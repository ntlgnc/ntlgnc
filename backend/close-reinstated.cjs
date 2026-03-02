/**
 * Close reinstated signals that have expired hold periods.
 * Looks up the historical candle at the correct exit time for each signal.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    // Get all open signals with no exit price, joined with strategy for barMinutes
    const { rows: signals } = await client.query(`
      SELECT s.id, s.symbol, s.direction, s."entryPrice", s."holdBars",
             s."createdAt", s."strategyId", st."barMinutes"
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'open' AND s."exitPrice" IS NULL
      ORDER BY s."createdAt" ASC
    `);

    console.log('Open signals with no exit price:', signals.length);

    const now = Date.now();
    let closed = 0;
    let stillOpen = 0;
    let noCandle = 0;
    let anomaly = 0;

    for (const sig of signals) {
      const holdMs = (sig.holdBars || 60) * sig.barMinutes * 60 * 1000;
      const exitTime = new Date(sig.createdAt).getTime() + holdMs;

      if (exitTime > now) {
        stillOpen++;
        continue; // Not yet expired
      }

      const entryPrice = parseFloat(sig.entryPrice);
      if (!entryPrice || entryPrice <= 0) continue;

      // Pick the right candle table
      const table = sig.barMinutes >= 1440 ? 'Candle1d'
                  : sig.barMinutes >= 60   ? 'Candle1h'
                  : 'Candle1m';

      // Look up candle at exit time
      const { rows: candles } = await client.query(
        `SELECT close, timestamp FROM "${table}"
         WHERE symbol = $1 AND timestamp <= $2
         ORDER BY timestamp DESC LIMIT 1`,
        [sig.symbol, new Date(exitTime).toISOString()]
      );

      if (candles.length === 0) {
        noCandle++;
        continue;
      }

      const exitPrice = parseFloat(candles[0].close);

      // Sanity check — >50% drift is anomalous
      const drift = Math.abs(exitPrice - entryPrice) / entryPrice;
      if (drift > 0.50) {
        anomaly++;
        console.log('  [ANOMALY] id=' + sig.id + ' ' + sig.symbol + ' drift=' + (drift * 100).toFixed(1) + '% — skipping');
        continue;
      }

      const ret = sig.direction === 'LONG'
        ? (exitPrice / entryPrice - 1) * 100
        : (entryPrice / exitPrice - 1) * 100;

      await client.query(
        `UPDATE "FracmapSignal"
         SET "exitPrice" = $1, "returnPct" = $2, status = 'closed', "closedAt" = $3
         WHERE id = $4 AND status = 'open'`,
        [exitPrice, +(ret.toFixed(4)), new Date(exitTime).toISOString(), sig.id]
      );
      closed++;

      if (closed <= 10 || closed % 20 === 0) {
        console.log('  [CLOSE] ' + sig.symbol + ' id=' + sig.id + ' dir=' + sig.direction +
          ' entry=' + entryPrice.toFixed(4) + ' exit=' + exitPrice.toFixed(4) +
          ' ret=' + ret.toFixed(4) + '% table=' + table);
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log('Closed:', closed);
    console.log('Still open (not expired):', stillOpen);
    console.log('No candle found:', noCandle);
    console.log('Anomaly (skipped):', anomaly);

  } finally {
    client.release();
    pool.end();
  }
})();
