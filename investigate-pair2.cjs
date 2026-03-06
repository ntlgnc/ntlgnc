const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.6180339887;

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
    for (let j = start; j <= clampEnd; j++) { wMax = Math.max(wMax, highs[j], lows[j]); wMin = Math.min(wMin, highs[j], lows[j]); }
    lower[i] = (1 - phiO) * wMax + phiO * wMin;
    upper[i] = (1 - phiO) * wMin + phiO * wMax;
  }
  return { lower, upper };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // CAKE SHORT triggered at 21:19 — get ~120 bars before that
  // ATOM LONG triggered at 21:40

  for (const { sym, dir, triggerTime, cycle, order } of [
    { sym: 'CAKEUSDT', dir: 'SHORT', triggerTime: '2026-03-05 21:19:00', cycle: 88, order: 1 },
    { sym: 'ATOMUSDT', dir: 'LONG', triggerTime: '2026-03-05 21:40:00', cycle: 58, order: 3 },
  ]) {
    // Load bars leading up to trigger
    const { rows: bars } = await c.query(`
      SELECT timestamp, open, high, low, close
      FROM "Candle1m"
      WHERE symbol = $1
        AND timestamp <= $2::timestamptz
      ORDER BY timestamp DESC
      LIMIT 200
    `, [sym, triggerTime]);
    bars.reverse();

    const highs = bars.map(b => +b.high);
    const lows = bars.map(b => +b.low);
    const n = bars.length;
    const lastIdx = n - 1;
    const lastBar = bars[lastIdx];

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`${sym} ${dir} — trigger bar: ${triggerTime}`);
    console.log(`  maxCycle: ${cycle}, maxOrder: ${order}`);
    console.log(`  Trigger bar: O:${lastBar.open} H:${lastBar.high} L:${lastBar.low} C:${lastBar.close}`);
    console.log(`${'═'.repeat(65)}`);

    // Show the last 5 bars
    console.log('\n  Last 5 bars:');
    for (let i = Math.max(0, n - 5); i < n; i++) {
      const b = bars[i];
      console.log(`    ${b.timestamp} O:${b.open} H:${b.high} L:${b.low} C:${b.close}`);
    }

    // Compute the triggering band (cycle, order) and show bands around trigger
    const band = computeFracmap(highs, lows, cycle, order);
    const lo = band.lower[lastIdx];
    const up = band.upper[lastIdx];

    console.log(`\n  Fracmap band (cycle=${cycle}, order=${order}) at trigger bar:`);
    console.log(`    Lower: ${lo ? lo.toFixed(6) : 'null'}`);
    console.log(`    Upper: ${up ? up.toFixed(6) : 'null'}`);
    console.log(`    Bar Low: ${lastBar.low}, Bar High: ${lastBar.high}, Bar Close: ${lastBar.close}`);

    if (dir === 'SHORT') {
      console.log(`\n  SHORT signal check: high(${lastBar.high}) > upper(${up?.toFixed(6)}) AND close(${lastBar.close}) < upper(${up?.toFixed(6)})?`);
      console.log(`    Pierce above: ${+lastBar.high > up} | Close below: ${+lastBar.close < up} | SIGNAL: ${+lastBar.high > up && +lastBar.close < up}`);
    } else {
      console.log(`\n  LONG signal check: low(${lastBar.low}) < lower(${lo?.toFixed(6)}) AND close(${lastBar.close}) > lower(${lo?.toFixed(6)})?`);
      console.log(`    Pierce below: ${+lastBar.low < lo} | Close above: ${+lastBar.close > lo} | SIGNAL: ${+lastBar.low < lo && +lastBar.close > lo}`);
    }

    // Also show bands from neighbouring cycles to understand the ensemble vote
    console.log(`\n  Ensemble bands at trigger bar (all orders for nearby cycles):`);
    let buyVotes = 0, sellVotes = 0;
    const votingBands = [];
    for (let ord = 1; ord <= 6; ord++) {
      for (let cyc = 10; cyc <= 100; cyc++) {
        if (cyc < 55) continue; // minCyc=55 for 1m
        const b = computeFracmap(highs, lows, cyc, ord);
        const bLo = b.lower[lastIdx];
        const bUp = b.upper[lastIdx];
        if (bLo === null || bUp === null || bUp <= bLo) continue;
        const bandWidth = (bUp - bLo) / ((bUp + bLo) / 2);
        if (bandWidth < 0.0001) continue;

        const buyAtI = +lastBar.low < bLo && +lastBar.close > bLo;
        const sellAtI = +lastBar.high > bUp && +lastBar.close < bUp;
        if (buyAtI) {
          buyVotes++;
          votingBands.push({ cyc, ord, type: 'BUY', lo: bLo.toFixed(6), up: bUp.toFixed(6) });
        }
        if (sellAtI) {
          sellVotes++;
          votingBands.push({ cyc, ord, type: 'SELL', lo: bLo.toFixed(6), up: bUp.toFixed(6) });
        }
      }
    }
    console.log(`    BUY votes: ${buyVotes}, SELL votes: ${sellVotes}`);
    if (votingBands.length <= 20) {
      for (const vb of votingBands) {
        console.log(`      ${vb.type} cycle=${vb.cyc} order=${vb.ord} lo=${vb.lo} up=${vb.up}`);
      }
    } else {
      console.log(`    (${votingBands.length} voting bands — showing first 15)`);
      for (const vb of votingBands.slice(0, 15)) {
        console.log(`      ${vb.type} cycle=${vb.cyc} order=${vb.ord} lo=${vb.lo} up=${vb.up}`);
      }
    }

    // What was the price doing in the 10 bars before trigger?
    console.log(`\n  Price action in 10 bars before trigger:`);
    const slice = bars.slice(Math.max(0, n - 11), n);
    const startP = +slice[0].close;
    const endP = +slice[slice.length - 1].close;
    const change = ((endP / startP) - 1) * 100;
    console.log(`    ${startP} → ${endP} (${change >= 0 ? '+' : ''}${change.toFixed(3)}%)`);
    const minLow = Math.min(...slice.map(b => +b.low));
    const maxHigh = Math.max(...slice.map(b => +b.high));
    console.log(`    Range: ${minLow} – ${maxHigh} (${((maxHigh / minLow - 1) * 100).toFixed(3)}%)`);
  }

  await c.end();
})();
