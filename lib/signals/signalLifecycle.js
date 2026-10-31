import {
  SIGNAL_STATUS,
  canTransition,
  SIGNAL_CONFIG,
} from '../config/signalConfig.js';
import { getEntryProximity, calcPnlPercent, checkTpSl } from './proximity.js';
import {
  classifyEntrySide,
  evaluateEntryConfirmation,
  mergeEntryConfirmCfg,
  isPastTp1,
} from './entryConfirm.js';
import { buildInvalidationRecord } from './invalidation.js';
import {
  normalizeEmaCrossZoneConfig,
  signalEntryZone,
  isEmaAtCrossLevelInZone,
} from './emaCrossZone.js';
import { rsiDivergenceForDirection } from '../scanner/indicators.js';
import { rangeTouchesLevel } from './pathRange.js';

function qualityInvalidation(signal, previousStatus, qualityCheck, price, now) {
  const reasons = qualityCheck?.failures?.length
    ? qualityCheck.failures
    : [{
        category: 'Entry Quality',
        reason: qualityCheck?.reason || 'Entry quality re-check failed',
        actual: qualityCheck?.reScore ?? null,
        required: qualityCheck?.details?.requiredScore ?? null,
      }];
  return buildInvalidationRecord({
    signal,
    previousStatus,
    category: reasons[0]?.category || 'Entry Quality',
    reasons,
    price,
    at: now.toISOString(),
  });
}

function entryQualityFailed(signal, previousStatus, qualityCheck, price, now) {
  if (qualityCheck && qualityCheck.ok === false) {
    return qualityInvalidation(signal, previousStatus, qualityCheck, price, now);
  }
  return null;
}

function markEntryHit(signal, currentPrice, now, updates, events, notifications, liveCross = false, hitAtIso = null) {
  if (liveCross) {
    updates.metadata = {
      ...(signal.metadata || {}),
      nearBreakout: false,
      nearState: 'ENTERED_LIVE',
      liveEntry: true,
      breakoutConfirmed: false,
    };
  }

  updates.status = SIGNAL_STATUS.ONGOING;
  // First valid trigger is immutable: later entry touches must not move the marker.
  updates.entry_hit_at = signal.entry_hit_at || hitAtIso || now.toISOString();
  updates.entry_hit_price = signal.entry_hit_price ?? currentPrice;
  updates.last_updated_at = now.toISOString();
  // Ensure ready_at exists so auto-trader validation never rejects a legitimate ENTRY_HIT
  if (!signal.ready_at && !updates.ready_at) {
    updates.ready_at = signal.created_at || now.toISOString();
  }
  events.push({
    event_type: 'ENTRY_HIT',
    old_status: SIGNAL_STATUS.READY,
    new_status: SIGNAL_STATUS.ONGOING,
    price: currentPrice,
    message: 'Entry zone reached',
  });
  if (!signal.entry_notified) {
    notifications.push({ type: 'ENTRY_HIT', signal: { ...signal, ...updates } });
  }
}

/**
 * Apply lifecycle rules to an existing signal given current market data.
 * Returns { nextStatus, updates, events, notifications }
 * Does NOT persist — caller persists.
 */
/**
 * qualityCheck: optional { ok: boolean, reason?: string, reScore?: number }
 * When entry is hit and qualityCheck.ok === false → INVALIDATED (no ONGOING).
 */
/**
 * Near-breakout signal whose LIVE price has already crossed the entry level in the trade
 * direction (SHORT: price <= entry, LONG: price >= entry) → enter now at market
 * (don't wait for the candle close). Skips if price already ran > 0.5R past entry (chasing)
 * or is beyond the SL.
 */
export function nearLiveEntryCrossed(signal, price) {
  const entry = +signal.entry;
  const sl = +signal.sl;
  const p = +price;
  if (!entry || !sl || !p) return false;
  const dir = String(signal.direction || signal.dir || '').toUpperCase();
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return false;
  const moved = dir === 'LONG' ? p - entry : entry - p; // + = in favour
  if (dir !== 'LONG' && dir !== 'SHORT') return false;
  if (moved < 0) return false; // not reached entry yet
  if (moved > risk * 0.5) return false; // already ran — don't chase
  if (dir === 'LONG' ? p <= sl : p >= sl) return false;
  return true;
}

function harmonicDWasTouched(signal, currentPrice, candleRange) {
  const harmonic = signal.metadata?.harmonic;
  if (signal.metadata?.strategy !== 'harmonic' || !harmonic) return false;
  const entry = +(harmonic.D?.price ?? signal.entry);
  if (!(entry > 0)) return false;
  const zoneLow = Math.min(+(harmonic.przLow ?? entry), +(harmonic.przHigh ?? entry));
  const zoneHigh = Math.max(+(harmonic.przLow ?? entry), +(harmonic.przHigh ?? entry));
  const price = +currentPrice;
  const low = candleRange?.low != null ? +candleRange.low : price;
  const high = candleRange?.high != null ? +candleRange.high : price;
  return (low <= zoneHigh && high >= zoneLow) ||
    (String(signal.direction || signal.dir).toUpperCase() === 'LONG' ? price <= zoneHigh : price >= zoneLow);
}


