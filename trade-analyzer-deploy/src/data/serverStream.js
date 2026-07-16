/**
 * serverStream.js
 * Drop-in replacement for YahooStream that reads candles + live price from the
 * backend's own cached market data (/api/market-data) instead of polling Yahoo
 * directly. This makes the server the single upstream data client, so additional
 * browser viewers cost only a cheap cache read rather than another Yahoo request.
 */

const TIMEFRAME_SECONDS = {
  '1m':  60,
  '5m':  300,
  '15m': 900,
  '1H':  3600,
  '4H':  14400,
  '1D':  86400,
};

export class ServerStream {
  constructor() {
    this._timer = null;
    this._stopped = false;
    this._symbol = null;
    this._timeframe = null;
    this._callbacks = null;
    this._lastClosedTime = null;
  }

  /**
   * @param {string} symbol
   * @param {string} timeframe
   * @param {{ onCandleUpdate?: (candle: object) => void, onTick?: (price: number) => void }} callbacks
   * @param {{ pollMs?: number, maxPollMs?: number }} [options]
   */
  subscribe(symbol, timeframe, callbacks, options = {}) {
    this.unsubscribe();
    this._symbol = symbol;
    this._timeframe = timeframe;
    this._callbacks = callbacks;
    this._stopped = false;
    this._lastClosedTime = null;
    this._baseMs = options.pollMs || 5000;
    this._maxMs = options.maxPollMs || 30000;
    this._currentMs = this._baseMs;
    this._timer = setTimeout(() => this._loop(), 0);
  }

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
    if (this._stopped || !this._symbol) return;

    let ok = false;
    try {
      const res = await fetch(`/api/market-data?symbol=${encodeURIComponent(this._symbol)}`);
      if (res.ok) {
        const data = await res.json();
        const candles = data.candles || [];
        if (candles.length > 0) {
          ok = true;
          const latest = candles[candles.length - 1];
          const price = (data.price != null) ? data.price : latest.close;

          if (this._callbacks?.onTick) {
            this._callbacks.onTick(price);
          }

          if (this._callbacks?.onCandleUpdate) {
            const duration = TIMEFRAME_SECONDS[this._timeframe] || 900;
            const nowUnix = Math.floor(Date.now() / 1000);
            // Emit closed=true only once per candle, not on every poll while the
            // server is still serving the same bar as latest.
            let isClosed = false;
            if ((nowUnix - latest.time) >= duration && this._lastClosedTime !== latest.time) {
              isClosed = true;
              this._lastClosedTime = latest.time;
            }
            this._callbacks.onCandleUpdate({ ...latest, isClosed });
          }
        }
      }
    } catch (err) {
      console.error(`[ServerStream] poll error for ${this._symbol}:`, err.message);
    }

    // Reset cadence on success, back off on failure up to the cap.
    this._currentMs = ok ? this._baseMs : Math.min(this._maxMs, Math.round(this._currentMs * 1.8));
    if (!this._stopped) {
      this._timer = setTimeout(() => this._loop(), this._currentMs);
    }
  }
}

export default ServerStream;
