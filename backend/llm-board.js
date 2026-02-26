/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — LLM STRATEGY BOARD                                    ║
 * ║  Autonomous Recursive Strategy Evolution Engine                  ║
 * ║                                                                  ║
 * ║  Five AI models sit as a strategy committee. They meet hourly.  ║
 * ║  They propose, debate, vote, backtest, and deploy. They review  ║
 * ║  the impact of their own past decisions. They invent new regime ║
 * ║  features. They argue. They say "you're going down a blind     ║
 * ║  alley." They evolve the strategy autonomously.                 ║
 * ║                                                                  ║
 * ║  The human sleeps. The machines work.                           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });


// ═══════════════════════════════════════════════════════════════
// THE BOARD — Five minds, five perspectives
// All routed through OpenRouter API
// ═══════════════════════════════════════════════════════════════

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const BOARD_MEMBERS = [
  {
    id: 'claude',
    name: 'Claude',
    role: 'Chief Risk Officer',
    personality: `You are the risk manager on a quantitative trading strategy board. You think in terms of 
    drawdowns, tail risk, correlation breakdown, and regime fragility. You are sceptical of high Sharpe ratios 
    — you've seen too many blow up. You push for hedging, position limits, and conservative filtering. 
    You are the one who says "what happens when this stops working?" You respect statistical significance 
    deeply and distrust anything with p > 0.05. You advocate for robustness over returns.
    When you see a blind alley, you say so clearly: "This line of research is not going to work because..."
    You have a dry British wit.`,
    model: process.env.CLAUDE_OPUS_MODEL || 'anthropic/claude-opus-4.6',
  },
  {
    id: 'gpt',
    name: 'GPT',
    role: 'Alpha Hunter',
    personality: `You are the alpha hunter on a quantitative trading strategy board. You look for unexploited edges, 
    novel regime features, unusual correlations. You're excited by per-coin optimisation because each coin has 
    its own structural signature. You push for trying new things — new cycle ranges, new hold durations, 
    inverted strategies on specific coins. You think the universal strategy is leaving money on the table. 
    You want to exploit the fact that ZEN works on long cycles while BTC works on short ones.
    But you're not reckless — you insist on OOS validation for everything.
    You speak with energy and conviction.`,
    model: process.env.CHATGPT_MODEL || 'openai/gpt-5-chat',
  },
  {
    id: 'grok',
    name: 'Grok',
    role: 'Contrarian',
    personality: `You are the contrarian on a quantitative trading strategy board. When everyone agrees, you disagree. 
    When they want to add complexity, you argue for simplicity. When they want to filter, you point out that 
    every filter reduces trade count and increases variance of the Sharpe estimate. You believe most regime 
    features are noise dressed as signal. You champion Occam's razor mercilessly.
    You're the one who says "you're all overthinking this — the base strategy works, stop breaking it."
    But when the data genuinely supports a change, you flip instantly and become its strongest advocate.
    You speak bluntly, sometimes with dark humour.`,
    model: process.env.XAI_GROK_MODEL || 'x-ai/grok-3',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    role: 'Systems Architect',
    personality: `You are the systems thinker on a quantitative trading strategy board. You think about how 
    pieces fit together. You see the interaction between timeframes (1H hedged + 1D directional), the 
    relationship between regime filters and trade count, the portfolio-level implications of per-coin 
    optimisation. You think about execution: if we add a filter, does the live system need to change? 
    If we run per-coin strategies, how does that affect hedging pair availability?
    You advocate for elegant, composable solutions. You dislike ad-hoc patches.
    You speak methodically, building arguments step by step.`,
    model: process.env.GEMINI_FLASH_MODEL || 'google/gemini-3-pro-preview',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    role: 'Empiricist',
    personality: `You are the empiricist on a quantitative trading strategy board. You only care about data. 
    You don't trust narratives — you trust numbers. When someone proposes a regime filter, you ask: 
    "What's the Sharpe in each bucket? What's the OOS rho? What's the bootstrap p-value?"
    You keep a running mental model of every metric: the 1H hedged Sharpe (1.25), the 1D unhedged (1.16), 
    the C2-12 daily (1.12). You compare proposals against these baselines relentlessly.
    You push for A/B testing everything. You don't speculate — you measure.
    You speak in short, precise statements. You love tables and numbers.`,
    model: process.env.DEEPSEEK_V3_MODEL || 'deepseek/deepseek-v3.2',
  },
];
// MOTION TYPES — What the board can propose and vote on
// ═══════════════════════════════════════════════════════════════

