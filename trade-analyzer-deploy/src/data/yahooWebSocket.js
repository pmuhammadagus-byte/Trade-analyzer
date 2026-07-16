/**
 * yahooWebSocket.js
 * Simulated WebSocket stream class using an HTTP polling mechanism
 * against Yahoo Finance. This serves as a key-free, drop-in replacement
 * for Finnhub's WebSocket stream.
 */

import { fetchCandles } from './yahooFinanceAPI.js';

const TIMEFRAME_SECONDS = {
  '1m':  60,
  '5m':  300,
  '15m': 900,
  '1H':  3600,
  '4H':  14400,
  '1D':  86400,
};

export class YahooStream {
  constructor() {
    /** @type {any} */
    this._intervalTimer = null;
    /** @type {string|null} */
    this._symbol = null;
    /** @type {string|null} */
    this._timeframe = null;
    /** @type {{ onCandleUpdate?: Function, onTick?: Function }|null} */
    this._callbacks = null;
    this._isPolling = false;
  }

  /**
   * Subscribe to real-time updates for a symbol.
   *
   * @param {string} symbol - Local symbol (XAUUSD, EURUSD, etc.)
   * @param {string} timeframe - Local timeframe (1m, 5m, 15m, 1H, 4H, 1D)
   * @param {{ onCandleUpdate?: (candle: object) => void, onTick?: (price: number) => void }} callbacks
   */
  subscribe(symbol, timeframe, callbacks, options = {}) {
    this.unsubscribe();

    this._symbol = symbol;
    this._timeframe = timeframe;
    this._callbacks = callbacks;
    this._stopped = false;

    // Self-scheduling poll with exponential backoff: transient Yahoo errors / 429s
    // slow the loop down instead of hammering. Optional stagger spreads multiple
    // symbols so they don't all hit Yahoo on the same tick.
    this._baseMs = options.pollMs || 6000;
    this._maxMs = options.maxPollMs || 60000;
    this._currentMs = this._baseMs;
    this._timer = setTimeout(() => this._loop(), options.staggerMs || 0);
  }

  /** Disconnect the stream. */
  unsubscribe() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._symbol = null;
    this._timeframe = null;
    this._callbacks = null;
  }

  /** @private */
  async _loop() {
    if (this._stopped || !this._symbol || !this._timeframe) return;

    let ok = false;
    try {
      const candles = await fetchCandles(this._symbol, this._timeframe);

      if (candles && candles.length > 0) {
        ok = true;
        const latestCandle = candles[candles.length - 1];

        if (this._callbacks?.onTick) {
          this._callbacks.onTick(latestCandle.close);
        }

        const duration = TIMEFRAME_SECONDS[this._timeframe] || 900;
        const nowUnix = Math.floor(Date.now() / 1000);
        const isClosed = (nowUnix - latestCandle.time) >= duration;

        if (this._callbacks?.onCandleUpdate) {
          this._callbacks.onCandleUpdate({ ...latestCandle, isClosed });
        }
      }
    } catch (err) {
      console.error(`[YahooStream] Polling error for ${this._symbol}:`, err.message);
    }

    // Reset cadence on success, back off on failure up to the cap.
    this._currentMs = ok ? this._baseMs : Math.min(this._maxMs, Math.round(this._currentMs * 1.8));
    if (!this._stopped) {
      this._timer = setTimeout(() => this._loop(), this._currentMs);
    }
  }
}

export default YahooStream;
