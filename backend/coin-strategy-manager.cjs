/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  COIN STRATEGY MANAGER — Per-Coin Parallel Strategy Instances    ║
 * ║                                                                  ║
 * ║  The LLM Board reviews universe backtest data one coin at a      ║
 * ║  time and decides whether to deploy PARALLEL strategy instances  ║
 * ║  for specific coins. These are REAL FracmapStrategy rows that    ║
 * ║  run as ADDITIONAL signal loops alongside the universal ones.    ║
 * ║                                                                  ║
 * ║  KEY PRINCIPLE: These are ADDITIVE — they generate MORE signals, ║
 * ║  not fewer. The universal strategies continue unchanged.          ║
 * ║                                                                  ║
 * ║  Each coin strategy:                                              ║
 * ║  - Creates a FracmapStrategy row (type='coin_specific')          ║
 * ║  - Runs as its own loop in live-signals, trading ONLY that coin  ║
 * ║  - Uses same Fracmap signal detection with coin-specific filters ║
 * ║  - Gets its own strategyId → signals tracked separately          ║
 * ║                                                                  ║
 * ║  NAMING: COIN_{SYMBOL}_{TIMEFRAME}                               ║
 * ║  e.g. COIN_BTC_1m, COIN_ETH_1h, COIN_SOL_1d                    ║
 * ║                                                                  ║
 * ║  Requires 5/5 UNANIMOUS vote. One vote per timeframe.            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// NOTE: No dotenv loading here — this module is always imported by
// live-signals.cjs or llm-board.js which already handle .env loading.


// ═══════════════════════════════════════════════════════════════
// DB SCHEMA
// ═══════════════════════════════════════════════════════════════

async function ensureCoinStrategyTables(client) {
  // Metadata table: tracks board decisions & provenance for coin strategies
  // The ACTUAL strategy lives in FracmapStrategy table
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_coin_strategies (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      active          BOOLEAN DEFAULT true,
      
      -- Identity (links to FracmapStrategy)
      strategy_name   TEXT NOT NULL UNIQUE,
      fracmap_strategy_id INTEGER,
      symbol          TEXT NOT NULL,
      timeframe       TEXT NOT NULL,
      bar_minutes     INT NOT NULL,
      
      -- The coin-specific regime filter conditions
      filter_conditions JSONB,
      
      -- Strategy parameters (from universe backtest winner_params)
      strategy_params JSONB,
      
      -- Decision provenance
      meeting_id      INTEGER,
      proposed_by     TEXT,
      vote_count      TEXT,
      rationale       TEXT,
      
      -- Evidence from universe backtest
      backtest_evidence JSONB,
      
      -- Performance tracking (computed from FracmapSignal via strategyId)
      total_signals       INT DEFAULT 0,
      open_signals        INT DEFAULT 0,
      closed_signals      INT DEFAULT 0,
      avg_return          FLOAT,
      win_rate            FLOAT,
      total_return        FLOAT,
      sharpe              FLOAT,
      last_performance_update TIMESTAMPTZ,
      
      -- Lifecycle
      deactivated_at  TIMESTAMPTZ,
      deactivated_by  TEXT,
      deactivation_reason TEXT,
      
      UNIQUE(symbol, timeframe)
    )
  `);

  // Review queue: tracks which coins have been reviewed (by COIN, not coin+tf)
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_coin_review_queue (
      id              SERIAL PRIMARY KEY,
      symbol          TEXT NOT NULL UNIQUE,
      queued_at       TIMESTAMPTZ DEFAULT now(),
      reviewed_at     TIMESTAMPTZ,
      meeting_id      INTEGER,
      decision        TEXT,
      total_trades    INT DEFAULT 0
    )
  `);

  // Add fracmap_strategy_id column if missing (upgrade from v1)
  try {
    await client.query(`ALTER TABLE board_coin_strategies ADD COLUMN IF NOT EXISTS fracmap_strategy_id INTEGER`);
    await client.query(`ALTER TABLE board_coin_strategies ADD COLUMN IF NOT EXISTS strategy_params JSONB`);
    await client.query(`ALTER TABLE board_coin_strategies ADD COLUMN IF NOT EXISTS open_signals INT DEFAULT 0`);
    await client.query(`ALTER TABLE board_coin_strategies ADD COLUMN IF NOT EXISTS sharpe FLOAT`);
  } catch {}

  // Migrate review queue if old version had (symbol, timeframe) unique constraint
  try {
    await client.query(`ALTER TABLE board_coin_review_queue DROP CONSTRAINT IF EXISTS board_coin_review_queue_symbol_timeframe_key`);
  } catch {}

  // Add indexes
  try {
    await client.query(`CREATE INDEX IF NOT EXISTS idx_coin_strat_active ON board_coin_strategies(active, symbol)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_coin_strat_tf ON board_coin_strategies(active, bar_minutes)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_coin_strat_fracmap ON board_coin_strategies(fracmap_strategy_id) WHERE active = true`);
  } catch {}
}


