/**
 * @module supplyDemand
 * Supply and demand zone detection via Rally-Base-Rally / Drop-Base-Drop
 * and reversal patterns (DBR / RBD).
 * Operates on arrays of candle objects: { time, open, high, low, close, volume }
 */

import { atr } from './indicators.js';

/**
 * @typedef {Object} Zone
 * @property {'demand'|'supply'} type
 * @property {'RBR'|'DBR'|'DBD'|'RBD'} pattern
 * @property {number} top
 * @property {number} bottom
 * @property {number} startIndex
 * @property {number} endIndex
 * @property {number} time
 * @property {number} strength    - 0-100
 * @property {'fresh'|'tested'|'broken'} status
 * @property {number} testCount
 */

/**
 * Classify a candle as 'rally', 'drop', or 'base' relative to the current ATR.
 * @param {{ open: number, close: number }} candle
 * @param {number} atrVal - Current ATR value.
 * @returns {'rally'|'drop'|'base'}
 */
function classifyCandle(candle, atrVal) {
  const body = candle.close - candle.open; // signed
  const absBody = Math.abs(body);
  const threshold = 0.5 * atrVal;

  if (absBody < threshold) return 'base';
  return body > 0 ? 'rally' : 'drop';
}

/**
 * Detect supply and demand zones.
 *
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @param {number} [atrPeriod=14]
 * @returns {Zone[]}
 */
export function detectZones(candles, atrPeriod = 14) {
  if (!candles || candles.length < atrPeriod + 5) return [];

  const atrValues = atr(candles, atrPeriod);
  const zones = [];

  // Precompute average volume for VSA filtering
  let volumeSum = 0;
  let volumeCount = 0;
  for (const c of candles) {
    if (c.volume > 0) {
      volumeSum += c.volume;
      volumeCount++;
    }
  }
  const avgVolume = volumeCount > 0 ? volumeSum / volumeCount : 1;

  // Classify every candle
  const labels = candles.map((c, i) => {
    const a = atrValues[i];
    return isNaN(a) || a <= 0 ? 'base' : classifyCandle(c, a);
  });

  // Scan for patterns: we need at least 3 segments (move → base → move)
  let i = atrPeriod; // start after ATR is valid
  while (i < candles.length - 2) {
    // 1. Find the start of a directional move (rally or drop)
    const firstMoveType = labels[i];
    if (firstMoveType === 'base') {
      i++;
      continue;
    }

    // Consume consecutive candles of the same move type
    let firstMoveEnd = i;
    while (firstMoveEnd + 1 < candles.length && labels[firstMoveEnd + 1] === firstMoveType) {
      firstMoveEnd++;
    }

    // 2. Look for a base zone (1-3 base candles)
    const baseStart = firstMoveEnd + 1;
    if (baseStart >= candles.length) break;
    if (labels[baseStart] !== 'base') {
      i = baseStart;
      continue;
    }

    let baseEnd = baseStart;
    const maxBaseLen = 3;
    while (
      baseEnd + 1 < candles.length &&
      labels[baseEnd + 1] === 'base' &&
      baseEnd - baseStart + 1 < maxBaseLen
    ) {
      baseEnd++;
    }

    // 3. Look for the second directional move
    const secondMoveStart = baseEnd + 1;
    if (secondMoveStart >= candles.length) break;
    const secondMoveType = labels[secondMoveStart];

    if (secondMoveType === 'base') {
      i = secondMoveStart;
      continue;
    }

    // Consume the second move
    let secondMoveEnd = secondMoveStart;
    while (secondMoveEnd + 1 < candles.length && labels[secondMoveEnd + 1] === secondMoveType) {
      secondMoveEnd++;
    }

    // 4. Determine pattern
    let pattern = /** @type {'RBR'|'DBR'|'DBD'|'RBD'|null} */ (null);
    let zoneType = /** @type {'demand'|'supply'|null} */ (null);

    if (firstMoveType === 'rally' && secondMoveType === 'rally') {
      pattern = 'RBR';
      zoneType = 'demand';
    } else if (firstMoveType === 'drop' && secondMoveType === 'rally') {
      pattern = 'DBR';
      zoneType = 'demand';
    } else if (firstMoveType === 'drop' && secondMoveType === 'drop') {
      pattern = 'DBD';
      zoneType = 'supply';
    } else if (firstMoveType === 'rally' && secondMoveType === 'drop') {
      pattern = 'RBD';
      zoneType = 'supply';
    }

    if (!pattern || !zoneType) {
      i = secondMoveStart;
      continue;
    }

    // Hard VSA Filter: Departure candles must have average volume > avgVolume * 1.2 (if volume data is available)
    if (volumeCount > 0) {
      let totalDepartureVolume = 0;
      for (let m = secondMoveStart; m <= secondMoveEnd; m++) {
        totalDepartureVolume += candles[m].volume;
      }
      const avgDepartureVolume = totalDepartureVolume / (secondMoveEnd - secondMoveStart + 1);
      if (avgDepartureVolume < avgVolume * 1.2) {
        i = secondMoveStart;
        continue;
      }
    }

    // 5. Zone boundaries = high/low of the base candles
    let zoneTop = -Infinity;
    let zoneBottom = Infinity;
    for (let b = baseStart; b <= baseEnd; b++) {
      zoneTop = Math.max(zoneTop, candles[b].high);
      zoneBottom = Math.min(zoneBottom, candles[b].low);
    }

    // 6. Strength scoring
    const currentATR = atrValues[baseStart] || 1;
    let strength = 0;

    // a) Departure strength: how fast price left the base (second move body / ATR) → 40 pts
    let departureBody = 0;
    for (let m = secondMoveStart; m <= secondMoveEnd; m++) {
      departureBody += Math.abs(candles[m].close - candles[m].open);
    }
    const departureRatio = departureBody / currentATR;
    strength += Math.min(40, Math.round((departureRatio / 3) * 40));

    // b) Base tightness: smaller base range = stronger → 30 pts
    const baseRange = zoneTop - zoneBottom;
    if (baseRange > 0) {
      const tightnessRatio = currentATR / baseRange; // higher = tighter
      strength += Math.min(30, Math.round(Math.min(tightnessRatio, 3) / 3 * 30));
    } else {
      strength += 30; // zero-range base is maximally tight
    }

    // c) Fresh = full 30 pts (will be reduced by updateZoneStatus later)
    strength += 30;

    strength = Math.max(0, Math.min(100, strength));

    // d) Reversal patterns (DBR / RBD) get a small bonus, capped at 100
    if (pattern === 'DBR' || pattern === 'RBD') {
      strength = Math.min(100, strength + 10);
    }

    zones.push({
      type: zoneType,
      pattern,
      top: zoneTop,
      bottom: zoneBottom,
      startIndex: baseStart,
      endIndex: baseEnd,
      time: candles[baseStart].time,
      strength,
      status: /** @type {'fresh'} */ ('fresh'),
      testCount: 0,
    });

    // Advance past this pattern
    i = secondMoveEnd + 1;
  }

  return zones;
}