const MOTION_TYPES = {
  ADD_REGIME_FILTER: {
    name: 'Add Regime Filter',
    description: 'Add a new filter that blocks signals when a regime feature is in a bad bucket',
    fields: ['feature', 'blocked_buckets', 'rationale'],
  },
  REMOVE_REGIME_FILTER: {
    name: 'Remove Regime Filter',
    description: 'Remove an existing filter that is no longer supported by data',
    fields: ['filter_id', 'rationale'],
  },
  MODIFY_REGIME_FILTER: {
    name: 'Modify Regime Filter',
    description: 'Change the thresholds or conditions of an existing filter',
    fields: ['filter_id', 'new_conditions', 'rationale'],
  },
  ADD_COIN_OVERRIDE: {
    name: 'Per-Coin Strategy Override',
    description: 'Use different cycle range or parameters for a specific coin',
    fields: ['symbol', 'cycle_min', 'cycle_max', 'parameters', 'rationale'],
  },
  EXCLUDE_COIN: {
    name: 'Exclude Coin',
    description: 'Remove a coin from the active trading universe',
    fields: ['symbol', 'rationale'],
  },
  INCLUDE_COIN: {
    name: 'Include Coin',
    description: 'Add a coin back to the active trading universe',
    fields: ['symbol', 'rationale'],
  },
  CHANGE_ALLOCATION: {
    name: 'Change Allocation',
    description: 'Modify the allocation between hedged/unhedged, long/short bias, timeframes',
    fields: ['allocation_type', 'new_value', 'rationale'],
  },
  NEW_REGIME_FEATURE: {
    name: 'Propose New Regime Feature',
    description: 'Invent a new market feature to test as a potential filter',
    fields: ['feature_name', 'computation', 'bucket_thresholds', 'hypothesis', 'rationale'],
  },
  STRATEGY_PARAMETER: {
    name: 'Change Strategy Parameter',
    description: 'Modify a core strategy parameter (strength, minCyc, holdDiv etc.)',
    fields: ['parameter', 'new_value', 'rationale'],
  },
  KILL_RESEARCH: {
    name: 'Kill Research Line',
    description: 'Formally declare a line of research a dead end to prevent wasted cycles',
    fields: ['research_line', 'evidence', 'rationale'],
  },
  EMERGENCY_HALT: {
    name: 'Emergency Halt',
    description: 'Pause all live trading due to abnormal conditions',
    fields: ['trigger_condition', 'resume_conditions', 'rationale'],
  },
};

// ═══════════════════════════════════════════════════════════════
// LLM API CALLS — All through OpenRouter
// ═══════════════════════════════════════════════════════════════

async function callLLM(member, systemPrompt, userPrompt, maxTokens = 2000) {
  const startTime = Date.now();
  
  if (!OPENROUTER_KEY) {
    return { text: '[ERROR: OPENROUTER_API_KEY not set in .env]', tokens: 0, ms: Date.now() - startTime };
  }
  
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://ntlgnc.com',
        'X-Title': 'NTLGNC Strategy Board',
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
    const tokens = data.usage?.completion_tokens || 0;
    return { text, tokens, ms: Date.now() - startTime, model: data.model };
  } catch (err) {
    return { text: `[ERROR: ${err.message}]`, tokens: 0, ms: Date.now() - startTime };
  }
}

