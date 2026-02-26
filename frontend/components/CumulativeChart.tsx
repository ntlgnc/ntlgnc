"use client";

import { useEffect, useRef } from "react";
import type { ModelKey } from "./types";

type Props = {
  curves: Record<ModelKey, number[]>;
  height?: number;
};

const COLORS: Record<ModelKey, string> = {
  openai: "#00d67d",
  claude: "#a78bfa",
  grok: "#ff6b35",
};

const LABELS: Record<ModelKey, string> = {
  openai: "OpenAI",
  claude: "Claude",
  grok: "Grok",
};

export default function CumulativeChart({ curves, height = 300 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function draw() {
      const parent = canvas!.parentElement;
      if (!parent) return;

      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      const w = parent.clientWidth;
      const h = height;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;

      const ctx = canvas!.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);

      const pad = { t: 20, r: 20, b: 36, l: 54 };
      const cw = w - pad.l - pad.r;
      const ch = h - pad.t - pad.b;

      const all = [...curves.openai, ...curves.claude, ...curves.grok];
      if (all.length === 0) return;

      const minY = Math.min(...all) - 0.4;
      const maxY = Math.max(...all) + 0.4;

      const xFor = (i: number, n: number) => pad.l + (cw / Math.max(n - 1, 1)) * i;
      const yFor = (v: number) => pad.t + ch - ((v - minY) / (maxY - minY)) * ch;

      // Grid lines
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const y = pad.t + (ch / 5) * i;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(w - pad.r, y);
        ctx.stroke();
      }

      // Zero line
      const zy = yFor(0);
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.l, zy);
      ctx.lineTo(w - pad.r, zy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw each model curve
      (["openai", "claude", "grok"] as ModelKey[]).forEach((model) => {
        const data = curves[model];
        const n = data.length;
        const col = COLORS[model];

        if (n < 2) return;

        // Area fill
        ctx.beginPath();
        ctx.moveTo(xFor(0, n), zy);
        data.forEach((v, i) => ctx.lineTo(xFor(i, n), yFor(v)));
        ctx.lineTo(xFor(n - 1, n), zy);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
        grad.addColorStop(0, col + "18");
        grad.addColorStop(1, col + "02");
        ctx.fillStyle = grad;
        ctx.fill();

        // Line
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = col;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        data.forEach((v, i) => {
          const x = xFor(i, n);
          const y = yFor(v);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;

        // End dot
        const lx = xFor(n - 1, n);
        const ly = yFor(data[n - 1]);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(lx, ly, 5, 0, Math.PI * 2);
        ctx.fill();

        // Glow ring
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(lx, ly, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // End label
        ctx.fillStyle = col;
        ctx.font = '600 11px "JetBrains Mono", monospace';
        ctx.textAlign = "left";
        const label = (data[n - 1] >= 0 ? "+" : "") + data[n - 1].toFixed(2) + "%";
        ctx.fillText(label, lx + 14, ly + 4);
      });

      // Y-axis labels
      ctx.fillStyle = "#5a5a6e";
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = "right";
      ctx.shadowBlur = 0;
      for (let i = 0; i <= 5; i++) {
        const v = maxY - ((maxY - minY) / 5) * i;
        const y = pad.t + (ch / 5) * i;
        ctx.fillText((v >= 0 ? "+" : "") + v.toFixed(1) + "%", pad.l - 8, y + 4);
      }

      // X-axis labels
      ctx.textAlign = "center";
      ctx.fillStyle = "#5a5a6e";
      ["0h", "6h", "12h", "18h", "24h"].forEach((l, i) => {
        const x = pad.l + (cw / 4) * i;
        ctx.fillText(l, x, h - pad.b + 20);
      });
    }

    draw();

    const ro = new ResizeObserver(draw);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener("resize", draw);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [curves, height]);

  return (
    <section className="pt-9">
      {/* Title + legend */}
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-display text-lg font-bold text-[var(--text)]">
          Cumulative Returns (24h)
        </h3>
        <div className="flex gap-5">
          {(["openai", "claude", "grok"] as ModelKey[]).map((m) => (
            <div key={m} className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <span className="w-5 h-[3px] rounded" style={{ background: COLORS[m] }} />
              {LABELS[m]}
            </div>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5 relative"
        style={{ height }}
      >
        <canvas ref={canvasRef} />
      </div>
    </section>
  );
}
