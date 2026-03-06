const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('═══ Spearman (rho) for ALL features, bar_minutes=1 ═══\n');

  const { rows } = await client.query(`
    SELECT feature_key, direction_filter, rho, spread, confidence,
           COUNT(*) OVER (PARTITION BY feature_key, direction_filter) as buckets
    FROM regime_scorecard
    WHERE bar_minutes = 1 AND bucket_index = 0
    ORDER BY direction_filter, ABS(rho) DESC
  `);

  let lastDir = '';
  for (const r of rows) {
    if (r.direction_filter !== lastDir) {
      console.log(`\n  ── ${r.direction_filter.toUpperCase()} ──`);
      lastDir = r.direction_filter;
    }
    const reliable = Math.abs(r.rho) >= 0.8 ? '✅ RELIABLE' : Math.abs(r.rho) >= 0.5 ? '⚠️  MODERATE' : '❌ WEAK';
    console.log(`  ${r.feature_key.padEnd(20)} ρ=${String(r.rho).padStart(6)} spread=${String(r.spread).padStart(6)} ${reliable}`);
  }

  console.log('\n\n═══ posInRange specifically across ALL timeframes ═══\n');
  
  const { rows: pir } = await client.query(`
    SELECT bar_minutes, direction_filter, rho, spread, 
           bucket_index, bucket_label, oos_sharpe, oos_trades
    FROM regime_scorecard
    WHERE feature_key = 'posInRange'
    ORDER BY bar_minutes, direction_filter, bucket_index
  `);

  let lastTf = 0;
  let lastDir2 = '';
  for (const r of pir) {
    if (r.bar_minutes !== lastTf) {
      const label = r.bar_minutes === 1 ? '1M' : r.bar_minutes === 60 ? '1H' : '1D';
      console.log(`\n  ── ${label} ──`);
      lastTf = r.bar_minutes;
      lastDir2 = '';
    }
    if (r.direction_filter !== lastDir2) {
      const reliable = Math.abs(r.rho) >= 0.8 ? '✅ RELIABLE' : Math.abs(r.rho) >= 0.5 ? '⚠️  MODERATE' : '❌ WEAK';
      console.log(`  ${r.direction_filter.padEnd(6)} ρ=${r.rho} ${reliable}`);
      lastDir2 = r.direction_filter;
    }
    console.log(`    bucket ${r.bucket_index} "${r.bucket_label}" SR=${String(r.oos_sharpe).padStart(6)} n=${String(r.oos_trades).padStart(5)}`);
  }

  await client.end();
}
main().catch(err => console.error(err.message));
