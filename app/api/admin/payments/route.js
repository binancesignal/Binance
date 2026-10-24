import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import {
  getPaymentSettings,
  updatePaymentSettings,
  listPendingDeposits,
  listPendingWithdrawals,
  confirmDeposit,
  rejectDeposit,
  completeWithdrawal,
  rejectWithdrawal,
  adminAdjustWallet,
  listUserDeposits,
} from '../../../../lib/database/payments.js';
import { getUserByEmail, getUserById } from '../../../../lib/database/users.js';
import { writeAudit } from '../../../../lib/database/users.js';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { session };
}

export async function GET() {
  const { session, error } = await requireAdmin();
  if (error) return error;
  try {
    const [settings, deposits, withdrawals] = await Promise.all([
      getPaymentSettings(),
      listPendingDeposits(50),
      listPendingWithdrawals(50),
    ]);
    // enrich deposits with email
    const enrichedDep = await Promise.all(
      deposits.map(async (d) => {
        const u = await getUserById(d.user_id);
        return { ...d, user_email: u?.email || null };
      })
    );
    const enrichedWd = await Promise.all(
      withdrawals.map(async (w) => {
        const u = await getUserById(w.user_id);
        return { ...w, user_email: u?.email || null };
      })
    );
    return NextResponse.json({
      settings,
      pending_deposits: enrichedDep,
      pending_withdrawals: enrichedWd,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST actions:
 *  update_settings | confirm_deposit | reject_deposit |
 *  complete_withdrawal | reject_withdrawal | adjust_wallet
 */
export async function POST(req) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === 'update_settings') {
      const s = await updatePaymentSettings(body.settings || body);
      await writeAudit(session.userId, 'payment_settings_update', { settings: s });
      return NextResponse.json({ ok: true, settings: s });
    }

    if (action === 'confirm_deposit') {
      if (!body.deposit_id) return NextResponse.json({ error: 'deposit_id required' }, { status: 400 });
      const result = await confirmDeposit(body.deposit_id, session.userId);
      await writeAudit(session.userId, 'confirm_deposit', { deposit_id: body.deposit_id, result });
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'reject_deposit') {
      if (!body.deposit_id) return NextResponse.json({ error: 'deposit_id required' }, { status: 400 });
      const d = await rejectDeposit(body.deposit_id, session.userId, body.note || '');
      await writeAudit(session.userId, 'reject_deposit', { deposit_id: body.deposit_id });
      return NextResponse.json({ ok: true, deposit: d });
    }

    if (action === 'complete_withdrawal') {
      if (!body.withdrawal_id) return NextResponse.json({ error: 'withdrawal_id required' }, { status: 400 });
      const w = await completeWithdrawal(body.withdrawal_id, session.userId, body.note || '');
      await writeAudit(session.userId, 'complete_withdrawal', { withdrawal_id: body.withdrawal_id });
      return NextResponse.json({ ok: true, withdrawal: w });
    }

    if (action === 'reject_withdrawal') {
      if (!body.withdrawal_id) return NextResponse.json({ error: 'withdrawal_id required' }, { status: 400 });
      const w = await rejectWithdrawal(body.withdrawal_id, session.userId, body.note || '');
      await writeAudit(session.userId, 'reject_withdrawal', { withdrawal_id: body.withdrawal_id });
      return NextResponse.json({ ok: true, withdrawal: w });
    }

    if (action === 'adjust_wallet') {
      let userId = body.user_id;
      if (!userId && body.email) {
        const u = await getUserByEmail(body.email);
        if (!u) return NextResponse.json({ error: 'User not found' }, { status: 404 });
        userId = u.id;
      }
      if (!userId) return NextResponse.json({ error: 'user_id or email required' }, { status: 400 });
      const amount = Number(body.amount);
      if (!amount || Number.isNaN(amount)) {
        return NextResponse.json({ error: 'amount required (positive=credit, negative=debit)' }, { status: 400 });
      }
      const bal = await adminAdjustWallet(userId, amount, body.note || '');
      await writeAudit(session.userId, 'adjust_wallet', { userId, amount, balance: bal });
      return NextResponse.json({ ok: true, balance: bal });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
