// Pure helpers (no server imports) — safe to use from client components too.

/** Status → admin category (Watching / Entry ready / In trade / TP hit / SL hit / Invalid / Formed). */
export function harmonicCategory(status) {
  const st = String(status || '').toUpperCase();
  if (st === 'WAITING' || st === 'WATCHING') return 'watching';
  if (st === 'ENTRY_READY') return 'entry_ready';
  if (st === 'IN_TRADE') return 'in_trade';
  if (st.startsWith('TP')) return 'tp_hit';
  if (st === 'SL_HIT') return 'sl_hit';
  if (st === 'INVALIDATED' || st === 'MISSED') return 'invalid';
  if (st === 'FORMED') return 'formed';
  return 'other';
}

const CAT_RANK = { entry_ready: 6, in_trade: 5, watching: 4, formed: 3, tp_hit: 2, sl_hit: 1, invalid: 0, other: 0 };

/** Keep only ONE signal per coin: live stage first, then higher score, then newest. */
export function pickBestPerCoin(items = []) {
  const best = new Map();
  for (const e of items) {
    const sym = String(e?.symbol || '').toUpperCase();
    if (!sym) continue;
    const cur = best.get(sym);
    if (!cur) {
      best.set(sym, e);
      continue;
    }
    const ra = CAT_RANK[harmonicCategory(e.status)] ?? 0;
    const rb = CAT_RANK[harmonicCategory(cur.status)] ?? 0;
    let better;
    if (ra !== rb) better = ra > rb;
    else if ((+e.score || 0) !== (+cur.score || 0)) better = (+e.score || 0) > (+cur.score || 0);
    else better = (+e.time || 0) > (+cur.time || 0);
    if (better) best.set(sym, e);
  }
  const keep = new Set(best.values());
  return items.filter((e) => keep.has(e));
}

/** Final outcomes that no longer need re-checking against the exchange. */
export function isFinalHarmonicStatus(status) {
  const st = String(status || '').toUpperCase();
  return st === 'SL_HIT' || st === 'TP3_HIT' || st === 'INVALIDATED' || st === 'MISSED';
}

/** 0 = none, 1..3 = highest take-profit reached (TP1_HIT / TP2_HIT / TP3_HIT). */
export function tpLevelOf(it) {
  const m = /^TP([123])/.exec(String(it?.status || '').toUpperCase());
  if (m) return +m[1];
  // "TP1 ✅ then SL" — the card keeps the targets that were reached before the stop
  const r = Math.round(+it?.tpReached || 0);
  return r >= 1 && r <= 3 ? r : 0;
}
