/**
 * Gait Model Client
 * =================
 * Talks to the separately-deployed FastAPI gait service (repo: aatsanjam-kaur/gait-api).
 *
 * That service takes a walking video (multipart field `file`) at POST /analyze-gait,
 * runs MediaPipe pose estimation + a logistic-regression classifier, and returns:
 *   { prediction: "KOA" | "NM", confidence: <P(KOA), 0-1>, risk_score: <0-100> }
 *
 * Note: despite its name, the service's `confidence` is the probability of the KOA class
 * (not confidence in whichever label won), so it is stored here as `probability_koa`.
 */

const MODEL_VERSION = 'gait-video-logreg-v1';

class GaitServiceError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'GaitServiceError';
    this.isGaitService = true;
    this.status = status; // HTTP status we should return to our own client
    this.detail = detail;
  }
}

function isConfigured() {
  return Boolean(process.env.GAIT_API_URL);
}

/**
 * @param {{ buffer: Buffer, originalname: string, mimetype: string }} file - a multer memory-storage file
 * @returns {Promise<{ prediction: 'KOA'|'NM', probability_koa: number, gait_risk_score: number, model_version: string }>}
 */
async function analyzeGaitVideo(file) {
  const base = process.env.GAIT_API_URL;
  if (!base) {
    throw new GaitServiceError('Gait analysis is not configured on this server (GAIT_API_URL is not set)', 503);
  }

  // Pose extraction runs frame by frame, so this is far slower than a normal API call.
  // Hosted free tiers can also cold-start for 30-60s, hence the generous default.
  const timeoutMs = Number(process.env.GAIT_API_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype || 'video/mp4' }), file.originalname || 'gait.mp4');

  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/analyze-gait`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new GaitServiceError(`Gait analysis timed out after ${timeoutMs} ms`, 504);
    }
    throw new GaitServiceError('Could not reach the gait analysis service', 503, err.message);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch (_e) {
      detail = `HTTP ${res.status}`;
    }
    // The FastAPI app returns 500 for every failure, including "video had no detectable person".
    throw new GaitServiceError('Gait analysis service could not process this video', 502, detail);
  }

  const data = await res.json();
  const p = Number(data.confidence);
  if (!['KOA', 'NM'].includes(data.prediction) || !Number.isFinite(p)) {
    throw new GaitServiceError('Gait analysis service returned an unexpected response', 502, JSON.stringify(data));
  }

  return {
    prediction: data.prediction,
    probability_koa: p,
    gait_risk_score: Math.round(Math.min(100, Math.max(0, p * 100)) * 10) / 10,
    model_version: MODEL_VERSION,
  };
}

module.exports = { analyzeGaitVideo, isConfigured, GaitServiceError, MODEL_VERSION };
