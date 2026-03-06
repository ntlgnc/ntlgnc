/**
 * NTLGNC — Dump Board Filters
 * Read-only. Shows all active filters with full conditions.
 * Usage: node backend/dump-filters.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, feature, timeframe, conditions, active, 
            trades_passed, trades_filtered, created_at
     FROM board_filters ORDER BY id`
  );

  console.log(`\n=== ALL BOARD FILTERS (${rows.length} total) ===\n`);

  for (const f of rows) {
    const cond = typeof f.conditions === 'string' ? JSON.parse(f.conditions) : f.conditions;
    const status = f.active ? 'ACTIVE' : 'INACTIVE';
    console.log(`-- Filter #${f.id} --  ${status}`);
    console.log(`  Feature:    ${f.feature}`);
    console.log(`  Timeframe:  ${f.timeframe || 'all'}`);
    console.log(`  Passed:     ${f.trades_passed || 0}   Filtered: ${f.trades_filtered || 0}`);
    console.log(`  Created:    ${new Date(f.created_at).toISOString().slice(0, 16)}`);
    console.log(`  Conditions:`);
    console.log(JSON.stringify(cond, null, 4).split('\n').map(l => '    ' + l).join('\n'));
    console.log('');
  }

  await client.end();
}

main().catch(err => { console.error('x', err.message); process.exit(1); });
