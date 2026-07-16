/**
 * @module signalGenerator
 * Confluence-based signal generation with FundingPips risk management.
 * Operates on arrays of candle objects: { time, open, high, low, close, volume }
 */

import { detectOrderBlocks, updateMitigation } from './orderBlocks.js';
import { detectZones, updateZoneStatus } from './supplyDemand.js';
import { detectStructure } from './marketStructure.js';
import { analyzeTrend } from './trendDetector.js';
import { rsi, ema, atr, macd } from './indicators.js';

// ──────────────────────────────────────────────
// FundingPips contract specifications
// ──────────────────────────────────────────────

/** @type {Record<string, { type: string, pipValue: number|null, pipSize: number, label: string }>} */
export const CONTRACT_SPECS = {
  BTCUSDT:  { type: 'crypto',      pipValue: 1,    pipSize: 1,      label: '$/coin' },
  XAUUSD:   { type: 'commodity',   pipValue: 100,  pipSize: 1,      label: '$/point' },
  GBPUSD:   { type: 'forex',       pipValue: 10,   pipSize: 0.0001, label: '$/pip' },
  USDCAD:   { type: 'forex_quote', pipValue: null,  pipSize: 0.0001, label: '$/pip (dynamic)' },
};

/** Maximum dollar risk per trade. */
export const MAX_RISK = 50;

/** Maximum losing trades per day before halting. */
export const MAX_DAILY_LOSSES = 3;

/** ATR multipliers config for Stop Loss buffers. */
export const ATR_MULTIPLIERS = {
  BTCUSDT: 1.5,
  XAUUSD: 0.5,
  GBPUSD: 0.5,
  USDCAD: 0.5,
};

export const ATR_CONFIG = {
  useDynamic: true,
};

/**
 * Strategy options the live engine (server autopilot + browser client) passes to
 * generateSignals. Backtest (96 trades, ~60–82d, pessimistic fills) showed that
 * blocking ranging-regime setups lifted profit factor 1.36→1.71, net +53%, and
 * cut max drawdown — every metric improved. Re-validate on longer/out-of-sample
 * data when available. Set blockRanging:false here to revert to prior behaviour.
 */
export const LIVE_STRATEGY_OPTS = { blockRanging: true };

/**
 * Get the spread value in price units for a symbol.
 *
 * @param {string} symbol
 * @returns {number}
 */
function getSpread(symbol) {
  switch (symbol) {
    case 'BTCUSDT': return 25.0;
    case 'XAUUSD': return 0.7;
    case 'GBPUSD':
    case 'USDCAD':
      return 0.00007; // 0.7 pips
    default:
      return 0;
  }
}

// ──────────────────────────────────────────────
// Lot-size calculator
// ──────────────────────────────────────────────

/**
 * Calculate position size to risk exactly $50.
 *
 * @param {string} symbol - e.g. 'BTCUSDT', 'XAUUSD', 'EURUSD'.
 * @param {number} entryPrice
 * @param {number} slPrice
 * @param {number|null} [currentRate=null] - Required for quote-currency pairs (USDCAD).
 * @returns {{ lots: number, riskAmount: number, slDistance: number, slPips: number }}
 */
