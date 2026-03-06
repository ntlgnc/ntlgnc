/**
 * NTLGNC — Filter Audit
 * 
 * Independently verifies cumulative returns with and without filters.
 * Reads directly from the database, no API dependencies.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  NTLGNC — FILTER AUDIT                                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // 1. Count signals by status
  const { rows: statusCounts } = await client.query(`
    SELECT status, COUNT(*) as count, 
           COALESCE(SUM("returnPct"), 0) as total_return
    FROM "FracmapSignal"
    GROUP BY status
    ORDER BY status
  `);
  
  console.log('═══ Signal Status Breakdown ═══');
  for (const r of statusCounts) {
    console.log(`  ${r.status.padEnd(20)} count: ${String(r.count).padStart(5)}   return: ${parseFloat(r.total_return).toFixed(2)}%`);
  }

  // 2. Closed signals (what the signals page shows)
  const { rows: [closedStats] } = await client.query(`
    SELECT COUNT(*) as count, 
           SUM("returnPct") as total_return,
           AVG("returnPct") as avg_return,
           COUNT(*) FILTER (WHERE "returnPct" > 0) as wins
    FROM "FracmapSignal"
    WHERE status = 'closed'
  `);

  console.log('\n═══ CLOSED Signals (what /signals shows) ═══');
  console.log(`  Count:      ${closedStats.count}`);
  console.log(`  Cum Return: ${parseFloat(closedStats.total_return).toFixed(2)}%`);
  console.log(`  Avg Return: ${parseFloat(closedStats.avg_return).toFixed(4)}%`);
  console.log(`  Win Rate:   ${(closedStats.wins / closedStats.count * 100).toFixed(1)}%`);

  // 3. Filtered_closed signals (blocked by retroactive filter)
  const { rows: [filteredStats] } = await client.query(`
    SELECT COUNT(*) as count, 
           SUM("returnPct") as total_return,
           AVG("returnPct") as avg_return,
           COUNT(*) FILTER (WHERE "returnPct" > 0) as wins
    FROM "FracmapSignal"
    WHERE status = 'filtered_closed'
  `);

  console.log('\n═══ FILTERED_CLOSED Signals (retroactively blocked) ═══');
  console.log(`  Count:      ${filteredStats.count}`);
  console.log(`  Cum Return: ${parseFloat(filteredStats.total_return || 0).toFixed(2)}%`);
  console.log(`  Avg Return: ${parseFloat(filteredStats.avg_return || 0).toFixed(4)}%`);
  console.log(`  Win Rate:   ${filteredStats.count > 0 ? (filteredStats.wins / filteredStats.count * 100).toFixed(1) : 0}%`);

  // 4. What it would look like WITHOUT filters (closed + filtered_closed combined)
  const { rows: [combinedStats] } = await client.query(`
    SELECT COUNT(*) as count, 
           SUM("returnPct") as total_return,
           AVG("returnPct") as avg_return,
           COUNT(*) FILTER (WHERE "returnPct" > 0) as wins
    FROM "FracmapSignal"
    WHERE status IN ('closed', 'filtered_closed')
  `);

  console.log('\n═══ COMBINED (what returns WOULD BE without filters) ═══');
  console.log(`  Count:      ${combinedStats.count}`);
  console.log(`  Cum Return: ${parseFloat(combinedStats.total_return).toFixed(2)}%`);
  console.log(`  Avg Return: ${parseFloat(combinedStats.avg_return).toFixed(4)}%`);
  console.log(`  Win Rate:   ${(combinedStats.wins / combinedStats.count * 100).toFixed(1)}%`);

  // 5. Filter impact summary
  const closedReturn = parseFloat(closedStats.total_return);
  const combinedReturn = parseFloat(combinedStats.total_return);
  const filteredReturn = parseFloat(filteredStats.total_return || 0);

  console.log('\n═══ FILTER IMPACT SUMMARY ═══');
  console.log(`  With filters:    ${closedReturn.toFixed(2)}% (${closedStats.count} trades)`);
  console.log(`  Without filters: ${combinedReturn.toFixed(2)}% (${combinedStats.count} trades)`);
  console.log(`  Improvement:     ${(closedReturn - combinedReturn).toFixed(2)}%`);
  console.log(`  Blocked return:  ${filteredReturn.toFixed(2)}% (${filteredStats.count} trades removed)`);
  console.log(`  Verdict:         ${closedReturn > combinedReturn ? '🟢 FILTERS ARE HELPING' : '🔴 FILTERS ARE HURTING'}`);

  // 6. Per-filter breakdown
  console.log('\n═══ PER-FILTER BREAKDOWN ═══');
  const { rows: perFilter } = await client.query(`
    SELECT filtered_by,
           COUNT(*) as count,
           SUM("returnPct") as total_return,
           COUNT(*) FILTER (WHERE "returnPct" > 0) as wins,
           COUNT(*) FILTER (WHERE "returnPct" <= 0) as losses
    FROM "FracmapSignal"
    WHERE status = 'filtered_closed' AND filtered_by IS NOT NULL
    GROUP BY filtered_by
    ORDER BY filtered_by
  `);

  for (const f of perFilter) {
    const ret = parseFloat(f.total_return);
    console.log(`  Filter #${f.filtered_by}: ${f.count} blocked (${f.wins}W/${f.losses}L) → return ${ret.toFixed(2)}%`);
    console.log(`    ${ret < 0 ? '🟢 HELPING (blocked losers)' : '🔴 HURTING (blocked winners)'}`);
  }

  // 7. Per-timeframe breakdown
  console.log('\n═══ PER-TIMEFRAME BREAKDOWN ═══');
  for (const [label, bm] of [['1M', 1], ['1H', 60], ['1D', 1440]]) {
    const { rows: [withF] } = await client.query(`
      SELECT COUNT(*) as count, COALESCE(SUM(s."returnPct"), 0) as total_return
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'closed' AND st."barMinutes" = $1
    `, [bm]);

    const { rows: [withoutF] } = await client.query(`
      SELECT COUNT(*) as count, COALESCE(SUM(s."returnPct"), 0) as total_return
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status IN ('closed', 'filtered_closed') AND st."barMinutes" = $1
    `, [bm]);

    const wReturn = parseFloat(withF.total_return);
    const woReturn = parseFloat(withoutF.total_return);
    console.log(`  ${label}: With filters: ${wReturn.toFixed(2)}% (${withF.count}) | Without: ${woReturn.toFixed(2)}% (${withoutF.count}) | Δ ${(wReturn - woReturn).toFixed(2)}%`);
  }

  // 8. Verify the signals page number matches
  console.log('\n═══ SIGNALS PAGE VERIFICATION ═══');
  const { rows: [pageNum] } = await client.query(`
    SELECT SUM("returnPct") as cum_return
    FROM "FracmapSignal"
    WHERE status = 'closed'
  `);
  console.log(`  /signals should show: +${parseFloat(pageNum.cum_return).toFixed(2)}%`);
  console.log(`  If it shows a different number, there's a bug.`);

  // 9. Check for any anomalies
  console.log('\n═══ ANOMALY CHECK ═══');
  const { rows: [nullReturn] } = await client.query(`
    SELECT COUNT(*) as count FROM "FracmapSignal" 
    WHERE status = 'closed' AND "returnPct" IS NULL
  `);
  console.log(`  Closed with NULL returnPct: ${nullReturn.count}`);

  const { rows: [dupCheck] } = await client.query(`
    SELECT COUNT(*) as count FROM "FracmapSignal"
    WHERE status = 'filtered_closed' AND filtered_by IS NULL
  `);
  console.log(`  Filtered_closed with NULL filtered_by: ${dupCheck.count}`);

  const { rows: [openCheck] } = await client.query(`
    SELECT COUNT(*) as count FROM "FracmapSignal" WHERE status = 'open'
  `);
  console.log(`  Currently open: ${openCheck.count}`);

  await client.end();
  console.log('\n✓ Audit complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
