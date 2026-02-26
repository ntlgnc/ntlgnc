"use client";

import { useEffect, useState, useCallback, useRef } from "react";

/* ═══ TYPES ═══ */
type ScanResult = {
  symbol: string; barMinutes: number; cycle: number; order: number;
  mode: string; effectiveMinutes: number;
  total: number; buys: number; sells: number;
  winRate: number; avgRet: number; totalRet: number;
  maxWin: number; maxLoss: number; maxDrawdown: number;
  profitFactor: number | null; sharpe: number;
};
type ChartBar = {
  time: string; open: number; high: number; low: number; close: number;
  volume: number; lower: number | null; upper: number | null;
};
type ChartSignal = {
  idx: number; type: "BUY" | "SELL"; price: number; time: string;
  exitIdx?: number; exitPrice?: number; exitTime?: string;
  returnPct?: number; won?: boolean;
};

const COIN_COLORS_STATIC: Record<string, string> = {
  BTCUSDT: "#f7931a", ETHUSDT: "#627eea", XRPUSDT: "#fff", BNBUSDT: "#f3ba2f",
  SOLUSDT: "#9945ff", DOGEUSDT: "#c2a633", LINKUSDT: "#2a5ada", AVAXUSDT: "#e84142",
  ADAUSDT: "#0033ad", DOTUSDT: "#e6007a", LTCUSDT: "#bfbbbb", SHIBUSDT: "#ffa409",
  TRXUSDT: "#ef0027", XLMUSDT: "#14b6e7", HBARUSDT: "#666", ZECUSDT: "#ecb244",
  SUIUSDT: "#6fbcf0", TONUSDT: "#0098ea", UNIUSDT: "#ff007a", BCHUSDT: "#8dc351",
};
// Auto-assign colours for coins not in the static map
const _autoColors = ["#e6194b","#3cb44b","#ffe119","#4363d8","#f58231","#911eb4","#42d4f4","#f032e6","#bfef45","#fabed4","#469990","#dcbeff","#9A6324","#800000","#aaffc3","#808000","#ffd8b1","#000075","#a9a9a9","#e6beff"];
let _autoIdx = 0;
function coinColor(sym: string): string {
  if (COIN_COLORS_STATIC[sym]) return COIN_COLORS_STATIC[sym];
  // Assign a stable color based on symbol hash
  let hash = 0;
  for (let i = 0; i < sym.length; i++) hash = ((hash << 5) - hash) + sym.charCodeAt(i);
  return _autoColors[Math.abs(hash) % _autoColors.length];
}
const GOLD = "#D4A843";
const GOLD_DIM = "rgba(212,168,67,0.15)";
function barLimit(bm: number): number { return bm <= 1 ? 600 : bm <= 5 ? 300 : 200; }
function coinLabel(s: string) { return s.replace("USDT", ""); }

