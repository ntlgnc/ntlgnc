/**
 * research-cron.js — Autonomous Inter-Meeting LLM Research Engine
 * 
 * Runs every 5 minutes between board meetings.
 * Picks up queued research tasks, builds data context from the database,
 * calls the assigned LLM via OpenRouter, and stores structured results.
 * 
 * Research findings appear in the next board meeting's briefing
 * as pre-built motions ready for voting.
 * 
 * Modelled on evolution-cron.js pattern.
 */

const { Client } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

try { dotenv.config({ path: path.resolve(__dirname, '.env') }); } catch {}
try { dotenv.config(); } catch {}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// LLM model mapping (same as board)
const LLM_MODELS = {
  claude: 'anthropic/claude-sonnet-4',
  gpt: 'openai/gpt-4o',
  grok: 'x-ai/grok-3-mini-beta',
  gemini: 'google/gemini-2.5-flash-preview',
  deepseek: 'deepseek/deepseek-chat-v3-0324'
};

const RESEARCH_SYSTEM_PROMPT = `You are a quantitative research analyst for a cryptocurrency trading system.
You have been given raw data from the system's database and a specific research question.
Your job is to analyse the data rigorously and produce actionable findings.

PRINCIPLES:
- Negative returns under specific regime conditions indicate EXPLOITABLE STRUCTURE, not exclusion candidates.
- Always consider directional asymmetry: do LONG and SHORT signals behave differently under this regime?
- A feature with rho >= 0.8 (Spearman rank correlation between in-sample and out-of-sample bucket ordering) is reliable.
- OOS Sharpe > 0.5 with 50+ trades is interesting. OOS Sharpe > 1.0 with 100+ trades is strong. OOS Sharpe > 2.0 is exceptional.
- When proposing filters: always specify feature, conditions, timeframe, and expected impact.
- When proposing deployments: always specify symbol, timeframe, and cite specific evidence (Sharpe, rho, trade count).

Respond ONLY in JSON format. No preamble, no markdown fences.`;

async function callLLM(modelId, systemPrompt, userPrompt, maxTokens = 2000) {
  const model = LLM_MODELS[modelId] || LLM_MODELS.claude;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ntlgnc.com',
        'X-Title': 'NTLGNC Research Cron'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.3
      })
    });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const tokens = data.usage?.total_tokens || 0;
    return { text, tokens };
  } catch (err) {
    console.error(`  ❌ LLM call failed (${modelId}): ${err.message}`);
    return { text: '', tokens: 0 };
  }
}

function parseJSON(text) {
  let clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const firstBrace = clean.indexOf('{');
  const firstBracket = clean.indexOf('[');
  const start = Math.min(
    firstBrace >= 0 ? firstBrace : Infinity,
    firstBracket >= 0 ? firstBracket : Infinity
  );
  if (start < Infinity) clean = clean.slice(start);
  clean = clean.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(clean); } catch {
    let attempt = clean;
    const opens = (attempt.match(/{/g) || []).length;
    const closes = (attempt.match(/}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) attempt += '}';
    try { return JSON.parse(attempt); } catch { return null; }
  }
}

// ═══════════════════════════════════════════════════════════════
// DATA BUILDERS — Pull raw data for each research task type
// ═══════════════════════════════════════════════════════════════

