"use client";

import { useState, useEffect, useCallback } from "react";
import AdminNav from "@/components/AdminNav";

const GOLD = "#D4A843";
const GREEN = "#22c55e";
const RED = "#ef4444";
const BLUE = "#3b82f6";
const MUTED = "rgba(255,255,255,0.4)";

type Result = {
  id: number;
  cycle_min: number;
  cycle_max: number;
  pair_mode: string;
  max_gap: number;
  coins_used: number;
  is_sharpe: number;
  is_win_rate: number;
  is_profit_factor: number;
  is_total_ret: number;
  is_trade_count: number;
  oos_sharpe: number;
  oos_win_rate: number;
  oos_profit_factor: number;
  oos_total_ret: number;
  oos_trade_count: number;
  oos_avg_hold: number;
  oos_t1_count: number;
  oos_t2_count: number;
  oos_unmatched: number;
  oos_unhedged_sharpe: number;
  oos_unhedged_wr: number;
  top_pairs: any[];
};

type CoinRow = {
  backtest_id: number;
  symbol: string;
  oos_signals: number;
  oos_as_long: number;
  oos_as_short: number;
  oos_avg_return: number;
  oos_win_rate: number;
  best_cycle: number | null;
};

type Metric = "oos_sharpe" | "oos_win_rate" | "oos_profit_factor" | "oos_total_ret";

function metricLabel(m: Metric): string {
  return { oos_sharpe: "OOS Sharpe", oos_win_rate: "OOS Win Rate", oos_profit_factor: "OOS PF", oos_total_ret: "OOS Return" }[m];
}

function fmtMetric(v: number, m: Metric): string {
  if (m === "oos_win_rate") return v.toFixed(1) + "%";
  if (m === "oos_total_ret") return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
  return v.toFixed(2);
}

// ── Heatmap cell color ──
function heatColor(value: number, metric: Metric): string {
  let norm: number;
  if (metric === "oos_sharpe") norm = Math.min(1, Math.max(0, (value + 1) / 4)); // -1..3 → 0..1
  else if (metric === "oos_win_rate") norm = Math.min(1, Math.max(0, (value - 30) / 40)); // 30-70
  else if (metric === "oos_profit_factor") norm = Math.min(1, Math.max(0, (value - 0.5) / 2)); // 0.5-2.5
  else norm = Math.min(1, Math.max(0, (value + 20) / 60)); // -20..40

  if (norm > 0.7) return `rgba(34,197,94,${0.15 + norm * 0.35})`;
  if (norm > 0.45) return `rgba(234,179,8,${0.1 + norm * 0.2})`;
  return `rgba(239,68,68,${0.05 + (1 - norm) * 0.2})`;
}