// ═══════════════════════════════════════════════════════════════
// NAMING CONVENTION
// ═══════════════════════════════════════════════════════════════

function coinStrategyName(symbol, timeframe) {
  const cleanSymbol = symbol.replace('USDT', '').toUpperCase();
  return `COIN_${cleanSymbol}_${timeframe}`;
}

function parseStrategyName(name) {
  const match = name.match(/^COIN_([A-Z0-9]+)_(\d+[mhd])$/);
  if (!match) return null;
  return { symbol: `${match[1]}USDT`, timeframe: match[2] };
}

const TF_TO_BAR_MINUTES = { '1m': 1, '1h': 60, '1d': 1440 };
const BAR_MINUTES_TO_TF = { 1: '1m', 60: '1h', 1440: '1d' };

const TF_CONFIG = {
  1:    { table: 'Candle1m', interval: 60_000,     label: '1-Minute' },
  60:   { table: 'Candle1h', interval: 5 * 60_000,  label: '1-Hour'   },
  1440: { table: 'Candle1d', interval: 15 * 60_000, label: '1-Day'    },
};


// ═══════════════════════════════════════════════════════════════
// DEPLOY — Creates REAL FracmapStrategy row + metadata
// ═══════════════════════════════════════════════════════════════

/**
 * Deploy a new coin strategy.
 * 
 * Creates a FracmapStrategy row (type='coin_specific') that live-signals
 * will pick up and run as a parallel loop for ONLY this coin.
 * 
 * Also records metadata in board_coin_strategies for tracking.
 */