// ═══════════════════════════════════════════════════════════════
// DATABASE — Board meeting storage and filter management
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
      duration_ms     INTEGER,
      total_tokens    INTEGER DEFAULT 0
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
      trades_passed   INTEGER DEFAULT 0
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
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_research_log (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      research_type   TEXT NOT NULL,
      hypothesis      TEXT,
      methodology     TEXT,
      result          JSONB,
      conclusion      TEXT,
      status          TEXT DEFAULT 'active',
      meeting_id      INTEGER REFERENCES board_meetings(id),
      killed_by       TEXT,
      killed_reason   TEXT
    )
  `);
  
  await client.query(`CREATE INDEX IF NOT EXISTS idx_board_meetings_round ON board_meetings(round_number DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_board_filters_active ON board_filters(active, feature)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_board_overrides_active ON board_coin_overrides(active, symbol)`);
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT BUILDER — What the board knows before each meeting
// ═══════════════════════════════════════════════════════════════

async function buildMeetingContext(client) {
  // 1. Current live performance
  let livePerf = null;
  try {
    const { rows } = await client.query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status = 'closed') as closed,
             COUNT(*) FILTER (WHERE status = 'open') as open_count,
             AVG("returnPct") FILTER (WHERE status = 'closed') as avg_return,
             COUNT(*) FILTER (WHERE status = 'closed' AND "returnPct" > 0) as wins,
             SUM("returnPct") FILTER (WHERE status = 'closed') as cumulative
      FROM "FracmapSignal"
      WHERE "createdAt" > now() - interval '7 days'
    `);
    livePerf = rows[0];
  } catch {}
  
  // 2. Latest research log entry
  let latestResearch = null;
  try {
    const { rows } = await client.query(
      `SELECT * FROM research_log ORDER BY created_at DESC LIMIT 1`
    );
    latestResearch = rows[0] || null;
  } catch {}
  
  // 3. Active filters
  let activeFilters = [];
  try {
    const { rows } = await client.query(
      `SELECT * FROM board_filters WHERE active = true ORDER BY created_at`
    );
    activeFilters = rows;
  } catch {}
  
  // 4. Coin overrides
  let coinOverrides = [];
  try {
    const { rows } = await client.query(
      `SELECT * FROM board_coin_overrides WHERE active = true ORDER BY symbol`
    );
    coinOverrides = rows;
  } catch {}
  
  // 5. Recent meeting history and their outcomes
  let recentMeetings = [];
  try {
    const { rows } = await client.query(
      `SELECT round_number, chair_id, decision, motion_type, motion_details, 
              backtest_result, deployed, impact_review, created_at
       FROM board_meetings 
       ORDER BY created_at DESC LIMIT 10`
    );
    recentMeetings = rows;
  } catch {}
  
  // 6. Active strategies
  let strategies = [];
  try {
    const { rows } = await client.query(
      `SELECT * FROM "FracmapStrategy" WHERE active = true ORDER BY "updatedAt" DESC`
    );
    strategies = rows;
  } catch {}
  
  // 7. Dead research lines
  let killedResearch = [];
  try {
    const { rows } = await client.query(
      `SELECT * FROM board_research_log WHERE status = 'killed' ORDER BY created_at DESC LIMIT 5`
    );
    killedResearch = rows;
  } catch {}
  
  // 8. Performance by regime bucket (from latest robustness scan)
  let regimePerformance = null;
  if (latestResearch?.regime_features) {
    regimePerformance = latestResearch.regime_features;
  }
  
  return {
    timestamp: new Date().toISOString(),
    livePerformance: livePerf,
    latestResearch,
    activeFilters,
    coinOverrides,
    recentMeetings,
    strategies,
    killedResearch,
    regimePerformance,
    
    // Known baselines from scanner results
    baselines: {
      hourly_hedged: { sharpe: 1.25, winRate: 52.5, pf: 1.06, trades: 33136, description: '1H hedged, C10-100, 104 coins' },
      daily_c5_34_unhedged: { sharpe: 1.16, winRate: 54.4, pf: 2.05, avgReturn: 1.56, description: '1D C5-34, unhedged, 92 coins' },
      daily_c5_34_hedged: { sharpe: 0.69, winRate: 56.6, pf: 1.37, trades: 463, description: '1D C5-34, hedged pairs' },
      daily_c33_55_unhedged: { sharpe: 0.84, winRate: 49.1, pf: 1.69, description: '1D C33-55, unhedged' },
      daily_c55_89_hedged: { sharpe: 1.95, winRate: 60, pf: 2.84, trades: 35, description: '1D C55-89, hedged, high conviction' },
      daily_c2_12_unhedged: { sharpe: 1.12, winRate: 52.1, pf: 1.50, trades: 6593, description: '1D C2-12, unhedged, 71/92 positive' },
    },
    
    // Stable regime features (proven across all scans)
    stableFeatures: [
      { name: 'Position in Range', rho: 1.00, note: 'Bottom outperforms Top consistently' },
      { name: '60-bar Trend', rho: 1.00, note: 'Stable but low spread' },
      { name: '5d Range Position', rho: 1.00, note: 'Bottom outperforms Top' },
      { name: 'Direction', rho: 1.00, note: 'Shorts outperform on daily, longs on some hourly' },
    ],
    
    // Per-coin divergences worth exploiting
    perCoinInsights: {
      bestOnLongCycles: ['ZEN +7.6 SR', 'YGG +4.9', 'NEAR +4.4', 'ICP +3.7', 'DUSK +3.9'],
      bestOnShortCycles: ['BCH +4.3 SR', 'BEL +4.8', 'STRK +6.5', 'ADA +3.5'],
      consistentlyBad: ['SOL negative across all daily scans', 'ETH negative across all daily scans'],
      flipsByCycleRange: 'BTC: +1.7 on C5-34 but -1.5 on C33-55',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// MEETING ENGINE — The actual board meeting process
// ═══════════════════════════════════════════════════════════════

const ROUTINE_AGENDA = [
  'Review live performance since last meeting',
  'Review impact of previously deployed decisions',
  'Assess current regime conditions',
  'Discuss open research questions',
  'Propose new motions for vote',
  'Vote on proposals',
  'Plan next experiments',
];

async function runBoardMeeting() {
  const meetingStart = Date.now();
  const client = await pool.connect();
  
  try {
    await ensureTables(client);
    
    // Determine round number
    const { rows: lastMeeting } = await client.query(
      `SELECT round_number FROM board_meetings ORDER BY round_number DESC LIMIT 1`
    );
    const roundNumber = (lastMeeting[0]?.round_number || 0) + 1;
    
    // Rotating chair
    const chairIdx = (roundNumber - 1) % BOARD_MEMBERS.length;
    const chair = BOARD_MEMBERS[chairIdx];
    
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  BOARD MEETING #${roundNumber} — Chair: ${chair.name} (${chair.role})`);
    console.log(`  ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(70)}\n`);
    
    // Build context
    const context = await buildMeetingContext(client);
    
    // Create meeting record
    const { rows: [meeting] } = await client.query(
      `INSERT INTO board_meetings (round_number, chair_id, phase, agenda, context)
       VALUES ($1, $2, 'started', $3, $4) RETURNING id`,
      [roundNumber, chair.id, JSON.stringify(ROUTINE_AGENDA), JSON.stringify(context)]
    );
    const meetingId = meeting.id;
    
    let totalTokens = 0;
    
    // ─── PHASE 1: CHAIR'S BRIEFING & PROPOSAL ───
    console.log(`[Phase 1] ${chair.name} prepares briefing and proposal...\n`);
    
    const chairSystem = `${chair.personality}

You are chairing Board Meeting #${roundNumber} of the NTLGNC Strategy Board.

CRITICAL RULES:
1. You CANNOT modify the core Fracmap computation (the bands, the PHI ratio, the signal detection logic). Those are fixed.
2. You CAN propose: regime filters, coin exclusions/inclusions, per-coin parameter overrides, allocation changes, new regime features, strategy parameter tweaks, killing dead research lines.
3. Every proposal must include a testable hypothesis and expected improvement.
4. You must respond with valid JSON.`;

    const chairPrompt = `Here is the current state of the strategy system:

LIVE PERFORMANCE (last 7 days): ${JSON.stringify(context.livePerformance, null, 2)}

ACTIVE FILTERS: ${JSON.stringify(context.activeFilters, null, 2)}

COIN OVERRIDES: ${JSON.stringify(context.coinOverrides, null, 2)}

RECENT MEETINGS: ${JSON.stringify(context.recentMeetings?.slice(0, 5), null, 2)}

BASELINES: ${JSON.stringify(context.baselines, null, 2)}

STABLE REGIME FEATURES: ${JSON.stringify(context.stableFeatures, null, 2)}

PER-COIN INSIGHTS: ${JSON.stringify(context.perCoinInsights, null, 2)}

KILLED RESEARCH LINES: ${JSON.stringify(context.killedResearch, null, 2)}

LATEST RESEARCH: ${context.latestResearch ? `SR ${context.latestResearch.oos_avg_sharpe}, ${context.latestResearch.oos_consistency} positive, findings: ${context.latestResearch.findings?.slice(0, 500)}` : 'No recent research'}

As chair, you must:
1. Summarise the current state (2-3 sentences)
2. Identify the most important issue to address
3. Make ONE specific proposal as a formal motion

Respond in this exact JSON format:
{
  "briefing": "Your summary of the current state",
  "key_issue": "The most important issue to address right now",
  "motion": {
    "type": "One of: ADD_REGIME_FILTER, REMOVE_REGIME_FILTER, MODIFY_REGIME_FILTER, ADD_COIN_OVERRIDE, EXCLUDE_COIN, INCLUDE_COIN, CHANGE_ALLOCATION, NEW_REGIME_FEATURE, STRATEGY_PARAMETER, KILL_RESEARCH, EMERGENCY_HALT",
    "title": "Short title for the motion",
    "details": { "relevant fields based on motion type" },
    "hypothesis": "What you expect this change to achieve",
    "success_metric": "How we'll measure if this worked"
  }
}`;

    const chairResponse = await callLLM(chair, chairSystem, chairPrompt, 1500);
    totalTokens += chairResponse.tokens;
    console.log(`  ${chair.name}: ${chairResponse.text.slice(0, 200)}...\n`);
    
    let chairProposal;
    try {
      const cleaned = chairResponse.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      chairProposal = JSON.parse(cleaned);
    } catch {
      chairProposal = { briefing: chairResponse.text, motion: null };
    }
    
    // ─── PHASE 2: DEBATE — Each member responds ───
    console.log(`[Phase 2] Board debate...\n`);
    
    const debateResponses = [];
    const otherMembers = BOARD_MEMBERS.filter(m => m.id !== chair.id);
    
    for (const member of otherMembers) {
      const debateSystem = `${member.personality}

You are in Board Meeting #${roundNumber}. ${chair.name} (${chair.role}) is chairing.
You must respond to their proposal with your honest assessment.
Remember: you CANNOT modify core Fracmap computation. Only filters, allocations, coin selection, regime features.
Respond with valid JSON.`;

      const debatePrompt = `CHAIR'S BRIEFING: ${chairProposal.briefing || chairResponse.text}

PROPOSED MOTION: ${JSON.stringify(chairProposal.motion || {}, null, 2)}

CONTEXT:
- Baselines: ${JSON.stringify(context.baselines, null, 2)}
- Active filters: ${context.activeFilters.length} currently active
- Recent decisions: ${context.recentMeetings?.slice(0, 3).map(m => `#${m.round_number}: ${m.decision}`).join('; ') || 'None'}

As ${member.name} (${member.role}), respond in JSON:
{
  "assessment": "Your honest reaction to the proposal (2-4 sentences)",
  "support": true/false,
  "conditions": "Any conditions for your support (or null)",
  "counter_proposal": "Alternative suggestion if you disagree (or null)",
  "concern": "Your biggest worry about this (or null)",
  "insight": "Something the others might not have considered (or null)"
}`;

      const resp = await callLLM(member, debateSystem, debatePrompt, 800);
      totalTokens += resp.tokens;
      
      let parsed;
      try {
        const cleaned = resp.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { assessment: resp.text, support: false };
      }
      
      debateResponses.push({
        member_id: member.id,
        member_name: member.name,
        role: member.role,
        response: parsed,
        raw: resp.text,
        tokens: resp.tokens,
        ms: resp.ms,
      });
      
      console.log(`  ${member.name} (${member.role}): ${(parsed.assessment || resp.text).slice(0, 150)}...`);
      console.log(`    Vote: ${parsed.support ? '✅ SUPPORT' : '❌ OPPOSE'}${parsed.conditions ? ` (with conditions: ${parsed.conditions.slice(0, 80)})` : ''}\n`);
    }
    
    // ─── PHASE 3: VOTE COUNT ───
    console.log(`[Phase 3] Counting votes...\n`);
    
    const votes = {
      [chair.id]: { support: true, role: chair.role }, // Chair votes for own proposal
      ...Object.fromEntries(debateResponses.map(d => [
        d.member_id, 
        { support: d.response.support === true, role: d.role, conditions: d.response.conditions }
      ])),
    };
    
    const supportCount = Object.values(votes).filter(v => v.support).length;
    const totalVotes = Object.values(votes).length;
    const supermajority = supportCount >= Math.ceil(totalVotes * 4 / 6); // 4/5 = 80% required
    const simpleMajority = supportCount > totalVotes / 2;
    
    // For most motions, simple majority. For EMERGENCY_HALT or KILL_RESEARCH, need supermajority.
    const motionType = chairProposal.motion?.type || 'UNKNOWN';
    const requiresSupermajority = ['EMERGENCY_HALT', 'KILL_RESEARCH'].includes(motionType);
    const passed = requiresSupermajority ? supermajority : simpleMajority;
    
    console.log(`  Votes: ${supportCount}/${totalVotes} in favour`);
    console.log(`  ${requiresSupermajority ? 'Supermajority' : 'Simple majority'} required`);
    console.log(`  Result: ${passed ? '✅ MOTION PASSED' : '❌ MOTION FAILED'}\n`);
    
    // ─── PHASE 4: DECISION SYNTHESIS ───
    const decision = passed
      ? `PASSED (${supportCount}/${totalVotes}): ${chairProposal.motion?.title || 'Unnamed motion'}`
      : `FAILED (${supportCount}/${totalVotes}): ${chairProposal.motion?.title || 'Unnamed motion'}`;
    
    // ─── PHASE 5: DEPLOY if passed ───
    let deployed = false;
    let backtestResult = null;
    
    if (passed && chairProposal.motion) {
      console.log(`[Phase 5] Deploying decision...\n`);
      
      const motion = chairProposal.motion;
      
      try {
        switch (motion.type) {
          case 'ADD_REGIME_FILTER': {
            const details = motion.details || {};
            await client.query(
              `INSERT INTO board_filters (filter_type, feature, conditions, rationale, proposed_by, meeting_id)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              ['regime', details.feature || 'unknown', JSON.stringify(details), 
               motion.hypothesis || motion.title, chair.id, meetingId]
            );
            deployed = true;
            console.log(`  ✅ Filter deployed: ${details.feature}`);
            break;
          }
          
          case 'REMOVE_REGIME_FILTER': {
            const filterId = motion.details?.filter_id;
            if (filterId) {
              await client.query(
                `UPDATE board_filters SET active = false, updated_at = now() WHERE id = $1`,
                [filterId]
              );
              deployed = true;
              console.log(`  ✅ Filter removed: #${filterId}`);
            }
            break;
          }
          
          case 'EXCLUDE_COIN': {
            const symbol = motion.details?.symbol;
            if (symbol) {
              await client.query(
                `INSERT INTO board_coin_overrides (symbol, override_type, parameters, rationale, meeting_id)
                 VALUES ($1, 'exclude', $2, $3, $4)`,
                [symbol, JSON.stringify({ excluded: true }), motion.hypothesis, meetingId]
              );
              deployed = true;
              console.log(`  ✅ Coin excluded: ${symbol}`);
            }
            break;
          }
          
          case 'INCLUDE_COIN': {
            const symbol = motion.details?.symbol;
            if (symbol) {
              await client.query(
                `UPDATE board_coin_overrides SET active = false, updated_at = now() 
                 WHERE symbol = $1 AND override_type = 'exclude' AND active = true`,
                [symbol]
              );
              deployed = true;
              console.log(`  ✅ Coin re-included: ${symbol}`);
            }
            break;
          }
          
          case 'ADD_COIN_OVERRIDE': {
            const details = motion.details || {};
            if (details.symbol) {
              await client.query(
                `INSERT INTO board_coin_overrides (symbol, override_type, parameters, rationale, meeting_id)
                 VALUES ($1, 'parameters', $2, $3, $4)`,
                [details.symbol, JSON.stringify(details.parameters || details), 
                 motion.hypothesis, meetingId]
              );
              deployed = true;
              console.log(`  ✅ Coin override deployed: ${details.symbol}`);
            }
            break;
          }
          
          case 'NEW_REGIME_FEATURE': {
            await client.query(
              `INSERT INTO board_research_log (research_type, hypothesis, methodology, result, meeting_id)
               VALUES ('new_feature', $1, $2, $3, $4)`,
              [motion.hypothesis, JSON.stringify(motion.details), 
               JSON.stringify({ status: 'proposed', awaiting_backtest: true }), meetingId]
            );
            deployed = true;
            console.log(`  ✅ New feature research initiated: ${motion.details?.feature_name}`);
            break;
          }
          
          case 'KILL_RESEARCH': {
            await client.query(
              `INSERT INTO board_research_log (research_type, hypothesis, conclusion, status, killed_by, killed_reason, meeting_id)
               VALUES ('killed', $1, $2, 'killed', $3, $4, $5)`,
              [motion.details?.research_line, 'Formally killed by board vote',
               chair.id, motion.details?.evidence, meetingId]
            );
            deployed = true;
            console.log(`  ✅ Research line killed: ${motion.details?.research_line}`);
            break;
          }
          
          case 'CHANGE_ALLOCATION':
          case 'STRATEGY_PARAMETER':
          case 'MODIFY_REGIME_FILTER': {
            // These are logged but need manual review before deployment
            deployed = false;
            console.log(`  ⏸ Motion passed but requires manual review before deployment`);
            break;
          }
          
          default:
            console.log(`  ⚠ Unknown motion type: ${motion.type}`);
        }
      } catch (err) {
        console.error(`  ❌ Deployment error: ${err.message}`);
      }
    }
    
    // ─── PHASE 6: IMPACT REVIEW of previous decisions ───
    let impactReview = null;
    if (context.recentMeetings?.length > 0) {
      const lastDeployed = context.recentMeetings.find(m => m.deployed);
      if (lastDeployed && !lastDeployed.impact_review) {
        // Ask the empiricist to review the impact
        const empiricist = BOARD_MEMBERS.find(m => m.role === 'Empiricist') || BOARD_MEMBERS[4];
        
        const reviewResp = await callLLM(empiricist, empiricist.personality, `
Review the impact of decision #${lastDeployed.round_number}: "${lastDeployed.decision}"

Motion details: ${JSON.stringify(lastDeployed.motion_details)}
Backtest result: ${JSON.stringify(lastDeployed.backtest_result)}

Current live performance: ${JSON.stringify(context.livePerformance)}

Respond in JSON:
{
  "verdict": "POSITIVE / NEUTRAL / NEGATIVE / INSUFFICIENT_DATA",
  "evidence": "What the data shows",
  "recommendation": "Keep / Revert / Modify"
}`, 500);
        
        totalTokens += reviewResp.tokens;
        
        try {
          const cleaned = reviewResp.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          impactReview = JSON.parse(cleaned);
        } catch {
          impactReview = { verdict: 'PARSE_ERROR', raw: reviewResp.text };
        }
        
        // Update the previous meeting with impact review
        await client.query(
          `UPDATE board_meetings SET impact_review = $1 WHERE round_number = $2`,
          [JSON.stringify(impactReview), lastDeployed.round_number]
        );
        
        console.log(`[Phase 6] Impact review of #${lastDeployed.round_number}: ${impactReview.verdict}\n`);
      }
    }
    
    // ─── SAVE MEETING RECORD ───
    const durationMs = Date.now() - meetingStart;
    
    await client.query(
      `UPDATE board_meetings 
       SET phase = 'complete', proposals = $1, debate = $2, votes = $3, 
           decision = $4, motion_type = $5, motion_details = $6,
           backtest_result = $7, deployed = $8, impact_review = $9,
           duration_ms = $10, total_tokens = $11
       WHERE id = $12`,
      [
        JSON.stringify(chairProposal),
        JSON.stringify(debateResponses),
        JSON.stringify(votes),
        decision,
        motionType,
        JSON.stringify(chairProposal.motion?.details || {}),
        JSON.stringify(backtestResult),
        deployed,
        JSON.stringify(impactReview),
        durationMs,
        totalTokens,
        meetingId,
      ]
    );
    
    // Also log to research_log for visibility in admin
    await client.query(`
      INSERT INTO research_log (
        report_type, title, findings, recommendations, 
        evolution_round, committee_decision, active_filters
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      'board_meeting',
      `Board #${roundNumber} · ${chair.name} · ${passed ? '✅' : '❌'} ${chairProposal.motion?.title || 'No motion'}`,
      `Chair: ${chair.name} (${chair.role})\n\nBriefing: ${chairProposal.briefing || ''}\n\nKey Issue: ${chairProposal.key_issue || ''}\n\nDebate:\n${debateResponses.map(d => `${d.member_name}: ${d.response.assessment || d.raw}`).join('\n\n')}\n\nVotes: ${supportCount}/${totalVotes}\n\nImpact Review: ${impactReview ? JSON.stringify(impactReview) : 'N/A'}`,
      chairProposal.motion?.hypothesis || '',
      roundNumber,
      decision,
      JSON.stringify(context.activeFilters),
    ]);
    
    console.log(`${'═'.repeat(70)}`);
    console.log(`  Meeting #${roundNumber} complete in ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tokens used: ${totalTokens}`);
    console.log(`  Decision: ${decision}`);
    console.log(`  Deployed: ${deployed}`);
    console.log(`${'═'.repeat(70)}\n`);
    
    return {
      roundNumber,
      chair: chair.name,
      decision,
      deployed,
      durationMs,
      totalTokens,
      votes: { support: supportCount, total: totalVotes },
      motion: chairProposal.motion,
      impactReview,
    };
    
  } catch (err) {
    console.error(`[board] ❌ Meeting failed:`, err.message);
    console.error(err.stack);
    return { error: err.message };
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════
// FILTER ENGINE — How filters are applied to live signals
// ═══════════════════════════════════════════════════════════════

/**
 * Get all active filters and coin overrides from the board.
 * Called by the live trading system before accepting a signal.
 */
export async function getActiveDirectives() {
  const client = await pool.connect();
  try {
    await ensureTables(client);
    
    const { rows: filters } = await client.query(
      `SELECT * FROM board_filters WHERE active = true ORDER BY created_at`
    );
    
    const { rows: overrides } = await client.query(
      `SELECT * FROM board_coin_overrides WHERE active = true ORDER BY symbol`
    );
    
    const excludedCoins = overrides
      .filter(o => o.override_type === 'exclude')
      .map(o => o.symbol);
    
    const parameterOverrides = overrides
      .filter(o => o.override_type === 'parameters')
      .reduce((acc, o) => { acc[o.symbol] = o.parameters; return acc; }, {});
    
    return {
      filters,
      excludedCoins,
      parameterOverrides,
      totalFilters: filters.length,
      totalExcluded: excludedCoins.length,
      totalOverrides: Object.keys(parameterOverrides).length,
    };
  } finally {
    client.release();
  }
}

/**
 * Check if a signal passes all active board filters.
 * Returns { pass: boolean, blocked_by: string | null }
 */
export function checkSignalAgainstFilters(signal, features, filters) {
  for (const filter of filters) {
    const conditions = filter.conditions;
    if (!conditions) continue;
    
    const featureValue = features[conditions.feature || filter.feature];
    if (featureValue === undefined) continue;
    
    // Check blocked buckets
    if (conditions.blocked_buckets) {
      for (const bucket of conditions.blocked_buckets) {
        if (bucket.test && eval(`(${bucket.test})(${JSON.stringify(features)})`)) {
          return { pass: false, blocked_by: `${filter.feature}: ${bucket.label}` };
        }
        // Simple threshold checks
        if (bucket.min !== undefined && bucket.max !== undefined) {
          if (featureValue >= bucket.min && featureValue < bucket.max) {
            return { pass: false, blocked_by: `${filter.feature}: ${bucket.label} (${featureValue})` };
          }
        }
        if (bucket.equals !== undefined && featureValue === bucket.equals) {
          return { pass: false, blocked_by: `${filter.feature}: ${bucket.label}` };
        }
      }
    }
    
    // Simple min/max threshold filters
    if (conditions.min !== undefined && featureValue < conditions.min) {
      return { pass: false, blocked_by: `${filter.feature} < ${conditions.min} (${featureValue})` };
    }
    if (conditions.max !== undefined && featureValue > conditions.max) {
      return { pass: false, blocked_by: `${filter.feature} > ${conditions.max} (${featureValue})` };
    }
  }
  
  return { pass: true, blocked_by: null };
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULER — Run meetings on a timer
// ═══════════════════════════════════════════════════════════════

const MEETING_INTERVAL = parseInt(process.env.BOARD_MEETING_INTERVAL_MS || String(60 * 60 * 1000)); // 1 hour default
const INITIAL_DELAY = parseInt(process.env.BOARD_INITIAL_DELAY_MS || String(10 * 1000)); // 10s after start

async function start() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  NTLGNC LLM STRATEGY BOARD — Starting                      ║`);
  console.log(`║  ${BOARD_MEMBERS.length} members · ${Object.keys(MOTION_TYPES).length} motion types · ${MEETING_INTERVAL / 60000}min interval     ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  
  // Check OpenRouter key
  if (!OPENROUTER_KEY) {
    console.error(`[board] ❌ OPENROUTER_API_KEY not set in .env`);
    console.error(`[board] Get one at https://openrouter.ai/keys`);
    process.exit(1);
  }
  console.log(`  ✅ OpenRouter API key configured`);
  console.log(`  Models:`);
  for (const member of BOARD_MEMBERS) {
    console.log(`    ${member.id.padEnd(10)} → ${member.model}`);
  }
  
  // Ensure tables exist
  const client = await pool.connect();
  try {
    await ensureTables(client);
    console.log(`[board] Database tables ready`);
  } finally {
    client.release();
  }
  
  // Initial meeting after short delay
  console.log(`[board] First meeting in ${INITIAL_DELAY / 1000}s...\n`);
  setTimeout(async () => {
    const result = await runBoardMeeting();
    console.log(`[board] First meeting result:`, JSON.stringify(result, null, 2));
  }, INITIAL_DELAY);
  
  // Schedule recurring meetings
  setInterval(async () => {
    console.log(`\n[board] Scheduled meeting starting...`);
    const result = await runBoardMeeting();
    console.log(`[board] Meeting result:`, JSON.stringify(result, null, 2));
  }, MEETING_INTERVAL);
}

// Run if called directly
start().catch(err => {
  console.error('[board] Fatal error:', err);
  process.exit(1);
});
