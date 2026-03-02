import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const dynamic = "force-dynamic";

// ── Matrix replay logic (ported from backend/filter-matrix-check.cjs) ──

const FEATURE_TO_SNAP: Record<string, string> = {
  posInRange: "posInRange60",
  volState: "volState",
  atrCompression: "atr_compression",
  hurst: "hurst",
  volRatio5d: "volRatio5d",
  persistence: "persistence",
  trend60: "trend60",
  posInRange5d: "posInRange5d",
  trend5d: "trend5d",
  volCluster: "volCluster",
  volRatio: "volRatio",
  hour: "hourOfDay",
};

type BucketTest = (v: any) => boolean;

const BUCKET_TESTS: Record<string, BucketTest> = {
  "Bottom (<0.25)": (v) => typeof v === "number" && v < 0.25,
  "Middle (0.25-0.75)": (v) => typeof v === "number" && v >= 0.25 && v <= 0.75,
  "Top (>0.75)": (v) => typeof v === "number" && v > 0.75,
  COMPRESSED: (v) => String(v).toUpperCase() === "COMPRESSED",
  NORMAL: (v) => String(v).toUpperCase() === "NORMAL",
  EXPANDING: (v) => String(v).toUpperCase() === "EXPANDING",
  "Compressed (<0.7)": (v) => typeof v === "number" && v < 0.7,
  "Normal (0.7-1.3)": (v) => typeof v === "number" && v >= 0.7 && v <= 1.3,
  "Expanding (>1.3)": (v) => typeof v === "number" && v > 1.3,
  "Mean-Rev (<0.45)": (v) => typeof v === "number" && v < 0.45,
  "Random (0.45-0.55)": (v) => typeof v === "number" && v >= 0.45 && v <= 0.55,
  "Trending (>0.55)": (v) => typeof v === "number" && v > 0.55,
  "Calm (<0.7)": (v) => typeof v === "number" && v < 0.7,
  "Heated (>1.3)": (v) => typeof v === "number" && v > 1.3,
  "Choppy (<0.47)": (v) => typeof v === "number" && v < 0.47,
  "Mixed (0.47-0.55)": (v) => typeof v === "number" && v >= 0.47 && v <= 0.55,
  "Clean (>0.55)": (v) => typeof v === "number" && v > 0.55,
  "Down (<-0.3)": (v) => typeof v === "number" && v < -0.3,
  "Flat (-0.3-0.3)": (v) => typeof v === "number" && v >= -0.3 && v <= 0.3,
  "Up (>0.3)": (v) => typeof v === "number" && v > 0.3,
  "Bear (<-0.3)": (v) => typeof v === "number" && v < -0.3,
  "Neutral (-0.3-0.3)": (v) => typeof v === "number" && v >= -0.3 && v <= 0.3,
  "Bull (>0.3)": (v) => typeof v === "number" && v > 0.3,
  "Unstable (<0.2)": (v) => typeof v === "number" && v < 0.2,
  "Moderate (0.2-0.5)": (v) => typeof v === "number" && v >= 0.2 && v <= 0.5,
  "Persistent (>0.5)": (v) => typeof v === "number" && v > 0.5,
  "Quiet (<0.7)": (v) => typeof v === "number" && v < 0.7,
  "Spiking (>1.3)": (v) => typeof v === "number" && v > 1.3,
  "Asia (0-8)": (v) => typeof v === "number" && v < 8,
  "Europe (8-15)": (v) => typeof v === "number" && v >= 8 && v < 15,
  "US (15-23)": (v) => typeof v === "number" && v >= 15,
};

type MatrixAttribution = {
  system: "board_filter" | "filter_matrix" | "coin_gate";
  feature_key?: string;
  bucket_label?: string;
  direction?: string;
  mode?: string;
};

