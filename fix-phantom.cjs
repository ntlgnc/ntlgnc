const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://ntlgnc:Ntlgnc2026@localhost:5432/ntlgnc_db?schema=public' });

(async () => {
  const pairId = '324a09d4-e189-454f-9196-dcfd59ffde6e';

  // Get the closed leg's closedAt
  const { rows: [closedLeg] } = await pool.query(`
    SELECT "closedAt", "exitPrice" FROM "FracmapSignal"
    WHERE pair_id = $1 AND status = 'closed'
  `, [pairId]);

  if (!closedLeg) { console.log('No closed leg found'); process.exit(1); }

  // Get the 1h candle close price for DENTUSDT at the time the other leg closed
  const closeTime = closedLeg.closedAt;
  const { rows: [candle] } = await pool.query(`
    SELECT close FROM "Candle1h"
    WHERE symbol = 'DENTUSDT' AND timestamp <= $1
    ORDER BY timestamp DESC LIMIT 1
  `, [closeTime]);

  const exitPrice = candle ? candle.close : null;
  console.log('Closing DENT SHORT at:', exitPrice, 'time:', closeTime);

  // Get entry price to calculate return
  const { rows: [openLeg] } = await pool.query(`
    SELECT id, "entryPrice", direction FROM "FracmapSignal"
    WHERE pair_id = $1 AND status = 'open'
  `, [pairId]);

  let returnPct = 0;
  if (openLeg && exitPrice) {
    // SHORT: (entry - exit) / entry * 100
    returnPct = (openLeg.entryPrice / exitPrice - 1) * 100;
    // Actually for SHORT: profit when price goes down
    // returnPct = (entryPrice - exitPrice) / entryPrice * 100
    returnPct = ((openLeg.entryPrice - exitPrice) / openLeg.entryPrice) * 100;
  }
  console.log('Entry:', openLeg?.entryPrice, 'Exit:', exitPrice, 'Return:', returnPct.toFixed(4) + '%');

  // Close the phantom leg
  await pool.query(`
    UPDATE "FracmapSignal"
    SET status = 'closed', "closedAt" = $1, "exitPrice" = $2, "returnPct" = $3
    WHERE pair_id = $4 AND status = 'open'
  `, [closeTime, exitPrice, returnPct, pairId]);

  console.log('Phantom closed successfully');
  pool.end();
})();
