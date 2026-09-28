const { pool } = require('../config/db');
const { patientSchema } = require('../utils/validators');

const NESTED_SELECT = `
  p.*,
  (select json_agg(s.* order by s.created_at desc) from symptom_assessments s where s.patient_id = p.id) as symptom_assessments,
  (select json_agg(ss.* order by ss.created_at desc) from sensor_sessions ss where ss.patient_id = p.id) as sensor_sessions,
  (select json_agg(r.* order by r.created_at desc) from risk_assessments r where r.patient_id = p.id) as risk_assessments,
  (select json_agg(rf.* order by rf.created_at desc) from referrals rf where rf.patient_id = p.id) as referrals
`;

/** Health-worker flow: a worker registers a patient they've just screened in the field. */
async function createPatient(req, res) {
  const patient = patientSchema.parse(req.body);
  const { rows } = await pool.query(
    `insert into patients
       (id, health_worker_id, local_id, name, age, gender, phone, village, block, district, device_created_at, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (id) do nothing
     returning *`,
    [
      patient.id,
      req.healthWorker.id,
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

  if (rows.length === 0) {
    // Already exists (idempotent retry) — return the existing record instead of an error.
    const existing = await pool.query('select * from patients where id = $1', [patient.id]);
    return res.status(200).json(existing.rows[0]);
  }

  res.status(201).json(rows[0]);
}

/**
 * Any signed-in health worker (worker/officer/admin) can browse and search every
 * patient — screening data is shared across the whole team, not siloed to whoever
 * registered the patient.
 */
async function listPatients(req, res) {
  const { limit = 50, offset = 0, search } = req.query;
  const params = [Number(limit), Number(offset)];
  let where = '1=1';

  if (search) {
    params.push(`%${search}%`);
    where += ` and (name ilike $${params.length} or local_id ilike $${params.length})`;
  }

  const { rows } = await pool.query(
    `select * from patients where ${where} order by created_at desc limit $1 offset $2`,
    params
  );
  res.json(rows);
}

/**
 * A specific patient's full record (with nested assessments/sensor sessions/risk/referrals).
 * Accessible to any health worker, or to a patient viewing their own record.
 */
async function getPatient(req, res) {
  const isHealthWorker = !!req.healthWorker;
  const isOwnRecord = !!req.patient && req.patient.id === req.params.id;

  if (!isHealthWorker && !isOwnRecord) {
    return res.status(403).json({ error: 'Not authorized to view this patient record' });
  }

  const { rows } = await pool.query(
    `select ${NESTED_SELECT} from patients p where p.id = $1`,
    [req.params.id]
  );

  if (rows.length === 0) return res.status(404).json({ error: 'Patient not found' });
  res.json(rows[0]);
}

/**
 * GET/POST /api/patients/me — the patient self-login flow.
 * A patient registers/logs in with their own account (/api/auth/register, /api/auth/login),
 * then calls this to fetch their profile, or create it on their very first login —
 * no health worker needs to have registered them first.
 */
async function getOrCreateOwnProfile(req, res) {
  if (req.healthWorker) {
    return res.status(400).json({ error: 'This endpoint is for patient accounts, not health worker accounts' });
  }

  if (req.patient) {
    const { rows } = await pool.query(
      `select ${NESTED_SELECT} from patients p where p.id = $1`,
      [req.patient.id]
    );
    return res.json(rows[0]);
  }

  if (req.method !== 'POST') {
    return res.status(404).json({ error: 'No patient profile yet — POST to this endpoint to create one' });
  }

  const patient = patientSchema.parse(req.body);
  const { rows } = await pool.query(
    `insert into patients
       (id, auth_user_id, health_worker_id, local_id, name, age, gender, phone, village, block, district, device_created_at, synced_at)
     values ($1,$2, null, $3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (id) do nothing
     returning *`,
    [
      patient.id,
      req.authUser.sub,
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

  if (rows.length === 0) {
    const existing = await pool.query('select * from patients where id = $1', [patient.id]);
    return res.status(200).json(existing.rows[0]);
  }

  res.status(201).json(rows[0]);
}

module.exports = { createPatient, listPatients, getPatient, getOrCreateOwnProfile };