async function buildCoinDeepDiveContext(client, dataScope) {
  const symbol = dataScope?.symbol;
  if (!symbol) {
    // No symbol specified — fall back to free exploration with coin queue info
    let context = 'COIN DEEP DIVE requested but no specific symbol provided.\n\n';
    context += 'TOP COINS IN UNIVERSE BACKTEST (by OOS trade count, not yet deployed):\n';
    try {
      const { rows } = await client.query(`
        SELECT ub.symbol, ub.timeframe, ub.oos_sharpe, ub.oos_trades, ub.regime_rho_breakdown
        FROM universe_backtest ub
        WHERE ub.symbol NOT IN (SELECT symbol FROM board_coin_strategies WHERE active = true)
          AND ub.oos_trades >= 30
        ORDER BY ub.oos_trades DESC
        LIMIT 20
      `);
      for (const r of rows) {
        context += `  ${r.symbol} [${r.timeframe}]: OOS Sharpe=${r.oos_sharpe}, trades=${r.oos_trades}\n`;
        if (r.regime_rho_breakdown) {
          const rho = typeof r.regime_rho_breakdown === 'string' ? JSON.parse(r.regime_rho_breakdown) : r.regime_rho_breakdown;
          const topFeatures = Object.entries(rho).filter(([,v]) => Math.abs(v) >= 0.8).map(([k,v]) => `${k}=${v}`).join(', ');
          if (topFeatures) context += `    Strong features (|rho|>=0.8): ${topFeatures}\n`;
        }
      }
    } catch (err) {
      context += `  Error: ${err.message}\n`;
    }
    context += '\nAnalyse the top candidates and recommend which coin+timeframe to deploy next, citing specific evidence.\n';
    return context;
  }
  
  let context = `COIN DEEP DIVE: ${symbol}\n\n`;
  
  // Universe backtest results for this coin across all timeframes
  try {
    const { rows } = await client.query(`
      SELECT timeframe, oos_sharpe, oos_trades, is_sharpe, is_trades,
             winner_params, regime_rho_breakdown
      FROM universe_backtest 
      WHERE symbol = $1
      ORDER BY timeframe
    `, [symbol]);
    context += `BACKTEST RESULTS (${rows.length} timeframes):\n`;
    for (const r of rows) {
      context += `  ${r.timeframe}: OOS Sharpe=${r.oos_sharpe}, OOS trades=${r.oos_trades}, IS Sharpe=${r.is_sharpe}, IS trades=${r.is_trades}\n`;
      if (r.regime_rho_breakdown) {
        const rho = typeof r.regime_rho_breakdown === 'string' ? JSON.parse(r.regime_rho_breakdown) : r.regime_rho_breakdown;
        context += `    Regime rho: ${JSON.stringify(rho)}\n`;
      }
      if (r.winner_params) {
        context += `    Winner params: ${JSON.stringify(r.winner_params)}\n`;
      }
    }
  } catch (err) {
    context += `  Error loading backtests: ${err.message}\n`;
  }
  
  // Regime scorecard entries for this coin
  try {
    const { rows } = await client.query(`
      SELECT feature, timeframe, rho, spread, is_sharpe, oos_sharpe, 
             bucket_count, total_trades
      FROM regime_scorecard
      WHERE symbol = $1
      ORDER BY ABS(rho) DESC
    `, [symbol]);
    context += `\nREGIME SCORECARD (${rows.length} feature-timeframe combos, sorted by |rho|):\n`;
    for (const r of rows) {
      context += `  ${r.feature} [${r.timeframe}]: rho=${r.rho?.toFixed(3)}, spread=${r.spread?.toFixed(4)}, IS_sharpe=${r.is_sharpe?.toFixed(2)}, OOS_sharpe=${r.oos_sharpe?.toFixed(2)}, trades=${r.total_trades}\n`;
    }
  } catch (err) {
    context += `  Error loading scorecard: ${err.message}\n`;
  }
  
  // Recent signal performance for this coin
  try {
    const { rows } = await client.query(`
      SELECT s.direction, st."barMinutes", COUNT(*) as n,
             AVG(s."returnPct") as avg_return, 
             SUM(CASE WHEN s."returnPct" > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) as win_rate
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.symbol = $1 AND s.status = 'closed' AND s."closedAt" > now() - interval '7 days'
      GROUP BY s.direction, st."barMinutes"
      ORDER BY st."barMinutes", s.direction
    `, [symbol]);
    const tfMap = { 1: '1m', 60: '1h', 1440: '1d' };
    context += `\nRECENT SIGNAL PERFORMANCE (last 7 days):\n`;
    for (const r of rows) {
      const tf = tfMap[r.barMinutes] || r.barMinutes + 'm';
      context += `  ${r.direction} ${tf}: ${r.n} signals, avg return=${parseFloat(r.avg_return).toFixed(4)}%, win rate=${(parseFloat(r.win_rate) * 100).toFixed(1)}%\n`;
    }
  } catch (err) {
    context += `  Error loading signals: ${err.message}\n`;
  }
  
  // Current regime conditions
  try {
    const { rows } = await client.query(`
      SELECT timeframe, vol_state, pos_in_range_60, atr_compression, 
             vol_ratio, trend, persistence
      FROM regime_cache
      WHERE symbol = $1
      ORDER BY timeframe
    `, [symbol]);
    context += `\nCURRENT REGIME CONDITIONS:\n`;
    for (const r of rows) {
      context += `  ${r.timeframe}: vol=${r.vol_state}, posInRange60=${r.pos_in_range_60}, atrComp=${r.atr_compression}, volRatio=${r.vol_ratio}, trend=${r.trend}, persist=${r.persistence}\n`;
    }
  } catch (err) {
    context += `  Error loading regime: ${err.message}\n`;
  }
  
  // Check if already deployed
  try {
    const { rows } = await client.query(`
      SELECT id, timeframe, active, created_at FROM board_coin_strategies
      WHERE symbol = $1
    `, [symbol]);
    if (rows.length > 0) {
      context += `\nEXISTING STRATEGIES:\n`;
      for (const r of rows) {
        context += `  #${r.id} ${r.timeframe}: active=${r.active}, created=${r.created_at}\n`;
      }
    } else {
      context += `\nNO EXISTING STRATEGIES — this coin is available for deployment.\n`;
    }
  } catch {}
  
  return context;
}

