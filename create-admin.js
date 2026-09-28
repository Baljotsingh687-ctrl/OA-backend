// Creates the first admin health worker (bootstrap). Usage:
//   npm run create-admin -- admin@example.com 'StrongPassword123' 'Admin Name'
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/db');

async function main() {
  const [email, password, name = 'Admin'] = process.argv.slice(2);
  if (!email || !password || password.length < 8) {
    console.error("Usage: npm run create-admin -- <email> <password (8+ chars)> [name]");
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('insert into users (email, password_hash) values ($1,$2) returning id', [email.toLowerCase(), hash]);
    await client.query("insert into health_workers (auth_user_id, name, role) values ($1,$2,'admin')", [u.rows[0].id, name]);
    await client.query('COMMIT');
    console.log(`Admin created: ${email}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main();
