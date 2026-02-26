"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";

/* ═══════════════════════════════════════════════════
   ALL MODELS (14 total — matches backend provider IDs)
   No same-provider restriction — users can pick multiple
   from the same family (e.g. Claude Haiku + Claude Sonnet)
   ═══════════════════════════════════════════════════ */
export type ModelDef = {
  id: string;
  name: string;
  short: string;
  family: string;
  hex: string;
  tier: "fast" | "mid" | "slow";
  icon: string;
};

export const ALL_MODELS: ModelDef[] = [
  { id: "gpt-4o-mini",          name: "GPT-4o Mini",         short: "GPT",       family: "openai",     hex: "#10a37f", tier: "fast",  icon: "G" },
  { id: "claude-haiku",         name: "Claude 3.5 Haiku",    short: "Haiku",     family: "anthropic",  hex: "#e0b0ff", tier: "fast",  icon: "C" },
  { id: "claude-sonnet",        name: "Claude Sonnet 4.5",    short: "Sonnet",    family: "anthropic",  hex: "#c77dff", tier: "mid",   icon: "C" },
  { id: "claude-opus",          name: "Claude Opus 4.6",      short: "Opus",      family: "anthropic",  hex: "#9b59b6", tier: "slow",  icon: "C" },
  { id: "grok-mini",            name: "Grok 3 Mini",         short: "Grok-m",    family: "xai",        hex: "#ff9b70", tier: "fast",  icon: "G" },
  { id: "grok",                 name: "Grok 3",              short: "Grok",      family: "xai",        hex: "#ff6b35", tier: "mid",   icon: "G" },
  { id: "gemini-flash-lite",    name: "Gemini 2.0 Flash Lite",short: "Gem-L",     family: "google",     hex: "#7baaf7", tier: "fast",  icon: "G" },
  { id: "gemini-flash",         name: "Gemini 2.0 Flash",     short: "Gemini",    family: "google",     hex: "#4285f4", tier: "mid",   icon: "G" },
  { id: "llama-70b",            name: "Llama 3.3 70B",       short: "Llama",     family: "meta",       hex: "#a855f7", tier: "mid",   icon: "L" },
  { id: "mistral-medium",       name: "Mistral Medium 3",    short: "Mist-M",    family: "mistral",    hex: "#f97316", tier: "fast",  icon: "M" },
  { id: "mistral-large",        name: "Mistral Large 2512",  short: "Mistral",   family: "mistral",    hex: "#ea580c", tier: "mid",   icon: "M" },
  { id: "deepseek-v3",          name: "DeepSeek V3.2",        short: "DS",        family: "deepseek",   hex: "#00d4aa", tier: "fast",  icon: "D" },
  { id: "perplexity-sonar",     name: "Perplexity Sonar",    short: "Pplx",      family: "perplexity", hex: "#22d3ee", tier: "fast",  icon: "P" },
  { id: "perplexity-sonar-pro", name: "Perplexity Sonar Pro",short: "Pplx-P",    family: "perplexity", hex: "#06b6d4", tier: "mid",   icon: "P" },
];

export const MODEL_FAMILIES = [
  { id: "openai",     name: "OpenAI",     hex: "#10a37f" },
  { id: "anthropic",  name: "Anthropic",  hex: "#c77dff" },
  { id: "xai",        name: "xAI",        hex: "#ff6b35" },
  { id: "google",     name: "Google",     hex: "#4285f4" },
  { id: "meta",       name: "Meta",       hex: "#a855f7" },
  { id: "mistral",    name: "Mistral",    hex: "#ea580c" },
  { id: "deepseek",   name: "DeepSeek",   hex: "#00d4aa" },
  { id: "perplexity", name: "Perplexity", hex: "#06b6d4" },
];

export const MAX_SELECTED = 15;
export const DEFAULT_SELECTED: string[] = [
  "gpt-4o-mini", "claude-haiku", "grok-mini", "gemini-flash-lite", "deepseek-v3", "mistral-medium",
];

export function getModel(id: string): ModelDef | undefined {
  return ALL_MODELS.find((m) => m.id === id);
}

export function modelColor(id: string): string {
  return getModel(id)?.hex || "#888";
}

/* ═══ USER STATE ═══ */
export type UserState = {
  isLoggedIn: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  subscription: "anonymous" | "registered" | "premium";
  stripeCustomerId: string | null;
  trialSecondsRemaining: number;
  trialActive: boolean;
  trialStartedAt: number | null;
  heroCoins: [string, string];
  selectedModels: string[];
  authProvider?: string; // "email" | "google" | "twitter"
};

const DAILY_TRIAL_SECONDS = 1200;

