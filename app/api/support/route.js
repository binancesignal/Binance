import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/session.js';
import { getUserById } from '../../../lib/database/users.js';
import { getThread, appendMessage, listOpenThreads } from '../../../lib/database/support.js';
import { getState } from '../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';

async function getBotToken() {
  let token = process.env.TELEGRAM_BOT_TOKEN || '';
  try {
    const stored = await getState('telegram_config', null);
    if (stored?.bot_token) token = stored.bot_token;
  } catch (_) {}
  return token;
}

async function getAdminChatId() {
  try {
    const stored = await getState('telegram_config', null);
    if (stored?.chat_id) return String(stored.chat_id);
  } catch (_) {}
  return process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
}

async function notifyAdminTelegram({ user, text, userId }) {
  const token = await getBotToken();
  const chatId = await getAdminChatId();
  if (!token || !chatId) return { sent: false, reason: 'No bot token or admin chat_id' };
  const body =
    `🆘 <b>Support</b>\n` +
    `From: <code>${user?.email || userId}</code>\n` +
    `User id: <code>${userId}</code>\n\n` +
    `${escapeHtml(text)}\n\n` +
    `Reply: <code>/support_reply ${userId} your message</code>`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: 'HTML' }),
  });
  const data = await res.json().catch(() => ({}));
  return { sent: !!data.ok, reason: data.description };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function GET(req) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await getUserById(session.userId);
    const { searchParams } = new URL(req.url);
    if (user?.role === 'admin' && searchParams.get('all') === '1') {
      const threads = await listOpenThreads(40);
      return NextResponse.json({ threads });
    }
    const thread = await getThread(session.userId);
    return NextResponse.json(thread);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await getUserById(session.userId);
    const body = await req.json().catch(() => ({}));
    const text = String(body.text || '').trim();
    if (!text) return NextResponse.json({ error: 'Message required' }, { status: 400 });

    // Admin can reply from the site too (optional)
    if (body.asAdmin && user?.role === 'admin' && body.userId) {
      const msg = await appendMessage(body.userId, { from: 'admin', text });
      return NextResponse.json({ ok: true, message: msg });
    }

    const msg = await appendMessage(session.userId, { from: 'user', text });
    const notify = await notifyAdminTelegram({ user, text, userId: session.userId });
    return NextResponse.json({ ok: true, message: msg, telegram: notify });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