export function calculateLotSize(symbol, entryPrice, slPrice, currentRate = null) {
  const spec = CONTRACT_SPECS[symbol];
  if (!spec) {
    throw new Error(`Unknown symbol: ${symbol}. Supported: ${Object.keys(CONTRACT_SPECS).join(', ')}`);
  }

  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance === 0) {
    return { lots: 0, riskAmount: 0, slDistance: 0, slPips: 0 };
  }

  let lots = 0;
  let slPips = 0;

  switch (spec.type) {
    case 'crypto': {
      // 1 lot = 1 coin; risk per lot = slDistance
      lots = MAX_RISK / slDistance;
      slPips = slDistance; // expressed in price units
      break;
    }

    case 'commodity': {
      // XAUUSD: 1 lot = $100/point
      lots = MAX_RISK / (slDistance * 100);
      slPips = slDistance;
      break;
    }

    case 'forex': {
      // EURUSD / GBPUSD: pip = 0.0001, 1 std lot = $10/pip
      slPips = slDistance / spec.pipSize;
      lots = MAX_RISK / (slPips * 10);
      break;
    }

    case 'forex_quote': {
      // USDCAD: pipValue = 10 / currentRate
      if (!currentRate || currentRate <= 0) {
        throw new Error(`currentRate is required for ${symbol}`);
      }
      slPips = slDistance / spec.pipSize;
      const dynamicPipValue = 10 / currentRate;
      lots = MAX_RISK / (slPips * dynamicPipValue);
      break;
    }

    default:
      throw new Error(`Unsupported contract type: ${spec.type}`);
  }

  // Clamp to minimum 0.01, round to 2 decimals
  lots = Math.max(0.01, Math.round(lots * 100) / 100);

  // Apply maximum lot limits requested by the user
  let maxLots = 3.0; // Default limit
  if (symbol === 'BTCUSDT') {
    maxLots = 0.14;
  } else if (symbol === 'XAUUSD') {
    maxLots = 0.3;
  } else if (spec.type === 'forex' || spec.type === 'forex_quote') {
    maxLots = 3.0;
  }

  lots = Math.min(lots, maxLots);

  // Calculate actual risk based on the final clamped lot size
  let riskAmount = MAX_RISK;
  switch (spec.type) {
    case 'crypto':
      riskAmount = lots * slDistance;
      break;
    case 'commodity':
      riskAmount = lots * slDistance * 100;
      break;
    case 'forex':
      riskAmount = slPips * lots * 10;
      break;
    case 'forex_quote':
      const dynamicPipValue = 10 / currentRate;
      riskAmount = slPips * lots * dynamicPipValue;
      break;
  }

  riskAmount = Math.round(riskAmount * 100) / 100;

  return { lots, riskAmount, slDistance, slPips: Math.round(slPips * 100) / 100 };
}

// ──────────────────────────────────────────────
// Signal generation
// ──────────────────────────────────────────────

/**
 * @typedef {Object} Signal
 * @property {'LONG'|'SHORT'} type
 * @property {string} symbol
 * @property {number} time
 * @property {number} entry
 * @property {number} sl
 * @property {number} tp1
 * @property {number} tp2
 * @property {number} lotSize
 * @property {number} riskAmount
 * @property {number} slPips
 * @property {number} rrRatio
 * @property {'A'|'B'|'C'} quality
 * @property {string[]} confluences
 * @property {number} score
 */

/**
 * Generate confluence-based trade signals.
 *
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @param {string} symbol
 * @param {number} [dailyLossCount=0]
 * @returns {Signal[]}
 */
