const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Find the CAKE/ATOM pair from ~5 Mar 21:19
  const { rows: pairs } = await c.query(`
    SELECT s.id, s.pair_id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
           s."returnPct", s.pair_return, s."maxCycle", s."maxOrder", s.strength,
           s."holdBars", s.status, s."createdAt", s."closedAt",
           s."triggerBands",
           st."barMinutes", st.name as strategy_name
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL
      AND ((s.symbol = 'CAKEUSDT' AND s.direction = 'SHORT')
        OR (s.symbol = 'ATOMUSDT' AND s.direction = 'LONG'))
      AND s."createdAt" >= '2026-03-05 21:00:00'
      AND s."createdAt" <= '2026-03-05 22:00:00'
    ORDER BY s.pair_id, s.symbol
  `);

  if (pairs.length === 0) {
    console.log('No exact match, searching broader...');
    const { rows: broader } = await c.query(`
      SELECT s.id, s.pair_id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
             s."returnPct", s.pair_return, s."maxCycle", s."maxOrder", s.strength,
             s."holdBars", s.status, s."createdAt", s."closedAt",
             s."triggerBands",
             st."barMinutes"
      FROM "FracmapSignal" s
      LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.pair_id IS NOT NULL
        AND (s.symbol = 'CAKEUSDT' OR s.symbol = 'ATOMUSDT')
        AND s."createdAt" >= '2026-03-05 20:00:00'
        AND s."createdAt" <= '2026-03-06 00:00:00'
      ORDER BY s."createdAt"
    `);
    for (const r of broader) {
      console.log(`${r.symbol} ${r.direction} pair=${r.pair_id} created=${r.createdAt} cycle=${r.maxCycle} str=${r.strength} entry=${r.entryPrice}`);
    }
  }

  console.log(`\nFound ${pairs.length} legs:\n`);
  for (const p of pairs) {
    console.log(`=== ${p.symbol} ${p.direction} ===`);
    console.log(`  Signal ID: ${p.id}`);
    console.log(`  Pair ID: ${p.pair_id}`);
    console.log(`  Entry: ${p.entryPrice} at ${p.createdAt}`);
    console.log(`  Exit: ${p.exitPrice} at ${p.closedAt}`);
    console.log(`  Return: ${p.returnPct}%`);
    console.log(`  Pair Return: ${p.pair_return}%`);
    console.log(`  maxCycle: ${p.maxCycle}, maxOrder: ${p.maxOrder}, strength: ${p.strength}`);
    console.log(`  holdBars: ${p.holdBars}`);
    console.log(`  barMinutes: ${p.barMinutes}`);

    const tb = typeof p.triggerBands === 'string' ? JSON.parse(p.triggerBands) : p.triggerBands;
    if (tb) {
      console.log(`  triggerBands: ${JSON.stringify(tb).slice(0, 300)}`);
    }
  }

  // Now look at what the fracmap bands looked like at the signal bar
  // Get the 1m candles around the entry time for both coins
  if (pairs.length >= 1) {
    const entryTime = pairs[0].createdAt;
    for (const sym of ['CAKEUSDT', 'ATOMUSDT']) {
      const { rows: candles } = await c.query(`
        SELECT timestamp, open, high, low, close
        FROM "Candle1m"
        WHERE symbol = $1
          AND timestamp >= $2::timestamptz - INTERVAL '5 minutes'
          AND timestamp <= $2::timestamptz + INTERVAL '5 minutes'
        ORDER BY timestamp
      `, [sym, entryTime]);
      console.log(`\n${sym} candles around entry (${entryTime}):`);
      for (const ca of candles) {
        console.log(`  ${ca.timestamp} O:${ca.open} H:${ca.high} L:${ca.low} C:${ca.close}`);
      }
    }
  }

  // Check: were there ANY signals (not just paired) for both coins at this time?
  const { rows: allSigs } = await c.query(`
    SELECT s.id, s.symbol, s.direction, s."maxCycle", s.strength, s."createdAt",
           s.pair_id, s.pair_symbol, s.pair_direction
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st."barMinutes" = 1
      AND (s.symbol = 'CAKEUSDT' OR s.symbol = 'ATOMUSDT')
      AND s."createdAt" >= '2026-03-05 21:00:00'
      AND s."createdAt" <= '2026-03-05 22:00:00'
    ORDER BY s."createdAt"
  `);
  console.log(`\nAll 1m signals for CAKE/ATOM between 21:00-22:00 on Mar 5:`);
  for (const s of allSigs) {
    console.log(`  ${s.createdAt} ${s.symbol} ${s.direction} cycle=${s.maxCycle} str=${s.strength} pair=${s.pair_id ? s.pair_symbol + ' ' + s.pair_direction : 'unpaired'}`);
  }

  await c.end();
})();