/** LuxAlgo-style OB mitigation for live signals (WATCHING/READY). */
function isObFibZoneMitigated(signal, currentPrice, candleRange, mitigation = 'Wick') {
  const meta = signal.metadata || {};
  if ((meta.strategy || signal.strategy) !== 'ob_fib') return false;
  const ob = meta.ob || signal.ob || meta.obFib?.zone || {};
  const top = Math.max(+(ob.high ?? meta.obHigh ?? 0), +(ob.low ?? meta.obLow ?? 0));
  const btm = Math.min(+(ob.high ?? meta.obHigh ?? 0), +(ob.low ?? meta.obLow ?? 0));
  if (!(top > 0 && btm > 0 && top >= btm)) return false;
  const dir = String(signal.direction || signal.dir || '').toUpperCase();
  const price = +currentPrice;
  const low = candleRange?.low != null ? +candleRange.low : price;
  const high = candleRange?.high != null ? +candleRange.high : price;
  const close = candleRange?.close != null ? +candleRange.close : price;
  if (mitigation === 'Close') {
    if (dir === 'LONG') return close < btm;
    if (dir === 'SHORT') return close > top;
  }
  // Wick (LuxAlgo default): full pierce beyond the band
  if (dir === 'LONG') return low < btm;
  if (dir === 'SHORT') return high > top;
  return false;
}

