require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "actualReturn" FLOAT');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "absError" FLOAT');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "scoredAt" TIMESTAMPTZ');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "predReturn" FLOAT');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "featureSnapshotId" UUID');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS regime TEXT');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "regimeDirection" TEXT');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "volState" TEXT');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS tags JSONB');
  await c.query('ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "promptVersion" INT DEFAULT 1');
  console.log('All columns added');
  await c.end();
})();
