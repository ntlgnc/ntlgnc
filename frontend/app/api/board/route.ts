import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const dynamic = "force-dynamic";

async function ensureTables(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_meetings (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      round_number INTEGER NOT NULL, chair_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'started',
      agenda JSONB, context JSONB, proposals JSONB, debate JSONB, votes JSONB,
      decision TEXT, motion_type TEXT, motion_details JSONB, backtest_result JSONB,
      deployed BOOLEAN DEFAULT false, impact_review JSONB, duration_ms INTEGER, total_tokens INTEGER DEFAULT 0
    )
  `);
  try { await client.query(`ALTER TABLE board_meetings ADD COLUMN IF NOT EXISTS follow_up_target TEXT`); } catch {}
  try { await client.query(`ALTER TABLE board_meetings ADD COLUMN IF NOT EXISTS follow_up_met BOOLEAN`); } catch {}
  try { await client.query(`ALTER TABLE board_meetings ADD COLUMN IF NOT EXISTS digest TEXT`); } catch {}
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_filters (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      active BOOLEAN DEFAULT true, filter_type TEXT NOT NULL, feature TEXT NOT NULL,
      conditions JSONB NOT NULL, rationale TEXT, proposed_by TEXT,
      meeting_id INTEGER, backtest_sharpe FLOAT, live_sharpe FLOAT,
      trades_filtered INTEGER DEFAULT 0, trades_passed INTEGER DEFAULT 0
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_coin_overrides (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      active BOOLEAN DEFAULT true, symbol TEXT NOT NULL, override_type TEXT NOT NULL,
      parameters JSONB NOT NULL, rationale TEXT, meeting_id INTEGER
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_research_log (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      research_type TEXT NOT NULL, hypothesis TEXT, methodology TEXT,
      result JSONB, conclusion TEXT, status TEXT DEFAULT 'active',
      meeting_id INTEGER, killed_by TEXT, killed_reason TEXT
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS board_topic_requests (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      requested_by TEXT NOT NULL, meeting_id INTEGER,
      topic TEXT NOT NULL, rationale TEXT, priority TEXT DEFAULT 'NORMAL',
      status TEXT DEFAULT 'pending', addressed_in INTEGER
    )
  `);
}

