require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  for (const [label, bm] of [['1m', 1], ['1h', 60], ['1d', 1440]]) {
    // Paired closed signals
    const { rows: [paired] } = await c.query(`
      SELECT COUNT(*) as cnt,
             AVG("returnPct") as avg_ret,
             COUNT(*) FILTER (WHERE "returnPct" > 0) as wins
      FROM "FracmapSignal" s
      LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE st."barMinutes" = $1 AND s.status = 'closed' AND s."returnPct" IS NOT NULL
        AND s.pair_id IS NOT NULL
    `, [bm]);

    // Unpaired (orphan) closed signals
    const { rows: [orphan] } = await c.query(`
      SELECT COUNT(*) as cnt,
             AVG("returnPct") as avg_ret,
             COUNT(*) FILTER (WHERE "returnPct" > 0) as wins
      FROM "FracmapSignal" s
      LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE st."barMinutes" = $1 AND s.status = 'closed' AND s."returnPct" IS NOT NULL
        AND s.pair_id IS NULL
    `, [bm]);

    const pWR = paired.cnt > 0 ? (paired.wins / paired.cnt * 100).toFixed(1) : '—';
    const oWR = orphan.cnt > 0 ? (orphan.wins / orphan.cnt * 100).toFixed(1) : '—';
    const pAvg = paired.avg_ret ? (+paired.avg_ret).toFixed(4) : '—';
    const oAvg = orphan.avg_ret ? (+orphan.avg_ret).toFixed(4) : '—';

    console.log(`${label}:`);
    console.log(`  Paired:   ${paired.cnt} signals, avg=${pAvg}%, WR=${pWR}%`);
    console.log(`  Orphans:  ${orphan.cnt} signals, avg=${oAvg}%, WR=${oWR}%`);
  }

  await c.end();
})();
