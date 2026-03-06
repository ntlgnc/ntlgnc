/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  FRACMAP — LLM STRATEGY BOARD v4                                 ║
 * ║  BTC Forecast Challenge — Clean Slate Rewrite                   ║
 * ║                                                                  ║
 * ║  Phase 0: Score Previous Round (DB only)                        ║
 * ║  Phase 1: Initial Analysis (5 parallel)                         ║
 * ║  Phase 2: Chair Summary (1 call)                                ║
 * ║  Phase 3: Deliberation (5 sequential)                           ║
 * ║  Phase 4: Final Vote + Individual Forecasts (5 parallel)        ║
 * ║  Phase 5: Process Vote (0-5 conditional)                        ║
 * ║  Phase 6: Hero Edit — Winner's Reward (1 call)                  ║
 * ║  Phase 7: Save Everything (DB only)                             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Robust .env loading — search multiple locations like other backend scripts
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envCandidates = [
  join(__dirname, '.env'),
  join(__dirname, '.env.local'),
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.local'),
  join(__dirname, '..', '.env'),
  join(__dirname, '..', '.env.local'),
];
const envPath = envCandidates.find(p => existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`[board] Loaded env from ${envPath}`);
} else {
  dotenv.config(); // fallback
  console.log(`[board] ⚠ No .env found in searched paths`);
}
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });


// ═══════════════════════════════════════════════════════════════
// GENESIS DOCUMENT — BTC Forecast Challenge Charter
// ═══════════════════════════════════════════════════════════════

const GENESIS_DOCUMENT = `
╔══════════════════════════════════════════════════════════════════╗
║  FRACMAP STRATEGY BOARD — BTC FORECAST CHALLENGE                 ║
║  Charter v4.0 — March 2026                                      ║
╚══════════════════════════════════════════════════════════════════╝

PURPOSE: Five AI models predict BTC's direction every hour. You are scored
on direction accuracy, price accuracy, and statistical significance (p-value).

SCORING:
  • Direction: Did you call UP or DOWN correctly?
  • Price: How close was your price_target to the actual price?
  • p-value: One-sided binomial test — is your accuracy better than chance?
  • Edge: Your accuracy minus the base rate (% of rounds BTC went UP)
  • Streaks: Consecutive correct calls tracked

AVAILABLE DATA (provided each round):
  • BTC 1H OHLC bars (configurable count, default 24)
  • BTC regime snapshot: posInRange60, volState, ATR, trend, persistence, hurst
  • Full leaderboard with p-values and streaks
  • Last N scored rounds with individual predictions + outcomes
  • Your personal stats highlighted
  • Previous round result

MEETING STRUCTURE:
  Phase 1: Initial Analysis — all 5 members analyse independently (parallel)
  Phase 2: Chair Summary — best forecaster summarises all analyses
  Phase 3: Deliberation — each member responds to colleagues (sequential)
  Phase 4: Final Vote — group vote + individual prediction (parallel)
  Phase 5: Process Vote — vote on any proposed process changes (conditional)
  Phase 6: Hero Edit — best forecaster updates homepage (reward)

DELIBERATION RULES:
  • You MUST reference at least one colleague's argument by name
  • You may revise your prediction if persuaded — this is strength, not weakness
  • You may propose a process change (e.g. increase history bars from 24 to 36)
  • Be specific: cite numbers, name colleagues, explain your reasoning

PROCESS CHANGES:
  • Any member may propose a process change during deliberation
  • All 5 vote YES/NO; 4/5 majority to pass
  • Changes stored in board_forecast_config and take effect next meeting
  • Examples: increase/decrease bars, enable/disable regime features

PRINCIPLES:
  DATA OVER NARRATIVE — cite numbers, not stories
  ACKNOWLEDGE UNCERTAINTY — LOW confidence is valid and honest
  LEARN FROM MISTAKES — your track record is public, own it
  INDEPENDENCE OF THOUGHT — the best forecaster disagrees when data says to
`.trim();


// ═══════════════════════════════════════════════════════════════
// THE BOARD
// ═══════════════════════════════════════════════════════════════

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const BOARD_MEMBERS = [
  {
    id: 'claude', name: 'Claude', role: 'Risk Analyst',
    personality: `You are the risk analyst. You think in regime changes, mean reversion, and tail risk.
    You watch for exhaustion signals — when BTC is at range extremes and volatility is compressing,
    you call reversals. You distrust momentum at extended levels. You cite posInRange, ATR compression,
    and Hurst exponent. You have a dry British wit.`,
    model: process.env.CLAUDE_OPUS_MODEL || 'anthropic/claude-opus-4.6',
  },
  {
    id: 'gpt', name: 'GPT', role: 'Pattern Hunter',
    personality: `You are the pattern hunter. You look for momentum, technical setups, and multi-bar
    structures. You track candle patterns — engulfing, doji, pin bars. You read volume divergences.
    You believe trends persist until structure breaks. You speak with energy and conviction.
    You cite specific bar patterns and price levels.`,
    model: process.env.CHATGPT_MODEL || 'openai/gpt-5-chat',
  },
  {
    id: 'grok', name: 'Grok', role: 'Contrarian',
    personality: `You are the contrarian. When everyone agrees, you challenge. You look for exhaustion
    signals, over-crowded trades, and reversals. You believe consensus predictions are priced in.
    When the group says UP, you ask "but what if DOWN?" You argue from positioning, not narrative.
    You speak bluntly with dark humour.`,
    model: process.env.XAI_GROK_MODEL || 'x-ai/grok-3',
  },
  {
    id: 'gemini', name: 'Gemini', role: 'Systems Thinker',
    personality: `You are the systems thinker. You see cross-timeframe context — when 1H says UP but
    daily structure says DOWN, you flag it. You track persistence, Hurst exponent, and regime
    transitions. You believe in regime awareness over pattern recognition. You speak methodically.`,
    model: process.env.GEMINI_FLASH_MODEL || 'google/gemini-3-pro-preview',
  },
  {
    id: 'deepseek', name: 'DeepSeek', role: 'Empiricist',
    personality: `You are the empiricist. You only care about data. You ask: "What's my hit rate in
    this regime? What's the base rate? What's my p-value?" You track your own performance obsessively.
    You never let narrative override statistics. You speak in short, precise statements. You love tables.`,
    model: process.env.DEEPSEEK_V3_MODEL || 'deepseek/deepseek-v3.2',
  },
];


// ═══════════════════════════════════════════════════════════════
// LLM API
// ═══════════════════════════════════════════════════════════════

async function callLLM(member, systemPrompt, userPrompt, maxTokens = 2000) {
  const startTime = Date.now();
  if (!OPENROUTER_KEY) return { text: '[ERROR: OPENROUTER_API_KEY not set]', tokens: 0, ms: 0 };

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://fracmap.com',
        'X-Title': 'FRACMAP Strategy Board',
      },
      body: JSON.stringify({
        model: member.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || data.error?.message || JSON.stringify(data.error) || 'No response';
    return { text, tokens: data.usage?.completion_tokens || 0, ms: Date.now() - startTime, model: data.model };
  } catch (err) {
    return { text: `[ERROR: ${err.message}]`, tokens: 0, ms: Date.now() - startTime };
  }
}

