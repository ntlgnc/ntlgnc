"use client";

import { useState, useEffect, useCallback } from "react";

const GOLD = "#D4A843";
const GREEN = "#22c55e";
const RED = "#ef4444";
const BLUE = "#3b82f6";
const ORANGE = "#f97316";
const MUTED = "rgba(255,255,255,0.4)";

// ── Types ──

type FilterSeries = {
  filter_id: number;
  feature: string;
  timeframe: string;
  deployed_at: string;
  trades_passed: number;
  trades_filtered: number;
  block_rate: string;
  evaluated: number;
  cumulative_inverted_return: number;
  avg_inverted_per_trade: number;
  verdict: string;
  source?: string;
  series: Array<{
    time: string;
    symbol: string;
    direction: string;
    hypothetical_return: number;
    inverted_return: number;
    cumulative_inverted: number;
  }>;
};

type MatrixCell = {
  strategy_id: string;
  strategy_name: string;
  bar_minutes: number | null;
  feature_key: string;
  bucket_label: string;
  direction: string;
  mode: string;
  source: string;
  signals_blocked: number;
  counterfactual: { total_return: number; avg_return: number; win_rate: number };
  verdict: string;
};

type CoinGateEntry = {
  symbol: string;
  strategy_id: string;
  strategy_name: string;
  bar_minutes: number | null;
  recent_win_rate: number | null;
  signals_blocked: number;
  counterfactual: { total_return: number; avg_return: number; win_rate: number };
  verdict: string;
};

type Summary = {
  window_hours: number;
  strategies: Array<{ id: string; name: string; barMinutes: number }>;
  totals: {
    signals: number;
    passed: number;
    filtered: number;
    passed_return: number;
    passed_win_rate: number;
    filtered_return: number;
    filtered_win_rate: number;
  };
  by_system: {
    board_filters: { count: number; active_filters: number; total_return: number; avg_return: number; win_rate: number; verdict: string };
    filter_matrix: { count: number; active_locks: number; total_return: number; avg_return: number; win_rate: number; verdict: string };
    coin_gate: { count: number; gated_coins: number; total_return: number; avg_return: number; win_rate: number; verdict: string };
  };
  net_filter_value: number;
  note?: string;
};

type Tab = "all" | "board" | "matrix" | "coin_gate";

function tfLabel(barMinutes: number | null): string {
  if (!barMinutes) return "?";
  if (barMinutes >= 1440) return "1d";
  if (barMinutes >= 60) return "1h";
  return "1m";
}

// ── Sub-components ──

function MiniChart({
  data,
  width = 400,
  height = 120,
}: {
  data: FilterSeries;
  width?: number;
  height?: number;
}) {
  const series = data.series;
  if (series.length < 2) {
    return (
      <div
        className="flex items-center justify-center font-mono text-[10px]"
        style={{ width, height, color: MUTED }}
      >
        Waiting for data ({series.length} signal{series.length !== 1 ? "s" : ""})
      </div>
    );
  }

  const values = series.map((s) => s.cumulative_inverted);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values);
  const range = maxVal - minVal || 1;
  const padding = 4;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;
  const zeroY = padding + ((maxVal - 0) / range) * chartH;

  const points = series.map((s, i) => {
    const x = padding + (i / (series.length - 1)) * chartW;
    const y = padding + ((maxVal - s.cumulative_inverted) / range) * chartH;
    return `${x},${y}`;
  });
  const linePath = `M${points.join(" L")}`;
  const firstX = padding;
  const lastX = padding + chartW;
  const fillPath = `${linePath} L${lastX},${zeroY} L${firstX},${zeroY} Z`;

  const finalValue = values[values.length - 1];
  const isPositive = finalValue >= 0;
  const lineColor = isPositive ? GREEN : RED;
  const fillColor = isPositive ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)";

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <line
        x1={padding} y1={zeroY} x2={width - padding} y2={zeroY}
        stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="3,3"
      />
      <path d={fillPath} fill={fillColor} />
      <path d={linePath} fill="none" stroke={lineColor} strokeWidth="1.5" />
      <circle
        cx={padding + chartW}
        cy={padding + ((maxVal - finalValue) / range) * chartH}
        r="3" fill={lineColor}
      />
    </svg>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const color =
    verdict === "HELPING" ? GREEN : verdict === "HURTING" ? RED : MUTED;
  const label =
    verdict === "HELPING"
      ? "HELPING"
      : verdict === "HURTING"
      ? "HURTING"
      : "INSUFFICIENT";
  return (
    <span
      className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
      style={{ color, background: `${color}15` }}
    >
      {label}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, { color: string; label: string }> = {
    board_filter: { color: GOLD, label: "BOARD" },
    operator: { color: RED, label: "OPERATOR" },
    board_vote: { color: ORANGE, label: "BOARD VOTE" },
    coin_gate: { color: BLUE, label: "COIN GATE" },
  };
  const { color, label } = map[source] || { color: MUTED, label: source.toUpperCase() };
  return (
    <span
      className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ml-2"
      style={{ color, background: `${color}18`, border: `1px solid ${color}30` }}
    >
      {label}
    </span>
  );
}

