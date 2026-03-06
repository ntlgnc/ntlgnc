import { NextResponse } from "next/server";
import { Client } from "pg";

/**
 * GET /api/board/filter-impact
 * 
 * Returns time-series data for each active filter showing the cumulative
 * INVERTED return of blocked signals. If a filter blocks signals that would
 * have lost money, the inverted cumulative goes UP (filter is helping).
 * If it blocks signals that would have made money, it goes DOWN (filter is hurting).
 * 
 * Query params:
 *   ?hours=24  (default 168 = 7 days)
 *   ?filter_id=1  (optional, specific filter)
 */
export async function GET(req: Request) {
  const conn = process.env.DATABASE_URL;
  if (!conn) return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const hours = Number(url.searchParams.get("hours") ?? "168");
  const filterId = url.searchParams.get("filter_id");

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    // Get active filters
    const filterQuery = filterId
      ? `SELECT id, feature, timeframe, conditions, created_at, trades_passed, trades_filtered FROM board_filters WHERE id = $1`
      : `SELECT id, feature, timeframe, conditions, created_at, trades_passed, trades_filtered FROM board_filters WHERE active = true ORDER BY id`;
    const filterParams = filterId ? [filterId] : [];
    const { rows: filters } = await client.query(filterQuery, filterParams);

    // Get all strategies for barMinutes lookup
    const { rows: strategies } = await client.query(
      `SELECT id, "barMinutes" FROM "FracmapStrategy"`
    );
    const strategyMap: Record<string, number> = {};
    for (const s of strategies) strategyMap[s.id] = s.barMinutes;

    const result: Record<string, any> = {};

    for (const filter of filters) {
      const fId = filter.id;
      const deployedAt = filter.created_at;

      // Get signals blocked by this filter
      const { rows: blockedSignals } = await client.query(
        `SELECT id, symbol, direction, "entryPrice", "strategyId", "holdBars",
                "createdAt", status, filtered_by
         FROM "FracmapSignal"
         WHERE filtered_by = $1 AND "createdAt" >= $2
         ORDER BY "createdAt" ASC`,
        [fId, new Date(Date.now() - hours * 3600000).toISOString()]
      );

      // For each blocked signal, compute the hypothetical return
      const series: Array<{
        time: string;
        symbol: string;
        direction: string;
        hypothetical_return: number;
        inverted_return: number;
        cumulative_inverted: number;
      }> = [];

      let cumulativeInverted = 0;

      for (const sig of blockedSignals) {
        const barMinutes = strategyMap[sig.strategyId] || 1;
        const holdBars = sig.holdBars || 60;
        const holdMs = holdBars * barMinutes * 60 * 1000;
        const exitTime = new Date(sig.createdAt).getTime() + holdMs;

        if (exitTime > Date.now()) continue; // Not yet expired

        const entryPrice = parseFloat(sig.entryPrice);
        if (!entryPrice || entryPrice <= 0) continue;

        const table =
          barMinutes >= 1440
            ? "Candle1d"
            : barMinutes >= 60
            ? "Candle1h"
            : "Candle1m";

        try {
          const { rows: candles } = await client.query(
            `SELECT close FROM "${table}" WHERE symbol = $1 AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 1`,
            [sig.symbol, new Date(exitTime).toISOString()]
          );

          if (candles.length > 0) {
            const exitPrice = parseFloat(candles[0].close);
            const hypotheticalReturn =
              sig.direction === "LONG"
                ? (exitPrice / entryPrice - 1) * 100
                : (entryPrice / exitPrice - 1) * 100;

            if (Math.abs(hypotheticalReturn) > 50) continue; // Sanity check

            // INVERT: flip the sign. If the blocked trade LOST money (negative return),
            // the inverted return is POSITIVE (filter saved us money).
            const invertedReturn = -hypotheticalReturn;
            cumulativeInverted += invertedReturn;

            series.push({
              time: sig.createdAt,
              symbol: sig.symbol,
              direction: sig.direction,
              hypothetical_return: Math.round(hypotheticalReturn * 10000) / 10000,
              inverted_return: Math.round(invertedReturn * 10000) / 10000,
              cumulative_inverted: Math.round(cumulativeInverted * 10000) / 10000,
            });
          }
        } catch {}
      }

      const totalBlocked = series.length;
      const totalInverted = cumulativeInverted;
      const avgInverted = totalBlocked > 0 ? totalInverted / totalBlocked : 0;
      const verdict =
        totalBlocked < 10
          ? "INSUFFICIENT_DATA"
          : totalInverted > 0
          ? "HELPING"
          : "HURTING";

      result[fId] = {
        filter_id: fId,
        feature: filter.feature,
        timeframe: filter.timeframe,
        deployed_at: deployedAt,
        trades_passed: filter.trades_passed,
        trades_filtered: filter.trades_filtered,
        block_rate:
          filter.trades_filtered + filter.trades_passed > 0
            ? (
                (filter.trades_filtered /
                  (filter.trades_filtered + filter.trades_passed)) *
                100
              ).toFixed(1)
            : "0",
        evaluated: totalBlocked,
        cumulative_inverted_return: Math.round(totalInverted * 10000) / 10000,
        avg_inverted_per_trade: Math.round(avgInverted * 10000) / 10000,
        verdict,
        series,
      };
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    await client.end();
  }
}
