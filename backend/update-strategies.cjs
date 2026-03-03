/**
 * Update active strategies to optimised cycle ranges:
 * 1m: C30-C40
 * 1h: C10-C60
 * 1d: C2-C4 (already C2-C3, widening to C4)
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  console.log('=== Updating strategy cycle ranges ===\n');

  // 1m: Deactivate existing 1m strategies, create C30-40
  const { rows: old1m } = await c.query(
    `UPDATE "FracmapStrategy" SET active = false WHERE "barMinutes" = 1 AND active = true RETURNING name`
  );
  old1m.forEach(r => console.log('  Deactivated 1m: ' + r.name));

  const { rows: [new1m] } = await c.query(
    `INSERT INTO "FracmapStrategy" (name, type, "barMinutes", "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax", active, config, "createdAt", "updatedAt")
     VALUES ($1, 'universal', 1, 1, 0, true, true, 4, true, 30, 40, true, $2, now(), now()) RETURNING id, name`,
    ['Universal 1m - C30-C40', JSON.stringify({ hedging_enabled: true, hedge_mode: 'exclusive', max_gap: 5 })]
  );
  console.log('  Created 1m: ' + new1m.name);

  // 1h: Deactivate existing, create C10-60
  const { rows: old1h } = await c.query(
    `UPDATE "FracmapStrategy" SET active = false WHERE "barMinutes" = 60 AND active = true RETURNING name`
  );
  old1h.forEach(r => console.log('  Deactivated 1h: ' + r.name));

  const { rows: [new1h] } = await c.query(
    `INSERT INTO "FracmapStrategy" (name, type, "barMinutes", "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax", active, config, "createdAt", "updatedAt")
     VALUES ($1, 'universal', 60, 1, 0, true, true, 5, true, 10, 60, true, $2, now(), now()) RETURNING id, name`,
    ['Universal 60m - C10-C60', JSON.stringify({ hedging_enabled: true, hedge_mode: 'exclusive', max_gap: 1 })]
  );
  console.log('  Created 1h: ' + new1h.name);

  // 1d: Update existing C2-C3 to C2-C4
  const { rows: upd1d } = await c.query(
    `UPDATE "FracmapStrategy" SET "cycleMax" = 4, name = 'Universal 1D - C2-C4 Optimised', "updatedAt" = now()
     WHERE "barMinutes" = 1440 AND active = true AND "cycleMin" = 2 RETURNING id, name, "cycleMin", "cycleMax"`
  );
  if (upd1d[0]) console.log('  Updated 1d: ' + upd1d[0].name + ' C' + upd1d[0].cycleMin + '-' + upd1d[0].cycleMax);

  // Verify
  console.log('\n=== Active strategies ===');
  const { rows: active } = await c.query(
    `SELECT name, "barMinutes", "cycleMin", "cycleMax" FROM "FracmapStrategy" WHERE active = true ORDER BY "barMinutes"`
  );
  active.forEach(r => {
    const tf = r.barMinutes >= 1440 ? '1D' : r.barMinutes >= 60 ? '1H' : '1m';
    console.log('  ' + tf + ': ' + r.name + ' C' + r.cycleMin + '-' + r.cycleMax);
  });

  c.release(); pool.end();
})();
