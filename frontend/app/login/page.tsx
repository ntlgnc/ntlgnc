"use client";

import { useAuth } from "@/components/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const GOLD = "#D4A843";

export default function LoginPage() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user) router.push("/signals");
  }, [user, router]);

  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="text-center mb-8">
          <div className="text-lg font-mono font-black mb-1" style={{ color: GOLD }}>NTLGNC</div>
          <p className="text-[11px] font-mono text-white/55">Sign in to access real-time signals</p>
        </div>

        <div className="space-y-3">
          <a href="/api/auth/oauth/google" className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-lg text-[12px] font-mono font-semibold transition-all hover:opacity-90" style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.7)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </a>

          <a href="/api/auth/oauth/twitter" className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-lg text-[12px] font-mono font-semibold transition-all hover:opacity-90" style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.7)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            Continue with X (Twitter)
          </a>
        </div>

        <p className="text-[9px] font-mono text-white/40 text-center mt-6">
          By signing in you agree to our <a href="/terms" style={{ color: GOLD }}>Terms</a> and <a href="/privacy" style={{ color: GOLD }}>Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}
