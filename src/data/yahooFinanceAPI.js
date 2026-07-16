/**
 * yahooFinanceAPI.js
 * Fetches historical OHLCV data and live price updates from Yahoo Finance
 * via the Vite dev proxy.
 */

const YAHOO_BASE = '/api/yahoo/v8/finance/chart';

export const YAHOO_SYMBOL_MAP = {
  BTCUSDT: 'BTC-USD', // Bitcoin Spot
  XAUUSD: 'GC=F',     // Gold Futures
  GBPUSD: 'GBPUSD=X', // Spot GBP/USD
  USDCAD: 'USDCAD=X', // Spot USD/CAD
};

let xauusdOffset = null;
let xauusdOffsetTime = 0;
const XAU_OFFSET_TTL_MS = 5 * 60 * 1000; // refresh the futures->spot offset every 5 min

/**
 * Calculates or returns the cached offset between Swissquote Spot Gold and Yahoo Finance Futures (GC=F).
 *
 * @param {number} latestYahooClose
 * @returns {Promise<number>}
 */
async function getXauusdOffset(latestYahooClose) {
  // Cache the offset but refresh periodically — futures vs spot basis drifts
  // intraday, so a once-only offset goes stale over a session.
  if (xauusdOffset !== null && (Date.now() - xauusdOffsetTime) < XAU_OFFSET_TTL_MS) {
    return xauusdOffset;
  }
  try {
    const res = await fetch('/api/swissquote');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    const instrument = data[0];
    if (instrument && instrument.spreadProfilePrices && instrument.spreadProfilePrices.length > 0) {
      const priceObj = instrument.spreadProfilePrices[0];
      const bid = parseFloat(priceObj.bid);
      const ask = parseFloat(priceObj.ask);
      const spotPrice = (bid + ask) / 2;
      
      xauusdOffset = spotPrice - latestYahooClose;
      xauusdOffsetTime = Date.now();
      console.log(`[yahooFinanceAPI] Calculated XAUUSD spot offset: ${xauusdOffset.toFixed(4)} (Spot: ${spotPrice.toFixed(2)}, Futures: ${latestYahooClose.toFixed(2)})`);
      return xauusdOffset;
    }
  } catch (err) {
    console.error('[yahooFinanceAPI] Failed to fetch Swissquote spot price for offset:', err);
  }
  // Keep the last known offset on failure rather than snapping back to 0.
  return xauusdOffset ?? 0;
}

const TIMEFRAME_CONFIG = {
  '1m':  { interval: '1m',  range: '5d',   aggFactor: 1 },
  '5m':  { interval: '5m',  range: '10d',  aggFactor: 1 },
  '15m': { interval: '15m', range: '15d',  aggFactor: 1 },
  '1H':  { interval: '60m', range: '60d',  aggFactor: 1 },
  '4H':  { interval: '60m', range: '120d', aggFactor: 4 }, // aggregate hourly by 4
  '1D':  { interval: '1d',  range: '2y',   aggFactor: 1 },
};

/**
 * Fetch historical candles from Yahoo Finance.
 *
 * @param {string} symbol - Local symbol key (XAUUSD, EURUSD, etc.)
 * @param {string} timeframe - Local timeframe key (1m, 5m, 15m, 1H, 4H, 1D)
 * @returns {Promise<Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
/**
 * Neighbour-relative outlier-wick filter for thin Yahoo Forex feeds.
 * Yahoo's `=X` FX data occasionally emits rollover / bad-tick spikes (100-200+ pip
 * wicks) that don't exist on a real broker feed. A fixed clamp also clips genuine
 * news candles, so instead a wick is only treated as a glitch when it is BOTH large
 * in absolute terms AND a big multiple of the LOCAL median bar range; it is then
 * pulled back proportionally to local volatility. Genuine news bars (whose
 * neighbours are also volatile) raise the local median and are left untouched.
 *
 * @param {Array<{open:number,high:number,low:number,close:number}>} candles
 * @param {string} symbol
 * @returns {Array} filtered candles (forex only; other symbols returned unchanged)
 */
