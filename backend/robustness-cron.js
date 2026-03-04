/**
 * robustness-cron.js — Hourly automated robustness audit
 * 
 * Architecture:
 *   1. Load all ACTIVE strategies from FracmapStrategy table
 *   2. For each timeframe needed, load candle data ONCE (shared across strategies)
 *   3. Regime features are MARKET properties — computed once per coin/bar, cached
 *   4. For each strategy, run signal detection, tag signals with cached regime features
 *   5. Compute SR per regime bucket × direction (all/long/short), persist to regime_scorecard
 *   6. Store research_log report per strategy
 *
 * Supports universal strategies (all coins) and per-coin strategies (symbol field set).
 * Picks up new/changed strategies automatically from FracmapStrategy.
 *
 * Usage:  node robustness-cron.js
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const PHI = 1.618034;
const SPLIT_PCT = 50;
const AUDIT_INTERVAL = 60 * 60 * 1000;

const DEFAULT_STRATEGIES = {
  1:    { barMinutes: 1,    cycleMin: 10, cycleMax: 100, minStr: 1, minCyc: 55, spike: true, nearMiss: true, holdDiv: 4, priceExt: true },
  60:   { barMinutes: 60,   cycleMin: 55, cycleMax: 89,  minStr: 1, minCyc: 64, spike: true, nearMiss: true, holdDiv: 5, priceExt: true },
  1440: { barMinutes: 1440, cycleMin: 2,  cycleMax: 12,  minStr: 1, minCyc: 0,  spike: false, nearMiss: false, holdDiv: 2, priceExt: true },
};

const BAR_TABLE = { 1: 'Candle1m', 60: 'Candle1h', 1440: 'Candle1d' };
const TF_LABEL = { 1: '1m', 60: '1h', 1440: '1d' };


// ═══════════════════════════════════════════════════════════════
// FRACMAP CORE (identical to scanner / live-signals)
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
  return { lower, upper, forwardBars };
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
      const entryPrice = bars[position.entryIdx]?.open || bars[Math.min(position.entryIdx, n - 1)].close;
      const exitPrice = bars[Math.min(position.exitIdx, n - 1)].open;
      position.returnPct = position.type === "LONG"
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100;
      position.exitActualIdx = Math.min(position.exitIdx, n - 1);
      signals.push(position);
      position = null;
    }
    if (position) continue;
    let longVotes = 0, shortVotes = 0, maxCyc = 0, maxOrd = 0;
    for (const band of allBands) {
      const lo = band.lower, up = band.upper;
      const w = Math.max(2, Math.round(band.cycle / 6));
      // Long: pierce-and-close on lower band + cusp (isLocalMax = spike up) + priceExtreme
      if (lo[i] !== null) {
        const pierce = bars[i].low < lo[i] && bars[i].close > lo[i];
        const nearTemporal = nearMiss && !pierce && (i > 0 && lo[i-1] !== null &&
          bars[i-1].low < lo[i-1] && bars[i-1].close > lo[i-1]);
        const cusp = isLocalMax(lo, i, w);
        if ((pierce || nearTemporal) && cusp) {
          if (priceExtreme && !isPriceLow(i, w)) { /* skip */ } else {
            longVotes++;
            if (band.cycle > maxCyc) { maxCyc = band.cycle; maxOrd = band.order; }
          }
        }
      }
      // Short: pierce-and-close on upper band + cusp (isLocalMin = spike down) + priceExtreme
      if (up[i] !== null) {
        const pierce = bars[i].high > up[i] && bars[i].close < up[i];
        const nearTemporal = nearMiss && !pierce && (i > 0 && up[i-1] !== null &&
          bars[i-1].high > up[i-1] && bars[i-1].close < up[i-1]);
        const cusp = isLocalMin(up, i, w);
        if ((pierce || nearTemporal) && cusp) {
          if (priceExtreme && !isPriceHigh(i, w)) { /* skip */ } else {
            shortVotes++;
            if (band.cycle > maxCyc) { maxCyc = band.cycle; maxOrd = band.order; }
          }
        }
      }
    }
    const totalVotes = longVotes + shortVotes;
    if (totalVotes < minStrength) continue;
    if (maxCyc < minMaxCycle) continue;
    if (spikeFilter && longVotes > 0 && shortVotes > 0) continue;
    const dir = longVotes >= shortVotes ? "LONG" : "SHORT";
    const hold = Math.max(3, Math.round(maxCyc / holdDivisor));
    position = { type: dir, entryIdx: i + 1, exitIdx: i + 1 + hold, holdDuration: hold, strength: totalVotes, maxCycle: maxCyc, maxOrder: maxOrd };
  }
  if (position) {
    const entryPrice = bars[position.entryIdx]?.open || bars[n - 1].close;
    const exitPrice = bars[n - 1].close;
    position.returnPct = position.type === "LONG"
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;
    position.exitActualIdx = n - 1;
    signals.push(position);
  }
  return signals;
}


