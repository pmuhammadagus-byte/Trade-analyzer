import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

// Deriving paths in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------------------------
//  WS & Fetch Polyfill (CORS & Proxy handling)
// --------------------------------------------------------------------
globalThis.WebSocket = WebSocket;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url = typeof input === 'string' ? input : input.url;

  if (url.startsWith('/api/binance')) {
    url = 'https://api.binance.com' + url.replace(/^\/api\/binance/, '');
  } else if (url.startsWith('/api/finnhub')) {
    url = 'https://finnhub.io' + url.replace(/^\/api\/finnhub/, '');
  } else if (url.startsWith('/api/swissquote')) {
    url = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD';
  } else if (url.startsWith('/api/yahoo') || url.includes('query1.finance.yahoo.com')) {
    if (url.startsWith('/api/yahoo')) {
      url = 'https://query1.finance.yahoo.com' + url.replace(/^\/api\/yahoo/, '');
    }
    init = init || {};
    init.headers = {
      ...init.headers,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://finance.yahoo.com',
      'Referer': 'https://finance.yahoo.com',
    };
  }

  return originalFetch(url, init);
};

// --------------------------------------------------------------------
//  Imports of application code
// --------------------------------------------------------------------
import DBManager from './src/data/db.js';
import TradeManager from './src/components/tradeManager.js';
import { BinanceStream } from './src/data/binanceWebSocket.js';
import { YahooStream } from './src/data/yahooWebSocket.js';
import { fetchKlines } from './src/data/binanceAPI.js';
import { fetchCandles, filterForexOutlierWicks } from './src/data/yahooFinanceAPI.js';
import { fetchTwelveCandles } from './src/data/twelveDataAPI.js';
import { generateSignals, LIVE_STRATEGY_OPTS } from './src/analysis/signalGenerator.js';
import { analyzeExit } from './src/analysis/exitManager.js';
import { sendTelegramMessage } from './src/data/telegramNotifier.js';

// --------------------------------------------------------------------
//  App Setup
// --------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7860;
const TIMEFRAME = process.env.AUTOPILOT_TIMEFRAME || '15m';
const SYMBOLS = ['BTCUSDT', 'XAUUSD', 'GBPUSD', 'USDCAD'];

// Filter active autopilot symbols to maximize returns and eliminate noise
const AUTOPILOT_SYMBOLS = ['BTCUSDT', 'XAUUSD', 'GBPUSD', 'USDCAD'];

// Per-symbol Twelve Data API keys (OANDA-grade forex/metals that match TradingView).
// Read from environment so keys stay server-side and out of the public repo/bundle.
// A symbol with no key transparently falls back to Yahoo.
const TWELVEDATA_KEYS = {
  XAUUSD: process.env.TWELVEDATA_KEY_XAUUSD,
  GBPUSD: process.env.TWELVEDATA_KEY_GBPUSD,
  USDCAD: process.env.TWELVEDATA_KEY_USDCAD,
};
const getTdKey = (symbol) => TWELVEDATA_KEYS[symbol] || null;

const dbManager = new DBManager();
const tradeManager = new TradeManager({ isServer: true, db: dbManager });

// State caching for background scanners
const historyMap = {};
const livePrices = {};
const streams = {};
const lastUpdate = {};    // last time each symbol's feed delivered data (ms)
const staleAlerted = {};  // de-dupe flag for feed-stale Telegram alerts
const lastScannedCandleTime = {};

// Helper delay utility
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --------------------------------------------------------------------
//  Background 24/7 Scanning and Feed Handlers
// --------------------------------------------------------------------

async function loadHistoryForSymbol(symbol) {
  try {
    const candles = await fetchCandles(symbol, TIMEFRAME);
    
    if (candles && candles.length > 0) {
      historyMap[symbol] = candles;
      livePrices[symbol] = candles[candles.length - 1].close;
      console.log(`[Autopilot] Loaded ${candles.length} historical candles for ${symbol}. Current Price: $${livePrices[symbol]}`);
    }
  } catch (err) {
    console.error(`[Autopilot] Failed to load history for ${symbol}:`, err.message);
  }
}

