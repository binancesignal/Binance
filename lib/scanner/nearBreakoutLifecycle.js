/**
 * Near-breakout (BREAKING NOW) lifecycle:
 *  - Persist as WATCHING so refresh still shows them
 *  - On each cron: re-check price vs level
 *  - When candle CLOSES beyond level (fresh, not late) → promote to READY
 *  - Late / already-run breakouts are skipped (INVALIDATED)
 */
import { getKlines } from '../exchange/index.js';
import { calcATR } from './indicators.js';
import { detectPatterns } from './strategy/chartPattern/patterns.js';
import { validateBreakout, evaluateNearBreakout } from './strategy/chartPattern/breakout.js';
import { CHART_PATTERN_CONFIG } from './strategy/chartPattern/config.js';
import { resolveGateConfig } from './strategy/chartPattern/gates.js';
import { SIGNAL_STATUS } from '../config/signalConfig.js';
import { createSignal, updateSignal, getSignalById, createSignalEvent } from '../database/signals.js';
import { buildInvalidationRecord } from '../signals/invalidation.js';

function nearBreakoutInvalidation(sig, price, category, reason, actual, required) {
  return buildInvalidationRecord({
    signal: sig,
    previousStatus: sig.status,
    category,
    reasons: [{ category, reason, actual, required }],
    price,
  });
}

function mergeCfg(overrides) {
  return resolveGateConfig(CHART_PATTERN_CONFIG, overrides);
}

/**
 * Persist a near-breakout radar hit as a WATCHING signal (idempotent).
 */
