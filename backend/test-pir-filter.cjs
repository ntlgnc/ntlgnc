/**
 * Test PiR filter: Orders 1-3, PiR 0.2-0.8, top 30, 45 days.
 * Compare filtered vs unfiltered, weekly consistency.
 * Also simulate hedged pairs.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PHI = 1.6180339887;
const ORDERS_TO_USE = [1, 2, 3, 4, 5, 6];

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
      const ei = pos.entryIdx, lb = Math.min(60, ei);
      const slice = bars.slice(Math.max(0, ei - lb), ei + 1);
      const closes = slice.map(b => b.close);
      const min60 = Math.min(...closes), max60 = Math.max(...closes);
      const pir = (max60 - min60) > 0 ? (closes[closes.length - 1] - min60) / (max60 - min60) : 0.5;
      signals.push({...pos, returnPct: +r.toFixed(4), won: r > 0, posInRange: pir,
        week: Math.floor(ei / (1440 * 7)), barIdx: ei});
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

function buildPairsExclusive(sigs, maxGapBars) {
  const pairs = []; const used = new Set();
  const barIndex = new Map();
  for (let i = 0; i < sigs.length; i++) { const b = sigs[i].barIdx; if (!barIndex.has(b)) barIndex.set(b, []); barIndex.get(b).push(i); }
  for (let ai = 0; ai < sigs.length; ai++) {
    if (used.has(ai)) continue; const A = sigs[ai];
    let bestBi = -1, bestScore = -Infinity;
    for (let bar = A.barIdx - maxGapBars; bar <= A.barIdx; bar++) {
      const cands = barIndex.get(bar); if (!cands) continue;
      for (const bi of cands) {
        if (bi === ai || used.has(bi)) continue; const B = sigs[bi];
        if (B.type === A.type || B.symbol === A.symbol) continue;
        const gap = A.barIdx - B.barIdx;
        const bExit = B.barIdx + B.holdDuration;
        const bRem = bExit - A.barIdx;
        if (bRem < 1) continue;
        const dur = Math.min(A.holdDuration, bRem);
        const score = (gap === 0 ? 100000 : 0) + dur * 100 - gap * 10 + B.strength;
        if (score > bestScore) { bestScore = score; bestBi = bi; }
      }
    }
    if (bestBi >= 0) {
      const B = sigs[bestBi];
      // Use raw returnPct sum as approximation (actual price-based would be better)
      const pairRet = A.returnPct + B.returnPct;
      pairs.push({ pairReturn: +pairRet.toFixed(4), won: pairRet > 0, week: A.week });
      used.add(ai); used.add(bestBi);
    }
  }
  return pairs;
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
    for (let cycle = 30; cycle <= 40; cycle++) for (const order of ORDERS_TO_USE) bands.push(computeFracmap(bars.map(b => b.high), bars.map(b => b.low), cycle, order));
    const sigs = detect(bars, bands);
    sigs.forEach(s => { s.symbol = symbol; allSigs.push(s); });
    process.stdout.write('\r  ' + symbol);
  }
  console.log('\n');

  const configs = [
    { label: 'Baseline (all orders, no PiR filter)', filter: () => true },
    { label: 'Orders 1-3 only', filter: s => s.maxOrder <= 3 },
    { label: 'Orders 1-3 + PiR 0.2-0.8', filter: s => s.maxOrder <= 3 && s.posInRange >= 0.2 && s.posInRange < 0.8 },
    { label: 'Orders 1-2 + PiR 0.2-0.8', filter: s => s.maxOrder <= 2 && s.posInRange >= 0.2 && s.posInRange < 0.8 },
    { label: 'All orders + PiR 0.2-0.8', filter: s => s.posInRange >= 0.2 && s.posInRange < 0.8 },
    { label: 'Orders 1-3 + PiR 0.15-0.85', filter: s => s.maxOrder <= 3 && s.posInRange >= 0.15 && s.posInRange < 0.85 },
  ];

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  FILTER COMPARISON — Unhedged + Hedged, 45 days, Top 30             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  console.log('  Config                            | Trades | Avg Bps | WR%   | Prof Wks | Pairs | Pair Bps | Pair WR | Pair Prof Wks');
  console.log('  ' + '-'.repeat(115));

  for (const cfg of configs) {
    const sigs = allSigs.filter(cfg.filter);
    const n = sigs.length;
    if (n === 0) continue;
    const wins = sigs.filter(s => s.won).length;
    const avgBps = Math.round(sigs.reduce((s, r) => s + r.returnPct, 0) / n * 100);
    const wr = (wins / n * 100).toFixed(1);
    const weeks = [...new Set(sigs.map(s => s.week))].sort((a, b) => a - b);
    const profWeeks = weeks.filter(w => sigs.filter(s => s.week === w).reduce((s, r) => s + r.returnPct, 0) > 0).length;

    // Hedged pairs
    const sorted = [...sigs].sort((a, b) => a.barIdx - b.barIdx);
    const pairs = buildPairsExclusive(sorted, 5);
    const pairN = pairs.length;
    const pairAvgBps = pairN > 0 ? Math.round(pairs.reduce((s, r) => s + r.pairReturn, 0) / pairN * 100) : 0;
    const pairWR = pairN > 0 ? (pairs.filter(p => p.won).length / pairN * 100).toFixed(1) : '0';
    const pairProfWeeks = pairN > 0 ? weeks.filter(w => pairs.filter(p => p.week === w).reduce((s, r) => s + r.pairReturn, 0) > 0).length : 0;

    console.log('  ' + cfg.label.padEnd(36) +
      '| ' + String(n).padStart(6) +
      ' | ' + String(avgBps).padStart(7) +
      ' | ' + wr.padStart(5) + '%' +
      ' | ' + (profWeeks + '/' + weeks.length).padStart(8) +
      ' | ' + String(pairN).padStart(5) +
      ' | ' + String(pairAvgBps).padStart(8) +
      ' | ' + pairWR.padStart(6) + '%' +
      ' | ' + (pairProfWeeks + '/' + weeks.length).padStart(13));
  }

  c.release(); pool.end();
})();
