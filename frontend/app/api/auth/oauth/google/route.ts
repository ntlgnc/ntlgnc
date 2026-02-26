import { NextResponse } from "next/server";
import crypto from "crypto";

/**
 * GET /api/auth/oauth/google?returnTo=/feed
 * Redirects to Google's OAuth consent screen.
 * returnTo is encoded in the state param.
 */
export async function GET(req: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_CLIENT_ID not configured" }, { status: 500 });
  }

  const reqUrl = new URL(req.url);
  const returnTo = reqUrl.searchParams.get("returnTo") || "/";

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const redirectUri = `${baseUrl}/api/auth/oauth/google/callback`;

  // Encode returnTo in state
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = nonce + "." + Buffer.from(returnTo).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
