const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Check if 1m candle data exists during the gap
  const { rows } = await c.query(`
    SELECT date_trunc('day', timestamp) as day,
           COUNT(DISTINCT symbol) as coins,
           COUNT(*) as candles
    FROM "Candle1m"
    WHERE timestamp >= '2026-02-23' AND timestamp <= '2026-03-05'
    GROUP BY day ORDER BY day
  `);
  console.log('1m candle data per day (Feb 23 - Mar 5):');
  for (const r of rows) {
    console.log(`  ${new Date(r.day).toISOString().slice(0,10)}: ${r.coins} coins, ${r.candles} candles`);
  }

  // Check what the 1m strategy config was on Feb 23 (last working day)
  // Look at signals from Feb 23 to see which coins were being tracked
  const { rows: feb23coins } = await c.query(`
    SELECT DISTINCT symbol
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND s."createdAt" >= '2026-02-23' AND s."createdAt" < '2026-02-24'
  `);
  console.log(`\nCoins with 1m signals on Feb 23: ${feb23coins.length}`);
  console.log(feb23coins.map(r => r.symbol).join(', '));

  // Check the current 1m strategy's coin_universe
  const { rows: strat } = await c.query(`
    SELECT config FROM "FracmapStrategy" WHERE "barMinutes" = 1 AND active = true LIMIT 1
  `);
  if (strat[0]) {
    const conf = strat[0].config || {};
    const coins = conf.coin_universe || [];
    console.log(`\nCurrent 1m strategy coin_universe: ${coins.length} coins`);
    if (coins.length > 0) console.log(coins.slice(0, 10).join(', '), '...');
  }

  // Check if there was a DIFFERENT 1m strategy before that got deleted
  // Look at strategyId of signals from Feb 23 vs Mar 4+
  const { rows: stratIds } = await c.query(`
    SELECT DISTINCT s."strategyId",
           CASE WHEN s."createdAt" < '2026-02-24' THEN 'before' ELSE 'after' END as period
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
    ORDER BY period
  `);
  console.log('\nStrategy IDs used by 1m signals:');
  for (const r of stratIds) {
    console.log(`  ${r.period}: strategyId=${r.strategyId}`);
  }

  await c.end();
})();
