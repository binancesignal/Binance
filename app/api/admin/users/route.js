import { NextResponse } from 'next/server';
import { getSession, createSessionToken, setSessionCookie } from '../../../../lib/auth/session.js';
import {
  listUsers,
  getUserById,
  getUserByEmail,
  createUser,
  deleteUser,
  updateUser,
  writeAudit,
  TRIAL_DAYS,
  getUserTradingSettings,
  setUserTradingSettings,
  sanitizeUser,
} from '../../../../lib/database/users.js';
import { countOpenExecutionsForUser, deleteExecutionsForUser } from '../../../../lib/database/executions.js';

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

/** Admin: create an account. POST { email, password, plan? } */
export async function POST(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  try {
    const { email, password, plan } = (await req.json()) || {};
    if (!email || !password) {
      return NextResponse.json({ error: 'email and password required' }, { status: 400 });
    }
    if (plan && !['trial', 'signal', 'auto', 'pro'].includes(plan)) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }
    const user = await createUser({ email, password, role: 'user' });
    if (plan && plan !== 'trial') {
      await updateUser(user.id, { plan, subscription_status: 'active' });
    }
    await writeAudit(session.userId, 'admin_create_user', { userId: user.id, email: user.email, plan: plan || 'trial' });
    return NextResponse.json({ ok: true, user: { id: user.id, email: user.email, plan: plan || 'trial' } });
  } catch (e) {
    const msg = e.message || 'Create failed';
    return NextResponse.json({ error: msg }, { status: msg.includes('already') ? 409 : 500 });
  }
}

/**
 * Admin: permanently delete an account. DELETE { userId | email, force? }
 * Refuses admins / yourself; refuses users with open trades unless force.
 */
export async function DELETE(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  try {
    const { userId, email, force } = (await req.json()) || {};
    const target = userId ? await getUserById(userId) : email ? await getUserByEmail(email) : null;
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (target.id === session.userId || target.role === 'admin') {
      return NextResponse.json({ error: 'Cannot delete an admin account' }, { status: 403 });
    }
    const open = await countOpenExecutionsForUser(target.id);
    if (open > 0 && !force) {
      return NextResponse.json(
        { error: `${open} trade(s) are still open for this user`, code: 'OPEN_TRADES', open },
        { status: 409 }
      );
    }
    const deletedTrades = await deleteExecutionsForUser(target.id);
    await deleteUser(target.id);
    await writeAudit(session.userId, 'admin_delete_user', { userId: target.id, email: target.email, deletedTrades });
    return NextResponse.json({ ok: true, deleted: target.email, deletedTrades });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  try {
    const body = await req.json();
    const { userId, action, plan, days, force } = body || {};
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

    if (action === 'clear_trade_history') {
      // open trades are still tracked here (SL/TP ids, PnL sync) - don't lose them by accident
      const open = await countOpenExecutionsForUser(userId);
      if (open > 0 && !force) {
        return NextResponse.json(
          { error: `${open} trade(s) are still open for this user`, code: 'OPEN_TRADES', open },
          { status: 409 }
        );
      }
      const deleted = await deleteExecutionsForUser(userId);
      // Fresh start: auto-trade off (so old, still-active signals are not re-entered) and the
      // starting capital cleared. The user turns auto-trade on and sets a new capital.
      const settings = await getUserTradingSettings(userId);
      const next = { ...settings, autoTradingEnabled: false, autoTradeExchange: null };
      delete next.capital;
      await setUserTradingSettings(userId, next);
      await writeAudit(session.userId, 'clear_trade_history', { userId, deleted, force: !!force });
      return NextResponse.json({ ok: true, deleted });
    }

    // Admin can log in as any user without knowing their password
    if (action === 'impersonate') {
      if (target.is_suspended) {
        return NextResponse.json({ error: 'Account is suspended' }, { status: 403 });
      }
      const token = await createSessionToken({
        userId: target.id,
        email: target.email,
        role: target.role,
        plan: target.plan,
      });
      await setSessionCookie(token);
      await writeAudit(session.userId, 'impersonate', { userId: target.id, email: target.email });
      return NextResponse.json({
        ok: true,
        user: sanitizeUser(target),
        redirect: '/',
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
