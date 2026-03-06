const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// The per-TF row calculates ret as d.cumReturn, but that's closed-only
// Need to add d.openPnL to include open position PnL
const old = `const ret = d.cumReturn || 0;`;
const rep = `const ret = (d.cumReturn || 0) + (d.openPnL || 0);`;

if (code.includes(old)) {
  code = code.replace(old, rep);
  console.log('Fixed: homepage per-TF return now includes open PnL');
} else {
  console.log('ERROR: Could not find per-TF return line');
}

fs.writeFileSync(path, code);
console.log('Done');
