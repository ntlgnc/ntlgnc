"use client";

import { useState, useEffect, useCallback } from "react";

/* ── All colors as Tailwind arbitrary-value classes ── */
const MEMBERS = {
  claude:  { role: "Risk Analyst",        emoji: "🛡", text: "text-[#c4a5ff]", bg: "bg-[#c4a5ff]/10", border: "border-[#c4a5ff]/20", barBg: "#c4a5ff" },
  gpt:     { role: "Pattern Hunter",      emoji: "🎯", text: "text-[#74d4a8]", bg: "bg-[#74d4a8]/10", border: "border-[#74d4a8]/20", barBg: "#74d4a8" },
  grok:    { role: "Contrarian",           emoji: "⚡", text: "text-[#ff9966]", bg: "bg-[#ff9966]/10", border: "border-[#ff9966]/20", barBg: "#ff9966" },
  gemini:  { role: "Systems Thinker",     emoji: "🏗", text: "text-[#66bbff]", bg: "bg-[#66bbff]/10", border: "border-[#66bbff]/20", barBg: "#66bbff" },
  deepseek:{ role: "Empiricist",           emoji: "📊", text: "text-[#ffcc44]", bg: "bg-[#ffcc44]/10", border: "border-[#ffcc44]/20", barBg: "#ffcc44" },
} as const;

type MemberId = keyof typeof MEMBERS;
const getMember = (id: string) => MEMBERS[id as MemberId] || MEMBERS.claude;

const GOLD_TEXT = "text-[#D4A843]";
const GOLD_BG = "bg-[#D4A843]/[0.06] border-[#D4A843]/[0.18]";
const PANEL = "border border-white/10 bg-white/[0.02]";

type BoardTab = "meetings" | "approvals" | "filters" | "overrides" | "research" | "stats" | "forecasts";