// ═══════════════════════════════════════════════════════════════
// REGIME FEATURES — Market properties, NOT strategy-dependent
// Computed once per coin/bar, reused across all strategies
// ═══════════════════════════════════════════════════════════════

function logReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}
function std(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function normalizedSlope(arr) {
  const n = arr.length; if (n < 3) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += arr[i]; sxx += i * i; sxy += i * arr[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const s = std(arr);
  return s > 0 ? slope / s * n : 0;
}
function persistenceFn(closes) {
  let same = 0;
  for (let i = 2; i < closes.length; i++) {
    if ((closes[i] > closes[i - 1]) === (closes[i - 1] > closes[i - 2])) same++;
  }
  return closes.length > 2 ? same / (closes.length - 2) : 0.5;
}
function atrVal(bars, idx) {
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, idx - 13); i <= idx; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    sum += tr; cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}
function hurstExponent(series) {
  const n = series.length; if (n < 30) return 0.5;
  const maxLag = Math.min(40, Math.floor(n / 4)); if (maxLag < 4) return 0.5;
  const logLags = [], logVars = [];
  for (let tau = 2; tau <= maxLag; tau++) {
    const diffs = [];
    for (let i = 0; i < n - tau; i++) diffs.push(series[i + tau] - series[i]);
    const v = std(diffs) ** 2; if (v <= 0) continue;
    logLags.push(Math.log(tau)); logVars.push(Math.log(v));
  }
  if (logLags.length < 3) return 0.5;
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const xM = mean(logLags), yM = mean(logVars);
  let num = 0, den = 0;
  for (let i = 0; i < logLags.length; i++) { const dx = logLags[i] - xM; num += dx * (logVars[i] - yM); den += dx * dx; }
  return den === 0 ? 0.5 : Math.max(0, Math.min(1, (num / den) / 2));
}
function ewmaVol(rets, span) {
  if (rets.length === 0) return 0;
  const lambda = 1 - 2 / (span + 1);
  let ewma = rets[0] ** 2;
  for (let i = 1; i < rets.length; i++) ewma = lambda * ewma + (1 - lambda) * rets[i] ** 2;
  return Math.sqrt(ewma);
}
function volClusterCorr(rets, window) {
  if (rets.length < window * 3) return 0;
  const n = rets.length;
  const w1 = [], w2 = [], w3 = [];
  for (let i = n - window * 3; i < n - window * 2; i++) w1.push(Math.abs(rets[i]));
  for (let i = n - window * 2; i < n - window; i++) w2.push(Math.abs(rets[i]));
  for (let i = n - window; i < n; i++) w3.push(Math.abs(rets[i]));
  const pcorr = (x, y) => {
    if (x.length < 3) return 0;
    const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
    const d = Math.sqrt(dx2 * dy2);
    return d > 0 ? num / d : 0;
  };
  return (pcorr(w1, w2) + pcorr(w2, w3)) / 2;
}

/**
 * Compute regime features at a specific bar index.
 * Pure market property — same regardless of which strategy fires.
 * lookback param adjusts 5d equivalent for different timeframes:
 *   1m = 1440 bars/day × 5 = 7200
 *   1h = 24 bars/day × 5 = 120
 *   1d = 5 bars
 */
function computeRegimeFeaturesAtBar(bars, idx, lookbackBars) {
  if (idx < 60 || idx >= bars.length) return null;
  const c60 = bars.slice(Math.max(0, idx - 60), idx + 1);
  const closes60 = c60.map(b => b.close);
  const rets60 = logReturns(closes60);

  const vol10 = std(rets60.slice(-10));
  const vol60f = std(rets60);
  const volRatio = vol60f > 0 ? vol10 / vol60f : 1;
  const trend60 = normalizedSlope(closes60.map(p => Math.log(p)));
  const pers = persistenceFn(closes60);
  const min60 = Math.min(...closes60), max60 = Math.max(...closes60);
  const posInRange = (max60 - min60) > 0 ? (closes60[closes60.length - 1] - min60) / (max60 - min60) : 0.5;

  const atr60 = atrVal(c60, c60.length - 1);
  const lb = Math.min(lookbackBars, idx);
  const cLong = bars.slice(Math.max(0, idx - lb), idx + 1);
  const closesLong = cLong.map(b => b.close);
  const atrLong = atrVal(cLong, cLong.length - 1);
  const atrCompression = atrLong > 0 ? atr60 / atrLong : 1;

  const retsLong = logReturns(closesLong);
  const ewmaShort = ewmaVol(retsLong.slice(-60), 10);
  const ewmaLong = ewmaVol(retsLong, 60);
  const volRatio5d = ewmaLong > 0 ? ewmaShort / ewmaLong : 1;

  const minLong = Math.min(...closesLong), maxLong = Math.max(...closesLong);
  const posInRange5d = (maxLong - minLong) > 0 ? (closesLong[closesLong.length - 1] - minLong) / (maxLong - minLong) : 0.5;
  const trend5d = normalizedSlope(closesLong.slice(-Math.min(lb, closesLong.length)).map(p => Math.log(p)));

  const hurstSampled = [];
  const hurstRaw = closesLong.length > 512 ? closesLong.slice(-Math.min(4320, closesLong.length)) : closesLong;
  for (let i = 0; i < hurstRaw.length; i += Math.max(1, Math.floor(hurstRaw.length / 300))) hurstSampled.push(hurstRaw[i]);
  if (hurstSampled.length < 30) { for (const v of hurstRaw) hurstSampled.push(v); }
  const hurst = hurstExponent(hurstSampled.map(p => Math.log(Math.max(p, 0.0001))));

  const volCluster = retsLong.length >= 180 ? volClusterCorr(retsLong, 60) : 0;

  const volState = atrCompression < 0.6 ? "COMPRESSED" : atrCompression > 1.4 ? "EXPANDING" : "NORMAL";
  let hourOfDay = 12;
  try { hourOfDay = new Date(bars[idx].time).getUTCHours(); } catch {}

  return { volState, hourOfDay, trend60, persistence: pers, posInRange, volRatio, atrCompression, hurst, volRatio5d, posInRange5d, trend5d, volCluster };
}


// ═══════════════════════════════════════════════════════════════
// REGIME BUCKETING & SHARPE
// ═══════════════════════════════════════════════════════════════

const REGIME_FEATURES = [
  { key: "posInRange", label: "Position in Range", buckets: [
    { label: "Bottom (<0.25)", test: f => f.posInRange < 0.25 },
    { label: "Middle (0.25-0.75)", test: f => f.posInRange >= 0.25 && f.posInRange <= 0.75 },
    { label: "Top (>0.75)", test: f => f.posInRange > 0.75 },
  ]},
  { key: "volState", label: "Vol State", buckets: [
    { label: "COMPRESSED", test: f => f.volState === "COMPRESSED" },
    { label: "NORMAL", test: f => f.volState === "NORMAL" },
    { label: "EXPANDING", test: f => f.volState === "EXPANDING" },
  ]},
  { key: "atrCompression", label: "ATR Compression", buckets: [
    { label: "Compressed (<0.7)", test: f => f.atrCompression < 0.7 },
    { label: "Normal (0.7-1.3)", test: f => f.atrCompression >= 0.7 && f.atrCompression <= 1.3 },
    { label: "Expanding (>1.3)", test: f => f.atrCompression > 1.3 },
  ]},
  { key: "hurst", label: "Hurst Exponent", buckets: [
    { label: "Mean-Rev (<0.45)", test: f => f.hurst < 0.45 },
    { label: "Random (0.45-0.55)", test: f => f.hurst >= 0.45 && f.hurst <= 0.55 },
    { label: "Trending (>0.55)", test: f => f.hurst > 0.55 },
  ]},
  { key: "volRatio5d", label: "1h/1d Vol Ratio", buckets: [
    { label: "Calm (<0.7)", test: f => f.volRatio5d < 0.7 },
    { label: "Normal (0.7-1.3)", test: f => f.volRatio5d >= 0.7 && f.volRatio5d <= 1.3 },
    { label: "Heated (>1.3)", test: f => f.volRatio5d > 1.3 },
  ]},
  { key: "persistence", label: "Persistence", buckets: [
    { label: "Choppy (<0.47)", test: f => f.persistence < 0.47 },
    { label: "Mixed (0.47-0.55)", test: f => f.persistence >= 0.47 && f.persistence <= 0.55 },
    { label: "Clean (>0.55)", test: f => f.persistence > 0.55 },
  ]},
  { key: "trend60", label: "60-bar Trend", buckets: [
    { label: "Down (<-0.3)", test: f => f.trend60 < -0.3 },
    { label: "Flat (-0.3-0.3)", test: f => f.trend60 >= -0.3 && f.trend60 <= 0.3 },
    { label: "Up (>0.3)", test: f => f.trend60 > 0.3 },
  ]},
  { key: "posInRange5d", label: "5d Range Position", buckets: [
    { label: "Bottom (<0.25)", test: f => f.posInRange5d < 0.25 },
    { label: "Middle (0.25-0.75)", test: f => f.posInRange5d >= 0.25 && f.posInRange5d <= 0.75 },
    { label: "Top (>0.75)", test: f => f.posInRange5d > 0.75 },
  ]},
  { key: "trend5d", label: "5-day Trend", buckets: [
    { label: "Bear (<-0.3)", test: f => f.trend5d < -0.3 },
    { label: "Neutral (-0.3-0.3)", test: f => f.trend5d >= -0.3 && f.trend5d <= 0.3 },
    { label: "Bull (>0.3)", test: f => f.trend5d > 0.3 },
  ]},
  { key: "volCluster", label: "Vol Cluster Corr", buckets: [
    { label: "Unstable (<0.2)", test: f => f.volCluster < 0.2 },
    { label: "Moderate (0.2-0.5)", test: f => f.volCluster >= 0.2 && f.volCluster <= 0.5 },
    { label: "Persistent (>0.5)", test: f => f.volCluster > 0.5 },
  ]},
  { key: "volRatio", label: "Vol Ratio 10/60", buckets: [
    { label: "Quiet (<0.7)", test: f => f.volRatio < 0.7 },
    { label: "Normal (0.7-1.3)", test: f => f.volRatio >= 0.7 && f.volRatio <= 1.3 },
    { label: "Spiking (>1.3)", test: f => f.volRatio > 1.3 },
  ]},
  { key: "hour", label: "Hour (UTC)", buckets: [
    { label: "Asia (0-8)", test: f => f.hourOfDay < 8 },
    { label: "Europe (8-15)", test: f => f.hourOfDay >= 8 && f.hourOfDay < 15 },
    { label: "US (15-23)", test: f => f.hourOfDay >= 15 },
  ]},
  { key: "direction", label: "Direction", buckets: [
    { label: "LONG", test: f => f.direction === "LONG" },
    { label: "SHORT", test: f => f.direction === "SHORT" },
  ]},
];

function computeBucketSharpe(signals, barMinutes) {
  if (signals.length < 3) return { sharpe: 0, winRate: 0, avgRet: 0, n: signals.length };
  const rets = signals.map(s => s.returnPct);
  const n = rets.length;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const stdev = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n);
  const avgHold = signals.reduce((s, sig) => s + (sig.holdDuration || 20), 0) / n;
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(525600 / Math.max(1, avgHold * barMinutes)) : 0;
  const winRate = rets.filter(r => r > 0).length / n * 100;
  return { sharpe: +sharpe.toFixed(2), winRate: +winRate.toFixed(1), avgRet: +mean.toFixed(4), n };
}

