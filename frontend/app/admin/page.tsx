"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";

const GOLD = "#D4A843";

const FracmapScanner = dynamic(() => import("@/components/FracmapScanner"), { ssr: false });
const FracmapLive = dynamic(() => import("@/components/FracmapLive"), { ssr: false });
const FracmapTopography = dynamic(() => import("@/components/FracmapTopography"), { ssr: false });
const FracmapTab = dynamic(() => import("@/components/FracmapTab"), { ssr: false });
const ResearchLog = dynamic(() => import("@/components/ResearchLog"), { ssr: false });
const LLMBoard = dynamic(() => import("@/components/LLMBoard"), { ssr: false });

type AdminTab = "live" | "scanner" | "signals" | "topo" | "research" | "board" | "ops";

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("live");
  const [auth, setAuth] = useState(false);
  const [pin, setPin] = useState("");

  useEffect(() => {
    const saved = sessionStorage.getItem("ntlgnc_admin");
    if (saved === "1") setAuth(true);
  }, []);

  const handleAuth = () => {
    if (pin === (process.env.NEXT_PUBLIC_ADMIN_PIN || "1234")) {
      setAuth(true);
      sessionStorage.setItem("ntlgnc_admin", "1");
    }
  };

  if (!auth) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="p-6 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(167,139,250,0.2)" }}>
          <div className="text-sm font-mono font-bold mb-3" style={{ color: "#a78bfa" }}>⚙ Admin Access</div>
          <input type="password" value={pin} onChange={e => setPin(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAuth()}
            className="px-3 py-2 rounded text-sm font-mono border w-48" style={{ background: "#0a0a1a", borderColor: "rgba(167,139,250,0.2)", color: "white" }}
            placeholder="PIN" autoFocus />
          <button onClick={handleAuth} className="ml-2 px-4 py-2 rounded text-sm font-mono font-bold" style={{ background: "#a78bfa", color: "#000" }}>→</button>
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
    { id: "board", label: "🏛 Board" },
    { id: "ops", label: "🔧 Ops" },
  ];

  return (
    <div className="max-w-[95vw] mx-auto px-4 py-4">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-sm font-mono font-bold" style={{ color: "#a78bfa" }}>⚙ ADMIN</span>
        <div className="flex gap-px rounded overflow-hidden border" style={{ borderColor: "rgba(167,139,250,0.15)" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className="px-3 py-1.5 text-[11px] font-mono transition-all" style={{
              background: tab === t.id ? "rgba(167,139,250,0.1)" : "transparent",
              color: tab === t.id ? "#a78bfa" : "rgba(255,255,255,0.55)",
            }}>{t.label}</button>
          ))}
        </div>
        <div className="flex-1" />
        <a href="/" className="text-[10px] font-mono text-white/40 hover:text-white/60 mr-3">← Public site</a>
        <button onClick={() => { sessionStorage.removeItem("ntlgnc_admin"); setAuth(false); }} className="text-[10px] font-mono text-white/40 hover:text-white/60">Logout</button>
      </div>

      {tab === "live" && <FracmapLive />}
      {tab === "scanner" && <FracmapScanner />}
      {tab === "signals" && <FracmapTab />}
      {tab === "topo" && <FracmapTopography />}
      {tab === "research" && <ResearchLog />}
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
  };
} | null;