function handleTick(symbol, price) {
  if (livePrices[symbol] === price) return;
  livePrices[symbol] = price;

  // 1. Feed to trade manager to check SL/TP/Partial exits in real-time
  tradeManager.updatePrices(price, symbol);

  // 2. Perform live exit suggestions / warnings updates on active trades of this symbol
  const activeTrades = tradeManager.activeTrades.filter(t => t.symbol === symbol && t.status === 'active');
  if (activeTrades.length > 0 && historyMap[symbol] && historyMap[symbol].length > 0) {
    const candlesCopy = [...historyMap[symbol]];
    const lastIdx = candlesCopy.length - 1;
    candlesCopy[lastIdx] = {
      ...candlesCopy[lastIdx],
      close: price,
      high: Math.max(candlesCopy[lastIdx].high, price),
      low: Math.min(candlesCopy[lastIdx].low, price),
    };

    for (const trade of activeTrades) {
      const exitAnalysis = analyzeExit(candlesCopy, trade);
      tradeManager.updateExitAnalysis(trade.id, exitAnalysis);
    }
  }
}

function handleCandleUpdate(symbol, candle) {
  lastUpdate[symbol] = Date.now();
  if (!historyMap[symbol]) historyMap[symbol] = [];
  const history = historyMap[symbol];

  const lastIndex = history.findIndex(c => c.time === candle.time);
  if (lastIndex !== -1) {
    history[lastIndex] = { ...candle };
  } else {
    // Transition detected! A new candle has started.
    // The previous candle in history is now closed and finalized.
    if (history.length > 0) {
      const closedCandle = history[history.length - 1];
      closedCandle.isClosed = true;
      console.log(`[Autopilot] Transition detected: Candle CLOSED for ${symbol} at ${new Date(closedCandle.time * 1000).toLocaleTimeString()}. Recalculating setups.`);
      runScannersForSymbol(symbol);
    }

    history.push({ ...candle });
    if (history.length > 1000) history.shift();
  }

  // If candle is explicitly marked closed (e.g. from Yahoo polling ticks), run the scan
  if (candle.isClosed) {
    console.log(`[Autopilot] Candle CLOSED for ${symbol} at ${new Date().toLocaleTimeString()}. Recalculating setups.`);
    runScannersForSymbol(symbol);
  }
}

function runScannersForSymbol(symbol) {
  const candles = historyMap[symbol];
  if (!candles || candles.length < 50) {
    console.warn(`[Autopilot] Insufficient candles to scan ${symbol}`);
    return;
  }

  const latestCandle = candles[candles.length - 1];
  if (lastScannedCandleTime[symbol] === latestCandle.time) {
    return; // Already scanned this candle
  }
  lastScannedCandleTime[symbol] = latestCandle.time;

  // Prevent opening trades if symbol has active trade or is in 10-minute cooldown
  const hasActiveTrade = tradeManager.activeTrades.some(t => t.symbol === symbol && t.status === 'active');
  if (hasActiveTrade) return;

  if (!AUTOPILOT_SYMBOLS.includes(symbol)) {
    return; // Exclude unprofitable symbols from auto-trading
  }

  if (tradeManager.isSymbolCoolingDown(symbol)) {
    console.log(`[Autopilot] Skipping ${symbol} scan due to 10-minute post-close cooldown.`);
    return;
  }

  try {
    let signals = generateSignals(candles, symbol, tradeManager.dailyLosses, LIVE_STRATEGY_OPTS);
    
    // Strict quality guards
    signals = signals.filter(sig => ['A', 'B'].includes(sig.quality));
    signals = signals.filter(sig => !tradeManager.activeTrades.some(t => t.symbol === sig.symbol && t.status === 'active'));
    signals = signals.filter(sig => !tradeManager.isSymbolCoolingDown(sig.symbol));

    if (signals.length > 0) {
      const bestSignal = signals[0];
      const latestCandle = candles[candles.length - 1];

      // Block same-candle executions
      if (!tradeManager.wasAlreadyExecuted(symbol, latestCandle.time)) {
        console.log(`[Autopilot] 🎯 high-probability Grade ${bestSignal.quality} setup scanned for ${symbol}! Auto-executing:`, bestSignal);
        tradeManager.takeTrade(bestSignal, latestCandle.time);
      }
    }
  } catch (err) {
    console.error(`[Autopilot] Error running signal scan for ${symbol}:`, err);
  }
}

