/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — 1D SIGNAL BACKFILL                                    ║
 * ║                                                                  ║
 * ║  Regenerates prediction history for the 1D strategy on all      ║
 * ║  coins for the last N days. Uses the exact same fracmap +       ║
 * ║  signal detection + board filter logic as live-signals.cjs.     ║
 * ║                                                                  ║
 * ║  Usage (PowerShell):                                            ║
 * ║    cd <project-root>                                            ║
 * ║    node backend/backfill-1d-signals.cjs                         ║
 * ║                                                                  ║
 * ║  Options (edit below):                                          ║
 * ║    BACKFILL_DAYS  — how many days back to regenerate (default 5)║
 * ║    DRY_RUN        — set true to preview without writing to DB   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // backend/.env
if (!process.env.DATABASE_URL) {
  require('dotenv').config(); // Try CWD as fallback
}
const { Client } = require('pg');

// ═══════════════════════════════════════════════════════════════
// CONFIG — Edit these as needed
// ═══════════════════════════════════════════════════════════════
const BACKFILL_DAYS = 5;
const DRY_RUN = false;  // Set true to just preview signals without writing
const BAR_MINUTES = 1440;
const TABLE = 'Candle1d';
const TF_LABEL = '1d';
const PHI = 1.618034;

// Default 1D strategy params (overridden by whatever is active in DB)
const DEFAULT_1D = {
  cycleMin: 2, cycleMax: 12,
  minStr: 1, minCyc: 0, spike: false, nearMiss: false,
  holdDiv: 2, priceExt: true,
};

