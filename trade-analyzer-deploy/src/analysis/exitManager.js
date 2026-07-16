/**
 * @module exitManager
 * Exit analysis and trade management suggestions.
 * Operates on arrays of candle objects: { time, open, high, low, close, volume }
 */

import { detectStructure } from './marketStructure.js';
import { rsi, ema, macd } from './indicators.js';

/**
 * Contract specs mirrored from signalGenerator for P&L calculation.
 * @type {Record<string, { type: string, pipValue: number|null, pipSize: number }>}
 */
const CONTRACT_SPECS = {
  BTCUSDT:  { type: 'crypto',      pipValue: 1,    pipSize: 1 },
  XAUUSD:   { type: 'commodity',   pipValue: 100,  pipSize: 1 },
  GBPUSD:   { type: 'forex',       pipValue: 10,   pipSize: 0.0001 },
  USDCAD:   { type: 'forex_quote', pipValue: null,  pipSize: 0.0001 },
};

/**
 * @typedef {Object} Trade
 * @property {'LONG'|'SHORT'} type
 * @property {number} entry
 * @property {number} sl
 * @property {number} tp1
 * @property {number} tp2
 * @property {number} lotSize
 * @property {string} symbol
 */

/**
 * @typedef {Object} ExitAnalysis
 * @property {number}  currentPnL     - Unrealised P&L in dollars.
 * @property {number}  currentRR      - Current R:R achieved.
 * @property {'HOLD'|'PARTIAL_CLOSE'|'CLOSE'|'MOVE_SL'} suggestion
 * @property {string}  reason
 * @property {number|null} newSL      - Suggested new SL if MOVE_SL.
 * @property {string[]} warnings
 */

/**
 * Analyse an open trade and suggest exit management.
 *
 * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }[]} candles
 * @param {Trade} trade
 * @returns {ExitAnalysis}
 */
