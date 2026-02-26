"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/AuthContext";

const GOLD = "#D4A843";

type SeatInfo = {
  cap: number; activeSeats: number; remaining: number;
  forSale: number; cheapestSeat: number | null; avgAsk: number | null;
  pricing: Record<string, number>;
  recentSales: any[];
};

type MarketSeat = {
  id: number; ask_price: number; expires_at: string; days_remaining: number; listed_at: string;
};

type MySeat = {
  id: number; purchased_at: string; expires_at: string; months_bought: number;
  price_paid: number; for_sale: boolean; ask_price: number | null;
};

export default function PricingPage() {
  const { user } = useAuth();
  const [info, setInfo] = useState<SeatInfo | null>(null);
  const [market, setMarket] = useState<MarketSeat[]>([]);
  const [mySeat, setMySeat] = useState<MySeat | null>(null);
  const [selectedMonths, setSelectedMonths] = useState(1);
  const [askPrice, setAskPrice] = useState("");
  const [buying, setBuying] = useState(false);
  const [listing, setListing] = useState(false);
  const [msg, setMsg] = useState("");

  const loadData = () => {
    fetch("/api/seats?action=status").then(r => r.json()).then(d => setInfo(d)).catch(() => {});
    fetch("/api/seats?action=marketplace").then(r => r.json()).then(d => { if (d.seats) setMarket(d.seats); }).catch(() => {});
    if (user?.id) {
      fetch(`/api/seats?action=my-seat&userId=${user.id}`).then(r => r.json()).then(d => setMySeat(d.seat)).catch(() => {});
    }
  };

  // Handle Stripe success redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success" && user?.id) {
      const months = parseInt(params.get("months") || "1");
      fetch("/api/seats", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "buy", userId: user.id, email: user.email, months }),
      }).then(r => r.json()).then(d => {
        if (d.seat) {
          setMsg(`Seat purchased! Expires ${new Date(d.seat.expires_at).toLocaleDateString()}. List it for profit below.`);
          loadData();
          // Clean URL
          window.history.replaceState({}, "", "/pricing");
        }
      }).catch(() => {});
    }
    if (params.get("checkout") === "cancelled") {
      setMsg("Checkout cancelled.");
      window.history.replaceState({}, "", "/pricing");
    }
  }, [user?.id]);

  useEffect(() => { loadData(); }, [user?.id]);

  const handleBuy = async () => {
    if (!user) { window.location.href = "/login"; return; }
    setBuying(true); setMsg("");
    try {
      // First check capacity
      const statusRes = await fetch("/api/seats?action=status");
      const statusData = await statusRes.json();
      if (statusData.remaining <= 0) {
        setMsg("All seats sold — check the marketplace below.");
        setBuying(false);
        return;
      }

      // Create Stripe checkout session
      const res = await fetch("/api/stripe/seat-checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, email: user.email, months: selectedMonths }),
      });
      const d = await res.json();
      if (d.url) {
        window.location.href = d.url; // Redirect to Stripe
      } else {
        // Stripe not configured — fall back to direct DB purchase (dev mode)
        const fallback = await fetch("/api/seats", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "buy", userId: user.id, email: user.email, months: selectedMonths }),
        });
        const fd = await fallback.json();
        if (fd.seat) { setMsg(`Seat purchased! Expires ${new Date(fd.seat.expires_at).toLocaleDateString()}`); loadData(); }
        else { setMsg(fd.error || d.message || "Error"); }
      }
    } catch { setMsg("Network error"); }
    setBuying(false);
  };

  const handleList = async () => {
    if (!mySeat || !askPrice) return;
    setListing(true); setMsg("");
    try {
      const res = await fetch("/api/seats", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list-for-sale", userId: user?.id, seatId: mySeat.id, askPrice: parseFloat(askPrice) }),
      });
      const d = await res.json();
      if (d.listed) { setMsg(`Listed for $${askPrice}. It can be bought instantly.`); loadData(); }
      else { setMsg(d.error || "Error"); }
    } catch { setMsg("Network error"); }
    setListing(false);
  };

  const handleUnlist = async () => {
    if (!mySeat) return;
    await fetch("/api/seats", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unlist", userId: user?.id, seatId: mySeat.id }),
    });
    setMsg("Unlisted."); loadData();
  };

  const handleBuyResale = async (seatId: number) => {
    if (!user) { window.location.href = "/login"; return; }
    setBuying(true); setMsg("");
    try {
      const res = await fetch("/api/seats", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "buy-resale", buyerId: user.id, buyerEmail: user.email, seatId }),
      });
      const d = await res.json();
      if (d.purchased) { setMsg(`Seat purchased for $${d.price}! Expires ${new Date(d.expiresAt).toLocaleDateString()}`); loadData(); }
      else { setMsg(d.error || "Already sold"); }
    } catch { setMsg("Network error"); }
    setBuying(false);
  };

  const pctFilled = info ? (info.activeSeats / info.cap * 100) : 0;

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-mono font-black mb-2" style={{ color: GOLD }}>Buy a Seat</h1>
        <p className="text-sm font-mono text-white/55">
          1 million seats. When they&apos;re gone, the only way in is the marketplace.
        </p>
      </div>

      {/* Capacity bar */}
      {info && (
        <div className="max-w-xl mx-auto mb-10">
          <div className="flex justify-between text-[10px] font-mono mb-1">
            <span className="text-white/50">{info.activeSeats.toLocaleString()} seats taken</span>
            <span style={{ color: GOLD }}>{info.remaining.toLocaleString()} remaining</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pctFilled, 100)}%`, background: pctFilled > 90 ? "#ef4444" : GOLD }} />
          </div>
          {pctFilled > 75 && (
            <div className="text-[10px] font-mono text-center mt-1" style={{ color: "#ef4444" }}>
              {pctFilled > 90 ? "Almost sold out" : "Filling up fast"}
            </div>
          )}
        </div>
      )}

      {/* Buy New Seat */}
      <div className="grid grid-cols-4 gap-4 max-w-2xl mx-auto mb-6">
        {([1, 3, 6, 12] as const).map(m => {
          const price = info?.pricing?.[m] || 0;
          const perMonth = price / m;
          const savings = m > 1 ? Math.round((1 - perMonth / 20) * 100) : 0;
          return (
            <button key={m} onClick={() => setSelectedMonths(m)}
              className="rounded-xl p-4 text-center transition-all"
              style={{
                background: selectedMonths === m ? "rgba(212,168,67,0.08)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${selectedMonths === m ? "rgba(212,168,67,0.3)" : "rgba(255,255,255,0.06)"}`,
              }}>
              <div className="text-lg font-mono font-black" style={{ color: selectedMonths === m ? GOLD : "rgba(255,255,255,0.7)" }}>
                {m}
              </div>
              <div className="text-[9px] font-mono text-white/40 mb-2">{m === 1 ? "month" : "months"}</div>
              <div className="text-sm font-mono font-bold" style={{ color: selectedMonths === m ? GOLD : "rgba(255,255,255,0.6)" }}>
                ${price}
              </div>
              {savings > 0 && (
                <div className="text-[9px] font-mono mt-1" style={{ color: "#22c55e" }}>Save {savings}%</div>
              )}
            </button>
          );
        })}
      </div>

      <div className="text-center mb-12">
        <button onClick={handleBuy} disabled={buying}
          className="px-8 py-3 rounded-lg text-sm font-mono font-bold transition-all hover:opacity-90 disabled:opacity-50"
          style={{ background: GOLD, color: "#000" }}>
          {buying ? "Processing..." : `Buy Seat — $${info?.pricing?.[selectedMonths] || "..."}`}
        </button>
        {msg && <p className="text-[11px] font-mono mt-3 text-white/60">{msg}</p>}
      </div>

      {/* My Seat — with prominent resale CTA */}
      {mySeat && (
        <div className="max-w-xl mx-auto mb-12 rounded-xl p-6" style={{ background: "rgba(212,168,67,0.04)", border: "1px solid rgba(212,168,67,0.15)" }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: GOLD }}>Your Seat</div>
              <div className="text-sm font-mono text-white/70">
                Expires {new Date(mySeat.expires_at).toLocaleDateString()} · Paid ${mySeat.price_paid}
              </div>
            </div>
            <div className="text-[9px] font-mono px-2 py-1 rounded" style={{ background: "rgba(34,197,94,0.08)", color: "#22c55e" }}>
              ACTIVE
            </div>
          </div>

          {mySeat.for_sale ? (
            <div>
              <div className="text-[11px] font-mono text-white/50 mb-2">
                Listed for <span className="font-bold text-white/80">${mySeat.ask_price}</span> — can be bought at any moment
              </div>
              <button onClick={handleUnlist} className="text-[10px] font-mono px-3 py-1 rounded" style={{ border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.5)" }}>
                Remove listing
              </button>
            </div>
          ) : (
            <div className="rounded-lg p-4 mt-2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="text-[12px] font-mono font-bold text-white/80 mb-1">
                List your seat for profit
              </div>
              <div className="text-[10px] font-mono text-white/45 mb-3">
                You paid ${mySeat.price_paid}. As demand grows, seats become more valuable.
                List yours at a higher price — when someone buys it, you keep 90% instantly. We take 10%.
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-mono text-white/40">$</span>
                  <input type="number" value={askPrice} onChange={e => setAskPrice(e.target.value)}
                    placeholder={String(Math.round(mySeat.price_paid * 1.5))}
                    className="w-24 px-2 py-1 rounded text-[12px] font-mono text-white/80"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }} />
                </div>
                <button onClick={handleList} disabled={listing || !askPrice}
                  className="px-4 py-1 rounded text-[11px] font-mono font-bold disabled:opacity-30"
                  style={{ background: GOLD, color: "#000" }}>
                  {listing ? "..." : "List for Sale"}
                </button>
              </div>
              {askPrice && parseFloat(askPrice) > mySeat.price_paid && (
                <div className="text-[10px] font-mono mt-2" style={{ color: "#22c55e" }}>
                  You&apos;d receive ${(parseFloat(askPrice) * 0.9).toFixed(2)} — a ${(parseFloat(askPrice) * 0.9 - mySeat.price_paid).toFixed(2)} profit
                </div>
              )}
              <div className="text-[9px] font-mono mt-2 text-white/30">
                ⚠ Once listed, your seat can be purchased immediately. The transfer is instant and final. You cannot cancel after a buyer pays.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Marketplace */}
      <div className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-mono font-bold" style={{ color: GOLD }}>Seat Marketplace</h2>
          <div className="text-[10px] font-mono text-white/40">
            {info?.forSale || 0} seats for sale
            {info?.cheapestSeat && <> · from <span style={{ color: GOLD }}>${info.cheapestSeat}</span></>}
          </div>
        </div>

        {market.length === 0 ? (
          <div className="text-center py-8 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <p className="text-sm font-mono text-white/40">No seats on the marketplace yet</p>
            <p className="text-[10px] font-mono text-white/30 mt-1">Buy a new seat above, then list it here at your price</p>
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-white/50 border-b" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                  <th className="text-left py-2 px-3 font-mono">Seat #</th>
                  <th className="text-right py-2 px-3 font-mono">Price</th>
                  <th className="text-right py-2 px-3 font-mono">Days Left</th>
                  <th className="text-right py-2 px-3 font-mono">$/Day</th>
                  <th className="text-center py-2 px-3 font-mono"></th>
                </tr>
              </thead>
              <tbody>
                {market.map(s => {
                  const daysLeft = Math.max(1, Math.round(s.days_remaining));
                  const perDay = (s.ask_price / daysLeft).toFixed(2);
                  return (
                    <tr key={s.id} className="border-b hover:bg-white/[0.02]" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
                      <td className="py-2 px-3 font-mono text-white/50">#{s.id}</td>
                      <td className="py-2 px-3 font-mono text-right font-bold" style={{ color: GOLD }}>${s.ask_price}</td>
                      <td className="py-2 px-3 font-mono text-right text-white/50">{daysLeft}d</td>
                      <td className="py-2 px-3 font-mono text-right text-white/40">${perDay}</td>
                      <td className="py-2 px-3 text-center">
                        <button onClick={() => handleBuyResale(s.id)} disabled={buying}
                          className="px-3 py-1 rounded text-[10px] font-mono font-bold disabled:opacity-30"
                          style={{ background: GOLD, color: "#000" }}>
                          Buy
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="max-w-2xl mx-auto">
        <h3 className="text-sm font-mono font-bold text-white/70 mb-4">How seats work</h3>
        <div className="grid grid-cols-2 gap-6">
          {[
            { title: "Limited supply", desc: "1 million seats total. When they sell out, the only way in is the marketplace. Seats expire and replenish naturally." },
            { title: "Real-time signals", desc: "While your seat is active, you get real-time signals via web and API. Every coin, every timeframe, zero delay." },
            { title: "Resale for profit", desc: "List your seat at any price. If someone buys it, you keep 90%. The transfer is instant and irrevocable. Buy low, sell high." },
            { title: "Price discovery", desc: "As the model proves itself, seat demand grows. Early buyers can profit from appreciation. The market sets the price." },
          ].map(item => (
            <div key={item.title}>
              <div className="text-[11px] font-mono font-bold text-white/60 mb-1">{item.title}</div>
              <div className="text-[10px] font-mono leading-relaxed text-white/40">{item.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Agent/API note */}
      <div className="mt-10 text-center">
        <p className="text-[10px] font-mono text-white/40">
          Autonomous agents can hold seats and receive signals via API or MCP. Crypto payments accepted.
        </p>
      </div>
    </div>
  );
}
