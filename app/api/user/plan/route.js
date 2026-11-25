import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getUserById } from '../../../../lib/database/users.js';
import {
  getPaymentSettings,
  createDeposit,
  submitDepositTx,
  listUserDeposits,
  planCountdown,
} from '../../../../lib/database/payments.js';

export const dynamic = 'force-dynamic';

async function requireUser() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  return { session };
}

/** GET — plan config + countdown + deposit history */
export async function GET() {
  const { session, error } = await requireUser();
  if (error) return error;
  try {
    const [settings, user, deposits] = await Promise.all([
      getPaymentSettings(),
      getUserById(session.userId),
      listUserDeposits(session.userId, 10),
    ]);
    return NextResponse.json({
      settings: {
        plan_name: settings.plan_name,
        plan_price_usdt: settings.plan_price_usdt,
        plan_duration_days: settings.plan_duration_days,
        deposit_address_usdt: settings.deposit_address_usdt,
        deposit_network: settings.deposit_network,
      },
      user: {
        plan: user?.plan,
        subscription_status: user?.subscription_status,
        plan_expires_at: user?.plan_expires_at,
        trial_ends_at: user?.trial_ends_at,
      },
      countdown: planCountdown(user),
      deposits,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST actions:
 *  { action: 'create_deposit' }
 *  { action: 'submit_tx', deposit_id, tx_hash }
 */
export async function POST(req) {
  const { session, error } = await requireUser();
  if (error) return error;
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'create_deposit';

    if (action === 'create_deposit') {
      const settings = await getPaymentSettings();
      if (!settings.deposit_address_usdt) {
        return NextResponse.json(
          { error: 'Deposit address not configured. Contact admin.' },
          { status: 400 }
        );
      }
      const deposit = await createDeposit(session.userId);
      return NextResponse.json({
        ok: true,
        deposit,
        address: settings.deposit_address_usdt,
        network: settings.deposit_network,
        amount: deposit.unique_amount,
        note: `Send exactly ${deposit.unique_amount} USDT (${settings.deposit_network}). Unique amount helps us match your payment.`,
      });
    }

    if (action === 'submit_tx') {
      if (!body.deposit_id) {
        return NextResponse.json({ error: 'deposit_id required' }, { status: 400 });
      }
      const deposit = await submitDepositTx(session.userId, body.deposit_id, body.tx_hash);
      return NextResponse.json({
        ok: true,
        deposit,
        message: 'Payment submitted. Admin will confirm shortly — plan activates after confirmation.',
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
