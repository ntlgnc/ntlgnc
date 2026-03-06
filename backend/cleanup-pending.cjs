const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Expire any remaining pending signals
  const r1 = await c.query(`UPDATE "FracmapSignal" SET status = 'expired', "closedAt" = now() WHERE status = 'pending'`);
  console.log('Expired pending signals:', r1.rowCount);

  // Show signal counts by status
  const r2 = await c.query(`SELECT status, count(*) FROM "FracmapSignal" GROUP BY status ORDER BY status`);
  console.log('Signal counts by status:');
  r2.rows.forEach(r => console.log(`  ${r.status}: ${r.count}`));

  await c.end();
})();
