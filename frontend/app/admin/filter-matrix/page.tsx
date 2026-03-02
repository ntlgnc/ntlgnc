"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

const GOLD = "#D4A843";
const BG = "#080a10";
const GREEN = "#22c55e";
const RED = "#ef4444";
const ORANGE = "#f59e0b";
const MUTED = "rgba(255,255,255,0.35)";

const FEATURES = [
  { key: "posInRange", label: "Position in Range", buckets: ["Bottom (<0.25)", "Middle (0.25-0.75)", "Top (>0.75)"] },
  { key: "volState", label: "Vol State", buckets: ["COMPRESSED", "NORMAL", "EXPANDING"] },
  { key: "atrCompression", label: "ATR Compression", buckets: ["Compressed (<0.7)", "Normal (0.7-1.3)", "Expanding (>1.3)"] },
  { key: "hurst", label: "Hurst Exponent", buckets: ["Mean-Rev (<0.45)", "Random (0.45-0.55)", "Trending (>0.55)"] },
  { key: "volRatio5d", label: "1h/1d Vol Ratio", buckets: ["Calm (<0.7)", "Normal (0.7-1.3)", "Heated (>1.3)"] },
  { key: "persistence", label: "Persistence", buckets: ["Choppy (<0.47)", "Mixed (0.47-0.55)", "Clean (>0.55)"] },
  { key: "trend60", label: "60-bar Trend", buckets: ["Down (<-0.3)", "Flat (-0.3-0.3)", "Up (>0.3)"] },
  { key: "posInRange5d", label: "5d Range Position", buckets: ["Bottom (<0.25)", "Middle (0.25-0.75)", "Top (>0.75)"] },
  { key: "trend5d", label: "5-day Trend", buckets: ["Bear (<-0.3)", "Neutral (-0.3-0.3)", "Bull (>0.3)"] },
  { key: "volCluster", label: "Vol Cluster Corr", buckets: ["Unstable (<0.2)", "Moderate (0.2-0.5)", "Persistent (>0.5)"] },
  { key: "volRatio", label: "Vol Ratio 10/60", buckets: ["Quiet (<0.7)", "Normal (0.7-1.3)", "Spiking (>1.3)"] },
  { key: "hour", label: "Hour (UTC)", buckets: ["Asia (0-8)", "Europe (8-15)", "US (15-23)"] },
];

type CellMode = "auto" | "locked_block" | "locked_pass";
type Strategy = { id: string; name: string; barMinutes: number; active: boolean };
type MatrixState = Record<string, Record<string, Record<string, Record<string, CellMode>>>>;
type BoardVotes = Record<string, Record<string, Record<string, Record<string, boolean>>>>;
type ScorecardMap = Record<number, Record<string, Record<number, Record<string, number>>>>;

function srBg(sr: number): string {
  const i = Math.min(Math.abs(sr) / 4, 1);
  if (sr > 0.5) return `rgba(34,197,94,${0.08 + i * 0.25})`;
  if (sr > 0) return `rgba(34,197,94,${0.04 + i * 0.1})`;
  if (sr > -0.5) return `rgba(239,68,68,${0.04 + i * 0.1})`;
  return `rgba(239,68,68,${0.08 + i * 0.25})`;
}

function srColor(sr: number): string {
  if (sr > 2) return "#22c55e";
  if (sr > 0.5) return "#86efac";
  if (sr > 0) return "#a3a3a3";
  if (sr > -1) return "#fca5a5";
  return "#ef4444";
}

