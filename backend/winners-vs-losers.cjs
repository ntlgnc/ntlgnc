/**
 * Compare average features of winning vs losing trades (Orders 1-3, top 30, 45 days).
 * Features: maxCycle, maxOrder, strength, direction, hour, holdDuration, coin
 * Goal: find what winning trades have in common.
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
    if (pos && i >= pos.exitIdx) {
      const ep = bars[i].open; const r = pos.type === 'LONG' ? (ep/pos.ep-1)*100 : (pos.ep/ep-1)*100;
      // Compute simple features at entry point
      const entryI = pos.entryIdx;
      const lookback = Math.min(60, entryI);
      const slice = bars.slice(Math.max(0, entryI - lookback), entryI + 1);
      const closes = slice.map(b => b.close);
      const highs60 = slice.map(b => b.high);
      const lows60 = slice.map(b => b.low);
      const min60 = Math.min(...closes), max60 = Math.max(...closes);
      const posInRange = (max60 - min60) > 0 ? (closes[closes.length - 1] - min60) / (max60 - min60) : 0.5;
      // Simple volatility: std of 1-bar returns
      const rets = [];
      for (let k = 1; k < closes.length; k++) rets.push((closes[k] / closes[k-1] - 1) * 100);
      const meanRet = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
      const stdRet = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / rets.length) : 0;
      // Trend: slope of closes
      const trend = closes.length >= 10 ? (closes[closes.length - 1] / closes[Math.max(0, closes.length - 10)] - 1) * 100 : 0;
      // Spread: high-low range as % of close
      const spreadPct = slice.length > 0 ? (slice[slice.length - 1].high - slice[slice.length - 1].low) / slice[slice.length - 1].close * 100 : 0;

      signals.push({
        ...pos, returnPct: +r.toFixed(4), won: r > 0,
        posInRange, vol60: stdRet, trend10: trend, spreadPct,
        hour: bars[entryI].time ? new Date(bars[entryI].time).getUTCHours() : 0,
      });
      pos = null;
    }
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
  return signals;
}

(async () => {
  const c = await pool.connect();
  const { rows: volumes } = await c.query(`
    SELECT symbol FROM (SELECT symbol, AVG(daily_vol) as v FROM (
      SELECT symbol, timestamp::date as day, SUM(volume * close) as daily_vol
      FROM "Candle1m" WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY symbol, day) sub GROUP BY symbol ORDER BY v DESC LIMIT 30) t
  `);
  const top30 = volumes.map(r => r.symbol);

  const winners = [];
  const losers = [];
  const flats = [];

  for (const symbol of top30) {
    const { rows } = await c.query(
      `SELECT timestamp as time, open, high, low, close FROM "Candle1m"
       WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '45 days'
       ORDER BY timestamp ASC`, [symbol]);
    if (rows.length < 5000) continue;
    const bars = rows.map(r => ({time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close}));
    const h = bars.map(b => b.high), l = bars.map(b => b.low);
    const bands = [];
    for (let cycle = 30; cycle <= 40; cycle++) for (const order of ORDERS) bands.push(computeFracmap(h, l, cycle, order));
    const sigs = detect(bars, bands).filter(s => s.maxOrder <= 3);
    for (const sig of sigs) {
      sig.symbol = symbol;
      if (sig.returnPct > 0) winners.push(sig);
      else if (sig.returnPct < 0) losers.push(sig);
      else flats.push(sig);
    }
    process.stdout.write('\r  ' + symbol);
  }
  console.log('\n');

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  WINNERS vs LOSERS — Orders 1-3, Top 30, 45 days            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('  Winners: ' + winners.length + ' | Losers: ' + losers.length + ' | Flats: ' + flats.length + '\n');

  const avg = (arr, fn) => arr.length > 0 ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0;

  const features = [
    { label: 'maxOrder', fn: s => s.maxOrder },
    { label: 'maxCycle', fn: s => s.maxCycle },
    { label: 'strength', fn: s => s.strength },
    { label: 'holdDuration (bars)', fn: s => s.holdDuration },
    { label: 'posInRange (0-1)', fn: s => s.posInRange },
    { label: 'vol60 (1-bar std %)', fn: s => s.vol60 },
    { label: 'trend10 (%)', fn: s => s.trend10 },
    { label: 'spreadPct (%)', fn: s => s.spreadPct },
    { label: 'hour (UTC)', fn: s => s.hour },
    { label: '% LONG', fn: s => s.type === 'LONG' ? 1 : 0 },
  ];

  console.log('  Feature                | Winners Avg  | Losers Avg   | Diff        | Signal');
  console.log('  ' + '-'.repeat(80));
  for (const f of features) {
    const wAvg = avg(winners, f.fn);
    const lAvg = avg(losers, f.fn);
    const diff = wAvg - lAvg;
    const pctDiff = lAvg !== 0 ? (diff / Math.abs(lAvg) * 100) : 0;
    const signal = Math.abs(pctDiff) > 10 ? '***' : Math.abs(pctDiff) > 5 ? '**' : Math.abs(pctDiff) > 2 ? '*' : '';
    console.log('  ' + f.label.padEnd(25) +
      '| ' + wAvg.toFixed(4).padStart(12) +
      ' | ' + lAvg.toFixed(4).padStart(12) +
      ' | ' + (diff >= 0 ? '+' : '') + diff.toFixed(4).padStart(10) +
      ' | ' + signal);
  }

  // Bucket analysis for key features
  console.log('\n=== POSITION IN RANGE — Winners vs Losers ===\n');
  const pirBuckets = [
    { label: 'Bottom (<0.25)', test: v => v < 0.25 },
    { label: 'Mid-Low (0.25-0.5)', test: v => v >= 0.25 && v < 0.5 },
    { label: 'Mid-High (0.5-0.75)', test: v => v >= 0.5 && v < 0.75 },
    { label: 'Top (>0.75)', test: v => v >= 0.75 },
  ];
  console.log('  Bucket            | Win Trades | Win%  | Lose Trades | Total Bps');
  console.log('  ' + '-'.repeat(65));
  for (const b of pirBuckets) {
    const all = [...winners, ...losers].filter(s => b.test(s.posInRange));
    const w = all.filter(s => s.won).length;
    const totalRet = all.reduce((s, r) => s + r.returnPct, 0);
    const avgBps = all.length > 0 ? Math.round(totalRet / all.length * 100) : 0;
    console.log('  ' + b.label.padEnd(20) + '| ' + String(w).padStart(10) + ' | ' + (all.length > 0 ? (w/all.length*100).toFixed(1) : '?').padStart(5) + '% | ' + String(all.length - w).padStart(11) + ' | ' + String(avgBps).padStart(9));
  }

  console.log('\n=== VOLATILITY — Winners vs Losers ===\n');
  const volBuckets = [
    { label: 'Very Low (<0.02)', test: v => v < 0.02 },
    { label: 'Low (0.02-0.05)', test: v => v >= 0.02 && v < 0.05 },
    { label: 'Medium (0.05-0.1)', test: v => v >= 0.05 && v < 0.1 },
    { label: 'High (>0.1)', test: v => v >= 0.1 },
  ];
  console.log('  Bucket            | Trades | WR%   | Avg Bps');
  console.log('  ' + '-'.repeat(50));
  for (const b of volBuckets) {
    const all = [...winners, ...losers, ...flats].filter(s => b.test(s.vol60));
    const w = all.filter(s => s.won).length;
    const avgBps = all.length > 0 ? Math.round(all.reduce((s, r) => s + r.returnPct, 0) / all.length * 100) : 0;
    console.log('  ' + b.label.padEnd(20) + '| ' + String(all.length).padStart(6) + ' | ' + (all.length > 0 ? (w/all.length*100).toFixed(1) : '?').padStart(5) + '% | ' + String(avgBps).padStart(7));
  }

  console.log('\n=== STRENGTH — Winners vs Losers ===\n');
  console.log('  Str   | Trades | WR%   | Avg Bps');
  console.log('  ' + '-'.repeat(40));
  for (let str = 1; str <= 6; str++) {
    const all = [...winners, ...losers, ...flats].filter(s => s.strength === str);
    if (all.length < 10) continue;
    const w = all.filter(s => s.won).length;
    const avgBps = Math.round(all.reduce((s, r) => s + r.returnPct, 0) / all.length * 100);
    console.log('  ' + String(str).padStart(5) + ' | ' + String(all.length).padStart(6) + ' | ' + (w/all.length*100).toFixed(1).padStart(5) + '% | ' + String(avgBps).padStart(7));
  }

  c.release(); pool.end();
})();
