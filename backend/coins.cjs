/**
 * coins.cjs — Shared coin list for the entire backend
 *
 * Dynamically fetches the top 100 USDT pairs from Binance by 24h quote volume,
 * excluding stablecoins and leveraged tokens.
 *
 * STICKY LIST: Once a coin enters the top 100, it stays tracked forever.
 * This prevents data gaps if a coin temporarily drops out of the top 100.
 * The full list of "ever seen" coins is persisted to coin-registry.json.
 *
 * Usage:
 *   const { getTopCoins, getAllTrackedCoins, FALLBACK_COINS } = require('./coins.cjs');
 *   const top100  = await getTopCoins(100);        // current top 100 (for predictions)
 *   const allEver = await getAllTrackedCoins();     // every coin ever in top 100 (for data collection)
 */

const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Stablecoins and wrapped/leveraged tokens to exclude
const EXCLUDED = new Set([
  'USDCUSDT', 'BUSDUSDT', 'TUSDUSDT', 'USDPUSDT', 'DAIUSDT',
  'FDUSDUSDT', 'EURUSDT', 'GBPUSDT', 'AEURUSDT', 'USTCUSDT',
  'PAXUSDT', 'GUSDUSDT', 'SUSDUSDT', 'FRAXUSDT', 'LUSDUSDT',
  'USDDUSDT', 'CRVUSDUSDT', 'PYUSDUSDT', 'USDEUSDT', 'USD1USDT',
  'RLUSDUSDT', 'USDSUSDT', 'EURCUSDT', 'EURIUSDT', 'USDNUSDT',
]);

// Patterns to exclude (leveraged tokens, fan tokens, etc.)
const EXCLUDED_PATTERNS = [/UP$/, /DOWN$/, /BULL$/, /BEAR$/];

// Hardcoded fallback — current top 20 (used if Binance API is unreachable on first ever run)
const FALLBACK_COINS = [
  'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'SOLUSDT',
  'TRXUSDT', 'DOGEUSDT', 'BCHUSDT', 'ADAUSDT', 'XLMUSDT',
  'LINKUSDT', 'HBARUSDT', 'LTCUSDT', 'ZECUSDT', 'AVAXUSDT',
  'SUIUSDT', 'SHIBUSDT', 'TONUSDT', 'DOTUSDT', 'UNIUSDT',
];

/* ═══ Persistent registry — "once in, always in" ═══ */

const REGISTRY_PATH = path.join(__dirname, 'coin-registry.json');

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
      return {
        coins: new Map(Object.entries(data.coins || {})),  // symbol → { firstSeen, lastInTop100 }
        lastRefresh: data.lastRefresh || 0,
      };
    }
  } catch (e) {
    console.warn(`[coins] Failed to load registry: ${e.message}`);
  }
  return { coins: new Map(), lastRefresh: 0 };
}

function saveRegistry(registry) {
  try {
    const obj = {
      coins: Object.fromEntries(registry.coins),
      lastRefresh: registry.lastRefresh,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn(`[coins] Failed to save registry: ${e.message}`);
  }
}

/* ═══ In-memory cache ═══ */

let _currentTop = null;     // latest top 100 by volume (sorted)
let _allTracked = null;     // full sticky list (sorted: current top first, then historical)
let _cachedAt = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // refresh every 6 hours

/**
 * Refresh the coin list from Binance and merge into the persistent registry.
 */
async function refresh() {
  const registry = loadRegistry();
  const now = Date.now();

  try {
    const url = 'https://data-api.binance.vision/api/v3/ticker/24hr';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const tickers = await res.json();

    const usdtPairs = tickers
      .filter(t => {
        const sym = t.symbol;
        if (!sym.endsWith('USDT')) return false;
        if (EXCLUDED.has(sym)) return false;
        const base = sym.replace(/USDT$/, '');
        if (EXCLUDED_PATTERNS.some(p => p.test(base))) return false;
        if (parseFloat(t.quoteVolume) < 1_000_000) return false;
        return true;
      })
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .map(t => t.symbol);

    // Current top 100
    _currentTop = usdtPairs.slice(0, 100);
    const currentSet = new Set(_currentTop);

    // Merge into registry — add new coins, update timestamps
    const nowISO = new Date().toISOString();
    for (const sym of _currentTop) {
      const existing = registry.coins.get(sym);
      if (existing) {
        existing.lastInTop100 = nowISO;
      } else {
        registry.coins.set(sym, { firstSeen: nowISO, lastInTop100: nowISO });
      }
    }

    // Build the full tracked list: current top 100 first (in volume order),
    // then any historical coins that dropped out (alphabetical)
    const historical = [...registry.coins.keys()]
      .filter(s => !currentSet.has(s))
      .sort();
    _allTracked = [..._currentTop, ...historical];

    registry.lastRefresh = now;
    saveRegistry(registry);
    _cachedAt = now;

    const newCount = _allTracked.length - _currentTop.length;
    console.log(`[coins] Top 100 refreshed. ${_allTracked.length} total tracked (${newCount} historical)`);

  } catch (err) {
    console.error(`[coins] Failed to fetch from Binance: ${err.message}`);

    // Use registry if we have one, otherwise fallback
    if (registry.coins.size > 0) {
      _allTracked = [...registry.coins.keys()];
      _currentTop = _allTracked.slice(0, 100);
      _cachedAt = now; // don't retry immediately
      console.log(`[coins] Using saved registry: ${_allTracked.length} coins`);
    } else {
      _currentTop = FALLBACK_COINS;
      _allTracked = FALLBACK_COINS;
      console.log(`[coins] Using hardcoded fallback: ${FALLBACK_COINS.length} coins`);
    }
  }
}

/**
 * Get the current top N coins by volume.
 * Use this for things like predictions where you only want the most active coins.
 */
async function getTopCoins(n = 100) {
  if (!_currentTop || Date.now() - _cachedAt > CACHE_TTL) {
    await refresh();
  }
  return _currentTop.slice(0, n);
}

/**
 * Get ALL coins ever tracked (sticky list — once in, never removed).
 * Use this for data collection to avoid gaps.
 */
async function getAllTrackedCoins() {
  if (!_allTracked || Date.now() - _cachedAt > CACHE_TTL) {
    await refresh();
  }
  return _allTracked;
}

module.exports = { getTopCoins, getAllTrackedCoins, FALLBACK_COINS, EXCLUDED };
