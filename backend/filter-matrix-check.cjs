/**
 * NTLGNC — Filter Matrix Checker (3-state model)
 * 
 * Checks signals against the per-strategy filter matrix.
 * 
 * Three states per cell:
 *   locked_block → always blocked (user override)
 *   locked_pass  → always passes (user override)
 *   auto         → defers to board_votes table
 * 
 * Usage in live-signals.cjs:
 *   const { checkMatrix } = require('./filter-matrix-check.cjs');
 *   const result = await checkMatrix(client, strategyId, signal.direction, regimeSnap);
 */

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
  "Bottom (<0.25)": v => typeof v === 'number' && v < 0.25,
  "Middle (0.25-0.75)": v => typeof v === 'number' && v >= 0.25 && v <= 0.75,
  "Top (>0.75)": v => typeof v === 'number' && v > 0.75,
  "COMPRESSED": v => String(v).toUpperCase() === "COMPRESSED",
  "NORMAL": v => String(v).toUpperCase() === "NORMAL",
  "EXPANDING": v => String(v).toUpperCase() === "EXPANDING",
  "Compressed (<0.7)": v => typeof v === 'number' && v < 0.7,
  "Normal (0.7-1.3)": v => typeof v === 'number' && v >= 0.7 && v <= 1.3,
  "Expanding (>1.3)": v => typeof v === 'number' && v > 1.3,
  "Mean-Rev (<0.45)": v => typeof v === 'number' && v < 0.45,
  "Random (0.45-0.55)": v => typeof v === 'number' && v >= 0.45 && v <= 0.55,
  "Trending (>0.55)": v => typeof v === 'number' && v > 0.55,
  "Calm (<0.7)": v => typeof v === 'number' && v < 0.7,
  "Heated (>1.3)": v => typeof v === 'number' && v > 1.3,
  "Choppy (<0.47)": v => typeof v === 'number' && v < 0.47,
  "Mixed (0.47-0.55)": v => typeof v === 'number' && v >= 0.47 && v <= 0.55,
  "Clean (>0.55)": v => typeof v === 'number' && v > 0.55,
  "Down (<-0.3)": v => typeof v === 'number' && v < -0.3,
  "Flat (-0.3-0.3)": v => typeof v === 'number' && v >= -0.3 && v <= 0.3,
  "Up (>0.3)": v => typeof v === 'number' && v > 0.3,
  "Bear (<-0.3)": v => typeof v === 'number' && v < -0.3,
  "Neutral (-0.3-0.3)": v => typeof v === 'number' && v >= -0.3 && v <= 0.3,
  "Bull (>0.3)": v => typeof v === 'number' && v > 0.3,
  "Unstable (<0.2)": v => typeof v === 'number' && v < 0.2,
  "Moderate (0.2-0.5)": v => typeof v === 'number' && v >= 0.2 && v <= 0.5,
  "Persistent (>0.5)": v => typeof v === 'number' && v > 0.5,
  "Quiet (<0.7)": v => typeof v === 'number' && v < 0.7,
  "Spiking (>1.3)": v => typeof v === 'number' && v > 1.3,
  "Asia (0-8)": v => typeof v === 'number' && v < 8,
  "Europe (8-15)": v => typeof v === 'number' && v >= 8 && v < 15,
  "US (15-23)": v => typeof v === 'number' && v >= 15,
};

// Cache
let _matrixCache = null;
let _votesCache = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

async function loadAll(client) {
  const now = Date.now();
  if (_matrixCache && _votesCache && (now - _cacheTime) < CACHE_TTL) {
    return { matrixRows: _matrixCache, voteRows: _votesCache };
  }

  let matrixRows = [];
  let voteRows = [];
  try {
    const m = await client.query(`SELECT strategy_id, feature_key, bucket_label, direction, mode FROM filter_matrix`);
    matrixRows = m.rows;
  } catch {}
  try {
    const v = await client.query(`SELECT strategy_id, feature_key, bucket_label, direction, blocked FROM filter_matrix_board_votes`);
    voteRows = v.rows;
  } catch {}

  _matrixCache = matrixRows;
  _votesCache = voteRows;
  _cacheTime = now;
  return { matrixRows, voteRows };
}

async function checkMatrix(client, strategyId, direction, regimeSnap) {
  if (!regimeSnap || !strategyId) return { pass: true, blockedBy: null, reason: null };

  const { matrixRows, voteRows } = await loadAll(client);

  // Build quick lookups for this strategy+direction
  const matrixLookup = {};
  for (const r of matrixRows) {
    if (r.strategy_id === strategyId && r.direction === direction) {
      const key = `${r.feature_key}|${r.bucket_label}`;
      matrixLookup[key] = r.mode;
    }
  }
  const voteLookup = {};
  for (const r of voteRows) {
    if (r.strategy_id === strategyId && r.direction === direction) {
      const key = `${r.feature_key}|${r.bucket_label}`;
      voteLookup[key] = r.blocked;
    }
  }

  // Check each feature
  for (const [featureKey, snapField] of Object.entries(FEATURE_TO_SNAP)) {
    const snapValue = regimeSnap[snapField];
    if (snapValue === undefined || snapValue === null) continue;

    // Find which bucket this value falls into
    for (const [bucketLabel, testFn] of Object.entries(BUCKET_TESTS)) {
      if (!testFn(snapValue)) continue;

      const key = `${featureKey}|${bucketLabel}`;
      const mode = matrixLookup[key] || 'auto';

      if (mode === 'locked_pass') continue; // User forced pass — skip
      if (mode === 'locked_block') {
        return {
          pass: false,
          blockedBy: `matrix:locked:${featureKey}:${bucketLabel}:${direction}`,
          reason: `${snapField}=${typeof snapValue === 'number' ? snapValue.toFixed(3) : snapValue} in LOCKED BLOCK bucket "${bucketLabel}" for ${direction}`,
        };
      }

      // Auto — check board vote
      if (mode === 'auto' && voteLookup[key]) {
        return {
          pass: false,
          blockedBy: `matrix:board:${featureKey}:${bucketLabel}:${direction}`,
          reason: `${snapField}=${typeof snapValue === 'number' ? snapValue.toFixed(3) : snapValue} in BOARD BLOCKED bucket "${bucketLabel}" for ${direction}`,
        };
      }
    }
  }

  return { pass: true, blockedBy: null, reason: null };
}

function invalidateMatrixCache() {
  _matrixCache = null;
  _votesCache = null;
  _cacheTime = 0;
}

module.exports = { checkMatrix, invalidateMatrixCache };
