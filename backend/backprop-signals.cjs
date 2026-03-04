/**
 * backprop-signals.cjs — Faithful replay of live-signals.cjs logic
 *
 * Two-phase approach to avoid OOM on long replays:
 *   Phase 1: Process each coin independently (one at a time in memory)
 *            → detect signals, close expired, write to DB
 *   Phase 2: Walk through signals chronologically and hedge-pair
 *            → queries DB like the live engine does
 *
 * Usage: node backprop-signals.cjs [hours=1200]
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const HOURS = parseInt(process.argv[2] || '1200', 10);
const DAYS = Math.ceil(HOURS / 24);
const PHI = 1.618034;

const TIMEFRAMES = [
  {
    key: '1m', barMinutes: 1, table: 'Candle1m', label: '1-Minute',
    cycleMin: 10, cycleMax: 100,
    minStr: 1, minCyc: 55, spike: true, nearMiss: true, holdDiv: 4, priceExt: true,
    historyBars: 700, replayBars: HOURS * 60,
    coinCap: 50,
  },
  {
    key: '1h', barMinutes: 60, table: 'Candle1h', label: '1-Hour',
    cycleMin: 55, cycleMax: 89,
    minStr: 1, minCyc: 64, spike: true, nearMiss: true, holdDiv: 5, priceExt: true,
    historyBars: 500, replayBars: HOURS,
    coinCap: 150,
  },
  {
    key: '1d', barMinutes: 1440, table: 'Candle1d', label: '1-Day',
    cycleMin: 2, cycleMax: 12,
    minStr: 1, minCyc: 0, spike: false, nearMiss: false, holdDiv: 2, priceExt: true,
    historyBars: 200, replayBars: DAYS,
    coinCap: 150,
  },
];

// ═══ Fracmap core (identical to live-signals.cjs) ═══

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
  // ═══ CORRECTED: Original design + scanner improvements ═══
  // Touch: pierce-and-close (reversal confirmation)
  // Near-miss: temporal (x-axis, check prev bar) — no look-ahead bias because bands are lagged
  // Spike/cusp: isLocalMax on lower band (spike up), isLocalMin on upper band (spike down)
  //             Always applied. Window = cycle/6. Can look forward because bands are lagged.
  // PriceExtreme: per-band with cycle/6 window (from scanner, more principled)
  // Combined spike: reject mixed long+short votes (when spikeFilter enabled)
  // Strength: direction-specific (longVotes or shortVotes individually vs minStr)
  // holdBars: floor of 3
  const { minStr, minCyc, spike: spikeFilter, nearMiss, priceExt: priceExtreme, holdDiv } = strategy;

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

  let longVotes = 0, shortVotes = 0, maxCyc = 0, maxOrd = 0;

  for (const band of allBands) {
    const lo = band.lower, up = band.upper;
    const w = Math.max(2, Math.round(band.cycle / 6));

    // Long: pierce-and-close on lower band + cusp (isLocalMax = spike up) + priceExtreme
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

    // Short: pierce-and-close on upper band + cusp (isLocalMin = spike down) + priceExtreme
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

  // Combined spike: reject mixed signals
  if (spikeFilter && longVotes > 0 && shortVotes > 0) return null;

  // Direction-specific strength check
  if (longVotes >= minStr && maxCyc >= minCyc && longVotes >= shortVotes) {
    const hold = Math.max(3, Math.round(maxCyc / holdDiv));
    return {
      direction: 'LONG', strength: longVotes,
      maxCycle: maxCyc, maxOrder: maxOrd, holdBars: hold,
      entryPrice: (i + 1 < bars.length) ? bars[i + 1].open : bars[i].close,
    };
  }
  if (shortVotes >= minStr && maxCyc >= minCyc) {
    const hold = Math.max(3, Math.round(maxCyc / holdDiv));
    return {
      direction: 'SHORT', strength: shortVotes,
      maxCycle: maxCyc, maxOrder: maxOrd, holdBars: hold,
      entryPrice: (i + 1 < bars.length) ? bars[i + 1].open : bars[i].close,
    };
  }
  return null;
}

// ═══ Main ═══

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n═══ BACKPROP: Faithful replay of live-signals.cjs ═══`);
  console.log(`═══ Replaying last ${HOURS} hours / ${DAYS} days (all TFs aligned) ═══\n`);

  const { rows: strategies } = await client.query(
    `SELECT id, "barMinutes", config FROM "FracmapStrategy" WHERE active = true ORDER BY "barMinutes"`
  );
  const stratMap = {};
  for (const s of strategies) stratMap[s.barMinutes] = s;

  const { rows: coinRows } = await client.query(`SELECT DISTINCT symbol FROM "Candle1h" LIMIT 200`);
  const allCoins = coinRows.map(r => r.symbol);

  let excludedSet = new Set();
  try {
    const { rows: excl } = await client.query(
      `SELECT symbol FROM board_coin_overrides WHERE active = true AND override_type = 'exclude'`
    );
    excludedSet = new Set(excl.map(r => r.symbol));
  } catch {}

  let totalNew = 0, totalClosed = 0, totalHedged = 0;

  for (const tf of TIMEFRAMES) {
    const strat = stratMap[tf.barMinutes];
    if (!strat) {
      console.log(`[${tf.label}] No active strategy, skipping`);
      continue;
    }

    const strategyId = strat.id;
    const hedgeCfg = strat.config || { hedging_enabled: true, max_gap: 1, hedge_mode: 'exclusive' };
    const maxGapDays = hedgeCfg.max_gap || 1;
    const hedgeMode = hedgeCfg.hedge_mode || 'exclusive';

    const strategy = {
      minStr: tf.minStr, minCyc: tf.minCyc,
      spike: tf.spike, nearMiss: tf.nearMiss,
      holdDiv: tf.holdDiv, priceExt: tf.priceExt,
      cycleMin: tf.cycleMin, cycleMax: tf.cycleMax,
    };

    const coins = allCoins.filter(c => !excludedSet.has(c)).slice(0, tf.coinCap);
    const totalBarsNeeded = tf.historyBars + tf.replayBars;

    console.log(`[${tf.label}] ${coins.length} coins, replay=${tf.replayBars} bars, hedging: max_gap=${maxGapDays}d, mode=${hedgeMode}`);

    // Clear existing signals for this strategy
    const { rowCount: deleted } = await client.query(
      `DELETE FROM "FracmapSignal" WHERE "strategyId" = $1`, [strategyId]
    );
    if (deleted) console.log(`  Cleared ${deleted} existing signals`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: Process each coin independently (memory-safe)
    // One coin's bands in memory at a time → detect + close
    // ═══════════════════════════════════════════════════════════
    let tfNew = 0, tfClosed = 0;
    let coinsDone = 0;

    for (const symbol of coins) {
      const { rows: rawBars } = await client.query(
        `SELECT timestamp as time, open, high, low, close FROM "${tf.table}"
         WHERE symbol = $1 ORDER BY timestamp DESC LIMIT $2`,
        [symbol, totalBarsNeeded]
      );
      if (rawBars.length < 200) continue;
      const bars = rawBars.reverse();
      bars.forEach(b => { b.open = +b.open; b.high = +b.high; b.low = +b.low; b.close = +b.close; });

      const highs = bars.map(b => b.high);
      const lows = bars.map(b => b.low);
      const allBands = [];
      for (let order = 1; order <= 6; order++) {
        for (let cycle = strategy.cycleMin; cycle <= strategy.cycleMax; cycle++) {
          allBands.push(computeFracmap(highs, lows, cycle, order));
        }
      }

      const replayStart = Math.max(bars.length - tf.replayBars - 1, 100);
      let openSig = null; // no-stacking: max 1 open per symbol

      for (let i = replayStart; i < bars.length - 1; i++) {
        // Close expired signal
        if (openSig && (i - openSig.barIdx) >= openSig.holdBars) {
          const exitPrice = bars[i].open;
          const ret = openSig.direction === 'LONG'
            ? (exitPrice / openSig.entryPrice - 1) * 100
            : (openSig.entryPrice / exitPrice - 1) * 100;
          const drift = Math.abs(exitPrice - openSig.entryPrice) / openSig.entryPrice;
          if (drift <= 0.50) {
            await client.query(
              `UPDATE "FracmapSignal" SET "exitPrice" = $1, "returnPct" = $2,
               status = 'closed', "closedAt" = $3 WHERE id = $4 AND status = 'open'`,
              [exitPrice, +ret.toFixed(4), new Date(bars[i].time), openSig.dbId]
            );
            tfClosed++;
          }
          openSig = null;
        }

        // No-stacking
        if (openSig) continue;

        // Detect signal
        const signal = detectSignalAtBar(bars, allBands, i, strategy);
        if (!signal) continue;

        // Insert
        const signalTime = new Date(bars[i].time);
        const { rows: [newSig] } = await client.query(
          `INSERT INTO "FracmapSignal"
           ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [strategyId, symbol, signal.direction, signal.entryPrice,
           signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder, signalTime]
        );

        openSig = {
          dbId: newSig.id, direction: signal.direction,
          entryPrice: signal.entryPrice, holdBars: signal.holdBars,
          barIdx: i,
        };
        tfNew++;
      }

      // Close last signal if expired at final bar
      if (openSig && (bars.length - 1 - openSig.barIdx) >= openSig.holdBars) {
        const lastIdx = bars.length - 1;
        const exitPrice = bars[lastIdx].open;
        const ret = openSig.direction === 'LONG'
          ? (exitPrice / openSig.entryPrice - 1) * 100
          : (openSig.entryPrice / exitPrice - 1) * 100;
        const drift = Math.abs(exitPrice - openSig.entryPrice) / openSig.entryPrice;
        if (drift <= 0.50) {
          await client.query(
            `UPDATE "FracmapSignal" SET "exitPrice" = $1, "returnPct" = $2,
             status = 'closed', "closedAt" = $3 WHERE id = $4 AND status = 'open'`,
            [exitPrice, +ret.toFixed(4), new Date(bars[lastIdx].time), openSig.dbId]
          );
          tfClosed++;
        }
      }

      coinsDone++;
      if (coinsDone % 10 === 0) {
        process.stdout.write(`  ${coinsDone}/${coins.length} coins, +${tfNew} signals, -${tfClosed} closed\r`);
      }
    }
    console.log(`  Phase 1 done: ${coinsDone} coins, +${tfNew} signals, -${tfClosed} closed`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Hedge pairing — walk through signals by createdAt
    // Matches live engine: for each new signal, find best opposite-
    // direction unpaired open signal within max_gap days
    // ═══════════════════════════════════════════════════════════
    let tfHedged = 0;

    if (hedgeCfg.hedging_enabled) {
      // Get all signals for this strategy, sorted by creation time
      const { rows: allSignals } = await client.query(
        `SELECT id, symbol, direction, "entryPrice", strength, "holdBars", "createdAt", status, pair_id
         FROM "FracmapSignal" WHERE "strategyId" = $1 ORDER BY "createdAt" ASC`,
        [strategyId]
      );

      // Walk through each signal and try to pair it (like live engine does on insert)
      for (const sig of allSignals) {
        if (sig.pair_id) continue; // already paired

        const oppositeDir = sig.direction === 'LONG' ? 'SHORT' : 'LONG';
        const pairWhere = hedgeMode === 'exclusive' ? 'AND pair_id IS NULL' : '';

        // Query for best match — same as live engine lines 821-829
        // Temporal check: signal was open at sig.createdAt if it was created before
        // and either still open now OR closed AFTER sig.createdAt
        const { rows: candidates } = await client.query(
          `SELECT id, symbol, direction, "entryPrice", "holdBars", strength, "createdAt"
           FROM "FracmapSignal"
           WHERE "strategyId" = $1 AND direction = $2
           AND symbol != $3 AND id != $4
           AND "createdAt" <= $5
           AND "createdAt" >= $5 - INTERVAL '${maxGapDays} days'
           AND ("closedAt" IS NULL OR "closedAt" > $5)
           ${pairWhere}
           ORDER BY strength DESC, "createdAt" DESC LIMIT 1`,
          [strategyId, oppositeDir, sig.symbol, sig.id, sig.createdAt]
        );

        if (candidates.length === 0) continue;

        const match = candidates[0];
        const pairId = crypto.randomUUID();

        await client.query(
          `UPDATE "FracmapSignal" SET pair_id = $1, pair_symbol = $2, pair_direction = $3 WHERE id = $4`,
          [pairId, sig.symbol, sig.direction, match.id]
        );
        await client.query(
          `UPDATE "FracmapSignal" SET pair_id = $1, pair_symbol = $2, pair_direction = $3 WHERE id = $4`,
          [pairId, match.symbol, match.direction, sig.id]
        );
        tfHedged++;
      }

      // Phase 2b: Compute pair_return for closed pairs
      const { rows: closedPairs } = await client.query(
        `SELECT DISTINCT pair_id FROM "FracmapSignal"
         WHERE "strategyId" = $1 AND pair_id IS NOT NULL AND status = 'closed' AND pair_return IS NULL`,
        [strategyId]
      );
      for (const { pair_id } of closedPairs) {
        const { rows: legs } = await client.query(
          `SELECT id, "returnPct", status FROM "FracmapSignal" WHERE pair_id = $1`, [pair_id]
        );
        if (legs.length === 2 && legs.every(l => l.status === 'closed' && l.returnPct != null)) {
          const pairReturn = +(parseFloat(legs[0].returnPct) + parseFloat(legs[1].returnPct)).toFixed(4);
          await client.query(
            `UPDATE "FracmapSignal" SET pair_return = $1 WHERE pair_id = $2`,
            [pairReturn, pair_id]
          );
        }
      }

      console.log(`  Phase 2 done: ${tfHedged} hedged pairs, ${closedPairs.length} pair_returns computed`);
    }

    console.log(`[${tf.label}] Done: +${tfNew} signals, -${tfClosed} closed, ${tfHedged} hedged pairs\n`);
    totalNew += tfNew;
    totalClosed += tfClosed;
    totalHedged += tfHedged;
  }

  // Summary
  const { rows: summary } = await client.query(`
    SELECT st."barMinutes", s.status, COUNT(*) as cnt,
           COUNT(*) FILTER (WHERE s.pair_id IS NOT NULL) as hedged
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    GROUP BY st."barMinutes", s.status
    ORDER BY st."barMinutes", s.status
  `);

  console.log(`═══ SUMMARY ═══`);
  console.log(`Total: +${totalNew} new, -${totalClosed} closed, ${totalHedged} hedged pairs`);
  console.log(`\nBy timeframe:`);
  for (const r of summary) {
    const tf = r.barMinutes === 1 ? '1m' : r.barMinutes === 60 ? '1h' : '1d';
    console.log(`  ${tf} ${r.status}: ${r.cnt} (${r.hedged} hedged)`);
  }

  const { rows: pairStats } = await client.query(`
    SELECT pair_return FROM "FracmapSignal"
    WHERE pair_return IS NOT NULL
    GROUP BY pair_id, pair_return
  `);
  if (pairStats.length > 0) {
    const rets = pairStats.map(r => +r.pair_return);
    const wins = rets.filter(r => r > 0).length;
    const avg = rets.reduce((s, r) => s + r, 0) / rets.length;
    console.log(`\nHedged pair stats (${rets.length} closed pairs):`);
    console.log(`  Win rate: ${(wins / rets.length * 100).toFixed(0)}%`);
    console.log(`  Avg return: ${avg >= 0 ? '+' : ''}${avg.toFixed(3)}%`);
    console.log(`  Range: ${Math.min(...rets).toFixed(2)}% to ${Math.max(...rets).toFixed(2)}%`);
  }

  // Date range check
  const { rows: dateRange } = await client.query(`
    SELECT st."barMinutes",
           MIN(s."createdAt") as earliest,
           MAX(s."createdAt") as latest
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    GROUP BY st."barMinutes" ORDER BY st."barMinutes"
  `);
  console.log(`\nDate ranges:`);
  for (const r of dateRange) {
    const tf = r.barMinutes === 1 ? '1m' : r.barMinutes === 60 ? '1h' : '1d';
    console.log(`  ${tf}: ${r.earliest?.toISOString().slice(0,10)} to ${r.latest?.toISOString().slice(0,10)}`);
  }

  await client.end();
  console.log('\nDone!');
})();
