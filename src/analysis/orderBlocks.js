/**
 * @module orderBlocks
 * Order block detection with validation and mitigation tracking.
 * Operates on arrays of candle objects: { time, open, high, low, close, volume }
 */

import { atr } from './indicators.js';

/**
 * @typedef {Object} OrderBlock
 * @property {'bullish'|'bearish'} type
 * @property {number} top          - High of the OB candle.
 * @property {number} bottom       - Low of the OB candle.
 * @property {number} index        - Candle index of the OB.
 * @property {number} time         - Timestamp of the OB candle.
 * @property {number} strength     - Quality score 0-100.
 * @property {boolean} mitigated
 * @property {number|null} mitigatedAt - Index where mitigated.
 */

/**
 * Detect order blocks in the candle array.
 *
 * Detection:
 * 1. Calculate ATR.
 * 2. For each candle i (1 ≤ i < length-1):
 *    - Bullish OB: candle[i] is bearish AND candle[i+1] has a bullish body > 1.5×ATR.
 *    - Bearish OB: candle[i] is bullish AND candle[i+1] has a bearish body > 1.5×ATR.
 * 3. Strength scored from impulse/ATR ratio, volume, and FVG presence.
 *
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @param {number} [atrPeriod=14]
 * @returns {OrderBlock[]}
 */
export function detectOrderBlocks(candles, atrPeriod = 14) {
  if (!candles || candles.length < atrPeriod + 2) return [];

  const atrValues = atr(candles, atrPeriod);
  const orderBlocks = [];

  // Pre-compute average volume for strength scoring
  let volumeSum = 0;
  let volumeCount = 0;
  for (const c of candles) {
    if (c.volume > 0) {
      volumeSum += c.volume;
      volumeCount++;
    }
  }
  const avgVolume = volumeCount > 0 ? volumeSum / volumeCount : 1;

  for (let i = 1; i < candles.length - 1; i++) {
    const currentATR = atrValues[i];
    if (isNaN(currentATR) || currentATR <= 0) continue;

    const curr = candles[i];
    const next = candles[i + 1];

    const currBody = Math.abs(curr.close - curr.open);
    const nextBody = Math.abs(next.close - next.open);

    const currIsBearish = curr.close < curr.open;
    const currIsBullish = curr.close > curr.open;
    const nextIsBullish = next.close > next.open;
    const nextIsBearish = next.close < next.open;

    let obType = /** @type {'bullish'|'bearish'|null} */ (null);

    const isVolumeValid = (volumeCount === 0) || (next.volume > avgVolume * 1.5);

    // Bullish OB: bearish candle followed by strong bullish impulse + high volume
    if (currIsBearish && nextIsBullish && nextBody > 1.5 * currentATR && isVolumeValid) {
      obType = 'bullish';
    }
    // Bearish OB: bullish candle followed by strong bearish impulse + high volume
    else if (currIsBullish && nextIsBearish && nextBody > 1.5 * currentATR && isVolumeValid) {
      obType = 'bearish';
    }

    if (!obType) continue;

    // --- Strength scoring ---
    let strength = 0;

    // 1. Impulse body / ATR ratio → up to 40 points
    const impulseRatio = nextBody / currentATR;
    // 1.5× is minimum; scale from 1.5 (0 pts) up to ~4× (40 pts)
    strength += Math.min(40, Math.round(((impulseRatio - 1.5) / 2.5) * 40));

    // 2. Volume of impulse vs average → up to 30 points
    if (next.volume > 0 && avgVolume > 0) {
      const volRatio = next.volume / avgVolume;
      // 1× = 0 pts, 3× = 30 pts
      strength += Math.min(30, Math.round(Math.max(0, (volRatio - 1) / 2) * 30));
    }

    // 3. FVG presence → up to 30 points
    const hasFVG = checkFVG(candles, i, obType);
    if (hasFVG) strength += 30;

    // Clamp 0-100
    strength = Math.max(0, Math.min(100, strength));

    orderBlocks.push({
      type: obType,
      top: curr.high,
      bottom: curr.low,
      index: i,
      time: curr.time,
      strength,
      mitigated: false,
      mitigatedAt: null,
    });
  }

  return orderBlocks;
}

/**
 * Check if a Fair Value Gap exists around the order block candle.
 *
 * Bullish FVG: candle[i-1].high < candle[i+1].low  (gap up)
 * Bearish FVG: candle[i-1].low  > candle[i+1].high (gap down)
 *
 * @param {{ high: number, low: number }[]} candles
 * @param {number} i - Index of the OB candle.
 * @param {'bullish'|'bearish'} obType
 * @returns {boolean}
 */
function checkFVG(candles, i, obType) {
  if (i < 0 || i >= candles.length - 2) return false;

  const obCandle = candles[i];
  const postImpulse = candles[i + 2];

  if (obType === 'bullish') {
    return obCandle.high < postImpulse.low;
  } else {
    return obCandle.low > postImpulse.high;
  }
}

/**
 * Update mitigation status for order blocks.
 * A bullish OB is mitigated when any subsequent candle closes below OB.bottom.
 * A bearish OB is mitigated when any subsequent candle closes above OB.top.
 *
 * @param {OrderBlock[]} orderBlocks
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @returns {OrderBlock[]} Updated array with mitigated flags.
 */
export function updateMitigation(orderBlocks, candles) {
  if (!orderBlocks || orderBlocks.length === 0 || !candles || candles.length === 0) {
    return orderBlocks || [];
  }

  return orderBlocks.map(ob => {
    if (ob.mitigated) return ob; // Already mitigated, skip

    const updated = { ...ob };

    // Only check candles after the OB breakout ( breakout candle is ob.index + 1, so check from +2 )
    for (let c = ob.index + 2; c < candles.length; c++) {
      if (ob.type === 'bullish') {
        const touches = candles[c].low <= ob.top;
        const breaks = candles[c].close < ob.bottom;
        if (touches || breaks) {
          updated.mitigated = true;
          updated.mitigatedAt = c;
          break;
        }
      } else if (ob.type === 'bearish') {
        const touches = candles[c].high >= ob.bottom;
        const breaks = candles[c].close > ob.top;
        if (touches || breaks) {
          updated.mitigated = true;
          updated.mitigatedAt = c;
          break;
        }
      }
    }

    return updated;
  });
}
