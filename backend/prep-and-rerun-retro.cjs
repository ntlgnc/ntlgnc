/**
 * NTLGNC — Prep filters and re-run retroactive application
 * 
 * 1. Undoes previous retroactive filter (restores filtered_closed → closed)
 * 2. Deactivates all filters except #1 and #3
 * 3. Ensures ATR compression filter exists and is active
 * 4. Runs retroactive filter with the clean set
 *
 * Usage: node backend/prep-and-rerun-retro.cjs
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('✗ No DATABASE_URL'); process.exit(1); }
  const masked = dbUrl.replace(/:([^@]+)@/, ':***@');
  console.log(`DB: ${masked}`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  console.log('✓ Connected\n');

  // ── Step 1: Undo previous retroactive filter ──
  console.log('═══ Step 1: Undo previous retroactive application ═══');
  const { rowCount: restored } = await client.query(`
    UPDATE "FracmapSignal"
    SET status = 'closed', filtered_by = NULL
    WHERE status = 'filtered_closed'
      AND filtered_by IS NOT NULL
  `);
  console.log(`  ✓ Restored ${restored} signals from filtered_closed → closed\n`);

  // ── Step 2: Deactivate all filters except #1 and #3 ──
  console.log('═══ Step 2: Clean up filters ═══');
  
  // Deactivate everything first
  await client.query(`UPDATE board_filters SET active = false`);
  console.log('  ✓ Deactivated all filters');

  // Reactivate only #1 and #3
  await client.query(`UPDATE board_filters SET active = true WHERE id IN (1, 3)`);
  console.log('  ✓ Reactivated filter #1 (posInRange60) and #3 (volState)');

  // ── Step 3: Ensure ATR compression filter exists ──
  // Check if we already have an ATR filter
  const { rows: atrFilters } = await client.query(
    `SELECT id FROM board_filters WHERE feature = 'atrCompression' AND active = true`
  );

  if (atrFilters.length === 0) {
    // Create a clean ATR compression filter
    const conditions = {
      rules: [
        {
          feature: "atr_compression",
          direction: "BOTH",
          max: 0.7,
          label: "Block all signals when ATR compression < 0.7 (compressed)"
        }
      ]
    };

    const { rows: [inserted] } = await client.query(
      `INSERT INTO board_filters (feature, timeframe, conditions, active, created_at, trades_passed, trades_filtered)
       VALUES ('atrCompression', 'all', $1, true, now(), 0, 0)
       RETURNING id`,
      [JSON.stringify(conditions)]
    );
    console.log(`  ✓ Created ATR compression filter as #${inserted.id}`);
  } else {
    console.log(`  ✓ ATR compression filter already active (#${atrFilters[0].id})`);
  }

  // Show current active filters
  const { rows: activeFilters } = await client.query(
    `SELECT id, feature, timeframe FROM board_filters WHERE active = true ORDER BY id`
  );
  console.log(`\n  Active filters:`);
  for (const f of activeFilters) {
    console.log(`    #${f.id} — ${f.feature} [${f.timeframe}]`);
  }

  await client.end();
  console.log('\n✓ Prep complete. Now run the retroactive filter:\n');
  console.log('  node backend/retroactive-filter.cjs --dry    (preview)');
  console.log('  node backend/retroactive-filter.cjs          (apply)\n');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
