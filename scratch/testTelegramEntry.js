import dotenv from 'dotenv';
dotenv.config();
import { sendTelegramMessage } from './src/data/telegramNotifier.js';

const mockTradeMsg = `🚨 <b>NEW AUTOPILOT TRADE EXECUTED</b>\n\n` +
  `<b>Setup Quality:</b> <code>Grade B Setup</code>\n` +
  `<b>Symbol:</b> <code>GBPUSD</code>\n` +
  `<b>Direction:</b> <code>LONG</code>\n` +
  `<b>Lot Size:</b> <code>0.20 lots</code>\n` +
  `<b>Entry Price:</b> <code>$1.34797</code>\n` +
  `<b>Stop Loss (SL):</b> <code>$1.34543</code>\n` +
  `<b>Take Profit 1 (TP1):</b> <code>$1.35306</code>\n` +
  `<b>Take Profit 2 (TP2):</b> <code>$1.35560</code>\n\n` +
  `📊 <b>Risk Configuration:</b>\n` +
  `• <b>Expected Risk:</b> <code>$50.87</code> (FundingPips Compliant)\n` +
  `• <b>Stop Loss Distance:</b> <code>0.00254 price units</code>\n\n` +
  `💡 <b>Trade Confluences Scanned:</b>\n` +
  `• Price at S/D Zone\n` +
  `• Trend aligned (bullish)\n` +
  `• Price near EMA21 support`;

async function run() {
  console.log('Sending mock trade entry message...');
  await sendTelegramMessage(mockTradeMsg);
  console.log('Done.');
}

run();
