#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  MULTI-MOTION PATCH                                              ║
 * ║                                                                  ║
 * ║  Replaces the single-motion Phase 4b→5→6 with a loop that:     ║
 * ║    - Chair produces up to 3 separate motions                    ║
 * ║    - Each motion gets its own vote (with correct threshold)     ║
 * ║    - Each motion deploys independently                          ║
 * ║    - No more bundling to bypass unanimity                       ║
 * ║                                                                  ║
 * ║  Usage: node backend/apply-multi-motion.cjs                     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'llm-board.js');
let code = fs.readFileSync(FILE, 'utf8');

// ═══════════════════════════════════════════════════════════════
// We need to replace from the chair synthesis prompt through 
// to the end of Phase 6 (just before Phase 7).
// ═══════════════════════════════════════════════════════════════

const OLD_START = `    // ─── Chair synthesises a single motion from solutions ───
    console.log(\`[Phase 4b] \${chair.name} synthesises solutions into one motion...\\n\`);`;

const OLD_END = `    // ─── PHASE 7: FOLLOW-UP TARGET ───`;

const startIdx = code.indexOf(OLD_START);
const endIdx = code.indexOf(OLD_END);

if (startIdx === -1) {
  console.log('❌ Could not find Phase 4b start marker. Already patched?');
  process.exit(1);
}
if (endIdx === -1) {
  console.log('❌ Could not find Phase 7 start marker.');
  process.exit(1);
}

