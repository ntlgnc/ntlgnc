import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";
import { validateAdminRequest, unauthorizedResponse } from "@/lib/admin-auth";

const DB_URL = process.env.DATABASE_URL;
const PHI = 1.6180339887;

async function getClient(): Promise<Client> {
  if (!DB_URL) throw new Error("No DATABASE_URL");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

/* ── Core fracmap computation (with forward projection) ── */
function computeFracmap(highs: number[], lows: number[], cycle: number, order: number) {
  const zfracR = Math.round(cycle / 3.0);
  const phiO = Math.pow(PHI, order);
  const n = highs.length;
  const forwardBars = Math.round(cycle / 3);
  const totalLen = n + forwardBars;
  const lower: (number | null)[] = new Array(totalLen).fill(null);
  const upper: (number | null)[] = new Array(totalLen).fill(null);
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

/* ── Ensemble signal detection ── */
function detectEnsembleSignals(
  bars: any[], allBands: any[], minStrength = 1, minMaxCycle = 0,
  spikeFilter = false, holdDivisor = 2, nearMiss = false, priceExtreme = false
) {
  const signals: any[] = [];
  let position: any = null;
  const n = bars.length;

  function isLocalMax(arr: (number | null)[], i: number, w: number): boolean {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && (arr[j] as number) > val) return false; }
    return true;
  }
  function isLocalMin(arr: (number | null)[], i: number, w: number): boolean {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && (arr[j] as number) < val) return false; }
    return true;
  }
  function isPriceLow(i: number, w: number): boolean {
    const lo = bars[i].low;
    for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].low < lo) return false; }
    return true;
  }
  function isPriceHigh(i: number, w: number): boolean {
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

    let buyStrength = 0, sellStrength = 0, maxBuyCycle = 0, maxSellCycle = 0, maxBuyOrder = 0, maxSellOrder = 0;
    const buyBands: { cycle: number; order: number }[] = [];
    const sellBands: { cycle: number; order: number }[] = [];

    for (const band of allBands) {
      const lo = band.lower[i], up = band.upper[i];
      if (lo === null || up === null || up <= lo) continue;
      const bandWidth = (up - lo) / ((up + lo) / 2);
      if (bandWidth < 0.0001) continue;
      const sw = Math.round(band.cycle / 3);

      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i - 1] !== null && bars[i - 1].low < (band.lower[i - 1] as number) && bars[i - 1].close > (band.lower[i - 1] as number));
      if (buyAtI || buyNear) {
        if (spikeFilter) { const sH = isLocalMax(band.lower, i, sw); const sN = nearMiss && (isLocalMax(band.lower, i - 1, sw) || isLocalMax(band.lower, i + 1, sw)); if (!sH && !sN) continue; }
        buyStrength++; buyBands.push({ cycle: band.cycle, order: band.order });
        if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle;
        if (band.order > maxBuyOrder) maxBuyOrder = band.order;
      }

      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i - 1] !== null && bars[i - 1].high > (band.upper[i - 1] as number) && bars[i - 1].close < (band.upper[i - 1] as number));
      if (sellAtI || sellNear) {
        if (spikeFilter) { const sH = isLocalMin(band.upper, i, sw); const sN = nearMiss && (isLocalMin(band.upper, i - 1, sw) || isLocalMin(band.upper, i + 1, sw)); if (!sH && !sN) continue; }
        sellStrength++; sellBands.push({ cycle: band.cycle, order: band.order });
        if (band.cycle > maxSellCycle) maxSellCycle = band.cycle;
        if (band.order > maxSellOrder) maxSellOrder = band.order;
      }
    }

    if (buyStrength >= minStrength && maxBuyCycle >= minMaxCycle && buyStrength >= sellStrength) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / holdDivisor);
        position = { type: "LONG", entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, time: bars[i + 1].time, strength: buyStrength, triggerBands: buyBands };
      }
    } else if (sellStrength >= minStrength && maxSellCycle >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxSellCycle / holdDivisor);
        position = { type: "SHORT", entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxSellCycle, maxOrder: maxSellOrder, time: bars[i + 1].time, strength: sellStrength, triggerBands: sellBands };
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

