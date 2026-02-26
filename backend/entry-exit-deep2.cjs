/**
 * DEEPER ANALYSIS: What exactly are the 270 extra trades doing?
 * And per-trade, is signal_close or next_open the better entry?
 * 
 * Usage: node entry-exit-deep.cjs
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

// Detect signals — returns signal bar index + signal info (NO position management)
// This just tells us: at bar i, would a signal fire?
function detectAllSignalBars(bars, allBands, strategy) {
  const { minStr, minCyc, spike: spikeFilter, nearMiss, priceExt: priceExtreme, holdDiv } = strategy;
  const signals = [];
  const n = bars.length;

  function isLocalMax(arr, idx, w) {
    const val = arr[idx]; if (val === null) return false;
    for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) {
      if (j === idx) continue; if (arr[j] !== null && arr[j] > val) return false;
    }
    return true;
  }
  function isLocalMin(arr, idx, w) {
    const val = arr[idx]; if (val === null) return false;
    for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) {
      if (j === idx) continue; if (arr[j] !== null && arr[j] < val) return false;
    }
    return true;
  }
  function isPriceLow(idx, w) {
    const lo = bars[idx].low;
    for (let j = Math.max(0, idx - w); j < idx; j++) { if (bars[j].low < lo) return false; }
    return true;
  }
  function isPriceHigh(idx, w) {
    const hi = bars[idx].high;
    for (let j = Math.max(0, idx - w); j < idx; j++) { if (bars[j].high > hi) return false; }
    return true;
  }

  // Walk WITH position blocking (matches scanner exactly)
  let position = null;

  for (let i = 1; i < n; i++) {
    // Close expired position (using exit_open to match scanner)
    if (position && i >= position.exitIdx) {
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
        buyStrength++; if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle;
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
        sellStrength++; if (band.cycle > maxSellCycle) maxSellCycle = band.cycle;
        if (band.order > maxSellOrder) maxSellOrder = band.order;
      }
    }

    let direction = null, maxCycle = 0;
    if (buyStrength >= minStr && maxBuyCycle >= minCyc && buyStrength >= sellStrength) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) continue;
      direction = 'LONG'; maxCycle = maxBuyCycle;
    } else if (sellStrength >= minStr && maxSellCycle >= minCyc) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) continue;
      direction = 'SHORT'; maxCycle = maxSellCycle;
    }

    if (direction) {
      const hd = Math.round(maxCycle / holdDiv);

      // Compute return for BOTH entry methods, with BOTH exit methods
      const entryClose = bars[i].close;
      const entryNextOpen = (i + 1 < n) ? bars[i + 1].open : null;

      // Scanner exit index: entryIdx + hd
      // For next_open: entryIdx = i+1, exitIdx = i+1+hd
      // For signal_close: entryIdx = i, exitIdx = i+hd
      const exitIdxScanner = Math.min(i + 1 + hd, n - 1);  // scanner style
      const exitIdxLive = Math.min(i + hd, n - 1);          // live style

      const exitOpen_scanner = bars[exitIdxScanner].open;
      const exitClose_scanner = bars[exitIdxScanner].close;
      const exitOpen_live = bars[exitIdxLive].open;
      const exitClose_live = bars[exitIdxLive].close;

      function calcRet(entry, exit, dir) {
        if (entry == null || exit == null) return null;
        return dir === 'LONG' ? (exit / entry - 1) * 100 : (entry / exit - 1) * 100;
      }

      const sig = {
        barIdx: i, direction, maxCycle, holdDuration: hd,
        strength: direction === 'LONG' ? buyStrength : sellStrength,
        entryClose, entryNextOpen,

        // A: Scanner style (next_open → exit_open at scanner exitIdx)
        retA: calcRet(entryNextOpen, exitOpen_scanner, direction),
        // B: Live style (signal_close → exit_close at live exitIdx)
        retB: calcRet(entryClose, exitClose_live, direction),
        // For understanding: what's the gap between close and next open?
        entrySlippage: entryNextOpen != null ? ((entryNextOpen - entryClose) / entryClose * 100) : null,
      };

      signals.push(sig);

      // Set position block (scanner style: entryIdx = i+1)
      if (entryNextOpen != null) {
        position = { exitIdx: exitIdxScanner };
      } else {
        position = { exitIdx: exitIdxLive };
      }
    }
  }
  return signals;
}


async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  DEEP ANALYSIS: Entry Price Impact                           ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  const { rows: stratRows } = await client.query(
    `SELECT * FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = 60
     ORDER BY "updatedAt" DESC LIMIT 1`
  );
  const s = stratRows[0];
  const strategy = s ? {
    minStr: s.minStr, minCyc: s.minCyc, spike: s.spike, nearMiss: s.nearMiss,
    holdDiv: s.holdDiv, priceExt: s.priceExt ?? true, cycleMin: s.cycleMin ?? 10, cycleMax: s.cycleMax ?? 34,
  } : { minStr: 1, minCyc: 0, spike: false, nearMiss: true, holdDiv: 4, priceExt: true, cycleMin: 10, cycleMax: 34 };

  console.log(`[STRATEGY] ×${strategy.minStr} C≥${strategy.minCyc} spike=${strategy.spike} nearMiss=${strategy.nearMiss} ÷${strategy.holdDiv}\n`);

  const { rows: coinRows } = await client.query(`SELECT DISTINCT symbol FROM "Candle1h" LIMIT 200`);
  const coins = coinRows.map(r => r.symbol);

  const allSigs = [];
  let processed = 0;

  for (const symbol of coins) {
    const barsNeeded = strategy.cycleMax * 8;
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

    const sigs = detectAllSignalBars(bars, allBands, strategy);
    for (const sig of sigs) { sig.symbol = symbol; allSigs.push(sig); }
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  ${processed} coins...\r`);
  }

  console.log(`\nTotal signal events: ${allSigs.length} across ${processed} coins\n`);

  // ── Analysis 1: Entry slippage distribution ──
  const withNextOpen = allSigs.filter(s => s.entryNextOpen != null);
  const slippages = withNextOpen.map(s => s.entrySlippage);
  slippages.sort((a, b) => a - b);

  console.log(`${'═'.repeat(70)}`);
  console.log(`1. ENTRY SLIPPAGE: close → next open`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`   Signals with next bar available: ${withNextOpen.length}`);
  console.log(`   Avg slippage: ${(slippages.reduce((s, v) => s + v, 0) / slippages.length).toFixed(4)}%`);
  console.log(`   Median slippage: ${slippages[Math.floor(slippages.length / 2)].toFixed(4)}%`);
  console.log(`   Min: ${slippages[0].toFixed(4)}%  Max: ${slippages[slippages.length - 1].toFixed(4)}%`);
  console.log(`   Std dev: ${Math.sqrt(slippages.reduce((s, v) => s + v * v, 0) / slippages.length - Math.pow(slippages.reduce((s, v) => s + v, 0) / slippages.length, 2)).toFixed(4)}%`);

  // Break down by direction
  const longSlip = withNextOpen.filter(s => s.direction === 'LONG').map(s => s.entrySlippage);
  const shortSlip = withNextOpen.filter(s => s.direction === 'SHORT').map(s => s.entrySlippage);
  console.log(`\n   LONG signals (${longSlip.length}): avg slippage ${(longSlip.reduce((s,v)=>s+v,0)/longSlip.length).toFixed(4)}%`);
  console.log(`     → Positive slip = next open HIGHER than close → WORSE for longs (pay more)`);
  console.log(`   SHORT signals (${shortSlip.length}): avg slippage ${(shortSlip.reduce((s,v)=>s+v,0)/shortSlip.length).toFixed(4)}%`);
  console.log(`     → Positive slip = next open HIGHER than close → BETTER for shorts (sell higher)`);

  // ── Analysis 2: Per-trade return comparison ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`2. PER-TRADE RETURN: Scanner (A) vs Live (B) — same signals`);
  console.log(`${'═'.repeat(70)}`);

  const both = withNextOpen.filter(s => s.retA != null && s.retB != null);
  const retsA = both.map(s => s.retA);
  const retsB = both.map(s => s.retB);
  const diffs = both.map(s => s.retA - s.retB); // positive = scanner better

  const avgA = retsA.reduce((s, v) => s + v, 0) / retsA.length;
  const avgB = retsB.reduce((s, v) => s + v, 0) / retsB.length;
  const avgDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const winsA = retsA.filter(r => r > 0).length;
  const winsB = retsB.filter(r => r > 0).length;

  console.log(`   Trades compared: ${both.length}`);
  console.log(`   Scanner avg return: ${avgA.toFixed(4)}%  (win rate: ${(winsA/both.length*100).toFixed(1)}%)`);
  console.log(`   Live avg return:    ${avgB.toFixed(4)}%  (win rate: ${(winsB/both.length*100).toFixed(1)}%)`);
  console.log(`   Avg per-trade gap:  ${avgDiff.toFixed(4)}% (positive = scanner better)`);
  console.log(`   Cumulative gap:     ${(avgDiff * both.length).toFixed(2)}%`);

  // How often does scanner beat live on same signal?
  const scannerBetter = diffs.filter(d => d > 0).length;
  const liveBetter = diffs.filter(d => d < 0).length;
  const tied = diffs.filter(d => d === 0).length;
  console.log(`\n   Scanner wins: ${scannerBetter}  Live wins: ${liveBetter}  Tied: ${tied}`);
  console.log(`   Scanner beats live on ${(scannerBetter/both.length*100).toFixed(1)}% of identical signals`);

  // ── Analysis 3: Break down by LONG vs SHORT ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`3. BREAKDOWN BY DIRECTION`);
  console.log(`${'═'.repeat(70)}`);

  for (const dir of ['LONG', 'SHORT']) {
    const dirSigs = both.filter(s => s.direction === dir);
    if (dirSigs.length === 0) continue;
    const dA = dirSigs.map(s => s.retA);
    const dB = dirSigs.map(s => s.retB);
    const dd = dirSigs.map(s => s.retA - s.retB);
    console.log(`\n   ${dir} (${dirSigs.length} trades):`);
    console.log(`     Scanner avg: ${(dA.reduce((s,v)=>s+v,0)/dA.length).toFixed(4)}%  win: ${(dA.filter(r=>r>0).length/dA.length*100).toFixed(1)}%`);
    console.log(`     Live avg:    ${(dB.reduce((s,v)=>s+v,0)/dB.length).toFixed(4)}%  win: ${(dB.filter(r=>r>0).length/dB.length*100).toFixed(1)}%`);
    console.log(`     Gap:         ${(dd.reduce((s,v)=>s+v,0)/dd.length).toFixed(4)}% per trade`);
    console.log(`     Scanner wins on ${(dd.filter(d=>d>0).length/dd.length*100).toFixed(1)}% of trades`);
  }

  // ── Analysis 4: Are the 270 "extra" trades losers? ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`4. EDGE-CASE TRADES (signals where next bar doesn't exist)`);
  console.log(`${'═'.repeat(70)}`);

  const edgeCases = allSigs.filter(s => s.entryNextOpen == null);
  console.log(`   Edge-case signals: ${edgeCases.length}`);
  if (edgeCases.length > 0) {
    const edgeRets = edgeCases.filter(s => s.retB != null).map(s => s.retB);
    if (edgeRets.length > 0) {
      console.log(`   With live returns: ${edgeRets.length}`);
      console.log(`   Avg return: ${(edgeRets.reduce((s,v)=>s+v,0)/edgeRets.length).toFixed(4)}%`);
      console.log(`   Win rate: ${(edgeRets.filter(r=>r>0).length/edgeRets.length*100).toFixed(1)}%`);
    }
  } else {
    console.log(`   (None — the 270 extra trades from the first analysis come from`);
    console.log(`    different position blocking timing, not edge cases)`);
  }

  await client.end();
  console.log(`\n[done]\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
