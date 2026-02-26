import { NextResponse } from "next/server";
import { Client } from "pg";

const DB_URL = process.env.DATABASE_URL;

export async function GET() {
  if (!DB_URL) return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });

  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  try {
    const { rows } = await client.query(`
      SELECT symbol, COUNT(*)::int as cnt
      FROM "Candle1m"
      WHERE symbol NOT LIKE 'i%'
      GROUP BY symbol
      HAVING COUNT(*) >= 100
      ORDER BY cnt DESC
    `);

    return NextResponse.json({
      coins: rows.map((r: any) => r.symbol),
      count: rows.length,
    });
  } finally {
    await client.end();
  }
}