async function deployCoinStrategy(client, details, chairId, meetingId, voteCount) {
  const { symbol, timeframe, filter_conditions, rationale, backtest_evidence } = details;
  
  if (!symbol || !timeframe) {
    return { success: false, error: 'Missing required fields: symbol, timeframe' };
  }

  const barMinutes = TF_TO_BAR_MINUTES[timeframe];
  if (!barMinutes) {
    return { success: false, error: `Invalid timeframe: ${timeframe}. Must be 1m, 1h, or 1d.` };
  }

  const strategyName = coinStrategyName(symbol, timeframe);

  // Get the winner_params from universe_backtest for this coin+timeframe
  let strategyParams = null;
  try {
    const { rows } = await client.query(
      `SELECT winner_params FROM universe_backtest WHERE symbol = $1 AND bar_minutes = $2`,
      [symbol, barMinutes]
    );
    if (rows[0]?.winner_params) {
      strategyParams = typeof rows[0].winner_params === 'string' 
        ? JSON.parse(rows[0].winner_params) 
        : rows[0].winner_params;
    }
  } catch {}

  // Fall back to the universal strategy params if no winner_params
  if (!strategyParams) {
    try {
      const { rows } = await client.query(
        `SELECT "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax"
         FROM "FracmapStrategy" WHERE active = true AND "barMinutes" = $1 AND (type IS NULL OR type = 'universal')
         ORDER BY "updatedAt" DESC LIMIT 1`,
        [barMinutes]
      );
      if (rows[0]) strategyParams = rows[0];
    } catch {}
  }

  // Final fallback: hardcoded defaults matching live-signals DEFAULT_STRATEGIES
  if (!strategyParams) {
    const defaults = {
      1:    { minStr: 1, minCyc: 55, spike: true, nearMiss: true, holdDiv: 4, priceExt: true, cycleMin: 10, cycleMax: 100 },
      60:   { minStr: 1, minCyc: 64, spike: true, nearMiss: true, holdDiv: 5, priceExt: true, cycleMin: 55, cycleMax: 89 },
      1440: { minStr: 1, minCyc: 0, spike: false, nearMiss: false, holdDiv: 2, priceExt: true, cycleMin: 2, cycleMax: 12 },
    };
    strategyParams = defaults[barMinutes] || defaults[1];
  }

  // ── Step 1: Deactivate any existing coin strategy for this coin+tf ──
  try {
    await client.query(
      `UPDATE "FracmapStrategy" SET active = false, "updatedAt" = now()
       WHERE type = 'coin_specific' AND symbol = $1 AND "barMinutes" = $2 AND active = true`,
      [symbol, barMinutes]
    );
    await client.query(
      `UPDATE board_coin_strategies SET active = false, deactivated_at = now(), 
       deactivated_by = $1, deactivation_reason = 'Superseded by new board decision'
       WHERE symbol = $2 AND timeframe = $3 AND active = true`,
      [chairId, symbol, timeframe]
    );
  } catch {}

  // ── Step 2: Create REAL FracmapStrategy row ──
  const { rows: stratRows } = await client.query(
    `INSERT INTO "FracmapStrategy" 
     (name, type, "barMinutes", symbol, 
      "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax",
      active, "createdAt", "updatedAt")
     VALUES ($1, 'coin_specific', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, now(), now())
     RETURNING id`,
    [strategyName, barMinutes, symbol,
     strategyParams.minStr ?? 1, strategyParams.minCyc ?? 0,
     strategyParams.spike ?? true, strategyParams.nearMiss ?? true,
     strategyParams.holdDiv ?? 2, strategyParams.priceExt ?? true,
     strategyParams.cycleMin ?? 5, strategyParams.cycleMax ?? 20]
  );

  const fracmapStrategyId = stratRows[0].id;

  // ── Step 3: Create metadata record ──
  const { rows: metaRows } = await client.query(
    `INSERT INTO board_coin_strategies 
     (strategy_name, fracmap_strategy_id, symbol, timeframe, bar_minutes,
      filter_conditions, strategy_params,
      meeting_id, proposed_by, vote_count, rationale, backtest_evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (symbol, timeframe) DO UPDATE SET
       active = true, fracmap_strategy_id = $2,
       filter_conditions = $6, strategy_params = $7,
       meeting_id = $8, proposed_by = $9, vote_count = $10, 
       rationale = $11, backtest_evidence = $12,
       deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL,
       updated_at = now()
     RETURNING id, strategy_name`,
    [strategyName, fracmapStrategyId, symbol, timeframe, barMinutes,
     JSON.stringify(filter_conditions || {}), JSON.stringify(strategyParams),
     meetingId, chairId, voteCount || '',
     rationale || '', JSON.stringify(backtest_evidence || {})]
  );

  // ── Step 4: Mark this coin as reviewed ──
  await client.query(
    `INSERT INTO board_coin_review_queue (symbol, reviewed_at, meeting_id, decision)
     VALUES ($1, now(), $2, 'deploy_strategy')
     ON CONFLICT (symbol) DO UPDATE SET 
       reviewed_at = now(), meeting_id = $2, decision = 'deploy_strategy'`,
    [symbol, meetingId]
  );

  return { 
    success: true, 
    strategy_name: metaRows[0].strategy_name, 
    id: metaRows[0].id,
    fracmap_strategy_id: fracmapStrategyId,
  };
}


/**
 * Record a "no action needed" decision for a coin.
 */
async function markCoinReviewedNoAction(client, symbol, meetingId) {
  await client.query(
    `INSERT INTO board_coin_review_queue (symbol, reviewed_at, meeting_id, decision)
     VALUES ($1, now(), $2, 'no_action')
     ON CONFLICT (symbol) DO UPDATE SET 
       reviewed_at = now(), meeting_id = $2, decision = 'no_action'`,
    [symbol, meetingId]
  );
}


/**
 * Deactivate a coin strategy — both FracmapStrategy row and metadata.
 */
