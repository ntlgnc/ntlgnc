"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

const GOLD = "#D4A843";
const BG = "#080a10";

const MEMBER_COLORS: Record<string, string> = {
  claude: "#c4a5ff", gpt: "#74d4a8", grok: "#ff9966", gemini: "#66bbff", deepseek: "#ffcc44",
};
const MEMBER_ROLES: Record<string, string> = {
  claude: "Chief Risk Officer", gpt: "Alpha Hunter", grok: "Contrarian",
  gemini: "Systems Architect", deepseek: "Empiricist",
};
const MEMBER_EMOJI: Record<string, string> = {
  claude: "🛡", gpt: "🎯", grok: "⚡", gemini: "🏗", deepseek: "📊",
};

// ═══════════════════════════════════════════════════════════════
// Color helpers
// ═══════════════════════════════════════════════════════════════

function rangeColor(val: number) {
  // 0 = deep red, 0.5 = neutral, 1 = deep green
  if (val < 0.25) return "#ef4444";
  if (val < 0.5) return "#f59e0b";
  if (val < 0.75) return "#a3e635";
  return "#22c55e";
}

function volStateColor(state: string) {
  if (state === "COMPRESSED") return "#ef4444";
  if (state === "EXPANDING") return "#22c55e";
  return "#94a3b8";
}

function regimeColor(regime: string) {
  if (regime === "TREND") return "#22c55e";
  if (regime === "RANGE") return "#3b82f6";
  return "#a78bfa";
}

function changePctColor(pct: number) {
  if (pct > 3) return "#22c55e";
  if (pct > 0) return "#86efac";
  if (pct > -3) return "#fca5a5";
  return "#ef4444";
}

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

type CoinSnapshot = {
  symbol: string;
  price: number;
  change24h: number;
  posInRange60: number;
  posInRange5d: number;
  trend60: number;
  trend5d: number;
  persistence60: number;
  hurst: number;
  atrCompression: number;
  volRatio: number;
  volRatio5d: number;
  vol60: number;
  regime: string;
  volState: string;
  direction: string;
  posInRangeBucket: string;
  longFavourable: boolean;
  shortFavourable: boolean;
};

type MarketAgg = {
  totalCoins: number;
  regime: { TREND: number; RANGE: number; TRANSITION: number };
  volState: { COMPRESSED: number; NORMAL: number; EXPANDING: number };
  rangePosition: { BOTTOM: number; MIDDLE: number; TOP: number };
  trend: { DOWN: number; FLAT: number; UP: number };
  avgHurst: number;
  avgAtrCompression: number;
  avgVolRatio5d: number;
  longFavourableCount: number;
  shortFavourableCount: number;
  marketMood: string;
};

type BoardMeeting = {
  id: number;
  time: string;
  round: number;
  chair: string;
  decision: string;
  motionType: string;
  motionDetails: any;
  deployed: boolean;
  votes: any;
  briefing: string;
  keyIssue: string;
  debate: { name: string; role: string; assessment: string; support: boolean; concern?: string; insight?: string }[];
  durationMs: number;
  tokens: number;
};

// ═══════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════

