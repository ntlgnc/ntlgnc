import { NextRequest, NextResponse } from "next/server";

export async function middleware(req: NextRequest) {
  // Protect all /api/admin/* routes with Bearer token auth
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = auth.slice(7);
  const hash = process.env.ADMIN_TOKEN_HASH;
  if (!token || !hash) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Use Web Crypto API (Edge Runtime compatible)
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  if (hashHex !== hash) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/admin/:path*"],
};
