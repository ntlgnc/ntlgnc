/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  UNIVERSE BACKTEST v3 — FAST MODE                                    ║
 * ║                                                                      ║
 * ║  Uses the KNOWN live strategy params (already optimised in scanner)  ║
 * ║  Skips IS optimisation — runs 1 combo per coin instead of 320.      ║
 * ║  Splits data 50/50, runs both halves, compares regime stability.    ║
 * ║  Saves every 20 coins. Supports resume.                             ║
 * ║                                                                      ║
 * ║  Usage: node backend/universe-backtest.cjs                          ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

// ═══════════════════════════════════════════════════════════════
// KNOWN STRATEGY PARAMS — from live-signals.cjs defaults
// ═══════════════════════════════════════════════════════════════

const PHI = 1.6180339887;

const STRATEGIES = [
  {
    barMinutes: 1, table: 'Candle1m', label: '1M', days: 45,
    cycleMin: 10, cycleMax: 100,
    minStr: 1, minCyc: 55, spike: true, nearMiss: true, holdDiv: 4, priceExt: true,
  },
  {
    barMinutes: 60, table: 'Candle1h', label: '1H', days: 460,
    cycleMin: 55, cycleMax: 89,
    minStr: 1, minCyc: 64, spike: true, nearMiss: true, holdDiv: 5, priceExt: true,
  },
  {
    barMinutes: 1440, table: 'Candle1d', label: '1D', days: 2920,
    cycleMin: 2, cycleMax: 12,
    minStr: 1, minCyc: 0, spike: false, nearMiss: false, holdDiv: 2, priceExt: true,
  },
];

const SPLIT_PCT = 50;

// ═══════════════════════════════════════════════════════════════
// SIGNAL ENGINE — Ported verbatim from FracmapScanner.tsx
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
// CALC METRICS — Ported verbatim from FracmapScanner.tsx
// ═══════════════════════════════════════════════════════════════

function calcMetrics(sigs, bm, totalBars) {
  if (sigs.length === 0) return { sharpe: 0, winRate: 0, totalRet: 0, trades: 0, profitFactor: 0 };
  const rets = sigs.map(s => s.returnPct);
  const winRate = rets.filter(r => r > 0).length / rets.length * 100;
  let eq = 1; for (const r of rets) eq *= (1 + r / 100);
  const grossWin = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));

  const nBars = totalBars || (sigs.length > 0
    ? Math.max(...sigs.map(s => (s.exitActualIdx ?? s.exitIdx ?? s.entryIdx + s.holdDuration) + 1))
    : 0);
  const barRets = new Float64Array(nBars);
  for (const sig of sigs) {
    const entry = sig.entryIdx;
    const exit = sig.exitActualIdx ?? sig.exitIdx ?? (entry + sig.holdDuration);
    const hold = Math.max(1, exit - entry);
    const perBar = sig.returnPct / hold;
    for (let b = entry; b < exit && b < nBars; b++) barRets[b] += perBar;
  }

  const barsPerDay = Math.round(1440 / Math.max(1, bm));
  const nDays = Math.max(1, Math.ceil(nBars / barsPerDay));
  const dailyRets = [];
  for (let d = 0; d < nDays; d++) {
    const start = d * barsPerDay;
    const end = Math.min(start + barsPerDay, nBars);
    let daySum = 0;
    for (let b = start; b < end; b++) daySum += barRets[b];
    dailyRets.push(daySum);
  }

  let dSum = 0, dSum2 = 0;
  for (const d of dailyRets) { dSum += d; dSum2 += d * d; }
  const dMean = dSum / dailyRets.length;
  const dVar = dSum2 / dailyRets.length - dMean * dMean;
  const dStd = Math.sqrt(Math.max(0, dVar));
  const sharpe = dStd > 0 ? (dMean / dStd) * Math.sqrt(365) : 0;

  return { sharpe, winRate, totalRet: (eq - 1) * 100, trades: sigs.length, profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0 };
}

// ═══════════════════════════════════════════════════════════════
// REGIME FEATURES — Ported verbatim from RegimeAnalysis.tsx
// ═══════════════════════════════════════════════════════════════

