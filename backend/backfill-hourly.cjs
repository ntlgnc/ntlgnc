/**
 * backfill-hourly.cjs — One-time backfill of ALL available hourly data
 *
 * Downloads the COMPLETE hourly history from Binance for all tracked coins.
 * No row cap — this is a one-time full download. The live-fetch-hourly.cjs
 * script handles the 10K rolling cap going forward.
 *
 * Safe to re-run: uses ON CONFLICT DO NOTHING.
 *
 * Usage: node backfill-hourly.cjs [--symbol BTCUSDT]
 *
 * BTC has ~75,000 hourly candles since Aug 2017.
 * Expect ~20–30 min for 100 coins on first run.
 */
require('dotenv').config();
const { Client } = require('pg');
const { getAllTrackedCoins } = require('./coins.cjs');

const DB_URL = process.env.DATABASE_URL;

let fetch;
async function getFetch() {
  if (!fetch) { const m = await import('node-fetch'); fetch = m.default; }
  return fetch;
}

const BINANCE_LIMIT = 1000;

async function fetchKlines(symbol, interval, fetchFn, startTime, endTime, limit = BINANCE_LIMIT) {
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

async function backfillSymbol(symbol, client, fetchFn) {
  const { rows: [existing] } = await client.query(
    `SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest, COUNT(*)::int as cnt FROM "Candle1h" WHERE symbol = $1`,
    [symbol]
  );

  let totalInserted = 0;
  let pages = 0;

  if (existing.cnt === 0) {
    // Full backfill — download everything available
    process.stdout.write(`  ${symbol.padEnd(12)} full backfill...`);
    let endTime = Date.now();

    while (true) {
      const candles = await fetchKlines(symbol, '1h', fetchFn, null, endTime, BINANCE_LIMIT);
      if (candles.length === 0) break;

      const inserted = await upsertCandles(client, 'Candle1h', symbol, candles);
      totalInserted += inserted;
      pages++;

      const oldestTs = candles[0][0];
      if (candles.length < BINANCE_LIMIT) break;
      endTime = oldestTs - 1;

      await new Promise(r => setTimeout(r, 350));
    }

    console.log(` ${totalInserted} candles (${pages} pages)`);
  } else {
    // Fill backwards from earliest known to get any older history
    process.stdout.write(`  ${symbol.padEnd(12)} filling gaps (${existing.cnt} existing)...`);
    let endTime = new Date(existing.earliest).getTime() - 1;

    while (true) {
      const candles = await fetchKlines(symbol, '1h', fetchFn, null, endTime, BINANCE_LIMIT);
      if (candles.length === 0) break;

      const inserted = await upsertCandles(client, 'Candle1h', symbol, candles);
      totalInserted += inserted;
      pages++;

      const oldestTs = candles[0][0];
      if (candles.length < BINANCE_LIMIT) break;
      endTime = oldestTs - 1;

      await new Promise(r => setTimeout(r, 350));
    }

    // Also fill forward from latest to now
    const { rows: [lat] } = await client.query(
      `SELECT MAX(timestamp) as latest FROM "Candle1h" WHERE symbol = $1`, [symbol]
    );
    const startTime = new Date(lat.latest).getTime() + 1;
    let fwdTime = startTime;
    while (true) {
      const candles = await fetchKlines(symbol, '1h', fetchFn, fwdTime, null, BINANCE_LIMIT);
      if (candles.length === 0) break;
      const ins = await upsertCandles(client, 'Candle1h', symbol, candles);
      totalInserted += ins;
      if (candles.length < BINANCE_LIMIT) break;
      fwdTime = candles[candles.length - 1][0] + 1;
      await new Promise(r => setTimeout(r, 350));
    }

    console.log(` ${totalInserted} candles (${pages} pages)`);
  }

  return totalInserted;
}

async function main() {
  const args = process.argv.slice(2);
  let numCoins = 100;
  let singleSymbol = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coins' && args[i+1]) numCoins = parseInt(args[i+1]);
    if (args[i] === '--symbol' && args[i+1]) singleSymbol = args[i+1].toUpperCase();
  }

  const fetchFn = await getFetch();
  const allCoins = singleSymbol ? [singleSymbol] : await getAllTrackedCoins();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log(`\n═══ Hourly Backfill: ${allCoins.length} coins ═══\n`);

  let grandTotal = 0;
  const startTime = Date.now();

  for (const symbol of allCoins) {
    try {
      const count = await backfillSymbol(symbol, client, fetchFn);
      grandTotal += count;
    } catch (err) {
      console.error(`  ✗ ${symbol}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n═══ Done: ${grandTotal} total hourly candles in ${elapsed}s ═══\n`);

  // Print summary
  const { rows } = await client.query(
    `SELECT symbol, COUNT(*)::int as cnt, MIN(timestamp) as earliest, MAX(timestamp) as latest
     FROM "Candle1h" GROUP BY symbol ORDER BY cnt DESC`
  );
  console.log('Symbol       Count     Earliest             Latest');
  console.log('─'.repeat(70));
  for (const r of rows) {
    console.log(`${r.symbol.padEnd(12)} ${String(r.cnt).padStart(7)}   ${r.earliest.toISOString().slice(0,16)}   ${r.latest.toISOString().slice(0,16)}`);
  }

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
