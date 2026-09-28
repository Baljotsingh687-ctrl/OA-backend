const { pool } = require('../config/db');

/**
 * Idempotently upserts a record whose primary key was generated on the device
 * (client-side UUID). ON CONFLICT DO NOTHING means a retried sync from a
 * flaky connection never creates duplicates or overwrites server-side fields
 * (like `synced_at`) that the device doesn't know about.
 *
 * Returns 'inserted' | 'skipped_duplicate'.
 */
async function upsertPatient(client, healthWorkerId, patient) {
  const { rows } = await client.query(
    `insert into patients
       (id, health_worker_id, local_id, name, age, gender, phone, village, block, district, device_created_at, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (id) do nothing
     returning id`,
    [
      patient.id,
      healthWorkerId,
      patient.local_id || null,
      patient.name,
      patient.age || null,
      patient.gender || null,
      patient.phone || null,
      patient.village || null,
      patient.block || null,
      patient.district || null,
      patient.device_created_at || null,
    ]
  );
  return rows.length > 0 ? 'inserted' : 'skipped_duplicate';
}

async function upsertSymptomAssessment(client, assessment) {
  const { rows } = await client.query(
    `insert into symptom_assessments
       (id, patient_id, pain_scale, stiffness_duration_min, swelling, family_history,
        joints_affected, koos_pain_score, koos_symptoms_score, koos_adl_score,
        koos_sport_score, koos_qol_score, raw_answers, device_created_at, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     on conflict (id) do nothing
     returning id`,
    [
      assessment.id,
      assessment.patient_id,
      assessment.pain_scale ?? null,
      assessment.stiffness_duration_min ?? null,
      assessment.swelling ?? false,
      assessment.family_history ?? false,
      assessment.joints_affected ?? [],
      assessment.koos_pain_score,
      assessment.koos_symptoms_score,
      assessment.koos_adl_score,
      assessment.koos_sport_score,
      assessment.koos_qol_score,
      assessment.raw_answers ? JSON.stringify(assessment.raw_answers) : null,
      assessment.device_created_at || null,
    ]
  );
  return rows.length > 0 ? 'inserted' : 'skipped_duplicate';
}

async function upsertSensorSession(client, session) {
  const { rows } = await client.query(
    `insert into sensor_sessions
       (id, patient_id, session_type, device_id, started_at, ended_at, raw_data, storage_url, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (id) do nothing
     returning id`,
    [
      session.id,
      session.patient_id,
      session.session_type,
      session.device_id || null,
      session.started_at || null,
      session.ended_at || null,
      session.raw_data ? JSON.stringify(session.raw_data) : null,
      session.storage_url || null,
    ]
  );

  const status = rows.length > 0 ? 'inserted' : 'skipped_duplicate';

  // If the client already computed gait features on-device (or from a quick edge model),
  // sync them too, keyed off the same idempotency guarantee.
  if (status === 'inserted' && session.gait_features) {
    const gf = session.gait_features;
    await client.query(
      `insert into gait_features
         (id, sensor_session_id, stride_time_variability, knee_rom_deg, cadence_asymmetry, stance_time_ratio, extra)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [
        session.id,
        gf.stride_time_variability ?? null,
        gf.knee_rom_deg ?? null,
        gf.cadence_asymmetry ?? null,
        gf.stance_time_ratio ?? null,
        gf.extra ? JSON.stringify(gf.extra) : null,
      ]
    );
  }

  return status;
}

/**
 * Processes a full offline sync batch inside one transaction per table-set so a partial
 * network failure mid-batch doesn't leave the DB half-written for a single patient's data.
 */
async function processSyncBatch(healthWorkerId, batch) {
  const client = await pool.connect();
  const results = { patients: [], symptom_assessments: [], sensor_sessions: [] };

  try {
    await client.query('BEGIN');

    for (const patient of batch.patients) {
      const status = await upsertPatient(client, healthWorkerId, patient);
      results.patients.push({ id: patient.id, status });
    }
    for (const assessment of batch.symptom_assessments) {
      const status = await upsertSymptomAssessment(client, assessment);
      results.symptom_assessments.push({ id: assessment.id, status });
    }
    for (const session of batch.sensor_sessions) {
      const status = await upsertSensorSession(client, session);
      results.sensor_sessions.push({ id: session.id, status });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Fire-and-forget audit log (best effort; failure here shouldn't fail the sync response)
  logSyncResults(healthWorkerId, results).catch(() => {});

  return results;
}

async function logSyncResults(healthWorkerId, results) {
  const rows = [];
  for (const [table, records] of Object.entries(results)) {
    for (const r of records) {
      rows.push([table, r.id, healthWorkerId, r.status]);
    }
  }
  if (rows.length === 0) return;

  const values = rows
    .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    .join(', ');
  const flat = rows.flat();

  await pool.query(
    `insert into sync_log (table_name, record_id, health_worker_id, status) values ${values}`,
    flat
  );
}

module.exports = { processSyncBatch };
