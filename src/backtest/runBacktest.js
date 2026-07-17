/**
 * @module backtest/runBacktest
 * CLI entry point for the backtester.
 *
 *   npm run backtest                       # all symbols, cached data
 *   npm run backtest -- BTCUSDT            # one symbol
 *   npm run backtest -- --refresh          # re-fetch data (ignore cache)
 *   npm run backtest -- --tie=optimistic   # upper-bound fill assumption
 *   npm run backtest -- --size=5000        # candles to request from the feed
 *
 * Data source mirrors live: TwelveData per-symbol key when present (set
 * TWELVEDATA_KEY_<SYMBOL> in .env), otherwise Yahoo. Fetched candles are cached
 * to scratch/bt-cache so reruns are offline. Trade logs land in scratch/bt-results.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// --- Make the browser-oriented fetch helpers work under Node -------------
// yahooFinanceAPI builds relative "/api/yahoo" + "/api/swissquote" proxy URLs;
// rewrite them to the real upstreams (same shim the server uses).
const __nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('/api/yahoo')) {
    url = 'https://query1.finance.yahoo.com' + url.replace(/^\/api\/yahoo/, '');
    init = { ...(init || {}), headers: {
      ...((init && init.headers) || {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://finance.yahoo.com',
      'Referer': 'https://finance.yahoo.com',
    } };
  } else if (url.startsWith('/api/swissquote')) {
    url = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD';
  }
  return __nativeFetch(url, init);
};

const { fetchCandles } = await import('../data/yahooFinanceAPI.js');
const { fetchTwelveCandles } = await import('../data/twelveDataAPI.js');
const { backtestSymbol, computeStats } = await import('./backtester.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '../../scratch/bt-cache');
const RESULT_DIR = path.resolve(__dirname, '../../scratch/bt-results');
const ALL_SYMBOLS = ['BTCUSDT', 'XAUUSD', 'GBPUSD', 'USDCAD'];
const TIMEFRAME = '15m';

function parseArgs(argv) {
  const opts = {
    symbols: [], refresh: false, tieBreak: 'pessimistic', size: 5000,
    ab: false, max: 0, strategyOpts: {},
  };
  for (const a of argv) {
    if (a === '--refresh') opts.refresh = true;
    else if (a === '--ab') opts.ab = true;
    else if (a === '--block-ranging') opts.strategyOpts.blockRanging = true;
    else if (a.startsWith('--max-entry-dist=')) opts.strategyOpts.maxEntryDistAtr = parseFloat(a.slice(17));
    else if (a.startsWith('--max=')) opts.max = parseInt(a.slice(6), 10) || 0;
    else if (a.startsWith('--tie=')) opts.tieBreak = a.slice(6);
    else if (a.startsWith('--size=')) opts.size = parseInt(a.slice(7), 10) || 5000;
    else if (!a.startsWith('--')) opts.symbols.push(a.toUpperCase());
  }
  if (opts.symbols.length === 0) opts.symbols = [...ALL_SYMBOLS];
  return opts;
}

// A/B presets: each runs the full strategy with a different generateSignals opts.
const AB_CONFIGS = [
  { name: 'baseline',         strategyOpts: {} },
  { name: 'blockRanging',     strategyOpts: { blockRanging: true } },
  { name: 'entryDist<=1.5',   strategyOpts: { maxEntryDistAtr: 1.5 } },
  { name: 'entryDist<=1.0',   strategyOpts: { maxEntryDistAtr: 1.0 } },
  { name: 'ranging+dist1.5',  strategyOpts: { blockRanging: true, maxEntryDistAtr: 1.5 } },
];

async function loadCandles(symbol, { refresh, size }) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}-${TIMEFRAME}.json`);
  if (!refresh && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.log(`[data] ${symbol}: ${cached.length} candles (cache)`);
    return cached;
  }

  const tdKey = process.env[`TWELVEDATA_KEY_${symbol}`];
  let candles = [];
  if (tdKey) {
    for (const sz of [size, 2000, 800]) {
      try {
        candles = await fetchTwelveCandles(symbol, TIMEFRAME, sz, tdKey);
        console.log(`[data] ${symbol}: ${candles.length} candles (TwelveData, size=${sz})`);
        break;
      } catch (err) {
        console.warn(`[data] ${symbol}: TwelveData size=${sz} failed: ${err.message}`);
      }
    }
  }
  if (candles.length === 0) {
    // Yahoo allows up to 60d for the 15m interval — request the max for backtesting.
    candles = await fetchCandles(symbol, TIMEFRAME, '60d');
    console.log(`[data] ${symbol}: ${candles.length} candles (Yahoo${tdKey ? ' fallback' : ''})`);
  }

  if (candles.length > 0) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(candles));
  }
  return candles;
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : (v === Infinity ? '∞' : '—'));
const pad = (s, w) => String(s).padStart(w);

function printReport(rows, firstCol = 'Symbol') {
  const cols = [
    [firstCol, 16], ['Trades', 7], ['Win%', 7], ['PF', 6], ['Net $', 10],
    ['Expect', 8], ['AvgWin', 8], ['AvgLoss', 8], ['MaxDD', 9], ['Comm $', 9],
  ];
  const head = cols.map(([h, w]) => pad(h, w)).join(' ');
  console.log('\n' + head);
  console.log('-'.repeat(head.length));
  for (const s of rows) {
    console.log([
      pad(s.symbol, 16), pad(s.trades, 7), pad(fmt(s.winRate, 1), 7), pad(fmt(s.profitFactor), 6),
      pad(fmt(s.netPnL), 10), pad(fmt(s.expectancy), 8), pad(fmt(s.avgWin), 8),
      pad(fmt(s.avgLoss), 8), pad(fmt(s.maxDrawdown), 9), pad(fmt(s.totalCommission), 9),
    ].join(' '));
  }
  console.log('-'.repeat(head.length));
}

/** Run one strategy config across all loaded symbols; return per-symbol + combined stats. */
function runConfig(candlesBySymbol, strategyOpts, tieBreak, progress) {
  const perSymbol = [];
  const allTrades = [];
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    const { trades, stats } = backtestSymbol(candles, symbol, {
      tieBreak, strategyOpts, onProgress: progress,
    });
    perSymbol.push(stats);
    allTrades.push(...trades);
  }
  return { perSymbol, allTrades, combined: computeStats(allTrades, 'ALL') };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!['pessimistic', 'optimistic', 'proximity'].includes(opts.tieBreak)) {
    console.error(`Invalid --tie=${opts.tieBreak}. Use pessimistic | optimistic | proximity.`);
    process.exit(1);
  }
  fs.mkdirSync(RESULT_DIR, { recursive: true });

  // Load candles for every symbol once, then reuse across configs.
  const candlesBySymbol = {};
  for (const symbol of opts.symbols) {
    let candles;
    try {
      candles = await loadCandles(symbol, opts);
    } catch (err) {
      console.error(`[data] ${symbol}: load failed: ${err.message}`);
      continue;
    }
    if (!candles || candles.length < 250) {
      console.warn(`[backtest] ${symbol}: only ${candles?.length || 0} candles — skipping (need >250).`);
      continue;
    }
    if (opts.max > 0 && candles.length > opts.max) candles = candles.slice(-opts.max);
    const spanDays = ((candles[candles.length - 1].time - candles[0].time) / 86400).toFixed(1);
    console.log(`[backtest] ${symbol}: ${candles.length} bars (~${spanDays}d)`);
    candlesBySymbol[symbol] = candles;
  }
  if (Object.keys(candlesBySymbol).length === 0) {
    console.error('[backtest] No symbols produced data.');
    process.exit(1);
  }

  console.log(`[backtest] tie=${opts.tieBreak}${opts.ab ? ' mode=A/B' : ''}`);

  if (opts.ab) {
    // Run each preset config; compare combined performance.
    const rows = [];
    for (const cfg of AB_CONFIGS) {
      process.stdout.write(`  ${cfg.name.padEnd(16)} `);
      const { combined } = runConfig(candlesBySymbol, cfg.strategyOpts, opts.tieBreak,
        () => process.stdout.write('.'));
      combined.symbol = cfg.name; // reuse the first column for the config label
      rows.push(combined);
      process.stdout.write(` ${combined.trades} trades, net $${fmt(combined.netPnL)}\n`);
    }
    printReport(rows, 'Config');
    fs.writeFileSync(path.join(RESULT_DIR, 'ab.json'), JSON.stringify(rows, null, 2));

    const best = [...rows].sort((a, b) => b.netPnL - a.netPnL)[0];
    const base = rows.find(r => r.symbol === 'baseline');
    console.log(`\nFill assumption: ${opts.tieBreak}. Costs (commission) included in Net $.`);
    console.log(`Best config: ${best.symbol} (net $${fmt(best.netPnL)}, PF ${fmt(best.profitFactor)}).`);
    if (base) console.log(`Delta vs baseline: $${fmt(best.netPnL - base.netPnL)} on ${best.trades} vs ${base.trades} trades.`);
    console.log(`Note: short sample — treat deltas as directional, not proof.`);
    return;
  }

  // Single config (default = live behaviour; flags can override).
  const { perSymbol, allTrades } = runConfig(candlesBySymbol, opts.strategyOpts, opts.tieBreak,
    () => process.stdout.write('.'));
  process.stdout.write('\n');
  for (const stats of perSymbol) {
    const symTrades = allTrades.filter(t => t.symbol === stats.symbol);
    fs.writeFileSync(path.join(RESULT_DIR, `${stats.symbol}.json`), JSON.stringify({ stats, trades: symTrades }, null, 2));
  }
  const rows = [...perSymbol];
  if (rows.length > 1) rows.push(computeStats(allTrades, 'ALL'));
  printReport(rows);

  const combined = rows[rows.length - 1];
  const sOpts = JSON.stringify(opts.strategyOpts);
  console.log(`\nStrategy opts: ${sOpts === '{}' ? 'baseline (live)' : sOpts}`);
  console.log(`Fill assumption: ${opts.tieBreak}. Commission included in Net $; spread baked into levels.`);
  console.log(`Per-trade logs: scratch/bt-results/<symbol>.json\n`);
  if (combined.netPnL < 0) {
    console.log(`Verdict: net NEGATIVE (${fmt(combined.netPnL)}). Loses after costs on this data.`);
  } else {
    console.log(`Verdict: net positive (${fmt(combined.netPnL)}). Validate out-of-sample before trusting.`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
