/**
 * Compare nearMiss=ON vs nearMiss=OFF for 1m C30-40
 * Then break down by day to check consistency.
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

function detect(bars, bands, spike, nearMiss) {
  const signals = []; let pos = null; const n = bars.length;
  function isLM(arr, i, w) { const v = arr[i]; if (v === null) return false; for (let j = Math.max(0, i-w); j <= Math.min(arr.length-1, i+w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] > v) return false; } return true; }
  function isLm(arr, i, w) { const v = arr[i]; if (v === null) return false; for (let j = Math.max(0, i-w); j <= Math.min(arr.length-1, i+w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] < v) return false; } return true; }
  function isPL(i, w) { for (let j = Math.max(0, i-w); j < i; j++) if (bars[j].low < bars[i].low) return false; return true; }
  function isPH(i, w) { for (let j = Math.max(0, i-w); j < i; j++) if (bars[j].high > bars[i].high) return false; return true; }
  for (let i = 1; i < n; i++) {
    if (pos && i >= pos.exitIdx) { const ep = bars[i].open; const r = pos.type === 'LONG' ? (ep/pos.ep-1)*100 : (pos.ep/ep-1)*100; signals.push({...pos, returnPct: +r.toFixed(3), won: r > 0, day: bars[pos.entryIdx].time.toISOString().slice(0,10)}); pos = null; }
    if (pos) continue;
    let bs = 0, ss = 0, mbc = 0, msc = 0;
    for (const b of bands) {
      const lo = b.lower[i], up = b.upper[i];
      if (lo === null || up === null || up <= lo || (up-lo)/((up+lo)/2) < 0.0001) continue;
      const sw = Math.round(b.cycle / 3);
      const buyAt = bars[i].low < lo && bars[i].close > lo;
      const buyNr = nearMiss && !buyAt && (i > 0 && b.lower[i-1] !== null && bars[i-1].low < b.lower[i-1] && bars[i-1].close > b.lower[i-1]);
      if (buyAt || buyNr) { if (spike) { if (!isLM(b.lower, i, sw) && !(nearMiss && (isLM(b.lower, i-1, sw) || isLM(b.lower, i+1, sw)))) continue; } bs++; if (b.cycle > mbc) mbc = b.cycle; }
      const sellAt = bars[i].high > up && bars[i].close < up;
      const sellNr = nearMiss && !sellAt && (i > 0 && b.upper[i-1] !== null && bars[i-1].high > b.upper[i-1] && bars[i-1].close < b.upper[i-1]);
      if (sellAt || sellNr) { if (spike) { if (!isLm(b.upper, i, sw) && !(nearMiss && (isLm(b.upper, i-1, sw) || isLm(b.upper, i+1, sw)))) continue; } ss++; if (b.cycle > msc) msc = b.cycle; }
    }
    if (bs >= 1 && bs >= ss) { if (isPL(i, Math.round(mbc/2)) && i+1 < n) { const hd = Math.round(mbc/4); pos = {type:'LONG',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:mbc,strength:bs}; } }
    else if (ss >= 1) { if (isPH(i, Math.round(msc/2)) && i+1 < n) { const hd = Math.round(msc/4); pos = {type:'SHORT',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:msc,strength:ss}; } }
  }
  if (pos) { const ep = bars[n-1].close; const r = pos.type==='LONG'?(ep/pos.ep-1)*100:(pos.ep/ep-1)*100; signals.push({...pos, returnPct:+r.toFixed(3), won:r>0, day:bars[Math.min(pos.entryIdx, n-1)].time.toISOString().slice(0,10)}); }
  return signals;
}

(async () => {
  const c = await pool.connect();

  console.log('Loading 1m data (5 days)...');
  const { rows: coins } = await c.query(
    "SELECT DISTINCT symbol FROM \"Candle1m\" WHERE timestamp > NOW() - INTERVAL '6 days' GROUP BY symbol HAVING COUNT(*) >= 5000"
  );
  console.log('Coins: ' + coins.length + '\n');

  for (const nmMode of [true, false]) {
    const label = nmMode ? 'nearMiss=ON (current)' : 'nearMiss=OFF';
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  ' + label);
    console.log('═══════════════════════════════════════════════════════════\n');

    let allSignals = [];

    for (const { symbol } of coins) {
      const { rows } = await c.query(
        "SELECT timestamp as time, open, high, low, close FROM \"Candle1m\" WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '6 days' ORDER BY timestamp ASC", [symbol]
      );
      if (rows.length < 5000) continue;
      const bars = rows.map(r => ({time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close}));
      const h = bars.map(b => b.high), l = bars.map(b => b.low);
      const bands = [];
      for (let cycle = 30; cycle <= 40; cycle++) for (const order of ORDERS) bands.push(computeFracmap(h, l, cycle, order));
      const sigs = detect(bars, bands, true, nmMode);
      allSignals = allSignals.concat(sigs);
    }

    // Overall stats
    const closed = allSignals.filter(s => s.won !== undefined);
    const wins = closed.filter(s => s.won).length;
    const totalRet = closed.reduce((s, r) => s + r.returnPct, 0);
    const avgRet = closed.length > 0 ? totalRet / closed.length : 0;
    const wr = closed.length > 0 ? (wins / closed.length * 100) : 0;

    console.log('  OVERALL: ' + closed.length + ' signals | WR=' + wr.toFixed(1) + '% | Avg=' + (avgRet >= 0 ? '+' : '') + avgRet.toFixed(4) + '% | Total=' + (totalRet >= 0 ? '+' : '') + totalRet.toFixed(1) + '%\n');

    // By day
    const byDay = {};
    for (const s of closed) {
      if (!byDay[s.day]) byDay[s.day] = { trades: 0, wins: 0, totalRet: 0 };
      byDay[s.day].trades++;
      if (s.won) byDay[s.day].wins++;
      byDay[s.day].totalRet += s.returnPct;
    }

    const days = Object.keys(byDay).sort();
    console.log('  Day        | Trades | WR%   | Avg Ret  | Day Ret');
    console.log('  ' + '-'.repeat(60));
    for (const day of days) {
      const d = byDay[day];
      const dwr = (d.wins / d.trades * 100).toFixed(1);
      const davg = (d.totalRet / d.trades);
      console.log('  ' + day +
        ' | ' + String(d.trades).padStart(6) +
        ' | ' + dwr.padStart(5) + '%' +
        ' | ' + (davg >= 0 ? '+' : '') + davg.toFixed(4) + '%' +
        ' | ' + (d.totalRet >= 0 ? '+' : '') + d.totalRet.toFixed(1) + '%');
    }

    // Profitable days count
    const profDays = days.filter(d => byDay[d].totalRet > 0).length;
    console.log('\n  Profitable days: ' + profDays + '/' + days.length + ' (' + (profDays/days.length*100).toFixed(0) + '%)\n');
  }

  c.release(); pool.end();
})();
