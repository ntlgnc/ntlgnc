import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { userId, email } = await req.json();

  if (!userId || !email) {
    return NextResponse.json({ error: "userId and email required" }, { status: 400 });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  const publicUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

  if (!secretKey || !priceId) {
    return NextResponse.json({
      url: null,
      message: "Stripe not yet configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID in .env.local",
    });
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" as any });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${publicUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/?checkout=cancelled`,
      metadata: { userId },
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error("Stripe checkout error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
