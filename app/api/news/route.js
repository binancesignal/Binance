import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/session.js';
import { getUserById } from '../../../lib/database/users.js';
import { listNews, addNews, deleteNews } from '../../../lib/database/news.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(50, Math.max(1, +(searchParams.get('limit') || 15)));
    const items = await listNews({ limit });
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await getUserById(session.userId);
    if (!user || user.role !== 'admin') {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === 'delete') {
      await deleteNews(body.id);
      return NextResponse.json({ ok: true });
    }
    const item = await addNews({
      title: body.title,
      body: body.body,
      imageUrl: body.imageUrl || body.image_url || null,
      createdBy: user.email || user.id,
    });
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
