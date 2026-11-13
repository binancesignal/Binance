import { calcEMASeries } from '../scanner/indicators.js';

/**
 * EMA cross inside the entry zone (global ON/OFF filter).
 *
 * Rule (as traded on TradingView):
 *   - Take the signal's zone band and extend it LEFT in time:
 *       Harmonic → D zone / PRZ (przLow..przHigh)
 *       Other strategies → entry / order-block zone
 *   - Walk the chart from the LEFT (oldest candle) to the right on the signal TF only.
 *   - A "cross" is the exact intersection of EMA fast (20) and EMA slow (50).
 *   - The FIRST cross from the left whose intersection price lies INSIDE the zone counts.
 *     Later crosses in the same zone are ignored.
 *   - Signal passes when such a cross exists.
 *
 * Cross is always measured on the signal's own timeframe (1h signal → 1h cross only).
 */

export const EMA_CROSS_ZONE_STATE_KEY = 'ema_cross_zone_filter';
export const EMA_CROSS_ZONE_DEFAULTS = {
  enabled: false,
  fast: 20,
  slow: 50,
  // When true: do not go ONGOING on zone touch alone.
  // ONGOING only when price is in the entry/D zone AND the EMA lines are at
  // the cross (or the final level about to cross) — not after the cross already finished.
  ongoingRequiresCross: false,
};
export const EMA_CROSS_ZONE_CANDLES = 300;

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export function normalizeEmaCrossZoneConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  let fast = clampInt(src.fast, 5, 100, EMA_CROSS_ZONE_DEFAULTS.fast);
  let slow = clampInt(src.slow, 10, 300, EMA_CROSS_ZONE_DEFAULTS.slow);
  if (fast >= slow) fast = Math.max(5, slow - 1);
  return {
    enabled: src.enabled === true,
    fast,
    slow,
    ongoingRequiresCross: src.ongoingRequiresCross === true,
  };
}

/**
 * @param candles  closed candles, oldest → newest ({time, close, ...})
 * @param zoneLow / zoneHigh  entry zone price band
 * @returns {{index,time,price,type,emaFast,emaSlow}|null}
 */
export function findFirstEmaCrossInZone(candles, zoneLow, zoneHigh, opts = {}) {
  const fastP = opts.fast || 20;
  const slowP = opts.slow || 50;
  const lo = Math.min(+zoneLow, +zoneHigh);
  const hi = Math.max(+zoneLow, +zoneHigh);
  if (!Array.isArray(candles) || candles.length < slowP + 2) return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  const fast = calcEMASeries(candles, fastP);
  const slow = calcEMASeries(candles, slowP);

  // Start where BOTH EMAs exist (slow warm-up), scanning left → right.
  for (let i = slowP; i < candles.length; i++) {
    const f0 = fast[i - 1];
    const s0 = slow[i - 1];
    const f1 = fast[i];
    const s1 = slow[i];
    if (f0 == null || s0 == null || f1 == null || s1 == null) continue;

    const d0 = f0 - s0;
    const d1 = f1 - s1;
    const bull = d0 <= 0 && d1 > 0;
    const bear = d0 >= 0 && d1 < 0;
    if (!bull && !bear) continue;

    // Exact intersection of the two EMA lines between candle i-1 and i
    // (this is the visual "cross point" drawn on TradingView).
    const t = d0 === d1 ? 1 : d0 / (d0 - d1);
    const price = f0 + t * (f1 - f0);
    if (price < lo || price > hi) continue;

    return {
      index: i,
      time: candles[i].time,
      price,
      type: bull ? 'bullish' : 'bearish',
      emaFast: f1,
      emaSlow: s1,
    };
  }
  return null;
}

/**
 * True when EMAs are at the cross (or the last level about to cross) inside the zone.
 * Used for ONGOING: zone touch alone is not enough when ongoingRequiresCross is ON.
 *
 * - Cross must not already be finished far from the zone.
 * - Either the exact first-from-left cross sits in the zone on a recent bar while
 *   price is in the zone, or the last closed bars show an imminent/just-happened
 *   cross with EMA mid inside the zone.
 */
