/**
 * Switch 1D strategy from C2-12 to C2-3 optimised.
 * Deactivates old strategies (doesn't delete), creates new one,
 * then back-propagates signals for the last 10 days.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PHI = 1.6180339887;

// ── Signal engine (copied from hedged-backtest.cjs) ──

function computeFracmap(highs, lows, cycle, order) {
  const zfracR = Math.round(cycle / 3.0);
  const phiO = Math.pow(PHI, order);
  const n = highs.length;
  const forwardBars = Math.round(cycle / 3);
  const totalLen = n + forwardBars;
  const lower = new Array(totalLen).fill(null);
  const upper = new Array(totalLen).fill(null);
  const minIdx = (order + 1) * zfracR;
  for (let i = minIdx; i < totalLen; i++) {
    const start = i - (order + 1) * zfracR;
    const end = i - order * zfracR;
    if (start < 0 || start >= n) continue;
    const clampEnd = Math.min(end, n - 1);
    if (clampEnd < start) continue;
    let wMax = -Infinity, wMin = Infinity;
    for (let j = start; j <= clampEnd; j++) { wMax = Math.max(wMax, highs[j], lows[j]); wMin = Math.min(wMin, highs[j], lows[j]); }
    lower[i] = (1 - phiO) * wMax + phiO * wMin;
    upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper, forwardBars, cycle, order };
}

function detectEnsembleSignals(bars, allBands, minStrength, minMaxCycle, spikeFilter, holdDivisor, nearMiss, priceExtreme) {
  const signals = [];
  let position = null;
  const n = bars.length;
  function isPriceLow(i, w) {
    const lo = bars[i].low;
    for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].low < lo) return false; }
    return true;
  }
  function isPriceHigh(i, w) {
    const hi = bars[i].high;
    for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].high > hi) return false; }
    return true;
  }
  for (let i = 1; i < n; i++) {
    if (position && i >= position.exitIdx) {
      const exitPrice = bars[i].open;
      const ret = position.type === 'LONG' ? (exitPrice / position.entryPrice - 1) * 100 : (position.entryPrice / exitPrice - 1) * 100;
      signals.push({ ...position, exitPrice, exitActualIdx: i, returnPct: +ret.toFixed(3), won: ret > 0 });
      position = null;
    }
    if (position) continue;
    let buyStrength = 0, sellStrength = 0, maxBuyCycle = 0, maxSellCycle = 0, maxBuyOrder = 0, maxSellOrder = 0;
    for (const band of allBands) {
      const lo = band.lower[i], up = band.upper[i];
      if (lo === null || up === null || up <= lo) continue;
      const bandWidth = (up - lo) / ((up + lo) / 2);
      if (bandWidth < 0.0001) continue;
      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      if (buyAtI) {
        buyStrength++; if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle; if (band.order > maxBuyOrder) maxBuyOrder = band.order;
      }
      const sellAtI = bars[i].high > up && bars[i].close < up;
      if (sellAtI) {
        sellStrength++; if (band.cycle > maxSellCycle) maxSellCycle = band.cycle; if (band.order > maxSellOrder) maxSellOrder = band.order;
      }
    }
    if (buyStrength >= minStrength && maxBuyCycle >= minMaxCycle && buyStrength >= sellStrength) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / holdDivisor);
        position = { type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, time: bars[i + 1].time, strength: buyStrength };
      }
    } else if (sellStrength >= minStrength && maxSellCycle >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxSellCycle / holdDivisor);
        position = { type: 'SHORT', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxSellCycle, maxOrder: maxSellOrder, time: bars[i + 1].time, strength: sellStrength };
      }
    }
  }
  if (position) {
    const exitPrice = bars[n - 1].close;
    const ret = position.type === 'LONG' ? (exitPrice / position.entryPrice - 1) * 100 : (position.entryPrice / exitPrice - 1) * 100;
    signals.push({ ...position, exitPrice, exitActualIdx: n - 1, returnPct: +ret.toFixed(3), won: ret > 0 });
  }
  return signals;
}

// ── Main ──

(async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Step 1: Deactivate current 1D strategies
    console.log('=== Step 1: Deactivate current 1D strategies ===');
    const { rows: oldStrats } = await client.query(
      `UPDATE "FracmapStrategy" SET active = false
       WHERE active = true AND "barMinutes" = 1440
       RETURNING id, name`
    );
    for (const s of oldStrats) {
      console.log('  Deactivated: ' + s.name + ' (' + s.id.slice(0, 8) + '...)');
    }

    // Step 2: Create new C2-3 optimised strategy
    console.log('\n=== Step 2: Create C2-3 Optimised 1D strategy ===');
    const { rows: [newStrat] } = await client.query(
      `INSERT INTO "FracmapStrategy" (name, type, "barMinutes", "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax", active, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, now(), now())
       RETURNING id, name`,
      ['Universal 1D - C2-C3 Optimised', 'universal', 1440, 1, 0, false, false, 2, true, 2, 3]
    );
    console.log('  Created: ' + newStrat.name + ' (' + newStrat.id.slice(0, 8) + '...)');

    // Step 3: Back-propagate signals for the last 10 days
    console.log('\n=== Step 3: Back-propagate last 10 days ===');

    // Load candles (need lookback for band computation)
    const lookbackDays = 50; // Extra lookback for band warmup
    const { rows: allCoins } = await client.query(
      `SELECT DISTINCT symbol FROM "Candle1d"
       WHERE timestamp > NOW() - INTERVAL '${lookbackDays + 10} days'
       GROUP BY symbol HAVING COUNT(*) >= ${lookbackDays}`
    );
    console.log('  Coins with enough data: ' + allCoins.length);

    let totalSignals = 0;
    let totalOpen = 0;
    let totalClosed = 0;

    for (const { symbol } of allCoins) {
      const { rows: bars } = await client.query(
        `SELECT timestamp as time, open, high, low, close, volume
         FROM "Candle1d" WHERE symbol = $1
         ORDER BY timestamp ASC`,
        [symbol]
      );

      if (bars.length < lookbackDays) continue;

      const parsed = bars.map(b => ({
        time: b.time, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +(b.volume || 0)
      }));

      // Compute bands for C2-3
      const highs = parsed.map(b => b.high);
      const lows = parsed.map(b => b.low);
      const bands = [];
      for (let cycle = 2; cycle <= 3; cycle++) {
        for (const order of [1, 2, 3, 4, 5, 6]) {
          bands.push(computeFracmap(highs, lows, cycle, order));
        }
      }

      // Detect signals on full history
      const signals = detectEnsembleSignals(parsed, bands, 1, 0, false, 2, false, true);

      // Filter to signals within the last 10 days
      const cutoffIdx = parsed.length - 10;
      const recentSignals = signals.filter(s => s.entryIdx >= cutoffIdx);

      for (const sig of recentSignals) {
        const barTime = parsed[sig.entryIdx].time;
        const now = new Date();
        const exitTime = new Date(new Date(barTime).getTime() + sig.holdDuration * 86400000);
        const isExpired = exitTime <= now;

        // Check for duplicate
        const { rows: existing } = await client.query(
          `SELECT id FROM "FracmapSignal"
           WHERE "strategyId" = $1 AND symbol = $2 AND direction = $3
           AND "createdAt"::date = $4::date LIMIT 1`,
          [newStrat.id, symbol, sig.type, barTime]
        );
        if (existing.length > 0) continue;

        if (isExpired) {
          // Already expired — write as closed with actual return
          const exitIdx = Math.min(sig.entryIdx + sig.holdDuration, parsed.length - 1);
          const exitPrice = parsed[exitIdx].open;
          const ret = sig.type === 'LONG'
            ? (exitPrice / sig.entryPrice - 1) * 100
            : (sig.entryPrice / exitPrice - 1) * 100;

          await client.query(
            `INSERT INTO "FracmapSignal"
             ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder",
              status, "exitPrice", "returnPct", "closedAt", "createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed',$9,$10,$11,$12)`,
            [newStrat.id, symbol, sig.type, sig.entryPrice, sig.strength, sig.holdDuration,
             sig.maxCycle, sig.maxOrder, sig.exitPrice, +(ret.toFixed(4)), exitTime, barTime]
          );
          totalClosed++;
        } else {
          // Still open
          await client.query(
            `INSERT INTO "FracmapSignal"
             ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder",
              status, "createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,
            [newStrat.id, symbol, sig.type, sig.entryPrice, sig.strength, sig.holdDuration,
             sig.maxCycle, sig.maxOrder, barTime]
          );
          totalOpen++;
        }
        totalSignals++;
      }
    }

    console.log('  Signals generated: ' + totalSignals + ' (closed=' + totalClosed + ', open=' + totalOpen + ')');

    // Summary
    const { rows: [summary] } = await client.query(
      `SELECT COUNT(*)::int as total,
              COUNT(*) FILTER (WHERE status = 'open')::int as open,
              COUNT(*) FILTER (WHERE status = 'closed')::int as closed,
              AVG("returnPct") FILTER (WHERE status = 'closed') as avg_ret,
              SUM("returnPct") FILTER (WHERE status = 'closed') as total_ret,
              COUNT(*) FILTER (WHERE status = 'closed' AND "returnPct" > 0)::int as wins
       FROM "FracmapSignal" WHERE "strategyId" = $1`,
      [newStrat.id]
    );

    console.log('\n=== BACK-PROPAGATION SUMMARY ===');
    console.log('  Strategy: ' + newStrat.name);
    console.log('  Total signals: ' + summary.total);
    console.log('  Open: ' + summary.open);
    console.log('  Closed: ' + summary.closed);
    if (summary.closed > 0) {
      const wr = (summary.wins / summary.closed * 100).toFixed(1);
      console.log('  Avg return: ' + (summary.avg_ret >= 0 ? '+' : '') + (+summary.avg_ret).toFixed(3) + '%');
      console.log('  Total return: ' + (summary.total_ret >= 0 ? '+' : '') + (+summary.total_ret).toFixed(2) + '%');
      console.log('  Win rate: ' + wr + '% (' + summary.wins + '/' + summary.closed + ')');
    }

    await client.query('COMMIT');
    console.log('\n✓ Transaction committed. Live engine will pick up new strategy on next 1D tick.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK:', err.message);
  } finally {
    client.release();
    pool.end();
  }
})();
