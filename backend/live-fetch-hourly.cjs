/**
 * live-fetch-hourly.cjs — Fetches 1-hour candles for all tracked Binance coins
 *
 * Runs every hour. On first run (or when a new coin appears), it backfills
 * up to MAX_ROWS_PER_COIN hourly candles from Binance (most recent first).
 *
 * After backfill, it appends the latest candle each hour and prunes rows
 * beyond MAX_ROWS_PER_COIN to keep the DB from growing unbounded.
 *
 * 10,000 hourly candles ≈ 14 months of data per coin.
 */
require('dotenv').config();
const { Client } = require('pg');
const { getAllTrackedCoins } = require('./coins.cjs');

const DB_URL = process.env.DATABASE_URL;
const MAX_ROWS_PER_COIN = 10_000;

let fetch;
async function getFetch() {
  if (!fetch) { const m = await import('node-fetch'); fetch = m.default; }
  return fetch;
}

const BATCH_SIZE = 5;
const BATCH_DELAY = 1000;
const BINANCE_LIMIT = 1000;

async function fetchKlines(symbol, interval, fetchFn, startTime = null, endTime = null, limit = BINANCE_LIMIT) {
  let url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  if (endTime) url += `&endTime=${endTime}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  return res.json();
}

async function upsertCandles(client, table, symbol, candles) {
  if (candles.length === 0) return 0;
  const values = [];
  const params = [];
  let idx = 1;
  for (const c of candles) {
    values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6})`);
    params.push(symbol, new Date(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]));
    idx += 7;
  }
  const sql = `
    INSERT INTO "${table}" (symbol, timestamp, open, high, low, close, volume)
    VALUES ${values.join(', ')}
    ON CONFLICT (symbol, timestamp) DO NOTHING
  `;
  const result = await client.query(sql, params);
  return result.rowCount;
}

/**
 * Prune oldest rows beyond MAX_ROWS_PER_COIN for a given symbol.
 */
async function pruneOldRows(client, table, symbol) {
  const { rows: [{ cnt }] } = await client.query(
    `SELECT COUNT(*)::int as cnt FROM "${table}" WHERE symbol = $1`, [symbol]
  );
  if (cnt <= MAX_ROWS_PER_COIN) return 0;

  const excess = cnt - MAX_ROWS_PER_COIN;
  const { rowCount } = await client.query(`
    DELETE FROM "${table}" WHERE id IN (
      SELECT id FROM "${table}" WHERE symbol = $1 ORDER BY timestamp ASC LIMIT $2
    )
  `, [symbol, excess]);
  return rowCount;
}

/**
 * Backfill up to MAX_ROWS_PER_COIN hourly candles for a symbol,
 * then prune any excess.
 */
async function syncSymbol(symbol, client, fetchFn) {
  const { rows: [existing] } = await client.query(
    `SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest, COUNT(*)::int as cnt
     FROM "Candle1h" WHERE symbol = $1`,
    [symbol]
  );

  let totalInserted = 0;

  if (existing.cnt === 0) {
    // Initial backfill: fetch up to MAX_ROWS_PER_COIN most recent candles
    console.log(`  [${symbol}] No hourly data — backfilling up to ${MAX_ROWS_PER_COIN} candles...`);
    let endTime = Date.now();
    let remaining = MAX_ROWS_PER_COIN;

    while (remaining > 0) {
      const limit = Math.min(remaining, BINANCE_LIMIT);
      const candles = await fetchKlines(symbol, '1h', fetchFn, null, endTime, limit);
      if (candles.length === 0) break;

      const inserted = await upsertCandles(client, 'Candle1h', symbol, candles);
      totalInserted += inserted;
      remaining -= candles.length;

      const oldestTs = candles[0][0];
      if (candles.length < limit) break;
      endTime = oldestTs - 1;

      await new Promise(r => setTimeout(r, 300));
    }
  } else {
    // Incremental: fetch from last known timestamp forward
    const startTime = new Date(existing.latest).getTime() + 1;
    const candles = await fetchKlines(symbol, '1h', fetchFn, startTime, null, BINANCE_LIMIT);
    if (candles.length > 0) {
      totalInserted = await upsertCandles(client, 'Candle1h', symbol, candles);
    }

    // Prune oldest rows if we've exceeded the cap
    const pruned = await pruneOldRows(client, 'Candle1h', symbol);
    if (pruned > 0) console.log(`  [${symbol}] Pruned ${pruned} old hourly candles`);
  }

  return totalInserted;
}

async function tick() {
  const fetchFn = await getFetch();
  const coins = await getAllTrackedCoins();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`\n══════ ${now} ══════ hourly fetch: ${coins.length} coins (cap ${MAX_ROWS_PER_COIN}/coin) ══════`);

  let totalSaved = 0, totalFailed = 0;

  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(s => syncSymbol(s, client, fetchFn))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        if (r.value > 0) console.log(`  ✓ ${batch[j]}: ${r.value} hourly candles`);
        totalSaved += r.value;
      } else {
        console.error(`  ✗ ${batch[j]}: ${r.reason?.message || r.reason}`);
        totalFailed++;
      }
    }

    if (i + BATCH_SIZE < coins.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  await client.end();
  console.log(`  Total: ${totalSaved} hourly candles saved, ${totalFailed} coins failed\n`);
}

// Run immediately, then align to the top of each hour
// This ensures the completed candle is in the DB before the signal engine polls
tick().catch(e => console.error('Hourly tick failed:', e));

function msUntilNextHour() {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const elapsed = now % hourMs;
  return hourMs - elapsed;
}

// Small delay after hour turns to let Binance finalise the candle
const HOUR_OFFSET = 5_000; // 5 seconds after the hour

async function alignedLoop() {
  while (true) {
    const waitMs = msUntilNextHour() + HOUR_OFFSET;
    console.log(`[hourly-fetch] Next fetch in ${(waitMs/1000).toFixed(0)}s (aligned to XX:00:${HOUR_OFFSET/1000}s)`);
    await new Promise(r => setTimeout(r, waitMs));
    await tick().catch(e => console.error('Hourly tick failed:', e));
  }
}
alignedLoop();
