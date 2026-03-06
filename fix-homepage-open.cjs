// Fix: Include open trade PnL in homepage hedged-stats API
const fs = require('fs');
const path = '/opt/ntlgnc/frontend/app/api/signals/route.ts';
let code = fs.readFileSync(path, 'utf8');

// Find the hedged-stats return block and add open PnL calculation
// We need to fetch current prices for open pairs and calculate their PnL

const oldReturn = `      return NextResponse.json({
        hedgedStats: {
          period,
          closedPairs: allRets.length,
          wins,
          cumReturn: Math.round(cumReturn * 1000) / 1000,
          winRate: Math.round(winRate * 10) / 10,
          sharpe: Math.round(sharpe * 100) / 100,
          openPairs: openRows.length,
        },
        byTimeframe: {
          "1m": { ...calcStats(byTf["1m"]), open: openByTf["1m"] },
          "1h": { ...calcStats(byTf["1h"]), open: openByTf["1h"] },
          "1d": { ...calcStats(byTf["1d"]), open: openByTf["1d"] },
        },
      });
    }`;

const newReturn = `      // Fetch open pair details for mark-to-market PnL
      const { rows: openPairDetails } = await pool.query(\`
        SELECT s.pair_id, s.symbol, s.direction, s."entryPrice",
          CASE WHEN st."barMinutes" >= 1440 THEN '1d'
               WHEN st."barMinutes" >= 60 THEN '1h'
               ELSE '1m' END as tf
        FROM "FracmapSignal" s
        LEFT JOIN "FracmapStrategy" st ON s."strategyId" = st.id
        WHERE s.pair_id IS NOT NULL AND s.status = 'open'
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

if (code.includes(oldReturn)) {
  code = code.replace(oldReturn, newReturn);
  console.log('Fixed: hedged-stats API now includes open PnL');
} else {
  console.log('ERROR: Could not find hedged-stats return block');
  process.exit(1);
}

fs.writeFileSync(path, code);
console.log('Done - API patched');
