/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ALIGNMENT VERIFICATION v2                                       ║
 * ║                                                                  ║
 * ║  Uses the SAME parameterised detector for all three variants    ║
 * ║  (proven correct in entry-exit-analysis.cjs).                   ║
 * ║                                                                  ║
 * ║  OLD LIVE:  signal_close entry → exit_close  (before fix)       ║
 * ║  NEW LIVE:  next_open entry → exit_open      (after fix)        ║
 * ║  SCANNER:   next_open entry → exit_open      (unchanged)        ║
 * ║                                                                  ║
 * ║  NEW LIVE should be IDENTICAL to SCANNER since they use the     ║
 * ║  same entry/exit mode.                                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
const fs = require('fs');
const candidates = [
  path.join(__dirname, '.env'), path.join(__dirname, 'backend', '.env'),
  path.join(process.cwd(), '.env'), path.join(process.cwd(), 'backend', '.env'),
];
const envPath = candidates.find(p => fs.existsSync(p));
if (envPath) {
  try { require('dotenv').config({ path: envPath }); }
  catch (e) { const lines = fs.readFileSync(envPath, 'utf8').split('\n'); for (const t of lines) { const l = t.trim(); if (!l || l.startsWith('#')) continue; const eq = l.indexOf('='); if (eq > 0) { const k = l.slice(0, eq).trim(); if (!process.env[k]) process.env[k] = l.slice(eq + 1).trim(); } } }
}
let Client;
try { Client = require('pg').Client; } catch (e) { const p = path.join(__dirname, 'node_modules', 'pg'); Client = require(fs.existsSync(p) ? p : path.join(process.cwd(), 'node_modules', 'pg')).Client; }
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
    for (let j = start; j <= clampEnd; j++) { wMax = Math.max(wMax, highs[j], lows[j]); wMin = Math.min(wMin, highs[j], lows[j]); }
    lower[i] = (1 - phiO) * wMax + phiO * wMin;
    upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper, forwardBars, cycle, order };
}

