require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  const { rows: [strat] } = await c.query(
    `SELECT id FROM "FracmapStrategy" WHERE name = 'Universal 1m - C30-C40' AND active = true`
  );

  console.log('=== ORDER 1 vs ORDER 2+ (existing back-propagated signals) ===\n');

  for (const filter of ['= 1', '> 1']) {
    const label = filter === '= 1' ? 'Order 1 ONLY' : 'Order 2+';
    const { rows: [s] } = await c.query(`
      SELECT COUNT(*)::int as total,
             COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
             AVG("returnPct") as avg_ret,
             SUM("returnPct") as total_ret
      FROM "FracmapSignal"
      WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" ${filter}
    `, [strat.id]);

    const wr = s.total > 0 ? (s.wins / s.total * 100).toFixed(1) : '0';
    console.log(label + ':');
    console.log('  Trades: ' + s.total + ' | WR: ' + wr + '% | Avg: ' + (+s.avg_ret >= 0 ? '+' : '') + (+s.avg_ret).toFixed(4) + '% | Total: ' + (+s.total_ret >= 0 ? '+' : '') + (+s.total_ret).toFixed(1) + '%');
  }

  // Order 1 by day
  console.log('\n=== ORDER 1 — DAILY CONSISTENCY ===\n');
  const { rows: days } = await c.query(`
    SELECT "createdAt"::date as day,
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" = 1
    GROUP BY day ORDER BY day
  `, [strat.id]);

  console.log('  Day        | Trades | WR%   | Avg Ret  | Day Ret');
  console.log('  ' + '-'.repeat(58));
  for (const d of days) {
    const wr = (d.wins / d.total * 100).toFixed(1);
    const avg = (+d.avg_ret);
    console.log('  ' + d.day.toISOString().slice(0, 10) +
      ' | ' + String(d.total).padStart(6) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (avg >= 0 ? '+' : '') + avg.toFixed(4) + '%' +
      ' | ' + (+d.total_ret >= 0 ? '+' : '') + (+d.total_ret).toFixed(1) + '%');
  }
  const profDays = days.filter(d => +d.total_ret > 0).length;
  console.log('\n  Profitable days: ' + profDays + '/' + days.length + ' (' + (profDays / days.length * 100).toFixed(0) + '%)');

  // Order 2+ by day for comparison
  console.log('\n=== ORDER 2+ — DAILY CONSISTENCY ===\n');
  const { rows: days2 } = await c.query(`
    SELECT "createdAt"::date as day,
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed' AND "maxOrder" > 1
    GROUP BY day ORDER BY day
  `, [strat.id]);

  console.log('  Day        | Trades | WR%   | Avg Ret  | Day Ret');
  console.log('  ' + '-'.repeat(58));
  for (const d of days2) {
    const wr = (d.wins / d.total * 100).toFixed(1);
    console.log('  ' + d.day.toISOString().slice(0, 10) +
      ' | ' + String(d.total).padStart(6) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (+d.avg_ret >= 0 ? '+' : '') + (+d.avg_ret).toFixed(4) + '%' +
      ' | ' + (+d.total_ret >= 0 ? '+' : '') + (+d.total_ret).toFixed(1) + '%');
  }
  const profDays2 = days2.filter(d => +d.total_ret > 0).length;
  console.log('\n  Profitable days: ' + profDays2 + '/' + days2.length + ' (' + (profDays2 / days2.length * 100).toFixed(0) + '%)');

  c.release(); pool.end();
})();
