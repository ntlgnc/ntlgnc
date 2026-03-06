import { NextRequest, NextResponse } from "next/server";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import { Pool } from "pg";
import { validateAdminRequest, unauthorizedResponse } from "@/lib/admin-auth";

const execAsync = promisify(exec);
const BACKEND_DIR = path.resolve(process.cwd(), "..", "backend");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COMMANDS: Record<string, {
  cmd: string;
  cwd: string;
  daemon?: boolean;
  killPattern?: string;
  timeout?: number;
}> = {
  // ── Data Collection ──
  live_fetch: {
    cmd: "node live-fetch.cjs",
    cwd: BACKEND_DIR,
    daemon: true,
    killPattern: "live-fetch",
  },
  stop_live_fetch: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "live-fetch",
  },

  // ── Signal Engine ──
  live_signals: {
    cmd: "node live-signals.cjs",
    cwd: BACKEND_DIR,
    daemon: true,
    killPattern: "live-signals",
  },
  stop_live_signals: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "live-signals",
  },

  // ── Hourly Fetch ──
  live_fetch_hourly: {
    cmd: "node live-fetch-hourly.cjs",
    cwd: BACKEND_DIR,
    daemon: true,
    killPattern: "live-fetch-hourly",
  },
  stop_live_fetch_hourly: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "live-fetch-hourly",
  },

  // ── Daily Fetch ──
  live_fetch_daily: {
    cmd: "node live-fetch-daily.cjs",
    cwd: BACKEND_DIR,
    daemon: true,
    killPattern: "live-fetch-daily",
  },
  stop_live_fetch_daily: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "live-fetch-daily",
  },

  // ── Backfills ──
  backfill_1m: {
    cmd: "node backfill-1m.cjs --days 2",
    cwd: BACKEND_DIR,
    daemon: true,
  },
  backfill_hourly: {
    cmd: "node backfill-hourly.cjs --days 14",
    cwd: BACKEND_DIR,
    daemon: true,
  },
  backfill_daily: {
    cmd: "node backfill-daily.cjs --days 60",
    cwd: BACKEND_DIR,
    daemon: true,
  },

  // ── Backend lifecycle (supervisor) ──
  supervisor: {
    cmd: "node supervisor.cjs",
    cwd: BACKEND_DIR,
    daemon: true,
    killPattern: "supervisor.cjs",
  },
  stop_supervisor: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "supervisor.cjs",
  },
  // Stop ALL backend (supervisor + individual processes)
  stop_all_backend: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "live-fetch|live-signals|llm-board|supervisor|research-cron",
  },

  // ── LLM Strategy Board ──
  llm_board: {
    cmd: "node llm-board.js",
    cwd: BACKEND_DIR,
    daemon: true,
    killPattern: "llm-board",
  },
  stop_llm_board: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "llm-board",
  },
  trigger_meeting: {
    cmd: "node trigger-meeting.cjs",
    cwd: BACKEND_DIR,
    timeout: 300000,
  },

  restart_backend: {
    cmd: "node supervisor-win.js",
    cwd: BACKEND_DIR,
    daemon: true,
    killPattern: "supervisor-win",
  },
  stop_backend: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "supervisor-win",
  },

  // ── Evolution ──
  evolution_cron: {
    cmd: "node evolution-cron.js",
    cwd: BACKEND_DIR,
    daemon: true,
  },
  robustness_cron: {
    cmd: "node robustness-cron.js",
    cwd: BACKEND_DIR,
    daemon: true,
  },
  research_cron: {
    cmd: "node research-cron.cjs",
    cwd: BACKEND_DIR,
    daemon: true,
  },
  stop_research_cron: {
    cmd: "echo stopped",
    cwd: BACKEND_DIR,
    killPattern: "research-cron",
  },

  // ── Utilities ──
  cleanup_coins: {
    cmd: "node cleanup-coins.cjs",
    cwd: BACKEND_DIR,
    timeout: 30000,
  },
  add_hedged_type: {
    cmd: "node add-hedged-type.cjs",
    cwd: BACKEND_DIR,
    timeout: 15000,
  },
  check_candles: {
    cmd: `node -e "import('dotenv/config').then(()=>import('pg')).then(async p=>{const c=new p.default.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query('SELECT COUNT(*) as total, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM \\\"Candle1m\\\"');console.log(JSON.stringify(r.rows[0],null,2));await c.end();process.exit()})"`,
    cwd: BACKEND_DIR,
    timeout: 10000,
  },
};

