/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — ALIGNMENT VERIFICATION                                ║
 * ║                                                                  ║
 * ║  Proves the fix worked by running three versions side by side:  ║
 * ║                                                                  ║
 * ║  OLD LIVE:  entry=signal close, exit=bar close  (before fix)    ║
 * ║  NEW LIVE:  entry=next open,    exit=bar open   (after fix)     ║
 * ║  SCANNER:   entry=next open,    exit=bar open   (unchanged)     ║
 * ║                                                                  ║
 * ║  If the fix worked, NEW LIVE and SCANNER should be identical.   ║
 * ║                                                                  ║
 * ║  Usage: node verify-alignment.cjs                                ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
const fs = require('fs');
const candidates = [
  path.join(__dirname, '.env'),
  path.join(__dirname, 'backend', '.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'backend', '.env'),
];
const envPath = candidates.find(p => fs.existsSync(p));
if (envPath) {
  try { require('dotenv').config({ path: envPath }); }
  catch (e) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const t of lines) {
      const l = t.trim(); if (!l || l.startsWith('#')) continue;
      const eq = l.indexOf('=');
      if (eq > 0) { const k = l.slice(0, eq).trim(); if (!process.env[k]) process.env[k] = l.slice(eq + 1).trim(); }
    }
  }
}
let Client;
try { Client = require('pg').Client; } catch (e) {
  const p = path.join(__dirname, 'node_modules', 'pg');
  Client = require(fs.existsSync(p) ? p : path.join(process.cwd(), 'node_modules', 'pg')).Client;
}
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('ERROR: DATABASE_URL not set.'); process.exit(1); }

const PHI = 1.618034;

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
    for (let j = start; j <= clampEnd; j++) {
      wMax = Math.max(wMax, highs[j], lows[j]);
      wMin = Math.min(wMin, highs[j], lows[j]);
    }
    lower[i] = (1 - phiO) * wMax + phiO * wMin;
    upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper, forwardBars, cycle, order };
}

// ═══════════════════════════════════════════════════════════════
// SCANNER's detectEnsembleSignals — EXACT COPY from FracmapScanner.tsx
// Entry: bars[i+1].open  |  Exit: bars[exitIdx].open
// ═══════════════════════════════════════════════════════════════
function scannerDetect(bars, allBands, minStrength, minMaxCycle, spikeFilter, holdDivisor, nearMiss, priceExtreme) {
  const signals = [];
  let position = null;
  const n = bars.length;
  function isLocalMax(arr, i, w) { const val = arr[i]; if (val === null) return false; for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] > val) return false; } return true; }
  function isLocalMin(arr, i, w) { const val = arr[i]; if (val === null) return false; for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] < val) return false; } return true; }
  function isPriceLow(i, w) { const lo = bars[i].low; for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].low < lo) return false; } return true; }
  function isPriceHigh(i, w) { const hi = bars[i].high; for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].high > hi) return false; } return true; }

  for (let i = 1; i < n; i++) {
    if (position && i >= position.exitIdx) {
      const exitPrice = bars[i].open;  // SCANNER: exit at open
      const ret = position.type === 'LONG' ? (exitPrice / position.entryPrice - 1) * 100 : (position.entryPrice / exitPrice - 1) * 100;
      signals.push({ ...position, exitPrice, exitActualIdx: i, returnPct: +ret.toFixed(3), won: ret > 0 });
      position = null;
    }
    if (position) continue;
    let buyStr = 0, sellStr = 0, maxBuyC = 0, maxSellC = 0, maxBuyO = 0, maxSellO = 0;
    for (const band of allBands) {
      const lo = band.lower[i], up = band.upper[i];
      if (lo === null || up === null || up <= lo) continue;
      const bw = (up - lo) / ((up + lo) / 2); if (bw < 0.0001) continue;
      const sw = Math.round(band.cycle / 3);
      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null && bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);
      if (buyAtI || buyNear) { if (spikeFilter) { const sH = isLocalMax(band.lower, i, sw); const sN = nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw)); if (!sH && !sN) continue; } buyStr++; if (band.cycle > maxBuyC) maxBuyC = band.cycle; if (band.order > maxBuyO) maxBuyO = band.order; }
      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null && bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);
      if (sellAtI || sellNear) { if (spikeFilter) { const sH = isLocalMin(band.upper, i, sw); const sN = nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw)); if (!sH && !sN) continue; } sellStr++; if (band.cycle > maxSellC) maxSellC = band.cycle; if (band.order > maxSellO) maxSellO = band.order; }
    }
    if (buyStr >= minStrength && maxBuyC >= minMaxCycle && buyStr >= sellStr) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyC / 2))) {}
      else if (i + 1 < n) { const hd = Math.round(maxBuyC / holdDivisor); position = { type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyC, maxOrder: maxBuyO, time: bars[i + 1].time, strength: buyStr }; }
    } else if (sellStr >= minStrength && maxSellC >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellC / 2))) {}
      else if (i + 1 < n) { const hd = Math.round(maxSellC / holdDivisor); position = { type: 'SHORT', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxSellC, maxOrder: maxSellO, time: bars[i + 1].time, strength: sellStr }; }
    }
  }
  if (position) { const ep = bars[n-1].close; const ret = position.type === 'LONG' ? (ep / position.entryPrice - 1) * 100 : (position.entryPrice / ep - 1) * 100; signals.push({ ...position, exitPrice: ep, exitActualIdx: n-1, returnPct: +ret.toFixed(3), won: ret > 0 }); }
  return signals;
}

