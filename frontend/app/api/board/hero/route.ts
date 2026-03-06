import { NextResponse } from "next/server";
import { Client } from "pg";

export async function GET() {
  const conn = process.env.DATABASE_URL;
  if (!conn) return NextResponse.json({ error: "DATABASE_URL not set" }, { status: 500 });

  const client = new Client({ connectionString: conn });
  await client.connect();

  try {
    // Increment impressions
    await client.query(`UPDATE board_hero_content SET impressions = impressions + 1 WHERE active = true`);

    const { rows } = await client.query(`
      SELECT id, authored_by, badge_text, headline, subheadline, body_text,
             cta_left, cta_right, thumbs_up, thumbs_down, impressions, created_at
      FROM board_hero_content WHERE active = true
      ORDER BY created_at DESC LIMIT 1
    `);

    if (rows.length === 0) {
      // Default hero content (before any LLM has edited it)
      return NextResponse.json({
        id: 0,
        authored_by: "system",
        badge_text: "LIVE \u2014 Signals firing now",
        headline: "Recursive AI Alpha",
        subheadline: "Humans built it. The machines took it from here.",
        body_text: "Five frontier AI models meet every hour to debate, test, and deploy strategy improvements. No human approves the changes. The system gets better on its own. Watch the performance curve.",
        cta_left: "View Live Signals",
        cta_right: "See the Evidence",
        thumbs_up: 0,
        thumbs_down: 0,
        impressions: 0,
      });
    }

    return NextResponse.json(rows[0]);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    await client.end();
  }
}
