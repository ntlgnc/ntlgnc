"use client";

import Link from "next/link";
import { useEffect, useState, useRef } from "react";

const GOLD = "#D4A843";

type ResearchDoc = {
  id: number;
  created_at: string;
  title: string;
  description: string | null;
  doc_type: string;
  content: string | null;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  tags: string[];
  author: string;
};

/* ── tiny helpers ─────────────────────────────────────────── */
function fmtDate(iso: string) { return new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }); }
function fmtSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function badgeColor(type: string) {
  switch (type) {
    case "docx": return { bg: "rgba(66,133,244,0.15)", fg: "#4285F4" };
    case "pdf": return { bg: "rgba(234,67,53,0.15)", fg: "#EA4335" };
    case "markdown": return { bg: "rgba(212,168,67,0.15)", fg: GOLD };
    case "note": return { bg: "rgba(255,255,255,0.08)", fg: "#ccc" };
    default: return { bg: "rgba(212,168,67,0.15)", fg: GOLD };
  }
}

export default function ResearchPage() {
  const [documents, setDocuments] = useState<ResearchDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const [expandedNote, setExpandedNote] = useState<number | null>(null);

  // Upload form state
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadDesc, setUploadDesc] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Note form state
  const [noteTitle, setNoteTitle] = useState("");
  const [noteDesc, setNoteDesc] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [noteTags, setNoteTags] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  async function fetchDocs() {
    try {
      const res = await fetch("/api/research-docs");
      const data = await res.json();
      setDocuments(data.documents || []);
    } catch (err) {
      console.error("Failed to fetch research docs:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchDocs(); }, []);

  async function handleUpload() {
    if (!uploadFile || !uploadTitle.trim()) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", uploadFile);
      form.append("title", uploadTitle);
      form.append("description", uploadDesc);
      form.append("tags", uploadTags);

      const res = await fetch("/api/research-docs", { method: "POST", body: form });
      const data = await res.json();
      if (data.error) { alert(`Upload failed: ${data.error}`); return; }

      // Reset form and refresh
      setUploadTitle(""); setUploadDesc(""); setUploadTags(""); setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setShowUpload(false);
      fetchDocs();
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveNote() {
    if (!noteTitle.trim()) return;
    setSavingNote(true);
    try {
      const res = await fetch("/api/research-docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: noteTitle,
          description: noteDesc,
          content: noteContent,
          tags: noteTags ? noteTags.split(",").map(t => t.trim()).filter(Boolean) : [],
        }),
      });
      const data = await res.json();
      if (data.error) { alert(`Save failed: ${data.error}`); return; }

      setNoteTitle(""); setNoteDesc(""); setNoteContent(""); setNoteTags("");
      setShowNote(false);
      fetchDocs();
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSavingNote(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this document?")) return;
    try {
      await fetch(`/api/research-docs?id=${id}`, { method: "DELETE" });
      fetchDocs();
    } catch {}
  }

  // Static (hardcoded) doc that was there before — include as fallback
  const LEGACY_DOCS = [
    { date: "2026-02-28", title: "Filter Policy Change Justification", desc: "Statistical justification for replacing posInRange filter with Hurst Exponent and 5-Day Trend filters on 1M strategy. Spearman rank analysis of 18,692 OOS signals.", file: "/research/2026-02-28_Filter_Policy_Change_Justification.docx" },
  ];

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-mono font-black mb-2" style={{ color: GOLD }}>Research & Methodology</h1>
      <p className="text-[12px] font-mono text-white/55 mb-12">How the FRACMAP signal system works, validated, and evolves.</p>

      {/* The Model */}
      <section className="mb-12">
        <h2 className="text-sm font-mono font-bold text-white/80 mb-3">The Model</h2>
        <div className="text-[12px] font-mono leading-relaxed text-white/40 space-y-3">
          <p>
            FRACMAP signals are generated by a proprietary mathematical model that detects structural price patterns across cryptocurrency markets. The model operates on fractal principles — repeating patterns that appear at every time scale, from minutes to months.
          </p>
          <p>
            The model computes support and resistance zones using a multi-scale harmonic analysis. When price interacts with these zones under specific conditions, directional signals are generated. The model runs across 100+ cryptocurrency pairs simultaneously, detecting opportunities that would be invisible to human analysis.
          </p>
          <p>
            The core model is never modified by the AI system. It is the fixed mathematical foundation on which everything else is built.
          </p>
        </div>
      </section>

      {/* Validation */}
      <section className="mb-12">
        <h2 className="text-sm font-mono font-bold text-white/80 mb-3">Validation Framework</h2>
        <div className="text-[12px] font-mono leading-relaxed text-white/40 space-y-3">
          <p>
            Every strategy is validated using strict out-of-sample testing. Historical data is split: the first half is used for optimisation, the second half — data the system has never seen — is used for validation. Only strategies that perform well on unseen data are deployed.
          </p>
          <p>
            This approach was verified using synthetic random-walk data (prices with zero predictability). The system correctly found no edge in random data: in-sample Sharpe was high (pure overfitting), but out-of-sample Sharpe was -0.09 — statistically zero. This proves the validation gate works.
          </p>
          <p>
            When the same pipeline produces positive out-of-sample Sharpe ratios on real market data across 100+ coins and 5+ years of history, the edge is genuine market structure, not a statistical artefact.
          </p>
        </div>

        {/* Key stats box */}
        <div className="mt-4 p-4 rounded-xl grid grid-cols-3 gap-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          {[
            { l: "OOS Consistency", v: "69/104 coins", d: "Positive Sharpe on unseen data" },
            { l: "Bootstrap Significance", v: "9 coins at p<0.05", d: "Verified via 10,000 random permutations" },
            { l: "Random Walk Check", v: "OOS SR: -0.09", d: "Confirms no look-ahead bias" },
          ].map(s => (
            <div key={s.l}>
              <div className="text-[8px] font-mono uppercase tracking-widest text-white/50">{s.l}</div>
              <div className="text-sm font-mono font-bold" style={{ color: GOLD }}>{s.v}</div>
              <div className="text-[9px] font-mono text-white/50 mt-0.5">{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Regime Analysis */}
      <section className="mb-12">
        <h2 className="text-sm font-mono font-bold text-white/80 mb-3">Regime Analysis</h2>
        <div className="text-[12px] font-mono leading-relaxed text-white/40 space-y-3">
          <p>
            Every signal is tagged with 16 market features at the moment of entry: volatility state, trend direction, time of day, price position in range, and more. These features are analysed to determine which market conditions produce the best and worst signal performance.
          </p>
          <p>
            Features are ranked by &ldquo;spread&rdquo; — the difference in performance between the best and worst conditions. Features with high spread AND stable rankings across in-sample and out-of-sample data are used as live filters. Features that invert (the best bucket in-sample becomes the worst out-of-sample) are retired.
          </p>
          <p>
            Currently, 6 features show perfect stability (ρ=1.0) between in-sample and out-of-sample: the system&apos;s performance in these conditions is consistent and predictable.
          </p>
        </div>
      </section>

      {/* AI Strategy Board */}
      <section className="mb-12">
        <h2 className="text-sm font-mono font-bold text-white/80 mb-3">AI Strategy Board</h2>
        <div className="text-[12px] font-mono leading-relaxed text-white/40 space-y-3">
          <p>
            Six AI models from different providers meet hourly to debate strategy modifications. Each model brings a different analytical perspective: quantitative rigour, risk assessment, contrarian thinking, cross-market context, parameter sensitivity, and timing effects.
          </p>
          <p>
            One model proposes a modification each hour. The others critique it. A supermajority (4/6) must agree before the proposal is tested. Accepted proposals are automatically backtested on data the models have never seen. Only improvements that exceed a 5% Sharpe improvement threshold are deployed.
          </p>
          <p>
            The AI models cannot modify the core mathematical model. They can only adjust filters, position sizing, hold duration, and hedging rules. This creates genuine recursive self-improvement with hard empirical checks at every step.
          </p>
        </div>
      </section>

      {/* Hedged Strategy */}
      <section className="mb-12">
        <h2 className="text-sm font-mono font-bold text-white/80 mb-3">Market-Neutral Hedging</h2>
        <div className="text-[12px] font-mono leading-relaxed text-white/40 space-y-3">
          <p>
            The system can pair opposite signals — a long on one coin with a short on another — to create market-neutral positions. The hedged return comes from relative price movement between the two coins, not from the market direction. This makes the strategy robust to market crashes and rallies alike.
          </p>
          <p>
            In backtesting across 33,000+ paired trades over 5 years, the hedged Sharpe ratio (1.25) significantly exceeds the unhedged ratio (0.08). This confirms the model&apos;s edge comes from relative pricing, not directional bets — a fundamentally more robust signal.
          </p>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* Research Documents — Dynamic + Upload                      */}
      {/* ═══════════════════════════════════════════════════════════ */}
      <section className="mb-12">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-mono font-bold text-white/80">Research Documents</h2>
          <div className="flex gap-2">
            <button
              onClick={() => { setShowNote(!showNote); setShowUpload(false); }}
              className="text-[10px] font-mono px-3 py-1.5 rounded transition-all hover:brightness-125"
              style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              + Add Note
            </button>
            <button
              onClick={() => { setShowUpload(!showUpload); setShowNote(false); }}
              className="text-[10px] font-mono px-3 py-1.5 rounded transition-all hover:brightness-125"
              style={{ background: "rgba(212,168,67,0.15)", color: GOLD, border: `1px solid ${GOLD}33` }}
            >
              + Upload File
            </button>
          </div>
        </div>

        <div className="text-[12px] font-mono leading-relaxed text-white/40 space-y-2 mb-4">
          <p>Published research, policy changes, and analytical reports from the FRACMAP quantitative team.</p>
        </div>

        {/* ── Upload file form ── */}
        {showUpload && (
          <div className="mb-6 p-4 rounded-xl space-y-3" style={{ background: "rgba(212,168,67,0.05)", border: `1px solid ${GOLD}22` }}>
            <div className="text-[10px] font-mono font-bold uppercase tracking-widest" style={{ color: GOLD }}>Upload Document</div>
            <input
              type="text" placeholder="Title *" value={uploadTitle}
              onChange={e => setUploadTitle(e.target.value)}
              className="w-full bg-transparent text-[12px] font-mono text-white/80 px-3 py-2 rounded outline-none"
              style={{ border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <textarea
              placeholder="Description (optional)" value={uploadDesc}
              onChange={e => setUploadDesc(e.target.value)} rows={2}
              className="w-full bg-transparent text-[12px] font-mono text-white/40 px-3 py-2 rounded outline-none resize-none"
              style={{ border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <input
              type="text" placeholder="Tags (comma-separated, e.g. filters, 1M, hurst)" value={uploadTags}
              onChange={e => setUploadTags(e.target.value)}
              className="w-full bg-transparent text-[10px] font-mono text-white/40 px-3 py-2 rounded outline-none"
              style={{ border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <div className="flex items-center gap-3">
              <input
                ref={fileInputRef} type="file"
                accept=".docx,.pdf,.md,.txt,.csv,.json"
                onChange={e => setUploadFile(e.target.files?.[0] || null)}
                className="text-[11px] font-mono text-white/50 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-[10px] file:font-mono file:font-bold file:cursor-pointer"
                style={{ }}
              />
              <button
                onClick={handleUpload}
                disabled={uploading || !uploadFile || !uploadTitle.trim()}
                className="text-[10px] font-mono font-bold px-4 py-1.5 rounded disabled:opacity-30 transition-all"
                style={{ background: GOLD, color: "#000" }}
              >
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </div>
          </div>
        )}

        {/* ── Add note form ── */}
        {showNote && (
          <div className="mb-6 p-4 rounded-xl space-y-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-white/50">Add Research Note</div>
            <input
              type="text" placeholder="Title *" value={noteTitle}
              onChange={e => setNoteTitle(e.target.value)}
              className="w-full bg-transparent text-[12px] font-mono text-white/80 px-3 py-2 rounded outline-none"
              style={{ border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <input
              type="text" placeholder="Short description (optional)" value={noteDesc}
              onChange={e => setNoteDesc(e.target.value)}
              className="w-full bg-transparent text-[11px] font-mono text-white/40 px-3 py-2 rounded outline-none"
              style={{ border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <textarea
              placeholder="Content / notes / decision rationale..." value={noteContent}
              onChange={e => setNoteContent(e.target.value)} rows={6}
              className="w-full bg-transparent text-[12px] font-mono text-white/50 px-3 py-2 rounded outline-none resize-none leading-relaxed"
              style={{ border: "1px solid rgba(255,255,255,0.1)" }}
            />
            <div className="flex items-center gap-3">
              <input
                type="text" placeholder="Tags (comma-separated)" value={noteTags}
                onChange={e => setNoteTags(e.target.value)}
                className="flex-1 bg-transparent text-[10px] font-mono text-white/40 px-3 py-2 rounded outline-none"
                style={{ border: "1px solid rgba(255,255,255,0.1)" }}
              />
              <button
                onClick={handleSaveNote}
                disabled={savingNote || !noteTitle.trim()}
                className="text-[10px] font-mono font-bold px-4 py-1.5 rounded disabled:opacity-30 transition-all"
                style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}
              >
                {savingNote ? "Saving..." : "Save Note"}
              </button>
            </div>
          </div>
        )}

        {/* ── Document list ── */}
        <div className="space-y-2">
          {/* Dynamic documents from DB */}
          {documents.map(doc => {
            const bc = badgeColor(doc.doc_type);
            const isNote = doc.doc_type === "note";
            const isExpanded = expandedNote === doc.id;

            return (
              <div key={doc.id}>
                <div
                  className="block p-3 rounded-lg transition-all hover:brightness-125"
                  style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", cursor: isNote ? "pointer" : "default" }}
                  onClick={() => isNote && setExpandedNote(isExpanded ? null : doc.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] font-mono text-white/40 mr-3">{fmtDate(doc.created_at)}</span>
                      {isNote ? (
                        <span className="text-[12px] font-mono font-bold text-white/80">{doc.title}</span>
                      ) : (
                        <a href={doc.file_path || "#"} download className="text-[12px] font-mono font-bold text-white/80 hover:underline">
                          {doc.title}
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                      {doc.file_size ? (
                        <span className="text-[9px] font-mono text-white/30">{fmtSize(doc.file_size)}</span>
                      ) : null}
                      <span className="text-[9px] font-mono px-2 py-0.5 rounded uppercase" style={{ background: bc.bg, color: bc.fg }}>
                        {doc.doc_type}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(doc.id); }}
                        className="text-[9px] font-mono text-white/20 hover:text-red-400 transition-colors px-1"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  {doc.description && (
                    <div className="text-[10px] font-mono text-white/40 mt-1 ml-[70px]">{doc.description}</div>
                  )}
                  {doc.tags && doc.tags.length > 0 && (
                    <div className="flex gap-1.5 mt-1.5 ml-[70px]">
                      {doc.tags.map(tag => (
                        <span key={tag} className="text-[8px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.4)" }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {/* Expanded note content */}
                {isNote && isExpanded && doc.content && (
                  <div className="ml-[70px] mr-3 mt-1 mb-2 p-3 rounded-lg text-[11px] font-mono text-white/50 leading-relaxed whitespace-pre-wrap"
                       style={{ background: "rgba(255,255,255,0.02)", borderLeft: `2px solid ${GOLD}33` }}>
                    {doc.content}
                  </div>
                )}
              </div>
            );
          })}

          {/* Legacy hardcoded doc (fallback if DB is empty) */}
          {documents.length === 0 && LEGACY_DOCS.map(doc => (
            <a key={doc.file} href={doc.file} download className="block p-3 rounded-lg transition-all hover:brightness-125" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-mono text-white/40 mr-3">{doc.date}</span>
                  <span className="text-[12px] font-mono font-bold text-white/80">{doc.title}</span>
                </div>
                <span className="text-[9px] font-mono px-2 py-0.5 rounded" style={{ background: "rgba(212,168,67,0.15)", color: GOLD }}>DOCX</span>
              </div>
              <div className="text-[10px] font-mono text-white/40 mt-1 ml-[70px]">{doc.desc}</div>
            </a>
          ))}

          {loading && (
            <div className="text-[11px] font-mono text-white/30 py-4 text-center">Loading documents...</div>
          )}
        </div>
      </section>

      {/* Limitations */}
      <section className="mb-12">
        <h2 className="text-sm font-mono font-bold text-white/80 mb-3">Limitations & Risks</h2>
        <div className="text-[12px] font-mono leading-relaxed text-white/40 space-y-3">
          <p>
            Past performance does not guarantee future results. The model may encounter market conditions it has never seen. Cryptocurrency markets can experience extreme volatility, flash crashes, and liquidity gaps that are not reflected in historical data.
          </p>
          <p>
            The average return per trade is small (approximately 0.04%). The edge comes from consistency across thousands of trades. Individual trades will frequently lose. The win rate is approximately 51-52% — barely above a coin flip. The value is in the positive skew of returns: winners are larger than losers.
          </p>
          <p>
            Signals are informational only and do not constitute financial advice. Users should not risk capital they cannot afford to lose.
          </p>
        </div>
      </section>

      <div className="text-center pt-6 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
        <Link href="/signals" className="px-6 py-3 rounded-lg text-sm font-mono font-bold inline-block" style={{ background: GOLD, color: "#000" }}>
          View Live Signals
        </Link>
      </div>
    </div>
  );
}
