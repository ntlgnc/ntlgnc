require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  const { rows: [strat] } = await c.query(
    `SELECT id FROM "FracmapStrategy" WHERE name = 'Universal 1m - C30-C40' AND active = true`
  );

  console.log('=== WIN RATE INVESTIGATION ===\n');

  // Overall WR
  const { rows: [all] } = await c.query(`
    SELECT COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           COUNT(*) FILTER (WHERE "returnPct" = 0)::int as flat,
           COUNT(*) FILTER (WHERE "returnPct" < 0)::int as losses
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed'
  `, [strat.id]);
  console.log('All closed: ' + all.total + ' | Wins: ' + all.wins + ' (' + (all.wins/all.total*100).toFixed(1) + '%) | Flat: ' + all.flat + ' | Losses: ' + all.losses);

  // WR by order
  console.log('\nWR by order:');
  const { rows: byOrd } = await c.query(`
    SELECT "maxOrder",
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed'
    GROUP BY "maxOrder" ORDER BY "maxOrder"
  `, [strat.id]);
  byOrd.forEach(r => console.log('  Order ' + r.maxOrder + ': ' + r.total + ' trades, WR=' + (r.wins/r.total*100).toFixed(1) + '%'));

  // Check: what does the signals page see?
  // It queries with st.active = true and status IN ('open','closed')
  console.log('\nWhat the signals page shows (active + open/closed):');
  const { rows: [page] } = await c.query(`
    SELECT COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE s.status = 'closed')::int as closed,
           COUNT(*) FILTER (WHERE s.status = 'open')::int as open,
           COUNT(*) FILTER (WHERE s.status = 'closed' AND s."returnPct" > 0)::int as wins
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st.active = true AND st."barMinutes" = 1 AND s.status IN ('open', 'closed')
  `);
  console.log('  Total: ' + page.total + ' | Closed: ' + page.closed + ' | Open: ' + page.open);
  console.log('  Wins (closed): ' + page.wins + ' | WR: ' + (page.closed > 0 ? (page.wins/page.closed*100).toFixed(1) : '?') + '%');

  // Check if hedged pairs WR is different
  console.log('\nHedged pairs WR (1m):');
  const { rows: [hp] } = await c.query(`
    SELECT COUNT(DISTINCT pair_id)::int as pairs,
           COUNT(*) FILTER (WHERE pair_return > 0)::int / 2 as pair_wins,
           COUNT(*) FILTER (WHERE pair_return IS NOT NULL)::int / 2 as pair_closed
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st.active = true AND st."barMinutes" = 1 AND pair_id IS NOT NULL
  `);
  console.log('  Pairs: ' + hp.pairs + ' | Pair wins: ' + hp.pair_wins + ' | Pair closed: ' + hp.pair_closed);
  if (hp.pair_closed > 0) console.log('  Pair WR: ' + (hp.pair_wins / hp.pair_closed * 100).toFixed(1) + '%');

  // The signals page equity curve component computes WR from closed signals
  // But the hedged card computes WR from pair returns
  // Let's check what the 55% could be
  console.log('\nPossible sources of 55% WR on signals page:');

  // Check: is it showing WR from the MiniEquityCurve which uses sorted closed signals?
  // That component filters by periodicity (1m = barMinutes <= 1)
  const { rows: [pageCalc] } = await c.query(`
    SELECT COUNT(*)::int as closed,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE st.active = true AND s.status = 'closed' AND s."returnPct" IS NOT NULL
      AND st."barMinutes" <= 1
  `);
  console.log('  Active 1m closed with returnPct: ' + pageCalc.closed + ' | Wins: ' + pageCalc.wins + ' | WR: ' + (pageCalc.closed > 0 ? (pageCalc.wins/pageCalc.closed*100).toFixed(1) : '?') + '%');

  c.release(); pool.end();
})();
