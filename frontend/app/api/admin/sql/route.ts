import { NextRequest, NextResponse } from "next/server";
import { Client } from "pg";
import { validateAdminRequest, unauthorizedResponse } from "@/lib/admin-auth";

const DB_URL = process.env.DATABASE_URL;

// Safety: block destructive keywords unless explicitly allowed
const DANGEROUS_PATTERNS = [
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /TRUNCATE/i,
  /ALTER\s+TABLE.*DROP/i,
  /DELETE\s+FROM/i,
  /UPDATE\s+/i,
  /INSERT\s+INTO/i,
  /CREATE\s+FUNCTION/i,
  /CREATE\s+OR\s+REPLACE\s+FUNCTION/i,
  /GRANT\s+/i,
  /REVOKE\s+/i,
];

export async function POST(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  if (!DB_URL) return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }

  const { sql, allowDangerous } = body;
  if (!sql || typeof sql !== "string" || sql.trim().length === 0) {
    return NextResponse.json({ error: "Empty SQL" }, { status: 400 });
  }

  // Block dangerous queries unless explicitly confirmed
  if (!allowDangerous) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(sql)) {
        return NextResponse.json({ 
          error: `Blocked: "${sql.match(pattern)?.[0]}" detected. This is a destructive operation.`,
          dangerous: true,
        }, { status: 400 });
      }
    }
  }

  const client = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 5000 });

  try {
    await client.connect();
    await client.query("SET statement_timeout = '30s'");

    const start = Date.now();
    const result = await client.query(sql);
    const elapsed = Date.now() - start;

    return NextResponse.json({
      ok: true,
      command: result.command,
      rowCount: result.rowCount,
      rows: result.rows?.slice(0, 500) ?? [],  // Cap at 500 rows
      fields: result.fields?.map(f => f.name) ?? [],
      elapsed,
      truncated: (result.rows?.length ?? 0) > 500,
    });
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      error: err.message?.slice(0, 500) || "Unknown error",
    }, { status: 400 });
  } finally {
    await client.end().catch(() => {});
  }
}
