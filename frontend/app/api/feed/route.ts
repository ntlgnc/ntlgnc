import { NextResponse } from "next/server";
import { Client } from "pg";

/**
 * GET /api/feed?userId=xxx           → returns feed items + signals + scores
 * GET /api/feed?userId=xxx&format=json → returns full JSON export for external consumption
 * POST /api/feed                      → add/remove/update feed items
 */

async function getClient(): Promise<Client> {
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL not set");
  const client = new Client({ connectionString: conn });
  await client.connect();
  return client;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  const format = url.searchParams.get("format");

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const client = await getClient();
  try {
    // Ensure tables exist (safe no-op if already created)
    await ensureTables(client);

    // Feed items
    const { rows: items } = await client.query(
      `SELECT id, symbol, models, horizon, inverse, label, "createdAt"
       FROM "FeedConfig" WHERE "userId" = $1 ORDER BY "createdAt" ASC`,
      [userId]
    );

    // Recent signals (last 100)
    const { rows: signals } = await client.query(
      `SELECT id, "feedConfigId", symbol, direction, confidence, "entryPrice",
              models, horizon, "createdAt", "exitPrice", "returnPct", "resolvedAt"
       FROM "Signal" WHERE "userId" = $1
       ORDER BY "createdAt" DESC LIMIT 100`,
      [userId]
    );

    // Scores
    const { rows: scoreRows } = await client.query(
      `SELECT period, "periodKey", signals, wins, "totalReturnPct"
       FROM "SignalScore" WHERE "userId" = $1
       ORDER BY "updatedAt" DESC`,
      [userId]
    );

    // Running total from all signals
    const { rows: totalRow } = await client.query(
      `SELECT COUNT(*) as signals,
              SUM(CASE WHEN "returnPct" > 0 THEN 1 ELSE 0 END) as wins,
              COALESCE(SUM("returnPct"), 0) as "totalReturnPct"
       FROM "Signal" WHERE "userId" = $1 AND "resolvedAt" IS NOT NULL`,
      [userId]
    );

    const scores = buildScores(scoreRows, totalRow[0]);

    const result = { items, signals, scores };

    // JSON format adds metadata
    if (format === "json") {
      return NextResponse.json({
        meta: {
          userId,
          exportedAt: new Date().toISOString(),
          feedItems: items.length,
          activeSignals: signals.filter((s: any) => !s.resolvedAt).length,
        },
        feedConfigs: items,
        signals: {
          active: signals.filter((s: any) => !s.resolvedAt),
          resolved: signals.filter((s: any) => s.resolvedAt),
        },
        performance: scores,
      }, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store",
        },
      });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message, items: [], signals: [], scores: defaultScores() }, { status: 200 });
  } finally {
    await client.end();
  }
}

export async function POST(req: Request) {
  const body = await req.json();
  const { userId, action } = body;

  if (!userId || !action) {
    return NextResponse.json({ error: "userId and action required" }, { status: 400 });
  }

  const client = await getClient();
  try {
    await ensureTables(client);

    if (action === "add") {
      const { item } = body;
      if (!item?.symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

      const { rows } = await client.query(
        `INSERT INTO "FeedConfig" ("userId", symbol, models, horizon, inverse, label)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [userId, item.symbol, item.models || [], item.horizon || "all", item.inverse || false, item.label || null]
      );

      return NextResponse.json({ ok: true, id: rows[0].id });
    }

    if (action === "remove") {
      const { itemId } = body;
      await client.query(
        `DELETE FROM "FeedConfig" WHERE id = $1 AND "userId" = $2`,
        [itemId, userId]
      );
      return NextResponse.json({ ok: true });
    }

    if (action === "update") {
      const { itemId, updates } = body;
      const fields: string[] = [];
      const vals: any[] = [];
      let idx = 1;

      if (updates.symbol) { fields.push(`symbol = $${idx++}`); vals.push(updates.symbol); }
      if (updates.models) { fields.push(`models = $${idx++}`); vals.push(updates.models); }
      if (updates.horizon) { fields.push(`horizon = $${idx++}`); vals.push(updates.horizon); }
      if (updates.inverse !== undefined) { fields.push(`inverse = $${idx++}`); vals.push(updates.inverse); }
      if (updates.label !== undefined) { fields.push(`label = $${idx++}`); vals.push(updates.label); }
      fields.push(`"updatedAt" = NOW()`);

      if (fields.length > 1) {
        vals.push(itemId, userId);
        await client.query(
          `UPDATE "FeedConfig" SET ${fields.join(", ")} WHERE id = $${idx++} AND "userId" = $${idx}`,
          vals
        );
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    await client.end();
  }
}

/* ═══ Helpers ═══ */

function buildScores(scoreRows: any[], totalRow: any) {
  const daily = scoreRows.find((r: any) => r.period === "day") || {};
  const weekly = scoreRows.find((r: any) => r.period === "week") || {};
  const monthly = scoreRows.find((r: any) => r.period === "month") || {};

  return {
    daily: {
      signals: daily.signals || 0,
      wins: daily.wins || 0,
      returnPct: parseFloat(daily.totalReturnPct) || 0,
      periodKey: daily.periodKey || "",
    },
    weekly: {
      signals: weekly.signals || 0,
      wins: weekly.wins || 0,
      returnPct: parseFloat(weekly.totalReturnPct) || 0,
      periodKey: weekly.periodKey || "",
    },
    monthly: {
      signals: monthly.signals || 0,
      wins: monthly.wins || 0,
      returnPct: parseFloat(monthly.totalReturnPct) || 0,
      periodKey: monthly.periodKey || "",
    },
    runningTotal: {
      signals: parseInt(totalRow?.signals) || 0,
      wins: parseInt(totalRow?.wins) || 0,
      returnPct: parseFloat(totalRow?.totalReturnPct) || 0,
    },
  };
}

function defaultScores() {
  return {
    daily: { signals: 0, wins: 0, returnPct: 0, periodKey: "" },
    weekly: { signals: 0, wins: 0, returnPct: 0, periodKey: "" },
    monthly: { signals: 0, wins: 0, returnPct: 0, periodKey: "" },
    runningTotal: { signals: 0, wins: 0, returnPct: 0 },
  };
}

async function ensureTables(client: Client) {
  // Create FeedConfig table if not exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS "FeedConfig" (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId"    UUID NOT NULL,
      symbol      TEXT NOT NULL,
      models      TEXT[] NOT NULL DEFAULT '{}',
      horizon     TEXT NOT NULL DEFAULT 'all',
      inverse     BOOLEAN NOT NULL DEFAULT false,
      label       TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS "Signal" (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "feedConfigId"  UUID NOT NULL,
      "userId"        UUID NOT NULL,
      symbol          TEXT NOT NULL,
      direction       TEXT NOT NULL,
      confidence      FLOAT,
      "entryPrice"    FLOAT,
      models          TEXT[] DEFAULT '{}',
      horizon         TEXT NOT NULL,
      "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
      "exitPrice"     FLOAT,
      "returnPct"     FLOAT,
      "resolvedAt"    TIMESTAMPTZ
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS "SignalScore" (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId"        UUID NOT NULL,
      period          TEXT NOT NULL,
      "periodKey"     TEXT NOT NULL,
      signals         INT NOT NULL DEFAULT 0,
      wins            INT NOT NULL DEFAULT 0,
      "totalReturnPct" FLOAT NOT NULL DEFAULT 0,
      "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE("userId", period, "periodKey")
    )
  `).catch(() => {});
}
