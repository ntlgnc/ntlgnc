require('dotenv').config();
const {Client} = require('pg');
const c = new Client(process.env.DATABASE_URL);
c.connect().then(() => c.query('ALTER TABLE "FracmapSignal" DROP CONSTRAINT IF EXISTS "FracmapSignal_status_check"')).then(() => {console.log('Done'); c.end()}).catch(e => {console.error(e.message); c.end()});
