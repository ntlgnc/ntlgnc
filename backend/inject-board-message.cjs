/**
 * Injects the Filter Policy Change document into the next board meeting briefing
 * as an operator message. The board will see this at the top of their next meeting.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
if (!process.env.DATABASE_URL) require('dotenv').config();
const { Client } = require('pg');

const MESSAGE = `
╔══════════════════════════════════════════════════════════════════════════╗
║  FILTER POLICY CHANGE — EFFECTIVE IMMEDIATELY                          ║
║  Document: Filter Policy Change Justification (28 Feb 2026)            ║
╚══════════════════════════════════════════════════════════════════════════╝

The operator has completed a statistical audit of the 1M strategy filters.
Three changes are being implemented based on Spearman rank correlation analysis
of 18,692 out-of-sample signals:

━━━ CHANGE 1: REMOVE posInRange filter (#1) from 1M signals ━━━
REASON: Spearman ρ=0.5 (longs) and ρ=-0.5 (shorts) — neither meets the ρ=±1.0
reliability threshold. The filter blocks profitable long trades (Bottom bucket
SR +3.85, n=4,161). The apparent +172% improvement may reflect short-term market
conditions rather than a durable pattern.

━━━ CHANGE 2: ADD Hurst Exponent filter for 1M SHORTS ━━━
Block: Mean-Rev (<0.45) and Random (0.45-0.55) buckets.
Pass: Trending (>0.55) only.
REASON: Perfect Spearman ρ=1.0 with spread 22.3 (highest of any 1M short feature).
Short signals detect upward exhaustion. In trending markets, momentum breaks and
reversals follow through. In mean-reverting/random markets, there is no sustained
momentum to exhaust — shorts trigger on noise with no follow-through.
Blocks 3,763 losing trades. Preserves 757 trending shorts (SR +5.97).

━━━ CHANGE 3: ADD 5-Day Trend filter for 1M LONGS ━━━
Block: Bull (>0.3) bucket.
Pass: Bear and Neutral.
REASON: Perfect Spearman ρ=1.0 with spread 15.2. Long signals detect downward
exhaustion. In bearish markets, dips to exhaustion represent genuine oversold
conditions with snap-back potential (SR +14.5, n=2,550). In bullish markets,
the same exhaustion level is reached by minor pullbacks — not genuine selling
pressure. No oversold energy means no bounce.
Blocks 1,943 marginally losing trades (SR -0.69).

━━━ BOARD DIRECTIVE ━━━
These changes are based on rigorous statistical analysis. The board should:
1. Note these changes in the meeting record
2. Continue monitoring 1M Sharpe over the next 48-72 hours
3. NOT re-propose posInRange filters for 1M (insufficient statistical basis)
4. Consider proposing Hurst and Trend5d filters for other timeframes if ρ=1.0

Full justification document available in the Research section of the site.
`;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Deactivate any existing operator messages
  await client.query(`UPDATE board_operator_messages SET active = false WHERE active = true`);

  // Insert new message (expires in 72 hours so it's seen across multiple meetings)
  await client.query(
    `INSERT INTO board_operator_messages (message, active, expires_at)
     VALUES ($1, true, NOW() + INTERVAL '72 hours')`,
    [MESSAGE.trim()]
  );

  console.log('✓ Operator message injected into board meeting briefing');
  console.log('  The board will see this at the top of their next meeting.');
  console.log('  Expires in 72 hours.');

  await client.end();
}

main().catch(err => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});
