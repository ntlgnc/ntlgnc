const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://ntlgnc:Ntlgnc2026@localhost:5432/ntlgnc_db?schema=public' });

(async () => {
  const { rows } = await pool.query(`
    SELECT s.pair_id, s.pair_return, s."maxCycle"
    FROM "FracmapSignal" s
    LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.pair_id IS NOT NULL AND s.status = 'closed'
      AND st."barMinutes" = 1 AND st.active = true AND s.pair_return IS NOT NULL
    ORDER BY s.pair_id, s."createdAt"
  `);

  // Group into pairs, get avg cycle
  const pairMap = {};
  for (const r of rows) {
    if (!pairMap[r.pair_id]) pairMap[r.pair_id] = { cycles: [], ret: parseFloat(r.pair_return) || 0 };
    pairMap[r.pair_id].cycles.push(r.maxCycle || 0);
  }

  const data = [];
  for (const [, p] of Object.entries(pairMap)) {
    if (p.cycles.length !== 2) continue;
    const avgCycle = (p.cycles[0] + p.cycles[1]) / 2;
    data.push({ x: avgCycle, y: p.ret });
  }

  const xs = data.map(d => d.x);
  const ys = data.map(d => d.y);
  const n = data.length;

  console.log(`Pairs: ${n}\n`);

  // =============================================
  // 1. PEARSON (linear) — baseline
  // =============================================
  const rLinear = pearson(xs, ys);
  console.log(`=== LINEAR (Pearson) ===`);
  console.log(`r = ${rLinear.toFixed(4)}, R² = ${(rLinear ** 2).toFixed(4)}`);

  // =============================================
  // 2. SPEARMAN (rank correlation)
  // =============================================
  const rSpearman = spearman(xs, ys);
  console.log(`\n=== SPEARMAN (monotonic non-linear) ===`);
  console.log(`ρ = ${rSpearman.toFixed(4)}`);

  // =============================================
  // 3. QUADRATIC FIT — y = ax² + bx + c
  // =============================================
  const quad = fitQuadratic(xs, ys);
  console.log(`\n=== QUADRATIC FIT (y = ax² + bx + c) ===`);
  console.log(`a = ${quad.a.toFixed(6)}, b = ${quad.b.toFixed(4)}, c = ${quad.c.toFixed(4)}`);
  console.log(`R² = ${quad.r2.toFixed(4)}`);
  console.log(`Linear R² = ${(rLinear ** 2).toFixed(4)} → Quadratic R² = ${quad.r2.toFixed(4)} (improvement: ${((quad.r2 - rLinear ** 2) * 100).toFixed(3)}%)`);

  // Find the peak of the parabola
  if (quad.a !== 0) {
    const peak = -quad.b / (2 * quad.a);
    const peakY = quad.a * peak * peak + quad.b * peak + quad.c;
    console.log(`Parabola ${quad.a < 0 ? 'peaks' : 'troughs'} at cycle = ${peak.toFixed(1)}, predicted return = ${peakY >= 0 ? '+' : ''}${peakY.toFixed(4)}%`);
  }

  // =============================================
  // 4. ETA SQUARED (correlation ratio) — any shape
  // =============================================
  // Bucket x into groups, measure between-group vs total variance
  const eta2 = etaSquared(xs, ys, 10); // bucket by 10s
  console.log(`\n=== ETA SQUARED (η² — any-shape relationship) ===`);
  console.log(`η² = ${eta2.toFixed(4)}`);
  console.log(`Interpretation: cycle length explains ${(eta2 * 100).toFixed(2)}% of return variance`);

  // =============================================
  // 5. F-TEST for quadratic term significance
  // =============================================
  const fTest = quadraticFTest(xs, ys);
  console.log(`\n=== F-TEST: Is the quadratic term significant? ===`);
  console.log(`F-statistic = ${fTest.F.toFixed(2)}`);
  console.log(`p-value ≈ ${fTest.p < 0.001 ? '<0.001' : fTest.p.toFixed(4)}`);
  console.log(`${fTest.p < 0.05 ? '✓ YES' : '✗ NO'} — the curved relationship is ${fTest.p < 0.05 ? 'statistically significant' : 'NOT statistically significant'} (α=0.05)`);

  // =============================================
  // 6. Print the predicted curve at each bucket
  // =============================================
  console.log(`\n=== PREDICTED RETURN BY CYCLE (quadratic model) ===`);
  console.log('Cycle | Predicted Ret | Actual Avg Ret | Pairs');
  console.log('------|---------------|----------------|------');
  const buckets = {};
  for (const d of data) {
    const b = Math.floor(d.x / 10) * 10;
    if (!buckets[b]) buckets[b] = [];
    buckets[b].push(d.y);
  }
  for (const b of Object.keys(buckets).map(Number).sort((a, b) => a - b)) {
    const mid = b + 5;
    const predicted = quad.a * mid * mid + quad.b * mid + quad.c;
    const actual = buckets[b].reduce((s, r) => s + r, 0) / buckets[b].length;
    console.log(`${String(b + '-' + (b + 9)).padEnd(6)}| ${(predicted >= 0 ? '+' : '') + predicted.toFixed(3) + '%'}        | ${(actual >= 0 ? '+' : '') + actual.toFixed(3) + '%'}         | ${buckets[b].length}`);
  }

  // =============================================
  // 7. Also check cycle diff with quadratic
  // =============================================
  const diffs = [];
  for (const [, p] of Object.entries(pairMap)) {
    if (p.cycles.length !== 2) continue;
    diffs.push({ x: Math.abs(p.cycles[0] - p.cycles[1]), y: p.ret });
  }
  const dxs = diffs.map(d => d.x);
  const dys = diffs.map(d => d.y);
  const quadDiff = fitQuadratic(dxs, dys);
  const eta2Diff = etaSquared(dxs, dys, 10);
  const fDiff = quadraticFTest(dxs, dys);

  console.log(`\n=== CYCLE DIFFERENCE — NON-LINEAR ANALYSIS ===`);
  console.log(`Quadratic R² = ${quadDiff.r2.toFixed(4)}`);
  console.log(`η² = ${eta2Diff.toFixed(4)}`);
  console.log(`F-test p-value ≈ ${fDiff.p < 0.001 ? '<0.001' : fDiff.p.toFixed(4)} (quadratic term ${fDiff.p < 0.05 ? 'significant' : 'not significant'})`);
  if (quadDiff.a !== 0) {
    const peak = -quadDiff.b / (2 * quadDiff.a);
    console.log(`Parabola ${quadDiff.a < 0 ? 'peaks' : 'troughs'} at diff = ${peak.toFixed(1)}`);
  }

  pool.end();
})();

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
  // Solve normal equations for y = ax² + bx + c
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    sx += xi; sx2 += xi ** 2; sx3 += xi ** 3; sx4 += xi ** 4;
    sy += yi; sxy += xi * yi; sx2y += xi ** 2 * yi;
  }
  // [n    sx   sx2 ] [c]   [sy  ]
  // [sx   sx2  sx3 ] [b] = [sxy ]
  // [sx2  sx3  sx4 ] [a]   [sx2y]
  const A = [[n, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]];
  const B = [sy, sxy, sx2y];
  const sol = solve3x3(A, B);
  const c = sol[0], b = sol[1], a = sol[2];

  // Calculate R²
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
  // Gaussian elimination
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

