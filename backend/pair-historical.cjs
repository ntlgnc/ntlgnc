/**
 * Retroactively pair existing signals that don't have pair_id yet.
 * Uses the same logic as live-signals.cjs: find opposite-direction
 * signals on different coins within max_gap days.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    // Get hedging config from active 1D strategy
    const { rows: [strat] } = await client.query(
      `SELECT id, name, config, "barMinutes" FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = 1440 AND config IS NOT NULL LIMIT 1`
    );
    if (!strat || !strat.config?.hedging_enabled) {
      console.log('No active 1D strategy with hedging enabled.');
      await client.end();
      return;
    }

    const maxGapDays = strat.config.max_gap || 1;
    const hedgeMode = strat.config.hedge_mode || 'exclusive';
    console.log('Strategy:', strat.name);
    console.log('Mode:', hedgeMode, '| Max gap:', maxGapDays, 'day(s)\n');

    // Get all unpaired signals for this strategy, sorted by creation time
    const { rows: signals } = await client.query(
      `SELECT id, symbol, direction, "entryPrice", "holdBars", strength, status, "returnPct", "createdAt"
       FROM "FracmapSignal"
       WHERE "strategyId" = $1 AND pair_id IS NULL AND status IN ('open', 'closed')
       ORDER BY "createdAt" ASC`,
      [strat.id]
    );
    console.log('Unpaired signals:', signals.length);

    const used = new Set();
    let paired = 0;

    for (let i = 0; i < signals.length; i++) {
      if (hedgeMode === 'exclusive' && used.has(signals[i].id)) continue;
      const A = signals[i];

      let bestIdx = -1;
      let bestScore = -Infinity;

      // Search backwards for opposite-direction signal within gap window
      for (let j = 0; j < signals.length; j++) {
        if (j === i) continue;
        if (hedgeMode === 'exclusive' && used.has(signals[j].id)) continue;
        const B = signals[j];

        if (B.direction === A.direction) continue;
        if (B.symbol === A.symbol) continue;

        // Check gap: B must have been created within maxGapDays of A
        const gapMs = Math.abs(new Date(A.createdAt).getTime() - new Date(B.createdAt).getTime());
        const gapDays = gapMs / 86400000;
        if (gapDays > maxGapDays) continue;

        // B should have been created before or at same time as A (not forward-looking)
        if (new Date(B.createdAt).getTime() > new Date(A.createdAt).getTime()) continue;

        const gap = gapDays;
        const tier = gap < 0.1 ? 1 : 2;
        const score = (tier === 1 ? 100000 : 0) + B.strength * 10 - gap * 100;

        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }

      if (bestIdx >= 0) {
        const B = signals[bestIdx];
        const pairId = crypto.randomUUID();

        // Compute pair_return if both are closed
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

        if (hedgeMode === 'exclusive') {
          used.add(A.id);
          used.add(B.id);
        }
        paired++;

        if (paired <= 10 || paired % 20 === 0) {
          const retStr = pairReturn != null ? (pairReturn >= 0 ? '+' : '') + pairReturn.toFixed(2) + '%' : 'open';
          console.log('  Paired: ' + A.symbol + ' ' + A.direction + ' + ' + B.symbol + ' ' + B.direction + ' → ' + retStr);
        }
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log('Pairs created:', paired);
    console.log('Signals used:', hedgeMode === 'exclusive' ? used.size : paired * 2);
    console.log('Remaining unpaired:', signals.length - (hedgeMode === 'exclusive' ? used.size : paired * 2));

    // Stats on paired results
    const { rows: [stats] } = await client.query(
      `SELECT COUNT(DISTINCT pair_id) as pairs,
              COUNT(*) FILTER (WHERE pair_return IS NOT NULL)::int / 2 as closed_pairs,
              AVG(pair_return) FILTER (WHERE pair_return IS NOT NULL) as avg_ret,
              COUNT(*) FILTER (WHERE pair_return > 0)::int / 2 as wins
       FROM "FracmapSignal"
       WHERE "strategyId" = $1 AND pair_id IS NOT NULL`,
      [strat.id]
    );
    if (stats.pairs > 0) {
      console.log('\nPair stats:');
      console.log('  Total pairs:', stats.pairs);
      console.log('  Closed pairs:', stats.closed_pairs);
      if (stats.avg_ret != null) {
        console.log('  Avg pair return:', (stats.avg_ret >= 0 ? '+' : '') + (+stats.avg_ret).toFixed(3) + '%');
      }
    }

  } finally {
    client.release();
    pool.end();
  }
})();