function mean(arr) { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr); return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function logReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}
function normalizedSlope(series) {
  const n = series.length; if (n < 3) return 0;
  const xMean = (n - 1) / 2, yMean = mean(series);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = i - xMean; num += dx * (series[i] - yMean); den += dx * dx; }
  if (den === 0) return 0;
  const slope = num / den, rets = logReturns(series), vol = stdDev(rets);
  return vol === 0 ? 0 : slope / vol;
}
function persistenceFn(closes) {
  if (closes.length < 3) return 0.5;
  const rets = logReturns(closes);
  const dir = Math.sign(closes[closes.length - 1] - closes[0]);
  if (dir === 0) return 0.5;
  return rets.filter(r => Math.sign(r) === dir).length / rets.length;
}
function hurstExponent(series) {
  const n = series.length; if (n < 30) return 0.5;
  const maxLag = Math.min(40, Math.floor(n / 4)); if (maxLag < 4) return 0.5;
  const logLags = [], logVars = [];
  for (let tau = 2; tau <= maxLag; tau++) {
    const diffs = [];
    for (let i = 0; i < n - tau; i++) diffs.push(series[i + tau] - series[i]);
    const v = stdDev(diffs) ** 2; if (v <= 0) continue;
    logLags.push(Math.log(tau)); logVars.push(Math.log(v));
  }
  if (logLags.length < 3) return 0.5;
  const xM = mean(logLags), yM = mean(logVars);
  let num2 = 0, den2 = 0;
  for (let i = 0; i < logLags.length; i++) { const dx = logLags[i] - xM; num2 += dx * (logVars[i] - yM); den2 += dx * dx; }
  return den2 === 0 ? 0.5 : Math.max(0, Math.min(1, (num2 / den2) / 2));
}
function trueRange(c, prevClose) {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}
function atrVal(candles, period) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) trs.push(trueRange(candles[i], candles[i - 1].close));
  return mean(trs.slice(-period));
}
function ewmaVol(rets, span) {
  if (rets.length < 2) return 0;
  const alpha = 2 / (span + 1);
  let v = rets[0] ** 2;
  for (let i = 1; i < rets.length; i++) v = alpha * rets[i] ** 2 + (1 - alpha) * v;
  return Math.sqrt(v);
}
function volClusterCorr(rets, window) {
  if (rets.length < window * 2) return 0;
  const absRets = rets.map(r => Math.abs(r));
  const n = absRets.length - window;
  const x = [], y = [];
  for (let i = 0; i < n; i++) { x.push(absRets[i]); y.push(absRets[i + window]); }
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const den = Math.sqrt(dx2 * dy2);
  return den > 0 ? num / den : 0;
}

function computeFeaturesAtBar(bars, idx, signalMeta) {
  const lookback60 = Math.min(60, idx);
  if (lookback60 < 20) return null;

  const c60 = bars.slice(Math.max(0, idx - 60), idx + 1);
  const c5d = bars.slice(Math.max(0, idx - 1440), idx + 1);
  const closes60 = c60.map(b => b.close);
  const closes5d = c5d.map(b => b.close);
  const rets60 = logReturns(closes60);

  const vol10 = stdDev(rets60.slice(-10));
  const vol60f = stdDev(rets60);
  const volRatio = vol60f > 0 ? vol10 / vol60f : 1;
  const trend60 = normalizedSlope(closes60.map(p => Math.log(p)));
  const persistence60 = persistenceFn(closes60);
  const min60 = Math.min(...closes60), max60 = Math.max(...closes60);
  const posInRange60 = (max60 - min60) > 0 ? (closes60[closes60.length - 1] - min60) / (max60 - min60) : 0.5;

  const hurstSampled = [];
  const hurstRaw = closes5d.length > 512 ? closes5d.slice(-Math.min(4320, closes5d.length)) : closes5d;
  for (let i = 0; i < hurstRaw.length; i += 15) hurstSampled.push(hurstRaw[i]);
  if (hurstRaw.length % 15 !== 1) hurstSampled.push(hurstRaw[hurstRaw.length - 1]);
  const hurst = hurstExponent(hurstSampled.map(p => Math.log(p)));

  const atr60 = atrVal(c60, c60.length - 1);
  const longCandles = c5d.slice(-Math.min(1440, c5d.length));
  const atrLong = atrVal(longCandles, longCandles.length - 1);
  const atrCompression = atrLong > 0 ? atr60 / atrLong : 1;

  const rets5d = logReturns(closes5d);
  const ewma1h = ewmaVol(rets5d.slice(-60), 10);
  const ewma1d = ewmaVol(rets5d.slice(-1440), 60);
  const volRatio5d = ewma1d > 0 ? ewma1h / ewma1d : 1;

  const min5d = Math.min(...closes5d), max5d = Math.max(...closes5d);
  const posInRange5d = (max5d - min5d) > 0 ? (closes5d[closes5d.length - 1] - min5d) / (max5d - min5d) : 0.5;
  const trend5d = normalizedSlope(closes5d.slice(-Math.min(1440, closes5d.length)).map(p => Math.log(p)));
  const vc = rets5d.length >= 180 ? volClusterCorr(rets5d, 60) : 0;

  let hourOfDay = 12;
  try { hourOfDay = new Date(bars[idx].time).getUTCHours(); } catch {}

  return {
    hurst, atrCompression, trend60, persistence60, volRatio, posInRange60,
    trend5d, volCluster: vc, posInRange5d, volRatio5d,
    strength: signalMeta.strength, maxCycle: signalMeta.maxCycle,
    returnPct: signalMeta.returnPct, won: signalMeta.returnPct > 0,
    hourOfDay, direction: signalMeta.type,
  };
}

