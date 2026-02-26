import { NextResponse } from "next/server";
import { Client } from "pg";

const DB_URL = process.env.DATABASE_URL;

async function getClient() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

export async function GET() {
  if (!DB_URL) return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });

  const client = await getClient();
  try {
    // Per-symbol candle stats
    const perSymbol = await client.query(`
      SELECT 
        symbol,
        COUNT(*)::int as candle_count,
        MIN(timestamp) as first_candle,
        MAX(timestamp) as last_candle,
        ROUND(COUNT(*)::numeric / 1440, 1)::float as approx_days,
        ROUND(EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600, 1)::float as span_hours
      FROM "Candle1m"
      GROUP BY symbol
      ORDER BY candle_count DESC
    `);

    // Total candles
    const totals = await client.query(`
      SELECT 
        COUNT(*)::int as total_candles,
        COUNT(DISTINCT symbol)::int as total_symbols,
        MIN(timestamp) as earliest,
        MAX(timestamp) as latest
      FROM "Candle1m"
    `);

    // Gap detection: find gaps > 5 minutes per symbol (top 5 coins only)
    const topSymbols = perSymbol.rows.slice(0, 5).map((r: any) => r.symbol);
    const gaps: Record<string, any[]> = {};

    for (const sym of topSymbols) {
      const gapResult = await client.query(`
        WITH ordered AS (
          SELECT timestamp, 
                 LEAD(timestamp) OVER (ORDER BY timestamp) as next_ts
          FROM "Candle1m"
          WHERE symbol = $1
        )
        SELECT 
          timestamp as gap_start,
          next_ts as gap_end,
          EXTRACT(EPOCH FROM (next_ts - timestamp))::int / 60 as gap_minutes
        FROM ordered
        WHERE next_ts - timestamp > INTERVAL '5 minutes'
        ORDER BY next_ts - timestamp DESC
        LIMIT 5
      `, [sym]);
      gaps[sym] = gapResult.rows;
    }

    // Hourly candle rate (last 24h) — data freshness check
    const hourlyRate = await client.query(`
      SELECT 
        date_trunc('hour', timestamp) as hour,
        COUNT(DISTINCT symbol)::int as symbols_active,
        COUNT(*)::int as candle_count
      FROM "Candle1m"
      WHERE timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY date_trunc('hour', timestamp)
      ORDER BY hour DESC
      LIMIT 24
    `);

    // Latest candle per symbol (freshness)
    const freshness = await client.query(`
      SELECT 
        symbol,
        MAX(timestamp) as latest,
        EXTRACT(EPOCH FROM (NOW() - MAX(timestamp)))::int / 60 as age_minutes
      FROM "Candle1m"
      GROUP BY symbol
      ORDER BY age_minutes ASC
    `);

    await client.end();

    return NextResponse.json({
      totals: totals.rows[0],
      perSymbol: perSymbol.rows,
      gaps,
      hourlyRate: hourlyRate.rows,
      freshness: freshness.rows,
    });
  } catch (err: any) {
    await client.end().catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
