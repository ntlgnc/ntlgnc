const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Replace the hover conditional in the right panel with always-show label,
// and move hover info to an overlay on the chart area

// 1. Replace the right panel header (hover conditional) with always-show label
const oldHeader = `          {hoverIdx !== null && hoverVal !== null ? (
            <div className="mb-2.5">
              <div className="text-[9px] font-mono text-white/50">{hoverDate}</div>
              <div className="text-[14px] font-mono font-black tabular-nums" style={{ color: hoverVal >= 0 ? GREEN : RED }}>
                {hoverVal >= 0 ? "+" : ""}{hoverVal.toFixed(2)}%
              </div>
              <div className="text-[8px] font-mono text-white/40">pair #{(hoverIdx + 1)}/{cumData.length}</div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 mb-2.5">
              <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold" style={{ background: \`\${color}15\`, color }}>{label}</span>
              <span className="text-[10px] font-mono text-white/80">Hedged</span>
            </div>
          )}`;

const newHeader = `          <div className="flex items-center gap-1.5 mb-2.5">
              <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold" style={{ background: \`\${color}15\`, color }}>{label}</span>
              <span className="text-[10px] font-mono text-white/80">Hedged</span>
            </div>`;

if (code.includes(oldHeader)) {
  code = code.replace(oldHeader, newHeader);
  console.log('Step 1: Removed hover conditional from header');
} else {
  console.log('ERROR: Could not find header pattern');
  process.exit(1);
}

// 2. Add hover tooltip overlay to the chart area (inside the chart container)
// The chart is wrapped in a flex-1 div. We need to make it position:relative
// and add an absolutely positioned tooltip.
const oldChartWrap = `        <div className="flex-1 p-3 pr-0 flex items-stretch">
          {cumData.length >= 2 ? (
            <svg ref={svgRef}`;

const newChartWrap = `        <div className="flex-1 p-3 pr-0 flex items-stretch" style={{ position: "relative" }}>
          {hoverIdx !== null && hoverVal !== null && (
            <div style={{ position: "absolute", top: 6, left: 12, zIndex: 10, pointerEvents: "none", background: "rgba(0,0,0,0.75)", borderRadius: 4, padding: "3px 6px", border: "1px solid rgba(255,255,255,0.1)" }}>
              <div className="text-[8px] font-mono text-white/60">{hoverDate}</div>
              <div className="text-[12px] font-mono font-black tabular-nums" style={{ color: hoverVal >= 0 ? GREEN : RED }}>
                {hoverVal >= 0 ? "+" : ""}{hoverVal.toFixed(2)}%
              </div>
              <div className="text-[7px] font-mono text-white/40">pair {(hoverIdx + 1)}/{cumData.length}</div>
            </div>
          )}
          {cumData.length >= 2 ? (
            <svg ref={svgRef}`;

if (code.includes(oldChartWrap)) {
  code = code.replace(oldChartWrap, newChartWrap);
  console.log('Step 2: Added hover overlay to chart area');
} else {
  console.log('ERROR: Could not find chart wrap pattern');
  process.exit(1);
}

fs.writeFileSync(path, code);
console.log('Done');
