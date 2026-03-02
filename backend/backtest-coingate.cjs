/**
 * Backtest: Coin Quality Gate
 *
 * For each coin+strategy, replay all closed signals chronologically.
 * At each signal, compute the trailing 25-trade win rate.
 * If WR < 35% (and >= 10 trades), the gate would have blocked.
 * Compare returns of "would-have-been-blocked" vs "would-have-passed" signals.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const LOOKBACK = 25;
const MIN_TRADES = 10;
const GATE_WR = 35;

(async () => {
  const client = await pool.connect();
  try {
    // Get all closed signals (including those that were filtered then closed)
    // ordered by closedAt so we replay in sequence
    const { rows: signals } = await client.query(`
      SELECT id, symbol, "strategyId", "returnPct", "closedAt", direction,
             status
      FROM "FracmapSignal"
      WHERE "returnPct" IS NOT NULL
        AND "closedAt" IS NOT NULL
        AND status IN ('closed', 'filtered_closed')
      ORDER BY "closedAt" ASC
    `);

    console.log('Total closed signals for backtest: ' + signals.length);

    // Get strategy barMinutes for grouping
    const { rows: strats } = await client.query(
      'SELECT id, name, "barMinutes" FROM "FracmapStrategy" WHERE active = true'
    );
    const stratMap = {};
    for (const s of strats) stratMap[s.id] = s;

    // Group by strategy
    const byStrategy = {};
    for (const sig of signals) {
      if (!stratMap[sig.strategyId]) continue; // skip inactive strategies
      const key = sig.strategyId;
      if (!byStrategy[key]) byStrategy[key] = [];
      byStrategy[key].push(sig);
    }

    // For each strategy, replay per-coin
    for (const [stratId, stratSignals] of Object.entries(byStrategy)) {
      const strat = stratMap[stratId];
      const tf = strat.barMinutes >= 1440 ? '1d' : strat.barMinutes >= 60 ? '1h' : '1m';

      console.log('\n╔══════════════════════════════════════════════════════════════╗');
      console.log('║  ' + (strat.name || stratId).padEnd(50) + ' [' + tf + ']  ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');

      // Group by coin
      const byCoin = {};
      for (const sig of stratSignals) {
        if (!byCoin[sig.symbol]) byCoin[sig.symbol] = [];
        byCoin[sig.symbol].push(sig);
      }

      let totalGatedReturn = 0;
      let totalGatedCount = 0;
      let totalPassedReturn = 0;
      let totalPassedCount = 0;
      let totalGatedWins = 0;
      let totalPassedWins = 0;
      let coinsWhereGateHelped = 0;
      let coinsWhereGateHurt = 0;
      let coinsWithGating = 0;

      const coinResults = [];

      for (const [symbol, coinSignals] of Object.entries(byCoin)) {
        // Replay: maintain trailing window
        const history = []; // last N returns
        let gatedReturn = 0;
        let gatedCount = 0;
        let gatedWins = 0;
        let passedReturn = 0;
        let passedCount = 0;
        let passedWins = 0;

        for (const sig of coinSignals) {
          const ret = parseFloat(sig.returnPct);
          if (isNaN(ret)) continue;

          // Check if gate would block based on PRECEDING trades
          const trailingN = history.slice(-LOOKBACK);
          const trailingWins = trailingN.filter(r => r > 0).length;
          const trailingWR = trailingN.length > 0 ? (trailingWins / trailingN.length) * 100 : 50;
          const wouldBlock = trailingN.length >= MIN_TRADES && trailingWR < GATE_WR;

          if (wouldBlock) {
            gatedReturn += ret;
            gatedCount++;
            if (ret > 0) gatedWins++;
          } else {
            passedReturn += ret;
            passedCount++;
            if (ret > 0) passedWins++;
          }

          // Add to history AFTER the decision (this trade's result feeds future decisions)
          history.push(ret);
        }

        if (gatedCount > 0) {
          coinsWithGating++;
          const gatedAvg = gatedReturn / gatedCount;
          const passedAvg = passedCount > 0 ? passedReturn / passedCount : 0;
          const helped = gatedAvg < passedAvg;
          if (helped) coinsWhereGateHelped++;
          else coinsWhereGateHurt++;

          totalGatedReturn += gatedReturn;
          totalGatedCount += gatedCount;
          totalGatedWins += gatedWins;
          totalPassedReturn += passedReturn;
          totalPassedCount += passedCount;
          totalPassedWins += passedWins;

          coinResults.push({
            symbol,
            total: coinSignals.length,
            gatedCount,
            gatedReturn,
            gatedAvg,
            gatedWR: gatedCount > 0 ? (gatedWins / gatedCount * 100) : 0,
            passedCount,
            passedReturn,
            passedAvg,
            passedWR: passedCount > 0 ? (passedWins / passedCount * 100) : 0,
            helped,
          });
        }
      }

      // Sort by gated count descending
      coinResults.sort((a, b) => b.gatedCount - a.gatedCount);

      // Print per-coin results
      if (coinResults.length > 0) {
        console.log('\n  COIN            TOTAL  GATED  GATED_AVG  GATED_WR  PASSED_AVG  PASSED_WR  VERDICT');
        console.log('  ' + '-'.repeat(90));
        for (const c of coinResults) {
          console.log(
            '  ' + c.symbol.padEnd(16) +
            String(c.total).padEnd(7) +
            String(c.gatedCount).padEnd(7) +
            (c.gatedAvg >= 0 ? '+' : '') + c.gatedAvg.toFixed(3).padStart(8) + '%  ' +
            c.gatedWR.toFixed(0).padStart(5) + '%   ' +
            (c.passedAvg >= 0 ? '+' : '') + c.passedAvg.toFixed(3).padStart(8) + '%   ' +
            c.passedWR.toFixed(0).padStart(5) + '%   ' +
            (c.helped ? 'GATE HELPED' : 'GATE HURT')
          );
        }
      }

      // Print strategy summary
      const gAvg = totalGatedCount > 0 ? totalGatedReturn / totalGatedCount : 0;
      const pAvg = totalPassedCount > 0 ? totalPassedReturn / totalPassedCount : 0;
      const gWR = totalGatedCount > 0 ? (totalGatedWins / totalGatedCount * 100) : 0;
      const pWR = totalPassedCount > 0 ? (totalPassedWins / totalPassedCount * 100) : 0;

      console.log('\n  ── STRATEGY TOTALS ──');
      console.log('  Coins with gating events: ' + coinsWithGating);
      console.log('  Gate helped: ' + coinsWhereGateHelped + ' coins | Gate hurt: ' + coinsWhereGateHurt + ' coins');
      console.log('  GATED:  ' + totalGatedCount + ' trades | avg=' + gAvg.toFixed(4) + '% | WR=' + gWR.toFixed(1) + '% | total=' + totalGatedReturn.toFixed(2) + '%');
      console.log('  PASSED: ' + totalPassedCount + ' trades | avg=' + pAvg.toFixed(4) + '% | WR=' + pWR.toFixed(1) + '% | total=' + totalPassedReturn.toFixed(2) + '%');
      console.log('  DELTA:  avg_return=' + (pAvg - gAvg).toFixed(4) + '% better when passed | WR=' + (pWR - gWR).toFixed(1) + '% better when passed');
      console.log('  NET VERDICT: Gate is ' + (gAvg < pAvg ? 'HELPING' : 'HURTING') + ' (gated avg ' + (gAvg < pAvg ? 'worse' : 'better') + ' than passed avg)');
    }

  } finally {
    client.release();
    pool.end();
  }
})();