// Poll Twelve Data for one symbol on its own dedicated key. Free tier allows
// 800 calls/day, so a 120s cadence (~720/day) stays safely under the limit while
// still tracking 15m candles. Backs off on errors so a hiccup never hammers the API.
function startTwelveDataPoller(symbol, apiKey, basePollMs = 120000) {
  let currentMs = basePollMs;
  const maxMs = 600000;
  let stopped = false;

  async function loop() {
    if (stopped) return;
    let ok = false;
    try {
      const candles = await fetchTwelveCandles(symbol, TIMEFRAME, 10, apiKey);
      if (candles && candles.length > 0) {
        ok = true;
        const latest = candles[candles.length - 1];
        handleTick(symbol, latest.close);
        
        const durationMap = {
          '1m': 60,
          '5m': 300,
          '15m': 900,
          '1H': 3600,
          '4H': 14400,
          '1D': 86400,
        };
        const tfSec = durationMap[TIMEFRAME] || 900;
        
        handleCandleUpdate(symbol, {
          ...latest,
          isClosed: (Math.floor(Date.now() / 1000) - latest.time) >= tfSec,
        });
      }
    } catch (err) {
      console.error(`[TwelveData] poll failed for ${symbol}:`, err.message);
    }
    currentMs = ok ? basePollMs : Math.min(maxMs, Math.round(currentMs * 1.8));
    if (!stopped) setTimeout(loop, currentMs);
  }

  setTimeout(loop, 0);
  streams[symbol] = { unsubscribe: () => { stopped = true; } };
}

// --------------------------------------------------------------------
//  Feed health monitoring (weekend-aware)
// --------------------------------------------------------------------
function isForexOpen(now = new Date()) {
  const day = now.getUTCDay(); // 0 Sun .. 6 Sat
  const h = now.getUTCHours();
  if (day === 6) return false;             // Saturday: closed
  if (day === 0 && h < 22) return false;   // Sunday before ~22:00 UTC
  if (day === 5 && h >= 21) return false;  // Friday after ~21:00 UTC
  return true;
}
function feedExpectedLive(symbol) {
  return symbol === 'BTCUSDT' ? true : isForexOpen();
}
const STALE_SECONDS = 20 * 60;
function checkFeedHealth() {
  for (const symbol of SYMBOLS) {
    const last = lastUpdate[symbol];
    const ageSec = last ? (Date.now() - last) / 1000 : Infinity;
    const stale = ageSec > STALE_SECONDS && feedExpectedLive(symbol);
    if (stale && !staleAlerted[symbol]) {
      staleAlerted[symbol] = true;
      console.warn(`[FeedHealth] ${symbol} feed stale (${Math.round(ageSec / 60)} min).`);
      sendTelegramMessage(`⚠️ <b>FEED STALE</b>\n\n<code>${symbol}</code> has not updated in <b>${Math.round(ageSec / 60)} min</b> while its market should be open. Check the data feed / Twelve Data key.`);
    } else if (!stale && staleAlerted[symbol]) {
      staleAlerted[symbol] = false;
      sendTelegramMessage(`✅ <b>FEED RECOVERED</b>\n\n<code>${symbol}</code> is updating again.`);
    }
  }
}

