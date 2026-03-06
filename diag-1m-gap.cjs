const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Check 1m signal counts per day in the gap period
  const { rows } = await c.query(`
    SELECT date_trunc('day', s."createdAt") as day,
           COUNT(*) as signals,
           COUNT(*) FILTER (WHERE s.status = 'closed') as closed,
           COUNT(*) FILTER (WHERE s.direction = 'LONG') as longs,
           COUNT(*) FILTER (WHERE s.direction = 'SHORT') as shorts
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND s."createdAt" >= '2026-02-20'
      AND s."createdAt" <= '2026-03-06'
    GROUP BY day ORDER BY day
  `);

  console.log('1m signals per day (Feb 20 - Mar 6):');
  for (const r of rows) {
    const d = new Date(r.day).toISOString().slice(0, 10);
    console.log(`  ${d}: ${r.signals} sigs (${r.closed} closed, ${r.longs}L/${r.shorts}S)`);
  }

  // Check how many of those had BOTH long and short on the same bar
  const { rows: pairCheck } = await c.query(`
    SELECT date_trunc('day', s."createdAt") as day,
           COUNT(DISTINCT floor(extract(epoch from s."createdAt") * 1000 / 60000)) as bars_with_sigs
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND s.status = 'closed' AND s."returnPct" IS NOT NULL
      AND s."createdAt" >= '2026-02-20'
      AND s."createdAt" <= '2026-03-06'
    GROUP BY day ORDER BY day
  `);

  console.log('\nBars with closed signals per day:');
  for (const r of pairCheck) {
    const d = new Date(r.day).toISOString().slice(0, 10);
    console.log(`  ${d}: ${r.bars_with_sigs} bars`);
  }

  // Check if any pairs were actually formed in the gap period
  const { rows: pairs } = await c.query(`
    SELECT date_trunc('day', s."createdAt") as day, COUNT(*) as paired_sigs
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND s.status = 'closed' AND s."returnPct" IS NOT NULL
      AND s."createdAt" >= '2026-02-22'
      AND s."createdAt" <= '2026-03-04'
    GROUP BY day ORDER BY day
  `);

  console.log('\nClosed signals with returnPct per day (Feb 22 - Mar 4):');
  for (const r of pairs) {
    const d = new Date(r.day).toISOString().slice(0, 10);
    console.log(`  ${d}: ${r.paired_sigs}`);
  }

  await c.end();
})();
