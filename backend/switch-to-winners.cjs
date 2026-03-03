require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  const hedgeConfig = JSON.stringify({ hedging_enabled: true, hedge_mode: 'exclusive', max_gap: 1 });

  console.log('=== Switching to winning strategies ===\n');

  // 1H: Deactivate all, reactivate C10-34 V1 with hedging
  await c.query(`UPDATE "FracmapStrategy" SET active = false WHERE "barMinutes" = 60 AND active = true`);
  const { rows: [h] } = await c.query(
    `UPDATE "FracmapStrategy" SET active = true, config = $1 WHERE name = 'Universal 60m -V1' RETURNING id, name, "cycleMin", "cycleMax"`,
    [hedgeConfig]
  );
  console.log('1H: Reactivated ' + h.name + ' C' + h.cycleMin + '-' + h.cycleMax);

  // 1D: Deactivate all, reactivate C2-12 with hedging
  await c.query(`UPDATE "FracmapStrategy" SET active = false WHERE "barMinutes" = 1440 AND active = true`);
  const { rows: [d] } = await c.query(
    `UPDATE "FracmapStrategy" SET active = true, config = $1 WHERE name = 'Universal 1D - C2-C12' AND "barMinutes" = 1440 RETURNING id, name, "cycleMin", "cycleMax"`,
    [hedgeConfig]
  );
  if (d) {
    console.log('1D: Reactivated ' + d.name + ' C' + d.cycleMin + '-' + d.cycleMax);
  } else {
    console.log('1D: C2-C12 not found, creating...');
    const { rows: [newD] } = await c.query(
      `INSERT INTO "FracmapStrategy" (name, type, "barMinutes", "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax", active, config, "createdAt", "updatedAt")
       VALUES ('Universal 1D - C2-C12', 'universal', 1440, 1, 0, false, false, 2, true, 2, 12, true, $1, now(), now()) RETURNING id, name`, [hedgeConfig]
    );
    console.log('1D: Created ' + newD.name);
  }

  // Verify
  console.log('\n=== Active strategies ===');
  const { rows: active } = await c.query(
    `SELECT name, "barMinutes", "cycleMin", "cycleMax", config FROM "FracmapStrategy" WHERE active = true ORDER BY "barMinutes"`
  );
  active.forEach(r => {
    const tf = r.barMinutes >= 1440 ? '1D' : r.barMinutes >= 60 ? '1H' : '1m';
    const hedging = r.config?.hedging_enabled ? 'HEDGED' : '';
    console.log('  ' + tf + ': ' + r.name + ' C' + r.cycleMin + '-' + r.cycleMax + ' ' + hedging);
  });

  c.release(); pool.end();
})();
