/**
 * @module indicators
 * Technical indicators computed as pure functions.
 * All functions operate on arrays of numbers (prices/volumes).
 * Returns arrays of the same length, using NaN for insufficient data points.
 * NO external libraries.
 */

/**
 * Simple Moving Average.
 * @param {number[]} values - Array of numeric values.
 * @param {number} period - Lookback period.
 * @returns {number[]} Array of SMA values (NaN where insufficient data).
 */
export function sma(values, period) {
  if (!values || values.length === 0 || period <= 0) return [];
  if (period > values.length) return new Array(values.length).fill(NaN);

  const result = new Array(values.length).fill(NaN);
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }

  return result;
}

/**
 * Exponential Moving Average.
 * @param {number[]} values - Array of numeric values.
 * @param {number} period - Lookback period.
 * @returns {number[]} Array of EMA values (NaN where insufficient data).
 */
export function ema(values, period) {
  if (!values || values.length === 0 || period <= 0) return [];
  if (period > values.length) return new Array(values.length).fill(NaN);

  const result = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  result[period - 1] = sum / period;

  // Calculate EMA from period onward
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

/**
 * Relative Strength Index.
 * @param {number[]} closes - Array of close prices.
 * @param {number} [period=14] - RSI period.
 * @returns {number[]} Array of RSI values (0-100, NaN where insufficient data).
 */
export function rsi(closes, period = 14) {
  if (!closes || closes.length === 0 || period <= 0) return [];
  if (closes.length < period + 1) return new Array(closes.length).fill(NaN);

  const result = new Array(closes.length).fill(NaN);

  // Step 1: price changes
  const changes = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    changes[i] = closes[i] - closes[i - 1];
  }

  // Step 2: separate gains and losses
  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? Math.abs(c) : 0));

  // Step 3: first average (SMA over first `period` changes, starting at index 1)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value at index = period
  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  // Step 4: smoothed averages for subsequent values
  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}

/**
 * Moving Average Convergence Divergence.
 * @param {number[]} closes - Array of close prices.
 * @param {number} [fast=12] - Fast EMA period.
 * @param {number} [slow=26] - Slow EMA period.
 * @param {number} [signal=9] - Signal line EMA period.
 * @returns {{ macdLine: number[], signalLine: number[], histogram: number[] }}
 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length === 0) {
    return { macdLine: [], signalLine: [], histogram: [] };
  }

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  // MACD line = fast EMA - slow EMA
  const macdLine = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }

  // Extract valid MACD values for signal line calculation
  const validMacdStart = macdLine.findIndex(v => !isNaN(v));
  let signalLine = new Array(closes.length).fill(NaN);

  if (validMacdStart !== -1) {
    const validMacd = macdLine.slice(validMacdStart);
    const signalEma = ema(validMacd, signal);

    for (let i = 0; i < signalEma.length; i++) {
      signalLine[validMacdStart + i] = signalEma[i];
    }
  }

  // Histogram = MACD - Signal
  const histogram = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(macdLine[i]) && !isNaN(signalLine[i])) {
      histogram[i] = macdLine[i] - signalLine[i];
    }
  }

  return { macdLine, signalLine, histogram };
}

/**
 * Average True Range.
 * @param {{ high: number, low: number, close: number }[]} candles - Candle data.
 * @param {number} [period=14] - ATR period.
 * @returns {number[]} Array of ATR values (NaN where insufficient data).
 */
export function atr(candles, period = 14) {
  if (!candles || candles.length === 0 || period <= 0) return [];
  if (candles.length < 2) return [NaN];

  const result = new Array(candles.length).fill(NaN);

  // Step 1: calculate True Range for each candle
  const tr = new Array(candles.length).fill(0);
  tr[0] = candles[0].high - candles[0].low; // No previous close for first candle

  for (let i = 1; i < candles.length; i++) {
    const highLow = candles[i].high - candles[i].low;
    const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
    const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(highLow, highPrevClose, lowPrevClose);
  }

  // Step 2: first ATR = SMA of first `period` true ranges
  if (candles.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += tr[i];
  }
  result[period - 1] = sum / period;

  // Step 3: smoothed ATR for subsequent values
  for (let i = period; i < candles.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }

  return result;
}

/**
 * Bollinger Bands.
 * @param {number[]} closes - Array of close prices.
 * @param {number} [period=20] - SMA period for the middle band.
 * @param {number} [stdDevMult=2] - Standard deviation multiplier.
 * @returns {{ upper: number[], middle: number[], lower: number[] }}
 */
export function bollingerBands(closes, period = 20, stdDevMult = 2) {
  if (!closes || closes.length === 0) {
    return { upper: [], middle: [], lower: [] };
  }

  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    // Calculate standard deviation over the window
    let sumSqDiff = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - middle[i];
      sumSqDiff += diff * diff;
    }
    const sd = Math.sqrt(sumSqDiff / period);

    upper[i] = middle[i] + stdDevMult * sd;
    lower[i] = middle[i] - stdDevMult * sd;
  }

  return { upper, middle, lower };
}

/**
 * Volume Simple Moving Average.
 * @param {number[]} volumes - Array of volume values.
 * @param {number} [period=20] - SMA period.
 * @returns {number[]} Array of volume SMA values.
 */
export function volumeSMA(volumes, period = 20) {
  return sma(volumes, period);
}
