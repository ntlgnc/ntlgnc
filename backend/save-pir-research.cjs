require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  await c.query(`CREATE TABLE IF NOT EXISTS research_documents (
    id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now(),
    title TEXT NOT NULL, description TEXT, doc_type TEXT DEFAULT 'note',
    content TEXT, file_path TEXT, file_name TEXT, file_size INTEGER,
    tags TEXT[] DEFAULT '{}', author TEXT DEFAULT 'operator'
  )`);

  const title = 'PiR Directional Rho: ALL direction rho is invalid for directional features';
  const content = [
    '# Position in Range — Directional Rho Finding',
    '',
    '**Date**: 2026-03-03',
    '**Author**: Operator + Claude (analysis)',
    '**Status**: FINDING — methodology change required',
    '',
    '---',
    '',
    '## Summary',
    '',
    'The regime scorecard computes Spearman rho for each feature using ALL signals (longs + shorts combined), then separately for LONG and SHORT. For features where the interpretation depends on trade direction, the ALL rho is misleading and should not be used for filter decisions.',
    '',
    '## Affected Features',
    '',
    'These features have direction-dependent interpretation — the ALL rho is meaningless:',
    '- **posInRange** (PiR): Bottom is good for longs (buy the dip), bad for shorts. Combining cancels the signal.',
    '- **trend60**: Uptrend favours longs, downtrend favours shorts.',
    '- **trend5d**: Same as trend60 at larger scale.',
    '- **posInRange5d**: Same as posInRange at larger scale.',
    '',
    '## Features Where ALL Rho IS Valid',
    '',
    'These features affect both directions the same way:',
    '- **volRatio, atrCompression, volState**: Volatility regime affects all trades equally.',
    '- **hurst**: Mean-reversion vs trending affects the strategy mechanics, not direction.',
    '- **persistence, volCluster**: Market microstructure features.',
    '- **hour**: Time-of-day effects are direction-agnostic.',
    '',
    '## Evidence: PiR on 1m Data',
    '',
    'Middle bucket (0.25-0.75) IS vs OOS stability:',
    '- ALL: IS=#1 (SR 8.90), OOS=#1 (SR 16.00) — rho=0.5 (STABLE for middle, rho penalised because Bottom/Top swapped)',
    '- LONG: IS=#1 (SR 3.20), OOS=#1 (SR 28.96) — rho=0.5 (STABLE for middle)',
    '- SHORT: IS=#1 (SR 12.57), OOS=#2 (SR 3.19) — rho=-0.5 (Middle shifted from #1 to #2, but still positive)',
    '',
    'Both LONG and SHORT Middle buckets are positive in both IS and OOS halves. The filter is valid.',
    '',
    '## Recommendation',
    '',
    '1. When evaluating directional features (PiR, trend), only use LONG and SHORT rho, ignore ALL.',
    '2. For the PiR filter specifically: block signals when PiR < 0.2 or PiR > 0.8 for all directions.',
    '3. The scorecard UI and LLM board briefing should flag which features are directional.',
    '4. A rho of 0.5 can still support a filter if the specific bucket being acted on held its rank — check the bucket rank, not just the overall rho.',
    '',
    '## Related',
    '',
    '- Regime scorecard: /regime/scorecard',
    '- Filter matrix: /admin/filter-matrix',
    '- Analysis scripts: backend/check-pir-isoos2.cjs, backend/pir-order-deep.cjs',
  ].join('\n');

  const { rows } = await c.query(
    `INSERT INTO research_documents (title, description, doc_type, content, tags, author)
     VALUES ($1, $2, 'note', $3, $4, $5) RETURNING id, title`,
    [title, 'ALL-direction rho is invalid for directional features like PiR and trend. Use LONG/SHORT rho only.',
     content, ['rho', 'methodology', 'pir', 'directional', 'scorecard', 'finding'], 'operator+claude']
  );
  console.log('Saved:', rows[0]);
  c.release(); pool.end();
})();
