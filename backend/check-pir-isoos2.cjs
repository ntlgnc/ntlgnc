require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  console.log('=== PiR IS vs OOS — All timeframes ===\n');

  for (const bm of [1, 60, 1440]) {
    const tf = bm >= 1440 ? '1D' : bm >= 60 ? '1H' : '1m';
    const { rows } = await c.query(`
      SELECT bucket_label, bucket_index, direction_filter,
             is_sharpe, oos_sharpe, oos_win_rate, oos_trades, is_trades, rho, confidence
      FROM regime_scorecard
      WHERE bar_minutes = $1 AND feature_key = 'posInRange'
      ORDER BY direction_filter, bucket_index
    `, [bm]);

    if (rows.length === 0) { console.log(tf + ': no data\n'); continue; }

    console.log('═══ ' + tf + ' ═══\n');
    console.log('  Dir    | Bucket                | IS SR   | OOS SR  | OOS WR  | IS n   | OOS n  | Rho  | Conf');
    console.log('  ' + '-'.repeat(100));

    let lastDir = '';
    for (const r of rows) {
      if (r.direction_filter !== lastDir && lastDir) console.log('');
      lastDir = r.direction_filter;

      const mid = (r.bucket_label || '').includes('Middle') ? ' ◄ MID' : '';
      console.log('  ' + (r.direction_filter || '?').padEnd(7) +
        '| ' + (r.bucket_label || '?').padEnd(22) +
        '| ' + (r.is_sharpe != null ? (+r.is_sharpe).toFixed(2) : '?').padStart(7) +
        ' | ' + (r.oos_sharpe != null ? (+r.oos_sharpe).toFixed(2) : '?').padStart(7) +
        ' | ' + (r.oos_win_rate != null ? (+r.oos_win_rate).toFixed(1) + '%' : '?').padStart(7) +
        ' | ' + String(r.is_trades || 0).padStart(6) +
        ' | ' + String(r.oos_trades || 0).padStart(6) +
        ' | ' + (r.rho != null ? (+r.rho).toFixed(1) : '?').padStart(4) +
        ' | ' + (r.confidence || '?') + mid);
    }

    // Rank analysis
    const dirs = [...new Set(rows.map(r => r.direction_filter))];
    console.log('');
    for (const dir of dirs) {
      const dr = rows.filter(r => r.direction_filter === dir).sort((a, b) => (b.oos_sharpe || 0) - (a.oos_sharpe || 0));
      if (dr.length < 3) continue;

      const isRanked = [...dr].sort((a, b) => (b.is_sharpe || 0) - (a.is_sharpe || 0));
      const oosRanked = dr; // already sorted by oos

      console.log('  ' + dir + ' ranking:');
      console.log('    IS:  #1=' + isRanked[0].bucket_label + ' (' + (+isRanked[0].is_sharpe || 0).toFixed(2) + ')  #2=' + isRanked[1].bucket_label + '  #3=' + isRanked[2].bucket_label);
      console.log('    OOS: #1=' + oosRanked[0].bucket_label + ' (' + (+oosRanked[0].oos_sharpe || 0).toFixed(2) + ')  #2=' + oosRanked[1].bucket_label + '  #3=' + oosRanked[2].bucket_label);

      const midRow = dr.find(r => (r.bucket_label || '').includes('Middle'));
      if (midRow) {
        const isPos = isRanked.findIndex(r => r === midRow) + 1;
        const oosPos = oosRanked.findIndex(r => r === midRow) + 1;
        const stable = isPos === oosPos;
        console.log('    Middle: IS=#' + isPos + ' OOS=#' + oosPos + (stable ? ' ✓ STABLE' : ' ✗ shifted'));
      }
    }
    console.log('\n');
  }

  c.release(); pool.end();
})();
