const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ntlgnc' });

(async () => {
  // Count 1m hedged closed pairs by age bucket
  const { rows } = await pool.query(`
    SELECT
      CASE
        WHEN s."closedAt" > NOW() - INTERVAL '1 day' THEN '1d'
        WHEN s."closedAt" > NOW() - INTERVAL '7 days' THEN '1w'
        WHEN s."closedAt" > NOW() - INTERVAL '30 days' THEN '1m'
        ELSE 'older'
      END as bucket,
      COUNT(DISTINCT s.pair_id) as pair_count,
      MIN(s."closedAt")::text as earliest,
      MAX(s."closedAt")::text as latest
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL
      AND s.status = 'closed'
      AND (st."barMinutes" = 1 OR st."barMinutes" IS NULL)
      AND s."closedAt" IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);
  console.log('1m pairs by closedAt bucket:');
  console.table(rows);

  // Check NULL closedAt
  const { rows: nulls } = await pool.query(`
    SELECT COUNT(DISTINCT s.pair_id) as null_closed_pairs
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL
      AND s.status = 'closed'
      AND (st."barMinutes" = 1 OR st."barMinutes" IS NULL)
      AND s."closedAt" IS NULL
  `);
  console.log('Pairs with NULL closedAt:', nulls[0].null_closed_pairs);

  // Sample some closedAt values for 1m pairs in 2-7 day range
  const { rows: samples } = await pool.query(`
    SELECT DISTINCT ON (s.pair_id)
      s.pair_id, s."closedAt"::text, s."createdAt"::text, s.symbol
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL
      AND s.status = 'closed'
      AND (st."barMinutes" = 1 OR st."barMinutes" IS NULL)
      AND s."closedAt" > NOW() - INTERVAL '7 days'
      AND s."closedAt" < NOW() - INTERVAL '1 day'
    LIMIT 5
  `);
  console.log('Sample 1m pairs closed 1-7 days ago:');
  console.table(samples);

  pool.end();
})();
