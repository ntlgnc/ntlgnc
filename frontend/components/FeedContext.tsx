"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useAuth } from "./AuthContext";

/* ═══════════════════════════════════════════
   Feed Config — a "cloned" card the user watches
   ═══════════════════════════════════════════ */
export type FeedItem = {
  id: string;              // UUID from DB (or temp client ID)
  symbol: string;          // e.g. "BTCUSDT"
  models: string[];        // e.g. ["claude-opus", "gpt-4o-mini"]
  horizon: string;         // "all" | "5" | "15" | "30" | "60"
  inverse: boolean;
  label?: string;
};

export type SignalEntry = {
  id: string;
  feedConfigId: string;
  symbol: string;
  direction: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entryPrice: number;
  models: string[];
  horizon: string;
  createdAt: string;
  exitPrice?: number;
  returnPct?: number;
  resolvedAt?: string;
};

export type ScoreSummary = {
  daily: { signals: number; wins: number; returnPct: number; periodKey: string };
  weekly: { signals: number; wins: number; returnPct: number; periodKey: string };
  monthly: { signals: number; wins: number; returnPct: number; periodKey: string };
  runningTotal: { signals: number; wins: number; returnPct: number };
};

export type StrategyInfo = {
  id: string;
  name: string;
  coins: string[];
  models: string[];
  horizons: string[];
  signalType: string;
  active: boolean;
};

export type StrategySignalEntry = {
  id: string;
  strategyId: string;
  strategyName?: string;
  symbol: string;
  direction: "BUY" | "SELL";
  confidence: number;
  entryPrice: number;
  models: string[];
  horizon: string;
  regime: string;
  createdAt: string;
  exitPrice?: number;
  returnPct?: number;
  resolvedAt?: string;
};

const DEFAULT_SCORES: ScoreSummary = {
  daily: { signals: 0, wins: 0, returnPct: 0, periodKey: "" },
  weekly: { signals: 0, wins: 0, returnPct: 0, periodKey: "" },
  monthly: { signals: 0, wins: 0, returnPct: 0, periodKey: "" },
  runningTotal: { signals: 0, wins: 0, returnPct: 0 },
};

type FeedContextType = {
  feedItems: FeedItem[];
  signals: SignalEntry[];
  scores: ScoreSummary;
  strategies: StrategyInfo[];
  strategySignals: StrategySignalEntry[];
  strategyPerformance: { total: number; wins: number; totalReturn: string; sharpe: string } | null;
  loading: boolean;
  addFeedItem: (item: Omit<FeedItem, "id">) => Promise<void>;
  removeFeedItem: (id: string) => Promise<void>;
  updateFeedItem: (id: string, updates: Partial<FeedItem>) => Promise<void>;
  refreshSignals: () => Promise<void>;
  feedJsonUrl: string | null;
};

const FeedContext = createContext<FeedContextType | null>(null);

export function useFeed() {
  const ctx = useContext(FeedContext);
  if (!ctx) throw new Error("useFeed must be inside FeedProvider");
  return ctx;
}

const LOCAL_KEY = "ntlgnc_feed";

function loadLocal(): FeedItem[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]");
  } catch { return []; }
}

function saveLocal(items: FeedItem[]) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(items)); } catch {}
}

