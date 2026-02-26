require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // 1. Create FeatureSnapshot table
  await c.query(`
    CREATE TABLE IF NOT EXISTS "FeatureSnapshot" (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol        TEXT NOT NULL,
      t0            TIMESTAMPTZ NOT NULL,
      version       INT NOT NULL DEFAULT 1,
      vol10         FLOAT,
      vol20         FLOAT,
      vol60         FLOAT,
      vol_ratio     FLOAT,
      trend60       FLOAT,
      pos_in_range60 FLOAT,
      persistence60 FLOAT,
      hurst         FLOAT,
      atr_compression FLOAT,
      vol_ratio_5d  FLOAT,
      pos_in_range_5d FLOAT,
      trend_5d      FLOAT,
      regime        TEXT NOT NULL DEFAULT 'unknown',
      regime_direction TEXT DEFAULT 'NONE',
      vol_state     TEXT DEFAULT 'normal',
      micro_matrix  JSONB,
      "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(symbol, t0)
    )
  `);
  console.log('1. FeatureSnapshot table created');

  await c.query('CREATE INDEX IF NOT EXISTS idx_feature_symbol_t0 ON "FeatureSnapshot"(symbol, t0 DESC)');
  await c.query('CREATE INDEX IF NOT EXISTS idx_feature_regime ON "FeatureSnapshot"(regime, "createdAt" DESC)');
  console.log('2. FeatureSnapshot indexes created');

  // 2. Create ModelRegimePerf table (with "window" quoted because it is a reserved word)
  await c.query(`
    CREATE TABLE IF NOT EXISTS "ModelRegimePerf" (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider      TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      "horizonMinutes" INT NOT NULL,
      regime        TEXT NOT NULL,
      "volState"    TEXT NOT NULL DEFAULT 'all',
      "window"      TEXT NOT NULL DEFAULT '24h',
      total         INT NOT NULL DEFAULT 0,
      "dirCorrect"  INT NOT NULL DEFAULT 0,
      mae           FLOAT DEFAULT 0,
      rmse          FLOAT DEFAULT 0,
      "avgReturn"   FLOAT DEFAULT 0,
      "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(provider, symbol, "horizonMinutes", regime, "volState", "window")
    )
  `);
  console.log('3. ModelRegimePerf table created');

  await c.query('CREATE INDEX IF NOT EXISTS idx_modelregimeperf_lookup ON "ModelRegimePerf"(provider, symbol, "horizonMinutes", regime)');
  console.log('4. ModelRegimePerf index created');

  console.log('All done!');
  await c.end();
})();