function rankArray(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
  return ranks;
}

function spearmanRho(ranks1, ranks2) {
  const n = ranks1.length;
  if (n < 2) return null;
  let dSq = 0;
  for (let i = 0; i < n; i++) dSq += (ranks1[i] - ranks2[i]) ** 2;
  return 1 - (6 * dSq) / (n * (n * n - 1));
}


// ═══════════════════════════════════════════════════════════════
// SCORECARD PERSISTENCE
// ═══════════════════════════════════════════════════════════════

async function persistScorecard(client, strat, allTagged, bm) {
  // Delete existing scorecard rows for this strategy/timeframe before inserting fresh
  await client.query(
    `DELETE FROM regime_scorecard WHERE bar_minutes = $1 AND ${strat.id ? 'strategy_id = $2' : 'strategy_id IS NULL'}`,
    strat.id ? [bm, strat.id] : [bm]
  );

  const directionSplits = [
    { label: 'all', sigs: allTagged },
    { label: 'long', sigs: allTagged.filter(s => s.direction === 'LONG') },
    { label: 'short', sigs: allTagged.filter(s => s.direction === 'SHORT') },
  ];

  let rowsWritten = 0;
  for (const split of directionSplits) {
    if (split.sigs.length < 10) continue;
    const splitSorted = [...split.sigs].sort((a, b) => a._barIdx - b._barIdx);
    const splitPoint = splitSorted[Math.floor(splitSorted.length / 2)]._barIdx;
    const isSigs = splitSorted.filter(s => s._barIdx < splitPoint);
    const oosSigs = splitSorted.filter(s => s._barIdx >= splitPoint);

    for (const feat of REGIME_FEATURES) {
      const oosResults = feat.buckets.map(b => ({ label: b.label, ...computeBucketSharpe(oosSigs.filter(s => b.test(s)), bm) }));
      const isResults = feat.buckets.map(b => ({ label: b.label, ...computeBucketSharpe(isSigs.filter(s => b.test(s)), bm) }));

      const oosSharpes = oosResults.filter(b => b.n >= 3).map(b => b.sharpe);
      const spread = oosSharpes.length >= 2 ? Math.max(...oosSharpes) - Math.min(...oosSharpes) : 0;

      let rho = null;
      const validBuckets = feat.buckets.filter((_, i) => isResults[i].n >= 3 && oosResults[i].n >= 3);
      if (validBuckets.length >= 2) {
        const isRanks = rankArray(validBuckets.map((_, i) => isResults[feat.buckets.indexOf(validBuckets[i])].sharpe));
        const oosRanks = rankArray(validBuckets.map((_, i) => oosResults[feat.buckets.indexOf(validBuckets[i])].sharpe));
        rho = spearmanRho(isRanks, oosRanks);
      }

      const minBucketN = Math.min(...isResults.map(b => b.n), ...oosResults.map(b => b.n));
      let confidence = 'insufficient';
      if (minBucketN >= 10 && rho !== null) {
        if (rho >= 0.8) confidence = 'high';
        else if (rho >= 0.4) confidence = 'moderate';
        else if (rho >= 0) confidence = 'low';
        else if (rho >= -0.4) confidence = 'unstable';
        else confidence = 'inverted';
      }

      for (let bi = 0; bi < oosResults.length; bi++) {
        const oos = oosResults[bi];
        const is_ = isResults[bi];
        await client.query(`
          INSERT INTO regime_scorecard
            (strategy_id, strategy_label, feature_key, feature_label, direction_filter,
             bucket_index, bucket_label, oos_sharpe, oos_win_rate, oos_avg_ret, oos_trades,
             is_sharpe, is_trades, spread, rho, confidence, bar_minutes, total_signals, computed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
        `, [
          strat.id, strat.label, feat.key, feat.label, split.label,
          bi, oos.label, oos.sharpe, oos.winRate, oos.avgRet, oos.n,
          is_.sharpe, is_.n, +spread.toFixed(1), rho, confidence, bm, allTagged.length,
        ]);
        rowsWritten++;
      }
    }
  }
  return rowsWritten;
}

