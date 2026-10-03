import { NextResponse } from 'next/server';
import { getState, setState } from '../../../../lib/database/appState.js';
import { sendTestMessage } from '../../../../lib/telegram/telegram.js';
import {
  getTelegramNotifyConfig,
  setTelegramNotifyConfig,
} from '../../../../lib/telegram/notifyConfig.js';
import { upsertLiveBoard, getLiveBoardEvents } from '../../../../lib/telegram/liveBoard.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stored = (await getState('telegram_config', null)) || {};
    const envToken = !!process.env.TELEGRAM_BOT_TOKEN;
    const envChat = !!process.env.TELEGRAM_CHAT_ID;
    const notify = await getTelegramNotifyConfig();
    const boardMsgId = await getState('telegram_live_board_message_id', null);
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
      bot_username: stored.bot_username || process.env.TELEGRAM_BOT_USERNAME || null,
      source: stored.bot_token || stored.chat_id ? 'database' : envToken ? 'env' : 'none',
      notify,
      liveBoardMessageId: boardMsgId,
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
      // Always force: even if mode is every_event or board was deleted
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

    const bot_token_in = (body.bot_token || '').trim();
    const chat_id_in = String(body.chat_id || '').trim();
    const bot_username = String(body.bot_username || '').trim().replace(/^@/, '');
    const test = !!body.test;

    const prev = (await getState('telegram_config', null)) || {};
    const bot_token = bot_token_in || prev.bot_token || process.env.TELEGRAM_BOT_TOKEN || '';
    const chat_id = chat_id_in || prev.chat_id || process.env.TELEGRAM_CHAT_ID || '';

    if (!bot_token || !chat_id) {
      return NextResponse.json(
        { error: 'bot_token and chat_id required (or save them once first)' },
        { status: 400 }
      );
    }

    await setState('telegram_config', {
      bot_token,
      chat_id,
      bot_username: bot_username || prev.bot_username || undefined,
    });

    let testResult = null;
    if (test) {
      testResult = await sendTestMessage();
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      test: testResult,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
