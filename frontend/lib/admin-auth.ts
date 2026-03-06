import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const ADMIN_TOKEN_HASH = process.env.ADMIN_TOKEN_HASH || "";

/** Validate an admin request by checking the Bearer token against the stored hash. */
export function validateAdminRequest(req: NextRequest | Request): boolean {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (!token || !ADMIN_TOKEN_HASH) return false;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return hash === ADMIN_TOKEN_HASH;
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
