export type ModelKey = "openai" | "claude" | "grok";

/** Provider names as stored in the DB (provider column) */
export type ProviderKey = "openai" | "anthropic" | "xai";

/** Map provider → display model key */
export const PROVIDER_TO_MODEL: Record<ProviderKey, ModelKey> = {
  openai: "openai",
  anthropic: "claude",
  xai: "grok",
};

export const MODEL_NAMES: Record<ModelKey, string> = {
  openai: "OpenAI",
  claude: "Claude",
  grok: "Grok",
};

export const MODEL_TECH: Record<ModelKey, string> = {
  openai: "gpt-4o-mini",
  claude: "claude-sonnet-4-5",
  grok: "grok-3",
};

export type FighterStats = {
  model: ModelKey;
  returnPct: number;
  returnUsd: number;
  accuracy: number;
  winRate: number;
  totalPreds: number;
  streak: string;
};

export type CoinPredictions = {
  openai: number | null;
  claude: number | null;
  grok: number | null;
};

export type CoinData = {
  rank: number;
  name: string;
  symbol: string;     // e.g. "BTC"
  dbSymbol: string;   // e.g. "BTCUSDT"
  icon: string;
  iconClass: string;
  price: number;
  change24h: number;
  predictions: Record<number, CoinPredictions>; // horizon → per-model predictions
};

export type CurvePoint = { t: number; v: number };

export type DashboardPayload = {
  updatedAt: string;
  fighters: FighterStats[];
  coins: CoinData[];
  curves: Record<ModelKey, number[]>;  // cumulative return arrays for chart
  round: number;
};
