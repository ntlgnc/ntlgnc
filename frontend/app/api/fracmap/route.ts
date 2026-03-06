import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";
import { validateAdminRequest, unauthorizedResponse } from "@/lib/admin-auth";

const DB_URL = process.env.DATABASE_URL;
const PHI = 1.618034;

async function getClient() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

/* ─── Core fracmap computation ─── */
function computeFracmap(highs: number[], lows: number[], cycle: number, order: number) {
  const zfracR = Math.round(cycle / 3.0);  // Original: cycle/(1+2*order) with order=1 → cycle/3
  const phiO = Math.pow(PHI, order);
  const n = highs.length;
  const lower: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);
  const minIdx = (order + 1) * zfracR;
  for (let i = minIdx; i < n; i++) {
    const start = i - (order + 1) * zfracR;
    const end = i - order * zfracR;
    let wMax = -Infinity, wMin = Infinity;
    for (let j = start; j <= end; j++) {
      wMax = Math.max(wMax, highs[j], lows[j]);
      wMin = Math.min(wMin, highs[j], lows[j]);
    }
    lower[i] = (1 - phiO) * wMax + phiO * wMin;
    upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper };
}

function detectSignals(bars: any[], lower: (number | null)[], upper: (number | null)[], cycle: number) {
  const signals: any[] = [];
  let positionExpiresAt = -1;
  for (let i = 1; i < bars.length; i++) {
    if (i < positionExpiresAt) continue;
    // Skip if bands are touching or crossed (upper <= lower means no valid channel)
    if (lower[i] === null || upper[i] === null) continue;
    if (upper[i]! <= lower[i]!) continue;
    if (bars[i].low < lower[i]! && bars[i].close > lower[i]!) {
      signals.push({ idx: i, type: "BUY", price: bars[i].close, time: bars[i].time });
      positionExpiresAt = i + cycle;
    } else if (bars[i].high > upper[i]! && bars[i].close < upper[i]!) {
      signals.push({ idx: i, type: "SELL", price: bars[i].close, time: bars[i].time });
      positionExpiresAt = i + cycle;
    }
  }
  return signals;
}

function aggregate(candles: any[], barMinutes: number) {
  // For 1H (60) and 1D (1440), data comes pre-aggregated from Candle1h/Candle1d
  if (barMinutes === 60 || barMinutes === 1440) {
    return candles.map((c: any) => ({
      time: c.timestamp, open: c.open, high: c.high,
      low: c.low, close: c.close, volume: c.volume,
    }));
  }
  const bars: any[] = [];
  for (let i = 0; i <= candles.length - barMinutes; i += barMinutes) {
    const slice = candles.slice(i, i + barMinutes);
    bars.push({
      time: slice[0].timestamp, open: slice[0].open,
      high: Math.max(...slice.map((c: any) => c.high)),
      low: Math.min(...slice.map((c: any) => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s: number, c: any) => s + c.volume, 0),
    });
  }
  return bars;
}

/** Pick the right candle table based on bar size */
function candleTable(barMinutes: number): string {
  if (barMinutes === 1440) return "Candle1d";
  if (barMinutes === 60) return "Candle1h";
  return "Candle1m";
}

function backtest(bars: any[], cycle: number, order: number, barMinutes: number = 1) {
  const { lower, upper } = computeFracmap(bars.map(b => b.high), bars.map(b => b.low), cycle, order);
  const signals = detectSignals(bars, lower, upper, cycle);
  const n = bars.length;
  const trades: any[] = [];
  for (const sig of signals) {
    const exitIdx = Math.min(sig.idx + cycle, n - 1);
    const ret = sig.type === "BUY"
      ? (bars[exitIdx].close / bars[sig.idx].close) - 1
      : (bars[sig.idx].close / bars[exitIdx].close) - 1;
    trades.push({ ...sig, ret });
  }
  if (!trades.length) return null;
  const rets = trades.map(t => t.ret);
  const wins = rets.filter(r => r > 0);
  const losses = rets.filter(r => r <= 0);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length);
  const gp = wins.reduce((s, r) => s + r, 0);
  const gl = Math.abs(losses.reduce((s, r) => s + r, 0));
  let equity = 1, peak = 1, maxDD = 0;
  for (const r of rets) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  // Annualize Sharpe: trade duration = cycle * barMinutes minutes
  // Trades per year = 525600 / (cycle * barMinutes)
  const tradesPerYear = 525600 / (cycle * barMinutes);
  const rawSharpe = std > 0 ? mean / std : 0;
  const annualizedSharpe = rawSharpe * Math.sqrt(tradesPerYear);
  return {
    total: trades.length, buys: trades.filter(t => t.type === "BUY").length,
    sells: trades.filter(t => t.type === "SELL").length,
    winRate: +(wins.length / rets.length * 100).toFixed(1),
    avgRet: +(mean * 100).toFixed(3),
    totalRet: +((equity - 1) * 100).toFixed(2),
    maxDrawdown: +(maxDD * 100).toFixed(2),
    maxWin: +(Math.max(...rets) * 100).toFixed(2),
    maxLoss: +(Math.min(...rets) * 100).toFixed(2),
    profitFactor: gl > 0 ? +(gp / gl).toFixed(2) : null,
    sharpe: +annualizedSharpe.toFixed(2),
  };
}

