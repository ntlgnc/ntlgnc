require('dotenv').config();
const { Client } = require('pg');
const { readFileSync } = require('fs');
const path = require('path');

const sql = readFileSync(path.join(__dirname, 'sql', '004_regime_and_strategy.sql'), 'utf8');

console.log('Running migration 004: Regime tagging + Strategy configs...');

const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect()
  .then(() => c.query(sql))
  .then(() => { console.log('Migration 004 complete!'); c.end(); })
  .catch(err => { console.error('Migration error:', err.message); c.end(); process.exit(1); });
