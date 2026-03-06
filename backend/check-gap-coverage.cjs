const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Coins that had data on Feb 22-23 (before gap)
  const { rows: beforeGap } = await c.query(`
    SELECT DISTINCT symbol FROM "Candle1m"
    WHERE timestamp >= '2026-02-22' AND timestamp < '2026-02-24'
  `);
  const beforeCoins = new Set(beforeGap.map(r => r.symbol));

  // Coins that have data during gap (Feb 24 - Mar 3)
  const { rows: duringGap } = await c.query(`
    SELECT DISTINCT symbol FROM "Candle1m"
    WHERE timestamp >= '2026-02-24' AND timestamp < '2026-03-04'
  `);
  const gapCoins = new Set(duringGap.map(r => r.symbol));

  const missing = [...beforeCoins].filter(c => !gapCoins.has(c));
  console.log(`Coins before gap: ${beforeCoins.size}`);
  console.log(`Coins with gap data: ${gapCoins.size}`);
  console.log(`Missing gap data: ${missing.length}`);
  if (missing.length <= 30) console.log('Missing:', missing.join(', '));

  // How many of the gap coins have >= 10000 candles in gap?
  const { rows: coverage } = await c.query(`
    SELECT symbol, COUNT(*) as cnt
    FROM "Candle1m"
    WHERE timestamp >= '2026-02-24' AND timestamp < '2026-03-04'
    GROUP BY symbol ORDER BY cnt DESC LIMIT 10
  `);
  console.log('\nTop coins by gap coverage:');
  for (const r of coverage) console.log(`  ${r.symbol}: ${r.cnt} candles`);

  await c.end();
})();