function StatBox({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: MUTED }}>
        {label}
      </div>
      <div
        className="text-lg font-mono font-bold tabular-nums"
        style={{ color: color || "white" }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Board Filter Card ──

function BoardFilterCard({ data }: { data: FilterSeries }) {
  const cumInv = data.cumulative_inverted_return;
  const isPositive = cumInv >= 0;
  const hoursActive = Math.round(
    (Date.now() - new Date(data.deployed_at).getTime()) / 3600000
  );

  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${isPositive ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)"}`,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center">
          <span className="text-[13px] font-mono font-bold text-white">
            #{data.filter_id} {data.feature}
          </span>
          <SourceBadge source="board_filter" />
        </div>
        <VerdictBadge verdict={data.verdict} />
      </div>
      <div className="flex gap-4 mb-3 text-[10px] font-mono" style={{ color: MUTED }}>
        <span>Block rate: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.block_rate}%</span></span>
        <span>Evaluated: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.evaluated}</span></span>
        <span>Active: <span style={{ color: "rgba(255,255,255,0.7)" }}>{hoursActive}h</span></span>
        <span>Filtered: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.trades_filtered}</span></span>
      </div>
      <MiniChart data={data} width={380} height={100} />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>Cumulative filter value</span>
        <span
          className="text-[16px] font-mono font-black tabular-nums"
          style={{ color: isPositive ? GREEN : RED }}
        >
          {isPositive ? "+" : ""}{cumInv.toFixed(2)}%
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>Per trade avg</span>
        <span
          className="text-[11px] font-mono font-bold tabular-nums"
          style={{ color: data.avg_inverted_per_trade >= 0 ? GREEN : RED }}
        >
          {data.avg_inverted_per_trade >= 0 ? "+" : ""}{data.avg_inverted_per_trade.toFixed(4)}%
        </span>
      </div>
    </div>
  );
}

// ── Matrix Lock Card ──