async function persistCoinScorecard(client, strat, allTagged, bm) {
  // Delete existing per-coin rows
  await client.query(
    `DELETE FROM regime_scorecard_coins WHERE bar_minutes = $1 AND ${strat.id ? 'strategy_id = $2' : 'strategy_id IS NULL'}`,
    strat.id ? [bm, strat.id] : [bm]
  );

  // Group signals by symbol
  const bySymbol = {};
  for (const sig of allTagged) {
    if (!sig.symbol) continue;
    if (!bySymbol[sig.symbol]) bySymbol[sig.symbol] = [];
    bySymbol[sig.symbol].push(sig);
  }

  let rowsWritten = 0;
  const values = [];
  
  for (const [symbol, sigs] of Object.entries(bySymbol)) {
    if (sigs.length < 5) continue;
    
    for (const dirSplit of [
      { label: 'all', sigs },
      { label: 'long', sigs: sigs.filter(s => s.direction === 'LONG') },
      { label: 'short', sigs: sigs.filter(s => s.direction === 'SHORT') },
    ]) {
      if (dirSplit.sigs.length < 3) continue;
      
      for (const feat of REGIME_FEATURES) {
        for (let bi = 0; bi < feat.buckets.length; bi++) {
          const bucket = feat.buckets[bi];
          const inBucket = dirSplit.sigs.filter(s => bucket.test(s));
          if (inBucket.length < 2) continue;
          
          const metrics = computeBucketSharpe(inBucket, bm);
          values.push([
            strat.id, symbol, feat.key, dirSplit.label, bi, bucket.label,
            metrics.sharpe, metrics.winRate, metrics.avgRet, metrics.n, bm,
          ]);
          rowsWritten++;
        }
      }
    }
  }

  // Batch insert for performance
  for (let i = 0; i < values.length; i += 50) {
    const batch = values.slice(i, i + 50);
    const placeholders = batch.map((_, idx) => {
      const off = idx * 11;
      return `($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9},$${off+10},$${off+11},now())`;
    }).join(',');
    const flat = batch.flat();
    await client.query(`
      INSERT INTO regime_scorecard_coins
        (strategy_id, symbol, feature_key, direction_filter, bucket_index, bucket_label,
         oos_sharpe, oos_win_rate, oos_avg_ret, oos_trades, bar_minutes, computed_at)
      VALUES ${placeholders}
    `, flat);
  }

  return rowsWritten;
}


