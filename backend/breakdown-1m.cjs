require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  // Get active 1m strategy
  const { rows: [strat] } = await c.query(
    `SELECT id, name, spike, "nearMiss", "minStr", "holdDiv", "cycleMin", "cycleMax", config
     FROM "FracmapStrategy" WHERE "barMinutes" = 1 AND active = true LIMIT 1`
  );
  console.log('Strategy:', strat.name);
  console.log('  spike=' + strat.spike + ' nearMiss=' + strat.nearMiss + ' minStr=' + strat.minStr + ' holdDiv=' + strat.holdDiv);
  console.log('  cycles=' + strat.cycleMin + '-' + strat.cycleMax);
  console.log('  hedging:', strat.config);

  // Breakdown by maxOrder
  console.log('\n=== PERFORMANCE BY MAX ORDER ===');
  const { rows: byOrder } = await c.query(`
    SELECT "maxOrder",
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed'
    GROUP BY "maxOrder" ORDER BY "maxOrder"
  `, [strat.id]);

  console.log('  Order | Trades | WR%   | Avg Ret  | Total Ret');
  console.log('  ' + '-'.repeat(55));
  byOrder.forEach(r => {
    const wr = r.total > 0 ? (r.wins / r.total * 100).toFixed(1) : '0';
    console.log('  ' + String(r.maxOrder || '?').padStart(5) +
      ' | ' + String(r.total).padStart(6) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (r.avg_ret >= 0 ? '+' : '') + (+r.avg_ret).toFixed(4) + '%' +
      ' | ' + (r.total_ret >= 0 ? '+' : '') + (+r.total_ret).toFixed(1) + '%');
  });

  // Breakdown by maxCycle
  console.log('\n=== PERFORMANCE BY MAX CYCLE ===');
  const { rows: byCycle } = await c.query(`
    SELECT "maxCycle",
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed'
    GROUP BY "maxCycle" ORDER BY "maxCycle"
  `, [strat.id]);

  console.log('  Cycle | Trades | WR%   | Avg Ret  | Total Ret');
  console.log('  ' + '-'.repeat(55));
  byCycle.forEach(r => {
    const wr = r.total > 0 ? (r.wins / r.total * 100).toFixed(1) : '0';
    console.log('  ' + String(r.maxCycle || '?').padStart(5) +
      ' | ' + String(r.total).padStart(6) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (r.avg_ret >= 0 ? '+' : '') + (+r.avg_ret).toFixed(4) + '%' +
      ' | ' + (r.total_ret >= 0 ? '+' : '') + (+r.total_ret).toFixed(1) + '%');
  });

  // Breakdown by strength
  console.log('\n=== PERFORMANCE BY STRENGTH ===');
  const { rows: byStr } = await c.query(`
    SELECT strength,
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed'
    GROUP BY strength ORDER BY strength
  `, [strat.id]);

  console.log('  Str   | Trades | WR%   | Avg Ret  | Total Ret');
  console.log('  ' + '-'.repeat(55));
  byStr.forEach(r => {
    const wr = r.total > 0 ? (r.wins / r.total * 100).toFixed(1) : '0';
    console.log('  ' + String(r.strength || '?').padStart(5) +
      ' | ' + String(r.total).padStart(6) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (r.avg_ret >= 0 ? '+' : '') + (+r.avg_ret).toFixed(4) + '%' +
      ' | ' + (r.total_ret >= 0 ? '+' : '') + (+r.total_ret).toFixed(1) + '%');
  });

  // Breakdown by direction
  console.log('\n=== PERFORMANCE BY DIRECTION ===');
  const { rows: byDir } = await c.query(`
    SELECT direction,
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed'
    GROUP BY direction ORDER BY direction
  `, [strat.id]);

  console.log('  Dir   | Trades | WR%   | Avg Ret  | Total Ret');
  console.log('  ' + '-'.repeat(55));
  byDir.forEach(r => {
    const wr = r.total > 0 ? (r.wins / r.total * 100).toFixed(1) : '0';
    console.log('  ' + r.direction.padStart(5) +
      ' | ' + String(r.total).padStart(6) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (r.avg_ret >= 0 ? '+' : '') + (+r.avg_ret).toFixed(4) + '%' +
      ' | ' + (r.total_ret >= 0 ? '+' : '') + (+r.total_ret).toFixed(1) + '%');
  });

  c.release(); pool.end();
})();
