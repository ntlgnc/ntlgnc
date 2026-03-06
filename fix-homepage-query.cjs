const fs = require('fs');
const apiPath = '/opt/ntlgnc/frontend/app/api/signals/route.ts';
let code = fs.readFileSync(apiPath, 'utf8');

// Replace the entire hedged-stats action with a corrected version
// that properly counts pairs (requires both legs present and both closed)

const oldAction = `if (action === "hedged-stats") {
      const period = searchParams.get("period") || "24h";
      const intervals: Record<string, string> = {
        "24h": "1 day", "1w": "7 days", "1m": "30 days",
      };
      const interval = intervals[period] || "1 day";

      // Per-timeframe closed hedged pairs
      const { rows: tfRows } = await pool.query(\`
        SELECT sub.tf, sub.pair_return
        FROM (
          SELECT DISTINCT ON (s.pair_id) s.pair_id, s.pair_return,
            CASE WHEN st."barMinutes" >= 1440 THEN '1d'
                 WHEN st."barMinutes" >= 60 THEN '1h'
                 ELSE '1m' END as tf
          FROM "FracmapSignal" s
          LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
          WHERE s.pair_id IS NOT NULL AND s.pair_return IS NOT NULL
            AND s.status = 'closed' AND s."closedAt" > NOW() - INTERVAL '\${interval}'
            AND (st.active = true OR s."strategyId" IS NULL)
        ) sub
      \`);

      // Build per-TF stats
      const byTf: Record<string, number[]> = { "1m": [], "1h": [], "1d": [] };
      for (const r of tfRows) {
        const ret = parseFloat(r.pair_return) || 0;
        const tf = r.tf || "1m";
        if (byTf[tf]) byTf[tf].push(ret);
      }

      const calcStats = (rets: number[]) => {
        const cum = rets.reduce((s, r) => s + r, 0);
        const wins = rets.filter(r => r > 0).length;
        const winRate = rets.length > 0 ? (wins / rets.length * 100) : 0;
        return {
          pairs: rets.length,
          wins,
          cumReturn: Math.round(cum * 1000) / 1000,
          winRate: Math.round(winRate * 10) / 10,
        };
      };

      // Open hedged pairs per TF
      const { rows: openRows } = await pool.query(\`
        SELECT DISTINCT ON (s.pair_id) s.pair_id,
          CASE WHEN st."barMinutes" >= 1440 THEN '1d'
               WHEN st."barMinutes" >= 60 THEN '1h'
               ELSE '1m' END as tf
        FROM "FracmapSignal" s
        LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.pair_id IS NOT NULL AND s.status = 'open'
            AND (st.active = true OR s."strategyId" IS NULL)
      \`);
      const openByTf: Record<string, number> = { "1m": 0, "1h": 0, "1d": 0 };
      for (const r of openRows) { if (openByTf[r.tf] != null) openByTf[r.tf]++; }

      // Combined stats for backwards compat
      const allRets = tfRows.map((r: any) => parseFloat(r.pair_return) || 0);
      const cumReturn = allRets.reduce((s: number, r: number) => s + r, 0);
      const wins = allRets.filter((r: number) => r > 0).length;
      const winRate = allRets.length > 0 ? (wins / allRets.length * 100) : 0;
      const mean = allRets.length > 0 ? cumReturn / allRets.length : 0;
      const std = allRets.length > 1 ? Math.sqrt(allRets.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / allRets.length) : 0;
      const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

      // Fetch open pair details for mark-to-market PnL
      const { rows: openPairDetails } = await pool.query(\`
        SELECT s.pair_id, s.symbol, s.direction, s."entryPrice",
          CASE WHEN st."barMinutes" >= 1440 THEN '1d'
               WHEN st."barMinutes" >= 60 THEN '1h'
               ELSE '1m' END as tf
        FROM "FracmapSignal" s
        LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.pair_id IS NOT NULL AND s.status = 'open'
            AND (st.active = true OR s."strategyId" IS NULL)
      \`);

      // Fetch current prices for open symbols
      const openSymbols = [...new Set(openPairDetails.map((r: any) => r.symbol))];
      let openPrices: Record<string, number> = {};
      if (openSymbols.length > 0) {
        try {
          const priceResp = await fetch(\`https://api.binance.com/api/v3/ticker/price?symbols=[\${openSymbols.map((s: string) => \`"\${s}"\`).join(",")}]\`);
          const priceData = await priceResp.json();
          for (const p of priceData) {
            if (p.symbol && p.price) openPrices[p.symbol] = parseFloat(p.price);
          }
        } catch (e) { /* ignore price fetch errors */ }
      }

      // Calculate open PnL per pair and per TF
      const openPairMap: Record<string, { legs: any[] }> = {};
      for (const r of openPairDetails) {
        if (!openPairMap[r.pair_id]) openPairMap[r.pair_id] = { legs: [] };
        openPairMap[r.pair_id].legs.push(r);
      }
      let totalOpenPnL = 0;
      const openPnLByTf: Record<string, number> = { "1m": 0, "1h": 0, "1d": 0 };
      for (const [, pair] of Object.entries(openPairMap)) {
        let pairPnL = 0;
        let tf = "1m";
        for (const leg of pair.legs) {
          const cp = openPrices[leg.symbol];
          if (cp && leg.entryPrice) {
            const ret = leg.direction === "LONG"
              ? (cp / leg.entryPrice - 1) * 100
              : (leg.entryPrice / cp - 1) * 100;
            pairPnL += ret;
          }
          tf = leg.tf || "1m";
        }
        totalOpenPnL += pairPnL;
        if (openPnLByTf[tf] != null) openPnLByTf[tf] += pairPnL;
      }

      const totalReturn = cumReturn + totalOpenPnL;

      return NextResponse.json({
        hedgedStats: {
          period,
          closedPairs: allRets.length,
          wins,
          cumReturn: Math.round(totalReturn * 1000) / 1000,
          closedReturn: Math.round(cumReturn * 1000) / 1000,
          openPnL: Math.round(totalOpenPnL * 1000) / 1000,
          winRate: Math.round(winRate * 10) / 10,
          sharpe: Math.round(sharpe * 100) / 100,
          openPairs: openRows.length,
        },
        byTimeframe: {
          "1m": { ...calcStats(byTf["1m"]), open: openByTf["1m"], openPnL: Math.round(openPnLByTf["1m"] * 1000) / 1000 },
          "1h": { ...calcStats(byTf["1h"]), open: openByTf["1h"], openPnL: Math.round(openPnLByTf["1h"] * 1000) / 1000 },
          "1d": { ...calcStats(byTf["1d"]), open: openByTf["1d"], openPnL: Math.round(openPnLByTf["1d"] * 1000) / 1000 },
        },
      });
    }`;