async function buildRegimeScanContext(client, dataScope) {
  const feature = dataScope?.feature || 'volState';
  let context = `REGIME SCAN: Feature "${feature}" across all coins\n\n`;
  
  try {
    const { rows } = await client.query(`
      SELECT symbol, timeframe, rho, spread, oos_sharpe, total_trades
      FROM regime_scorecard
      WHERE feature = $1 AND total_trades >= 30
      ORDER BY ABS(rho) DESC
      LIMIT 50
    `, [feature]);
    context += `TOP 50 COINS BY |rho| for ${feature} (min 30 trades):\n`;
    for (const r of rows) {
      context += `  ${r.symbol} [${r.timeframe}]: rho=${r.rho?.toFixed(3)}, spread=${r.spread?.toFixed(4)}, OOS_sharpe=${r.oos_sharpe?.toFixed(2)}, trades=${r.total_trades}\n`;
    }
  } catch (err) {
    context += `  Error: ${err.message}\n`;
  }
  
  return context;
}

async function buildFilterDesignContext(client, dataScope) {
  const feature = dataScope?.feature || 'volState';
  const timeframe = dataScope?.timeframe || '1h';
  let context = `FILTER DESIGN: Feature "${feature}" on ${timeframe}\n\n`;
  
  // Get regime scorecard data for this feature
  try {
    const { rows } = await client.query(`
      SELECT symbol, rho, spread, is_sharpe, oos_sharpe, total_trades,
             bucket_count
      FROM regime_scorecard
      WHERE feature = $1 AND timeframe = $2 AND total_trades >= 30
      ORDER BY oos_sharpe ASC
      LIMIT 30
    `, [feature, timeframe]);
    context += `SCORECARD FOR ${feature} [${timeframe}] — sorted by worst OOS Sharpe:\n`;
    for (const r of rows) {
      context += `  ${r.symbol}: rho=${r.rho?.toFixed(3)}, OOS_sharpe=${r.oos_sharpe?.toFixed(2)}, trades=${r.total_trades}\n`;
    }
  } catch (err) {
    context += `  Error: ${err.message}\n`;
  }
  
  // Get current active filters for comparison
  try {
    const { rows } = await client.query(`
      SELECT id, feature, conditions, timeframe, active, trades_filtered, trades_passed
      FROM board_filters WHERE active = true
    `);
    context += `\nCURRENT ACTIVE FILTERS:\n`;
    for (const r of rows) {
      context += `  #${r.id} ${r.feature} [${r.timeframe}]: ${JSON.stringify(r.conditions)}, filtered=${r.trades_filtered}, passed=${r.trades_passed}\n`;
    }
  } catch {}
  
  return context;
}

