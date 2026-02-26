/**
 * evolution-cron.js — Autonomous prompt evolution scheduler
 *
 * Run alongside forecast-multi.js and scoring-engine.js:
 *   node evolution-cron.js
 *
 * Responsibilities:
 *   1. Pick up 'pending' rounds (created via API trigger or auto-scheduled)
 *   2. Run the full evolution pipeline (proposal → debate → vote → A/B)
 *   3. Check completed A/B tests and evaluate results
 *   4. Auto-trigger new rounds every 24h (when enabled)
 *
 * Can be added to ecosystem.config.js for PM2 management.
 */

import 'dotenv/config';
import {
  triggerEvolutionRound,
  checkABTests,
  getEvolutionState,
} from './prompt-evolution.js';
import pg from 'pg';

const { Client } = pg;
const DB_URL = process.env.DATABASE_URL;
const CHECK_INTERVAL = 5 * 60 * 1000;  // Check every 5 minutes
const AUTO_TRIGGER = process.env.EVOLUTION_AUTO_TRIGGER === 'true';

console.log('[evolution-cron] Starting prompt evolution scheduler');
console.log(`[evolution-cron] Auto-trigger: ${AUTO_TRIGGER}`);
console.log(`[evolution-cron] Check interval: ${CHECK_INTERVAL / 1000}s`);

async function processPendingRounds() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  try {
    // Find pending rounds that need processing
    const { rows } = await client.query(`
      SELECT id, round_number, proposer_provider
      FROM "PromptEvolution"
      WHERE phase = 'pending'
      ORDER BY started_at ASC
      LIMIT 1
    `);

    if (rows.length === 0) return false;

    const round = rows[0];
    console.log(`[evolution-cron] Processing pending round ${round.round_number}...`);

    // Update to 'proposal' phase so it doesn't get picked up again
    await client.query(`
      UPDATE "PromptEvolution" SET phase = 'proposal' WHERE id = $1
    `, [round.id]);

    // Close this connection — triggerEvolutionRound opens its own
    await client.end();

    // Run the full pipeline
    const result = await triggerEvolutionRound();
    console.log(`[evolution-cron] Round result:`, JSON.stringify(result));
    return true;

  } catch (err) {
    console.error('[evolution-cron] Error processing pending round:', err.message);
    await client.end().catch(() => {});
    return false;
  }
}

async function tick() {
  const now = new Date();
  const timeStr = now.toISOString().slice(11, 19);

  try {
    // 1. Process any pending rounds
    const processed = await processPendingRounds();
    if (processed) return;  // Don't do anything else this tick

    // 2. Check if any A/B tests need evaluation
    const evaluated = await checkABTests();
    if (evaluated > 0) {
      console.log(`[evolution-cron] [${timeStr}] Evaluated ${evaluated} A/B test(s)`);
      return;
    }

    // 3. Auto-trigger if enabled and conditions met
    if (AUTO_TRIGGER) {
      const state = await getEvolutionState();
      if (!state.activeRound && !state.abTest) {
        // Check if 24h since last round
        const lastRound = state.history[0];
        if (lastRound) {
          const hoursSince = (Date.now() - new Date(lastRound.started_at).getTime()) / (1000 * 60 * 60);
          if (hoursSince >= 24) {
            console.log(`[evolution-cron] [${timeStr}] Auto-triggering evolution round (${hoursSince.toFixed(1)}h since last)`);
            const result = await triggerEvolutionRound();
            console.log(`[evolution-cron] Auto-trigger result:`, JSON.stringify(result));
          }
        } else {
          // No previous rounds — trigger the first one
          console.log(`[evolution-cron] [${timeStr}] Auto-triggering first evolution round`);
          const result = await triggerEvolutionRound();
          console.log(`[evolution-cron] First round result:`, JSON.stringify(result));
        }
      }
    }

  } catch (err) {
    console.error(`[evolution-cron] [${timeStr}] Tick error:`, err.message);
  }
}

// Initial run
tick();

// Schedule
setInterval(tick, CHECK_INTERVAL);

console.log('[evolution-cron] Scheduler running. Ctrl+C to stop.');
