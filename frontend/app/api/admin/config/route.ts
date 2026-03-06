import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { validateAdminRequest, unauthorizedResponse } from "@/lib/admin-auth";

// Path to the backend config file
const CONFIG_PATH = path.join(process.cwd(), "..", "backend", "model-config.json");

// Fallback: check a few possible locations
function getConfigPath(): string {
  const candidates = [
    CONFIG_PATH,
    path.join(process.cwd(), "backend", "model-config.json"),
    path.resolve("backend/model-config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return CONFIG_PATH; // default write location
}

function readConfig() {
  const p = getConfigPath();
  if (!existsSync(p)) {
    return { disabled: [], enabledForDebate: [], disabledCoins: [] };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { disabled: [], enabledForDebate: [], disabledCoins: [] };
  }
}

export async function GET(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  const config = readConfig();
  return NextResponse.json(config);
}

export async function POST(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  try {
    const body = await req.json();
    const { disabled, enabledForDebate, disabledCoins, loopIntervalMinutes } = body;

    if (!Array.isArray(disabled)) {
      return NextResponse.json({ error: "disabled must be an array" }, { status: 400 });
    }

    // Read existing config to preserve fields not being updated
    const existing = readConfig();

    const config = {
      _comment: "Models listed in 'disabled' will be skipped. Coins in 'disabledCoins' skip LLM calls but still collect candles. Edit via /admin page.",
      disabled: disabled,
      enabledForDebate: enabledForDebate || [],
      disabledCoins: Array.isArray(disabledCoins) ? disabledCoins : (existing.disabledCoins || []),
      loopIntervalMinutes: loopIntervalMinutes != null ? Number(loopIntervalMinutes) : (existing.loopIntervalMinutes || 5),
    };

    const p = getConfigPath();
    writeFileSync(p, JSON.stringify(config, null, 2), "utf8");

    return NextResponse.json({ ok: true, config });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
