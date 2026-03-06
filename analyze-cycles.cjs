const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://ntlgnc:Ntlgnc2026@localhost:5432/ntlgnc_db?schema=public' });

(async () => {
  // Get all closed 1m hedged pairs with cycle info
  const { rows } = await pool.query(`
    SELECT s.pair_id, s.symbol, s.direction, s."returnPct", s.pair_return,
           s."maxCycle", s."createdAt"::text,
           st."barMinutes"
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL
      AND s.status = 'closed'
      AND st."barMinutes" = 1
      AND st.active = true
      AND s.pair_return IS NOT NULL
    ORDER BY s.pair_id, s."createdAt"
  `);

  // Group by pair_id
  const pairMap = {};
  for (const r of rows) {
    if (!pairMap[r.pair_id]) pairMap[r.pair_id] = [];
    pairMap[r.pair_id].push(r);
  }

  const pairs = [];
  for (const [pid, legs] of Object.entries(pairMap)) {
    if (legs.length !== 2) continue;
    const [a, b] = legs;
    const cycleA = a.maxCycle || 0;
    const cycleB = b.maxCycle || 0;
    const avgCycle = (cycleA + cycleB) / 2;
    const cycleDiff = Math.abs(cycleA - cycleB);
    const pairRet = parseFloat(a.pair_return) || 0;
    pairs.push({ pid, cycleA, cycleB, avgCycle, cycleDiff, pairRet, symA: a.symbol, symB: b.symbol });
  }

  console.log(`Total 1m closed hedged pairs: ${pairs.length}\n`);

  // --- Analysis 1: Average cycle vs returns ---
  console.log('=== AVG CYCLE LENGTH vs PAIR RETURN ===');
  const cycleBuckets = {};
  for (const p of pairs) {
    const bucket = Math.floor(p.avgCycle / 10) * 10; // bucket by 10s
    const key = `${bucket}-${bucket + 9}`;
    if (!cycleBuckets[key]) cycleBuckets[key] = { returns: [], count: 0, wins: 0, sortKey: bucket };
    cycleBuckets[key].returns.push(p.pairRet);
    cycleBuckets[key].count++;
    if (p.pairRet > 0) cycleBuckets[key].wins++;
  }

  const sortedBuckets = Object.entries(cycleBuckets).sort((a, b) => a[1].sortKey - b[1].sortKey);
  console.log('Cycle Range | Pairs | Avg Ret  | Win %  | Cum Ret');
  console.log('------------|-------|----------|--------|--------');
  for (const [key, d] of sortedBuckets) {
    const avg = d.returns.reduce((s, r) => s + r, 0) / d.returns.length;
    const cum = d.returns.reduce((s, r) => s + r, 0);
    const wr = (d.wins / d.count * 100);
    console.log(`${key.padEnd(12)}| ${String(d.count).padEnd(6)}| ${(avg >= 0 ? '+' : '') + avg.toFixed(3) + '%'}  | ${wr.toFixed(0).padStart(3)}%   | ${(cum >= 0 ? '+' : '') + cum.toFixed(2) + '%'}`);
  }

  // Correlation: avg cycle vs return
  const corrAvgCycle = pearson(pairs.map(p => p.avgCycle), pairs.map(p => p.pairRet));
  console.log(`\nPearson correlation (avg cycle vs return): ${corrAvgCycle.toFixed(4)}`);

  // --- Analysis 2: Cycle difference vs returns ---
  console.log('\n=== CYCLE DIFFERENCE (|cycleA - cycleB|) vs PAIR RETURN ===');
  const diffBuckets = {};
  for (const p of pairs) {
    let key;
    if (p.cycleDiff === 0) key = '0 (same)';
    else if (p.cycleDiff <= 10) key = '1-10';
    else if (p.cycleDiff <= 20) key = '11-20';
    else if (p.cycleDiff <= 30) key = '21-30';
    else if (p.cycleDiff <= 50) key = '31-50';
    else key = '51+';
    const sortKey = p.cycleDiff === 0 ? 0 : p.cycleDiff <= 10 ? 1 : p.cycleDiff <= 20 ? 2 : p.cycleDiff <= 30 ? 3 : p.cycleDiff <= 50 ? 4 : 5;
    if (!diffBuckets[key]) diffBuckets[key] = { returns: [], count: 0, wins: 0, sortKey };
    diffBuckets[key].returns.push(p.pairRet);
    diffBuckets[key].count++;
    if (p.pairRet > 0) diffBuckets[key].wins++;
  }

  const sortedDiff = Object.entries(diffBuckets).sort((a, b) => a[1].sortKey - b[1].sortKey);
  console.log('Diff Range  | Pairs | Avg Ret  | Win %  | Cum Ret');
  console.log('------------|-------|----------|--------|--------');
  for (const [key, d] of sortedDiff) {
    const avg = d.returns.reduce((s, r) => s + r, 0) / d.returns.length;
    const cum = d.returns.reduce((s, r) => s + r, 0);
    const wr = (d.wins / d.count * 100);
    console.log(`${key.padEnd(12)}| ${String(d.count).padEnd(6)}| ${(avg >= 0 ? '+' : '') + avg.toFixed(3) + '%'}  | ${wr.toFixed(0).padStart(3)}%   | ${(cum >= 0 ? '+' : '') + cum.toFixed(2) + '%'}`);
  }

  const corrDiff = pearson(pairs.map(p => p.cycleDiff), pairs.map(p => p.pairRet));
  console.log(`\nPearson correlation (cycle diff vs return): ${corrDiff.toFixed(4)}`);

  // --- Analysis 3: Individual cycle lengths ---
  console.log('\n=== INDIVIDUAL CYCLE (max of two legs) vs PAIR RETURN ===');
  const maxCycleBuckets = {};
  for (const p of pairs) {
    const maxC = Math.max(p.cycleA, p.cycleB);
    const bucket = Math.floor(maxC / 10) * 10;
    const key = `${bucket}-${bucket + 9}`;
    if (!maxCycleBuckets[key]) maxCycleBuckets[key] = { returns: [], count: 0, wins: 0, sortKey: bucket };
    maxCycleBuckets[key].returns.push(p.pairRet);
    maxCycleBuckets[key].count++;
    if (p.pairRet > 0) maxCycleBuckets[key].wins++;
  }

  const sortedMax = Object.entries(maxCycleBuckets).sort((a, b) => a[1].sortKey - b[1].sortKey);
  console.log('Max Cycle   | Pairs | Avg Ret  | Win %  | Cum Ret');
  console.log('------------|-------|----------|--------|--------');
  for (const [key, d] of sortedMax) {
    const avg = d.returns.reduce((s, r) => s + r, 0) / d.returns.length;
    const cum = d.returns.reduce((s, r) => s + r, 0);
    const wr = (d.wins / d.count * 100);
    console.log(`${key.padEnd(12)}| ${String(d.count).padEnd(6)}| ${(avg >= 0 ? '+' : '') + avg.toFixed(3) + '%'}  | ${wr.toFixed(0).padStart(3)}%   | ${(cum >= 0 ? '+' : '') + cum.toFixed(2) + '%'}`);
  }

  const corrMax = pearson(pairs.map(p => Math.max(p.cycleA, p.cycleB)), pairs.map(p => p.pairRet));
  console.log(`\nPearson correlation (max cycle vs return): ${corrMax.toFixed(4)}`);

  // --- Analysis 4: Distribution summary ---
  console.log('\n=== SUMMARY STATS ===');
  const allRets = pairs.map(p => p.pairRet);
  const avgRet = allRets.reduce((s, r) => s + r, 0) / allRets.length;
  const wins = allRets.filter(r => r > 0).length;
  const avgCycles = pairs.map(p => p.avgCycle);
  const avgCycleMean = avgCycles.reduce((s, c) => s + c, 0) / avgCycles.length;
  const diffs = pairs.map(p => p.cycleDiff);
  const avgDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;

  console.log(`Pairs: ${pairs.length}`);
  console.log(`Avg return: ${avgRet >= 0 ? '+' : ''}${avgRet.toFixed(4)}%`);
  console.log(`Win rate: ${(wins / pairs.length * 100).toFixed(1)}%`);
  console.log(`Avg cycle (mean of two legs): ${avgCycleMean.toFixed(1)}`);
  console.log(`Avg cycle diff: ${avgDiff.toFixed(1)}`);
  console.log(`Cycle range: ${Math.min(...avgCycles).toFixed(0)} - ${Math.max(...avgCycles).toFixed(0)}`);

  pool.end();
})();

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}