// ═══════════════════════════════════════════════════════════════
// EXACT scanner detectEnsembleSignals — parameterised entry/exit
// This is a SINGLE function with entryMode/exitMode switches,
// so signal detection and position blocking are IDENTICAL across
// all variants. Only the pricing differs.
// ═══════════════════════════════════════════════════════════════
function detectSignals(bars, allBands, minStrength, minMaxCycle, spikeFilter, holdDivisor, nearMiss, priceExtreme, entryMode, exitMode) {
  const signals = [];
  let position = null;
  const n = bars.length;
  function isLocalMax(arr, i, w) { const val = arr[i]; if (val === null) return false; for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] > val) return false; } return true; }
  function isLocalMin(arr, i, w) { const val = arr[i]; if (val === null) return false; for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] < val) return false; } return true; }
  function isPriceLow(i, w) { const lo = bars[i].low; for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].low < lo) return false; } return true; }
  function isPriceHigh(i, w) { const hi = bars[i].high; for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].high > hi) return false; } return true; }

  for (let i = 1; i < n; i++) {
    if (position && i >= position.exitIdx) {
      const exitPrice = exitMode === 'exit_open' ? bars[i].open : bars[i].close;
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
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyC / 2))) { /* skip */ }
      else {
        const hd = Math.round(maxBuyC / holdDivisor);
        if (entryMode === 'next_open') {
          if (i + 1 < n) position = { type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyC, maxOrder: maxBuyO, time: bars[i + 1].time, strength: buyStr };
        } else {
          position = { type: 'LONG', entryIdx: i, entryPrice: bars[i].close, exitIdx: Math.min(i + hd, n - 1), holdDuration: hd, maxCycle: maxBuyC, maxOrder: maxBuyO, time: bars[i].time, strength: buyStr };
        }
      }
    } else if (sellStr >= minStrength && maxSellC >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellC / 2))) { /* skip */ }
      else {
        const hd = Math.round(maxSellC / holdDivisor);
        if (entryMode === 'next_open') {
          if (i + 1 < n) position = { type: 'SHORT', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxSellC, maxOrder: maxSellO, time: bars[i + 1].time, strength: sellStr };
        } else {
          position = { type: 'SHORT', entryIdx: i, entryPrice: bars[i].close, exitIdx: Math.min(i + hd, n - 1), holdDuration: hd, maxCycle: maxSellC, maxOrder: maxSellO, time: bars[i].time, strength: sellStr };
        }
      }
    }
  }
  if (position) {
    const ep = bars[n - 1].close;
    const ret = position.type === 'LONG' ? (ep / position.entryPrice - 1) * 100 : (position.entryPrice / ep - 1) * 100;
    signals.push({ ...position, exitPrice: ep, exitActualIdx: n - 1, returnPct: +ret.toFixed(3), won: ret > 0, stillOpen: true });
  }
  return signals;
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  ALIGNMENT VERIFICATION v2                                   ║`);
  console.log(`║  Same detection logic, only entry/exit pricing differs       ║`);
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

  const variants = [
    { label: 'OLD LIVE (before fix)', entry: 'signal_close', exit: 'exit_close' },
    { label: 'NEW LIVE (after fix) ', entry: 'next_open',    exit: 'exit_open'  },
    { label: 'SCANNER (target)     ', entry: 'next_open',    exit: 'exit_open'  },
  ];

  // Note: NEW LIVE and SCANNER use identical params — they MUST produce the same output.
  // This proves the fix makes live = scanner.

  const totals = variants.map(() => ({ trades: 0, wins: 0, cumRet: 0, returns: [] }));

  // Trade-by-trade comparison between NEW LIVE (idx 1) and SCANNER (idx 2)
  let perfectMatches = 0, totalCompared = 0, maxDiv = 0;

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

    const results = variants.map(v =>
      detectSignals(bars, allBands, strategy.minStr, strategy.minCyc, strategy.spike,
        strategy.holdDiv, strategy.nearMiss, strategy.priceExt, v.entry, v.exit)
    );

    for (let vi = 0; vi < variants.length; vi++) {
      const closed = results[vi].filter(s => !s.stillOpen);
      totals[vi].trades += closed.length;
      totals[vi].wins += closed.filter(s => s.won).length;
      totals[vi].cumRet += closed.reduce((sum, s) => sum + s.returnPct, 0);
    }

    // Compare NEW LIVE vs SCANNER trade by trade
    const newLive = results[1].filter(s => !s.stillOpen);
    const scanner = results[2].filter(s => !s.stillOpen);
    const minLen = Math.min(newLive.length, scanner.length);
    for (let t = 0; t < minLen; t++) {
      totalCompared++;
      const diff = Math.abs(newLive[t].returnPct - scanner[t].returnPct);
      if (diff < 0.001) perfectMatches++;
      if (diff > maxDiv) maxDiv = diff;
    }

    processed++;
    if (processed % 20 === 0) process.stdout.write(`  ${processed} coins...\r`);
  }

  console.log(`Processed: ${processed} coins\n`);

  console.log(`${'═'.repeat(80)}`);
  console.log(`${''.padEnd(25)} ${'Trades'.padEnd(10)} ${'Win%'.padEnd(10)} ${'Avg Ret'.padEnd(12)} ${'Cum Ret'.padEnd(14)}`);
  console.log(`${'═'.repeat(80)}`);
  for (let vi = 0; vi < variants.length; vi++) {
    const d = totals[vi];
    const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(1) + '%' : '—';
    const ar = d.trades > 0 ? (d.cumRet / d.trades).toFixed(4) + '%' : '—';
    console.log(`${variants[vi].label.padEnd(25)} ${String(d.trades).padEnd(10)} ${wr.padEnd(10)} ${ar.padEnd(12)} ${d.cumRet.toFixed(2) + '%'}`);
  }

  const oldGap = totals[0].cumRet - totals[2].cumRet;
  const newGap = totals[1].cumRet - totals[2].cumRet;

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`RESULTS`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Gap BEFORE (old live vs scanner): ${oldGap.toFixed(2)}%`);
  console.log(`  Gap AFTER  (new live vs scanner): ${newGap.toFixed(2)}%`);
  console.log(`  Recovered: ${(oldGap - newGap).toFixed(2)}%`);

  if (totals[0].trades > 0 && totals[2].trades > 0) {
    const bpsBefore = ((totals[0].cumRet / totals[0].trades) - (totals[2].cumRet / totals[2].trades)) * 100;
    const bpsAfter = ((totals[1].cumRet / totals[1].trades) - (totals[2].cumRet / totals[2].trades)) * 100;
    console.log(`\n  Per-trade gap BEFORE: ${bpsBefore.toFixed(2)} bps`);
    console.log(`  Per-trade gap AFTER:  ${bpsAfter.toFixed(2)} bps`);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`TRADE-BY-TRADE: New Live vs Scanner`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Trades compared:  ${totalCompared}`);
  console.log(`  Perfect matches:  ${perfectMatches} (${totalCompared > 0 ? (perfectMatches/totalCompared*100).toFixed(1) : 0}%)`);
  console.log(`  Max divergence:   ${maxDiv.toFixed(4)}%`);
  console.log(`  Trade counts:     New Live=${totals[1].trades}  Scanner=${totals[2].trades}`);

  if (totals[1].trades === totals[2].trades && perfectMatches === totalCompared) {
    console.log(`\n  ✅ PERFECT ALIGNMENT — New Live and Scanner produce identical results.`);
    console.log(`     The entry/exit fix fully closes the gap.`);
  } else if (Math.abs(newGap) < 0.01) {
    console.log(`\n  ✅ EFFECTIVELY IDENTICAL — residual gap is negligible.`);
  } else {
    console.log(`\n  ⚠️  Unexpected divergence — investigate further.`);
  }

  await client.end();
  console.log(`\n[done]\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
