const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const barMinutes = 1440;
  const barMs = 86400_000;

  // Run for both windows
  for (const { label, interval } of [
    { label: '1M (30 days)', interval: '30 days' },
    { label: 'ALL (2 months)', interval: '2 months' },
  ]) {
    const { rows: signals } = await c.query(`
      SELECT s.id, s.symbol, s.direction, s."returnPct", s."createdAt"
      FROM "FracmapSignal" s
      LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'closed' AND s."returnPct" IS NOT NULL
        AND st."barMinutes" = $1
        AND s."createdAt" >= NOW() - INTERVAL '${interval}'
      ORDER BY s."createdAt"
    `, [barMinutes]);

    const barGroups = {};
    for (const sig of signals) {
      const ts = new Date(sig.createdAt).getTime();
      const barKey = Math.floor(ts / barMs) * barMs;
      if (!barGroups[barKey]) barGroups[barKey] = [];
      barGroups[barKey].push(sig);
    }

    const naturalPairs = [];
    const usedIds = new Set();
    for (const [barKeyStr, barSigs] of Object.entries(barGroups)) {
      const longs = barSigs.filter(s => s.direction === 'LONG');
      const shorts = barSigs.filter(s => s.direction === 'SHORT');
      for (const long of longs) {
        for (const short of shorts) {
          if (long.symbol === short.symbol) continue;
          if (usedIds.has(long.id) || usedIds.has(short.id)) continue;
          usedIds.add(long.id);
          usedIds.add(short.id);
          naturalPairs.push({
            bar: +barKeyStr,
            barDate: new Date(+barKeyStr).toISOString().slice(0, 10),
            longSym: long.symbol, shortSym: short.symbol,
            longRet: +long.returnPct, shortRet: +short.returnPct,
            pairReturn: (+long.returnPct) + (+short.returnPct),
            longId: long.id, shortId: short.id,
          });
          break;
        }
      }
    }

    naturalPairs.sort((a, b) => a.bar - b.bar);

    console.log(`\n=== ${label} ===`);
    console.log(`Signals: ${signals.length}, Bars: ${Object.keys(barGroups).length}, Pairs: ${naturalPairs.length}`);

    // Show last 15 pairs with their bar dates
    console.log(`\nLast 15 pairs:`);
    for (const p of naturalPairs.slice(-15)) {
      console.log(`  ${p.barDate} L:${p.longSym.replace('USDT','')}(${p.longRet>=0?'+':''}${p.longRet.toFixed(2)}%) S:${p.shortSym.replace('USDT','')}(${p.shortRet>=0?'+':''}${p.shortRet.toFixed(2)}%) = ${p.pairReturn>=0?'+':''}${p.pairReturn.toFixed(2)}%`);
    }

    // Count pairs per bar and show multi-pair bars
    const pairsPerBar = {};
    for (const p of naturalPairs) {
      pairsPerBar[p.barDate] = (pairsPerBar[p.barDate] || 0) + 1;
    }
    const multiBars = Object.entries(pairsPerBar).filter(([, count]) => count > 1);
    console.log(`\nBars with multiple pairs: ${multiBars.length}`);
    for (const [date, count] of multiBars.slice(-10)) {
      console.log(`  ${date}: ${count} pairs`);
    }

    // Cumulative return at 30-day boundary
    const cutoff30d = Date.now() - 30 * 86400_000;
    const olderPairs = naturalPairs.filter(p => p.bar < cutoff30d);
    const recentPairs = naturalPairs.filter(p => p.bar >= cutoff30d);
    const olderTotal = olderPairs.reduce((s, p) => s + p.pairReturn, 0);
    const recentTotal = recentPairs.reduce((s, p) => s + p.pairReturn, 0);
    console.log(`\nOlder pairs (before 30d): ${olderPairs.length}, total: ${olderTotal.toFixed(2)}%`);
    console.log(`Recent pairs (last 30d): ${recentPairs.length}, total: ${recentTotal.toFixed(2)}%`);
    console.log(`Combined: ${(olderTotal + recentTotal).toFixed(2)}%`);

    // Check: are the recent pair IDs the same?
    if (label.startsWith('ALL')) {
      console.log(`\nRecent pair IDs (first 5): ${recentPairs.slice(0,5).map(p => p.longId.slice(0,8)+'..+'+p.shortId.slice(0,8)).join(', ')}`);
    }
  }

  await c.end();
})();
