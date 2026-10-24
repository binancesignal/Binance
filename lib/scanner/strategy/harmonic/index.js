import { calcATR, findSwings, calcEMASeries } from '../../indicators.js';
import {
  HARMONIC_FAMILIES,
  normalizeHarmonicConfig,
} from './config.js';

const ratioOf = (a, b) => (Math.abs(b) > 1e-12 ? Math.abs(a) / Math.abs(b) : 0);
const inRange = (value, [low, high]) => value >= low && value <= high;

function zoneTouchedSince(candles, fromIndex, entry, zone) {
  return candles.slice(Math.max(0, fromIndex)).some((candle) => (
    +candle.low <= entry + zone && +candle.high >= entry - zone
  ));
}

/**
 * Find the first (leftmost / earliest in time) EMA fast/slow cross after point C
 * that falls INSIDE the D-zone / PRZ horizontal band when that zone is extended
 * left in time. Same timeframe only (cfg.patternTf candles).
 *
 * "Inside D zone" = the cross candle overlaps [przLow, przHigh], or the EMA
 * values at the cross sit inside that band.
 */
function findFirstEmaCrossNearPrz(candles, fromIndex, entry, atr, direction, cfg, przLow, przHigh) {
  const fastP = cfg.emaFast || 20;
  const slowP = cfg.emaSlow || 50;
  if (!candles || candles.length < slowP + 2) return null;

  // Strict D-zone band (horizontal PRZ). Fallback to small ATR pad around entry
  // only when prz bounds are missing.
  let zLo;
  let zHi;
  if (przLow != null && przHigh != null && Number.isFinite(+przLow) && Number.isFinite(+przHigh)) {
    zLo = Math.min(+przLow, +przHigh);
    zHi = Math.max(+przLow, +przHigh);
  } else {
    const pad = Math.max((atr || 0) * (cfg.dZoneATR ?? 0.15), Math.abs(entry) * 0.0002);
    zLo = entry - pad;
    zHi = entry + pad;
  }

  const fast = calcEMASeries(candles, fastP);
  const slow = calcEMASeries(candles, slowP);
  const start = Math.max(fromIndex, slowP);
  let firstAny = null;
  let firstDirectional = null;

  for (let i = start + 1; i < candles.length; i++) {
    const f0 = fast[i - 1];
    const s0 = slow[i - 1];
    const f1 = fast[i];
    const s1 = slow[i];
    if (f0 == null || s0 == null || f1 == null || s1 == null) continue;

    const bullCross = f0 <= s0 && f1 > s1;
    const bearCross = f0 >= s0 && f1 < s1;
    if (!bullCross && !bearCross) continue;

    const c = candles[i];
    // D zone extended left: candle range overlaps the PRZ band, OR EMA mid is in band
    const candleInZone = +c.low <= zHi && +c.high >= zLo;
    const emaMid = (f1 + s1) / 2;
    const emaInZone = emaMid >= zLo && emaMid <= zHi;
    if (!candleInZone && !emaInZone) continue;

    const cross = {
      index: i,
      time: c.time,
      price: +c.close,
      type: bullCross ? 'bullish' : 'bearish',
      emaFast: f1,
      emaSlow: s1,
      inDZone: true,
      przLow: zLo,
      przHigh: zHi,
      // Same TF as the harmonic signal only
      tf: cfg.patternTf || null,
    };
    if (!firstAny) firstAny = cross;
    const wantsBull = direction === 'LONG';
    if ((wantsBull && bullCross) || (!wantsBull && bearCross)) {
      if (!firstDirectional) firstDirectional = cross;
      break;
    }
  }
  return firstDirectional || firstAny;
}

