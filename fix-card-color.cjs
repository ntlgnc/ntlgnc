const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Fix line color to use closedRet (the curve only shows closed trades)
const old = 'const lineColor = totalRet >= 0 ? GREEN : RED;';
const rep = 'const lineColor = closedRet >= 0 ? GREEN : RED;';

if (code.includes(old)) {
  code = code.replace(old, rep);
  console.log('Fixed: lineColor now uses closedRet');
} else {
  console.log('Pattern not found');
}

fs.writeFileSync(path, code);
