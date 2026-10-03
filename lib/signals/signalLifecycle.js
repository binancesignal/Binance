import {
  SIGNAL_STATUS,
  canTransition,
  SIGNAL_CONFIG,
} from '../config/signalConfig.js';
import { getEntryProximity, calcPnlPercent, checkTpSl } from './proximity.js';
import { buildInvalidationRecord } from './invalidation.js';

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

function markEntryHit(signal, currentPrice, now, updates, events, notifications, liveCross = false) {
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
  updates.entry_hit_at = now.toISOString();
  updates.entry_hit_price = currentPrice;
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

export function applyLifecycle(signal, currentPrice, atr5m, now = new Date(), candleRange = null, qualityCheck = null, opts = {}) {
  const status = signal.status;
  const updates = {
    current_price: currentPrice,
    last_checked_at: now.toISOString(),
    last_price: currentPrice,
  };
  const events = [];
  const notifications = [];

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

  // --- WATCHING ---
  if (status === SIGNAL_STATUS.WATCHING) {
    // Near-breakout radar: wait for candle CLOSE confirmation (recheckNearBreakout).
    // Never treat proximity as ENTRY HIT while still waiting for breakout.
    const isNearBreakout =
      signal.metadata?.nearBreakout === true ||
      signal.metadata?.kind === 'NEAR_BREAKOUT';

    const liveCross = isNearBreakout && opts.nearLiveEntry === true && nearLiveEntryCrossed(signal, currentPrice);
    const entryReached = (prox.entryHit && !isNearBreakout) || liveCross;
    if ((prox.isReady || entryReached) && canTransition(status, SIGNAL_STATUS.READY)) {
      updates.status = SIGNAL_STATUS.READY;
      updates.ready_at = now.toISOString();
      updates.last_updated_at = now.toISOString();
      events.push({
        event_type: 'READY',
        old_status: status,
        new_status: SIGNAL_STATUS.READY,
        price: currentPrice,
        message: entryReached
          ? 'Entry level reached — READY; entry confirmation runs on a later evaluation'
          : `Proximity ${prox.proximityScore}% (≤ ${prox.readyThresholdATR.toFixed(2)} ATR)`,
      });
      if (!signal.ready_notified) {
        notifications.push({ type: 'READY', signal: { ...signal, ...updates } });
      }
      return { nextStatus: SIGNAL_STATUS.READY, updates, events, notifications };
    }
  }

  // --- READY ---
  if (status === SIGNAL_STATUS.READY) {
    const isNearBreakoutReady =
      signal.metadata?.nearBreakout === true ||
      signal.metadata?.kind === 'NEAR_BREAKOUT';
    const liveCrossReady = isNearBreakoutReady && opts.nearLiveEntry === true && nearLiveEntryCrossed(signal, currentPrice);
    if (
      ((prox.entryHit && !isNearBreakoutReady) || liveCrossReady) &&
      canTransition(status, SIGNAL_STATUS.ONGOING)
    ) {
      // Entry-time quality gate
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

      markEntryHit(signal, currentPrice, now, updates, events, notifications, liveCrossReady);
      return { nextStatus: SIGNAL_STATUS.ONGOING, updates, events, notifications };
    }
    // still ready or drifted away — stay READY (no reverse to WATCHING)
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

    const hits = checkTpSl(signal, currentPrice, candleRange);

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
        message: `SL hit @ ${currentPrice}`,
      });
      if (!signal.sl_notified) {
        notifications.push({ type: 'SL', signal: { ...signal, ...updates } });
      }
      return { nextStatus: SIGNAL_STATUS.STOPPED, updates, events, notifications };
    }

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
