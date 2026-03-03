require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  const features = ['hurst', 'trend5d', 'posInRange'];
  const res = await c.query(
    `SELECT feature_key, bucket_label, direction_filter, bar_minutes, rho, confidence, oos_sharpe, oos_trades, spread
     FROM regime_scorecard WHERE feature_key = ANY($1)
     ORDER BY feature_key, bar_minutes, direction_filter, bucket_label`,
    [features]
  );

  console.log('feature_key    | bucket                 | dir   | tf   | rho    | confidence   | SR       | trades');
  console.log('-'.repeat(110));
  for (const r of res.rows) {
    const tf = r.bar_minutes >= 1440 ? '1d' : r.bar_minutes >= 60 ? '1h' : '1m';
    console.log(
      (r.feature_key || '').padEnd(15) + '| ' +
      (r.bucket_label || '').padEnd(23) + '| ' +
      (r.direction_filter || 'all').padEnd(6) + '| ' +
      tf.padEnd(5) + '| ' +
      String(r.rho ?? 'NULL').padEnd(7) + '| ' +
      (r.confidence || '?').padEnd(13) + '| ' +
      String(r.oos_sharpe ?? '?').padEnd(9) + '| ' +
      String(r.oos_trades ?? '?')
    );
  }

  // Coverage stats
  const stats = await c.query(
    `SELECT COUNT(*)::int as total,
            COUNT(rho)::int as has_rho,
            COUNT(*) FILTER (WHERE confidence = 'insufficient')::int as insufficient,
            COUNT(*) FILTER (WHERE confidence = 'high')::int as high_conf
     FROM regime_scorecard`
  );
  console.log('\n=== SCORECARD COVERAGE ===');
  console.log(stats.rows[0]);

  // Check which bar_minutes exist
  const tfs = await c.query(
    `SELECT DISTINCT bar_minutes FROM regime_scorecard ORDER BY bar_minutes`
  );
  console.log('Timeframes in scorecard:', tfs.rows.map(r => r.bar_minutes));

  c.release(); pool.end();
})();
