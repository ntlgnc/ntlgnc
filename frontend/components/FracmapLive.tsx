"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { adminFetch } from "@/lib/admin-fetch";

const GOLD = "#D4A843";
const GOLD_DIM = "rgba(212,168,67,0.08)";
const FALLBACK_COINS = ["ETHUSDT","BTCUSDT","XRPUSDT","SOLUSDT","BNBUSDT","ADAUSDT","DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT","SHIBUSDT","UNIUSDT","TRXUSDT","XLMUSDT","BCHUSDT","HBARUSDT","ZECUSDT","SUIUSDT","TONUSDT"];
let ALL_COINS = [...FALLBACK_COINS];
// Dynamically load coin list from DB
fetch("/api/coins").then(r => r.json()).then(d => { if (d.coins?.length > 0) ALL_COINS = d.coins; }).catch(() => {});
const DEFAULT_EXCLUDED = new Set<string>(); // No default exclusions — users control via coin selector

function getExcludedCoins(): Set<string> {
  try { const s = sessionStorage.getItem("fracmap_excluded_coins"); if (s) return new Set<string>(JSON.parse(s)); } catch {}
  return DEFAULT_EXCLUDED;
}
function getActiveCoins(): string[] { const ex = getExcludedCoins(); return ALL_COINS.filter(c => !ex.has(c)); }
const REFRESH_MS = 10000;
const COINS_PER_TICK = 3;
const ORDER_COLORS: Record<number,{base:string}> = {1:{base:"rgba(212,168,67,"},2:{base:"rgba(230,140,50,"},3:{base:"rgba(220,100,60,"},4:{base:"rgba(200,80,80,"},5:{base:"rgba(160,80,180,"},6:{base:"rgba(80,120,200,"}};
const ORDER_HEX: Record<number,string> = {1:"#D4A843",2:"#E68C32",3:"#DC643C",4:"#C85050",5:"#A050B4",6:"#5078C8"};

type Strategy={id:string;name:string;type:string;barMinutes:number;symbol:string|null;minStr:number;minCyc:number;spike:boolean;nearMiss:boolean;holdDiv:number;priceExt?:boolean;isSharpe:number|null;oosSharpe:number|null;bootP:number|null;winRate:number|null;active:boolean;cycleMin?:number;cycleMax?:number};
type TradeRecord={id:string;dbId?:string;coin:string;type:"LONG"|"SHORT";entryPrice:number;entryTime:string;strength:number;holdBars:number;barMinutes:number;status:"open"|"closed";currentPrice?:number;unrealizedPct?:number;exitPrice?:number;returnPct?:number;closedTime?:string;triggerBands?:{cycle:number;order:number}[];exitTimeEstimate?:string;maxCycle?:number;maxOrder?:number};
type CoinState={symbol:string;lastPrice:number;change1m:number;bars:any[];bands:any[]};
type EquityPoint={time:string;cumReturn:number;tradeCount:number};

// Compact price display: 0.00001234 → "0.₄1234" (subscript = leading zeros after decimal)
function fmtPrice(p: number): string {
  if (p >= 1) return p.toFixed(p >= 100 ? 2 : 4);
  const s = p.toFixed(10);
  const m = s.match(/^0\.(0+)/);
  if (!m || m[1].length < 3) return p.toFixed(6);
  const zeros = m[1].length;
  const sig = s.slice(2 + zeros, 2 + zeros + 4).replace(/0+$/, "");
  return `0.₀${zeros > 9 ? zeros : ""}${zeros <= 9 ? String.fromCharCode(8320 + zeros) : ""}${sig}`.replace("₀", "");
}
// React version with styled subscript
function FmtPrice({ p }: { p: number }) {
  if (p >= 1) return <>{p.toFixed(p >= 100 ? 2 : 4)}</>;
  const s = p.toFixed(10);
  const m = s.match(/^0\.(0+)/);
  if (!m || m[1].length < 3) return <>{p.toFixed(6)}</>;
  const zeros = m[1].length;
  const sig = s.slice(2 + zeros, 2 + zeros + 4).replace(/0+$/, "") || "0";
  return <>0.<sub style={{fontSize:"0.7em",opacity:0.5}}>{zeros}</sub>{sig}</>;
}

const PAD={top:20,right:58,bottom:30,left:10};
const EP={top:20,right:58,bottom:30,left:55};

