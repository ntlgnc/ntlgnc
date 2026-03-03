/**
 * Update 1m strategy to top 30 most liquid coins only.
 * Then back-propagate signals and pair them.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const crypto = require('crypto');
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
    if (pos && i >= pos.exitIdx) { const ep = bars[i].open; const r = pos.type === 'LONG' ? (ep/pos.ep-1)*100 : (pos.ep/ep-1)*100; signals.push({...pos, returnPct: +r.toFixed(4), won: r > 0}); pos = null; }
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
    if (bs >= 1 && bs >= ss) { if (isPL(i, Math.round(mbc/2)) && i+1 < n) { const hd = Math.round(mbc/4); pos = {type:'LONG',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:mbc,maxOrder:mbo,strength:bs,time:bars[i+1].time}; } }
    else if (ss >= 1) { if (isPH(i, Math.round(msc/2)) && i+1 < n) { const hd = Math.round(msc/4); pos = {type:'SHORT',entryIdx:i+1,ep:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:msc,maxOrder:mso,strength:ss,time:bars[i+1].time}; } }
  }
  if (pos) { const ep = bars[n-1].close; const r = pos.type==='LONG'?(ep/pos.ep-1)*100:(pos.ep/ep-1)*100; signals.push({...pos,returnPct:+r.toFixed(4),won:r>0}); }
  return signals;
}

(async () => {
  const client = await pool.connect();
  try {
    console.log('=== Switching 1m to Top 30 coins ===\n');

    // Get top 30 by volume
    const { rows: volumes } = await client.query(`
      SELECT symbol, AVG(daily_vol) as avg_daily_vol
      FROM (SELECT symbol, timestamp::date as day, SUM(volume * close) as daily_vol
            FROM "Candle1m" WHERE timestamp > NOW() - INTERVAL '7 days'
            GROUP BY symbol, day) sub
      GROUP BY symbol ORDER BY avg_daily_vol DESC LIMIT 30
    `);
    const top30 = volumes.map(r => r.symbol);
    console.log('Top 30 coins: ' + top30.slice(0, 10).join(', ') + '...\n');

    // Deactivate old 1m strategy
    await client.query(`UPDATE "FracmapStrategy" SET active = false WHERE "barMinutes" = 1 AND active = true`);

    // Create new top-30 strategy
    const { rows: [strat] } = await client.query(
      `INSERT INTO "FracmapStrategy" (name, type, "barMinutes", "minStr", "minCyc", spike, "nearMiss", "holdDiv", "priceExt", "cycleMin", "cycleMax", active, config, "createdAt", "updatedAt")
       VALUES ($1, 'universal', 1, 1, 0, true, true, 4, true, 30, 40, true, $2, now(), now()) RETURNING id, name`,
      ['Universal 1m - C30-C40 Top30', JSON.stringify({ hedging_enabled: true, hedge_mode: 'exclusive', max_gap: 5, coin_universe: top30 })]
    );
    console.log('Created: ' + strat.name + '\n');

    // Back-propagate 5 days
    let total = 0, closed = 0, open = 0;
    for (const symbol of top30) {
      const { rows } = await client.query(
        `SELECT timestamp as time, open, high, low, close FROM "Candle1m" WHERE symbol = $1 AND timestamp > NOW() - INTERVAL '6 days' ORDER BY timestamp ASC`, [symbol]
      );
      if (rows.length < 3000) continue;
      const bars = rows.map(r => ({time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close}));
      const h = bars.map(b => b.high), l = bars.map(b => b.low);
      const bands = [];
      for (let cycle = 30; cycle <= 40; cycle++) for (const order of ORDERS) bands.push(computeFracmap(h, l, cycle, order));
      const sigs = detect(bars, bands);
      const cutoffIdx = bars.length - (5 * 1440);

      for (const sig of sigs.filter(s => s.entryIdx >= Math.max(0, cutoffIdx))) {
        const barTime = bars[sig.entryIdx].time;
        const exitTime = new Date(new Date(barTime).getTime() + sig.holdDuration * 60000);
        const dup = await client.query(`SELECT id FROM "FracmapSignal" WHERE "strategyId" = $1 AND symbol = $2 AND "createdAt" = $3 LIMIT 1`, [strat.id, symbol, barTime]);
        if (dup.rows.length > 0) continue;

        if (exitTime <= new Date()) {
          const exitIdx = Math.min(sig.entryIdx + sig.holdDuration, bars.length - 1);
          const exitPrice = bars[exitIdx].open;
          const ret = sig.type === 'LONG' ? (exitPrice / sig.ep - 1) * 100 : (sig.ep / exitPrice - 1) * 100;
          if (Math.abs(ret) > 50) continue;
          await client.query(
            `INSERT INTO "FracmapSignal" ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", status, "exitPrice", "returnPct", "closedAt", "createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'closed',$9,$10,$11,$12)`,
            [strat.id, symbol, sig.type, sig.ep, sig.strength, sig.holdDuration, sig.maxCycle, sig.maxOrder, exitPrice, +(ret.toFixed(4)), exitTime, barTime]);
          closed++;
        } else {
          await client.query(
            `INSERT INTO "FracmapSignal" ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", "maxCycle", "maxOrder", status, "createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)`,
            [strat.id, symbol, sig.type, sig.ep, sig.strength, sig.holdDuration, sig.maxCycle, sig.maxOrder, barTime]);
          open++;
        }
        total++;
      }
      process.stdout.write('\r  ' + symbol + ' total=' + total);
    }

    console.log('\n\nSignals: ' + total + ' (closed=' + closed + ' open=' + open + ')');

    // Summary
    const { rows: [s] } = await client.query(
      `SELECT AVG("returnPct") FILTER (WHERE status='closed') as a, SUM("returnPct") FILTER (WHERE status='closed') as t,
              COUNT(*) FILTER (WHERE status='closed' AND "returnPct">0)::int as w, COUNT(*) FILTER (WHERE status='closed')::int as c
       FROM "FracmapSignal" WHERE "strategyId"=$1`, [strat.id]);
    if (s.c > 0) console.log('Avg: ' + (+s.a >= 0 ? '+' : '') + (+s.a).toFixed(4) + '% | Total: ' + (+s.t >= 0 ? '+' : '') + (+s.t).toFixed(1) + '% | WR: ' + (s.w/s.c*100).toFixed(1) + '%');

    // Pair
    console.log('\nPairing...');
    const { rows: sigs } = await client.query(
      `SELECT id, symbol, direction, strength, status, "returnPct", "createdAt" FROM "FracmapSignal" WHERE "strategyId" = $1 AND pair_id IS NULL ORDER BY "createdAt" ASC`, [strat.id]);
    const used = new Set(); let paired = 0;
    for (let i = 0; i < sigs.length; i++) {
      if (used.has(sigs[i].id)) continue; const A = sigs[i];
      let bestIdx = -1, bestScore = -Infinity;
      for (let j = Math.max(0, i - 500); j < i; j++) {
        if (used.has(sigs[j].id)) continue; const B = sigs[j];
        if (B.direction === A.direction || B.symbol === A.symbol) continue;
        const gapMs = new Date(A.createdAt).getTime() - new Date(B.createdAt).getTime();
        if (gapMs < 0 || gapMs > 5 * 60000) continue;
        const score = (gapMs < 60000 ? 100000 : 0) + B.strength * 10 - gapMs / 6000;
        if (score > bestScore) { bestScore = score; bestIdx = j; }
      }
      if (bestIdx >= 0) {
        const B = sigs[bestIdx]; const pairId = crypto.randomUUID();
        let pr = null;
        if (A.status === 'closed' && B.status === 'closed' && A.returnPct != null && B.returnPct != null)
          pr = +(parseFloat(A.returnPct) + parseFloat(B.returnPct)).toFixed(4);
        await client.query('UPDATE "FracmapSignal" SET pair_id=$1, pair_symbol=$2, pair_direction=$3, pair_return=$4 WHERE id=$5', [pairId, B.symbol, B.direction, pr, A.id]);
        await client.query('UPDATE "FracmapSignal" SET pair_id=$1, pair_symbol=$2, pair_direction=$3, pair_return=$4 WHERE id=$5', [pairId, A.symbol, A.direction, pr, B.id]);
        used.add(A.id); used.add(B.id); paired++;
      }
    }
    console.log('Pairs: ' + paired);

  } finally { client.release(); pool.end(); }
})();
