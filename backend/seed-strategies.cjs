/**
 * Seed default strategies into FracmapStrategy table.
 * Run once: node seed-strategies.cjs
 */
require('dotenv').config();
const { Client } = require('pg');

const STRATEGIES = [
  {
    name: 'Fracmap 1m Default',
    type: 'fracmap', barMinutes: 1, minStr: 1, minCyc: 55,
    spike: true, nearMiss: true, holdDiv: 4, priceExt: true,
    cycleMin: 10, cycleMax: 100, active: true,
    config: { hedging_enabled: true, max_gap: 1, hedge_mode: 'exclusive' },
  },
  {
    name: 'Fracmap 1h Default',
    type: 'fracmap', barMinutes: 60, minStr: 1, minCyc: 64,
    spike: true, nearMiss: true, holdDiv: 5, priceExt: true,
    cycleMin: 55, cycleMax: 89, active: true,
    config: { hedging_enabled: true, max_gap: 1, hedge_mode: 'exclusive' },
  },
  {
    name: 'Fracmap 1d Default',
    type: 'fracmap', barMinutes: 1440, minStr: 1, minCyc: 0,
    spike: false, nearMiss: false, holdDiv: 2, priceExt: true,
    cycleMin: 2, cycleMax: 12, active: true,
    config: { hedging_enabled: true, max_gap: 3, hedge_mode: 'exclusive' },
  },
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  for (const s of STRATEGIES) {
    // Check if one already exists for this barMinutes
    const { rows } = await c.query(
      `SELECT id FROM "FracmapStrategy" WHERE "barMinutes" = $1 AND active = true LIMIT 1`,
      [s.barMinutes]
    );
    if (rows.length) {
      console.log(`${s.name}: already exists (id=${rows[0].id}), updating config...`);
      await c.query(
        `UPDATE "FracmapStrategy" SET config = $1 WHERE id = $2`,
        [JSON.stringify(s.config), rows[0].id]
      );
      continue;
    }

    const { rows: [newStrat] } = await c.query(
      `INSERT INTO "FracmapStrategy"
       (name, type, "barMinutes", "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax", active, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [s.name, s.type, s.barMinutes, s.minStr, s.minCyc, s.spike, s.nearMiss, s.holdDiv, s.priceExt, s.cycleMin, s.cycleMax, s.active, JSON.stringify(s.config)]
    );
    console.log(`${s.name}: created (id=${newStrat.id})`);
  }

  // Update existing null-strategy signals to use the new 1m strategy
  const { rows: [strat1m] } = await c.query(
    `SELECT id FROM "FracmapStrategy" WHERE "barMinutes" = 1 AND active = true LIMIT 1`
  );
  if (strat1m) {
    const { rowCount } = await c.query(
      `UPDATE "FracmapSignal" SET "strategyId" = $1 WHERE "strategyId" IS NULL`,
      [strat1m.id]
    );
    console.log(`\nAssigned ${rowCount} orphaned signals to strategy ${strat1m.id} (1m)`);
  }

  // Verify
  const { rows: all } = await c.query(
    `SELECT id, name, "barMinutes", active, config FROM "FracmapStrategy" WHERE active = true ORDER BY "barMinutes"`
  );
  console.log('\nActive strategies:', JSON.stringify(all, null, 2));

  await c.end();
})();
