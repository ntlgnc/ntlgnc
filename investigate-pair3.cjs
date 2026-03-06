const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.6180339887;

function computeFracmap(highs, lows, cycle, order) {
  const zfracR = Math.round(cycle / 3.0);
  const phiO = Math.pow(PHI, order);
  const n = highs.length;
  const totalLen = n + Math.round(cycle / 3);
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

  // Signal detection happens at bar i, entry at bar i+1.
  // CAKE createdAt=21:19:31 → entry bar is 21:19, so detection bar is 21:18 (or 21:17 via nearMiss)
  // ATOM createdAt=21:40:30 → entry bar is 21:40, so detection bar is 21:39 (or 21:38 via nearMiss)

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  WHY CAKE GOT SHORT AND ATOM GOT LONG DESPITE CORRELATION       ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  for (const { sym, dir, detectionBar, entryBar, entryPrice } of [
    { sym: 'CAKEUSDT', dir: 'SHORT', detectionBar: '2026-03-05 21:18:00', entryBar: '2026-03-05 21:19:00', entryPrice: 1.398 },
    { sym: 'ATOMUSDT', dir: 'LONG', detectionBar: '2026-03-05 21:39:00', entryBar: '2026-03-05 21:40:00', entryPrice: 1.842 },
  ]) {
    // Load bars up to and including detection bar
    const { rows: bars } = await c.query(`
      SELECT timestamp, open, high, low, close
      FROM "Candle1m"
      WHERE symbol = $1 AND timestamp <= $2::timestamptz
      ORDER BY timestamp DESC LIMIT 200
    `, [sym, detectionBar]);
    bars.reverse();

    const highs = bars.map(b => +b.high);
    const lows = bars.map(b => +b.low);
    const n = bars.length;
    const lastIdx = n - 1;
    const lastBar = bars[lastIdx];
    const prevBar = bars[lastIdx - 1];

    console.log(`${'═'.repeat(65)}`);
    console.log(`${sym} ${dir}`);
    console.log(`  Detection bar (i): ${detectionBar}`);
    console.log(`  Entry bar (i+1): ${entryBar}`);
    console.log(`${'═'.repeat(65)}`);

    // Show detection bar and previous bar
    console.log(`\n  Bar i-1: O:${prevBar.open} H:${prevBar.high} L:${prevBar.low} C:${prevBar.close}`);
    console.log(`  Bar i  : O:${lastBar.open} H:${lastBar.high} L:${lastBar.low} C:${lastBar.close}`);

    // Check all ensemble bands at detection bar AND previous bar (nearMiss)
    let buyVotesI = 0, sellVotesI = 0;
    let buyVotesPrev = 0, sellVotesPrev = 0;
    const sellingBands = [];
    const buyingBands = [];

    for (let ord = 1; ord <= 6; ord++) {
      for (let cyc = 55; cyc <= 100; cyc++) {
        const b = computeFracmap(highs, lows, cyc, ord);
        const bLoI = b.lower[lastIdx];
        const bUpI = b.upper[lastIdx];
        const bLoPrev = b.lower[lastIdx - 1];
        const bUpPrev = b.upper[lastIdx - 1];

        // Check at bar i
        if (bLoI !== null && bUpI !== null && bUpI > bLoI) {
          const bandWidth = (bUpI - bLoI) / ((bUpI + bLoI) / 2);
          if (bandWidth >= 0.0001) {
            const buyAtI = +lastBar.low < bLoI && +lastBar.close > bLoI;
            const sellAtI = +lastBar.high > bUpI && +lastBar.close < bUpI;
            if (buyAtI) { buyVotesI++; buyingBands.push({ cyc, ord, src: 'bar_i', lo: bLoI, up: bUpI }); }
            if (sellAtI) { sellVotesI++; sellingBands.push({ cyc, ord, src: 'bar_i', lo: bLoI, up: bUpI }); }
          }
        }

        // Check at bar i-1 (nearMiss candidate)
        if (bLoPrev !== null && bUpPrev !== null && bUpPrev > bLoPrev) {
          const bandWidth = (bUpPrev - bLoPrev) / ((bUpPrev + bLoPrev) / 2);
          if (bandWidth >= 0.0001) {
            const buyPrev = +prevBar.low < bLoPrev && +prevBar.close > bLoPrev;
            const sellPrev = +prevBar.high > bUpPrev && +prevBar.close < bUpPrev;
            if (buyPrev) { buyVotesPrev++; buyingBands.push({ cyc, ord, src: 'bar_i-1(nearMiss)', lo: bLoPrev, up: bUpPrev }); }
            if (sellPrev) { sellVotesPrev++; sellingBands.push({ cyc, ord, src: 'bar_i-1(nearMiss)', lo: bLoPrev, up: bUpPrev }); }
          }
        }
      }
    }

    const totalBuy = buyVotesI + buyVotesPrev;
    const totalSell = sellVotesI + sellVotesPrev;

    console.log(`\n  Ensemble votes at detection:`);
    console.log(`    BUY:  ${buyVotesI} at bar i + ${buyVotesPrev} nearMiss = ${totalBuy} total`);
    console.log(`    SELL: ${sellVotesI} at bar i + ${sellVotesPrev} nearMiss = ${totalSell} total`);

    if (dir === 'SHORT' && sellingBands.length > 0) {
      console.log(`\n  SELL voting bands (top 10):`);
      for (const sb of sellingBands.slice(0, 10)) {
        console.log(`    cycle=${sb.cyc} order=${sb.ord} [${sb.src}] upper=${sb.up.toFixed(6)} lower=${sb.lo.toFixed(6)}`);
      }
      const uniqueUppers = [...new Set(sellingBands.map(b => b.up.toFixed(6)))];
      console.log(`  Unique upper band levels: ${uniqueUppers.join(', ')}`);
    }
    if (dir === 'LONG' && buyingBands.length > 0) {
      console.log(`\n  BUY voting bands (top 10):`);
      for (const bb of buyingBands.slice(0, 10)) {
        console.log(`    cycle=${bb.cyc} order=${bb.ord} [${bb.src}] lower=${bb.lo.toFixed(6)} upper=${bb.up.toFixed(6)}`);
      }
      const uniqueLowers = [...new Set(buyingBands.map(b => b.lo.toFixed(6)))];
      console.log(`  Unique lower band levels: ${uniqueLowers.join(', ')}`);
    }

    // Show the band context: where was price relative to bands?
    console.log(`\n  CONTEXT — What was happening:`);
    if (dir === 'SHORT') {
      const upperBand = sellingBands.length > 0 ? sellingBands[0].up : null;
      if (upperBand) {
        console.log(`    Price (H:${lastBar.high}) poked above upper band (${upperBand.toFixed(4)})`);
        console.log(`    Then closed back below it (C:${lastBar.close})`);
        console.log(`    → "Hit the ceiling and bounced" = SHORT reversal signal`);
        console.log(`    Band width: ${((sellingBands[0].up - sellingBands[0].lo) / sellingBands[0].lo * 100).toFixed(3)}%`);
      }
    } else {
      const lowerBand = buyingBands.length > 0 ? buyingBands[0].lo : null;
      if (lowerBand) {
        console.log(`    Price (L:${lastBar.low}) dipped below lower band (${lowerBand.toFixed(4)})`);
        console.log(`    Then closed back above it (C:${lastBar.close})`);
        console.log(`    → "Hit the floor and bounced" = LONG reversal signal`);
        console.log(`    Band width: ${((buyingBands[0].up - buyingBands[0].lo) / buyingBands[0].lo * 100).toFixed(3)}%`);
      }
    }
  }

  // Key insight: show both coins' price changes from 21:10 to 21:45
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  CORRELATION CHECK — Both coins 21:10 to 21:45');
  console.log('═'.repeat(65));
  for (const sym of ['CAKEUSDT', 'ATOMUSDT']) {
    const { rows } = await c.query(`
      SELECT timestamp, close FROM "Candle1m"
      WHERE symbol = $1 AND timestamp >= '2026-03-05 21:10:00' AND timestamp <= '2026-03-05 21:45:00'
      ORDER BY timestamp
    `, [sym]);
    const closes = rows.map(r => `${new Date(r.timestamp).getUTCMinutes().toString().padStart(2, '0')}:${(+r.close).toFixed(4)}`);
    console.log(`  ${sym}: ${closes.join(' | ')}`);
  }

  await c.end();
})();
