const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Replace the trade row layout — fix 3 issues:
// 1. More visible LIVE badge (colored background)
// 2. Show timeframe (1m/1h/1d) badge
// 3. Even column spacing (use grid instead of flex with flex-1 gap)

const oldRow = `                <div className="rounded-xl p-3 flex items-center gap-4 flex-wrap cursor-pointer hover:brightness-110 transition-all" style={{ background: "rgba(255,255,255,0.02)", border: \`1px solid \${borderColor}\` }} onClick={() => setExpandedPairId(expandedPairId === p.pair_id ? null : p.pair_id)}>
                  {/* Leg A */}
                  <div className="flex items-center gap-2 min-w-[140px]">
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{
                      background: p.legA.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      color: p.legA.direction === "LONG" ? GREEN : RED,
                    }}>{p.legA.direction[0]}</span>
                    <span className="text-[12px] font-mono font-bold text-white">{p.legA.symbol?.replace("USDT", "")}</span>
                    {p.legA.returnPct != null && (
                      <span className="text-[10px] font-mono tabular-nums" style={{ color: p.legA.returnPct > 0 ? GREEN : RED }}>
                        {p.legA.returnPct > 0 ? "+" : ""}{(+p.legA.returnPct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  {/* Arrow */}
                  <span className="text-[10px] font-mono" style={{ color: GOLD }}>+</span>
                  {/* Leg B */}
                  <div className="flex items-center gap-2 min-w-[140px]">
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{
                      background: p.legB.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      color: p.legB.direction === "LONG" ? GREEN : RED,
                    }}>{p.legB.direction[0]}</span>
                    <span className="text-[12px] font-mono font-bold text-white">{p.legB.symbol?.replace("USDT", "")}</span>
                    {p.legB.returnPct != null && (
                      <span className="text-[10px] font-mono tabular-nums" style={{ color: p.legB.returnPct > 0 ? GREEN : RED }}>
                        {p.legB.returnPct > 0 ? "+" : ""}{(+p.legB.returnPct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  {/* Pair return */}
                  <div className="flex-1" />
                  <div className="text-right">
                    <div className="text-[16px] font-mono font-black tabular-nums" style={{
                      color: pairRet != null ? (pairRet > 0 ? GREEN : pairRet < 0 ? RED : "rgba(255,255,255,0.5)") : "rgba(255,255,255,0.3)"
                    }}>
                      {pairRet != null ? \`\${pairRet > 0 ? "+" : ""}\${(+pairRet).toFixed(2)}%\` : "—"}
                    </div>
                    <div className="text-[9px] font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>
                      {new Date(p.legA.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      {isClosed && p.legA.closedAt && (<> → {new Date(p.legA.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>)}
                      {!isClosed && <span style={{ color: GREEN }}> · live</span>}
                    </div>
                  </div>
                  <span className="text-[10px] ml-1 transition-transform" style={{ color: "rgba(255,255,255,0.2)", display: "inline-block", transform: expandedPairId === p.pair_id ? "rotate(180deg)" : "none" }}>▾</span>
                </div>`;

const newRow = `                <div className="rounded-xl p-3 cursor-pointer hover:brightness-110 transition-all" style={{ background: "rgba(255,255,255,0.02)", border: \`1px solid \${borderColor}\`, display: "grid", gridTemplateColumns: "minmax(130px,1fr) 16px minmax(130px,1fr) 50px minmax(80px,auto) 14px", alignItems: "center", gap: "8px" }} onClick={() => setExpandedPairId(expandedPairId === p.pair_id ? null : p.pair_id)}>
                  {/* Leg A */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{
                      background: p.legA.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      color: p.legA.direction === "LONG" ? GREEN : RED,
                    }}>{p.legA.direction[0]}</span>
                    <span className="text-[12px] font-mono font-bold text-white">{p.legA.symbol?.replace("USDT", "")}</span>
                    {p.legA.returnPct != null && (
                      <span className="text-[10px] font-mono tabular-nums" style={{ color: p.legA.returnPct > 0 ? GREEN : RED }}>
                        {p.legA.returnPct > 0 ? "+" : ""}{(+p.legA.returnPct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  {/* Arrow */}
                  <span className="text-[10px] font-mono text-center" style={{ color: GOLD }}>+</span>
                  {/* Leg B */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{
                      background: p.legB.direction === "LONG" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                      color: p.legB.direction === "LONG" ? GREEN : RED,
                    }}>{p.legB.direction[0]}</span>
                    <span className="text-[12px] font-mono font-bold text-white">{p.legB.symbol?.replace("USDT", "")}</span>
                    {p.legB.returnPct != null && (
                      <span className="text-[10px] font-mono tabular-nums" style={{ color: p.legB.returnPct > 0 ? GREEN : RED }}>
                        {p.legB.returnPct > 0 ? "+" : ""}{(+p.legB.returnPct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  {/* Timeframe + Status badge */}
                  <div className="flex flex-col items-center gap-1">
                    {(() => {
                      const bm = p.legA?.barMinutes || p.legB?.barMinutes || 1;
                      const tfLabel = bm >= 1440 ? "1d" : bm >= 60 ? "1h" : "1m";
                      const tfColor = bm >= 1440 ? GOLD : bm >= 60 ? "#a78bfa" : "#3b82f6";
                      return <span className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ background: \`\${tfColor}15\`, color: tfColor }}>{tfLabel}</span>;
                    })()}
                    {!isClosed && <span className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded animate-pulse" style={{ background: "rgba(34,197,94,0.15)", color: GREEN }}>LIVE</span>}
                  </div>
                  {/* Pair return + dates */}
                  <div className="text-right">
                    <div className="text-[16px] font-mono font-black tabular-nums" style={{
                      color: pairRet != null ? (pairRet > 0 ? GREEN : pairRet < 0 ? RED : "rgba(255,255,255,0.5)") : "rgba(255,255,255,0.3)"
                    }}>
                      {pairRet != null ? \`\${pairRet > 0 ? "+" : ""}\${(+pairRet).toFixed(2)}%\` : "—"}
                    </div>
                    <div className="text-[9px] font-mono" style={{ color: "rgba(255,255,255,0.3)" }}>
                      {new Date(p.legA.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      {isClosed && p.legA.closedAt && (<> → {new Date(p.legA.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>)}
                    </div>
                  </div>
                  <span className="text-[10px] transition-transform" style={{ color: "rgba(255,255,255,0.2)", display: "inline-block", transform: expandedPairId === p.pair_id ? "rotate(180deg)" : "none" }}>▾</span>
                </div>`;

if (code.includes(oldRow)) {
  code = code.replace(oldRow, newRow);
  console.log('Fixed trade row: grid layout, TF badge, prominent LIVE badge');
} else {
  console.log('ERROR: Could not find trade row pattern');
  process.exit(1);
}

fs.writeFileSync(path, code);
console.log('Done');
