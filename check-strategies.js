const { Pool } = require('pg');
require('dotenv').config({ path: 'backend/.env' });
const p = new Pool({ connectionString: process.env.DATABASE_URL });
p.query('SELECT id, name, type, symbol, "barMinutes", active FROM "FracmapStrategy" ORDER BY id')
  .then(r => { console.table(r.rows); p.end(); });