const XABCD_RULES = [
  { family: 'GARTLEY', xb: [0.55, 0.68], bc: [0.35, 0.92], target: 'xa', ratio: 0.786 },
  { family: 'BAT', xb: [0.35, 0.55], bc: [0.35, 0.92], target: 'xa', ratio: 0.886 },
  { family: 'ALT_BAT', xb: [0.33, 0.43], bc: [0.35, 0.92], target: 'xa', ratio: 1.13 },
  { family: 'DEEP_BAT', xb: [0.82, 0.95], bc: [0.35, 0.92], target: 'xa', ratio: 0.886 },
  { family: 'BUTTERFLY', xb: [0.72, 0.86], bc: [0.35, 0.92], target: 'xa', ratio: 1.414 },
  { family: 'CRAB', xb: [0.35, 0.65], bc: [0.35, 0.92], target: 'xa', ratio: 1.618 },
  { family: 'DEEP_CRAB', xb: [0.82, 0.95], bc: [0.35, 0.92], target: 'xa', ratio: 1.618 },
  { family: 'CYPHER', xb: [0.35, 0.65], bc: null, xc: [1.05, 1.5], target: 'xc', ratio: 0.786 },
  { family: 'SHARK', xb: [0.35, 0.65], bc: null, xc: [1.05, 1.7], target: 'xc', ratio: 1 },
];

function directionOf(points) {
  if (points[0].type === 'L' && points[1].type === 'H' && points[2].type === 'L' && points[3].type === 'H') return 'LONG';
  if (points[0].type === 'H' && points[1].type === 'L' && points[2].type === 'H' && points[3].type === 'L') return 'SHORT';
  return null;
}

function projectD(family, points, direction, rule = null) {
  const [X, A, B, C] = points;
  const dir = direction === 'LONG' ? 1 : -1;
  const xa = Math.abs(A.price - X.price);
  if (!(xa > 0)) return null;

  if (family === 'ABCD') {
    const ab = Math.abs(B.price - A.price);
    return { price: C.price - dir * ab, ratios: { xb: ratioOf(B.price - A.price, A.price - X.price), bc: ratioOf(C.price - B.price, B.price - A.price), cdAb: 1 } };
  }

  const xb = ratioOf(B.price - A.price, A.price - X.price);
  const bc = ratioOf(C.price - B.price, B.price - A.price);
  const xc = ratioOf(C.price - X.price, A.price - X.price);
  if (rule?.xb && !inRange(xb, rule.xb)) return null;
  if (rule?.bc && !inRange(bc, rule.bc)) return null;
  if (rule?.xc && !inRange(xc, rule.xc)) return null;

  const span = rule?.target === 'xc' ? Math.abs(C.price - X.price) : xa;
  return {
    price: rule?.target === 'xc'
      ? C.price - dir * rule.ratio * span
      : A.price - dir * rule.ratio * span,
    ratios: { xb, bc, xc, dProjection: rule.ratio },
  };
}

