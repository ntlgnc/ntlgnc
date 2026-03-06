/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — RETROACTIVE FILTER APPLICATION                        ║
 * ║                                                                  ║
 * ║  Runs current board filters backwards over ALL existing closed  ║
 * ║  signals. Signals that would have been blocked get moved from   ║
 * ║  'closed' → 'filtered_closed', removing them from the visible  ║
 * ║  signals page and cumulative return chart.                      ║
 * ║                                                                  ║
 * ║  This lets you see: "If we'd had these filters from the start, ║
 * ║  would we have avoided that nasty drawdown?"                    ║
 * ║                                                                  ║
 * ║  Usage (PowerShell):                                            ║
 * ║    cd <project-root>                                            ║
 * ║    node backend/retroactive-filter.cjs                          ║
 * ║                                                                  ║
 * ║  REVERSIBLE: Run with --undo to restore all filtered signals:   ║
 * ║    node backend/retroactive-filter.cjs --undo                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.618034;
const UNDO_MODE = process.argv.includes('--undo');
const DRY_RUN = process.argv.includes('--dry');

// ═══════════════════════════════════════════════════════════════
// FIELD ALIASES — Same as live-signals.cjs
// ═══════════════════════════════════════════════════════════════

const FIELD_ALIASES = {
  'posinrange60': 'posInRange60', 'posinrange': 'posInRange60', 'pos_in_range': 'posInRange60',
  'range_position': 'posInRange60', 'rangeposition': 'posInRange60', 'position_in_range': 'posInRange60',
  'positioninrange': 'posInRange60', 'range_pos': 'posInRange60', 'range': 'posInRange60',
  'volstate': 'volState', 'vol_state': 'volState', 'volatility_state': 'volState',
  'volatilitystate': 'volState', 'vol': 'volState',
  'volratio': 'volRatio', 'vol_ratio': 'volRatio', 'volatility_ratio': 'volRatio',
  'atr_compression': 'atr_compression', 'atrcompression': 'atr_compression', 'atr': 'atr_compression',
  'atr_compress': 'atr_compression',
};

function resolveField(name) {
  if (!name) return null;
  return FIELD_ALIASES[name.toLowerCase().trim()] || name;
}

function parseComparison(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^([<>=!]+)\s*([\d.]+)/);
  if (m) return { op: m[1], val: parseFloat(m[2]) };
  const n = parseFloat(s);
  if (!isNaN(n)) return { op: '=', val: n };
  return null;
}

function passesComparison(actual, op, expected) {
  switch (op) {
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '=': case '==': return actual === expected;
    case '!=': case '<>': return actual !== expected;
    default: return true;
  }
}

function numFmt(v) { return typeof v === 'number' ? v.toFixed(3) : String(v); }

// ═══════════════════════════════════════════════════════════════
// FILTER EVALUATION — Same as live-signals.cjs
// ═══════════════════════════════════════════════════════════════

function checkFilters(signal, regimeSnap, filters, tfLabel) {
  for (const filter of filters) {
    const ftf = (filter.timeframe || 'all').toLowerCase();
    if (ftf !== 'all' && ftf !== tfLabel) continue;

    let cond = typeof filter.conditions === 'string' ? JSON.parse(filter.conditions) : filter.conditions;
    if (!cond) continue;

    let depth = 0;
    while (cond.conditions && typeof cond.conditions === 'object' && depth < 5) {
      cond = cond.conditions; depth++;
    }

    const blockReason = evaluateConditions(cond, signal, regimeSnap, filter);
    if (blockReason) return { pass: false, filterId: filter.id, reason: blockReason };
  }
  return { pass: true, filterId: null, reason: null };
}

