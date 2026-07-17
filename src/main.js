/**
 * main.js
 * Main entry point of the Trade Analyzer application.
 * Manages states, coordinates UI components, coordinates WebSocket streams,
 * and executes analysis runs.
 */

import DataManager from './data/dataManager.js';
import ChartManager from './chart/chartManager.js';
import Header from './components/header.js';
import SignalPanel from './components/signalPanel.js';
import AnalysisPanel from './components/analysisPanel.js';
import TradeManager from './components/tradeManager.js';

// Import technical analysis tools
import { detectOrderBlocks, updateMitigation } from './analysis/orderBlocks.js';
import { detectZones, updateZoneStatus } from './analysis/supplyDemand.js';
import { detectStructure } from './analysis/marketStructure.js';
import { analyzeTrend } from './analysis/trendDetector.js';
import { rsi, ema, atr, macd, bollingerBands } from './analysis/indicators.js';
import { generateSignals, LIVE_STRATEGY_OPTS } from './analysis/signalGenerator.js';
import { analyzeExit } from './analysis/exitManager.js';

// --- Application States ---
let currentSymbol = 'BTCUSDT';
let currentTimeframe = '15m';
/** @type {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} */
let history = [];
let lastTickPrice = null;
const livePrices = {
  BTCUSDT: 0,
  XAUUSD: 0,
  GBPUSD: 0,
  USDCAD: 1.38, // approximate fallback
};

// --- Instantiate Core Classes ---
const dataManager = new DataManager();
const chartManager = new ChartManager('chart-container');

// Header
const header = new Header({
  onSymbolChange: (symbol) => {
    if (symbol !== currentSymbol) {
      initSymbolTimeframe(symbol, currentTimeframe);
    }
  },
  onTimeframeChange: (tf) => {
    if (tf !== currentTimeframe) {
      initSymbolTimeframe(currentSymbol, tf);
    }
  },
});

// Trade Manager
const tradeManager = new TradeManager({
  onDailyLossUpdate: (count) => {
    header.updateDailyLosses(count);
    // Halt checking disabled - trade anytime setup meets
  },
});

// Signal Panel
const signalPanel = new SignalPanel({
  onTakeTrade: (signal) => {
    if (tradeManager.shouldStopTrading()) {
      alert('Trading is halted today. You have reached 3 daily losses.');
      return;
    }
    const trade = tradeManager.takeTrade(signal);
    console.log('[Main] Trade taken:', trade);
    // Draw the active trade levels on the chart
    chartManager.drawSignal(signal);
  },
});

// Analysis Panel
const analysisPanel = new AnalysisPanel();

// Set initial daily losses state in header
const initialLosses = tradeManager.getDailyLosses();
header.updateDailyLosses(initialLosses);

// Set initial account summary in header
const initSummary = tradeManager.getAccountSummary();
header.updateAccountSummary(initSummary.balance, initSummary.equity);

// Ensure daily stop overlay remains hidden
const overlay = document.getElementById('daily-stop-overlay');
if (overlay) {
  overlay.classList.add('hidden');
}

// Acknowledge stop button listener
const ackBtn = document.getElementById('acknowledge-stop');
if (ackBtn) {
  ackBtn.addEventListener('click', () => {
    const stopOverlay = document.getElementById('daily-stop-overlay');
    if (stopOverlay) stopOverlay.classList.add('hidden');
  });
}

// Reset Account button listener
const resetAccountBtn = document.getElementById('btn-reset-account');
if (resetAccountBtn) {
  resetAccountBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to reset your account? This will clear all trade history, active trades, and restore your balance to $5,000.')) {
      resetAccountBtn.disabled = true;
      const originalText = resetAccountBtn.innerHTML;
      resetAccountBtn.innerHTML = '🔄 Resetting...';
      try {
        await tradeManager.resetAccount();
        console.log('[Main] Account reset successful.');
      } catch (err) {
        console.error('[Main] Account reset failed:', err);
        alert('Failed to reset account. Please try again.');
      } finally {
        resetAccountBtn.disabled = false;
        resetAccountBtn.innerHTML = originalText;
      }
    }
  });
}

// --- Subscription / Initialization Flow ---

/**
 * Switch the active symbol and timeframe, load history, and subscribe to feeds.
 *
 * @param {string} symbol
 * @param {string} timeframe
 */
