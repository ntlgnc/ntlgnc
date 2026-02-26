"use client";

import { useAuth } from "./AuthContext";

/**
 * Full-screen paywall overlay.
 * Shows when:
 *  - user has no premium subscription AND
 *  - daily trial has expired (0 seconds left, trial not active)
 *
 * Blocks all interaction with underlying content.
 */
export default function PaywallOverlay() {
  const { user, startCheckout, setShowAuthModal } = useAuth();

  // Dev bypass — never block on localhost
  if (typeof window !== "undefined" && window.location.hostname === "localhost") return null;

  // Premium users — never blocked
  if (user.subscription === "premium") return null;

  // Trial is currently running — not blocked
  if (user.trialActive && user.trialSecondsRemaining > 0) return null;

  // Trial hasn't started yet AND user hasn't used it today — not blocked
  // (they can still browse until they activate the trial)
  if (!user.trialActive && user.trialSecondsRemaining > 0 && !user.trialStartedAt) return null;

  // If trial is used up (started today but 0 seconds left) — BLOCK
  const trialUsedUp = user.trialStartedAt !== null && user.trialSecondsRemaining <= 0;
  if (!trialUsedUp) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      {/* Blurred backdrop */}
      <div className="absolute inset-0 bg-[#06060b]/85 backdrop-blur-md" />

      {/* Lock card */}
      <div className="relative w-full max-w-lg mx-4 bg-[var(--bg-card)] rounded-2xl border border-[var(--border)] shadow-2xl overflow-hidden">
        {/* Gradient top bar */}
        <div className="h-1.5 bg-gradient-to-r from-[#10a37f] via-[#c77dff] to-[#ff6b35]" />

        <div className="p-8 text-center">
          {/* Lock icon */}
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-brand/10 border border-brand/20 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>

          <h2 className="text-xl font-bold mb-2 text-white">
            Your daily preview has ended
          </h2>
          <p className="text-sm mb-1" style={{ color: "var(--text-muted)" }}>
            You&apos;ve used your 20 minutes of free access for today.
          </p>
          <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
            Subscribe to unlock unlimited AI predictions, buy/sell signals, and your personal feed — all day, every day.
          </p>

          {/* Pricing card */}
          <div className="bg-brand/5 border border-brand/20 rounded-xl p-5 mb-6">
            <div className="flex items-baseline justify-center gap-1 mb-3">
              <span className="text-3xl font-extrabold text-white">$20</span>
              <span className="text-sm" style={{ color: "var(--text-muted)" }}>/month</span>
            </div>
            <ul className="space-y-2 text-sm text-left max-w-xs mx-auto" style={{ color: "var(--text-muted)" }}>
              <li className="flex items-start gap-2">
                <span className="text-[var(--up)] mt-0.5">✓</span>
                <span>Unlimited access to 20 AI model predictions</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--up)] mt-0.5">✓</span>
                <span>Custom signal feed with buy/sell alerts</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--up)] mt-0.5">✓</span>
                <span>JSON API access to your signals</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--up)] mt-0.5">✓</span>
                <span>Daily, weekly &amp; monthly performance tracking</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--up)] mt-0.5">✓</span>
                <span>Live Market Desk debates across 20 coins</span>
              </li>
            </ul>
          </div>

          {/* CTA */}
          {user.isLoggedIn ? (
            <button
              onClick={startCheckout}
              className="w-full py-3.5 rounded-xl bg-brand hover:bg-brand/90 text-white font-bold text-base transition-colors shadow-lg shadow-brand/20"
            >
              Subscribe — $20/month
            </button>
          ) : (
            <div className="space-y-3">
              <button
                onClick={() => setShowAuthModal(true)}
                className="w-full py-3.5 rounded-xl bg-brand hover:bg-brand/90 text-white font-bold text-base transition-colors shadow-lg shadow-brand/20"
              >
                Sign up &amp; Subscribe
              </button>
              <button
                onClick={() => setShowAuthModal(true)}
                className="text-xs font-medium text-brand hover:text-white transition-colors"
              >
                Already have an account? Sign in
              </button>
            </div>
          )}

          <p className="mt-4 text-[10px]" style={{ color: "var(--text-dim)" }}>
            Cancel anytime · Your preview resets tomorrow at midnight UTC
          </p>
        </div>
      </div>
    </div>
  );
}