function MarketMoodCard({ market, filters }: { market: MarketAgg; filters: any[] }) {
  const longPct = (market.longFavourableCount / market.totalCoins * 100).toFixed(0);
  const shortPct = (market.shortFavourableCount / market.totalCoins * 100).toFixed(0);
  const compressedPct = (market.volState.COMPRESSED / market.totalCoins * 100).toFixed(0);
  const transitionPct = (market.regime.TRANSITION / market.totalCoins * 100).toFixed(0);
  const trendPct = (market.regime.TREND / market.totalCoins * 100).toFixed(0);

  // Derive a plain-English market read
  const moodEmoji = market.marketMood.includes("Bearish") ? "🔴" : market.marketMood.includes("Bullish") ? "🟢" : "🟡";
  const isTough = parseInt(compressedPct) > 20 || parseInt(transitionPct) > 60;
  const activeFilterCount = filters.length;
  const workingFilterCount = filters.filter((f: any) => (f.trades_filtered || 0) + (f.trades_passed || 0) > 0).length;

  return (
    <div className="space-y-4">
      {/* ── HEADLINE: What's happening right now ── */}
      <div className="rounded-xl p-5" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(212,168,67,0.15)" }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-widest" style={{ color: GOLD }}>
              Market Conditions
            </div>
            <div className="text-[18px] font-mono font-bold mt-1" style={{ color: "#e2e8f0" }}>
              {moodEmoji} {market.marketMood}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-mono text-white/40">{market.totalCoins} coins tracked</div>
            <div className="text-[10px] font-mono mt-0.5" style={{ color: workingFilterCount > 0 ? GOLD : "#ef4444" }}>
              {workingFilterCount > 0 
                ? `${workingFilterCount} of ${activeFilterCount} filters working` 
                : activeFilterCount > 0 
                  ? `${activeFilterCount} filters deployed but not connected`
                  : 'No filters active'}
            </div>
          </div>
        </div>

        {/* Plain-English summary */}
        <div className="text-[11px] font-mono text-white/60 leading-relaxed mb-4 p-3 rounded-lg" style={{ background: "rgba(255,255,255,0.02)" }}>
          {parseInt(transitionPct) > 60
            ? `Most of the market (${transitionPct}%) is in transition — neither clearly trending nor ranging. This makes signals less reliable.`
            : parseInt(trendPct) > 30
            ? `${trendPct}% of coins are trending — good conditions for directional signals.`
            : `The market is mixed — ${market.regime.RANGE} coins are ranging, ${market.regime.TREND} are trending.`}
          {parseInt(compressedPct) > 15
            ? ` Volatility is compressed on ${compressedPct}% of coins — historically these produce poor signals (Sharpe -1.0).`
            : ` Volatility conditions are mostly normal.`}
          {` Currently ${longPct}% of coins favour longs, ${shortPct}% favour shorts.`}
        </div>

        {/* 3 clear metric cards */}
        <div className="grid grid-cols-3 gap-3">
          {/* Card 1: Market Direction */}
          <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
            <div className="text-[9px] font-mono text-white/40 mb-2">WHERE IS PRICE?</div>
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono text-red-400">Bottom</span>
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 rounded-full bg-red-500/30" style={{ width: Math.max(8, market.rangePosition.BOTTOM / market.totalCoins * 80) }} />
                  <span className="text-[11px] font-mono font-bold text-white/80">{market.rangePosition.BOTTOM}</span>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono text-white/50">Middle</span>
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 rounded-full bg-white/20" style={{ width: Math.max(8, market.rangePosition.MIDDLE / market.totalCoins * 80) }} />
                  <span className="text-[11px] font-mono font-bold text-white/80">{market.rangePosition.MIDDLE}</span>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono text-green-400">Top</span>
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 rounded-full bg-green-500/30" style={{ width: Math.max(8, market.rangePosition.TOP / market.totalCoins * 80) }} />
                  <span className="text-[11px] font-mono font-bold text-white/80">{market.rangePosition.TOP}</span>
                </div>
              </div>
            </div>
            <div className="text-[8px] font-mono text-white/25 mt-2">
              Longs blocked at bottom · Shorts blocked at top
            </div>
          </div>

          {/* Card 2: Volatility */}
          <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
            <div className="text-[9px] font-mono text-white/40 mb-2">VOLATILITY STATE</div>
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono text-red-400">Compressed</span>
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 rounded-full bg-red-500/30" style={{ width: Math.max(8, market.volState.COMPRESSED / market.totalCoins * 80) }} />
                  <span className="text-[11px] font-mono font-bold text-white/80">{market.volState.COMPRESSED}</span>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono text-white/50">Normal</span>
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 rounded-full bg-white/20" style={{ width: Math.max(8, market.volState.NORMAL / market.totalCoins * 80) }} />
                  <span className="text-[11px] font-mono font-bold text-white/80">{market.volState.NORMAL}</span>
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono text-green-400">Expanding</span>
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 rounded-full bg-green-500/30" style={{ width: Math.max(8, market.volState.EXPANDING / market.totalCoins * 80) }} />
                  <span className="text-[11px] font-mono font-bold text-white/80">{market.volState.EXPANDING}</span>
                </div>
              </div>
            </div>
            <div className="text-[8px] font-mono text-white/25 mt-2">
              Compressed = low quality · signals blocked
            </div>
          </div>

          {/* Card 3: What's being traded */}
          <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
            <div className="text-[9px] font-mono text-white/40 mb-2">SIGNAL QUALITY</div>
            <div className="space-y-2.5">
              <div>
                <div className="flex justify-between items-center mb-0.5">
                  <span className="text-[10px] font-mono text-green-400">Long-favourable</span>
                  <span className="text-[13px] font-mono font-bold text-green-400">{longPct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div className="h-full rounded-full bg-green-500/40" style={{ width: `${longPct}%` }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-0.5">
                  <span className="text-[10px] font-mono text-red-400">Short-favourable</span>
                  <span className="text-[13px] font-mono font-bold text-red-400">{shortPct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div className="h-full rounded-full bg-red-500/40" style={{ width: `${shortPct}%` }} />
                </div>
              </div>
            </div>
            <div className="text-[8px] font-mono text-white/25 mt-2">
              Hurst {market.avgHurst.toFixed(2)} · ATR {market.avgAtrCompression.toFixed(2)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CoinHeatmap({ coins, sortKey, setSortKey }: { coins: CoinSnapshot[]; sortKey: string; setSortKey: (k: string) => void }) {
  const [hoveredCoin, setHoveredCoin] = useState<string | null>(null);
  const sortedCoins = [...coins].sort((a, b) => {
    if (sortKey === "symbol") return a.symbol.localeCompare(b.symbol);
    if (sortKey === "change24h") return b.change24h - a.change24h;
    if (sortKey === "posInRange60") return (b.posInRange60 ?? 0) - (a.posInRange60 ?? 0);
    if (sortKey === "quality") {
      const qa = (a.longFavourable ? 1 : 0) + (a.shortFavourable ? 1 : 0);
      const qb = (b.longFavourable ? 1 : 0) + (b.shortFavourable ? 1 : 0);
      return qb - qa;
    }
    return 0;
  });

  const sortBtn = (key: string, label: string) => (
    <button
      onClick={() => setSortKey(key)}
      className="px-2 py-0.5 rounded text-[9px] font-mono transition-all"
      style={{
        background: sortKey === key ? "rgba(212,168,67,0.15)" : "transparent",
        color: sortKey === key ? GOLD : "rgba(255,255,255,0.4)",
        border: `1px solid ${sortKey === key ? "rgba(212,168,67,0.3)" : "transparent"}`,
      }}
    >
      {label}
    </button>
  );

  // Signal quality assessment for each coin
  const getQuality = (c: CoinSnapshot) => {
    if (c.volState === "COMPRESSED") return { label: "BLOCKED", color: "#ef4444", desc: "Compressed volatility — signals blocked" };
    if (c.longFavourable && c.shortFavourable) return { label: "BOTH", color: "#22c55e", desc: "Good conditions for long and short" };
    if (c.longFavourable) return { label: "LONG OK", color: "#86efac", desc: "Favourable for long signals" };
    if (c.shortFavourable) return { label: "SHORT OK", color: "#fca5a5", desc: "Favourable for short signals" };
    return { label: "CAUTION", color: "#94a3b8", desc: "Mixed conditions — signals may underperform" };
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-white/40">SORT:</span>
          {sortBtn("quality", "Signal Quality")}
          {sortBtn("change24h", "24h %")}
          {sortBtn("posInRange60", "Range Pos")}
          {sortBtn("symbol", "A-Z")}
        </div>
        <div className="text-[9px] font-mono text-white/30">
          Hover any coin for details
        </div>
      </div>

      {/* Compact grid view */}
      <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
        {sortedCoins.map(c => {
          const q = getQuality(c);
          const isHovered = hoveredCoin === c.symbol;
          return (
            <div
              key={c.symbol}
              onMouseEnter={() => setHoveredCoin(c.symbol)}
              onMouseLeave={() => setHoveredCoin(null)}
              className="rounded-lg p-2 cursor-default transition-all relative"
              style={{
                background: isHovered ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${isHovered ? "rgba(212,168,67,0.3)" : q.label === "BLOCKED" ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.04)"}`,
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-mono font-bold text-white/90">{c.symbol.replace("USDT", "")}</span>
                <span className="text-[9px] font-mono font-bold" style={{ color: changePctColor(c.change24h) }}>
                  {c.change24h >= 0 ? "+" : ""}{c.change24h.toFixed(1)}%
                </span>
              </div>

              {/* Range position bar */}
              <div className="h-1.5 rounded-full bg-white/5 mb-1.5 overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{
                  width: `${((c.posInRange60 ?? 0.5) * 100)}%`,
                  background: `linear-gradient(to right, #ef4444, #f59e0b 25%, #a3e635 50%, #22c55e)`,
                  opacity: 0.7,
                }} />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[8px] font-mono px-1 py-0.5 rounded" style={{
                  background: `${q.color}10`, color: q.color, border: `1px solid ${q.color}20`,
                }}>{q.label}</span>
                <span className="text-[8px] font-mono" style={{ color: volStateColor(c.volState) }}>
                  {c.volState === "COMPRESSED" ? "🔻" : c.volState === "EXPANDING" ? "🔺" : ""}
                  {c.volState.slice(0, 4)}
                </span>
              </div>

              {/* Hover tooltip */}
              {isHovered && (
                <div className="absolute bottom-full left-0 mb-1 z-50 p-3 rounded-lg min-w-[220px]" style={{
                  background: "rgba(8,10,16,0.97)", border: "1px solid rgba(212,168,67,0.25)",
                  backdropFilter: "blur(8px)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                }}>
                  <div className="text-[11px] font-mono font-bold text-white mb-1">{c.symbol.replace("USDT", "")} — {q.desc}</div>
                  <div className="text-[9px] font-mono text-white/50 space-y-0.5">
                    <div>Range position: <span style={{ color: rangeColor(c.posInRange60 ?? 0.5) }}>{((c.posInRange60 ?? 0) * 100).toFixed(0)}%</span> {(c.posInRange60 ?? 0.5) < 0.25 ? "(longs blocked)" : (c.posInRange60 ?? 0.5) > 0.75 ? "(shorts blocked)" : "(clear)"}</div>
                    <div>Volatility: <span style={{ color: volStateColor(c.volState) }}>{c.volState}</span> {c.volState === "COMPRESSED" ? "— all signals blocked" : ""}</div>
                    <div>Regime: <span style={{ color: regimeColor(c.regime) }}>{c.regime}</span></div>
                    <div>Hurst: {c.hurst?.toFixed(2) ?? "—"} {(c.hurst ?? 0.5) < 0.45 ? "(mean-reverting)" : (c.hurst ?? 0.5) > 0.55 ? "(trending)" : "(random walk)"}</div>
                    <div>Trend: {c.trend60 != null ? `${c.trend60 > 0 ? "+" : ""}${c.trend60.toFixed(2)}` : "—"}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BoardMeetingCard({ meeting }: { meeting: BoardMeeting }) {
  const [expanded, setExpanded] = useState(false);
  const passed = meeting.decision?.startsWith("PASSED");
  const chairColor = MEMBER_COLORS[meeting.chair] || "#aaa";
  const timeAgo = getTimeAgo(meeting.time);

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
      {/* Header */}
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left p-4 hover:bg-white/[0.02] transition-colors">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-bold" style={{ color: GOLD }}>
              Board #{meeting.round}
            </span>
            <span className="text-[10px] font-mono" style={{ color: chairColor }}>
              {MEMBER_EMOJI[meeting.chair]} {meeting.chair.toUpperCase()} chairing
            </span>
            <span className="text-[9px] font-mono text-white/30">{timeAgo}</span>
          </div>
          <span className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold ${passed ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
            {passed ? "✅ PASSED" : "❌ FAILED"}
            {meeting.deployed && " · DEPLOYED"}
          </span>
        </div>

        {meeting.briefing && (
          <div className="text-[11px] font-mono text-white/60 mb-1">{meeting.briefing}</div>
        )}
        {meeting.keyIssue && (
          <div className="text-[11px] font-mono text-white/40">
            <span className="text-yellow-400/60">Key issue:</span> {meeting.keyIssue}
          </div>
        )}
      </button>

      {/* Expanded debate */}
      {expanded && meeting.debate && (
        <div className="border-t px-4 pb-4" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          <div className="text-[9px] font-mono text-white/30 mt-3 mb-2 uppercase tracking-widest">Debate</div>
          {meeting.debate.map((d, i) => (
            <div key={i} className="mb-3 pl-3 border-l-2" style={{ borderColor: MEMBER_COLORS[d.name?.toLowerCase()] || "#555" }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-mono font-bold" style={{ color: MEMBER_COLORS[d.name?.toLowerCase()] || "#aaa" }}>
                  {MEMBER_EMOJI[d.name?.toLowerCase()] || "💬"} {d.name}
                </span>
                <span className="text-[9px] font-mono text-white/30">{d.role}</span>
                <span className={`text-[9px] font-mono ${d.support ? "text-green-400" : "text-red-400"}`}>
                  {d.support ? "✓ support" : "✗ oppose"}
                </span>
              </div>
              <div className="text-[10px] font-mono text-white/50 leading-relaxed">{d.assessment}</div>
              {d.concern && (
                <div className="text-[9px] font-mono text-yellow-400/50 mt-1">⚠ {d.concern}</div>
              )}
              {d.insight && (
                <div className="text-[9px] font-mono text-blue-400/50 mt-1">💡 {d.insight}</div>
              )}
            </div>
          ))}

          {/* Votes summary */}
          {meeting.votes && (
            <div className="flex gap-2 mt-2">
              {Object.entries(meeting.votes).map(([id, v]: [string, any]) => (
                <span key={id} className="px-2 py-0.5 rounded text-[9px] font-mono"
                  style={{
                    background: v.support ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                    color: v.support ? "#22c55e" : "#ef4444",
                    border: `1px solid ${v.support ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)"}`,
                  }}>
                  {MEMBER_EMOJI[id]} {id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatFilterRules(conditions: any): string[] {
  if (!conditions) return ["No conditions"];
  const cond = typeof conditions === "string" ? JSON.parse(conditions) : conditions;
  const lines: string[] = [];
  
  if (cond.rules && Array.isArray(cond.rules)) {
    for (const r of cond.rules) {
      const dir = r.direction ? `${r.direction}s` : "All";
      const feature = r.feature || "unknown";
      let constraint = "";
      if (r.min !== undefined && r.max !== undefined) constraint = `${r.min} – ${r.max}`;
      else if (r.min !== undefined) constraint = `≥ ${r.min}`;
      else if (r.max !== undefined) constraint = `≤ ${r.max}`;
      const label = r.label || `${feature} ${constraint}`;
      lines.push(`${dir}: ${label}`);
    }
  } else {
    // Simple threshold filter
    const feature = cond.feature || "unknown";
    if (cond.min !== undefined) lines.push(`${feature} ≥ ${cond.min}`);
    if (cond.max !== undefined) lines.push(`${feature} ≤ ${cond.max}`);
    if (cond.allowed) lines.push(`${feature} in [${cond.allowed.join(", ")}]`);
    if (cond.blocked) lines.push(`${feature} not in [${cond.blocked.join(", ")}]`);
  }
  return lines.length > 0 ? lines : ["Active"];
}

function ActiveFilters({ filters }: { filters: any[] }) {
  const [expanded, setExpanded] = useState(false);

  if (filters.length === 0) return null;

  // Group by timeframe
  const byTf: Record<string, any[]> = { all: [], '1m': [], '1h': [], '1d': [] };
  filters.forEach(f => {
    const tf = (f.timeframe || 'all').toLowerCase();
    if (byTf[tf]) byTf[tf].push(f);
    else byTf['all'].push(f);
  });

  const tfConfig: { key: string; label: string; color: string }[] = [
    { key: '1m', label: '1-Minute', color: '#3b82f6' },
    { key: '1h', label: '1-Hour', color: '#a78bfa' },
    { key: '1d', label: 'Daily', color: GOLD },
  ];

  // Generate narrative summary per timeframe
  function narrativeFor(tf: string): string {
    const specific = byTf[tf] || [];
    const global = byTf['all'] || [];
    const all = [...specific, ...global];
    if (all.length === 0) return "No filters — all signals pass through unfiltered.";

    const working = all.filter((f: any) => (f.trades_filtered || 0) + (f.trades_passed || 0) > 0);
    const notConnected = all.length - working.length;

    // Extract what the filters actually do
    const blocks: string[] = [];
    for (const f of all) {
      const feat = (f.feature || '').toLowerCase();
      if (feat.includes('posinrange') || feat.includes('range_position') || feat.includes('range position')) {
        blocks.push("range position gating");
      } else if (feat.includes('volstate') || feat.includes('vol_state') || feat.includes('volatility')) {
        blocks.push("compressed volatility blocking");
      } else if (feat.includes('atr')) {
        blocks.push("ATR compression filter");
      } else if (feat.includes('kill') || feat.includes('KILL') || feat.includes('diagnostic')) {
        blocks.push("diagnostic/kill-test");
      } else if (feat.includes('circuit') || feat.includes('stabilisation') || feat.includes('emergency')) {
        blocks.push("circuit breaker");
      } else {
        blocks.push(f.feature);
      }
    }
    const unique = [...new Set(blocks)];

    if (working.length === 0) {
      return `${all.length} filter${all.length > 1 ? 's' : ''} deployed but NONE actively blocking signals. Board decisions are not reaching the signal engine.`;
    }
    if (notConnected > 0) {
      return `${working.length} of ${all.length} filters active: ${unique.join(", ")}. ${notConnected} not yet connected.`;
    }
    return `${all.length} filter${all.length > 1 ? 's' : ''} active: ${unique.join(", ")}.`;
  }

  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-mono uppercase tracking-widest" style={{ color: GOLD }}>
          Signal Filtering
        </div>
        <div className="text-[9px] font-mono text-white/30">
          {filters.length} filter{filters.length !== 1 ? 's' : ''} deployed by the LLM Strategy Board
        </div>
      </div>

      {/* Narrative summaries per timeframe */}
      <div className="space-y-2 mb-3">
        {tfConfig.map(({ key, label, color }) => {
          const count = (byTf[key]?.length || 0) + (byTf['all']?.length || 0);
          return (
            <div key={key} className="flex items-start gap-2">
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shrink-0 mt-0.5" style={{
                background: `${color}15`, color, border: `1px solid ${color}25`,
              }}>{label}</span>
              <span className="text-[10px] font-mono text-white/50 leading-relaxed">
                {count > 0 ? narrativeFor(key) : <span className="text-white/25">Unfiltered — no protection active.</span>}
              </span>
            </div>
          );
        })}
      </div>

      {/* Expandable detail */}
      <button onClick={() => setExpanded(!expanded)}
        className="text-[9px] font-mono transition-all px-2 py-1 rounded"
        style={{ color: "rgba(255,255,255,0.3)", background: expanded ? "rgba(255,255,255,0.04)" : "transparent" }}>
        {expanded ? "▾ Hide filter details" : "▸ Show filter details"} ({filters.length})
      </button>

      {expanded && (
        <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
          {filters.map((f, i) => {
            const rules = formatFilterRules(f.conditions);
            const tf = (f.timeframe || 'all').toLowerCase();
            const tfInfo = tfConfig.find(t => t.key === tf) || { label: 'ALL', color: GOLD };
            return (
              <div key={i} className="py-2 border-t first:border-t-0" style={{ borderColor: "rgba(255,255,255,0.03)" }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-1 py-0.5 rounded text-[7px] font-mono font-bold" style={{
                    background: `${tfInfo.color}15`, color: tfInfo.color,
                  }}>{tfInfo.label}</span>
                  <span className="text-[10px] font-mono text-white/70">{f.feature}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 ml-1">
                  {rules.map((r, j) => (
                    <span key={j} className="px-1.5 py-0.5 rounded text-[8px] font-mono"
                      style={{
                        background: "rgba(255,255,255,0.03)",
                        color: "rgba(255,255,255,0.4)",
                        border: "1px solid rgba(255,255,255,0.06)",
                      }}>
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════

function getTimeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ═══════════════════════════════════════════════════════════════
// Main page
// ═══════════════════════════════════════════════════════════════

export default function RegimePage() {
  const [coins, setCoins] = useState<CoinSnapshot[]>([]);
  const [market, setMarket] = useState<MarketAgg | null>(null);
  const [meetings, setMeetings] = useState<BoardMeeting[]>([]);
  const [filters, setFilters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [sortKey, setSortKey] = useState("quality");
  const [tab, setTab] = useState<"heatmap" | "board">("heatmap");
  const [regimeTf, setRegimeTf] = useState<"1m" | "1h" | "1d">("1h");
  const [allTfSummary, setAllTfSummary] = useState<Record<string, any>>({});
  const [aiNarrative, setAiNarrative] = useState<{ headline: string; body: string } | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [regimeRes, boardRes, multiRes] = await Promise.all([
        fetch(`/api/regime?action=snapshot&tf=${regimeTf}`).then(r => r.json()),
        fetch("/api/regime?action=board-summary").then(r => r.json()),
        fetch("/api/regime?action=snapshot-multi").then(r => r.json()).catch(() => ({ timeframes: {} })),
      ]);

      if (regimeRes.coins) {
        setCoins(regimeRes.coins);
        setMarket(regimeRes.market);
        setLastUpdate(regimeRes.timestamp);
      }

      if (boardRes.meetings) setMeetings(boardRes.meetings);
      if (boardRes.filters) setFilters(boardRes.filters);
      if (multiRes.timeframes) setAllTfSummary(multiRes.timeframes);
      
      // Generate AI narrative from all timeframe data — check cache first
      if (multiRes.timeframes && Object.keys(multiRes.timeframes).length >= 2) {
        try {
          const cacheRes = await fetch("/api/regime?action=market-narrative");
          const cacheData = await cacheRes.json();
          if (cacheData.narrative) {
            setAiNarrative({ headline: cacheData.narrative.headline, body: cacheData.narrative.body });
          } else {
            generateNarrative(multiRes.timeframes, regimeRes.market);
          }
        } catch {
          generateNarrative(multiRes.timeframes, regimeRes.market);
        }
      }
    } catch (e) {
      console.error("Fetch error:", e);
    }
    setLoading(false);
  }, [regimeTf]);

  const generateNarrative = async (tfData: Record<string, any>, currentMarket: any) => {
    if (narrativeLoading || aiNarrative) return;
    setNarrativeLoading(true);
    try {
      const tfSummaries = Object.entries(tfData).map(([tf, data]: [string, any]) => {
        const m = data.market;
        if (!m) return `${tf}: no data`;
        return `${tf}: ${m.totalCoins} coins, mood=${m.marketMood}, regime=${m.regime?.TREND || 0} trend/${m.regime?.RANGE || 0} range/${m.regime?.TRANSITION || 0} transition, vol=${m.volState?.COMPRESSED || 0} compressed/${m.volState?.NORMAL || 0} normal/${m.volState?.EXPANDING || 0} expanding, position=${m.rangePosition?.BOTTOM || 0} bottom/${m.rangePosition?.MIDDLE || 0} middle/${m.rangePosition?.TOP || 0} top, hurst=${m.avgHurst?.toFixed(2)}, longFav=${m.longFavourableCount}, shortFav=${m.shortFavourableCount}`;
      }).join("\n");

      const prompt = `You are writing a market conditions summary for a crypto counter-trend trading system called FRACMAP Signal Lab. The system looks for movement exhaustions and generates counter-trend signals across three timeframes: 1-minute (micro-momentum), 1-hour (medium), and daily (swing reversals).

Here is the current regime data across all timeframes:
${tfSummaries}

Write TWO things in JSON format:
1. "headline" — A bold 4-8 word market headline (no emoji). Write it so a non-technical reader understands it. Avoid jargon like "compression squeeze" — instead say things like "Volatility Drying Up Across All Timeframes" or "Markets Flat and Waiting For Direction".
2. "body" — A 2-3 sentence plain English summary. The reader may not be a professional trader. If you use any technical term, briefly explain what it means in parentheses the first time. For example: "volatility is compressed (price movements have become unusually small)" or "Hurst exponents below 0.45 (indicating prices are bouncing back and forth rather than trending)". Be specific about the numbers. Explain what the system is doing across timeframes and why.

Respond with ONLY the JSON object: {"headline": "...", "body": "..."}`;

      const response = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, max_tokens: 300 }),
      });
      const data = await response.json();
      const text = data.text || "";
      const cleaned = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      setAiNarrative(parsed);
      // Cache it
      try {
        await fetch(`/api/regime?action=save-market-narrative&headline=${encodeURIComponent(parsed.headline)}&body=${encodeURIComponent(parsed.body)}`);
      } catch {}
    } catch (e) {
      console.error("Narrative generation failed:", e);
    }
    setNarrativeLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    fetchData();
    const iv = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [fetchData]);

  const tfMeta: Record<string, { label: string; color: string; refresh: string }> = {
    '1m': { label: '1-Minute', color: '#3b82f6', refresh: 'every 5 min' },
    '1h': { label: '1-Hour', color: '#a78bfa', refresh: 'every 15 min' },
    '1d': { label: 'Daily', color: GOLD, refresh: 'every 30 min' },
  };

  return (
    <div className="min-h-screen" style={{ background: BG, color: "#e2e8f0" }}>
      {/* Header */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-20 pb-6">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="text-2xl font-mono font-black tracking-tight" style={{ color: GOLD }}>
              Market Regime Monitor
            </h1>
            <p className="text-[11px] font-mono text-white/40 mt-1">
              Regime analysis across {coins.length} coins · Viewing <span className="font-bold" style={{ color: tfMeta[regimeTf].color }}>{tfMeta[regimeTf].label}</span> candles · Cached {tfMeta[regimeTf].refresh}
            </p>
          </div>
          <div className="text-right">
            {lastUpdate && (
              <div className="text-[9px] font-mono text-white/30">
                Updated {getTimeAgo(lastUpdate)}
              </div>
            )}
            <button
              onClick={() => { setLoading(true); fetchData(); }}
              className="mt-1 px-3 py-1 rounded text-[10px] font-mono font-bold transition-all hover:brightness-125"
              style={{ background: "rgba(212,168,67,0.12)", color: GOLD, border: "1px solid rgba(212,168,67,0.2)" }}
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* AI Market Narrative — cross-timeframe analysis */}
        {aiNarrative ? (
          <div className="rounded-xl p-5 mt-4 mb-4" style={{ background: "rgba(212,168,67,0.03)", border: "1px solid rgba(212,168,67,0.12)" }}>
            <div className="text-[18px] font-mono font-bold mb-3" style={{ color: "#e2e8f0" }}>
              {aiNarrative.headline}
            </div>
            <div className="text-[11px] font-mono text-white/60 leading-relaxed">
              {aiNarrative.body}
            </div>
          </div>
        ) : narrativeLoading ? (
          <div className="rounded-xl p-4 mt-4 mb-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
            <div className="text-[10px] font-mono text-white/30">
              ⏳ Analysing market conditions across all timeframes...
            </div>
          </div>
        ) : null}

        {/* Timeframe selector */}
        <div className="flex gap-2 mt-3">
          {(["1m", "1h", "1d"] as const).map(tf => {
            const meta = tfMeta[tf];
            const summary = allTfSummary[tf];
            const isActive = regimeTf === tf;
            return (
              <button key={tf} onClick={() => setRegimeTf(tf)}
                className="flex-1 rounded-lg p-3 text-left transition-all"
                style={{
                  background: isActive ? `${meta.color}12` : "rgba(255,255,255,0.02)",
                  border: `1px solid ${isActive ? `${meta.color}40` : "rgba(255,255,255,0.06)"}`,
                }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-mono font-bold" style={{ color: isActive ? meta.color : "rgba(255,255,255,0.5)" }}>
                    {meta.label}
                  </span>
                  {summary && (
                    <span className="text-[9px] font-mono text-white/25">{summary.coinCount} coins</span>
                  )}
                </div>
                {summary?.market ? (
                  <div className="flex gap-3 text-[9px] font-mono text-white/40">
                    <span>🔴 {summary.market.volState?.COMPRESSED || 0} compressed</span>
                    <span>🟢 {summary.market.regime?.TREND || 0} trending</span>
                  </div>
                ) : (
                  <div className="text-[9px] font-mono text-white/20">No data yet</div>
                )}
              </button>
            );
          })}
        </div>

        {/* Cross-timeframe conflict alert */}
        {allTfSummary['1m']?.market && allTfSummary['1d']?.market && (() => {
          const m1m = allTfSummary['1m'].market;
          const m1d = allTfSummary['1d'].market;
          const shortCompressed = (m1m.volState?.COMPRESSED || 0) / (m1m.totalCoins || 1);
          const longCompressed = (m1d.volState?.COMPRESSED || 0) / (m1d.totalCoins || 1);
          if (Math.abs(shortCompressed - longCompressed) > 0.15) {
            return (
              <div className="mt-3 px-3 py-2 rounded-lg text-[10px] font-mono" style={{
                background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.15)", color: "rgba(251,191,36,0.8)",
              }}>
                ⚠ Timeframe divergence: {(shortCompressed * 100).toFixed(0)}% compressed on 1M vs {(longCompressed * 100).toFixed(0)}% on 1D — short-term conditions differ from the longer trend.
              </div>
            );
          }
          return null;
        })()}
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-12">
        {loading ? (
          <div className="text-center py-20">
            <div className="text-[14px] font-mono" style={{ color: GOLD }}>Computing regime features...</div>
            <div className="text-[10px] font-mono text-white/30 mt-2">Analysing 1H bars across all coins</div>
          </div>
        ) : (
          <>
            {/* Market Overview */}
            {market && <MarketMoodCard market={market} filters={filters} />}

            {/* Tabs */}
            <div className="flex items-center gap-1 mt-6 mb-4">
              {(["heatmap", "board"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="px-4 py-1.5 rounded text-[11px] font-mono font-bold transition-all"
                  style={{
                    background: tab === t ? "rgba(212,168,67,0.12)" : "transparent",
                    color: tab === t ? GOLD : "rgba(255,255,255,0.35)",
                    border: `1px solid ${tab === t ? "rgba(212,168,67,0.2)" : "transparent"}`,
                  }}
                >
                  {t === "heatmap" ? `📊 Coin Regimes (${coins.length})` : `🏛 Board Meetings (${meetings.length})`}
                </button>
              ))}
            </div>

            {/* Active Filters Banner */}
            {filters.length > 0 && <div className="mb-4"><ActiveFilters filters={filters} /></div>}

            {/* Content */}
            {tab === "heatmap" && (
              <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <CoinHeatmap coins={coins} sortKey={sortKey} setSortKey={setSortKey} />
              </div>
            )}

            {tab === "board" && (
              <div className="space-y-3">
                {meetings.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-[14px] font-mono text-white/40">🏛 No board meetings yet</div>
                    <div className="text-[10px] font-mono text-white/20 mt-2">
                      The LLM strategy board meets hourly to discuss regime conditions and vote on signal filters
                    </div>
                  </div>
                ) : (
                  meetings.map(m => <BoardMeetingCard key={m.id} meeting={m} />)
                )}
              </div>
            )}

            {/* How it works */}
            <div className="mt-8 rounded-xl p-5" style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.04)" }}>
              <div className="text-[11px] font-mono uppercase tracking-widest mb-3" style={{ color: "rgba(212,168,67,0.6)" }}>
                How This Works
              </div>
              <div className="text-[11px] font-mono text-white/40 leading-relaxed space-y-2">
                <p>
                  <span className="text-white/60 font-bold">Three signal engines run simultaneously</span> — 1M (every minute), 
                  1H (every hour), and 1D (every day). Each detects fractal band breakouts at its own timescale.
                  A coin can be in different regimes at different timeframes — for example, compressed on 1M bars 
                  (short-term squeeze) while trending on 1D bars (larger move in progress).
                </p>
                <p>
                  <span className="text-white/60 font-bold">This page shows 1H regime conditions.</span> These are the most 
                  relevant for the majority of our signals. The regime features (range position, volatility state, Hurst exponent) 
                  are computed from the last 60 hourly candles for each coin.
                </p>
                <p>
                  <span className="text-white/60 font-bold">Board filters are timeframe-aware.</span> A filter tagged "1H" only 
                  blocks 1H signals. A filter tagged "ALL" blocks signals across every timeframe. The 
                  <span style={{ color: GOLD }}> LLM Strategy Board</span> meets every hour to review conditions and vote on 
                  which filters to add or remove. Filters that pass are deployed to the live signal engine automatically.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
