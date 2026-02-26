import { NextResponse } from "next/server";
import crypto from "crypto";

/**
 * GET /api/auth/oauth/twitter?returnTo=/feed
 * Redirects to Twitter's OAuth 2.0 consent screen (with PKCE).
 * The returnTo path is encoded in the state param so it survives the full OAuth round-trip.
 */
export async function GET(req: Request) {
  const clientId = process.env.TWITTER_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "TWITTER_CLIENT_ID not configured" }, { status: 500 });
  }

  const reqUrl = new URL(req.url);
  const returnTo = reqUrl.searchParams.get("returnTo") || "/";

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const redirectUri = `${baseUrl}/api/auth/oauth/twitter/callback`;

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  // Encode returnTo in state so it survives the OAuth round-trip
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = nonce + "." + Buffer.from(returnTo).toString("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "tweet.read users.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const response = NextResponse.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
  response.cookies.set("twitter_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return response;
}