export async function GET(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  if (!DB_URL) return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "scan";
  const client = await getClient();

  try {
    /* ═══ ACTION: scan ═══ */
    if (action === "scan" || action === "strategies") {
      const bms = [1, 5, 15, 60, 1440];
      const cycs = [20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 100];
      const ords = [1, 2, 3, 4, 5, 6];
      const minTrades = parseInt(searchParams.get("minTrades") || "5");
      const filterBm = parseInt(searchParams.get("barMinutes") || "0");
      const mode = searchParams.get("mode") || "basic";

      // Get symbols from the most populated table
      const { rows: syms } = await client.query(
        `SELECT symbol, COUNT(*)::int as cnt FROM "Candle1m"
         WHERE symbol NOT LIKE 'i%' GROUP BY symbol HAVING COUNT(*) >= 5000
         ORDER BY cnt DESC`
      );

      const results: any[] = [];
      const symbolList: string[] = syms.map((s: any) => s.symbol);

      for (const si of syms) {
        const bmsToRun = filterBm > 0 ? [filterBm] : bms;

        // Cache candles per table to avoid re-fetching
        const tableCache: Record<string, any[]> = {};
        for (const bm of bmsToRun) {
          const table = candleTable(bm);
          if (!tableCache[table]) {
            const { rows: candles } = await client.query(
              `SELECT timestamp,open,high,low,close,volume FROM "${table}"
               WHERE symbol=$1 ORDER BY timestamp`, [si.symbol]
            );
            tableCache[table] = candles;
          }
          const bars = aggregate(tableCache[table], bm);
          if (bars.length < 200) continue;
          for (const o of ords) for (const c of cycs) {
            if (bars.length < c * 3) continue;
            const m = backtest(bars, c, o, bm);
            if (!m || m.total < minTrades) continue;
            results.push({
              symbol: si.symbol, barMinutes: bm, cycle: c, order: o,
              effectiveMinutes: bm * c, mode, ...m,
            });
          }
        }
      }

      results.sort((a, b) => b.sharpe - a.sharpe);
      await client.end();
      return NextResponse.json({
        results: results.slice(0, 200),
        symbols: symbolList,
        count: results.length,
      });
    }

    /* ═══ ACTION: chart ═══ */
    if (action === "chart") {
      const symbol = searchParams.get("symbol") || "BTCUSDT";
      const cycle = parseInt(searchParams.get("cycle") || "75");
      const order = parseInt(searchParams.get("order") || "2");
      const barMinutes = parseInt(searchParams.get("barMinutes") || "15");
      const limit = parseInt(searchParams.get("limit") || "200");

      // Fetch candles from the appropriate table
      const table = candleTable(barMinutes);
      const { rows: candles } = await client.query(
        `SELECT timestamp,open,high,low,close,volume FROM "${table}"
         WHERE symbol=$1 ORDER BY timestamp`,
        [symbol]
      );

      const bars = aggregate(candles, barMinutes);
      const { lower, upper } = computeFracmap(
        bars.map(b => b.high), bars.map(b => b.low), cycle, order
      );
      const sigs = detectSignals(bars, lower, upper, cycle);

      // Enrich ALL signals with exit info
      const enrichedSigs = sigs.map(s => {
        const exitIdx = Math.min(s.idx + cycle, bars.length - 1);
        const ret = s.type === "BUY"
          ? (bars[exitIdx].close / bars[s.idx].close - 1) * 100
          : (bars[s.idx].close / bars[exitIdx].close - 1) * 100;
        return {
          ...s, exitIdx, exitPrice: bars[exitIdx].close,
          exitTime: bars[exitIdx].time, returnPct: +ret.toFixed(3), won: ret > 0,
        };
      });

      // Window chart bars — center on a specific bar if requested, else show latest
      const centerBar = searchParams.get("centerBar") ? parseInt(searchParams.get("centerBar")!) : null;
      let start: number, end: number;
      if (centerBar !== null) {
        const half = Math.floor(limit / 2);
        start = Math.max(0, centerBar - half);
        end = Math.min(bars.length, start + limit);
        start = Math.max(0, end - limit); // re-adjust if near end
      } else {
        end = bars.length;
        start = Math.max(0, end - limit);
      }
      const chartBars = bars.slice(start, end).map((b, i) => ({
        ...b, lower: lower[start + i], upper: upper[start + i],
      }));
      // Signals visible on the chart (re-indexed to chart coordinates)
      const chartSigs = enrichedSigs
        .filter(s => s.idx >= start && s.idx < end)
        .map(s => ({ ...s, idx: s.idx - start, exitIdx: s.exitIdx - start }));
      // ALL signals for the list (with original bar indices for reference)
      const allSigs = enrichedSigs.map(s => ({
        type: s.type, price: s.price, time: s.time,
        exitTime: s.exitTime, exitPrice: s.exitPrice,
        returnPct: s.returnPct, won: s.won,
        barIdx: s.idx, // original index in full history
        inView: s.idx >= start && s.idx < end,
        chartIdx: s.idx >= start && s.idx < end ? s.idx - start : null,
      }));
      const metrics = backtest(bars, cycle, order, barMinutes);

      await client.end();
      return NextResponse.json({ bars: chartBars, signals: chartSigs, allSignals: allSigs, metrics });
    }

    /* ═══ ACTION: live ═══
       Returns 1m bars with fracmap bands projected from aggregated timeframe */
    if (action === "live") {
      const symbol = searchParams.get("symbol") || "BTCUSDT";
      const cycle = parseInt(searchParams.get("cycle") || "75");
      const order = parseInt(searchParams.get("order") || "2");
      const barMinutes = parseInt(searchParams.get("barMinutes") || "15");
      const viewBars = parseInt(searchParams.get("viewBars") || "180");

      const lookback = (order + 2) * Math.round(cycle / 3) * (barMinutes >= 60 ? 1 : barMinutes);
      const total = barMinutes >= 60
        ? viewBars + lookback + 2  // for 1H/1D, we fetch from that table directly
        : viewBars + lookback + barMinutes * 2;

      const table = candleTable(barMinutes);
      const { rows: candles } = await client.query(
        `SELECT timestamp,open,high,low,close,volume FROM "${table}"
         WHERE symbol=$1 ORDER BY timestamp DESC LIMIT $2`,
        [symbol, total]
      );
      candles.reverse();

      // Compute fracmap on aggregated bars
      const aggBars = aggregate(candles, barMinutes);
      const { lower, upper } = computeFracmap(
        aggBars.map(b => b.high), aggBars.map(b => b.low), cycle, order
      );

      // Map fracmap values onto 1m candles
      const liveBars = candles.slice(-viewBars).map((c: any) => {
        const cTime = new Date(c.timestamp).getTime();
        let fl: number | null = null, fu: number | null = null;
        for (let j = aggBars.length - 1; j >= 0; j--) {
          if (cTime >= new Date(aggBars[j].time).getTime()) {
            fl = lower[j]; fu = upper[j]; break;
          }
        }
        return {
          time: c.timestamp, open: c.open, high: c.high, low: c.low,
          close: c.close, volume: c.volume, lower: fl, upper: fu,
        };
      });

      // Detect signals on aggregated bars and map to 1m times
      const sigs = detectSignals(aggBars, lower, upper, cycle);
      const recentSigs = sigs.slice(-10).map(s => ({
        type: s.type, price: s.price, time: s.time,
      }));

      // Current price info
      const lastCandle = candles[candles.length - 1];
      const lastAgg = aggBars[aggBars.length - 1];
      const currentBandLower = lower[aggBars.length - 1];
      const currentBandUpper = upper[aggBars.length - 1];
      const distLower = currentBandLower != null
        ? +((lastCandle.close - currentBandLower) / lastCandle.close * 100).toFixed(3) : null;
      const distUpper = currentBandUpper != null
        ? +((currentBandUpper - lastCandle.close) / lastCandle.close * 100).toFixed(3) : null;

      await client.end();
      return NextResponse.json({
        candles: liveBars,
        signals: recentSigs,
        lastUpdated: lastCandle?.timestamp || null,
        currentPrice: lastCandle?.close,
        bandDistance: { lower: distLower, upper: distUpper },
      });
    }

    await client.end();
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  } catch (err: any) {
    await client.end().catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
