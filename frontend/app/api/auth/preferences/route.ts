import { NextResponse } from "next/server";
import { Client } from "pg";

/**
 * GET /api/auth/preferences?userId=xxx
 * Returns saved model selections for a logged-in user.
 *
 * POST /api/auth/preferences
 * Body: { userId, selectedModels: string[], heroCoins: [string, string] }
 * Saves user preferences to DB.
 *
 * NOTE: Requires adding a "preferences" JSONB column to the User table:
 *   ALTER TABLE "User" ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT preferences FROM "User" WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) return NextResponse.json({ error: "User not found" }, { status: 404 });
    return NextResponse.json(rows[0].preferences || {});
  } catch (err: any) {
    // If preferences column doesn't exist yet, return empty
    if (err.message?.includes("preferences")) {
      return NextResponse.json({});
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    await client.end();
  }
}

export async function POST(req: Request) {
  const { userId, selectedModels, heroCoins } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const prefs: Record<string, any> = {};
  if (selectedModels) prefs.selectedModels = selectedModels;
  if (heroCoins) prefs.heroCoins = heroCoins;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Ensure column exists (safe to run multiple times)
    await client.query(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'`
    ).catch(() => {}); // ignore if already exists

    await client.query(
      `UPDATE "User" SET preferences = COALESCE(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [userId, JSON.stringify(prefs)]
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    await client.end();
  }
}
