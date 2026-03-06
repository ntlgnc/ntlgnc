// Fix: Include open trade PnL in summary bar and equity card displays
const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/signals/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// 1. Fix hedgedStats memo to include open PnL
// Need to add prices to the dependency and calculate open PnL
const oldMemo = `const hedgedStats = useMemo(() => {
    if (!hedgedData?.pairs) return null;
    const windowMs: Record<string, number> = {
      "1H": 3600_000, "1D": 86400_000, "1W": 7 * 86400_000, "1M": 30 * 86400_000,
    };
    const cutoff = timeframe === "ALL" ? 0 : Date.now() - (windowMs[timeframe] || 86400_000);
    const allPairs = cutoff === 0 ? hedgedData.pairs : hedgedData.pairs.filter((p: any) => {
      if (p.status === "open") return true;
      const closedAt = new Date(p.legA?.closedAt || p.legB?.closedAt || p.legA?.createdAt || 0).getTime();
      return closedAt >= cutoff;
    });
    const closed = allPairs.filter((p: any) => p.status === "closed" && p.pair_return != null);
    const openCount = allPairs.filter((p: any) => p.status === "open").length;
    const returns = closed.map((p: any) => +p.pair_return);
    const cumReturn = returns.reduce((s: number, r: number) => s + r, 0);
    const wins = returns.filter((r: number) => r > 0).length;
    const winRate = returns.length > 0 ? (wins / returns.length * 100) : 0;
    const mean = returns.length > 0 ? cumReturn / returns.length : 0;
    const std = returns.length > 1 ? Math.sqrt(returns.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / returns.length) : 0;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    // 24h return
    const cutoff24h = Date.now() - 86400_000;
    const recent = closed.filter((p: any) => new Date(p.legA?.closedAt || 0).getTime() >= cutoff24h);
    const ret24h = recent.reduce((s: number, p: any) => s + (+p.pair_return), 0);

    // Per-TF 24h returns
    const getPairBm = (p: any) => p.legA?.barMinutes || p.legB?.barMinutes || 1;
    const tf24h: Record<string, number> = { "1m": 0, "1h": 0, "1d": 0 };
    for (const p of recent) {
      const bm = getPairBm(p);
      const tf = bm >= 1440 ? "1d" : bm >= 60 ? "1h" : "1m";
      tf24h[tf] += +p.pair_return;
    }

    return { closed: closed.length, open: openCount, cumReturn, winRate, mean, sharpe, ret24h, tf24h };
  }, [hedgedData, timeframe]);`;

const newMemo = `const hedgedStats = useMemo(() => {
    if (!hedgedData?.pairs) return null;
    const windowMs: Record<string, number> = {
      "1H": 3600_000, "1D": 86400_000, "1W": 7 * 86400_000, "1M": 30 * 86400_000,
    };
    const cutoff = timeframe === "ALL" ? 0 : Date.now() - (windowMs[timeframe] || 86400_000);
    const allPairs = cutoff === 0 ? hedgedData.pairs : hedgedData.pairs.filter((p: any) => {
      if (p.status === "open") return true;
      const closedAt = new Date(p.legA?.closedAt || p.legB?.closedAt || p.legA?.createdAt || 0).getTime();
      return closedAt >= cutoff;
    });
    const closed = allPairs.filter((p: any) => p.status === "closed" && p.pair_return != null);
    const openPairs = allPairs.filter((p: any) => p.status === "open");
    const openCount = openPairs.length;
    const returns = closed.map((p: any) => +p.pair_return);
    const closedReturn = returns.reduce((s: number, r: number) => s + r, 0);

    // Calculate open PnL from current prices
    let openPnL = 0;
    const getPairBm = (p: any) => p.legA?.barMinutes || p.legB?.barMinutes || 1;
    for (const p of openPairs) {
      let legAret = 0, legBret = 0;
      const cpA = prices[p.legA?.symbol];
      const cpB = prices[p.legB?.symbol];
      if (cpA && p.legA?.entryPrice) { legAret = p.legA.direction === "LONG" ? (cpA / p.legA.entryPrice - 1) * 100 : (p.legA.entryPrice / cpA - 1) * 100; }
      if (cpB && p.legB?.entryPrice) { legBret = p.legB.direction === "LONG" ? (cpB / p.legB.entryPrice - 1) * 100 : (p.legB.entryPrice / cpB - 1) * 100; }
      openPnL += legAret + legBret;
    }

    const cumReturn = closedReturn + openPnL;
    const wins = returns.filter((r: number) => r > 0).length;
    const winRate = returns.length > 0 ? (wins / returns.length * 100) : 0;
    const mean = returns.length > 0 ? closedReturn / returns.length : 0;
    const std = returns.length > 1 ? Math.sqrt(returns.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / returns.length) : 0;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    // 24h return (closed + open PnL)
    const cutoff24h = Date.now() - 86400_000;
    const recent = closed.filter((p: any) => new Date(p.legA?.closedAt || 0).getTime() >= cutoff24h);
    const ret24hClosed = recent.reduce((s: number, p: any) => s + (+p.pair_return), 0);
    const ret24h = ret24hClosed + openPnL;

    // Per-TF 24h returns (closed)
    const tf24h: Record<string, number> = { "1m": 0, "1h": 0, "1d": 0 };
    for (const p of recent) {
      const bm = getPairBm(p);
      const tf = bm >= 1440 ? "1d" : bm >= 60 ? "1h" : "1m";
      tf24h[tf] += +p.pair_return;
    }
    // Add open PnL per TF
    for (const p of openPairs) {
      let legAret = 0, legBret = 0;
      const cpA = prices[p.legA?.symbol];
      const cpB = prices[p.legB?.symbol];
      if (cpA && p.legA?.entryPrice) { legAret = p.legA.direction === "LONG" ? (cpA / p.legA.entryPrice - 1) * 100 : (p.legA.entryPrice / cpA - 1) * 100; }
      if (cpB && p.legB?.entryPrice) { legBret = p.legB.direction === "LONG" ? (cpB / p.legB.entryPrice - 1) * 100 : (p.legB.entryPrice / cpB - 1) * 100; }
      const bm = getPairBm(p);
      const tf = bm >= 1440 ? "1d" : bm >= 60 ? "1h" : "1m";
      tf24h[tf] += legAret + legBret;
    }

    return { closed: closed.length, open: openCount, cumReturn, closedReturn, openPnL, winRate, mean, sharpe, ret24h, tf24h };
  }, [hedgedData, timeframe, prices]);`;

if (code.includes(oldMemo)) {
  code = code.replace(oldMemo, newMemo);
  console.log('Fixed: hedgedStats now includes open PnL');
} else {
  console.log('ERROR: Could not find hedgedStats memo');
  process.exit(1);
}

// 2. Revert equity card "closed N" display back to totalRet (closed+open)
// since user wants the combined return shown
const oldClosedDisplay = `style={{ color: closedRet >= 0 ? GREEN : RED }}>{closedRet >= 0 ? "+" : ""}{closedRet.toFixed(2)}%`;
const newClosedDisplay = `style={{ color: totalRet >= 0 ? GREEN : RED }}>{totalRet >= 0 ? "+" : ""}{totalRet.toFixed(2)}%`;

if (code.includes(oldClosedDisplay)) {
  code = code.replace(oldClosedDisplay, newClosedDisplay);
  console.log('Reverted: equity card closed line shows totalRet again');
} else {
  console.log('Note: equity card display already uses totalRet or pattern not found');
}

fs.writeFileSync(path, code);
console.log('Done - signals page patched');
