import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

export const dynamic = "force-dynamic";

// Ensure table exists
async function ensureTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS research_log (
      id              SERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      report_type     TEXT NOT NULL DEFAULT 'hourly_scan',
      title           TEXT NOT NULL,
      winner_strategy JSONB,
      oos_avg_sharpe  FLOAT,
      oos_consistency TEXT,
      oos_avg_winrate FLOAT,
      oos_avg_pf      FLOAT,
      oos_avg_return  FLOAT,
      per_coin_oos    JSONB,
      regime_features JSONB,
      net_position    JSONB,
      robustness      JSONB,
      findings        TEXT,
      recommendations TEXT,
      evolution_round INTEGER,
      committee_decision TEXT,
      active_filters  JSONB,
      bar_minutes     INTEGER DEFAULT 1,
      cycle_min       INTEGER DEFAULT 10,
      cycle_max       INTEGER DEFAULT 100,
      split_pct       INTEGER DEFAULT 50,
      total_bars      INTEGER,
      total_signals   INTEGER
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_research_log_created ON research_log(created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_research_log_type ON research_log(report_type, created_at DESC)`);
}

// GET — list reports
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const offset = parseInt(searchParams.get("offset") || "0");
  const reportType = searchParams.get("type") || null;
  const id = searchParams.get("id") || null;

  const client = await pool.connect();
  try {
    await ensureTable(client);

    // Single report by id
    if (id) {
      const { rows } = await client.query(`SELECT * FROM research_log WHERE id = $1`, [id]);
      return NextResponse.json({ report: rows[0] || null });
    }

    // List
    let query = `SELECT id, created_at, report_type, title, oos_avg_sharpe, oos_consistency, 
                        oos_avg_winrate, oos_avg_pf, oos_avg_return, bar_minutes, 
                        total_signals, evolution_round, committee_decision,
                        net_position, robustness
                 FROM research_log`;
    const params: any[] = [];
    if (reportType) {
      query += ` WHERE report_type = $1`;
      params.push(reportType);
    }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await client.query(query, params);

    // Also get total count
    let countQ = `SELECT COUNT(*) as total FROM research_log`;
    if (reportType) countQ += ` WHERE report_type = '${reportType}'`;
    const { rows: countRows } = await client.query(countQ);

    return NextResponse.json({ reports: rows, total: parseInt(countRows[0]?.total || "0") });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

// POST — create new report
export async function POST(req: NextRequest) {
  const body = await req.json();
  const client = await pool.connect();
  try {
    await ensureTable(client);

    const { rows } = await client.query(`
      INSERT INTO research_log (
        report_type, title, winner_strategy, oos_avg_sharpe, oos_consistency,
        oos_avg_winrate, oos_avg_pf, oos_avg_return, per_coin_oos,
        regime_features, net_position, robustness, findings, recommendations,
        active_filters, bar_minutes, cycle_min, cycle_max, split_pct,
        total_bars, total_signals
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      ) RETURNING *
    `, [
      body.report_type || "hourly_scan",
      body.title || `Scan ${new Date().toISOString().slice(0, 16)}`,
      JSON.stringify(body.winner_strategy || null),
      body.oos_avg_sharpe || null,
      body.oos_consistency || null,
      body.oos_avg_winrate || null,
      body.oos_avg_pf || null,
      body.oos_avg_return || null,
      JSON.stringify(body.per_coin_oos || null),
      JSON.stringify(body.regime_features || null),
      JSON.stringify(body.net_position || null),
      JSON.stringify(body.robustness || null),
      body.findings || null,
      body.recommendations || null,
      JSON.stringify(body.active_filters || null),
      body.bar_minutes || 1,
      body.cycle_min || 10,
      body.cycle_max || 100,
      body.split_pct || 50,
      body.total_bars || null,
      body.total_signals || null,
    ]);

    return NextResponse.json({ report: rows[0] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

// PATCH — update committee decision
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const client = await pool.connect();
  try {
    await ensureTable(client);
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    if (body.committee_decision !== undefined) {
      sets.push(`committee_decision = $${idx++}`);
      vals.push(body.committee_decision);
    }
    if (body.evolution_round !== undefined) {
      sets.push(`evolution_round = $${idx++}`);
      vals.push(body.evolution_round);
    }

    if (sets.length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

    vals.push(body.id);
    const { rows } = await client.query(
      `UPDATE research_log SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`, vals
    );

    return NextResponse.json({ report: rows[0] || null });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
