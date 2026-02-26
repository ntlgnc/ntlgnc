import { NextResponse } from "next/server";
import { Client } from "pg";
import crypto from "crypto";

/**
 * GET /api/auth/oauth/google/callback?code=...&state=...
 * State contains nonce.base64url(returnTo).
 * Redirects to returnTo?auth_success=... after successful auth.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") || "";

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  // Decode returnTo from state
  let returnTo = "/";
  try {
    const dotIdx = state.indexOf(".");
    if (dotIdx > 0) {
      returnTo = Buffer.from(state.slice(dotIdx + 1), "base64url").toString("utf8") || "/";
    }
  } catch { returnTo = "/"; }

  const errorRedirect = (reason: string) =>
    NextResponse.redirect(`${baseUrl}${returnTo}?auth_error=${reason}`);

  if (error || !code) {
    return errorRedirect(error || "no_code");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorRedirect("google_not_configured");
  }

  const redirectUri = `${baseUrl}/api/auth/oauth/google/callback`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return errorRedirect("token_exchange_failed");
    }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();

    if (!googleUser.email) {
      return errorRedirect("no_email");
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
      const { rows: existing } = await client.query(
        `SELECT id, email, name, subscription, "stripeCustomerId" FROM "User" WHERE email = $1`,
        [googleUser.email.toLowerCase()]
      );

      let userId: string;
      let userName: string;
      let subscription: string;
      let stripeCustomerId: string | null;

      if (existing.length > 0) {
        userId = existing[0].id;
        userName = existing[0].name || googleUser.name || googleUser.email.split("@")[0];
        subscription = existing[0].subscription;
        stripeCustomerId = existing[0].stripeCustomerId;

        if (!existing[0].name && googleUser.name) {
          await client.query(`UPDATE "User" SET name = $1 WHERE id = $2`, [googleUser.name, userId]);
        }
      } else {
        userId = crypto.randomUUID();
        userName = googleUser.name || googleUser.email.split("@")[0];
        subscription = "free";
        stripeCustomerId = null;

        const placeholderHash = `oauth_google_${crypto.randomBytes(32).toString("hex")}`;
        await client.query(
          `INSERT INTO "User" (id, email, name, "passwordHash", subscription) VALUES ($1, $2, $3, $4, $5)`,
          [userId, googleUser.email.toLowerCase(), userName, placeholderHash, subscription]
        );
      }

      const authPayload = JSON.stringify({
        userId,
        email: googleUser.email.toLowerCase(),
        name: userName,
        subscription,
        stripeCustomerId,
        provider: "google",
      });
      const encoded = Buffer.from(authPayload).toString("base64url");

      return NextResponse.redirect(`${baseUrl}${returnTo}?auth_success=${encoded}`);
    } finally {
      await client.end();
    }
  } catch (e: any) {
    console.error("Google OAuth error:", e);
    return errorRedirect("server_error");
  }
}
