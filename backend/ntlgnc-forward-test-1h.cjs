/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — 1H FORWARD TEST (last 24 hours)                       ║
 * ║                                                                  ║
 * ║  Extracts the EXACT trading logic from FracmapScanner.tsx        ║
 * ║  and live-signals.cjs, then runs it over the last 24 hours       ║
 * ║  of 1H candle data from the database.                           ║
 * ║                                                                  ║
 * ║  Purpose: verify that the scanner/backtest code produces the     ║
 * ║  same signals as the live signal engine on localhost:3000/signals ║
 * ║                                                                  ║
 * ║  Usage:  node ntlgnc-forward-test-1h.cjs                        ║
 * ║     or:  powershell -c "node ntlgnc-forward-test-1h.cjs"        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
const fs = require('fs');

// Find .env — works whether run from project root, backend/, or anywhere
const candidates = [
  path.join(__dirname, '.env'),
  path.join(__dirname, 'backend', '.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'backend', '.env'),
];
console.log(`[env] Script dir: ${__dirname}`);
console.log(`[env] Working dir: ${process.cwd()}`);
const envPath = candidates.find(p => { 
  const exists = fs.existsSync(p);
  console.log(`[env]   ${exists ? '✓' : '✗'} ${p}`);
  return exists;
});

if (envPath) {
  // Parse .env manually in case dotenv isn't installed
  try {
    require('dotenv').config({ path: envPath });
    console.log(`[env] Loaded via dotenv from ${envPath}`);
  } catch (e) {
    // dotenv not installed — parse manually
    console.log(`[env] dotenv not available, parsing ${envPath} manually...`);
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
    console.log(`[env] Loaded manually from ${envPath}`);
  }
} else {
  console.log(`[env] No .env found in any searched location`);
}

// pg might also need manual require path if not in node_modules
let Client;
try {
  Client = require('pg').Client;
} catch (e) {
  // Try from the backend's node_modules
  const backendNM = path.join(__dirname, 'node_modules', 'pg');
  const cwdNM = path.join(process.cwd(), 'node_modules', 'pg');
  try {
    Client = require(fs.existsSync(backendNM) ? backendNM : cwdNM).Client;
  } catch (e2) {
    console.error('ERROR: Cannot find "pg" module. Run: npm install pg');
    console.error('  Tried:', backendNM, cwdNM);
    process.exit(1);
  }
}

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  console.error('Place this script in the backend/ folder (next to .env) and run from there.');
  process.exit(1);
}
console.log(`[env] DATABASE_URL = ${DB_URL.replace(/:[^@]+@/, ':***@')}`);

const PHI = 1.618034;

// ═══════════════════════════════════════════════════════════════
// FRACMAP CORE — EXACT COPY from FracmapScanner.tsx + live-signals.cjs
// ═══════════════════════════════════════════════════════════════

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
// SCANNER-STYLE detectEnsembleSignals — EXACT COPY from FracmapScanner.tsx
// This is the BACKTESTER logic (walks all bars, one position at a time)
// ═══════════════════════════════════════════════════════════════

function detectEnsembleSignals(bars, allBands, minStrength, minMaxCycle, spikeFilter, holdDivisor, nearMiss, priceExtreme) {
  const signals = [];
  let position = null;
  const n = bars.length;

  function isLocalMax(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) {
      if (j === i) continue;
      if (arr[j] !== null && arr[j] > val) return false;
    }
    return true;
  }
  function isLocalMin(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) {
      if (j === i) continue;
      if (arr[j] !== null && arr[j] < val) return false;
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
      const exitPrice = bars[i].open;
      const ret = position.type === 'LONG'
        ? (exitPrice / position.entryPrice - 1) * 100
        : (position.entryPrice / exitPrice - 1) * 100;
      signals.push({
        ...position,
        exitPrice,
        exitActualIdx: i,
        returnPct: +ret.toFixed(3),
        won: ret > 0,
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
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / holdDivisor);
        position = {
          type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open,
          exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd,
          maxCycle: maxBuyCycle, maxOrder: maxBuyOrder,
          time: bars[i + 1].time, strength: buyStrength,
          coin: bars[i + 1].coin || '?',
        };
      }
    } else if (sellStrength >= minStrength && maxSellCycle >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxSellCycle / holdDivisor);
        position = {
          type: 'SHORT', entryIdx: i + 1, entryPrice: bars[i + 1].open,
          exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd,
          maxCycle: maxSellCycle, maxOrder: maxSellOrder,
          time: bars[i + 1].time, strength: sellStrength,
          coin: bars[i + 1].coin || '?',
        };
      }
    }
  }

  // Close any remaining open position at the last bar
  if (position) {
    const exitPrice = bars[n - 1].close;
    const ret = position.type === 'LONG'
      ? (exitPrice / position.entryPrice - 1) * 100
      : (position.entryPrice / exitPrice - 1) * 100;
    signals.push({
      ...position,
      exitPrice,
      exitActualIdx: n - 1,
      returnPct: +ret.toFixed(3),
      won: ret > 0,
      stillOpen: true,
    });
  }

  return signals;
}