async function startAutopilot() {
  console.log('[Autopilot] Initializing feeds (Twelve Data for keyed forex/metals, Yahoo for the rest)...');
  
  // 1. Load initial history for all symbols using Yahoo Finance
  console.log('[Autopilot] Pre-loading historical caches...');
  for (const symbol of SYMBOLS) {
    const tdKey = getTdKey(symbol);
    try {
      let candles;
      if (tdKey) {
        try {
          candles = await fetchTwelveCandles(symbol, '15m', 500, tdKey);
          console.log(`[Autopilot] Loaded ${candles.length} Twelve Data candles for ${symbol}.`);
        } catch (tdErr) {
          console.error(`[Autopilot] Twelve Data pre-load failed for ${symbol}, falling back to Yahoo:`, tdErr.message);
          candles = await fetchCandles(symbol, '15m');
        }
      } else {
        candles = await fetchCandles(symbol, '15m');
      }
      if (candles && candles.length > 0) {
        historyMap[symbol] = candles;
        livePrices[symbol] = candles[candles.length - 1].close;
        // Immediately calculate active trades' P&L and R:R with the loaded price
        tradeManager.updatePrices(livePrices[symbol], symbol);
      }
    } catch (err) {
      console.error(`[Autopilot] Pre-load failed for ${symbol}:`, err.message);
    }
  }

  // 2. Subscribe to real-time Yahoo streams for all 6 symbols in the background
  console.log('[Autopilot] Establishing background monitoring feeds...');
  for (const [idx, symbol] of SYMBOLS.entries()) {
    const tdKey = getTdKey(symbol);
    if (tdKey) {
      // OANDA-grade feed on a dedicated key (broker / TradingView-matching candles).
      console.log(`[Autopilot] Streaming ${symbol} from Twelve Data (dedicated key).`);
      startTwelveDataPoller(symbol, tdKey, 120000);
    } else {
      const stream = new YahooStream();
      stream.subscribe(symbol, TIMEFRAME, {
        onTick: (price) => { handleTick(symbol, price); },
        onCandleUpdate: (candle) => { handleCandleUpdate(symbol, candle); },
      }, { pollMs: 10000, staggerMs: idx * 1500 });
      streams[symbol] = stream;
    }
  }

  console.log(`[Server Autopilot] Startup complete. Timeframe: ${TIMEFRAME}. Autopilot active for: ${AUTOPILOT_SYMBOLS.join(', ')}.`);

  // Monitor feed liveness; alert (weekend-aware) if a feed stalls during market hours.
  setInterval(checkFeedHealth, 5 * 60 * 1000);
}

// --------------------------------------------------------------------
//  API Routing
// --------------------------------------------------------------------

app.get('/api/terminal-state', (req, res) => {
  res.json({
    activeTrades: tradeManager.activeTrades,
    tradeHistory: tradeManager.tradeHistory,
    accountBalance: tradeManager.accountBalance,
    dailyLosses: tradeManager.dailyLosses,
    lastClosedTime: tradeManager.lastClosedTime,
    lastExecutedCandleTime: tradeManager.lastExecutedCandleTime,
    twelveDataActive: false,
    feeds: Object.fromEntries(SYMBOLS.map(s => [s, lastUpdate[s] ? Math.floor((Date.now() - lastUpdate[s]) / 1000) : null])),
  });
});

// Cached market data: browsers read candles + live price from the server's own
// poller cache instead of each hitting Yahoo. Reads in-memory state, no upstream call.
app.get('/api/market-data', (req, res) => {
  const symbol = req.query.symbol;
  const rawCandles = (symbol && historyMap[symbol]) ? historyMap[symbol].slice(-500) : [];
  // Re-apply the forex outlier-wick filter on read, so candles cached in memory
  // before this fix (or any stray glitch bar) are cleaned without a full restart.
  // Twelve Data is already broker-clean, so only the Yahoo path needs wick scrubbing.
  const candles = getTdKey(symbol) ? rawCandles : filterForexOutlierWicks(rawCandles, symbol);
  
  // Prevent browser caching of real-time market data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.json({
    symbol: symbol || null,
    candles,
    price: (symbol && livePrices[symbol] != null) ? livePrices[symbol] : null,
    serverTime: Math.floor(Date.now() / 1000),
  });
});

app.post('/api/take-trade', async (req, res) => {
  const { signal } = req.body;
  if (!signal) {
    return res.status(400).json({ error: 'Signal structure required' });
  }
  // takeTrade is async and resolves to null when the trade is rejected
  // (duplicate symbol, cooldown, etc.) — await it so success reflects reality.
  const trade = await tradeManager.takeTrade(signal);
  res.json({ success: !!trade, trade: trade || null });
});

