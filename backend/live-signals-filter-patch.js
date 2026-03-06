// ═══════════════════════════════════════════════════════════════
// LIVE-SIGNALS.CJS — FILTER WIRING PATCH
// ═══════════════════════════════════════════════════════════════
//
// Apply these changes to backend/live-signals.cjs:
//
// 1. Add these requires at the top (after the existing requires):

// --- ADD AFTER LINE ~20 ---
const { getActiveDirectives, checkSignalAgainstFilters } = require('./llm-board.js');

// --- ADD NEW FUNCTION after ensureSignalTable() ---

// Compute basic regime features from the bar data at signal time
function computeRegimeSnapshot(bars, barIdx) {
  if (barIdx < 60) return null;
  
  const window = bars.slice(barIdx - 59, barIdx + 1); // last 60 bars
  const closes = window.map(b => b.close);
  const highs = window.map(b => b.high);
  const lows = window.map(b => b.low);
  
  // Position in Range (60-bar)
  const hi60 = Math.max(...highs);
  const lo60 = Math.min(...lows);
  const posInRange60 = hi60 > lo60 ? (closes[closes.length - 1] - lo60) / (hi60 - lo60) : 0.5;
  
  // ATR Compression
  const trs = [];
  for (let i = 1; i < window.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const atr60 = trs.reduce((a, b) => a + b, 0) / trs.length;
  const atrCompression = atr60 > 0 ? atr14 / atr60 : 1;
  
  // Vol State
  const volState = atrCompression < 0.7 ? 'COMPRESSED' : atrCompression > 1.3 ? 'EXPANDING' : 'NORMAL';
  
  // Simple trend (linear regression slope direction)
  const n = closes.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += closes[i]; sumXY += i * closes[i]; sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const trend60 = slope / (sumY / n) * n; // normalised trend
  
  // Hurst estimate (simplified R/S)
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const cumDev = [];
  let running = 0;
  for (const r of logReturns) { running += r - mean; cumDev.push(running); }
  const range = Math.max(...cumDev) - Math.min(...cumDev);
  const std = Math.sqrt(logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length);
  const hurst = std > 0 ? Math.log(range / std) / Math.log(logReturns.length) : 0.5;
  
  return {
    posInRange60: +posInRange60.toFixed(4),
    atrCompression: +atrCompression.toFixed(4),
    volState,
    trend60: +trend60.toFixed(4),
    hurst: +hurst.toFixed(4),
  };
}

// 2. Modify the signal insertion block (~line 391):
//
// BEFORE:
//   if (signal) {
//     // Write to DB
//     await client.query(
//       `INSERT INTO "FracmapSignal" ...
//
// AFTER (replace the entire `if (signal)` block):

/*
          if (signal) {
            // Compute regime snapshot at signal time
            const regimeSnapshot = computeRegimeSnapshot(bars, lastBar);
            
            // Check against board filters
            let filteredBy = null;
            let signalStatus = 'open';
            
            if (regimeSnapshot) {
              try {
                const directives = await getActiveDirectives();
                
                // Check coin exclusion
                const coinBase = symbol.replace('USDT', '');
                if (directives.excludedCoins.includes(coinBase) || directives.excludedCoins.includes(symbol)) {
                  filteredBy = -1; // -1 = excluded coin
                  signalStatus = 'filtered';
                  console.log(`  [FILTERED] ${symbol} ${signal.direction} — coin excluded`);
                }
                
                // Check regime filters
                if (!filteredBy && directives.filters.length > 0) {
                  const check = checkSignalAgainstFilters(signal, regimeSnapshot, directives.filters);
                  if (!check.pass) {
                    filteredBy = check.filter_id || -2;
                    signalStatus = 'filtered';
                    console.log(`  [FILTERED] ${symbol} ${signal.direction} — ${check.blocked_by}`);
                  }
                }
              } catch (err) {
                // Filter check failed — allow signal through
                console.warn(`  [WARN] Filter check failed for ${symbol}: ${err.message}`);
              }
            }
            
            // Write signal (both passed and filtered — filtered for counterfactual tracking)
            await client.query(
              `INSERT INTO "FracmapSignal" 
               ("strategyId", symbol, direction, "entryPrice", strength, "holdBars", 
                "maxCycle", "maxOrder", timeframe, filtered_by, regime_snapshot, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [strategyId, symbol, signal.direction, signal.entryPrice,
               signal.strength, signal.holdBars, signal.maxCycle, signal.maxOrder,
               config.label, filteredBy, JSON.stringify(regimeSnapshot), signalStatus]
            );
            
            if (signalStatus === 'open') {
              newSignals++;
            }
          }
*/

// 3. Add counterfactual closing for filtered signals
//    In the closing loop (around line 310-370), add after the existing close logic:

/*
      // Close expired FILTERED signals with counterfactual returns
      // These were blocked by filters but we track what would have happened
      const { rows: filteredSignals } = await client.query(
        `SELECT * FROM "FracmapSignal" 
         WHERE "strategyId" = $1 AND status = 'filtered' AND symbol = $2`,
        [strategyId, symbol]
      );
      
      for (const sig of filteredSignals) {
        const barsSince = Math.round(
          (Date.now() - new Date(sig.createdAt).getTime()) / (config.barMinutes * 60_000)
        );
        if (barsSince >= (sig.holdBars || 10)) {
          const currentPrice = bars[bars.length - 1]?.close;
          if (!currentPrice) continue;
          
          const ret = sig.direction === 'LONG'
            ? (currentPrice / sig.entryPrice - 1) * 100
            : (sig.entryPrice / currentPrice - 1) * 100;
          
          await client.query(
            `UPDATE "FracmapSignal" SET "exitPrice" = $1, "returnPct" = $2, 
             status = 'filtered_closed', "closedAt" = now() WHERE id = $3`,
            [currentPrice, +ret.toFixed(4), sig.id]
          );
          console.log(`  [COUNTERFACTUAL] ${symbol} id=${sig.id} dir=${sig.direction} ret=${ret.toFixed(4)}% (would have been)`);
        }
      }
*/
