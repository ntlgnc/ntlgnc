/**
 * Reinstate wrongly filtered signals:
 * 1. Remove volState COMPRESSED and atrCompression Compressed matrix locks
 * 2. Change status of signals blocked by those locks from 'filtered' → 'open'
 * 3. Change status of signals blocked by filter #16 from 'filtered' → 'open'
 * 4. The existing close-expired cron will then naturally close any that have expired
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const FEATURE_TO_SNAP = {
  posInRange: 'posInRange60',
  volState: 'volState',
  atrCompression: 'atr_compression',
};

const BUCKET_TESTS = {
  "COMPRESSED": v => String(v).toUpperCase() === "COMPRESSED",
  "Compressed (<0.7)": v => typeof v === 'number' && v < 0.7,
};

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
    await client.query('BEGIN');

    // ── Step 1: Remove the 4 unsupported matrix locks ──
    console.log('=== Step 1: Remove unsupported matrix locks ===');
    for (const lock of LOCKS_TO_REMOVE) {
      const res = await client.query(
        `DELETE FROM filter_matrix
         WHERE feature_key = $1 AND bucket_label = $2 AND direction = $3 AND mode = 'locked_block'`,
        [lock.feature_key, lock.bucket_label, lock.direction]
      );
      console.log('  Removed ' + res.rowCount + ' row(s): ' + lock.feature_key + ' ' + lock.bucket_label + ' ' + lock.direction);
    }

    // ── Step 2: Identify and reinstate matrix-blocked signals ──
    console.log('\n=== Step 2: Reinstate matrix-blocked signals ===');
    const unattr = await client.query(
      `SELECT id, symbol, direction, "strategyId", status, regime_snapshot
       FROM "FracmapSignal"
       WHERE status IN ('filtered', 'filtered_closed') AND filtered_by IS NULL`
    );

    const reinstateIds = [];
    for (const sig of unattr.rows) {
      const snap = typeof sig.regime_snapshot === 'string'
        ? JSON.parse(sig.regime_snapshot)
        : sig.regime_snapshot;
      if (wouldBeBlockedByRemovedLock(snap, sig.direction)) {
        reinstateIds.push(sig.id);
      }
    }

    if (reinstateIds.length > 0) {
      // filtered → open, filtered_closed → closed
      const res1 = await client.query(
        `UPDATE "FracmapSignal" SET status = 'open' WHERE id = ANY($1) AND status = 'filtered'`,
        [reinstateIds]
      );
      const res2 = await client.query(
        `UPDATE "FracmapSignal" SET status = 'closed' WHERE id = ANY($1) AND status = 'filtered_closed'`,
        [reinstateIds]
      );
      console.log('  Reinstated ' + res1.rowCount + ' filtered → open');
      console.log('  Reinstated ' + res2.rowCount + ' filtered_closed → closed');
    } else {
      console.log('  No matrix-blocked signals to reinstate');
    }

    // ── Step 3: Reinstate filter #16 signals ──
    console.log('\n=== Step 3: Reinstate filter #16 signals ===');
    const res3 = await client.query(
      `UPDATE "FracmapSignal" SET status = 'open', filtered_by = NULL WHERE filtered_by = 16 AND status = 'filtered'`
    );
    const res4 = await client.query(
      `UPDATE "FracmapSignal" SET status = 'closed', filtered_by = NULL WHERE filtered_by = 16 AND status = 'filtered_closed'`
    );
    console.log('  Reinstated ' + res3.rowCount + ' filtered → open');
    console.log('  Reinstated ' + res4.rowCount + ' filtered_closed → closed');

    // ── Step 4: Verify ──
    console.log('\n=== Verification ===');
    const remaining = await client.query(
      "SELECT mode, COUNT(*)::int as cnt FROM filter_matrix WHERE mode = 'locked_block' GROUP BY mode"
    );
    console.log('Remaining locked_block entries:', remaining.rows);

    const locks = await client.query(
      "SELECT feature_key, bucket_label, direction FROM filter_matrix WHERE mode = 'locked_block'"
    );
    locks.rows.forEach(r => console.log('  ' + r.feature_key + ' | ' + r.bucket_label + ' | ' + r.direction));

    const openCount = await client.query(
      `SELECT COUNT(*)::int as cnt FROM "FracmapSignal" WHERE status = 'open'`
    );
    console.log('Total open signals now:', openCount.rows[0].cnt);

    await client.query('COMMIT');
    console.log('\n✓ Transaction committed successfully');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ROLLED BACK:', err.message);
  } finally {
    client.release();
    pool.end();
  }
})();