export function isEmaAtCrossLevelInZone(candles, zoneLow, zoneHigh, opts = {}) {
  const fastP = opts.fast || 20;
  const slowP = opts.slow || 50;
  const lo = Math.min(+zoneLow, +zoneHigh);
  const hi = Math.max(+zoneLow, +zoneHigh);
  if (!Array.isArray(candles) || candles.length < slowP + 3) {
    return { ok: false, reason: 'not enough candles' };
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { ok: false, reason: 'no zone' };
  }

  const fast = calcEMASeries(candles, fastP);
  const slow = calcEMASeries(candles, slowP);
  const n = candles.length;
  const last = n - 1;

  // Prefer the first-from-left exact cross inside the zone
  const first = findFirstEmaCrossInZone(candles, lo, hi, { fast: fastP, slow: slowP });
  if (first) {
    // Cross is "fresh" if it is on one of the last few closed bars, OR
    // EMAs have not spread far after the cross (still at the cross level).
    const barsSince = last - first.index;
    const fNow = fast[last];
    const sNow = slow[last];
    const spread = fNow != null && sNow != null ? Math.abs(fNow - sNow) : null;
    const zoneW = Math.max(hi - lo, Math.abs(lo) * 0.0001);
    const stillAtLevel = spread != null && spread <= zoneW * 1.25;
    const recent = barsSince <= 3;
    if (recent || stillAtLevel) {
      return {
        ok: true,
        reason: recent
          ? 'EMA cross just formed inside zone'
          : 'EMA still at cross level inside zone',
        cross: first,
        barsSince,
      };
    }
    return {
      ok: false,
      reason: 'EMA cross inside zone already finished (spread after cross)',
      cross: first,
      barsSince,
    };
  }

  // No completed cross in zone yet — check if EMAs are about to cross at the zone
  const f1 = fast[last];
  const s1 = slow[last];
  const f0 = fast[last - 1];
  const s0 = slow[last - 1];
  if (f1 == null || s1 == null || f0 == null || s0 == null) {
    return { ok: false, reason: 'EMA not ready' };
  }
  const mid = (f1 + s1) / 2;
  const inZone = mid >= lo && mid <= hi;
  const zoneW = Math.max(hi - lo, Math.abs(lo) * 0.0001);
  const gap0 = Math.abs(f0 - s0);
  const gap1 = Math.abs(f1 - s1);
  const approaching = gap1 <= gap0 && gap1 <= zoneW * 1.5;
  const justFlipped =
    (f0 <= s0 && f1 > s1) || (f0 >= s0 && f1 < s1);

  if (inZone && (approaching || justFlipped)) {
    return {
      ok: true,
      reason: justFlipped
        ? 'EMA just crossed at zone level'
        : 'EMA at last level about to cross inside zone',
      cross: {
        index: last,
        time: candles[last].time,
        price: mid,
        type: f1 > s1 ? 'bullish' : 'bearish',
        emaFast: f1,
        emaSlow: s1,
      },
      barsSince: 0,
    };
  }

  return {
    ok: false,
    reason: inZone
      ? 'Price in zone but EMAs not at cross level'
      : 'No EMA cross at entry/D zone level',
    cross: null,
  };
}

/** Entry zone of a stored signal row (or a fresh scan result).
 *  Harmonic → strict D-zone / PRZ band (przLow..przHigh), NOT the wider ready zone.
 *  Other strategies → order-block / entry zone, then entry point fallback.
 */
