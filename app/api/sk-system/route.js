import { NextResponse } from 'next/server';
import { requireSkReadAccess } from '../../../lib/skSystem/access.js';
import * as store from '../../../lib/skSystem/store.js';
import { getSkConfigs } from '../../../lib/skSystem/runner.js';
import { bucketOf } from '../../../lib/skSystem/lifecycle.js';
import { SK_STAGES } from '../../../lib/skSystem/config.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

const QUALITY_MIN = { STRONG: 80, VALID: 65, WEAK: 0 };

function summary(s) {
  const { analysis, ...rest } = s;
  const steps = analysis?.steps;
  return { ...rest, bucket: bucketOf(s), isNew: s.status === 'OPEN' && Date.now() - Date.parse(s.createdAt) < 24 * 3600_000, stepsDone: steps ? steps.filter((x) => x.status === 'CONFIRMED').length : null, stepsTotal: steps ? steps.length : null };
}

/**
 * GET /api/sk-system?bucket=&symbol=&dir=&stage=&tf=&from=&to=&quality=&minScore=&limit=
 * bucket: new · active · waiting · entry_ready · ongoing · completed · invalidated · expired · history (all)
 */
export async function GET(request) {
  const auth = await requireSkReadAccess();
  if (auth.error) return auth.error;
  const { session, isAdmin } = auth;
  try {
    const q = new URL(request.url).searchParams;
    const dir = q.get('dir');
    const stage = q.get('stage');
    const quality = q.get('quality');
    const filters = {
      symbol: (q.get('symbol') || '').trim().toUpperCase() || undefined,
      dir: dir === 'LONG' || dir === 'SHORT' ? dir : undefined,
      stage: SK_STAGES.includes(stage) ? stage : undefined,
      tf: q.get('tf') || undefined,
      setup: +q.get('setup') === 2 ? 2 : +q.get('setup') === 1 ? 1 : undefined,
      from: q.get('from') || undefined,
      to: q.get('to') ? new Date(Date.parse(q.get('to')) + 86400_000).toISOString() : undefined,
      minScore: q.get('minScore') ? +q.get('minScore') : quality && QUALITY_MIN[quality] ? QUALITY_MIN[quality] : undefined,
      limit: Math.min(1000, Math.max(1, +q.get('limit') || 300)),
    };
    const [rows, cfgs, run] = await Promise.all([store.listSetups({ ...filters, limit: 1000 }), getSkConfigs(), store.getLatestRun(isAdmin ? session.userId : undefined)]);
    const cfg = cfgs[1];
    const cfg2 = cfgs[2];
    let list = rows.filter((s) => (quality === 'WEAK' ? s.score < 65 : quality === 'VALID' ? s.score >= 65 && s.score < 80 : quality === 'STRONG' ? s.score >= 80 : true)).map(summary);
    const counts = { all: list.length };
    for (const s of list) {
      counts[s.bucket] = (counts[s.bucket] || 0) + 1;
      if (s.isNew) counts.new = (counts.new || 0) + 1;
    }
    // Admin-configured visible buckets (empty / missing = all open-relevant buckets)
    const visible = Array.isArray(cfg.visibleBuckets) && cfg.visibleBuckets.length
      ? new Set(cfg.visibleBuckets)
      : null;
    if (visible && !isAdmin) {
      list = list.filter((s) => visible.has(s.bucket) || (s.isNew && visible.has('new')));
    }
    const bucket = q.get('bucket') || 'all';
    if (bucket === 'new') list = list.filter((s) => s.isNew);
    else if (bucket !== 'all' && bucket !== 'history') list = list.filter((s) => s.bucket === bucket);
    // history = everything; other tabs: newest activity first
    list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return NextResponse.json(
      {
        ok: true,
        setups: list.slice(0, Math.min(filters.limit, cfg.maxHistory + 200)),
        counts,
        run: run && { id: run.id, status: run.status, total: run.total, analyzed: run.analyzed, ok: run.ok, failed: run.failed, setupsFound: run.setupsFound, offset: run.offset, currentSymbol: run.currentSymbol, pausedReason: run.pausedReason, universe: run.universe, topN: run.topN, ranking: run.ranking, setups: run.config?.setups || [1], startedAt: run.startedAt, finishedAt: run.finishedAt, failedSymbols: (run.failedSymbols || []).slice(-20) },
        // read-only strategy settings (edited by the admin in Admin → SK System)
        // Setup 2 (intraday 1H) — same shape, shown next to Setup 1 in the strategy-settings box
        config2: { enabled: cfg2.enabled, primaryTf: cfg2.primaryTf, confirmTfs: cfg2.confirmTfs, htfAlignment: cfg2.htfAlignment, swingSensitivity: cfg2.swingSensitivity, fibLevels: cfg2.fibLevels, cZone: [cfg2.cZoneFrom, cfg2.cZoneTo], entryFib: [cfg2.entryFibFrom, cfg2.entryFibTo], entryMode: cfg2.entryMode, minScore: cfg2.minScore, minRR: cfg2.minRR, tpMethod: cfg2.tpMethod, slBufferAtr: cfg2.slBufferAtr, dExtension: cfg2.dExtension },
        config: { enabled: cfg.enabled, scanUniverse: cfg.scanUniverse, topN: cfg.topN, rankingMethod: cfg.rankingMethod, primaryTf: cfg.primaryTf, confirmTfs: cfg.confirmTfs, htfAlignment: cfg.htfAlignment, swingSensitivity: cfg.swingSensitivity, fibLevels: cfg.fibLevels, cZone: [cfg.cZoneFrom, cfg.cZoneTo], entryFib: [cfg.entryFibFrom, cfg.entryFibTo], entryMode: cfg.entryMode, minScore: cfg.minScore, minRR: cfg.minRR, tpMethod: cfg.tpMethod, slBufferAtr: cfg.slBufferAtr, dExtension: cfg.dExtension },
        isAdmin,
        visibleBuckets: cfg.visibleBuckets || null,
        skEnabled: !!cfg.enabled,
        canScan: cfg.enabled && (isAdmin || cfg.userScanMax > 0),
        scanMax: isAdmin ? 600 : cfg.userScanMax,
        canAll: isAdmin || cfg.userScanMax >= 600,
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === 'SK_MIGRATION_MISSING' ? 503 : 500, headers: NO_STORE });
  }
}
