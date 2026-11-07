import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getState, setState } from '../../../../lib/database/appState.js';
import {
  FIB_SIGNALS_CONFIG_KEY,
  FIB_SIGNALS_CURSOR_KEY,
  FIB_SIGNALS_STATUS_KEY,
  FIB_SIGNALS_STORE_KEY,
  FIB_SIGNALS_LOCK_KEY,
  FIB_SIGNALS_INVALID_KEY,
  OB_FIB_LEVELS,
  OB_FIB_TFS,
  OB_FIB_REF_TFS,
  normalizeFibSignalsConfig,
} from '../../../../lib/fibSignals/config.js';
import { runFibSignalsPass, getFibSignalsConfig } from '../../../../lib/fibSignals/runner.js';
import { loadStore, loadInvalid } from '../../../../lib/fibSignals/store.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

async function snapshot() {
  const [config, status, cursor, store, invalidStore] = await Promise.all([
    getFibSignalsConfig(),
    getState(FIB_SIGNALS_STATUS_KEY, null),
    getState(FIB_SIGNALS_CURSOR_KEY, null),
    loadStore(),
    loadInvalid(),
  ]);
  const active = store.signals.filter((s) => s.status === 'ACTIVE').length;
  return {
    ok: true,
    config,
    status,
    cursor,
    counts: { active, closed: store.signals.length - active, invalid: invalidStore.items.length },
    options: { levels: OB_FIB_LEVELS, ltfs: OB_FIB_TFS, refTfs: OB_FIB_REF_TFS },
  };
}

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  return NextResponse.json(await snapshot());
}

/** PUT { config }  → save selections / ON-OFF */
export async function PUT(request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const cfg = normalizeFibSignalsConfig(body.config || body);
  await setState(FIB_SIGNALS_CONFIG_KEY, cfg);
  // a changed selection starts a fresh sweep
  await setState(FIB_SIGNALS_CURSOR_KEY, { offset: 0, cycles: 0, at: new Date().toISOString() });
  return NextResponse.json({ ...(await snapshot()), saved: true });
}

/** POST { action: 'run', reset? } → one pass now (client repeats until sweepDone) · { action: 'clear' } → wipe published signals */
export async function POST(request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  if (body.action === 'clear') {
    await setState(FIB_SIGNALS_STORE_KEY, { v: 1, signals: [] });
    await setState(FIB_SIGNALS_INVALID_KEY, { v: 1, items: [] });
    await setState(FIB_SIGNALS_CURSOR_KEY, { offset: 0, cycles: 0, at: new Date().toISOString() });
    return NextResponse.json({ ...(await snapshot()), cleared: true });
  }
  if (body.action === 'unlock') {
    await setState(FIB_SIGNALS_LOCK_KEY, { at: 0 });
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'run') {
    const result = await runFibSignalsPass({ source: 'admin', force: true, budgetMs: 40_000, resetCursor: !!body.reset });
    return NextResponse.json({ ...(await snapshot()), result });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
