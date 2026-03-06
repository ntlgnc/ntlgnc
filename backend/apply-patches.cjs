#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  BOARD MEETING PATCH APPLIER                                     ║
 * ║                                                                  ║
 * ║  Applies all 5 patches to llm-board.js:                         ║
 * ║    1. Motion type validation (prevent chair bypass)              ║
 * ║    2. AFFIRM_PATIENCE deployed flag fix                         ║
 * ║    3. Per-LLM forecast scoring + price targets                  ║
 * ║    4. Spearman ρ enforcement for proposals                      ║
 * ║    5. Shorter meeting output                                     ║
 * ║                                                                  ║
 * ║  Usage: node apply-patches.cjs                                  ║
 * ║  (Run from the backend/ directory)                              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'llm-board.js');
let code = fs.readFileSync(FILE, 'utf8');
let changes = 0;

function replace(label, oldStr, newStr) {
  if (!code.includes(oldStr)) {
    console.log(`  ⚠ SKIP: "${label}" — pattern not found`);
    return false;
  }
  code = code.replace(oldStr, newStr);
  changes++;
  console.log(`  ✅ ${label}`);
  return true;
}

console.log('\n╔═══════════════════════════════════╗');
console.log('║  Applying Board Meeting Patches   ║');
console.log('╚═══════════════════════════════════╝\n');

// ═══════════════════════════════════════════════════════════════
// PATCH 1: Motion type validation
// ═══════════════════════════════════════════════════════════════
console.log('Patch 1: Motion type guardrail...');

replace('Motion type guardrail',
  `    const synthesis = parseJSON(synthesisResp.text) || { motion: solutions[0] };
    console.log(\`  Motion: \${synthesis.motion?.title || 'Unnamed'}\\n\`);`,

  `    const synthesis = parseJSON(synthesisResp.text) || { motion: solutions[0] };
    
    // ═══ MOTION TYPE GUARDRAIL — Prevent chair from picking wrong type ═══
    if (synthesis.motion) {
      const _title = (synthesis.motion.title || '').toLowerCase();
      const _type = (synthesis.motion.type || '').toUpperCase();
      const _det = synthesis.motion.details || {};
      
      // If title mentions deploying a coin strategy, force correct type
      if (/deploy.*coin|coin.*strateg|coin_\\w+_\\d/i.test(_title) && _type !== 'DEPLOY_COIN_STRATEGY') {
        console.log(\`  ⚠ GUARDRAIL: Title implies DEPLOY_COIN_STRATEGY but type was "\${_type}". Correcting.\`);
        synthesis.motion.type = 'DEPLOY_COIN_STRATEGY';
      }
      // If title mentions deactivating, force correct type
      if (/deactivat.*coin|remove.*coin.*strat/i.test(_title) && _type !== 'DEACTIVATE_COIN_STRATEGY') {
        console.log(\`  ⚠ GUARDRAIL: Title implies DEACTIVATE_COIN_STRATEGY. Correcting.\`);
        synthesis.motion.type = 'DEACTIVATE_COIN_STRATEGY';
      }
      // AFFIRM_PATIENCE should not carry deployment details
      if (_type === 'AFFIRM_PATIENCE' && _det.symbol && _det.timeframe) {
        console.log(\`  ⚠ GUARDRAIL: AFFIRM_PATIENCE has deploy details. Stripping.\`);
        delete _det.symbol; delete _det.timeframe; delete _det.backtest_evidence;
      }
      // Validate type exists
      if (synthesis.motion.type && !MOTION_TYPES[synthesis.motion.type]) {
        console.log(\`  ⚠ GUARDRAIL: Unknown type "\${synthesis.motion.type}". → AFFIRM_PATIENCE\`);
        synthesis.motion.type = 'AFFIRM_PATIENCE';
      }
      
      // ═══ EVIDENCE GUARDRAIL — Filter/strategy motions need ρ evidence ═══
      const _evidenceTypes = ['ADD_REGIME_FILTER', 'MODIFY_REGIME_FILTER', 'DEPLOY_COIN_STRATEGY'];
      if (_evidenceTypes.includes(synthesis.motion.type)) {
        const ev = _det.evidence || _det.backtest_evidence || {};
        const rho = ev.rho || ev.best_rho || null;
        if (rho === null || rho === undefined) {
          console.log(\`  ⚠ EVIDENCE: \${synthesis.motion.type} has no ρ. → REQUEST_ANALYSIS\`);
          synthesis.motion.type = 'REQUEST_ANALYSIS';
          synthesis.motion.details = { question: \`Gather ρ evidence for: \${synthesis.motion.title}\`, data_needed: 'regime ρ values', timeframe: _det.timeframe || 'all' };
          synthesis.motion.title = \`[Evidence needed] \${synthesis.motion.title}\`;
        } else if (rho < 0.8) {
          console.log(\`  ⚠ EVIDENCE: ρ=\${rho} < 0.8 threshold. → REQUEST_ANALYSIS\`);
          synthesis.motion.type = 'REQUEST_ANALYSIS';
          synthesis.motion.title = \`[ρ=\${rho} < 0.8] \${synthesis.motion.title}\`;
        } else {
          console.log(\`  ✅ Evidence OK: ρ=\${rho}\`);
        }
      }
    }
    
    console.log(\`  Motion: \${synthesis.motion?.title || 'Unnamed'} [type=\${synthesis.motion?.type}]\\n\`);`
);

