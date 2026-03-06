/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  COIN REGIME SENSITIVITY RANKING                                 ║
 * ║                                                                  ║
 * ║  For each coin, computes:                                        ║
 * ║    - Per-feature Spearman ρ (monotonic SR across buckets)        ║
 * ║    - Per-feature Sharpe spread (best bucket SR − worst bucket)  ║
 * ║    - Overall coin quality score                                  ║
 * ║                                                                  ║
 * ║  Answers: which coins respond predictably to regime features     ║
 * ║  (filters work on them) vs which are random/noisy?              ║
 * ║                                                                  ║
 * ║  Usage: node backend/coin-regime-ranking.cjs                    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

// ── Spearman rank correlation ──
function rankArray(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
  return ranks;
}

function spearmanRho(vals1, vals2) {
  const n = vals1.length;
  if (n < 3) return null;
  const r1 = rankArray(vals1);
  const r2 = rankArray(vals2);
  let dSq = 0;
  for (let i = 0; i < n; i++) dSq += (r1[i] - r2[i]) ** 2;
  return +(1 - (6 * dSq) / (n * (n * n - 1))).toFixed(3);
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  COIN REGIME SENSITIVITY RANKING — 1M Signals                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // ═══════════════════════════════════════════════════════════
  // Step 1: Get per-coin overall performance from closed signals
  // ═══════════════════════════════════════════════════════════
  const { rows: coinPerfRows } = await client.query(`
    SELECT s.symbol,
           COUNT(*) as trades,
           SUM(s."returnPct") as total_return,
           AVG(s."returnPct") as avg_return,
           COUNT(*) FILTER (WHERE s."returnPct" > 0) as wins
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status = 'closed' AND st."barMinutes" = 1
    GROUP BY s.symbol
    HAVING COUNT(*) >= 5
    ORDER BY s.symbol
  `);

  const coinOverall = {};
  for (const r of coinPerfRows) {
    const rets = [];
    coinOverall[r.symbol] = {
      trades: parseInt(r.trades),
      totalReturn: parseFloat(r.total_return),
      avgReturn: parseFloat(r.avg_return),
      winRate: (r.wins / r.trades * 100),
    };
  }

  // Compute per-coin Sharpe from individual signals
  const { rows: allSignals } = await client.query(`
    SELECT s.symbol, s."returnPct"
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status = 'closed' AND st."barMinutes" = 1
    ORDER BY s.symbol, s."createdAt"
  `);

  const coinSignals = {};
  for (const s of allSignals) {
    if (!coinSignals[s.symbol]) coinSignals[s.symbol] = [];
    coinSignals[s.symbol].push(parseFloat(s.returnPct));
  }

  for (const [sym, rets] of Object.entries(coinSignals)) {
    if (!coinOverall[sym]) continue;
    if (rets.length < 3) { coinOverall[sym].sharpe = 0; continue; }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((a, v) => a + (v - mean) ** 2, 0) / rets.length);
    coinOverall[sym].sharpe = std > 0 ? +(mean / std * Math.sqrt(525600)).toFixed(2) : 0;
  }

  // ═══════════════════════════════════════════════════════════
  // Step 2: Get per-coin bucket Sharpes from regime_scorecard_coins
  // ═══════════════════════════════════════════════════════════
  const { rows: scorecardRows } = await client.query(`
    SELECT symbol, feature_key, direction_filter, bucket_index, bucket_label,
           oos_sharpe, oos_trades
    FROM regime_scorecard_coins
    WHERE bar_minutes = 1 AND direction_filter = 'all'
    ORDER BY symbol, feature_key, bucket_index
  `);

  // Group: coin → feature → [{ bucketIndex, sharpe, trades }]
  const coinFeatureData = {};
  for (const r of scorecardRows) {
    if (!coinFeatureData[r.symbol]) coinFeatureData[r.symbol] = {};
    if (!coinFeatureData[r.symbol][r.feature_key]) coinFeatureData[r.symbol][r.feature_key] = [];
    coinFeatureData[r.symbol][r.feature_key].push({
      bucketIndex: r.bucket_index,
      label: r.bucket_label,
      sharpe: parseFloat(r.oos_sharpe),
      trades: parseInt(r.oos_trades),
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Step 3: For each coin × feature, compute Spearman ρ and spread
  // ═══════════════════════════════════════════════════════════

  // We also need the MARKET-WIDE bucket ordering to compute Spearman
  // (rho measures if this coin's bucket ranking matches the market pattern)
  const { rows: marketRows } = await client.query(`
    SELECT feature_key, bucket_index, bucket_label, oos_sharpe, oos_trades
    FROM regime_scorecard
    WHERE bar_minutes = 1 AND direction_filter = 'all'
    ORDER BY feature_key, bucket_index
  `);

  const marketFeatureData = {};
  for (const r of marketRows) {
    if (!marketFeatureData[r.feature_key]) marketFeatureData[r.feature_key] = [];
    marketFeatureData[r.feature_key].push({
      bucketIndex: r.bucket_index,
      sharpe: parseFloat(r.oos_sharpe),
    });
  }

  // Key features to analyse (skip 'direction' — only 2 buckets, not useful for Spearman)
  const FEATURES = [
    'posInRange', 'volState', 'atrCompression', 'hurst', 'volRatio5d',
    'persistence', 'trend60', 'posInRange5d', 'trend5d', 'volCluster', 'volRatio', 'hour',
  ];

  const coinRankings = [];

  for (const [symbol, featureMap] of Object.entries(coinFeatureData)) {
    if (!coinOverall[symbol]) continue;

    const featureResults = [];
    let totalAbsRho = 0;
    let totalSpread = 0;
    let featureCount = 0;

    for (const feat of FEATURES) {
      const coinBuckets = featureMap[feat];
      const marketBuckets = marketFeatureData[feat];
      if (!coinBuckets || coinBuckets.length < 3 || !marketBuckets) continue;

      // Sort by bucket index to align
      coinBuckets.sort((a, b) => a.bucketIndex - b.bucketIndex);

      const coinSharpes = coinBuckets.map(b => b.sharpe);
      const minTrades = Math.min(...coinBuckets.map(b => b.trades));

      // Spread: best minus worst bucket Sharpe
      const spread = Math.max(...coinSharpes) - Math.min(...coinSharpes);

      // Spearman: does the coin's bucket ranking match the market's?
      const matchedMarket = coinBuckets.map(cb => {
        const mb = marketBuckets.find(m => m.bucketIndex === cb.bucketIndex);
        return mb ? mb.sharpe : 0;
      });

      const rho = spearmanRho(coinSharpes, matchedMarket);

      featureResults.push({
        feature: feat,
        rho,
        spread: +spread.toFixed(2),
        buckets: coinBuckets,
        minTrades,
      });

      if (rho !== null) {
        totalAbsRho += Math.abs(rho);
        featureCount++;
      }
      totalSpread += spread;
    }

    const avgAbsRho = featureCount > 0 ? totalAbsRho / featureCount : 0;
    const avgSpread = featureResults.length > 0 ? totalSpread / featureResults.length : 0;

    coinRankings.push({
      symbol,
      ...coinOverall[symbol],
      featureResults,
      avgAbsRho: +avgAbsRho.toFixed(3),
      avgSpread: +avgSpread.toFixed(2),
      featureCount,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4: Output rankings
  // ═══════════════════════════════════════════════════════════

  // ── Table 1: All coins ranked by overall Sharpe ──
  console.log('═══ ALL COINS RANKED BY OVERALL SHARPE (≥5 trades) ═══\n');
  const bySharpe = [...coinRankings].sort((a, b) => b.sharpe - a.sharpe);
  console.log('  #   Symbol          Trades  Return     SR    WR%   AvgAbsρ  AvgSpread  Features');
  console.log('  ' + '─'.repeat(95));
  for (let i = 0; i < bySharpe.length; i++) {
    const c = bySharpe[i];
    console.log(`  ${String(i + 1).padStart(3)}  ${c.symbol.padEnd(15)} ${String(c.trades).padStart(5)}  ${(c.totalReturn.toFixed(2) + '%').padStart(9)}  ${c.sharpe.toFixed(2).padStart(6)}  ${c.winRate.toFixed(0).padStart(4)}%  ${c.avgAbsRho.toFixed(2).padStart(7)}  ${c.avgSpread.toFixed(1).padStart(9)}  ${c.featureCount}`);
  }

  // ── Table 2: Per-feature breakdown for top 15 and bottom 15 coins ──
  console.log('\n\n═══ FEATURE DETAIL: TOP 15 COINS (by Sharpe) ═══\n');
  for (const c of bySharpe.slice(0, 15)) {
    console.log(`  ${c.symbol} (SR=${c.sharpe}, ${c.trades} trades, ret=${c.totalReturn.toFixed(2)}%)`);
    for (const fr of c.featureResults) {
      const rhoLabel = fr.rho === null ? '  N/A' :
        Math.abs(fr.rho) >= 0.8 ? `${fr.rho >= 0 ? '+' : ''}${fr.rho.toFixed(1)} ✅` :
        Math.abs(fr.rho) >= 0.4 ? `${fr.rho >= 0 ? '+' : ''}${fr.rho.toFixed(1)} ⚡` :
                                   `${fr.rho >= 0 ? '+' : ''}${fr.rho.toFixed(1)} ❌`;
      const bucketStr = fr.buckets.map(b =>
        `${b.label.split(' ')[0]}:SR=${b.sharpe}(n=${b.trades})`
      ).join('  ');
      console.log(`    ${fr.feature.padEnd(16)} ρ=${rhoLabel.padEnd(8)} spread=${String(fr.spread).padStart(5)}  ${bucketStr}`);
    }
    console.log('');
  }

  console.log('\n═══ FEATURE DETAIL: BOTTOM 15 COINS (by Sharpe) ═══\n');
  for (const c of bySharpe.slice(-15)) {
    console.log(`  ${c.symbol} (SR=${c.sharpe}, ${c.trades} trades, ret=${c.totalReturn.toFixed(2)}%)`);
    for (const fr of c.featureResults) {
      const rhoLabel = fr.rho === null ? '  N/A' :
        Math.abs(fr.rho) >= 0.8 ? `${fr.rho >= 0 ? '+' : ''}${fr.rho.toFixed(1)} ✅` :
        Math.abs(fr.rho) >= 0.4 ? `${fr.rho >= 0 ? '+' : ''}${fr.rho.toFixed(1)} ⚡` :
                                   `${fr.rho >= 0 ? '+' : ''}${fr.rho.toFixed(1)} ❌`;
      const bucketStr = fr.buckets.map(b =>
        `${b.label.split(' ')[0]}:SR=${b.sharpe}(n=${b.trades})`
      ).join('  ');
      console.log(`    ${fr.feature.padEnd(16)} ρ=${rhoLabel.padEnd(8)} spread=${String(fr.spread).padStart(5)}  ${bucketStr}`);
    }
    console.log('');
  }

  // ── Table 3: Coins where filters are most/least predictive ──
  console.log('\n═══ COINS RANKED BY REGIME SENSITIVITY (AvgAbsρ) ═══\n');
  console.log('  High AvgAbsρ = regime features predict this coin well (filters work)');
  console.log('  Low AvgAbsρ  = coin performance is random w.r.t. regime (filters useless)\n');

  const byRho = [...coinRankings].filter(c => c.featureCount >= 5)
    .sort((a, b) => b.avgAbsRho - a.avgAbsRho);

  console.log('  #   Symbol          Trades  SR      AvgAbsρ  AvgSpread  Verdict');
  console.log('  ' + '─'.repeat(75));
  for (let i = 0; i < byRho.length; i++) {
    const c = byRho[i];
    const verdict = c.avgAbsRho >= 0.6 ? '✅ Filters work well' :
                    c.avgAbsRho >= 0.35 ? '⚡ Moderate sensitivity' :
                                          '❌ Regime-blind';
    console.log(`  ${String(i + 1).padStart(3)}  ${c.symbol.padEnd(15)} ${String(c.trades).padStart(5)}  ${c.sharpe.toFixed(2).padStart(6)}  ${c.avgAbsRho.toFixed(2).padStart(7)}  ${c.avgSpread.toFixed(1).padStart(9)}  ${verdict}`);
  }

  // ── Table 4: Actionable summary ──
  console.log('\n\n═══ ACTIONABLE SUMMARY ═══\n');

  const regimeBlind = byRho.filter(c => c.avgAbsRho < 0.35 && c.sharpe < 0);
  const regimeSensitive = byRho.filter(c => c.avgAbsRho >= 0.6 && c.sharpe > 0);
  const lowSR_highRho = byRho.filter(c => c.avgAbsRho >= 0.5 && c.sharpe < 0);

  console.log(`  REGIME-BLIND LOSERS (AvgAbsρ<0.35, SR<0) — ${regimeBlind.length} coins`);
  console.log('  These lose money AND filters can\'t help them. Best candidates for exclusion.');
  for (const c of regimeBlind) {
    console.log(`    ${c.symbol.padEnd(15)} SR=${c.sharpe.toFixed(2).padStart(6)}  ρ=${c.avgAbsRho.toFixed(2)}  ${c.trades} trades  ret=${c.totalReturn.toFixed(2)}%`);
  }

  console.log(`\n  REGIME-SENSITIVE WINNERS (AvgAbsρ≥0.6, SR>0) — ${regimeSensitive.length} coins`);
  console.log('  These are profitable AND respond well to regime filtering. Keep and trust filters.');
  for (const c of regimeSensitive) {
    console.log(`    ${c.symbol.padEnd(15)} SR=${c.sharpe.toFixed(2).padStart(6)}  ρ=${c.avgAbsRho.toFixed(2)}  ${c.trades} trades  ret=${c.totalReturn.toFixed(2)}%`);
  }

  console.log(`\n  REGIME-SENSITIVE LOSERS (AvgAbsρ≥0.5, SR<0) — ${lowSR_highRho.length} coins`);
  console.log('  These lose money BUT regime features predict their performance.');
  console.log('  Better filtering (not exclusion) might fix them.');
  for (const c of lowSR_highRho) {
    console.log(`    ${c.symbol.padEnd(15)} SR=${c.sharpe.toFixed(2).padStart(6)}  ρ=${c.avgAbsRho.toFixed(2)}  ${c.trades} trades  ret=${c.totalReturn.toFixed(2)}%`);
    // Show which feature has the strongest signal for this coin
    const best = c.featureResults
      .filter(f => f.rho !== null)
      .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))[0];
    if (best) {
      console.log(`      Best feature: ${best.feature} (ρ=${best.rho}, spread=${best.spread})`);
    }
  }

  await client.end();
  console.log('\n✓ Coin regime ranking complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
