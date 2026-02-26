/**
 * backfill-1m.cjs — One-time backfill of 2 weeks of 1-minute candle data
 *
 * Downloads 14 days of 1m candles from Binance for all tracked coins.
 * Existing coins (your original 20) will just fill any gaps.
 * New coins (the additional ~80) will get the full 2 weeks.
 *
 * Safe to re-run: uses ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   node backfill-1m.cjs                   # all tracked coins, 14 days
 *   node backfill-1m.cjs --days 7          # 7 days instead
 *   node backfill-1m.cjs --symbol PEPEUSDT # single coin only
 *
 * 2 weeks = 20,160 one-minute candles per coin.
 * 100 coins × 20,160 = ~2M rows. Expect ~30-45 min on first run.
 */
require('dotenv').config();
const { Client } = require('pg');
const { getAllTrackedCoins } = require('./coins.cjs');

const DB_URL = process.env.DATABASE_URL;
const DEFAULT_DAYS = 14;
const BINANCE_LIMIT = 1000;  // max candles per request

let fetch;
async function getFetch() {
  if (!fetch) { const m = await import('node-fetch'); fetch = m.default; }
  return fetch;
}

async function fetchKlines(symbol, fetchFn, startTime, endTime) {
  let url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&limit=${BINANCE_LIMIT}`;
  if (startTime) url += `&startTime=${startTime}`;
  if (endTime) url += `&endTime=${endTime}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  return res.json();
}

/**
 * Bulk insert candles using raw SQL — much faster than Prisma upserts
 * for thousands of rows. ON CONFLICT DO NOTHING skips duplicates.
 */
async function bulkInsert(client, symbol, candles) {
  if (candles.length === 0) return 0;

  const values = [];
  const params = [];
  let idx = 1;

  for (const c of candles) {
    values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6})`);
    params.push(
      symbol,
      new Date(c[0]),  // timestamp
      Number(c[1]),    // open
      Number(c[2]),    // high
      Number(c[3]),    // low
      Number(c[4]),    // close
      Number(c[5]),    // volume
    );
    idx += 7;
  }

  const sql = `
    INSERT INTO "Candle1m" (symbol, timestamp, open, high, low, close, volume)
    VALUES ${values.join(', ')}
    ON CONFLICT (symbol, timestamp) DO NOTHING
  `;

  const result = await client.query(sql, params);
  return result.rowCount;
}

/**
 * Backfill a single symbol. Paginates forward from startMs to now.
 * Forward pagination is more efficient for a fixed time window.
 */
async function backfillSymbol(symbol, client, fetchFn, startMs) {
  // Check what we already have in the target window
  const { rows: [existing] } = await client.query(
    `SELECT COUNT(*)::int as cnt FROM "Candle1m"
     WHERE symbol = $1 AND timestamp >= $2`,
    [symbol, new Date(startMs)]
  );

  const expectedCandles = Math.floor((Date.now() - startMs) / 60000);
  const coverage = existing.cnt > 0 ? ((existing.cnt / expectedCandles) * 100).toFixed(0) : 0;
  process.stdout.write(`  ${symbol.padEnd(12)} ${existing.cnt} existing (${coverage}% coverage)... `);

  let totalInserted = 0;
  let currentStart = startMs;
  let pages = 0;

  while (currentStart < Date.now()) {
    const candles = await fetchKlines(symbol, fetchFn, currentStart, null);
    if (candles.length === 0) break;

    const inserted = await bulkInsert(client, symbol, candles);
    totalInserted += inserted;
    pages++;

    // Move forward past the last candle we received
    const lastTs = candles[candles.length - 1][0];
    currentStart = lastTs + 60000; // +1 minute

    // Progress indicator every 5 pages
    if (pages % 5 === 0) process.stdout.write('.');

    // Rate limit: ~3 req/sec
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(` +${totalInserted} (${pages} pages)`);
  return totalInserted;
}

async function main() {
  const args = process.argv.slice(2);
  let days = DEFAULT_DAYS;
  let singleSymbol = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i+1]) days = parseInt(args[i+1]);
    if (args[i] === '--symbol' && args[i+1]) singleSymbol = args[i+1].toUpperCase();
  }

  const startMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  const startDate = new Date(startMs).toISOString().slice(0, 10);

  const fetchFn = await getFetch();
  const allCoins = singleSymbol ? [singleSymbol] : await getAllTrackedCoins();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(`\n═══ 1m Backfill: ${allCoins.length} coins × ${days} days (since ${startDate}) ═══`);
  console.log(`    Expected: ~${(days * 24 * 60).toLocaleString()} candles per coin\n`);

  let grandTotal = 0;
  let coinsDone = 0;
  const t0 = Date.now();

  for (const symbol of allCoins) {
    try {
      const count = await backfillSymbol(symbol, client, fetchFn, startMs);
      grandTotal += count;
      coinsDone++;

      // ETA
      const elapsed = (Date.now() - t0) / 1000;
      const perCoin = elapsed / coinsDone;
      const remaining = (allCoins.length - coinsDone) * perCoin;
      if (coinsDone % 10 === 0) {
        console.log(`    --- ${coinsDone}/${allCoins.length} coins done, ETA ${(remaining / 60).toFixed(1)} min ---`);
      }
    } catch (err) {
      console.error(`  ✗ ${symbol}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n═══ Done: ${grandTotal.toLocaleString()} candles inserted in ${elapsed}s ═══\n`);

  // Summary
  const { rows } = await client.query(`
    SELECT symbol, COUNT(*)::int as cnt,
           MIN(timestamp) as earliest, MAX(timestamp) as latest
    FROM "Candle1m"
    GROUP BY symbol ORDER BY cnt DESC
    LIMIT 20
  `);
  console.log('Top 20 by count:');
  console.log('Symbol       Count       Earliest             Latest');
  console.log('─'.repeat(70));
  for (const r of rows) {
    console.log(`${r.symbol.padEnd(12)} ${String(r.cnt).padStart(9)}   ${r.earliest.toISOString().slice(0,16)}   ${r.latest.toISOString().slice(0,16)}`);
  }

  const { rows: [totals] } = await client.query(
    `SELECT COUNT(DISTINCT symbol) as coins, COUNT(*)::bigint as total FROM "Candle1m"`
  );
  console.log(`\nTotal: ${totals.coins} coins, ${Number(totals.total).toLocaleString()} rows`);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