async function buildOpportunityScanContext(client, dataScope) {
  let context = `OPPORTUNITY SCAN: Coins with extreme recent returns\n\n`;
  
  // Find coins with worst 24h returns — these are the opportunities
  try {
    const { rows } = await client.query(`
      SELECT s.symbol, st."barMinutes", s.direction, COUNT(*) as n,
             AVG(s."returnPct") as avg_return,
             SUM(CASE WHEN s."returnPct" > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) as win_rate
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'closed' AND s."closedAt" > now() - interval '24 hours'
      GROUP BY s.symbol, st."barMinutes", s.direction
      HAVING COUNT(*) >= 3
      ORDER BY AVG(s."returnPct") ASC
      LIMIT 20
    `);
    const tfMap = { 1: '1m', 60: '1h', 1440: '1d' };
    context += `WORST PERFORMING COIN/TF/DIRECTION (24h, min 3 trades):\n`;
    for (const r of rows) {
      const tf = tfMap[r.barMinutes] || r.barMinutes + 'm';
      context += `  ${r.symbol} ${tf} ${r.direction}: ${r.n} trades, avg=${parseFloat(r.avg_return).toFixed(4)}%, WR=${(parseFloat(r.win_rate) * 100).toFixed(1)}%\n`;
    }
  } catch (err) {
    context += `  Error: ${err.message}\n`;
  }
  
  // Get regime conditions for the worst performers
  try {
    const { rows } = await client.query(`
      SELECT DISTINCT s.symbol, rc.timeframe, rc.vol_state, rc.pos_in_range_60, 
             rc.atr_compression, rc.vol_ratio
      FROM "FracmapSignal" s
      JOIN regime_cache rc ON s.symbol = rc.symbol
      WHERE s.status = 'closed' AND s."closedAt" > now() - interval '24 hours'
        AND s."returnPct" < -0.1
      LIMIT 20
    `);
    context += `\nREGIME CONDITIONS FOR LOSING TRADES:\n`;
    for (const r of rows) {
      context += `  ${r.symbol} [${r.timeframe}]: vol=${r.vol_state}, posInRange=${r.pos_in_range_60}, atrComp=${r.atr_compression}\n`;
    }
  } catch {}
  
  context += `\nQUESTION: For each losing coin, is the loss regime-specific? If so, what filter would capture this? A coin losing money ONLY in compressed vol is a filter opportunity, not an exclusion candidate.\n`;
  
  return context;
}

async function buildCrossTimeframeContext(client, dataScope) {
  let context = `CROSS-TIMEFRAME ANALYSIS\n\n`;
  context += `Question: Does the daily (1d) regime predict hourly (1h) signal performance?\n\n`;
  
  try {
    const { rows } = await client.query(`
      SELECT rc_d.symbol, rc_d.vol_state as daily_vol, rc_d.trend as daily_trend,
             AVG(s."returnPct") as avg_1h_return, COUNT(s.*) as n_1h_trades,
             SUM(CASE WHEN s."returnPct" > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(s.*), 0) as win_rate_1h
      FROM regime_cache rc_d
      JOIN "FracmapSignal" s ON s.symbol = rc_d.symbol
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE rc_d.timeframe = '1d'
        AND st."barMinutes" = 60
        AND s.status = 'closed'
        AND s."closedAt" > now() - interval '30 days'
      GROUP BY rc_d.symbol, rc_d.vol_state, rc_d.trend
      HAVING COUNT(s.*) >= 10
      ORDER BY AVG(s."returnPct") DESC
      LIMIT 30
    `);
    context += `1D REGIME → 1H PERFORMANCE (last 30 days, min 10 trades):\n`;
    for (const r of rows) {
      context += `  ${r.symbol} | daily_vol=${r.daily_vol}, daily_trend=${r.daily_trend} → 1H avg=${parseFloat(r.avg_1h_return).toFixed(4)}%, WR=${(parseFloat(r.win_rate_1h) * 100).toFixed(1)}%, n=${r.n_1h_trades}\n`;
    }
  } catch (err) {
    context += `  Error: ${err.message}\n`;
  }
  
  return context;
}

