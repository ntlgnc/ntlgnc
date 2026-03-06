/**
 * IS/OOS Cycle Length vs Returns — Non-linear Analysis
 *
 * Re-runs the universe backtest signal detection for 1m strategies,
 * captures per-trade {maxCycle, returnPct} for IS and OOS halves,
 * then runs Pearson, Spearman, quadratic fit, eta², F-test analysis.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const PHI = 1.6180339887;
const SPLIT_PCT = 50;

// Strategy params (from universe-backtest.cjs)
const STRATEGIES = [
  {
    barMinutes: 1, table: 'Candle1m', label: '1m', days: 45,
    cycleMin: 10, cycleMax: 100,
    minStr: 1, minCyc: 55, spike: true, nearMiss: true, holdDiv: 4, priceExt: true,
  },
  {
    barMinutes: 60, table: 'Candle1h', label: '1h', days: 460,
    cycleMin: 55, cycleMax: 89,
    minStr: 1, minCyc: 64, spike: true, nearMiss: true, holdDiv: 5, priceExt: true,
  },
  {
    barMinutes: 1440, table: 'Candle1d', label: '1d', days: 2920,
    cycleMin: 2, cycleMax: 12,
    minStr: 1, minCyc: 0, spike: false, nearMiss: false, holdDiv: 2, priceExt: true,
  },
];

// ═══════════════════════════════════════════════════════════════
// SIGNAL ENGINE — verbatim from universe-backtest.cjs
// ═══════════════════════════════════════════════════════════════

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
  return { lower, upper, forwardBars };
}

function detectEnsembleSignals(bars, allBands, minStrength, minMaxCycle, spikeFilter, holdDivisor, nearMiss, priceExtreme) {
  const signals = [];
  let position = null;
  const n = bars.length;
  function isLocalMax(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] > val) return false; }
    return true;
  }
  function isLocalMin(arr, i, w) {
    const val = arr[i]; if (val === null) return false;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) { if (j === i) continue; if (arr[j] !== null && arr[j] < val) return false; }
    return true;
  }
  function isPriceLow(i, w) {
    const lo = bars[i].low;
    for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].low < lo) return false; }
    return true;
  }
  function isPriceHigh(i, w) {
    const hi = bars[i].high;
    for (let j = Math.max(0, i - w); j < i; j++) { if (bars[j].high > hi) return false; }
    return true;
  }
  for (let i = 1; i < n; i++) {
    if (position && i >= position.exitIdx) {
      const exitPrice = bars[i].open;
      const ret = position.type === 'LONG' ? (exitPrice / position.entryPrice - 1) * 100 : (position.entryPrice / exitPrice - 1) * 100;
      signals.push({ ...position, exitPrice, exitActualIdx: i, returnPct: +ret.toFixed(3), won: ret > 0 });
      position = null;
    }
    if (position) continue;
    let buyStrength = 0, sellStrength = 0, maxBuyCycle = 0, maxSellCycle = 0, maxBuyOrder = 0, maxSellOrder = 0;
    for (const band of allBands) {
      const lo = band.lower[i], up = band.upper[i];
      if (lo === null || up === null || up <= lo) continue;
      const bandWidth = (up - lo) / ((up + lo) / 2);
      if (bandWidth < 0.0001) continue;
      const sw = Math.round(band.cycle / 3);
      const buyAtI = bars[i].low < lo && bars[i].close > lo;
      const buyNear = nearMiss && !buyAtI && (i > 0 && band.lower[i-1] !== null && bars[i-1].low < band.lower[i-1] && bars[i-1].close > band.lower[i-1]);
      if (buyAtI || buyNear) {
        if (spikeFilter) { const sH = isLocalMax(band.lower, i, sw); const sN = nearMiss && (isLocalMax(band.lower, i-1, sw) || isLocalMax(band.lower, i+1, sw)); if (!sH && !sN) continue; }
        buyStrength++; if (band.cycle > maxBuyCycle) maxBuyCycle = band.cycle; if (band.order > maxBuyOrder) maxBuyOrder = band.order;
      }
      const sellAtI = bars[i].high > up && bars[i].close < up;
      const sellNear = nearMiss && !sellAtI && (i > 0 && band.upper[i-1] !== null && bars[i-1].high > band.upper[i-1] && bars[i-1].close < band.upper[i-1]);
      if (sellAtI || sellNear) {
        if (spikeFilter) { const sH = isLocalMin(band.upper, i, sw); const sN = nearMiss && (isLocalMin(band.upper, i-1, sw) || isLocalMin(band.upper, i+1, sw)); if (!sH && !sN) continue; }
        sellStrength++; if (band.cycle > maxSellCycle) maxSellCycle = band.cycle; if (band.order > maxSellOrder) maxSellOrder = band.order;
      }
    }
    if (buyStrength >= minStrength && maxBuyCycle >= minMaxCycle && buyStrength >= sellStrength) {
      if (priceExtreme && !isPriceLow(i, Math.round(maxBuyCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxBuyCycle / holdDivisor);
        position = { type: 'LONG', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxBuyCycle, maxOrder: maxBuyOrder, time: bars[i + 1].time, strength: buyStrength };
      }
    } else if (sellStrength >= minStrength && maxSellCycle >= minMaxCycle) {
      if (priceExtreme && !isPriceHigh(i, Math.round(maxSellCycle / 2))) { /* skip */ }
      else if (i + 1 < n) {
        const hd = Math.round(maxSellCycle / holdDivisor);
        position = { type: 'SHORT', entryIdx: i + 1, entryPrice: bars[i + 1].open, exitIdx: Math.min(i + 1 + hd, n - 1), holdDuration: hd, maxCycle: maxSellCycle, maxOrder: maxSellOrder, time: bars[i + 1].time, strength: sellStrength };
      }
    }
  }
  if (position) {
    const exitPrice = bars[n - 1].close;
    const ret = position.type === 'LONG' ? (exitPrice / position.entryPrice - 1) * 100 : (position.entryPrice / exitPrice - 1) * 100;
    signals.push({ ...position, exitPrice, exitActualIdx: n - 1, returnPct: +ret.toFixed(3), won: ret > 0 });
  }
  return signals;
}

