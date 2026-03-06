"use client";

import { useState, useEffect, useRef } from "react";

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

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " " + new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function fmtSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const typeBadge: Record<string, { bg: string; fg: string; label: string }> = {
  docx: { bg: "rgba(66,133,244,0.15)", fg: "#4285F4", label: "DOCX" },
  pdf: { bg: "rgba(234,67,53,0.15)", fg: "#EA4335", label: "PDF" },
  markdown: { bg: "rgba(212,168,67,0.15)", fg: GOLD, label: "MD" },
  text: { bg: "rgba(255,255,255,0.08)", fg: "#aaa", label: "TXT" },
  note: { bg: "rgba(139,92,246,0.15)", fg: "#a78bfa", label: "NOTE" },
  file: { bg: "rgba(255,255,255,0.08)", fg: "#aaa", label: "FILE" },
};

export default function ResearchDocs() {
  const [documents, setDocuments] = useState<ResearchDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"list" | "upload" | "note">("list");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Upload state
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadDesc, setUploadDesc] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Note state
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
      resetUpload();
      fetchDocs();
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }

  function resetUpload() {
    setUploadTitle(""); setUploadDesc(""); setUploadTags(""); setUploadFile(null);
    if (fileRef.current) fileRef.current.value = "";
    setMode("list");
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
          tags: noteTags ? noteTags.split(",").map((t: string) => t.trim()).filter(Boolean) : [],
        }),
      });
      const data = await res.json();
      if (data.error) { alert(`Save failed: ${data.error}`); return; }
      setNoteTitle(""); setNoteDesc(""); setNoteContent(""); setNoteTags("");
      setMode("list");
      fetchDocs();
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSavingNote(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this research document?")) return;
    try {
      await fetch(`/api/research-docs?id=${id}`, { method: "DELETE" });
      fetchDocs();
    } catch {}
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[13px] font-mono font-bold" style={{ color: GOLD }}>📎 RESEARCH DOCUMENTS</span>
        <span className="text-[9px] font-mono text-[var(--text-dim)]">
          Filter decisions, policy changes, and analysis notes · {documents.length} docs
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setMode(mode === "note" ? "list" : "note")}
          className="text-[9px] font-mono px-2.5 py-1 rounded transition-all"
          style={{
            background: mode === "note" ? "rgba(139,92,246,0.15)" : "transparent",
            color: mode === "note" ? "#a78bfa" : "var(--text-dim)",
            border: `1px solid ${mode === "note" ? "#a78bfa33" : "var(--border)"}`,
          }}
        >
          + Note
        </button>
        <button
          onClick={() => setMode(mode === "upload" ? "list" : "upload")}
          className="text-[9px] font-mono px-2.5 py-1 rounded transition-all"
          style={{
            background: mode === "upload" ? `${GOLD}18` : "transparent",
            color: mode === "upload" ? GOLD : "var(--text-dim)",
            border: `1px solid ${mode === "upload" ? GOLD + "33" : "var(--border)"}`,
          }}
        >
          + Upload File
        </button>
      </div>

      {/* ── Upload form ── */}
      {mode === "upload" && (
        <div className="mb-4 p-4 rounded-lg space-y-2.5" style={{ background: `${GOLD}08`, border: `1px solid ${GOLD}18` }}>
          <input
            type="text" placeholder="Title *" value={uploadTitle}
            onChange={e => setUploadTitle(e.target.value)}
            className="w-full bg-transparent text-[11px] font-mono text-[var(--text)] px-3 py-2 rounded outline-none"
            style={{ border: "1px solid var(--border)" }}
          />
          <textarea
            placeholder="Description — what decision does this document, why is it important?" value={uploadDesc}
            onChange={e => setUploadDesc(e.target.value)} rows={2}
            className="w-full bg-transparent text-[10px] font-mono text-[var(--text-dim)] px-3 py-2 rounded outline-none resize-none"
            style={{ border: "1px solid var(--border)" }}
          />
          <input
            type="text" placeholder="Tags (comma-separated, e.g. filters, 1M, hurst, coin-gate)" value={uploadTags}
            onChange={e => setUploadTags(e.target.value)}
            className="w-full bg-transparent text-[10px] font-mono text-[var(--text-dim)] px-3 py-1.5 rounded outline-none"
            style={{ border: "1px solid var(--border)" }}
          />
          <div className="flex items-center gap-3 pt-1">
            <input
              ref={fileRef} type="file"
              accept=".docx,.pdf,.md,.txt,.csv,.json,.xlsx"
              onChange={e => setUploadFile(e.target.files?.[0] || null)}
              className="text-[10px] font-mono text-[var(--text-dim)] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[9px] file:font-mono file:font-bold file:cursor-pointer"
            />
            <div className="flex-1" />
            <button onClick={resetUpload} className="text-[9px] font-mono text-[var(--text-dim)] px-3 py-1 rounded hover:text-white transition-colors">Cancel</button>
            <button
              onClick={handleUpload}
              disabled={uploading || !uploadFile || !uploadTitle.trim()}
              className="text-[9px] font-mono font-bold px-4 py-1.5 rounded disabled:opacity-30 transition-all"
              style={{ background: GOLD, color: "#000" }}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>
          </div>
        </div>
      )}

      {/* ── Note form ── */}
      {mode === "note" && (
        <div className="mb-4 p-4 rounded-lg space-y-2.5" style={{ background: "rgba(139,92,246,0.05)", border: "1px solid rgba(139,92,246,0.12)" }}>
          <input
            type="text" placeholder="Title *" value={noteTitle}
            onChange={e => setNoteTitle(e.target.value)}
            className="w-full bg-transparent text-[11px] font-mono text-[var(--text)] px-3 py-2 rounded outline-none"
            style={{ border: "1px solid var(--border)" }}
          />
          <input
            type="text" placeholder="Short description (optional)" value={noteDesc}
            onChange={e => setNoteDesc(e.target.value)}
            className="w-full bg-transparent text-[10px] font-mono text-[var(--text-dim)] px-3 py-1.5 rounded outline-none"
            style={{ border: "1px solid var(--border)" }}
          />
          <textarea
            placeholder="Content — decision rationale, filter parameters, analysis results, observations..."
            value={noteContent}
            onChange={e => setNoteContent(e.target.value)} rows={8}
            className="w-full bg-transparent text-[11px] font-mono text-[var(--text-dim)] px-3 py-2 rounded outline-none resize-none leading-relaxed"
            style={{ border: "1px solid var(--border)" }}
          />
          <div className="flex items-center gap-3 pt-1">
            <input
              type="text" placeholder="Tags (comma-separated)" value={noteTags}
              onChange={e => setNoteTags(e.target.value)}
              className="flex-1 bg-transparent text-[10px] font-mono text-[var(--text-dim)] px-3 py-1.5 rounded outline-none"
              style={{ border: "1px solid var(--border)" }}
            />
            <button onClick={() => setMode("list")} className="text-[9px] font-mono text-[var(--text-dim)] px-3 py-1 rounded hover:text-white transition-colors">Cancel</button>
            <button
              onClick={handleSaveNote}
              disabled={savingNote || !noteTitle.trim()}
              className="text-[9px] font-mono font-bold px-4 py-1.5 rounded disabled:opacity-30 transition-all"
              style={{ background: "rgba(139,92,246,0.25)", color: "#a78bfa" }}
            >
              {savingNote ? "Saving..." : "Save Note"}
            </button>
          </div>
        </div>
      )}

      {/* ── Document list ── */}
      {loading && <div className="text-[10px] font-mono text-[var(--text-dim)] py-8 text-center">Loading...</div>}

      {!loading && documents.length === 0 && (
        <div className="text-[10px] font-mono text-[var(--text-dim)] py-8 text-center">
          No research documents yet. Use &quot;+ Upload File&quot; to attach a document or &quot;+ Note&quot; to record a decision.
        </div>
      )}

      {!loading && documents.length > 0 && (
        <div className="space-y-1">
          {documents.map(doc => {
            const badge = typeBadge[doc.doc_type] || typeBadge.file;
            const isNote = doc.doc_type === "note";
            const isExpanded = expandedId === doc.id;

            return (
              <div key={doc.id}>
                <div
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all hover:brightness-125"
                  style={{
                    background: isExpanded ? "rgba(139,92,246,0.06)" : "rgba(255,255,255,0.015)",
                    border: isExpanded ? "1px solid rgba(139,92,246,0.15)" : "1px solid transparent",
                    cursor: isNote ? "pointer" : "default",
                  }}
                  onClick={() => isNote && setExpandedId(isExpanded ? null : doc.id)}
                >
                  {/* Date */}
                  <span className="text-[9px] font-mono text-[var(--text-dim)] w-[120px] flex-shrink-0">
                    {fmtDate(doc.created_at)}
                  </span>

                  {/* Badge */}
                  <span className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded flex-shrink-0"
                    style={{ background: badge.bg, color: badge.fg }}>
                    {badge.label}
                  </span>

                  {/* Title + description */}
                  <div className="flex-1 min-w-0">
                    {isNote ? (
                      <span className="text-[10px] font-mono font-semibold text-[var(--text)]">{doc.title}</span>
                    ) : (
                      <a href={doc.file_path || "#"} download
                        className="text-[10px] font-mono font-semibold text-[var(--text)] hover:underline"
                        onClick={e => e.stopPropagation()}>
                        {doc.title}
                      </a>
                    )}
                    {doc.description && (
                      <span className="text-[9px] font-mono text-[var(--text-dim)] ml-2">{doc.description}</span>
                    )}
                  </div>

                  {/* Tags */}
                  {doc.tags && doc.tags.length > 0 && (
                    <div className="flex gap-1 flex-shrink-0">
                      {doc.tags.map(tag => (
                        <span key={tag} className="text-[7px] font-mono px-1.5 py-0.5 rounded"
                          style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-dim)" }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Size */}
                  {doc.file_size ? (
                    <span className="text-[8px] font-mono text-[var(--text-dim)] flex-shrink-0 w-[45px] text-right">
                      {fmtSize(doc.file_size)}
                    </span>
                  ) : <span className="w-[45px] flex-shrink-0" />}

                  {/* Delete */}
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(doc.id); }}
                    className="text-[9px] font-mono text-[var(--text-dim)] hover:text-red-400 transition-colors px-1 flex-shrink-0 opacity-30 hover:opacity-100"
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>

                {/* Expanded note content */}
                {isNote && isExpanded && doc.content && (
                  <div className="ml-[132px] mr-10 mt-1 mb-2 p-3 rounded-lg text-[10px] font-mono text-[var(--text-dim)] leading-relaxed whitespace-pre-wrap"
                    style={{ background: "rgba(139,92,246,0.04)", borderLeft: "2px solid rgba(139,92,246,0.2)" }}>
                    {doc.content}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
