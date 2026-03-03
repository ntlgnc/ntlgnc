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

    if (action === "stats24h") {
      // Match signals page 1D logic: signals CREATED in last 24h
      const closedRes = await pool.query(`
        SELECT 
          COUNT(*) as closed,
          SUM("returnPct") as cum_return,
          COUNT(*) FILTER (WHERE "returnPct" > 0) as wins
        FROM "FracmapSignal"
        WHERE status = 'closed' AND "createdAt" > NOW() - INTERVAL '24 hours'
      `);
      const cr = closedRes.rows[0];
      const closed24 = parseInt(cr.closed) || 0;
      const wins24 = parseInt(cr.wins) || 0;
      const cumReturn24 = parseFloat(cr.cum_return) || 0;
      const winRate24 = closed24 > 0 ? (wins24 / closed24 * 100) : 0;

      // Sharpe for closed 24h
      const retRows24 = await pool.query(
        `SELECT "returnPct" FROM "FracmapSignal" WHERE status = 'closed' AND "returnPct" IS NOT NULL AND "createdAt" > NOW() - INTERVAL '24 hours'`
      );
      const rets24 = retRows24.rows.map((r: any) => parseFloat(r.returnPct) || 0);
      const mean24 = rets24.length > 0 ? rets24.reduce((a: number, b: number) => a + b, 0) / rets24.length : 0;
      const std24 = rets24.length > 1 ? Math.sqrt(rets24.reduce((a: number, b: number) => a + (b - mean24) ** 2, 0) / rets24.length) : 0;
      const sharpe24 = std24 > 0 ? (mean24 / std24) * Math.sqrt(252) : 0;

      // Open positions created in last 24h
      const openRes = await pool.query(`
        SELECT s.id, s.symbol, s.direction, s."entryPrice"
        FROM "FracmapSignal" s
        WHERE s.status = 'open' AND s."createdAt" > NOW() - INTERVAL '24 hours'
      `);
      const openSignals = openRes.rows;
      const openCount = openSignals.length;

      // Get latest prices for open positions
      let unrealisedPnL = 0;
      let openGreen = 0;
      let openRed = 0;
      const priceMap: Record<string, number> = {};
      if (openSignals.length > 0) {
        const symbols = [...new Set(openSignals.map((s: any) => s.symbol))];
        for (const sym of symbols.slice(0, 50)) {
          try {
            const pr = await pool.query(
              `SELECT close FROM "Candle1m" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
              [sym]
            );
            if (pr.rows[0]) priceMap[sym] = parseFloat(pr.rows[0].close);
          } catch {}
        }
        for (const sig of openSignals) {
          const cp = priceMap[sig.symbol];
          if (!cp || !sig.entryPrice) continue;
          const entry = parseFloat(sig.entryPrice);
          const ret = sig.direction === 'LONG'
            ? (cp / entry - 1) * 100
            : (entry / cp - 1) * 100;
          unrealisedPnL += ret;
          if (ret > 0) openGreen++; else openRed++;
        }
      }

      // Combine closed and open returns for Sharpe
      const allReturns = [...rets24];
      for (const sig of openSignals) {
        const cp = priceMap[sig.symbol];
        if (!cp || !sig.entryPrice) continue;
        const entry = parseFloat(sig.entryPrice);
        const ret = sig.direction === 'LONG'
          ? (cp / entry - 1) * 100
          : (entry / cp - 1) * 100;
        allReturns.push(ret);
      }
      const meanAll = allReturns.length > 0 ? allReturns.reduce((a: number, b: number) => a + b, 0) / allReturns.length : 0;
      const stdAll = allReturns.length > 1 ? Math.sqrt(allReturns.reduce((a: number, b: number) => a + (b - meanAll) ** 2, 0) / allReturns.length) : 0;
      const sharpeAll = stdAll > 0 ? (meanAll / stdAll) * Math.sqrt(252) : 0;

      return NextResponse.json({
        stats24h: {
          closed: closed24,
          wins: wins24,
          cumReturn: Math.round(cumReturn24 * 1000) / 1000,
          winRate: Math.round(winRate24 * 10) / 10,
          sharpe: Math.round(sharpeAll * 100) / 100,
          avgReturn: Math.round(meanAll * 10000) / 10000,
          open: openCount,
          openGreen,
          openRed,
          unrealisedPnL: Math.round(unrealisedPnL * 1000) / 1000,
          combinedPnL: Math.round((cumReturn24 + unrealisedPnL) * 1000) / 1000,
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
          // Try 1m first (most recent), fall back to 1h, then 1d
          let r = await pool.query(
            `SELECT close FROM "Candle1m" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
            [symbol]
          );
          if (!r.rows[0]) {
            r = await pool.query(
              `SELECT close FROM "Candle1h" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
              [symbol]
            );
          }
          if (!r.rows[0]) {
            r = await pool.query(
              `SELECT close FROM "Candle1d" WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
              [symbol]
            );
          }
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
      const intervals: Record<string, string> = {
        "1H": "1 hour", "1D": "1 day", "1W": "7 days", "1M": "30 days",
      };

      const isAll = timeframe === "ALL";
      const interval = intervals[timeframe] || "1 day";

      // Fetch signals from ACTIVE strategies only — exclude 'filtered' and inactive strategy signals
      const r = await pool.query(`
        SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
               s."returnPct", s.status, s."createdAt", s."closedAt", s."holdBars", s."strategyId",
               s.pair_id, s.pair_symbol, s.pair_direction, s.pair_return,
               st."barMinutes"
        FROM "FracmapSignal" s
        JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.status IN ('open', 'closed') AND st.active = true
        ${isAll ? '' : `AND s."createdAt" > NOW() - INTERVAL '${interval}'`}
        ORDER BY s."createdAt" DESC
      `);
      return NextResponse.json({ signals: r.rows });
    }

    if (action === "hedged-pairs") {
      const timeframe = searchParams.get("timeframe") || "1W";
      const intervals: Record<string, string> = {
        "1D": "1 day", "1W": "7 days", "1M": "30 days", "ALL": "9999 days",
      };
      const interval = intervals[timeframe] || "7 days";

      // Get paired signals from ACTIVE strategies only
      const { rows: pairedSignals } = await pool.query(`
        SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
               s."returnPct", s.status, s."createdAt", s."closedAt", s."holdBars", s."strategyId",
               s.pair_id, s.pair_symbol, s.pair_direction, s.pair_return,
               st."barMinutes"
        FROM "FracmapSignal" s
        JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.pair_id IS NOT NULL AND s.status IN ('open', 'closed') AND st.active = true
        AND s."createdAt" > NOW() - INTERVAL '${interval}'
        ORDER BY s."createdAt" DESC
      `);

      // Group by pair_id
      const pairMap: Record<string, any[]> = {};
      for (const s of pairedSignals) {
        if (!pairMap[s.pair_id]) pairMap[s.pair_id] = [];
        pairMap[s.pair_id].push(s);
      }

      const pairs = [];
      for (const [pairId, legs] of Object.entries(pairMap)) {
        if (legs.length !== 2) continue;
        const [legA, legB] = legs.sort((a: any, b: any) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        const pairStatus = legA.status === 'closed' && legB.status === 'closed' ? 'closed' : 'open';
        pairs.push({
          pair_id: pairId,
          legA, legB,
          pair_return: legA.pair_return,
          status: pairStatus,
        });
      }

      pairs.sort((a: any, b: any) =>
        new Date(b.legA.createdAt).getTime() - new Date(a.legA.createdAt).getTime()
      );

      // Get unpaired signals from ACTIVE strategies only
      const { rows: unpaired } = await pool.query(`
        SELECT s.id, s.symbol, s.direction, s."entryPrice", s."exitPrice",
               s."returnPct", s.status, s."createdAt", s."closedAt", s."holdBars",
               st."barMinutes"
        FROM "FracmapSignal" s
        JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.pair_id IS NULL AND s.status IN ('open', 'closed') AND st.active = true
        AND s."createdAt" > NOW() - INTERVAL '${interval}'
        ORDER BY s."createdAt" DESC
      `);

      // Stats
      const closedPairs = pairs.filter((p: any) => p.status === 'closed' && p.pair_return != null);
      const pairRets = closedPairs.map((p: any) => p.pair_return);
      const avgPairReturn = pairRets.length > 0 ? pairRets.reduce((s: number, r: number) => s + r, 0) / pairRets.length : 0;
      const pairWinRate = pairRets.length > 0 ? pairRets.filter((r: number) => r > 0).length / pairRets.length * 100 : 0;

      return NextResponse.json({
        pairs,
        unpaired,
        stats: {
          total_pairs: pairs.length,
          open_pairs: pairs.filter((p: any) => p.status === 'open').length,
          closed_pairs: closedPairs.length,
          avg_pair_return_bps: Math.round(avgPairReturn * 100),
          pair_win_rate: Math.round(pairWinRate * 10) / 10,
          unpaired_count: unpaired.length,
        },
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
