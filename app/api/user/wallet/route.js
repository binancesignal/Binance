import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import {
  getWalletBalance,
  listLedger,
  listUserWithdrawals,
  createWithdrawal,
  getPaymentSettings,
  getCoinPrices,
} from '../../../../lib/database/payments.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const [balance, ledger, withdrawals, settings, prices] = await Promise.all([
      getWalletBalance(session.userId),
      listLedger(session.userId, 30),
      listUserWithdrawals(session.userId, 20),
      getPaymentSettings(),
      getCoinPrices(),
    ]);
    return NextResponse.json({
      balance,
      withdraw_min_usdt: settings.withdraw_min_usdt,
      withdraw_fee_usdt: settings.withdraw_fee_usdt,
      withdraw_coins: settings.withdraw_coins,
      prices,
      ledger,
      withdrawals,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** POST { amount_usdt, coin, address, network? } */
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const w = await createWithdrawal(session.userId, {
      amount_usdt: body.amount_usdt,
      coin: body.coin || 'USDT',
      address: body.address,
      network: body.network,
    });
    return NextResponse.json({
      ok: true,
      withdrawal: w,
      message: 'Withdraw request submitted. It will be processed shortly.',
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
