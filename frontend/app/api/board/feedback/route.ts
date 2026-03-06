import { NextResponse } from "next/server";
import { Client } from "pg";

export async function POST(req: Request) {
  const conn = process.env.DATABASE_URL;
  if (!conn) return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 500 });

  let body: { feature_type?: string; feature_id?: number; vote?: string; session_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { feature_type, feature_id, vote, session_id } = body;

  if (!feature_type || !feature_id || !["up", "down"].includes(vote || "")) {
    return NextResponse.json(
      { error: "Need feature_type, feature_id, and vote ('up' or 'down')" },
      { status: 400 }
    );
  }

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    // Check for existing vote from same session
    if (session_id) {
      const { rows: existing } = await client.query(
        `SELECT id FROM user_feedback WHERE feature_type = $1 AND feature_id = $2 AND session_id = $3`,
        [feature_type, feature_id, session_id]
      );
      if (existing.length > 0) {
        await client.query(
          `UPDATE user_feedback SET vote = $1, created_at = now() WHERE id = $2`,
          [vote, existing[0].id]
        );
        await updateAggregates(client, feature_type, feature_id);
        return NextResponse.json({ updated: true, id: existing[0].id });
      }
    }

    // Insert new
    const {
      rows: [inserted],
    } = await client.query(
      `INSERT INTO user_feedback (feature_type, feature_id, vote, session_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [feature_type, feature_id, vote, session_id || null]
    );

    await updateAggregates(client, feature_type, feature_id);
    return NextResponse.json({ created: true, id: inserted.id });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    await client.end();
  }
}

async function updateAggregates(client: Client, featureType: string, featureId: number) {
  const {
    rows: [counts],
  } = await client.query(
    `SELECT 
      COUNT(*) FILTER (WHERE vote = 'up')::int as ups,
      COUNT(*) FILTER (WHERE vote = 'down')::int as downs
    FROM user_feedback WHERE feature_type = $1 AND feature_id = $2`,
    [featureType, featureId]
  );

  if (featureType === "hero") {
    await client.query(
      `UPDATE board_hero_content SET thumbs_up = $1, thumbs_down = $2 WHERE id = $3`,
      [counts.ups, counts.downs, featureId]
    );
  }
}
