/**
 * @module trendDetector
 * Multi-factor trend analysis combining EMA alignment, slope,
 * market structure, and price position.
 * Operates on arrays of candle objects: { time, open, high, low, close, volume }
 */

import { ema } from './indicators.js';
import { detectStructure } from './marketStructure.js';

/**
 * @typedef {Object} TrendAnalysis
 * @property {'strong_bullish'|'bullish'|'ranging'|'bearish'|'strong_bearish'} direction
 * @property {number}  strength       - 0-100
 * @property {'bullish'|'bearish'|'mixed'} emaAlignment
 * @property {'bullish'|'bearish'|'ranging'} structureTrend
 * @property {'increasing'|'decreasing'|'neutral'} momentum
 * @property {string}  details        - Human-readable summary
 */

/**
 * Analyse trend on the given candle data.
 *
 * Scoring (100 total):
 *   25 pts – EMA alignment (perfect stack = full marks)
 *   25 pts – EMA slope (last 5 values directional)
 *   25 pts – Market structure (HH+HL / LH+LL)
 *   25 pts – Price position vs EMA 200
 *
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @returns {TrendAnalysis}
 */
export function analyzeTrend(candles) {
  const defaultResult = {
    direction: /** @type {const} */ ('ranging'),
    strength: 0,
    emaAlignment: /** @type {const} */ ('mixed'),
    structureTrend: /** @type {const} */ ('ranging'),
    momentum: /** @type {const} */ ('neutral'),
    details: 'Insufficient data for trend analysis.',
  };

  if (!candles || candles.length < 200) {
    // We need at least 200 candles for EMA 200
    // Gracefully degrade: try with what we have
    if (!candles || candles.length < 50) return defaultResult;
  }

  const closes = candles.map(c => c.close);
  const lastClose = closes[closes.length - 1];

  // --- 1. EMA calculations ---
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = candles.length >= 200 ? ema(closes, 200) : null;

  const lastIdx = closes.length - 1;
  const e9 = ema9[lastIdx];
  const e21 = ema21[lastIdx];
  const e50 = ema50[lastIdx];
  const e200 = ema200 ? ema200[lastIdx] : null;

  // --- Score tracking: positive = bullish, negative = bearish ---
  let bullScore = 0;
  let bearScore = 0;

  // --- Factor 1: EMA alignment (25 pts) ---
  let emaAlignment = /** @type {'bullish'|'bearish'|'mixed'} */ ('mixed');

  if (!isNaN(e9) && !isNaN(e21) && !isNaN(e50)) {
    let bullAlignCount = 0;
    let bearAlignCount = 0;

    // Check pairwise ordering
    if (e9 > e21) bullAlignCount++; else if (e9 < e21) bearAlignCount++;
    if (e21 > e50) bullAlignCount++; else if (e21 < e50) bearAlignCount++;

    if (e200 !== null && !isNaN(e200)) {
      if (e50 > e200) bullAlignCount++; else if (e50 < e200) bearAlignCount++;

      // Perfect alignment = 3 pairs correct
      if (bullAlignCount === 3) {
        emaAlignment = 'bullish';
        bullScore += 25;
      } else if (bearAlignCount === 3) {
        emaAlignment = 'bearish';
        bearScore += 25;
      } else {
        // Partial
        bullScore += Math.round((bullAlignCount / 3) * 25);
        bearScore += Math.round((bearAlignCount / 3) * 25);
      }
    } else {
      // No EMA200 — score from 2 pairs
      if (bullAlignCount === 2) {
        emaAlignment = 'bullish';
        bullScore += 20;
      } else if (bearAlignCount === 2) {
        emaAlignment = 'bearish';
        bearScore += 20;
      } else {
        bullScore += Math.round((bullAlignCount / 2) * 20);
        bearScore += Math.round((bearAlignCount / 2) * 20);
      }
    }
  }

  // --- Factor 2: EMA slope — last 5 values of EMA21 (25 pts) ---
  let momentum = /** @type {'increasing'|'decreasing'|'neutral'} */ ('neutral');

  if (lastIdx >= 5) {
    const slopeWindow = 5;
    const recentEma = ema21.slice(lastIdx - slopeWindow + 1, lastIdx + 1);
    const validEma = recentEma.filter(v => !isNaN(v));

    if (validEma.length >= 3) {
      let rising = 0;
      let falling = 0;
      for (let i = 1; i < validEma.length; i++) {
        if (validEma[i] > validEma[i - 1]) rising++;
        else if (validEma[i] < validEma[i - 1]) falling++;
      }
      const total = validEma.length - 1;

      if (rising / total >= 0.7) {
        momentum = 'increasing';
        bullScore += 25;
      } else if (falling / total >= 0.7) {
        momentum = 'decreasing';
        bearScore += 25;
      } else {
        // Partial credit
        bullScore += Math.round((rising / total) * 25);
        bearScore += Math.round((falling / total) * 25);
      }
    }
  }

  // --- Factor 3: Market structure (25 pts) ---
  const structure = detectStructure(candles);
  const structureTrend = structure.trend;

  if (structureTrend === 'bullish') {
    bullScore += 25;
  } else if (structureTrend === 'bearish') {
    bearScore += 25;
  } else {
    // Partial based on individual flags
    if (structure.higherHighs) bullScore += 8;
    if (structure.higherLows) bullScore += 8;
    if (structure.lowerHighs) bearScore += 8;
    if (structure.lowerLows) bearScore += 8;
  }

  // --- Factor 4: Price position vs EMA200 (25 pts) ---
  if (e200 !== null && !isNaN(e200)) {
    if (lastClose > e200) {
      // Distance matters: the further above, the more bullish
      const distPct = ((lastClose - e200) / e200) * 100;
      bullScore += Math.min(25, Math.round(Math.min(distPct, 5) / 5 * 25));
    } else {
      const distPct = ((e200 - lastClose) / e200) * 100;
      bearScore += Math.min(25, Math.round(Math.min(distPct, 5) / 5 * 25));
    }
  }

  // --- Final direction and strength ---
  const netScore = bullScore - bearScore; // positive = bullish, negative = bearish
  const totalScore = Math.abs(netScore);
  const strength = Math.min(100, totalScore);

  let direction = /** @type {'strong_bullish'|'bullish'|'ranging'|'bearish'|'strong_bearish'} */ ('ranging');

  if (netScore > 0) {
    if (strength >= 80) direction = 'strong_bullish';
    else if (strength >= 55) direction = 'bullish';
    else direction = 'ranging';
  } else if (netScore < 0) {
    if (strength >= 80) direction = 'strong_bearish';
    else if (strength >= 55) direction = 'bearish';
    else direction = 'ranging';
  }

  // --- Build details string ---
  const details = [
    `Trend: ${direction} (strength ${strength}/100)`,
    `EMA alignment: ${emaAlignment} | EMA9=${e9?.toFixed(2)} EMA21=${e21?.toFixed(2)} EMA50=${e50?.toFixed(2)}${e200 !== null ? ' EMA200=' + e200?.toFixed(2) : ''}`,
    `Market structure: ${structureTrend} (HH:${structure.higherHighs} HL:${structure.higherLows} LH:${structure.lowerHighs} LL:${structure.lowerLows})`,
    `Momentum: ${momentum}`,
    `Bull score: ${bullScore} | Bear score: ${bearScore}`,
  ].join('\n');

  return {
    direction,
    strength,
    emaAlignment,
    structureTrend,
    momentum,
    details,
  };
}
