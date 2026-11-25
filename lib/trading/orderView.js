/**
 * One shape for "what did the bot do with this signal" — used by the Portfolio API and the
 * light live endpoint. Pure (no DB): callers pass the executions and the live board items.
 */
import { PENDING_LIMIT_STATUSES, RUNNING_STATUSES } from './limitRotation.js';

const up = (v) => String(v ?? '').trim().toUpperCase();
const PROBLEM = ['SKIPPED', 'FAILED', 'REJECTED', 'CANCELLED', 'CANCELED'];

export function orderGroup(status) {
  const st = up(status);
  if (PENDING_LIMIT_STATUSES.includes(st)) return 'pending';
  if (RUNNING_STATUSES.includes(st)) return 'running';
  if (PROBLEM.includes(st)) return 'problem';
  return 'closed';
}

const num = (v) => (v != null && Number.isFinite(+v) ? +v : null);

export function toOrderView(e, liveById = new Map()) {
  const md = e.metadata || {};
  const d = md.orderDetails || {};
  const att = md.attempt || {};
  const live = liveById.get(String(md.harmonicId || d.harmonicId || att.harmonicId || '')) || liveById.get(String(e.signal_id)) || null;
  const entry = num(d.entry) ?? num(att.entry) ?? num(e.signal_entry);
  const price = num(live?.price);
  return {
    id: e.id,
    symbol: e.symbol,
    side: up(e.side),
    status: up(e.status),
    group: orderGroup(e.status),
    orderType: d.orderType || md.orderType || null,
    orderId: e.entry_order_id || md.orderId || null,
    signalId: e.signal_id,
    entry,
    limitPrice: num(d.limitPrice) ?? num(md.limitPrice),
    actualEntry: num(e.actual_entry),
    sl: num(e.sl) ?? num(att.sl),
    tp1: num(e.tp1) ?? num(att.tp1),
    tp2: num(e.tp2) ?? num(att.tp2),
    tp3: num(e.tp3) ?? num(att.tp3),
    qty: num(e.quantity),
    notional: num(e.notional) ?? num(d.notional),
    margin: num(e.margin) ?? num(d.margin),
    leverage: num(e.leverage) ?? num(d.leverage),
    maxLeverage: num(d.maxLeverage),
    score: num(e.score) ?? num(d.score) ?? num(att.score),
    pattern: d.pattern || att.pattern || null,
    tf: d.tf || att.tf || null,
    przLow: num(d.przLow) ?? num(att.przLow),
    przHigh: num(d.przHigh) ?? num(att.przHigh),
    mode: e.mode || null,
    environment: md.environment || null,
    reason: e.error || md.skipReason || md.protectionError || null,
    attempts: num(md.attempts),
    replaces: d.replaces || null,
    adminPinned: !!d.adminPinned,
    protection: md.protectionStatus || null,
    events: Array.isArray(md.events) ? md.events.slice(-12) : [],
    createdAt: e.created_at || null,
    updatedAt: e.updated_at || null,
    filledAt: e.filled_at || null,
    signal: live
      ? {
          status: live.status,
          price,
          tpLevel: live.tpLevel || 0,
          score: num(live.score),
          entryTouched: !!live.entryTouched,
          distancePct: price != null && entry ? ((price - entry) / entry) * 100 : null,
          refreshedAt: live.refreshedAt || null,
        }
      : null,
  };
}

/** Pending first (best score), then running, then problems / cancelled (newest first). */
export function sortOrderViews(list) {
  const rank = { pending: 0, running: 1, problem: 2, closed: 3 };
  return [...list].sort(
    (a, b) =>
      (rank[a.group] ?? 9) - (rank[b.group] ?? 9) ||
      (a.group === 'pending' ? (b.score || 0) - (a.score || 0) : 0) ||
      Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0)
  );
}