function OpsPanel() {
  const [health, setHealth] = useState<HealthData>(null);
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState("");
  const [lastCheck, setLastCheck] = useState<Date | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/exec");
      const d = await res.json();
      if (!d.error) setHealth(d);
      setLastCheck(new Date());
    } catch {}
  }, []);

  useEffect(() => {
    fetchHealth();
    const iv = setInterval(fetchHealth, 15000); // refresh every 15s
    return () => clearInterval(iv);
  }, [fetchHealth]);

  const exec = async (id: string) => {
    setRunning(id);
    setOutput("Running...");
    try {
      const res = await fetch("/api/admin/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const d = await res.json();
      setOutput(d.output || d.error || JSON.stringify(d));
      // Refresh health after a command
      setTimeout(fetchHealth, 3000);
    } catch (e: any) { setOutput(e.message); }
    setRunning("");
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

  return (
    <div className="space-y-6">
      {/* ── SYSTEM STATUS ── */}
      <div className="rounded-xl p-5" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-mono font-bold" style={{ color: GOLD }}>System Status</h2>
          <span className="text-[9px] font-mono text-white/30">
            {lastCheck ? `checked ${ago(lastCheck.toISOString())}` : "checking..."} · auto-refreshes every 15s
          </span>
        </div>

        {!health ? (
          <div className="text-[11px] font-mono text-white/40">Loading health data...</div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {/* Services */}
            <ServiceCard
              name="1m Data Collection"
              processKey="live_fetch"
              running={health.processes.live_fetch}
              dataFresh={!isStale(health.data.candle1m.latest, 5)}
              detail={`${health.data.candle1m.recentCoins} coins active · last: ${ago(health.data.candle1m.latest)}`}
              startCmd="live_fetch"
              stopCmd="stop_live_fetch"
              onExec={exec}
              busy={running}
            />
            <ServiceCard
              name="Signal Engine"
              processKey="live_signals"
              running={health.processes.live_signals}
              dataFresh={!isStale(health.data.signals.latest, 30)}
              detail={`${health.data.signals.total} total · ${health.data.signals.open} open · last: ${ago(health.data.signals.latest)}`}
              startCmd="live_signals"
              stopCmd="stop_live_signals"
              onExec={exec}
              busy={running}
            />
            <ServiceCard
              name="Hourly Data"
              processKey="live_fetch_hourly"
              running={health.processes.live_fetch_hourly}
              dataFresh={!isStale(health.data.candle1h.latest, 120)}
              detail={`${health.data.candle1h.recentCoins} coins · last: ${ago(health.data.candle1h.latest)}`}
              startCmd="live_fetch_hourly"
              stopCmd="stop_live_fetch_hourly"
              onExec={exec}
              busy={running}
            />
            <ServiceCard
              name="Daily Data"
              processKey="live_fetch_daily"
              running={health.processes.live_fetch_daily}
              dataFresh={!isStale(health.data.candle1d.latest, 1500)}
              detail={`${health.data.candle1d.recentCoins} coins · last: ${ago(health.data.candle1d.latest)}`}
              startCmd="live_fetch_daily"
              stopCmd="stop_live_fetch_daily"
              onExec={exec}
              busy={running}
            />
          </div>
        )}
      </div>

      {/* ── BACKFILL & UTILITIES ── */}
      <div className="rounded-xl p-5" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <h2 className="text-sm font-mono font-bold mb-3" style={{ color: GOLD }}>Backfill & Utilities</h2>
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
              className="px-3 py-1.5 rounded text-[11px] font-mono transition-all disabled:opacity-40"
              style={{ background: "rgba(167,139,250,0.08)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.15)" }}>
              {running === op.id ? "⏳" : "▶"} {op.label}
            </button>
          ))}
        </div>
      </div>

      {/* Command output */}
      {output && (
        <pre className="p-3 rounded text-[10px] font-mono overflow-auto max-h-96" style={{ background: "rgba(0,0,0,0.3)", color: "rgba(255,255,255,0.6)" }}>{output}</pre>
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

  const statusColor = isUp ? "#22c55e" : isPartial ? "#f59e0b" : "#ef4444";
  const statusText = isUp ? "UP" : isPartial ? "STALE" : "DOWN";

  return (
    <div className="rounded-lg p-4" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${statusColor}22` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: statusColor, boxShadow: isUp ? `0 0 8px ${statusColor}` : "none" }} />
          <span className="text-[12px] font-mono font-bold text-white">{name}</span>
        </div>
        <span className="text-[10px] font-mono font-bold" style={{ color: statusColor }}>{statusText}</span>
      </div>
      <div className="text-[9px] font-mono text-white/40 mb-3">{detail}</div>
      <div className="flex gap-2">
        {!running ? (
          <button onClick={() => onExec(startCmd)} disabled={!!busy}
            className="flex-1 py-2 rounded text-[12px] font-mono font-bold transition-all disabled:opacity-40"
            style={{ background: "#22c55e", color: "#000" }}>
            {busy === startCmd ? "⏳ Starting..." : "▶ START"}
          </button>
        ) : (
          <>
            <button onClick={() => { onExec(stopCmd); setTimeout(() => onExec(startCmd), 3000); }} disabled={!!busy}
              className="flex-1 py-2 rounded text-[11px] font-mono font-bold transition-all disabled:opacity-40"
              style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)" }}>
              {busy ? "⏳" : "↻"} RESTART
            </button>
            <button onClick={() => onExec(stopCmd)} disabled={!!busy}
              className="px-4 py-2 rounded text-[11px] font-mono font-bold transition-all disabled:opacity-40"
              style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
              ■ STOP
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── SQL Console ── */
function SqlConsole() {
  const [sql, setSql] = useState("");
  const [result, setResult] = useState("");

  const run = async () => {
    try {
      const res = await fetch("/api/admin/sql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const d = await res.json();
      setResult(JSON.stringify(d, null, 2));
    } catch (e: any) { setResult(e.message); }
  };

  return (
    <div className="rounded-xl p-5" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div className="text-[10px] font-mono text-white/50 mb-1">SQL Console</div>
      <textarea value={sql} onChange={e => setSql(e.target.value)} rows={3}
        className="w-full p-2 rounded text-[11px] font-mono border" style={{ background: "#0a0a1a", borderColor: "rgba(167,139,250,0.1)", color: "white" }}
        placeholder='SELECT COUNT(*) FROM "FracmapSignal"' />
      <button onClick={run} className="mt-1 px-3 py-1 rounded text-[10px] font-mono" style={{ background: "#a78bfa", color: "#000" }}>Run</button>
      {result && <pre className="mt-2 p-2 rounded text-[9px] font-mono overflow-auto max-h-48" style={{ background: "rgba(0,0,0,0.3)", color: "rgba(255,255,255,0.55)" }}>{result}</pre>}
    </div>
  );
}
