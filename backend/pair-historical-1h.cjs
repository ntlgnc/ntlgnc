/**
 * Retroactively pair 1H signals that don't have pair_id yet.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const STRAT_ID = '565b90e1-365d-46a6-87c4-77499b54deec'; // Universal 60m -V1
const MAX_GAP_HOURS = 1; // 1 hour gap max
const MODE = 'exclusive';

(async () => {
  const client = await pool.connect();
  try {
    console.log('Pairing 1H signals (exclusive, max_gap=' + MAX_GAP_HOURS + 'h)...\n');

    const { rows: signals } = await client.query(
      `SELECT id, symbol, direction, "entryPrice", "holdBars", strength, status, "returnPct", "createdAt"
       FROM "FracmapSignal"
       WHERE "strategyId" = $1 AND pair_id IS NULL AND status IN ('open', 'closed')
       ORDER BY "createdAt" ASC`,
      [STRAT_ID]
    );
    console.log('Unpaired signals:', signals.length);

    const used = new Set();
    let paired = 0;

    for (let i = 0; i < signals.length; i++) {
      if (used.has(signals[i].id)) continue;
      const A = signals[i];

      let bestIdx = -1;
      let bestScore = -Infinity;

      for (let j = 0; j < i; j++) {
        if (used.has(signals[j].id)) continue;
        const B = signals[j];
        if (B.direction === A.direction) continue;
        if (B.symbol === A.symbol) continue;

        const gapMs = new Date(A.createdAt).getTime() - new Date(B.createdAt).getTime();
        const gapHours = gapMs / 3600000;
        if (gapHours > MAX_GAP_HOURS || gapHours < 0) continue;

        const tier = gapHours < 0.1 ? 1 : 2;
        const score = (tier === 1 ? 100000 : 0) + B.strength * 10 - gapHours * 100;
        if (score > bestScore) { bestScore = score; bestIdx = j; }
      }

      if (bestIdx >= 0) {
        const B = signals[bestIdx];
        const pairId = crypto.randomUUID();
        let pairReturn = null;
        if (A.status === 'closed' && B.status === 'closed' && A.returnPct != null && B.returnPct != null) {
          pairReturn = +(parseFloat(A.returnPct) + parseFloat(B.returnPct)).toFixed(4);
        }

        await client.query(
          `UPDATE "FracmapSignal" SET pair_id = $1, pair_symbol = $2, pair_direction = $3, pair_return = $4 WHERE id = $5`,
          [pairId, B.symbol, B.direction, pairReturn, A.id]
        );
        await client.query(
          `UPDATE "FracmapSignal" SET pair_id = $1, pair_symbol = $2, pair_direction = $3, pair_return = $4 WHERE id = $5`,
          [pairId, A.symbol, A.direction, pairReturn, B.id]
        );

        used.add(A.id);
        used.add(B.id);
        paired++;

        if (paired <= 10 || paired % 50 === 0) {
          const retStr = pairReturn != null ? (pairReturn >= 0 ? '+' : '') + pairReturn.toFixed(2) + '%' : 'open';
          console.log('  ' + A.symbol.padEnd(14) + A.direction + ' + ' + B.symbol.padEnd(14) + B.direction + ' → ' + retStr);
        }
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log('Pairs created:', paired);
    console.log('Signals paired:', used.size);
    console.log('Remaining unpaired:', signals.length - used.size);

    // Stats
    const { rows: [stats] } = await client.query(
      `SELECT COUNT(DISTINCT pair_id)::int as pairs,
              AVG(pair_return) FILTER (WHERE pair_return IS NOT NULL) as avg_ret,
              COUNT(*) FILTER (WHERE pair_return > 0)::int / GREATEST(1, COUNT(*) FILTER (WHERE pair_return IS NOT NULL)::int) * 100 as wr
       FROM "FracmapSignal"
       WHERE "strategyId" = $1 AND pair_id IS NOT NULL`,
      [STRAT_ID]
    );
    console.log('Total 1H pairs:', stats.pairs);
    if (stats.avg_ret != null) console.log('Avg pair return:', (stats.avg_ret >= 0 ? '+' : '') + (+stats.avg_ret).toFixed(3) + '%');

  } finally {
    client.release();
    pool.end();
  }
})();