// ═══════════════════════════════════════════════════════════════
// REGIME FEATURE DEFINITIONS — Ported from RegimeAnalysis.tsx
// ═══════════════════════════════════════════════════════════════

const FEATURES = [
  { key: 'hurst', extract: f => f.hurst, buckets: [
    { label: 'Mean-Rev (<0.45)', test: v => v < 0.45 },
    { label: 'Random (0.45-0.55)', test: v => v >= 0.45 && v <= 0.55 },
    { label: 'Trending (>0.55)', test: v => v > 0.55 },
  ]},
  { key: 'atrCompression', extract: f => f.atrCompression, buckets: [
    { label: 'Compressed (<0.7)', test: v => v < 0.7 },
    { label: 'Normal (0.7-1.3)', test: v => v >= 0.7 && v <= 1.3 },
    { label: 'Expanding (>1.3)', test: v => v > 1.3 },
  ]},
  { key: 'trend60', extract: f => f.trend60, buckets: [
    { label: 'Down (<-0.3)', test: v => v < -0.3 },
    { label: 'Flat (-0.3-0.3)', test: v => v >= -0.3 && v <= 0.3 },
    { label: 'Up (>0.3)', test: v => v > 0.3 },
  ]},
  { key: 'persistence60', extract: f => f.persistence60, buckets: [
    { label: 'Choppy (<0.47)', test: v => v < 0.47 },
    { label: 'Mixed (0.47-0.55)', test: v => v >= 0.47 && v <= 0.55 },
    { label: 'Clean (>0.55)', test: v => v > 0.55 },
  ]},
  { key: 'volRatio', extract: f => f.volRatio, buckets: [
    { label: 'Quiet (<0.7)', test: v => v < 0.7 },
    { label: 'Normal (0.7-1.3)', test: v => v >= 0.7 && v <= 1.3 },
    { label: 'Spiking (>1.3)', test: v => v > 1.3 },
  ]},
  { key: 'posInRange60', extract: f => f.posInRange60, buckets: [
    { label: 'Bottom (<0.25)', test: v => v < 0.25 },
    { label: 'Middle (0.25-0.75)', test: v => v >= 0.25 && v <= 0.75 },
    { label: 'Top (>0.75)', test: v => v > 0.75 },
  ]},
  { key: 'trend5d', extract: f => f.trend5d, buckets: [
    { label: 'Bear (<-0.3)', test: v => v < -0.3 },
    { label: 'Neutral (-0.3-0.3)', test: v => v >= -0.3 && v <= 0.3 },
    { label: 'Bull (>0.3)', test: v => v > 0.3 },
  ]},
  { key: 'volCluster', extract: f => f.volCluster, buckets: [
    { label: 'Unstable (<0.2)', test: v => v < 0.2 },
    { label: 'Moderate (0.2-0.5)', test: v => v >= 0.2 && v <= 0.5 },
    { label: 'Persistent (>0.5)', test: v => v > 0.5 },
  ]},
  { key: 'posInRange5d', extract: f => f.posInRange5d, buckets: [
    { label: 'Bottom (<0.25)', test: v => v < 0.25 },
    { label: 'Middle (0.25-0.75)', test: v => v >= 0.25 && v <= 0.75 },
    { label: 'Top (>0.75)', test: v => v > 0.75 },
  ]},
  { key: 'volRatio5d', extract: f => f.volRatio5d, buckets: [
    { label: 'Calm (<0.7)', test: v => v < 0.7 },
    { label: 'Normal (0.7-1.3)', test: v => v >= 0.7 && v <= 1.3 },
    { label: 'Heated (>1.3)', test: v => v > 1.3 },
  ]},
];

