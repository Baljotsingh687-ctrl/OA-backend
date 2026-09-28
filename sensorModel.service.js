/**
 * Sensor (IMU) Model Client
 * =========================
 * Sends a stored sensor session's raw readings to the hosted sensor model
 * (POST <SENSOR_API_URL>, e.g. https://xxxx.ngrok-free.dev/analyze-sensor) and normalises the reply.
 *
 * The model's exact request/response contract wasn't available when this was written, so the
 * request shape is configurable and the response parser is tolerant:
 *   SENSOR_API_MODE       csv (default) = multipart file upload of the readings as CSV
 *                         json          = JSON body { session_id, readings: [...] }
 *   SENSOR_API_FILE_FIELD multipart field name for csv mode (default "file")
 *   SENSOR_API_KEY_HEADER header that carries the key (default "x-api-key")
 * Response: looks for a probability/score in probability_koa | probability | confidence | risk_score | score
 * (0-1 is scaled to 0-100) and a label in prediction | label | class.
 */

const MODEL_VERSION = 'sensor-model-v1';
const COLS = ['sensor_location', 't_ms', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'mx', 'my', 'mz', 'knee_angle_deg'];

class SensorServiceError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'SensorServiceError';
    this.isModelService = true;
    this.status = status;
    this.detail = detail;
  }
}

function toCsv(readings) {
  const lines = [COLS.join(',')];
  for (const r of readings) lines.push(COLS.map((c) => (r[c] === null || r[c] === undefined ? '' : r[c])).join(','));
  return lines.join('\n');
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
  // risk_score is 0-100 by convention in these services; the others are 0-1 probabilities
  const scaled = found.key === 'risk_score' || found.value > 1 ? found.value : found.value * 100;
  const label = src.prediction ?? src.label ?? src.class ?? null;
  return {
    prediction: label === null ? null : String(label),
    sensor_risk_score: Math.round(Math.min(100, Math.max(0, scaled)) * 10) / 10,
    model_version: MODEL_VERSION,
    raw_response: data,
  };
}

async function analyzeSensorReadings(sessionId, readings) {
  const url = process.env.SENSOR_API_URL;
  if (!url) throw new SensorServiceError('Sensor analysis is not configured on this server (SENSOR_API_URL is not set)', 503);

  const headers = { 'ngrok-skip-browser-warning': 'true', Accept: 'application/json' };
  if (process.env.SENSOR_API_KEY) headers[process.env.SENSOR_API_KEY_HEADER || 'x-api-key'] = process.env.SENSOR_API_KEY;

  let body;
  if ((process.env.SENSOR_API_MODE || 'csv') === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ session_id: sessionId, readings });
  } else {
    body = new FormData();
    body.append(process.env.SENSOR_API_FILE_FIELD || 'file', new Blob([toCsv(readings)], { type: 'text/csv' }), `${sessionId}.csv`);
  }

  const timeoutMs = Number(process.env.SENSOR_API_TIMEOUT_MS || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new SensorServiceError(`Sensor analysis timed out after ${timeoutMs} ms`, 504);
    throw new SensorServiceError('Could not reach the sensor analysis service (is the ngrok tunnel running?)', 503, err.message);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_e) { data = null; }

  if (!res.ok) {
    const detail = (data && (data.detail || data.error)) ? JSON.stringify(data.detail || data.error) : text.slice(0, 500);
    throw new SensorServiceError('Sensor analysis service rejected the request', 502, `HTTP ${res.status}: ${detail}`);
  }
  if (data === null) {
    throw new SensorServiceError('Sensor analysis service did not return JSON (ngrok warning page? check the URL)', 502, text.slice(0, 200));
  }
  const out = normalise(data);
  if (!out) throw new SensorServiceError('Sensor analysis response had no recognisable score', 502, JSON.stringify(data).slice(0, 500));
  return out;
}

module.exports = { analyzeSensorReadings, SensorServiceError, MODEL_VERSION };