function evaluateConditions(cond, signal, snap, filter) {
  if (cond.rules && Array.isArray(cond.rules)) {
    for (const rule of cond.rules) {
      if (rule.direction && rule.direction !== 'BOTH' && signal.direction !== rule.direction) continue;
      const field = resolveField(rule.feature || filter.feature);
      const val = snap[field];
      if (val === undefined || val === null) continue;
      if (rule.min !== undefined && val < rule.min) return `${field} ${numFmt(val)} < ${rule.min}`;
      if (rule.max !== undefined && val > rule.max) return `${field} ${numFmt(val)} > ${rule.max}`;
      if (rule.equal !== undefined && String(val) === String(rule.equal)) return `${field} = ${rule.equal}`;
    }
  }

  for (const blockKey of ['block_all', 'block_longs', 'block_shorts']) {
    if (!cond[blockKey]) continue;
    if (blockKey === 'block_longs' && signal.direction !== 'LONG') continue;
    if (blockKey === 'block_shorts' && signal.direction !== 'SHORT') continue;
    const sub = cond[blockKey];
    for (const [k, v] of Object.entries(sub)) {
      const field = resolveField(k);
      if (!field || snap[field] === undefined) continue;
      if (typeof v === 'string') {
        const cmp = parseComparison(v);
        if (cmp && typeof snap[field] === 'number') {
          if (!passesComparison(snap[field], cmp.op, cmp.val)) return `${field} ${numFmt(snap[field])} fails ${v} (${blockKey})`;
        } else if (String(snap[field]) === String(v)) {
          return `${field} = ${v} (${blockKey})`;
        }
      }
    }
  }

  for (const [key, dir] of [['block_when', null], ['block_long_when', 'LONG'], ['block_short_when', 'SHORT']]) {
    if (!cond[key]) continue;
    if (dir && signal.direction !== dir) continue;
    const result = evaluateStringExpr(String(cond[key]), snap);
    if (result) return `${cond[key]} → true (${key})`;
  }

  if (cond.condition && typeof cond.condition === 'string') {
    const result = evaluateStringExpr(cond.condition, snap);
    if (result) return `${cond.condition.slice(0, 60)} → true`;
  }

  for (const [key, val] of Object.entries(cond)) {
    if (['feature', 'timeframe', 'filter_type', 'action', 'logic', 'duration', 'details',
         'rationale', 'monitoring', 'auto_expire', 'filter_name', 'rollback_plan',
         'implementation_notes', 'data_source', 'logging', 'diagnostic_flag',
         'log_every_evaluation', 'heartbeat_monitor', 'diagnostic_logging',
         'log_fields', 'activation_window', 'additional_request', 'scope',
         'direction', 'rules', 'block_all', 'block_longs', 'block_shorts',
         'block_when', 'block_long_when', 'block_short_when', 'condition',
         'features', 'constraints', 'review_timeline', 'implementation_steps',
         'signal_direction', 'coin_coverage'].includes(key)) continue;

    const field = resolveField(key);
    if (!field || snap[field] === undefined) continue;
    const actual = snap[field];

    if (Array.isArray(val)) {
      const hasComparisons = val.some(v => typeof v === 'string' && /^[<>=!]/.test(v.trim()));
      if (hasComparisons) {
        for (const v of val) {
          const cmp = parseComparison(v);
          if (cmp && typeof actual === 'number') {
            if (!passesComparison(actual, cmp.op, cmp.val)) return `${field} ${numFmt(actual)} fails ${v}`;
          }
        }
      } else {
        if (!val.map(v => String(v).toUpperCase()).includes(String(actual).toUpperCase())) {
          return `${field} = ${actual}, not in [${val.join(', ')}]`;
        }
      }
      continue;
    }

    if (typeof val === 'string') {
      const cmp = parseComparison(val);
      if (cmp && typeof actual === 'number') {
        if (!passesComparison(actual, cmp.op, cmp.val)) return `${field} ${numFmt(actual)} fails requirement ${val}`;
      } else if (typeof actual === 'string') {
        if (String(actual).toUpperCase() !== String(val).toUpperCase()) {
          return `${field} = ${actual}, required ${val}`;
        }
      }
    }
  }

  const mainField = resolveField(cond.feature || filter.feature);
  const mainVal = mainField ? snap[mainField] : undefined;
  if (mainVal !== undefined) {
    if (cond.min !== undefined && mainVal < cond.min) return `${mainField} ${numFmt(mainVal)} < ${cond.min}`;
    if (cond.max !== undefined && mainVal > cond.max) return `${mainField} ${numFmt(mainVal)} > ${cond.max}`;
    if (cond.equal !== undefined && String(mainVal) === String(cond.equal)) return `${mainField} = ${cond.equal}`;
  }

  return null;
}

