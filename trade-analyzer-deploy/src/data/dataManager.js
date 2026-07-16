/**
 * dataManager.js
 * Unified data interface that routes historical and real-time data requests
 * to the correct provider (Binance or Yahoo Finance) based on the symbol.
 */

import { fetchKlines, fetchTickerPrice }  from './binanceAPI.js';
import { BinanceStream }              from './binanceWebSocket.js';
import { fetchCandles as fetchYahooCandles, fetchQuote as fetchYahooQuote } from './yahooFinanceAPI.js';
import { YahooStream }                from './yahooWebSocket.js';
import { ServerStream }               from './serverStream.js';

/* -------------------------------------------------------------------- */
/*  Configuration maps                                                  */
/* -------------------------------------------------------------------- */

/**
 * Per-symbol configuration.
 * `provider`    – which API back-end to use
 * `wsSymbol`    – symbol string expected by the WebSocket layer
 * `displayName` – human-readable label for the UI
 * `type`        – asset class
 */
export const SYMBOL_CONFIG = {
  BTCUSDT: { provider: 'yahoo',   wsSymbol: 'BTC-USD',        displayName: 'BTC/USDT', type: 'crypto'    },
  XAUUSD:  { provider: 'yahoo',   wsSymbol: 'GC=F',           displayName: 'XAU/USD',  type: 'commodity' },
  GBPUSD:  { provider: 'yahoo',   wsSymbol: 'GBPUSD=X',       displayName: 'GBP/USD',  type: 'forex'     },
  USDCAD:  { provider: 'yahoo',   wsSymbol: 'USDCAD=X',       displayName: 'USD/CAD',  type: 'forex'     },
};

/**
 * Maps the app's timeframe labels to each provider's native format
 * and stores the duration in seconds.
 */
export const TIMEFRAME_MAP = {
  '1m':  { binance: '1m',  finnhub: '1',   seconds: 60     },
  '5m':  { binance: '5m',  finnhub: '5',   seconds: 300    },
  '15m': { binance: '15m', finnhub: '15',  seconds: 900    },
  '1H':  { binance: '1h',  finnhub: '60',  seconds: 3600   },
  '4H':  { binance: '4h',  finnhub: '240', seconds: 14400  },
  '1D':  { binance: '1d',  finnhub: 'D',   seconds: 86400  },
};

/* -------------------------------------------------------------------- */
/*  DataManager class                                                   */
/* -------------------------------------------------------------------- */

const HISTORY_CANDLES = 500; // number of candles to load

export default class DataManager {
  constructor() {
    /** @type {BinanceStream} */
    this._binanceStream = new BinanceStream();
    /** @type {YahooStream} */
    this._yahooStream = new YahooStream();
    /** @type {ServerStream} */
    this._serverStream = new ServerStream();
  }

  /* ------------------------------------------------------------------ */
  /*  Historical data                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Load historical OHLCV candles for the given symbol and timeframe.
   *
   * @param {string} symbol    - e.g. 'BTCUSDT', 'XAUUSD'
   * @param {string} timeframe - e.g. '1m', '1H', '1D'
   * @returns {Promise<Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>>}
   */
  async loadHistory(symbol, timeframe) {
    const config = this._requireSymbol(symbol);
    const tf     = this._requireTimeframe(timeframe);

    if (config.provider === 'binance') {
      return this._loadBinanceHistory(symbol, tf);
    }

    return this._loadYahooHistory(symbol, timeframe);
  }

  /** @private */
  async _loadBinanceHistory(symbol, tf) {
    console.log(`[DataManager] Loading Binance history: ${symbol} ${tf.binance}`);
    return fetchKlines(symbol, tf.binance, HISTORY_CANDLES);
  }

