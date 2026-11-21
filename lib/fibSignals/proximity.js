/**
 * "How close is price to the entry?" — comparable across coins.
 *
 * A raw % distance means different things for different coins (1 % is nothing for a volatile coin,
 * a lot for BTC), so the distance is measured in ATR units of the signal's own time frame
 * (= how many "normal candles" price still has to travel) and turned into 0-100:
 *   0 ATR away → 100 %,  3 ATR away → 50 %,  6 ATR → 20 %,  10 ATR → 8 %.
 */
const HALF_ATR = 3;

export function entryProximity({ price, entry, atr, sl }) {
  const p = +price;
  const e = +entry;
  if (!(p > 0) || !(e > 0)) return { pct: null, distAtr: null, distPct: null };
  let unit = +atr;
  if (!(unit > 0)) {
    const risk = Math.abs(e - +sl);
    unit = risk > 0 ? risk / 1.5 : e * 0.01; // no ATR stored → derive a unit from the stop distance
  }
  const dist = Math.abs(p - e);
  const distAtr = dist / unit;
  const pct = Math.max(1, Math.min(100, Math.round(100 / (1 + (distAtr / HALF_ATR) ** 2))));
  return { pct, distAtr: +distAtr.toFixed(3), distPct: +((dist / e) * 100).toFixed(3) };
}
