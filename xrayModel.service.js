/**
 * X-ray Model Client
 * ==================
 * Sends a knee X-ray image to the hosted X-ray model (POST <XRAY_API_URL>, e.g.
 * https://xxxx.ngrok-free.dev/analyze-xray) as a multipart upload, the same way
 * gaitModel.service.js talks to the gait API.
 *
 * Config (.env):
 *   XRAY_API_URL, XRAY_API_KEY
 *   XRAY_API_KEY_HEADER  header carrying the key (default "x-api-key")
 *   XRAY_API_FILE_FIELD  multipart field name for the image (default "file")
 * Response: looks for a score in risk_score | probability_koa | probability | confidence | score
 * (0-1 is scaled to 0-100) and a label in prediction | label | class | grade.
 */

const MODEL_VERSION = 'xray-model-v1';

class XrayServiceError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'XrayServiceError';
    this.isModelService = true;
    this.status = status;
    this.detail = detail;
  }
}

function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return { key: k, value: v };
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return { key: k, value: Number(v) };
  }
  return null;
}

function normalise(data) {
  const src = data && typeof data === 'object' && data.result && typeof data.result === 'object' ? data.result : data || {};
  const found = firstNumber(src, ['risk_score', 'probability_koa', 'probability', 'confidence', 'score']);
  if (!found) return null;
  const scaled = found.key === 'risk_score' || found.value > 1 ? found.value : found.value * 100;
  const label = src.prediction ?? src.label ?? src.class ?? src.grade ?? null;
  return {
    prediction: label === null ? null : String(label),
    xray_score: Math.round(Math.min(100, Math.max(0, scaled)) * 10) / 10,
    model_version: MODEL_VERSION,
    raw_response: data,
  };
}

/** @param {{ buffer: Buffer, originalname: string, mimetype: string }} file - multer memory-storage file */
async function analyzeXray(file) {
  const url = process.env.XRAY_API_URL;
  if (!url) throw new XrayServiceError('X-ray analysis is not configured on this server (XRAY_API_URL is not set)', 503);

  const headers = { 'ngrok-skip-browser-warning': 'true', Accept: 'application/json' };
  if (process.env.XRAY_API_KEY) headers[process.env.XRAY_API_KEY_HEADER || 'x-api-key'] = process.env.XRAY_API_KEY;

  const form = new FormData();
  form.append(
    process.env.XRAY_API_FILE_FIELD || 'file',
    new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' }),
    file.originalname || 'xray.jpg'
  );

  const timeoutMs = Number(process.env.XRAY_API_TIMEOUT_MS || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new XrayServiceError(`X-ray analysis timed out after ${timeoutMs} ms`, 504);
    throw new XrayServiceError('Could not reach the X-ray analysis service (is the ngrok tunnel running?)', 503, err.message);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_e) { data = null; }

  if (!res.ok) {
    const detail = data && (data.detail || data.error) ? JSON.stringify(data.detail || data.error) : text.slice(0, 500);
    throw new XrayServiceError('X-ray analysis service rejected the request', 502, `HTTP ${res.status}: ${detail}`);
  }
  if (data === null) {
    throw new XrayServiceError('X-ray analysis service did not return JSON (ngrok warning page? check the URL)', 502, text.slice(0, 200));
  }
  const out = normalise(data);
  if (!out) throw new XrayServiceError('X-ray analysis response had no recognisable score', 502, JSON.stringify(data).slice(0, 500));
  return out;
}

module.exports = { analyzeXray, XrayServiceError, MODEL_VERSION };
