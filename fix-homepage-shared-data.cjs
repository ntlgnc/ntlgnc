const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/page.tsx';
let code = fs.readFileSync(path, 'utf8');

// Replace the hedged-stats fetch with hedged-pairs fetch + client-side computation
// This ensures homepage uses the SAME data as signals page

const GREEN = '"#22c55e"';
const RED = '"#ef4444"';

const oldFetch = `  useEffect(() => {
    const load = () => {
      fetch(\`/api/signals?action=hedged-stats&period=\${statsPeriod}\`)
        .then(r => r.json())
        .then(d => { if (d.hedgedStats) setStats(d.hedgedStats); if (d.byTimeframe) setByTf(d.byTimeframe); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, [statsPeriod]);`;

const newFetch = `  useEffect(() => {
    const load = async () => {
      try {
        // Fetch ALL hedged pairs (same endpoint as signals page)
        const resp = await fetch("/api/signals?action=hedged-pairs&timeframe=ALL");
        const data = await resp.json();
        if (!data.pairs) return;

        // Fetch current prices for open pairs
        const openPairs = data.pairs.filter((p: any) => p.status === "open");
        const openSymbols = [...new Set(openPairs.flatMap((p: any) => [p.legA?.symbol, p.legB?.symbol].filter(Boolean)))];
        let prices: Record<string, number> = {};
        if (openSymbols.length > 0) {
          try {
            const pr = await fetch(\`/api/signals?action=prices&symbols=\${openSymbols.join(",")}\`);
            const pd = await pr.json();
            if (pd.prices) prices = pd.prices;
          } catch {}
        }

        // Apply time window filter (same logic as signals page)
        const windowMs: Record<string, number> = { "24h": 86400_000, "1w": 7 * 86400_000, "1m": 30 * 86400_000 };
        const cutoff = Date.now() - (windowMs[statsPeriod] || 86400_000);
        const windowPairs = data.pairs.filter((p: any) => {
          if (p.status === "open") return true;
          const closedAt = new Date(p.legA?.closedAt || p.legB?.closedAt || p.legA?.createdAt || 0).getTime();
          return closedAt >= cutoff;
        });

        // Group by TF
        const getPairTf = (p: any): string => {
          const bm = p.legA?.barMinutes || p.legB?.barMinutes;
          if (bm && bm >= 1440) return "1d";
          if (bm && bm >= 60) return "1h";
          return "1m";
        };

        const tfData: Record<string, { closed: number[]; openCount: number; openPnL: number }> = {
          "1m": { closed: [], openCount: 0, openPnL: 0 },
          "1h": { closed: [], openCount: 0, openPnL: 0 },
          "1d": { closed: [], openCount: 0, openPnL: 0 },
        };

        for (const p of windowPairs) {
          const tf = getPairTf(p);
          if (!tfData[tf]) continue;
          if (p.status === "closed" && p.pair_return != null) {
            tfData[tf].closed.push(+p.pair_return);
          } else if (p.status === "open") {
            tfData[tf].openCount++;
            let pnl = 0;
            for (const leg of [p.legA, p.legB]) {
              if (!leg) continue;
              const cp = prices[leg.symbol];
              if (cp && leg.entryPrice) {
                pnl += leg.direction === "LONG" ? (cp / leg.entryPrice - 1) * 100 : (leg.entryPrice / cp - 1) * 100;
              }
            }
            tfData[tf].openPnL += pnl;
          }
        }

        // Build byTimeframe for display
        const byTfResult: Record<string, any> = {};
        let totalClosed = 0, totalWins = 0, totalClosedRet = 0, totalOpenPnL = 0, totalOpen = 0;
        for (const tf of ["1m", "1h", "1d"]) {
          const d = tfData[tf];
          const cum = d.closed.reduce((s, r) => s + r, 0);
          const wins = d.closed.filter(r => r > 0).length;
          const winRate = d.closed.length > 0 ? (wins / d.closed.length * 100) : 0;
          byTfResult[tf] = { pairs: d.closed.length, wins, cumReturn: cum, winRate, open: d.openCount, openPnL: d.openPnL };
          totalClosed += d.closed.length;
          totalWins += wins;
          totalClosedRet += cum;
          totalOpenPnL += d.openPnL;
          totalOpen += d.openCount;
        }

        const allRets = Object.values(tfData).flatMap(d => d.closed);
        const mean = allRets.length > 0 ? totalClosedRet / allRets.length : 0;
        const std = allRets.length > 1 ? Math.sqrt(allRets.reduce((a, b) => a + (b - mean) ** 2, 0) / allRets.length) : 0;
        const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

        setStats({
          period: statsPeriod,
          closedPairs: totalClosed,
          wins: totalWins,
          cumReturn: totalClosedRet + totalOpenPnL,
          winRate: totalClosed > 0 ? (totalWins / totalClosed * 100) : 0,
          sharpe,
          openPairs: totalOpen,
        });
        setByTf(byTfResult);
      } catch {}
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, [statsPeriod]);`;

if (code.includes(oldFetch)) {
  code = code.replace(oldFetch, newFetch);
  console.log('Fixed: homepage now uses hedged-pairs API (same as signals page)');
} else {
  console.log('ERROR: Could not find old fetch pattern');
  process.exit(1);
}

fs.writeFileSync(path, code);
console.log('Done');
