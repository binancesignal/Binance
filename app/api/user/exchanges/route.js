import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import {
  getUserById,
  getPlan,
  canAutoTrade,
  getUserTradingSettings,
  setUserTradingSettings,
  saveExchangeKeys,
  getExchangeKeys,
  deleteExchangeKeys,
  listExchangeConnections,
} from '../../../../lib/database/users.js';
import { getAccountOverview, explainKeyError } from '../../../../lib/exchange/account.js';
import { setState } from '../../../../lib/database/appState.js';

export const dynamic = 'force-dynamic';

const EXCHANGES = ['bybit', 'binance'];
const isEx = (x) => EXCHANGES.includes(x);

async function state(userId) {
  const [connections, settings] = await Promise.all([
    listExchangeConnections(userId),
    getUserTradingSettings(userId),
  ]);
  const binanceConnections = connections.filter((connection) => connection.exchange === 'binance');
  const binanceAutoTradeEnabled =
    settings.autoTradingEnabled &&
    settings.autoTradeExchange === 'binance' &&
    binanceConnections.some((connection) => connection.exchange === 'binance');
  return {
    connections: binanceConnections,
    selectedExchange: 'binance',
    autoTradeExchange: binanceAutoTradeEnabled ? 'binance' : null,
    autoTradingEnabled: !!binanceAutoTradeEnabled,
    available: ['binance'],
  };
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true, ...(await state(session.userId)) });
}

/**
 * POST { action: 'connect',    exchange, mode: 'mock'|'live', apiKey, apiSecret, confirmLive? }
 *      { action: 'disconnect', exchange }
 *      { action: 'select',     exchange }                 → which exchange's signals/account to view
 *      { action: 'autotrade',  exchange: 'bybit'|'binance'|null, enabled }  → ONE exchange at a time
 */
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const exchange = String(body.exchange || '').toLowerCase();
    const userId = session.userId;

    if (action === 'connect') {
      if (!isEx(exchange)) return NextResponse.json({ error: 'exchange must be bybit or binance' }, { status: 400 });
      const mode = body.mode === 'live' ? 'live' : 'mock';
      const apiKey = String(body.apiKey || '').trim();
      const apiSecret = String(body.apiSecret || '').trim();
      if (!apiKey || !apiSecret) return NextResponse.json({ error: 'apiKey and apiSecret required' }, { status: 400 });
      if (mode === 'live' && body.confirmLive !== true) {
        return NextResponse.json(
          { error: 'Live mode uses real money. Confirm that you understand before connecting.', needsLiveConfirm: true },
          { status: 400 }
        );
      }
      // Verify against the exchange BEFORE saving: wrong keys / wrong mode are caught here.
      let overview;
      try {
        overview = await getAccountOverview(exchange, mode, apiKey, apiSecret);
      } catch (e) {
        return NextResponse.json({ error: explainKeyError(exchange, mode, e) }, { status: 400 });
      }
      await saveExchangeKeys(userId, exchange, { apiKey, apiSecret, mode });
      // first connection becomes the selected exchange
      const settings = await getUserTradingSettings(userId);
      const had = (await listExchangeConnections(userId)).filter((c) => c.exchange !== exchange);
      if (!had.length) await setUserTradingSettings(userId, { ...settings, selectedExchange: exchange });
      return NextResponse.json({
        ok: true,
        msg: `${exchange === 'bybit' ? 'Bybit' : 'Binance'} connected (${mode === 'live' ? 'LIVE' : 'MOCK'})`,
        equity: overview.balance.equity,
        ...(await state(userId)),
      });
    }

    if (action === 'disconnect') {
      if (!isEx(exchange)) return NextResponse.json({ error: 'exchange must be bybit or binance' }, { status: 400 });
      await deleteExchangeKeys(userId, exchange);
      const settings = await getUserTradingSettings(userId);
      const next = { ...settings };
      if (next.autoTradeExchange === exchange) {
        next.autoTradeExchange = null;
        next.autoTradingEnabled = false;
      }
      await setUserTradingSettings(userId, next);
      return NextResponse.json({ ok: true, msg: 'Disconnected', ...(await state(userId)) });
    }

    if (action === 'select') {
      if (exchange !== 'binance') return NextResponse.json({ error: 'The user dashboard is Binance-only' }, { status: 400 });
      const settings = await getUserTradingSettings(userId);
      await setUserTradingSettings(userId, { ...settings, selectedExchange: 'binance' });
      return NextResponse.json({ ok: true, ...(await state(userId)) });
    }

    if (action === 'autotrade') {
      const settings = await getUserTradingSettings(userId);
      if (body.enabled !== false && exchange !== 'binance') {
        return NextResponse.json({ error: 'User auto-trading is available for Binance only' }, { status: 400 });
      }
      const enabled = body.enabled !== false && isEx(exchange);
      if (!enabled) {
        await setUserTradingSettings(userId, { ...settings, autoTradingEnabled: false, autoTradeExchange: null });
        return NextResponse.json({ ok: true, msg: 'Auto-trade OFF', ...(await state(userId)) });
      }
      const user = await getUserById(userId);
      const plan = await getPlan(user.plan);
      if (!canAutoTrade(user, plan)) {
        return NextResponse.json({ error: 'Auto-trade requires an active Auto or Pro plan' }, { status: 403 });
      }
      const keys = await getExchangeKeys(userId, exchange);
      if (!keys) {
        return NextResponse.json({ error: `Connect ${exchange} first` }, { status: 400 });
      }
      // Exactly one exchange at a time: arming one automatically disarms the other.
      const replaced = settings.autoTradeExchange && settings.autoTradeExchange !== exchange ? settings.autoTradeExchange : null;
      await setUserTradingSettings(userId, { ...settings, autoTradingEnabled: true, autoTradeExchange: exchange });
      // re-arming is the explicit "resume" for the High Risk drawdown halt
      // must be {} not null — app_state.value is JSONB NOT NULL
      await setState(`risk_guard:${userId}`, {});
      return NextResponse.json({
        ok: true,
        msg: `Auto-trade ON for ${exchange === 'bybit' ? 'Bybit' : 'Binance'}${replaced ? ` (switched off ${replaced})` : ''}`,
        ...(await state(userId)),
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