/**
 * Get spread in price for a symbol
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

export function analyzeExit(candles, trade) {
  const defaultResult = {
    currentPnL: 0,
    currentRR: 0,
    suggestion: /** @type {const} */ ('HOLD'),
    reason: 'Insufficient data.',
    newSL: null,
    warnings: [],
  };

  if (!candles || candles.length < 20 || !trade) return defaultResult;

  let currentPrice = candles[candles.length - 1].close;
  const spread = getSpread(trade.symbol);
  if (trade.type === 'SHORT') {
    currentPrice += spread; // SHORT positions value/exit at the Ask price
  }
  const direction = trade.type === 'LONG' ? 1 : -1;

  // --- 1. P&L ---
  const pnl = calculatePnL(trade, currentPrice, trade.symbol);

  // --- 2. Current R:R ---
  const riskDistance = trade.initialRiskDist || Math.abs(trade.entry - trade.sl);
  const moveFromEntry = (currentPrice - trade.entry) * direction;
  
  // Guard against micro-stop division anomalies in older trades
  let minThreshold = 0.00005; // half a pip for Forex
  if (trade.symbol === 'BTCUSDT') {
    minThreshold = 0.1; // 10 cents for crypto
  } else if (trade.symbol === 'XAUUSD') {
    minThreshold = 0.05; // 5 cents for gold
  }

  const currentRR = riskDistance >= minThreshold ? moveFromEntry / riskDistance : 0;

  // --- 3. Suggestion ---
  let suggestion = /** @type {'HOLD'|'PARTIAL_CLOSE'|'CLOSE'|'MOVE_SL'} */ ('HOLD');
  let reason = 'Trade is running. Holding for TP1 target (70% exit) and TP2 target (30% exit).';
  let newSL = /** @type {number|null} */ (null);

  if (trade.partialClosed) {
    // Trail the stop on the runner toward the most recent confirmed swing (ratchet),
    // floored at breakeven so the position can never fall back into a loss.
    try {
      const struct = detectStructure(candles);
      const buf = (trade.initialRiskDist || riskDistance) * 0.2;
      if (trade.type === 'LONG') {
        const lows = struct.swingLows.filter(sw => sw.price < currentPrice - buf);
        const ref = lows.length ? lows[lows.length - 1].price - buf : trade.entry;
        newSL = Math.max(trade.entry, ref);
      } else {
        const highs = struct.swingHighs.filter(sw => sw.price > currentPrice + buf);
        const ref = highs.length ? highs[highs.length - 1].price + buf : trade.entry;
        newSL = Math.min(trade.entry, ref);
      }
    } catch {
      newSL = trade.entry;
    }

    if (currentRR >= 3.0) {
      suggestion = 'CLOSE';
      reason = `Remaining 30% reached the TP2 target (R:R: ${currentRR.toFixed(2)}). Exit the runner.`;
    } else {
      suggestion = 'MOVE_SL';
      const trailed = (trade.type === 'LONG' && newSL > trade.entry) || (trade.type === 'SHORT' && newSL < trade.entry);
      reason = trailed
        ? `70% profit banked. Trailing the stop behind structure to lock in gains on the 30% runner.`
        : `70% profit banked. Stop held at breakeven; holding the 30% runner for TP2.`;
    }
  } else {
    const tp1Reached = trade.type === 'LONG' ? currentPrice >= trade.tp1 : currentPrice <= trade.tp1;
    if (tp1Reached || currentRR >= 2.0) {
      suggestion = 'PARTIAL_CLOSE';
      reason = `Price reached TP1 target (R:R: ${currentRR.toFixed(2)}). Secure 70% partial close and move SL to Breakeven.`;
    } else if (currentRR < 0 && moveFromEntry < 0) {
      suggestion = 'HOLD';
      reason = `Trade is ${Math.abs(currentRR).toFixed(2)}R against you. SL not yet hit.`;
    }
  }

  // --- 4. Warnings ---
  const warnings = [];
  const closes = candles.map(c => c.close);

  // a. CHoCH against trade direction
  try {
    const structure = detectStructure(candles);
    const recentCHoCH = structure.structureBreaks.filter(
      b => b.type === 'CHoCH' && b.index >= candles.length - 10
    );
    for (const ch of recentCHoCH) {
      if (
        (trade.type === 'LONG' && ch.direction === 'bearish') ||
        (trade.type === 'SHORT' && ch.direction === 'bullish')
      ) {
        warnings.push(`CHoCH detected against position at index ${ch.index} — potential reversal`);
      }
    }
  } catch {
    // Structure detection may fail on very short data — ignore
  }

  // b. RSI divergence
  try {
    const rsiValues = rsi(closes);
    const lastRSI = rsiValues[rsiValues.length - 1];
    const prevRSI = rsiValues[rsiValues.length - 6]; // ~5 candles back

    if (!isNaN(lastRSI) && !isNaN(prevRSI)) {
      if (trade.type === 'LONG') {
        // Price making new high but RSI not
        const priceHigher = currentPrice > candles[candles.length - 6]?.close;
        const rsiLower = lastRSI < prevRSI;
        if (priceHigher && rsiLower && lastRSI > 60) {
          warnings.push(`Bearish RSI divergence detected (RSI: ${lastRSI.toFixed(1)})`);
        }
      } else {
        // Price making new low but RSI not
        const priceLower = currentPrice < candles[candles.length - 6]?.close;
        const rsiHigher = lastRSI > prevRSI;
        if (priceLower && rsiHigher && lastRSI < 40) {
          warnings.push(`Bullish RSI divergence detected (RSI: ${lastRSI.toFixed(1)})`);
        }
      }
    }
  } catch {
    // Ignore
  }

  // c. (Opposing S/D zone detection is handled externally — flag if price is far from entry)

  // d. EMA crossover against position
  try {
    const ema9Values = ema(closes, 9);
    const ema21Values = ema(closes, 21);
    const last9 = ema9Values[ema9Values.length - 1];
    const prev9 = ema9Values[ema9Values.length - 2];
    const last21 = ema21Values[ema21Values.length - 1];
    const prev21 = ema21Values[ema21Values.length - 2];

    if (!isNaN(last9) && !isNaN(last21) && !isNaN(prev9) && !isNaN(prev21)) {
      // Bearish crossover: EMA9 was above EMA21 and now crosses below
      if (trade.type === 'LONG' && prev9 > prev21 && last9 < last21) {
        warnings.push('Bearish EMA9/EMA21 crossover — momentum shifting against long');
      }
      // Bullish crossover: EMA9 was below EMA21 and now crosses above
      if (trade.type === 'SHORT' && prev9 < prev21 && last9 > last21) {
        warnings.push('Bullish EMA9/EMA21 crossover — momentum shifting against short');
      }
    }
  } catch {
    // Ignore
  }

  // e. MACD histogram declining (momentum fading)
  try {
    const macdData = macd(closes);
    const hist = macdData.histogram;
    if (hist.length >= 5) {
      const recent = hist.slice(-5).filter(v => !isNaN(v));
      if (recent.length >= 3) {
        let declining = true;
        let inclining = true;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i] >= recent[i - 1]) declining = false;
          if (recent[i] <= recent[i - 1]) inclining = false;
        }

        if (trade.type === 'LONG' && declining && recent[recent.length - 1] > 0) {
          warnings.push('MACD histogram declining — bullish momentum fading');
        }
        if (trade.type === 'SHORT' && inclining && recent[recent.length - 1] < 0) {
          warnings.push('MACD histogram rising — bearish momentum fading');
        }
      }
    }
  } catch {
    // Ignore
  }

  return {
    currentPnL: Math.round(pnl * 100) / 100,
    currentRR: Math.round(currentRR * 100) / 100,
    suggestion,
    reason,
    newSL,
    warnings,
  };
}

/**
 * Calculate dollar P&L for a trade at the current price.
 *
 * @param {Trade} trade
 * @param {number} currentPrice
 * @param {string} symbol
 * @param {number} [currentRate] - Required for USDCAD.
 * @returns {number} P&L in dollars (positive = profit).
 */
export function calculatePnL(trade, currentPrice, symbol, currentRate) {
  const direction = trade.type === 'LONG' ? 1 : -1;
  const priceDiff = currentPrice - trade.entry;

  const spec = CONTRACT_SPECS[symbol];
  if (!spec) {
    // Fallback: assume crypto-style
    return priceDiff * trade.lotSize * direction;
  }

  switch (spec.type) {
    case 'crypto':
      // pnl = (currentPrice - entry) * lots * direction
      return priceDiff * trade.lotSize * direction;

    case 'commodity':
      // XAUUSD: pnl = (currentPrice - entry) * lots * 100 * direction
      return priceDiff * trade.lotSize * 100 * direction;

    case 'forex':
      // EURUSD/GBPUSD: pnl = pips * lots * 10 * direction
      return (priceDiff / spec.pipSize) * trade.lotSize * 10 * direction;

    case 'forex_quote': {
      // USDCAD: pnl = pips * lots * (10/currentRate) * direction
      const rate = currentRate || currentPrice; // fallback to current price as approximation
      return (priceDiff / spec.pipSize) * trade.lotSize * (10 / rate) * direction;
    }

    default:
      return priceDiff * trade.lotSize * direction;
  }
}

/**
 * Check if trading should stop for the day.
 *
 * @param {number} dailyLossCount
 * @returns {{ shouldStop: boolean, message: string }}
 */
export function shouldStopTrading(dailyLossCount) {
  return {
    shouldStop: false,
    message: 'Unlimited trading mode active.',
  };
}