function evaluateStringExpr(expr, snap) {
  const str = String(expr).toUpperCase();
  const matches = [...str.matchAll(/(\w+)\s*([<>=!]+)\s*['"]?([^'")\s,]+)['"]?/g)];
  for (const m of matches) {
    const field = resolveField(m[1]);
    if (!field || snap[field] === undefined) continue;
    const actual = snap[field];
    const target = m[3]; const op = m[2];
    if (typeof actual === 'number') {
      const num = parseFloat(target);
      if (!isNaN(num) && passesComparison(actual, op, num)) return true;
    } else if (op === '=' || op === '==') {
      if (String(actual).toUpperCase() === target.toUpperCase()) return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// REGIME SNAPSHOT RECONSTRUCTION
// Rebuilds a regime snapshot from candle data at signal time
// for signals that don't already have one stored
// ═══════════════════════════════════════════════════════════════

function computeQuickRegime(bars) {
  if (bars.length < 60) return null;
  const recent = bars.slice(-60);
  const closes = recent.map(b => b.close);
  const high60 = Math.max(...closes);
  const low60 = Math.min(...closes);
  const range60 = high60 - low60;
  const posInRange60 = range60 > 0 ? (closes[closes.length - 1] - low60) / range60 : 0.5;

  const recentVol = stddev(closes.slice(-20).map((c, i, a) => i > 0 ? (c - a[i-1]) / a[i-1] * 100 : 0).slice(1));
  const longerVol = stddev(closes.map((c, i, a) => i > 0 ? (c - a[i-1]) / a[i-1] * 100 : 0).slice(1));
  const volRatio = longerVol > 0 ? recentVol / longerVol : 1;
  const volState = volRatio < 0.7 ? 'COMPRESSED' : volRatio > 1.3 ? 'EXPANDING' : 'NORMAL';

  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);
  const atrs = highs.map((h, i) => h - lows[i]);
  const atrMean = atrs.reduce((a, b) => a + b, 0) / atrs.length;
  const atr_compression = atrMean > 0 ? atrs.slice(-5).reduce((a, b) => a + b, 0) / 5 / atrMean : 1;

  return { posInRange60, volRatio, volState, atr_compression, high60, low60, lastClose: closes[closes.length - 1] };
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, v) => a + (v - mean) ** 2, 0) / arr.length);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(`✗ DATABASE_URL not found!`);
    process.exit(1);
  }
  const masked = dbUrl.replace(/:([^@]+)@/, ':***@');
  console.log(`\nDB: ${masked}`);

  const client = new Client({ connectionString: dbUrl });
  try { await client.connect(); } catch (err) {
    console.error(`✗ DB connection failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`✓ Connected\n`);

  // ── UNDO MODE ──
  if (UNDO_MODE) {
    console.log(`╔═══════════════════════════════════════════════════╗`);
    console.log(`║  UNDO — Restoring retroactively filtered signals  ║`);
    console.log(`╚═══════════════════════════════════════════════════╝\n`);

    const { rowCount } = await client.query(`
      UPDATE "FracmapSignal"
      SET status = 'closed', filtered_by = NULL
      WHERE status = 'filtered_closed'
        AND filtered_by IS NOT NULL
    `);
    console.log(`✓ Restored ${rowCount} signals from 'filtered_closed' → 'closed'`);
    await client.end();
    return;
  }

  // ── NORMAL MODE: Apply filters retroactively ──
  console.log(`╔═══════════════════════════════════════════════════╗`);
  console.log(`║  RETROACTIVE FILTER APPLICATION                    ║`);
  console.log(`║  Mode: ${DRY_RUN ? 'DRY RUN (preview only)       ' : 'LIVE — modifying signal statuses'}       ║`);
  console.log(`╚═══════════════════════════════════════════════════╝\n`);

  // Load active filters
  let filters = [];
  try {
    const { rows } = await client.query(
      `SELECT id, feature, conditions, COALESCE(timeframe, 'all') as timeframe
       FROM board_filters WHERE active = true ORDER BY created_at`
    );
    filters = rows;
  } catch { }

  if (filters.length === 0) {
    console.log(`✗ No active board filters found. Nothing to apply.`);
    await client.end();
    return;
  }

  console.log(`✓ Loaded ${filters.length} active filter(s):`);
  for (const f of filters) {
    const cond = typeof f.conditions === 'string' ? JSON.parse(f.conditions) : f.conditions;
    console.log(`  #${f.id} — ${f.feature || 'multi'} [${f.timeframe}] ${JSON.stringify(cond).slice(0, 80)}...`);
  }

  // Load strategy barMinutes mapping for TF label determination
  const strategyBarMinutes = {};
  try {
    const { rows } = await client.query(`SELECT id, "barMinutes" FROM "FracmapStrategy"`);
    for (const r of rows) strategyBarMinutes[r.id] = r.barMinutes;
  } catch { }

  // Load ALL closed signals (the visible ones on /signals)
  const { rows: signals } = await client.query(`
    SELECT id, symbol, direction, "entryPrice", "exitPrice", "returnPct",
           status, "createdAt", "closedAt", "holdBars", "strategyId",
           regime_snapshot, filtered_by
    FROM "FracmapSignal"
    WHERE status = 'closed'
    ORDER BY "createdAt" ASC
  `);

  console.log(`\n✓ Found ${signals.length} closed signals to evaluate\n`);

  if (signals.length === 0) {
    console.log(`Nothing to do.`);
    await client.end();
    return;
  }

  // Show the date range
  const earliest = signals[0].createdAt;
  const latest = signals[signals.length - 1].createdAt;
  console.log(`  Date range: ${new Date(earliest).toISOString().slice(0, 10)} → ${new Date(latest).toISOString().slice(0, 10)}`);

  // Pre-compute: group signals by symbol for efficient candle fetching
  const bySymbol = {};
  for (const sig of signals) {
    if (!bySymbol[sig.symbol]) bySymbol[sig.symbol] = [];
    bySymbol[sig.symbol].push(sig);
  }

  const symbols = Object.keys(bySymbol);
  console.log(`  Across ${symbols.length} unique coins\n`);

  // Stats
  let totalChecked = 0;
  let totalBlocked = 0;
  let totalPassed = 0;
  let totalNoSnapshot = 0;
  let blockedReturn = 0;   // Sum of returns that would have been blocked
  let passedReturn = 0;    // Sum of returns that passed
  const blockedByFilter = {}; // filterId → count
  const blockedDetails = [];  // For the summary table

  // Process each symbol
  for (const symbol of symbols) {
    const sigList = bySymbol[symbol];

    // Determine which candle table to use based on strategy
    // We need to figure out the barMinutes for regime reconstruction
    const firstSig = sigList[0];
    const barMinutes = firstSig.strategyId ? (strategyBarMinutes[firstSig.strategyId] || 60) : 60;
    const table = barMinutes >= 1440 ? 'Candle1d' : barMinutes >= 60 ? 'Candle1h' : 'Candle1m';
    const tfLabel = barMinutes >= 1440 ? '1d' : barMinutes >= 60 ? '1h' : '1m';

    // Fetch candles for this symbol covering the full signal range
    // Need 60 bars before the earliest signal for regime computation
    const earliestSigTime = new Date(sigList[0].createdAt);
    const paddedStart = new Date(earliestSigTime.getTime() - 80 * barMinutes * 60_000);

    let candles;
    try {
      const { rows } = await client.query(
        `SELECT timestamp as time, open, high, low, close
         FROM "${table}" WHERE symbol = $1 AND timestamp >= $2
         ORDER BY timestamp ASC`,
        [symbol, paddedStart]
      );
      candles = rows.map(r => ({
        time: new Date(r.time).getTime(),
        open: +r.open, high: +r.high, low: +r.low, close: +r.close,
      }));
    } catch {
      // Try fallback table
      try {
        const { rows } = await client.query(
          `SELECT timestamp as time, open, high, low, close
           FROM "Candle1h" WHERE symbol = $1 AND timestamp >= $2
           ORDER BY timestamp ASC`,
          [symbol, paddedStart]
        );
        candles = rows.map(r => ({
          time: new Date(r.time).getTime(),
          open: +r.open, high: +r.high, low: +r.low, close: +r.close,
        }));
      } catch {
        candles = [];
      }
    }

    if (candles.length < 60) {
      totalNoSnapshot += sigList.length;
      continue;
    }

    // Process each signal for this symbol
    for (const sig of sigList) {
      totalChecked++;
      const sigTime = new Date(sig.createdAt).getTime();

      // Get or reconstruct regime snapshot
      let snap = null;
      if (sig.regime_snapshot) {
        snap = typeof sig.regime_snapshot === 'string' ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
      }

      if (!snap || Object.keys(snap).length === 0) {
        // Reconstruct from candle data at signal time
        // Find candles up to signal time
        const barsUpToSignal = candles.filter(c => c.time <= sigTime);
        if (barsUpToSignal.length >= 60) {
          snap = computeQuickRegime(barsUpToSignal);
        }
      }

      if (!snap) {
        totalNoSnapshot++;
        totalPassed++;
        passedReturn += parseFloat(sig.returnPct) || 0;
        continue;
      }

      // Check filters
      const filterResult = checkFilters(
        { direction: sig.direction },
        snap,
        filters,
        tfLabel
      );

      const ret = parseFloat(sig.returnPct) || 0;

      if (!filterResult.pass) {
        totalBlocked++;
        blockedReturn += ret;
        blockedByFilter[filterResult.filterId] = (blockedByFilter[filterResult.filterId] || 0) + 1;

        blockedDetails.push({
          id: sig.id,
          symbol: sig.symbol,
          direction: sig.direction,
          returnPct: ret,
          date: new Date(sig.createdAt).toISOString().slice(0, 10),
          filter: filterResult.filterId,
          reason: filterResult.reason,
        });

        // Update the signal in DB
        if (!DRY_RUN) {
          await client.query(
            `UPDATE "FracmapSignal"
             SET status = 'filtered_closed',
                 filtered_by = $1,
                 regime_snapshot = COALESCE(regime_snapshot, $2::jsonb)
             WHERE id = $3`,
            [filterResult.filterId, JSON.stringify(snap), sig.id]
          );
        }
      } else {
        totalPassed++;
        passedReturn += ret;
      }
    }
  }

  // ── Summary ──
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  RETROACTIVE FILTER RESULTS                                   ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Signals checked:      ${String(totalChecked).padStart(6)}                              ║`);
  console.log(`║  Would have blocked:   ${String(totalBlocked).padStart(6)}  (${(totalBlocked/totalChecked*100).toFixed(1)}%)                       ║`);
  console.log(`║  Would have passed:    ${String(totalPassed).padStart(6)}  (${(totalPassed/totalChecked*100).toFixed(1)}%)                       ║`);
  console.log(`║  No snapshot (kept):   ${String(totalNoSnapshot).padStart(6)}                              ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║  RETURN IMPACT                                                ║`);
  console.log(`║  Blocked signals total return: ${blockedReturn >= 0 ? '+' : ''}${blockedReturn.toFixed(2)}%${' '.repeat(Math.max(0, 24 - blockedReturn.toFixed(2).length))}║`);
  console.log(`║  Passed signals total return:  ${passedReturn >= 0 ? '+' : ''}${passedReturn.toFixed(2)}%${' '.repeat(Math.max(0, 24 - passedReturn.toFixed(2).length))}║`);

  const savedReturn = blockedReturn < 0 ? Math.abs(blockedReturn) : -blockedReturn;
  const verdict = blockedReturn < 0 ? '🟢 FILTERS WOULD HAVE SAVED' : '🔴 FILTERS WOULD HAVE HURT';
  console.log(`║  Net saved by filters:         ${savedReturn >= 0 ? '+' : ''}${savedReturn.toFixed(2)}%${' '.repeat(Math.max(0, 24 - savedReturn.toFixed(2).length))}║`);
  console.log(`║  Verdict: ${verdict}${' '.repeat(Math.max(0, 42 - verdict.length))}║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);

  // Breakdown by filter
  if (Object.keys(blockedByFilter).length > 0) {
    console.log(`\n── Blocks by filter ──`);
    for (const [fid, count] of Object.entries(blockedByFilter)) {
      const filterSigs = blockedDetails.filter(d => String(d.filter) === String(fid));
      const filterReturn = filterSigs.reduce((s, d) => s + d.returnPct, 0);
      const filterLosses = filterSigs.filter(d => d.returnPct < 0);
      const filterWins = filterSigs.filter(d => d.returnPct > 0);
      console.log(`  Filter #${fid}: ${count} blocked (${filterWins.length} winners, ${filterLosses.length} losers) → return ${filterReturn >= 0 ? '+' : ''}${filterReturn.toFixed(2)}%`);
    }
  }

  // Show worst blocked trades (the big saves)
  const worstBlocked = blockedDetails.filter(d => d.returnPct < 0).sort((a, b) => a.returnPct - b.returnPct).slice(0, 10);
  if (worstBlocked.length > 0) {
    console.log(`\n── Worst trades filters would have saved you from ──`);
    for (const d of worstBlocked) {
      console.log(`  ${d.date} ${d.symbol.padEnd(12)} ${d.direction.padEnd(6)} ${d.returnPct.toFixed(2)}%  ← blocked by #${d.filter} (${d.reason.slice(0, 50)})`);
    }
  }

  // Show best blocked trades (the ones filters would have wrongly killed)
  const bestBlocked = blockedDetails.filter(d => d.returnPct > 0).sort((a, b) => b.returnPct - a.returnPct).slice(0, 5);
  if (bestBlocked.length > 0) {
    console.log(`\n── Best trades filters would have wrongly blocked ──`);
    for (const d of bestBlocked) {
      console.log(`  ${d.date} ${d.symbol.padEnd(12)} ${d.direction.padEnd(6)} +${d.returnPct.toFixed(2)}%  ← blocked by #${d.filter} (${d.reason.slice(0, 50)})`);
    }
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] No DB changes made. Run without --dry to apply.`);
  } else if (totalBlocked > 0) {
    console.log(`\n✓ ${totalBlocked} signals moved from 'closed' → 'filtered_closed'`);
    console.log(`  Your /signals page will now show the filtered history.`);
    console.log(`\n  To UNDO this:  node backend/retroactive-filter.cjs --undo`);
  }

  await client.end();
}

main().catch(err => {
  console.error(`\n✗ FATAL:`, err);
  console.error(`\nStack:`, err.stack);
  process.exit(1);
});
