import { NextResponse, after } from 'next/server';
import { runFullScan, getFullScanBudgetMs } from '../../../../lib/scanner/scanner.js';
import { isProductionDbReady } from '../../../../lib/database/index.js';
import { getState, setState } from '../../../../lib/database/appState.js';
import { normalizeParts } from '../../../../lib/scanner/scanParts.js';
import { processAutoTrades } from '../../../../lib/trading/autoTrader.js';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Full discovery scan (like Scan Now) — intended for a 5-minute cron.
 * - Sweeps the WHOLE coin universe (top volume first) within a time budget
 *   (app_state `full_scan_budget_seconds`, env FULL_SCAN_BUDGET_SECONDS, default 40s);
 *   anything left over is continued by the 1-min cron via the persisted cursor
 * - Creates NEW signals + updates the levels of existing WATCHING/READY signals in place
 *   (same coin/direction/strategy/pattern/tf). ONGOING / closed signals are never touched
 * - Concurrent with 1-min cron: full-scan WAITS for the lock (up to ~55s).
 *   If still busy, it is DEFERRED (pending_full_scan) — the next 1-min cron
 *   promotes itself to a full discovery pass. Full-scan is never silently lost.
 *
 * BACKGROUND MODE (default): the route answers within milliseconds ({started:true}) and runs the
 * scan in `after()` — so cron-job.org's 30s timeout can no longer fail the job, however long the
 * scan takes (up to maxDuration). Check progress/results in Admin → Scan log.
 * Add `&wait=1` to get the old behaviour (hold the response until the scan finishes) for debugging.
 *
 * GET/POST /api/cron/full-scan?secret=CRON_SECRET
 */
async function handle(request) {
  const routeStartedAt = Date.now();
  const authHeader = request.headers.get('authorization') || '';
  const cronSecret = process.env.CRON_SECRET;
  const url = new URL(request.url);
  const querySecret = url.searchParams.get('secret');

  if (cronSecret) {
    const token = authHeader.replace(/^Bearer\s+/i, '') || querySecret;
    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  try {
    const enabled = await getState('auto_scan_enabled', false);
    if (!enabled) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: 'auto_scan_enabled is false — enable from admin panel',
      });
    }
  } catch (e) {
    console.error('[cron/full-scan] auto_scan check', e.message);
  }

  if (process.env.NODE_ENV === 'production' && !isProductionDbReady()) {
    return NextResponse.json(
      { error: 'Supabase not configured' },
      { status: 503 }
    );
  }

  const wait = url.searchParams.get('wait') === '1';
  if (wait) {
    const out = await executeFullScan(routeStartedAt);
    return NextResponse.json(out.body, { status: out.status });
  }

  // Background: respond now, scan after the response has been sent.
  after(async () => {
    try {
      const out = await executeFullScan(routeStartedAt);
      if (out.status >= 400) console.error('[cron/full-scan] background run failed', JSON.stringify(out.body));
    } catch (e) {
      console.error('[cron/full-scan] background crash', e);
    }
  });
  return NextResponse.json({
    ok: true,
    started: true,
    background: true,
    msg: 'full-scan started in background — see Admin → Scan log for the result',
  });
}

