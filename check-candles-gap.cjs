const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'backend', '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(`
    SELECT date_trunc('day', timestamp) as day,
           COUNT(DISTINCT symbol) as coins,
           COUNT(*) as candles
    FROM "Candle1m"
    WHERE timestamp >= '2026-02-22' AND timestamp <= '2026-03-05'
    GROUP BY day ORDER BY day
  `);
  console.log('1m candle data per day (Feb 22 - Mar 5):');
  for (const r of rows) {
    console.log('  ' + new Date(r.day).toISOString().slice(0,10) + ': ' + r.coins + ' coins, ' + r.candles + ' candles');
  }
  await c.end();
})();