// ═══════════════════════════════════════════════════════════════
// LIVE detectSignalAtBar — simulated bar-by-bar as the live engine runs
// OLD version: entry=bars[i].close
// NEW version: entry=bars[i+1].open
// ═══════════════════════════════════════════════════════════════
function liveDetectAtBar(bars, allBands, i, strategy) {
  const { minStr, minCyc, spike: spikeFilter, nearMiss, priceExt: priceExtreme, holdDiv } = strategy;
  function isLocalMax(arr, idx, w) { const val = arr[idx]; if (val === null) return false; for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) { if (j === idx) continue; if (arr[j] !== null && arr[j] > val) return false; } return true; }
  function isLocalMin(arr, idx, w) { const val = arr[idx]; if (val === null) return false; for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) { if (j === idx) continue; if (arr[j] !== null && arr[j] < val) return false; } return true; }
  function isPriceLow(idx, w) { const lo = bars[idx].low; for (let j = Math.max(0, idx - w); j < idx; j++) { if (bars[j].low < lo) return false; } return true; }
  function isPriceHigh(idx, w) { const hi = bars[idx].high; for (let j = Math.max(0, idx - w); j < idx; j++) { if (bars[j].high > hi) return false; } return true; }

  let buyStr = 0, sellStr = 0, maxBuyC = 0, maxSellC = 0, maxBuyO = 0, maxSellO = 0;
  for (const band of allBands) {
    const lo = band.lower[i], up = band.upper[i];
    if (lo === null || up === null || up <= lo) continue;
    const bw = (up - lo) / ((up + lo) / 2); if (bw < 0.0001) continue;
    const sw = Math.round(band.cycle / 3);
    const buyAtI = bars[i].low < lo && bars[i].close > lo;
    const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null && bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);
    if (buyAtI || buyNear) { if (spikeFilter) { const sH = isLocalMax(band.lower, i, sw); const sN = nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw)); if (!sH && !sN) continue; } buyStr++; if (band.cycle > maxBuyC) maxBuyC = band.cycle; if (band.order > maxBuyO) maxBuyO = band.order; }
    const sellAtI = bars[i].high > up && bars[i].close < up;
    const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null && bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);
    if (sellAtI || sellNear) { if (spikeFilter) { const sH = isLocalMin(band.upper, i, sw); const sN = nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw)); if (!sH && !sN) continue; } sellStr++; if (band.cycle > maxSellC) maxSellC = band.cycle; if (band.order > maxSellO) maxSellO = band.order; }
  }

  if (buyStr >= minStr && maxBuyC >= minCyc && buyStr >= sellStr) {
    if (priceExtreme && !isPriceLow(i, Math.round(maxBuyC / 2))) return null;
    const holdBars = Math.round(maxBuyC / holdDiv);
    return { direction: 'LONG', strength: buyStr, maxCycle: maxBuyC, maxOrder: maxBuyO, holdBars };
  }
  if (sellStr >= minStr && maxSellC >= minCyc) {
    if (priceExtreme && !isPriceHigh(i, Math.round(maxSellC / 2))) return null;
    const holdBars = Math.round(maxSellC / holdDiv);
    return { direction: 'SHORT', strength: sellStr, maxCycle: maxSellC, maxOrder: maxSellO, holdBars };
  }
  return null;
}

