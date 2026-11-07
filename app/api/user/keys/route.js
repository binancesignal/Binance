import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { saveUserKeys, getUserKeyStatus } from '../../../../lib/database/users.js';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const status = await getUserKeyStatus(session.userId);
  return NextResponse.json(status);
}

export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json();
    const { apiKey, apiSecret } = body || {};
    if (!apiKey || !apiSecret) {
      return NextResponse.json({ error: 'apiKey and apiSecret required' }, { status: 400 });
    }
    const result = await saveUserKeys(session.userId, { apiKey, apiSecret });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
