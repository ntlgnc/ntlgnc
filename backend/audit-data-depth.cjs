/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DATA DEPTH AUDIT                                                ║
 * ║                                                                  ║
 * ║  How much data do we actually have?                              ║
 * ║  - Candles per timeframe (1m, 1h, 1d) — total, date range       ║
 * ║  - Per-coin candle depth                                         ║
 * ║  - Signals per timeframe — closed, open, filtered                ║
 * ║  - Regime scorecard coverage                                     ║
 * ║                                                                  ║
 * ║  Usage: node backend/audit-data-depth.cjs                       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  DATA DEPTH AUDIT                                            ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // ═══════════════════════════════════════════════════════════
  // 1. CANDLE DATA
  // ═══════════════════════════════════════════════════════════
  console.log('═══ CANDLE DATA ═══\n');

  const candleTables = [
    { table: 'Candle1m', label: '1-Minute', barMins: 1 },
    { table: 'Candle1h', label: '1-Hour', barMins: 60 },
    { table: 'Candle1d', label: '1-Day', barMins: 1440 },
  ];

  for (const ct of candleTables) {
    try {
      const { rows: [summary] } = await client.query(`
        SELECT COUNT(*) as total_rows,
               COUNT(DISTINCT symbol) as coins,
               MIN(timestamp) as earliest,
               MAX(timestamp) as latest
        FROM "${ct.table}"
      `);

      const earliest = new Date(summary.earliest);
      const latest = new Date(summary.latest);
      const days = ((latest - earliest) / (1000 * 60 * 60 * 24)).toFixed(1);

      console.log(`  ${ct.label} (${ct.table})`);
      console.log(`    Total rows:    ${parseInt(summary.total_rows).toLocaleString()}`);
      console.log(`    Coins:         ${summary.coins}`);
      console.log(`    Date range:    ${earliest.toISOString().slice(0, 10)} → ${latest.toISOString().slice(0, 10)} (${days} days)`);

      // Per-coin depth distribution
      const { rows: coinDepth } = await client.query(`
        SELECT symbol,
               COUNT(*) as bars,
               MIN(timestamp) as earliest,
               MAX(timestamp) as latest
        FROM "${ct.table}"
        GROUP BY symbol
        ORDER BY COUNT(*) DESC
      `);

      const depths = coinDepth.map(r => parseInt(r.bars));
      const median = depths[Math.floor(depths.length / 2)];
      const min = depths[depths.length - 1];
      const max = depths[0];
      const avg = Math.round(depths.reduce((a, b) => a + b, 0) / depths.length);

      console.log(`    Per-coin bars:  min=${min}  median=${median}  avg=${avg}  max=${max}`);

      // Show top 5 and bottom 5
      console.log(`    Top 5:  ${coinDepth.slice(0, 5).map(r => `${r.symbol.replace('USDT', '')}:${parseInt(r.bars).toLocaleString()}`).join('  ')}`);
      console.log(`    Bot 5:  ${coinDepth.slice(-5).map(r => `${r.symbol.replace('USDT', '')}:${parseInt(r.bars).toLocaleString()}`).join('  ')}`);

      // How many coins have "enough" data for backtesting?
      const thresholds = ct.barMins === 1 ? [1440, 10080, 43200, 525600] : // 1d, 1w, 1mo, 1yr in 1m bars
                          ct.barMins === 60 ? [24, 168, 720, 8760] :       // 1d, 1w, 1mo, 1yr in 1h bars
                                              [1, 7, 30, 365];             // in 1d bars
      const labels = ['1 day', '1 week', '1 month', '1 year'];
      const counts = thresholds.map(t => coinDepth.filter(r => parseInt(r.bars) >= t).length);
      console.log(`    Coverage:  ${labels.map((l, i) => `≥${l}: ${counts[i]} coins`).join('  ')}`);
      console.log('');
    } catch (err) {
      console.log(`  ${ct.label}: TABLE NOT FOUND (${err.message})\n`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 2. SIGNALS
  // ═══════════════════════════════════════════════════════════
  console.log('═══ SIGNALS ═══\n');

  const { rows: sigSummary } = await client.query(`
    SELECT st."barMinutes" as bar_minutes,
           s.status,
           COUNT(*) as cnt
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    GROUP BY st."barMinutes", s.status
    ORDER BY st."barMinutes", s.status
  `);

  const sigByTf = {};
  for (const r of sigSummary) {
    if (!sigByTf[r.bar_minutes]) sigByTf[r.bar_minutes] = {};
    sigByTf[r.bar_minutes][r.status] = parseInt(r.cnt);
  }

  for (const [tf, statuses] of Object.entries(sigByTf)) {
    const label = +tf === 1 ? '1-Minute' : +tf === 60 ? '1-Hour' : +tf === 1440 ? '1-Day' : `${tf}m`;
    const total = Object.values(statuses).reduce((a, b) => a + b, 0);
    console.log(`  ${label} Signals: ${total.toLocaleString()} total`);
    for (const [status, cnt] of Object.entries(statuses)) {
      console.log(`    ${status.padEnd(18)} ${cnt.toLocaleString()}`);
    }
  }

  // Signal date ranges
  const { rows: sigDates } = await client.query(`
    SELECT st."barMinutes" as bar_minutes,
           MIN(s."createdAt") as earliest,
           MAX(s."createdAt") as latest,
           COUNT(DISTINCT s.symbol) as coins
    FROM "FracmapSignal" s
    JOIN "FracmapStrategy" st ON s."strategyId" = st.id
    WHERE s.status = 'closed'
    GROUP BY st."barMinutes"
    ORDER BY st."barMinutes"
  `);

  console.log('\n  Signal Date Ranges (closed only):');
  for (const r of sigDates) {
    const label = +r.bar_minutes === 1 ? '1M' : +r.bar_minutes === 60 ? '1H' : '1D';
    const days = ((new Date(r.latest) - new Date(r.earliest)) / (1000 * 60 * 60 * 24)).toFixed(1);
    console.log(`    ${label}: ${new Date(r.earliest).toISOString().slice(0, 10)} → ${new Date(r.latest).toISOString().slice(0, 10)} (${days} days, ${r.coins} coins)`);
  }

  // ═══════════════════════════════════════════════════════════
  // 3. PER-COIN SIGNAL DEPTH
  // ═══════════════════════════════════════════════════════════
  console.log('\n\n═══ PER-COIN SIGNAL DEPTH (closed, by timeframe) ═══\n');

  for (const tf of [1, 60, 1440]) {
    const label = tf === 1 ? '1-Minute' : tf === 60 ? '1-Hour' : '1-Day';
    const { rows: coinSigs } = await client.query(`
      SELECT s.symbol, COUNT(*) as trades,
             SUM(s."returnPct") as total_return
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'closed' AND st."barMinutes" = $1
      GROUP BY s.symbol
      ORDER BY COUNT(*) DESC
    `, [tf]);

    if (coinSigs.length === 0) {
      console.log(`  ${label}: No closed signals\n`);
      continue;
    }

    const trades = coinSigs.map(r => parseInt(r.trades));
    const med = trades[Math.floor(trades.length / 2)];
    const total = trades.reduce((a, b) => a + b, 0);

    console.log(`  ${label}: ${coinSigs.length} coins with closed signals (${total.toLocaleString()} total trades)`);
    console.log(`    Per-coin: min=${trades[trades.length - 1]}  median=${med}  avg=${Math.round(total / coinSigs.length)}  max=${trades[0]}`);
    
    const thresholds = [5, 10, 20, 50, 100];
    console.log(`    ${thresholds.map(t => `≥${t}t: ${coinSigs.filter(r => parseInt(r.trades) >= t).length} coins`).join('  ')}`);

    // Top 10
    console.log(`    Top 10: ${coinSigs.slice(0, 10).map(r => `${r.symbol.replace('USDT', '')}:${r.trades}(${parseFloat(r.total_return).toFixed(1)}%)`).join('  ')}`);
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  // 4. REGIME SCORECARD COVERAGE
  // ═══════════════════════════════════════════════════════════
  console.log('═══ REGIME SCORECARD COVERAGE ═══\n');

  try {
    const { rows: scMeta } = await client.query(`
      SELECT bar_minutes,
             COUNT(DISTINCT feature_key) as features,
             COUNT(*) as total_rows,
             MAX(computed_at) as last_computed,
             MAX(total_signals) as total_signals
      FROM regime_scorecard
      GROUP BY bar_minutes
      ORDER BY bar_minutes
    `);

    console.log('  Market-wide scorecard:');
    for (const r of scMeta) {
      const label = +r.bar_minutes === 1 ? '1M' : +r.bar_minutes === 60 ? '1H' : '1D';
      console.log(`    ${label}: ${r.features} features, ${r.total_rows} rows, ${parseInt(r.total_signals).toLocaleString()} signals, computed ${new Date(r.last_computed).toISOString().slice(0, 16)}`);
    }
  } catch { console.log('  Market-wide scorecard: NOT AVAILABLE'); }

  try {
    const { rows: coinScMeta } = await client.query(`
      SELECT bar_minutes,
             COUNT(DISTINCT symbol) as coins,
             COUNT(DISTINCT feature_key) as features,
             COUNT(*) as total_rows
      FROM regime_scorecard_coins
      GROUP BY bar_minutes
      ORDER BY bar_minutes
    `);

    console.log('\n  Per-coin scorecard:');
    for (const r of coinScMeta) {
      const label = +r.bar_minutes === 1 ? '1M' : +r.bar_minutes === 60 ? '1H' : '1D';
      console.log(`    ${label}: ${r.coins} coins, ${r.features} features, ${r.total_rows} rows`);
    }
  } catch { console.log('  Per-coin scorecard: NOT AVAILABLE'); }

  // ═══════════════════════════════════════════════════════════
  // 5. STRATEGIES
  // ═══════════════════════════════════════════════════════════
  console.log('\n\n═══ STRATEGIES ═══\n');

  const { rows: strats } = await client.query(`
    SELECT id, label, "barMinutes", "maxCycle", "maxOrder", active
    FROM "FracmapStrategy"
    ORDER BY "barMinutes", id
  `);

  for (const s of strats) {
    const label = +s.barMinutes === 1 ? '1M' : +s.barMinutes === 60 ? '1H' : '1D';
    console.log(`  [${s.id}] ${label} ${s.label || '(unnamed)'}  cycle≤${s.maxCycle} order≤${s.maxOrder}  ${s.active ? '✅ active' : '❌ inactive'}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 6. BOARD OVERRIDES (exclusions)
  // ═══════════════════════════════════════════════════════════
  console.log('\n\n═══ COIN EXCLUSIONS ═══\n');

  try {
    const { rows: overrides } = await client.query(`
      SELECT reason, COUNT(*) as cnt
      FROM board_coin_overrides
      WHERE active = true AND override_type = 'exclude'
      GROUP BY reason
      ORDER BY COUNT(*) DESC
    `);
    for (const r of overrides) {
      console.log(`  ${r.reason || '(no reason)'}: ${r.cnt} coins`);
    }
    const { rows: [totEx] } = await client.query(`SELECT COUNT(*) as cnt FROM board_coin_overrides WHERE active = true AND override_type = 'exclude'`);
    console.log(`  Total excluded: ${totEx.cnt}`);
  } catch { console.log('  No exclusion data'); }

  await client.end();
  console.log('\n✓ Data depth audit complete');
}

main().catch(err => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