// ═══════════════════════════════════════════════════════════════
// STATISTICAL FUNCTIONS — from analyze-nonlinear.cjs
// ═══════════════════════════════════════════════════════════════

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx2 += (x[i] - mx) ** 2;
    dy2 += (y[i] - my) ** 2;
  }
  return dx2 * dy2 === 0 ? 0 : num / Math.sqrt(dx2 * dy2);
}

function spearman(x, y) {
  const rank = (arr) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
      const avgRank = (i + j - 1) / 2 + 1;
      for (let k = i; k < j; k++) ranks[sorted[k].i] = avgRank;
      i = j;
    }
    return ranks;
  };
  return pearson(rank(x), rank(y));
}

function fitQuadratic(x, y) {
  const n = x.length;
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    sx += xi; sx2 += xi ** 2; sx3 += xi ** 3; sx4 += xi ** 4;
    sy += yi; sxy += xi * yi; sx2y += xi ** 2 * yi;
  }
  const A = [[n, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]];
  const B = [sy, sxy, sx2y];
  const sol = solve3x3(A, B);
  const c = sol[0], b = sol[1], a = sol[2];
  const my = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = a * x[i] ** 2 + b * x[i] + c;
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { a, b, c, r2 };
}

function solve3x3(A, B) {
  const a = A.map(r => [...r]);
  const b = [...B];
  for (let i = 0; i < 3; i++) {
    let maxRow = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(a[k][i]) > Math.abs(a[maxRow][i])) maxRow = k;
    [a[i], a[maxRow]] = [a[maxRow], a[i]];
    [b[i], b[maxRow]] = [b[maxRow], b[i]];
    for (let k = i + 1; k < 3; k++) {
      const f = a[k][i] / a[i][i];
      for (let j = i; j < 3; j++) a[k][j] -= f * a[i][j];
      b[k] -= f * b[i];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    x[i] = b[i];
    for (let j = i + 1; j < 3; j++) x[i] -= a[i][j] * x[j];
    x[i] /= a[i][i];
  }
  return x;
}

