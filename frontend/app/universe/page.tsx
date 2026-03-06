"use client";

import { useState, useEffect, useMemo } from "react";

const GOLD = "#D4A843";
const CYAN = "#06b6d4";
const PURPLE = "#a78bfa";
const GREEN = "#22c55e";
const RED = "#ef4444";

type TfData = {
  barMinutes: number;
  is: { sharpe: number; winRate: number; totalRet: number; trades: number };
  oos: { sharpe: number; winRate: number; totalRet: number; trades: number; profitFactor: number };
  avgAbsRho: number | null;
  perfectRho: number;
  totalFeatures: number;
  winnerParams?: any;
  computedAt?: string;
  comparison?: any[];
};

type CoinSummary = {
  symbol: string;
  excluded: boolean;
  timeframes: Record<string, TfData>;
};

const srColor = (v: number) => v > 2 ? GREEN : v > 0.5 ? "#86efac" : v > 0 ? "#a3a3a3" : v > -1 ? "#fca5a5" : RED;
const wrColor = (v: number) => v >= 55 ? GREEN : v >= 45 ? "#eab308" : RED;
const retColor = (v: number) => v >= 0 ? GREEN : RED;
const rhoColor = (v: number | null) => {
  if (v === null) return "#444";
  return v >= 0.8 ? GREEN : v >= 0.4 ? "#86efac" : v >= 0 ? "#eab308" : v >= -0.4 ? "#fca5a5" : RED;
};
const confIcon = (rho: number | null) => {
  if (rho === null) return { icon: "❓", label: "n/a", color: "#666" };
  if (rho >= 0.8) return { icon: "✅", label: "high", color: GREEN };
  if (rho >= 0.4) return { icon: "🟡", label: "moderate", color: "#86efac" };
  if (rho >= 0) return { icon: "⚠️", label: "low", color: "#eab308" };
  if (rho >= -0.4) return { icon: "🔴", label: "unstable", color: "#fca5a5" };
  return { icon: "⛔", label: "inverted", color: RED };
};
const recommendation = (rho: number | null, oosSpread: number) => {
  if (rho === null) return { text: "Insufficient data", color: "#666", rank: 5 };
  if (rho >= 0.8 && oosSpread > 2) return { text: "USE — strong filter", color: GREEN, rank: 0 };
  if (rho >= 0.8) return { text: "USE — stable", color: GREEN, rank: 1 };
  if (rho >= 0.4 && oosSpread > 3) return { text: "USE WITH CAUTION", color: "#eab308", rank: 2 };
  if (rho >= 0.4) return { text: "MONITOR", color: "#eab308", rank: 3 };
  if (rho >= 0) return { text: "WEAK", color: "#fca5a5", rank: 4 };
  return { text: "RETIRE — inverted", color: RED, rank: 6 };
};
const srBg = (sr: number) => {
  const intensity = Math.min(Math.abs(sr) / 5, 1) * 0.25;
  return sr > 0 ? `rgba(34,197,94,${intensity})` : `rgba(239,68,68,${intensity})`;
};
const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const tfColor = (tf: string) => tf === "1M" ? GREEN : tf === "1H" ? "#3b82f6" : PURPLE;

/* ═══════════════════════════════════════════════════════════════
   COIN DETAIL
   ═══════════════════════════════════════════════════════════════ */

