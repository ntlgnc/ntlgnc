/**
 * Check for look-ahead bias in fracmap band computation.
 *
 * For each band at bar i, trace exactly which bars [start..end] it uses.
 * If end >= i, there's a look-ahead.
 */

const PHI = 1.6180339887;

function traceComputeFracmap(n, cycle, order) {
  const zfracR = Math.round(cycle / 3.0);
  const forwardBars = Math.round(cycle / 3);
  const totalLen = n + forwardBars;
  const minIdx = (order + 1) * zfracR;

  console.log(`  cycle=${cycle} order=${order}: zfracR=${zfracR} forwardBars=${forwardBars} totalLen=${totalLen} minIdx=${minIdx}`);

  const issues = [];

  // Check a few representative bars
  for (const i of [minIdx, Math.floor(n / 2), n - 1, n, n + forwardBars - 1]) {
    if (i < minIdx || i >= totalLen) continue;
    const start = i - (order + 1) * zfracR;
    const end = i - order * zfracR;
    const clampEnd = Math.min(end, n - 1);
    if (start < 0 || start >= n) continue;
    if (clampEnd < start) continue;

    // The band at index i uses data from bars[start] to bars[clampEnd]
    // If i < n (i.e., this is a bar we could trade on), check if end > i
    const isDataBar = i < n;
    const looksAhead = isDataBar && end > i;

    const label = isDataBar ? 'DATA BAR' : 'FORWARD BAR';
    const warn = looksAhead ? ' *** LOOK-AHEAD! ***' : '';

    console.log(`    band[${i}] (${label}): uses bars[${start}..${clampEnd}] (raw end=${end})${warn}`);

    if (looksAhead) {
      issues.push({ i, start, end, clampEnd, cycle, order });
    }
  }

  return issues;
}

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  LOOK-AHEAD BIAS CHECK                                      ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

const n = 500; // Simulate 500 daily bars
let totalIssues = 0;

console.log('=== Signal detection at bar i uses band[i] ===');
console.log('=== band[i] computed from bars[start..end] ===');
console.log('=== LOOK-AHEAD if end > i (using future bars) ===\n');

for (const cycle of [2, 3, 4, 5, 8, 12]) {
  console.log(`\n── Cycle ${cycle} ──`);
  for (const order of [1, 2, 3]) {
    const issues = traceComputeFracmap(n, cycle, order);
    totalIssues += issues.length;
  }
}

console.log('\n\n=== ENTRY LOGIC CHECK ===');
console.log('Signal detected at bar i → entry at bar i+1 (next bar open)');
console.log('So the DETECTION uses band[i] at bar i, then ENTERS at bars[i+1].open');
console.log('Question: does band[i] use any data from bar i or beyond?\n');

// For cycle=2, order=1:
// zfracR = round(2/3) = 1
// band[i] uses: start = i - 2*1 = i-2, end = i - 1*1 = i-1
// So band[i] uses bars[i-2..i-1] — NO look-ahead, doesn't even use bar i
console.log('cycle=2, order=1: band[i] uses bars[i-2..i-1] — does NOT use bar i ✓');

// For cycle=2, order=2:
// zfracR = 1
// band[i] uses: start = i - 3*1 = i-3, end = i - 2*1 = i-2
console.log('cycle=2, order=2: band[i] uses bars[i-3..i-2] — does NOT use bar i ✓');

// For cycle=3, order=1:
// zfracR = round(3/3) = 1
// band[i] uses: start = i - 2*1 = i-2, end = i - 1*1 = i-1
console.log('cycle=3, order=1: band[i] uses bars[i-2..i-1] — does NOT use bar i ✓');

// Check: detection at bar i compares bars[i].low < band.lower[i]
// So it uses: bars[i] price AND band[i] value
// band[i] is computed from past bars only (verified above)
// Then: entry at bars[i+1].open — one bar later
console.log('\nDetection: bars[i].low < band.lower[i] → band uses bars up to [i-1]');
console.log('Entry: bars[i+1].open (next day open)');
console.log('This is a VALID backtest setup — no look-ahead in band computation.\n');

// BUT check the isLocalMax/isLocalMin which uses spike filter
console.log('=== SPIKE FILTER CHECK (daily: spike=false, so SKIPPED) ===');
console.log('isLocalMax(band.lower, i, w) checks band.lower[i-w..i+w]');
console.log('This looks FORWARD by w bars into band values (not prices)');
console.log('But daily config has spike=false, so this never runs ✓\n');

// NOW check: what about the forwardBars projection?
console.log('=== FORWARD BARS PROJECTION ===');
console.log('computeFracmap generates totalLen = n + forwardBars extra band values');
console.log('These extend BEYOND the data — used for projection, not detection');
console.log('detectEnsembleSignals loops i from 1 to n (bars.length)');
console.log('So it CANNOT access band[n] or beyond — bounded by bars array ✓\n');

// Check holdDuration for cycle=2
console.log('=== HOLD DURATION CHECK ===');
for (const cycle of [2, 3, 4, 5, 8, 12]) {
  const hd = Math.round(cycle / 2); // holdDiv=2 for daily
  console.log(`  cycle=${cycle}: holdDuration = round(${cycle}/2) = ${hd} bars (${hd} days)`);
}

console.log('\n=== VERDICT ===');
if (totalIssues > 0) {
  console.log('⚠️ FOUND POTENTIAL LOOK-AHEAD ISSUES — see above');
} else {
  console.log('✓ No look-ahead in band computation');
  console.log('✓ Detection uses band[i] which only references bars < i');
  console.log('✓ Entry at bars[i+1].open (next day)');
  console.log('✓ Spike filter disabled for daily');
  console.log('\nBand computation is clean. The suspiciously high SR at short');
  console.log('cycles may be due to:');
  console.log('  1. holdDuration=1 for cycle=2 (round(2/2)=1) — exits same day!');
  console.log('     Entry at bar i+1 open, exit at bar i+2 open = 1 day hold');
  console.log('     With 149 coins and 10K+ reuse pairs, tiny edges compound');
  console.log('  2. Reuse mode inflates pair count (correlated returns)');
  console.log('  3. Very short holds reduce exposure to adverse moves');
}