function MatrixLockCard({ data }: { data: MatrixCell }) {
  const borderColor = data.mode === "locked_block" ? RED : ORANGE;
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${borderColor}30`,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center">
          <span className="text-[13px] font-mono font-bold text-white">
            {data.feature_key}
          </span>
          <span
            className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: "rgba(255,255,255,0.06)", color: MUTED }}
          >
            {data.bucket_label}
          </span>
          <span
            className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded font-bold"
            style={{ background: "rgba(212,168,67,0.1)", color: GOLD, border: `1px solid ${GOLD}30` }}
          >
            {tfLabel(data.bar_minutes)}
          </span>
          <SourceBadge source={data.source} />
        </div>
        <VerdictBadge verdict={data.verdict} />
      </div>
      <div className="flex gap-4 mb-3 text-[10px] font-mono" style={{ color: MUTED }}>
        <span>Strategy: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.strategy_name}</span></span>
        <span>Direction: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.direction}</span></span>
        <span>Mode: <span style={{ color: borderColor }}>{data.mode.replace("_", " ").toUpperCase()}</span></span>
        <span>Blocked: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.signals_blocked}</span></span>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>Counterfactual return</span>
        <span
          className="text-[16px] font-mono font-black tabular-nums"
          style={{ color: data.counterfactual.total_return <= 0 ? GREEN : RED }}
        >
          {data.counterfactual.total_return <= 0 ? "" : "+"}{data.counterfactual.total_return.toFixed(2)}%
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>Avg / Win rate</span>
        <span className="text-[11px] font-mono font-bold tabular-nums" style={{ color: MUTED }}>
          {data.counterfactual.avg_return.toFixed(4)}% / {data.counterfactual.win_rate.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ── Coin Gate Card ──

function CoinGateCard({ data }: { data: CoinGateEntry }) {
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${BLUE}30`,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center">
          <span className="text-[13px] font-mono font-bold text-white">
            {data.symbol}
          </span>
          <span
            className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded font-bold"
            style={{ background: "rgba(212,168,67,0.1)", color: GOLD, border: `1px solid ${GOLD}30` }}
          >
            {tfLabel(data.bar_minutes)}
          </span>
          <SourceBadge source="coin_gate" />
        </div>
        <VerdictBadge verdict={data.verdict} />
      </div>
      <div className="flex gap-4 mb-3 text-[10px] font-mono" style={{ color: MUTED }}>
        <span>Strategy: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.strategy_name}</span></span>
        <span>
          Trailing WR:{" "}
          <span style={{ color: data.recent_win_rate !== null && data.recent_win_rate < 35 ? RED : "rgba(255,255,255,0.7)" }}>
            {data.recent_win_rate !== null ? `${data.recent_win_rate}%` : "N/A"}
          </span>
        </span>
        <span>Blocked: <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.signals_blocked}</span></span>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>Counterfactual return</span>
        <span
          className="text-[16px] font-mono font-black tabular-nums"
          style={{ color: data.counterfactual.total_return <= 0 ? GREEN : RED }}
        >
          {data.counterfactual.total_return <= 0 ? "" : "+"}{data.counterfactual.total_return.toFixed(2)}%
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>Avg / Win rate</span>
        <span className="text-[11px] font-mono font-bold tabular-nums" style={{ color: MUTED }}>
          {data.counterfactual.avg_return.toFixed(4)}% / {data.counterfactual.win_rate.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ── Main Page ──

export default function FilterAuditDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [boardFilters, setBoardFilters] = useState<Record<string, FilterSeries>>({});
  const [matrixLocks, setMatrixLocks] = useState<MatrixCell[]>([]);
  const [coinGate, setCoinGate] = useState<CoinGateEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(168);
  const [tab, setTab] = useState<Tab>("all");

  const load = useCallback(() => {
    setLoading(true);

    const base = `/api/board/filter-audit?hours=${hours}`;

    // Always fetch summary
    fetch(`${base}&action=summary`)
      .then((r) => r.json())
      .then((d) => { if (d && !d.error) setSummary(d); })
      .catch(() => {});

    // Fetch detail data based on active tab
    if (tab === "all" || tab === "board") {
      fetch(`${base}&action=board-filters`)
        .then((r) => r.json())
        .then((d) => { if (d && !d.error) setBoardFilters(d); })
        .catch(() => {});
    }

    if (tab === "all" || tab === "matrix") {
      fetch(`${base}&action=matrix-locks`)
        .then((r) => r.json())
        .then((d) => { if (d?.cells) setMatrixLocks(d.cells); })
        .catch(() => {});
    }

    if (tab === "all" || tab === "coin_gate") {
      fetch(`${base}&action=coin-gate`)
        .then((r) => r.json())
        .then((d) => { if (d?.coins) setCoinGate(d.coins); })
        .catch(() => {});
    }

    // Clear loading after a reasonable time (all fetches fire in parallel)
    setTimeout(() => setLoading(false), 300);
  }, [hours, tab]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  const boardList = Object.values(boardFilters).sort(
    (a, b) => b.cumulative_inverted_return - a.cumulative_inverted_return
  );

  const sys = summary?.by_system;
  const totals = summary?.totals;
  const blockRate =
    totals && totals.filtered + totals.passed > 0
      ? ((totals.filtered / (totals.filtered + totals.passed)) * 100).toFixed(1)
      : "0";

  const tabs: { key: Tab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "board", label: "Board Filters" },
    { key: "matrix", label: "Matrix Locks" },
    { key: "coin_gate", label: "Coin Gate" },
  ];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-mono font-bold" style={{ color: GOLD }}>
            Filter Audit — Unified
          </h2>
          <p className="text-[11px] font-mono mt-1" style={{ color: MUTED }}>
            All 3 filter systems: Board Filters, Matrix Locks, Coin Quality Gate.
            Counterfactual returns show what blocked signals would have earned.
          </p>
        </div>
        <div className="flex gap-2">
          {[24, 72, 168].map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className="text-[10px] font-mono px-2 py-1 rounded transition-all"
              style={{
                background: hours === h ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.05)",
                border: `1px solid ${hours === h ? "rgba(212,168,67,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: hours === h ? GOLD : MUTED,
              }}
            >
              {h}h
            </button>
          ))}
        </div>
      </div>

      {/* KPI bar */}
      <div
        className="rounded-xl p-4 mb-6 flex items-center justify-between gap-4 flex-wrap"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <StatBox
          label="Net Filter Value"
          value={summary ? `${summary.net_filter_value >= 0 ? "+" : ""}${summary.net_filter_value.toFixed(2)}%` : "—"}
          color={summary ? (summary.net_filter_value >= 0 ? GREEN : RED) : MUTED}
        />
        <StatBox
          label="Board Filters"
          value={sys ? `${sys.board_filters.count}` : "—"}
          color={GOLD}
        />
        <StatBox
          label="Matrix Locks"
          value={sys ? `${sys.filter_matrix.count}` : "—"}
          color={ORANGE}
        />
        <StatBox
          label="Coin Gate"
          value={sys ? `${sys.coin_gate.count}` : "—"}
          color={BLUE}
        />
        <StatBox
          label="Total Blocked"
          value={totals ? totals.filtered.toLocaleString() : "—"}
        />
        <StatBox
          label="Block Rate"
          value={totals ? `${blockRate}%` : "—"}
        />
      </div>

      {/* System tabs */}
      <div className="flex gap-2 mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="text-[11px] font-mono px-3 py-1.5 rounded transition-all"
            style={{
              background: tab === t.key ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${tab === t.key ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)"}`,
              color: tab === t.key ? "white" : MUTED,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Cards grid */}
      {loading && !summary ? (
        <div className="text-center py-12 font-mono text-sm" style={{ color: MUTED }}>
          Loading filter audit data...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Board filter cards */}
          {(tab === "all" || tab === "board") &&
            boardList.map((f) => (
              <BoardFilterCard key={`bf-${f.filter_id}`} data={f} />
            ))}

          {/* Matrix lock cards */}
          {(tab === "all" || tab === "matrix") &&
            matrixLocks.map((m, i) => (
              <MatrixLockCard
                key={`ml-${m.strategy_id}-${m.feature_key}-${m.bucket_label}-${m.direction}-${i}`}
                data={m}
              />
            ))}

          {/* Coin gate cards */}
          {(tab === "all" || tab === "coin_gate") &&
            coinGate.map((c, i) => (
              <CoinGateCard key={`cg-${c.symbol}-${c.strategy_id}-${i}`} data={c} />
            ))}
        </div>
      )}

      {/* Empty state per tab */}
      {!loading && tab === "board" && boardList.length === 0 && (
        <div className="text-center py-8 font-mono text-sm" style={{ color: MUTED }}>
          No active board filters in this window
        </div>
      )}
      {!loading && tab === "matrix" && matrixLocks.length === 0 && (
        <div className="text-center py-8 font-mono text-sm" style={{ color: MUTED }}>
          No matrix lock blocks in this window
        </div>
      )}
      {!loading && tab === "coin_gate" && coinGate.length === 0 && (
        <div className="text-center py-8 font-mono text-sm" style={{ color: MUTED }}>
          No coin gate blocks in this window
        </div>
      )}

      {/* Footer */}
      <div className="text-center mt-6">
        <p className="text-[10px] font-mono" style={{ color: MUTED }}>
          Auto-refreshes every 60s · Negative counterfactual = filter saved money ·
          Matrix/coin-gate attribution uses current matrix state (not historical)
        </p>
      </div>
    </div>
  );
}
