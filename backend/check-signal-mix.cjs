require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();
  const { rows } = await c.query(`
    SELECT st.name, st.active, st."barMinutes", COUNT(s.id)::int as sigs,
           SUM(s."returnPct") FILTER (WHERE s.status = 'closed') as total_ret
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    GROUP BY st.id, st.name, st.active, st."barMinutes"
    ORDER BY st."barMinutes", st.active DESC
  `);
  console.log('ALL signals in DB by strategy:\n');
  rows.forEach(r => {
    const tf = r.barMinutes >= 1440 ? '1D' : r.barMinutes >= 60 ? '1H' : '1m';
    const ret = r.total_ret ? (+r.total_ret).toFixed(0) : '0';
    console.log('  ' + tf + ' ' + (r.active ? 'ACTIVE' : 'OFF   ') + ' | ' + r.name.padEnd(38) + ' | ' + String(r.sigs).padStart(6) + ' sigs | ret=' + ret + '%');
  });
  c.release(); pool.end();
})();
