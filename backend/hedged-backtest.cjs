/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  HEDGED BACKTEST — Full Grid Search                                 ║
 * ║                                                                      ║
 * ║  Tests every [cycleMin, cycleMax] pair (2..20) × gap (0..5) ×       ║
 * ║  mode (exclusive, reuse) for hedged strategy performance.           ║
 * ║                                                                      ║
 * ║  Usage: node backend/hedged-backtest.cjs                            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.6180339887;
const BAR_MINUTES = 1440;
const SPLIT_PCT = 50;
const MAX_GAP_VALUES = [0, 1, 2, 3, 4, 5];
const MIN_BARS = 200;
const ORDERS = [1, 2, 3, 4, 5, 6];
const CYCLE_RANGE = { min: 2, max: 20 };

// Daily strategy params (fixed, only cycleMin/cycleMax vary)
const DAILY_PARAMS = {
  minStr: 1, minCyc: 0, spike: false, nearMiss: false, holdDiv: 2, priceExt: true,
};

// ═══════════════════════════════════════════════════════════════
// SIGNAL ENGINE — Copied from universe-backtest.cjs
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
// PAIRING ENGINE — Ported from HedgedStrategy.tsx
// ═══════════════════════════════════════════════════════════════

function buildPairs(allSignals, maxGapBars, coinBars, exclusive) {
  // allSignals: { coin: string, ...signal }[] sorted by entryIdx
  const pairs = [];
  const used = exclusive ? new Set() : null;
  const unmatched = [];

  // Build bar index
  const barIndex = new Map();
  for (let i = 0; i < allSignals.length; i++) {
    const bar = allSignals[i].entryIdx;
    if (!barIndex.has(bar)) barIndex.set(bar, []);
    barIndex.get(bar).push(i);
  }

  for (let ai = 0; ai < allSignals.length; ai++) {
    if (exclusive && used.has(ai)) continue;
    const A = allSignals[ai];

    let bestBi = -1;
    let bestScore = -Infinity;

    for (let bar = A.entryIdx - maxGapBars; bar <= A.entryIdx; bar++) {
      const candidates = barIndex.get(bar);
      if (!candidates) continue;
      for (const bi of candidates) {
        if (bi === ai) continue;
        if (exclusive && used.has(bi)) continue;
        const B = allSignals[bi];
        if (B.type === A.type) continue;
        if (B.coin === A.coin) continue;

        const gap = A.entryIdx - B.entryIdx;
        const pairBar = A.entryIdx;
        const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
        const bRemaining = bExit - pairBar;
        const minRequired = Math.max(1, A.holdDuration - maxGapBars);
        if (bRemaining < minRequired) continue;

        const aRemaining = A.holdDuration;
        const tier = gap === 0 ? 1 : 2;
        const pairDuration = Math.min(aRemaining, bRemaining);
        const score = (tier === 1 ? 100000 : 0) + pairDuration * 100 - gap * 10 + B.strength;

        if (score > bestScore) { bestScore = score; bestBi = bi; }
      }
    }

    if (bestBi >= 0) {
      const B = allSignals[bestBi];
      const gap = A.entryIdx - B.entryIdx;
      const pairBar = A.entryIdx;
      const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
      const bRemaining = bExit - pairBar;
      const pairDuration = Math.min(A.holdDuration, bRemaining);
      const tier = gap === 0 ? 1 : 2;
      const pairExitBar = pairBar + pairDuration;

      const barsA = coinBars[A.coin];
      const barsB = coinBars[B.coin];

      let legA_return, legB_return;

      if (barsA && pairBar < barsA.length && pairExitBar < barsA.length) {
        const aEntry = barsA[pairBar].open;
        const aExit = barsA[pairExitBar].open;
        legA_return = A.type === 'LONG' ? (aExit / aEntry - 1) * 100 : (aEntry / aExit - 1) * 100;
      } else {
        legA_return = A.returnPct * (pairDuration / Math.max(A.holdDuration, 1));
      }

      if (barsB && pairBar < barsB.length && pairExitBar < barsB.length) {
        const bEntry = barsB[pairBar].open;
        const bExit2 = barsB[pairExitBar].open;
        legB_return = B.type === 'LONG' ? (bExit2 / bEntry - 1) * 100 : (bEntry / bExit2 - 1) * 100;
      } else {
        legB_return = B.returnPct * (pairDuration / Math.max(B.holdDuration, 1));
      }

      const pairReturn = legA_return + legB_return;

      // Sanity: skip extreme returns
      if (Math.abs(pairReturn) > 100) continue;

      pairs.push({
        tier, legA_coin: A.coin, legB_coin: B.coin,
        legA_type: A.type, legB_type: B.type,
        pairBar, pairDuration,
        legA_return: +legA_return.toFixed(3),
        legB_return: +legB_return.toFixed(3),
        pairReturn: +pairReturn.toFixed(3),
        gapBars: gap,
      });

      if (exclusive) { used.add(ai); used.add(bestBi); }
    } else {
      unmatched.push(A);
    }
  }

  // Count unique signals used
  const uniqueSignals = new Set();
  for (const p of pairs) {
    uniqueSignals.add(p.legA_coin + ':' + p.pairBar);
    uniqueSignals.add(p.legB_coin + ':' + (p.pairBar - p.gapBars));
  }

  return { pairs, unmatched, uniqueSignalCount: uniqueSignals.size };
}

