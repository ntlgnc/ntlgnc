/**
 * NTLGNC — 1D Signal Diagnostic
 * 
 * Inspects the current state of all 1D signals in the database.
 * Does NOT modify anything — read-only.
 *
 * Usage: node backend/diagnose-1d.cjs
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('✗ No DATABASE_URL'); process.exit(1); }
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // Find the 1D strategy
  const { rows: strats } = await client.query(
    `SELECT id, name, "barMinutes", active, "createdAt", "updatedAt"
     FROM "FracmapStrategy" WHERE "barMinutes" = 1440 ORDER BY "updatedAt" DESC`
  );

  if (strats.length === 0) {
    console.log('No 1D strategy found in FracmapStrategy table.');
    await client.end();
    return;
  }

  console.log(`\n═══ 1D STRATEGIES ═══`);
  for (const s of strats) {
    console.log(`  id=${s.id}  name="${s.name}"  active=${s.active}  created=${new Date(s.createdAt).toISOString().slice(0, 10)}  updated=${new Date(s.updatedAt).toISOString().slice(0, 10)}`);
  }

  const stratId = strats[0].id;
  console.log(`\nUsing strategy: ${stratId}\n`);

  // Count signals by status
  const { rows: statusCounts } = await client.query(
    `SELECT status, COUNT(*)::int as cnt, 
            MIN("createdAt") as earliest, MAX("createdAt") as latest
     FROM "FracmapSignal" WHERE "strategyId" = $1
     GROUP BY status ORDER BY status`,
    [stratId]
  );

  console.log(`═══ SIGNAL COUNTS BY STATUS ═══`);
  let totalAll = 0;
  for (const r of statusCounts) {
    const e = r.earliest ? new Date(r.earliest).toISOString().slice(0, 16) : '-';
    const l = r.latest ? new Date(r.latest).toISOString().slice(0, 16) : '-';
    console.log(`  ${r.status.padEnd(18)} ${String(r.cnt).padStart(5)}   (${e} → ${l})`);
    totalAll += r.cnt;
  }
  console.log(`  ${'TOTAL'.padEnd(18)} ${String(totalAll).padStart(5)}`);

  // Open signals — these are the "stuck" ones
  const { rows: openSigs } = await client.query(
    `SELECT id, symbol, direction, "entryPrice", "holdBars", "createdAt", status
     FROM "FracmapSignal" WHERE "strategyId" = $1 AND status = 'open'
     ORDER BY "createdAt" ASC`,
    [stratId]
  );

  if (openSigs.length > 0) {
    console.log(`\n═══ OPEN (potentially stuck) SIGNALS ═══`);
    console.log(`  ${'ID'.padEnd(8)} ${'SYMBOL'.padEnd(12)} ${'DIR'.padEnd(6)} ${'ENTRY'.padEnd(12)} ${'HOLD'.padEnd(6)} ${'CREATED'.padEnd(20)} ${'AGE(days)'.padEnd(10)} ${'EXPIRED?'}`);
    const now = Date.now();
    for (const s of openSigs) {
      const created = new Date(s.createdAt);
      const ageDays = ((now - created.getTime()) / 86400_000).toFixed(1);
      const holdMs = (s.holdBars || 2) * 1440 * 60_000;
      const expired = (now - created.getTime()) > holdMs;
      console.log(`  ${String(s.id).slice(0,8).padEnd(8)} ${s.symbol.padEnd(12)} ${s.direction.padEnd(6)} ${String(s.entryPrice).slice(0,10).padEnd(12)} ${String(s.holdBars).padEnd(6)} ${created.toISOString().slice(0, 19).padEnd(20)} ${ageDays.padEnd(10)} ${expired ? '⚠ YES — should be closed' : 'no'}`);
    }
  }

  // Closed signals without returnPct
  const { rows: noReturn } = await client.query(
    `SELECT id, symbol, direction, "entryPrice", "exitPrice", "returnPct", "createdAt", "closedAt"
     FROM "FracmapSignal" WHERE "strategyId" = $1 AND status = 'closed' AND "returnPct" IS NULL
     ORDER BY "createdAt" ASC`,
    [stratId]
  );
  if (noReturn.length > 0) {
    console.log(`\n═══ CLOSED BUT MISSING returnPct ═══`);
    for (const s of noReturn) {
      console.log(`  ${String(s.id).slice(0,8)} ${s.symbol.padEnd(12)} ${s.direction.padEnd(6)} entry=${s.entryPrice} exit=${s.exitPrice} created=${new Date(s.createdAt).toISOString().slice(0, 10)}`);
    }
  }

  // Daily breakdown of recent signals
  const { rows: dailyBreakdown } = await client.query(
    `SELECT DATE("createdAt") as day, status, COUNT(*)::int as cnt,
            ROUND(AVG("returnPct")::numeric, 3) as avg_ret,
            ROUND(SUM("returnPct")::numeric, 3) as total_ret
     FROM "FracmapSignal" WHERE "strategyId" = $1
     GROUP BY DATE("createdAt"), status
     ORDER BY day DESC, status
     LIMIT 50`,
    [stratId]
  );

  console.log(`\n═══ DAILY BREAKDOWN (most recent first) ═══`);
  console.log(`  ${'DATE'.padEnd(12)} ${'STATUS'.padEnd(18)} ${'COUNT'.padStart(6)} ${'AVG_RET'.padStart(10)} ${'TOTAL_RET'.padStart(12)}`);
  for (const r of dailyBreakdown) {
    const day = new Date(r.day).toISOString().slice(0, 10);
    console.log(`  ${day.padEnd(12)} ${r.status.padEnd(18)} ${String(r.cnt).padStart(6)} ${String(r.avg_ret || '-').padStart(10)} ${String(r.total_ret || '-').padStart(12)}`);
  }

  // Overall return stats for closed signals
  const { rows: [retStats] } = await client.query(
    `SELECT COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
            COUNT(*) FILTER (WHERE "returnPct" <= 0)::int as losses,
            ROUND(SUM("returnPct")::numeric, 3) as cum_return,
            ROUND(AVG("returnPct")::numeric, 4) as avg_return,
            ROUND(MIN("returnPct")::numeric, 3) as worst,
            ROUND(MAX("returnPct")::numeric, 3) as best
     FROM "FracmapSignal" WHERE "strategyId" = $1 AND status = 'closed' AND "returnPct" IS NOT NULL`,
    [stratId]
  );

  if (retStats.total > 0) {
    const wr = (retStats.wins / retStats.total * 100).toFixed(1);
    console.log(`\n═══ CLOSED SIGNAL PERFORMANCE ═══`);
    console.log(`  Total:       ${retStats.total}`);
    console.log(`  Wins:        ${retStats.wins}  (${wr}%)`);
    console.log(`  Losses:      ${retStats.losses}`);
    console.log(`  Cum return:  ${retStats.cum_return}%`);
    console.log(`  Avg return:  ${retStats.avg_return}%`);
    console.log(`  Best trade:  +${retStats.best}%`);
    console.log(`  Worst trade: ${retStats.worst}%`);
  }

  // Also check: ALL strategies' signal counts to see overall picture
  const { rows: allStrats } = await client.query(`
    SELECT s."strategyId", st.name, st."barMinutes",
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE s.status = 'open')::int as open,
           COUNT(*) FILTER (WHERE s.status = 'closed')::int as closed,
           COUNT(*) FILTER (WHERE s.status = 'filtered')::int as filtered,
           COUNT(*) FILTER (WHERE s.status = 'filtered_closed')::int as filt_closed
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    GROUP BY s."strategyId", st.name, st."barMinutes"
    ORDER BY total DESC
  `);

  console.log(`\n═══ ALL STRATEGIES OVERVIEW ═══`);
  console.log(`  ${'NAME'.padEnd(30)} ${'BAR_MIN'.padStart(8)} ${'TOTAL'.padStart(7)} ${'OPEN'.padStart(6)} ${'CLOSED'.padStart(8)} ${'FILTERED'.padStart(10)} ${'FILT_CLS'.padStart(10)}`);
  for (const r of allStrats) {
    console.log(`  ${(r.name || 'null').slice(0,28).padEnd(30)} ${String(r.barMinutes || '?').padStart(8)} ${String(r.total).padStart(7)} ${String(r.open).padStart(6)} ${String(r.closed).padStart(8)} ${String(r.filtered).padStart(10)} ${String(r.filt_closed).padStart(10)}`);
  }

  await client.end();
  console.log(`\nDone.\n`);
}

main().catch(err => {
  console.error('✗ FATAL:', err);
  process.exit(1);
});
