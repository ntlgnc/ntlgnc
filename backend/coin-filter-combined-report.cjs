/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  COIN-LEVEL FILTER — Combined Analysis Report                    ║
 * ║                                                                  ║
 * ║  Runs all three tiers of investigation and produces a            ║
 * ║  consolidated recommendation.                                    ║
 * ║                                                                  ║
 * ║  Usage: node backend/coin-filter-combined-report.cjs            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

// ── Regime classifiers (same as Tier 1) ──
const REGIME_CLASSIFIERS = {
  hurst: {
    field: 'hurst',
    buckets: [
      { label: 'Mean-Rev (<0.45)', test: v => typeof v === 'number' && v < 0.45 },
      { label: 'Random (0.45-0.55)', test: v => typeof v === 'number' && v >= 0.45 && v <= 0.55 },
      { label: 'Trending (>0.55)', test: v => typeof v === 'number' && v > 0.55 },
    ],
  },
  trend5d: {
    field: 'trend5d',
    buckets: [
      { label: 'Bear (<-0.3)', test: v => typeof v === 'number' && v < -0.3 },
      { label: 'Neutral', test: v => typeof v === 'number' && v >= -0.3 && v <= 0.3 },
      { label: 'Bull (>0.3)', test: v => typeof v === 'number' && v > 0.3 },
    ],
  },
};

const STABLECOIN_PATTERNS = [
  /^USD[TCSD]/i, /^DAI/i, /^TUSD/i, /^BUSD/i, /^FDUSD/i,
  /^PYUSD/i, /^USDD/i, /^GUSD/i, /^PAX(?!G)/i, /^USD1/i,
];