const DEFAULT_STATE: UserState = {
  isLoggedIn: false, userId: null, email: null, displayName: null,
  subscription: "anonymous", stripeCustomerId: null,
  trialSecondsRemaining: DAILY_TRIAL_SECONDS, trialActive: false, trialStartedAt: null,
  heroCoins: ["BTCUSDT", "ETHUSDT"],
  selectedModels: [...DEFAULT_SELECTED],
};

/* ═══ CONTEXT ═══ */
type AuthContextType = {
  user: UserState;
  register: (email: string, password: string, name?: string) => Promise<{ ok: boolean; error?: string }>;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  startCheckout: () => Promise<void>;
  activateTrial: () => void;
  hasAccess: () => boolean;
  setHeroCoin: (slot: 0 | 1, symbol: string) => void;
  showAuthModal: boolean;
  setShowAuthModal: (v: boolean) => void;
  selectedModels: ModelDef[];
  toggleModelSelection: (id: string) => void;
  setSelectedModels: (ids: string[]) => void;
  showModelPicker: boolean;
  setShowModelPicker: (v: boolean) => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}

const STORAGE_KEY = "ntlgnc_user";

function loadState(): UserState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    const today = new Date().toDateString();
    const trialDay = parsed.trialStartedAt ? new Date(parsed.trialStartedAt).toDateString() : null;
    if (trialDay !== today) {
      parsed.trialSecondsRemaining = DAILY_TRIAL_SECONDS;
      parsed.trialActive = false;
      parsed.trialStartedAt = null;
    }
    if (parsed.selectedModels) {
      parsed.selectedModels = parsed.selectedModels.filter((id: string) => ALL_MODELS.some(m => m.id === id));
    }
    if (!parsed.selectedModels || parsed.selectedModels.length === 0) {
      parsed.selectedModels = [...DEFAULT_SELECTED];
    }
    return { ...DEFAULT_STATE, ...parsed };
  } catch { return DEFAULT_STATE; }
}

function saveState(s: UserState) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

/* ═══ Server-side preference sync ═══ */
async function savePrefsToServer(userId: string, selectedModels: string[], heroCoins: [string, string]) {
  try {
    await fetch("/api/auth/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, selectedModels, heroCoins }),
    });
  } catch {}
}

