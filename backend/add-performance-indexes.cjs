/**
 * add-performance-indexes.cjs
 * 
 * Adds indexes to dramatically speed up dashboard, analytics, and live queries.
 * Safe to run multiple times — uses IF NOT EXISTS.
 */
const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('[indexes] Connected to database\n');

  const indexes = [
    // Dashboard main query: WHERE returnPercent IS NOT NULL AND timestamp > X ORDER BY timestamp ASC
    {
      name: 'idx_prediction_scored_timestamp',
      sql: `CREATE INDEX IF NOT EXISTS idx_prediction_scored_timestamp 
            ON "Prediction" (timestamp ASC) 
            WHERE "returnPercent" IS NOT NULL`,
    },
    // Live: DISTINCT ON (symbol, provider, horizonMinutes) WHERE timestamp > X ORDER BY ... timestamp DESC
    {
      name: 'idx_prediction_latest_by_coin_provider_hz',
      sql: `CREATE INDEX IF NOT EXISTS idx_prediction_latest_by_coin_provider_hz 
            ON "Prediction" (symbol, provider, "horizonMinutes", timestamp DESC) 
            WHERE timestamp > NOW() - INTERVAL '24 hours'`,
    },
    // Analytics: GROUP BY bucket, provider, symbol, horizonMinutes WHERE returnPercent IS NOT NULL
    {
      name: 'idx_prediction_analytics_group',
      sql: `CREATE INDEX IF NOT EXISTS idx_prediction_analytics_group 
            ON "Prediction" (provider, symbol, "horizonMinutes", timestamp) 
            WHERE "returnPercent" IS NOT NULL`,
    },
    // Per-model counts: WHERE timestamp > 7 days GROUP BY provider, model
    {
      name: 'idx_prediction_provider_model_recent',
      sql: `CREATE INDEX IF NOT EXISTS idx_prediction_provider_model_recent 
            ON "Prediction" (provider, model, timestamp)`,
    },
    // Experiment stats: WHERE tags->>'tag_key' = X — GIN index on tags JSONB
    {
      name: 'idx_prediction_tags_gin',
      sql: `CREATE INDEX IF NOT EXISTS idx_prediction_tags_gin 
            ON "Prediction" USING gin (tags)`,
    },
    // Signal gate: WHERE gateBlocked = true
    {
      name: 'idx_prediction_gate_blocked',
      sql: `CREATE INDEX IF NOT EXISTS idx_prediction_gate_blocked 
            ON "Prediction" ("gateBlocked") 
            WHERE "gateBlocked" = true`,
    },
    // Candle1m: recent candles for dashboard
    {
      name: 'idx_candle1m_symbol_timestamp',
      sql: `CREATE INDEX IF NOT EXISTS idx_candle1m_symbol_timestamp 
            ON "Candle1m" (symbol, timestamp DESC)`,
    },
  ];

  let created = 0;
  let skipped = 0;

  for (const idx of indexes) {
    try {
      const start = Date.now();
      await client.query(idx.sql);
      const elapsed = Date.now() - start;
      console.log(`  ✓ ${idx.name} (${elapsed}ms)`);
      created++;
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log(`  · ${idx.name} (already exists)`);
        skipped++;
      } else {
        console.error(`  ✗ ${idx.name}: ${err.message}`);
      }
    }
  }

  // Show table sizes for reference
  const { rows } = await client.query(`
    SELECT 
      relname as table_name,
      pg_size_pretty(pg_total_relation_size(C.oid)) as total_size,
      pg_size_pretty(pg_indexes_size(C.oid)) as index_size,
      reltuples::bigint as approx_rows
    FROM pg_class C
    LEFT JOIN pg_namespace N ON N.oid = C.relnamespace
    WHERE relname IN ('Prediction', 'Candle1m', 'SignalGateRule', 'ABTest')
    AND N.nspname = 'public'
    ORDER BY pg_total_relation_size(C.oid) DESC
  `);

  console.log('\n[indexes] Table sizes:');
  console.table(rows);

  console.log(`\n[indexes] Done! ${created} created, ${skipped} already existed`);
  console.log('[indexes] Restart your frontend — queries should be much faster now');

  await client.end();
}

main().catch(err => { console.error('[indexes] Fatal:', err); process.exit(1); });
