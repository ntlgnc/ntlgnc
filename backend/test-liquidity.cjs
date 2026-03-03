require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  const { rows: [strat] } = await c.query(
    `SELECT id FROM "FracmapStrategy" WHERE name = 'Universal 1m - C30-C40' AND active = true`
  );

  console.log('=== PROFITABILITY vs LIQUIDITY (1m C30-40) ===\n');

  // Get average daily volume per coin from recent 1m data
  console.log('Computing average daily volume per coin...');
  const { rows: volumes } = await c.query(`
    SELECT symbol,
           AVG(daily_vol) as avg_daily_vol
    FROM (
      SELECT symbol, timestamp::date as day, SUM(volume * close) as daily_vol
      FROM "Candle1m"
      WHERE timestamp > NOW() - INTERVAL '5 days'
      GROUP BY symbol, day
    ) sub
    GROUP BY symbol
    ORDER BY avg_daily_vol DESC
  `);

  // Build volume rank
  const volRank = {};
  const volMap = {};
  volumes.forEach((r, i) => {
    volRank[r.symbol] = i + 1;
    volMap[r.symbol] = +r.avg_daily_vol;
  });

  // Get per-coin signal performance
  const { rows: byCoin } = await c.query(`
    SELECT symbol,
           COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE "returnPct" > 0)::int as wins,
           AVG("returnPct") as avg_ret,
           SUM("returnPct") as total_ret
    FROM "FracmapSignal"
    WHERE "strategyId" = $1 AND status = 'closed'
    GROUP BY symbol
  `, [strat.id]);

  // Merge and sort by volume
  const merged = byCoin.map(r => ({
    symbol: r.symbol,
    trades: r.total,
    wins: r.wins,
    wr: r.total > 0 ? (r.wins / r.total * 100) : 0,
    avgRet: +r.avg_ret,
    totalRet: +r.total_ret,
    rank: volRank[r.symbol] || 999,
    dailyVol: volMap[r.symbol] || 0,
  })).sort((a, b) => a.rank - b.rank);

  // Bucket by volume quartile
  const n = merged.length;
  const q1 = Math.floor(n * 0.25);
  const q2 = Math.floor(n * 0.5);
  const q3 = Math.floor(n * 0.75);

  const buckets = [
    { label: 'Top 25% (most liquid)', coins: merged.slice(0, q1) },
    { label: '25-50%', coins: merged.slice(q1, q2) },
    { label: '50-75%', coins: merged.slice(q2, q3) },
    { label: 'Bottom 25% (least liquid)', coins: merged.slice(q3) },
  ];

  console.log('\n=== PERFORMANCE BY LIQUIDITY QUARTILE ===\n');
  console.log('  Quartile                    | Coins | Trades | WR%   | Avg Ret  | Total Ret | Avg Vol ($)');
  console.log('  ' + '-'.repeat(95));

  for (const b of buckets) {
    const trades = b.coins.reduce((s, c) => s + c.trades, 0);
    const wins = b.coins.reduce((s, c) => s + c.wins, 0);
    const totalRet = b.coins.reduce((s, c) => s + c.totalRet, 0);
    const avgRet = trades > 0 ? totalRet / trades : 0;
    const wr = trades > 0 ? (wins / trades * 100) : 0;
    const avgVol = b.coins.reduce((s, c) => s + c.dailyVol, 0) / b.coins.length;

    console.log('  ' + b.label.padEnd(30) +
      '| ' + String(b.coins.length).padStart(5) +
      ' | ' + String(trades).padStart(6) +
      ' | ' + wr.toFixed(1).padStart(5) + '%' +
      ' | ' + (avgRet >= 0 ? '+' : '') + avgRet.toFixed(4) + '%' +
      ' | ' + (totalRet >= 0 ? '+' : '') + totalRet.toFixed(1).padStart(8) + '%' +
      ' | ' + (avgVol / 1e6).toFixed(1) + 'M');
  }

  // Top 10 and bottom 10 coins
  console.log('\n=== TOP 10 MOST LIQUID — Performance ===\n');
  console.log('  Rank | Symbol          | DailyVol($M) | Trades | WR%   | Avg Ret  | Total');
  console.log('  ' + '-'.repeat(85));
  for (const c2 of merged.slice(0, 10)) {
    console.log('  ' + String(c2.rank).padStart(4) +
      ' | ' + c2.symbol.padEnd(16) +
      '| ' + (c2.dailyVol / 1e6).toFixed(0).padStart(12) + 'M' +
      ' | ' + String(c2.trades).padStart(6) +
      ' | ' + c2.wr.toFixed(1).padStart(5) + '%' +
      ' | ' + (c2.avgRet >= 0 ? '+' : '') + c2.avgRet.toFixed(4) + '%' +
      ' | ' + (c2.totalRet >= 0 ? '+' : '') + c2.totalRet.toFixed(1) + '%');
  }

  console.log('\n=== TOP 10 LEAST LIQUID — Performance ===\n');
  console.log('  Rank | Symbol          | DailyVol($M) | Trades | WR%   | Avg Ret  | Total');
  console.log('  ' + '-'.repeat(85));
  for (const c2 of merged.slice(-10)) {
    console.log('  ' + String(c2.rank).padStart(4) +
      ' | ' + c2.symbol.padEnd(16) +
      '| ' + (c2.dailyVol / 1e6).toFixed(1).padStart(12) + 'M' +
      ' | ' + String(c2.trades).padStart(6) +
      ' | ' + c2.wr.toFixed(1).padStart(5) + '%' +
      ' | ' + (c2.avgRet >= 0 ? '+' : '') + c2.avgRet.toFixed(4) + '%' +
      ' | ' + (c2.totalRet >= 0 ? '+' : '') + c2.totalRet.toFixed(1) + '%');
  }

  // Top 20 vs top 50 vs all
  console.log('\n=== CUMULATIVE PERFORMANCE BY UNIVERSE SIZE ===\n');
  for (const topN of [10, 20, 30, 50, 80, merged.length]) {
    const subset = merged.slice(0, topN);
    const trades = subset.reduce((s, c) => s + c.trades, 0);
    const wins = subset.reduce((s, c) => s + c.wins, 0);
    const totalRet = subset.reduce((s, c) => s + c.totalRet, 0);
    const avgRet = trades > 0 ? totalRet / trades : 0;
    const wr = trades > 0 ? (wins / trades * 100) : 0;
    console.log('  Top ' + String(topN).padStart(3) + ' coins: ' +
      String(trades).padStart(6) + ' trades | WR=' + wr.toFixed(1) + '% | Avg=' + (avgRet >= 0 ? '+' : '') + avgRet.toFixed(4) + '% | Total=' + (totalRet >= 0 ? '+' : '') + totalRet.toFixed(1) + '%');
  }

  c.release(); pool.end();
})();