// ── Legend Component (horizontal or vertical) ──
function Legend({ horizontal }: { horizontal?: boolean }) {
  const items = [
    {
      label: "Auto",
      desc: "LLM board controls",
      style: { background: "rgba(34,197,94,0.12)", border: "1.5px solid rgba(34,197,94,0.2)", color: GREEN },
      text: "2.1",
    },
    {
      label: "Board Blocked",
      desc: "LLM voted to block",
      style: {
        background: "repeating-linear-gradient(135deg, rgba(245,158,11,0.04), rgba(245,158,11,0.04) 4px, rgba(245,158,11,0.1) 4px, rgba(245,158,11,0.1) 8px)",
        border: "2px solid rgba(245,158,11,0.6)", color: ORANGE,
      },
      text: "🤖",
      labelColor: ORANGE,
    },
    {
      label: "Locked Block",
      desc: "You forced blocked",
      style: {
        background: "repeating-linear-gradient(135deg, rgba(239,68,68,0.06), rgba(239,68,68,0.06) 4px, rgba(239,68,68,0.12) 4px, rgba(239,68,68,0.12) 8px)",
        border: "3px solid rgba(239,68,68,0.8)", color: RED, boxShadow: "0 0 8px rgba(239,68,68,0.25)",
      },
      text: "🔒",
      labelColor: RED,
    },
    {
      label: "Locked Pass",
      desc: "You forced pass",
      style: {
        background: "rgba(34,197,94,0.08)",
        border: "3px solid rgba(34,197,94,0.7)", color: GREEN, boxShadow: "0 0 8px rgba(34,197,94,0.2)",
      },
      text: "🔒",
      labelColor: GREEN,
    },
  ];

  if (horizontal) {
    return (
      <div className="rounded-xl border border-white/[0.06] p-3 mb-5" style={{ background: "rgba(255,255,255,0.015)" }}>
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-[10px] font-mono font-bold" style={{ color: GOLD }}>Key:</span>
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-7 h-5 rounded-sm flex items-center justify-center text-[8px] font-bold flex-shrink-0" style={it.style}>
                {it.text}
              </div>
              <span className="text-[9px] font-mono font-bold" style={{ color: it.labelColor || "rgba(255,255,255,0.7)" }}>{it.label}</span>
            </div>
          ))}
          <span className="text-[8px] font-mono text-white/25 ml-auto">Click to cycle: Auto → Lock Block → Lock Pass</span>
        </div>
      </div>
    );
  }

  // Vertical sidebar
  return (
    <div className="w-52 flex-shrink-0 hidden lg:block">
      <div className="rounded-xl border border-white/[0.06] p-4 sticky top-20" style={{ background: "rgba(255,255,255,0.015)" }}>
        <div className="text-[11px] font-mono font-bold mb-4" style={{ color: GOLD }}>Key</div>
        <div className="space-y-3">
          {items.map((it, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <div className="w-10 h-7 rounded-sm flex items-center justify-center text-[9px] font-bold flex-shrink-0" style={it.style}>
                {it.text}
              </div>
              <div>
                <div className="text-[10px] font-mono font-bold" style={{ color: it.labelColor || "rgba(255,255,255,0.7)" }}>{it.label}</div>
                <div className="text-[8px] font-mono text-white/30">{it.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 pt-4 border-t border-white/[0.06] text-[9px] font-mono text-white/25 leading-relaxed">
          <span className="text-white/50 font-bold">Click</span> any cell to cycle:<br />
          Auto → Lock Block → Lock Pass → Auto
        </div>
        <div className="mt-4 pt-4 border-t border-white/[0.06] text-[9px] font-mono text-white/25 leading-relaxed">
          Cell values show the <span className="text-white/50 font-bold">Sharpe Ratio</span> for that specific direction.
        </div>
      </div>
    </div>
  );
}

// ── Half Grid (one direction) for mobile ──
function HalfGrid({ direction, features, getCellMode, getBoardVote, getSR, getRho, cycle, dirLabel, dirColor }: {
  direction: "long" | "short";
  features: typeof FEATURES;
  getCellMode: (f: string, b: string, d: string) => CellMode;
  getBoardVote: (f: string, b: string, d: string) => boolean;
  getSR: (f: string, bi: number, d: "long" | "short") => number | null;
  getRho: (f: string, bi: number, d: "long" | "short") => { rho: number | null; confidence: string | null } | null;
  cycle: (f: string, b: string, d: string) => void;
  dirLabel: string;
  dirColor: string;
}) {
  const dirUpper = direction === "long" ? "LONG" : "SHORT";

  return (
    <div className="rounded-xl border border-white/[0.06] overflow-hidden" style={{ background: "rgba(255,255,255,0.01)" }}>
      <div className="py-2.5 text-center border-b border-white/[0.08]" style={{ background: "rgba(212,168,67,0.04)" }}>
        <span className="text-[12px] font-mono font-black" style={{ color: dirColor }}>{dirLabel}</span>
      </div>
      {features.map((feat) => (
        <div key={feat.key} className="border-b border-white/[0.03]">
          <div className="px-3 pt-2 pb-1">
            <div className="text-[10px] font-mono font-bold text-white/70">{feat.label}</div>
          </div>
          <div className="grid grid-cols-3 gap-1.5 px-2 pb-2">
            {feat.buckets.map((bucket, bi) => {
              const mode = getCellMode(feat.key, bucket, dirUpper);
              const boardBlocked = getBoardVote(feat.key, bucket, dirUpper);
              const sr = getSR(feat.key, bi, direction);
              const hasSR = sr !== null && sr !== undefined;
              const rhoData = getRho(feat.key, bi, direction);
              const rho = rhoData?.rho;
              const rhoColor = rho === null || rho === undefined ? "rgba(239,68,68,0.5)"
                : rho >= 0.8 ? "rgba(34,197,94,0.7)"
                : rho >= 0.4 ? "rgba(134,239,172,0.6)"
                : rho >= 0 ? "rgba(234,179,8,0.6)"
                : "rgba(239,68,68,0.6)";
              let borderStyle: string, bgStyle: string, textColor: string, shadow = "none";

              if (mode === "locked_block") {
                borderStyle = "3px solid rgba(239,68,68,0.8)";
                bgStyle = "repeating-linear-gradient(135deg, rgba(239,68,68,0.06), rgba(239,68,68,0.06) 4px, rgba(239,68,68,0.12) 4px, rgba(239,68,68,0.12) 8px)";
                textColor = "rgba(239,68,68,0.9)";
                shadow = "0 0 8px rgba(239,68,68,0.25)";
              } else if (mode === "locked_pass") {
                borderStyle = "3px solid rgba(34,197,94,0.7)";
                bgStyle = hasSR ? srBg(sr!) : "rgba(34,197,94,0.08)";
                textColor = hasSR ? srColor(sr!) : GREEN;
                shadow = "0 0 8px rgba(34,197,94,0.2)";
              } else if (boardBlocked) {
                borderStyle = "2px solid rgba(245,158,11,0.6)";
                bgStyle = "repeating-linear-gradient(135deg, rgba(245,158,11,0.04), rgba(245,158,11,0.04) 4px, rgba(245,158,11,0.1) 4px, rgba(245,158,11,0.1) 8px)";
                textColor = "rgba(245,158,11,0.9)";
              } else {
                borderStyle = hasSR ? `1.5px solid ${sr! > 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.15)"}` : "1.5px solid rgba(255,255,255,0.06)";
                bgStyle = hasSR ? srBg(sr!) : "rgba(255,255,255,0.02)";
                textColor = hasSR ? srColor(sr!) : "rgba(255,255,255,0.15)";
              }

              return (
                <button key={bi}
                  onClick={() => cycle(feat.key, bucket, dirUpper)}
                  className="rounded font-mono text-center relative"
                  style={{ height: 54, background: bgStyle, border: borderStyle, boxShadow: shadow, cursor: "pointer" }}>
                  <div className="text-[7px] font-mono text-white/25 absolute top-0.5 left-1 right-1 truncate">{bucket}</div>
                  {hasSR ? (
                    <span className="text-[13px] font-black tabular-nums" style={{ color: textColor }}>{sr!.toFixed(1)}</span>
                  ) : (
                    <span className="text-[10px]" style={{ color: textColor }}>–</span>
                  )}
                  <div className="text-[7px] font-mono font-bold absolute bottom-0.5 left-1 right-1" style={{ color: rhoColor }}>
                    {rho !== null && rho !== undefined ? `ρ${rho.toFixed(1)}` : "no ρ"}
                  </div>
                  {mode !== "auto" && <span className="absolute top-0.5 right-0.5 text-[6px]">🔒</span>}
                  {mode === "auto" && boardBlocked && <span className="absolute top-0.5 right-0.5 text-[6px]">🤖</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Main Page
// ════════════════════════════════════════════════════════════

export default function FilterMatrixPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [activeStratId, setActiveStratId] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<MatrixState>({});
  const [boardVotes, setBoardVotes] = useState<BoardVotes>({});
  const [scorecard, setScorecard] = useState<ScorecardMap>({});
  const [rhoMap, setRhoMap] = useState<Record<number, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [srThreshold, setSrThreshold] = useState<number>(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/filter-matrix?action=load");
      const d = await res.json();
      if (d.strategies) setStrategies(d.strategies);
      if (d.matrix) setMatrix(d.matrix);
      if (d.boardVotes) setBoardVotes(d.boardVotes);
      if (d.scorecard) setScorecard(d.scorecard);
      if (d.rhoMap) setRhoMap(d.rhoMap);
      if (!activeStratId && d.strategies?.length > 0) setActiveStratId(d.strategies[0].id);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [activeStratId]);

  useEffect(() => { load(); }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/filter-matrix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", matrix }),
      });
      const d = await res.json();
      if (d.ok) { setDirty(false); setLastSaved(new Date().toLocaleTimeString()); }
    } catch (e) { console.error(e); }
    setSaving(false);
  }, [matrix]);

  const cycle = (feature: string, bucket: string, direction: string) => {
    setMatrix(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const sid = activeStratId!;
      if (!next[sid]) next[sid] = {};
      if (!next[sid][feature]) next[sid][feature] = {};
      if (!next[sid][feature][bucket]) next[sid][feature][bucket] = {};
      const current: CellMode = next[sid][feature][bucket][direction] || "auto";
      const order: CellMode[] = ["auto", "locked_block", "locked_pass"];
      next[sid][feature][bucket][direction] = order[(order.indexOf(current) + 1) % 3];
      return next;
    });
    setDirty(true);
  };

  const getCellMode = (feature: string, bucket: string, direction: string): CellMode => {
    return matrix[activeStratId!]?.[feature]?.[bucket]?.[direction] || "auto";
  };

  const getBoardVote = (feature: string, bucket: string, direction: string): boolean => {
    return boardVotes[activeStratId!]?.[feature]?.[bucket]?.[direction] ?? false;
  };

  const getSR = (featureKey: string, bucketIndex: number, direction: "long" | "short"): number | null => {
    const strat = strategies.find(s => s.id === activeStratId);
    if (!strat) return null;
    return scorecard[strat.barMinutes]?.[featureKey]?.[bucketIndex]?.[direction] ?? null;
  };

  const getRho = (featureKey: string, bucketIndex: number, direction: "long" | "short"): { rho: number | null; confidence: string | null } | null => {
    const strat = strategies.find(s => s.id === activeStratId);
    if (!strat) return null;
    return rhoMap[strat.barMinutes]?.[featureKey]?.[bucketIndex]?.[direction] ?? null;
  };

  const featurePassesThreshold = (featureKey: string): boolean => {
    if (srThreshold === 0) return true;
    const strat = strategies.find(s => s.id === activeStratId);
    if (!strat) return true;
    const fd = scorecard[strat.barMinutes]?.[featureKey];
    if (!fd) return false;
    for (const bi of Object.keys(fd)) {
      const b = fd[parseInt(bi)];
      if (!b) continue;
      for (const d of ["long", "short"]) {
        if (b[d] !== undefined && Math.abs(b[d]) >= srThreshold) return true;
      }
    }
    return false;
  };

  const countBlocked = (stratId: string) => {
    let count = 0;
    const m = matrix[stratId];
    if (m) {
      for (const feat of Object.values(m)) {
        for (const buck of Object.values(feat as any)) {
          for (const val of Object.values(buck as any)) { if (val === "locked_block") count++; }
        }
      }
    }
    const bv = boardVotes[stratId];
    if (bv) {
      for (const [fk, buckets] of Object.entries(bv)) {
        for (const [bl, dirs] of Object.entries(buckets as any)) {
          for (const [dir, blocked] of Object.entries(dirs as any)) {
            if (blocked && (matrix[stratId]?.[fk]?.[bl]?.[dir] || "auto") === "auto") count++;
          }
        }
      }
    }
    return count;
  };

  const filteredFeatures = FEATURES.filter(f => featurePassesThreshold(f.key));

  // ── Desktop Cell ──
  const Cell = ({ feature, bucketIndex, bucket, direction }: {
    feature: string; bucketIndex: number; bucket: string; direction: "long" | "short";
  }) => {
    const dirUpper = direction === "long" ? "LONG" : "SHORT";
    const mode = getCellMode(feature, bucket, dirUpper);
    const boardBlocked = getBoardVote(feature, bucket, dirUpper);
    const sr = getSR(feature, bucketIndex, direction);
    const hasSR = sr !== null && sr !== undefined;
    const rhoData = getRho(feature, bucketIndex, direction);
    const rhoVal = rhoData?.rho;
    const cellRhoColor = rhoVal === null || rhoVal === undefined ? "rgba(239,68,68,0.5)"
      : rhoVal >= 0.8 ? "rgba(34,197,94,0.7)"
      : rhoVal >= 0.4 ? "rgba(134,239,172,0.6)"
      : rhoVal >= 0 ? "rgba(234,179,8,0.6)"
      : "rgba(239,68,68,0.6)";
    let borderStyle: string, bgStyle: string, textColor: string, shadow = "none";

    if (mode === "locked_block") {
      borderStyle = "3px solid rgba(239,68,68,0.8)";
      bgStyle = "repeating-linear-gradient(135deg, rgba(239,68,68,0.06), rgba(239,68,68,0.06) 4px, rgba(239,68,68,0.12) 4px, rgba(239,68,68,0.12) 8px)";
      textColor = "rgba(239,68,68,0.9)"; shadow = "0 0 8px rgba(239,68,68,0.25)";
    } else if (mode === "locked_pass") {
      borderStyle = "3px solid rgba(34,197,94,0.7)";
      bgStyle = hasSR ? srBg(sr!) : "rgba(34,197,94,0.08)";
      textColor = hasSR ? srColor(sr!) : GREEN; shadow = "0 0 8px rgba(34,197,94,0.2)";
    } else if (boardBlocked) {
      borderStyle = "2px solid rgba(245,158,11,0.6)";
      bgStyle = "repeating-linear-gradient(135deg, rgba(245,158,11,0.04), rgba(245,158,11,0.04) 4px, rgba(245,158,11,0.1) 4px, rgba(245,158,11,0.1) 8px)";
      textColor = "rgba(245,158,11,0.9)";
    } else {
      borderStyle = hasSR ? `1.5px solid ${sr! > 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.15)"}` : "1.5px solid rgba(255,255,255,0.06)";
      bgStyle = hasSR ? srBg(sr!) : "rgba(255,255,255,0.02)";
      textColor = hasSR ? srColor(sr!) : "rgba(255,255,255,0.15)";
    }

    return (
      <button onClick={() => cycle(feature, bucket, dirUpper)}
        className="w-full rounded transition-all duration-150 font-mono relative"
        style={{ height: 54, background: bgStyle, border: borderStyle, cursor: "pointer", boxShadow: shadow }}
        title={`${feature} / ${bucket} / ${dirUpper}\nρ=${rhoVal != null ? rhoVal.toFixed(1) : '?'} | ${mode === "locked_block" ? "🔒 LOCKED BLOCK" : mode === "locked_pass" ? "🔓 LOCKED PASS" : boardBlocked ? "🤖 BOARD BLOCKED" : "AUTO"}`}>
        {hasSR ? (
          <span className="text-[13px] font-black tabular-nums" style={{ color: textColor }}>{sr!.toFixed(1)}</span>
        ) : (
          <span className="text-[10px]" style={{ color: textColor }}>–</span>
        )}
        <div className="text-[7px] font-mono font-bold absolute bottom-0.5 left-1 right-1" style={{ color: cellRhoColor }}>
          {rhoVal !== null && rhoVal !== undefined ? `ρ${rhoVal.toFixed(1)}` : "no ρ"}
        </div>
        {mode !== "auto" && <span className="absolute top-0.5 right-1 text-[7px]" style={{ color: mode === "locked_block" ? RED : GREEN }}>🔒</span>}
        {mode === "auto" && boardBlocked && <span className="absolute top-0.5 right-1 text-[7px]">🤖</span>}
      </button>
    );
  };

  return (
    <div className="min-h-screen" style={{ background: BG, color: "#e2e8f0" }}>
      <nav className="fixed top-0 w-full z-50 border-b border-white/[0.06]" style={{ background: "rgba(8,10,16,0.95)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/" className="text-[15px] font-mono font-black tracking-tight" style={{ color: GOLD }}>
            NTLGNC <span className="text-white/40 font-normal text-[11px]">SIGNAL LAB</span>
          </Link>
          <div className="flex gap-4 sm:gap-6 text-[11px] font-mono">
            <Link href="/" className="text-white/40 hover:text-white/70 transition hidden sm:block">Home</Link>
            <Link href="/signals" className="text-white/40 hover:text-white/70 transition">Signals</Link>
            <Link href="/regime/scorecard" className="text-white/40 hover:text-white/70 transition hidden sm:block">Scorecard</Link>
            <Link href="/admin" className="text-white/40 hover:text-white/70 transition">Admin</Link>
            <span className="font-bold" style={{ color: GOLD }}>Filters</span>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-3 sm:px-6 pt-18 sm:pt-20 pb-12">
        <AdminNav />
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
          <div>
            <h1 className="text-lg sm:text-xl font-mono font-black tracking-tight" style={{ color: GOLD }}>Filter Matrix</h1>
            <p className="text-[10px] sm:text-[11px] font-mono text-white/40 mt-1">
              Click cells to cycle: Auto → Lock Block → Lock Pass
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastSaved && <span className="text-[9px] font-mono text-white/25">Saved {lastSaved}</span>}
            <button onClick={save} disabled={!dirty || saving}
              className="px-3 sm:px-4 py-2 rounded text-[10px] sm:text-[11px] font-mono font-bold transition-all"
              style={{
                background: dirty ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${dirty ? "rgba(34,197,94,0.4)" : "rgba(255,255,255,0.08)"}`,
                color: dirty ? GREEN : "rgba(255,255,255,0.25)",
                cursor: dirty ? "pointer" : "default", opacity: saving ? 0.5 : 1,
              }}>
              {saving ? "Saving..." : dirty ? "💾 Save" : "No Changes"}
            </button>
          </div>
        </div>

        {/* Controls row */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex gap-2">
            {strategies.map(s => {
              const isActive = s.id === activeStratId;
              const blocked = countBlocked(s.id);
              const tfShort = s.barMinutes === 1 ? "1M" : s.barMinutes === 60 ? "1H" : s.barMinutes === 1440 ? "1D" : `${s.barMinutes}m`;
              return (
                <button key={s.id} onClick={() => setActiveStratId(s.id)}
                  className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-lg font-mono transition-all"
                  style={{
                    background: isActive ? "rgba(212,168,67,0.12)" : "rgba(255,255,255,0.02)",
                    border: `1px solid ${isActive ? "rgba(212,168,67,0.35)" : "rgba(255,255,255,0.06)"}`,
                    color: isActive ? GOLD : "rgba(255,255,255,0.4)",
                  }}>
                  <span className="font-black text-[14px] sm:text-[16px]">{tfShort}</span>
                  {blocked > 0 && (
                    <span className="ml-2 px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-bold"
                      style={{ background: "rgba(239,68,68,0.15)", color: RED }}>{blocked}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[8px] sm:text-[9px] font-mono text-white/30 mr-1 sm:mr-2">|SR| ≥</span>
            <div className="flex gap-px rounded overflow-hidden border border-white/[0.08]">
              {[{ val: 0, label: "All" }, { val: 0.5, label: "0.5" }, { val: 1, label: "1.0" }, { val: 2, label: "2.0" }].map(opt => (
                <button key={opt.val} onClick={() => setSrThreshold(opt.val)}
                  className="px-2 sm:px-3 py-1 sm:py-1.5 text-[9px] sm:text-[10px] font-mono font-bold transition-all"
                  style={{
                    background: srThreshold === opt.val ? "rgba(212,168,67,0.15)" : "transparent",
                    color: srThreshold === opt.val ? GOLD : "rgba(255,255,255,0.4)",
                  }}>{opt.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Legend: horizontal on mobile/tablet, hidden on desktop (sidebar shows instead) */}
        <div className="lg:hidden">
          <Legend horizontal />
        </div>

        {loading ? (
          <div className="text-center py-12 text-[11px] font-mono text-white/30">Loading...</div>
        ) : !activeStratId ? (
          <div className="text-center py-12 text-[11px] font-mono text-white/30">No strategies found</div>
        ) : (
          <>
            {/* ═══ DESKTOP: side-by-side 6-col grid + sidebar ═══ */}
            <div className="hidden md:flex gap-5">
              <div className="flex-1 rounded-xl border border-white/[0.06] overflow-hidden" style={{ background: "rgba(255,255,255,0.01)" }}>
                <div className="grid items-end border-b border-white/[0.08]"
                  style={{ gridTemplateColumns: "160px repeat(3, 1fr) 6px repeat(3, 1fr)", background: "rgba(212,168,67,0.04)" }}>
                  <div className="py-3 px-3 text-[11px] font-mono font-bold text-white/50">Feature</div>
                  <div className="col-span-3 py-3 text-center"><span className="text-[12px] font-mono font-black" style={{ color: GREEN }}>▲ LONGS</span></div>
                  <div />
                  <div className="col-span-3 py-3 text-center"><span className="text-[12px] font-mono font-black" style={{ color: RED }}>▼ SHORTS</span></div>
                </div>
                {filteredFeatures.length === 0 ? (
                  <div className="py-8 text-center text-[11px] font-mono text-white/25">No features match |SR| ≥ {srThreshold}</div>
                ) : filteredFeatures.map(feat => (
                  <div key={feat.key} className="grid items-center border-b border-white/[0.03] hover:bg-white/[0.01] transition-colors"
                    style={{ gridTemplateColumns: "160px repeat(3, 1fr) 6px repeat(3, 1fr)" }}>
                    <div className="py-2 px-3"><div className="text-[11px] font-mono font-bold text-white/80">{feat.label}</div></div>
                    {feat.buckets.map((bucket, bi) => (
                      <div key={`l${bi}`} className="px-1.5 py-1.5 text-center">
                        <div className="text-[9px] font-mono text-white/30 mb-1 truncate">{bucket}</div>
                        <Cell feature={feat.key} bucketIndex={bi} bucket={bucket} direction="long" />
                      </div>
                    ))}
                    <div className="h-full" style={{ background: "rgba(255,255,255,0.04)" }} />
                    {feat.buckets.map((bucket, bi) => (
                      <div key={`s${bi}`} className="px-1.5 py-1.5 text-center">
                        <div className="text-[9px] font-mono text-white/30 mb-1 truncate">{bucket}</div>
                        <Cell feature={feat.key} bucketIndex={bi} bucket={bucket} direction="short" />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <Legend />
            </div>

            {/* ═══ MOBILE: two stacked grids (Longs then Shorts) ═══ */}
            <div className="md:hidden space-y-4">
              <HalfGrid direction="long" features={filteredFeatures}
                getCellMode={getCellMode} getBoardVote={getBoardVote} getSR={getSR} getRho={getRho}
                cycle={cycle} dirLabel="▲ LONGS" dirColor={GREEN} />
              <HalfGrid direction="short" features={filteredFeatures}
                getCellMode={getCellMode} getBoardVote={getBoardVote} getSR={getSR} getRho={getRho}
                cycle={cycle} dirLabel="▼ SHORTS" dirColor={RED} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
