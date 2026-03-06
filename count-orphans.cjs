const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Overall paired vs orphaned breakdown
  const { rows: [summary] } = await c.query(`
    SELECT
      COUNT(*) FILTER (WHERE pair_id IS NOT NULL AND status='closed') as paired_closed,
      COUNT(*) FILTER (WHERE pair_id IS NULL AND status='closed') as orphan_closed,
      COUNT(*) FILTER (WHERE pair_id IS NOT NULL AND status='open') as paired_open,
      COUNT(*) FILTER (WHERE pair_id IS NULL AND status='open') as orphan_open,
      AVG("returnPct") FILTER (WHERE pair_id IS NOT NULL AND status='closed') as paired_avg_ret,
      AVG("returnPct") FILTER (WHERE pair_id IS NULL AND status='closed') as orphan_avg_ret,
      SUM("returnPct") FILTER (WHERE pair_id IS NOT NULL AND status='closed') as paired_total_ret,
      SUM("returnPct") FILTER (WHERE pair_id IS NULL AND status='closed') as orphan_total_ret,
      STDDEV("returnPct") FILTER (WHERE pair_id IS NOT NULL AND status='closed') as paired_stddev,
      STDDEV("returnPct") FILTER (WHERE pair_id IS NULL AND status='closed') as orphan_stddev
    FROM "FracmapSignal"
  `);

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  ORPHANED vs PAIRED SIGNAL ANALYSIS                             ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  console.log('  ALL STRATEGIES COMBINED:');
  console.log(`    Paired closed:  ${summary.paired_closed}`);
  console.log(`    Orphan closed:  ${summary.orphan_closed}`);
  console.log(`    Paired open:    ${summary.paired_open}`);
  console.log(`    Orphan open:    ${summary.orphan_open}`);
  console.log(`    Paired avg ret: ${(+summary.paired_avg_ret).toFixed(4)}%`);
  console.log(`    Orphan avg ret: ${(+summary.orphan_avg_ret).toFixed(4)}%`);
  console.log(`    Paired total ret: ${(+summary.paired_total_ret).toFixed(4)}%`);
  console.log(`    Orphan total ret: ${(+summary.orphan_total_ret).toFixed(4)}%`);
  console.log(`    Paired stddev:  ${(+summary.paired_stddev).toFixed(4)}%`);
  console.log(`    Orphan stddev:  ${(+summary.orphan_stddev).toFixed(4)}%`);

  // Break down by strategy/timeframe
  const { rows: byStrategy } = await c.query(`
    SELECT
      COALESCE(st."barMinutes", 0) as bar_minutes,
      COALESCE(st.name, 'unknown') as strategy_name,
      COUNT(*) FILTER (WHERE s.pair_id IS NOT NULL AND s.status='closed') as paired_closed,
      COUNT(*) FILTER (WHERE s.pair_id IS NULL AND s.status='closed') as orphan_closed,
      AVG(s."returnPct") FILTER (WHERE s.pair_id IS NOT NULL AND s.status='closed') as paired_avg,
      AVG(s."returnPct") FILTER (WHERE s.pair_id IS NULL AND s.status='closed') as orphan_avg,
      SUM(s."returnPct") FILTER (WHERE s.pair_id IS NULL AND s.status='closed') as orphan_total
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    GROUP BY st."barMinutes", st.name
    ORDER BY st."barMinutes"
  `);

  console.log('\n  BY STRATEGY/TIMEFRAME:');
  for (const r of byStrategy) {
    const tf = r.bar_minutes === 1 ? '1m' : r.bar_minutes === 60 ? '1h' : r.bar_minutes === 1440 ? '1d' : `${r.bar_minutes}m`;
    const total = (+r.paired_closed) + (+r.orphan_closed);
    const orphanPct = total > 0 ? ((+r.orphan_closed) / total * 100).toFixed(1) : '0';
    console.log(`\n    ${tf} (${r.strategy_name}):`);
    console.log(`      Paired: ${r.paired_closed}, Orphan: ${r.orphan_closed} (${orphanPct}% orphaned)`);
    console.log(`      Paired avg ret: ${r.paired_avg ? (+r.paired_avg).toFixed(4) : 'N/A'}%`);
    console.log(`      Orphan avg ret: ${r.orphan_avg ? (+r.orphan_avg).toFixed(4) : 'N/A'}%`);
    console.log(`      Orphan total ret: ${r.orphan_total ? (+r.orphan_total).toFixed(4) : '0'}%`);
  }

  // Direction breakdown for orphans
  const { rows: byDir } = await c.query(`
    SELECT
      s.direction,
      COUNT(*) as cnt,
      AVG(s."returnPct") as avg_ret,
      SUM(s."returnPct") as total_ret
    FROM "FracmapSignal" s
    WHERE s.pair_id IS NULL AND s.status = 'closed'
    GROUP BY s.direction
  `);

  console.log('\n  ORPHAN DIRECTION BREAKDOWN:');
  for (const r of byDir) {
    console.log(`    ${r.direction}: ${r.cnt} signals, avg ret: ${(+r.avg_ret).toFixed(4)}%, total: ${(+r.total_ret).toFixed(4)}%`);
  }

  // Show the worst and best orphan returns to understand distribution
  const { rows: worstOrphans } = await c.query(`
    SELECT s.symbol, s.direction, s."returnPct", s."createdAt", s."closedAt", s."holdBars"
    FROM "FracmapSignal" s
    WHERE s.pair_id IS NULL AND s.status = 'closed'
    ORDER BY s."returnPct" ASC
    LIMIT 10
  `);

  console.log('\n  WORST 10 ORPHAN RETURNS (hidden from hedged reporting):');
  for (const r of worstOrphans) {
    console.log(`    ${r.symbol} ${r.direction} ${(+r.returnPct).toFixed(4)}% hold=${r.holdBars} ${r.createdAt}`);
  }

  const { rows: bestOrphans } = await c.query(`
    SELECT s.symbol, s.direction, s."returnPct", s."createdAt", s."closedAt", s."holdBars"
    FROM "FracmapSignal" s
    WHERE s.pair_id IS NULL AND s.status = 'closed'
    ORDER BY s."returnPct" DESC
    LIMIT 10
  `);

  console.log('\n  BEST 10 ORPHAN RETURNS (hidden from hedged reporting):');
  for (const r of bestOrphans) {
    console.log(`    ${r.symbol} ${r.direction} ${(+r.returnPct).toFixed(4)}% hold=${r.holdBars} ${r.createdAt}`);
  }

  // What would the REAL hedged performance look like if orphans were included?
  // Paired: each pair has pair_return which is already the combined return
  // Orphans: each runs solo at full exposure
  const { rows: [pairPerf] } = await c.query(`
    SELECT
      COUNT(DISTINCT pair_id) as num_pairs,
      AVG(pair_return) as avg_pair_return,
      SUM(pair_return) / COUNT(DISTINCT pair_id) as avg_pair_return_check
    FROM "FracmapSignal"
    WHERE pair_id IS NOT NULL AND status = 'closed' AND pair_return IS NOT NULL
  `);

  console.log('\n  REPORTED vs REAL PERFORMANCE:');
  console.log(`    Reported pairs: ${pairPerf.num_pairs}, avg pair return: ${(+pairPerf.avg_pair_return).toFixed(4)}%`);
  const reportedTotal = (+pairPerf.avg_pair_return) * (+pairPerf.num_pairs);
  const orphanTotal = +summary.orphan_total_ret || 0;
  const combinedTotal = reportedTotal + orphanTotal;
  const combinedCount = (+pairPerf.num_pairs) + (+summary.orphan_closed);
  console.log(`    Reported total return (pairs only): ${reportedTotal.toFixed(4)}%`);
  console.log(`    Hidden orphan total return: ${orphanTotal.toFixed(4)}%`);
  console.log(`    REAL total return (incl orphans): ${combinedTotal.toFixed(4)}%`);
  console.log(`    Difference: ${(combinedTotal - reportedTotal).toFixed(4)}%`);

  await c.end();
})();