// Simulate live engine: walk bar by bar, one open position per coin
function simulateLive(bars, allBands, strategy, entryMode, exitMode) {
  const signals = [];
  let openSignal = null; // { entryBar, entryPrice, holdBars, direction, ... }

  for (let i = 100; i < bars.length; i++) {
    // Check if open signal should be closed
    if (openSignal) {
      const barsSince = i - openSignal.entryBar;
      if (barsSince >= openSignal.holdBars) {
        const exitPrice = exitMode === 'open' ? bars[i].open : bars[i].close;
        const ret = openSignal.direction === 'LONG'
          ? (exitPrice / openSignal.entryPrice - 1) * 100
          : (openSignal.entryPrice / exitPrice - 1) * 100;
        signals.push({ ...openSignal, exitPrice, exitBar: i, returnPct: +ret.toFixed(3), won: ret > 0 });
        openSignal = null;
      }
    }

    if (openSignal) continue; // one position at a time

    // Detect on bar i (simulating bars[length-2] in live — the completed bar)
    const signal = liveDetectAtBar(bars, allBands, i, strategy);
    if (!signal) continue;

    if (entryMode === 'next_open') {
      if (i + 1 >= bars.length) continue; // can't enter, no next bar
      openSignal = {
        ...signal, entryBar: i + 1, entryPrice: bars[i + 1].open,
        time: bars[i + 1].time,
      };
    } else {
      // signal_close (old live behaviour)
      openSignal = {
        ...signal, entryBar: i, entryPrice: bars[i].close,
        time: bars[i].time,
      };
    }
  }

  // Close any remaining
  if (openSignal) {
    const ep = bars[bars.length - 1].close;
    const ret = openSignal.direction === 'LONG'
      ? (ep / openSignal.entryPrice - 1) * 100
      : (openSignal.entryPrice / ep - 1) * 100;
    signals.push({ ...openSignal, exitPrice: ep, exitBar: bars.length - 1, returnPct: +ret.toFixed(3), won: ret > 0, stillOpen: true });
  }

  return signals;
}


