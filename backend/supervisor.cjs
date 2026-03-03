/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  NTLGNC BACKEND SUPERVISOR                                      ║
 * ║  One script to rule them all. Manages all backend processes.     ║
 * ║                                                                  ║
 * ║  Usage:  node backend/supervisor.cjs                             ║
 * ║  Stop:   Ctrl+C (gracefully stops all children)                  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── PROCESS DEFINITIONS ───────────────────────────────────────────
// Each process: { name, script, delay (ms before start), restartDelay, maxRestarts }
const PROCESSES = [
  {
    name: 'frontend',
    script: '__npm__',      // special: runs npm run dev in frontend dir
    cwd: path.join(__dirname, '..', 'frontend'),
    command: 'npm',
    args: ['run', 'dev'],
    delay: 0,
    restartDelay: 5000,
    maxRestarts: 20,
    description: 'Next.js frontend (port 3000)',
  },
  {
    name: 'data-1m',
    script: 'live-fetch.cjs',
    delay: 5000,            // wait for frontend to be up
    restartDelay: 5000,
    maxRestarts: 50,
    description: '1-minute candle fetcher',
  },
  {
    name: 'data-1h',
    script: 'live-fetch-hourly.cjs',
    delay: 7000,
    restartDelay: 5000,
    maxRestarts: 50,
    description: '1-hour candle fetcher',
  },
  {
    name: 'data-1d',
    script: 'live-fetch-daily.cjs',
    delay: 9000,
    restartDelay: 5000,
    maxRestarts: 50,
    description: '1-day candle fetcher',
  },
  {
    name: 'signals',
    script: 'live-signals.cjs',
    delay: 12000,
    restartDelay: 5000,
    maxRestarts: 50,
    description: 'Signal generation engine',
  },
  {
    name: 'llm-board',
    script: 'llm-board.js',
    delay: 20000,
    restartDelay: 30000,
    maxRestarts: 20,
    description: 'LLM Strategy Board',
  },
  {
    name: 'regime-cache',
    script: 'regime-cache.cjs',
    delay: 14000,
    restartDelay: 10000,
    maxRestarts: 50,
    description: 'Regime cache (5-min refresh, all timeframes)',
  },
  {
    name: 'mtm-cron',
    script: 'mtm-cron.cjs',
    delay: 16000,
    restartDelay: 10000,
    maxRestarts: 50,
    description: 'Mark-to-market snapshots for open positions',
  },
  {
    name: 'research',
    script: 'research-cron.cjs',
    delay: 25000,            // start after llm-board is up
    restartDelay: 30000,
    maxRestarts: 20,
    description: 'Autonomous inter-meeting LLM research engine (5-min cycle)',
  },
  {
    name: 'backfill-1m',
    script: 'backfill-1m-deep.cjs',
    delay: 60000,             // start after 1 minute
    restartDelay: 86400000,   // restart once per day (24h)
    maxRestarts: 999,
    description: 'Deep 1m candle backfill (extends history by 1 week per run)',
  },
];

// ─── STATE ─────────────────────────────────────────────────────────
const children = {};  // name → { proc, restarts, lastStart, status }
let shuttingDown = false;
const LOG_DIR = path.join(__dirname, 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── COLORS ────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

const COLORS = [C.cyan, C.green, C.magenta, C.yellow, C.blue];
const nameColors = {};
PROCESSES.forEach((p, i) => { nameColors[p.name] = COLORS[i % COLORS.length]; });

function log(name, msg, color) {
  const ts = new Date().toLocaleTimeString();
  const c = color || nameColors[name] || C.reset;
  const tag = name.padEnd(10);
  console.log(`${C.dim}${ts}${C.reset} ${c}[${tag}]${C.reset} ${msg}`);
}

function logSupervisor(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`${C.dim}${ts}${C.reset} ${C.bold}[supervisor]${C.reset} ${msg}`);
}

