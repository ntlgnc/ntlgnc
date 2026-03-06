"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import RegimeAnalysis from "./RegimeAnalysis";
import HedgedStrategy from "./HedgedStrategy";
import { adminFetch } from "@/lib/admin-fetch";

const GOLD = "#D4A843";
const GOLD_DIM = "rgba(212,168,67,0.08)";

const FALLBACK_COINS = ["ETHUSDT","BTCUSDT","XRPUSDT","SOLUSDT","BNBUSDT","ADAUSDT","DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT","SHIBUSDT","UNIUSDT","TRXUSDT","XLMUSDT","BCHUSDT","HBARUSDT","ZECUSDT","SUIUSDT","TONUSDT"];
const OPT_STRENGTHS = [1, 2, 3, 5, 8];
const OPT_SPIKE = [false, true];
const OPT_NEARMISS = [false, true];
const OPT_HOLDDIV = [2, 3, 4, 5];
// PxExt is always ON — proven to improve all strategies
// OPT_MINCYCLES generated dynamically based on cycle range

type Combo = { minStr: number; minCyc: number; spike: boolean; nearMiss: boolean; holdDiv: number; priceExt: boolean; key: string };
type CoinResult = { symbol: string; barsLoaded: number; comboSharpes: Record<string, number>; comboWinRates: Record<string, number>; comboTotalRets: Record<string, number>; comboTrades: Record<string, number>; bestComboKey: string; bestSharpe: number };
type UniResult = { combo: Combo; avgSharpe: number; avgWinRate: number; avgTotalRet: number; avgTrades: number; coinSharpes: Record<string, number>; consistency: number };

function sharpeColor(val: number, maxAbs: number): string {
  if (maxAbs === 0) return "rgba(128,128,128,0.1)";
  const norm = Math.max(-1, Math.min(1, val / maxAbs));
  if (norm >= 0) return `rgba(34,197,94,${(0.06 + norm * 0.65).toFixed(2)})`;
  return `rgba(239,68,68,${(0.06 + (-norm) * 0.65).toFixed(2)})`;
}

type RunSnapshot = {
  barMinutes: number;
  cycleMin: number;
  cycleMax: number;
  coinResults: CoinResult[];
  uniResults: UniResult[];
  combos: Combo[];
  totalBars: number;
  winner: UniResult | null;
};

