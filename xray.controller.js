const { z } = require('zod');
const { pool } = require('../config/db');
const { analyzeXray: runXrayModel } = require('../services/xrayModel.service');

const patientIdSchema = z.string().uuid();

/**
 * POST /api/patients/:patientId/xray-analysis   (multipart/form-data, field: "image")
 * Relays the X-ray to the X-ray model and stores the result in xray_analyses. The next
 * POST /api/patients/:patientId/risk-assessment blends the latest X-ray score into the composite.
 */
async function analyzeXray(req, res) {
  const patientId = patientIdSchema.parse(req.params.patientId);
  if (!req.file) return res.status(400).json({ error: 'Attach the X-ray as multipart field "image"' });

  const patient = await pool.query('select id from patients where id = $1', [patientId]);
  if (patient.rows.length === 0) return res.status(404).json({ error: 'Patient not found' });

  let result;
  try {
    result = await runXrayModel(req.file);
  } catch (err) {
    if (err.isModelService) return res.status(err.status).json({ error: err.message, detail: err.detail });
    throw err;
  }

  const { rows } = await pool.query(
    `insert into xray_analyses (patient_id, prediction, xray_score, model_version, raw_response, filename)
     values ($1, $2, $3, $4, $5, $6)
     returning id, patient_id, prediction, xray_score, model_version, created_at`,
    [patientId, result.prediction, result.xray_score, result.model_version, JSON.stringify(result.raw_response), req.file.originalname || null]
  );

  res.status(201).json(rows[0]);
}

/** GET /api/patients/:patientId/xray-analysis  -> past X-ray results, newest first */
async function listXrayAnalyses(req, res) {
  const patientId = patientIdSchema.parse(req.params.patientId);
  const { rows } = await pool.query(
    `select id, prediction, xray_score, model_version, filename, created_at
     from xray_analyses where patient_id = $1 order by created_at desc`,
    [patientId]
  );
  res.json(rows);
}

module.exports = { analyzeXray, listXrayAnalyses };
