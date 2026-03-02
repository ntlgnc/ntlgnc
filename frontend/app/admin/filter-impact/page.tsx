"use client";

import { useState, useEffect, useCallback } from "react";
import AdminNav from "@/components/AdminNav";

const GOLD = "#D4A843";
const GREEN = "#22c55e";
const RED = "#ef4444";
const MUTED = "rgba(255,255,255,0.4)";

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
  series: Array<{
    time: string;
    symbol: string;
    direction: string;
    hypothetical_return: number;
    inverted_return: number;
    cumulative_inverted: number;
  }>;
};

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

  // Zero line position
  const zeroY = padding + ((maxVal - 0) / range) * chartH;

  // Build path
  const points = series.map((s, i) => {
    const x = padding + (i / (series.length - 1)) * chartW;
    const y = padding + ((maxVal - s.cumulative_inverted) / range) * chartH;
    return `${x},${y}`;
  });
  const linePath = `M${points.join(" L")}`;

  // Fill area to zero line
  const firstX = padding;
  const lastX = padding + chartW;
  const fillPath = `${linePath} L${lastX},${zeroY} L${firstX},${zeroY} Z`;

  const finalValue = values[values.length - 1];
  const isPositive = finalValue >= 0;
  const lineColor = isPositive ? GREEN : RED;
  const fillColor = isPositive ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)";

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {/* Zero line */}
      <line
        x1={padding}
        y1={zeroY}
        x2={width - padding}
        y2={zeroY}
        stroke="rgba(255,255,255,0.1)"
        strokeWidth="1"
        strokeDasharray="3,3"
      />
      {/* Fill */}
      <path d={fillPath} fill={fillColor} />
      {/* Line */}
      <path d={linePath} fill="none" stroke={lineColor} strokeWidth="1.5" />
      {/* End dot */}
      <circle
        cx={padding + chartW}
        cy={padding + ((maxVal - finalValue) / range) * chartH}
        r="3"
        fill={lineColor}
      />
    </svg>
  );
}

function FilterCard({ data }: { data: FilterSeries }) {
  const cumInv = data.cumulative_inverted_return;
  const isPositive = cumInv >= 0;
  const verdictColor =
    data.verdict === "HELPING"
      ? GREEN
      : data.verdict === "HURTING"
      ? RED
      : MUTED;
  const verdictLabel =
    data.verdict === "HELPING"
      ? "✅ HELPING"
      : data.verdict === "HURTING"
      ? "❌ HURTING"
      : "⏳ Insufficient data";

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
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-[13px] font-mono font-bold text-white">
            #{data.filter_id} {data.feature}
          </span>
          <span
            className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{
              background: "rgba(255,255,255,0.06)",
              color: MUTED,
            }}
          >
            {(data.timeframe || "all").toUpperCase()}
          </span>
        </div>
        <span className="text-[11px] font-mono" style={{ color: verdictColor }}>
          {verdictLabel}
        </span>
      </div>

      {/* Stats row */}
      <div className="flex gap-4 mb-3 text-[10px] font-mono" style={{ color: MUTED }}>
        <span>
          Block rate:{" "}
          <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.block_rate}%</span>
        </span>
        <span>
          Evaluated:{" "}
          <span style={{ color: "rgba(255,255,255,0.7)" }}>{data.evaluated}</span>
        </span>
        <span>
          Active:{" "}
          <span style={{ color: "rgba(255,255,255,0.7)" }}>{hoursActive}h</span>
        </span>
        <span>
          Filtered:{" "}
          <span style={{ color: "rgba(255,255,255,0.7)" }}>
            {data.trades_filtered}
          </span>
        </span>
      </div>

      {/* Chart */}
      <MiniChart data={data} width={380} height={100} />

      {/* Cumulative return */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>
          Cumulative filter value
        </span>
        <span
          className="text-[16px] font-mono font-black tabular-nums"
          style={{ color: isPositive ? GREEN : RED }}
        >
          {isPositive ? "+" : ""}
          {cumInv.toFixed(2)}%
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>
          Per trade avg
        </span>
        <span
          className="text-[11px] font-mono font-bold tabular-nums"
          style={{ color: data.avg_inverted_per_trade >= 0 ? GREEN : RED }}
        >
          {data.avg_inverted_per_trade >= 0 ? "+" : ""}
          {data.avg_inverted_per_trade.toFixed(4)}%
        </span>
      </div>
    </div>
  );
}

