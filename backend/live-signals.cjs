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

const DB_URL = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: DB_URL, max: 10 });

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
    // ALIGNED WITH SCANNER: entry at NEXT bar's open (not signal bar's close)
    // The caller detects at bars[length-2], so bars[i+1] always exists
    return {
      direction: 'LONG', strength: buyStrength,
      maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, holdBars,
      entryPrice: (i + 1 < bars.length) ? bars[i + 1].open : bars[i].close,
    };
  }

  if (sellStrength >= minStr && maxSellCycle >= minCyc) {
    if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) return null;
    const holdBars = Math.round(maxSellCycle / holdDiv);
    // ALIGNED WITH SCANNER: entry at NEXT bar's open (not signal bar's close)
    return {
      direction: 'SHORT', strength: sellStrength,
      maxCycle: maxSellCycle, maxOrder: maxSellOrder, holdBars,
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
    const { rows } = await client.query(
      `SELECT * FROM "FracmapSignal" WHERE "strategyId" = $1 AND status = 'open'`,
      [strategyId]
    );
    return rows;
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
      "closedAt" TIMESTAMPTZ
    )
  `);
  try {
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_status ON "FracmapSignal"(status, "strategyId")`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_created ON "FracmapSignal"("createdAt" DESC)`);
  } catch {}
}

async function runTimeframeLoop(tfKey) {
  const config = DEFAULT_STRATEGIES[tfKey];
  const barsNeeded = config.cycleMax * 8; // enough history for band computation

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
      } : {
        minStr: config.minStr, minCyc: config.minCyc,
        spike: config.spike, nearMiss: config.nearMiss,
        holdDiv: config.holdDiv, priceExt: config.priceExt,
        cycleMin: config.cycleMin, cycleMax: config.cycleMax,
      };

      const strategyId = dbStrategy?.id || null;
      const excluded = await getExcludedCoins(client);
      const coins = await getCoins(client);
      const activeCoins = coins.filter(c => !excluded.has(c));

      const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
      let newSignals = 0, closedSignals = 0, errors = 0;

      // Get open signals to track for closing
      const openSignals = strategyId ? await getOpenSignals(client, strategyId) : [];
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

          if (rows.length < 200) continue; // not enough data

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
            const barsSinceEntry = Math.round(
              (Date.now() - new Date(sig.createdAt).getTime()) / (config.barMinutes * 60_000)
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
              // Verify the last bar timestamp is recent (within 2× the hold period)
              const barAge = Date.now() - new Date(lastBarTime).getTime();
              const maxBarAge = config.barMinutes * 60_000 * (sig.holdBars || 10) * 2;
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
            }
          }

          // Check if we already have an open signal for this symbol on this strategy
          const hasOpen = symbolOpen.some(s => {
            const barsSince = Math.round(
              (Date.now() - new Date(s.createdAt).getTime()) / (config.barMinutes * 60_000)
            );
            return barsSince < (s.holdBars || 10);
          });

          if (hasOpen) continue; // Don't stack signals

          // Detect signal on the last completed bar
          const lastBar = bars.length - 2; // -2 because last bar may be incomplete
          if (lastBar < 100) continue;

          const signal = detectSignalAtBar(bars, allBands, lastBar, strategy);

          if (signal) {
            // Write to DB
            await client.query(
              `INSERT INTO "FracmapSignal" 
               ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [strategyId, symbol, signal.direction, signal.entryPrice,
               signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder]
            );
            newSignals++;
          }

        } catch (err) {
          errors++;
          if (errors <= 3) console.error(`  [${config.label}] ${symbol}: ${err.message}`);
        }
      }

      if (newSignals > 0 || closedSignals > 0) {
        console.log(`[${config.label}] ${now} · ${activeCoins.length} coins · +${newSignals} new · -${closedSignals} closed${errors > 0 ? ` · ${errors} errors` : ''}`);
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

    // Check for active strategies
    for (const [key, cfg] of Object.entries(DEFAULT_STRATEGIES)) {
      const { rows } = await client.query(
        `SELECT id, name, "minStr", "minCyc", spike, "nearMiss", "holdDiv", "cycleMin", "cycleMax"
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

  // Launch all three timeframe loops
  await Promise.all([
    runTimeframeLoop('1m'),
    runTimeframeLoop('1h'),
    runTimeframeLoop('1d'),
  ]);
}

start().catch(err => {
  console.error('[engine] Fatal error:', err);
  process.exit(1);
});
