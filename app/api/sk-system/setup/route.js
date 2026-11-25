import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../../lib/skSystem/access.js';
import * as store from '../../../../lib/skSystem/store.js';
import { bucketOf } from '../../../../lib/skSystem/lifecycle.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/sk-system/setup?id=…[&stage=ENTRY_READY]
 * Returns the stored setup with its ORIGINAL analysis (never recalculated from today's market).
 * `stage` selects the snapshot taken when that stage was first reached; default = latest stored analysis.
 */
export async function GET(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  try {
    const q = new URL(request.url).searchParams;
    const id = String(q.get('id') || '');
    if (!/^sk2?_[A-Z0-9]+_(LONG|SHORT)_\d+$/.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
    const setup = await store.getSetup(id);
    if (!setup) return NextResponse.json({ error: 'setup not found' }, { status: 404 });
    const [events, snapshots] = await Promise.all([store.listEvents(id), store.listSnapshots(id)]);
    let analysis = setup.analysis;
    let snapshot = null;
    const stage = q.get('stage');
    if (stage) {
      const snap = await store.getSnapshot(id, stage);
      if (snap) {
        analysis = snap.analysis;
        snapshot = { stage: snap.stage, at: snap.created_at };
      }
    }
    return NextResponse.json({ ok: true, setup: { ...setup, analysis: undefined, bucket: bucketOf(setup) }, analysis, snapshot, events, snapshots }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
