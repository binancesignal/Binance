/**
 * DOUBLE ORDER BLOCK — an order block that has a second, smaller order block formed INSIDE it
 * (same direction). The inner block is the sharper entry zone; we then wait for price to come back to it.
 *
 *   outer OB (older)  ┌──────────────┐        ← LuxAlgo OB
 *   inner OB (newer)  │ ┌──────────┐ │        ← LuxAlgo OB fully inside the outer one
 *                     │ └──────────┘ │
 *                     └──────────────┘
 *
 * Status of a pair (judged on the INNER block, with the same wick rule as the LuxAlgo indicator):
 *   UNMITIGATED — price has not come back into the inner block yet  → still waiting for it
 *   MITIGATED   — price already traded into it ("touched") or went through it ("broken")
 */
import { detectLuxAlgoOrderBlocksHistorical } from '../scanner/orderBlocks.js';
import { calcATR } from '../scanner/indicators.js';
import { entryProximity } from '../fibSignals/proximity.js';

export const DOUBLE_OB_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '1d'];

const DEFAULTS = {
  length: 5, // LuxAlgo swing length
  mitigation: 'Wick', // LuxAlgo mitigation method
  lookback: 400,
  tolFrac: 0.05, // inner may poke out of the outer by 5 % of the outer's height
  maxAge: 200, // inner block must have formed within the last N candles
  mitigatedRecent: 100, // a mitigated pair is only listed if it happened within the last N candles
};

const hOf = (ob) => Math.abs(ob.high - ob.low);

/** does `inner` sit inside `outer` (same direction, formed later, outer still alive when inner formed)? */
export function isNested(outer, inner, tolFrac = DEFAULTS.tolFrac) {
  if (outer === inner || outer.type !== inner.type) return false;
  if (!(inner.index > outer.index)) return false;
  const hA = hOf(outer);
  const hB = hOf(inner);
  if (!(hA > 0) || !(hB > 0) || hB > hA) return false;
  const tol = hA * tolFrac;
  if (inner.high > outer.high + tol || inner.low < outer.low - tol) return false;
  const formedAt = inner.confBar ?? inner.index;
  if (outer.mitigatedAt != null && outer.mitigatedAt <= formedAt) return false;
  return true;
}

/** first candle (after the inner block is confirmed) that traded into its zone, or null */
function firstTouchIndex(candles, ob) {
  for (let i = (ob.confBar ?? ob.index) + 1; i < candles.length; i++) {
    if (candles[i].low <= ob.high && candles[i].high >= ob.low) return i;
  }
  return null;
}

/**
 * Pair up nested order blocks. Pure: works on an OB list + the candles they came from.
 * @returns {object[]} setups (unsorted)
 */
export function pairDoubleObs(obs, candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const len = candles.length;
  const out = [];
  if (!len) return out;
  const price = Number.isFinite(+o.price) && +o.price > 0 ? +o.price : candles[len - 1].close;
  const atr = calcATR(candles, 14) || Math.abs(candles[len - 1].high - candles[len - 1].low) || price * 0.01;

  for (const inner of obs) {
    if (len - 1 - inner.index > o.maxAge) continue;
    // the tightest older OB that still contains it
    let outer = null;
    for (const a of obs) {
      if (!isNested(a, inner, o.tolFrac)) continue;
      if (!outer || hOf(a) < hOf(outer)) outer = a;
    }
    if (!outer) continue;

    const touch = firstTouchIndex(candles, inner);
    const broken = inner.mitigatedAt != null;
    const eventIdx = broken && touch != null ? Math.min(touch, inner.mitigatedAt) : broken ? inner.mitigatedAt : touch;
    const mitigated = eventIdx != null;
    if (mitigated && len - 1 - eventIdx > o.mitigatedRecent) continue;

    const bear = inner.type === 'bearish';
    const entry = inner.avg ?? inner.mid;
    const outerMid = outer.avg ?? outer.mid;
    // how far apart the two mid lines are, as % of the OUTER block's height (0 = exactly the same line)
    const midGapPct = +((Math.abs(outerMid - entry) / hOf(outer)) * 100).toFixed(1);
    const prox = entryProximity({ price, entry, atr, sl: bear ? inner.high : inner.low });
    out.push({
      symbol: o.symbol || null,
      tf: o.tf || null,
      type: inner.type,
      side: bear ? 'SELL' : 'BUY',
      status: mitigated ? 'MITIGATED' : 'UNMITIGATED',
      mitigation: !mitigated ? null : broken ? 'broken' : 'touched',
      mitigatedIndex: eventIdx,
      mitigatedTime: eventIdx != null ? candles[eventIdx].time : null,
      mitigatedAgo: eventIdx != null ? len - 1 - eventIdx : null,
      outer: { high: outer.high, low: outer.low, mid: outer.avg ?? outer.mid, index: outer.index, time: outer.time, mitigatedAt: outer.mitigatedAt ?? null },
      inner: { high: inner.high, low: inner.low, mid: entry, index: inner.index, time: inner.time, confBar: inner.confBar ?? null, mitigatedAt: inner.mitigatedAt ?? null },
      entry,
      midGapPct,
      price,
      atr: +atr,
      age: len - 1 - inner.index,
      distPct: prox.distPct,
      distAtr: prox.distAtr,
      proximityPct: prox.pct,
    });
  }
  return out;
}

/** waiting ones: nearest to the entry first · mitigated: most recent first */
export function sortSetups(list) {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'UNMITIGATED' ? -1 : 1;
    if (a.status === 'UNMITIGATED') return (a.distAtr ?? Infinity) - (b.distAtr ?? Infinity);
    return (a.mitigatedAgo ?? Infinity) - (b.mitigatedAgo ?? Infinity);
  });
}

/** closed candles (oldest → newest, with volume) → double-OB setups */
export function findDoubleObs(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Array.isArray(candles) || candles.length < o.length * 4 + 20) return [];
  const obs = detectLuxAlgoOrderBlocksHistorical(candles, o.lookback, { length: o.length, mitigation: o.mitigation });
  return sortSetups(pairDoubleObs(obs, candles, o));
}
