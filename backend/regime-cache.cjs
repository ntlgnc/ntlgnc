/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — REGIME CACHE                                          ║
 * ║  Background process: computes regime features for all coins      ║
 * ║  across 1M, 1H, 1D candles every 5 minutes                      ║
 * ║  Results cached in regime_cache table for instant page loads     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// ─── Math helpers ──────────────────────────────────────────────
function mean(arr) { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) {
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
  const slope = num / den, rets = logReturns(series), vol = std(rets);
  return vol === 0 ? 0 : slope / vol;
}
function persistence(closes) {
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
    const v = std(diffs) ** 2; if (v <= 0) continue;
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
  if (rets.length === 0) return 0;
  const lambda = 1 - 2 / (span + 1);
  let ewma = rets[0] ** 2;
  for (let i = 1; i < rets.length; i++) ewma = lambda * ewma + (1 - lambda) * rets[i] ** 2;
  return Math.sqrt(ewma);
}

// ─── Regime computation (same logic as route.ts) ────────────────
function computeRegime(bars) {
  if (bars.length < 60) return null;

  const idx = bars.length - 1;
  const c60 = bars.slice(Math.max(0, idx - 60), idx + 1);
  const c5d = bars.slice(Math.max(0, idx - 1440), idx + 1);
  const closes60 = c60.map(b => b.close);
  const closes5d = c5d.map(b => b.close);
  const rets60 = logReturns(closes60);

  const vol10 = std(rets60.slice(-10));
  const vol60f = std(rets60);
  const volRatio = vol60f > 0 ? vol10 / vol60f : 1;
  const trend60 = normalizedSlope(closes60.map(p => Math.log(p)));
  const persistence60 = persistence(closes60);
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

  const isTrend = Math.abs(trend60) > 0.4 && persistence60 > 0.60 && hurst > 0.52;
  const isRange = Math.abs(trend60) < 0.15 && hurst < 0.48;
  const regime = isTrend ? 'TREND' : isRange ? 'RANGE' : 'TRANSITION';
  const direction = isTrend ? (trend60 > 0 ? 'UP' : 'DOWN') : Math.abs(trend60) > 0.2 ? (trend60 > 0 ? 'UP' : 'DOWN') : 'NONE';
  const volState = atrCompression < 0.6 ? 'COMPRESSED' : atrCompression > 1.4 ? 'EXPANDING' : 'NORMAL';

  const posInRangeBucket = posInRange60 < 0.25 ? 'BOTTOM' : posInRange60 > 0.75 ? 'TOP' : 'MIDDLE';
  const longFavourable = posInRange60 >= 0.25 && volState !== 'COMPRESSED';
  const shortFavourable = posInRange60 <= 0.75 && volState !== 'COMPRESSED';

  const barsBack24h = Math.min(24, bars.length - 1);
  const price24hAgo = bars[idx - barsBack24h]?.close || bars[0].close;
  const currentPrice = bars[idx].close;
  const change24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;

  return {
    price: currentPrice, change24h,
    posInRange60, posInRange5d,
    trend60, trend5d, persistence60, hurst,
    atrCompression, volRatio, volRatio5d, vol60: vol60f,
    regime, volState, direction,
    posInRangeBucket,
    longFavourable, shortFavourable,
  };
}