export default function LLMBoard() {
  const [tab, setTab] = useState<BoardTab>("meetings");
  const [meetings, setMeetings] = useState<any[]>([]);
  const [filters, setFilters] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<any[]>([]);
  const [research, setResearch] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [forecastData, setForecastData] = useState<any>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, fRes, oRes, rRes, sRes, aRes, fcRes] = await Promise.all([
        fetch("/api/board?action=meetings&limit=50").then(r => r.json()),
        fetch("/api/board?action=filters&active=false").then(r => r.json()),
        fetch("/api/board?action=overrides").then(r => r.json()),
        fetch("/api/board?action=research").then(r => r.json()),
        fetch("/api/board?action=stats").then(r => r.json()),
        fetch("/api/board", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pendingApprovals" }) }).then(r => r.json()).catch(() => ({ approvals: [] })),
        fetch("/api/board/forecast").then(r => r.json()).catch(() => ({ forecasts: [], leaderboard: [], trackRecord: {} })),
      ]);
      setMeetings(mRes.meetings || []);
      setFilters(fRes.filters || []);
      setOverrides(oRes.overrides || []);
      setResearch(rRes.research || []);
      setStats(sRes);
      setApprovals(aRes.approvals || []);
      setForecastData(fcRes);
    } catch (e) { console.error("Board fetch error:", e); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const loadMeetingDetail = async (id: number) => {
    try {
      const res = await fetch(`/api/board?action=meeting&id=${id}`);
      const data = await res.json();
      setSelectedMeeting(data.meeting);
    } catch {}
  };

  const toggleFilter = async (id: number, active: boolean) => {
    await fetch("/api/board", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggleFilter", id, active }),
    });
    fetchData();
  };

  const tabs: { id: BoardTab; label: string; count?: number; alert?: boolean }[] = [
    { id: "meetings", label: "🏛 Meetings", count: meetings.length },
    { id: "approvals", label: "⚠ Approvals", count: approvals.length, alert: approvals.length > 0 },
    { id: "filters", label: "🔬 Filters", count: filters.filter(f => f.active).length },
    { id: "overrides", label: "🪙 Overrides", count: overrides.length },
    { id: "research", label: "🧪 Research", count: research.length },
    { id: "stats", label: "📈 Stats" },
    { id: "forecasts", label: "🔮 Forecasts" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className={`text-sm font-mono font-bold ${GOLD_TEXT}`}>🏛 LLM STRATEGY BOARD</span>
        <span className="text-[11px] font-mono text-gray-300">
          v1 · {stats?.meetingStats?.total_meetings || 0} meetings · {stats?.filterStats?.active_filters || 0} active filters
        </span>
        <div className="flex-1" />
        <button onClick={fetchData} disabled={loading}
          className={`px-2 py-1 rounded text-[10px] font-mono border ${GOLD_TEXT} ${GOLD_BG}`}>
          {loading ? "⏳" : "↻"} Refresh
        </button>
      </div>

      {/* Board Members */}
      <div className="flex gap-2 flex-wrap">
        {(Object.entries(MEMBERS) as [MemberId, typeof MEMBERS[MemberId]][]).map(([id, m]) => (
          <div key={id} className={`px-2 py-1 rounded text-[10px] font-mono flex items-center gap-1 border ${m.text} ${m.bg} ${m.border}`}>
            {m.emoji} {id.toUpperCase()} — {m.role}
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 rounded overflow-hidden border border-[#D4A843]/15">
        {tabs.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedMeeting(null); }}
            className={`px-3 py-1.5 text-[11px] font-mono transition-all ${
              tab === t.id ? `${GOLD_TEXT} bg-[#D4A843]/10` : 
              t.alert ? "text-red-400 bg-red-500/5 animate-pulse" : "text-gray-300 hover:text-gray-100"
            }`}>
            {t.label}{t.count !== undefined ? ` (${t.count})` : ""}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "meetings" && !selectedMeeting && <MeetingsList meetings={meetings} onSelect={loadMeetingDetail} />}
      {tab === "meetings" && selectedMeeting && <MeetingLog meeting={selectedMeeting} onBack={() => setSelectedMeeting(null)} onRefresh={fetchData} />}
      {tab === "approvals" && <ApprovalQueue approvals={approvals} onRefresh={fetchData} />}
      {tab === "filters" && <FiltersList filters={filters} onToggle={toggleFilter} onRefresh={fetchData} />}
      {tab === "overrides" && <OverridesList overrides={overrides} onRefresh={fetchData} />}
      {tab === "research" && <ResearchList research={research} />}
      {tab === "stats" && stats && <BoardStats stats={stats} meetings={meetings} />}
      {tab === "forecasts" && <ForecastLeaderboard data={forecastData} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MEETINGS LIST
   ═══════════════════════════════════════════════════════════════ */

function MeetingsList({ meetings, onSelect }: { meetings: any[]; onSelect: (id: number) => void }) {
  if (meetings.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 font-mono text-sm">
        No board meetings yet.<br />
        <code className="text-xs mt-2 inline-block px-3 py-1 rounded bg-black/40 text-gray-300">node backend/llm-board.js</code>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {meetings.map(m => {
        const passed = m.decision?.includes("PASSED");
        const votes = m.votes ? JSON.parse(typeof m.votes === "string" ? m.votes : JSON.stringify(m.votes)) : {};
        const supportCount = Object.values(votes).filter((v: any) => v.support).length;
        const totalVotes = Object.values(votes).length;
        const mem = getMember(m.chair_id);

        return (
          <button key={m.id} onClick={() => onSelect(m.id)}
            className="w-full text-left px-3 py-2 rounded transition-all hover:bg-white/5 border border-white/10">
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-mono font-bold ${mem.text}`}>
                {mem.emoji} #{m.round_number}
              </span>
              <span className={`text-[10px] font-mono ${passed ? "text-green-400" : "text-red-400"}`}>
                {passed ? "✅" : "❌"} {m.decision?.slice(0, 80)}
              </span>
              <div className="flex-1" />
              {m.deployed && <span className="text-[9px] font-mono px-1 rounded bg-green-500/10 text-green-400">DEPLOYED</span>}
              <span className="text-[9px] font-mono text-gray-400">
                {supportCount}/{totalVotes} · {m.total_tokens}tok · {((m.duration_ms || 0) / 1000).toFixed(0)}s
              </span>
              <span className="text-[9px] font-mono text-gray-400">
                {new Date(m.created_at).toLocaleDateString()} {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   MEETING LOG — The main event. Log-style chronological view.
   Handles both v1 (chair→debate→vote) and v2 (8-phase) data.
   ═══════════════════════════════════════════════════════════════ */

function MeetingLog({ meeting, onBack, onRefresh }: { meeting: any; onBack: () => void; onRefresh: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const proposals = typeof meeting.proposals === "string" ? JSON.parse(meeting.proposals) : meeting.proposals;
  const debate = typeof meeting.debate === "string" ? JSON.parse(meeting.debate) : meeting.debate;
  const votes = typeof meeting.votes === "string" ? JSON.parse(meeting.votes) : meeting.votes;
  const impact = typeof meeting.impact_review === "string" ? JSON.parse(meeting.impact_review) : meeting.impact_review;
  const passed = meeting.decision?.includes("PASSED");
  const chairMem = getMember(meeting.chair_id);

  // v2 fields
  const situation = proposals?.situation;
  const problems = proposals?.problems;
  const prioritised = proposals?.prioritised;
  const solutions = proposals?.solutions || debate; // v2 uses debate field for solutions
  const synthesis = proposals?.synthesis;
  const followUp = proposals?.follow_up || (meeting.follow_up_target ? { follow_up_target: meeting.follow_up_target } : null);

  // ── Deep JSON extraction for v1 ──
  // v1 stores the whole chair response as proposals — could be the parsed object or a JSON string
  let briefingText = "";
  let keyIssue = "";
  let motionTitle = "";
  let hypothesis = "";
  let motionDetails: any = null;

  // Helper: try to deeply extract from a potentially nested/stringified object
  const deepExtract = (obj: any) => {
    if (!obj) return;
    let data = obj;
    // If it's a string that looks like JSON, parse it
    if (typeof data === "string") {
      try {
        data = JSON.parse(data.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
      } catch { return; } // not JSON, leave as-is
    }
    if (typeof data !== "object") return;
    
    // Extract fields, but if briefing is itself a JSON string, recurse into it
    if (data.briefing) {
      if (typeof data.briefing === "string" && data.briefing.trim().startsWith("{")) {
        // Briefing is a stringified JSON — recurse
        deepExtract(data.briefing);
      } else if (!briefingText) {
        briefingText = data.briefing;
      }
    }
    if (!briefingText && data.situation_summary) briefingText = data.situation_summary;
    if (!keyIssue && data.key_issue) keyIssue = data.key_issue;
    if (!motionTitle && data.motion?.title) motionTitle = data.motion.title;
    if (!motionTitle && data.motion?.type) motionTitle = data.motion.type;
    if (!hypothesis && data.motion?.hypothesis) hypothesis = data.motion.hypothesis;
    if (!motionDetails && data.motion?.details) motionDetails = data.motion.details;
  };

  // Try v2 structure first
  if (situation?.situation_summary) briefingText = situation.situation_summary;
  if (prioritised?.selected_problem) keyIssue = prioritised.selected_problem;
  if (synthesis?.motion?.title) motionTitle = synthesis.motion.title;
  if (synthesis?.motion?.hypothesis) hypothesis = synthesis.motion.hypothesis;
  if (synthesis?.motion?.details) motionDetails = synthesis.motion.details;

  // Fallback: extract from proposals directly (v1)
  if (!briefingText) deepExtract(proposals);

  // Clean up
  briefingText = (briefingText || "").replace(/\\n/g, "\n").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  keyIssue = (keyIssue || "").trim();

  // Save editable field
  const saveField = async (field: string, value: string) => {
    setSaving(true);
    try {
      await fetch("/api/board", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "updateMeeting", id: meeting.id, field, value }),
      });
      setEditing(null);
      onRefresh();
    } catch (e) { console.error("Save error:", e); }
    setSaving(false);
  };

  // Editable field component
  const EditableField = ({ field, label, value, multiline = false }: { field: string; label: string; value: string; multiline?: boolean }) => (
    <div className="group relative">
      {editing === field ? (
        <div className="space-y-1">
          {multiline ? (
            <textarea value={editValue} onChange={e => setEditValue(e.target.value)} rows={4}
              className="w-full p-2 rounded text-[11px] font-mono bg-black/40 border border-[#D4A843]/30 text-white resize-y" />
          ) : (
            <input value={editValue} onChange={e => setEditValue(e.target.value)}
              className="w-full p-2 rounded text-[11px] font-mono bg-black/40 border border-[#D4A843]/30 text-white" />
          )}
          <div className="flex gap-1">
            <button onClick={() => saveField(field, editValue)} disabled={saving}
              className="px-2 py-0.5 rounded text-[9px] font-mono bg-green-500/20 text-green-400 border border-green-500/30">
              {saving ? "⏳" : "✓"} Save
            </button>
            <button onClick={() => setEditing(null)}
              className="px-2 py-0.5 rounded text-[9px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">✕ Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-1">
          <span className="flex-1">{value || <span className="text-gray-600 italic">empty</span>}</span>
          <button onClick={() => { setEditing(field); setEditValue(value || ""); }}
            className="opacity-0 group-hover:opacity-100 transition-opacity px-1 py-0.5 rounded text-[8px] font-mono text-gray-500 hover:text-[#D4A843] hover:bg-[#D4A843]/10">
            ✎ edit
          </button>
        </div>
      )}
    </div>
  );

  // Log entry component — collapsible, with preview line
  const LogEntry = ({ id, icon, label, color, preview, children, defaultOpen = false }: { 
    id: string; icon: string; label: string; color: string; preview?: string; children: React.ReactNode; defaultOpen?: boolean 
  }) => {
    const isOpen = expanded[id] ?? defaultOpen;
    return (
      <div className="flex gap-3 pb-4 relative">
        {/* Timeline connector */}
        <div className="flex flex-col items-center">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] ${color} shrink-0`}>
            {icon}
          </div>
          <div className="w-px flex-1 bg-white/10 mt-1" />
        </div>
        {/* Content */}
        <div className="flex-1 min-w-0 pb-2">
          <button onClick={() => toggle(id)} className="flex items-center gap-2 mb-1 group w-full text-left">
            <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${color}`}>{label}</span>
            <span className="text-[8px] font-mono text-gray-600 group-hover:text-gray-400 transition-colors">
              {isOpen ? "▼" : "▶"}
            </span>
          </button>
          {!isOpen && preview && (
            <button onClick={() => toggle(id)} className="text-[10px] font-mono text-gray-500 hover:text-gray-300 transition-colors text-left">
              {preview.slice(0, 150)}{preview.length > 150 ? "…" : ""} <span className="text-gray-600 ml-1">show more</span>
            </button>
          )}
          {isOpen && (
            <div className="text-[11px] font-mono text-gray-300 leading-relaxed">{children}</div>
          )}
        </div>
      </div>
    );
  };

  // Parse debate entries — handle both v1 and v2 formats
  const getDebateEntries = () => {
    if (!debate || !Array.isArray(debate)) return [];
    return debate.map((d: any) => {
      const resp = d.response || d;
      let assessment = resp.assessment || resp.solution || d.raw || "";
      try {
        if (typeof assessment === "string" && assessment.trim().startsWith("{")) {
          const p = JSON.parse(assessment.replace(/```json\n?/g, "").replace(/```\n?/g, ""));
          assessment = p.assessment || p.solution || assessment;
        }
      } catch {}
      return { ...d, assessment, resp };
    });
  };

  return (
    <div className="space-y-2">
      <button onClick={onBack} className="text-[10px] font-mono text-gray-400 hover:text-white transition-colors">← Back to meetings</button>

      {/* Meeting header */}
      <div className={`p-4 rounded-lg border ${GOLD_BG}`}>
        <div className="flex items-center gap-3 mb-1">
          <span className={`text-lg font-mono font-bold ${GOLD_TEXT}`}>Board Meeting #{meeting.round_number}</span>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${passed ? "bg-green-500/15 text-green-400" : meeting.decision?.includes("FAILED") && meeting.decision?.includes("PASSED") ? "bg-yellow-500/15 text-yellow-400" : "bg-red-500/15 text-red-400"}`}>
            {passed && !meeting.decision?.includes("FAILED") ? "✅ PASSED" : meeting.decision?.includes("PASSED") && meeting.decision?.includes("FAILED") ? "⚠ MIXED" : "❌ FAILED"}{meeting.deployed ? " · DEPLOYED" : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-gray-400">
          <span className={chairMem.text}>{chairMem.emoji} {meeting.chair_id?.toUpperCase()} chairing</span>
          <span>{new Date(meeting.created_at).toLocaleString()}</span>
          <span>{((meeting.duration_ms || 0) / 1000).toFixed(1)}s</span>
          <span>{meeting.total_tokens} tokens</span>
        </div>
      </div>

      {/* ── THE LOG ── */}
      <div className="pl-1 pt-2">

        {/* Phase 1: Situation / Briefing */}
        <LogEntry id="p1" icon="📊" label="Phase 1 — Situational Awareness" color={GOLD_TEXT} preview={briefingText}>
          <EditableField field="briefing" label="Briefing" value={briefingText} multiline />
          {situation?.key_changes && (
            <div className="mt-2">
              <span className="text-gray-500 text-[9px]">KEY CHANGES:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {situation.key_changes.map((c: string, i: number) => (
                  <span key={i} className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-white/5 text-gray-300">{c}</span>
                ))}
              </div>
            </div>
          )}
          {situation?.concerning_patterns?.length > 0 && (
            <div className="mt-2">
              <span className="text-red-400/60 text-[9px]">⚠ CONCERNS:</span>
              {situation.concerning_patterns.map((p: string, i: number) => (
                <div key={i} className="text-[10px] text-red-400/80 ml-2">• {p}</div>
              ))}
            </div>
          )}
        </LogEntry>

        {/* Phase 2: Problems (v2) or Key Issue (v1) */}
        {problems && problems.length > 0 ? (
          <LogEntry id="p2" icon="🔍" label="Phase 2 — Problem Identification" color="text-orange-400" defaultOpen>
            <div className="space-y-1.5">
              {problems.map((p: any, i: number) => {
                const mem = p.identified_by ? getMember(p.identified_by) : null;
                return (
                  <div key={i} className="flex items-start gap-2">
                    {mem && <span className={`text-[9px] font-mono ${mem.text}`}>{mem.emoji}</span>}
                    <div>
                      <span className={`text-[10px] font-mono font-bold ${
                        p.severity === "HIGH" ? "text-red-400" : p.severity === "MEDIUM" ? "text-yellow-400" : "text-gray-400"
                      }`}>[{p.severity}]</span>
                      <span className="ml-1">{p.title}</span>
                      {p.evidence && <div className="text-[9px] text-gray-500 mt-0.5">{p.evidence}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </LogEntry>
        ) : keyIssue && (
          <LogEntry id="issue" icon="⚠" label="Key Issue" color="text-yellow-400" defaultOpen>
            <EditableField field="key_issue" label="Key Issue" value={keyIssue} />
          </LogEntry>
        )}

        {/* Phase 3: Prioritised problem (v2) */}
        {prioritised && (
          <LogEntry id="p3" icon="🎯" label="Phase 3 — Prioritised Problem" color="text-red-400" defaultOpen>
            <div className="font-bold text-white">{prioritised.selected_problem}</div>
            {prioritised.rationale && <div className="text-[10px] text-gray-400 mt-1">{prioritised.rationale}</div>}
            {prioritised.deferred?.length > 0 && (
              <div className="text-[9px] text-gray-600 mt-1">Deferred: {prioritised.deferred.join(", ")}</div>
            )}
          </LogEntry>
        )}

        {/* Phase 4: Solutions / Debate */}
        <LogEntry id="p4" icon="💬" label={problems ? "Phase 4 — Solutions & Debate" : "Debate"} color="text-blue-400" preview={getDebateEntries()[0]?.assessment}>
          <div className="space-y-2">
            {getDebateEntries().map((d: any, i: number) => {
              const mem = getMember(d.member_id);
              return (
                <div key={i} className={`p-2.5 rounded border-l-[3px] ${mem.bg} ${mem.border}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-mono font-bold ${mem.text}`}>
                      {mem.emoji} {d.member_name || d.member_id?.toUpperCase()} <span className="font-normal text-gray-500">({d.role || getMember(d.member_id).role})</span>
                    </span>
                    {d.resp?.support !== undefined && (
                      <span className={`text-[9px] font-mono ${d.resp.support ? "text-green-400" : "text-red-400"}`}>
                        {d.resp.support ? "✅" : "❌"}
                      </span>
                    )}
                    {(d.ms || d.tokens) && <span className="text-[8px] font-mono text-gray-600">{d.ms}ms · {d.tokens}tok</span>}
                  </div>
                  <div className="text-gray-300">{d.assessment}</div>
                  {d.resp?.hypothesis && <div className="text-[10px] text-gray-400 mt-1">💡 {d.resp.hypothesis}</div>}
                  {d.resp?.conditions && <div className={`text-[10px] text-gray-400 mt-1`}><span className={`${GOLD_TEXT} font-bold`}>Conditions:</span> {d.resp.conditions}</div>}
                  {d.resp?.concern && <div className="text-[10px] text-gray-400 mt-1"><span className="text-red-400 font-bold">Concern:</span> {d.resp.concern}</div>}
                  {d.resp?.insight && <div className="text-[10px] text-gray-400 mt-1"><span className="text-green-400 font-bold">Insight:</span> {d.resp.insight}</div>}
                  {d.resp?.counter_proposal && <div className="text-[10px] text-gray-400 mt-1"><span className="text-blue-400 font-bold">Counter:</span> {d.resp.counter_proposal}</div>}
                  {d.resp?.success_metric && <div className="text-[10px] text-gray-400 mt-1"><span className="text-purple-400 font-bold">Metric:</span> {d.resp.success_metric}</div>}
                </div>
              );
            })}
          </div>
        </LogEntry>

        {/* Motion (synthesised from solutions in v2, or from chair in v1) */}
        {motionTitle && (
          <LogEntry id="motion" icon="📜" label="Motion" color={GOLD_TEXT} defaultOpen>
            <div className={`p-3 rounded border ${GOLD_BG}`}>
              <div className={`font-bold text-white text-[12px]`}>{motionTitle}</div>
              {hypothesis && <p className="text-gray-300 mt-1">{hypothesis}</p>}
              {synthesis?.rationale && <p className="text-gray-400 mt-1 text-[10px]">{synthesis.rationale}</p>}
              {motionDetails && (
                <pre className="text-[9px] font-mono text-gray-500 mt-2 overflow-auto max-h-24 bg-black/20 rounded p-2">
                  {JSON.stringify(motionDetails, null, 2)}
                </pre>
              )}
            </div>
          </LogEntry>
        )}

        {/* Phase 5: Votes */}
        {votes && (
          <LogEntry id="p5" icon="🗳" label={problems ? "Phase 5 — Vote" : "Vote"} color="text-purple-400" defaultOpen>
            <div className="space-y-1">
              {Object.entries(votes).map(([id, v]: [string, any]) => {
                const mem = getMember(id);
                return (
                  <div key={id} className="flex items-start gap-2">
                    <span className={`text-[10px] font-mono font-bold w-24 ${mem.text}`}>
                      {mem.emoji} {id.toUpperCase()}
                    </span>
                    <span className={`text-[10px] font-mono w-6 ${v.support ? "text-green-400" : "text-red-400"}`}>
                      {v.support ? "✅" : "❌"}
                    </span>
                    <span className="text-[10px] text-gray-400 flex-1">
                      {v.reasoning || v.conditions || ""}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={`mt-2 text-[11px] font-mono font-bold ${passed ? "text-green-400" : "text-red-400"}`}>
              Result: {meeting.decision}
            </div>
          </LogEntry>
        )}

        {/* Phase 7: Follow-up target */}
        {(followUp?.follow_up_target || meeting.follow_up_target) && (
          <LogEntry id="p7" icon="🎯" label="Phase 7 — Follow-up Target" color="text-cyan-400" defaultOpen>
            <EditableField field="follow_up_target" label="Follow-up" value={followUp?.follow_up_target || meeting.follow_up_target || ""} multiline />
            {followUp?.how_to_measure && <div className="text-[9px] text-gray-500 mt-1">📐 {followUp.how_to_measure}</div>}
          </LogEntry>
        )}

        {/* Impact review (if present) */}
        {impact && (
          <LogEntry id="p8" icon="📊" label="Phase 8 — Impact Review" defaultOpen color={
            impact.verdict === "POSITIVE" ? "text-green-400" : impact.verdict === "NEGATIVE" ? "text-red-400" : "text-yellow-400"
          }>
            <div className={`font-bold ${
              impact.verdict === "POSITIVE" ? "text-green-400" : impact.verdict === "NEGATIVE" ? "text-red-400" : "text-yellow-400"
            }`}>
              Verdict: {impact.verdict}
            </div>
            {impact.evidence && <p className="text-gray-300 mt-1">{impact.evidence}</p>}
            {impact.recommendation && <p className="text-gray-400 mt-1">Recommendation: {impact.recommendation}</p>}
          </LogEntry>
        )}

        {/* End marker */}
        <div className="flex gap-3">
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] text-gray-600 bg-white/5">✓</div>
          <span className="text-[9px] font-mono text-gray-600 pt-1">
            Meeting #{meeting.round_number} concluded · {((meeting.duration_ms || 0) / 1000).toFixed(1)}s · {meeting.total_tokens} tokens
          </span>
        </div>
      </div>

      {/* Raw JSON toggle */}
      <RawDataToggle data={meeting} />
    </div>
  );
}

/* ── Raw JSON viewer ── */
function RawDataToggle({ data }: { data: any }) {
  const [show, setShow] = useState(false);
  return (
    <div className="mt-4">
      <button onClick={() => setShow(!show)} className="text-[9px] font-mono text-gray-600 hover:text-gray-400">
        {show ? "▼ Hide" : "▶ Show"} raw data
      </button>
      {show && (
        <pre className="mt-1 p-3 rounded text-[8px] font-mono text-gray-500 bg-black/30 overflow-auto max-h-64">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   FILTERS LIST (unchanged from clean version)
   ═══════════════════════════════════════════════════════════════ */

function FiltersList({ filters, onToggle, onRefresh }: { filters: any[]; onToggle: (id: number, active: boolean) => void; onRefresh: () => void }) {
  const active = filters.filter(f => f.active);
  const inactive = filters.filter(f => !f.active);
  const [measuringId, setMeasuringId] = useState<number | null>(null);

  const measureImpact = async (id: number) => {
    setMeasuringId(id);
    try {
      await fetch("/api/board", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "measureImpact", id }),
      });
      onRefresh();
    } catch {}
    setMeasuringId(null);
  };

  return (
    <div className="space-y-4">
      <div className="text-[10px] font-mono text-gray-300">{active.length} active · {inactive.length} inactive</div>
      {filters.length === 0 && (
        <div className="text-center py-8 text-gray-400 font-mono text-sm">No filters yet.</div>
      )}
      {filters.map(f => {
        const impact = f.impact_data ? (typeof f.impact_data === "string" ? JSON.parse(f.impact_data) : f.impact_data) : null;
        const verdictColor = impact?.verdict === "POSITIVE" ? "text-green-400" : impact?.verdict === "NEGATIVE" ? "text-red-400" : "text-yellow-400";
        const verdictBg = impact?.verdict === "POSITIVE" ? "bg-green-500/10 border-green-500/20" : impact?.verdict === "NEGATIVE" ? "bg-red-500/10 border-red-500/20" : "bg-yellow-500/10 border-yellow-500/20";
        
        return (
          <div key={f.id} className={`p-3 rounded-lg border ${f.active ? "border-green-500/20 bg-green-500/[0.03]" : "border-white/10 bg-white/[0.01] opacity-60"}`}>
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-mono font-bold ${f.active ? "text-green-400" : "text-gray-300"}`}>
                {f.active ? "✅" : "⏸"} {f.feature}
              </span>
              <span className="text-[9px] font-mono px-1.5 py-px rounded" style={{
                background: (f.timeframe || 'all') === '1m' ? 'rgba(59,130,246,0.1)' :
                            (f.timeframe || 'all') === '1h' ? 'rgba(167,139,250,0.1)' :
                            (f.timeframe || 'all') === '1d' ? 'rgba(212,168,67,0.1)' : 'rgba(255,255,255,0.05)',
                color: (f.timeframe || 'all') === '1m' ? '#3b82f6' :
                       (f.timeframe || 'all') === '1h' ? '#a78bfa' :
                       (f.timeframe || 'all') === '1d' ? '#D4A843' : 'rgba(255,255,255,0.5)',
              }}>
                {(f.timeframe || 'all').toUpperCase()} signals
              </span>
              <span className="text-[9px] font-mono text-gray-400">{f.filter_type} · #{f.id}</span>
              <div className="flex-1" />
              <span className="text-[9px] font-mono text-gray-400">{f.trades_passed || 0} passed · {f.trades_filtered || 0} filtered</span>
              <button onClick={() => measureImpact(f.id)} disabled={measuringId === f.id}
                className="text-[9px] font-mono px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                {measuringId === f.id ? "⏳" : "📊"} Measure
              </button>
              <button onClick={() => onToggle(f.id, !f.active)}
                className={`text-[9px] font-mono px-2 py-0.5 rounded ${f.active ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>
                {f.active ? "Disable" : "Enable"}
              </button>
            </div>
            {f.rationale && <p className="text-[10px] font-mono text-gray-300 mt-1">{f.rationale}</p>}
            
            {/* Impact measurement display */}
            {impact ? (
              <div className={`mt-2 p-2.5 rounded border ${verdictBg}`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`text-[10px] font-mono font-bold ${verdictColor}`}>
                    {impact.verdict === "POSITIVE" ? "✅" : impact.verdict === "NEGATIVE" ? "❌" : "⚪"} {impact.verdict}
                  </span>
                  <span className="text-[8px] font-mono text-gray-500">
                    measured {impact.period_hours}h after deployment · {impact.summary?.total_signals || 0} total signals
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[8px] font-mono text-gray-500 mb-0.5">PASSED (traded)</div>
                    <div className="text-[10px] font-mono text-gray-300">
                      {impact.passed?.count || 0} trades · avg {(impact.passed?.avgReturn || 0).toFixed(3)}% · WR {(impact.passed?.winRate || 0).toFixed(0)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-[8px] font-mono text-gray-500 mb-0.5">BLOCKED (counterfactual)</div>
                    <div className="text-[10px] font-mono text-gray-300">
                      {impact.blocked?.count || 0} trades · avg {(impact.blocked?.avgReturn || 0).toFixed(3)}% · WR {(impact.blocked?.winRate || 0).toFixed(0)}%
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-1.5 pt-1.5 border-t border-white/5">
                  <span className={`text-[10px] font-mono font-bold ${(impact.improvement?.avg_return_delta || 0) > 0 ? "text-green-400" : "text-red-400"}`}>
                    Δ {(impact.improvement?.avg_return_delta || 0) > 0 ? "+" : ""}{(impact.improvement?.avg_return_delta || 0).toFixed(4)}%/trade
                  </span>
                  <span className={`text-[10px] font-mono ${(impact.improvement?.saved_cumulative_return || 0) > 0 ? "text-green-400" : "text-red-400"}`}>
                    Net saved: {(impact.improvement?.saved_cumulative_return || 0) > 0 ? "+" : ""}{(impact.improvement?.saved_cumulative_return || 0).toFixed(2)}%
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-2 text-[9px] font-mono text-gray-600 italic">
                ⏳ No impact measurement yet — click 📊 Measure to evaluate
              </div>
            )}
            
            <div className="text-[9px] font-mono text-gray-500 mt-1">
              Proposed by {f.proposed_by || "unknown"} · {new Date(f.created_at).toLocaleDateString()}
              {f.meeting_id && ` · Meeting #${f.meeting_id}`}
              {f.impact_measured_at && ` · Last measured ${new Date(f.impact_measured_at).toLocaleString()}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */

function OverridesList({ overrides, onRefresh }: { overrides: any[]; onRefresh: () => void }) {
  const excludes = overrides.filter(o => o.override_type === "exclude");
  const params = overrides.filter(o => o.override_type === "parameters");

  return (
    <div className="space-y-4">
      {overrides.length === 0 && <div className="text-center py-8 text-gray-400 font-mono text-sm">No coin overrides yet.</div>}
      {excludes.length > 0 && (
        <div>
          <div className="text-[10px] font-mono font-bold text-gray-300 mb-2">🚫 EXCLUDED COINS</div>
          <div className="flex gap-2 flex-wrap">
            {excludes.map(o => (
              <span key={o.id} className="px-2 py-1 rounded text-[10px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">
                {o.symbol} <span className="text-gray-400">({o.rationale?.slice(0, 40)})</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {params.length > 0 && (
        <div>
          <div className="text-[10px] font-mono font-bold text-gray-300 mb-2">⚙ PARAMETER OVERRIDES</div>
          {params.map(o => (
            <div key={o.id} className={`p-2 rounded mb-1 ${PANEL}`}>
              <span className={`text-[11px] font-mono font-bold ${GOLD_TEXT}`}>{o.symbol}</span>
              <pre className="text-[9px] font-mono text-gray-400 mt-1">
                {JSON.stringify(typeof o.parameters === "string" ? JSON.parse(o.parameters) : o.parameters, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */

function ResearchList({ research }: { research: any[] }) {
  return (
    <div className="space-y-2">
      {research.length === 0 && <div className="text-center py-8 text-gray-400 font-mono text-sm">No research entries yet.</div>}
      {research.map(r => (
        <div key={r.id} className={`p-3 rounded-lg border ${r.status === "killed" ? "border-red-500/20 bg-red-500/[0.03]" : PANEL}`}>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-mono font-bold ${r.status === "killed" ? "text-red-400" : "text-green-400"}`}>
              {r.status === "killed" ? "💀" : "🧪"} {r.research_type}
            </span>
            <span className="text-[9px] font-mono text-gray-400">{new Date(r.created_at).toLocaleDateString()}</span>
          </div>
          {r.hypothesis && <p className="text-[10px] font-mono text-gray-300 mt-1">{r.hypothesis}</p>}
          {r.conclusion && <p className="text-[10px] font-mono text-gray-300 mt-1">{r.conclusion}</p>}
          {r.killed_by && <p className="text-[9px] font-mono text-red-400 mt-1">Killed by {r.killed_by}: {r.killed_reason}</p>}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════════════════════════════
// FORECAST LEADERBOARD (Admin only)
// ═══════════════════════════════════════════════════════════════

function ForecastLeaderboard({ data }: { data: any }) {
  if (!data) return <div className="text-gray-500 text-[11px] font-mono">Loading forecast data...</div>;

  const leaderboard = data.leaderboard || [];
  const forecasts = (data.forecasts || []).filter((f: any) => f.reviewed_at);
  const trackRecord = data.trackRecord || {};
  const baseRate = data.baseRate ?? 50;

  const memberIds = ["claude", "gpt", "grok", "gemini", "deepseek"];

  // Build per-LLM error history from scored forecasts (oldest first) — for charts
  const errorHistory: Record<string, { round: number; error: number; cumError: number; correct: boolean }[]> = {};
  for (const id of memberIds) errorHistory[id] = [];

  const sortedForecasts = [...forecasts].reverse();
  for (const f of sortedForecasts) {
    const scores = typeof f.individual_scores === "string" ? JSON.parse(f.individual_scores) : f.individual_scores;
    if (!scores) continue;
    for (const id of memberIds) {
      if (scores[id]) {
        const errPct = scores[id].price_error_pct ?? scores[id].price_error ?? null;
        if (errPct !== null) {
          const err = typeof errPct === "number" ? errPct : 0;
          if (err > 10) continue;
          const prev = errorHistory[id].length > 0 ? errorHistory[id][errorHistory[id].length - 1].cumError : 0;
          errorHistory[id].push({ round: f.round_number, error: err, cumError: prev + err, correct: !!scores[id].direction_correct });
        }
      }
    }
  }

  const maxCumError = Math.max(...Object.values(errorHistory).flat().map(e => e.cumError), 1);

  // Sort leaderboard by win rate (direction accuracy is the primary metric)
  const sortedLeaderboard = [...leaderboard].sort((a: any, b: any) => {
    const accA = a.total_forecasts > 0 ? a.correct_direction / a.total_forecasts : 0;
    const accB = b.total_forecasts > 0 ? b.correct_direction / b.total_forecasts : 0;
    return accB - accA;
  });

  // Significance stars helper
  const sigStars = (p: number) => p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "";
  const sigColor = (p: number) => p < 0.05 ? "text-green-400" : p < 0.10 ? "text-yellow-400" : "text-gray-500";

  return (
    <div className="space-y-4">
      {/* ── PAGE OVERVIEW ── */}
      <div className={`rounded-lg p-3 ${PANEL}`}>
        <div className="text-[10px] font-mono text-gray-300 leading-relaxed">
          <span className="text-white/80 font-bold">BTC Hourly Forecast Dashboard.</span>{" "}
          Every hour, five LLMs (Claude, GPT, Grok, Gemini, DeepSeek) independently analyse BTC price action, then debate and vote on the next hour&apos;s direction (UP or DOWN).
          After the hour passes, each prediction is scored against the actual BTC move. All metrics below use the <span className="text-white/60 font-bold">entire scored history</span> (no rolling window) unless stated otherwise.
        </div>
      </div>

      {/* ── SUMMARY CARDS ── */}
      <div>
        <div className="text-[9px] font-mono text-gray-500 mb-1.5">
          Headline accuracy over all {trackRecord.total || 0} scored rounds. Base Rate = how often BTC actually went UP in the sample (a naive &quot;always predict UP&quot; strategy would achieve this accuracy).
        </div>
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: "Consensus Accuracy", value: `${trackRecord.accuracy || 0}%`, cls: "text-green-400" },
            { label: "Group Vote Accuracy", value: `${trackRecord.group_vote_accuracy || 0}%`, cls: "text-blue-400" },
            { label: "Total Rounds", value: trackRecord.total || 0, cls: GOLD_TEXT },
            { label: "Correct", value: trackRecord.correct || 0, cls: "text-green-400" },
            { label: "Base Rate (BTC UP%)", value: `${baseRate}%`, cls: "text-gray-300" },
          ].map(s => (
            <div key={s.label} className={`p-3 rounded-lg text-center ${PANEL}`}>
              <div className={`text-lg font-mono font-bold ${s.cls}`}>{s.value}</div>
              <div className="text-[9px] font-mono text-gray-300">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className={`text-[11px] font-mono font-bold ${GOLD_TEXT} mb-2`}>🏆 BTC FORECAST LEAGUE TABLE</div>
        <div className="text-[9px] font-mono text-gray-500 mb-2 leading-relaxed">
          Per-LLM performance ranked by direction accuracy. <span className="text-white/60">Win Rate</span> = correct direction calls / total forecasts (entire history).{" "}
          <span className="text-white/60">p-value</span> = one-sided binomial test: probability of achieving this many correct calls (or more) by pure chance assuming a fair 50/50 coin flip. A p-value below 0.05 means the accuracy is statistically significant (unlikely due to luck).{" "}
          <span className="text-white/60">Edge</span> = Win Rate minus Base Rate ({baseRate}%). If BTC went UP {baseRate}% of the time, a naive &quot;always UP&quot; bot scores {baseRate}%. Edge measures how much better the LLM is than that naive strategy. Positive Edge = genuine predictive skill.{" "}
          <span className="text-white/60">Avg Err</span> = mean absolute error between predicted price target and actual price (%).{" "}
          <span className="text-white/60">Grp Vote%</span> = accuracy of each LLM&apos;s recommendation for the group consensus call (not their individual bet).
        </div>
        <div className={`rounded-lg overflow-hidden border ${GOLD_BG}`}>
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-center px-2 py-2 text-gray-400 w-8">#</th>
                <th className="text-left px-2 py-2 text-gray-400">LLM</th>
                <th className="text-center px-2 py-2 text-gray-400">Win Rate</th>
                <th className="text-center px-2 py-2 text-gray-400">p-value</th>
                <th className="text-center px-2 py-2 text-gray-400">Edge</th>
                <th className="text-center px-2 py-2 text-gray-400">Avg Err</th>
                <th className="text-center px-2 py-2 text-gray-400">Grp Vote%</th>
                <th className="text-center px-2 py-2 text-gray-400 w-10">n</th>
              </tr>
            </thead>
            <tbody>
              {sortedLeaderboard.map((lb: any, i: number) => {
                const mem = getMember(lb.member_id);
                const n = lb.total_forecasts || 0;
                const accuracy = n > 0 ? (lb.correct_direction / n * 100) : 0;
                const pVal = lb.p_value ?? 1;
                const excess = lb.excess ?? 0;
                const avgErr = lb.avg_error ? parseFloat(lb.avg_error) : 0;
                const isChair = i === 0 && n >= 3;
                const stars = sigStars(pVal);
                return (
                  <tr key={lb.member_id} className={`border-b border-white/5 ${isChair ? "bg-[#D4A843]/5" : ""}`}>
                    <td className="text-center px-2 py-2 text-gray-500">{i === 0 ? "👑" : i + 1}</td>
                    <td className={`px-2 py-2 ${mem.text}`}>
                      {mem.emoji} {lb.member_id.toUpperCase()}
                      {isChair && <span className="text-[8px] text-[#D4A843] ml-1">CHAIR</span>}
                    </td>
                    <td className={`text-center px-2 py-2 ${accuracy >= 60 ? "text-green-400" : accuracy >= 50 ? "text-gray-300" : "text-red-400"}`}>
                      {accuracy.toFixed(1)}%
                    </td>
                    <td className={`text-center px-2 py-2 ${sigColor(pVal)}`}>
                      {pVal < 0.001 ? "<0.001" : pVal.toFixed(3)}{stars && <span className="text-yellow-300 ml-0.5">{stars}</span>}
                    </td>
                    <td className={`text-center px-2 py-2 ${excess > 0 ? "text-green-400" : excess < 0 ? "text-red-400" : "text-gray-400"}`}>
                      {excess > 0 ? "+" : ""}{excess.toFixed(1)}%
                    </td>
                    <td className="text-center px-2 py-2 text-gray-300">{avgErr > 0 ? avgErr.toFixed(2) + "%" : "—"}</td>
                    <td className={`text-center px-2 py-2 ${lb.group_vote_accuracy && parseFloat(lb.group_vote_accuracy) >= 55 ? "text-blue-400" : "text-gray-400"}`}>
                      {lb.group_vote_accuracy ? `${lb.group_vote_accuracy}%` : "—"}
                    </td>
                    <td className="text-center px-2 py-2 text-gray-500">{n}</td>
                  </tr>
                );
              })}
              {leaderboard.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-4 text-center text-gray-500">No forecast data yet — results appear after 2+ meetings</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="text-[9px] font-mono text-gray-500 mt-1">
          👑 #1 with 3+ forecasts earns chair · Ranked by win rate · p-value = one-sided binomial test vs coin flip (p=0.5) · <span className="text-yellow-300">*</span> p&lt;0.05 · <span className="text-yellow-300">**</span> p&lt;0.01 · <span className="text-yellow-300">***</span> p&lt;0.001 · Edge = win rate minus base rate
        </div>
      </div>

      {Object.values(errorHistory).some(h => h.length > 1) && (
        <div>
          <div className={`text-[11px] font-mono font-bold ${GOLD_TEXT} mb-2`}>📉 CUMULATIVE PREDICTION ERROR</div>
          <div className="text-[9px] font-mono text-gray-500 mb-2 leading-relaxed">
            Running total of each LLM&apos;s absolute price prediction error over time.
            Each round, the error = |predicted BTC price - actual BTC price| / actual price as a %. Errors above 10% are excluded as outliers.
            The <span className="text-white/60">lowest line</span> is the most accurate price predictor. Filled dots = correct direction call, hollow dots = wrong direction.
            This measures <span className="text-white/60">price target precision</span>, not direction accuracy.
          </div>
          <div className={`rounded-lg p-4 ${PANEL}`}>
            <svg viewBox="0 0 600 220" className="w-full h-52">
              {/* Y axis grid — cumulative % error */}
              {Array.from({ length: 5 }, (_, i) => {
                const v = (maxCumError * 1.1 / 4) * i;
                const y = 190 - (v / (maxCumError * 1.1)) * 175;
                return (
                  <g key={i}>
                    <line x1="45" y1={y} x2="590" y2={y} stroke="rgba(255,255,255,0.06)" strokeDasharray="4 4" />
                    <text x="40" y={y + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">{v.toFixed(1)}%</text>
                  </g>
                );
              })}
              {/* Zero baseline */}
              <line x1="45" y1={190} x2="590" y2={190} stroke="rgba(255,255,255,0.1)" />
              <text x="40" y={193} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">0%</text>
              {/* Lines for each LLM — cumulative error */}
              {memberIds.map(id => {
                const hist = errorHistory[id];
                if (hist.length < 1) return null;
                const mem = MEMBERS[id as MemberId];
                const allRounds = Object.values(errorHistory).flat().map(e => e.round);
                const minR = Math.min(...allRounds);
                const maxR = Math.max(...allRounds);
                const range = maxR - minR || 1;
                // Start from zero
                const pointsArr = [{ x: 50, y: 190 }, ...hist.map(h => ({
                  x: 50 + ((h.round - minR) / range) * 530,
                  y: 190 - (h.cumError / (maxCumError * 1.1)) * 175,
                }))];
                const points = pointsArr.map(p => `${p.x},${p.y}`).join(" ");
                return (
                  <g key={id}>
                    <polyline points={points} fill="none" stroke={mem.barBg} strokeWidth="2" strokeOpacity="0.8" />
                    {hist.map((h, i) => {
                      const x = 50 + ((h.round - minR) / range) * 530;
                      const y = 190 - (h.cumError / (maxCumError * 1.1)) * 175;
                      return <circle key={i} cx={x} cy={y} r="3" fill={h.correct ? mem.barBg : "transparent"} stroke={mem.barBg} strokeWidth="1.5" />;
                    })}
                    {/* Label at end */}
                    {hist.length > 0 && (() => {
                      const last = pointsArr[pointsArr.length - 1];
                      return <text x={last.x + 5} y={last.y + 3} fill={mem.barBg} fontSize="8" fontFamily="monospace" opacity="0.8">{id.toUpperCase()}</text>;
                    })()}
                  </g>
                );
              })}
            </svg>
            <div className="flex gap-4 justify-center mt-2">
              {memberIds.map(id => {
                const mem = MEMBERS[id as MemberId];
                const hist = errorHistory[id];
                const cumErr = hist.length > 0 ? hist[hist.length - 1].cumError : 0;
                return (
                  <div key={id} className="flex items-center gap-1">
                    <div className="w-3 h-0.5 rounded" style={{ backgroundColor: mem.barBg }} />
                    <span className={`text-[9px] font-mono ${mem.text}`}>{id.toUpperCase()} {cumErr.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
            <div className="text-[8px] font-mono text-gray-500 text-center mt-1">
              Cumulative % error over time · All start at 0 · Lowest line = most accurate · ● correct dir · ○ wrong dir
            </div>
          </div>
        </div>
      )}

      {/* ── CUMULATIVE RETURNS CHART ── */}
      {(() => {
        const chartData: any[] = data.chartData || [];
        if (chartData.length < 2) return null;

        // Description rendered inside the return block below

        // Compute cumulative return for each LLM, consensus, group vote, and buy & hold
        type RetPt = { round: number; time: string; cum: number };
        const series: Record<string, RetPt[]> = {};
        const ids = [...memberIds, "consensus", "groupVote", "buyHold"];
        for (const id of ids) series[id] = [];

        let cumBH = 0;
        const cumMap: Record<string, number> = {};
        for (const id of [...memberIds, "consensus", "groupVote"]) cumMap[id] = 0;

        for (const d of chartData) {
          const ch = d.changePct || 0;
          // Buy & hold: always long, so return = actual change
          cumBH += ch;
          series.buyHold.push({ round: d.round, time: d.time, cum: cumBH });

          // Each LLM: if predicted UP, return = change; if DOWN, return = -change
          for (const id of memberIds) {
            const dir = d.dirs?.[id];
            if (dir) {
              cumMap[id] += dir === "UP" ? ch : -ch;
            }
            series[id].push({ round: d.round, time: d.time, cum: cumMap[id] });
          }

          // Consensus
          if (d.consensusDir) {
            cumMap.consensus += d.consensusDir === "UP" ? ch : -ch;
          }
          series.consensus.push({ round: d.round, time: d.time, cum: cumMap.consensus });

          // Group vote
          if (d.groupVoteDir) {
            cumMap.groupVote += d.groupVoteDir === "UP" ? ch : -ch;
          }
          series.groupVote.push({ round: d.round, time: d.time, cum: cumMap.groupVote });
        }

        const allVals = ids.flatMap(id => series[id].map(p => p.cum));
        const minV = Math.min(...allVals, 0);
        const maxV = Math.max(...allVals, 0);
        const range = (maxV - minV) || 1;
        const pad = range * 0.1;
        const yMin = minV - pad;
        const yMax = maxV + pad;
        const yRange = yMax - yMin;
        const totalPts = chartData.length;

        const toX = (i: number) => 50 + (i / Math.max(1, totalPts - 1)) * 530;
        const toY = (v: number) => 190 - ((v - yMin) / yRange) * 175;

        const memberColors: Record<string, string> = {
          claude: "#c4a5ff", gpt: "#74d4a8", grok: "#ff9966", gemini: "#66bbff", deepseek: "#ffcc44",
          consensus: "#D4A843", groupVote: "#ffffff", buyHold: "#666666",
        };
        const memberLabels: Record<string, string> = {
          claude: "CLAUDE", gpt: "GPT", grok: "GROK", gemini: "GEMINI", deepseek: "DEEPSEEK",
          consensus: "CONSENSUS", groupVote: "GRP VOTE", buyHold: "BUY&HOLD",
        };

        // Y-axis grid lines
        const ySteps = 5;
        const yGridLines = Array.from({ length: ySteps + 1 }, (_, i) => yMin + (yRange / ySteps) * i);

        return (
          <div>
            <div className={`text-[11px] font-mono font-bold ${GOLD_TEXT} mb-2`}>📈 CUMULATIVE RETURNS — Direction Bets (entire history)</div>
            <div className="text-[9px] font-mono text-gray-500 mb-2 leading-relaxed">
              Simulated P&amp;L if you traded each LLM&apos;s hourly direction call. For each round: if an LLM predicted UP, its return = the actual BTC % change that hour;
              if it predicted DOWN, its return = the negative of the actual change (i.e. it profits when BTC falls).
              Returns are summed cumulatively. <span className="text-white/60">Gold line</span> = consensus (majority vote of all 5 LLMs).{" "}
              <span className="text-white/60">Dashed gray</span> = buy &amp; hold (always long BTC, benchmark).{" "}
              <span className="text-white/60">Dashed white</span> = group vote (formal group recommendation, which can differ from consensus).
              A rising line above zero means the strategy is profitable; above the gray dashed line means it beats passive BTC holding.
            </div>
            <div className={`rounded-lg p-4 ${PANEL}`}>
              <svg viewBox="0 0 600 230" className="w-full h-56">
                {/* Y-axis gridlines */}
                {yGridLines.map((v, i) => {
                  const y = toY(v);
                  return (
                    <g key={i}>
                      <line x1="45" y1={y} x2="590" y2={y} stroke={Math.abs(v) < 0.01 ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)"} strokeDasharray={Math.abs(v) < 0.01 ? "0" : "4 4"} />
                      <text x="40" y={y + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">{v >= 0 ? "+" : ""}{v.toFixed(1)}%</text>
                    </g>
                  );
                })}
                {/* Zero line (heavier) */}
                <line x1="45" y1={toY(0)} x2="590" y2={toY(0)} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                {/* Buy & hold — dashed, behind */}
                <polyline
                  points={series.buyHold.map((p, i) => `${toX(i)},${toY(p.cum)}`).join(" ")}
                  fill="none" stroke={memberColors.buyHold} strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.5"
                />
                {/* LLM lines */}
                {memberIds.map(id => {
                  const pts = series[id];
                  if (pts.length < 2) return null;
                  return (
                    <polyline key={id}
                      points={pts.map((p, i) => `${toX(i)},${toY(p.cum)}`).join(" ")}
                      fill="none" stroke={memberColors[id]} strokeWidth="1.5" strokeOpacity="0.7"
                    />
                  );
                })}
                {/* Group vote — white dashed */}
                <polyline
                  points={series.groupVote.map((p, i) => `${toX(i)},${toY(p.cum)}`).join(" ")}
                  fill="none" stroke={memberColors.groupVote} strokeWidth="1.5" strokeDasharray="6 3" strokeOpacity="0.5"
                />
                {/* Consensus — gold, thicker, on top */}
                <polyline
                  points={series.consensus.map((p, i) => `${toX(i)},${toY(p.cum)}`).join(" ")}
                  fill="none" stroke={memberColors.consensus} strokeWidth="2.5" strokeOpacity="0.9"
                />
                {/* End labels */}
                {ids.map(id => {
                  const pts = series[id];
                  if (pts.length === 0) return null;
                  const last = pts[pts.length - 1];
                  const x = toX(pts.length - 1);
                  const y = toY(last.cum);
                  // Stagger labels to avoid overlap
                  return (
                    <text key={id} x={x + 4} y={y + 3} fill={memberColors[id]} fontSize="7" fontFamily="monospace" opacity="0.8">
                      {last.cum >= 0 ? "+" : ""}{last.cum.toFixed(1)}%
                    </text>
                  );
                })}
                {/* X-axis labels — first and last date */}
                {chartData.length > 0 && (
                  <>
                    <text x="50" y="208" fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="monospace">
                      {new Date(chartData[0].time).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </text>
                    <text x="580" y="208" textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="monospace">
                      {new Date(chartData[chartData.length - 1].time).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </text>
                    <text x="315" y="222" textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize="7" fontFamily="monospace">
                      {chartData.length} rounds
                    </text>
                  </>
                )}
              </svg>
              {/* Legend */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2">
                {ids.map(id => {
                  const pts = series[id];
                  const final = pts.length > 0 ? pts[pts.length - 1].cum : 0;
                  const isDashed = id === "buyHold" || id === "groupVote";
                  return (
                    <div key={id} className="flex items-center gap-1">
                      <div className="w-4 h-0.5 rounded" style={{
                        backgroundColor: memberColors[id],
                        opacity: id === "buyHold" ? 0.5 : 0.8,
                        ...(isDashed ? { backgroundImage: `repeating-linear-gradient(90deg, ${memberColors[id]} 0px, ${memberColors[id]} 3px, transparent 3px, transparent 6px)`, backgroundColor: "transparent" } : {}),
                      }} />
                      <span className="text-[8px] font-mono" style={{ color: memberColors[id], opacity: 0.8 }}>
                        {memberLabels[id]} {final >= 0 ? "+" : ""}{final.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="text-[8px] font-mono text-gray-500 text-center mt-1">
                Return = actual BTC hourly % move × direction bet · Gold = consensus · Dashed white = group vote · Dashed gray = buy &amp; hold
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── ROLLING 10-PERIOD WIN RATE ── */}
      {(() => {
        const chartData: any[] = data.chartData || [];
        if (chartData.length < 12) return null;
        const WINDOW = 10;
        const allIds = [...memberIds, "consensus"];
        const memberColors: Record<string, string> = {
          claude: "#c4a5ff", gpt: "#74d4a8", grok: "#ff9966", gemini: "#66bbff", deepseek: "#ffcc44",
          consensus: "#D4A843",
        };
        const memberLabels: Record<string, string> = {
          claude: "CLAUDE", gpt: "GPT", grok: "GROK", gemini: "GEMINI", deepseek: "DEEPSEEK",
          consensus: "CONSENSUS",
        };

        // Build rolling win-rate series
        const wrSeries: Record<string, { round: number; wr: number }[]> = {};
        for (const id of allIds) wrSeries[id] = [];

        // First build per-round correct/wrong for each
        const roundCorrect: Record<string, boolean[]> = {};
        for (const id of allIds) roundCorrect[id] = [];
        for (const d of chartData) {
          const ch = d.changePct || 0;
          const actualDir = ch >= 0 ? "UP" : "DOWN";
          for (const id of memberIds) {
            const dir = d.dirs?.[id];
            roundCorrect[id].push(dir === actualDir);
          }
          roundCorrect.consensus.push(d.consensusDir === actualDir);
        }

        // Compute rolling window
        for (const id of allIds) {
          const arr = roundCorrect[id];
          for (let i = WINDOW - 1; i < arr.length; i++) {
            const wins = arr.slice(i - WINDOW + 1, i + 1).filter(Boolean).length;
            wrSeries[id].push({ round: chartData[i].round, wr: (wins / WINDOW) * 100 });
          }
        }

        const totalPts = wrSeries[allIds[0]]?.length || 0;
        if (totalPts < 2) return null;
        const toX = (i: number) => 50 + (i / Math.max(1, totalPts - 1)) * 530;
        const toY = (v: number) => 190 - ((v - 20) / 60) * 175; // range 20%-80%

        return (
          <div>
            <div className={`text-[11px] font-mono font-bold ${GOLD_TEXT} mb-2`}>🎯 ROLLING {WINDOW}-PERIOD WIN RATE</div>
            <div className="text-[9px] font-mono text-gray-500 mb-2 leading-relaxed">
              Direction accuracy over a sliding window of the last {WINDOW} rounds. At each point, win rate = number of correct direction calls in the preceding {WINDOW} rounds / {WINDOW}.
              The <span className="text-white/60">50% line</span> represents a coin flip (no skill). Sustained periods above 50% suggest genuine predictive ability; below 50% means the model is
              doing worse than random. This chart reveals <span className="text-white/60">streaks and regime changes</span> — an LLM may perform well in trending markets but poorly in choppy ones.
            </div>
            <div className={`rounded-lg p-4 ${PANEL}`}>
              <svg viewBox="0 0 600 220" className="w-full h-52">
                {/* Y grid */}
                {[20, 30, 40, 50, 60, 70, 80].map(v => (
                  <g key={v}>
                    <line x1="45" y1={toY(v)} x2="590" y2={toY(v)} stroke={v === 50 ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)"} strokeDasharray={v === 50 ? "0" : "4 4"} />
                    <text x="40" y={toY(v) + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">{v}%</text>
                  </g>
                ))}
                {/* 50% reference line */}
                <line x1="45" y1={toY(50)} x2="590" y2={toY(50)} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                {/* LLM lines */}
                {memberIds.map(id => {
                  const pts = wrSeries[id];
                  if (pts.length < 2) return null;
                  return <polyline key={id} points={pts.map((p, i) => `${toX(i)},${toY(p.wr)}`).join(" ")} fill="none" stroke={memberColors[id]} strokeWidth="1.5" strokeOpacity="0.6" />;
                })}
                {/* Consensus — gold, thicker */}
                <polyline points={wrSeries.consensus.map((p, i) => `${toX(i)},${toY(p.wr)}`).join(" ")} fill="none" stroke={memberColors.consensus} strokeWidth="2.5" strokeOpacity="0.9" />
                {/* End labels */}
                {allIds.map(id => {
                  const pts = wrSeries[id];
                  if (pts.length === 0) return null;
                  const last = pts[pts.length - 1];
                  return <text key={id} x={toX(pts.length - 1) + 4} y={toY(last.wr) + 3} fill={memberColors[id]} fontSize="7" fontFamily="monospace" opacity="0.8">{last.wr.toFixed(0)}%</text>;
                })}
              </svg>
              <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2">
                {allIds.map(id => {
                  const pts = wrSeries[id];
                  const last = pts.length > 0 ? pts[pts.length - 1].wr : 0;
                  return (
                    <div key={id} className="flex items-center gap-1">
                      <div className="w-3 h-0.5 rounded" style={{ backgroundColor: memberColors[id], opacity: id === "consensus" ? 0.9 : 0.7 }} />
                      <span className="text-[8px] font-mono" style={{ color: memberColors[id] }}>{memberLabels[id]} {last.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
              <div className="text-[8px] font-mono text-gray-500 text-center mt-1">
                Rolling {WINDOW}-round direction accuracy · 50% line = coin flip · Gold = consensus
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── ROLLING 10-PERIOD SHARPE RATIO ── */}
      {(() => {
        const chartData: any[] = data.chartData || [];
        if (chartData.length < 12) return null;
        const WINDOW = 10;
        const allIds = [...memberIds, "consensus"];
        const memberColors: Record<string, string> = {
          claude: "#c4a5ff", gpt: "#74d4a8", grok: "#ff9966", gemini: "#66bbff", deepseek: "#ffcc44",
          consensus: "#D4A843",
        };
        const memberLabels: Record<string, string> = {
          claude: "CLAUDE", gpt: "GPT", grok: "GROK", gemini: "GEMINI", deepseek: "DEEPSEEK",
          consensus: "CONSENSUS",
        };

        // Build per-round return for each
        const roundRets: Record<string, number[]> = {};
        for (const id of allIds) roundRets[id] = [];
        for (const d of chartData) {
          const ch = d.changePct || 0;
          for (const id of memberIds) {
            const dir = d.dirs?.[id];
            roundRets[id].push(dir === "UP" ? ch : -ch);
          }
          roundRets.consensus.push(d.consensusDir === "UP" ? ch : -ch);
        }

        // Rolling Sharpe: mean / stdev * sqrt(annualisation)
        // Each round = 1 hour → ~8760 hours/year
        const ANN = Math.sqrt(8760);
        const srSeries: Record<string, { round: number; sr: number }[]> = {};
        for (const id of allIds) {
          srSeries[id] = [];
          const rets = roundRets[id];
          for (let i = WINDOW - 1; i < rets.length; i++) {
            const window = rets.slice(i - WINDOW + 1, i + 1);
            const mean = window.reduce((s, v) => s + v, 0) / WINDOW;
            const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / WINDOW;
            const std = Math.sqrt(variance);
            const sr = std > 0 ? (mean / std) * ANN : 0;
            // Clamp to reasonable range
            srSeries[id].push({ round: chartData[i].round, sr: Math.max(-20, Math.min(20, sr)) });
          }
        }

        const totalPts = srSeries[allIds[0]]?.length || 0;
        if (totalPts < 2) return null;

        const allVals = allIds.flatMap(id => srSeries[id].map(p => p.sr));
        const minSR = Math.min(...allVals, -5);
        const maxSR = Math.max(...allVals, 5);
        const srRange = (maxSR - minSR) || 1;
        const pad = srRange * 0.1;
        const yMin = minSR - pad;
        const yMax = maxSR + pad;
        const yRange = yMax - yMin;

        const toX = (i: number) => 50 + (i / Math.max(1, totalPts - 1)) * 530;
        const toY = (v: number) => 190 - ((v - yMin) / yRange) * 175;

        // Y grid
        const step = yRange > 20 ? 5 : yRange > 10 ? 2 : 1;
        const yGridVals: number[] = [];
        for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yGridVals.push(v);

        return (
          <div>
            <div className={`text-[11px] font-mono font-bold ${GOLD_TEXT} mb-2`}>⚡ ROLLING {WINDOW}-PERIOD SHARPE RATIO (annualised)</div>
            <div className="text-[9px] font-mono text-gray-500 mb-2 leading-relaxed">
              Risk-adjusted return over a sliding window of {WINDOW} rounds. Sharpe Ratio = (mean return / standard deviation of returns) x annualisation factor.
              Each round&apos;s return is the signed BTC hourly move (positive if the LLM&apos;s direction call was correct, negative if wrong).
              Annualised by multiplying by √8760 (hours per year). <span className="text-white/60">Above zero</span> = positive risk-adjusted returns;{" "}
              <span className="text-white/60">below zero</span> = losing money on a risk-adjusted basis. A Sharpe above 2 is considered excellent; above 1 is good.
              Unlike win rate, this accounts for the <span className="text-white/60">magnitude</span> of each move — being right on big moves matters more than being right on small ones.
            </div>
            <div className={`rounded-lg p-4 ${PANEL}`}>
              <svg viewBox="0 0 600 220" className="w-full h-52">
                {yGridVals.map(v => (
                  <g key={v}>
                    <line x1="45" y1={toY(v)} x2="590" y2={toY(v)} stroke={v === 0 ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)"} strokeDasharray={v === 0 ? "0" : "4 4"} />
                    <text x="40" y={toY(v) + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">{v.toFixed(0)}</text>
                  </g>
                ))}
                {/* Zero line */}
                <line x1="45" y1={toY(0)} x2="590" y2={toY(0)} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                {/* LLM lines */}
                {memberIds.map(id => {
                  const pts = srSeries[id];
                  if (pts.length < 2) return null;
                  return <polyline key={id} points={pts.map((p, i) => `${toX(i)},${toY(p.sr)}`).join(" ")} fill="none" stroke={memberColors[id]} strokeWidth="1.5" strokeOpacity="0.6" />;
                })}
                {/* Consensus */}
                <polyline points={srSeries.consensus.map((p, i) => `${toX(i)},${toY(p.sr)}`).join(" ")} fill="none" stroke={memberColors.consensus} strokeWidth="2.5" strokeOpacity="0.9" />
                {/* End labels */}
                {allIds.map(id => {
                  const pts = srSeries[id];
                  if (pts.length === 0) return null;
                  const last = pts[pts.length - 1];
                  return <text key={id} x={toX(pts.length - 1) + 4} y={toY(last.sr) + 3} fill={memberColors[id]} fontSize="7" fontFamily="monospace" opacity="0.8">{last.sr.toFixed(1)}</text>;
                })}
              </svg>
              <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2">
                {allIds.map(id => {
                  const pts = srSeries[id];
                  const last = pts.length > 0 ? pts[pts.length - 1].sr : 0;
                  return (
                    <div key={id} className="flex items-center gap-1">
                      <div className="w-3 h-0.5 rounded" style={{ backgroundColor: memberColors[id], opacity: id === "consensus" ? 0.9 : 0.7 }} />
                      <span className="text-[8px] font-mono" style={{ color: memberColors[id] }}>{memberLabels[id]} {last >= 0 ? "+" : ""}{last.toFixed(1)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="text-[8px] font-mono text-gray-500 text-center mt-1">
                Rolling {WINDOW}-round Sharpe ratio · Annualised (×√8760) · Zero line = no edge · Gold = consensus
              </div>
            </div>
          </div>
        );
      })()}

      {forecasts.length > 0 && (() => {
        const last10 = forecasts.slice(0, 10).reverse(); // oldest to newest, left to right
        return (
          <div>
            <div className={`text-[11px] font-mono font-bold ${GOLD_TEXT} mb-2`}>📡 DIRECTION TAPE — Last {last10.length} Meetings</div>
            <div className="text-[9px] font-mono text-gray-500 mb-2 leading-relaxed">
              Recent prediction history for each LLM. Each column is one hourly round. Top row shows what BTC actually did (green ▲ = UP, red ▼ = DOWN).
              Below it: each LLM&apos;s individual prediction. <span className="text-white/60">Bright</span> arrows = correct call, <span className="text-white/60">dim</span> = wrong.
              The &quot;Bias&quot; column shows what % of the last {last10.length} calls were UP — a model that always predicts UP (100%) or always DOWN (0%) is flagged with ⚠ as it may lack nuance.
            </div>
            <div className={`rounded-lg overflow-hidden border ${GOLD_BG}`}>
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left px-3 py-1.5 text-gray-400 w-24">Meeting</th>
                    {last10.map((f: any) => (
                      <th key={f.id} className="text-center px-1 py-1.5 text-gray-500">#{f.round_number}</th>
                    ))}
                    <th className="text-right px-3 py-1.5 text-gray-400">Bias</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Actual BTC direction */}
                  <tr className="border-b border-white/5">
                    <td className="px-3 py-1.5 text-gray-300 font-bold">BTC Actual</td>
                    {last10.map((f: any) => {
                      const dir = f.actual_direction;
                      return (
                        <td key={f.id} className="text-center px-1 py-1.5">
                          <span className={`text-sm ${dir === "UP" ? "text-green-400" : "text-red-400"}`}>
                            {dir === "UP" ? "▲" : "▼"}
                          </span>
                        </td>
                      );
                    })}
                    <td className="text-right px-3 py-1.5 text-gray-400">
                      {(() => {
                        const ups = last10.filter((f: any) => f.actual_direction === "UP").length;
                        return `${ups}▲ ${last10.length - ups}▼`;
                      })()}
                    </td>
                  </tr>
                  {/* Group vote direction */}
                  <tr className="border-b border-white/5 bg-blue-500/5">
                    <td className="px-3 py-1.5 text-blue-400 font-bold">🗳 Group Vote</td>
                    {last10.map((f: any) => {
                      const gv = f.group_vote_direction;
                      if (!gv) return <td key={f.id} className="text-center px-1 py-1.5"><span className="text-gray-600">·</span></td>;
                      const correct = f.actual_direction && gv === f.actual_direction;
                      return (
                        <td key={f.id} className="text-center px-1 py-1.5">
                          <span className={`text-sm ${correct ? "opacity-100" : "opacity-30"}`}>
                            <span className={gv === "UP" ? "text-green-400" : "text-red-400"}>
                              {gv === "UP" ? "▲" : "▼"}
                            </span>
                          </span>
                        </td>
                      );
                    })}
                    <td className="text-right px-3 py-1.5 text-blue-400">
                      {(() => {
                        const withGv = last10.filter((f: any) => f.group_vote_direction);
                        const gvUps = withGv.filter((f: any) => f.group_vote_direction === "UP").length;
                        return withGv.length > 0 ? `${Math.round(gvUps / withGv.length * 100)}% ▲` : "—";
                      })()}
                    </td>
                  </tr>
                  {/* Each LLM's predicted direction */}
                  {memberIds.map(id => {
                    const mem = MEMBERS[id as MemberId];
                    let ups = 0; let correct = 0; let total = 0;
                    const cells = last10.map((f: any) => {
                      const indiv = typeof f.individual_forecasts === "string" ? JSON.parse(f.individual_forecasts) : f.individual_forecasts;
                      const scores = typeof f.individual_scores === "string" ? JSON.parse(f.individual_scores) : f.individual_scores;
                      const pred = indiv?.[id]?.direction;
                      const wasCorrect = scores?.[id]?.direction_correct;
                      if (pred === "UP") ups++;
                      if (pred) total++;
                      if (wasCorrect) correct++;
                      return { id: f.id, pred, wasCorrect, actual: f.actual_direction };
                    });
                    const upPct = total > 0 ? Math.round(ups / total * 100) : 0;
                    const allSame = upPct === 100 || upPct === 0;
                    return (
                      <tr key={id} className="border-b border-white/5">
                        <td className={`px-3 py-1.5 ${mem.text}`}>{mem.emoji} {id.toUpperCase()}</td>
                        {cells.map((c, i) => (
                          <td key={i} className="text-center px-1 py-1.5">
                            {c.pred ? (
                              <span className={`text-sm ${c.wasCorrect ? "opacity-100" : "opacity-30"}`}>
                                <span className={c.pred === "UP" ? "text-green-400" : "text-red-400"}>
                                  {c.pred === "UP" ? "▲" : "▼"}
                                </span>
                              </span>
                            ) : <span className="text-gray-600">·</span>}
                          </td>
                        ))}
                        <td className={`text-right px-3 py-1.5 ${allSame ? "text-yellow-400 font-bold" : "text-gray-400"}`}>
                          {upPct}% ▲{allSame && " ⚠"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-[8px] font-mono text-gray-500 mt-1">
              Bright = correct direction · Dim = wrong direction · ⚠ = always predicts same direction
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function BoardStats({ stats, meetings }: { stats: any; meetings: any[] }) {
  const ms = stats.meetingStats || {};
  const fs = stats.filterStats || {};

  const voteData: Record<string, { support: number; oppose: number }> = {};
  for (const m of meetings) {
    const votes = typeof m.votes === "string" ? JSON.parse(m.votes) : m.votes;
    if (!votes) continue;
    for (const [id, v] of Object.entries(votes) as any) {
      if (!voteData[id]) voteData[id] = { support: 0, oppose: 0 };
      if (v.support) voteData[id].support++; else voteData[id].oppose++;
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Meetings", value: ms.total_meetings || 0 },
          { label: "Passed", value: `${ms.passed || 0} / ${(ms.passed || 0) + (ms.failed || 0)}` },
          { label: "Deployed", value: ms.deployed || 0 },
          { label: "Tokens Used", value: ((ms.total_tokens || 0) / 1000).toFixed(1) + "K" },
        ].map(s => (
          <div key={s.label} className={`p-3 rounded-lg text-center border ${GOLD_BG}`}>
            <div className={`text-lg font-mono font-bold ${GOLD_TEXT}`}>{s.value}</div>
            <div className="text-[9px] font-mono text-gray-300">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Active Filters", value: fs.active_filters || 0, cls: "text-green-400" },
          { label: "Signals Passed", value: fs.total_passed || 0, cls: "text-green-400" },
          { label: "Signals Filtered", value: fs.total_filtered || 0, cls: "text-red-400" },
        ].map(s => (
          <div key={s.label} className={`p-3 rounded-lg text-center ${PANEL}`}>
            <div className={`text-lg font-mono font-bold ${s.cls}`}>{s.value}</div>
            <div className="text-[9px] font-mono text-gray-300">{s.label}</div>
          </div>
        ))}
      </div>

      {Object.keys(voteData).length > 0 && (
        <div>
          <div className="text-[10px] font-mono font-bold text-gray-300 mb-2">🗳 VOTING PATTERNS</div>
          <div className="space-y-1">
            {Object.entries(voteData).map(([id, v]) => {
              const total = v.support + v.oppose;
              const pct = total > 0 ? (v.support / total * 100).toFixed(0) : "0";
              const mem = getMember(id);
              return (
                <div key={id} className="flex items-center gap-2">
                  <span className={`text-[10px] font-mono w-20 ${mem.text}`}>{mem.emoji} {id.toUpperCase()}</span>
                  <div className="flex-1 h-3 rounded overflow-hidden bg-white/10">
                    <div className="h-full rounded transition-all" style={{ width: `${pct}%`, background: mem.barBg }} />
                  </div>
                  <span className="text-[9px] font-mono text-gray-300 w-24 text-right">
                    {v.support}✅ {v.oppose}❌ ({pct}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}


/* ── Approval Queue ── */
function ApprovalQueue({ approvals, onRefresh }: { approvals: any[]; onRefresh: () => void }) {
  const [processing, setProcessing] = useState<number | null>(null);

  const handleAction = async (id: number, action: "approveMotion" | "rejectMotion", reason?: string) => {
    setProcessing(id);
    try {
      await fetch("/api/board", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id, reason }),
      });
      onRefresh();
    } catch {}
    setProcessing(null);
  };

  if (approvals.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-2xl mb-2">✅</div>
        <div className="text-[12px] font-mono text-gray-400">No pending approvals</div>
        <div className="text-[10px] font-mono text-gray-600 mt-1">
          Destructive board actions (exclude coin, emergency halt, strategy changes) require your approval before deployment.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-[11px] font-mono text-red-400">
        ⚠ {approvals.length} action{approvals.length > 1 ? "s" : ""} awaiting your approval.
      </div>
      {approvals.map(a => {
        const params = typeof a.parameters === "string" ? JSON.parse(a.parameters) : a.parameters;
        const details = params?.details || params?.motion?.details || {};
        return (
          <div key={a.id} className="p-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.03]">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] font-mono font-bold text-amber-400">{a.request_type}</span>
              <span className="text-[9px] font-mono text-gray-500">
                Meeting #{a.round_number} · {a.chair_id?.toUpperCase()} · {new Date(a.created_at).toLocaleString()}
              </span>
            </div>
            <div className="text-[11px] font-mono text-white/80 mb-2">{a.description}</div>
            {details.symbol && <div className="text-[10px] font-mono text-gray-300 mb-2">Coin: <span className="text-white font-bold">{details.symbol}</span></div>}
            {params?.motion?.hypothesis && <div className="text-[10px] font-mono text-gray-400 mb-3 italic">&quot;{params.motion.hypothesis}&quot;</div>}
            <div className="flex gap-2">
              <button onClick={() => handleAction(a.id, "approveMotion")} disabled={processing === a.id}
                className="px-4 py-2 rounded text-[11px] font-mono font-bold bg-green-500 text-black disabled:opacity-40">
                {processing === a.id ? "⏳" : "✅"} APPROVE
              </button>
              <button onClick={() => handleAction(a.id, "rejectMotion", "Rejected by operator")} disabled={processing === a.id}
                className="px-4 py-2 rounded text-[11px] font-mono font-bold bg-red-500/10 text-red-400 border border-red-500/20 disabled:opacity-40">
                {processing === a.id ? "⏳" : "❌"} REJECT
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
