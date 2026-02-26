"use client";

import React, { useState, useMemo } from "react";

const GOLD = "#D4A843";

// ═══════════════════════════════════════════════════════════════════
// Feature computation — ported from metrics.js for client-side use
// ═══════════════════════════════════════════════════════════════════

function mean(arr: number[]) { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr: number[]) {
  if (arr.length < 2) return 0;
  const m = mean(arr); return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function logReturns(closes: number[]) {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

function normalizedSlope(series: number[]) {
  const n = series.length; if (n < 3) return 0;
  const xMean = (n - 1) / 2, yMean = mean(series);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = i - xMean; num += dx * (series[i] - yMean); den += dx * dx; }
  if (den === 0) return 0;
  const slope = num / den, rets = logReturns(series), vol = std(rets);
  return vol === 0 ? 0 : slope / vol;
}

function persistence(closes: number[]) {
  if (closes.length < 3) return 0.5;
  const rets = logReturns(closes);
  const dir = Math.sign(closes[closes.length - 1] - closes[0]);
  if (dir === 0) return 0.5;
  return rets.filter(r => Math.sign(r) === dir).length / rets.length;
}

function hurstExponent(series: number[]) {
  const n = series.length; if (n < 30) return 0.5;
  const maxLag = Math.min(40, Math.floor(n / 4)); if (maxLag < 4) return 0.5;
  const logLags: number[] = [], logVars: number[] = [];
  for (let tau = 2; tau <= maxLag; tau++) {
    const diffs: number[] = [];
    for (let i = 0; i < n - tau; i++) diffs.push(series[i + tau] - series[i]);
    const v = std(diffs) ** 2; if (v <= 0) continue;
    logLags.push(Math.log(tau)); logVars.push(Math.log(v));
  }
  if (logLags.length < 3) return 0.5;
  const xM = mean(logLags), yM = mean(logVars);
  let num = 0, den = 0;
  for (let i = 0; i < logLags.length; i++) { const dx = logLags[i] - xM; num += dx * (logVars[i] - yM); den += dx * dx; }
  return den === 0 ? 0.5 : Math.max(0, Math.min(1, (num / den) / 2));
}

function trueRange(c: any, prevClose: number) {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

function atrVal(candles: any[], period: number) {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) trs.push(trueRange(candles[i], candles[i - 1].close));
  return mean(trs.slice(-period));
}

function ewmaVol(rets: number[], span: number) {
  if (rets.length === 0) return 0;
  const lambda = 1 - 2 / (span + 1);
  let ewma = rets[0] ** 2;
  for (let i = 1; i < rets.length; i++) ewma = lambda * ewma + (1 - lambda) * rets[i] ** 2;
  return Math.sqrt(ewma);
}

function volClusterCorr(rets: number[], window: number) {
  if (rets.length < window * 3) return 0;
  const w1: number[] = [], w2: number[] = [], w3: number[] = [];
  const n = rets.length;
  for (let i = n - window * 3; i < n - window * 2; i++) w1.push(Math.abs(rets[i]));
  for (let i = n - window * 2; i < n - window; i++) w2.push(Math.abs(rets[i]));
  for (let i = n - window; i < n; i++) w3.push(Math.abs(rets[i]));
  const c12 = pearsonCorr(w1, w2), c23 = pearsonCorr(w2, w3);
  return (c12 + c23) / 2;
}

function pearsonCorr(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < 3) return 0;
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const d = Math.sqrt(dx2 * dy2);
  return d > 0 ? num / d : 0;
}

// ═══════════════════════════════════════════════════════════════════
// Compute all features at a specific bar index given the full bar array
// Uses lookback windows relative to that bar
// ═══════════════════════════════════════════════════════════════════

type BarFeatures = {
  // Micro (60-bar)
  vol10: number; vol20: number; vol60: number; volRatio: number;
  trend60: number; persistence60: number; posInRange60: number;
  // Regime (longer window)
  hurst: number; atrCompression: number; volRatio5d: number;
  trend5d: number; volCluster: number; posInRange5d: number;
  // Classification
  regime: string; direction: string; volState: string;
  // Signal metadata
  signalDir: string; strength: number; maxCycle: number;
  returnPct: number; won: boolean;
  // Derived
  hourOfDay: number; signalDensity: number;
};

