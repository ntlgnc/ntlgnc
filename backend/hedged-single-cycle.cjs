/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  HEDGED BACKTEST — Single Cycle Sweep                               ║
 * ║                                                                      ║
 * ║  Tests each individual cycle length (not ranges) for hedged          ║
 * ║  performance. Daily: cycles 2-20. Hourly: cycles 2-100.             ║
 * ║                                                                      ║
 * ║  Usage: node backend/hedged-single-cycle.cjs                        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.6180339887;
const SPLIT_PCT = 50;
const MAX_GAP_VALUES = [0, 1, 2, 3, 4, 5];
const MIN_BARS = 200;
const ORDERS = [1, 2, 3, 4, 5, 6];

// ═══════════════════════════════════════════════════════════════
// SIGNAL ENGINE — Copied from hedged-backtest.cjs
// ═══════════════════════════════════════════════════════════════

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
  function isLocalMax(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] > val) return false; }
    return true;
  }
  function isLocalMin(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] < val) return false; }
    return true;
  }
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

// ═══════════════════════════════════════════════════════════════
// PAIRING + METRICS — Same as hedged-backtest.cjs
// ═══════════════════════════════════════════════════════════════

function buildPairs(allSignals, maxGapBars, coinBars, exclusive) {
  const pairs = [];
  const used = exclusive ? new Set() : null;
  const barIndex = new Map();
  for (let i = 0; i < allSignals.length; i++) {
    const bar = allSignals[i].entryIdx;
    if (!barIndex.has(bar)) barIndex.set(bar, []);
    barIndex.get(bar).push(i);
  }
  for (let ai = 0; ai < allSignals.length; ai++) {
    if (exclusive && used.has(ai)) continue;
    const A = allSignals[ai];
    let bestBi = -1, bestScore = -Infinity;
    for (let bar = A.entryIdx - maxGapBars; bar <= A.entryIdx; bar++) {
      const candidates = barIndex.get(bar);
      if (!candidates) continue;
      for (const bi of candidates) {
        if (bi === ai) continue;
        if (exclusive && used.has(bi)) continue;
        const B = allSignals[bi];
        if (B.type === A.type || B.coin === A.coin) continue;
        const gap = A.entryIdx - B.entryIdx;
        const pairBar = A.entryIdx;
        const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
        const bRemaining = bExit - pairBar;
        if (bRemaining < Math.max(1, A.holdDuration - maxGapBars)) continue;
        const pairDuration = Math.min(A.holdDuration, bRemaining);
        const tier = gap === 0 ? 1 : 2;
        const score = (tier === 1 ? 100000 : 0) + pairDuration * 100 - gap * 10 + B.strength;
        if (score > bestScore) { bestScore = score; bestBi = bi; }
      }
    }
    if (bestBi >= 0) {
      const B = allSignals[bestBi];
      const gap = A.entryIdx - B.entryIdx;
      const pairBar = A.entryIdx;
      const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
      const pairDuration = Math.min(A.holdDuration, bExit - pairBar);
      const pairExitBar = pairBar + pairDuration;
      const barsA = coinBars[A.coin], barsB = coinBars[B.coin];
      let legA_return, legB_return;
      if (barsA && pairBar < barsA.length && pairExitBar < barsA.length) {
        const aE = barsA[pairBar].open, aX = barsA[pairExitBar].open;
        legA_return = A.type === 'LONG' ? (aX / aE - 1) * 100 : (aE / aX - 1) * 100;
      } else { legA_return = A.returnPct * (pairDuration / Math.max(A.holdDuration, 1)); }
      if (barsB && pairBar < barsB.length && pairExitBar < barsB.length) {
        const bE = barsB[pairBar].open, bX = barsB[pairExitBar].open;
        legB_return = B.type === 'LONG' ? (bX / bE - 1) * 100 : (bE / bX - 1) * 100;
      } else { legB_return = B.returnPct * (pairDuration / Math.max(B.holdDuration, 1)); }
      const pairReturn = legA_return + legB_return;
      if (Math.abs(pairReturn) > 100) continue;
      pairs.push({ tier: gap === 0 ? 1 : 2, pairReturn: +pairReturn.toFixed(3), pairDuration, gapBars: gap, entryBar: A.entryIdx });
      if (exclusive) { used.add(ai); used.add(bestBi); }
    }
  }
  return pairs;
}

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function calcMetrics(pairs, barMinutes) {
  if (pairs.length === 0) return { sharpe: 0, winRate: 0, pf: 0, totalRet: 0, avgHold: 0, avgRetBps: 0, tStat: 0, pValue: 1, t1: 0, t2: 0 };
  const rets = pairs.map(p => p.pairReturn);
  const n = rets.length;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const avgHold = pairs.reduce((s, p) => s + p.pairDuration, 0) / n;
  const winRate = rets.filter(r => r > 0).length / n * 100;
  const grossWin = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Daily-return-based Sharpe (correct annualisation)
  // Distribute each pair's return evenly across its hold bars, bucket into daily returns
  const barsPerDay = Math.round(1440 / Math.max(1, barMinutes));
  const maxBar = pairs.length > 0 ? Math.max(...pairs.map(p => (p.entryBar || 0) + p.pairDuration)) : 0;
  const nDays = Math.max(1, Math.ceil(maxBar / barsPerDay));
  const dailyRets = new Float64Array(nDays);
  for (const p of pairs) {
    const entry = p.entryBar || 0;
    const hold = Math.max(1, p.pairDuration);
    const perBar = p.pairReturn / hold;
    for (let b = entry; b < entry + hold; b++) {
      const day = Math.floor(b / barsPerDay);
      if (day < nDays) dailyRets[day] += perBar;
    }
  }
  let dSum = 0, dSum2 = 0;
  for (const d of dailyRets) { dSum += d; dSum2 += d * d; }
  const dMean = dSum / nDays;
  const dVar = dSum2 / nDays - dMean * dMean;
  const dStd = Math.sqrt(Math.max(0, dVar));
  const sharpe = dStd > 0 ? (dMean / dStd) * Math.sqrt(365) : 0;

  // t-stat on per-trade returns (still valid for significance testing)
  const sampleStd = n > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;
  const tStat = sampleStd > 0 ? (mean / (sampleStd / Math.sqrt(n))) : 0;
  const pValue = Math.max(0, Math.min(1, 2 * (1 - normalCDF(Math.abs(tStat)))));
  return {
    sharpe: +sharpe.toFixed(3), winRate: +winRate.toFixed(1), pf: +pf.toFixed(2),
    totalRet: rets.reduce((s, r) => s + r, 0), avgHold: +avgHold.toFixed(1),
    avgRetBps: Math.round(mean * 100), tStat: +tStat.toFixed(2), pValue: +pValue.toFixed(4),
    t1: pairs.filter(p => p.tier === 1).length, t2: pairs.filter(p => p.tier === 2).length,
  };
}

