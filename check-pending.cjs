const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const { rows: pending } = await c.query(`
    SELECT id, symbol, direction, status, "entryPrice", "detectedPrice", "detectedAt", "enteredAt", tick_id
    FROM "FracmapSignal" WHERE status = 'pending' ORDER BY "createdAt" DESC LIMIT 10
  `);
  console.log(`Pending signals: ${pending.length}`);
  for (const r of pending) {
    console.log(`  id=${r.id} ${r.symbol} ${r.direction} detected=${r.detectedAt} detectedPrice=${r.detectedPrice} entryPrice=${r.entryPrice} tick=${r.tick_id}`);
  }

  // Check new columns exist
  const { rows: sample } = await c.query(`
    SELECT id, "detectedAt", "enteredAt", "detectedPrice", pair_type, tick_id
    FROM "FracmapSignal" WHERE "detectedAt" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 3
  `);
  console.log(`\nSample rows with new columns:`);
  for (const r of sample) {
    console.log(`  id=${r.id} detectedAt=${r.detectedAt} enteredAt=${r.enteredAt} detectedPrice=${r.detectedPrice} pairType=${r.pair_type} tick=${r.tick_id}`);
  }

  // Check backfill worked
  const { rows: [counts] } = await c.query(`
    SELECT
      COUNT(*) FILTER (WHERE "detectedAt" IS NOT NULL) as has_detected,
      COUNT(*) FILTER (WHERE "detectedAt" IS NULL) as missing_detected,
      COUNT(*) FILTER (WHERE "enteredAt" IS NOT NULL AND status IN ('open','closed')) as has_entered,
      COUNT(*) FILTER (WHERE "enteredAt" IS NULL AND status IN ('open','closed')) as missing_entered,
      COUNT(*) FILTER (WHERE status = 'pending') as pending_total,
      COUNT(*) FILTER (WHERE status = 'expired') as expired_total
    FROM "FracmapSignal"
  `);
  console.log(`\nBackfill status:`);
  console.log(`  detectedAt set: ${counts.has_detected}, missing: ${counts.missing_detected}`);
  console.log(`  enteredAt set: ${counts.has_entered}, missing: ${counts.missing_entered}`);
  console.log(`  pending: ${counts.pending_total}, expired: ${counts.expired_total}`);

  await c.end();
})();