function makeSetup({ family, direction, points, target, score, atr, candles, cfg }) {
  const [X, A, B] = points;
  const C = points[points.length - 1];
  const entry = target.price;
  const dZone = Math.max(atr * cfg.dZoneATR, Math.abs(entry) * 0.0002);
  const risk = Math.max(atr * cfg.stopBufferATR, dZone * 1.5, Math.abs(C.price - entry) * 0.06);
  const height = Math.max(Math.abs(C.price - entry), atr * 0.5);
  const stop = direction === 'LONG' ? entry - risk : entry + risk;
  // D entries approach from the opposite side of the trade's targets: first
  // objective is the prior C pivot, then A, then a measured extension.
  const tp1Dist = Math.max(risk * 1.25, Math.abs(C.price - entry));
  const tp2Dist = Math.max(tp1Dist, Math.abs(A.price - entry));
  const tp3Dist = Math.max(tp2Dist, Math.abs(A.price - entry) + Math.abs(A.price - X.price) * 0.272);
  const sign = direction === 'LONG' ? 1 : -1;
  const pattern = `${family}_${direction === 'LONG' ? 'BULL' : 'BEAR'}`;
  const rr = tp1Dist / risk;
  const anchors = [
    { i: X.i, time: X.time, price: X.price, label: 'X' },
    { i: A.i, time: A.time, price: A.price, label: 'A' },
    { i: B.i, time: B.time, price: B.price, label: 'B' },
    { i: C.i, time: C.time, price: C.price, label: 'C' },
    { i: null, time: null, price: entry, label: 'D (projected)' },
  ];
  const zoneReadyDist = cfg.readyDistanceATR * atr;
  const przLow = entry - dZone;
  const przHigh = entry + dZone;

  // First (leftmost) EMA cross INSIDE the D-zone band (extended left in time)
  const emaCross = findFirstEmaCrossNearPrz(
    candles,
    typeof C.i === 'number' ? C.i : 0,
    entry,
    atr,
    direction,
    cfg,
    przLow,
    przHigh
  );
  const wantsBull = direction === 'LONG';
  const emaCrossOk = !!(
    emaCross &&
    ((wantsBull && emaCross.type === 'bullish') || (!wantsBull && emaCross.type === 'bearish'))
  );

  // Soft score boost when cross confirms; hard filter when emaCrossConfirm is on
  let finalScore = score;
  if (emaCrossOk) finalScore = Math.min(95, score + 6);
  else if (cfg.emaCrossConfirm) finalScore = Math.max(0, score - 25);

  return {
    strategy: 'harmonic',
    pattern,
    symbol: null,
    dir: direction,
    direction,
    score: finalScore,
    entry,
    sl: stop,
    tp1: entry + sign * tp1Dist,
    tp2: entry + sign * tp2Dist,
    tp3: entry + sign * tp3Dist,
    rr: rr.toFixed(1),
    price: null,
    atr,
    ob: {
      low: entry - zoneReadyDist,
      high: entry + zoneReadyDist,
      mid: entry,
      time: C.time,
      strength: finalScore,
      type: direction === 'LONG' ? 'bullish' : 'bearish',
      status: 'ACTIVE',
      displacement: 0,
    },
    quality: {
      harmonicPattern: true,
      harmonicFit: finalScore,
      breakoutConfirmed: false,
      emaCrossOk,
      emaCrossConfirmRequired: !!cfg.emaCrossConfirm,
    },
    // When confirm is required and no directional cross → reject setup
    reject: !!(cfg.emaCrossConfirm && !emaCrossOk),
    metadata: {
      strategy: 'harmonic',
      pattern,
      patternType: pattern,
      patternTf: cfg.patternTf,
      harmonic: {
        family,
        direction,
        X: { price: X.price, time: X.time },
        A: { price: A.price, time: A.time },
        B: { price: B.price, time: B.time },
        C: { price: C.price, time: C.time },
        D: { price: entry, time: null },
        przLow: entry - dZone,
        przHigh: entry + dZone,
        readyDistanceATR: cfg.readyDistanceATR,
        readyDistance: zoneReadyDist,
        dZoneATR: cfg.dZoneATR,
        ratios: target.ratios,
        anchors,
        emaCross: emaCross
          ? {
              type: emaCross.type,
              time: emaCross.time,
              price: emaCross.price,
              index: emaCross.index,
              emaFast: emaCross.emaFast,
              emaSlow: emaCross.emaSlow,
              ok: emaCrossOk,
              required: !!cfg.emaCrossConfirm,
              // Same TF as the harmonic signal (e.g. 1h signal → 1h cross only)
              tf: emaCross.tf || cfg.patternTf || null,
            }
          : null,
      },
      harmonicGeometry: {
        family,
        pattern,
        direction,
        anchors,
        support: direction === 'LONG' ? entry : C.price,
        resistance: direction === 'LONG' ? C.price : entry,
      },
      emaCrossConfirm: !!cfg.emaCrossConfirm,
    },
  };
}

