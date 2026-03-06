/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — MARK-TO-MARKET CRON                                   ║
 * ║                                                                  ║
 * ║  READ-ONLY against trade execution. Writes ONLY to signal_mtm.  ║
 * ║  Does NOT touch FracmapSignal, board_filters, or live-signals.  ║
 * ║                                                                  ║
 * ║  Snapshots unrealised P&L for all open positions at intervals:  ║
 * ║    1M signals  → every 15 minutes                               ║
 * ║    1H signals  → every 60 minutes                               ║
 * ║    1D signals  → every 60 minutes                               ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    node backend/mtm-cron.cjs                                    ║
 * ║    pm2 start backend/mtm-cron.cjs --name mtm-cron               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// Intervals per barMinutes
const INTERVALS = {
  1:    15 * 60_000,   // 1M signals → every 15 min
  60:   60 * 60_000,   // 1H signals → every 60 min
  1440: 60 * 60_000,   // 1D signals → every 60 min
};

// Track last run per timeframe to avoid overlap
const lastRun = {};

async function ensureTable() {
  const client = await pool.connect();
  try {
    // Drop old table if signal_id was wrong type (INTEGER instead of TEXT)
    const { rows } = await client.query(`
      SELECT data_type FROM information_schema.columns 
      WHERE table_name = 'signal_mtm' AND column_name = 'signal_id'
    `);
    if (rows.length > 0 && rows[0].data_type === 'integer') {
      console.log('  Dropping old signal_mtm table (signal_id was INTEGER, needs TEXT)...');
      await client.query('DROP TABLE signal_mtm');
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS signal_mtm (
        id SERIAL PRIMARY KEY,
        signal_id TEXT NOT NULL,
        strategy_id TEXT,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price NUMERIC NOT NULL,
        mark_price NUMERIC NOT NULL,
        unrealised_pct NUMERIC NOT NULL,
        bar_minutes INTEGER NOT NULL,
        snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(signal_id, snapshot_at)
      )
    `);
    // Index for fast equity curve queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_mtm_snapshot ON signal_mtm (snapshot_at, bar_minutes)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_mtm_signal ON signal_mtm (signal_id, snapshot_at)
    `);
    console.log('✓ signal_mtm table ready');
  } finally {
    client.release();
  }
}

/**
 * Get latest price for a symbol from candle tables
 * Tries the most granular table first (1m → 1h → 1d)
 */
async function getLatestPrice(client, symbol) {
  for (const table of ['Candle1m', 'Candle1h', 'Candle1d']) {
    try {
      const { rows } = await client.query(
        `SELECT close FROM "${table}" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
        [symbol]
      );
      if (rows.length > 0) return parseFloat(rows[0].close);
    } catch {}
  }
  return null;
}

/**
 * Snapshot all open signals for a given barMinutes
 */
async function snapshotTimeframe(barMinutes) {
  const client = await pool.connect();
  const tfLabel = barMinutes === 1 ? '1M' : barMinutes === 60 ? '1H' : '1D';

  try {
    // Get all open signals for this timeframe
    const { rows: openSignals } = await client.query(`
      SELECT s.id, s.symbol, s.direction, s."entryPrice", s."strategyId"
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'open' AND st."barMinutes" = $1
    `, [barMinutes]);

    if (openSignals.length === 0) {
      console.log(`  [${tfLabel}] No open signals`);
      return { snapped: 0 };
    }

    // Get unique symbols and batch-fetch prices
    const symbols = [...new Set(openSignals.map(s => s.symbol))];
    const priceMap = {};
    for (const sym of symbols) {
      priceMap[sym] = await getLatestPrice(client, sym);
    }

    const priced = Object.values(priceMap).filter(v => v !== null).length;
    console.log(`  [${tfLabel}] Prices: ${priced}/${symbols.length} found`);

    const now = new Date();
    let snapped = 0;
    let skipped = { noPrice: 0, noEntry: 0, sanity: 0 };

    for (const sig of openSignals) {
      const markPrice = priceMap[sig.symbol];
      if (!markPrice) { skipped.noPrice++; continue; }

      const entryPrice = parseFloat(sig.entryPrice);
      if (!entryPrice || entryPrice <= 0) { skipped.noEntry++; continue; }

      const unrealisedPct = sig.direction === 'LONG'
        ? (markPrice / entryPrice - 1) * 100
        : (entryPrice / markPrice - 1) * 100;

      // Sanity check — skip extreme outliers
      if (Math.abs(unrealisedPct) > 200) { skipped.sanity++; continue; }

      try {
        await client.query(`
          INSERT INTO signal_mtm (signal_id, strategy_id, symbol, direction, entry_price, mark_price, unrealised_pct, bar_minutes, snapshot_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (signal_id, snapshot_at) DO UPDATE SET
            mark_price = EXCLUDED.mark_price,
            unrealised_pct = EXCLUDED.unrealised_pct
        `, [sig.id, sig.strategyId, sig.symbol, sig.direction, entryPrice, markPrice,
            Math.round(unrealisedPct * 10000) / 10000, barMinutes, now]);
        snapped++;
      } catch (err) {
        if (snapped === 0) console.log(`    INSERT error: ${err.message}`);
      }
    }

    console.log(`  [${tfLabel}] ${snapped}/${openSignals.length} positions marked (${symbols.length} symbols)${skipped.noPrice ? ` | noPrice:${skipped.noPrice}` : ''}${skipped.noEntry ? ` | noEntry:${skipped.noEntry}` : ''}${skipped.sanity ? ` | sanity:${skipped.sanity}` : ''}`);
    return { snapped };
  } finally {
    client.release();
  }
}

/**
 * Cleanup old MTM data (keep last 30 days)
 */
async function cleanup() {
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `DELETE FROM signal_mtm WHERE snapshot_at < NOW() - INTERVAL '30 days'`
    );
    if (rowCount > 0) console.log(`  [CLEANUP] Removed ${rowCount} old MTM rows`);
  } finally {
    client.release();
  }
}

// ── Main Loop ──
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  NTLGNC — Mark-to-Market Cron         ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log('');

  await ensureTable();

  // Immediate first run
  console.log(`[${new Date().toISOString().slice(11, 19)}] Initial snapshot...`);
  for (const bm of [1, 60, 1440]) {
    await snapshotTimeframe(bm);
    lastRun[bm] = Date.now();
  }

  // Check loop every minute — fire snapshots when interval has elapsed
  setInterval(async () => {
    const now = Date.now();
    for (const [bm, interval] of Object.entries(INTERVALS)) {
      const barMin = parseInt(bm);
      const elapsed = now - (lastRun[barMin] || 0);
      if (elapsed >= interval) {
        const tfLabel = barMin === 1 ? '1M' : barMin === 60 ? '1H' : '1D';
        console.log(`[${new Date().toISOString().slice(11, 19)}] Snapshotting ${tfLabel}...`);
        try {
          await snapshotTimeframe(barMin);
        } catch (err) {
          console.error(`  [${tfLabel}] Error:`, err.message);
        }
        lastRun[barMin] = now;
      }
    }
  }, 60_000);

  // Cleanup once per hour
  setInterval(cleanup, 3600_000);

  console.log('\n✓ MTM cron running. Intervals: 1M=15min, 1H=60min, 1D=60min');
  console.log('  Press Ctrl+C to stop.\n');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