function replayMatrixCheck(
  regimeSnap: any,
  direction: string,
  strategyId: string,
  matrixRows: any[],
  voteRows: any[]
): MatrixAttribution | null {
  if (!regimeSnap) return null;

  const matrixLookup: Record<string, string> = {};
  for (const r of matrixRows) {
    if (r.strategy_id === strategyId && r.direction === direction) {
      matrixLookup[`${r.feature_key}|${r.bucket_label}`] = r.mode;
    }
  }
  const voteLookup: Record<string, boolean> = {};
  for (const r of voteRows) {
    if (r.strategy_id === strategyId && r.direction === direction) {
      voteLookup[`${r.feature_key}|${r.bucket_label}`] = r.blocked;
    }
  }

  for (const [featureKey, snapField] of Object.entries(FEATURE_TO_SNAP)) {
    const snapValue = regimeSnap[snapField];
    if (snapValue === undefined || snapValue === null) continue;

    for (const [bucketLabel, testFn] of Object.entries(BUCKET_TESTS)) {
      if (!testFn(snapValue)) continue;

      const key = `${featureKey}|${bucketLabel}`;
      const mode = matrixLookup[key] || "auto";

      if (mode === "locked_pass") continue;
      if (mode === "locked_block") {
        return {
          system: "filter_matrix",
          feature_key: featureKey,
          bucket_label: bucketLabel,
          direction,
          mode: "locked_block",
        };
      }
      if (mode === "auto" && voteLookup[key]) {
        return {
          system: "filter_matrix",
          feature_key: featureKey,
          bucket_label: bucketLabel,
          direction,
          mode: "board_vote",
        };
      }
    }
  }

  return null;
}

// ── Counterfactual return computation ──

async function computeCounterfactualReturn(
  client: any,
  sig: any,
  strategyMap: Record<string, number>
): Promise<number | null> {
  // If already closed with a return, use it directly
  if (
    (sig.status === "filtered_closed" || sig.status === "closed") &&
    sig.returnPct != null
  ) {
    return parseFloat(sig.returnPct);
  }

  // For 'filtered' signals, compute from candles
  const barMinutes = strategyMap[sig.strategyId] || 1;
  const holdBars = sig.holdBars || 60;
  const holdMs = holdBars * barMinutes * 60 * 1000;
  const exitTime = new Date(sig.createdAt).getTime() + holdMs;

  if (exitTime > Date.now()) return null; // Not yet evaluable

  const entryPrice = parseFloat(sig.entryPrice);
  if (!entryPrice || entryPrice <= 0) return null;

  const table =
    barMinutes >= 1440 ? "Candle1d" : barMinutes >= 60 ? "Candle1h" : "Candle1m";

  try {
    const { rows: candles } = await client.query(
      `SELECT close FROM "${table}" WHERE symbol = $1 AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 1`,
      [sig.symbol, new Date(exitTime).toISOString()]
    );
    if (candles.length === 0) return null;
    const exitPrice = parseFloat(candles[0].close);
    const ret =
      sig.direction === "LONG"
        ? (exitPrice / entryPrice - 1) * 100
        : (entryPrice / exitPrice - 1) * 100;
    return Math.abs(ret) > 50 ? null : Math.round(ret * 10000) / 10000; // sanity cap
  } catch {
    return null;
  }
}

// ── Summary action ──