export function signalEntryZone(signal) {
  const meta = signal?.metadata || {};
  const strat = String(meta.strategy || signal?.strategy || '').toLowerCase();

  // Harmonic: always use the D zone (PRZ) so that "extend zone left" matches TradingView.
  if (strat === 'harmonic') {
    const h = meta.harmonic || {};
    let low = +h.przLow;
    let high = +h.przHigh;
    if (Number.isFinite(low) && Number.isFinite(high)) {
      return { low: Math.min(low, high), high: Math.max(low, high) };
    }
    const e = +signal?.entry;
    if (Number.isFinite(e)) return { low: e, high: e };
    return null;
  }

  const ob = signal?.ob || {};
  let low = +(signal?.ob_low ?? ob.low);
  let high = +(signal?.ob_high ?? ob.high);
  if (!(Number.isFinite(low) && Number.isFinite(high))) {
    const h = meta.harmonic || {};
    low = +h.przLow;
    high = +h.przHigh;
  }
  if (!(Number.isFinite(low) && Number.isFinite(high))) {
    const e = +signal?.entry;
    if (!Number.isFinite(e)) return null;
    low = e;
    high = e;
  }
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

/** Timeframe the signal was built on (cross is measured only here). */
export function signalTimeframe(signal, fallback = '15m') {
  const meta = signal?.metadata || {};
  return String(
    meta.patternTf || meta.setupTf || meta.setup_tf || meta.obTf || meta.tf || fallback
  ).toLowerCase();
}

/**
 * Evaluate one signal against candles of its own timeframe.
 * Returns the object stored in metadata.emaCrossZone.
 */
export function evaluateEmaCrossZone(signal, candles, cfg) {
  const c = normalizeEmaCrossZoneConfig(cfg);
  const zone = signalEntryZone(signal);
  const tf = signalTimeframe(signal);
  const base = {
    fast: c.fast,
    slow: c.slow,
    tf,
    zoneLow: zone?.low ?? null,
    zoneHigh: zone?.high ?? null,
    checkedAt: new Date().toISOString(),
  };
  if (!zone) return { ...base, ok: false, cross: null, reason: 'no entry zone' };
  const cross = findFirstEmaCrossInZone(candles, zone.low, zone.high, c);
  return cross
    ? {
        ...base,
        ok: true,
        cross: { type: cross.type, time: cross.time, price: cross.price, index: cross.index },
        reason: 'first EMA cross from the left is inside the entry zone',
      }
    : { ...base, ok: false, cross: null, reason: 'no EMA cross inside the entry zone' };
}

/**
 * True when the filter is ON and this signal has been checked and FAILED.
 * Unchecked signals (no metadata yet) are never hidden. ONGOING trades and
 * finished signals are never hidden (open positions must stay manageable).
 */
export function isHiddenByEmaCrossZone(signal, cfg) {
  const c = normalizeEmaCrossZoneConfig(cfg);
  if (!c.enabled) return false;
  const status = String(signal?.status || '').trim().toUpperCase();
  if (status !== 'WATCHING' && status !== 'READY') return false;
  const r = signal?.metadata?.emaCrossZone;
  if (!r) return false;
  if (r.fast !== c.fast || r.slow !== c.slow) return false; // stale settings → re-check pending
  return r.ok === false;
}

/**
 * Re-check every active WATCHING/READY signal with the current settings and
 * store the result on the signal. Used when the admin saves the toggle so it
 * applies to signals that were already scanned.
 *
 * deps = { getActiveSignals, updateSignal, getKlines(symbol, tf, limit, signal) }
 */
export async function applyEmaCrossZoneToActiveSignals(cfg, deps) {
  const c = normalizeEmaCrossZoneConfig(cfg);
  const { getActiveSignals, updateSignal, getKlines } = deps;
  const active = await getActiveSignals();
  const targets = (active || []).filter((s) => {
    const st = String(s?.status || '').trim().toUpperCase();
    return st === 'WATCHING' || st === 'READY';
  });

  const stats = { checked: 0, passed: 0, hidden: 0, errors: 0, cleared: 0 };

  // OFF → drop stored results so nothing stays hidden; everything is visible again.
  if (!c.enabled) {
    for (const s of targets) {
      if (!s.metadata?.emaCrossZone) continue;
      const { emaCrossZone, ...rest } = s.metadata;
      try {
        await updateSignal(s.signal_id, { metadata: rest });
        stats.cleared++;
      } catch {
        stats.errors++;
      }
    }
    return stats;
  }

  // Group by symbol+tf so each candle set is fetched once.
  const cache = new Map();
  for (const s of targets) {
    const tf = signalTimeframe(s);
    const key = `${s.exchange || ''}|${s.symbol}|${tf}`;
    try {
      if (!cache.has(key)) {
        // 4th arg = the signal, so the caller can pick the right exchange for it
        cache.set(key, getKlines(s.symbol, tf, EMA_CROSS_ZONE_CANDLES, s));
      }
      const candles = await cache.get(key);
      const result = evaluateEmaCrossZone(s, candles, c);
      await updateSignal(s.signal_id, {
        metadata: { ...(s.metadata || {}), emaCrossZone: result },
      });
      stats.checked++;
      if (result.ok) stats.passed++;
      else stats.hidden++;
    } catch (e) {
      stats.errors++;
    }
  }
  return stats;
}
