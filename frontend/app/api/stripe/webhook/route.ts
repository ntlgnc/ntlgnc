import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !endpointSecret) {
    return NextResponse.json({ ok: false, message: "Stripe webhook not configured" }, { status: 501 });
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" as any });

    const body = await req.text();
    const sig = req.headers.get("stripe-signature")!;

    let event;
    try {
      event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
    } catch (err: any) {
      return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
    }

    const { Client } = await import("pg");

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as any;
      const userId = session.metadata?.userId;
      const customerId = session.customer as string;

      if (userId) {
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        await client.query(
          `UPDATE "User" SET subscription = 'premium', "stripeCustomerId" = $1 WHERE id = $2`,
          [customerId, userId]
        );
        await client.end();
      }
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object as any;
      const customerId = sub.customer as string;
      const status = sub.status;
      if (status === "active" || status === "trialing") {
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        await client.query(`UPDATE "User" SET subscription = 'premium' WHERE "stripeCustomerId" = $1`, [customerId]);
        await client.end();
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as any;
      const customerId = sub.customer as string;
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      await client.query(`UPDATE "User" SET subscription = 'free' WHERE "stripeCustomerId" = $1`, [customerId]);
      await client.end();
    }

    if (event.type === "invoice.payment_failed") {
      console.warn("Payment failed for:", (event.data.object as any).customer);
    }

    return NextResponse.json({ received: true });
  } catch (err: any) {
    console.error("Webhook error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