async function buildFreeExplorationContext(client, dataScope) {
  let context = `FREE EXPLORATION — Find something we haven't asked about\n\n`;
  
  // Give a broad summary of system state
  try {
    const { rows: [stats] } = await client.query(`
      SELECT COUNT(*) as total_signals,
             AVG("returnPct") as avg_return,
             SUM(CASE WHEN "returnPct" > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) as win_rate
      FROM "FracmapSignal"
      WHERE status = 'closed' AND "closedAt" > now() - interval '7 days'
    `);
    context += `SYSTEM OVERVIEW (7 days): ${stats.total_signals} signals, avg return=${parseFloat(stats.avg_return || 0).toFixed(4)}%, WR=${(parseFloat(stats.win_rate || 0) * 100).toFixed(1)}%\n\n`;
  } catch {}
  
  // All regime scorecard features with strongest edges
  try {
    const { rows } = await client.query(`
      SELECT feature, COUNT(*) as coins_with_data,
             AVG(ABS(rho)) as avg_abs_rho,
             MAX(ABS(rho)) as max_abs_rho,
             AVG(oos_sharpe) as avg_oos_sharpe
      FROM regime_scorecard
      WHERE total_trades >= 30
      GROUP BY feature
      ORDER BY AVG(ABS(rho)) DESC
    `);
    context += `REGIME FEATURES BY AVERAGE |rho|:\n`;
    for (const r of rows) {
      context += `  ${r.feature}: avg|rho|=${parseFloat(r.avg_abs_rho).toFixed(3)}, max|rho|=${parseFloat(r.max_abs_rho).toFixed(3)}, coins=${r.coins_with_data}, avg_oos_sharpe=${parseFloat(r.avg_oos_sharpe).toFixed(3)}\n`;
    }
  } catch {}
  
  // Active filters and strategies
  try {
    const { rows } = await client.query(`SELECT COUNT(*) as n FROM board_filters WHERE active = true`);
    context += `\nActive filters: ${rows[0]?.n || 0}\n`;
  } catch {}
  try {
    const { rows } = await client.query(`SELECT COUNT(*) as n FROM board_coin_strategies WHERE active = true`);
    context += `Active coin strategies: ${rows[0]?.n || 0}\n`;
  } catch {}
  
  context += `\nYou have full access to the data above. What patterns, risks, or opportunities do you see that the board hasn't discussed? Think creatively about: cross-feature interactions, temporal patterns, concentration risks, unexploited regime features, or coins that are surprisingly strong/weak.\n`;
  
  return context;
}

// ═══════════════════════════════════════════════════════════════
// RESEARCH PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════

