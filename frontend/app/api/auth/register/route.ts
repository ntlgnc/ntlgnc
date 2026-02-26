import { NextResponse } from "next/server";
import { Client } from "pg";
import crypto from "crypto";

export async function POST(req: Request) {
  const { email, password, name } = await req.json();

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  }

  if (!name || String(name).trim().length < 2) {
    return NextResponse.json({ error: "Username is required (min 2 characters)" }, { status: 400 });
  }

  const username = String(name).trim();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Check email uniqueness
    const existingEmail = await client.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
    if (existingEmail.rows.length > 0) {
      return NextResponse.json({ error: "Email already registered" }, { status: 409 });
    }

    // Check username uniqueness
    const existingName = await client.query(`SELECT id FROM "User" WHERE LOWER(name) = LOWER($1)`, [username]);
    if (existingName.rows.length > 0) {
      return NextResponse.json({ error: "Username already taken" }, { status: 409 });
    }

    // Hash password
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    const passwordHash = `${salt}:${hash}`;

    const userId = crypto.randomUUID();

    await client.query(
      `INSERT INTO "User" (id, email, name, "passwordHash", subscription, "createdAt")
       VALUES ($1, $2, $3, $4, 'free', NOW())`,
      [userId, email, username, passwordHash]
    );

    return NextResponse.json({
      userId,
      email,
      name: username,
      subscription: "free",
    });
  } finally {
    await client.end();
  }
}
