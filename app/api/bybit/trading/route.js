import { NextResponse } from 'next/server';
import { getState } from '../../../../lib/database/appState.js';
import {
  getWalletBalance,
  getPositions,
  getOpenOrders,
  getOrderHistory,
  placeOrder,
  cancelOrder,
  getOrderRealtime,
  setTradingStop,
  createInternalTransfer,
} from '../../../../lib/bybit/client.js';

export const dynamic = 'force-dynamic';

async function keys() {
  const apiKey = await getState('bybit_api_key', null);
  const apiSecret = await getState('bybit_api_secret', null);
  if (!apiKey || !apiSecret) {
    const err = new Error('Bybit API keys not saved. Add them in Bybit API section.');
    err.status = 400;
    throw err;
  }
  return { apiKey, apiSecret };
}

export async function GET() {
  try {
    const { apiKey, apiSecret } = await keys();
    let balance = null;
    let balanceError = null;
    try {
      balance = await getWalletBalance(apiKey, apiSecret, 'UNIFIED');
    } catch (e) {
      try {
        balance = await getWalletBalance(apiKey, apiSecret, 'CONTRACT');
      } catch (e2) {
        balanceError = e2.message || e.message;
      }
    }
    let positions = [];
    let positionsError = null;
    let openOrders = [];
    let openOrdersError = null;
    let history = [];
    let historyError = null;
    try {
      positions = await getPositions(apiKey, apiSecret);
    } catch (e) {
      positionsError = e.message;
    }
    try {
      openOrders = await getOpenOrders(apiKey, apiSecret);
    } catch (e) {
      openOrdersError = e.message;
    }
    try {
      history = await getOrderHistory(apiKey, apiSecret);
    } catch (e) {
      historyError = e.message;
    }
    return NextResponse.json({
      ok: true,
      balance,
      balanceError,
      positions,
      positionsError,
      openOrders,
      openOrdersError,
      history,
      historyError,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}

export async function POST(request) {
  try {
    const { apiKey, apiSecret } = await keys();
    const body = await request.json().catch(() => ({}));
    const action = body.action;

    if (action === 'place') {
      if (!body.symbol || !body.side || !body.qty) {
        return NextResponse.json({ error: 'symbol, side, qty required' }, { status: 400 });
      }
      const result = await placeOrder(apiKey, apiSecret, body);
      if (!result.orderId) {
        return NextResponse.json(
          {
            ok: false,
            unknown: true,
            result,
            error: `Bybit retCode=${result.retCode ?? 'missing'} retMsg=${result.retMsg || 'No response message'}; no orderId was returned.`,
          },
          { status: 202 }
        );
      }
      try {
        const order = await getOrderRealtime(apiKey, apiSecret, {
          symbol: body.symbol,
          orderId: result.orderId,
        });
        return NextResponse.json({
          ok: true,
          result,
          orderStatus: order?.orderStatus || 'ACCEPTED',
          verification: order ? 'VERIFIED' : 'PENDING',
          msg: order
            ? `Order accepted; exchange status ${order.orderStatus}.`
            : 'Order accepted; exchange order record is not visible yet.',
        });
      } catch (verifyError) {
        return NextResponse.json(
          {
            ok: true,
            result,
            orderStatus: 'VERIFY_UNKNOWN',
            verification: 'UNKNOWN',
            verificationError: verifyError.message,
            msg: 'Order accepted, but its exchange status could not be verified.',
          },
          { status: 202 }
        );
      }
    }
    if (action === 'cancel') {
      if (!body.symbol || !body.orderId) {
        return NextResponse.json({ error: 'symbol and orderId required' }, { status: 400 });
      }
      const result = await cancelOrder(apiKey, apiSecret, body);
      return NextResponse.json({ ok: true, result, msg: 'Order cancelled' });
    }
    if (action === 'tradingStop') {
      const result = await setTradingStop(apiKey, apiSecret, body);
      return NextResponse.json({ ok: true, result, msg: 'TP/SL updated' });
    }
    if (action === 'transfer') {
      const result = await createInternalTransfer(apiKey, apiSecret, body);
      return NextResponse.json({ ok: true, result, msg: 'Transfer submitted' });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 400 });
  }
}
