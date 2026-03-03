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
  console.log('COIN GATE BLOCKS (' + d.coins.length + ' coins):\n');
  d.coins.sort((a, b) => b.signals_blocked - a.signals_blocked);
  for (const c of d.coins) {
    const tf = c.bar_minutes >= 1440 ? '1d' : c.bar_minutes >= 60 ? '1h' : '1m';
    const wr = c.recent_win_rate != null ? c.recent_win_rate + '%' : 'N/A';
    console.log(
      '  ' + c.symbol.padEnd(14) + ' [' + tf + ']' +
      ' WR=' + wr.padEnd(8) +
      ' blocked=' + String(c.signals_blocked).padEnd(4) +
      ' CF=' + c.counterfactual.total_return.toFixed(2).padStart(8) + '%' +
      ' | ' + c.verdict
    );
  }

  console.log('\n── HOW COIN GATE WORKS ──');
  console.log('Coin quality gate (backend/coin-quality-gate.cjs):');
  console.log('  Looks at last 25 closed trades per coin per strategy');
  console.log('  Blocks if trailing win rate < 35%');
  console.log('  Minimum 10 trades before gating activates');
  console.log('  NOT set by LLM board — purely algorithmic');
})();
