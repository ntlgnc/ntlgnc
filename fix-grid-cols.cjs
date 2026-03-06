const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Fix the grid template — distribute space evenly across all columns
const old = `style={{ background: "rgba(255,255,255,0.02)", border: \`1px solid \${borderColor}\`, display: "grid", gridTemplateColumns: "minmax(130px,1fr) 16px minmax(130px,1fr) 50px minmax(80px,auto) 14px", alignItems: "center", gap: "8px" }}`;

const rep = `style={{ background: "rgba(255,255,255,0.02)", border: \`1px solid \${borderColor}\`, display: "grid", gridTemplateColumns: "2fr 12px 2fr 36px 1fr 12px", alignItems: "center", gap: "4px" }}`;

if (code.includes(old)) {
  code = code.replace(old, rep);
  console.log('Fixed: grid columns now 2fr 12px 2fr 36px 1fr 12px');
} else {
  console.log('ERROR: Could not find grid template');
  process.exit(1);
}

fs.writeFileSync(path, code);
console.log('Done');
