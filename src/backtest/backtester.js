/**
 * @module backtest/backtester
 * Event-driven, no-look-ahead backtester for the live strategy.
 *
 * Design goals:
 *  - Measure the EXACT strategy that trades live. It reuses `generateSignals`
 *    (entries) and `analyzeExit` (runner trailing) verbatim, plus the same cost
 *    formulas (`getSpread`, `calculateCommission`) and P&L math (`calculatePnL`)
 *    the live `TradeManager` uses. No reimplementation of the edge.
 *  - No look-ahead: at bar i the entry scan only sees candles[0..i].
 *  - Honest fills: SL/TP are detected against each subsequent bar's intrabar
 *    high/low (not a polled close, which the live engine optimistically uses).
 *  - Faithful trade lifecycle: 70% partial at TP1, SL→breakeven, 30% runner to
 *    TP2 with structure trailing — exactly like `TradeManager.updatePrices`.
 *
 * Same-bar ambiguity (a bar spans both SL and a TP) is resolved by `tieBreak`:
 *  - 'pessimistic' (default): assume SL filled first — honest lower bound.
 *  - 'optimistic':  assume the TP filled first — upper bound.
 *  - 'proximity':   assume the level nearer the bar's open filled first.
 */

import { generateSignals } from '../analysis/signalGenerator.js';
import { analyzeExit, calculatePnL } from '../analysis/exitManager.js';
import { getSpread, calculateCommission } from '../components/tradeManager.js';

/**
 * P&L in dollars for an arbitrary lot size at a given fill price.
 * Delegates to the same `calculatePnL` the live engine uses (lot override).
 */
function pnlForLots(trade, fillPrice, lots) {
  return calculatePnL({ ...trade, lotSize: lots }, fillPrice, trade.symbol, fillPrice);
}

/**
 * Decide which level a bar touched first when it spans both.
 * @returns {'sl'|'tp'}
 */
function firstTouch(open, slLevel, tpLevel, mode) {
  if (mode === 'optimistic') return 'tp';
  if (mode === 'proximity') {
    return Math.abs(open - slLevel) <= Math.abs(open - tpLevel) ? 'sl' : 'tp';
  }
  return 'sl'; // pessimistic
}

/** Open a trade from a signal (mirrors TradeManager.takeTrade bookkeeping). */
function openTrade(sig, symbol, candleTime) {
  const commission = calculateCommission(symbol, sig.entry, sig.lotSize);
  return {
    type: sig.type,
    symbol,
    entry: sig.entry,
    sl: sig.sl,
    tp1: sig.tp1,
    tp2: sig.tp2,
    lotSize: sig.lotSize,      // remaining lots (shrinks to 30% after partial)
    initialLots: sig.lotSize,
    riskAmount: sig.riskAmount,
    initialRiskDist: Math.abs(sig.entry - sig.sl),
    commission,
    realizedPnL: 0,
    partialClosed: false,
    slMoved: false,
    quality: sig.quality,
    score: sig.score,
    confluences: sig.confluences,
    entryTime: candleTime,
  };
}

/** Book the 70% partial at TP1 and move SL to breakeven (mirrors _triggerPartialClose). */
function bookPartial(t, exitPrice) {
  const partLots = t.initialLots * 0.7;
  t.realizedPnL += pnlForLots(t, exitPrice, partLots);
  t.lotSize = t.initialLots * 0.3;
  t.partialClosed = true;
  t.partialExitPrice = exitPrice;
  t.sl = t.entry; // breakeven
  t.slMoved = true;
}

/** Finalize a trade and push the record (mirrors _closeTrade accounting). */
function bookClose(t, reason, exitPrice, trades, onClose) {
  const remainingPnL = pnlForLots(t, exitPrice, t.lotSize);
  const grossPnL = (t.realizedPnL || 0) + remainingPnL;
  const netPnL = grossPnL - (t.commission || 0);
  trades.push({
    type: t.type,
    symbol: t.symbol,
    entry: t.entry,
    sl: t.sl,
    tp1: t.tp1,
    tp2: t.tp2,
    initialLots: t.initialLots,
    quality: t.quality,
    score: t.score,
    entryTime: t.entryTime,
    exitTime: exitPrice && t._barTime ? t._barTime : null,
    closeReason: reason,
    exitPrice,
    partialClosed: !!t.partialClosed,
    realizedPnL: t.realizedPnL || 0,
    commission: t.commission || 0,
    grossPnL,
    pnl: netPnL,
    rMultiple: t.initialRiskDist > 0 ? netPnL / (t.riskAmount || 1) : 0,
  });
  onClose();
}

/**
 * Process one bar against an active trade: trailing, then SL/TP fills.
 * Mirrors TradeManager.updatePrices order (SL → TP2 → TP1) with intrabar extremes.
 */
