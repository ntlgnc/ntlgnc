"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/components/AuthContext";
import Link from "next/link";
import dynamic from "next/dynamic";

const SignalChart = dynamic(() => import("@/components/SignalChart"), { ssr: false });

const GOLD = "#D4A843";
const GREEN = "#22c55e";
const RED = "#ef4444";
const PAGE_SIZE = 20;

type Signal = {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice?: number;
  returnPct?: number;
  status: "open" | "closed";
  createdAt: string;
  closedAt?: string;
  strength?: number;
  holdBars?: number;
  strategyId?: string;
  barMinutes?: number;
};

type PeriodicityKey = "all" | "1m" | "1h" | "1D";
type DirectionKey = "all" | "long" | "short";

// Determine periodicity from barMinutes or heuristics
function getPeriodicity(sig: Signal): "1m" | "1h" | "1D" {
  if (sig.barMinutes != null) {
    if (sig.barMinutes <= 1) return "1m";
    if (sig.barMinutes <= 60) return "1h";
    return "1D";
  }
  // Fallback heuristic from holdBars and duration
  const holdBars = sig.holdBars || 10;
  if (sig.closedAt && sig.createdAt) {
    const dur = new Date(sig.closedAt).getTime() - new Date(sig.createdAt).getTime();
    const perBar = dur / holdBars;
    if (perBar > 12 * 60 * 60_000) return "1D";
    if (perBar > 30 * 60_000) return "1h";
    return "1m";
  }
  if (holdBars > 100) return "1m";
  if (holdBars > 20) return "1h";
  return "1D";
}