export default function FracmapScanner() {
  const [allCoins, setAllCoins] = useState<string[]>(FALLBACK_COINS);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  const [progress, setProgress] = useState("");
  const [barMinutes, setBarMinutes] = useState(15);
  const [cycleMin, setCycleMin] = useState(5);
  const [cycleMax, setCycleMax] = useState(20);
  const [randomMode, setRandomMode] = useState(false);
  const [excludedCoins, setExcludedCoins] = useState<Set<string>>(() => {
    try { const s = sessionStorage.getItem("fracmap_excluded_coins"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [coinResults, setCoinResults] = useState<CoinResult[]>([]);
  const [uniResults, setUniResults] = useState<UniResult[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);
  const [view, setView] = useState<"universal" | "coins">("universal");
  const [metric, setMetric] = useState<"sharpe" | "winRate" | "totalRet">("sharpe");
  const [runHistory, setRunHistory] = useState<RunSnapshot[]>(() => {
    try { const s = sessionStorage.getItem("fracmap_scanner_runs"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [activeRun, setActiveRun] = useState<number>(-1); // -1 = live/latest
  const [appendMode, setAppendMode] = useState(false);

  // Persist run history to sessionStorage
  useEffect(() => {
    try {
      // Only persist last 5 runs to avoid exceeding storage limits
      const toStore = runHistory.slice(-5);
      sessionStorage.setItem("fracmap_scanner_runs", JSON.stringify(toStore));
    } catch {}
  }, [runHistory]);

  // Fetch available coins from DB on mount
  useEffect(() => {
    fetch("/api/coins").then(r => r.json()).then(d => {
      if (d.coins?.length > 0) setAllCoins(d.coins);
    }).catch(() => {});
    // Fetch market-cap rankings (cached 24h server-side)
    fetch("/api/coins?action=market-cap-rank").then(r => r.json()).then(d => {
      if (d.rankings) setMcapRanks(d.rankings);
    }).catch(() => {});
  }, []);

  // Persist excluded coins
  useEffect(() => {
    try { sessionStorage.setItem("fracmap_excluded_coins", JSON.stringify([...excludedCoins])); } catch {}
  }, [excludedCoins]);

  const activeCoins = useMemo(() => allCoins.filter(c => !excludedCoins.has(c)), [excludedCoins, allCoins]);

  // Auto-restore last run's data on mount
  useEffect(() => {
    if (runHistory.length > 0 && coinResults.length === 0 && !running) {
      const last = runHistory[runHistory.length - 1];
      setCoinResults(last.coinResults);
      setUniResults(last.uniResults);
      setCombos(last.combos);
      setBarMinutes(last.barMinutes);
      if (last.cycleMin) setCycleMin(last.cycleMin);
      if (last.cycleMax) setCycleMax(last.cycleMax);
      setActiveRun(-1);
      setProgress(`✅ Restored previous run — ${last.combos.length} combos × ${last.coinResults.length} coins · ${last.totalBars.toLocaleString()} total bars`);
      // Restore OOS results if saved
      try {
        const oos = sessionStorage.getItem("fracmap_scanner_oos");
        if (oos) { const d = JSON.parse(oos); setOosResults(d.results || []); setOosWinner(d.winner || null); }
      } catch {}
      // Restore regime signals + refetch bars (signals are small, bars are too big for sessionStorage)
      try {
        const regRaw = sessionStorage.getItem("fracmap_scanner_regime_sigs");
        if (regRaw) {
          const reg = JSON.parse(regRaw);
          if (reg.oos && Object.keys(reg.oos).length > 0) {
            setRegimeOosSignals(reg.oos);
            if (reg.is) setRegimeIsSignals(reg.is);
            // Re-fetch bars in small batches to avoid freezing
            const bm = last.barMinutes || 1;
            const syms = Object.keys(reg.oos).slice(0, 30); // cap at 30 coins for restore
            const fetchBars = async () => {
              const oosB: Record<string,any[]> = {};
              const isB: Record<string,any[]> = {};
              const BATCH = 3;
              for (let i = 0; i < syms.length; i += BATCH) {
                const batch = syms.slice(i, i + BATCH);
                await Promise.all(batch.map(async (sym) => {
                  try {
                    const res = await adminFetch(`/api/fracmap?action=chart&symbol=${sym}&barMinutes=${bm}&cycle=75&order=1&limit=999999`);
                    const data = await res.json();
                    if (data.bars?.length > 50) {
                      const splitIdx = Math.round(data.bars.length * 50 / 100);
                      oosB[sym] = data.bars.slice(splitIdx).map((b: any) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
                      isB[sym] = data.bars.slice(0, splitIdx).map((b: any) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
                    }
                  } catch {}
                }));
                await new Promise(r => setTimeout(r, 0)); // yield between batches
              }
              if (Object.keys(oosB).length > 0) { setRegimeCoinBars(oosB); setRegimeIsBars(isB); }
            };
            fetchBars();
          }
        }
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showTop, setShowTop] = useState(30);
  const [auditData, setAuditData] = useState<{ symbol: string; bars1m: number; bars5m: number; bars15m: number; oldest1m: string; oldest5m: string; oldest15m: string }[]>([]);
  const [auditing, setAuditing] = useState(false);
  const [auditProgress, setAuditProgress] = useState("");
  const [splitPct, setSplitPct] = useState(50); // % of data for in-sample
  const [isStartYear, setIsStartYear] = useState(0); // IS data must start from this year
  const [oosResults, setOosResults] = useState<{ coin: string; bars: number; trades: number; sharpe: number; winRate: number; totalRet: number; profitFactor: number }[]>([]);
  const [oosWinner, setOosWinner] = useState<Combo | null>(null);
  // Regime analysis data — stored during OOS phase
  const [regimeCoinBars, setRegimeCoinBars] = useState<Record<string, any[]>>({});
  const [regimeOosSignals, setRegimeOosSignals] = useState<Record<string, any[]>>({});
  const [regimeIsBars, setRegimeIsBars] = useState<Record<string, any[]>>({});
  const [regimeIsSignals, setRegimeIsSignals] = useState<Record<string, any[]>>({});
  const [saveModal, setSaveModal] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingRow, setSavingRow] = useState<number|null>(null);
  // OOS market-cap filter
  const [oosTopN, setOosTopN] = useState<number | null>(null);
  const [mcapRanks, setMcapRanks] = useState<Record<string, number>>({});
  const [saveMsg, setSaveMsg] = useState("");
  const [savedStrategies, setSavedStrategies] = useState<any[]>([]);

  // Derived: OOS results filtered by market-cap top N
  const oosDisplayResults = useMemo(() => {
    if (!oosTopN || Object.keys(mcapRanks).length === 0) return oosResults;
    return oosResults.filter(r => (mcapRanks[r.coin] ?? 999) <= oosTopN);
  }, [oosResults, oosTopN, mcapRanks]);

  // Derived: OOS signals filtered to match display results
  const oosDisplaySignals = useMemo(() => {
    if (!oosTopN || Object.keys(mcapRanks).length === 0) return regimeOosSignals;
    const allowed = new Set(oosDisplayResults.map(r => r.coin));
    const filtered: Record<string, any[]> = {};
    for (const [sym, sigs] of Object.entries(regimeOosSignals)) {
      if (allowed.has(sym)) filtered[sym] = sigs;
    }
    return filtered;
  }, [regimeOosSignals, oosDisplayResults, oosTopN, mcapRanks]);

  // Load saved strategies on mount
  useEffect(() => {
    adminFetch("/api/fracmap-strategy?action=list")
      .then(r => r.json())
      .then(d => { if (d.strategies) setSavedStrategies(d.strategies); })
      .catch(() => {});
  }, []);

  // Helper: compute metrics for a set of signals
  // Sharpe is TIME-SERIES based: builds a per-bar return series (0 when flat)
  // then annualises with sqrt(barsPerYear). This avoids inflating Sharpe by
  // ignoring idle time between trades.
  function calcMetrics(sigs: any[], bm: number, totalBars?: number) {
    if (sigs.length === 0) return { sharpe: 0, winRate: 0, totalRet: 0, trades: 0, profitFactor: 0 };
    const rets = sigs.map((s: any) => s.returnPct as number);
    const winRate = rets.filter(r => r > 0).length / rets.length * 100;
    let eq = 1; for (const r of rets) eq *= (1 + r / 100);
    const grossWin = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
    const grossLoss = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));

    // Time-series Sharpe: build per-bar returns, aggregate to daily, annualize from daily
    // This avoids the sqrt(525600) inflation that makes minute-bar Sharpe meaningless
    const nBars = totalBars || (sigs.length > 0
      ? Math.max(...sigs.map((s: any) => (s.exitActualIdx ?? s.exitIdx ?? s.entryIdx + s.holdDuration) + 1))
      : 0);
    const barRets = new Float64Array(nBars); // all zeros = flat
    for (const sig of sigs) {
      const entry = sig.entryIdx;
      const exit = sig.exitActualIdx ?? sig.exitIdx ?? (entry + sig.holdDuration);
      const hold = Math.max(1, exit - entry);
      const perBar = (sig.returnPct as number) / hold;
      for (let b = entry; b < exit && b < nBars; b++) barRets[b] += perBar; // += not = to handle overlaps
    }

    // Aggregate bar returns into daily buckets (1440 minutes per day)
    const barsPerDay = Math.round(1440 / Math.max(1, bm));
    const nDays = Math.max(1, Math.ceil(nBars / barsPerDay));
    const dailyRets: number[] = [];
    for (let d = 0; d < nDays; d++) {
      const start = d * barsPerDay;
      const end = Math.min(start + barsPerDay, nBars);
      let daySum = 0;
      for (let b = start; b < end; b++) daySum += barRets[b];
      dailyRets.push(daySum);
    }

    // Sharpe from daily returns, annualized with sqrt(365)
    let dSum = 0, dSum2 = 0;
    for (const d of dailyRets) { dSum += d; dSum2 += d * d; }
    const dMean = dSum / dailyRets.length;
    const dVar = dSum2 / dailyRets.length - dMean * dMean;
    const dStd = Math.sqrt(Math.max(0, dVar));
    const sharpe = dStd > 0 ? (dMean / dStd) * Math.sqrt(365) : 0;

    return { sharpe, winRate, totalRet: (eq - 1) * 100, trades: sigs.length, profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0 };
  }

  const runScan = useCallback(async () => {
    setRunning(true);
    cancelRef.current = false;
    // In append mode, keep existing results; otherwise clear
    const prevCoinResults = appendMode ? [...coinResults] : [];
    const prevOosResults = appendMode ? [...oosResults] : [];
    const prevRegSigs = appendMode ? { ...regimeOosSignals } : {};
    const prevRegBars = appendMode ? { ...regimeCoinBars } : {};
    const existingCoins = new Set(prevCoinResults.map(cr => cr.symbol));

    if (!appendMode) {
      setCoinResults([]); setUniResults([]); setOosResults([]); setOosWinner(null);
      setRegimeOosSignals({}); setRegimeCoinBars({}); setRegimeIsSignals({}); setRegimeIsBars({});
    }

    // Figure out which coins to process
    const coinsToProcess = appendMode
      ? activeCoins.filter(c => !existingCoins.has(c))
      : activeCoins;

    if (coinsToProcess.length === 0) {
      setProgress("⚠️ All selected coins already have results. Deselect some existing coins or disable append mode.");
      setRunning(false);
      return;
    }

    setProgress(appendMode
      ? `Appending ${coinsToProcess.length} new coins to existing ${prevCoinResults.length} results...`
      : `Starting scan...`);

    // Generate minCycle thresholds: 0 (any), plus ~3 evenly spaced values within the range
    const cycleRange = cycleMax - cycleMin;
    const optMinCycles = [0];
    if (cycleRange >= 4) {
      optMinCycles.push(cycleMin + Math.round(cycleRange * 0.25));
      optMinCycles.push(cycleMin + Math.round(cycleRange * 0.5));
      optMinCycles.push(cycleMin + Math.round(cycleRange * 0.75));
    }
    const allCombos: Combo[] = [];
    for (const minStr of OPT_STRENGTHS) for (const minCyc of optMinCycles) for (const spike of OPT_SPIKE) for (const nm of OPT_NEARMISS) for (const holdDiv of OPT_HOLDDIV) {
      allCombos.push({ minStr, minCyc, spike, nearMiss: nm, holdDiv, priceExt: true, key: `s${minStr}_c${minCyc}_sp${spike?1:0}_nm${nm?1:0}_h${holdDiv}` });
    }
    setCombos(allCombos);

    // Build universal accumulator — seed with existing results in append mode
    const uniAcc: Record<string, { sharpes: number[]; winRates: number[]; totalRets: number[]; trades: number[]; coinSharpes: Record<string, number> }> = {};
    for (const c of allCombos) uniAcc[c.key] = { sharpes: [], winRates: [], totalRets: [], trades: [], coinSharpes: {} };

    if (appendMode) {
      // Seed accumulator with existing coin data
      for (const cr of prevCoinResults) {
        for (const combo of allCombos) {
          if (cr.comboSharpes[combo.key] !== undefined) {
            uniAcc[combo.key].sharpes.push(cr.comboSharpes[combo.key]);
            uniAcc[combo.key].winRates.push(cr.comboWinRates[combo.key]);
            uniAcc[combo.key].totalRets.push(cr.comboTotalRets[combo.key]);
            uniAcc[combo.key].trades.push(cr.comboTrades[combo.key]);
            uniAcc[combo.key].coinSharpes[cr.symbol] = cr.comboSharpes[combo.key];
          }
        }
      }
    }

    const allCR: CoinResult[] = [...prevCoinResults];

    // ── PASS 1: Fetch all coin bars ──────────────────────────
    const coinBarCache: Record<string, any[]> = {};

    for (let ci = 0; ci < coinsToProcess.length; ci++) {
      if (cancelRef.current) {
        setProgress(`⏹ Stopped after ${ci}/${coinsToProcess.length} coins`);
        break;
      }
      const symbol = coinsToProcess[ci];
      setProgress(`${randomMode ? "🎲 Generating random" : "Loading"} ${symbol} (${ci+1}/${coinsToProcess.length}${appendMode ? `, +${prevCoinResults.length} existing` : ""})...`);
      let coinBars: any[] = [];

      if (randomMode) {
        // ═══ Synthetic random walk ═══
        const nBars = 10500;
        const perBarVol = 0.0003;
        let price = 100;
        const t0 = Date.now() - nBars * 60000;
        for (let i = 0; i < nBars; i++) {
          const u1 = Math.random(), u2 = Math.random();
          const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          const ret = z * perBarVol;
          const open = price;
          const close = open * (1 + ret);
          const spread = Math.abs(ret) + perBarVol * 0.5 * Math.random();
          const high = Math.max(open, close) * (1 + spread * Math.random());
          const low = Math.min(open, close) * (1 - spread * Math.random());
          coinBars.push({
            time: new Date(t0 + i * 60000).toISOString(),
            open, high, low, close,
            volume: 1000 + Math.random() * 9000,
          });
          price = close;
        }
        setProgress(`🎲 Generated ${nBars} random bars for ${symbol}`);
        await new Promise(r => setTimeout(r, 0));
      } else {
        try {
          const res = await adminFetch(`/api/fracmap?action=chart&symbol=${symbol}&barMinutes=${barMinutes}&cycle=75&order=1&limit=999999`);
          const data = await res.json();
          if (data.bars?.length > 50) coinBars = data.bars.map((b: any) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }));
        } catch { continue; }
      }
      if (coinBars.length < 100) { setProgress(`${symbol} — skipped (${coinBars.length} bars)`); continue; }
      coinBarCache[symbol] = coinBars;
      await new Promise(r => setTimeout(r, 0));
    }

    // ── Determine IS eligibility based on isStartYear ────────
    const allCachedSymbols = Object.keys(coinBarCache);
    if (allCachedSymbols.length === 0) {
      setProgress("⚠️ No coins with enough data");
      setRunning(false);
      return;
    }

    const isEligible: Set<string> = new Set();
    const isExcluded: string[] = [];

    if (isStartYear === 0) {
      // OFF — all coins participate in IS (original behaviour)
      for (const sym of allCachedSymbols) isEligible.add(sym);
    } else {
      const isStartDate = new Date(`${isStartYear}-01-01T00:00:00Z`).getTime();
      for (const sym of allCachedSymbols) {
        const coinFirstBar = new Date(coinBarCache[sym][0].time).getTime();
        if (coinFirstBar <= isStartDate) {
          isEligible.add(sym);
        } else {
          isExcluded.push(sym);
        }
      }
    }

    if (isEligible.size === 0) {
      const sampleDates = allCachedSymbols.slice(0, 5).map(s => {
        const d = new Date(coinBarCache[s][0].time).toISOString().slice(0,10);
        return `${s.replace("USDT","")}: ${d}`;
      }).join(", ");
      setProgress(`⚠️ No coins have data back to ${isStartYear}-01-01. Earliest found: ${sampleDates}. Try a later year.`);
      setRunning(false);
      return;
    }

    setProgress(`IS${isStartYear > 0 ? ` from ${isStartYear}` : ""}: ${isEligible.size} coins eligible${isExcluded.length > 0 ? `, ${isExcluded.length} excluded (${isExcluded.slice(0, 8).map(s => s.replace("USDT","")).join(", ")}${isExcluded.length > 8 ? "..." : ""})` : ""}. Running optimisation...`);
    await new Promise(r => setTimeout(r, 50));

    // ── PASS 2: Run IS optimisation on eligible coins only ───
    let processedIS = 0;

    for (const symbol of allCachedSymbols) {
      if (cancelRef.current) break;
      if (!isEligible.has(symbol)) continue;

      processedIS++;
      const coinBars = coinBarCache[symbol];
      const splitIdx = Math.round(coinBars.length * splitPct / 100);
      const isBars = coinBars.slice(0, splitIdx);

      setProgress(`IS ${symbol.replace("USDT","")} (${processedIS}/${isEligible.size}${isExcluded.length > 0 ? `, ${isExcluded.length} → OOS only` : ""}) — ${isBars.length} IS bars, computing...`);

      // Server-side computation via fracmap compute API
      try {
        const res = await adminFetch("/api/fracmap/compute", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "batchScan", bars: isBars, barMinutes, cycleMin, cycleMax, combos: allCombos }),
        });
        const data = await res.json();
        if (!data.comboMetrics) { setProgress(`IS ${symbol} — compute failed`); continue; }

        const cr: CoinResult = { symbol, barsLoaded: isBars.length, comboSharpes: {}, comboWinRates: {}, comboTotalRets: {}, comboTrades: {}, bestComboKey: "", bestSharpe: -Infinity };
        for (const combo of allCombos) {
          const m = data.comboMetrics[combo.key] || { sharpe: 0, winRate: 0, totalRet: 0, trades: 0 };
          cr.comboSharpes[combo.key] = m.sharpe; cr.comboWinRates[combo.key] = m.winRate; cr.comboTotalRets[combo.key] = m.totalRet; cr.comboTrades[combo.key] = m.trades;
          if (m.sharpe > cr.bestSharpe) { cr.bestSharpe = m.sharpe; cr.bestComboKey = combo.key; }
          uniAcc[combo.key].sharpes.push(m.sharpe); uniAcc[combo.key].winRates.push(m.winRate); uniAcc[combo.key].totalRets.push(m.totalRet); uniAcc[combo.key].trades.push(m.trades); uniAcc[combo.key].coinSharpes[symbol] = m.sharpe;
        }
        allCR.push(cr); setCoinResults([...allCR]);
      } catch (e) { setProgress(`IS ${symbol} — error: ${(e as Error).message}`); continue; }
      await new Promise(r => setTimeout(r, 0));
    }
    const finals: UniResult[] = allCombos.map(c => { const a = uniAcc[c.key]; const nn = a.sharpes.length || 1; return { combo: c, avgSharpe: a.sharpes.reduce((s,v) => s+v, 0)/nn, avgWinRate: a.winRates.reduce((s,v) => s+v, 0)/nn, avgTotalRet: a.totalRets.reduce((s,v) => s+v, 0)/nn, avgTrades: a.trades.reduce((s,v) => s+v, 0)/nn, coinSharpes: a.coinSharpes, consistency: (a.sharpes.filter(s => s > 0).length / nn) * 100 }; });
    finals.sort((a, b) => b.avgSharpe - a.avgSharpe);
    setUniResults(finals);

    // ── OUT-OF-SAMPLE: run ONLY the winner on the second half ──
    const winner = finals[0]?.combo;
    if (winner) {
      setOosWinner(winner);

      // In append mode, check if winner is the same — if so, keep existing OOS and just add new coins
      const prevWinnerKey = oosWinner?.key;
      const winnerUnchanged = appendMode && prevWinnerKey === winner.key;

      if (winnerUnchanged) {
        setProgress(`Winner unchanged (${winner.key}) — keeping existing OOS, computing ${coinsToProcess.length} new coins...`);
      } else {
        setProgress(`Running out-of-sample validation with winner: ×${winner.minStr} C${winner.minCyc} ${winner.spike?"⚡":""} ${winner.nearMiss?"±":""} ÷${winner.holdDiv}...`);
      }

      const oosRows: typeof oosResults = [];
      const regSigs: Record<string, any[]> = {};
      const regBars: Record<string, any[]> = {};
      const regIsSigs: Record<string, any[]> = {};
      const regIsBars: Record<string, any[]> = {};

      if (winnerUnchanged) {
        // Keep existing OOS results for coins we didn't reprocess
        for (const r of prevOosResults) oosRows.push(r);
        Object.assign(regSigs, prevRegSigs);
        Object.assign(regBars, prevRegBars);
      }

      // Determine which coins need OOS computation
      const oosCoinsAlreadyDone = new Set(oosRows.map(r => r.coin));
      const coinsThatNeedOos: Record<string, any[]> = {};

      // New coins from this run — we have their bars in coinBarCache
      for (const symbol of Object.keys(coinBarCache)) {
        if (!oosCoinsAlreadyDone.has(symbol)) coinsThatNeedOos[symbol] = coinBarCache[symbol];
      }

      // If winner changed, we also need to re-run existing coins
      if (!winnerUnchanged && appendMode) {
        const existingOosCoins = prevOosResults.map(r => r.coin).filter(s => !coinsThatNeedOos[s]);
        for (const sym of existingOosCoins) {
          try {
            setProgress(`Re-fetching OOS data for ${sym} (winner changed)...`);
            const res = await adminFetch(`/api/fracmap?action=chart&symbol=${sym}&barMinutes=${barMinutes}&cycle=75&order=1&limit=999999`);
            const data = await res.json();
            if (data.bars?.length > 50) coinsThatNeedOos[sym] = data.bars.map((b: any) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }));
          } catch {}
        }
      }

      const oosSymbols = Object.keys(coinsThatNeedOos);
      for (let oi = 0; oi < oosSymbols.length; oi++) {
        if (cancelRef.current) { setProgress(`⏹ Stopped during OOS after ${oi}/${oosSymbols.length} coins`); break; }
        const symbol = oosSymbols[oi];
        setProgress(`OOS ${symbol} (${oi+1}/${oosSymbols.length})...`);
        await new Promise(r => setTimeout(r, 0)); // yield so progress shows
        const fullBars = coinsThatNeedOos[symbol];
        const splitIdx = Math.round(fullBars.length * splitPct / 100);
        const oosBars = fullBars.slice(splitIdx);
        if (oosBars.length < 50) continue;

        // Server-side OOS computation via fracmap compute API
        try {
          const res = await adminFetch("/api/fracmap/compute", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "computeOOS", bars: fullBars, barMinutes, cycleMin, cycleMax, splitPct, combo: winner, includeIS: true }),
          });
          const data = await res.json();
          if (!data.oosMetrics) continue;
          const m = data.oosMetrics;
          oosRows.push({ coin: symbol, bars: data.oosBarsCount || oosBars.length, trades: m.trades, sharpe: m.sharpe, winRate: m.winRate, totalRet: m.totalRet, profitFactor: m.profitFactor });
          regSigs[symbol] = data.oosSignals || [];
          regBars[symbol] = data.oosBars || oosBars;
          if (data.isSignals) regIsSigs[symbol] = data.isSignals;
          if (data.isBars) regIsBars[symbol] = data.isBars;
        } catch { continue; }
        await new Promise(r => setTimeout(r, 0)); // yield to UI thread
      }
      setProgress(`Setting OOS results (${oosRows.length} coins)...`);
      setOosResults(oosRows);
      setRegimeOosSignals(regSigs);
      setRegimeCoinBars(regBars);
      setRegimeIsSignals(regIsSigs);
      setRegimeIsBars(regIsBars);
      await new Promise(r => setTimeout(r, 50)); // let React render before heavy serialization
      try { sessionStorage.setItem("fracmap_scanner_oos", JSON.stringify({ results: oosRows, winner })); } catch {}
      try {
        // Only save signals (not bars) and cap at 2MB to avoid freezing on serialize
        const regJson = JSON.stringify({ oos: regSigs, is: regIsSigs });
        if (regJson.length < 2_000_000) sessionStorage.setItem("fracmap_scanner_regime_sigs", regJson);
      } catch (e) { /* too large, skip */ }
    }
    // Save snapshot
    const totalCoins = allCR.length;
    const snapshot: RunSnapshot = {
      barMinutes,
      cycleMin, cycleMax,
      coinResults: [...allCR],
      uniResults: finals,
      combos: allCombos,
      totalBars: allCR.reduce((s, c) => s + c.barsLoaded, 0),
      winner: finals[0] || null,
    };
    setRunHistory(prev => [...prev, snapshot]);
    setActiveRun(-1);
    setProgress(`✅ Complete${randomMode ? " 🎲 RANDOM WALK" : ""} — ${allCombos.length} combos × ${isEligible.size} IS coins (${isExcluded.length} excluded, IS from ${isStartYear})${appendMode ? ` (+${prevCoinResults.length} existing)` : ""} · ${snapshot.totalBars.toLocaleString()} total bars analysed`);
    setRunning(false);
  }, [barMinutes, splitPct, cycleMin, cycleMax, isStartYear, appendMode, randomMode, coinResults, oosResults, regimeOosSignals, regimeCoinBars]);

  // Active data: either live state or a historical snapshot
  const activeSnapshot = activeRun >= 0 ? runHistory[activeRun] : null;
  const activeCoinResults = activeSnapshot ? activeSnapshot.coinResults : coinResults;
  const activeUniResults = activeSnapshot ? activeSnapshot.uniResults : uniResults;
  const activeCombos = activeSnapshot ? activeSnapshot.combos : combos;
  const activeBarMin = activeSnapshot ? activeSnapshot.barMinutes : barMinutes;

  async function saveRow(r: any, idx: number) {
    setSavingRow(idx);
    try {
      const nm = `V${idx+1} ×${r.combo.minStr} C≥${r.combo.minCyc||"∞"} ${r.combo.spike?"⚡":"–"} ${r.combo.nearMiss?"±":"–"} ÷${r.combo.holdDiv}`;
      const res = await adminFetch("/api/fracmap-strategy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "saveStrategy", name: nm, type: "universal", barMinutes: activeBarMin,
          minStr: r.combo.minStr, minCyc: r.combo.minCyc, spike: r.combo.spike,
          nearMiss: r.combo.nearMiss, holdDiv: r.combo.holdDiv, priceExt: true,
          isSharpe: r.avgSharpe, oosSharpe: null, winRate: r.avgWinRate,
          profitFactor: null, consistency: r.consistency,
          totalTrades: Math.round(r.avgTrades * activeCoinResults.length),
          splitPct, cycleMin, cycleMax,
        })
      });
      const d = await res.json();
      if (d.strategy) {
        const r2 = await adminFetch("/api/fracmap-strategy?action=list"); const d2 = await r2.json();
        if (d2.strategies) setSavedStrategies(d2.strategies);
      }
    } catch {}
    setSavingRow(null);
  }

  const sorted = [...activeUniResults].sort((a, b) => metric === "sharpe" ? b.avgSharpe - a.avgSharpe : metric === "winRate" ? b.avgWinRate - a.avgWinRate : b.avgTotalRet - a.avgTotalRet);
  const maxAbs = activeUniResults.length > 0 ? Math.max(...activeUniResults.map(r => Math.abs(r.avgSharpe)), 0.01) : 1;
  const selData = activeCoinResults.find(c => c.symbol === selectedCoin);
  const coinMaxAbs = selData ? Math.max(...Object.values(selData.comboSharpes).map(Math.abs), 0.01) : 1;

  return (
    <div>
      {/* Header */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="text-2xl mt-0.5" style={{ color: GOLD }}>⚙</div>
          <div>
            <div className="text-sm font-semibold mb-1">Fracmap Strategy Scanner</div>
            <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              Backtests <strong>{OPT_STRENGTHS.length * 4 * OPT_SPIKE.length * OPT_NEARMISS.length * OPT_HOLDDIV.length} strategy combinations</strong> (PxExt 📍 always on) across <strong>{activeCoins.length} coins</strong>.
              Core model: cycles {cycleMin}–{cycleMax}, step 1, all 6 φ orders.
              Data is split: <strong style={{ color: "#a78bfa" }}>first {splitPct}% for optimisation</strong>, remaining <strong style={{ color: "#a78bfa" }}>{100 - splitPct}% for out-of-sample validation</strong>.
              The winning combo is tested on unseen data to verify the edge is real.
              Coins must have data back to <strong style={{ color: "#a78bfa" }}>{isStartYear}</strong> to participate in IS — newer coins are validated in OOS only.
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 mt-3 pt-3 border-t border-[var(--border)]">
          <span className="text-[9px] font-mono text-[var(--text-dim)] mr-1">COINS:</span>
          <button onClick={() => setExcludedCoins(new Set())} disabled={running}
            className="px-1.5 py-0.5 rounded text-[8px] font-mono font-bold border transition-all mr-0.5"
            style={{ background: GOLD_DIM, borderColor: GOLD + "40", color: GOLD }}>ALL</button>
          <button onClick={() => setExcludedCoins(new Set(allCoins))} disabled={running}
            className="px-1.5 py-0.5 rounded text-[8px] font-mono font-bold border transition-all mr-1"
            style={{ background: "transparent", borderColor: "var(--border)", color: "var(--text-dim)" }}>NONE</button>
          {allCoins.map(c => {
            const excluded = excludedCoins.has(c);
            return <button key={c} onClick={() => { const next = new Set(excludedCoins); if (excluded) next.delete(c); else next.add(c); setExcludedCoins(next); }} disabled={running}
              className="px-1.5 py-0.5 rounded text-[8px] font-mono border transition-all"
              style={{ opacity: excluded ? 0.3 : 1, background: excluded ? "transparent" : GOLD_DIM, borderColor: excluded ? "var(--border)" : GOLD + "40", color: excluded ? "var(--text-dim)" : GOLD, textDecoration: excluded ? "line-through" : "none" }}>
              {c.replace("USDT","")}
            </button>;
          })}
          <span className="text-[8px] font-mono text-[var(--text-dim)] ml-2">{activeCoins.length}/{allCoins.length} active</span>
        </div>
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-[var(--border)]">
          <span className="text-[9px] font-mono text-[var(--text-dim)]">BAR SIZE:</span>
          {[1, 5, 15, 60, 1440].map(m => (
            <button key={m} onClick={() => setBarMinutes(m)} disabled={running}
              className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{ background: barMinutes === m ? GOLD_DIM : "transparent", borderColor: barMinutes === m ? GOLD + "40" : "var(--border)", color: barMinutes === m ? GOLD : "var(--text-dim)" }}>{m === 60 ? "1H" : m === 1440 ? "1D" : m + "m"}</button>
          ))}

          <div className="w-px h-5 bg-[var(--border)] opacity-30" />

          <span className="text-[9px] font-mono text-[var(--text-dim)]">IN-SAMPLE:</span>
          {[10, 20, 30, 50, 60, 70].map(p => (
            <button key={p} onClick={() => setSplitPct(p)} disabled={running}
              className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{ background: splitPct === p ? "rgba(167,139,250,0.12)" : "transparent", borderColor: splitPct === p ? "#a78bfa40" : "var(--border)", color: splitPct === p ? "#a78bfa" : "var(--text-dim)" }}>{p}%</button>
          ))}
          <span className="text-[8px] font-mono text-[var(--text-dim)]">→ {100 - splitPct}% OOS {splitPct <= 20 && "⚡ fast test"}</span>

          <div className="w-px h-5 bg-[var(--border)] opacity-30" />

          <span className="text-[9px] font-mono text-[var(--text-dim)]">CYCLES:</span>
          <input type="number" value={cycleMin} onChange={e => setCycleMin(+e.target.value || 0)}
            onBlur={() => setCycleMin(Math.max(2, Math.min(cycleMax - 1, cycleMin)))} disabled={running}
            className="w-10 px-1 py-0.5 rounded text-[9px] font-mono font-semibold border text-center bg-transparent"
            style={{ borderColor: GOLD + "40", color: GOLD }} />
          <span className="text-[8px] font-mono text-[var(--text-dim)]">–</span>
          <input type="number" value={cycleMax} onChange={e => setCycleMax(+e.target.value || 0)}
            onBlur={() => setCycleMax(Math.max(cycleMin + 1, Math.min(200, cycleMax)))} disabled={running}
            className="w-10 px-1 py-0.5 rounded text-[9px] font-mono font-semibold border text-center bg-transparent"
            style={{ borderColor: GOLD + "40", color: GOLD }} />

          <div className="w-px h-5 bg-[var(--border)] opacity-30" />

          <span className="text-[9px] font-mono text-[var(--text-dim)]">OOS TOP:</span>
          <input type="number" value={oosTopN ?? ""} placeholder="All"
            onChange={e => { const v = e.target.value; setOosTopN(v === "" ? null : +v); }}
            onBlur={() => { if (oosTopN != null) setOosTopN(Math.max(5, Math.min(200, oosTopN))); }} disabled={running}
            className="w-12 px-1 py-0.5 rounded text-[9px] font-mono font-semibold border text-center bg-transparent"
            style={{ borderColor: oosTopN ? "#22c55e40" : "var(--border)", color: oosTopN ? "#22c55e" : "var(--text-dim)" }} />
          <span className="text-[8px] font-mono text-[var(--text-dim)]">{oosTopN ? `top ${oosTopN} by mcap` : "all coins"}</span>

          <div className="flex-1" />
          <span className="text-[9px] font-mono text-[var(--text-dim)]">{activeCoins.length} coins × {combos.length || 320} combos = {(activeCoins.length * (combos.length || 320)).toLocaleString()} backtests</span>
        </div>
        <div className="flex items-center gap-4 mt-2 pt-2 border-t border-[var(--border)]">
          <span className="text-[9px] font-mono text-[var(--text-dim)]">IS FROM:</span>
          {[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 0].map(y => (
            <button key={y} onClick={() => setIsStartYear(y)} disabled={running}
              className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold border transition-all"
              style={{ background: isStartYear === y ? (y === 0 ? "rgba(239,68,68,0.12)" : "rgba(167,139,250,0.12)") : "transparent", borderColor: isStartYear === y ? (y === 0 ? "#ef444440" : "#a78bfa40") : "var(--border)", color: isStartYear === y ? (y === 0 ? "#ef4444" : "#a78bfa") : "var(--text-dim)" }}>{y === 0 ? "OFF" : y}</button>
          ))}
          <span className="text-[8px] font-mono text-[var(--text-dim)]">{isStartYear === 0 ? "All coins participate in IS (original behaviour)" : `Coins without data back to ${isStartYear} are excluded from IS but still tested in OOS`}</span>
        </div>
        <div className="flex items-center gap-3 mt-2 pt-2 border-t border-[var(--border)]">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={randomMode} onChange={e => setRandomMode(e.target.checked)} disabled={running}
              className="w-3 h-3 accent-[#ef4444] cursor-pointer" />
            <span className="text-[9px] font-mono" style={{ color: randomMode ? "#ef4444" : "var(--text-dim)" }}>
              🎲 Random Walk
            </span>
          </label>
          {coinResults.length > 0 && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={appendMode} onChange={e => setAppendMode(e.target.checked)} disabled={running}
                className="w-3 h-3 accent-[#D4A843] cursor-pointer" />
              <span className="text-[9px] font-mono" style={{ color: appendMode ? GOLD : "var(--text-dim)" }}>
                ＋ Append ({coinResults.length} existing)
              </span>
            </label>
          )}
          <div className="flex-1" />
          <button onClick={runScan} disabled={running}
            className="px-5 py-2 rounded text-[11px] font-mono font-bold tracking-wider transition-all disabled:opacity-40"
            style={{ background: running ? "transparent" : randomMode ? "#ef4444" : GOLD, color: running ? (randomMode ? "#ef4444" : GOLD) : "#000", border: `1px solid ${randomMode ? "#ef4444" : GOLD}` }}>
            {running ? "⏳ SCANNING..." : randomMode ? "🎲 RANDOM" : "▶ RUN SCAN"}
          </button>
          {running && <button onClick={() => { cancelRef.current = true; }}
            className="px-4 py-2 rounded text-[11px] font-mono font-bold tracking-wider transition-all"
            style={{ background: "#ef4444", color: "#fff", border: "1px solid #ef4444" }}>
            ⏹ STOP
          </button>}
        </div>
        {progress && <div className="text-[10px] font-mono mt-2 pt-2 border-t border-[var(--border)]" style={{ color: progress.startsWith("✅") ? "#22c55e" : "var(--text-dim)" }}>{progress}</div>}

        {/* Run history tabs */}
        {runHistory.length > 0 && (
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--border)]">
            <span className="text-[8px] font-mono text-[var(--text-dim)]">RUNS:</span>
            {runHistory.map((snap, idx) => (
              <button key={idx} onClick={() => { setActiveRun(idx); }}
                className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold border transition-all"
                style={{
                  background: (activeRun === idx || (activeRun === -1 && idx === runHistory.length - 1)) ? GOLD_DIM : "transparent",
                  borderColor: (activeRun === idx || (activeRun === -1 && idx === runHistory.length - 1)) ? GOLD + "40" : "var(--border)",
                  color: (activeRun === idx || (activeRun === -1 && idx === runHistory.length - 1)) ? GOLD : "var(--text-dim)",
                }}>
                {snap.barMinutes}m · {snap.cycleMin||5}–{snap.cycleMax||20}c · SR {snap.winner?.avgSharpe.toFixed(2) || "–"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Running — live coin cards */}
      {running && coinResults.length > 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
          <div className="text-[10px] font-mono font-semibold mb-2" style={{ color: GOLD }}>SCANNED</div>
          <div className="grid grid-cols-5 gap-2">
            {coinResults.map(cr => (
              <div key={cr.symbol} className="p-2 rounded border border-[var(--border)]">
                <div className="text-[10px] font-mono font-bold text-[var(--text)]">{cr.symbol.replace("USDT","")}</div>
                <div className="text-[8px] font-mono text-[var(--text-dim)]">{cr.barsLoaded} bars</div>
                <div className="text-[9px] font-mono font-semibold mt-0.5 tabular-nums" style={{ color: cr.bestSharpe > 0 ? "#22c55e" : "#ef4444" }}>Best SR: {cr.bestSharpe.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeUniResults.length > 0 && (<>
        {/* Winner */}
        <div className="bg-[var(--bg-card)] border-2 rounded-lg p-4 mb-4" style={{ borderColor: GOLD + "60" }}>
          <div className="flex items-center gap-4">
            <span className="text-xl">🏆</span>
            <div>
              <div className="text-[10px] font-mono font-bold" style={{ color: GOLD }}>BEST UNIVERSAL STRATEGY</div>
              <div className="text-[12px] font-mono font-semibold text-[var(--text)] mt-0.5">
                Str ×{sorted[0].combo.minStr} · MinCyc {sorted[0].combo.minCyc === 0 ? "Any" : `≥${sorted[0].combo.minCyc}`} · Spike {sorted[0].combo.spike ? "⚡ On" : "Off"} · ±1 {sorted[0].combo.nearMiss ? "On" : "Off"} · PxExt 📍 · Hold ÷{sorted[0].combo.holdDiv}
              </div>
            </div>
            <div className="flex-1" />
            <div className="text-right"><div className="text-[9px] font-mono text-[var(--text-dim)]">Sharpe</div><div className="text-[18px] font-mono font-bold tabular-nums" style={{ color: sorted[0].avgSharpe > 0 ? "#22c55e" : "#ef4444" }}>{sorted[0].avgSharpe.toFixed(3)}</div></div>
            <div className="text-right"><div className="text-[9px] font-mono text-[var(--text-dim)]">Consistency</div><div className="text-[18px] font-mono font-bold tabular-nums" style={{ color: sorted[0].consistency > 70 ? "#22c55e" : "#eab308" }}>{sorted[0].consistency.toFixed(0)}%</div></div>
            <div className="text-right"><div className="text-[9px] font-mono text-[var(--text-dim)]">Win %</div><div className="text-[18px] font-mono font-bold tabular-nums" style={{ color: sorted[0].avgWinRate > 55 ? "#22c55e" : "#eab308" }}>{sorted[0].avgWinRate.toFixed(1)}%</div></div>
            <button onClick={() => {
              const exportData = {
                timestamp: new Date().toISOString(),
                barMinutes: activeBarMin,
                splitPct,
                winner: { str: sorted[0].combo.minStr, minCyc: sorted[0].combo.minCyc, spike: sorted[0].combo.spike, nearMiss: sorted[0].combo.nearMiss, holdDiv: sorted[0].combo.holdDiv, avgSharpe: sorted[0].avgSharpe, consistency: sorted[0].consistency, avgWinRate: sorted[0].avgWinRate, avgTotalRet: sorted[0].avgTotalRet },
                inSample: activeCoinResults.map(cr => ({ coin: cr.symbol, bars: cr.barsLoaded, bestSharpe: cr.bestSharpe, bestCombo: cr.bestComboKey })),
                oos: oosResults.map(r => ({ ...r })),
                heatmap: sorted.slice(0, 30).map(r => ({ combo: r.combo.key, avgSharpe: +r.avgSharpe.toFixed(4), consistency: +r.consistency.toFixed(1), avgWinRate: +r.avgWinRate.toFixed(2), avgTotalRet: +r.avgTotalRet.toFixed(4), coinSharpes: r.coinSharpes })),
              };
              const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url;
              a.download = `fracmap-scan-${activeBarMin}m-${new Date().toISOString().slice(0,10)}.json`;
              a.click(); URL.revokeObjectURL(url);
            }}
              className="px-3 py-1.5 rounded text-[9px] font-mono font-semibold border transition-all ml-2"
              style={{ borderColor: GOLD + "40", color: GOLD }}>
              💾 EXPORT
            </button>
            <button onClick={() => { setSaveName(`Universal ${activeBarMin}m`); setSaveMsg(""); setSaveModal(true); }}
              className="px-3 py-1.5 rounded text-[9px] font-mono font-bold border transition-all"
              style={{ background: "#22c55e18", borderColor: "#22c55e40", color: "#22c55e" }}>
              💾 SAVE TO DB
            </button>
            <button onClick={async () => {
              try {
                const avgSR = oosResults.reduce((s,r) => s+r.sharpe, 0) / oosResults.length;
                const avgWR = oosResults.reduce((s,r) => s+r.winRate, 0) / oosResults.length;
                const avgRet = oosResults.reduce((s,r) => s+r.totalRet, 0) / oosResults.length;
                const avgPF = oosResults.reduce((s,r) => s+(isFinite(r.profitFactor)?r.profitFactor:0), 0) / oosResults.length;
                const posCount = oosResults.filter(r => r.sharpe > 0).length;
                await fetch("/api/research-log", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    report_type: "hourly_scan",
                    title: `Scan ${activeBarMin}m · SR ${avgSR.toFixed(2)} · ${new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}`,
                    winner_strategy: sorted[0] ? { minStr: sorted[0].combo.minStr, minCyc: sorted[0].combo.minCyc, spike: sorted[0].combo.spike, nearMiss: sorted[0].combo.nearMiss, holdDiv: sorted[0].combo.holdDiv } : null,
                    oos_avg_sharpe: avgSR, oos_consistency: `${posCount}/${oosResults.length}`,
                    oos_avg_winrate: avgWR, oos_avg_pf: avgPF, oos_avg_return: avgRet,
                    per_coin_oos: oosResults.map(r => ({ coin: r.coin, sharpe: r.sharpe, winRate: r.winRate, totalRet: r.totalRet, pf: r.profitFactor, trades: r.trades })),
                    bar_minutes: activeBarMin, split_pct: splitPct, total_signals: oosResults.reduce((s,r) => s+r.trades, 0),
                  })
                });
                alert("✅ Logged to Research");
              } catch(e: any) { alert("❌ " + e.message); }
            }}
              className="px-3 py-1.5 rounded text-[9px] font-mono font-bold border transition-all"
              style={{ background: "#06b6d418", borderColor: "#06b6d440", color: "#06b6d4" }}>
              📋 LOG TO RESEARCH
            </button>
          </div>
        </div>

        {/* Out-of-Sample Results */}
        {oosResults.length > 0 && oosWinner && (
          <div className="bg-[var(--bg-card)] border-2 rounded-lg p-4 mb-4" style={{ borderColor: "#a78bfa60" }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[11px] font-mono font-bold" style={{ color: "#a78bfa" }}>📊 OUT-OF-SAMPLE VALIDATION ({100 - splitPct}% unseen data)</span>
              {oosTopN && Object.keys(mcapRanks).length > 0 && oosDisplayResults.length < oosResults.length && (
                <span className="px-2 py-0.5 rounded text-[8px] font-mono font-bold" style={{ background: "rgba(34,197,94,0.1)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)" }}>
                  Top {oosTopN} by mcap ({oosDisplayResults.length}/{oosResults.length} coins)
                </span>
              )}
              <span className="text-[9px] font-mono text-[var(--text-dim)]">
                Winner tested on data it was never optimised on
              </span>
            </div>

            {/* OOS Summary */}
            {(() => {
              const dr = oosDisplayResults;
              const avgSR = dr.reduce((s, r) => s + r.sharpe, 0) / dr.length;
              const avgWR = dr.reduce((s, r) => s + r.winRate, 0) / dr.length;
              const avgRet = dr.reduce((s, r) => s + r.totalRet, 0) / dr.length;
              const avgPF = dr.reduce((s, r) => s + (isFinite(r.profitFactor) ? r.profitFactor : 0), 0) / dr.length;
              const posCount = dr.filter(r => r.sharpe > 0).length;
              return (
                <div className="flex gap-6 mb-3 p-3 rounded-lg border border-[var(--border)]" style={{ background: "rgba(167,139,250,0.04)" }}>
                  <div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">OOS Avg Sharpe</div>
                    <div className="text-[16px] font-mono font-bold tabular-nums" style={{ color: avgSR > 0 ? "#22c55e" : "#ef4444" }}>{avgSR.toFixed(3)}</div>
                  </div>
                  <div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">vs In-Sample</div>
                    <div className="text-[16px] font-mono font-bold tabular-nums" style={{ color: avgSR > 0 ? "#22c55e" : "#ef4444" }}>
                      {sorted[0] ? `${((avgSR / sorted[0].avgSharpe) * 100).toFixed(0)}%` : "–"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">OOS Consistency</div>
                    <div className="text-[16px] font-mono font-bold tabular-nums" style={{ color: posCount / dr.length > 0.6 ? "#22c55e" : "#eab308" }}>
                      {posCount}/{dr.length} positive
                    </div>
                  </div>
                  <div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">OOS Win %</div>
                    <div className="text-[16px] font-mono font-bold tabular-nums" style={{ color: avgWR > 55 ? "#22c55e" : "#eab308" }}>{avgWR.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">OOS Avg Ret</div>
                    <div className="text-[16px] font-mono font-bold tabular-nums" style={{ color: avgRet > 0 ? "#22c55e" : "#ef4444" }}>{avgRet > 0 ? "+" : ""}{avgRet.toFixed(2)}%</div>
                  </div>
                  <div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">Profit Factor</div>
                    <div className="text-[16px] font-mono font-bold tabular-nums" style={{ color: avgPF > 1 ? "#22c55e" : "#ef4444" }}>{avgPF.toFixed(2)}</div>
                  </div>
                </div>
              );
            })()}

            {/* OOS per-coin table */}
            <table className="w-full text-[9px] font-mono border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-1.5 py-1 text-left text-[var(--text-dim)] font-normal">Coin</th>
                  <th className="px-1.5 py-1 text-right text-[var(--text-dim)] font-normal">OOS Bars</th>
                  <th className="px-1.5 py-1 text-right text-[var(--text-dim)] font-normal">Trades</th>
                  <th className="px-1.5 py-1 text-right font-semibold" style={{ color: "#a78bfa" }}>Sharpe</th>
                  <th className="px-1.5 py-1 text-right text-[var(--text-dim)] font-normal">Win %</th>
                  <th className="px-1.5 py-1 text-right text-[var(--text-dim)] font-normal">Total Ret</th>
                  <th className="px-1.5 py-1 text-right text-[var(--text-dim)] font-normal">PF</th>
                  <th className="px-2 py-1 text-left text-[var(--text-dim)] font-normal">IS → OOS</th>
                </tr>
              </thead>
              <tbody>
                {[...oosDisplayResults].sort((a, b) => b.sharpe - a.sharpe).map(r => {
                  const isSharpe = sorted[0]?.coinSharpes[r.coin] || 0;
                  const decay = isSharpe !== 0 ? ((r.sharpe / isSharpe) * 100) : 0;
                  const mcapRank = mcapRanks[r.coin];
                  return (
                    <tr key={r.coin} className="border-b border-[var(--border)] border-opacity-20">
                      <td className="px-1.5 py-1 font-semibold">{r.coin.replace("USDT","")}{mcapRank ? <span className="text-[7px] text-[var(--text-dim)] ml-1">#{mcapRank}</span> : ""}</td>
                      <td className="px-1.5 py-1 text-right text-[var(--text-dim)] tabular-nums">{r.bars.toLocaleString()}</td>
                      <td className="px-1.5 py-1 text-right text-[var(--text-dim)] tabular-nums">{r.trades}</td>
                      <td className="px-1.5 py-1 text-right font-semibold tabular-nums" style={{ color: r.sharpe > 0 ? "#22c55e" : "#ef4444", background: sharpeColor(r.sharpe, Math.max(...oosDisplayResults.map(x => Math.abs(x.sharpe)), 0.01)) }}>{r.sharpe.toFixed(3)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: r.winRate > 55 ? "#22c55e" : "#eab308" }}>{r.winRate.toFixed(1)}%</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: r.totalRet > 0 ? "#22c55e" : "#ef4444" }}>{r.totalRet > 0 ? "+" : ""}{r.totalRet.toFixed(2)}%</td>
                      <td className="px-1.5 py-1 text-right tabular-nums" style={{ color: (r.profitFactor ?? 0) > 1 ? "#22c55e" : "#ef4444" }}>{r.profitFactor != null && isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "–"}</td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1">
                          <span className="tabular-nums" style={{ color: isSharpe > 0 ? "#22c55e80" : "#ef444480" }}>{isSharpe.toFixed(1)}</span>
                          <span className="text-[var(--text-dim)]">→</span>
                          <span className="tabular-nums" style={{ color: r.sharpe > 0 ? "#22c55e" : "#ef4444" }}>{r.sharpe.toFixed(1)}</span>
                          <span className="text-[7px] tabular-nums" style={{ color: decay > 80 ? "#22c55e" : decay > 40 ? "#eab308" : "#ef4444" }}>
                            ({decay > 0 ? decay.toFixed(0) : "–"}%)
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="mt-2 text-[8px] font-mono text-[var(--text-dim)]">
              IS → OOS column shows in-sample Sharpe → out-of-sample Sharpe with retention %. Over 60% retention suggests a robust edge, not overfitting.
            </div>
          </div>
        )}

        {/* Regime Analysis — uses OOS signals and bar data */}
        {oosResults.length > 0 && Object.keys(regimeOosSignals).length > 0 && (
          <div className="mb-4">
            <RegimeAnalysis
              coinBarData={regimeCoinBars}
              oosSignals={regimeOosSignals}
              isBarData={regimeIsBars}
              isSignals={regimeIsSignals}
              barMinutes={activeBarMin}
            />
          </div>
        )}

        {/* Cumulative Returns + Net Position + Worst Trade Analysis */}
        {oosResults.length > 0 && Object.keys(regimeOosSignals).length > 0 && (
          <ScannerExtras oosSignals={oosDisplaySignals} oosResults={oosDisplayResults} />
        )}

        {/* Hedged Strategy — pairs opposite signals for market-neutral exposure */}
        {oosResults.length > 0 && Object.keys(regimeOosSignals).length > 0 && (
          <HedgedStrategy
            oosSignals={regimeOosSignals}
            oosResults={oosResults}
            oosBars={regimeCoinBars}
            barMinutes={activeBarMin}
            splitPct={splitPct}
            cycleMin={cycleMin}
            cycleMax={cycleMax}
            winnerCombo={sorted[0]?.combo || null}
          />
        )}

        {/* Controls */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3 mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            {(["universal","coins"] as const).map(v => (
              <button key={v} onClick={() => setView(v)} className="px-3 py-1 rounded text-[10px] font-mono font-semibold border transition-all"
                style={{ background: view === v ? GOLD_DIM : "transparent", borderColor: view === v ? GOLD + "40" : "var(--border)", color: view === v ? GOLD : "var(--text-dim)" }}>
                {v === "universal" ? "🌍 Universal Heatmap" : "🪙 Per-Coin Heatmaps"}
              </button>
            ))}
            <div className="w-px h-6 bg-[var(--border)] opacity-30" />
            <span className="text-[9px] font-mono text-[var(--text-dim)]">Sort:</span>
            {(["sharpe","winRate","totalRet"] as const).map(m => (
              <button key={m} onClick={() => setMetric(m)} className="px-2 py-0.5 rounded text-[9px] font-mono font-semibold border transition-all"
                style={{ background: metric === m ? GOLD_DIM : "transparent", borderColor: metric === m ? GOLD + "40" : "var(--border)", color: metric === m ? GOLD : "var(--text-dim)" }}>
                {m === "sharpe" ? "Sharpe" : m === "winRate" ? "Win %" : "Ret"}
              </button>
            ))}
            <div className="flex-1" />
            <span className="text-[9px] font-mono text-[var(--text-dim)]">Show:</span>
            {[20,50,100,320].map(n => (
              <button key={n} onClick={() => setShowTop(n)} className="px-2 py-0.5 rounded text-[9px] font-mono border transition-all"
                style={{ background: showTop === n ? GOLD_DIM : "transparent", borderColor: showTop === n ? GOLD + "40" : "var(--border)", color: showTop === n ? GOLD : "var(--text-dim)" }}>
                {n === 320 ? "All" : n}
              </button>
            ))}
          </div>
        </div>

        {/* Universal Heatmap */}
        {view === "universal" && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4 overflow-x-auto">
            <div className="text-[10px] font-mono font-semibold mb-3" style={{ color: GOLD }}>UNIVERSAL HEATMAP — Avg Sharpe across {activeCoinResults.length} coins</div>
            <table className="w-full text-[9px] font-mono border-collapse" style={{ minWidth: 800 + activeCoinResults.length * 40 }}>
              <thead>
                <tr>
                  <th className="px-1 py-1 text-left text-[var(--text-dim)] font-normal sticky left-0 bg-[var(--bg-card)] z-10">#</th>
                  <th className="px-1 py-1 text-center text-[var(--text-dim)] font-normal">Str</th>
                  <th className="px-1 py-1 text-center text-[var(--text-dim)] font-normal">Cyc</th>
                  <th className="px-1 py-1 text-center text-[var(--text-dim)] font-normal">Spk</th>
                  <th className="px-1 py-1 text-center text-[var(--text-dim)] font-normal">±1</th>
                  <th className="px-1 py-1 text-center text-[var(--text-dim)] font-normal">Hld</th>
                  <th className="px-1.5 py-1 text-right font-semibold" style={{ color: GOLD }}>SR</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">Con</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">W%</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">Ret</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">T</th>
                  <th className="px-0.5 py-1 text-center text-[var(--text-dim)] font-normal" style={{fontSize:7}}>💾</th>
                  {activeCoinResults.map(cr => <th key={cr.symbol} className="px-0.5 py-1 text-center text-[var(--text-dim)] font-normal" style={{ minWidth: 36, fontSize: 7 }}>{cr.symbol.replace("USDT","")}</th>)}
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, showTop).map((r, idx) => (
                  <tr key={r.combo.key} className="hover:brightness-110" style={{ background: idx === 0 ? GOLD_DIM : "transparent" }}>
                    <td className="px-1 py-0.5 text-[var(--text-dim)] sticky left-0 bg-[var(--bg-card)]">{idx+1}</td>
                    <td className="px-1 py-0.5 text-center">×{r.combo.minStr}</td>
                    <td className="px-1 py-0.5 text-center">{r.combo.minCyc === 0 ? "∞" : `≥${r.combo.minCyc}`}</td>
                    <td className="px-1 py-0.5 text-center">{r.combo.spike ? "⚡" : "–"}</td>
                    <td className="px-1 py-0.5 text-center">{r.combo.nearMiss ? "±" : "–"}</td>
                    <td className="px-1 py-0.5 text-center">÷{r.combo.holdDiv}</td>
                    <td className="px-1.5 py-0.5 text-right font-semibold tabular-nums" style={{ color: r.avgSharpe > 0 ? "#22c55e" : "#ef4444", background: sharpeColor(r.avgSharpe, maxAbs) }}>{r.avgSharpe.toFixed(2)}</td>
                    <td className="px-1 py-0.5 text-right tabular-nums" style={{ color: r.consistency > 70 ? "#22c55e" : r.consistency > 50 ? "#eab308" : "#ef4444" }}>{r.consistency.toFixed(0)}</td>
                    <td className="px-1 py-0.5 text-right tabular-nums" style={{ color: r.avgWinRate > 55 ? "#22c55e" : "#eab308" }}>{r.avgWinRate.toFixed(1)}</td>
                    <td className="px-1 py-0.5 text-right tabular-nums" style={{ color: r.avgTotalRet > 0 ? "#22c55e" : "#ef4444" }}>{r.avgTotalRet > 0 ? "+" : ""}{r.avgTotalRet.toFixed(1)}</td>
                    <td className="px-1 py-0.5 text-right text-[var(--text-dim)] tabular-nums">{r.avgTrades.toFixed(0)}</td>
                    <td className="px-0.5 py-0.5 text-center"><button onClick={() => saveRow(r, idx)} disabled={savingRow !== null}
                      className="text-[8px] hover:brightness-150 transition-all disabled:opacity-30" title="Save to DB">{savingRow === idx ? "⏳" : "💾"}</button></td>
                    {activeCoinResults.map(cr => {
                      const v = r.coinSharpes[cr.symbol] || 0;
                      return <td key={cr.symbol} className="px-0 py-0.5 text-center tabular-nums" style={{ background: sharpeColor(v, maxAbs), color: v > 0 ? "#22c55e" : v < 0 ? "#ef4444" : "var(--text-dim)", fontSize: 7 }}>{v !== 0 ? v.toFixed(1) : "–"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Per-Coin View */}
        {view === "coins" && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
            <div className="text-[10px] font-mono font-semibold mb-3" style={{ color: GOLD }}>SELECT COIN — individual optimal settings (⚠ may overfit)</div>
            <div className="grid grid-cols-5 gap-2 mb-4">
              {activeCoinResults.map(cr => {
                const bc = activeCombos.find(c => c.key === cr.bestComboKey);
                return (
                  <button key={cr.symbol} onClick={() => setSelectedCoin(cr.symbol)} className="p-2.5 rounded-lg border transition-all text-left"
                    style={{ background: selectedCoin === cr.symbol ? GOLD_DIM : "transparent", borderColor: selectedCoin === cr.symbol ? GOLD + "60" : "var(--border)" }}>
                    <div className="text-[11px] font-mono font-bold" style={{ color: selectedCoin === cr.symbol ? GOLD : "var(--text)" }}>{cr.symbol.replace("USDT","")}</div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">{cr.barsLoaded.toLocaleString()} bars</div>
                    <div className="text-[10px] font-mono font-semibold mt-1 tabular-nums" style={{ color: cr.bestSharpe > 0 ? "#22c55e" : "#ef4444" }}>SR {cr.bestSharpe.toFixed(2)}</div>
                    {bc && <div className="text-[7px] font-mono text-[var(--text-dim)] mt-0.5">×{bc.minStr} C{bc.minCyc||"∞"} {bc.spike?"⚡":"–"} {bc.nearMiss?"±":"–"} {bc.priceExt?"📍":"–"} ÷{bc.holdDiv}</div>}
                  </button>
                );
              })}
            </div>
            {selData && (
              <div className="border-t border-[var(--border)] pt-4">
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-[11px] font-mono font-bold" style={{ color: GOLD }}>{selectedCoin?.replace("USDT","")} HEATMAP</span>
                  <span className="text-[9px] font-mono text-[var(--text-dim)]">{selData.barsLoaded.toLocaleString()} bars · Best SR: {selData.bestSharpe.toFixed(3)}</span>
                  <div className="flex-1" />
                  {sorted[0] && <span className="text-[8px] font-mono text-[var(--text-dim)]">Universal best highlighted in green border</span>}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[9px] font-mono border-collapse">
                    <thead>
                      <tr>
                        <th className="px-1.5 py-1 text-left text-[var(--text-dim)] font-normal">#</th>
                        <th className="px-1.5 py-1 text-center text-[var(--text-dim)] font-normal">Str</th>
                        <th className="px-1.5 py-1 text-center text-[var(--text-dim)] font-normal">Cyc</th>
                        <th className="px-1.5 py-1 text-center text-[var(--text-dim)] font-normal">Spk</th>
                        <th className="px-1.5 py-1 text-center text-[var(--text-dim)] font-normal">±1</th>
                        <th className="px-1.5 py-1 text-center text-[var(--text-dim)] font-normal">Hld</th>
                        <th className="px-2 py-1 text-right font-semibold" style={{ color: GOLD }}>Sharpe</th>
                        <th className="px-2 py-1 text-right text-[var(--text-dim)] font-normal">Win %</th>
                        <th className="px-2 py-1 text-right text-[var(--text-dim)] font-normal">Total Ret</th>
                        <th className="px-2 py-1 text-right text-[var(--text-dim)] font-normal">Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeCombos.map(c => ({ combo: c, sharpe: selData.comboSharpes[c.key]||0, winRate: selData.comboWinRates[c.key]||0, totalRet: selData.comboTotalRets[c.key]||0, trades: selData.comboTrades[c.key]||0 }))
                        .sort((a, b) => metric === "sharpe" ? b.sharpe - a.sharpe : metric === "winRate" ? b.winRate - a.winRate : b.totalRet - a.totalRet)
                        .slice(0, showTop).map((r, idx) => (
                        <tr key={r.combo.key} style={{ background: idx === 0 ? GOLD_DIM : "transparent", outline: r.combo.key === sorted[0]?.combo.key ? "1px solid #22c55e40" : "none" }}>
                          <td className="px-1.5 py-0.5 text-[var(--text-dim)]">{idx+1}</td>
                          <td className="px-1.5 py-0.5 text-center">×{r.combo.minStr}</td>
                          <td className="px-1.5 py-0.5 text-center">{r.combo.minCyc === 0 ? "∞" : `≥${r.combo.minCyc}`}</td>
                          <td className="px-1.5 py-0.5 text-center">{r.combo.spike ? "⚡" : "–"}</td>
                          <td className="px-1.5 py-0.5 text-center">{r.combo.nearMiss ? "±" : "–"}</td>
                          <td className="px-1.5 py-0.5 text-center">÷{r.combo.holdDiv}</td>
                          <td className="px-2 py-0.5 text-right font-semibold tabular-nums" style={{ color: r.sharpe > 0 ? "#22c55e" : "#ef4444", background: sharpeColor(r.sharpe, coinMaxAbs) }}>{r.sharpe.toFixed(3)}</td>
                          <td className="px-2 py-0.5 text-right tabular-nums" style={{ color: r.winRate > 55 ? "#22c55e" : "#eab308" }}>{r.winRate.toFixed(1)}%</td>
                          <td className="px-2 py-0.5 text-right tabular-nums" style={{ color: r.totalRet > 0 ? "#22c55e" : "#ef4444" }}>{r.totalRet > 0 ? "+" : ""}{r.totalRet.toFixed(2)}%</td>
                          <td className="px-2 py-0.5 text-right text-[var(--text-dim)] tabular-nums">{r.trades}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-3 px-2 mb-4">
          <span className="text-[8px] font-mono text-[var(--text-dim)]">HEAT SCALE:</span>
          <div className="flex gap-0.5">{[-1,-0.5,0,0.5,1].map(v => (
            <div key={v} className="w-10 h-4 rounded-sm flex items-center justify-center text-[7px] font-mono"
              style={{ background: sharpeColor(v * maxAbs, maxAbs), color: v >= 0 ? "#22c55e" : "#ef4444" }}>{v > 0 ? "+" : ""}{(v * maxAbs).toFixed(1)}</div>
          ))}</div>
          <span className="text-[7px] font-mono text-[var(--text-dim)]">Green = positive Sharpe · Red = negative</span>
        </div>

        {/* Alpha / Significance Analysis */}
        <AlphaAnalysis winner={sorted[0]} coinResults={activeCoinResults} barMinutes={activeBarMin} cycleMin={cycleMin} cycleMax={cycleMax} splitPct={splitPct} />

        {/* Saved Strategies */}
        {savedStrategies.length > 0 && (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
            <div className="text-[10px] font-mono font-semibold mb-3" style={{ color: "#22c55e" }}>💾 SAVED STRATEGIES</div>
            <div className="grid grid-cols-1 gap-2">
              {savedStrategies.map(s => (
                <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-[var(--border)] hover:border-[#22c55e40] transition-all">
                  <div className={`w-2 h-2 rounded-full ${s.active ? "bg-green-500" : "bg-gray-500"}`} />
                  <div className="flex-1">
                    <div className="text-[10px] font-mono font-semibold text-[var(--text)]">{s.name}</div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">
                      {s.type} · {s.barMinutes}m · ×{s.minStr} C{s.minCyc} {s.spike?"⚡":""} {s.nearMiss?"±":""} ÷{s.holdDiv}
                      {s.symbol ? ` · ${s.symbol.replace("USDT","")}` : ""}
                    </div>
                  </div>
                  <div className="text-[9px] font-mono tabular-nums" style={{ color: (s.oosSharpe||0) > 0 ? "#22c55e" : "#ef4444" }}>
                    OOS SR {(s.oosSharpe||0).toFixed(1)}
                  </div>
                  {s.bootP != null && (
                    <div className="text-[9px] font-mono tabular-nums" style={{ color: s.bootP < 0.05 ? "#22c55e" : "#eab308" }}>
                      p={s.bootP < 0.001 ? "<.001" : s.bootP.toFixed(3)}
                    </div>
                  )}
                  <div className="text-[9px] font-mono tabular-nums" style={{ color: (s.winRate||0) > 55 ? "#22c55e" : "#eab308" }}>
                    {(s.winRate||0).toFixed(1)}%
                  </div>
                  <button onClick={async () => {
                    await adminFetch("/api/fracmap-strategy", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "toggleStrategy", id: s.id, active: !s.active }) });
                    const r = await adminFetch("/api/fracmap-strategy?action=list");
                    const d = await r.json();
                    if (d.strategies) setSavedStrategies(d.strategies);
                  }}
                    className="px-2 py-0.5 rounded text-[8px] font-mono border transition-all"
                    style={{ borderColor: s.active ? "#22c55e40" : "var(--border)", color: s.active ? "#22c55e" : "var(--text-dim)" }}>
                    {s.active ? "● ACTIVE" : "○ OFF"}
                  </button>
                  <button onClick={async () => {
                    if (!confirm(`Delete "${s.name}"?`)) return;
                    await adminFetch("/api/fracmap-strategy", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "deleteStrategy", id: s.id }) });
                    const r = await adminFetch("/api/fracmap-strategy?action=list");
                    const d = await r.json();
                    if (d.strategies) setSavedStrategies(d.strategies);
                  }}
                    className="px-2 py-0.5 rounded text-[8px] font-mono border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-all">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </>)}

      {/* ── SAVE MODAL ── */}
      {saveModal && sorted[0] && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setSaveModal(false)}>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6 w-[480px] max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="text-[13px] font-mono font-bold mb-4" style={{ color: "#22c55e" }}>💾 Save Strategy to Database</div>

            {/* Strategy preview */}
            <div className="p-3 rounded-lg border border-[var(--border)] mb-4" style={{ background: GOLD_DIM }}>
              <div className="text-[10px] font-mono font-bold" style={{ color: GOLD }}>
                ×{sorted[0].combo.minStr} · C≥{sorted[0].combo.minCyc} · {sorted[0].combo.spike?"⚡":"–"} · {sorted[0].combo.nearMiss?"±":"–"} · {sorted[0].combo.priceExt?"📍":"–"} · ÷{sorted[0].combo.holdDiv}
              </div>
              <div className="flex gap-4 mt-2 text-[9px] font-mono tabular-nums">
                <span>IS Sharpe: <strong style={{ color: "#22c55e" }}>{sorted[0].avgSharpe.toFixed(3)}</strong></span>
                <span>Consistency: {sorted[0].consistency.toFixed(0)}%</span>
                <span>Win%: {sorted[0].avgWinRate.toFixed(1)}%</span>
                {oosDisplayResults.length > 0 && <span>OOS Sharpe: <strong style={{ color: "#a78bfa" }}>{(oosDisplayResults.reduce((s,r) => s+r.sharpe,0)/oosDisplayResults.length).toFixed(3)}</strong>{oosTopN ? <span className="text-[8px] text-[var(--text-dim)]"> (top {oosTopN})</span> : ""}</span>}
              </div>
            </div>

            {/* Name input */}
            <div className="mb-4">
              <label className="text-[9px] font-mono text-[var(--text-dim)] block mb-1">Strategy Name</label>
              <input value={saveName} onChange={e => setSaveName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-transparent text-[11px] font-mono text-[var(--text)] focus:outline-none focus:border-[#22c55e40]"
                placeholder="e.g. Universal 1m v1" autoFocus />
            </div>

            {/* Save options */}
            <div className="flex gap-3 mb-4">
              <button onClick={async () => {
                setSaving(true); setSaveMsg("");
                try {
                  const avgOosSR = oosDisplayResults.length > 0 ? oosDisplayResults.reduce((s,r)=>s+r.sharpe,0)/oosDisplayResults.length : null;
                  const avgOosWR = oosDisplayResults.length > 0 ? oosDisplayResults.reduce((s,r)=>s+r.winRate,0)/oosDisplayResults.length : null;
                  const avgOosPF = oosDisplayResults.length > 0 ? oosDisplayResults.reduce((s,r)=>s+(isFinite(r.profitFactor)?r.profitFactor:0),0)/oosDisplayResults.length : null;
                  const res = await adminFetch("/api/fracmap-strategy", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "saveStrategy", name: saveName, type: "universal", barMinutes: activeBarMin,
                      minStr: sorted[0].combo.minStr, minCyc: sorted[0].combo.minCyc,
                      spike: sorted[0].combo.spike, nearMiss: sorted[0].combo.nearMiss, holdDiv: sorted[0].combo.holdDiv,
                      priceExt: sorted[0].combo.priceExt,
                      isSharpe: sorted[0].avgSharpe, oosSharpe: avgOosSR,
                      winRate: avgOosWR || sorted[0].avgWinRate, profitFactor: avgOosPF,
                      consistency: sorted[0].consistency,
                      totalTrades: Math.round(sorted[0].avgTrades * activeCoinResults.length),
                      splitPct, cycleMin, cycleMax,
                      config: oosTopN ? { coin_universe_top_n: oosTopN } : undefined,
                    })
                  });
                  const d = await res.json();
                  if (d.strategy) {
                    setSaveMsg(`✅ Saved "${saveName}" (id: ${d.strategy.id.slice(0,8)}...)`);
                    const r2 = await adminFetch("/api/fracmap-strategy?action=list");
                    const d2 = await r2.json();
                    if (d2.strategies) setSavedStrategies(d2.strategies);
                  } else { setSaveMsg(`❌ ${d.error || "Unknown error"}`); }
                } catch (e: any) { setSaveMsg(`❌ ${e.message}`); }
                setSaving(false);
              }} disabled={saving || !saveName.trim()}
                className="flex-1 px-4 py-2 rounded-lg text-[10px] font-mono font-bold transition-all disabled:opacity-40"
                style={{ background: "#22c55e", color: "#000" }}>
                {saving ? "⏳ Saving..." : "💾 Save Universal"}
              </button>

              <button onClick={async () => {
                setSaving(true); setSaveMsg("");
                try {
                  const coinStrats = activeCoinResults.map(cr => {
                    const bc = activeCombos.find(c => c.key === cr.bestComboKey);
                    if (!bc) return null;
                    return {
                      symbol: cr.symbol, minStr: bc.minStr, minCyc: bc.minCyc,
                      spike: bc.spike, nearMiss: bc.nearMiss, holdDiv: bc.holdDiv,
                      sharpe: cr.bestSharpe, winRate: cr.comboWinRates[cr.bestComboKey] || 0,
                      pf: 0, trades: cr.comboTrades[cr.bestComboKey] || 0,
                    };
                  }).filter(Boolean);
                  const res = await adminFetch("/api/fracmap-strategy", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "savePerCoinStrategies", name: saveName, barMinutes: activeBarMin, splitPct, strategies: coinStrats
                    })
                  });
                  const d = await res.json();
                  if (d.strategies) {
                    setSaveMsg(`✅ Saved ${d.strategies.length} per-coin strategies`);
                    const r2 = await adminFetch("/api/fracmap-strategy?action=list");
                    const d2 = await r2.json();
                    if (d2.strategies) setSavedStrategies(d2.strategies);
                  } else { setSaveMsg(`❌ ${d.error || "Unknown error"}`); }
                } catch (e: any) { setSaveMsg(`❌ ${e.message}`); }
                setSaving(false);
              }} disabled={saving || !saveName.trim()}
                className="flex-1 px-4 py-2 rounded-lg text-[10px] font-mono font-bold border transition-all disabled:opacity-40"
                style={{ borderColor: "#a78bfa40", color: "#a78bfa" }}>
                {saving ? "⏳ Saving..." : "💾 Save Per-Coin (×20)"}
              </button>
            </div>

            {saveMsg && <div className="text-[10px] font-mono mb-3" style={{ color: saveMsg.startsWith("✅") ? "#22c55e" : "#ef4444" }}>{saveMsg}</div>}

            <button onClick={() => setSaveModal(false)}
              className="w-full px-4 py-2 rounded-lg text-[10px] font-mono border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] transition-all">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Significance levels ──
function sigLabel(p: number): { text: string; color: string } {
  if (p < 0.001) return { text: "★★★ p < 0.001", color: "#22c55e" };
  if (p < 0.01)  return { text: "★★ p < 0.01", color: "#22c55e" };
  if (p < 0.05)  return { text: "★ p < 0.05", color: "#eab308" };
  if (p < 0.10)  return { text: "· p < 0.10", color: "#f97316" };
  return { text: "ns", color: "#ef4444" };
}

type AlphaRow = {
  symbol: string;
  nTrades: number; nLong: number; nShort: number;
  meanRet: number; stdRet: number; tStat: number; pValue: number;
  annSharpe: number; alpha: number; profitFactor: number;
  bootP: number; boot5: number; boot95: number;
  // Long breakdown
  longMeanRet: number; longWinRate: number; longSharpe: number; longPF: number; longTotalRet: number;
  // Short breakdown
  shortMeanRet: number; shortWinRate: number; shortSharpe: number; shortPF: number; shortTotalRet: number;
  // Bootstrap by direction
  bootLongP: number; bootShortP: number;
};

function calcDirectionalStats(sigs: any[], bm: number, totalBars?: number) {
  if (sigs.length === 0) return { meanRet: 0, winRate: 0, sharpe: 0, pf: 0, totalRet: 0 };
  const rets = sigs.map((s: any) => s.returnPct as number);
  const n = rets.length;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const winRate = rets.filter(r => r > 0).length / n * 100;
  const gw = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const gl = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  let eq = 1; for (const r of rets) eq *= (1 + r / 100);

  // Time-series Sharpe: aggregate to daily, annualize from daily
  const nBars = totalBars || (sigs.length > 0
    ? Math.max(...sigs.map((s: any) => (s.exitActualIdx ?? s.exitIdx ?? s.entryIdx + s.holdDuration) + 1))
    : 0);
  const barRets = new Float64Array(nBars);
  for (const sig of sigs) {
    const entry = sig.entryIdx;
    const exit = sig.exitActualIdx ?? sig.exitIdx ?? (entry + sig.holdDuration);
    const hold = Math.max(1, exit - entry);
    const perBar = (sig.returnPct as number) / hold;
    for (let b = entry; b < exit && b < nBars; b++) barRets[b] += perBar;
  }
  const barsPerDay = Math.round(1440 / Math.max(1, bm));
  const nDays = Math.max(1, Math.ceil(nBars / barsPerDay));
  const dailyRets: number[] = [];
  for (let d = 0; d < nDays; d++) {
    const start = d * barsPerDay;
    const end = Math.min(start + barsPerDay, nBars);
    let daySum = 0;
    for (let b = start; b < end; b++) daySum += barRets[b];
    dailyRets.push(daySum);
  }
  let dSum = 0, dSum2 = 0;
  for (const d of dailyRets) { dSum += d; dSum2 += d * d; }
  const dMean = dSum / dailyRets.length;
  const dVar = dSum2 / dailyRets.length - dMean * dMean;
  const dStd = Math.sqrt(Math.max(0, dVar));
  const sharpe = dStd > 0 ? (dMean / dStd) * Math.sqrt(365) : 0;

  return { meanRet: mean, winRate, sharpe, pf, totalRet: (eq - 1) * 100 };
}

function AlphaAnalysis({ winner, coinResults, barMinutes, cycleMin = 5, cycleMax = 20, splitPct = 50 }: { winner: UniResult | undefined; coinResults: CoinResult[]; barMinutes: number; cycleMin?: number; cycleMax?: number; splitPct?: number }) {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<AlphaRow[]>([]);
  const [progress, setProgress] = useState("");
  const BOOTSTRAP_N = 10000;

  const runAlpha = useCallback(async () => {
    if (!winner) return;
    setRunning(true); setRows([]);
    const combo = winner.combo;
    const allRows: AlphaRow[] = [];

    for (let ci = 0; ci < coinResults.length; ci++) {
      const cr = coinResults[ci];
      setProgress(`${cr.symbol} (${ci + 1}/${coinResults.length}) — fetching & computing...`);

      // Server-side OOS computation via fracmap compute API
      let sigs: any[] = [];
      let coinBars: any[] = [];
      try {
        const res = await adminFetch("/api/fracmap/compute", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "computeOOS", symbol: cr.symbol, barMinutes, cycleMin, cycleMax, splitPct, combo }),
        });
        const data = await res.json();
        if (!data.oosSignals || data.oosSignals.length < 3) continue;
        sigs = data.oosSignals;
        coinBars = data.oosBars || [];
      } catch { continue; }
      if (sigs.length < 3) continue;

      // Split by direction
      const longSigs = sigs.filter((s: any) => s.type === "LONG");
      const shortSigs = sigs.filter((s: any) => s.type === "SHORT");
      const longStats = calcDirectionalStats(longSigs, barMinutes, coinBars.length);
      const shortStats = calcDirectionalStats(shortSigs, barMinutes, coinBars.length);
      // Per-trade Sharpe for directional bootstrap comparison (must match computeBootSharpe formula)
      const ptDirSharpe = (dirSigs: any[]) => {
        if (dirSigs.length < 2) return 0;
        const dr = dirSigs.map((s: any) => s.returnPct as number);
        const dm = dr.reduce((s, r) => s + r, 0) / dr.length;
        const ds = Math.sqrt(dr.reduce((s, r) => s + (r - dm) ** 2, 0) / dr.length);
        const dh = dirSigs.reduce((s: number, sig: any) => s + sig.holdDuration * barMinutes, 0) / dr.length;
        return ds > 0 ? (dm / ds) * Math.sqrt(525600 / Math.max(1, dh)) : 0;
      };
      const ptLongSharpe = ptDirSharpe(longSigs);
      const ptShortSharpe = ptDirSharpe(shortSigs);

      // Combined stats
      const rets = sigs.map((s: any) => s.returnPct as number);
      const n = rets.length;
      const mean = rets.reduce((s, r) => s + r, 0) / n;
      const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
      const se = std / Math.sqrt(n);
      const tStat = se > 0 ? mean / se : 0;
      const z = Math.abs(tStat);
      const pValue = n > 2 ? 2 * (1 - normalCDF(z)) : 1;
      // Time-series Sharpe for the combined strategy — aggregate to daily
      const tsBarRets = new Float64Array(coinBars.length);
      for (const sig of sigs) {
        const entry = sig.entryIdx;
        const exit = sig.exitActualIdx ?? sig.exitIdx ?? (entry + sig.holdDuration);
        const hold = Math.max(1, exit - entry);
        const perBar = (sig.returnPct as number) / hold;
        for (let b = entry; b < exit && b < coinBars.length; b++) tsBarRets[b] += perBar;
      }
      const _bpd = Math.round(1440 / Math.max(1, barMinutes));
      const _nDays = Math.max(1, Math.ceil(coinBars.length / _bpd));
      const _dailyRets: number[] = [];
      for (let d = 0; d < _nDays; d++) {
        const s0 = d * _bpd, e0 = Math.min(s0 + _bpd, coinBars.length);
        let ds = 0; for (let b = s0; b < e0; b++) ds += tsBarRets[b];
        _dailyRets.push(ds);
      }
      let _dS = 0, _dS2 = 0;
      for (const d of _dailyRets) { _dS += d; _dS2 += d * d; }
      const tsMean = _dS / _dailyRets.length;
      const tsVar = _dS2 / _dailyRets.length - tsMean * tsMean;
      const tsStd = Math.sqrt(Math.max(0, tsVar));
      const annSharpe = tsStd > 0 ? (tsMean / tsStd) * Math.sqrt(365) : 0;
      // Per-trade Sharpe (used ONLY for bootstrap comparison — both actual and random
      // use the same formula, so p-values are valid even though absolute values inflate)
      const ptStd = n > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n) : 0;
      const avgHM = sigs.reduce((s: number, sig: any) => s + sig.holdDuration * barMinutes, 0) / n;
      const ptSharpe = ptStd > 0 ? (mean / ptStd) * Math.sqrt(525600 / Math.max(1, avgHM)) : 0;
      const firstPrice = coinBars[0].close;
      const lastPrice = coinBars[coinBars.length - 1].close;
      const buyHoldRet = (lastPrice / firstPrice - 1) * 100;
      let eq = 1; for (const r of rets) eq *= (1 + r / 100);
      const alpha = (eq - 1) * 100 - buyHoldRet;
      const gw = rets.filter(r => r > 0).reduce((s, r) => s + r, 0);
      const gl = Math.abs(rets.filter(r => r < 0).reduce((s, r) => s + r, 0));
      const profitFactor = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;

      // Bootstrap with ACTUAL direction ratio
      setProgress(`${cr.symbol} (${ci + 1}/${coinResults.length}) — bootstrap ${BOOTSTRAP_N.toLocaleString()} (${longSigs.length}L/${shortSigs.length}S)...`);
      const holdDurations = sigs.map((s: any) => s.holdDuration);
      const directions = sigs.map((s: any) => s.type as string); // actual L/S sequence
      const longRatio = longSigs.length / n;

      const bootSharpes: number[] = [];
      const bootLongSharpes: number[] = [];
      const bootShortSharpes: number[] = [];

      for (let b = 0; b < BOOTSTRAP_N; b++) {
        const bootRetsAll: number[] = [];
        const bootRetsLong: number[] = [];
        const bootRetsShort: number[] = [];
        for (let t = 0; t < n; t++) {
          const maxStart = coinBars.length - holdDurations[t] - 1;
          if (maxStart < 1) continue;
          const rndEntry = Math.floor(Math.random() * maxStart);
          const entryP = coinBars[rndEntry].close;
          const exitP = coinBars[Math.min(rndEntry + holdDurations[t], coinBars.length - 1)].close;
          // Use actual direction ratio: same % longs/shorts as real strategy
          const isLong = directions[t] === "LONG";
          const ret = isLong ? (exitP / entryP - 1) * 100 : (entryP / exitP - 1) * 100;
          bootRetsAll.push(ret);
          if (isLong) bootRetsLong.push(ret); else bootRetsShort.push(ret);
        }

        const computeBootSharpe = (brets: number[]) => {
          if (brets.length < 2) return 0;
          const bm = brets.reduce((s, r) => s + r, 0) / brets.length;
          const bs = Math.sqrt(brets.reduce((s, r) => s + (r - bm) ** 2, 0) / brets.length);
          const bAvgHM = holdDurations.reduce((s, h) => s + h * barMinutes, 0) / holdDurations.length;
          return bs > 0 ? (bm / bs) * Math.sqrt(525600 / Math.max(1, bAvgHM)) : 0;
        };

        bootSharpes.push(computeBootSharpe(bootRetsAll));
        if (bootRetsLong.length > 1) bootLongSharpes.push(computeBootSharpe(bootRetsLong));
        if (bootRetsShort.length > 1) bootShortSharpes.push(computeBootSharpe(bootRetsShort));
      }

      bootSharpes.sort((a, b) => a - b);
      bootLongSharpes.sort((a, b) => a - b);
      bootShortSharpes.sort((a, b) => a - b);
      const bootP = bootSharpes.filter(s => s >= ptSharpe).length / BOOTSTRAP_N;
      const boot5 = bootSharpes[Math.floor(BOOTSTRAP_N * 0.05)];
      const boot95 = bootSharpes[Math.floor(BOOTSTRAP_N * 0.95)];
      const bootLongP = bootLongSharpes.length > 0 ? bootLongSharpes.filter(s => s >= ptLongSharpe).length / bootLongSharpes.length : 1;
      const bootShortP = bootShortSharpes.length > 0 ? bootShortSharpes.filter(s => s >= ptShortSharpe).length / bootShortSharpes.length : 1;

      allRows.push({
        symbol: cr.symbol, nTrades: n, nLong: longSigs.length, nShort: shortSigs.length,
        meanRet: mean, stdRet: std, tStat, pValue, annSharpe, alpha, profitFactor,
        bootP, boot5, boot95,
        longMeanRet: longStats.meanRet, longWinRate: longStats.winRate, longSharpe: longStats.sharpe, longPF: longStats.pf, longTotalRet: longStats.totalRet,
        shortMeanRet: shortStats.meanRet, shortWinRate: shortStats.winRate, shortSharpe: shortStats.sharpe, shortPF: shortStats.pf, shortTotalRet: shortStats.totalRet,
        bootLongP, bootShortP,
      });
      setRows([...allRows]);
      await new Promise(r => setTimeout(r, 0));
    }

    setProgress(`✅ Alpha analysis complete — ${allRows.length} coins tested`);
    setRunning(false);
  }, [winner, coinResults, barMinutes, splitPct]);

  if (!winner) return null;

  // Aggregates
  const sigCount = rows.filter(r => r.pValue < 0.05).length;
  const bootSigCount = rows.filter(r => r.bootP < 0.05).length;
  const avgAlpha = rows.length > 0 ? rows.reduce((s, r) => s + r.alpha, 0) / rows.length : 0;
  const avgPF = rows.length > 0 ? rows.reduce((s, r) => s + (isFinite(r.profitFactor) ? r.profitFactor : 0), 0) / rows.length : 0;
  const totalLong = rows.reduce((s, r) => s + r.nLong, 0);
  const totalShort = rows.reduce((s, r) => s + r.nShort, 0);
  const totalAll = totalLong + totalShort;
  const avgLongWR = rows.length > 0 ? rows.reduce((s, r) => s + r.longWinRate * r.nLong, 0) / Math.max(totalLong, 1) : 0;
  const avgShortWR = rows.length > 0 ? rows.reduce((s, r) => s + r.shortWinRate * r.nShort, 0) / Math.max(totalShort, 1) : 0;
  const longBootSigCount = rows.filter(r => r.bootLongP < 0.05).length;
  const shortBootSigCount = rows.filter(r => r.bootShortP < 0.05).length;

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
      <div className="flex items-center gap-4 mb-3">
        <span className="text-[11px] font-mono font-semibold" style={{ color: "#a78bfa" }}>α STATISTICAL SIGNIFICANCE</span>
        <span className="text-[9px] font-mono text-[var(--text-dim)]">
          T-test · Direction-aware Bootstrap ({BOOTSTRAP_N.toLocaleString()}) · Long/Short Breakdown
        </span>
        <div className="flex-1" />
        {rows.length > 0 && (
          <button onClick={() => {
            const exportData = {
              timestamp: new Date().toISOString(),
              barMinutes,
              splitPct: `OOS only (${100 - splitPct}% unseen data)`,
              winnerCombo: winner ? { str: winner.combo.minStr, minCyc: winner.combo.minCyc, spike: winner.combo.spike, nearMiss: winner.combo.nearMiss, holdDiv: winner.combo.holdDiv } : null,
              summary: {
                tTestSig: `${sigCount}/${rows.length}`,
                bootSig: `${bootSigCount}/${rows.length}`,
                avgAlpha: +avgAlpha.toFixed(4),
                avgPF: +avgPF.toFixed(4),
                totalLong, totalShort,
                longWinRate: +avgLongWR.toFixed(2),
                shortWinRate: +avgShortWR.toFixed(2),
                bootSigLong: `${longBootSigCount}/${rows.length}`,
                bootSigShort: `${shortBootSigCount}/${rows.length}`,
              },
              coins: rows.sort((a, b) => a.pValue - b.pValue).map(r => ({
                coin: r.symbol.replace("USDT", ""),
                trades: r.nTrades, long: r.nLong, short: r.nShort, shortPct: +((r.nShort / r.nTrades) * 100).toFixed(1),
                tStat: +r.tStat.toFixed(4), pValue: +r.pValue.toFixed(6), sharpe: +r.annSharpe.toFixed(3),
                alpha: +r.alpha.toFixed(4), profitFactor: +(isFinite(r.profitFactor) ? r.profitFactor.toFixed(4) : 999),
                bootP: +r.bootP.toFixed(6), boot5: +r.boot5.toFixed(3), boot95: +r.boot95.toFixed(3),
                longWinRate: +r.longWinRate.toFixed(2), longSharpe: +r.longSharpe.toFixed(3), longPF: +(isFinite(r.longPF) ? r.longPF.toFixed(4) : 999), longTotalRet: +r.longTotalRet.toFixed(4), bootLongP: +r.bootLongP.toFixed(6),
                shortWinRate: +r.shortWinRate.toFixed(2), shortSharpe: +r.shortSharpe.toFixed(3), shortPF: +(isFinite(r.shortPF) ? r.shortPF.toFixed(4) : 999), shortTotalRet: +r.shortTotalRet.toFixed(4), bootShortP: +r.bootShortP.toFixed(6),
              })),
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href = url;
            a.download = `fracmap-alpha-${barMinutes}m-${new Date().toISOString().slice(0,10)}.json`;
            a.click(); URL.revokeObjectURL(url);
          }}
            className="px-3 py-1.5 rounded text-[9px] font-mono font-semibold border transition-all mr-2"
            style={{ borderColor: "#a78bfa40", color: "#a78bfa" }}>
            💾 EXPORT JSON
          </button>
        )}
        <button onClick={runAlpha} disabled={running}
          className="px-4 py-1.5 rounded text-[10px] font-mono font-bold tracking-wider transition-all disabled:opacity-40"
          style={{ background: running ? "transparent" : "#a78bfa", color: running ? "#a78bfa" : "#000", border: "1px solid #a78bfa" }}>
          {running ? "⏳ ANALYSING..." : "▶ RUN ALPHA TEST"}
        </button>
      </div>

      <div className="text-[9px] font-mono text-[var(--text-dim)] mb-3">
        Tests the <strong style={{ color: GOLD }}>winning universal combo</strong> on each coin using <strong style={{ color: "#22c55e" }}>OOS data only</strong> ({100 - splitPct}% unseen).
        Bootstrap uses the <strong>actual long/short ratio</strong> from the strategy (not 50/50), so it fairly tests whether entry timing matters for each direction.
      </div>

      {progress && <div className="text-[9px] font-mono mb-3" style={{ color: progress.startsWith("✅") ? "#22c55e" : "var(--text-dim)" }}>{progress}</div>}

      {rows.length > 0 && (
        <>
          {/* Summary row 1: Combined */}
          <div className="flex gap-5 mb-2 p-3 rounded-lg border border-[var(--border)]" style={{ background: "rgba(167,139,250,0.04)" }}>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">T-Test Sig</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: sigCount > rows.length / 2 ? "#22c55e" : "#eab308" }}>
                {sigCount}/{rows.length}
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Boot Sig (all)</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: bootSigCount > rows.length / 2 ? "#22c55e" : "#eab308" }}>
                {bootSigCount}/{rows.length}
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Avg Alpha</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: avgAlpha > 0 ? "#22c55e" : "#ef4444" }}>
                {avgAlpha > 0 ? "+" : ""}{avgAlpha.toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Avg PF</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: avgPF > 1 ? "#22c55e" : "#ef4444" }}>
                {avgPF.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Summary row 2: Direction breakdown */}
          <div className="flex gap-4 mb-4 p-3 rounded-lg border border-[var(--border)]" style={{ background: "rgba(34,197,94,0.03)" }}>
            <div>
              <div className="text-[8px] font-mono text-[var(--text-dim)]">Direction Split</div>
              <div className="text-[12px] font-mono font-bold tabular-nums">
                <span style={{ color: "#22c55e" }}>{totalLong}L</span>
                <span className="text-[var(--text-dim)]"> / </span>
                <span style={{ color: "#ef4444" }}>{totalShort}S</span>
                <span className="text-[9px] text-[var(--text-dim)] font-normal ml-1">({totalAll > 0 ? ((totalShort / totalAll) * 100).toFixed(0) : 0}% short)</span>
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono" style={{ color: "#22c55e" }}>Long Win %</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: avgLongWR > 55 ? "#22c55e" : "#eab308" }}>
                {avgLongWR.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono" style={{ color: "#ef4444" }}>Short Win %</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: avgShortWR > 55 ? "#22c55e" : "#eab308" }}>
                {avgShortWR.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono" style={{ color: "#22c55e" }}>Boot Sig (long)</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: longBootSigCount > rows.length / 2 ? "#22c55e" : "#eab308" }}>
                {longBootSigCount}/{rows.length}
              </div>
            </div>
            <div>
              <div className="text-[8px] font-mono" style={{ color: "#ef4444" }}>Boot Sig (short)</div>
              <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: shortBootSigCount > rows.length / 2 ? "#22c55e" : "#eab308" }}>
                {shortBootSigCount}/{rows.length}
              </div>
            </div>
          </div>

          {/* Per-coin table */}
          <div className="overflow-x-auto">
            <table className="w-full text-[9px] font-mono border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-1.5 py-1 text-left text-[var(--text-dim)] font-normal">Coin</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">T</th>
                  <th className="px-1 py-1 text-center text-[var(--text-dim)] font-normal">L/S</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">S%</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">T-stat</th>
                  <th className="px-1 py-1 text-right font-semibold" style={{ color: "#a78bfa" }}>P-val</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">SR</th>
                  <th className="px-1 py-1 text-right text-[var(--text-dim)] font-normal">PF</th>
                  <th className="px-1 py-1 text-right font-semibold" style={{ color: "#a78bfa" }}>Boot P</th>
                  <th className="px-0.5 py-1 text-center text-[var(--text-dim)]">│</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#22c55e" }}>L WR</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#22c55e" }}>L SR</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#22c55e" }}>L PF</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#22c55e" }}>L Ret</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#22c55e" }}>L Boot</th>
                  <th className="px-0.5 py-1 text-center text-[var(--text-dim)]">│</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#ef4444" }}>S WR</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#ef4444" }}>S SR</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#ef4444" }}>S PF</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#ef4444" }}>S Ret</th>
                  <th className="px-1 py-1 text-right font-normal" style={{ color: "#ef4444" }}>S Boot</th>
                </tr>
              </thead>
              <tbody>
                {rows.sort((a, b) => a.pValue - b.pValue).map(r => {
                  const sig = sigLabel(r.pValue);
                  const bsig = sigLabel(r.bootP);
                  const blsig = sigLabel(r.bootLongP);
                  const bssig = sigLabel(r.bootShortP);
                  const shortPct = r.nTrades > 0 ? ((r.nShort / r.nTrades) * 100).toFixed(0) : "–";
                  return (
                    <tr key={r.symbol} className="border-b border-[var(--border)] border-opacity-20 hover:bg-white/[0.02]">
                      <td className="px-1.5 py-1 font-semibold text-[var(--text)]">{r.symbol.replace("USDT","")}</td>
                      <td className="px-1 py-1 text-right text-[var(--text-dim)] tabular-nums">{r.nTrades}</td>
                      <td className="px-1 py-1 text-center tabular-nums">
                        <span style={{ color: "#22c55e" }}>{r.nLong}</span>/<span style={{ color: "#ef4444" }}>{r.nShort}</span>
                      </td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: +shortPct > 60 ? "#ef4444" : +shortPct > 40 ? "#eab308" : "#22c55e" }}>{shortPct}%</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: Math.abs(r.tStat) > 1.96 ? "#22c55e" : "var(--text-dim)" }}>{r.tStat.toFixed(2)}</td>
                      <td className="px-1 py-1 text-right tabular-nums font-semibold" style={{ color: sig.color }}>{r.pValue < 0.001 ? "<.001" : r.pValue.toFixed(3)}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.annSharpe > 0 ? "#22c55e" : "#ef4444" }}>{r.annSharpe.toFixed(1)}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.profitFactor > 1 ? "#22c55e" : "#ef4444" }}>{isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}</td>
                      <td className="px-1 py-1 text-right tabular-nums font-semibold" style={{ color: bsig.color }}>{r.bootP < 0.001 ? "<.001" : r.bootP.toFixed(3)}</td>
                      <td className="px-0.5 py-1 text-center text-[var(--border)]">│</td>
                      {/* Long cols */}
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.longWinRate > 55 ? "#22c55e" : "#eab308" }}>{r.nLong > 0 ? r.longWinRate.toFixed(1) + "%" : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.longSharpe > 0 ? "#22c55e" : "#ef4444" }}>{r.nLong > 0 ? r.longSharpe.toFixed(1) : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.longPF > 1 ? "#22c55e" : "#ef4444" }}>{r.nLong > 0 ? (isFinite(r.longPF) ? r.longPF.toFixed(2) : "∞") : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.longTotalRet > 0 ? "#22c55e" : "#ef4444" }}>{r.nLong > 0 ? (r.longTotalRet > 0 ? "+" : "") + r.longTotalRet.toFixed(1) + "%" : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: blsig.color }}>{r.nLong > 1 ? (r.bootLongP < 0.001 ? "<.001" : r.bootLongP.toFixed(3)) : "–"}</td>
                      <td className="px-0.5 py-1 text-center text-[var(--border)]">│</td>
                      {/* Short cols */}
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.shortWinRate > 55 ? "#22c55e" : "#eab308" }}>{r.nShort > 0 ? r.shortWinRate.toFixed(1) + "%" : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.shortSharpe > 0 ? "#22c55e" : "#ef4444" }}>{r.nShort > 0 ? r.shortSharpe.toFixed(1) : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.shortPF > 1 ? "#22c55e" : "#ef4444" }}>{r.nShort > 0 ? (isFinite(r.shortPF) ? r.shortPF.toFixed(2) : "∞") : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: r.shortTotalRet > 0 ? "#22c55e" : "#ef4444" }}>{r.nShort > 0 ? (r.shortTotalRet > 0 ? "+" : "") + r.shortTotalRet.toFixed(1) + "%" : "–"}</td>
                      <td className="px-1 py-1 text-right tabular-nums" style={{ color: bssig.color }}>{r.nShort > 1 ? (r.bootShortP < 0.001 ? "<.001" : r.bootShortP.toFixed(3)) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Interpretation */}
          <div className="mt-3 pt-3 border-t border-[var(--border)] text-[9px] font-mono text-[var(--text-dim)] leading-relaxed">
            <strong style={{ color: "#a78bfa" }}>How to read:</strong> <strong>L/S</strong> = long/short trade count. <strong>S%</strong> = percentage of trades that were shorts.
            Bootstrap now uses the <strong>actual direction ratio</strong> from the strategy — random entries are assigned the same long/short sequence, so the null hypothesis is fair for counter-trend strategies.
            <strong>L Boot / S Boot</strong> = bootstrap p-value for longs and shorts separately — if shorts show p &lt; 0.05 in a rising market, the short timing has genuine alpha.
            <strong>PF</strong> &gt; 1 = edge. <strong>★★★</strong> = p &lt; 0.001, <strong>★★</strong> = p &lt; 0.01, <strong>★</strong> = p &lt; 0.05, <strong>ns</strong> = not significant.
          </div>
        </>
      )}
    </div>
  );
}

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/* ═══════════════════════════════════════════════════════════
   ScannerExtras — Cumulative returns, net position, worst trades
   Rendered as a separate component to isolate from main scanner
   ═══════════════════════════════════════════════════════════ */
