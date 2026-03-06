/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — LLM Board v3 Upgrade Script                          ║
 * ║                                                                  ║
 * ║  Run: node backend/upgrade-board-v3.cjs                         ║
 * ║                                                                  ║
 * ║  This patches llm-board.js in-place with:                       ║
 * ║    • Genesis Document sections 13-15                            ║
 * ║    • AFFIRM_PATIENCE, EDIT_HERO, COMPETITION_ENTRY motions      ║
 * ║    • New DB tables (hero, competitions, forecasts, feedback)     ║
 * ║    • BTC forecast data in buildMeetingContext                    ║
 * ║    • Data maturity scoring                                       ║
 * ║    • Restructured briefing (long-term evidence first)           ║
 * ║    • Updated phase prompts (patience-aware)                      ║
 * ║    • BTC forecast phase after Phase 7                            ║
 * ║    • New deploy cases for hero/competition/patience              ║
 * ║                                                                  ║
 * ║  Creates a backup at llm-board.js.v2-backup before patching.   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');

const BOARD_PATH = path.join(__dirname, 'llm-board.js');
const BACKUP_PATH = BOARD_PATH + '.v2-backup';

if (!fs.existsSync(BOARD_PATH)) {
  console.error('❌ llm-board.js not found at', BOARD_PATH);
  process.exit(1);
}

// Backup
fs.copyFileSync(BOARD_PATH, BACKUP_PATH);
console.log(`✅ Backup created: ${BACKUP_PATH}`);

let src = fs.readFileSync(BOARD_PATH, 'utf8');

// Helper: insert text after a marker line
function insertAfter(marker, newText) {
  const idx = src.indexOf(marker);
  if (idx === -1) { console.warn(`⚠ Marker not found: "${marker.slice(0, 60)}..."`); return false; }
  const end = src.indexOf('\n', idx) + 1;
  src = src.slice(0, end) + newText + src.slice(end);
  return true;
}

// Helper: replace text between two markers (inclusive of start line, exclusive of end line)
function replaceBetween(startMarker, endMarker, newText) {
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  if (startIdx === -1 || endIdx === -1) { console.warn(`⚠ Markers not found for replaceBetween`); return false; }
  const lineStart = src.lastIndexOf('\n', startIdx) + 1;
  src = src.slice(0, lineStart) + newText + src.slice(endIdx);
  return true;
}

// Helper: insert before a marker
function insertBefore(marker, newText) {
  const idx = src.indexOf(marker);
  if (idx === -1) { console.warn(`⚠ Marker not found: "${marker.slice(0, 60)}..."`); return false; }
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  src = src.slice(0, lineStart) + newText + src.slice(lineStart);
  return true;
}

let patchCount = 0;

// ═══════════════════════════════════════════════════════════════
// PATCH 1: Add Genesis Document sections 13-15
// ═══════════════════════════════════════════════════════════════

const GENESIS_ADDITIONS = `
13. BOARD COMPETITION — COIN PICK CHALLENGE
  Each board member may submit a competition entry selecting:
    a) ONE coin from the active universe
    b) TWO regime factors that are NOT the standard posInRange60 or volState
       (these are already proven — find something NEW)
  
  Selection MUST be justified with statistical analysis from the regime data,
  scorecard, or per-coin regime heatmap. No narrative-only picks.
  
  Scoring: After 72 hours, each pick is evaluated on whether the chosen
  regime factors predicted signal quality for that coin. The leaderboard
  is shown in each briefing. Submit via COMPETITION_ENTRY motion type.

14. HERO SECTION — CREATIVE CONTROL
  The board takes turns editing the home page hero section via EDIT_HERO motion.
  CONSTRAINTS:
    - Badge: max 30 chars (e.g. "LIVE — Signals firing now")
    - Headline: max 40 chars, monospace font
    - Subheadline: max 60 chars, italic style
    - Body: max 250 chars
    - CTA buttons: max 25 chars each
  Be creative. Reference real performance data. User feedback (thumbs up/down)
  is shown in briefings.

15. BTC 60-MINUTE FORECAST
  At the end of each meeting, all board members forecast BTC's direction
  for the next 60 minutes. You will be given last 60 bars of BTC 1H OHLC
  and full BTC regime data. Each member states UP or DOWN, confidence
  (LOW/MEDIUM/HIGH), and justification from regime data. The consensus
  is recorded and scored at the next meeting. Track record is in the briefing.
`;

