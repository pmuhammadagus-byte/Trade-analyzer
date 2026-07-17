import { Bot } from 'grammy';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

// ─── Config ───────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TRADE_URL  = process.env.TRADE_ANALYZER_URL || 'https://trade-analyzer-4rpq.onrender.com';

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!GEMINI_KEY) { console.error('GEMINI_API_KEY missing — get one free at https://aistudio.google.com/apikey'); process.exit(1); }

// ─── Gemini AI ────────────────────────────────────────
const genAI  = new GoogleGenerativeAI(GEMINI_KEY);
const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// ─── Trade Analyzer API Helper ───────────────────────
async function fetchTradeData() {
  try {
    const res  = await fetch(`${TRADE_URL}/api/terminal-state`, { signal: AbortSignal.timeout(8000) });
    return await res.json();
  } catch (e) {
    return { error: 'Gagal mengambil data trade analyzer' };
  }
}

async function fetchMarketData(symbol) {
  try {
    const res = await fetch(`${TRADE_URL}/api/market-data?symbol=${symbol}`, { signal: AbortSignal.timeout(8000) });
    return await res.json();
  } catch (e) {
    return { error: 'Gagal mengambil data market' };
  }
}

// ─── Format trade data for AI context ────────────────
function formatTradeContext(data) {
  if (data.error) return `Trade Analyzer API error: ${data.error}`;
  
  let text = `📊 TRADING TERMINAL STATUS\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `💰 Balance: $${(data.accountBalance || 0).toLocaleString()}\n`;
  text += `📊 Equity: $${(data.accountBalance || 0).toLocaleString()}\n`;
  text += `🔴 Daily Losses: ${data.dailyLosses || 0}/3\n`;
  text += `\n`;

  // Active trades
  if (data.activeTrades && data.activeTrades.length > 0) {
    text += `📈 ACTIVE TRADES (${data.activeTrades.length}):\n`;
    for (const t of data.activeTrades) {
      const pnl = ((t.currentPrice || t.entry) - t.entry) * (t.direction === 'long' ? 1 : -1);
      const pnlPct = ((pnl / t.entry) * 100).toFixed(2);
      const emoji = pnl >= 0 ? '🟢' : '🔴';
      text += `  ${emoji} ${t.symbol} | ${t.direction.toUpperCase()} | Entry: $${t.entry} | P/L: $${pnl.toFixed(2)} (${pnlPct}%)\n`;
      text += `     SL: $${t.stopLoss} | TP: $${t.takeProfit} | Quality: ${t.quality || '-'}\n`;
    }
  } else {
    text += `📭 Tidak ada trade aktif\n`;
  }

  text += `\n📋 TRADE HISTORY (${(data.tradeHistory || []).length} trades):\n`;
  const recent = (data.tradeHistory || []).slice(-5).reverse();
  for (const t of recent) {
    const emoji = (t.pnl || 0) >= 0 ? '✅' : '❌';
    text += `  ${emoji} ${t.symbol} | ${t.direction || '?'} | P/L: $${(t.pnl || 0).toFixed(2)}\n`;
  }

  // Feed status
  if (data.feeds) {
    text += `\n📡 Data Feeds:\n`;
    for (const [sym, age] of Object.entries(data.feeds)) {
      const status = age === null ? '🔴 OFFLINE' : (age < 60 ? '🟢' : (age < 300 ? '🟡' : '🔴'));
      text += `  ${status} ${sym}: ${age !== null ? age + 's ago' : 'N/A'}\n`;
    }
  }

  return text;
}

// ─── Bot Setup ────────────────────────────────────────
const bot = new Bot(BOT_TOKEN);

// Allowed users (optional security)
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').filter(Boolean);

bot.use(async (ctx, next) => {
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(String(ctx.from?.id))) {
    return;
  }
  return next();
});

// ─── System Prompt ───────────────────────────────────
const SYSTEM_PROMPT = `Kamu adalah CAK Trading Assistant — seorang AI trader profesional yang ahli dalam analisa teknikal, smart money concepts, dan manajemen risiko.

KEMAMPUANMU:
1. Chat normal — bisa menjawab pertanyaan apapun dengan santai dan ramah
2. Analisa Trading — memberikan analisa pasar forex dan crypto
3. Manajemen Trading — mengecek status trade, balance, dan performa
4. Edukasi — menjelaskan konsep trading (order blocks, supply/demand, dll)

GAYA BAHASA:
- Bahasa Indonesia (campur sedikit bahasa Inggris untuk istilah trading)
- Santai tapi profesional, seperti teman trader yang berpengalaman
- Gunakan emoji yang relevan
- Jelaskan dengan jelas dan terstruktur
- Selalu ingatkan bahwa ini bukan financial advice

Ketika user bertanya tentang status trading, kamu akan diberikan data real-time dari Trade Analyzer terminal.`;

// ─── Conversation Memory (per user, last 10 messages) ──
const conversations = new Map();

function getUserMemory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const mem = conversations.get(userId);
  if (mem.length > 20) mem.splice(0, mem.length - 10);
  return mem;
}

// ─── Command Handlers ─────────────────────────────────

// /start
bot.command('start', async (ctx) => {
  await ctx.reply(
    `🦞 *CAK Trading Assistant*\n\n` +
    `Hai! Aku AI trader kamu. Bisa ngobrol biasa atau tanya soal trading!\n\n` +
    `📋 *Commands:*\n` +
    `/status — Cek status trading terminal\n` +
    `/market — Cek harga pasar terkini\n` +
    `/history — Riwayat trade\n` +
    `/balance — Cek saldo\n` +
    `/help — Bantuan\n\n` +
    `Atau langsung chat aja, aku bisa bantu analisa juga! 📈`,
    { parse_mode: 'Markdown' }
  );
});

// /status
bot.command('status', async (ctx) => {
  await ctx.reply('📊 Mengambil data terminal...');
  const data = fetchTradeData();
  // Show loading, then edit with data
  setTimeout(async () => {
    const d = await data;
    const text = formatTradeContext(d);
    await ctx.reply(text);
  }, 2000);
});

// /market
bot.command('market', async (ctx) => {
  const symbols = ['BTCUSDT', 'XAUUSD', 'GBPUSD', 'USDCAD'];
  let text = '📈 *HARGA PASAR TERKINI*\n━━━━━━━━━━━━━━━━━━━━\n';
  
  for (const sym of symbols) {
    const d = await fetchMarketData(sym);
    if (d.price) {
      text += `💰 ${sym}: $${d.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    }
  }
  text += `\n_Source: Trade Analyzer Terminal_`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// /balance