// ═══════════════════════════════════════════════════════════════
// TIMEFRAME CONFIGS
// ═══════════════════════════════════════════════════════════════

const TIMEFRAMES = [
  {
    label: '1D', barMinutes: 1440, table: 'Candle1d',
    cycleStart: 2, cycleEnd: 20,
    minStr: 1, minCyc: 0, spike: false, nearMiss: false, holdDiv: 2, priceExt: true,
  },
  {
    label: '1H', barMinutes: 60, table: 'Candle1h',
    cycleStart: 2, cycleEnd: 100,
    minStr: 1, minCyc: 0, spike: true, nearMiss: true, holdDiv: 5, priceExt: true,
  },
];

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  HEDGED BACKTEST — Single Cycle Sweep (1D + 1H)                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // Create table
  await client.query(`
    CREATE TABLE IF NOT EXISTS hedged_single_cycle (
      id SERIAL PRIMARY KEY, computed_at TIMESTAMPTZ DEFAULT now(),
      bar_minutes INT NOT NULL, cycle INT NOT NULL,
      pair_mode TEXT NOT NULL, max_gap INT NOT NULL,
      coins_used INT, total_signals INT,
      oos_sharpe FLOAT, oos_win_rate FLOAT, oos_pf FLOAT,
      oos_total_ret FLOAT, oos_trade_count INT, oos_avg_hold FLOAT,
      oos_avg_ret_bps INT, oos_t_stat FLOAT, oos_p_value FLOAT,
      oos_t1 INT, oos_t2 INT,
      is_sharpe FLOAT, is_trade_count INT,
      UNIQUE(bar_minutes, cycle, pair_mode, max_gap)
    )
  `);

  for (const tf of TIMEFRAMES) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ' + tf.label + ' BARS (' + tf.barMinutes + 'm) — cycles ' + tf.cycleStart + ' to ' + tf.cycleEnd);
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Load candles
    console.log('  Loading ' + tf.table + '...');
    const { rows: rawBars } = await client.query(
      `SELECT symbol, timestamp as time, open, high, low, close, volume FROM "${tf.table}" ORDER BY symbol, timestamp`
    );
    const coinBars = {};
    for (const row of rawBars) {
      if (!coinBars[row.symbol]) coinBars[row.symbol] = [];
      coinBars[row.symbol].push({ time: row.time, open: +row.open, high: +row.high, low: +row.low, close: +row.close });
    }
    const allCoins = Object.keys(coinBars).filter(c => coinBars[c].length >= MIN_BARS);
    console.log('  ' + Object.keys(coinBars).length + ' coins, ' + allCoins.length + ' with >=' + MIN_BARS + ' bars\n');

    if (allCoins.length === 0) { console.log('  No coins. Skipping.'); continue; }

    const totalCycles = tf.cycleEnd - tf.cycleStart + 1;
    const totalCells = totalCycles * MAX_GAP_VALUES.length * 2;
    let cellsDone = 0;
    const results = [];

    for (let cycle = tf.cycleStart; cycle <= tf.cycleEnd; cycle++) {
      // Generate signals for this single cycle
      const oosSignals = {};
      const isSignals = {};
      const oosBarsMap = {};
      const isBarsMap = {};
      let totalOos = 0;

      for (const symbol of allCoins) {
        const bars = coinBars[symbol];
        const splitIdx = Math.floor(bars.length * SPLIT_PCT / 100);
        const isHalf = bars.slice(0, splitIdx);
        const oosHalf = bars.slice(splitIdx);
        if (isHalf.length < 50 || oosHalf.length < 50) continue;

        const genBands = (barsArr) => {
          const highs = barsArr.map(b => b.high);
          const lows = barsArr.map(b => b.low);
          const bands = [];
          for (const order of ORDERS) {
            bands.push(computeFracmap(highs, lows, cycle, order));
          }
          return bands;
        };

        const oosSigs = detectEnsembleSignals(oosHalf, genBands(oosHalf), tf.minStr, tf.minCyc, tf.spike, tf.holdDiv, tf.nearMiss, tf.priceExt);
        const isSigs = detectEnsembleSignals(isHalf, genBands(isHalf), tf.minStr, tf.minCyc, tf.spike, tf.holdDiv, tf.nearMiss, tf.priceExt);

        if (oosSigs.length > 0) { oosSignals[symbol] = oosSigs; oosBarsMap[symbol] = oosHalf; totalOos += oosSigs.length; }
        if (isSigs.length > 0) { isSignals[symbol] = isSigs; isBarsMap[symbol] = isHalf; }
      }

      if (totalOos < 2) { cellsDone += MAX_GAP_VALUES.length * 2; continue; }

      const flatten = (sigMap) => {
        const flat = [];
        for (const [sym, sigs] of Object.entries(sigMap)) {
          for (const s of sigs) flat.push({ ...s, coin: sym });
        }
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
          const oosM = calcMetrics(oosPairs, tf.barMinutes);
          const isM = calcMetrics(isPairs, tf.barMinutes);

          await client.query(`
            INSERT INTO hedged_single_cycle (bar_minutes, cycle, pair_mode, max_gap, coins_used, total_signals,
              oos_sharpe, oos_win_rate, oos_pf, oos_total_ret, oos_trade_count, oos_avg_hold,
              oos_avg_ret_bps, oos_t_stat, oos_p_value, oos_t1, oos_t2, is_sharpe, is_trade_count)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            ON CONFLICT (bar_minutes, cycle, pair_mode, max_gap)
            DO UPDATE SET computed_at=now(), coins_used=$5, total_signals=$6,
              oos_sharpe=$7, oos_win_rate=$8, oos_pf=$9, oos_total_ret=$10, oos_trade_count=$11, oos_avg_hold=$12,
              oos_avg_ret_bps=$13, oos_t_stat=$14, oos_p_value=$15, oos_t1=$16, oos_t2=$17, is_sharpe=$18, is_trade_count=$19
          `, [
            tf.barMinutes, cycle, mode, maxGap, coinsUsed, totalOos,
            oosM.sharpe, oosM.winRate, oosM.pf, oosM.totalRet, oosPairs.length, oosM.avgHold,
            oosM.avgRetBps, oosM.tStat, oosM.pValue, oosM.t1, oosM.t2, isM.sharpe, isPairs.length,
          ]);

          if (oosPairs.length >= 5) {
            results.push({ cycle, mode, maxGap, sr: oosM.sharpe, isSr: isM.sharpe, wr: oosM.winRate, pairs: oosPairs.length, bps: oosM.avgRetBps, tStat: oosM.tStat, pVal: oosM.pValue });
          }
          cellsDone++;
        }
      }
      process.stdout.write('\r  Progress: ' + ((cellsDone / totalCells * 100) | 0) + '% (' + cellsDone + '/' + totalCells + ') — cycle=' + cycle + ' sigs=' + totalOos + ' coins=' + Object.keys(oosSignals).length);
    }

    console.log('\n');

    // Print summary — gap=0 exclusive (cleanest signal)
    results.sort((a, b) => b.sr - a.sr);
    const gap0excl = results.filter(r => r.maxGap === 0 && r.mode === 'exclusive').sort((a, b) => b.sr - a.sr);

    console.log('  ─── TOP SINGLE CYCLES (gap=0, exclusive) ───\n');
    console.log('  Cycle | OOS SR | IS SR  | Bps  | t-stat | p-val  | WR%   | Pairs');
    console.log('  ' + '-'.repeat(75));
    for (const r of gap0excl.slice(0, 25)) {
      console.log(
        '  ' + String(r.cycle).padStart(5) +
        ' | ' + r.sr.toFixed(2).padStart(6) +
        ' | ' + r.isSr.toFixed(2).padStart(6) +
        ' | ' + String(r.bps).padStart(4) +
        ' | ' + r.tStat.toFixed(1).padStart(6) +
        ' | ' + (r.pVal < 0.001 ? '<0.001' : r.pVal.toFixed(3)).padStart(6) +
        ' | ' + r.wr.toFixed(1).padStart(5) + '%' +
        ' | ' + String(r.pairs).padStart(5)
      );
    }

    // Also show gap=0 reuse for comparison
    const gap0reuse = results.filter(r => r.maxGap === 0 && r.mode === 'reuse').sort((a, b) => b.sr - a.sr);
    console.log('\n  ─── TOP SINGLE CYCLES (gap=0, reuse) ───\n');
    console.log('  Cycle | OOS SR | IS SR  | Bps  | t-stat | p-val  | WR%   | Pairs');
    console.log('  ' + '-'.repeat(75));
    for (const r of gap0reuse.slice(0, 25)) {
      console.log(
        '  ' + String(r.cycle).padStart(5) +
        ' | ' + r.sr.toFixed(2).padStart(6) +
        ' | ' + r.isSr.toFixed(2).padStart(6) +
        ' | ' + String(r.bps).padStart(4) +
        ' | ' + r.tStat.toFixed(1).padStart(6) +
        ' | ' + (r.pVal < 0.001 ? '<0.001' : r.pVal.toFixed(3)).padStart(6) +
        ' | ' + r.wr.toFixed(1).padStart(5) + '%' +
        ' | ' + String(r.pairs).padStart(5)
      );
    }
  }

  const { rows: counts } = await client.query('SELECT bar_minutes, COUNT(*)::int as cnt FROM hedged_single_cycle GROUP BY bar_minutes ORDER BY bar_minutes');
  console.log('\n  ✓ Done.');
  counts.forEach(r => console.log('    ' + (r.bar_minutes >= 1440 ? '1D' : r.bar_minutes >= 60 ? '1H' : '1m') + ': ' + r.cnt + ' rows'));

  await client.end();
})();
