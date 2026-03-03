/**
 * Back-propagate signals for the new 1H C48-53 strategy over the last 10 days.
 * Then pair them for hedged view.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PHI = 1.6180339887;
const STRAT_NAME = 'Universal 60m - C33-C41 Optimised';

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
  function isLocalMax(arr, i, w) { const val = arr[i]; if (val === null) return false; for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] > val) return false; } return true; }
  function isLocalMin(arr, i, w) { const val = arr[i]; if (val === null) return false; for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] < val) return false; } return true; }
  function isPriceLow(i, w) { const lo = bars[i].low; for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].low < lo) return false; } return true; }
  function isPriceHigh(i, w) { const hi = bars[i].high; for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].high > hi) return false; } return true; }
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
      const bandWidth = (up - lo) / ((up + lo) / 2); if (bandWidth < 0.0001) continue;
      const sw = Math.round(band.cycle / 3);
      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      const buyNear = !buyAtI && (i > 0 && band.lower[i-1] !== null && bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);
      if (buyAtI || buyNear) {
        const sH = isLocalMax(band.lower, i, sw); const sN = isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw);
        if (sH || sN) { buyStrength++; if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle; if (band.order > maxBuyOrder) maxBuyOrder = band.order; }
      }
      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = !sellAtI && (i > 0 && band.upper[i-1] !== null && bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);
      if (sellAtI || sellNear) {
        const sH = isLocalMin(band.upper, i, sw); const sN = isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw);
        if (sH || sN) { sellStrength++; if (band.cycle > maxSellCycle) maxSellCycle = band.cycle; if (band.order > maxSellOrder) maxSellOrder = band.order; }
      }
    }
    if (buyStrength >= 1 && buyStrength >= sellStrength) {
      if (!isPriceLow(i, Math.round(maxBuyCycle / 2))) {}
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / 5);
        position = { type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, time: bars[i + 1].time, strength: buyStrength };
      }
    } else if (sellStrength >= 1) {
      if (!isPriceHigh(i, Math.round(maxSellCycle / 2))) {}
      else if (i + 1 < n) {
        const hd = Math.round(maxSellCycle / 5);
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

(async () => {
  const client = await pool.connect();
  try {
    // Get strategy
    const { rows: [strat] } = await client.query('SELECT id FROM "FracmapStrategy" WHERE name = $1 AND active = true', [STRAT_NAME]);
    if (!strat) { console.log('Strategy not found'); return; }
    console.log('Strategy:', STRAT_NAME, strat.id.slice(0, 8) + '...');

    // Get coins with 1H data
    const { rows: coins } = await client.query(
      `SELECT DISTINCT symbol FROM "Candle1h" WHERE timestamp > NOW() - INTERVAL '30 days' GROUP BY symbol HAVING COUNT(*) >= 500`
    );
    console.log('Coins:', coins.length);

    let totalSignals = 0, totalClosed = 0, totalOpen = 0;

    for (const { symbol } of coins) {
      const { rows } = await client.query(
        `SELECT timestamp as time, open, high, low, close FROM "Candle1h" WHERE symbol = $1 ORDER BY timestamp ASC`, [symbol]
      );
      if (rows.length < 500) continue;
      const bars = rows.map(r => ({ time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close }));

      // Compute bands for C48-53
      const highs = bars.map(b => b.high), lows = bars.map(b => b.low);
      const bands = [];
      for (let cycle = 33; cycle <= 41; cycle++) {
        for (const order of [1, 2, 3, 4, 5, 6]) bands.push(computeFracmap(highs, lows, cycle, order));
      }

      const signals = detectEnsembleSignals(bars, bands, 1, 0, true, 5, true, true);

      // Filter to last 10 days
      const cutoffIdx = bars.length - 240; // 10 days × 24 hours
      const recent = signals.filter(s => s.entryIdx >= cutoffIdx);

      for (const sig of recent) {
        const barTime = bars[sig.entryIdx].time;
        const exitTime = new Date(new Date(barTime).getTime() + sig.holdDuration * 3600000);
        const isExpired = exitTime <= new Date();

        // Check duplicate
        const { rows: dup } = await client.query(
          `SELECT id FROM "FracmapSignal" WHERE "strategyId" = $1 AND symbol = $2 AND direction = $3 AND "createdAt"::date = $4::date LIMIT 1`,
          [strat.id, symbol, sig.type, barTime]
        );
        if (dup.length > 0) continue;

        if (isExpired) {
          const exitIdx = Math.min(sig.entryIdx + sig.holdDuration, bars.length - 1);
          const exitPrice = bars[exitIdx].open;
          const ret = sig.type === 'LONG' ? (exitPrice / sig.entryPrice - 1) * 100 : (sig.entryPrice / exitPrice - 1) * 100;
          await client.query(
            `INSERT INTO "FracmapSignal" ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", status, "exitPrice", "returnPct", "closedAt", "createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed',$9,$10,$11,$12)`,
            [strat.id, symbol, sig.type, sig.entryPrice, sig.strength, sig.holdDuration, sig.maxCycle, sig.maxOrder, exitPrice, +(ret.toFixed(4)), exitTime, barTime]
          );
          totalClosed++;
        } else {
          await client.query(
            `INSERT INTO "FracmapSignal" ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", status, "createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,
            [strat.id, symbol, sig.type, sig.entryPrice, sig.strength, sig.holdDuration, sig.maxCycle, sig.maxOrder, barTime]
          );
          totalOpen++;
        }
        totalSignals++;
      }
    }

    console.log('\nSignals: ' + totalSignals + ' (closed=' + totalClosed + ', open=' + totalOpen + ')');

    // Summary
    const { rows: [s] } = await client.query(
      `SELECT COUNT(*)::int as total, AVG("returnPct") FILTER (WHERE status='closed') as avg_ret, SUM("returnPct") FILTER (WHERE status='closed') as total_ret, COUNT(*) FILTER (WHERE status='closed' AND "returnPct">0)::int as wins, COUNT(*) FILTER (WHERE status='closed')::int as closed FROM "FracmapSignal" WHERE "strategyId"=$1`, [strat.id]
    );
    console.log('Total:', s.total, '| Closed:', s.closed);
    if (s.closed > 0) {
      console.log('Avg return: ' + (+s.avg_ret >= 0 ? '+' : '') + (+s.avg_ret).toFixed(3) + '%');
      console.log('Total return: ' + (+s.total_ret >= 0 ? '+' : '') + (+s.total_ret).toFixed(2) + '%');
      console.log('Win rate: ' + (s.wins / s.closed * 100).toFixed(1) + '%');
    }

    // Now pair them
    console.log('\nPairing signals...');
    const { rows: sigs } = await client.query(
      `SELECT id, symbol, direction, "entryPrice", "holdBars", strength, status, "returnPct", "createdAt" FROM "FracmapSignal" WHERE "strategyId" = $1 AND pair_id IS NULL AND status IN ('open','closed') ORDER BY "createdAt" ASC`, [strat.id]
    );

    const used = new Set();
    let paired = 0;
    for (let i = 0; i < sigs.length; i++) {
      if (used.has(sigs[i].id)) continue;
      const A = sigs[i];
      let bestIdx = -1, bestScore = -Infinity;
      for (let j = 0; j < i; j++) {
        if (used.has(sigs[j].id)) continue;
        const B = sigs[j];
        if (B.direction === A.direction || B.symbol === A.symbol) continue;
        const gapMs = new Date(A.createdAt).getTime() - new Date(B.createdAt).getTime();
        if (gapMs < 0 || gapMs > 3600000) continue; // 1 hour gap
        const score = (gapMs < 60000 ? 100000 : 0) + B.strength * 10 - gapMs / 36000;
        if (score > bestScore) { bestScore = score; bestIdx = j; }
      }
      if (bestIdx >= 0) {
        const B = sigs[bestIdx];
        const pairId = crypto.randomUUID();
        let pairReturn = null;
        if (A.status === 'closed' && B.status === 'closed' && A.returnPct != null && B.returnPct != null)
          pairReturn = +(parseFloat(A.returnPct) + parseFloat(B.returnPct)).toFixed(4);
        await client.query('UPDATE "FracmapSignal" SET pair_id=$1, pair_symbol=$2, pair_direction=$3, pair_return=$4 WHERE id=$5', [pairId, B.symbol, B.direction, pairReturn, A.id]);
        await client.query('UPDATE "FracmapSignal" SET pair_id=$1, pair_symbol=$2, pair_direction=$3, pair_return=$4 WHERE id=$5', [pairId, A.symbol, A.direction, pairReturn, B.id]);
        used.add(A.id); used.add(B.id); paired++;
      }
    }
    console.log('Pairs created:', paired);

  } finally { client.release(); pool.end(); }
})();
