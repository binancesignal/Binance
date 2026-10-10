import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getSession } from '../../../../lib/auth/session.js';
import { getState } from '../../../../lib/database/appState.js';
import {
  getTelegramStatus,
  setTelegramLinkCode,
  unlinkTelegram,
  getUserById,
  hasActiveAccess,
} from '../../../../lib/database/users.js';

async function botUsername() {
  let u = process.env.TELEGRAM_BOT_USERNAME || '';
  try {
    const stored = await getState('telegram_config', null);
    if (stored?.bot_username) u = stored.bot_username;
  } catch (_) {}
  return String(u || '').replace(/^@/, '');
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const status = await getTelegramStatus(session.userId);
  const username = await botUsername();
  return NextResponse.json({ ...status, bot_username: username || null });
}

export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'connect';

    if (action === 'unlink') {
      await unlinkTelegram(session.userId);
      return NextResponse.json({ ok: true, linked: false });
    }

    // connect — generate short-lived code + deep link
    const user = await getUserById(session.userId);
    if (!user || !hasActiveAccess(user)) {
      return NextResponse.json(
        { error: 'Active trial or paid plan required to link Telegram' },
        { status: 403 }
      );
    }

    const code = randomBytes(8).toString('hex');
    await setTelegramLinkCode(session.userId, code);
    const username = await botUsername();
    if (!username) {
      return NextResponse.json({
        ok: true,
        code,
        deep_link: null,
        message:
          'Bot username not configured. Admin must set bot_username in Telegram settings. Meanwhile send /start ' +
          code +
          ' to the bot manually.',
      });
    }
    const deep_link = `https://t.me/${username}?start=${code}`;
    return NextResponse.json({ ok: true, code, deep_link, expires_in_minutes: 15 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
