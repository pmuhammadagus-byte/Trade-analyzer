/**
 * twelveDataAPI.js  (SERVER-SIDE ONLY)
 *
 * Fetches OHLC candles from Twelve Data (OANDA-sourced forex / metals) so the chart
 * and scanners match broker / TradingView data instead of Yahoo's coarse FX feed.
 *
 * API keys are passed in by the caller (read from server environment variables) and
 * are NEVER sent to the browser. The browser only ever reads the already-fetched
 * candles from the server's /api/market-data cache.
 */

// App symbol -> Twelve Data symbol (forex/metals use slash notation).
const TD_SYMBOL = {
  XAUUSD: 'XAU/USD',
  GBPUSD: 'GBP/USD',
  USDCAD: 'USD/CAD',
  BTCUSDT: 'BTC/USD',
};

// App timeframe -> Twelve Data interval.
const TD_INTERVAL = {
  '1m': '1min', '5m': '5min', '15m': '15min', '1H': '1h', '4H': '4h', '1D': '1day',
};

/**
 * Fetch candles from Twelve Data.
 *
 * @param {string} symbol     App symbol, e.g. 'USDCAD'.
 * @param {string} timeframe  App timeframe, e.g. '15m'.
 * @param {number} outputsize Number of candles to request.
 * @param {string} apiKey     Twelve Data API key for this symbol.
 * @returns {Promise<Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>>}
 */
export async function fetchTwelveCandles(symbol, timeframe = '15m', outputsize = 500, apiKey) {
  if (!apiKey) throw new Error(`No Twelve Data API key provided for ${symbol}`);

  const tdSymbol = TD_SYMBOL[symbol] || symbol;
  const interval = TD_INTERVAL[timeframe] || '15min';
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}`
    + `&interval=${interval}&outputsize=${outputsize}&timezone=UTC&format=JSON&apikey=${apiKey}`;

  const res = await fetch(url);
  const data = await res.json();

  // Twelve Data signals problems via { status: 'error', message, code }.
  if (!data || data.status === 'error' || !Array.isArray(data.values)) {
    const msg = data && data.message ? data.message : 'no values returned';
    throw new Error(`Twelve Data error for ${symbol}: ${msg}`);
  }

  // Values are newest-first; convert datetime (UTC) -> unix seconds and reverse.
  const candles = data.values.map(v => {
    const dt = v.datetime.includes(' ')
      ? v.datetime.replace(' ', 'T') + 'Z'
      : v.datetime + 'T00:00:00Z';
    return {
      time: Math.floor(new Date(dt).getTime() / 1000),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume || 0),
    };
  }).filter(c => Number.isFinite(c.time) && Number.isFinite(c.close)).reverse();

  return candles;
}

export default { fetchTwelveCandles };
