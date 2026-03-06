/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  COIN-LEVEL FILTER — TIER 1: Regime Cross-Reference             ║
 * ║                                                                  ║
 * ║  Tests whether unprofitable coins cluster in regime buckets      ║
 * ║  that our existing Hurst/Trend5d filters already block.          ║
 * ║  If so, the coin problem may solve itself without per-coin       ║
 * ║  filtering — avoiding overfitting risk.                          ║
 * ║                                                                  ║
 * ║  Usage: node backend/coin-filter-tier1-regime-crossref.cjs      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

// ── Regime bucket classifiers (same as filter-matrix-check.cjs) ──
const REGIME_CLASSIFIERS = {
  hurst: {
    label: 'Hurst Exponent',
    field: 'hurst',
    buckets: [
      { label: 'Mean-Rev (<0.45)', test: v => typeof v === 'number' && v < 0.45 },
      { label: 'Random (0.45-0.55)', test: v => typeof v === 'number' && v >= 0.45 && v <= 0.55 },
      { label: 'Trending (>0.55)', test: v => typeof v === 'number' && v > 0.55 },
    ],
  },
  trend5d: {
    label: '5-Day Trend',
    field: 'trend5d',
    buckets: [
      { label: 'Bear (<-0.3)', test: v => typeof v === 'number' && v < -0.3 },
      { label: 'Neutral (-0.3-0.3)', test: v => typeof v === 'number' && v >= -0.3 && v <= 0.3 },
      { label: 'Bull (>0.3)', test: v => typeof v === 'number' && v > 0.3 },
    ],
  },
  posInRange60: {
    label: 'Position in Range (60)',
    field: 'posInRange60',
    buckets: [
      { label: 'Bottom (<0.25)', test: v => typeof v === 'number' && v < 0.25 },
      { label: 'Middle (0.25-0.75)', test: v => typeof v === 'number' && v >= 0.25 && v <= 0.75 },
      { label: 'Top (>0.75)', test: v => typeof v === 'number' && v > 0.75 },
    ],
  },
  persistence60: {
    label: 'Persistence',
    field: 'persistence60',
    buckets: [
      { label: 'Unstable (<0.2)', test: v => typeof v === 'number' && v < 0.2 },
      { label: 'Moderate (0.2-0.5)', test: v => typeof v === 'number' && v >= 0.2 && v <= 0.5 },
      { label: 'Persistent (>0.5)', test: v => typeof v === 'number' && v > 0.5 },
    ],
  },
  volState: {
    label: 'Volatility State',
    field: 'volState',
    buckets: [
      { label: 'COMPRESSED', test: v => String(v).toUpperCase() === 'COMPRESSED' },
      { label: 'NORMAL', test: v => String(v).toUpperCase() === 'NORMAL' },
      { label: 'EXPANDING', test: v => String(v).toUpperCase() === 'EXPANDING' },
    ],
  },
  atr_compression: {
    label: 'ATR Compression',
    field: 'atr_compression',
    buckets: [
      { label: 'Compressed (<0.7)', test: v => typeof v === 'number' && v < 0.7 },
      { label: 'Normal (0.7-1.3)', test: v => typeof v === 'number' && v >= 0.7 && v <= 1.3 },
      { label: 'Expanding (>1.3)', test: v => typeof v === 'number' && v > 1.3 },
    ],
  },
};

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  TIER 1: Regime Cross-Reference — Coin Performance       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // ── Step 1: Get all closed 1M signals with regime snapshots ──
  const { rows: signals } = await client.query(`
    SELECT s.id, s.symbol, s.direction, s."returnPct", s.regime_snapshot,
           s."createdAt", s."closedAt"
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status = 'closed' AND st."barMinutes" = 1
      AND s.regime_snapshot IS NOT NULL
    ORDER BY s."createdAt"
  `);

  console.log(`  Total closed 1M signals with regime data: ${signals.length}\n`);

  if (signals.length === 0) {
    console.log('  No signals with regime_snapshot found. Exiting.');
    await client.end();
    return;
  }

  // ── Step 2: Classify coins into profitable vs unprofitable ──
  const coinPerf = {};
  for (const sig of signals) {
    const sym = sig.symbol;
    if (!coinPerf[sym]) coinPerf[sym] = { trades: 0, totalReturn: 0, wins: 0, signals: [] };
    coinPerf[sym].trades++;
    coinPerf[sym].totalReturn += parseFloat(sig.returnPct);
    if (parseFloat(sig.returnPct) > 0) coinPerf[sym].wins++;
    coinPerf[sym].signals.push(sig);
  }

  // Filter to coins with ≥5 trades for statistical relevance
  const qualifiedCoins = Object.entries(coinPerf)
    .filter(([_, p]) => p.trades >= 5)
    .sort((a, b) => a[1].totalReturn - b[1].totalReturn);

  const unprofitable = qualifiedCoins.filter(([_, p]) => p.totalReturn < 0);
  const profitable = qualifiedCoins.filter(([_, p]) => p.totalReturn >= 0);

  console.log(`  Qualified coins (≥5 trades): ${qualifiedCoins.length}`);
  console.log(`  Profitable: ${profitable.length}   Unprofitable: ${unprofitable.length}\n`);

  // ── Step 3: For each regime feature, compute the distribution of trades ──
  //    from unprofitable coins vs profitable coins across buckets
  console.log('═══ REGIME DISTRIBUTION: Unprofitable vs Profitable Coins ═══\n');
  console.log('  For each regime feature, we show what % of losing-coin trades');
  console.log('  fell into each bucket vs what % of winning-coin trades did.\n');
  console.log('  If losing coins over-index in buckets we already filter,');
  console.log('  the Hurst/Trend5d filters may already solve the coin problem.\n');

  const unprofitableSignals = unprofitable.flatMap(([_, p]) => p.signals);
  const profitableSignals = profitable.flatMap(([_, p]) => p.signals);

  for (const [featureKey, feature] of Object.entries(REGIME_CLASSIFIERS)) {
    console.log(`  ── ${feature.label} (${featureKey}) ──`);

    for (const bucket of feature.buckets) {
      const unprofInBucket = unprofitableSignals.filter(s => {
        const snap = typeof s.regime_snapshot === 'string'
          ? JSON.parse(s.regime_snapshot) : s.regime_snapshot;
        return snap && bucket.test(snap[feature.field]);
      });
      const profInBucket = profitableSignals.filter(s => {
        const snap = typeof s.regime_snapshot === 'string'
          ? JSON.parse(s.regime_snapshot) : s.regime_snapshot;
        return snap && bucket.test(snap[feature.field]);
      });

      const unprofPct = unprofitableSignals.length > 0
        ? (unprofInBucket.length / unprofitableSignals.length * 100).toFixed(1) : '0.0';
      const profPct = profitableSignals.length > 0
        ? (profInBucket.length / profitableSignals.length * 100).toFixed(1) : '0.0';

      const unprofAvgRet = unprofInBucket.length > 0
        ? (unprofInBucket.reduce((s, sig) => s + parseFloat(sig.returnPct), 0) / unprofInBucket.length).toFixed(4)
        : 'N/A';
      const profAvgRet = profInBucket.length > 0
        ? (profInBucket.reduce((s, sig) => s + parseFloat(sig.returnPct), 0) / profInBucket.length).toFixed(4)
        : 'N/A';

      const skew = parseFloat(unprofPct) - parseFloat(profPct);
      const skewLabel = skew > 5 ? ' ← LOSERS OVER-INDEX' : skew < -5 ? ' ← WINNERS OVER-INDEX' : '';

      console.log(`    ${bucket.label.padEnd(25)} Losers: ${unprofPct.padStart(5)}% (n=${String(unprofInBucket.length).padStart(4)}, avg=${unprofAvgRet}%)  Winners: ${profPct.padStart(5)}% (n=${String(profInBucket.length).padStart(4)}, avg=${profAvgRet}%)${skewLabel}`);
    }
    console.log('');
  }

  // ── Step 4: Specific analysis — would Hurst + Trend5d filters have caught the worst coins? ──
  console.log('═══ TARGETED TEST: Would existing filters have caught worst coins? ═══\n');

  const bottom10 = unprofitable.slice(0, Math.min(10, unprofitable.length));
  console.log('  Bottom 10 unprofitable coins and their regime profile at trade time:\n');

  for (const [sym, perf] of bottom10) {
    const wr = (perf.wins / perf.trades * 100).toFixed(0);
    console.log(`  ${sym.padEnd(15)} ${perf.trades} trades  ret=${perf.totalReturn.toFixed(2).padStart(8)}%  WR=${wr}%`);

    // Count how many of this coin's trades would have been blocked by
    // common regime filters (Hurst mean-reverting + bearish trend5d + compressed vol)
    let wouldBlock_hurst = 0;
    let wouldBlock_trend5d = 0;
    let wouldBlock_any = 0;
    let hasSnapshot = 0;

    for (const sig of perf.signals) {
      const snap = typeof sig.regime_snapshot === 'string'
        ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
      if (!snap) continue;
      hasSnapshot++;

      const hurstMR = typeof snap.hurst === 'number' && snap.hurst < 0.45;
      const trend5dBear = typeof snap.trend5d === 'number' && snap.trend5d < -0.3;

      // For shorts in bull trend, longs in bear trend
      const dirMismatch =
        (sig.direction === 'LONG' && trend5dBear) ||
        (sig.direction === 'SHORT' && typeof snap.trend5d === 'number' && snap.trend5d > 0.3);

      if (hurstMR) wouldBlock_hurst++;
      if (dirMismatch) wouldBlock_trend5d++;
      if (hurstMR || dirMismatch) wouldBlock_any++;
    }

    if (hasSnapshot > 0) {
      console.log(`    Regime snapshots: ${hasSnapshot}/${perf.trades}`);
      console.log(`    Would block (Hurst<0.45):    ${wouldBlock_hurst} (${(wouldBlock_hurst/hasSnapshot*100).toFixed(0)}%)`);
      console.log(`    Would block (Trend mismatch): ${wouldBlock_trend5d} (${(wouldBlock_trend5d/hasSnapshot*100).toFixed(0)}%)`);
      console.log(`    Would block (either):         ${wouldBlock_any} (${(wouldBlock_any/hasSnapshot*100).toFixed(0)}%)`);

      // Simulate filtered return
      const keptSignals = perf.signals.filter(sig => {
        const snap = typeof sig.regime_snapshot === 'string'
          ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
        if (!snap) return true;
        const hurstMR = typeof snap.hurst === 'number' && snap.hurst < 0.45;
        const dirMismatch =
          (sig.direction === 'LONG' && typeof snap.trend5d === 'number' && snap.trend5d < -0.3) ||
          (sig.direction === 'SHORT' && typeof snap.trend5d === 'number' && snap.trend5d > 0.3);
        return !(hurstMR || dirMismatch);
      });
      const keptReturn = keptSignals.reduce((s, sig) => s + parseFloat(sig.returnPct), 0);
      console.log(`    After regime filter: ${keptSignals.length} trades, ret=${keptReturn.toFixed(2)}%`);
    } else {
      console.log(`    No regime snapshots available for this coin`);
    }
    console.log('');
  }

  // ── Step 5: Aggregate — what % of losses from bottom coins are regime-explainable? ──
  console.log('═══ AGGREGATE: How much of the coin problem is regime-explainable? ═══\n');

  let totalLoss = 0;
  let regimeExplainedLoss = 0;
  let totalLossSignals = 0;
  let regimeBlockableSignals = 0;

  for (const [sym, perf] of unprofitable) {
    for (const sig of perf.signals) {
      const ret = parseFloat(sig.returnPct);
      if (ret >= 0) continue; // only count losing trades

      totalLoss += ret;
      totalLossSignals++;

      const snap = typeof sig.regime_snapshot === 'string'
        ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
      if (!snap) continue;

      const hurstMR = typeof snap.hurst === 'number' && snap.hurst < 0.45;
      const dirMismatch =
        (sig.direction === 'LONG' && typeof snap.trend5d === 'number' && snap.trend5d < -0.3) ||
        (sig.direction === 'SHORT' && typeof snap.trend5d === 'number' && snap.trend5d > 0.3);
      const compressed = String(snap.volState).toUpperCase() === 'COMPRESSED';

      if (hurstMR || dirMismatch || compressed) {
        regimeExplainedLoss += ret;
        regimeBlockableSignals++;
      }
    }
  }

  console.log(`  Total losing trades from unprofitable coins: ${totalLossSignals}`);
  console.log(`  Total loss: ${totalLoss.toFixed(2)}%`);
  console.log(`  Regime-blockable trades: ${regimeBlockableSignals} (${(regimeBlockableSignals/totalLossSignals*100).toFixed(1)}%)`);
  console.log(`  Regime-blockable loss: ${regimeExplainedLoss.toFixed(2)}% (${(regimeExplainedLoss/totalLoss*100).toFixed(1)}% of total)\n`);

  if (regimeBlockableSignals / totalLossSignals > 0.5) {
    console.log('  ✅ CONCLUSION: >50% of losing-coin trades are regime-blockable.');
    console.log('     The existing Hurst/Trend5d/Vol filters likely solve most of the coin problem.');
    console.log('     Proceed to validate with Tier 2 rolling lookback for remaining edge cases.\n');
  } else {
    console.log('  ⚠️  CONCLUSION: Regime filters only explain a minority of losing-coin trades.');
    console.log('     Per-coin filtering (Tier 2) is needed — these coins may have structural issues');
    console.log('     not captured by regime features alone.\n');
  }

  await client.end();
  console.log('✓ Tier 1 analysis complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
