require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();

  // Show all 1H strategies
  const { rows } = await c.query(
    `SELECT id, name, "cycleMin", "cycleMax", active FROM "FracmapStrategy" WHERE "barMinutes" = 60 ORDER BY active DESC, name`
  );
  console.log('All 1H strategies:');
  for (const r of rows) {
    const { rows: [cnt] } = await c.query(
      `SELECT COUNT(*)::int as total FROM "FracmapSignal" WHERE "strategyId" = $1`, [r.id]
    );
    console.log('  ' + (r.active ? 'ACTIVE' : 'off') + ' | ' + r.name + ' C' + r.cycleMin + '-' + r.cycleMax + ' | sigs=' + cnt.total);
  }

  // Reactivate the original C10-34 (Universal 60m -V1)
  const res1 = await c.query(
    `UPDATE "FracmapStrategy" SET active = true, config = $1 WHERE name = 'Universal 60m -V1' AND "barMinutes" = 60 RETURNING id, name`,
    [JSON.stringify({ hedging_enabled: true, hedge_mode: 'exclusive', max_gap: 1 })]
  );
  if (res1.rows[0]) console.log('\nReactivated: ' + res1.rows[0].name);

  // Deactivate C33-41
  const res2 = await c.query(
    `UPDATE "FracmapStrategy" SET active = false WHERE name = 'Universal 60m - C33-C41 Optimised' RETURNING name`
  );
  if (res2.rows[0]) console.log('Deactivated: ' + res2.rows[0].name);

  // Keep C33-41 signals for comparison but the live engine will use C10-34
  console.log('\nDone. Original C10-34 strategy reactivated for smoother 1H performance.');

  c.release(); pool.end();
})();
