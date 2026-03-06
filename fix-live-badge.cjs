const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Replace the TF + LIVE badge column with a single combined badge
const oldBadge = `                  {/* Timeframe + Status badge */}
                  <div className="flex flex-col items-center gap-1">
                    {(() => {
                      const bm = p.legA?.barMinutes || p.legB?.barMinutes || 1;
                      const tfLabel = bm >= 1440 ? "1d" : bm >= 60 ? "1h" : "1m";
                      const tfColor = bm >= 1440 ? GOLD : bm >= 60 ? "#a78bfa" : "#3b82f6";
                      return <span className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ background: \`\${tfColor}15\`, color: tfColor }}>{tfLabel}</span>;
                    })()}
                    {!isClosed && <span className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded animate-pulse" style={{ background: "rgba(34,197,94,0.15)", color: GREEN }}>LIVE</span>}
                  </div>`;

const newBadge = `                  {/* Timeframe badge (green-tinted if live) */}
                  <div className="flex items-center justify-center">
                    {(() => {
                      const bm = p.legA?.barMinutes || p.legB?.barMinutes || 1;
                      const tfLabel = bm >= 1440 ? "1d" : bm >= 60 ? "1h" : "1m";
                      const tfColor = bm >= 1440 ? GOLD : bm >= 60 ? "#a78bfa" : "#3b82f6";
                      if (!isClosed) {
                        return <span className="inline-flex items-center gap-1 text-[8px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ background: "rgba(34,197,94,0.12)", color: GREEN, border: "1px solid rgba(34,197,94,0.25)" }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} />{tfLabel}
                        </span>;
                      }
                      return <span className="text-[8px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ background: \`\${tfColor}15\`, color: tfColor }}>{tfLabel}</span>;
                    })()}
                  </div>`;

if (code.includes(oldBadge)) {
  code = code.replace(oldBadge, newBadge);
  console.log('Fixed: merged LIVE into TF badge, no animation, no wrapping');
} else {
  console.log('ERROR: Could not find badge pattern');
  process.exit(1);
}

fs.writeFileSync(path, code);
console.log('Done');
