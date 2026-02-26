/**
 * check-candles.cjs — Health check for all candle tables
 *
 * Usage: node check-candles.cjs
 */
require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  for (const table of ['Candle1m', 'Candle1h', 'Candle1d']) {
    console.log(`\n═══ ${table} ═══`);
    try {
      const { rows: [summary] } = await client.query(
        `SELECT COUNT(DISTINCT symbol) as coins, COUNT(*)::bigint as total,
                MIN(timestamp) as earliest, MAX(timestamp) as latest
         FROM "${table}"`
      );
      console.log(`  Coins: ${summary.coins} | Total rows: ${summary.total}`);
      console.log(`  Range: ${summary.earliest?.toISOString().slice(0,16) || 'N/A'} → ${summary.latest?.toISOString().slice(0,16) || 'N/A'}`);

      const { rows: top } = await client.query(
        `SELECT symbol, COUNT(*)::int as cnt, MIN(timestamp) as earliest, MAX(timestamp) as latest
         FROM "${table}" GROUP BY symbol ORDER BY cnt DESC LIMIT 10`
      );
      console.log(`  Top 10 by count:`);
      for (const r of top) {
        console.log(`    ${r.symbol.padEnd(12)} ${String(r.cnt).padStart(8)} candles  ${r.earliest.toISOString().slice(0,10)} → ${r.latest.toISOString().slice(0,10)}`);
      }
    } catch (e) {
      console.log(`  Table does not exist yet. Run: node run-migration-013.cjs`);
    }
  }

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