// ═══════════════════════════════════════════════════════════════
// PATCH 2: AFFIRM_PATIENCE deployed fix
// ═══════════════════════════════════════════════════════════════
console.log('\nPatch 2: AFFIRM_PATIENCE deployed fix...');

replace('AFFIRM_PATIENCE returns false',
  `    case 'AFFIRM_PATIENCE': {
      console.log(\`  ✅ PATIENCE AFFIRMED: \${details.rationale || motion.title}\`);
      // No system changes — this is a formal "do nothing" vote
      return true;
    }`,

  `    case 'AFFIRM_PATIENCE': {
      console.log(\`  ✅ PATIENCE AFFIRMED: \${details.rationale || motion.title}\`);
      // No system changes — return false so UI doesn't show "DEPLOYED"
      return false;
    }`
);

// ═══════════════════════════════════════════════════════════════
// PATCH 3: Per-LLM forecast leaderboard table
// ═══════════════════════════════════════════════════════════════
console.log('\nPatch 3: Forecast leaderboard table + scoring...');

// Add new table after board_btc_forecasts
replace('Add forecast_leaderboard table',
  `  // User feedback — thumbs up/down on board changes`,

  `  // Per-LLM forecast accuracy leaderboard
  await client.query(\`
    CREATE TABLE IF NOT EXISTS board_forecast_leaderboard (
      id              SERIAL PRIMARY KEY,
      member_id       TEXT NOT NULL,
      total_forecasts INT DEFAULT 0,
      correct_direction INT DEFAULT 0,
      total_abs_error FLOAT DEFAULT 0,
      best_streak     INT DEFAULT 0,
      current_streak  INT DEFAULT 0,
      last_updated    TIMESTAMPTZ DEFAULT now(),
      UNIQUE(member_id)
    )
  \`);
  await client.query(\`ALTER TABLE board_btc_forecasts ADD COLUMN IF NOT EXISTS individual_scores JSONB\`);

  // User feedback — thumbs up/down on board changes`
);

// ═══════════════════════════════════════════════════════════════
// PATCH 3b: Load forecast leaderboard in gatherContext
// ═══════════════════════════════════════════════════════════════

// Add leaderboard loading after forecastRecord
replace('Load forecast leaderboard',
  `  let forecastRecord = { total: 0, correct: 0, streak: 0 };`,
  `  let forecastRecord = { total: 0, correct: 0, streak: 0 };
  let forecastLeaderboard = [];`
);

// Load leaderboard data (insert after forecastRecord loading)
replace('Fetch leaderboard data',
  `    forecastRecord.streak = streak;`,
  `    forecastRecord.streak = streak;
    // Per-LLM leaderboard
    try {
      const { rows: lbRows } = await client.query(\`SELECT * FROM board_forecast_leaderboard ORDER BY CASE WHEN total_forecasts = 0 THEN 0 ELSE correct_direction::float / total_forecasts END DESC\`);
      forecastLeaderboard = lbRows;
    } catch {}`
);

// Add to return object
replace('Add leaderboard to context return',
  `    forecastRecord,`,
  `    forecastRecord,
    forecastLeaderboard,`
);

