require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  const { rows: [strat] } = await c.query(
    `SELECT id FROM "FracmapStrategy" WHERE name = 'Universal 1m - C30-C40' AND active = true`
  );

  console.log('=== FEB 28 DEEP DIVE — Order 2+ signals ===\n');

  // By order on Feb 28
  console.log('By order on Feb 28:');
  const { rows: byOrder } = await c.query(`
    SELECT "maxOrder",
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" > 1
      AND "createdAt"::date = '2026-02-28'
    GROUP BY "maxOrder" ORDER BY "maxOrder"
  `, [strat.id]);
  console.log('  Order | Trades | WR%   | Avg Ret  | Day Ret');
  console.log('  ' + '-'.repeat(55));
  byOrder.forEach(r => {
    console.log('  ' + String(r.maxOrder).padStart(5) +
      ' | ' + String(r.total).padStart(6) +
      ' | ' + (r.wins / r.total * 100).toFixed(1).padStart(5) + '%' +
      ' | ' + (+r.avg_ret >= 0 ? '+' : '') + (+r.avg_ret).toFixed(4) + '%' +
      ' | ' + (+r.total_ret >= 0 ? '+' : '') + (+r.total_ret).toFixed(1) + '%');
  });

  // By direction on Feb 28 (order 2+)
  console.log('\nBy direction on Feb 28 (order 2+):');
  const { rows: byDir } = await c.query(`
    SELECT direction,
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" > 1
      AND "createdAt"::date = '2026-02-28'
    GROUP BY direction
  `, [strat.id]);
  byDir.forEach(r => console.log('  ' + r.direction + ': ' + r.total + ' trades | WR=' + (r.wins/r.total*100).toFixed(1) + '% | Total=' + (+r.total_ret).toFixed(1) + '%'));

  // Worst individual signals on Feb 28 (order 2+)
  console.log('\nWorst 20 signals on Feb 28 (order 2+):');
  const { rows: worst } = await c.query(`
    SELECT symbol, direction, "maxOrder", "maxCycle", strength, "returnPct",
           "entryPrice", "exitPrice", "holdBars",
           "createdAt"::time as time
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" > 1
      AND "createdAt"::date = '2026-02-28'
    ORDER BY "returnPct" ASC LIMIT 20
  `, [strat.id]);
  console.log('  Symbol         | Dir   | Ord | Cyc | Str | Ret%     | Hold | Time');
  console.log('  ' + '-'.repeat(75));
  worst.forEach(r => {
    console.log('  ' + (r.symbol || '').padEnd(16) +
      ' | ' + r.direction.padEnd(5) +
      ' | ' + String(r.maxOrder).padStart(3) +
      ' | ' + String(r.maxCycle).padStart(3) +
      ' | ' + String(r.strength).padStart(3) +
      ' | ' + (+r.returnPct >= 0 ? '+' : '') + (+r.returnPct).toFixed(3) + '%' +
      ' | ' + String(r.holdBars).padStart(4) +
      ' | ' + String(r.time).slice(0, 5));
  });

  // Compare: same day, order 1 — what was different?
  console.log('\nFor comparison — Order 1 on Feb 28:');
  const { rows: [o1] } = await c.query(`
    SELECT COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" = 1
      AND "createdAt"::date = '2026-02-28'
  `, [strat.id]);
  console.log('  Order 1: ' + o1.total + ' trades | WR=' + (o1.wins/o1.total*100).toFixed(1) + '% | Total=' + (+o1.total_ret).toFixed(1) + '%');

  // Also check: Feb 28 Order 2+ — were losses concentrated in specific coins?
  console.log('\nTop losing coins on Feb 28 (order 2+):');
  const { rows: byCoin } = await c.query(`
    SELECT symbol,
           COUNT(*)::int as total,
           SUM("returnPct") as total_ret,
           AVG("returnPct") as avg_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" > 1
      AND "createdAt"::date = '2026-02-28'
    GROUP BY symbol
    ORDER BY SUM("returnPct") ASC LIMIT 15
  `, [strat.id]);
  byCoin.forEach(r => {
    console.log('  ' + (r.symbol || '').padEnd(16) + ' | ' + String(r.total).padStart(3) + ' trades | ' + (+r.total_ret >= 0 ? '+' : '') + (+r.total_ret).toFixed(1) + '%');
  });

  c.release(); pool.end();
})();
