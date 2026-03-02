import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Filter Matrix API
 * 
 * Table: filter_matrix
 *   strategy_id, feature_key, bucket_label, direction, mode ('auto'|'locked_block'|'locked_pass')
 * 
 * Table: filter_matrix_board_votes  
 *   strategy_id, feature_key, bucket_label, direction, blocked (boolean), voted_at, voted_by (filter meeting #)
 * 
 * Effective state:
 *   locked_block → always blocked
 *   locked_pass  → always passes
 *   auto         → defers to board_votes (blocked=true means blocked)
 */

async function ensureTables(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS filter_matrix (
      id SERIAL PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      bucket_label TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
      mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'locked_block', 'locked_pass')),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(strategy_id, feature_key, bucket_label, direction)
    )
  `);
  // Add mode column if table exists but column doesn't
  try {
    await client.query(`ALTER TABLE filter_matrix ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'auto'`);
    await client.query(`ALTER TABLE filter_matrix ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`);
  } catch {}

  await client.query(`
    CREATE TABLE IF NOT EXISTS filter_matrix_board_votes (
      id SERIAL PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      bucket_label TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
      blocked BOOLEAN NOT NULL DEFAULT false,
      voted_at TIMESTAMPTZ DEFAULT now(),
      voted_by TEXT,
      UNIQUE(strategy_id, feature_key, bucket_label, direction)
    )
  `);
}

export async function GET(req: NextRequest) {
  const client = await pool.connect();
  try {
    await ensureTables(client);

    const { rows: strategies } = await client.query(`
      SELECT DISTINCT ON ("barMinutes") id, name, "barMinutes", active
      FROM "FracmapStrategy"
      WHERE active = true AND "barMinutes" IN (1, 60, 1440)
      ORDER BY "barMinutes", "updatedAt" DESC
    `);

    // Load matrix state (user overrides)
    const { rows: cells } = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, mode FROM filter_matrix`
    );
    const matrix: Record<string, any> = {};
    for (const cell of cells) {
      const sid = cell.strategy_id;
      if (!matrix[sid]) matrix[sid] = {};
      if (!matrix[sid][cell.feature_key]) matrix[sid][cell.feature_key] = {};
      if (!matrix[sid][cell.feature_key][cell.bucket_label]) matrix[sid][cell.feature_key][cell.bucket_label] = {};
      matrix[sid][cell.feature_key][cell.bucket_label][cell.direction] = cell.mode;
    }

    // If matrix is empty, prepopulate from current live filters
    if (cells.length === 0 && strategies.length > 0) {
      for (const strat of strategies) {
        const sid = strat.id;
        matrix[sid] = {
          posInRange: {
            "Bottom (<0.25)": { LONG: "locked_block" },
            "Top (>0.75)": { SHORT: "locked_block" },
          },
          volState: {
            "COMPRESSED": { LONG: "locked_block", SHORT: "locked_block" },
          },
          atrCompression: {
            "Compressed (<0.7)": { LONG: "locked_block", SHORT: "locked_block" },
          },
        };
      }
    }

    // Load board votes
    const { rows: votes } = await client.query(
      `SELECT strategy_id, feature_key, bucket_label, direction, blocked FROM filter_matrix_board_votes`
    );
    const boardVotes: Record<string, any> = {};
    for (const v of votes) {
      if (!boardVotes[v.strategy_id]) boardVotes[v.strategy_id] = {};
      if (!boardVotes[v.strategy_id][v.feature_key]) boardVotes[v.strategy_id][v.feature_key] = {};
      if (!boardVotes[v.strategy_id][v.feature_key][v.bucket_label]) boardVotes[v.strategy_id][v.feature_key][v.bucket_label] = {};
      boardVotes[v.strategy_id][v.feature_key][v.bucket_label][v.direction] = v.blocked;
    }

    // Load scorecard data (SR + rho)
    let scorecardMap: Record<number, any> = {};
    let rhoMap: Record<number, any> = {};
    try {
      const { rows: sc } = await client.query(`
        SELECT feature_key, bucket_index, bucket_label, direction_filter,
               oos_sharpe, oos_win_rate, oos_trades, bar_minutes, rho, confidence
        FROM regime_scorecard
        WHERE direction_filter IN ('long', 'short')
      `);
      for (const r of sc) {
        if (!scorecardMap[r.bar_minutes]) scorecardMap[r.bar_minutes] = {};
        if (!scorecardMap[r.bar_minutes][r.feature_key]) scorecardMap[r.bar_minutes][r.feature_key] = {};
        if (!scorecardMap[r.bar_minutes][r.feature_key][r.bucket_index])
          scorecardMap[r.bar_minutes][r.feature_key][r.bucket_index] = {};
        scorecardMap[r.bar_minutes][r.feature_key][r.bucket_index][r.direction_filter] = r.oos_sharpe;

        // Rho is per-feature (same across buckets within a direction), store per bucket too for display
        if (!rhoMap[r.bar_minutes]) rhoMap[r.bar_minutes] = {};
        if (!rhoMap[r.bar_minutes][r.feature_key]) rhoMap[r.bar_minutes][r.feature_key] = {};
        if (!rhoMap[r.bar_minutes][r.feature_key][r.bucket_index])
          rhoMap[r.bar_minutes][r.feature_key][r.bucket_index] = {};
        rhoMap[r.bar_minutes][r.feature_key][r.bucket_index][r.direction_filter] = {
          rho: r.rho != null ? parseFloat(r.rho) : null,
          confidence: r.confidence,
        };
      }
    } catch {}

    return NextResponse.json({ strategies, matrix, boardVotes, scorecard: scorecardMap, rhoMap });
  } finally {
    client.release();
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.action !== "save") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const matrix = body.matrix;
  if (!matrix || typeof matrix !== "object") {
    return NextResponse.json({ error: "Invalid matrix" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await ensureTables(client);
    await client.query("BEGIN");

    // Clear and rewrite all matrix entries
    await client.query("DELETE FROM filter_matrix");

    let count = 0;
    for (const [stratId, features] of Object.entries(matrix)) {
      for (const [featureKey, buckets] of Object.entries(features as any)) {
        for (const [bucketLabel, directions] of Object.entries(buckets as any)) {
          for (const [direction, mode] of Object.entries(directions as any)) {
            if (mode && mode !== "auto") {
              // Only store non-auto entries (auto is the default)
              await client.query(
                `INSERT INTO filter_matrix (strategy_id, feature_key, bucket_label, direction, mode)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (strategy_id, feature_key, bucket_label, direction) 
                 DO UPDATE SET mode = $5, updated_at = now()`,
                [stratId, featureKey, bucketLabel, direction, mode]
              );
              count++;
            }
          }
        }
      }
    }

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    client.release();
  }
}
