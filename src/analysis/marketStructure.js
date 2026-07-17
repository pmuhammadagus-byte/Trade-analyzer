/**
 * @module marketStructure
 * Swing point detection and market structure analysis (BOS / CHoCH).
 * Operates on arrays of candle objects: { time, open, high, low, close, volume }
 */

import { ema } from './indicators.js';

/**
 * @typedef {Object} SwingPoint
 * @property {number} index - Index in the candles array.
 * @property {number} price - Price level of the swing.
 * @property {number} time  - Timestamp of the candle.
 */

/**
 * @typedef {Object} StructureBreak
 * @property {'BOS'|'CHoCH'} type
 * @property {'bullish'|'bearish'} direction
 * @property {number} index - Candle index where the break occurred.
 * @property {number} price - Price level that was broken.
 * @property {number} time
 */

/**
 * Find swing highs and swing lows.
 * A swing high at index i means candle[i].high is strictly greater than all
 * highs in the window [i - lookback, i + lookback].
 * A swing low at index i means candle[i].low is strictly less than all
 * lows in the window [i - lookback, i + lookback].
 *
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @param {number} [lookback=5]
 * @returns {{ swingHighs: SwingPoint[], swingLows: SwingPoint[] }}
 */
export function findSwingPoints(candles, lookback = 5) {
  if (!candles || candles.length === 0) {
    return { swingHighs: [], swingLows: [] };
  }

  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= lookback; j++) {
      // Check left side
      if (candles[i].high <= candles[i - j].high) isSwingHigh = false;
      if (candles[i].low >= candles[i - j].low) isSwingLow = false;

      // Check right side
      if (candles[i].high <= candles[i + j].high) isSwingHigh = false;
      if (candles[i].low >= candles[i + j].low) isSwingLow = false;

      // Early exit when neither is possible
      if (!isSwingHigh && !isSwingLow) break;
    }

    if (isSwingHigh) {
      swingHighs.push({ index: i, price: candles[i].high, time: candles[i].time });
    }
    if (isSwingLow) {
      swingLows.push({ index: i, price: candles[i].low, time: candles[i].time });
    }
  }

  return { swingHighs, swingLows };
}

/**
 * Detect market structure including BOS, CHoCH, and trend.
 *
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @param {number} [lookback=5]
 * @returns {{
 *   swingHighs: SwingPoint[],
 *   swingLows: SwingPoint[],
 *   structureBreaks: StructureBreak[],
 *   trend: 'bullish'|'bearish'|'ranging',
 *   higherHighs: boolean,
 *   higherLows: boolean,
 *   lowerHighs: boolean,
 *   lowerLows: boolean
 * }}
 */
export function detectStructure(candles, lookback = 5) {
  const { swingHighs, swingLows } = findSwingPoints(candles, lookback);

  const result = {
    swingHighs,
    swingLows,
    structureBreaks: [],
    trend: /** @type {'bullish'|'bearish'|'ranging'} */ ('ranging'),
    higherHighs: false,
    higherLows: false,
    lowerHighs: false,
    lowerLows: false,
  };

  if (swingHighs.length < 2 && swingLows.length < 2) {
    return result;
  }

  // --- Determine HH / HL / LH / LL patterns from last 2 swing points ---
  if (swingHighs.length >= 2) {
    const lastH = swingHighs[swingHighs.length - 1];
    const prevH = swingHighs[swingHighs.length - 2];
    result.higherHighs = lastH.price > prevH.price;
    result.lowerHighs = lastH.price < prevH.price;
  }

  if (swingLows.length >= 2) {
    const lastL = swingLows[swingLows.length - 1];
    const prevL = swingLows[swingLows.length - 2];
    result.higherLows = lastL.price > prevL.price;
    result.lowerLows = lastL.price < prevL.price;
  }

  // --- Determine overall trend from swing-point sequence ---
  if (result.higherHighs && result.higherLows) {
    result.trend = 'bullish';
  } else if (result.lowerHighs && result.lowerLows) {
    result.trend = 'bearish';
  } else {
    result.trend = 'ranging';
  }

  // --- Chronological walk to detect structure breaks and update localTrend ---
  let localTrend = /** @type {'bullish'|'bearish'|'ranging'} */ ('ranging');

  // Initialise local trend from the overall trend pattern
  if (result.higherHighs && result.higherLows) {
    localTrend = 'bullish';
  } else if (result.lowerHighs && result.lowerLows) {
    localTrend = 'bearish';
  }

  const structureBreaks = [];

  // Clone active swing points so we can mark them as broken
  const activeHighs = swingHighs.map(sh => ({ ...sh, broken: false }));
  const activeLows = swingLows.map(sl => ({ ...sl, broken: false }));

  // Process candles chronologically
  for (let c = 0; c < candles.length; c++) {
    const close = candles[c].close;

    // 1. Check if candle c breaks any active high established before c
    let brokenHigh = null;
    for (const sh of activeHighs) {
      if (sh.index < c && !sh.broken && close > sh.price) {
        sh.broken = true;
        // Target the highest broken level at this candle to represent major breakout
        if (!brokenHigh || sh.price > brokenHigh.price) {
          brokenHigh = sh;
        }
      }
    }

    if (brokenHigh) {
      const type = (localTrend === 'bearish' || localTrend === 'ranging') ? 'CHoCH' : 'BOS';
      structureBreaks.push({
        type,
        direction: /** @type {'bullish'} */ ('bullish'),
        index: c,
        price: brokenHigh.price,
        time: candles[c].time,
      });
      localTrend = 'bullish';
    }

    // 2. Check if candle c breaks any active low established before c
    let brokenLow = null;
    for (const sl of activeLows) {
      if (sl.index < c && !sl.broken && close < sl.price) {
        sl.broken = true;
        // Target the lowest broken level at this candle
        if (!brokenLow || sl.price < brokenLow.price) {
          brokenLow = sl;
        }
      }
    }

    if (brokenLow) {
      const type = (localTrend === 'bullish' || localTrend === 'ranging') ? 'CHoCH' : 'BOS';
      structureBreaks.push({
        type,
        direction: /** @type {'bearish'} */ ('bearish'),
        index: c,
        price: brokenLow.price,
        time: candles[c].time,
      });
      localTrend = 'bearish';
    }
  }

  // Sort structure breaks chronologically (already chronological from the loop, but sort just in case)
  structureBreaks.sort((a, b) => a.index - b.index);
  result.structureBreaks = structureBreaks;

  return result;
}