function etaSquared(x, y, bucketSize) {
  const n = x.length;
  const my = y.reduce((s, v) => s + v, 0) / n;
  const groups = {};
  for (let i = 0; i < n; i++) {
    const g = Math.floor(x[i] / bucketSize) * bucketSize;
    if (!groups[g]) groups[g] = [];
    groups[g].push(y[i]);
  }
  let ssBetween = 0, ssTotal = 0;
  for (const [, grp] of Object.entries(groups)) {
    const gm = grp.reduce((s, v) => s + v, 0) / grp.length;
    ssBetween += grp.length * (gm - my) ** 2;
  }
  for (let i = 0; i < n; i++) ssTotal += (y[i] - my) ** 2;
  return ssTotal === 0 ? 0 : ssBetween / ssTotal;
}

function linearFit(x, y) {
  const n = x.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sx2 += x[i] ** 2; }
  const a = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  const b = (sy - a * sx) / n;
  return { a, b };
}

function quadraticFTest(x, y) {
  const n = x.length;
  const lr = linearFit(x, y);
  let rssLinear = 0;
  for (let i = 0; i < n; i++) rssLinear += (y[i] - (lr.a * x[i] + lr.b)) ** 2;
  const qr = fitQuadratic(x, y);
  let rssQuad = 0;
  for (let i = 0; i < n; i++) rssQuad += (y[i] - (qr.a * x[i] ** 2 + qr.b * x[i] + qr.c)) ** 2;
  const F = ((rssLinear - rssQuad) / 1) / (rssQuad / (n - 3));
  const df1 = 1, df2 = n - 3;
  const p = fDistPValue(F, df1, df2);
  return { F, p };
}

function fDistPValue(F, df1, df2) {
  const x = df2 / (df2 + df1 * F);
  return betaRegularized(df2 / 2, df1 / 2, x);
}

