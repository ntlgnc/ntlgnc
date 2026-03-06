const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

const old = `{isClosed && p.legA.closedAt && (<> → {new Date(p.legA.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>)}
                    </div>`;

const rep = `{isClosed && p.legA.closedAt && (<> → {new Date(p.legA.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>)}
                      {!isClosed && <span style={{ color: GREEN, fontWeight: 700 }}> · LIVE</span>}
                    </div>`;

if (code.includes(old)) {
  code = code.replace(old, rep);
  console.log('Added LIVE text to date line');
} else {
  console.log('ERROR: pattern not found');
  process.exit(1);
}

fs.writeFileSync(path, code);
