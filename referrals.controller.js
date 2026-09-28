const { pool } = require('../config/db');
const { referralUpdateSchema } = require('../utils/validators');

async function listReferrals(req, res) {
  const { status, district } = req.query;
  const params = [];
  let where = '1=1';

  if (status) {
    params.push(status);
    where += ` and rf.status = $${params.length}`;
  }
  if (district) {
    params.push(district);
    where += ` and p.district = $${params.length}`;
  }
  // Any health worker (not just officers/admins) can see every patient's referrals —
  // patient data is shared across the whole team, not siloed to whoever registered them.

  const { rows } = await pool.query(
    `select rf.*, p.name as patient_name, p.village, p.block, p.district
     from referrals rf
     join patients p on p.id = rf.patient_id
     where ${where}
     order by rf.created_at desc`,
    params
  );
  res.json(rows);
}

async function updateReferral(req, res) {
  const update = referralUpdateSchema.parse(req.body);
  const { rows } = await pool.query(
    `update referrals set status = $1, notes = coalesce($2, notes), updated_at = now()
     where id = $3
     returning *`,
    [update.status, update.notes, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Referral not found' });
  res.json(rows[0]);
}

module.exports = { listReferrals, updateReferral };
