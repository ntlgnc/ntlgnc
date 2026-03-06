"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { adminFetch } from "@/lib/admin-fetch";

/* ═══════════════════════════════════════════════════════════════
   FRACMAP TOPOGRAPHY MODEL
   Full-spectrum golden-ratio exhaustion indicator
   
   Computes φ^n bands for orders 1–6 across cycles 10–200,
   drawing all bands simultaneously to create a topographic
   landscape that price navigates through.
   
   Generates ensemble signals: only 1 long or 1 short at a time.
   ═══════════════════════════════════════════════════════════════ */

const GOLD = "#D4A843";
const GOLD_DIM = "rgba(212,168,67,0.15)";

// ── Color palette for different orders ──
const ORDER_COLORS: Record<number, { base: string }> = {
  1: { base: "rgba(212,168,67," },
  2: { base: "rgba(230,140,50," },
  3: { base: "rgba(220,100,60," },
  4: { base: "rgba(200,80,80," },
  5: { base: "rgba(160,80,180," },
  6: { base: "rgba(80,120,200," },
};
const ORDER_HEX: Record<number, string> = {
  1: "#D4A843", 2: "#E68C32", 3: "#DC643C",
  4: "#C85050", 5: "#A050B4", 6: "#5078C8",
};

export default function FracmapTopography() {
  const [bars, setBars] = useState<any[]>([]);
  const [allCoins, setAllCoins] = useState(["ETHUSDT","BTCUSDT","XRPUSDT","SOLUSDT","BNBUSDT","ADAUSDT","DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT","SHIBUSDT","UNIUSDT","TRXUSDT","XLMUSDT","BCHUSDT","HBARUSDT","ZECUSDT","SUIUSDT","TONUSDT"]);
  const [cycleRange, setCycleRange] = useState([10, 200]);
  const [draftCycleRange, setDraftCycleRange] = useState<[any, any]>([10, 200]);
  const [cycleStep, setCycleStep] = useState(10);
  const [enabledOrders, setEnabledOrders] = useState([1, 2, 3, 4, 5, 6]);
  const [minStrength, setMinStrength] = useState(3);
  const [minCycle, setMinCycle] = useState(0);
  const [spikeFilter, setSpikeFilter] = useState(true);
  const [nearMiss, setNearMiss] = useState(false);
  const [holdDivisor, setHoldDivisor] = useState(2); // hold = maxCycle / holdDivisor
  const [showStrategy, setShowStrategy] = useState(false);
  const [showCandles, setShowCandles] = useState(true);
  const [showSignals, setShowSignals] = useState(true);
  const [yAxisMode, setYAxisMode] = useState<"tight" | "padded" | "free">("padded");
  const [shadingMode, setShadingMode] = useState<"valley" | "channel">("channel");
  const [bandOpacity, setBandOpacity] = useState(0.08);
  const [viewStart, setViewStart] = useState(0);
  const [viewBars, setViewBars] = useState(300);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pastedData, setPastedData] = useState("");
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [showEquityCurve, setShowEquityCurve] = useState(false);
  const [apiSymbol, setApiSymbol] = useState("ETHUSDT");
  const [apiBarMin, setApiBarMin] = useState(15);
  const [apiLoading, setApiLoading] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  // Computed results from server-side API
  const [allBands, setAllBands] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [maxForward, setMaxForward] = useState(0);
  const [computing, setComputing] = useState(false);

  // Load coins + initial data on mount
  useEffect(() => {
    loadFromApi();
    fetch("/api/coins").then(r => r.json()).then(d => { if (d.coins?.length > 0) setAllCoins(d.coins); }).catch(() => {});
  }, []);

  // Compute bands + signals via server API whenever params change
  const computeRef = useRef(0);
  useEffect(() => {
    if (bars.length === 0) { setAllBands([]); setSignals([]); setMetrics(null); setMaxForward(0); return; }
    const seq = ++computeRef.current;
    setComputing(true);
    adminFetch("/api/fracmap/compute", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "topography", bars, barMinutes: apiBarMin,
        cycleMin: cycleRange[0], cycleMax: cycleRange[1], cycleStep,
        enabledOrders, minStr: minStrength, minCyc: minCycle,
        spike: spikeFilter, nearMiss, holdDiv: holdDivisor,
      }),
    }).then(r => r.json()).then(data => {
      if (seq !== computeRef.current) return; // stale
      setAllBands(data.bands || []);
      setSignals(data.signals || []);
      setMetrics(data.metrics || null);
      setMaxForward(data.maxForward || 0);
    }).catch(err => { console.error("Topography compute error:", err); })
    .finally(() => { if (seq === computeRef.current) setComputing(false); });
  }, [bars, cycleRange, cycleStep, enabledOrders, minStrength, minCycle, spikeFilter, nearMiss, holdDivisor, apiBarMin]);

  // Load from API (fetches candles which triggers compute via useEffect above)
  const loadFromApi = useCallback(async () => {
    setApiLoading(true);
    try {
      const res = await adminFetch(`/api/fracmap/compute`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "topography", symbol: apiSymbol, barMinutes: apiBarMin, limit: 2000,
          cycleMin: cycleRange[0], cycleMax: cycleRange[1], cycleStep,
          enabledOrders, minStr: minStrength, minCyc: minCycle,
          spike: spikeFilter, nearMiss, holdDiv: holdDivisor,
        }),
      });
      const data = await res.json();
      if (data.bars?.length > 50) {
        setBars(data.bars);
        setAllBands(data.bands || []);
        setSignals(data.signals || []);
        setMetrics(data.metrics || null);
        setMaxForward(data.maxForward || 0);
        setViewStart(0);
      }
    } catch (err) {
      console.error("Failed to load from API:", err);
    }
    setApiLoading(false);
  }, [apiSymbol, apiBarMin, cycleRange, cycleStep, enabledOrders, minStrength, minCycle, spikeFilter, nearMiss, holdDivisor]);

  const loadPastedData = useCallback(() => {
    try {
      const lines = pastedData.trim().split("\n");
      const parsed: any[] = [];
      for (const line of lines) {
        const parts = line.split(",").map(s => s.trim());
        if (parts.length < 5) continue;
        const [time, open, high, low, close, vol] = parts;
        const o = parseFloat(open), h = parseFloat(high), l = parseFloat(low), c = parseFloat(close);
        if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
        parsed.push({ time: time || new Date().toISOString(), open: o, high: h, low: l, close: c, volume: parseFloat(vol) || 0 });
      }
      if (parsed.length > 50) {
        setBars(parsed);
        setViewStart(0);
        setShowPasteModal(false);
        setPastedData("");
      }
    } catch (e) { console.error(e); }
  }, [pastedData, viewBars]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setViewStart(s => Math.max(0, s - 20));
      if (e.key === "ArrowRight") setViewStart(s => Math.min(bars.length, s + 20));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bars.length, viewBars]);

  const vEnd = Math.min(viewStart + viewBars, bars.length);
  const vBars = bars.slice(viewStart, vEnd);

  // Show projection funnel when we can see past the last candle
  // projBars = how many extra slots to add for the forward projection
  const barsShortfall = viewBars - vBars.length; // how many empty candle slots at the right
  const projBars = barsShortfall > 0 ? Math.min(maxForward, barsShortfall + maxForward) : 0;
  const totalSlots = vBars.length + projBars;

  const W = 1100, H = 480;
  const PAD = { top: 25, right: 65, bottom: 35, left: 70 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slotW = plotW / (totalSlots || 1);
  const candleW = slotW;
  const bodyW = Math.max(1, candleW * 0.55);

  // Y-axis modes:
  // "tight"  = price only, 2% padding (max detail)
  // "padded" = price only, 10% padding (default)
  // "free"   = includes band extremes (see full topography)
  let minP = Infinity, maxP = -Infinity;
  vBars.forEach((b: any) => {
    if (b.high > maxP) maxP = b.high;
    if (b.low < minP) minP = b.low;
  });
  if (yAxisMode === "tight") {
    const range = maxP - minP || 1;
    maxP = maxP + range * 0.02;
    minP = minP - range * 0.02;
  } else if (yAxisMode === "padded") {
    maxP = maxP * 1.1;
    minP = minP * 0.9;
  } else {
    // free: include band extremes (including projection zone)
    const scanEnd = vEnd + projBars;
    allBands.forEach((band: any) => {
      for (let i = viewStart; i < scanEnd; i++) {
        if (band.lower[i] !== null && band.lower[i] < minP) minP = band.lower[i];
        if (band.upper[i] !== null && band.upper[i] > maxP) maxP = band.upper[i];
      }
    });
  }

  const rangeP = maxP - minP || 1;
  const toX = (i: number) => PAD.left + (i + 0.5) * slotW;
  const toY = (p: number) => PAD.top + plotH - ((p - minP) / rangeP) * plotH;

  const yTicks: number[] = [];
  const step = rangeP / 6;
  for (let i = 0; i <= 6; i++) yTicks.push(minP + step * i);

  const xLabels: { idx: number; label: string }[] = [];
  const labelInt = Math.max(1, Math.floor(viewBars / 10));
  for (let i = 0; i < vBars.length; i += labelInt) {
    const d = new Date(vBars[i].time);
    xLabels.push({ idx: i, label: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` });
  }

  // Sort bands outside-in: highest order & largest cycle first (widest bands),
  // so the shading builds inward creating a clear valley effect
  const sortedBands = useMemo(() => {
    return [...allBands].sort((a, b) => {
      // Primary: higher order first (wider bands)
      if (b.order !== a.order) return b.order - a.order;
      // Secondary: larger cycle first
      return b.cycle - a.cycle;
    });
  }, [allBands]);

  const bandPathsByOrder = useMemo(() => {
    const groups: Record<number, any[]> = {};
    for (const band of allBands) {
      if (!groups[band.order]) groups[band.order] = [];
      groups[band.order].push(band);
    }
    // Sort each group: largest cycle first (widest rendered first)
    for (const key in groups) {
      groups[key].sort((a: any, b: any) => b.cycle - a.cycle);
    }
    return groups;
  }, [allBands]);

  const visibleSignals = signals.filter((s: any) => s.entryIdx >= viewStart && s.entryIdx < vEnd);

  const handleMM = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const idx = Math.floor((mx - PAD.left) / candleW);
    setHoverIdx(idx >= 0 && idx < vBars.length ? idx : null);
  };

  const hBar = hoverIdx != null ? vBars[hoverIdx] : null;

  const toggleOrder = (o: number) => {
    setEnabledOrders(prev =>
      prev.includes(o) ? prev.filter(x => x !== o) : [...prev, o].sort()
    );
  };

  return (
    <div>
      {/* Header info */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl mt-0.5" style={{ color: GOLD }}>φ</div>
          <div>
            <div className="text-sm font-semibold mb-1">Fracmap Topography — Full Spectrum Model</div>
            <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              Computes golden-ratio exhaustion bands across <strong>all orders (1–6)</strong> and <strong>all cycles ({cycleRange[0]}–{cycleRange[1]})</strong> simultaneously,
              creating a topographic landscape of support/resistance. Ensemble signals fire when price interacts with band layers.
              Only <strong>1 position</strong> (long or short) at a time.
              Expand <strong style={{ color: "#22c55e" }}>Trade Strategy</strong> below to tune entry filters, spike detection, and hold duration.
            </div>
          </div>
        </div>
        {metrics && (
          <div className="flex items-center gap-6 mt-3 pt-3 border-t border-[var(--border)]">
            <MetricPill label="BANDS" value={String(metrics.bandCount)} color="var(--text-muted)" />
            <MetricPill label="TRADES" value={String(metrics.trades)} color="var(--text-muted)" />
            <MetricPill label="WIN%" value={`${metrics.winRate}%`}
              color={metrics.winRate > 55 ? "var(--up)" : metrics.winRate > 45 ? "#eab308" : "var(--down)"} />
            <MetricPill label="AVG RET" value={`${metrics.avgRet > 0 ? "+" : ""}${metrics.avgRet}%`}
              color={metrics.avgRet > 0 ? "var(--up)" : "var(--down)"} />
            <MetricPill label="TOTAL RET" value={`${metrics.totalRet > 0 ? "+" : ""}${metrics.totalRet}%`}
              color={metrics.totalRet > 0 ? "var(--up)" : "var(--down)"} />
            <MetricPill label="SHARPE" value={metrics.sharpe.toFixed(2)}
              color={metrics.sharpe > 0.2 ? "var(--up)" : metrics.sharpe > 0 ? "#eab308" : "var(--down)"} />
            <MetricPill label="MAX DD" value={`-${metrics.maxDD}%`} color="var(--down)" />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Orders */}
          <div>
            <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">ORDERS</div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5, 6].map(o => (
                <button key={o} onClick={() => toggleOrder(o)}
                  className="w-7 h-7 rounded text-[11px] font-mono font-semibold border transition-all"
                  style={{
                    background: enabledOrders.includes(o) ? ORDER_HEX[o] + "18" : "transparent",
                    borderColor: enabledOrders.includes(o) ? ORDER_HEX[o] + "60" : "var(--border)",
                    color: enabledOrders.includes(o) ? ORDER_HEX[o] : "var(--text-dim)",
                  }}>{o}</button>
              ))}
            </div>
          </div>

          {/* Cycle Range — staged with GO button */}
          <div>
            <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">CYCLE RANGE</div>
            <div className="flex items-center gap-1">
              <button onClick={() => { const v = Math.max(5, cycleRange[0] - 5); setCycleRange([v, cycleRange[1]]); setDraftCycleRange([v, cycleRange[1]]); }}
                className="w-6 h-7 rounded text-[12px] font-mono font-bold border transition-all flex items-center justify-center"
                style={{ background: GOLD_DIM, borderColor: GOLD + "40", color: GOLD }}>−</button>
              <input type="text" inputMode="numeric" value={draftCycleRange[0]}
                onChange={e => { const v = e.target.value.replace(/\D/g, ""); setDraftCycleRange([v === "" ? "" as any : +v, draftCycleRange[1]]); }}
                className="w-12 h-7 px-1 rounded text-[11px] font-mono font-semibold border text-center tabular-nums"
                style={{ background: "var(--bg-card2)", borderColor: draftCycleRange[0] !== cycleRange[0] ? GOLD + "80" : "var(--border)", color: draftCycleRange[0] !== cycleRange[0] ? GOLD : "var(--text)" }} />
              <button onClick={() => { const v = Math.min(cycleRange[0] + 5, cycleRange[1] - 5); setCycleRange([v, cycleRange[1]]); setDraftCycleRange([v, cycleRange[1]]); }}
                className="w-6 h-7 rounded text-[12px] font-mono font-bold border transition-all flex items-center justify-center"
                style={{ background: GOLD_DIM, borderColor: GOLD + "40", color: GOLD }}>+</button>

              <span className="text-[var(--text-dim)] text-[10px] mx-0.5">→</span>

              <button onClick={() => { const v = Math.max(cycleRange[0] + 5, cycleRange[1] - 5); setCycleRange([cycleRange[0], v]); setDraftCycleRange([cycleRange[0], v]); }}
                className="w-6 h-7 rounded text-[12px] font-mono font-bold border transition-all flex items-center justify-center"
                style={{ background: GOLD_DIM, borderColor: GOLD + "40", color: GOLD }}>−</button>
              <input type="text" inputMode="numeric" value={draftCycleRange[1]}
                onChange={e => { const v = e.target.value.replace(/\D/g, ""); setDraftCycleRange([draftCycleRange[0], v === "" ? "" as any : +v]); }}
                className="w-12 h-7 px-1 rounded text-[11px] font-mono font-semibold border text-center tabular-nums"
                style={{ background: "var(--bg-card2)", borderColor: draftCycleRange[1] !== cycleRange[1] ? GOLD + "80" : "var(--border)", color: draftCycleRange[1] !== cycleRange[1] ? GOLD : "var(--text)" }} />
              <button onClick={() => { const v = Math.min(500, cycleRange[1] + 5); setCycleRange([cycleRange[0], v]); setDraftCycleRange([cycleRange[0], v]); }}
                className="w-6 h-7 rounded text-[12px] font-mono font-bold border transition-all flex items-center justify-center"
                style={{ background: GOLD_DIM, borderColor: GOLD + "40", color: GOLD }}>+</button>

              {(draftCycleRange[0] !== cycleRange[0] || draftCycleRange[1] !== cycleRange[1]) && (
                <button onClick={() => {
                    const a = Math.max(5, +draftCycleRange[0] || 10);
                    const b = Math.max(a + 5, +draftCycleRange[1] || 200);
                    setCycleRange([a, b]);
                    setDraftCycleRange([a, b]);
                  }}
                  className="h-7 px-3 rounded text-[10px] font-mono font-bold border transition-all ml-1 animate-pulse"
                  style={{ background: GOLD, borderColor: GOLD, color: "#000" }}>GO</button>
              )}
            </div>
          </div>

          {/* Step */}
          <div>
            <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">STEP</div>
            <div className="flex gap-1">
              {[1, 2, 5, 10, 20].map(s => (
                <button key={s} onClick={() => setCycleStep(s)}
                  className="px-2 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                  style={{
                    background: cycleStep === s ? GOLD_DIM : "transparent",
                    borderColor: cycleStep === s ? GOLD + "40" : "var(--border)",
                    color: cycleStep === s ? GOLD : "var(--text-dim)",
                  }}>{s}</button>
              ))}
            </div>
          </div>

          {/* Band Opacity */}
          <div>
            <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">OPACITY</div>
            <div className="flex items-center gap-1">
              <input type="range" min={1} max={30} value={Math.round(bandOpacity * 100)}
                onChange={e => setBandOpacity(+e.target.value / 100)}
                className="w-16" style={{ accentColor: GOLD }} />
              <span className="text-[9px] font-mono text-[var(--text-dim)]">{(bandOpacity * 100).toFixed(0)}%</span>
            </div>
          </div>

          <div className="flex-1" />

          {/* Toggles */}
          <div className="flex gap-1">
            <button onClick={() => setShowCandles(!showCandles)}
              className="px-2 py-1 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{
                background: showCandles ? "rgba(34,197,94,0.08)" : "transparent",
                borderColor: showCandles ? "#22c55e40" : "var(--border)",
                color: showCandles ? "#22c55e" : "var(--text-dim)",
              }}>{showCandles ? "●" : "○"} Candles</button>
            <button onClick={() => setShowSignals(!showSignals)}
              className="px-2 py-1 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{
                background: showSignals ? "rgba(34,197,94,0.08)" : "transparent",
                borderColor: showSignals ? "#22c55e40" : "var(--border)",
                color: showSignals ? "#22c55e" : "var(--text-dim)",
              }}>{showSignals ? "●" : "○"} Signals</button>
            <button onClick={() => setYAxisMode(m => m === "padded" ? "tight" : m === "tight" ? "free" : "padded")}
              className="px-2 py-1 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{
                background: yAxisMode !== "free" ? GOLD_DIM : "transparent",
                borderColor: yAxisMode !== "free" ? GOLD + "40" : "var(--border)",
                color: yAxisMode !== "free" ? GOLD : "var(--text-dim)",
              }}>{yAxisMode === "tight" ? "🔒 Tight" : yAxisMode === "padded" ? "🔒 Padded" : "🔓 Free"}</button>
            <button onClick={() => setShadingMode(m => m === "valley" ? "channel" : "valley")}
              className="px-2 py-1 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{
                background: GOLD_DIM,
                borderColor: GOLD + "40",
                color: GOLD,
              }}>{shadingMode === "valley" ? "🏔 Valley" : "📊 Channel"}</button>
          </div>
        </div>

        {/* Data source row */}
        <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-[var(--border)]">
          <span className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider">DATA:</span>

          {/* Load from your DB */}
          <select value={apiSymbol} onChange={e => setApiSymbol(e.target.value)}
            className="px-2 py-1 rounded text-[10px] font-mono font-semibold border border-[var(--border)] bg-[var(--bg-card2)] text-[var(--text)]">
            {allCoins.map(s =>
              <option key={s} value={s}>{s.replace("USDT", "")}</option>
            )}
          </select>
          <div className="flex gap-1">
            {[1, 5, 15, 60, 1440].map(m => (
              <button key={m} onClick={() => setApiBarMin(m)}
                className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold border transition-all"
                style={{
                  background: apiBarMin === m ? GOLD_DIM : "transparent",
                  borderColor: apiBarMin === m ? GOLD + "40" : "var(--border)",
                  color: apiBarMin === m ? GOLD : "var(--text-dim)",
                }}>{m === 60 ? "1H" : m === 1440 ? "1D" : m + "m"}</button>
            ))}
          </div>
          <button onClick={loadFromApi} disabled={apiLoading}
            className="px-3 py-1 rounded text-[10px] font-mono font-bold tracking-wider transition-all disabled:opacity-40"
            style={{ background: GOLD_DIM, color: GOLD, border: `1px solid ${GOLD}40` }}>
            {apiLoading ? "LOADING..." : "⟵ LOAD FROM DB"}
          </button>

          <span className="text-[var(--text-dim)] text-[10px]">or</span>

          <button onClick={() => setShowPasteModal(true)}
            className="px-3 py-1 rounded text-[10px] font-mono font-bold border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] transition-all">
            PASTE CSV
          </button>

          <div className="flex-1" />

          {/* Scroll */}
          <button onClick={() => setViewStart(0)}
            className="px-2 py-0.5 rounded text-[8px] font-mono font-bold border transition-all"
            style={{
              background: viewStart === 0 ? GOLD_DIM : "transparent",
              borderColor: viewStart === 0 ? GOLD + "40" : "var(--border)",
              color: viewStart === 0 ? GOLD : "var(--text-dim)",
            }}>◆ Genesis</button>
          <input type="range" min={0} max={Math.max(0, bars.length)}
            value={viewStart} onChange={e => setViewStart(+e.target.value)}
            className="w-40" style={{ accentColor: GOLD }} />
          <button onClick={() => {
              // Start late enough that some view slots are past the data, triggering projection
              const target = Math.max(0, bars.length - Math.round(viewBars * 0.5));
              setViewStart(target);
            }}
            className="px-2 py-0.5 rounded text-[8px] font-mono font-bold border transition-all"
            style={{
              background: viewStart >= bars.length - viewBars ? GOLD_DIM : "transparent",
              borderColor: viewStart >= bars.length - viewBars ? GOLD + "40" : "var(--border)",
              color: viewStart >= bars.length - viewBars ? GOLD : "var(--text-dim)",
            }}>Latest ▸</button>
          <span className="text-[9px] font-mono text-[var(--text-dim)] tabular-nums">{viewStart}–{vEnd} of {bars.length}</span>
          <span className="text-[8px] font-mono text-[var(--text-dim)]">← → keys</span>
        </div>
      </div>

      {/* Trade Strategy — expandable */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg mb-4 overflow-hidden">
        <button onClick={() => setShowStrategy(!showStrategy)}
          className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors">
          <span className="text-[11px] font-mono font-semibold" style={{ color: "#22c55e" }}>TRADE STRATEGY</span>
          <span className="text-[9px] font-mono text-[var(--text-dim)]">
            Str ×{minStrength} · Cyc {minCycle === 0 ? "Any" : `≥${minCycle}`} · Spike {spikeFilter ? (nearMiss ? "⚡±1" : "⚡") : "Off"} · Hold cyc/{holdDivisor}
          </span>
          <div className="flex-1" />
          {metrics && (
            <span className="text-[9px] font-mono tabular-nums" style={{ color: metrics.sharpe > 0 ? "#22c55e" : "#ef4444" }}>
              {metrics.trades}T · {metrics.winRate}%W · SR {metrics.sharpe.toFixed(2)}
            </span>
          )}
          <span className="text-[10px] text-[var(--text-dim)]">{showStrategy ? "▼" : "▶"}</span>
        </button>

        {showStrategy && (
          <div className="px-4 pb-4 pt-1 border-t border-[var(--border)]">
            <div className="flex flex-wrap items-start gap-6">

              {/* Entry: Min Strength */}
              <div>
                <div className="text-[9px] font-mono tracking-wider mb-1.5" style={{ color: "#22c55e60" }}>MIN STRENGTH</div>
                <div className="flex gap-1">
                  {[1, 2, 3, 5, 8].map(s => (
                    <button key={s} onClick={() => setMinStrength(s)}
                      className="px-2.5 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                      style={{
                        background: minStrength === s ? "rgba(34,197,94,0.12)" : "transparent",
                        borderColor: minStrength === s ? "#22c55e40" : "var(--border)",
                        color: minStrength === s ? "#22c55e" : "var(--text-dim)",
                      }}>×{s}</button>
                  ))}
                </div>
                <div className="text-[8px] font-mono text-[var(--text-dim)] mt-1 opacity-60">Bands that must agree</div>
              </div>

              {/* Entry: Min Cycle */}
              <div>
                <div className="text-[9px] font-mono tracking-wider mb-1.5" style={{ color: "#22c55e60" }}>MIN CYCLE</div>
                <div className="flex gap-1">
                  {[0, 50, 100, 150].map(c => (
                    <button key={c} onClick={() => setMinCycle(c)}
                      className="px-2.5 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                      style={{
                        background: minCycle === c ? "rgba(34,197,94,0.12)" : "transparent",
                        borderColor: minCycle === c ? "#22c55e40" : "var(--border)",
                        color: minCycle === c ? "#22c55e" : "var(--text-dim)",
                      }}>{c === 0 ? "Any" : `≥${c}`}</button>
                  ))}
                </div>
                <div className="text-[8px] font-mono text-[var(--text-dim)] mt-1 opacity-60">Longest triggering cycle</div>
              </div>

              {/* Entry: Spike Filter */}
              <div>
                <div className="text-[9px] font-mono tracking-wider mb-1.5" style={{ color: "#22c55e60" }}>SPIKE FILTER</div>
                <button onClick={() => setSpikeFilter(!spikeFilter)}
                  className="px-3 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                  style={{
                    background: spikeFilter ? "rgba(34,197,94,0.12)" : "transparent",
                    borderColor: spikeFilter ? "#22c55e40" : "var(--border)",
                    color: spikeFilter ? "#22c55e" : "var(--text-dim)",
                  }}>{spikeFilter ? "⚡ On" : "○ Off"}</button>
                <div className="text-[8px] font-mono text-[var(--text-dim)] mt-1 opacity-60">Band must be at spike tip</div>
              </div>

              {/* Entry: Near Miss ±1 */}
              <div>
                <div className="text-[9px] font-mono tracking-wider mb-1.5" style={{ color: "#22c55e60" }}>NEAR MISS</div>
                <button onClick={() => setNearMiss(!nearMiss)}
                  className="px-3 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                  style={{
                    background: nearMiss ? "rgba(34,197,94,0.12)" : "transparent",
                    borderColor: nearMiss ? "#22c55e40" : "var(--border)",
                    color: nearMiss ? "#22c55e" : "var(--text-dim)",
                  }}>±1 {nearMiss ? "On" : "Off"}</button>
                <div className="text-[8px] font-mono text-[var(--text-dim)] mt-1 opacity-60">Cross or spike ±1 bar</div>
              </div>

              <div className="w-px h-14 bg-[var(--border)] opacity-20 self-center" />

              {/* Exit: Hold Duration */}
              <div>
                <div className="text-[9px] font-mono tracking-wider mb-1.5" style={{ color: GOLD + "90" }}>HOLD = cycle ÷</div>
                <div className="flex gap-1">
                  {[2, 3, 4, 5].map(d => (
                    <button key={d} onClick={() => setHoldDivisor(d)}
                      className="px-2.5 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                      style={{
                        background: holdDivisor === d ? GOLD_DIM : "transparent",
                        borderColor: holdDivisor === d ? GOLD + "40" : "var(--border)",
                        color: holdDivisor === d ? GOLD : "var(--text-dim)",
                      }}>÷{d}</button>
                  ))}
                </div>
                <div className="text-[8px] font-mono text-[var(--text-dim)] mt-1 opacity-60">Hold for cycle/{holdDivisor} bars</div>
              </div>

            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 mb-4 relative">
        {hBar && (
          <div className="absolute top-2 left-20 z-10 flex items-center gap-4 text-[10px] font-mono">
            <span className="text-[var(--text-dim)]">{new Date(hBar.time).toLocaleString()}</span>
            <span>O <span className="text-[var(--text)]">{hBar.open.toFixed(2)}</span></span>
            <span>H <span className="text-[var(--up)]">{hBar.high.toFixed(2)}</span></span>
            <span>L <span className="text-[var(--down)]">{hBar.low.toFixed(2)}</span></span>
            <span>C <span style={{ color: hBar.close >= hBar.open ? "var(--up)" : "var(--down)" }}>{hBar.close.toFixed(2)}</span></span>
          </div>
        )}

        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet"
          onMouseMove={handleMM} onMouseLeave={() => setHoverIdx(null)}>

          {/* Clip path to constrain bands within the plot area */}
          <defs>
            <clipPath id="plotClip">
              <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {/* Grid */}
          {yTicks.map((v, i) => (
            <g key={`yt${i}`}>
              <line x1={PAD.left} y1={toY(v)} x2={W - PAD.right} y2={toY(v)} stroke="rgba(255,255,255,0.03)" />
              <text x={PAD.left - 6} y={toY(v) + 3} textAnchor="end" fill="rgba(255,255,255,0.2)" fontSize="8" fontFamily="monospace">
                {v >= 1000 ? v.toFixed(0) : v.toFixed(2)}
              </text>
            </g>
          ))}
          {xLabels.map(xl => (
            <text key={`xl${xl.idx}`} x={toX(xl.idx)} y={H - 6} textAnchor="middle"
              fill="rgba(255,255,255,0.15)" fontSize="7" fontFamily="monospace">{xl.label}</text>
          ))}

          {/* All bands and projection clipped to the plot area */}
          <g clipPath="url(#plotClip)">

          {/* Projection zone boundary — dashed vertical line at last real bar */}
          {projBars > 0 && (
            <>
              <line x1={toX(vBars.length - 0.5)} y1={PAD.top} x2={toX(vBars.length - 0.5)} y2={PAD.top + plotH}
                stroke={GOLD} strokeWidth={0.8} strokeDasharray="4,3" opacity={0.3} />
              <text x={toX(vBars.length + 2)} y={PAD.top + 12} fontSize="8" fontFamily="monospace" fill={GOLD} opacity={0.4}>
                PROJECTION
              </text>
            </>
          )}

          {/* Band fills — two modes:
              "valley": shading OUTSIDE bands (above upper, below lower) → black valley in middle
              "channel": shading BETWEEN upper & lower → traditional filled channels
              Both rendered outside-in: highest order first
              Bands extend into projection zone (cycle/3 bars beyond last candle) */}
          {[6, 5, 4, 3, 2, 1].filter(o => enabledOrders.includes(o)).map(order => {
            const bands = bandPathsByOrder[order];
            if (!bands) return null;
            const colorInfo = ORDER_COLORS[order];
            if (!colorInfo) return null;
            const chartTop = PAD.top;
            const chartBot = PAD.top + plotH;
            const totalVisualSlots = vBars.length + projBars;
            return bands.map((band: any, bi: number) => {
              if (shadingMode === "valley") {
                // VALLEY MODE: shade outside the bands
                const upperPoints: { i: number; u: number }[] = [];
                const lowerPoints: { i: number; l: number }[] = [];
                for (let i = 0; i < totalVisualSlots; i++) {
                  const gi = viewStart + i; // absolute index (extends past bars.length into projection)
                  if (gi < band.upper.length && band.upper[gi] !== null) upperPoints.push({ i, u: band.upper[gi] });
                  if (gi < band.lower.length && band.lower[gi] !== null) lowerPoints.push({ i, l: band.lower[gi] });
                }
                const fills: React.ReactNode[] = [];
                if (upperPoints.length >= 2) {
                  let uPath = upperPoints.map((p, j) =>
                    `${j === 0 ? "M" : "L"}${toX(p.i).toFixed(1)},${toY(p.u).toFixed(1)}`
                  ).join(" ");
                  uPath += ` L${toX(upperPoints[upperPoints.length - 1].i).toFixed(1)},${chartTop}`;
                  uPath += ` L${toX(upperPoints[0].i).toFixed(1)},${chartTop} Z`;
                  fills.push(<path key={`bfu-${order}-${bi}`} d={uPath} fill={colorInfo.base + bandOpacity + ")"} stroke="none" />);
                }
                if (lowerPoints.length >= 2) {
                  let lPath = lowerPoints.map((p, j) =>
                    `${j === 0 ? "M" : "L"}${toX(p.i).toFixed(1)},${toY(p.l).toFixed(1)}`
                  ).join(" ");
                  lPath += ` L${toX(lowerPoints[lowerPoints.length - 1].i).toFixed(1)},${chartBot}`;
                  lPath += ` L${toX(lowerPoints[0].i).toFixed(1)},${chartBot} Z`;
                  fills.push(<path key={`bfl-${order}-${bi}`} d={lPath} fill={colorInfo.base + bandOpacity + ")"} stroke="none" />);
                }
                return <g key={`bf-${order}-${bi}`}>{fills}</g>;
              } else {
                // CHANNEL MODE: shade between upper and lower
                const points: { i: number; u: number; l: number }[] = [];
                for (let i = 0; i < totalVisualSlots; i++) {
                  const gi = viewStart + i;
                  if (gi < band.upper.length && gi < band.lower.length &&
                      band.upper[gi] !== null && band.lower[gi] !== null && band.upper[gi] > band.lower[gi]) {
                    points.push({ i, u: band.upper[gi], l: band.lower[gi] });
                  }
                }
                if (points.length < 2) return null;
                let path = points.map((p, j) => `${j === 0 ? "M" : "L"}${toX(p.i).toFixed(1)},${toY(p.u).toFixed(1)}`).join(" ");
                path += " " + [...points].reverse().map((p) => `L${toX(p.i).toFixed(1)},${toY(p.l).toFixed(1)}`).join(" ");
                path += " Z";
                return <path key={`bf-${order}-${bi}`} d={path} fill={colorInfo.base + bandOpacity + ")"} stroke="none" />;
              }
            });
          })}

          {/* Band edge lines (sampled) — outside-in order */}
          {[6, 5, 4, 3, 2, 1].filter(o => enabledOrders.includes(o)).map(order => {
            const bands = bandPathsByOrder[order];
            if (!bands) return null;
            const hex = ORDER_HEX[order];
            if (!hex) return null;
            const every = Math.max(1, Math.floor((bands as any[]).length / 5));
            return (bands as any[]).filter((_: any, i: number) => i % every === 0 || i === (bands as any[]).length - 1).map((band: any, bi: number) => {
              let upperPath = "", lowerPath = "";
              let uS = false, lS = false;
              const totalVisualSlots = vBars.length + projBars;
              for (let i = 0; i < totalVisualSlots; i++) {
                const gi = viewStart + i;
                if (gi < band.upper.length && band.upper[gi] !== null) { upperPath += `${uS ? "L" : "M"}${toX(i).toFixed(1)},${toY(band.upper[gi]).toFixed(1)} `; uS = true; }
                if (gi < band.lower.length && band.lower[gi] !== null) { lowerPath += `${lS ? "L" : "M"}${toX(i).toFixed(1)},${toY(band.lower[gi]).toFixed(1)} `; lS = true; }
              }
              return (
                <g key={`be-${order}-${bi}`}>
                  {upperPath && <path d={upperPath} fill="none" stroke={hex} strokeWidth="0.4" opacity={0.25} />}
                  {lowerPath && <path d={lowerPath} fill="none" stroke={hex} strokeWidth="0.4" opacity={0.25} />}
                </g>
              );
            });
          })}

          </g>{/* end clipPath group */}

          {/* Candlesticks — always on top, fully opaque */}
          {showCandles && vBars.map((b: any, i: number) => {
            const x = toX(i), bullish = b.close >= b.open, color = bullish ? "#22c55e" : "#ef4444";
            const bTop = toY(Math.max(b.open, b.close)), bBot = toY(Math.min(b.open, b.close)), bH = Math.max(1, bBot - bTop);
            return (
              <g key={`c${i}`}>
                <line x1={x} y1={toY(b.high)} x2={x} y2={toY(b.low)} stroke={color} strokeWidth={1} opacity={0.9} />
                <rect x={x - bodyW / 2 - 0.5} y={bTop - 0.5} width={bodyW + 1} height={bH + 1} fill="rgba(0,0,0,0.7)" stroke="none" rx={0.5} />
                <rect x={x - bodyW / 2} y={bTop} width={bodyW} height={bH} fill={bullish ? "#0a0a0a" : color} stroke={color} strokeWidth={0.8} />
              </g>
            );
          })}

          {/* Signals */}
          {showSignals && visibleSignals.map((sig: any, i: number) => {
            const ci = sig.entryIdx - viewStart;
            if (ci < 0 || ci >= vBars.length) return null;
            const x = toX(ci), isLong = sig.type === "LONG";
            const y = isLong ? toY(vBars[ci].low) + 14 : toY(vBars[ci].high) - 14;
            const color = isLong ? "#22c55e" : "#ef4444";
            const exi = sig.exitActualIdx - viewStart;
            const showExit = exi >= 0 && exi < vBars.length;
            return (
              <g key={`s${i}`}>
                <polygon points={isLong ? `${x},${y - 8} ${x - 5},${y + 2} ${x + 5},${y + 2}` : `${x},${y + 8} ${x - 5},${y - 2} ${x + 5},${y - 2}`}
                  fill={color} opacity={0.9} />
                {sig.strength > 1 && (
                  <text x={x} y={isLong ? y + 16 : y - 14} textAnchor="middle" fontSize="7" fontFamily="monospace" fill={color} opacity={0.6}>×{sig.strength}</text>
                )}
                {sig.returnPct !== undefined && (
                  <text x={x} y={isLong ? y + (sig.strength > 1 ? 26 : 16) : y - (sig.strength > 1 ? 22 : 12)}
                    textAnchor="middle" fontSize="7" fontFamily="monospace" fontWeight="bold"
                    fill={sig.won ? "#22c55e" : "#ef4444"}>
                    {sig.returnPct >= 0 ? "+" : ""}{sig.returnPct.toFixed(1)}%
                  </text>
                )}
                {showExit && (
                  <line x1={x} y1={toY(sig.entryPrice)} x2={toX(exi)} y2={toY(sig.exitPrice)}
                    stroke={sig.won ? "#22c55e" : "#ef4444"} strokeWidth={0.5} strokeDasharray="3,3" opacity={0.3} />
                )}
              </g>
            );
          })}

          {/* Hover crosshair */}
          {hoverIdx != null && (
            <>
              <line x1={toX(hoverIdx)} y1={PAD.top} x2={toX(hoverIdx)} y2={PAD.top + plotH} stroke="rgba(255,255,255,0.08)" strokeWidth={0.5} />
              <rect x={W - PAD.right + 2} y={toY(vBars[hoverIdx].close) - 8} width={58} height={16} rx={2} fill="var(--bg-card2)" stroke="var(--border)" strokeWidth={0.5} />
              <text x={W - PAD.right + 5} y={toY(vBars[hoverIdx].close) + 3} fontSize="9" fontFamily="monospace"
                fill={vBars[hoverIdx].close >= vBars[hoverIdx].open ? "#22c55e" : "#ef4444"}>
                {vBars[hoverIdx].close.toFixed(2)}
              </text>
            </>
          )}
        </svg>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-2 text-[9px] font-mono text-[var(--text-dim)]">
          {enabledOrders.map(o => (
            <span key={o} className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm inline-block" style={{ background: ORDER_HEX[o] + "30", border: `1px solid ${ORDER_HEX[o]}50` }} />
              <span style={{ color: ORDER_HEX[o] }}>o{o} φ^{o}={Math.pow(1.618034, o).toFixed(2)}</span>
            </span>
          ))}
          <span className="text-[var(--border)]">|</span>
          <span><span className="text-[#22c55e]">▲</span> Long</span>
          <span><span className="text-[#ef4444]">▼</span> Short</span>
          <span className="text-[var(--border)]">|</span>
          <span>×N = band convergence</span>
        </div>
      </div>

      {/* Signals Table + Equity Curve */}
      {signals.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-3">
            <span className="text-[11px] font-mono font-semibold" style={{ color: GOLD }}>ENSEMBLE SIGNALS</span>
            <span className="text-[9px] font-mono text-[var(--text-dim)]">
              {metrics?.trades} trades · {metrics?.longs} longs · {metrics?.shorts} shorts · hold = cycle/{holdDivisor} · {spikeFilter ? (nearMiss ? "spike ⚡±1" : "spike ⚡") : "no spike"}
            </span>
            <div className="flex-1" />
            <button onClick={() => setShowEquityCurve(!showEquityCurve)}
              className="px-3 py-1 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{
                background: showEquityCurve ? GOLD_DIM : "transparent",
                borderColor: showEquityCurve ? GOLD + "40" : "var(--border)",
                color: showEquityCurve ? GOLD : "var(--text-dim)",
              }}>{showEquityCurve ? "● Equity Curve" : "○ Equity Curve"}</button>
          </div>

          {/* Equity Curve Chart */}
          {showEquityCurve && signals.length >= 2 && (
            <div className="px-4 py-3 border-b border-[var(--border)]">
              <EquityCurve signals={signals} barMinutes={apiBarMin} />
            </div>
          )}

          <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 bg-[var(--bg-card)] z-10">
                <tr className="text-[var(--text-dim)] border-b border-[var(--border)]">
                  <th className="text-left px-3 py-2">#</th>
                  <th className="text-left px-2 py-2">Type</th>
                  <th className="text-right px-2 py-2">Entry</th>
                  <th className="text-right px-2 py-2">Exit</th>
                  <th className="text-right px-2 py-2">Return</th>
                  <th className="text-right px-2 py-2">Cum Ret</th>
                  <th className="text-center px-2 py-2">Strength</th>
                  <th className="text-right px-2 py-2">Hold</th>
                  <th className="text-left px-2 py-2">Time</th>
                </tr>
              </thead>
              <tbody>
                {signals.slice().reverse().map((sig: any, i: number) => (
                  <tr key={i}
                    className="border-b border-[var(--border)] border-opacity-30 hover:bg-white/[0.03] transition-colors cursor-pointer"
                    onClick={() => {
                      const target = sig.entryIdx - Math.floor(viewBars / 2);
                      setViewStart(Math.max(0, Math.min(bars.length, target)));
                    }}>
                    <td className="px-3 py-2 text-[var(--text-dim)]">{signals.length - i}</td>
                    <td className="px-2 py-2">
                      <span className="font-semibold" style={{ color: sig.type === "LONG" ? "#22c55e" : "#ef4444" }}>
                        {sig.type === "LONG" ? "▲ LONG" : "▼ SHORT"}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right text-[var(--text-muted)] tabular-nums">${sig.entryPrice.toFixed(2)}</td>
                    <td className="px-2 py-2 text-right text-[var(--text-muted)] tabular-nums">${sig.exitPrice.toFixed(2)}</td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums" style={{ color: sig.won ? "#22c55e" : "#ef4444" }}>
                      {sig.returnPct >= 0 ? "+" : ""}{sig.returnPct.toFixed(3)}%
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums" style={{ color: sig.cumReturn >= 0 ? "#22c55e" : "#ef4444" }}>
                      {sig.cumReturn >= 0 ? "+" : ""}{sig.cumReturn.toFixed(2)}%
                    </td>
                    <td className="px-2 py-2 text-center" style={{ color: sig.strength > 3 ? GOLD : "var(--text-dim)" }}>×{sig.strength}</td>
                    <td className="px-2 py-2 text-right text-[var(--text-dim)] tabular-nums">{sig.holdDuration}b</td>
                    <td className="px-2 py-2 text-[var(--text-dim)]">
                      {new Date(sig.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Paste Modal */}
      {showPasteModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setShowPasteModal(false)}>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 w-[500px] max-h-[80vh]" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-2">Paste CSV Data</div>
            <div className="text-[10px] text-[var(--text-dim)] mb-3">
              Format: time,open,high,low,close,volume (one row per bar, min 50 rows)
            </div>
            <textarea value={pastedData} onChange={e => setPastedData(e.target.value)}
              rows={12} className="w-full bg-[var(--bg-card2)] border border-[var(--border)] rounded-lg p-3 text-[10px] font-mono text-[var(--text)] resize-y"
              placeholder="2026-02-15T00:00:00Z,2000.5,2005.3,1998.1,2003.2,150000..." />
            <div className="flex gap-2 mt-3">
              <button onClick={loadPastedData}
                className="px-4 py-2 rounded-lg text-[11px] font-mono font-bold"
                style={{ background: GOLD_DIM, color: GOLD, border: `1px solid ${GOLD}40` }}>LOAD</button>
              <button onClick={() => setShowPasteModal(false)}
                className="px-4 py-2 rounded-lg text-[11px] font-mono font-bold border border-[var(--border)] text-[var(--text-dim)]">CANCEL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider">{label}</span>
      <span className="text-[11px] font-mono font-semibold tabular-nums" style={{ color }}>{value}</span>
    </div>
  );
}

function EquityCurve({ signals, barMinutes }: { signals: any[]; barMinutes: number }) {
  const W = 1050, H = 200;
  const PAD = { top: 20, right: 60, bottom: 28, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Build equity points: start at 0, then each trade's cumReturn
  const points = [0, ...signals.map((s: any) => s.cumReturn as number)];
  // Annualised Sharpe = (mean / std) × √(525600 / avg_trade_minutes)
  const MINS_PER_YEAR = 525600;
  const rets = signals.map((s: any) => s.returnPct as number);
  const avgR = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const stdR = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - avgR) ** 2, 0) / rets.length) : 0;
  const avgHoldMins = signals.length > 0
    ? signals.reduce((s: number, sig: any) => s + sig.holdDuration * barMinutes, 0) / signals.length
    : 1;
  const annFactor = Math.sqrt(MINS_PER_YEAR / avgHoldMins);
  const sharpe = stdR > 0 ? (avgR / stdR) * annFactor : 0;
  const minY = Math.min(0, ...points);
  const maxY = Math.max(0, ...points);
  const rangeY = maxY - minY || 1;

  const toX = (i: number) => PAD.left + (i / (points.length - 1)) * plotW;
  const toY = (v: number) => PAD.top + plotH - ((v - minY) / rangeY) * plotH;

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(p).toFixed(1)}`).join(" ");
  const areaD = pathD + ` L${toX(points.length - 1).toFixed(1)},${toY(0).toFixed(1)} L${toX(0).toFixed(1)},${toY(0).toFixed(1)} Z`;

  const finalReturn = points[points.length - 1];
  const isPositive = finalReturn >= 0;
  const lineColor = isPositive ? "#22c55e" : "#ef4444";

  // Y ticks
  const yTicks: number[] = [];
  const step = rangeY / 4;
  for (let i = 0; i <= 4; i++) yTicks.push(minY + step * i);

  // X labels (trade numbers)
  const xLabels: { i: number; label: string }[] = [];
  const xStep = Math.max(1, Math.floor(signals.length / 8));
  for (let i = 0; i < signals.length; i += xStep) {
    xLabels.push({ i: i + 1, label: `#${i + 1}` }); // +1 because points[0] is the 0 start
  }
  xLabels.push({ i: signals.length, label: `#${signals.length}` });

  // Find max drawdown point
  let peak = 0, worstDD = 0, worstDDIdx = 0;
  for (let i = 0; i < points.length; i++) {
    if (points[i] > peak) peak = points[i];
    const dd = peak - points[i];
    if (dd > worstDD) { worstDD = dd; worstDDIdx = i; }
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-2">
        <span className="text-[10px] font-mono font-semibold" style={{ color: "#D4A843" }}>CUMULATIVE RETURNS</span>
        <span className="text-[9px] font-mono tabular-nums" style={{ color: lineColor }}>
          {isPositive ? "+" : ""}{finalReturn.toFixed(2)}%
        </span>
        <span className="text-[9px] font-mono tabular-nums" style={{ color: sharpe > 0.2 ? "#22c55e" : sharpe > 0 ? "#eab308" : "#ef4444" }}>
          Sharpe: {sharpe.toFixed(2)}
        </span>
        {worstDD > 0 && (
          <span className="text-[9px] font-mono tabular-nums text-[var(--down)]">
            Max DD: -{worstDD.toFixed(2)}%
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid */}
        {yTicks.map((v, i) => (
          <g key={`eyt${i}`}>
            <line x1={PAD.left} y1={toY(v)} x2={W - PAD.right} y2={toY(v)} stroke="rgba(255,255,255,0.04)" />
            <text x={PAD.left - 6} y={toY(v) + 3} textAnchor="end" fill="rgba(255,255,255,0.2)" fontSize="8" fontFamily="monospace">
              {v.toFixed(1)}%
            </text>
          </g>
        ))}

        {/* Zero line */}
        <line x1={PAD.left} y1={toY(0)} x2={W - PAD.right} y2={toY(0)}
          stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="4,4" />

        {/* X labels */}
        {xLabels.map(xl => (
          <text key={`exl${xl.i}`} x={toX(xl.i)} y={H - 5} textAnchor="middle"
            fill="rgba(255,255,255,0.15)" fontSize="7" fontFamily="monospace">{xl.label}</text>
        ))}

        {/* Area fill */}
        <path d={areaD} fill={lineColor + "10"} />

        {/* Equity line */}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />

        {/* Trade dots — colour by win/loss */}
        {signals.map((sig: any, i: number) => {
          const x = toX(i + 1);
          const y = toY(sig.cumReturn);
          return (
            <circle key={`ed${i}`} cx={x} cy={y} r={1.5}
              fill={sig.won ? "#22c55e" : "#ef4444"} opacity={0.7} />
          );
        })}

        {/* End dot + label */}
        <circle cx={toX(points.length - 1)} cy={toY(finalReturn)} r={4} fill={lineColor} />
        <circle cx={toX(points.length - 1)} cy={toY(finalReturn)} r={6} fill={lineColor} fillOpacity={0.3} />
        <text x={toX(points.length - 1) - 8} y={toY(finalReturn) - 10}
          textAnchor="end" fill={lineColor} fontSize="10" fontWeight="bold" fontFamily="monospace">
          {isPositive ? "+" : ""}{finalReturn.toFixed(2)}%
        </text>

        {/* Max drawdown marker */}
        {worstDD > 0.1 && (
          <>
            <line x1={toX(worstDDIdx)} y1={toY(points[worstDDIdx])} x2={toX(worstDDIdx)} y2={toY(points[worstDDIdx] + worstDD)}
              stroke="#ef4444" strokeWidth={1} strokeDasharray="2,2" opacity={0.5} />
            <text x={toX(worstDDIdx) + 4} y={toY(points[worstDDIdx]) + 10}
              fill="#ef4444" fontSize="7" fontFamily="monospace" opacity={0.6}>
              -{worstDD.toFixed(1)}%
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