export default function HedgedBacktestDashboard() {
  const [results, setResults] = useState<Result[]>([]);
  const [coins, setCoins] = useState<CoinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<Metric>("oos_sharpe");
  const [modeFilter, setModeFilter] = useState<string>("exclusive");
  const [gapFilter, setGapFilter] = useState<number>(0);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/board/hedged-backtest?bar_minutes=1440")
      .then((r) => r.json())
      .then((d) => {
        setResults(d.results || []);
        setCoins(d.coins || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Filtered results for heatmap
  const heatData = results.filter(
    (r) => r.pair_mode === modeFilter && r.max_gap === gapFilter
  );

  // Build heatmap grid: cycleMin (rows) × cycleMax (cols)
  const cycleMinValues = [...new Set(results.map((r) => r.cycle_min))].sort((a, b) => a - b);
  const cycleMaxValues = [...new Set(results.map((r) => r.cycle_max))].sort((a, b) => a - b);
  const heatLookup: Record<string, Result> = {};
  for (const r of heatData) heatLookup[`${r.cycle_min}-${r.cycle_max}`] = r;

  // Top results
  const topResults = [...results]
    .filter((r) => r.oos_trade_count >= 5)
    .sort((a, b) => b.oos_sharpe - a.oos_sharpe)
    .slice(0, 20);

  // Best result
  const best = topResults[0];

  // Gap degradation for best cycle range
  const gapDegradation = best
    ? results.filter(
        (r) =>
          r.cycle_min === best.cycle_min &&
          r.cycle_max === best.cycle_max &&
          r.oos_trade_count >= 3
      )
    : [];

  // Per-coin data for best config
  const bestCoins = best ? coins.filter((c) => c.backtest_id === best.id).sort((a, b) => b.oos_signals - a.oos_signals) : [];

  const metrics: Metric[] = ["oos_sharpe", "oos_win_rate", "oos_profit_factor", "oos_total_ret"];

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <AdminNav />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-mono font-bold" style={{ color: GOLD }}>
            Hedged Backtest — Daily Grid Search
          </h2>
          <p className="text-[11px] font-mono mt-1" style={{ color: MUTED }}>
            Every [cycleMin, cycleMax] pair (2-20) × gap (0-5) × mode (exclusive/reuse).
            {results.length > 0 && ` ${results.length} configurations tested.`}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 font-mono text-sm" style={{ color: MUTED }}>
          Loading backtest results...
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 font-mono text-sm" style={{ color: MUTED }}>
          No results yet. Run: node backend/hedged-backtest.cjs
        </div>
      ) : (
        <>
          {/* Controls */}
          <div
            className="rounded-xl p-4 mb-6 flex items-center gap-6 flex-wrap"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <div>
              <div className="text-[9px] font-mono uppercase tracking-wider mb-1" style={{ color: MUTED }}>Metric</div>
              <div className="flex gap-1">
                {metrics.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMetric(m)}
                    className="px-2 py-1 text-[10px] font-mono rounded transition-all"
                    style={{
                      background: metric === m ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.05)",
                      border: `1px solid ${metric === m ? "rgba(212,168,67,0.3)" : "rgba(255,255,255,0.08)"}`,
                      color: metric === m ? GOLD : MUTED,
                    }}
                  >
                    {metricLabel(m)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[9px] font-mono uppercase tracking-wider mb-1" style={{ color: MUTED }}>Mode</div>
              <div className="flex gap-1">
                {["exclusive", "reuse"].map((m) => (
                  <button
                    key={m}
                    onClick={() => setModeFilter(m)}
                    className="px-2 py-1 text-[10px] font-mono rounded transition-all"
                    style={{
                      background: modeFilter === m ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.05)",
                      border: `1px solid ${modeFilter === m ? "rgba(212,168,67,0.3)" : "rgba(255,255,255,0.08)"}`,
                      color: modeFilter === m ? GOLD : MUTED,
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[9px] font-mono uppercase tracking-wider mb-1" style={{ color: MUTED }}>Gap</div>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4, 5].map((g) => (
                  <button
                    key={g}
                    onClick={() => setGapFilter(g)}
                    className="px-2 py-1 text-[10px] font-mono rounded transition-all"
                    style={{
                      background: gapFilter === g ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.05)",
                      border: `1px solid ${gapFilter === g ? "rgba(212,168,67,0.3)" : "rgba(255,255,255,0.08)"}`,
                      color: gapFilter === g ? GOLD : MUTED,
                    }}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Heatmap */}
          <div className="mb-6">
            <h3 className="text-[12px] font-mono font-bold mb-3" style={{ color: GOLD }}>
              {metricLabel(metric)} Heatmap — {modeFilter} mode, gap={gapFilter}
            </h3>
            <div className="overflow-x-auto">
              <table className="text-[9px] font-mono border-collapse">
                <thead>
                  <tr>
                    <th className="p-1 text-right" style={{ color: MUTED }}>min\max</th>
                    {cycleMaxValues.map((cMax) => (
                      <th key={cMax} className="p-1 text-center" style={{ color: MUTED, minWidth: 36 }}>
                        {cMax}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cycleMinValues.map((cMin) => (
                    <tr key={cMin}>
                      <td className="p-1 text-right font-bold" style={{ color: MUTED }}>{cMin}</td>
                      {cycleMaxValues.map((cMax) => {
                        if (cMax <= cMin) {
                          return <td key={cMax} className="p-1" />;
                        }
                        const r = heatLookup[`${cMin}-${cMax}`];
                        if (!r || r.oos_trade_count < 3) {
                          return (
                            <td key={cMax} className="p-1 text-center" style={{ color: "rgba(255,255,255,0.1)" }}>
                              —
                            </td>
                          );
                        }
                        const val = r[metric] as number;
                        return (
                          <td
                            key={cMax}
                            className="p-1 text-center font-bold rounded"
                            style={{ background: heatColor(val, metric), color: "rgba(255,255,255,0.9)" }}
                            title={`C${cMin}-${cMax}: ${fmtMetric(val, metric)} (${r.oos_trade_count} pairs)`}
                          >
                            {fmtMetric(val, metric)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Best config + gap degradation */}
          {best && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div
                className="rounded-xl p-4"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(34,197,94,0.15)" }}
              >
                <div className="text-[11px] font-mono font-bold mb-3" style={{ color: GREEN }}>
                  Best Configuration
                </div>
                <div className="grid grid-cols-2 gap-3 text-[10px] font-mono">
                  <div>
                    <span style={{ color: MUTED }}>Cycles: </span>
                    <span className="font-bold text-white">{best.cycle_min}-{best.cycle_max}</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>Mode: </span>
                    <span className="font-bold text-white">{best.pair_mode}</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>Gap: </span>
                    <span className="font-bold text-white">{best.max_gap}</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>Pairs: </span>
                    <span className="font-bold text-white">{best.oos_trade_count} (T1={best.oos_t1_count})</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>OOS Sharpe: </span>
                    <span className="font-bold" style={{ color: best.oos_sharpe > 0 ? GREEN : RED }}>{best.oos_sharpe.toFixed(2)}</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>IS Sharpe: </span>
                    <span className="font-bold" style={{ color: best.is_sharpe > 0 ? GREEN : RED }}>{best.is_sharpe.toFixed(2)}</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>OOS WR: </span>
                    <span className="font-bold text-white">{best.oos_win_rate.toFixed(1)}%</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>OOS Return: </span>
                    <span className="font-bold" style={{ color: best.oos_total_ret > 0 ? GREEN : RED }}>
                      {best.oos_total_ret >= 0 ? "+" : ""}{best.oos_total_ret.toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>Unhedged SR: </span>
                    <span className="font-bold" style={{ color: MUTED }}>{best.oos_unhedged_sharpe.toFixed(2)}</span>
                  </div>
                  <div>
                    <span style={{ color: MUTED }}>PF: </span>
                    <span className="font-bold text-white">{best.oos_profit_factor.toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Gap degradation */}
              <div
                className="rounded-xl p-4"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                <div className="text-[11px] font-mono font-bold mb-3" style={{ color: GOLD }}>
                  Gap Degradation — C{best.cycle_min}-{best.cycle_max}
                </div>
                <table className="w-full text-[10px] font-mono">
                  <thead>
                    <tr style={{ color: MUTED }}>
                      <th className="text-left py-1">Gap</th>
                      <th className="text-left py-1">Mode</th>
                      <th className="text-right py-1">SR</th>
                      <th className="text-right py-1">WR</th>
                      <th className="text-right py-1">Pairs</th>
                      <th className="text-right py-1">Ret%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gapDegradation
                      .sort((a, b) => a.max_gap - b.max_gap || a.pair_mode.localeCompare(b.pair_mode))
                      .map((r, i) => (
                        <tr key={i} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          <td className="py-1">{r.max_gap}</td>
                          <td className="py-1" style={{ color: r.pair_mode === "exclusive" ? BLUE : GOLD }}>
                            {r.pair_mode.slice(0, 4)}
                          </td>
                          <td className="py-1 text-right font-bold" style={{ color: r.oos_sharpe > 0 ? GREEN : RED }}>
                            {r.oos_sharpe.toFixed(2)}
                          </td>
                          <td className="py-1 text-right">{r.oos_win_rate.toFixed(1)}%</td>
                          <td className="py-1 text-right">{r.oos_trade_count}</td>
                          <td className="py-1 text-right" style={{ color: r.oos_total_ret > 0 ? GREEN : RED }}>
                            {r.oos_total_ret >= 0 ? "+" : ""}{r.oos_total_ret.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Top 20 table */}
          <div className="mb-6">
            <h3 className="text-[12px] font-mono font-bold mb-3" style={{ color: GOLD }}>
              Top 20 Configs by OOS Sharpe (min 5 pairs)
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono border-collapse">
                <thead>
                  <tr style={{ color: MUTED, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                    <th className="text-left py-2 px-2">Cycles</th>
                    <th className="text-left py-2 px-2">Mode</th>
                    <th className="text-center py-2 px-2">Gap</th>
                    <th className="text-right py-2 px-2">OOS SR</th>
                    <th className="text-right py-2 px-2">IS SR</th>
                    <th className="text-right py-2 px-2">WR%</th>
                    <th className="text-right py-2 px-2">PF</th>
                    <th className="text-right py-2 px-2">Pairs</th>
                    <th className="text-right py-2 px-2">T1/T2</th>
                    <th className="text-right py-2 px-2">Ret%</th>
                    <th className="text-right py-2 px-2">Coins</th>
                  </tr>
                </thead>
                <tbody>
                  {topResults.map((r, i) => (
                    <tr
                      key={i}
                      style={{
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        background: i === 0 ? "rgba(34,197,94,0.05)" : undefined,
                      }}
                    >
                      <td className="py-1.5 px-2 font-bold text-white">
                        {r.cycle_min}-{r.cycle_max}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: r.pair_mode === "exclusive" ? BLUE : GOLD }}>
                        {r.pair_mode}
                      </td>
                      <td className="py-1.5 px-2 text-center">{r.max_gap}</td>
                      <td className="py-1.5 px-2 text-right font-bold" style={{ color: r.oos_sharpe > 0 ? GREEN : RED }}>
                        {r.oos_sharpe.toFixed(2)}
                      </td>
                      <td className="py-1.5 px-2 text-right" style={{ color: r.is_sharpe > 0 ? GREEN : RED }}>
                        {r.is_sharpe.toFixed(2)}
                      </td>
                      <td className="py-1.5 px-2 text-right">{r.oos_win_rate.toFixed(1)}%</td>
                      <td className="py-1.5 px-2 text-right">{r.oos_profit_factor.toFixed(2)}</td>
                      <td className="py-1.5 px-2 text-right">{r.oos_trade_count}</td>
                      <td className="py-1.5 px-2 text-right" style={{ color: MUTED }}>
                        {r.oos_t1_count}/{r.oos_t2_count}
                      </td>
                      <td className="py-1.5 px-2 text-right" style={{ color: r.oos_total_ret > 0 ? GREEN : RED }}>
                        {r.oos_total_ret >= 0 ? "+" : ""}{r.oos_total_ret.toFixed(1)}%
                      </td>
                      <td className="py-1.5 px-2 text-right" style={{ color: MUTED }}>{r.coins_used}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-coin table */}
          {bestCoins.length > 0 && (
            <div className="mb-6">
              <h3 className="text-[12px] font-mono font-bold mb-3" style={{ color: GOLD }}>
                Per-Coin Analysis — Best config (C{best?.cycle_min}-{best?.cycle_max} {best?.pair_mode} gap={best?.max_gap})
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] font-mono border-collapse">
                  <thead>
                    <tr style={{ color: MUTED, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      <th className="text-left py-2 px-2">Coin</th>
                      <th className="text-right py-2 px-2">Signals</th>
                      <th className="text-right py-2 px-2">L/S</th>
                      <th className="text-right py-2 px-2">Avg Ret</th>
                      <th className="text-right py-2 px-2">WR%</th>
                      <th className="text-right py-2 px-2">Best Cycle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bestCoins.map((c, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        <td className="py-1 px-2 font-bold text-white">{c.symbol.replace("USDT", "")}</td>
                        <td className="py-1 px-2 text-right">{c.oos_signals}</td>
                        <td className="py-1 px-2 text-right" style={{ color: MUTED }}>
                          {c.oos_as_long}L/{c.oos_as_short}S
                        </td>
                        <td className="py-1 px-2 text-right" style={{ color: c.oos_avg_return > 0 ? GREEN : RED }}>
                          {c.oos_avg_return >= 0 ? "+" : ""}{c.oos_avg_return.toFixed(3)}%
                        </td>
                        <td className="py-1 px-2 text-right">{c.oos_win_rate.toFixed(1)}%</td>
                        <td className="py-1 px-2 text-right" style={{ color: GOLD }}>
                          {c.best_cycle != null ? `${c.best_cycle}d` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="text-center mt-6">
        <p className="text-[10px] font-mono" style={{ color: MUTED }}>
          Daily bars · 50/50 IS/OOS split · Hedged = Long A + Short B (or vice versa) · Both legs close at shorter duration
        </p>
      </div>
    </div>
  );
}
