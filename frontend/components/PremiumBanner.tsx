"use client";

import { useAuth } from "./AuthContext";

export default function PremiumBanner() {
  const { user, activateTrial, startCheckout, setShowAuthModal } = useAuth();

  if (user.subscription === "premium") return null;

  const secs = user.trialSecondsRemaining;
  const mins = Math.floor(secs / 60);
  const secsPart = secs % 60;
  const timeStr = `${mins}:${secsPart.toString().padStart(2, "0")}`;
  const lowTime = user.trialActive && secs < 120;

  // Trial running
  if (user.trialActive && secs > 0) {
    return (
      <div className={`rounded-lg border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2 ${
        lowTime
          ? "border-down/40 bg-down/5"
          : "border-line bg-panel2"
      }`}>
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${lowTime ? "bg-down" : "bg-up"} animate-pulseSoft`} />
          <span className="text-xs font-semibold">
            {lowTime ? "Trial ending" : "Trial active"} — <span className="tabular">{timeStr}</span> remaining
          </span>
        </div>
        <button
          onClick={startCheckout}
          className={`text-xs font-semibold px-3 py-1 rounded-lg transition-colors ${
            lowTime
              ? "bg-brand text-white hover:bg-brand/90"
              : "text-brand hover:bg-brand/10"
          }`}
        >
          Go unlimited — $20/mo
        </button>
      </div>
    );
  }

  // Trial expired (logged in, 0 seconds left)
  if (user.isLoggedIn && secs <= 0) {
    return (
      <div className="rounded-lg border border-brand/30 bg-brand/5 px-4 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm">🔒</span>
          <div>
            <div className="text-xs font-semibold">Your daily preview has ended</div>
            <div className="text-[10px] text-muted">Unlock all AI predictions and Market Desk debates — unlimited, all day</div>
          </div>
        </div>
        <button onClick={startCheckout} className="text-xs font-bold px-4 py-1.5 rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
          Subscribe — $20/month
        </button>
      </div>
    );
  }

  // Not started (anonymous or registered, trial available)
  return (
    <div className="rounded-lg border border-line bg-panel2 px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
      <div className="text-xs text-muted">
        <span className="font-semibold text-white">3 AI models compete</span> — ChatGPT, Claude & Grok predict live, debate in public, scored in real-time
      </div>
      <div className="flex items-center gap-2">
        {user.isLoggedIn ? (
          <button onClick={activateTrial} className="text-xs font-semibold text-brand hover:text-white transition-colors">
            Start 20-min free preview →
          </button>
        ) : (
          <button onClick={() => setShowAuthModal(true)} className="text-xs font-semibold text-brand hover:text-white transition-colors">
            Sign up for free preview →
          </button>
        )}
        <span className="text-muted2 text-[10px]">Or $20/mo for unlimited</span>
      </div>
    </div>
  );
}