function quadraticFTest(x, y) {
  const n = x.length;
  const my = y.reduce((s, v) => s + v, 0) / n;

  // Linear fit RSS
  const lr = linearFit(x, y);
  let rssLinear = 0;
  for (let i = 0; i < n; i++) rssLinear += (y[i] - (lr.a * x[i] + lr.b)) ** 2;

  // Quadratic fit RSS
  const qr = fitQuadratic(x, y);
  let rssQuad = 0;
  for (let i = 0; i < n; i++) rssQuad += (y[i] - (qr.a * x[i] ** 2 + qr.b * x[i] + qr.c)) ** 2;

  // F = ((RSS_linear - RSS_quad) / 1) / (RSS_quad / (n - 3))
  const F = ((rssLinear - rssQuad) / 1) / (rssQuad / (n - 3));

  // Approximate p-value using F(1, n-3)
  const df1 = 1, df2 = n - 3;
  const p = fDistPValue(F, df1, df2);

  return { F, p };
}

function linearFit(x, y) {
  const n = x.length;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sx2 += x[i] ** 2; }
  const a = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  const b = (sy - a * sx) / n;
  return { a, b };
}

function fDistPValue(F, df1, df2) {
  // Approximate using regularized incomplete beta function
  const x = df2 / (df2 + df1 * F);
  return betaRegularized(df2 / 2, df1 / 2, x);
}

function betaRegularized(a, b, x) {
  // Continued fraction approximation
  if (x < 0 || x > 1) return 0;
  if (x === 0) return 0;
  if (x === 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  // Lentz's algorithm
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
