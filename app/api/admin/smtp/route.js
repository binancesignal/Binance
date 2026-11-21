import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getUserById } from '../../../../lib/database/users.js';
import { getSmtpPublic, saveSmtpConfig, sendMail, verifySmtp } from '../../../../lib/mail/mailer.js';
import { getState } from '../../../../lib/database/appState.js';
import { testEmailTemplate } from '../../../../lib/mail/templates.js';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const user = await getUserById(session.userId);
  if (!user || user.role !== 'admin') return { error: NextResponse.json({ error: 'Admin only' }, { status: 403 }) };
  return { user };
}

export async function GET() {
  const a = await requireAdmin();
  if (a.error) return a.error;
  return NextResponse.json(await getSmtpPublic());
}

export async function POST(req) {
  const a = await requireAdmin();
  if (a.error) return a.error;
  try {
    const body = await req.json().catch(() => ({}));

    if (body.action === 'test') {
      try {
        await verifySmtp();
        const brand = (await getState('branding', {})) || {};
        const appName = brand.appName || 'Signal Desk';
        const mail = testEmailTemplate({ appName, logoUrl: brand.logoUrl });
        await sendMail({ to: body.to || a.user.email, appName, ...mail });
        return NextResponse.json({ ok: true, sentTo: body.to || a.user.email });
      } catch (e) {
        const m = String(e.message || e);
        const hint = /Invalid login|535|Username and Password not accepted/i.test(m)
          ? ' — wrong username or app password (Gmail needs an App Password, not your normal password).'
          : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(m) ? ' — check host and port.' : '';
        return NextResponse.json({ error: m + hint }, { status: 400 });
      }
    }

    return NextResponse.json({ ok: true, ...(await saveSmtpConfig(body)) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
