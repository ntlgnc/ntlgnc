// Compare homepage and signals page data side by side
const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  // Homepage API
  const hp = await fetchJson('http://localhost:3000/api/signals?action=hedged-stats&period=24h');

  // Signals page API (ALL data, same as what the page fetches)
  const sp = await fetchJson('http://localhost:3000/api/signals?action=hedged-pairs&timeframe=ALL');

  // Simulate signals page 1D filtering
  const cutoff = Date.now() - 86400_000;
  const allPairs = sp.pairs || [];

  // Group by TF
  const getPairTf = (p) => {
    const bm = p.legA?.barMinutes || p.legB?.barMinutes;
    if (bm && bm >= 1440) return "1d";
    if (bm && bm >= 60) return "1h";
    return "1m";
  };

  // Filter by closedAt (1D window) — same as signals page equity cards
  const windowPairs = allPairs.filter(p => {
    if (p.status === "open") return true;
    const closedAt = new Date(p.legA?.closedAt || p.legB?.closedAt || p.legA?.createdAt || 0).getTime();
    return closedAt >= cutoff;
  });

  const byTf = { "1m": [], "1h": [], "1d": [] };
  const openByTf = { "1m": [], "1h": [], "1d": [] };
  for (const p of windowPairs) {
    const tf = getPairTf(p);
    if (p.status === "closed" && p.pair_return != null) {
      byTf[tf].push(+p.pair_return);
    } else if (p.status === "open") {
      openByTf[tf].push(p);
    }
  }

  console.log('=== COMPARISON (24h / 1D window) ===\n');

  for (const tf of ["1m", "1h", "1d"]) {
    const hpTf = hp.byTimeframe[tf];
    const spClosed = byTf[tf];
    const spOpen = openByTf[tf];
    const spClosedRet = spClosed.reduce((s, r) => s + r, 0);

    console.log(`--- ${tf} ---`);
    console.log(`  Homepage:  ${hpTf.pairs} closed, cumReturn=${hpTf.cumReturn}, open=${hpTf.open}, openPnL=${hpTf.openPnL}`);
    console.log(`  Signals:   ${spClosed.length} closed, cumReturn=${spClosedRet.toFixed(3)}, open=${spOpen.length}`);
    if (hpTf.pairs !== spClosed.length) console.log(`  ** MISMATCH: ${hpTf.pairs} vs ${spClosed.length} closed pairs`);
  }

  console.log(`\n--- TOTAL ---`);
  console.log(`  Homepage:  ${hp.hedgedStats.closedPairs} closed, closedRet=${hp.hedgedStats.closedReturn}, openPnL=${hp.hedgedStats.openPnL}, total=${hp.hedgedStats.cumReturn}`);
  const spTotalClosed = Object.values(byTf).flat().reduce((s, r) => s + r, 0);
  const spTotalClosedCount = Object.values(byTf).flat().length;
  const spTotalOpen = Object.values(openByTf).flat().length;
  console.log(`  Signals:   ${spTotalClosedCount} closed, closedRet=${spTotalClosed.toFixed(3)}, open=${spTotalOpen}`);
})();
