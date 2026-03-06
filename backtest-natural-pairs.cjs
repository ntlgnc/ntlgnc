const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  NATURAL PAIRS BACKTEST — Same-bar opposite signals             ║');
  console.log('║  Last 2 months of closed signals                                ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  for (const { barMinutes, label, barMs } of [
    { barMinutes: 1, label: '1-Minute', barMs: 60_000 },
    { barMinutes: 60, label: '1-Hour', barMs: 3600_000 },
    { barMinutes: 1440, label: '1-Day', barMs: 86400_000 },
  ]) {
    // Get all closed signals for this timeframe in last 2 months
    const { rows: signals } = await c.query(`
      SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
             s."returnPct", s."createdAt", s."closedAt", s."holdBars",
             s.pair_id
      FROM "FracmapSignal" s
      LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'closed' AND s."returnPct" IS NOT NULL
        AND st."barMinutes" = $1
        AND s."createdAt" >= NOW() - INTERVAL '2 months'
      ORDER BY s."createdAt"
    `, [barMinutes]);

    if (signals.length === 0) {
      console.log(`\n  ${label}: No closed signals found\n`);
      continue;
    }

    // Group signals by bar timestamp (snap createdAt to bar boundary)
    const barGroups = {};
    for (const sig of signals) {
      const ts = new Date(sig.createdAt).getTime();
      const barKey = Math.floor(ts / barMs) * barMs;
      if (!barGroups[barKey]) barGroups[barKey] = [];
      barGroups[barKey].push(sig);
    }

    // Find natural pairs: same bar, opposite directions, different coins
    const naturalPairs = [];
    const usedIds = new Set();

    for (const [barKey, barSigs] of Object.entries(barGroups)) {
      const longs = barSigs.filter(s => s.direction === 'LONG');
      const shorts = barSigs.filter(s => s.direction === 'SHORT');

      // Match longs with shorts (greedy: strongest first by absolute return diversity)
      // Simple: pair them in order, each signal used once
      for (const long of longs) {
        for (const short of shorts) {
          if (long.symbol === short.symbol) continue; // different coins
          if (usedIds.has(long.id) || usedIds.has(short.id)) continue;

          usedIds.add(long.id);
          usedIds.add(short.id);

          const pairReturn = (+long.returnPct) + (+short.returnPct);
          naturalPairs.push({
            bar: new Date(+barKey).toISOString(),
            longSym: long.symbol, shortSym: short.symbol,
            longRet: +long.returnPct, shortRet: +short.returnPct,
            pairReturn,
            longHold: long.holdBars, shortHold: short.holdBars,
          });
          break; // one pair per long
        }
      }
    }

    // Count unpaired signals (orphans that couldn't find a same-bar partner)
    const pairedCount = usedIds.size;
    const orphanCount = signals.length - pairedCount;

    // Stats
    const pairRets = naturalPairs.map(p => p.pairReturn);
    const wins = pairRets.filter(r => r > 0).length;
    const totalRet = pairRets.reduce((s, r) => s + r, 0);
    const avgRet = pairRets.length > 0 ? totalRet / pairRets.length : 0;
    const winRate = pairRets.length > 0 ? (wins / pairRets.length * 100) : 0;

    // Sharpe
    const std = pairRets.length > 1 ? Math.sqrt(pairRets.reduce((s, r) => s + (r - avgRet) ** 2, 0) / pairRets.length) : 0;
    const sharpe = std > 0 ? (avgRet / std) * Math.sqrt(252) : 0;

    // Max drawdown
    let peak = 0, maxDD = 0, cum = 0;
    for (const r of pairRets) { cum += r; peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum - peak); }

    // Profit factor
    const grossWin = pairRets.filter(r => r > 0).reduce((s, r) => s + r, 0);
    const grossLoss = Math.abs(pairRets.filter(r => r < 0).reduce((s, r) => s + r, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

    // Compare with ALL signals (unhedged baseline)
    const allRets = signals.map(s => +s.returnPct);
    const allAvg = allRets.reduce((s, r) => s + r, 0) / allRets.length;
    const allWins = allRets.filter(r => r > 0).length;
    const allWinRate = (allWins / allRets.length * 100);
    const allTotal = allRets.reduce((s, r) => s + r, 0);

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`  ${label} (${barMinutes}m bars)`);
    console.log(`${'═'.repeat(65)}`);
    console.log(`  Total signals: ${signals.length}`);
    console.log(`  Bars with signals: ${Object.keys(barGroups).length}`);
    console.log(`  Bars with BOTH long+short: ${naturalPairs.length}`);
    console.log(`  Signals paired: ${pairedCount} (${(pairedCount/signals.length*100).toFixed(1)}%)`);
    console.log(`  Signals orphaned (no same-bar partner): ${orphanCount} (${(orphanCount/signals.length*100).toFixed(1)}%)`);

    console.log(`\n  NATURAL PAIRS (same-bar opposite signals):`);
    console.log(`    Pairs: ${naturalPairs.length}`);
    console.log(`    Wins: ${wins} (${winRate.toFixed(1)}%)`);
    console.log(`    Avg return: ${avgRet >= 0 ? '+' : ''}${avgRet.toFixed(4)}%`);
    console.log(`    Total return: ${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%`);
    console.log(`    Sharpe: ${sharpe.toFixed(2)}`);
    console.log(`    Profit Factor: ${pf > 10 ? '>10' : pf.toFixed(2)}`);
    console.log(`    Max Drawdown: ${maxDD.toFixed(2)}%`);

    console.log(`\n  BASELINE (all signals unhedged):`);
    console.log(`    Signals: ${signals.length}`);
    console.log(`    Win rate: ${allWinRate.toFixed(1)}%`);
    console.log(`    Avg return: ${allAvg >= 0 ? '+' : ''}${allAvg.toFixed(4)}%`);
    console.log(`    Total return: ${allTotal >= 0 ? '+' : ''}${allTotal.toFixed(2)}%`);

    console.log(`\n  ORPHAN SIGNALS (no same-bar partner):`);
    const orphanIds = new Set(signals.filter(s => !usedIds.has(s.id)).map(s => s.id));
    const orphanRets = signals.filter(s => orphanIds.has(s.id)).map(s => +s.returnPct);
    const orphanAvg = orphanRets.length > 0 ? orphanRets.reduce((s, r) => s + r, 0) / orphanRets.length : 0;
    const orphanWins = orphanRets.filter(r => r > 0).length;
    const orphanWinRate = orphanRets.length > 0 ? (orphanWins / orphanRets.length * 100) : 0;
    const orphanTotal = orphanRets.reduce((s, r) => s + r, 0);
    console.log(`    Signals: ${orphanRets.length}`);
    console.log(`    Win rate: ${orphanWinRate.toFixed(1)}%`);
    console.log(`    Avg return: ${orphanAvg >= 0 ? '+' : ''}${orphanAvg.toFixed(4)}%`);
    console.log(`    Total return: ${orphanTotal >= 0 ? '+' : ''}${orphanTotal.toFixed(2)}%`);

    // Show best and worst 5 natural pairs
    const sorted = [...naturalPairs].sort((a, b) => b.pairReturn - a.pairReturn);
    console.log(`\n  BEST 5 natural pairs:`);
    for (const p of sorted.slice(0, 5)) {
      console.log(`    ${p.bar.slice(0,16)} L:${p.longSym.replace('USDT','')}(${p.longRet >= 0 ? '+' : ''}${p.longRet.toFixed(2)}%) + S:${p.shortSym.replace('USDT','')}(${p.shortRet >= 0 ? '+' : ''}${p.shortRet.toFixed(2)}%) = ${p.pairReturn >= 0 ? '+' : ''}${p.pairReturn.toFixed(2)}%`);
    }
    console.log(`  WORST 5 natural pairs:`);
    for (const p of sorted.slice(-5).reverse()) {
      console.log(`    ${p.bar.slice(0,16)} L:${p.longSym.replace('USDT','')}(${p.longRet >= 0 ? '+' : ''}${p.longRet.toFixed(2)}%) + S:${p.shortSym.replace('USDT','')}(${p.shortRet >= 0 ? '+' : ''}${p.shortRet.toFixed(2)}%) = ${p.pairReturn >= 0 ? '+' : ''}${p.pairReturn.toFixed(2)}%`);
    }

    // Distribution of pair returns
    const buckets = { '<-2%': 0, '-2 to -1%': 0, '-1 to 0%': 0, '0 to 1%': 0, '1 to 2%': 0, '>2%': 0 };
    for (const r of pairRets) {
      if (r < -2) buckets['<-2%']++;
      else if (r < -1) buckets['-2 to -1%']++;
      else if (r < 0) buckets['-1 to 0%']++;
      else if (r < 1) buckets['0 to 1%']++;
      else if (r < 2) buckets['1 to 2%']++;
      else buckets['>2%']++;
    }
    console.log(`\n  Return distribution:`);
    for (const [k, v] of Object.entries(buckets)) {
      const pct = pairRets.length > 0 ? (v / pairRets.length * 100).toFixed(0) : '0';
      const bar = '█'.repeat(Math.round(v / Math.max(1, pairRets.length) * 40));
      console.log(`    ${k.padEnd(12)} ${String(v).padStart(4)} (${pct.padStart(2)}%) ${bar}`);
    }
  }

  await c.end();
})();
