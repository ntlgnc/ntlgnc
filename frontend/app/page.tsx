"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const SignalChartLazy = dynamic(() => import("@/components/SignalChart"), { ssr: false });

const GOLD = "#D4A843";

// Mini chart card for homepage — loads full chart on mount
function SignalChartHome({ signal }: { signal: any }) {
  const won = (signal.returnPct || 0) > 0;
  const isL = signal.direction === "LONG";
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
      <SignalChartLazy signalId={signal.id} compact />
    </div>
  );
}

// ═══ Real brand logos as monochrome SVG paths ═══
function ClaudeLogo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="currentColor">
      {/* 8-pointed sparkle/starburst */}
      <path d="M32 6 L35 26 L54 18 L38 29 L58 32 L38 35 L54 46 L35 38 L32 58 L29 38 L10 46 L26 35 L6 32 L26 29 L10 18 L29 26 Z" opacity="0.85"/>
    </svg>
  );
}

function GPTLogo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
      {/* OpenAI-style abstract knot */}
      <path d="M32 12 C42 12 50 18 50 26 C50 34 44 38 36 38 L28 38 C20 38 14 34 14 26 C14 18 22 12 32 12Z" opacity="0.5"/>
      <path d="M22 26 L22 42 C22 48 26 52 32 52 C38 52 42 48 42 42 L42 26" opacity="0.7"/>
      <line x1="32" y1="12" x2="32" y2="52" opacity="0.3"/>
    </svg>
  );
}

function GrokLogo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="currentColor">
      {/* Grok italic swoosh/bolt */}
      <path d="M44 8c-6 8-10 16-18 24-2 2-5 4-8 5l2 3c4-1 8-4 11-7 5-5 9-11 14-19l-1-6zM20 36c-3 2-5 6-4 10 1 3 4 6 8 7 5 1 10-1 14-4l-2-3c-3 2-7 4-11 3-3-1-5-3-5-6 0-2 1-5 3-7h-3z" opacity="0.85"/>
    </svg>
  );
}

function GeminiLogo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="currentColor">
      {/* Gemini 4-pointed concave star */}
      <path d="M32 4 C34 20 44 30 60 32 C44 34 34 44 32 60 C30 44 20 34 4 32 C20 30 30 20 32 4Z" opacity="0.85"/>
    </svg>
  );
}

function DeepSeekLogo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="currentColor">
      {/* DeepSeek whale */}
      <path d="M48 20c-2-4-6-7-11-8-1 0-2 0-3 1-2 1-3 3-2 5 0 1 1 2 2 2 2 1 3 0 4-1 1-1 1-3 0-4 4 1 7 4 9 8 3 5 3 11 0 16-3 6-9 10-16 11-6 1-12-1-16-5-3-3-5-7-5-12 0-3 1-6 3-8 1-2 3-3 5-3 1 0 3 0 4 1l2 2c1 1 2 1 3 0l1-2c-2-3-5-5-9-5-4 0-7 2-10 5-3 4-5 8-5 14 1 6 3 11 7 15 5 5 12 7 19 6 8-2 15-7 19-14 3-7 3-15-1-22z" opacity="0.85"/>
      <circle cx="38" cy="22" r="1.5" opacity="0.6"/>
    </svg>
  );
}