if (insertBefore('`.trim();', GENESIS_ADDITIONS)) {
  patchCount++;
  console.log(`✅ PATCH 1: Genesis sections 13-15 added`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 2: Add new MOTION_TYPES
// ═══════════════════════════════════════════════════════════════

const NEW_MOTIONS = `  AFFIRM_PATIENCE: { name: 'Affirm Patience', fields: ['rationale', 'next_review_conditions'] },
  EDIT_HERO: { name: 'Edit Hero Section', fields: ['badge_text', 'headline', 'subheadline', 'body_text', 'cta_left', 'cta_right', 'creative_rationale'] },
  COMPETITION_ENTRY: { name: 'Competition Entry', fields: ['coin', 'regime_factor_1', 'regime_factor_2', 'hypothesis', 'statistical_basis'] },
`;

if (insertAfter("  REQUEST_ANALYSIS: { name: 'Request Analysis', fields: ['question', 'data_needed', 'timeframe'] },", NEW_MOTIONS)) {
  patchCount++;
  console.log(`✅ PATCH 2: New motion types added`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 3: Add new database tables to ensureTables()
// ═══════════════════════════════════════════════════════════════

const NEW_TABLES = `
  // ═══ v3 NEW TABLES ═══

  // Filtered signal outcomes (counterfactual analysis cache)
  await client.query(\`
    CREATE TABLE IF NOT EXISTS filtered_signal_outcomes (
      id                       SERIAL PRIMARY KEY,
      computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_filtered           INTEGER,
      total_evaluated          INTEGER,
      hypothetical_avg_return  FLOAT,
      hypothetical_win_rate    FLOAT,
      hypothetical_cum_return  FLOAT,
      actual_avg_return        FLOAT,
      actual_win_rate          FLOAT,
      actual_cum_return        FLOAT,
      filter_value_pct         FLOAT,
      direction_breakdown      JSONB,
      per_filter_breakdown     JSONB,
      sample_size_note         TEXT
    )
  \`);

  // Hero content — LLM-authored home page hero section
  await client.query(\`
    CREATE TABLE IF NOT EXISTS board_hero_content (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ DEFAULT now(),
      meeting_id      INTEGER REFERENCES board_meetings(id),
      authored_by     TEXT NOT NULL,
      badge_text      VARCHAR(30) NOT NULL DEFAULT 'LIVE — Signals firing now',
      headline        VARCHAR(40) NOT NULL DEFAULT 'Recursive AI Alpha',
      subheadline     VARCHAR(60) NOT NULL DEFAULT 'Humans built it. The machines took it from here.',
      body_text       VARCHAR(250) NOT NULL DEFAULT 'Five frontier AI models meet every hour to debate, test, and deploy strategy improvements.',
      cta_left        VARCHAR(25) NOT NULL DEFAULT 'View Live Signals',
      cta_right       VARCHAR(25) NOT NULL DEFAULT 'See the Evidence',
      active          BOOLEAN DEFAULT false,
      approved_at     TIMESTAMPTZ,
      thumbs_up       INTEGER DEFAULT 0,
      thumbs_down     INTEGER DEFAULT 0,
      impressions     INTEGER DEFAULT 0
    )
  \`);

  // Competition entries — coin pick challenge
  await client.query(\`
    CREATE TABLE IF NOT EXISTS board_competitions (
      id                SERIAL PRIMARY KEY,
      created_at        TIMESTAMPTZ DEFAULT now(),
      meeting_id        INTEGER REFERENCES board_meetings(id),
      round_number      INTEGER,
      member_id         TEXT NOT NULL,
      competition_type  TEXT DEFAULT 'coin_pick',
      coin              TEXT NOT NULL,
      regime_factor_1   TEXT NOT NULL,
      regime_factor_2   TEXT NOT NULL,
      hypothesis        TEXT,
      statistical_basis TEXT,
      entry_price       FLOAT,
      evaluated_at      TIMESTAMPTZ,
      result            JSONB,
      score             FLOAT,
      active            BOOLEAN DEFAULT true
    )
  \`);

  // BTC forecast — collective direction prediction
  await client.query(\`
    CREATE TABLE IF NOT EXISTS board_btc_forecasts (
      id                      SERIAL PRIMARY KEY,
      created_at              TIMESTAMPTZ DEFAULT now(),
      meeting_id              INTEGER REFERENCES board_meetings(id),
      round_number            INTEGER,
      btc_price_at_forecast   FLOAT,
      btc_price_at_review     FLOAT,
      actual_direction        TEXT,
      actual_change_pct       FLOAT,
      consensus_direction     TEXT,
      consensus_correct       BOOLEAN,
      individual_forecasts    JSONB,
      regime_snapshot         JSONB,
      reviewed_at             TIMESTAMPTZ
    )
  \`);

  // User feedback — thumbs up/down on board changes
  await client.query(\`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ DEFAULT now(),
      feature_type    TEXT NOT NULL,
      feature_id      INTEGER NOT NULL,
      vote            TEXT NOT NULL,
      session_id      TEXT,
      ip_hash         TEXT
    )
  \`);
  try { await client.query(\`CREATE INDEX IF NOT EXISTS idx_user_feedback_feature ON user_feedback(feature_type, feature_id)\`); } catch {}
`;

if (insertBefore("  await client.query(`CREATE INDEX IF NOT EXISTS idx_board_meetings_round", NEW_TABLES)) {
  patchCount++;
  console.log(`✅ PATCH 3: New database tables added`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 4: Add new data queries to buildMeetingContext()
// ═══════════════════════════════════════════════════════════════

const NEW_CONTEXT_QUERIES = `
  // ═══ v3: DATA HEALTH DIAGNOSTICS ═══
  let dataHealth = {};
  try {
    const { rows: [snapshotCoverage] } = await client.query(\`
      SELECT 
        COUNT(*)::int as total_signals,
        COUNT(*) FILTER (WHERE regime_snapshot IS NOT NULL)::int as with_snapshot,
        COUNT(*) FILTER (WHERE filtered_by IS NOT NULL)::int as with_filtered_by,
        COUNT(*) FILTER (WHERE status = 'filtered')::int as filtered_signals,
        COUNT(*) FILTER (WHERE status = 'closed')::int as closed_signals,
        COUNT(*) FILTER (WHERE status = 'open')::int as open_signals
      FROM "FracmapSignal" WHERE "createdAt" > now() - interval '7 days'
    \`);
    dataHealth = snapshotCoverage || {};
  } catch {}

  // ═══ v3: SIGNAL VOLUME RATE ═══
  let signalRate = { passed_per_hour: 0, filtered_per_hour: 0 };
  try {
    const { rows: [rate] } = await client.query(\`
      SELECT 
        COUNT(*) FILTER (WHERE status != 'filtered')::float / GREATEST(EXTRACT(EPOCH FROM (now() - MIN("createdAt"))) / 3600, 1) as passed_per_hour,
        COUNT(*) FILTER (WHERE status = 'filtered')::float / GREATEST(EXTRACT(EPOCH FROM (now() - MIN("createdAt"))) / 3600, 1) as filtered_per_hour
      FROM "FracmapSignal" WHERE "createdAt" > now() - interval '24 hours'
    \`);
    signalRate = rate || signalRate;
  } catch {}

  // ═══ v3: BTC OHLC DATA FOR FORECAST ═══
  let btcOhlc = [];
  try {
    const { rows } = await client.query(\`
      SELECT timestamp, open, high, low, close, volume
      FROM "Candle1h" WHERE symbol = 'BTCUSDT'
      ORDER BY timestamp DESC LIMIT 60
    \`);
    btcOhlc = rows.reverse();
    console.log(\`  ✅ BTC OHLC: \${btcOhlc.length} hourly bars loaded\`);
  } catch (err) {
    console.warn(\`  ⚠ BTC OHLC query failed: \${err.message}\`);
  }

  // ═══ v3: BTC REGIME DATA ═══
  let btcRegime = null;
  try {
    const { rows } = await client.query(
      \`SELECT data FROM regime_cache WHERE symbol = 'BTCUSDT' AND timeframe = '1h' LIMIT 1\`
    );
    if (rows.length > 0) {
      btcRegime = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    }
  } catch {}

  // ═══ v3: PREVIOUS BTC FORECAST (for scoring) ═══
  let previousForecast = null;
  try {
    const { rows } = await client.query(
      \`SELECT * FROM board_btc_forecasts WHERE reviewed_at IS NULL ORDER BY created_at DESC LIMIT 1\`
    );
    previousForecast = rows.length > 0 ? rows[0] : null;
  } catch {}

  // ═══ v3: BTC FORECAST TRACK RECORD ═══
  let forecastRecord = { total: 0, correct: 0, streak: 0 };
  try {
    const { rows } = await client.query(
      \`SELECT consensus_correct FROM board_btc_forecasts WHERE reviewed_at IS NOT NULL ORDER BY created_at DESC LIMIT 20\`
    );
    forecastRecord.total = rows.length;
    forecastRecord.correct = rows.filter(r => r.consensus_correct).length;
    let streak = 0;
    for (const r of rows) { if (r.consensus_correct) streak++; else break; }
    forecastRecord.streak = streak;
  } catch {}

  // ═══ v3: COMPETITION LEADERBOARD ═══
  let competitionLeaderboard = [];
  try {
    const { rows } = await client.query(\`
      SELECT member_id, COUNT(*)::int as entries,
             COUNT(*) FILTER (WHERE evaluated_at IS NOT NULL)::int as evaluated,
             AVG(score) FILTER (WHERE score IS NOT NULL) as avg_score
      FROM board_competitions WHERE active = true
      GROUP BY member_id ORDER BY AVG(score) DESC NULLS LAST
    \`);
    competitionLeaderboard = rows;
  } catch {}

  let activeCompetitions = [];
  try {
    const { rows } = await client.query(
      \`SELECT * FROM board_competitions WHERE active = true AND evaluated_at IS NULL ORDER BY created_at DESC LIMIT 10\`
    );
    activeCompetitions = rows;
  } catch {}

  // ═══ v3: HERO CONTENT & FEEDBACK ═══
  let heroContent = null;
  try {
    const { rows } = await client.query(
      \`SELECT * FROM board_hero_content WHERE active = true ORDER BY created_at DESC LIMIT 1\`
    );
    heroContent = rows[0] || null;
  } catch {}

  let heroHistory = [];
  try {
    const { rows } = await client.query(
      \`SELECT authored_by, headline, thumbs_up, thumbs_down, created_at
       FROM board_hero_content ORDER BY created_at DESC LIMIT 5\`
    );
    heroHistory = rows;
  } catch {}

  // ═══ v3: USER FEEDBACK SUMMARY ═══
  let feedbackSummary = [];
  try {
    const { rows } = await client.query(\`
      SELECT feature_type, feature_id, 
             COUNT(*) FILTER (WHERE vote = 'up')::int as thumbs_up,
             COUNT(*) FILTER (WHERE vote = 'down')::int as thumbs_down
      FROM user_feedback WHERE created_at > now() - interval '7 days'
      GROUP BY feature_type, feature_id
    \`);
    feedbackSummary = rows;
  } catch {}

`;

// Insert before the return statement in buildMeetingContext
if (insertBefore("  return {\n    timestamp: new Date().toISOString(),", NEW_CONTEXT_QUERIES)) {
  patchCount++;
  console.log(`✅ PATCH 4: New context queries added`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 5: Add new fields to the return object
// ═══════════════════════════════════════════════════════════════

const NEW_RETURN_FIELDS = `    dataHealth,
    signalRate,
    btcOhlc,
    btcRegime,
    previousForecast,
    forecastRecord,
    competitionLeaderboard,
    activeCompetitions,
    heroContent,
    heroHistory,
    feedbackSummary,
`;

if (insertAfter("    filteredOutcomes,", NEW_RETURN_FIELDS)) {
  patchCount++;
  console.log(`✅ PATCH 5: New return fields added to buildMeetingContext`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 6: Add new deploy cases to deployMotion()
// ═══════════════════════════════════════════════════════════════

const NEW_DEPLOY_CASES = `    case 'AFFIRM_PATIENCE': {
      console.log(\`  ✅ PATIENCE AFFIRMED: \${details.rationale || motion.title}\`);
      // No system changes — this is a formal "do nothing" vote
      return true;
    }
    case 'EDIT_HERO': {
      const d = details;
      // Enforce character limits
      if ((d.headline || '').length > 40 || (d.subheadline || '').length > 60 ||
          (d.body_text || '').length > 250 || (d.badge_text || '').length > 30) {
        console.log(\`  ❌ Hero content exceeds character limits\`);
        return false;
      }
      // Deactivate previous hero
      await client.query(\`UPDATE board_hero_content SET active = false WHERE active = true\`);
      await client.query(
        \`INSERT INTO board_hero_content
         (meeting_id, authored_by, badge_text, headline, subheadline, body_text, cta_left, cta_right, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)\`,
        [meetingId, chairId,
         (d.badge_text || 'LIVE — Signals firing now').slice(0, 30),
         (d.headline || 'Recursive AI Alpha').slice(0, 40),
         (d.subheadline || 'Humans built it. The machines took it from here.').slice(0, 60),
         (d.body_text || '').slice(0, 250),
         (d.cta_left || 'View Live Signals').slice(0, 25),
         (d.cta_right || 'See the Evidence').slice(0, 25)]
      );
      console.log(\`  ✅ Hero content updated by \${chairId}\`);
      return true;
    }
    case 'COMPETITION_ENTRY': {
      // Each board member submitting is handled via the chair — store with chair's ID
      // In future, allow individual submissions during Phase 4
      const d = details;
      if (!d.coin || !d.regime_factor_1 || !d.regime_factor_2) {
        console.log(\`  ❌ Competition entry missing required fields\`);
        return false;
      }
      // Get current price for the coin
      let entryPrice = 0;
      try {
        const { rows } = await client.query(
          \`SELECT close FROM "Candle1h" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1\`,
          [d.coin]
        );
        entryPrice = rows.length > 0 ? parseFloat(rows[0].close) : 0;
      } catch {}
      await client.query(
        \`INSERT INTO board_competitions 
         (meeting_id, round_number, member_id, coin, regime_factor_1, regime_factor_2, hypothesis, statistical_basis, entry_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)\`,
        [meetingId, roundNumber, chairId, d.coin, d.regime_factor_1, d.regime_factor_2,
         d.hypothesis || motion.hypothesis || '', d.statistical_basis || '', entryPrice]
      );
      console.log(\`  ✅ Competition entry: \${d.coin} + [\${d.regime_factor_1}, \${d.regime_factor_2}] by \${chairId}\`);
      return true;
    }
`;

// Insert before the default case in deployMotion
if (insertBefore("    default: {\n      console.log(`  ⏸ ${type} requires manual review`);", NEW_DEPLOY_CASES)) {
  patchCount++;
  console.log(`✅ PATCH 6: New deploy cases added (AFFIRM_PATIENCE, EDIT_HERO, COMPETITION_ENTRY)`);
}

// We need roundNumber available in deployMotion — add it as a parameter
// The function signature currently is: async function deployMotion(client, motion, chairId, meetingId)
src = src.replace(
  'async function deployMotion(client, motion, chairId, meetingId)',
  'async function deployMotion(client, motion, chairId, meetingId, roundNumber)'
);
// And update the call site
src = src.replace(
  'deployed = await deployMotion(client, synthesis.motion, chair.id, meetingId);',
  'deployed = await deployMotion(client, synthesis.motion, chair.id, meetingId, roundNumber);'
);
console.log(`✅ PATCH 6b: deployMotion signature updated with roundNumber`);

// ═══════════════════════════════════════════════════════════════
// PATCH 7: Add BTC Forecast phase after Phase 7
// ═══════════════════════════════════════════════════════════════

const BTC_FORECAST_PHASE = `
    // ═══ BTC 60-MINUTE FORECAST (v3) ═══
    console.log(\`[BTC Forecast] All members predict BTC direction...\\n\`);
    
    let btcForecastData = null;
    if (context.btcOhlc.length >= 10) {
      // Build BTC data summary for the LLMs
      const btcBars = context.btcOhlc;
      const lastPrice = parseFloat(btcBars[btcBars.length - 1]?.close || 0);
      const btcSummary = [
        \`BTC Current Price: $\${lastPrice.toFixed(0)}\`,
        \`Last 10 bars (1H OHLC):\`,
        ...btcBars.slice(-10).map(b => {
          const t = new Date(b.timestamp).toISOString().slice(11, 16);
          return \`  \${t}: O\${parseFloat(b.open).toFixed(0)} H\${parseFloat(b.high).toFixed(0)} L\${parseFloat(b.low).toFixed(0)} C\${parseFloat(b.close).toFixed(0)}\`;
        }),
      ];
      if (context.btcRegime) {
        const r = context.btcRegime;
        btcSummary.push(\`BTC Regime: posInRange=\${(r.posInRange60||0).toFixed(2)} vol=\${r.volState||'?'} atr=\${(r.atrCompression||0).toFixed(2)}\`);
        btcSummary.push(\`  trend=\${(r.trend60||0).toFixed(2)} persistence=\${(r.persistence60||0).toFixed(2)} hurst=\${(r.hurst||0).toFixed(3)} regime=\${r.regime||'?'}\`);
      }
      if (context.forecastRecord.total > 0) {
        btcSummary.push(\`Track record: \${context.forecastRecord.correct}/\${context.forecastRecord.total} (\${((context.forecastRecord.correct/context.forecastRecord.total)*100).toFixed(0)}%)\`);
      }

      const forecastPromises = BOARD_MEMBERS.map(m => callLLM(m, memberSystem(m), \`
BTC 60-MINUTE FORECAST. Predict BTC direction for the next hour.

\${btcSummary.join('\\n')}

You MUST justify your prediction using the regime data above, not gut feeling.
Consider: posInRange (where in the range is BTC?), volatility state, trend, persistence, hurst.

Respond as JSON:
{
  "direction": "UP" or "DOWN",
  "confidence": "LOW" or "MEDIUM" or "HIGH",
  "reasoning": "2-3 sentences citing specific regime values"
}\`, 300));

      const forecastResponses = await Promise.all(forecastPromises);
      const forecasts = {};
      let upVotes = 0, downVotes = 0;
      
      for (let i = 0; i < BOARD_MEMBERS.length; i++) {
        totalTokens += forecastResponses[i].tokens;
        const parsed = parseJSON(forecastResponses[i].text) || { direction: 'UP', confidence: 'LOW', reasoning: forecastResponses[i].text };
        const dir = (parsed.direction || '').toUpperCase() === 'DOWN' ? 'DOWN' : 'UP';
        forecasts[BOARD_MEMBERS[i].id] = { direction: dir, confidence: parsed.confidence || 'LOW', reasoning: parsed.reasoning || '' };
        if (dir === 'UP') upVotes++; else downVotes++;
        console.log(\`  \${BOARD_MEMBERS[i].name}: \${dir} (\${parsed.confidence || 'LOW'}) — \${(parsed.reasoning || '').slice(0, 80)}\`);
      }

      const consensus = upVotes >= downVotes ? 'UP' : 'DOWN';
      console.log(\`\\n  Consensus: \${consensus} (\${upVotes} UP / \${downVotes} DOWN)\\n\`);

      // Save forecast
      try {
        await client.query(\`
          INSERT INTO board_btc_forecasts 
            (meeting_id, round_number, btc_price_at_forecast, consensus_direction, individual_forecasts, regime_snapshot)
          VALUES ($1, $2, $3, $4, $5, $6)\`,
          [meetingId, roundNumber, lastPrice, consensus, JSON.stringify(forecasts), 
           context.btcRegime ? JSON.stringify(context.btcRegime) : null]
        );
      } catch (err) {
        console.warn(\`  ⚠ Failed to save BTC forecast: \${err.message}\`);
      }

      btcForecastData = { consensus, upVotes, downVotes, forecasts, price: lastPrice };
    } else {
      console.log(\`  ⏭ Skipping forecast — insufficient BTC data (\${context.btcOhlc.length} bars)\\n\`);
    }

    // ═══ SCORE PREVIOUS BTC FORECAST ═══
    if (context.previousForecast && context.btcOhlc.length > 0) {
      const pf = context.previousForecast;
      const currentPrice = parseFloat(context.btcOhlc[context.btcOhlc.length - 1]?.close || 0);
      if (currentPrice > 0 && pf.btc_price_at_forecast > 0) {
        const actualDirection = currentPrice > pf.btc_price_at_forecast ? 'UP' : 'DOWN';
        const changePct = ((currentPrice - pf.btc_price_at_forecast) / pf.btc_price_at_forecast * 100);
        const consensusCorrect = pf.consensus_direction === actualDirection;
        try {
          await client.query(
            \`UPDATE board_btc_forecasts SET btc_price_at_review = $1, actual_direction = $2, actual_change_pct = $3, consensus_correct = $4, reviewed_at = now() WHERE id = $5\`,
            [currentPrice, actualDirection, changePct, consensusCorrect, pf.id]
          );
          console.log(\`  📊 Previous forecast scored: \${pf.consensus_direction} → \${actualDirection} (\${changePct >= 0 ? '+' : ''}\${changePct.toFixed(2)}%) — \${consensusCorrect ? '✅' : '❌'}\`);
        } catch {}
      }
    }

`;

// Insert after Phase 7 follow-up, before the SAVE section
if (insertBefore("    // ─── SAVE ───", BTC_FORECAST_PHASE)) {
  patchCount++;
  console.log(`✅ PATCH 7: BTC Forecast phase added`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 8: Update Phase 1 prompt to be maturity-aware
// ═══════════════════════════════════════════════════════════════

src = src.replace(
  `Focus on: what changed since last meeting, any concerning patterns, current regime state.

Respond as JSON:
{
  "situation_summary": "Your 3-5 sentence summary of the current state",
  "key_changes": ["change 1", "change 2", ...],
  "concerning_patterns": ["pattern 1", ...]
}`,
  `Focus on: data maturity status, any filters approaching decision-readiness,
regime conditions, and what changed since last meeting.

CRITICAL: Check the maturity scores FIRST. If no filters are decision-ready,
note this prominently — the board's main job may be patience, research, or creative work.

Respond as JSON:
{
  "situation_summary": "Your 3-5 sentence summary",
  "key_changes": ["change 1", "change 2", ...],
  "concerning_patterns": ["pattern 1", ...],
  "data_maturity_note": "Summary of which filters are/aren't decision-ready",
  "recommended_focus": "filters|research|competition|patience|creative"
}`
);
patchCount++;
console.log(`✅ PATCH 8: Phase 1 prompt updated (maturity-aware)`);

// ═══════════════════════════════════════════════════════════════
// PATCH 9: Update Phase 2 prompt (patience-aware)
// ═══════════════════════════════════════════════════════════════

src = src.replace(
  `PHASE 2 — PROBLEM IDENTIFICATION. As \${m.name} (\${m.role}), identify 1-3 problems
you see with the current system performance or configuration.

You may also request topics for future meetings if you see issues that aren't urgent
but should be discussed. These will be queued and shown to future chairs.`,
  `PHASE 2 — PROBLEM IDENTIFICATION. As \${m.name} (\${m.role}), identify 1-3 problems.

BEFORE IDENTIFYING PROBLEMS: Check the maturity status of all active filters.
If no filter has reached 2000+ evaluated signals AND 72+ hours, the correct
answer may be "insufficient data to evaluate our existing decisions."
This is a VALID and IMPORTANT problem that can lead to AFFIRM_PATIENCE.

Consider problems in ALL areas: filters, research gaps, competition opportunities,
hero section, BTC forecast accuracy, signal volume, regime analysis.

You may also request topics for future meetings.`
);
patchCount++;
console.log(`✅ PATCH 9: Phase 2 prompt updated (patience-aware)`);

// ═══════════════════════════════════════════════════════════════
// PATCH 10: Update Phase 4 solution prompt
// ═══════════════════════════════════════════════════════════════

src = src.replace(
  `IMPORTANT: If proposing a filter, you MUST specify which signal timeframe(s) it applies to.
Available timeframes: "1m" (1-minute bars), "1h" (1-hour bars), "1d" (daily bars), "all" (all timeframes).

Respond as JSON:
{
  "solution": "Your proposed solution in plain English",
  "motion_type": "One of: ADD_REGIME_FILTER, REMOVE_REGIME_FILTER, MODIFY_REGIME_FILTER, EXCLUDE_COIN, INCLUDE_COIN, ADD_COIN_OVERRIDE, NEW_REGIME_FEATURE, KILL_RESEARCH, STRATEGY_PARAMETER, EMERGENCY_HALT",`,
  `AVAILABLE MOTION TYPES (pick the most appropriate):
  • ADD_REGIME_FILTER / REMOVE / MODIFY — For filter changes (only if maturity allows)
  • AFFIRM_PATIENCE — To formally vote to wait and gather more data
  • EDIT_HERO — To update the home page hero section (creative)
  • COMPETITION_ENTRY — To submit a coin pick with novel regime factors
  • REQUEST_BACKTEST / REQUEST_ANALYSIS — For historical analysis
  • NEW_REGIME_FEATURE / KILL_RESEARCH — For research pipeline
  • EXCLUDE_COIN / INCLUDE_COIN — For coin management [needs human approval]

Respond as JSON:
{
  "solution": "Your proposed solution in plain English",
  "motion_type": "One of the types above",`
);
patchCount++;
console.log(`✅ PATCH 10: Phase 4 prompt updated (new motion types)`);

// ═══════════════════════════════════════════════════════════════
// PATCH 11: Add maturity section to formatBriefing (at the top)
// ═══════════════════════════════════════════════════════════════

// We'll add a data health + maturity section right after the operator message
const MATURITY_BRIEFING = `
  // ═══ v3: DATA HEALTH & FILTER MATURITY (shown first!) ═══
  // Maturity helper
  const computeMaturity = (filter) => {
    const totalSignals = (filter.trades_filtered || 0) + (filter.trades_passed || 0);
    const hoursActive = Math.round((Date.now() - new Date(filter.created_at).getTime()) / 3600000);
    const signalMaturity = Math.min(100, Math.round((totalSignals / 2000) * 100));
    const timeMaturity = Math.min(100, Math.round((hoursActive / 72) * 100));
    const overallMaturity = Math.min(signalMaturity, timeMaturity);
    return { totalSignals, hoursActive, signalMaturity, timeMaturity, overallMaturity, isDecisionReady: totalSignals >= 2000 && hoursActive >= 72 };
  };

  if (ctx.dataHealth) {
    const dh = ctx.dataHealth;
    briefing += \`📋 DATA HEALTH (7d): \${dh.total_signals || 0} signals, \${dh.with_snapshot || 0} with regime_snapshot (\${dh.total_signals > 0 ? ((dh.with_snapshot/dh.total_signals)*100).toFixed(0) : 0}%), \${dh.filtered_signals || 0} filtered, \${dh.closed_signals || 0} closed\\n\`;
    briefing += \`  Signal rate: \${parseFloat(ctx.signalRate?.passed_per_hour || 0).toFixed(1)} passed/hr, \${parseFloat(ctx.signalRate?.filtered_per_hour || 0).toFixed(1)} filtered/hr\\n\\n\`;
  }

  let anyDecisionReady = false;
  if (ctx.filterImpact.length > 0) {
    briefing += \`🔒 FILTER MATURITY STATUS (decision-readiness):\\n\`;
    for (const f of ctx.filterImpact) {
      const mat = computeMaturity(f);
      const bar = '█'.repeat(Math.round(mat.overallMaturity / 5)) + '░'.repeat(20 - Math.round(mat.overallMaturity / 5));
      const lock = mat.isDecisionReady ? '🔓' : '🔒';
      briefing += \`  \${lock} #\${f.id} \${f.feature} [\${(f.timeframe||'all').toUpperCase()}]: \${bar} \${mat.overallMaturity}% (\${mat.totalSignals}/2000 sigs, \${mat.hoursActive}/72h)\\n\`;
      if (mat.isDecisionReady) anyDecisionReady = true;
    }
    if (!anyDecisionReady) {
      briefing += \`\\n  ╔═══════════════════════════════════════════════════════════════╗\\n\`;
      briefing += \`  ║  ⚠ NO FILTERS DECISION-READY. Filter changes are BLOCKED.     ║\\n\`;
      briefing += \`  ║  Focus: research, competition, forecasts, hero, AFFIRM_PATIENCE║\\n\`;
      briefing += \`  ╚═══════════════════════════════════════════════════════════════╝\\n\`;
    }
    briefing += \`\\n\`;
  }

`;

// Insert at the start of formatBriefing, after the operator message block
if (insertAfter("    briefing += `───────────────────────────────────────────────────────────────────\\n\\n`;\n  }", MATURITY_BRIEFING)) {
  patchCount++;
  console.log(`✅ PATCH 11: Maturity section added to briefing`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 12: Add BTC forecast, competition & hero sections to briefing
// ═══════════════════════════════════════════════════════════════

// Add before "Available actions reminder"
const EXTRA_BRIEFING = `
  // ═══ v3: BTC FORECAST SECTION ═══
  if (ctx.btcOhlc?.length > 0 || ctx.forecastRecord?.total > 0) {
    briefing += \`\\n🔮 BTC 60-MIN FORECAST:\\n\`;
    if (ctx.previousForecast) {
      briefing += \`  Previous: \${ctx.previousForecast.consensus_direction || 'NONE'} at $\${parseFloat(ctx.previousForecast.btc_price_at_forecast || 0).toFixed(0)}\\n\`;
    }
    if (ctx.forecastRecord.total > 0) {
      briefing += \`  Track record: \${ctx.forecastRecord.correct}/\${ctx.forecastRecord.total} (\${((ctx.forecastRecord.correct/ctx.forecastRecord.total)*100).toFixed(0)}%)\`;
      if (ctx.forecastRecord.streak > 0) briefing += \` — \${ctx.forecastRecord.streak} streak\`;
      briefing += \`\\n\`;
    }
    if (ctx.btcOhlc.length > 0) {
      const last = ctx.btcOhlc[ctx.btcOhlc.length - 1];
      const first = ctx.btcOhlc[0];
      briefing += \`  BTC 60-bar range: \${parseFloat(first.open).toFixed(0)} → \${parseFloat(last.close).toFixed(0)}\\n\`;
    }
    if (ctx.btcRegime) {
      const r = ctx.btcRegime;
      briefing += \`  BTC regime: posInRange=\${(r.posInRange60||0).toFixed(2)} vol=\${r.volState||'?'} atr=\${(r.atrCompression||0).toFixed(2)} hurst=\${(r.hurst||0).toFixed(3)}\\n\`;
    }
  }

  // ═══ v3: COMPETITION LEADERBOARD ═══
  if (ctx.competitionLeaderboard?.length > 0) {
    briefing += \`\\n🏆 COIN PICK COMPETITION:\\n\`;
    for (const l of ctx.competitionLeaderboard) {
      briefing += \`  \${l.member_id.toUpperCase()}: \${l.entries} entries, \${l.evaluated} scored, avg=\${l.avg_score ? parseFloat(l.avg_score).toFixed(2) : 'n/a'}\\n\`;
    }
  }
  if (ctx.activeCompetitions?.length > 0) {
    briefing += \`  Active: \${ctx.activeCompetitions.map(c => \`\${c.member_id.toUpperCase()}→\${c.coin}[\${c.regime_factor_1},\${c.regime_factor_2}]\`).join(' | ')}\\n\`;
  }

  // ═══ v3: HERO CONTENT & USER FEEDBACK ═══
  if (ctx.heroContent) {
    briefing += \`\\n🎨 HERO (by \${ctx.heroContent.authored_by.toUpperCase()}): "\${ctx.heroContent.headline}" 👍\${ctx.heroContent.thumbs_up||0}/👎\${ctx.heroContent.thumbs_down||0}\\n\`;
  }
  if (ctx.feedbackSummary?.length > 0) {
    briefing += \`👥 USER FEEDBACK: \${ctx.feedbackSummary.map(f => \`\${f.feature_type}#\${f.feature_id}:👍\${f.thumbs_up}👎\${f.thumbs_down}\`).join(' | ')}\\n\`;
  }

  // ═══ v3: LOW SIGNAL VOLUME PROMPT ═══
  const passedRate = parseFloat(ctx.signalRate?.passed_per_hour || 0);
  if (passedRate < 5 && passedRate > 0) {
    briefing += \`\\n⚠ LOW SIGNAL VOLUME (\${passedRate.toFixed(1)}/hr). Focus on: RESEARCH, COMPETITION, BACKTEST, CREATIVE, AFFIRM_PATIENCE\\n\`;
  }

`;

if (insertBefore("  // Available actions reminder", EXTRA_BRIEFING)) {
  patchCount++;
  console.log(`✅ PATCH 12: BTC forecast, competition, hero, feedback sections added to briefing`);
}

// ═══════════════════════════════════════════════════════════════
// PATCH 13: Update available actions in briefing
// ═══════════════════════════════════════════════════════════════

src = src.replace(
  `  briefing += \`  • ADD_REGIME_FILTER — Deploy a new signal filter (specify timeframe: 1m/1h/1d/all) [auto-deploys]\\n\`;`,
  `  briefing += \`  • ADD_REGIME_FILTER — Deploy a new signal filter [auto-deploys, respects maturity locks]\\n\`;
  briefing += \`  • AFFIRM_PATIENCE — Formally vote to wait and gather more data [auto-deploys]\\n\`;
  briefing += \`  • EDIT_HERO — Update home page hero section (chair's turn) [auto-deploys]\\n\`;
  briefing += \`  • COMPETITION_ENTRY — Submit coin pick with novel regime factors [auto-deploys]\\n\`;`
);
patchCount++;
console.log(`✅ PATCH 13: Available actions updated`);

// ═══════════════════════════════════════════════════════════════
// PATCH 14: Update the header comment to v3
// ═══════════════════════════════════════════════════════════════

src = src.replace(
  '║  NTLGNC — LLM STRATEGY BOARD v2',
  '║  NTLGNC — LLM STRATEGY BOARD v3'
);
src = src.replace(
  '║  8-Phase Structured Meeting Protocol                             ║',
  '║  8-Phase Structured Meeting Protocol + BTC Forecast              ║'
);
patchCount++;
console.log(`✅ PATCH 14: Header updated to v3`);

// ═══════════════════════════════════════════════════════════════
// WRITE
// ═══════════════════════════════════════════════════════════════

fs.writeFileSync(BOARD_PATH, src);

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ✅ ALL ${patchCount} PATCHES APPLIED SUCCESSFULLY`);
console.log(`  Backup: ${BACKUP_PATH}`);
console.log(`  Updated: ${BOARD_PATH}`);
console.log(`${'═'.repeat(60)}\n`);
console.log(`Next steps:`);
console.log(`  1. Review the patched file`);
console.log(`  2. Create board-api.js for hero/feedback API endpoints`);
console.log(`  3. Restart the llm-board process`);
console.log(`  4. Run: node backend/trigger-meeting.cjs to test\n`);
