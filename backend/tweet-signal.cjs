/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  FRACMAP — TWITTER SIGNAL BOT                                   ║
 * ║  Posts tweets when live-signals engine generates buy/sell alerts ║
 * ║  Fire-and-forget — errors never crash the signal engine         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const { TwitterApi } = require('twitter-api-v2');

// ── Config from env ──
const ENABLED     = process.env.TWITTER_TWEET_ENABLED === 'true';
const DRY_RUN     = process.env.TWITTER_TWEET_DRY_RUN === 'true';
const MIN_TF      = process.env.TWITTER_TWEET_MIN_TIMEFRAME || '1h';
const MIN_STR     = parseInt(process.env.TWITTER_TWEET_MIN_STRENGTH || '2', 10);
const COOLDOWN_MS = (parseInt(process.env.TWITTER_TWEET_COOLDOWN_MINUTES || '30', 10)) * 60 * 1000;

// ── Timeframe ordering for filter comparison ──
const TF_RANK = { '1m': 0, '5m': 1, '15m': 2, '1h': 3, '4h': 4, '1d': 5 };

// ── In-memory cooldown map: symbol → last tweet timestamp ──
const cooldowns = new Map();

// ── Twitter client (lazy init) ──
let client = null;

function getClient() {
  if (client) return client;
  const apiKey       = process.env.TWITTER_API_KEY;
  const apiSecret    = process.env.TWITTER_API_SECRET;
  const accessToken  = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    return null;
  }
  client = new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken,
    accessSecret,
  });
  return client;
}

// ── Format price with commas ──
function fmtPrice(p) {
  const n = parseFloat(p);
  if (isNaN(n)) return String(p);
  return n >= 1
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toPrecision(4);
}

// ── Build hashtags from symbol ──
function hashtagsFor(symbol) {
  const base = symbol.replace(/USDT$/, '').replace(/USD$/, '');
  const tags = ['#crypto', `#${base}`, '#trading'];
  if (base === 'BTC') tags.push('#Bitcoin');
  if (base === 'ETH') tags.push('#Ethereum');
  return tags.join(' ');
}

// ── Format regime description ──
function regimeText(regime) {
  if (!regime) return '';
  const parts = [];
  if (regime.trend)    parts.push(regime.trend);
  if (regime.volState) parts.push(regime.volState.toLowerCase() + ' vol');
  if (regime.posInRange60 !== undefined) {
    const pir = (regime.posInRange60 * 100).toFixed(0);
    parts.push(`PiR ${pir}%`);
  }
  return parts.length ? parts.join(', ') : '';
}

// ── Build tweet text ──
function formatTweet({ symbol, direction, entryPrice, strength, timeframe, regime }) {
  const emoji = direction === 'LONG' ? '🟢' : '🔴';
  const action = direction === 'LONG' ? 'LONG' : 'SHORT';
  const regime_line = regimeText(regime);

  let text = `${emoji} ${symbol} ${action} signal (${timeframe})\n`;
  text += `Entry: $${fmtPrice(entryPrice)} | Strength: ${strength}/3\n`;
  if (regime_line) text += `Regime: ${regime_line}\n`;
  text += `\nfracmap.com/signals\n\n`;
  text += hashtagsFor(symbol);
  return text;
}

/**
 * Main export — call after every signal INSERT.
 * Fire-and-forget: never throws.
 */
async function tweetSignal({ symbol, direction, entryPrice, strength, timeframe, signalId, regime }) {
  try {
    if (!ENABLED) return;

    // ── Timeframe filter ──
    const tfRank = TF_RANK[timeframe] ?? -1;
    const minRank = TF_RANK[MIN_TF] ?? 3;
    if (tfRank < minRank) return;

    // ── Strength filter ──
    if ((strength || 0) < MIN_STR) return;

    // ── Cooldown per symbol ──
    const key = `${symbol}-${timeframe}`;
    const last = cooldowns.get(key) || 0;
    if (Date.now() - last < COOLDOWN_MS) {
      console.log(`[TWEET] Cooldown active for ${key}, skipping`);
      return;
    }

    const text = formatTweet({ symbol, direction, entryPrice, strength, timeframe, regime });

    // ── Dry run mode ──
    if (DRY_RUN) {
      console.log(`[TWEET-DRY] Would post (signal ${signalId}):\n${text}`);
      cooldowns.set(key, Date.now());
      return;
    }

    // ── Post tweet ──
    const tw = getClient();
    if (!tw) {
      console.log('[TWEET] Twitter credentials not configured, skipping');
      return;
    }

    const result = await tw.v2.tweet(text);
    cooldowns.set(key, Date.now());
    console.log(`[TWEET] Posted for ${symbol} ${direction} (${timeframe}), tweet ID: ${result.data?.id}`);
  } catch (err) {
    // Never throw — signal engine must not be affected
    console.error(`[TWEET] Error posting for ${symbol}: ${err.message}`);
  }
}

module.exports = { tweetSignal };
