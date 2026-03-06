import { NextRequest, NextResponse } from "next/server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.CLAUDE_OPUS_MODEL || "anthropic/claude-opus-4.6";

export async function POST(req: NextRequest) {
  if (!OPENROUTER_KEY) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY not configured" }, { status: 500 });
  }

  try {
    const { prompt, max_tokens = 300 } = await req.json();
    
    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "prompt required" }, { status: 400 });
    }

    // Rate limit: max prompt size to prevent abuse
    if (prompt.length > 5000) {
      return NextResponse.json({ error: "prompt too long" }, { status: 400 });
    }

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "HTTP-Referer": "https://fracmap.com",
        "X-Title": "FRACMAP Signal Lab",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    
    if (data.error) {
      return NextResponse.json({ error: data.error.message || "LLM call failed" }, { status: 500 });
    }

    const text = data.choices?.[0]?.message?.content || "";
    return NextResponse.json({ text });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
