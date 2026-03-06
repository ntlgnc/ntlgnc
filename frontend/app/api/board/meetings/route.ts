import { NextResponse } from "next/server";
import { Client } from "pg";

export async function GET(req: Request) {
  const conn = process.env.DATABASE_URL;
  if (!conn) return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "10");

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, round_number, chair_id, decision, motion_type, deployed,
              follow_up_target, follow_up_met, duration_ms, total_tokens,
              votes, digest, created_at
       FROM board_meetings WHERE phase = 'complete'
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    const meetings = rows.map((m) => ({
      ...m,
      votes: typeof m.votes === "string" ? JSON.parse(m.votes) : m.votes,
    }));

    return NextResponse.json({ meetings });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    await client.end();
  }
}
