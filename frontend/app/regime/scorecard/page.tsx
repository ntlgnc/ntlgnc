"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";

const GOLD = "#D4A843";
const BG = "#080a10";

// ═══════════════════════════════════════════════════════════════
// Color helpers
// ═══════════════════════════════════════════════════════════════

const srColor = (sr: number) => sr > 2 ? "#22c55e" : sr > 0.5 ? "#86efac" : sr > 0 ? "#a3a3a3" : sr > -1 ? "#fca5a5" : "#ef4444";
const wrColor = (wr: number) => wr > 60 ? "#22c55e" : wr > 52 ? "#86efac" : wr > 48 ? "#a3a3a3" : "#ef4444";
const rhoColor = (rho: number) => rho >= 0.8 ? "#22c55e" : rho >= 0.4 ? "#86efac" : rho >= 0 ? "#eab308" : rho >= -0.4 ? "#fca5a5" : "#ef4444";
const confidenceIcon = (c: string) => c === "high" ? "✅" : c === "moderate" ? "🟡" : c === "low" ? "⚠️" : c === "unstable" ? "🔴" : c === "inverted" ? "⛔" : "❓";
const confidenceColor = (c: string) => c === "high" ? "#22c55e" : c === "moderate" ? "#86efac" : c === "low" ? "#eab308" : c === "unstable" ? "#fca5a5" : c === "inverted" ? "#ef4444" : "#666";
const srBg = (sr: number) => {
  const intensity = Math.min(Math.abs(sr) / 5, 1) * 0.3;
  return sr > 0 ? `rgba(34,197,94,${intensity})` : `rgba(239,68,68,${intensity})`;
};

type ScorecardRow = {
  feature_key: string;
  feature_label: string;
  direction_filter: string;
  bucket_index: number;
  bucket_label: string;
  oos_sharpe: number;
  oos_win_rate: number;
  oos_avg_ret: number;
  oos_trades: number;
  is_sharpe: number;
  is_trades: number;
  spread: number;
  rho: number;
  confidence: string;
  bar_minutes: number;
  strategy_label: string;
  total_signals: number;
  computed_at: string;
};

type Meta = {
  bar_minutes: number;
  direction_filter: string;
  rows: number;
  last_computed: string;
  total_signals: number;
};

type FeatureGroup = {
  key: string;
  label: string;
  buckets: { index: number; label: string; oos_sharpe: number; oos_win_rate: number; oos_avg_ret: number; oos_trades: number; is_sharpe: number; is_trades: number }[];
  spread: number;
  rho: number | null;
  confidence: string;
  totalTrades: number;
};

// ═══════════════════════════════════════════════════════════════
// Sharpe bar component — visual horizontal bar
// ═══════════════════════════════════════════════════════════════

function SharpeBar({ value, maxAbs }: { value: number; maxAbs: number }) {
  const pct = Math.min(Math.abs(value) / maxAbs, 1) * 100;
  const isPos = value >= 0;
  return (
    <div className="relative h-3 w-full" style={{ background: "rgba(255,255,255,0.03)" }}>
      {isPos ? (
        <div className="absolute left-1/2 h-full" style={{
          width: `${pct / 2}%`, background: `rgba(34,197,94,${0.3 + pct / 200})`,
          borderRight: "1px solid rgba(34,197,94,0.6)",
        }} />
      ) : (
        <div className="absolute right-1/2 h-full" style={{
          width: `${pct / 2}%`, background: `rgba(239,68,68,${0.3 + pct / 200})`,
          borderLeft: "1px solid rgba(239,68,68,0.6)",
        }} />
      )}
      <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ background: "rgba(255,255,255,0.1)" }} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Feature detail card — expanded view of a single feature
// ═══════════════════════════════════════════════════════════════