// ═══════════════════════════════════════════════════════════════
// SPEARMAN + BUCKET ANALYSIS
// ═══════════════════════════════════════════════════════════════

function bucketSharpe(signals, bm, totalBars) {
  if (signals.length < 3) return null;
  const rets = signals.map(s => s.returnPct);
  const wins = rets.filter(r => r > 0).length;
  const m = mean(rets);
  const s = stdDev(rets);
  // Annualised from per-trade: approximate trades per year
  const avgHold = 50; // bars approx
  const tradesPerYear = (525600 / Math.max(1, bm)) / avgHold;
  const sharpe = s > 0 ? (m / s) * Math.sqrt(tradesPerYear) : 0;
  return sharpe;
}

function rankArray(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
  return ranks;
}

function spearmanRho(a, b) {
  const n = a.length;
  if (n < 3) return null;
  // If all values are the same in either array, ρ is undefined (no variation)
  const aAllSame = a.every(v => v === a[0]);
  const bAllSame = b.every(v => v === b[0]);
  if (aAllSame || bAllSame) return null;
  const r1 = rankArray(a), r2 = rankArray(b);
  let dSq = 0;
  for (let i = 0; i < n; i++) dSq += (r1[i] - r2[i]) ** 2;
  return +(1 - (6 * dSq) / (n * (n * n - 1))).toFixed(3);
}

function analyseRegime(taggedSignals, bm, totalBars) {
  return FEATURES.map(feat => {
    const bucketed = feat.buckets.map(b => ({
      label: b.label,
      signals: taggedSignals.filter(s => b.test(feat.extract(s))),
    }));
    const sharpes = bucketed.map(b => bucketSharpe(b.signals, bm, totalBars));
    const trades = bucketed.map(b => b.signals.length);
    const validSharpes = sharpes.filter(s => s !== null);
    const spread = validSharpes.length >= 2 ? +(Math.max(...validSharpes) - Math.min(...validSharpes)).toFixed(2) : 0;
    return { key: feat.key, buckets: bucketed.map((b, i) => ({ label: b.label, sharpe: sharpes[i], trades: trades[i] })), spread };
  });
}

