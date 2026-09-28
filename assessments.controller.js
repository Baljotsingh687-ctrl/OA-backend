const { pool } = require('../config/db');
const { symptomAssessmentSchema } = require('../utils/validators');

async function createAssessment(req, res) {
  const a = symptomAssessmentSchema.parse(req.body);

  const { rows } = await pool.query(
    `insert into symptom_assessments
       (id, patient_id, pain_scale, stiffness_duration_min, swelling, family_history,
        joints_affected, koos_pain_score, koos_symptoms_score, koos_adl_score,
        koos_sport_score, koos_qol_score, raw_answers, device_created_at, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     on conflict (id) do nothing
     returning *`,
    [
      a.id,
      a.patient_id,
      a.pain_scale ?? null,
      a.stiffness_duration_min ?? null,
      a.swelling ?? false,
      a.family_history ?? false,
      a.joints_affected ?? [],
      a.koos_pain_score,
      a.koos_symptoms_score,
      a.koos_adl_score,
      a.koos_sport_score,
      a.koos_qol_score,
      a.raw_answers ? JSON.stringify(a.raw_answers) : null,
      a.device_created_at || null,
    ]
  );

  if (rows.length === 0) {
    const existing = await pool.query('select * from symptom_assessments where id = $1', [a.id]);
    return res.status(200).json(existing.rows[0]);
  }

  res.status(201).json(rows[0]);
}

async function listAssessmentsForPatient(req, res) {
  const patientId = req.params.patientId || req.query.patient_id;
  if (!patientId) return res.status(400).json({ error: 'patient_id is required (path param or ?patient_id=)' });

  const { rows } = await pool.query(
    'select * from symptom_assessments where patient_id = $1 order by created_at desc',
    [patientId]
  );
  res.json(rows);
}

module.exports = { createAssessment, listAssessmentsForPatient };
