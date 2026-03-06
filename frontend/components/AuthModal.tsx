"use client";

import { useState } from "react";
import { useAuth } from "./AuthContext";

export default function AuthModal() {
  const { showAuthModal, setShowAuthModal, register, login } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!showAuthModal) return null;

  const handleSubmit = async () => {
    setError(null);
    if (mode === "register" && !username.trim()) {
      setError("Username is required");
      return;
    }
    setLoading(true);
    const result = mode === "register"
      ? await register(email, password, username)
      : await login(email, password);
    setLoading(false);
    if (!result.ok) setError(result.error || "Something went wrong");
  };

  const handleGoogleLogin = () => {
    const returnTo = encodeURIComponent(window.location.pathname);
    window.location.href = `/api/auth/oauth/google?returnTo=${returnTo}`;
  };

  const handleTwitterLogin = () => {
    const returnTo = encodeURIComponent(window.location.pathname);
    window.location.href = `/api/auth/oauth/twitter?returnTo=${returnTo}`;
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowAuthModal(false)} />
      <div className="relative w-full max-w-md mx-4 bg-[var(--bg-card)] rounded-xl border border-[var(--border)] shadow-2xl overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[#10a37f] via-[#c77dff] to-[#ff6b35]" />
        <div className="p-6">
          <h2 className="text-xl font-bold mb-1">{mode === "register" ? "Create Account" : "Sign In"}</h2>
          <p className="text-sm opacity-60 mb-4">
            {mode === "register" ? "Join fracmap to access AI predictions" : "Welcome back"}
          </p>

          {/* OAuth buttons */}
          <div className="space-y-2 mb-4">
            <button onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-white text-gray-800 rounded-lg font-medium text-sm hover:bg-gray-100 transition-colors">
              <svg className="w-5 h-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Continue with Google
            </button>
            <button onClick={handleTwitterLogin}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#1DA1F2] text-white rounded-lg font-medium text-sm hover:bg-[#1a91da] transition-colors">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
              Continue with X / Twitter
            </button>
          </div>

          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-[var(--border)]" />
            <span className="text-xs opacity-40">or use email</span>
            <div className="flex-1 h-px bg-[var(--border)]" />
          </div>

          <div className="space-y-3">
            {mode === "register" && (
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-[#ff6b35]"
              />
            )}
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-[#ff6b35]"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              className="w-full px-3 py-2 bg-[var(--bg-main)] border border-[var(--border)] rounded-lg text-sm focus:outline-none focus:border-[#ff6b35]"
            />
          </div>

          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full mt-4 py-2.5 bg-[#ff6b35] hover:bg-[#ff5722] rounded-lg font-semibold text-sm transition-colors disabled:opacity-50"
          >
            {loading ? "..." : mode === "register" ? "Create Account" : "Sign In"}
          </button>

          <p className="text-center text-xs mt-3 opacity-50">
            {mode === "register" ? "Already have an account?" : "Need an account?"}{" "}
            <button onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(null); }}
              className="text-[#ff6b35] hover:underline">
              {mode === "register" ? "Sign in" : "Register"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
