const {Client}=require("pg");
const c=new Client({connectionString:"postgresql://frcstr:secret123@localhost:5433/frcstr_db?schema=public"});
c.connect().then(async()=>{
  console.log("Adding indexes...");
  await c.query('CREATE INDEX IF NOT EXISTS idx_candle1m_symbol_ts ON "Candle1m" (symbol, timestamp DESC)');
  console.log("  done 1");
  await c.query('CREATE INDEX IF NOT EXISTS idx_prediction_unscored ON "Prediction" ("actualClose") WHERE "actualClose" IS NULL');
  console.log("  done 2");
  console.log("Done");
  c.end();
}).catch(e=>{console.error(e);c.end()});