function parseJSON(text) {
  if (!text || typeof text !== 'string') return null;

  // Step 1: Strip markdown code fences
  let clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Step 2: Strip any preamble text before the first { or [
  const firstBrace = clean.indexOf('{');
  const firstBracket = clean.indexOf('[');
  const start = Math.min(
    firstBrace >= 0 ? firstBrace : Infinity,
    firstBracket >= 0 ? firstBracket : Infinity
  );
  if (start < Infinity) clean = clean.slice(start);

  // Step 3: Strip any trailing text after the last } or ]
  const lastBrace = clean.lastIndexOf('}');
  const lastBracket = clean.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);
  if (end > 0) clean = clean.slice(0, end + 1);

  // Step 4: Fix trailing commas before closing braces/brackets
  clean = clean.replace(/,\s*([}\]])/g, '$1');

  // Step 5: Try direct parse
  try { return JSON.parse(clean); } catch {}

  // Step 6: Try fixing truncated JSON by adding missing closing braces/brackets
  let attempt = clean;
  const openBraces = (attempt.match(/{/g) || []).length;
  const closeBraces = (attempt.match(/}/g) || []).length;
  const openBrackets = (attempt.match(/\[/g) || []).length;
  const closeBrackets = (attempt.match(/\]/g) || []).length;

  // Remove any trailing incomplete key-value pair (truncated mid-string)
  attempt = attempt.replace(/,?\s*"[^"]*"?\s*:?\s*"?[^"{}[\]]*$/, '');

  for (let i = 0; i < openBrackets - closeBrackets; i++) attempt += ']';
  for (let i = 0; i < openBraces - closeBraces; i++) attempt += '}';
  // Fix trailing commas again after surgery
  attempt = attempt.replace(/,\s*([}\]])/g, '$1');

  try { return JSON.parse(attempt); } catch {}

  return null;
}


// ═══════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════

function binomialPValue(k, n, p = 0.5) {
  if (n === 0 || k <= 0) return 1;
  if (k > n) return 0;
  function logChoose(n, k) {
    if (k < 0 || k > n) return -Infinity;
    if (k === 0 || k === n) return 0;
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1);
    return s;
  }
  let cdf = 0;
  for (let i = 0; i < k; i++) {
    cdf += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}


// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_meetings (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      round_number    INTEGER NOT NULL,
      chair_id        TEXT NOT NULL,
      phase           TEXT NOT NULL DEFAULT 'started',
      agenda          JSONB,
      context         JSONB,
      proposals       JSONB,
      debate          JSONB,
      votes           JSONB,
      decision        TEXT,
      motion_type     TEXT,
      motion_details  JSONB,
      backtest_result JSONB,
      deployed        BOOLEAN DEFAULT false,
      impact_review   JSONB,
      follow_up_target TEXT,
      follow_up_met   BOOLEAN,
      duration_ms     INTEGER,
      total_tokens    INTEGER DEFAULT 0,
      digest          TEXT
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS board_filters (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      active          BOOLEAN DEFAULT true,
      filter_type     TEXT NOT NULL,
      feature         TEXT NOT NULL,
      conditions      JSONB NOT NULL,
      rationale       TEXT,
      proposed_by     TEXT,
      meeting_id      INTEGER REFERENCES board_meetings(id),
      backtest_sharpe FLOAT,
      live_sharpe     FLOAT,
      trades_filtered INTEGER DEFAULT 0,
      trades_passed   INTEGER DEFAULT 0,
      timeframe       TEXT DEFAULT 'all',
      impact_data     JSONB,
      impact_measured_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS board_coin_overrides (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      active          BOOLEAN DEFAULT true,
      symbol          TEXT NOT NULL,
      override_type   TEXT NOT NULL,
      parameters      JSONB NOT NULL,
      rationale       TEXT,
      meeting_id      INTEGER REFERENCES board_meetings(id)
    )
  `);

  // Hero content — LLM-authored home page hero section
  await client.query(`
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
  `);

  // BTC forecast — collective direction prediction
  await client.query(`
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
      individual_scores       JSONB,
      regime_snapshot         JSONB,
      reviewed_at             TIMESTAMPTZ,
      group_vote_direction    TEXT,
      group_vote_details      JSONB,
      phase1_analyses         JSONB,
      chair_summary           TEXT,
      deliberation            JSONB,
      process_proposals       JSONB
    )
  `);

  // Per-LLM forecast accuracy leaderboard
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_forecast_leaderboard (
      id              SERIAL PRIMARY KEY,
      member_id       TEXT NOT NULL,
      total_forecasts INT DEFAULT 0,
      correct_direction INT DEFAULT 0,
      total_abs_error FLOAT DEFAULT 0,
      best_streak     INT DEFAULT 0,
      current_streak  INT DEFAULT 0,
      last_updated    TIMESTAMPTZ DEFAULT now(),
      group_vote_correct INT DEFAULT 0,
      UNIQUE(member_id)
    )
  `);

  // Forecast config — dynamic process parameters
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_forecast_config (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT now(),
      updated_by_meeting INTEGER
    )
  `);

  // Seed default config
  await client.query(`
    INSERT INTO board_forecast_config (key, value) VALUES ('btc_bars', '24'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);
  await client.query(`
    INSERT INTO board_forecast_config (key, value) VALUES ('history_rounds', '24'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);

  // Add new columns if missing (safe for existing installs)
  const safeAlter = async (q) => { try { await client.query(q); } catch {} };
  await safeAlter(`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS group_vote_direction TEXT`);
  await safeAlter(`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS group_vote_details JSONB`);
  await safeAlter(`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS phase1_analyses JSONB`);
  await safeAlter(`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS chair_summary TEXT`);
  await safeAlter(`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS deliberation JSONB`);
  await safeAlter(`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS process_proposals JSONB`);
  await safeAlter(`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS individual_scores JSONB`);
  await safeAlter(`ALTER TABLE board_forecast_leaderboard ADD COLUMN IF NOT EXISTS group_vote_correct INT DEFAULT 0`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_board_meetings_round ON board_meetings(round_number DESC)`);
}


// ═══════════════════════════════════════════════════════════════
// CONTEXT BUILDER — BTC-focused data gathering
// ═══════════════════════════════════════════════════════════════

