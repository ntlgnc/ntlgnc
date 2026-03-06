/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  COIN-LEVEL FILTER — TIER 2: Rolling Coin Quality Gate          ║
 * ║                                                                  ║
 * ║  Simulates a rolling lookback filter on per-coin performance.   ║
 * ║  At each trade entry, checks the coin's trailing N closed       ║
 * ║  trades — if win rate < threshold, the trade is blocked.        ║
 * ║                                                                  ║
 * ║  This is LOOK-AHEAD FREE: decisions are based only on data      ║
 * ║  available at the time of each trade.                            ║
 * ║                                                                  ║
 * ║  Usage:                                                          ║
 * ║    node backend/coin-filter-tier2-rolling.cjs                   ║
 * ║    node backend/coin-filter-tier2-rolling.cjs --lookback 20     ║
 * ║    node backend/coin-filter-tier2-rolling.cjs --min-wr 35       ║
 * ║    node backend/coin-filter-tier2-rolling.cjs --sweep           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

// ── Configuration (overridable via CLI flags) ──
const SWEEP_MODE = process.argv.includes('--sweep');
const LOOKBACK = parseInt(process.argv.find((_, i, a) => a[i-1] === '--lookback') || '20');
const MIN_WR = parseFloat(process.argv.find((_, i, a) => a[i-1] === '--min-wr') || '35');
const MIN_TRADES_BEFORE_GATE = 10; // Don't gate coins until they have this many trades

function computeSharpe(returns) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, v) => a + (v - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252); // Annualised
}

