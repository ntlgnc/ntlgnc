/**
 * Add PiR range filter: block signals when posInRange60 < 0.2 or > 0.8.
 * Uses the board_filters system for tracking and counterfactual analysis.
 */
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();

  // Check existing PiR filters (info only, don't skip)
  const { rows: existing } = await c.query(
    `SELECT id, feature, active FROM board_filters WHERE feature LIKE '%posInRange%' OR feature LIKE '%pos_in_range%' OR feature LIKE '%range_pos%'`
  );
  if (existing.length > 0) {
    console.log('Existing PiR filters (will not interfere):');
    existing.forEach(r => console.log('  #' + r.id + ' ' + r.feature + ' active=' + r.active));
    console.log('');
  }

  // Create the filter
  // The checkFilters function in live-signals.cjs checks conditions.rules against regimeSnap
  // Each rule: { feature, min, max, direction (optional) }
  // We want to BLOCK when posInRange60 < 0.2 OR posInRange60 > 0.8
  // That means we block when NOT in range 0.2-0.8
  // The filter logic: if value < min → block, if value > max → block
  // So: min=0.2, max=0.8 means block if OUTSIDE this range

  const conditions = {
    feature: 'posInRange60',
    rules: [
      { feature: 'posInRange60', min: 0.2, max: 0.8 }
    ],
    description: 'Block signals when price is at extreme position in 60-bar range. Middle range (0.2-0.8) has IS/OOS stable outperformance (SR 16.0, rho=0.5 but middle bucket #1 in both halves).'
  };

  const { rows: [filter] } = await c.query(
    `INSERT INTO board_filters (filter_type, feature, conditions, rationale, proposed_by, active)
     VALUES ('manual', 'posInRange60', $1, $2, 'operator', true) RETURNING id, feature`,
    [JSON.stringify(conditions),
     'PiR mid-range filter: Block signals at range extremes (<0.2 or >0.8). Validated on 45 days of 1m data (top 30 coins): middle range +3 bps avg vs -1 bps at extremes. Hedged pairs improve from 3 bps to 8 bps. IS/OOS stable: middle ranked #1 in both halves for ALL and LONG directions.']
  );

  console.log('Created filter #' + filter.id + ': ' + filter.feature);
  console.log('\nThis will:');
  console.log('  - Block 1m signals when posInRange60 < 0.2 or > 0.8');
  console.log('  - Apply to ALL timeframes (1m, 1h, 1d) unless timeframe restricted');
  console.log('  - Track blocked signals with counterfactual returns');
  console.log('  - Visible on /admin/filter-audit and /admin/filter-impact');

  // Verify
  const { rows: active } = await c.query('SELECT id, feature, active FROM board_filters WHERE active = true');
  console.log('\nActive filters:');
  active.forEach(r => console.log('  #' + r.id + ' ' + r.feature));

  c.release(); pool.end();
})();
