import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * GET /api/signals/mtm?tf=all|1m|1h|1d
 *
 * Returns a proper mark-to-market equity curve.
 *
 * For each MTM snapshot timestamp:
 *   - cumClosedReturn: sum of all closed trade returns up to that time
 *   - unrealisedReturn: sum of unrealised P&L across all open positions at that snapshot
 *   - totalReturn: cumClosedReturn + unrealisedReturn (the true portfolio value)
 *
 * This gives a smooth, realistic equity curve that reflects daily P&L movement
 * of open positions without modifying any trade records.
 *
 * Returns: { series: [{ time, totalReturn, closedReturn, unrealisedReturn, openPositions }] }
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const tf = url.searchParams.get("tf") || "all";

  const client = await pool.connect();
  try {
    // Determine barMinutes filter
    let barFilter = "";
    const barParams: number[] = [];
    if (tf === "1m") { barFilter = "AND bar_minutes = 1"; }
    else if (tf === "1h") { barFilter = "AND bar_minutes = 60"; }
    else if (tf === "1d") { barFilter = "AND bar_minutes = 1440"; }

    // 1. Get all MTM snapshot timestamps (grouped)
    let mtmSnapshots: any[] = [];
    try {
      const { rows } = await client.query(`
        SELECT snapshot_at as time,
               SUM(unrealised_pct) as total_unrealised,
               COUNT(*) as open_count
        FROM signal_mtm
        WHERE 1=1 ${barFilter}
        GROUP BY snapshot_at
        ORDER BY snapshot_at ASC
      `);
      mtmSnapshots = rows;
    } catch {
      // Table may not exist yet
    }

    // 2. Get all closed signals with their close times, ordered by closedAt
    let stratFilter = "";
    if (tf === "1m") stratFilter = `AND st."barMinutes" = 1`;
    else if (tf === "1h") stratFilter = `AND st."barMinutes" = 60`;
    else if (tf === "1d") stratFilter = `AND st."barMinutes" = 1440`;

    const { rows: closedSignals } = await client.query(`
      SELECT s."returnPct", s."closedAt"
      FROM "FracmapSignal" s
      JOIN "FracmapStrategy" st ON s."strategyId" = st.id
      WHERE s.status = 'closed' AND s."returnPct" IS NOT NULL
        AND s."closedAt" IS NOT NULL AND st.active = true ${stratFilter}
      ORDER BY s."closedAt" ASC
    `);

    // Build cumulative closed returns timeline
    let cumClosed = 0;
    const closedTimeline: { time: number; cumClosed: number }[] = [];
    for (const sig of closedSignals) {
      cumClosed += parseFloat(sig.returnPct) || 0;
      closedTimeline.push({
        time: new Date(sig.closedAt).getTime(),
        cumClosed,
      });
    }
    const totalClosedReturn = cumClosed;

    // 3. Build the MTM equity curve
    // For each snapshot, find cumClosed at that point + unrealised at that point
    const series: any[] = [];

    if (mtmSnapshots.length === 0) {
      // No MTM data yet — return closed-only points
      for (const pt of closedTimeline) {
        series.push({
          time: new Date(pt.time).toISOString(),
          totalReturn: Math.round(pt.cumClosed * 100) / 100,
          closedReturn: Math.round(pt.cumClosed * 100) / 100,
          unrealisedReturn: 0,
          openPositions: 0,
        });
      }
    } else {
      // Include closed events as points (with interpolated unrealised = 0 before first MTM)
      // Then include MTM snapshots with interpolated cumClosed
      
      // Merge both timelines into one sorted series
      type RawPoint = { time: number; type: "closed" | "mtm"; cumClosed?: number; unrealised?: number; openCount?: number };
      const allPoints: RawPoint[] = [];

      for (const pt of closedTimeline) {
        allPoints.push({ time: pt.time, type: "closed", cumClosed: pt.cumClosed });
      }
      for (const snap of mtmSnapshots) {
        allPoints.push({
          time: new Date(snap.time).getTime(),
          type: "mtm",
          unrealised: parseFloat(snap.total_unrealised) || 0,
          openCount: parseInt(snap.open_count) || 0,
        });
      }

      // Sort by time
      allPoints.sort((a, b) => a.time - b.time);

      // Walk through, carrying forward the latest cumClosed and latest unrealised
      let runningClosed = 0;
      let runningUnrealised = 0;
      let runningOpenCount = 0;

      for (const pt of allPoints) {
        if (pt.type === "closed") {
          runningClosed = pt.cumClosed!;
        } else {
          runningUnrealised = pt.unrealised!;
          runningOpenCount = pt.openCount!;
        }

        series.push({
          time: new Date(pt.time).toISOString(),
          totalReturn: Math.round((runningClosed + runningUnrealised) * 100) / 100,
          closedReturn: Math.round(runningClosed * 100) / 100,
          unrealisedReturn: Math.round(runningUnrealised * 100) / 100,
          openPositions: runningOpenCount,
        });
      }
    }

    return NextResponse.json({
      series,
      summary: {
        totalPoints: series.length,
        closedSignals: closedSignals.length,
        closedReturn: Math.round(totalClosedReturn * 100) / 100,
        mtmSnapshots: mtmSnapshots.length,
        latestUnrealised: mtmSnapshots.length > 0
          ? Math.round((parseFloat(mtmSnapshots[mtmSnapshots.length - 1].total_unrealised) || 0) * 100) / 100
          : 0,
        tf,
      },
    });
  } finally {
    client.release();
  }
}
