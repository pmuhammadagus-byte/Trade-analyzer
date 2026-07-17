/**
 * binanceAPI.js
 * Fetches historical OHLCV kline data from Binance REST API via Vite dev proxy.
 */

const BINANCE_BASE = '/api/binance/api/v3';

/**
 * Fetch historical kline (candlestick) data from Binance.
 *
 * @param {string} symbol   - Trading pair, e.g. 'BTCUSDT'
 * @param {string} interval - Kline interval: '1m','5m','15m','1h','4h','1d', etc.
 * @param {number} [limit=500] - Number of candles to retrieve (max 1000).
 * @returns {Promise<Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
export async function fetchKlines(symbol, interval, limit = 500) {
  const url = `${BINANCE_BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error(`[binanceAPI] Network error fetching klines for ${symbol}:`, err);
    throw new Error(`Network error fetching Binance klines: ${err.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`[binanceAPI] HTTP ${response.status} for ${symbol} ${interval}:`, body);
    throw new Error(`Binance API error ${response.status}: ${body}`);
  }

  const raw = await response.json();

  if (!Array.isArray(raw)) {
    console.error('[binanceAPI] Unexpected response shape:', raw);
    throw new Error('Binance API returned unexpected data format');
  }

  /*
   * Binance kline array element layout:
   *  [0]  openTime        (ms)
   *  [1]  open            (string)
   *  [2]  high            (string)
   *  [3]  low             (string)
   *  [4]  close           (string)
   *  [5]  volume          (string)
   *  [6]  closeTime       (ms)
   *  [7+] …other fields
   */
  return raw.map((k) => ({
    time:   Math.floor(k[0] / 1000), // convert ms → seconds
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/**
 * Fetch current ticker price for a cryptocurrency.
 *
 * @param {string} symbol - Trading pair, e.g. 'BTCUSDT'
 * @returns {Promise<number>} - Live price
 */
export async function fetchTickerPrice(symbol) {
  const url = `${BINANCE_BASE}/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching Binance ticker price`);
  }
  const data = await response.json();
  return parseFloat(data.price);
}

