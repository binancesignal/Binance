/**
 * "Supply Demand Zones PRO" (TradingView Pine v6) ported to JS — same defaults, same rules:
 *
 *  • pivot high / low with swingLen (12) bars on both sides, confirmed swingLen bars later
 *  • skipped when the confirming candle opens in the "Other" session (UTC hour 22–24)
 *  • at least minDistance (44) bars after the last zone of the same kind
 *  • the zone is centred on the pivot candle's middle and forced to EXACTLY 1.0 × ATR(20) tall
 *    (force / min / max height are all 1.0 in the script's defaults)
 *  • overlapping an unbroken zone of the same kind among the last 10 → merged into it (no new zone)
 *  • invalidated when a candle CLOSES beyond it (supply: close > top · demand: close < bottom)
 *
 * Closed candles only, oldest → newest: { time (s), open, high, low, close }.
 */
export const SD_DEFAULTS = {
  swingLen: 12,
  atrLen: 20,
  maxHeightATR: 1.0,
  minHeightATR: 1.0,
  forceHeightATR: 1.0,
  minDistance: 44,
  invalidation: 'Close', // 'Close' | 'Wick'
};

/** Pine ta.atr(len): RMA of the true range, seeded with the SMA of the first `len` values (NaN before) */
export function rmaAtr(candles, len = 20) {
  const out = new Array(candles.length).fill(NaN);
  let prev = NaN;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    if (i < len - 1) {
      sum += tr;
    } else if (i === len - 1) {
      sum += tr;
      prev = sum / len;
      out[i] = prev;
    } else {
      prev = (prev * (len - 1) + tr) / len;
      out[i] = prev;
    }
  }
  return out;
}

function pivotHigh(cs, p, L) {
  const v = cs[p].high;
  for (let j = 1; j <= L; j++) {
    if (!(v > cs[p - j].high)) return false; // strictly above the left side
    if (!(v >= cs[p + j].high)) return false; // not below the right side
  }
  return true;
}
function pivotLow(cs, p, L) {
  const v = cs[p].low;
  for (let j = 1; j <= L; j++) {
    if (!(v < cs[p - j].low)) return false;
    if (!(v <= cs[p + j].low)) return false;
  }
  return true;
}

const sessionOther = (timeSec) => new Date(timeSec * 1000).getUTCHours() >= 22;

/**
 * @returns {{type:'supply'|'demand', top:number, bottom:number, startIndex:number, startTime:number,
 *            createdIndex:number, broken:boolean, brokenIndex:number|null, brokenTime:number|null}[]}
 */
export function findSupplyDemandZones(candles, opts = {}) {
  const o = { ...SD_DEFAULTS, ...opts };
  const n = Array.isArray(candles) ? candles.length : 0;
  const L = o.swingLen;
  const zones = [];
  if (n < 2 * L + 2) return zones;
  const atrArr = rmaAtr(candles, o.atrLen);
  const last = { supply: 0, demand: 0 };

  const tryCreate = (type, i) => {
    if (sessionOther(candles[i].time)) return;
    const atr = atrArr[i];
    if (!(atr > 0)) return; // Pine: comparisons with na are false → nothing is created
    if (i - last[type] < o.minDistance) return;
    const p = i - L;
    let top = candles[p].high;
    let bot = candles[p].low;
    const mid = (top + bot) / 2;
    let height = top - bot;
    if (height < atr * o.forceHeightATR) {
      const forced = atr * o.forceHeightATR;
      top = mid + forced / 2;
      bot = mid - forced / 2;
      height = forced;
    }
    if (height > atr * o.maxHeightATR) {
      const maxH = atr * o.maxHeightATR;
      top = mid + maxH / 2;
      bot = mid - maxH / 2;
      height = maxH;
    }
    if (!(height >= atr * o.minHeightATR)) return;

    // merge with an unbroken zone of the same kind among the last 10
    for (let k = zones.length - 1; k >= Math.max(0, zones.length - 10); k--) {
      const z = zones[k];
      if (z.type === type && !z.broken && top >= z.bottom && bot <= z.top) {
        z.top = Math.max(top, z.top);
        z.bottom = Math.min(bot, z.bottom);
        return; // merged — no new zone, last-zone bar is NOT moved
      }
    }
    zones.push({ type, top, bottom: bot, startIndex: p, startTime: candles[p].time, createdIndex: i, broken: false, brokenIndex: null, brokenTime: null });
    last[type] = i;
  };

  for (let i = 0; i < n; i++) {
    const p = i - L;
    if (p >= L) {
      if (pivotHigh(candles, p, L)) tryCreate('supply', i);
      if (pivotLow(candles, p, L)) tryCreate('demand', i);
    }
    // invalidation, checked for every zone on every candle (including the one that just created it)
    const c = candles[i];
    for (const z of zones) {
      if (z.broken) continue;
      const lvl = z.type === 'supply' ? (o.invalidation === 'Close' ? c.close : c.high) : (o.invalidation === 'Close' ? c.close : c.low);
      if (z.type === 'supply' ? lvl > z.top : lvl < z.bottom) {
        z.broken = true;
        z.brokenIndex = i;
        z.brokenTime = c.time;
      }
    }
  }
  return zones;
}

/**
 * Does a supply (for a bearish / red OB) or demand (for a bullish / green OB) zone TOUCH this double-OB setup?
 *   waiting setup   → the zone must still be unbroken
 *   mitigated setup → the zone must still have been valid when the OB got mitigated
 * @returns {null | {type, top, bottom, startIndex, startTime, brokenIndex, brokenTime, touchesInner, touchesOuter}}
 */
export function matchSupplyDemand(setup, zones, candles) {
  const want = setup.type === 'bearish' ? 'supply' : 'demand';
  const mitigated = setup.status === 'MITIGATED';
  let best = null;
  let bestScore = -Infinity;
  for (const z of zones || []) {
    if (z.type !== want) continue;
    if (mitigated) {
      if (z.brokenIndex != null && setup.mitigatedIndex != null && z.brokenIndex < setup.mitigatedIndex) continue;
    } else if (z.brokenIndex != null) continue;
    const touchesOuter = z.top >= setup.outer.low && z.bottom <= setup.outer.high;
    const touchesInner = z.top >= setup.inner.low && z.bottom <= setup.inner.high;
    if (!touchesOuter && !touchesInner) continue;
    const overlap = Math.min(z.top, setup.outer.high) - Math.max(z.bottom, setup.outer.low);
    const score = (touchesInner ? 1e12 : 0) + overlap / (setup.outer.high - setup.outer.low || 1);
    if (score > bestScore) {
      bestScore = score;
      best = {
        type: want === 'supply' ? 'SUPPLY' : 'DEMAND',
        top: z.top,
        bottom: z.bottom,
        startIndex: z.startIndex,
        startTime: z.startTime,
        brokenIndex: z.brokenIndex,
        brokenTime: z.brokenTime,
        touchesInner,
        touchesOuter,
      };
    }
  }
  return best;
}
