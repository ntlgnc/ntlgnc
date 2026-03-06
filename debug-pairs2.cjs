const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://ntlgnc:Ntlgnc2026@localhost:5432/ntlgnc_db?schema=public' });

(async () => {
  const r1 = await pool.query(`
    SELECT
      CASE
        WHEN s."closedAt" > NOW() - INTERVAL '1 day' THEN 'last_1d'
        WHEN s."closedAt" > NOW() - INTERVAL '7 days' THEN 'last_1w'
        WHEN s."closedAt" > NOW() - INTERVAL '30 days' THEN 'last_1m'
        ELSE 'older'
      END as bucket,
      COUNT(DISTINCT s.pair_id) as pairs
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL AND s.status = 'closed'
      AND st."barMinutes" = 1 AND s."closedAt" IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `);
  console.log('1m closed pairs by closedAt age:');
  for (const r of r1.rows) console.log(' ', r.bucket, ':', r.pairs, 'pairs');

  const r2 = await pool.query(`
    SELECT COUNT(DISTINCT pair_id) as cnt
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL AND s.status = 'closed'
      AND st."barMinutes" = 1 AND s."closedAt" IS NULL
  `);
  console.log('1m with NULL closedAt:', r2.rows[0].cnt, 'pairs');

  // Also check by createdAt for comparison
  const r3 = await pool.query(`
    SELECT
      CASE
        WHEN s."createdAt" > NOW() - INTERVAL '1 day' THEN 'last_1d'
        WHEN s."createdAt" > NOW() - INTERVAL '7 days' THEN 'last_1w'
        WHEN s."createdAt" > NOW() - INTERVAL '30 days' THEN 'last_1m'
        ELSE 'older'
      END as bucket,
      COUNT(DISTINCT s.pair_id) as pairs
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL AND s.status = 'closed'
      AND st."barMinutes" = 1
    GROUP BY 1 ORDER BY 1
  `);
  console.log('\n1m closed pairs by createdAt age:');
  for (const r of r3.rows) console.log(' ', r.bucket, ':', r.pairs, 'pairs');

  pool.end();
})();
