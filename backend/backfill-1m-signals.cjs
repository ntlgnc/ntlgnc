/**
 * Backfill 1m signals for the gap period (Feb 24 – Mar 3, 2026)
 *
 * OPTIMIZED: Computes bands ONCE per coin for the full bar array,
 * then sweeps through gap bars calling detectSignalAtBar.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const PHI = 1.618034;

const STRATEGY = {
  barMinutes: 1, table: 'Candle1m',
  cycleMin: 10, cycleMax: 100,
  minStr: 1, minCyc: 55,
  spike: true, nearMiss: true, holdDiv: 4, priceExt: true,
};

const BARS_NEEDED = STRATEGY.cycleMax * 8; // 800

const GAP_START = new Date('2026-02-24T00:00:00Z');
const GAP_END   = new Date('2026-03-04T00:00:00Z');

// ═══ FRACMAP CORE ═══

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

  let longVotes = 0, shortVotes = 0, maxCyc = 0, maxOrd = 0;

  for (const band of allBands) {
    const lo = band.lower, up = band.upper;
    const w = Math.max(2, Math.round(band.cycle / 6));

    if (lo[i] !== null) {
      const pierce = bars[i].low < lo[i] && bars[i].close > lo[i];
      const nearTemporal = nearMiss && !pierce && (i > 0 && lo[i-1] !== null &&
        bars[i-1].low < lo[i-1] && bars[i-1].close > lo[i-1]);
      const cusp = isLocalMax(lo, i, w);
      if ((pierce || nearTemporal) && cusp) {
        if (priceExtreme && !isPriceLow(i, w)) { /* skip */ } else {
          longVotes++;
          if (band.cycle > maxCyc) { maxCyc = band.cycle; maxOrd = band.order; }
        }
      }
    }

    if (up[i] !== null) {
      const pierce = bars[i].high > up[i] && bars[i].close < up[i];
      const nearTemporal = nearMiss && !pierce && (i > 0 && up[i-1] !== null &&
        bars[i-1].high > up[i-1] && bars[i-1].close < up[i-1]);
      const cusp = isLocalMin(up, i, w);
      if ((pierce || nearTemporal) && cusp) {
        if (priceExtreme && !isPriceHigh(i, w)) { /* skip */ } else {
          shortVotes++;
          if (band.cycle > maxCyc) { maxCyc = band.cycle; maxOrd = band.order; }
        }
      }
    }
  }

  if (spikeFilter && longVotes > 0 && shortVotes > 0) return null;

  if (longVotes >= minStr && maxCyc >= minCyc && longVotes >= shortVotes) {
    const hold = Math.max(3, Math.round(maxCyc / holdDiv));
    return { direction: 'LONG', strength: longVotes, maxCycle: maxCyc, maxOrder: maxOrd, holdBars: hold,
      entryPrice: (i + 1 < bars.length) ? bars[i + 1].open : bars[i].close };
  }
  if (shortVotes >= minStr && maxCyc >= minCyc) {
    const hold = Math.max(3, Math.round(maxCyc / holdDiv));
    return { direction: 'SHORT', strength: shortVotes, maxCycle: maxCyc, maxOrder: maxOrd, holdBars: hold,
      entryPrice: (i + 1 < bars.length) ? bars[i + 1].open : bars[i].close };
  }
  return null;
}

// ═══ MAIN ═══