export function FeedProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [scores, setScores] = useState<ScoreSummary>(DEFAULT_SCORES);
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [strategySignals, setStrategySignals] = useState<StrategySignalEntry[]>([]);
  const [strategyPerformance, setStrategyPerformance] = useState<{ total: number; wins: number; totalReturn: string; sharpe: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  // Load feed items + strategy data on mount / login
  useEffect(() => {
    if (user.isLoggedIn && user.userId && !loadedRef.current) {
      loadedRef.current = true;
      setLoading(true);

      // Fetch both feed items and strategy data in parallel
      const feedPromise = fetch(`/api/feed?userId=${user.userId}`)
        .then(r => r.json())
        .then(data => {
          if (data.items) setFeedItems(data.items);
          if (data.signals) setSignals(data.signals);
          if (data.scores) setScores(data.scores);
        })
        .catch(() => {
          setFeedItems(loadLocal());
        });

      const strategyPromise = fetch(`/api/strategy?userId=${user.userId}`)
        .then(r => r.json())
        .then(data => {
          if (data.strategies) {
            setStrategies(data.strategies.map((s: any) => ({
              id: s.id,
              name: s.name,
              coins: s.coins || [],
              models: s.models || [],
              horizons: s.horizons || [],
              signalType: s.signalType || "both",
              active: s.active,
            })));
          }
          if (data.signals) {
            // Map strategy names onto signals
            const stratMap = new Map((data.strategies || []).map((s: any) => [s.id, s.name]));
            setStrategySignals(data.signals.map((s: any) => ({
              id: s.id,
              strategyId: s.strategyId,
              strategyName: stratMap.get(s.strategyId) || "Strategy",
              symbol: s.symbol,
              direction: s.direction,
              confidence: s.confidence || 0,
              entryPrice: s.entryPrice || 0,
              models: s.models || [],
              horizon: s.horizon || "all",
              regime: s.regime || "",
              createdAt: s.createdAt,
              exitPrice: s.exitPrice,
              returnPct: s.returnPct,
              resolvedAt: s.resolvedAt,
            })));
          }
          if (data.performance?.overall) {
            setStrategyPerformance(data.performance.overall);
          }
        })
        .catch(() => {});

      Promise.all([feedPromise, strategyPromise]).finally(() => setLoading(false));
    } else if (!user.isLoggedIn) {
      loadedRef.current = false;
      setFeedItems(loadLocal());
      setSignals([]);
      setScores(DEFAULT_SCORES);
      setStrategies([]);
      setStrategySignals([]);
      setStrategyPerformance(null);
    }
  }, [user.isLoggedIn, user.userId]);

  // Save locally whenever feed changes
  useEffect(() => { saveLocal(feedItems); }, [feedItems]);

  const addFeedItem = useCallback(async (item: Omit<FeedItem, "id">) => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newItem: FeedItem = { id: tempId, ...item };

    // Optimistic add
    setFeedItems(prev => [...prev, newItem]);

    if (user.isLoggedIn && user.userId) {
      try {
        const res = await fetch("/api/feed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.userId, action: "add", item }),
        });
        const data = await res.json();
        if (data.id) {
          // Replace temp ID with server ID
          setFeedItems(prev => prev.map(f => f.id === tempId ? { ...f, id: data.id } : f));
        }
      } catch {}
    }
  }, [user.isLoggedIn, user.userId]);

  const removeFeedItem = useCallback(async (id: string) => {
    setFeedItems(prev => prev.filter(f => f.id !== id));

    if (user.isLoggedIn && user.userId && !id.startsWith("temp-")) {
      try {
        await fetch("/api/feed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.userId, action: "remove", itemId: id }),
        });
      } catch {}
    }
  }, [user.isLoggedIn, user.userId]);

  const updateFeedItem = useCallback(async (id: string, updates: Partial<FeedItem>) => {
    setFeedItems(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));

    if (user.isLoggedIn && user.userId && !id.startsWith("temp-")) {
      try {
        await fetch("/api/feed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.userId, action: "update", itemId: id, updates }),
        });
      } catch {}
    }
  }, [user.isLoggedIn, user.userId]);

  const refreshSignals = useCallback(async () => {
    if (!user.isLoggedIn || !user.userId) return;
    try {
      const [feedRes, stratRes] = await Promise.all([
        fetch(`/api/signals?userId=${user.userId}`).catch(() => null),
        fetch(`/api/strategy?userId=${user.userId}`).catch(() => null),
      ]);
      if (feedRes) {
        const data = await feedRes.json();
        if (data.signals) setSignals(data.signals);
        if (data.scores) setScores(data.scores);
      }
      if (stratRes) {
        const data = await stratRes.json();
        if (data.strategies) {
          setStrategies(data.strategies.map((s: any) => ({
            id: s.id, name: s.name, coins: s.coins || [], models: s.models || [],
            horizons: s.horizons || [], signalType: s.signalType || "both", active: s.active,
          })));
        }
        if (data.signals) {
          const stratMap = new Map((data.strategies || []).map((s: any) => [s.id, s.name]));
          setStrategySignals(data.signals.map((s: any) => ({
            id: s.id, strategyId: s.strategyId,
            strategyName: stratMap.get(s.strategyId) || "Strategy",
            symbol: s.symbol, direction: s.direction, confidence: s.confidence || 0,
            entryPrice: s.entryPrice || 0, models: s.models || [], horizon: s.horizon || "all",
            regime: s.regime || "", createdAt: s.createdAt,
            exitPrice: s.exitPrice, returnPct: s.returnPct, resolvedAt: s.resolvedAt,
          })));
        }
        if (data.performance?.overall) setStrategyPerformance(data.performance.overall);
      }
    } catch {}
  }, [user.isLoggedIn, user.userId]);

  // Auto-refresh signals every 60s for logged-in users
  useEffect(() => {
    if (!user.isLoggedIn || !user.userId) return;
    refreshSignals();
    const iv = setInterval(refreshSignals, 60_000);
    return () => clearInterval(iv);
  }, [user.isLoggedIn, user.userId, refreshSignals]);

  const feedJsonUrl = user.isLoggedIn && user.userId
    ? `/api/feed?userId=${user.userId}&format=json`
    : null;

  return (
    <FeedContext.Provider value={{
      feedItems, signals, scores,
      strategies, strategySignals, strategyPerformance,
      loading,
      addFeedItem, removeFeedItem, updateFeedItem,
      refreshSignals, feedJsonUrl,
    }}>
      {children}
    </FeedContext.Provider>
  );
}
