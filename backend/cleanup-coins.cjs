require('dotenv').config();
const { Client } = require('pg');
const { getAllTrackedCoins } = require('./coins.cjs');

async function main() {
  const ACTIVE_COINS = await getAllTrackedCoins();
  console.log(`Active coins (sticky list): ${ACTIVE_COINS.length}`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 1. Find what coins exist in the DB
  const { rows: predCoins } = await client.query(
    `SELECT DISTINCT symbol, COUNT(*)::int as cnt FROM "Prediction" GROUP BY symbol ORDER BY symbol`
  );
  console.log('=== Coins in Predictions table ===');
  for (const r of predCoins) {
    const active = ACTIVE_COINS.includes(r.symbol) ? '  ✓ ACTIVE' : '  ✗ OLD — will delete';
    console.log(`  ${r.symbol.padEnd(12)} ${String(r.cnt).padStart(6)} preds${active}`);
  }

  const { rows: candleCoins } = await client.query(
    `SELECT DISTINCT symbol, COUNT(*)::int as cnt FROM "Candle1m" GROUP BY symbol ORDER BY symbol`
  );
  console.log('\n=== Coins in Candle1m table ===');
  for (const r of candleCoins) {
    const active = ACTIVE_COINS.includes(r.symbol) ? '  ✓ ACTIVE' : '  ✗ OLD — will delete';
    console.log(`  ${r.symbol.padEnd(12)} ${String(r.cnt).padStart(8)} candles${active}`);
  }

  // 2. Build list of coins to remove
  const placeholders = ACTIVE_COINS.map((_, i) => `$${i + 1}`).join(',');

  // 3. Delete old predictions
  const { rowCount: predDeleted } = await client.query(
    `DELETE FROM "Prediction" WHERE symbol NOT IN (${placeholders})`,
    ACTIVE_COINS
  );
  console.log(`\n✓ Deleted ${predDeleted} predictions for inactive coins`);

  // 4. Delete old candles (1m)
  const { rowCount: candleDeleted } = await client.query(
    `DELETE FROM "Candle1m" WHERE symbol NOT IN (${placeholders})`,
    ACTIVE_COINS
  );
  console.log(`✓ Deleted ${candleDeleted} 1m candles for inactive coins`);

  // 4b. Delete old candles (1h)
  try {
    const { rowCount: hourlyDeleted } = await client.query(
      `DELETE FROM "Candle1h" WHERE symbol NOT IN (${placeholders})`,
      ACTIVE_COINS
    );
    console.log(`✓ Deleted ${hourlyDeleted} 1h candles for inactive coins`);
  } catch (e) { /* table might not exist yet */ }

  // 4c. Delete old candles (1d)
  try {
    const { rowCount: dailyDeleted } = await client.query(
      `DELETE FROM "Candle1d" WHERE symbol NOT IN (${placeholders})`,
      ACTIVE_COINS
    );
    console.log(`✓ Deleted ${dailyDeleted} 1d candles for inactive coins`);
  } catch (e) { /* table might not exist yet */ }

  // 5. Clean up bias trackers for old coins
  try {
    const { rowCount: biasDeleted } = await client.query(
      `DELETE FROM "ModelBiasTracker" WHERE symbol NOT IN (${placeholders})`,
      ACTIVE_COINS
    );
    console.log(`✓ Deleted ${biasDeleted} bias tracker rows for inactive coins`);
  } catch (e) { /* table might not exist */ }

  try {
    const { rowCount: regimeDeleted } = await client.query(
      `DELETE FROM "ModelRegimePerf" WHERE symbol NOT IN (${placeholders})`,
      ACTIVE_COINS
    );
    console.log(`✓ Deleted ${regimeDeleted} regime perf rows for inactive coins`);
  } catch (e) { /* table might not exist */ }

  // 6. Verify
  const { rows: [remaining] } = await client.query(
    `SELECT COUNT(DISTINCT symbol) as coins, COUNT(*)::int as preds FROM "Prediction"`
  );
  console.log(`\nAfter cleanup: ${remaining.coins} coins, ${remaining.preds} predictions`);

  await client.end();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