export function generateSignals(candles, symbol, dailyLossCount = 0, opts = {}) {
  // Experiment flags (default off → identical to live behaviour):
  //   opts.blockRanging     – reject all setups when trend is 'ranging'.
  //   opts.maxEntryDistAtr  – reject setups whose entry has run more than this
  //                           many ATR away from the zone it is based on (anti-chase).
  // Daily loss limit check removed - trade anytime setup meets
  if (!candles || candles.length < 50) return [];

  const lastCandle = candles[candles.length - 1];

  // Option B: Session-based Kill Zones for Forex and Gold
  const isCrypto = symbol === 'BTCUSDT';
  if (!isCrypto) {
    const lastCandleDate = new Date(lastCandle.time * 1000);
    const utcHour = lastCandleDate.getUTCHours();
    const inLondonKZ = utcHour >= 7 && utcHour < 10;
    const inNewYorkKZ = utcHour >= 12 && utcHour < 15;
    if (!inLondonKZ && !inNewYorkKZ) {
      return [];
    }
  }

  // --- Run all analyses ---
  const closes = candles.map(c => c.close);
  const lastClose = lastCandle.close;

  let orderBlocks = detectOrderBlocks(candles);
  orderBlocks = updateMitigation(orderBlocks, candles);

  let zones = detectZones(candles);
  zones = updateZoneStatus(zones, candles);

  const structure = detectStructure(candles);
  const trend = analyzeTrend(candles);

  // Experiment: skip ranging regimes entirely (mean-reversion zone entries get
  // chopped in range-bound chop — see audit). Off unless opts.blockRanging set.
  if (opts.blockRanging && trend.direction === 'ranging') return [];

  const rsiValues = rsi(closes);
  const ema21Values = ema(closes, 21);
  const ema50Values = ema(closes, 50);
  const atrValues = atr(candles);
  const macdData = macd(closes);

  const lastRSI = rsiValues[rsiValues.length - 1];
  const lastATR = atrValues[atrValues.length - 1];
  const lastEma21 = ema21Values[ema21Values.length - 1];
  const lastEma50 = ema50Values[ema50Values.length - 1];

  if (isNaN(lastATR) || lastATR <= 0) return [];

  const signals = [];

  // Candidate zones: recent candles (last 3) touching an OB or S/D zone
  const recentStart = Math.max(0, candles.length - 3);

  // --- Check Order Blocks ---
  const activeOBs = orderBlocks.filter(ob => {
    return !ob.mitigated || ob.mitigatedAt >= recentStart;
  });
  for (const ob of activeOBs) {
    // Check if recent price is within the OB range
    let isHit = false;
    for (let c = recentStart; c < candles.length; c++) {
      if (ob.type === 'bullish' && candles[c].low <= ob.top && candles[c].low >= ob.bottom) {
        isHit = true;
        break;
      }
      if (ob.type === 'bearish' && candles[c].high >= ob.bottom && candles[c].high <= ob.top) {
        isHit = true;
        break;
      }
    }
    if (!isHit) continue;

    const signalType = ob.type === 'bullish' ? 'LONG' : 'SHORT';
    const result = buildSignal(
      signalType, ob.top, ob.bottom, 'OB',
      lastClose, lastATR, structure, trend, lastRSI, lastEma21, lastEma50,
      candles, symbol, opts
    );
    if (result) signals.push(result);
  }

  // --- Check S/D Zones ---
  const activeZones = zones.filter(z => {
    return z.status === 'fresh' || (z.status === 'tested' && z.firstTestIndex >= recentStart);
  });
  for (const zone of activeZones) {
    let isHit = false;
    for (let c = recentStart; c < candles.length; c++) {
      if (zone.type === 'demand' && candles[c].low <= zone.top && candles[c].close >= zone.bottom) {
        isHit = true;
        break;
      }
      if (zone.type === 'supply' && candles[c].high >= zone.bottom && candles[c].close <= zone.top) {
        isHit = true;
        break;
      }
    }
    if (!isHit) continue;

    const signalType = zone.type === 'demand' ? 'LONG' : 'SHORT';
    const result = buildSignal(
      signalType, zone.top, zone.bottom, 'SD',
      lastClose, lastATR, structure, trend, lastRSI, lastEma21, lastEma50,
      candles, symbol, opts
    );
    if (result) signals.push(result);
  }

  // De-duplicate: if multiple signals share direction and are within 1 ATR of each other, keep strongest
  const deduplicated = deduplicateSignals(signals, lastATR);

  return deduplicated;
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

/**
 * Detect if a liquidity sweep has occurred.
 */
function detectLiquiditySweep(type, candles, structure, zoneBottom, zoneTop) {
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx].close;
  
  if (type === 'LONG') {
    const recentSwingLows = (structure.swingLows || []).filter(
      sl => sl.index < lastIdx - 2 && sl.index >= lastIdx - 40 && sl.price > zoneBottom
    );
    if (recentSwingLows.length === 0) return false;
    
    const lowestSwingLow = Math.min(...recentSwingLows.map(sl => sl.price));
    
    let dippedBelow = false;
    for (let c = lastIdx - 2; c <= lastIdx; c++) {
      if (candles[c] && candles[c].low < lowestSwingLow) {
        dippedBelow = true;
        break;
      }
    }
    return dippedBelow && lastClose > lowestSwingLow;
  } else {
    const recentSwingHighs = (structure.swingHighs || []).filter(
      sh => sh.index < lastIdx - 2 && sh.index >= lastIdx - 40 && sh.price < zoneTop
    );
    if (recentSwingHighs.length === 0) return false;
    
    const highestSwingHigh = Math.max(...recentSwingHighs.map(sh => sh.price));
    
    let spikedAbove = false;
    for (let c = lastIdx - 2; c <= lastIdx; c++) {
      if (candles[c] && candles[c].high > highestSwingHigh) {
        spikedAbove = true;
        break;
      }
    }
    return spikedAbove && lastClose < highestSwingHigh;
  }
}