/**
 * Kill node.exe processes whose command line contains the pattern.
 */
async function killByPattern(pattern: string): Promise<string> {
  try {
    // Handle pipe-separated patterns (e.g. "live-fetch|live-signals|llm-board")
    const patterns = pattern.split("|").map(p => p.trim()).filter(Boolean);
    let totalKilled = 0;
    const killedPids: string[] = [];
    
    for (const pat of patterns) {
      try {
        const { stdout } = await execAsync(
          `wmic process where "name='node.exe' and commandline like '%${pat}%'" get processid /format:list`,
          { timeout: 5000 }
        );
        const pids = (stdout.match(/ProcessId=(\d+)/g) || []).map(s => s.split("=")[1]);
        const myPid = String(process.pid);
        const toKill = pids.filter(pid => pid !== myPid && !killedPids.includes(pid));

        for (const pid of toKill) {
          try { await execAsync(`taskkill /F /PID ${pid}`, { timeout: 3000 }); killedPids.push(pid); totalKilled++; } catch {}
        }
      } catch {}
    }

    if (totalKilled === 0) return "No matching processes found.";
    return `Killed ${totalKilled} process(es) — PID ${killedPids.join(", ")}`;
  } catch (err: any) {
    return `Kill scan: ${err.message?.slice(0, 80) || "no matches"}`;
  }
}

/**
 * Check if a process is running by pattern match
 */
async function isProcessRunning(pattern: string): Promise<boolean> {
  try {
    // Linux: use pgrep to find node processes matching the pattern
    const { stdout } = await execAsync(
      `pgrep -f "${pattern}" 2>/dev/null || true`,
      { timeout: 5000 }
    );
    const pids = stdout.trim().split("\n").filter(Boolean);
    const myPid = String(process.pid);
    return pids.filter(pid => pid !== myPid).length > 0;
  } catch {
    // Fallback for Windows
    try {
      const { stdout } = await execAsync(
        `wmic process where "name='node.exe' and commandline like '%${pattern}%'" get processid /format:list`,
        { timeout: 5000 }
      );
      const pids = (stdout.match(/ProcessId=(\d+)/g) || []).map(s => s.split("=")[1]);
      const myPid = String(process.pid);
      return pids.filter(pid => pid !== myPid).length > 0;
    } catch {
      return false;
    }
  }
}

