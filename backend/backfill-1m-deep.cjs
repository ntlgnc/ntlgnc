/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DEEP 1m BACKFILL — Extends history backwards by 1 week/run     ║
 * ║                                                                  ║
 * ║  Run nightly. Each run finds the earliest 1m candle per coin    ║
 * ║  and fetches 7 more days before that. Binance API: 1000 bars    ║
 * ║  per request = ~16.7 hours, so ~10 requests per coin per week.  ║
 * ║                                                                  ║
 * ║  Usage: node backend/backfill-1m-deep.cjs                      ║
 * ║  Add to supervisor or run via cron/scheduler.                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const BATCH_SIZE = 1000; // Binance max per request
const INTERVAL_MS = 60000; // 1 minute in ms
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_MS = 200; // Delay between API calls to avoid rate limits
const MAX_COINS = 200; // Safety limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol, startTime, endTime) {
  const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&limit=${BATCH_SIZE}&startTime=${startTime}&endTime=${endTime}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status} for ${symbol}`);
  return res.json();
}

(async () => {
  const client = await pool.connect();

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  DEEP 1m BACKFILL — Extending history by 1 week                 ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  // Ensure table exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS "Candle1m" (
      symbol TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      open FLOAT, high FLOAT, low FLOAT, close FLOAT, volume FLOAT,
      UNIQUE(symbol, timestamp)
    )
  `);

  // Get all coins and their earliest candle
  const { rows: coins } = await client.query(`
    SELECT symbol, MIN(timestamp) as earliest, COUNT(*)::int as bars
    FROM "Candle1m"
    GROUP BY symbol
    ORDER BY bars DESC
    LIMIT $1
  `, [MAX_COINS]);

  console.log('  Coins in database: ' + coins.length);
  if (coins.length === 0) { console.log('  No coins found. Run the live fetcher first.'); await client.release(); await pool.end(); return; }

  const now = Date.now();
  let totalInserted = 0;
  let totalCoins = 0;
  let errors = 0;

  for (const coin of coins) {
    const earliest = new Date(coin.earliest).getTime();
    const targetStart = earliest - WEEK_MS;

    // Skip if we already have data going back far enough (e.g., already ran today)
    const daysBack = (now - earliest) / (24 * 60 * 60 * 1000);
    console.log('  ' + coin.symbol.padEnd(14) + ' | ' + coin.bars + ' bars | earliest: ' + new Date(earliest).toISOString().slice(0, 10) + ' (' + daysBack.toFixed(0) + 'd ago)');

    let cursor = targetStart;
    let coinInserted = 0;

    while (cursor < earliest) {
      const batchEnd = Math.min(cursor + BATCH_SIZE * INTERVAL_MS, earliest);

      try {
        const klines = await fetchKlines(coin.symbol, cursor, batchEnd);

        if (klines.length === 0) {
          // No more data available before this point
          break;
        }

        // Insert candles
        for (const k of klines) {
          const ts = new Date(k[0]).toISOString();
          const open = parseFloat(k[1]);
          const high = parseFloat(k[2]);
          const low = parseFloat(k[3]);
          const close = parseFloat(k[4]);
          const volume = parseFloat(k[5]);

          if (isNaN(open) || open <= 0) continue;

          try {
            await client.query(
              `INSERT INTO "Candle1m" (symbol, timestamp, open, high, low, close, volume)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (symbol, timestamp) DO NOTHING`,
              [coin.symbol, ts, open, high, low, close, volume]
            );
            coinInserted++;
          } catch {}
        }

        // Move cursor forward
        const lastTs = klines[klines.length - 1][0];
        cursor = lastTs + INTERVAL_MS;

        await sleep(RATE_LIMIT_MS);

      } catch (err) {
        errors++;
        if (errors <= 5) console.error('    Error: ' + err.message);
        break; // Move to next coin on error
      }
    }

    if (coinInserted > 0) {
      totalInserted += coinInserted;
      totalCoins++;
      process.stdout.write('    → +' + coinInserted + ' candles\n');
    }
  }

  // Verify
  const { rows: [after] } = await client.query(`
    SELECT COUNT(*)::bigint as total, MIN(timestamp) as earliest, MAX(timestamp) as latest
    FROM "Candle1m"
  `);

  console.log('\n=== SUMMARY ===');
  console.log('  Coins extended: ' + totalCoins);
  console.log('  Candles added: ' + totalInserted.toLocaleString());
  console.log('  Errors: ' + errors);
  console.log('  Total 1m candles: ' + (+after.total).toLocaleString());
  console.log('  Range: ' + new Date(after.earliest).toISOString().slice(0, 10) + ' to ' + new Date(after.latest).toISOString().slice(0, 10));

  client.release();
  await pool.end();
  console.log('\n✓ Done. Run again tomorrow to extend another week.');
})();
