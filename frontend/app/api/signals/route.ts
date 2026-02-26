import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "list";

  try {
    if (action === "stats") {
      const r = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'closed') as closed,
          COUNT(*) FILTER (WHERE status = 'open') as open_count,
          SUM(CASE WHEN status = 'closed' THEN "returnPct" ELSE 0 END) as cum_return,
          COUNT(*) FILTER (WHERE status = 'closed' AND "returnPct" > 0) as wins
        FROM "FracmapSignal"
      `);
      const row = r.rows[0];
      const closed = parseInt(row.closed) || 0;
      const wins = parseInt(row.wins) || 0;
      const cumReturn = parseFloat(row.cum_return) || 0;
      const winRate = closed > 0 ? (wins / closed * 100) : 0;

      const retRows = await pool.query(`SELECT "returnPct" FROM "FracmapSignal" WHERE status = 'closed' AND "returnPct" IS NOT NULL`);
      const rets = retRows.rows.map((r: any) => parseFloat(r.returnPct) || 0);
      const mean = rets.length > 0 ? rets.reduce((a: number, b: number) => a + b, 0) / rets.length : 0;
      const std = rets.length > 1 ? Math.sqrt(rets.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / rets.length) : 0;
      const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

      return NextResponse.json({
        stats: {
          totalTrades: closed,
          openTrades: parseInt(row.open_count) || 0,
          cumReturn: Math.round(cumReturn * 1000) / 1000,
          winRate: Math.round(winRate * 10) / 10,
          sharpe: Math.round(sharpe * 100) / 100,
        }
      });
    }

    if (action === "showcase") {
      // FIXED: Added directional consistency check.
      // A profitable LONG must have exitPrice > entryPrice.
      // A profitable SHORT must have exitPrice < entryPrice.
      // Without this, phantom exit prices (e.g. the ALLO 0.099 bug) can
      // produce impossible-looking showcase cards where the chart contradicts the return.
      const bestBuys = await pool.query(`
        SELECT id, symbol, direction, "entryPrice", "exitPrice",
               "returnPct", status, "createdAt", "closedAt", "holdBars", "strategyId"
        FROM "FracmapSignal"
        WHERE status = 'closed' AND direction = 'LONG' AND "returnPct" > 0
          AND "exitPrice" > "entryPrice"
          AND "closedAt" > NOW() - INTERVAL '12 hours'
        ORDER BY "returnPct" DESC LIMIT 2
      `);
      const bestSells = await pool.query(`
        SELECT id, symbol, direction, "entryPrice", "exitPrice",
               "returnPct", status, "createdAt", "closedAt", "holdBars", "strategyId"
        FROM "FracmapSignal"
        WHERE status = 'closed' AND direction = 'SHORT' AND "returnPct" > 0
          AND "exitPrice" < "entryPrice"
          AND "closedAt" > NOW() - INTERVAL '12 hours'
        ORDER BY "returnPct" DESC LIMIT 2
      `);
      return NextResponse.json({ signals: [...bestBuys.rows, ...bestSells.rows] });
    }

    if (action === "recent") {
      const limit = parseInt(searchParams.get("limit") || "10");
      const r = await pool.query(`
        SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
               s."returnPct", s.status, s."createdAt", s."closedAt", s."holdBars", s."strategyId",
               COALESCE(st."barMinutes", NULL) as "barMinutes"
        FROM "FracmapSignal" s
        LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.status = 'closed' 
        ORDER BY s."closedAt" DESC LIMIT $1
      `, [limit]);
      return NextResponse.json({ signals: r.rows });
    }

    if (action === "prices") {
      const symbolsParam = searchParams.get("symbols") || "";
      const symbols = symbolsParam.split(",").filter(Boolean);
      if (symbols.length === 0) return NextResponse.json({ prices: {} });
      
      const prices: Record<string, number> = {};
      for (const symbol of symbols.slice(0, 50)) {
        try {
          const r = await pool.query(
            `SELECT close FROM "Candle1m" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
            [symbol]
          );
          if (r.rows[0]) prices[symbol] = parseFloat(r.rows[0].close);
        } catch {}
      }
      return NextResponse.json({ prices });
    }

    if (action === "chart") {
      const signalId = searchParams.get("signalId");
      if (!signalId) return NextResponse.json({ error: "signalId required" }, { status: 400 });

      const { rows: [sig] } = await pool.query(
        `SELECT symbol, direction, "entryPrice", "exitPrice", "returnPct", status, 
                "createdAt", "closedAt", "holdBars", "strategyId"
         FROM "FracmapSignal" WHERE id = $1`, [signalId]
      );
      if (!sig) return NextResponse.json({ error: "Signal not found" }, { status: 404 });

      const holdBars = sig.holdBars || 10;

      let table = "Candle1h";
      try {
        if (sig.strategyId) {
          const { rows: [strat] } = await pool.query(
            `SELECT "barMinutes" FROM "FracmapStrategy" WHERE id = $1`, [sig.strategyId]
          );
          if (strat) {
            const bm = parseInt(strat.barMinutes);
            if (bm <= 1) table = "Candle1m";
            else if (bm <= 60) table = "Candle1h";
            else table = "Candle1d";
          }
        }
      } catch {}

      const barDurationMs = table === "Candle1m" ? 60_000 : table === "Candle1h" ? 3600_000 : 86400_000;

      const entryMs = new Date(sig.createdAt).getTime();
      const snappedEntryMs = Math.floor(entryMs / barDurationMs) * barDurationMs;

      const barsBefore = 25;
      const barsAfter = holdBars + 5;
      const startTime = new Date(snappedEntryMs - barsBefore * barDurationMs);
      const endTime = new Date(snappedEntryMs + barsAfter * barDurationMs);

      const { rows: candles } = await pool.query(`
        SELECT timestamp as time, open, high, low, close FROM "${table}" 
        WHERE symbol = $1 AND timestamp >= $2 AND timestamp <= $3
        ORDER BY time ASC LIMIT 500
      `, [sig.symbol, startTime, endTime]);

      let entryBarIdx = -1;
      const ep = parseFloat(sig.entryPrice);
      let bestDist = Infinity;
      for (let i = candles.length - 1; i >= 0; i--) {
        const ct = new Date(candles[i].time).getTime();
        if (ct > new Date(sig.createdAt).getTime()) continue;
        const dist = Math.abs(parseFloat(candles[i].close) - ep);
        if (dist < bestDist) {
          bestDist = dist;
          entryBarIdx = i;
        }
      }
      if (entryBarIdx < 0) entryBarIdx = candles.findIndex((c: any) => new Date(c.time).getTime() >= snappedEntryMs);
      if (entryBarIdx < 0) entryBarIdx = candles.length - 1;

      let exitBarIdx = -1;
      if (sig.exitPrice && sig.closedAt) {
        const xp = parseFloat(sig.exitPrice);
        let bestExitDist = Infinity;
        for (let i = entryBarIdx + 1; i < candles.length; i++) {
          const dist = Math.abs(parseFloat(candles[i].close) - xp);
          if (dist < bestExitDist) {
            bestExitDist = dist;
            exitBarIdx = i;
          }
        }
      }

      return NextResponse.json({
        signal: { ...sig, holdBars },
        candles: candles.map((c: any) => ({
          time: c.time, open: +c.open, high: +c.high, low: +c.low, close: +c.close,
        })),
        table,
        entryBarIdx,
        exitBarIdx,
      });
    }

    if (action === "list") {
      const timeframe = searchParams.get("timeframe") || "1D";
      const limit = parseInt(searchParams.get("limit") || "2000");
      const intervals: Record<string, string> = {
        "1H": "1 hour", "1D": "1 day", "1W": "7 days", "1M": "30 days", "ALL": "365 days"
      };
      const interval = intervals[timeframe] || "1 day";

      // Join strategy table to get barMinutes for periodicity classification
      const r = await pool.query(`
        SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
               s."returnPct", s.status, s."createdAt", s."closedAt", s."holdBars", s."strategyId",
               st."barMinutes"
        FROM "FracmapSignal" s
        LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s."createdAt" > NOW() - INTERVAL '${interval}' 
        ORDER BY s."createdAt" DESC LIMIT $1
      `, [limit]);
      return NextResponse.json({ signals: r.rows });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
