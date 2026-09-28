const { pool } = require('../config/db');

async function districtSummary(req, res) {
  const { rows } = await pool.query('select * from v_district_risk_summary order by district, block');
  res.json(rows);
}

async function overallStats(req, res) {
  const { rows } = await pool.query(`
    select
      (select count(*) from patients) as total_patients,
      (select count(*) from risk_assessments where risk_tier = 'high') as high_risk_count,
      (select count(*) from risk_assessments where risk_tier = 'moderate') as moderate_risk_count,
      (select count(*) from risk_assessments where risk_tier = 'low') as low_risk_count,
      (select count(*) from referrals where status = 'pending') as pending_referrals,
      (select count(*) from referrals where status = 'completed') as completed_referrals,
      (select count(distinct health_worker_id) from patients) as active_health_workers
  `);
  res.json(rows[0]);
}

/** Simple time-series: new patients screened per day, last 30 days — for a trend chart. */
async function screeningTrend(req, res) {
  const { rows } = await pool.query(`
    select date_trunc('day', created_at)::date as day, count(*) as patients_screened
    from patients
    where created_at >= now() - interval '30 days'
    group by 1
    order by 1
  `);
  res.json(rows);
}

module.exports = { districtSummary, overallStats, screeningTrend };
