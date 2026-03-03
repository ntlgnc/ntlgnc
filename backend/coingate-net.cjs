const http = require('http');
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}
(async () => {
  const d = await fetchJson('http://localhost:3000/api/board/filter-audit?action=coin-gate&hours=168');

  let totalBlocked = 0;
  let totalCF = 0;
  let helping = 0;
  let hurting = 0;

  for (const c of d.coins) {
    totalBlocked += c.signals_blocked;
    totalCF += c.counterfactual.total_return;
    if (c.counterfactual.total_return < 0) helping++;
    else if (c.counterfactual.total_return > 0) hurting++;
  }

  console.log('COIN GATE — NET IMPACT (7d)');
  console.log('  Coins gated: ' + d.coins.length);
  console.log('  Signals blocked: ' + totalBlocked);
  console.log('  Net counterfactual: ' + (totalCF >= 0 ? '+' : '') + totalCF.toFixed(2) + '%');
  console.log('  Verdict: ' + (totalCF < 0 ? 'NET HELPING (blocked losers)' : 'NET HURTING (blocked winners)'));
  console.log('');
  console.log('  Coins where gate helped: ' + helping);
  console.log('  Coins where gate hurt:   ' + hurting);
  console.log('');
  console.log('  The blocked signals would have EARNED ' + totalCF.toFixed(2) + '% if allowed through.');
})();
