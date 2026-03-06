require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
p.query('SELECT status, COUNT(*) FROM "FracmapSignal" GROUP BY status')
  .then(r => { console.log(r.rows); p.end(); });
