/**
 * HEDGED SINGLE CYCLE SWEEP — 1-MINUTE BARS
 *
 * Loads per-coin to avoid OOM. Tests cycles 2-100.
 * Uses same table as hedged-single-cycle.cjs (hedged_single_cycle).
 *
 * Usage: node backend/hedged-single-cycle-1m.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.6180339887;
const SPLIT_PCT = 50;
const MAX_GAP_VALUES = [0, 1, 2, 3, 4, 5];
const ORDERS = [1, 2, 3, 4, 5, 6];
const BAR_MINUTES = 1;
const MIN_BARS = 5000;
const CYCLE_START = 2;
const CYCLE_END = 100;
const DAYS_LOOKBACK = 45; // 1m data: ~45 days

// Strategy params for 1m (from live-signals.cjs defaults)
const PARAMS = { minStr: 1, minCyc: 0, spike: true, nearMiss: true, holdDiv: 4, priceExt: true };

// ── Signal engine (same as hedged-single-cycle.cjs) ──

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
      const bandWidth = (up - lo) / ((up + lo) / 2);
      if (bandWidth < 0.0001) continue;
      const sw = Math.round(band.cycle / 3);
      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null && bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);
      if (buyAtI || buyNear) {
        if (spikeFilter) { const sH = isLocalMax(band.lower, i, sw); const sN = nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw)); if (!sH && !sN) continue; }
        buyStrength++; if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle; if (band.order > maxBuyOrder) maxBuyOrder = band.order;
      }
      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null && bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);
      if (sellAtI || sellNear) {
        if (spikeFilter) { const sH = isLocalMin(band.upper, i, sw); const sN = nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw)); if (!sH && !sN) continue; }
        sellStrength++; if (band.cycle > maxSellCycle) maxSellCycle = band.cycle; if (band.order > maxSellOrder) maxSellOrder = band.order;
      }
    }
    if (buyStrength >= minStrength && maxBuyCycle >= minMaxCycle && buyStrength >= sellStrength) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) {}
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / holdDivisor);
        position = { type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, time: bars[i + 1].time, strength: buyStrength };
      }
    } else if (sellStrength >= minStrength && maxSellCycle >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) {}
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

function buildPairs(allSignals, maxGapBars, coinBars, exclusive) {
  const pairs = [];
  const used = exclusive ? new Set() : null;
  const barIndex = new Map();
  for (let i = 0; i < allSignals.length; i++) { const bar = allSignals[i].entryIdx; if (!barIndex.has(bar)) barIndex.set(bar, []); barIndex.get(bar).push(i); }
  for (let ai = 0; ai < allSignals.length; ai++) {
    if (exclusive && used.has(ai)) continue;
    const A = allSignals[ai];
    let bestBi = -1, bestScore = -Infinity;
    for (let bar = A.entryIdx - maxGapBars; bar <= A.entryIdx; bar++) {
      const cands = barIndex.get(bar); if (!cands) continue;
      for (const bi of cands) {
        if (bi === ai || (exclusive && used.has(bi))) continue;
        const B = allSignals[bi]; if (B.type === A.type || B.coin === A.coin) continue;
        const gap = A.entryIdx - B.entryIdx;
        const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
        const bRem = bExit - A.entryIdx;
        if (bRem < Math.max(1, A.holdDuration - maxGapBars)) continue;
        const dur = Math.min(A.holdDuration, bRem);
        const score = (gap === 0 ? 100000 : 0) + dur * 100 - gap * 10 + B.strength;
        if (score > bestScore) { bestScore = score; bestBi = bi; }
      }
    }
    if (bestBi >= 0) {
      const B = allSignals[bestBi];
      const gap = A.entryIdx - B.entryIdx;
      const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
      const dur = Math.min(A.holdDuration, bExit - A.entryIdx);
      const exitBar = A.entryIdx + dur;
      const barsA = coinBars[A.coin], barsB = coinBars[B.coin];
      let lA, lB;
      if (barsA && A.entryIdx < barsA.length && exitBar < barsA.length) { const e = barsA[A.entryIdx].open, x = barsA[exitBar].open; lA = A.type === 'LONG' ? (x/e-1)*100 : (e/x-1)*100; } else { lA = A.returnPct * (dur / Math.max(A.holdDuration, 1)); }
      if (barsB && A.entryIdx < barsB.length && exitBar < barsB.length) { const e = barsB[A.entryIdx].open, x = barsB[exitBar].open; lB = B.type === 'LONG' ? (x/e-1)*100 : (e/x-1)*100; } else { lB = B.returnPct * (dur / Math.max(B.holdDuration, 1)); }
      const pr = lA + lB;
      if (Math.abs(pr) > 50) continue;
      pairs.push({ tier: gap === 0 ? 1 : 2, pairReturn: +pr.toFixed(3), pairDuration: dur, gapBars: gap });
      if (exclusive) { used.add(ai); used.add(bestBi); }
    }
  }
  return pairs;
}

function normalCDF(x) { const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911; const s=x<0?-1:1; x=Math.abs(x)/Math.sqrt(2); const t=1/(1+p*x); return 0.5*(1+s*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x))); }

function calcMetrics(pairs) {
  if (pairs.length === 0) return { sharpe: 0, winRate: 0, pf: 0, totalRet: 0, avgHold: 0, avgRetBps: 0, tStat: 0, pValue: 1, t1: 0, t2: 0 };
  const rets = pairs.map(p => p.pairReturn), n = rets.length;
  const mean = rets.reduce((s,r) => s+r, 0)/n;
  const std = Math.sqrt(rets.reduce((s,r) => s+(r-mean)**2, 0)/n);
  const avgHold = pairs.reduce((s,p) => s+p.pairDuration, 0)/n;
  const sharpe = std > 0 ? (mean/std)*Math.sqrt(525600/Math.max(1, avgHold*BAR_MINUTES)) : 0;
  const wr = rets.filter(r => r>0).length/n*100;
  const gw = rets.filter(r=>r>0).reduce((s,r)=>s+r,0);
  const gl = Math.abs(rets.filter(r=>r<0).reduce((s,r)=>s+r,0));
  const pf = gl>0?gw/gl:gw>0?999:0;
  const sStd = n>1?Math.sqrt(rets.reduce((s,r)=>s+(r-mean)**2,0)/(n-1)):0;
  const tStat = sStd>0?(mean/(sStd/Math.sqrt(n))):0;
  const pValue = Math.max(0,Math.min(1,2*(1-normalCDF(Math.abs(tStat)))));
  return { sharpe:+sharpe.toFixed(3), winRate:+wr.toFixed(1), pf:+pf.toFixed(2), totalRet:rets.reduce((s,r)=>s+r,0), avgHold:+avgHold.toFixed(1), avgRetBps:Math.round(mean*100), tStat:+tStat.toFixed(2), pValue:+pValue.toFixed(4), t1:pairs.filter(p=>p.tier===1).length, t2:pairs.filter(p=>p.tier===2).length };
}

// ── Main ──

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  HEDGED SINGLE CYCLE SWEEP — 1-Minute bars (cycles 2-100)            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Ensure table
  await client.query(`
    CREATE TABLE IF NOT EXISTS hedged_single_cycle (
      id SERIAL PRIMARY KEY, computed_at TIMESTAMPTZ DEFAULT now(),
      bar_minutes INT NOT NULL, cycle INT NOT NULL,
      pair_mode TEXT NOT NULL, max_gap INT NOT NULL,
      coins_used INT, total_signals INT,
      oos_sharpe FLOAT, oos_win_rate FLOAT, oos_pf FLOAT,
      oos_total_ret FLOAT, oos_trade_count INT, oos_avg_hold FLOAT,
      oos_avg_ret_bps INT, oos_t_stat FLOAT, oos_p_value FLOAT,
      oos_t1 INT, oos_t2 INT, is_sharpe FLOAT, is_trade_count INT,
      UNIQUE(bar_minutes, cycle, pair_mode, max_gap)
    )
  `);

  // Get all coins with 1m data
  console.log('  Finding coins with 1m data...');
  const { rows: coinList } = await client.query(
    `SELECT symbol, COUNT(*)::int as cnt FROM "Candle1m"
     WHERE timestamp > NOW() - INTERVAL '${DAYS_LOOKBACK} days'
     GROUP BY symbol HAVING COUNT(*) >= $1 ORDER BY cnt DESC`,
    [MIN_BARS]
  );
  console.log('  ' + coinList.length + ' coins with >=' + MIN_BARS + ' 1m bars\n');

  const totalCycles = CYCLE_END - CYCLE_START + 1;
  const totalCells = totalCycles * MAX_GAP_VALUES.length * 2;
  let cellsDone = 0;
  const results = [];

  for (let cycle = CYCLE_START; cycle <= CYCLE_END; cycle++) {
    // Load bars per-coin and generate signals for this cycle
    const oosSignals = {};
    const oosBarsMap = {};
    const isSignals = {};
    const isBarsMap = {};
    let totalOos = 0;

    for (const { symbol } of coinList) {
      const { rows } = await client.query(
        `SELECT timestamp as time, open, high, low, close FROM "Candle1m"
         WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '${DAYS_LOOKBACK} days'
         ORDER BY timestamp ASC`,
        [symbol]
      );
      if (rows.length < MIN_BARS) continue;

      const bars = rows.map(r => ({ time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close }));
      const splitIdx = Math.floor(bars.length * SPLIT_PCT / 100);
      const isHalf = bars.slice(0, splitIdx);
      const oosHalf = bars.slice(splitIdx);
      if (isHalf.length < 2000 || oosHalf.length < 2000) continue;

      const genBands = (barsArr) => {
        const highs = barsArr.map(b => b.high), lows = barsArr.map(b => b.low);
        return ORDERS.map(order => computeFracmap(highs, lows, cycle, order));
      };

      const oosSigs = detectEnsembleSignals(oosHalf, genBands(oosHalf), PARAMS.minStr, PARAMS.minCyc, PARAMS.spike, PARAMS.holdDiv, PARAMS.nearMiss, PARAMS.priceExt);
      const isSigs = detectEnsembleSignals(isHalf, genBands(isHalf), PARAMS.minStr, PARAMS.minCyc, PARAMS.spike, PARAMS.holdDiv, PARAMS.nearMiss, PARAMS.priceExt);

      if (oosSigs.length > 0) { oosSignals[symbol] = oosSigs; oosBarsMap[symbol] = oosHalf; totalOos += oosSigs.length; }
      if (isSigs.length > 0) { isSignals[symbol] = isSigs; isBarsMap[symbol] = isHalf; }
    }

    if (totalOos < 2) { cellsDone += MAX_GAP_VALUES.length * 2; continue; }

    const flatten = (sigMap) => {
      const flat = [];
      for (const [sym, sigs] of Object.entries(sigMap)) { for (const s of sigs) flat.push({ ...s, coin: sym }); }
      flat.sort((a, b) => a.entryIdx - b.entryIdx);
      return flat;
    };

    const flatOos = flatten(oosSignals);
    const flatIs = flatten(isSignals);
    const coinsUsed = Object.keys(oosSignals).length;

    for (const maxGap of MAX_GAP_VALUES) {
      for (const mode of ['exclusive', 'reuse']) {
        const oosPairs = buildPairs(flatOos, maxGap, oosBarsMap, mode === 'exclusive');
        const isPairs = buildPairs(flatIs, maxGap, isBarsMap, mode === 'exclusive');
        const oosM = calcMetrics(oosPairs);
        const isM = calcMetrics(isPairs);

        await client.query(`
          INSERT INTO hedged_single_cycle (bar_minutes, cycle, pair_mode, max_gap, coins_used, total_signals,
            oos_sharpe, oos_win_rate, oos_pf, oos_total_ret, oos_trade_count, oos_avg_hold,
            oos_avg_ret_bps, oos_t_stat, oos_p_value, oos_t1, oos_t2, is_sharpe, is_trade_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT (bar_minutes, cycle, pair_mode, max_gap)
          DO UPDATE SET computed_at=now(), coins_used=$5, total_signals=$6,
            oos_sharpe=$7, oos_win_rate=$8, oos_pf=$9, oos_total_ret=$10, oos_trade_count=$11, oos_avg_hold=$12,
            oos_avg_ret_bps=$13, oos_t_stat=$14, oos_p_value=$15, oos_t1=$16, oos_t2=$17, is_sharpe=$18, is_trade_count=$19
        `, [BAR_MINUTES, cycle, mode, maxGap, coinsUsed, totalOos,
            oosM.sharpe, oosM.winRate, oosM.pf, oosM.totalRet, oosPairs.length, oosM.avgHold,
            oosM.avgRetBps, oosM.tStat, oosM.pValue, oosM.t1, oosM.t2, isM.sharpe, isPairs.length]);

        if (oosPairs.length >= 5) {
          results.push({ cycle, mode, maxGap, sr: oosM.sharpe, isSr: isM.sharpe, wr: oosM.winRate, pairs: oosPairs.length, bps: oosM.avgRetBps, tStat: oosM.tStat, pVal: oosM.pValue });
        }
        cellsDone++;
      }
    }
    process.stdout.write('\r  Progress: ' + ((cellsDone / totalCells * 100) | 0) + '% cycle=' + cycle + ' sigs=' + totalOos + ' coins=' + coinsUsed);
  }

  console.log('\n');

  // Summary
  results.sort((a, b) => b.sr - a.sr);
  const gap0excl = results.filter(r => r.maxGap === 0 && r.mode === 'exclusive').sort((a, b) => b.sr - a.sr);
  console.log('  ─── TOP 1m SINGLE CYCLES (gap=0, exclusive) ───\n');
  console.log('  Cycle | OOS SR | IS SR  | Bps  | t-stat | p-val  | WR%   | Pairs');
  console.log('  ' + '-'.repeat(75));
  for (const r of gap0excl.slice(0, 25)) {
    console.log('  ' + String(r.cycle).padStart(5) + ' | ' + r.sr.toFixed(2).padStart(6) + ' | ' + r.isSr.toFixed(2).padStart(6) + ' | ' + String(r.bps).padStart(4) + ' | ' + r.tStat.toFixed(1).padStart(6) + ' | ' + (r.pVal < 0.001 ? '<0.001' : r.pVal.toFixed(3)).padStart(6) + ' | ' + r.wr.toFixed(1).padStart(5) + '% | ' + String(r.pairs).padStart(5));
  }

  const gap0reuse = results.filter(r => r.maxGap === 0 && r.mode === 'reuse').sort((a, b) => b.sr - a.sr);
  console.log('\n  ─── TOP 1m SINGLE CYCLES (gap=0, reuse) ───\n');
  console.log('  Cycle | OOS SR | IS SR  | Bps  | t-stat | p-val  | WR%   | Pairs');
  console.log('  ' + '-'.repeat(75));
  for (const r of gap0reuse.slice(0, 25)) {
    console.log('  ' + String(r.cycle).padStart(5) + ' | ' + r.sr.toFixed(2).padStart(6) + ' | ' + r.isSr.toFixed(2).padStart(6) + ' | ' + String(r.bps).padStart(4) + ' | ' + r.tStat.toFixed(1).padStart(6) + ' | ' + (r.pVal < 0.001 ? '<0.001' : r.pVal.toFixed(3)).padStart(6) + ' | ' + r.wr.toFixed(1).padStart(5) + '% | ' + String(r.pairs).padStart(5));
  }

  console.log('\n  ✓ Done.');
  await client.end();
})();
