/**
 * live-fetch.cjs — Fetches 1-minute candles for all tracked Binance coins
 *
 * Runs every 60 seconds. Fetches in batches of 10 to avoid rate limits.
 * Uses dynamic coin list from coins.cjs (refreshes every 6 hours).
 * Uses pg directly (no Prisma dependency).
 */
require('dotenv').config();
const { Client } = require('pg');
const { getAllTrackedCoins } = require('./coins.cjs');

console.log('DEBUG: live-fetch starting (all tracked coins)');
console.log('DEBUG: DATABASE_URL exists?', !!process.env.DATABASE_URL);

const DB_URL = process.env.DATABASE_URL;

let fetch;
async function getFetch() {
  if (!fetch) {
    const mod = await import('node-fetch');
    fetch = mod.default;
  }
  return fetch;
}

let dbClient;
async function getDb() {
  if (!dbClient) {
    dbClient = new Client({ connectionString: DB_URL });
    await dbClient.connect();
  }
  return dbClient;
}

const BATCH_SIZE = 10;
const BATCH_DELAY = 500;

async function fetchAndSaveCandle(symbol, fetchFn, client) {
  try {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&limit=1`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

    const [candle] = await res.json();
    if (!candle) throw new Error('No candle');

    const timestamp = new Date(candle[0]);

    await client.query(
      `INSERT INTO "Candle1m" (symbol, timestamp, open, high, low, close, volume)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (symbol, timestamp) DO NOTHING`,
      [symbol, timestamp, Number(candle[1]), Number(candle[2]), Number(candle[3]), Number(candle[4]), Number(candle[5])]
    );

    return { symbol, ok: true, close: Number(candle[4]) };
  } catch (err) {
    console.error(`[${symbol}] ${err.message}`);
    return { symbol, ok: false };
  }
}

async function processBatch(symbols, fetchFn, client) {
  return Promise.all(symbols.map(s => fetchAndSaveCandle(s, fetchFn, client)));
}

async function tick() {
  const fetchFn = await getFetch();
  const client = await getDb();
  const coins = await getAllTrackedCoins();
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`──── ${now} ──── fetching ${coins.length} coins (1m) ────`);

  let saved = 0, failed = 0;

  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE);
    const results = await processBatch(batch, fetchFn, client);
    for (const r of results) {
      if (r.ok) saved++;
      else failed++;
    }
    if (i + BATCH_SIZE < coins.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  console.log(`  ✓ ${saved} saved, ${failed} failed\n`);
}

tick();
setInterval(tick, 60000);