export function applyLifecycle(signal, currentPrice, atr5m, now = new Date(), candleRange = null, qualityCheck = null, opts = {}) {
  const status = signal.status;
  const updates = {
    current_price: currentPrice,
    last_checked_at: now.toISOString(),
    last_price: currentPrice,
  };
  const events = [];
  const notifications = [];

  // OB + Fib: if LuxAlgo OB zone is already broken, signal is dead (no entry)
  if (status === SIGNAL_STATUS.WATCHING || status === SIGNAL_STATUS.READY) {
    const mit = signal.metadata?.obFib?.mitigation || signal.metadata?.mitigation || 'Wick';
    if (isObFibZoneMitigated(signal, currentPrice, candleRange, mit) && canTransition(status, SIGNAL_STATUS.INVALIDATED)) {
      const invalidation = buildInvalidationRecord({
        signal,
        previousStatus: status,
        category: 'Order Block',
        reasons: [{
          category: 'Order Block',
          reason: 'Order block mitigated (LuxAlgo) — zone no longer valid',
          actual: currentPrice,
          required: signal.metadata?.ob || signal.ob || null,
        }],
        price: currentPrice,
        at: now.toISOString(),
      });
      updates.status = SIGNAL_STATUS.INVALIDATED;
      updates.invalidated_at = now.toISOString();
      updates.metadata = {
        ...(signal.metadata || {}),
        invalidation,
        obMitigated: true,
      };
      events.push({
        event_type: 'INVALIDATED',
        old_status: status,
        new_status: SIGNAL_STATUS.INVALIDATED,
        price: currentPrice,
        message: invalidation.reason,
        metadata: { invalidation },
      });
      notifications.push({ type: 'INVALIDATED', signal: { ...signal, ...updates } });
      return { nextStatus: SIGNAL_STATUS.INVALIDATED, updates, events, notifications };
    }
  }

  // Age invalidation for pre-entry
  if (
    (status === SIGNAL_STATUS.WATCHING || status === SIGNAL_STATUS.READY) &&
    signal.created_at
  ) {
    const ageHrs =
      (now.getTime() - new Date(signal.created_at).getTime()) / 3600000;
    if (ageHrs > SIGNAL_CONFIG.maxSignalAgeHours) {
      if (canTransition(status, SIGNAL_STATUS.INVALIDATED)) {
          const invalidation = buildInvalidationRecord({
            signal,
            previousStatus: status,
            category: 'Expired',
            reasons: [{
              category: 'Expired',
              code: 'SIGNAL_AGE',
              reason: `Signal age ${ageHrs.toFixed(2)}h exceeds ${SIGNAL_CONFIG.maxSignalAgeHours}h limit`,
              actual: +ageHrs.toFixed(2),
              required: `≤ ${SIGNAL_CONFIG.maxSignalAgeHours}h`,
            }],
            price: currentPrice,
            at: now.toISOString(),
          });
          updates.metadata = { ...(signal.metadata || {}), invalidation };
        updates.status = SIGNAL_STATUS.INVALIDATED;
        updates.invalidated_at = now.toISOString();
        updates.last_updated_at = now.toISOString();
        events.push({
          event_type: 'INVALIDATED',
          old_status: status,
          new_status: SIGNAL_STATUS.INVALIDATED,
          price: currentPrice,
          message: invalidation.reason,
          metadata: { invalidation },
        });
        if (!signal.invalidated_notified) {
          notifications.push({ type: 'INVALIDATED', signal: { ...signal, ...updates } });
        }
        return { nextStatus: SIGNAL_STATUS.INVALIDATED, updates, events, notifications };
      }
    }
  }

  const prox = getEntryProximity(signal, currentPrice, atr5m, candleRange);
  updates.distance_to_entry = prox.distanceToEntry;
  updates.distance_percent = prox.distancePercent;
  updates.atr_distance = prox.atrDistance;
  updates.proximity_score = prox.proximityScore;
  updates.ready_threshold = prox.readyThreshold;
  updates.atr_5m = prox.atr5m;

  // Harmonic entries are limit reactions at projected D.
  // Default: wick/tick into D/PRZ → ONGOING.
  // When emaCrossZone.ongoingRequiresCross is ON: zone touch only makes READY;
  // ONGOING waits until EMA lines are at the cross (last level) inside the D zone.
  if (
    signal.metadata?.strategy === 'harmonic' &&
    (status === SIGNAL_STATUS.WATCHING || status === SIGNAL_STATUS.READY) &&
    harmonicDWasTouched(signal, currentPrice, candleRange)
  ) {
    const eczCfg = normalizeEmaCrossZoneConfig(opts.emaCrossZone);
    const closedCandlesHarm = opts.closedCandles || null;
    let crossLevel = null;

    if (eczCfg.ongoingRequiresCross && closedCandlesHarm?.length) {
      const zone = signalEntryZone(signal);
      if (zone) {
        crossLevel = isEmaAtCrossLevelInZone(closedCandlesHarm, zone.low, zone.high, {
          fast: eczCfg.fast,
          slow: eczCfg.slow,
        });
      } else {
        crossLevel = { ok: false, reason: 'no D zone' };
      }
    }

    const allowOngoing = !eczCfg.ongoingRequiresCross || crossLevel?.ok === true;
    // When toggle ON: READY only if EMA is at / about to cross inside D zone (not zone touch alone)
    const allowReady =
      !eczCfg.ongoingRequiresCross ||
      crossLevel?.ok === true ||
      // "about to cross" is still reported as ok:false with reason containing "not at cross" — treat approaching from helper
      (crossLevel && /about to cross|just crossed|just formed|still at cross/i.test(String(crossLevel.reason || '')));

    updates.metadata = {
      ...(signal.metadata || {}),
      ...(updates.metadata || {}),
      harmonicDHit: true,
      harmonicDHitAt: signal.metadata?.harmonicDHitAt || now.toISOString(),
      emaOngoingCross: crossLevel
        ? {
            ok: !!crossLevel.ok,
            reason: crossLevel.reason || null,
            cross: crossLevel.cross || null,
            checkedAt: now.toISOString(),
          }
        : signal.metadata?.emaOngoingCross || null,
    };

    if (!allowOngoing) {
      if (status === SIGNAL_STATUS.WATCHING && allowReady && canTransition(status, SIGNAL_STATUS.READY)) {
        updates.status = SIGNAL_STATUS.READY;
        updates.ready_at = now.toISOString();
        updates.last_updated_at = now.toISOString();
        events.push({
          event_type: 'READY',
          old_status: SIGNAL_STATUS.WATCHING,
          new_status: SIGNAL_STATUS.READY,
          price: currentPrice,
          message: crossLevel?.reason || 'D zone — EMA near cross level',
        });
        if (!signal.ready_notified) {
          notifications.push({ type: 'READY', signal: { ...signal, ...updates, status: SIGNAL_STATUS.READY } });
        }
        return { nextStatus: SIGNAL_STATUS.READY, updates, events, notifications };
      }
      // Toggle ON but EMA not near cross → stay WATCHING (do not flood READY)
      if (eczCfg.ongoingRequiresCross && status === SIGNAL_STATUS.WATCHING) {
        updates.last_updated_at = now.toISOString();
        return { nextStatus: SIGNAL_STATUS.WATCHING, updates, events, notifications };
      }
      // Already READY, waiting for cross level
      updates.status = SIGNAL_STATUS.READY;
      updates.last_updated_at = now.toISOString();
      return { nextStatus: SIGNAL_STATUS.READY, updates, events, notifications };
    }

    // Cross level OK → ONGOING
    let readySignal = signal;
    if (status === SIGNAL_STATUS.WATCHING) {
      updates.ready_at = now.toISOString();
      readySignal = { ...signal, status: SIGNAL_STATUS.READY, ready_at: signal.ready_at || now.toISOString() };
      events.push({
        event_type: 'READY',
        old_status: SIGNAL_STATUS.WATCHING,
        new_status: SIGNAL_STATUS.READY,
        price: currentPrice,
        message: 'D / PRZ + EMA at cross level',
      });
    }
    markEntryHit(readySignal, currentPrice, now, updates, events, notifications);
    updates.metadata = {
      ...(updates.metadata || {}),
      harmonicDHit: true,
      harmonicDHitAt: now.toISOString(),
    };
    return { nextStatus: SIGNAL_STATUS.ONGOING, updates, events, notifications };
  }

  // --- Entry confirmation config (no touch fills; close beyond → next candle) ---
  let ecfg = mergeEntryConfirmCfg(opts.entryConfirm);
  // Crypto-confluence loss review: require a cleaner 15m confirmation before changing READY → ONGOING.
  // This prevents a simple entry touch / weak close from becoming a trade, while preserving the setup itself.
  if (signal.metadata?.strategy === 'crypto_confluence' || signal.metadata?.strategy === 'powerful_max_gpt') {
    ecfg = {
      ...ecfg,
      minBreakBodyRatio: Math.max(ecfg.minBreakBodyRatio ?? 0.35, 0.45),
      minBreakBeyondATR: Math.max(ecfg.minBreakBeyondATR ?? 0.05, 0.10),
      retestConfirmBeyondATR: Math.max(ecfg.retestConfirmBeyondATR ?? 0.05, 0.10),
      maxChaseATR: Math.min(ecfg.maxChaseATR ?? 1.25, 0.90),
      maxChaseR: Math.min(ecfg.maxChaseR ?? 1.0, 0.75),
    };
  }
  const closedCandles = opts.closedCandles || null; // pattern/entry TF closed bars
  const entryConfirm = signal.metadata?.strategy !== 'harmonic' && closedCandles?.length
    ? evaluateEntryConfirmation(signal, closedCandles, atr5m, ecfg)
    : null;

  // Opposite RSI divergence at / into the order block must not go ONGOING.
  // Example: sell (bearish) OB + bullish RSI divergence underneath → INVALIDATED.
  // Applies to any setup that carries OB geometry (crypto_confluence and others).
  if (
    (status === SIGNAL_STATUS.WATCHING || status === SIGNAL_STATUS.READY) &&
    closedCandles?.length >= 30
  ) {
    const dir = String(signal.direction || signal.dir || '').toUpperCase();
    if (dir === 'LONG' || dir === 'SHORT') {
      const meta = signal.metadata || {};
      const ob = meta.ob || signal.ob || {};
      const obLow = +(ob.low ?? signal.ob_low ?? meta.obLow);
      const obHigh = +(ob.high ?? signal.ob_high ?? meta.obHigh);
      const hasOb = Number.isFinite(obLow) && Number.isFinite(obHigh) && obHigh >= obLow;
      const price = +currentPrice;
      const hi = candleRange?.high != null ? +candleRange.high : price;
      const lo = candleRange?.low != null ? +candleRange.low : price;
      // Touch = current bar or last price overlaps the OB zone (with tiny pad)
      const pad = Math.max((obHigh - obLow) * 0.05, Math.abs(price) * 0.0005);
      const touchesOb = hasOb && lo <= obHigh + pad && hi >= obLow - pad;
      // crypto_confluence: always re-check; other strategies: only when OB is being touched
      const shouldCheck =
        meta.strategy === 'crypto_confluence' || meta.strategy === 'powerful_max_gpt' || touchesOb || !hasOb;

      if (shouldCheck) {
        try {
          const rsiDiv = rsiDivergenceForDirection(closedCandles, dir, 14);
          if (rsiDiv.against && canTransition(status, SIGNAL_STATUS.INVALIDATED)) {
            const why = touchesOb
              ? `Order block touch + opposite RSI divergence — ${rsiDiv.detail}`
              : `Opposite RSI divergence blocks entry — ${rsiDiv.detail}`;
            const invalidation = buildInvalidationRecord({
              signal,
              previousStatus: status,
              category: 'Entry Quality',
              reasons: [{
                category: 'Entry Quality',
                code: touchesOb ? 'OB_TOUCH_OPPOSITE_RSI_DIV' : 'OPPOSITE_RSI_DIVERGENCE',
                reason: why,
                actual: rsiDiv.detail,
                required: dir === 'SHORT'
                  ? 'No bullish RSI divergence at sell order block'
                  : 'No bearish RSI divergence at buy order block',
              }],
              price: currentPrice,
              at: now.toISOString(),
            });
            updates.metadata = {
              ...(signal.metadata || {}),
              invalidation,
              oppositeRsiDivergence: true,
              obTouchInvalidation: !!touchesOb,
              rsiDivDetail: rsiDiv.detail,
            };
            updates.status = SIGNAL_STATUS.INVALIDATED;
            updates.invalidated_at = now.toISOString();
            updates.last_updated_at = now.toISOString();
            events.push({
              event_type: 'INVALIDATED',
              old_status: status,
              new_status: SIGNAL_STATUS.INVALIDATED,
              price: currentPrice,
              message: why,
              metadata: { invalidation },
            });
            if (!signal.invalidated_notified) {
              notifications.push({ type: 'INVALIDATED', signal: { ...signal, ...updates } });
            }
            return { nextStatus: SIGNAL_STATUS.INVALIDATED, updates, events, notifications };
          }
        } catch (_) {
          // If divergence cannot be evaluated, do not block entry on that alone.
        }
      }
    }
  }

  // Missed move: TP1 hit before entry fill, or confirm path blocked as chase/TP1 → invalidate.
  // opts.preEntryRange = high/low of EVERY candle since the signal was created, so a wick to
  // TP1 between two monitor ticks is never missed (previously only the current 5m candle
  // was checked → price could tag TP1, return to entry, and the signal still went live).
  const missedRange = opts.preEntryRange || candleRange;
  if (
    (status === SIGNAL_STATUS.WATCHING || status === SIGNAL_STATUS.READY) &&
    !signal.tp1_hit &&
    (isPastTp1(signal, currentPrice, missedRange) || entryConfirm?.chaseBlocked || entryConfirm?.tp1Missed)
  ) {
    if (canTransition(status, SIGNAL_STATUS.INVALIDATED)) {
      const tp1HitNow = isPastTp1(signal, currentPrice, missedRange) || entryConfirm?.tp1Missed;
      const invalidation = buildInvalidationRecord({
        signal,
        previousStatus: status,
        category: 'Missed Entry',
        reasons: [{
          category: 'Missed Entry',
          code: tp1HitNow ? 'TP1_BEFORE_ENTRY' : 'CHASE_TOO_FAR',
          reason: tp1HitNow
            ? 'Breakout/price reached TP1 before entry was filled — signal invalid'
            : (entryConfirm?.reason || 'Price ran too far past entry before fill — signal invalid'),
          actual: currentPrice,
          required: tp1HitNow ? 'Entry fill before TP1' : 'Entry within chase limits',
        }],
        price: currentPrice,
        at: now.toISOString(),
      });
      updates.metadata = { ...(signal.metadata || {}), invalidation, missedEntry: true };
      updates.status = SIGNAL_STATUS.INVALIDATED;
      updates.invalidated_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      events.push({
        event_type: 'INVALIDATED',
        old_status: status,
        new_status: SIGNAL_STATUS.INVALIDATED,
        price: currentPrice,
        message: invalidation.reason,
        metadata: { invalidation },
      });
      if (!signal.invalidated_notified) {
        notifications.push({ type: 'INVALIDATED', signal: { ...signal, ...updates } });
      }
      return { nextStatus: SIGNAL_STATUS.INVALIDATED, updates, events, notifications };
    }
  }

  // Promote PAST_ENTRY → RETEST watching metadata
  if (status === SIGNAL_STATUS.WATCHING || status === SIGNAL_STATUS.READY) {
    const side = classifyEntrySide(signal, currentPrice, atr5m, ecfg);
    if (side === 'PAST_ENTRY' && signal.metadata?.entryMode !== 'RETEST') {
      updates.metadata = {
        ...(signal.metadata || {}),
        ...(updates.metadata || {}),
        entryMode: 'RETEST',
        retestWatching: true,
      };
    }
    if (entryConfirm?.retestTouched) {
      updates.metadata = {
        ...(signal.metadata || {}),
        ...(updates.metadata || {}),
        retestTouched: true,
      };
    }
    if (entryConfirm?.breakConfirmed) {
      updates.metadata = {
        ...(signal.metadata || {}),
        ...(updates.metadata || {}),
        entryBreakConfirmed: true,
        entryBreakQuality: entryConfirm.quality || null,
        entryConfirmReason: entryConfirm.reason || null,
      };
    }
  }

  // --- WATCHING ---
  if (status === SIGNAL_STATUS.WATCHING) {
    // Near-breakout radar stays special; normal signals never use live-price touch entry
    const isNearBreakout =
      signal.metadata?.nearBreakout === true ||
      signal.metadata?.kind === 'NEAR_BREAKOUT';
    const allowLive =
      isNearBreakout &&
      opts.nearLiveEntry === true &&
      SIGNAL_CONFIG.disableLivePriceEntry !== true;
    const liveCross = allowLive && nearLiveEntryCrossed(signal, currentPrice);

    // READY when near entry OR retest mode already past entry (still watching for retest)
    const isRetest = (updates.metadata || signal.metadata || {}).entryMode === 'RETEST';
    let nearEnough = prox.isReady || isRetest || liveCross;
    // Harmonic + ONGOING-at-cross toggle: READY only when EMA is near/at cross in D zone
    if (
      nearEnough &&
      signal.metadata?.strategy === 'harmonic' &&
      normalizeEmaCrossZoneConfig(opts.emaCrossZone).ongoingRequiresCross
    ) {
      const zone = signalEntryZone(signal);
      const closed = opts.closedCandles || null;
      if (zone && closed?.length) {
        const cfg = normalizeEmaCrossZoneConfig(opts.emaCrossZone);
        const lvl = isEmaAtCrossLevelInZone(closed, zone.low, zone.high, {
          fast: cfg.fast,
          slow: cfg.slow,
        });
        nearEnough = !!lvl?.ok || /about to cross|just crossed|just formed|still at cross/i.test(String(lvl?.reason || ''));
        updates.metadata = {
          ...(signal.metadata || {}),
          ...(updates.metadata || {}),
          emaOngoingCross: {
            ok: !!lvl?.ok,
            reason: lvl?.reason || null,
            cross: lvl?.cross || null,
            checkedAt: now.toISOString(),
          },
        };
      } else {
        nearEnough = false;
      }
    }
    if (nearEnough && canTransition(status, SIGNAL_STATUS.READY)) {
      updates.status = SIGNAL_STATUS.READY;
      updates.ready_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      events.push({
        event_type: 'READY',
        old_status: status,
        new_status: SIGNAL_STATUS.READY,
        price: currentPrice,
        message: isRetest
          ? 'Retest watching — wait pullback + close beyond entry, enter next candle'
          : liveCross
            ? 'Near-breakout live cross — READY'
            : `Proximity ${prox.proximityScore}% — wait candle CLOSE beyond entry, then next candle enter`,
      });
      if (!signal.ready_notified) {
        notifications.push({ type: 'READY', signal: { ...signal, ...updates } });
      }
      return { nextStatus: SIGNAL_STATUS.READY, updates, events, notifications };
    }
  }

  // Pre-entry SL: if price already hit stop while still WATCHING/READY, kill the setup.
  // (Previously SL was only evaluated in ONGOING — chart could show price through SL while status stayed READY.)
  if (
    (status === SIGNAL_STATUS.WATCHING || status === SIGNAL_STATUS.READY) &&
    signal.sl != null &&
    Number(signal.sl) > 0
  ) {
    const preHits = checkTpSl(signal, currentPrice, candleRange);
    if (preHits.slHit && canTransition(status, SIGNAL_STATUS.INVALIDATED)) {
      const dir = String(signal.direction || signal.dir || '').toUpperCase();
      const invalidation = buildInvalidationRecord({
        signal,
        previousStatus: status,
        category: 'Stop Loss',
        reasons: [{
          category: 'Stop Loss',
          reason: `SL hit before entry (${dir || '—'}) @ ${currentPrice}`,
          actual: currentPrice,
          required: signal.sl,
        }],
        price: currentPrice,
        at: now.toISOString(),
      });
      updates.status = SIGNAL_STATUS.INVALIDATED;
      updates.invalidated_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      updates.metadata = {
        ...(signal.metadata || {}),
        invalidation,
        preEntrySlHit: true,
      };
      events.push({
        event_type: 'INVALIDATED',
        old_status: status,
        new_status: SIGNAL_STATUS.INVALIDATED,
        price: currentPrice,
        message: `SL hit before entry @ ${currentPrice}`,
        metadata: { invalidation, preEntrySlHit: true },
      });
      if (!signal.invalidated_notified) {
        notifications.push({ type: 'INVALIDATED', signal: { ...signal, ...updates } });
      }
      return { nextStatus: SIGNAL_STATUS.INVALIDATED, updates, events, notifications };
    }
  }

  // --- READY ---
  if (status === SIGNAL_STATUS.READY) {
    const isNearBreakoutReady =
      signal.metadata?.nearBreakout === true ||
      signal.metadata?.kind === 'NEAR_BREAKOUT';
    const allowLiveReady =
      isNearBreakoutReady &&
      opts.nearLiveEntry === true &&
      SIGNAL_CONFIG.disableLivePriceEntry !== true;
    const liveCrossReady = allowLiveReady && nearLiveEntryCrossed(signal, currentPrice);

    // Primary path: candle close beyond entry + next candle (no touch)
    // ONGOING needs the entry level to have really been traded through since the signal was
    // born (full candle range). Without this a SHORT whose price already sat BELOW entry
    // "closed beyond entry" and went ONGOING although entry was never touched.
    const entryTol = (SIGNAL_CONFIG.entryToleranceATR || 0) * (prox.atr5m || 0);
    const entryTouched = opts.preEntryRange
      ? rangeTouchesLevel(opts.preEntryRange, signal.entry, entryTol)
      : true; // no candle history supplied (legacy callers / tests)
    const confirmEnter = entryConfirm?.canEnter === true && entryTouched;
    // Entry fill: price/candle has traded into the entry band (prox.entryHit) AND the
    // post-signal range actually touched entry (entryTouched). This is the real limit-fill
    // path — without it signals stayed READY on the chart with NOW sitting on ENTRY.
    // Still blocked by chase/TP1-missed flags from entryConfirm when present.
    // Stale fill: after READY the candles traded THROUGH entry, but price has since moved out of the
    // entry band (prox.entryHit is false) — the signal used to stay READY forever while the chart
    // showed price beyond entry.  readyRange only covers candles since ready_at, so a touch that
    // happened before READY never counts.
    const rangeFilled =
      !!opts.readyRange && rangeTouchesLevel(opts.readyRange, signal.entry, entryTol);
    const entryFilled =
      ((prox.entryHit === true && entryTouched) || rangeFilled) &&
      !entryConfirm?.chaseBlocked &&
      !entryConfirm?.tp1Missed;
    const canGoOngoing = confirmEnter || liveCrossReady || entryFilled;

    if (canGoOngoing && canTransition(status, SIGNAL_STATUS.ONGOING)) {
      const invalidation = entryQualityFailed(signal, status, qualityCheck, currentPrice, now);
      if (invalidation) {
        if (canTransition(status, SIGNAL_STATUS.INVALIDATED)) {
          updates.status = SIGNAL_STATUS.INVALIDATED;
          updates.invalidated_at = now.toISOString();
          updates.last_updated_at = now.toISOString();
          updates.metadata = {
            ...(signal.metadata || {}),
            entryQualityFail: qualityCheck.reason,
            ...(qualityCheck.reScore != null ? { reScoreAtEntry: qualityCheck.reScore } : {}),
            invalidation,
          };
          events.push({
            event_type: 'INVALIDATED',
            old_status: status,
            new_status: SIGNAL_STATUS.INVALIDATED,
            price: currentPrice,
            message: invalidation.reason,
            metadata: { invalidation },
          });
          if (!signal.invalidated_notified) {
            notifications.push({ type: 'INVALIDATED', signal: { ...signal, ...updates } });
          }
          return { nextStatus: SIGNAL_STATUS.INVALIDATED, updates, events, notifications };
        }
      }

      updates.metadata = {
        ...(signal.metadata || {}),
        ...(updates.metadata || {}),
        entryConfirm: entryConfirm
          ? {
              mode: (signal.metadata || {}).entryMode || 'NORMAL',
              reason: entryConfirm.reason,
              quality: entryConfirm.quality,
              chaseAtr: entryConfirm.chaseAtr,
            }
          : entryFilled
            ? { mode: 'ENTRY_FILL', reason: 'entry band filled — ONGOING' }
            : { mode: 'LIVE_NEAR', reason: 'near-breakout live cross' },
        ...(entryFilled && !confirmEnter && !liveCrossReady
          ? { entryFillPath: prox.entryHit === true ? 'entry_band_touch' : 'entry_range_touch' }
          : {}),
      };
      // stamp entry_hit_at with the real fill candle when we know it (never later than now)
      const touchIso =
        Number.isFinite(+opts.entryTouchAt) && +opts.entryTouchAt * 1000 <= now.getTime()
          ? new Date(+opts.entryTouchAt * 1000).toISOString()
          : null;
      markEntryHit(signal, currentPrice, now, updates, events, notifications, liveCrossReady, entryFilled ? touchIso : null);
      if (entryConfirm?.canEnter) {
        events[events.length - 1].message =
          entryConfirm.reason || 'Entry on next candle after break close';
      }
      return { nextStatus: SIGNAL_STATUS.ONGOING, updates, events, notifications };
    }
    // stay READY — waiting for break close / next candle / retest
    if (entryConfirm?.canEnter === true && !entryTouched) {
      updates.metadata = {
        ...(signal.metadata || {}),
        ...(updates.metadata || {}),
        entryConfirmReason: 'waiting for price to touch the entry level',
      };
    } else if (entryConfirm?.reason) {
      updates.metadata = {
        ...(signal.metadata || {}),
        ...(updates.metadata || {}),
        entryConfirmReason: entryConfirm.reason,
        entryBreakConfirmed: !!entryConfirm.breakConfirmed,
      };
    }
  }

  // --- ONGOING ---
  if (status === SIGNAL_STATUS.ONGOING) {
    const pnl = calcPnlPercent(signal, currentPrice);
    updates.current_pnl_percent = pnl;
    if (signal.max_profit_percent == null || pnl > +signal.max_profit_percent) {
      updates.max_profit_percent = pnl;
    }
    if (signal.max_loss_percent == null || pnl < +signal.max_loss_percent) {
      updates.max_loss_percent = pnl;
    }

    let hits;
    if (opts.pathHits) {
      // Candle-by-candle path since the entry fill: TP touches before the stop-out count,
      // TP touches after it do not. Live price is still checked on top of that.
      const base = checkTpSl(signal, currentPrice, null);
      const p = opts.pathHits;
      hits = {
        tp1Hit: !!(base.tp1Hit || p.tp1),
        tp2Hit: !!(base.tp2Hit || p.tp2),
        tp3Hit: !!(base.tp3Hit || p.tp3),
        slHit: !!(base.slHit || p.sl),
      };
    } else {
      hits = checkTpSl(signal, currentPrice, candleRange);
    }

    // TP first (preserve flags if SL comes later)
    if (hits.tp1Hit && !signal.tp1_hit) {
      updates.tp1_hit = true;
      updates.tp1_hit_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      events.push({
        event_type: 'TP1_HIT',
        old_status: status,
        new_status: status,
        price: currentPrice,
        message: 'TP1 reached',
      });
      if (!signal.tp1_notified) {
        notifications.push({ type: 'TP1', signal: { ...signal, ...updates } });
      }
    }
    if (hits.tp2Hit && !signal.tp2_hit) {
      updates.tp2_hit = true;
      updates.tp2_hit_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      events.push({
        event_type: 'TP2_HIT',
        old_status: status,
        new_status: status,
        price: currentPrice,
        message: 'TP2 reached',
      });
      if (!signal.tp2_notified) {
        notifications.push({ type: 'TP2', signal: { ...signal, ...updates } });
      }
    }
    if (hits.tp3Hit && canTransition(status, SIGNAL_STATUS.COMPLETED_PROFIT)) {
      updates.tp3_hit = true;
      updates.tp3_hit_at = now.toISOString();
      updates.status = SIGNAL_STATUS.COMPLETED_PROFIT;
      updates.completed_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      events.push({
        event_type: 'TP3_HIT',
        old_status: status,
        new_status: SIGNAL_STATUS.COMPLETED_PROFIT,
        price: currentPrice,
        message: 'TP3 reached — completed',
      });
      if (!signal.tp3_notified) {
        notifications.push({ type: 'TP3', signal: { ...signal, ...updates } });
      }
      return {
        nextStatus: SIGNAL_STATUS.COMPLETED_PROFIT,
        updates,
        events,
        notifications,
      };
    }

    // apply tp flags even if not completing
    if (hits.tp1Hit) updates.tp1_hit = true;
    if (hits.tp2Hit) updates.tp2_hit = true;

    // SL after TP processing: still stop the trade, but tp1_hit/tp2_hit flags remain
    // so the live board can show TP1/TP2 category instead of pure SL
    const hadTp = !!(updates.tp1_hit || signal.tp1_hit || hits.tp1Hit);
    if (hits.slHit && canTransition(status, SIGNAL_STATUS.STOPPED)) {
      updates.status = SIGNAL_STATUS.STOPPED;
      updates.stopped_at = now.toISOString();
      updates.completed_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      events.push({
        event_type: 'STOPPED',
        old_status: status,
        new_status: SIGNAL_STATUS.STOPPED,
        price: currentPrice,
        message: hadTp
          ? `SL hit @ ${currentPrice} (after TP hit)`
          : `SL hit @ ${currentPrice}`,
      });
      if (!signal.sl_notified) {
        notifications.push({ type: hadTp ? 'SL_AFTER_TP' : 'SL', signal: { ...signal, ...updates } });
      }
      return { nextStatus: SIGNAL_STATUS.STOPPED, updates, events, notifications };
    }
  }

  updates.last_updated_at = now.toISOString();
  return { nextStatus: status, updates, events, notifications };
}