function compareIsOos(isRegime, oosRegime) {
  return FEATURES.map((feat, fi) => {
    const isSharpes = isRegime[fi].buckets.map(b => b.sharpe ?? 0);
    const oosSharpes = oosRegime[fi].buckets.map(b => b.sharpe ?? 0);
    return {
      key: feat.key,
      rho: spearmanRho(isSharpes, oosSharpes),
      isSpread: isRegime[fi].spread,
      oosSpread: oosRegime[fi].spread,
      isBuckets: isRegime[fi].buckets,
      oosBuckets: oosRegime[fi].buckets,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  UNIVERSE BACKTEST v3 — FAST (known strategy params)              ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  // Create table
  await client.query(`
    CREATE TABLE IF NOT EXISTS universe_backtest (
      id SERIAL PRIMARY KEY,
      computed_at TIMESTAMPTZ DEFAULT now(),
      symbol TEXT NOT NULL,
      bar_minutes INT NOT NULL,
      is_sharpe FLOAT, is_win_rate FLOAT, is_total_ret FLOAT, is_trades INT,
      oos_sharpe FLOAT, oos_win_rate FLOAT, oos_total_ret FLOAT, oos_trades INT,
      oos_profit_factor FLOAT,
      avg_abs_rho FLOAT, perfect_rho INT, total_features INT,
      regime_comparison JSONB,
      regime_comparison_long JSONB,
      regime_comparison_short JSONB,
      winner_params JSONB,
      UNIQUE(symbol, bar_minutes)
    )
  `);
  // Add columns if they don't exist (for existing tables)
  try { await client.query(`ALTER TABLE universe_backtest ADD COLUMN IF NOT EXISTS regime_comparison_long JSONB`); } catch {}
  try { await client.query(`ALTER TABLE universe_backtest ADD COLUMN IF NOT EXISTS regime_comparison_short JSONB`); } catch {}
  console.log('  ✓ universe_backtest table ready\n');

  async function persistBatch(results, bm, params) {
    for (const c of results) {
      await client.query(`
        INSERT INTO universe_backtest (symbol, bar_minutes, is_sharpe, is_win_rate, is_total_ret, is_trades,
          oos_sharpe, oos_win_rate, oos_total_ret, oos_trades, oos_profit_factor,
          avg_abs_rho, perfect_rho, total_features, regime_comparison, regime_comparison_long, regime_comparison_short, winner_params)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (symbol, bar_minutes) DO UPDATE SET
          computed_at = now(), is_sharpe=$3, is_win_rate=$4, is_total_ret=$5, is_trades=$6,
          oos_sharpe=$7, oos_win_rate=$8, oos_total_ret=$9, oos_trades=$10, oos_profit_factor=$11,
          avg_abs_rho=$12, perfect_rho=$13, total_features=$14, regime_comparison=$15,
          regime_comparison_long=$16, regime_comparison_short=$17, winner_params=$18
      `, [
        c.symbol, bm,
        +c.is.sharpe.toFixed(3), +c.is.winRate.toFixed(1), +c.is.totalRet.toFixed(2), c.is.trades,
        +c.oos.sharpe.toFixed(3), +c.oos.winRate.toFixed(1), +c.oos.totalRet.toFixed(2), c.oos.trades, +c.oos.profitFactor.toFixed(2),
        c.avgAbsRho, c.perfectRho, c.totalFeatures,
        JSON.stringify(c.comparison),
        JSON.stringify(c.comparisonLong || []),
        JSON.stringify(c.comparisonShort || []),
        JSON.stringify(params),
      ]);
    }
  }

  for (const strat of STRATEGIES) {
    const { barMinutes, table, label, days, cycleMin, cycleMax, minStr, minCyc, spike, nearMiss, holdDiv, priceExt } = strat;
    const bm = barMinutes;
    const params = { minStr, minCyc, spike, nearMiss, holdDiv, priceExt, cycleMin, cycleMax };

    console.log(`${'═'.repeat(65)}`);
    console.log(`  ${label} — ${table} — cycles ${cycleMin}–${cycleMax} — ${days} days`);
    console.log(`  Strategy: ×${minStr} C≥${minCyc} ${spike?'⚡':'–'} ${nearMiss?'±':'–'} ÷${holdDiv} PxExt:${priceExt?'ON':'OFF'}`);
    console.log('═'.repeat(65));

    // Resume support
    let alreadyDone = new Set();
    try {
      const { rows: done } = await client.query(`SELECT symbol FROM universe_backtest WHERE bar_minutes = $1`, [bm]);
      alreadyDone = new Set(done.map(r => r.symbol));
      if (alreadyDone.size > 0) console.log(`  ⏩ Resuming: ${alreadyDone.size} coins already done`);
    } catch {}

    // Get list of symbols with enough data (DON'T load all candles at once — OOM on 1m)
    console.log(`  Finding eligible coins...`);
    const { rows: symbolRows } = await client.query(`
      SELECT symbol, COUNT(*) as cnt
      FROM "${table}"
      WHERE timestamp >= NOW() - INTERVAL '${days} days'
      GROUP BY symbol
      HAVING COUNT(*) >= 200
      ORDER BY symbol
    `);

    const allSymbols = symbolRows.map(r => r.symbol);
    const symbols = allSymbols.filter(s => !alreadyDone.has(s));
    console.log(`  ${allSymbols.length} coins with ≥200 bars, ${symbols.length} to process (${alreadyDone.size} skipped)`);

    const batch = [];
    const coinResults = [];
    const startTime = Date.now();

    for (let si = 0; si < symbols.length; si++) {
      const symbol = symbols[si];
      const coinStart = Date.now();

      // Load candles for THIS coin only
      const { rows: rawBars } = await client.query(`
        SELECT timestamp as time, open, high, low, close, volume
        FROM "${table}"
        WHERE symbol = $1 AND timestamp >= NOW() - INTERVAL '${days} days'
        ORDER BY timestamp
      `, [symbol]);
      const bars = rawBars.map(c => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume || 0) }));
      if (bars.length < 200) continue;

      const splitIdx = Math.round(bars.length * SPLIT_PCT / 100);
      const isBars = bars.slice(0, splitIdx);
      const oosBars = bars.slice(splitIdx);
      if (isBars.length < 100 || oosBars.length < 50) continue;

      // Compute bands for IS
      const isHighs = isBars.map(b => b.high), isLows = isBars.map(b => b.low);
      const isBands = [];
      for (let order = 1; order <= 6; order++)
        for (let cycle = cycleMin; cycle <= cycleMax; cycle++)
          isBands.push({ cycle, order, ...computeFracmap(isHighs, isLows, cycle, order) });

      const isSigs = detectEnsembleSignals(isBars, isBands, minStr, minCyc, spike, holdDiv, nearMiss, priceExt);
      const isMetrics = calcMetrics(isSigs, barMinutes, isBars.length);

      // Compute bands for OOS
      const oosHighs = oosBars.map(b => b.high), oosLows = oosBars.map(b => b.low);
      const oosBands = [];
      for (let order = 1; order <= 6; order++)
        for (let cycle = cycleMin; cycle <= cycleMax; cycle++)
          oosBands.push({ cycle, order, ...computeFracmap(oosHighs, oosLows, cycle, order) });

      const oosSigs = detectEnsembleSignals(oosBars, oosBands, minStr, minCyc, spike, holdDiv, nearMiss, priceExt);
      const oosMetrics = calcMetrics(oosSigs, barMinutes, oosBars.length);

      // Tag signals with regime features
      const oosTagged = [];
      for (const sig of oosSigs) { const f = computeFeaturesAtBar(oosBars, sig.entryIdx, sig); if (f) oosTagged.push(f); }
      const isTagged = [];
      for (const sig of isSigs) { const f = computeFeaturesAtBar(isBars, sig.entryIdx, sig); if (f) isTagged.push(f); }

      // Regime analysis per direction: ALL, LONG, SHORT
      function regimeForDirection(oosT, isT, label) {
        const oosFiltered = label === 'ALL' ? oosT : oosT.filter(s => s.direction === label);
        const isFiltered = label === 'ALL' ? isT : isT.filter(s => s.direction === label);
        const oosRegime = analyseRegime(oosFiltered, barMinutes, oosBars.length);
        const isRegime = analyseRegime(isFiltered, barMinutes, isBars.length);
        const comp = compareIsOos(isRegime, oosRegime);
        
        // Add min-bucket confidence to each feature
        for (const feat of comp) {
          const minOosBucket = Math.min(...(feat.oosBuckets || []).map(b => b.trades));
          const minIsBucket = Math.min(...(feat.isBuckets || []).map(b => b.trades));
          const minBucket = Math.min(minOosBucket, minIsBucket);
          feat.confidence = minBucket >= 15 ? 'high' : minBucket >= 5 ? 'low_n' : 'insufficient';
        }
        
        const rhos = comp.map(c => c.rho).filter(r => r !== null);
        const avgAbsRho = rhos.length > 0 ? +(rhos.reduce((s, r) => s + Math.abs(r), 0) / rhos.length).toFixed(3) : null;
        const perfectRho = rhos.filter(r => r === 1.0).length;
        return { comparison: comp, avgAbsRho, perfectRho, totalFeatures: rhos.length, trades: oosFiltered.length };
      }

      const regimeAll = regimeForDirection(oosTagged, isTagged, 'ALL');
      const regimeLong = regimeForDirection(oosTagged, isTagged, 'LONG');
      const regimeShort = regimeForDirection(oosTagged, isTagged, 'SHORT');

      // Debug first coin
      if (si === 0) {
        console.log(`\n  DEBUG ${symbol}: ${oosTagged.length} OOS tagged (${oosTagged.filter(s=>s.direction==='LONG').length}L/${oosTagged.filter(s=>s.direction==='SHORT').length}S), ${isTagged.length} IS tagged`);
        for (const feat of regimeAll.comparison.slice(0, 3)) {
          console.log(`    ${feat.key}: IS=[${feat.isBuckets.map(b => `${b.trades}t/${b.sharpe?.toFixed(1) ?? 'null'}`).join(', ')}] OOS=[${feat.oosBuckets.map(b => `${b.trades}t/${b.sharpe?.toFixed(1) ?? 'null'}`).join(', ')}] ρ=${feat.rho} conf=${feat.confidence}`);
        }
        console.log('');
      }

      const result = {
        symbol, is: isMetrics, oos: oosMetrics,
        avgAbsRho: regimeAll.avgAbsRho, perfectRho: regimeAll.perfectRho, totalFeatures: regimeAll.totalFeatures,
        comparison: regimeAll.comparison,
        comparisonLong: regimeLong.comparison,
        comparisonShort: regimeShort.comparison,
        longTrades: regimeLong.trades,
        shortTrades: regimeShort.trades,
      };
      coinResults.push(result);
      batch.push(result);

      const elapsed = ((Date.now() - coinStart) / 1000).toFixed(1);
      const totalSec = ((Date.now() - startTime) / 1000).toFixed(0);
      const eta = (si + 1) > 0 ? Math.round(((Date.now() - startTime) / (si + 1)) * (symbols.length - si - 1) / 1000) : 0;
      const srStr = oosMetrics.sharpe >= 0 ? `+${oosMetrics.sharpe.toFixed(2)}` : oosMetrics.sharpe.toFixed(2);
      console.log(`  ${si+1}/${symbols.length} ${symbol.replace('USDT','').padEnd(8)} IS:${isSigs.length}t OOS:${oosSigs.length}t SR=${srStr} ρ=${regimeAll.avgAbsRho ?? '—'} ${elapsed}s (${totalSec}s, ETA ~${eta}s)`);

      // Batch persist every 20
      if (batch.length >= 20) {
        console.log(`    💾 Saving ${batch.length} coins...`);
        try { await persistBatch(batch, bm, params); console.log(`    ✓ Saved`); } catch (e) { console.error(`    ✗ ${e.message}`); }
        batch.length = 0;
      }
    }

    // Final batch
    if (batch.length > 0) {
      console.log(`    💾 Saving final ${batch.length} coins...`);
      try { await persistBatch(batch, bm, params); console.log(`    ✓ Saved`); } catch (e) { console.error(`    ✗ ${e.message}`); }
      batch.length = 0;
    }

    // Summary
    coinResults.sort((a, b) => b.oos.sharpe - a.oos.sharpe);
    const withTrades = coinResults.filter(c => c.oos.trades >= 3);
    const profitable = withTrades.filter(c => c.oos.sharpe > 0);
    console.log(`\n  ── ${label} RESULTS: ${coinResults.length} coins ──`);
    console.log(`  ${withTrades.length} with ≥3 OOS trades, ${profitable.length} profitable (${(profitable.length / Math.max(1, withTrades.length) * 100).toFixed(0)}%)`);
    if (withTrades.length > 0) {
      console.log(`  Avg OOS Sharpe: ${mean(withTrades.map(c => c.oos.sharpe)).toFixed(2)}`);
    }
    console.log(`\n  Top 15 by OOS Sharpe:`);
    for (let i = 0; i < Math.min(15, coinResults.length); i++) {
      const c = coinResults[i];
      console.log(`    ${String(i+1).padEnd(3)} ${c.symbol.replace('USDT','').padEnd(10)} IS:${c.is.sharpe.toFixed(2).padStart(6)} OOS:${c.oos.sharpe.toFixed(2).padStart(6)} WR:${c.oos.winRate.toFixed(1).padStart(5)}% ${c.oos.trades}t ρ=${c.avgAbsRho ?? '—'} perfect:${c.perfectRho}/${c.totalFeatures}`);
    }
    console.log('');
  }

  await client.end();
  console.log('✓ Universe backtest complete — results in DB, check localhost:3000/universe');
}

main().catch(err => { console.error('✗ FATAL:', err.message); process.exit(1); });
