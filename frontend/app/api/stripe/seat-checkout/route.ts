import { NextResponse } from "next/server";

// Pricing: $20/month with 5% cumulative discount per additional month
function calculatePrice(months: number): number {
  let total = 0;
  for (let i = 0; i < months; i++) {
    total += 20 * (1 - i * 0.05);
  }
  return Math.round(total * 100) / 100;
}

export async function POST(req: Request) {
  const { userId, email, months } = await req.json();

  if (!userId || !email || !months) {
    return NextResponse.json({ error: "userId, email, and months required" }, { status: 400 });
  }

  if (![1, 3, 6, 12].includes(months)) {
    return NextResponse.json({ error: "months must be 1, 3, 6, or 12" }, { status: 400 });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const publicUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

  if (!secretKey) {
    return NextResponse.json({
      url: null,
      message: "Stripe not yet configured. Set STRIPE_SECRET_KEY in .env.local",
    });
  }

  const price = calculatePrice(months);
  const priceInCents = Math.round(price * 100);

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secretKey, { apiVersion: "2024-06-20" as any });

    const session = await stripe.checkout.sessions.create({
      mode: "payment", // One-time, not subscription
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: priceInCents,
          product_data: {
            name: `NTLGNC Signal Seat — ${months} month${months > 1 ? "s" : ""}`,
            description: `Real-time signal access for ${months} month${months > 1 ? "s" : ""}. Transferable on the marketplace.`,
          },
        },
        quantity: 1,
      }],
      success_url: `${publicUrl}/pricing?checkout=success&session_id={CHECKOUT_SESSION_ID}&months=${months}`,
      cancel_url: `${publicUrl}/pricing?checkout=cancelled`,
      metadata: { userId, months: String(months), type: "seat_purchase" },
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error("Stripe seat checkout error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
