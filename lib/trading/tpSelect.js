/**
 * User-selectable take-profit level (TP1 / TP2 / TP3).
 */

export function normalizeTpLevel(v, fallback = 1) {
  const n = Math.round(+v);
  if (n === 2 || n === 3) return n;
  if (n === 1) return 1;
  return fallback;
}

/** Pick price from a signal / execution for the given TP level. */
export function resolveTpPrice(levels, tpLevel = 1) {
  const level = normalizeTpLevel(tpLevel, 1);
  const tp1 = levels?.tp1 != null ? +levels.tp1 : null;
  const tp2 = levels?.tp2 != null ? +levels.tp2 : null;
  const tp3 = levels?.tp3 != null ? +levels.tp3 : null;
  if (level === 3 && tp3 != null && Number.isFinite(tp3)) return { level: 3, price: tp3, label: 'TP3' };
  if (level === 2 && tp2 != null && Number.isFinite(tp2)) return { level: 2, price: tp2, label: 'TP2' };
  if (tp1 != null && Number.isFinite(tp1)) return { level: 1, price: tp1, label: 'TP1' };
  if (tp2 != null && Number.isFinite(tp2)) return { level: 2, price: tp2, label: 'TP2' };
  if (tp3 != null && Number.isFinite(tp3)) return { level: 3, price: tp3, label: 'TP3' };
  return { level: null, price: null, label: null };
}

/** Available TP choices for UI (only levels that have a price). */
export function listTpOptions(levels) {
  const out = [];
  if (levels?.tp1 != null && Number.isFinite(+levels.tp1)) out.push({ level: 1, price: +levels.tp1, label: 'TP1' });
  if (levels?.tp2 != null && Number.isFinite(+levels.tp2)) out.push({ level: 2, price: +levels.tp2, label: 'TP2' });
  if (levels?.tp3 != null && Number.isFinite(+levels.tp3)) out.push({ level: 3, price: +levels.tp3, label: 'TP3' });
  return out;
}
