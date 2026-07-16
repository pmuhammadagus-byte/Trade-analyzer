/**
 * finnhubAPI.js
 * Fetches historical OHLCV candles and live quotes from Finnhub REST API
 * via Vite dev proxy.
 */

const FINNHUB_BASE = '/api/finnhub/api/v1';
const FINNHUB_API_KEY = 'd7aejfpr01qn9i7kleugd7aejfpr01qn9i7klev0';

/**
 * Maps local symbol names to Finnhub's expected symbol format.
 */
export const FINNHUB_SYMBOL_MAP = {
  XAUUSD: 'OANDA:XAU_USD',
  GBPUSD: 'OANDA:GBP_USD',
  EURUSD: 'OANDA:EUR_USD',
  USDCAD: 'OANDA:USD_CAD',
};

/**
 * Fetch historical OHLCV candles from Finnhub.
 *
 * @param {string} symbol     - Local symbol key, e.g. 'XAUUSD'
 * @param {string} resolution - Candle resolution: '1','5','15','60','240','D'
 * @param {number} from       - Start unix timestamp (seconds)
 * @param {number} to         - End unix timestamp (seconds)
 * @returns {Promise<Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
export async function fetchCandles(symbol, resolution, from, to) {
  const finnhubSymbol = FINNHUB_SYMBOL_MAP[symbol] ?? symbol;

  const params = new URLSearchParams({
    symbol: finnhubSymbol,
    resolution,
    from: String(Math.floor(from)),
    to:   String(Math.floor(to)),
    token: FINNHUB_API_KEY,
  });

  const url = `${FINNHUB_BASE}/forex/candle?${params}`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error(`[finnhubAPI] Network error fetching candles for ${symbol}:`, err);
    throw new Error(`Network error fetching Finnhub candles: ${err.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[finnhubAPI] HTTP ${response.status} for ${symbol}:`, body);
    throw new Error(`Finnhub API error ${response.status}: ${body}`);
  }

  const data = await response.json();

  if (data.s === 'no_data' || !data.t || data.t.length === 0) {
    console.warn(`[finnhubAPI] No data returned for ${symbol} (${resolution})`);
    return [];
  }

  // Zip the parallel arrays into an array of candle objects
  return data.t.map((timestamp, i) => ({
    time:   timestamp,
    open:   data.o[i],
    high:   data.h[i],
    low:    data.l[i],
    close:  data.c[i],
    volume: data.v[i],
  }));
}

/**
 * Fetch a real-time quote for the given symbol.
 *
 * @param {string} symbol - Local symbol key, e.g. 'XAUUSD'
 * @returns {Promise<{current:number, high:number, low:number, open:number, prevClose:number}>}
 */
export async function fetchQuote(symbol) {
  const finnhubSymbol = FINNHUB_SYMBOL_MAP[symbol] ?? symbol;

  const params = new URLSearchParams({
    symbol: finnhubSymbol,
    token:  FINNHUB_API_KEY,
  });

  const url = `${FINNHUB_BASE}/quote?${params}`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error(`[finnhubAPI] Network error fetching quote for ${symbol}:`, err);
    throw new Error(`Network error fetching Finnhub quote: ${err.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[finnhubAPI] HTTP ${response.status} for quote ${symbol}:`, body);
    throw new Error(`Finnhub quote API error ${response.status}: ${body}`);
  }

  const q = await response.json();

  return {
    current:   q.c,
    high:      q.h,
    low:       q.l,
    open:      q.o,
    prevClose: q.pc,
  };
}
