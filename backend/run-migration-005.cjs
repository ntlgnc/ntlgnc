/**
 * run-migration-005.cjs — Runs the feature engine migration
 *
 * Usage: node run-migration-005.cjs
 */

require('dotenv').config();
const { Client } = require('pg');
const { readFileSync } = require('fs');
const path = require('path');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('[migration-005] Running feature engine migration...');

  try {
    const sql = readFileSync(path.join(__dirname, 'sql', '005_feature_engine.sql'), 'utf8');

    // Split on semicolons and run each statement
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await client.query(stmt);
        // Log first 60 chars of each statement
        const preview = stmt.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`  ✓ ${preview}...`);
      } catch (err) {
        // IF NOT EXISTS / ADD COLUMN IF NOT EXISTS might produce non-fatal errors
        if (err.message.includes('already exists') || err.message.includes('duplicate')) {
          console.log(`  ⊘ Already exists: ${stmt.slice(0, 50)}...`);
        } else {
          console.error(`  ✗ Error: ${err.message}`);
          console.error(`    Statement: ${stmt.slice(0, 100)}...`);
        }
      }
    }

    console.log('[migration-005] Done!');
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error('[migration-005] Fatal:', err);
  process.exit(1);
});