function formatDuration(ms: number): string {
  if (ms < 0) return "expired";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

// ─── Mini Equity Curve ──────────────────────────────────────────────────
function MiniEquityCurve({ label, signals, color, prices, filters, timeWindow }: { label: string; signals: Signal[]; color: string; prices: Record<string, number>; filters?: any[]; timeWindow?: "1H" | "1D" | "1W" | "1M" | "ALL" }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [mtmSeries, setMtmSeries] = useState<{ time: string; totalReturn: number }[]>([]);
  const closed = signals.filter(s => s.status === "closed" && s.returnPct != null);
  const openSigs = signals.filter(s => s.status === "open");
  const sorted = [...closed].sort(
    (a, b) => new Date(a.closedAt || a.createdAt).getTime() - new Date(b.closedAt || b.createdAt).getTime()
  );

  // Fetch MTM blended equity curve
  const tf = label === "1M" ? "1m" : label === "1H" ? "1h" : "1d";
  useEffect(() => {
    const fetchMtm = () => {
      fetch(`/api/signals/mtm?tf=${tf}`)
        .then(r => r.json())
        .then(d => { if (d.series && d.series.length > 0) setMtmSeries(d.series); })
        .catch(() => {});
    };
    fetchMtm();
    const iv = setInterval(fetchMtm, 60_000);
    return () => clearInterval(iv);
  }, [tf]);

  // Build closed-only curve (used for stats + fallback)
  const eqCurve = useMemo(() => {
    let cum = 0;
    return sorted.map(s => { cum += s.returnPct || 0; return cum; });
  }, [sorted]);

  // Build display curve: use MTM series if it has data, otherwise closed-only
  const { displayValues, displayTimes } = useMemo(() => {
    if (mtmSeries.length >= 2) {
      return {
        displayValues: mtmSeries.map(p => p.totalReturn),
        displayTimes: mtmSeries.map(p => new Date(p.time).getTime()),
      };
    }
    // Fallback to closed-only
    return {
      displayValues: eqCurve,
      displayTimes: sorted.map(s => new Date(s.closedAt || s.createdAt).getTime()),
    };
  }, [mtmSeries, eqCurve, sorted]);

  // Apply time window filter: crop to the selected range and rebase to 0 at window start
  const { windowValues, windowTimes } = useMemo(() => {
    if (!timeWindow || timeWindow === "ALL" || displayTimes.length < 2) {
      return { windowValues: displayValues, windowTimes: displayTimes };
    }
    const nowMs = Date.now();
    const windowMs: Record<string, number> = { "1H": 60*60*1000, "1D": 24*60*60*1000, "1W": 7*24*60*60*1000, "1M": 30*24*60*60*1000 };
    const cutoff = nowMs - (windowMs[timeWindow] || Infinity);
    
    // Find the last point before the cutoff (or first point after) to use as baseline
    let baselineValue = 0;
    let startIdx = 0;
    for (let i = 0; i < displayTimes.length; i++) {
      if (displayTimes[i] >= cutoff) { startIdx = i; break; }
      baselineValue = displayValues[i];
      startIdx = i + 1;
    }
    // Include one point before cutoff for smooth start, rebased
    const effectiveStart = Math.max(0, startIdx - 1);
    const slicedValues = displayValues.slice(effectiveStart);
    const slicedTimes = displayTimes.slice(effectiveStart);
    const base = slicedValues.length > 0 ? slicedValues[0] : 0;
    
    return {
      windowValues: slicedValues.map(v => +(v - base).toFixed(3)),
      windowTimes: slicedTimes,
    };
  }, [displayValues, displayTimes, timeWindow]);

  const cumReturn = eqCurve.length > 0 ? eqCurve[eqCurve.length - 1] : 0;
  // curveReturn = what the chart actually shows (windowed MTM endpoint)
  // We compute this after unrealisedPnL is available below
  const wins = sorted.filter(s => (s.returnPct || 0) > 0).length;
  const winRate = sorted.length > 0 ? (wins / sorted.length * 100) : 0;
  const mean = sorted.length > 0 ? cumReturn / sorted.length : 0;
  const returns = sorted.map(s => s.returnPct || 0);
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length)
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // Unrealised return for open positions
  const openReturns = openSigs.map(sig => {
    const cp = prices[sig.symbol];
    if (!cp || !sig.entryPrice) return null;
    if (sig.direction === "LONG") return (cp / sig.entryPrice - 1) * 100;
    return (sig.entryPrice / cp - 1) * 100;
  }).filter(r => r !== null) as number[];
  const unrealisedPnL = openReturns.reduce((s, r) => s + r, 0);

  // Chart color should reflect the current total value (closed + live unrealised)
  // This matches what the user sees: if open positions make the portfolio positive, chart is green
  const curveReturn = cumReturn + unrealisedPnL;

  const W = 300, H = 130;

  // Time-based x positions
  const timePositions = useMemo(() => {
    if (windowTimes.length < 2) return windowTimes.map(() => 0);
    const minT = Math.min(...windowTimes);
    const maxT = Math.max(...windowTimes);
    const range = maxT - minT || 1;
    return windowTimes.map(t => ((t - minT) / range) * W);
  }, [windowTimes]);

  const curveD = useMemo(() => {
    if (windowValues.length < 2) return "";
    const minV = Math.min(0, ...windowValues);
    const maxV = Math.max(0, ...windowValues);
    const range = maxV - minV || 1;
    return windowValues.map((v, i) => {
      const x = timePositions[i];
      const y = H - ((v - minV) / range) * (H - 8) - 4;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [windowValues, timePositions]);

  // Area under curve
  const areaD = useMemo(() => {
    if (windowValues.length < 2) return "";
    const minV = Math.min(0, ...windowValues);
    const maxV = Math.max(0, ...windowValues);
    const range = maxV - minV || 1;
    const zeroY = H - ((0 - minV) / range) * (H - 8) - 4;
    const points = windowValues.map((v, i) => {
      const x = timePositions[i];
      const y = H - ((v - minV) / range) * (H - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M0,${zeroY} L${points.join(" L")} L${W},${zeroY} Z`;
  }, [windowValues, timePositions]);

  return (
    <div className="flex-1 min-w-[320px] rounded-xl overflow-hidden relative" style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(212,168,67,0.25)",
    }}>
      {/* Info button */}
      <button
        onClick={() => setShowTooltip(!showTooltip)}
        className="absolute top-2 left-2 z-10 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono font-bold transition-all hover:brightness-150"
        style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.08)" }}
      >?</button>

      {/* Tooltip overlay */}
      {showTooltip && (
        <div className="absolute inset-0 z-20 p-4 flex flex-col justify-between" style={{
          background: "rgba(8,10,16,0.97)", backdropFilter: "blur(8px)",
          border: "1px solid rgba(212,168,67,0.25)", borderRadius: 12,
        }}>
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[12px] font-mono font-bold" style={{ color }}>{label} Bar Strategy</span>
              <button onClick={() => setShowTooltip(false)} className="text-[10px] font-mono text-white/40 hover:text-white/70">✕</button>
            </div>
            <div className="text-[10px] font-mono text-white/60 leading-relaxed space-y-2">
              <p>
                <span className="text-white/90 font-bold">What it does:</span>{" "}
                {label === "1M" ? "Detects movement exhaustions on 1-minute candles. High frequency — ~100+ signals/day. Best for capturing micro-momentum." :
                 label === "1H" ? "Detects movement exhaustions on 1-hour candles. Medium frequency — ~20-40 signals/day. Our highest volume and most backtested strategy." :
                 "Detects movement exhaustions on daily candles. Low frequency — ~2-5 signals/day. Captures larger swing reversals."}
              </p>
              <p>
                <span className="text-white/90 font-bold">How signals work:</span>{" "}
                {label === "1M" ? "Price crosses above/below target level → generates a counter-trend signal with a hold period based on the dominant cycle length." :
                 label === "1H" ? "Price crosses above/below target level → generates a counter-trend signal with a hold period based on the dominant cycle length." :
                 "Price crosses above/below target level → generates a counter-trend signal with a hold period based on the dominant cycle length."}
              </p>
            </div>
          </div>
          {/* Active filters for this timeframe */}
          {filters && filters.length > 0 && (
            <div className="mt-3 pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="text-[9px] font-mono text-white/40 mb-1.5">ACTIVE FILTERS ({filters.length})</div>
              {filters.slice(0, 3).map((f: any, i: number) => (
                <div key={i} className="text-[9px] font-mono text-white/50 mb-1">
                  <span style={{ color: GOLD }}>●</span> {f.feature?.slice(0, 40)}{f.feature?.length > 40 ? '…' : ''}
                </div>
              ))}
              {filters.length > 3 && <div className="text-[9px] font-mono text-white/30">+{filters.length - 3} more</div>}
            </div>
          )}
        </div>
      )}
      <div className="flex">
        {/* Chart - left side */}
        <div className="flex-1 p-3 pr-0 flex items-stretch">
          {displayValues.length > 1 ? (() => {
            const minV = Math.min(0, ...windowValues);
            const maxV = Math.max(0, ...windowValues);
            const range = maxV - minV || 1;
            const zeroY = H - ((0 - minV) / range) * (H - 8) - 4;
            const lineColor = curveReturn >= 0 ? GREEN : RED;
            const endVal = windowValues[windowValues.length - 1] || 0;
            return (
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full" style={{ minHeight: 150 }}>
              <defs>
                <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lineColor} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {/* Zero line */}
              <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="4 4" />
              <path d={areaD} fill={`url(#grad-${label})`} />
              <path d={curveD} fill="none" stroke={lineColor} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {/* End dot */}
              {windowValues.length > 0 && (
                <circle
                  cx={timePositions[timePositions.length - 1]}
                  cy={H - ((endVal - minV) / range) * (H - 8) - 4}
                  r="3" fill={lineColor}
                />
              )}
            </svg>
            );
          })() : (
            <div className="flex items-center justify-center w-full" style={{ minHeight: 150 }}>
              <span className="text-[10px] font-mono text-white/80">No closed trades</span>
            </div>
          )}
        </div>

        {/* Stats - right side */}
        <div className="shrink-0 p-3 pl-2 flex flex-col justify-between items-end">
          {/* Header badge */}
          <div className="flex items-center gap-1.5 mb-2.5">
            <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold"
              style={{ background: `${color}15`, color }}>{label}</span>
            <span className="text-[10px] font-mono text-white/80">Bar Signals</span>
          </div>

          {/* Closed row: count + return */}
          <div className="w-full mb-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[8px] font-mono text-white/65 w-[34px] text-right">closed</span>
              <span className="text-[11px] font-mono font-bold text-white/85 tabular-nums">{sorted.length}</span>
              <span className="text-[14px] font-mono font-black tabular-nums leading-tight ml-auto"
                style={{ color: cumReturn >= 0 ? GREEN : RED }}>
                {cumReturn >= 0 ? "+" : ""}{cumReturn.toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Open row: count + return */}
          <div className="w-full mb-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 8 }}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[8px] font-mono text-white/65 w-[34px] text-right">open</span>
              <span className="text-[11px] font-mono font-bold text-white/85 tabular-nums">{openSigs.length}</span>
              {openReturns.length > 0 ? (
                <span className="text-[12px] font-mono font-bold tabular-nums leading-tight ml-auto"
                  style={{ color: unrealisedPnL >= 0 ? GREEN : RED }}>
                  {unrealisedPnL >= 0 ? "+" : ""}{unrealisedPnL.toFixed(2)}%
                </span>
              ) : (
                <span className="text-[11px] font-mono text-white/80 ml-auto">—</span>
              )}
            </div>
          </div>

          {/* Detailed stats */}
          <div className="w-full space-y-0.5">
            {[
              { l: "Win", v: `${winRate.toFixed(0)}%` },
              { l: "Sharpe", v: sharpe.toFixed(2) },
              { l: "Avg", v: `${mean >= 0 ? "+" : ""}${mean.toFixed(3)}%` },
            ].map(s => (
              <div key={s.l} className="flex items-baseline gap-1.5">
                <span className="text-[8px] font-mono uppercase tracking-wider text-white/65 w-[34px] text-right">{s.l}</span>
                <span className="text-[11px] font-mono font-bold text-white/75 tabular-nums">{s.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Daily Performance Table ────────────────────────────────────────────
function DailyPerformance({ signals }: { signals: Signal[] }) {
  const closed = signals.filter(s => s.status === "closed" && s.returnPct != null);

  // Group by date and periodicity
  const dailyData = useMemo(() => {
    type DayRow = { date: string; periodicity: string; trades: number; wins: number; totalRet: number; returns: number[] };
    const map = new Map<string, DayRow>();

    closed.forEach(s => {
      const date = new Date(s.closedAt || s.createdAt).toISOString().slice(0, 10);
      const p = getPeriodicity(s).toUpperCase();
      const key = `${date}|${p}`;
      if (!map.has(key)) map.set(key, { date, periodicity: p, trades: 0, wins: 0, totalRet: 0, returns: [] });
      const row = map.get(key)!;
      row.trades++;
      row.returns.push(s.returnPct || 0);
      row.totalRet += s.returnPct || 0;
      if ((s.returnPct || 0) > 0) row.wins++;
    });

    // Also compute "ALL" rows per date
    const dateMap = new Map<string, DayRow>();
    closed.forEach(s => {
      const date = new Date(s.closedAt || s.createdAt).toISOString().slice(0, 10);
      if (!dateMap.has(date)) dateMap.set(date, { date, periodicity: "ALL", trades: 0, wins: 0, totalRet: 0, returns: [] });
      const row = dateMap.get(date)!;
      row.trades++;
      row.returns.push(s.returnPct || 0);
      row.totalRet += s.returnPct || 0;
      if ((s.returnPct || 0) > 0) row.wins++;
    });

    dateMap.forEach((v, k) => map.set(`${k}|ALL`, v));

    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date) || a.periodicity.localeCompare(b.periodicity));
  }, [closed]);

  const [dpFilter, setDpFilter] = useState<"ALL" | "1M" | "1H" | "1D">("ALL");
  const [dpPage, setDpPage] = useState(0);
  const [dpChartMode, setDpChartMode] = useState<"cumulative" | "daily">("cumulative");
  const DP_PAGE_SIZE = 10;

  const filteredDaily = useMemo(() => {
    return dailyData.filter(d => d.periodicity === dpFilter);
  }, [dailyData, dpFilter]);

  // Reset page when filter changes
  useEffect(() => { setDpPage(0); }, [dpFilter]);

  // Summary stats across all filtered days
  const summary = useMemo(() => {
    if (filteredDaily.length === 0) return { avgTrades: 0, avgWinRate: 0, avgRet: 0, sharpe: 0, days: 0 };
    const days = filteredDaily.length;
    const totalTrades = filteredDaily.reduce((s, d) => s + d.trades, 0);
    const totalWins = filteredDaily.reduce((s, d) => s + d.wins, 0);
    const dailyReturns = filteredDaily.map(d => d.totalRet);
    const meanDailyRet = dailyReturns.reduce((s, r) => s + r, 0) / days;
    const std = days > 1
      ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanDailyRet) ** 2, 0) / days)
      : 0;
    const sharpe = std > 0 ? (meanDailyRet / std) * Math.sqrt(252) : 0;
    const avgWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
    return {
      days,
      avgTrades: totalTrades / days,
      avgWinRate,
      avgRet: meanDailyRet,
      sharpe,
    };
  }, [filteredDaily]);

  const periodicityColor = (p: string) => {
    if (p === "1M") return "#3b82f6";
    if (p === "1H") return "#a78bfa";
    if (p === "1D") return GOLD;
    return "rgba(255,255,255,0.6)";
  };

  return (
    <div className="rounded-xl overflow-hidden" style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(212,168,67,0.25)",
    }}>
      {/* Header */}
      <div className="p-3 pb-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-mono font-bold text-white/80">Daily Performance</span>
          <div className="flex gap-px rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
            {(["ALL", "1M", "1H", "1D"] as const).map(f => (
              <button key={f} onClick={() => setDpFilter(f)}
                className="px-2 py-0.5 text-[9px] font-mono"
                style={{
                  background: dpFilter === f ? "rgba(212,168,67,0.1)" : "transparent",
                  color: dpFilter === f ? GOLD : "rgba(255,255,255,0.5)",
                }}>{f}</button>
            ))}
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-2 mb-2 pb-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          {[
            { l: "Daily SR", v: summary.sharpe.toFixed(2) },
            { l: "Avg Signals", v: summary.avgTrades.toFixed(0) },
            { l: "Win Rate", v: `${summary.avgWinRate.toFixed(0)}%` },
            { l: "Avg Rtn", v: `${summary.avgRet >= 0 ? "+" : ""}${summary.avgRet.toFixed(3)}%` },
          ].map(s => (
            <div key={s.l} className="text-center">
              <div className="text-[7px] font-mono uppercase tracking-wider text-white/45">{s.l}</div>
              <div className="text-[11px] font-mono font-bold text-white/75 tabular-nums">{s.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Daily Chart */}
      {(() => {
        // Sort chronologically for chart (oldest first)
        const chronoDaily = [...filteredDaily].reverse();
        const dailyReturns = chronoDaily.map(d => d.totalRet);

        if (dailyReturns.length === 0) return null;

        // Cumulative curve
        let cum = 0;
        const cumReturns = dailyReturns.map(r => { cum += r; return cum; });

        const CW = 300, CH = 60;
        const data = dpChartMode === "cumulative" ? cumReturns : dailyReturns;
        const minV = Math.min(0, ...data);
        const maxV = Math.max(0, ...data);
        const range = maxV - minV || 1;
        const yFor = (v: number) => CH - 4 - ((v - minV) / range) * (CH - 8);
        const zeroY = yFor(0);

        return (
          <div className="px-3 pb-2">
            {/* Toggle */}
            <div className="flex items-center justify-end mb-1">
              <div className="flex gap-px rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
                {(["cumulative", "daily"] as const).map(m => (
                  <button key={m} onClick={() => setDpChartMode(m)}
                    className="px-2 py-px text-[8px] font-mono capitalize"
                    style={{
                      background: dpChartMode === m ? "rgba(212,168,67,0.1)" : "transparent",
                      color: dpChartMode === m ? GOLD : "rgba(255,255,255,0.4)",
                    }}>{m}</button>
                ))}
              </div>
            </div>

            <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" className="w-full" style={{ height: 60 }}>
              {/* Zero line */}
              <line x1={0} y1={zeroY} x2={CW} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeDasharray="3 2" />

              {dpChartMode === "cumulative" ? (
                <>
                  {/* Area fill */}
                  <path d={(() => {
                    if (data.length < 2) return "";
                    const pts = data.map((v, i) => {
                      const x = (i / (data.length - 1)) * CW;
                      return `${x.toFixed(1)},${yFor(v).toFixed(1)}`;
                    });
                    return `M0,${zeroY} L${pts.join(" L")} L${CW},${zeroY} Z`;
                  })()} fill={cum >= 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)"} />
                  {/* Line */}
                  <path d={data.map((v, i) => {
                    const x = (i / (data.length - 1)) * CW;
                    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yFor(v).toFixed(1)}`;
                  }).join(" ")} fill="none" stroke={cum >= 0 ? GREEN : RED} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                </>
              ) : (
                <>
                  {/* Histogram bars */}
                  {data.map((v, i) => {
                    const barW = Math.max(1, CW / data.length - 1);
                    const x = (i / data.length) * CW + 0.5;
                    const barH = Math.abs(yFor(v) - zeroY);
                    const y = v >= 0 ? yFor(v) : zeroY;
                    return (
                      <rect key={i} x={x} y={y} width={barW} height={Math.max(0.5, barH)}
                        fill={v >= 0 ? GREEN : RED} opacity={0.7} rx={0.5} />
                    );
                  })}
                </>
              )}
            </svg>
          </div>
        );
      })()}

      {/* Table */}
      {(() => {
        const dpTotalPages = Math.ceil(filteredDaily.length / DP_PAGE_SIZE);
        const dpPaged = filteredDaily.slice(dpPage * DP_PAGE_SIZE, (dpPage + 1) * DP_PAGE_SIZE);
        return (
          <>
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-white/60" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <th className="text-left py-1.5 px-3 font-mono font-semibold">Date</th>
              <th className="text-right py-1.5 px-2 font-mono font-semibold">Signals</th>
              <th className="text-right py-1.5 px-2 font-mono font-semibold">Avg Rtn</th>
              <th className="text-right py-1.5 px-3 font-mono font-semibold">Day Rtn</th>
            </tr>
          </thead>
          <tbody>
            {dpPaged.length === 0 && (
              <tr><td colSpan={4} className="py-6 text-center text-white/40 font-mono">No daily data</td></tr>
            )}
            {dpPaged.map((d, i) => {
              const avgRet = d.trades > 0 ? d.totalRet / d.trades : 0;
              return (
                <tr key={`${d.date}-${d.periodicity}-${i}`} className="hover:bg-white/[0.02]"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                  <td className="py-1.5 px-3 font-mono tabular-nums text-white/65">
                    {d.date.slice(5)}
                  </td>
                  <td className="py-1.5 px-2 font-mono tabular-nums text-right text-white/65">
                    {d.trades}
                  </td>
                  <td className="py-1.5 px-2 font-mono tabular-nums text-right"
                    style={{ color: avgRet >= 0 ? GREEN : RED }}>
                    {avgRet >= 0 ? "+" : ""}{avgRet.toFixed(3)}%
                  </td>
                  <td className="py-1.5 px-3 font-mono tabular-nums text-right font-bold"
                    style={{ color: d.totalRet >= 0 ? GREEN : RED }}>
                    {d.totalRet >= 0 ? "+" : ""}{d.totalRet.toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {dpTotalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-2" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <button onClick={() => setDpPage(p => Math.max(0, p - 1))} disabled={dpPage === 0}
              className="px-2 py-0.5 text-[9px] font-mono rounded"
              style={{
                color: dpPage === 0 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.6)",
                background: "rgba(255,255,255,0.03)",
              }}>‹</button>
            <span className="text-[9px] font-mono text-white/50 tabular-nums">
              {dpPage + 1}/{dpTotalPages}
            </span>
            <button onClick={() => setDpPage(p => Math.min(dpTotalPages - 1, p + 1))} disabled={dpPage >= dpTotalPages - 1}
              className="px-2 py-0.5 text-[9px] font-mono rounded"
              style={{
                color: dpPage >= dpTotalPages - 1 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.6)",
                background: "rgba(255,255,255,0.03)",
              }}>›</button>
          </div>
        )}
          </>
        );
      })()}
    </div>
  );
}

// ─── Seat Market Card ───────────────────────────────────────────────────
type SeatStatus = {
  cap: number;
  activeSeats: number;
  remaining: number;
  forSale: number;
  cheapestSeat: number | null;
  avgAsk: number | null;
  pricing: Record<string, number>;
  recentSales: { amount: number; commission: number; created_at: string }[];
};

function SeatMarket() {
  const [data, setData] = useState<SeatStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/seats?action=status")
      .then(r => r.json())
      .then(d => { if (!d.error) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const lastSale = data?.recentSales?.[0];

  return (
    <div className="rounded-xl overflow-hidden mt-3" style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(212,168,67,0.25)",
    }}>
      <div className="p-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-mono font-bold text-white/80">Seat Market</span>
          <Link href="/pricing" className="text-[9px] font-mono" style={{ color: GOLD }}>
            View pricing →
          </Link>
        </div>

        {loading ? (
          <div className="py-6 text-center">
            <span className="text-[10px] font-mono text-white/40">Loading…</span>
          </div>
        ) : data ? (
          <>
            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-3">
              <div>
                <div className="text-[7px] font-mono uppercase tracking-wider text-white/40">Seats Active</div>
                <div className="text-[13px] font-mono font-bold text-white/80 tabular-nums">
                  {data.activeSeats.toLocaleString()}
                  <span className="text-[9px] text-white/40 font-normal"> / {(data.cap / 1000)}k</span>
                </div>
              </div>
              <div>
                <div className="text-[7px] font-mono uppercase tracking-wider text-white/40">Available</div>
                <div className="text-[13px] font-mono font-bold tabular-nums" style={{ color: data.remaining > 0 ? GREEN : RED }}>
                  {data.remaining > 0 ? data.remaining.toLocaleString() : "Sold Out"}
                </div>
              </div>
              <div>
                <div className="text-[7px] font-mono uppercase tracking-wider text-white/40">For Sale</div>
                <div className="text-[13px] font-mono font-bold text-white/80 tabular-nums">
                  {data.forSale > 0 ? data.forSale : "None"}
                </div>
              </div>
              <div>
                <div className="text-[7px] font-mono uppercase tracking-wider text-white/40">
                  {data.forSale > 0 ? "Cheapest" : "Base Price"}
                </div>
                <div className="text-[13px] font-mono font-bold tabular-nums" style={{ color: GOLD }}>
                  ${data.forSale > 0 && data.cheapestSeat ? data.cheapestSeat.toFixed(2) : data.pricing["1"]?.toFixed(2) || "20.00"}
                  <span className="text-[9px] text-white/40 font-normal">/mo</span>
                </div>
              </div>
            </div>

            {/* Price range bar */}
            {data.forSale > 0 && data.cheapestSeat && data.avgAsk && (
              <div className="mb-3 pb-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="flex items-center justify-between text-[8px] font-mono text-white/40 mb-1">
                  <span>Price Range</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <div className="h-full rounded-full" style={{
                    background: `linear-gradient(90deg, ${GREEN}, ${GOLD})`,
                    width: "60%",
                  }} />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[9px] font-mono" style={{ color: GREEN }}>${data.cheapestSeat.toFixed(2)}</span>
                  <span className="text-[9px] font-mono" style={{ color: GOLD }}>${data.avgAsk.toFixed(2)} avg</span>
                </div>
              </div>
            )}

            {/* Last sale */}
            {lastSale && (
              <div className="flex items-center justify-between py-2 px-2 rounded-lg" style={{ background: "rgba(255,255,255,0.02)" }}>
                <div>
                  <div className="text-[7px] font-mono uppercase tracking-wider text-white/40">Last Seat Sold</div>
                  <div className="text-[11px] font-mono font-bold text-white/70 tabular-nums">
                    ${lastSale.amount.toFixed(2)}
                    <span className="text-[9px] text-white/40 font-normal ml-1">
                      ({new Date(lastSale.created_at).toLocaleDateString([], { month: "short", day: "numeric" })})
                    </span>
                  </div>
                </div>
                <span className="text-[8px] font-mono text-white/30">{lastSale.commission > 0 ? "resale" : "direct"}</span>
              </div>
            )}

            {/* No activity state */}
            {data.activeSeats === 0 && !lastSale && (
              <div className="py-4 text-center" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <div className="text-[10px] font-mono text-white/35 mb-2">No seats sold yet</div>
                <Link href="/pricing" className="px-4 py-1.5 rounded text-[10px] font-mono font-bold inline-block"
                  style={{ background: GOLD, color: "#000" }}>
                  Be the first
                </Link>
              </div>
            )}
          </>
        ) : (
          <div className="py-6 text-center">
            <span className="text-[10px] font-mono text-white/40">Unable to load seat data</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Net Position Card ──────────────────────────────────────────────────
const NET_POSITION_DELAY_MINS = 5; // configurable: try 5, 10, 15 etc.

function NetPosition({ signals, isPaid }: { signals: Signal[]; isPaid: boolean }) {
  const [coinCount, setCoinCount] = useState<number>(0);
  const [npFilter, setNpFilter] = useState<"ALL" | "1M" | "1H" | "1D">("ALL");
  const [chartMode, setChartMode] = useState<"24h" | "daily">("24h");

  const delayMs = isPaid ? 0 : NET_POSITION_DELAY_MINS * 60 * 1000;

  // Fetch coin universe size
  useEffect(() => {
    fetch("/api/coins")
      .then(r => r.json())
      .then(d => { if (d.count) setCoinCount(d.count); })
      .catch(() => {});
  }, []);

  // For free users: compute positions as they were N minutes ago
  // This means: ignore signals created within the delay window,
  // and treat signals closed within the delay window as still open
  const effectiveSignals = useMemo(() => {
    if (isPaid) return signals;
    const cutoff = Date.now() - delayMs;
    return signals
      .filter(s => new Date(s.createdAt).getTime() <= cutoff)
      .map(s => {
        // If closed within the delay window, treat as still open at the cutoff time
        if (s.status === "closed" && s.closedAt && new Date(s.closedAt).getTime() > cutoff) {
          return { ...s, status: "open" as const, closedAt: undefined, returnPct: undefined };
        }
        return s;
      });
  }, [signals, isPaid, delayMs]);

  // Filter open signals by periodicity
  const openFiltered = useMemo(() => {
    const open = effectiveSignals.filter(s => s.status === "open");
    if (npFilter === "ALL") return open;
    return open.filter(s => {
      const p = getPeriodicity(s).toUpperCase();
      return p === npFilter;
    });
  }, [effectiveSignals, npFilter]);

  // Net position: longs - shorts
  const longs = openFiltered.filter(s => s.direction === "LONG").length;
  const shorts = openFiltered.filter(s => s.direction === "SHORT").length;
  const net = longs - shorts;
  const totalOpen = openFiltered.length;
  const netPct = coinCount > 0 ? (net / coinCount * 100) : 0;
  const exposurePct = coinCount > 0 ? (totalOpen / coinCount * 100) : 0;

  // Unique coins with open positions
  const uniqueCoins = new Set(openFiltered.map(s => s.symbol)).size;
  const coveragePct = coinCount > 0 ? (uniqueCoins / coinCount * 100) : 0;

  // Build hourly position history from all signals (last 24h)
  const hourlyHistory = useMemo(() => {
    const now = isPaid ? Date.now() : Date.now() - delayMs;
    const hours: { time: string; net: number; longs: number; shorts: number }[] = [];

    for (let h = 23; h >= 0; h--) {
      const t = now - h * 3600_000;
      const tDate = new Date(t);
      const label = tDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      // Signals that were open at time t
      const openAtT = effectiveSignals.filter(s => {
        if (npFilter !== "ALL" && getPeriodicity(s).toUpperCase() !== npFilter) return false;
        const created = new Date(s.createdAt).getTime();
        if (created > t) return false;
        if (s.status === "closed" && s.closedAt) {
          const closed = new Date(s.closedAt).getTime();
          if (closed < t) return false;
        }
        return true;
      });

      const l = openAtT.filter(s => s.direction === "LONG").length;
      const sh = openAtT.filter(s => s.direction === "SHORT").length;
      hours.push({ time: label, net: l - sh, longs: l, shorts: sh });
    }
    return hours;
  }, [effectiveSignals, npFilter, isPaid, delayMs]);

  // Build daily position history
  const dailyHistory = useMemo(() => {
    const dateMap = new Map<string, { longs: number; shorts: number }>();

    effectiveSignals.forEach(s => {
      if (npFilter !== "ALL" && getPeriodicity(s).toUpperCase() !== npFilter) return;
      const date = new Date(s.createdAt).toISOString().slice(0, 10);
      if (!dateMap.has(date)) dateMap.set(date, { longs: 0, shorts: 0 });
      const row = dateMap.get(date)!;
      if (s.direction === "LONG") row.longs++;
      else row.shorts++;
    });

    return Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date: date.slice(5), net: v.longs - v.shorts, longs: v.longs, shorts: v.shorts }));
  }, [effectiveSignals, npFilter]);

  // Chart rendering
  const chartData = chartMode === "24h"
    ? hourlyHistory.map(h => h.net)
    : dailyHistory.map(d => d.net);

  const CW = 300, CH = 50;
  const minV = Math.min(0, ...chartData);
  const maxV = Math.max(0, ...chartData);
  const range = maxV - minV || 1;
  const yFor = (v: number) => CH - 3 - ((v - minV) / range) * (CH - 6);
  const zeroY = yFor(0);

  return (
    <div className="rounded-xl overflow-hidden mt-3" style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(212,168,67,0.25)",
    }}>
      {/* Delayed data banner for free users */}
      {!isPaid && (
        <div className="text-center px-3 py-1" style={{
          background: "rgba(212,168,67,0.12)",
          borderBottom: "1px solid rgba(212,168,67,0.15)",
        }}>
          <Link href="/pricing" className="text-[10px] font-mono font-bold" style={{ color: GOLD }}>
            {NET_POSITION_DELAY_MINS}m delayed data – Buy a seat for live →
          </Link>
        </div>
      )}

      <div className="p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-mono font-bold text-white/80">Net Position</span>
          <div className="flex gap-px rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
            {(["ALL", "1M", "1H", "1D"] as const).map(f => (
              <button key={f} onClick={() => setNpFilter(f)}
                className="px-2 py-0.5 text-[9px] font-mono"
                style={{
                  background: npFilter === f ? "rgba(212,168,67,0.1)" : "transparent",
                  color: npFilter === f ? GOLD : "rgba(255,255,255,0.5)",
                }}>{f}</button>
            ))}
          </div>
        </div>

        {/* Net position headline */}
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-[20px] font-mono font-black tabular-nums"
            style={{ color: net > 0 ? GREEN : net < 0 ? RED : "rgba(255,255,255,0.6)" }}>
            {net > 0 ? "+" : ""}{net}
          </span>
          <span className="text-[10px] font-mono text-white/50">
            net ({netPct >= 0 ? "+" : ""}{netPct.toFixed(1)}% of universe)
          </span>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-4 gap-2 mb-2 pb-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          {[
            { l: "Longs", v: longs, c: GREEN },
            { l: "Shorts", v: shorts, c: RED },
            { l: "Coverage", v: `${coveragePct.toFixed(0)}%`, c: undefined },
            { l: "Exposure", v: `${exposurePct.toFixed(0)}%`, c: undefined },
          ].map(s => (
            <div key={s.l} className="text-center">
              <div className="text-[7px] font-mono uppercase tracking-wider text-white/40">{s.l}</div>
              <div className="text-[12px] font-mono font-bold tabular-nums" style={{ color: s.c || "rgba(255,255,255,0.75)" }}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* Chart toggle */}
        <div className="flex items-center justify-end mb-1">
          <div className="flex gap-px rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
            {(["24h", "daily"] as const).map(m => (
              <button key={m} onClick={() => setChartMode(m)}
                className="px-2 py-px text-[8px] font-mono capitalize"
                style={{
                  background: chartMode === m ? "rgba(212,168,67,0.1)" : "transparent",
                  color: chartMode === m ? GOLD : "rgba(255,255,255,0.4)",
                }}>{m}</button>
            ))}
          </div>
        </div>

        {/* Chart */}
        {chartData.length > 1 ? (
          <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" className="w-full" style={{ height: 50 }}>
            <line x1={0} y1={zeroY} x2={CW} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeDasharray="3 2" />
            {chartData.map((v, i) => {
              if (chartData.length < 2) return null;
              const barW = Math.max(1, CW / chartData.length - 1);
              const x = (i / chartData.length) * CW + 0.5;
              const barH = Math.abs(yFor(v) - zeroY);
              const y = v >= 0 ? yFor(v) : zeroY;
              return (
                <rect key={i} x={x} y={y} width={barW} height={Math.max(0.5, barH)}
                  fill={v >= 0 ? GREEN : RED} opacity={0.6} rx={0.5} />
              );
            })}
            <path d={chartData.map((v, i) => {
              const x = (i / (chartData.length - 1)) * CW;
              return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yFor(v).toFixed(1)}`;
            }).join(" ")} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : (
          <div className="flex items-center justify-center" style={{ height: 50 }}>
            <span className="text-[9px] font-mono text-white/30">Insufficient data</span>
          </div>
        )}

        {/* Long/short bias bar */}
        {totalOpen > 0 && (
          <div className="mt-2">
            <div className="flex justify-between text-[8px] font-mono mb-0.5">
              <span style={{ color: GREEN }}>▲ {longs} longs</span>
              <span style={{ color: RED }}>{shorts} shorts ▼</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden flex" style={{ background: "rgba(255,255,255,0.04)" }}>
              <div className="h-full" style={{
                background: GREEN, width: `${(longs / totalOpen * 100)}%`,
              }} />
              <div className="h-full" style={{
                background: RED, width: `${(shorts / totalOpen * 100)}%`,
              }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────
export default function SignalsPage() {
  const { user } = useAuth();
  const isPaid = user?.subscriptionStatus === "active";
  const [signals, setSignals] = useState<Signal[]>([]);
  const [periodicityFilter, setPeriodicityFilter] = useState<PeriodicityKey>("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionKey>("all");
  const [timeframe, setTimeframe] = useState<"1H" | "1D" | "1W" | "1M" | "ALL">("1D");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [activeFilters, setActiveFilters] = useState<any[]>([]);
  const [viewMode, setViewMode] = useState<"signals" | "hedged">("signals");
  const [hedgedData, setHedgedData] = useState<{ pairs: any[]; unpaired: any[]; stats: any } | null>(null);

  // Tick clock every 10s
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(iv);
  }, []);

  // Load signals
  useEffect(() => {
    const load = () => {
      fetch(`/api/signals?action=list&timeframe=${timeframe}`)
        .then(r => r.json())
        .then(d => { if (d.signals) setSignals(d.signals); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, isPaid ? 10000 : 60000);
    return () => clearInterval(iv);
  }, [timeframe, isPaid]);

  // Load hedged pairs when in hedged view
  useEffect(() => {
    if (viewMode !== "hedged") return;
    const load = () => {
      fetch(`/api/signals?action=hedged-pairs&timeframe=${timeframe}`)
        .then(r => r.json())
        .then(d => { if (d.pairs) setHedgedData(d); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, isPaid ? 10000 : 60000);
    return () => clearInterval(iv);
  }, [viewMode, timeframe, isPaid]);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [periodicityFilter, directionFilter, timeframe, viewMode]);

  // Load active board filters
  useEffect(() => {
    fetch("/api/regime?action=board-summary")
      .then(r => r.json())
      .then(d => { if (d.filters) setActiveFilters(d.filters); })
      .catch(() => {});
  }, []);

  // Bucket signals by periodicity
  const byPeriodicity = useMemo(() => {
    const buckets: Record<"1m" | "1h" | "1D", Signal[]> = { "1m": [], "1h": [], "1D": [] };
    signals.forEach(s => { buckets[getPeriodicity(s)].push(s); });
    return buckets;
  }, [signals]);

  // Filtered signals
  const filtered = useMemo(() => {
    let result = signals;
    // Free users: exclude signals created within the delay window
    if (!isPaid) {
      const cutoff = Date.now() - NET_POSITION_DELAY_MINS * 60 * 1000;
      result = result.filter(s => new Date(s.createdAt).getTime() <= cutoff);
    }
    if (periodicityFilter !== "all") {
      result = result.filter(s => getPeriodicity(s) === periodicityFilter);
    }
    if (directionFilter !== "all") {
      result = result.filter(s =>
        directionFilter === "long" ? s.direction === "LONG" : s.direction === "SHORT"
      );
    }
    return result;
  }, [signals, periodicityFilter, directionFilter, isPaid]);

  // Chart signals — use the same time-filtered dataset as the table
  const chartSignals = useMemo(() => {
    let result = signals;
    if (directionFilter !== "all") {
      result = result.filter(s =>
        directionFilter === "long" ? s.direction === "LONG" : s.direction === "SHORT"
      );
    }
    // Apply same free-user delay as filtered
    if (!isPaid) {
      const cutoff = Date.now() - NET_POSITION_DELAY_MINS * 60 * 1000;
      result = result.filter(s => new Date(s.createdAt).getTime() <= cutoff);
    }
    const buckets: Record<"1m" | "1h" | "1D", Signal[]> = { "1m": [], "1h": [], "1D": [] };
    result.forEach(s => { buckets[getPeriodicity(s)].push(s); });
    return buckets;
  }, [signals, directionFilter, isPaid]);

  // Pagination
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Open signals for price fetching
  const open = signals.filter(s => s.status === "open");

  // Fetch prices for all visible signals (open ones need live price, closed ones with missing exitPrice need fallback)
  useEffect(() => {
    const allSymbols = [...new Set(signals.map(s => s.symbol))];
    if (allSymbols.length === 0) return;
    const fetchPrices = () => {
      fetch(`/api/signals?action=prices&symbols=${allSymbols.join(",")}`)
        .then(r => r.json())
        .then(d => { if (d.prices) setPrices(d.prices); })
        .catch(() => {});
    };
    fetchPrices();
    const iv = setInterval(fetchPrices, 15000);
    return () => clearInterval(iv);
  }, [open.map(s => s.symbol).join(",")]);

  const getUnrealisedReturn = (sig: Signal) => {
    const currentPrice = prices[sig.symbol];
    if (!currentPrice || !sig.entryPrice) return null;
    if (sig.direction === "LONG") return (currentPrice / sig.entryPrice - 1) * 100;
    return (sig.entryPrice / currentPrice - 1) * 100;
  };

  // Aggregate stats for filtered signals
  const stats = useMemo(() => {
    const closed = filtered.filter(s => s.status === "closed");
    const openCount = filtered.filter(s => s.status === "open").length;
    const cumReturn = closed.reduce((s, t) => s + (t.returnPct || 0), 0);
    const wins = closed.filter(s => (s.returnPct || 0) > 0).length;
    const winRate = closed.length > 0 ? (wins / closed.length * 100) : 0;
    const mean = closed.length > 0 ? cumReturn / closed.length : 0;
    const returns = closed.map(s => s.returnPct || 0);
    const std = returns.length > 1
      ? Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length)
      : 0;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    return { closed: closed.length, open: openCount, cumReturn, winRate, mean, sharpe };
  }, [filtered]);

  // Open P&L
  const openPnL = useMemo(() => {
    const openSigs = filtered.filter(s => s.status === "open");
    const returns = openSigs.map(s => getUnrealisedReturn(s)).filter(r => r !== null) as number[];
    const total = returns.reduce((s, r) => s + r, 0);
    const greens = returns.filter(r => r > 0).length;
    return { total, greens, count: returns.length };
  }, [filtered, prices]);

  const delayMs = isPaid ? 0 : NET_POSITION_DELAY_MINS * 60 * 1000;

  // Filter tab component
  const FilterPill = ({ label, active, onClick, count }: {
    label: string; active: boolean; onClick: () => void; count?: number;
  }) => (
    <button onClick={onClick} className="px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all duration-150"
      style={{
        background: active ? "rgba(212,168,67,0.12)" : "rgba(255,255,255,0.03)",
        color: active ? GOLD : "rgba(255,255,255,0.45)",
        border: `1px solid ${active ? "rgba(212,168,67,0.25)" : "rgba(255,255,255,0.06)"}`,
      }}>
      {label}{count != null ? ` (${count})` : ""}
    </button>
  );

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* ── Summary Stats Bar ── */}
      <div className="flex items-center gap-6 mb-6 flex-wrap">
        <div>
          <div className="text-[9px] font-mono uppercase tracking-widest" style={{ color: "rgba(212,168,67,0.75)" }}>
            Cumulative Return
          </div>
          <div className="text-3xl font-mono font-black tabular-nums"
            style={{ color: stats.cumReturn > 0 ? GREEN : RED }}>
            {stats.cumReturn > 0 ? "+" : ""}{stats.cumReturn.toFixed(2)}%
          </div>
        </div>
        <div className="h-10 w-px" style={{ background: "rgba(255,255,255,0.1)" }} />
        <div className="grid grid-cols-5 gap-4">
          {[
            { l: "Closed", v: stats.closed },
            { l: "Open", v: stats.open },
            { l: "Win Rate", v: `${stats.winRate.toFixed(1)}%` },
            { l: "Avg Return", v: stats.closed > 0 ? `${stats.mean >= 0 ? "+" : ""}${stats.mean.toFixed(3)}%` : "—" },
            { l: "Sharpe", v: stats.sharpe.toFixed(2) },
          ].map(k => (
            <div key={k.l}>
              <div className="text-[8px] font-mono uppercase tracking-widest text-white/85">{k.l}</div>
              <div className="text-sm font-mono font-bold tabular-nums text-white/85">{k.v}</div>
            </div>
          ))}
        </div>
        {openPnL.count > 0 && (
          <>
            <div className="h-10 w-px" style={{ background: "rgba(255,255,255,0.1)" }} />
            <div>
              <div className="text-[8px] font-mono uppercase tracking-widest" style={{ color: "rgba(34,197,94,0.5)" }}>Open P&L</div>
              <div className="text-sm font-mono font-bold tabular-nums" style={{ color: openPnL.total > 0 ? GREEN : RED }}>
                {openPnL.total > 0 ? "+" : ""}{openPnL.total.toFixed(3)}%
                <span className="text-[9px] text-white/80 ml-1">({openPnL.greens}/{openPnL.count} green)</span>
              </div>
            </div>
          </>
        )}
        <div className="flex-1" />
        <div className="flex gap-px rounded overflow-hidden border" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          {(["1H", "1D", "1W", "1M", "ALL"] as const).map(tf => (
            <button key={tf} onClick={() => setTimeframe(tf)} className="px-3 py-1 text-[10px] font-mono" style={{
              background: timeframe === tf ? "rgba(212,168,67,0.1)" : "transparent",
              color: timeframe === tf ? GOLD : "rgba(255,255,255,0.55)",
            }}>{tf}</button>
          ))}
        </div>
        <div className="flex gap-px rounded overflow-hidden border" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
          {(["signals", "hedged"] as const).map(vm => (
            <button key={vm} onClick={() => setViewMode(vm)} className="px-3 py-1 text-[10px] font-mono" style={{
              background: viewMode === vm ? "rgba(212,168,67,0.1)" : "transparent",
              color: viewMode === vm ? GOLD : "rgba(255,255,255,0.55)",
            }}>{vm === "signals" ? "All Signals" : "Hedged Pairs"}</button>
          ))}
        </div>
      </div>

      {/* ── Hedged Pairs View ── */}
      {viewMode === "hedged" && (
        <div className="mb-6">
          {/* Hedged equity charts — one per timeframe */}
          {hedgedData?.pairs && (() => {
            // Determine timeframe for each pair from barMinutes
            const getPairTf = (p: any): string => {
              const bm = p.legA?.barMinutes || p.legB?.barMinutes;
              if (bm && bm >= 1440) return "1D";
              if (bm && bm >= 60) return "1H";
              if (bm && bm <= 1) return "1m";
              return "ALL";
            };

            const tfConfigs = [
              { key: "1m", label: "1M", color: "#3b82f6" },
              { key: "1H", label: "1H", color: "#a78bfa" },
              { key: "1D", label: "1D", color: GOLD },
              { key: "ALL", label: "ALL", color: "rgba(255,255,255,0.6)" },
            ];

            // Group pairs by timeframe
            const pairsByTf: Record<string, any[]> = {};
            for (const p of hedgedData.pairs) {
              const tf = getPairTf(p);
              if (!pairsByTf[tf]) pairsByTf[tf] = [];
              pairsByTf[tf].push(p);
            }
            // If everything is in ALL (no barMinutes data), just show one card
            const activeTfs = tfConfigs.filter(tc => (pairsByTf[tc.key]?.length || 0) > 0);
            if (activeTfs.length === 0) return null;

            // Helper to build one card
            const buildCard = (tfPairs: any[], label: string, color: string) => {
            const closedPairs = tfPairs
              .filter((p: any) => p.status === "closed" && p.pair_return != null)
              .sort((a: any, b: any) => new Date(a.legA.createdAt).getTime() - new Date(b.legA.createdAt).getTime());
            const openPairs = tfPairs.filter((p: any) => p.status === "open");
            const pairRets = closedPairs.map((p: any) => +p.pair_return);

            let openPairPnL = 0;
            const openPairReturns: number[] = [];
            for (const p of openPairs) {
              let legAret = 0, legBret = 0, hasData = false;
              const cpA = prices[p.legA?.symbol];
              const cpB = prices[p.legB?.symbol];
              if (cpA && p.legA?.entryPrice) { legAret = p.legA.direction === "LONG" ? (cpA / p.legA.entryPrice - 1) * 100 : (p.legA.entryPrice / cpA - 1) * 100; hasData = true; }
              if (cpB && p.legB?.entryPrice) { legBret = p.legB.direction === "LONG" ? (cpB / p.legB.entryPrice - 1) * 100 : (p.legB.entryPrice / cpB - 1) * 100; hasData = true; }
              if (hasData) { openPairPnL += legAret + legBret; openPairReturns.push(legAret + legBret); }
            }

            let cum = 0;
            const cumData = closedPairs.map((p: any) => { cum += p.pair_return; return cum; });
            if (openPairReturns.length > 0 && cumData.length > 0) { cumData.push(cum + openPairPnL); }
            const closedRet = pairRets.reduce((s: number, r: number) => s + r, 0);
            const totalRet = closedRet + openPairPnL;
            const wins = pairRets.filter((r: number) => r > 0).length;
            const winRate = pairRets.length > 0 ? (wins / pairRets.length * 100) : 0;
            const meanRet = pairRets.length > 0 ? pairRets.reduce((s: number, r: number) => s + r, 0) / pairRets.length : 0;
            const stdRet = pairRets.length > 1 ? Math.sqrt(pairRets.reduce((s: number, r: number) => s + (r - meanRet) ** 2, 0) / pairRets.length) : 0;
            const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;
            const grossWin = pairRets.filter((r: number) => r > 0).reduce((s: number, r: number) => s + r, 0);
            const grossLoss = Math.abs(pairRets.filter((r: number) => r < 0).reduce((s: number, r: number) => s + r, 0));
            const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
            const maxDD = (() => { let peak = 0, dd = 0; for (const v of cumData) { peak = Math.max(peak, v); dd = Math.min(dd, v - peak); } return dd; })();

            const cW = 290, cH = 130, pad = 10;
            const lineColor = totalRet >= 0 ? GREEN : RED;
            let curveD = "", areaD = "", zeroY = cH / 2;
            if (cumData.length >= 2) {
              const minV = Math.min(0, ...cumData); const maxV = Math.max(0, ...cumData); const range = maxV - minV || 1;
              zeroY = cH - ((0 - minV) / range) * (cH - 16) - 8;
              const pts = cumData.map((v: number, i: number) => ({ x: pad + (i / (cumData.length - 1)) * (cW - pad * 2), y: cH - ((v - minV) / range) * (cH - 16) - 8 }));
              curveD = pts.map((p: any, i: number) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
              areaD = `${curveD} L${pts[pts.length - 1].x.toFixed(1)},${zeroY} L${pad},${zeroY} Z`;
            }

            return (
              <div key={label} className="flex-1 min-w-[320px] rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${color}25` }}>
                <div className="flex">
                  <div className="flex-1 p-3 pr-0 flex items-stretch">
                    {cumData.length >= 2 ? (
                      <svg viewBox={`0 0 ${cW} ${cH}`} preserveAspectRatio="none" className="w-full h-full" style={{ minHeight: 120 }}>
                        <defs><linearGradient id={`grad-h-${label}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={lineColor} stopOpacity="0.2" /><stop offset="100%" stopColor={lineColor} stopOpacity="0.02" /></linearGradient></defs>
                        <line x1={pad} y1={zeroY} x2={cW - pad} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="4 4" />
                        <path d={areaD} fill={`url(#grad-h-${label})`} />
                        <path d={curveD} fill="none" stroke={lineColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                        {(() => { const minV = Math.min(0, ...cumData); const maxV = Math.max(0, ...cumData); const range = maxV - minV || 1; const endX = pad + (cW - pad * 2); const endY = cH - ((cumData[cumData.length - 1] - minV) / range) * (cH - 16) - 8; return <circle cx={endX} cy={endY} r="3" fill={lineColor} />; })()}
                      </svg>
                    ) : (
                      <div className="flex items-center justify-center w-full" style={{ minHeight: 120 }}><span className="text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.4)" }}>No closed pairs</span></div>
                    )}
                  </div>
                  <div className="shrink-0 p-3 pl-2 flex flex-col justify-between items-end">
                    <div className="flex items-center gap-1.5 mb-2.5">
                      <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold" style={{ background: `${color}15`, color }}>{label}</span>
                      <span className="text-[10px] font-mono text-white/80">Hedged</span>
                    </div>
                    <div className="w-full mb-1"><div className="flex items-baseline gap-1.5">
                      <span className="text-[8px] font-mono text-white/65 w-[34px] text-right">closed</span>
                      <span className="text-[11px] font-mono font-bold text-white/85 tabular-nums">{closedPairs.length}</span>
                      <span className="text-[14px] font-mono font-black tabular-nums leading-tight ml-auto" style={{ color: totalRet >= 0 ? GREEN : RED }}>{totalRet >= 0 ? "+" : ""}{totalRet.toFixed(2)}%</span>
                    </div></div>
                    <div className="w-full mb-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 8 }}><div className="flex items-baseline gap-1.5">
                      <span className="text-[8px] font-mono text-white/65 w-[34px] text-right">open</span>
                      <span className="text-[11px] font-mono font-bold text-white/85 tabular-nums">{openPairs.length}</span>
                      {openPairReturns.length > 0 ? (
                        <span className="text-[12px] font-mono font-bold tabular-nums leading-tight ml-auto" style={{ color: openPairPnL >= 0 ? GREEN : RED }}>{openPairPnL >= 0 ? "+" : ""}{openPairPnL.toFixed(2)}%</span>
                      ) : (<span className="text-[11px] font-mono text-white/80 ml-auto">—</span>)}
                    </div></div>
                    <div className="w-full space-y-0.5">
                      {[
                        { l: "Win", v: `${winRate.toFixed(0)}%` },
                        { l: "Sharpe", v: sharpe.toFixed(2) },
                        { l: "Avg", v: `${meanRet >= 0 ? "+" : ""}${meanRet.toFixed(3)}%` },
                        { l: "PF", v: pf > 10 ? ">10" : pf.toFixed(2) },
                        { l: "MaxDD", v: `${maxDD.toFixed(1)}%` },
                      ].map(s => (
                        <div key={s.l} className="flex items-baseline gap-1.5">
                          <span className="text-[8px] font-mono uppercase tracking-wider text-white/65 w-[34px] text-right">{s.l}</span>
                          <span className="text-[11px] font-mono font-bold text-white/75 tabular-nums">{s.v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
            }; // end buildCard

            return (
              <div className="flex gap-3 mb-4 flex-wrap">
                {activeTfs.map(tc => {
                  const tfPairs = pairsByTf[tc.key] || [];
                  if (tfPairs.length === 0) return null;
                  return buildCard(tfPairs, tc.label, tc.color);
                })}
              </div>
            );
          })()}

          {hedgedData?.pairs?.length === 0 && (
            <div className="text-center py-12 font-mono text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>
              No hedged pairs yet. Pairs form when opposite-direction signals fire on different coins within the gap window.
            </div>
          )}
          <div className="space-y-2">
            {hedgedData?.pairs?.map((p: any) => {
              const isClosed = p.status === "closed";
              // Use actual pair_return for closed, compute MTM for open
              let pairRet = p.pair_return;
              if (pairRet == null && p.legA && p.legB) {
                const cpA = prices[p.legA.symbol];
                const cpB = prices[p.legB.symbol];
                let mtm = 0; let hasMtm = false;
                if (cpA && p.legA.entryPrice) { mtm += p.legA.direction === "LONG" ? (cpA / p.legA.entryPrice - 1) * 100 : (p.legA.entryPrice / cpA - 1) * 100; hasMtm = true; }
                if (cpB && p.legB.entryPrice) { mtm += p.legB.direction === "LONG" ? (cpB / p.legB.entryPrice - 1) * 100 : (p.legB.entryPrice / cpB - 1) * 100; hasMtm = true; }
                if (hasMtm) pairRet = mtm;
              }
              const borderColor = pairRet == null ? "rgba(255,255,255,0.08)" : pairRet > 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)";
              return (
                <div key={p.pair_id} className="rounded-xl p-3 flex items-center gap-4 flex-wrap" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${borderColor}` }}>
                  {/* Leg A */}
                  <div className="flex items-center gap-2 min-w-[140px]">
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{
                      background: p.legA.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      color: p.legA.direction === "LONG" ? GREEN : RED,
                    }}>{p.legA.direction[0]}</span>
                    <span className="text-[12px] font-mono font-bold text-white">{p.legA.symbol?.replace("USDT", "")}</span>
                    {p.legA.returnPct != null && (
                      <span className="text-[10px] font-mono tabular-nums" style={{ color: p.legA.returnPct > 0 ? GREEN : RED }}>
                        {p.legA.returnPct > 0 ? "+" : ""}{(+p.legA.returnPct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  {/* Arrow */}
                  <span className="text-[10px] font-mono" style={{ color: GOLD }}>+</span>
                  {/* Leg B */}
                  <div className="flex items-center gap-2 min-w-[140px]">
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{
                      background: p.legB.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      color: p.legB.direction === "LONG" ? GREEN : RED,
                    }}>{p.legB.direction[0]}</span>
                    <span className="text-[12px] font-mono font-bold text-white">{p.legB.symbol?.replace("USDT", "")}</span>
                    {p.legB.returnPct != null && (
                      <span className="text-[10px] font-mono tabular-nums" style={{ color: p.legB.returnPct > 0 ? GREEN : RED }}>
                        {p.legB.returnPct > 0 ? "+" : ""}{(+p.legB.returnPct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  {/* Pair return */}
                  <div className="flex-1" />
                  <div className="text-right">
                    <div className="text-[16px] font-mono font-black tabular-nums" style={{
                      color: pairRet != null ? (pairRet > 0 ? GREEN : pairRet < 0 ? RED : "rgba(255,255,255,0.5)") : "rgba(255,255,255,0.3)"
                    }}>
                      {pairRet != null ? `${pairRet > 0 ? "+" : ""}${(+pairRet).toFixed(2)}%` : "—"}
                    </div>
                    <div className="text-[9px] font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>
                      {isClosed ? "closed" : "live"} · {new Date(p.legA.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Three Equity Charts ── */}
      {viewMode === "signals" && <><div className="flex gap-3 mb-6 flex-wrap">
        <MiniEquityCurve label="1M" signals={chartSignals["1m"]} color="#3b82f6" prices={prices} timeWindow={timeframe}
          filters={activeFilters.filter((f: any) => { const tf = (f.timeframe || 'all').toLowerCase(); return tf === 'all' || tf === '1m'; })} />
        <MiniEquityCurve label="1H" signals={chartSignals["1h"]} color="#a78bfa" prices={prices} timeWindow={timeframe}
          filters={activeFilters.filter((f: any) => { const tf = (f.timeframe || 'all').toLowerCase(); return tf === 'all' || tf === '1h'; })} />
        <MiniEquityCurve label="1D" signals={chartSignals["1D"]} color={GOLD} prices={prices} timeWindow={timeframe}
          filters={activeFilters.filter((f: any) => { const tf = (f.timeframe || 'all').toLowerCase(); return tf === 'all' || tf === '1d'; })} />
      </div>

      {/* ── Main Content: Trade Table + Daily Performance ── */}
      <div className="flex gap-4 mb-4" style={{ alignItems: "flex-start" }}>
        {/* Left: Trade table */}
        <div className="flex-1 min-w-0">

      {/* ── Filter Tabs ── */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {/* Periodicity filters */}
        <div className="flex gap-1.5 mr-3">
          {([
            { key: "all" as PeriodicityKey, label: "All" },
            { key: "1m" as PeriodicityKey, label: "1M" },
            { key: "1h" as PeriodicityKey, label: "1H" },
            { key: "1D" as PeriodicityKey, label: "1D" },
          ]).map(f => (
            <FilterPill
              key={f.key}
              label={f.label}
              active={periodicityFilter === f.key}
              onClick={() => setPeriodicityFilter(f.key)}
              count={f.key === "all" ? signals.length : byPeriodicity[f.key as "1m" | "1h" | "1D"]?.length}
            />
          ))}
        </div>

        {/* Direction filters */}
        <div className="h-5 w-px" style={{ background: "rgba(255,255,255,0.08)" }} />
        <div className="flex gap-1.5 ml-3">
          {([
            { key: "all" as DirectionKey, label: "All Dirs" },
            { key: "long" as DirectionKey, label: "▲ Longs" },
            { key: "short" as DirectionKey, label: "▼ Shorts" },
          ]).map(f => (
            <FilterPill
              key={f.key}
              label={f.label}
              active={directionFilter === f.key}
              onClick={() => setDirectionFilter(f.key)}
            />
          ))}
        </div>

        <div className="flex-1" />

        {/* Pagination info */}
        <span className="text-[9px] font-mono text-white/75 tabular-nums">
          {filtered.length} signals · page {page + 1}/{Math.max(totalPages, 1)}
        </span>

      </div>

      {/* ── Signal Cards ── */}
      {!isPaid && (
        <div className="text-center px-3 py-1.5 mb-3 rounded-lg" style={{
          background: "rgba(212,168,67,0.06)",
          border: "1px solid rgba(212,168,67,0.15)",
        }}>
          <Link href="/pricing" className="text-[10px] font-mono font-bold" style={{ color: GOLD }}>
            {NET_POSITION_DELAY_MINS}m delayed data – Buy a seat for live →
          </Link>
        </div>
      )}
      {paged.length === 0 && (
        <div className="py-12 text-center font-mono text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>No signals match these filters</div>
      )}
      <div className="space-y-1.5">
        {paged.map(sig => {
          const isL = sig.direction === "LONG";
          const unrealised = getUnrealisedReturn(sig);
          const isExpanded = expandedId === sig.id;
          const periodicity = getPeriodicity(sig);
          const barMins = sig.barMinutes || (periodicity === "1m" ? 1 : periodicity === "1h" ? 60 : 1440);
          const holdMs = (sig.holdBars || 10) * barMins * 60_000;
          const expectedClose = new Date(sig.createdAt).getTime() + holdMs;
          const remaining = expectedClose - now;
          const ret = sig.status === "closed" ? (sig.returnPct || 0) : unrealised;
          const retColor = ret !== null && ret !== undefined ? (ret > 0 ? GREEN : ret < 0 ? RED : "rgba(255,255,255,0.5)") : "rgba(255,255,255,0.3)";
          const borderColor = sig.status === "open" ? "rgba(34,197,94,0.12)" : ret !== null && ret !== undefined ? (ret > 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)") : "rgba(255,255,255,0.06)";
          const tfColor = periodicity === "1m" ? "#3b82f6" : periodicity === "1h" ? "#a78bfa" : GOLD;

          return (
            <React.Fragment key={sig.id}>
              <div
                className="rounded-xl p-3 flex items-center gap-3 cursor-pointer hover:brightness-110 transition-all"
                style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${borderColor}` }}
                onClick={() => setExpandedId(isExpanded ? null : sig.id)}
              >
                {/* Direction badge */}
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded shrink-0" style={{
                  background: isL ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                  color: isL ? GREEN : RED,
                }}>{isL ? "L" : "S"}</span>

                {/* Coin */}
                <span className="text-[13px] font-mono font-bold text-white min-w-[60px]">
                  {sig.symbol?.replace("USDT", "")}
                </span>

                {/* Timeframe badge */}
                <span className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded shrink-0" style={{
                  background: `${tfColor}15`, color: tfColor,
                }}>{periodicity.toUpperCase()}</span>

                {/* Entry/Exit prices */}
                <div className="text-[9px] font-mono tabular-nums hidden sm:flex items-center gap-2" style={{ color: "rgba(255,255,255,0.5)" }}>
                  <span>{sig.entryPrice?.toFixed(sig.entryPrice > 100 ? 2 : 4)}</span>
                  <span style={{ color: "rgba(255,255,255,0.2)" }}>→</span>
                  <span>{sig.exitPrice ? sig.exitPrice.toFixed(sig.exitPrice > 100 ? 2 : 4) : (prices[sig.symbol] ? prices[sig.symbol].toFixed(prices[sig.symbol] > 100 ? 2 : 4) : "—")}</span>
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Status */}
                {sig.status === "open" ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-[9px] font-mono" style={{ color: GREEN }}>
                      {remaining > 0 ? formatDuration(remaining) : "closing..."}
                    </span>
                  </div>
                ) : (
                  <span className="text-[9px] font-mono shrink-0" style={{ color: "rgba(255,255,255,0.3)" }}>
                    {new Date(sig.closedAt || sig.createdAt).toLocaleDateString()}
                  </span>
                )}

                {/* Return */}
                <div className="text-right min-w-[70px] shrink-0">
                  <span className="text-[15px] font-mono font-black tabular-nums" style={{ color: retColor }}>
                    {ret !== null && ret !== undefined
                      ? `${ret > 0 ? "+" : ""}${ret.toFixed(2)}%`
                      : "—"}
                  </span>
                </div>
              </div>

              {/* Expanded chart */}
              {isExpanded && (
                <div className="rounded-xl p-3 -mt-1" style={{ background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.04)" }}>
                  <SignalChart signalId={sig.id} />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            onClick={() => setPage(0)}
            disabled={page === 0}
            className="px-2 py-1 text-[10px] font-mono rounded transition-colors"
            style={{
              color: page === 0 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.6)",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >«</button>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-2 py-1 text-[10px] font-mono rounded transition-colors"
            style={{
              color: page === 0 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.6)",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >‹ Prev</button>
          <span className="text-[10px] font-mono text-white/85 tabular-nums">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-2 py-1 text-[10px] font-mono rounded transition-colors"
            style={{
              color: page >= totalPages - 1 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.6)",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >Next ›</button>
          <button
            onClick={() => setPage(totalPages - 1)}
            disabled={page >= totalPages - 1}
            className="px-2 py-1 text-[10px] font-mono rounded transition-colors"
            style={{
              color: page >= totalPages - 1 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.6)",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >»</button>
        </div>
      )}

        </div>{/* end left trade table */}

        {/* Right: Daily Performance + Seat Market + Net Position */}
        <div className="w-[340px] shrink-0 hidden lg:block">
          <DailyPerformance signals={signals} />
          <SeatMarket />
          <NetPosition signals={signals} isPaid={isPaid} />
        </div>
      </div>{/* end flex row */}

      {/* Sidebar cards - mobile (stacks below) */}
      <div className="lg:hidden mb-4">
        <DailyPerformance signals={signals} />
        <SeatMarket />
        <NetPosition signals={signals} isPaid={isPaid} />
      </div>

      {/* Free tier CTA */}
      {!isPaid && filtered.length > 0 && (
        <div className="mt-6 p-4 rounded-xl text-center"
          style={{ background: "rgba(212,168,67,0.04)", border: "1px solid rgba(212,168,67,0.1)" }}>
          <p className="text-[12px] font-mono mb-3" style={{ color: GOLD }}>
            Open signals are hidden for free users. Buy a seat to unlock real-time access.
          </p>
          <Link href="/pricing" className="px-5 py-2 rounded-lg text-[12px] font-mono font-bold inline-block"
            style={{ background: GOLD, color: "#000" }}>
            Buy a Seat
          </Link>
        </div>
      )}
      </>}
    </div>
  );
}
