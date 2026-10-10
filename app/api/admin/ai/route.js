import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getUserById } from '../../../../lib/database/users.js';
import {
  getAiManagerConfigPublic,
  setAiManagerApiKey,
  askAiManager,
} from '../../../../lib/ai/manager.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const user = await getUserById(session.userId);
  if (!user || user.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Admin only' }, { status: 403 }) };
  }
  return { user };
}

export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const cfg = await getAiManagerConfigPublic();
  return NextResponse.json(cfg);
}

export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'save';

    if (action === 'test') {
      if (body.api_key && String(body.api_key).trim()) {
        await setAiManagerApiKey(String(body.api_key).trim());
      }
      const result = await askAiManager({
        user: gate.user,
        message: 'Say only: Nila is online.',
        history: [],
      });
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, reply: result.reply, model: result.model });
    }

    const key = String(body.api_key || '').trim();
    if (!key) {
      return NextResponse.json({ error: 'api_key required' }, { status: 400 });
    }
    const r = await setAiManagerApiKey(key);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
