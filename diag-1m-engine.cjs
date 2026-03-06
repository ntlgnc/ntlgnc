const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Check all strategies with barMinutes=1
  const { rows: strats } = await c.query(`
    SELECT id, name, active, "barMinutes", "createdAt", "updatedAt",
           config->>'coin_universe' as coins
    FROM "FracmapStrategy"
    WHERE "barMinutes" = 1
    ORDER BY "createdAt"
  `);
  console.log('1m strategies:');
  for (const s of strats) {
    const coins = s.coins ? JSON.parse(s.coins).length : 0;
    console.log(`  ${String(s.id).slice(0,8)}... name=${s.name} active=${s.active} coins=${coins} created=${new Date(s.createdAt).toISOString().slice(0,10)} updated=${new Date(s.updatedAt).toISOString().slice(0,10)}`);
  }

  // Check last signal from each 1m strategy before and after the gap
  for (const s of strats) {
    const { rows: last } = await c.query(`
      SELECT "createdAt", symbol, direction, status
      FROM "FracmapSignal"
      WHERE "strategyId" = $1
      ORDER BY "createdAt" DESC LIMIT 1
    `, [s.id]);
    const { rows: beforeGap } = await c.query(`
      SELECT "createdAt", symbol, direction, status
      FROM "FracmapSignal"
      WHERE "strategyId" = $1 AND "createdAt" < '2026-02-24'
      ORDER BY "createdAt" DESC LIMIT 1
    `, [s.id]);
    const { rows: afterGap } = await c.query(`
      SELECT "createdAt", symbol, direction, status
      FROM "FracmapSignal"
      WHERE "strategyId" = $1 AND "createdAt" > '2026-03-03'
      ORDER BY "createdAt" ASC LIMIT 1
    `, [s.id]);
    console.log(`\n  Strategy ${s.name} (${String(s.id).slice(0,8)}):`);
    console.log(`    Last signal: ${last[0] ? new Date(last[0].createdAt).toISOString() : 'none'}`);
    console.log(`    Last before gap: ${beforeGap[0] ? new Date(beforeGap[0].createdAt).toISOString() : 'none'}`);
    console.log(`    First after gap: ${afterGap[0] ? new Date(afterGap[0].createdAt).toISOString() : 'none'}`);
  }

  // Check 1h and 1d signals during the gap - were they running?
  for (const [label, bm] of [['1h', 60], ['1d', 1440]]) {
    const { rows } = await c.query(`
      SELECT date_trunc('day', s."createdAt") as day, COUNT(*) as sigs
      FROM "FracmapSignal" s
      LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE st."barMinutes" = $1
        AND s."createdAt" >= '2026-02-22'
        AND s."createdAt" <= '2026-03-06'
      GROUP BY day ORDER BY day
    `, [bm]);
    console.log(`\n${label} signals per day (Feb 22 - Mar 6):`);
    for (const r of rows) {
      console.log(`  ${new Date(r.day).toISOString().slice(0,10)}: ${r.sigs}`);
    }
  }

  // Check pm2 restart events or any signals with status='expired' or 'pending' in the gap
  const { rows: gapSigs } = await c.query(`
    SELECT status, COUNT(*) as cnt
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND s."createdAt" >= '2026-02-23'
      AND s."createdAt" <= '2026-03-04'
    GROUP BY status
  `);
  console.log('\n1m signals in gap period (Feb 23 - Mar 4) by status:');
  for (const r of gapSigs) {
    console.log(`  ${r.status}: ${r.cnt}`);
  }

  await c.end();
})();
