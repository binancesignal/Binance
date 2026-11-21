import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getExchangeKeys, getUserTradingSettings, setUserTradingSettings } from '../../../../lib/database/users.js';
import { getLedgerExecutions } from '../../../../lib/database/executions.js';
import * as binance from '../../../../lib/binance/private.js';
import { syncClosedTrades } from '../../../../lib/trading/pnlSync.js';
import {
  getCapital,
  buildLedger,
  setCapital,
  clearCapital,
  validateStartingCapital,
  MIN_STARTING_CAPITAL,
} from '../../../../lib/trading/capital.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function wallet(keys) {
  try {
    const a = await binance.getAccountSummary(keys.apiKey, keys.apiSecret, keys.mode);
    return {
      equity: a.totalMarginBalance || a.totalWalletBalance || 0,
      available: a.availableBalance || 0,
    };
  } catch (_) {
    return null;
  }
}

/** GET /api/user/capital - starting capital + the full trade-by-trade ledger for the chart. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const keys = await getExchangeKeys(session.userId, 'binance');
    if (!keys) return NextResponse.json({ ok: true, connected: false });
    const settings = await getUserTradingSettings(session.userId);
    const capital = getCapital(settings, keys.mode);

    let syncNote = null;
    if (capital) {
      try {
        const r = await syncClosedTrades({ userId: session.userId, keys });
        if (r.errors.length) syncNote = r.errors[0];
      } catch (e) {
        syncNote = e.message;
      }
    }
    const [w, rows] = await Promise.all([
      wallet(keys),
      capital
        ? getLedgerExecutions({ userId: session.userId, exchange: 'binance', mode: keys.mode }, capital.startedAt)
        : Promise.resolve([]),
    ]);
    return NextResponse.json(
      {
        ok: true,
        connected: true,
        mode: keys.mode,
        minStartingCapital: MIN_STARTING_CAPITAL,
        wallet: w,
        capital,
        ledger: capital ? buildLedger(capital, rows, keys.mode) : null,
        syncNote,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/user/capital
 *   { action: 'start', startingCapital }  - set (or restart with) a starting capital
 *   { action: 'stop' }                    - stop budgeting; the bot goes back to using the whole wallet
 * Restarting begins a fresh run: older trades stay in the database but leave the chart.
 */
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const keys = await getExchangeKeys(session.userId, 'binance');
    if (!keys) return NextResponse.json({ error: 'Connect Binance first' }, { status: 400 });
    const settings = await getUserTradingSettings(session.userId);

    if (body.action === 'stop') {
      await setUserTradingSettings(session.userId, clearCapital(settings, keys.mode));
      return NextResponse.json({ ok: true, capital: null });
    }
    if (body.action !== 'start') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    const w = await wallet(keys);
    const check = validateStartingCapital(body.startingCapital, w?.equity ?? null);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

    // a restart begins a fresh run, so positions still open on the exchange must finish first
    if (getCapital(settings, keys.mode)) {
      const positions = await binance.getPositionRisk(keys.apiKey, keys.apiSecret, keys.mode);
      if (positions.length) {
        return NextResponse.json(
          { error: `${positions.length} position(s) are still open. Restart the capital after they close.` },
          { status: 409 }
        );
      }
    }

    const next = setCapital(settings, keys.mode, check.amount);
    await setUserTradingSettings(session.userId, next);
    return NextResponse.json({ ok: true, capital: getCapital(next, keys.mode) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
