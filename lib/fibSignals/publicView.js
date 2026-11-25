/**
 * What NON-admin users may see of a signal: trade levels and results only.
 * Nothing about the strategy (no fib / order-block / time-frame / score / zone / ids that encode them).
 */
import crypto from 'node:crypto';
import { outcomeLabel } from './evaluate.js';

const SALT = 'sg1';
export const publicId = (signalId) => crypto.createHash('sha256').update(`${SALT}:${signalId}`).digest('hex').slice(0, 14);

/** closed without ever filling the entry (invalid / missed / expired-unfilled) → not a trade, hidden from users */
export const isPublicVisible = (s) => s.status === 'ACTIVE' || !!s.entryHit;

/** result label for users — only real results, never lifecycle stages */
export function publicOutcome(s) {
  if (s.status === 'ACTIVE') {
    if (s.tp3Hit) return 'TP3 ✓';
    if (s.tp2Hit) return 'TP2 ✓';
    if (s.tp1Hit) return 'TP1 ✓';
    return '';
  }
  const full = outcomeLabel(s);
  return full === 'Expired' ? 'Closed' : full;
}

export function toPublicSignal(s) {
  return {
    id: publicId(s.signal_id),
    symbol: s.symbol,
    side: s.side,
    status: s.status === 'ACTIVE' ? 'ACTIVE' : 'CLOSED',
    createdAt: s.createdAt,
    closedAt: s.closedAt || null,
    entry: s.entry,
    sl: s.sl,
    tp1: s.tp1,
    tp2: s.tp2,
    tp3: s.tp3,
    tpPct: s.tpPct,
    riskPct: s.riskPct,
    rr: s.rr,
    tp1Hit: !!s.tp1Hit,
    tp2Hit: !!s.tp2Hit,
    tp3Hit: !!s.tp3Hit,
    slHit: !!s.slHit,
    entryHit: !!s.entryHit,
    entryTime: s.entryTime || null,
    trackingPaused: !!s.trackingIssue,
    closeReason: s.closeReason || null,
    outcome: publicOutcome(s),
  };
}

/** find a stored signal by raw id (admin) or by public id (everyone) */
export function findSignal(store, id) {
  const key = String(id || '');
  return store.signals.find((s) => s.signal_id === key || publicId(s.signal_id) === key);
}