export async function GET() {
  // Health check endpoint — returns status of all services
  try {
    const [liveFetch, liveSignals, liveHourly, liveDaily, supervisor, llmBoard, researchCron] = await Promise.all([
      isProcessRunning("live-fetch.cjs"),
      isProcessRunning("live-signals.cjs"),
      isProcessRunning("live-fetch-hourly"),
      isProcessRunning("live-fetch-daily"),
      isProcessRunning("supervisor.cjs"),
      isProcessRunning("llm-board"),
      isProcessRunning("research-cron"),
    ]);

    // Check data freshness
    const [candle1m, candle1h, candle1d, signals, boardMeeting] = await Promise.all([
      pool.query(`SELECT MAX(timestamp) as latest, COUNT(DISTINCT symbol) as coins FROM "Candle1m" WHERE timestamp > NOW() - INTERVAL '10 minutes'`).catch(() => ({ rows: [{ latest: null, coins: 0 }] })),
      pool.query(`SELECT MAX(timestamp) as latest, COUNT(DISTINCT symbol) as coins FROM "Candle1h" WHERE timestamp > NOW() - INTERVAL '3 hours'`).catch(() => ({ rows: [{ latest: null, coins: 0 }] })),
      pool.query(`SELECT MAX(timestamp) as latest, COUNT(DISTINCT symbol) as coins FROM "Candle1d" WHERE timestamp > NOW() - INTERVAL '2 days'`).catch(() => ({ rows: [{ latest: null, coins: 0 }] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'open') as open, MAX("createdAt") as latest FROM "FracmapSignal"`).catch(() => ({ rows: [{ total: 0, open: 0, latest: null }] })),
      pool.query(`SELECT id, round_number, phase, decision, created_at, duration_ms, total_tokens FROM board_meetings ORDER BY created_at DESC LIMIT 1`).catch(() => ({ rows: [] })),
    ]);

    // Signal health — per-timeframe breakdown for 1h, 6h, 24h windows
    let signalHealth = null;
    try {
      const { rows: shRows } = await pool.query(`
        SELECT 
          s."barMinutes",
          f.status,
          COUNT(*) FILTER (WHERE f."createdAt" > now() - interval '1 hour')::int as last_1h,
          COUNT(*) FILTER (WHERE f."createdAt" > now() - interval '6 hours')::int as last_6h,
          COUNT(*) FILTER (WHERE f."createdAt" > now() - interval '24 hours')::int as last_24h
        FROM "FracmapSignal" f
        JOIN "FracmapStrategy" s ON f."strategyId" = s.id
        WHERE f."createdAt" > now() - interval '24 hours'
        GROUP BY s."barMinutes", f.status
        ORDER BY s."barMinutes", f.status
      `);
      
      // Open positions with soonest close
      const { rows: openPos } = await pool.query(`
        SELECT s."barMinutes", COUNT(*)::int as count,
               MIN(f."createdAt") as oldest,
               MIN(f."holdBars") as min_hold
        FROM "FracmapSignal" f
        JOIN "FracmapStrategy" s ON f."strategyId" = s.id
        WHERE f.status = 'open'
        GROUP BY s."barMinutes"
        ORDER BY s."barMinutes"
      `);
      
      // Active filter stats
      const { rows: filterStats } = await pool.query(`
        SELECT COUNT(*)::int as active_filters,
               SUM(trades_filtered)::int as total_filtered,
               SUM(trades_passed)::int as total_passed
        FROM board_filters WHERE active = true
      `);
      
      signalHealth = { byTimeframe: shRows, openPositions: openPos, filters: filterStats[0] || { active_filters: 0, total_filtered: 0, total_passed: 0 } };
    } catch {}


    return NextResponse.json({
      processes: {
        live_fetch: liveFetch,
        live_signals: liveSignals,
        live_fetch_hourly: liveHourly,
        live_fetch_daily: liveDaily,
        supervisor,
        llm_board: llmBoard,
        research_cron: researchCron,
      },
      data: {
        candle1m: { latest: candle1m.rows[0]?.latest, recentCoins: parseInt(candle1m.rows[0]?.coins) || 0 },
        candle1h: { latest: candle1h.rows[0]?.latest, recentCoins: parseInt(candle1h.rows[0]?.coins) || 0 },
        candle1d: { latest: candle1d.rows[0]?.latest, recentCoins: parseInt(candle1d.rows[0]?.coins) || 0 },
        signals: { total: parseInt(signals.rows[0]?.total) || 0, open: parseInt(signals.rows[0]?.open) || 0, latest: signals.rows[0]?.latest },
        board: boardMeeting.rows[0] || null,
        signalHealth,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!validateAdminRequest(req)) return unauthorizedResponse();
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }
  
  const { id } = body;
  const def = COMMANDS[id];
  if (!def) return NextResponse.json({ error: `Unknown command: ${id}` }, { status: 400 });

  const lines: string[] = [];

  try {
    if (def.killPattern) {
      const killResult = await killByPattern(def.killPattern);
      lines.push(killResult);
      await new Promise(r => setTimeout(r, 1500));
    }

    if (id.startsWith("stop_")) {
      return NextResponse.json({ ok: true, output: lines.join("\n") || "Stopped." });
    }

    if (def.daemon) {
      const parts = def.cmd.split(" ");
      const child = spawn(parts[0], parts.slice(1), {
        cwd: def.cwd,
        detached: true,
        stdio: "ignore",
        shell: false,
        env: { ...process.env },
      });
      child.unref();
      lines.push(`Started: ${def.cmd} (PID ${child.pid})`);
      return NextResponse.json({ ok: true, output: lines.join("\n") });
    }

    const { stdout, stderr } = await execAsync(def.cmd, {
      cwd: def.cwd,
      timeout: def.timeout || 15000,
      env: { ...process.env },
    });

    if (stdout?.trim()) lines.push(stdout.trim());
    if (stderr?.trim()) lines.push(stderr.trim());

    return NextResponse.json({ ok: true, output: lines.join("\n") || "Done." });
  } catch (err: any) {
    lines.push(`Error: ${err.message?.slice(0, 300) || "Unknown"}`);
    return NextResponse.json({ ok: false, output: lines.join("\n") });
  }
}
