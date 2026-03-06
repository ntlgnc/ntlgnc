import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const dynamic = "force-dynamic";

// ═══════════════════════════════════════════════════════════════
// MATH UTILITIES — Ported from RegimeAnalysis.tsx for server-side
// ═══════════════════════════════════════════════════════════════

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
  let num2 = 0, den2 = 0;
  for (let i = 0; i < logLags.length; i++) { const dx = logLags[i] - xM; num2 += dx * (logVars[i] - yM); den2 += dx * dx; }
  return den2 === 0 ? 0.5 : Math.max(0, Math.min(1, (num2 / den2) / 2));
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

// ═══════════════════════════════════════════════════════════════
// Compute regime features for a single coin given its bars
// ═══════════════════════════════════════════════════════════════

type RegimeSnapshot = {
  symbol: string;
  timestamp: string;
  price: number;
  change24h: number;
  // Feature values
  posInRange60: number;
  posInRange5d: number;
  trend60: number;
  trend5d: number;
  persistence60: number;
  hurst: number;
  atrCompression: number;
  volRatio: number;
  volRatio5d: number;
  vol60: number;
  // Classifications
  regime: string;      // TREND / RANGE / TRANSITION
  volState: string;    // COMPRESSED / NORMAL / EXPANDING
  direction: string;   // UP / DOWN / NONE
  // Bucket labels for display
  posInRangeBucket: string;
  volStateBucket: string;
  trendBucket: string;
  // Signal quality indicators
  longFavourable: boolean;   // regime conditions favour longs
  shortFavourable: boolean;  // regime conditions favour shorts
};

function computeRegimeForCoin(bars: any[]): RegimeSnapshot | null {
  if (bars.length < 100) return null;

  const idx = bars.length - 1;
  const c60 = bars.slice(Math.max(0, idx - 60), idx + 1);
  const c5d = bars.slice(Math.max(0, idx - 1440), idx + 1);
  const closes60 = c60.map((b: any) => b.close);
  const closes5d = c5d.map((b: any) => b.close);
  const rets60 = logReturns(closes60);

  // Micro features
  const vol10 = std(rets60.slice(-10));
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

  // Regime classification
  const isTrend = Math.abs(trend60) > 0.4 && persistence60 > 0.60 && hurst > 0.52;
  const isRange = Math.abs(trend60) < 0.15 && hurst < 0.48;
  const regime = isTrend ? "TREND" : isRange ? "RANGE" : "TRANSITION";
  const direction = isTrend ? (trend60 > 0 ? "UP" : "DOWN") : Math.abs(trend60) > 0.2 ? (trend60 > 0 ? "UP" : "DOWN") : "NONE";
  const volState = atrCompression < 0.6 ? "COMPRESSED" : atrCompression > 1.4 ? "EXPANDING" : "NORMAL";

  // Bucket labels
  const posInRangeBucket = posInRange60 < 0.25 ? "BOTTOM" : posInRange60 > 0.75 ? "TOP" : "MIDDLE";
  const volStateBucket = volState;
  const trendBucket = trend60 < -0.3 ? "DOWN" : trend60 > 0.3 ? "UP" : "FLAT";

  // Signal quality — based on scanner regime analysis results
  // Longs favoured: Middle/Top range, Normal/Expanding vol
  // Shorts favoured: Bottom range, Normal/Expanding vol  
  const longFavourable = posInRange60 >= 0.25 && volState !== "COMPRESSED";
  const shortFavourable = posInRange60 <= 0.75 && volState !== "COMPRESSED";

  // 24h change
  const barsBack24h = Math.min(24, bars.length - 1);
  const price24hAgo = bars[idx - barsBack24h]?.close || bars[0].close;
  const currentPrice = bars[idx].close;
  const change24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;

  return {
    symbol: "",  // filled in by caller
    timestamp: bars[idx].timestamp || bars[idx].time,
    price: currentPrice,
    change24h,
    posInRange60, posInRange5d,
    trend60, trend5d,
    persistence60, hurst,
    atrCompression, volRatio, volRatio5d,
    vol60: vol60f,
    regime, volState, direction,
    posInRangeBucket, volStateBucket, trendBucket,
    longFavourable, shortFavourable,
  };
}

// ═══════════════════════════════════════════════════════════════
// Market-wide aggregate — what % of coins are in each bucket
// ═══════════════════════════════════════════════════════════════