/** The actual scan job. Returns { status, body } (not a Response) so it can run inside after(). */
async function executeFullScan(routeStartedAt) {
  try {
    const intervalMin = Math.max(
      1,
      Math.min(60, +(await getState('full_scan_interval_minutes', 5)) || 5)
    );
    const universe = (await getState('full_scan_universe', null)) || 'all';
    const chunkSize = +(await getState('full_scan_chunk_size', null)) || 0; // 0 = use default config

    // Split scan: scan the universe in N parts, one part per tick (default 3; 1 = old full sweep)
    const parts = normalizeParts(await getState('full_scan_parts', null), 3);
    const options = {
      resetCursor: parts <= 1,
      parts,
      universe: universe === 'all' || universe === '' ? 'all' : +universe || 'all',
    };
    if (chunkSize > 0) options.chunkSize = chunkSize;

    const budgetMs = await getFullScanBudgetMs();
    const result = await runFullScan('cron-full', {
      ...options,
      mode: 'full',
      fullScan: true,
      budgetMs,
      // 1-min scans normally finish well inside this; if not, the full-scan is deferred
      // (pending_full_scan) and the next 1-min cron promotes itself to a full sweep.
      lockWaitMs: 15_000,
    });

    // Record schedule timestamps for UI countdown (even if deferred — ring stays honest)
    const nowIso = new Date().toISOString();
    // Next run is anchored to when THIS cron fired (not when it finished), because the external
    // cron fires on a fixed clock; otherwise the ring would drift by the scan duration.
    const nextIso = new Date(routeStartedAt + intervalMin * 60 * 1000).toISOString();
    try {
      if (!result.deferred) {
        await setState('last_full_scan_at', nowIso);
        await setState('last_full_scan_summary', {
          at: nowIso,
          scanned: result.symbolsScanned ?? 0,
          total: result.coverage?.totalSymbols ?? null,
          partial: !!result.partial,
          part: result.coverage?.partsMode ? result.coverage.part : null,
          parts: result.coverage?.partsMode ? result.coverage.parts : null,
          byExchange: result.byExchange || null,
          created: result.signalsCreated ?? 0,
          updated: result.signalsUpdated ?? 0,
          durationMs: Date.now() - routeStartedAt,
        });
      }
      await setState('full_scan_interval_minutes', intervalMin);
      await setState('next_full_scan_at', nextIso);
      if (result.deferred) {
        await setState('pending_full_scan', {
          at: nowIso,
          reason: result.reason || 'deferred',
        });
      }
    } catch (e) {
      console.error('[cron/full-scan] schedule state', e.message);
    }

    let autoTrade = {
      autoTradingEnabled: false,
      autoTradesAttempted: 0,
      autoTradesPlaced: 0,
      autoTradesSkipped: 0,
      autoTradesFailed: 0,
    };
    try {
      if (result.ok && !result.skipped && !result.deferred) {
        autoTrade = await processAutoTrades();
      }
    } catch (ae) {
      console.error('[cron/full-scan] auto-trade', ae.message);
      autoTrade.autoTradesFailed = 1;
      autoTrade.error = ae.message;
    }

    return { status: 200, body: {
      ok: !!result.ok,
      skipped: !!result.skipped,
      mode: 'full',
      scanRunId: result.scanRunId ?? null,
      symbolsScanned: result.symbolsScanned ?? 0,
      signalsCreated: result.signalsCreated ?? 0,
      signalsUpdated: result.signalsUpdated ?? 0,
      watching: result.watching_count ?? 0,
      ready: result.ready_count ?? 0,
      ongoing: result.ongoing_count ?? 0,
      telegramSent: result.telegramSent ?? 0,
      errorCount: result.errorCount ?? 0,
      intervalMinutes: intervalMin,
      lastFullScanAt: nowIso,
      nextFullScanAt: nextIso,
      totalSymbols: result.coverage?.totalSymbols ?? null,
      partial: !!result.partial,
      byExchange: result.byExchange || null,
      budgetSeconds: Math.round(budgetMs / 1000),
      scanParts: parts,
      part: result.coverage?.partsMode ? result.coverage.part : null,
      autoTradesPlaced: autoTrade.autoTradesPlaced ?? 0,
      deferred: !!result.deferred,
      pendingFullScan: !!result.pendingFullScan,
      waitedMs: result.waitedMs ?? 0,
      msg: result.deferred
        ? `full-scan DEFERRED (will run on next cron): ${result.reason || 'lock busy'}`
        : result.ok
          ? `full-scan: ${result.symbolsScanned ?? 0} symbols, +${result.signalsCreated ?? 0} new, ~${result.signalsUpdated ?? 0} updated`
          : result.reason || result.error || 'failed',
    },
    };
  } catch (e) {
    console.error('[cron/full-scan]', e);
    return { status: 500, body: { ok: false, error: String(e.message || e).slice(0, 200) } };
  }
}

export async function GET(request) {
  return handle(request);
}
export async function POST(request) {
  return handle(request);
}
