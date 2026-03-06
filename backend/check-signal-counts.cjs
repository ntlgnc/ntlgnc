require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(`
    SELECT date_trunc('day', s."createdAt") as day, COUNT(*) as sigs,
           COUNT(*) FILTER (WHERE s.pair_type = 'backfill') as backfilled
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND s."createdAt" >= '2026-02-20' AND s."createdAt" <= '2026-03-06'
    GROUP BY day ORDER BY day
  `);
  console.log('1m signals per day (Feb 20 - Mar 6):');
  for (const r of rows) {
    console.log('  ' + new Date(r.day).toISOString().slice(0,10) + ': ' + r.sigs + ' sigs (' + r.backfilled + ' backfilled)');
  }
  await c.end();
})();
