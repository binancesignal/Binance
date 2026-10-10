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
import { getActiveSignals, getSignalById } from '../../../../lib/database/signals.js';
import {
  sendCoinAnalysisChartToChat,
  sendSignalAnalysisChartToChat,
} from '../../../../lib/telegram/telegram.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function getBotToken() {
  let token = process.env.TELEGRAM_BOT_TOKEN || '';
  try {
    const stored = await getState('telegram_config', null);
    if (stored?.bot_token) token = stored.bot_token;
  } catch (_) {}
  return token;
}

async function reply(chatId, text, replyMarkup = null) {
  const token = await getBotToken();
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
}

async function answerCallback(callbackId, text = '') {
  const token = await getBotToken();
  if (!token || !callbackId) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

async function sendActiveSignalPicker(chatId, { readyOnly = false } = {}) {
  const active = await getActiveSignals();
  const statusRank = { READY: 0, WATCHING: 1, ONGOING: 2 };
  const rows = (active || [])
    .filter((signal) => !readyOnly || String(signal.status || '').toUpperCase() === 'READY')
    .sort((a, b) =>
      (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
      (+b.score || 0) - (+a.score || 0)
    )
    .slice(0, 10)
    .map((signal) => [{
      text: `${signal.symbol} ${signal.direction} · ${signal.status} · ${Math.round(+signal.score || 0)}`,
      callback_data: `analyze:${signal.signal_id}`,
    }]);
  if (!rows.length) {
    await reply(
      chatId,
      readyOnly
        ? 'No READY signals right now. Refresh the liveboard or try /analyze for other active setups.'
        : 'No active signals yet. Run a scan first; then use /analyze to choose one.'
    );
    return;
  }
  rows.push([{ text: 'Refresh signal list', callback_data: 'analyze:list' }]);
  await reply(
    chatId,
    readyOnly
      ? '📈 <b>Choose a READY signal for its full ICT chart analysis:</b>'
      : '📊 <b>Choose a signal for its full chart analysis:</b>',
    {
    inline_keyboard: rows,
  });
}

export async function POST(req) {
  try {
    const update = await req.json();
    const callback = update.callback_query;
    if (callback) {
      const chatId = callback.message?.chat?.id;
      const data = String(callback.data || '');
      await answerCallback(
        callback.id,
        data === 'analyze:list' || data === 'analyze:ready'
          ? 'Loading signals…'
          : data === 'analyze:coin'
            ? 'Choose a coin…'
          : 'Building chart…'
      );
      if (!chatId) return NextResponse.json({ ok: true });
      if (data === 'analyze:list') {
        await sendActiveSignalPicker(chatId);
        return NextResponse.json({ ok: true });
      }
      if (data === 'analyze:ready') {
        await sendActiveSignalPicker(chatId, { readyOnly: true });
        return NextResponse.json({ ok: true });
      }
      if (data === 'analyze:coin') {
        await reply(
          chatId,
          'Send a coin and timeframe, for example <code>/chart BTC 15m</code>.\nSupported timeframes: 5m, 15m, 30m, 1h, 2h, 4h.'
        );
        return NextResponse.json({ ok: true });
      }
      if (data.startsWith('analyze:')) {
        const signalId = data.slice('analyze:'.length);
        const signal = await getSignalById(signalId);
        if (!signal) {
          await reply(chatId, 'That signal is no longer available.');
          return NextResponse.json({ ok: true });
        }
        const result = await sendSignalAnalysisChartToChat(chatId, signal);
        if (!result?.ok) {
          await reply(chatId, 'Could not send the chart analysis. Try again in a moment.');
        }
      }
      return NextResponse.json({ ok: true });
    }

    const msg = update.message || update.edited_message;
    if (!msg?.text || !msg.chat?.id) {
      return NextResponse.json({ ok: true });
    }
    const text = String(msg.text).trim();
    const chatId = msg.chat.id;
    const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();

    if (command === '/chart' && text.split(/\s+/)[1]) {
      const [, symbol, requestedTimeframe = '15m'] = text.split(/\s+/);
      const result = await sendCoinAnalysisChartToChat(chatId, symbol, requestedTimeframe.toLowerCase());
      if (!result?.ok && result?.error) {
        await reply(chatId, typeof result.error === 'string' ? result.error : 'Could not send that analysis chart right now.');
      }
      return NextResponse.json({ ok: true });
    }

    if (command === '/analyze' || command === '/chart') {
      await sendActiveSignalPicker(chatId);
      return NextResponse.json({ ok: true });
    }

    if (command === '/start') {
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
