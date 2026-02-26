"use client";

import { useState, useEffect, useMemo } from "react";

const GOLD = "#D4A843";
const UP_COLOR = GOLD;
const DOWN_FILL = "#1a1a2e";
const DOWN_STROKE = "rgba(255,255,255,0.45)";
const GREEN = "#22c55e";
const RED = "#ef4444";

type Candle = { time: string; open: number; high: number; low: number; close: number };
type SignalData = {
  symbol: string; direction: string; entryPrice: number; exitPrice?: number;
  returnPct?: number; status: string; createdAt: string; closedAt?: string; holdBars?: number;
};

export default function SignalChart({ signalId, compact = false }: { signalId: string; compact?: boolean }) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [signal, setSignal] = useState<SignalData | null>(null);
  const [serverEntryIdx, setServerEntryIdx] = useState<number>(-1);
  const [serverExitIdx, setServerExitIdx] = useState<number>(-1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/signals?action=chart&signalId=${signalId}`)
      .then(r => r.json())
      .then(d => {
        if (d.candles) setCandles(d.candles);
        if (d.signal) setSignal(d.signal);
        if (d.entryBarIdx != null) setServerEntryIdx(d.entryBarIdx);
        if (d.exitBarIdx != null) setServerExitIdx(d.exitBarIdx);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [signalId]);

  const W = compact ? 420 : 700;
  const H = compact ? 170 : 260;
  const PAD = { top: 14, bottom: 20, left: 4, right: 4 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const chart = useMemo(() => {
    if (candles.length < 5 || !signal) return null;

    // Use server-provided entry index, fallback to search
    let entryIdx = serverEntryIdx >= 0 ? serverEntryIdx : -1;
    if (entryIdx < 0) {
      const signalTime = new Date(signal.createdAt).getTime();
      entryIdx = candles.findIndex(c => new Date(c.time).getTime() >= signalTime);
    }
    if (entryIdx < 0 || entryIdx >= candles.length) entryIdx = candles.length - 1;

    // Sanity check: entry price should be within the candle range at the entry bar
    // If not, the data is unreliable — don't show a misleading chart
    const entryCandle = candles[entryIdx];
    if (entryCandle && signal.entryPrice > 0) {
      const candleMid = (entryCandle.high + entryCandle.low) / 2;
      const tolerance = candleMid * 0.05; // 5% tolerance
      if (Math.abs(signal.entryPrice - candleMid) > tolerance) return "bad_data";
    }

    // Find exit bar
    let exitIdx = -1;
    if (signal.closedAt) {
      const closeTime = new Date(signal.closedAt).getTime();
      exitIdx = candles.findIndex(c => new Date(c.time).getTime() >= closeTime);
      if (exitIdx < 0) exitIdx = candles.length - 1;
    }

    // Trim to ~25 bars before entry + everything after (exit + 5)
    const barsBefore = 25;
    const trimStart = Math.max(0, entryIdx - barsBefore);
    const holdBars = signal.holdBars || 10;
    const endBar = exitIdx > 0 ? exitIdx + 5 : entryIdx + holdBars + 5;
    const trimEnd = Math.min(candles.length, endBar + 1);

    const vis = candles.slice(trimStart, trimEnd);
    const adjEntry = entryIdx - trimStart;
    const adjExit = exitIdx >= 0 ? exitIdx - trimStart : -1;

    const minP = Math.min(...vis.map(c => c.low)) * 0.9985;
    const maxP = Math.max(...vis.map(c => c.high)) * 1.0015;
    const range = maxP - minP || 1;

    // Fatter candles — use 70% of available space per bar
    const gap = chartW / vis.length;
    const barW = Math.max(2, gap * 0.7);

    const toY = (p: number) => PAD.top + chartH - ((p - minP) / range) * chartH;
    const toX = (i: number) => PAD.left + i * gap + gap / 2;

    const isLong = signal.direction === "LONG";
    const won = signal.status === "closed" && (signal.returnPct || 0) > 0;

    return { minP, maxP, range, barW, gap, toY, toX, entryIdx: adjEntry, exitIdx: adjExit, isLong, won, vis };
  }, [candles, signal, serverEntryIdx, chartW, chartH]);

  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ width: W, height: H }}>
        <span className="text-[10px] font-mono text-white/30">Loading chart...</span>
      </div>
    );
  }

  if (!chart || !signal || chart === "bad_data") {
    return (
      <div className="flex items-center justify-center" style={{ width: W, height: H }}>
        <span className="text-[10px] font-mono text-white/20">{chart === "bad_data" ? "Unable to display chart" : "No chart data"}</span>
      </div>
    );
  }

  const { toY, toX, barW, entryIdx, exitIdx, isLong, won, vis } = chart;
  const entryY = toY(signal.entryPrice);
  const entryX = toX(entryIdx);
  const arrowColor = isLong ? GREEN : RED;
  const resultColor = won ? GREEN : RED;

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-bold" style={{ color: isLong ? GREEN : RED }}>
            {isLong ? "▲" : "▼"} {signal.symbol.replace("USDT", "")}
          </span>
          <span className="text-[9px] font-mono text-white/30">
            {new Date(signal.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        {signal.status === "closed" && signal.returnPct != null && (
          <span className="text-[11px] font-mono font-bold" style={{ color: resultColor }}>
            {signal.returnPct > 0 ? "+" : ""}{signal.returnPct.toFixed(3)}%
          </span>
        )}
        {signal.status === "open" && (
          <span className="inline-flex items-center gap-1 text-[9px] font-mono" style={{ color: GREEN }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: GREEN }} /> LIVE
          </span>
        )}
      </div>

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Subtle hold zone */}
        {exitIdx > 0 && (
          <rect
            x={toX(entryIdx) - barW / 2}
            y={PAD.top}
            width={toX(exitIdx) - toX(entryIdx) + barW}
            height={chartH}
            fill={won ? "rgba(34,197,94,0.03)" : "rgba(239,68,68,0.03)"}
          />
        )}

        {/* Entry price line — subtle */}
        <line
          x1={toX(entryIdx)} y1={entryY}
          x2={W - PAD.right} y2={entryY}
          stroke={arrowColor} strokeWidth={0.5} strokeDasharray="2 2" opacity={0.3}
        />

        {/* Candlesticks */}
        {vis.map((c, i) => {
          const x = toX(i);
          const bullish = c.close >= c.open;
          const bodyTop = toY(Math.max(c.open, c.close));
          const bodyBot = toY(Math.min(c.open, c.close));
          const bodyH = Math.max(1, bodyBot - bodyTop);

          return (
            <g key={i}>
              {/* Wick */}
              <line x1={x} y1={toY(c.high)} x2={x} y2={toY(c.low)}
                stroke={bullish ? UP_COLOR : DOWN_STROKE} strokeWidth={0.8} />
              {/* Body */}
              <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH}
                fill={bullish ? UP_COLOR : DOWN_FILL}
                stroke={bullish ? UP_COLOR : DOWN_STROKE}
                strokeWidth={bullish ? 0 : 0.8}
                rx={0.5} />
            </g>
          );
        })}

        {/* ENTRY ARROW — compact, clean */}
        {(() => {
          const sz = 5; // arrow head size
          const stem = 8;
          if (isLong) {
            // Up arrow below entry candle
            const tipY = toY(vis[entryIdx]?.low ?? signal.entryPrice) + 4;
            return (
              <g>
                <polygon points={`${entryX},${tipY} ${entryX - sz},${tipY + sz * 1.6} ${entryX + sz},${tipY + sz * 1.6}`}
                  fill={GREEN} />
                <line x1={entryX} y1={tipY + sz * 1.6} x2={entryX} y2={tipY + sz * 1.6 + stem}
                  stroke={GREEN} strokeWidth={2} strokeLinecap="round" />
              </g>
            );
          } else {
            // Down arrow above entry candle
            const tipY = toY(vis[entryIdx]?.high ?? signal.entryPrice) - 4;
            return (
              <g>
                <polygon points={`${entryX},${tipY} ${entryX - sz},${tipY - sz * 1.6} ${entryX + sz},${tipY - sz * 1.6}`}
                  fill={RED} />
                <line x1={entryX} y1={tipY - sz * 1.6} x2={entryX} y2={tipY - sz * 1.6 - stem}
                  stroke={RED} strokeWidth={2} strokeLinecap="round" />
              </g>
            );
          }
        })()}

        {/* EXIT marker — clean small dot + label */}
        {signal.status === "closed" && signal.exitPrice && exitIdx > 0 && (() => {
          const ex = toX(exitIdx);
          const ey = toY(signal.exitPrice);
          const labelW = 36;
          const labelH = 12;
          // Position label above or below based on space
          const labelAbove = ey > PAD.top + chartH / 2;
          const ly = labelAbove ? ey - 16 : ey + 6;
          return (
            <g>
              <circle cx={ex} cy={ey} r={3} fill={resultColor} opacity={0.8} />
              <circle cx={ex} cy={ey} r={5} fill="none" stroke={resultColor} strokeWidth={0.8} opacity={0.4} />
              <rect x={ex - labelW / 2} y={ly} width={labelW} height={labelH} rx={2}
                fill={won ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)"}
                stroke={resultColor} strokeWidth={0.4} />
              <text x={ex} y={ly + labelH - 3} textAnchor="middle" fill={resultColor}
                fontFamily="monospace" fontSize={7.5} fontWeight="bold">
                {signal.returnPct! > 0 ? "+" : ""}{signal.returnPct!.toFixed(2)}%
              </text>
            </g>
          );
        })()}

        {/* Time labels */}
        {vis.length > 0 && (
          <>
            <text x={PAD.left + 2} y={H - 4} className="text-[7px]" fill="rgba(255,255,255,0.15)" fontFamily="monospace">
              {new Date(vis[0].time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </text>
            <text x={W - PAD.right - 2} y={H - 4} textAnchor="end" className="text-[7px]" fill="rgba(255,255,255,0.15)" fontFamily="monospace">
              {new Date(vis[vis.length - 1].time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