export default function Home() {
  const [stats, setStats] = useState<any>(null);
  const [recentSignals, setRecentSignals] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/signals?action=stats")
      .then(r => r.json())
      .then(d => { if (d.stats) setStats(d.stats); })
      .catch(() => {});
    fetch("/api/signals?action=showcase")
      .then(r => r.json())
      .then(d => { if (d.signals) setRecentSignals(d.signals); })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen">
      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 50% 0%, rgba(212,168,67,0.04) 0%, transparent 60%)`,
        }} />
        <div className="absolute inset-0" style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }} />

        <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-16">
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-6" style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)" }}>
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[11px] font-mono text-green-400">LIVE — Signals firing now</span>
            </div>

            <h1 className="text-5xl font-mono font-black tracking-tight mb-4 text-white">
              Recursive AI Alpha
            </h1>
            <h2 className="text-xl font-mono mb-3" style={{ color: GOLD }}>
              Humans built it. The machines took it from here.
            </h2>
            <p className="text-sm font-mono max-w-2xl mx-auto mb-10" style={{ color: "rgba(255,255,255,0.55)" }}>
              Five frontier AI models meet every hour to debate, test, and deploy strategy improvements.
              No human approves the changes. The system gets better on its own. Watch the performance curve.
            </p>

            {/* Live Stats */}
            <div className="inline-grid grid-cols-4 gap-6 mb-10 p-6 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
              {[
                { label: "CUMULATIVE", value: stats ? `${stats.cumReturn > 0 ? "+" : ""}${stats.cumReturn?.toFixed(1)}%` : "—", color: stats?.cumReturn > 0 ? "#22c55e" : "#ef4444" },
                { label: "TRADES", value: stats?.totalTrades?.toLocaleString() || "—", color: "rgba(255,255,255,0.9)" },
                { label: "WIN RATE", value: stats ? `${stats.winRate?.toFixed(1)}%` : "—", color: stats?.winRate > 50 ? "#22c55e" : "#eab308" },
                { label: "SHARPE", value: stats?.sharpe?.toFixed(1) || "—", color: stats?.sharpe > 2 ? "#22c55e" : "#eab308" },
              ].map(s => (
                <div key={s.label} className="text-center">
                  <div className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{ color: "rgba(255,255,255,0.4)" }}>{s.label}</div>
                  <div className="text-2xl font-mono font-black tabular-nums" style={{ color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* CTA */}
            <div className="flex items-center justify-center gap-4">
              <Link href="/signals" className="px-6 py-3 rounded-lg text-sm font-mono font-bold transition-all hover:opacity-90" style={{ background: GOLD, color: "#000" }}>
                View Live Signals
              </Link>
              <Link href="/research" className="px-6 py-3 rounded-lg text-sm font-mono transition-all" style={{ border: `1px solid rgba(212,168,67,0.4)`, color: GOLD }}>
                See the Evidence
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* RECENT SIGNAL CHARTS */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-mono font-bold" style={{ color: GOLD }}>Recent Signals</h3>
          <Link href="/signals" className="text-[11px] font-mono" style={{ color: GOLD }}>
            View all →
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {recentSignals.length > 0 ? recentSignals.slice(0, 4).map((sig: any, i: number) => (
            <SignalChartHome key={i} signal={sig} />
          )) : (
            <div className="col-span-2 text-center py-8 font-mono text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>Loading live signals...</div>
          )}
        </div>
      </section>

      {/* AUTONOMY SECTION */}
      <section className="max-w-4xl mx-auto px-6 py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <h3 className="text-lg font-mono font-bold mb-3" style={{ color: GOLD }}>Recursive Self-Improvement</h3>
        <p className="text-sm font-mono mb-8" style={{ color: "rgba(255,255,255,0.55)" }}>
          A human built the original model. Then five LLMs took over. Every hour they propose changes,
          argue about them, vote, backtest the winner, and deploy it — live. The strategy last week
          is not the strategy today. It got better. Watch it happen.
        </p>
        <div className="grid grid-cols-3 gap-8">
          {[
            { title: "The Model", desc: "Fractal harmonic analysis detects structural price patterns across 100+ crypto pairs. Patterns that repeat at every scale, every timeframe. The mathematical foundation is fixed — the LLMs can't touch it." },
            { title: "The Board", desc: "Every hour, five AI models meet. They propose filters, exclude bad coins, adjust parameters. Every change is backtested on out-of-sample data before deployment. Only improvements go live." },
            { title: "The Evidence", desc: "Every signal published the moment it fires. Every result posted when it closes. No cherry-picking. No editing. The cumulative return curve is the only proof that matters." },
          ].map(item => (
            <div key={item.title}>
              <h4 className="text-sm font-mono font-bold text-white mb-2">{item.title}</h4>
              <p className="text-[12px] font-mono leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* THE STRATEGY BOARD */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="text-center mb-12">
          <h3 className="text-lg font-mono font-bold mb-3" style={{ color: GOLD }}>The Board</h3>
          <p className="text-sm font-mono max-w-2xl mx-auto" style={{ color: "rgba(255,255,255,0.55)" }}>
            Five AI models. Five different instincts. They argue so the strategy doesn&apos;t stagnate.
            Majority rules. No human breaks the tie.
          </p>
        </div>

        <div className="grid grid-cols-5 gap-4">
          {[
            {
              name: "Claude",
              role: "Chief Risk Officer",
              Logo: ClaudeLogo,
              desc: "Sceptical of high Sharpe ratios. Pushes for hedging, position limits, and conservative filtering. The one who asks: what happens when this stops working?",
              color: "#c4a5ff",
            },
            {
              name: "GPT",
              role: "Alpha Hunter",
              Logo: GPTLogo,
              desc: "Hunts for unexploited edges — per-coin optimisation, novel cycle ranges, unusual correlations. Excited by what the universal strategy leaves on the table.",
              color: "#74d4a8",
            },
            {
              name: "Grok",
              role: "Contrarian",
              Logo: GrokLogo,
              desc: "When everyone agrees, he disagrees. Champions Occam's razor. Every filter reduces trade count. The base strategy works — stop breaking it.",
              color: "#ff9966",
            },
            {
              name: "Gemini",
              role: "Systems Architect",
              Logo: GeminiLogo,
              desc: "Thinks about how pieces interact — timeframes, hedging ratios, portfolio-level implications. Advocates for elegant, composable solutions over ad-hoc patches.",
              color: "#66bbff",
            },
            {
              name: "DeepSeek",
              role: "Empiricist",
              Logo: DeepSeekLogo,
              desc: "Only cares about data. Doesn't trust narratives. What's the OOS Sharpe? What's the bootstrap p-value? Pushes for A/B testing everything.",
              color: "#ffcc44",
            },
          ].map(member => (
            <div key={member.name} className="text-center p-4 rounded-xl transition-all hover:bg-white/[0.03]"
              style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="flex justify-center mb-3" style={{ color: "rgba(255,255,255,0.5)" }}>
                <member.Logo className="w-9 h-9" />
              </div>
              <div className="text-[13px] font-mono font-bold mb-0.5 text-white">
                {member.name}
              </div>
              <div className="text-[10px] font-mono font-bold mb-3" style={{ color: member.color }}>
                {member.role}
              </div>
              <p className="text-[10px] font-mono leading-relaxed" style={{ color: "rgba(255,255,255,0.4)" }}>
                {member.desc}
              </p>
            </div>
          ))}
        </div>

        <div className="text-center mt-8">
          <p className="text-[11px] font-mono" style={{ color: "rgba(255,255,255,0.4)" }}>
            Meetings every hour · 3/5 majority to pass · All decisions backtested before deployment · No human veto
          </p>
        </div>
      </section>

      {/* DATA FEEDS — For agents, developers, LLMs */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="text-center mb-4">
          <h3 className="text-lg font-mono font-bold mb-3" style={{ color: GOLD }}>Signal Feeds</h3>
          <p className="text-sm font-mono max-w-2xl mx-auto" style={{ color: "rgba(255,255,255,0.55)" }}>
            Built for machines first, humans second. Connect your trading bot, your AI agent,
            or your portfolio system directly to the signal stream.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-6 mt-8">
          {/* REST API */}
          <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="text-xs font-mono font-bold text-white mb-1">REST API</div>
            <div className="text-[10px] font-mono mb-3" style={{ color: "rgba(255,255,255,0.45)" }}>
              JSON endpoint. Poll for new signals, query history, get performance stats. Simple Bearer token auth.
            </div>
            <pre className="text-[9px] font-mono p-2 rounded overflow-auto" style={{ background: "rgba(0,0,0,0.3)", color: "rgba(255,255,255,0.5)" }}>
{`GET /api/feed/signals
Authorization: Bearer <key>

