/**
 * Back-propagate signals for the new optimised strategies:
 * 1m C30-40 (5 days), 1h C10-60 (10 days), 1d C2-4 (already has signals)
 * With hedged pairing.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PHI = 1.6180339887;
const ORDERS = [1, 2, 3, 4, 5, 6];

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

function detectEnsembleSignals(bars, allBands, spike, nearMiss, holdDiv, priceExt) {
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
      const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null && bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);
      if (buyAtI || buyNear) {
        if (spike) { const sH = isLocalMax(band.lower, i, sw); const sN = nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw)); if (!sH && !sN) continue; }
        buyStrength++; if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle; if (band.order > maxBuyOrder) maxBuyOrder = band.order;
      }
      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null && bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);
      if (sellAtI || sellNear) {
        if (spike) { const sH = isLocalMin(band.upper, i, sw); const sN = nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw)); if (!sH && !sN) continue; }
        sellStrength++; if (band.cycle > maxSellCycle) maxSellCycle = band.cycle; if (band.order > maxSellOrder) maxSellOrder = band.order;
      }
    }
    if (buyStrength >= 1 && buyStrength >= sellStrength) {
      if (priceExt && !isPriceLow(i, Math.round(maxBuyCycle / 2))) {}
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / holdDiv);
        position = { type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, time: bars[i + 1].time, strength: buyStrength };
      }
    } else if (sellStrength >= 1) {
      if (priceExt && !isPriceHigh(i, Math.round(maxSellCycle / 2))) {}
      else if (i + 1 < n) {
        const hd = Math.round(maxSellCycle / holdDiv);
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

async function pairSignals(client, stratId, maxGapMs) {
  const { rows: sigs } = await client.query(
    `SELECT id, symbol, direction, strength, status, "returnPct", "createdAt" FROM "FracmapSignal" WHERE "strategyId" = $1 AND pair_id IS NULL AND status IN ('open','closed') ORDER BY "createdAt" ASC`, [stratId]
  );
  const used = new Set();
  let paired = 0;
  for (let i = 0; i < sigs.length; i++) {
    if (used.has(sigs[i].id)) continue;
    const A = sigs[i];
    let bestIdx = -1, bestScore = -Infinity;
    for (let j = Math.max(0, i - 500); j < i; j++) {
      if (used.has(sigs[j].id)) continue;
      const B = sigs[j];
      if (B.direction === A.direction || B.symbol === A.symbol) continue;
      const gapMs = new Date(A.createdAt).getTime() - new Date(B.createdAt).getTime();
      if (gapMs < 0 || gapMs > maxGapMs) continue;
      const score = (gapMs < 60000 ? 100000 : 0) + B.strength * 10 - gapMs / 6000;
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
  return paired;
}

const CONFIGS = [
  { table: 'Candle1m', barMinutes: 1, name: 'Universal 1m - C30-C40', cycleMin: 30, cycleMax: 40, spike: true, nearMiss: true, holdDiv: 4, priceExt: true, daysBack: 5, minBars: 5000, maxGapMs: 5 * 60000 },
  { table: 'Candle1h', barMinutes: 60, name: 'Universal 60m - C10-C60', cycleMin: 10, cycleMax: 60, spike: true, nearMiss: true, holdDiv: 5, priceExt: true, daysBack: 10, minBars: 200, maxGapMs: 3600000 },
];

(async () => {
  const client = await pool.connect();
  try {
    for (const cfg of CONFIGS) {
      console.log('\n═══ ' + cfg.name + ' ═══');
      const { rows: [strat] } = await client.query('SELECT id FROM "FracmapStrategy" WHERE name = $1 AND active = true', [cfg.name]);
      if (!strat) { console.log('  Strategy not found!'); continue; }

      const { rows: coins } = await client.query(
        `SELECT DISTINCT symbol FROM "${cfg.table}" WHERE timestamp > NOW() - INTERVAL '${cfg.daysBack + 1} days' GROUP BY symbol HAVING COUNT(*) >= ${cfg.minBars}`
      );
      console.log('  Coins: ' + coins.length);

      let total = 0, closed = 0, open = 0;
      for (const { symbol } of coins) {
        const { rows } = await client.query(
          `SELECT timestamp as time, open, high, low, close FROM "${cfg.table}" WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '${cfg.daysBack + 5} days' ORDER BY timestamp ASC`, [symbol]
        );
        if (rows.length < cfg.minBars) continue;
        const bars = rows.map(r => ({ time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close }));

        const highs = bars.map(b => b.high), lows = bars.map(b => b.low);
        const bands = [];
        for (let cycle = cfg.cycleMin; cycle <= cfg.cycleMax; cycle++) {
          for (const order of ORDERS) bands.push(computeFracmap(highs, lows, cycle, order));
        }

        const signals = detectEnsembleSignals(bars, bands, cfg.spike, cfg.nearMiss, cfg.holdDiv, cfg.priceExt);
        const cutoffIdx = bars.length - (cfg.daysBack * Math.round(1440 / cfg.barMinutes));
        const recent = signals.filter(s => s.entryIdx >= Math.max(0, cutoffIdx));

        for (const sig of recent) {
          const barTime = bars[sig.entryIdx].time;
          const exitTime = new Date(new Date(barTime).getTime() + sig.holdDuration * cfg.barMinutes * 60000);
          const isExpired = exitTime <= new Date();

          const { rows: dup } = await client.query(
            `SELECT id FROM "FracmapSignal" WHERE "strategyId" = $1 AND symbol = $2 AND "createdAt" = $3 LIMIT 1`,
            [strat.id, symbol, barTime]
          );
          if (dup.length > 0) continue;

          if (isExpired) {
            const exitIdx = Math.min(sig.entryIdx + sig.holdDuration, bars.length - 1);
            const exitPrice = bars[exitIdx].open;
            const ret = sig.type === 'LONG' ? (exitPrice / sig.entryPrice - 1) * 100 : (sig.entryPrice / exitPrice - 1) * 100;
            if (Math.abs(ret) > 50) continue;
            await client.query(
              `INSERT INTO "FracmapSignal" ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", status, "exitPrice", "returnPct", "closedAt", "createdAt")
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed',$9,$10,$11,$12)`,
              [strat.id, symbol, sig.type, sig.entryPrice, sig.strength, sig.holdDuration, sig.maxCycle, sig.maxOrder, sig.exitPrice, +(ret.toFixed(4)), exitTime, barTime]
            );
            closed++;
          } else {
            await client.query(
              `INSERT INTO "FracmapSignal" ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", status, "createdAt")
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,
              [strat.id, symbol, sig.type, sig.entryPrice, sig.strength, sig.holdDuration, sig.maxCycle, sig.maxOrder, barTime]
            );
            open++;
          }
          total++;
          if (total % 1000 === 0) process.stdout.write('\r  ' + symbol + ' total=' + total);
        }
      }

      console.log('\n  Signals: ' + total + ' (closed=' + closed + ', open=' + open + ')');

      // Summary
      const { rows: [s] } = await client.query(
        `SELECT COUNT(*)::int as total, AVG("returnPct") FILTER (WHERE status='closed') as avg_ret, SUM("returnPct") FILTER (WHERE status='closed') as total_ret, COUNT(*) FILTER (WHERE status='closed' AND "returnPct">0)::int as wins, COUNT(*) FILTER (WHERE status='closed')::int as closed FROM "FracmapSignal" WHERE "strategyId"=$1`, [strat.id]
      );
      if (s.closed > 0) {
        console.log('  Avg: ' + (+s.avg_ret >= 0 ? '+' : '') + (+s.avg_ret).toFixed(3) + '% | Total: ' + (+s.total_ret >= 0 ? '+' : '') + (+s.total_ret).toFixed(1) + '% | WR: ' + (s.wins / s.closed * 100).toFixed(1) + '%');
      }

      // Pair
      console.log('  Pairing...');
      const pairs = await pairSignals(client, strat.id, cfg.maxGapMs);
      console.log('  Pairs: ' + pairs);
    }

    console.log('\n✓ Done.');
  } finally { client.release(); pool.end(); }
})();
