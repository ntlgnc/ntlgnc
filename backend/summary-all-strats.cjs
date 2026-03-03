require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  ALL STRATEGIES — Performance Summary                                ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Get all strategies (active and inactive) for 1h and 1d
  const { rows: strats } = await c.query(
    `SELECT id, name, "barMinutes", "cycleMin", "cycleMax", active, "createdAt"
     FROM "FracmapStrategy"
     WHERE "barMinutes" IN (60, 1440)
     ORDER BY "barMinutes", "createdAt"`
  );

  for (const tf of [1440, 60]) {
    const label = tf === 1440 ? '1D' : '1H';
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ' + label + ' STRATEGIES');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const tfStrats = strats.filter(s => s.barMinutes === tf);

    for (const s of tfStrats) {
      // Unhedged stats
      const { rows: [unhedged] } = await c.query(
        `SELECT COUNT(*)::int as total,
                COUNT(*) FILTER (WHERE status = 'closed')::int as closed,
                COUNT(*) FILTER (WHERE status = 'open')::int as open,
                AVG("returnPct") FILTER (WHERE status = 'closed') as avg_ret,
                SUM("returnPct") FILTER (WHERE status = 'closed') as total_ret,
                COUNT(*) FILTER (WHERE status = 'closed' AND "returnPct" > 0)::int as wins
         FROM "FracmapSignal" WHERE "strategyId" = $1`, [s.id]
      );

      // Hedged stats
      const { rows: [hedged] } = await c.query(
        `SELECT COUNT(DISTINCT pair_id)::int as pairs,
                AVG(pair_return) FILTER (WHERE pair_return IS NOT NULL) as avg_pair_ret,
                SUM(pair_return) FILTER (WHERE pair_return IS NOT NULL) / 2 as total_pair_ret,
                COUNT(*) FILTER (WHERE pair_return > 0)::int / GREATEST(2, COUNT(*) FILTER (WHERE pair_return IS NOT NULL)::int) * 100 as pair_wr
         FROM "FracmapSignal" WHERE "strategyId" = $1 AND pair_id IS NOT NULL`, [s.id]
      );

      if (unhedged.total === 0) continue;

      const status = s.active ? 'ACTIVE' : 'off';
      const wr = unhedged.closed > 0 ? (unhedged.wins / unhedged.closed * 100).toFixed(1) : '0';
      const avgRet = unhedged.avg_ret != null ? (+unhedged.avg_ret).toFixed(3) : '?';
      const totalRet = unhedged.total_ret != null ? (+unhedged.total_ret).toFixed(1) : '?';

      console.log('  [' + status.padEnd(6) + '] ' + s.name);
      console.log('           Cycles: ' + s.cycleMin + '-' + s.cycleMax);
      console.log('           UNHEDGED: ' + unhedged.closed + ' closed | Avg: ' + (avgRet >= 0 ? '+' : '') + avgRet + '% | Total: ' + (totalRet >= 0 ? '+' : '') + totalRet + '% | WR: ' + wr + '%');

      if (hedged.pairs > 0) {
        const hAvg = hedged.avg_pair_ret != null ? (+hedged.avg_pair_ret).toFixed(3) : '?';
        const hTotal = hedged.total_pair_ret != null ? (+hedged.total_pair_ret).toFixed(1) : '?';
        console.log('           HEDGED:   ' + hedged.pairs + ' pairs  | Avg: ' + (hAvg >= 0 ? '+' : '') + hAvg + '% | Total: ' + (hTotal >= 0 ? '+' : '') + hTotal + '% | WR: ' + hedged.pair_wr + '%');
      } else {
        console.log('           HEDGED:   no pairs');
      }
      console.log('');
    }
  }

  c.release(); pool.end();
})();
