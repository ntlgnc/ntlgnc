import { NextResponse } from "next/server";
import { Client } from "pg";

const DB_URL = process.env.DATABASE_URL;

// ── CoinGecko market-cap cache (24h TTL) ──
let mcapCache: { rankings: Record<string, number>; fetchedAt: number } | null = null;
const MCAP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Common CoinGecko id → Binance symbol overrides
const ID_OVERRIDES: Record<string, string> = {
  "avalanche-2": "AVAXUSDT",
  "matic-network": "MATICUSDT",
  "shiba-inu": "SHIBUSDT",
  "bitcoin-cash": "BCHUSDT",
  "crypto-com-chain": "CROUSDT",
  "lido-dao": "LDOUSDT",
  "wrapped-bitcoin": "WBTCUSDT",
  "leo-token": "LEOUSDT",
  "chainlink": "LINKUSDT",
  "internet-computer": "ICPUSDT",
  "the-open-network": "TONUSDT",
  "binancecoin": "BNBUSDT",
  "staked-ether": "STETHUSDT",
};

async function fetchMcapRankings(): Promise<Record<string, number>> {
  // Return cache if fresh
  if (mcapCache && Date.now() - mcapCache.fetchedAt < MCAP_TTL_MS) {
    return mcapCache.rankings;
  }

  const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

  const coins: { id: string; symbol: string; market_cap_rank: number }[] = await res.json();
  const rankings: Record<string, number> = {};

  for (const c of coins) {
    // Use override if available, otherwise derive from ticker symbol
    const binanceSymbol = ID_OVERRIDES[c.id] || (c.symbol.toUpperCase() + "USDT");
    rankings[binanceSymbol] = c.market_cap_rank;
  }

  mcapCache = { rankings, fetchedAt: Date.now() };
  return rankings;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── Market cap rankings ──
  if (action === "market-cap-rank") {
    try {
      const rankings = await fetchMcapRankings();
      return NextResponse.json({ rankings });
    } catch (e: any) {
      return NextResponse.json({ error: e.message, rankings: {} }, { status: 502 });
    }
  }

  // ── Default: coin list from DB ──
  if (!DB_URL) return NextResponse.json({ error: "No DATABASE_URL" }, { status: 500 });

  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  try {
    const { rows } = await client.query(`
      SELECT symbol, COUNT(*)::int as cnt
      FROM "Candle1m"
      WHERE symbol NOT LIKE 'i%'
      GROUP BY symbol
      HAVING COUNT(*) >= 100
      ORDER BY cnt DESC
    `);

    return NextResponse.json({
      coins: rows.map((r: any) => r.symbol),
      count: rows.length,
    });
  } finally {
    await client.end();
  }
}
