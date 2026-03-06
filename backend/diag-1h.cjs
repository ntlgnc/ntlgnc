/**
 * diag-1h.cjs — Diagnose why 1h signals are sparse
 * Checks band touches, spike filter rejects, priceExt blocks
 */
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

function isLocalMax(arr, idx, w) {
  const val = arr[idx]; if (val === null) return false;
  for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) {
    if (j === idx) continue; if (arr[j] !== null && arr[j] > val) return false;
  }
  return true;
}
function isLocalMin(arr, idx, w) {
  const val = arr[idx]; if (val === null) return false;
  for (let j = Math.max(0, idx - w); j <= Math.min(arr.length - 1, idx + w); j++) {
    if (j === idx) continue; if (arr[j] !== null && arr[j] < val) return false;
  }
  return true;
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const strat = { minStr: 1, minCyc: 64, spike: true, nearMiss: true, holdDiv: 5, priceExt: true, cycleMin: 55, cycleMax: 89 };
  const totalBands = (strat.cycleMax - strat.cycleMin + 1) * 6;
  console.log('1h strategy: minStr=' + strat.minStr + ' minCyc=' + strat.minCyc + ' spike=' + strat.spike + ' priceExt=' + strat.priceExt + ' cycles=' + strat.cycleMin + '-' + strat.cycleMax + ' (' + totalBands + ' bands)');

  const { rows: coinRows } = await c.query('SELECT DISTINCT symbol FROM "Candle1h" LIMIT 200');
  const coins = coinRows.map(r => r.symbol).slice(0, 150);

  let grandTouches = 0, grandSpikeRejects = 0, grandPriceExtBlocks = 0, grandMinCycBlocks = 0, grandSignals = 0;
  const signalDetails = [];

  for (const symbol of coins) {
    const { rows: bars } = await c.query(
      'SELECT timestamp as time, open, high, low, close FROM "Candle1h" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 500',
      [symbol]
    );
    if (bars.length < 200) continue;
    bars.reverse();
    bars.forEach(b => { b.open = +b.open; b.high = +b.high; b.low = +b.low; b.close = +b.close; });

    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);

    const allBands = [];
    for (let order = 1; order <= 6; order++) {
      for (let cycle = strat.cycleMin; cycle <= strat.cycleMax; cycle++) {
        allBands.push(computeFracmap(highs, lows, cycle, order));
      }
    }

    // Check last 24 bars (24 hours) for more data
    const checkStart = Math.max(bars.length - 25, 100);

    for (let i = checkStart; i < bars.length - 1; i++) {
      let buyStr = 0, sellStr = 0, maxBuyC = 0, maxSellC = 0;
      let bandTouches = 0, spikeRejects = 0;

      for (const band of allBands) {
        const lo = band.lower[i], up = band.upper[i];
        if (lo === null || up === null || up <= lo) continue;
        const bw = (up - lo) / ((up + lo) / 2);
        if (bw < 0.0001) continue;
        const sw = Math.round(band.cycle / 3);

        // Buy check
        const buyAtI = bars[i].low < lo && bars[i].close > lo;
        const buyNear = strat.nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null &&
          bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);

        if (buyAtI || buyNear) {
          bandTouches++;
          const sH = isLocalMax(band.lower, i, sw);
          const sN = strat.nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw));
          if (strat.spike && !sH && !sN) { spikeRejects++; continue; }
          buyStr++;
          if (band.cycle > maxBuyC) maxBuyC = band.cycle;
        }

        // Sell check
        const sellAtI = bars[i].high > up && bars[i].close < up;
        const sellNear = strat.nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null &&
          bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);

        if (sellAtI || sellNear) {
          bandTouches++;
          const sH = isLocalMin(band.upper, i, sw);
          const sN = strat.nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw));
          if (strat.spike && !sH && !sN) { spikeRejects++; continue; }
          sellStr++;
          if (band.cycle > maxSellC) maxSellC = band.cycle;
        }
      }

      grandTouches += bandTouches;
      grandSpikeRejects += spikeRejects;

      // Check what blocks a signal
      const time = new Date(bars[i].time).toISOString().slice(0,16);

      if (buyStr > 0 || sellStr > 0) {
        let blocked = [];

        if (buyStr >= strat.minStr) {
          if (maxBuyC < strat.minCyc) { blocked.push('LONG: maxCycle=' + maxBuyC + ' < minCyc=' + strat.minCyc); grandMinCycBlocks++; }
          else if (strat.priceExt) {
            const w = Math.round(maxBuyC / 2);
            let isLow = true;
            for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].low < bars[i].low) { isLow = false; break; } }
            if (!isLow) { blocked.push('LONG: priceExt blocked (not price low in ' + w + ' bars)'); grandPriceExtBlocks++; }
            else { grandSignals++; signalDetails.push(time + ' ' + symbol + ' LONG str=' + buyStr + ' maxC=' + maxBuyC); }
          } else {
            grandSignals++; signalDetails.push(time + ' ' + symbol + ' LONG str=' + buyStr + ' maxC=' + maxBuyC);
          }
        }

        if (sellStr >= strat.minStr) {
          if (maxSellC < strat.minCyc) { blocked.push('SHORT: maxCycle=' + maxSellC + ' < minCyc=' + strat.minCyc); grandMinCycBlocks++; }
          else if (strat.priceExt) {
            const w = Math.round(maxSellC / 2);
            let isHigh = true;
            for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].high > bars[i].high) { isHigh = false; break; } }
            if (!isHigh) { blocked.push('SHORT: priceExt blocked (not price high in ' + w + ' bars)'); grandPriceExtBlocks++; }
            else { grandSignals++; signalDetails.push(time + ' ' + symbol + ' SHORT str=' + sellStr + ' maxC=' + maxSellC); }
          } else {
            grandSignals++; signalDetails.push(time + ' ' + symbol + ' SHORT str=' + sellStr + ' maxC=' + maxSellC);
          }
        }

        if (blocked.length > 0 && (bandTouches > 3 || buyStr > 0 || sellStr > 0)) {
          // Only print interesting blocks
        }
      }
    }
  }

  console.log('\n=== LAST 24 HOURS — 1H DETECTION SUMMARY (150 coins) ===');
  console.log('Band touches (pierce+close): ' + grandTouches);
  console.log('Spike filter rejects:        ' + grandSpikeRejects);
  console.log('MinCyc blocks (maxC < 64):   ' + grandMinCycBlocks);
  console.log('PriceExt blocks:             ' + grandPriceExtBlocks);
  console.log('Signals that pass all:       ' + grandSignals);

  if (signalDetails.length > 0) {
    console.log('\nPassing signals:');
    signalDetails.forEach(d => console.log('  ' + d));
  }

  // Show what happens without priceExt
  console.log('\n=== WITHOUT priceExt (what would pass) ===');
  // Re-count without priceExt is already implicit in the minCyc pass count
  // Let me just show the spike vs priceExt split
  const spikeRate = grandTouches > 0 ? ((grandSpikeRejects / grandTouches) * 100).toFixed(1) : '0';
  console.log('Spike filter kills ' + spikeRate + '% of all band touches');
  console.log('PriceExt kills ' + grandPriceExtBlocks + ' of ' + (grandSignals + grandPriceExtBlocks) + ' spike-passing signals (' + (grandSignals + grandPriceExtBlocks > 0 ? ((grandPriceExtBlocks / (grandSignals + grandPriceExtBlocks)) * 100).toFixed(0) : 0) + '%)');
  console.log('MinCyc (64) kills ' + grandMinCycBlocks + ' additional (low-cycle noise)');

  await c.end();
})();
