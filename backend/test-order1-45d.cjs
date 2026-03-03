/**
 * Order 1 vs Order 2+ on full 45-day 1m data, top 30 coins.
 * Weekly breakdown + Spearman rank consistency test.
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
    if (pos && i >= pos.exitIdx) { const ep = bars[i].open; const r = pos.type === 'LONG' ? (ep/pos.ep-1)*100 : (pos.ep/ep-1)*100; signals.push({...pos, returnPct: +r.toFixed(4), won: r > 0, barIdx: pos.entryIdx}); pos = null; }
    if (pos) continue;
    let bs = 0, ss = 0, mbc = 0, msc = 0, mbo = 0, mso = 0;
    for (const b of bands) {
      const lo = b.lower[i], up = b.upper[i];
      if (lo === null || up === null || up <= lo || (up-lo)/((up+lo)/2) < 0.0001) continue;
      const sw = Math.round(b.cycle / 3);
      const buyAt = bars[i].low < lo && bars[i].close > lo;
      const buyNr = i > 0 && b.lower[i-1] !== null && bars[i-1].low < b.lower[i-1] && bars[i-1].close > b.lower[i-1];
      if (buyAt || buyNr) { if (!isLM(b.lower, i, sw) && !(isLM(b.lower, i-1, sw) || isLM(b.lower, i+1, sw))) {} else { bs++; if (b.cycle > mbc) mbc = b.cycle; if (b.order > mbo) mbo = b.order; } }
      const sellAt = bars[i].high > up && bars[i].close < up;
      const sellNr = i > 0 && b.upper[i-1] !== null && bars[i-1].high > b.upper[i-1] && bars[i-1].close < b.upper[i-1];
      if (sellAt || sellNr) { if (!isLm(b.upper, i, sw) && !(isLm(b.upper, i-1, sw) || isLm(b.upper, i+1, sw))) {} else { ss++; if (b.cycle > msc) msc = b.cycle; if (b.order > mso) mso = b.order; } }
    }
    if (bs >= 1 && bs >= ss) { if (isPL(i, Math.round(mbc/2)) && i+1 < n) { const hd = Math.round(mbc/4); pos = {type:'LONG',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:mbc,maxOrder:mbo,strength:bs}; } }
    else if (ss >= 1) { if (isPH(i, Math.round(msc/2)) && i+1 < n) { const hd = Math.round(msc/4); pos = {type:'SHORT',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:msc,maxOrder:mso,strength:ss}; } }
  }
  if (pos) { const ep = bars[n-1].close; const r = pos.type==='LONG'?(ep/pos.ep-1)*100:(pos.ep/ep-1)*100; signals.push({...pos,returnPct:+r.toFixed(4),won:r>0,barIdx:pos.entryIdx}); }
  return signals;
}

function spearmanRho(a, b) {
  const n = a.length; if (n < 3) return 0;
  const rank = arr => {
    const sorted = arr.map((v, i) => ({v, i})).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[sorted[i].i] = i + 1;
    return ranks;
  };
  const ra = rank(a), rb = rank(b);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

(async () => {
  const c = await pool.connect();

  console.log('=== ORDER 1 vs 2+ — Full 45-day history, Top 30 coins ===\n');

  // Get top 30
  const { rows: volumes } = await c.query(`
    SELECT symbol FROM (
      SELECT symbol, AVG(daily_vol) as v FROM (
        SELECT symbol, timestamp::date as day, SUM(volume * close) as daily_vol
        FROM "Candle1m" WHERE timestamp > NOW() - INTERVAL '7 days'
        GROUP BY symbol, day) sub GROUP BY symbol ORDER BY v DESC LIMIT 30) t
  `);
  const top30 = volumes.map(r => r.symbol);
  console.log('Top 30: ' + top30.slice(0, 8).join(', ') + '...\n');

  // Collect all signals across all coins
  const allSigs = { o1: [], o2plus: [] };
  let processed = 0;

  for (const symbol of top30) {
    const { rows } = await c.query(
      `SELECT timestamp as time, open, high, low, close FROM "Candle1m"
       WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '45 days'
       ORDER BY timestamp ASC`, [symbol]
    );
    if (rows.length < 5000) continue;
    const bars = rows.map(r => ({time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close}));
    const h = bars.map(b => b.high), l = bars.map(b => b.low);
    const bands = [];
    for (let cycle = 30; cycle <= 40; cycle++) for (const order of ORDERS) bands.push(computeFracmap(h, l, cycle, order));
    const sigs = detect(bars, bands);

    for (const sig of sigs) {
      // Determine week number from bar index
      const week = Math.floor(sig.barIdx / (1440 * 7));
      const entry = { ...sig, symbol, week };
      if (sig.maxOrder === 1) allSigs.o1.push(entry);
      else allSigs.o2plus.push(entry);
    }
    processed++;
    process.stdout.write('\r  ' + symbol + ' (' + processed + '/' + top30.length + ')');
  }
  console.log('\n');

  // Overall stats
  for (const [label, sigs] of Object.entries(allSigs)) {
    const total = sigs.length;
    const wins = sigs.filter(s => s.won).length;
    const totalRet = sigs.reduce((s, r) => s + r.returnPct, 0);
    const avg = total > 0 ? totalRet / total : 0;
    const wr = total > 0 ? (wins / total * 100) : 0;
    console.log(label.toUpperCase() + ' OVERALL: ' + total + ' trades | WR=' + wr.toFixed(1) + '% | Avg=' + (avg >= 0 ? '+' : '') + avg.toFixed(4) + '% (' + Math.round(avg * 100) + ' bps) | Total=' + (totalRet >= 0 ? '+' : '') + totalRet.toFixed(1) + '%');
  }

  // Weekly breakdown
  const allWeeks = new Set();
  Object.values(allSigs).forEach(sigs => sigs.forEach(s => allWeeks.add(s.week)));
  const weeks = [...allWeeks].sort((a, b) => a - b);

  console.log('\n=== WEEKLY BREAKDOWN ===\n');
  console.log('  Week | O1 Trades | O1 WR%  | O1 AvgBps | O1 Total  | O2+ Trades | O2+ WR% | O2+ AvgBps | O2+ Total');
  console.log('  ' + '-'.repeat(110));

  const o1WeeklyRets = [];
  const o2WeeklyRets = [];

  for (const week of weeks) {
    const o1w = allSigs.o1.filter(s => s.week === week);
    const o2w = allSigs.o2plus.filter(s => s.week === week);

    const o1wr = o1w.length > 0 ? (o1w.filter(s => s.won).length / o1w.length * 100) : 0;
    const o2wr = o2w.length > 0 ? (o2w.filter(s => s.won).length / o2w.length * 100) : 0;
    const o1ret = o1w.reduce((s, r) => s + r.returnPct, 0);
    const o2ret = o2w.reduce((s, r) => s + r.returnPct, 0);
    const o1avg = o1w.length > 0 ? o1ret / o1w.length : 0;
    const o2avg = o2w.length > 0 ? o2ret / o2w.length : 0;

    o1WeeklyRets.push(o1ret);
    o2WeeklyRets.push(o2ret);

    console.log('  W' + String(week).padStart(3) +
      ' | ' + String(o1w.length).padStart(9) +
      ' | ' + o1wr.toFixed(1).padStart(6) + '%' +
      ' | ' + String(Math.round(o1avg * 100)).padStart(9) +
      ' | ' + ((o1ret >= 0 ? '+' : '') + o1ret.toFixed(1) + '%').padStart(9) +
      ' | ' + String(o2w.length).padStart(10) +
      ' | ' + o2wr.toFixed(1).padStart(6) + '%' +
      ' | ' + String(Math.round(o2avg * 100)).padStart(10) +
      ' | ' + ((o2ret >= 0 ? '+' : '') + o2ret.toFixed(1) + '%').padStart(9));
  }

  // Profitable weeks
  const o1Prof = o1WeeklyRets.filter(r => r > 0).length;
  const o2Prof = o2WeeklyRets.filter(r => r > 0).length;
  console.log('\n  O1 profitable weeks: ' + o1Prof + '/' + weeks.length + ' (' + (o1Prof/weeks.length*100).toFixed(0) + '%)');
  console.log('  O2+ profitable weeks: ' + o2Prof + '/' + weeks.length + ' (' + (o2Prof/weeks.length*100).toFixed(0) + '%)');

  // Spearman rank consistency: do the weeks that are good for O1 also tend to be good for O1?
  // Actually more useful: rank weeks by O1 return and by O2+ return, check if they're correlated
  if (weeks.length >= 4) {
    const rho = spearmanRho(o1WeeklyRets, o2WeeklyRets);
    console.log('\n  Spearman rho (O1 weekly ret vs O2+ weekly ret): ' + rho.toFixed(3));
    console.log('  Interpretation: ' + (Math.abs(rho) > 0.7 ? 'STRONGLY correlated — same market conditions affect both' :
      Math.abs(rho) > 0.4 ? 'MODERATELY correlated' : 'WEAKLY correlated — different drivers'));
  }

  // Also: is O1 consistently better than O2+ each week?
  const o1BetterWeeks = weeks.filter((w, i) => o1WeeklyRets[i] > o2WeeklyRets[i]).length;
  console.log('  O1 beats O2+ in: ' + o1BetterWeeks + '/' + weeks.length + ' weeks (' + (o1BetterWeeks/weeks.length*100).toFixed(0) + '%)');

  // By order individually
  console.log('\n=== BY INDIVIDUAL ORDER (full 45 days, top 30 coins) ===\n');
  console.log('  Order | Trades | WR%   | Avg Bps | Total Ret  | Prof Weeks');
  console.log('  ' + '-'.repeat(65));

  for (const targetOrder of [1, 2, 3, 4, 5, 6]) {
    // Re-filter from all signals
    const orderSigs = (targetOrder === 1 ? allSigs.o1 : allSigs.o2plus.filter(s => s.maxOrder === targetOrder));
    const total = orderSigs.length;
    if (total === 0) continue;
    const wins = orderSigs.filter(s => s.won).length;
    const totalRet = orderSigs.reduce((s, r) => s + r.returnPct, 0);
    const avg = totalRet / total;
    const wr = (wins / total * 100);
    const profWeeks = weeks.filter(w => orderSigs.filter(s => s.week === w).reduce((s, r) => s + r.returnPct, 0) > 0).length;

    console.log('  ' + String(targetOrder).padStart(5) +
      ' | ' + String(total).padStart(6) +
      ' | ' + wr.toFixed(1).padStart(5) + '%' +
      ' | ' + String(Math.round(avg * 100)).padStart(7) +
      ' | ' + ((totalRet >= 0 ? '+' : '') + totalRet.toFixed(1) + '%').padStart(10) +
      ' | ' + profWeeks + '/' + weeks.length);
  }

  c.release(); pool.end();
})();
