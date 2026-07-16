/**
 * binanceWebSocket.js
 * Real-time kline streaming from Binance WebSocket API.
 * No API key required.
 */

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';
const MAX_RECONNECT_DELAY = 30_000; // 30 seconds

export class BinanceStream {
  constructor() {
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {string|null} */
    this._symbol = null;
    /** @type {string|null} */
    this._interval = null;
    /** @type {{ onCandleUpdate?: Function, onTick?: Function }|null} */
    this._callbacks = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._intentionallyClosed = false;
  }

  /**
   * Subscribe to a kline stream.
   *
   * @param {string} symbol   - Lowercase symbol, e.g. 'btcusdt'
   * @param {string} interval - Kline interval, e.g. '1m', '5m', '1h'
   * @param {{ onCandleUpdate?: (candle: object) => void, onTick?: (price: number) => void }} callbacks
   */
  subscribe(symbol, interval, callbacks) {
    // Clean up any existing connection first
    this.unsubscribe();

    this._symbol = symbol.toLowerCase();
    this._interval = interval;
    this._callbacks = callbacks;
    this._intentionallyClosed = false;
    this._reconnectAttempts = 0;

    this._connect();
  }

  /** Disconnect from the current stream. */
  unsubscribe() {
    this._intentionallyClosed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }

    this._symbol = null;
    this._interval = null;
    this._callbacks = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                          */
  /* ------------------------------------------------------------------ */

  _connect() {
    const streamName = `${this._symbol}@kline_${this._interval}`;
    const url = `${BINANCE_WS_BASE}/${streamName}`;

    console.log(`[BinanceStream] Connecting to ${url}`);

    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      console.log(`[BinanceStream] Connected – ${streamName}`);
      this._reconnectAttempts = 0;
    };

    this._ws.onmessage = (event) => {
      try {
        this._handleMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('[BinanceStream] Error handling message:', err);
      }
    };

    this._ws.onerror = (err) => {
      console.error('[BinanceStream] WebSocket error:', err);
    };

    this._ws.onclose = (event) => {
      console.warn(`[BinanceStream] Connection closed (code=${event.code})`);
      if (!this._intentionallyClosed) {
        this._reconnect();
      }
    };
  }

  /**
   * Parse a Binance kline WebSocket event.
   *
   * Binance event shape:
   * {
   *   e: 'kline',
   *   k: { t, o, h, l, c, v, x, ... }
   * }
   */
  _handleMessage(msg) {
    if (msg.e !== 'kline' || !msg.k) return;

    const k = msg.k;

    const candle = {
      time:     Math.floor(k.t / 1000), // ms → seconds
      open:     parseFloat(k.o),
      high:     parseFloat(k.h),
      low:      parseFloat(k.l),
      close:    parseFloat(k.c),
      volume:   parseFloat(k.v),
      isClosed: k.x,
    };

    // Always emit the latest close as a tick
    if (this._callbacks?.onTick) {
      this._callbacks.onTick(candle.close);
    }

    if (this._callbacks?.onCandleUpdate) {
      this._callbacks.onCandleUpdate(candle);
    }
  }

  /** Reconnect with exponential backoff: 1 s → 2 s → 4 s → … → 30 s max. */
  _reconnect() {
    const delay = Math.min(
      1000 * 2 ** this._reconnectAttempts,
      MAX_RECONNECT_DELAY,
    );
    this._reconnectAttempts += 1;

    console.log(`[BinanceStream] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(() => {
      if (!this._intentionallyClosed) {
        this._connect();
      }
    }, delay);
  }
}
