import { NextResponse } from "next/server";
import { Client } from "pg";

export async function GET() {
  const conn = process.env.DATABASE_URL;
  if (!conn) return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 500 });

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    const { rows: leaderboard } = await client.query(`
      SELECT member_id, 
             COUNT(*)::int as entries,
             COUNT(*) FILTER (WHERE evaluated_at IS NOT NULL)::int as evaluated,
             AVG(score) FILTER (WHERE score IS NOT NULL) as avg_score,
             MAX(score) as best_score,
             SUM(score) FILTER (WHERE score IS NOT NULL) as total_score
      FROM board_competitions WHERE active = true
      GROUP BY member_id ORDER BY AVG(score) DESC NULLS LAST
    `);

    const { rows: entries } = await client.query(`
      SELECT id, member_id, coin, regime_factor_1, regime_factor_2,
             hypothesis, entry_price, score, evaluated_at, created_at
      FROM board_competitions WHERE active = true
      ORDER BY created_at DESC LIMIT 20
    `);

    return NextResponse.json({ leaderboard, entries });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    await client.end();
  }
}
