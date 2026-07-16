/**
 * @module backtest/validate
 * Robustness checks for the blockRanging change, on already-cached candles
 * (no network / keys needed). Answers three questions the aggregate A/B can't:
 *   1. Per-symbol — does blockRanging help every symbol, or just one?
 *   2. In-sample vs out-of-sample — does it win in BOTH halves of the data?
 *   3. Fill sensitivity — does it win under pessimistic AND optimistic fills?
 *
 *   npm run backtest:validate
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { backtestSymbol, computeStats } from './backtester.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '../../scratch/bt-cache');
const SYMBOLS = ['BTCUSDT', 'XAUUSD', 'GBPUSD', 'USDCAD'];
const CONFIGS = { baseline: {}, blockRanging: { blockRanging: true } };

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : (v === Infinity ? '∞' : '—'));
const pad = (s, w) => String(s).padStart(w);

function loadCache() {
  const out = {};
  for (const sym of SYMBOLS) {
    const f = path.join(CACHE_DIR, `${sym}-15m.json`);
    if (fs.existsSync(f)) out[sym] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return out;
}

/** Run a config across symbols on a slice; return per-symbol stats + combined. */
function run(candlesBySym, strategyOpts, tieBreak, sliceFn) {
  const all = [];
  const per = {};
  for (const [sym, candles] of Object.entries(candlesBySym)) {
    const c = sliceFn ? sliceFn(candles) : candles;
    if (c.length < 260) continue;
    const { trades } = backtestSymbol(c, sym, { tieBreak, strategyOpts });
    per[sym] = computeStats(trades, sym);
    all.push(...trades);
  }
  return { per, combined: computeStats(all, 'ALL') };
}

function row(label, s, w = 18) {
  return [
    label.padEnd(w), pad(s.trades, 7), pad(fmt(s.winRate, 1), 7),
    pad(fmt(s.profitFactor), 6), pad(fmt(s.netPnL), 10), pad(fmt(s.expectancy), 9),
    pad(fmt(s.maxDrawdown), 9),
  ].join(' ');
}
function header(label, w = 18) {
  const h = [label.padEnd(w), pad('Trades', 7), pad('Win%', 7), pad('PF', 6), pad('Net $', 10), pad('Expect', 9), pad('MaxDD', 9)].join(' ');
  console.log('\n' + h); console.log('-'.repeat(h.length));
}

function main() {
  const data = loadCache();
  if (Object.keys(data).length === 0) {
    console.error('No cached candles. Run `npm run backtest -- --refresh` first.');
    process.exit(1);
  }

  const base = run(data, CONFIGS.baseline, 'pessimistic');
  const blk = run(data, CONFIGS.blockRanging, 'pessimistic');

  // 1) Per-symbol: baseline vs blockRanging.
  console.log('\n=== 1) PER-SYMBOL (pessimistic, full data) ===');
  header('Symbol / config');
  let helped = 0, total = 0;
  for (const sym of Object.keys(base.per)) {
    total++;
    console.log(row(`${sym} baseline`, base.per[sym]));
    console.log(row(`${sym} blockRanging`, blk.per[sym]));
    const d = blk.per[sym].netPnL - base.per[sym].netPnL;
    if (d > 0) helped++;
    console.log(`  Δnet = ${d >= 0 ? '+' : ''}${fmt(d)}  (PF ${fmt(base.per[sym].profitFactor)}→${fmt(blk.per[sym].profitFactor)})`);
  }
  console.log(`\n  blockRanging improved net on ${helped}/${total} symbols.`);

  // 2) In-sample vs out-of-sample (split each series at its midpoint).
  console.log('\n=== 2) IN-SAMPLE vs OUT-OF-SAMPLE (combined, pessimistic) ===');
  const firstHalf = c => c.slice(0, Math.floor(c.length / 2));
  const secondHalf = c => c.slice(Math.floor(c.length / 2));
  const isBase = run(data, CONFIGS.baseline, 'pessimistic', firstHalf).combined;
  const isBlk = run(data, CONFIGS.blockRanging, 'pessimistic', firstHalf).combined;
  const oosBase = run(data, CONFIGS.baseline, 'pessimistic', secondHalf).combined;
  const oosBlk = run(data, CONFIGS.blockRanging, 'pessimistic', secondHalf).combined;
  header('Half / config');
  console.log(row('IS  baseline', isBase));
  console.log(row('IS  blockRanging', isBlk));
  console.log(row('OOS baseline', oosBase));
  console.log(row('OOS blockRanging', oosBlk));
  const isWin = isBlk.netPnL > isBase.netPnL;
  const oosWin = oosBlk.netPnL > oosBase.netPnL;
  console.log(`\n  blockRanging wins net: in-sample=${isWin}, out-of-sample=${oosWin}.`);

  // 3) Fill sensitivity (combined, full data).
  console.log('\n=== 3) FILL SENSITIVITY (combined, full data) ===');
  const optBase = run(data, CONFIGS.baseline, 'optimistic').combined;
  const optBlk = run(data, CONFIGS.blockRanging, 'optimistic').combined;
  header('Fills / config');
  console.log(row('pessimistic base', base.combined));
  console.log(row('pessimistic block', blk.combined));
  console.log(row('optimistic  base', optBase));
  console.log(row('optimistic  block', optBlk));
  console.log(`\n  blockRanging wins net under: pessimistic=${blk.combined.netPnL > base.combined.netPnL}, optimistic=${optBlk.netPnL > optBase.netPnL}.`);

  // Verdict
  const robust = (helped >= Math.ceil(total * 0.75)) && isWin && oosWin
    && (blk.combined.netPnL > base.combined.netPnL) && (optBlk.netPnL > optBase.netPnL);
  console.log(`\n=== VERDICT ===`);
  console.log(robust
    ? `blockRanging holds across symbols, both data halves, and both fill models. Reasonable to keep live (still validate on longer/cleaner data).`
    : `blockRanging is NOT uniformly robust — inspect which dimension failed above before fully trusting it.`);
}

main();