async function loadPrefsFromServer(userId: string): Promise<{ selectedModels?: string[]; heroCoins?: [string, string] } | null> {
  try {
    const res = await fetch(`/api/auth/preferences?userId=${userId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserState>(DEFAULT_STATE);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const prefsSyncRef = useRef(false);
  const oauthHandledRef = useRef(false);
  const hydratedRef = useRef(false);

  useEffect(() => { setUser(loadState()); }, []);
  useEffect(() => {
    // Skip saving on initial render (before loadState has updated user)
    if (!hydratedRef.current) { hydratedRef.current = true; return; }
    saveState(user);
  }, [user]);

  /* ═══ OAuth callback handler ═══
     After Google/Twitter redirect, the URL will contain ?auth_success=<base64>
     or ?auth_error=<reason>. We read it here and log the user in.
  */
  useEffect(() => {
    if (typeof window === "undefined" || oauthHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);

    const authSuccess = params.get("auth_success");
    const authError = params.get("auth_error");

    if (authSuccess) {
      oauthHandledRef.current = true;
      try {
        const decoded = JSON.parse(atob(authSuccess.replace(/-/g, "+").replace(/_/g, "/")));
        setUser(u => ({
          ...u,
          isLoggedIn: true,
          userId: decoded.userId,
          email: decoded.email,
          displayName: decoded.name || decoded.email?.split("@")[0] || "User",
          subscription: decoded.subscription === "premium" ? "premium" : "registered",
          stripeCustomerId: decoded.stripeCustomerId || null,
          authProvider: decoded.provider || "email",
        }));
        // Clean up URL (remove ?auth_success from address bar)
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, "", cleanUrl);
      } catch (e) {
        console.error("Failed to parse OAuth callback:", e);
      }
    } else if (authError) {
      oauthHandledRef.current = true;
      console.warn("OAuth error:", authError);
      // Show an error — could set state here, but for now just clean URL
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
      // Re-open auth modal to let them try again
      setShowAuthModal(true);
    }
  }, []);

  // Load server-side prefs when user logs in
  useEffect(() => {
    if (user.isLoggedIn && user.userId && !prefsSyncRef.current) {
      prefsSyncRef.current = true;
      loadPrefsFromServer(user.userId).then(prefs => {
        if (prefs?.selectedModels && prefs.selectedModels.length > 0) {
          const valid = prefs.selectedModels.filter((id: string) => ALL_MODELS.some(m => m.id === id));
          if (valid.length > 0) {
            setUser(u => ({ ...u, selectedModels: valid.slice(0, MAX_SELECTED) }));
          }
        }
        if (prefs?.heroCoins) {
          setUser(u => ({ ...u, heroCoins: prefs.heroCoins as [string, string] }));
        }
      });
    }
    if (!user.isLoggedIn) {
      prefsSyncRef.current = false;
    }
  }, [user.isLoggedIn, user.userId]);

  // Trial countdown
  useEffect(() => {
    if (!user.trialActive || user.subscription === "premium") return;
    if (user.trialSecondsRemaining <= 0) { setUser((u) => ({ ...u, trialActive: false })); return; }
    const iv = setInterval(() => {
      setUser((u) => {
        const r = Math.max(0, u.trialSecondsRemaining - 1);
        return { ...u, trialSecondsRemaining: r, trialActive: r > 0 };
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [user.trialActive, user.trialSecondsRemaining, user.subscription]);

  const register = useCallback(async (email: string, password: string, name?: string) => {
    try {
      const res = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name }) });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "Registration failed" };
      setUser((u) => ({ ...u, isLoggedIn: true, userId: data.userId, email: data.email, displayName: data.name || email.split("@")[0], subscription: "registered", authProvider: "email" }));
      setShowAuthModal(false);
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e.message || "Network error" }; }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "Login failed" };
      setUser((u) => ({ ...u, isLoggedIn: true, userId: data.userId, email: data.email, displayName: data.name || email.split("@")[0], subscription: data.subscription === "premium" ? "premium" : "registered", stripeCustomerId: data.stripeCustomerId || null, authProvider: "email" }));
      setShowAuthModal(false);
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e.message || "Network error" }; }
  }, []);

  const logout = useCallback(() => { setUser({ ...DEFAULT_STATE }); localStorage.removeItem(STORAGE_KEY); prefsSyncRef.current = false; oauthHandledRef.current = false; }, []);

  const startCheckout = useCallback(async () => {
    if (!user.isLoggedIn) { setShowAuthModal(true); return; }
    try {
      const res = await fetch("/api/stripe/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: user.userId, email: user.email }) });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch (e) { console.error("Checkout error:", e); }
  }, [user.isLoggedIn, user.userId, user.email]);

  const activateTrial = useCallback(() => {
    if (user.subscription === "premium" || user.trialSecondsRemaining <= 0) return;
    if (!user.isLoggedIn) { setShowAuthModal(true); return; }
    setUser((u) => ({ ...u, trialActive: true, trialStartedAt: Date.now() }));
  }, [user.subscription, user.trialSecondsRemaining, user.isLoggedIn]);

  const isDev = typeof window !== "undefined" && window.location.hostname === "localhost";
  const hasAccess = useCallback(() => isDev || user.subscription === "premium" || user.trialActive, [isDev, user.subscription, user.trialActive]);

  const setHeroCoin = useCallback((slot: 0 | 1, symbol: string) => {
    setUser((u) => {
      const c = [...u.heroCoins] as [string, string];
      c[slot] = symbol;
      if (u.isLoggedIn && u.userId) savePrefsToServer(u.userId, u.selectedModels, c);
      return { ...u, heroCoins: c };
    });
  }, []);

  const selectedModels = user.selectedModels
    .map(id => getModel(id))
    .filter((m): m is ModelDef => !!m);

  const toggleModelSelection = useCallback((id: string) => {
    setUser((u) => {
      const current = [...u.selectedModels];
      const idx = current.indexOf(id);
      if (idx >= 0) {
        if (current.length <= 1) return u;
        current.splice(idx, 1);
      } else {
        if (current.length >= MAX_SELECTED) return u;
        current.push(id);
      }
      if (u.isLoggedIn && u.userId) savePrefsToServer(u.userId, current, u.heroCoins);
      return { ...u, selectedModels: current };
    });
  }, []);

  const setSelectedModelsDirect = useCallback((ids: string[]) => {
    const valid = ids.filter(id => ALL_MODELS.some(m => m.id === id)).slice(0, MAX_SELECTED);
    if (valid.length === 0) return;
    setUser((u) => {
      if (u.isLoggedIn && u.userId) savePrefsToServer(u.userId, valid, u.heroCoins);
      return { ...u, selectedModels: valid };
    });
  }, []);

  return (
    <AuthContext.Provider value={{
      user, register, login, logout, startCheckout, activateTrial, hasAccess, setHeroCoin,
      showAuthModal, setShowAuthModal,
      selectedModels, toggleModelSelection, setSelectedModels: setSelectedModelsDirect,
      showModelPicker, setShowModelPicker,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
