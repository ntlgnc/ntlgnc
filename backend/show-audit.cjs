// Quick display of filter audit data
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
  try {
    const summary = await fetchJson('http://localhost:3000/api/board/filter-audit?action=summary&hours=168');
    const matrix = await fetchJson('http://localhost:3000/api/board/filter-audit?action=matrix-locks&hours=168');
    const board = await fetchJson('http://localhost:3000/api/board/filter-audit?action=board-filters&hours=168');

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  FILTER AUDIT — ALL CARDS WITH RHO                          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    if (summary.by_system) {
      const s = summary;
      console.log('\n── SUMMARY ──');
      console.log('  Net Filter Value: ' + (s.net_filter_value >= 0 ? '+' : '') + s.net_filter_value.toFixed(2) + '%');
      console.log('  Board Filters: ' + s.by_system.board_filters.count + ' blocked');
      console.log('  Matrix Locks:  ' + s.by_system.filter_matrix.count + ' blocked');
      console.log('  Coin Gate:     ' + s.by_system.coin_gate.count + ' blocked');
    }

    // Board filters
    const boardList = Object.values(board).filter(f => f.filter_id);
    if (boardList.length > 0) {
      console.log('\n── BOARD FILTERS (' + boardList.length + ') ──');
      boardList.forEach(f => {
        const sc = f.scorecard;
        const rho = sc && sc.rho !== null ? 'ρ=' + sc.rho.toFixed(1) : 'NO RHO';
        console.log('  #' + f.filter_id + ' ' + f.feature + ' | ' + rho + ' | ' + f.verdict);
        console.log('     Cumulative: ' + (f.cumulative_inverted_return >= 0 ? '+' : '') + f.cumulative_inverted_return.toFixed(2) + '% | Evaluated: ' + f.evaluated);
      });
    }

    // Matrix locks
    if (matrix.cells && matrix.cells.length > 0) {
      console.log('\n── MATRIX LOCKS (' + matrix.cells.length + ') ──');
      matrix.cells.forEach(c => {
        const sc = c.scorecard;
        const rho = sc && sc.rho !== null ? 'ρ=' + sc.rho.toFixed(1) : 'NO RHO';
        const conf = sc ? sc.confidence || '?' : 'none';
        const sr = sc && sc.oos_sharpe !== null ? 'SR=' + sc.oos_sharpe.toFixed(1) : 'SR=?';
        const tf = c.bar_minutes >= 1440 ? '1d' : c.bar_minutes >= 60 ? '1h' : '1m';
        const trades = sc ? sc.oos_trades : 0;
        console.log('  ' + c.feature_key + ' ' + c.bucket_label + ' ' + c.direction + ' [' + tf + ']');
        console.log('     ' + rho + ' | ' + conf + ' | ' + sr + ' | ' + trades + ' scorecard trades');
        console.log('     Blocked: ' + c.signals_blocked + ' | CF Return: ' + c.counterfactual.total_return.toFixed(2) + '% | ' + c.verdict);
        console.log('');
      });
    }

  } catch (e) {
    console.error('Error:', e.message, '— is the dev server running on localhost:3000?');
  }
})();