async function initSymbolTimeframe(symbol, timeframe) {
  try {
    currentSymbol = symbol;
    currentTimeframe = timeframe;
    lastTickPrice = null;

    console.log(`[Main] Initializing ${symbol} on ${timeframe}`);

    // Unsubscribe existing WebSockets
    dataManager.unsubscribeAll();

    // Clear chart overlays
    chartManager.clearAll();

    // Show connecting status
    header.setConnectionStatus('connecting');

    // Fetch historical candles
    const candles = await dataManager.loadHistory(symbol, timeframe);
    if (!candles || candles.length === 0) {
      throw new Error('No historical data returned');
    }

    history = candles;
    console.log(`[Main] Loaded ${history.length} historical candles.`);

    // Live-only engine: trades are opened/closed server-side on live ticks only.

    // Set chart base data
    chartManager.setData(history, symbol);

    // Sync header open price for percentage change
    if (history.length > 0) {
      const lastCandle = history[history.length - 1];
      
      // Find the candle closest to exactly 24 hours ago (86400 seconds ago) for a true 24h change
      const targetTime = Math.floor(Date.now() / 1000) - 86400;
      let openCandle = history[0];
      let minDiff = Math.abs(openCandle.time - targetTime);
      for (const c of history) {
        const diff = Math.abs(c.time - targetTime);
        if (diff < minDiff) {
          minDiff = diff;
          openCandle = c;
        }
      }

      header.setOpenPrice(openCandle.close);
      header.updatePrice(lastCandle.close, null);
      lastTickPrice = lastCandle.close;
      livePrices[symbol] = lastCandle.close;
      // Immediately calculate active trades' P&L and R:R with the loaded price
      tradeManager.updatePrices(lastCandle.close, symbol);
      analysisPanel.setLiveRates(livePrices);
    }

    // Run structural analytics
    runAnalysis();

    // Update connection status
    header.setConnectionStatus('connected');

    // Subscribe to live feed
    dataManager.subscribeRealtime(symbol, timeframe, {
      onTick: (price) => {
        if (symbol !== currentSymbol) return; // Stale stream protection
        handleTick(price);
      },
      onCandleUpdate: (candle) => {
        if (symbol !== currentSymbol) return; // Stale stream protection
        handleCandleUpdate(candle);
      },
    });

  } catch (error) {
    console.error(`[Main] Initialization failed for ${symbol} (${timeframe}):`, error);
    header.setConnectionStatus('disconnected');
  }
}

/**
 * Handle real-time price updates.
 *
 * @param {number} price
 */
function handleTick(price) {
  if (price === lastTickPrice) return;

  // Update header ticker
  header.updatePrice(price, lastTickPrice);

  // Feed to trade manager to update active positions
  tradeManager.updatePrices(price, currentSymbol);

  // If we have active positions, update exit suggestions in real-time
  if (tradeManager.activeTrades.length > 0) {
    for (const trade of tradeManager.activeTrades) {
      if (trade.symbol === currentSymbol) {
        // Clone history and replace latest close with live price
        const candlesCopy = [...history];
        if (candlesCopy.length > 0) {
          const idx = candlesCopy.length - 1;
          candlesCopy[idx] = {
            ...candlesCopy[idx],
            close: price,
            high: Math.max(candlesCopy[idx].high, price),
            low: Math.min(candlesCopy[idx].low, price),
          };
        }
        const exitAnalysis = analyzeExit(candlesCopy, trade);
        tradeManager.updateExitAnalysis(trade.id, exitAnalysis);
      }
    }
  }



  // Update live price caches
  livePrices[currentSymbol] = price;
  analysisPanel.setLiveRates(livePrices);

  // Update account summary display in header in real-time!
  const summary = tradeManager.getAccountSummary();
  header.updateAccountSummary(summary.balance, summary.equity);

  lastTickPrice = price;
}

/**
 * Handle streaming kline updates.
 *
 * @param {object} candle
 */
function handleCandleUpdate(candle) {
  const lastIndex = history.findIndex(c => c.time === candle.time);
  let isNewCandle = false;

  if (lastIndex !== -1) {
    // Update current in-progress candle
    history[lastIndex] = {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };
  } else {
    // Transition detected! A new candle has started.
    // The previous candle in history is now closed and finalized.
    history.push({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });

    if (history.length > 1000) {
      history.shift();
    }
    isNewCandle = true;
  }

  // Rerender the chart candle
  chartManager.updateCandle(candle);

  // Recalculate setups if the candle has officially closed, or if a new candle started (transition)
  if (candle.isClosed || isNewCandle) {
    console.log(`[Main] Candle closed at ${new Date(candle.time * 1000).toLocaleTimeString()}. Recalculating setups.`);
    runAnalysis();
  }
}

/**
 * Run technical indicator formulas and smart money scanning algorithms.
 */