export function filterForexOutlierWicks(candles, symbol) {
  if (!['GBPUSD', 'USDCAD'].includes(symbol) || !candles || candles.length === 0) {
    return candles;
  }

  const WINDOW = 10;         // bars of context on each side
  const MIN_WICK = 0.0025;   // only consider wicks above ~25 pips; the neighbour
                             // ratio below decides the rest, so real news wicks
                             // (volatile neighbours) are spared while isolated
                             // calm-market spikes — i.e. Yahoo rollover glitches — get caught
  const OUTLIER_MULT = 4;    // relative trip: wick exceeds 4x the local median range
  const ABS_MAX = 0.0150;    // absolute backstop: any wick > ~150 pips on 15m FX is a
                             // Yahoo glitch even if neighbours are also bad (rollover clusters)

  const median = (arr) => {
    if (arr.length === 0) return 0;
    const srt = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(srt.length / 2);
    return srt.length % 2 ? srt[mid] : (srt[mid - 1] + srt[mid]) / 2;
  };

  return candles.map((c, i) => {
    const maxVal = Math.max(c.open, c.close);
    const minVal = Math.min(c.open, c.close);
    const upperWick = c.high - maxVal;
    const lowerWick = minVal - c.low;

    // Cheap skip: neither wick is even large enough to be suspect.
    if (upperWick <= MIN_WICK && lowerWick <= MIN_WICK) return c;

    // Local median of the full bar range from surrounding candles (self excluded).
    const ranges = [];
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(candles.length - 1, i + WINDOW); j++) {
      if (j === i) continue;
      ranges.push(candles[j].high - candles[j].low);
    }
    // medRange = 0 when there isn't enough local context; the absolute backstop
    // below still applies in that case.
    const medRange = ranges.length >= 5 ? median(ranges) : 0;

    // Remaining wick after clamping: proportional to local volatility but bounded
    // to a realistic 15-40 pips, so even a glitch cluster can't leave a huge wick.
    const clampAmt = Math.min(Math.max(medRange > 0 ? 2 * medRange : 0.0010, 0.0008), 0.0040);

    let cleanHigh = c.high;
    let cleanLow = c.low;
    const relUpper = medRange > 0 && upperWick > OUTLIER_MULT * medRange;
    const relLower = medRange > 0 && lowerWick > OUTLIER_MULT * medRange;
    if (upperWick > MIN_WICK && (upperWick > ABS_MAX || relUpper)) {
      cleanHigh = maxVal + clampAmt;
    }
    if (lowerWick > MIN_WICK && (lowerWick > ABS_MAX || relLower)) {
      cleanLow = minVal - clampAmt;
    }

    if (cleanHigh === c.high && cleanLow === c.low) return c;
    return { ...c, high: cleanHigh, low: cleanLow };
  });
}

