require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const c = await pool.connect();
  const { rows } = await c.query(
    `SELECT cycle_min, cycle_max, pair_mode, max_gap,
            oos_sharpe, oos_sharpe_lo95, is_sharpe,
            oos_avg_ret_bps, oos_t_stat, oos_p_value,
            oos_win_rate, oos_trade_count
     FROM hedged_backtest
     WHERE bar_minutes = 1440 AND oos_trade_count >= 5
     ORDER BY oos_sharpe DESC LIMIT 20`
  );
  console.log('TOP 20 — with statistical significance:');
  console.log('');
  console.log('Cycles    Mode       Gap  OOS SR  SR 95%lo  IS SR    Bps  t-stat  p-val   WR%    Pairs');
  console.log('-'.repeat(100));
  for (const r of rows) {
    const pval = r.oos_p_value < 0.001 ? '<.001' : r.oos_p_value.toFixed(3);
    const stars = r.oos_p_value < 0.001 ? '***' : r.oos_p_value < 0.01 ? '**' : r.oos_p_value < 0.05 ? '*' : '';
    console.log(
      ('C' + r.cycle_min + '-' + r.cycle_max).padEnd(10) +
      r.pair_mode.padEnd(11) +
      String(r.max_gap).padEnd(5) +
      r.oos_sharpe.toFixed(2).padStart(6) +
      (r.oos_sharpe_lo95 != null ? r.oos_sharpe_lo95.toFixed(2) : '?').padStart(9) +
      r.is_sharpe.toFixed(2).padStart(7) +
      String(r.oos_avg_ret_bps || 0).padStart(6) +
      (r.oos_t_stat != null ? r.oos_t_stat.toFixed(1) : '?').padStart(8) +
      ('  ' + pval + stars).padEnd(10) +
      r.oos_win_rate.toFixed(1).padStart(6) + '%' +
      String(r.oos_trade_count).padStart(7)
    );
  }
  c.release(); pool.end();
})();
