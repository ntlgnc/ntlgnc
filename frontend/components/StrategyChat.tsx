"use client";

import { useState, useRef, useEffect } from "react";
import { STRATEGY_TEMPLATES, templateToStrategy, StrategyTemplate } from "@/lib/strategy-templates";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type StrategyConfig = {
  name: string;
  coins: string[];
  models: string[];
  horizons: string[];
  signalType: string;
  regimes: string[];
  volStates: string[];
  regimeDirections: string[];
  active: boolean;
};

type Props = {
  onStrategyCreate: (config: StrategyConfig) => void;
  loading: boolean;
};

const WELCOME_MESSAGE = `Hey! I'm your signal assistant. I'll help you set up the perfect trading strategy in under a minute.

**What kind of signals are you looking for?** For example:
- "I want to catch dips on BTC and ETH"
- "Aggressive scalping across all coins"
- "Conservative, just the majors"

Or pick a ready-made strategy below 👇`;

const COIN_LABELS: Record<string, string> = {
  BTCUSDT: "BTC", ETHUSDT: "ETH", XRPUSDT: "XRP", BNBUSDT: "BNB",
  SOLUSDT: "SOL", TRXUSDT: "TRX", DOGEUSDT: "DOGE", BCHUSDT: "BCH",
  ADAUSDT: "ADA", XLMUSDT: "XLM", LINKUSDT: "LINK", HBARUSDT: "HBAR",
  LTCUSDT: "LTC", ZECUSDT: "ZEC", AVAXUSDT: "AVAX", SUIUSDT: "SUI",
  SHIBUSDT: "SHIB", TONUSDT: "TON", DOTUSDT: "DOT", UNIUSDT: "UNI",
};

