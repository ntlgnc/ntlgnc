import { NextResponse } from "next/server";

/**
 * POST /api/stripe/portal
 * Creates a Stripe Customer Portal session for managing subscriptions.
 * Accepts stripeCustomerId directly, or userId to look it up from DB.
 */
export async function POST(req: Request) {
  const { stripeCustomerId, userId } = await req.json();

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const baseUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

  if (!stripeKey) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 501 });
  }

  let customerId = stripeCustomerId;

  // If no stripeCustomerId provided, look it up from DB by userId
  if (!customerId && userId) {
    try {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const result = await client.query(`SELECT "stripeCustomerId" FROM "User" WHERE id = $1`, [userId]);
      await client.end();
      customerId = result.rows[0]?.stripeCustomerId;
    } catch (e) {
      console.error("DB lookup error:", e);
    }
  }

  if (!customerId) {
    return NextResponse.json({ error: "No Stripe customer found" }, { status: 400 });
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" as any });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}/`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
