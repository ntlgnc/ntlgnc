/**
 * Clean stablecoins from database and prevent them from being added.
 * Run once: node clean-stables.cjs
 */
require('dotenv').config();
const { Client } = require('pg');

const STABLES = [
  'USDTUSDT','USDCUSDT','FDUSDUSDT','DAIUSDT','TUSDUSDT','USDEUSDT',
  'PYUSDUSDT','USDPUSDT','GUSDUSDT','FRAXUSDT','BUSDUSDT','LUSDUSDT',
  'USD1USDT','RLUSDUSDT','USDSUSDT','SUSDUSDT','EURCUSDT','AEURUSDT',
  'EURIUSDT','USDNUSDT',
  // Also catch base symbols without USDT suffix
  'USDT','USDC','FDUSD','DAI','TUSD','USDe','PYUSD','USDP','GUSD',
  'FRAX','BUSD','LUSD','USD1','RLUSD','USDS','sUSD','EURC','AEUR',
  'EURI','USDN'
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  console.log('=== Stablecoin Cleanup ===\n');

  // 1. Check distinct coins in candle tables that are stablecoins
  const { rows: regCoins } = await c.query(
    `SELECT DISTINCT symbol FROM "Candle1h" WHERE symbol = ANY($1)`, [STABLES]
  );
  console.log('Stablecoins found in data:', regCoins.map(r => r.symbol).join(', ') || 'none');

  // 2. Check candle tables
  for (const t of ['Candle1m', 'Candle1h', 'Candle1d']) {
    const { rows } = await c.query(
      `SELECT symbol, COUNT(*) as cnt FROM "${t}" WHERE symbol = ANY($1) GROUP BY symbol ORDER BY cnt DESC`, [STABLES]
    );
    if (rows.length) {
      console.log(`${t}:`, rows.map(r => `${r.symbol}(${r.cnt})`).join(', '));
    } else {
      console.log(`${t}: clean`);
    }
  }

  // 3. Check signals
  const { rows: sigs } = await c.query(
    `SELECT symbol, COUNT(*) as cnt FROM "FracmapSignal" WHERE symbol = ANY($1) GROUP BY symbol`, [STABLES]
  );
  console.log('Signals:', sigs.length ? sigs.map(r => `${r.symbol}(${r.cnt})`).join(', ') : 'none');

  // 4. Delete stablecoin data
  console.log('\n=== Deleting... ===\n');

  for (const t of ['Candle1m', 'Candle1h', 'Candle1d']) {
    const { rowCount } = await c.query(`DELETE FROM "${t}" WHERE symbol = ANY($1)`, [STABLES]);
    console.log(`Deleted ${rowCount} rows from ${t}`);
  }

  const { rowCount: sigDel } = await c.query(`DELETE FROM "FracmapSignal" WHERE symbol = ANY($1)`, [STABLES]);
  console.log(`Deleted ${sigDel} signals`);

  // Also clean from board_coin_overrides and board_coin_strategies if they have stablecoins
  try {
    const { rowCount: ovDel } = await c.query(`DELETE FROM board_coin_overrides WHERE symbol = ANY($1)`, [STABLES]);
    if (ovDel) console.log(`Deleted ${ovDel} from board_coin_overrides`);
  } catch {}
  try {
    const { rowCount: csDel } = await c.query(`DELETE FROM board_coin_strategies WHERE symbol = ANY($1)`, [STABLES]);
    if (csDel) console.log(`Deleted ${csDel} from board_coin_strategies`);
  } catch {}

  // 5. Add stablecoins to excluded_coins table (if it exists) to prevent re-adding
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS excluded_coins (
      symbol TEXT PRIMARY KEY,
      reason TEXT DEFAULT 'stablecoin',
      added_at TIMESTAMPTZ DEFAULT now()
    )`);
    for (const sym of STABLES) {
      await c.query(
        `INSERT INTO excluded_coins (symbol, reason) VALUES ($1, 'stablecoin') ON CONFLICT (symbol) DO NOTHING`,
        [sym]
      );
    }
    console.log(`\nAdded ${STABLES.length} symbols to excluded_coins blocklist`);
  } catch (e) {
    console.log('Could not create excluded_coins table:', e.message);
  }

  console.log('\n=== Done ===');
  await c.end();
})();