// ═══════════════════════════════════════════════════════════════
// FRACMAP CORE — Identical to live-signals.cjs & scanner
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
// SIGNAL DETECTION — Identical to live-signals.cjs
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
    const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null &&
      bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);

    if (buyAtI || buyNear) {
      if (spikeFilter) {
        const sH = isLocalMax(band.lower, i, sw);
        const sN = nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw));
        if (!sH && !sN) continue;
      }
      buyStrength++;
      if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle;
      if (band.order > maxBuyOrder) maxBuyOrder = band.order;
    }

    const sellAtI = bars[i].high > up && bars[i].close < up;
    const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null &&
      bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);

    if (sellAtI || sellNear) {
      if (spikeFilter) {
        const sH = isLocalMin(band.upper, i, sw);
        const sN = nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw));
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
      entryPrice: (i + 1 < bars.length) ? bars[i + 1].open : bars[i].close,
    };
  }

  if (sellStrength >= minStr && maxSellCycle >= minCyc) {
    if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) return null;
    const holdBars = Math.round(maxSellCycle / holdDiv);
    return {
      direction: 'SHORT', strength: sellStrength,
      maxCycle: maxSellCycle, maxOrder: maxSellOrder, holdBars,
      entryPrice: (i + 1 < bars.length) ? bars[i + 1].open : bars[i].close,
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// REGIME SNAPSHOT — Identical to live-signals.cjs
// ═══════════════════════════════════════════════════════════════

function computeQuickRegime(bars) {
  if (bars.length < 60) return {};
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
// BOARD FILTER LOGIC — Identical to live-signals.cjs
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
  const lower = name.toLowerCase().trim();
  return FIELD_ALIASES[lower] || name;
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

function checkFilters(signal, regimeSnap, filters) {
  for (const filter of filters) {
    const ftf = (filter.timeframe || 'all').toLowerCase();
    if (ftf !== 'all' && ftf !== TF_LABEL) continue;

    let cond = typeof filter.conditions === 'string' ? JSON.parse(filter.conditions) : filter.conditions;
    if (!cond) continue;

    let depth = 0;
    while (cond.conditions && typeof cond.conditions === 'object' && depth < 5) {
      cond = cond.conditions;
      depth++;
    }

    const blockReason = evaluateConditions(cond, signal, regimeSnap, filter);
    if (blockReason) return { pass: false, filterId: filter.id, reason: blockReason };
  }
  return { pass: true, filterId: null, reason: null };
}

function evaluateConditions(cond, signal, snap, filter) {
  // RULES ARRAY
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

  // BLOCK_ALL / BLOCK_LONGS / BLOCK_SHORTS
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

  // BLOCK_WHEN / BLOCK_LONG_WHEN / BLOCK_SHORT_WHEN
  for (const [key, dir] of [['block_when', null], ['block_long_when', 'LONG'], ['block_short_when', 'SHORT']]) {
    if (!cond[key]) continue;
    if (dir && signal.direction !== dir) continue;
    const expr = String(cond[key]);
    const result = evaluateStringExpr(expr, snap);
    if (result) return `${expr} → true (${key})`;
  }

  // CONDITION STRING
  if (cond.condition && typeof cond.condition === 'string') {
    const result = evaluateStringExpr(cond.condition, snap);
    if (result) return `${cond.condition.slice(0, 60)} → true`;
  }

  // ALLOWLIST / THRESHOLD per-key
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

  // SIMPLE THRESHOLD on filter.feature
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
    const target = m[3];
    const op = m[2];
    if (typeof actual === 'number') {
      const num = parseFloat(target);
      if (!isNaN(num) && passesComparison(actual, op, num)) return true;
    } else {
      if (op === '=' || op === '==') {
        if (String(actual).toUpperCase() === target.toUpperCase()) return true;
      }
    }
  }
  return false;
}

function numFmt(v) { return typeof v === 'number' ? v.toFixed(3) : String(v); }


// ═══════════════════════════════════════════════════════════════
// MAIN BACKFILL
// ═══════════════════════════════════════════════════════════════

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(`✗ DATABASE_URL not found in environment!`);
    console.error(`  Looked for .env in: ${process.cwd()}, ${__dirname}, ${require('path').join(__dirname, '..')}`);
    console.error(`  Fix: make sure .env or .env.local exists with DATABASE_URL=postgresql://...`);
    process.exit(1);
  }
  // Mask password for display
  const masked = dbUrl.replace(/:([^@]+)@/, ':***@');
  console.log(`\nDB: ${masked}`);

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
  } catch (err) {
    console.error(`✗ Failed to connect to database: ${err.message}`);
    console.error(`  Is PostgreSQL running? Check your DATABASE_URL.`);
    process.exit(1);
  }
  console.log(`✓ Connected to database\n`);

  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║  NTLGNC — 1D SIGNAL BACKFILL (${BACKFILL_DAYS} days)             ║`);
  console.log(`║  Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE — writing to FracmapSignal'}       ║`);
  console.log(`╚═══════════════════════════════════════════════════╝\n`);

  // ── Step 1: Load the active 1D strategy from DB ──
  const { rows: stratRows } = await client.query(
    `SELECT * FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = $1
     ORDER BY "updatedAt" DESC LIMIT 1`,
    [BAR_MINUTES]
  );

  let strategy, strategyId;
  if (stratRows.length > 0) {
    const s = stratRows[0];
    strategyId = s.id;
    strategy = {
      minStr: s.minStr ?? DEFAULT_1D.minStr,
      minCyc: s.minCyc ?? DEFAULT_1D.minCyc,
      spike: s.spike ?? DEFAULT_1D.spike,
      nearMiss: s.nearMiss ?? DEFAULT_1D.nearMiss,
      holdDiv: s.holdDiv ?? DEFAULT_1D.holdDiv,
      priceExt: s.priceExt ?? DEFAULT_1D.priceExt,
      cycleMin: s.cycleMin ?? DEFAULT_1D.cycleMin,
      cycleMax: s.cycleMax ?? DEFAULT_1D.cycleMax,
    };
    console.log(`✓ Found active 1D strategy: "${s.name}" (id=${s.id})`);
    console.log(`  ×${strategy.minStr} C≥${strategy.minCyc} ÷${strategy.holdDiv} cycles=${strategy.cycleMin}-${strategy.cycleMax} spike=${strategy.spike} nearMiss=${strategy.nearMiss} priceExt=${strategy.priceExt}`);
  } else {
    strategyId = null;
    strategy = DEFAULT_1D;
    console.log(`⚠ No active 1D strategy in DB — using defaults`);
    console.log(`  ×${strategy.minStr} C≥${strategy.minCyc} ÷${strategy.holdDiv} cycles=${strategy.cycleMin}-${strategy.cycleMax}`);
  }

  const barsNeeded = strategy.cycleMax * 8;

  // ── Step 2: Load board filters ──
  let filters = [];
  try {
    const { rows } = await client.query(
      `SELECT id, feature, conditions, COALESCE(timeframe, 'all') as timeframe
       FROM board_filters WHERE active = true ORDER BY created_at`
    );
    filters = rows;
    console.log(`✓ Loaded ${filters.length} active board filter(s)`);
  } catch {
    console.log(`⚠ No board_filters table or no active filters`);
  }

  // ── Step 3: Get all coins that have 1D candle data ──
  const { rows: coinRows } = await client.query(
    `SELECT DISTINCT symbol FROM "${TABLE}" ORDER BY symbol`
  );
  const coins = coinRows.map(r => r.symbol);
  console.log(`✓ Found ${coins.length} coins with daily candle data\n`);

  // ── Step 4: Determine the backfill date range ──
  // We want to simulate what would have happened at each daily bar close
  // for the last BACKFILL_DAYS days.
  const now = new Date();
  const backfillDates = [];
  for (let d = BACKFILL_DAYS; d >= 1; d--) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - d);
    date.setUTCHours(0, 0, 0, 0); // Daily candles are at 00:00 UTC
    backfillDates.push(date);
  }

  console.log(`Backfill dates (UTC midnight):`);
  for (const d of backfillDates) {
    console.log(`  ${d.toISOString().slice(0, 10)}`);
  }

  // ── Step 5: Find existing 1D signals (stuck open or missing closes) ──
  const windowStart = backfillDates[0];

  // 5a: Load existing signals for this strategy in the window
  const { rows: existingSignals } = await client.query(
    `SELECT id, symbol, direction, "entryPrice", "holdBars", "createdAt", status, "returnPct", "exitPrice"
     FROM "FracmapSignal"
     WHERE "strategyId" = $1 AND "createdAt" >= $2
     ORDER BY "createdAt"`,
    [strategyId, windowStart]
  );

  // Build a set of existing signal keys (symbol+date+direction) to avoid duplicates
  const existingKeys = new Set();
  for (const s of existingSignals) {
    const dateKey = new Date(s.createdAt).toISOString().slice(0, 10);
    existingKeys.add(`${s.symbol}|${dateKey}|${s.direction}`);
  }

  const stuckOpen = existingSignals.filter(s => s.status === 'open');
  const alreadyClosed = existingSignals.filter(s => s.status === 'closed');
  console.log(`\n✓ Found ${existingSignals.length} existing 1D signals in window:`);
  console.log(`  ${stuckOpen.length} stuck open, ${alreadyClosed.length} already closed, ${existingSignals.length - stuckOpen.length - alreadyClosed.length} other\n`);

  // ── Step 6: Generate NEW signals for dates/coins that are missing ──
  let totalCreated = 0;
  let totalFiltered = 0;
  let totalClosed = 0;
  let totalSkipped = 0;
  let totalDuplicatesSkipped = 0;

  for (const targetDate of backfillDates) {
    const dateStr = targetDate.toISOString().slice(0, 10);
    let dayCreated = 0;
    let dayFiltered = 0;
    let daySkipDup = 0;

    process.stdout.write(`\n── ${dateStr} ──`);

    for (const symbol of coins) {
      try {
        const { rows } = await client.query(
          `SELECT timestamp as time, open, high, low, close
           FROM "${TABLE}" WHERE symbol = $1 AND timestamp <= $2
           ORDER BY timestamp DESC LIMIT $3`,
          [symbol, targetDate, barsNeeded + 2]
        );

        if (rows.length < Math.min(60, Math.floor(barsNeeded * 0.8))) continue;

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

        const lastBar = bars.length - 2;
        if (lastBar < 20) continue;

        const signal = detectSignalAtBar(bars, allBands, lastBar, strategy);
        if (!signal) continue;

        // Check if we already have this signal
        const sigKey = `${symbol}|${dateStr}|${signal.direction}`;
        if (existingKeys.has(sigKey)) {
          daySkipDup++;
          totalDuplicatesSkipped++;
          continue;
        }

        const regimeSnap = computeQuickRegime(bars);
        const filterResult = checkFilters(signal, regimeSnap, filters);

        const signalTime = new Date(targetDate);
        signalTime.setUTCHours(0, 15, 0, 0);

        if (!filterResult.pass) {
          if (!DRY_RUN) {
            await client.query(
              `INSERT INTO "FracmapSignal"
               ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder",
                status, filtered_by, regime_snapshot, "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'filtered', $9, $10, $11)`,
              [strategyId, symbol, signal.direction, signal.entryPrice,
               signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder,
               filterResult.filterId, JSON.stringify(regimeSnap), signalTime]
            );
          }
          dayFiltered++;
          totalFiltered++;
        } else {
          if (!DRY_RUN) {
            await client.query(
              `INSERT INTO "FracmapSignal"
               ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder",
                regime_snapshot, "createdAt", status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')`,
              [strategyId, symbol, signal.direction, signal.entryPrice,
               signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder,
               JSON.stringify(regimeSnap), signalTime]
            );
          }
          dayCreated++;
          totalCreated++;
        }

        existingKeys.add(sigKey); // Track so we don't double-insert
      } catch (err) {
        totalSkipped++;
      }
    }

    process.stdout.write(` → +${dayCreated} new, ${dayFiltered} filtered, ${daySkipDup} already existed`);
  }

  console.log(`\n`);

  // ── Step 7: Close ALL stuck-open signals (existing + newly created) ──
  if (!DRY_RUN) {
    console.log(`── Closing stuck-open signals ──`);

    const { rows: openSignals } = await client.query(
      `SELECT id, symbol, direction, "entryPrice", "holdBars", "createdAt"
       FROM "FracmapSignal"
       WHERE status = 'open'
         AND "strategyId" = $1
         AND "createdAt" >= $2`,
      [strategyId, windowStart]
    );

    console.log(`  Found ${openSignals.length} open signals to evaluate`);

    for (const sig of openSignals) {
      const holdMs = (sig.holdBars || 2) * BAR_MINUTES * 60 * 1000;
      const exitTime = new Date(new Date(sig.createdAt).getTime() + holdMs);

      if (exitTime > now) {
        // Not expired yet — leave as open
        continue;
      }

      // Find the candle closest to the exit time
      try {
        const { rows: candles } = await client.query(
          `SELECT open, close, timestamp FROM "${TABLE}"
           WHERE symbol = $1 AND timestamp <= $2
           ORDER BY timestamp DESC LIMIT 1`,
          [sig.symbol, exitTime]
        );

        if (candles.length === 0) continue;

        // Use OPEN of the exit bar (aligned with scanner/live logic)
        const exitPrice = parseFloat(candles[0].open);
        const ret = sig.direction === 'LONG'
          ? (exitPrice / sig.entryPrice - 1) * 100
          : (sig.entryPrice / exitPrice - 1) * 100;

        // Sanity check
        if (Math.abs(ret) > 50) {
          console.log(`  ⚠ ${sig.symbol} id=${sig.id}: return ${ret.toFixed(2)}% too extreme, skipping`);
          continue;
        }

        await client.query(
          `UPDATE "FracmapSignal"
           SET "exitPrice" = $1, "returnPct" = $2, status = 'closed', "closedAt" = $3
           WHERE id = $4`,
          [exitPrice, +ret.toFixed(4), exitTime, sig.id]
        );
        totalClosed++;
      } catch {}
    }

    // Also compute hypothetical returns for filtered signals
    const { rows: filteredSignals } = await client.query(
      `SELECT id, symbol, direction, "entryPrice", "holdBars", "createdAt"
       FROM "FracmapSignal"
       WHERE status = 'filtered'
         AND "strategyId" = $1
         AND "createdAt" >= $2
         AND "returnPct" IS NULL`,
      [strategyId, windowStart]
    );

    let filteredClosed = 0;
    for (const sig of filteredSignals) {
      const holdMs = (sig.holdBars || 2) * BAR_MINUTES * 60 * 1000;
      const exitTime = new Date(new Date(sig.createdAt).getTime() + holdMs);

      if (exitTime > now) continue;

      try {
        const { rows: candles } = await client.query(
          `SELECT open, close, timestamp FROM "${TABLE}"
           WHERE symbol = $1 AND timestamp <= $2
           ORDER BY timestamp DESC LIMIT 1`,
          [sig.symbol, exitTime]
        );

        if (candles.length === 0) continue;

        const exitPrice = parseFloat(candles[0].open);
        const ret = sig.direction === 'LONG'
          ? (exitPrice / sig.entryPrice - 1) * 100
          : (sig.entryPrice / exitPrice - 1) * 100;

        if (Math.abs(ret) > 50) continue;

        await client.query(
          `UPDATE "FracmapSignal"
           SET "exitPrice" = $1, "returnPct" = $2, status = 'filtered_closed', "closedAt" = $3
           WHERE id = $4`,
          [exitPrice, +ret.toFixed(4), exitTime, sig.id]
        );
        filteredClosed++;
      } catch {}
    }

    console.log(`  ✓ Closed ${totalClosed} open signals with returns`);
    console.log(`  ✓ Computed hypothetical returns for ${filteredClosed} filtered signals`);
  }

  // ── Summary ──
  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║  BACKFILL COMPLETE                                 ║`);
  console.log(`╠═══════════════════════════════════════════════════╣`);
  console.log(`║  NEW signals added:   ${String(totalCreated).padStart(5)}                         ║`);
  console.log(`║  NEW filtered:        ${String(totalFiltered).padStart(5)}                         ║`);
  console.log(`║  Already existed:     ${String(totalDuplicatesSkipped).padStart(5)}                         ║`);
  console.log(`║  Stuck-open closed:   ${String(totalClosed).padStart(5)}                         ║`);
  console.log(`║  Coins skipped:       ${String(totalSkipped).padStart(5)}                         ║`);
  console.log(`╚═══════════════════════════════════════════════════╝\n`);

  await client.end();
}

main().catch(err => {
  console.error(`\n✗ FATAL:`, err);
  console.error(`\nStack:`, err.stack);
  console.error(`\nMessage:`, err.message);
  console.error(`\nCode:`, err.code);
  process.exit(1);
});