function FeatureDetail({ feature, allDirections }: { feature: FeatureGroup; allDirections: Record<string, FeatureGroup> }) {
  const maxSr = Math.max(...feature.buckets.map(b => Math.abs(b.oos_sharpe)), 1);

  return (
    <div className="rounded-lg border border-white/[0.06] p-4" style={{ background: "rgba(212,168,67,0.02)" }}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-[13px] font-mono font-bold text-white">{feature.label}</span>
          <span className="text-[9px] font-mono text-white/30 ml-2">{feature.key}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-white/40">
            Spread: <span className="font-bold" style={{ color: feature.spread > 3 ? "#06b6d4" : feature.spread > 1.5 ? "#22c55e" : "#a3a3a3" }}>{feature.spread?.toFixed(1)}</span>
          </span>
          {feature.rho !== null && (
            <span className="text-[9px] font-mono text-white/40">
              ρ IS→OOS: <span className="font-bold" style={{ color: rhoColor(feature.rho) }}>{feature.rho?.toFixed(2)}</span>
              {" "}{confidenceIcon(feature.confidence)}
            </span>
          )}
          <span className="text-[9px] font-mono text-white/30">{feature.totalTrades} trades</span>
        </div>
      </div>

      {/* Bucket bars */}
      <div className="space-y-1">
        {feature.buckets.map((b, i) => (
          <div key={i} className="grid grid-cols-[140px_1fr_60px_50px_60px_50px_50px] gap-2 items-center">
            <div className="text-[10px] font-mono text-white/60 truncate">{b.label}</div>
            <SharpeBar value={b.oos_sharpe} maxAbs={maxSr} />
            <div className="text-[10px] font-mono text-right font-bold tabular-nums" style={{ color: srColor(b.oos_sharpe) }}>
              {b.oos_trades > 2 ? b.oos_sharpe?.toFixed(2) : "–"}
            </div>
            <div className="text-[9px] font-mono text-right tabular-nums" style={{ color: wrColor(b.oos_win_rate) }}>
              {b.oos_trades > 2 ? `${b.oos_win_rate?.toFixed(0)}%` : "–"}
            </div>
            <div className="text-[9px] font-mono text-right tabular-nums" style={{ color: b.oos_avg_ret > 0 ? "#22c55e" : "#ef4444" }}>
              {b.oos_trades > 2 ? `${b.oos_avg_ret > 0 ? "+" : ""}${b.oos_avg_ret?.toFixed(3)}%` : "–"}
            </div>
            <div className="text-[8px] font-mono text-right text-white/30">{b.oos_trades}t</div>
            {b.is_sharpe !== null && (
              <div className="text-[8px] font-mono text-right tabular-nums" style={{ color: srColor(b.is_sharpe), opacity: 0.5 }}>
                IS:{b.is_trades > 2 ? b.is_sharpe?.toFixed(1) : "–"}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Direction comparison if we have all directions loaded */}
      {allDirections && Object.keys(allDirections).length > 1 && (
        <div className="mt-3 pt-3 border-t border-white/[0.04]">
          <div className="text-[8px] font-mono text-white/25 mb-2">DIRECTION COMPARISON</div>
          <div className="grid grid-cols-3 gap-2">
            {["all", "long", "short"].map(dir => {
              const fg = allDirections[dir];
              if (!fg) return <div key={dir} className="text-[9px] font-mono text-white/20">No {dir} data</div>;
              return (
                <div key={dir} className="rounded p-2 border border-white/[0.04]" style={{ background: "rgba(255,255,255,0.01)" }}>
                  <div className="text-[9px] font-mono font-bold mb-1" style={{ color: dir === "long" ? "#22c55e" : dir === "short" ? "#ef4444" : GOLD }}>
                    {dir === "all" ? "▬ ALL" : dir === "long" ? "▲ LONG" : "▼ SHORT"}
                  </div>
                  {fg.buckets.map((b, i) => (
                    <div key={i} className="flex justify-between text-[8px] font-mono">
                      <span className="text-white/40 truncate" style={{ maxWidth: 80 }}>{b.label}</span>
                      <span className="font-bold tabular-nums" style={{ color: srColor(b.oos_sharpe) }}>
                        {b.oos_trades > 2 ? b.oos_sharpe?.toFixed(1) : "–"}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Coin drill-down — per-coin bucket breakdown for a feature
// ═══════════════════════════════════════════════════════════════

function CoinDrillDown({ featureKey, tf, direction }: { featureKey: string; tf: number; direction: string }) {
  const [coinRows, setCoinRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState<"symbol" | "spread" | "best" | "worst" | "trades">("spread");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/regime?action=scorecard-coins&tf=${tf}&direction=${direction}&feature=${encodeURIComponent(featureKey)}`)
      .then(r => r.json())
      .then(d => { setCoinRows(d.rows || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [featureKey, tf, direction]);

  // Group by symbol
  const coins = useMemo(() => {
    const grouped: Record<string, any[]> = {};
    for (const r of coinRows) {
      if (!grouped[r.symbol]) grouped[r.symbol] = [];
      grouped[r.symbol].push(r);
    }
    return Object.entries(grouped).map(([symbol, buckets]) => {
      const sorted = buckets.sort((a, b) => a.bucket_index - b.bucket_index);
      const sharpes = sorted.filter(b => b.oos_trades >= 2).map(b => b.oos_sharpe);
      const spread = sharpes.length >= 2 ? Math.max(...sharpes) - Math.min(...sharpes) : 0;
      const best = sharpes.length > 0 ? Math.max(...sharpes) : 0;
      const worst = sharpes.length > 0 ? Math.min(...sharpes) : 0;
      const totalTrades = sorted.reduce((s, b) => s + (b.oos_trades || 0), 0);
      return { symbol: symbol.replace("USDT", ""), buckets: sorted, spread, best, worst, totalTrades };
    });
  }, [coinRows]);

  const sortedCoins = useMemo(() => {
    const c = [...coins];
    if (sortCol === "spread") c.sort((a, b) => b.spread - a.spread);
    else if (sortCol === "best") c.sort((a, b) => b.best - a.best);
    else if (sortCol === "worst") c.sort((a, b) => a.worst - b.worst);
    else if (sortCol === "trades") c.sort((a, b) => b.totalTrades - a.totalTrades);
    else c.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return c;
  }, [coins, sortCol]);

  if (loading) return <div className="text-[9px] font-mono text-white/30 py-2">Loading per-coin data...</div>;
  if (coins.length === 0) return <div className="text-[9px] font-mono text-white/20 py-2">No per-coin data — run the robustness cron with the latest code to populate.</div>;

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.04]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono font-bold text-white/50">PER-COIN BREAKDOWN — {coins.length} coins</span>
        <div className="flex gap-px rounded overflow-hidden border border-white/[0.06]">
          {(["spread", "best", "worst", "trades", "symbol"] as const).map(s => (
            <button key={s} onClick={() => setSortCol(s)}
              className="px-2 py-0.5 text-[8px] font-mono"
              style={{ background: sortCol === s ? "rgba(212,168,67,0.1)" : "transparent", color: sortCol === s ? GOLD : "rgba(255,255,255,0.25)" }}>
              {s === "spread" ? "↕ Spread" : s === "best" ? "↑ Best" : s === "worst" ? "↓ Worst" : s === "trades" ? "# n" : "A→Z"}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[400px] overflow-y-auto">
        <table className="w-full text-[8px] font-mono border-collapse">
          <thead className="sticky top-0" style={{ background: BG }}>
            <tr className="border-b border-white/[0.06] text-white/30">
              <th className="py-1 px-2 text-left w-[80px]">Coin</th>
              <th className="py-1 px-1 text-center w-[40px]">Spread</th>
              <th className="py-1 px-1 text-center w-[40px]">Trades</th>
              {coinRows.length > 0 && [...new Set(coinRows.map(r => r.bucket_label))].sort().map(label => (
                <th key={label} colSpan={2} className="py-1 px-1 text-center" style={{ borderLeft: "1px solid rgba(255,255,255,0.04)" }}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedCoins.map(coin => (
              <tr key={coin.symbol} className="border-b border-white/[0.02] hover:bg-white/[0.015]">
                <td className="py-1 px-2 text-white/70 font-bold">{coin.symbol}</td>
                <td className="py-1 px-1 text-center" style={{ color: coin.spread > 5 ? "#06b6d4" : coin.spread > 2 ? "#22c55e" : "#a3a3a3" }}>
                  {coin.spread.toFixed(1)}
                </td>
                <td className="py-1 px-1 text-center text-white/30">{coin.totalTrades}</td>
                {coin.buckets.map((b: any, i: number) => (
                  <React.Fragment key={i}>
                    <td className="py-1 px-1 text-center font-bold tabular-nums" style={{
                      borderLeft: "1px solid rgba(255,255,255,0.04)",
                      color: srColor(b.oos_sharpe),
                      background: srBg(b.oos_sharpe),
                    }}>
                      {b.oos_trades >= 2 ? b.oos_sharpe?.toFixed(1) : "–"}
                    </td>
                    <td className="py-1 px-0.5 text-center text-white/20">
                      {b.oos_trades >= 2 ? b.oos_trades : ""}
                    </td>
                  </React.Fragment>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════

export default function RegimeScorecardPage() {
  const [rows, setRows] = useState<ScorecardRow[]>([]);
  const [meta, setMeta] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(true);
  const [tf, setTf] = useState(60);
  const [direction, setDirection] = useState("all");
  const [sortBy, setSortBy] = useState<"spread" | "rho" | "bestSR" | "worstSR" | "trades">("spread");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [allDirData, setAllDirData] = useState<Record<string, ScorecardRow[]>>({});
  const [interpretations, setInterpretations] = useState<Record<string, string>>({});
  const [interpreting, setInterpreting] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/regime?action=scorecard&tf=${tf}&direction=${direction}`);
      const d = await res.json();
      setRows(d.rows || []);
      setMeta(d.meta || []);
      // Load cached interpretations
      if (d.interpretations && Object.keys(d.interpretations).length > 0) {
        setInterpretations(prev => ({ ...prev, ...d.interpretations }));
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [tf, direction]);

  // Fetch all directions for comparison when a feature is expanded
  const fetchAllDirections = useCallback(async (featureKey: string) => {
    const result: Record<string, ScorecardRow[]> = {};
    for (const dir of ["all", "long", "short"]) {
      try {
        const res = await fetch(`/api/regime?action=scorecard&tf=${tf}&direction=${dir}`);
        const d = await res.json();
        result[dir] = (d.rows || []).filter((r: ScorecardRow) => r.feature_key === featureKey);
      } catch {}
    }
    setAllDirData(result);
  }, [tf]);

  // AI interpretation of a feature row
  // Clear interpretations when direction or timeframe changes
  useEffect(() => {
    setInterpretations({});
  }, [direction, tf]);

  const interpretFeature = useCallback(async (feat: FeatureGroup) => {
    if (interpretations[feat.key]) return;
    setInterpreting(feat.key);
    try {
      const bucketSummary = (dir: string, buckets: { label: string; oos_sharpe: number; oos_win_rate: number; oos_avg_ret: number; oos_trades: number }[]) =>
        buckets.map(b => `${b.label}: SR=${b.oos_sharpe?.toFixed(1)}, WR=${b.oos_win_rate?.toFixed(0)}%, n=${b.oos_trades}`).join(" | ");

      let context = `Feature: ${feat.label}\nDirection: ${direction}\nTimeframe: ${tfLabels[tf] || tf + "m"}\nSpread: ${feat.spread?.toFixed(1)}, Stability ρ: ${feat.rho !== null ? feat.rho?.toFixed(2) : "n/a"} (${feat.confidence})\nBuckets: ${bucketSummary(direction, feat.buckets)}`;

      // If viewing "all", fetch long+short context so the interpretation is smarter
      if (direction === "all") {
        try {
          const [longRes, shortRes] = await Promise.all([
            fetch(`/api/regime?action=scorecard&tf=${tf}&direction=long`).then(r => r.json()),
            fetch(`/api/regime?action=scorecard&tf=${tf}&direction=short`).then(r => r.json()),
          ]);
          const longBuckets = (longRes.rows || []).filter((r: any) => r.feature_key === feat.key).sort((a: any, b: any) => a.bucket_index - b.bucket_index);
          const shortBuckets = (shortRes.rows || []).filter((r: any) => r.feature_key === feat.key).sort((a: any, b: any) => a.bucket_index - b.bucket_index);
          if (longBuckets.length > 0) context += `\nLONG only: ${bucketSummary("long", longBuckets)}`;
          if (shortBuckets.length > 0) context += `\nSHORT only: ${bucketSummary("short", shortBuckets)}`;
        } catch {}
      }

      const prompt = `Summarise this data in under 20 words. Rules: state which bucket/direction has highest SR and WR. No metaphors. No interpretation. No words like "edge", "contrarian", "opportunity", "suggests". Only say what the numbers show.

${context}

Under 20 words, numbers only:`;

      const response = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, max_tokens: 80 }),
      });
      const data = await response.json();
      const text = data.text || data.error || "Could not generate interpretation.";
      setInterpretations(prev => ({ ...prev, [feat.key]: text }));
      try {
        await fetch(`/api/regime?action=scorecard-interpret&tf=${tf}&direction=${direction}&feature=${encodeURIComponent(feat.key)}&interpretation=${encodeURIComponent(text)}`);
      } catch {}
    } catch (e) {
      setInterpretations(prev => ({ ...prev, [feat.key]: "Failed to generate interpretation." }));
    }
    setInterpreting(null);
  }, [interpretations, direction, tf]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Group rows by feature
  const features: FeatureGroup[] = useMemo(() => {
    const grouped: Record<string, ScorecardRow[]> = {};
    for (const r of rows) {
      if (!grouped[r.feature_key]) grouped[r.feature_key] = [];
      grouped[r.feature_key].push(r);
    }
    return Object.entries(grouped).map(([key, featureRows]) => {
      const sorted = featureRows.sort((a, b) => a.bucket_index - b.bucket_index);
      const sharpes = sorted.filter(b => b.oos_trades > 2).map(b => b.oos_sharpe);
      const spread = sharpes.length >= 2 ? Math.max(...sharpes) - Math.min(...sharpes) : 0;
      return {
        key,
        label: sorted[0].feature_label,
        buckets: sorted.map(r => ({
          index: r.bucket_index, label: r.bucket_label,
          oos_sharpe: r.oos_sharpe, oos_win_rate: r.oos_win_rate, oos_avg_ret: r.oos_avg_ret, oos_trades: r.oos_trades,
          is_sharpe: r.is_sharpe, is_trades: r.is_trades,
        })),
        spread: sorted[0].spread ?? spread,
        rho: sorted[0].rho,
        confidence: sorted[0].confidence || "insufficient",
        totalTrades: sorted.reduce((s, r) => s + (r.oos_trades || 0), 0),
      };
    });
  }, [rows]);

  // All-directions feature groups for comparison panel
  const allDirFeatures = useMemo(() => {
    const result: Record<string, FeatureGroup> = {};
    for (const [dir, dirRows] of Object.entries(allDirData)) {
      if (dirRows.length === 0) continue;
      const sorted = dirRows.sort((a, b) => a.bucket_index - b.bucket_index);
      const sharpes = sorted.filter(b => b.oos_trades > 2).map(b => b.oos_sharpe);
      result[dir] = {
        key: sorted[0].feature_key, label: sorted[0].feature_label,
        buckets: sorted.map(r => ({
          index: r.bucket_index, label: r.bucket_label,
          oos_sharpe: r.oos_sharpe, oos_win_rate: r.oos_win_rate, oos_avg_ret: r.oos_avg_ret, oos_trades: r.oos_trades,
          is_sharpe: r.is_sharpe, is_trades: r.is_trades,
        })),
        spread: sorted[0].spread ?? 0, rho: sorted[0].rho, confidence: sorted[0].confidence || "insufficient",
        totalTrades: sorted.reduce((s, r) => s + (r.oos_trades || 0), 0),
      };
    }
    return result;
  }, [allDirData]);

  const sortedFeatures = useMemo(() => {
    const f = [...features];
    if (sortBy === "spread") f.sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0));
    else if (sortBy === "rho") f.sort((a, b) => (b.rho ?? -2) - (a.rho ?? -2));
    else if (sortBy === "bestSR") f.sort((a, b) => Math.max(...b.buckets.map(x => x.oos_sharpe)) - Math.max(...a.buckets.map(x => x.oos_sharpe)));
    else if (sortBy === "worstSR") f.sort((a, b) => Math.min(...a.buckets.map(x => x.oos_sharpe)) - Math.min(...b.buckets.map(x => x.oos_sharpe)));
    else f.sort((a, b) => b.totalTrades - a.totalTrades);
    return f;
  }, [features, sortBy]);

  const availableTfs = [...new Set(meta.map(m => m.bar_minutes))].sort((a, b) => a - b);
  const tfLabels: Record<number, string> = { 1: "1m", 60: "1H", 1440: "1D" };
  const totalSignals = rows.length > 0 ? rows[0].total_signals : 0;
  const computedAt = rows.length > 0 ? rows[0].computed_at : null;
  const strategyLabel = rows.length > 0 ? rows[0].strategy_label : "";

  return (
    <div className="min-h-screen" style={{ background: BG, color: "#e2e8f0" }}>
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 border-b border-white/[0.06]" style={{ background: "rgba(8,10,16,0.95)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/" className="text-[15px] font-mono font-black tracking-tight" style={{ color: GOLD }}>
            FRACMAP <span className="text-white/40 font-normal text-[11px]">SIGNAL LAB</span>
          </Link>
          <div className="flex gap-6 text-[11px] font-mono">
            <Link href="/" className="text-white/40 hover:text-white/70 transition">Home</Link>
            <Link href="/signals" className="text-white/40 hover:text-white/70 transition">Signals</Link>
            <Link href="/regime" className="text-white/40 hover:text-white/70 transition">Regime</Link>
            <Link href="/regime/scorecard" className="font-bold" style={{ color: GOLD }}>Scorecard</Link>
            <Link href="/research" className="text-white/40 hover:text-white/70 transition">Research</Link>
            <a href="https://x.com/fracmap_signals" target="_blank" rel="noopener noreferrer" className="text-white/40 hover:text-white/70 transition">Follow on X</a>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-20 pb-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-mono font-black tracking-tight" style={{ color: GOLD }}>
              Regime Scorecard
            </h1>
            <p className="text-[12px] font-mono text-white/50 mt-1">
              The data the LLM board uses to evaluate strategy performance across market conditions.
            </p>
            <p className="text-[10px] font-mono text-white/35 mt-0.5">
              {totalSignals.toLocaleString()} signals · In-sample vs out-of-sample stability testing
              {strategyLabel && <> · {strategyLabel}</>}
              {computedAt && <> · computed {new Date(computedAt).toLocaleString()}</>}
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <button onClick={() => setShowExplainer(!showExplainer)}
            className="text-[10px] font-mono px-3 py-1.5 rounded border transition-all"
            style={{ color: "#06b6d4", borderColor: "rgba(6,182,212,0.2)", background: showExplainer ? "rgba(6,182,212,0.08)" : "transparent" }}>
            {showExplainer ? "▼ Hide explanation" : "▶ What is this page?"}
          </button>
        </div>

        {showExplainer && (
          <div className="mb-6 rounded-lg border p-5 text-[10px] font-mono leading-relaxed space-y-3" style={{ borderColor: "rgba(6,182,212,0.15)", background: "rgba(6,182,212,0.03)" }}>
            <div className="text-[12px] font-bold" style={{ color: "#06b6d4" }}>How to read this scorecard</div>
            
            <div className="text-white/60">
              <span className="text-white/80 font-bold">What you're looking at:</span> Every signal generated by the selected strategy (e.g. the 1H strategy with {totalSignals.toLocaleString()} signals across all coins) has been tagged with the market conditions at the moment it fired — was volatility compressed? Was price at the top or bottom of its range? Was the Hurst exponent high or low? Each row is one of these market condition features.
            </div>

            <div className="text-white/60">
              <span className="text-white/80 font-bold">Buckets:</span> Each feature is split into 3 buckets (e.g. Bottom / Middle / Top for Position in Range). The signals from ALL coins are pooled together and sorted into these buckets based on what the condition was at entry time. The SR, Win%, and AvgR shown are the actual outcomes of signals that fired in each bucket. This is not a single coin — it's the aggregate across every coin the strategy traded.
            </div>

            <div className="text-white/60">
              <span className="text-white/80 font-bold">Spread (ΔSR):</span> The difference between the best and worst bucket Sharpe ratio. A high spread means this feature strongly differentiates between good and bad conditions for the strategy. Spread of 13.3 means one bucket has SR ~10 higher than another — a large effect.
            </div>

            <div className="text-white/60">
              <span className="text-white/80 font-bold">ρ IS→OOS (Spearman rank correlation):</span> This is the most important column. The signal data is split 50/50 into in-sample (IS) and out-of-sample (OOS) halves chronologically. The bucket Sharpe ratios are computed independently on each half, then Spearman rank correlation measures whether the ranking of buckets (best → worst) is the same in both halves.
            </div>

            <div className="pl-4 text-white/50 space-y-1">
              <div><span className="font-bold text-green-400">ρ = 1.00</span> — Perfect: the best bucket IS was also the best bucket OOS. The pattern held out-of-sample.</div>
              <div><span className="font-bold text-green-300">ρ = 0.50</span> — Moderate: some consistency between halves but not fully reliable.</div>
              <div><span className="font-bold text-yellow-400">ρ = 0.00</span> — No relationship: bucket rankings are random between halves. The feature is noise.</div>
              <div><span className="font-bold text-red-400">ρ = -1.00</span> — Inverted: whatever worked IS did the opposite OOS. The pattern is unstable and should not be used.</div>
            </div>

            <div className="text-white/60">
              <span className="text-white/80 font-bold">Direction filter:</span> Use the All / Long / Short toggle to see if the pattern is driven by one side. A feature with high spread on "All" but flat spread on "Long" tells you the effect is entirely in the short signals.
            </div>

            <div className="text-white/60">
              <span className="text-white/80 font-bold">One strategy per timeframe:</span> The 1m, 1H, and 1D buttons each show a different strategy. They are independent — the 1H scorecard shows only signals from the 1H strategy. The regime features are computed from the corresponding candle data (1H candles for 1H strategy).
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 mb-6">
          {/* Timeframe */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-mono text-white/30 mr-1">Timeframe</span>
            <div className="flex gap-px rounded overflow-hidden border border-white/[0.08]">
              {availableTfs.length > 0 ? availableTfs.map(t => (
                <button key={t} onClick={() => setTf(t)}
                  className="px-3 py-1.5 text-[10px] font-mono font-bold transition-all"
                  style={{
                    background: tf === t ? "rgba(212,168,67,0.15)" : "transparent",
                    color: tf === t ? GOLD : "rgba(255,255,255,0.55)",
                  }}>
                  {tfLabels[t] || `${t}m`}
                </button>
              )) : (
                <span className="px-3 py-1.5 text-[10px] font-mono text-white/20">No data yet</span>
              )}
            </div>
          </div>

          {/* Direction */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-mono text-white/30 mr-1">Direction</span>
            <div className="flex gap-px rounded overflow-hidden border border-white/[0.08]">
              {["all", "long", "short"].map(d => (
                <button key={d} onClick={() => setDirection(d)}
                  className="px-3 py-1.5 text-[10px] font-mono font-bold transition-all"
                  style={{
                    background: direction === d ? (d === "long" ? "rgba(34,197,94,0.12)" : d === "short" ? "rgba(239,68,68,0.12)" : "rgba(212,168,67,0.12)") : "transparent",
                    color: direction === d ? (d === "long" ? "#22c55e" : d === "short" ? "#ef4444" : GOLD) : "rgba(255,255,255,0.55)",
                  }}>
                  {d === "all" ? "▬ All" : d === "long" ? "▲ Long" : "▼ Short"}
                </button>
              ))}
            </div>
          </div>

          {/* Sort */}
          <div className="flex items-center gap-1 ml-auto">
            <button onClick={() => {
              sortedFeatures.forEach(f => interpretFeature(f));
            }}
              className="px-3 py-1.5 rounded text-[10px] font-mono font-bold transition-all mr-3 border"
              style={{ background: "rgba(168,85,247,0.1)", color: "#a855f7", borderColor: "rgba(168,85,247,0.2)" }}>
              {interpreting ? "⏳ Interpreting..." : "🧠 Interpret All"}
            </button>
            <span className="text-[9px] font-mono text-white/30 mr-1">Sort</span>
            <div className="flex gap-px rounded overflow-hidden border border-white/[0.08]">
              {([
                ["spread", "↕ Spread"],
                ["rho", "🔗 Stability"],
                ["bestSR", "↑ Best SR"],
                ["worstSR", "↓ Worst SR"],
                ["trades", "# Trades"],
              ] as const).map(([key, label]) => (
                <button key={key} onClick={() => setSortBy(key)}
                  className="px-2 py-1.5 text-[9px] font-mono transition-all"
                  style={{
                    background: sortBy === key ? "rgba(212,168,67,0.12)" : "transparent",
                    color: sortBy === key ? GOLD : "rgba(255,255,255,0.5)",
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-[11px] font-mono text-white/30">Loading scorecard data...</div>
        ) : features.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-[14px] font-mono text-white/40 mb-2">No scorecard data available</div>
            <div className="text-[10px] font-mono text-white/20">
              Run the Robustness Cron from the admin Ops tab to populate regime bucket analysis.
            </div>
          </div>
        ) : (
          <>
            {/* Summary stats */}
            <div className="grid grid-cols-6 gap-3 mb-6">
              {[
                { label: "Features Analysed", value: features.length, color: "#06b6d4" },
                { label: "Total Signals", value: totalSignals.toLocaleString(), color: GOLD },
                { label: "Most Predictive", value: sortedFeatures[0]?.label || "–", color: "#22c55e" },
                { label: "Highest Spread", value: sortedFeatures[0]?.spread?.toFixed(1) || "–", color: "#06b6d4" },
                { label: "Best Stability", value: (() => { const best = [...features].sort((a, b) => (b.rho ?? -2) - (a.rho ?? -2))[0]; return best?.rho !== null ? `${best.label} (ρ=${best.rho?.toFixed(2)})` : "–"; })(), color: "#a78bfa" },
                { label: "Avg Bucket Trades", value: features.length > 0 ? Math.round(features.reduce((s, f) => s + f.totalTrades, 0) / features.reduce((s, f) => s + f.buckets.length, 0)).toLocaleString() : "–", color: "#94a3b8" },
              ].map((s, i) => (
                <div key={i} className="rounded-lg p-3 border border-white/[0.05]" style={{ background: "rgba(255,255,255,0.01)" }}>
                  <div className="text-[9px] font-mono text-white/50">{s.label}</div>
                  <div className="text-[12px] font-mono font-bold mt-0.5 truncate" style={{ color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Main table */}
            <div className="rounded-lg border border-white/[0.06] overflow-hidden" style={{ background: "rgba(255,255,255,0.01)" }}>
              <table className="w-full text-[11px] font-mono border-collapse">
                <thead>
                  <tr style={{ background: "rgba(212,168,67,0.06)" }}>
                    <th className="py-3 px-3 text-left text-white/80 font-bold w-[200px] text-[12px] border-b-2" style={{ borderColor: "rgba(212,168,67,0.3)" }}>Feature</th>
                    <th className="py-3 px-2 text-center text-white/80 font-bold w-[60px] text-[11px] border-b-2" style={{ borderColor: "rgba(212,168,67,0.3)" }}>Spread</th>
                    <th className="py-3 px-2 text-center font-bold w-[65px] text-[11px] border-b-2" style={{ color: "#c4b5fd", borderColor: "rgba(212,168,67,0.3)" }}>ρ IS→OOS</th>
                    {[0, 1, 2].map(i => (
                      <th key={i} colSpan={4} className="py-3 px-1 text-center font-bold text-[11px] border-b-2" style={{ color: "#22d3ee", borderLeft: "2px solid rgba(255,255,255,0.06)", borderColor: "rgba(212,168,67,0.3)" }}>
                        Bucket {i + 1}
                      </th>
                    ))}
                  </tr>
                  <tr className="border-b border-white/[0.08]" style={{ background: "rgba(255,255,255,0.02)" }}>
                    <th className="py-1.5 px-3 text-left font-normal"></th>
                    <th className="py-1.5 px-2 text-center font-normal text-white/40 text-[10px]">ΔSR</th>
                    <th className="py-1.5 px-2 text-center font-normal text-[10px]" style={{ color: "#a78bfa" }}>ρ</th>
                    {[0, 1, 2].map(i => (
                      <th key={i} colSpan={4} className="py-1.5 font-normal" style={{ borderLeft: "2px solid rgba(255,255,255,0.06)" }}>
                        <div className="grid grid-cols-4 gap-0 text-center text-white/50 text-[10px]">
                          <span>n</span><span>SR</span><span>Win%</span><span>AvgR</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedFeatures.map(feat => (
                    <React.Fragment key={feat.key}>
                    <tr
                      className="hover:bg-white/[0.02] cursor-pointer transition-colors"
                      style={{ borderBottom: interpretations[feat.key] ? "none" : "1px solid rgba(255,255,255,0.04)" }}
                      onClick={() => {
                        if (expanded === feat.key) { setExpanded(null); }
                        else { setExpanded(feat.key); fetchAllDirections(feat.key); }
                      }}>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <div>
                            <div className="font-bold text-white text-[12px]">{feat.label}</div>
                            <div className="text-white/30 text-[9px]">{feat.totalTrades} signals</div>
                          </div>
                          {!interpretations[feat.key] && (
                            <button onClick={(e) => { e.stopPropagation(); interpretFeature(feat); }}
                              className="text-[9px] font-mono px-1.5 py-0.5 rounded transition-all opacity-20 hover:opacity-80"
                              style={{ color: "#a855f7", background: "rgba(168,85,247,0.1)" }}>
                              🧠
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 text-center font-bold text-[12px]" style={{ color: feat.spread > 3 ? "#06b6d4" : feat.spread > 1.5 ? "#22c55e" : "#a3a3a3" }}>
                        {feat.spread?.toFixed(1)}
                      </td>
                      <td className="py-2.5 px-2 text-center font-bold tabular-nums" style={{ color: feat.rho !== null ? rhoColor(feat.rho) : "#666" }}>
                        {feat.rho !== null && feat.confidence !== "insufficient" ? (
                          <div>
                            <div className="text-[12px]">{feat.rho?.toFixed(2)}</div>
                            <div className="text-[8px] font-normal" style={{ color: confidenceColor(feat.confidence) }}>{feat.confidence}</div>
                          </div>
                        ) : <span className="text-white/25">n/a</span>}
                      </td>
                      {[0, 1, 2].map(bi => {
                        const b = feat.buckets[bi];
                        if (!b) return <td key={bi} colSpan={4} style={{ borderLeft: "2px solid rgba(255,255,255,0.06)" }}></td>;
                        return (
                          <td key={bi} colSpan={4} style={{ borderLeft: "2px solid rgba(255,255,255,0.06)" }}>
                            <div className="grid grid-cols-4 gap-0 text-center items-center">
                              <div>
                                <div className="text-[8px] text-white/30 leading-none mb-0.5 truncate px-0.5">{b.label}</div>
                                <span className="text-white/40 text-[10px]">{b.oos_trades}</span>
                              </div>
                              <div className="font-bold tabular-nums text-[12px] py-1 rounded-sm" style={{ color: srColor(b.oos_sharpe), background: srBg(b.oos_sharpe) }}>
                                {b.oos_trades > 2 ? b.oos_sharpe?.toFixed(1) : "–"}
                              </div>
                              <div className="tabular-nums text-[11px]" style={{ color: wrColor(b.oos_win_rate) }}>
                                {b.oos_trades > 2 ? `${b.oos_win_rate?.toFixed(0)}%` : "–"}
                              </div>
                              <div className="tabular-nums text-[10px]" style={{ color: b.oos_avg_ret > 0 ? "#22c55e" : "#ef4444" }}>
                                {b.oos_trades > 2 ? `${b.oos_avg_ret > 0 ? "+" : ""}${b.oos_avg_ret?.toFixed(3)}%` : "–"}
                              </div>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    {interpretations[feat.key] && (
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        <td colSpan={15} className="pb-2.5 px-3 pt-0">
                          <div className="ml-1 pl-3 py-1.5 text-[10px] font-mono text-white/55 leading-relaxed" style={{ borderLeft: "2px solid rgba(168,85,247,0.3)" }}>
                            {interpretations[feat.key]}
                          </div>
                        </td>
                      </tr>
                    )}
                    {interpreting === feat.key && !interpretations[feat.key] && (
                      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        <td colSpan={15} className="pb-2.5 px-3 pt-0">
                          <div className="ml-1 pl-3 py-1.5 text-[9px] font-mono text-white/25" style={{ borderLeft: "2px solid rgba(168,85,247,0.15)" }}>
                            ⏳ Generating...
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Expanded detail */}
            {expanded && (() => {
              const feat = features.find(f => f.key === expanded);
              if (!feat) return null;
              return (
                <div className="mt-4 space-y-0">
                  <FeatureDetail feature={feat} allDirections={allDirFeatures} />
                  <div className="rounded-lg border border-white/[0.06] p-4 mt-0" style={{ background: "rgba(212,168,67,0.02)" }}>
                    <CoinDrillDown featureKey={feat.key} tf={tf} direction={direction} />
                  </div>
                </div>
              );
            })()}

          </>
        )}
      </div>
    </div>
  );
}
