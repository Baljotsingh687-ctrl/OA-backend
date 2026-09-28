const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

/**
 * Verifies the JWT issued by this backend's own login endpoints (see auth.controller.js).
 * Verifying locally means no extra network round-trip on every request — important when
 * health workers are on patchy connections.
 *
 * A logged-in user can be either of two kinds of account:
 *   - a health worker (row in `health_workers`), or
 *   - a patient logging in on their own (row in `patients`, linked via `patients.auth_user_id`).
 *
 * This attaches `req.authUser` (token claims, `sub` = users.id) plus whichever of
 * `req.healthWorker` / `req.patient` matches. Neither being set just means this is a
 * brand-new account with no profile row yet — that's expected on a patient's very first
 * login, before they've called `POST /api/patients/me` to create their profile, so this
 * middleware does NOT reject that case; routes that need an existing profile enforce it
 * themselves (see `requireHealthWorker` below).
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET not set' });
    }

    const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
    req.authUser = claims; // claims.sub = users.id

    const hw = await pool.query(
      'select id, name, role, village, block, district, language_pref from health_workers where auth_user_id = $1',
      [claims.sub]
    );

    if (hw.rows.length > 0) {
      req.healthWorker = hw.rows[0];
      return next();
    }

    const pt = await pool.query(
      'select id, auth_user_id, name, age, gender, phone, village, block, district from patients where auth_user_id = $1',
      [claims.sub]
    );

    if (pt.rows.length > 0) {
      req.patient = pt.rows[0];
      return next();
    }

    // No health_workers or patients row linked yet — allow the request through.
    // In practice only `POST /api/patients/me` (patient self-registration) makes
    // sense at this point; every other route guards itself with requireHealthWorker
    // or an explicit req.patient check.
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    next(err);
  }
}

/** Restricts a route to signed-in health workers (any role) — i.e. not a patient account. */
function requireHealthWorker(req, res, next) {
  if (!req.healthWorker) {
    return res.status(403).json({ error: 'Health worker account required' });
  }
  next();
}

/** Restricts a route to officer/admin roles (for dashboard + referral management endpoints). */
function requireOfficer(req, res, next) {
  if (!req.healthWorker || !['officer', 'admin'].includes(req.healthWorker.role)) {
    return res.status(403).json({ error: 'Officer or admin role required' });
  }
  next();
}

/** Restricts a route to admins only (e.g. creating health worker accounts). */
function requireAdmin(req, res, next) {
  if (!req.healthWorker || req.healthWorker.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  next();
}

/**
 * For the ESP32 / hardware: it can't do an interactive login, so it sends a shared
 * key in the `x-device-key` header (must match DEVICE_API_KEY in .env).
 */
function requireDeviceKey(req, res, next) {
  const expected = process.env.DEVICE_API_KEY;
  if (!expected) return res.status(500).json({ error: 'Server misconfigured: DEVICE_API_KEY not set' });
  const given = Buffer.from(String(req.headers['x-device-key'] || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Invalid device key' });
  }
  next();
}

module.exports = { requireDeviceKey, requireAuth, requireOfficer, requireHealthWorker, requireAdmin };
