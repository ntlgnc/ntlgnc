const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('═══ Scorecard: posInRange, bar_minutes=1 ═══\n');

  const { rows } = await client.query(`
    SELECT direction_filter, bucket_index, bucket_label, 
           oos_sharpe, oos_trades, oos_win_rate, oos_avg_ret
    FROM regime_scorecard
    WHERE feature_key = 'posInRange' AND bar_minutes = 1
    ORDER BY direction_filter, bucket_index
  `);

  for (const r of rows) {
    console.log(`  ${r.direction_filter.padEnd(6)} bucket ${r.bucket_index} "${r.bucket_label.padEnd(20)}" SR=${String(r.oos_sharpe).padStart(6)} n=${String(r.oos_trades).padStart(5)} WR=${r.oos_win_rate}% AvgR=${r.oos_avg_ret}%`);
  }

  console.log('\n═══ Explanation ═══');
  console.log('  Scorecard page (direction=All) shows the "all" rows');
  console.log('  Filter matrix shows the "long" and "short" rows');
  console.log('  These are computed independently — they won\'t be simple averages');

  await client.end();
}
main().catch(err => console.error(err.message));