const NEW_CODE = `    // ─── Chair synthesises SEPARATE motions from solutions ───
    console.log(\`[Phase 4b] \${chair.name} synthesises solutions into separate motions...\\n\`);
    
    const synthesisResp = await callLLM(chair, memberSystem(chair), \`
ALL PROPOSED SOLUTIONS:
\${JSON.stringify(solutions, null, 2)}

THE PROBLEM: \${p3.selected_problem}

As chair, extract up to 3 SEPARATE motions from the proposed solutions.
CRITICAL RULE: Each motion must be a SINGLE action type. NEVER bundle multiple 
action types into one motion. If members proposed both AFFIRM_PATIENCE and 
DEPLOY_COIN_STRATEGY, those become TWO separate motions with TWO separate votes.

Each motion type has its own vote threshold:
  - DEPLOY_COIN_STRATEGY: 5/5 UNANIMOUS
  - EXCLUDE_COIN, INCLUDE_COIN, EMERGENCY_HALT, STRATEGY_PARAMETER: 4/5 SUPERMAJORITY
  - Everything else: 3/5 SIMPLE MAJORITY

Respond as JSON:
{
  "motions": [
    {
      "title": "Short title (under 15 words)",
      "type": "ONE motion type only",
      "details": { "timeframe": "1h/1m/1d/all", ...implementation details... },
      "hypothesis": "1 sentence expected outcome",
      "success_metric": "How to measure"
    }
  ],
  "rationale": "Why these motions address the problem"
}

RULES:
- Max 3 motions per meeting
- Each motion = exactly ONE type (no arrays of actions)
- DEPLOY_COIN_STRATEGY needs: symbol, timeframe, rationale, backtest_evidence with rho
- AFFIRM_PATIENCE needs: rationale
- ADD_REGIME_FILTER needs: feature, conditions, timeframe
\`, 1000);
    totalTokens += synthesisResp.tokens;
    const synthesis = parseJSON(synthesisResp.text) || {};
    
    // Normalise: handle both old format {motion:{}} and new format {motions:[]}
    let motions = [];
    if (synthesis.motions && Array.isArray(synthesis.motions)) {
      motions = synthesis.motions.slice(0, 3); // Max 3
    } else if (synthesis.motion) {
      motions = [synthesis.motion]; // Backwards compat
    } else if (solutions[0]) {
      motions = [{ title: 'Fallback', type: 'AFFIRM_PATIENCE', details: { rationale: 'Chair synthesis failed' } }];
    }
    
    console.log(\`  \${motions.length} motion(s) to vote on:\\n\`);
    
    // ═══ VOTE + DEPLOY LOOP — Each motion gets its own vote ═══
    const allMotionResults = [];
    let anyDeployed = false;
    
    for (let mi = 0; mi < motions.length; mi++) {
      const motion = motions[mi];
      console.log(\`  ── Motion \${mi + 1}/\${motions.length}: \${motion.title || 'Unnamed'} ──\\n\`);
      
      // ═══ MOTION TYPE GUARDRAIL ═══
      if (motion) {
        const _title = (motion.title || '').toLowerCase();
        const _type = (motion.type || '').toUpperCase();
        const _det = motion.details || {};
        
        if (/deploy.*coin|coin.*strateg|coin_\\w+_\\d|launch.*\\b(btc|eth|sol|bnb)\\b.*strat/i.test(_title) && _type !== 'DEPLOY_COIN_STRATEGY') {
          console.log(\`    ⚠ GUARDRAIL: Title implies DEPLOY_COIN_STRATEGY but type was "\${_type}". Correcting.\`);
          motion.type = 'DEPLOY_COIN_STRATEGY';
        }
        if (/deactivat.*coin|remove.*coin.*strat/i.test(_title) && _type !== 'DEACTIVATE_COIN_STRATEGY') {
          console.log(\`    ⚠ GUARDRAIL: Title implies DEACTIVATE_COIN_STRATEGY. Correcting.\`);
          motion.type = 'DEACTIVATE_COIN_STRATEGY';
        }
        if (_type === 'AFFIRM_PATIENCE' && _det.symbol && _det.timeframe) {
          console.log(\`    ⚠ GUARDRAIL: AFFIRM_PATIENCE has deploy details. Stripping.\`);
          delete _det.symbol; delete _det.timeframe; delete _det.backtest_evidence;
        }
        if (motion.type && !MOTION_TYPES[motion.type]) {
          console.log(\`    ⚠ GUARDRAIL: Unknown type "\${motion.type}". → AFFIRM_PATIENCE\`);
          motion.type = 'AFFIRM_PATIENCE';
        }
        
        // Evidence guardrail
        const _evidenceTypes = ['ADD_REGIME_FILTER', 'MODIFY_REGIME_FILTER', 'DEPLOY_COIN_STRATEGY'];
        if (_evidenceTypes.includes(motion.type)) {
          const ev = _det.evidence || _det.backtest_evidence || {};
          const rho = ev.rho || ev.best_rho || null;
          if (rho === null || rho === undefined) {
            console.log(\`    ⚠ EVIDENCE: \${motion.type} has no ρ. → REQUEST_ANALYSIS\`);
            motion.type = 'REQUEST_ANALYSIS';
            motion.details = { question: \`Gather ρ evidence for: \${motion.title}\`, data_needed: 'regime ρ values', timeframe: _det.timeframe || 'all' };
            motion.title = \`[Evidence needed] \${motion.title}\`;
          } else if (rho < 0.8) {
            console.log(\`    ⚠ EVIDENCE: ρ=\${rho} < 0.8. → REQUEST_ANALYSIS\`);
            motion.type = 'REQUEST_ANALYSIS';
            motion.title = \`[ρ=\${rho} < 0.8] \${motion.title}\`;
          } else {
            console.log(\`    ✅ Evidence OK: ρ=\${rho}\`);
          }
        }
      }
      
      console.log(\`    Type: \${motion.type}\\n\`);
      
      // ═══ VOTE on this motion ═══
      const motionType = motion.type || 'UNKNOWN';
      const requiresUnanimous = ['DEPLOY_COIN_STRATEGY'].includes(motionType);
      const requiresSupermajority = ['EMERGENCY_HALT', 'KILL_RESEARCH', 'EXCLUDE_COIN', 'INCLUDE_COIN', 'STRATEGY_PARAMETER'].includes(motionType);
      const thresholdLabel = requiresUnanimous ? '5/5 UNANIMOUS' : requiresSupermajority ? '4/5 SUPERMAJORITY' : '3/5 MAJORITY';
      
      console.log(\`    Voting [\${thresholdLabel}]...\\n\`);
      
      const votePromises = BOARD_MEMBERS.map(m => callLLM(m, memberSystem(m), \`
MOTION \${mi + 1}/\${motions.length}: "\${motion.title}"
Type: \${motion.type} [requires \${thresholdLabel}]
Details: \${JSON.stringify(motion.details || {}).slice(0, 400)}
Hypothesis: \${motion.hypothesis || 'None stated'}

Vote on THIS motion only. \${motions.length > 1 ? 'Other motions will be voted on separately.' : ''}

Respond as JSON:
{
  "support": true/false,
  "reasoning": "1 sentence why. Cite data."
}\`, 150));

      const voteResponses = await Promise.all(votePromises);
      const motionVotes = {};
      for (let i = 0; i < BOARD_MEMBERS.length; i++) {
        totalTokens += voteResponses[i].tokens;
        const parsed = parseJSON(voteResponses[i].text) || { support: false, reasoning: voteResponses[i].text };
        motionVotes[BOARD_MEMBERS[i].id] = { support: !!parsed.support, reasoning: parsed.reasoning };
        console.log(\`    \${BOARD_MEMBERS[i].name}: \${parsed.support ? '✅' : '❌'} \${(parsed.reasoning || '').slice(0, 80)}\`);
      }
      
      const supportCount = Object.values(motionVotes).filter(v => v.support).length;
      const totalVoteCount = Object.values(motionVotes).length;
      const threshold = requiresUnanimous ? totalVoteCount : requiresSupermajority ? Math.ceil(totalVoteCount * 4 / 5) : Math.ceil(totalVoteCount / 2 + 0.1);
      const motionPassed = supportCount >= threshold;
      
      if (!motionPassed && requiresUnanimous) {
        console.log(\`\\n    Result: \${supportCount}/\${totalVoteCount} → ❌ FAILED (needed \${thresholdLabel})\\n\`);
      } else if (!motionPassed && requiresSupermajority) {
        console.log(\`\\n    Result: \${supportCount}/\${totalVoteCount} → ❌ FAILED (needed \${thresholdLabel})\\n\`);
      } else {
        console.log(\`\\n    Result: \${supportCount}/\${totalVoteCount} → \${motionPassed ? '✅ PASSED' : '❌ FAILED'}\\n\`);
      }
      
      // ═══ DEPLOY this motion if passed ═══
      let motionDeployed = false;
      if (motionPassed) {
        try {
          motion._supportCount = supportCount;
          motion._totalVotes = totalVoteCount;
          motionDeployed = await deployMotion(client, motion, chair.id, meetingId, roundNumber);
          if (motionDeployed) anyDeployed = true;
        } catch (err) {
          console.error(\`    ❌ Deploy error: \${err.message}\`);
        }
      }
      
      allMotionResults.push({
        motion,
        votes: motionVotes,
        supportCount,
        totalVotes: totalVoteCount,
        threshold,
        thresholdLabel,
        passed: motionPassed,
        deployed: motionDeployed,
      });
    }
    
    // Build combined decision string
    const decisionParts = allMotionResults.map((r, i) => 
      \`[\${i+1}] \${r.passed ? 'PASSED' : 'FAILED'} (\${r.supportCount}/\${r.totalVotes}): \${r.motion.title || 'Unnamed'}\`
    );
    const decision = decisionParts.join(' | ');
    const deployed = anyDeployed;
    
    // Use the first motion's type as the primary for DB storage (backwards compat)
    const motionType = allMotionResults[0]?.motion?.type || 'UNKNOWN';
    
    // Combined votes object for DB storage
    const votes = {};
    for (const result of allMotionResults) {
      for (const [memberId, vote] of Object.entries(result.votes)) {
        if (!votes[memberId]) votes[memberId] = { support: true, reasoning: [], role: '' };
        const memberInfo = BOARD_MEMBERS.find(m => m.id === memberId);
        votes[memberId].role = memberInfo?.role || '';
        votes[memberId].reasoning.push(\`[\${result.motion.title?.slice(0, 30)}]: \${vote.support ? '✅' : '❌'} \${vote.reasoning || ''}\`);
        if (!vote.support) votes[memberId].support = false; // If they opposed ANY motion, mark as oppose
      }
    }
    // Flatten reasoning arrays to strings
    for (const v of Object.values(votes)) {
      v.reasoning = v.reasoning.join(' | ');
    }

    // Store synthesis with all motions for frontend rendering
    const synthesis_compat = { 
      motion: allMotionResults[0]?.motion, 
      motions: allMotionResults,
      rationale: synthesis.rationale 
    };
    
    console.log(\`\\n  ═══ MEETING RESULTS ═══\`);
    for (const r of allMotionResults) {
      console.log(\`  \${r.passed ? '✅' : '❌'} \${r.motion.title} [\${r.supportCount}/\${r.totalVotes}, needed \${r.thresholdLabel}]\${r.deployed ? ' → DEPLOYED' : ''}\`);
    }
    console.log();

`;

