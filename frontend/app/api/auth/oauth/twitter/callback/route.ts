import { NextResponse } from "next/server";
import { Client } from "pg";
import crypto from "crypto";
import { cookies } from "next/headers";

/**
 * GET /api/auth/oauth/twitter/callback?code=...&state=...
 * The state param contains nonce.base64url(returnTo).
 * After auth, redirects directly to returnTo?auth_success=... (e.g. /feed?auth_success=...)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state") || "";

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  // Decode returnTo from state (format: nonce.base64url)
  let returnTo = "/";
  try {
    const dotIdx = state.indexOf(".");
    if (dotIdx > 0) {
      returnTo = Buffer.from(state.slice(dotIdx + 1), "base64url").toString("utf8") || "/";
    }
  } catch { returnTo = "/"; }

  // Helper to redirect with returnTo preserved
  const errorRedirect = (reason: string) =>
    NextResponse.redirect(`${baseUrl}${returnTo}?auth_error=${reason}`);

  if (error || !code) {
    return errorRedirect(error || "no_code");
  }

  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorRedirect("twitter_not_configured");
  }

  const cookieStore = await cookies();
  const codeVerifier = cookieStore.get("twitter_code_verifier")?.value;
  if (!codeVerifier) {
    return errorRedirect("missing_verifier");
  }

  const redirectUri = `${baseUrl}/api/auth/oauth/twitter/callback`;

  try {
    // 1. Exchange code for tokens
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("Twitter token exchange failed:", tokenData);
      return errorRedirect("token_exchange_failed");
    }

    // 2. Fetch user info
    const userRes = await fetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();
    const twitterUser = userData.data;

    if (!twitterUser?.id) {
      return errorRedirect("no_twitter_user");
    }

    const twitterEmail = `${twitterUser.username}@twitter.fracmap.local`;
    const displayName = twitterUser.name || twitterUser.username;

    // 3. Create or get user in database
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
      const { rows: existing } = await client.query(
        `SELECT id, email, name, subscription, "stripeCustomerId" FROM "User" WHERE email = $1`,
        [twitterEmail.toLowerCase()]
      );

      let userId: string;
      let userName: string;
      let subscription: string;
      let stripeCustomerId: string | null;

      if (existing.length > 0) {
        userId = existing[0].id;
        userName = existing[0].name || displayName;
        subscription = existing[0].subscription;
        stripeCustomerId = existing[0].stripeCustomerId;

        if (existing[0].name !== displayName) {
          await client.query(`UPDATE "User" SET name = $1 WHERE id = $2`, [displayName, userId]);
        }
      } else {
        userId = crypto.randomUUID();
        userName = displayName;
        subscription = "free";
        stripeCustomerId = null;

        const placeholderHash = `oauth_twitter_${crypto.randomBytes(32).toString("hex")}`;
        await client.query(
          `INSERT INTO "User" (id, email, name, "passwordHash", subscription) VALUES ($1, $2, $3, $4, $5)`,
          [userId, twitterEmail.toLowerCase(), userName, placeholderHash, subscription]
        );
      }

      // 4. Redirect directly to returnTo with auth data
      const authPayload = JSON.stringify({
        userId,
        email: twitterEmail.toLowerCase(),
        name: userName,
        subscription,
        stripeCustomerId,
        provider: "twitter",
        twitterUsername: twitterUser.username,
      });
      const encoded = Buffer.from(authPayload).toString("base64url");

      const response = NextResponse.redirect(`${baseUrl}${returnTo}?auth_success=${encoded}`);
      response.cookies.delete("twitter_code_verifier");
      return response;
    } finally {
      await client.end();
    }
  } catch (e: any) {
    console.error("Twitter OAuth error:", e);
    return errorRedirect("server_error");
  }
}
