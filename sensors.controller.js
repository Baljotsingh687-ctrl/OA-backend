const { pool } = require('../config/db');
const { sensorSessionSchema, sensorReadingsBatchSchema } = require('../utils/validators');

async function createSensorSession(req, res) {
  const s = sensorSessionSchema.parse(req.body);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `insert into sensor_sessions
         (id, patient_id, session_type, device_id, started_at, ended_at, raw_data, storage_url, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (id) do nothing
       returning *`,
      [
        s.id,
        s.patient_id,
        s.session_type,
        s.device_id || null,
        s.started_at || null,
        s.ended_at || null,
        s.raw_data ? JSON.stringify(s.raw_data) : null,
        s.storage_url || null,
      ]
    );

    let gaitFeatureRow = null;
    if (rows.length > 0 && s.gait_features) {
      const gf = s.gait_features;
      const inserted = await client.query(
        `insert into gait_features
           (id, sensor_session_id, stride_time_variability, knee_rom_deg, cadence_asymmetry, stance_time_ratio, extra)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
         returning *`,
        [
          s.id,
          gf.stride_time_variability ?? null,
          gf.knee_rom_deg ?? null,
          gf.cadence_asymmetry ?? null,
          gf.stance_time_ratio ?? null,
          gf.extra ? JSON.stringify(gf.extra) : null,
        ]
      );
      gaitFeatureRow = inserted.rows[0];
    }

    await client.query('COMMIT');

    if (rows.length === 0) {
      const existing = await pool.query('select * from sensor_sessions where id = $1', [s.id]);
      return res.status(200).json(existing.rows[0]);
    }

    res.status(201).json({ ...rows[0], gait_features: gaitFeatureRow });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listSessionsForPatient(req, res) {
  const patientId = req.params.patientId || req.query.patient_id;
  if (!patientId) return res.status(400).json({ error: 'patient_id is required (path param or ?patient_id=)' });

  const { rows } = await pool.query(
    `select ss.*, gf.stride_time_variability, gf.knee_rom_deg, gf.cadence_asymmetry, gf.stance_time_ratio
     from sensor_sessions ss
     left join gait_features gf on gf.sensor_session_id = ss.id
     where ss.patient_id = $1
     order by ss.created_at desc`,
    [patientId]
  );
  res.json(rows);
}

/**
 * POST .../sensor-sessions/:sessionId/readings
 * Bulk-inserts a batch of raw samples (up to 5000) from the hardware into sensor_readings.
 * Safe to retry: samples already stored (same session + sensor_location + t_ms) are skipped.
 */
async function addReadings(req, res) {
  const { sessionId } = req.params;
  const batch = sensorReadingsBatchSchema.parse(req.body);

  const session = await pool.query('select id from sensor_sessions where id = $1', [sessionId]);
  if (session.rows.length === 0) return res.status(404).json({ error: 'Sensor session not found' });

  const r = batch.readings;
  const col = (k) => r.map((x) => x[k] ?? null);
  const loc = r.map((x) => x.sensor_location || batch.sensor_location || 'default');
  const extra = r.map((x) => (x.extra ? JSON.stringify(x.extra) : null));

  const result = await pool.query(
    `insert into sensor_readings
       (sensor_session_id, sensor_location, t_ms, ax, ay, az, gx, gy, gz, mx, my, mz, knee_angle_deg, extra)
     select $1::uuid, t.loc, t.t_ms, t.ax, t.ay, t.az, t.gx, t.gy, t.gz, t.mx, t.my, t.mz, t.knee, t.extra::jsonb
     from unnest(
       $2::text[], $3::int[], $4::real[], $5::real[], $6::real[], $7::real[], $8::real[], $9::real[],
       $10::real[], $11::real[], $12::real[], $13::real[], $14::text[]
     ) as t(loc, t_ms, ax, ay, az, gx, gy, gz, mx, my, mz, knee, extra)
     on conflict (sensor_session_id, sensor_location, t_ms) do nothing`,
    [
      sessionId, loc, col('t_ms'),
      col('ax'), col('ay'), col('az'), col('gx'), col('gy'), col('gz'),
      col('mx'), col('my'), col('mz'), col('knee_angle_deg'), extra,
    ]
);

  res.status(201).json({ received: r.length, inserted: result.rowCount, skipped_duplicates: r.length - result.rowCount });
}

/** GET .../sensor-sessions/:sessionId/readings?sensor_location=&from_ms=&to_ms=&limit= */
async function listReadings(req, res) {
  const { sessionId } = req.params;
  const { sensor_location, from_ms, to_ms, limit = 10000 } = req.query;
  const params = [sessionId];
  let where = 'sensor_session_id = $1';
  if (sensor_location) { params.push(sensor_location); where += ` and sensor_location = $${params.length}`; }
  if (from_ms) { params.push(Number(from_ms)); where += ` and t_ms >= $${params.length}`; }
  if (to_ms) { params.push(Number(to_ms)); where += ` and t_ms <= $${params.length}`; }
  params.push(Math.min(Number(limit) || 10000, 50000));

  const { rows } = await pool.query(
    `select sensor_location, t_ms, ax, ay, az, gx, gy, gz, mx, my, mz, knee_angle_deg, extra
     from sensor_readings where ${where} order by t_ms, sensor_location limit $${params.length}`,
    params
  );
  res.json(rows);
}

module.exports = { createSensorSession, listSessionsForPatient, addReadings, listReadings };
