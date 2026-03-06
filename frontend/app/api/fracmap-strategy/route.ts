import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";
import { validateAdminRequest, unauthorizedResponse } from "@/lib/admin-auth";

function getClient() {
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL not set");
  return new Client({ connectionString: conn });
}

// ── GET: list strategies or get signals ──
export async function GET(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list";
  const client = getClient();
  await client.connect();

  try {
    if (action === "list") {
      const { rows } = await client.query(
        `SELECT * FROM "FracmapStrategy" ORDER BY "active" DESC, "updatedAt" DESC`
      );
      return NextResponse.json({ strategies: rows });
    }

    if (action === "signals") {
      const strategyId = url.searchParams.get("strategyId");
      const symbol = url.searchParams.get("symbol");
      const status = url.searchParams.get("status");
      const limit = Number(url.searchParams.get("limit") ?? "100");

      let where = "WHERE 1=1";
      const params: any[] = [];
      if (strategyId) { params.push(strategyId); where += ` AND "strategyId" = $${params.length}`; }
      if (symbol) { params.push(symbol); where += ` AND "symbol" = $${params.length}`; }
      if (status) { params.push(status); where += ` AND "status" = $${params.length}`; }
      params.push(limit);

      const { rows } = await client.query(
        `SELECT * FROM "FracmapSignal" ${where} ORDER BY "createdAt" DESC LIMIT $${params.length}`,
        params
      );
      return NextResponse.json({ signals: rows });
    }

    if (action === "activeStrategy") {
      // Get the currently active strategy (or strategies for per-coin)
      const type = url.searchParams.get("type") || "universal";
      const { rows } = await client.query(
        `SELECT * FROM "FracmapStrategy" WHERE "active" = true AND "type" = $1 ORDER BY "updatedAt" DESC`,
        [type]
      );
      return NextResponse.json({ strategies: rows });
    }

    if (action === "active") {
      const { rows } = await client.query(
        `SELECT id, name, type, "barMinutes", "cycleMin", "cycleMax", "minStr", "minCyc",
                spike, "nearMiss", "holdDiv", "priceExt", config
         FROM "FracmapStrategy" WHERE active = true ORDER BY "barMinutes"`
      );
      return NextResponse.json({ strategies: rows });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } finally {
    await client.end();
  }
}

// ── POST: save strategy, record signal, update signal ──
export async function POST(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  const body = await req.json();
  const action = body.action;
  const client = getClient();
  await client.connect();

  try {
    // ── Save a strategy ──
    if (action === "saveStrategy") {
      const {
        name, type = "universal", barMinutes = 1, symbol = null,
        minStr, minCyc, spike, nearMiss, holdDiv, priceExt,
        isSharpe, oosSharpe, bootP, winRate, profitFactor, consistency, totalTrades, splitPct,
        cycleMin, cycleMax, config
      } = body;

      if (!name || minStr == null || minCyc == null || holdDiv == null) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }

      // Ensure cycleMin/cycleMax columns exist (safe migration)
      try {
        await client.query(`ALTER TABLE "FracmapStrategy" ADD COLUMN IF NOT EXISTS "cycleMin" integer DEFAULT 5`);
        await client.query(`ALTER TABLE "FracmapStrategy" ADD COLUMN IF NOT EXISTS "cycleMax" integer DEFAULT 20`);
        await client.query(`ALTER TABLE "FracmapStrategy" ADD COLUMN IF NOT EXISTS "priceExt" boolean DEFAULT false`);
      } catch {}

      const { rows } = await client.query(
        `INSERT INTO "FracmapStrategy"
          ("name", "type", "barMinutes", "symbol",
           "minStr", "minCyc", "spike", "nearMiss", "holdDiv", "priceExt",
           "isSharpe", "oosSharpe", "bootP", "winRate", "profitFactor", "consistency", "totalTrades", "splitPct",
           "cycleMin", "cycleMax", "config")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [name, type, barMinutes, symbol,
         minStr, minCyc, spike ?? true, nearMiss ?? true, holdDiv, priceExt ?? false,
         isSharpe, oosSharpe, bootP, winRate, profitFactor, consistency, totalTrades, splitPct,
         cycleMin ?? 5, cycleMax ?? 20, config ? JSON.stringify(config) : null]
      );

      return NextResponse.json({ strategy: rows[0] });
    }

    // ── Save multiple per-coin strategies in one call ──
    if (action === "savePerCoinStrategies") {
      const { name, barMinutes, splitPct, strategies: coinStrats } = body;
      // coinStrats: [{ symbol, minStr, minCyc, spike, nearMiss, holdDiv, sharpe, winRate, pf, trades }]
      if (!Array.isArray(coinStrats) || coinStrats.length === 0) {
        return NextResponse.json({ error: "No strategies provided" }, { status: 400 });
      }

      const saved = [];
      for (const cs of coinStrats) {
        const { rows } = await client.query(
          `INSERT INTO "FracmapStrategy"
            ("name", "type", "barMinutes", "symbol",
             "minStr", "minCyc", "spike", "nearMiss", "holdDiv",
             "isSharpe", "winRate", "profitFactor", "totalTrades", "splitPct")
           VALUES ($1, 'per_coin', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [`${name} — ${cs.symbol.replace("USDT","")}`, barMinutes, cs.symbol,
           cs.minStr, cs.minCyc, cs.spike ?? true, cs.nearMiss ?? true, cs.holdDiv,
           cs.sharpe, cs.winRate, cs.pf, cs.trades, splitPct]
        );
        saved.push(rows[0]);
      }

      return NextResponse.json({ strategies: saved });
    }

    // ── Toggle active status ──
    if (action === "toggleStrategy") {
      const { id, active } = body;
      if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

      const { rows } = await client.query(
        `UPDATE "FracmapStrategy" SET "active" = $1, "updatedAt" = now() WHERE "id" = $2 RETURNING *`,
        [active ?? false, id]
      );

      return NextResponse.json({ strategy: rows[0] || null });
    }

    // ── Delete strategy ──
    if (action === "deleteStrategy") {
      const { id } = body;
      if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

      await client.query(`DELETE FROM "FracmapStrategy" WHERE "id" = $1`, [id]);
      return NextResponse.json({ deleted: true });
    }

    // ── Record a new signal ──
    if (action === "recordSignal") {
      const { strategyId, symbol, direction, entryPrice, targetPrice, stopPrice, strength, holdBars, maxCycle, maxOrder, triggerBands } = body;
      if (!strategyId || !symbol || !direction || !entryPrice || !holdBars) {
        return NextResponse.json({ error: "Missing required signal fields" }, { status: 400 });
      }

      const { rows } = await client.query(
        `INSERT INTO "FracmapSignal"
          ("strategyId", "symbol", "direction", "entryPrice", "targetPrice", "stopPrice", "strength", "holdBars", "maxCycle", "maxOrder", "triggerBands")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [strategyId, symbol, direction, entryPrice, targetPrice, stopPrice, strength, holdBars, maxCycle || null, maxOrder || null, triggerBands ? JSON.stringify(triggerBands) : null]
      );

      return NextResponse.json({ signal: rows[0] });
    }

    // ── Close a signal ──
    if (action === "closeSignal") {
      const { id, exitPrice, returnPct, status = "closed" } = body;
      if (!id) return NextResponse.json({ error: "Missing signal id" }, { status: 400 });

      const { rows } = await client.query(
        `UPDATE "FracmapSignal"
         SET "exitPrice" = $1, "returnPct" = $2, "status" = $3, "closedAt" = now()
         WHERE "id" = $4
         RETURNING *`,
        [exitPrice, returnPct, status, id]
      );

      return NextResponse.json({ signal: rows[0] || null });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } finally {
    await client.end();
  }
}
