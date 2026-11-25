/**
 * Pure helpers for the harmonic LIMIT auto-trade (no database / exchange imports → unit-testable).
 *
 * Rule: while a limit order is waiting for its fill (the trade is NOT "in trade" yet) the bot keeps
 * only the best ENTRY_READY signals of the board (best = highest score). When a better one appears
 * the weaker pending order is cancelled and a new limit is placed on the better one. If that better
 * signal later leaves ENTRY_READY while the weaker one is still ready, the weaker one gets its order back.
 *
 * How many limits may wait at the same time = admin setting `maxPendingLimitOrders` (default 1).
 */

export const PENDING_LIMIT_STATUSES = ['PENDING', 'PLACING', 'PLACED', 'WAITING_FILL', 'VERIFY_UNKNOWN'];
/** Order already filled → the trade is running ("in trade"); it no longer holds a pending slot. */
export const RUNNING_STATUSES = ['PROTECTING', 'FILLED', 'PROTECTED', 'UNPROTECTED', 'PARTIALLY_FILLED'];

const up = (v) => String(v ?? '').trim().toUpperCase();

/** Saved harmonic board item → the signal shape the Binance trader works with (null if not tradable). */
export function harmonicItemToSignal(e, { minScore = 0 } = {}) {
  if (!e?.symbol) return null;
  const st = up(e.status);
  if (st !== 'ENTRY_READY' && st !== 'READY') return null;
  const score = +e.score || 0;
  if (score < minScore) return null;
  const entry = e.entry ?? e.plan?.entry ?? e.D?.price;
  if (!(+entry > 0)) return null;
  const sl = e.sl ?? e.plan?.sl ?? null;
  const id =
    e.signal_id ||
    e.id ||
    `hs_${e.symbol}_${e.tf || ''}_${e.family || ''}_${e.direction || ''}_${e.C?.time || e.time || ''}`;
  return {
    signal_id: String(id),
    symbol: up(e.symbol),
    direction: up(e.direction || e.dir || 'LONG') === 'SHORT' ? 'SHORT' : 'LONG',
    status: 'ENTRY_READY',
    score,
    entry: +entry,
    sl: sl != null ? +sl : null,
    tp1: e.tp1 ?? e.plan?.tp1 ?? null,
    tp2: e.tp2 ?? e.plan?.tp2 ?? null,
    tp3: e.tp3 ?? e.plan?.tp3 ?? null,
    current_price: e.marketPrice ?? e.price ?? null,
    exchange: 'binance',
    strategy: 'harmonic',
    metadata: {
      strategy: 'harmonic',
      fromHarmonicBoard: true,
      pattern: e.family || e.label || null,
      patternLabel: e.label || null,
      tf: e.tf || null,
      harmonicId: e.id || null,
      adminPinned: !!e.adminStatusOverride,
      przLow: e.przLow ?? null,
      przHigh: e.przHigh ?? null,
      plan: e.plan || null,
      foundAt: e.savedAt || null,
    },
  };
}

/** Ready pool: one signal per symbol+side (highest score), best first. */
export function buildReadyPool(signals = []) {
  const byId = new Map();
  for (const s of signals) {
    const prev = byId.get(s.signal_id);
    if (!prev || (+s.score || 0) > (+prev.score || 0)) byId.set(s.signal_id, s);
  }
  const byPair = new Map();
  for (const s of byId.values()) {
    const k = `${up(s.symbol)}:${up(s.direction || s.dir)}`;
    const prev = byPair.get(k);
    if (!prev || (+s.score || 0) > (+prev.score || 0)) byPair.set(k, s);
  }
  return [...byPair.values()].sort(byPriority);
}

const pinned = (s) => (s?.metadata?.adminPinned ? 1 : 0);
/** Admin-pinned ENTRY READY first (the admin decided), then the best score. */
const byPriority = (a, b) => pinned(b) - pinned(a) || (+b.score || 0) - (+a.score || 0);

/**
 * Decide what to do with the waiting limit orders.
 * @param readyPool  best-first ENTRY_READY signals (see buildReadyPool)
 * @param executions the user's open executions (any status)
 * @param slots      max limits allowed to wait at once
 * @returns {{desired:Array, keep:Array, cancel:Array<{execution,kind,reason,by}>, place:Array}}
 */