// ═══════════════════════════════════════════════════════════════
// PATCH 3c: Enhanced forecast prompt with price target
// ═══════════════════════════════════════════════════════════════

replace('Enhanced forecast prompt',
  `BTC 60-MINUTE FORECAST. Predict BTC direction for the next hour.

\${btcSummary.join('\\n')}

You MUST justify your prediction using the regime data above, not gut feeling.
Consider: posInRange (where in the range is BTC?), volatility state, trend, persistence, hurst.

Respond as JSON:
{
  "direction": "UP" or "DOWN",
  "confidence": "LOW" or "MEDIUM" or "HIGH",
  "reasoning": "2-3 sentences citing specific regime values"
}\`, 300))`,

  `BTC 60-MINUTE FORECAST. Predict BTC price in 1 hour.
Current: $\${lastPrice.toFixed(2)}

\${btcSummary.join('\\n')}

Give a SPECIFIC price target. Justify with regime data.

Respond as JSON:
{
  "direction": "UP" or "DOWN",
  "price_target": <your predicted BTC price as a number>,
  "confidence": "LOW" or "MEDIUM" or "HIGH",
  "reasoning": "1-2 sentences, cite regime numbers"
}\`, 300))`
);

// Store price_target in forecast
replace('Store price_target',
  `        forecasts[BOARD_MEMBERS[i].id] = { direction: dir, confidence: parsed.confidence || 'LOW', reasoning: parsed.reasoning || '' };`,
  `        const priceTarget = parseFloat(parsed.price_target) || lastPrice;
        forecasts[BOARD_MEMBERS[i].id] = { direction: dir, price_target: priceTarget, confidence: parsed.confidence || 'LOW', reasoning: parsed.reasoning || '' };`
);

// ═══════════════════════════════════════════════════════════════
// PATCH 3d: Enhanced forecast scoring with per-LLM tracking
// ═══════════════════════════════════════════════════════════════

replace('Enhanced forecast scoring',
  `        const consensusCorrect = pf.consensus_direction === actualDirection;
        try {
          await client.query(
            \`UPDATE board_btc_forecasts SET btc_price_at_review = $1, actual_direction = $2, actual_change_pct = $3, consensus_correct = $4, reviewed_at = now() WHERE id = $5\`,
            [currentPrice, actualDirection, changePct, consensusCorrect, pf.id]
          );
          console.log(\`  📊 Previous forecast scored: \${pf.consensus_direction} → \${actualDirection} (\${changePct >= 0 ? '+' : ''}\${changePct.toFixed(2)}%) — \${consensusCorrect ? '✅' : '❌'}\`);
        } catch {}`,

  `        const consensusCorrect = pf.consensus_direction === actualDirection;
        
        // Score individual LLMs
        const _indivForecasts = typeof pf.individual_forecasts === 'string' ? JSON.parse(pf.individual_forecasts) : (pf.individual_forecasts || {});
        const individualScores = {};
        for (const [_mid, _fcast] of Object.entries(_indivForecasts)) {
          const _dirOK = _fcast.direction === actualDirection;
          const _pErr = _fcast.price_target ? Math.abs(_fcast.price_target - currentPrice) : null;
          individualScores[_mid] = { direction_correct: _dirOK, price_error: _pErr, predicted_target: _fcast.price_target || null };
          console.log(\`    \${_mid.toUpperCase()}: \${_fcast.direction}→\${actualDirection} \${_dirOK ? '✅' : '❌'}\${_pErr !== null ? \` err=$\${_pErr.toFixed(0)}\` : ''}\`);
          try {
            await client.query(\`
              INSERT INTO board_forecast_leaderboard (member_id, total_forecasts, correct_direction, total_abs_error, current_streak, best_streak)
              VALUES ($1, 1, $2, $3, $4, $4)
              ON CONFLICT (member_id) DO UPDATE SET
                total_forecasts = board_forecast_leaderboard.total_forecasts + 1,
                correct_direction = board_forecast_leaderboard.correct_direction + $2,
                total_abs_error = board_forecast_leaderboard.total_abs_error + COALESCE($3, 0),
                current_streak = CASE WHEN $2 = 1 THEN board_forecast_leaderboard.current_streak + 1 ELSE 0 END,
                best_streak = GREATEST(board_forecast_leaderboard.best_streak, CASE WHEN $2 = 1 THEN board_forecast_leaderboard.current_streak + 1 ELSE board_forecast_leaderboard.best_streak END),
                last_updated = now()
            \`, [_mid, _dirOK ? 1 : 0, _pErr, _dirOK ? 1 : 0]);
          } catch {}
        }
        // Find closest predictor
        const _withTargets = Object.entries(individualScores).filter(([,s]) => s.price_error !== null);
        if (_withTargets.length > 0) {
          _withTargets.sort((a, b) => a[1].price_error - b[1].price_error);
          console.log(\`    🏆 Closest: \${_withTargets[0][0].toUpperCase()} (off by $\${_withTargets[0][1].price_error.toFixed(0)})\`);
        }
        
        try {
          await client.query(
            \`UPDATE board_btc_forecasts SET btc_price_at_review = $1, actual_direction = $2, actual_change_pct = $3, consensus_correct = $4, individual_scores = $5, reviewed_at = now() WHERE id = $6\`,
            [currentPrice, actualDirection, changePct, consensusCorrect, JSON.stringify(individualScores), pf.id]
          );
          console.log(\`  📊 Forecast scored: \${pf.consensus_direction} → \${actualDirection} (\${changePct >= 0 ? '+' : ''}\${changePct.toFixed(2)}%) — \${consensusCorrect ? '✅' : '❌'}\`);
        } catch {}`
);