// ═══════════════════════════════════════════════════════════════
// LIVE-STYLE detectSignalAtBar — EXACT COPY from live-signals.cjs
// This is what runs in production (checks only the last bar)
// ═══════════════════════════════════════════════════════════════

function detectSignalAtBar(bars, allBands, i, strategy) {
  const { minStr, minCyc, spike: spikeFilter, nearMiss, priceExt: priceExtreme, holdDiv } = strategy;

  function isLocalMax(arr, idx, w) {
    const val = arr[idx]; if (val === null) return false;
    for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) {
      if (j === idx) continue;
      if (arr[j] !== null && arr[j] > val) return false;
    }
    return true;
  }
  function isLocalMin(arr, idx, w) {
    const val = arr[idx]; if (val === null) return false;
    for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) {
      if (j === idx) continue;
      if (arr[j] !== null && arr[j] < val) return false;
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

  if (buyStrength >= minStr && maxBuyCycle >= minCyc && buyStrength >= sellStrength) {
    if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) return null;
    const holdBars = Math.round(maxBuyCycle / holdDiv);
    return {
      direction: 'LONG', strength: buyStrength,
      maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, holdBars,
      entryPrice: bars[i].close,
    };
  }

  if (sellStrength >= minStr && maxSellCycle >= minCyc) {
    if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) return null;
    const holdBars = Math.round(maxSellCycle / holdDiv);
    return {
      direction: 'SHORT', strength: sellStrength,
      maxCycle: maxSellCycle, maxOrder: maxSellOrder, holdBars,
      entryPrice: bars[i].close,
    };
  }

  return null;
}