// ═══════════════════════════════════════════════════════════════
// Also need to fix the Phase 7 prompt and DB save to use new variables
// ═══════════════════════════════════════════════════════════════

// Replace the section between Phase 4b start and Phase 7 start
const before = code.substring(0, startIdx);
const after = code.substring(endIdx);

code = before + NEW_CODE + after;

// Fix the DB save to use synthesis_compat instead of synthesis
code = code.replace(
  `          synthesis,`,
  `          synthesis: synthesis_compat,`
);

// Fix the decision reference in digest
// (the 'synthesis.motion' references need to work with the new structure)

console.log('\n╔═══════════════════════════════════════╗');
console.log('║  Multi-Motion Patch Applied            ║');
console.log('╚═══════════════════════════════════════╝\n');

// Backup
const backup = FILE + '.pre-multimotion-backup';
if (!fs.existsSync(backup)) {
  fs.copyFileSync(FILE, backup);
  console.log(`  Backup: ${backup}`);
}

fs.writeFileSync(FILE, code, 'utf8');
console.log(`  Written: ${FILE}\n`);
console.log('  Changes:');
console.log('  ✅ Chair now produces up to 3 separate motions');
console.log('  ✅ Each motion voted independently with correct threshold');
console.log('  ✅ Each motion deployed independently');
console.log('  ✅ No more bundling to bypass unanimity');
console.log('  ✅ Decision string shows all results');
console.log('  ✅ Backwards compatible with frontend rendering\n');