function betaRegularized(a, b, x) {
  if (x < 0 || x > 1) return 0;
  if (x === 0) return 0;
  if (x === 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 1 - (a + 1) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; f = d;
  for (let m = 1; m <= 200; m++) {
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= d * c;
    num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c; f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * f;
}

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// ═══════════════════════════════════════════════════════════════
// ANALYSIS OUTPUT — run on collected trade data
// ═══════════════════════════════════════════════════════════════

function analyzeDataset(label, trades) {
  if (trades.length < 10) {
    console.log(`\n  ${label}: Only ${trades.length} trades — skipping\n`);
    return;
  }

  const xs = trades.map(t => t.maxCycle);
  const ys = trades.map(t => t.returnPct);
  const n = trades.length;
  const avgRet = ys.reduce((s, v) => s + v, 0) / n;
  const wins = ys.filter(r => r > 0).length;

  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  ${label} — ${n} trades, avg ret: ${avgRet >= 0 ? '+' : ''}${avgRet.toFixed(4)}%, WR: ${(wins/n*100).toFixed(1)}%`);
  console.log('═'.repeat(65));

  // Pearson
  const rLin = pearson(xs, ys);
  console.log(`  Pearson r = ${rLin.toFixed(4)}, R² = ${(rLin ** 2).toFixed(4)}`);

  // Spearman
  const rSpear = spearman(xs, ys);
  console.log(`  Spearman ρ = ${rSpear.toFixed(4)}`);

  // Quadratic
  const quad = fitQuadratic(xs, ys);
  console.log(`  Quadratic: a=${quad.a.toFixed(6)}, b=${quad.b.toFixed(4)}, c=${quad.c.toFixed(4)}, R²=${quad.r2.toFixed(4)}`);
  if (quad.a !== 0) {
    const peak = -quad.b / (2 * quad.a);
    const peakY = quad.a * peak * peak + quad.b * peak + quad.c;
    console.log(`  Parabola ${quad.a < 0 ? 'peaks' : 'troughs'} at cycle = ${peak.toFixed(1)}, predicted ret = ${peakY >= 0 ? '+' : ''}${peakY.toFixed(4)}%`);
  }

  // Eta squared
  const eta2 = etaSquared(xs, ys, 10);
  console.log(`  η² = ${eta2.toFixed(4)} (cycle explains ${(eta2 * 100).toFixed(2)}% of variance)`);

  // F-test
  const fTest = quadraticFTest(xs, ys);
  console.log(`  F-test: F=${fTest.F.toFixed(2)}, p=${fTest.p < 0.001 ? '<0.001' : fTest.p.toFixed(4)} ${fTest.p < 0.05 ? '✓ SIGNIFICANT' : '✗ not significant'}`);

  // Bucket table
  console.log(`\n  Cycle  | Trades | Avg Ret  | Win %  | Predicted`);
  console.log(`  -------|--------|----------|--------|----------`);
  const buckets = {};
  for (let i = 0; i < n; i++) {
    const b = Math.floor(xs[i] / 10) * 10;
    if (!buckets[b]) buckets[b] = { rets: [], wins: 0 };
    buckets[b].rets.push(ys[i]);
    if (ys[i] > 0) buckets[b].wins++;
  }
  for (const b of Object.keys(buckets).map(Number).sort((a, c) => a - c)) {
    const d = buckets[b];
    const avg = d.rets.reduce((s, r) => s + r, 0) / d.rets.length;
    const wr = (d.wins / d.rets.length * 100);
    const mid = b + 5;
    const pred = quad.a * mid * mid + quad.b * mid + quad.c;
    console.log(`  ${String(b + '-' + (b + 9)).padEnd(7)}| ${String(d.rets.length).padEnd(7)}| ${(avg >= 0 ? '+' : '') + avg.toFixed(3) + '%'}  | ${wr.toFixed(0).padStart(3)}%   | ${(pred >= 0 ? '+' : '') + pred.toFixed(3) + '%'}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  IS/OOS CYCLE LENGTH vs RETURNS — Non-linear Analysis             ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  for (const strat of STRATEGIES) {
    const { barMinutes, table, label, days, cycleMin, cycleMax, minStr, minCyc, spike, nearMiss, holdDiv, priceExt } = strat;

    console.log(`\n${'█'.repeat(65)}`);
    console.log(`  ${label.toUpperCase()} — ${table} — cycles ${cycleMin}–${cycleMax} — ${days} days`);
    console.log('█'.repeat(65));

    // Get all symbols with enough data
    const { rows: symbolRows } = await client.query(`
      SELECT symbol, COUNT(*) as cnt
      FROM "${table}"
      WHERE timestamp >= NOW() - INTERVAL '${days} days'
      GROUP BY symbol
      HAVING COUNT(*) >= 200
      ORDER BY symbol
    `);

    const symbols = symbolRows.map(r => r.symbol);
    console.log(`  ${symbols.length} coins with ≥200 bars`);

    const isTrades = [];
    const oosTrades = [];
    const allTrades = [];
    const startTime = Date.now();

    for (let si = 0; si < symbols.length; si++) {
      const symbol = symbols[si];

      const { rows: rawBars } = await client.query(`
        SELECT timestamp as time, open, high, low, close
        FROM "${table}"
        WHERE symbol = $1 AND timestamp >= NOW() - INTERVAL '${days} days'
        ORDER BY timestamp
      `, [symbol]);
      const bars = rawBars.map(c => ({ time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
      if (bars.length < 200) continue;

      const splitIdx = Math.round(bars.length * SPLIT_PCT / 100);
      const isBars = bars.slice(0, splitIdx);
      const oosBars = bars.slice(splitIdx);
      if (isBars.length < 100 || oosBars.length < 50) continue;

      // IS signals
      const isHighs = isBars.map(b => b.high), isLows = isBars.map(b => b.low);
      const isBands = [];
      for (let order = 1; order <= 6; order++)
        for (let cycle = cycleMin; cycle <= cycleMax; cycle++)
          isBands.push({ cycle, order, ...computeFracmap(isHighs, isLows, cycle, order) });
      const isSigs = detectEnsembleSignals(isBars, isBands, minStr, minCyc, spike, holdDiv, nearMiss, priceExt);

      // OOS signals
      const oosHighs = oosBars.map(b => b.high), oosLows = oosBars.map(b => b.low);
      const oosBands = [];
      for (let order = 1; order <= 6; order++)
        for (let cycle = cycleMin; cycle <= cycleMax; cycle++)
          oosBands.push({ cycle, order, ...computeFracmap(oosHighs, oosLows, cycle, order) });
      const oosSigs = detectEnsembleSignals(oosBars, oosBands, minStr, minCyc, spike, holdDiv, nearMiss, priceExt);

      for (const s of isSigs) isTrades.push({ maxCycle: s.maxCycle, returnPct: s.returnPct, symbol, direction: s.type });
      for (const s of oosSigs) oosTrades.push({ maxCycle: s.maxCycle, returnPct: s.returnPct, symbol, direction: s.type });
      for (const s of [...isSigs, ...oosSigs]) allTrades.push({ maxCycle: s.maxCycle, returnPct: s.returnPct, symbol, direction: s.type });

      if ((si + 1) % 25 === 0 || si === symbols.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const eta = Math.round(((Date.now() - startTime) / (si + 1)) * (symbols.length - si - 1) / 1000);
        console.log(`  ${si+1}/${symbols.length} coins processed (IS:${isTrades.length} OOS:${oosTrades.length} trades) — ${elapsed}s, ETA ~${eta}s`);
      }
    }

    // Run analysis on IS, OOS, and ALL
    analyzeDataset(`${label.toUpperCase()} — IN-SAMPLE (first 50% of data)`, isTrades);
    analyzeDataset(`${label.toUpperCase()} — OUT-OF-SAMPLE (second 50% of data)`, oosTrades);
    analyzeDataset(`${label.toUpperCase()} — COMBINED (IS + OOS)`, allTrades);

    // IS vs OOS comparison
    if (isTrades.length >= 10 && oosTrades.length >= 10) {
      const isQuad = fitQuadratic(isTrades.map(t => t.maxCycle), isTrades.map(t => t.returnPct));
      const oosQuad = fitQuadratic(oosTrades.map(t => t.maxCycle), oosTrades.map(t => t.returnPct));
      const isPeak = isQuad.a !== 0 ? -isQuad.b / (2 * isQuad.a) : null;
      const oosPeak = oosQuad.a !== 0 ? -oosQuad.b / (2 * oosQuad.a) : null;
      console.log(`\n${'─'.repeat(65)}`);
      console.log(`  ${label.toUpperCase()} IS vs OOS COMPARISON:`);
      console.log(`  IS  peak cycle: ${isPeak ? isPeak.toFixed(1) : 'N/A'}, R²=${isQuad.r2.toFixed(4)}`);
      console.log(`  OOS peak cycle: ${oosPeak ? oosPeak.toFixed(1) : 'N/A'}, R²=${oosQuad.r2.toFixed(4)}`);
      if (isPeak && oosPeak) {
        console.log(`  Peak drift: ${Math.abs(isPeak - oosPeak).toFixed(1)} cycles — ${Math.abs(isPeak - oosPeak) < 10 ? '✓ STABLE' : '✗ UNSTABLE'}`);
      }
    }
  }

  await client.end();
  console.log('\n✓ Analysis complete');
}

main().catch(err => { console.error('✗ FATAL:', err.message); process.exit(1); });
