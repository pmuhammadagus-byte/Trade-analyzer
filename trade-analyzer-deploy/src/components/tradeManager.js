import { sendTelegramMessage } from '../data/telegramNotifier.js';

// Spread configuration
export function getSpread(symbol) {
  switch (symbol) {
    case 'BTCUSDT': return 25.0;
    case 'ETHUSDT': return 5.0;
    case 'XAUUSD': return 0.7;
    case 'EURUSD':
    case 'GBPUSD':
    case 'USDCAD':
      return 0.00007; // 0.7 pips
    default:
      return 0;
  }
}

// Commission configuration
export function calculateCommission(symbol, entryPrice, lots) {
  if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') {
    // Crypto: 0.04% per trade = 0.08% round-turn commission
    return 0.0008 * entryPrice * lots;
  } else {
    // Forex/Metals: $5 per lot round-turn commission
    return 5.0 * lots;
  }
}

export class TradeManager {
  constructor({ onDailyLossUpdate, isServer = false, db = null }) {
    this.isServer = isServer;
    this.db = db;
    this.onDailyLossUpdate = onDailyLossUpdate;
    
    this.activeTrades = [];
    this.tradeHistory = [];
    this.dailyLosses = 0;
    this.accountBalance = 5000.0;
    this.lastExecutedCandleTime = {};
    this.lastClosedTime = {};
    this.lastResetDate = new Date().toDateString();
  }

  /**
   * Add a trade from a signal
   */
  async takeTrade(signal, candleTime = null) {
    if (!this.isServer) {
      try {
        const response = await fetch('/api/take-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signal }),
        });
        const result = await response.json();
        if (result.success && result.trade) {
          console.log('[Client TradeManager] Trade submitted successfully to server:', result.trade);
          if (globalThis.syncTerminalState) await globalThis.syncTerminalState();
          return result.trade;
        }
      } catch (err) {
        console.error('[Client TradeManager] Failed to submit trade to server:', err);
      }
      return null;
    }

    this._checkDailyReset();
    
    // Exclude if already running an active trade on this symbol
    const active = this.activeTrades.some(t => t.symbol === signal.symbol && t.status === 'active');
    if (active) return null;

    // Exclude if the symbol is in a 10-minute cooldown
    if (this.isSymbolCoolingDown(signal.symbol)) {
      console.warn(`[TradeManager] Cannot take trade on ${signal.symbol}: cooling down.`);
      return null;
    }

    const spread = getSpread(signal.symbol);
    const commission = calculateCommission(signal.symbol, signal.entry, signal.lotSize);

    // Entry price is pre-adjusted for spread during signal generation
    const entryPrice = signal.entry;

    const trade = {
      // Non-colliding dynamic ID prevents duplicate entries on rapid executions
      id: Date.now() + Math.floor(Math.random() * 100000),
      type: signal.type,
      symbol: signal.symbol,
      entry: entryPrice,
      sl: signal.sl,
      tp1: signal.tp1,
      tp2: signal.tp2,
      lotSize: signal.lotSize,
      riskAmount: signal.riskAmount,
      time: Date.now(),
      // Initial current price: LONG trades exit at Bid (signal.entry), SHORT trades exit at Ask (signal.entry + spread)
      currentPrice: signal.type === 'LONG' ? signal.entry : signal.entry + spread,
      pnl: 0,
      currentRR: 0,
      commission: commission,
      status: 'active',
      slMoved: false,
      quality: signal.quality || 'A',
      initialRiskDist: Math.abs(signal.entry - signal.sl),
    };

    // Debit commission immediately from the closed balance
    this.accountBalance -= commission;
    this._saveAccountBalance();

    this.activeTrades.push(trade);
    this._saveActiveTrades();

    // Record execution candle time to block same-candle re-entry
    if (candleTime) {
      this.lastExecutedCandleTime[signal.symbol] = candleTime;
      this._saveLastExecutedCandleTime();
    }

    // Send Telegram Entry Notification
    const decs = this._getDecimals(trade.symbol);
    const confluencesHtml = signal.confluences && signal.confluences.length > 0 
      ? signal.confluences.map(c => `• ${c}`).join('\n')
      : '• Smart Money Confluence Setup';