export async function persistNearBreakout(near, atr5m = null) {
  if (!near?.symbol || !near?.signal_id) return { ok: false, reason: 'missing id' };
  const existing = await getSignalById(near.signal_id);
  const now = new Date().toISOString();
  const gapAtr = near.gapAtr != null ? +near.gapAtr : null;
  const state = near.state || 'APPROACHING';
  const dir = String(near.direction || near.dir || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const num = (v) => (v == null || v === '—' || v === '' ? null : Number.isFinite(+v) ? +v : null);

  const base = {
    symbol: near.symbol,
    direction: dir,
    status: SIGNAL_STATUS.WATCHING,
    score: num(near.score),
    entry: num(near.entry),
    sl: num(near.sl),
    tp1: num(near.tp1),
    tp2: num(near.tp2),
    tp3: num(near.tp3),
    rr: num(near.rr),
    current_price: num(near.price),
    atr_5m: atr5m != null ? num(atr5m) : null,
    atr_distance: gapAtr,
    distance_percent: num(near.gapPct),
    proximity_score: state === 'BREAKING_NOW' ? 90 : state === 'AT_LEVEL' ? 75 : 50,
    last_checked_at: now,
    last_updated_at: now,
    last_price: num(near.price),
    metadata: {
      ...(near.patternGeom ? { patternGeom: near.patternGeom } : {}),
      strategy: 'chart_pattern',
      kind: 'NEAR_BREAKOUT',
      nearBreakout: true,
      nearState: state,
      pattern: near.pattern,
      patternType: near.pattern,
      patternTf: near.patternTf,
      htf: near.htf,
      trigger: near.trigger,
      breakoutLevel: near.trigger,
      breakoutConfirmed: false,
      gapAtr,
      gapPct: near.gapPct,
      approaching: near.approaching,
      volBuild: near.volBuild,
      conf: near.conf,
      blockers: near.blockers,
      htfAligned: near.htfAligned,
      touches: near.touches,
    },
  };

  if (existing) {
    // Don't overwrite if already promoted / ongoing
    const st = String(existing.status || '').toUpperCase();
    if (['ONGOING', 'COMPLETED_PROFIT', 'STOPPED', 'INVALIDATED'].includes(st)) {
      return { ok: false, reason: 'terminal', existing: true };
    }
    if (existing.metadata?.breakoutConfirmed) {
      return { ok: false, reason: 'already confirmed', existing: true };
    }
    await updateSignal(near.signal_id, {
      ...base,
      // keep created_at
    });
    return { ok: true, updated: true, signal_id: near.signal_id };
  }

  await createSignal({
    signal_id: near.signal_id,
    ...base,
    created_at: now,
    entry_hit_at: null,
    ready_at: null,
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
    current_pnl_percent: 0,
    max_profit_percent: 0,
    max_loss_percent: 0,
  });
  try {
    await createSignalEvent({
      signal_id: near.signal_id,
      event_type: 'NEAR_BREAKOUT',
      old_status: null,
      new_status: SIGNAL_STATUS.WATCHING,
      price: near.price,
      message: `${state} · waiting candle close · gap ${gapAtr != null ? gapAtr.toFixed(2) : '?'} ATR`,
    });
  } catch (_) {}
  return { ok: true, created: true, signal_id: near.signal_id };
}

/**
 * Re-evaluate a stored NEAR_BREAKOUT signal.
 * Returns { action: 'hold'|'promote'|'invalidate', updates?, reason? }
 */
export async function recheckNearBreakout(sig, currentPrice, cfgOver = {}) {
  const meta = sig.metadata || {};
  if (!meta.nearBreakout && meta.kind !== 'NEAR_BREAKOUT') {
    return { action: 'skip' };
  }
  const tf = meta.patternTf || '15m';
  const cfg = mergeCfg(cfgOver);
  cfg.patternTf = tf;

  let candles;
  try {
    candles = await getKlines(sig.symbol, tf, cfg.patternKlineLimit || 120);
  } catch (e) {
    return { action: 'hold', reason: e.message };
  }
  if (!candles?.length) return { action: 'hold', reason: 'no candles' };

  const atr = calcATR(candles.slice(0, -1), 14) || 0;
  const patterns = detectPatterns(candles, atr);
  const wantType = meta.pattern || meta.patternType;
  const pattern =
    patterns.find((p) => p.patternType === wantType) ||
    patterns.find((p) => p.direction === (sig.direction || '').toUpperCase()) ||
    patterns[0];

  if (!pattern) {
    const reason = 'Pattern no longer detected';
    const invalidation = nearBreakoutInvalidation(sig, currentPrice, 'Breakout', reason, 'Not detected', wantType || 'Pattern must remain detected');
    return {
      action: 'invalidate',
      reason,
      invalidation,
      updates: {
        status: SIGNAL_STATUS.INVALIDATED,
        invalidated_at: invalidation.time,
        last_updated_at: invalidation.time,
        current_price: currentPrice,
        metadata: { ...meta, nearBreakout: false, invalidateReason: 'pattern_gone', invalidation },
      },
    };
  }

  // Try full breakout validation on CLOSED candle
  const br = validateBreakout(pattern, candles, atr, cfg);
  if (br.ok) {
    // Late filter: already extended beyond maxBreakoutDistanceATR
    const maxDist = cfg.maxBreakoutDistanceATR ?? 1.5;
    if (br.distAtr != null && br.distAtr > maxDist) {
      const reason = `Late breakout ${br.distAtr.toFixed(2)} ATR > ${maxDist}`;
      const invalidation = nearBreakoutInvalidation(sig, currentPrice, 'Breakout', reason, +br.distAtr.toFixed(4), `≤ ${maxDist} ATR`);
      return {
        action: 'invalidate',
        reason,
        invalidation,
        actual: +br.distAtr.toFixed(4),
        required: `≤ ${maxDist} ATR`,
        updates: {
          status: SIGNAL_STATUS.INVALIDATED,
          invalidated_at: invalidation.time,
          last_updated_at: invalidation.time,
          current_price: currentPrice,
          metadata: {
            ...meta,
            nearBreakout: false,
            breakoutConfirmed: false,
            lateBreakout: true,
            distAtr: br.distAtr,
            invalidateReason: 'late_breakout',
            invalidation,
          },
        },
      };
    }

    // Also skip if live price already past 0.5R toward TP1 from entry (move already happened)
    const entry = br.entry;
    const risk = Math.abs(entry - (sig.sl || entry));
    if (risk > 0) {
      const moved =
        br.direction === 'LONG'
          ? currentPrice - entry
          : entry - currentPrice;
      if (moved > risk * 0.5) {
        const rMultiple = moved / risk;
        const reason = 'Breakout already ran (>0.5R) — skip late entry';
        const invalidation = nearBreakoutInvalidation(sig, currentPrice, 'Breakout', reason, +rMultiple.toFixed(4), '≤ 0.5R');
        return {
          action: 'invalidate',
          reason,
          invalidation,
          actual: +rMultiple.toFixed(4),
          required: '≤ 0.5R',
          updates: {
            status: SIGNAL_STATUS.INVALIDATED,
            invalidated_at: invalidation.time,
            last_updated_at: invalidation.time,
            current_price: currentPrice,
            metadata: {
              ...meta,
              nearBreakout: false,
              lateBreakout: true,
              invalidateReason: 'already_ran',
              invalidation,
            },
          },
        };
      }
    }

    // PROMOTE → READY (breakout confirmed on close)
    const now = new Date().toISOString();
    return {
      action: 'promote',
      reason: 'Breakout confirmed on candle close',
      updates: {
        status: SIGNAL_STATUS.READY,
        ready_at: now,
        entry: entry,
        sl: sig.sl, // keep structural SL from near setup; levels already set
        current_price: currentPrice,
        atr_distance: br.distAtr != null ? +br.distAtr.toFixed(2) : 0.2,
        distance_percent: 0,
        proximity_score: 95,
        last_updated_at: now,
        last_checked_at: now,
        last_price: currentPrice,
        score: Math.max(+sig.score || 0, 70),
        metadata: {
          ...meta,
          nearBreakout: false,
          nearState: 'CONFIRMED',
          kind: 'CHART_PATTERN',
          breakoutConfirmed: true,
          breakoutLevel: br.level,
          breakoutCandleTime: br.breakoutCandle?.time ?? null,
          rvol: br.rvol,
          distAtr: br.distAtr,
          bodyRatio: br.bodyRatio,
          promotedAt: now,
        },
      },
    };
  }

  // Still waiting — refresh near state
  const nb = evaluateNearBreakout(pattern, candles, atr, currentPrice, cfg);
  if (!nb.ok) {
    // Drifted away from level
    const age = nb.age != null ? nb.age : 99;
    // nearMaxPatternAge: 0 = disable age-based invalidation (other rules still apply)
    const maxAge = cfg.nearMaxPatternAge ?? 30;
    if (maxAge > 0 && age > maxAge) {
      const reason = 'Near setup stale';
      const invalidation = nearBreakoutInvalidation(sig, currentPrice, 'Expired', reason, age, `≤ ${maxAge} candles`);
      return {
        action: 'invalidate',
        reason,
        invalidation,
        actual: age,
        required: `≤ ${maxAge} candles`,
        updates: {
          status: SIGNAL_STATUS.INVALIDATED,
          invalidated_at: invalidation.time,
          last_updated_at: invalidation.time,
          current_price: currentPrice,
          metadata: { ...meta, nearBreakout: false, invalidateReason: 'stale', invalidation },
        },
      };
    }
    return {
      action: 'hold',
      updates: {
        current_price: currentPrice,
        last_checked_at: new Date().toISOString(),
        last_price: currentPrice,
        atr_distance: nb.gapAtr,
        distance_percent: nb.gapPct,
        proximity_score: 30,
        metadata: { ...meta, nearState: 'AWAY', gapAtr: nb.gapAtr },
      },
    };
  }

  return {
    action: 'hold',
    updates: {
      current_price: currentPrice,
      last_checked_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
      last_price: currentPrice,
      atr_distance: nb.gapAtr,
      distance_percent: nb.gapPct,
      proximity_score:
        nb.state === 'BREAKING_NOW' ? 90 : nb.state === 'AT_LEVEL' ? 75 : 55,
      metadata: {
        ...meta,
        nearState: nb.state,
        gapAtr: nb.gapAtr,
        gapPct: nb.gapPct,
        approaching: nb.approaching,
        volBuild: nb.volBuild,
      },
    },
  };
}
