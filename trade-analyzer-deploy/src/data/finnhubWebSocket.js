/**
 * finnhubWebSocket.js
 * Real-time trade streaming from Finnhub WebSocket API for forex / commodity
 * instruments, with client-side candle aggregation.
 */

import { FINNHUB_SYMBOL_MAP } from './finnhubAPI.js';

const FINNHUB_WS_URL = 'wss://ws.finnhub.io?token=d7aejfpr01qn9i7kleugd7aejfpr01qn9i7klev0';
const MAX_RECONNECT_DELAY = 30_000; // 30 seconds

/**
 * Interval label → duration in seconds.
 * Used to bucket incoming trades into candle periods.
 */
const INTERVAL_SECONDS = {
  '1':   60,
  '5':   300,
  '15':  900,
  '60':  3600,
  '240': 14400,
  'D':   86400,
};

export class FinnhubStream {
  constructor() {
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {string|null} */
    this._symbol = null;       // local key, e.g. 'XAUUSD'
    /** @type {string|null} */
    this._finnhubSymbol = null; // mapped, e.g. 'OANDA:XAU_USD'
    /** @type {string|null} */
    this._interval = null;     // finnhub resolution string
    /** @type {number} */
    this._intervalSeconds = 0;
    /** @type {{ onCandleUpdate?: Function, onTick?: Function }|null} */
    this._callbacks = null;

    // Candle aggregation state
    this._currentCandle = null;
    this._currentPeriodStart = 0;

    // Reconnection state
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._intentionallyClosed = false;
  }

  /**
   * Subscribe to a Finnhub trade stream and aggregate into candles.
   *
   * @param {string} symbol   - Local symbol, e.g. 'XAUUSD'
   * @param {string} interval - Finnhub resolution: '1','5','15','60','240','D'
   * @param {{ onCandleUpdate?: (candle: object) => void, onTick?: (price: number) => void }} callbacks
   */
  subscribe(symbol, interval, callbacks) {
    this.unsubscribe();

    this._symbol = symbol;
    this._finnhubSymbol = FINNHUB_SYMBOL_MAP[symbol] ?? symbol;
    this._interval = interval;
    this._intervalSeconds = INTERVAL_SECONDS[interval] ?? 60;
    this._callbacks = callbacks;
    this._intentionallyClosed = false;
    this._reconnectAttempts = 0;

    // Reset aggregation state
    this._currentCandle = null;
    this._currentPeriodStart = 0;

    this._connect();
  }

  /** Unsubscribe and disconnect. */
  unsubscribe() {
    this._intentionallyClosed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    // Send unsubscribe message before closing, if connection is open
    if (this._ws && this._ws.readyState === WebSocket.OPEN && this._finnhubSymbol) {
      try {
        this._ws.send(JSON.stringify({
          type:   'unsubscribe',
          symbol: this._finnhubSymbol,
        }));
      } catch {
        // best-effort – ignore send failures during teardown
      }
    }

    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }

    this._symbol = null;
    this._finnhubSymbol = null;
    this._interval = null;
    this._callbacks = null;
    this._currentCandle = null;
    this._currentPeriodStart = 0;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal – connection                                             */
  /* ------------------------------------------------------------------ */

  _connect() {
    console.log(`[FinnhubStream] Connecting for ${this._finnhubSymbol} (${this._interval})`);

    this._ws = new WebSocket(FINNHUB_WS_URL);

    this._ws.onopen = () => {
      console.log(`[FinnhubStream] Connected – subscribing to ${this._finnhubSymbol}`);
      this._reconnectAttempts = 0;

      this._ws.send(JSON.stringify({
        type:   'subscribe',
        symbol: this._finnhubSymbol,
      }));
    };

    this._ws.onmessage = (event) => {
      try {
        this._handleMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('[FinnhubStream] Error handling message:', err);
      }
    };

    this._ws.onerror = (err) => {
      console.error('[FinnhubStream] WebSocket error:', err);
    };

    this._ws.onclose = (event) => {
      console.warn(`[FinnhubStream] Connection closed (code=${event.code})`);
      if (!this._intentionallyClosed) {
        this._reconnect();
      }
    };
  }

  /**
   * Handle incoming Finnhub WebSocket messages.
   *
   * Trade message shape:
   * {
   *   type: 'trade',
   *   data: [{ s: symbol, p: price, t: timestamp_ms, v: volume }, …]
   * }
   */
  _handleMessage(msg) {
    if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;

    for (const trade of msg.data) {
      // Filter to our subscribed symbol only
      if (trade.s !== this._finnhubSymbol) continue;

      this._aggregateToCandle({
        price:     trade.p,
        timestamp: trade.t / 1000, // ms → seconds
        volume:    trade.v ?? 0,
      });

      // Emit tick for every trade
      if (this._callbacks?.onTick) {
        this._callbacks.onTick(trade.p);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internal – candle aggregation                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Aggregate a single trade into a candle for the configured interval.
   *
   * @param {{ price: number, timestamp: number, volume: number }} trade
   */
  _aggregateToCandle(trade) {
    const periodStart = Math.floor(trade.timestamp / this._intervalSeconds) * this._intervalSeconds;

    if (this._currentCandle === null || periodStart !== this._currentPeriodStart) {
      // Emit the completed candle (if any) before starting a new one
      if (this._currentCandle !== null) {
        const completedCandle = { ...this._currentCandle, isClosed: true };
        if (this._callbacks?.onCandleUpdate) {
          this._callbacks.onCandleUpdate(completedCandle);
        }
      }

      // Start a fresh candle
      this._currentPeriodStart = periodStart;
      this._currentCandle = {
        time:     periodStart,
        open:     trade.price,
        high:     trade.price,
        low:      trade.price,
        close:    trade.price,
        volume:   trade.volume,
        isClosed: false,
      };
    } else {
      // Update the in-progress candle
      this._currentCandle.high   = Math.max(this._currentCandle.high, trade.price);
      this._currentCandle.low    = Math.min(this._currentCandle.low, trade.price);
      this._currentCandle.close  = trade.price;
      this._currentCandle.volume += trade.volume;
    }

    // Always emit the in-progress candle so the UI can render live updates
    if (this._callbacks?.onCandleUpdate) {
      this._callbacks.onCandleUpdate({ ...this._currentCandle });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internal – reconnection                                           */
  /* ------------------------------------------------------------------ */

  /** Reconnect with exponential backoff: 1 s → 2 s → 4 s → … → 30 s max. */
  _reconnect() {
    const delay = Math.min(
      1000 * 2 ** this._reconnectAttempts,
      MAX_RECONNECT_DELAY,
    );
    this._reconnectAttempts += 1;

    console.log(`[FinnhubStream] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(() => {
      if (!this._intentionallyClosed) {
        this._connect();
      }
    }, delay);
  }
}
