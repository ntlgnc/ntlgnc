const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://ntlgnc:Ntlgnc2026@localhost:5432/ntlgnc_db?schema=public' });

(async () => {
  // Check what scanner/backtest tables exist
  const { rows: tables } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
    AND (table_name ILIKE '%scan%' OR table_name ILIKE '%backtest%' OR table_name ILIKE '%oos%' OR table_name ILIKE '%sample%')
  `);
  console.log('Scanner-related tables:', tables.map(t => t.table_name));

  // Check FracmapStrategy columns
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='FracmapStrategy' ORDER BY ordinal_position
  `);
  console.log('\nFracmapStrategy columns:');
  for (const c of cols) console.log(`  ${c.column_name} (${c.data_type})`);

  // Check if there's IS/OOS data in strategy
  const { rows: strats } = await pool.query(`
    SELECT id, symbol, "barMinutes", "maxCycle", active,
           "isReturn", "oosReturn", "isWinRate", "oosWinRate", "isTrades", "oosTrades",
           "isSharpe", "oosSharpe"
    FROM "FracmapStrategy"
    LIMIT 5
  `).catch(() => ({ rows: [] }));

  if (strats.length) {
    console.log('\nSample strategies with IS/OOS fields:');
    for (const s of strats) console.log(JSON.stringify(s));
  }

  // Check all column names that contain 'is' or 'oos' or 'sample'
  const { rows: isoosCols } = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='FracmapStrategy'
    AND (column_name ILIKE '%oos%' OR column_name ILIKE '%sample%' OR column_name ILIKE '%backtest%' OR column_name ILIKE '%sharpe%' OR column_name ILIKE '%trades%' OR column_name ILIKE '%return%' OR column_name ILIKE '%win%')
    ORDER BY column_name
  `);
  console.log('\nIS/OOS related columns in FracmapStrategy:');
  for (const c of isoosCols) console.log(`  ${c.column_name} (${c.data_type})`);

  // Count strategies with IS/OOS data
  const { rows: counts } = await pool.query(`
    SELECT COUNT(*) as total,
           COUNT("isReturn") as with_is,
           COUNT("oosReturn") as with_oos
    FROM "FracmapStrategy"
  `).catch(() => ({ rows: [{ total: 0, with_is: 0, with_oos: 0 }] }));
  console.log('\nStrategy counts:', counts[0]);

  pool.end();
})();