/* ── Metrics calculation (time-series Sharpe) ── */
function calcMetrics(sigs: any[], bm: number, totalBars?: number) {
  if (sigs.length === 0) return { sharpe: 0, winRate: 0, totalRet: 0, trades: 0, profitFactor: 0 };
  const rets = sigs.map((s: any) => s.returnPct as number);
  const winRate = rets.filter(r => r > 0).length / rets.length * 100;
  let eq = 1; for (const r of rets) eq *= (1 + r / 100);
  const grossWin = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));

  const nBars = totalBars || (sigs.length > 0
    ? Math.max(...sigs.map((s: any) => (s.exitActualIdx ?? s.exitIdx ?? s.entryIdx + s.holdDuration) + 1))
    : 0);
  const barRets = new Float64Array(nBars);
  for (const sig of sigs) {
    const entry = sig.entryIdx;
    const exit = sig.exitActualIdx ?? sig.exitIdx ?? (entry + sig.holdDuration);
    const hold = Math.max(1, exit - entry);
    const perBar = (sig.returnPct as number) / hold;
    for (let b = entry; b < exit && b < nBars; b++) barRets[b] += perBar;
  }

  const barsPerDay = Math.round(1440 / Math.max(1, bm));
  const nDays = Math.max(1, Math.ceil(nBars / barsPerDay));
  const dailyRets: number[] = [];
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