async function getConfig(client) {
  const config = {};
  try {
    const { rows } = await client.query(`SELECT key, value FROM board_forecast_config`);
    for (const r of rows) config[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
  } catch {}
  return {
    btc_bars: parseInt(config.btc_bars) || 24,
    history_rounds: parseInt(config.history_rounds) || 24,
    ...config,
  };
}

async function buildMeetingContext(client) {
  const config = await getConfig(client);

  // BTC OHLC bars
  let btcOhlc = [];
  try {
    const { rows } = await client.query(`
      SELECT timestamp, open, high, low, close, volume
      FROM "Candle1h" WHERE symbol = 'BTCUSDT'
      ORDER BY timestamp DESC LIMIT $1
    `, [config.btc_bars]);
    btcOhlc = rows.reverse();
    console.log(`  ✅ BTC OHLC: ${btcOhlc.length} hourly bars loaded`);
  } catch (err) {
    console.warn(`  ⚠ BTC OHLC query failed: ${err.message}`);
  }

  // BTC regime
  let btcRegime = null;
  try {
    const { rows } = await client.query(
      `SELECT data FROM regime_cache WHERE symbol = 'BTCUSDT' AND timeframe = '1h' LIMIT 1`
    );
    if (rows.length > 0) {
      btcRegime = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    }
  } catch {}

  // Unscored previous forecast (for Phase 0 scoring)
  let previousForecast = null;
  try {
    const { rows } = await client.query(
      `SELECT * FROM board_btc_forecasts WHERE reviewed_at IS NULL ORDER BY created_at DESC LIMIT 1`
    );
    previousForecast = rows.length > 0 ? rows[0] : null;
  } catch {}

  // Leaderboard
  let forecastLeaderboard = [];
  try {
    const { rows } = await client.query(
      `SELECT * FROM board_forecast_leaderboard
       ORDER BY CASE WHEN total_forecasts = 0 THEN 0
                     ELSE correct_direction::float / total_forecasts END DESC`
    );
    forecastLeaderboard = rows;
  } catch {}

  // Last N scored rounds (full detail)
  let scoredRounds = [];
  try {
    const { rows } = await client.query(`
      SELECT round_number, consensus_direction, consensus_correct, actual_direction,
             actual_change_pct, btc_price_at_forecast, btc_price_at_review,
             individual_forecasts, individual_scores, group_vote_direction,
             group_vote_details, created_at, reviewed_at
      FROM board_btc_forecasts WHERE reviewed_at IS NOT NULL
      ORDER BY created_at DESC LIMIT $1
    `, [config.history_rounds]);
    scoredRounds = rows;
  } catch {}

  // Older scored rounds beyond the detail window (compressed chain)
  let olderRounds = [];
  try {
    const { rows } = await client.query(`
      SELECT round_number, consensus_direction, consensus_correct, actual_direction,
             actual_change_pct, btc_price_at_forecast, btc_price_at_review,
             group_vote_direction, created_at
      FROM board_btc_forecasts WHERE reviewed_at IS NOT NULL
      ORDER BY created_at DESC
      OFFSET $1 LIMIT 200
    `, [config.history_rounds]);
    olderRounds = rows;
  } catch {}

  // Hero content
  let heroContent = null;
  try {
    const { rows } = await client.query(
      `SELECT * FROM board_hero_content WHERE active = true ORDER BY created_at DESC LIMIT 1`
    );
    heroContent = rows[0] || null;
  } catch {}

  // Round number
  const { rows: lastMeeting } = await client.query(
    `SELECT round_number FROM board_meetings ORDER BY round_number DESC LIMIT 1`
  );
  const roundNumber = (lastMeeting[0]?.round_number || 0) + 1;

  return {
    config,
    btcOhlc,
    btcRegime,
    previousForecast,
    forecastLeaderboard,
    scoredRounds,
    olderRounds,
    heroContent,
    roundNumber,
    timestamp: new Date().toISOString(),
  };
}


// ═══════════════════════════════════════════════════════════════
// BRIEFING FORMATTER — Compact BTC-focused briefing
// ═══════════════════════════════════════════════════════════════

function formatBriefing(ctx, memberId = null) {
  const lb = ctx.forecastLeaderboard;
  const rounds = ctx.scoredRounds;
  const bars = ctx.btcOhlc;
  const regime = ctx.btcRegime;

  let b = `═══ BTC FORECAST CHALLENGE — Round #${ctx.roundNumber} ═══\n`;
  b += `${ctx.timestamp}\n\n`;

  // Config
  b += `⚙ CONFIG: ${ctx.config.btc_bars} bars, ${ctx.config.history_rounds} history rounds\n\n`;

  // BTC price data
  if (bars.length > 0) {
    const last = bars[bars.length - 1];
    const first = bars[0];
    b += `📊 BTC 1H OHLC (last ${bars.length} bars):\n`;
    b += `  Range: $${parseFloat(first.open).toFixed(0)} → $${parseFloat(last.close).toFixed(0)}\n`;
    // Show last 12 bars in compact format
    const showBars = bars.slice(-12);
    for (const bar of showBars) {
      const t = new Date(bar.timestamp).toISOString().slice(11, 16);
      const o = parseFloat(bar.open).toFixed(0);
      const h = parseFloat(bar.high).toFixed(0);
      const l = parseFloat(bar.low).toFixed(0);
      const c = parseFloat(bar.close).toFixed(0);
      const dir = parseFloat(bar.close) >= parseFloat(bar.open) ? '▲' : '▼';
      b += `  ${t} ${dir} O${o} H${h} L${l} C${c}\n`;
    }
    b += `\n`;
  }

  // Regime snapshot
  if (regime) {
    b += `🔬 BTC REGIME:\n`;
    b += `  posInRange60: ${(regime.posInRange60 || 0).toFixed(3)}\n`;
    b += `  volState: ${regime.volState || '?'}\n`;
    b += `  atrCompression: ${(regime.atrCompression || 0).toFixed(3)}\n`;
    b += `  trend60: ${(regime.trend60 || 0).toFixed(3)}\n`;
    b += `  persistence60: ${(regime.persistence60 || 0).toFixed(3)}\n`;
    b += `  hurst: ${(regime.hurst || 0).toFixed(4)}\n`;
    b += `  regime: ${regime.regime || '?'}\n\n`;
  }

  // Leaderboard with p-values
  if (lb.length > 0) {
    // Base rate
    const totalUp = rounds.filter(r => r.actual_direction === 'UP').length;
    const baseRate = rounds.length > 0 ? (totalUp / rounds.length * 100).toFixed(1) : '50.0';

    b += `🏆 FORECAST LEADERBOARD (base rate: ${baseRate}% UP):\n`;
    b += `  Name       Dir%   p-value  AvgErr  Streak  Best  n    GrpVote%\n`;
    b += `  ─────────  ─────  ───────  ──────  ──────  ────  ───  ────────\n`;
    for (const l of lb) {
      const n = l.total_forecasts || 0;
      const k = l.correct_direction || 0;
      const pct = n > 0 ? ((k / n) * 100).toFixed(1) : '0.0';
      const pVal = n > 0 ? binomialPValue(k, n).toFixed(3) : '1.000';
      const avgErr = n > 0 ? (l.total_abs_error / n).toFixed(2) : '-';
      const gvPct = n > 0 && l.group_vote_correct != null ? ((l.group_vote_correct / n) * 100).toFixed(1) : '-';
      const highlight = memberId && l.member_id === memberId ? ' ← YOU' : '';
      b += `  ${l.member_id.toUpperCase().padEnd(9)}  ${(pct + '%').padEnd(5)}  ${pVal.padEnd(7)}  ${(avgErr + '%').padEnd(6)}  ${String(l.current_streak).padEnd(6)}  ${String(l.best_streak).padEnd(4)}  ${String(n).padEnd(3)}  ${(gvPct === '-' ? '-' : gvPct + '%').padEnd(8)}${highlight}\n`;
    }
    b += `\n`;
  }

  // Personal stats highlight
  if (memberId) {
    const myStats = lb.find(l => l.member_id === memberId);
    if (myStats && myStats.total_forecasts > 0) {
      const n = myStats.total_forecasts;
      const k = myStats.correct_direction;
      const pct = ((k / n) * 100).toFixed(1);
      const pVal = binomialPValue(k, n).toFixed(4);
      b += `🎯 YOUR STATS: ${pct}% accuracy (${k}/${n}), p=${pVal}, streak=${myStats.current_streak}\n\n`;
    }
  }

  // Previous round result
  if (rounds.length > 0) {
    const last = rounds[0];
    const chg = last.actual_change_pct != null ? `${last.actual_change_pct >= 0 ? '+' : ''}${parseFloat(last.actual_change_pct).toFixed(2)}%` : '?';
    b += `📋 LAST ROUND (#${last.round_number}): BTC went ${last.actual_direction} (${chg})\n`;
    b += `  Consensus: ${last.consensus_direction} → ${last.consensus_correct ? '✅ CORRECT' : '❌ WRONG'}\n`;
    if (last.group_vote_direction) {
      b += `  Group vote: ${last.group_vote_direction}\n`;
    }
    // Individual results
    const indiv = typeof last.individual_scores === 'string' ? JSON.parse(last.individual_scores) : (last.individual_scores || {});
    const forecasts = typeof last.individual_forecasts === 'string' ? JSON.parse(last.individual_forecasts) : (last.individual_forecasts || {});
    for (const [mid, score] of Object.entries(indiv)) {
      const pred = forecasts[mid]?.direction || '?';
      const correct = score.direction_correct ? '✅' : '❌';
      const err = score.price_error_pct != null ? ` err=${score.price_error_pct.toFixed(2)}%` : '';
      const highlight = memberId && mid === memberId ? ' ← YOU' : '';
      b += `    ${mid.toUpperCase()}: predicted ${pred} → ${correct}${err}${highlight}\n`;
    }
    b += `\n`;
  }

  // Recent history with individual predictions
  if (rounds.length > 1) {
    b += `📜 SCORED HISTORY (last ${rounds.length} rounds, with individual predictions):\n`;
    for (const r of rounds) {
      const chg = r.actual_change_pct != null ? `${r.actual_change_pct >= 0 ? '+' : ''}${parseFloat(r.actual_change_pct).toFixed(2)}%` : '';
      const price = r.btc_price_at_forecast ? `$${parseFloat(r.btc_price_at_forecast).toFixed(0)}` : '';
      const reviewPrice = r.btc_price_at_review ? `→$${parseFloat(r.btc_price_at_review).toFixed(0)}` : '';
      b += `\n  ── Round #${r.round_number} ${price}${reviewPrice} ${chg} — Actual: ${r.actual_direction} ──\n`;
      b += `  Consensus: ${r.consensus_direction} ${r.consensus_correct ? '✅' : '❌'}`;
      if (r.group_vote_direction) b += ` | Group vote: ${r.group_vote_direction}`;
      b += `\n`;

      // Show each member's prediction, target, confidence, and reasoning
      const indivF = typeof r.individual_forecasts === 'string' ? JSON.parse(r.individual_forecasts) : (r.individual_forecasts || {});
      const indivS = typeof r.individual_scores === 'string' ? JSON.parse(r.individual_scores) : (r.individual_scores || {});
      for (const [mid, fcast] of Object.entries(indivF)) {
        const score = indivS[mid] || {};
        const correct = score.direction_correct ? '✅' : '❌';
        const target = fcast.price_target ? `$${parseFloat(fcast.price_target).toFixed(0)}` : '';
        const errStr = score.price_error_pct != null ? ` err=${score.price_error_pct.toFixed(2)}%` : '';
        const conf = fcast.confidence || '?';
        const reasoning = (fcast.reasoning || '').slice(0, 120);
        const highlight = memberId && mid === memberId ? ' ← YOU' : '';
        b += `    ${mid.toUpperCase()}: ${fcast.direction} ${target} (${conf}) ${correct}${errStr}${highlight}\n`;
        if (reasoning) b += `      "${reasoning}"\n`;
      }
    }
    b += `\n`;
  }

  // Compressed history chain (older rounds beyond the detail window)
  const older = ctx.olderRounds || [];
  if (older.length > 0) {
    // Group into blocks of 10 and compress each block
    const blockSize = 10;
    const blocks = [];
    for (let i = 0; i < older.length; i += blockSize) {
      const chunk = older.slice(i, i + blockSize);
      const first = chunk[chunk.length - 1]; // oldest in block (rows are DESC)
      const last = chunk[0]; // newest in block
      const correct = chunk.filter(r => r.consensus_correct).length;
      const total = chunk.length;
      const ups = chunk.filter(r => r.actual_direction === 'UP').length;
      const gvCorrect = chunk.filter(r => r.group_vote_direction && r.group_vote_direction === r.actual_direction).length;
      const gvTotal = chunk.filter(r => r.group_vote_direction).length;
      const priceStart = first.btc_price_at_forecast ? parseFloat(first.btc_price_at_forecast).toFixed(0) : '?';
      const priceEnd = last.btc_price_at_review ? parseFloat(last.btc_price_at_review).toFixed(0) : '?';
      const roundRange = `#${first.round_number}-#${last.round_number}`;
      blocks.push(
        `  [${roundRange}] BTC $${priceStart}→$${priceEnd} | ${correct}/${total} consensus (${(correct/total*100).toFixed(0)}%)` +
        (gvTotal > 0 ? ` | grp ${gvCorrect}/${gvTotal} (${(gvCorrect/gvTotal*100).toFixed(0)}%)` : '') +
        ` | mkt ${ups}▲${total-ups}▼`
      );
    }

    // Rolling aggregate across all older rounds
    const allCorrect = older.filter(r => r.consensus_correct).length;
    const allGvCorrect = older.filter(r => r.group_vote_direction && r.group_vote_direction === r.actual_direction).length;
    const allGvTotal = older.filter(r => r.group_vote_direction).length;
    const allUps = older.filter(r => r.actual_direction === 'UP').length;
    const oldestPrice = older[older.length - 1]?.btc_price_at_forecast ? parseFloat(older[older.length - 1].btc_price_at_forecast).toFixed(0) : '?';
    const newestPrice = older[0]?.btc_price_at_review ? parseFloat(older[0].btc_price_at_review).toFixed(0) : '?';

    b += `⛓ COMPRESSED HISTORY (rounds before detail window — ${older.length} rounds total):\n`;
    b += `  ═══ AGGREGATE: ${allCorrect}/${older.length} consensus (${(allCorrect/older.length*100).toFixed(1)}%)`;
    if (allGvTotal > 0) b += ` | ${allGvCorrect}/${allGvTotal} grp vote (${(allGvCorrect/allGvTotal*100).toFixed(1)}%)`;
    b += ` | BTC $${oldestPrice}→$${newestPrice} | mkt ${allUps}▲${older.length-allUps}▼\n`;

    for (const block of blocks) {
      b += block + '\n';
    }
    b += `\n`;
  }

  return b;
}


// ═══════════════════════════════════════════════════════════════
// MEETING ENGINE — 7-Phase BTC Forecast Protocol
// ═══════════════════════════════════════════════════════════════

async function runBoardMeeting() {
  const meetingStart = Date.now();
  const client = await pool.connect();

  try {
    await ensureTables(client);

    // DEDUP GUARD
    if (!manualTrigger) {
      const { rows: recentMeetings } = await client.query(
        `SELECT id, round_number, phase, created_at FROM board_meetings
         WHERE created_at > now() - interval '30 minutes'
         ORDER BY created_at DESC LIMIT 1`
      );
      if (recentMeetings.length > 0) {
        const minutesAgo = (Date.now() - new Date(recentMeetings[0].created_at).getTime()) / 60000;
        console.log(`[board] ⏭ Skipping — meeting #${recentMeetings[0].round_number} ran ${minutesAgo.toFixed(0)}min ago`);
        return { skipped: true, reason: `Meeting #${recentMeetings[0].round_number} ran ${minutesAgo.toFixed(0)}min ago` };
      }
    } else {
      console.log(`[board] ⚡ Manual trigger — skipping dedup guard`);
    }

    // Build context
    let context;
    try {
      context = await buildMeetingContext(client);
    } catch (ctxErr) {
      console.error(`[board] ❌ Context build failed:`, ctxErr.message);
      return { error: `Context build failed: ${ctxErr.message}` };
    }

    const roundNumber = context.roundNumber;

    // Chair = best forecaster by avg price error (merit-based)
    let chair;
    try {
      const { rows: lb } = await client.query(
        `SELECT member_id FROM board_forecast_leaderboard
         WHERE total_forecasts >= 3
         ORDER BY CASE WHEN total_forecasts = 0 THEN 999999
                       ELSE total_abs_error / total_forecasts END ASC
         LIMIT 1`
      );
      if (lb.length > 0) {
        const winner = BOARD_MEMBERS.find(m => m.id === lb[0].member_id);
        if (winner) {
          chair = winner;
          console.log(`  🏆 Chair by forecast merit: ${chair.name}`);
        }
      }
    } catch {}
    if (!chair) {
      const chairIdx = (roundNumber - 1) % BOARD_MEMBERS.length;
      chair = BOARD_MEMBERS[chairIdx];
      console.log(`  Chair by rotation: ${chair.name}`);
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  BTC FORECAST MEETING #${roundNumber} — Chair: ${chair.name} (${chair.role})`);
    console.log(`  ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(70)}\n`);

    // Create meeting record
    let meetingId;
    try {
      const { rows: [meeting] } = await client.query(
        `INSERT INTO board_meetings (round_number, chair_id, phase, context)
         VALUES ($1, $2, 'started', $3) RETURNING id`,
        [roundNumber, chair.id, JSON.stringify({ briefingLength: 0, timestamp: context.timestamp })]
      );
      meetingId = meeting.id;
    } catch (insertErr) {
      console.error(`[board] ❌ Failed to create meeting row:`, insertErr.message);
      return { error: `Meeting insert failed: ${insertErr.message}` };
    }
    let totalTokens = 0;

    const memberSystem = (m) => `${GENESIS_DOCUMENT}\n\nYOUR ROLE: ${m.name} — ${m.role}\n${m.personality}\n\nYou are in Round #${roundNumber}. Respond with valid JSON only.`;

    // Get BTC current price
    const lastPrice = context.btcOhlc.length > 0 ? parseFloat(context.btcOhlc[context.btcOhlc.length - 1]?.close || 0) : 0;

    if (lastPrice <= 0 || context.btcOhlc.length < 3) {
      console.log(`  ❌ Insufficient BTC data (${context.btcOhlc.length} bars, price=${lastPrice}). Aborting.`);
      await client.query(`UPDATE board_meetings SET phase = 'failed', decision = 'Insufficient BTC data' WHERE id = $1`, [meetingId]);
      return { error: 'Insufficient BTC data' };
    }

    // ══════════════════════════════════════════════════════════
    // PHASE 0: Score Previous Round (DB only, no LLM calls)
    // ══════════════════════════════════════════════════════════
    console.log(`[Phase 0] Scoring previous round...\n`);
    let previousResult = null;

    if (context.previousForecast) {
      const pf = context.previousForecast;
      const currentPrice = lastPrice;
      if (currentPrice > 0 && pf.btc_price_at_forecast > 0) {
        const actualDirection = currentPrice > pf.btc_price_at_forecast ? 'UP' : 'DOWN';
        const changePct = ((currentPrice - pf.btc_price_at_forecast) / pf.btc_price_at_forecast * 100);
        const consensusCorrect = pf.consensus_direction === actualDirection;

        // Score group vote
        const groupVoteCorrect = pf.group_vote_direction ? pf.group_vote_direction === actualDirection : null;

        // Score individual LLMs
        const indivForecasts = typeof pf.individual_forecasts === 'string' ? JSON.parse(pf.individual_forecasts) : (pf.individual_forecasts || {});
        const individualScores = {};
        for (const [mid, fcast] of Object.entries(indivForecasts)) {
          const dirOK = fcast.direction === actualDirection;
          const pErr = fcast.price_target && currentPrice > 0 ? Math.abs(fcast.price_target - currentPrice) / currentPrice * 100 : null;
          individualScores[mid] = { direction_correct: dirOK, price_error_pct: pErr, predicted_target: fcast.price_target || null };
          console.log(`    ${mid.toUpperCase()}: ${fcast.direction}→${actualDirection} ${dirOK ? '✅' : '❌'}${pErr !== null ? ` err=${pErr.toFixed(2)}%` : ''}`);

          // Update leaderboard
          try {
            // Score group vote for this member
            const gvDetails = typeof pf.group_vote_details === 'string' ? JSON.parse(pf.group_vote_details) : (pf.group_vote_details || {});
            const memberGroupVote = gvDetails[mid]?.group_vote;
            const memberGvCorrect = memberGroupVote ? (memberGroupVote === actualDirection ? 1 : 0) : 0;

            await client.query(`
              INSERT INTO board_forecast_leaderboard (member_id, total_forecasts, correct_direction, total_abs_error, current_streak, best_streak, group_vote_correct)
              VALUES ($1, 1, $2, $3, $4, $4, $5)
              ON CONFLICT (member_id) DO UPDATE SET
                total_forecasts = board_forecast_leaderboard.total_forecasts + 1,
                correct_direction = board_forecast_leaderboard.correct_direction + $2,
                total_abs_error = board_forecast_leaderboard.total_abs_error + COALESCE($3, 0),
                current_streak = CASE WHEN $2 = 1 THEN board_forecast_leaderboard.current_streak + 1 ELSE 0 END,
                best_streak = GREATEST(board_forecast_leaderboard.best_streak, CASE WHEN $2 = 1 THEN board_forecast_leaderboard.current_streak + 1 ELSE board_forecast_leaderboard.best_streak END),
                group_vote_correct = board_forecast_leaderboard.group_vote_correct + $5,
                last_updated = now()
            `, [mid, dirOK ? 1 : 0, pErr, dirOK ? 1 : 0, memberGvCorrect]);
          } catch {}
        }

        // Update forecast record
        try {
          await client.query(
            `UPDATE board_btc_forecasts SET btc_price_at_review = $1, actual_direction = $2, actual_change_pct = $3, consensus_correct = $4, individual_scores = $5, reviewed_at = now() WHERE id = $6`,
            [currentPrice, actualDirection, changePct, consensusCorrect, JSON.stringify(individualScores), pf.id]
          );
          console.log(`  📊 Scored: ${pf.consensus_direction} → ${actualDirection} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%) — ${consensusCorrect ? '✅' : '❌'}`);
        } catch {}

        previousResult = { actualDirection, changePct, consensusCorrect, groupVoteCorrect, individualScores };

        // Refresh leaderboard in context after scoring
        try {
          const { rows } = await client.query(
            `SELECT * FROM board_forecast_leaderboard
             ORDER BY CASE WHEN total_forecasts = 0 THEN 0
                           ELSE correct_direction::float / total_forecasts END DESC`
          );
          context.forecastLeaderboard = rows;
        } catch {}
      }
    } else {
      console.log(`  No previous forecast to score\n`);
    }

    // ══════════════════════════════════════════════════════════
    // PHASE 1: Initial Analysis (5 parallel LLM calls)
    // ══════════════════════════════════════════════════════════
    console.log(`\n[Phase 1] All members analyse BTC...\n`);

    const phase1Promises = BOARD_MEMBERS.map(m => {
      const briefing = formatBriefing(context, m.id);
      return callLLM(m, memberSystem(m), `
${briefing}

PHASE 1 — INITIAL ANALYSIS. As ${m.name} (${m.role}), analyse BTC for the next 60 minutes.

Consider:
- Recent price action and candle structure
- Regime indicators (posInRange, volState, ATR, trend, persistence, Hurst)
- Your track record and past mistakes
- The base rate and statistical context

Give a SPECIFIC price target. Justify with data.

Respond as JSON:
{
  "analysis": "Your 3-5 sentence analysis citing specific numbers",
  "direction": "UP" or "DOWN",
  "price_target": <your predicted BTC price as a number>,
  "confidence": "LOW" or "MEDIUM" or "HIGH",
  "reasoning": "Key factors driving your call",
  "key_factors": ["factor1", "factor2", "factor3"]
}`, 500);
    });

    const phase1Responses = await Promise.all(phase1Promises);
    const phase1Analyses = {};
    for (let i = 0; i < BOARD_MEMBERS.length; i++) {
      totalTokens += phase1Responses[i].tokens;
      const parsed = parseJSON(phase1Responses[i].text) || { analysis: phase1Responses[i].text, direction: 'UP', confidence: 'LOW' };
      phase1Analyses[BOARD_MEMBERS[i].id] = {
        ...parsed,
        direction: (parsed.direction || '').toUpperCase() === 'DOWN' ? 'DOWN' : 'UP',
        price_target: parseFloat(parsed.price_target) || lastPrice,
      };
      console.log(`  ${BOARD_MEMBERS[i].name}: ${parsed.direction} $${(parseFloat(parsed.price_target) || lastPrice).toFixed(0)} (${parsed.confidence || 'LOW'}) — ${(parsed.reasoning || '').slice(0, 80)}`);
    }
    console.log();


    // ══════════════════════════════════════════════════════════
    // PHASE 2: Chair Summary (1 LLM call)
    // ══════════════════════════════════════════════════════════
    console.log(`[Phase 2] ${chair.name} summarises analyses...\n`);

    const analyseSummary = Object.entries(phase1Analyses).map(([id, a]) =>
      `${id.toUpperCase()} (${BOARD_MEMBERS.find(m => m.id === id)?.role}): ${a.direction} $${a.price_target?.toFixed(0) || '?'} (${a.confidence}) — ${a.reasoning || a.analysis || ''}`
    ).join('\n');

    // Reference leaderboard for credibility weighting
    const lbContext = context.forecastLeaderboard.map(l => {
      const n = l.total_forecasts || 0;
      const k = l.correct_direction || 0;
      const pct = n > 0 ? ((k / n) * 100).toFixed(1) : '0';
      const pVal = n > 0 ? binomialPValue(k, n).toFixed(3) : '1.000';
      return `${l.member_id.toUpperCase()}: ${pct}% (p=${pVal}, n=${n})`;
    }).join(', ');

    const chairSummaryResp = await callLLM(chair, memberSystem(chair), `
ALL PHASE 1 ANALYSES:
${analyseSummary}

LEADERBOARD CONTEXT: ${lbContext}

PHASE 2 — CHAIR SUMMARY. As chair, summarise:
1. Areas of agreement
2. Key disagreements
3. Notable arguments that deserve weight
4. Reference the leaderboard — who has earned credibility?

Keep it concise. Focus on substance, not process.

Respond as JSON:
{
  "summary": "Your 4-6 sentence summary",
  "agreements": ["what members agree on"],
  "disagreements": ["where they differ"],
  "strongest_argument": "Which member made the most compelling case and why"
}`, 500);
    totalTokens += chairSummaryResp.tokens;
    const chairSummary = parseJSON(chairSummaryResp.text) || { summary: chairSummaryResp.text };
    console.log(`  Summary: ${(chairSummary.summary || '').slice(0, 200)}\n`);


    // ══════════════════════════════════════════════════════════
    // PHASE 3: Deliberation (5 sequential LLM calls, random order)
    // ══════════════════════════════════════════════════════════
    console.log(`[Phase 3] Deliberation (sequential)...\n`);

    // Randomise speaking order
    const deliberationOrder = [...BOARD_MEMBERS].sort(() => Math.random() - 0.5);
    const deliberationComments = [];
    const processProposals = [];

    for (let i = 0; i < deliberationOrder.length; i++) {
      const m = deliberationOrder[i];
      const priorComments = deliberationComments.map(d =>
        `${d.member.toUpperCase()}: ${d.comment} ${d.revised ? `[REVISED: now ${d.revised_direction} $${d.revised_target}]` : '[NO REVISION]'} ${d.process_proposal ? `[PROCESS PROPOSAL: ${d.process_proposal}]` : ''}`
      ).join('\n');

      const resp = await callLLM(m, memberSystem(m), `
PHASE 1 ANALYSES:
${analyseSummary}

CHAIR SUMMARY:
${chairSummary.summary || chairSummaryResp.text}
Agreements: ${JSON.stringify(chairSummary.agreements || [])}
Disagreements: ${JSON.stringify(chairSummary.disagreements || [])}
Strongest argument: ${chairSummary.strongest_argument || 'not specified'}

${priorComments ? `DELIBERATION SO FAR:\n${priorComments}\n` : ''}
YOUR ORIGINAL ANALYSIS: ${phase1Analyses[m.id]?.analysis || ''}
YOUR ORIGINAL CALL: ${phase1Analyses[m.id]?.direction} $${phase1Analyses[m.id]?.price_target?.toFixed(0) || '?'}

PHASE 3 — DELIBERATION. You are speaker ${i + 1} of 5. You MUST:
1. Reference at least one colleague BY NAME and critically assess their argument
2. State whether you are revising your prediction (changing is a sign of intellectual honesty)
3. Optionally propose a process change (e.g. "increase bars from ${context.config.btc_bars} to 36")

Respond as JSON:
{
  "comment": "Your 3-5 sentence deliberation response",
  "referenced_colleague": "Name of colleague you're responding to",
  "revised_direction": "UP" or "DOWN" or null (null = no revision),
  "revised_target": <new price target or null>,
  "process_proposal": "Description of proposed change, or null"
}`, 400);
      totalTokens += resp.tokens;
      const parsed = parseJSON(resp.text) || { comment: resp.text };
      const revised = parsed.revised_direction && ['UP', 'DOWN'].includes(parsed.revised_direction.toUpperCase());

      deliberationComments.push({
        member: m.id,
        comment: parsed.comment || resp.text,
        referenced_colleague: parsed.referenced_colleague || null,
        revised: revised,
        revised_direction: revised ? parsed.revised_direction.toUpperCase() : null,
        revised_target: revised ? (parseFloat(parsed.revised_target) || lastPrice) : null,
        process_proposal: parsed.process_proposal || null,
      });

      if (parsed.process_proposal) {
        processProposals.push({ proposed_by: m.id, proposal: parsed.process_proposal });
      }

      const revisionNote = revised ? ` → REVISED to ${parsed.revised_direction.toUpperCase()}` : '';
      console.log(`  ${m.name} (${i + 1}/5): ${(parsed.comment || '').slice(0, 100)}${revisionNote}`);
    }
    console.log();


    // ══════════════════════════════════════════════════════════
    // PHASE 4: Final Vote + Individual Forecasts (5 parallel)
    // ══════════════════════════════════════════════════════════
    console.log(`[Phase 4] Final vote + individual predictions...\n`);

    const deliberationSummary = deliberationComments.map(d =>
      `${d.member.toUpperCase()}: ${d.comment}${d.revised ? ` [REVISED to ${d.revised_direction}]` : ''}`
    ).join('\n');

    const phase4Promises = BOARD_MEMBERS.map(m => {
      // Get this member's latest position (Phase 3 revision or Phase 1 original)
      const delib = deliberationComments.find(d => d.member === m.id);
      const currentDir = delib?.revised ? delib.revised_direction : phase1Analyses[m.id]?.direction;
      const currentTarget = delib?.revised ? delib.revised_target : phase1Analyses[m.id]?.price_target;

      return callLLM(m, memberSystem(m), `
DELIBERATION COMPLETE. Here's what happened:
${deliberationSummary}

YOUR CURRENT POSITION: ${currentDir} $${(currentTarget || lastPrice).toFixed(0)}

PHASE 4 — FINAL VOTE. Provide TWO predictions:

1. GROUP VOTE: What should the CONSENSUS call be? (This is your vote for the group)
2. INDIVIDUAL PREDICTION: Your own personal call (may differ from group vote)

The group consensus = majority of group votes.
Your individual prediction is scored separately on the leaderboard.

Respond as JSON:
{
  "group_vote": "UP" or "DOWN",
  "group_reasoning": "1 sentence why the group should call this",
  "individual_direction": "UP" or "DOWN",
  "individual_target": <your predicted BTC price>,
  "individual_confidence": "LOW" or "MEDIUM" or "HIGH",
  "individual_reasoning": "1-2 sentences for your personal call"
}`, 300);
    });

    const phase4Responses = await Promise.all(phase4Promises);
    const groupVotes = {};
    const individualForecasts = {};
    let groupUp = 0, groupDown = 0;
    let indivUp = 0, indivDown = 0;

    for (let i = 0; i < BOARD_MEMBERS.length; i++) {
      totalTokens += phase4Responses[i].tokens;
      const parsed = parseJSON(phase4Responses[i].text) || {};
      const mid = BOARD_MEMBERS[i].id;

      const gv = (parsed.group_vote || '').toUpperCase() === 'DOWN' ? 'DOWN' : 'UP';
      const iv = (parsed.individual_direction || gv).toUpperCase() === 'DOWN' ? 'DOWN' : 'UP';
      const it = parseFloat(parsed.individual_target) || lastPrice;

      groupVotes[mid] = { group_vote: gv, reasoning: parsed.group_reasoning || '' };
      individualForecasts[mid] = {
        direction: iv,
        price_target: it,
        confidence: parsed.individual_confidence || 'LOW',
        reasoning: parsed.individual_reasoning || '',
      };

      if (gv === 'UP') groupUp++; else groupDown++;
      if (iv === 'UP') indivUp++; else indivDown++;

      const diffMarker = gv !== iv ? ' ⚡SPLIT' : '';
      console.log(`  ${BOARD_MEMBERS[i].name}: group=${gv}, indiv=${iv} $${it.toFixed(0)} (${parsed.individual_confidence || 'LOW'})${diffMarker}`);
    }

    const groupVoteDirection = groupUp >= groupDown ? 'UP' : 'DOWN';
    const consensusDirection = indivUp >= indivDown ? 'UP' : 'DOWN';
    console.log(`\n  Group vote: ${groupVoteDirection} (${groupUp} UP / ${groupDown} DOWN)`);
    console.log(`  Individual consensus: ${consensusDirection} (${indivUp} UP / ${indivDown} DOWN)\n`);


    // ══════════════════════════════════════════════════════════
    // PHASE 5: Process Vote (conditional)
    // ══════════════════════════════════════════════════════════
    let processResults = [];
    if (processProposals.length > 0) {
      console.log(`[Phase 5] Process vote on ${processProposals.length} proposal(s)...\n`);

      for (const prop of processProposals) {
        const votePromises = BOARD_MEMBERS.map(m => callLLM(m, memberSystem(m), `
PROCESS CHANGE PROPOSED by ${prop.proposed_by.toUpperCase()}:
"${prop.proposal}"

Current config: bars=${context.config.btc_bars}, history_rounds=${context.config.history_rounds}

Vote YES or NO. 4/5 majority required to pass.

Respond as JSON:
{ "vote": "YES" or "NO", "reasoning": "1 sentence" }`, 100));

        const voteResponses = await Promise.all(votePromises);
        let yesCount = 0;
        const votes = {};
        for (let i = 0; i < BOARD_MEMBERS.length; i++) {
          totalTokens += voteResponses[i].tokens;
          const parsed = parseJSON(voteResponses[i].text) || {};
          const vote = (parsed.vote || '').toUpperCase() === 'YES';
          votes[BOARD_MEMBERS[i].id] = { vote: vote ? 'YES' : 'NO', reasoning: parsed.reasoning || '' };
          if (vote) yesCount++;
        }

        const passed = yesCount >= 4;
        console.log(`  "${prop.proposal}" — ${yesCount}/5 → ${passed ? '✅ PASSED' : '❌ FAILED'}`);

        // Apply if passed
        if (passed) {
          try {
            // Parse the proposal to extract config changes
            const propText = prop.proposal.toLowerCase();
            const barsMatch = propText.match(/(?:increase|decrease|change|set)\s+(?:btc_)?bars?\s+(?:from\s+\d+\s+)?to\s+(\d+)/i)
              || propText.match(/(\d+)\s+bars/i);
            const histMatch = propText.match(/(?:increase|decrease|change|set)\s+history\s+(?:rounds?\s+)?to\s+(\d+)/i)
              || propText.match(/(\d+)\s+(?:history|rounds)/i);

            if (barsMatch) {
              const newBars = Math.min(120, Math.max(6, parseInt(barsMatch[1])));
              await client.query(
                `UPDATE board_forecast_config SET value = $1::jsonb, updated_at = now(), updated_by_meeting = $2 WHERE key = 'btc_bars'`,
                [JSON.stringify(newBars), meetingId]
              );
              console.log(`    Applied: btc_bars → ${newBars}`);
            }
            if (histMatch) {
              const newHist = Math.min(50, Math.max(3, parseInt(histMatch[1])));
              await client.query(
                `UPDATE board_forecast_config SET value = $1::jsonb, updated_at = now(), updated_by_meeting = $2 WHERE key = 'history_rounds'`,
                [JSON.stringify(newHist), meetingId]
              );
              console.log(`    Applied: history_rounds → ${newHist}`);
            }
          } catch (err) {
            console.warn(`    ⚠ Failed to apply process change: ${err.message}`);
          }
        }

        processResults.push({ proposal: prop.proposal, proposed_by: prop.proposed_by, votes, yesCount, passed });
      }
      console.log();
    }


    // ══════════════════════════════════════════════════════════
    // PHASE 6: Hero Edit — Winner's Reward (1 LLM call)
    // ══════════════════════════════════════════════════════════
    console.log(`[Phase 6] Hero edit — winner's reward...\n`);

    // Find best forecaster by direction accuracy
    let heroAuthor = chair; // fallback to chair
    try {
      const { rows: lb } = await client.query(
        `SELECT member_id FROM board_forecast_leaderboard
         WHERE total_forecasts >= 3
         ORDER BY CASE WHEN total_forecasts = 0 THEN 0
                       ELSE correct_direction::float / total_forecasts END DESC
         LIMIT 1`
      );
      if (lb.length > 0) {
        const winner = BOARD_MEMBERS.find(m => m.id === lb[0].member_id);
        if (winner) heroAuthor = winner;
      }
    } catch {}

    console.log(`  Hero author: ${heroAuthor.name} (best forecaster)\n`);

    let heroEditData = null;
    try {
      const currentHero = context.heroContent;
      const heroPrompt = currentHero
        ? `Current hero (by ${currentHero.authored_by}): badge="${currentHero.badge_text}" headline="${currentHero.headline}" sub="${currentHero.subheadline}" body="${currentHero.body_text}" | 👍${currentHero.thumbs_up || 0} 👎${currentHero.thumbs_down || 0}`
        : `No hero set yet — you're first!`;

      const heroResp = await callLLM(heroAuthor, memberSystem(heroAuthor), `
🏆 REWARD: You are the BEST FORECASTER and get to edit the homepage hero section!

${heroPrompt}

BTC is at $${lastPrice.toFixed(0)}, forecast consensus: ${consensusDirection}

RULES:
- DO NOT include ANY numbers, percentages, or statistics
- Focus on NARRATIVE, TONE, and BRAND MESSAGING
- Be creative, concise, and compelling

Respond as JSON:
{
  "badge_text": "max 30 chars (e.g. 'LIVE — Signals Firing')",
  "headline": "max 40 chars",
  "subheadline": "max 60 chars",
  "body_text": "max 250 chars",
  "cta_left": "max 25 chars",
  "cta_right": "max 25 chars",
  "creative_rationale": "Why this angle"
}`, 400);
      totalTokens += heroResp.tokens;
      const heroParsed = parseJSON(heroResp.text);

      if (heroParsed && heroParsed.headline) {
        const stripNumbers = (s) => s.replace(/\d[\d,.]*%?/g, '').replace(/\s{2,}/g, ' ').trim();
        const h = {
          badge_text: stripNumbers(heroParsed.badge_text || 'LIVE — Signals firing now').slice(0, 30),
          headline: stripNumbers(heroParsed.headline || 'Recursive AI Alpha').slice(0, 40),
          subheadline: stripNumbers(heroParsed.subheadline || '').slice(0, 60),
          body_text: stripNumbers(heroParsed.body_text || '').slice(0, 250),
          cta_left: (heroParsed.cta_left || 'View Live Signals').slice(0, 25),
          cta_right: (heroParsed.cta_right || 'See the Evidence').slice(0, 25),
        };
        await client.query(`UPDATE board_hero_content SET active = false WHERE active = true`);
        await client.query(
          `INSERT INTO board_hero_content
           (meeting_id, authored_by, badge_text, headline, subheadline, body_text, cta_left, cta_right, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [meetingId, heroAuthor.id, h.badge_text, h.headline, h.subheadline, h.body_text, h.cta_left, h.cta_right]
        );
        heroEditData = h;
        console.log(`  ✅ Hero updated: "${h.headline}" / "${h.subheadline}"`);
      }
    } catch (err) {
      console.warn(`  ⚠ Hero edit failed: ${err.message}`);
    }


    // ══════════════════════════════════════════════════════════
    // PHASE 7: Save Everything (DB only)
    // ══════════════════════════════════════════════════════════
    console.log(`\n[Phase 7] Saving...\n`);
    const durationMs = Date.now() - meetingStart;

    // Save BTC forecast
    try {
      await client.query(`
        INSERT INTO board_btc_forecasts
          (meeting_id, round_number, btc_price_at_forecast, consensus_direction,
           individual_forecasts, regime_snapshot, group_vote_direction,
           group_vote_details, phase1_analyses, chair_summary,
           deliberation, process_proposals)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [meetingId, roundNumber, lastPrice, consensusDirection,
         JSON.stringify(individualForecasts),
         context.btcRegime ? JSON.stringify(context.btcRegime) : null,
         groupVoteDirection,
         JSON.stringify(groupVotes),
         JSON.stringify(phase1Analyses),
         chairSummary.summary || chairSummaryResp.text,
         JSON.stringify(deliberationComments),
         processProposals.length > 0 ? JSON.stringify(processResults) : null]
      );
    } catch (err) {
      console.warn(`  ⚠ Failed to save forecast: ${err.message}`);
    }

    // Generate digest
    const digest = [
      `BTC $${lastPrice.toFixed(0)}.`,
      `Group: ${groupVoteDirection} (${groupUp}-${groupDown}).`,
      `Indiv: ${consensusDirection} (${indivUp}-${indivDown}).`,
      previousResult ? `Prev: ${previousResult.consensusCorrect ? '✅' : '❌'} (${previousResult.actualDirection} ${previousResult.changePct >= 0 ? '+' : ''}${previousResult.changePct.toFixed(2)}%).` : '',
      processResults.filter(p => p.passed).length > 0 ? `Process changes: ${processResults.filter(p => p.passed).map(p => p.proposal).join('; ')}.` : '',
    ].filter(Boolean).join(' ').slice(0, 250);

    // Save meeting
    const decision = `Group: ${groupVoteDirection} (${groupUp}/${groupDown}) | Indiv: ${consensusDirection} (${indivUp}/${indivDown})`;
    await client.query(
      `UPDATE board_meetings
       SET phase = 'complete',
           decision = $1, deployed = false, duration_ms = $2, total_tokens = $3,
           proposals = $4, votes = $5, digest = $6
       WHERE id = $7`,
      [decision, durationMs, totalTokens,
       JSON.stringify({ phase1: phase1Analyses, chairSummary, deliberation: deliberationComments, processResults }),
       JSON.stringify(groupVotes),
       digest, meetingId]
    );

    console.log(`${'═'.repeat(70)}`);
    console.log(`  Meeting #${roundNumber} complete in ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tokens: ${totalTokens}`);
    console.log(`  Group vote: ${groupVoteDirection} | Individual consensus: ${consensusDirection}`);
    console.log(`  BTC: $${lastPrice.toFixed(0)}`);
    console.log(`${'═'.repeat(70)}\n`);

    return {
      roundNumber, chair: chair.name, decision, durationMs, totalTokens,
      groupVote: groupVoteDirection, consensus: consensusDirection, price: lastPrice,
      heroAuthor: heroAuthor.name, processChanges: processResults.filter(p => p.passed),
    };
  } catch (err) {
    console.error(`[board] ❌ Meeting failed:`, err.message, err.stack);
    return { error: err.message };
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// FILTER ENGINE (unchanged — live-signals depends on these)
// ═══════════════════════════════════════════════════════════════

export async function getActiveDirectives() {
  const client = await pool.connect();
  try {
    await ensureTables(client);
    const { rows: filters } = await client.query(`SELECT *, COALESCE(timeframe, 'all') as timeframe FROM board_filters WHERE active = true ORDER BY created_at`);
    const { rows: overrides } = await client.query(`SELECT * FROM board_coin_overrides WHERE active = true ORDER BY symbol`);
    return {
      filters,
      excludedCoins: overrides.filter(o => o.override_type === 'exclude').map(o => o.symbol),
      parameterOverrides: overrides.filter(o => o.override_type === 'parameters').reduce((a, o) => { a[o.symbol] = o.parameters; return a; }, {}),
    };
  } finally { client.release(); }
}

export function checkSignalAgainstFilters(signal, features, filters) {
  for (const filter of filters) {
    const conditions = filter.conditions;
    if (!conditions) continue;

    // Direction-aware rules
    if (conditions.rules) {
      for (const rule of conditions.rules) {
        if (rule.direction && signal.direction !== rule.direction) continue;
        const val = features[rule.feature || filter.feature];
        if (val === undefined) continue;
        if (rule.min !== undefined && val < rule.min) return { pass: false, blocked_by: `${filter.feature}: ${rule.label || ''} (${val})` };
        if (rule.max !== undefined && val > rule.max) return { pass: false, blocked_by: `${filter.feature}: ${rule.label || ''} (${val})` };
      }
    }

    // Simple threshold
    const featureValue = features[conditions.feature || filter.feature];
    if (featureValue === undefined) continue;
    if (conditions.min !== undefined && featureValue < conditions.min) return { pass: false, blocked_by: `${filter.feature} < ${conditions.min}` };
    if (conditions.max !== undefined && featureValue > conditions.max) return { pass: false, blocked_by: `${filter.feature} > ${conditions.max}` };
  }
  return { pass: true, blocked_by: null };
}

// Manual trigger — bypasses the 30-min dedup guard
export async function triggerMeeting() {
  console.log(`[board] ⚡ Manual meeting trigger — bypassing dedup guard`);
  manualTrigger = true;
  try {
    const result = await runBoardMeeting();
    return result;
  } finally {
    manualTrigger = false;
  }
}


// ═══════════════════════════════════════════════════════════════
// SCHEDULER — aligned to top of each hour, no overlapping meetings
// ═══════════════════════════════════════════════════════════════

const MEETING_INTERVAL = parseInt(process.env.BOARD_MEETING_INTERVAL_MS || String(60 * 60 * 1000));
let meetingInProgress = false;
let manualTrigger = false;

async function runScheduledMeeting() {
  if (meetingInProgress) {
    console.log(`[board] ⏳ Meeting already in progress, skipping this tick`);
    return;
  }
  meetingInProgress = true;
  try {
    console.log(`\n[board] Scheduled meeting starting...`);
    const result = await runBoardMeeting();
    console.log(`[board] Result:`, JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[board] Meeting error:`, err);
  } finally {
    meetingInProgress = false;
  }
}

function msUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(next.getHours() + 1, 0, 30, 0); // XX:00:30 — 30s past the hour for clean data
  return next.getTime() - now.getTime();
}

async function start() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  FRACMAP LLM STRATEGY BOARD v4 — BTC Forecast Challenge     ║`);
  console.log(`║  ${BOARD_MEMBERS.length} members · 7-phase protocol · ${MEETING_INTERVAL / 60000}min interval         ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  if (!OPENROUTER_KEY) {
    console.error(`[board] ❌ OPENROUTER_API_KEY not set in .env`);
    process.exit(1);
  }

  console.log(`  Models:`);
  for (const m of BOARD_MEMBERS) console.log(`    ${m.id.padEnd(10)} → ${m.model}`);

  const client = await pool.connect();
  try { await ensureTables(client); console.log(`[board] Database ready`); } finally { client.release(); }

  // Run first meeting immediately (10s delay for startup)
  const INITIAL_DELAY = parseInt(process.env.BOARD_INITIAL_DELAY_MS || String(10 * 1000));
  console.log(`[board] First meeting in ${INITIAL_DELAY / 1000}s...`);
  setTimeout(runScheduledMeeting, INITIAL_DELAY);

  // Then align to the top of each hour
  const waitMs = msUntilNextHour();
  console.log(`[board] Next hourly meeting in ${(waitMs / 60000).toFixed(1)}min (at top of hour)`);
  setTimeout(() => {
    // Run the first hourly meeting
    runScheduledMeeting();
    // Then repeat every hour
    setInterval(runScheduledMeeting, MEETING_INTERVAL);
  }, waitMs);

  // Poll for manual trigger file every 5 seconds
  const fs = await import('fs');
  const triggerFile = new URL('trigger-meeting.flag', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  console.log(`[board] Watching for manual trigger: ${triggerFile}\n`);
  setInterval(async () => {
    try {
      if (fs.existsSync(triggerFile)) {
        fs.unlinkSync(triggerFile);
        if (meetingInProgress) {
          console.log(`[board] ⚡ Manual trigger detected but meeting already in progress — ignoring`);
          return;
        }
        console.log(`[board] ⚡ Manual trigger detected — starting meeting now`);
        manualTrigger = true;
        meetingInProgress = true;
        try {
          const result = await runBoardMeeting();
          // Write result to a response file
          fs.writeFileSync(triggerFile + '.result', JSON.stringify(result));
          console.log(`[board] ⚡ Manual meeting complete`);
        } catch (err) {
          console.error(`[board] ⚡ Manual meeting error:`, err);
          fs.writeFileSync(triggerFile + '.result', JSON.stringify({ error: err.message }));
        } finally {
          manualTrigger = false;
          meetingInProgress = false;
        }
      }
    } catch {}
  }, 5000);
}

// Only auto-start when run directly, not when imported by trigger
const isDirectRun = process.argv[1] && !process.argv.includes('-e') && !process.argv.includes('--eval');
if (isDirectRun) {
  start().catch(err => { console.error('[board] Fatal:', err); process.exit(1); });
}