// ═══════════════════════════════════════════════════════════════
// MAIN AUDIT
// ═══════════════════════════════════════════════════════════════

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS research_log (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      report_type TEXT NOT NULL DEFAULT 'hourly_scan', title TEXT NOT NULL,
      winner_strategy JSONB, oos_avg_sharpe FLOAT, oos_consistency TEXT,
      oos_avg_winrate FLOAT, oos_avg_pf FLOAT, oos_avg_return FLOAT,
      per_coin_oos JSONB, regime_features JSONB, net_position JSONB,
      robustness JSONB, findings TEXT, recommendations TEXT,
      evolution_round INTEGER, committee_decision TEXT, active_filters JSONB,
      bar_minutes INTEGER DEFAULT 1, cycle_min INTEGER, cycle_max INTEGER,
      split_pct INTEGER DEFAULT 50, total_bars INTEGER, total_signals INTEGER
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS regime_scorecard (
      id SERIAL PRIMARY KEY,
      strategy_id TEXT,
      strategy_label TEXT,
      feature_key TEXT NOT NULL,
      feature_label TEXT NOT NULL,
      direction_filter TEXT NOT NULL DEFAULT 'all',
      bucket_index INTEGER NOT NULL,
      bucket_label TEXT NOT NULL,
      oos_sharpe FLOAT,
      oos_win_rate FLOAT,
      oos_avg_ret FLOAT,
      oos_trades INTEGER,
      is_sharpe FLOAT,
      is_trades INTEGER,
      spread FLOAT,
      rho FLOAT,
      confidence TEXT,
      bar_minutes INTEGER NOT NULL,
      total_signals INTEGER,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Per-coin regime scorecard
  await client.query(`
    CREATE TABLE IF NOT EXISTS regime_scorecard_coins (
      id SERIAL PRIMARY KEY,
      strategy_id TEXT,
      symbol TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      direction_filter TEXT NOT NULL DEFAULT 'all',
      bucket_index INTEGER NOT NULL,
      bucket_label TEXT NOT NULL,
      oos_sharpe FLOAT,
      oos_win_rate FLOAT,
      oos_avg_ret FLOAT,
      oos_trades INTEGER,
      bar_minutes INTEGER NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Safe upgrades for existing installs
  const addCol = async (col, type) => { try { await client.query(`ALTER TABLE regime_scorecard ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch {} };
  await addCol('strategy_id', 'INTEGER');
  await addCol('strategy_label', 'TEXT');
  await addCol('total_signals', 'INTEGER');
}

async function runAudit() {
  const startTime = Date.now();
  const client = await pool.connect();
  console.log(`\n[robustness] ═══ Starting audit at ${new Date().toISOString()} ═══`);

  try {
    await ensureTables(client);

    // ── 1. Load ACTIVE strategies from DB ──
    const { rows: dbStrategies } = await client.query(
      `SELECT id, name, type, "barMinutes", symbol, "minStr", "minCyc", spike, "nearMiss",
              "holdDiv", "priceExt", "cycleMin", "cycleMax"
       FROM "FracmapStrategy" WHERE active = true ORDER BY "barMinutes", symbol NULLS FIRST`
    );

    let strategies = [];
    if (dbStrategies.length > 0) {
      strategies = dbStrategies.map(s => ({
        id: s.id,
        label: s.name || `${TF_LABEL[s.barMinutes] || s.barMinutes + 'm'}-${s.type}${s.symbol ? '-' + s.symbol.replace('USDT', '') : ''}`,
        type: s.type || 'universal',
        barMinutes: s.barMinutes,
        table: BAR_TABLE[s.barMinutes] || 'Candle1m',
        symbol: s.symbol || null,
        minStr: s.minStr ?? 1, minCyc: s.minCyc ?? 0, spike: s.spike ?? true,
        nearMiss: s.nearMiss ?? true, holdDiv: s.holdDiv ?? 2, priceExt: s.priceExt ?? false,
        cycleMin: s.cycleMin ?? 5, cycleMax: s.cycleMax ?? 20,
      }));
      console.log(`[robustness] ${strategies.length} active strategies from DB:`);
      for (const s of strategies) console.log(`  · ${s.label} [${TF_LABEL[s.barMinutes]}] ${s.type}${s.symbol ? ' → ' + s.symbol : ''} (×${s.minStr} C≥${s.minCyc} ÷${s.holdDiv} cyc:${s.cycleMin}-${s.cycleMax})`);
    } else {
      console.log(`[robustness] No active strategies in DB — using defaults for 1m/1h/1d`);
      for (const [bm, cfg] of Object.entries(DEFAULT_STRATEGIES)) {
        strategies.push({ id: null, label: `${TF_LABEL[bm]}-default`, type: 'universal', barMinutes: +bm, table: BAR_TABLE[bm], symbol: null, ...cfg });
      }
    }

    // ── 2. Load candle data ONCE per timeframe ──
    const timeframesNeeded = [...new Set(strategies.map(s => s.barMinutes))];
    const candleCache = {}; // { barMinutes: { symbol: bars[] } }
    // Lookback bars for regime 5d context: 1m=7200, 1h=120, 1d=5
    const lookbackMap = { 1: 7200, 60: 120, 1440: 5 };

    for (const bm of timeframesNeeded) {
      const table = BAR_TABLE[bm];
      if (!table) { console.warn(`  ⚠ Unknown barMinutes ${bm}, skipping`); continue; }

      const { rows: symbolRows } = await client.query(`SELECT DISTINCT symbol FROM "${table}" ORDER BY symbol`);
      candleCache[bm] = {};
      let loaded = 0;
      for (const { symbol } of symbolRows) {
        const { rows } = await client.query(
          `SELECT timestamp as time, open, high, low, close FROM "${table}" WHERE symbol=$1 ORDER BY timestamp`,
          [symbol]
        );
        if (rows.length > 200) {
          candleCache[bm][symbol] = rows.map(r => ({ time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close }));
          loaded++;
        }
      }
      console.log(`[robustness] ${TF_LABEL[bm]}: loaded ${loaded} coins, ${symbolRows.length} total in ${table}`);
    }

    // ── 3. Run each strategy ──
    for (const strat of strategies) {
      const stratStart = Date.now();
      const bm = strat.barMinutes;
      const coinData = candleCache[bm];
      if (!coinData || Object.keys(coinData).length === 0) {
        console.warn(`  ⚠ No data for ${TF_LABEL[bm]}, skipping "${strat.label}"`);
        continue;
      }

      const coinList = strat.symbol ? [strat.symbol].filter(s => coinData[s]) : Object.keys(coinData);
      if (coinList.length === 0) {
        console.warn(`  ⚠ No matching coins for "${strat.label}"`);
        continue;
      }

      const perCoinOOS = [];
      const allTagged = [];
      let totalSignals = 0, totalBars = 0, netLongs = 0, netShorts = 0;
      const lb = lookbackMap[bm] || 1440;

      for (const symbol of coinList) {
        const bars = coinData[symbol];
        if (!bars || bars.length < 200) continue;
        totalBars += bars.length;

        const splitIdx = Math.round(bars.length * SPLIT_PCT / 100);
        const oosBars = bars.slice(splitIdx);
        if (oosBars.length < 100) continue;

        // Compute Fracmap bands for THIS strategy's parameters
        const highs = oosBars.map(b => b.high);
        const lows = oosBars.map(b => b.low);
        const allBands = [];
        for (let order = 1; order <= 6; order++) {
          for (let cycle = strat.cycleMin; cycle <= strat.cycleMax; cycle++) {
            allBands.push({ cycle, order, ...computeFracmap(highs, lows, cycle, order) });
          }
        }

        // Detect signals with THIS strategy's parameters
        const sigs = detectEnsembleSignals(oosBars, allBands, strat.minStr, strat.minCyc, strat.spike, strat.holdDiv, strat.nearMiss, strat.priceExt);
        if (sigs.length < 3) continue;

        // Per-coin OOS metrics
        const rets = sigs.map(s => s.returnPct);
        const barsPerDay = bm === 1440 ? 1 : bm === 60 ? 24 : 1440;
        const nDays = Math.max(1, Math.ceil(oosBars.length / barsPerDay));
        const barRets = new Float64Array(oosBars.length);
        for (const sig of sigs) {
          const entry = sig.entryIdx;
          const exit = sig.exitActualIdx || sig.exitIdx || (entry + sig.holdDuration);
          const hold = Math.max(1, exit - entry);
          const perBar = sig.returnPct / hold;
          for (let b = entry; b < exit && b < oosBars.length; b++) barRets[b] += perBar;
        }
        const dailyRets = [];
        for (let d = 0; d < nDays; d++) {
          const s0 = d * barsPerDay, e0 = Math.min(s0 + barsPerDay, oosBars.length);
          let ds = 0; for (let b = s0; b < e0; b++) ds += barRets[b];
          dailyRets.push(ds);
        }
        const dMean = dailyRets.reduce((s, v) => s + v, 0) / dailyRets.length;
        const dStd = Math.sqrt(dailyRets.reduce((s, v) => s + (v - dMean) ** 2, 0) / dailyRets.length);
        const sharpe = dStd > 0 ? (dMean / dStd) * Math.sqrt(365) : 0;
        const totalRet = rets.reduce((s, r) => s + r, 0);
        const winRate = rets.filter(r => r > 0).length / rets.length * 100;
        const gw = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
        const gl = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));
        const pf = gl > 0 ? gw / gl : gw > 0 ? 999 : 0;

        netLongs += sigs.filter(s => s.type === "LONG").length;
        netShorts += sigs.filter(s => s.type === "SHORT").length;

        perCoinOOS.push({
          coin: symbol.replace("USDT", ""), sharpe: +sharpe.toFixed(2), winRate: +winRate.toFixed(1),
          totalRet: +totalRet.toFixed(2), pf: +pf.toFixed(2), trades: sigs.length,
        });

        // Tag signals with MARKET regime features (not strategy-dependent)
        for (const sig of sigs) {
          const regime = computeRegimeFeaturesAtBar(oosBars, sig.entryIdx, lb);
          if (regime) {
            allTagged.push({ ...regime, symbol, direction: sig.type, maxCycle: sig.maxCycle, returnPct: sig.returnPct, holdDuration: sig.holdDuration, _barIdx: sig.entryIdx });
          }
        }
        totalSignals += sigs.length;
      }

      if (allTagged.length < 10) {
        console.log(`  ⚠ "${strat.label}": ${allTagged.length} signals — skipping (need ≥10)`);
        continue;
      }

      perCoinOOS.sort((a, b) => b.sharpe - a.sharpe);
      const posCoins = perCoinOOS.filter(c => c.sharpe > 0).length;
      const avgSharpe = perCoinOOS.reduce((s, c) => s + c.sharpe, 0) / Math.max(perCoinOOS.length, 1);
      const avgWinRate = perCoinOOS.reduce((s, c) => s + c.winRate, 0) / Math.max(perCoinOOS.length, 1);
      const avgPF = perCoinOOS.reduce((s, c) => s + Math.min(c.pf, 10), 0) / Math.max(perCoinOOS.length, 1);

      const stratSec = ((Date.now() - stratStart) / 1000).toFixed(1);
      console.log(`  ✅ "${strat.label}" [${TF_LABEL[bm]}]: ${coinList.length} coins, ${totalSignals} signals, SR ${avgSharpe.toFixed(2)}, ${posCoins}/${perCoinOOS.length} positive (${stratSec}s)`);

      // Store research_log
      const title = `${strat.label} · SR ${avgSharpe.toFixed(2)} · ${posCoins}/${perCoinOOS.length} · ${new Date().toISOString().slice(0, 16)}`;
      const stratConfig = { id: strat.id, label: strat.label, type: strat.type, symbol: strat.symbol, minStr: strat.minStr, minCyc: strat.minCyc, spike: strat.spike, nearMiss: strat.nearMiss, holdDiv: strat.holdDiv, priceExt: strat.priceExt, cycleMin: strat.cycleMin, cycleMax: strat.cycleMax };
      const regimeTable = [];
      // Quick regime summary for research_log (not the full scorecard — that goes in regime_scorecard)
      const sorted = [...allTagged].sort((a, b) => a._barIdx - b._barIdx);
      const splitPt = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]._barIdx : 0;
      const isSigs = sorted.filter(s => s._barIdx < splitPt);
      const oosSigs = sorted.filter(s => s._barIdx >= splitPt);
      for (const feat of REGIME_FEATURES) {
        const oosR = feat.buckets.map(b => ({ label: b.label, ...computeBucketSharpe(oosSigs.filter(s => b.test(s)), bm) }));
        const isR = feat.buckets.map(b => ({ label: b.label, ...computeBucketSharpe(isSigs.filter(s => b.test(s)), bm) }));
        const sh = oosR.filter(b => b.n >= 3).map(b => b.sharpe);
        const sp = sh.length >= 2 ? Math.max(...sh) - Math.min(...sh) : 0;
        regimeTable.push({ feature: feat.label, key: feat.key, spread: +sp.toFixed(1), buckets: oosR, isBuckets: isR });
      }

      await client.query(`
        INSERT INTO research_log (
          report_type, title, winner_strategy, oos_avg_sharpe, oos_consistency,
          oos_avg_winrate, oos_avg_pf, per_coin_oos, regime_features, net_position,
          findings, recommendations, bar_minutes, cycle_min, cycle_max, split_pct, total_bars, total_signals
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      `, [
        "hourly_scan", title, JSON.stringify(stratConfig),
        avgSharpe, `${posCoins}/${perCoinOOS.length}`, avgWinRate, avgPF,
        JSON.stringify(perCoinOOS), JSON.stringify(regimeTable),
        JSON.stringify({ totalLongs: netLongs, totalShorts: netShorts, shortPct: +(netShorts / Math.max(netLongs + netShorts, 1) * 100).toFixed(1) }),
        '', '', bm, strat.cycleMin, strat.cycleMax, SPLIT_PCT, totalBars, totalSignals,
      ]);

      // Persist regime scorecard (all/long/short × all features × all buckets)
      const scRows = await persistScorecard(client, strat, allTagged, bm);
      const coinRows = await persistCoinScorecard(client, strat, allTagged, bm);
      console.log(`    📊 Scorecard: ${scRows} rows written, ${coinRows} per-coin rows`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[robustness] ═══ Audit complete in ${elapsed}s ═══\n`);

  } catch (err) {
    console.error(`[robustness] ❌ Audit failed:`, err.message);
    console.error(err.stack);
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// SCHEDULER
// ═══════════════════════════════════════════════════════════════

console.log(`[robustness] Starting hourly robustness audit cron`);
console.log(`[robustness] Dynamic mode — loads active strategies from FracmapStrategy each run`);
console.log(`[robustness] Regime features computed ONCE per timeframe, shared across strategies`);
console.log(`[robustness] Interval: ${AUDIT_INTERVAL / 60000} min`);

runAudit();
setInterval(runAudit, AUDIT_INTERVAL);

console.log('[robustness] Scheduler running. Ctrl+C to stop.');