(async () => {
  const client = await pool.connect();

  try {
    const { rows: strats } = await client.query(
      `SELECT id FROM "FracmapStrategy" WHERE "barMinutes" = 1 AND active = true LIMIT 1`
    );
    const strategyId = strats[0]?.id || null;
    console.log(`Strategy ID: ${strategyId}`);

    const { rows: coinRows } = await client.query(`
      SELECT DISTINCT symbol FROM "Candle1m"
      WHERE timestamp >= $1 AND timestamp < $2
      ORDER BY symbol
    `, [GAP_START, GAP_END]);
    let coins = coinRows.map(r => r.symbol);
    console.log(`Coins with 1m data in gap: ${coins.length}`);
    if (coins.length === 0) { console.log('No data. Run backfill-1m.cjs first.'); process.exit(1); }

    // Cap to 50 coins (same as live engine for 1m)
    if (coins.length > 50) {
      console.log(`Capping from ${coins.length} to 50 coins (live engine cap)`);
      coins = coins.slice(0, 50);
    }

    // Clean previous backfill
    const { rowCount: deleted } = await client.query(`
      DELETE FROM "FracmapSignal"
      WHERE "strategyId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3 AND pair_type = 'backfill'
    `, [strategyId, GAP_START, GAP_END]);
    if (deleted > 0) console.log(`Cleaned ${deleted} previous backfill signals`);

    const allSignals = [];
    let totalDetected = 0;

    for (let ci = 0; ci < coins.length; ci++) {
      const symbol = coins[ci];
      const t0 = Date.now();

      // Fetch history before gap + all gap bars + some extra after for exit prices
      const historyStart = new Date(GAP_START.getTime() - BARS_NEEDED * 60_000 * 1.5);
      const dataEnd = new Date(GAP_END.getTime() + 100 * 60_000); // extra 100 bars for exits
      const { rows } = await client.query(`
        SELECT timestamp as time, open, high, low, close
        FROM "Candle1m" WHERE symbol = $1 AND timestamp >= $2 AND timestamp <= $3
        ORDER BY timestamp ASC
      `, [symbol, historyStart, dataEnd]);

      if (rows.length < BARS_NEEDED) {
        console.log(`  ${symbol}: ${rows.length} bars (need ${BARS_NEEDED}), skipping`);
        continue;
      }

      const bars = rows.map(r => ({
        time: new Date(r.time), open: +r.open, high: +r.high, low: +r.low, close: +r.close,
      }));

      // Find gap start index
      const gapStartIdx = bars.findIndex(b => b.time >= GAP_START);
      if (gapStartIdx < 100) {
        console.log(`  ${symbol}: gap starts at idx ${gapStartIdx}, need more history`);
        continue;
      }

      // Find gap end index
      let gapEndIdx = bars.findIndex(b => b.time >= GAP_END);
      if (gapEndIdx < 0) gapEndIdx = bars.length;

      // Compute bands ONCE for the full bar array
      const highs = bars.map(b => b.high);
      const lows = bars.map(b => b.low);
      const allBands = [];
      for (let order = 1; order <= 6; order++) {
        for (let cycle = STRATEGY.cycleMin; cycle <= STRATEGY.cycleMax; cycle++) {
          allBands.push(computeFracmap(highs, lows, cycle, order));
        }
      }

      let coinSignals = 0;
      let lastSignalBar = -Infinity;
      let lastHoldBars = 0;

      // Sweep through gap bars
      // Enforce full holdBars cooldown — same as live engine's hasOpen check
      for (let i = gapStartIdx; i < gapEndIdx; i++) {
        if (i - lastSignalBar < lastHoldBars) continue; // Don't stack signals

        const signal = detectSignalAtBar(bars, allBands, i, STRATEGY);
        if (!signal) continue;

        // Exit at open of bar (entry + holdBars)
        const entryBarIdx = i + 1;
        const exitBarIdx = entryBarIdx + signal.holdBars;
        if (exitBarIdx >= bars.length) continue;

        const exitPrice = bars[exitBarIdx].open;
        const returnPct = signal.direction === 'LONG'
          ? (exitPrice / signal.entryPrice - 1) * 100
          : (signal.entryPrice / exitPrice - 1) * 100;

        if (Math.abs(returnPct) > 50) continue;

        allSignals.push({
          barTime: bars[i].time, symbol, direction: signal.direction,
          strength: signal.strength, holdBars: signal.holdBars,
          maxCycle: signal.maxCycle, maxOrder: signal.maxOrder,
          entryPrice: signal.entryPrice, exitPrice,
          returnPct: +returnPct.toFixed(4),
          createdAt: bars[i].time, enteredAt: bars[entryBarIdx].time,
          closedAt: bars[exitBarIdx].time,
        });

        lastSignalBar = i;
        lastHoldBars = signal.holdBars;
        coinSignals++;
        totalDetected++;
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${ci+1}/${coins.length}] ${symbol}: ${coinSignals} signals (${elapsed}s)`);
    }

    console.log(`\nTotal signals detected: ${totalDetected}`);

    // Natural pair matching per bar
    allSignals.sort((a, b) => a.barTime - b.barTime);
    const barGroups = new Map();
    for (const sig of allSignals) {
      const barKey = Math.floor(sig.barTime.getTime() / 60_000);
      if (!barGroups.has(barKey)) barGroups.set(barKey, []);
      barGroups.get(barKey).push(sig);
    }

    let paired = 0;
    for (const [, sigs] of barGroups) {
      const longs = sigs.filter(s => s.direction === 'LONG');
      const shorts = sigs.filter(s => s.direction === 'SHORT');
      const usedL = new Set(), usedS = new Set();
      for (let li = 0; li < longs.length; li++) {
        for (let si = 0; si < shorts.length; si++) {
          if (usedL.has(li) || usedS.has(si)) continue;
          if (longs[li].symbol === shorts[si].symbol) continue;
          const pairId = crypto.randomUUID();
          longs[li].pairId = pairId;
          longs[li].pairSymbol = shorts[si].symbol;
          longs[li].pairDirection = shorts[si].direction;
          shorts[si].pairId = pairId;
          shorts[si].pairSymbol = longs[li].symbol;
          shorts[si].pairDirection = longs[li].direction;
          const pairReturn = +(longs[li].returnPct + shorts[si].returnPct).toFixed(4);
          longs[li].pairReturn = pairReturn;
          shorts[si].pairReturn = pairReturn;
          usedL.add(li);
          usedS.add(si);
          paired++;
        }
      }
    }

    console.log(`Natural pairs formed: ${paired}`);

    // Insert all signals
    let inserted = 0;
    const tickId = `backfill-${Date.now()}`;
    for (const sig of allSignals) {
      await client.query(`
        INSERT INTO "FracmapSignal"
        ("strategyId", symbol, direction, "entryPrice", "exitPrice", "returnPct",
         strength, "holdBars", "maxCycle", "maxOrder", status,
         "createdAt", "closedAt", "detectedAt", "enteredAt",
         pair_id, pair_symbol, pair_direction, pair_type, pair_return, tick_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'closed',$11,$12,$11,$13,$14,$15,$16,'backfill',$17,$18)
      `, [
        strategyId, sig.symbol, sig.direction, sig.entryPrice, sig.exitPrice, sig.returnPct,
        sig.strength, sig.holdBars, sig.maxCycle, sig.maxOrder,
        sig.createdAt, sig.closedAt, sig.enteredAt,
        sig.pairId || null, sig.pairSymbol || null, sig.pairDirection || null,
        sig.pairReturn || null, tickId,
      ]);
      inserted++;
    }

    console.log(`\nInserted ${inserted} signals (${paired} pairs)`);

    // Summary
    const pairReturns = [];
    const seenPairs = new Set();
    for (const s of allSignals) {
      if (s.pairId && !seenPairs.has(s.pairId)) {
        seenPairs.add(s.pairId);
        pairReturns.push(s.pairReturn);
      }
    }
    if (pairReturns.length > 0) {
      const wins = pairReturns.filter(r => r > 0).length;
      const total = pairReturns.reduce((a, b) => a + b, 0);
      console.log(`Pair stats: ${pairReturns.length} pairs, WR=${(wins/pairReturns.length*100).toFixed(1)}%, total=${total.toFixed(2)}%`);
    }

  } finally {
    client.release();
    await pool.end();
  }
})();