    const msg = `🚨 <b>NEW AUTOPILOT TRADE EXECUTED</b>\n\n` +
      `<b>Setup Quality:</b> <code>Grade ${trade.quality} Setup</code>\n` +
      `<b>Symbol:</b> <code>${trade.symbol}</code>\n` +
      `<b>Direction:</b> <code>${trade.type}</code>\n` +
      `<b>Lot Size:</b> <code>${trade.lotSize.toFixed(2)} lots</code>\n` +
      `<b>Entry Price:</b> <code>$${trade.entry.toFixed(decs)}</code>\n` +
      `<b>Stop Loss (SL):</b> <code>$${trade.sl.toFixed(decs)}</code>\n` +
      `<b>Take Profit 1 (TP1):</b> <code>$${trade.tp1.toFixed(decs)}</code>\n` +
      `<b>Take Profit 2 (TP2):</b> <code>$${trade.tp2.toFixed(decs)}</code>\n\n` +
      `📊 <b>Risk Configuration:</b>\n` +
      `• <b>Expected Risk:</b> <code>$${trade.riskAmount.toFixed(2)}</code> (FundingPips Compliant)\n` +
      `• <b>Stop Loss Distance:</b> <code>${Math.abs(trade.entry - trade.sl).toFixed(decs)} price units</code>\n\n` +
      `💡 <b>Trade Confluences Scanned:</b>\n${confluencesHtml}`;

    sendTelegramMessage(msg);

