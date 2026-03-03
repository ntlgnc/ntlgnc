/**
 * 1. Orders 1-3 combined: weekly consistency + avg bps + SR
 * 2. Deep dive into orders 5-6: what's common about them?
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
    if (pos && i >= pos.exitIdx) { const ep = bars[i].open; const r = pos.type === 'LONG' ? (ep/pos.ep-1)*100 : (pos.ep/ep-1)*100; signals.push({...pos, returnPct: +r.toFixed(4), won: r > 0, barIdx: pos.entryIdx, time: bars[pos.entryIdx].time}); pos = null; }
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
  if (pos) { const ep = bars[n-1].close; const r = pos.type==='LONG'?(ep/pos.ep-1)*100:(pos.ep/ep-1)*100; signals.push({...pos,returnPct:+r.toFixed(4),won:r>0,barIdx:pos.entryIdx,time:bars[Math.min(pos.entryIdx,n-1)].time}); }
  return signals;
}

(async () => {
  const c = await pool.connect();

  // Get top 30
  const { rows: volumes } = await c.query(`
    SELECT symbol FROM (SELECT symbol, AVG(daily_vol) as v FROM (
      SELECT symbol, timestamp::date as day, SUM(volume * close) as daily_vol
      FROM "Candle1m" WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY symbol, day) sub GROUP BY symbol ORDER BY v DESC LIMIT 30) t
  `);
  const top30 = volumes.map(r => r.symbol);

  // Collect all signals
  const allSigs = [];
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
    const sigs = detect(bars, bands);
    for (const sig of sigs) {
      const week = Math.floor(sig.barIdx / (1440 * 7));
      const hour = sig.time ? new Date(sig.time).getUTCHours() : 0;
      allSigs.push({ ...sig, symbol, week, hour });
    }
    process.stdout.write('\r  ' + symbol);
  }
  console.log('\n');

  // ═══════════════════════════════════════════════════
  // PART 1: Orders 1-3 combined
  // ═══════════════════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PART 1: Orders 1-3 combined vs Orders 4-6                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const [label, filter] of [['Orders 1-3', s => s.maxOrder <= 3], ['Orders 4-6', s => s.maxOrder >= 4], ['All orders', () => true]]) {
    const sigs = allSigs.filter(filter);
    const total = sigs.length;
    const wins = sigs.filter(s => s.won).length;
    const rets = sigs.map(s => s.returnPct);
    const mean = rets.reduce((s, r) => s + r, 0) / total;
    const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / total);
    const avgHoldDays = sigs.reduce((s, r) => s + r.holdDuration, 0) / total / 1440;
    const tradesPerYear = avgHoldDays > 0 ? 365 / avgHoldDays : 365;
    const sr = std > 0 ? (mean / std) * Math.sqrt(Math.min(tradesPerYear, 365)) : 0;

    const allWeeks = [...new Set(sigs.map(s => s.week))].sort((a, b) => a - b);
    const profWeeks = allWeeks.filter(w => sigs.filter(s => s.week === w).reduce((s, r) => s + r.returnPct, 0) > 0).length;

    console.log('  ' + label.padEnd(12) + ': ' + total + ' trades | Avg=' + Math.round(mean * 100) + ' bps | WR=' + (wins/total*100).toFixed(1) + '% | SR=' + sr.toFixed(2) + ' | Prof weeks=' + profWeeks + '/' + allWeeks.length);

    // Weekly detail
    if (label === 'Orders 1-3') {
      console.log('\n    Weekly detail:');
      for (const w of allWeeks) {
        const ws = sigs.filter(s => s.week === w);
        const wr = ws.filter(s => s.won).length;
        const wret = ws.reduce((s, r) => s + r.returnPct, 0);
        const wavg = wret / ws.length;
        console.log('      W' + w + ': ' + ws.length + ' trades | ' + Math.round(wavg * 100) + ' bps | WR=' + (wr/ws.length*100).toFixed(1) + '% | ' + (wret >= 0 ? '+' : '') + wret.toFixed(1) + '%');
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // PART 2: Orders 5-6 deep dive
  // ═══════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PART 2: Orders 5-6 — What makes them different?             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const o56 = allSigs.filter(s => s.maxOrder >= 5);
  const o13 = allSigs.filter(s => s.maxOrder <= 3);

  console.log('  Total O5-6 trades: ' + o56.length + ' | O1-3 trades: ' + o13.length + '\n');

  // By coin
  console.log('  === By Coin (O5-6) ===');
  const coinBuckets = {};
  o56.forEach(s => { if (!coinBuckets[s.symbol]) coinBuckets[s.symbol] = []; coinBuckets[s.symbol].push(s); });
  const coinEntries = Object.entries(coinBuckets).sort((a, b) => b[1].length - a[1].length);
  console.log('  Coin           | Trades | WR%   | Avg Bps');
  console.log('  ' + '-'.repeat(45));
  for (const [sym, sigs] of coinEntries) {
    const avg = sigs.reduce((s, r) => s + r.returnPct, 0) / sigs.length;
    const wr = sigs.filter(s => s.won).length / sigs.length * 100;
    console.log('  ' + sym.padEnd(16) + ' | ' + String(sigs.length).padStart(6) + ' | ' + wr.toFixed(1).padStart(5) + '% | ' + String(Math.round(avg * 100)).padStart(7));
  }

  // By cycle
  console.log('\n  === By Cycle (O5-6 vs O1-3) ===');
  console.log('  Cycle | O56 Trades | O56 Bps | O13 Trades | O13 Bps');
  console.log('  ' + '-'.repeat(55));
  for (let cycle = 30; cycle <= 40; cycle++) {
    const s56 = o56.filter(s => s.maxCycle === cycle);
    const s13 = o13.filter(s => s.maxCycle === cycle);
    const avg56 = s56.length > 0 ? s56.reduce((s, r) => s + r.returnPct, 0) / s56.length : 0;
    const avg13 = s13.length > 0 ? s13.reduce((s, r) => s + r.returnPct, 0) / s13.length : 0;
    console.log('  ' + String(cycle).padStart(5) + ' | ' + String(s56.length).padStart(10) + ' | ' + String(Math.round(avg56 * 100)).padStart(7) + ' | ' + String(s13.length).padStart(10) + ' | ' + String(Math.round(avg13 * 100)).padStart(7));
  }

  // By direction
  console.log('\n  === By Direction ===');
  for (const dir of ['LONG', 'SHORT']) {
    const s56 = o56.filter(s => s.type === dir);
    const s13 = o13.filter(s => s.type === dir);
    const avg56 = s56.length > 0 ? Math.round(s56.reduce((s, r) => s + r.returnPct, 0) / s56.length * 100) : 0;
    const avg13 = s13.length > 0 ? Math.round(s13.reduce((s, r) => s + r.returnPct, 0) / s13.length * 100) : 0;
    console.log('  ' + dir + ': O56=' + s56.length + ' trades ' + avg56 + ' bps | O13=' + s13.length + ' trades ' + avg13 + ' bps');
  }

  // By strength
  console.log('\n  === By Strength (O5-6) ===');
  const strBuckets = {};
  o56.forEach(s => { const k = s.strength; if (!strBuckets[k]) strBuckets[k] = []; strBuckets[k].push(s); });
  console.log('  Str   | Trades | WR%   | Avg Bps');
  console.log('  ' + '-'.repeat(40));
  for (const [str, sigs] of Object.entries(strBuckets).sort((a, b) => +a[0] - +b[0])) {
    const avg = sigs.reduce((s, r) => s + r.returnPct, 0) / sigs.length;
    const wr = sigs.filter(s => s.won).length / sigs.length * 100;
    console.log('  ' + String(str).padStart(5) + ' | ' + String(sigs.length).padStart(6) + ' | ' + wr.toFixed(1).padStart(5) + '% | ' + String(Math.round(avg * 100)).padStart(7));
  }

  // By hour of day
  console.log('\n  === By Hour of Day (O5-6 vs O1-3) ===');
  console.log('  Hour | O56 Trades | O56 Bps | O13 Trades | O13 Bps');
  console.log('  ' + '-'.repeat(55));
  for (let h = 0; h < 24; h++) {
    const s56 = o56.filter(s => s.hour === h);
    const s13 = o13.filter(s => s.hour === h);
    if (s56.length === 0 && s13.length === 0) continue;
    const avg56 = s56.length > 0 ? Math.round(s56.reduce((s, r) => s + r.returnPct, 0) / s56.length * 100) : 0;
    const avg13 = s13.length > 0 ? Math.round(s13.reduce((s, r) => s + r.returnPct, 0) / s13.length * 100) : 0;
    console.log('  ' + String(h).padStart(4) + ' | ' + String(s56.length).padStart(10) + ' | ' + String(avg56).padStart(7) + ' | ' + String(s13.length).padStart(10) + ' | ' + String(avg13).padStart(7));
  }

  // Hold duration comparison
  console.log('\n  === Hold Duration ===');
  const avgHold56 = o56.reduce((s, r) => s + r.holdDuration, 0) / o56.length;
  const avgHold13 = o13.reduce((s, r) => s + r.holdDuration, 0) / o13.length;
  console.log('  O5-6 avg hold: ' + avgHold56.toFixed(1) + ' bars (' + (avgHold56).toFixed(0) + ' mins)');
  console.log('  O1-3 avg hold: ' + avgHold13.toFixed(1) + ' bars (' + (avgHold13).toFixed(0) + ' mins)');

  c.release(); pool.end();
})();
