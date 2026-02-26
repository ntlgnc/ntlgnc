// Migration: Add 'hedged' strategy type to FracmapStrategy
// Run: cd backend && node add-hedged-type.cjs
const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  console.log('Adding hedged strategy type...');
  try {
    await client.query(`ALTER TABLE "FracmapStrategy" DROP CONSTRAINT IF EXISTS "FracmapStrategy_type_check"`);
    await client.query(`ALTER TABLE "FracmapStrategy" ADD CONSTRAINT "FracmapStrategy_type_check" CHECK ("type" IN ('universal', 'per_coin', 'custom', 'hedged'))`);
    console.log('✓ Type constraint updated');
    await client.query(`ALTER TABLE "FracmapStrategy" ADD COLUMN IF NOT EXISTS "config" JSONB`);
    console.log('✓ Config column added');
    console.log('✅ Done');
  } catch (e) { console.error('Error:', e.message); }
  finally { client.release(); await pool.end(); }
}
run();
