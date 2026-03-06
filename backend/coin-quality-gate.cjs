/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  COIN QUALITY GATE — Live Integration Module                     ║
 * ║                                                                  ║
 * ║  Plugs into live-signals.cjs to block signals from coins with   ║
 * ║  poor trailing performance. Implements Tier 2 (rolling lookback)║
 * ║  as a real-time filter.                                          ║
 * ║                                                                  ║
 * ║  Usage in live-signals.cjs:                                      ║
 * ║    const { checkCoinQuality, invalidateCoinCache }              ║
 * ║      = require('./coin-quality-gate.cjs');                      ║
 * ║                                                                  ║
 * ║    // Before writing a signal:                                   ║
 * ║    const coinCheck = await checkCoinQuality(client, symbol,     ║
 * ║                                              strategyId);       ║
 * ║    if (!coinCheck.pass) {                                        ║
 * ║      // Signal blocked — log reason and skip                     ║
 * ║    }                                                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ── Configuration (tunable — start conservative) ──
const LOOKBACK = 25;              // Look at last N closed trades per coin
const MIN_WIN_RATE = 35;          // Block if WR < 35%
const MIN_TRADES_BEFORE_GATE = 10; // Don't gate coins until they have this many trades
const CACHE_TTL = 5 * 60_000;    // Cache coin stats for 5 minutes

// ── Internal cache ──
let _coinStatsCache = null;
let _cacheTime = 0;

/**
 * Load per-coin trailing stats from closed signals.
 * Cached for CACHE_TTL to avoid hitting DB every tick.
 */
async function loadCoinStats(client, strategyId) {
  const now = Date.now();
  if (_coinStatsCache && (now - _cacheTime) < CACHE_TTL) {
    return _coinStatsCache;
  }

  // Get the last LOOKBACK closed trades per coin for this strategy
  // Using a window function to get the most recent N per symbol
  const { rows } = await client.query(`
    WITH ranked AS (
      SELECT symbol, "returnPct",
             ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY "closedAt" DESC) as rn,
             COUNT(*) OVER (PARTITION BY symbol) as total_closed
      FROM "FracmapSignal"
      WHERE "strategyId" = $1 AND status = 'closed'
    )
    SELECT symbol,
           total_closed,
           COUNT(*) as recent_trades,
           COUNT(*) FILTER (WHERE "returnPct" > 0) as recent_wins,
           SUM("returnPct") as recent_return,
           AVG("returnPct") as recent_avg
    FROM ranked
    WHERE rn <= $2
    GROUP BY symbol, total_closed
  `, [strategyId, LOOKBACK]);

  const stats = {};
  for (const r of rows) {
    stats[r.symbol] = {
      totalClosed: parseInt(r.total_closed),
      recentTrades: parseInt(r.recent_trades),
      recentWins: parseInt(r.recent_wins),
      recentWinRate: r.recent_trades > 0 ? (r.recent_wins / r.recent_trades * 100) : 50,
      recentReturn: parseFloat(r.recent_return),
      recentAvg: parseFloat(r.recent_avg),
    };
  }

  _coinStatsCache = stats;
  _cacheTime = now;
  return stats;
}

/**
 * Check whether a coin passes the quality gate.
 *
 * @param {Object} client - PostgreSQL client
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} strategyId - strategy ID from FracmapStrategy
 * @returns {{ pass: boolean, reason: string|null, stats: object|null }}
 */
async function checkCoinQuality(client, symbol, strategyId) {
  if (!strategyId) return { pass: true, reason: null, stats: null };

  try {
    const stats = await loadCoinStats(client, strategyId);
    const coinStats = stats[symbol];

    // New coin or not enough history — allow through
    if (!coinStats || coinStats.totalClosed < MIN_TRADES_BEFORE_GATE) {
      return { pass: true, reason: null, stats: coinStats || null };
    }

    // Check trailing win rate
    if (coinStats.recentWinRate < MIN_WIN_RATE) {
      return {
        pass: false,
        reason: `Coin quality gate: ${symbol} trailing WR=${coinStats.recentWinRate.toFixed(1)}% < ${MIN_WIN_RATE}% (last ${coinStats.recentTrades} trades)`,
        stats: coinStats,
      };
    }

    return { pass: true, reason: null, stats: coinStats };
  } catch (err) {
    // Fail open — if we can't check, allow the trade
    console.error(`[COIN-GATE] Error checking ${symbol}: ${err.message}`);
    return { pass: true, reason: null, stats: null };
  }
}

/**
 * Invalidate the cache (call after a batch of closes).
 */
function invalidateCoinCache() {
  _coinStatsCache = null;
  _cacheTime = 0;
}

module.exports = { checkCoinQuality, invalidateCoinCache };
