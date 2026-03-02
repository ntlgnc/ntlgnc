/**
 * Audit script: assess signals to reinstate from removed filters
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const FEATURE_TO_SNAP = {
  posInRange: 'posInRange60',
  volState: 'volState',
  atrCompression: 'atr_compression',
  hurst: 'hurst',
  volRatio5d: 'volRatio5d',
  persistence: 'persistence',
  trend60: 'trend60',
  posInRange5d: 'posInRange5d',
  trend5d: 'trend5d',
  volCluster: 'volCluster',
  volRatio: 'volRatio',
  hour: 'hourOfDay',
};

const BUCKET_TESTS = {
  "COMPRESSED": v => String(v).toUpperCase() === "COMPRESSED",
  "Compressed (<0.7)": v => typeof v === 'number' && v < 0.7,
};

// The 4 locks we want to remove
const LOCKS_TO_REMOVE = [
  { feature_key: 'volState', bucket_label: 'COMPRESSED', direction: 'LONG' },
  { feature_key: 'volState', bucket_label: 'COMPRESSED', direction: 'SHORT' },
  { feature_key: 'atrCompression', bucket_label: 'Compressed (<0.7)', direction: 'LONG' },
  { feature_key: 'atrCompression', bucket_label: 'Compressed (<0.7)', direction: 'SHORT' },
];

function wouldBeBlockedByRemovedLock(regimeSnap, direction) {
  if (!regimeSnap) return false;
  for (const lock of LOCKS_TO_REMOVE) {
    if (lock.direction !== direction) continue;
    const snapField = FEATURE_TO_SNAP[lock.feature_key];
    if (!snapField) continue;
    const val = regimeSnap[snapField];
    if (val === undefined || val === null) continue;
    const testFn = BUCKET_TESTS[lock.bucket_label];
    if (testFn && testFn(val)) return true;
  }
  return false;
}

(async () => {
  const client = await pool.connect();
  try {
    // 1. Check filter #16
    console.log('=== FILTER #16 ===');
    const f16 = await client.query('SELECT id, feature, conditions, active, trades_filtered FROM board_filters WHERE id = 16');
    if (f16.rows[0]) {
      console.log(f16.rows[0]);
    } else {
      console.log('Not found in DB (may have been deleted)');
    }

    const f16sigs = await client.query(
      `SELECT status, COUNT(*)::int as cnt FROM "FracmapSignal" WHERE filtered_by = 16 GROUP BY status`
    );
    console.log('Filter #16 signals by status:', f16sigs.rows);
    const f16total = f16sigs.rows.reduce((s, r) => s + r.cnt, 0);
    console.log('Total filter #16 signals:', f16total);

    // 2. Check active matrix locks
    console.log('\n=== ACTIVE MATRIX LOCKS ===');
    const locks = await client.query(
      "SELECT strategy_id, feature_key, bucket_label, direction, mode FROM filter_matrix WHERE mode = 'locked_block'"
    );
    locks.rows.forEach(r => console.log('  ' + r.feature_key + ' | ' + r.bucket_label + ' | ' + r.direction));

    // 3. Get all unattributed filtered signals and replay
    console.log('\n=== UNATTRIBUTED FILTERED SIGNALS (replay) ===');
    const unattr = await client.query(
      `SELECT id, symbol, direction, "strategyId", status, regime_snapshot
       FROM "FracmapSignal"
       WHERE status IN ('filtered', 'filtered_closed') AND filtered_by IS NULL`
    );
    console.log('Total unattributed filtered signals:', unattr.rows.length);

    let matrixVolState = 0;
    let matrixAtrComp = 0;
    let coinGate = 0;
    let matrixPosInRange = 0;
    let matrixOther = 0;
    const reinstateIds = [];

    for (const sig of unattr.rows) {
      const snap = typeof sig.regime_snapshot === 'string'
        ? JSON.parse(sig.regime_snapshot)
        : sig.regime_snapshot;

      if (wouldBeBlockedByRemovedLock(snap, sig.direction)) {
        reinstateIds.push(sig.id);
        // Figure out which lock
        const volVal = snap ? snap[FEATURE_TO_SNAP.volState] : null;
        const atrVal = snap ? snap[FEATURE_TO_SNAP.atrCompression] : null;
        if (volVal !== null && volVal !== undefined && String(volVal).toUpperCase() === 'COMPRESSED') {
          matrixVolState++;
        } else {
          matrixAtrComp++;
        }
      } else {
        // Check if blocked by posInRange (which we're keeping)
        // or coin gate
        coinGate++; // simplified — these are either posInRange or coin gate
      }
    }

    console.log('\nAttribution of unattributed signals:');
    console.log('  volState COMPRESSED blocks:', matrixVolState);
    console.log('  atrCompression Compressed blocks:', matrixAtrComp);
    console.log('  Other (posInRange kept + coin gate):', coinGate);
    console.log('\nSignals to REINSTATE from matrix locks:', reinstateIds.length);

    // 4. Status breakdown of signals to reinstate
    if (reinstateIds.length > 0) {
      const breakdown = await client.query(
        `SELECT status, COUNT(*)::int as cnt FROM "FracmapSignal" WHERE id = ANY($1) GROUP BY status`,
        [reinstateIds]
      );
      console.log('Reinstate breakdown by status:', breakdown.rows);
    }

    // 5. Filter #16 + matrix combined
    console.log('\n=== TOTAL REINSTATEMENT PLAN ===');
    console.log('From matrix locks (volState+atrCompression):', reinstateIds.length);
    console.log('From filter #16:', f16total);
    console.log('TOTAL to reinstate:', reinstateIds.length + f16total);

  } finally {
    client.release();
    pool.end();
  }
})();
