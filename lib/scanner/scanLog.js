/**
 * Scan log — per-coin / per-run record of what the scanner really did, so the admin can verify
 * a background scan (cron returns instantly) actually ran, and see every coin that was scanned.
 *
 * Stored in app_state (no migration needed):
 *   scan_live                         → { status:'running'|'idle', ... }  (progress marker)
 *   scan_last_run:<kind>:<exchange>   → latest run incl. the per-coin list   (kind = full | cron)
 *   scan_run_history:<kind>:<exchange>→ last N run summaries (no coin lists)
 *   coin_scan_status:<exchange>       → { SYMBOL: { at, run, kind, part, r, ms, f, c, u, e } }
 *
 * Every function here is best-effort: logging must NEVER break a scan.
 */
import { getState, setState } from '../database/appState.js';

export const HISTORY_MAX = 30;
export const COIN_STATUS_MAX = 1500;

export const logKind = (source, promoted = false) => (source === 'cron-full' || promoted ? 'full' : 'cron');

/** Result label for one coin (pure). */
export function classifyCoin({ noPrice, error, created, updated, skipped, found } = {}) {
  if (noPrice) return 'no_price';
  if (error) return 'error';
  if (created > 0) return 'created';
  if (updated > 0) return 'updated';
  if (skipped > 0) return 'skipped';
  if (found > 0) return 'filtered';
  return 'no_setup';
}

/** Merge a run's coins into the per-coin status map; keeps the newest COIN_STATUS_MAX entries (pure). */
export function mergeCoinStatus(map, coins, meta, max = COIN_STATUS_MAX) {
  const out = { ...(map || {}) };
  for (const c of coins) {
    out[c.s] = {
      at: meta.at,
      run: meta.runId ?? null,
      kind: meta.kind,
      part: meta.part ?? null,
      r: c.r,
      ms: c.ms,
      f: c.f || 0,
      c: c.c || 0,
      u: c.u || 0,
      ...(c.e ? { e: String(c.e).slice(0, 120) } : {}),
    };
  }
  const keys = Object.keys(out);
  if (keys.length > max) {
    keys
      .sort((a, b) => String(out[a].at).localeCompare(String(out[b].at)))
      .slice(0, keys.length - max)
      .forEach((k) => delete out[k]);
  }
  return out;
}

export async function recordScanStart(meta) {
  try {
    await setState('scan_live', { status: 'running', ...meta, startedAt: meta.startedAt || new Date().toISOString() });
  } catch (e) {
    console.error('[scanLog] start', e.message);
  }
}

/**
 * run: { runId, kind, source, exchange, strategy, part, parts, totalSymbols, startedAt, durationMs,
 *        budgetMs, partial, status, created, updated, errorCount, errors }
 * coins: [{ s, r, ms, price, f, c, u, sk, e }]   pending: symbols not reached (budget hit)
 */
export async function recordScanFinish(run, coins = [], pending = []) {
  try {
    const finishedAt = new Date().toISOString();
    const exchange = run.exchange || 'binance';
    const kind = run.kind || 'cron';
    const counts = {};
    for (const c of coins) counts[c.r] = (counts[c.r] || 0) + 1;
    const full = { ...run, finishedAt, scanned: coins.length, counts, coins, pending: pending.slice(0, 600) };
    await setState(`scan_last_run:${kind}:${exchange}`, full);

    const histKey = `scan_run_history:${kind}:${exchange}`;
    const hist = (await getState(histKey, [])) || [];
    const { errors, ...summary } = run;
    hist.unshift({ ...summary, finishedAt, scanned: coins.length, counts, pendingCount: pending.length, errors: (errors || []).slice(0, 3) });
    await setState(histKey, hist.slice(0, HISTORY_MAX));

    const statusKey = `coin_scan_status:${exchange}`;
    const map = (await getState(statusKey, {})) || {};
    await setState(
      statusKey,
      mergeCoinStatus(map, coins, { at: finishedAt, runId: run.runId, kind, part: run.part })
    );
    await setState('scan_live', { status: 'idle', lastFinishedAt: finishedAt, lastKind: kind, lastRunId: run.runId ?? null });
  } catch (e) {
    console.error('[scanLog] finish', e.message);
  }
}

export async function recordScanFailure(run, message) {
  try {
    const finishedAt = new Date().toISOString();
    const exchange = run.exchange || 'binance';
    const kind = run.kind || 'cron';
    const histKey = `scan_run_history:${kind}:${exchange}`;
    const hist = (await getState(histKey, [])) || [];
    hist.unshift({ ...run, errors: undefined, status: 'FAILED', finishedAt, scanned: 0, counts: {}, pendingCount: 0, error: String(message).slice(0, 200) });
    await setState(histKey, hist.slice(0, HISTORY_MAX));
    await setState('scan_live', { status: 'idle', lastFinishedAt: finishedAt, lastKind: kind, lastFailed: true, lastError: String(message).slice(0, 200) });
  } catch (e) {
    console.error('[scanLog] failure', e.message);
  }
}
