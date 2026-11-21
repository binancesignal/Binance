/**
 * Scan universe — ALL eligible USDT perpetuals, or the Top N by a ranking method.
 * Nothing is capped silently: `all` returns every eligible symbol, `top` returns exactly min(N, eligible).
 */
export const rankKey = {
  volume: (t) => +t.volume || 0,
  gainers: (t) => +t.change || 0,
  losers: (t) => -(+t.change || 0),
  volatility: (t) => (+t.price > 0 ? ((+t.high || 0) - (+t.low || 0)) / +t.price : 0),
};

/**
 * @param {{mode:'all'|'top', topN?:number, ranking?:string, eligible:string[], tickers:object, symbols?:string[]}} o
 * @returns {string[]} ordered symbol list
 */
export function selectUniverse(o) {
  const ranking = rankKey[o.ranking] ? o.ranking : 'volume';
  const eligibleSet = new Set((o.eligible || []).map((s) => String(s).toUpperCase()));
  let list;
  if (Array.isArray(o.symbols) && o.symbols.length) {
    // explicit coin selection (still only eligible symbols)
    list = [...new Set(o.symbols.map((s) => String(s).toUpperCase()))].filter((s) => eligibleSet.has(s));
  } else {
    const tickers = o.tickers || {};
    list = [...eligibleSet];
    // eligible coins without a ticker keep a 0 rank (they are NOT dropped)
    list.sort((a, b) => rankKey[ranking](tickers[b] || {}) - rankKey[ranking](tickers[a] || {}) || a.localeCompare(b));
    if (o.mode === 'top') {
      const n = Math.max(1, Math.round(+o.topN) || 50);
      list = list.slice(0, n);
    }
  }
  return list;
}

/**
 * Turn a scan request into the universe that is actually allowed.
 * Admin: anything (All coins, any Top N). Normal user: at most `cfg.userScanMax` coins (600+ = All coins allowed).
 * @returns {{ok:boolean, error?:string, mode?:'all'|'top', topN?:number, symbols?:string[], notice?:string}}
 */
export function resolveScanRequest({ cfg, isAdmin, body = {} }) {
  const clean = (list) =>
    (Array.isArray(list) ? list : [])
      .map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''))
      .filter(Boolean)
      .map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));
  const max = isAdmin ? 700 : cfg.userScanMax;
  if (!isAdmin && !(max > 0)) return { ok: false, error: 'Scanning is disabled for users (admin setting)' };
  let symbols = clean(body.symbols);
  let notice;
  if (symbols.length) {
    if (symbols.length > max) {
      symbols = symbols.slice(0, max);
      notice = `Only the first ${max} coins are scanned (your limit)`;
    }
    return { ok: true, mode: 'top', topN: symbols.length, symbols, notice };
  }
  const wantAll = body.mode === 'all';
  const allAllowed = isAdmin || max >= 600;
  if (wantAll && allAllowed) return { ok: true, mode: 'all', topN: null };
  const asked = wantAll ? max : Math.max(1, Math.round(+body.topN) || cfg.topN); // "All coins" without permission → the user's maximum
  const topN = Math.min(asked, isAdmin ? 600 : max);
  if (wantAll || asked > topN) notice = `Limited to the Top ${topN} coins for your account`;
  return { ok: true, mode: 'top', topN, notice };
}