app.post('/api/manual-close', (req, res) => {
  const { tradeId } = req.body;
  if (tradeId === undefined) {
    return res.status(400).json({ error: 'Trade ID required' });
  }
  tradeManager.manualClose(Number(tradeId));
  res.json({ success: true, message: `Trade ${tradeId} closed successfully.` });
});

app.post('/api/reset-account', (req, res) => {
  tradeManager.resetAccount();
  res.json({ success: true, message: 'Terminal account state reset completely.' });
});

app.get('/api/test-telegram', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(400).json({
      success: false,
      error: `Missing credentials. Token: ${token ? 'configured' : 'MISSING'}, Chat ID: ${chatId ? 'configured' : 'MISSING'}`
    });
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const msg = `🔔 <b>Trade Analyzer Connection Test</b>\n\n` +
                `<b>Status:</b> 🟢 Connected successfully!\n` +
                `<b>Source:</b> 🚀 Triggered from Hugging Face Server\n` +
                `<b>Time:</b> <code>${new Date().toLocaleString()}</code>\n\n` +
                `This confirms your Telegram configuration is working perfectly.`;
                
    const telegramRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'HTML',
      }),
    });

    const data = await telegramRes.json();
    if (telegramRes.ok && data.ok) {
      res.json({ success: true, message: 'Test message sent to Telegram successfully.', data });
    } else {
      res.status(400).json({ success: false, error: data.description || 'Telegram API Error', data });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Proxy routes for client-side fetches (Bypasses CORS natively)
app.use('/api/binance', async (req, res) => {
  try {
    const targetUrl = 'https://api.binance.com' + req.originalUrl.replace(/^\/api\/binance/, '');
    const response = await fetch(targetUrl);
    res.status(response.status);
    const data = await response.text();
    res.send(data);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.use('/api/yahoo', async (req, res) => {
  try {
    const targetUrl = 'https://query1.finance.yahoo.com' + req.originalUrl.replace(/^\/api\/yahoo/, '');
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://finance.yahoo.com',
        'Referer': 'https://finance.yahoo.com',
      }
    });
    res.status(response.status);
    const data = await response.text();
    res.send(data);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.use('/api/swissquote', async (req, res) => {
  try {
    const targetUrl = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD';
    const response = await fetch(targetUrl);
    res.status(response.status);
    const data = await response.text();
    res.send(data);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --------------------------------------------------------------------
//  Static Asset hosting (Production deployment build)
// --------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    // Hashed JS/CSS bundles are content-addressed and safe to cache forever, but
    // index.html must never be cached or browsers keep loading the old bundle after
    // a deploy (the root cause of "I pushed but still see the old version").
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --------------------------------------------------------------------
//  Database connection & bootup coordination
// --------------------------------------------------------------------
async function bootServer() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('CRITICAL ERROR: MONGODB_URI environment variable is missing.');
    process.exit(1);
  }

  try {
    // 1. Establish Mongo connection & Sync state
    await dbManager.connect(uri);
    const state = await dbManager.loadState();
    
    // Sync DB into server TradeManager properties
    tradeManager.activeTrades = state.activeTrades || [];
    tradeManager.tradeHistory = state.tradeHistory || [];
    tradeManager.accountBalance = state.accountBalance ?? 5000.0;
    tradeManager.dailyLosses = state.dailyLosses ?? 0;
    tradeManager.lastExecutedCandleTime = state.lastExecutedCandleTime || {};
    tradeManager.lastClosedTime = state.lastClosedTime || {};
    tradeManager.lastResetDate = state.lastResetDate || new Date().toDateString();

    console.log('[Server] MongoDB terminal state recovered successfully.');
    console.log(`[Server] Active Positions: ${tradeManager.activeTrades.length} | Balance: $${tradeManager.accountBalance.toFixed(2)}`);

    // 2. Start 24/7 scanning feed loops
    await startAutopilot();

    // 3. Bind HTTP Port listener
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] Trade Analyzer Full-Stack Engine running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to boot terminal backend:', err);
    process.exit(1);
  }
}

bootServer();
