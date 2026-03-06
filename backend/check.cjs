const {Pool} = require("pg");
require("dotenv").config({path: "../.env"});
require("dotenv").config({path: "../.env.local"});
const p = new Pool({connectionString: process.env.DATABASE_URL});
p.query('SELECT status, COUNT(*) FROM "FracmapSignal" GROUP BY status')
  .then(r => { console.log(r.rows); p.end(); });