export default function FracmapLive(){
  const [strategies,setStrategies]=useState<Strategy[]>([]);
  const [activeStrategy,setActiveStrategy]=useState<Strategy|null>(null);
  const [perCoinStrategies,setPerCoinStrategies]=useState<Strategy[]>([]);
  const [stratMode,setStratMode]=useState<"universal"|"per_coin">("universal");
  const [coinStates,setCoinStates]=useState<Record<string,CoinState>>({});
  const [selectedCoin,setSelectedCoin]=useState("BTCUSDT");
  const [filterCoin,setFilterCoin]=useState<string|null>(null); // null = show all coins
  const [isLive,setIsLive]=useState(false);
  const [lastTick,setLastTick]=useState("");
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [yAxisMode,setYAxisMode]=useState<"tight"|"padded"|"free">("padded");
  const [shadingMode,setShadingMode]=useState<"valley"|"channel">("valley");
  const [chartView,setChartView]=useState<"price"|"equity">("price");
  const [chartBars,setChartBars]=useState(0); // 0 = auto (2x cycle)
  const [equityWindow,setEquityWindow]=useState(60);
  const [equityHistory,setEquityHistory]=useState<EquityPoint[]>([]);
  const [equityResetTime,setEquityResetTime]=useState(Date.now());
  const [now,setNow]=useState(Date.now());
  // ── Diagnostic mode ──
  const [showDiag,setShowDiag]=useState(false);
  const [togglingIds,setTogglingIds]=useState<Set<string>>(new Set());
  const [togglingAll,setTogglingAll]=useState<string|null>(null); // "1-on", "60-off" etc
  const [diagRunning,setDiagRunning]=useState(false);
  const [diagCoin,setDiagCoin]=useState("XRPUSDT");
  const [diagResults,setDiagResults]=useState<{
    coin:string; barsFull:number; barsLive:number; bandCount:number;
    scannerSigs:any[]; liveSigs:any[];
    scannerLast20:any[]; liveLast20:any[];
    match:boolean; divergeIdx:number|null;
  }|null>(null);
  const timerRef=useRef<any>(null);
  const countdownRef=useRef<any>(null);
  const svgRef=useRef<SVGSVGElement>(null);
  const chartContainerRef=useRef<HTMLDivElement>(null);
  // Dynamic chart dimensions — measured from actual container
  const [chartW,setChartW]=useState(0);
  const [chartH,setChartH]=useState(0);
  const bandOpacity=0.08;

  // ══════════════════════════════════════════════════════════════
  // BUG FIX: Stable trade storage using refs
  // Trades are stored in a ref as the source of truth.
  // A mutex lock prevents concurrent refresh calls from clobbering each other.
  // ══════════════════════════════════════════════════════════════
  const tradesRef = useRef<TradeRecord[]>([]);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const knownKeysRef = useRef<Set<string>>(new Set());

  // Persist trades to sessionStorage
  const persistTrades = useCallback((t: TradeRecord[]) => {
    try { sessionStorage.setItem("fracmap_live_trades", JSON.stringify(t.slice(-200))); } catch {}
  }, []);

  // Restore trades from sessionStorage on mount
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("fracmap_live_trades");
      if (s) {
        const raw: TradeRecord[] = JSON.parse(s);
        // Deduplicate: only keep one open trade per coin
        const seenOpen = new Set<string>();
        const restored = raw.filter(t => {
          if (t.status === "open") {
            if (seenOpen.has(t.coin)) return false;
            seenOpen.add(t.coin);
          }
          return true;
        });
        if (restored.length > 0) {
          tradesRef.current = restored;
          for (const t of restored) knownKeysRef.current.add(t.id);
          setTrades(restored);
        }
      }
    } catch {}
  }, []);
  const refreshLockRef = useRef(false);
  // Bar cache: skip band recomputation if the last bar timestamp hasn't changed
  const barCacheRef = useRef<Record<string, { lastBarTime: string; state: CoinState }>>({});
  // Keep strategy refs in sync so refresh closure doesn't go stale
  const activeStratRef = useRef<Strategy|null>(null);
  const perCoinStratRef = useRef<Strategy[]>([]);
  const stratModeRef = useRef<"universal"|"per_coin">("universal");
  const equityResetRef = useRef(Date.now());
  useEffect(()=>{ activeStratRef.current = activeStrategy; },[activeStrategy]);
  useEffect(()=>{ perCoinStratRef.current = perCoinStrategies; },[perCoinStrategies]);
  useEffect(()=>{ stratModeRef.current = stratMode; },[stratMode]);
  useEffect(()=>{ equityResetRef.current = equityResetTime; },[equityResetTime]);

  // Countdown timer — update "now" every second for live countdowns
  useEffect(() => {
    if (isLive) {
      countdownRef.current = setInterval(() => setNow(Date.now()), 1000);
    } else {
      if (countdownRef.current) clearInterval(countdownRef.current);
    }
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [isLive]);


  useEffect(()=>{
    const m=()=>{
      if(chartContainerRef.current){
        setChartW(chartContainerRef.current.offsetWidth);
        setChartH(chartContainerRef.current.offsetHeight);
      }
    };
    m();
    const ro=new ResizeObserver(m);
    if(chartContainerRef.current)ro.observe(chartContainerRef.current);
    return()=>ro.disconnect();
  },[coinStates,selectedCoin,yAxisMode,shadingMode,chartView]);

  useEffect(()=>{adminFetch("/api/fracmap-strategy?action=list").then(r=>r.json()).then(d=>{if(d.strategies){setStrategies(d.strategies);const u=d.strategies.filter((s:Strategy)=>s.type==="universal"&&s.active),p=d.strategies.filter((s:Strategy)=>(s.type==="per_coin"||s.type==="coin_specific")&&s.active);if(u.length>0)setActiveStrategy(u[0]);if(p.length>0)setPerCoinStrategies(p);}setLoading(false);}).catch(e=>{setError(e.message);setLoading(false);});},[]);

  // Load historical trades from DB on mount AND when strategy changes (last 24h)
  const loadHistorical=useCallback(()=>{
    const stratId=activeStrategy?.id;
    const stratFilter=stratId?`&strategyId=${stratId}`:"";
    adminFetch(`/api/fracmap-strategy?action=signals&status=closed&limit=500${stratFilter}`).then(r=>r.json()).then(d=>{
      if(!d.signals)return;
      const cutoff=Date.now()-24*3600000;
      const historical:TradeRecord[]=d.signals
        .filter((s:any)=>new Date(s.createdAt).getTime()>cutoff)
        .map((s:any)=>({
          id:s.id, dbId:s.id, coin:s.symbol, type:s.direction as "LONG"|"SHORT",
          entryPrice:s.entryPrice, entryTime:s.createdAt, strength:s.strength||1,
          holdBars:s.holdBars||5, barMinutes:1, status:"closed" as const,
          exitPrice:s.exitPrice, returnPct:s.returnPct, closedTime:s.closedAt,
          maxCycle:s.maxCycle||undefined, maxOrder:s.maxOrder||undefined,
          triggerBands:s.triggerBands??(typeof s.triggerBands==="string"?JSON.parse(s.triggerBands):undefined),
        }));
      // Replace closed trades entirely (clean slate for this strategy)
      const openTrades=tradesRef.current.filter(t=>t.status==="open");
      tradesRef.current=[...openTrades,...historical];
      historical.forEach(t=>knownKeysRef.current.add(t.id));
      setTrades([...tradesRef.current]);
      persistTrades(tradesRef.current);
      const sorted=[...historical].sort((a,b)=>new Date(a.closedTime||a.entryTime).getTime()-new Date(b.closedTime||b.entryTime).getTime());
      let cum=0;const eqPts:EquityPoint[]=sorted.map(t=>{cum+=(t.returnPct||0);return{time:t.closedTime||t.entryTime,cumReturn:cum,tradeCount:0};});
      if(eqPts.length>0)setEquityHistory(eqPts);
    }).catch(()=>{});
    // Also load open signals — only recent ones (stale opens are dead)
    adminFetch(`/api/fracmap-strategy?action=signals&status=open&limit=100${stratFilter}`).then(r=>r.json()).then(d=>{
      if(!d.signals||!d.signals.length)return;
      const recentCutoff=Date.now()-2*3600000; // only opens from last 2 hours
      const openSigs:TradeRecord[]=d.signals
        .filter((s:any)=>new Date(s.createdAt).getTime()>recentCutoff)
        .map((s:any)=>({
        id:s.id, dbId:s.id, coin:s.symbol, type:s.direction as "LONG"|"SHORT",
        entryPrice:s.entryPrice, entryTime:s.createdAt, strength:s.strength||1,
        holdBars:s.holdBars||5, barMinutes:1, status:"open" as const,
        exitTimeEstimate:s.holdBars?new Date(new Date(s.createdAt).getTime()+s.holdBars*60000).toISOString():undefined,
        maxCycle:s.maxCycle||undefined, maxOrder:s.maxOrder||undefined,
        triggerBands:s.triggerBands??(typeof s.triggerBands==="string"?JSON.parse(s.triggerBands):undefined),
      }));
      const existingIds=new Set(tradesRef.current.map(t=>t.id));
      const existingOpenCoins=new Set(tradesRef.current.filter(t=>t.status==="open").map(t=>t.coin));
      const newOnes=openSigs.filter(t=>!existingIds.has(t.id)&&!existingOpenCoins.has(t.coin));
      if(newOnes.length>0){
        tradesRef.current=[...newOnes,...tradesRef.current];
        newOnes.forEach(t=>knownKeysRef.current.add(t.id));
        setTrades([...tradesRef.current]);
        persistTrades(tradesRef.current);
      }
    }).catch(()=>{});
  },[activeStrategy]);

  // Load on mount and whenever strategy changes
  useEffect(()=>{loadHistorical();},[loadHistorical]);

  const getStrat=useCallback((sym:string):Strategy|null=>{
    if(stratModeRef.current==="per_coin"){const p=perCoinStratRef.current.find(s=>s.symbol===sym);if(p)return p;}
    return activeStratRef.current;
  },[]);

  const refreshCoin=useCallback(async(sym:string,st:Strategy):Promise<{state:CoinState;signals:any[]}|null>=>{
    try{
    const cMax = st.cycleMax ?? 100;
    const cMin = st.cycleMin ?? 10;

    // Server-side computation — bands + signals computed on server
    const res=await adminFetch("/api/fracmap/compute",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        action:"liveDetect",symbol:sym,barMinutes:st.barMinutes,
        cycleMin:cMin,cycleMax:cMax,
        minStr:Number(st.minStr)||1,minCyc:Number(st.minCyc)||0,
        spike:!!st.spike,nearMiss:!!st.nearMiss,holdDiv:Number(st.holdDiv)||2,priceExt:true,
      }),
    });
    const data=await res.json();
    if(!data.bars||data.bars.length<50)return null;

    // Cache check: skip if same last bar
    const lastBarTime = data.bars[data.bars.length - 1]?.time;
    const cached = barCacheRef.current[sym];
    if (cached && cached.lastBarTime === lastBarTime) {
      const lastBar = data.bars[data.bars.length - 1];
      const prevBar = data.bars.length > 1 ? data.bars[data.bars.length - 2] : lastBar;
      return { state: { ...cached.state, lastPrice: lastBar.close, change1m: ((lastBar.close - prevBar.close) / prevBar.close) * 100 }, signals: data.signals || [] };
    }

    const bars=data.bars.map((b:any)=>({time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume||0}));
    const bands=data.bands||[];
    const last=bars[bars.length-1],prev=bars.length>1?bars[bars.length-2]:last;
    const state: CoinState = {symbol:sym,lastPrice:last.close,change1m:((last.close-prev.close)/prev.close)*100,bars,bands};
    barCacheRef.current[sym] = { lastBarTime, state };
    return {state,signals:data.signals||[]};}catch{return null;}
  },[]);

  const coinIdxRef = useRef(0);

  const refresh=useCallback(async()=>{
    if(refreshLockRef.current) return;
    refreshLockRef.current = true;

    try {
    if(!activeStratRef.current&&perCoinStratRef.current.length===0){ refreshLockRef.current=false; return; }

    // Round-robin: process 1 coin per tick
    const ac = getActiveCoins();
    if (ac.length === 0) { refreshLockRef.current = false; return; }
    const sym = ac[coinIdxRef.current % ac.length];
    coinIdxRef.current++;
    const st=getStrat(sym);
    if(!st){ refreshLockRef.current=false; return; }
    if(coinIdxRef.current <= 2) console.log("[FracmapLive] Strategy loaded:", {minStr:st.minStr, minCyc:st.minCyc, spike:st.spike, nearMiss:st.nearMiss, holdDiv:st.holdDiv, priceExt:st.priceExt, cycleMin:st.cycleMin, cycleMax:st.cycleMax, types: {minStr:typeof st.minStr, minCyc:typeof st.minCyc, cycleMin:typeof st.cycleMin, cycleMax:typeof st.cycleMax}});
    // ═══ FIX: Validate strategy params before computing signals ═══
    const stMinStr = Number(st.minStr) || 1;
    const stMinCyc = Number(st.minCyc) ?? 0;  // minCyc=0 means "any cycle"
    const stHoldDiv = Number(st.holdDiv) || 2;
    const stSpike = !!st.spike;
    const stNearMiss = !!st.nearMiss;
    // Warn if strategy looks misconfigured (cycleMin/cycleMax null = DB migration issue)
    if (st.cycleMin == null || st.cycleMax == null) {
      console.warn(`[FracmapLive] ⚠️ Strategy "${st.name}" has null cycleMin/cycleMax — using defaults. Re-save from scanner to fix.`);
    }
    const result=await refreshCoin(sym,st);
    if(!result){ refreshLockRef.current=false; return; }
    const {state,signals:sigs}=result;

    setCoinStates(prev => ({...prev, [sym]: state}));

    console.log(`[LIVE] ${sym} bars=${state.bars.length} bands=${state.bands.length} sigs=${sigs.length} str=${stMinStr} cyc=${stMinCyc} spike=${stSpike} cRange=${st.cycleMin ?? '??'}-${st.cycleMax ?? '??'}`);

    const currentTrades = [...tradesRef.current];

    // Update open trades for this coin
    currentTrades.forEach((t, idx) => {
      if (t.coin === sym && t.status === "open") {
        const u = t.type === "LONG"
          ? ((state.lastPrice / t.entryPrice) - 1) * 100
          : ((t.entryPrice / state.lastPrice) - 1) * 100;
        currentTrades[idx] = { ...t, currentPrice: state.lastPrice, unrealizedPct: u };

        const entryMs = new Date(t.entryTime).getTime();
        const holdMs = t.holdBars * t.barMinutes * 60 * 1000;
        if (Date.now() >= entryMs + holdMs) {
          const retPct = u;
          currentTrades[idx] = {
            ...currentTrades[idx], status: "closed", exitPrice: state.lastPrice,
            returnPct: retPct, closedTime: new Date().toISOString(),
          };
          if (currentTrades[idx].dbId) {
            adminFetch("/api/fracmap-strategy", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "closeSignal", id: currentTrades[idx].dbId,
                exitPrice: state.lastPrice, returnPct: retPct, status: "closed",
              }),
            }).catch(() => {});
          }
        }
      }
    });

    // New signals — enter if the most recent signal is still within its hold period
    if (sigs.length > 0) {
      const l = sigs[sigs.length - 1];
      // Round entry time to nearest minute for stable key (prevents near-duplicate keys from time drift)
      const roundedMs = Math.round(new Date(l.time).getTime() / 60000) * 60000;
      const k = `${sym}_${new Date(roundedMs).toISOString()}_${l.type}`;
      const ba = state.bars.length - 1 - l.entryIdx;

      // Primary guard: never open a second trade on the same coin
      const hasOpen = currentTrades.some(t => t.coin === sym && t.status === "open");
      if (!hasOpen && !knownKeysRef.current.has(k) && ba < l.holdDuration) {
          console.log(`[SIGNAL] ${sym} ${l.type} str=${l.strength} maxC=${l.maxCycle} maxO=${l.maxOrder} ba=${ba} price=${l.entryPrice} bands=${l.triggerBands?.map((b:any)=>`C${b.cycle}φ${b.order}`).join(",")}`);
          const bar = state.bars[l.entryIdx];
          if (bar) console.log(`[SIGNAL BAR] open=${bar.open} high=${bar.high} low=${bar.low} close=${bar.close}`);
          const u = l.type === "LONG"
            ? ((state.lastPrice / l.entryPrice) - 1) * 100
            : ((l.entryPrice / state.lastPrice) - 1) * 100;
          const barMs = st.barMinutes * 60 * 1000;
          const entryMs = new Date(l.time).getTime();
          const exitEstimate = new Date(entryMs + l.holdDuration * barMs).toISOString();

          const newTrade: TradeRecord = {
            id: k, coin: sym, type: l.type, entryPrice: l.entryPrice, entryTime: l.time,
            strength: l.strength, holdBars: l.holdDuration, barMinutes: st.barMinutes,
            status: "open", currentPrice: state.lastPrice, unrealizedPct: u,
            triggerBands: l.triggerBands || [{cycle: l.maxCycle, order: l.maxOrder}],
            maxCycle: l.maxCycle, maxOrder: l.maxOrder,
            exitTimeEstimate: exitEstimate,
          };
          currentTrades.unshift(newTrade);
          knownKeysRef.current.add(k);

          const stratId = st.id;
          if (stratId) {
            adminFetch("/api/fracmap-strategy", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "recordSignal", strategyId: stratId, symbol: sym,
                direction: l.type, entryPrice: l.entryPrice,
                strength: l.strength, holdBars: l.holdDuration,
                maxCycle: l.maxCycle, maxOrder: l.maxOrder,
                triggerBands: l.triggerBands || [],
              }),
            }).then(r => r.json()).then(d => {
              if (d.signal?.id) {
                const ti = tradesRef.current.findIndex(t => t.id === k);
                if (ti >= 0) tradesRef.current[ti] = { ...tradesRef.current[ti], dbId: d.signal.id };
              }
            }).catch(() => {});
          }
      }
    }

    tradesRef.current = currentTrades;
    setTrades([...currentTrades]);
    persistTrades(currentTrades);
    setLastTick(new Date().toLocaleTimeString());

    // Update equity from closed trades
    const closedRets = currentTrades.filter(t => t.status === "closed").map(t => t.returnPct || 0);
    const cumClosedReturn = closedRets.reduce((a, b) => a + b, 0);
    const closedCount = closedRets.length;

    setEquityHistory(p => {
      const c = Date.now() - 6 * 3600000;
      const resetTime = equityResetRef.current;
      const filtered = p.filter(x =>
        new Date(x.time).getTime() > c && new Date(x.time).getTime() >= resetTime
      );
      const lastPoint = filtered[filtered.length - 1];
      if (lastPoint && lastPoint.tradeCount === closedCount) return filtered;
      return [...filtered,
        { time: new Date().toISOString(), cumReturn: cumClosedReturn, tradeCount: closedCount }];
    });
    } finally {
      refreshLockRef.current = false;
    }
  },[getStrat,refreshCoin]);

  useEffect(()=>{
    if(isLive){
      refresh();
      // 1 coin every 1.5s = full cycle through 20 coins in 30s
      timerRef.current=setInterval(refresh, 1500);
    } else {
      if(timerRef.current){ clearInterval(timerRef.current); timerRef.current=null; }
    }
    return()=>{if(timerRef.current){ clearInterval(timerRef.current); timerRef.current=null; }};
  },[isLive,refresh]);

  /* ═══ DERIVED ═══ */
  const openT=trades.filter(t=>t.status==="open"),closedT=trades.filter(t=>t.status==="closed");
  const longs=openT.filter(t=>t.type==="LONG").length,shorts=openT.filter(t=>t.type==="SHORT").length;
  const totUnr=openT.reduce((s,t)=>s+(t.unrealizedPct||0),0),avgUnr=openT.length?totUnr/openT.length:0;
  const cRets=closedT.map(t=>t.returnPct||0),cumClosed=cRets.reduce((s,r)=>s+r,0);
  const cWins=cRets.filter(r=>r>0).length,cWinRate=cRets.length?(cWins/cRets.length)*100:0;
  const cSharpe=useMemo(()=>{
    if(cRets.length<2)return 0;
    const times=closedT.map(t=>({entry:new Date(t.entryTime).getTime(),close:new Date(t.closedTime||t.entryTime).getTime(),ret:t.returnPct||0,holdMin:t.holdBars*(t.barMinutes||1)}));
    if(times.length<2)return 0;
    const firstEntry=Math.min(...times.map(t=>t.entry));
    const lastClose=Math.max(...times.map(t=>t.close));
    const totalMinutes=Math.max(1,(lastClose-firstEntry)/60000);
    const totalDays=Math.max(1,totalMinutes/1440);
    // If less than 2 days of data, use per-trade Sharpe (annualized by avg hold time)
    if(totalDays<2){
      const mean=cRets.reduce((s,r)=>s+r,0)/cRets.length;
      const std=Math.sqrt(cRets.reduce((s,r)=>s+(r-mean)**2,0)/cRets.length);
      if(std<=0)return 0;
      const avgHoldMin=times.reduce((s,t)=>s+t.holdMin,0)/times.length;
      return(mean/std)*Math.sqrt(525600/Math.max(1,avgHoldMin));
    }
    // Otherwise use daily bucketing
    const nDays=Math.ceil(totalDays);
    const dailyRets=new Array(nDays).fill(0);
    for(const t of times){
      const dayIdx=Math.min(nDays-1,Math.floor((t.close-firstEntry)/86400000));
      dailyRets[dayIdx]+=t.ret;
    }
    let dS=0,dS2=0;
    for(const d of dailyRets){dS+=d;dS2+=d*d;}
    const dMean=dS/nDays;
    const dVar=dS2/nDays-dMean*dMean;
    const dStd=Math.sqrt(Math.max(0,dVar));
    if(dStd<=0)return 0;
    return(dMean/dStd)*Math.sqrt(365);
  },[closedT]);

  /* ═══ COUNTDOWN HELPER ═══ */
  const getCountdown = useCallback((t: TradeRecord): string => {
    if (t.status === "closed") return "Closed";
    if (!t.exitTimeEstimate) return `${t.holdBars}b`;
    const exitMs = new Date(t.exitTimeEstimate).getTime();
    const remaining = exitMs - now;
    if (remaining <= 0) return "Closing...";
    const totalSec = Math.floor(remaining / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      return `${hrs}h ${remMins}m`;
    }
    return `${mins}m ${String(secs).padStart(2, "0")}s`;
  }, [now]);

  /* ═══ PRICE CHART CALC ═══ */
  const sel=coinStates[selectedCoin],cSt=getStrat(selectedCoin);
  // ═══ FIX: Use nullish coalescing for maxCycle — must match band computation range ═══
  const maxCycle = cSt?.cycleMax ?? 100;
  const autoChartBars = maxCycle * 2;
  const effectiveChartBars = chartBars > 0 ? chartBars : autoChartBars;
  const plotW=chartW-PAD.left-PAD.right,plotH=chartH-PAD.top-PAD.bottom;
  const aB=sel?.bars||[],aBands=sel?.bands||[],vB=aB.slice(-effectiveChartBars),vs=Math.max(0,aB.length-effectiveChartBars);
  const proj=7,ts=vB.length+proj,slW=plotW/(ts||1),bdW=Math.max(1,slW*0.55);
  let mn=Infinity,mx=-Infinity;vB.forEach((b:any)=>{if(b.high>mx)mx=b.high;if(b.low<mn)mn=b.low;});
  if(mn===Infinity){mn=0;mx=1;}
  if(yAxisMode==="tight"){const r=mx-mn||1;mx+=r*0.02;mn-=r*0.02;}
  else if(yAxisMode==="padded"){const r=mx-mn||1;mx+=r*0.10;mn-=r*0.10;}
  else{const e=vs+vB.length+proj;aBands.forEach((b:any)=>{for(let i=vs;i<e;i++){if(i<b.lower.length&&b.lower[i]!=null&&b.lower[i]<mn)mn=b.lower[i];if(i<b.upper.length&&b.upper[i]!=null&&b.upper[i]>mx)mx=b.upper[i];}});}
  const rng=mx-mn||1,toX=(i:number)=>PAD.left+(i+0.5)*slW,toY=(p:number)=>PAD.top+plotH-((p-mn)/rng)*plotH;
  const srtB=useMemo(()=>[...aBands].sort((a,b)=>b.order!==a.order?b.order-a.order:b.cycle-a.cycle),[aBands]);
  // Build chart markers from actual trades (stable — won't disappear on re-render)
  const vSig = useMemo(() => {
    if (!vB || vB.length === 0) return [];
    const markers: any[] = [];
    for (const t of trades) {
      if (t.coin !== selectedCoin) continue;
      const tMs = new Date(t.entryTime).getTime();
      // Find the closest bar by time (not first within tolerance)
      let bestIdx = -1, bestDiff = Infinity;
      for (let bi = 0; bi < vB.length; bi++) {
        const diff = Math.abs(new Date(vB[bi].time).getTime() - tMs);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = bi; }
      }
      if (bestIdx < 0 || bestDiff > 120000) continue; // 2 min max
      markers.push({
        entryIdx: bestIdx,
        entryPrice: t.entryPrice,
        type: t.type,
        strength: t.strength,
        status: t.status,
        coin: t.coin,
        entryTime: t.entryTime,
        maxCycle: t.maxCycle,
        maxOrder: t.maxOrder,
        unrealizedPct: t.unrealizedPct,
        returnPct: t.returnPct,
        holdBars: t.holdBars,
      });
    }
    return markers;
  }, [trades, selectedCoin, vB]);
  const yT:number[]=[];for(let i=0;i<=6;i++)yT.push(mn+(rng/6)*i);
  const selTr=openT.find(t=>t.coin===selectedCoin);
  const tK=useMemo(()=>{const k=new Set<string>();if(selTr?.triggerBands){const tb=typeof selTr.triggerBands==="string"?JSON.parse(selTr.triggerBands):selTr.triggerBands;if(Array.isArray(tb))tb.forEach((t:any)=>k.add(`${t.cycle}-${t.order}`));}return k;},[selTr]);
  const hT=tK.size>0;

  /* ═══ EQUITY CALC ═══ */
  // Build closed trade rows with cumulative
  const closedWithCum = useMemo(() => {
    // Sort by closedTime ascending for cumulative calc
    const sorted = [...closedT].sort((a, b) =>
      new Date(a.closedTime || a.entryTime).getTime() - new Date(b.closedTime || b.entryTime).getTime()
    );
    let cum = 0;
    const withCum = sorted.map(t => { cum += (t.returnPct || 0); return { ...t, cumPct: cum }; });
    // Reverse for display — most recent exit at top
    return withCum.reverse();
  }, [closedT]);

  // Build equity curve from actual closed trades (sorted chronologically with cumulative)
  const eqCum=useMemo(()=>{
    // closedWithCum is reverse-chronological, we need chronological for the chart
    const chrono = [...closedWithCum].reverse();
    if(!chrono.length)return[];
    return chrono.map(t=>({time:t.closedTime||t.entryTime,value:t.cumPct}));
  },[closedWithCum]);
  const ePW=chartW-EP.left-EP.right,ePH=chartH-EP.top-EP.bottom;
  let eMin=0,eMax=0;eqCum.forEach(p=>{if(p.value<eMin)eMin=p.value;if(p.value>eMax)eMax=p.value;});
  const eP=(eMax-eMin)*0.1||0.01;eMin-=eP;eMax+=eP;const eR=eMax-eMin||1;
  const eX=(i:number)=>EP.left+(i/Math.max(eqCum.length-1,1))*ePW;
  const eY=(v:number)=>EP.top+ePH-((v-eMin)/eR)*ePH;

  /* ═══ DIAGNOSTIC: Compare full-data vs live-data signal detection ═══ */
  const runDiagnostic = useCallback(async (coin: string) => {
    if (!activeStrategy) return;
    setDiagRunning(true); setDiagResults(null);
    const st = activeStrategy;
    const cMin = st.cycleMin ?? 10, cMax = st.cycleMax ?? 100;
    const params = { barMinutes:st.barMinutes, cycleMin:cMin, cycleMax:cMax, minStr:Number(st.minStr)||1, minCyc:Number(st.minCyc)||0, spike:!!st.spike, holdDiv:Number(st.holdDiv)||2, nearMiss:!!st.nearMiss, priceExt:true };
    try {
      // 1. Full-data signals (scanner-equivalent) via computeOOS with all bars
      const resFull = await adminFetch("/api/fracmap/compute", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ action:"computeOOS", symbol:coin, ...params, splitPct:0 }),
      });
      const dataFull = await resFull.json();
      const scannerSigs = dataFull.oosSignals || [];
      const fullBarCount = dataFull.oosBars?.length || 0;

      // 2. Live-data signals (live-equivalent) via liveDetect
      const resLive = await adminFetch("/api/fracmap/compute", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ action:"liveDetect", symbol:coin, ...params }),
      });
      const dataLive = await resLive.json();
      const liveSigs = dataLive.signals || [];
      const liveBarCount = dataLive.bars?.length || 0;

      // Compare last 20 signals
      const sLast = scannerSigs.slice(-20).map((s: any) => ({ type: s.type, idx: s.entryIdx, price: s.entryPrice, time: s.time, str: s.strength, maxC: s.maxCycle, hold: s.holdDuration, ret: s.returnPct }));
      const lLast = liveSigs.slice(-20).map((s: any) => ({ type: s.type, idx: s.entryIdx, price: s.entryPrice, time: s.time, str: s.strength, maxC: s.maxCycle, hold: s.holdDuration, ret: s.returnPct }));

      // Find first divergence point in the tail
      const tailLen = Math.min(scannerSigs.length, liveSigs.length, 50);
      let divergeIdx: number | null = null;
      for (let i = 1; i <= tailLen; i++) {
        const sS = scannerSigs[scannerSigs.length - i];
        const lS = liveSigs[liveSigs.length - i];
        if (sS.time !== lS.time || sS.type !== lS.type) { divergeIdx = i; break; }
      }

      console.log(`[DIAG] ${coin}: fullBars=${fullBarCount} liveBars=${liveBarCount} scannerSigs=${scannerSigs.length} liveSigs=${liveSigs.length}`);

      setDiagResults({
        coin, barsFull: fullBarCount, barsLive: liveBarCount, bandCount: (cMax-cMin+1)*6,
        scannerSigs, liveSigs,
        scannerLast20: sLast, liveLast20: lLast,
        match: divergeIdx === null, divergeIdx,
      });
    } catch (e: any) {
      console.error("[DIAG] Error:", e);
    }
    setDiagRunning(false);
  }, [activeStrategy]);

  if(loading)return <div className="p-8 text-center text-[var(--text-dim)] font-mono text-sm">Loading strategies...</div>;
  if(error)return <div className="p-8 text-center text-red-400 font-mono text-sm">{error}</div>;
  const uS=strategies.filter(s=>s.type==="universal");

  /* ═══ BAND RENDER HELPER ═══ */
  const renderBands = () => {
    const nodes: React.ReactNode[] = [];
    for (const o of [6,5,4,3,2,1]) {
      const bands = srtB.filter(b => b.order === o);
      if (!bands.length) continue;
      const ci = ORDER_COLORS[o], cT = PAD.top, cB = PAD.top + plotH;
      bands.forEach((band, bi) => {
        const it = tK.has(`${band.cycle}-${band.order}`);
        const op = hT ? (it ? 0.25 : 0.005) : bandOpacity;
        if (shadingMode === "valley") {
          const uP: {i:number;u:number}[] = [], lP: {i:number;l:number}[] = [];
          for (let i = 0; i < ts; i++) { const gi = vs + i; if (gi < band.upper.length && band.upper[gi] != null) uP.push({i, u: band.upper[gi]!}); if (gi < band.lower.length && band.lower[gi] != null) lP.push({i, l: band.lower[gi]!}); }
          if (uP.length >= 2) { let p = uP.map((pt, j) => `${j===0?"M":"L"}${toX(pt.i).toFixed(1)},${toY(pt.u).toFixed(1)}`).join(" "); p += ` L${toX(uP[uP.length-1].i).toFixed(1)},${cT} L${toX(uP[0].i).toFixed(1)},${cT} Z`; nodes.push(<path key={`u${o}${bi}`} d={p} fill={ci.base+op+")"}/>); }
          if (lP.length >= 2) { let p = lP.map((pt, j) => `${j===0?"M":"L"}${toX(pt.i).toFixed(1)},${toY(pt.l).toFixed(1)}`).join(" "); p += ` L${toX(lP[lP.length-1].i).toFixed(1)},${cB} L${toX(lP[0].i).toFixed(1)},${cB} Z`; nodes.push(<path key={`l${o}${bi}`} d={p} fill={ci.base+op+")"}/>); }
        } else {
          const pts: {i:number;u:number;l:number}[] = [];
          for (let i = 0; i < ts; i++) { const gi = vs + i; if (gi < band.upper.length && gi < band.lower.length && band.upper[gi] != null && band.lower[gi] != null && band.upper[gi]! > band.lower[gi]!) pts.push({i, u: band.upper[gi]!, l: band.lower[gi]!}); }
          if (pts.length >= 2) { let d = pts.map((p, j) => `${j===0?"M":"L"}${toX(p.i).toFixed(1)},${toY(p.u).toFixed(1)}`).join(" ") + " " + [...pts].reverse().map(p => `L${toX(p.i).toFixed(1)},${toY(p.l).toFixed(1)}`).join(" ") + " Z"; nodes.push(<path key={`c${o}${bi}`} d={d} fill={ci.base+op+")"}/>); }
        }
      });
    }
    return nodes;
  };

  const renderEdges = () => {
    const nodes: React.ReactNode[] = [];
    for (const o of [6,5,4,3,2,1]) {
      const bands = srtB.filter(b => b.order === o), hex = ORDER_HEX[o];
      bands.forEach((band, bi) => {
        const it = tK.has(`${band.cycle}-${band.order}`);
        if (!it && hT) return; // hide non-trigger edges entirely when signal active
        if (!hT && bands.length > 5) { if (bi % Math.max(1, Math.floor(bands.length/3)) !== 0 && bi !== bands.length-1) return; } // thin when no signal
        const eO = hT ? 0.7 : 0.25, eW = it ? 1.2 : 0.4;
        let uP = "", lP = "", uS = false, lS = false;
        for (let i = 0; i < ts; i++) { const gi = vs + i; if (gi < band.upper.length && band.upper[gi] != null) { uP += `${uS?"L":"M"}${toX(i).toFixed(1)},${toY(band.upper[gi]!).toFixed(1)} `; uS = true; } if (gi < band.lower.length && band.lower[gi] != null) { lP += `${lS?"L":"M"}${toX(i).toFixed(1)},${toY(band.lower[gi]!).toFixed(1)} `; lS = true; } }
        nodes.push(<g key={`e${o}${bi}`}>{uP && <path d={uP} fill="none" stroke={hex} strokeWidth={eW} opacity={eO}/>}{lP && <path d={lP} fill="none" stroke={hex} strokeWidth={eW} opacity={eO}/>}</g>);
      });
    }
    return nodes;
  };

  return(
    <div className="space-y-2">
      {/* ACTIVE STRATEGIES PANEL */}
      {(() => {
        const activeStrats = strategies.filter(s => s.active);
        const liveUniversal = activeStrats.filter(s => s.type === "universal");
        const liveCoin = activeStrats.filter(s => s.type === "per_coin" || s.type === "coin_specific");
        const tfLabels: Record<number, string> = { 1: "1M", 15: "15M", 60: "1H", 1440: "1D" };
        const tfOrder = [1, 60, 1440];
        // Add any extra timeframes that have strategies (e.g. 15m)
        for (const s of strategies) {
          if (!tfOrder.includes(s.barMinutes)) tfOrder.push(s.barMinutes);
        }
        tfOrder.sort((a, b) => a - b);
        const grouped = new Map<number, Strategy[]>();
        for (const bm of tfOrder) grouped.set(bm, []);
        for (const s of strategies) {
          const arr = grouped.get(s.barMinutes);
          if (arr) arr.push(s); else grouped.set(s.barMinutes, [s]);
        }

        const handleActivate = async (id: string, bm: number) => {
          setTogglingIds(prev => new Set(prev).add(id));
          // Deactivate any other active strategies for this timeframe first
          const others = (grouped.get(bm) || []).filter(s => s.active && s.id !== id);
          for (const s of others) {
            try {
              await adminFetch("/api/fracmap-strategy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "toggleStrategy", id: s.id, active: false }),
              });
            } catch {}
          }
          // Now activate the chosen one
          try {
            const res = await adminFetch("/api/fracmap-strategy", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "toggleStrategy", id, active: true }),
            });
            const d = await res.json();
            if (d.strategy) {
              setStrategies(prev => prev.map(s => {
                if (s.id === id) return { ...s, active: true };
                if (s.barMinutes === bm && others.some(o => o.id === s.id)) return { ...s, active: false };
                return s;
              }));
            }
          } catch {}
          setTogglingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
        };

        const handleDeactivate = async (id: string) => {
          setTogglingIds(prev => new Set(prev).add(id));
          try {
            const res = await adminFetch("/api/fracmap-strategy", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "toggleStrategy", id, active: false }),
            });
            const d = await res.json();
            if (d.strategy) {
              setStrategies(prev => prev.map(s => s.id === id ? { ...s, active: false } : s));
            }
          } catch {}
          setTogglingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
        };

        const handleDeactivateAll = async (bm: number) => {
          const key = `${bm}-off`;
          setTogglingAll(key);
          const targets = (grouped.get(bm) || []).filter(s => s.active);
          for (const s of targets) {
            try {
              await adminFetch("/api/fracmap-strategy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "toggleStrategy", id: s.id, active: false }),
              });
            } catch {}
          }
          setStrategies(prev => prev.map(s => s.barMinutes === bm && targets.some(t => t.id === s.id) ? { ...s, active: false } : s));
          setTogglingAll(null);
        };

        return (
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-[11px] font-mono font-bold tracking-wide" style={{ color: GOLD }}>Live Strategies</span>
              <span className="text-[9px] font-mono text-[var(--text-dim)]">
                {liveUniversal.length} universal live{liveCoin.length > 0 ? ` + ${liveCoin.length} coin-specific` : ""} · {strategies.length} available across {new Set(strategies.map(s => s.barMinutes)).size} timeframe{new Set(strategies.map(s => s.barMinutes)).size !== 1 ? "s" : ""}
              </span>
              {togglingAll && <span className="text-[9px] font-mono animate-pulse" style={{ color: GOLD }}>⏳ Processing…</span>}
            </div>
            <div className="flex gap-3">
              {tfOrder.map(bm => {
                const all = grouped.get(bm) || [];
                const active = all.filter(s => s.active);
                const inactive = all.filter(s => !s.active);
                const label = tfLabels[bm] || `${bm}m`;
                const hasActive = active.length > 0;
                const universalActive = active.filter(s => s.type === "universal");
                const perCoinActive = active.filter(s => s.type === "per_coin" || s.type === "coin_specific");
                // For the picker: get unique universal strategies (inactive)
                const universalInactive = inactive.filter(s => s.type === "universal");
                const isBusy = togglingAll === `${bm}-on` || togglingAll === `${bm}-off`;

                return (
                  <div key={bm} className="flex-1 rounded-lg p-2" style={{
                    background: hasActive ? "rgba(34,197,94,0.04)" : "rgba(255,255,255,0.02)",
                    border: `1px solid ${hasActive ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.06)"}`,
                    opacity: isBusy ? 0.6 : 1,
                  }}>
                    {/* Header row */}
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{
                          background: bm === 1 ? "rgba(59,130,246,0.1)" : bm === 60 ? "rgba(167,139,250,0.1)" : "rgba(212,168,67,0.1)",
                          color: bm === 1 ? "#3b82f6" : bm === 60 ? "#a78bfa" : GOLD,
                        }}>{label}</span>
                        <div className={`w-1.5 h-1.5 rounded-full ${hasActive ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />
                        {isBusy && <span className="text-[8px] font-mono animate-pulse" style={{ color: GOLD }}>…</span>}
                      </div>
                      {all.length > 0 && hasActive && (
                        <div className="flex gap-1">
                            <button onClick={() => handleDeactivateAll(bm)} disabled={!!togglingAll}
                              className="px-1.5 py-0.5 rounded text-[8px] font-mono transition-colors disabled:opacity-40"
                              style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
                              Stop
                            </button>
                        </div>
                      )}
                    </div>

                    {all.length === 0 ? (
                      <div className="text-[9px] font-mono text-[var(--text-dim)] py-1">No strategies saved</div>
                    ) : (
                      <div>
                        {/* Active strategy — show with stop button */}
                        {active.length > 0 && (() => {
                          // Engine uses the most recently updated, so show that one
                          const running = active.sort((a, b) => (b as any).updatedAt?.localeCompare?.((a as any).updatedAt) || 0)[0];
                          return (
                            <div className="flex items-center gap-2 py-0.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
                              <span className="text-[9px] font-mono truncate flex-1" style={{ color: "var(--text)" }}>
                                {running.name.replace(/^Universal \d+[mhd]\s*[-–]\s*/i, "")}
                              </span>
                              {running.oosSharpe != null && (
                                <span className="text-[8px] font-mono shrink-0" style={{ color: "#22c55e" }}>SR {running.oosSharpe.toFixed(1)}</span>
                              )}
                            </div>
                          );
                        })()}

                        {/* Per-coin count if any active */}
                        {active.filter(s => s.type === "per_coin" || s.type === "coin_specific").length > 0 && (
                          <div className="text-[8px] font-mono text-[var(--text-dim)] mt-0.5">
                            +{active.filter(s => s.type === "per_coin" || s.type === "coin_specific").length} coin-specific active
                          </div>
                        )}

                        {/* Swap strategy dropdown — always available when strategies exist */}
                        <div className="mt-1.5 pt-1.5" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          <select
                            className="w-full px-2 py-1 rounded text-[9px] font-mono border border-[var(--border)]"
                            style={{ background: "#1a1a2e", color: "#e0e0e0" }}
                            value=""
                            onChange={async (e) => {
                              const id = e.target.value;
                              if (id) await handleActivate(id, bm);
                            }}
                          >
                            <option value="" disabled>{hasActive ? "Switch strategy…" : "Activate a strategy…"}</option>
                            {all.filter(s => s.type === "universal").map(s => (
                              <option key={s.id} value={s.id}>
                                {s.active ? "● " : ""}{s.name} {s.oosSharpe != null ? `(SR ${s.oosSharpe.toFixed(1)})` : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* HEADER */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 shrink-0"><span className="text-sm font-mono font-bold tracking-wide" style={{color:GOLD}}>⚡ Fracmap Live</span><div className={`w-2 h-2 rounded-full ${isLive?"bg-green-500 animate-pulse":"bg-gray-600"}`}/></div>
          <select value={activeStrategy?.id||""} onChange={e=>{const s=strategies.find(x=>x.id===e.target.value);if(s)setActiveStrategy(s);}} className="px-2 py-1 rounded text-xs font-mono border border-[var(--border)] min-w-0 flex-1 truncate" style={{background:"#1a1a2e",color:"#e0e0e0"}}>{uS.map(s=><option key={s.id} value={s.id} style={{background:"#1a1a2e",color:"#e0e0e0"}}>{s.name} — SR {(s.oosSharpe||s.isSharpe||0).toFixed(1)}</option>)}</select>
          {lastTick&&<span className="text-[10px] font-mono text-[var(--text-dim)] shrink-0">{lastTick}</span>}
          <button onClick={()=>setShowDiag(!showDiag)} title="Diagnose" className="px-1.5 py-1 rounded text-[10px] font-mono border transition-all shrink-0" style={{background:showDiag?"rgba(167,139,250,0.1)":"transparent",borderColor:showDiag?"#a78bfa40":"var(--border)",color:showDiag?"#a78bfa":"var(--text-dim)"}}>🔬</button>
          <button onClick={()=>{if(!isLive){/* Starting */}else{/* Stopping */}setIsLive(!isLive);}} className="px-4 py-1 rounded text-xs font-mono font-semibold tracking-wide shrink-0 whitespace-nowrap" style={{background:isLive?"transparent":"#22c55e",color:isLive?"#ef4444":"#000",border:`1px solid ${isLive?"#ef4444":"#22c55e"}`}}>{isLive?"■ Stop":"▶ Go Live"}</button>
        </div>
        {activeStrategy&&(<div className="flex items-center gap-3 mt-2 pt-2 border-t border-[var(--border)]">
          {[`Str ×${activeStrategy.minStr}`,`Cyc ≥${activeStrategy.minCyc}`,activeStrategy.spike?"Spike ⚡":"Spike off",activeStrategy.nearMiss?"±1 on":"±1 off",activeStrategy.priceExt?"PxExt 📍":"",`Hold ÷${activeStrategy.holdDiv}`,`${activeStrategy.barMinutes}m bars`,`Cycles ${activeStrategy.cycleMin ?? '??'}–${activeStrategy.cycleMax ?? '??'}`].filter(Boolean).map((t,i)=><span key={i} className="text-[10px] font-mono text-[var(--text-dim)]">{t}</span>)}
          <div className="h-3 w-px bg-[var(--border)]"/>
          {activeStrategy.oosSharpe!=null&&<span className="text-[10px] font-mono" style={{color:"#22c55e"}}>OOS {activeStrategy.oosSharpe.toFixed(2)}</span>}
          {activeStrategy.winRate!=null&&<span className="text-[10px] font-mono" style={{color:"#eab308"}}>Win {activeStrategy.winRate.toFixed(1)}%</span>}
          <div className="h-3 w-px bg-[var(--border)]"/><span className="text-[10px] font-mono text-[var(--text-dim)]">1.5s/coin · {getActiveCoins().length} coins · {(() => { const cMax = activeStrategy.cycleMax ?? 100; const hd = Number(activeStrategy.holdDiv) || 2; return Math.max(500, Math.round((7 * Math.round(cMax / 3) + 30 * Math.round(cMax / hd)) * 1.2)); })()}b</span>
        </div>)}
      </div>

      {/* ═══ DIAGNOSTIC PANEL ═══ */}
      {showDiag && (
        <div className="bg-[var(--bg-card)] border-2 rounded-lg p-4" style={{borderColor:"#a78bfa60"}}>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[11px] font-mono font-bold" style={{color:"#a78bfa"}}>🔬 SIGNAL DIAGNOSTIC — Scanner vs Live</span>
            <select value={diagCoin} onChange={e=>setDiagCoin(e.target.value)} className="px-2 py-0.5 rounded text-xs font-mono border border-[var(--border)]" style={{background:"#1a1a2e",color:"#e0e0e0"}}>
              {getActiveCoins().map(c=><option key={c} value={c}>{c.replace("USDT","")}</option>)}
            </select>
            <button onClick={()=>runDiagnostic(diagCoin)} disabled={diagRunning} className="px-3 py-1 rounded text-[10px] font-mono font-bold transition-all disabled:opacity-40" style={{background:"#a78bfa",color:"#000"}}>
              {diagRunning ? "⏳ Running..." : "▶ Run Comparison"}
            </button>
            <span className="text-[9px] font-mono text-[var(--text-dim)]">
              Fetches full data (scanner) + live-sized data, runs both signal detectors, compares output
            </span>
          </div>

          {diagResults && (
            <div className="space-y-3">
              {/* Summary */}
              <div className="flex gap-6 p-3 rounded-lg border border-[var(--border)]" style={{background:"rgba(167,139,250,0.04)"}}>
                <div>
                  <div className="text-[8px] font-mono text-[var(--text-dim)]">Full Bars (Scanner)</div>
                  <div className="text-sm font-mono font-bold text-[var(--text)]">{diagResults.barsFull.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-[8px] font-mono text-[var(--text-dim)]">Live Bars (3000 cap)</div>
                  <div className="text-sm font-mono font-bold text-[var(--text)]">{diagResults.barsLive.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-[8px] font-mono text-[var(--text-dim)]">Bands</div>
                  <div className="text-sm font-mono font-bold text-[var(--text)]">{diagResults.bandCount}</div>
                </div>
                <div>
                  <div className="text-[8px] font-mono text-[var(--text-dim)]">Scanner Signals</div>
                  <div className="text-sm font-mono font-bold" style={{color:"#a78bfa"}}>{diagResults.scannerSigs.length}</div>
                </div>
                <div>
                  <div className="text-[8px] font-mono text-[var(--text-dim)]">Live Signals</div>
                  <div className="text-sm font-mono font-bold" style={{color:GOLD}}>{diagResults.liveSigs.length}</div>
                </div>
                <div>
                  <div className="text-[8px] font-mono text-[var(--text-dim)]">Tail Match</div>
                  <div className="text-sm font-mono font-bold" style={{color:diagResults.match?"#22c55e":"#ef4444"}}>
                    {diagResults.match ? "✓ MATCH" : `✗ DIVERGE at -${diagResults.divergeIdx}`}
                  </div>
                </div>
              </div>

              {/* Side-by-side last 20 signals */}
              <div className="grid grid-cols-2 gap-3">
                {/* Scanner signals */}
                <div>
                  <div className="text-[9px] font-mono font-bold mb-1" style={{color:"#a78bfa"}}>Scanner (full data · {diagResults.barsFull} bars)</div>
                  <div className="overflow-y-auto max-h-[300px] rounded border border-[var(--border)]">
                    <table className="w-full text-[10px]">
                      <thead><tr className="text-white/30 border-b border-white/5">
                        <th className="py-1 px-1.5 text-left">#</th>
                        <th className="py-1 px-1.5 text-left">Time</th>
                        <th className="py-1 px-1.5 text-left">Dir</th>
                        <th className="py-1 px-1.5 text-right">Price</th>
                        <th className="py-1 px-1.5 text-center">Str</th>
                        <th className="py-1 px-1.5 text-center">MaxC</th>
                        <th className="py-1 px-1.5 text-center">Hold</th>
                        <th className="py-1 px-1.5 text-right">Ret%</th>
                      </tr></thead>
                      <tbody>
                        {diagResults.scannerLast20.map((s,i)=>{
                          const liveMatch = diagResults.liveLast20[i];
                          const matches = liveMatch && liveMatch.time === s.time && liveMatch.type === s.type;
                          return (
                            <tr key={i} className="border-b border-white/[0.03]" style={{background:matches?"transparent":"rgba(239,68,68,0.06)"}}>
                              <td className="py-1 px-1.5 text-white/30">{diagResults.scannerSigs.length - 20 + i}</td>
                              <td className="py-1 px-1.5 text-white/50 tabular-nums">{s.time ? new Date(s.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "–"}</td>
                              <td className={`py-1 px-1.5 font-semibold ${s.type==="LONG"?"text-green-400":"text-red-400"}`}>{s.type}</td>
                              <td className="py-1 px-1.5 text-right tabular-nums text-white/50">{s.price?.toFixed(4)}</td>
                              <td className="py-1 px-1.5 text-center text-white/50">×{s.str}</td>
                              <td className="py-1 px-1.5 text-center" style={{color:GOLD}}>C{s.maxC}</td>
                              <td className="py-1 px-1.5 text-center text-white/40">{s.hold}</td>
                              <td className={`py-1 px-1.5 text-right tabular-nums ${(s.ret||0)>=0?"text-green-400":"text-red-400"}`}>{(s.ret||0)>0?"+":""}{(s.ret||0).toFixed(3)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Live signals */}
                <div>
                  <div className="text-[9px] font-mono font-bold mb-1" style={{color:GOLD}}>Live (live data · {diagResults.barsLive} bars)</div>
                  <div className="overflow-y-auto max-h-[300px] rounded border border-[var(--border)]">
                    <table className="w-full text-[10px]">
                      <thead><tr className="text-white/30 border-b border-white/5">
                        <th className="py-1 px-1.5 text-left">#</th>
                        <th className="py-1 px-1.5 text-left">Time</th>
                        <th className="py-1 px-1.5 text-left">Dir</th>
                        <th className="py-1 px-1.5 text-right">Price</th>
                        <th className="py-1 px-1.5 text-center">Str</th>
                        <th className="py-1 px-1.5 text-center">MaxC</th>
                        <th className="py-1 px-1.5 text-center">Hold</th>
                        <th className="py-1 px-1.5 text-right">Ret%</th>
                      </tr></thead>
                      <tbody>
                        {diagResults.liveLast20.map((s,i)=>{
                          const scanMatch = diagResults.scannerLast20[i];
                          const matches = scanMatch && scanMatch.time === s.time && scanMatch.type === s.type;
                          return (
                            <tr key={i} className="border-b border-white/[0.03]" style={{background:matches?"transparent":"rgba(239,68,68,0.06)"}}>
                              <td className="py-1 px-1.5 text-white/30">{diagResults.liveSigs.length - 20 + i}</td>
                              <td className="py-1 px-1.5 text-white/50 tabular-nums">{s.time ? new Date(s.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "–"}</td>
                              <td className={`py-1 px-1.5 font-semibold ${s.type==="LONG"?"text-green-400":"text-red-400"}`}>{s.type}</td>
                              <td className="py-1 px-1.5 text-right tabular-nums text-white/50">{s.price?.toFixed(4)}</td>
                              <td className="py-1 px-1.5 text-center text-white/50">×{s.str}</td>
                              <td className="py-1 px-1.5 text-center" style={{color:GOLD}}>C{s.maxC}</td>
                              <td className="py-1 px-1.5 text-center text-white/40">{s.hold}</td>
                              <td className={`py-1 px-1.5 text-right tabular-nums ${(s.ret||0)>=0?"text-green-400":"text-red-400"}`}>{(s.ret||0)>0?"+":""}{(s.ret||0).toFixed(3)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="text-[9px] font-mono text-[var(--text-dim)] mt-2">
                Red rows = signal mismatch at that position. Check F12 console for [DIAG] logs with full details.
                {!diagResults.match && <span style={{color:"#ef4444"}}> Tail divergence at position -{diagResults.divergeIdx} — likely caused by position-lock chain difference from different bar history lengths.</span>}
                {diagResults.match && <span style={{color:"#22c55e"}}> Last 50 signals match between scanner and live — signal logic is consistent.</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* MAIN: Feed + Chart */}
      <div className="flex gap-2" style={{height: 520}}>
        {/* LEFT: Trade Log — height synced to row */}
        <div className="w-[280px] shrink-0 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-2.5 overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-mono font-semibold" style={{color:GOLD}}>Trade Log</div>
            <div className="flex items-center gap-2">
              {trades.length > 0 && (
                <button onClick={()=>{tradesRef.current=[];knownKeysRef.current.clear();setTrades([]);setEquityHistory([]);try{sessionStorage.removeItem("fracmap_live_trades");}catch{}}} title="Clear all trades" className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] hover:border-[#ef4444] transition-all" style={{color:"var(--text-dim)"}}>🗑</button>
              )}
              {openT.length > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{background:"rgba(34,197,94,0.1)", color:"#22c55e"}}>
                  {openT.length} open
                </span>
              )}
            </div>
          </div>
          {trades.length===0&&<div className="text-xs font-mono text-[var(--text-dim)] py-6 text-center flex-1 flex items-center justify-center">{isLive?"Monitoring...":"Press ▶ Go Live"}</div>}
          <div className="space-y-1 flex-1">
            {/* Show open trades first, then recently closed */}
            {[...openT, ...closedT.slice(0, Math.max(0, 12 - openT.length))].slice(0, 12).map(t=>(<button key={t.id} onClick={()=>setSelectedCoin(t.coin)} className="w-full text-left px-2.5 py-2 rounded-lg border hover:brightness-110 transition-all" style={{borderColor:t.coin===selectedCoin?(t.type==="LONG"?"#22c55e40":"#ef444440"):"var(--border)",background:t.status==="open"?(t.type==="LONG"?"rgba(34,197,94,0.06)":"rgba(239,68,68,0.06)"):"transparent",opacity:t.status==="closed"?0.5:1}}>
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-mono font-bold" style={{color:t.type==="LONG"?"#22c55e":"#ef4444"}}>{t.type==="LONG"?"▲":"▼"} {t.coin.replace("USDT","")}</span>
                <span className="text-[11px] font-mono" style={{color:t.type==="LONG"?"#22c55e":"#ef4444"}}>{t.type}</span>
                {t.strength>1&&<span className="text-[10px] font-mono" style={{color:GOLD}}>×{t.strength}</span>}
                {(t.maxCycle || t.triggerBands?.[0]?.cycle) && <span className="text-[9px] font-mono text-[var(--text-dim)]">C{t.maxCycle || t.triggerBands?.[0]?.cycle}·φ{t.maxOrder || t.triggerBands?.[0]?.order}</span>}
                <div className="flex-1"/>
                {t.status==="open"?<span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"/>:<span className="text-[10px] font-mono text-[var(--text-dim)]">✓</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono tabular-nums">
                <span className="text-[var(--text-dim)]"><FmtPrice p={t.entryPrice}/></span>
                {t.status==="open"&&t.unrealizedPct!=null&&<span style={{color:t.unrealizedPct>0?"#22c55e":"#ef4444"}}>{t.unrealizedPct>0?"+":""}{t.unrealizedPct.toFixed(3)}%</span>}
                {t.status==="closed"&&t.returnPct!=null&&<span style={{color:t.returnPct>0?"#22c55e":"#ef4444"}}>{t.returnPct>0?"+":""}{t.returnPct.toFixed(3)}%</span>}
              </div>
              {/* Entry time + Countdown */}
              <div className="flex items-center justify-between mt-1 text-[10px] font-mono">
                <span className="text-[var(--text-dim)]">
                  {new Date(t.entryTime).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
                </span>
                {t.status === "open" ? (
                  <span className="px-1.5 py-0.5 rounded text-[9px]" style={{
                    background: "rgba(212,168,67,0.1)",
                    color: GOLD,
                  }}>
                    ⏱ {getCountdown(t)}
                  </span>
                ) : (
                  <span className="text-[var(--text-dim)]">closed</span>
                )}
              </div>
            </button>))}
          </div>
        </div>

        {/* RIGHT: Chart / Equity */}
        <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-2.5 flex flex-col">
          {/* Toolbar */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap shrink-0">
            <div className="flex gap-px rounded overflow-hidden border border-[var(--border)]">
              <button onClick={()=>setChartView("price")} className="px-2.5 py-0.5 text-[10px] font-mono" style={{background:chartView==="price"?GOLD_DIM:"transparent",color:chartView==="price"?GOLD:"var(--text-dim)"}}>Chart</button>
              <button onClick={()=>setChartView("equity")} className="px-2.5 py-0.5 text-[10px] font-mono" style={{background:chartView==="equity"?"rgba(34,197,94,0.1)":"transparent",color:chartView==="equity"?"#22c55e":"var(--text-dim)"}}>Equity</button>
            </div>
            {chartView==="price"&&(<>
              <select value={selectedCoin} onChange={e=>setSelectedCoin(e.target.value)} className="px-2 py-0.5 rounded text-sm font-mono font-bold border border-[var(--border)]" style={{background:"#1a1a2e",color:"#e0e0e0"}}>{ALL_COINS.map(s=><option key={s} value={s} style={{background:"#1a1a2e",color:"#e0e0e0"}}>{s.replace("USDT","")}</option>)}</select>
              {sel&&(<><span className="text-base font-mono font-bold tabular-nums text-[var(--text)]">{sel.lastPrice.toFixed(sel.lastPrice>100?2:4)}</span><span className="text-xs font-mono tabular-nums" style={{color:sel.change1m>0?"#22c55e":sel.change1m<0?"#ef4444":"var(--text-dim)"}}>{sel.change1m>0?"+":""}{sel.change1m.toFixed(3)}%</span>
              {selTr&&<span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold" style={{background:selTr.type==="LONG"?"rgba(34,197,94,0.15)":"rgba(239,68,68,0.15)",color:selTr.type==="LONG"?"#22c55e":"#ef4444"}}>{selTr.type}</span>}
              {selTr?.triggerBands&&<span className="text-[10px] font-mono text-[var(--text-dim)]">{(() => { const raw = selTr.triggerBands; const tb: any[] = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : []; if (!tb.length) return ""; const orders = [...new Set(tb.map((t:any)=>t.order))].sort(); const cMin = Math.min(...tb.map((t:any)=>t.cycle)); const cMax = Math.max(...tb.map((t:any)=>t.cycle)); return `C${cMin}-${cMax} · φ${orders.join(",")} · ×${tb.length}`; })()}</span>}</>)}
            </>)}
            {chartView==="equity"&&(<>
              <span className="text-xs font-mono text-[var(--text)]">Strategy Cumulative</span>
              <span className="text-[10px] font-mono text-[var(--text-dim)]">{closedT.length} trades</span>
              {eqCum.length>0&&<span className="text-xs font-mono tabular-nums" style={{color:eqCum[eqCum.length-1].value>0?"#22c55e":"#ef4444"}}>{eqCum[eqCum.length-1].value>0?"+":""}{eqCum[eqCum.length-1].value.toFixed(3)}%</span>}
            </>)}
            <div className="flex-1"/>
            {chartView==="price"&&(<>
              <button onClick={()=>setYAxisMode(m=>m==="tight"?"padded":m==="padded"?"free":"tight")} className="px-1.5 py-0.5 rounded text-[10px] font-mono border" style={{background:yAxisMode!=="free"?GOLD_DIM:"transparent",borderColor:yAxisMode!=="free"?GOLD+"40":"var(--border)",color:yAxisMode!=="free"?GOLD:"var(--text-dim)"}}>{yAxisMode==="tight"?"🔒 Tight":yAxisMode==="padded"?"🔒 Pad":"🔓 Free"}</button>
              <button onClick={()=>setShadingMode(m=>m==="valley"?"channel":"valley")} className="px-1.5 py-0.5 rounded text-[10px] font-mono border" style={{background:shadingMode==="valley"?"rgba(167,139,250,0.1)":"transparent",borderColor:shadingMode==="valley"?"#a78bfa40":"var(--border)",color:shadingMode==="valley"?"#a78bfa":"var(--text-dim)"}}>{shadingMode==="valley"?"🏔 Val":"📊 Ch"}</button>
              <div className="flex items-center gap-0.5 rounded overflow-hidden border border-[var(--border)]">
                <button onClick={()=>setChartBars(Math.max(20,effectiveChartBars-20))} className="px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-dim)] hover:text-white">−</button>
                <span className="px-1 py-0.5 text-[9px] font-mono tabular-nums" style={{color:GOLD}}>{effectiveChartBars}</span>
                <button onClick={()=>setChartBars(Math.min(500,effectiveChartBars+20))} className="px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-dim)] hover:text-white">+</button>
              </div>
            </>)}
          </div>

          {/* CHART CONTAINER — measured for dynamic SVG sizing */}
          <div ref={chartContainerRef} className="flex-1 min-h-0 overflow-hidden">
          {/* PRICE CHART */}
          {chartView==="price"&&(vB.length>0?(
            <svg ref={svgRef} width={chartW} height={chartH} className="block" style={{background:"rgba(0,0,0,0.2)",borderRadius:6,maxWidth:"100%"}}>
              <defs><clipPath id="lpC"><rect x={PAD.left} y={PAD.top} width={plotW} height={plotH}/></clipPath></defs>
              {yT.map((v,i)=><line key={i} x1={PAD.left} y1={toY(v)} x2={chartW-PAD.right} y2={toY(v)} stroke="rgba(255,255,255,0.04)"/>)}
              <g clipPath="url(#lpC)">
                {proj>0&&<line x1={toX(vB.length-0.5)} y1={PAD.top} x2={toX(vB.length-0.5)} y2={PAD.top+plotH} stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="4,3"/>}
                {renderBands()}
                {renderEdges()}
                {vB.map((b:any,i:number)=>{const x=toX(i),up=b.close>=b.open,col=up?"#22c55e":"#ef4444",bT=toY(Math.max(b.open,b.close)),bB=toY(Math.min(b.open,b.close)),bH=Math.max(1,bB-bT);return <g key={`k${i}`}><line x1={x} y1={toY(b.high)} x2={x} y2={toY(b.low)} stroke={col} strokeWidth={0.8} opacity={0.7}/><rect x={x-bdW/2-0.5} y={bT-0.5} width={bdW+1} height={bH+1} fill="rgba(0,0,0,0.7)" rx={0.5}/><rect x={x-bdW/2} y={bT} width={bdW} height={bH} fill={up?"#0a0a0a":col} stroke={col} strokeWidth={0.6}/></g>;})}
                {vSig.map((sig:any,i:number)=>{const x=toX(sig.entryIdx),isL=sig.type==="LONG",y=isL?toY(sig.entryPrice)+14:toY(sig.entryPrice)-14,col=isL?"#22c55e":"#ef4444",isOpen=sig.status==="open",pts=isL?`${x},${y-12} ${x-6},${y} ${x+6},${y}`:`${x},${y+12} ${x-6},${y} ${x+6},${y}`;const tt=`${sig.type} ×${sig.strength} C${sig.maxCycle||"?"}·φ${sig.maxOrder||"?"}\n${sig.entryPrice.toFixed(sig.entryPrice>100?2:4)} @ ${new Date(sig.entryTime).toLocaleTimeString()}\nHold: ${sig.holdBars||"?"} bars · ${sig.status}\n${sig.status==="open"?(sig.unrealizedPct>0?"+":"")+sig.unrealizedPct?.toFixed(3)+"%":(sig.returnPct>0?"+":"")+sig.returnPct?.toFixed(3)+"%"}`;return <g key={`s${i}`} style={{cursor:"pointer"}}><title>{tt}</title><polygon points={pts} fill="black" opacity={0.6} transform="translate(0,1)"/><polygon points={pts} fill={col} stroke={isOpen?"white":"rgba(255,255,255,0.4)"} strokeWidth={isOpen?1.5:0.8} opacity={isOpen?1:0.6}/></g>;})}
              </g>
              {yT.map((v,i)=><text key={`yl${i}`} x={chartW-PAD.right+4} y={toY(v)+3} fill="rgba(255,255,255,0.35)" fontSize={8} fontFamily="monospace">{v.toFixed(v>1000?0:v>10?2:4)}</text>)}
              {vB.filter((_:any,i:number)=>i%Math.max(1,Math.floor(vB.length/8))===0).map((b:any)=>{const idx=vB.indexOf(b),d=new Date(b.time);return <text key={`xl${idx}`} x={toX(idx)} y={chartH-6} textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize={7} fontFamily="monospace">{`${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`}</text>;})}
              {proj>0&&<text x={toX(vB.length+proj/2)} y={PAD.top+14} textAnchor="middle" fill="rgba(255,255,255,0.08)" fontSize={9} fontFamily="monospace" fontWeight="bold">PROJECTION</text>}
            </svg>
          ):(<div className="flex-1 flex items-center justify-center text-xs font-mono text-[var(--text-dim)]">{isLive?"Loading chart...":"Press ▶ Go Live"}</div>))}

          {/* EQUITY CHART */}
          {chartView==="equity"&&(eqCum.length>1?(
            <svg width={chartW} height={chartH} className="block" style={{background:"rgba(0,0,0,0.2)",borderRadius:6,maxWidth:"100%"}}>
              <line x1={EP.left} y1={eY(0)} x2={chartW-EP.right} y2={eY(0)} stroke="rgba(255,255,255,0.15)" strokeDasharray="4,3"/>
              {Array.from({length:5}).map((_,i)=>{const v=eMin+(i+1)*(eMax-eMin)/6;return <line key={i} x1={EP.left} y1={eY(v)} x2={chartW-EP.right} y2={eY(v)} stroke="rgba(255,255,255,0.04)"/>;})
              }
              {(()=>{const last=eqCum[eqCum.length-1],pos=last.value>=0;let d=eqCum.map((p,i)=>`${i===0?"M":"L"}${eX(i).toFixed(1)},${eY(p.value).toFixed(1)}`).join(" ");d+=` L${eX(eqCum.length-1).toFixed(1)},${eY(0).toFixed(1)} L${eX(0).toFixed(1)},${eY(0).toFixed(1)} Z`;return <path d={d} fill={pos?"rgba(34,197,94,0.08)":"rgba(239,68,68,0.08)"}/>;})()}
              <path d={eqCum.map((p,i)=>`${i===0?"M":"L"}${eX(i).toFixed(1)},${eY(p.value).toFixed(1)}`).join(" ")} fill="none" stroke={eqCum[eqCum.length-1].value>=0?"#22c55e":"#ef4444"} strokeWidth={1.5}/>
              {Array.from({length:5}).map((_,i)=>{const v=eMin+(i+1)*(eMax-eMin)/6;return <text key={i} x={EP.left-4} y={eY(v)+3} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize={8} fontFamily="monospace">{v.toFixed(3)}%</text>;})}
              <text x={EP.left-4} y={eY(0)+3} textAnchor="end" fill="rgba(255,255,255,0.5)" fontSize={8} fontFamily="monospace">0%</text>
              {eqCum.filter((_,i)=>i%Math.max(1,Math.floor(eqCum.length/6))===0).map((p,i)=>{const idx=eqCum.indexOf(p),d=new Date(p.time);return <text key={i} x={eX(idx)} y={chartH-6} textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize={7} fontFamily="monospace">{`${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`}</text>;})}
            </svg>
          ):(<div className="flex-1 flex items-center justify-center text-xs font-mono text-[var(--text-dim)]">{isLive?"Collecting data...":"Press ▶ Go Live"}</div>))}
          </div>{/* end chart container */}
        </div>
      </div>

      {/* COIN GRID */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-2.5">
        <div className="flex flex-wrap gap-1.5">
          {getActiveCoins().map(sym=>{const cs=coinStates[sym],has=openT.some(t=>t.coin===sym),dir=openT.find(t=>t.coin===sym)?.type;return(
            <button key={sym} onClick={()=>setSelectedCoin(sym)} className="px-3 py-1.5 rounded-lg border text-center transition-all" style={{borderColor:sym===selectedCoin?GOLD+"60":has?(dir==="LONG"?"#22c55e40":"#ef444440"):"var(--border)",background:sym===selectedCoin?GOLD_DIM:has?(dir==="LONG"?"rgba(34,197,94,0.05)":"rgba(239,68,68,0.05)"):"transparent"}}>
              <div className="text-[11px] font-mono font-bold" style={{color:sym===selectedCoin?GOLD:has?(dir==="LONG"?"#22c55e":"#ef4444"):"var(--text-dim)"}}>{sym.replace("USDT","")}</div>
              {cs?(<><div className="text-[10px] font-mono tabular-nums" style={{color:cs.change1m>0?"#22c55e":cs.change1m<0?"#ef4444":"var(--text-dim)"}}>{cs.change1m>0?"+":""}{cs.change1m.toFixed(2)}%</div>{has&&<div className="text-[9px] font-mono font-bold" style={{color:dir==="LONG"?"#22c55e":"#ef4444"}}>{dir==="LONG"?"▲ Long":"▼ Short"}</div>}</>):<div className="text-[9px] font-mono text-[var(--text-dim)]">–</div>}
            </button>);})}
        </div>
      </div>

      {/* NET POSITION */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-2.5">
        <div className="flex items-center gap-6 flex-wrap">
          <span className="text-xs font-mono font-semibold" style={{color:GOLD}}>Open Positions</span>
          <div className="h-3 w-px bg-[var(--border)]"/>
          <span className="text-xs font-mono" style={{color:"#22c55e"}}>▲ {longs} Long{longs!==1?"s":""}</span>
          <span className="text-xs font-mono" style={{color:"#ef4444"}}>▼ {shorts} Short{shorts!==1?"s":""}</span>
          <div className="h-3 w-px bg-[var(--border)]"/>
          <span className="text-xs font-mono text-[var(--text-dim)]">Total: {longs+shorts} / {getActiveCoins().length}</span>
          <div className="h-3 w-px bg-[var(--border)]"/>
          <span className="text-xs font-mono tabular-nums" style={{color:avgUnr>0?"#22c55e":avgUnr<0?"#ef4444":"var(--text-dim)"}}>Avg: {avgUnr>0?"+":""}{avgUnr.toFixed(3)}%</span>
          <span className="text-xs font-mono tabular-nums" style={{color:totUnr>0?"#22c55e":totUnr<0?"#ef4444":"var(--text-dim)"}}>Unr P&L: {totUnr>0?"+":""}{totUnr.toFixed(3)}%</span>
          <div className="flex-1"/>
          <span className="text-xs font-mono tabular-nums font-semibold" style={{color:longs-shorts>0?"#22c55e":longs-shorts<0?"#ef4444":"var(--text-dim)"}}>Net: {longs-shorts>0?`+${longs-shorts} Long`:longs-shorts<0?`${longs-shorts} Short`:"Flat"}</span>
        </div>
      </div>

      {/* CLOSED TRADES TABLE */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-4">
          <span className="text-xs font-mono font-semibold" style={{color:GOLD}}>Closed Trades</span>
          <span className="text-[10px] font-mono text-[var(--text-dim)]">{closedT.length} trades</span>
          <div className="h-3 w-px bg-[var(--border)]"/>
          <span className="text-[10px] font-mono tabular-nums" style={{color:cumClosed>0?"#22c55e":cumClosed<0?"#ef4444":"var(--text-dim)"}}>Cum: {cumClosed>0?"+":""}{cumClosed.toFixed(3)}%</span>
          <span className="text-[10px] font-mono tabular-nums" style={{color:cWinRate>50?"#22c55e":"#eab308"}}>Win: {cWinRate.toFixed(1)}%</span>
          <span className="text-[10px] font-mono tabular-nums" style={{color:cSharpe>0?"#22c55e":"#ef4444"}}>Sharpe: {cSharpe.toFixed(2)}</span>
        </div>
        <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-white/30 border-b border-white/5">
                <th className="text-left py-1.5 px-2 font-semibold">Entry</th>
                <th className="text-left py-1.5 px-2 font-semibold">Exit</th>
                <th className="text-left py-1.5 px-2 font-semibold">Coin</th>
                <th className="text-left py-1.5 px-2 font-semibold">Dir</th>
                <th className="text-center py-1.5 px-1 font-semibold">Sig</th>
                <th className="text-right py-1.5 px-2 font-semibold">Entry $</th>
                <th className="text-right py-1.5 px-2 font-semibold">Exit $</th>
                <th className="text-right py-1.5 px-2 font-semibold">Return</th>
                <th className="text-right py-1.5 px-2 font-semibold">Cumulative</th>
                <th className="text-center py-1.5 px-2 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {closedWithCum.length===0&&<tr><td colSpan={10} className="py-4 text-center text-white/20 font-mono">No closed trades yet</td></tr>}
              {closedWithCum.map(t=>{
                return(
                <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-1.5 px-2 text-white/40 tabular-nums">{new Date(t.entryTime).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</td>
                  <td className="py-1.5 px-2 text-white/40 tabular-nums">{t.closedTime?new Date(t.closedTime).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"—"}</td>
                  <td className="py-1.5 px-2 font-medium">{t.coin.replace("USDT","")}</td>
                  <td className={`py-1.5 px-2 font-semibold ${t.type==="LONG"?"text-green-400":"text-red-400"}`}>{t.type==="LONG"?"▲ Long":"▼ Short"}</td>
                  <td className="py-1.5 px-1 text-center text-[9px] font-mono text-white/40">{t.triggerBands && t.triggerBands.length > 0 ? `×${t.triggerBands.length}` : "—"}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-white/50"><FmtPrice p={t.entryPrice}/></td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-white/50"><FmtPrice p={t.exitPrice||0}/></td>
                  <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${(t.returnPct||0)>=0?"text-green-400":"text-red-400"}`}>{(t.returnPct||0)>0?"+":""}{(t.returnPct||0).toFixed(3)}%</td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${t.cumPct>=0?"text-green-400/60":"text-red-400/60"}`}>{t.cumPct>0?"+":""}{t.cumPct.toFixed(3)}%</td>
                  <td className="py-1.5 px-2 text-center">{(t.returnPct||0)>0?<span className="text-green-400">✓</span>:<span className="text-red-400">✗</span>}</td>
                </tr>);
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
