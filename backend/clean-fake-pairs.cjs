require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Count before
  for (const pt of [null, 'natural', 'forced', 'backfill']) {
    const { rows: [r] } = await c.query(
      pt === null
        ? `SELECT COUNT(*) as cnt FROM "FracmapSignal" WHERE pair_id IS NOT NULL AND pair_type IS NULL`
        : `SELECT COUNT(*) as cnt FROM "FracmapSignal" WHERE pair_type = $1`,
      pt === null ? [] : [pt]
    );
    console.log(`pair_type=${pt}: ${r.cnt} signals`);
  }

  // Clear pair fields on non-natural pairs
  const { rowCount } = await c.query(`
    UPDATE "FracmapSignal"
    SET pair_id = NULL, pair_symbol = NULL, pair_direction = NULL, pair_return = NULL, pair_type = NULL
    WHERE pair_id IS NOT NULL AND (pair_type IS NULL OR pair_type != 'natural')
  `);
  console.log(`\nCleared pair data from ${rowCount} signals (kept only pair_type='natural')`);

  // Count after
  const { rows: [after] } = await c.query(
    `SELECT COUNT(*) as cnt, COUNT(DISTINCT pair_id) as pairs FROM "FracmapSignal" WHERE pair_id IS NOT NULL`
  );
  console.log(`Remaining: ${after.cnt} paired signals, ${after.pairs} unique pairs`);

  await c.end();
})();