async function deactivateCoinStrategy(client, strategyName, deactivatedBy, reason) {
  const { rows } = await client.query(
    `SELECT fracmap_strategy_id, symbol, bar_minutes FROM board_coin_strategies 
     WHERE strategy_name = $1 AND active = true`,
    [strategyName]
  );

  if (rows[0]) {
    if (rows[0].fracmap_strategy_id) {
      await client.query(
        `UPDATE "FracmapStrategy" SET active = false, "updatedAt" = now() WHERE id::text = $1::text`,
        [rows[0].fracmap_strategy_id]
      );
    }
    await client.query(
      `UPDATE "FracmapStrategy" SET active = false, "updatedAt" = now()
       WHERE type = 'coin_specific' AND symbol = $1 AND "barMinutes" = $2 AND active = true`,
      [rows[0].symbol, rows[0].bar_minutes]
    );
  }

  await client.query(
    `UPDATE board_coin_strategies SET active = false, deactivated_at = now(),
     deactivated_by = $1, deactivation_reason = $2, updated_at = now()
     WHERE strategy_name = $3 AND active = true`,
    [deactivatedBy, reason, strategyName]
  );
}


// ═══════════════════════════════════════════════════════════════
// ACTIVE COIN STRATEGIES — For live-signals to discover & run
// ═══════════════════════════════════════════════════════════════

let _coinStrategiesCache = null;
let _coinStrategiesCacheTime = 0;
const COIN_STRATEGY_CACHE_TTL = 60_000;

/**
 * Get all active coin-specific strategies with their full config.
 * live-signals uses this to spawn parallel loops.
 */
async function getActiveCoinStrategies(client) {
  const now = Date.now();
  if (_coinStrategiesCache && (now - _coinStrategiesCacheTime) < COIN_STRATEGY_CACHE_TTL) {
    return _coinStrategiesCache;
  }

  try {
    const { rows } = await client.query(
      `SELECT fs.id, fs.name, fs.symbol, fs."barMinutes",
              fs."minStr", fs."minCyc", fs.spike, fs."nearMiss", 
              fs."holdDiv", fs."priceExt", fs."cycleMin", fs."cycleMax",
              bcs.filter_conditions
       FROM "FracmapStrategy" fs
       LEFT JOIN board_coin_strategies bcs 
         ON bcs.fracmap_strategy_id::text = fs.id::text AND bcs.active = true
       WHERE fs.active = true AND fs.type = 'coin_specific'
       ORDER BY fs."createdAt"`
    );

    const strategies = rows.map(r => {
      const tfCfg = TF_CONFIG[r.barMinutes] || TF_CONFIG[1];
      return {
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        barMinutes: r.barMinutes,
        table: tfCfg.table,
        interval: tfCfg.interval,
        label: `COIN-${r.symbol.replace('USDT', '')}-${BAR_MINUTES_TO_TF[r.barMinutes]}`,
        minStr: r.minStr,
        minCyc: r.minCyc,
        spike: r.spike,
        nearMiss: r.nearMiss,
        holdDiv: r.holdDiv,
        priceExt: r.priceExt,
        cycleMin: r.cycleMin,
        cycleMax: r.cycleMax,
        filterConditions: r.filter_conditions 
          ? (typeof r.filter_conditions === 'string' ? JSON.parse(r.filter_conditions) : r.filter_conditions)
          : null,
      };
    });

    _coinStrategiesCache = strategies;
    _coinStrategiesCacheTime = now;
    return strategies;
  } catch (err) {
    console.warn(`[coin-strategy] Error loading active strategies: ${err.message}`);
    return [];
  }
}

function invalidateCoinStrategyCache() {
  _coinStrategiesCache = null;
  _coinStrategiesCacheTime = 0;
}


// ═══════════════════════════════════════════════════════════════
// COIN REVIEW QUEUE — Most trades first, min 50, cycle back
// ═══════════════════════════════════════════════════════════════