// GET — list meetings, filters, overrides, or single meeting detail
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "meetings";
  const client = await pool.connect();

  try {
    await ensureTables(client);

    if (action === "meetings") {
      const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 100);
      const { rows } = await client.query(
        `SELECT id, created_at, round_number, chair_id, phase, decision, motion_type,
                deployed, duration_ms, total_tokens, votes
         FROM board_meetings ORDER BY round_number DESC LIMIT $1`, [limit]
      );
      return NextResponse.json({ meetings: rows });
    }

    if (action === "meeting") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { rows } = await client.query(`SELECT * FROM board_meetings WHERE id = $1`, [id]);
      return NextResponse.json({ meeting: rows[0] || null });
    }

    if (action === "filters") {
      const activeOnly = searchParams.get("active") !== "false";
      const where = activeOnly ? "WHERE active = true" : "";
      const { rows } = await client.query(
        `SELECT * FROM board_filters ${where} ORDER BY created_at DESC`
      );
      return NextResponse.json({ filters: rows });
    }

    if (action === "overrides") {
      const { rows } = await client.query(
        `SELECT * FROM board_coin_overrides WHERE active = true ORDER BY symbol`
      );
      return NextResponse.json({ overrides: rows });
    }

    if (action === "directives") {
      const { rows: filters } = await client.query(
        `SELECT * FROM board_filters WHERE active = true ORDER BY created_at`
      );
      const { rows: overrides } = await client.query(
        `SELECT * FROM board_coin_overrides WHERE active = true ORDER BY symbol`
      );
      const excludedCoins = overrides.filter((o: any) => o.override_type === 'exclude').map((o: any) => o.symbol);
      const paramOverrides = overrides.filter((o: any) => o.override_type === 'parameters');
      return NextResponse.json({ filters, excludedCoins, parameterOverrides: paramOverrides });
    }

    if (action === "research") {
      const { rows } = await client.query(
        `SELECT * FROM board_research_log ORDER BY created_at DESC LIMIT 20`
      );
      return NextResponse.json({ research: rows });
    }

    if (action === "topics") {
      const status = searchParams.get("status") || "pending";
      const { rows } = await client.query(
        `SELECT * FROM board_topic_requests WHERE status = $1 ORDER BY 
         CASE priority WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 WHEN 'LOW' THEN 3 END,
         created_at ASC`,
        [status]
      );
      return NextResponse.json({ topics: rows });
    }

    if (action === "operator-message") {
      try {
        const { rows } = await client.query(
          `SELECT id, message, created_at, active, expires_at FROM board_operator_messages 
           WHERE active = true AND (expires_at IS NULL OR expires_at > now())
           ORDER BY created_at DESC LIMIT 1`
        );
        return NextResponse.json({ message: rows[0] || null });
      } catch {
        return NextResponse.json({ message: null });
      }
    }

    if (action === "filter-impact") {
      const filterId = searchParams.get("id");
      if (filterId) {
        // Single filter impact
        const { rows: [filter] } = await client.query(
          `SELECT id, feature, active, created_at, trades_filtered, trades_passed, 
                  impact_data, impact_measured_at
           FROM board_filters WHERE id = $1`, [filterId]
        );
        return NextResponse.json({ filter: filter || null });
      }
      
      // All filters with impact data
      const { rows } = await client.query(
        `SELECT id, feature, active, created_at, trades_filtered, trades_passed,
                impact_data, impact_measured_at, rationale
         FROM board_filters ORDER BY created_at DESC`
      );
      
      // Also get signal counts since each filter was deployed
      for (const f of rows) {
        try {
          const { rows: [counts] } = await client.query(`
            SELECT 
              COUNT(*) FILTER (WHERE status = 'closed') as passed_closed,
              COUNT(*) FILTER (WHERE status IN ('filtered', 'filtered_closed')) as blocked_total,
              COUNT(*) FILTER (WHERE status = 'filtered_closed') as blocked_closed,
              AVG("returnPct") FILTER (WHERE status = 'closed') as passed_avg_return,
              AVG("returnPct") FILTER (WHERE status = 'filtered_closed') as blocked_avg_return,
              SUM("returnPct") FILTER (WHERE status = 'closed') as passed_total_return,
              SUM("returnPct") FILTER (WHERE status = 'filtered_closed') as blocked_total_return,
              COUNT(*) FILTER (WHERE status = 'closed' AND "returnPct" > 0) as passed_wins,
              COUNT(*) FILTER (WHERE status = 'filtered_closed' AND "returnPct" > 0) as blocked_wins
            FROM "FracmapSignal"
            WHERE "createdAt" >= $1
          `, [f.created_at]);
          f.live_stats = counts;
        } catch {}
      }
      
      return NextResponse.json({ filters: rows });
    }

    if (action === "stats") {
      const { rows: [stats] } = await client.query(`
        SELECT COUNT(*) as total_meetings,
               COUNT(*) FILTER (WHERE deployed = true) as deployed,
               COUNT(*) FILTER (WHERE decision LIKE 'PASSED%') as passed,
               COUNT(*) FILTER (WHERE decision LIKE 'FAILED%') as failed,
               SUM(total_tokens) as total_tokens,
               AVG(duration_ms) as avg_duration_ms,
               MAX(round_number) as latest_round
        FROM board_meetings
      `);
      const { rows: [filterStats] } = await client.query(`
        SELECT COUNT(*) FILTER (WHERE active = true) as active_filters,
               COUNT(*) FILTER (WHERE active = false) as inactive_filters,
               SUM(trades_filtered) as total_filtered,
               SUM(trades_passed) as total_passed
        FROM board_filters
      `);
      return NextResponse.json({ meetingStats: stats, filterStats });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

// POST — manual filter management, trigger meeting
function wouldBlock(signal: any, snap: any, feature: string, conditions: any): boolean {
  if (!conditions || !snap) return false;
  if (conditions.rules) {
    for (const rule of conditions.rules) {
      if (rule.direction && signal.direction !== rule.direction) continue;
      const key = rule.feature || feature;
      const val = snap[key];
      if (val == null) continue;
      if (rule.min !== undefined && val < rule.min) return true;
      if (rule.max !== undefined && val > rule.max) return true;
    }
  }
  const val = snap[conditions.feature || feature];
  if (val == null) return false;
  if (conditions.min !== undefined && val < conditions.min) return true;
  if (conditions.max !== undefined && val > conditions.max) return true;
  return false;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const action = body.action;
  const client = await pool.connect();

  try {
    await ensureTables(client);

    if (action === "addFilter") {
      const { feature, conditions, rationale } = body;
      if (!feature || !conditions) return NextResponse.json({ error: "feature and conditions required" }, { status: 400 });
      const { rows } = await client.query(
        `INSERT INTO board_filters (filter_type, feature, conditions, rationale, proposed_by)
         VALUES ('manual', $1, $2, $3, 'admin') RETURNING *`,
        [feature, JSON.stringify(conditions), rationale || 'Manually added']
      );
      return NextResponse.json({ filter: rows[0] });
    }

    if (action === "toggleFilter") {
      const { id, active } = body;
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { rows } = await client.query(
        `UPDATE board_filters SET active = $1, updated_at = now() WHERE id = $2 RETURNING *`,
        [active ?? false, id]
      );
      return NextResponse.json({ filter: rows[0] });
    }

    if (action === "deleteFilter") {
      const { id } = body;
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      await client.query(`DELETE FROM board_filters WHERE id = $1`, [id]);
      return NextResponse.json({ deleted: true });
    }

    if (action === "addOverride") {
      const { symbol, override_type, parameters, rationale } = body;
      if (!symbol || !override_type) return NextResponse.json({ error: "symbol and override_type required" }, { status: 400 });
      const { rows } = await client.query(
        `INSERT INTO board_coin_overrides (symbol, override_type, parameters, rationale)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [symbol, override_type, JSON.stringify(parameters || {}), rationale || '']
      );
      return NextResponse.json({ override: rows[0] });
    }

    if (action === "removeOverride") {
      const { id } = body;
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      await client.query(`UPDATE board_coin_overrides SET active = false WHERE id = $1`, [id]);
      return NextResponse.json({ removed: true });
    }

    if (action === "measureImpact") {
      const { id } = body;
      if (!id) return NextResponse.json({ error: "filter id required" }, { status: 400 });
      
      // Get filter
      const { rows: [filter] } = await client.query(
        `SELECT * FROM board_filters WHERE id = $1`, [id]
      );
      if (!filter) return NextResponse.json({ error: "Filter not found" }, { status: 404 });
      
      const conditions = typeof filter.conditions === 'string' ? JSON.parse(filter.conditions) : filter.conditions;
      
      // Get all closed signals since filter deployment
      const { rows: signals } = await client.query(`
        SELECT id, symbol, direction, "entryPrice", "exitPrice", "returnPct", 
               status, "createdAt", filtered_by, regime_snapshot
        FROM "FracmapSignal"
        WHERE "createdAt" >= $1 AND status IN ('closed', 'filtered_closed')
        ORDER BY "createdAt"
      `, [filter.created_at]);
      
      // Categorize: passed vs would-have-been-blocked
      const passed: any[] = [];
      const blocked: any[] = [];
      
      for (const sig of signals) {
        if (sig.filtered_by === id) {
          blocked.push(sig);
        } else if (sig.regime_snapshot) {
          const snap = typeof sig.regime_snapshot === 'string' ? JSON.parse(sig.regime_snapshot) : sig.regime_snapshot;
          if (wouldBlock(sig, snap, filter.feature, conditions)) {
            blocked.push(sig);
          } else {
            passed.push(sig);
          }
        } else {
          passed.push(sig);
        }
      }
      
      const stats = (arr: any[]) => {
        const rets = arr.filter((s: any) => s.returnPct != null).map((s: any) => s.returnPct);
        if (rets.length === 0) return { count: 0, avgReturn: 0, totalReturn: 0, winRate: 0, wins: 0 };
        const wins = rets.filter((r: number) => r > 0).length;
        const total = rets.reduce((a: number, b: number) => a + b, 0);
        return { count: rets.length, avgReturn: total / rets.length, totalReturn: total, winRate: (wins / rets.length) * 100, wins };
      };
      
      const passedStats = stats(passed);
      const blockedStats = stats(blocked);
      const periodHours = Math.round((Date.now() - new Date(filter.created_at).getTime()) / 3600000);
      
      const verdict = blockedStats.count === 0 ? 'NEUTRAL' :
        blockedStats.avgReturn < passedStats.avgReturn ? 'POSITIVE' :
        blockedStats.avgReturn > passedStats.avgReturn ? 'NEGATIVE' : 'NEUTRAL';
      
      const impact = {
        filter_id: id,
        feature: filter.feature,
        measured_at: new Date().toISOString(),
        period_start: filter.created_at,
        period_hours: periodHours,
        verdict,
        summary: { total_signals: signals.length, passed_count: passed.length, blocked_count: blocked.length },
        passed: passedStats,
        blocked: blockedStats,
        improvement: {
          avg_return_delta: passedStats.avgReturn - blockedStats.avgReturn,
          win_rate_delta: passedStats.winRate - blockedStats.winRate,
          saved_cumulative_return: blockedStats.avgReturn < 0 ? Math.abs(blockedStats.totalReturn) : -blockedStats.totalReturn,
        },
      };
      
      await client.query(
        `UPDATE board_filters SET impact_measured_at = now(), impact_data = $1,
                trades_passed = $2, trades_filtered = $3 WHERE id = $4`,
        [JSON.stringify(impact), passed.length, blocked.length, id]
      );
      
      return NextResponse.json({ impact });
    }

    if (action === "updateMeeting") {
      const { id, field, value } = body;
      if (!id || !field) return NextResponse.json({ error: "id and field required" }, { status: 400 });
      
      // Whitelist of editable fields
      const editableDirectFields = ["decision", "follow_up_target", "motion_type"];
      
      if (editableDirectFields.includes(field)) {
        await client.query(
          `UPDATE board_meetings SET ${field} = $1 WHERE id = $2`,
          [value, id]
        );
        return NextResponse.json({ updated: true, field });
      }
      
      // For JSON subfields inside proposals (briefing, key_issue, etc.)
      if (["briefing", "key_issue"].includes(field)) {
        // Read current proposals, patch the field, write back
        const { rows } = await client.query(`SELECT proposals FROM board_meetings WHERE id = $1`, [id]);
        if (rows.length === 0) return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
        let proposals = rows[0].proposals;
        if (typeof proposals === "string") proposals = JSON.parse(proposals);
        if (!proposals) proposals = {};
        
        if (field === "briefing") {
          // Handle both v1 (proposals.briefing) and v2 (proposals.situation.situation_summary)
          if (proposals.situation) {
            proposals.situation.situation_summary = value;
          } else {
            proposals.briefing = value;
          }
        } else if (field === "key_issue") {
          if (proposals.prioritised) {
            proposals.prioritised.selected_problem = value;
          } else {
            proposals.key_issue = value;
          }
        }
        
        await client.query(
          `UPDATE board_meetings SET proposals = $1 WHERE id = $2`,
          [JSON.stringify(proposals), id]
        );
        return NextResponse.json({ updated: true, field });
      }
      
      return NextResponse.json({ error: `Field '${field}' is not editable` }, { status: 400 });
    }

    if (action === "approveMotion") {
      const { id } = body;
      if (!id) return NextResponse.json({ error: "request id required" }, { status: 400 });
      
      const { rows: [req] } = await client.query(
        `SELECT * FROM board_requests WHERE id = $1 AND status = 'pending_approval'`, [id]
      );
      if (!req) return NextResponse.json({ error: "Request not found or already processed" }, { status: 404 });
      
      const params = typeof req.parameters === 'string' ? JSON.parse(req.parameters) : req.parameters;
      const motion = params.motion;
      const details = params.details || motion?.details || {};
      
      // Actually execute the motion now
      let result = 'Approved but deploy type not recognized';
      if (req.request_type === 'EXCLUDE_COIN' && details.symbol) {
        await client.query(
          `INSERT INTO board_coin_overrides (symbol, override_type, parameters, rationale, meeting_id)
           VALUES ($1, 'exclude', $2, $3, $4)`,
          [details.symbol, JSON.stringify({ excluded: true, expires: new Date(Date.now() + 24*60*60*1000).toISOString() }),
           motion?.hypothesis || 'Approved by human', req.meeting_id]
        );
        result = `Coin ${details.symbol} excluded (24h auto-expiry)`;
      } else if (req.request_type === 'INCLUDE_COIN' && details.symbol) {
        await client.query(
          `UPDATE board_coin_overrides SET active = false WHERE symbol = $1 AND override_type = 'exclude' AND active = true`,
          [details.symbol]
        );
        result = `Coin ${details.symbol} re-included`;
      } else if (req.request_type === 'EMERGENCY_HALT') {
        result = 'Emergency halt acknowledged — implement manually';
      } else if (req.request_type === 'STRATEGY_PARAMETER') {
        result = 'Strategy parameter change acknowledged — implement manually';
      }
      
      await client.query(
        `UPDATE board_requests SET status = 'approved', completed_at = now(), result_summary = $1 WHERE id = $2`,
        [result, id]
      );
      
      return NextResponse.json({ approved: true, result });
    }

    if (action === "rejectMotion") {
      const { id, reason } = body;
      if (!id) return NextResponse.json({ error: "request id required" }, { status: 400 });
      
      await client.query(
        `UPDATE board_requests SET status = 'rejected', completed_at = now(), result_summary = $1 WHERE id = $2`,
        [reason || 'Rejected by human operator', id]
      );
      
      return NextResponse.json({ rejected: true });
    }

    if (action === "pendingApprovals") {
      const { rows } = await client.query(
        `SELECT r.*, m.round_number, m.chair_id 
         FROM board_requests r 
         LEFT JOIN board_meetings m ON r.meeting_id = m.id
         WHERE r.status = 'pending_approval' 
         ORDER BY r.created_at DESC`
      );
      return NextResponse.json({ approvals: rows });
    }

    if (action === "triggerMeeting") {
      // Release the DB client — meeting will use its own
      client.release();
      
      const fs = await import('fs');
      const path = await import('path');
      const cwd = process.cwd();
      const triggerFile = path.join(cwd, 'backend', 'trigger-meeting.flag');
      const resultFile = triggerFile + '.result';
      
      // Clean up any stale result file
      try { fs.unlinkSync(resultFile); } catch {}
      
      // Write trigger flag — the running llm-board process will pick it up
      fs.writeFileSync(triggerFile, new Date().toISOString());
      
      // Poll for result (llm-board writes trigger-meeting.flag.result when done)
      const startTime = Date.now();
      const TIMEOUT = 280000; // 4min 40s (leave margin for the 5min fetch timeout)
      
      return new Promise<Response>((resolve) => {
        const poll = setInterval(() => {
          try {
            if (fs.existsSync(resultFile)) {
              const data = fs.readFileSync(resultFile, 'utf8');
              clearInterval(poll);
              try { fs.unlinkSync(resultFile); } catch {}
              try {
                const result = JSON.parse(data);
                resolve(NextResponse.json({ meeting: result }));
              } catch {
                resolve(NextResponse.json({ meeting: null, logs: data }));
              }
              return;
            }
          } catch {}
          
          if (Date.now() - startTime > TIMEOUT) {
            clearInterval(poll);
            resolve(NextResponse.json({ 
              meeting: null, 
              logs: "Meeting triggered but still running. Check the Board tab for results." 
            }));
          }
        }, 3000);
      });
    }

    if (action === "setOperatorMessage") {
      const msg = body.message?.trim();
      if (!msg) {
        // Clear all active messages
        await client.query(`UPDATE board_operator_messages SET active = false WHERE active = true`);
        return NextResponse.json({ ok: true, cleared: true });
      }
      // Deactivate old messages
      await client.query(`UPDATE board_operator_messages SET active = false WHERE active = true`);
      // Insert new
      const expiresHours = body.expiresHours || null;
      const { rows } = await client.query(
        `INSERT INTO board_operator_messages (message, active, expires_at) 
         VALUES ($1, true, $2) RETURNING id, created_at`,
        [msg, expiresHours ? `now() + interval '${parseInt(expiresHours)} hours'` : null]
      );
      return NextResponse.json({ ok: true, id: rows[0]?.id });
    }

    if (action === "clearOperatorMessage") {
      await client.query(`UPDATE board_operator_messages SET active = false WHERE active = true`);
      return NextResponse.json({ ok: true, cleared: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
