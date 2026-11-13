/**
 * Split-scan helpers: the coin universe is cut into N parts and ONE part is scanned per full-scan
 * tick (part 1 → part 2 → part 3 → part 1 …). Pure functions, no I/O.
 *
 * Coins are put in a stable (alphabetical) order so a coin never moves between parts when 24h
 * volume ranks change from one tick to the next. The offset only advances by what was really
 * processed, so a part that hit the time budget is continued by the next tick — nothing is skipped.
 */
export const MAX_SCAN_PARTS = 10;

export function normalizeParts(v, fallback = 3) {
  const n = Math.round(+v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_SCAN_PARTS, n);
}

export const partSize = (total, parts) => Math.max(1, Math.ceil(total / Math.max(1, parts)));

/** Stable order for slicing. */
export const stableOrder = (symbols) => [...symbols].sort();

/** The slice of `ordered` this tick should scan, starting at the persisted offset. */
export function planPart(ordered, parts, offset = 0) {
  const total = ordered.length;
  const size = partSize(total, parts);
  const start = total ? ((offset % total) + total) % total : 0;
  return {
    chunk: ordered.slice(start, start + size),
    size,
    start,
    part: Math.floor(start / size) + 1,
    parts,
  };
}

/** Next offset after `processed` coins were actually completed. Wraps to 0 at the end. */
export const nextPartOffset = (start, processed, total) => (total ? (start + processed) % total : 0);
