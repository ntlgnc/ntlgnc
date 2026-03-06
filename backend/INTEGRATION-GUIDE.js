/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  INTEGRATION GUIDE — Wiring Coin Quality Gate into live-signals ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * This file documents the exact changes needed to integrate the coin
 * quality gate into the existing signal pipeline.
 *
 * THREE changes are required in live-signals.cjs:
 *
 * ────────────────────────────────────────────────────────────────────
 * CHANGE 1: Add import at the top (line ~19, after checkMatrix import)
 * ────────────────────────────────────────────────────────────────────
 *
 *   const { checkMatrix } = require('./filter-matrix-check.cjs');
 * + const { checkCoinQuality, invalidateCoinCache } = require('./coin-quality-gate.cjs');
 *
 *
 * ────────────────────────────────────────────────────────────────────
 * CHANGE 2: Add coin quality check after regime + matrix filters
 *           (around line ~694, after the matrixResult check)
 * ────────────────────────────────────────────────────────────────────
 *
 *   Find this block:
 *
 *     // Also check per-strategy filter matrix
 *     let matrixResult = { pass: true, blockedBy: null, reason: null };
 *     if (filterResult.pass) {
 *       matrixResult = await checkMatrix(client, strategyId, signal.direction, regimeSnap);
 *     }
 *
 *   Add after it:
 *
 * +   // Also check per-coin quality gate (Tier 2)
 * +   let coinResult = { pass: true, reason: null };
 * +   if (filterResult.pass && matrixResult.pass) {
 * +     coinResult = await checkCoinQuality(client, symbol, strategyId);
 * +   }
 *
 *   Then modify the blocking condition from:
 *
 *     if (!filterResult.pass || !matrixResult.pass) {
 *
 *   To:
 *
 * -   if (!filterResult.pass || !matrixResult.pass) {
 * +   if (!filterResult.pass || !matrixResult.pass || !coinResult.pass) {
 *
 *   And add logging for coin blocks inside the blocked branch:
 *
 *     if (!matrixResult.pass) {
 *       console.log(`  [MATRIX] ${symbol} ${signal.direction} blocked: ${matrixResult.reason}`);
 *     }
 * +   if (!coinResult.pass) {
 * +     console.log(`  [COIN-GATE] ${symbol} ${signal.direction} blocked: ${coinResult.reason}`);
 * +   }
 *
 *
 * ────────────────────────────────────────────────────────────────────
 * CHANGE 3: Invalidate coin cache after closing signals
 *           (after the closing loop, around line ~680)
 * ────────────────────────────────────────────────────────────────────
 *
 *   Find this block (after the signal closing loop):
 *
 *     if (newSignals > 0 || closedSignals > 0) {
 *       console.log(`[${config.label}] ...`);
 *     }
 *
 *   Add before it:
 *
 * +   // Invalidate coin quality cache after closes so next tick picks up new data
 * +   if (closedSignals > 0) invalidateCoinCache();
 *
 *
 * ════════════════════════════════════════════════════════════════════
 * FULL DIFF (for reference)
 * ════════════════════════════════════════════════════════════════════
 *
 * --- a/backend/live-signals.cjs
 * +++ b/backend/live-signals.cjs
 * @@ -18,6 +18,7 @@
 *  require('dotenv').config();
 *  const { Client, Pool } = require('pg');
 *  const { checkMatrix } = require('./filter-matrix-check.cjs');
 * +const { checkCoinQuality, invalidateCoinCache } = require('./coin-quality-gate.cjs');
 *
 * @@ ~694 (inside the tick function, after matrix check)
 *              let matrixResult = { pass: true, blockedBy: null, reason: null };
 *              if (filterResult.pass) {
 *                matrixResult = await checkMatrix(client, strategyId, signal.direction, regimeSnap);
 *              }
 *
 * +            // Tier 2: Per-coin rolling quality gate
 * +            let coinResult = { pass: true, reason: null };
 * +            if (filterResult.pass && matrixResult.pass) {
 * +              coinResult = await checkCoinQuality(client, symbol, strategyId);
 * +            }
 *
 * -            if (!filterResult.pass || !matrixResult.pass) {
 * +            if (!filterResult.pass || !matrixResult.pass || !coinResult.pass) {
 *                // Signal blocked — write as filtered for tracking
 * @@ inside the blocked branch
 *                if (!matrixResult.pass) {
 *                  console.log(`  [MATRIX] ${symbol} ${signal.direction} blocked: ${matrixResult.reason}`);
 *                }
 * +              if (!coinResult.pass) {
 * +                console.log(`  [COIN-GATE] ${symbol} ${signal.direction} blocked: ${coinResult.reason}`);
 * +              }
 *
 * @@ ~750 (after the main loop, before the "newSignals" log)
 * +      // Refresh coin quality data after closes
 * +      if (closedSignals > 0) invalidateCoinCache();
 *
 *        if (newSignals > 0 || closedSignals > 0) {
 */

// This file is documentation only — it is not executable.
// The actual module is in coin-quality-gate.cjs
