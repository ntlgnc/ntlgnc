const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const { rows } = await c.query(`
    SELECT
      CASE WHEN s."createdAt" > NOW() - INTERVAL '2 weeks' THEN 'last_2w' ELSE 'earlier' END as period,
      COUNT(*) as signals,
      ROUND(AVG(s."returnPct")::numeric, 4) as avg_ret,
      ROUND((SUM(CASE WHEN s."returnPct" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) * 100)::numeric, 1) as win_rate,
      ROUND(SUM(s."returnPct")::numeric, 2) as total_ret
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status = 'closed' AND s."returnPct" IS NOT NULL
      AND st."barMinutes" = 1
      AND s."createdAt" >= NOW() - INTERVAL '2 months'
    GROUP BY period
    ORDER BY period
  `);

  console.log('1m signal performance by period:');
  rows.forEach(r => console.log(`  ${r.period}: ${r.signals} sigs, avg ${r.avg_ret}%, WR ${r.win_rate}%, total ${r.total_ret}%`));

  await c.end();
})();
