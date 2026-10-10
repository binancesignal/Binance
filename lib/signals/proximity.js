import { SIGNAL_CONFIG } from '../config/signalConfig.js';

/**
 * Dynamic entry proximity using ATR + OB width.
 * Optional candleRange { high, low } improves touch detection between cron ticks.
 */
export function getEntryProximity(signal, currentPrice, atr5m, candleRange = null) {
  const entry = +signal.entry;
  const price = +currentPrice;
  const distanceToEntry = Math.abs(price - entry);
  const distancePercent = entry ? (distanceToEntry / entry) * 100 : 999;

  const obHigh = +(signal.ob_high ?? signal.ob?.high ?? entry);
  const obLow = +(signal.ob_low ?? signal.ob?.low ?? entry);
  const obWidth = Math.abs(obHigh - obLow) || distanceToEntry;
  const riskDistance = Math.abs(entry - +(signal.sl ?? entry));

  const atr = atr5m && atr5m > 0 ? atr5m : riskDistance * 0.3 || entry * 0.002;

  let readyDistance = Math.min(
    SIGNAL_CONFIG.readyDistanceATR * atr,
    0.5 * obWidth
  );

  const minDist = (SIGNAL_CONFIG.minReadyDistancePct / 100) * entry;
  const maxDist = (SIGNAL_CONFIG.maxReadyDistancePct / 100) * entry;
  readyDistance = Math.max(minDist, Math.min(maxDist, readyDistance));

  const atrDistance = atr > 0 ? distanceToEntry / atr : 999;
  const proximityScore = Math.max(
    0,
    Math.min(100, Math.round((1 - distanceToEntry / (readyDistance * 2 || 1)) * 100))
  );

  const isReady = distanceToEntry <= readyDistance;

  const entryTol = SIGNAL_CONFIG.entryToleranceATR * atr;
  const hi = candleRange?.high != null ? +candleRange.high : price;
  const lo = candleRange?.low != null ? +candleRange.low : price;
  const isIctSmc = (signal.metadata?.strategy || signal.strategy) === 'ict_smc';

  // Entry fill = tight band around entry ONLY (never the full entry→SL range).
  // Bug before: SHORT used [entry − tol, SL + tol], so price still ABOVE entry
  // but below SL counted as ENTRY HIT (false alarm on about-to-break signals).
  let entryHit = false;
  if (signal.direction === 'LONG' || signal.dir === 'LONG') {
    // LONG limit below market: filled when price trades down into entry band
    entryHit =
      (price <= entry + entryTol && price >= entry - entryTol * 2) ||
      (lo <= entry + entryTol && lo >= entry - entryTol * 2);
  } else if (isIctSmc) {
    // ICT bearish POIs are limit sells above the post-BOS price: wait for a
    // retrace UP into entry (mirror the bullish retrace DOWN into entry).
    entryHit =
      (price >= entry - entryTol && price <= entry + entryTol * 2) ||
      (hi >= entry - entryTol && lo <= entry + entryTol * 2);
  } else {
    // SHORT: filled only when price has dropped TO entry (at or below entry + tol)
    // Market still above entry → NOT hit.
    entryHit =
      price <= entry + entryTol ||
      lo <= entry + entryTol;
  }

  return {
    distanceToEntry,
    distancePercent,
    atrDistance,
    obWidth,
    riskDistance,
    readyThreshold: readyDistance,
    readyThresholdATR: atr > 0 ? readyDistance / atr : SIGNAL_CONFIG.readyDistanceATR,
    proximityScore,
    isReady,
    entryHit,
    atr5m: atr,
  };
}

export function calcPnlPercent(signal, currentPrice) {
  const entry = +(signal.entry_hit_price || signal.entry);
  const price = +currentPrice;
  if (!entry) return 0;
  if (signal.direction === 'LONG' || signal.dir === 'LONG') {
    return ((price - entry) / entry) * 100;
  }
  return ((entry - price) / entry) * 100;
}

/**
 * TP/SL using last price + optional candle high/low.
 * If both SL and TP appear in the same candle range, do NOT invent order —
 * prefer the more conservative outcome already chosen by caller / status path.
 */
export function checkTpSl(signal, currentPrice, candleRange = null) {
  const price = +currentPrice;
  const dir = signal.direction || signal.dir;
  const hi = candleRange?.high != null ? +candleRange.high : price;
  const lo = candleRange?.low != null ? +candleRange.low : price;

  const result = {
    tp1Hit: !!signal.tp1_hit,
    tp2Hit: !!signal.tp2_hit,
    tp3Hit: !!signal.tp3_hit,
    slHit: false,
  };

  if (dir === 'LONG') {
    if (hi >= +signal.tp1 || price >= +signal.tp1) result.tp1Hit = true;
    if (hi >= +signal.tp2 || price >= +signal.tp2) result.tp2Hit = true;
    if (hi >= +signal.tp3 || price >= +signal.tp3) result.tp3Hit = true;
    if (lo <= +signal.sl || price <= +signal.sl) result.slHit = true;
  } else {
    if (lo <= +signal.tp1 || price <= +signal.tp1) result.tp1Hit = true;
    if (lo <= +signal.tp2 || price <= +signal.tp2) result.tp2Hit = true;
    if (lo <= +signal.tp3 || price <= +signal.tp3) result.tp3Hit = true;
    if (hi >= +signal.sl || price >= +signal.sl) result.slHit = true;
  }
  return result;
}
