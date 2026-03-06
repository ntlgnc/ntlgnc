require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.618034;
function computeFracmap(highs, lows, cycle, order) {
  const zfracR = Math.round(cycle / 3.0);
  const phiO = Math.pow(PHI, order);
  const n = highs.length;
  const forwardBars = Math.round(cycle / 3);
  const totalLen = n + forwardBars;
  const lower = new Array(totalLen).fill(null);
  const upper = new Array(totalLen).fill(null);
  const minIdx = (order + 1) * zfracR;
  for (let i = minIdx; i < totalLen; i++) {
    const start = i - (order + 1) * zfracR;
    const end = i - order * zfracR;
    if (start < 0 || start >= n) continue;
    const clampEnd = Math.min(end, n - 1);
    if (clampEnd < start) continue;
    let wMax = -Infinity, wMin = Infinity;
    for (let j = start; j <= clampEnd; j++) {
      wMax = Math.max(wMax, highs[j], lows[j]);
      wMin = Math.min(wMin, highs[j], lows[j]);
    }
    lower[i] = (1 - phiO) * wMax + phiO * wMin;
    upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper, forwardBars, cycle, order };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // Test BTCUSDT 1h
  const barsNeeded = 89 * 8;
  const maxAge = 60 * barsNeeded * 60000 * 1.5;
  const { rows } = await c.query(
    `SELECT timestamp as time, open, high, low, close FROM "Candle1h"
     WHERE symbol = 'BTCUSDT' AND timestamp >= $1
     ORDER BY timestamp DESC LIMIT $2`,
    [new Date(Date.now() - maxAge), barsNeeded]
  );
  console.log('BTCUSDT 1h bars fetched:', rows.length);
  const minBars = Math.min(200, Math.floor(barsNeeded * 0.8));
  console.log('Min bars required:', minBars, 'Pass?', rows.length >= minBars);

  const bars = rows.slice().reverse().map(r => ({
    time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close,
  }));
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);

  const allBands = [];
  for (let order = 1; order <= 6; order++) {
    for (let cycle = 55; cycle <= 89; cycle++) {
      allBands.push(computeFracmap(highs, lows, cycle, order));
    }
  }
  console.log('Bands computed:', allBands.length);

  // Check last 10 bars for any touches
  for (let offset = 1; offset <= 10; offset++) {
    const i = bars.length - offset - 1;
    if (i < 0) break;
    let longStr = 0, shortStr = 0;
    for (const band of allBands) {
      const lo = band.lower[i], up = band.upper[i];
      if (lo !== null && bars[i].low <= lo) longStr++;
      if (up !== null && bars[i].high >= up) shortStr++;
    }
    const ts = new Date(bars[i].time).toISOString().slice(0, 16);
    console.log('Bar[-' + offset + '] ' + ts + ' close=' + bars[i].close + ' longTouches=' + longStr + ' shortTouches=' + shortStr);
  }

  // Try popular coins on 1m
  console.log('\n--- 1m timeframe (top coins) ---');
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT']) {
    const { rows: r1m } = await c.query(
      `SELECT timestamp as time, open, high, low, close FROM "Candle1m"
       WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 900`,
      [sym]
    );
    if (r1m.length < 200) { console.log(sym + ' 1m: only ' + r1m.length + ' bars, skipping'); continue; }
    const b = r1m.slice().reverse().map(r => ({ time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close }));
    const h = b.map(x => x.high), l = b.map(x => x.low);
    const bands1m = [];
    for (let order = 1; order <= 6; order++) {
      for (let cycle = 10; cycle <= 100; cycle++) {
        bands1m.push(computeFracmap(h, l, cycle, order));
      }
    }
    const li = b.length - 2;
    let ls = 0, ss = 0;
    for (const band of bands1m) {
      if (band.lower[li] !== null && b[li].low <= band.lower[li]) ls++;
      if (band.upper[li] !== null && b[li].high >= band.upper[li]) ss++;
    }
    console.log(sym + ' 1m: bars=' + b.length + ' close=' + b[li].close + ' longTouches=' + ls + ' shortTouches=' + ss + ' (need minCyc>=55 to trigger)');
  }

  await c.end();
})();