// ─── Table setup ────────────────────────────────────────────────
async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS regime_cache (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      data JSONB NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(symbol, timeframe)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS regime_cache_meta (
      id SERIAL PRIMARY KEY,
      timeframe TEXT NOT NULL UNIQUE,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      coin_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      market_aggregate JSONB
    )
  `);
}

// ─── Compute market aggregate from snapshots ────────────────────
function computeAggregate(snapshots) {
  const n = snapshots.length;
  const agg = {
    totalCoins: n,
    regime: { TREND: 0, RANGE: 0, TRANSITION: 0 },
    volState: { COMPRESSED: 0, NORMAL: 0, EXPANDING: 0 },
    rangePosition: { BOTTOM: 0, MIDDLE: 0, TOP: 0 },
    avgHurst: 0, avgAtrCompression: 0,
    longFavourableCount: 0, shortFavourableCount: 0,
    marketMood: '',
  };

  for (const s of snapshots) {
    if (agg.regime[s.regime] !== undefined) agg.regime[s.regime]++;
    if (agg.volState[s.volState] !== undefined) agg.volState[s.volState]++;
    if (agg.rangePosition[s.posInRangeBucket] !== undefined) agg.rangePosition[s.posInRangeBucket]++;
    agg.avgHurst += s.hurst || 0;
    agg.avgAtrCompression += s.atrCompression || 0;
    if (s.longFavourable) agg.longFavourableCount++;
    if (s.shortFavourable) agg.shortFavourableCount++;
  }

  if (n > 0) { agg.avgHurst /= n; agg.avgAtrCompression /= n; }

  const topPct = agg.rangePosition.TOP / n;
  const bottomPct = agg.rangePosition.BOTTOM / n;
  const expandPct = agg.volState.EXPANDING / n;
  const compressPct = agg.volState.COMPRESSED / n;
  const trendPct = agg.regime.TREND / n;

  if (topPct > 0.5 && expandPct > 0.3) agg.marketMood = "Euphoric — most coins near highs with expanding volatility";
  else if (bottomPct > 0.5 && expandPct > 0.3) agg.marketMood = "Capitulation — most coins near lows with expanding volatility";
  else if (compressPct > 0.4) agg.marketMood = "Compressed — volatility squeeze across the market, breakout imminent";
  else if (topPct > 0.4) agg.marketMood = "Bullish — majority of coins in upper range";
  else if (bottomPct > 0.4) agg.marketMood = "Bearish — majority of coins in lower range";
  else if (trendPct > 0.3) agg.marketMood = "Trending — directional moves across many coins";
  else agg.marketMood = "Mixed — no dominant regime across the market";

  return agg;
}

// ─── Candle tables and their lookback windows ───────────────────
const TIMEFRAMES = [
  { key: '1m', table: 'Candle1m', barsNeeded: 1500, interval: '3 days',  label: '1-Minute', cacheInterval: 5 * 60 * 1000 },
  { key: '1h', table: 'Candle1h', barsNeeded: 1500, interval: '90 days', label: '1-Hour',   cacheInterval: 15 * 60 * 1000 },
  { key: '1d', table: 'Candle1d', barsNeeded: 500,  interval: '600 days', label: 'Daily',   cacheInterval: 30 * 60 * 1000 },
];

// ─── Main computation for one timeframe ─────────────────────────
async function computeTimeframe(tf) {
  const start = Date.now();
  const client = await pool.connect();
  try {
    // Get all symbols
    const { rows: symbolRows } = await client.query(
      `SELECT DISTINCT symbol FROM "${tf.table}" ORDER BY symbol`
    );
    const symbols = symbolRows.map(r => r.symbol);
    const snapshots = [];

    for (const symbol of symbols) {
      try {
        const { rows: candles } = await client.query(
          `SELECT timestamp, open, high, low, close, volume
           FROM "${tf.table}" WHERE symbol = $1
           ORDER BY timestamp DESC LIMIT $2`,
          [symbol, tf.barsNeeded]
        );
        if (candles.length < 60) continue;
        candles.reverse();
        const bars = candles.map(c => ({
          time: c.timestamp, timestamp: c.timestamp,
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume),
        }));

        const snap = computeRegime(bars);
        if (snap) {
          snap.symbol = symbol;
          snapshots.push(snap);
          // Upsert into cache
          await client.query(
            `INSERT INTO regime_cache (symbol, timeframe, data, computed_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (symbol, timeframe) DO UPDATE SET data = $3, computed_at = now()`,
            [symbol, tf.key, JSON.stringify(snap)]
          );
        }
      } catch (err) {
        // Skip individual coin errors
      }
    }

    // Compute and cache aggregate
    const agg = computeAggregate(snapshots);
    const durationMs = Date.now() - start;
    await client.query(
      `INSERT INTO regime_cache_meta (timeframe, computed_at, coin_count, duration_ms, market_aggregate)
       VALUES ($1, now(), $2, $3, $4)
       ON CONFLICT (timeframe) DO UPDATE SET computed_at = now(), coin_count = $2, duration_ms = $3, market_aggregate = $4`,
      [tf.key, snapshots.length, durationMs, JSON.stringify(agg)]
    );

    console.log(`[regime-cache] ✅ ${tf.label}: ${snapshots.length} coins in ${(durationMs / 1000).toFixed(1)}s`);
    return { coins: snapshots.length, ms: durationMs };
  } finally {
    client.release();
  }
}

// ─── Startup and loop ───────────────────────────────────────────
async function init() {
  const client = await pool.connect();
  try { await ensureTable(client); } finally { client.release(); }
  console.log(`[regime-cache] Database tables ready`);
}

async function runAll() {
  const start = Date.now();
  console.log(`[regime-cache] Computing all timeframes...`);
  for (const tf of TIMEFRAMES) {
    try {
      await computeTimeframe(tf);
    } catch (err) {
      console.error(`[regime-cache] ❌ ${tf.label}: ${err.message}`);
    }
  }
  console.log(`[regime-cache] ✅ All done in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
}

async function main() {
  await init();
  
  // Run all once on startup
  for (const tf of TIMEFRAMES) {
    try { await computeTimeframe(tf); } catch (err) { console.error(`[regime-cache] ❌ ${tf.label}: ${err.message}`); }
  }
  
  // Then each on its own interval
  for (const tf of TIMEFRAMES) {
    setInterval(async () => {
      try { await computeTimeframe(tf); } catch (err) { console.error(`[regime-cache] ❌ ${tf.label}: ${err.message}`); }
    }, tf.cacheInterval);
    console.log(`[regime-cache] ${tf.label} → every ${tf.cacheInterval / 60000}min`);
  }
}

main().catch(err => {
  console.error(`[regime-cache] Fatal:`, err);
  process.exit(1);
});
