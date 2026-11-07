/**
 * Fib Signals — plain "signal" feed built on OB + HTF Fib (no WATCHING / READY / ONGOING stages, no strategy gates).
 *
 * Admin chooses ONLY:  Fib time frames · Fib lines · LTF (order-block time frames)
 * plus two switches:   firstTouchOnly (fib line never touched since its candle closed) · enabled (cron on/off).
 */
import { OB_FIB_DEFAULTS, OB_FIB_LEVELS, OB_FIB_TFS, OB_FIB_REF_TFS, normalizeObFibConfig } from '../scanner/strategy/obFib/config.js';

export const FIB_SIGNALS_CONFIG_KEY = 'fib_signals_config';
export const FIB_SIGNALS_STORE_KEY = 'fib_signals_store';
export const FIB_SIGNALS_CURSOR_KEY = 'fib_signals_cursor';
export const FIB_SIGNALS_STATUS_KEY = 'fib_signals_status';
export const FIB_SIGNALS_LOCK_KEY = 'fib_signals_lock';
export const FIB_SIGNALS_INVALID_KEY = 'fib_signals_invalid';

export const FIB_SIGNALS_DEFAULTS = {
  enabled: false,
  refTimeframes: ['1w', '1M'],
  timeframes: ['15m', '1h'],
  fibLevels: [0.382, 0.5, 0.618, 0.786],
  firstTouchOnly: false,
  // housekeeping only (not a signal gate)
  expireDays: 7, // unfilled signals are retired after N days (0 = never)
};

export { OB_FIB_LEVELS, OB_FIB_TFS, OB_FIB_REF_TFS };

const pickList = (v, allowed, fallback) => {
  if (!Array.isArray(v)) return fallback;
  const out = allowed.filter((x) => v.map(String).includes(x));
  return out.length ? out : fallback;
};

export function normalizeFibSignalsConfig(raw = {}) {
  const d = FIB_SIGNALS_DEFAULTS;
  const r = raw && typeof raw === 'object' ? raw : {};
  const levels = Array.isArray(r.fibLevels)
    ? [...new Set(r.fibLevels.map((x) => +(+x).toFixed(4)).filter((x) => Number.isFinite(x) && x >= -5 && x <= 10))].sort((a, b) => a - b)
    : d.fibLevels;
  const exp = Math.round(+r.expireDays);
  return {
    enabled: r.enabled === true,
    refTimeframes: pickList(r.refTimeframes, OB_FIB_REF_TFS, d.refTimeframes),
    timeframes: pickList(r.timeframes, OB_FIB_TFS, d.timeframes),
    fibLevels: levels.length ? levels.slice(0, 20) : d.fibLevels,
    firstTouchOnly: r.firstTouchOnly === true,
    expireDays: Number.isFinite(exp) ? Math.min(60, Math.max(0, exp)) : d.expireDays,
  };
}

/**
 * The OB+Fib engine config used by the auto Fib Signals scan.
 *
 * It is EXACTLY the config Coin Scan runs with: the admin's OB + Fib scanner settings (`base`:
 * order-block rules, min score, min R:R, entry distance, approach side, single fib …), with only the
 * three selections replaced by the Fib Signals ones (HTF · LTF · fib lines) — the same override Coin Scan
 * applies from its chips. Nothing is loosened, so a coin gives the same signals in both places.
 *
 * `requireUntouchedEntry` is the one switch handled outside the core: setups whose entry was already used
 * are not silently dropped, they are returned flagged and parked in the Invalid list.
 */
export function engineConfigFrom(cfg, base) {
  const b = base && typeof base === 'object' ? base : OB_FIB_DEFAULTS;
  return normalizeObFibConfig({
    ...b,
    enabled: true,
    refTimeframes: cfg.refTimeframes,
    timeframes: cfg.timeframes,
    fibLevels: cfg.fibLevels,
    requireUntouchedEntry: false,
  });
}