export default function FracmapTab() {
  const [view, setView] = useState<"scan" | "chart" | "live">("scan");
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanBarMin, setScanBarMin] = useState(0);
  const [scanMinTrades, setScanMinTrades] = useState(8);
  const [sortKey, setSortKey] = useState<keyof ScanResult>("sharpe");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [filterCoin, setFilterCoin] = useState<string>("all");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [allCoins, setAllCoins] = useState<string[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [chartSymbol, setChartSymbol] = useState("BTCUSDT");
  const [chartBarMin, setChartBarMin] = useState(15);
  const [chartCycle, setChartCycle] = useState(75);
  const [chartOrder, setChartOrder] = useState(2);
  const [chartBars, setChartBars] = useState<ChartBar[]>([]);
  const [chartSignals, setChartSignals] = useState<ChartSignal[]>([]);
  const [allSignals, setAllSignals] = useState<any[]>([]);
  const [chartMetrics, setChartMetrics] = useState<any>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [liveCandles, setLiveCandles] = useState<ChartBar[]>([]);
  const [liveSignals, setLiveSignals] = useState<any[]>([]);
  const [liveLastUpdate, setLiveLastUpdate] = useState<string | null>(null);
  const [liveBandDist, setLiveBandDist] = useState<{lower: number | null; upper: number | null} | null>(null);
  const [liveCurrentPrice, setLiveCurrentPrice] = useState<number | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const liveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const signalListRef = useRef<HTMLDivElement>(null);
  const [selectedSignalIdx, setSelectedSignalIdx] = useState<number | null>(null);
  const [pendingHighlight, setPendingHighlight] = useState<number | null>(null);
  const [currentTradeNum, setCurrentTradeNum] = useState<number | null>(null); // 0-based into allSignals (chronological)

  const runScan = useCallback(async () => {
    setScanning(true); setHasScanned(true);
    try {
      const bmParam = scanBarMin > 0 ? `&barMinutes=${scanBarMin}` : "";
      const res = await fetch(`/api/fracmap?action=scan${bmParam}&minTrades=${scanMinTrades}`);
      const data = await res.json();
      setScanResults(data.results || []); setSymbols(data.symbols || []);
    } catch {} setScanning(false);
  }, [scanBarMin, scanMinTrades]);

  const loadChartExplicit = useCallback(async (sym: string, bm: number, cyc: number, ord: number, centerBar?: number) => {
    setChartLoading(true); setSelectedSignalIdx(null);
    try {
      const lim = barLimit(bm);
      const centerParam = centerBar != null ? `&centerBar=${centerBar}` : "";
      const res = await fetch(`/api/fracmap?action=chart&symbol=${sym}&barMinutes=${bm}&cycle=${cyc}&order=${ord}&limit=${lim}${centerParam}`);
      const data = await res.json();
      setChartBars(data.bars || []); setChartSignals(data.signals || []); setAllSignals(data.allSignals || []); setChartMetrics(data.metrics || null);
    } catch {} setChartLoading(false);
  }, []);

  const loadCurrentChart = useCallback(() => {
    setCurrentTradeNum(null);
    loadChartExplicit(chartSymbol, chartBarMin, chartCycle, chartOrder);
  }, [loadChartExplicit, chartSymbol, chartBarMin, chartCycle, chartOrder]);

  useEffect(() => {
    if (autoRefresh && view === "chart") {
      refreshRef.current = setInterval(loadCurrentChart, 60000);
      return () => { if (refreshRef.current) clearInterval(refreshRef.current); };
    }
    return () => { if (refreshRef.current) clearInterval(refreshRef.current); };
  }, [autoRefresh, view, loadCurrentChart]);

  // Fetch available coins from DB
  useEffect(() => {
    fetch("/api/coins").then(r => r.json()).then(d => { if (d.coins?.length > 0) setAllCoins(d.coins); }).catch(() => {});
  }, []);

  const loadLiveExplicit = useCallback(async (sym: string, bm: number, cyc: number, ord: number) => {
    try {
      const params = new URLSearchParams({ action: "live", symbol: sym, cycle: String(cyc), order: String(ord), barMinutes: String(bm), viewBars: String(barLimit(bm)) });
      const res = await fetch(`/api/fracmap?${params}`);
      const data = await res.json();
      setLiveCandles(data.candles || []); setLiveSignals(data.signals || []);
      setLiveLastUpdate(data.lastUpdated); setLiveBandDist(data.bandDistance || null);
      setLiveCurrentPrice(data.currentPrice || null);
    } catch {}
  }, []);

  const loadCurrentLive = useCallback(() => {
    loadLiveExplicit(chartSymbol, chartBarMin, chartCycle, chartOrder);
  }, [loadLiveExplicit, chartSymbol, chartBarMin, chartCycle, chartOrder]);

  useEffect(() => {
    if (view === "live") {
      setLiveLoading(true); loadCurrentLive().finally(() => setLiveLoading(false));
      liveRef.current = setInterval(loadCurrentLive, 60000);
      return () => { if (liveRef.current) clearInterval(liveRef.current); };
    }
    return () => { if (liveRef.current) clearInterval(liveRef.current); };
  }, [view, loadCurrentLive]);

  // After chart reload with re-centering, highlight the pending signal
  useEffect(() => {
    if (pendingHighlight != null && allSignals.length > 0) {
      const match = allSignals.find(s => s.barIdx === pendingHighlight && s.inView);
      if (match && match.chartIdx != null) {
        setSelectedSignalIdx(match.chartIdx);
      }
      setPendingHighlight(null);
    }
  }, [allSignals, pendingHighlight]);

  /** Navigate to trade N (0-based, chronological). Re-centers chart if off-screen. */
  const navigateToTrade = useCallback((tradeNum: number) => {
    if (tradeNum < 0 || tradeNum >= allSignals.length) return;
    setCurrentTradeNum(tradeNum);
    const sig = allSignals[tradeNum];
    if (sig.inView && sig.chartIdx != null) {
      setSelectedSignalIdx(sig.chartIdx);
    } else {
      setPendingHighlight(sig.barIdx);
      loadChartExplicit(chartSymbol, chartBarMin, chartCycle, chartOrder, sig.barIdx);
    }
    // Highlight row in list without stealing page scroll from chart
    // The row gets highlighted via style, user can scroll list manually if needed
  }, [allSignals, chartSymbol, chartBarMin, chartCycle, chartOrder, loadChartExplicit]);

  const navPrev = useCallback(() => {
    if (allSignals.length === 0) return;
    const next = currentTradeNum != null ? Math.max(0, currentTradeNum - 1) : allSignals.length - 1;
    navigateToTrade(next);
  }, [allSignals, currentTradeNum, navigateToTrade]);

  const navNext = useCallback(() => {
    if (allSignals.length === 0) return;
    const next = currentTradeNum != null ? Math.min(allSignals.length - 1, currentTradeNum + 1) : 0;
    navigateToTrade(next);
  }, [allSignals, currentTradeNum, navigateToTrade]);

  const sorted = [...scanResults].filter(r => filterCoin === "all" || r.symbol === filterCoin)
    .sort((a, b) => { const av = a[sortKey] ?? 0; const bv = b[sortKey] ?? 0; return sortDir === "desc" ? (bv as number) - (av as number) : (av as number) - (bv as number); });

  const handleSort = (key: keyof ScanResult) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const openChart = (r: ScanResult) => {
    setChartSymbol(r.symbol); setChartBarMin(r.barMinutes); setChartCycle(r.cycle); setChartOrder(r.order);
    setView("chart"); setCurrentTradeNum(null);
    loadChartExplicit(r.symbol, r.barMinutes, r.cycle, r.order);
  };
  const openLive = (r: ScanResult) => {
    setChartSymbol(r.symbol); setChartBarMin(r.barMinutes); setChartCycle(r.cycle); setChartOrder(r.order);
    setView("live");
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="flex bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-0.5">
          {(["scan","chart","live"] as const).map(v => (
            <button key={v} onClick={() => setView(v)} className="px-4 py-1.5 rounded-md text-[11px] font-mono font-semibold tracking-wider transition-all"
              style={{ background: view === v ? v === "live" ? "rgba(34,197,94,0.12)" : GOLD_DIM : "transparent", color: view === v ? v === "live" ? "#22c55e" : GOLD : "var(--text-dim)" }}>
              {v === "scan" ? "SCANNER" : v === "chart" ? "BACKTEST CHART" : "● LIVE 1m"}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: GOLD }} />
          <span className="text-[10px] font-mono" style={{ color: GOLD }}>φ FRACMAP</span>
        </div>
      </div>

      {view === "scan" && (
        <div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
            <div className="flex items-start gap-3">
              <div className="text-2xl mt-0.5" style={{ color: GOLD }}>φ</div>
              <div>
                <div className="text-sm font-semibold mb-1">Fracmap Strategy Scanner</div>
                <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                  The scanner backtests the golden-ratio exhaustion indicator across all your coins using different parameter combinations.
                  Choose your preferred <strong>bar size</strong> (1m, 5m, 15m or All), set a <strong>minimum trade count</strong> for
                  statistical significance, then click <strong style={{ color: GOLD }}>↻ SCAN</strong> to run.
                  Results are ranked by Sharpe ratio. Click <strong>Chart</strong> to view the backtest with
                  entry/exit signals, or <strong>● Live</strong> to open the live 1-minute view with bands overlaid and projected forward.
                </div>
              </div>
            </div>
          </div>

          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">BAR SIZE</div>
                <div className="flex gap-1">
                  {[{v:0,l:"All"},{v:1,l:"1m"},{v:5,l:"5m"},{v:15,l:"15m"}].map(({v,l}) => (
                    <button key={v} onClick={() => setScanBarMin(v)} className="px-2.5 py-1 rounded text-[11px] font-mono font-semibold border transition-all"
                      style={{ background: scanBarMin === v ? GOLD_DIM : "transparent", borderColor: scanBarMin === v ? GOLD+"40" : "var(--border)", color: scanBarMin === v ? GOLD : "var(--text-muted)" }}>{l}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">MIN TRADES</div>
                <select value={scanMinTrades} onChange={e => setScanMinTrades(+e.target.value)}
                  className="px-2 py-1.5 rounded text-[11px] font-mono font-semibold border border-[var(--border)] bg-[var(--bg-card2)] text-[var(--text)]">
                  {[5,8,10,15,20,30].map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="flex-1" />
              {hasScanned && symbols.length > 0 && (
                <div>
                  <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">COIN FILTER</div>
                  <div className="flex gap-1 flex-wrap">
                    <button onClick={() => setFilterCoin("all")} className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold border transition-all"
                      style={{ background: filterCoin === "all" ? GOLD_DIM : "transparent", borderColor: filterCoin === "all" ? GOLD+"40" : "var(--border)", color: filterCoin === "all" ? GOLD : "var(--text-dim)" }}>ALL</button>
                    {symbols.map(s => (
                      <button key={s} onClick={() => setFilterCoin(s)} className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold border transition-all"
                        style={{ background: filterCoin === s ? (coinColor(s)||"#888")+"20" : "transparent", borderColor: filterCoin === s ? (coinColor(s)||"#888")+"40" : "var(--border)", color: filterCoin === s ? coinColor(s)||"#888" : "var(--text-dim)" }}>{coinLabel(s)}</button>
                    ))}
                  </div>
                </div>
              )}
              <button onClick={runScan} disabled={scanning} className="px-5 py-2 rounded-lg text-[12px] font-mono font-bold tracking-wider transition-all disabled:opacity-40"
                style={{ background: GOLD_DIM, color: GOLD, border: `1px solid ${GOLD}60` }}>{scanning ? "SCANNING..." : "↻ SCAN"}</button>
            </div>
          </div>

          {!hasScanned ? (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-12 text-center">
              <div className="text-lg mb-2" style={{ color: GOLD }}>φ</div>
              <div className="text-sm text-[var(--text-muted)] mb-1">Choose your settings above, then click <strong style={{ color: GOLD }}>↻ SCAN</strong></div>
              <div className="text-[10px] text-[var(--text-dim)]">The scanner will test hundreds of parameter combinations across all coins in your database.</div>
            </div>
          ) : (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-[11px] font-mono">
                  <thead className="sticky top-0 bg-[var(--bg-card)] z-10">
                    <tr className="text-[var(--text-dim)] border-b border-[var(--border)]">
                      <th className="text-left px-3 py-2.5">Coin</th>
                      <th className="text-left px-2 py-2.5 cursor-pointer hover:text-[var(--text)]" onClick={() => handleSort("cycle")}>Cycle {sortKey==="cycle"&&(sortDir==="desc"?"▾":"▴")}</th>
                      <th className="text-left px-2 py-2.5">Ord</th>
                      <th className="text-left px-2 py-2.5">Horizon</th>
                      <th className="text-right px-2 py-2.5 cursor-pointer hover:text-[var(--text)]" onClick={() => handleSort("total")}>Trades {sortKey==="total"&&(sortDir==="desc"?"▾":"▴")}</th>
                      <th className="text-right px-2 py-2.5 cursor-pointer hover:text-[var(--text)]" onClick={() => handleSort("winRate")}>Win% {sortKey==="winRate"&&(sortDir==="desc"?"▾":"▴")}</th>
                      <th className="text-right px-2 py-2.5 cursor-pointer hover:text-[var(--text)]" onClick={() => handleSort("avgRet")}>Avg Ret {sortKey==="avgRet"&&(sortDir==="desc"?"▾":"▴")}</th>
                      <th className="text-right px-2 py-2.5 cursor-pointer hover:text-[var(--text)]" onClick={() => handleSort("totalRet")}>Total {sortKey==="totalRet"&&(sortDir==="desc"?"▾":"▴")}</th>
                      <th className="text-right px-2 py-2.5">MaxDD</th>
                      <th className="text-right px-2 py-2.5">PF</th>
                      <th className="text-right px-2 py-2.5 cursor-pointer hover:text-[var(--text)]" onClick={() => handleSort("sharpe")}>Sharpe {sortKey==="sharpe"&&(sortDir==="desc"?"▾":"▴")}</th>
                      <th className="px-2 py-2.5 text-center">View</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.slice(0, 100).map((r, i) => {
                      const color = coinColor(r.symbol) || "#888";
                      const wrColor = r.winRate >= 65 ? "var(--up)" : r.winRate >= 50 ? "#eab308" : "var(--down)";
                      const retColor = r.avgRet >= 0 ? "var(--up)" : "var(--down)";
                      const shColor = r.sharpe >= 3 ? "var(--up)" : r.sharpe >= 1 ? "#eab308" : "var(--down)";
                      return (
                        <tr key={i} className="border-b border-[var(--border)] border-opacity-30 hover:bg-white/[0.03] transition-colors group">
                          <td className="px-3 py-2"><div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: color }} /><span className="font-semibold">{coinLabel(r.symbol)}</span></div></td>
                          <td className="px-2 py-2 text-[var(--text-muted)]">{r.barMinutes}m·c{r.cycle}</td>
                          <td className="px-2 py-2 text-[var(--text-muted)]">o{r.order}</td>
                          <td className="px-2 py-2 text-[var(--text-dim)]">{r.effectiveMinutes >= 60 ? `${(r.effectiveMinutes/60).toFixed(1)}h` : `${r.effectiveMinutes}m`}</td>
                          <td className="px-2 py-2 text-[var(--text-muted)] tabular-nums text-right">{r.total}</td>
                          <td className="px-2 py-2 tabular-nums font-semibold text-right" style={{ color: wrColor }}>{r.winRate}%</td>
                          <td className="px-2 py-2 tabular-nums font-semibold text-right" style={{ color: retColor }}>{r.avgRet >= 0 ? "+" : ""}{r.avgRet}%</td>
                          <td className="px-2 py-2 tabular-nums text-right" style={{ color: retColor }}>{r.totalRet >= 0 ? "+" : ""}{r.totalRet}%</td>
                          <td className="px-2 py-2 tabular-nums text-[var(--down)] text-right">-{r.maxDrawdown}%</td>
                          <td className="px-2 py-2 tabular-nums text-[var(--text-muted)] text-right">{r.profitFactor != null ? r.profitFactor : "∞"}</td>
                          <td className="px-2 py-2 tabular-nums font-semibold text-right" style={{ color: shColor }}>{r.sharpe}</td>
                          <td className="px-2 py-2 text-center">
                            <div className="flex gap-1 justify-center">
                              <button onClick={(e) => { e.stopPropagation(); openChart(r); }} className="px-2 py-1 rounded text-[9px] font-mono font-bold border border-[var(--border)] hover:border-[var(--brand)] hover:text-[var(--brand)] text-[var(--text-dim)] transition-colors flex items-center gap-1" title="View backtest chart"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,12 5,6 9,9 14,3" /><polyline points="10,3 14,3 14,7" /></svg>Chart</button>
                              <button onClick={(e) => { e.stopPropagation(); openLive(r); }} className="px-2 py-1 rounded text-[9px] font-mono font-bold border border-[var(--border)] hover:border-[var(--up)] hover:text-[var(--up)] text-[var(--text-dim)] transition-colors" title="Live 1m view">● Live</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {sorted.length === 0 && !scanning && <div className="text-center py-10 text-[var(--text-dim)] text-sm">No strategies found. Try lowering the minimum trades or changing bar size.</div>}
              {scanning && <div className="text-center py-10 text-sm" style={{ color: GOLD }}><span className="animate-pulse">Scanning parameter space across all coins...</span></div>}
            </div>
          )}
        </div>
      )}

      {view === "chart" && (
        <div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">SYMBOL</div>
                <select value={chartSymbol} onChange={e => setChartSymbol(e.target.value)} className="px-2 py-1.5 rounded text-[11px] font-mono font-semibold border border-[var(--border)] bg-[var(--bg-card2)] text-[var(--text)]">
                  {(symbols.length > 0 ? symbols : allCoins.length > 0 ? allCoins : ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"]).map(s => <option key={s} value={s}>{coinLabel(s)}</option>)}
                </select>
              </div>
              <div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">BAR</div>
                <div className="flex gap-1">{[1,5,15,60,1440].map(m => (
                  <button key={m} onClick={() => setChartBarMin(m)} className="px-2.5 py-1 rounded text-[11px] font-mono font-semibold border transition-all"
                    style={{ background: chartBarMin===m?GOLD_DIM:"transparent", borderColor: chartBarMin===m?GOLD+"40":"var(--border)", color: chartBarMin===m?GOLD:"var(--text-muted)" }}>{m === 60 ? "1H" : m === 1440 ? "1D" : m + "m"}</button>
                ))}</div>
              </div>
              <div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">CYCLE</div>
                <input type="number" value={chartCycle} onChange={e => setChartCycle(+e.target.value||75)} className="w-16 px-2 py-1 rounded text-[11px] font-mono border border-[var(--border)] bg-[var(--bg-card2)] text-[var(--text)] text-center" min={10} max={200} />
              </div>
              <div>
                <div className="text-[9px] font-mono text-[var(--text-dim)] tracking-wider mb-1">ORDER</div>
                <div className="flex gap-1">{[1,2,3,4,5,6].map(o => (
                  <button key={o} onClick={() => setChartOrder(o)} className="px-2.5 py-1 rounded text-[11px] font-mono font-semibold border transition-all"
                    style={{ background: chartOrder===o?GOLD_DIM:"transparent", borderColor: chartOrder===o?GOLD+"40":"var(--border)", color: chartOrder===o?GOLD:"var(--text-muted)" }}>{o}</button>
                ))}</div>
              </div>
              <div className="flex-1" />
              <button onClick={() => setAutoRefresh(!autoRefresh)} className="px-3 py-1.5 rounded text-[10px] font-mono font-semibold border transition-all"
                style={{ background: autoRefresh?"rgba(34,197,94,0.1)":"transparent", borderColor: autoRefresh?"#22c55e40":"var(--border)", color: autoRefresh?"#22c55e":"var(--text-dim)" }}>
                {autoRefresh ? "● LIVE" : "○ AUTO"}</button>
              <button onClick={loadCurrentChart} disabled={chartLoading} className="px-4 py-1.5 rounded-lg text-[11px] font-mono font-bold tracking-wider transition-all disabled:opacity-40"
                style={{ background: GOLD_DIM, color: GOLD, border: `1px solid ${GOLD}40` }}>{chartLoading ? "..." : "LOAD"}</button>
            </div>
            <div className="flex items-center gap-4 mt-3 pt-3 border-t border-[var(--border)]">
              <span className="text-[10px] font-mono text-[var(--text-dim)]">
                {coinLabel(chartSymbol)} · {chartBarMin}m · c{chartCycle} · o{chartOrder} · φ^{chartOrder}={Math.pow(1.618034,chartOrder).toFixed(3)} · Horizon: {chartBarMin*chartCycle>=60?`${(chartBarMin*chartCycle/60).toFixed(1)}h`:`${chartBarMin*chartCycle}m`}
              </span>
              {chartMetrics && (<>
                <span className="text-[10px] font-mono tabular-nums" style={{ color: chartMetrics.sharpe>3?"var(--up)":chartMetrics.sharpe>1?"#eab308":"var(--down)" }}>Sharpe {chartMetrics.sharpe}</span>
                <span className="text-[10px] font-mono tabular-nums" style={{ color: chartMetrics.winRate>60?"var(--up)":"#eab308" }}>Win {chartMetrics.winRate}%</span>
                <span className="text-[10px] font-mono tabular-nums" style={{ color: chartMetrics.avgRet>0?"var(--up)":"var(--down)" }}>Avg {chartMetrics.avgRet>0?"+":""}{chartMetrics.avgRet}%</span>
                <span className="text-[10px] font-mono tabular-nums text-[var(--down)]">MaxDD -{chartMetrics.maxDrawdown}%</span>
              </>)}
              {allSignals.length > 0 && <span className="text-[10px] font-mono" style={{ color: GOLD }}>{allSignals.length} signals ({chartSignals.length} in view)</span>}
            </div>
          </div>
          {chartBars.length === 0 && !chartLoading && (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-10 text-center mb-4">
              <div className="text-lg mb-2" style={{ color: GOLD }}>φ</div>
              <div className="text-sm text-[var(--text-muted)] mb-1">Backtest Chart</div>
              <div className="text-[10px] text-[var(--text-dim)] max-w-md mx-auto leading-relaxed">
                Configure the symbol, bar size, cycle and order above, then click <strong style={{ color: GOLD }}>LOAD</strong>.
                The chart shows historical price with golden-ratio φ exhaustion bands overlaid. Buy/sell signals appear as triangles.
                Dashed lines connect entry to exit showing the trade outcome. Bands project forward by ⅓ cycle to show upcoming support/resistance.
              </div>
            </div>
          )}
          {chartBars.length > 0 ? (
            <div ref={chartContainerRef} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 mb-4">
              <CandlestickChart bars={chartBars} signals={chartSignals} cycle={chartCycle} highlightIdx={selectedSignalIdx} />
            </div>
          ) : chartLoading ? (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-20 text-center">
              <span className="text-sm animate-pulse" style={{ color: GOLD }}>Loading chart data...</span>
            </div>
          ) : null}

          {/* Trade navigation controls */}
          {allSignals.length > 0 && chartBars.length > 0 && (
            <div className="flex items-center gap-3 mb-4 px-1">
              <button onClick={navPrev} disabled={currentTradeNum === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono font-semibold border transition-all disabled:opacity-30 hover:bg-white/[0.03]"
                style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="6,2 3,5 6,8" /></svg>
                Prev
              </button>
              <div className="flex items-center gap-2 flex-1 justify-center">
                {currentTradeNum != null && allSignals[currentTradeNum] ? (() => {
                  const sig = allSignals[currentTradeNum];
                  const isBuy = sig.type === "BUY";
                  return (
                    <div className="flex items-center gap-2 px-3 py-1 rounded-lg" style={{ background: isBuy ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)" }}>
                      <span className="text-[11px] font-mono font-bold" style={{ color: isBuy ? "#22c55e" : "#ef4444" }}>{sig.type}</span>
                      <span className="text-[10px] font-mono text-[var(--text-dim)]">@ ${sig.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                      <span className="text-[10px] font-mono text-[var(--text-dim)]">{new Date(sig.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      {sig.returnPct !== undefined && (
                        <span className="text-[11px] font-mono font-bold tabular-nums" style={{ color: sig.won ? "#22c55e" : "#ef4444" }}>
                          {sig.returnPct >= 0 ? "+" : ""}{sig.returnPct.toFixed(3)}%
                        </span>
                      )}
                    </div>
                  );
                })() : (
                  <span className="text-[10px] font-mono text-[var(--text-dim)]">Use ◀ ▶ to step through trades</span>
                )}
              </div>
              <div className="text-[10px] font-mono tabular-nums text-[var(--text-dim)]">
                {currentTradeNum != null ? `${currentTradeNum + 1} / ${allSignals.length}` : `${allSignals.length} trades`}
              </div>
              <button onClick={navNext} disabled={currentTradeNum === allSignals.length - 1}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono font-semibold border transition-all disabled:opacity-30 hover:bg-white/[0.03]"
                style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
                Next
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="4,2 7,5 4,8" /></svg>
              </button>
            </div>
          )}

          {allSignals.length > 0 && (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
              <div className="text-[10px] font-mono font-semibold tracking-wider text-[var(--text-dim)] uppercase mb-1">ALL SIGNALS ({allSignals.length})</div>
              <div className="text-[9px] text-[var(--text-dim)] mb-3">Click a row or use ◀ ▶ above to navigate trades</div>
              <div ref={signalListRef} className="space-y-1.5 max-h-[400px] overflow-y-auto">
                {allSignals.slice().reverse().map((sig, i) => {
                  const chronIdx = allSignals.length - 1 - i; // reverse back to chronological index
                  const isBuy = sig.type === "BUY";
                  const isSelected = currentTradeNum === chronIdx;
                  return (
                    <div key={i} id={`sig-row-${chronIdx}`} onClick={() => {
                      navigateToTrade(chronIdx);
                    }}
                      className="flex items-center gap-3 py-2 px-3 rounded-lg border cursor-pointer transition-all hover:bg-white/[0.02]"
                      style={{ borderColor: isSelected ? (isBuy ? "#22c55e40" : "#ef444440") : "var(--border)", background: isSelected ? (isBuy ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)") : "transparent", opacity: sig.inView ? 1 : 0.6 }}>
                      <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: isBuy?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)" }}>
                        <span className="text-sm font-bold" style={{ color: isBuy?"#22c55e":"#ef4444" }}>{isBuy?"↑":"↓"}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-mono font-semibold">{sig.type}</span>
                          <span className="text-[10px] font-mono text-[var(--text-dim)]">@ ${sig.price.toLocaleString(undefined,{maximumFractionDigits:4})}</span>
                          <span className="text-[9px] font-mono text-[var(--text-dim)]">{new Date(sig.time).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</span>
                          {sig.exitTime && <span className="text-[9px] font-mono text-[var(--text-dim)]">→ {new Date(sig.exitTime).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</span>}
                          {!sig.inView && <span className="text-[8px] font-mono px-1 rounded bg-white/[0.05] text-[var(--text-dim)]">click to view</span>}
                        </div>
                      </div>
                      {sig.returnPct !== undefined && (
                        <div className="text-right">
                          <span className="text-[11px] font-mono font-bold tabular-nums" style={{ color: sig.won?"#22c55e":"#ef4444" }}>{sig.returnPct>=0?"+":""}{sig.returnPct.toFixed(3)}%</span>
                          <div className="text-[8px] font-mono" style={{ color: sig.won?"#22c55e":"#ef4444", opacity: 0.6 }}>{sig.won?"WIN":"LOSS"}</div>
                        </div>
                      )}
                      <div className="text-[9px] font-mono text-[var(--text-dim)] tabular-nums w-8 text-right">{isSelected ? "◆" : `#${chronIdx + 1}`}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <button onClick={() => setView("scan")} className="mt-4 text-[11px] font-mono text-[var(--text-dim)] hover:text-[var(--text)] transition-colors">← Back to Scanner</button>
        </div>
      )}

      {view === "live" && (
        <div>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
            <div className="flex flex-wrap items-center gap-4 mb-3">
              <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[var(--up)] animate-pulse" /><span className="text-[11px] font-mono font-bold text-[var(--up)]">LIVE</span></div>
              <select value={chartSymbol} onChange={e => setChartSymbol(e.target.value)} className="px-2 py-1.5 rounded text-[11px] font-mono font-semibold border border-[var(--border)] bg-[var(--bg-card2)] text-[var(--text)]">
                {(symbols.length>0?symbols:allCoins.length>0?allCoins:["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"]).map(s => <option key={s} value={s}>{coinLabel(s)}</option>)}
              </select>
              <div className="flex gap-1">{[1,5,15,60,1440].map(m => (
                <button key={m} onClick={() => setChartBarMin(m)} className="px-2 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                  style={{ background: chartBarMin===m?GOLD_DIM:"transparent", borderColor: chartBarMin===m?GOLD+"40":"var(--border)", color: chartBarMin===m?GOLD:"var(--text-dim)" }}>{m === 60 ? "1H" : m === 1440 ? "1D" : m + "m"}</button>
              ))}</div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-mono text-[var(--text-dim)]">c</span>
                <input type="number" value={chartCycle} onChange={e => setChartCycle(+e.target.value||75)} className="w-14 px-1.5 py-1 rounded text-[10px] font-mono border border-[var(--border)] bg-[var(--bg-card2)] text-[var(--text)] text-center" />
                <span className="text-[9px] font-mono text-[var(--text-dim)]">o</span>
                <div className="flex gap-0.5">{[1,2,3,4,5,6].map(o => (
                  <button key={o} onClick={() => setChartOrder(o)} className="w-6 h-6 rounded text-[10px] font-mono font-semibold border transition-all"
                    style={{ background: chartOrder===o?GOLD_DIM:"transparent", borderColor: chartOrder===o?GOLD+"40":"var(--border)", color: chartOrder===o?GOLD:"var(--text-dim)" }}>{o}</button>
                ))}</div>
              </div>
              <div className="flex-1" />
              {liveLastUpdate && <span className="text-[9px] font-mono text-[var(--text-dim)]">Updated {new Date(liveLastUpdate).toLocaleTimeString()} · refreshes 60s</span>}
            </div>
            {liveBandDist && liveCurrentPrice && (
              <div className="flex items-center gap-6 pt-3 border-t border-[var(--border)]">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: coinColor(chartSymbol)||"#888" }} />
                  <span className="text-sm font-mono font-bold">{coinLabel(chartSymbol)}</span>
                  <span className="text-sm font-mono tabular-nums text-[var(--text)]">${liveCurrentPrice.toLocaleString(undefined,{maximumFractionDigits:2})}</span>
                </div>
                <BandGauge label="To Lower" value={liveBandDist.lower} color="#22c55e" direction="down" />
                <BandGauge label="To Upper" value={liveBandDist.upper} color="#ef4444" direction="up" />
              </div>
            )}
            {!liveLoading && liveCandles.length === 0 && (
              <div className="mt-3 pt-3 border-t border-[var(--border)] text-[10px] text-[var(--text-dim)]">
                Shows candles with Fracmap φ bands projected from the aggregated timeframe. The dashed golden lines extend forward showing future support/resistance. Auto-refreshes every 60 seconds.
              </div>
            )}
          </div>
          {liveLoading && liveCandles.length === 0 ? (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-20 text-center"><span className="text-sm animate-pulse text-[var(--up)]">Loading live data...</span></div>
          ) : liveCandles.length > 0 ? (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 mb-4"><CandlestickChart bars={liveCandles} signals={[]} cycle={chartCycle} /></div>
          ) : <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-20 text-center text-[var(--text-dim)] text-sm">No live data available</div>}
          {liveSignals.length > 0 && (
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
              <div className="text-[9px] font-mono font-semibold tracking-wider text-[var(--text-dim)] uppercase mb-2">RECENT FRACMAP SIGNALS</div>
              <div className="flex flex-wrap gap-2">
                {liveSignals.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border" style={{ background: s.type==="BUY"?"rgba(34,197,94,0.06)":"rgba(239,68,68,0.06)", borderColor: s.type==="BUY"?"rgba(34,197,94,0.2)":"rgba(239,68,68,0.2)" }}>
                    <span className="text-xs font-bold" style={{ color: s.type==="BUY"?"#22c55e":"#ef4444" }}>{s.type==="BUY"?"▲":"▼"} {s.type}</span>
                    <span className="text-[10px] font-mono text-[var(--text-muted)]">@ ${s.price.toLocaleString(undefined,{maximumFractionDigits:2})}</span>
                    <span className="text-[9px] font-mono text-[var(--text-dim)]">{new Date(s.time).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <button onClick={() => setView("scan")} className="mt-4 text-[11px] font-mono text-[var(--text-dim)] hover:text-[var(--text)] transition-colors">← Back to Scanner</button>
        </div>
      )}
    </div>
  );
}

function BandGauge({ label, value, color, direction }: { label: string; value: number | null; color: string; direction: "up" | "down" }) {
  if (value === null) return null;
  const pct = Math.min(Math.abs(value), 5);
  const width = (pct / 5) * 100;
  const isClose = Math.abs(value) < 0.5;
  return (
    <div className="flex items-center gap-2">
      <div className="text-[9px] font-mono text-[var(--text-dim)]">{label}</div>
      <div className="w-24 h-2 rounded-full bg-white/[0.05] overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${width}%`, background: isClose?color:color+"60" }} />
      </div>
      <span className="text-[10px] font-mono font-semibold tabular-nums" style={{ color: isClose?color:"var(--text-muted)" }}>{value>0?"+":""}{value}%</span>
      {isClose && <span className="text-[8px] font-mono font-bold px-1 py-0 rounded animate-pulse" style={{ background: color+"20", color }}>{direction==="down"?"NEAR BUY":"NEAR SELL"}</span>}
    </div>
  );
}

function CandlestickChart({ bars, signals, cycle, highlightIdx }: { bars: ChartBar[]; signals: ChartSignal[]; cycle: number; highlightIdx?: number | null }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const futureExt = Math.round(cycle / 3);
  const W = 960, H = 400;
  const PAD = { top: 20, right: 65, bottom: 30, left: 70 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const n = bars.length;
  const totalBars = n + futureExt;
  const candleW = plotW / totalBars;
  const bodyW = Math.max(1, candleW * 0.6);
  let minP = Infinity, maxP = -Infinity;
  bars.forEach(b => { if (b.high > maxP) maxP = b.high; if (b.low < minP) minP = b.low; });
  const rangeP = maxP - minP || 1;
  const yPad = rangeP * 0.10;
  const toX = (i: number) => PAD.left + (i + 0.5) * candleW;
  const toY = (p: number) => PAD.top + plotH - ((p - (minP - yPad)) / (rangeP + 2 * yPad)) * plotH;

  let upperPath = "", lowerPath = "", upperStart = false, lowerStart = false;
  let lastUpper: number | null = null, lastLower: number | null = null;
  bars.forEach((b, i) => {
    if (b.upper != null) { upperPath += `${upperStart?"L":"M"}${toX(i).toFixed(1)},${toY(b.upper).toFixed(1)} `; upperStart = true; lastUpper = b.upper; }
    if (b.lower != null) { lowerPath += `${lowerStart?"L":"M"}${toX(i).toFixed(1)},${toY(b.lower).toFixed(1)} `; lowerStart = true; lastLower = b.lower; }
  });
  let futureUpper = "", futureLower = "";
  if (lastUpper !== null) futureUpper = `M${toX(n-1).toFixed(1)},${toY(lastUpper).toFixed(1)} L${toX(n+futureExt-1).toFixed(1)},${toY(lastUpper).toFixed(1)}`;
  if (lastLower !== null) futureLower = `M${toX(n-1).toFixed(1)},${toY(lastLower).toFixed(1)} L${toX(n+futureExt-1).toFixed(1)},${toY(lastLower).toFixed(1)}`;

  const yTicks: number[] = []; const step = rangeP / 5;
  for (let i = 0; i <= 5; i++) yTicks.push(minP + step * i);
  const xLabels: {idx:number;label:string}[] = [];
  const labelInt = Math.max(1, Math.floor(n / 8));
  for (let i = 0; i < n; i += labelInt) xLabels.push({ idx: i, label: new Date(bars[i].time).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) });

  const handleMM = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (W / rect.width);
    const idx = Math.floor((mx - PAD.left) / candleW);
    setHoverIdx(idx >= 0 && idx < n ? idx : null);
  };
  const hBar = hoverIdx != null ? bars[hoverIdx] : null;

  return (
    <div className="relative">
      {hBar && (
        <div className="absolute top-0 left-20 z-10 flex items-center gap-4 text-[10px] font-mono">
          <span className="text-[var(--text-dim)]">{new Date(hBar.time).toLocaleString()}</span>
          <span>O <span className="text-[var(--text)]">{hBar.open.toFixed(2)}</span></span>
          <span>H <span className="text-[var(--up)]">{hBar.high.toFixed(2)}</span></span>
          <span>L <span className="text-[var(--down)]">{hBar.low.toFixed(2)}</span></span>
          <span>C <span style={{ color: hBar.close>=hBar.open?"var(--up)":"var(--down)" }}>{hBar.close.toFixed(2)}</span></span>
          {hBar.upper != null && <span style={{ color: GOLD }}>φ↑ {hBar.upper.toFixed(2)}</span>}
          {hBar.lower != null && <span style={{ color: GOLD }}>φ↓ {hBar.lower.toFixed(2)}</span>}
        </div>
      )}
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet" onMouseMove={handleMM} onMouseLeave={() => setHoverIdx(null)}>
        <rect x={toX(n-0.5)} y={PAD.top} width={futureExt*candleW} height={plotH} fill="rgba(212,168,67,0.02)" />
        {futureExt > 0 && <line x1={toX(n-0.5)} y1={PAD.top} x2={toX(n-0.5)} y2={PAD.top+plotH} stroke={GOLD} strokeWidth={0.5} opacity={0.15} strokeDasharray="4,4" />}
        {yTicks.map((v,i) => (<g key={i}><line x1={PAD.left} y1={toY(v)} x2={W-PAD.right} y2={toY(v)} stroke="rgba(255,255,255,0.04)" /><text x={PAD.left-6} y={toY(v)+3} textAnchor="end" fill="rgba(255,255,255,0.25)" fontSize="9" fontFamily="monospace">{v>=1000?v.toFixed(0):v.toFixed(2)}</text></g>))}
        {xLabels.map(xl => <text key={xl.idx} x={toX(xl.idx)} y={H-6} textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize="8" fontFamily="monospace">{xl.label}</text>)}
        {bars.some(b => b.upper!=null&&b.lower!=null) && (() => {
          const vb = bars.map((b,i) => ({i,u:b.upper,l:b.lower})).filter(b => b.u!=null&&b.l!=null);
          if (vb.length<2) return null;
          let fp = vb.map((b,j) => `${j===0?"M":"L"}${toX(b.i).toFixed(1)},${toY(b.u!).toFixed(1)}`).join(" ");
          fp += " " + [...vb].reverse().map((b,j) => `${j===0?"L":"L"}${toX(b.i).toFixed(1)},${toY(b.l!).toFixed(1)}`).join(" ") + " Z";
          return <path d={fp} fill={GOLD} opacity={0.04} />;
        })()}
        {lastUpper!==null && lastLower!==null && <rect x={toX(n-1)} y={toY(lastUpper)} width={futureExt*candleW} height={Math.abs(toY(lastLower)-toY(lastUpper))} fill={GOLD} opacity={0.03} />}
        {upperPath && <path d={upperPath} fill="none" stroke={GOLD} strokeWidth="1.2" opacity={0.6} strokeDasharray="3,2" />}
        {lowerPath && <path d={lowerPath} fill="none" stroke={GOLD} strokeWidth="1.2" opacity={0.6} strokeDasharray="3,2" />}
        {futureUpper && <path d={futureUpper} fill="none" stroke={GOLD} strokeWidth="1.5" opacity={0.4} strokeDasharray="6,3" />}
        {futureLower && <path d={futureLower} fill="none" stroke={GOLD} strokeWidth="1.5" opacity={0.4} strokeDasharray="6,3" />}
        {futureExt>0 && lastUpper!==null && <text x={toX(n+futureExt/2)} y={PAD.top+14} textAnchor="middle" fill={GOLD} opacity={0.3} fontSize="8" fontFamily="monospace">→ projection ({futureExt} bars)</text>}
        {lastUpper!==null && <text x={toX(n+futureExt-1)+4} y={toY(lastUpper)+3} fontSize="8" fontFamily="monospace" fill={GOLD} opacity={0.5}>{lastUpper>=1000?lastUpper.toFixed(0):lastUpper.toFixed(2)}</text>}
        {lastLower!==null && <text x={toX(n+futureExt-1)+4} y={toY(lastLower)+3} fontSize="8" fontFamily="monospace" fill={GOLD} opacity={0.5}>{lastLower>=1000?lastLower.toFixed(0):lastLower.toFixed(2)}</text>}
        {bars.map((b,i) => {
          const x=toX(i), bullish=b.close>=b.open, color=bullish?"#22c55e":"#ef4444";
          const bTop=toY(Math.max(b.open,b.close)), bBot=toY(Math.min(b.open,b.close)), bH=Math.max(1,bBot-bTop);
          return (<g key={i}><line x1={x} y1={toY(b.high)} x2={x} y2={toY(b.low)} stroke={color} strokeWidth={0.8} opacity={0.5} /><rect x={x-bodyW/2} y={bTop} width={bodyW} height={bH} fill={bullish?"transparent":color} stroke={color} strokeWidth={0.8} opacity={0.8} /></g>);
        })}
        {signals.map((sig,i) => {
          if (sig.idx<0||sig.idx>=n) return null;
          const x=toX(sig.idx), y=sig.type==="BUY"?toY(bars[sig.idx].low)+12:toY(bars[sig.idx].high)-12, isBuy=sig.type==="BUY";
          const isHL = highlightIdx === sig.idx;
          return (<g key={`s${i}`}>
            {isHL && <>
              <line x1={x} y1={PAD.top} x2={x} y2={PAD.top+plotH} stroke={isBuy?"#22c55e":"#ef4444"} strokeWidth={1} opacity={0.3} strokeDasharray="4,3" />
              <circle cx={x} cy={y-3} r={14} fill="none" stroke={isBuy?"#22c55e":"#ef4444"} strokeWidth={2} opacity={0.6}>
                <animate attributeName="r" from="10" to="18" dur="1.5s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.6" to="0" dur="1.5s" repeatCount="indefinite" />
              </circle>
              <circle cx={x} cy={y-3} r={10} fill={isBuy?"#22c55e":"#ef4444"} opacity={0.12} />
            </>}
            <polygon points={isBuy?`${x},${y-8} ${x-5},${y+2} ${x+5},${y+2}`:`${x},${y+8} ${x-5},${y-2} ${x+5},${y-2}`} fill={isBuy?"#22c55e":"#ef4444"} opacity={isHL?1:0.9} />
            {sig.returnPct!==undefined && <text x={x} y={isBuy?y+18:y-14} textAnchor="middle" fontSize={isHL?"10":"8"} fontFamily="monospace" fontWeight="bold" fill={sig.won?"#22c55e":"#ef4444"}>{sig.returnPct>=0?"+":""}{sig.returnPct.toFixed(1)}%</text>}
            {sig.exitIdx!=null&&sig.exitIdx>=0&&sig.exitIdx<n && <line x1={x} y1={toY(sig.price)} x2={toX(sig.exitIdx)} y2={toY(sig.exitPrice!)} stroke={sig.won?"#22c55e":"#ef4444"} strokeWidth={isHL?1:0.5} strokeDasharray="2,2" opacity={isHL?0.7:0.4} />}
          </g>);
        })}
        {hoverIdx!=null&&hoverIdx>=0&&hoverIdx<n && (<>
          <line x1={toX(hoverIdx)} y1={PAD.top} x2={toX(hoverIdx)} y2={PAD.top+plotH} stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
          <rect x={W-PAD.right+2} y={toY(bars[hoverIdx].close)-8} width={58} height={16} rx={2} fill="var(--bg-card2)" stroke="var(--border)" strokeWidth={0.5} />
          <text x={W-PAD.right+5} y={toY(bars[hoverIdx].close)+3} fontSize="9" fontFamily="monospace" fill={bars[hoverIdx].close>=bars[hoverIdx].open?"#22c55e":"#ef4444"}>{bars[hoverIdx].close.toFixed(2)}</text>
        </>)}
      </svg>
      <div className="flex items-center gap-4 mt-2 text-[9px] font-mono text-[var(--text-dim)]">
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block rounded" style={{ background: GOLD, opacity: 0.6 }} /> φ Bands</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block rounded" style={{ background: GOLD, opacity: 0.3 }} /> Projected</span>
        <span className="flex items-center gap-1"><span className="text-[#22c55e]">▲</span> Buy</span>
        <span className="flex items-center gap-1"><span className="text-[#ef4444]">▼</span> Sell</span>
        <span style={{ color: GOLD, opacity: 0.5 }}>φ = 1.618</span>
      </div>
    </div>
  );
}
