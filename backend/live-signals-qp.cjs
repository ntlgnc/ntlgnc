/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — LIVE SIGNAL ENGINE                                    ║
 * ║  Multi-timeframe autonomous signal generation                   ║
 * ║                                                                  ║
 * ║  Runs three concurrent loops:                                   ║
 * ║    1m  — every 60s,  checks latest 1-minute candles             ║
 * ║    1h  — every 5min, checks latest hourly candles               ║
 * ║    1d  — every 15min, checks latest daily candles               ║
 * ║                                                                  ║
 * ║  Each loop: fetch candles → compute bands → detect signals →    ║
 * ║  check board filters → write to FracmapSignal → close expired   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const { Client, Pool } = require('pg');
const { checkMatrix } = require('./filter-matrix-check.cjs');
const { checkCoinQuality, invalidateCoinCache } = require('./coin-quality-gate.cjs');
const { ensureCoinStrategyTables, getActiveCoinStrategies, invalidateCoinStrategyCache } = require('./coin-strategy-manager.cjs');
const { tweetSignal } = require('./tweet-signal.cjs');

const DB_URL = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: DB_URL, max: 20 });

const PHI = 1.618034;

// ═══════════════════════════════════════════════════════════════
// STRATEGY CONFIGS — Winner parameters from scanner results
// These get overridden by whatever's active in FracmapStrategy DB
// ═══════════════════════════════════════════════════════════════

const DEFAULT_STRATEGIES = {
  '1m': {
    barMinutes: 1, table: 'Candle1m', interval: 60_000,
    cycleMin: 10, cycleMax: 100,
    minStr: 1, minCyc: 55, spike: true, nearMiss: true, holdDiv: 4, priceExt: true,
    label: '1-Minute',
  },
  '1h': {
    barMinutes: 60, table: 'Candle1h', interval: 5 * 60_000,
    cycleMin: 55, cycleMax: 89,
    minStr: 1, minCyc: 64, spike: true, nearMiss: true, holdDiv: 5, priceExt: true,
    label: '1-Hour',
  },
  '1d': {
    barMinutes: 1440, table: 'Candle1d', interval: 15 * 60_000,
    cycleMin: 2, cycleMax: 12,
    minStr: 1, minCyc: 0, spike: false, nearMiss: false, holdDiv: 2, priceExt: true,
    label: '1-Day',
  },
};

// ═══════════════════════════════════════════════════════════════
// FRACMAP CORE — Identical to scanner/robustness
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
// SIGNAL DETECTION — Last-bar only (live mode)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// LIVE LOOP — One per timeframe
// ═══════════════════════════════════════════════════════════════

async function getCoins(client) {
  try {
    const { rows } = await client.query(
      `SELECT DISTINCT symbol FROM "Candle1h" LIMIT 200`
    );
    return rows.map(r => r.symbol);
  } catch {
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT',
            'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT'];
  }
}

async function getActiveStrategy(client, barMinutes) {
  try {
    const { rows } = await client.query(
      `SELECT * FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = $1 
       ORDER BY "updatedAt" DESC LIMIT 1`,
      [barMinutes]
    );
    if (rows[0]) return rows[0];
  } catch {}
  return null;
}

async function getExcludedCoins(client) {
  try {
    const { rows } = await client.query(
      `SELECT symbol FROM board_coin_overrides WHERE active = true AND override_type = 'exclude'`
    );
    return new Set(rows.map(r => r.symbol));
  } catch {
    return new Set();
  }
}

async function getOpenSignals(client, strategyId) {
  try {
    if (strategyId) {
      const { rows } = await client.query(
        `SELECT * FROM "FracmapSignal" WHERE "strategyId" = $1 AND status IN ('open', 'pending')`,
        [strategyId]
      );
      return rows;
    } else {
      const { rows } = await client.query(
        `SELECT * FROM "FracmapSignal" WHERE "strategyId" IS NULL AND status IN ('open', 'pending')`
      );
      return rows;
    }
  } catch {
    return [];
  }
}

async function ensureSignalTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "FracmapSignal" (
      id SERIAL PRIMARY KEY,
      "strategyId" INTEGER,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      "entryPrice" FLOAT NOT NULL,
      "exitPrice" FLOAT,
      "targetPrice" FLOAT,
      "stopPrice" FLOAT,
      "returnPct" FLOAT,
      strength INTEGER DEFAULT 1,
      "holdBars" INTEGER DEFAULT 10,
      "maxCycle" INTEGER,
      "maxOrder" INTEGER,
      "triggerBands" JSONB,
      status TEXT DEFAULT 'open',
      "createdAt" TIMESTAMPTZ DEFAULT now(),
      "closedAt" TIMESTAMPTZ,
      filtered_by INTEGER,
      regime_snapshot JSONB
    )
  `);
  try {
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_status ON "FracmapSignal"(status, "strategyId")`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_created ON "FracmapSignal"("createdAt" DESC)`);
  } catch {}
  // Migrate: add columns if table already exists without them
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS filtered_by INTEGER`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS regime_snapshot JSONB`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS pair_id UUID`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS pair_symbol TEXT`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS pair_direction TEXT`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS pair_return FLOAT`); } catch {}
  try { await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_pair ON "FracmapSignal"(pair_id) WHERE pair_id IS NOT NULL`); } catch {}
  // Queue-and-pair columns
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS "detectedAt" TIMESTAMPTZ`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS "enteredAt" TIMESTAMPTZ`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS "detectedPrice" FLOAT`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS pair_type TEXT`); } catch {}
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS tick_id TEXT`); } catch {}
  try { await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_pending ON "FracmapSignal"(status, "strategyId", direction) WHERE status = 'pending'`); } catch {}
  // Backfill existing data
  try { await client.query(`UPDATE "FracmapSignal" SET "detectedAt" = "createdAt" WHERE "detectedAt" IS NULL`); } catch {}
  try { await client.query(`UPDATE "FracmapSignal" SET "enteredAt" = "createdAt" WHERE "enteredAt" IS NULL AND status IN ('open', 'closed')`); } catch {}
}

