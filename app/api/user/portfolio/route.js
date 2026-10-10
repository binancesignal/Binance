import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getExchangeKeys } from '../../../../lib/database/users.js';
import { getAccountOverview, explainKeyError } from '../../../../lib/exchange/account.js';
import { getOpenExecutions } from '../../../../lib/database/executions.js';
import { listTpOptions, normalizeTpLevel } from '../../../../lib/trading/tpSelect.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** GET /api/user/portfolio?exchange=bybit|binance — live balance, positions, open orders. */
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const exchange = String(new URL(req.url).searchParams.get('exchange') || 'bybit').toLowerCase();
  if (exchange !== 'bybit' && exchange !== 'binance') {
    return NextResponse.json({ error: 'exchange must be bybit or binance' }, { status: 400 });
  }
  try {
    const keys = await getExchangeKeys(session.userId, exchange);
    if (!keys) return NextResponse.json({ ok: true, connected: false, exchange });
    try {
      const o = await getAccountOverview(exchange, keys.mode, keys.apiKey, keys.apiSecret);
      // Attach bot TP1/2/3 levels from open executions so the Trade UI can switch targets
      let positions = o.positions || [];
      try {
        const execs = await getOpenExecutions({ userId: session.userId, exchange });
        const byKey = new Map();
        for (const e of execs || []) {
          const k = `${String(e.symbol || '').toUpperCase()}:${String(e.side || '').toUpperCase()}`;
          byKey.set(k, e);
        }
        positions = positions.map((p) => {
          const k = `${String(p.symbol || '').toUpperCase()}:${String(p.direction || '').toUpperCase()}`;
          const e = byKey.get(k);
          if (!e) return p;
          const levels = {
            tp1: e.tp1 ?? e.metadata?.tp1 ?? null,
            tp2: e.tp2 ?? e.metadata?.tp2 ?? null,
            tp3: e.tp3 ?? e.metadata?.tp3 ?? null,
          };
          return {
            ...p,
            tp1: levels.tp1,
            tp2: levels.tp2,
            tp3: levels.tp3,
            tpOptions: listTpOptions(levels),
            activeTpLevel: normalizeTpLevel(e.metadata?.activeTpLevel ?? e.metadata?.preferredTpLevel ?? 1, 1),
            executionId: e.id,
            signalId: e.signal_id,
          };
        });
      } catch (_) {}
      return NextResponse.json(
        { ok: true, connected: true, exchange, mode: keys.mode, key_hint: keys.key_hint, fetchedAt: Date.now(), ...o, positions },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    } catch (e) {
      return NextResponse.json({
        ok: false,
        connected: true,
        exchange,
        mode: keys.mode,
        key_hint: keys.key_hint,
        error: explainKeyError(exchange, keys.mode, e),
      });
    }
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