/**
 * Detect timeframe based on candle spacing.
 */
function detectTimeframe(candles) {
  if (!candles || candles.length < 2) return '15m';
  for (let i = candles.length - 2; i >= 0; i--) {
    const diff = candles[i + 1].time - candles[i].time;
    if (diff === 60) return '1m';
    if (diff === 300) return '5m';
    if (diff === 900) return '15m';
    if (diff === 3600) return '1H';
    if (diff === 14400) return '4H';
    if (diff === 86400) return '1D';
  }
  return '15m';
}

/**
 * Get dynamic optimal Stop Loss ATR multiplier per symbol and timeframe.
 */
function getAtrMultiplier(symbol, timeframe) {
  const isHigherTimeframe = timeframe === '1H' || timeframe === '4H' || timeframe === '1D';
  if (isHigherTimeframe) {
    switch (symbol) {
      case 'BTCUSDT': return 2.5;
      case 'XAUUSD': return 0.5;
      case 'GBPUSD': return 2.0;
      case 'USDCAD': return 2.5;
      default: return 0.5;
    }
  } else {
    // 15m, 5m, 1m
    switch (symbol) {
      case 'BTCUSDT': return 1.5;
      case 'XAUUSD': return 1.5;
      case 'GBPUSD': return 2.0;
      case 'USDCAD': return 1.0;
      default: return 0.5;
    }
  }
}

/**
 * Build and score a signal candidate.
 * @returns {Signal|null}
 */