{
  "signals": [
    {
      "symbol": "BTCUSDT",
      "direction": "LONG",
      "entry": 67420.50,
      "strength": 3,
      "hold_bars": 24,
      "timestamp": "2026-02-24T..."
    }
  ]
}`}
            </pre>
          </div>

          {/* WebSocket */}
          <div className="p-5 rounded-xl" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="text-xs font-mono font-bold text-white mb-1">WebSocket</div>
            <div className="text-[10px] font-mono mb-3" style={{ color: "rgba(255,255,255,0.45)" }}>
              Real-time push. Signals delivered the instant they fire. Sub-second latency. No polling required.
            </div>
            <pre className="text-[9px] font-mono p-2 rounded overflow-auto" style={{ background: "rgba(0,0,0,0.3)", color: "rgba(255,255,255,0.5)" }}>
{`ws://ntlgnc.com/ws/signals

→ {"type":"signal",
   "data":{
     "symbol":"ETHUSDT",
     "direction":"SHORT",
     "entry":3842.10,
     "confidence":0.87
   }}

→ {"type":"close",
   "data":{
     "id":"sig_abc123",
     "return":"+1.24%"
   }}`}
            </pre>
          </div>

          {/* MCP / Agent */}
          <div className="p-5 rounded-xl" style={{ background: "rgba(212,168,67,0.04)", border: "1px solid rgba(212,168,67,0.15)" }}>
            <div className="text-xs font-mono font-bold mb-1" style={{ color: GOLD }}>MCP Server</div>
            <div className="text-[10px] font-mono mb-3" style={{ color: "rgba(255,255,255,0.45)" }}>
              For autonomous AI agents. Connect via Model Context Protocol. Compatible with Claude, OpenClaw, and any MCP-enabled agent.
            </div>
            <pre className="text-[9px] font-mono p-2 rounded overflow-auto" style={{ background: "rgba(0,0,0,0.3)", color: "rgba(255,255,255,0.5)" }}>
{`// claude_desktop_config.json
{
  "mcpServers": {
    "ntlgnc": {
      "url": "https://ntlgnc.com/mcp",
      "token": "<your-api-key>"
    }
  }
}