    return trade;
  }

  /**
   * Update all trades with current prices
   */
  updatePrices(currentPrice, symbol) {
    this._checkDailyReset();
    const spread = getSpread(symbol);

    for (const trade of this.activeTrades) {
      if (trade.symbol !== symbol) continue;
      if (trade.status !== 'active') continue; // Skip already closed trades in memory loop

      // SHORT trades exit/value at Ask price (Bid + Spread)
      const valuationPrice = trade.type === 'SHORT' ? currentPrice + spread : currentPrice;
      trade.currentPrice = valuationPrice;

      const direction = trade.type === 'LONG' ? 1 : -1;
      const priceDiff = (valuationPrice - trade.entry) * direction;
      const slDist = trade.initialRiskDist || Math.abs(trade.entry - trade.sl);

      // Calculate total P&L (realized + remaining)
      const remainingPnL = this._calculatePnL(trade, valuationPrice);
      // Net of commission so per-trade P&L matches the actual balance impact.
      trade.pnl = (trade.realizedPnL || 0) + remainingPnL - (trade.commission || 0);
      
      // Guard against micro-stop division anomalies in older trades
      let minThreshold = 0.00005; // half a pip for Forex
      if (trade.symbol === 'BTCUSDT' || trade.symbol === 'ETHUSDT') {
        minThreshold = 0.1; // 10 cents for crypto
      } else if (trade.symbol === 'XAUUSD') {
        minThreshold = 0.05; // 5 cents for gold
      }

      trade.currentRR = slDist >= minThreshold ? priceDiff / slDist : 0;

      // Only the authoritative server engine opens/closes positions. The browser
      // client is display-only (refreshed from the server every few seconds), so
      // it must never close trades or mutate balance/history locally.
      if (!this.isServer) continue;

      // Check auto SL/TP hit or partial close at TP1. Closes fill at the EXACT
      // SL/TP level (not an overshooting tick) so realized risk stays bounded.
      if (trade.type === 'LONG') {
        if (valuationPrice <= trade.sl) {
          const reason = trade.partialClosed ? 'Trailing Stop' : 'SL Hit';
          this._closeTrade(trade, reason, trade.sl);
        } else if (valuationPrice >= trade.tp2) {
          if (!trade.partialClosed) {
            this._triggerPartialClose(trade, trade.tp1);
          }
          this._closeTrade(trade, 'TP2 Hit', trade.tp2);
        } else if (valuationPrice >= trade.tp1 && !trade.partialClosed) {
          this._triggerPartialClose(trade, trade.tp1);
        }
      } else {
        if (valuationPrice >= trade.sl) {
          const reason = trade.partialClosed ? 'Trailing Stop' : 'SL Hit';
          this._closeTrade(trade, reason, trade.sl);
        } else if (valuationPrice <= trade.tp2) {
          if (!trade.partialClosed) {
            this._triggerPartialClose(trade, trade.tp1);
          }
          this._closeTrade(trade, 'TP2 Hit', trade.tp2);
        } else if (valuationPrice <= trade.tp1 && !trade.partialClosed) {
          this._triggerPartialClose(trade, trade.tp1);
        }
      }
    }
    this._render();
  }

  /**
   * Update exit analysis from the exit manager
   */
  updateExitAnalysis(tradeId, analysis) {
    const trade = this.activeTrades.find(t => t.id === tradeId);
    if (!trade || !analysis || trade.status !== 'active') return; // Guard against updating closed trades

    if (analysis.warnings && analysis.warnings.length > 0) {
      trade.warnings = analysis.warnings;
    } else {
      trade.warnings = [];
    }

    if (analysis.suggestion) {
      trade.suggestion = analysis.suggestion;
      trade.suggestionText = analysis.reason;
    } else {
      trade.suggestion = null;
      trade.suggestionText = null;
    }

    // Apply a trailed stop on the runner (ratchet only — never loosen, never cross
    // back to the loss side of breakeven). Authoritative on the server engine.
    if (analysis.newSL != null && trade.partialClosed && this.isServer) {
      const better = trade.type === 'LONG'
        ? (analysis.newSL > trade.sl && analysis.newSL >= trade.entry)
        : (analysis.newSL < trade.sl && analysis.newSL <= trade.entry);
      if (better) {
        trade.sl = analysis.newSL;
        trade.slMoved = true;
        this._saveActiveTrades();
      }
    }

    // Warnings/suggestions are ephemeral display state recomputed every tick, so
    // just re-render — no need to write them to the database on every tick.
    this._render();
  }

  _generatePostMortem(trade) {
    const decs = this._getDecimals(trade.symbol);
    const lines = [];

    // Factual invalidation summary — no fabricated narrative.
    lines.push(`• <b>Invalidation:</b> Price hit the Stop Loss at <code>$${trade.sl.toFixed(decs)}</code> (exit <code>$${(trade.exitPrice ?? trade.sl).toFixed(decs)}</code>), invalidating the ${trade.type} setup.`);

    if (trade.partialClosed) {
      const realized = trade.realizedPnL || 0;
      lines.push(`• <b>Partial Banked First:</b> TP1 was reached — 70% closed for <code>+$${realized.toFixed(2)}</code> before the runner was stopped, so this was not a full-risk loss.`);
    }

    // Real warning signals the exit analyser flagged before the stop (from analyzeExit).
    if (Array.isArray(trade.warnings) && trade.warnings.length > 0) {
      lines.push(`• <b>Warning signs flagged before the stop:</b>`);
      for (const w of trade.warnings) lines.push(`   – ${w}`);
    } else {
      lines.push(`• <b>No reversal warnings were flagged</b> before the stop — price simply traded to the predefined invalidation level.`);
    }

    return lines.join('\n');
  }

  _closeTrade(trade, reason, exitPriceOverride = null) {
    if (trade.status === 'closed') return; // Double close safety lock guard
    trade.status = 'closed';
    trade.closeReason = reason;
    trade.closeTime = Date.now();
    // Fill at the exact SL/TP level when provided, so realized P&L matches the
    // intended risk instead of an overshooting live tick.
    trade.exitPrice = (exitPriceOverride !== null) ? exitPriceOverride : trade.currentPrice;

    // Record close time to trigger 10-minute cooldown
    this.lastClosedTime[trade.symbol] = Date.now();
    this._saveLastClosedTime();

    // Credit/debit ONLY the remaining portion P&L to balance
    const remainingPnL = this._calculatePnL(trade, trade.exitPrice);
    this.accountBalance += remainingPnL;
    this._saveAccountBalance();

    // Final P&L = realized partial + remaining portion, NET of commission (so stats,
    // win/loss counts and the Telegram "Net Realized P&L" are actually net).
    trade.pnl = (trade.realizedPnL || 0) + remainingPnL - (trade.commission || 0);

    if (trade.pnl < 0) {
      this.dailyLosses++;
      this._saveDailyLosses();
      if (this.onDailyLossUpdate) {
        this.onDailyLossUpdate(this.dailyLosses);
      }
    }

    this.tradeHistory.push({ ...trade });
    this.activeTrades = this.activeTrades.filter(t => t.id !== trade.id);
    this._saveActiveTrades();
    this._saveTradeHistory();

    // Send Telegram Exit Notification
    const decs = this._getDecimals(trade.symbol);
    const profitSign = trade.pnl >= 0 ? '+' : '';
    let postMortemHtml = '';
    
    if (reason.includes('SL Hit')) {
      postMortemHtml = `\n\n🔍 <b>Smart Post-Mortem Audit (What went wrong?):</b>\n` + this._generatePostMortem(trade);
    }

    const header = trade.pnl >= 0
      ? `🏁 <b>TRADE CLOSED (${reason.toUpperCase()})</b>`
      : `❌ <b>TRADE CLOSED (${reason.toUpperCase()})</b>`;

    const msg = `${header}\n\n` +
      `<b>Symbol:</b> <code>${trade.symbol}</code>\n` +
      `<b>Exit Price:</b> <code>$${trade.exitPrice.toFixed(decs)}</code>\n` +
      `<b>Exit Reason:</b> <code>${trade.closeReason}</code>\n` +
      `<b>Net Realized P&amp;L:</b> <code>${profitSign}$${trade.pnl.toFixed(2)}</code>\n\n` +
      `📈 <b>Account Update:</b>\n` +
      `• <b>New Balance:</b> <code>$${this.accountBalance.toFixed(2)}</code>\n` +
      `• <b>Status:</b> Position fully liquidated. Cooldown period active for 10 minutes.${postMortemHtml}`;

    sendTelegramMessage(msg);

    this._render();
  }

  /**
   * Manually close a trade
   */
  async manualClose(tradeId) {
    if (!this.isServer) {
      try {
        const response = await fetch('/api/manual-close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tradeId }),
        });
        const result = await response.json();
        if (result.success) {
          console.log(`[Client TradeManager] Close requested for trade ${tradeId}.`);
          if (globalThis.syncTerminalState) await globalThis.syncTerminalState();
        }
      } catch (err) {
        console.error(`[Client TradeManager] Failed to close trade ${tradeId}:`, err);
      }
      return;
    }

    const trade = this.activeTrades.find(t => t.id === tradeId);
    if (trade) {
      this._closeTrade(trade, 'Manual Close');
    }
  }


  _calculatePnL(trade, currentPrice) {
    return this._calculatePnLForLots(trade, currentPrice, trade.lotSize);
  }

  _calculatePnLForLots(trade, currentPrice, lotSize) {
    const direction = trade.type === 'LONG' ? 1 : -1;
    const diff = (currentPrice - trade.entry) * direction;
    const sym = trade.symbol;

    if (sym === 'BTCUSDT' || sym === 'ETHUSDT') {
      return diff * lotSize;
    } else if (sym === 'XAUUSD') {
      return diff * lotSize * 100;
    } else if (sym === 'EURUSD' || sym === 'GBPUSD') {
      return (diff / 0.0001) * lotSize * 10;
    } else if (sym === 'USDCAD') {
      return (diff / 0.0001) * lotSize * (10 / currentPrice);
    }
    return 0;
  }

  _triggerPartialClose(trade, exitPrice) {
    if (trade.partialClosed) return;

    const partialLotSize = trade.lotSize * 0.7;
    const partialPnL = this._calculatePnLForLots(trade, exitPrice, partialLotSize);

    trade.realizedPnL = (trade.realizedPnL || 0) + partialPnL;

    // Credit realized partial P&L to account balance
    this.accountBalance += partialPnL;
    this._saveAccountBalance();

    // Reduce remaining lot size by 70% (leaving 30% active)
    trade.lotSize = trade.lotSize * 0.3;
    trade.partialClosed = true;
    trade.partialExitPrice = exitPrice;
    trade.partialExitTime = Date.now();

    // Trail Stop Loss to Breakeven (entry price) to secure a risk-free trade
    trade.sl = trade.entry;
    trade.slMoved = true;

    // Persist the reduced lot size + breakeven SL right away so a server restart
    // between the partial and the final close keeps the correct state.
    this._saveActiveTrades();

    trade.suggestion = 'MOVE_SL';
    trade.suggestionText = `TP1 reached — 70% quantity closed at $${exitPrice.toFixed(this._getDecimals(trade.symbol))} (+$${partialPnL.toFixed(2)}). SL moved to Breakeven.`;

    console.log(`[TradeManager] 70% Partial close triggered for ${trade.symbol} at $${exitPrice}: realized +$${partialPnL.toFixed(2)}. SL moved to Breakeven ($${trade.entry}).`);

    // Send Telegram TP1 Partial Close Notification
    const decs = this._getDecimals(trade.symbol);
    const msg = `💰 <b>TP1 PARTIAL CLOSE REACHED</b>\n\n` +
      `<b>Symbol:</b> <code>${trade.symbol}</code>\n` +
      `<b>Target Hit:</b> TP1 reached at <code>$${exitPrice.toFixed(decs)}</code>\n` +
      `<b>Realized Profit:</b> <code>+$${partialPnL.toFixed(2)}</code>\n\n` +
      `📦 <b>Volume Realization Details:</b>\n` +
      `• <b>Closed Quantity (70%):</b> <code>${partialLotSize.toFixed(2)} lots</code>\n` +
      `• <b>Remaining Quantity (30%):</b> <code>${trade.lotSize.toFixed(2)} lots</code>\n\n` +
      `🛡️ <b>Risk-Free Status Active:</b>\n` +
      `• Stop Loss has been automatically trailed to <b>Breakeven</b> (<code>$${trade.entry.toFixed(decs)}</code>).\n` +
      `• Maximum risk on this position is now <code>$0.00</code>.`;

    sendTelegramMessage(msg);
  }

  
  _render() {
    if (this.isServer) return;
    const list = document.getElementById('trade-list');
    if (!list) return;

    if (this.activeTrades.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🎯</span>
          <p>No active trades</p>
        </div>`;
      return;
    }

    list.innerHTML = this.activeTrades.map(trade => {
      const isPositive = trade.pnl >= 0;
      const decimals = this._getDecimals(trade.symbol);

      return `
        <div class="trade-card" id="trade-${trade.id}">
          <div class="signal-header">
            <span class="signal-direction ${trade.type.toLowerCase()}">
              ${trade.type} ${trade.symbol}
              ${trade.partialClosed ? '<span class="partial-badge" style="font-size: 0.62rem; padding: 1px 4px; background: rgba(59, 130, 246, 0.2); color: var(--accent-cyan); border-radius: 4px; margin-left: 6px; border: 1px solid rgba(59, 130, 246, 0.3);">70% exit</span>' : ''}
              <span class="signal-quality grade-${(trade.quality || 'A').toLowerCase()}" style="font-size: 0.6rem; border-width: 1px; width: 15px; height: 15px; margin-left: 6px; display: inline-flex; vertical-align: middle; align-items: center; justify-content: center;">${trade.quality || 'A'}</span>
            </span>
            <span class="trade-pnl ${isPositive ? 'positive' : 'negative'}">
              ${isPositive ? '+' : ''}$${trade.pnl.toFixed(2)}
            </span>
          </div>
          <div class="signal-levels" style="margin-top: 8px;">
            <div class="signal-level">
              <span class="signal-level-label">Entry</span>
              <span class="signal-level-value entry">${trade.entry.toFixed(decimals)}</span>
            </div>
            <div class="signal-level">
              <span class="signal-level-label">Current</span>
              <span class="signal-level-value" style="color: ${isPositive ? 'var(--bullish)' : 'var(--bearish)'}">
                ${trade.currentPrice.toFixed(decimals)}
              </span>
            </div>
            <div class="signal-level">
              <span class="signal-level-label">SL</span>
              <span class="signal-level-value sl">${trade.sl.toFixed(decimals)}</span>
            </div>
            <div class="signal-level">
              <span class="signal-level-label">TP2</span>
              <span class="signal-level-value tp">${trade.tp2.toFixed(decimals)}</span>
            </div>
            <div class="signal-level">
              <span class="signal-level-label">R:R</span>
              <span class="signal-level-value" style="color: var(--accent-cyan)">${trade.currentRR.toFixed(2)}</span>
            </div>
            <div class="signal-level">
              <span class="signal-level-label">Lots</span>
              <span class="signal-level-value lots">${trade.lotSize.toFixed(2)}</span>
            </div>
          </div>
          ${trade.suggestion ? `
            <div class="trade-suggestion ${this._suggestionClass(trade.suggestion)}">
              💡 ${trade.suggestionText || trade.suggestion}
            </div>
          ` : ''}
          ${trade.warnings && trade.warnings.length > 0 ? `
            <div class="trade-suggestion warning">
              ⚠️ ${trade.warnings[0]}
            </div>
          ` : ''}
          <div class="signal-actions" style="margin-top: 8px;">
            <button class="btn btn-danger btn-sm btn-close-trade" data-trade-id="${trade.id}">
              Close Trade
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Attach close listeners
    list.querySelectorAll('.btn-close-trade').forEach(btn => {
      btn.addEventListener('click', () => {
        this.manualClose(parseInt(btn.dataset.tradeId));
      });
    });
  }

  _suggestionClass(suggestion) {
    switch (suggestion) {
      case 'HOLD': return 'hold';
      case 'PARTIAL_CLOSE': return 'partial';
      case 'CLOSE': return 'close';
      case 'MOVE_SL': return 'hold';
      default: return 'hold';
    }
  }

  _getDecimals(symbol) {
    if (symbol === 'XAUUSD') return 2;
    if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') return 2;
    return 5;
  }

  getDailyLosses() {
    return this.dailyLosses;
  }

  shouldStopTrading() {
    this._checkDailyReset();
    return false; // Removed 3 daily losses limit - trade anytime
  }

  _checkDailyReset() {
    const today = new Date().toDateString();
    if (this.isServer) {
      if (this.lastResetDate !== today) {
        console.log(`[Server TradeManager] Midnight system date rollover detected. Resetting losses count to 0.`);
        this.dailyLosses = 0;
        this.lastResetDate = today;
        this._saveDailyLosses();
        if (this.onDailyLossUpdate) {
          this.onDailyLossUpdate(0);
        }
      }
      return;
    }

    const stored = localStorage.getItem('tradeAnalyzer_dailyLosses');
    let storedDate = today;
    if (stored) {
      const data = JSON.parse(stored);
      storedDate = data.date;
    }

    if (storedDate !== today) {
      console.log(`[TradeManager] Midnight system date rollover detected. Resetting losses count to 0.`);
      this.dailyLosses = 0;
      this._saveDailyLosses();
      if (this.onDailyLossUpdate) {
        this.onDailyLossUpdate(0);
      }
      const overlay = document.getElementById('daily-stop-overlay');
      if (overlay) overlay.classList.add('hidden');
    }
  }

  _loadDailyLosses() {
    if (this.isServer) return this.dailyLosses;
    const today = new Date().toDateString();
    const stored = localStorage.getItem('tradeAnalyzer_dailyLosses');
    if (stored) {
      const data = JSON.parse(stored);
      if (data.date === today) return data.count;
    }
    return 0;
  }

  _saveDailyLosses() {
    if (this.isServer) {
      if (this.db) this.db.saveDailyLosses(this.dailyLosses, this.lastResetDate);
    } else {
      localStorage.setItem('tradeAnalyzer_dailyLosses', JSON.stringify({
        date: new Date().toDateString(),
        count: this.dailyLosses,
      }));
    }
  }

  resetDailyLosses() {
    this.dailyLosses = 0;
    this._saveDailyLosses();
    if (!this.isServer && this.onDailyLossUpdate) {
      this.onDailyLossUpdate(0);
    }
  }

  _loadActiveTrades() {
    if (this.isServer) return this.activeTrades;
    const stored = localStorage.getItem('tradeAnalyzer_activeTrades');
    return stored ? JSON.parse(stored) : [];
  }

  _saveActiveTrades() {
    if (this.isServer) {
      if (this.db) this.db.saveActiveTrades(this.activeTrades);
    } else {
      localStorage.setItem('tradeAnalyzer_activeTrades', JSON.stringify(this.activeTrades));
    }
  }

  _loadTradeHistory() {
    if (this.isServer) return this.tradeHistory;
    const stored = localStorage.getItem('tradeAnalyzer_tradeHistory');
    return stored ? JSON.parse(stored) : [];
  }

  _saveTradeHistory() {
    if (this.isServer) {
      if (this.db) this.db.saveTradeHistory(this.tradeHistory);
    } else {
      localStorage.setItem('tradeAnalyzer_tradeHistory', JSON.stringify(this.tradeHistory));
    }
  }

  getSymbolStats() {
    const stats = {};
    const symbols = ['BTCUSDT', 'XAUUSD', 'GBPUSD', 'USDCAD'];
    for (const sym of symbols) {
      stats[sym] = {
        total: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        profit: 0,
        grossProfit: 0,
        grossLoss: 0,
        profitFactor: 0,
      };
    }

    for (const trade of this.tradeHistory) {
      const sym = trade.symbol;
      if (!stats[sym]) continue;

      stats[sym].total++;
      stats[sym].profit += trade.pnl;

      if (trade.pnl >= 0) {
        stats[sym].wins++;
        stats[sym].grossProfit += trade.pnl;
      } else {
        stats[sym].losses++;
        stats[sym].grossLoss += Math.abs(trade.pnl);
      }
    }

    for (const sym of symbols) {
      const s = stats[sym];
      s.winRate = s.total > 0 ? (s.wins / s.total) * 100 : 0;
      s.profitFactor = s.grossLoss > 0 ? s.grossProfit / s.grossLoss : s.grossProfit > 0 ? 99.9 : 0;
    }

    return stats;
  }
  _loadAccountBalance() {
    if (this.isServer) return this.accountBalance;
    const stored = localStorage.getItem('tradeAnalyzer_accountBalance');
    if (stored) {
      const val = parseFloat(stored);
      if (!isNaN(val)) return val;
    }
    return 5000.0;
  }

  _saveAccountBalance() {
    if (this.isServer) {
      if (this.db) this.db.saveAccountBalance(this.accountBalance);
    } else {
      localStorage.setItem('tradeAnalyzer_accountBalance', this.accountBalance.toString());
    }
  }

  getAccountSummary() {
    let unrealizedPnL = 0;
    for (const trade of this.activeTrades) {
      unrealizedPnL += this._calculatePnL(trade, trade.currentPrice);
    }
    return {
      balance: this.accountBalance,
      equity: this.accountBalance + unrealizedPnL,
    };
  }

  async resetAccount() {
    if (!this.isServer) {
      try {
        const response = await fetch('/api/reset-account', { method: 'POST' });
        const result = await response.json();
        if (result.success) {
          console.log('[Client TradeManager] Account reset successfully on server.');
          if (globalThis.syncTerminalState) await globalThis.syncTerminalState();
        }
      } catch (err) {
        console.error('[Client TradeManager] Failed to reset account on server:', err);
      }
      return;
    }

    this.accountBalance = 5000.0;
    this._saveAccountBalance();
    this.resetDailyLosses();
    this.activeTrades = [];
    this._saveActiveTrades();
    this.tradeHistory = [];
    this._saveTradeHistory();
    
    // Clear cooldowns and executions on reset
    this.lastExecutedCandleTime = {};
    this.lastClosedTime = {};
    this._saveLastExecutedCandleTime();
    this._saveLastClosedTime();
  }

  wasAlreadyExecuted(symbol, candleTime) {
    return this.lastExecutedCandleTime[symbol] === candleTime;
  }

  isSymbolCoolingDown(symbol) {
    const closedTime = this.lastClosedTime[symbol];
    if (!closedTime) return false;
    const elapsed = Date.now() - closedTime;
    return elapsed < 10 * 60 * 1000; // 10 minutes cooldown
  }

  _loadLastExecutedCandleTime() {
    if (this.isServer) return this.lastExecutedCandleTime;
    const stored = localStorage.getItem('tradeAnalyzer_lastExecutedCandleTime');
    return stored ? JSON.parse(stored) : {};
  }

  _saveLastExecutedCandleTime() {
    if (this.isServer) {
      if (this.db) this.db.saveLastExecutedCandleTime(this.lastExecutedCandleTime);
    } else {
      localStorage.setItem('tradeAnalyzer_lastExecutedCandleTime', JSON.stringify(this.lastExecutedCandleTime));
    }
  }

  _loadLastClosedTime() {
    if (this.isServer) return this.lastClosedTime;
    const stored = localStorage.getItem('tradeAnalyzer_lastClosedTime');
    return stored ? JSON.parse(stored) : {};
  }

  _saveLastClosedTime() {
    if (this.isServer) {
      if (this.db) this.db.saveLastClosedTime(this.lastClosedTime);
    } else {
      localStorage.setItem('tradeAnalyzer_lastClosedTime', JSON.stringify(this.lastClosedTime));
    }
  }
}

export default TradeManager;

