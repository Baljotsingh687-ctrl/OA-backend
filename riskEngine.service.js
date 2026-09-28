/**
 * Risk Scoring Engine
 * ===================
 * Produces a 0-100 composite OA risk score from:
 *   1. Symptom data (digitized KOOS questionnaire)
 *   2. Gait data (from IMU sensors or vision/pose-estimation), when available
 *
 * Design notes:
 * - This is a *screening/triage* tool, not a diagnostic one. Recommendations
 *   are phrased as "refer" / "monitor", never as a diagnosis.
 * - If your ML teammates have a trained classifier (XGBoost/RF/1D-CNN) exposed
 *   over HTTP, set ML_MODEL_ENDPOINT and this engine will call it for the
 *   gait_score instead of the rule-based heuristic below — with automatic
 *   fallback if the call fails or times out, so a flaky model service never
 *   blocks a health worker in the field.
 */

// KOOS subscale max raw scores (every item is scored 0-4), per the official KOOS manual.
const KOOS_MAX = {
  pain: 36,     // 9 items
  symptoms: 28, // 7 items
  adl: 68,      // 17 items (function in daily living)
  sport: 20,    // 5 items (function in sport/recreation)
  qol: 16,      // 4 items (quality of life)
};

/**
 * Normalizes raw KOOS subscale totals into a single 0-100 symptom score.
 * Note: KOOS itself is scored so 100 = no symptoms / best knee health, the opposite
 * direction of WOMAC. We invert each subscale here so the output stays a "risk-style"
 * score (higher = more symptom burden) that the rest of the engine already expects.
 * There's no single official KOOS composite, so this averages the five subscales
 * equally — adjust the weights below if your clinical team wants a different mix.
 */
function computeSymptomScore({ koos_pain_score, koos_symptoms_score, koos_adl_score, koos_sport_score, koos_qol_score }) {
  const painBurden = 100 - (clamp(koos_pain_score, 0, KOOS_MAX.pain) / KOOS_MAX.pain) * 100;
  const symptomsBurden = 100 - (clamp(koos_symptoms_score, 0, KOOS_MAX.symptoms) / KOOS_MAX.symptoms) * 100;
  const adlBurden = 100 - (clamp(koos_adl_score, 0, KOOS_MAX.adl) / KOOS_MAX.adl) * 100;
  const sportBurden = 100 - (clamp(koos_sport_score, 0, KOOS_MAX.sport) / KOOS_MAX.sport) * 100;
  const qolBurden = 100 - (clamp(koos_qol_score, 0, KOOS_MAX.qol) / KOOS_MAX.qol) * 100;

  const composite = (painBurden + symptomsBurden + adlBurden + sportBurden + qolBurden) / 5;
  return round1(composite);
}

/** Rule-based gait score fallback (used if no ML endpoint is configured, or it fails). */
function computeGaitScoreRuleBased(features) {
  if (!features) return null;

  const {
    stride_time_variability = 0, // higher = worse, typical clinical cut-off ~ >3-4%
    knee_rom_deg = 140,          // lower = worse, healthy knee ROM ~130-150 deg walking
    cadence_asymmetry = 0,       // 0-1, higher = worse
    stance_time_ratio = 0.6,     // ~0.6 is typical single-limb stance ratio; deviation = worse
  } = features;

  const strideRisk = clamp(stride_time_variability / 6, 0, 1); // >6% variability -> max risk
  const romRisk = clamp((150 - knee_rom_deg) / 60, 0, 1);      // ROM below ~90deg -> max risk
  const asymmetryRisk = clamp(cadence_asymmetry, 0, 1);
  const stanceRisk = clamp(Math.abs(stance_time_ratio - 0.6) / 0.25, 0, 1);

  const composite =
    strideRisk * 0.3 + romRisk * 0.35 + asymmetryRisk * 0.2 + stanceRisk * 0.15;

  return round1(composite * 100);
}