function manageBar(t, bar, hist, tieBreak, trades, onClose) {
  t._barTime = bar.time;
  const spread = getSpread(t.symbol);

  // Runner: trail the stop using the SAME analyzeExit logic the server applies.
  if (t.partialClosed) {
    try {
      const ex = analyzeExit(hist, t);
      if (ex && ex.newSL != null) {
        const better = t.type === 'LONG'
          ? (ex.newSL > t.sl && ex.newSL >= t.entry)
          : (ex.newSL < t.sl && ex.newSL <= t.entry);
        if (better) { t.sl = ex.newSL; t.slMoved = true; }
      }
    } catch { /* structure can fail on short data — ignore */ }
  }

  if (t.type === 'LONG') {
    // LONG values at bid: compare levels directly to the bar's low/high.
    const hitSL = bar.low <= t.sl;
    const hitTP1 = bar.high >= t.tp1;
    const hitTP2 = bar.high >= t.tp2;

    if (!t.partialClosed) {
      if (hitSL && hitTP1) {
        if (firstTouch(bar.open, t.sl, t.tp1, tieBreak) === 'sl') {
          bookClose(t, 'SL Hit', t.sl, trades, onClose); return;
        }
        bookPartial(t, t.tp1);
        if (hitTP2) { bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return; }
        return; // runner continues with SL at breakeven
      }
      if (hitSL) { bookClose(t, 'SL Hit', t.sl, trades, onClose); return; }
      if (hitTP2) { bookPartial(t, t.tp1); bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return; }
      if (hitTP1) { bookPartial(t, t.tp1); return; }
    } else {
      // Runner: SL sits at/above breakeven.
      if (hitSL && hitTP2) {
        if (firstTouch(bar.open, t.sl, t.tp2, tieBreak) === 'sl') {
          bookClose(t, 'Trailing Stop', t.sl, trades, onClose); return;
        }
        bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return;
      }
      if (hitSL) { bookClose(t, 'Trailing Stop', t.sl, trades, onClose); return; }
      if (hitTP2) { bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return; }
    }
  } else {
    // SHORT values at ask (bid + spread): shift the bar extremes by the spread.
    const adverse = bar.high + spread; // toward SL (above)
    const favor = bar.low + spread;    // toward TP (below)
    const hitSL = adverse >= t.sl;
    const hitTP1 = favor <= t.tp1;
    const hitTP2 = favor <= t.tp2;

    if (!t.partialClosed) {
      if (hitSL && hitTP1) {
        if (firstTouch(bar.open + spread, t.sl, t.tp1, tieBreak) === 'sl') {
          bookClose(t, 'SL Hit', t.sl, trades, onClose); return;
        }
        bookPartial(t, t.tp1);
        if (hitTP2) { bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return; }
        return;
      }
      if (hitSL) { bookClose(t, 'SL Hit', t.sl, trades, onClose); return; }
      if (hitTP2) { bookPartial(t, t.tp1); bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return; }
      if (hitTP1) { bookPartial(t, t.tp1); return; }
    } else {
      if (hitSL && hitTP2) {
        if (firstTouch(bar.open + spread, t.sl, t.tp2, tieBreak) === 'sl') {
          bookClose(t, 'Trailing Stop', t.sl, trades, onClose); return;
        }
        bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return;
      }
      if (hitSL) { bookClose(t, 'Trailing Stop', t.sl, trades, onClose); return; }
      if (hitTP2) { bookClose(t, 'TP2 Hit', t.tp2, trades, onClose); return; }
    }
  }
}

/**
 * Backtest one symbol over a candle series.
 *
 * @param {{time:number,open:number,high:number,low:number,close:number,volume:number}[]} candles
 * @param {string} symbol
 * @param {{ warmup?:number, tieBreak?:'pessimistic'|'optimistic'|'proximity', strategyOpts?:object, onProgress?:(i:number,n:number)=>void }} [opts]
 *   strategyOpts is forwarded to generateSignals (e.g. { blockRanging, maxEntryDistAtr }).
 * @returns {{ trades: object[], stats: object }}
 */
export function backtestSymbol(candles, symbol, opts = {}) {
  const warmup = opts.warmup ?? 200; // need EMA200 for trend
  const tieBreak = opts.tieBreak ?? 'pessimistic';
  const trades = [];
  let active = null;

  if (!candles || candles.length <= warmup + 2) {
    return { trades, stats: computeStats(trades, symbol) };
  }

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];

    if (active) {
      // Manage the open trade on this (post-entry) bar. The entry bar itself is
      // never used for fills because the trade was opened on the prior iteration.
      const hist = candles.slice(0, i + 1);
      manageBar(active, bar, hist, tieBreak, trades, () => { active = null; });
      continue; // one position per symbol; also blocks same-candle re-entry
    }

    // Flat: scan for a signal as of bar i (history ends at i — no future data).
    const hist = candles.slice(0, i + 1);
    let signals = generateSignals(hist, symbol, 0, opts.strategyOpts || {});
    signals = signals.filter(s => s.quality === 'A' || s.quality === 'B');
    if (signals.length > 0) {
      active = openTrade(signals[0], symbol, bar.time); // fills begin next bar
    }

    if (opts.onProgress && i % 500 === 0) opts.onProgress(i, candles.length);
  }

  // Mark-to-market any trade still open at the end of the series.
  if (active) {
    active._barTime = candles[candles.length - 1].time;
    const lastClose = candles[candles.length - 1].close;
    bookClose(active, 'End of data', lastClose, trades, () => { active = null; });
  }

  return { trades, stats: computeStats(trades, symbol) };
}

/**
 * Aggregate trade records into performance metrics.
 * @param {object[]} trades
 * @param {string} [symbol]
 */
export function computeStats(trades, symbol = 'ALL') {
  const n = trades.length;
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, totalCommission = 0;
  let bal = 0, peak = 0, maxDD = 0;
  const equityCurve = [];

  for (const t of trades) {
    const p = t.pnl;
    totalCommission += t.commission || 0;
    if (p >= 0) { wins++; grossWin += p; } else { losses++; grossLoss += Math.abs(p); }
    bal += p;
    equityCurve.push(bal);
    peak = Math.max(peak, bal);
    maxDD = Math.max(maxDD, peak - bal);
  }

  const netPnL = grossWin - grossLoss;
  return {
    symbol,
    trades: n,
    wins,
    losses,
    winRate: n ? (wins / n) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    netPnL,
    grossWin,
    grossLoss,
    avgWin: wins ? grossWin / wins : 0,
    avgLoss: losses ? grossLoss / losses : 0,
    expectancy: n ? netPnL / n : 0,
    totalCommission,
    maxDrawdown: maxDD,
    equityCurve,
  };
}
