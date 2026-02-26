"use client";

import { useState, useMemo } from "react";

const GOLD = "#D4A843";

/* ═══════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════ */
type Signal = {
  type: "LONG" | "SHORT";
  entryIdx: number;
  entryPrice: number;
  exitIdx: number;
  exitActualIdx?: number;
  exitPrice: number;
  holdDuration: number;
  maxCycle: number;
  maxOrder?: number;
  strength: number;
  time: string;
  returnPct: number;
  won: boolean;
};

type PairedTrade = {
  tier: 1 | 2;
  legA: Signal & { coin: string };
  legB: Signal & { coin: string };
  pairBar: number;         // bar at which both are active
  pairDuration: number;    // bars both held
  legA_return: number;     // return for leg A over pair duration
  legB_return: number;     // return for leg B over pair duration
  pairReturn: number;      // legA + legB (hedged return)
  gapBars: number;         // 0 for T1, 1-5 for T2
};

type Props = {
  oosSignals: Record<string, any[]>;
  oosResults: any[];
  oosBars?: Record<string, any[]>;
  barMinutes: number;
  splitPct: number;
  cycleMin: number;
  cycleMax: number;
  winnerCombo: any;
};

/* ═══════════════════════════════════════════════════════════════
   Pairing Engine
   ═══════════════════════════════════════════════════════════════ */
function buildPairs(
  oosSignals: Record<string, any[]>,
  maxGapBars: number = 5,
  oosBars?: Record<string, any[]>,
): { pairs: PairedTrade[]; unmatched: (Signal & { coin: string })[] } {
  // Flatten all signals with coin label and sort by entry time
  const allSigs: (Signal & { coin: string })[] = [];
  for (const [symbol, sigs] of Object.entries(oosSignals)) {
    for (const s of sigs) allSigs.push({ ...s, coin: symbol });
  }
  allSigs.sort((a, b) => a.entryIdx - b.entryIdx);

  const pairs: PairedTrade[] = [];
  const used = new Set<number>(); // indices into allSigs that are already paired
  const unmatched: (Signal & { coin: string })[] = [];

  // Build index: for each entryIdx, list of signal indices at that bar
  const barIndex = new Map<number, number[]>();
  for (let i = 0; i < allSigs.length; i++) {
    const bar = allSigs[i].entryIdx;
    if (!barIndex.has(bar)) barIndex.set(bar, []);
    barIndex.get(bar)!.push(i);
  }

  for (let ai = 0; ai < allSigs.length; ai++) {
    if (used.has(ai)) continue;
    const A = allSigs[ai];

    let bestBi = -1;
    let bestScore = -Infinity;

    // Only search signals entered at bars [A.entryIdx - maxGapBars, A.entryIdx]
    for (let bar = A.entryIdx - maxGapBars; bar <= A.entryIdx; bar++) {
      const candidates = barIndex.get(bar);
      if (!candidates) continue;
      for (const bi of candidates) {
        if (bi === ai || used.has(bi)) continue;
        const B = allSigs[bi];

        if (B.type === A.type) continue;
        if (B.coin === A.coin) continue;

        const gap = A.entryIdx - B.entryIdx;
        const pairBar = A.entryIdx;

        const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
        const bRemaining = bExit - pairBar;
        const minRequired = Math.max(1, A.holdDuration - maxGapBars);
        if (bRemaining < minRequired) continue;

        const aRemaining = A.holdDuration;
        const tier = gap === 0 ? 1 : 2;
        const pairDuration = Math.min(aRemaining, bRemaining);
        const score = (tier === 1 ? 100000 : 0) + pairDuration * 100 - gap * 10 + B.strength;

        if (score > bestScore) {
          bestScore = score;
          bestBi = bi;
        }
      }
    }

    if (bestBi >= 0) {
      const B = allSigs[bestBi];
      const gap = A.entryIdx - B.entryIdx;
      const pairBar = A.entryIdx;
      const bExit = B.exitActualIdx ?? B.exitIdx ?? (B.entryIdx + B.holdDuration);
      const bRemaining = bExit - pairBar;
      const pairDuration = Math.min(A.holdDuration, bRemaining);
      const tier = gap === 0 ? 1 : 2;
      const pairExitBar = pairBar + pairDuration;

      // Compute returns: use actual bar prices if available, otherwise scale linearly
      let legA_return: number;
      let legB_return: number;

      const barsA = oosBars?.[A.coin];
      const barsB = oosBars?.[B.coin];

      if (barsA && pairBar < barsA.length && pairExitBar < barsA.length) {
        // Use actual prices for Leg A
        const aEntry = barsA[pairBar].open;
        const aExit = barsA[pairExitBar].open;
        legA_return = A.type === "LONG"
          ? (aExit / aEntry - 1) * 100
          : (aEntry / aExit - 1) * 100;
      } else {
        legA_return = A.returnPct * (pairDuration / Math.max(A.holdDuration, 1));
      }

      if (barsB && pairBar < barsB.length && pairExitBar < barsB.length) {
        // Use actual prices for Leg B
        const bEntry = barsB[pairBar].open;
        const bExit = barsB[pairExitBar].open;
        legB_return = B.type === "LONG"
          ? (bExit / bEntry - 1) * 100
          : (bEntry / bExit - 1) * 100;
      } else {
        legB_return = B.returnPct * (pairDuration / Math.max(B.holdDuration, 1));
      }

      const pairReturn = legA_return + legB_return;

      pairs.push({
        tier: tier as 1 | 2,
        legA: A, legB: B,
        pairBar, pairDuration,
        legA_return: +legA_return.toFixed(3),
        legB_return: +legB_return.toFixed(3),
        pairReturn: +pairReturn.toFixed(3),
        gapBars: gap,
      });

      used.add(ai);
      used.add(bestBi);
    } else {
      unmatched.push(A);
    }
  }

  return { pairs, unmatched };
}

