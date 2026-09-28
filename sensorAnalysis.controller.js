const { z } = require('zod');
const { pool } = require('../config/db');
const { analyzeSensorReadings } = require('../services/sensorModel.service');

const bodySchema = z.object({ sensor_session_id: z.string().uuid() });
const patientIdSchema = z.string().uuid();

/**
 * POST /api/patients/:patientId/sensor-analysis     body: { "sensor_session_id": "<uuid>" }
 * Reads the session's stored sensor_readings, sends them to the sensor model, and saves the
 * score on that session's gait_features row (extra.model_gait_risk_score) so the next
 * POST /api/patients/:patientId/risk-assessment uses it as the gait score.
 */
async function analyzeSensorSession(req, res) {
  const patientId = patientIdSchema.parse(req.params.patientId);
  const { sensor_session_id: sessionId } = bodySchema.parse(req.body || {});

  const session = await pool.query('select id from sensor_sessions where id = $1 and patient_id = $2', [sessionId, patientId]);
  if (session.rows.length === 0) return res.status(404).json({ error: 'Sensor session not found for this patient' });

  const { rows: readings } = await pool.query(
    `select sensor_location, t_ms, ax, ay, az, gx, gy, gz, mx, my, mz, knee_angle_deg
     from sensor_readings where sensor_session_id = $1 order by t_ms, sensor_location limit 200000`,
    [sessionId]
  );
  if (readings.length === 0) return res.status(422).json({ error: 'This session has no sensor readings yet' });

  let result;
  try {
    result = await analyzeSensorReadings(sessionId, readings);
  } catch (err) {
    if (err.isModelService) return res.status(err.status).json({ error: err.message, detail: err.detail });
    throw err;
  }

  const extra = {
    source: 'sensor-api',
    prediction: result.prediction,
    model_gait_risk_score: result.sensor_risk_score,
    model_version: result.model_version,
    readings_analyzed: readings.length,
  };

  const existing = await pool.query('select id from gait_features where sensor_session_id = $1 order by created_at desc limit 1', [sessionId]);
  if (existing.rows.length > 0) {
    await pool.query(`update gait_features set extra = coalesce(extra, '{}'::jsonb) || $2::jsonb where id = $1`, [existing.rows[0].id, JSON.stringify(extra)]);
  } else {
    await pool.query(`insert into gait_features (id, sensor_session_id, extra) values (gen_random_uuid(), $1, $2)`, [sessionId, JSON.stringify(extra)]);
  }

  res.status(201).json({
    sensor_session_id: sessionId,
    patient_id: patientId,
    prediction: result.prediction,
    sensor_risk_score: result.sensor_risk_score,
    model_version: result.model_version,
    readings_analyzed: readings.length,
  });
}

module.exports = { analyzeSensorSession };
