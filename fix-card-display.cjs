// Fix: show closed-only return next to "closed N" and open-only return next to "open N"
// Currently totalRet (closed+open) is shown next to "closed" which is misleading

const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Find the display block that shows closed count + totalRet
// Current pattern: closed {closedPairs.length} {totalRet}
// Fix: closed {closedPairs.length} {closedRet}

// The block looks like:
// <span>closed</span><span>{closedPairs.length}</span>
// <span style={{ color: totalRet >= 0 ? GREEN : RED }}>{totalRet >= 0 ? "+" : ""}{totalRet.toFixed(2)}%</span>

const oldClosed = `<span className="text-[14px] font-mono font-black tabular-nums leading-tight ml-auto" style={{ color: totalRet >= 0 ? GREEN : RED }}>{totalRet >= 0 ? "+" : ""}{totalRet.toFixed(2)}%</span>`;
const newClosed = `<span className="text-[14px] font-mono font-black tabular-nums leading-tight ml-auto" style={{ color: closedRet >= 0 ? GREEN : RED }}>{closedRet >= 0 ? "+" : ""}{closedRet.toFixed(2)}%</span>`;

if (code.includes(oldClosed)) {
  code = code.replace(oldClosed, newClosed);
  console.log('Fixed: closed return now shows closedRet instead of totalRet');
} else {
  console.log('Could not find closed return display pattern');
  // Try to find what's there
  const idx = code.indexOf('totalRet.toFixed(2)');
  if (idx > 0) {
    console.log('Context around totalRet.toFixed(2):', code.substring(idx - 200, idx + 100));
  }
}

fs.writeFileSync(path, code);
console.log('Done');