export async function fetchCandles(symbol, timeframe, rangeOverride = null) {
  const yahooSymbol = YAHOO_SYMBOL_MAP[symbol] ?? symbol;
  const config = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG['15m'];

  const params = new URLSearchParams({
    interval: config.interval,
    // Callers (e.g. the backtester) may request a longer window than the app's
    // default; Yahoo allows up to 60d for 15m. Falls back to the config default.
    range: rangeOverride || config.range,
  });

  const url = `${YAHOO_BASE}/${yahooSymbol}?${params}`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error(`[yahooFinanceAPI] Network error for ${symbol}:`, err);
    throw new Error(`Yahoo Finance network error: ${err.message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[yahooFinanceAPI] HTTP ${response.status} for ${symbol}:`, text);
    throw new Error(`Yahoo Finance error ${response.status}`);
  }

  const data = await response.json();
  const result = data.chart?.result?.[0];

  if (!result || !result.timestamp || result.timestamp.length === 0) {
    console.warn(`[yahooFinanceAPI] No candles returned for ${symbol} (${timeframe})`);
    return [];
  }

  const timestamps = result.timestamp;
  const quotes = result.indicators.quote[0];

  const durationMap = {
    '1m':  60,
    '5m':  300,
    '15m': 900,
    '1H':  3600,
    '4H':  14400,
    '1D':  86400,
  };
  const duration = durationMap[timeframe] || 900;

  // Parse raw parallel arrays into aligned, deduplicated candle objects
  let parsed = [];
  const unique = new Map();

  for (let i = 0; i < timestamps.length; i++) {
    // Yahoo Finance can sometimes return nulls for illiquid candles
    if (
      quotes.open[i] === null ||
      quotes.high[i] === null ||
      quotes.low[i] === null ||
      quotes.close[i] === null
    ) {
      continue;
    }

    const alignedTime = Math.floor(timestamps[i] / duration) * duration;

    if (unique.has(alignedTime)) {
      const existing = unique.get(alignedTime);
      existing.high = Math.max(existing.high, parseFloat(quotes.high[i]));
      existing.low = Math.min(existing.low, parseFloat(quotes.low[i]));
      existing.close = parseFloat(quotes.close[i]);
      existing.volume += parseFloat(quotes.volume[i] ?? 0);
    } else {
      unique.set(alignedTime, {
        time:   alignedTime,
        open:   parseFloat(quotes.open[i]),
        high:   parseFloat(quotes.high[i]),
        low:    parseFloat(quotes.low[i]),
        close:  parseFloat(quotes.close[i]),
        volume: parseFloat(quotes.volume[i] ?? 0),
      });
    }
  }

  parsed = Array.from(unique.values());

  if (symbol === 'XAUUSD' && parsed.length > 0) {
    const latestYahooClose = parsed[parsed.length - 1].close;
    const offset = await getXauusdOffset(latestYahooClose);
    if (offset !== 0) {
      parsed = parsed.map(c => ({
        ...c,
        open:  c.open + offset,
        high:  c.high + offset,
        low:   c.low + offset,
        close: c.close + offset,
      }));
    }
  }

  // Remove Yahoo's fake forex rollover / bad-tick wick spikes (neighbour-relative,
  // preserves genuine news candles — see filterForexOutlierWicks).
  parsed = filterForexOutlierWicks(parsed, symbol);

  // Handle client-side candle aggregation if required (e.g. 4H timeframe)
  if (config.aggFactor > 1) {
    parsed = aggregateCandles(parsed, config.aggFactor);
  }

  return parsed;
}

/**
 * Aggregate smaller interval candles into larger ones.
 *
 * @param {Array<object>} candles
 * @param {number} factor
 * @returns {Array<object>}
 */
function aggregateCandles(candles, factor) {
  const result = [];

  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    if (chunk.length === 0) continue;

    const highs = chunk.map(c => c.high);
    const lows  = chunk.map(c => c.low);

    result.push({
      time:   chunk[0].time, // start of period
      open:   chunk[0].open,
      high:   Math.max(...highs),
      low:    Math.min(...lows),
      close:  chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return result;
}

/**
 * Fetch the latest price quote for a symbol.
 *
 * @param {string} symbol
 * @returns {Promise<{current:number, open:number, high:number, low:number}>}
 */
export async function fetchQuote(symbol) {
  const yahooSymbol = YAHOO_SYMBOL_MAP[symbol] ?? symbol;
  const url = `${YAHOO_BASE}/${yahooSymbol}?interval=1m&range=1d`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching quote`);

  const data = await response.json();
  const result = data.chart?.result?.[0];
  if (!result || !result.timestamp || result.timestamp.length === 0) {
    throw new Error('No quote data returned');
  }

  const quotes = result.indicators.quote[0];
  const lastIdx = result.timestamp.length - 1;

  // Search backwards to find the last non-null close
  let current = null;
  let open = null;
  let high = null;
  let low = null;

  for (let i = lastIdx; i >= 0; i--) {
    if (quotes.close[i] !== null) {
      current = quotes.close[i];
      open = quotes.open[i];
      high = quotes.high[i];
      low = quotes.low[i];
      break;
    }
  }

  if (current === null) {
    throw new Error('Quote chart contained only null values');
  }

  let offset = 0;
  if (symbol === 'XAUUSD') {
    const rawClose = parseFloat(current);
    offset = await getXauusdOffset(rawClose);
  }

  return {
    current: parseFloat(current) + offset,
    open:    (parseFloat(open ?? current)) + offset,
    high:    (parseFloat(high ?? current)) + offset,
    low:     (parseFloat(low ?? current)) + offset,
  };
}
