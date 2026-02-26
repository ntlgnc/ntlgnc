import { NextResponse } from "next/server";
import { Client } from "pg";
import crypto from "crypto";

export async function POST(req: Request) {
  const { email, password } = await req.json();

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const result = await client.query(
      `SELECT id, email, name, "passwordHash", subscription, "stripeCustomerId"
       FROM "User" WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const user = result.rows[0];
    const [salt, storedHash] = String(user.passwordHash).split(":");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");

    if (hash !== storedHash) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    return NextResponse.json({
      userId: user.id,
      email: user.email,
      name: user.name,
      subscription: user.subscription,
      stripeCustomerId: user.stripeCustomerId,
    });
  } finally {
    await client.end();
  }
}
