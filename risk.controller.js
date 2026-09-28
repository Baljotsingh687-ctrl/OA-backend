const { pool } = require('../config/db');
const { computeRiskAssessment } = require('../services/riskEngine.service');

/**
 * POST /api/patients/:patientId/risk-assessment
 * Body (optional): { symptom_assessment_id, sensor_session_id }
 * If not provided, uses the patient's most recent symptom assessment and sensor session.
 */
async function runRiskAssessment(req, res) {
  const { patientId } = req.params;
  let { symptom_assessment_id, sensor_session_id } = req.body || {};

  const patientCheck = await pool.query('select id from patients where id = $1', [patientId]);
  if (patientCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  let symptomAssessment = null;
  if (symptom_assessment_id) {
    const r = await pool.query('select * from symptom_assessments where id = $1 and patient_id = $2', [
      symptom_assessment_id,
      patientId,
    ]);
    symptomAssessment = r.rows[0] || null;
  } else {
    const r = await pool.query(
      'select * from symptom_assessments where patient_id = $1 order by created_at desc limit 1',
      [patientId]
    );
    symptomAssessment = r.rows[0] || null;
  }

  let gaitFeatures = null;
  let resolvedSensorSessionId = sensor_session_id || null;
  if (sensor_session_id) {
    const r = await pool.query('select * from gait_features where sensor_session_id = $1', [sensor_session_id]);
    gaitFeatures = r.rows[0] || null;
  } else {
    const r = await pool.query(
      `select gf.* from gait_features gf
       join sensor_sessions ss on ss.id = gf.sensor_session_id
       where ss.patient_id = $1
       order by gf.created_at desc limit 1`,
      [patientId]
    );
    gaitFeatures = r.rows[0] || null;
    resolvedSensorSessionId = gaitFeatures ? gaitFeatures.sensor_session_id : null;
  }

  const result = await computeRiskAssessment(symptomAssessment, gaitFeatures);

  const { rows } = await pool.query(
    `insert into risk_assessments
       (patient_id, symptom_assessment_id, sensor_session_id, symptom_score, gait_score, composite_score, risk_tier, recommendation, model_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      patientId,
      symptomAssessment ? symptomAssessment.id : null,
      resolvedSensorSessionId,
      result.symptom_score,
      result.gait_score,
      result.composite_score,
      result.risk_tier,
      result.recommendation,
      result.model_version,
    ]
  );

  // High-risk auto-creates a pending referral so nothing falls through the cracks
  if (result.risk_tier === 'high') {
    await pool.query(
      `insert into referrals (patient_id, risk_assessment_id, status, notes)
       values ($1, $2, 'pending', 'Auto-created: high OA risk score')`,
      [patientId, rows[0].id]
    );
  }

  res.status(201).json(rows[0]);
}

async function getLatestRiskForPatient(req, res) {
  const { rows } = await pool.query(
    'select * from risk_assessments where patient_id = $1 order by created_at desc limit 1',
    [req.params.patientId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'No risk assessment yet for this patient' });
  res.json(rows[0]);
}

module.exports = { runRiskAssessment, getLatestRiskForPatient };
