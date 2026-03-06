const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  FILTER OPPORTUNITY ANALYSIS — 1M Sharpe Improvement     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // ═══════════════════════════════════════
  // APPROACH 3: Reliable features (ρ=1) with blockable buckets
  // ═══════════════════════════════════════
  console.log('═══ APPROACH 3: ρ=1.0 features for 1M with negative SR buckets ═══\n');
  console.log('  These are statistically reliable features where we can block');
  console.log('  specific buckets that have negative Sharpe Ratios.\n');

  const { rows: reliable } = await client.query(`
    SELECT feature_key, direction_filter, rho, bucket_index, bucket_label,
           oos_sharpe, oos_trades, oos_win_rate, oos_avg_ret, spread
    FROM regime_scorecard
    WHERE bar_minutes = 1 
      AND ABS(rho) = 1
      AND direction_filter IN ('long', 'short')
    ORDER BY direction_filter, spread DESC, feature_key, bucket_index
  `);

  let lastDir = '';
  let lastFeat = '';
  for (const r of reliable) {
    if (r.direction_filter !== lastDir) {
      console.log(`\n  ── ${r.direction_filter.toUpperCase()} (ρ=1.0 features) ──`);
      lastDir = r.direction_filter;
      lastFeat = '';
    }
    if (r.feature_key !== lastFeat) {
      console.log(`\n  ${r.feature_key} (spread=${r.spread}, ρ=${r.rho})`);
      lastFeat = r.feature_key;
    }
    const blockable = r.oos_sharpe < 0 ? ' ← 🎯 BLOCK CANDIDATE' : '';
    console.log(`    bucket ${r.bucket_index} "${r.bucket_label}" SR=${String(r.oos_sharpe).padStart(7)} n=${String(r.oos_trades).padStart(5)} WR=${r.oos_win_rate}% AvgR=${r.oos_avg_ret}%${blockable}`);
  }

  // ═══════════════════════════════════════
  // APPROACH 2: 1H reliable buckets that could apply to 1M
  // ═══════════════════════════════════════
  console.log('\n\n═══ APPROACH 2: 1H ρ=1.0 features (could cross-apply to 1M) ═══\n');

  const { rows: reliable1h } = await client.query(`
    SELECT feature_key, direction_filter, rho, bucket_index, bucket_label,
           oos_sharpe, oos_trades, oos_win_rate, oos_avg_ret, spread
    FROM regime_scorecard
    WHERE bar_minutes = 60 
      AND ABS(rho) = 1
      AND direction_filter IN ('long', 'short')
    ORDER BY direction_filter, spread DESC, feature_key, bucket_index
  `);

  lastDir = '';
  lastFeat = '';
  for (const r of reliable1h) {
    if (r.direction_filter !== lastDir) {
      console.log(`\n  ── ${r.direction_filter.toUpperCase()} (1H ρ=1.0 features) ──`);
      lastDir = r.direction_filter;
      lastFeat = '';
    }
    if (r.feature_key !== lastFeat) {
      console.log(`\n  ${r.feature_key} (spread=${r.spread}, ρ=${r.rho})`);
      lastFeat = r.feature_key;
    }
    const blockable = r.oos_sharpe < 0 ? ' ← 🎯 BLOCK CANDIDATE' : '';
    console.log(`    bucket ${r.bucket_index} "${r.bucket_label}" SR=${String(r.oos_sharpe).padStart(7)} n=${String(r.oos_trades).padStart(5)} WR=${r.oos_win_rate}% AvgR=${r.oos_avg_ret}%${blockable}`);
  }

  // ═══════════════════════════════════════
  // APPROACH 1: Per-coin performance
  // ═══════════════════════════════════════
  console.log('\n\n═══ APPROACH 1: Per-coin SR for 1M (top & bottom coins) ═══\n');

  try {
    const { rows: coins } = await client.query(`
      SELECT coin, oos_sharpe, oos_trades, oos_win_rate, oos_avg_ret
      FROM regime_scorecard_coins
      WHERE bar_minutes = 1 AND feature_key = 'posInRange' AND bucket_index = 0
        AND direction_filter = 'all'
      ORDER BY oos_sharpe DESC
    `);

    if (coins.length > 0) {
      console.log('  Top 10 coins (highest SR in posInRange Bottom bucket):');
      for (const c of coins.slice(0, 10)) {
        console.log(`    ${c.coin.padEnd(15)} SR=${String(c.oos_sharpe).padStart(7)} n=${String(c.oos_trades).padStart(4)} WR=${c.oos_win_rate}%`);
      }
      console.log('\n  Bottom 10 coins (worst SR):');
      for (const c of coins.slice(-10)) {
        console.log(`    ${c.coin.padEnd(15)} SR=${String(c.oos_sharpe).padStart(7)} n=${String(c.oos_trades).padStart(4)} WR=${c.oos_win_rate}%`);
      }
    } else {
      console.log('  No per-coin data available in regime_scorecard_coins');
    }
  } catch (err) {
    console.log('  regime_scorecard_coins table not available:', err.message);
  }

  // Alternative: check per-coin from signals directly
  console.log('\n  Per-coin from closed 1M signals directly:');
  const { rows: coinPerf } = await client.query(`
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
    ORDER BY SUM(s."returnPct") DESC
  `);

  const stdCalc = (arr) => {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a,b) => a+b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a,v) => a + (v-m)**2, 0) / arr.length);
  };

  console.log('\n  Top 15 coins by total return (≥5 trades):');
  for (const c of coinPerf.slice(0, 15)) {
    const avg = parseFloat(c.avg_return);
    const wr = (c.wins / c.trades * 100).toFixed(0);
    console.log(`    ${c.symbol.padEnd(15)} ${String(c.trades).padStart(4)} trades  ret=${parseFloat(c.total_return).toFixed(2).padStart(8)}%  avg=${avg.toFixed(3).padStart(7)}%  WR=${wr}%`);
  }

  console.log('\n  Bottom 15 coins (worst performers):');
  for (const c of coinPerf.slice(-15)) {
    const avg = parseFloat(c.avg_return);
    const wr = (c.wins / c.trades * 100).toFixed(0);
    console.log(`    ${c.symbol.padEnd(15)} ${String(c.trades).padStart(4)} trades  ret=${parseFloat(c.total_return).toFixed(2).padStart(8)}%  avg=${avg.toFixed(3).padStart(7)}%  WR=${wr}%`);
  }

  // Summary stats
  const totalCoins = coinPerf.length;
  const profitable = coinPerf.filter(c => parseFloat(c.total_return) > 0).length;
  const unprofitable = totalCoins - profitable;
  console.log(`\n  Summary: ${totalCoins} coins with ≥5 trades: ${profitable} profitable, ${unprofitable} unprofitable`);

  // What if we only kept profitable coins?
  const profitableReturn = coinPerf.filter(c => parseFloat(c.total_return) > 0)
    .reduce((s, c) => s + parseFloat(c.total_return), 0);
  const allReturn = coinPerf.reduce((s, c) => s + parseFloat(c.total_return), 0);
  const profitableTrades = coinPerf.filter(c => parseFloat(c.total_return) > 0)
    .reduce((s, c) => s + parseInt(c.trades), 0);
  const allTrades = coinPerf.reduce((s, c) => s + parseInt(c.trades), 0);

  console.log(`\n  If we only traded profitable coins:`);
  console.log(`    Return: ${profitableReturn.toFixed(2)}% from ${profitableTrades} trades`);
  console.log(`    vs All: ${allReturn.toFixed(2)}% from ${allTrades} trades`);
  console.log(`    Improvement: +${(profitableReturn - allReturn).toFixed(2)}%`);

  await client.end();
  console.log('\n✓ Analysis complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