// ═══════════════════════════════════════════════════════════════
// HEDGED METRICS
// ═══════════════════════════════════════════════════════════════

// Approximate two-tailed p-value from t-statistic (good enough for t > 1)
function tToP(t, df) {
  if (df < 1) return 1;
  const x = df / (df + t * t);
  // Regularized incomplete beta approximation (simple series)
  let p;
  if (Math.abs(t) < 0.001) return 1;
  // Use normal approximation for large df
  if (df > 100) {
    const z = Math.abs(t);
    p = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) * (1 / z);
    return Math.min(1, 2 * p);
  }
  // Simple approximation: p ≈ 2 * (1 - Φ(|t| * sqrt(df/(df-2))))
  const adj = Math.abs(t) * Math.sqrt(df / Math.max(1, df - 2));
  p = 2 * (1 - normalCDF(adj));
  return Math.max(0, Math.min(1, p));
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

function calcHedgedMetrics(pairs) {
  if (pairs.length === 0) return { sharpe: 0, winRate: 0, profitFactor: 0, totalRet: 0, avgHold: 0, t1Count: 0, t2Count: 0, avgRetBps: 0, tStat: 0, pValue: 1, sharpeLo95: 0 };

  const pairRets = pairs.map(p => p.pairReturn);
  const n = pairRets.length;
  const meanRet = pairRets.reduce((s, r) => s + r, 0) / n;
  const variance = pairRets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / n;
  const stdRet = Math.sqrt(variance);
  const winRate = pairRets.filter(r => r > 0).length / n * 100;
  const totalRet = pairRets.reduce((s, r) => s + r, 0);
  const avgHold = pairs.reduce((s, p) => s + p.pairDuration, 0) / n;
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(525600 / Math.max(1, avgHold * BAR_MINUTES)) : 0;
  const grossWin = pairRets.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(pairRets.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const t1Count = pairs.filter(p => p.tier === 1).length;
  const t2Count = pairs.filter(p => p.tier === 2).length;

  // Average return in basis points (1 bps = 0.01%)
  const avgRetBps = Math.round(meanRet * 100); // meanRet is in %, * 100 = bps

  // t-statistic: is mean return significantly different from zero?
  const sampleStd = n > 1 ? Math.sqrt(pairRets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (n - 1)) : 0;
  const tStat = sampleStd > 0 ? (meanRet / (sampleStd / Math.sqrt(n))) : 0;
  const pValue = tToP(tStat, n - 1);

  // Bootstrap 95% CI on Sharpe (1000 resamples)
  let sharpeLo95 = 0;
  if (n >= 10) {
    const bootstrapSharpes = [];
    for (let b = 0; b < 1000; b++) {
      let bSum = 0, bSum2 = 0, bHold = 0;
      for (let j = 0; j < n; j++) {
        const idx = Math.floor(Math.random() * n);
        bSum += pairRets[idx];
        bSum2 += pairRets[idx] ** 2;
        bHold += pairs[idx].pairDuration;
      }
      const bMean = bSum / n;
      const bStd = Math.sqrt(Math.max(0, bSum2 / n - bMean * bMean));
      const bAvgHold = bHold / n;
      const bSharpe = bStd > 0 ? (bMean / bStd) * Math.sqrt(525600 / Math.max(1, bAvgHold * BAR_MINUTES)) : 0;
      bootstrapSharpes.push(bSharpe);
    }
    bootstrapSharpes.sort((a, b) => a - b);
    sharpeLo95 = bootstrapSharpes[Math.floor(0.05 * bootstrapSharpes.length)];
  }

  return {
    sharpe: +sharpe.toFixed(3), winRate: +winRate.toFixed(1), profitFactor: +profitFactor.toFixed(3),
    totalRet: +totalRet.toFixed(3), avgHold: +avgHold.toFixed(1), t1Count, t2Count,
    avgRetBps, tStat: +tStat.toFixed(2), pValue: +pValue.toFixed(4), sharpeLo95: +sharpeLo95.toFixed(3),
  };
}

// Unhedged baseline from raw signals
function calcUnhedgedBaseline(signals) {
  if (signals.length === 0) return { sharpe: 0, winRate: 0 };
  const rets = signals.map(s => s.returnPct);
  const winRate = rets.filter(r => r > 0).length / rets.length * 100;
  const m = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / rets.length);
  const avgHold = signals.reduce((s, sig) => s + sig.holdDuration, 0) / signals.length;
  const sharpe = std > 0 ? (m / std) * Math.sqrt(525600 / Math.max(1, avgHold * BAR_MINUTES)) : 0;
  return { sharpe: +sharpe.toFixed(3), winRate: +winRate.toFixed(1) };
}