// ═══════════════════════════════════════════════════════════════
// PATCH 3e: Add leaderboard to forecast briefing
// ═══════════════════════════════════════════════════════════════

replace('Leaderboard in briefing',
  `    if (ctx.btcRegime) {
      const r = ctx.btcRegime;
      briefing += \`  BTC regime: posInRange=\${(r.posInRange60||0).toFixed(2)} vol=\${r.volState||'?'} atr=\${(r.atrCompression||0).toFixed(2)} hurst=\${(r.hurst||0).toFixed(3)}\\n\`;
    }
  }`,

  `    if (ctx.btcRegime) {
      const r = ctx.btcRegime;
      briefing += \`  BTC regime: posInRange=\${(r.posInRange60||0).toFixed(2)} vol=\${r.volState||'?'} atr=\${(r.atrCompression||0).toFixed(2)} hurst=\${(r.hurst||0).toFixed(3)}\\n\`;
    }
    if (ctx.forecastLeaderboard?.length > 0) {
      briefing += \`  FORECAST LEADERBOARD:\\n\`;
      for (const lb of ctx.forecastLeaderboard) {
        const pct = lb.total_forecasts > 0 ? ((lb.correct_direction / lb.total_forecasts) * 100).toFixed(0) : '0';
        const avgErr = lb.total_forecasts > 0 ? (lb.total_abs_error / lb.total_forecasts).toFixed(0) : '-';
        briefing += \`    \${lb.member_id.toUpperCase().padEnd(9)} \${(pct + '%').padEnd(5)} avg_err=$\${avgErr.toString().padEnd(6)} streak=\${lb.current_streak} best=\${lb.best_streak} n=\${lb.total_forecasts}\\n\`;
      }
    }
  }`
);

// ═══════════════════════════════════════════════════════════════
// PATCH 5: Shorter Phase 2 prompts
// ═══════════════════════════════════════════════════════════════
console.log('\nPatch 5: Shorter prompts...');

// Reduce vote maxTokens from 300 to 150
replace('Shorter vote tokens',
  `"reasoning": "Why you support or oppose (1-2 sentences)",
  "conditions": "Any conditions for your support (or null)"
}\`, 300))`,

  `"reasoning": "1 sentence why. Cite data.",
  "conditions": "Any conditions (or null)"
}\`, 150))`
);

// ═══════════════════════════════════════════════════════════════
// DONE
// ═══════════════════════════════════════════════════════════════

console.log(`\n═══════════════════════════════════════`);
console.log(`  ${changes} patches applied successfully`);
console.log(`═══════════════════════════════════════\n`);

// Backup original
const backup = FILE + '.pre-patch-backup';
if (!fs.existsSync(backup)) {
  fs.copyFileSync(FILE, backup);
  console.log(`  Backup saved to ${backup}`);
}

fs.writeFileSync(FILE, code, 'utf8');
console.log(`  Patched file written to ${FILE}\n`);
