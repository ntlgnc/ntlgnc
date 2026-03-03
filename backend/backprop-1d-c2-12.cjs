/**
 * Back-propagate 1D C2-12 signals with hedging (10 days).
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const crypto = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PHI = 1.6180339887;

function computeFracmap(highs, lows, cycle, order) {
  const zfracR = Math.round(cycle / 3.0), phiO = Math.pow(PHI, order), n = highs.length;
  const forwardBars = Math.round(cycle / 3), totalLen = n + forwardBars;
  const lower = new Array(totalLen).fill(null), upper = new Array(totalLen).fill(null);
  for (let i = (order + 1) * zfracR; i < totalLen; i++) {
    const start = i - (order + 1) * zfracR, end = i - order * zfracR;
    if (start < 0 || start >= n) continue; const ce = Math.min(end, n - 1); if (ce < start) continue;
    let wMax = -Infinity, wMin = Infinity;
    for (let j = start; j <= ce; j++) { wMax = Math.max(wMax, highs[j], lows[j]); wMin = Math.min(wMin, highs[j], lows[j]); }
    lower[i] = (1 - phiO) * wMax + phiO * wMin; upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper, cycle, order };
}

function detect(bars, bands) {
  const signals = []; let pos = null; const n = bars.length;
  const isPL = (i, w) => { for (let j = Math.max(0, i - w); j < i; j++) if (bars[j].low < bars[i].low) return false; return true; };
  const isPH = (i, w) => { for (let j = Math.max(0, i - w); j < i; j++) if (bars[j].high > bars[i].high) return false; return true; };
  for (let i = 1; i < n; i++) {
    if (pos && i >= pos.exitIdx) { const ep = bars[i].open; const r = pos.type === 'LONG' ? (ep/pos.entryPrice-1)*100 : (pos.entryPrice/ep-1)*100; signals.push({...pos, exitPrice: ep, returnPct: +r.toFixed(3), won: r > 0}); pos = null; }
    if (pos) continue;
    let bs = 0, ss = 0, mbc = 0, msc = 0, mbo = 0, mso = 0;
    for (const b of bands) { const lo = b.lower[i], up = b.upper[i]; if (lo === null || up === null || up <= lo || (up-lo)/((up+lo)/2) < 0.0001) continue;
      if (bars[i].low < lo && bars[i].close > lo) { bs++; if (b.cycle > mbc) mbc = b.cycle; if (b.order > mbo) mbo = b.order; }
      if (bars[i].high > up && bars[i].close < up) { ss++; if (b.cycle > msc) msc = b.cycle; if (b.order > mso) mso = b.order; }
    }
    if (bs >= 1 && bs >= ss) { if (isPL(i, Math.round(mbc/2)) && i+1 < n) { const hd = Math.round(mbc/2); pos = {type:'LONG',entryIdx:i+1,entryPrice:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:mbc,maxOrder:mbo,time:bars[i+1].time,strength:bs}; } }
    else if (ss >= 1) { if (isPH(i, Math.round(msc/2)) && i+1 < n) { const hd = Math.round(msc/2); pos = {type:'SHORT',entryIdx:i+1,entryPrice:bars[i+1].open,exitIdx:Math.min(i+1+hd,n-1),holdDuration:hd,maxCycle:msc,maxOrder:mso,time:bars[i+1].time,strength:ss}; } }
  }
  if (pos) { const ep = bars[n-1].close; const r = pos.type==='LONG'?(ep/pos.entryPrice-1)*100:(pos.entryPrice/ep-1)*100; signals.push({...pos,exitPrice:ep,returnPct:+r.toFixed(3),won:r>0}); }
  return signals;
}

(async () => {
  const client = await pool.connect();
  try {
    const { rows: [strat] } = await client.query("SELECT id FROM \"FracmapStrategy\" WHERE name = 'Universal 1D - C2-C12' AND active = true");
    if (!strat) { console.log('Not found'); return; }
    console.log('Strategy: Universal 1D - C2-C12');
    await client.query('DELETE FROM "FracmapSignal" WHERE "strategyId" = $1', [strat.id]);
    const { rows: coins } = await client.query("SELECT DISTINCT symbol FROM \"Candle1d\" GROUP BY symbol HAVING COUNT(*) >= 200");
    console.log('Coins: ' + coins.length);
    let total = 0, closed = 0, open = 0;
    for (const { symbol } of coins) {
      const { rows } = await client.query("SELECT timestamp as time, open, high, low, close FROM \"Candle1d\" WHERE symbol = $1 ORDER BY timestamp ASC", [symbol]);
      if (rows.length < 200) continue;
      const bars = rows.map(r => ({time:r.time,open:+r.open,high:+r.high,low:+r.low,close:+r.close}));
      const h = bars.map(b=>b.high), l = bars.map(b=>b.low), bands = [];
      for (let c = 2; c <= 12; c++) for (const o of [1,2,3,4,5,6]) bands.push(computeFracmap(h, l, c, o));
      const sigs = detect(bars, bands);
      for (const sig of sigs.filter(s => s.entryIdx >= bars.length - 10)) {
        const bt = bars[sig.entryIdx].time, et = new Date(new Date(bt).getTime() + sig.holdDuration * 86400000);
        if (et <= new Date()) {
          const ei = Math.min(sig.entryIdx + sig.holdDuration, bars.length - 1), ep = bars[ei].open;
          const r = sig.type==='LONG'?(ep/sig.entryPrice-1)*100:(sig.entryPrice/ep-1)*100;
          await client.query("INSERT INTO \"FracmapSignal\" (\"strategyId\",symbol,direction,\"entryPrice\",strength,\"holdBars\",\"maxCycle\",\"maxOrder\",status,\"exitPrice\",\"returnPct\",\"closedAt\",\"createdAt\") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'closed',$9,$10,$11,$12)",
            [strat.id,symbol,sig.type,sig.entryPrice,sig.strength,sig.holdDuration,sig.maxCycle,sig.maxOrder,ep,+(r.toFixed(4)),et,bt]);
          closed++;
        } else {
          await client.query("INSERT INTO \"FracmapSignal\" (\"strategyId\",symbol,direction,\"entryPrice\",strength,\"holdBars\",\"maxCycle\",\"maxOrder\",status,\"createdAt\") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)",
            [strat.id,symbol,sig.type,sig.entryPrice,sig.strength,sig.holdDuration,sig.maxCycle,sig.maxOrder,bt]);
          open++;
        }
        total++;
      }
    }
    console.log('Signals: ' + total + ' (closed=' + closed + ' open=' + open + ')');
    const { rows: [sm] } = await client.query("SELECT AVG(\"returnPct\") FILTER (WHERE status='closed') as a, SUM(\"returnPct\") FILTER (WHERE status='closed') as t, COUNT(*) FILTER (WHERE status='closed' AND \"returnPct\">0)::int as w, COUNT(*) FILTER (WHERE status='closed')::int as c FROM \"FracmapSignal\" WHERE \"strategyId\"=$1", [strat.id]);
    if (sm.c > 0) console.log('Avg:' + (+sm.a>=0?'+':'') + (+sm.a).toFixed(3) + '% Total:' + (+sm.t>=0?'+':'') + (+sm.t).toFixed(1) + '% WR:' + (sm.w/sm.c*100).toFixed(1) + '%');

    console.log('Pairing...');
    const { rows: ss } = await client.query("SELECT id,symbol,direction,strength,status,\"returnPct\",\"createdAt\" FROM \"FracmapSignal\" WHERE \"strategyId\"=$1 AND pair_id IS NULL ORDER BY \"createdAt\" ASC", [strat.id]);
    const used = new Set(); let paired = 0;
    for (let i = 0; i < ss.length; i++) {
      if (used.has(ss[i].id)) continue; const A = ss[i]; let bi = -1, bs2 = -Infinity;
      for (let j = 0; j < i; j++) { if (used.has(ss[j].id)) continue; const B = ss[j];
        if (B.direction===A.direction||B.symbol===A.symbol) continue;
        const g = new Date(A.createdAt).getTime()-new Date(B.createdAt).getTime();
        if (g<0||g>86400000) continue;
        const sc = (g<3600000?100000:0)+B.strength*10-g/86400;
        if (sc > bs2) { bs2 = sc; bi = j; }
      }
      if (bi >= 0) { const B = ss[bi], pid = crypto.randomUUID();
        let pr = null; if (A.status==='closed'&&B.status==='closed'&&A.returnPct!=null&&B.returnPct!=null) pr=+(parseFloat(A.returnPct)+parseFloat(B.returnPct)).toFixed(4);
        await client.query("UPDATE \"FracmapSignal\" SET pair_id=$1,pair_symbol=$2,pair_direction=$3,pair_return=$4 WHERE id=$5",[pid,B.symbol,B.direction,pr,A.id]);
        await client.query("UPDATE \"FracmapSignal\" SET pair_id=$1,pair_symbol=$2,pair_direction=$3,pair_return=$4 WHERE id=$5",[pid,A.symbol,A.direction,pr,B.id]);
        used.add(A.id); used.add(B.id); paired++;
      }
    }
    console.log('Pairs: ' + paired);
  } finally { client.release(); pool.end(); }
})();
