const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Revert line color back to totalRet (the curve includes open PnL at the end)
code = code.replace(
  'const lineColor = closedRet >= 0 ? GREEN : RED;',
  'const lineColor = totalRet >= 0 ? GREEN : RED;'
);
console.log('Reverted lineColor to totalRet');
fs.writeFileSync(path, code);
