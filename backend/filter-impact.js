/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC — FILTER IMPACT MEASUREMENT                            ║
 * ║                                                                  ║
 * ║  Measures the real-world impact of board-deployed regime filters ║
 * ║  by comparing performance of:                                    ║
 * ║    A) Signals that PASSED filters (actually traded)             ║
 * ║    B) Signals that were BLOCKED by filters (counterfactual)     ║
 * ║                                                                  ║
 * ║  If blocked signals were worse than passed signals, the filter  ║
 * ║  is working. If they were better, the filter is destroying edge.║
 * ╚══════════════════════════════════════════════════════════════════╝
 * 
 * Two modes:
 *   1. LIVE MODE: Wired into live-signals.cjs — blocked signals are 
 *      written with status='filtered' so we track their counterfactual
 *      returns when they eventually "close" (based on hold period).
 *   2. RETROACTIVE: Query all signals since a filter was deployed,
 *      compute what the filter would have blocked, compare returns.
 */

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// ═══════════════════════════════════════════════════════════════
// SCHEMA — Add columns to support filter audit trail
// ═══════════════════════════════════════════════════════════════

async function ensureImpactSchema(client) {
  // Add timeframe to FracmapSignal if missing
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS timeframe TEXT`); } catch {}
  // Add filtered_by — which filter blocked this signal (null = passed)
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS filtered_by INTEGER`); } catch {}
  // Add filter_details — what the regime values were at signal time  
  try { await client.query(`ALTER TABLE "FracmapSignal" ADD COLUMN IF NOT EXISTS regime_snapshot JSONB`); } catch {}
  
  // Index for impact queries
  try { await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_filtered ON "FracmapSignal"(filtered_by, status)`); } catch {}
  try { await client.query(`CREATE INDEX IF NOT EXISTS idx_signal_timeframe ON "FracmapSignal"(timeframe, "createdAt" DESC)`); } catch {}
  
  // Add impact columns to board_filters
  try { await client.query(`ALTER TABLE board_filters ADD COLUMN IF NOT EXISTS impact_measured_at TIMESTAMPTZ`); } catch {}
  try { await client.query(`ALTER TABLE board_filters ADD COLUMN IF NOT EXISTS impact_data JSONB`); } catch {}
}


// ═══════════════════════════════════════════════════════════════
// RETROACTIVE IMPACT — For signals already in DB
// Computes what the filter WOULD HAVE blocked and compares returns
// ═══════════════════════════════════════════════════════════════

async function measureFilterImpact(filterId) {
  const client = await pool.connect();
  try {
    await ensureImpactSchema(client);
    
    // Get the filter
    const { rows: [filter] } = await client.query(
      `SELECT * FROM board_filters WHERE id = $1`, [filterId]
    );
    if (!filter) throw new Error(`Filter ${filterId} not found`);
    
    const conditions = typeof filter.conditions === 'string' 
      ? JSON.parse(filter.conditions) : filter.conditions;
    const deployedAt = filter.created_at;
    
    console.log(`\n═══ MEASURING IMPACT: ${filter.feature} (Filter #${filterId}) ═══`);
    console.log(`  Deployed: ${deployedAt}`);
    console.log(`  Conditions: ${JSON.stringify(conditions).slice(0, 200)}`);
    
    // Get all CLOSED signals since filter was deployed
    const { rows: signals } = await client.query(`
      SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice", 
             s."returnPct", s.status, s."createdAt", s."closedAt",
             s.timeframe, s.filtered_by, s.regime_snapshot
      FROM "FracmapSignal" s
      WHERE s."createdAt" >= $1 
        AND s.status IN ('closed', 'filtered')
      ORDER BY s."createdAt"
    `, [deployedAt]);
    
    console.log(`  Total signals since deployment: ${signals.length}`);
    
    // Separate into passed and would-have-been-blocked
    // For signals with regime_snapshot, we can check retroactively
    // For signals without, we use the filtered_by column
    const passed = [];
    const blocked = [];
    let unknownRegime = 0;
    
    for (const sig of signals) {
      if (sig.filtered_by === filterId) {
        // This signal was actually blocked by this filter (live mode)
        blocked.push(sig);
      } else if (sig.regime_snapshot) {
        // We have regime data — check if this filter would have blocked it
        const snapshot = typeof sig.regime_snapshot === 'string' 
          ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
        const wouldBlock = checkWouldBlock(sig, snapshot, filter.feature, conditions);
        if (wouldBlock) {
          blocked.push(sig);
        } else {
          passed.push(sig);
        }
      } else {
        // No regime snapshot — assume passed (conservative)
        passed.push(sig);
        unknownRegime++;
      }
    }
    
    // Compute stats
    const passedClosed = passed.filter(s => s.returnPct != null);
    const blockedClosed = blocked.filter(s => s.returnPct != null);
    
    const passedStats = computeStats(passedClosed);
    const blockedStats = computeStats(blockedClosed);
    
    // The key metric: if blocked signals had worse returns, filter is working
    const savedReturn = (blockedStats.avgReturn < 0) 
      ? Math.abs(blockedStats.totalReturn) // We saved this much by not trading them
      : -blockedStats.totalReturn; // We LOST this much by blocking profitable trades
    
    const verdict = blockedStats.avgReturn < passedStats.avgReturn
      ? 'POSITIVE' // Filter is helping — blocked worse trades
      : blockedStats.avgReturn > passedStats.avgReturn
        ? 'NEGATIVE' // Filter is hurting — blocked better trades
        : 'NEUTRAL';
    
    const impact = {
      filter_id: filterId,
      feature: filter.feature,
      measured_at: new Date().toISOString(),
      period_start: deployedAt,
      period_hours: Math.round((Date.now() - new Date(deployedAt).getTime()) / 3600000),
      verdict,
      summary: {
        total_signals: signals.length,
        passed_count: passed.length,
        blocked_count: blocked.length,
        unknown_regime: unknownRegime,
      },
      passed: passedStats,
      blocked: blockedStats,
      improvement: {
        avg_return_delta: passedStats.avgReturn - blockedStats.avgReturn,
        win_rate_delta: passedStats.winRate - blockedStats.winRate,
        saved_cumulative_return: savedReturn,
      },
    };
    
    // Save to DB
    await client.query(
      `UPDATE board_filters SET impact_measured_at = now(), impact_data = $1,
              trades_passed = $2, trades_filtered = $3
       WHERE id = $4`,
      [JSON.stringify(impact), passed.length, blocked.length, filterId]
    );
    
    // Print results
    console.log(`\n  ── RESULTS ──`);
    console.log(`  Verdict: ${verdict}`);
    console.log(`  Passed signals:  ${passedStats.count} trades, avg ${passedStats.avgReturn.toFixed(3)}%, WR ${passedStats.winRate.toFixed(1)}%, cumulative ${passedStats.totalReturn.toFixed(2)}%`);
    console.log(`  Blocked signals: ${blockedStats.count} trades, avg ${blockedStats.avgReturn.toFixed(3)}%, WR ${blockedStats.winRate.toFixed(1)}%, cumulative ${blockedStats.totalReturn.toFixed(2)}%`);
    console.log(`  Return delta: ${impact.improvement.avg_return_delta > 0 ? '+' : ''}${impact.improvement.avg_return_delta.toFixed(4)}% per trade (passed vs blocked)`);
    console.log(`  Saved cumulative: ${savedReturn > 0 ? '+' : ''}${savedReturn.toFixed(2)}%`);
    console.log(`  ${unknownRegime > 0 ? `  ⚠ ${unknownRegime} signals had no regime snapshot (assumed passed)` : ''}`);
    
    return impact;
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// CHECK IF A SIGNAL WOULD BE BLOCKED
// ═══════════════════════════════════════════════════════════════

function checkWouldBlock(signal, regimeSnapshot, feature, conditions) {
  if (!conditions || !regimeSnapshot) return false;
  
  // Handle rules-based filters (like posInRange60)
  if (conditions.rules) {
    for (const rule of conditions.rules) {
      // Direction check
      if (rule.direction && signal.direction !== rule.direction) continue;
      
      const featureKey = rule.feature || feature;
      const val = regimeSnapshot[featureKey];
      if (val === undefined || val === null) continue;
      
      if (rule.min !== undefined && val < rule.min) return true;
      if (rule.max !== undefined && val > rule.max) return true;
    }
  }
  
  // Handle simple threshold filters
  const featureValue = regimeSnapshot[conditions.feature || feature];
  if (featureValue === undefined || featureValue === null) return false;
  if (conditions.min !== undefined && featureValue < conditions.min) return true;
  if (conditions.max !== undefined && featureValue > conditions.max) return true;
  
  return false;
}


// ═══════════════════════════════════════════════════════════════
// STATS HELPER
// ═══════════════════════════════════════════════════════════════

function computeStats(signals) {
  if (signals.length === 0) {
    return { count: 0, avgReturn: 0, totalReturn: 0, winRate: 0, wins: 0, losses: 0, bestTrade: 0, worstTrade: 0 };
  }
  
  const returns = signals.map(s => s.returnPct || 0);
  const wins = returns.filter(r => r > 0).length;
  const totalReturn = returns.reduce((a, b) => a + b, 0);
  
  return {
    count: signals.length,
    avgReturn: totalReturn / signals.length,
    totalReturn,
    winRate: (wins / signals.length) * 100,
    wins,
    losses: signals.length - wins,
    bestTrade: Math.max(...returns),
    worstTrade: Math.min(...returns),
  };
}


// ═══════════════════════════════════════════════════════════════
// MEASURE ALL ACTIVE FILTERS
// ═══════════════════════════════════════════════════════════════

async function measureAllFilters() {
  const client = await pool.connect();
  try {
    await ensureImpactSchema(client);
    const { rows: filters } = await client.query(
      `SELECT id FROM board_filters WHERE active = true ORDER BY id`
    );
    
    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  FILTER IMPACT MEASUREMENT — ${filters.length} active filter(s)           ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
    
    const results = [];
    for (const f of filters) {
      const impact = await measureFilterImpact(f.id);
      results.push(impact);
    }
    
    return results;
  } finally {
    client.release();
  }
}


// ═══════════════════════════════════════════════════════════════
// FORMAT FOR BOARD MEETING BRIEFING
// ═══════════════════════════════════════════════════════════════

export function formatImpactForBriefing(impactData) {
  if (!impactData || !Array.isArray(impactData)) return '';
  
  let text = '\n📊 FILTER IMPACT ASSESSMENT:\n';
  for (const impact of impactData) {
    const emoji = impact.verdict === 'POSITIVE' ? '✅' : impact.verdict === 'NEGATIVE' ? '❌' : '⚪';
    text += `  ${emoji} ${impact.feature} (Filter #${impact.filter_id}):\n`;
    text += `    Verdict: ${impact.verdict} over ${impact.period_hours}h\n`;
    text += `    Passed:  ${impact.passed.count} trades, avg ${impact.passed.avgReturn.toFixed(3)}%, WR ${impact.passed.winRate.toFixed(1)}%\n`;
    text += `    Blocked: ${impact.blocked.count} trades, avg ${impact.blocked.avgReturn.toFixed(3)}%, WR ${impact.blocked.winRate.toFixed(1)}%\n`;
    text += `    Delta: ${impact.improvement.avg_return_delta > 0 ? '+' : ''}${impact.improvement.avg_return_delta.toFixed(4)}% per trade\n`;
    text += `    Net saved: ${impact.improvement.saved_cumulative_return > 0 ? '+' : ''}${impact.improvement.saved_cumulative_return.toFixed(2)}%\n`;
  }
  return text;
}


// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export { measureFilterImpact, measureAllFilters, ensureImpactSchema, checkWouldBlock, computeStats };

// CLI mode
if (process.argv[1] && process.argv[1].includes('filter-impact')) {
  const filterId = process.argv[2] ? parseInt(process.argv[2]) : null;
  
  if (filterId) {
    measureFilterImpact(filterId)
      .then(r => { console.log('\nDone.'); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  } else {
    measureAllFilters()
      .then(r => { console.log('\nAll done.'); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  }
}