// ═══════════════════════════════════════════════════════════════
// MAIN — Forward test over the last 24h
// ═══════════════════════════════════════════════════════════════

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  NTLGNC — 1H FORWARD TEST (last 24 hours)                   ║`);
  console.log(`║  Comparing scanner logic vs live signal engine               ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // ── 1. Load active 1H strategy from DB ──
  const { rows: stratRows } = await client.query(
    `SELECT * FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = 60
     ORDER BY "updatedAt" DESC LIMIT 1`
  );

  let strategy;
  let strategyId;
  if (stratRows[0]) {
    const s = stratRows[0];
    strategy = {
      minStr: s.minStr, minCyc: s.minCyc,
      spike: s.spike, nearMiss: s.nearMiss,
      holdDiv: s.holdDiv, priceExt: s.priceExt ?? true,
      cycleMin: s.cycleMin ?? 55, cycleMax: s.cycleMax ?? 89,
    };
    strategyId = s.id;
    console.log(`[STRATEGY] Loaded from DB: "${s.name}" (id=${s.id})`);
    console.log(`  Params: ×${strategy.minStr} C≥${strategy.minCyc} spike=${strategy.spike} nearMiss=${strategy.nearMiss} ÷${strategy.holdDiv} priceExt=${strategy.priceExt}`);
    console.log(`  Cycles: ${strategy.cycleMin}–${strategy.cycleMax}, Orders: 1–6`);
  } else {
    // Fall back to defaults from live-signals.cjs
    strategy = {
      minStr: 1, minCyc: 64, spike: true, nearMiss: true,
      holdDiv: 5, priceExt: true, cycleMin: 55, cycleMax: 89,
    };
    strategyId = null;
    console.log(`[STRATEGY] No active 1H strategy in DB, using defaults`);
    console.log(`  Params: ×${strategy.minStr} C≥${strategy.minCyc} spike=${strategy.spike} nearMiss=${strategy.nearMiss} ÷${strategy.holdDiv} priceExt=${strategy.priceExt}`);
    console.log(`  Cycles: ${strategy.cycleMin}–${strategy.cycleMax}, Orders: 1–6`);
  }

  // ── 2. Load actual signals from DB for comparison ──
  let dbSignals = [];
  if (strategyId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { rows } = await client.query(
      `SELECT * FROM "FracmapSignal" WHERE "strategyId" = $1 AND "createdAt" >= $2
       ORDER BY "createdAt" DESC`,
      [strategyId, since]
    );
    dbSignals = rows;
    console.log(`\n[DB SIGNALS] Found ${dbSignals.length} signals in last 24h from live engine`);
  }

  // ── 3. Get all coins with 1H data ──
  const { rows: coinRows } = await client.query(
    `SELECT DISTINCT symbol FROM "Candle1h" LIMIT 200`
  );
  const coins = coinRows.map(r => r.symbol);
  console.log(`[DATA] ${coins.length} coins with 1H data\n`);

  // ── 4. Run forward test ──
  const barsNeeded = strategy.cycleMax * 8; // same as live-signals.cjs
  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000);
  const maxAge = 60 * barsNeeded * 60000 * 1.5; // same safety margin as live
  const oldestAllowed = new Date(now - maxAge);

  const allGeneratedSignals = [];
  const scannerSignals = []; // from full backtest approach
  let coinsProcessed = 0;
  let coinsSkipped = 0;

  for (const symbol of coins) {
    // Fetch candles (same query as live-signals.cjs)
    const { rows } = await client.query(
      `SELECT timestamp as time, open, high, low, close
       FROM "Candle1h" WHERE symbol = $1 AND timestamp >= $2
       ORDER BY timestamp DESC LIMIT $3`,
      [symbol, oldestAllowed, barsNeeded]
    );

    if (rows.length < 200) {
      coinsSkipped++;
      continue;
    }

    // Reverse to chronological (same as live-signals.cjs)
    const bars = rows.slice().reverse().map(r => ({
      time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close,
      coin: symbol,
    }));

    // Compute all bands (same as live-signals.cjs)
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const allBands = [];
    for (let order = 1; order <= 6; order++) {
      for (let cycle = strategy.cycleMin; cycle <= strategy.cycleMax; cycle++) {
        allBands.push(computeFracmap(highs, lows, cycle, order));
      }
    }

    // ── METHOD A: Live-style (bar-by-bar, last 24h only) ──
    // Walk through bars in the last 24h and check each one
    for (let i = 100; i < bars.length; i++) {
      const barTime = new Date(bars[i].time);
      if (barTime < cutoff24h) continue;

      // Use the EXACT live-signals detectSignalAtBar function
      const signal = detectSignalAtBar(bars, allBands, i, strategy);
      if (signal) {
        allGeneratedSignals.push({
          method: 'LIVE',
          symbol,
          barTime: bars[i].time,
          ...signal,
        });
      }
    }

    // ── METHOD B: Scanner-style (full backtest over lookback window) ──
    const scanSigs = detectEnsembleSignals(
      bars, allBands,
      strategy.minStr, strategy.minCyc,
      strategy.spike, strategy.holdDiv,
      strategy.nearMiss, strategy.priceExt
    );
    // Filter to signals that fire within the last 24h
    for (const sig of scanSigs) {
      if (sig.time && new Date(sig.time) >= cutoff24h) {
        scannerSignals.push({ ...sig, symbol });
      }
    }

    coinsProcessed++;
  }

  // ── 5. Report results ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`FORWARD TEST RESULTS — Last 24 Hours`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`Coins processed: ${coinsProcessed} (${coinsSkipped} skipped <200 bars)`);

  // ── Live-style signals ──
  console.log(`\n── METHOD A: Live-style (detectSignalAtBar, bar-by-bar) ──`);
  console.log(`Total signals generated: ${allGeneratedSignals.length}`);

  const liveLongs = allGeneratedSignals.filter(s => s.direction === 'LONG');
  const liveShorts = allGeneratedSignals.filter(s => s.direction === 'SHORT');
  console.log(`  Longs: ${liveLongs.length}   Shorts: ${liveShorts.length}`);

  if (allGeneratedSignals.length > 0) {
    console.log(`\n  Recent signals (newest first):`);
    console.log(`  ${'─'.repeat(66)}`);
    console.log(`  ${'Time'.padEnd(22)} ${'Coin'.padEnd(12)} ${'Dir'.padEnd(7)} ${'Price'.padEnd(12)} Str  Cyc  Hold`);
    console.log(`  ${'─'.repeat(66)}`);
    for (const s of allGeneratedSignals.slice(-30).reverse()) {
      const t = new Date(s.barTime).toISOString().slice(5, 16).replace('T', ' ');
      console.log(`  ${t.padEnd(22)} ${s.symbol.replace('USDT', '').padEnd(12)} ${(s.direction === 'LONG' ? '▲ Up' : '▼ Dn').padEnd(7)} ${s.entryPrice.toFixed(4).padEnd(12)} ${String(s.strength).padEnd(5)}${String(s.maxCycle).padEnd(5)}${s.holdBars}`);
    }
  }

  // ── Scanner-style signals ──
  console.log(`\n── METHOD B: Scanner-style (detectEnsembleSignals, full backtest) ──`);
  console.log(`Total signals in last 24h: ${scannerSignals.length}`);

  const scanLongs = scannerSignals.filter(s => s.type === 'LONG');
  const scanShorts = scannerSignals.filter(s => s.type === 'SHORT');
  console.log(`  Longs: ${scanLongs.length}   Shorts: ${scanShorts.length}`);

  // Calculate returns for scanner signals
  const closedScanner = scannerSignals.filter(s => !s.stillOpen);
  const openScanner = scannerSignals.filter(s => s.stillOpen);
  if (closedScanner.length > 0) {
    const avgRet = closedScanner.reduce((s, t) => s + t.returnPct, 0) / closedScanner.length;
    const wins = closedScanner.filter(s => s.won).length;
    const cumRet = closedScanner.reduce((s, t) => s + t.returnPct, 0);
    console.log(`  Closed: ${closedScanner.length} | Open: ${openScanner.length}`);
    console.log(`  Win rate: ${(wins / closedScanner.length * 100).toFixed(1)}%`);
    console.log(`  Avg return: ${avgRet.toFixed(3)}%`);
    console.log(`  Cumulative return: ${cumRet.toFixed(3)}%`);
  }

  if (scannerSignals.length > 0) {
    console.log(`\n  Recent signals (newest first):`);
    console.log(`  ${'─'.repeat(80)}`);
    console.log(`  ${'Time'.padEnd(22)} ${'Coin'.padEnd(12)} ${'Dir'.padEnd(7)} ${'Entry'.padEnd(12)} ${'Return'.padEnd(10)} ${'Status'.padEnd(8)}`);
    console.log(`  ${'─'.repeat(80)}`);
    for (const s of scannerSignals.slice(-30).reverse()) {
      const t = s.time ? new Date(s.time).toISOString().slice(5, 16).replace('T', ' ') : '—';
      const ret = s.returnPct !== undefined ? `${s.returnPct.toFixed(3)}%` : '—';
      const status = s.stillOpen ? '● Open' : (s.won ? '✓ Won' : '✗ Lost');
      console.log(`  ${t.padEnd(22)} ${s.symbol.replace('USDT', '').padEnd(12)} ${(s.type === 'LONG' ? '▲ Up' : '▼ Dn').padEnd(7)} ${s.entryPrice.toFixed(4).padEnd(12)} ${ret.padEnd(10)} ${status}`);
    }
  }

  // ── Compare with DB signals ──
  if (dbSignals.length > 0) {
    console.log(`\n── COMPARISON: Actual DB Signals vs Forward Test ──`);
    console.log(`  DB signals (last 24h): ${dbSignals.length}`);
    console.log(`  Live-method signals:   ${allGeneratedSignals.length}`);
    console.log(`  Scanner-method signals: ${scannerSignals.length}`);

    // Show DB signals
    const dbLongs = dbSignals.filter(s => s.direction === 'LONG');
    const dbShorts = dbSignals.filter(s => s.direction === 'SHORT');
    const dbClosed = dbSignals.filter(s => s.status === 'closed');
    const dbOpen = dbSignals.filter(s => s.status === 'open');
    console.log(`  DB: ${dbLongs.length} longs, ${dbShorts.length} shorts | ${dbClosed.length} closed, ${dbOpen.length} open`);

    if (dbClosed.length > 0) {
      const dbAvgRet = dbClosed.reduce((s, t) => s + (t.returnPct || 0), 0) / dbClosed.length;
      const dbWins = dbClosed.filter(s => s.returnPct > 0).length;
      const dbCumRet = dbClosed.reduce((s, t) => s + (t.returnPct || 0), 0);
      console.log(`  DB closed: win rate ${(dbWins / dbClosed.length * 100).toFixed(1)}%, avg ret ${dbAvgRet.toFixed(3)}%, cum ret ${dbCumRet.toFixed(3)}%`);
    }

    console.log(`\n  DB signals detail:`);
    console.log(`  ${'─'.repeat(80)}`);
    console.log(`  ${'Time'.padEnd(22)} ${'Coin'.padEnd(12)} ${'Dir'.padEnd(7)} ${'Entry'.padEnd(12)} ${'Return'.padEnd(10)} ${'Status'.padEnd(8)}`);
    console.log(`  ${'─'.repeat(80)}`);
    for (const s of dbSignals.slice(0, 30)) {
      const t = new Date(s.createdAt).toISOString().slice(5, 16).replace('T', ' ');
      const ret = s.returnPct != null ? `${s.returnPct.toFixed(3)}%` : '—';
      const status = s.status === 'open' ? '● Open' : (s.returnPct > 0 ? '✓ Won' : '✗ Lost');
      console.log(`  ${t.padEnd(22)} ${s.symbol.replace('USDT', '').padEnd(12)} ${(s.direction === 'LONG' ? '▲ Up' : '▼ Dn').padEnd(7)} ${(+s.entryPrice).toFixed(4).padEnd(12)} ${ret.padEnd(10)} ${status}`);
    }

    // ── Signal matching: check if live-method signals match DB signals ──
    console.log(`\n── SIGNAL MATCHING ──`);
    let matched = 0, unmatched = 0;
    for (const dbSig of dbSignals) {
      const dbTime = new Date(dbSig.createdAt).getTime();
      const found = allGeneratedSignals.find(s =>
        s.symbol === dbSig.symbol &&
        s.direction === dbSig.direction &&
        Math.abs(new Date(s.barTime).getTime() - dbTime) < 2 * 3600 * 1000 // within 2 hours
      );
      if (found) {
        matched++;
      } else {
        unmatched++;
        const t = new Date(dbSig.createdAt).toISOString().slice(5, 16).replace('T', ' ');
        console.log(`  ❌ UNMATCHED DB signal: ${dbSig.symbol} ${dbSig.direction} at ${t} (entry=${dbSig.entryPrice})`);
      }
    }
    console.log(`\n  Matched: ${matched}/${dbSignals.length} | Unmatched: ${unmatched}`);

    if (unmatched === 0 && matched > 0) {
      console.log(`  ✅ ALL DB signals reproduced by forward test — logic is consistent!`);
    } else if (unmatched > 0) {
      console.log(`  ⚠️  Some signals didn't match. Possible reasons:`);
      console.log(`     - Live engine checks only the LAST completed bar (bars[length-2])`);
      console.log(`     - Live engine skips if another signal is already open for that coin`);
      console.log(`     - Forward test checks ALL bars in the 24h window`);
      console.log(`     - Timing differences: live runs on a 5-min poll interval`);
    }
  }

  // ── KEY DIFFERENCE ANALYSIS ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`KEY DIFFERENCES: Scanner (backtest) vs Live Engine`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`
  1. ENTRY PRICE:
     - Scanner: bars[i+1].open (next bar's open after signal bar)
     - Live:    bars[i].close  (signal bar's close)
     → This is a known difference. Scanner enters at next open;
       live enters at current close. Usually small impact.

  2. POSITION MANAGEMENT:
     - Scanner: ONE position at a time across ALL coins (sequential loop)
     - Live:    ONE position per COIN (independent per-symbol tracking)
     → Live can have 50+ simultaneous positions; scanner can only have 1.
       This means scanner misses many signals that fire simultaneously.

  3. EXIT MECHANISM:
     - Scanner: exit at bars[exitIdx].open (next bar open after hold expires)
     - Live:    exit at bars[last].close (current close when hold expires)
     → Slight timing difference on exits too.

  4. BAR SELECTION:
     - Scanner: checks ALL bars in sequence
     - Live:    checks only bars[length-2] (last completed bar)
     → Live won't catch signals on bars it didn't poll during.
       With 5-min polling for 1H bars, it catches every bar.

  NOTE: The scanner's per-coin-sequential position model means its backtest
  metrics don't reflect what happens in production, where the live engine
  runs independently per coin. This is NOT a bug — it's a design choice.
  But it means scanner's cumulative return ≠ live cumulative return.
  `);

  await client.end();
  console.log(`\n[done]\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