// ─── PROCESS LAUNCHER ──────────────────────────────────────────────
function startProcess(config) {
  if (shuttingDown) return;
  
  const state = children[config.name] || { proc: null, restarts: 0, lastStart: 0, status: 'stopped' };
  children[config.name] = state;

  // Determine command and args
  let cmd, args, cwd;
  if (config.command) {
    // Custom command (e.g. npm run dev)
    cmd = 'npm';
    args = config.args || [];
    cwd = config.cwd || __dirname;
  } else {
    const scriptPath = path.join(__dirname, config.script);
    if (!fs.existsSync(scriptPath)) {
      log(config.name, `❌ Script not found: ${config.script}`, C.red);
      state.status = 'missing';
      return;
    }
    cmd = 'node';
    args = [scriptPath];
    cwd = __dirname;
  }

  state.lastStart = Date.now();
  state.status = 'starting';

  const proc = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
    shell: !!config.command,  // shell needed for npm on Windows
  });

  state.proc = proc;
  state.status = 'running';
  state.pid = proc.pid;

  log(config.name, `✅ Started (PID ${proc.pid}) — ${config.description}`);

  // Log file for this process
  const logFile = fs.createWriteStream(
    path.join(LOG_DIR, `${config.name}.log`),
    { flags: 'a' }
  );
  const errFile = fs.createWriteStream(
    path.join(LOG_DIR, `${config.name}-error.log`),
    { flags: 'a' }
  );

  proc.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        // Show important lines in console, log everything to file
        const important = line.includes('✅') || line.includes('❌') || line.includes('⚠') ||
                         line.includes('Meeting #') || line.includes('HEADLINE') ||
                         line.includes('Filter deployed') || line.includes('PASSED') ||
                         line.includes('FAILED') || line.includes('Error') ||
                         line.includes('started') || line.includes('ready') ||
                         line.includes('BRIEFING EXCERPT');
        if (important) {
          log(config.name, line.slice(0, 200));
        }
        logFile.write(`${new Date().toISOString()} ${line}\n`);
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim() && !line.includes('ExperimentalWarning') && !line.includes('DeprecationWarning')) {
        log(config.name, `⚠ ${line.slice(0, 200)}`, C.yellow);
        errFile.write(`${new Date().toISOString()} ${line}\n`);
      }
    }
  });

  proc.on('exit', (code, signal) => {
    state.status = 'stopped';
    state.proc = null;
    logFile.end();
    errFile.end();

    if (shuttingDown) {
      log(config.name, `Stopped (shutdown)`, C.dim);
      return;
    }

    const runtime = ((Date.now() - state.lastStart) / 1000).toFixed(0);

    if (code === 0) {
      log(config.name, `Exited cleanly after ${runtime}s`, C.dim);
    } else {
      log(config.name, `❌ Crashed (code ${code}, signal ${signal}) after ${runtime}s`, C.red);
    }

    // Auto-restart
    if (state.restarts >= config.maxRestarts) {
      log(config.name, `🛑 Max restarts (${config.maxRestarts}) reached. Giving up.`, C.red);
      state.status = 'dead';
      return;
    }

    // Reset restart counter if it ran for more than 5 minutes
    if (Date.now() - state.lastStart > 5 * 60 * 1000) {
      state.restarts = 0;
    }

    state.restarts++;
    const delay = config.restartDelay * Math.min(state.restarts, 5); // exponential-ish backoff
    log(config.name, `↻ Restarting in ${(delay / 1000).toFixed(0)}s (attempt ${state.restarts}/${config.maxRestarts})`, C.yellow);
    setTimeout(() => startProcess(config), delay);
  });
}

// ─── STATUS DISPLAY ────────────────────────────────────────────────
function showStatus() {
  console.log(`\n${C.bold}  ── Process Status ──${C.reset}`);
  for (const config of PROCESSES) {
    const state = children[config.name] || { status: 'not started', pid: null, restarts: 0 };
    const statusColor = state.status === 'running' ? C.green :
                        state.status === 'dead' ? C.red :
                        state.status === 'stopped' ? C.yellow : C.dim;
    const pid = state.pid ? ` (PID ${state.pid})` : '';
    const restarts = state.restarts > 0 ? ` [${state.restarts} restarts]` : '';
    console.log(`  ${statusColor}●${C.reset} ${nameColors[config.name]}${config.name.padEnd(12)}${C.reset} ${statusColor}${state.status}${C.reset}${pid}${restarts}`);
  }
  console.log();
}

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  
  logSupervisor(`\n${signal} received — shutting down all processes...`);
  
  const procs = Object.values(children).filter(c => c.proc);
  if (procs.length === 0) {
    logSupervisor('No running processes. Exiting.');
    process.exit(0);
  }

  // Send SIGTERM to all
  for (const [name, state] of Object.entries(children)) {
    if (state.proc) {
      log(name, 'Sending SIGTERM...', C.dim);
      state.proc.kill('SIGTERM');
    }
  }

  // Force kill after 10 seconds
  setTimeout(() => {
    logSupervisor('Force-killing remaining processes...');
    for (const state of Object.values(children)) {
      if (state.proc) {
        try { state.proc.kill('SIGKILL'); } catch {}
      }
    }
    process.exit(1);
  }, 10000);

  // Check if all exited
  const checkInterval = setInterval(() => {
    const alive = Object.values(children).filter(c => c.proc);
    if (alive.length === 0) {
      clearInterval(checkInterval);
      logSupervisor('All processes stopped. Goodbye! 👋');
      process.exit(0);
    }
  }, 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// Windows: handle Ctrl+C
if (process.platform === 'win32') {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => shutdown('SIGINT'));
  // Also catch the close event
  rl.on('close', () => shutdown('close'));
}

// ─── STARTUP ───────────────────────────────────────────────────────
console.log(`
${C.bold}╔══════════════════════════════════════════════════════════════════╗
║  NTLGNC BACKEND SUPERVISOR                                      ║
║  Managing ${PROCESSES.length} processes                                          ║
╚══════════════════════════════════════════════════════════════════╝${C.reset}
`);

logSupervisor(`Starting ${PROCESSES.length} processes with staggered delays...`);
console.log();

for (const config of PROCESSES) {
  const delay = config.delay || 0;
  if (delay === 0) {
    startProcess(config);
  } else {
    log(config.name, `Scheduled to start in ${(delay / 1000).toFixed(0)}s`, C.dim);
    setTimeout(() => startProcess(config), delay);
  }
}

// Show status every 5 minutes
setInterval(() => {
  if (!shuttingDown) showStatus();
}, 5 * 60 * 1000);

// Show initial status after all processes have started
setTimeout(showStatus, 20000);