type MarketAggregate = {
  totalCoins: number;
  regime: { TREND: number; RANGE: number; TRANSITION: number };
  volState: { COMPRESSED: number; NORMAL: number; EXPANDING: number };
  rangePosition: { BOTTOM: number; MIDDLE: number; TOP: number };
  trend: { DOWN: number; FLAT: number; UP: number };
  avgHurst: number;
  avgAtrCompression: number;
  avgVolRatio5d: number;
  longFavourableCount: number;
  shortFavourableCount: number;
  marketMood: string;  // human-readable summary
};

function computeMarketAggregate(snapshots: RegimeSnapshot[]): MarketAggregate {
  const n = snapshots.length;
  const agg: MarketAggregate = {
    totalCoins: n,
    regime: { TREND: 0, RANGE: 0, TRANSITION: 0 },
    volState: { COMPRESSED: 0, NORMAL: 0, EXPANDING: 0 },
    rangePosition: { BOTTOM: 0, MIDDLE: 0, TOP: 0 },
    trend: { DOWN: 0, FLAT: 0, UP: 0 },
    avgHurst: 0, avgAtrCompression: 0, avgVolRatio5d: 0,
    longFavourableCount: 0, shortFavourableCount: 0,
    marketMood: "",
  };

  for (const s of snapshots) {
    agg.regime[s.regime as keyof typeof agg.regime]++;
    agg.volState[s.volState as keyof typeof agg.volState]++;
    agg.rangePosition[s.posInRangeBucket as keyof typeof agg.rangePosition]++;
    agg.trend[s.trendBucket as keyof typeof agg.trend]++;
    agg.avgHurst += s.hurst;
    agg.avgAtrCompression += s.atrCompression;
    agg.avgVolRatio5d += s.volRatio5d;
    if (s.longFavourable) agg.longFavourableCount++;
    if (s.shortFavourable) agg.shortFavourableCount++;
  }

  if (n > 0) {
    agg.avgHurst /= n;
    agg.avgAtrCompression /= n;
    agg.avgVolRatio5d /= n;
  }

  // Market mood summary
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

// ═══════════════════════════════════════════════════════════════
// API HANDLER
// ═══════════════════════════════════════════════════════════════

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "snapshot";
  const client = await pool.connect();

  try {
    // ── ACTION: snapshot — Read from regime_cache (fast!) ──
    if (action === "snapshot") {
      const tf = searchParams.get("tf") || "1h";
      
      // Try reading from cache first
      try {
        const { rows: cached } = await client.query(
          `SELECT symbol, data FROM regime_cache WHERE timeframe = $1`, [tf]
        );
        const { rows: meta } = await client.query(
          `SELECT computed_at, coin_count, duration_ms, market_aggregate FROM regime_cache_meta WHERE timeframe = $1`, [tf]
        );

        if (cached.length > 0 && meta.length > 0) {
          const coins = cached.map((r: any) => {
            const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            return { symbol: r.symbol, ...d };
          });
          const market = typeof meta[0].market_aggregate === 'string' 
            ? JSON.parse(meta[0].market_aggregate) : meta[0].market_aggregate;

          return NextResponse.json({
            timestamp: meta[0].computed_at,
            coins,
            market,
            cached: true,
            computedIn: meta[0].duration_ms,
          });
        }
      } catch {
        // Cache table might not exist yet — fall through to live computation
      }

      // Fallback: compute live (slow, first load before cache runs)
      const { rows: symbolRows } = await client.query(
        `SELECT DISTINCT symbol FROM "Candle1h" ORDER BY symbol`
      );
      const symbols = symbolRows.map((r: any) => r.symbol);
      const snapshots: RegimeSnapshot[] = [];

      for (const symbol of symbols) {
        const { rows: candles } = await client.query(
          `SELECT timestamp, open, high, low, close, volume 
           FROM "Candle1h" WHERE symbol = $1 
           ORDER BY timestamp DESC LIMIT 1500`,
          [symbol]
        );
        if (candles.length < 100) continue;
        candles.reverse();
        const bars = candles.map((c: any) => ({
          time: c.timestamp, timestamp: c.timestamp,
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
        }));
        const snap = computeRegimeForCoin(bars);
        if (snap) { snap.symbol = symbol; snapshots.push(snap); }
      }

      const aggregate = computeMarketAggregate(snapshots);
      return NextResponse.json({
        timestamp: new Date().toISOString(),
        coins: snapshots,
        market: aggregate,
        cached: false,
      });
    }

    // ── ACTION: snapshot-multi — All 3 timeframes from cache ──
    if (action === "snapshot-multi") {
      try {
        const { rows: allMeta } = await client.query(
          `SELECT timeframe, computed_at, coin_count, duration_ms, market_aggregate FROM regime_cache_meta ORDER BY timeframe`
        );
        const result: Record<string, any> = {};
        for (const m of allMeta) {
          const agg = typeof m.market_aggregate === 'string' ? JSON.parse(m.market_aggregate) : m.market_aggregate;
          result[m.timeframe] = {
            computedAt: m.computed_at,
            coinCount: m.coin_count,
            durationMs: m.duration_ms,
            market: agg,
          };
        }
        return NextResponse.json({ timeframes: result, timestamp: new Date().toISOString() });
      } catch {
        return NextResponse.json({ timeframes: {}, timestamp: new Date().toISOString() });
      }
    }

    // ── ACTION: coin — Single coin regime detail ──
    if (action === "coin") {
      const symbol = searchParams.get("symbol") || "BTCUSDT";
      const { rows: candles } = await client.query(
        `SELECT timestamp, open, high, low, close, volume 
         FROM "Candle1h" WHERE symbol = $1 
         ORDER BY timestamp DESC LIMIT 1500`,
        [symbol]
      );

      if (candles.length < 100) {
        return NextResponse.json({ error: "Insufficient data" }, { status: 404 });
      }

      candles.reverse();
      const bars = candles.map((c: any) => ({
        time: c.timestamp, timestamp: c.timestamp,
        open: Number(c.open), high: Number(c.high),
        low: Number(c.low), close: Number(c.close),
        volume: Number(c.volume),
      }));

      const snap = computeRegimeForCoin(bars);
      if (!snap) return NextResponse.json({ error: "Computation failed" }, { status: 500 });
      snap.symbol = symbol;

      return NextResponse.json({ coin: snap });
    }

    // ── ACTION: board-summary — Latest board meeting for public display ──
    if (action === "board-summary") {
      // Ensure table exists
      try {
        await client.query(`SELECT 1 FROM board_meetings LIMIT 0`);
      } catch {
        return NextResponse.json({ meeting: null, filters: [], message: "Board has not met yet" });
      }

      const { rows: meetings } = await client.query(
        `SELECT id, created_at, round_number, chair_id, decision, motion_type,
                motion_details, deployed, impact_review, votes, proposals, debate,
                duration_ms, total_tokens
         FROM board_meetings 
         WHERE phase = 'complete'
         ORDER BY created_at DESC LIMIT 5`
      );

      // Active filters — include real activity counts
      let filters: any[] = [];
      try {
        const { rows } = await client.query(
          `SELECT id, feature, conditions, rationale, proposed_by, created_at, timeframe,
                  COALESCE(trades_filtered, 0) as trades_filtered, 
                  COALESCE(trades_passed, 0) as trades_passed
           FROM board_filters WHERE active = true ORDER BY created_at`
        );
        filters = rows;
      } catch {}

      // Active coin overrides
      let overrides: any[] = [];
      try {
        const { rows } = await client.query(
          `SELECT symbol, override_type, parameters, rationale
           FROM board_coin_overrides WHERE active = true ORDER BY symbol`
        );
        overrides = rows;
      } catch {}

      return NextResponse.json({
        meetings: meetings.map((m: any) => ({
          id: m.id,
          time: m.created_at,
          round: m.round_number,
          chair: m.chair_id,
          decision: m.decision,
          motionType: m.motion_type,
          motionDetails: m.motion_details,
          deployed: m.deployed,
          impactReview: m.impact_review,
          votes: m.votes,
          briefing: m.proposals?.briefing,
          keyIssue: m.proposals?.key_issue,
          debate: m.debate?.map((d: any) => ({
            name: d.member_name,
            role: d.role,
            assessment: d.response?.assessment || d.raw?.slice(0, 300),
            support: d.response?.support,
            concern: d.response?.concern,
            insight: d.response?.insight,
          })),
          durationMs: m.duration_ms,
          tokens: m.total_tokens,
        })),
        filters,
        overrides,
      });
    }

    // ── ACTION: regime-context — Full regime data formatted for LLM board ──
    if (action === "regime-context") {
      // Same as snapshot but formatted as a text briefing for LLMs
      const { rows: symbolRows } = await client.query(
        `SELECT DISTINCT symbol FROM "Candle1h" ORDER BY symbol`
      );
      const symbols = symbolRows.map((r: any) => r.symbol);
      const snapshots: RegimeSnapshot[] = [];

      for (const symbol of symbols) {
        const { rows: candles } = await client.query(
          `SELECT timestamp, open, high, low, close, volume 
           FROM "Candle1h" WHERE symbol = $1 
           ORDER BY timestamp DESC LIMIT 1500`,
          [symbol]
        );
        if (candles.length < 100) continue;
        candles.reverse();
        const bars = candles.map((c: any) => ({
          time: c.timestamp, timestamp: c.timestamp,
          open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume),
        }));
        const snap = computeRegimeForCoin(bars);
        if (snap) { snap.symbol = symbol; snapshots.push(snap); }
      }

      const agg = computeMarketAggregate(snapshots);

      // Format as a structured text briefing
      const briefing = `
REAL-TIME REGIME ANALYSIS — ${new Date().toISOString()}
${agg.totalCoins} coins analysed from 1H data

MARKET MOOD: ${agg.marketMood}

REGIME DISTRIBUTION:
  TREND: ${agg.regime.TREND} coins (${(agg.regime.TREND/agg.totalCoins*100).toFixed(0)}%)
  RANGE: ${agg.regime.RANGE} coins (${(agg.regime.RANGE/agg.totalCoins*100).toFixed(0)}%)
  TRANSITION: ${agg.regime.TRANSITION} coins (${(agg.regime.TRANSITION/agg.totalCoins*100).toFixed(0)}%)

VOLATILITY STATE:
  COMPRESSED: ${agg.volState.COMPRESSED} coins (${(agg.volState.COMPRESSED/agg.totalCoins*100).toFixed(0)}%)
  NORMAL: ${agg.volState.NORMAL} coins (${(agg.volState.NORMAL/agg.totalCoins*100).toFixed(0)}%)
  EXPANDING: ${agg.volState.EXPANDING} coins (${(agg.volState.EXPANDING/agg.totalCoins*100).toFixed(0)}%)

RANGE POSITION:
  BOTTOM (<0.25): ${agg.rangePosition.BOTTOM} coins (${(agg.rangePosition.BOTTOM/agg.totalCoins*100).toFixed(0)}%)
  MIDDLE (0.25-0.75): ${agg.rangePosition.MIDDLE} coins (${(agg.rangePosition.MIDDLE/agg.totalCoins*100).toFixed(0)}%)
  TOP (>0.75): ${agg.rangePosition.TOP} coins (${(agg.rangePosition.TOP/agg.totalCoins*100).toFixed(0)}%)

SIGNAL QUALITY:
  Long-favourable conditions: ${agg.longFavourableCount}/${agg.totalCoins} coins
  Short-favourable conditions: ${agg.shortFavourableCount}/${agg.totalCoins} coins

AVERAGES:
  Hurst: ${agg.avgHurst.toFixed(3)} (${agg.avgHurst < 0.45 ? 'mean-reverting' : agg.avgHurst > 0.55 ? 'trending' : 'random walk'})
  ATR Compression: ${agg.avgAtrCompression.toFixed(3)}
  Vol Ratio (1h/1d): ${agg.avgVolRatio5d.toFixed(3)}

NOTABLE COINS:
  TOP OF RANGE: ${snapshots.filter(s => s.posInRangeBucket === 'TOP').slice(0, 8).map(s => `${s.symbol.replace('USDT','')} (${(s.posInRange60*100).toFixed(0)}%)`).join(', ')}
  BOTTOM OF RANGE: ${snapshots.filter(s => s.posInRangeBucket === 'BOTTOM').slice(0, 8).map(s => `${s.symbol.replace('USDT','')} (${(s.posInRange60*100).toFixed(0)}%)`).join(', ')}
  VOL EXPANDING: ${snapshots.filter(s => s.volState === 'EXPANDING').slice(0, 8).map(s => `${s.symbol.replace('USDT','')} (ATR ${s.atrCompression.toFixed(2)})`).join(', ')}
  VOL COMPRESSED: ${snapshots.filter(s => s.volState === 'COMPRESSED').slice(0, 8).map(s => `${s.symbol.replace('USDT','')} (ATR ${s.atrCompression.toFixed(2)})`).join(', ')}

REMINDER — PROVEN REGIME FILTER RULES (from scanner backtest):
  Position in Range (strongest predictor, ρ=1.0):
    LONGS: Best in Middle/Top (SR 1.4–3.7). Worst in Bottom (SR -1.0). 
    SHORTS: Best in Bottom (SR 5.9!). Worst in Top (SR -1.4).
  Vol State (ρ=1.0):
    All signals better in EXPANDING (SR 1.3) and NORMAL (SR 0.1). COMPRESSED hurts (SR -1.0).
  ATR Compression (ρ=1.0):
    Expanding vol = better signals. Compressed vol = bad signals.
  1h/1d Vol Ratio (ρ=1.0):
    Heated (>1.3) = bad for signals (SR -0.9). Calm/Normal = good.
`.trim();

      return NextResponse.json({ briefing, aggregate: agg, coins: snapshots });
    }

    if (action === "scorecard") {
      const tf = parseInt(searchParams.get("tf") || "60");
      const direction = searchParams.get("direction") || "all";
      
      const { rows } = await client.query(`
        SELECT feature_key, feature_label, direction_filter, bucket_index, bucket_label,
               oos_sharpe, oos_win_rate, oos_avg_ret, oos_trades,
               is_sharpe, is_trades, spread, rho, confidence,
               bar_minutes, strategy_label, total_signals, computed_at
        FROM regime_scorecard
        WHERE bar_minutes = $1 AND direction_filter = $2
        ORDER BY feature_key, bucket_index
      `, [tf, direction]);
      
      // Also get available timeframes and directions
      const { rows: meta } = await client.query(`
        SELECT DISTINCT bar_minutes, direction_filter, 
               COUNT(*)::int as rows, MAX(computed_at) as last_computed,
               MAX(total_signals)::int as total_signals
        FROM regime_scorecard
        GROUP BY bar_minutes, direction_filter
        ORDER BY bar_minutes, direction_filter
      `);
      
      // Load cached interpretations
      let interpretations: Record<string, string> = {};
      try {
        const { rows: intRows } = await client.query(`
          SELECT feature_key, interpretation 
          FROM regime_scorecard_interpretations
          WHERE bar_minutes = $1 AND direction_filter = $2
        `, [tf, direction]);
        for (const r of intRows) interpretations[r.feature_key] = r.interpretation;
      } catch {
        // Table might not exist yet
      }
      
      return NextResponse.json({ rows, meta, tf, direction, interpretations });
    }

    if (action === "scorecard-coins") {
      const tf = parseInt(searchParams.get("tf") || "60");
      const direction = searchParams.get("direction") || "all";
      const feature = searchParams.get("feature") || "";
      
      if (!feature) {
        return NextResponse.json({ error: "feature required" }, { status: 400 });
      }
      
      const { rows } = await client.query(`
        SELECT symbol, bucket_index, bucket_label, oos_sharpe, oos_win_rate, oos_avg_ret, oos_trades
        FROM regime_scorecard_coins
        WHERE bar_minutes = $1 AND direction_filter = $2 AND feature_key = $3
        ORDER BY symbol, bucket_index
      `, [tf, direction, feature]);
      
      return NextResponse.json({ rows, feature, tf, direction });
    }

    if (action === "scorecard-interpret") {
      // Save a cached interpretation
      const tf = parseInt(searchParams.get("tf") || "60");
      const direction = searchParams.get("direction") || "all";
      const feature = searchParams.get("feature") || "";
      const interpretation = searchParams.get("interpretation") || "";
      
      if (!feature || !interpretation) {
        return NextResponse.json({ error: "feature and interpretation required" }, { status: 400 });
      }
      
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS regime_scorecard_interpretations (
            id SERIAL PRIMARY KEY,
            bar_minutes INTEGER NOT NULL,
            direction_filter TEXT NOT NULL DEFAULT 'all',
            feature_key TEXT NOT NULL,
            interpretation TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE(bar_minutes, direction_filter, feature_key)
          )
        `);
        await client.query(`
          INSERT INTO regime_scorecard_interpretations (bar_minutes, direction_filter, feature_key, interpretation)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (bar_minutes, direction_filter, feature_key)
          DO UPDATE SET interpretation = $4, created_at = now()
        `, [tf, direction, feature, interpretation]);
        return NextResponse.json({ ok: true });
      } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    if (action === "market-narrative") {
      // Return cached narrative, or null if stale/missing
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS regime_market_narrative (
            id SERIAL PRIMARY KEY,
            headline TEXT NOT NULL,
            body TEXT NOT NULL,
            source_hash TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        const { rows: nRows } = await client.query(
          `SELECT headline, body, created_at FROM regime_market_narrative 
           WHERE created_at > now() - interval '30 minutes'
           ORDER BY created_at DESC LIMIT 1`
        );
        return NextResponse.json({ narrative: nRows[0] || null });
      } catch {
        return NextResponse.json({ narrative: null });
      }
    }

    if (action === "save-market-narrative") {
      const headline = searchParams.get("headline") || "";
      const body = searchParams.get("body") || "";
      if (!headline || !body) {
        return NextResponse.json({ error: "headline and body required" }, { status: 400 });
      }
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS regime_market_narrative (
            id SERIAL PRIMARY KEY,
            headline TEXT NOT NULL,
            body TEXT NOT NULL,
            source_hash TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        await client.query(
          `INSERT INTO regime_market_narrative (headline, body) VALUES ($1, $2)`,
          [headline, body]
        );
        return NextResponse.json({ ok: true });
      } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
