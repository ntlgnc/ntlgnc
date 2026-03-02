import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const barMinutes = Number(searchParams.get("bar_minutes") ?? "1440");
  const detail = searchParams.get("detail") === "true";
  const top = Number(searchParams.get("top") ?? "0");

  const client = await pool.connect();
  try {
    const columns = detail
      ? "*"
      : `id, computed_at, bar_minutes, cycle_min, cycle_max, pair_mode, max_gap, split_pct, coins_used,
         is_sharpe, is_win_rate, is_profit_factor, is_total_ret, is_trade_count, is_avg_hold, is_t1_count, is_t2_count, is_unmatched,
         oos_sharpe, oos_win_rate, oos_profit_factor, oos_total_ret, oos_trade_count, oos_avg_hold, oos_t1_count, oos_t2_count, oos_unmatched,
         oos_unhedged_sharpe, oos_unhedged_wr, top_pairs`;

    let query = `SELECT ${columns} FROM hedged_backtest WHERE bar_minutes = $1`;
    const params: any[] = [barMinutes];

    if (top > 0) {
      query += ` AND oos_trade_count >= 5 ORDER BY oos_sharpe DESC LIMIT $2`;
      params.push(top);
    } else {
      query += ` ORDER BY cycle_min, cycle_max, pair_mode, max_gap`;
    }

    const { rows } = await client.query(query, params);

    // Also load per-coin data if available
    let coins: any[] = [];
    if (rows.length > 0) {
      try {
        const btIds = rows.slice(0, 5).map((r: any) => r.id);
        const { rows: coinRows } = await client.query(
          `SELECT * FROM hedged_backtest_coins WHERE backtest_id = ANY($1) ORDER BY backtest_id, oos_signals DESC`,
          [btIds]
        );
        coins = coinRows;
      } catch {}
    }

    return NextResponse.json({ results: rows, coins });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