// Top coin pairs
function getTopPairs(pairs, limit = 10) {
  const freq = {};
  for (const p of pairs) {
    const key = [p.legA_coin, p.legB_coin].sort().join('/');
    if (!freq[key]) freq[key] = { pair: key, count: 0, totalRet: 0 };
    freq[key].count++;
    freq[key].totalRet += p.pairReturn;
  }
  return Object.values(freq)
    .map(f => ({ ...f, avgRet: +(f.totalRet / f.count).toFixed(3) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  HEDGED BACKTEST — Full Grid Search (Daily bars)                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // ── Create tables ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS hedged_backtest (
      id SERIAL PRIMARY KEY, computed_at TIMESTAMPTZ DEFAULT now(),
      bar_minutes INT NOT NULL, cycle_min INT NOT NULL, cycle_max INT NOT NULL,
      pair_mode TEXT NOT NULL, max_gap INT NOT NULL, split_pct INT DEFAULT 50,
      coins_used INT,
      is_sharpe FLOAT, is_win_rate FLOAT, is_profit_factor FLOAT,
      is_total_ret FLOAT, is_trade_count INT, is_avg_hold FLOAT,
      is_t1_count INT, is_t2_count INT, is_unmatched INT,
      oos_sharpe FLOAT, oos_win_rate FLOAT, oos_profit_factor FLOAT,
      oos_total_ret FLOAT, oos_trade_count INT, oos_avg_hold FLOAT,
      oos_t1_count INT, oos_t2_count INT, oos_unmatched INT,
      oos_unhedged_sharpe FLOAT, oos_unhedged_wr FLOAT,
      oos_avg_ret_bps INT, oos_t_stat FLOAT, oos_p_value FLOAT, oos_sharpe_lo95 FLOAT,
      is_avg_ret_bps INT, is_t_stat FLOAT, is_p_value FLOAT, is_sharpe_lo95 FLOAT,
      top_pairs JSONB, oos_pairs JSONB,
      UNIQUE(bar_minutes, cycle_min, cycle_max, pair_mode, max_gap)
    )
  `);

  // Add stat columns if table already exists
  for (const col of ['oos_avg_ret_bps INT', 'oos_t_stat FLOAT', 'oos_p_value FLOAT', 'oos_sharpe_lo95 FLOAT', 'is_avg_ret_bps INT', 'is_t_stat FLOAT', 'is_p_value FLOAT', 'is_sharpe_lo95 FLOAT']) {
    try { await client.query(`ALTER TABLE hedged_backtest ADD COLUMN IF NOT EXISTS ${col}`); } catch {}
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS hedged_backtest_coins (
      id SERIAL PRIMARY KEY,
      backtest_id INT REFERENCES hedged_backtest(id) ON DELETE CASCADE,
      symbol TEXT,
      oos_signals INT, oos_paired INT, oos_as_long INT, oos_as_short INT,
      oos_avg_return FLOAT, oos_win_rate FLOAT,
      best_cycle INT
    )
  `);

  // ── Load all daily candles ──
  console.log('\n  Loading daily candles...');
  const { rows: rawBars } = await client.query(`
    SELECT symbol, timestamp as time, open, high, low, close, volume
    FROM "Candle1d"
    ORDER BY symbol, timestamp
  `);

  const coinBars = {};
  for (const row of rawBars) {
    if (!coinBars[row.symbol]) coinBars[row.symbol] = [];
    coinBars[row.symbol].push({ time: row.time, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +(row.volume || 0) });
  }

  const allCoins = Object.keys(coinBars).filter(c => coinBars[c].length >= MIN_BARS);
  console.log(`  ${Object.keys(coinBars).length} total coins, ${allCoins.length} with ≥${MIN_BARS} bars`);

  if (allCoins.length === 0) {
    console.log('  No coins with enough data. Exiting.');
    await client.end();
    return;
  }

  // ── Pre-compute ALL fracmap bands for cycles 2-20, orders 1-6, per coin ──
  console.log('  Pre-computing fracmap bands (cycles 2-20, orders 1-6)...');
  const allBandsCache = {}; // { symbol: { cycle: { order: band } } }

  for (const symbol of allCoins) {
    const bars = coinBars[symbol];
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    allBandsCache[symbol] = {};
    for (let cycle = CYCLE_RANGE.min; cycle <= CYCLE_RANGE.max; cycle++) {
      allBandsCache[symbol][cycle] = {};
      for (const order of ORDERS) {
        allBandsCache[symbol][cycle][order] = computeFracmap(highs, lows, cycle, order);
      }
    }
  }
  console.log(`  Bands cached for ${allCoins.length} coins\n`);

  // ── Generate all cycle range combos ──
  const cycleRanges = [];
  for (let cMin = CYCLE_RANGE.min; cMin < CYCLE_RANGE.max; cMin++) {
    for (let cMax = cMin + 1; cMax <= CYCLE_RANGE.max; cMax++) {
      cycleRanges.push({ cycleMin: cMin, cycleMax: cMax });
    }
  }
  console.log(`  Grid: ${cycleRanges.length} cycle ranges × ${MAX_GAP_VALUES.length} gaps × 2 modes = ${cycleRanges.length * MAX_GAP_VALUES.length * 2} cells\n`);

  const topResults = []; // Collect for final summary
  let cellsDone = 0;
  const totalCells = cycleRanges.length * MAX_GAP_VALUES.length * 2;

  for (const { cycleMin, cycleMax } of cycleRanges) {
    // Collect signals for this cycle range
    const isSignals = {}; // { symbol: Signal[] }
    const oosSignals = {};
    const isBars = {};
    const oosBars = {};
    let totalIs = 0, totalOos = 0;

    for (const symbol of allCoins) {
      const bars = coinBars[symbol];
      const splitIdx = Math.floor(bars.length * SPLIT_PCT / 100);
      const isHalf = bars.slice(0, splitIdx);
      const oosHalf = bars.slice(splitIdx);

      if (isHalf.length < 50 || oosHalf.length < 50) continue;

      // Filter bands to this cycle range
      const getBands = (barsArr) => {
        const bands = [];
        const highs = barsArr.map(b => b.high);
        const lows = barsArr.map(b => b.low);
        for (let cycle = cycleMin; cycle <= cycleMax; cycle++) {
          for (const order of ORDERS) {
            bands.push(computeFracmap(highs, lows, cycle, order));
          }
        }
        return bands;
      };

      const isBands = getBands(isHalf);
      const oosBands = getBands(oosHalf);

      const isSigs = detectEnsembleSignals(isHalf, isBands, DAILY_PARAMS.minStr, DAILY_PARAMS.minCyc, DAILY_PARAMS.spike, DAILY_PARAMS.holdDiv, DAILY_PARAMS.nearMiss, DAILY_PARAMS.priceExt);
      const oosSigs = detectEnsembleSignals(oosHalf, oosBands, DAILY_PARAMS.minStr, DAILY_PARAMS.minCyc, DAILY_PARAMS.spike, DAILY_PARAMS.holdDiv, DAILY_PARAMS.nearMiss, DAILY_PARAMS.priceExt);

      if (isSigs.length > 0) {
        isSignals[symbol] = isSigs;
        isBars[symbol] = isHalf;
        totalIs += isSigs.length;
      }
      if (oosSigs.length > 0) {
        oosSignals[symbol] = oosSigs;
        oosBars[symbol] = oosHalf;
        totalOos += oosSigs.length;
      }
    }

    const coinsUsed = Object.keys(oosSignals).length;
    if (totalOos < 2) {
      cellsDone += MAX_GAP_VALUES.length * 2;
      continue;
    }

    // Flatten signals with coin labels
    const flattenSigs = (sigMap) => {
      const flat = [];
      for (const [symbol, sigs] of Object.entries(sigMap)) {
        for (const s of sigs) flat.push({ ...s, coin: symbol });
      }
      flat.sort((a, b) => a.entryIdx - b.entryIdx);
      return flat;
    };

    const flatIs = flattenSigs(isSignals);
    const flatOos = flattenSigs(oosSignals);

    // Unhedged baseline
    const oosBaseline = calcUnhedgedBaseline(flatOos);

    // Test each gap × mode combination
    for (const maxGap of MAX_GAP_VALUES) {
      for (const mode of ['exclusive', 'reuse']) {
        const isExclusive = mode === 'exclusive';

        const oosResult = buildPairs(flatOos, maxGap, oosBars, isExclusive);
        const isResult = buildPairs(flatIs, maxGap, isBars, isExclusive);

        const oosMetrics = calcHedgedMetrics(oosResult.pairs);
        const isMetrics = calcHedgedMetrics(isResult.pairs);

        const topPairs = getTopPairs(oosResult.pairs);

        // Upsert
        await client.query(`
          INSERT INTO hedged_backtest (
            bar_minutes, cycle_min, cycle_max, pair_mode, max_gap, split_pct, coins_used,
            is_sharpe, is_win_rate, is_profit_factor, is_total_ret, is_trade_count, is_avg_hold, is_t1_count, is_t2_count, is_unmatched,
            oos_sharpe, oos_win_rate, oos_profit_factor, oos_total_ret, oos_trade_count, oos_avg_hold, oos_t1_count, oos_t2_count, oos_unmatched,
            oos_unhedged_sharpe, oos_unhedged_wr,
            oos_avg_ret_bps, oos_t_stat, oos_p_value, oos_sharpe_lo95,
            is_avg_ret_bps, is_t_stat, is_p_value, is_sharpe_lo95,
            top_pairs
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
          ON CONFLICT (bar_minutes, cycle_min, cycle_max, pair_mode, max_gap)
          DO UPDATE SET computed_at=now(), coins_used=$7,
            is_sharpe=$8, is_win_rate=$9, is_profit_factor=$10, is_total_ret=$11, is_trade_count=$12, is_avg_hold=$13, is_t1_count=$14, is_t2_count=$15, is_unmatched=$16,
            oos_sharpe=$17, oos_win_rate=$18, oos_profit_factor=$19, oos_total_ret=$20, oos_trade_count=$21, oos_avg_hold=$22, oos_t1_count=$23, oos_t2_count=$24, oos_unmatched=$25,
            oos_unhedged_sharpe=$26, oos_unhedged_wr=$27,
            oos_avg_ret_bps=$28, oos_t_stat=$29, oos_p_value=$30, oos_sharpe_lo95=$31,
            is_avg_ret_bps=$32, is_t_stat=$33, is_p_value=$34, is_sharpe_lo95=$35,
            top_pairs=$36
        `, [
          BAR_MINUTES, cycleMin, cycleMax, mode, maxGap, SPLIT_PCT, coinsUsed,
          isMetrics.sharpe, isMetrics.winRate, isMetrics.profitFactor, isMetrics.totalRet, isResult.pairs.length, isMetrics.avgHold, isMetrics.t1Count, isMetrics.t2Count, isResult.unmatched.length,
          oosMetrics.sharpe, oosMetrics.winRate, oosMetrics.profitFactor, oosMetrics.totalRet, oosResult.pairs.length, oosMetrics.avgHold, oosMetrics.t1Count, oosMetrics.t2Count, oosResult.unmatched.length,
          oosBaseline.sharpe, oosBaseline.winRate,
          oosMetrics.avgRetBps, oosMetrics.tStat, oosMetrics.pValue, oosMetrics.sharpeLo95,
          isMetrics.avgRetBps, isMetrics.tStat, isMetrics.pValue, isMetrics.sharpeLo95,
          JSON.stringify(topPairs),
        ]);

        // Track for summary
        if (oosResult.pairs.length >= 5) {
          topResults.push({
            cycleMin, cycleMax, mode, maxGap,
            oosSharpe: oosMetrics.sharpe, isSharpe: isMetrics.sharpe,
            oosWR: oosMetrics.winRate, oosPairs: oosResult.pairs.length,
            oosBps: oosMetrics.avgRetBps, oosTstat: oosMetrics.tStat, oosPval: oosMetrics.pValue, oosSRlo95: oosMetrics.sharpeLo95,
            oosPF: oosMetrics.profitFactor, oosRet: oosMetrics.totalRet,
          });
        }

        cellsDone++;
      }
    }

    // Progress
    const pct = ((cellsDone / totalCells) * 100).toFixed(0);
    process.stdout.write(`\r  Progress: ${pct}% (${cellsDone}/${totalCells}) — last: C${cycleMin}-${cycleMax} OOS=${totalOos} sigs, ${coinsUsed} coins`);
  }

  console.log('\n');

  // ── Per-coin analysis for top-5 configs ──
  topResults.sort((a, b) => b.oosSharpe - a.oosSharpe);
  const top5 = topResults.slice(0, 5);

  if (top5.length > 0) {
    console.log('  Saving per-coin breakdown for top-5 configs...');
    for (const cfg of top5) {
      // Get the backtest_id
      const { rows: [bt] } = await client.query(
        'SELECT id FROM hedged_backtest WHERE bar_minutes=$1 AND cycle_min=$2 AND cycle_max=$3 AND pair_mode=$4 AND max_gap=$5',
        [BAR_MINUTES, cfg.cycleMin, cfg.cycleMax, cfg.mode, cfg.maxGap]
      );
      if (!bt) continue;

      // Regenerate OOS signals for this config
      for (const symbol of allCoins) {
        const bars = coinBars[symbol];
        const splitIdx = Math.floor(bars.length * SPLIT_PCT / 100);
        const oosHalf = bars.slice(splitIdx);
        if (oosHalf.length < 50) continue;

        const bands = [];
        const highs = oosHalf.map(b => b.high);
        const lows = oosHalf.map(b => b.low);
        for (let cycle = cfg.cycleMin; cycle <= cfg.cycleMax; cycle++) {
          for (const order of ORDERS) {
            bands.push(computeFracmap(highs, lows, cycle, order));
          }
        }

        const sigs = detectEnsembleSignals(oosHalf, bands, DAILY_PARAMS.minStr, DAILY_PARAMS.minCyc, DAILY_PARAMS.spike, DAILY_PARAMS.holdDiv, DAILY_PARAMS.nearMiss, DAILY_PARAMS.priceExt);
        if (sigs.length === 0) continue;

        const longs = sigs.filter(s => s.type === 'LONG').length;
        const shorts = sigs.filter(s => s.type === 'SHORT').length;
        const avgRet = sigs.reduce((s, sig) => s + sig.returnPct, 0) / sigs.length;
        const wr = sigs.filter(s => s.won).length / sigs.length * 100;
        const cycleCounts = {};
        for (const s of sigs) { cycleCounts[s.maxCycle] = (cycleCounts[s.maxCycle] || 0) + 1; }
        const bestCycle = Object.entries(cycleCounts).sort((a, b) => b[1] - a[1])[0];

        await client.query(
          `INSERT INTO hedged_backtest_coins (backtest_id, symbol, oos_signals, oos_paired, oos_as_long, oos_as_short, oos_avg_return, oos_win_rate, best_cycle)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [bt.id, symbol, sigs.length, 0, longs, shorts, +avgRet.toFixed(3), +wr.toFixed(1), bestCycle ? parseInt(bestCycle[0]) : null]
        );
      }
    }
  }

  // ── Print summary ──
  console.log('\n  ═══════════════════════════════════════════════════════════════');
  console.log('  TOP 20 CONFIGS by OOS Sharpe (min 5 pairs)');
  console.log('  ═══════════════════════════════════════════════════════════════\n');

  const top20 = topResults.slice(0, 20);
  console.log('  Cycles   | Mode      | Gap | OOS SR | SR 95%CI | IS SR  | Bps  | t-stat | p-val  | WR%   | Pairs');
  console.log('  ' + '-'.repeat(105));
  for (const r of top20) {
    console.log(
      '  ' + `C${r.cycleMin}-${r.cycleMax}`.padEnd(9) +
      '| ' + r.mode.padEnd(10) +
      '| ' + String(r.maxGap).padEnd(4) +
      '| ' + r.oosSharpe.toFixed(2).padStart(6) +
      ' | ' + r.oosSRlo95.toFixed(2).padStart(8) +
      ' | ' + r.isSharpe.toFixed(2).padStart(6) +
      ' | ' + String(r.oosBps).padStart(4) +
      ' | ' + r.oosTstat.toFixed(1).padStart(6) +
      ' | ' + (r.oosPval < 0.001 ? '<0.001' : r.oosPval.toFixed(3)).padStart(6) +
      ' | ' + r.oosWR.toFixed(1).padStart(5) + '%' +
      ' | ' + String(r.oosPairs).padStart(5)
    );
  }

  // ── Per-coin cycle analysis ──
  if (top5.length > 0) {
    const best = top5[0];
    console.log('\n  ═══════════════════════════════════════════════════════════════');
    console.log(`  PER-COIN ANALYSIS — Best config: C${best.cycleMin}-${best.cycleMax} ${best.mode} gap=${best.maxGap}`);
    console.log('  ═══════════════════════════════════════════════════════════════\n');

    const { rows: [bt] } = await client.query(
      'SELECT id FROM hedged_backtest WHERE bar_minutes=$1 AND cycle_min=$2 AND cycle_max=$3 AND pair_mode=$4 AND max_gap=$5',
      [BAR_MINUTES, best.cycleMin, best.cycleMax, best.mode, best.maxGap]
    );
    if (bt) {
      const { rows: coins } = await client.query(
        'SELECT * FROM hedged_backtest_coins WHERE backtest_id=$1 ORDER BY oos_signals DESC LIMIT 30',
        [bt.id]
      );
      console.log('  Coin           | Sigs | L/S      | AvgRet  | WR%   | Best Cycle');
      console.log('  ' + '-'.repeat(70));
      for (const c of coins) {
        console.log(
          '  ' + (c.symbol || '').padEnd(17) +
          '| ' + String(c.oos_signals).padStart(4) +
          ' | ' + `${c.oos_as_long}L/${c.oos_as_short}S`.padEnd(9) +
          '| ' + (c.oos_avg_return >= 0 ? '+' : '') + c.oos_avg_return.toFixed(3).padStart(6) + '%' +
          ' | ' + c.oos_win_rate.toFixed(1).padStart(5) + '%' +
          ' | ' + (c.best_cycle != null ? `${c.best_cycle}d` : '—')
        );
      }
    }
  }

  const { rows: [countRow] } = await client.query('SELECT COUNT(*)::int as cnt FROM hedged_backtest WHERE bar_minutes=$1', [BAR_MINUTES]);
  console.log(`\n  ✓ Done. ${countRow.cnt} rows in hedged_backtest table.`);

  await client.end();
})();