function CoinDetail({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTf, setActiveTf] = useState("1M");
  const [regimeSort, setRegimeSort] = useState<"action" | "spread" | "rho">("action");
  const [direction, setDirection] = useState<"ALL" | "LONG" | "SHORT">("ALL");

  useEffect(() => {
    fetch(`/api/universe?action=coin&symbol=${encodeURIComponent(symbol)}`)
      .then(r => r.json())
      .then(d => {
        setData(d);
        const tfs = Object.keys(d.timeframes || {});
        if (tfs.length > 0 && !d.timeframes["1M"]) setActiveTf(tfs[0]);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [symbol]);

  const tfs = Object.keys(data?.timeframes || {});
  const tf: TfData | undefined = data?.timeframes?.[activeTf];
  const compAll: any[] = (tf as any)?.comparison || [];
  const compLong: any[] = (tf as any)?.comparisonLong || [];
  const compShort: any[] = (tf as any)?.comparisonShort || [];
  const comparison = direction === "LONG" ? compLong : direction === "SHORT" ? compShort : compAll;

  const sorted = useMemo(() => {
    const arr = [...comparison];
    if (regimeSort === "action") {
      arr.sort((a: any, b: any) => {
        const ra = recommendation(a.rho, a.oosSpread || 0).rank;
        const rb = recommendation(b.rho, b.oosSpread || 0).rank;
        if (ra !== rb) return ra - rb;
        return (b.oosSpread || 0) - (a.oosSpread || 0);
      });
    } else if (regimeSort === "spread") {
      arr.sort((a: any, b: any) => (b.oosSpread || 0) - (a.oosSpread || 0));
    } else {
      arr.sort((a: any, b: any) => (b.rho ?? -2) - (a.rho ?? -2));
    }
    return arr;
  }, [comparison, regimeSort]);

  if (loading) return <div className="text-[11px] font-mono text-white/30 py-16 text-center">Loading {symbol}...</div>;
  if (!data || !data.timeframes) return <div className="text-[11px] font-mono text-red-400 py-8 text-center">No backtest data for {symbol}</div>;

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <button onClick={onBack} className="text-[11px] font-mono text-white/40 hover:text-white transition-colors px-2 py-1 rounded" style={{ border: "1px solid rgba(255,255,255,0.1)" }}>← Back</button>
        <h2 className="text-xl font-mono font-black" style={{ color: GOLD }}>{symbol.replace("USDT", "")}</h2>
        <span className="text-[11px] font-mono text-white/30">{symbol}</span>
        {data.excluded && (
          <span className="text-[9px] font-mono px-2 py-0.5 rounded" style={{ background: "rgba(239,68,68,0.12)", color: RED }}>
            EXCLUDED {data.excludeReason ? `— ${data.excludeReason}` : ""}
          </span>
        )}
      </div>

      {/* Performance Cards */}
      <div className={`grid gap-4 mb-6`} style={{ gridTemplateColumns: `repeat(${tfs.length}, 1fr)` }}>
        {tfs.map(tfKey => {
          const d = data.timeframes[tfKey];
          const isActive = tfKey === activeTf;
          const wp = d.winnerParams;
          return (
            <button key={tfKey} onClick={() => setActiveTf(tfKey)}
              className="rounded-xl p-4 text-left transition-all"
              style={{
                background: isActive ? `${tfColor(tfKey)}08` : "rgba(255,255,255,0.015)",
                border: `2px solid ${isActive ? tfColor(tfKey) + "50" : "rgba(255,255,255,0.04)"}`,
              }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[12px] font-mono font-bold" style={{ color: tfColor(tfKey) }}>{tfKey}</span>
                {wp && <span className="text-[8px] font-mono text-white/25">×{wp.minStr} C≥{wp.minCyc} {wp.spike ? "⚡" : ""}{wp.nearMiss ? "±" : ""} ÷{wp.holdDiv}</span>}
              </div>
              <div className="space-y-1">
                <div className="flex items-center text-[8px] font-mono text-white/30 gap-4">
                  <span className="w-14"></span><span className="w-12 text-right" style={{ color: "#4ade80" }}>IS</span><span className="w-12 text-right" style={{ color: "#f97316" }}>OOS</span>
                </div>
                {[
                  { label: "Sharpe", is: d.is.sharpe, oos: d.oos.sharpe, fmt: (v: number) => v.toFixed(2), cf: srColor },
                  { label: "Win Rate", is: d.is.winRate, oos: d.oos.winRate, fmt: (v: number) => v.toFixed(1) + "%", cf: wrColor },
                  { label: "Return", is: d.is.totalRet, oos: d.oos.totalRet, fmt: (v: number) => pct(v), cf: retColor },
                  { label: "Trades", is: d.is.trades, oos: d.oos.trades, fmt: (v: number) => String(v), cf: () => "white" },
                ].map(row => (
                  <div key={row.label} className="flex items-center gap-4 text-[10px] font-mono tabular-nums">
                    <span className="w-14 text-white/30">{row.label}</span>
                    <span className="w-12 text-right" style={{ color: "#4ade80" }}>{row.fmt(row.is)}</span>
                    <span className="w-12 text-right font-bold" style={{ color: row.cf(row.oos) }}>{row.fmt(row.oos)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-2 flex items-center gap-4" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                <span className="text-[8px] font-mono text-white/25">Avg|ρ|</span>
                <span className="text-[11px] font-mono font-bold" style={{ color: rhoColor(d.avgAbsRho) }}>
                  {d.avgAbsRho?.toFixed(2) ?? "—"}
                </span>
                <span className="text-[8px] font-mono text-white/25">Perfect ρ</span>
                <span className="text-[11px] font-mono font-bold" style={{ color: d.perfectRho > 0 ? GREEN : "#666" }}>
                  {d.perfectRho}/{d.totalFeatures}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Regime Table */}
      {tf && sorted.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: `${CYAN}04`, border: `2px solid ${CYAN}30` }}>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-[12px] font-mono font-bold" style={{ color: CYAN }}>
              🧬 Regime Analysis — {activeTf} — {symbol.replace("USDT", "")}
            </span>
            <div className="flex-1" />
            {/* Direction toggle */}
            <div className="flex gap-px rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
              {([
                { k: "ALL" as const, label: "All", icon: "" },
                { k: "LONG" as const, label: "▲ Longs", icon: "" },
                { k: "SHORT" as const, label: "▼ Shorts", icon: "" },
              ]).map(d => (
                <button key={d.k} onClick={() => setDirection(d.k)}
                  className="px-3 py-1 text-[9px] font-mono transition-all"
                  style={{
                    background: direction === d.k ? (d.k === "LONG" ? `${GREEN}18` : d.k === "SHORT" ? `${RED}18` : `${CYAN}18`) : "transparent",
                    color: direction === d.k ? (d.k === "LONG" ? GREEN : d.k === "SHORT" ? RED : CYAN) : "rgba(255,255,255,0.35)",
                  }}>
                  {d.label}
                </button>
              ))}
            </div>
            {/* Sort controls */}
            <div className="flex gap-px rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
              {([
                { k: "action" as const, label: "Best First" },
                { k: "spread" as const, label: "Spread" },
                { k: "rho" as const, label: "ρ Value" },
              ]).map(s => (
                <button key={s.k} onClick={() => setRegimeSort(s.k)}
                  className="px-2.5 py-1 text-[9px] font-mono transition-all"
                  style={{ background: regimeSort === s.k ? `${CYAN}18` : "transparent", color: regimeSort === s.k ? CYAN : "rgba(255,255,255,0.35)" }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Summary badges */}
          <div className="flex gap-3 mb-4 flex-wrap">
            {[
              { label: "✅ Stable (ρ≥0.8)", count: comparison.filter((c: any) => c.rho !== null && c.rho >= 0.8).length, color: GREEN },
              { label: "🟡 Moderate", count: comparison.filter((c: any) => c.rho !== null && c.rho >= 0.4 && c.rho < 0.8).length, color: "#86efac" },
              { label: "⚠️ Low", count: comparison.filter((c: any) => c.rho !== null && c.rho >= 0 && c.rho < 0.4).length, color: "#eab308" },
              { label: "🔴 Unstable", count: comparison.filter((c: any) => c.rho !== null && c.rho < 0).length, color: RED },
              { label: "❓ N/A", count: comparison.filter((c: any) => c.rho === null).length, color: "#666" },
            ].filter(b => b.count > 0).map(b => (
              <span key={b.label} className="text-[9px] font-mono px-2.5 py-1 rounded"
                style={{ color: b.color, background: b.color + "12", border: `1px solid ${b.color}25` }}>
                {b.label}: {b.count}
              </span>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono border-collapse">
              <thead>
                <tr style={{ borderBottom: "2px solid rgba(255,255,255,0.08)" }}>
                  <th className="py-2.5 px-3 text-left text-white/50 font-semibold" style={{ width: 140 }}>Feature</th>
                  <th className="py-2.5 px-2 text-center text-white/50 font-semibold" style={{ width: 55 }}>Spread</th>
                  <th className="py-2.5 px-2 text-center font-semibold" style={{ width: 70, color: PURPLE }}>ρ IS→OOS</th>
                  <th className="py-2.5 px-2 text-center text-white/30 font-semibold text-[8px]" style={{ width: 30 }}>n</th>
                  {[1, 2, 3].map(i => (
                    <th key={i} colSpan={2} className="py-2.5 px-2 text-center font-semibold" style={{ color: CYAN, borderLeft: "1px solid rgba(255,255,255,0.06)" }}>
                      Bucket {i}
                    </th>
                  ))}
                  <th className="py-2.5 px-2 text-center text-white/50 font-semibold" style={{ borderLeft: "1px solid rgba(255,255,255,0.06)", width: 130 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((feat: any) => {
                  const conf = confIcon(feat.rho);
                  const allBucketTrades = (feat.oosBuckets || []).map((b: any) => b?.trades ?? 0);
                  const minBucket = allBucketTrades.length > 0 ? Math.min(...allBucketTrades) : 0;
                  const rec = recommendation(feat.rho, feat.oosSpread || 0);
                  return (
                    <tr key={feat.key} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }} className="hover:bg-white/[0.015]">
                      <td className="py-2.5 px-3 text-white/70 font-semibold">{feat.key}</td>
                      <td className="py-2.5 px-2 text-center font-bold tabular-nums"
                        style={{ color: (feat.oosSpread || 0) > 3 ? CYAN : (feat.oosSpread || 0) > 1.5 ? GREEN : "rgba(255,255,255,0.2)" }}>
                        {(feat.oosSpread || 0).toFixed(1)}
                      </td>
                      <td className="py-2.5 px-2 text-center font-bold tabular-nums" style={{ color: rhoColor(feat.rho) }}>
                        {feat.rho !== null ? feat.rho.toFixed(2) : "n/a"} <span className="text-[8px]">{conf.icon}</span>
                      </td>
                      <td className="py-2.5 px-2 text-center text-[8px] tabular-nums" style={{
                        color: minBucket >= 15 ? GREEN : minBucket >= 5 ? '#eab308' : '#666'
                      }}>
                        {minBucket}
                      </td>
                      {[0, 1, 2].map(bi => {
                        const isB = feat.isBuckets?.[bi];
                        const oosB = feat.oosBuckets?.[bi];
                        if (!isB && !oosB) return <td key={bi} colSpan={2} style={{ borderLeft: "1px solid rgba(255,255,255,0.04)" }}></td>;
                        const isSr = isB?.sharpe ?? 0;
                        const oosSr = oosB?.sharpe ?? 0;
                        const oosN = oosB?.trades ?? 0;
                        return (
                          <td key={bi} colSpan={2} className="py-2.5 px-2 text-center" style={{ borderLeft: "1px solid rgba(255,255,255,0.04)" }}>
                            <div className="text-[7px] text-white/20 mb-1">{(oosB || isB)?.label}</div>
                            <div className="flex items-center justify-center gap-1.5">
                              <span className="tabular-nums px-1 rounded" style={{ color: "#4ade80", background: isSr !== 0 ? srBg(isSr) : "transparent" }}>
                                {(isB?.trades ?? 0) > 2 ? isSr.toFixed(1) : "–"}
                              </span>
                              <span className="text-white/15">/</span>
                              <span className="tabular-nums font-bold px-1 rounded" style={{ color: "#f97316", background: oosSr !== 0 ? srBg(oosSr) : "transparent" }}>
                                {oosN > 2 ? oosSr.toFixed(1) : "–"}
                              </span>
                              <span className="text-[7px] text-white/15">{oosN}t</span>
                            </div>
                          </td>
                        );
                      })}
                      <td className="py-2.5 px-2 text-center text-[9px] font-semibold" style={{ borderLeft: "1px solid rgba(255,255,255,0.04)", color: rec.color }}>
                        {rec.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 pt-3 text-[9px] font-mono text-white/30 leading-relaxed" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <strong style={{ color: CYAN }}>Spread</strong> = max − min OOS bucket Sharpe.
            <strong style={{ color: PURPLE }}> ρ IS→OOS</strong> = Spearman correlation. 1.0 = pattern held perfectly.
            <strong style={{ color: "#4ade80" }}> Green</strong> = IS, <strong style={{ color: "#f97316" }}>Orange</strong> = OOS.
          </div>
        </div>
      )}

      {tf && sorted.length === 0 && (
        <div className="text-[10px] font-mono text-white/20 py-8 text-center rounded-xl" style={{ border: "1px solid rgba(255,255,255,0.04)" }}>
          No regime data for {activeTf}. Run: <code>node backend/universe-backtest.cjs</code>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LIST PAGE
   ═══════════════════════════════════════════════════════════════ */

type SortKey = "symbol" | "oosSharpe" | "isSharpe" | "oosWR" | "oosTrades" | "oosRet" | "avgRho";

export default function UniversePage() {
  const [coins, setCoins] = useState<CoinSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "excluded">("all");
  const [tfFilter, setTfFilter] = useState<"1M" | "1H" | "1D">("1M");
  const [sortKey, setSortKey] = useState<SortKey>("oosSharpe");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    fetch("/api/universe?action=list")
      .then(r => r.json())
      .then(d => setCoins(d.coins || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const getTf = (c: CoinSummary) => c.timeframes[tfFilter];

  const getSortValue = (c: CoinSummary, key: SortKey): number | string => {
    const tf = getTf(c);
    if (key === "symbol") return c.symbol;
    if (key === "oosSharpe") return tf?.oos?.sharpe ?? -999;
    if (key === "isSharpe") return tf?.is?.sharpe ?? -999;
    if (key === "oosWR") return tf?.oos?.winRate ?? -999;
    if (key === "oosTrades") return tf?.oos?.trades ?? -999;
    if (key === "oosRet") return tf?.oos?.totalRet ?? -999;
    if (key === "avgRho") return tf?.avgAbsRho ?? -999;
    return 0;
  };

  const filtered = useMemo(() => {
    let list = coins;
    if (statusFilter === "active") list = list.filter(c => !c.excluded);
    else if (statusFilter === "excluded") list = list.filter(c => c.excluded);
    if (search) list = list.filter(c => c.symbol.toLowerCase().includes(search.toLowerCase()));
    // Only show coins that have data for the selected timeframe
    list = list.filter(c => c.timeframes[tfFilter]);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = getSortValue(a, sortKey);
      const bv = getSortValue(b, sortKey);
      if (typeof av === "string") return dir * (av as string).localeCompare(bv as string);
      return dir * ((av as number) - (bv as number));
    });
  }, [coins, statusFilter, search, sortKey, sortDir, tfFilter]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "symbol" ? "asc" : "desc"); }
  };

  if (selectedCoin) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-10">
        <CoinDetail symbol={selectedCoin} onBack={() => setSelectedCoin(null)} />
      </div>
    );
  }

  const ColH = ({ k, label }: { k: SortKey; label: string }) => (
    <th className="py-3 px-3 text-center cursor-pointer select-none font-semibold transition-colors hover:text-white/70 text-[10px] whitespace-nowrap"
      style={{ color: sortKey === k ? GOLD : "rgba(255,255,255,0.4)" }}
      onClick={() => handleSort(k)}>
      {label} {sortKey === k ? (sortDir === "desc" ? "↓" : "↑") : ""}
    </th>
  );

  // Count coins per TF for badges
  const tfCounts = { "1M": 0, "1H": 0, "1D": 0 };
  coins.forEach(c => { for (const k of ["1M","1H","1D"] as const) if (c.timeframes[k]) tfCounts[k]++; });

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-mono font-black mb-1" style={{ color: GOLD }}>Universe</h1>
        <p className="text-[11px] font-mono text-white/35">
          Full IS/OOS backtest per coin. Click any row for regime breakdown.
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Timeframe toggle */}
        <div className="flex gap-px rounded-lg overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
          {(["1M", "1H", "1D"] as const).map(tf => (
            <button key={tf} onClick={() => setTfFilter(tf)}
              className="px-4 py-1.5 text-[11px] font-mono font-bold transition-all"
              style={{
                background: tfFilter === tf ? `${tfColor(tf)}15` : "transparent",
                color: tfFilter === tf ? tfColor(tf) : "rgba(255,255,255,0.35)",
              }}>
              {tf} <span className="text-[8px] font-normal opacity-60">({tfCounts[tf]})</span>
            </button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex gap-px rounded-lg overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
          {(["all", "active", "excluded"] as const).map(f => (
            <button key={f} onClick={() => setStatusFilter(f)}
              className="px-3 py-1.5 text-[10px] font-mono transition-all"
              style={{ background: statusFilter === f ? `${GOLD}15` : "transparent", color: statusFilter === f ? GOLD : "rgba(255,255,255,0.35)" }}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <input type="text" placeholder="Search coin..." value={search} onChange={e => setSearch(e.target.value)}
          className="bg-transparent text-[11px] font-mono text-white/60 px-3 py-1.5 rounded-lg outline-none w-44"
          style={{ border: "1px solid rgba(255,255,255,0.08)" }} />
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-white/30">{filtered.length} coins</span>
      </div>

      {loading ? (
        <div className="text-[11px] font-mono text-white/30 py-16 text-center">Loading...</div>
      ) : coins.length === 0 ? (
        <div className="text-[11px] font-mono text-white/20 py-16 text-center">
          No backtest data. Run: <code className="text-white/40">node backend/universe-backtest.cjs</code>
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.025)", borderBottom: "2px solid rgba(255,255,255,0.08)" }}>
                <th className="w-10 px-3 py-3 text-left text-white/30 font-semibold">#</th>
                <th className="py-3 px-3 text-left cursor-pointer font-semibold text-[10px] hover:text-white/70"
                  style={{ color: sortKey === "symbol" ? GOLD : "rgba(255,255,255,0.4)" }}
                  onClick={() => handleSort("symbol")}>
                  Coin {sortKey === "symbol" ? (sortDir === "desc" ? "↓" : "↑") : ""}
                </th>
                <ColH k="oosSharpe" label={`${tfFilter} OOS Sharpe`} />
                <ColH k="isSharpe" label="IS Sharpe" />
                <ColH k="oosWR" label="Win Rate" />
                <ColH k="oosTrades" label="Trades" />
                <ColH k="oosRet" label="OOS Return" />
                <ColH k="avgRho" label="Avg|ρ|" />
                <th className="py-3 px-3 text-center text-white/30 font-semibold text-[9px]">Perfect ρ</th>
                <th className="py-3 px-3 text-center text-white/30 font-semibold text-[9px]">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => {
                const tf = getTf(c);
                if (!tf) return null;
                return (
                  <tr key={c.symbol}
                    className="transition-all cursor-pointer hover:bg-white/[0.03]"
                    onClick={() => setSelectedCoin(c.symbol)}
                    style={{
                      background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.008)",
                      borderBottom: "1px solid rgba(255,255,255,0.025)",
                      opacity: c.excluded ? 0.35 : 1,
                    }}>
                    <td className="px-3 py-2.5 text-white/20">{i + 1}</td>
                    <td className="py-2.5 px-3 font-bold text-white/90">{c.symbol.replace("USDT", "")}</td>
                    <td className="py-2.5 px-3 text-center tabular-nums font-bold text-[12px]" style={{ color: srColor(tf.oos.sharpe) }}>
                      {tf.oos.sharpe.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 text-center tabular-nums" style={{ color: "#4ade80", opacity: 0.5 }}>
                      {tf.is.sharpe.toFixed(1)}
                    </td>
                    <td className="py-2.5 px-3 text-center tabular-nums" style={{ color: wrColor(tf.oos.winRate) }}>
                      {tf.oos.winRate.toFixed(0)}%
                    </td>
                    <td className="py-2.5 px-3 text-center tabular-nums text-white/40">
                      {tf.oos.trades}
                    </td>
                    <td className="py-2.5 px-3 text-center tabular-nums" style={{ color: retColor(tf.oos.totalRet) }}>
                      {pct(tf.oos.totalRet)}
                    </td>
                    <td className="py-2.5 px-3 text-center tabular-nums font-bold" style={{ color: rhoColor(tf.avgAbsRho) }}>
                      {tf.avgAbsRho?.toFixed(2) ?? "—"}
                    </td>
                    <td className="py-2.5 px-3 text-center tabular-nums" style={{ color: tf.perfectRho > 0 ? GREEN : "#444" }}>
                      {tf.perfectRho}/{tf.totalFeatures}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      {c.excluded ? (
                        <span className="text-[8px] px-1.5 py-0.5 rounded" style={{ background: "rgba(239,68,68,0.1)", color: RED }}>EXCL</span>
                      ) : (
                        <span className="text-[8px] px-1.5 py-0.5 rounded" style={{ background: "rgba(34,197,94,0.06)", color: GREEN }}>LIVE</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
