/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  COIN-LEVEL FILTER — TIER 3: Static Exclusion List              ║
 * ║                                                                  ║
 * ║  Identifies structural outliers that should never be traded:    ║
 * ║    - Stablecoins (USDT, USDC, DAI, TUSD, etc.)                ║
 * ║    - Coins with < 3 days of candle history                      ║
 * ║    - Coins with known manipulation patterns (large gaps)        ║
 * ║    - Coins with extremely low volume / wide spreads             ║
 * ║                                                                  ║
 * ║  Outputs a JSON exclusion list and optionally writes to         ║
 * ║  board_coin_overrides table.                                    ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    node backend/coin-filter-tier3-static.cjs                    ║
 * ║    node backend/coin-filter-tier3-static.cjs --apply            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const APPLY_MODE = process.argv.includes('--apply');

// ── Known stablecoins (peg-tracking assets don't have meaningful signals) ──
const STABLECOIN_PATTERNS = [
  /^USD[TCSD]/i,   // USDTUSDT, USDCUSDT, etc.
  /^DAI/i,
  /^TUSD/i,
  /^BUSD/i,
  /^FDUSD/i,
  /^PYUSD/i,
  /^USDD/i,
  /^GUSD/i,
  /^PAX(?!G)/i,    // PAXUSDT but not PAXGUSDT (gold)
  /^EURUSDT/i,
  /^GBPUSDT/i,
  /^USD1USDT/i,
];

function isStablecoin(symbol) {
  return STABLECOIN_PATTERNS.some(pat => pat.test(symbol));
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  TIER 3: Static Exclusion List — Structural Outliers     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const exclusions = [];

  // ── Check 1: Stablecoins ──
  console.log('═══ CHECK 1: Stablecoins ═══\n');
  const { rows: allCoins } = await client.query(
    `SELECT DISTINCT symbol FROM "Candle1m" UNION SELECT DISTINCT symbol FROM "Candle1h"`
  );
  const stablecoins = allCoins.filter(c => isStablecoin(c.symbol));
  for (const c of stablecoins) {
    exclusions.push({ symbol: c.symbol, reason: 'stablecoin', detail: 'Peg-tracking asset — signals are noise' });
    console.log(`  🚫 ${c.symbol} — stablecoin`);
  }
  if (stablecoins.length === 0) console.log('  None found in active coin set');

  // ── Check 2: Insufficient history ──
  console.log('\n═══ CHECK 2: Insufficient History (<3 days of 1m candles) ═══\n');
  const { rows: candleCounts } = await client.query(`
    SELECT symbol, COUNT(*) as bars,
           MIN(timestamp) as first_bar, MAX(timestamp) as last_bar,
           EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 86400 as days_span
    FROM "Candle1m"
    GROUP BY symbol
    HAVING EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 86400 < 3
    ORDER BY COUNT(*)
  `);
  for (const c of candleCounts) {
    const days = parseFloat(c.days_span).toFixed(1);
    // Don't double-count stablecoins
    if (!exclusions.find(e => e.symbol === c.symbol)) {
      exclusions.push({ symbol: c.symbol, reason: 'insufficient_history', detail: `Only ${days} days of data (${c.bars} bars)` });
      console.log(`  🚫 ${c.symbol} — ${days} days, ${c.bars} bars`);
    }
  }
  if (candleCounts.length === 0) console.log('  All coins have ≥3 days of history');

  // ── Check 3: Anomalous price gaps (manipulation indicator) ──
  console.log('\n═══ CHECK 3: Anomalous Price Gaps (>20% in 1 candle) ═══\n');
  const { rows: gapCoins } = await client.query(`
    WITH gaps AS (
      SELECT symbol, timestamp,
             ABS((close - open) / NULLIF(open, 0)) * 100 as gap_pct
      FROM "Candle1m"
      WHERE open > 0
    )
    SELECT symbol, COUNT(*) as gap_count, MAX(gap_pct) as max_gap
    FROM gaps
    WHERE gap_pct > 20
    GROUP BY symbol
    HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC
  `);
  for (const c of gapCoins) {
    if (!exclusions.find(e => e.symbol === c.symbol)) {
      exclusions.push({
        symbol: c.symbol,
        reason: 'price_anomaly',
        detail: `${c.gap_count} candles with >20% gap (max: ${parseFloat(c.max_gap).toFixed(1)}%)`
      });
      console.log(`  🚫 ${c.symbol} — ${c.gap_count} extreme gaps (max ${parseFloat(c.max_gap).toFixed(1)}%)`);
    }
  }
  if (gapCoins.length === 0) console.log('  No coins with frequent extreme price gaps');

  // ── Check 4: Consistently losing coins with very low win rates ──
  console.log('\n═══ CHECK 4: Structurally Losing (≥20 trades, WR<25%, negative return) ═══\n');
  const { rows: losingCoins } = await client.query(`
    SELECT s.symbol,
           COUNT(*) as trades,
           SUM(s."returnPct") as total_return,
           COUNT(*) FILTER (WHERE s."returnPct" > 0) as wins
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status = 'closed' AND st."barMinutes" = 1
    GROUP BY s.symbol
    HAVING COUNT(*) >= 20
       AND COUNT(*) FILTER (WHERE s."returnPct" > 0)::float / COUNT(*) < 0.25
       AND SUM(s."returnPct") < -5
    ORDER BY SUM(s."returnPct")
  `);
  for (const c of losingCoins) {
    const wr = (c.wins / c.trades * 100).toFixed(0);
    if (!exclusions.find(e => e.symbol === c.symbol)) {
      exclusions.push({
        symbol: c.symbol,
        reason: 'structural_loser',
        detail: `${c.trades} trades, WR=${wr}%, total=${parseFloat(c.total_return).toFixed(2)}%`
      });
      console.log(`  🚫 ${c.symbol} — ${c.trades} trades, WR=${wr}%, ret=${parseFloat(c.total_return).toFixed(2)}%`);
    }
  }
  if (losingCoins.length === 0) console.log('  No coins meet the structural loser criteria');

  // ── Summary ──
  console.log('\n═══ EXCLUSION SUMMARY ═══\n');
  console.log(`  Total exclusions: ${exclusions.length}`);
  const byReason = {};
  for (const e of exclusions) {
    byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`    ${reason}: ${count}`);
  }

  // ── Apply to database ──
  if (APPLY_MODE) {
    console.log('\n═══ APPLYING TO board_coin_overrides ═══\n');
    for (const excl of exclusions) {
      // Check if already excluded
      const { rows: existing } = await client.query(
        `SELECT id FROM board_coin_overrides WHERE symbol = $1 AND override_type = 'exclude' AND active = true`,
        [excl.symbol]
      );
      if (existing.length > 0) {
        console.log(`  ⏩ ${excl.symbol} already excluded (id=${existing[0].id})`);
        continue;
      }
      await client.query(
        `INSERT INTO board_coin_overrides (symbol, override_type, parameters, rationale)
         VALUES ($1, 'exclude', $2, $3)`,
        [excl.symbol, JSON.stringify({ reason: excl.reason, detail: excl.detail }), `Tier 3 auto-exclusion: ${excl.reason} — ${excl.detail}`]
      );
      console.log(`  ✅ Excluded: ${excl.symbol} (${excl.reason})`);
    }
  } else {
    console.log('\n  Run with --apply to write exclusions to database');
  }

  await client.end();
  console.log('\n✓ Tier 3 analysis complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