function buildResearchPrompt(taskType, question, dataContext) {
  const responseFormat = {
    COIN_DEEP_DIVE: `{
  "summary": "1-2 sentence key finding",
  "recommendation": "DEPLOY / NO_DEPLOY / NEEDS_MORE_DATA",
  "confidence": "HIGH / MEDIUM / LOW",
  "analysis": {
    "best_timeframe": "1h/1m/1d",
    "best_feature": "feature name",
    "best_rho": 0.0,
    "oos_sharpe": 0.0,
    "oos_trades": 0,
    "directional_notes": "Any LONG vs SHORT asymmetries",
    "risk_factors": "What could go wrong"
  },
  "recommended_motion": {
    "type": "DEPLOY_COIN_STRATEGY or null",
    "title": "Deploy X on Y",
    "details": { "symbol": "...", "timeframe": "...", "rationale": "...", "backtest_evidence": {} }
  }
}`,
    REGIME_SCAN: `{
  "summary": "Key finding about this regime feature",
  "top_coins": [{ "symbol": "...", "timeframe": "...", "rho": 0.0, "oos_sharpe": 0.0, "trades": 0 }],
  "weak_coins": [{ "symbol": "...", "reason": "..." }],
  "recommendation": "What the board should do with this information",
  "follow_up_research": "What to investigate next"
}`,
    FILTER_DESIGN: `{
  "summary": "Proposed filter and expected impact",
  "proposed_filter": {
    "feature": "...",
    "conditions": { "blocked_values": [...], "threshold": "..." },
    "timeframe": "...",
    "expected_block_rate": "X%",
    "expected_improvement": "Description of what this filter should achieve"
  },
  "evidence": { "coins_affected": 0, "avg_blocked_return": 0, "avg_passed_return": 0 },
  "recommended_motion": {
    "type": "ADD_REGIME_FILTER",
    "title": "...",
    "details": { "feature": "...", "conditions": {}, "timeframe": "..." }
  }
}`,
    OPPORTUNITY_SCAN: `{
  "summary": "Key opportunities found",
  "opportunities": [{ "symbol": "...", "regime_condition": "...", "exploitable_pattern": "...", "proposed_action": "..." }],
  "recommended_research": [{ "task_type": "...", "question": "..." }]
}`,
    CROSS_TF_ANALYSIS: `{
  "summary": "Cross-timeframe findings",
  "correlations": [{ "predictor_tf": "...", "target_tf": "...", "feature": "...", "strength": "...", "description": "..." }],
  "recommendation": "How the board could use this",
  "proposed_feature": "Description of any new feature worth testing"
}`,
    FREE_EXPLORATION: `{
  "summary": "What I found",
  "findings": [{ "title": "...", "description": "...", "importance": "HIGH/MEDIUM/LOW", "evidence": "..." }],
  "recommended_actions": [{ "type": "...", "description": "..." }],
  "recommended_research": [{ "task_type": "...", "question": "..." }]
}`
  };
  
  return `RESEARCH TASK: ${taskType}
QUESTION: ${question}

DATA:
${dataContext}

Analyse the data above and answer the research question.
Be specific — cite exact numbers (rho values, Sharpe ratios, trade counts).
If you recommend a deployable action, provide a complete pre-built motion.

Respond ONLY as JSON in this format:
${responseFormat[taskType] || responseFormat.FREE_EXPLORATION}`;
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXECUTION LOOP
// ═══════════════════════════════════════════════════════════════

async function runResearchCycle() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  
  try {
    // Check if a board meeting is currently running (skip if so)
    const { rows: activeMeetings } = await client.query(`
      SELECT id FROM board_meetings 
      WHERE created_at > now() - interval '15 minutes' 
        AND (phase = 'started' OR phase = 'running')
      LIMIT 1
    `);
    if (activeMeetings.length > 0) {
      console.log(`⏸ Board meeting #${activeMeetings[0].id} in progress — skipping research cycle`);
      return;
    }
    
    // Pick up next queued task
    const { rows: tasks } = await client.query(`
      SELECT * FROM research_tasks 
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `);
    
    if (tasks.length === 0) {
      console.log(`📚 No queued research tasks`);
      return;
    }
    
    const task = tasks[0];
    console.log(`\n🔬 Starting research task #${task.id}: ${task.task_type} — "${task.question.slice(0, 80)}"`);
    
    // Mark as running
    await client.query(
      `UPDATE research_tasks SET status = 'running', started_at = now() WHERE id = $1`,
      [task.id]
    );
    
    // Build data context based on task type
    const dataScope = typeof task.data_scope === 'string' ? JSON.parse(task.data_scope) : (task.data_scope || {});
    let dataContext;
    
    switch (task.task_type) {
      case 'COIN_DEEP_DIVE':
        dataContext = await buildCoinDeepDiveContext(client, dataScope);
        break;
      case 'REGIME_SCAN':
        dataContext = await buildRegimeScanContext(client, dataScope);
        break;
      case 'FILTER_DESIGN':
        dataContext = await buildFilterDesignContext(client, dataScope);
        break;
      case 'OPPORTUNITY_SCAN':
        dataContext = await buildOpportunityScanContext(client, dataScope);
        break;
      case 'CROSS_TF_ANALYSIS':
        dataContext = await buildCrossTimeframeContext(client, dataScope);
        break;
      case 'FREE_EXPLORATION':
      default:
        dataContext = await buildFreeExplorationContext(client, dataScope);
        break;
    }
    
    // Build prompt
    const prompt = buildResearchPrompt(task.task_type, task.question, dataContext);
    
    // Select which LLM to use
    const assignedTo = Array.isArray(task.assigned_to) ? task.assigned_to[0] : 
                       (typeof task.assigned_to === 'string' ? task.assigned_to.replace(/[{}]/g, '') : 'claude');
    
    console.log(`  📡 Calling ${assignedTo} (${LLM_MODELS[assignedTo] || 'unknown'})...`);
    
    // Call the LLM
    const response = await callLLM(assignedTo, RESEARCH_SYSTEM_PROMPT, prompt, 2000);
    
    if (!response.text) {
      await client.query(
        `UPDATE research_tasks SET status = 'failed', completed_at = now(), 
         result = $1, tokens_used = $2 WHERE id = $3`,
        [JSON.stringify({ error: 'Empty LLM response' }), response.tokens, task.id]
      );
      console.log(`  ❌ Research task #${task.id} failed — empty response`);
      return;
    }
    
    // Parse result
    const result = parseJSON(response.text);
    if (!result) {
      await client.query(
        `UPDATE research_tasks SET status = 'failed', completed_at = now(), 
         result = $1, tokens_used = $2 WHERE id = $3`,
        [JSON.stringify({ error: 'JSON parse failed', raw: response.text.slice(0, 500) }), response.tokens, task.id]
      );
      console.log(`  ❌ Research task #${task.id} failed — couldn't parse JSON`);
      return;
    }
    
    // Extract recommended motions if present
    const recommendedMotions = [];
    if (result.recommended_motion && result.recommended_motion.type) {
      recommendedMotions.push(result.recommended_motion);
    }
    if (result.recommended_actions) {
      for (const action of result.recommended_actions) {
        if (action.type) recommendedMotions.push(action);
      }
    }
    
    // Store completed result
    await client.query(
      `UPDATE research_tasks SET 
         status = 'completed', 
         completed_at = now(), 
         result = $1,
         recommended_motions = $2,
         tokens_used = $3
       WHERE id = $4`,
      [JSON.stringify(result),
       recommendedMotions.length > 0 ? `{${recommendedMotions.map(m => `"${JSON.stringify(m).replace(/"/g, '\\"')}"`).join(',')}}` : null,
       response.tokens,
       task.id]
    );
    
    // Simpler approach for recommended_motions - store as JSONB array
    if (recommendedMotions.length > 0) {
      await client.query(
        `UPDATE research_tasks SET recommended_motions = $1::jsonb[] WHERE id = $2`,
        [recommendedMotions.map(m => JSON.stringify(m)), task.id]
      );
    }
    
    console.log(`  ✅ Research task #${task.id} completed!`);
    console.log(`     Summary: ${(result.summary || '').slice(0, 120)}`);
    console.log(`     Recommendation: ${result.recommendation || result.recommended_motion?.type || 'none'}`);
    console.log(`     Tokens: ${response.tokens}`);
    if (recommendedMotions.length > 0) {
      console.log(`     📌 ${recommendedMotions.length} pre-built motion(s) ready for board review`);
    }
    
  } catch (err) {
    console.error(`❌ Research cycle error: ${err.message}`);
    console.error(err.stack);
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--once')) {
    // Single execution mode
    runResearchCycle()
      .then(() => { console.log('Research cycle complete.'); process.exit(0); })
      .catch(err => { console.error(err); process.exit(1); });
  } else {
    // Continuous mode — run every 5 minutes
    const INTERVAL = 5 * 60 * 1000; // 5 minutes
    console.log(`🔬 Research cron starting — polling every ${INTERVAL / 60000} minutes`);
    console.log(`   Models: ${JSON.stringify(Object.keys(LLM_MODELS))}`);
    
    // Run immediately, then on interval
    runResearchCycle().catch(console.error);
    setInterval(() => {
      runResearchCycle().catch(console.error);
    }, INTERVAL);
  }
}

module.exports = { runResearchCycle };
