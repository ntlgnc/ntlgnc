/**
 * Historical liquidity analysis using the full 1m backtest database.
 * Uses the hedged_single_cycle results (which tested all coins)
 * plus a fresh signal generation split by volume quartile.
 *
 * Approach: Generate signals on full 1m history (45 days),
 * bucket coins by volume, check if top-liquid outperforms consistently.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PHI = 1.6180339887;
const ORDERS = [1, 2, 3, 4, 5, 6];

function computeFracmap(highs, lows, cycle, order) {
  const zfracR = Math.round(cycle / 3.0), phiO = Math.pow(PHI, order), n = highs.length;
  const fwd = Math.round(cycle / 3), totalLen = n + fwd;
  const lower = new Array(totalLen).fill(null), upper = new Array(totalLen).fill(null);
  for (let i = (order + 1) * zfracR; i < totalLen; i++) {
    const s = i - (order + 1) * zfracR, e = i - order * zfracR;
    if (s < 0 || s >= n) continue; const ce = Math.min(e, n - 1); if (ce < s) continue;
    let wMax = -Infinity, wMin = Infinity;
    for (let j = s; j <= ce; j++) { wMax = Math.max(wMax, highs[j], lows[j]); wMin = Math.min(wMin, highs[j], lows[j]); }
    lower[i] = (1 - phiO) * wMax + phiO * wMin; upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper, cycle, order };
}

function detect(bars, bands) {
  const signals = []; let pos = null; const n = bars.length;
  function isLM(arr, i, w) { const v = arr[i]; if (v === null) return false; for (let j = Math.max(0, i-w); j <= Math.min(arr.length-1, i+w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] > v) return false; } return true; }
  function isLm(arr, i, w) { const v = arr[i]; if (v === null) return false; for (let j = Math.max(0, i-w); j <= Math.min(arr.length-1, i+w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] < v) return false; } return true; }
  function isPL(i, w) { for (let j = Math.max(0, i-w); j < i; j++) if (bars[j].low < bars[i].low) return false; return true; }
  function isPH(i, w) { for (let j = Math.max(0, i-w); j < i; j++) if (bars[j].high > bars[i].high) return false; return true; }
  for (let i = 1; i < n; i++) {
    if (pos && i >= pos.exitIdx) { const ep = bars[i].open; const r = pos.type === 'LONG' ? (ep/pos.ep-1)*100 : (pos.ep/ep-1)*100; signals.push({...pos, returnPct: +r.toFixed(4), won: r > 0, week: Math.floor(pos.entryIdx / (1440 * 7))}); pos = null; }
    if (pos) continue;
    let bs = 0, ss = 0, mbc = 0, msc = 0;
    for (const b of bands) {
      const lo = b.lower[i], up = b.upper[i];
      if (lo === null || up === null || up <= lo || (up-lo)/((up+lo)/2) < 0.0001) continue;
      const sw = Math.round(b.cycle / 3);
      const buyAt = bars[i].low < lo && bars[i].close > lo;
      const buyNr = i > 0 && b.lower[i-1] !== null && bars[i-1].low < b.lower[i-1] && bars[i-1].close > b.lower[i-1];
      if (buyAt || buyNr) { if (!isLM(b.lower, i, sw) && !(isLM(b.lower, i-1, sw) || isLM(b.lower, i+1, sw))) {} else { bs++; if (b.cycle > mbc) mbc = b.cycle; } }
      const sellAt = bars[i].high > up && bars[i].close < up;
      const sellNr = i > 0 && b.upper[i-1] !== null && bars[i-1].high > b.upper[i-1] && bars[i-1].close < b.upper[i-1];
      if (sellAt || sellNr) { if (!isLm(b.upper, i, sw) && !(isLm(b.upper, i-1, sw) || isLm(b.upper, i+1, sw))) {} else { ss++; if (b.cycle > msc) msc = b.cycle; } }
    }
    if (bs >= 1 && bs >= ss) { if (isPL(i, Math.round(mbc/2)) && i+1 < n) { const hd = Math.round(mbc/4); pos = {type:'LONG',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:mbc,strength:bs}; } }
    else if (ss >= 1) { if (isPH(i, Math.round(msc/2)) && i+1 < n) { const hd = Math.round(msc/4); pos = {type:'SHORT',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:msc,strength:ss}; } }
  }
  if (pos) { const ep = bars[n-1].close; const r = pos.type==='LONG'?(ep/pos.ep-1)*100:(pos.ep/ep-1)*100; signals.push({...pos,returnPct:+r.toFixed(4),won:r>0,week:Math.floor(pos.entryIdx/(1440*7))}); }
  return signals;
}

(async () => {
  const c = await pool.connect();

  console.log('=== HISTORICAL LIQUIDITY ANALYSIS (full 1m data, C30-40) ===\n');

  // Get volume ranking
  console.log('Computing volume rankings...');
  const { rows: volumes } = await c.query(`
    SELECT symbol, AVG(daily_vol) as avg_daily_vol
    FROM (SELECT symbol, timestamp::date as day, SUM(volume * close) as daily_vol
          FROM "Candle1m" WHERE timestamp > NOW() - INTERVAL '30 days'
          GROUP BY symbol, day) sub
    GROUP BY symbol ORDER BY avg_daily_vol DESC
  `);
  const volRank = {};
  volumes.forEach((r, i) => { volRank[r.symbol] = i + 1; });
  const top30 = new Set(volumes.slice(0, 30).map(r => r.symbol));
  const mid30 = new Set(volumes.slice(30, 60).map(r => r.symbol));
  const rest = new Set(volumes.slice(60).map(r => r.symbol));

  console.log('Top 30: ' + [...top30].slice(0, 5).join(', ') + '...');
  console.log('Total coins ranked: ' + volumes.length + '\n');

  // Load and process each coin
  const { rows: coinList } = await c.query(
    "SELECT DISTINCT symbol FROM \"Candle1m\" WHERE timestamp > NOW() - INTERVAL '45 days' GROUP BY symbol HAVING COUNT(*) >= 10000"
  );
  console.log('Coins with enough 1m data: ' + coinList.length);

  const bucketStats = {
    top30: { weeks: {}, total: 0, wins: 0, totalRet: 0 },
    mid30: { weeks: {}, total: 0, wins: 0, totalRet: 0 },
    rest: { weeks: {}, total: 0, wins: 0, totalRet: 0 },
  };

  let processed = 0;
  for (const { symbol } of coinList) {
    const { rows } = await c.query(
      "SELECT timestamp as time, open, high, low, close, volume FROM \"Candle1m\" WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '45 days' ORDER BY timestamp ASC", [symbol]
    );
    if (rows.length < 10000) continue;
    const bars = rows.map(r => ({time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close}));
    const h = bars.map(b => b.high), l = bars.map(b => b.low);
    const bands = [];
    for (let cycle = 30; cycle <= 40; cycle++) for (const order of ORDERS) bands.push(computeFracmap(h, l, cycle, order));
    const sigs = detect(bars, bands);

    const bucket = top30.has(symbol) ? 'top30' : mid30.has(symbol) ? 'mid30' : 'rest';
    const bs = bucketStats[bucket];

    for (const sig of sigs) {
      bs.total++;
      if (sig.won) bs.wins++;
      bs.totalRet += sig.returnPct;
      // Track by week
      const weekKey = 'W' + sig.week;
      if (!bs.weeks[weekKey]) bs.weeks[weekKey] = { total: 0, wins: 0, totalRet: 0 };
      bs.weeks[weekKey].total++;
      if (sig.won) bs.weeks[weekKey].wins++;
      bs.weeks[weekKey].totalRet += sig.returnPct;
    }

    processed++;
    if (processed % 20 === 0) process.stdout.write('\r  Processed ' + processed + '/' + coinList.length);
  }

  console.log('\n');

  // Overall comparison
  console.log('=== OVERALL (full 45-day history) ===\n');
  console.log('  Bucket    | Trades  | WR%   | Avg Ret  | Total Ret');
  console.log('  ' + '-'.repeat(60));
  for (const [label, bs] of Object.entries(bucketStats)) {
    const wr = bs.total > 0 ? (bs.wins / bs.total * 100).toFixed(1) : '0';
    const avg = bs.total > 0 ? (bs.totalRet / bs.total) : 0;
    console.log('  ' + label.padEnd(12) +
      '| ' + String(bs.total).padStart(7) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (avg >= 0 ? '+' : '') + avg.toFixed(4) + '%' +
      ' | ' + (bs.totalRet >= 0 ? '+' : '') + bs.totalRet.toFixed(1) + '%');
  }

  // Weekly consistency
  console.log('\n=== WEEKLY CONSISTENCY ===\n');
  const allWeeks = new Set();
  Object.values(bucketStats).forEach(bs => Object.keys(bs.weeks).forEach(w => allWeeks.add(w)));
  const sortedWeeks = [...allWeeks].sort();

  console.log('  Week  | Top30 Ret    | Mid30 Ret    | Rest Ret     | Top30 WR | Mid30 WR | Rest WR');
  console.log('  ' + '-'.repeat(90));
  for (const week of sortedWeeks) {
    const t = bucketStats.top30.weeks[week] || { total: 0, wins: 0, totalRet: 0 };
    const m = bucketStats.mid30.weeks[week] || { total: 0, wins: 0, totalRet: 0 };
    const r = bucketStats.rest.weeks[week] || { total: 0, wins: 0, totalRet: 0 };
    const twr = t.total > 0 ? (t.wins/t.total*100).toFixed(1) : '—';
    const mwr = m.total > 0 ? (m.wins/m.total*100).toFixed(1) : '—';
    const rwr = r.total > 0 ? (r.wins/r.total*100).toFixed(1) : '—';
    console.log('  ' + week.padEnd(6) +
      ' | ' + ((t.totalRet >= 0 ? '+' : '') + t.totalRet.toFixed(1) + '%').padStart(11) +
      ' | ' + ((m.totalRet >= 0 ? '+' : '') + m.totalRet.toFixed(1) + '%').padStart(11) +
      ' | ' + ((r.totalRet >= 0 ? '+' : '') + r.totalRet.toFixed(1) + '%').padStart(11) +
      ' | ' + twr.padStart(7) + '%' +
      ' | ' + mwr.padStart(7) + '%' +
      ' | ' + rwr.padStart(7) + '%');
  }

  // Count profitable weeks per bucket
  console.log('\n  Profitable weeks:');
  for (const [label, bs] of Object.entries(bucketStats)) {
    const profWeeks = Object.values(bs.weeks).filter(w => w.totalRet > 0).length;
    const totalWeeks = Object.keys(bs.weeks).length;
    console.log('    ' + label + ': ' + profWeeks + '/' + totalWeeks + ' (' + (profWeeks/totalWeeks*100).toFixed(0) + '%)');
  }

  c.release(); pool.end();
})();
