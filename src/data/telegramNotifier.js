/**
 * telegramNotifier.js
 * Browser-safe utility to send HTML-formatted messages to Telegram.
 * Operates purely on the server side if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
 */

export async function sendTelegramMessage(htmlText) {
  // Check if we are running in Node.js server environment and have variables configured
  if (typeof process === 'undefined' || !process.env) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    // Gracefully bypass if credentials are not configured
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[Telegram] API HTTP error ${res.status}:`, text);
    }
  } catch (err) {
    console.error('[Telegram] Failed to send notification:', err.message);
  }
}
