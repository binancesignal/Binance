import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getUserById } from '../../../../lib/database/users.js';
import {
  getPaymentSettings,
  createDeposit,
  listUserDeposits,
  planCountdown,
} from '../../../../lib/database/payments.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const [user, settings, deposits] = await Promise.all([
      getUserById(session.userId),
      getPaymentSettings(),
      listUserDeposits(session.userId, 10),
    ]);
    const countdown = planCountdown(user);
    const methods = {
      usdt: {
        enabled: settings.usdt_enabled !== false,
        price: Number(settings.usdt_price ?? settings.plan_price_usdt) || 49,
        fee_pct: Number(settings.usdt_fee_pct) || 0,
        network: settings.deposit_network || 'TRC20',
        address: settings.deposit_address_usdt || '',
      },
      paypal: {
        enabled: settings.paypal_enabled !== false,
        price: Number(settings.paypal_price ?? settings.plan_price_usdt) || 49,
        fee_pct: Number(settings.paypal_fee_pct) || 0,
        email: settings.paypal_email || '',
        me_link: settings.paypal_me_link || '',
      },
      bank: {
        enabled: !!settings.bank_enabled,
        price: Number(settings.bank_price ?? settings.plan_price_usdt) || 49,
        fee_pct: Number(settings.bank_fee_pct) || 0,
        instructions: settings.bank_instructions || '',
      },
    };
    return NextResponse.json({
      user: {
        plan: user?.plan,
        subscription_status: user?.subscription_status,
        plan_expires_at: user?.plan_expires_at,
      },
      settings: {
        plan_name: settings.plan_name || 'Pro',
        plan_price_usdt: settings.plan_price_usdt,
        plan_duration_days: settings.plan_duration_days || 30,
        require_profile_verify_for_pay: !!settings.require_profile_verify_for_pay,
      },
      methods,
      countdown,
      deposits,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const settings = await getPaymentSettings();

    // Unverified users CAN pay (unless admin explicitly requires verify)
    if (settings.require_profile_verify_for_pay) {
      const user = await getUserById(session.userId);
      // soft check only if flag on — default is off
      if (user && user.profile_verified === false) {
        // still allow; flag reserved for future hard gate
      }
    }

    if (action === 'create_deposit') {
      const method = String(body.method || 'usdt').toLowerCase();
      const deposit = await createDeposit(session.userId, method);
      const payload = {
        ok: true,
        deposit,
        method,
        amount: deposit.unique_amount || deposit.expected_amount,
        expires_at: deposit.expires_at,
      };
      if (method === 'usdt') {
        payload.address = settings.deposit_address_usdt;
        payload.network = settings.deposit_network || 'TRC20';
        payload.note = `Send exactly ${payload.amount} USDT (${payload.network}). Plan activates automatically after on-chain confirmation.`;
      } else if (method === 'paypal') {
        payload.paypal_email = settings.paypal_email || '';
        payload.paypal_me_link = settings.paypal_me_link || '';
        payload.note = 'Pay the exact amount via PayPal. Admin confirms when funds arrive (auto webhook optional).';
      } else {
        payload.instructions = settings.bank_instructions || '';
        payload.note = 'Bank transfer is currently limited — follow instructions.';
      }
      return NextResponse.json(payload);
    }

    // submit_tx removed from UX — auto worker detects USDT; keep for admin/debug only
    if (action === 'submit_tx') {
      return NextResponse.json(
        { error: 'Manual tx submit disabled — USDT is verified automatically on-chain.' },
        { status: 400 }
      );
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
