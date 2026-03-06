require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Get the 10 most recent closed 1m pairs
  const { rows } = await c.query(`
    SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
           s."returnPct", s.status, s."createdAt", s."closedAt",
           s."holdBars", s."maxCycle", s.pair_id, s.pair_symbol,
           s.pair_direction, s.pair_return, s.pair_type, s.tick_id,
           s."detectedAt", s."enteredAt"
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND s.pair_id IS NOT NULL
      AND s.status = 'closed'
      AND s."returnPct" IS NOT NULL
    ORDER BY s."closedAt" DESC
    LIMIT 20
  `);

  // Group by pair_id
  const pairs = {};
  for (const r of rows) {
    if (!pairs[r.pair_id]) pairs[r.pair_id] = [];
    pairs[r.pair_id].push(r);
  }

  let count = 0;
  for (const [pairId, legs] of Object.entries(pairs)) {
    if (count >= 10) break;
    count++;
    legs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    console.log(`\n═══ PAIR ${count}: ${pairId.slice(0,8)}... ═══`);
    console.log(`  pair_type: ${legs[0].pair_type}`);
    console.log(`  pair_return: ${legs[0].pair_return}%`);
    console.log(`  tick_id: ${legs[0].tick_id}`);
    for (const leg of legs) {
      const created = new Date(leg.createdAt).toISOString().replace('T', ' ').slice(0, 19);
      const closed = leg.closedAt ? new Date(leg.closedAt).toISOString().replace('T', ' ').slice(0, 19) : '—';
      const entered = leg.enteredAt ? new Date(leg.enteredAt).toISOString().replace('T', ' ').slice(0, 19) : '—';
      console.log(`  LEG: ${leg.direction.padEnd(5)} ${leg.symbol.padEnd(14)} entry=${leg.entryPrice} exit=${leg.exitPrice} ret=${leg.returnPct}%`);
      console.log(`        created=${created} entered=${entered} closed=${closed} hold=${leg.holdBars} cycle=${leg.maxCycle}`);
    }
  }

  await c.end();
})();
