"use client";

import { usePathname } from "next/navigation";

const GOLD = "#D4A843";
const MUTED = "rgba(255,255,255,0.4)";

const pages = [
  { href: "/admin", label: "Admin Home" },
  { href: "/admin/filter-audit", label: "Filter Audit" },
  { href: "/admin/filter-impact", label: "Filter Impact" },
  { href: "/admin/filter-matrix", label: "Filter Matrix" },
];

export default function AdminNav() {
  const path = usePathname();

  return (
    <div
      className="flex items-center gap-1 mb-4 pb-3"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <span
        className="text-[13px] font-mono font-bold tracking-wide mr-3"
        style={{ color: GOLD }}
      >
        ADMIN
      </span>
      {pages.map((p) => {
        const active = path === p.href;
        return (
          <a
            key={p.href}
            href={p.href}
            className="px-3 py-1.5 text-[11px] font-mono font-bold rounded transition-all"
            style={{
              color: active ? GOLD : MUTED,
              background: active
                ? "rgba(212,168,67,0.12)"
                : "rgba(255,255,255,0.03)",
              border: `1px solid ${
                active ? "rgba(212,168,67,0.25)" : "rgba(255,255,255,0.06)"
              }`,
            }}
          >
            {p.label}
          </a>
        );
      })}
    </div>
  );
}
