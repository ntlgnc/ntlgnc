"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { adminFetch } from "@/lib/admin-fetch";

const FracmapScanner = dynamic(() => import("@/components/FracmapScanner"), { ssr: false });
const FracmapLive = dynamic(() => import("@/components/FracmapLive"), { ssr: false });
const FracmapTopography = dynamic(() => import("@/components/FracmapTopography"), { ssr: false });
const FracmapTab = dynamic(() => import("@/components/FracmapTab"), { ssr: false });
const ResearchLog = dynamic(() => import("@/components/ResearchLog"), { ssr: false });
const ResearchDocs = dynamic(() => import("@/components/ResearchDocs"), { ssr: false });
const LLMBoard = dynamic(() => import("@/components/LLMBoard"), { ssr: false });

/* ── Tailwind class constants ── */
const PURPLE = "text-purple-400";
const PURPLE_BG = "bg-purple-500/10 border-purple-500/20";
const GOLD_TEXT = "text-[#D4A843]";
const GOLD_BG = "bg-[#D4A843]/[0.06] border-[#D4A843]/[0.18]";
const PANEL = "rounded-xl p-5 bg-black/30 border border-white/[0.06]";

type AdminTab = "live" | "scanner" | "signals" | "topo" | "research" | "docs" | "board" | "ops";

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("live");
  const [auth, setAuth] = useState(false);
  const [token, setToken] = useState("");
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    const saved = sessionStorage.getItem("fracmap_admin_token");
    if (saved) {
      // Validate saved token against server
      fetch("/api/admin/ops", { headers: { Authorization: `Bearer ${saved}` } })
        .then(r => { if (r.ok) setAuth(true); else sessionStorage.removeItem("fracmap_admin_token"); })
        .catch(() => {});
    }
  }, []);

  const handleAuth = async () => {
    setAuthError(false);
    try {
      const res = await fetch("/api/admin/ops", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        setAuth(true);
        sessionStorage.setItem("fracmap_admin_token", token);
      } else {
        setAuthError(true);
      }
    } catch { setAuthError(true); }
  };

  if (!auth) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="p-6 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(212,168,67,0.2)" }}>
          <div className="text-sm font-mono font-bold mb-3" style={{ color: "#D4A843" }}>Admin Access</div>
          <input type="password" value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAuth()}
            className="px-3 py-2 rounded text-sm font-mono bg-[#0a0a1a] text-white w-64"
            style={{ border: `1px solid ${authError ? "#ef4444" : "rgba(212,168,67,0.2)"}` }}
            placeholder="Admin token" autoFocus />
          <button onClick={handleAuth} className="ml-2 px-4 py-2 rounded text-sm font-mono font-bold" style={{ background: "#D4A843", color: "#000" }}>→</button>
          {authError && <div className="text-[10px] font-mono text-red-400 mt-2">Invalid token</div>}
        </div>
      </div>
    );
  }

  const tabs: { id: AdminTab; label: string }[] = [
    { id: "live", label: "⚡ Live" },
    { id: "scanner", label: "⚙ Scanner" },
    { id: "signals", label: "φ Signals" },
    { id: "topo", label: "🗺 Topo" },
    { id: "research", label: "📋 Research" },
    { id: "docs", label: "📎 Docs" },
    { id: "board", label: "🏛 Board" },
    { id: "ops", label: "🔧 Ops" },
  ];

  const toolPages = [
    { href: "/admin/hedged-backtest", label: "Hedged Backtest" },
    { href: "/admin/filter-audit", label: "Filter Audit" },
    { href: "/admin/filter-impact", label: "Filter Impact" },
    { href: "/admin/filter-matrix", label: "Filter Matrix" },
  ];

  return (
    <div className="max-w-[95vw] mx-auto px-4 py-4">
      {/* ── NAV BAR ── */}
      <div className="flex items-center gap-4 mb-2">
        <span className="text-base font-mono font-bold tracking-wide" style={{ color: "#D4A843" }}>ADMIN</span>
        <div className="flex gap-0.5 rounded-lg overflow-hidden" style={{ border: "1px solid rgba(212,168,67,0.2)", background: "rgba(212,168,67,0.03)" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="px-4 py-2 text-[13px] font-mono font-medium transition-all"
              style={{
                color: tab === t.id ? "#D4A843" : "rgba(255,255,255,0.5)",
                background: tab === t.id ? "rgba(212,168,67,0.12)" : "transparent",
              }}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="w-px h-5" style={{ background: "rgba(255,255,255,0.08)" }} />
        <div className="flex gap-1">
          {toolPages.map(p => (
            <a key={p.href} href={p.href}
              className="px-3 py-1.5 text-[11px] font-mono font-bold rounded transition-all"
              style={{ color: "rgba(255,255,255,0.5)", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
              {p.label}
            </a>
          ))}
        </div>
        <div className="flex-1" />
        <a href="/" className="text-xs font-mono transition-colors" style={{ color: "rgba(255,255,255,0.4)" }}>← Public site</a>
        <button onClick={() => { sessionStorage.removeItem("fracmap_admin"); setAuth(false); }}
          className="ml-3 text-xs font-mono transition-colors" style={{ color: "rgba(255,255,255,0.4)" }}>
          Logout
        </button>
      </div>

      {tab === "live" && <FracmapLive />}
      {tab === "scanner" && <FracmapScanner />}
      {tab === "signals" && <FracmapTab />}
      {tab === "topo" && <FracmapTopography />}
      {tab === "research" && <ResearchLog />}
      {tab === "docs" && <ResearchDocs />}
      {tab === "board" && <LLMBoard />}
      {tab === "ops" && <OpsPanel />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SYSTEM HEALTH & OPS PANEL
   ═══════════════════════════════════════════════════════════════ */

type HealthData = {
  processes: Record<string, boolean>;
  data: {
    candle1m: { latest: string | null; recentCoins: number };
    candle1h: { latest: string | null; recentCoins: number };
    candle1d: { latest: string | null; recentCoins: number };
    signals: { total: number; open: number; latest: string | null };
    board: { round_number: number; phase: string; decision: string; created_at: string; duration_ms: number; total_tokens: number } | null;
  };
} | null;

function OpsPanel() {
  const [health, setHealth] = useState<HealthData>(null);
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState("");
  const [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [triggerStatus, setTriggerStatus] = useState("");

  const fetchHealth = useCallback(async () => {
    try {
      const res = await adminFetch("/api/admin/exec");
      const d = await res.json();
      if (!d.error) setHealth(d);
      setLastCheck(new Date());
    } catch {}
  }, []);

  useEffect(() => {
    fetchHealth();
    const iv = setInterval(fetchHealth, 30000);
    return () => clearInterval(iv);
  }, [fetchHealth]);

  const exec = async (id: string) => {
    setRunning(id);
    setOutput("Running...");
    try {
      const res = await adminFetch("/api/admin/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const d = await res.json();
      setOutput(d.output || d.error || JSON.stringify(d));
      setTimeout(fetchHealth, 3000);
    } catch (e: any) { setOutput(e.message); }
    setRunning("");
  };

  const triggerMeeting = async () => {
    setTriggerStatus("⏳ Triggering meeting... (takes 1-2 minutes)");
    try {
      const res = await fetch("/api/board", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "triggerMeeting" }),
        signal: AbortSignal.timeout(300000),
      });
      const d = await res.json();
      if (d.error) {
        setTriggerStatus(`❌ ${d.error}`);
      } else if (d.meeting) {
        setTriggerStatus(`✅ Meeting #${d.meeting.roundNumber || '?'} — ${d.meeting.decision || 'complete'}`);
      } else {
        setTriggerStatus(`✅ Triggered`);
      }
      setTimeout(fetchHealth, 3000);
    } catch (e: any) {
      setTriggerStatus(`❌ ${e.message}`);
    }
  };

  const ago = (ts: string | null) => {
    if (!ts) return "never";
    const ms = Date.now() - new Date(ts).getTime();
    if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
    return `${Math.round(ms / 3600000)}h ago`;
  };

  const isStale = (ts: string | null, maxMinutes: number) => {
    if (!ts) return true;
    return Date.now() - new Date(ts).getTime() > maxMinutes * 60000;
  };

  const allDown = health && !health.processes.live_fetch && !health.processes.live_signals &&
                  !health.processes.live_fetch_hourly && !health.processes.live_fetch_daily;
  const supervisorUp = health?.processes?.supervisor;

  return (
    <div className="space-y-6">
      {/* ── SUPERVISOR CONTROL ── */}
      <div className={`${PANEL} border-[#D4A843]/20`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className={`text-sm font-mono font-bold ${GOLD_TEXT}`}>🎛 Backend Supervisor</h2>
            <p className="text-[9px] font-mono text-gray-500 mt-0.5">
              Manages all 5 backend processes from one place. Start this instead of individual services.
            </p>
          </div>
          <span className="text-[9px] font-mono text-gray-500">
            {lastCheck ? `checked ${ago(lastCheck.toISOString())}` : "checking..."}
          </span>
        </div>

        <div className="flex gap-3 items-center">
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
            supervisorUp ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'
          }`}>
            <span className={`w-2.5 h-2.5 rounded-full ${supervisorUp ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`} />
            <span className={`text-[11px] font-mono font-bold ${supervisorUp ? 'text-green-400' : 'text-red-400'}`}>
              {supervisorUp ? 'SUPERVISOR RUNNING' : 'SUPERVISOR DOWN'}
            </span>
          </div>
          
          {!supervisorUp ? (
            <button onClick={() => exec('supervisor')} disabled={!!running}
              className="px-6 py-2.5 rounded-lg text-[13px] font-mono font-bold transition-all disabled:opacity-40 bg-green-500 text-black">
              {running === 'supervisor' ? '⏳ Starting...' : '▶ START ALL'}
            </button>
          ) : (
            <>
              <button onClick={() => { exec('stop_supervisor'); setTimeout(() => exec('stop_all_backend'), 2000); }} disabled={!!running}
                className="px-4 py-2 rounded-lg text-[11px] font-mono font-bold transition-all disabled:opacity-40 bg-red-500/10 text-red-500 border border-red-500/20">
                ■ STOP ALL
              </button>
              <button onClick={() => { exec('stop_all_backend'); setTimeout(() => exec('supervisor'), 3000); }} disabled={!!running}
                className="px-4 py-2 rounded-lg text-[11px] font-mono font-bold transition-all disabled:opacity-40 bg-amber-500/15 text-amber-500 border border-amber-500/30">
                ↻ RESTART ALL
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── INDIVIDUAL SERVICES ── */}
      <div className={PANEL}>
        <div className="flex items-center justify-between mb-4">
          <h2 className={`text-sm font-mono font-bold ${GOLD_TEXT}`}>Individual Services</h2>
          <span className="text-[9px] font-mono text-gray-500">auto-refreshes every 30s</span>
        </div>

        {!health ? (
          <div className="text-[11px] font-mono text-gray-400">Loading health data...</div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <ServiceCard name="1m Data Collection" processKey="live_fetch"
              running={health.processes.live_fetch} dataFresh={!isStale(health.data.candle1m.latest, 5)}
              detail={`${health.data.candle1m.recentCoins} coins active · last: ${ago(health.data.candle1m.latest)}`}
              startCmd="live_fetch" stopCmd="stop_live_fetch" onExec={exec} busy={running} />
            <ServiceCard name="Signal Engine" processKey="live_signals"
              running={health.processes.live_signals} dataFresh={!isStale(health.data.signals.latest, 30)}
              detail={`${health.data.signals.total} total · ${health.data.signals.open} open · last: ${ago(health.data.signals.latest)}`}
              startCmd="live_signals" stopCmd="stop_live_signals" onExec={exec} busy={running} />
            <ServiceCard name="Hourly Data" processKey="live_fetch_hourly"
              running={health.processes.live_fetch_hourly} dataFresh={!isStale(health.data.candle1h.latest, 120)}
              detail={`${health.data.candle1h.recentCoins} coins · last: ${ago(health.data.candle1h.latest)}`}
              startCmd="live_fetch_hourly" stopCmd="stop_live_fetch_hourly" onExec={exec} busy={running} />
            <ServiceCard name="Daily Data" processKey="live_fetch_daily"
              running={health.processes.live_fetch_daily} dataFresh={!isStale(health.data.candle1d.latest, 1500)}
              detail={`${health.data.candle1d.recentCoins} coins · last: ${ago(health.data.candle1d.latest)}`}
              startCmd="live_fetch_daily" stopCmd="stop_live_fetch_daily" onExec={exec} busy={running} />
            <ServiceCard name="LLM Strategy Board" processKey="llm_board"
              running={health.processes.llm_board} 
              dataFresh={health.data.board ? !isStale(health.data.board.created_at, 90) : false}
              detail={health.data.board 
                ? `Meeting #${health.data.board.round_number} · ${health.data.board.phase} · ${ago(health.data.board.created_at)}`
                : 'No meetings yet'}
              startCmd="llm_board" stopCmd="stop_llm_board" onExec={exec} busy={running} />
          </div>
        )}
      </div>

      {/* ── OPERATOR MESSAGE TO BOARD ── */}
      <OperatorMessage />

      {/* ── SIGNAL HEALTH MONITOR ── */}
      {health?.data?.signalHealth && <SignalHealthMonitor data={health.data.signalHealth} ago={ago} />}

      {/* ── FILTER IMPACT CHARTS ── */}
      <FilterImpactPanel />

      {/* ── TRIGGER MEETING ── */}
      <div className={PANEL}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className={`text-sm font-mono font-bold ${GOLD_TEXT}`}>⚡ Manual Meeting Trigger</h2>
            <p className="text-[9px] font-mono text-gray-500 mt-0.5">
              Force a board meeting now. Bypasses the hourly schedule and 30-min dedup guard.
            </p>
          </div>
          <button onClick={triggerMeeting} disabled={!!triggerStatus.startsWith("⏳")}
            className="px-5 py-2.5 rounded-lg text-[12px] font-mono font-bold transition-all disabled:opacity-40 bg-purple-500 text-white border border-purple-400/30 hover:bg-purple-400">
            {triggerStatus.startsWith("⏳") ? "⏳ Running..." : "⚡ Trigger Meeting Now"}
          </button>
        </div>
        {triggerStatus && (
          <div className={`text-[11px] font-mono p-2 rounded ${
            triggerStatus.startsWith("✅") ? "text-green-400 bg-green-500/5" :
            triggerStatus.startsWith("❌") ? "text-red-400 bg-red-500/5" :
            "text-amber-400 bg-amber-500/5"
          }`}>{triggerStatus}</div>
        )}
      </div>

      {/* ── BACKFILL & UTILITIES ── */}
      <div className={PANEL}>
        <h2 className={`text-sm font-mono font-bold mb-3 ${GOLD_TEXT}`}>Backfill & Utilities</h2>
        <div className="flex flex-wrap gap-2">
          {[
            { id: "backfill_1m", label: "Backfill 1m (2 days)" },
            { id: "backfill_hourly", label: "Backfill 1H (14 days)" },
            { id: "backfill_daily", label: "Backfill 1D (60 days)" },
            { id: "check_candles", label: "Check Candles" },
            { id: "cleanup_coins", label: "Cleanup Coins" },
            { id: "evolution_cron", label: "Evolution Cron" },
            { id: "robustness_cron", label: "Robustness Cron" },
          ].map(op => (
            <button key={op.id} onClick={() => exec(op.id)} disabled={!!running}
              className={`px-3 py-1.5 rounded text-[11px] font-mono transition-all disabled:opacity-40 border ${PURPLE} ${PURPLE_BG}`}>
              {running === op.id ? "⏳" : "▶"} {op.label}
            </button>
          ))}
        </div>
      </div>

      {/* Command output */}
      {output && (
        <pre className="p-3 rounded text-[10px] font-mono overflow-auto max-h-96 bg-black/30 text-gray-300">{output}</pre>
      )}

      <SqlConsole />
    </div>
  );
}

/* ── Service Card ── */
function ServiceCard({ name, processKey, running, dataFresh, detail, startCmd, stopCmd, onExec, busy }: {
  name: string; processKey: string; running: boolean; dataFresh: boolean; detail: string;
  startCmd: string; stopCmd: string; onExec: (id: string) => void; busy: string;
}) {
  const isUp = running && dataFresh;
  const isPartial = running && !dataFresh;

  const statusCls = isUp ? "text-green-500" : isPartial ? "text-amber-500" : "text-red-500";
  const dotCls = isUp ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : isPartial ? "bg-amber-500" : "bg-red-500";
  const borderCls = isUp ? "border-green-500/15" : isPartial ? "border-amber-500/15" : "border-red-500/15";
  const statusText = isUp ? "UP" : isPartial ? "STALE" : "DOWN";

  return (
    <div className={`rounded-lg p-4 bg-white/[0.02] border ${borderCls}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${dotCls}`} />
          <span className="text-[12px] font-mono font-bold text-white">{name}</span>
        </div>
        <span className={`text-[10px] font-mono font-bold ${statusCls}`}>{statusText}</span>
      </div>
      <div className="text-[9px] font-mono text-gray-400 mb-3">{detail}</div>
      <div className="flex gap-2">
        {!running ? (
          <button onClick={() => onExec(startCmd)} disabled={!!busy}
            className="flex-1 py-2 rounded text-[12px] font-mono font-bold transition-all disabled:opacity-40 bg-green-500 text-black">
            {busy === startCmd ? "⏳ Starting..." : "▶ START"}
          </button>
        ) : (
          <>
            <button onClick={() => { onExec(stopCmd); setTimeout(() => onExec(startCmd), 3000); }} disabled={!!busy}
              className="flex-1 py-2 rounded text-[11px] font-mono font-bold transition-all disabled:opacity-40 bg-amber-500/15 text-amber-500 border border-amber-500/30">
              {busy ? "⏳" : "↻"} RESTART
            </button>
            <button onClick={() => onExec(stopCmd)} disabled={!!busy}
              className="px-4 py-2 rounded text-[11px] font-mono font-bold transition-all disabled:opacity-40 bg-red-500/10 text-red-500 border border-red-500/20">
              ■ STOP
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── SQL Console ── */
/* ── Operator Message to Board ── */
function OperatorMessage() {
  const [message, setMessage] = useState("");
  const [current, setCurrent] = useState<{ id: number; message: string; created_at: string } | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/board?action=operator-message");
      const d = await res.json();
      setCurrent(d.message || null);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!message.trim()) return;
    setStatus("⏳ Saving...");
    try {
      const res = await fetch("/api/board", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setOperatorMessage", message: message.trim() }),
      });
      const d = await res.json();
      if (d.ok) { setStatus("✅ Message set — board will see it at next meeting"); setMessage(""); load(); }
      else setStatus(`❌ ${d.error}`);
    } catch (e: any) { setStatus(`❌ ${e.message}`); }
  };

  const clear = async () => {
    try {
      await fetch("/api/board", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clearOperatorMessage" }),
      });
      setCurrent(null); setStatus("Cleared");
    } catch {}
  };

  return (
    <div className={PANEL}>
      <h2 className={`text-sm font-mono font-bold mb-2 ${GOLD_TEXT}`}>💬 Message to Board</h2>
      <p className="text-[9px] font-mono text-gray-500 mb-2">
        This message appears at the top of every board meeting briefing. Use it to give the LLMs context they're missing.
      </p>
      {current && (
        <div className="mb-3 p-2 rounded border border-amber-500/20 bg-amber-500/5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] font-mono text-amber-400 font-bold">⚠ ACTIVE MESSAGE</span>
            <button onClick={clear} className="text-[9px] font-mono text-red-400 hover:text-red-300">✕ Clear</button>
          </div>
          <div className="text-[10px] font-mono text-amber-200 whitespace-pre-wrap">{current.message}</div>
        </div>
      )}
      <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3}
        className="w-full p-2 rounded text-[11px] font-mono border border-purple-500/10 bg-[#0a0a1a] text-white"
        placeholder="e.g. I have manually disabled 6 malformed filters. The pipeline works correctly. Stop discussing pipeline issues." />
      <div className="flex items-center gap-2 mt-1">
        <button onClick={send}
          className="px-3 py-1 rounded text-[10px] font-mono bg-amber-500 text-black font-bold hover:bg-amber-400">
          Send to Board
        </button>
        {status && <span className="text-[9px] font-mono text-gray-400">{status}</span>}
      </div>
    </div>
  );
}

/* ── Signal Health Monitor ── */
function SignalHealthMonitor({ data, ago }: { data: any; ago: (ts: string | null) => string }) {
  const tfLabel: Record<number, string> = { 1: '1m', 60: '1H', 1440: '1D' };
  const tfOrder = [1, 60, 1440];

  // Build per-TF stats
  const byTf: Record<number, Record<string, { last_1h: number; last_6h: number; last_24h: number }>> = {};
  for (const row of (data.byTimeframe || [])) {
    const bm = row.barMinutes;
    if (!byTf[bm]) byTf[bm] = {};
    byTf[bm][row.status] = { last_1h: row.last_1h || 0, last_6h: row.last_6h || 0, last_24h: row.last_24h || 0 };
  }

  // Open positions
  const openMap: Record<number, { count: number; oldest: string; min_hold: number }> = {};
  for (const row of (data.openPositions || [])) {
    openMap[row.barMinutes] = { count: row.count, oldest: row.oldest, min_hold: row.min_hold };
  }

  const f = data.filters || {};

  return (
    <div className={PANEL}>
      <h2 className={`text-sm font-mono font-bold mb-3 ${GOLD_TEXT}`}>📊 Signal Health Monitor</h2>

      {/* Filter summary bar */}
      <div className="flex gap-4 mb-4 text-[10px] font-mono">
        <span className="text-gray-400">Active filters: <span className="text-white font-bold">{f.active_filters || 0}</span></span>
        <span className="text-gray-400">Total filtered: <span className="text-red-400 font-bold">{(f.total_filtered || 0).toLocaleString()}</span></span>
        <span className="text-gray-400">Total passed: <span className="text-green-400 font-bold">{(f.total_passed || 0).toLocaleString()}</span></span>
        {(f.total_filtered + f.total_passed) > 0 && (
          <span className="text-gray-400">Block rate: <span className="text-amber-400 font-bold">
            {((f.total_filtered / (f.total_filtered + f.total_passed)) * 100).toFixed(0)}%
          </span></span>
        )}
      </div>

      {/* Per-timeframe grid */}
      <div className="grid grid-cols-3 gap-3">
        {tfOrder.map(bm => {
          const tf = byTf[bm] || {};
          const label = tfLabel[bm] || `${bm}m`;
          const opened = (tf.open?.last_24h || 0) + (tf.closed?.last_24h || 0) + (tf.filtered?.last_24h || 0);
          const filtered24 = tf.filtered?.last_24h || 0;
          const closed24 = tf.closed?.last_24h || 0;
          const open24 = tf.open?.last_24h || 0;
          const opened1h = (tf.open?.last_1h || 0) + (tf.closed?.last_1h || 0) + (tf.filtered?.last_1h || 0);
          const filtered1h = tf.filtered?.last_1h || 0;
          const opened6h = (tf.open?.last_6h || 0) + (tf.closed?.last_6h || 0) + (tf.filtered?.last_6h || 0);
          const filtered6h = tf.filtered?.last_6h || 0;
          const openPos = openMap[bm];
          const isEmpty = opened === 0 && !openPos;
          const isWarning = bm === 1 ? opened1h === 0 : bm === 60 ? opened6h === 0 : opened === 0;

          return (
            <div key={bm} className={`rounded-lg p-3 border ${
              isEmpty ? 'border-red-500/20 bg-red-500/5' :
              isWarning ? 'border-amber-500/20 bg-amber-500/5' :
              'border-green-500/15 bg-green-500/5'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[13px] font-mono font-bold text-white">{label}</span>
                <span className={`text-[9px] font-mono font-bold ${
                  isEmpty ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-green-400'
                }`}>
                  {isEmpty ? '⚠ NO SIGNALS' : isWarning ? '⚠ QUIET' : '● ACTIVE'}
                </span>
              </div>

              <table className="w-full text-[9px] font-mono">
                <thead>
                  <tr className="text-gray-500">
                    <td></td><td className="text-right">1h</td><td className="text-right">6h</td><td className="text-right">24h</td>
                  </tr>
                </thead>
                <tbody>
                  <tr className="text-gray-300">
                    <td className="text-gray-500">Generated</td>
                    <td className="text-right">{opened1h}</td>
                    <td className="text-right">{opened6h}</td>
                    <td className="text-right">{opened}</td>
                  </tr>
                  <tr className="text-red-400">
                    <td className="text-gray-500">Filtered</td>
                    <td className="text-right">{filtered1h}</td>
                    <td className="text-right">{filtered6h}</td>
                    <td className="text-right">{filtered24}</td>
                  </tr>
                  <tr className="text-green-400">
                    <td className="text-gray-500">Closed</td>
                    <td className="text-right">{tf.closed?.last_1h || 0}</td>
                    <td className="text-right">{tf.closed?.last_6h || 0}</td>
                    <td className="text-right">{closed24}</td>
                  </tr>
                </tbody>
              </table>

              {openPos && (
                <div className="mt-2 pt-2 border-t border-white/5 text-[9px] font-mono text-gray-400">
                  Open: <span className="text-white font-bold">{openPos.count}</span>
                  {openPos.oldest && <> · oldest: {ago(openPos.oldest)}</>}
                </div>
              )}
              {!openPos && bm !== 1 && (
                <div className="mt-2 pt-2 border-t border-white/5 text-[9px] font-mono text-gray-500">
                  No open positions
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SqlConsole() {
  const [sql, setSql] = useState("");
  const [result, setResult] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async () => {
    try {
      const res = await adminFetch("/api/admin/sql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const d = await res.json();
      setResult(JSON.stringify(d, null, 2));
      setCopied(false);
    } catch (e: any) { setResult(e.message); }
  };

  const copy = () => {
    navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={PANEL}>
      <div className="text-[10px] font-mono text-gray-400 mb-1">SQL Console</div>
      <textarea value={sql} onChange={e => setSql(e.target.value)} rows={3}
        className="w-full p-2 rounded text-[11px] font-mono border border-purple-500/10 bg-[#0a0a1a] text-white"
        placeholder='SELECT COUNT(*) FROM "FracmapSignal"' />
      <button onClick={run} className="mt-1 px-3 py-1 rounded text-[10px] font-mono bg-purple-400 text-black font-bold">Run</button>
      {result && (
        <div className="mt-2">
          <button onClick={copy}
            className={`mb-1 px-2 py-1 rounded text-[9px] font-mono font-bold transition-all ${
              copied ? "bg-green-500 text-black" : "bg-purple-400/80 text-black hover:bg-purple-300"
            }`}>
            {copied ? "✓ Copied" : "📋 Copy"}
          </button>
          <pre className="p-2 rounded text-[9px] font-mono overflow-auto max-h-48 bg-black/30 text-gray-300">{result}</pre>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   FILTER IMPACT CHARTS — Cumulative inverted returns per filter
   Rising = filter saving money, Falling = filter blocking winners
   ═══════════════════════════════════════════════════════════════ */

type FilterSeriesPoint = {
  time: string; symbol: string; direction: string;
  hypothetical_return: number; inverted_return: number; cumulative_inverted: number;
};

type FilterImpactData = {
  filter_id: number; feature: string; timeframe: string; deployed_at: string;
  trades_passed: number; trades_filtered: number; block_rate: string;
  evaluated: number; cumulative_inverted_return: number; avg_inverted_per_trade: number;
  verdict: string; series: FilterSeriesPoint[];
};

function ImpactMiniChart({ series, width = 320, height = 80 }: { series: FilterSeriesPoint[]; width?: number; height?: number }) {
  if (series.length < 2) {
    return <div className="flex items-center justify-center font-mono text-[9px] text-gray-600" style={{ width, height }}>
      {series.length} signal{series.length !== 1 ? "s" : ""} — waiting for data
    </div>;
  }
  const values = series.map(s => s.cumulative_inverted);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const range = maxV - minV || 1;
  const pad = 2;
  const cW = width - pad * 2;
  const cH = height - pad * 2;
  const zeroY = pad + ((maxV - 0) / range) * cH;

  const pts = series.map((s, i) => {
    const x = pad + (i / (series.length - 1)) * cW;
    const y = pad + ((maxV - s.cumulative_inverted) / range) * cH;
    return `${x},${y}`;
  });
  const linePath = `M${pts.join(" L")}`;
  const fillPath = `${linePath} L${pad + cW},${zeroY} L${pad},${zeroY} Z`;
  const finalVal = values[values.length - 1];
  const isPos = finalVal >= 0;
  const lineCol = isPos ? "#22c55e" : "#ef4444";
  const fillCol = isPos ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)";

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <line x1={pad} y1={zeroY} x2={width - pad} y2={zeroY} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="3,3" />
      <path d={fillPath} fill={fillCol} />
      <path d={linePath} fill="none" stroke={lineCol} strokeWidth="1.5" />
      <circle cx={pad + cW} cy={pad + ((maxV - finalVal) / range) * cH} r="2.5" fill={lineCol} />
    </svg>
  );
}

function FilterImpactPanel() {
  const [filters, setFilters] = useState<Record<string, FilterImpactData>>({});
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(168);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/board/filter-impact?hours=${hours}`);
      const d = await res.json();
      if (d && !d.error) setFilters(d);
      setLoading(false);
    } catch { setLoading(false); }
  }, [hours]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  const filterList = Object.values(filters).sort((a, b) => b.cumulative_inverted_return - a.cumulative_inverted_return);
  const totalFiltered = filterList.reduce((s, f) => s + f.trades_filtered, 0);
  const totalPassed = filterList.reduce((s, f) => s + f.trades_passed, 0);
  const totalInverted = filterList.reduce((s, f) => s + f.cumulative_inverted_return, 0);
  const helping = filterList.filter(f => f.verdict === "HELPING").length;
  const hurting = filterList.filter(f => f.verdict === "HURTING").length;

  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className={`text-sm font-mono font-bold ${GOLD_TEXT}`}>📈 Filter Impact — Live</h2>
          <p className="text-[9px] font-mono text-gray-500 mt-0.5">
            Cumulative inverted returns of blocked signals. ↑ = filter saving money. ↓ = filter blocking winners.
          </p>
        </div>
        <div className="flex gap-1">
          {[24, 72, 168].map(h => (
            <button key={h} onClick={() => setHours(h)}
              className={`text-[9px] font-mono px-2 py-1 rounded transition-all border ${
                hours === h ? `${GOLD_TEXT} ${GOLD_BG}` : "text-gray-500 border-white/5 bg-white/[0.02]"
              }`}>{h}h</button>
          ))}
        </div>
      </div>

      {/* Aggregate bar */}
      <div className="flex gap-6 mb-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
        <div className="text-center">
          <div className="text-[8px] font-mono uppercase tracking-wider text-gray-500">Net Filter Value</div>
          <div className={`text-xl font-mono font-black tabular-nums ${totalInverted >= 0 ? "text-green-400" : "text-red-400"}`}>
            {totalInverted >= 0 ? "+" : ""}{totalInverted.toFixed(2)}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-[8px] font-mono uppercase tracking-wider text-gray-500">Blocked</div>
          <div className="text-base font-mono font-bold text-white">{totalFiltered.toLocaleString()}</div>
        </div>
        <div className="text-center">
          <div className="text-[8px] font-mono uppercase tracking-wider text-gray-500">Passed</div>
          <div className="text-base font-mono font-bold text-white">{totalPassed.toLocaleString()}</div>
        </div>
        <div className="text-center">
          <div className="text-[8px] font-mono uppercase tracking-wider text-gray-500">Block Rate</div>
          <div className="text-base font-mono font-bold text-white">
            {totalFiltered + totalPassed > 0 ? ((totalFiltered / (totalFiltered + totalPassed)) * 100).toFixed(1) : "0"}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-[8px] font-mono uppercase tracking-wider text-gray-500">Helping</div>
          <div className="text-base font-mono font-bold text-green-400">{helping}</div>
        </div>
        <div className="text-center">
          <div className="text-[8px] font-mono uppercase tracking-wider text-gray-500">Hurting</div>
          <div className="text-base font-mono font-bold text-red-400">{hurting}</div>
        </div>
      </div>

      {/* Filter cards grid */}
      {loading ? (
        <div className="text-center py-6 font-mono text-[10px] text-gray-500">Loading filter impact data...</div>
      ) : filterList.length === 0 ? (
        <div className="text-center py-6 font-mono text-[10px] text-gray-500">No active filters found</div>
      ) : (
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
          {filterList.map(f => {
            const isPos = f.cumulative_inverted_return >= 0;
            const verdictCol = f.verdict === "HELPING" ? "text-green-400" : f.verdict === "HURTING" ? "text-red-400" : "text-gray-500";
            const verdictLabel = f.verdict === "HELPING" ? "✅ HELPING" : f.verdict === "HURTING" ? "❌ HURTING" : "⏳ Low data";
            const hoursActive = Math.round((Date.now() - new Date(f.deployed_at).getTime()) / 3600000);
            return (
              <div key={f.filter_id} className={`rounded-lg p-3 border ${
                isPos ? "border-green-500/10 bg-green-500/[0.02]" : "border-red-500/10 bg-red-500/[0.02]"
              }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-mono font-bold text-white">
                    #{f.filter_id} {f.feature}
                  </span>
                  <span className={`text-[9px] font-mono font-bold ${verdictCol}`}>{verdictLabel}</span>
                </div>
                <div className="flex gap-3 mb-2 text-[8px] font-mono text-gray-500">
                  <span>Block: <span className="text-gray-300">{f.block_rate}%</span></span>
                  <span>Eval: <span className="text-gray-300">{f.evaluated}</span></span>
                  <span>Age: <span className="text-gray-300">{hoursActive}h</span></span>
                  <span>{(f.timeframe || "all").toUpperCase()}</span>
                </div>
                <ImpactMiniChart series={f.series} width={300} height={70} />
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[8px] font-mono text-gray-600">cumulative filter value</span>
                  <span className={`text-[14px] font-mono font-black tabular-nums ${isPos ? "text-green-400" : "text-red-400"}`}>
                    {isPos ? "+" : ""}{f.cumulative_inverted_return.toFixed(2)}%
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[8px] font-mono text-gray-600">per trade avg</span>
                  <span className={`text-[10px] font-mono font-bold tabular-nums ${f.avg_inverted_per_trade >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {f.avg_inverted_per_trade >= 0 ? "+" : ""}{f.avg_inverted_per_trade.toFixed(4)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-center mt-3">
        <span className="text-[8px] font-mono text-gray-600">Auto-refreshes every 60s · Inverted returns: chart ↑ = filter saving money · chart ↓ = filter blocking winners</span>
      </div>
    </div>
  );
}
