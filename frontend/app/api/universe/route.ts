import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "list";
  const client = await pool.connect();

  try {
    // ── LIST: All coins from backtest results ──
    if (action === "list") {
      const { rows } = await client.query(`
        SELECT symbol, bar_minutes, computed_at,
               is_sharpe, is_win_rate, is_total_ret, is_trades,
               oos_sharpe, oos_win_rate, oos_total_ret, oos_trades, oos_profit_factor,
               avg_abs_rho, perfect_rho, total_features,
               winner_params
        FROM universe_backtest
        ORDER BY symbol, bar_minutes
      `);

      const coinMap: Record<string, any> = {};
      for (const r of rows) {
        if (!coinMap[r.symbol]) coinMap[r.symbol] = { symbol: r.symbol, timeframes: {} };
        const tfKey = r.bar_minutes === 1 ? "1M" : r.bar_minutes === 60 ? "1H" : "1D";
        coinMap[r.symbol].timeframes[tfKey] = {
          barMinutes: r.bar_minutes,
          is: { sharpe: +r.is_sharpe, winRate: +r.is_win_rate, totalRet: +r.is_total_ret, trades: r.is_trades },
          oos: { sharpe: +r.oos_sharpe, winRate: +r.oos_win_rate, totalRet: +r.oos_total_ret, trades: r.oos_trades, profitFactor: +r.oos_profit_factor },
          avgAbsRho: r.avg_abs_rho ? +r.avg_abs_rho : null,
          perfectRho: r.perfect_rho,
          totalFeatures: r.total_features,
          winnerParams: r.winner_params,
          computedAt: r.computed_at,
        };
      }

      let excluded = new Set<string>();
      try {
        const { rows: ex } = await client.query(
          `SELECT symbol FROM board_coin_overrides WHERE active = true AND override_type = 'exclude'`
        );
        excluded = new Set(ex.map((r: any) => r.symbol));
      } catch {}

      const coins = Object.values(coinMap).map((c: any) => ({
        ...c,
        excluded: excluded.has(c.symbol),
      }));

      return NextResponse.json({ coins });
    }

    // ── COIN: Detailed regime comparison for one coin ──
    if (action === "coin") {
      const symbol = searchParams.get("symbol");
      if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

      const { rows } = await client.query(`
        SELECT bar_minutes, computed_at,
               is_sharpe, is_win_rate, is_total_ret, is_trades,
               oos_sharpe, oos_win_rate, oos_total_ret, oos_trades, oos_profit_factor,
               avg_abs_rho, perfect_rho, total_features,
               regime_comparison, regime_comparison_long, regime_comparison_short,
               winner_params
        FROM universe_backtest
        WHERE symbol = $1
        ORDER BY bar_minutes
      `, [symbol]);

      if (rows.length === 0) return NextResponse.json({ error: "No backtest data for this coin" }, { status: 404 });

      let excludeReason: string | null = null;
      try {
        const { rows: ex } = await client.query(
          `SELECT reason FROM board_coin_overrides WHERE symbol = $1 AND active = true AND override_type = 'exclude' LIMIT 1`,
          [symbol]
        );
        if (ex.length > 0) excludeReason = ex[0].reason;
      } catch {}

      const timeframes: Record<string, any> = {};
      for (const r of rows) {
        const tfKey = r.bar_minutes === 1 ? "1M" : r.bar_minutes === 60 ? "1H" : "1D";
        timeframes[tfKey] = {
          barMinutes: r.bar_minutes,
          is: { sharpe: +r.is_sharpe, winRate: +r.is_win_rate, totalRet: +r.is_total_ret, trades: r.is_trades },
          oos: { sharpe: +r.oos_sharpe, winRate: +r.oos_win_rate, totalRet: +r.oos_total_ret, trades: r.oos_trades, profitFactor: +r.oos_profit_factor },
          avgAbsRho: r.avg_abs_rho ? +r.avg_abs_rho : null,
          perfectRho: r.perfect_rho,
          totalFeatures: r.total_features,
          comparison: r.regime_comparison || [],
          comparisonLong: r.regime_comparison_long || [],
          comparisonShort: r.regime_comparison_short || [],
          winnerParams: r.winner_params,
          computedAt: r.computed_at,
        };
      }

      return NextResponse.json({
        symbol,
        excluded: excludeReason !== null,
        excludeReason,
        timeframes,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