function buildSignal(
  type, zoneTop, zoneBottom, source,
  lastClose, lastATR, structure, trend, lastRSI, lastEma21, lastEma50,
  candles, symbol, opts = {}
) {
  const confluences = [];
  let score = 0;

  // 1. Price at valid zone/OB (always 1 since we pre-filtered)
  confluences.push(`Price at ${source === 'OB' ? 'Order Block' : 'S/D Zone'}`);
  score++;

  // 2. Trend alignment
  const trendBull = trend.direction === 'bullish' || trend.direction === 'strong_bullish';
  const trendBear = trend.direction === 'bearish' || trend.direction === 'strong_bearish';
  if ((type === 'LONG' && trendBull) || (type === 'SHORT' && trendBear)) {
    confluences.push(`Trend aligned (${trend.direction})`);
    score++;
  }

  // 3. Market structure confirmation
  const recentBreaks = structure.structureBreaks.filter(
    b => b.index >= candles.length - 20
  );
  const hasBOSInDir = recentBreaks.some(
    b => b.type === 'BOS' &&
      ((type === 'LONG' && b.direction === 'bullish') ||
       (type === 'SHORT' && b.direction === 'bearish'))
  );
  const hasCHoCH = recentBreaks.some(
    b => b.type === 'CHoCH' &&
      ((type === 'LONG' && b.direction === 'bullish') ||
       (type === 'SHORT' && b.direction === 'bearish'))
  );
  if (hasBOSInDir) {
    confluences.push('BOS confirms direction');
    score++;
  } else if (hasCHoCH) {
    confluences.push('CHoCH signals reversal');
    score++;
  }

  // 4. RSI confirmation
  if (!isNaN(lastRSI)) {
    if (type === 'LONG' && lastRSI < 35) {
      confluences.push(`RSI oversold (${lastRSI.toFixed(1)})`);
      score++;
    } else if (type === 'SHORT' && lastRSI > 65) {
      confluences.push(`RSI overbought (${lastRSI.toFixed(1)})`);
      score++;
    }
  }

  // 5. EMA confluence (price near EMA 21 or 50 acting as S/R)
  if (!isNaN(lastEma21) && !isNaN(lastEma50)) {
    const emaProximity21 = Math.abs(lastClose - lastEma21) / lastATR;
    const emaProximity50 = Math.abs(lastClose - lastEma50) / lastATR;

    if (type === 'LONG' && lastClose >= lastEma21 && emaProximity21 < 1.5) {
      confluences.push('Price near EMA21 support');
      score++;
    } else if (type === 'LONG' && lastClose >= lastEma50 && emaProximity50 < 1.5) {
      confluences.push('Price near EMA50 support');
      score++;
    } else if (type === 'SHORT' && lastClose <= lastEma21 && emaProximity21 < 1.5) {
      confluences.push('Price near EMA21 resistance');
      score++;
    } else if (type === 'SHORT' && lastClose <= lastEma50 && emaProximity50 < 1.5) {
      confluences.push('Price near EMA50 resistance');
      score++;
    }
  }

  // 6. Liquidity Sweep Confirmation
  const sweepConfirmed = detectLiquiditySweep(type, candles, structure, zoneBottom, zoneTop);
  if (sweepConfirmed) {
    confluences.push('Liquidity sweep confirms setup');
    score++;
  }

  // Hard Trend Filter: Avoid counter-trend setups unless a CHoCH confirms a structural reversal
  const trendCounter = (type === 'LONG' && trendBear) || (type === 'SHORT' && trendBull);
  if (trendCounter && !hasCHoCH) return null;

  // Minimum 3 confluences required
  if (score < 3) return null;

  // --- Entry, SL, TP ---
  const detectedTimeframe = detectTimeframe(candles);
  const atrBufferMultiplier = ATR_CONFIG.useDynamic
    ? getAtrMultiplier(symbol, detectedTimeframe)
    : (ATR_MULTIPLIERS[symbol] ?? 0.5);
  const atrBuffer = lastATR * atrBufferMultiplier;
  const spread = getSpread(symbol);
  let entry, sl, tp1, tp2;

  if (type === 'LONG') {
    const techEntry = lastClose;
    let techSl = zoneBottom - atrBuffer;
    
    // Enforce minimum Stop Loss distance to prevent micro-stops and invalid trades
    const minSlDist = lastATR * 0.5;
    if (techSl >= techEntry - minSlDist) {
      techSl = techEntry - minSlDist;
    }
    
    // Spread adjustment:
    // LONG enters at Ask price = techEntry + spread.
    // SL is at Bid price = techSl.
    entry = techEntry + spread;
    sl = techSl;
    
    const risk = entry - sl;
    tp1 = entry + risk * 2; // 1:2 R:R
    tp2 = entry + risk * 3; // 1:3 R:R

    // Try to target next swing high for better TP
    const nextSwingHigh = structure.swingHighs
      .filter(sh => sh.price > entry)
      .sort((a, b) => a.price - b.price)[0];
    // Only pull TP1 up to a nearer swing high — never beyond TP2, otherwise TP1
    // and TP2 invert and the partial close books profit at an unreached price.
    if (nextSwingHigh && nextSwingHigh.price >= tp1 && nextSwingHigh.price < tp2) {
      tp1 = nextSwingHigh.price;
    }

    // Structure-based TP2: extend the final target to the next swing high beyond the
    // 1:3 level (capped at 6R) so we aim for real liquidity, not a fixed multiple.
    const tp2Cap = entry + risk * 6;
    const swingHighTP2 = structure.swingHighs
      .filter(sh => sh.price >= tp2 && sh.price <= tp2Cap)
      .sort((a, b) => a.price - b.price)[0];
    if (swingHighTP2) tp2 = swingHighTP2.price;
  } else {
    const techEntry = lastClose;
    let techSl = zoneTop + atrBuffer;
    
    // Enforce minimum Stop Loss distance to prevent micro-stops and invalid trades
    const minSlDist = lastATR * 0.5;
    if (techSl <= techEntry + minSlDist) {
      techSl = techEntry + minSlDist;
    }
    
    // Spread adjustment:
    // SHORT enters at Bid price = techEntry.
    // SL is at Ask price = techSl + spread.
    entry = techEntry;
    sl = techSl + spread;
    
    const risk = sl - entry;
    tp1 = entry - risk * 2;
    tp2 = entry - risk * 3;

    // Try to target next swing low
    const nextSwingLow = structure.swingLows
      .filter(sl => sl.price < entry)
      .sort((a, b) => b.price - a.price)[0];
    // Only pull TP1 down to a nearer swing low — never beyond TP2 (see LONG note).
    if (nextSwingLow && nextSwingLow.price <= tp1 && nextSwingLow.price > tp2) {
      tp1 = nextSwingLow.price;
    }

    // Structure-based TP2: extend down to the next swing low beyond the 1:3 level (capped 6R).
    const tp2Cap = entry - risk * 6;
    const swingLowTP2 = structure.swingLows
      .filter(sl => sl.price <= tp2 && sl.price >= tp2Cap)
      .sort((a, b) => b.price - a.price)[0];
    if (swingLowTP2) tp2 = swingLowTP2.price;
  }

  // Experiment (anti-chase): reject when price has already run too far from the
  // zone this setup is based on. Entry = current close, so a large gap means we
  // would be buying/selling well after the bounce, not at the level. Off unless set.
  if (opts.maxEntryDistAtr != null && lastATR > 0) {
    const distToZone = type === 'LONG' ? (entry - zoneTop) : (zoneBottom - entry);
    if (distToZone > opts.maxEntryDistAtr * lastATR) return null;
  }

  // Validate R:R ≥ 1:2
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp1 - entry);
  const rrRatio = risk > 0 ? reward / risk : 0;
  if (rrRatio < 2) return null;

  // --- Lot size ---
  let lotData;
  try {
    lotData = calculateLotSize(symbol, entry, sl, lastClose);
  } catch {
    // Unknown symbol — fallback
    lotData = { lots: 0.01, riskAmount: MAX_RISK, slDistance: risk, slPips: risk };
  }

  // Quality grade
  const quality = score >= 5 ? 'A' : score >= 4 ? 'B' : 'C';

  return {
    type,
    symbol,
    time: candles[candles.length - 1].time,
    entry: round(entry, 5),
    sl: round(sl, 5),
    tp1: round(tp1, 5),
    tp2: round(tp2, 5),
    lotSize: lotData.lots,
    riskAmount: lotData.riskAmount,
    slPips: lotData.slPips,
    rrRatio: Math.round(rrRatio * 100) / 100,
    quality,
    confluences,
    score,
  };
}

/**
 * Remove duplicate signals that are within 1 ATR of each other.
 * Keeps the one with the highest score.
 *
 * @param {Signal[]} signals
 * @param {number} atrVal
 * @returns {Signal[]}
 */
function deduplicateSignals(signals, atrVal) {
  if (signals.length <= 1) return signals;

  // Sort by score descending so we keep the best
  const sorted = [...signals].sort((a, b) => b.score - a.score);
  const kept = [];

  for (const sig of sorted) {
    const isDup = kept.some(
      s => s.type === sig.type && Math.abs(s.entry - sig.entry) < atrVal
    );
    if (!isDup) kept.push(sig);
  }

  return kept;
}

/**
 * Round a number to a given number of decimal places.
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
