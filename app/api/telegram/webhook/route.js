/**
 * Telegram bot webhook — handles /start CODE for personal link.
 * Set webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram/webhook
 */
import { NextResponse } from 'next/server';
import { getState } from '../../../../lib/database/appState.js';
import {
  getUserByTelegramLinkCode,
  linkTelegramChat,
} from '../../../../lib/database/users.js';

async function getBotToken() {
  let token = process.env.TELEGRAM_BOT_TOKEN || '';
  try {
    const stored = await getState('telegram_config', null);
    if (stored?.bot_token) token = stored.bot_token;
  } catch (_) {}
  return token;
}

async function reply(chatId, text) {
  const token = await getBotToken();
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
}

export async function POST(req) {
  try {
    const update = await req.json();
    const msg = update.message || update.edited_message;
    if (!msg?.text || !msg.chat?.id) {
      return NextResponse.json({ ok: true });
    }
    const text = String(msg.text).trim();
    const chatId = msg.chat.id;

    if (text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      const code = parts[1] || '';
      if (!code) {
        await reply(
          chatId,
          '👋 Open the Signal Desk site → Profile → Connect Telegram to link this chat for personal alerts.'
        );
        return NextResponse.json({ ok: true });
      }
      const user = await getUserByTelegramLinkCode(code);
      if (!user) {
        await reply(chatId, '❌ Link code invalid or expired. Generate a new one from the site.');
        return NextResponse.json({ ok: true });
      }
      await linkTelegramChat(user.id, chatId);
      await reply(
        chatId,
        '✅ <b>Connected</b>\nYou will receive personal signal alerts here while your plan/trial is active.'
      );
      return NextResponse.json({ ok: true });
    }

    if (text === '/unlink' || text === '/stop') {
      await reply(
        chatId,
        'To unlink, use Profile → Disconnect Telegram on the website.'
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[telegram webhook]', e.message);
    return NextResponse.json({ ok: true }); // always 200 to Telegram
  }
}