async function handleSummary(client: any, hours: number) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  // Load strategies
  const { rows: stratRows } = await client.query(
    `SELECT id, name, "barMinutes" FROM "FracmapStrategy" WHERE active = true`
  );
  const strategyMap: Record<string, number> = {};
  const strategies = stratRows.map((s: any) => {
    strategyMap[s.id] = s.barMinutes;
    return { id: s.id, name: s.name, barMinutes: s.barMinutes };
  });

  // Load all signals in window
  const { rows: signals } = await client.query(
    `SELECT id, symbol, direction, "entryPrice", "strategyId", "holdBars",
            "createdAt", status, filtered_by, "returnPct", regime_snapshot
     FROM "FracmapSignal"
     WHERE "createdAt" >= $1
     ORDER BY "createdAt" ASC`,
    [cutoff]
  );

  // Load matrix data for replay
  let matrixRows: any[] = [];
  let voteRows: any[] = [];
  try {
    const m = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, mode FROM filter_matrix`
    );
    matrixRows = m.rows;
  } catch {}
  try {
    const v = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, blocked FROM filter_matrix_board_votes`
    );
    voteRows = v.rows;
  } catch {}

  // Count active board filters
  let activeBoardFilters = 0;
  try {
    const { rows: [fc] } = await client.query(
      `SELECT COUNT(*) as cnt FROM board_filters WHERE active = true`
    );
    activeBoardFilters = parseInt(fc.cnt);
  } catch {}

  // Count active matrix locks
  const activeLocks = matrixRows.filter(
    (r: any) => r.mode === "locked_block"
  ).length;
  const activeVotes = voteRows.filter((r: any) => r.blocked).length;

  // Categorize signals
  const passed: any[] = [];
  const boardFiltered: any[] = [];
  const matrixFiltered: any[] = [];
  const coinGateFiltered: any[] = [];

  for (const sig of signals) {
    if (sig.status === "open" || sig.status === "closed") {
      passed.push(sig);
      continue;
    }

    // Filtered signal — attribute to a system
    if (
      sig.status === "filtered" ||
      sig.status === "filtered_closed"
    ) {
      if (sig.filtered_by) {
        // Board filter (has explicit ID)
        boardFiltered.push(sig);
        continue;
      }

      // No filtered_by — replay matrix to attribute
      const snap =
        typeof sig.regime_snapshot === "string"
          ? JSON.parse(sig.regime_snapshot)
          : sig.regime_snapshot;
      const matrixResult = replayMatrixCheck(
        snap,
        sig.direction,
        sig.strategyId,
        matrixRows,
        voteRows
      );

      if (matrixResult) {
        matrixFiltered.push({ ...sig, _matrixAttrib: matrixResult });
      } else {
        // By elimination → coin gate
        coinGateFiltered.push(sig);
      }
    }
  }

  // Compute returns for each bucket
  const computeStats = async (bucket: any[]) => {
    let totalReturn = 0;
    let wins = 0;
    let evaluated = 0;
    for (const sig of bucket) {
      const ret = await computeCounterfactualReturn(client, sig, strategyMap);
      if (ret !== null) {
        totalReturn += ret;
        if (ret > 0) wins++;
        evaluated++;
      }
    }
    return {
      count: bucket.length,
      evaluated,
      total_return: Math.round(totalReturn * 10000) / 10000,
      avg_return:
        evaluated > 0
          ? Math.round((totalReturn / evaluated) * 10000) / 10000
          : 0,
      win_rate: evaluated > 0 ? Math.round((wins / evaluated) * 1000) / 10 : 0,
    };
  };

  const [passedStats, boardStats, matrixStats, coinStats] = await Promise.all([
    computeStats(passed),
    computeStats(boardFiltered),
    computeStats(matrixFiltered),
    computeStats(coinGateFiltered),
  ]);

  const totalFiltered = boardStats.count + matrixStats.count + coinStats.count;
  const totalFilteredReturn =
    boardStats.total_return + matrixStats.total_return + coinStats.total_return;

  const verdict = (stats: any) =>
    stats.evaluated < 10
      ? "INSUFFICIENT_DATA"
      : stats.avg_return < 0
      ? "HELPING"
      : "HURTING";

  // Unique gated coins
  const gatedCoins = new Set(coinGateFiltered.map((s: any) => s.symbol));

  return NextResponse.json({
    window_hours: hours,
    strategies,
    totals: {
      signals: signals.length,
      passed: passedStats.count,
      filtered: totalFiltered,
      passed_return: passedStats.total_return,
      passed_win_rate: passedStats.win_rate,
      filtered_return: totalFilteredReturn,
      filtered_win_rate:
        totalFiltered > 0
          ? Math.round(
              (((boardStats.win_rate * boardStats.evaluated +
                matrixStats.win_rate * matrixStats.evaluated +
                coinStats.win_rate * coinStats.evaluated) /
                Math.max(
                  1,
                  boardStats.evaluated +
                    matrixStats.evaluated +
                    coinStats.evaluated
                )) *
                100) /
                100
            )
          : 0,
    },
    by_system: {
      board_filters: {
        count: boardStats.count,
        active_filters: activeBoardFilters,
        total_return: boardStats.total_return,
        avg_return: boardStats.avg_return,
        win_rate: boardStats.win_rate,
        verdict: verdict(boardStats),
      },
      filter_matrix: {
        count: matrixStats.count,
        active_locks: activeLocks + activeVotes,
        total_return: matrixStats.total_return,
        avg_return: matrixStats.avg_return,
        win_rate: matrixStats.win_rate,
        verdict: verdict(matrixStats),
      },
      coin_gate: {
        count: coinStats.count,
        gated_coins: gatedCoins.size,
        total_return: coinStats.total_return,
        avg_return: coinStats.avg_return,
        win_rate: coinStats.win_rate,
        verdict: verdict(coinStats),
      },
    },
    net_filter_value: Math.round(-totalFilteredReturn * 10000) / 10000,
    note: "Matrix/coin-gate attribution uses current matrix state, not historical. Locks removed since signal time may cause misattribution.",
  });
}