// Compact thumbnail version for embedding in other pages
export function FilterImpactThumbnail({ data }: { data: FilterSeries }) {
  const cumInv = data.cumulative_inverted_return;
  const isPositive = cumInv >= 0;
  return (
    <div className="inline-block">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-mono" style={{ color: MUTED }}>
          #{data.filter_id} {data.feature}
        </span>
        <span
          className="text-[10px] font-mono font-bold tabular-nums"
          style={{ color: isPositive ? GREEN : RED }}
        >
          {isPositive ? "+" : ""}
          {cumInv.toFixed(2)}%
        </span>
      </div>
      <MiniChart data={data} width={180} height={50} />
    </div>
  );
}

export default function FilterImpactDashboard() {
  const [filters, setFilters] = useState<Record<string, FilterSeries>>({});
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(168);

  const load = useCallback(() => {
    fetch(`/api/board/filter-impact?hours=${hours}`)
      .then((r) => r.json())
      .then((d) => {
        if (d && !d.error) setFilters(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [hours]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000); // Refresh every minute
    return () => clearInterval(iv);
  }, [load]);

  const filterList = Object.values(filters).sort(
    (a, b) => b.cumulative_inverted_return - a.cumulative_inverted_return
  );

  // Aggregate stats
  const totalFiltered = filterList.reduce((s, f) => s + f.trades_filtered, 0);
  const totalPassed = filterList.reduce((s, f) => s + f.trades_passed, 0);
  const totalInverted = filterList.reduce(
    (s, f) => s + f.cumulative_inverted_return,
    0
  );
  const helping = filterList.filter((f) => f.verdict === "HELPING").length;
  const hurting = filterList.filter((f) => f.verdict === "HURTING").length;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <AdminNav />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-mono font-bold" style={{ color: GOLD }}>
            Filter Impact — Live
          </h2>
          <p
            className="text-[11px] font-mono mt-1"
            style={{ color: MUTED }}
          >
            Cumulative inverted returns of blocked signals. Rising = filter is saving
            money. Falling = filter is blocking winners.
          </p>
        </div>
        <div className="flex gap-2">
          {[24, 72, 168].map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className="text-[10px] font-mono px-2 py-1 rounded transition-all"
              style={{
                background:
                  hours === h ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.05)",
                border: `1px solid ${hours === h ? "rgba(212,168,67,0.3)" : "rgba(255,255,255,0.08)"}`,
                color: hours === h ? GOLD : MUTED,
              }}
            >
              {h}h
            </button>
          ))}
        </div>
      </div>

      {/* Aggregate bar */}
      <div
        className="rounded-xl p-4 mb-6 flex items-center gap-8"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div className="text-center">
          <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: MUTED }}>
            Net Filter Value
          </div>
          <div
            className="text-2xl font-mono font-black tabular-nums"
            style={{ color: totalInverted >= 0 ? GREEN : RED }}
          >
            {totalInverted >= 0 ? "+" : ""}
            {totalInverted.toFixed(2)}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: MUTED }}>
            Blocked
          </div>
          <div className="text-lg font-mono font-bold text-white">{totalFiltered.toLocaleString()}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: MUTED }}>
            Passed
          </div>
          <div className="text-lg font-mono font-bold text-white">{totalPassed.toLocaleString()}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: MUTED }}>
            Block Rate
          </div>
          <div className="text-lg font-mono font-bold text-white">
            {totalFiltered + totalPassed > 0
              ? ((totalFiltered / (totalFiltered + totalPassed)) * 100).toFixed(1)
              : "0"}
            %
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: MUTED }}>
            Helping
          </div>
          <div className="text-lg font-mono font-bold" style={{ color: GREEN }}>{helping}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: MUTED }}>
            Hurting
          </div>
          <div className="text-lg font-mono font-bold" style={{ color: RED }}>{hurting}</div>
        </div>
      </div>

      {/* Filter cards */}
      {loading ? (
        <div className="text-center py-12 font-mono text-sm" style={{ color: MUTED }}>
          Loading filter impact data...
        </div>
      ) : filterList.length === 0 ? (
        <div className="text-center py-12 font-mono text-sm" style={{ color: MUTED }}>
          No active filters found
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filterList.map((f) => (
            <FilterCard key={f.filter_id} data={f} />
          ))}
        </div>
      )}

      <div className="text-center mt-6">
        <p className="text-[10px] font-mono" style={{ color: MUTED }}>
          Auto-refreshes every 60s · Inverted returns: ↑ = filter saved money · ↓ = filter blocked winners
        </p>
      </div>
    </div>
  );
}
