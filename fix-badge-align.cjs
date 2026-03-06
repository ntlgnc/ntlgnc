const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

const oldBadge = `                  {/* Timeframe badge (green-tinted if live) */}
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

const newBadge = `                  {/* Timeframe badge — green bg if live, normal if closed */}
                  <div className="flex items-center justify-center">
                    {(() => {
                      const bm = p.legA?.barMinutes || p.legB?.barMinutes || 1;
                      const tfLabel = bm >= 1440 ? "1d" : bm >= 60 ? "1h" : "1m";
                      const tfColor = bm >= 1440 ? GOLD : bm >= 60 ? "#a78bfa" : "#3b82f6";
                      const bg = !isClosed ? "rgba(34,197,94,0.15)" : \`\${tfColor}15\`;
                      const fg = !isClosed ? GREEN : tfColor;
                      return <span className="text-[8px] font-mono font-bold px-2 py-0.5 rounded text-center" style={{ background: bg, color: fg, minWidth: 28 }}>{tfLabel}</span>;
                    })()}
                  </div>`;

if (code.includes(oldBadge)) {
  code = code.replace(oldBadge, newBadge);
  console.log('Fixed: uniform badge width, color-only distinction for live');
} else {
  console.log('ERROR: pattern not found');
  process.exit(1);
}

fs.writeFileSync(path, code);
console.log('Done');
