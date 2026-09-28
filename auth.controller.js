const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { credentialsSchema, healthWorkerCreateSchema } = require('../utils/validators');

const BCRYPT_ROUNDS = 10;

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

/**
 * POST /api/auth/register  — public. A patient creates their own login.
 * Returns a token; the app then calls POST /api/patients/me to create the patient profile.
 */
async function register(req, res) {
  const { email, password } = credentialsSchema.parse(req.body);
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const { rows } = await pool.query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email',
      [email, hash]
    );
    res.status(201).json({ token: signToken(rows[0].id), user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    throw err;
  }
}

/** POST /api/auth/login — public. Works for both health workers and patients. */
async function login(req, res) {
  const { email, password } = credentialsSchema.parse(req.body);

  const { rows } = await pool.query('select id, email, password_hash from users where email = $1', [email]);
  const ok = rows.length > 0 && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const userId = rows[0].id;
  const hw = await pool.query('select id, name, role from health_workers where auth_user_id = $1', [userId]);
  const pt = hw.rows.length ? { rows: [] } : await pool.query('select id, name from patients where auth_user_id = $1', [userId]);

  res.json({
    token: signToken(userId),
    user: { id: userId, email: rows[0].email },
    account_type: hw.rows.length ? 'health_worker' : pt.rows.length ? 'patient' : 'new',
    profile: hw.rows[0] || pt.rows[0] || null,
  });
}

/**
 * POST /api/auth/health-workers — admin only. Creates a login + health_workers row in one go.
 * (Replaces the old manual "insert into health_workers" step.)
 */
async function createHealthWorker(req, res) {
  const data = healthWorkerCreateSchema.parse(req.body);
  const hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('insert into users (email, password_hash) values ($1, $2) returning id', [data.email, hash]);
    const hw = await client.query(
      `insert into health_workers (auth_user_id, name, phone, role, village, block, district, language_pref)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'en'))
       returning id, name, phone, role, village, block, district, language_pref`,
      [u.rows[0].id, data.name, data.phone || null, data.role, data.village || null, data.block || null, data.district || null, data.language_pref || null]
    );
    await client.query('COMMIT');
    res.status(201).json({ ...hw.rows[0], email: data.email });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email or phone already in use' });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { register, login, createHealthWorker };
