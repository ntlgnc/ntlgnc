"use client";

import { useState, useEffect, useCallback } from "react";

const GOLD = "#D4A843";
const CYAN = "#06b6d4";

type Report = {
  id: number;
  created_at: string;
  report_type: string;
  title: string;
  oos_avg_sharpe: number | null;
  oos_consistency: string | null;
  oos_avg_winrate: number | null;
  oos_avg_pf: number | null;
  oos_avg_return: number | null;
  bar_minutes: number;
  total_signals: number | null;
  evolution_round: number | null;
  committee_decision: string | null;
  net_position: any;
  robustness: any;
  // Full report fields (only when viewing detail)
  per_coin_oos?: any;
  regime_features?: any;
  findings?: string;
  recommendations?: string;
  active_filters?: any;
  winner_strategy?: any;
};

const typeColors: Record<string, { color: string; label: string; icon: string }> = {
  hourly_scan: { color: "#22c55e", label: "Hourly Scan", icon: "📊" },
  robustness_audit: { color: "#a78bfa", label: "Robustness Audit", icon: "🔬" },
  regime_update: { color: CYAN, label: "Regime Update", icon: "🧬" },
  committee_review: { color: "#f97316", label: "Committee Review", icon: "🧠" },
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Generate robustness findings from scanner data
function generateFindings(report: Report): string {
  const lines: string[] = [];
  const sr = report.oos_avg_sharpe;
  if (sr !== null) {
    const se = sr * Math.sqrt(2 / 7); // ~7 days of OOS
    lines.push(`**OOS Sharpe: ${sr.toFixed(3)}** (SE ≈ ${se.toFixed(2)}, 95% CI [${(sr - 1.96 * se).toFixed(2)}, ${(sr + 1.96 * se).toFixed(2)}])`);
  }
  if (report.oos_consistency) {
    const [pos, total] = report.oos_consistency.split("/").map(Number);
    const pBinom = pos && total ? (1 - binomialCDF(pos - 1, total, 0.5)).toFixed(3) : "?";
    lines.push(`**Consistency: ${report.oos_consistency}** positive coins (binomial p = ${pBinom})`);
  }
  if (report.net_position) {
    const np = report.net_position;
    lines.push(`**Net Position:** avg ${np.avgNet?.toFixed(1) || "?"}, range [${np.maxShortBias || "?"}, +${np.maxLongBias || "?"}]`);
  }
  if (report.robustness) {
    const rb = report.robustness;
    if (rb.bootstrap_sig) lines.push(`**Bootstrap sig:** ${rb.bootstrap_sig} coins at p<0.05`);
    if (rb.bonferroni_sig_coins) lines.push(`**Bonferroni sig:** ${rb.bonferroni_sig_coins}`);
  }
  return lines.join("\n\n");
}

// Binomial CDF (for consistency test)
function binomialCDF(k: number, n: number, p: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += binomialPMF(i, n, p);
  }
  return sum;
}
function binomialPMF(k: number, n: number, p: number): number {
  return comb(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
}
function comb(n: number, k: number): number {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return r;
}

export default function ResearchLog() {
  const [reports, setReports] = useState<Report[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Report | null>(null);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load reports
  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (filterType) params.set("type", filterType);
      const res = await fetch(`/api/research-log?${params}`);
      const data = await res.json();
      setReports(data.reports || []);
      setTotal(data.total || 0);
    } catch { }
    setLoading(false);
  }, [filterType]);

  useEffect(() => { loadReports(); }, [loadReports]);

  // Load detail
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    fetch(`/api/research-log?id=${selectedId}`)
      .then(r => r.json())
      .then(d => setDetail(d.report || null))
      .catch(() => { });
  }, [selectedId]);

  // Log current scanner state (called from scanner)
  const logScannerReport = async (scanData: any) => {
    setSaving(true);
    try {
      await fetch("/api/research-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scanData),
      });
      await loadReports();
    } catch { }
    setSaving(false);
  };

  const srColor = (v: number | null) => !v ? "var(--text-dim)" : v > 5 ? "#22c55e" : v > 2 ? "#4ade80" : v > 0 ? "#eab308" : "#ef4444";

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[13px] font-mono font-bold" style={{ color: GOLD }}>📋 RESEARCH LOG</span>
        <span className="text-[9px] font-mono text-[var(--text-dim)]">
          Timestamped robustness reports for LLM Evolution Committee · {total} reports
        </span>
        <div className="flex-1" />
        <div className="flex gap-px rounded overflow-hidden border border-[var(--border)]">
          {[{ key: null, label: "All" }, ...Object.entries(typeColors).map(([k, v]) => ({ key: k, label: v.icon + " " + v.label }))].map(f => (
            <button key={f.key || "all"} onClick={() => setFilterType(f.key)}
              className="px-2 py-0.5 text-[9px] font-mono"
              style={{
                background: filterType === f.key ? "rgba(212,168,67,0.12)" : "transparent",
                color: filterType === f.key ? GOLD : "var(--text-dim)"
              }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="text-[10px] font-mono text-[var(--text-dim)] py-8 text-center">Loading research log...</div>}

      {!loading && reports.length === 0 && (
        <div className="text-[10px] font-mono text-[var(--text-dim)] py-8 text-center">
          No reports yet. Reports are automatically generated after each scanner run, or manually from the scanner's "Log to Research" button.
        </div>
      )}

      {!loading && reports.length > 0 && (
        <div className="flex gap-4">
          {/* Timeline list */}
          <div className="w-[380px] flex-shrink-0 border-r border-[var(--border)] pr-4 max-h-[600px] overflow-y-auto">
            {reports.map((r, i) => {
              const tc = typeColors[r.report_type] || { color: "#7c7c96", label: r.report_type, icon: "📄" };
              const isSelected = selectedId === r.id;
              return (
                <div key={r.id} className="relative">
                  {/* Timeline connector */}
                  {i < reports.length - 1 && (
                    <div className="absolute left-[11px] top-[28px] w-[2px] bottom-0" style={{ background: "var(--border)" }} />
                  )}
                  <button
                    onClick={() => setSelectedId(isSelected ? null : r.id)}
                    className="w-full text-left pl-8 pr-2 py-3 rounded-lg transition-all relative"
                    style={{
                      background: isSelected ? "rgba(212,168,67,0.08)" : "transparent",
                      border: isSelected ? `1px solid ${GOLD}30` : "1px solid transparent",
                    }}
                  >
                    {/* Timeline dot */}
                    <div className="absolute left-[6px] top-[14px] w-[12px] h-[12px] rounded-full border-2 flex items-center justify-center"
                      style={{
                        borderColor: tc.color,
                        background: isSelected ? tc.color : "var(--bg-card)",
                      }}>
                      {isSelected && <div className="w-[4px] h-[4px] rounded-full bg-black" />}
                    </div>

                    {/* Content */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[8px] font-mono px-1.5 py-0.5 rounded" style={{ color: tc.color, background: tc.color + "15", border: `1px solid ${tc.color}25` }}>
                        {tc.icon} {tc.label}
                      </span>
                      <span className="text-[8px] font-mono text-[var(--text-dim)]">{timeAgo(r.created_at)}</span>
                    </div>
                    <div className="text-[10px] font-mono font-semibold text-[var(--text)] mb-1 leading-snug">
                      {r.title}
                    </div>
                    <div className="flex items-center gap-3 text-[9px] font-mono tabular-nums">
                      {r.oos_avg_sharpe !== null && (
                        <span style={{ color: srColor(r.oos_avg_sharpe) }}>
                          SR {r.oos_avg_sharpe.toFixed(2)}
                        </span>
                      )}
                      {r.oos_consistency && (
                        <span className="text-[var(--text-dim)]">{r.oos_consistency}</span>
                      )}
                      {r.total_signals && (
                        <span className="text-[var(--text-dim)]">{r.total_signals} sigs</span>
                      )}
                      {r.committee_decision && (
                        <span className="text-[8px] px-1.5 py-0.5 rounded" style={{ color: "#f97316", background: "#f9731612", border: "1px solid #f9731625" }}>
                          🧠 {r.committee_decision.slice(0, 30)}
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Detail panel */}
          <div className="flex-1 min-w-0">
            {!detail && !selectedId && (
              <div className="text-[10px] font-mono text-[var(--text-dim)] py-12 text-center">
                ← Select a report to view details
              </div>
            )}

            {selectedId && !detail && (
              <div className="text-[10px] font-mono text-[var(--text-dim)] py-8 text-center">Loading...</div>
            )}

            {detail && (
              <div className="max-h-[600px] overflow-y-auto">
                {/* Report header */}
                <div className="border-b border-[var(--border)] pb-3 mb-4">
                  <div className="text-[12px] font-mono font-bold text-[var(--text)]">{detail.title}</div>
                  <div className="text-[9px] font-mono text-[var(--text-dim)] mt-1">
                    {formatDate(detail.created_at)} · {detail.bar_minutes}m bars · 
                    Cycles {detail.winner_strategy?.cycleMin || "?"}–{detail.winner_strategy?.cycleMax || "?"}
                  </div>
                </div>

                {/* KPI row */}
                <div className="grid grid-cols-5 gap-2 mb-4">
                  {[
                    { l: "OOS Sharpe", v: detail.oos_avg_sharpe?.toFixed(3) || "–", c: srColor(detail.oos_avg_sharpe) },
                    { l: "Consistency", v: detail.oos_consistency || "–", c: "var(--text)" },
                    { l: "Win Rate", v: detail.oos_avg_winrate ? detail.oos_avg_winrate.toFixed(1) + "%" : "–", c: (detail.oos_avg_winrate || 0) > 53 ? "#22c55e" : "#eab308" },
                    { l: "Profit Factor", v: detail.oos_avg_pf?.toFixed(2) || "–", c: (detail.oos_avg_pf || 0) > 1 ? "#22c55e" : "#ef4444" },
                    { l: "Avg Return", v: detail.oos_avg_return ? (detail.oos_avg_return > 0 ? "+" : "") + detail.oos_avg_return.toFixed(2) + "%" : "–", c: (detail.oos_avg_return || 0) > 0 ? "#22c55e" : "#ef4444" },
                  ].map(k => (
                    <div key={k.l} className="p-2 rounded border border-[var(--border)]">
                      <div className="text-[8px] font-mono text-[var(--text-dim)]">{k.l}</div>
                      <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: k.c }}>{k.v}</div>
                    </div>
                  ))}
                </div>

                {/* Winner strategy */}
                {detail.winner_strategy && (
                  <div className="p-3 rounded-lg border mb-4" style={{ borderColor: GOLD + "30", background: "rgba(212,168,67,0.04)" }}>
                    <div className="text-[9px] font-mono font-bold" style={{ color: GOLD }}>🏆 WINNER STRATEGY</div>
                    <div className="text-[11px] font-mono text-[var(--text)] mt-1">
                      Str ×{detail.winner_strategy.minStr} · MinCyc {detail.winner_strategy.minCyc === 0 ? "Any" : `≥${detail.winner_strategy.minCyc}`} · 
                      Spike {detail.winner_strategy.spike ? "⚡ On" : "Off"} · ±1 {detail.winner_strategy.nearMiss ? "On" : "Off"} · 
                      Hold ÷{detail.winner_strategy.holdDiv}
                    </div>
                  </div>
                )}

                {/* Per-coin OOS table */}
                {detail.per_coin_oos && Array.isArray(detail.per_coin_oos) && detail.per_coin_oos.length > 0 && (
                  <div className="mb-4">
                    <div className="text-[10px] font-mono font-bold mb-2" style={{ color: "#a78bfa" }}>PER-COIN OOS RESULTS</div>
                    <table className="w-full text-[9px] font-mono border-collapse">
                      <thead>
                        <tr className="border-b border-[var(--border)]">
                          {["Coin", "SR", "Win%", "Ret", "PF", "Trades"].map(h => (
                            <th key={h} className="px-1.5 py-1 text-left text-[var(--text-dim)] font-normal">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.per_coin_oos as any[]).sort((a: any, b: any) => (b.sharpe || 0) - (a.sharpe || 0)).map((c: any) => (
                          <tr key={c.coin} className="border-b border-[var(--border)] border-opacity-20">
                            <td className="px-1.5 py-1 font-semibold">{c.coin}</td>
                            <td className="px-1.5 py-1 tabular-nums" style={{ color: (c.sharpe || 0) > 0 ? "#22c55e" : "#ef4444" }}>{(c.sharpe || 0).toFixed(1)}</td>
                            <td className="px-1.5 py-1 tabular-nums">{(c.winRate || 0).toFixed(1)}%</td>
                            <td className="px-1.5 py-1 tabular-nums" style={{ color: (c.totalRet || 0) > 0 ? "#22c55e" : "#ef4444" }}>{(c.totalRet || 0) > 0 ? "+" : ""}{(c.totalRet || 0).toFixed(2)}%</td>
                            <td className="px-1.5 py-1 tabular-nums">{(c.pf || 0).toFixed(2)}</td>
                            <td className="px-1.5 py-1 tabular-nums text-[var(--text-dim)]">{c.trades || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Regime features */}
                {detail.regime_features && Array.isArray(detail.regime_features) && detail.regime_features.length > 0 && (
                  <div className="mb-4">
                    <div className="text-[10px] font-mono font-bold mb-2" style={{ color: CYAN }}>🧬 REGIME FEATURES SNAPSHOT</div>
                    <table className="w-full text-[9px] font-mono border-collapse">
                      <thead>
                        <tr className="border-b border-[var(--border)]">
                          <th className="px-1.5 py-1 text-left text-[var(--text-dim)] font-normal">Feature</th>
                          <th className="px-1.5 py-1 text-center text-[var(--text-dim)] font-normal">Spread</th>
                          <th className="px-1.5 py-1 text-center font-normal" style={{ color: "#a78bfa" }}>ρ</th>
                          <th className="px-1.5 py-1 text-left text-[var(--text-dim)] font-normal">Best → Worst</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.regime_features as any[]).sort((a: any, b: any) => (b.spread || 0) - (a.spread || 0)).map((f: any) => (
                          <tr key={f.feature} className="border-b border-[var(--border)] border-opacity-20">
                            <td className="px-1.5 py-1 font-semibold text-[var(--text)]">{f.feature}</td>
                            <td className="px-1.5 py-1 text-center tabular-nums" style={{ color: (f.spread || 0) > 10 ? CYAN : (f.spread || 0) > 3 ? "#22c55e" : "var(--text-dim)" }}>
                              {(f.spread || 0).toFixed(1)}
                            </td>
                            <td className="px-1.5 py-1 text-center tabular-nums" style={{ color: f.rho >= 0.8 ? "#22c55e" : f.rho >= 0.4 ? "#86efac" : f.rho >= 0 ? "#eab308" : "#ef4444" }}>
                              {f.rho !== null ? f.rho.toFixed(2) : "n/a"}
                            </td>
                            <td className="px-1.5 py-1 text-[var(--text-dim)]">
                              {f.buckets?.map((b: any) => `${b.label}: SR ${(b.sr || 0).toFixed(1)}`).join(" · ") || "–"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Findings */}
                {(detail.findings || generateFindings(detail)) && (
                  <div className="mb-4">
                    <div className="text-[10px] font-mono font-bold mb-2" style={{ color: "#22c55e" }}>🔑 KEY FINDINGS</div>
                    <div className="text-[10px] font-mono text-[var(--text)] leading-relaxed p-3 rounded border border-[var(--border)]"
                      style={{ whiteSpace: "pre-wrap" }}>
                      {detail.findings || generateFindings(detail)}
                    </div>
                  </div>
                )}

                {/* Recommendations */}
                {detail.recommendations && (
                  <div className="mb-4">
                    <div className="text-[10px] font-mono font-bold mb-2" style={{ color: "#eab308" }}>💡 RECOMMENDATIONS</div>
                    <div className="text-[10px] font-mono text-[var(--text)] leading-relaxed p-3 rounded border border-[var(--border)]"
                      style={{ whiteSpace: "pre-wrap" }}>
                      {detail.recommendations}
                    </div>
                  </div>
                )}

                {/* Committee decision */}
                <div className="p-3 rounded-lg border mb-3" style={{ borderColor: "#f9731630", background: "rgba(249,115,22,0.04)" }}>
                  <div className="text-[9px] font-mono font-bold mb-2" style={{ color: "#f97316" }}>🧠 COMMITTEE DECISION</div>
                  {detail.committee_decision ? (
                    <div className="text-[10px] font-mono text-[var(--text)]">{detail.committee_decision}</div>
                  ) : (
                    <div className="text-[9px] font-mono text-[var(--text-dim)] italic">No committee decision recorded yet. The next evolution round will consume this report.</div>
                  )}
                </div>

                {/* Active filters at time of report */}
                {detail.active_filters && Array.isArray(detail.active_filters) && detail.active_filters.length > 0 && (
                  <div className="mb-3">
                    <div className="text-[9px] font-mono font-bold mb-1" style={{ color: "#22c55e" }}>ACTIVE FILTERS</div>
                    <div className="flex flex-wrap gap-1">
                      {(detail.active_filters as any[]).map((f: any, i: number) => (
                        <span key={i} className="px-2 py-0.5 rounded text-[8px] font-mono"
                          style={{ color: "#22c55e", background: "#22c55e12", border: "1px solid #22c55e25" }}>
                          {f.rule} {f.oos_lift ? `(${f.oos_lift})` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
