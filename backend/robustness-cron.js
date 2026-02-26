/**
 * robustness-cron.js — Hourly automated robustness audit
 * 
 * Runs every hour. Pulls latest Candle1m data from postgres,
 * re-runs the winner strategy backtest, computes regime features,
 * compares to the previous report, and logs a timestamped 
 * research report for the LLM Evolution Committee.
 *
 * Usage:
 *   node robustness-cron.js
 *
 * Add to ecosystem.config.js for PM2 management.
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const PHI = 1.618034;
const COINS = [
  "ETHUSDT","BTCUSDT","XRPUSDT","SOLUSDT","BNBUSDT","ADAUSDT","DOGEUSDT",
  "LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT","SHIBUSDT","UNIUSDT","TRXUSDT",
  "XLMUSDT","BCHUSDT","HBARUSDT","ZECUSDT","SUIUSDT","TONUSDT"
];

// ═══ Winner strategy parameters (from scanner results) ═══
const STRATEGY = { minStr: 1, minCyc: 55, spike: true, nearMiss: true, holdDiv: 4, priceExt: true };
const CYCLE_MIN = 10;
const CYCLE_MAX = 100;
const SPLIT_PCT = 50;
const BAR_MINUTES = 1;
const AUDIT_INTERVAL = 60 * 60 * 1000; // 1 hour

// ═══ Core Fracmap computation (same as scanner) ═══
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

// ═══ Signal detection (same as scanner) ═══
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
      const ret = position.type === "LONG" ? (exitPrice / position.entryPrice - 1) * 100 : (position.entryPrice / exitPrice - 1) * 100;
      signals.push({ ...position, exitPrice, exitActualIdx: i, returnPct: +ret.toFixed(3), won: ret > 0 });
      position = null;
    }
    if (position) continue;
    
    let buyStrength = 0, sellStrength = 0, maxBuyCycle = 0, maxSellCycle = 0;
    for (const band of allBands) {
      const lo = band.lower[i], up = band.upper[i];
      if (lo === null || up === null || up <= lo) continue;
      const bandWidth = (up - lo) / ((up + lo) / 2);
      if (bandWidth < 0.0001) continue;
      const sw = Math.round(band.cycle / 3);
      
      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null && bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);
      if (buyAtI || buyNear) {
        if (spikeFilter) { if (!isLocalMax(band.lower, i, sw) && !(nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw)))) continue; }
        buyStrength++; if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle;
      }
      
      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null && bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);
      if (sellAtI || sellNear) {
        if (spikeFilter) { if (!isLocalMin(band.upper, i, sw) && !(nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw)))) continue; }
        sellStrength++; if (band.cycle > maxSellCycle) maxSellCycle = band.cycle;
      }
    }
    
    if (buyStrength >= minStrength && maxBuyCycle >= minMaxCycle && buyStrength >= sellStrength) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / holdDivisor);
        position = { type: "LONG", entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyCycle, time: bars[i + 1].time, strength: buyStrength };
      }
    } else if (sellStrength >= minStrength && maxSellCycle >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxSellCycle / holdDivisor);
        position = { type: "SHORT", entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxSellCycle, time: bars[i + 1].time, strength: sellStrength };
      }
    }
  }
  if (position) {
    const exitPrice = bars[n - 1].close;
    const ret = position.type === "LONG" ? (exitPrice / position.entryPrice - 1) * 100 : (position.entryPrice / exitPrice - 1) * 100;
    signals.push({ ...position, exitPrice, exitActualIdx: n - 1, returnPct: +ret.toFixed(3), won: ret > 0 });
  }
  return signals;
}

// ═══ Regime feature computation (simplified from RegimeAnalysis) ═══
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
function persistence(closes) {
  let same = 0;
  for (let i = 2; i < closes.length; i++) {
    if ((closes[i] > closes[i-1]) === (closes[i-1] > closes[i-2])) same++;
  }
  return closes.length > 2 ? same / (closes.length - 2) : 0.5;
}
function atrVal(bars, idx) {
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, idx - 13); i <= idx; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close));
    sum += tr; cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;
}

function computeFeaturesAtBar(bars, idx, sig) {
  if (idx < 60 || idx >= bars.length) return null;
  const c60 = bars.slice(Math.max(0, idx - 60), idx + 1);
  const closes60 = c60.map(b => b.close);
  const rets60 = logReturns(closes60);
  
  const vol10 = std(rets60.slice(-10));
  const vol60f = std(rets60);
  const volRatio = vol60f > 0 ? vol10 / vol60f : 1;
  const trend60 = normalizedSlope(closes60.map(p => Math.log(p)));
  const pers = persistence(closes60);
  const min60 = Math.min(...closes60), max60 = Math.max(...closes60);
  const posInRange = (max60 - min60) > 0 ? (closes60[closes60.length - 1] - min60) / (max60 - min60) : 0.5;
  
  const atr60 = atrVal(c60, c60.length - 1);
  const c5d = bars.slice(Math.max(0, idx - 1440), idx + 1);
  const atrLong = atrVal(c5d, c5d.length - 1);
  const atrCompression = atrLong > 0 ? atr60 / atrLong : 1;
  
  let volState = atrCompression < 0.6 ? "COMPRESSED" : atrCompression > 1.4 ? "EXPANDING" : "NORMAL";
  let hourOfDay = 12;
  try { hourOfDay = new Date(bars[idx].time).getUTCHours(); } catch {}
  
  return {
    direction: sig.type,
    maxCycle: sig.maxCycle,
    volState,
    hourOfDay,
    trend60,
    persistence: pers,
    posInRange,
    volRatio,
    atrCompression,
    returnPct: sig.returnPct,
  };
}

// ═══ Regime bucketing and Sharpe computation ═══
const REGIME_FEATURES = [
  { key: "volState", label: "Vol State", buckets: [
    { label: "COMPRESSED", test: (f) => f.volState === "COMPRESSED" },
    { label: "NORMAL", test: (f) => f.volState === "NORMAL" },
    { label: "EXPANDING", test: (f) => f.volState === "EXPANDING" },
  ]},
  { key: "hour", label: "Hour (UTC)", buckets: [
    { label: "Asia (0-8)", test: (f) => f.hourOfDay < 8 },
    { label: "Europe (8-15)", test: (f) => f.hourOfDay >= 8 && f.hourOfDay < 15 },
    { label: "US (15-23)", test: (f) => f.hourOfDay >= 15 },
  ]},
  { key: "direction", label: "Direction", buckets: [
    { label: "LONG", test: (f) => f.direction === "LONG" },
    { label: "SHORT", test: (f) => f.direction === "SHORT" },
  ]},
  { key: "trend60", label: "60-bar Trend", buckets: [
    { label: "Down", test: (f) => f.trend60 < -0.3 },
    { label: "Flat", test: (f) => f.trend60 >= -0.3 && f.trend60 <= 0.3 },
    { label: "Up", test: (f) => f.trend60 > 0.3 },
  ]},
  { key: "posInRange", label: "Position in Range", buckets: [
    { label: "Bottom 33%", test: (f) => f.posInRange < 0.33 },
    { label: "Middle", test: (f) => f.posInRange >= 0.33 && f.posInRange <= 0.67 },
    { label: "Top 33%", test: (f) => f.posInRange > 0.67 },
  ]},
  { key: "maxCycle", label: "Max Trigger Cycle", buckets: [
    { label: "Short (≤70)", test: (f) => f.maxCycle <= 70 },
    { label: "Med (71-90)", test: (f) => f.maxCycle > 70 && f.maxCycle <= 90 },
    { label: "Long (>90)", test: (f) => f.maxCycle > 90 },
  ]},
  { key: "persistence", label: "Persistence", buckets: [
    { label: "Choppy (<0.47)", test: (f) => f.persistence < 0.47 },
    { label: "Mixed", test: (f) => f.persistence >= 0.47 && f.persistence <= 0.55 },
    { label: "Clean (>0.55)", test: (f) => f.persistence > 0.55 },
  ]},
  { key: "volRatio", label: "Vol Ratio 10/60", buckets: [
    { label: "Quiet (<0.7)", test: (f) => f.volRatio < 0.7 },
    { label: "Normal", test: (f) => f.volRatio >= 0.7 && f.volRatio <= 1.3 },
    { label: "Spiking (>1.3)", test: (f) => f.volRatio > 1.3 },
  ]},
  { key: "atrCompression", label: "ATR Compression", buckets: [
    { label: "Compressed (<0.7)", test: (f) => f.atrCompression < 0.7 },
    { label: "Normal", test: (f) => f.atrCompression >= 0.7 && f.atrCompression <= 1.3 },
    { label: "Expanding (>1.3)", test: (f) => f.atrCompression > 1.3 },
  ]},
];

function computeBucketSharpe(signals) {
  if (signals.length < 3) return { sharpe: 0, winRate: 0, avgRet: 0, n: signals.length };
  const rets = signals.map(s => s.returnPct);
  const n = rets.length;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const stdev = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n);
  const avgHold = signals.reduce((s, sig) => s + (sig.holdDuration || 20), 0) / n;
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(525600 / Math.max(1, avgHold * BAR_MINUTES)) : 0;
  const winRate = rets.filter(r => r > 0).length / n * 100;
  const se = Math.abs(sharpe) * Math.sqrt(2 / n);
  return { sharpe: +sharpe.toFixed(2), winRate: +winRate.toFixed(1), avgRet: +mean.toFixed(4), n, se: +se.toFixed(2) };
}

function computeRegimeTable(taggedSignals, splitPoint) {
  const isSigs = taggedSignals.filter(s => s._barIdx < splitPoint);
  const oosSigs = taggedSignals.filter(s => s._barIdx >= splitPoint);
  
  const results = [];
  for (const feat of REGIME_FEATURES) {
    const oosResults = feat.buckets.map(b => {
      const matching = oosSigs.filter(s => b.test(s));
      return { label: b.label, ...computeBucketSharpe(matching) };
    });
    const isResults = feat.buckets.map(b => {
      const matching = isSigs.filter(s => b.test(s));
      return { label: b.label, ...computeBucketSharpe(matching) };
    });
    
    // Compute spread (best - worst OOS Sharpe)
    const oosSharpes = oosResults.filter(b => b.n >= 3).map(b => b.sharpe);
    const spread = oosSharpes.length >= 2 ? Math.max(...oosSharpes) - Math.min(...oosSharpes) : 0;
    
    // Compute Spearman ρ between IS and OOS bucket rankings
    let rho = null;
    const validBuckets = feat.buckets.filter((_, i) => isResults[i].n >= 3 && oosResults[i].n >= 3);
    if (validBuckets.length >= 2) {
      const isRanks = rankArray(validBuckets.map((_, i) => isResults[feat.buckets.indexOf(validBuckets[i])].sharpe));
      const oosRanks = rankArray(validBuckets.map((_, i) => oosResults[feat.buckets.indexOf(validBuckets[i])].sharpe));
      rho = spearmanRho(isRanks, oosRanks);
    }
    
    results.push({
      feature: feat.label,
      key: feat.key,
      spread: +spread.toFixed(1),
      rho: rho !== null ? +rho.toFixed(2) : null,
      buckets: oosResults,
      isBuckets: isResults,
    });
  }
  return results;
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

// ═══ Main audit function ═══
async function runAudit() {
  const startTime = Date.now();
  const client = await pool.connect();
  console.log(`[robustness] Starting hourly audit at ${new Date().toISOString()}`);
  
  try {
    // Ensure research_log table exists
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
    
    // ── 1. Fetch data for all 20 coins ──
    const coinData = {};
    let totalBars = 0;
    for (const symbol of COINS) {
      const { rows } = await client.query(
        `SELECT timestamp as time, open, high, low, close FROM "Candle1m" WHERE symbol=$1 ORDER BY timestamp`,
        [symbol]
      );
      if (rows.length > 200) {
        coinData[symbol] = rows.map(r => ({ time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close }));
        totalBars += rows.length;
      }
    }
    console.log(`[robustness] Loaded ${Object.keys(coinData).length} coins, ${totalBars.toLocaleString()} total bars`);
    
    // ── 2. Run backtest per coin with IS/OOS split ──
    const perCoinOOS = [];
    const allOosTagged = [];
    let totalSignals = 0;
    let netLongs = 0, netShorts = 0;
    
    for (const [symbol, bars] of Object.entries(coinData)) {
      const splitIdx = Math.round(bars.length * SPLIT_PCT / 100);
      const oosBars = bars.slice(splitIdx);
      if (oosBars.length < 100) continue;
      
      // Compute bands on OOS bars
      const highs = oosBars.map(b => b.high);
      const lows = oosBars.map(b => b.low);
      const allBands = [];
      for (let order = 1; order <= 6; order++) {
        for (let cycle = CYCLE_MIN; cycle <= CYCLE_MAX; cycle++) {
          allBands.push({ cycle, order, ...computeFracmap(highs, lows, cycle, order) });
        }
      }
      
      // Detect signals
      const sigs = detectEnsembleSignals(oosBars, allBands, STRATEGY.minStr, STRATEGY.minCyc, STRATEGY.spike, STRATEGY.holdDiv, STRATEGY.nearMiss, STRATEGY.priceExt);
      if (sigs.length < 3) continue;
      
      // Compute OOS Sharpe (time-series, daily aggregation)
      const barsPerDay = 1440;
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
      
      const rets = sigs.map(s => s.returnPct);
      const totalRet = rets.reduce((s, r) => s + r, 0);
      const winRate = rets.filter(r => r > 0).length / rets.length * 100;
      const gw = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
      const gl = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));
      const pf = gl > 0 ? gw / gl : gw > 0 ? 999 : 0;
      
      const longSigs = sigs.filter(s => s.type === "LONG");
      const shortSigs = sigs.filter(s => s.type === "SHORT");
      netLongs += longSigs.length;
      netShorts += shortSigs.length;
      
      perCoinOOS.push({
        coin: symbol.replace("USDT", ""),
        sharpe: +sharpe.toFixed(2),
        winRate: +winRate.toFixed(1),
        totalRet: +totalRet.toFixed(2),
        pf: +pf.toFixed(2),
        trades: sigs.length,
        longs: longSigs.length,
        shorts: shortSigs.length,
      });
      
      // Tag signals with regime features for the regime table
      for (const sig of sigs) {
        const feat = computeFeaturesAtBar(oosBars, sig.entryIdx, sig);
        if (feat) {
          feat._barIdx = sig.entryIdx;
          feat.returnPct = sig.returnPct;
          feat.holdDuration = sig.holdDuration;
          allOosTagged.push(feat);
        }
      }
      totalSignals += sigs.length;
    }
    
    perCoinOOS.sort((a, b) => b.sharpe - a.sharpe);
    const posCoins = perCoinOOS.filter(c => c.sharpe > 0).length;
    const avgSharpe = perCoinOOS.reduce((s, c) => s + c.sharpe, 0) / Math.max(perCoinOOS.length, 1);
    const avgWinRate = perCoinOOS.reduce((s, c) => s + c.winRate, 0) / Math.max(perCoinOOS.length, 1);
    const avgRet = perCoinOOS.reduce((s, c) => s + c.totalRet, 0) / Math.max(perCoinOOS.length, 1);
    const avgPF = perCoinOOS.reduce((s, c) => s + Math.min(c.pf, 10), 0) / Math.max(perCoinOOS.length, 1);
    
    console.log(`[robustness] Backtest: ${perCoinOOS.length} coins, avg SR ${avgSharpe.toFixed(2)}, ${posCoins}/${perCoinOOS.length} positive, ${totalSignals} signals`);
    
    // ── 3. Compute regime table ──
    // Split tagged signals by midpoint for IS/OOS regime comparison
    const taggedSorted = allOosTagged.sort((a, b) => a._barIdx - b._barIdx);
    const regimeSplitPoint = taggedSorted.length > 0 ? taggedSorted[Math.floor(taggedSorted.length / 2)]._barIdx : 0;
    const regimeTable = computeRegimeTable(taggedSorted, regimeSplitPoint);
    
    console.log(`[robustness] Regime: ${regimeTable.length} features computed`);
    
    // ── 4. Fetch previous report for change detection ──
    const { rows: prevRows } = await client.query(
      `SELECT * FROM research_log WHERE report_type = 'hourly_scan' ORDER BY created_at DESC LIMIT 1`
    );
    const prev = prevRows[0] || null;
    
    // ── 5. Generate change-detection findings ──
    const findings = [];
    
    // Performance changes
    if (prev && prev.oos_avg_sharpe !== null) {
      const sharpeDelta = avgSharpe - prev.oos_avg_sharpe;
      const pctChange = prev.oos_avg_sharpe !== 0 ? (sharpeDelta / Math.abs(prev.oos_avg_sharpe) * 100) : 0;
      if (Math.abs(pctChange) > 10) {
        findings.push(`⚠️ OOS Sharpe ${sharpeDelta > 0 ? "improved" : "DEGRADED"} ${Math.abs(pctChange).toFixed(0)}%: ${prev.oos_avg_sharpe.toFixed(2)} → ${avgSharpe.toFixed(2)}`);
      } else {
        findings.push(`OOS Sharpe stable: ${prev.oos_avg_sharpe.toFixed(2)} → ${avgSharpe.toFixed(2)} (${sharpeDelta > 0 ? "+" : ""}${pctChange.toFixed(1)}%)`);
      }
    } else {
      findings.push(`First report. OOS Sharpe: ${avgSharpe.toFixed(2)}, ${posCoins}/${perCoinOOS.length} positive coins.`);
    }
    
    // Per-coin robustness changes
    if (prev && prev.per_coin_oos) {
      const prevCoins = {};
      for (const c of (Array.isArray(prev.per_coin_oos) ? prev.per_coin_oos : [])) {
        prevCoins[c.coin] = c;
      }
      
      const degraded = [];
      const improved = [];
      const flipped = [];
      
      for (const c of perCoinOOS) {
        const pc = prevCoins[c.coin];
        if (!pc) continue;
        const delta = c.sharpe - (pc.sharpe || 0);
        if (pc.sharpe > 0 && c.sharpe <= 0) flipped.push(`${c.coin} LOST edge (${pc.sharpe.toFixed(1)} → ${c.sharpe.toFixed(1)})`);
        else if (pc.sharpe <= 0 && c.sharpe > 0) flipped.push(`${c.coin} GAINED edge (${pc.sharpe.toFixed(1)} → ${c.sharpe.toFixed(1)})`);
        else if (delta < -3) degraded.push(`${c.coin} (${delta.toFixed(1)})`);
        else if (delta > 3) improved.push(`${c.coin} (+${delta.toFixed(1)})`);
      }
      
      if (flipped.length > 0) findings.push(`🔄 COIN FLIPS: ${flipped.join("; ")}`);
      if (degraded.length > 0) findings.push(`📉 Degraded: ${degraded.join(", ")}`);
      if (improved.length > 0) findings.push(`📈 Improved: ${improved.join(", ")}`);
    }
    
    // Regime stability changes
    if (prev && prev.regime_features) {
      const prevRegimes = {};
      for (const r of (Array.isArray(prev.regime_features) ? prev.regime_features : [])) {
        prevRegimes[r.feature || r.key] = r;
      }
      
      const rhoChanges = [];
      for (const r of regimeTable) {
        const pr = prevRegimes[r.feature] || prevRegimes[r.key];
        if (!pr) continue;
        const prevRho = pr.rho;
        const currRho = r.rho;
        
        if (prevRho !== null && currRho !== null) {
          if (prevRho >= 0.5 && currRho < 0.5) {
            rhoChanges.push(`⛔ ${r.feature}: ρ LOST stability (${prevRho.toFixed(2)} → ${currRho.toFixed(2)}) — STOP using as filter`);
          } else if (prevRho < 0.5 && currRho >= 0.5) {
            rhoChanges.push(`✅ ${r.feature}: ρ GAINED stability (${prevRho.toFixed(2)} → ${currRho.toFixed(2)}) — consider as filter`);
          } else if (prevRho >= 0 && currRho < 0) {
            rhoChanges.push(`⚠️ ${r.feature}: ρ INVERTED (${prevRho.toFixed(2)} → ${currRho.toFixed(2)}) — DANGER, rankings reversed`);
          }
        }
        
        // Spread changes
        const spreadDelta = r.spread - (pr.spread || 0);
        if (Math.abs(spreadDelta) > 5) {
          rhoChanges.push(`${r.feature} spread ${spreadDelta > 0 ? "widened" : "narrowed"}: ${(pr.spread||0).toFixed(1)} → ${r.spread.toFixed(1)}`);
        }
      }
      
      if (rhoChanges.length > 0) {
        findings.push(`\n🧬 REGIME STABILITY CHANGES:\n${rhoChanges.join("\n")}`);
      } else {
        findings.push(`🧬 Regime stability: No significant ρ changes detected.`);
      }
    }
    
    // Net position summary
    const netPos = {
      avgNet: +((netLongs - netShorts) / Math.max(perCoinOOS.length, 1)).toFixed(1),
      totalLongs: netLongs,
      totalShorts: netShorts,
      shortPct: +(netShorts / Math.max(netLongs + netShorts, 1) * 100).toFixed(1),
    };
    findings.push(`\n⚖️ Direction split: ${netLongs}L / ${netShorts}S (${netPos.shortPct}% short)`);
    
    // Robustness metrics
    const sharpeSE = avgSharpe * Math.sqrt(2 / 7); // ~7 days OOS
    const robustness = {
      sharpe_se: +sharpeSE.toFixed(2),
      sharpe_ci_low: +(avgSharpe - 1.96 * sharpeSE).toFixed(2),
      sharpe_ci_high: +(avgSharpe + 1.96 * sharpeSE).toFixed(2),
      positive_coins: `${posCoins}/${perCoinOOS.length}`,
      stable_regimes: regimeTable.filter(r => r.rho !== null && r.rho >= 0.8).map(r => r.feature),
      plausible_regimes: regimeTable.filter(r => r.rho !== null && r.rho >= 0.5 && r.rho < 0.8).map(r => r.feature),
      inverted_regimes: regimeTable.filter(r => r.rho !== null && r.rho < 0).map(r => r.feature),
    };
    
    // Recommendations
    const recs = [];
    if (robustness.inverted_regimes.length > 0) {
      recs.push(`STOP using as filters: ${robustness.inverted_regimes.join(", ")} (ρ < 0, inverted IS→OOS)`);
    }
    const negCoins = perCoinOOS.filter(c => c.sharpe < 0).map(c => c.coin);
    if (negCoins.length > 0) {
      recs.push(`Consider excluding: ${negCoins.join(", ")} (negative OOS Sharpe)`);
    }
    if (netPos.shortPct > 55) {
      recs.push(`Short-dominant strategy (${netPos.shortPct}% shorts). Monitor for market direction bias.`);
    }
    
    const title = `Hourly Audit · SR ${avgSharpe.toFixed(2)} · ${posCoins}/${perCoinOOS.length} · ${new Date().toISOString().slice(0, 16)}`;
    
    // ── 6. Store report ──
    await client.query(`
      INSERT INTO research_log (
        report_type, title, winner_strategy, oos_avg_sharpe, oos_consistency,
        oos_avg_winrate, oos_avg_pf, oos_avg_return, per_coin_oos,
        regime_features, net_position, robustness, findings, recommendations,
        bar_minutes, cycle_min, cycle_max, split_pct, total_bars, total_signals
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    `, [
      "hourly_scan", title, JSON.stringify(STRATEGY),
      avgSharpe, `${posCoins}/${perCoinOOS.length}`,
      avgWinRate, avgPF, avgRet,
      JSON.stringify(perCoinOOS), JSON.stringify(regimeTable),
      JSON.stringify(netPos), JSON.stringify(robustness),
      findings.join("\n\n"), recs.join("\n"),
      BAR_MINUTES, CYCLE_MIN, CYCLE_MAX, SPLIT_PCT,
      totalBars, totalSignals,
    ]);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[robustness] ✅ Report logged: "${title}" (${elapsed}s)`);
    console.log(`[robustness] Findings:\n${findings.join("\n")}`);
    if (recs.length > 0) console.log(`[robustness] Recommendations:\n${recs.join("\n")}`);
    
  } catch (err) {
    console.error(`[robustness] ❌ Audit failed:`, err.message);
    console.error(err.stack);
  } finally {
    client.release();
  }
}

// ═══ Scheduler ═══
console.log(`[robustness] Starting hourly robustness audit cron`);
console.log(`[robustness] Strategy: ×${STRATEGY.minStr} C≥${STRATEGY.minCyc} Spike:${STRATEGY.spike} ±1:${STRATEGY.nearMiss} ÷${STRATEGY.holdDiv}`);
console.log(`[robustness] Coins: ${COINS.length}, Cycles: ${CYCLE_MIN}-${CYCLE_MAX}, Split: ${SPLIT_PCT}%`);
console.log(`[robustness] Interval: ${AUDIT_INTERVAL / 60000} minutes`);

// Run immediately on start
runAudit();

// Then every hour
setInterval(runAudit, AUDIT_INTERVAL);

console.log('[robustness] Scheduler running. Ctrl+C to stop.');
