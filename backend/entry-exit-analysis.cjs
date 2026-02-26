/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — ENTRY/EXIT IMPACT ANALYSIS                            ║
 * ║                                                                  ║
 * ║  Runs 4 variants of the same strategy over the FULL dataset     ║
 * ║  to isolate which difference costs the most:                     ║
 * ║                                                                  ║
 * ║  A: Scanner-style  (entry=next open, exit=exit open)            ║
 * ║  B: Live-style     (entry=signal close, exit=last close)        ║
 * ║  C: Hybrid 1       (entry=next open, exit=last close)           ║
 * ║  D: Hybrid 2       (entry=signal close, exit=exit open)         ║
 * ║                                                                  ║
 * ║  By comparing A vs C we isolate EXIT difference                 ║
 * ║  By comparing A vs D we isolate ENTRY difference                ║
 * ║  By comparing A vs B we see the combined effect                 ║
 * ║                                                                  ║
 * ║  Usage: node entry-exit-analysis.cjs                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
const fs = require('fs');

// ── ENV loading (same as forward test) ──
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
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) { const k = t.slice(0, eq).trim(); if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim(); }
    }
  }
}

let Client;
try { Client = require('pg').Client; }
catch (e) {
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
// PARAMETERISED signal detector — configurable entry/exit pricing
//
// entryMode: 'next_open' (scanner) or 'signal_close' (live)
// exitMode:  'exit_open' (scanner) or 'exit_close' (live)
// ═══════════════════════════════════════════════════════════════

function detectSignals(bars, allBands, minStrength, minMaxCycle, spikeFilter, holdDivisor, nearMiss, priceExtreme, entryMode, exitMode) {
  const signals = [];
  let position = null;
  const n = bars.length;

  function isLocalMax(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) {
      if (j === i) continue; if (arr[j] !== null && arr[j] > val) return false;
    }
    return true;
  }
  function isLocalMin(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) {
      if (j === i) continue; if (arr[j] !== null && arr[j] < val) return false;
    }
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
    // Close expired position
    if (position && i >= position.exitIdx) {
      const exitPrice = exitMode === 'exit_open' ? bars[i].open : bars[i].close;
      const ret = position.type === 'LONG'
        ? (exitPrice / position.entryPrice - 1) * 100
        : (position.entryPrice / exitPrice - 1) * 100;
      signals.push({
        ...position, exitPrice, exitActualIdx: i,
        returnPct: +ret.toFixed(3), won: ret > 0,
      });
      position = null;
    }
    if (position) continue;

    let buyStrength = 0, sellStrength = 0, maxBuyCycle = 0, maxSellCycle = 0;
    let maxBuyOrder = 0, maxSellOrder = 0;

    for (const band of allBands) {
      const lo = band.lower[i], up = band.upper[i];
      if (lo === null || up === null || up <= lo) continue;
      const bandWidth = (up - lo) / ((up + lo) / 2);
      if (bandWidth < 0.0001) continue;
      const sw = Math.round(band.cycle / 3);

      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i - 1] !== null &&
        bars[i - 1].low < band.lower[i - 1] && bars[i - 1].close > band.lower[i - 1]);
      if (buyAtI || buyNear) {
        if (spikeFilter) {
          const sH = isLocalMax(band.lower, i, sw);
          const sN = nearMiss && (isLocalMax(band.lower, i - 1, sw) || isLocalMax(band.lower, i + 1, sw));
          if (!sH && !sN) continue;
        }
        buyStrength++;
        if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle;
        if (band.order > maxBuyOrder) maxBuyOrder = band.order;
      }

      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i - 1] !== null &&
        bars[i - 1].high > band.upper[i - 1] && bars[i - 1].close < band.upper[i - 1]);
      if (sellAtI || sellNear) {
        if (spikeFilter) {
          const sH = isLocalMin(band.upper, i, sw);
          const sN = nearMiss && (isLocalMin(band.upper, i - 1, sw) || isLocalMin(band.upper, i + 1, sw));
          if (!sH && !sN) continue;
        }
        sellStrength++;
        if (band.cycle > maxSellCycle) maxSellCycle = band.cycle;
        if (band.order > maxSellOrder) maxSellOrder = band.order;
      }
    }

    if (buyStrength >= minStrength && maxBuyCycle >= minMaxCycle && buyStrength >= sellStrength) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) { /* skip */ }
      else {
        const hd = Math.round(maxBuyCycle / holdDivisor);
        if (entryMode === 'next_open' && i + 1 < n) {
          position = {
            type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open,
            exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd,
            maxCycle: maxBuyCycle, maxOrder: maxBuyOrder,
            time: bars[i + 1].time, strength: buyStrength,
          };
        } else if (entryMode === 'signal_close') {
          position = {
            type: 'LONG', entryIdx: i, entryPrice: bars[i].close,
            exitIdx: Math.min(i + hd, n - 1), holdDuration: hd,
            maxCycle: maxBuyCycle, maxOrder: maxBuyOrder,
            time: bars[i].time, strength: buyStrength,
          };
        }
      }
    } else if (sellStrength >= minStrength && maxSellCycle >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) { /* skip */ }
      else {
        const hd = Math.round(maxSellCycle / holdDivisor);
        if (entryMode === 'next_open' && i + 1 < n) {
          position = {
            type: 'SHORT', entryIdx: i + 1, entryPrice: bars[i + 1].open,
            exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd,
            maxCycle: maxSellCycle, maxOrder: maxSellOrder,
            time: bars[i + 1].time, strength: sellStrength,
          };
        } else if (entryMode === 'signal_close') {
          position = {
            type: 'SHORT', entryIdx: i, entryPrice: bars[i].close,
            exitIdx: Math.min(i + hd, n - 1), holdDuration: hd,
            maxCycle: maxSellCycle, maxOrder: maxSellOrder,
            time: bars[i].time, strength: sellStrength,
          };
        }
      }
    }
  }

  if (position) {
    const exitPrice = bars[n - 1].close;
    const ret = position.type === 'LONG'
      ? (exitPrice / position.entryPrice - 1) * 100
      : (position.entryPrice / exitPrice - 1) * 100;
    signals.push({
      ...position, exitPrice, exitActualIdx: n - 1,
      returnPct: +ret.toFixed(3), won: ret > 0, stillOpen: true,
    });
  }

  return signals;
}


// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  ENTRY/EXIT IMPACT ANALYSIS                                  ║`);
  console.log(`║  Which pricing difference costs the most?                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // Load active 1H strategy
  const { rows: stratRows } = await client.query(
    `SELECT * FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = 60
     ORDER BY "updatedAt" DESC LIMIT 1`
  );
  const s = stratRows[0];
  const strategy = s ? {
    minStr: s.minStr, minCyc: s.minCyc,
    spike: s.spike, nearMiss: s.nearMiss,
    holdDiv: s.holdDiv, priceExt: s.priceExt ?? true,
    cycleMin: s.cycleMin ?? 55, cycleMax: s.cycleMax ?? 89,
  } : {
    minStr: 1, minCyc: 0, spike: false, nearMiss: true,
    holdDiv: 4, priceExt: true, cycleMin: 10, cycleMax: 34,
  };

  console.log(`[STRATEGY] ${s ? s.name : 'defaults'}: ×${strategy.minStr} C≥${strategy.minCyc} spike=${strategy.spike} nearMiss=${strategy.nearMiss} ÷${strategy.holdDiv} priceExt=${strategy.priceExt}`);
  console.log(`  Cycles: ${strategy.cycleMin}–${strategy.cycleMax}\n`);

  // Get coins
  const { rows: coinRows } = await client.query(`SELECT DISTINCT symbol FROM "Candle1h" LIMIT 200`);
  const coins = coinRows.map(r => r.symbol);

  // 4 variants
  const variants = [
    { name: 'A: Scanner    (next_open → exit_open)',   entry: 'next_open',     exit: 'exit_open'  },
    { name: 'B: Live       (signal_close → exit_close)', entry: 'signal_close', exit: 'exit_close' },
    { name: 'C: Hybrid1    (next_open → exit_close)',  entry: 'next_open',     exit: 'exit_close' },
    { name: 'D: Hybrid2    (signal_close → exit_open)', entry: 'signal_close', exit: 'exit_open'  },
  ];

  const results = variants.map(v => ({
    ...v,
    totalTrades: 0, totalWins: 0, totalReturn: 0,
    coinCount: 0, returns: [],
  }));

  const barsNeeded = strategy.cycleMax * 8;
  let processed = 0;

  for (const symbol of coins) {
    const { rows } = await client.query(
      `SELECT timestamp as time, open, high, low, close
       FROM "Candle1h" WHERE symbol = $1
       ORDER BY timestamp DESC LIMIT $2`,
      [symbol, barsNeeded]
    );
    if (rows.length < 200) continue;

    const bars = rows.slice().reverse().map(r => ({
      time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close,
    }));

    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const allBands = [];
    for (let order = 1; order <= 6; order++) {
      for (let cycle = strategy.cycleMin; cycle <= strategy.cycleMax; cycle++) {
        allBands.push(computeFracmap(highs, lows, cycle, order));
      }
    }

    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi];
      const sigs = detectSignals(
        bars, allBands,
        strategy.minStr, strategy.minCyc,
        strategy.spike, strategy.holdDiv,
        strategy.nearMiss, strategy.priceExt,
        v.entry, v.exit
      );

      const closed = sigs.filter(s => !s.stillOpen);
      results[vi].totalTrades += closed.length;
      results[vi].totalWins += closed.filter(s => s.won).length;
      results[vi].totalReturn += closed.reduce((sum, s) => sum + s.returnPct, 0);
      for (const s of closed) results[vi].returns.push(s.returnPct);
      results[vi].coinCount++;
    }

    processed++;
    if (processed % 20 === 0) process.stdout.write(`  ${processed}/${coins.length} coins...\r`);
  }

  console.log(`\nProcessed ${processed} coins\n`);

  // ── Report ──
  console.log(`${'═'.repeat(80)}`);
  console.log(`${'Variant'.padEnd(48)} ${'Trades'.padEnd(8)} ${'Win%'.padEnd(8)} ${'AvgRet'.padEnd(10)} ${'CumRet'.padEnd(12)}`);
  console.log(`${'═'.repeat(80)}`);

  for (const r of results) {
    const winRate = r.totalTrades > 0 ? (r.totalWins / r.totalTrades * 100).toFixed(1) : '—';
    const avgRet = r.totalTrades > 0 ? (r.totalReturn / r.totalTrades).toFixed(3) : '—';
    console.log(`${r.name.padEnd(48)} ${String(r.totalTrades).padEnd(8)} ${(winRate + '%').padEnd(8)} ${(avgRet + '%').padEnd(10)} ${r.totalReturn.toFixed(2) + '%'}`);
  }

  // ── Isolate costs ──
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`COST ATTRIBUTION (how much each difference costs vs Scanner baseline)`);
  console.log(`${'═'.repeat(80)}`);

  const A = results[0]; // Scanner baseline
  const B = results[1]; // Live
  const C = results[2]; // next_open entry + exit_close
  const D = results[3]; // signal_close entry + exit_open

  const exitCost = A.totalReturn - C.totalReturn;
  const entryCost = A.totalReturn - D.totalReturn;
  const combinedCost = A.totalReturn - B.totalReturn;

  console.log(`
  Scanner baseline (A):  ${A.totalReturn.toFixed(2)}% cumulative

  1. EXIT PRICE DIFFERENCE (A vs C — same entry, different exit):
     Scanner exit (bar open):  ${A.totalReturn.toFixed(2)}%
     Live exit (bar close):    ${C.totalReturn.toFixed(2)}%
     → EXIT costs:             ${exitCost >= 0 ? '+' : ''}${exitCost.toFixed(2)}% 
     ${Math.abs(exitCost) > Math.abs(entryCost) ? '⚠️  EXIT IS THE BIGGER FACTOR' : ''}

  2. ENTRY PRICE DIFFERENCE (A vs D — different entry, same exit):
     Scanner entry (next open): ${A.totalReturn.toFixed(2)}%
     Live entry (signal close): ${D.totalReturn.toFixed(2)}%
     → ENTRY costs:             ${entryCost >= 0 ? '+' : ''}${entryCost.toFixed(2)}%
     ${Math.abs(entryCost) > Math.abs(exitCost) ? '⚠️  ENTRY IS THE BIGGER FACTOR' : ''}

  3. COMBINED (A vs B):
     Scanner (A):               ${A.totalReturn.toFixed(2)}%
     Live (B):                  ${B.totalReturn.toFixed(2)}%
     → Combined gap:            ${combinedCost >= 0 ? '+' : ''}${combinedCost.toFixed(2)}%
     → Sum of parts:            ${(exitCost + entryCost).toFixed(2)}%
     → Interaction effect:      ${(combinedCost - exitCost - entryCost).toFixed(2)}%

  Win rate comparison:
     A (Scanner):  ${(A.totalWins / A.totalTrades * 100).toFixed(1)}%
     B (Live):     ${(B.totalWins / B.totalTrades * 100).toFixed(1)}%
     C (Hybrid1):  ${(C.totalWins / C.totalTrades * 100).toFixed(1)}%
     D (Hybrid2):  ${(D.totalWins / D.totalTrades * 100).toFixed(1)}%
  `);

  // ── Trade count differences ──
  if (A.totalTrades !== B.totalTrades) {
    console.log(`  NOTE: Trade counts differ (A=${A.totalTrades}, B=${B.totalTrades}).`);
    console.log(`  The 'next_open' entry skips signal on the last bar (needs i+1 to exist).`);
    console.log(`  The 'signal_close' entry can trigger on the very last bar.`);
    console.log(`  Difference: ${Math.abs(A.totalTrades - B.totalTrades)} trades\n`);
  }

  // ── Recommendation ──
  console.log(`${'═'.repeat(80)}`);
  console.log(`RECOMMENDATION`);
  console.log(`${'═'.repeat(80)}`);

  if (Math.abs(combinedCost) < 5) {
    console.log(`  The gap is small (<5%). Entry/exit pricing is NOT the main issue.`);
    console.log(`  The -297% vs -77% gap from the forward test is likely from the`);
    console.log(`  live engine running ALL coins in parallel (more total trades).`);
  } else if (Math.abs(exitCost) > Math.abs(entryCost) * 1.5) {
    console.log(`  EXIT pricing is the dominant factor.`);
    console.log(`  → Fix the live engine to exit at next bar's OPEN instead of current CLOSE.`);
    console.log(`  → This matches the scanner and is more conservative.`);
  } else if (Math.abs(entryCost) > Math.abs(exitCost) * 1.5) {
    console.log(`  ENTRY pricing is the dominant factor.`);
    console.log(`  → Fix the live engine to enter at next bar's OPEN instead of signal CLOSE.`);
    console.log(`  → This is more realistic anyway (you can't enter at the close that triggered the signal).`);
  } else {
    console.log(`  Both ENTRY and EXIT contribute roughly equally.`);
    console.log(`  → Align the live engine to scanner: enter at next open, exit at exit open.`);
  }

  await client.end();
  console.log(`\n[done]\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