function familyScore(ratios, rule) {
  const ratiosToScore = [];
  if (rule?.xb) {
    const mid = (rule.xb[0] + rule.xb[1]) / 2;
    ratiosToScore.push(Math.abs((ratios.xb - mid) / Math.max(0.01, (rule.xb[1] - rule.xb[0]) / 2)));
  }
  if (rule?.bc && ratios.bc != null) {
    const mid = (rule.bc[0] + rule.bc[1]) / 2;
    ratiosToScore.push(Math.abs((ratios.bc - mid) / Math.max(0.01, (rule.bc[1] - rule.bc[0]) / 2)));
  }
  if (rule?.xc && ratios.xc != null) {
    const mid = (rule.xc[0] + rule.xc[1]) / 2;
    ratiosToScore.push(Math.abs((ratios.xc - mid) / Math.max(0.01, (rule.xc[1] - rule.xc[0]) / 2)));
  }
  const fit = ratiosToScore.length
    ? Math.max(0, 1 - ratiosToScore.reduce((sum, value) => sum + value, 0) / ratiosToScore.length)
    : 0.65;
  return Math.round(56 + fit * 38);
}

function detectThreeDrives(swings, closed, atr, cfg, allCandles = closed) {
  const out = [];
  const recent = swings.slice(-18);
  for (let i = 0; i + 4 < recent.length; i++) {
    const points = recent.slice(i, i + 5);
    if (points.some((point, index) => index > 0 && point.type === points[index - 1].type)) continue;
    const bearish = points[0].type === 'L';
    const bullish = points[0].type === 'H';
    if (!bearish && !bullish) continue;
    const dirSpace = bearish ? 1 : -1;
    const values = points.map((point) => dirSpace * point.price);
    const [v0, v1, v2, v3, v4] = values;
    const d1 = v1 - v0;
    const c1 = v1 - v2;
    const d2 = v3 - v2;
    const c2 = v3 - v4;
    if (!(d1 > 0 && c1 > 0 && d2 > 0 && c2 > 0)) continue;
    const retr1 = c1 / d1;
    const ext2 = d2 / c1;
    const retr2 = c2 / d2;
    if (!(inRange(retr1, [0.55, 0.86]) && inRange(retr2, [0.55, 0.86]) && inRange(ext2, [1.2, 1.7]))) continue;
    const C = points[4];
    if (closed.length - 1 - C.i > cfg.maxPointAgeBars) continue;
    if (C.i - points[0].i > cfg.maxPatternSpanBars) continue;
    const direction = bearish ? 'SHORT' : 'LONG';
    const patternKey = `THREE_DRIVES_${direction === 'LONG' ? 'BULL' : 'BEAR'}`;
    if (!cfg.enabledPatterns.includes(patternKey)) continue;
    const entry = C.price + dirSpace * c2 * 1.45;
    const close = +closed[closed.length - 1]?.close;
    const zone = Math.max(atr * cfg.dZoneATR, Math.abs(entry) * 0.0002);
    if (zoneTouchedSince(allCandles, C.i, entry, zone)) continue;
    if (direction === 'LONG' ? close <= entry + zone : close >= entry - zone) continue;
    const fit = Math.max(0, 1 - (Math.abs(retr1 - 0.7) + Math.abs(retr2 - 0.7)) / 0.6 - Math.abs(ext2 - 1.45) / 0.5);
    const score = Math.round(56 + Math.min(1, fit) * 38);
    if (score < cfg.minSignalScore) continue;
    const setup = makeSetup({
      family: 'THREE_DRIVES',
      direction,
      points,
      target: { price: entry, ratios: { retr1, ext2, retr2, drive3: 1.45 } },
      score,
      atr,
      candles: closed,
      cfg,
    });
    setup.metadata.harmonic.anchors = points.map((point, k) => ({
      i: point.i,
      time: point.time,
      price: point.price,
      label: String(k + 1),
    })).concat([{ i: null, time: null, price: entry, label: 'D (projected)' }]);
    setup.metadata.harmonic.C = { price: C.price, time: C.time };
    setup.metadata.harmonic.D = { price: entry, time: null };
    setup.ob.time = C.time;
    out.push(setup);
  }
  return out;
}