function computeFeaturesAtBar(bars: any[], idx: number, signalMeta: any, recentSignalCount: number): BarFeatures | null {
  // Need at least 1440 bars before this index for full features
  const lookback60 = Math.min(60, idx);
  const lookback5d = Math.min(1440, idx);
  if (lookback60 < 20) return null;

  const c60 = bars.slice(Math.max(0, idx - 60), idx + 1);
  const c5d = bars.slice(Math.max(0, idx - 1440), idx + 1);
  const closes60 = c60.map((b: any) => b.close);
  const closes5d = c5d.map((b: any) => b.close);
  const rets60 = logReturns(closes60);

  // Micro features
  const vol10 = std(rets60.slice(-10));
  const vol20 = std(rets60.slice(-20));
  const vol60f = std(rets60);
  const volRatio = vol60f > 0 ? vol10 / vol60f : 1;
  const trend60 = normalizedSlope(closes60.map(p => Math.log(p)));
  const persistence60 = persistence(closes60);
  const min60 = Math.min(...closes60), max60 = Math.max(...closes60);
  const posInRange60 = (max60 - min60) > 0 ? (closes60[closes60.length - 1] - min60) / (max60 - min60) : 0.5;

  // 5d features
  const hurstSampled: number[] = [];
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

  // Regime classification
  const isTrend = Math.abs(trend60) > 0.4 && persistence60 > 0.60 && hurst > 0.52;
  const isRange = Math.abs(trend60) < 0.15 && hurst < 0.48;
  let regime = isTrend ? "TREND" : isRange ? "RANGE" : "TRANSITION";
  let direction = isTrend ? (trend60 > 0 ? "UP" : "DOWN") : Math.abs(trend60) > 0.2 ? (trend60 > 0 ? "UP" : "DOWN") : "NONE";
  let volState = atrCompression < 0.6 ? "COMPRESSED" : atrCompression > 1.4 ? "EXPANDING" : "NORMAL";

  // Time of day from bar timestamp
  let hourOfDay = 12;
  try { hourOfDay = new Date(bars[idx].time).getUTCHours(); } catch {}

  return {
    vol10, vol20, vol60: vol60f, volRatio,
    trend60, persistence60, posInRange60,
    hurst, atrCompression, volRatio5d,
    trend5d, volCluster: vc, posInRange5d,
    regime, direction, volState,
    signalDir: signalMeta.type,
    strength: signalMeta.strength,
    maxCycle: signalMeta.maxCycle,
    returnPct: signalMeta.returnPct,
    won: signalMeta.returnPct > 0,
    hourOfDay,
    signalDensity: recentSignalCount,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Feature definitions for the analysis grid
// ═══════════════════════════════════════════════════════════════════

type FeatureDef = {
  key: string;
  label: string;
  desc: string;
  extract: (f: BarFeatures) => number;
  buckets: { label: string; test: (v: number) => boolean }[];
  isCategorical?: boolean;
};

const FEATURES: FeatureDef[] = [
  {
    key: "hurst", label: "Hurst Exponent", desc: "Mean-reverting (<0.45) vs trending (>0.55)",
    extract: f => f.hurst,
    buckets: [
      { label: "Mean-Rev (<0.45)", test: v => v < 0.45 },
      { label: "Random (0.45–0.55)", test: v => v >= 0.45 && v <= 0.55 },
      { label: "Trending (>0.55)", test: v => v > 0.55 },
    ],
  },
  {
    key: "atrCompression", label: "ATR Compression", desc: "Volatility squeeze (<0.6) vs expansion (>1.4)",
    extract: f => f.atrCompression,
    buckets: [
      { label: "Compressed (<0.7)", test: v => v < 0.7 },
      { label: "Normal (0.7–1.3)", test: v => v >= 0.7 && v <= 1.3 },
      { label: "Expanding (>1.3)", test: v => v > 1.3 },
    ],
  },
  {
    key: "trend60", label: "60-bar Trend", desc: "Slope of price relative to noise",
    extract: f => f.trend60,
    buckets: [
      { label: "Down (<-0.3)", test: v => v < -0.3 },
      { label: "Flat (-0.3–0.3)", test: v => v >= -0.3 && v <= 0.3 },
      { label: "Up (>0.3)", test: v => v > 0.3 },
    ],
  },
  {
    key: "persistence60", label: "Persistence", desc: "Directional consistency (choppy <0.45 vs clean >0.6)",
    extract: f => f.persistence60,
    buckets: [
      { label: "Choppy (<0.47)", test: v => v < 0.47 },
      { label: "Mixed (0.47–0.55)", test: v => v >= 0.47 && v <= 0.55 },
      { label: "Clean (>0.55)", test: v => v > 0.55 },
    ],
  },
  {
    key: "volRatio", label: "Vol Ratio (10/60)", desc: "Short-term vol vs medium-term vol",
    extract: f => f.volRatio,
    buckets: [
      { label: "Quiet (<0.7)", test: v => v < 0.7 },
      { label: "Normal (0.7–1.3)", test: v => v >= 0.7 && v <= 1.3 },
      { label: "Spiking (>1.3)", test: v => v > 1.3 },
    ],
  },
  {
    key: "posInRange60", label: "Position in Range", desc: "Where price sits in 60-bar range",
    extract: f => f.posInRange60,
    buckets: [
      { label: "Bottom (<0.25)", test: v => v < 0.25 },
      { label: "Middle (0.25–0.75)", test: v => v >= 0.25 && v <= 0.75 },
      { label: "Top (>0.75)", test: v => v > 0.75 },
    ],
  },
  {
    key: "trend5d", label: "5-day Trend", desc: "Longer-term price direction",
    extract: f => f.trend5d,
    buckets: [
      { label: "Bear (<-0.3)", test: v => v < -0.3 },
      { label: "Neutral (-0.3–0.3)", test: v => v >= -0.3 && v <= 0.3 },
      { label: "Bull (>0.3)", test: v => v > 0.3 },
    ],
  },
  {
    key: "volCluster", label: "Vol Cluster Corr", desc: "Volatility regime persistence",
    extract: f => f.volCluster,
    buckets: [
      { label: "Unstable (<0.2)", test: v => v < 0.2 },
      { label: "Moderate (0.2–0.5)", test: v => v >= 0.2 && v <= 0.5 },
      { label: "Persistent (>0.5)", test: v => v > 0.5 },
    ],
  },
  {
    key: "posInRange5d", label: "5d Range Position", desc: "Where price sits in 5-day range",
    extract: f => f.posInRange5d,
    buckets: [
      { label: "Bottom (<0.25)", test: v => v < 0.25 },
      { label: "Middle (0.25–0.75)", test: v => v >= 0.25 && v <= 0.75 },
      { label: "Top (>0.75)", test: v => v > 0.75 },
    ],
  },
  {
    key: "volRatio5d", label: "1h/1d Vol Ratio", desc: "Short vs long EWMA volatility",
    extract: f => f.volRatio5d,
    buckets: [
      { label: "Calm (<0.7)", test: v => v < 0.7 },
      { label: "Normal (0.7–1.3)", test: v => v >= 0.7 && v <= 1.3 },
      { label: "Heated (>1.3)", test: v => v > 1.3 },
    ],
  },
  {
    key: "strength", label: "Signal Strength", desc: "Number of bands triggering",
    extract: f => f.strength,
    buckets: [
      { label: "Low (3–5)", test: v => v <= 5 },
      { label: "Medium (6–10)", test: v => v >= 6 && v <= 10 },
      { label: "High (>10)", test: v => v > 10 },
    ],
  },
  {
    key: "maxCycle", label: "Max Trigger Cycle", desc: "Highest cycle in the signal",
    extract: f => f.maxCycle,
    buckets: [
      { label: "Short (55–70)", test: v => v <= 70 },
      { label: "Medium (71–90)", test: v => v > 70 && v <= 90 },
      { label: "Long (>90)", test: v => v > 90 },
    ],
  },
  {
    key: "hourOfDay", label: "Hour (UTC)", desc: "Time-of-day effect",
    extract: f => f.hourOfDay,
    buckets: [
      { label: "Asia (0–8)", test: v => v < 8 },
      { label: "Europe (8–15)", test: v => v >= 8 && v < 15 },
      { label: "US (15–23)", test: v => v >= 15 },
    ],
  },
  {
    key: "regime", label: "Regime", desc: "TREND / RANGE / TRANSITION",
    extract: f => f.regime === "TREND" ? 0 : f.regime === "RANGE" ? 1 : 2,
    buckets: [
      { label: "TREND", test: v => v === 0 },
      { label: "RANGE", test: v => v === 1 },
      { label: "TRANSITION", test: v => v === 2 },
    ],
    isCategorical: true,
  },
  {
    key: "volState", label: "Vol State", desc: "COMPRESSED / NORMAL / EXPANDING",
    extract: f => f.volState === "COMPRESSED" ? 0 : f.volState === "NORMAL" ? 1 : 2,
    buckets: [
      { label: "COMPRESSED", test: v => v === 0 },
      { label: "NORMAL", test: v => v === 1 },
      { label: "EXPANDING", test: v => v === 2 },
    ],
    isCategorical: true,
  },
  {
    key: "signalDir", label: "Direction", desc: "LONG vs SHORT performance",
    extract: f => f.signalDir === "LONG" ? 0 : 1,
    buckets: [
      { label: "LONG", test: v => v === 0 },
      { label: "SHORT", test: v => v === 1 },
    ],
    isCategorical: true,
  },
];

// ═══════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════

type TaggedSignal = BarFeatures;

type Props = {
  coinBarData: Record<string, any[]>;  // symbol → OOS bars[]
  oosSignals: Record<string, any[]>;   // symbol → OOS signals[]
  isBarData?: Record<string, any[]>;   // symbol → IS bars[]
  isSignals?: Record<string, any[]>;   // symbol → IS signals[]
  barMinutes: number;
};

function calcBucketMetrics(signals: TaggedSignal[], barMinutes: number) {
  if (signals.length === 0) return { trades: 0, winRate: 0, avgRet: 0, sharpe: 0, profitFactor: 0 };
  const rets = signals.map(s => s.returnPct);
  const wins = rets.filter(r => r > 0).length;
  const grossWin = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const m = mean(rets), s = std(rets);
  // Annualised from per-trade: approximate trades per year
  const avgHold = 50; // bars approx
  const tradesPerYear = (525600 / barMinutes) / avgHold;
  const sharpe = s > 0 ? (m / s) * Math.sqrt(tradesPerYear) : 0;
  return {
    trades: signals.length,
    winRate: (wins / signals.length) * 100,
    avgRet: m,
    sharpe,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
  };
}

export default function RegimeAnalysis({ coinBarData, oosSignals, isBarData, isSignals, barMinutes }: Props) {
  const [running, setRunning] = useState(false);
  const [taggedSignals, setTaggedSignals] = useState<TaggedSignal[]>([]);
  const [isTaggedSignals, setIsTaggedSignals] = useState<TaggedSignal[]>([]);
  const [sortBy, setSortBy] = useState<"spread" | "bestSR" | "worstSR" | "trades" | "stability">("spread");
  const [showLongShort, setShowLongShort] = useState<"all" | "long" | "short">("all");
  const [showStability, setShowStability] = useState(false);

  // Tag signals with features for a given dataset
  const tagSignals = (sigMap: Record<string, any[]>, barMap: Record<string, any[]>) => {
    const tagged: TaggedSignal[] = [];
    for (const [symbol, signals] of Object.entries(sigMap)) {
      const bars = barMap[symbol];
      if (!bars || bars.length < 100) continue;
      const sigTimes = signals.map((s: any) => s.entryIdx);
      for (let si = 0; si < signals.length; si++) {
        const sig = signals[si];
        const idx = sig.entryIdx;
        if (idx < 60 || idx >= bars.length) continue;
        const density = sigTimes.filter((t: number) => t >= idx - 200 && t < idx).length;
        const features = computeFeaturesAtBar(bars, idx, sig, density);
        if (features) tagged.push(features);
      }
    }
    return tagged;
  };

  // Run the regime analysis
  const runAnalysis = () => {
    setRunning(true);
    // Tag OOS signals
    const oosTagged = tagSignals(oosSignals, coinBarData);
    setTaggedSignals(oosTagged);
    // Tag IS signals if available
    if (isSignals && isBarData && Object.keys(isSignals).length > 0) {
      const isTagged = tagSignals(isSignals, isBarData);
      setIsTaggedSignals(isTagged);
    } else {
      setIsTaggedSignals([]);
    }
    setRunning(false);
  };

  // Filter by direction
  const filtered = useMemo(() => {
    if (showLongShort === "long") return taggedSignals.filter(s => s.signalDir === "LONG");
    if (showLongShort === "short") return taggedSignals.filter(s => s.signalDir === "SHORT");
    return taggedSignals;
  }, [taggedSignals, showLongShort]);

  // Compute grid: for each feature, compute metrics per bucket
  const grid = useMemo(() => {
    if (filtered.length === 0) return [];

    return FEATURES.map(feat => {
      const bucketResults = feat.buckets.map(bucket => {
        const inBucket = filtered.filter(s => bucket.test(feat.extract(s)));
        return { ...bucket, metrics: calcBucketMetrics(inBucket, barMinutes), signals: inBucket };
      });
      const sharpes = bucketResults.map(b => b.metrics.sharpe);
      const spread = Math.max(...sharpes) - Math.min(...sharpes);
      const best = Math.max(...sharpes);
      const worst = Math.min(...sharpes);
      const totalTrades = bucketResults.reduce((s, b) => s + b.metrics.trades, 0);
      return { ...feat, bucketResults, spread, best, worst, totalTrades };
    });
  }, [filtered, barMinutes]);

  // ═══ STABILITY ANALYSIS: Spearman ρ between IS and OOS bucket rankings ═══
  const stability = useMemo(() => {
    if (isTaggedSignals.length === 0 || filtered.length === 0) return [];

    const isFiltered = showLongShort === "long" ? isTaggedSignals.filter(s => s.signalDir === "LONG")
      : showLongShort === "short" ? isTaggedSignals.filter(s => s.signalDir === "SHORT")
      : isTaggedSignals;

    return FEATURES.map(feat => {
      // Compute bucket Sharpes for IS
      const isBuckets = feat.buckets.map(bucket => {
        const inBucket = isFiltered.filter(s => bucket.test(feat.extract(s)));
        return { label: bucket.label, sharpe: calcBucketMetrics(inBucket, barMinutes).sharpe, n: inBucket.length };
      });
      // Compute bucket Sharpes for OOS
      const oosBuckets = feat.buckets.map(bucket => {
        const inBucket = filtered.filter(s => bucket.test(feat.extract(s)));
        return { label: bucket.label, sharpe: calcBucketMetrics(inBucket, barMinutes).sharpe, n: inBucket.length };
      });

      // Spearman ρ: rank correlation of bucket Sharpes
      const n = isBuckets.length;
      if (n < 2) return { key: feat.key, label: feat.label, rho: 0, isN: 0, oosN: 0, isBuckets, oosBuckets, confidence: "insufficient" as const };

      // Rank IS and OOS Sharpes
      const rankArr = (arr: number[]) => {
        const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
        const ranks = new Array(arr.length);
        for (let i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
        return ranks;
      };
      const isRanks = rankArr(isBuckets.map(b => b.sharpe));
      const oosRanks = rankArr(oosBuckets.map(b => b.sharpe));

      let d2sum = 0;
      for (let i = 0; i < n; i++) d2sum += (isRanks[i] - oosRanks[i]) ** 2;
      const rho = 1 - (6 * d2sum) / (n * (n * n - 1));

      const isN = isBuckets.reduce((s, b) => s + b.n, 0);
      const oosN = oosBuckets.reduce((s, b) => s + b.n, 0);

      // Confidence classification
      const minBucketN = Math.min(...isBuckets.map(b => b.n), ...oosBuckets.map(b => b.n));
      let confidence: "high" | "moderate" | "low" | "unstable" | "inverted" | "insufficient";
      if (minBucketN < 10) confidence = "insufficient";
      else if (rho >= 0.8) confidence = "high";
      else if (rho >= 0.4) confidence = "moderate";
      else if (rho >= 0) confidence = "low";
      else if (rho >= -0.4) confidence = "unstable";
      else confidence = "inverted";

      return { key: feat.key, label: feat.label, rho, isN, oosN, isBuckets, oosBuckets, confidence };
    });
  }, [filtered, isTaggedSignals, showLongShort, barMinutes]);
  const sortedGrid = useMemo(() => {
    const g = [...grid];
    if (sortBy === "spread") g.sort((a, b) => b.spread - a.spread);
    else if (sortBy === "bestSR") g.sort((a, b) => b.best - a.best);
    else if (sortBy === "worstSR") g.sort((a, b) => a.worst - b.worst);
    else if (sortBy === "stability") {
      g.sort((a, b) => {
        const sa = stability.find(s => s.key === a.key)?.rho ?? -2;
        const sb = stability.find(s => s.key === b.key)?.rho ?? -2;
        return sb - sa;
      });
    }
    else g.sort((a, b) => b.totalTrades - a.totalTrades);
    return g;
  }, [grid, sortBy, stability]);

  // Color helpers
  const rhoColor = (rho: number) => rho >= 0.8 ? "#22c55e" : rho >= 0.4 ? "#86efac" : rho >= 0 ? "#eab308" : rho >= -0.4 ? "#fca5a5" : "#ef4444";
  const confidenceColor = (c: string) => c === "high" ? "#22c55e" : c === "moderate" ? "#86efac" : c === "low" ? "#eab308" : c === "unstable" ? "#fca5a5" : c === "inverted" ? "#ef4444" : "#666";
  const confidenceIcon = (c: string) => c === "high" ? "✅" : c === "moderate" ? "🟡" : c === "low" ? "⚠️" : c === "unstable" ? "🔴" : c === "inverted" ? "⛔" : "❓";
  const srColor = (sr: number) => sr > 2 ? "#22c55e" : sr > 0.5 ? "#86efac" : sr > 0 ? "#a3a3a3" : sr > -1 ? "#fca5a5" : "#ef4444";
  const wrColor = (wr: number) => wr > 60 ? "#22c55e" : wr > 52 ? "#86efac" : wr > 48 ? "#a3a3a3" : "#ef4444";
  const srBg = (sr: number) => {
    const intensity = Math.min(Math.abs(sr) / 5, 1) * 0.25;
    return sr > 0 ? `rgba(34,197,94,${intensity})` : `rgba(239,68,68,${intensity})`;
  };

  const hasData = Object.keys(coinBarData).length > 0 && Object.keys(oosSignals).length > 0;

  return (
    <div className="bg-[var(--bg-card)] border-2 rounded-lg p-4" style={{ borderColor: "#06b6d460" }}>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-[11px] font-mono font-bold" style={{ color: "#06b6d4" }}>🧬 REGIME ANALYSIS — Feature × Performance Breakdown</span>
        <button
          onClick={runAnalysis}
          disabled={running || !hasData}
          className="px-3 py-1 rounded text-[10px] font-mono font-bold transition-all disabled:opacity-40"
          style={{ background: "#06b6d4", color: "#000" }}
        >
          {running ? "⏳ Analysing..." : taggedSignals.length > 0 ? "↻ Re-run" : "▶ Run Analysis"}
        </button>
        {taggedSignals.length > 0 && (
          <>
            <span className="text-[9px] font-mono text-[var(--text-dim)]">{taggedSignals.length} signals tagged with {FEATURES.length} features</span>
            <div className="flex gap-px rounded overflow-hidden border border-[var(--border)] ml-auto">
              {(["all", "long", "short"] as const).map(m => (
                <button key={m} onClick={() => setShowLongShort(m)}
                  className="px-2 py-0.5 text-[9px] font-mono"
                  style={{ background: showLongShort === m ? "rgba(6,182,212,0.12)" : "transparent", color: showLongShort === m ? "#06b6d4" : "var(--text-dim)" }}>
                  {m === "all" ? "All" : m === "long" ? "▲ Long" : "▼ Short"}
                </button>
              ))}
            </div>
            <div className="flex gap-px rounded overflow-hidden border border-[var(--border)]">
              {(["spread", "bestSR", "worstSR", "trades", "stability"] as const).map(m => (
                <button key={m} onClick={() => setSortBy(m)}
                  className="px-2 py-0.5 text-[9px] font-mono"
                  style={{ background: sortBy === m ? "rgba(6,182,212,0.12)" : "transparent", color: sortBy === m ? "#06b6d4" : "var(--text-dim)" }}>
                  {m === "spread" ? "↕ Spread" : m === "bestSR" ? "↑ Best" : m === "worstSR" ? "↓ Worst" : m === "stability" ? "🔗 Stable" : "# Trades"}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {!hasData && (
        <div className="text-[10px] font-mono text-[var(--text-dim)] py-4 text-center">
          Run a scanner first — regime analysis uses the OOS signal data
        </div>
      )}

      {taggedSignals.length > 0 && (
        <>
          {/* Overall summary */}
          <div className="flex gap-6 p-3 rounded-lg border border-[var(--border)] mb-3" style={{ background: "rgba(6,182,212,0.04)" }}>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Signals Analysed</div>
              <div className="text-sm font-mono font-bold text-[var(--text)]">{filtered.length}</div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Overall Win %</div>
              <div className="text-sm font-mono font-bold" style={{ color: wrColor(filtered.filter(s => s.won).length / filtered.length * 100) }}>
                {(filtered.filter(s => s.won).length / filtered.length * 100).toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Avg Return</div>
              <div className="text-sm font-mono font-bold" style={{ color: mean(filtered.map(s => s.returnPct)) > 0 ? "#22c55e" : "#ef4444" }}>
                {mean(filtered.map(s => s.returnPct)).toFixed(3)}%
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Longs / Shorts</div>
              <div className="text-sm font-mono font-bold text-[var(--text)]">
                {filtered.filter(s => s.signalDir === "LONG").length} / {filtered.filter(s => s.signalDir === "SHORT").length}
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Features Tested</div>
              <div className="text-sm font-mono font-bold" style={{ color: "#06b6d4" }}>{FEATURES.length}</div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Most Predictive</div>
              <div className="text-sm font-mono font-bold" style={{ color: GOLD }}>
                {sortedGrid[0]?.label || "–"}
              </div>
            </div>
          </div>

          {/* Feature × Bucket grid */}
          <div className="overflow-x-auto">
            <table className="w-full text-[9px] font-mono border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="py-1.5 px-2 text-left text-[var(--text-dim)] font-normal w-[140px]">Feature</th>
                  <th className="py-1.5 px-1 text-center text-[var(--text-dim)] font-normal w-[50px]">Spread</th>
                  {stability.length > 0 && <th className="py-1.5 px-1 text-center font-normal w-[50px]" style={{ color: "#a78bfa" }}>ρ IS→OOS</th>}
                  {[0, 1, 2].map(i => (
                    <th key={i} colSpan={4} className="py-1.5 px-1 text-center font-normal" style={{ color: "#06b6d4", borderLeft: "1px solid var(--border)" }}>
                      Bucket {i + 1}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-[var(--border)] text-white/30">
                  <th className="py-1 px-2 text-left font-normal"></th>
                  <th className="py-1 px-1 text-center font-normal">ΔSR</th>
                  {stability.length > 0 && <th className="py-1 px-1 text-center font-normal" style={{ color: "#a78bfa" }}>ρ</th>}
                  {[0, 1, 2].map(i => (
                    <React.Fragment key={i}>
                      <th className="py-1 px-1 text-center font-normal" style={{ borderLeft: "1px solid var(--border)" }}>n</th>
                      <th className="py-1 px-1 text-center font-normal">SR</th>
                      <th className="py-1 px-1 text-center font-normal">Win%</th>
                      <th className="py-1 px-1 text-center font-normal">AvgR</th>
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedGrid.map(feat => (
                  <tr key={feat.key} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="py-1.5 px-2">
                      <div className="font-semibold text-[var(--text)]">{feat.label}</div>
                      <div className="text-white/25 text-[8px]">{feat.desc}</div>
                    </td>
                    <td className="py-1.5 px-1 text-center font-bold" style={{ color: feat.spread > 3 ? "#06b6d4" : feat.spread > 1.5 ? "#22c55e" : "var(--text-dim)" }}>
                      {feat.spread.toFixed(1)}
                    </td>
                    {stability.length > 0 && (() => {
                      const s = stability.find(s => s.key === feat.key);
                      if (!s) return <td className="py-1.5 px-1 text-center">–</td>;
                      return <td className="py-1.5 px-1 text-center font-bold tabular-nums" title={`${s.confidence} confidence`} style={{ color: rhoColor(s.rho) }}>
                        {s.confidence === "insufficient" ? "n/a" : s.rho.toFixed(2)} <span className="text-[7px]">{confidenceIcon(s.confidence)}</span>
                      </td>;
                    })()}
                    {/* Render up to 3 buckets — pad with empty cells if fewer */}
                    {[0, 1, 2].map(bi => {
                      const bucket = feat.bucketResults[bi];
                      if (!bucket) {
                        return (
                          <React.Fragment key={bi}>
                            <td colSpan={4} className="py-1.5 px-1" style={{ borderLeft: "1px solid var(--border)" }}></td>
                          </React.Fragment>
                        );
                      }
                      const m = bucket.metrics;
                      return (
                        <React.Fragment key={bi}>
                          <td className="py-1.5 px-1 text-center text-white/40" style={{ borderLeft: "1px solid var(--border)" }}>
                            <div className="text-[8px] text-white/20 leading-none mb-0.5">{bucket.label}</div>
                            {m.trades}
                          </td>
                          <td className="py-1.5 px-1 text-center font-bold tabular-nums" style={{ color: srColor(m.sharpe), background: srBg(m.sharpe) }}>
                            {m.trades > 2 ? m.sharpe.toFixed(1) : "–"}
                          </td>
                          <td className="py-1.5 px-1 text-center tabular-nums" style={{ color: wrColor(m.winRate) }}>
                            {m.trades > 2 ? m.winRate.toFixed(0) + "%" : "–"}
                          </td>
                          <td className="py-1.5 px-1 text-center tabular-nums" style={{ color: m.avgRet > 0 ? "#22c55e" : "#ef4444" }}>
                            {m.trades > 2 ? (m.avgRet > 0 ? "+" : "") + m.avgRet.toFixed(3) + "%" : "–"}
                          </td>
                        </React.Fragment>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Interpretation */}
          <div className="mt-3 pt-3 border-t border-[var(--border)] text-[9px] font-mono text-[var(--text-dim)] leading-relaxed">
            <strong style={{ color: "#06b6d4" }}>How to read:</strong> Features are sorted by <strong>Spread</strong> (difference between best and worst bucket Sharpe) — high spread = the feature discriminates between good and bad conditions for signals.
            <strong> SR</strong> = annualised Sharpe ratio within that bucket. <strong>Win%</strong> = percentage of winning trades. <strong>AvgR</strong> = average return per trade.
            {stability.length > 0 && <> <strong style={{ color: "#a78bfa" }}>ρ IS→OOS</strong> = Spearman rank correlation of bucket Sharpes between in-sample and out-of-sample. ρ=1.0 means bucket rankings are perfectly preserved. ρ&lt;0 means the feature inverted — <strong>dangerous for filtering</strong>.</>}
            {" "}Features with spread &gt; 2.0 AND ρ &gt; 0.4 are strong candidates for live signal filtering.
          </div>

          {/* ═══ STABILITY REPORT ═══ */}
          {stability.length > 0 && (
            <div className="mt-3">
              <button onClick={() => setShowStability(!showStability)}
                className="px-3 py-1 rounded text-[10px] font-mono font-bold border transition-all mb-2"
                style={{ background: showStability ? "rgba(167,139,250,0.1)" : "transparent", borderColor: showStability ? "#a78bfa40" : "var(--border)", color: showStability ? "#a78bfa" : "var(--text-dim)" }}>
                {showStability ? "▼" : "▶"} Feature Stability Report (IS→OOS) — {isTaggedSignals.length} IS + {filtered.length} OOS signals
              </button>

              {showStability && (
                <div className="rounded-lg border p-3 mb-2" style={{ borderColor: "#a78bfa40", background: "rgba(167,139,250,0.03)" }}>
                  {/* Summary badges */}
                  <div className="flex gap-4 mb-3 flex-wrap">
                    {[
                      { label: "✅ Stable (ρ≥0.8)", count: stability.filter(s => s.confidence === "high").length, color: "#22c55e" },
                      { label: "🟡 Moderate (0.4-0.8)", count: stability.filter(s => s.confidence === "moderate").length, color: "#86efac" },
                      { label: "⚠️ Low (0-0.4)", count: stability.filter(s => s.confidence === "low").length, color: "#eab308" },
                      { label: "🔴 Unstable (ρ<0)", count: stability.filter(s => s.confidence === "unstable").length, color: "#fca5a5" },
                      { label: "⛔ Inverted (ρ<-0.4)", count: stability.filter(s => s.confidence === "inverted").length, color: "#ef4444" },
                      { label: "❓ Insufficient data", count: stability.filter(s => s.confidence === "insufficient").length, color: "#666" },
                    ].filter(b => b.count > 0).map(b => (
                      <span key={b.label} className="text-[9px] font-mono px-2 py-0.5 rounded" style={{ color: b.color, background: b.color + "15", border: `1px solid ${b.color}30` }}>
                        {b.label}: {b.count}
                      </span>
                    ))}
                  </div>

                  {/* Detailed stability table */}
                  <table className="w-full text-[9px] font-mono border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--border)]">
                        <th className="py-1.5 px-2 text-left text-[var(--text-dim)]">Feature</th>
                        <th className="py-1.5 px-1 text-center" style={{ color: "#a78bfa" }}>ρ</th>
                        <th className="py-1.5 px-1 text-center text-[var(--text-dim)]">Status</th>
                        <th className="py-1.5 px-1 text-center text-[var(--text-dim)]">IS n</th>
                        <th className="py-1.5 px-1 text-center text-[var(--text-dim)]">OOS n</th>
                        {[0, 1, 2].map(i => (
                          <React.Fragment key={i}>
                            <th className="py-1.5 px-1 text-center text-[#4ade80]" style={{ borderLeft: "1px solid var(--border)" }}>IS B{i+1}</th>
                            <th className="py-1.5 px-1 text-center text-[#f97316]">OOS B{i+1}</th>
                          </React.Fragment>
                        ))}
                        <th className="py-1.5 px-1 text-center text-[var(--text-dim)]" style={{ borderLeft: "1px solid var(--border)" }}>Recommendation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...stability].sort((a, b) => b.rho - a.rho).map(s => {
                        const oosSpread = grid.find(g => g.key === s.key)?.spread ?? 0;
                        let rec = "";
                        if (s.confidence === "insufficient") rec = "Need more data";
                        else if (s.confidence === "high" && oosSpread > 2) rec = "USE — strong filter";
                        else if (s.confidence === "high") rec = "USE — stable but low spread";
                        else if (s.confidence === "moderate" && oosSpread > 3) rec = "USE WITH CAUTION";
                        else if (s.confidence === "moderate") rec = "MONITOR — may improve";
                        else if (s.confidence === "low") rec = "WEAK — consider retiring";
                        else if (s.confidence === "unstable") rec = "RETIRE — unreliable";
                        else rec = "RETIRE — inverted rankings";

                        return (
                          <tr key={s.key} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="py-1.5 px-2 font-semibold text-[var(--text)]">{s.label}</td>
                            <td className="py-1.5 px-1 text-center font-bold tabular-nums" style={{ color: rhoColor(s.rho) }}>
                              {s.confidence === "insufficient" ? "n/a" : s.rho.toFixed(2)}
                            </td>
                            <td className="py-1.5 px-1 text-center" style={{ color: confidenceColor(s.confidence) }}>
                              {confidenceIcon(s.confidence)} {s.confidence}
                            </td>
                            <td className="py-1.5 px-1 text-center text-white/40">{s.isN}</td>
                            <td className="py-1.5 px-1 text-center text-white/40">{s.oosN}</td>
                            {[0, 1, 2].map(i => (
                              <React.Fragment key={i}>
                                <td className="py-1.5 px-1 text-center tabular-nums" style={{ borderLeft: "1px solid var(--border)", color: s.isBuckets[i]?.sharpe > 0 ? "#4ade80" : "#ef4444" }}>
                                  {s.isBuckets[i] ? `${s.isBuckets[i].sharpe.toFixed(1)}` : "–"}
                                </td>
                                <td className="py-1.5 px-1 text-center tabular-nums" style={{ color: s.oosBuckets[i]?.sharpe > 0 ? "#f97316" : "#ef4444" }}>
                                  {s.oosBuckets[i] ? `${s.oosBuckets[i].sharpe.toFixed(1)}` : "–"}
                                </td>
                              </React.Fragment>
                            ))}
                            <td className="py-1.5 px-1 text-center text-[8px]" style={{ borderLeft: "1px solid var(--border)", color: rec.startsWith("USE —") ? "#22c55e" : rec.startsWith("USE WITH") ? "#eab308" : rec.startsWith("RETIRE") ? "#ef4444" : "var(--text-dim)" }}>
                              {rec}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="mt-2 text-[8px] font-mono text-[var(--text-dim)] leading-relaxed">
                    <strong style={{ color: "#a78bfa" }}>Spearman ρ</strong> measures whether the ranking of bucket Sharpes is preserved from IS to OOS. ρ=1.0: perfect stability (same bucket is best/worst). ρ=0: no relationship (feature is noise). ρ&lt;0: rankings inverted (feature would <em>hurt</em> if used as filter). Only features with ρ≥0.4 AND spread≥2.0 should be used for live filtering.
                    The LLM Evolution Committee uses this stability report to decide which features to trust, retire, or investigate further.
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