  /** @private */
  async _loadYahooHistory(symbol, timeframe) {
    // For the server's native 15m timeframe, prefer the server's cached candles so
    // the browser doesn't hit Yahoo directly. Fall back to Yahoo if the cache is cold.
    if (timeframe === '15m') {
      try {
        const res = await fetch(`/api/market-data?symbol=${encodeURIComponent(symbol)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.candles && data.candles.length > 50) {
            console.log(`[DataManager] Loaded ${data.candles.length} candles from server cache: ${symbol}`);
            return data.candles;
          }
        }
      } catch (err) {
        console.warn(`[DataManager] Server cache unavailable for ${symbol}, falling back to Yahoo:`, err.message);
      }
    }
    console.log(`[DataManager] Loading Yahoo history: ${symbol} ${timeframe}`);
    return fetchYahooCandles(symbol, timeframe);
  }

  /**
   * Fetch current market price for a symbol (lightweight REST query).
   *
   * @param {string} symbol
   * @returns {Promise<number>}
   */
  async fetchCurrentPrice(symbol) {
    const config = this._requireSymbol(symbol);

    if (config.provider === 'binance') {
      return fetchTickerPrice(symbol);
    } else {
      const quote = await fetchYahooQuote(symbol);
      return quote.current;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Real-time streaming                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Subscribe to real-time updates for the given symbol and timeframe.
   *
   * @param {string} symbol    - e.g. 'BTCUSDT', 'XAUUSD'
   * @param {string} timeframe - e.g. '1m', '1H'
   * @param {{ onCandleUpdate?: (candle: object) => void, onTick?: (price: number) => void }} callbacks
   */
  subscribeRealtime(symbol, timeframe, callbacks) {
    const config = this._requireSymbol(symbol);
    const tf     = this._requireTimeframe(timeframe);

    if (config.provider === 'binance') {
      console.log(`[DataManager] Subscribing Binance stream: ${config.wsSymbol} ${tf.binance}`);
      this._binanceStream.subscribe(config.wsSymbol, tf.binance, callbacks);
    } else if (timeframe === '15m') {
      // Default timeframe served from the server's shared cache so each browser
      // doesn't poll Yahoo directly (server is the single upstream poller).
      console.log(`[DataManager] Subscribing server-cache stream: ${symbol} ${timeframe}`);
      this._serverStream.subscribe(symbol, timeframe, callbacks);
    } else {
      console.log(`[DataManager] Subscribing Yahoo stream: ${symbol} ${timeframe}`);
      this._yahooStream.subscribe(symbol, timeframe, callbacks);
    }
  }

  /** Disconnect all active WebSocket streams. */
  unsubscribeAll() {
    console.log('[DataManager] Unsubscribing all streams');
    this._binanceStream.unsubscribe();
    this._yahooStream.unsubscribe();
    this._serverStream.unsubscribe();
  }

  /* ------------------------------------------------------------------ */
  /*  Accessors                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Get the configuration object for a symbol.
   * @param {string} symbol
   * @returns {{ provider: string, wsSymbol: string, displayName: string, type: string }}
   */
  getSymbolConfig(symbol) {
    return SYMBOL_CONFIG[symbol] ?? null;
  }

  /**
   * List all supported symbol keys.
   * @returns {string[]}
   */
  getSymbols() {
    return Object.keys(SYMBOL_CONFIG);
  }

  /**
   * List all supported timeframe keys.
   * @returns {string[]}
   */
  getTimeframes() {
    return Object.keys(TIMEFRAME_MAP);
  }

  /* ------------------------------------------------------------------ */
  /*  Validation helpers                                                */
  /* ------------------------------------------------------------------ */

  /** @private */
  _requireSymbol(symbol) {
    const config = SYMBOL_CONFIG[symbol];
    if (!config) {
      throw new Error(`[DataManager] Unknown symbol: "${symbol}". Available: ${this.getSymbols().join(', ')}`);
    }
    return config;
  }

  /** @private */
  _requireTimeframe(timeframe) {
    const tf = TIMEFRAME_MAP[timeframe];
    if (!tf) {
      throw new Error(`[DataManager] Unknown timeframe: "${timeframe}". Available: ${this.getTimeframes().join(', ')}`);
    }
    return tf;
  }
}