/* ═══════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════ */
export default function HedgedStrategy({ oosSignals, oosResults, oosBars, barMinutes, splitPct, cycleMin, cycleMax, winnerCombo }: Props) {
  const [maxGap, setMaxGap] = useState(5);
  const [showPairs, setShowPairs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Run pairing engine
  const { pairs, unmatched } = useMemo(() => buildPairs(oosSignals, maxGap, oosBars), [oosSignals, maxGap, oosBars]);

  const t1 = pairs.filter(p => p.tier === 1);
  const t2 = pairs.filter(p => p.tier === 2);

  // Hedged metrics
  const pairRets = pairs.map(p => p.pairReturn);
  const meanRet = pairRets.length > 0 ? pairRets.reduce((s, r) => s + r, 0) / pairRets.length : 0;
  const stdRet = pairRets.length > 1 ? Math.sqrt(pairRets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / pairRets.length) : 0;
  const winRate = pairRets.length > 0 ? pairRets.filter(r => r > 0).length / pairRets.length * 100 : 0;
  const totalRet = pairRets.reduce((s, r) => s + r, 0);
  const avgHold = pairs.length > 0 ? pairs.reduce((s, p) => s + p.pairDuration, 0) / pairs.length : 0;
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(525600 / Math.max(1, avgHold * barMinutes)) : 0;
  const grossWin = pairRets.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(pairRets.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Unhedged metrics for comparison (from oosResults)
  const unhedgedSharpe = oosResults.length > 0 ? oosResults.reduce((s: number, r: any) => s + r.sharpe, 0) / oosResults.length : 0;
  const unhedgedWR = oosResults.length > 0 ? oosResults.reduce((s: number, r: any) => s + r.winRate, 0) / oosResults.length : 0;

  // Tier comparison
  const t1Rets = t1.map(p => p.pairReturn);
  const t2Rets = t2.map(p => p.pairReturn);
  const t1Mean = t1Rets.length > 0 ? t1Rets.reduce((s, r) => s + r, 0) / t1Rets.length : 0;
  const t2Mean = t2Rets.length > 0 ? t2Rets.reduce((s, r) => s + r, 0) / t2Rets.length : 0;
  const t1WR = t1Rets.length > 0 ? t1Rets.filter(r => r > 0).length / t1Rets.length * 100 : 0;
  const t2WR = t2Rets.length > 0 ? t2Rets.filter(r => r > 0).length / t2Rets.length * 100 : 0;

  // Cumulative pair returns
  const cumData: { idx: number; cum: number }[] = [];
  let cum = 0;
  pairs.sort((a, b) => a.pairBar - b.pairBar).forEach((p, i) => {
    cum += p.pairReturn;
    cumData.push({ idx: i, cum: +cum.toFixed(3) });
  });

  // Coin pair frequency
  const pairFreq: Record<string, number> = {};
  for (const p of pairs) {
    const key = [p.legA.coin, p.legB.coin].sort().join("/");
    pairFreq[key] = (pairFreq[key] || 0) + 1;
  }
  const topPairs = Object.entries(pairFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // SVG helper
  const svgLine = (data: number[], h: number) => {
    if (data.length < 2) return "";
    const minV = Math.min(...data, 0);
    const maxV = Math.max(...data, 0.001);
    const range = maxV - minV || 1;
    return data.map((v, i) => {
      const x = (i / (data.length - 1)) * 800;
      const y = (h - 10) - ((v - minV) / range) * (h - 20);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
  };

  // Save hedged strategy
  const saveStrategy = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const nm = `Hedged ×${winnerCombo?.minStr||1} gap≤${maxGap} SR${sharpe.toFixed(1)}`;
      const res = await fetch("/api/fracmap-strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "saveStrategy",
          name: nm,
          type: "hedged",
          barMinutes,
          minStr: winnerCombo?.minStr || 1,
          minCyc: winnerCombo?.minCyc || 55,
          spike: winnerCombo?.spike ?? true,
          nearMiss: winnerCombo?.nearMiss ?? true,
          holdDiv: winnerCombo?.holdDiv || 4,
          priceExt: true,
          isSharpe: sharpe,
          oosSharpe: sharpe,
          winRate, profitFactor: pf,
          consistency: pairs.length > 0 ? (pairs.filter(p => p.pairReturn > 0).length / pairs.length * 100) : 0,
          totalTrades: pairs.length,
          splitPct, cycleMin, cycleMax,
        }),
      });
      const d = await res.json();
      setSaveMsg(d.strategy ? `✅ Saved: ${nm}` : `❌ ${d.error || "Failed"}`);
    } catch (e: any) {
      setSaveMsg(`❌ ${e.message}`);
    }
    setSaving(false);
  };

  if (pairs.length === 0 && Object.keys(oosSignals).length === 0) return null;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[12px] font-mono font-bold" style={{ color: GOLD }}>⚖️ HEDGED STRATEGY</span>
        <span className="text-[9px] font-mono text-[var(--text-dim)]">
          Pairs opposite signals for market-neutral exposure · {pairs.length} pairs from {Object.keys(oosSignals).length * (Object.values(oosSignals)[0]?.length || 0)} raw signals
        </span>
      </div>

      {/* Gap control */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[9px] font-mono text-[var(--text-dim)]">Max entry gap:</span>
        {[0, 1, 2, 3, 5].map(g => (
          <button key={g} onClick={() => setMaxGap(g)}
            className="px-2 py-0.5 rounded text-[9px] font-mono font-bold border transition-all"
            style={{
              background: maxGap === g ? "rgba(212,168,67,0.1)" : "transparent",
              borderColor: maxGap === g ? GOLD + "40" : "var(--border)",
              color: maxGap === g ? GOLD : "var(--text-dim)",
            }}>
            {g === 0 ? "Same bar" : `±${g} bars`}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={saveStrategy} disabled={saving || pairs.length === 0}
          className="px-3 py-1.5 rounded text-[9px] font-mono font-bold border transition-all"
          style={{ background: "rgba(212,168,67,0.1)", borderColor: GOLD + "40", color: GOLD, opacity: pairs.length === 0 ? 0.3 : 1 }}>
          {saving ? "..." : "💾 SAVE HEDGED STRATEGY"}
        </button>
        {saveMsg && <span className="text-[9px] font-mono" style={{ color: saveMsg.startsWith("✅") ? "#22c55e" : "#ef4444" }}>{saveMsg}</span>}
      </div>

      {/* KPI comparison */}
      <div className="grid grid-cols-3 md:grid-cols-7 gap-2 mb-4">
        {[
          { l: "Pairs", v: `${pairs.length}`, sub: `${unmatched.length} unmatched`, c: "var(--text)" },
          { l: "Hedged SR", v: sharpe.toFixed(2), sub: `vs ${unhedgedSharpe.toFixed(2)} unhedged`, c: sharpe > unhedgedSharpe ? "#22c55e" : "#ef4444" },
          { l: "Win Rate", v: winRate.toFixed(1) + "%", sub: `vs ${unhedgedWR.toFixed(1)}% unhedged`, c: winRate > 55 ? "#22c55e" : winRate > 50 ? "#eab308" : "#ef4444" },
          { l: "Total Ret", v: (totalRet > 0 ? "+" : "") + totalRet.toFixed(2) + "%", sub: `${pairs.length} trades`, c: totalRet > 0 ? "#22c55e" : "#ef4444" },
          { l: "PF", v: pf > 10 ? ">10" : pf.toFixed(2), sub: "profit factor", c: pf > 1.2 ? "#22c55e" : pf > 1 ? "#eab308" : "#ef4444" },
          { l: "Avg Hold", v: avgHold.toFixed(0) + " bars", sub: `≈${(avgHold * barMinutes / 60).toFixed(1)}h`, c: "var(--text)" },
          { l: "Tier Mix", v: `${t1.length}T1 / ${t2.length}T2`, sub: `${(t1.length / Math.max(pairs.length, 1) * 100).toFixed(0)}% exact`, c: "#06b6d4" },
        ].map(k => (
          <div key={k.l} className="p-2 rounded border border-[var(--border)]">
            <div className="text-[8px] font-mono text-[var(--text-dim)]">{k.l}</div>
            <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: k.c }}>{k.v}</div>
            <div className="text-[7px] font-mono text-[var(--text-dim)]">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Tier breakdown */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="p-3 rounded border" style={{ borderColor: "#22c55e30", background: "#22c55e05" }}>
          <div className="text-[10px] font-mono font-bold" style={{ color: "#22c55e" }}>TIER 1 — Same Bar ({t1.length} pairs)</div>
          <div className="text-[9px] font-mono text-[var(--text-dim)] mt-1">
            Avg return: <strong style={{ color: t1Mean > 0 ? "#22c55e" : "#ef4444" }}>{t1Mean > 0 ? "+" : ""}{t1Mean.toFixed(3)}%</strong> · 
            Win rate: <strong>{t1WR.toFixed(0)}%</strong> · 
            Total: {t1Rets.reduce((s, r) => s + r, 0).toFixed(2)}%
          </div>
        </div>
        <div className="p-3 rounded border" style={{ borderColor: "#06b6d430", background: "#06b6d405" }}>
          <div className="text-[10px] font-mono font-bold" style={{ color: "#06b6d4" }}>TIER 2 — Within {maxGap} Bars ({t2.length} pairs)</div>
          <div className="text-[9px] font-mono text-[var(--text-dim)] mt-1">
            Avg return: <strong style={{ color: t2Mean > 0 ? "#22c55e" : "#ef4444" }}>{t2Mean > 0 ? "+" : ""}{t2Mean.toFixed(3)}%</strong> · 
            Win rate: <strong>{t2WR.toFixed(0)}%</strong> · 
            Total: {t2Rets.reduce((s, r) => s + r, 0).toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Cumulative returns chart */}
      {cumData.length > 2 && (
        <div className="mb-4">
          <div className="text-[9px] font-mono text-[var(--text-dim)] mb-2">HEDGED EQUITY CURVE — {pairs.length} paired trades</div>
          <div className="w-full h-[140px]">
            <svg viewBox="0 0 800 140" className="w-full h-full">
              <line x1="0" y1="70" x2="800" y2="70" stroke="#475569" strokeWidth="0.5" strokeDasharray="4 4" />
              <path d={svgLine(cumData.map(d => d.cum), 140)} fill="none" stroke={GOLD} strokeWidth="2" />
              <text x="4" y="12" fill={GOLD} fontSize="9" fontFamily="monospace">
                {Math.max(...cumData.map(d => d.cum)).toFixed(2)}%
              </text>
              <text x="4" y="136" fill="#ef4444" fontSize="9" fontFamily="monospace">
                {Math.min(...cumData.map(d => d.cum), 0).toFixed(2)}%
              </text>
            </svg>
          </div>
        </div>
      )}

      {/* Top coin pairs */}
      {topPairs.length > 0 && (
        <div className="mb-4">
          <div className="text-[9px] font-mono text-[var(--text-dim)] mb-2">MOST FREQUENT COIN PAIRS</div>
          <div className="flex flex-wrap gap-1">
            {topPairs.map(([pair, count]) => {
              const pairTrades = pairs.filter(p => [p.legA.coin, p.legB.coin].sort().join("/") === pair);
              const pairAvg = pairTrades.reduce((s, p) => s + p.pairReturn, 0) / pairTrades.length;
              return (
                <span key={pair} className="px-2 py-0.5 rounded text-[8px] font-mono border"
                  style={{ color: pairAvg > 0 ? "#22c55e" : "#ef4444", borderColor: "var(--border)" }}>
                  {pair.replace(/USDT/g, "")} ×{count} ({pairAvg > 0 ? "+" : ""}{pairAvg.toFixed(3)}%)
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Pair detail table (collapsible) */}
      <details>
        <summary className="text-[9px] font-mono text-[var(--text-dim)] cursor-pointer hover:text-[var(--text)] mb-2">
          Show all {pairs.length} paired trades
        </summary>
        <div className="max-h-[400px] overflow-y-auto">
          <table className="w-full text-[8px] font-mono border-collapse">
            <thead className="sticky top-0 bg-[var(--bg-card)]">
              <tr className="border-b border-[var(--border)]">
                {["T","Leg A","Dir","Leg B","Dir","Gap","Hold","A Ret","B Ret","Pair Ret"].map(h => (
                  <th key={h} className="py-1 px-1 text-left text-[var(--text-dim)] font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pairs.sort((a, b) => a.pairBar - b.pairBar).map((p, i) => (
                <tr key={i} className="border-b border-[var(--border)] border-opacity-20">
                  <td className="py-1 px-1">
                    <span className="px-1 rounded text-[7px]" style={{
                      background: p.tier === 1 ? "#22c55e15" : "#06b6d415",
                      color: p.tier === 1 ? "#22c55e" : "#06b6d4",
                    }}>T{p.tier}</span>
                  </td>
                  <td className="py-1 px-1 font-semibold">{p.legA.coin.replace("USDT","")}</td>
                  <td className="py-1 px-1" style={{ color: p.legA.type === "LONG" ? "#22c55e" : "#ef4444" }}>{p.legA.type[0]}</td>
                  <td className="py-1 px-1 font-semibold">{p.legB.coin.replace("USDT","")}</td>
                  <td className="py-1 px-1" style={{ color: p.legB.type === "LONG" ? "#22c55e" : "#ef4444" }}>{p.legB.type[0]}</td>
                  <td className="py-1 px-1 tabular-nums text-[var(--text-dim)]">{p.gapBars}</td>
                  <td className="py-1 px-1 tabular-nums">{p.pairDuration}</td>
                  <td className="py-1 px-1 tabular-nums" style={{ color: p.legA_return > 0 ? "#22c55e" : "#ef4444" }}>{p.legA_return > 0 ? "+" : ""}{p.legA_return.toFixed(3)}%</td>
                  <td className="py-1 px-1 tabular-nums" style={{ color: p.legB_return > 0 ? "#22c55e" : "#ef4444" }}>{p.legB_return > 0 ? "+" : ""}{p.legB_return.toFixed(3)}%</td>
                  <td className="py-1 px-1 tabular-nums font-bold" style={{ color: p.pairReturn > 0 ? "#22c55e" : "#ef4444" }}>{p.pairReturn > 0 ? "+" : ""}{p.pairReturn.toFixed(3)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* Interpretation */}
      <div className="mt-3 pt-3 border-t border-[var(--border)] text-[9px] font-mono text-[var(--text-dim)] leading-relaxed">
        <strong style={{ color: GOLD }}>How it works:</strong> Each raw signal is paired with an <strong>opposite-direction</strong> signal on a different coin, entered within ±{maxGap} bar{maxGap !== 1 ? "s" : ""}.
        Both legs close at the shorter duration. The hedged return = Leg A + Leg B. This cancels out market beta — you profit from <strong>relative</strong> moves between coins, not directional bets.
        <strong> Tier 1</strong> = exact same bar (best). <strong>Tier 2</strong> = within {maxGap} bars (good).
        Unmatched signals ({unmatched.length}) are excluded — they have unhedged exposure.
        {sharpe > unhedgedSharpe * 0.7 && <> The hedged Sharpe ({sharpe.toFixed(2)}) {sharpe > unhedgedSharpe ? "exceeds" : "is within range of"} the unhedged Sharpe ({unhedgedSharpe.toFixed(2)}), suggesting the edge comes from <strong>relative pricing</strong>, not market direction — a more robust signal.</>}
      </div>
    </div>
  );
}
