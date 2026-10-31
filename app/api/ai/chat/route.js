import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getUserById } from '../../../../lib/database/users.js';
import { askAiManager, getAiManagerConfigPublic } from '../../../../lib/ai/manager.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cfg = await getAiManagerConfigPublic();
  return NextResponse.json(cfg);
}

export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await req.json().catch(() => ({}));
    const message = String(body.message || '').trim();
    if (!message) {
      return NextResponse.json({ error: 'message required' }, { status: 400 });
    }
    if (message.length > 4000) {
      return NextResponse.json({ error: 'message too long' }, { status: 400 });
    }

    const user = await getUserById(session.userId);
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 });

    const history = Array.isArray(body.history) ? body.history : [];
    const result = await askAiManager({ user, message, history });
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'AI failed' }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      reply: result.reply,
      model: result.model,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
