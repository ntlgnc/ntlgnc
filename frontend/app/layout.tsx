"use client";

import "./globals.css";
import { AuthProvider, useAuth } from "@/components/AuthContext";
import Link from "next/link";
import { usePathname } from "next/navigation";

const GOLD = "#D4A843";

function Nav() {
  const path = usePathname();
  const { user } = useAuth();
  const isAdmin = user?.email === process.env.NEXT_PUBLIC_ADMIN_EMAIL || user?.role === "admin";
  const isAdminRoute = path?.startsWith("/admin");

  // Don't show public nav on admin pages
  if (isAdminRoute) return null;

  const links = [
    { href: "/", label: "Home" },
    { href: "/signals", label: "Signals" },
    { href: "/research", label: "Research" },
    { href: "/pricing", label: "Pricing" },
  ];

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b" style={{ background: "rgba(8,10,16,0.95)", borderColor: "rgba(212,168,67,0.1)", backdropFilter: "blur(12px)" }}>
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-lg font-mono font-black tracking-tight" style={{ color: GOLD }}>NTLGNC</span>
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/70">Signal Lab</span>
        </Link>
        <div className="flex items-center gap-5">
          {user ? (
            <Link href="/signals" className="py-1.5 text-[11px] font-mono" style={{ color: "#22c55e" }}>
              {user.name || user.email?.split("@")[0]}
            </Link>
          ) : (
            <Link href="/login" className="px-4 py-1.5 rounded text-[11px] font-mono font-bold" style={{ background: GOLD, color: "#000" }}>
              Sign In
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin" className="py-1 text-[10px] font-mono" style={{ color: "rgba(167,139,250,0.6)" }}>
              ⚙
            </Link>
          )}
          <div className="w-px h-4" style={{ background: "rgba(255,255,255,0.08)" }} />
          {links.map(l => (
            <Link key={l.href} href={l.href} className="py-1.5 text-[12px] font-mono transition-all" style={{
              color: path === l.href ? GOLD : "rgba(255,255,255,0.6)",
            }}>
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>NTLGNC Signal Lab — AI-Powered Market Signals</title>
        <meta name="description" content="Autonomous AI trading signals with verified real-time performance. Every signal published live — open, close, and result." />
      </head>
      <body className="bg-[#060810] text-white min-h-screen" style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}>
        <AuthProvider>
          <Nav />
          <main className="pt-14">
            {children}
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