/* ── Bar aggregation ── */
function aggregate(candles: any[], barMinutes: number) {
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

function candleTable(barMinutes: number): string {
  if (barMinutes === 1440) return "Candle1d";
  if (barMinutes === 60) return "Candle1h";
  return "Candle1m";
}

/* ── Build bands for all cycle/order combos ── */
function buildAllBands(highs: number[], lows: number[], cycleMin: number, cycleMax: number) {
  const bands: any[] = [];
  for (const order of [1, 2, 3, 4, 5, 6]) {
    for (let cycle = cycleMin; cycle <= cycleMax; cycle++) {
      const r = computeFracmap(highs, lows, cycle, order);
      bands.push({ cycle, order, ...r });
    }
  }
  return bands;
}

type Combo = { minStr: number; minCyc: number; spike: boolean; nearMiss: boolean; holdDiv: number; priceExt: boolean; key: string };

/* ═══════════════════════════════════════════════════════════════════
   POST /api/fracmap/compute — Admin-only server-side compute
   ═══════════════════════════════════════════════════════════════════ */

export async function POST(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }

  const { action } = body;

  /* ── ACTION: batchScan ──
     Compute IS results for one coin across all combos.
     Input: { bars, barMinutes, cycleMin, cycleMax, combos }
       - bars: pre-split IS bars (OHLCV array). Caller is responsible for splitting.
       OR: { symbol, barMinutes, cycleMin, cycleMax, splitPct, combos }
       - symbol: fetch from DB and split at splitPct.
     Output: { barsLoaded, comboMetrics } */
  if (action === "batchScan") {
    const { symbol, barMinutes, cycleMin, cycleMax, splitPct, combos, bars: inputBars } = body;
    if (!barMinutes || !cycleMin || !cycleMax || !combos?.length) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    let isBars: any[];
    let totalBars: number;
    let client: Client | null = null;

    if (inputBars?.length > 0) {
      // Use caller-provided bars directly (pre-split)
      isBars = inputBars;
      totalBars = inputBars.length;
    } else if (symbol) {
      client = await getClient();
      const table = candleTable(barMinutes);
      const { rows: candles } = await client.query(
        `SELECT timestamp,open,high,low,close,volume FROM "${table}" WHERE symbol=$1 ORDER BY timestamp`, [symbol]
      );
      const allBars = aggregate(candles, barMinutes);
      if (allBars.length < 50) { await client.end(); return NextResponse.json({ error: "Insufficient bars", barsLoaded: allBars.length }); }
      totalBars = allBars.length;
      const splitIdx = Math.round(allBars.length * (splitPct || 50) / 100);
      isBars = allBars.slice(0, splitIdx);
    } else {
      return NextResponse.json({ error: "Provide bars array or symbol" }, { status: 400 });
    }

    try {
      if (isBars.length < 50) return NextResponse.json({ error: "Insufficient IS bars" });

      const highs = isBars.map((b: any) => b.high);
      const lows = isBars.map((b: any) => b.low);
      const bands = buildAllBands(highs, lows, cycleMin, cycleMax);

      const comboMetrics: Record<string, any> = {};
      for (const combo of combos as Combo[]) {
        const sigs = detectEnsembleSignals(isBars, bands, combo.minStr, combo.minCyc, combo.spike, combo.holdDiv, combo.nearMiss, combo.priceExt);
        comboMetrics[combo.key] = calcMetrics(sigs, barMinutes, isBars.length);
      }

      return NextResponse.json({ symbol: symbol || "custom", barsLoaded: isBars.length, totalBars, comboMetrics });
    } finally {
      if (client) await client.end();
    }
  }

  /* ── ACTION: computeOOS ──
     Compute OOS (and optionally IS) results for one coin with a specific combo.
     Input: { bars, barMinutes, cycleMin, cycleMax, splitPct, combo, includeIS? }
       - bars: full bar array (will be split at splitPct), OR pre-split OOS bars
       OR: { symbol, barMinutes, cycleMin, cycleMax, splitPct, combo, includeIS? }
       - symbol: fetch from DB
     Output: { signals, metrics, oosBars, isSignals?, isMetrics? } */
  if (action === "computeOOS") {
    const { symbol, barMinutes, cycleMin, cycleMax, splitPct, combo, includeIS, bars: inputBars, preSplit } = body;
    if (!barMinutes || !cycleMin || !cycleMax || !combo) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    let oosBars: any[];
    let isBarsForIS: any[] | null = null;
    let client: Client | null = null;

    if (inputBars?.length > 0) {
      if (preSplit) {
        // Caller already split — inputBars IS the OOS portion
        oosBars = inputBars;
      } else {
        // Full bars provided, split here
        const splitIdx = Math.round(inputBars.length * (splitPct || 50) / 100);
        oosBars = inputBars.slice(splitIdx);
        if (includeIS) isBarsForIS = inputBars.slice(0, splitIdx);
      }
    } else if (symbol) {
      client = await getClient();
      const table = candleTable(barMinutes);
      const { rows: candles } = await client.query(
        `SELECT timestamp,open,high,low,close,volume FROM "${table}" WHERE symbol=$1 ORDER BY timestamp`, [symbol]
      );
      const allBars = aggregate(candles, barMinutes);
      const splitIdx = Math.round(allBars.length * (splitPct || 50) / 100);
      oosBars = allBars.slice(splitIdx);
      if (includeIS) isBarsForIS = allBars.slice(0, splitIdx);
    } else {
      return NextResponse.json({ error: "Provide bars array or symbol" }, { status: 400 });
    }

    try {
      if (oosBars.length < 50) return NextResponse.json({ error: "Insufficient OOS bars", barsAvailable: oosBars.length });

      const oosHighs = oosBars.map((b: any) => b.high);
      const oosLows = oosBars.map((b: any) => b.low);
      const oosBandData = buildAllBands(oosHighs, oosLows, cycleMin, cycleMax);
      const oosSigs = detectEnsembleSignals(oosBars, oosBandData, combo.minStr, combo.minCyc, combo.spike, combo.holdDiv, combo.nearMiss, combo.priceExt);
      const oosMetrics = calcMetrics(oosSigs, barMinutes, oosBars.length);

      const result: any = {
        symbol: symbol || "custom",
        oosBarsCount: oosBars.length,
        oosSignals: oosSigs,
        oosMetrics: oosMetrics,
        oosBars: oosBars,
      };

      if (includeIS && isBarsForIS && isBarsForIS.length >= 50) {
        const isHighs = isBarsForIS.map((b: any) => b.high);
        const isLows = isBarsForIS.map((b: any) => b.low);
        const isBandData = buildAllBands(isHighs, isLows, cycleMin, cycleMax);
        const isSigs = detectEnsembleSignals(isBarsForIS, isBandData, combo.minStr, combo.minCyc, combo.spike, combo.holdDiv, combo.nearMiss, combo.priceExt);
        result.isSignals = isSigs;
        result.isBars = isBarsForIS;
      }

      return NextResponse.json(result);
    } finally {
      if (client) await client.end();
    }
  }

  /* ── ACTION: liveDetect ──
     For FracmapLive: compute signals and bands for chart rendering.
     Input: { symbol, barMinutes, cycleMin, cycleMax, minStr, minCyc, spike, nearMiss, holdDiv, priceExt, viewBars? }
     Output: { bars (OHLCV), signals, bands (per cycle/order with lower/upper arrays) } */
  if (action === "liveDetect") {
    const { symbol, barMinutes, cycleMin, cycleMax, minStr, minCyc, spike, nearMiss, holdDiv, priceExt, viewBars: reqViewBars } = body;
    if (!symbol || !barMinutes || !cycleMin || !cycleMax) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const viewBars = reqViewBars || 500;
    const maxCycle = cycleMax;
    const holdDivisor = holdDiv || 2;
    const bandWarmup = 7 * Math.round(maxCycle / 3);
    const maxHold = Math.round(maxCycle / holdDivisor);
    const chainConvergence = 30 * maxHold;
    const fetchLimit = Math.max(viewBars, Math.round((bandWarmup + chainConvergence) * 1.2));

    const client = await getClient();
    try {
      const table = candleTable(barMinutes);
      const { rows: candles } = await client.query(
        `SELECT timestamp,open,high,low,close,volume FROM "${table}" WHERE symbol=$1 ORDER BY timestamp DESC LIMIT $2`,
        [symbol, fetchLimit]
      );
      candles.reverse();

      const bars = aggregate(candles, barMinutes);
      if (bars.length < 50) return NextResponse.json({ error: "Insufficient bars" });

      const highs = bars.map((b: any) => b.high);
      const lows = bars.map((b: any) => b.low);
      const allBandData = buildAllBands(highs, lows, cycleMin, cycleMax);

      const sigs = detectEnsembleSignals(bars, allBandData, minStr || 1, minCyc || 0, spike || false, holdDivisor, nearMiss || false, priceExt || false);

      // Return bands with windowed lower/upper arrays (full length for chart rendering)
      const bands = allBandData.map((b: any) => ({
        cycle: b.cycle,
        order: b.order,
        lower: b.lower,
        upper: b.upper,
        forwardBars: b.forwardBars,
      }));

      return NextResponse.json({
        bars,
        signals: sigs,
        bands,
        totalBars: bars.length,
      });
    } finally {
      await client.end();
    }
  }

  /* ── ACTION: topography ──
     Interactive topography explorer: compute bands + signals + metrics for custom params.
     Input: { symbol, barMinutes, bars?, cycleMin, cycleMax, cycleStep, enabledOrders,
              minStr, minCyc, spike, nearMiss, holdDiv, limit? }
     Output: { bars, bands, signals, metrics, maxForward } */
  if (action === "topography") {
    const { symbol, barMinutes, cycleMin, cycleMax, cycleStep: cStep, enabledOrders,
            minStr, minCyc, spike, nearMiss, holdDiv, bars: inputBars, limit } = body;

    let bars: any[];
    let client: Client | null = null;

    if (inputBars?.length > 0) {
      bars = inputBars;
    } else if (symbol && barMinutes) {
      client = await getClient();
      const table = candleTable(barMinutes);
      const fetchLimit = limit || 2000;
      const { rows: candles } = await client.query(
        `SELECT timestamp,open,high,low,close,volume FROM "${table}" WHERE symbol=$1 ORDER BY timestamp DESC LIMIT $2`,
        [symbol, fetchLimit]
      );
      candles.reverse();
      bars = aggregate(candles, barMinutes);
    } else {
      return NextResponse.json({ error: "Provide bars array or symbol+barMinutes" }, { status: 400 });
    }

    try {
      if (bars.length < 50) return NextResponse.json({ error: "Insufficient bars", barsLoaded: bars.length });

      const highs = bars.map((b: any) => b.high);
      const lows = bars.map((b: any) => b.low);
      const orders = enabledOrders || [1, 2, 3, 4, 5, 6];
      const step = cStep || 1;
      const cMin = cycleMin || 10;
      const cMax = cycleMax || 200;
      const holdDivisor = holdDiv || 2;

      const bands: any[] = [];
      let maxForward = 0;
      for (const order of orders) {
        for (let cycle = cMin; cycle <= cMax; cycle += step) {
          const r = computeFracmap(highs, lows, cycle, order);
          bands.push({ cycle, order, lower: r.lower, upper: r.upper, forwardBars: r.forwardBars });
          if (r.forwardBars > maxForward) maxForward = r.forwardBars;
        }
      }

      const sigs = detectEnsembleSignals(bars, bands, minStr || 1, minCyc || 0, spike || false, holdDivisor, nearMiss || false, false);

      // Add cumulative return
      let cumEquity = 1;
      for (const sig of sigs) {
        cumEquity *= (1 + sig.returnPct / 100);
        sig.cumReturn = +((cumEquity - 1) * 100).toFixed(3);
      }

      const rets = sigs.map((s: any) => s.returnPct);
      const wins = rets.filter((r: number) => r > 0);
      const totalRet = rets.reduce((s: number, r: number) => s + r, 0);
      const avgRet = rets.length > 0 ? totalRet / rets.length : 0;
      const winRate = rets.length > 0 ? (wins.length / rets.length * 100) : 0;
      const MINS_PER_YEAR = 525600;
      const std = rets.length > 1 ? Math.sqrt(rets.reduce((s: number, r: number) => s + (r - avgRet) ** 2, 0) / rets.length) : 0;
      const avgHoldMins = sigs.length > 0
        ? sigs.reduce((s: number, sig: any) => s + sig.holdDuration * (barMinutes || 15), 0) / sigs.length
        : 1;
      const annFactor = Math.sqrt(MINS_PER_YEAR / avgHoldMins);
      const sharpe = std > 0 ? (avgRet / std) * annFactor : 0;

      let equity = 1, peak = 1, maxDD = 0;
      for (const r of rets) {
        equity *= (1 + r / 100);
        if (equity > peak) peak = equity;
        const dd = (peak - equity) / peak;
        if (dd > maxDD) maxDD = dd;
      }

      const metrics = {
        trades: sigs.length,
        longs: sigs.filter((s: any) => s.type === "LONG").length,
        shorts: sigs.filter((s: any) => s.type === "SHORT").length,
        winRate: +winRate.toFixed(1),
        avgRet: +avgRet.toFixed(3),
        totalRet: +((equity - 1) * 100).toFixed(2),
        maxDD: +(maxDD * 100).toFixed(2),
        sharpe: +sharpe.toFixed(3),
      };

      return NextResponse.json({ bars, bands, signals: sigs, metrics, maxForward });
    } finally {
      if (client) await client.end();
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
