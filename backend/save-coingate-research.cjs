/**
 * Save coin gate backtest findings to the research_documents table.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const title = 'Coin Quality Gate Backtest: Trailing WR<35% Filter is Net Detrimental';

const content = [
  '# Coin Quality Gate — Backtest Results',
  '',
  '**Date**: 2026-03-02',
  '**Author**: Operator + Claude (automated backtest)',
  '**Status**: FINDING — actionable',
  '',
  '---',
  '',
  '## Summary',
  '',
  'The Coin Quality Gate (Tier 2 rolling filter) blocks new signals for any coin whose trailing 25-trade win rate drops below 35%. Backtest across all 5,752 closed signals shows the gate is **net detrimental** — it systematically blocks signals that outperform the signals it allows through.',
  '',
  '## Mechanism',
  '',
  '- **Lookback**: Last 25 closed trades per coin per strategy',
  '- **Threshold**: Win rate < 35% → block',
  '- **Activation**: Requires minimum 10 closed trades before gating',
  '- **Implementation**: backend/coin-quality-gate.cjs',
  '',
  '## Backtest Methodology',
  '',
  'Replayed all closed signals chronologically for each active strategy. At each signal, computed the trailing 25-trade win rate from *preceding* signals only (no lookahead). Recorded whether the gate would have blocked, and what the actual return was.',
  '',
  '## Key Results (1m Strategy — Universal 1m V8)',
  '',
  '| Metric | Gated (blocked) | Passed (allowed) |',
  '|--------|-----------------|------------------|',
  '| Trades | 727 | 1,823 |',
  '| Avg return | **-0.0275%** | -0.1124% |',
  '| Win rate | **45.1%** | 39.1% |',
  '| Total return | -20.01% | -204.82% |',
  '',
  '**The gate blocks better signals.** Gated trades had:',
  '- 6% higher win rate (45.1% vs 39.1%)',
  '- 4x smaller average loss (-0.027% vs -0.112%)',
  '',
  '## Per-Coin Breakdown',
  '',
  '- **67 coins** triggered the gate at least once',
  '- Gate helped on only **14 coins** (21%)',
  '- Gate hurt on **53 coins** (79%)',
  '',
  '## Root Cause',
  '',
  'The gate implements a **lagging mean-reversion penalty**. When a coin\'s WR dips below 35%, it\'s typically at the trough of a losing streak. The subsequent signals — which the gate blocks — are statistically more likely to be the recovery. The gate systematically blocks the bounce-back.',
  '',
  'This is a well-known problem with trailing performance cutoffs: they sell the bottom and buy the top.',
  '',
  '## Recommendation',
  '',
  '**Disable the coin quality gate.** It has:',
  '- No Spearman rho backing (no stability test)',
  '- No out-of-sample validation',
  '- An arbitrary threshold (35%) and lookback (25) with no optimisation',
  '- Net negative impact across 79% of coins',
  '',
  'If a per-coin filter is desired in future, it should be:',
  '1. Tested with IS/OOS split and Spearman rho (same as regime scorecard)',
  '2. Based on structural features (coin volatility regime, spread, liquidity) not trailing WR',
  '3. Subject to the same statistical standards as all other filters',
  '',
  '## Related',
  '',
  '- Filter Audit dashboard: /admin/filter-audit (Coin Gate tab)',
  '- Coin quality gate code: backend/coin-quality-gate.cjs',
  '- Previous filter policy research: "Filter Policy Change Justification" (2026-02-28, 2026-03-01)',
].join('\n');

const description = 'Backtest of coin quality gate (trailing WR<35% filter). Finding: net detrimental across 79% of coins. Gate blocks recovery signals after losing streaks.';

(async () => {
  const client = await pool.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS research_documents (' +
      '  id SERIAL PRIMARY KEY,' +
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
      '  title TEXT NOT NULL,' +
      '  description TEXT,' +
      '  doc_type TEXT NOT NULL DEFAULT \'note\',' +
      '  content TEXT,' +
      '  file_path TEXT,' +
      '  file_name TEXT,' +
      '  file_size INTEGER,' +
      '  tags TEXT[] DEFAULT \'{}\',' +
      '  author TEXT DEFAULT \'operator\'' +
      ')'
    );

    const { rows } = await client.query(
      'INSERT INTO research_documents (title, description, doc_type, content, tags, author) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, created_at',
      [title, description, 'note', content, ['backtest', 'coin-gate', 'filter', 'finding', 'actionable'], 'operator+claude']
    );

    console.log('Research document saved:');
    console.log(rows[0]);
  } finally {
    client.release();
    pool.end();
  }
})();