/**
 * Update zone status by checking if price has tested or broken through each zone.
 *
 * - Touch but bounce → status='tested', testCount++
 * - Close through zone → status='broken'
 * - More than 3 tests → reduce strength by 10 per extra test
 *
 * @param {Zone[]} zones
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @returns {Zone[]}
 */
export function updateZoneStatus(zones, candles) {
  if (!zones || zones.length === 0 || !candles || candles.length === 0) {
    return zones || [];
  }

  return zones.map(zone => {
    if (zone.status === 'broken') return zone;

    const updated = { ...zone };
    let currentlyInside = false;

    // Only check candles after the zone formed
    for (let c = zone.endIndex + 1; c < candles.length; c++) {
      const candle = candles[c];

      if (zone.type === 'demand') {
        // Price dips into zone
        const touchesZone = candle.low <= zone.top && candle.low >= zone.bottom;
        const closesThrough = candle.close < zone.bottom;

        if (closesThrough) {
          updated.status = 'broken';
          break;
        }
        if (touchesZone && candle.close > zone.top) {
          // Bounced off the zone (only count if price entered from outside)
          if (!currentlyInside) {
            updated.status = 'tested';
            updated.testCount++;
            if (updated.firstTestIndex === undefined) {
              updated.firstTestIndex = c;
            }
            currentlyInside = true;
          }
        } else {
          currentlyInside = false;
        }
      } else {
        // Supply zone
        const touchesZone = candle.high >= zone.bottom && candle.high <= zone.top;
        const closesThrough = candle.close > zone.top;

        if (closesThrough) {
          updated.status = 'broken';
          break;
        }
        if (touchesZone && candle.close < zone.bottom) {
          // Bounced off the zone
          if (!currentlyInside) {
            updated.status = 'tested';
            updated.testCount++;
            if (updated.firstTestIndex === undefined) {
              updated.firstTestIndex = c;
            }
            currentlyInside = true;
          }
        } else {
          currentlyInside = false;
        }
      }
    }

    // Penalise over-tested zones
    if (updated.testCount > 3) {
      const penalty = (updated.testCount - 3) * 10;
      updated.strength = Math.max(0, zone.strength - penalty);
    }

    return updated;
  });
}