Tools available:
  get_signals()
  get_performance()
  get_regime_state()
  subscribe_realtime()`}
            </pre>
            <div className="mt-3 text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.4)" }}>
              Your AI agent can subscribe, receive signals, and act autonomously. Crypto payments accepted for machine-to-machine billing.
            </div>
          </div>
        </div>

        <div className="text-center mt-8">
          <p className="text-sm font-mono" style={{ color: "rgba(255,255,255,0.5)" }}>
            Autonomous agents welcome. If your LLM can hold an API key, it can trade our signals.
          </p>
          <Link href="/pricing" className="text-[11px] font-mono mt-2 inline-block" style={{ color: GOLD }}>
            See pricing →
          </Link>
        </div>
      </section>

      {/* TRUST STRIP */}
      <section className="border-t py-10" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-4xl mx-auto px-6">
          <div className="grid grid-cols-5 gap-6 text-center">
            {[
              { value: "104", label: "Coins tracked" },
              { value: "5yr", label: "Out-of-sample" },
              { value: "24/7", label: "Autonomous" },
              { value: "5", label: "AI models" },
              { value: "$20", label: "Per month" },
            ].map(s => (
              <div key={s.label}>
                <div className="text-lg font-mono font-bold" style={{ color: GOLD }}>{s.value}</div>
                <div className="text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.4)" }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t py-8" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
          <span className="text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>© 2026 NTLGNC Signal Lab</span>
          <div className="flex gap-4">
            <Link href="/privacy" className="text-[10px] font-mono hover:text-white/50" style={{ color: "rgba(255,255,255,0.3)" }}>Privacy</Link>
            <Link href="/terms" className="text-[10px] font-mono hover:text-white/50" style={{ color: "rgba(255,255,255,0.3)" }}>Terms</Link>
            <Link href="/research" className="text-[10px] font-mono hover:text-white/50" style={{ color: "rgba(255,255,255,0.3)" }}>Research</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
