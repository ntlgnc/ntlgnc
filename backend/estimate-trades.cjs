require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  // Current 1D strategy
  const { rows: strats } = await c.query(
    `SELECT id, name, "barMinutes", "cycleMin", "cycleMax", active, "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt"
     FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = 1440`
  );
  console.log('=== CURRENT ACTIVE 1D STRATEGY ===');
  for (const s of strats) {
    console.log('  id:', s.id);
    console.log('  name:', s.name);
    console.log('  cycles:', s.cycleMin, '-', s.cycleMax);
    console.log('  params: minStr=' + s.minStr + ' minCyc=' + s.minCyc + ' spike=' + s.spike + ' nearMiss=' + s.nearMiss + ' holdDiv=' + s.holdDiv + ' priceExt=' + s.priceExt);
  }

  // How many days of daily data do we have?
  const { rows: [range] } = await c.query(
    `SELECT MIN(timestamp) as first_bar, MAX(timestamp) as last_bar, COUNT(DISTINCT symbol) as coins
     FROM "Candle1d"`
  );
  const days = Math.round((new Date(range.last_bar) - new Date(range.first_bar)) / 86400000);
  console.log('\n=== DATA RANGE ===');
  console.log('  From:', range.first_bar, 'To:', range.last_bar);
  console.log('  Days:', days, 'Coins:', range.coins);

  // Estimate from backtest: C2-3 signals in OOS half
  // OOS = second 50%, so OOS covers roughly days/2 days
  const oosDays = Math.round(days / 2);
  const oosSignals = 10332; // from backtest output
  const signalsPerDay = oosSignals / oosDays;
  const coinsActive = 149;

  console.log('\n=== TRADE FREQUENCY ESTIMATE (C2-3, unhedged) ===');
  console.log('  OOS signals:', oosSignals, 'over ~' + oosDays + ' days');
  console.log('  Signals per day:', signalsPerDay.toFixed(1));
  console.log('  Signals per coin per day:', (signalsPerDay / coinsActive).toFixed(3));

  // But live-signals only allows one open position per coin per strategy
  // With holdDuration=1 (cycle=2) or 2 (cycle=3), positions close fast
  // So effective daily rate is slightly lower due to position blocking
  console.log('\n  Note: holdDuration = 1 bar (cycle=2) or 2 bars (cycle=3)');
  console.log('  Positions close quickly so blocking is minimal');

  // Hedged pairs: with reuse, ~10198 pairs from 10332 signals
  // With exclusive, ~4374 pairs
  console.log('\n=== HEDGED PAIR FREQUENCY ===');
  console.log('  Reuse mode:    ~' + Math.round(10198 / oosDays) + ' pairs/day');
  console.log('  Exclusive mode: ~' + Math.round(4374 / oosDays) + ' pairs/day');

  // Recent 1D signals
  const { rows: recent } = await c.query(
    `SELECT COUNT(*)::int as cnt, MIN("createdAt") as first_sig
     FROM "FracmapSignal"
     WHERE "strategyId" = $1 AND "createdAt" > NOW() - INTERVAL '10 days'`,
    [strats[0]?.id]
  );
  if (recent[0]) {
    console.log('\n=== RECENT 1D SIGNALS (current strategy, last 10d) ===');
    console.log('  Count:', recent[0].cnt);
    console.log('  Since:', recent[0].first_sig);
    console.log('  Per day:', (recent[0].cnt / 10).toFixed(1));
  }

  c.release(); pool.end();
})();