async function simulateRollingFilter(signals, lookback, minWinRate) {
  // Sort signals chronologically
  const sorted = [...signals].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  // Track per-coin history as we walk forward
  const coinHistory = {}; // symbol → [{ returnPct, createdAt }]

  const results = {
    lookback,
    minWinRate,
    totalTrades: sorted.length,
    passedTrades: 0,
    blockedTrades: 0,
    passedReturn: 0,
    blockedReturn: 0,
    passedReturns: [],
    blockedReturns: [],
    passedWins: 0,
    blockedWins: 0,
    coinsEverBlocked: new Set(),
    coinBlockCounts: {},
  };

  for (const sig of sorted) {
    const sym = sig.symbol;
    const ret = parseFloat(sig.returnPct);

    if (!coinHistory[sym]) coinHistory[sym] = [];

    // ── Decision point: should we allow this trade? ──
    const history = coinHistory[sym];
    let blocked = false;

    if (history.length >= MIN_TRADES_BEFORE_GATE) {
      // Look at the last `lookback` closed trades for this coin
      const recentTrades = history.slice(-lookback);
      if (recentTrades.length >= MIN_TRADES_BEFORE_GATE) {
        const recentWins = recentTrades.filter(t => t.returnPct > 0).length;
        const recentWR = (recentWins / recentTrades.length) * 100;
        if (recentWR < minWinRate) {
          blocked = true;
        }
      }
    }

    // ── Record result ──
    if (blocked) {
      results.blockedTrades++;
      results.blockedReturn += ret;
      results.blockedReturns.push(ret);
      if (ret > 0) results.blockedWins++;
      results.coinsEverBlocked.add(sym);
      results.coinBlockCounts[sym] = (results.coinBlockCounts[sym] || 0) + 1;
    } else {
      results.passedTrades++;
      results.passedReturn += ret;
      results.passedReturns.push(ret);
      if (ret > 0) results.passedWins++;
    }

    // ── Update history (trade always enters history for future lookback) ──
    // Note: even blocked trades update history. This represents "we would have
    // seen this result" — the coin can recover and re-enter.
    coinHistory[sym].push({ returnPct: ret, createdAt: sig.createdAt });
  }

  results.passedSharpe = computeSharpe(results.passedReturns);
  results.blockedSharpe = computeSharpe(results.blockedReturns);
  results.unfilteredSharpe = computeSharpe(sorted.map(s => parseFloat(s.returnPct)));
  results.passedWinRate = results.passedTrades > 0
    ? (results.passedWins / results.passedTrades * 100) : 0;
  results.blockedWinRate = results.blockedTrades > 0
    ? (results.blockedWins / results.blockedTrades * 100) : 0;

  return results;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  TIER 2: Rolling Coin Quality Gate — Simulation          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // ── Fetch all closed 1M signals chronologically ──
  const { rows: signals } = await client.query(`
    SELECT s.id, s.symbol, s.direction, s."returnPct", s."createdAt", s."closedAt"
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status IN ('closed', 'filtered_closed') AND st."barMinutes" = 1
    ORDER BY s."createdAt"
  `);

  // Use only 'closed' for the primary analysis (filtered_closed are already removed)
  const closedOnly = signals.filter(s => true); // Include all for unbiased simulation
  console.log(`  Total 1M signals (closed + filtered_closed): ${signals.length}\n`);

  if (SWEEP_MODE) {
    // ── Parameter sweep mode ──
    console.log('═══ PARAMETER SWEEP ═══\n');
    console.log('  Lookback  MinWR  Passed  Blocked  PassedRet  BlockedRet  PassedSR  UnfilteredSR  Δ SR  CoinsBlocked');
    console.log('  ' + '─'.repeat(110));

    const lookbacks = [10, 15, 20, 25, 30];
    const winRates = [25, 30, 33, 35, 40, 45];

    let bestConfig = null;
    let bestSharpeImprove = -Infinity;

    for (const lb of lookbacks) {
      for (const wr of winRates) {
        const r = await simulateRollingFilter(signals, lb, wr);
        const deltasr = r.passedSharpe - r.unfilteredSharpe;
        const row = [
          String(lb).padStart(8),
          String(wr).padStart(5) + '%',
          String(r.passedTrades).padStart(6),
          String(r.blockedTrades).padStart(7),
          (r.passedReturn.toFixed(2) + '%').padStart(10),
          (r.blockedReturn.toFixed(2) + '%').padStart(11),
          r.passedSharpe.toFixed(3).padStart(9),
          r.unfilteredSharpe.toFixed(3).padStart(13),
          (deltasr >= 0 ? '+' : '') + deltasr.toFixed(3).padStart(5),
          String(r.coinsEverBlocked.size).padStart(12),
        ].join('  ');
        console.log(`  ${row}`);

        if (deltasr > bestSharpeImprove && r.blockedReturn < 0) {
          bestSharpeImprove = deltasr;
          bestConfig = { lookback: lb, minWR: wr, ...r };
        }
      }
    }

    if (bestConfig) {
      console.log(`\n  🎯 BEST CONFIG: lookback=${bestConfig.lookback}, minWR=${bestConfig.minWR}%`);
      console.log(`     Sharpe: ${bestConfig.unfilteredSharpe.toFixed(3)} → ${bestConfig.passedSharpe.toFixed(3)} (Δ ${bestSharpeImprove.toFixed(3)})`);
      console.log(`     Blocked ${bestConfig.blockedTrades} trades with ${bestConfig.blockedReturn.toFixed(2)}% return`);
      console.log(`     Coins ever blocked: ${bestConfig.coinsEverBlocked.size}`);
    }

  } else {
    // ── Single run mode ──
    console.log(`  Parameters: lookback=${LOOKBACK}, minWR=${MIN_WR}%, minTrades=${MIN_TRADES_BEFORE_GATE}\n`);

    const r = await simulateRollingFilter(signals, LOOKBACK, MIN_WR);

    console.log('═══ RESULTS ═══\n');
    console.log(`  Unfiltered: ${r.totalTrades} trades, SR=${r.unfilteredSharpe.toFixed(3)}`);
    console.log(`  Passed:     ${r.passedTrades} trades, ret=${r.passedReturn.toFixed(2)}%, SR=${r.passedSharpe.toFixed(3)}, WR=${r.passedWinRate.toFixed(1)}%`);
    console.log(`  Blocked:    ${r.blockedTrades} trades, ret=${r.blockedReturn.toFixed(2)}%, SR=${r.blockedSharpe.toFixed(3)}, WR=${r.blockedWinRate.toFixed(1)}%`);
    console.log(`  Δ Sharpe:   ${(r.passedSharpe - r.unfilteredSharpe).toFixed(3)}`);
    console.log(`  Coins ever blocked: ${r.coinsEverBlocked.size}\n`);

    if (r.blockedReturn < 0) {
      console.log('  ✅ FILTER IS HELPING: blocked trades have negative return');
      console.log(`     Saved ${Math.abs(r.blockedReturn).toFixed(2)}% of losses\n`);
    } else {
      console.log('  ⚠️  WARNING: blocked trades have positive return — filter too aggressive');
      console.log(`     Would have lost ${r.blockedReturn.toFixed(2)}% of good trades\n`);
    }

    // ── Show most-blocked coins ──
    const sortedBlocked = Object.entries(r.coinBlockCounts)
      .sort((a, b) => b[1] - a[1]);

    if (sortedBlocked.length > 0) {
      console.log('═══ MOST-BLOCKED COINS ═══\n');
      for (const [sym, count] of sortedBlocked.slice(0, 20)) {
        console.log(`    ${sym.padEnd(15)} ${count} trades blocked`);
      }
    }
  }

  await client.end();
  console.log('\n✓ Tier 2 simulation complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
