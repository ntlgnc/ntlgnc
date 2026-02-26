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

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