export default function StrategyChat({ onStrategyCreate, loading }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingStrategy, setPendingStrategy] = useState<StrategyConfig | null>(null);
  const [showTemplates, setShowTemplates] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, pendingStrategy]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || sending) return;

    const userMsg: Message = { role: "user", content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setShowTemplates(false);
    setSending(true);

    try {
      const res = await fetch("/api/strategy/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

      const data = await res.json();

      if (data.error) {
        setMessages([...newMessages, {
          role: "assistant",
          content: `Sorry, I hit a snag: ${data.error}. Try again?`,
        }]);
      } else {
        setMessages([...newMessages, {
          role: "assistant",
          content: data.reply,
        }]);

        if (data.strategyConfig) {
          setPendingStrategy(data.strategyConfig);
        }
      }
    } catch (err: any) {
      setMessages([...newMessages, {
        role: "assistant",
        content: "Connection error — please try again.",
      }]);
    }

    setSending(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const handleTemplateClick = (template: StrategyTemplate) => {
    const config = templateToStrategy(template);
    setPendingStrategy(config);
    setShowTemplates(false);
    setMessages([{
      role: "user",
      content: `I'd like the "${template.name}" strategy`,
    }, {
      role: "assistant",
      content: `Great choice! I've configured **${template.name}** for you — ${template.description.toLowerCase()} Here's what you'll get:`,
    }]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleCreateStrategy = () => {
    if (pendingStrategy) {
      onStrategyCreate(pendingStrategy);
    }
  };

  const handleTweak = () => {
    setPendingStrategy(null);
    setMessages(prev => [...prev, {
      role: "user",
      content: "I'd like to tweak this a bit.",
    }]);
    // The next sendMessage will include context
    setTimeout(() => {
      sendMessage("I'd like to tweak this a bit.");
    }, 100);
  };

  const visibleTemplates = STRATEGY_TEMPLATES.filter(t => t.slug !== "custom");

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#ff6b35]/10 border border-[#ff6b35]/20 text-[#ff6b35] text-xs font-semibold mb-3">
          <span className="w-2 h-2 rounded-full bg-[#ff6b35] animate-pulse" />
          SIGNAL ASSISTANT
        </div>
      </div>

      {/* Chat area */}
      <div className="bg-white/[0.02] rounded-xl border border-white/10 overflow-hidden">
        {/* Messages */}
        <div className="p-4 space-y-4 max-h-[450px] overflow-y-auto min-h-[200px]">
          {/* Welcome message */}
          <ChatBubble role="assistant" content={WELCOME_MESSAGE} />

          {/* User/assistant messages */}
          {messages.map((msg, i) => (
            <ChatBubble key={i} role={msg.role} content={msg.content} />
          ))}

          {/* Typing indicator */}
          {sending && (
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-[#ff6b35]/20 flex items-center justify-center flex-shrink-0">
                <span className="text-[#ff6b35] text-xs">🎯</span>
              </div>
              <div className="bg-white/[0.04] rounded-2xl rounded-tl-sm px-4 py-2.5">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}

          {/* Strategy config card */}
          {pendingStrategy && (
            <StrategyCard
              config={pendingStrategy}
              onAccept={handleCreateStrategy}
              onTweak={handleTweak}
              loading={loading}
            />
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Template quick-picks */}
        {showTemplates && (
          <div className="px-4 pb-3">
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
              {visibleTemplates.map(t => (
                <button
                  key={t.slug}
                  onClick={() => handleTemplateClick(t)}
                  className="flex-shrink-0 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.03]
                             hover:border-[#ff6b35]/30 hover:bg-[#ff6b35]/5 transition-all text-left group"
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm">{t.icon}</span>
                    <span className="text-xs font-semibold text-white/80 group-hover:text-white transition-colors">
                      {t.name}
                    </span>
                  </div>
                  <div className="text-[10px] text-white/30 group-hover:text-white/50 transition-colors">
                    {t.tagline}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input bar */}
        <div className="border-t border-white/10 p-3">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={pendingStrategy ? "Want to change anything?" : "Describe what you're looking for..."}
              disabled={sending}
              className="flex-1 bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white 
                         placeholder:text-white/25 focus:outline-none focus:border-[#ff6b35]/40 transition-colors
                         disabled:opacity-40"
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || sending}
              className="px-4 py-2.5 bg-[#ff6b35] hover:bg-[#ff6b35]/80 text-white text-sm font-semibold 
                         rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
          {!showTemplates && !pendingStrategy && (
            <button
              onClick={() => setShowTemplates(true)}
              className="mt-2 text-[10px] text-white/30 hover:text-white/50 transition-colors"
            >
              Show preset strategies →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══ Chat Bubble ═══ */
function ChatBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";

  // Simple markdown-ish rendering (bold only)
  const renderContent = (text: string) => {
    const parts = text.split(/(\*\*.*?\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>;
      }
      // Handle line breaks
      return part.split("\n").map((line, j) => (
        <span key={`${i}-${j}`}>
          {j > 0 && <br />}
          {line}
        </span>
      ));
    });
  };

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="bg-[#ff6b35]/15 border border-[#ff6b35]/20 rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%]">
          <p className="text-sm text-white/90 leading-relaxed">{content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-full bg-[#ff6b35]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
        <span className="text-[#ff6b35] text-xs">🎯</span>
      </div>
      <div className="bg-white/[0.04] rounded-2xl rounded-tl-sm px-4 py-2.5 max-w-[85%]">
        <p className="text-sm text-white/70 leading-relaxed">{renderContent(content)}</p>
      </div>
    </div>
  );
}

/* ═══ Strategy Config Card ═══ */
function StrategyCard({ config, onAccept, onTweak, loading }: {
  config: StrategyConfig;
  onAccept: () => void;
  onTweak: () => void;
  loading: boolean;
}) {
  const horizonLabels: Record<string, string> = { "5": "5m", "15": "15m", "30": "30m", "60": "60m" };
  const signalLabels: Record<string, string> = {
    both: "Long + Short", long: "Long Only", short: "Short Only", neutral: "Market Neutral",
  };
  const regimeLabels: Record<string, string> = {
    trend: "Trend", countertrend: "Counter-Trend", range: "Range",
  };

  return (
    <div className="mx-2 my-3">
      <div className="bg-gradient-to-br from-[#ff6b35]/10 to-transparent rounded-xl border border-[#ff6b35]/20 p-4">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-[#ff6b35]/20 flex items-center justify-center">
            <span className="text-sm">⚡</span>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">{config.name}</h3>
            <p className="text-[10px] text-white/40">Ready to activate</p>
          </div>
        </div>

        {/* Config grid */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <ConfigPill
            label="Coins"
            value={config.coins.length <= 4
              ? config.coins.map(c => COIN_LABELS[c] || c.replace("USDT", "")).join(", ")
              : `${config.coins.length} coins`
            }
          />
          <ConfigPill
            label="Horizons"
            value={config.horizons.map(h => horizonLabels[h] || h).join(", ") || "All"}
          />
          <ConfigPill
            label="Direction"
            value={signalLabels[config.signalType] || config.signalType}
          />
          <ConfigPill
            label="Regimes"
            value={config.regimes.length > 0
              ? config.regimes.map(r => regimeLabels[r] || r).join(", ")
              : "All"
            }
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onTweak}
            disabled={loading}
            className="flex-1 py-2 rounded-lg border border-white/10 text-xs text-white/50 
                       hover:text-white/80 hover:border-white/20 transition-colors"
          >
            Tweak it
          </button>
          <button
            onClick={onAccept}
            disabled={loading}
            className="flex-1 py-2 rounded-lg bg-[#ff6b35] text-white text-xs font-semibold
                       hover:bg-[#ff6b35]/80 transition-colors disabled:opacity-50"
          >
            {loading ? "Setting up..." : "Start this strategy →"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfigPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black/20 rounded-lg px-3 py-1.5">
      <div className="text-[9px] text-white/30 uppercase tracking-wider">{label}</div>
      <div className="text-xs text-white/80 font-medium">{value}</div>
    </div>
  );
}
