/**
 * live-fetch-daily.cjs - Fetches 1-day candles for all tracked Binance coins
 *
 * Runs every hour (to catch the daily close promptly).
 * On first run (or when a new coin appears), it backfills up to
 * MAX_ROWS_PER_COIN daily candles from Binance (most recent first).
 *
 * After backfill, it upserts the latest daily candle(s) and prunes
 * rows beyond MAX_ROWS_PER_COIN.
 *
 * 10,000 daily candles = ~27 years - effectively unlimited for crypto.
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

async function syncSymbol(symbol, client, fetchFn) {
  const { rows: [existing] } = await client.query(
    `SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest, COUNT(*)::int as cnt
     FROM "Candle1d" WHERE symbol = $1`,
    [symbol]
  );

  let totalInserted = 0;

  if (existing.cnt === 0) {
    // Initial backfill: fetch up to MAX_ROWS_PER_COIN most recent daily candles
    console.log(`  [${symbol}] No daily data - backfilling up to ${MAX_ROWS_PER_COIN} candles...`);
    let endTime = Date.now();
    let remaining = MAX_ROWS_PER_COIN;

    while (remaining > 0) {
      const limit = Math.min(remaining, BINANCE_LIMIT);
      const candles = await fetchKlines(symbol, '1d', fetchFn, null, endTime, limit);
      if (candles.length === 0) break;

      const inserted = await upsertCandles(client, 'Candle1d', symbol, candles);
      totalInserted += inserted;
      remaining -= candles.length;

      const oldestTs = candles[0][0];
      if (candles.length < limit) break;
      endTime = oldestTs - 1;

      await new Promise(r => setTimeout(r, 300));
    }
  } else {
    // Incremental: fetch from last known daily candle forward
    const startTime = new Date(existing.latest).getTime() + 1;
    const candles = await fetchKlines(symbol, '1d', fetchFn, startTime, null, BINANCE_LIMIT);
    if (candles.length > 0) {
      totalInserted = await upsertCandles(client, 'Candle1d', symbol, candles);
    }

    const pruned = await pruneOldRows(client, 'Candle1d', symbol);
    if (pruned > 0) console.log(`  [${symbol}] Pruned ${pruned} old daily candles`);
  }

  return totalInserted;
}

async function tick() {
  const fetchFn = await getFetch();
  const coins = await getAllTrackedCoins();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`\n====== ${now} ====== daily fetch: ${coins.length} coins (cap ${MAX_ROWS_PER_COIN}/coin) ======`);

  let totalSaved = 0, totalFailed = 0;

  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(s => syncSymbol(s, client, fetchFn))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        if (r.value > 0) console.log(`  + ${batch[j]}: ${r.value} daily candles`);
        totalSaved += r.value;
      } else {
        console.error(`  x ${batch[j]}: ${r.reason?.message || r.reason}`);
        totalFailed++;
      }
    }

    if (i + BATCH_SIZE < coins.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  await client.end();
  console.log(`  Total: ${totalSaved} daily candles saved, ${totalFailed} coins failed\n`);
}

// Run immediately, then align to the top of each hour
// Daily candles close at 00:00 UTC on Binance, but we poll hourly to catch it promptly
tick().catch(e => console.error('Daily tick failed:', e));

function msUntilNextHour() {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const elapsed = now % hourMs;
  return hourMs - elapsed;
}

const HOUR_OFFSET = 5_000; // 5 seconds after the hour

async function alignedLoop() {
  while (true) {
    const waitMs = msUntilNextHour() + HOUR_OFFSET;
    await new Promise(r => setTimeout(r, waitMs));
    await tick().catch(e => console.error('Daily tick failed:', e));
  }
}
alignedLoop();
