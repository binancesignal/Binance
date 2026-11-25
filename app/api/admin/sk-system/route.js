import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/auth/session.js';
import { getState, setState } from '../../../../lib/database/appState.js';
import { SK_CONFIG_KEY, SK_CONFIG2_KEY, SK_LOCK_KEY, SK_DEFAULTS, SK_DEFAULTS_2, SK_PRIMARY_TFS_2, SK_CONFIRM_TFS_2, SK_ALL_TFS, SK_PRIMARY_TFS, SK_CONFIRM_TFS, SK_FIB_LEVELS, SK_RANKINGS, SK_TOP_PRESETS, SK_STAGES, validateSkConfig } from '../../../../lib/skSystem/config.js';
import { getSkConfig } from '../../../../lib/skSystem/runner.js';

const keyOf = (no) => (no === 2 ? SK_CONFIG2_KEY : SK_CONFIG_KEY);
import * as store from '../../../../lib/skSystem/store.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

async function snapshot(extra = {}) {
  let counts = null;
  let migration = 'ok';
  try {
    const rows = await store.listSetups({ limit: 1000 });
    counts = { total: rows.length, open: rows.filter((s) => s.status === 'OPEN').length };
  } catch (e) {
    migration = e.code === 'SK_MIGRATION_MISSING' ? 'missing' : 'error';
  }
  return {
    ok: true,
    config: await getSkConfig(1),
    config2: await getSkConfig(2),
    defaults: SK_DEFAULTS,
    defaults2: SK_DEFAULTS_2,
    options: { tfs: SK_ALL_TFS, primaryTfs: SK_PRIMARY_TFS, confirmTfs: SK_CONFIRM_TFS, fibLevels: SK_FIB_LEVELS, rankings: SK_RANKINGS, topPresets: SK_TOP_PRESETS, stages: SK_STAGES },
    options2: { primaryTfs: SK_PRIMARY_TFS_2, confirmTfs: SK_CONFIRM_TFS_2 },
    counts,
    migration,
    ...extra,
  };
}

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  return NextResponse.json(await snapshot());
}

/** PUT { setup?: 1|2, config } — setup 2 saves the intraday setup's own settings (scan settings stay shared with Setup 1). Validated on the server; `notes` lists anything that was rejected / clamped. Other strategies are untouched. */
export async function PUT(request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const no = +body.setup === 2 ? 2 : 1;
  // Setup 2 merges into its OWN stored record (scan-level fields are read from Setup 1 at run time, so they are ignored here)
  const stored = no === 2 ? (await getState(SK_CONFIG2_KEY, null)) || {} : await getSkConfig(1);
  const { setup: _s, ...patch } = body.config || body;
  const merged = { ...stored, ...patch };
  const { config, notes } = validateSkConfig(merged, no);
  await setState(keyOf(no), config);
  return NextResponse.json(await snapshot({ saved: true, notes }));
}

/** POST { action:'unlock' } | { action:'reset-defaults' } | { action:'clear-history', confirm:'DELETE' } */
export async function POST(request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  if (body.action === 'unlock') {
    await setState(SK_LOCK_KEY, { at: 0 });
    const run = await store.getLatestRun();
    if (run) await setState(`${SK_LOCK_KEY}:${run.id}`, { at: 0 });
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'reset-defaults') {
    const no = +body.setup === 2 ? 2 : 1;
    await setState(keyOf(no), validateSkConfig({}, no).config);
    return NextResponse.json(await snapshot({ saved: true }));
  }
  if (body.action === 'clear-history') {
    if (body.confirm !== 'DELETE') return NextResponse.json({ error: 'confirm must be "DELETE"' }, { status: 400 });
    await store.clearAll();
    return NextResponse.json(await snapshot({ cleared: true }));
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