// ── Board-filters detail action ──

async function handleBoardFilters(client: any, hours: number) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const { rows: filters } = await client.query(
    `SELECT id, feature, timeframe, conditions, created_at, trades_passed, trades_filtered
     FROM board_filters WHERE active = true ORDER BY id`
  );

  const { rows: stratRows } = await client.query(
    `SELECT id, "barMinutes" FROM "FracmapStrategy"`
  );
  const strategyMap: Record<string, number> = {};
  for (const s of stratRows) strategyMap[s.id] = s.barMinutes;

  // Load scorecard for cross-reference
  let scorecardRows: any[] = [];
  try {
    const sc = await client.query(
      `SELECT feature_key, bucket_label, direction_filter, bar_minutes, rho, confidence, oos_sharpe, oos_trades
       FROM regime_scorecard`
    );
    scorecardRows = sc.rows;
  } catch {}

  // For a board filter, find the best-matching scorecard rows for its feature
  function filterScorecard(feature: string, timeframe: string | null) {
    const barMinutes = timeframe === "1d" ? 1440 : timeframe === "1h" ? 60 : timeframe === "1m" ? 1 : null;
    const matching = scorecardRows.filter(
      (r: any) => r.feature_key === feature && (barMinutes ? r.bar_minutes === barMinutes : true)
    );
    if (matching.length === 0) return null;
    // Return summary: best rho across direction_filter='all' rows
    const allRows = matching.filter((r: any) => r.direction_filter === "all");
    const dirRows = matching.filter((r: any) => r.direction_filter !== "all");
    const bestAll = allRows.length > 0 ? allRows.reduce((best: any, r: any) =>
      (r.rho != null && (best.rho == null || Math.abs(r.rho) > Math.abs(best.rho))) ? r : best, allRows[0]) : null;
    return {
      rho: bestAll?.rho != null ? parseFloat(bestAll.rho) : null,
      confidence: bestAll?.confidence || null,
      buckets: matching.map((r: any) => ({
        bucket: r.bucket_label,
        direction: r.direction_filter,
        rho: r.rho != null ? parseFloat(r.rho) : null,
        confidence: r.confidence,
        oos_sharpe: r.oos_sharpe != null ? parseFloat(r.oos_sharpe) : null,
        oos_trades: r.oos_trades != null ? parseInt(r.oos_trades) : 0,
      })),
    };
  }

  const result: Record<string, any> = {};

  for (const filter of filters) {
    const fId = filter.id;

    const { rows: blockedSignals } = await client.query(
      `SELECT id, symbol, direction, "entryPrice", "strategyId", "holdBars",
              "createdAt", status, filtered_by, "returnPct"
       FROM "FracmapSignal"
       WHERE filtered_by = $1 AND "createdAt" >= $2
       ORDER BY "createdAt" ASC`,
      [fId, cutoff]
    );

    const series: any[] = [];
    let cumulativeInverted = 0;

    for (const sig of blockedSignals) {
      const ret = await computeCounterfactualReturn(client, sig, strategyMap);
      if (ret === null) continue;

      const invertedReturn = -ret;
      cumulativeInverted += invertedReturn;

      series.push({
        time: sig.createdAt,
        symbol: sig.symbol,
        direction: sig.direction,
        hypothetical_return: ret,
        inverted_return: Math.round(invertedReturn * 10000) / 10000,
        cumulative_inverted: Math.round(cumulativeInverted * 10000) / 10000,
      });
    }

    const totalBlocked = series.length;
    const avgInverted = totalBlocked > 0 ? cumulativeInverted / totalBlocked : 0;
    const verdict =
      totalBlocked < 10
        ? "INSUFFICIENT_DATA"
        : cumulativeInverted > 0
        ? "HELPING"
        : "HURTING";

    result[fId] = {
      filter_id: fId,
      feature: filter.feature,
      timeframe: filter.timeframe,
      deployed_at: filter.created_at,
      trades_passed: filter.trades_passed,
      trades_filtered: filter.trades_filtered,
      block_rate:
        filter.trades_filtered + filter.trades_passed > 0
          ? (
              (filter.trades_filtered /
                (filter.trades_filtered + filter.trades_passed)) *
              100
            ).toFixed(1)
          : "0",
      evaluated: totalBlocked,
      cumulative_inverted_return:
        Math.round(cumulativeInverted * 10000) / 10000,
      avg_inverted_per_trade: Math.round(avgInverted * 10000) / 10000,
      verdict,
      source: "board_filter",
      scorecard: filterScorecard(filter.feature, filter.timeframe),
      series,
    };
  }

  return NextResponse.json(result);
}

