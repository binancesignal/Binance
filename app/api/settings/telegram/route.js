import { NextResponse } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import {
  sendTestMessage,
  getBotMe,
  getWebhookInfo,
  setTelegramWebhook,
  resolvePublicBaseUrl,
} from '../../../../lib/telegram/telegram.js';
import {
  getTelegramNotifyConfig,
  setTelegramNotifyConfig,
} from '../../../../lib/telegram/notifyConfig.js';
import { upsertLiveBoard, getLiveBoardEvents } from '../../../../lib/telegram/liveBoard.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const stored = (await getState('telegram_config', null)) || {};
    const envToken = !!process.env.TELEGRAM_BOT_TOKEN;
    const envChat = !!process.env.TELEGRAM_CHAT_ID;
    const notify = await getTelegramNotifyConfig();
    const boardMsgId = await getState('telegram_live_board_message_id', null);
    const token = stored.bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
    let webhook = null;
    let bot = null;
    if (token) {
      webhook = await getWebhookInfo(token);
      bot = await getBotMe(token);
    }
    const expectedBase = resolvePublicBaseUrl(request?.url);
    const expectedWebhook = expectedBase ? `${expectedBase}/api/telegram/webhook` : null;
    return NextResponse.json({
      configured: !!(
        (stored.bot_token || envToken) &&
        (stored.chat_id || envChat)
      ),
      has_token: !!(stored.bot_token || envToken),
      has_chat_id: !!(stored.chat_id || envChat),
      token_preview: stored.bot_token
        ? `${String(stored.bot_token).slice(0, 6)}…`
        : envToken
          ? '(from env)'
          : null,
      chat_id: stored.chat_id || (envChat ? '(from env)' : null),
      bot_username:
        stored.bot_username ||
        bot?.username ||
        process.env.TELEGRAM_BOT_USERNAME ||
        null,
      source: stored.bot_token || stored.chat_id ? 'database' : envToken ? 'env' : 'none',
      notify,
      liveBoardMessageId: boardMsgId,
      webhook,
      expected_webhook_url: expectedWebhook,
      webhook_ok: !!(
        webhook?.ok &&
        expectedWebhook &&
        String(webhook.url || '').replace(/\/$/, '') === expectedWebhook.replace(/\/$/, '')
      ),
      bot: bot?.ok ? bot : null,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = body.action || 'save_credentials';

    if (action === 'save_notify') {
      const next = await setTelegramNotifyConfig(body.notify || body);
      return NextResponse.json({ ok: true, notify: next });
    }

    if (action === 'refresh_live_board') {
      try {
        await setState('telegram_live_board_message_id', null);
        await setState('telegram_live_board_chat_id', null);
      } catch (_) {}
      const events = await getLiveBoardEvents();
      const r = await upsertLiveBoard({}, events, { force: true });
      if (!r.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: r.reason || r.error?.description || JSON.stringify(r.error) || 'send failed',
            ...r,
          },
          { status: 400 }
        );
      }
      return NextResponse.json({ ok: true, ...r });
    }

    if (action === 'set_webhook') {
      const prev = (await getState('telegram_config', null)) || {};
      const token = prev.bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
      if (!token) {
        return NextResponse.json({ error: 'Save bot token first' }, { status: 400 });
      }
      const base =
        (body.base_url && String(body.base_url).replace(/\/$/, '')) ||
        resolvePublicBaseUrl(request.url);
      const r = await setTelegramWebhook(base, token);
      if (!r.ok) {
        return NextResponse.json({ ok: false, error: r.error, ...r }, { status: 400 });
      }
      // keep username in sync from getMe
      const me = await getBotMe(token);
      if (me.ok && me.username) {
        await setState('telegram_config', {
          ...prev,
          bot_token: token,
          bot_username: me.username,
        });
      }
      return NextResponse.json({ ok: true, ...r, bot_username: me?.username || prev.bot_username });
    }

    const bot_token_in = (body.bot_token || '').trim();
    const chat_id_in = String(body.chat_id || '').trim();
    let bot_username = String(body.bot_username || '').trim().replace(/^@/, '');
    const test = !!body.test;
    const autoWebhook = body.set_webhook !== false;

    const prev = (await getState('telegram_config', null)) || {};
    const bot_token = bot_token_in || prev.bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
    const chat_id = chat_id_in || prev.chat_id || process.env.TELEGRAM_CHAT_ID || '';

    if (!bot_token || !chat_id) {
      return NextResponse.json(
        { error: 'bot_token and chat_id required (or save them once first)' },
        { status: 400 }
      );
    }

    // Validate token + auto-fill username from Telegram if missing
    const me = await getBotMe(bot_token);
    if (!me.ok) {
      return NextResponse.json(
        { error: `Invalid bot token: ${me.error || 'getMe failed'}` },
        { status: 400 }
      );
    }
    if (!bot_username && me.username) bot_username = me.username;

    await setState('telegram_config', {
      bot_token,
      chat_id,
      bot_username: bot_username || prev.bot_username || undefined,
    });

    let webhookResult = null;
    if (autoWebhook) {
      const base = resolvePublicBaseUrl(request.url);
      if (base) {
        webhookResult = await setTelegramWebhook(base, bot_token);
      } else {
        webhookResult = {
          ok: false,
          error:
            'Could not detect public URL. Use “Set webhook” after deploy, or set NEXT_PUBLIC_APP_URL.',
        };
      }
    }

    let testResult = null;
    if (test) {
      testResult = await sendTestMessage();
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      bot_username: bot_username || me.username || null,
      test: testResult,
      webhook: webhookResult,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
