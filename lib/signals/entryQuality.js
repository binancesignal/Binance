/**
 * Entry-time quality re-validation.
 * Scan-time score can decay — block READY→ONGOING / auto-trade if setup is dead.
 */
import { detectStructure } from '../scanner/structure.js';
import { detectOrderBlocks } from '../scanner/orderBlocks.js';
import { scoreSetup } from '../scanner/scoreSetup.js';
import { SIGNAL_CONFIG } from '../config/signalConfig.js';

export const ENTRY_QUALITY_DEFAULTS = {
  enabled: true,
  requireHtfStillAligned: true,
  requireObNearEntry: true,
  requireNoOppositeChoCh: true,
  /** re-score must be >= max(minScore, originalScore - scoreDropTolerance) */
  scoreDropTolerance: 15,
  useDashboardMinScore: true,
  minRrAtEntry: 1.2,
  /** OB zone must still be within this ATR of entry (or touch) */
  obNearEntryAtr: 2.5,
};

/**
 * @returns {{ ok: boolean, reason?: string, reScore?: number, details?: object }}
 */
export function revalidateEntryQuality(signal, htfCandles, obCandles, currentPrice, opts = {}) {
  const cfg = { ...ENTRY_QUALITY_DEFAULTS, ...opts };
  if (!cfg.enabled) return { ok: true, reason: 'quality check disabled' };
  const failures = [];
  const fail = (category, code, reason, actual = null, required = null, details = null) => {
    failures.push({ category, code, reason, actual, required, ...(details ? { details } : {}) });
  };

  const dir = String(signal.direction || signal.dir || '').toUpperCase();
  if (dir !== 'LONG' && dir !== 'SHORT') {
    fail('Entry Quality', 'DIRECTION', 'Invalid direction', dir, 'LONG or SHORT');
    return { ok: false, reason: failures[0].reason, failures };
  }

  const entry = +signal.entry;
  const sl = +signal.sl;
  const tp1 = +signal.tp1;
  const price = +currentPrice || +signal.current_price || entry;
  const originalScore = +signal.score || 0;
  const minScore = cfg.minScore != null ? +cfg.minScore : SIGNAL_CONFIG.minScore ?? 80;
  const atr = +signal.atr_5m || +opts.atr5m || 0;

  // --- SL / RR integrity ---
  if (!entry || !sl) {
    fail('Risk / RR', 'MISSING_LEVELS', 'Missing entry or SL', { entry, sl }, 'Both levels required');
    return { ok: false, reason: failures.map((item) => item.reason).join('; '), failures };
  }
  if (dir === 'LONG' && !(sl < entry)) {
    fail('Risk / RR', 'SL_POSITION', 'LONG SL must be below entry', sl, `< ${entry}`);
  }
  if (dir === 'SHORT' && !(sl > entry)) {
    fail('Risk / RR', 'SL_POSITION', 'SHORT SL must be above entry', sl, `> ${entry}`);
  }

  const risk = Math.abs(entry - sl);
  if (risk <= 0) {
    fail('Risk / RR', 'ZERO_RISK', 'Zero risk distance', risk, '> 0');
    return { ok: false, reason: failures.map((item) => item.reason).join('; '), failures };
  }
  let rr = null;
  const minRr = cfg.minRrAtEntry ?? 1.2;
  if (tp1) {
    const reward = Math.abs(+tp1 - entry);
    rr = reward / risk;
    if (rr + 1e-6 < minRr) {
      fail('Risk / RR', 'RR', `RR ${rr.toFixed(2)} < min ${minRr} at entry`, +rr.toFixed(4), minRr, { reward, risk });
    }
  }

  if (!htfCandles?.length || !obCandles?.length) {
    // Without candles, preserve the existing behavior: structural price/RR
    // checks still apply, but unavailable deep checks do not become failures.
    return failures.length
      ? { ok: false, reason: failures.map((item) => item.reason).join('; '), failures, details: { rr, minRr } }
      : { ok: true, reason: 'No candles for deep re-check — SL/RR only', reScore: originalScore, details: { rr, minRr } };
  }

  const htf = detectStructure(htfCandles);
  const details = {
    htfBias: htf.bias,
    htfBos: htf.bos,
    htfChoch: htf.choch,
  };

  // --- Opposite CHOCH / bias ---
  if (cfg.requireNoOppositeChoCh) {
    if (dir === 'LONG' && (htf.choch === 'bearish' || htf.bos === 'bearish')) {
      fail('HTF / Structure', 'OPPOSITE_STRUCTURE', 'HTF bearish CHOCH/BOS against LONG', {
        bias: htf.bias,
        bos: htf.bos,
        choch: htf.choch,
      }, 'No bearish CHOCH/BOS for LONG', details);
    }
    if (dir === 'SHORT' && (htf.choch === 'bullish' || htf.bos === 'bullish')) {
      fail('HTF / Structure', 'OPPOSITE_STRUCTURE', 'HTF bullish CHOCH/BOS against SHORT', {
        bias: htf.bias,
        bos: htf.bos,
        choch: htf.choch,
      }, 'No bullish CHOCH/BOS for SHORT', details);
    }
  }

  if (cfg.requireHtfStillAligned) {
    const aligned =
      dir === 'LONG'
        ? htf.bias === 'bullish' || htf.bos === 'bullish' || htf.choch === 'bullish'
        : htf.bias === 'bearish' || htf.bos === 'bearish' || htf.choch === 'bearish';
    // Neutral OK if not strongly opposite (already checked above)
    if (!aligned && htf.bias !== 'neutral') {
      fail('HTF / Structure', 'HTF_BIAS', `HTF bias ${htf.bias} not aligned with ${dir}`, {
        bias: htf.bias,
        bos: htf.bos,
        choch: htf.choch,
      }, `Bias/structure aligned with ${dir}`, details);
    }
  }

  // --- OB still near entry ---
  if (cfg.requireObNearEntry) {
    const obs = detectOrderBlocks(obCandles).filter((o) => o.status !== 'INVALIDATED');
    const dirObs = obs.filter((o) =>
      dir === 'LONG' ? o.type === 'bullish' : o.type === 'bearish'
    );
    const tol = atr > 0 ? atr * (cfg.obNearEntryAtr ?? 2.5) : Math.abs(entry) * 0.01;
    const nearestGap = dirObs.reduce((best, o) => {
      const mid = (o.low + o.high) / 2;
      const gap = entry >= o.low && entry <= o.high
        ? 0
        : Math.min(Math.abs(mid - entry), Math.abs(o.low - entry), Math.abs(o.high - entry));
      return Math.min(best, gap);
    }, Infinity);
    const near = nearestGap <= tol;
    // Also accept if original ob_low/ob_high still brackets entry
    const obL = +signal.ob_low;
    const obH = +signal.ob_high;
    const origOk =
      obL && obH && entry >= obL - tol && entry <= obH + tol;
    if (!near && !origOk) {
      const gap = Number.isFinite(nearestGap) ? +nearestGap.toFixed(8) : null;
      fail(
        'SMC / Order Block',
        'OB_NEAR_ENTRY',
        'Order block no longer valid near entry',
        { nearestGap: gap, matchingBlocks: dirObs.length, originalZone: obL && obH ? [obL, obH] : null },
        { maxGap: +tol.toFixed(8), unit: 'price' },
        { ...details, dirObs: dirObs.length, entry, atr }
      );
    }
  }

  // --- Re-score ---
  let reScore = 0;
  try {
    const results = scoreSetup(
      signal.symbol,
      htfCandles,
      obCandles,
      SIGNAL_CONFIG.entryStyle,
      0, // threshold 0 → collect all
      price,
      { includeAll: true }
    );
    const sameDir = results.filter((r) => r.dir === dir);
    reScore = sameDir.length ? Math.max(...sameDir.map((r) => +r.score || 0)) : 0;
  } catch (e) {
    fail('Score / Quality', 'RESCORE_ERROR', `Re-score failed: ${e.message}`, e.message, 'Successful score re-check');
    return { ok: false, reason: failures.map((item) => item.reason).join('; '), failures, details };
  }

  details.reScore = reScore;
  details.originalScore = originalScore;

  const floor = Math.max(
    cfg.useDashboardMinScore ? minScore : 0,
    originalScore - (cfg.scoreDropTolerance ?? 15)
  );
  // If original was high, don't allow huge drop; also enforce minScore
  const need = Math.max(minScore, Math.min(originalScore, floor));
  // clearer: must be >= minScore AND >= original - tolerance
  const needScore = Math.max(minScore, originalScore - (cfg.scoreDropTolerance ?? 15));
  if (reScore < needScore) {
    fail(
      'Score / Quality',
      'RESCORE',
      `Re-score ${reScore} < required ${needScore} (min ${minScore}, orig ${originalScore})`,
      reScore,
      needScore,
      { minScore, originalScore, scoreDropTolerance: cfg.scoreDropTolerance ?? 15 }
    );
  }

  details.rr = rr;
  details.minRr = minRr;
  details.requiredScore = needScore;
  details.minScore = minScore;
  return failures.length
    ? { ok: false, reason: failures.map((item) => item.reason).join('; '), reScore, failures, details }
    : { ok: true, reScore, details };
}