// ── Matrix-locks detail action ──

async function handleMatrixLocks(client: any, hours: number) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  // Load matrix data
  let matrixRows: any[] = [];
  let voteRows: any[] = [];
  try {
    const m = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, mode FROM filter_matrix`
    );
    matrixRows = m.rows;
  } catch {}
  try {
    const v = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, blocked FROM filter_matrix_board_votes`
    );
    voteRows = v.rows;
  } catch {}

  const { rows: stratRows } = await client.query(
    `SELECT id, name, "barMinutes" FROM "FracmapStrategy"`
  );
  const strategyMap: Record<string, number> = {};
  const strategyNames: Record<string, string> = {};
  for (const s of stratRows) {
    strategyMap[s.id] = s.barMinutes;
    strategyNames[s.id] = s.name;
  }

  // Load scorecard rho/SR for cross-reference
  const scorecardMap: Record<string, any> = {};
  try {
    const sc = await client.query(
      `SELECT feature_key, bucket_label, direction_filter, bar_minutes, rho, confidence, oos_sharpe, oos_trades
       FROM regime_scorecard`
    );
    for (const r of sc.rows) {
      const key = `${r.feature_key}|${r.bucket_label}|${r.direction_filter}|${r.bar_minutes}`;
      scorecardMap[key] = {
        rho: r.rho != null ? parseFloat(r.rho) : null,
        confidence: r.confidence,
        oos_sharpe: r.oos_sharpe != null ? parseFloat(r.oos_sharpe) : null,
        oos_trades: r.oos_trades != null ? parseInt(r.oos_trades) : 0,
      };
    }
  } catch {}

  // Helper to look up scorecard for a cell
  function lookupScorecard(featureKey: string, bucketLabel: string, direction: string, barMinutes: number | null) {
    if (!barMinutes) return null;
    // Try direction-specific first, then 'all'
    const dirKey = `${featureKey}|${bucketLabel}|${direction.toLowerCase()}|${barMinutes}`;
    if (scorecardMap[dirKey]) return scorecardMap[dirKey];
    const allKey = `${featureKey}|${bucketLabel}|all|${barMinutes}`;
    return scorecardMap[allKey] || null;
  }

  // Get unattributed filtered signals
  const { rows: signals } = await client.query(
    `SELECT id, symbol, direction, "entryPrice", "strategyId", "holdBars",
            "createdAt", status, "returnPct", regime_snapshot
     FROM "FracmapSignal"
     WHERE "createdAt" >= $1
       AND status IN ('filtered', 'filtered_closed')
       AND filtered_by IS NULL
     ORDER BY "createdAt" ASC`,
    [cutoff]
  );

  // Attribute each signal via matrix replay, group by cell
  const cellMap: Record<string, { cell: any; signals: any[] }> = {};

  for (const sig of signals) {
    const snap =
      typeof sig.regime_snapshot === "string"
        ? JSON.parse(sig.regime_snapshot)
        : sig.regime_snapshot;

    const attrib = replayMatrixCheck(
      snap,
      sig.direction,
      sig.strategyId,
      matrixRows,
      voteRows
    );

    if (!attrib) continue; // Falls to coin gate, not matrix

    const cellKey = `${sig.strategyId}|${attrib.feature_key}|${attrib.bucket_label}|${attrib.direction}|${attrib.mode}`;
    if (!cellMap[cellKey]) {
      cellMap[cellKey] = {
        cell: {
          strategy_id: sig.strategyId,
          strategy_name: strategyNames[sig.strategyId] || sig.strategyId,
          bar_minutes: strategyMap[sig.strategyId] || null,
          feature_key: attrib.feature_key,
          bucket_label: attrib.bucket_label,
          direction: attrib.direction,
          mode: attrib.mode,
          source: attrib.mode === "locked_block" ? "operator" : "board_vote",
        },
        signals: [],
      };
    }
    cellMap[cellKey].signals.push(sig);
  }

  // Compute counterfactual for each cell
  const cells = [];
  for (const { cell, signals: cellSigs } of Object.values(cellMap)) {
    let totalReturn = 0;
    let wins = 0;
    let evaluated = 0;

    for (const sig of cellSigs) {
      const ret = await computeCounterfactualReturn(client, sig, strategyMap);
      if (ret !== null) {
        totalReturn += ret;
        if (ret > 0) wins++;
        evaluated++;
      }
    }

    const avgReturn = evaluated > 0 ? totalReturn / evaluated : 0;
    const winRate = evaluated > 0 ? (wins / evaluated) * 100 : 0;
    const verdict =
      evaluated < 5
        ? "INSUFFICIENT_DATA"
        : avgReturn < 0
        ? "HELPING"
        : "HURTING";

    const sc = lookupScorecard(cell.feature_key, cell.bucket_label, cell.direction, cell.bar_minutes);
    cells.push({
      ...cell,
      signals_blocked: cellSigs.length,
      counterfactual: {
        total_return: Math.round(totalReturn * 10000) / 10000,
        avg_return: Math.round(avgReturn * 10000) / 10000,
        win_rate: Math.round(winRate * 10) / 10,
      },
      scorecard: sc,
      verdict,
    });
  }

  // Add dormant locks (exist in matrix but blocked zero signals in window)
  const activeCellKeys = new Set(Object.keys(cellMap));
  const allLocks = matrixRows.filter((r: any) => r.mode === "locked_block");
  const blockedVotes = voteRows.filter((r: any) => r.blocked);
  const allBlockSources = [
    ...allLocks.map((r: any) => ({ ...r, source: "operator" })),
    ...blockedVotes.map((r: any) => ({ ...r, mode: "board_vote", source: "board_vote" })),
  ];

  for (const lock of allBlockSources) {
    const cellKey = `${lock.strategy_id}|${lock.feature_key}|${lock.bucket_label}|${lock.direction}|${lock.mode}`;
    if (activeCellKeys.has(cellKey)) continue; // Already in results
    const barMins = strategyMap[lock.strategy_id] || null;
    const sc = lookupScorecard(lock.feature_key, lock.bucket_label, lock.direction, barMins);
    cells.push({
      strategy_id: lock.strategy_id,
      strategy_name: strategyNames[lock.strategy_id] || lock.strategy_id,
      bar_minutes: barMins,
      feature_key: lock.feature_key,
      bucket_label: lock.bucket_label,
      direction: lock.direction,
      mode: lock.mode,
      source: lock.source,
      signals_blocked: 0,
      counterfactual: { total_return: 0, avg_return: 0, win_rate: 0 },
      scorecard: sc,
      verdict: "DORMANT",
    });
  }

  cells.sort((a, b) => {
    // Active first, then dormant
    if (a.signals_blocked > 0 && b.signals_blocked === 0) return -1;
    if (a.signals_blocked === 0 && b.signals_blocked > 0) return 1;
    return a.counterfactual.total_return - b.counterfactual.total_return;
  });

  return NextResponse.json({
    cells,
    note: "Attribution uses current matrix state. Locks removed since signal time will misattribute those signals to coin_gate.",
  });
}

