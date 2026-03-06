require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  console.log('=== PiR SCORECARD — IS vs OOS per bucket (all timeframes) ===\n');

  for (const bm of [1, 60, 1440]) {
    const tf = bm >= 1440 ? '1D' : bm >= 60 ? '1H' : '1m';
    const { rows } = await c.query(`
      SELECT feature_key, bucket_label, bucket_index, direction_filter,
             oos_sharpe, is_sharpe, oos_win_rate, oos_trades, rho, confidence
      FROM regime_scorecard
      WHERE bar_minutes = $1 AND feature_key = 'posInRange60'
      ORDER BY direction_filter, bucket_index
    `, [bm]);

    if (rows.length === 0) continue;

    console.log('═══ ' + tf + ' ═══\n');
    console.log('  Dir    | Bucket                | IS SR   | OOS SR  | OOS WR  | Trades | Rho  | Conf');
    console.log('  ' + '-'.repeat(90));

    let lastDir = '';
    for (const r of rows) {
      if (r.direction_filter !== lastDir) {
        if (lastDir) console.log('');
        lastDir = r.direction_filter;
      }
      const isSR = r.is_sharpe != null ? (+r.is_sharpe).toFixed(2) : '?';
      const oosSR = r.oos_sharpe != null ? (+r.oos_sharpe).toFixed(2) : '?';
      const oosWR = r.oos_win_rate != null ? (+r.oos_win_rate).toFixed(1) : '?';
      const rho = r.rho != null ? (+r.rho).toFixed(1) : '?';

      // Highlight if middle bucket
      const isMiddle = r.bucket_label && r.bucket_label.includes('Middle') ? ' ◄' : '';

      console.log('  ' + (r.direction_filter || '?').padEnd(7) +
        '| ' + (r.bucket_label || '?').padEnd(22) +
        '| ' + isSR.padStart(7) +
        ' | ' + oosSR.padStart(7) +
        ' | ' + (oosWR + '%').padStart(7) +
        ' | ' + String(r.oos_trades || 0).padStart(6) +
        ' | ' + rho.padStart(4) +
        ' | ' + (r.confidence || '?').padEnd(12) + isMiddle);
    }

    // Check: was Middle best in both IS and OOS?
    const dirs = [...new Set(rows.map(r => r.direction_filter))];
    for (const dir of dirs) {
      const dirRows = rows.filter(r => r.direction_filter === dir);
      if (dirRows.length < 3) continue;

      const isBest = dirRows.reduce((best, r) => (r.is_sharpe || 0) > (best.is_sharpe || 0) ? r : best);
      const oosBest = dirRows.reduce((best, r) => (r.oos_sharpe || 0) > (best.oos_sharpe || 0) ? r : best);
      const isWorst = dirRows.reduce((worst, r) => (r.is_sharpe || 0) < (worst.is_sharpe || 0) ? r : worst);
      const oosWorst = dirRows.reduce((worst, r) => (r.oos_sharpe || 0) < (worst.oos_sharpe || 0) ? r : worst);

      console.log('\n  ' + dir + ':');
      console.log('    IS  best=' + (isBest.bucket_label || '?') + ' (' + (+isBest.is_sharpe || 0).toFixed(2) + ') | worst=' + (isWorst.bucket_label || '?') + ' (' + (+isWorst.is_sharpe || 0).toFixed(2) + ')');
      console.log('    OOS best=' + (oosBest.bucket_label || '?') + ' (' + (+oosBest.oos_sharpe || 0).toFixed(2) + ') | worst=' + (oosWorst.bucket_label || '?') + ' (' + (+oosWorst.oos_sharpe || 0).toFixed(2) + ')');

      const middleRow = dirRows.find(r => r.bucket_label && r.bucket_label.includes('Middle'));
      if (middleRow) {
        const isRank = dirRows.filter(r => (r.is_sharpe || 0) > (middleRow.is_sharpe || 0)).length + 1;
        const oosRank = dirRows.filter(r => (r.oos_sharpe || 0) > (middleRow.oos_sharpe || 0)).length + 1;
        console.log('    Middle IS rank=#' + isRank + ' | OOS rank=#' + oosRank + (isRank === oosRank ? ' ✓ STABLE' : ' ✗ SHIFTED'));
      }
    }
    console.log('\n');
  }

  c.release(); pool.end();
})();
