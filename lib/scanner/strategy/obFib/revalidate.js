/**
 * OB + HTF Fib — is the signal's order block STILL a LuxAlgo order block?
 *
 * A LuxAlgo OB can disappear from the indicator when
 *   · price mitigates it (wick / close beyond the band, per the Mitigation setting), or
 *   · it is pushed out of the "last N" list (bullExtLast / bearExtLast) by newer OBs, or
 *   · the structure flips and the pivot no longer qualifies.
 * Whatever the reason, a WATCHING / READY signal whose OB is no longer on the chart is INVALID.
 *
 * ONGOING trades are never touched here (the entry was already filled).
 */
import { detectLuxAlgoOrderBlocks, detectLuxAlgoOrderBlocksHistorical } from '../../orderBlocks.js';
import { normalizeObFibConfig } from './config.js';

const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };

export function obOfSignal(signal) {
  const m = signal?.metadata || {};
  const ob = m.ob || signal?.ob || m.obFib?.zone || {};
  const time = +(ob.time ?? m.obTime ?? 0);
  const type = ob.type || (String(signal?.direction || signal?.dir).toUpperCase() === 'SHORT' ? 'bearish' : 'bullish');
  return { time: time > 0 ? time : null, type, high: +ob.high, low: +ob.low };
}

export function obFibLtf(signal) {
  const m = signal?.metadata || {};
  return m.obFib?.tf || m.patternTf || m.setupTf || m.entryTf || '15m';
}

/** How many LTF candles are needed so the OB (and its mitigation history) is inside the window. */
export function candlesNeededForOb(signal, fallbackCfg = {}, nowSec = Math.floor(Date.now() / 1000)) {
  const cfg = normalizeObFibConfig(fallbackCfg);
  const sec = TF_SEC[obFibLtf(signal)] || 900;
  const { time } = obOfSignal(signal);
  const lux = signal?.metadata?.obFib?.lux || {};
  const len = +lux.length || cfg.obLength;
  const since = time ? Math.ceil((nowSec - time) / sec) : 0;
  return Math.min(1000, Math.max(cfg.lookback, since + len * 2 + 40));
}

/**
 * @param {object} signal  stored signal (metadata.ob + metadata.obFib.lux)
 * @param {object[]} candles  CLOSED LTF candles (oldest → newest)
 * @param {object} fallbackCfg  admin ob_fib config (used when the signal has no stored lux params)
 * @returns {{ok:boolean, code?:string, reason?:string, details?:object}}
 *   ok:true also when there is not enough data to decide (never invalidate on missing data).
 */
export function revalidateObFibSignal(signal, candles, fallbackCfg = {}) {
  const cfg = normalizeObFibConfig(fallbackCfg);
  const ob = obOfSignal(signal);
  if (!ob.time) return { ok: true, code: 'no_ob_time' };
  if (!Array.isArray(candles) || candles.length < 40) return { ok: true, code: 'no_data' };
  // the OB candle must be inside the downloaded window, otherwise we cannot judge
  if (+candles[0].time > ob.time) return { ok: true, code: 'ob_outside_window' };

  const lux = signal?.metadata?.obFib?.lux || {};
  const opts = {
    length: +lux.length || cfg.obLength,
    bullExtLast: +lux.bullExtLast || cfg.bullExtLast,
    bearExtLast: +lux.bearExtLast || cfg.bearExtLast,
    mitigation: lux.mitigation === 'Close' || lux.mitigation === 'Wick' ? lux.mitigation : cfg.mitigation,
  };
  const lookback = Math.min(candles.length, Math.max(cfg.lookback, candles.length));
  const live = detectLuxAlgoOrderBlocks(candles, lookback, opts);
  const still = live.find((x) => +x.time === ob.time && x.type === ob.type);
  if (still) return { ok: true, code: 'present', details: { status: still.status, tests: still.tests } };

  // gone — find out why, for a clear message
  let why = 'replaced';
  let at = null;
  try {
    const hist = detectLuxAlgoOrderBlocksHistorical(candles, lookback, opts);
    const h = hist.find((x) => +x.time === ob.time && x.type === ob.type);
    if (h && h.mitigatedAt != null) {
      why = 'mitigated';
      at = candles[h.mitigatedAt]?.time ?? null;
    } else if (!h) {
      why = 'flipped';
    }
  } catch (_) {}
  const msg =
    why === 'mitigated'
      ? `Order block mitigated (${opts.mitigation}) — LuxAlgo removed the zone`
      : why === 'flipped'
        ? 'Order block no longer valid in LuxAlgo (structure changed)'
        : 'Order block dropped out of the LuxAlgo list (newer order blocks replaced it)';
  return {
    ok: false,
    code: why,
    reason: msg,
    details: { obTime: ob.time, type: ob.type, mitigation: opts.mitigation, mitigatedAtTime: at },
  };
}
