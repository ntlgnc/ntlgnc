const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Show current active filters
  const { rows: before } = await client.query(
    `SELECT id, feature, active FROM board_filters WHERE active = true ORDER BY id`
  );
  console.log('Active legacy filters BEFORE:');
  for (const f of before) console.log(`  #${f.id} ${f.feature} — active=${f.active}`);

  // Deactivate all legacy filters
  const { rowCount } = await client.query(
    `UPDATE board_filters SET active = false WHERE active = true`
  );

  console.log(`\n✓ Deactivated ${rowCount} legacy filter(s)`);
  console.log('  The filter_matrix is now the sole source of truth.');

  // Verify
  const { rows: after } = await client.query(
    `SELECT COUNT(*) as count FROM board_filters WHERE active = true`
  );
  console.log(`  Active legacy filters remaining: ${after[0].count}`);

  await client.end();
}

main().catch(err => { console.error(err.message); process.exit(1); });
