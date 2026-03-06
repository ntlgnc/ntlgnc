const fs = require('fs');

// Fix 1: Add active strategy filter to homepage hedged-stats API
const apiPath = '/opt/ntlgnc/frontend/app/api/signals/route.ts';
let api = fs.readFileSync(apiPath, 'utf8');

// The hedged-stats closed pairs query is missing the active filter
const oldClosedQuery = `WHERE s.pair_id IS NOT NULL AND s.pair_return IS NOT NULL
            AND s.status = 'closed' AND s."closedAt" > NOW() - INTERVAL '\${interval}'`;
const newClosedQuery = `WHERE s.pair_id IS NOT NULL AND s.pair_return IS NOT NULL
            AND s.status = 'closed' AND s."closedAt" > NOW() - INTERVAL '\${interval}'
            AND (st.active = true OR s."strategyId" IS NULL)`;

if (api.includes(oldClosedQuery)) {
  api = api.replace(oldClosedQuery, newClosedQuery);
  console.log('Fixed: added active filter to hedged-stats closed query');
} else {
  console.log('ERROR: Could not find closed query pattern');
}

// The hedged-stats open pairs query is also missing the active filter
const oldOpenQuery = `WHERE s.pair_id IS NOT NULL AND s.status = 'open'
      \`);`;
const newOpenQuery = `WHERE s.pair_id IS NOT NULL AND s.status = 'open'
            AND (st.active = true OR s."strategyId" IS NULL)
      \`);`;

// There are two open queries (openRows and openPairDetails), fix both
let openFixCount = 0;
while (api.includes(oldOpenQuery)) {
  api = api.replace(oldOpenQuery, newOpenQuery);
  openFixCount++;
}
console.log(`Fixed: added active filter to ${openFixCount} open pair queries`);

fs.writeFileSync(apiPath, api);

// Fix 2: Shorten "1 Hour" to "1 Hr" on homepage to prevent wrapping
const pagePath = '/opt/ntlgnc/frontend/app/page.tsx';
let page = fs.readFileSync(pagePath, 'utf8');

const oldLabels = `{ key: "1m", label: "1 Min", color: "#3b82f6" },
                    { key: "1h", label: "1 Hour", color: "#a78bfa" },
                    { key: "1d", label: "1 Day", color: "#D4A843" },`;
const newLabels = `{ key: "1m", label: "1 Min", color: "#3b82f6" },
                    { key: "1h", label: "1 Hr", color: "#a78bfa" },
                    { key: "1d", label: "1 Day", color: "#D4A843" },`;

if (page.includes(oldLabels)) {
  page = page.replace(oldLabels, newLabels);
  console.log('Fixed: "1 Hour" -> "1 Hr" to prevent wrapping');
} else {
  console.log('ERROR: Could not find label pattern');
}

fs.writeFileSync(pagePath, page);
console.log('Done');