function ScannerExtras({ oosSignals, oosResults }: { oosSignals: Record<string, any[]>; oosResults: any[] }) {
  const [selCoin, setSelCoin] = useState<string | null>(null);
  const [showWorst, setShowWorst] = useState(false);
  const GOLD = "#D4A843";

  // ── All heavy computation memoized ──
  const { allSigs, coinCumData, compositeData, netPosData, worstAnalysis, worstTrades, maxBar } = useMemo(() => {
    const allSigs: (any & { coin: string })[] = [];
    for (const [symbol, sigs] of Object.entries(oosSignals)) {
      for (const s of sigs) allSigs.push({ ...s, coin: symbol });
    }

    const coinCumData: Record<string, { bar: number; cum: number }[]> = {};
    let maxBar = 0;
    for (const [symbol, sigs] of Object.entries(oosSignals)) {
      if (!sigs || sigs.length === 0) continue;
      const sorted = [...sigs].sort((a: any, b: any) => a.entryIdx - b.entryIdx);
      const pts: { bar: number; cum: number }[] = [{ bar: 0, cum: 0 }];
      let cum = 0;
      for (const sig of sorted) {
        cum += sig.returnPct || 0;
        const barIdx = sig.exitActualIdx || sig.exitIdx || (sig.entryIdx + sig.holdDuration);
        pts.push({ bar: barIdx, cum: +cum.toFixed(3) });
        if (barIdx > maxBar) maxBar = barIdx;
      }
      coinCumData[symbol] = pts;
    }

    const compositeData: { bar: number; avg: number }[] = [];
    if (maxBar > 0) {
      const step = Math.max(1, Math.floor(maxBar / 200));
      for (let bar = 0; bar <= maxBar; bar += step) {
        let sum = 0, count = 0;
        for (const pts of Object.values(coinCumData)) {
          let lastCum = 0;
          for (const pt of pts) { if (pt.bar <= bar) lastCum = pt.cum; else break; }
          sum += lastCum; count++;
        }
        compositeData.push({ bar, avg: count > 0 ? +(sum / count).toFixed(3) : 0 });
      }
    }

    const netPosData: { bar: number; net: number }[] = [];
    if (maxBar > 0 && allSigs.length > 0) {
      const STEP = Math.max(1, Math.floor(maxBar / 200));
      const buckets = new Float32Array(Math.ceil((maxBar + 1) / STEP));
      for (const s of allSigs) {
        const en = s.entryIdx, ex = s.exitActualIdx ?? s.exitIdx ?? (en + s.holdDuration);
        const delta = s.type === "LONG" ? 1 : -1;
        const b0 = Math.floor(en / STEP), b1 = Math.min(Math.floor(ex / STEP), buckets.length - 1);
        for (let b = b0; b <= b1; b++) buckets[b] += delta;
      }
      for (let i = 0; i < buckets.length; i++) netPosData.push({ bar: i * STEP, net: buckets[i] });
    }

    const sortedByReturn = [...allSigs].sort((a, b) => a.returnPct - b.returnPct);
    const worstCount = Math.max(5, Math.ceil(allSigs.length * 0.01));
    const worstTrades = sortedByReturn.slice(0, worstCount);

    const worstAnalysis = (() => {
      if (worstTrades.length === 0) return null;
      const wLongs = worstTrades.filter(s => s.type === "LONG").length;
      const wShorts = worstTrades.filter(s => s.type === "SHORT").length;
      const allLongs = allSigs.filter(s => s.type === "LONG").length;
      const longPctWorst = worstTrades.length > 0 ? wLongs / worstTrades.length * 100 : 0;
      const longPctAll = allSigs.length > 0 ? allLongs / allSigs.length * 100 : 0;
      const coinCounts: Record<string, number> = {};
      for (const s of worstTrades) coinCounts[s.coin] = (coinCounts[s.coin] || 0) + 1;
      const coinEntries = Object.entries(coinCounts).sort((a, b) => b[1] - a[1]);
      const topCoinPct = coinEntries.length > 0 ? coinEntries[0][1] / worstTrades.length * 100 : 0;
      const avgCycleWorst = worstTrades.reduce((s, t) => s + (t.maxCycle || 0), 0) / worstTrades.length;
      const avgCycleAll = allSigs.reduce((s, t) => s + (t.maxCycle || 0), 0) / allSigs.length;
      const avgStrWorst = worstTrades.reduce((s, t) => s + (t.strength || 0), 0) / worstTrades.length;
      const avgStrAll = allSigs.reduce((s, t) => s + (t.strength || 0), 0) / allSigs.length;
      const avgHoldWorst = worstTrades.reduce((s, t) => s + (t.holdDuration || 0), 0) / worstTrades.length;
      const avgHoldAll = allSigs.reduce((s, t) => s + (t.holdDuration || 0), 0) / allSigs.length;
      const allLosers = allSigs.filter(s => s.returnPct < 0);
      const avgLossWorst = worstTrades.reduce((s, t) => s + t.returnPct, 0) / worstTrades.length;
      const avgLossAll = allLosers.length > 0 ? allLosers.reduce((s, t) => s + t.returnPct, 0) / allLosers.length : 0;
      const worstTimes = worstTrades.map(s => s.entryIdx).sort((a, b) => a - b);
      const gaps: number[] = [];
      for (let i = 1; i < worstTimes.length; i++) gaps.push(worstTimes[i] - worstTimes[i - 1]);
      const avgGap = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : maxBar;
      const expectedGap = allSigs.length > 0 ? maxBar / allSigs.length * (allSigs.length / worstTrades.length) : maxBar;
      const clusterRatio = expectedGap > 0 ? avgGap / expectedGap : 1;
      const hourCounts = new Array(24).fill(0);
      const hourCountsAll = new Array(24).fill(0);
      for (const s of worstTrades) { try { hourCounts[new Date(s.time).getUTCHours()]++; } catch {} }
      for (const s of allSigs) { try { hourCountsAll[new Date(s.time).getUTCHours()]++; } catch {} }
      let peakHour = 0;
      for (let h = 1; h < 24; h++) if (hourCounts[h] > hourCounts[peakHour]) peakHour = h;
      const peakHourPctWorst = worstTrades.length > 0 ? hourCounts[peakHour] / worstTrades.length * 100 : 0;
      const peakHourPctAll = allSigs.length > 0 ? hourCountsAll[peakHour] / allSigs.length * 100 : 0;
      return {
        total: worstTrades.length, totalAll: allSigs.length,
        avgLoss: avgLossWorst, avgLossAll,
        longPctWorst, longPctAll, wLongs, wShorts,
        coinEntries, topCoinPct,
        avgCycleWorst, avgCycleAll,
        avgStrWorst, avgStrAll,
        avgHoldWorst, avgHoldAll,
        clusterRatio,
        peakHour, peakHourPctWorst, peakHourPctAll,
      };
    })();

    return { allSigs, coinCumData, compositeData, netPosData, worstAnalysis, worstTrades, maxBar };
  }, [oosSignals, oosResults]);

  // SVG line helper
  const svgLine = (data: { v: number }[], h: number, color: string) => {
    if (data.length < 2) return "";
    const minV = Math.min(...data.map(d => d.v), 0);
    const maxV = Math.max(...data.map(d => d.v), 0.001);
    const range = maxV - minV || 1;
    return data.map((d, i) => {
      const x = (i / (data.length - 1)) * 800;
      const y = (h - 10) - ((d.v - minV) / range) * (h - 20);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
  };

  const compMinV = Math.min(...compositeData.map(d => d.avg), 0);
  const compMaxV = Math.max(...compositeData.map(d => d.avg), 0.001);

  return (
    <>
      {/* ═══ CUMULATIVE RETURNS ═══ */}
      {compositeData.length > 2 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[11px] font-mono font-bold" style={{ color: "#22c55e" }}>📈 CUMULATIVE RETURNS (OOS)</span>
            <span className="text-[9px] font-mono text-[var(--text-dim)]">Equal-weight composite across {Object.keys(coinCumData).length} coins</span>
          </div>
          <div className="w-full h-[160px] mb-3">
            <svg viewBox="0 0 800 160" className="w-full h-full">
              <line x1="0" y1="80" x2="800" y2="80" stroke="#475569" strokeWidth="1" strokeDasharray="4 4" />
              <path d={svgLine(compositeData.map(d => ({ v: d.avg })), 160, "#22c55e")} fill="none" stroke="#22c55e" strokeWidth="2" />
              <text x="4" y="12" fill="#22c55e" fontSize="9" fontFamily="monospace">{compMaxV.toFixed(2)}%</text>
              <text x="4" y="156" fill="#ef4444" fontSize="9" fontFamily="monospace">{compMinV.toFixed(2)}%</text>
            </svg>
          </div>
          <div className="border-t border-[var(--border)] pt-3">
            <div className="text-[9px] font-mono text-[var(--text-dim)] mb-2">Click coin for individual equity curve:</div>
            <div className="flex flex-wrap gap-1 mb-3">
              {[...oosResults].sort((a: any, b: any) => b.sharpe - a.sharpe).map((r: any) => (
                <button key={r.coin} onClick={() => setSelCoin(selCoin === r.coin ? null : r.coin)}
                  className="px-1.5 py-0.5 rounded text-[8px] font-mono font-bold border transition-all"
                  style={{
                    background: selCoin === r.coin ? (r.sharpe > 0 ? "#22c55e12" : "#ef444412") : "transparent",
                    borderColor: selCoin === r.coin ? (r.sharpe > 0 ? "#22c55e40" : "#ef444440") : "var(--border)",
                    color: r.sharpe > 5 ? "#22c55e" : r.sharpe > 0 ? "#eab308" : "#ef4444",
                  }}>
                  {r.coin.replace("USDT","")} {r.sharpe > 0 ? "+" : ""}{r.sharpe.toFixed(1)}
                </button>
              ))}
            </div>
            {selCoin && coinCumData[selCoin] && coinCumData[selCoin].length > 1 && (() => {
              const pts = coinCumData[selCoin];
              const sr = oosResults.find((r: any) => r.coin === selCoin)?.sharpe || 0;
              const col = sr > 0 ? "#22c55e" : "#ef4444";
              const pMinV = Math.min(...pts.map(p => p.cum), 0);
              const pMaxV = Math.max(...pts.map(p => p.cum), 0.001);
              return (
                <div>
                  <div className="text-[10px] font-mono font-bold mb-2" style={{ color: col }}>
                    {selCoin.replace("USDT","")} — {pts.length - 1} trades · Total: {pts[pts.length-1]?.cum > 0 ? "+" : ""}{pts[pts.length-1]?.cum.toFixed(2)}%
                  </div>
                  <div className="w-full h-[120px]">
                    <svg viewBox="0 0 800 130" className="w-full h-full">
                      <line x1="0" y1="65" x2="800" y2="65" stroke="#475569" strokeWidth="0.5" strokeDasharray="4 4" />
                      <path d={svgLine(pts.map(p => ({ v: p.cum })), 130, col)} fill="none" stroke={col} strokeWidth="2" />
                      <text x="4" y="10" fill={col} fontSize="9" fontFamily="monospace">{pMaxV.toFixed(2)}%</text>
                      <text x="4" y="128" fill="#ef4444" fontSize="9" fontFamily="monospace">{pMinV.toFixed(2)}%</text>
                    </svg>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ═══ NET POSITION ═══ */}
      {netPosData.length > 10 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[11px] font-mono font-bold" style={{ color: "#06b6d4" }}>⚖️ NET POSITION</span>
            <span className="text-[9px] font-mono text-[var(--text-dim)]">Active longs − shorts across {Object.keys(oosSignals).length} coins · Positive = net long bias</span>
          </div>
          <div className="w-full h-[100px]">
            <svg viewBox="0 0 800 100" className="w-full h-full">
              <line x1="0" y1="50" x2="800" y2="50" stroke="#475569" strokeWidth="1" />
              <path d={svgLine(netPosData.map(d => ({ v: d.net })), 100, GOLD)} fill="none" stroke={GOLD} strokeWidth="2" />
            </svg>
          </div>
          <div className="flex gap-4 text-[9px] font-mono text-[var(--text-dim)] mt-1">
            <span>Avg: <strong style={{ color: netPosData.reduce((s,d) => s+d.net, 0) / netPosData.length > 0 ? "#22c55e" : "#ef4444" }}>
              {(netPosData.reduce((s,d) => s+d.net, 0) / netPosData.length).toFixed(1)}
            </strong></span>
            <span>Max long: <strong style={{ color: "#22c55e" }}>+{Math.max(...netPosData.map(d => d.net))}</strong></span>
            <span>Max short: <strong style={{ color: "#ef4444" }}>{Math.min(...netPosData.map(d => d.net))}</strong></span>
          </div>
        </div>
      )}

      {/* ═══ WORST TRADE ANALYSIS ═══ */}
      {worstAnalysis && worstAnalysis.total >= 5 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4 mb-4">
          <button onClick={() => setShowWorst(!showWorst)} className="w-full text-left flex items-center gap-3">
            <span className="text-[11px] font-mono font-bold" style={{ color: "#ef4444" }}>🔻 WORST TRADE ANALYSIS</span>
            <span className="text-[9px] font-mono text-[var(--text-dim)]">Bottom 1% ({worstAnalysis.total} trades, avg {worstAnalysis.avgLoss.toFixed(2)}%) — what went wrong?</span>
            <span className="text-[9px] font-mono text-[var(--text-dim)] ml-auto">{showWorst ? "▼" : "▶"}</span>
          </button>

          {showWorst && (
            <div className="mt-3 pt-3 border-t border-[var(--border)]">
              {/* Summary findings */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {[
                  { label: "Avg Loss (worst 1%)", value: worstAnalysis.avgLoss.toFixed(2) + "%", ref: worstAnalysis.avgLossAll.toFixed(2) + "% all losers", bad: true },
                  { label: "Direction Skew", value: `${worstAnalysis.wLongs}L / ${worstAnalysis.wShorts}S`, ref: `vs ${worstAnalysis.longPctAll.toFixed(0)}% longs overall`, bad: Math.abs(worstAnalysis.longPctWorst - worstAnalysis.longPctAll) > 15 },
                  { label: "Avg Cycle", value: worstAnalysis.avgCycleWorst.toFixed(0), ref: `vs ${worstAnalysis.avgCycleAll.toFixed(0)} overall`, bad: Math.abs(worstAnalysis.avgCycleWorst - worstAnalysis.avgCycleAll) > 10 },
                  { label: "Time Clustering", value: worstAnalysis.clusterRatio < 0.5 ? "CLUSTERED" : worstAnalysis.clusterRatio > 1.5 ? "Dispersed" : "Normal", ref: `ratio: ${worstAnalysis.clusterRatio.toFixed(2)}`, bad: worstAnalysis.clusterRatio < 0.5 },
                ].map(k => (
                  <div key={k.label} className="p-2 rounded border" style={{ borderColor: k.bad ? "#ef444430" : "var(--border)", background: k.bad ? "#ef444408" : "transparent" }}>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">{k.label}</div>
                    <div className="text-[13px] font-mono font-bold" style={{ color: k.bad ? "#ef4444" : "var(--text)" }}>{k.value}</div>
                    <div className="text-[8px] font-mono text-[var(--text-dim)]">{k.ref}</div>
                  </div>
                ))}
              </div>

              {/* Coin concentration */}
              <div className="mb-3">
                <div className="text-[9px] font-mono font-bold text-[var(--text-dim)] mb-1">COIN CONCENTRATION IN WORST TRADES</div>
                <div className="flex flex-wrap gap-1">
                  {worstAnalysis.coinEntries.map(([coin, count]: [string, number]) => {
                    const pctWorst = count / worstAnalysis.total * 100;
                    const totalForCoin = allSigs.filter(s => s.coin === coin).length;
                    const pctAll = totalForCoin / worstAnalysis.totalAll * 100;
                    const overRep = pctWorst > pctAll * 1.5;
                    return (
                      <span key={coin} className="px-2 py-0.5 rounded text-[8px] font-mono border"
                        style={{ color: overRep ? "#ef4444" : "var(--text-dim)", borderColor: overRep ? "#ef444430" : "var(--border)", background: overRep ? "#ef444408" : "transparent" }}>
                        {(coin as string).replace("USDT","")} {count} ({pctWorst.toFixed(0)}% worst{overRep ? " ⚠️" : ""} vs {pctAll.toFixed(0)}% pop)
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Peak hour */}
              {worstAnalysis.peakHourPctWorst > worstAnalysis.peakHourPctAll * 1.5 && (
                <div className="text-[9px] font-mono p-2 rounded border mb-3" style={{ borderColor: "#eab30830", color: "#eab308", background: "#eab30808" }}>
                  ⏰ Peak hour for worst trades: <strong>{worstAnalysis.peakHour}:00 UTC</strong> ({worstAnalysis.peakHourPctWorst.toFixed(0)}% of worst vs {worstAnalysis.peakHourPctAll.toFixed(0)}% of all)
                </div>
              )}

              {/* Interpretation */}
              <div className="text-[9px] font-mono text-[var(--text-dim)] leading-relaxed space-y-1">
                {worstAnalysis.longPctWorst > worstAnalysis.longPctAll + 15 && (
                  <div>⚠️ <strong style={{ color: "#ef4444" }}>LONG-dominated losses</strong> — {worstAnalysis.longPctWorst.toFixed(0)}% of worst trades are longs vs {worstAnalysis.longPctAll.toFixed(0)}% overall. Long entries may need tighter filtering.</div>
                )}
                {worstAnalysis.longPctWorst < worstAnalysis.longPctAll - 15 && (
                  <div>⚠️ <strong style={{ color: "#ef4444" }}>SHORT-dominated losses</strong> — {(100 - worstAnalysis.longPctWorst).toFixed(0)}% of worst trades are shorts vs {(100 - worstAnalysis.longPctAll).toFixed(0)}% overall. Short entries may need tighter filtering.</div>
                )}
                {worstAnalysis.clusterRatio < 0.5 && (
                  <div>⚠️ <strong style={{ color: "#ef4444" }}>Worst trades are CLUSTERED</strong> — they occur in bursts, not randomly. Suggests a regime or market condition that the strategy can't handle. Consider a drawdown circuit-breaker.</div>
                )}
                {worstAnalysis.topCoinPct > 30 && (
                  <div>⚠️ <strong style={{ color: "#ef4444" }}>{worstAnalysis.coinEntries[0][0].replace("USDT","")} over-represented</strong> in worst trades ({worstAnalysis.topCoinPct.toFixed(0)}%). Consider excluding or reducing exposure.</div>
                )}
                {worstAnalysis.avgCycleWorst > worstAnalysis.avgCycleAll * 1.2 && (
                  <div>📊 Worst trades use longer cycles (avg {worstAnalysis.avgCycleWorst.toFixed(0)} vs {worstAnalysis.avgCycleAll.toFixed(0)} overall). Longer cycles may produce larger losses when wrong.</div>
                )}
                {worstAnalysis.avgCycleWorst < worstAnalysis.avgCycleAll * 0.8 && (
                  <div>📊 Worst trades use shorter cycles (avg {worstAnalysis.avgCycleWorst.toFixed(0)} vs {worstAnalysis.avgCycleAll.toFixed(0)} overall). Short cycles may be triggering on noise.</div>
                )}
              </div>

              {/* Individual worst trades table */}
              <details className="mt-3">
                <summary className="text-[9px] font-mono text-[var(--text-dim)] cursor-pointer hover:text-[var(--text)]">Show individual worst trades ({worstTrades.length})</summary>
                <table className="w-full text-[8px] font-mono border-collapse mt-2">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      {["Coin","Dir","Return","Cycle","Str","Hold","Time"].map(h => (
                        <th key={h} className="py-1 px-1.5 text-left text-[var(--text-dim)] font-normal">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {worstTrades.slice(0, 30).map((t, i) => (
                      <tr key={i} className="border-b border-[var(--border)] border-opacity-20">
                        <td className="py-1 px-1.5 font-semibold">{t.coin.replace("USDT","")}</td>
                        <td className="py-1 px-1.5" style={{ color: t.type === "LONG" ? "#22c55e" : "#ef4444" }}>{t.type}</td>
                        <td className="py-1 px-1.5 font-bold tabular-nums" style={{ color: "#ef4444" }}>{t.returnPct.toFixed(2)}%</td>
                        <td className="py-1 px-1.5 tabular-nums">{t.maxCycle}</td>
                        <td className="py-1 px-1.5 tabular-nums">{t.strength}</td>
                        <td className="py-1 px-1.5 tabular-nums">{t.holdDuration}</td>
                        <td className="py-1 px-1.5 text-[var(--text-dim)]">{t.time ? new Date(t.time).toISOString().slice(5, 16).replace("T"," ") : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}
        </div>
      )}
    </>
  );
}