/**
 * Get the next coin for the board to review.
 * 
 * ORDER: Total trades across ALL timeframes (descending) — most traded first.
 * CYCLE: Never-reviewed first, then oldest-reviewed. When all have
 *        been reviewed, cycle back to the most-traded coin.
 * MINIMUM: 50 total OOS trades across all timeframes.
 * 
 * Returns ALL 3 timeframes' data for that one coin.
 */
async function getNextCoinForReview(client) {
  try {
    // Aggregate trades per coin across all timeframes
    const { rows: candidates } = await client.query(`
      WITH coin_totals AS (
        SELECT symbol, 
               SUM(oos_trades) as total_oos_trades,
               MAX(oos_sharpe) as max_oos_sharpe
        FROM universe_backtest 
        GROUP BY symbol
        HAVING SUM(oos_trades) >= 50
      )
      SELECT ct.symbol, ct.total_oos_trades, ct.max_oos_sharpe,
             crq.reviewed_at, crq.decision
      FROM coin_totals ct
      LEFT JOIN board_coin_review_queue crq ON ct.symbol = crq.symbol
      ORDER BY 
        crq.reviewed_at IS NULL DESC,
        crq.reviewed_at ASC NULLS FIRST,
        ct.total_oos_trades DESC,
        ct.max_oos_sharpe DESC
      LIMIT 1
    `);

    // If nobody qualifies (all reviewed), cycle back to top
    let candidate;
    if (candidates.length === 0) {
      const { rows: fallback } = await client.query(`
        SELECT symbol, SUM(oos_trades) as total_oos_trades, MAX(oos_sharpe) as max_oos_sharpe
        FROM universe_backtest 
        GROUP BY symbol
        HAVING SUM(oos_trades) >= 50
        ORDER BY SUM(oos_trades) DESC
        LIMIT 1
      `);
      if (fallback.length === 0) return null;
      candidate = { ...fallback[0], reviewed_at: null, decision: null };
    } else {
      candidate = candidates[0];
    }

    // Get ALL timeframes' data for this coin
    const { rows: tfData } = await client.query(`
      SELECT ub.symbol, ub.bar_minutes,
             ub.oos_sharpe, ub.oos_win_rate, ub.oos_trades, ub.oos_profit_factor,
             ub.is_sharpe, ub.is_trades,
             ub.avg_abs_rho, ub.perfect_rho, ub.total_features,
             ub.regime_comparison, ub.regime_comparison_long, ub.regime_comparison_short,
             ub.winner_params,
             bcs.active as has_active_strategy,
             bcs.strategy_name as active_strategy_name
      FROM universe_backtest ub
      LEFT JOIN board_coin_strategies bcs 
        ON ub.symbol = bcs.symbol 
        AND ub.bar_minutes = bcs.bar_minutes 
        AND bcs.active = true
      WHERE ub.symbol = $1
      ORDER BY ub.bar_minutes
    `, [candidate.symbol]);

    if (tfData.length === 0) return null;

    const timeframes = {};
    for (const row of tfData) {
      const tf = BAR_MINUTES_TO_TF[row.bar_minutes] || `${row.bar_minutes}m`;
      timeframes[tf] = {
        barMinutes: row.bar_minutes,
        oosSharpe: parseFloat(row.oos_sharpe),
        oosWinRate: parseFloat(row.oos_win_rate),
        oosTrades: row.oos_trades,
        oosProfitFactor: parseFloat(row.oos_profit_factor),
        isSharpe: parseFloat(row.is_sharpe),
        isTrades: row.is_trades,
        avgAbsRho: row.avg_abs_rho ? parseFloat(row.avg_abs_rho) : null,
        perfectRho: row.perfect_rho,
        totalFeatures: row.total_features,
        regimeComparison: row.regime_comparison || [],
        regimeComparisonLong: row.regime_comparison_long || [],
        regimeComparisonShort: row.regime_comparison_short || [],
        winnerParams: row.winner_params || null,
        hasActiveStrategy: !!row.has_active_strategy,
        activeStrategyName: row.active_strategy_name || null,
      };
    }

    return {
      symbol: candidate.symbol,
      totalOosTrades: parseInt(candidate.total_oos_trades),
      maxOosSharpe: parseFloat(candidate.max_oos_sharpe),
      lastReviewed: candidate.reviewed_at || null,
      lastDecision: candidate.decision || null,
      timeframes,
    };
  } catch (err) {
    console.warn(`[coin-strategy] Error getting next coin for review: ${err.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════
// PERFORMANCE REPORT — From FracmapSignal via strategyId
// ═══════════════════════════════════════════════════════════════

async function generateCoinStrategyReport(client) {
  const results = [];

  try {
    const { rows: strategies } = await client.query(`
      SELECT bcs.*, fs.id as fs_id
      FROM board_coin_strategies bcs
      LEFT JOIN "FracmapStrategy" fs ON fs.id::text = bcs.fracmap_strategy_id::text
      WHERE bcs.active = true
      ORDER BY bcs.created_at
    `);

    for (const strat of strategies) {
      try {
        const fsId = strat.fs_id || strat.fracmap_strategy_id;
        if (!fsId) {
          results.push({
            strategy_name: strat.strategy_name, symbol: strat.symbol, timeframe: strat.timeframe,
            error: 'No FracmapStrategy linked',
          });
          continue;
        }

        const { rows: signals } = await client.query(
          `SELECT "returnPct", status FROM "FracmapSignal" 
           WHERE "strategyId" = $1 AND status IN ('closed', 'open', 'filtered')`,
          [fsId]
        );

        const closed = signals.filter(s => s.status === 'closed');
        const open = signals.filter(s => s.status === 'open');
        const filtered = signals.filter(s => s.status === 'filtered');
        const returns = closed.map(s => parseFloat(s.returnPct)).filter(r => !isNaN(r));

        const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        const winRate = returns.length > 0 ? (returns.filter(r => r > 0).length / returns.length * 100) : 0;
        const totalReturn = returns.reduce((a, b) => a + b, 0);
        const sharpe = returns.length >= 5 ? computeSharpe(returns) : null;
        const hoursActive = (Date.now() - new Date(strat.created_at).getTime()) / 3_600_000;

        let verdict = 'INSUFFICIENT_DATA';
        if (closed.length >= 10) {
          if (avgReturn > 0.05) verdict = 'POSITIVE';
          else if (avgReturn < -0.05) verdict = 'NEGATIVE';
          else verdict = 'NEUTRAL';
        }

        try {
          await client.query(
            `UPDATE board_coin_strategies SET 
             total_signals = $1, open_signals = $2, closed_signals = $3,
             avg_return = $4, win_rate = $5, total_return = $6, sharpe = $7,
             last_performance_update = now(), updated_at = now()
             WHERE id = $8`,
            [signals.length, open.length, closed.length, avgReturn, winRate, totalReturn, sharpe, strat.id]
          );
        } catch {}

        results.push({
          strategy_name: strat.strategy_name,
          symbol: strat.symbol,
          timeframe: strat.timeframe,
          hours_active: hoursActive,
          total_signals: signals.length,
          open: open.length,
          closed: closed.length,
          filtered: filtered.length,
          avg_return: avgReturn,
          win_rate: winRate,
          total_return: totalReturn,
          sharpe,
          verdict,
          statistically_valid: closed.length >= 30,
        });
      } catch (err) {
        results.push({
          strategy_name: strat.strategy_name, symbol: strat.symbol, timeframe: strat.timeframe,
          error: err.message,
        });
      }
    }
  } catch (err) {
    console.warn(`[coin-strategy] Error generating report: ${err.message}`);
  }

  return {
    strategies: results,
    summary: results.length === 0 
      ? 'No active coin strategies yet.'
      : `${results.length} active coin strategies. ` +
        `${results.filter(r => r.verdict === 'POSITIVE').length} positive, ` +
        `${results.filter(r => r.verdict === 'NEGATIVE').length} negative, ` +
        `${results.filter(r => r.verdict === 'INSUFFICIENT_DATA').length} awaiting data.`,
  };
}

function computeSharpe(returns) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, v) => a + (v - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(252) : 0;
}


// ═══════════════════════════════════════════════════════════════
// BRIEFING FORMATTERS
// ═══════════════════════════════════════════════════════════════

function formatCoinReviewBriefing(coinData) {
  if (!coinData) return '\n🔬 COIN UNIVERSE REVIEW: No coins available for review (need ≥50 OOS trades).\n';

  const sym = coinData.symbol.replace('USDT', '');

  let text = `\n${'═'.repeat(70)}\n`;
  text += `🔬 COIN UNIVERSE REVIEW — ${sym} (${coinData.symbol})\n`;
  text += `${'═'.repeat(70)}\n\n`;

  text += `  Total OOS Trades: ${coinData.totalOosTrades} | Max OOS Sharpe: ${coinData.maxOosSharpe.toFixed(2)}\n`;
  if (coinData.lastReviewed) {
    text += `  Last reviewed: ${new Date(coinData.lastReviewed).toISOString().slice(0, 16)} — Decision: ${coinData.lastDecision || 'unknown'}\n`;
  } else {
    text += `  🆕 NEVER REVIEWED — First universe analysis review\n`;
  }

  text += `\n  IMPORTANT: You may propose up to 3 DEPLOY_COIN_STRATEGY motions (one per timeframe).\n`;
  text += `  Each requires a SEPARATE 5/5 UNANIMOUS vote.\n`;
  text += `  These create PARALLEL strategy instances — they ADD signals, they don't filter.\n\n`;

  for (const [tf, data] of Object.entries(coinData.timeframes)) {
    const tfUpper = tf.toUpperCase();
    text += `  ${'─'.repeat(65)}\n`;
    text += `  📊 ${sym} — ${tfUpper}\n`;
    text += `  ${'─'.repeat(65)}\n`;

    text += `    OOS: Sharpe ${data.oosSharpe.toFixed(2)} | WR ${data.oosWinRate.toFixed(1)}% | PF ${data.oosProfitFactor.toFixed(2)} | Trades ${data.oosTrades}\n`;
    text += `    IS:  Sharpe ${data.isSharpe.toFixed(2)} | Trades ${data.isTrades}\n`;
    text += `    Regime: Avg |ρ| ${data.avgAbsRho?.toFixed(3) ?? 'n/a'} | Perfect ρ: ${data.perfectRho}/${data.totalFeatures}\n`;

    if (data.hasActiveStrategy) {
      text += `    ⚡ EXISTING COIN STRATEGY: ${data.activeStrategyName} (already active — would be replaced)\n`;
    }

    if (data.winnerParams) {
      const wp = typeof data.winnerParams === 'string' ? JSON.parse(data.winnerParams) : data.winnerParams;
      text += `    Strategy params: ×${wp.minStr} C≥${wp.minCyc} ${wp.spike?'⚡':'–'} ${wp.nearMiss?'±':'–'} ÷${wp.holdDiv} PxExt:${wp.priceExt?'ON':'OFF'} cycles ${wp.cycleMin}–${wp.cycleMax}\n`;
    }

    const comparison = data.regimeComparison || [];
    if (comparison.length > 0) {
      text += `\n    Regime Analysis (ALL signals):\n`;
      text += `    Feature              IS Buckets                                  OOS Buckets                                 ρ     Spread\n`;
      text += `    ${'─'.repeat(115)}\n`;
      for (const feat of comparison) {
        const isBStr = (feat.isBuckets || []).map(b =>
          `${(b.label || '').slice(0, 8)}:${b.trades}t/${b.sharpe !== null ? b.sharpe.toFixed(1) : 'n/a'}`
        ).join(' ').padEnd(40);
        const oosBStr = (feat.oosBuckets || []).map(b =>
          `${(b.label || '').slice(0, 8)}:${b.trades}t/${b.sharpe !== null ? b.sharpe.toFixed(1) : 'n/a'}`
        ).join(' ').padEnd(40);
        const rho = feat.rho !== null && feat.rho !== undefined ? (feat.rho >= 0 ? ' ' : '') + feat.rho.toFixed(2) : ' n/a';
        const spread = (feat.oosSpread || feat.isSpread || 0).toFixed(1);
        text += `    ${(feat.key || '').padEnd(20)} ${isBStr} ${oosBStr} ${rho}  ${spread.padStart(5)}\n`;
      }
    }

    const longComp = data.regimeComparisonLong || [];
    if (longComp.length > 0) {
      text += `\n    Regime Analysis (LONG signals):\n`;
      for (const feat of longComp) {
        const oosBStr = (feat.oosBuckets || []).map(b =>
          `${(b.label || '').slice(0, 12)}:${b.trades}t/SR${b.sharpe !== null ? b.sharpe.toFixed(1) : 'n/a'}`
        ).join('  ').padEnd(80);
        const rho = feat.rho !== null && feat.rho !== undefined ? (feat.rho >= 0 ? ' ' : '') + feat.rho.toFixed(2) : ' n/a';
        text += `    ${(feat.key || '').padEnd(20)} ${oosBStr} ${rho}\n`;
      }
    }

    const shortComp = data.regimeComparisonShort || [];
    if (shortComp.length > 0) {
      text += `\n    Regime Analysis (SHORT signals):\n`;
      for (const feat of shortComp) {
        const oosBStr = (feat.oosBuckets || []).map(b =>
          `${(b.label || '').slice(0, 12)}:${b.trades}t/SR${b.sharpe !== null ? b.sharpe.toFixed(1) : 'n/a'}`
        ).join('  ').padEnd(80);
        const rho = feat.rho !== null && feat.rho !== undefined ? (feat.rho >= 0 ? ' ' : '') + feat.rho.toFixed(2) : ' n/a';
        text += `    ${(feat.key || '').padEnd(20)} ${oosBStr} ${rho}\n`;
      }
    }

    text += '\n';
  }

  return text;
}


function formatCoinStrategyPerformanceReport(report) {
  if (!report || !report.strategies || report.strategies.length === 0) {
    return '\n📊 COIN STRATEGY PERFORMANCE: No active coin strategies yet. Deploy one via DEPLOY_COIN_STRATEGY.\n';
  }

  let text = `\n${'═'.repeat(70)}\n`;
  text += `📊 ACTIVE COIN STRATEGIES — Parallel Instances (${report.strategies.length} active)\n`;
  text += `${'═'.repeat(70)}\n`;
  text += `  ${report.summary}\n\n`;

  text += `  Strategy                 Closed   Open   Avg Ret    WR      Total Ret  Sharpe  Verdict       Valid\n`;
  text += `  ${'─'.repeat(100)}\n`;

  for (const s of report.strategies) {
    if (s.error) {
      text += `  ${s.strategy_name.padEnd(24)}  ERROR: ${s.error}\n`;
      continue;
    }
    const closed = String(s.closed).padStart(6);
    const open = String(s.open).padStart(6);
    const avgRet = s.closed > 0 ? `${s.avg_return >= 0 ? '+' : ''}${s.avg_return.toFixed(3)}%`.padStart(9) : '      n/a';
    const wr = s.closed > 0 ? `${s.win_rate.toFixed(1)}%`.padStart(7) : '    n/a';
    const totRet = s.closed > 0 ? `${s.total_return >= 0 ? '+' : ''}${s.total_return.toFixed(2)}%`.padStart(10) : '       n/a';
    const sharpe = s.sharpe !== null ? `${s.sharpe.toFixed(2)}`.padStart(7) : '    n/a';
    const verdict = s.verdict.padEnd(14);
    const valid = s.statistically_valid ? ' ✅ ' : ' ⏳ ';
    text += `  ${s.strategy_name.padEnd(24)} ${closed} ${open} ${avgRet} ${wr} ${totRet} ${sharpe}  ${verdict} ${valid}\n`;
  }

  text += `\n  These are PARALLEL instances generating ADDITIONAL signals alongside universal strategies.\n`;
  text += `  Deactivate underperformers via DEACTIVATE_COIN_STRATEGY.\n`;

  return text;
}


// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  ensureCoinStrategyTables,
  coinStrategyName,
  parseStrategyName,
  deployCoinStrategy,
  deactivateCoinStrategy,
  markCoinReviewedNoAction,
  getActiveCoinStrategies,
  invalidateCoinStrategyCache,
  getNextCoinForReview,
  generateCoinStrategyReport,
  formatCoinReviewBriefing,
  formatCoinStrategyPerformanceReport,
  TF_TO_BAR_MINUTES,
  BAR_MINUTES_TO_TF,
  TF_CONFIG,
};
