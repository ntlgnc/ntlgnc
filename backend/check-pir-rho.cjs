require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();
  const { rows } = await c.query(
    `SELECT feature_key, bucket_label, direction_filter, rho, confidence, oos_sharpe, oos_trades
     FROM regime_scorecard
     WHERE bar_minutes = 1 AND feature_key = 'posInRange60'
     ORDER BY direction_filter, bucket_label`
  );
  console.log('PiR scorecard for 1m bars:\n');
  console.log('  Dir    | Bucket                | Rho  | Confidence   | SR     | Trades');
  console.log('  ' + '-'.repeat(75));
  rows.forEach(r => {
    const rho = r.rho != null ? (+r.rho).toFixed(1) : '?';
    const sr = r.oos_sharpe != null ? (+r.oos_sharpe).toFixed(2) : '?';
    console.log('  ' + (r.direction_filter || '?').padEnd(7) + '| ' +
      (r.bucket_label || '?').padEnd(22) + '| ' +
      rho.padStart(4) + ' | ' +
      (r.confidence || '?').padEnd(12) + ' | ' +
      sr.padStart(6) + ' | ' +
      r.oos_trades);
  });
  c.release(); pool.end();
})();
