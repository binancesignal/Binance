import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import {
  listUsers,
  getUserById,
  updateUser,
  writeAudit,
  TRIAL_DAYS,
} from '../../../../lib/database/users.js';

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { session };
}

export async function GET(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  const url = new URL(req.url);
  const search = url.searchParams.get('search') || '';
  const users = await listUsers({ search, limit: 100 });
  return NextResponse.json({ users });
}

export async function PATCH(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  try {
    const body = await req.json();
    const { userId, action, plan, days } = body || {};
    if (!userId || !action) {
      return NextResponse.json({ error: 'userId and action required' }, { status: 400 });
    }
    const target = await getUserById(userId);
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    if (action === 'extend_trial') {
      const d = Number(days) || TRIAL_DAYS;
      const base = new Date(Math.max(Date.now(), new Date(target.trial_ends_at || 0).getTime()));
      const newEnd = new Date(base.getTime() + d * 24 * 60 * 60 * 1000);
      await updateUser(userId, {
        trial_ends_at: newEnd.toISOString(),
        subscription_status: 'trialing',
        plan: 'trial',
      });
      await writeAudit(session.userId, 'extend_trial', { userId, days: d });
      return NextResponse.json({ ok: true });
    }

    if (action === 'assign_plan') {
      if (!['trial', 'signal', 'auto', 'pro'].includes(plan)) {
        return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
      }
      await updateUser(userId, {
        plan,
        subscription_status: plan === 'trial' ? 'trialing' : 'active',
      });
      await writeAudit(session.userId, 'assign_plan', { userId, plan });
      return NextResponse.json({ ok: true });
    }

    if (action === 'suspend') {
      await updateUser(userId, { is_suspended: true });
      await writeAudit(session.userId, 'suspend', { userId });
      return NextResponse.json({ ok: true });
    }

    if (action === 'unsuspend') {
      await updateUser(userId, { is_suspended: false });
      await writeAudit(session.userId, 'unsuspend', { userId });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