export function planLimitRotation({ readyPool = [], executions = [], slots = 1 }) {
  const n = Math.max(1, Math.min(10, Math.round(+slots) || 1));
  const pending = executions.filter((e) => PENDING_LIMIT_STATUSES.includes(up(e.status)));
  const running = executions.filter((e) => RUNNING_STATUSES.includes(up(e.status)));
  const runningIds = new Set(running.map((e) => String(e.signal_id)));
  const pendingIds = new Set(pending.map((e) => String(e.signal_id)));
  const readyIds = new Set(readyPool.map((s) => String(s.signal_id)));

  // a signal already running as a trade holds no pending slot and is never ordered twice
  const candidates = readyPool.filter((s) => !runningIds.has(String(s.signal_id)));
  // score first; on a tie the order that already waits keeps its place (no needless swapping)
  const ranked = [...candidates].sort(
    (a, b) =>
      byPriority(a, b) ||
      (pendingIds.has(String(b.signal_id)) ? 1 : 0) - (pendingIds.has(String(a.signal_id)) ? 1 : 0)
  );
  const desired = ranked.slice(0, n);
  const desiredIds = new Set(desired.map((s) => String(s.signal_id)));

  const keep = [];
  const cancel = [];
  for (const ex of pending) {
    const sid = String(ex.signal_id);
    if (!readyIds.has(sid)) {
      cancel.push({
        execution: ex,
        kind: 'LEFT_READY',
        reason: 'Signal is no longer ENTRY READY (price moved away or status changed) — limit order cancelled',
      });
    } else if (!desiredIds.has(sid)) {
      const by = desired.find((s) => !pendingIds.has(String(s.signal_id))) || desired[0] || null;
      const mine = +ex.score || +ranked.find((s) => String(s.signal_id) === sid)?.score || 0;
      cancel.push({
        execution: ex,
        kind: 'OUTRANKED',
        by,
        reason: by
          ? pinned(by)
            ? `Replaced: admin set ${by.symbol} to ENTRY READY (${by.symbol} score ${+by.score || 0}, ${ex.symbol} score ${mine})`
            : `Replaced by a higher-score ENTRY READY: ${by.symbol} score ${+by.score || 0} > ${ex.symbol} score ${mine}`
          : 'Replaced by a higher-score ENTRY READY signal',
      });
    } else {
      keep.push(ex);
    }
  }
  const place = desired.filter((s) => !pendingIds.has(String(s.signal_id)));
  return { desired, keep, cancel, place };
}

/** Queue view for the portfolio: every ready signal and what the bot did with it. */
export function describeQueue({ readyPool = [], plan, executions = [] }) {
  const desired = new Set((plan?.desired || []).map((s) => String(s.signal_id)));
  const exBySignal = new Map();
  for (const e of executions) if (!exBySignal.has(String(e.signal_id))) exBySignal.set(String(e.signal_id), e);
  return readyPool.slice(0, 12).map((s) => {
    const ex = exBySignal.get(String(s.signal_id));
    const exSt = ex ? up(ex.status) : null;
    let state = 'QUEUED';
    let note = 'Waiting — a higher-score signal holds the order slot';
    if (exSt && RUNNING_STATUSES.includes(exSt)) {
      state = 'IN_TRADE';
      note = 'Limit filled — trade is running';
    } else if (exSt && PENDING_LIMIT_STATUSES.includes(exSt)) {
      state = 'ORDER_PLACED';
      note = 'Limit order is waiting for the fill';
    } else if (exSt === 'SKIPPED' || exSt === 'FAILED' || exSt === 'REJECTED') {
      state = exSt;
      note = ex.error || 'Order was not placed';
    } else if (desired.has(String(s.signal_id))) {
      state = 'NEXT';
      note = 'Best score — order is being placed';
    }
    return {
      signalId: s.signal_id,
      symbol: s.symbol,
      direction: s.direction,
      score: +s.score || 0,
      tf: s.metadata?.tf || null,
      pattern: s.metadata?.patternLabel || s.metadata?.pattern || null,
      entry: s.entry,
      state,
      note,
    };
  });
}

/** Append a short event to an execution's history (kept small). */
export function pushEvent(metadata, type, text, extra = {}) {
  const events = Array.isArray(metadata?.events) ? metadata.events.slice(-19) : [];
  events.push({ at: new Date().toISOString(), type, text: String(text || '').slice(0, 300), ...extra });
  return { ...(metadata || {}), events };
}
