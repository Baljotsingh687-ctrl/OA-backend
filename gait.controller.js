const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');
const { pool } = require('../config/db');
const { analyzeGaitVideo: runGaitModel } = require('../services/gaitModel.service');

const patientIdSchema = z.string().uuid();

/**
 * POST /api/patients/:patientId/gait-analysis        (multipart/form-data, field: "video")
 *
 * Sends the walking video to the gait model service, then stores the outcome as a
 * `vision` sensor session + `gait_features` row. The model's 0-100 score is kept in
 * gait_features.extra.model_gait_risk_score, which the risk engine prefers over its
 * rule-based heuristic on the next POST /api/patients/:patientId/risk-assessment.
 */
async function analyzeGaitVideo(req, res) {
  const patientId = patientIdSchema.parse(req.params.patientId);

  if (!req.file) {
    return res.status(400).json({ error: 'Attach a walking video as multipart field "video"' });
  }

  const patient = await pool.query('select id from patients where id = $1', [patientId]);
  if (patient.rows.length === 0) return res.status(404).json({ error: 'Patient not found' });

  const startedAt = new Date();
  let result;
  try {
    result = await runGaitModel(req.file);
  } catch (err) {
    if (err.isGaitService) {
      return res.status(err.status).json({ error: err.message, detail: err.detail });
    }
    throw err;
  }

  const sessionId = uuidv4();
  const extra = {
    source: 'gait-api',
    prediction: result.prediction,
    probability_koa: result.probability_koa,
    model_gait_risk_score: result.gait_risk_score,
    model_version: result.model_version,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const session = await client.query(
      `insert into sensor_sessions
         (id, patient_id, session_type, device_id, started_at, ended_at, raw_data, synced_at)
       values ($1, $2, 'vision', $3, $4, now(), $5, now())
       returning *`,
      [
        sessionId,
        patientId,
        req.body?.device_id || null,
        startedAt.toISOString(),
        JSON.stringify({ filename: req.file.originalname, size_bytes: req.file.size, model_output: extra }),
      ]
    );

    const gf = await client.query(
      `insert into gait_features (id, sensor_session_id, extra)
       values (gen_random_uuid(), $1, $2)
       returning *`,
      [sessionId, JSON.stringify(extra)]
    );

    await client.query('COMMIT');

    res.status(201).json({
      sensor_session_id: session.rows[0].id,
      gait_features_id: gf.rows[0].id,
      patient_id: patientId,
      prediction: result.prediction,
      probability_koa: result.probability_koa,
      gait_risk_score: result.gait_risk_score,
      model_version: result.model_version,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { analyzeGaitVideo };
