"use client";

import { useState, useEffect, useCallback } from "react";

const GOLD = "#D4A843";
const PURPLE = "#a78bfa";
const GREEN = "#4ade80";
const RED = "#f87171";

const MEMBER_COLORS: Record<string, string> = {
  claude: "#c4a5ff",
  gpt: "#74d4a8",
  grok: "#ff9966",
  gemini: "#66bbff",
  deepseek: "#ffcc44",
};

const MEMBER_ROLES: Record<string, string> = {
  claude: "Chief Risk Officer",
  gpt: "Alpha Hunter",
  grok: "Contrarian",
  gemini: "Systems Architect",
  deepseek: "Empiricist",
};

const MEMBER_EMOJI: Record<string, string> = {
  claude: "🛡",
  gpt: "🎯",
  grok: "⚡",
  gemini: "🏗",
  deepseek: "📊",
};

type BoardTab = "meetings" | "filters" | "overrides" | "research" | "stats";

export default function LLMBoard() {
  const [tab, setTab] = useState<BoardTab>("meetings");
  const [meetings, setMeetings] = useState<any[]>([]);
  const [filters, setFilters] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<any[]>([]);
  const [research, setResearch] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, fRes, oRes, rRes, sRes] = await Promise.all([
        fetch("/api/board?action=meetings&limit=50").then(r => r.json()),
        fetch("/api/board?action=filters&active=false").then(r => r.json()),
        fetch("/api/board?action=overrides").then(r => r.json()),
        fetch("/api/board?action=research").then(r => r.json()),
        fetch("/api/board?action=stats").then(r => r.json()),
      ]);
      setMeetings(mRes.meetings || []);
      setFilters(fRes.filters || []);
      setOverrides(oRes.overrides || []);
      setResearch(rRes.research || []);
      setStats(sRes);
    } catch (e) {
      console.error("Board fetch error:", e);
    }
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggleFilter", id, active }),
    });
    fetchData();
  };

  const tabs: { id: BoardTab; label: string; count?: number }[] = [
    { id: "meetings", label: "🏛 Meetings", count: meetings.length },
    { id: "filters", label: "🔬 Filters", count: filters.filter(f => f.active).length },
    { id: "overrides", label: "🪙 Overrides", count: overrides.length },
    { id: "research", label: "🧪 Research", count: research.length },
    { id: "stats", label: "📈 Stats" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-mono font-bold" style={{ color: GOLD }}>
          🏛 LLM STRATEGY BOARD
        </span>
        <span className="text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>
          {stats?.meetingStats?.total_meetings || 0} meetings · {stats?.filterStats?.active_filters || 0} active filters
        </span>
        <div className="flex-1" />
        <button onClick={fetchData} disabled={loading}
          className="px-2 py-1 rounded text-[10px] font-mono"
          style={{ background: "rgba(212,168,67,0.08)", color: GOLD, border: `1px solid rgba(212,168,67,0.2)` }}>
          {loading ? "⏳" : "↻"} Refresh
        </button>
      </div>

      {/* Board Members */}
      <div className="flex gap-2 flex-wrap">
        {Object.entries(MEMBER_ROLES).map(([id, role]) => (
          <div key={id} className="px-2 py-1 rounded text-[10px] font-mono flex items-center gap-1"
            style={{ background: `${MEMBER_COLORS[id]}10`, border: `1px solid ${MEMBER_COLORS[id]}30`, color: MEMBER_COLORS[id] }}>
            {MEMBER_EMOJI[id]} {id.toUpperCase()} — {role}
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-px rounded overflow-hidden border" style={{ borderColor: "rgba(212,168,67,0.15)" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedMeeting(null); }}
            className="px-3 py-1.5 text-[11px] font-mono transition-all" style={{
              background: tab === t.id ? "rgba(212,168,67,0.1)" : "transparent",
              color: tab === t.id ? GOLD : "rgba(255,255,255,0.3)",
            }}>
            {t.label}{t.count !== undefined ? ` (${t.count})` : ''}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "meetings" && !selectedMeeting && (
        <MeetingsList meetings={meetings} onSelect={loadMeetingDetail} />
      )}
      {tab === "meetings" && selectedMeeting && (
        <MeetingDetail meeting={selectedMeeting} onBack={() => setSelectedMeeting(null)} />
      )}
      {tab === "filters" && (
        <FiltersList filters={filters} onToggle={toggleFilter} onRefresh={fetchData} />
      )}
      {tab === "overrides" && (
        <OverridesList overrides={overrides} onRefresh={fetchData} />
      )}
      {tab === "research" && (
        <ResearchList research={research} />
      )}
      {tab === "stats" && stats && (
        <BoardStats stats={stats} meetings={meetings} />
      )}
    </div>
  );
}

function MeetingsList({ meetings, onSelect }: { meetings: any[]; onSelect: (id: number) => void }) {
  if (meetings.length === 0) {
    return (
      <div className="text-center py-12 text-white/50 font-mono text-sm">
        No board meetings yet. Start the board engine with:<br />
        <code className="text-xs mt-2 inline-block px-3 py-1 rounded" style={{ background: "rgba(0,0,0,0.3)" }}>
          node backend/llm-board.js
        </code>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {meetings.map(m => {
        const passed = m.decision?.startsWith('PASSED');
        const votes = m.votes ? JSON.parse(typeof m.votes === 'string' ? m.votes : JSON.stringify(m.votes)) : {};
        const supportCount = Object.values(votes).filter((v: any) => v.support).length;
        const totalVotes = Object.values(votes).length;

        return (
          <button key={m.id} onClick={() => onSelect(m.id)}
            className="w-full text-left px-3 py-2 rounded transition-all hover:bg-white/[0.02]"
            style={{ border: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono font-bold" style={{ color: MEMBER_COLORS[m.chair_id] || GOLD }}>
                {MEMBER_EMOJI[m.chair_id] || '🏛'} #{m.round_number}
              </span>
              <span className="text-[10px] font-mono" style={{ color: passed ? GREEN : RED }}>
                {passed ? '✅' : '❌'} {m.decision?.slice(0, 80)}
              </span>
              <div className="flex-1" />
              {m.deployed && (
                <span className="text-[9px] font-mono px-1 rounded" style={{ background: "rgba(74,222,128,0.1)", color: GREEN }}>
                  DEPLOYED
                </span>
              )}
              <span className="text-[9px] font-mono text-white/50">
                {supportCount}/{totalVotes} · {m.total_tokens}tok · {((m.duration_ms || 0) / 1000).toFixed(0)}s
              </span>
              <span className="text-[9px] font-mono text-white/40">
                {new Date(m.created_at).toLocaleDateString()} {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function MeetingDetail({ meeting, onBack }: { meeting: any; onBack: () => void }) {
  const proposals = typeof meeting.proposals === 'string' ? JSON.parse(meeting.proposals) : meeting.proposals;
  const debate = typeof meeting.debate === 'string' ? JSON.parse(meeting.debate) : meeting.debate;
  const votes = typeof meeting.votes === 'string' ? JSON.parse(meeting.votes) : meeting.votes;
  const impact = typeof meeting.impact_review === 'string' ? JSON.parse(meeting.impact_review) : meeting.impact_review;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-[10px] font-mono text-white/55 hover:text-white/60">← Back to meetings</button>

      {/* Header */}
      <div className="p-4 rounded-lg" style={{ background: "rgba(212,168,67,0.04)", border: "1px solid rgba(212,168,67,0.15)" }}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg font-mono font-bold" style={{ color: GOLD }}>
            Meeting #{meeting.round_number}
          </span>
          <span className="text-sm font-mono" style={{ color: MEMBER_COLORS[meeting.chair_id] }}>
            {MEMBER_EMOJI[meeting.chair_id]} {meeting.chair_id?.toUpperCase()} chairing
          </span>
        </div>
        <div className="text-[10px] font-mono text-white/55">
          {new Date(meeting.created_at).toLocaleString()} · {((meeting.duration_ms || 0) / 1000).toFixed(1)}s · {meeting.total_tokens} tokens
        </div>
        <div className="mt-2 text-sm font-mono" style={{ color: meeting.decision?.startsWith('PASSED') ? GREEN : RED }}>
          {meeting.decision}
        </div>
      </div>

      {/* Chair's Briefing */}
      {proposals && (
        <div className="p-3 rounded-lg" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-[10px] font-mono font-bold mb-2" style={{ color: MEMBER_COLORS[meeting.chair_id] }}>
            📋 CHAIR&apos;S BRIEFING
          </div>
          {proposals.briefing && (
            <p className="text-[11px] font-mono text-white/60 mb-2">{proposals.briefing}</p>
          )}
          {proposals.key_issue && (
            <p className="text-[11px] font-mono text-white/60 mb-2">
              <span style={{ color: GOLD }}>Key Issue:</span> {proposals.key_issue}
            </p>
          )}
          {proposals.motion && (
            <div className="mt-2 p-2 rounded" style={{ background: "rgba(212,168,67,0.04)" }}>
              <div className="text-[10px] font-mono font-bold" style={{ color: GOLD }}>
                MOTION: {proposals.motion.title || proposals.motion.type}
              </div>
              <div className="text-[10px] font-mono text-white/60 mt-1">
                Type: {proposals.motion.type}
              </div>
              {proposals.motion.hypothesis && (
                <div className="text-[10px] font-mono text-white/50 mt-1">
                  Hypothesis: {proposals.motion.hypothesis}
                </div>
              )}
              {proposals.motion.details && (
                <pre className="text-[9px] font-mono text-white/55 mt-1 overflow-auto max-h-24">
                  {JSON.stringify(proposals.motion.details, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Debate */}
      {debate && Array.isArray(debate) && debate.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-mono font-bold text-white/60">💬 DEBATE</div>
          {debate.map((d: any, i: number) => {
            const resp = d.response || {};
            return (
              <div key={i} className="p-3 rounded-lg" style={{
                background: `${MEMBER_COLORS[d.member_id] || '#fff'}08`,
                borderLeft: `3px solid ${MEMBER_COLORS[d.member_id] || '#fff'}40`,
              }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-mono font-bold" style={{ color: MEMBER_COLORS[d.member_id] }}>
                    {MEMBER_EMOJI[d.member_id]} {d.member_name} ({d.role})
                  </span>
                  <span className="text-[10px] font-mono" style={{ color: resp.support ? GREEN : RED }}>
                    {resp.support ? '✅ SUPPORT' : '❌ OPPOSE'}
                  </span>
                  <span className="text-[9px] font-mono text-white/40">{d.ms}ms · {d.tokens}tok</span>
                </div>
                <p className="text-[11px] font-mono text-white/60">{resp.assessment || d.raw}</p>
                {resp.conditions && (
                  <p className="text-[10px] font-mono text-white/55 mt-1">
                    <span style={{ color: GOLD }}>Conditions:</span> {resp.conditions}
                  </p>
                )}
                {resp.concern && (
                  <p className="text-[10px] font-mono text-white/55 mt-1">
                    <span style={{ color: RED }}>Concern:</span> {resp.concern}
                  </p>
                )}
                {resp.insight && (
                  <p className="text-[10px] font-mono text-white/55 mt-1">
                    <span style={{ color: GREEN }}>Insight:</span> {resp.insight}
                  </p>
                )}
                {resp.counter_proposal && (
                  <p className="text-[10px] font-mono text-white/55 mt-1">
                    <span style={{ color: "#66bbff" }}>Counter:</span> {resp.counter_proposal}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Votes */}
      {votes && (
        <div className="p-3 rounded-lg" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-[10px] font-mono font-bold text-white/60 mb-2">🗳 VOTES</div>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(votes).map(([id, v]: [string, any]) => (
              <div key={id} className="flex items-center gap-1 text-[10px] font-mono"
                style={{ color: MEMBER_COLORS[id] || '#fff' }}>
                {MEMBER_EMOJI[id]} {id.toUpperCase()}: {v.support ? '✅' : '❌'}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Impact Review */}
      {impact && (
        <div className="p-3 rounded-lg" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-[10px] font-mono font-bold text-white/60 mb-2">📊 IMPACT REVIEW</div>
          <div className="text-[11px] font-mono" style={{
            color: impact.verdict === 'POSITIVE' ? GREEN : impact.verdict === 'NEGATIVE' ? RED : GOLD
          }}>
            Verdict: {impact.verdict}
          </div>
          {impact.evidence && <p className="text-[10px] font-mono text-white/60 mt-1">{impact.evidence}</p>}
          {impact.recommendation && <p className="text-[10px] font-mono text-white/60 mt-1">Recommendation: {impact.recommendation}</p>}
        </div>
      )}
    </div>
  );
}

function FiltersList({ filters, onToggle, onRefresh }: { filters: any[]; onToggle: (id: number, active: boolean) => void; onRefresh: () => void }) {
  const active = filters.filter(f => f.active);
  const inactive = filters.filter(f => !f.active);

  return (
    <div className="space-y-4">
      <div className="text-[10px] font-mono text-white/55">
        {active.length} active · {inactive.length} inactive
      </div>

      {filters.length === 0 && (
        <div className="text-center py-8 text-white/50 font-mono text-sm">
          No filters yet. The board will create them during meetings.
        </div>
      )}

      {filters.map(f => (
        <div key={f.id} className="p-3 rounded-lg" style={{
          background: f.active ? "rgba(74,222,128,0.04)" : "rgba(255,255,255,0.01)",
          border: `1px solid ${f.active ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.05)'}`,
          opacity: f.active ? 1 : 0.5,
        }}>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-bold" style={{ color: f.active ? GREEN : "white" }}>
              {f.active ? '✅' : '⏸'} {f.feature}
            </span>
            <span className="text-[9px] font-mono text-white/50">{f.filter_type} · #{f.id}</span>
            <div className="flex-1" />
            <span className="text-[9px] font-mono text-white/50">
              {f.trades_passed || 0} passed · {f.trades_filtered || 0} filtered
            </span>
            <button onClick={() => onToggle(f.id, !f.active)}
              className="text-[9px] font-mono px-2 py-0.5 rounded"
              style={{ background: f.active ? "rgba(248,113,113,0.1)" : "rgba(74,222,128,0.1)", 
                       color: f.active ? RED : GREEN }}>
              {f.active ? 'Disable' : 'Enable'}
            </button>
          </div>
          {f.rationale && <p className="text-[10px] font-mono text-white/60 mt-1">{f.rationale}</p>}
          {f.conditions && (
            <pre className="text-[9px] font-mono text-white/50 mt-1 overflow-auto max-h-16">
              {JSON.stringify(typeof f.conditions === 'string' ? JSON.parse(f.conditions) : f.conditions, null, 2)}
            </pre>
          )}
          <div className="text-[9px] font-mono text-white/40 mt-1">
            Proposed by {f.proposed_by || 'unknown'} · {new Date(f.created_at).toLocaleDateString()}
            {f.meeting_id && ` · Meeting #${f.meeting_id}`}
          </div>
        </div>
      ))}
    </div>
  );
}

function OverridesList({ overrides, onRefresh }: { overrides: any[]; onRefresh: () => void }) {
  const excludes = overrides.filter(o => o.override_type === 'exclude');
  const params = overrides.filter(o => o.override_type === 'parameters');

  return (
    <div className="space-y-4">
      {overrides.length === 0 && (
        <div className="text-center py-8 text-white/50 font-mono text-sm">
          No coin overrides yet. The board will create them during meetings.
        </div>
      )}

      {excludes.length > 0 && (
        <div>
          <div className="text-[10px] font-mono font-bold text-white/60 mb-2">🚫 EXCLUDED COINS</div>
          <div className="flex gap-2 flex-wrap">
            {excludes.map(o => (
              <span key={o.id} className="px-2 py-1 rounded text-[10px] font-mono"
                style={{ background: "rgba(248,113,113,0.08)", color: RED, border: "1px solid rgba(248,113,113,0.2)" }}>
                {o.symbol} <span className="text-white/50">({o.rationale?.slice(0, 40)})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {params.length > 0 && (
        <div>
          <div className="text-[10px] font-mono font-bold text-white/60 mb-2">⚙ PARAMETER OVERRIDES</div>
          {params.map(o => (
            <div key={o.id} className="p-2 rounded mb-1" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <span className="text-[11px] font-mono font-bold" style={{ color: GOLD }}>{o.symbol}</span>
              <pre className="text-[9px] font-mono text-white/55 mt-1">
                {JSON.stringify(typeof o.parameters === 'string' ? JSON.parse(o.parameters) : o.parameters, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResearchList({ research }: { research: any[] }) {
  return (
    <div className="space-y-2">
      {research.length === 0 && (
        <div className="text-center py-8 text-white/50 font-mono text-sm">
          No research entries yet.
        </div>
      )}
      {research.map(r => (
        <div key={r.id} className="p-3 rounded-lg" style={{
          background: r.status === 'killed' ? "rgba(248,113,113,0.04)" : "rgba(255,255,255,0.02)",
          border: `1px solid ${r.status === 'killed' ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.05)'}`,
        }}>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono font-bold" style={{ color: r.status === 'killed' ? RED : GREEN }}>
              {r.status === 'killed' ? '💀' : '🧪'} {r.research_type}
            </span>
            <span className="text-[9px] font-mono text-white/50">{new Date(r.created_at).toLocaleDateString()}</span>
          </div>
          {r.hypothesis && <p className="text-[10px] font-mono text-white/50 mt-1">{r.hypothesis}</p>}
          {r.conclusion && <p className="text-[10px] font-mono text-white/60 mt-1">{r.conclusion}</p>}
          {r.killed_by && (
            <p className="text-[9px] font-mono mt-1" style={{ color: RED }}>
              Killed by {r.killed_by}: {r.killed_reason}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function BoardStats({ stats, meetings }: { stats: any; meetings: any[] }) {
  const ms = stats.meetingStats || {};
  const fs = stats.filterStats || {};

  // Vote distribution
  const voteData: Record<string, { support: number; oppose: number }> = {};
  for (const m of meetings) {
    const votes = typeof m.votes === 'string' ? JSON.parse(m.votes) : m.votes;
    if (!votes) continue;
    for (const [id, v] of Object.entries(votes) as any) {
      if (!voteData[id]) voteData[id] = { support: 0, oppose: 0 };
      if (v.support) voteData[id].support++;
      else voteData[id].oppose++;
    }
  }

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Meetings', value: ms.total_meetings || 0 },
          { label: 'Passed', value: `${ms.passed || 0} / ${(ms.passed || 0) + (ms.failed || 0)}` },
          { label: 'Deployed', value: ms.deployed || 0 },
          { label: 'Tokens Used', value: ((ms.total_tokens || 0) / 1000).toFixed(1) + 'K' },
        ].map(s => (
          <div key={s.label} className="p-3 rounded-lg text-center" style={{ background: "rgba(212,168,67,0.04)", border: "1px solid rgba(212,168,67,0.1)" }}>
            <div className="text-lg font-mono font-bold" style={{ color: GOLD }}>{s.value}</div>
            <div className="text-[9px] font-mono text-white/55">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Active Filters', value: fs.active_filters || 0, color: GREEN },
          { label: 'Signals Passed', value: fs.total_passed || 0, color: GREEN },
          { label: 'Signals Filtered', value: fs.total_filtered || 0, color: RED },
        ].map(s => (
          <div key={s.label} className="p-3 rounded-lg text-center" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
            <div className="text-lg font-mono font-bold" style={{ color: s.color }}>{s.value}</div>
            <div className="text-[9px] font-mono text-white/55">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Vote distribution by member */}
      {Object.keys(voteData).length > 0 && (
        <div>
          <div className="text-[10px] font-mono font-bold text-white/60 mb-2">🗳 VOTING PATTERNS</div>
          <div className="space-y-1">
            {Object.entries(voteData).map(([id, v]) => {
              const total = v.support + v.oppose;
              const pct = total > 0 ? (v.support / total * 100).toFixed(0) : '0';
              return (
                <div key={id} className="flex items-center gap-2">
                  <span className="text-[10px] font-mono w-20" style={{ color: MEMBER_COLORS[id] }}>
                    {MEMBER_EMOJI[id]} {id.toUpperCase()}
                  </span>
                  <div className="flex-1 h-3 rounded overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: MEMBER_COLORS[id] }} />
                  </div>
                  <span className="text-[9px] font-mono text-white/55 w-20 text-right">
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