// ── Coin-gate detail action ──

async function handleCoinGate(client: any, hours: number) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  // Load matrix data for elimination
  let matrixRows: any[] = [];
  let voteRows: any[] = [];
  try {
    const m = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, mode FROM filter_matrix`
    );
    matrixRows = m.rows;
  } catch {}
  try {
    const v = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, blocked FROM filter_matrix_board_votes`
    );
    voteRows = v.rows;
  } catch {}

  const { rows: stratRows } = await client.query(
    `SELECT id, name, "barMinutes" FROM "FracmapStrategy"`
  );
  const strategyMap: Record<string, number> = {};
  const strategyNames: Record<string, string> = {};
  for (const s of stratRows) {
    strategyMap[s.id] = s.barMinutes;
    strategyNames[s.id] = s.name;
  }

  // Get unattributed filtered signals
  const { rows: signals } = await client.query(
    `SELECT id, symbol, direction, "entryPrice", "strategyId", "holdBars",
            "createdAt", status, "returnPct", regime_snapshot
     FROM "FracmapSignal"
     WHERE "createdAt" >= $1
       AND status IN ('filtered', 'filtered_closed')
       AND filtered_by IS NULL
     ORDER BY "createdAt" ASC`,
    [cutoff]
  );

  // Filter to only those NOT attributed to matrix
  const coinGateSignals: any[] = [];
  for (const sig of signals) {
    const snap =
      typeof sig.regime_snapshot === "string"
        ? JSON.parse(sig.regime_snapshot)
        : sig.regime_snapshot;
    const matrixResult = replayMatrixCheck(
      snap,
      sig.direction,
      sig.strategyId,
      matrixRows,
      voteRows
    );
    if (!matrixResult) coinGateSignals.push(sig);
  }

  // Group by symbol+strategy
  const coinMap: Record<string, any[]> = {};
  for (const sig of coinGateSignals) {
    const key = `${sig.symbol}|${sig.strategyId}`;
    if (!coinMap[key]) coinMap[key] = [];
    coinMap[key].push(sig);
  }

  // Load coin trailing stats
  let coinStatsMap: Record<string, any> = {};
  try {
    const { rows } = await client.query(`
      WITH ranked AS (
        SELECT symbol, "strategyId", "returnPct",
               ROW_NUMBER() OVER (PARTITION BY symbol, "strategyId" ORDER BY "closedAt" DESC) as rn
        FROM "FracmapSignal"
        WHERE status = 'closed'
      )
      SELECT symbol, "strategyId",
             COUNT(*) as recent_trades,
             COUNT(*) FILTER (WHERE "returnPct" > 0) as recent_wins
      FROM ranked
      WHERE rn <= 25
      GROUP BY symbol, "strategyId"
    `);
    for (const r of rows) {
      coinStatsMap[`${r.symbol}|${r.strategyId}`] = {
        recentTrades: parseInt(r.recent_trades),
        recentWinRate:
          r.recent_trades > 0
            ? Math.round(
                (parseInt(r.recent_wins) / parseInt(r.recent_trades)) * 1000
              ) / 10
            : 0,
      };
    }
  } catch {}

  const coins = [];
  for (const [key, sigs] of Object.entries(coinMap)) {
    const [symbol, strategyId] = key.split("|");
    const stats = coinStatsMap[key];

    let totalReturn = 0;
    let wins = 0;
    let evaluated = 0;

    for (const sig of sigs) {
      const ret = await computeCounterfactualReturn(client, sig, strategyMap);
      if (ret !== null) {
        totalReturn += ret;
        if (ret > 0) wins++;
        evaluated++;
      }
    }

    const avgReturn = evaluated > 0 ? totalReturn / evaluated : 0;
    const winRate = evaluated > 0 ? (wins / evaluated) * 100 : 0;
    const verdict =
      evaluated < 5
        ? "INSUFFICIENT_DATA"
        : avgReturn < 0
        ? "HELPING"
        : "HURTING";

    coins.push({
      symbol,
      strategy_id: strategyId,
      strategy_name: strategyNames[strategyId] || strategyId,
      bar_minutes: strategyMap[strategyId] || null,
      recent_win_rate: stats?.recentWinRate ?? null,
      signals_blocked: sigs.length,
      counterfactual: {
        total_return: Math.round(totalReturn * 10000) / 10000,
        avg_return: Math.round(avgReturn * 10000) / 10000,
        win_rate: Math.round(winRate * 10) / 10,
      },
      verdict,
    });
  }

  coins.sort((a, b) => a.counterfactual.total_return - b.counterfactual.total_return);

  return NextResponse.json({
    coins,
    note: "Coin gate attribution is by elimination: signals with no board filter ID and no matrix match.",
  });
}

// ── GET handler ──

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "summary";
  const hours = Math.min(
    Math.max(parseInt(searchParams.get("hours") || "168") || 168, 1),
    720
  );
  const client = await pool.connect();

  try {
    switch (action) {
      case "summary":
        return await handleSummary(client, hours);
      case "board-filters":
        return await handleBoardFilters(client, hours);
      case "matrix-locks":
        return await handleMatrixLocks(client, hours);
      case "coin-gate":
        return await handleCoinGate(client, hours);
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