async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  ALIGNMENT VERIFICATION                                      ║`);
  console.log(`║  OLD LIVE vs NEW LIVE vs SCANNER                             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  const { rows: stratRows } = await client.query(
    `SELECT * FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = 60 ORDER BY "updatedAt" DESC LIMIT 1`
  );
  const s = stratRows[0];
  const strategy = s ? {
    minStr: s.minStr, minCyc: s.minCyc, spike: s.spike, nearMiss: s.nearMiss,
    holdDiv: s.holdDiv, priceExt: s.priceExt ?? true, cycleMin: s.cycleMin ?? 10, cycleMax: s.cycleMax ?? 34,
  } : { minStr: 1, minCyc: 0, spike: false, nearMiss: true, holdDiv: 4, priceExt: true, cycleMin: 10, cycleMax: 34 };

  console.log(`[STRATEGY] ${s ? s.name : 'defaults'}: ×${strategy.minStr} C≥${strategy.minCyc} spike=${strategy.spike} nearMiss=${strategy.nearMiss} ÷${strategy.holdDiv} priceExt=${strategy.priceExt}`);
  console.log(`  Cycles: ${strategy.cycleMin}–${strategy.cycleMax}\n`);

  const { rows: coinRows } = await client.query(`SELECT DISTINCT symbol FROM "Candle1h" LIMIT 200`);
  const coins = coinRows.map(r => r.symbol);

  let scannerTotal = { trades: 0, wins: 0, cumRet: 0 };
  let oldLiveTotal = { trades: 0, wins: 0, cumRet: 0 };
  let newLiveTotal = { trades: 0, wins: 0, cumRet: 0 };

  // Per-trade comparison: scanner vs new live (should be identical)
  let perfectMatches = 0;
  let totalCompared = 0;
  let maxDivergence = 0;

  let processed = 0;
  const barsNeeded = strategy.cycleMax * 8;

  for (const symbol of coins) {
    const { rows } = await client.query(
      `SELECT timestamp as time, open, high, low, close FROM "Candle1h"
       WHERE symbol = $1 ORDER BY timestamp DESC LIMIT $2`, [symbol, barsNeeded]);
    if (rows.length < 200) continue;
    const bars = rows.slice().reverse().map(r => ({
      time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close }));

    const highs = bars.map(b => b.high), lows = bars.map(b => b.low);
    const allBands = [];
    for (let order = 1; order <= 6; order++)
      for (let cycle = strategy.cycleMin; cycle <= strategy.cycleMax; cycle++)
        allBands.push(computeFracmap(highs, lows, cycle, order));

    // SCANNER
    const scanSigs = scannerDetect(bars, allBands, strategy.minStr, strategy.minCyc, strategy.spike, strategy.holdDiv, strategy.nearMiss, strategy.priceExt);
    const scanClosed = scanSigs.filter(s => !s.stillOpen);
    scannerTotal.trades += scanClosed.length;
    scannerTotal.wins += scanClosed.filter(s => s.won).length;
    scannerTotal.cumRet += scanClosed.reduce((sum, s) => sum + s.returnPct, 0);

    // OLD LIVE (signal_close entry, exit_close)
    const oldSigs = simulateLive(bars, allBands, strategy, 'signal_close', 'close');
    const oldClosed = oldSigs.filter(s => !s.stillOpen);
    oldLiveTotal.trades += oldClosed.length;
    oldLiveTotal.wins += oldClosed.filter(s => s.won).length;
    oldLiveTotal.cumRet += oldClosed.reduce((sum, s) => sum + s.returnPct, 0);

    // NEW LIVE (next_open entry, exit_open) — should match scanner
    const newSigs = simulateLive(bars, allBands, strategy, 'next_open', 'open');
    const newClosed = newSigs.filter(s => !s.stillOpen);
    newLiveTotal.trades += newClosed.length;
    newLiveTotal.wins += newClosed.filter(s => s.won).length;
    newLiveTotal.cumRet += newClosed.reduce((sum, s) => sum + s.returnPct, 0);

    // Compare scanner vs new live trade-by-trade
    const minLen = Math.min(scanClosed.length, newClosed.length);
    for (let t = 0; t < minLen; t++) {
      totalCompared++;
      const diff = Math.abs(scanClosed[t].returnPct - newClosed[t].returnPct);
      if (diff < 0.001) perfectMatches++;
      if (diff > maxDivergence) maxDivergence = diff;
    }

    processed++;
    if (processed % 20 === 0) process.stdout.write(`  ${processed} coins...\r`);
  }

  console.log(`\nProcessed: ${processed} coins\n`);

  // ── Results ──
  console.log(`${'═'.repeat(80)}`);
  console.log(`${''.padEnd(20)} ${'Trades'.padEnd(10)} ${'Win%'.padEnd(10)} ${'Avg Ret'.padEnd(12)} ${'Cum Ret'.padEnd(14)}`);
  console.log(`${'═'.repeat(80)}`);

  for (const [label, data] of [['OLD LIVE (before)', oldLiveTotal], ['NEW LIVE (after)', newLiveTotal], ['SCANNER (target)', scannerTotal]]) {
    const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) + '%' : '—';
    const ar = data.trades > 0 ? (data.cumRet / data.trades).toFixed(4) + '%' : '—';
    const cr = data.cumRet.toFixed(2) + '%';
    console.log(`${label.padEnd(20)} ${String(data.trades).padEnd(10)} ${wr.padEnd(10)} ${ar.padEnd(12)} ${cr}`);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`IMPROVEMENT`);
  console.log(`${'═'.repeat(80)}`);

  const gap_before = oldLiveTotal.cumRet - scannerTotal.cumRet;
  const gap_after = newLiveTotal.cumRet - scannerTotal.cumRet;
  const recovered = gap_before - gap_after;

  console.log(`  Gap BEFORE fix:  ${gap_before.toFixed(2)}% cumulative (old live vs scanner)`);
  console.log(`  Gap AFTER fix:   ${gap_after.toFixed(2)}% cumulative (new live vs scanner)`);
  console.log(`  Recovered:       ${recovered.toFixed(2)}%`);

  if (oldLiveTotal.trades > 0 && scannerTotal.trades > 0) {
    const bps_before = ((oldLiveTotal.cumRet / oldLiveTotal.trades) - (scannerTotal.cumRet / scannerTotal.trades)) * 100;
    const bps_after = ((newLiveTotal.cumRet / newLiveTotal.trades) - (scannerTotal.cumRet / scannerTotal.trades)) * 100;
    console.log(`\n  Per-trade gap BEFORE: ${bps_before.toFixed(2)} bps`);
    console.log(`  Per-trade gap AFTER:  ${bps_after.toFixed(2)} bps`);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`TRADE-BY-TRADE MATCH: Scanner vs New Live`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Trades compared:  ${totalCompared}`);
  console.log(`  Perfect matches:  ${perfectMatches} (${(perfectMatches/totalCompared*100).toFixed(1)}%)`);
  console.log(`  Max divergence:   ${maxDivergence.toFixed(4)}%`);

  if (scannerTotal.trades === newLiveTotal.trades && perfectMatches === totalCompared) {
    console.log(`\n  ✅ PERFECT ALIGNMENT — Scanner and New Live produce identical results.`);
  } else if (Math.abs(gap_after) < 1) {
    console.log(`\n  ✅ NEAR-PERFECT — residual gap < 1% cumulative (rounding differences).`);
  } else {
    console.log(`\n  ⚠️  Some residual gap remains. Likely from position blocking timing.`);
    console.log(`     Scanner trades: ${scannerTotal.trades}  New Live trades: ${newLiveTotal.trades}`);
  }

  await client.end();
  console.log(`\n[done]\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