function computeSharpe(returns) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, v) => a + (v - mean) ** 2, 0) / (returns.length - 1);
  return variance === 0 ? 0 : (mean / Math.sqrt(variance)) * Math.sqrt(252);
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  COIN-LEVEL FILTERING — COMBINED ANALYSIS REPORT            ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║  Tests 3 approaches to filtering unprofitable coins:         ║');
  console.log('║    Tier 1: Regime cross-reference (do filters already help?) ║');
  console.log('║    Tier 2: Rolling quality gate (adaptive per-coin filter)   ║');
  console.log('║    Tier 3: Static exclusions (structural outliers)           ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  // ══════════════════════════════════════════
  // BASELINE: Current unfiltered performance
  // ══════════════════════════════════════════
  const { rows: allSignals } = await client.query(`
    SELECT s.id, s.symbol, s.direction, s."returnPct", s.regime_snapshot,
           s."createdAt", s."closedAt", s.status
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status IN ('closed', 'filtered_closed') AND st."barMinutes" = 1
    ORDER BY s."createdAt"
  `);

  const closedSignals = allSignals.filter(s => s.status === 'closed');
  const allReturns = closedSignals.map(s => parseFloat(s.returnPct));
  const totalReturn = allReturns.reduce((a, b) => a + b, 0);
  const baselineSharpe = computeSharpe(allReturns);
  const baselineWR = allReturns.filter(r => r > 0).length / allReturns.length * 100;

  console.log('═══ BASELINE (closed 1M signals) ═══');
  console.log(`  Trades:  ${closedSignals.length}`);
  console.log(`  Return:  ${totalReturn.toFixed(2)}%`);
  console.log(`  Sharpe:  ${baselineSharpe.toFixed(3)}`);
  console.log(`  Win Rate: ${baselineWR.toFixed(1)}%`);

  // Per-coin breakdown
  const coinPerf = {};
  for (const s of closedSignals) {
    if (!coinPerf[s.symbol]) coinPerf[s.symbol] = { ret: 0, trades: 0, wins: 0 };
    coinPerf[s.symbol].ret += parseFloat(s.returnPct);
    coinPerf[s.symbol].trades++;
    if (parseFloat(s.returnPct) > 0) coinPerf[s.symbol].wins++;
  }
  const qualified = Object.entries(coinPerf).filter(([_, p]) => p.trades >= 5);
  const profCoins = qualified.filter(([_, p]) => p.ret > 0);
  const lossCoins = qualified.filter(([_, p]) => p.ret <= 0);
  const lossFromBadCoins = lossCoins.reduce((s, [_, p]) => s + p.ret, 0);
  console.log(`  Coins (≥5 trades): ${qualified.length} (${profCoins.length} profitable, ${lossCoins.length} losing)`);
  console.log(`  Loss from losing coins: ${lossFromBadCoins.toFixed(2)}%`);
  console.log('');

  // ══════════════════════════════════════════
  // TIER 1: Regime cross-reference
  // ══════════════════════════════════════════
  console.log('═══ TIER 1: Regime Cross-Reference ═══\n');

  const signalsWithSnap = closedSignals.filter(s => s.regime_snapshot);
  let regimeBlockable = 0;
  let regimeBlockableReturn = 0;

  for (const sig of signalsWithSnap) {
    const snap = typeof sig.regime_snapshot === 'string'
      ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
    if (!snap) continue;

    const hurstMR = typeof snap.hurst === 'number' && snap.hurst < 0.45;
    const dirMismatch =
      (sig.direction === 'LONG' && typeof snap.trend5d === 'number' && snap.trend5d < -0.3) ||
      (sig.direction === 'SHORT' && typeof snap.trend5d === 'number' && snap.trend5d > 0.3);

    if (hurstMR || dirMismatch) {
      regimeBlockable++;
      regimeBlockableReturn += parseFloat(sig.returnPct);
    }
  }

  const tier1_keptReturns = [];
  for (const sig of closedSignals) {
    const snap = typeof sig.regime_snapshot === 'string'
      ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
    if (snap) {
      const hurstMR = typeof snap.hurst === 'number' && snap.hurst < 0.45;
      const dirMismatch =
        (sig.direction === 'LONG' && typeof snap.trend5d === 'number' && snap.trend5d < -0.3) ||
        (sig.direction === 'SHORT' && typeof snap.trend5d === 'number' && snap.trend5d > 0.3);
      if (hurstMR || dirMismatch) continue;
    }
    tier1_keptReturns.push(parseFloat(sig.returnPct));
  }

  const tier1Return = tier1_keptReturns.reduce((a, b) => a + b, 0);
  const tier1Sharpe = computeSharpe(tier1_keptReturns);

  console.log(`  Signals with regime snapshot: ${signalsWithSnap.length}/${closedSignals.length}`);
  console.log(`  Regime-blockable trades: ${regimeBlockable} (return: ${regimeBlockableReturn.toFixed(2)}%)`);
  console.log(`  After regime filter: ${tier1_keptReturns.length} trades, ${tier1Return.toFixed(2)}%, SR=${tier1Sharpe.toFixed(3)}`);
  console.log(`  Δ Sharpe: ${(tier1Sharpe - baselineSharpe).toFixed(3)}`);
  console.log(`  Verdict: ${regimeBlockableReturn < 0 ? '✅ Helps' : '⚠️  Blocking winners'}\n`);

  // ══════════════════════════════════════════
  // TIER 2: Rolling quality gate sweep
  // ══════════════════════════════════════════
  console.log('═══ TIER 2: Rolling Quality Gate (Parameter Sweep) ═══\n');

  const configs = [
    { lb: 15, wr: 30 }, { lb: 15, wr: 35 },
    { lb: 20, wr: 30 }, { lb: 20, wr: 33 }, { lb: 20, wr: 35 },
    { lb: 25, wr: 30 }, { lb: 25, wr: 35 },
  ];

  let bestTier2 = null;

  console.log('  LB  MinWR  Passed  Blocked  PassedRet  BlockedRet  PassedSR   Δ SR');
  console.log('  ' + '─'.repeat(75));

  for (const cfg of configs) {
    const coinHist = {};
    const passedRets = [];
    const blockedRets = [];

    const sorted = [...closedSignals].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    for (const sig of sorted) {
      const sym = sig.symbol;
      const ret = parseFloat(sig.returnPct);
      if (!coinHist[sym]) coinHist[sym] = [];

      let blocked = false;
      if (coinHist[sym].length >= 10) {
        const recent = coinHist[sym].slice(-cfg.lb);
        if (recent.length >= 10) {
          const wr = recent.filter(r => r > 0).length / recent.length * 100;
          if (wr < cfg.wr) blocked = true;
        }
      }

      if (blocked) blockedRets.push(ret);
      else passedRets.push(ret);

      coinHist[sym].push(ret);
    }

    const passedReturn = passedRets.reduce((a, b) => a + b, 0);
    const blockedReturn = blockedRets.reduce((a, b) => a + b, 0);
    const passedSR = computeSharpe(passedRets);
    const deltaSR = passedSR - baselineSharpe;

    console.log(`  ${String(cfg.lb).padStart(2)}  ${(cfg.wr + '%').padStart(4)}   ${String(passedRets.length).padStart(5)}  ${String(blockedRets.length).padStart(7)}  ${(passedReturn.toFixed(2) + '%').padStart(9)}  ${(blockedReturn.toFixed(2) + '%').padStart(10)}  ${passedSR.toFixed(3).padStart(8)}  ${(deltaSR >= 0 ? '+' : '') + deltaSR.toFixed(3)}`);

    if (blockedReturn < 0 && (!bestTier2 || deltaSR > bestTier2.deltaSR)) {
      bestTier2 = { ...cfg, passedReturn, blockedReturn, passedSR, deltaSR,
                    passedTrades: passedRets.length, blockedTrades: blockedRets.length };
    }
  }

  if (bestTier2) {
    console.log(`\n  🎯 Best: lookback=${bestTier2.lb}, minWR=${bestTier2.wr}%`);
    console.log(`     ${baselineSharpe.toFixed(3)} → ${bestTier2.passedSR.toFixed(3)} (Δ ${bestTier2.deltaSR.toFixed(3)})`);
    console.log(`     Blocked ${bestTier2.blockedTrades} trades worth ${bestTier2.blockedReturn.toFixed(2)}%`);
  }
  console.log('');

  // ══════════════════════════════════════════
  // TIER 3: Static exclusions
  // ══════════════════════════════════════════
  console.log('═══ TIER 3: Static Exclusion Candidates ═══\n');

  // Stablecoins
  const stables = [...new Set(closedSignals.map(s => s.symbol))]
    .filter(sym => STABLECOIN_PATTERNS.some(pat => pat.test(sym)));
  if (stables.length > 0) {
    console.log(`  Stablecoins in trade history: ${stables.join(', ')}`);
    const stableReturn = closedSignals
      .filter(s => stables.includes(s.symbol))
      .reduce((sum, s) => sum + parseFloat(s.returnPct), 0);
    console.log(`  Return from stablecoins: ${stableReturn.toFixed(2)}%`);
  } else {
    console.log('  No stablecoins found in closed trades');
  }

  // Structural losers (≥20 trades, WR<25%, return<-5%)
  const structuralLosers = qualified
    .filter(([_, p]) => p.trades >= 20 && (p.wins / p.trades) < 0.25 && p.ret < -5)
    .sort((a, b) => a[1].ret - b[1].ret);

  if (structuralLosers.length > 0) {
    console.log(`\n  Structural losers (≥20 trades, WR<25%, ret<-5%):`);
    for (const [sym, p] of structuralLosers) {
      const wr = (p.wins / p.trades * 100).toFixed(0);
      console.log(`    ${sym.padEnd(15)} ${p.trades} trades  WR=${wr}%  ret=${p.ret.toFixed(2)}%`);
    }
  }
  console.log('');

  // ══════════════════════════════════════════
  // COMBINED RECOMMENDATION
  // ══════════════════════════════════════════
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  COMBINED RECOMMENDATION                                     ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log('  1. REGIME FILTERS (Tier 1):');
  if (regimeBlockableReturn < -10) {
    console.log('     ✅ DEPLOY — regime filters capture significant coin losses');
    console.log(`     Expected recovery: ~${Math.abs(regimeBlockableReturn).toFixed(1)}% from ${regimeBlockable} blocked trades`);
  } else if (regimeBlockableReturn < 0) {
    console.log('     ⚡ PARTIAL — regime filters help but don\'t fully solve the problem');
  } else {
    console.log('     ❌ NOT SUFFICIENT — losing coins don\'t cluster in bad regime buckets');
  }

  console.log('');
  console.log('  2. ROLLING QUALITY GATE (Tier 2):');
  if (bestTier2 && bestTier2.deltaSR > 0.05) {
    console.log(`     ✅ DEPLOY — recommended config: lookback=${bestTier2.lb}, minWR=${bestTier2.wr}%`);
    console.log(`     Expected Sharpe improvement: ${bestTier2.deltaSR.toFixed(3)}`);
    console.log(`     Trades removed: ${bestTier2.blockedTrades} (${bestTier2.blockedReturn.toFixed(2)}%)`);
  } else if (bestTier2 && bestTier2.deltaSR > 0) {
    console.log(`     ⚡ MARGINAL — small improvement with lookback=${bestTier2.lb}, minWR=${bestTier2.wr}%`);
    console.log('     Consider deploying in observe-only mode first');
  } else {
    console.log('     ❌ NOT HELPFUL — rolling gate doesn\'t improve Sharpe');
  }

  console.log('');
  console.log('  3. STATIC EXCLUSIONS (Tier 3):');
  const tier3Count = stables.length + structuralLosers.length;
  if (tier3Count > 0) {
    console.log(`     ✅ DEPLOY — ${tier3Count} coins should be excluded`);
    if (stables.length > 0) console.log(`     Stablecoins: ${stables.join(', ')}`);
    if (structuralLosers.length > 0) console.log(`     Structural losers: ${structuralLosers.map(([s]) => s).join(', ')}`);
  } else {
    console.log('     ⏩ NONE NEEDED — no structural outliers detected');
  }

  console.log('');
  console.log('  DEPLOYMENT ORDER:');
  console.log('    Step 1: Deploy Tier 3 (static exclusions) — zero risk, immediate effect');
  console.log('    Step 2: Validate Tier 1 (regime filters) are active in filter matrix');
  console.log('    Step 3: Deploy Tier 2 (coin quality gate) in observe-only mode');
  console.log('    Step 4: After 48h of Tier 2 observation, activate blocking');
  console.log('');

  await client.end();
  console.log('✓ Combined analysis complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
