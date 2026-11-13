import { NextResponse } from 'next/server';
import { requireSkAccess } from '../../../../lib/skSystem/access.js';
import * as store from '../../../../lib/skSystem/store.js';
import { getSkConfigs, activeSetups, startRun, runChunk, setRunStatus } from '../../../../lib/skSystem/runner.js';
import { SK_TOP_PRESETS, SK_RANKINGS } from '../../../../lib/skSystem/config.js';
import { resolveScanRequest } from '../../../../lib/skSystem/universe.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const pub = (r) =>
  r && {
    id: r.id, status: r.status, total: r.total, analyzed: r.analyzed, ok: r.ok, failed: r.failed, setupsFound: r.setupsFound,
    offset: r.offset, currentSymbol: r.currentSymbol, pausedReason: r.pausedReason, universe: r.universe, topN: r.topN,
    ranking: r.ranking, setups: r.config?.setups || [1], startedAt: r.startedAt, finishedAt: r.finishedAt, failedSymbols: (r.failedSymbols || []).slice(-20),
    remaining: Math.max(0, r.total - r.analyzed), percent: r.total ? Math.round((r.analyzed / r.total) * 100) : 100,
  };

/** GET → latest scan run (resume after a page reload) */
export async function GET() {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ ok: true, run: pub(await store.getLatestRun(auth.session.userId)), presets: SK_TOP_PRESETS, rankings: SK_RANKINGS });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.code === 'SK_MIGRATION_MISSING' ? 503 : 500 });
  }
}

/**
 * POST — any signed-in user with access (admins: unlimited; users: capped by Admin → SK System → "Users: max coins per scan")
 *  { action:'start', mode:'all'|'top', topN?, ranking?, symbols? }  → creates a persisted run and processes the 1st chunk
 *  { action:'chunk', runId }    → continue (client repeats until status is completed / paused)
 *  { action:'stop', runId } · { action:'resume', runId }
 * A user can only drive their own runs.
 */
export async function POST(request) {
  const auth = await requireSkAccess();
  if (auth.error) return auth.error;
  const { session, isAdmin } = auth;
  try {
    const body = await request.json().catch(() => ({}));
    const cfgs = await getSkConfigs();
    const cfg = cfgs[1];
    if (!cfg.enabled) return NextResponse.json({ error: 'SK SYSTEM PRO is currently switched off by the admin' }, { status: 409 });
    const budgetMs = 40_000;
    if (body.action === 'start') {
      const req = resolveScanRequest({ cfg, isAdmin, body });
      if (!req.ok) return NextResponse.json({ error: req.error }, { status: 403 });
      const prev = await store.getLatestRun(session.userId);
      if (prev && prev.status === 'running') await setRunStatus(prev.id, 'stopped', 'replaced by a new scan');
      // body.setups: [1] · [2] · [1,2] (default = every enabled setup)
      const sets = activeSetups(cfgs, body.setups);
      if (!sets.length) return NextResponse.json({ error: 'The selected setup is switched off by the admin' }, { status: 409 });
      const run = await startRun({ cfg, cfgs, setups: sets, mode: req.mode, topN: req.topN, ranking: SK_RANKINGS.includes(body.ranking) ? body.ranking : cfg.rankingMethod, symbols: req.symbols, owner: session.userId });
      const out = run.status === 'running' ? await runChunk({ runId: run.id, cfg, cfgs, budgetMs, force: true }) : { run };
      return NextResponse.json({ ok: true, run: pub(out.run || run), notice: req.notice });
    }
    const runId = String(body.runId || '');
    if (!runId) return NextResponse.json({ error: 'runId required' }, { status: 400 });
    const existing = await store.getRun(runId);
    if (!existing) return NextResponse.json({ error: 'run not found' }, { status: 404 });
    if (!isAdmin && (existing.owner ?? null) !== session.userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (body.action === 'stop') return NextResponse.json({ ok: true, run: pub(await setRunStatus(runId, 'stopped', 'stopped by you')) });
    if (body.action === 'resume') {
      const run = await setRunStatus(runId, 'running');
      const out = await runChunk({ runId, cfg, cfgs, budgetMs, force: true });
      return NextResponse.json({ ok: true, run: pub(out.run || run) });
    }
    if (body.action === 'chunk') {
      const out = await runChunk({ runId, cfg, cfgs, budgetMs });
      return NextResponse.json({ ok: true, run: pub(out.run), skipped: out.skipped });
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message, banned: !!e.banned, throttled: !!e.throttled }, { status: e.code === 'SK_MIGRATION_MISSING' ? 503 : 500 });
  }
}