export function detectProjectedHarmonicSetups(candles, price, inputConfig = {}) {
  const cfg = normalizeHarmonicConfig(inputConfig);
  if (!Array.isArray(candles) || candles.length < 40 || !(+price > 0) || cfg.enabledPatterns.length === 0) return [];
  const closed = candles.slice(0, -1);
  const atr = calcATR(closed, 14) || calcATR(candles, 14) || 0;
  if (!(atr > 0)) return [];
  const swings = findSwings(closed, 3, 3).slice(-24);
  if (swings.length < 4) return [];
  const out = [];
  const enabled = new Set(cfg.enabledFamilies);
  const enabledPatterns = new Set(cfg.enabledPatterns);
  const lastIndex = closed.length - 1;

  for (let i = 0; i + 3 < swings.length; i++) {
    const points = swings.slice(i, i + 4);
    if (points.some((point, index) => index > 0 && point.type === points[index - 1].type)) continue;
    const direction = directionOf(points);
    if (!direction) continue;
    const C = points[3];
    if (lastIndex - C.i > cfg.maxPointAgeBars || C.i - points[0].i > cfg.maxPatternSpanBars) continue;

    const candidates = [];
      const directionKey = `${direction === 'LONG' ? 'BULL' : 'BEAR'}`;
      if (enabled.has('ABCD') && enabledPatterns.has(`ABCD_${directionKey}`)) {
      const projected = projectD('ABCD', points, direction);
      if (projected && inRange(projected.ratios.xb, [0.35, 0.92]) && inRange(projected.ratios.bc, [0.35, 0.92])) {
        candidates.push({ family: 'ABCD', target: projected, score: 78 });
      }
    }
    for (const rule of XABCD_RULES) {
      if (!enabled.has(rule.family) || !enabledPatterns.has(`${rule.family}_${direction === 'LONG' ? 'BULL' : 'BEAR'}`)) continue;
      const target = projectD(rule.family, points, direction, rule);
      if (!target) continue;
      candidates.push({ family: rule.family, target, score: familyScore(target.ratios, rule) });
    }

    for (const candidate of candidates) {
      if (candidate.score < cfg.minSignalScore) continue;
      const entry = candidate.target.price;
      if (!(entry > 0) || Math.abs(entry - C.price) < atr * 0.15) continue;
      const zone = Math.max(atr * cfg.dZoneATR, Math.abs(entry) * 0.0002);
      // Only alert before price reaches the projected D; a missed reversal is not a new setup.
      if (zoneTouchedSince(candles, C.i, entry, zone)) continue;
      if (direction === 'LONG' ? +price <= entry + zone : +price >= entry - zone) continue;
      const result = makeSetup({
        family: candidate.family,
        direction,
        points,
        target: candidate.target,
        score: candidate.score,
        atr,
        candles: closed,
        cfg,
      });
      result.price = +price;
      out.push(result);
    }
  }

  if (enabled.has('THREE_DRIVES') && cfg.enabledPatterns.some((pattern) => pattern.startsWith('THREE_DRIVES_'))) {
    out.push(...detectThreeDrives(swings, closed, atr, cfg, candles).map((setup) => {
      setup.price = +price;
      return setup;
    }));
  }

  const seen = new Set();
  return out
    .filter((setup) => !setup.reject)
    .sort((a, b) => b.score - a.score)
    .filter((setup) => {
      const key = `${setup.pattern}_${setup.metadata.patternTf || ''}_${setup.ob.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16);
}

export function runHarmonicStrategy({ symbol, candles, price, cfg: inputConfig = {} }) {
  const cfg = normalizeHarmonicConfig(inputConfig);
  const setups = detectProjectedHarmonicSetups(candles, price, cfg).map((setup) => ({
    ...setup,
    symbol,
    metadata: { ...setup.metadata, patternTf: cfg.patternTf || null },
  }));
  return setups;
}

export { HARMONIC_FAMILIES, normalizeHarmonicConfig };
