const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 1. Show open signals
  const { rows: open } = await client.query(`
    SELECT s.id, s.symbol, s.direction, s."entryPrice", s."strategyId", st."barMinutes"
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status = 'open'
    ORDER BY st."barMinutes", s.symbol
    LIMIT 10
  `);
  console.log(`\n=== OPEN SIGNALS (${open.length} shown) ===`);
  for (const s of open) {
    console.log(`  ${s.symbol} ${s.direction} entry=${s.entryPrice} barMin=${s.barMinutes}`);
  }

  if (open.length === 0) { await client.end(); return; }

  // 2. Try to get price for first symbol from each candle table
  const testSymbol = open[0].symbol;
  console.log(`\n=== PRICE LOOKUP: ${testSymbol} ===`);

  for (const table of ['Candle1m', 'Candle1h', 'Candle1d']) {
    try {
      const { rows } = await client.query(
        `SELECT close, timestamp FROM "${table}" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
        [testSymbol]
      );
      if (rows.length > 0) {
        console.log(`  ${table}: close=${rows[0].close} at ${rows[0].timestamp}`);
      } else {
        console.log(`  ${table}: NO DATA for ${testSymbol}`);
      }
    } catch (err) {
      console.log(`  ${table}: ERROR - ${err.message}`);
    }
  }

  // 3. Check what columns candle tables have
  console.log('\n=== CANDLE TABLE COLUMNS ===');
  for (const table of ['Candle1m', 'Candle1h', 'Candle1d']) {
    try {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [table]
      );
      console.log(`  ${table}: ${rows.map(r => r.column_name).join(', ')}`);
    } catch (err) {
      console.log(`  ${table}: ERROR - ${err.message}`);
    }
  }

  // 4. Check if entryPrice has sanity issues
  console.log('\n=== ENTRY PRICE CHECK ===');
  for (const s of open.slice(0, 3)) {
    const ep = parseFloat(s.entryPrice);
    console.log(`  ${s.symbol}: entryPrice=${s.entryPrice} parsed=${ep} valid=${ep > 0}`);
  }

  await client.end();
}

main().catch(err => console.error(err.message));