/** Calls an external trained model (if configured). Returns null on any failure so callers fall back gracefully. */
async function computeGaitScoreFromModel(features) {
  const endpoint = process.env.ML_MODEL_ENDPOINT;
  if (!endpoint || !features) return null;

  const timeoutMs = Number(process.env.ML_MODEL_TIMEOUT_MS || 3000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Expected model response shape: { gait_risk_score: 0-100 }
    if (typeof data.gait_risk_score === 'number') {
      return round1(clamp(data.gait_risk_score, 0, 100));
    }
    return null;
  } catch (_err) {
    return null; // network error, timeout, bad JSON -> fall back to rule-based
  } finally {
    clearTimeout(timer);
  }
}

function tierAndRecommendation(compositeScore) {
  if (compositeScore >= 66) {
    return {
      risk_tier: 'high',
      recommendation:
        'Refer to orthopaedician for clinical evaluation. Priority follow-up recommended.',
    };
  }
  if (compositeScore >= 33) {
    return {
      risk_tier: 'moderate',
      recommendation:
        'Monitor with lifestyle advice (weight management, low-impact exercise). Re-screen in 3-6 months.',
    };
  }
  return {
    risk_tier: 'low',
    recommendation: 'No referral needed at this time. Routine re-screening at next camp.',
  };
}

/**
 * Main entry point: computes a full risk assessment.
 * @param {object} symptomAssessment - row from symptom_assessments (may be null)
 * @param {object} gaitFeatures - row from gait_features (may be null if no sensor session)
 * @param {number|null} xrayScore - 0-100 score from the X-ray model (null if no X-ray on file)
 */
async function computeRiskAssessment(symptomAssessment, gaitFeatures, xrayScore = null) {
  const symptomScore = symptomAssessment ? computeSymptomScore(symptomAssessment) : null;

  let gaitScore = null;
  let modelVersion = 'rule-based-v1';
  if (gaitFeatures) {
    // 1) Score already produced by the gait video model (see gait.controller.js)
    const stored = gaitFeatures.extra && gaitFeatures.extra.model_gait_risk_score;
    if (typeof stored === 'number' && Number.isFinite(stored)) {
      gaitScore = round1(clamp(stored, 0, 100));
      modelVersion = gaitFeatures.extra.model_version || 'gait-video-logreg-v1';
    } else {
      // 2) Optional external features-based model, 3) rule-based fallback
      gaitScore = await computeGaitScoreFromModel(gaitFeatures);
      if (gaitScore !== null) {
        modelVersion = 'ml-model-v1';
      } else {
        gaitScore = computeGaitScoreRuleBased(gaitFeatures);
      }
    }
  }

  const hasXray = typeof xrayScore === 'number' && Number.isFinite(xrayScore);
  let composite;
  if (hasXray) {
    // With an X-ray: weighted blend of whatever components exist (weights renormalised over those present)
    const parts = [
      [symptomScore, 0.35],
      [gaitScore, 0.3],
      [round1(clamp(xrayScore, 0, 100)), 0.35],
    ].filter(([v]) => v !== null);
    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    composite = round1(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum);
    modelVersion = `${modelVersion}+xray`;
  } else if (symptomScore !== null && gaitScore !== null) {
    composite = round1(symptomScore * 0.5 + gaitScore * 0.5);
  } else if (symptomScore !== null) {
    composite = symptomScore; // no sensor data available for this patient
  } else if (gaitScore !== null) {
    composite = gaitScore; // no symptom form filled yet (unusual, but handled)
  } else {
    throw Object.assign(new Error('Cannot compute risk with no symptom or gait data'), { status: 400 });
  }

  const { risk_tier, recommendation } = tierAndRecommendation(composite);

  return {
    symptom_score: symptomScore,
    gait_score: gaitScore,
    xray_score: hasXray ? round1(clamp(xrayScore, 0, 100)) : null,
    composite_score: composite,
    risk_tier,
    recommendation,
    model_version: modelVersion,
  };
}

function clamp(value, min, max) {
  const n = Number(value);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { computeRiskAssessment, computeSymptomScore, computeGaitScoreRuleBased };