/**
 * Build a new WATCHING signal record from scan result.
 */
export function buildNewSignalRecord(scanResult, signalId, atr5m, now = new Date()) {
  const price = scanResult.price;
  const dir = scanResult.dir;
  const prox = getEntryProximity(
    {
      entry: scanResult.entry,
      sl: scanResult.sl,
      direction: dir,
      ob_high: scanResult.ob?.high,
      ob_low: scanResult.ob?.low,
      ob: scanResult.ob,
      strategy: scanResult.strategy,
      metadata: scanResult.metadata,
    },
    price,
    atr5m
  );

  // Limit-order style only: never birth as ONGOING (price already filled).
  // entryHit setups are rejected by scanner before this is called.
  let status = SIGNAL_STATUS.WATCHING;
  if (prox.isReady) status = SIGNAL_STATUS.READY;

  return {
    signal_id: signalId,
    symbol: scanResult.symbol,
    direction: dir,
    status,
    score: scanResult.score,
    entry: scanResult.entry,
    entry_hit_price: null,
    sl: scanResult.sl,
    tp1: scanResult.tp1,
    tp2: scanResult.tp2,
    tp3: scanResult.tp3,
    rr: scanResult.rr,
    current_price: price,
    current_pnl_percent: 0,
    atr_5m: atr5m,
    distance_to_entry: prox.distanceToEntry,
    distance_percent: prox.distancePercent,
    atr_distance: prox.atrDistance,
    proximity_score: prox.proximityScore,
    ready_threshold: prox.readyThreshold,
    ob_low: scanResult.ob?.low,
    ob_high: scanResult.ob?.high,
    ob_time: scanResult.ob?.time
      ? new Date(scanResult.ob.time * 1000).toISOString()
      : null,
    created_at: now.toISOString(),
    ready_at: status === SIGNAL_STATUS.READY ? now.toISOString() : null,
    entry_hit_at: null,
    last_checked_at: now.toISOString(),
    last_updated_at: now.toISOString(),
    last_price: price,
    max_profit_percent: 0,
    max_loss_percent: 0,
    tp1_hit: false,
    tp2_hit: false,
    tp3_hit: false,
    ready_notified: false,
    entry_notified: false,
    tp1_notified: false,
    tp2_notified: false,
    tp3_notified: false,
    sl_notified: false,
    invalidated_notified: false,
    metadata: {
      ...(scanResult.metadata || {}),
      conf: scanResult.conf,
      structure: scanResult.structure,
      pd: scanResult.pd,
      rvol: scanResult.rvol,
      ob: scanResult.ob,
      fvgs: scanResult.fvgs,
      liq: scanResult.liq,
      fib: scanResult.fib ?? scanResult.metadata?.fib,
      quality: scanResult.quality ?? scanResult.metadata?.quality,
      rejection: scanResult.rejection ?? scanResult.metadata?.rejection,
      elliottWave: scanResult.elliottWave ?? scanResult.metadata?.elliottWave,
      universal: scanResult.universal ?? scanResult.metadata?.universal,
    },
  };
}