async function runTimeframeLoop(tfKey) {
  const config = DEFAULT_STRATEGIES[tfKey];
  const barsNeeded = config.cycleMax * 8;

  // ── Board filter functions (inline CJS — can't import from ESM llm-board.js) ──
  async function loadActiveFilters(client) {
    try {
      const { rows } = await client.query(
        `SELECT id, feature, conditions, COALESCE(timeframe, 'all') as timeframe
         FROM board_filters WHERE active = true ORDER BY created_at`
      );
      return rows;
    } catch { return []; }
  }

  // ── FIELD NAME ALIASES — LLMs use many names for the same thing ──
  const FIELD_ALIASES = {
    // posInRange60
    'posinrange60': 'posInRange60', 'posinrange': 'posInRange60', 'pos_in_range': 'posInRange60',
    'range_position': 'posInRange60', 'rangeposition': 'posInRange60', 'position_in_range': 'posInRange60',
    'positioninrange': 'posInRange60', 'range_pos': 'posInRange60', 'range': 'posInRange60',
    // volState
    'volstate': 'volState', 'vol_state': 'volState', 'volatility_state': 'volState',
    'volatilitystate': 'volState', 'vol': 'volState',
    // volRatio
    'volratio': 'volRatio', 'vol_ratio': 'volRatio', 'volatility_ratio': 'volRatio',
    // atr_compression
    'atr_compression': 'atr_compression', 'atrcompression': 'atr_compression', 'atr': 'atr_compression',
    'atr_compress': 'atr_compression',
  };

  function resolveField(name) {
    if (!name) return null;
    const lower = name.toLowerCase().trim();
    return FIELD_ALIASES[lower] || name;
  }

  // Parse a string like ">0.75", "< 0.25", ">= 0.7" into {op, val}
  function parseComparison(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/^([<>=!]+)\s*([\d.]+)/);
    if (m) return { op: m[1], val: parseFloat(m[2]) };
    // Try "0.25" as just a number
    const n = parseFloat(s);
    if (!isNaN(n)) return { op: '=', val: n };
    return null;
  }

  // Check if a numeric value passes a comparison
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

  // ── UNIVERSAL FILTER CHECKER ──
  // Interprets whatever creative JSON the LLMs produce
  function checkFilters(signal, regimeSnap, filters, tfLabel) {
    for (const filter of filters) {
      const ftf = (filter.timeframe || 'all').toLowerCase();
      if (ftf !== 'all' && ftf !== tfLabel) continue;

      let cond = typeof filter.conditions === 'string' ? JSON.parse(filter.conditions) : filter.conditions;
      if (!cond) continue;

      // Unwrap nested conditions (LLMs love wrapping)
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
    // ─── RULES ARRAY (structured format) ───
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

    // ─── BLOCK_ALL / BLOCK_LONGS / BLOCK_SHORTS ───
    for (const blockKey of ['block_all', 'block_longs', 'block_shorts']) {
      if (!cond[blockKey]) continue;
      if (blockKey === 'block_longs' && signal.direction !== 'LONG') continue;
      if (blockKey === 'block_shorts' && signal.direction !== 'SHORT') continue;
      const sub = cond[blockKey];
      for (const [k, v] of Object.entries(sub)) {
        const field = resolveField(k);
        if (!field || snap[field] === undefined) continue;
        // String match
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

    // ─── BLOCK_WHEN / BLOCK_LONG_WHEN / BLOCK_SHORT_WHEN (string expressions) ───
    for (const [key, dir] of [['block_when', null], ['block_long_when', 'LONG'], ['block_short_when', 'SHORT']]) {
      if (!cond[key]) continue;
      if (dir && signal.direction !== dir) continue;
      const expr = String(cond[key]);
      const result = evaluateStringExpr(expr, snap);
      if (result) return `${expr} → true (${key})`;
    }

    // ─── CONDITION STRING (prose: "IF VolState = 'COMPRESSED' THEN BLOCK") ───
    if (cond.condition && typeof cond.condition === 'string') {
      const result = evaluateStringExpr(cond.condition, snap);
      if (result) return `${cond.condition.slice(0, 60)} → true`;
    }

    // ─── ALLOWLIST FORMAT: {vol_state: ["NORMAL", "EXPANDING"]} → block if NOT in list ───
    // ─── THRESHOLD FORMAT: {range_position: ">0.25"} or {atr_compression: "> 0.7"} ───
    for (const [key, val] of Object.entries(cond)) {
      // Skip meta keys
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

      // Array = allowlist: signal passes only if value is IN the array
      if (Array.isArray(val)) {
        // Could be string allowlist ["NORMAL", "EXPANDING"] or comparison list [">0.25", "<0.75"]
        const hasComparisons = val.some(v => typeof v === 'string' && /^[<>=!]/.test(v.trim()));
        if (hasComparisons) {
          // All comparisons must pass for signal to be allowed
          for (const v of val) {
            const cmp = parseComparison(v);
            if (cmp && typeof actual === 'number') {
              if (!passesComparison(actual, cmp.op, cmp.val)) {
                return `${field} ${numFmt(actual)} fails ${v}`;
              }
            }
          }
        } else {
          // String allowlist — block if NOT in list
          if (!val.map(v => String(v).toUpperCase()).includes(String(actual).toUpperCase())) {
            return `${field} = ${actual}, not in [${val.join(', ')}]`;
          }
        }
        continue;
      }

      // String with comparison operator: "> 0.7", "<0.25"
      if (typeof val === 'string') {
        const cmp = parseComparison(val);
        if (cmp && typeof actual === 'number') {
          // This is a REQUIREMENT (must be > 0.7), so block if NOT met
          if (!passesComparison(actual, cmp.op, cmp.val)) {
            return `${field} ${numFmt(actual)} fails requirement ${val}`;
          }
        } else if (typeof actual === 'string') {
          // Direct string comparison — if it matches, it's either an allowlist or a block
          // Contextual: if the key suggests blocking (contains 'block'), match = block
          // Otherwise treat as allowlist requirement: block if NOT matching
          if (String(actual).toUpperCase() !== String(val).toUpperCase()) {
            return `${field} = ${actual}, required ${val}`;
          }
        }
      }

      // Simple numeric threshold
      if (typeof val === 'number' && typeof actual === 'number') {
        // Ambiguous — skip simple numbers as they're usually IDs or non-filter values
      }
    }

    // ─── SIMPLE THRESHOLD on filter.feature ───
    const mainField = resolveField(cond.feature || filter.feature);
    const mainVal = mainField ? snap[mainField] : undefined;
    if (mainVal !== undefined) {
      if (cond.min !== undefined && mainVal < cond.min) return `${mainField} ${numFmt(mainVal)} < ${cond.min}`;
      if (cond.max !== undefined && mainVal > cond.max) return `${mainField} ${numFmt(mainVal)} > ${cond.max}`;
      if (cond.equal !== undefined && String(mainVal) === String(cond.equal)) return `${mainField} = ${cond.equal}`;
    }

    return null; // Signal passes this filter
  }

  // Parse simple expressions like "atr_compression > 0" or "IF VolState = 'COMPRESSED' THEN BLOCK"
  function evaluateStringExpr(expr, snap) {
    const str = String(expr).toUpperCase();
    // Pattern: FIELD OP VALUE
    const patterns = [
      /(\w+)\s*([<>=!]+)\s*['"]?([^'")\s]+)['"]?/g,
      /IF\s+(\w+)\s*=\s*['"]?(\w+)['"]?\s+THEN\s+BLOCK/gi,
    ];

    // Simple field comparison
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

  // Regime snapshot from bars — includes classified volState string
  function computeQuickRegime(bars) {
    if (bars.length < 60) return {};
    const recent = bars.slice(-60);
    const closes = recent.map(b => b.close);
    const high60 = Math.max(...closes);
    const low60 = Math.min(...closes);
    const range60 = high60 - low60;
    const posInRange60 = range60 > 0 ? (closes[closes.length - 1] - low60) / range60 : 0.5;

    // Volatility: recent vs longer-term
    const recentVol = stddev(closes.slice(-20).map((c, i, a) => i > 0 ? (c - a[i-1]) / a[i-1] * 100 : 0).slice(1));
    const longerVol = stddev(closes.map((c, i, a) => i > 0 ? (c - a[i-1]) / a[i-1] * 100 : 0).slice(1));
    const volRatio = longerVol > 0 ? recentVol / longerVol : 1;

    // Classify volatility state as string (matches what the board expects)
    const volState = volRatio < 0.7 ? 'COMPRESSED' : volRatio > 1.3 ? 'EXPANDING' : 'NORMAL';

    // ATR-based compression (for filter #8 kill-test)
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

  // Map barMinutes to timeframe label for filter matching
  const tfLabel = config.barMinutes === 1 ? '1m' : config.barMinutes === 60 ? '1h' : config.barMinutes === 1440 ? '1d' : 'all';

  console.log(`[${config.label}] Starting loop (every ${config.interval / 1000}s)`);

  async function tick() {
    const client = await pool.connect();
    try {
      await ensureSignalTable(client);

      // Load active strategy from DB (or use defaults)
      const dbStrategy = await getActiveStrategy(client, config.barMinutes);
      const strategy = dbStrategy ? {
        minStr: dbStrategy.minStr, minCyc: dbStrategy.minCyc,
        spike: dbStrategy.spike, nearMiss: dbStrategy.nearMiss,
        holdDiv: dbStrategy.holdDiv, priceExt: dbStrategy.priceExt ?? config.priceExt,
        cycleMin: dbStrategy.cycleMin ?? config.cycleMin,
        cycleMax: dbStrategy.cycleMax ?? config.cycleMax,
        config: dbStrategy.config || {},
      } : {
        minStr: config.minStr, minCyc: config.minCyc,
        spike: config.spike, nearMiss: config.nearMiss,
        holdDiv: config.holdDiv, priceExt: config.priceExt,
        cycleMin: config.cycleMin, cycleMax: config.cycleMax,
        config: { hedging_enabled: true, max_gap: 1, hedge_mode: 'exclusive' },
      };

      const strategyId = dbStrategy?.id || null;
      const excluded = await getExcludedCoins(client);
      const coins = await getCoins(client);
      let activeCoins = coins.filter(c => !excluded.has(c));

      // ── FIX: Cap coin count for fast timeframes ──
      // 150 coins × 546 bands = 84s per tick, exceeding the 60s interval.
      // Cap to 50 for 1m (still covers all major + top altcoins).
      // 1H/1D have longer intervals (5min/15min) so they can handle more.
      const MAX_COINS = { 1: 50, 60: 150, 1440: 150 };
      const cap = MAX_COINS[config.barMinutes] || 100;
      if (activeCoins.length > cap) {
        console.log(`[${config.label}] Capping coins from ${activeCoins.length} to ${cap}`);
        activeCoins = activeCoins.slice(0, cap);
      }

      const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const tickStartMs = Date.now();
      const tickId = `${tfLabel}-${tickStartMs}`;
      let newSignals = 0, closedSignals = 0, pendingSignals = 0, pairedSignals = 0, expiredSignals = 0, errors = 0;

      // ── Expire stale pending signals ──
      if (strategy.config && strategy.config.hedging_enabled) {
        const maxGapDays = strategy.config.max_gap || 1;
        try {
          const { rowCount } = await client.query(
            `UPDATE "FracmapSignal" SET status = 'expired', "closedAt" = now()
             WHERE "strategyId" = $1 AND status = 'pending'
             AND "detectedAt" < NOW() - INTERVAL '${maxGapDays} days'`,
            [strategyId]
          );
          if (rowCount > 0) {
            console.log(`[${config.label}] Expired ${rowCount} pending signals (exceeded ${maxGapDays}d gap)`);
            expiredSignals = rowCount;
          }
        } catch (expErr) {
          console.error(`[${config.label}] Expiry sweep error: ${expErr.message}`);
        }
      }

      // Get open+pending signals to track for closing and duplicate prevention
      const openSignals = await getOpenSignals(client, strategyId);
      const openBySymbol = {};
      for (const s of openSignals) {
        if (!openBySymbol[s.symbol]) openBySymbol[s.symbol] = [];
        openBySymbol[s.symbol].push(s);
      }

      for (const symbol of activeCoins) {
        try {
          // Fetch recent candles (time-anchored to prevent stale data)
          const maxAge = config.barMinutes * barsNeeded * 60_000 * 1.5; // 1.5× safety margin
          const oldestAllowed = new Date(Date.now() - maxAge);
          const { rows } = await client.query(
            `SELECT timestamp as time, open, high, low, close 
             FROM "${config.table}" WHERE symbol = $1 AND timestamp >= $2
             ORDER BY timestamp DESC LIMIT $3`,
            [symbol, oldestAllowed, barsNeeded]
          );

          if (rows.length < Math.min(200, Math.floor(barsNeeded * 0.8))) continue; // not enough data

          // Reverse to chronological order (use slice() to avoid mutating pg driver's array)
          const bars = rows.slice().reverse().map(r => ({
            time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close,
          }));

          // Compute all bands
          const highs = bars.map(b => b.high);
          const lows = bars.map(b => b.low);
          const allBands = [];
          for (let order = 1; order <= 6; order++) {
            for (let cycle = strategy.cycleMin; cycle <= strategy.cycleMax; cycle++) {
              allBands.push(computeFracmap(highs, lows, cycle, order));
            }
          }

          // Close expired signals for this symbol
          const symbolOpen = openBySymbol[symbol] || [];
          for (const sig of symbolOpen) {
            if (sig.status === 'pending') continue; // pending signals have no entry yet
            const enteredAt = sig.enteredAt || sig.createdAt;
            const barsSinceEntry = Math.round(
              (Date.now() - new Date(enteredAt).getTime()) / (config.barMinutes * 60_000)
            );
            if (barsSinceEntry >= (sig.holdBars || 10)) {
              // ALIGNED WITH SCANNER: exit at current bar's OPEN (not close)
              // Scanner exits at bars[exitIdx].open — the open of the bar after hold expires
              const currentPrice = bars[bars.length - 1].open;
              const lastBarTime = bars[bars.length - 1].time;

              // ── SANITY CHECK ──────────────────────────────────────
              // Reject exit prices that are implausibly far from entry.
              // A >50% move in a single hold period is almost certainly
              // a phantom price from stale/corrupt candle data.
              const priceDrift = Math.abs(currentPrice - sig.entryPrice) / sig.entryPrice;
              if (priceDrift > 0.50) {
                console.error(`[ANOMALY] ${symbol} signal=${sig.id}: exit price ${currentPrice} (bar ${lastBarTime}) is ${(priceDrift*100).toFixed(1)}% from entry ${sig.entryPrice} — SKIPPING close, will retry next tick`);
                continue;
              }

              // ── ADDITIONAL CHECK ──────────────────────────────────
              // For SHORT: profitable means price went DOWN (exit < entry)
              // For LONG:  profitable means price went UP   (exit > entry)
              // Verify the last bar timestamp is recent (within N× the hold period)
              // 1D candles arrive infrequently — use 5× for daily, 2× for others
              const barAge = Date.now() - new Date(lastBarTime).getTime();
              const staleFactor = config.barMinutes >= 1440 ? 5 : 2;
              const maxBarAge = config.barMinutes * 60_000 * (sig.holdBars || 10) * staleFactor;
              if (barAge > maxBarAge) {
                console.error(`[ANOMALY] ${symbol} signal=${sig.id}: last bar is ${(barAge/60000).toFixed(0)}min old (time=${lastBarTime}) — stale data, SKIPPING close`);
                continue;
              }

              const ret = sig.direction === 'LONG'
                ? (currentPrice / sig.entryPrice - 1) * 100
                : (sig.entryPrice / currentPrice - 1) * 100;

              // ── LOGGING ───────────────────────────────────────────
              console.log(`[CLOSE] ${symbol} id=${sig.id} dir=${sig.direction} entry=${sig.entryPrice} exit=${currentPrice} ret=${ret.toFixed(4)}% barTime=${lastBarTime} barsArray=${bars.length}`);

              await client.query(
                `UPDATE "FracmapSignal" SET "exitPrice" = $1, "returnPct" = $2,
                 status = 'closed', "closedAt" = now() WHERE id = $3 AND status = 'open'`,
                [currentPrice, +ret.toFixed(4), sig.id]
              );
              closedSignals++;

              // ── Hedge pair close: if this signal has a pair, close the partner too ──
              if (sig.pair_id) {
                try {
                  const { rows: [partner] } = await client.query(
                    `SELECT id, symbol, direction, "entryPrice", status, "returnPct"
                     FROM "FracmapSignal" WHERE pair_id = $1 AND id != $2 LIMIT 1`,
                    [sig.pair_id, sig.id]
                  );
                  if (partner && partner.status === 'open') {
                    // Close partner at its current price too
                    const { rows: partnerBars } = await client.query(
                      `SELECT open FROM "${config.table}" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
                      [partner.symbol]
                    );
                    if (partnerBars.length > 0) {
                      const partnerExit = +partnerBars[0].open;
                      const partnerRet = partner.direction === 'LONG'
                        ? (partnerExit / partner.entryPrice - 1) * 100
                        : (partner.entryPrice / partnerExit - 1) * 100;
                      await client.query(
                        `UPDATE "FracmapSignal" SET "exitPrice" = $1, "returnPct" = $2,
                         status = 'closed', "closedAt" = now() WHERE id = $3 AND status = 'open'`,
                        [partnerExit, +partnerRet.toFixed(4), partner.id]
                      );
                      // Compute pair_return and write to both legs
                      const pairReturn = +(ret + partnerRet).toFixed(4);
                      await client.query(
                        `UPDATE "FracmapSignal" SET pair_return = $1 WHERE pair_id = $2`,
                        [pairReturn, sig.pair_id]
                      );
                      console.log(`  [HEDGE-CLOSE] pair=${sig.pair_id.slice(0,8)}... ${symbol}(${ret.toFixed(2)}%) + ${partner.symbol}(${partnerRet.toFixed(2)}%) = ${pairReturn.toFixed(2)}%`);
                      closedSignals++;
                    }
                  } else if (partner && partner.status === 'closed' && partner.returnPct != null) {
                    // Partner already closed — just compute pair_return
                    const pairReturn = +(ret + partner.returnPct).toFixed(4);
                    await client.query(
                      `UPDATE "FracmapSignal" SET pair_return = $1 WHERE pair_id = $2`,
                      [pairReturn, sig.pair_id]
                    );
                  }
                } catch (pairErr) {
                  console.error(`  [HEDGE-CLOSE] Error: ${pairErr.message}`);
                }
              }
            }
          }

          // Check if we already have an open or pending signal for this symbol on this strategy
          const hasOpen = symbolOpen.some(s => {
            if (s.status === 'pending') return true; // pending counts as occupied
            const enteredAt = s.enteredAt || s.createdAt;
            const barsSince = Math.round(
              (Date.now() - new Date(enteredAt).getTime()) / (config.barMinutes * 60_000)
            );
            return barsSince < (s.holdBars || 10);
          });

          if (hasOpen) continue; // Don't stack signals

          // Detect signal on the last completed bar
          const lastBar = bars.length - 2; // -2 because last bar may be incomplete
          if (lastBar < 100) continue;

          const signal = detectSignalAtBar(bars, allBands, lastBar, strategy);

          if (signal) {
            // ── Check board filters before writing ──
            const filters = await loadActiveFilters(client);
            const regimeSnap = computeQuickRegime(bars);
            const filterResult = checkFilters(signal, regimeSnap, filters, tfLabel);

            // Also check per-strategy filter matrix
            let matrixResult = { pass: true, blockedBy: null, reason: null };
            if (filterResult.pass) {
              matrixResult = await checkMatrix(client, strategyId, signal.direction, regimeSnap);
            }

            // Tier 2: Per-coin rolling quality gate
            let coinResult = { pass: true, reason: null };
            if (filterResult.pass && matrixResult.pass) {
              coinResult = await checkCoinQuality(client, symbol, strategyId);
            }

            if (!filterResult.pass || !matrixResult.pass || !coinResult.pass) {
              // Signal blocked — write as filtered for tracking
              const filteredById = !filterResult.pass ? filterResult.filterId : null;
              await client.query(
                `INSERT INTO "FracmapSignal" 
                 ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", status, filtered_by, regime_snapshot)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'filtered', $9, $10)`,
                [strategyId, symbol, signal.direction, signal.entryPrice,
                 signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder,
                 filteredById, JSON.stringify(regimeSnap)]
              );
              if (filteredById) {
                try {
                  await client.query(`UPDATE board_filters SET trades_filtered = COALESCE(trades_filtered, 0) + 1 WHERE id = $1`, [filteredById]);
                } catch {}
              }
              if (!matrixResult.pass) {
                console.log(`  [MATRIX] ${symbol} ${signal.direction} blocked: ${matrixResult.reason}`);
              }
              if (!coinResult.pass) {
                console.log(`  [COIN-GATE] ${symbol} ${signal.direction} blocked: ${coinResult.reason}`);
              }
              continue; // Don't count as a new signal
            }

            // ── Queue-and-Pair: insert as pending, then try to find a partner ──
            if (strategy.config && strategy.config.hedging_enabled) {
              // Insert as PENDING — no capital deployed yet
              const { rows: [newSig] } = await client.query(
                `INSERT INTO "FracmapSignal"
                 ("strategyId", symbol, direction, "entryPrice", "detectedPrice", strength, "holdBars",
                  "maxCycle", "maxOrder", regime_snapshot, status, "detectedAt", tick_id)
                 VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, 'pending', now(), $10) RETURNING id, "detectedAt"`,
                [strategyId, symbol, signal.direction, signal.entryPrice,
                 signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder,
                 JSON.stringify(regimeSnap), tickId]
              );
              pendingSignals++;

              // Search for an existing PENDING signal with opposite direction to pair with
              const maxGapDays = strategy.config.max_gap || 1;
              try {
                const oppositeDir = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
                const { rows: candidates } = await client.query(
                  `SELECT id, symbol, direction, "detectedPrice", "holdBars", strength, "detectedAt", tick_id
                   FROM "FracmapSignal"
                   WHERE "strategyId" = $1 AND status = 'pending' AND direction = $2
                   AND symbol != $3 AND id != $4
                   AND "detectedAt" >= NOW() - INTERVAL '${maxGapDays} days'
                   ORDER BY strength DESC, "detectedAt" DESC LIMIT 1`,
                  [strategyId, oppositeDir, symbol, newSig.id]
                );

                if (candidates.length > 0) {
                  const match = candidates[0];
                  const pairId = require('crypto').randomUUID();
                  const pairType = (match.tick_id === tickId) ? 'natural' : 'forced';

                  // Get current market prices for BOTH legs at this moment
                  const { rows: [priceA] } = await client.query(
                    `SELECT close FROM "${config.table}" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
                    [symbol]
                  );
                  const { rows: [priceB] } = await client.query(
                    `SELECT close FROM "${config.table}" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
                    [match.symbol]
                  );
                  const entryPriceA = priceA ? +priceA.close : signal.entryPrice;
                  const entryPriceB = priceB ? +priceB.close : +match.detectedPrice;

                  // Activate BOTH: pending → open, set entryPrice at current market, enteredAt = now
                  await client.query(
                    `UPDATE "FracmapSignal"
                     SET status = 'open', "entryPrice" = $1, "enteredAt" = now(),
                         pair_id = $2, pair_symbol = $3, pair_direction = $4, pair_type = $5
                     WHERE id = $6`,
                    [entryPriceA, pairId, match.symbol, match.direction, pairType, newSig.id]
                  );
                  await client.query(
                    `UPDATE "FracmapSignal"
                     SET status = 'open', "entryPrice" = $1, "enteredAt" = now(),
                         pair_id = $2, pair_symbol = $3, pair_direction = $4, pair_type = $5
                     WHERE id = $6`,
                    [entryPriceB, pairId, symbol, signal.direction, pairType, match.id]
                  );

                  console.log(`  [HEDGE-PAIR] ${pairType.toUpperCase()}: ${symbol} ${signal.direction} @${entryPriceA} + ${match.symbol} ${oppositeDir} @${entryPriceB} (pair_id=${pairId.slice(0,8)}...)`);
                  pairedSignals++;
                  pendingSignals--; // this one is no longer pending

                  // Tweet the pair entry (not individual signal)
                  tweetSignal({
                    symbol, direction: signal.direction,
                    entryPrice: entryPriceA, strength: signal.strength,
                    timeframe: tfLabel, signalId: newSig?.id, regime: regimeSnap
                  }).catch(() => {});
                }
                // If no match: signal stays as 'pending' — no tweet, no entry
              } catch (hedgeErr) {
                console.error(`  [HEDGE-PAIR] Error: ${hedgeErr.message}`);
              }
            } else {
              // Non-hedged strategy: insert directly as open (legacy behavior)
              const { rows: [newSig] } = await client.query(
                `INSERT INTO "FracmapSignal"
                 ("strategyId", symbol, direction, "entryPrice", "detectedPrice", strength, "holdBars",
                  "maxCycle", "maxOrder", regime_snapshot, "detectedAt", "enteredAt")
                 VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, now(), now()) RETURNING id`,
                [strategyId, symbol, signal.direction, signal.entryPrice,
                 signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder,
                 JSON.stringify(regimeSnap)]
              );
              tweetSignal({
                symbol, direction: signal.direction,
                entryPrice: signal.entryPrice, strength: signal.strength,
                timeframe: tfLabel, signalId: newSig?.id, regime: regimeSnap
              }).catch(() => {});
            }

            // Increment trades_passed on all active filters (signal wasn't blocked)
            if (filters.length > 0) {
              try {
                const filterIds = filters.map(f => f.id);
                await client.query(`UPDATE board_filters SET trades_passed = COALESCE(trades_passed, 0) + 1 WHERE id = ANY($1)`, [filterIds]);
              } catch {}
            }
            newSignals++;
          }

        } catch (err) {
          errors++;
          if (errors <= 3) console.error(`  [${config.label}] ${symbol}: ${err.message}`);
        }
      }

      // Refresh coin quality data after closes
      if (closedSignals > 0) invalidateCoinCache();

      if (newSignals > 0 || closedSignals > 0 || pairedSignals > 0 || pendingSignals > 0 || expiredSignals > 0) {
        const parts = [`[${config.label}] ${now} · ${activeCoins.length} coins`];
        if (newSignals > 0) parts.push(`+${newSignals} new`);
        if (pendingSignals > 0) parts.push(`${pendingSignals} queued`);
        if (pairedSignals > 0) parts.push(`${pairedSignals} paired`);
        if (closedSignals > 0) parts.push(`-${closedSignals} closed`);
        if (expiredSignals > 0) parts.push(`${expiredSignals} expired`);
        if (errors > 0) parts.push(`${errors} errors`);
        console.log(parts.join(' · '));
      }

    } catch (err) {
      console.error(`[${config.label}] Tick error: ${err.message}`);
    } finally {
      client.release();
    }
  }

  // Run immediately, then wait for completion before scheduling next
  // For 1H and 1D: align to bar boundaries so we poll right after a new bar opens.
  // This ensures bars[length-2] is truly complete and bars[length-1].open is available.
  // For 1M: keep polling at fixed intervals (bars close every 60s anyway).

  function msUntilNextBar(barMinutes) {
    const now = Date.now();
    const barMs = barMinutes * 60_000;
    const elapsed = now % barMs;
    const remaining = barMs - elapsed;
    return remaining;
  }

  async function loop() {
    // First tick: run immediately
    await tick();

    if (config.barMinutes >= 60) {
      // ── BAR-ALIGNED MODE (1H, 1D) ──
      // Wait until the next bar opens + a small delay for data to land in DB
      const DATA_SETTLE_DELAY = 15_000; // 15s after bar open for fetch to complete
      console.log(`[${config.label}] Switching to bar-aligned mode (poll at XX:00:${DATA_SETTLE_DELAY/1000}s)`);

      while (true) {
        const waitMs = msUntilNextBar(config.barMinutes) + DATA_SETTLE_DELAY;
        console.log(`[${config.label}] Next tick in ${(waitMs/1000).toFixed(0)}s (bar-aligned)`);
        await new Promise(r => setTimeout(r, waitMs));
        const tickStart = Date.now();
        await tick();
        const elapsed = Date.now() - tickStart;
        if (elapsed > config.barMinutes * 60_000 * 0.5) {
          console.warn(`[${config.label}] ⚠ Tick took ${(elapsed/1000).toFixed(1)}s — dangerously slow`);
        }
      }
    } else {
      // ── POLLING MODE (1M) ──
      while (true) {
        const tickStart = Date.now();
        await tick();
        const elapsed = Date.now() - tickStart;
        if (elapsed > config.interval) {
          console.warn(`[${config.label}] ⚠ Tick took ${(elapsed/1000).toFixed(1)}s (interval is ${config.interval/1000}s) — consider reducing coin count or increasing interval`);
        }
        const wait = Math.max(1000, config.interval - elapsed);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  loop();
}

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════

async function start() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  NTLGNC LIVE SIGNAL ENGINE                                  ║`);
  console.log(`║  3 timeframes · autonomous · recursive                      ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // Ensure tables
  const client = await pool.connect();
  try {
    await ensureSignalTable(client);
    // Ensure strategy table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS "FracmapStrategy" (
        id SERIAL PRIMARY KEY,
        name TEXT, type TEXT DEFAULT 'universal', "barMinutes" INTEGER DEFAULT 1,
        symbol TEXT, "minStr" INTEGER, "minCyc" INTEGER, spike BOOLEAN DEFAULT true,
        "nearMiss" BOOLEAN DEFAULT true, "holdDiv" INTEGER DEFAULT 2, "priceExt" BOOLEAN DEFAULT false,
        "isSharpe" FLOAT, "oosSharpe" FLOAT, "bootP" FLOAT,
        "winRate" FLOAT, "profitFactor" FLOAT, consistency TEXT, "totalTrades" INTEGER,
        "splitPct" INTEGER, "cycleMin" INTEGER DEFAULT 5, "cycleMax" INTEGER DEFAULT 20,
        active BOOLEAN DEFAULT false, "createdAt" TIMESTAMPTZ DEFAULT now(), "updatedAt" TIMESTAMPTZ DEFAULT now()
      )
    `);
    console.log(`[engine] Database tables ready`);

    // Ensure coin strategy tables
    try { await ensureCoinStrategyTables(client); console.log(`[engine] Coin strategy tables ready`); } catch (e) { console.warn(`[engine] Coin strategy tables: ${e.message}`); }

    // Check for active strategies
    for (const [key, cfg] of Object.entries(DEFAULT_STRATEGIES)) {
      const { rows } = await client.query(
        `SELECT id, name, "minStr", "minCyc", spike, "nearMiss", "holdDiv", "cycleMin", "cycleMax", config
         FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = $1 LIMIT 1`,
        [cfg.barMinutes]
      );
      if (rows[0]) {
        console.log(`  ${cfg.label}: using saved strategy "${rows[0].name}" (×${rows[0].minStr} C≥${rows[0].minCyc} ÷${rows[0].holdDiv})`);
      } else {
        console.log(`  ${cfg.label}: using defaults (×${cfg.minStr} C≥${cfg.minCyc} ÷${cfg.holdDiv}) — save a strategy from scanner to override`);
      }
    }
  } finally {
    client.release();
  }

  console.log(`\n[engine] Starting signal loops...\n`);

  // Launch all three universal timeframe loops
  const universalLoops = Promise.all([
    runTimeframeLoop('1m'),
    runTimeframeLoop('1h'),
    runTimeframeLoop('1d'),
  ]);

  // ── COIN-SPECIFIC STRATEGY LOOPS ──
  // These run as PARALLEL instances alongside the universal ones.
  // They trade ONLY one coin each, generating ADDITIONAL signals.
  // New strategies are picked up every 60 seconds via cache refresh.
  const activeCoinLoops = new Map(); // name → { interval, strategyId }

  async function syncCoinStrategyLoops() {
    const client = await pool.connect();
    try {
      const strategies = await getActiveCoinStrategies(client);
      const activeNames = new Set(strategies.map(s => s.name));

      // Stop loops for deactivated strategies
      for (const [name, state] of activeCoinLoops) {
        if (!activeNames.has(name)) {
          console.log(`[engine] ⏹ Stopping coin strategy loop: ${name}`);
          clearInterval(state.interval);
          activeCoinLoops.delete(name);
        }
      }

      // Start loops for new strategies
      for (const strat of strategies) {
        if (activeCoinLoops.has(strat.name)) continue; // already running

        console.log(`[engine] ▶ Starting coin strategy loop: ${strat.name} (${strat.symbol} ${strat.barMinutes}m)`);
        
        // Create a tick function for this coin strategy
        const coinTick = async () => {
          const cl = await pool.connect();
          try {
            const barsNeeded = strat.cycleMax * 8;
            const tfLabel = strat.barMinutes === 1 ? '1m' : strat.barMinutes === 60 ? '1h' : '1d';

            const symbol = strat.symbol;
            const strategy = {
              minStr: strat.minStr, minCyc: strat.minCyc,
              spike: strat.spike, nearMiss: strat.nearMiss,
              holdDiv: strat.holdDiv, priceExt: strat.priceExt ?? false,
              cycleMin: strat.cycleMin, cycleMax: strat.cycleMax,
            };

            // Close expired signals for this strategy
            const { rows: openSigs } = await cl.query(
              `SELECT * FROM "FracmapSignal" WHERE "strategyId" = $1 AND status = 'open'`,
              [strat.id]
            );

            // Fetch candles
            const maxAge = strat.barMinutes * barsNeeded * 60_000 * 1.5;
            const oldestAllowed = new Date(Date.now() - maxAge);
            const { rows } = await cl.query(
              `SELECT timestamp as time, open, high, low, close 
               FROM "${strat.table}" WHERE symbol = $1 AND timestamp >= $2
               ORDER BY timestamp DESC LIMIT $3`,
              [symbol, oldestAllowed, barsNeeded]
            );

            if (rows.length < Math.min(200, Math.floor(barsNeeded * 0.8))) return;

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

            // Close expired
            for (const sig of openSigs) {
              const barsSinceEntry = Math.round(
                (Date.now() - new Date(sig.createdAt).getTime()) / (strat.barMinutes * 60_000)
              );
              if (barsSinceEntry >= (sig.holdBars || 10)) {
                const currentPrice = bars[bars.length - 1].open;
                const priceDrift = Math.abs(currentPrice - sig.entryPrice) / sig.entryPrice;
                if (priceDrift > 0.50) continue; // Skip anomalous exits
                const ret = sig.direction === 'LONG'
                  ? (currentPrice / sig.entryPrice - 1) * 100
                  : (sig.entryPrice / currentPrice - 1) * 100;
                console.log(`[CLOSE] [${strat.name}] ${symbol} dir=${sig.direction} ret=${ret.toFixed(4)}%`);
                await cl.query(
                  `UPDATE "FracmapSignal" SET "exitPrice" = $1, "returnPct" = $2, 
                   status = 'closed', "closedAt" = now() WHERE id = $3 AND status = 'open'`,
                  [currentPrice, +ret.toFixed(4), sig.id]
                );
              }
            }

            // Check for open signal (don't stack)
            const hasOpen = openSigs.some(s => {
              const barsSince = Math.round(
                (Date.now() - new Date(s.createdAt).getTime()) / (strat.barMinutes * 60_000)
              );
              return barsSince < (s.holdBars || 10);
            });
            if (hasOpen) return;

            // Detect signal
            const lastBar = bars.length - 2;
            if (lastBar < 100) return;
            const signal = detectSignalAtBar(bars, allBands, lastBar, strategy);
            if (!signal) return;

            // Coin-specific strategies still go through universal board filters
            const { rows: filterRows } = await cl.query(
              `SELECT id, feature, conditions, COALESCE(timeframe, 'all') as timeframe
               FROM board_filters WHERE active = true ORDER BY created_at`
            );

            // Quick regime for filter check
            const recent60 = bars.slice(-60);
            const closes60 = recent60.map(b => b.close);
            const high60 = Math.max(...closes60);
            const low60 = Math.min(...closes60);
            const range60 = high60 - low60;
            const posInRange60 = range60 > 0 ? (closes60[closes60.length - 1] - low60) / range60 : 0.5;
            const ret20 = closes60.slice(-20).map((c, i, a) => i > 0 ? (c - a[i-1]) / a[i-1] * 100 : 0).slice(1);
            const ret60 = closes60.map((c, i, a) => i > 0 ? (c - a[i-1]) / a[i-1] * 100 : 0).slice(1);
            const vol20 = stdArr(ret20);
            const vol60 = stdArr(ret60);
            const volRatio = vol60 > 0 ? vol20 / vol60 : 1;
            const volState = volRatio < 0.7 ? 'COMPRESSED' : volRatio > 1.3 ? 'EXPANDING' : 'NORMAL';
            const regimeSnap = { posInRange60, volRatio, volState };

            // Write signal (coin strategies bypass matrix and coin quality gate — they ARE the specialization)
            console.log(`  ✨ [${strat.name}] ${symbol} ${signal.direction} str=${signal.strength} cyc=${signal.maxCycle} hold=${signal.holdBars}`);
            await cl.query(
              `INSERT INTO "FracmapSignal" 
               ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", regime_snapshot)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [strat.id, symbol, signal.direction, signal.entryPrice,
               signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder,
               JSON.stringify(regimeSnap)]
            );

            // ── Tweet notification (fire-and-forget) ──
            tweetSignal({
              symbol, direction: signal.direction,
              entryPrice: signal.entryPrice, strength: signal.strength,
              timeframe: tfLabel, signalId: null, regime: regimeSnap
            }).catch(() => {});
          } catch (err) {
            // Don't crash the loop on individual tick errors
            if (!err.message?.includes('does not exist')) {
              console.error(`[${strat.name}] Tick error: ${err.message}`);
            }
          } finally {
            cl.release();
          }
        };

        // Run first tick immediately, then on interval
        coinTick().catch(err => console.error(`[${strat.name}] First tick error: ${err.message}`));
        const interval = setInterval(() => {
          coinTick().catch(err => console.error(`[${strat.name}] Tick error: ${err.message}`));
        }, strat.interval);

        activeCoinLoops.set(strat.name, { interval, strategyId: strat.id });
      }
    } catch (err) {
      console.warn(`[engine] Error syncing coin strategy loops: ${err.message}`);
    } finally {
      client.release();
    }
  }

  // Sync coin strategy loops every 60 seconds
  await syncCoinStrategyLoops();
  setInterval(syncCoinStrategyLoops, 60_000);

  // Helper for coin loop regime calc
  function stdArr(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, v) => a + (v - mean) ** 2, 0) / arr.length);
  }

  await universalLoops;
}

start().catch(err => {
  console.error('[engine] Fatal error:', err);
  process.exit(1);
});