bot.command('balance', async (ctx) => {
  const d = await fetchTradeData();
  if (d.error) {
    await ctx.reply(`❌ ${d.error}`);
    return;
  }
  await ctx.reply(
    `💰 *ACCOUNT BALANCE*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Balance: $${(d.accountBalance || 0).toLocaleString()}\n` +
    `📊 Daily Losses: ${d.dailyLosses || 0}/3\n` +
    `📈 Active Trades: ${(d.activeTrades || []).length}\n` +
    `📋 Total Trades: ${(d.tradeHistory || []).length}`,
    { parse_mode: 'Markdown' }
  );
});

// /history
bot.command('history', async (ctx) => {
  const d = await fetchTradeData();
  if (d.error) {
    await ctx.reply(`❌ ${d.error}`);
    return;
  }
  const history = d.tradeHistory || [];
  if (history.length === 0) {
    await ctx.reply('📭 Belum ada riwayat trade.');
    return;
  }
  
  let text = `📋 *RIWAYAT TRADE* (${history.length} total)\n━━━━━━━━━━━━━━━━━━━━\n`;
  const last10 = history.slice(-10).reverse();
  let totalPnl = 0;
  let wins = 0, losses = 0;
  
  for (const t of last10) {
    const pnl = t.pnl || 0;
    totalPnl += pnl;
    if (pnl >= 0) wins++; else losses++;
    const emoji = pnl >= 0 ? '🟢' : '🔴';
    text += `${emoji} ${t.symbol} | ${t.direction?.toUpperCase() || '?'} | $${pnl.toFixed(2)} | ${t.quality || '-'}\n`;
  }
  
  const winRate = last10.length > 0 ? ((wins / last10.length) * 100).toFixed(0) : 0;
  text += `\n📊 Win Rate: ${winRate}% | Total P/L: $${totalPnl.toFixed(2)}`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `🦞 *CAK Trading Assistant — Help*\n\n` +
    `*Commands:*\n` +
    `/status — Status terminal trading\n` +
    `/market — Harga pasar real-time\n` +
    `/balance — Cek saldo akun\n` +
    `/history — Riwayat trade\n` +
    `/help — Bantuan ini\n\n` +
    `*Chat Langsung:*\n` +
    `Tanya apa saja — analisa pasar, saran trading, edukasi, atau sekadar ngobrol! 🚀`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Main Message Handler (AI Chat + Trading Integration) ──
bot.on('message:text', async (ctx) => {
  const userMsg = ctx.message.text;
  const userId = ctx.from.id;
  
  // Show typing indicator
  await ctx.replyWithChatAction('typing');
  
  // Get user conversation memory
  const memory = getUserMemory(userId);
  memory.push({ role: 'user', text: userMsg });
  
  // Check if message is trading-related to inject real-time data
  const tradingKeywords = ['trade', 'posisi', 'signal', 'sinyal', 'profit', 'loss', 'rugi', 'untung', 
    'balance', 'saldo', 'pnl', 'harga', 'price', 'btc', 'xau', 'gbp', 'usd', 'forex', 'crypto',
    'status', 'terminal', 'analisa', 'order block', 'supply', 'demand', 'market', 'sell', 'buy',
    'trading', 'trade aktif', 'buka', 'tutup', 'stop loss', 'take profit'];
  
  const isTradeRelated = tradingKeywords.some(kw => userMsg.toLowerCase().includes(kw));
  
  let tradeContext = '';
  if (isTradeRelated) {
    try {
      const tradeData = await fetchTradeData();
      tradeContext = '\n\n[DATA REAL-TIME DARI TRADE ANALYZER TERMINAL]\n' + formatTradeContext(tradeData) + '\n';
    } catch (e) {
      tradeContext = '\n[Trade Analyzer API sedang tidak bisa diakses]\n';
    }
  }
  
  try {
    // Build prompt with history
    const chatHistory = memory.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    }));
    
    const prompt = tradeContext 
      ? `${SYSTEM_PROMPT}\n\nUser sedang bertanya terkait trading. Berikut data real-time dari terminal trading user:${tradeContext}\n\nPesan user: ${userMsg}`
      : `${SYSTEM_PROMPT}\n\nPesan user: ${userMsg}`;
    
    const result = await model.generateContent({
      contents: chatHistory.length > 0 ? [...chatHistory, { role: 'user', parts: [{ text: prompt }] }] : [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 2048,
      }
    });
    
    const reply = result.response.text();
    
    // Save to memory
    memory.push({ role: 'assistant', text: reply });
    
    // Send reply
    await ctx.reply(reply, { parse_mode: 'Markdown' }).catch(() => {
      // Fallback without markdown if formatting fails
      ctx.reply(reply);
    });
    
  } catch (e) {
    console.error('AI Error:', e.message);
    await ctx.reply('❌ Maaf, ada error. Coba lagi ya!');
  }
});

// ─── Start Bot ────────────────────────────────────────
console.log('🦞 CAK Trading Assistant starting...');
bot.start({
  onStart: (info) => {
    console.log(`✅ Bot started as @${info.username}`);
    console.log(`📡 Trade Analyzer: ${TRADE_URL}`);
  }
}).catch(e => {
  console.error('❌ Bot failed to start:', e.message);
  process.exit(1);
});