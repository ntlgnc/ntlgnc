require('dotenv').config();
const { Client } = require('pg');
const c = new Client(process.env.DATABASE_URL);
c.connect()
  .then(() => c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION'))
  .then(() => { console.log('✅ confidence column added'); c.end(); })
  .catch(e => { console.error(e); c.end(); });