function runAnalysis() {
  if (history.length < 50) {
    console.warn('[Main] Insufficient historical data to run scanners.');
    return;
  }

  const closes = history.map(c => c.close);

  // 1. Indicators
  const rsiValues = rsi(closes);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const atrValues = atr(history);
  const macdData = macd(closes);
  const bb = bollingerBands(closes);

  const indicators = {
    rsi: rsiValues,
    emas: { 9: ema9, 21: ema21, 50: ema50, 200: ema200 },
    atr: atrValues,
    macd: macdData,
    bollingerBands: bb,
  };

  // 2. Structural Analysis
  const structure = detectStructure(history);

  // 3. Smart Money Concepts (Order Blocks)
  let orderBlocks = detectOrderBlocks(history);
  orderBlocks = updateMitigation(orderBlocks, history);

  // 4. Supply & Demand Zones
  let zones = detectZones(history);
  zones = updateZoneStatus(zones, history);

  // 5. Overall Trend
  const trend = analyzeTrend(history);

  // 6. Signal Scanner
  const dailyLossCount = tradeManager.getDailyLosses();
  let signals = generateSignals(history, currentSymbol, dailyLossCount, LIVE_STRATEGY_OPTS);

  // Expose/Suggest Grade A and B setups (Score >= 4)
  signals = signals.filter(sig => ['A', 'B'].includes(sig.quality));

  // Do not suggest or trade if there's already an active trade running on this symbol
  signals = signals.filter(sig => !tradeManager.activeTrades.some(t => t.symbol === sig.symbol && t.status === 'active'));

  // Do not suggest or trade if this symbol is in a 10-minute cooldown after close
  signals = signals.filter(sig => !tradeManager.isSymbolCoolingDown(sig.symbol));

  // Client-side auto-execution is disabled; server runs scans and autopilot auto-execution 24/7.

  // --- Render Chart Overlays ---
  const emaDataForChart = {
    9: history.map((c, i) => ({ time: c.time, value: ema9[i] })),
    21: history.map((c, i) => ({ time: c.time, value: ema21[i] })),
    50: history.map((c, i) => ({ time: c.time, value: ema50[i] })),
    200: history.map((c, i) => ({ time: c.time, value: ema200[i] })),
  };
  chartManager.drawEMAs(emaDataForChart);
  chartManager.drawOrderBlocks(orderBlocks, history);
  chartManager.drawZones(zones);
  chartManager.setMarkers(structure, history);

  // Draw active trade levels or first high-probability scanned signal overlays on the chart
  const activeTrade = tradeManager.activeTrades.find(t => t.symbol === currentSymbol);
  if (activeTrade) {
    chartManager.drawSignal({
      entry: activeTrade.entry,
      sl: activeTrade.sl,
      tp1: activeTrade.tp1,
      tp2: activeTrade.tp2,
      symbol: activeTrade.symbol,
    });
  } else if (signals.length > 0) {
    chartManager.drawSignal(signals[0]);
  } else {
    chartManager._clearDrawnObjects('signalLines');
  }

  // --- Update UI Panels ---
  signalPanel.updateSignals(signals, currentSymbol);
  
  const symbolStats = tradeManager.getSymbolStats();
  analysisPanel.updateOverview(trend, structure, orderBlocks, zones, indicators, currentSymbol, symbolStats, tradeManager.tradeHistory, signals);

  // Update active positions' suggestions based on newly calculated structure & indicators
  for (const trade of tradeManager.activeTrades) {
    if (trade.symbol === currentSymbol) {
      const exitAnalysis = analyzeExit(history, trade);
      tradeManager.updateExitAnalysis(trade.id, exitAnalysis);
    }
  }

  // Update account summary display in header
  const summary = tradeManager.getAccountSummary();
  header.updateAccountSummary(summary.balance, summary.equity);
}

/// --- State Synchronization from 24/7 Server Autopilot ---
async function syncTerminalState() {
  try {
    const response = await fetch('/api/terminal-state');
    if (!response.ok) throw new Error('API server returned error');
    const state = await response.json();

    // Synchronize client-side TradeManager properties
    tradeManager.activeTrades = state.activeTrades || [];
    tradeManager.tradeHistory = state.tradeHistory || [];
    tradeManager.accountBalance = state.accountBalance ?? 5000.0;
    tradeManager.dailyLosses = state.dailyLosses ?? 0;
    tradeManager.lastClosedTime = state.lastClosedTime || {};
    tradeManager.lastExecutedCandleTime = state.lastExecutedCandleTime || {};

    // Update UI elements
    header.updateDailyLosses(tradeManager.dailyLosses);
    
    // Calculate equity and update header summary
    const summary = tradeManager.getAccountSummary();
    header.updateAccountSummary(summary.balance, summary.equity);

    // Re-render trade manager panel card list
    tradeManager._render();
  } catch (err) {
    console.error('[Main] Failed to sync terminal state with server:', err);
  }
}

// Make it globally accessible so manual trade triggers can cause immediate syncs
globalThis.syncTerminalState = syncTerminalState;

// --- Initial Startup ---
async function startApp() {
  await syncTerminalState(); // Discover Twelve Data status first
  initSymbolTimeframe(currentSymbol, currentTimeframe);
}
startApp();

// Synchronize state from 24/7 server every 3 seconds
setInterval(syncTerminalState, 3000);
