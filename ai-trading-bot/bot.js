import { Bot } from 'grammy';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

// ─── Config ───────────────────────────────────────────
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TRADE_URL   = process.env.TRADE_ANALYZER_URL || 'https://trade-analyzer-4rpq.onrender.com';
const AI_MODEL    = process.env.AI_MODEL || 'gpt-4o-mini';
const AI_BASE     = 'https://models.inference.ai.azure.com';

if (!BOT_TOKEN)    { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN missing — use your GitHub Personal Access Token'); process.exit(1); }

// ─── GitHub Models AI (Free GPT-4o-mini) ─────────────
async function askAI(messages) {
  const res = await fetch(`${AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: messages,
      temperature: 0.8,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.choices[0].message.content;
}

// ─── Trade Analyzer API Helper ───────────────────────
async function fetchTradeData() {
  try {
    const res = await fetch(`${TRADE_URL}/api/terminal-state`, { signal: AbortSignal.timeout(8000) });
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

  let text = `TRADING TERMINAL STATUS\n`;
  text += `Balance: $${(data.accountBalance || 0).toLocaleString()}\n`;
  text += `Daily Losses: ${data.dailyLosses || 0}/3\n`;
  text += `\n`;

  if (data.activeTrades && data.activeTrades.length > 0) {
    text += `ACTIVE TRADES (${data.activeTrades.length}):\n`;
    for (const t of data.activeTrades) {
      const pnl = ((t.currentPrice || t.entry) - t.entry) * (t.direction === 'long' ? 1 : -1);
      const pnlPct = ((pnl / t.entry) * 100).toFixed(2);
      const status = pnl >= 0 ? 'PROFIT' : 'LOSS';
      text += `  - ${t.symbol} | ${t.direction.toUpperCase()} | Entry: $${t.entry} | P/L: $${pnl.toFixed(2)} (${pnlPct}%) ${status}\n`;
      text += `    SL: $${t.stopLoss} | TP: $${t.takeProfit} | Quality: ${t.quality || '-'}\n`;
    }
  } else {
    text += `Tidak ada trade aktif saat ini.\n`;
  }

  text += `\nTRADE HISTORY (${(data.tradeHistory || []).length} trades):\n`;
  const recent = (data.tradeHistory || []).slice(-5).reverse();
  for (const t of recent) {
    const pnl = t.pnl || 0;
    const status = pnl >= 0 ? 'WIN' : 'LOSS';
    text += `  - ${t.symbol} | ${t.direction || '?'} | P/L: $${pnl.toFixed(2)} | ${status}\n`;
  }

  if (data.feeds) {
    text += `\nDATA FEEDS STATUS:\n`;
    for (const [sym, age] of Object.entries(data.feeds)) {
      const s = age === null ? 'OFFLINE' : (age < 60 ? 'LIVE' : (age < 300 ? 'SLOW' : 'STALE'));
      text += `  - ${sym}: ${s} (${age !== null ? age + 's ago' : 'N/A'})\n`;
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

Ketika user bertanya tentang status trading, data real-time akan diberikan sebelum pesan user.`;

// ─── Conversation Memory (per user, last 10 messages) ──
const conversations = new Map();

function getUserMemory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const mem = conversations.get(userId);
  if (mem.length > 20) mem.splice(0, mem.length - 10);
  return mem;
}

// ─── Command Handlers ─────────────────────────────────

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

bot.command('status', async (ctx) => {
  await ctx.reply('📊 Mengambil data terminal...');
  const d = await fetchTradeData();
  const text = formatTradeContext(d);
  await ctx.reply(text);
});

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

bot.command('balance', async (ctx) => {
  const d = await fetchTradeData();
  if (d.error) { await ctx.reply(`❌ ${d.error}`); return; }
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

bot.command('history', async (ctx) => {
  const d = await fetchTradeData();
  if (d.error) { await ctx.reply(`❌ ${d.error}`); return; }
  const history = d.tradeHistory || [];
  if (history.length === 0) { await ctx.reply('📭 Belum ada riwayat trade.'); return; }

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

  await ctx.replyWithChatAction('typing');

  const memory = getUserMemory(userId);
  memory.push({ role: 'user', content: userMsg });

  // Detect trading-related queries
  const tradingKeywords = ['trade', 'posisi', 'signal', 'sinyal', 'profit', 'loss', 'rugi', 'untung',
    'balance', 'saldo', 'pnl', 'harga', 'price', 'btc', 'xau', 'gbp', 'usd', 'forex', 'crypto',
    'status', 'terminal', 'analisa', 'order block', 'supply', 'demand', 'market', 'sell', 'buy',
    'trading', 'trade aktif', 'buka', 'tutup', 'stop loss', 'take profit', 'emas', 'gold', 'dollar'];

  const isTradeRelated = tradingKeywords.some(kw => userMsg.toLowerCase().includes(kw));

  // Build messages array for OpenAI-compatible API
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // Add conversation history
  for (const m of memory.slice(0, -1)) {
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content || m.text });
  }

  // Inject trade data if trading-related
  if (isTradeRelated) {
    try {
      const tradeData = await fetchTradeData();
      const tradeContext = formatTradeContext(tradeData);
      messages.push({
        role: 'system',
        content: `DATA REAL-TIME DARI TRADE ANALYZER TERMINAL USER:\n${tradeContext}\n\nBerdasarkan data di atas, jawab pertanyaan user. Berikan analisa yang jelas dan bermanfaat.`
      });
    } catch (e) {
      messages.push({ role: 'system', content: 'Trade Analyzer API sedang tidak bisa diakses. Jawab berdasarkan pengetahuan umum.' });
    }
  }

  // Add current message
  messages.push({ role: 'user', content: userMsg });

  try {
    const reply = await askAI(messages);
    memory.push({ role: 'assistant', content: reply });

    await ctx.reply(reply, { parse_mode: 'Markdown' }).catch(() => {
      ctx.reply(reply);
    });

  } catch (e) {
    console.error('AI Error:', e.message);
    await ctx.reply('❌ Maaf, ada error. Coba lagi ya!');
  }
});

// ─── Start Bot ────────────────────────────────────────
console.log('🦞 CAK Trading Assistant starting...');
console.log(`🤖 AI Model: ${AI_MODEL} (GitHub Models - FREE)`);
console.log(`📡 Trade Analyzer: ${TRADE_URL}`);
bot.start({
  onStart: (info) => {
    console.log(`✅ Bot started as @${info.username}`);
  }
}).catch(e => {
  console.error('❌ Bot failed to start:', e.message);
  process.exit(1);
});