const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://ntlgnc:Ntlgnc2026@localhost:5432/ntlgnc_db?schema=public' });

(async () => {
  // Find open 1h paired signals
  const { rows } = await pool.query(`
    SELECT s.id, s.pair_id, s.symbol, s.direction, s.status, s."entryPrice",
           s."createdAt"::text, s."closedAt"::text, st."barMinutes", st.active, st.name
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL AND s.status = 'open'
      AND st."barMinutes" >= 60 AND st."barMinutes" < 1440
    ORDER BY s."createdAt" DESC
  `);
  console.log('Open 1h paired signals:', rows.length);
  for (const r of rows) {
    console.log(`  pair_id=${r.pair_id} symbol=${r.symbol} dir=${r.direction} status=${r.status} active=${r.active} created=${r.createdAt}`);
  }

  // Check if these pair_ids have exactly 2 legs
  if (rows.length > 0) {
    const pairIds = [...new Set(rows.map(r => r.pair_id))];
    for (const pid of pairIds) {
      const { rows: legs } = await pool.query(`
        SELECT s.id, s.symbol, s.status, s.direction, s."createdAt"::text, s."closedAt"::text
        FROM "FracmapSignal" s
        WHERE s.pair_id = $1
        ORDER BY s."createdAt"
      `, [pid]);
      console.log(`\nPair ${pid} has ${legs.length} legs:`);
      for (const l of legs) {
        console.log(`  ${l.symbol} ${l.direction} status=${l.status} created=${l.createdAt} closed=${l.closedAt}`);
      }
    }
  }

  pool.end();
})();
