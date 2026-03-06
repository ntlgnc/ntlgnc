require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(`DELETE FROM "FracmapSignal" WHERE pair_type = 'backfill'`);
  console.log('Deleted ' + r.rowCount + ' backfill signals');
  await c.end();
})();