const newAction = `if (action === "hedged-stats") {
      const period = searchParams.get("period") || "24h";
      const intervals: Record<string, string> = {
        "24h": "1 day", "1w": "7 days", "1m": "30 days",
      };
      const interval = intervals[period] || "1 day";

      // Fetch ALL paired signals (same approach as hedged-pairs action)
      const { rows: allSignals } = await pool.query(\`
        SELECT s.id, s.symbol, s.direction, s."entryPrice", s."returnPct",
               s.status, s."createdAt", s."closedAt", s.pair_id, s.pair_return,
               st."barMinutes"
        FROM "FracmapSignal" s
        LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.pair_id IS NOT NULL
          AND s.status IN ('open', 'closed')
          AND (st.active = true OR s."strategyId" IS NULL)
      \`);

      // Group by pair_id — require exactly 2 legs
      const pairMap: Record<string, any[]> = {};
      for (const s of allSignals) {
        if (!pairMap[s.pair_id]) pairMap[s.pair_id] = [];
        pairMap[s.pair_id].push(s);
      }

      const pairs: any[] = [];
      for (const [pairId, legs] of Object.entries(pairMap)) {
        if (legs.length !== 2) continue;
        const [legA, legB] = legs.sort((a: any, b: any) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        const pairStatus = legA.status === 'closed' && legB.status === 'closed' ? 'closed' : 'open';
        const bm = legA.barMinutes || legB.barMinutes || 1;
        const tf = bm >= 1440 ? '1d' : bm >= 60 ? '1h' : '1m';
        pairs.push({ pairId, legA, legB, status: pairStatus, pair_return: legA.pair_return, tf });
      }

      // Filter closed pairs by time window (using closedAt)
      const cutoff = new Date(Date.now() - ({ "24h": 86400_000, "1w": 7*86400_000, "1m": 30*86400_000 }[period] || 86400_000));
      const closedPairs = pairs.filter(p =>
        p.status === 'closed' && p.pair_return != null &&
        new Date(p.legA.closedAt || p.legB.closedAt || 0) >= cutoff
      );
      const openPairs = pairs.filter(p => p.status === 'open');

      // Per-TF stats for closed
      const byTf: Record<string, number[]> = { "1m": [], "1h": [], "1d": [] };
      for (const p of closedPairs) {
        if (byTf[p.tf]) byTf[p.tf].push(parseFloat(p.pair_return) || 0);
      }

      const calcStats = (rets: number[]) => {
        const cum = rets.reduce((s, r) => s + r, 0);
        const wins = rets.filter(r => r > 0).length;
        const winRate = rets.length > 0 ? (wins / rets.length * 100) : 0;
        return { pairs: rets.length, wins, cumReturn: Math.round(cum * 1000) / 1000, winRate: Math.round(winRate * 10) / 10 };
      };

      // Open pair counts per TF
      const openByTf: Record<string, number> = { "1m": 0, "1h": 0, "1d": 0 };
      for (const p of openPairs) { if (openByTf[p.tf] != null) openByTf[p.tf]++; }

      // Combined closed stats
      const allRets = closedPairs.map(p => parseFloat(p.pair_return) || 0);
      const cumReturn = allRets.reduce((s: number, r: number) => s + r, 0);
      const wins = allRets.filter((r: number) => r > 0).length;
      const winRate = allRets.length > 0 ? (wins / allRets.length * 100) : 0;
      const mean = allRets.length > 0 ? cumReturn / allRets.length : 0;
      const std = allRets.length > 1 ? Math.sqrt(allRets.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / allRets.length) : 0;
      const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

      // Calculate open PnL from live prices
      const openSymbols = [...new Set(openPairs.flatMap(p => [p.legA.symbol, p.legB.symbol]))];
      let openPrices: Record<string, number> = {};
      if (openSymbols.length > 0) {
        try {
          const priceResp = await fetch(\`https://api.binance.com/api/v3/ticker/price?symbols=[\${openSymbols.map((s: string) => \`"\${s}"\`).join(",")}]\`);
          const priceData = await priceResp.json();
          for (const p of priceData) { if (p.symbol && p.price) openPrices[p.symbol] = parseFloat(p.price); }
        } catch (e) { /* ignore */ }
      }

      let totalOpenPnL = 0;
      const openPnLByTf: Record<string, number> = { "1m": 0, "1h": 0, "1d": 0 };
      for (const p of openPairs) {
        let pnl = 0;
        for (const leg of [p.legA, p.legB]) {
          const cp = openPrices[leg.symbol];
          if (cp && leg.entryPrice) {
            pnl += leg.direction === "LONG" ? (cp / leg.entryPrice - 1) * 100 : (leg.entryPrice / cp - 1) * 100;
          }
        }
        totalOpenPnL += pnl;
        if (openPnLByTf[p.tf] != null) openPnLByTf[p.tf] += pnl;
      }

      const totalReturn = cumReturn + totalOpenPnL;

      return NextResponse.json({
        hedgedStats: {
          period,
          closedPairs: closedPairs.length,
          wins,
          cumReturn: Math.round(totalReturn * 1000) / 1000,
          closedReturn: Math.round(cumReturn * 1000) / 1000,
          openPnL: Math.round(totalOpenPnL * 1000) / 1000,
          winRate: Math.round(winRate * 10) / 10,
          sharpe: Math.round(sharpe * 100) / 100,
          openPairs: openPairs.length,
        },
        byTimeframe: {
          "1m": { ...calcStats(byTf["1m"]), open: openByTf["1m"], openPnL: Math.round(openPnLByTf["1m"] * 1000) / 1000 },
          "1h": { ...calcStats(byTf["1h"]), open: openByTf["1h"], openPnL: Math.round(openPnLByTf["1h"] * 1000) / 1000 },
          "1d": { ...calcStats(byTf["1d"]), open: openByTf["1d"], openPnL: Math.round(openPnLByTf["1d"] * 1000) / 1000 },
        },
      });
    }`;

if (code.includes(oldAction)) {
  code = code.replace(oldAction, newAction);
  console.log('Replaced hedged-stats action with corrected pair-counting logic');
} else {
  console.log('ERROR: Could not find hedged-stats action to replace');
  process.exit(1);
}

fs.writeFileSync(apiPath, code);
console.log('Done');
