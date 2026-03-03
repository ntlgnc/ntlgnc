/**
 * 1. Trend10 split by LONG vs SHORT
 * 2. PiR breakdown with sample sizes for each order level
 * 3. Orders 5-6 performance when PiR is in middle range
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
      const ei = pos.entryIdx;
      const lb = Math.min(60, ei);
      const slice = bars.slice(Math.max(0, ei - lb), ei + 1);
      const closes = slice.map(b => b.close);
      const min60 = Math.min(...closes), max60 = Math.max(...closes);
      const posInRange = (max60 - min60) > 0 ? (closes[closes.length - 1] - min60) / (max60 - min60) : 0.5;
      const trend10 = closes.length >= 10 ? (closes[closes.length - 1] / closes[Math.max(0, closes.length - 10)] - 1) * 100 : 0;
      signals.push({...pos, returnPct: +r.toFixed(4), won: r > 0, posInRange, trend10,
        week: Math.floor(ei / (1440 * 7))});
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

function stats(sigs) {
  const n = sigs.length; if (n === 0) return { n: 0, wr: 0, bps: 0 };
  const w = sigs.filter(s => s.won).length;
  const avg = sigs.reduce((s, r) => s + r.returnPct, 0) / n;
  return { n, wr: (w / n * 100), bps: Math.round(avg * 100) };
}

function profWeeks(sigs) {
  const weeks = {};
  sigs.forEach(s => { if (!weeks[s.week]) weeks[s.week] = 0; weeks[s.week] += s.returnPct; });
  const all = Object.values(weeks);
  return all.filter(r => r > 0).length + '/' + all.length;
}

(async () => {
  const c = await pool.connect();
  const { rows: volumes } = await c.query(`
    SELECT symbol FROM (SELECT symbol, AVG(daily_vol) as v FROM (
      SELECT symbol, timestamp::date as day, SUM(volume * close) as daily_vol
      FROM "Candle1m" WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY symbol, day) sub GROUP BY symbol ORDER BY v DESC LIMIT 30) t`);
  const top30 = volumes.map(r => r.symbol);

  const allSigs = [];
  for (const symbol of top30) {
    const { rows } = await c.query(
      `SELECT timestamp as time, open, high, low, close FROM "Candle1m"
       WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '45 days' ORDER BY timestamp ASC`, [symbol]);
    if (rows.length < 5000) continue;
    const bars = rows.map(r => ({time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close}));
    const bands = [];
    for (let cycle = 30; cycle <= 40; cycle++) for (const order of ORDERS) bands.push(computeFracmap(bars.map(b => b.high), bars.map(b => b.low), cycle, order));
    const sigs = detect(bars, bands);
    sigs.forEach(s => { s.symbol = symbol; allSigs.push(s); });
    process.stdout.write('\r  ' + symbol);
  }
  console.log('\n');

  // ═══════════════════════════════════════
  // 1. TREND10 SPLIT BY DIRECTION
  // ═══════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TREND10 × DIRECTION                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('  trend10 = (close_now / close_10bars_ago - 1) × 100');
  console.log('  Positive = price was rising before entry\n');

  const trendBuckets = [
    { label: 'Strong down (<-0.1%)', test: v => v < -0.1 },
    { label: 'Mild down (-0.1 to 0)', test: v => v >= -0.1 && v < 0 },
    { label: 'Mild up (0 to 0.1%)', test: v => v >= 0 && v < 0.1 },
    { label: 'Strong up (>0.1%)', test: v => v >= 0.1 },
  ];

  for (const dir of ['LONG', 'SHORT']) {
    console.log('  --- ' + dir + ' ---');
    console.log('  Trend bucket       | n     | WR%   | Bps  | Prof wks');
    console.log('  ' + '-'.repeat(58));
    for (const tb of trendBuckets) {
      const sigs = allSigs.filter(s => s.type === dir && tb.test(s.trend10));
      const st = stats(sigs);
      console.log('  ' + tb.label.padEnd(21) + '| ' + String(st.n).padStart(5) + ' | ' + st.wr.toFixed(1).padStart(5) + '% | ' + String(st.bps).padStart(4) + ' | ' + profWeeks(sigs));
    }
    console.log('');
  }

  // ═══════════════════════════════════════
  // 2. PiR × ORDER with sample sizes
  // ═══════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PiR × ORDER — Full breakdown                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const pirBuckets = [
    { label: 'Bottom (<0.2)', test: v => v < 0.2 },
    { label: 'Low (0.2-0.4)', test: v => v >= 0.2 && v < 0.4 },
    { label: 'Mid (0.4-0.6)', test: v => v >= 0.4 && v < 0.6 },
    { label: 'High (0.6-0.8)', test: v => v >= 0.6 && v < 0.8 },
    { label: 'Top (>0.8)', test: v => v >= 0.8 },
  ];

  console.log('  Order | PiR Bucket     | n     | WR%   | Bps  | Prof wks');
  console.log('  ' + '-'.repeat(65));

  for (const order of [1, 2, 3, 4, 5, 6]) {
    for (const pir of pirBuckets) {
      const sigs = allSigs.filter(s => s.maxOrder === order && pir.test(s.posInRange));
      if (sigs.length < 5) continue;
      const st = stats(sigs);
      console.log('  ' + String(order).padStart(5) +
        ' | ' + pir.label.padEnd(15) +
        '| ' + String(st.n).padStart(5) +
        ' | ' + st.wr.toFixed(1).padStart(5) + '%' +
        ' | ' + String(st.bps).padStart(4) +
        ' | ' + profWeeks(sigs));
    }
  }

  // ═══════════════════════════════════════
  // 3. Can PiR rescue orders 5-6?
  // ═══════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Orders 5-6 filtered by PiR — Can mid-range rescue them?     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const o56 = allSigs.filter(s => s.maxOrder >= 5);
  console.log('  All O5-6: ' + o56.length + ' trades | ' + stats(o56).wr.toFixed(1) + '% WR | ' + stats(o56).bps + ' bps\n');

  for (const pir of pirBuckets) {
    const sigs = o56.filter(s => pir.test(s.posInRange));
    if (sigs.length < 3) continue;
    const st = stats(sigs);
    console.log('  O5-6 + ' + pir.label.padEnd(15) + ': n=' + String(st.n).padStart(4) + ' | WR=' + st.wr.toFixed(1).padStart(5) + '% | ' + st.bps + ' bps');
  }

  // Also split by direction
  console.log('\n  O5-6 mid-range (0.2-0.8) by direction:');
  for (const dir of ['LONG', 'SHORT']) {
    const sigs = o56.filter(s => s.type === dir && s.posInRange >= 0.2 && s.posInRange < 0.8);
    const st = stats(sigs);
    console.log('    ' + dir + ': n=' + st.n + ' | WR=' + st.wr.toFixed(1) + '% | ' + st.bps + ' bps');
  }

  c.release(); pool.end();
})();
