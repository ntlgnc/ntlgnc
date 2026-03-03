require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();

  // What's in the scorecard?
  const { rows: keys } = await c.query(`
    SELECT DISTINCT bar_minutes, feature_key
    FROM regime_scorecard
    ORDER BY bar_minutes, feature_key
  `);
  console.log('Scorecard feature_keys by timeframe:\n');
  keys.forEach(r => {
    const tf = r.bar_minutes >= 1440 ? '1D' : r.bar_minutes >= 60 ? '1H' : '1m';
    console.log('  ' + tf + ' | ' + r.feature_key);
  });

  // Also check: is there is_sharpe column?
  const { rows: cols } = await c.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'regime_scorecard'
    ORDER BY ordinal_position
  `);
  console.log('\nScorecard columns:', cols.map(r => r.column_name).join(', '));

  // Show a sample row
  const { rows: sample } = await c.query(`
    SELECT * FROM regime_scorecard
    WHERE feature_key LIKE '%posInRange%' OR feature_key LIKE '%pos%'
    LIMIT 5
  `);
  if (sample.length > 0) {
    console.log('\nSample posInRange rows:');
    sample.forEach(r => console.log('  ', JSON.stringify(r)));
  } else {
    // Try any row
    const { rows: any } = await c.query('SELECT * FROM regime_scorecard LIMIT 3');
    console.log('\nSample rows (any):');
    any.forEach(r => console.log('  ', r.feature_key, r.bucket_label, r.bar_minutes, 'rho=' + r.rho, 'is_sharpe=' + r.is_sharpe, 'oos_sharpe=' + r.oos_sharpe));
  }

  c.release(); pool.end();
})();
