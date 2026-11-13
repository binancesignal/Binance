/**
 * Harmonic pattern scanner for the Signals tab.
 *
 * - Projected: X–A–B–C complete → D zone projected → WAITING / ENTRY_READY
 * - Completed: full X–A–B–C–D already formed → FORMED
 * - Classic ratio sets (Carney-style) with per-pattern editable ranges
 * - Chart SVG: XABCD path, PRZ / D zone, labels
 */
import { findSwings, calcATR, calcEMASeries } from '../../indicators.js';
import { detectBreakers, findBreakersForDzone, BREAKER_DEFAULTS } from './breakerBlock.js';

export const HS_SCAN_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

/** Default Fib ratio windows per family (Scott Carney style + practical tolerance). */
export const DEFAULT_RATIO_RULES = {
  GARTLEY: {
    label: 'Gartley',
    xbMin: 0.55, xbMax: 0.68, // ideal 0.618
    bcMin: 0.382, bcMax: 0.886,
    xdMin: 0.75, xdMax: 0.82, // ideal 0.786 of XA
    target: 'xa', ratio: 0.786,
  },
  BAT: {
    label: 'Bat',
    xbMin: 0.35, xbMax: 0.55, // 0.382–0.50
    bcMin: 0.382, bcMax: 0.886,
    xdMin: 0.85, xdMax: 0.92, // 0.886
    target: 'xa', ratio: 0.886,
  },
  ALT_BAT: {
    label: 'Alternate Bat',
    xbMin: 0.33, xbMax: 0.45,
    bcMin: 0.382, bcMax: 0.886,
    xdMin: 1.08, xdMax: 1.18,
    target: 'xa', ratio: 1.13,
  },
  DEEP_BAT: {
    label: 'Deep Bat',
    xbMin: 0.82, xbMax: 0.95,
    bcMin: 0.382, bcMax: 0.886,
    xdMin: 0.85, xdMax: 0.92,
    target: 'xa', ratio: 0.886,
  },
  BUTTERFLY: {
    label: 'Butterfly',
    xbMin: 0.72, xbMax: 0.86, // 0.786
    bcMin: 0.382, bcMax: 0.886,
    xdMin: 1.20, xdMax: 1.50, // 1.27–1.414
    target: 'xa', ratio: 1.272,
  },
  CRAB: {
    label: 'Crab',
    xbMin: 0.35, xbMax: 0.65,
    bcMin: 0.382, bcMax: 0.886,
    xdMin: 1.50, xdMax: 1.72, // 1.618
    target: 'xa', ratio: 1.618,
  },
  DEEP_CRAB: {
    label: 'Deep Crab',
    xbMin: 0.82, xbMax: 0.95,
    bcMin: 0.382, bcMax: 0.886,
    xdMin: 1.50, xdMax: 1.72,
    target: 'xa', ratio: 1.618,
  },
  CYPHER: {
    label: 'Cypher',
    xbMin: 0.35, xbMax: 0.65,
    bcMin: 0, bcMax: 99, // uses XC instead
    xcMin: 1.13, xcMax: 1.414,
    xdMin: 0.75, xdMax: 0.82, // 0.786 of XC
    target: 'xc', ratio: 0.786,
  },
  SHARK: {
    label: 'Shark',
    xbMin: 0.35, xbMax: 0.65,
    bcMin: 0, bcMax: 99,
    xcMin: 1.13, xcMax: 1.70,
    xdMin: 0.85, xdMax: 1.15,
    target: 'xc', ratio: 0.886,
  },
  ABCD: {
    label: 'AB=CD',
    xbMin: 0.35, xbMax: 0.92, // AB retrace of XA loosely
    bcMin: 0.35, bcMax: 0.92,
    cdAbMin: 0.88, cdAbMax: 1.20, // CD ≈ AB
    target: 'ab', ratio: 1.0,
  },
};

export const FAMILY_KEYS = Object.keys(DEFAULT_RATIO_RULES);

export const HS_SCAN_DEFAULTS = {
  enabledFamilies: [...FAMILY_KEYS],
  ratioRules: { ...DEFAULT_RATIO_RULES },
  minScore: 55,
  maxPointAgeBars: 40,
  maxPatternSpanBars: 160,
  dZoneAtr: 0.18,
  readyDistanceAtr: 0.55,
  swingLeft: 3,
  swingRight: 3,
  swingLookback: 28,
  includeProjected: true,
  includeCompleted: true,
  // Prefer D zones that sit on / near EMA200 (confluence)
  preferEma200InDzone: false,
  requireEma200InDzone: false,
  emaPeriod: 200,
  // ATR pad: EMA may sit slightly above or below the PRZ mid and still count
  ema200PadAtr: 0.35,
  stopBufferAtr: 0.35,
  // Breaker Block Engine (AGPro-style)
  enableBreakers: true,
  preferBreakerInDzone: false,
  requireBreakerInDzone: false,
  breakerPadAtr: 0.25,
  breakerCfg: { ...BREAKER_DEFAULTS },
};

function deepCloneRules(rules) {
  const out = {};
  for (const [k, v] of Object.entries(rules || {})) {
    out[k] = { ...v };
  }
  return out;
}

export function normalizeHsScanConfig(raw = {}) {
  const d = HS_SCAN_DEFAULTS;
  const num = (v, fb, lo, hi) => {
    const n = +v;
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  };
  const enabled = Array.isArray(raw.enabledFamilies)
    ? raw.enabledFamilies.map((x) => String(x).toUpperCase()).filter((k) => FAMILY_KEYS.includes(k))
    : [...d.enabledFamilies];
  const ratioRules = deepCloneRules(DEFAULT_RATIO_RULES);
  if (raw.ratioRules && typeof raw.ratioRules === 'object') {
    for (const key of FAMILY_KEYS) {
      if (!raw.ratioRules[key]) continue;
      const src = raw.ratioRules[key];
      const dst = ratioRules[key];
      for (const field of Object.keys(dst)) {
        if (field === 'label' || field === 'target') {
          if (src[field] != null) dst[field] = src[field];
          continue;
        }
        if (src[field] != null && Number.isFinite(+src[field])) dst[field] = +src[field];
      }
    }
  }
  return {
    enabledFamilies: enabled.length ? enabled : [...d.enabledFamilies],
    ratioRules,
    minScore: num(raw.minScore, d.minScore, 30, 95),
    maxPointAgeBars: Math.round(num(raw.maxPointAgeBars, d.maxPointAgeBars, 5, 120)),
    maxPatternSpanBars: Math.round(num(raw.maxPatternSpanBars, d.maxPatternSpanBars, 20, 400)),
    dZoneAtr: num(raw.dZoneAtr, d.dZoneAtr, 0.05, 1),
    readyDistanceAtr: num(raw.readyDistanceAtr, d.readyDistanceAtr, 0.15, 3),
    swingLeft: Math.round(num(raw.swingLeft, d.swingLeft, 2, 8)),
    swingRight: Math.round(num(raw.swingRight, d.swingRight, 2, 8)),
    swingLookback: Math.round(num(raw.swingLookback, d.swingLookback, 10, 50)),
    includeProjected: raw.includeProjected !== false && raw.includeProjected !== 'false',
    includeCompleted: raw.includeCompleted !== false && raw.includeCompleted !== 'false',
    preferEma200InDzone: raw.preferEma200InDzone === true || raw.preferEma200InDzone === 'true',
    requireEma200InDzone: raw.requireEma200InDzone === true || raw.requireEma200InDzone === 'true',
    emaPeriod: Math.round(num(raw.emaPeriod, d.emaPeriod, 50, 300)),
    ema200PadAtr: num(raw.ema200PadAtr, d.ema200PadAtr, 0.05, 2),
    stopBufferAtr: num(raw.stopBufferAtr, d.stopBufferAtr, 0.1, 2),
    enableBreakers: raw.enableBreakers !== false && raw.enableBreakers !== 'false',
    preferBreakerInDzone: raw.preferBreakerInDzone === true || raw.preferBreakerInDzone === 'true',
    requireBreakerInDzone: raw.requireBreakerInDzone === true || raw.requireBreakerInDzone === 'true',
    breakerPadAtr: num(raw.breakerPadAtr, d.breakerPadAtr, 0.05, 1.5),
    breakerCfg: { ...BREAKER_DEFAULTS, ...(raw.breakerCfg && typeof raw.breakerCfg === 'object' ? raw.breakerCfg : {}) },
  };
}

const ratioOf = (a, b) => (Math.abs(b) > 1e-12 ? Math.abs(a) / Math.abs(b) : 0);
const inRange = (v, lo, hi) => v >= lo && v <= hi;

function directionOf4(points) {
  // X L, A H, B L, C H → bullish (D below C)
  if (points[0].type === 'L' && points[1].type === 'H' && points[2].type === 'L' && points[3].type === 'H') return 'LONG';
  if (points[0].type === 'H' && points[1].type === 'L' && points[2].type === 'H' && points[3].type === 'L') return 'SHORT';
  return null;
}

function directionOf5(points) {
  const d4 = directionOf4(points.slice(0, 4));
  if (!d4) return null;
  // D should continue alternating
  const need = points[3].type === 'H' ? 'L' : 'H';
  if (points[4].type !== need) return null;
  return d4;
}

function matchFamily(family, rule, ratios) {
  if (!rule) return false;
  if (family === 'ABCD') {
    return (
      inRange(ratios.xb, rule.xbMin, rule.xbMax) &&
      inRange(ratios.bc, rule.bcMin, rule.bcMax) &&
      (ratios.cdAb == null || inRange(ratios.cdAb, rule.cdAbMin ?? 0.88, rule.cdAbMax ?? 1.2))
    );
  }
  if (rule.target === 'xc') {
    return (
      inRange(ratios.xb, rule.xbMin, rule.xbMax) &&
      inRange(ratios.xc, rule.xcMin, rule.xcMax) &&
      (ratios.xd == null || inRange(ratios.xd, rule.xdMin, rule.xdMax))
    );
  }
  return (
    inRange(ratios.xb, rule.xbMin, rule.xbMax) &&
    inRange(ratios.bc, rule.bcMin, rule.bcMax) &&
    (ratios.xd == null || inRange(ratios.xd, rule.xdMin, rule.xdMax))
  );
}

function scoreFit(family, rule, ratios) {
  let s = 60;
  const mid = (a, b) => (a + b) / 2;
  const pen = (v, lo, hi) => {
    if (v == null) return 0;
    const m = mid(lo, hi);
    const half = (hi - lo) / 2 || 0.01;
    return Math.max(0, 1 - Math.abs(v - m) / half);
  };
  if (family === 'ABCD') {
    s += 15 * pen(ratios.cdAb ?? 1, rule.cdAbMin ?? 0.88, rule.cdAbMax ?? 1.2);
    s += 10 * pen(ratios.bc, rule.bcMin, rule.bcMax);
  } else if (rule.target === 'xc') {
    s += 12 * pen(ratios.xc, rule.xcMin, rule.xcMax);
    s += 12 * pen(ratios.xd ?? rule.ratio, rule.xdMin, rule.xdMax);
  } else {
    s += 10 * pen(ratios.xb, rule.xbMin, rule.xbMax);
    s += 8 * pen(ratios.bc, rule.bcMin, rule.bcMax);
    s += 12 * pen(ratios.xd ?? rule.ratio, rule.xdMin, rule.xdMax);
  }
  return Math.min(95, Math.round(s));
}

function projectDPrice(family, rule, X, A, B, C, direction) {
  const dir = direction === 'LONG' ? 1 : -1;
  const xa = Math.abs(A.price - X.price);
  if (!(xa > 0)) return null;
  if (family === 'ABCD') {
    const ab = Math.abs(B.price - A.price);
    return C.price - dir * ab * (rule.ratio || 1);
  }
  if (rule.target === 'xc') {
    const xc = Math.abs(C.price - X.price);
    return C.price - dir * (rule.ratio || 0.786) * xc;
  }
  return A.price - dir * (rule.ratio || 0.786) * xa;
}

function ratiosXABC(X, A, B, C) {
  return {
    xb: ratioOf(B.price - A.price, A.price - X.price),
    bc: ratioOf(C.price - B.price, B.price - A.price),
    xc: ratioOf(C.price - X.price, A.price - X.price),
  };
}

function ratiosXABCD(X, A, B, C, D) {
  const r = ratiosXABC(X, A, B, C);
  r.xd = ratioOf(D.price - A.price, A.price - X.price);
  r.cdAb = ratioOf(D.price - C.price, B.price - A.price);
  r.xcFromD = ratioOf(D.price - C.price, C.price - X.price);
  return r;
}


/**
 * After A is fixed, the swing extreme at A must hold until D (or until now for projected).
 * LONG  (A = swing high): any later high strictly above A → structure broken.
 * SHORT (A = swing low):  any later low strictly below A → structure broken.
 * Optional small ATR buffer so wicks barely beyond A don't nuke every setup.
 */
function structureBrokenAfterA(candles, A, direction, untilIndex, atr = 0, bufferAtr = 0.05) {
  if (!A || A.i == null || !candles?.length) return false;
  const buf = (atr || 0) * bufferAtr;
  const end = Math.min(candles.length - 1, untilIndex ?? candles.length - 1);
  for (let i = A.i + 1; i <= end; i++) {
    if (direction === 'LONG') {
      // A is high — new higher high invalidates
      if (+candles[i].high > A.price + buf) return true;
    } else {
      // A is low — new lower low invalidates
      if (+candles[i].low < A.price - buf) return true;
    }
  }
  return false;
}

/** Also: after C, for projected D, X must still be the binding extreme on the D side for some families — keep simple: only A rule as user requested. */

function zoneTouched(candles, fromIndex, lo, hi) {
  for (let i = Math.max(0, fromIndex); i < candles.length; i++) {
    if (+candles[i].low <= hi && +candles[i].high >= lo) return true;
  }
  return false;
}

function classifyProjected(price, entry, zone, readyDist, direction) {
  const dist = Math.abs(price - entry);
  if (direction === 'LONG') {
    if (price <= entry + zone) return 'ENTRY_READY';
    if (dist <= readyDist) return 'ENTRY_READY';
    return 'WAITING';
  }
  if (price >= entry - zone) return 'ENTRY_READY';
  if (dist <= readyDist) return 'ENTRY_READY';
  return 'WAITING';
}

/**
 * Harmonic trade plan: SL beyond D, TP1=0.382 CD leg, TP2=0.618 CD, TP3=A, TP4=X (or measured).
 */
function buildPlan(direction, X, A, B, C, entry, atr, cfg) {
  const sign = direction === 'LONG' ? 1 : -1;
  const risk = Math.max(atr * (cfg.stopBufferAtr || 0.35), Math.abs(C.price - entry) * 0.08, Math.abs(entry) * 0.001);
  const sl = entry - sign * risk;
  const cd = Math.abs(C.price - entry) || atr;
  const xa = Math.abs(A.price - X.price) || atr;
  const tp1 = entry + sign * Math.max(cd * 0.382, risk * 1.0);
  const tp2 = entry + sign * Math.max(cd * 0.618, risk * 1.5);
  // TP3 toward A, TP4 toward X / full XA
  const tp3 = direction === 'LONG' ? Math.max(A.price, entry + sign * risk * 2.2) : Math.min(A.price, entry + sign * risk * 2.2);
  const tp4 = direction === 'LONG' ? Math.max(X.price, entry + sign * xa * 0.886) : Math.min(X.price, entry + sign * xa * 0.886);
  const rr1 = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  const rr2 = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
  const rr3 = risk > 0 ? Math.abs(tp3 - entry) / risk : 0;
  return {
    entry,
    sl,
    tp1,
    tp2,
    tp3,
    tp4,
    risk,
    rr1: +rr1.toFixed(2),
    rr2: +rr2.toFixed(2),
    rr3: +rr3.toFixed(2),
  };
}

/** EMA200 intersects D-zone (with optional ATR pad above/below). */
function ema200InDzone(emaVal, przLow, przHigh, atr, padAtr) {
  if (emaVal == null || !Number.isFinite(emaVal)) return false;
  const pad = (atr || 0) * (padAtr ?? 0.35);
  return emaVal >= przLow - pad && emaVal <= przHigh + pad;
}

/**
 * SkChart annotations: XABCD poly, markers, D zone with prices, SL/TP lines, EMA200.
 */
export function buildHarmonicAnnotations(ev, candles, opts = {}) {
  const tf = opts.tf || '';
  const lastT = candles?.[candles.length - 1]?.time ?? ev.C?.time;
  const tEnd = lastT != null ? lastT + 40 * 60 : (ev.C?.time || 0) + 3600;
  const anns = [];
  const pts = [
    { label: 'X', ...ev.X },
    { label: 'A', ...ev.A },
    { label: 'B', ...ev.B },
    { label: 'C', ...ev.C },
  ];
  if (ev.D?.i != null && ev.D.time != null) {
    pts.push({ label: 'D', ...ev.D });
  }
  // structure poly
  anns.push({
    group: 'abcd',
    kind: 'poly',
    tf,
    points: pts.filter((p) => p.time != null).map((p) => ({ t: p.time, p: p.price })),
    label: ev.label || ev.family,
  });
  for (const p of pts) {
    if (p.time == null) continue;
    anns.push({
      group: 'abcd',
      kind: 'marker',
      tf,
      t: p.time,
      p: p.price,
      shape: ev.direction === 'LONG' ? 'up' : 'down',
      label: `${p.label} ${Number(p.price).toPrecision(6)}`,
      bold: true,
    });
  }
  // projected D marker at entry price (no time) — use C time + offset via hline label
  if (ev.kind === 'PROJECTED' && ev.entry != null) {
    anns.push({
      group: 'entry',
      kind: 'hline',
      tf,
      t1: ev.C.time,
      t2: tEnd,
      p1: ev.entry,
      label: `D ${Number(ev.entry).toPrecision(6)}`,
      tone: 'tp',
    });
  }
  // D zone with price labels
  if (ev.przLow != null && ev.przHigh != null) {
    anns.push({
      group: 'czone',
      kind: 'zone',
      tf,
      t1: ev.C.time,
      t2: tEnd,
      p1: ev.przHigh,
      p2: ev.przLow,
      label: `D zone ${Number(ev.przLow).toPrecision(6)} – ${Number(ev.przHigh).toPrecision(6)}`,
    });
  }
  const plan = ev.plan;
  if (plan) {
    const t1 = ev.C?.time || lastT;
    anns.push({ group: 'entry', kind: 'hline', tf, t1, t2: tEnd, p1: plan.entry, label: `Entry ${Number(plan.entry).toPrecision(6)}`, tone: 'tp' });
    anns.push({ group: 'entry', kind: 'hline', tf, t1, t2: tEnd, p1: plan.sl, label: `SL ${Number(plan.sl).toPrecision(6)}`, tone: 'sl', style: 'dashed' });
    anns.push({ group: 'targets', kind: 'hline', tf, t1, t2: tEnd, p1: plan.tp1, label: `TP1 ${Number(plan.tp1).toPrecision(6)} · R:R ${plan.rr1}`, tone: 'tp' });
    anns.push({ group: 'targets', kind: 'hline', tf, t1, t2: tEnd, p1: plan.tp2, label: `TP2 ${Number(plan.tp2).toPrecision(6)} · R:R ${plan.rr2}`, tone: 'tp' });
    anns.push({ group: 'targets', kind: 'hline', tf, t1, t2: tEnd, p1: plan.tp3, label: `TP3 ${Number(plan.tp3).toPrecision(6)}`, tone: 'tp', style: 'dashed' });
    if (plan.tp4 != null) {
      anns.push({ group: 'targets', kind: 'hline', tf, t1, t2: tEnd, p1: plan.tp4, label: `TP4 ${Number(plan.tp4).toPrecision(6)}`, tone: 'tp', style: 'dotted' });
    }
  }
  // EMA200 as annotation if we have a sample value at C/D
  if (ev.ema200 != null) {
    anns.push({
      group: 'trend',
      kind: 'hline',
      tf,
      t1: ev.X?.time || ev.C?.time,
      t2: tEnd,
      p1: ev.ema200,
      label: `EMA200 ${Number(ev.ema200).toPrecision(6)}${ev.ema200InDzone ? ' · in D zone' : ''}`,
      style: 'dashed',
    });
  }
  // Breaker blocks (bull / bear zones)
  const brList = [...(ev.breakers || []), ...((ev.allBreakers || []).filter((b) => !(ev.breakers || []).some((m) => m.id === b.id)))].slice(0, 6);
  for (const br of brList) {
    const colSide = br.isBull ? 'bull' : 'bear';
    const t1 = br.obTime || br.bornTime || ev.C?.time;
    anns.push({
      group: 'breaker',
      kind: 'zone',
      tf,
      t1,
      t2: tEnd,
      p1: br.top,
      p2: br.bot,
      label: `${br.side} BREAKER Q${Math.round(br.quality)} · ${br.action || br.state || ''}${ev.breakerInDzone && (ev.breakers || []).some((m) => m.id === br.id) ? ' · in D' : ''}`,
      side: colSide,
    });
    if (br.invalidLevel != null) {
      anns.push({
        group: 'breaker',
        kind: 'hline',
        tf,
        t1,
        t2: tEnd,
        p1: br.invalidLevel,
        label: `BB inv ${Number(br.invalidLevel).toPrecision(6)}`,
        style: 'dashed',
      });
    }
  }
  return anns;
}

/**
 * Find projected (XABC→D) and completed (XABCD) harmonic events.
 */
export function findHarmonicEvents(candles, cfgIn = {}) {
  const cfg = normalizeHsScanConfig(cfgIn);
  if (!candles || candles.length < 50) return [];

  const closed = candles;
  const atr = calcATR(closed, 14) || closed[closed.length - 1].close * 0.01;
  const emaSeries = calcEMASeries(closed, cfg.emaPeriod || 200);
  const breakers = cfg.enableBreakers ? detectBreakers(closed, cfg.breakerCfg || {}) : [];
  const swings = findSwings(closed, cfg.swingLeft, cfg.swingRight).slice(-cfg.swingLookback);
  if (swings.length < 4) return [];

  const lastIdx = closed.length - 1;
  const price = +closed[lastIdx].close;
  const events = [];
  const enabled = new Set(cfg.enabledFamilies);

  // ── Projected: 4 swings XABC ──────────────────────────────────────
  if (cfg.includeProjected) {
    for (let i = 0; i + 3 < swings.length; i++) {
      const pts = swings.slice(i, i + 4);
      if (pts.some((p, k) => k > 0 && p.type === pts[k - 1].type)) continue;
      const direction = directionOf4(pts);
      if (!direction) continue;
      const [X, A, B, C] = pts;
      if (lastIdx - C.i > cfg.maxPointAgeBars) continue;
      if (C.i - X.i > cfg.maxPatternSpanBars) continue;

      const baseRatios = ratiosXABC(X, A, B, C);

      // A must remain the extreme — new low (SHORT) / new high (LONG) after A = invalid
      if (structureBrokenAfterA(closed, A, direction, lastIdx, atr, 0.05)) continue;

      for (const family of cfg.enabledFamilies) {
        if (!enabled.has(family)) continue;
        const rule = cfg.ratioRules[family];
        if (!rule) continue;

        // For projected, check XB/BC/(XC) only — XD is the projection target
        const ratiosForMatch = { ...baseRatios };
        if (family === 'ABCD') {
          if (!inRange(baseRatios.xb, rule.xbMin, rule.xbMax) || !inRange(baseRatios.bc, rule.bcMin, rule.bcMax)) continue;
        } else if (rule.target === 'xc') {
          if (!inRange(baseRatios.xb, rule.xbMin, rule.xbMax) || !inRange(baseRatios.xc, rule.xcMin, rule.xcMax)) continue;
        } else {
          if (!inRange(baseRatios.xb, rule.xbMin, rule.xbMax) || !inRange(baseRatios.bc, rule.bcMin, rule.bcMax)) continue;
        }

        const entry = projectDPrice(family, rule, X, A, B, C, direction);
        if (!(entry > 0)) continue;
        if (Math.abs(entry - C.price) < atr * 0.12) continue;

        const zone = Math.max(atr * cfg.dZoneAtr, Math.abs(entry) * 0.00025);
        const przLow = entry - zone;
        const przHigh = entry + zone;

        // If price already traded through the PRZ, this projected setup is stale → skip
        if (zoneTouched(closed, C.i + 1, przLow, przHigh)) continue;

        const readyDist = atr * cfg.readyDistanceAtr;
        // Still approaching from the correct side?
        if (direction === 'LONG' && price < przLow - readyDist * 0.5) continue; // already far through
        if (direction === 'SHORT' && price > przHigh + readyDist * 0.5) continue;

        const status = classifyProjected(price, entry, zone, readyDist, direction);
        const ratios = { ...baseRatios, xd: rule.ratio, projected: true };
        let score = scoreFit(family, rule, ratios);
        if (score < cfg.minScore) continue;

        const emaAt = emaSeries[C.i] ?? emaSeries[lastIdx];
        const emaOk = ema200InDzone(emaAt, przLow, przHigh, atr, cfg.ema200PadAtr);
        if (cfg.requireEma200InDzone && !emaOk) continue;
        if (cfg.preferEma200InDzone && emaOk) score = Math.min(95, score + 8);

        const matchedBreakers = findBreakersForDzone(breakers, przLow, przHigh, direction, atr, cfg.breakerPadAtr);
        if (cfg.requireBreakerInDzone && !matchedBreakers.length) continue;
        if (cfg.preferBreakerInDzone && matchedBreakers.length) score = Math.min(95, score + 10);

        const plan = buildPlan(direction, X, A, B, C, entry, atr, cfg);
        events.push({
          kind: 'PROJECTED',
          status,
          family,
          label: rule.label || family,
          direction,
          score,
          time: C.time,
          index: C.i,
          X: { i: X.i, price: X.price, time: closed[X.i].time },
          A: { i: A.i, price: A.price, time: closed[A.i].time },
          B: { i: B.i, price: B.price, time: closed[B.i].time },
          C: { i: C.i, price: C.price, time: closed[C.i].time },
          D: { i: null, price: entry, time: null },
          entry,
          przLow,
          przHigh,
          ratios,
          price,
          plan,
          ema200: emaAt,
          ema200InDzone: emaOk,
          breakers: matchedBreakers,
          breakerInDzone: matchedBreakers.length > 0,
          allBreakers: breakers.filter((b) => b.alive).slice(0, 8),
        });
      }
    }
  }

  // ── Completed: 5 swings XABCD ─────────────────────────────────────
  if (cfg.includeCompleted) {
    for (let i = 0; i + 4 < swings.length; i++) {
      const pts = swings.slice(i, i + 5);
      if (pts.some((p, k) => k > 0 && p.type === pts[k - 1].type)) continue;
      const direction = directionOf5(pts);
      if (!direction) continue;
      const [X, A, B, C, D] = pts;
      if (lastIdx - D.i > cfg.maxPointAgeBars * 2) continue;
      if (D.i - X.i > cfg.maxPatternSpanBars) continue;

      // Invalidate if price broke beyond A between A and D (structure failed)
      if (structureBrokenAfterA(closed, A, direction, D.i, atr, 0.05)) continue;

      const ratios = ratiosXABCD(X, A, B, C, D);

      for (const family of cfg.enabledFamilies) {
        if (!enabled.has(family)) continue;
        const rule = cfg.ratioRules[family];
        if (!rule) continue;

        // For XC-target families, map xd from CD/XC
        const check = { ...ratios };
        if (rule.target === 'xc') {
          check.xd = ratioOf(D.price - C.price, C.price - X.price);
        }

        if (!matchFamily(family, rule, check)) continue;
        const score = scoreFit(family, rule, check);
        if (score < cfg.minScore) continue;

        const zone = Math.max(atr * cfg.dZoneAtr, Math.abs(D.price) * 0.00025);
        const przLow = D.price - zone;
        const przHigh = D.price + zone;
        const emaAt = emaSeries[D.i] ?? emaSeries[C.i];
        const emaOk = ema200InDzone(emaAt, przLow, przHigh, atr, cfg.ema200PadAtr);
        if (cfg.requireEma200InDzone && !emaOk) continue;
        let finalScore = score;
        if (cfg.preferEma200InDzone && emaOk) finalScore = Math.min(95, score + 8);

        const matchedBreakers = findBreakersForDzone(breakers, przLow, przHigh, direction, atr, cfg.breakerPadAtr);
        if (cfg.requireBreakerInDzone && !matchedBreakers.length) continue;
        if (cfg.preferBreakerInDzone && matchedBreakers.length) finalScore = Math.min(95, finalScore + 10);

        const plan = buildPlan(direction, X, A, B, C, D.price, atr, cfg);
        events.push({
          kind: 'COMPLETED',
          status: 'FORMED',
          family,
          label: rule.label || family,
          direction,
          score: finalScore,
          time: D.time,
          index: D.i,
          X: { i: X.i, price: X.price, time: closed[X.i].time },
          A: { i: A.i, price: A.price, time: closed[A.i].time },
          B: { i: B.i, price: B.price, time: closed[B.i].time },
          C: { i: C.i, price: C.price, time: closed[C.i].time },
          D: { i: D.i, price: D.price, time: closed[D.i].time },
          entry: D.price,
          przLow,
          przHigh,
          ratios: check,
          price,
          plan,
          ema200: emaAt,
          ema200InDzone: emaOk,
          breakers: matchedBreakers,
          breakerInDzone: matchedBreakers.length > 0,
          allBreakers: breakers.filter((b) => b.alive).slice(0, 8),
        });
      }
    }
  }

  // Deduplicate: same family+direction+near-C time keep highest score
  events.sort((a, b) => b.score - a.score || b.time - a.time);
  const kept = [];
  for (const e of events) {
    const dup = kept.some(
      (k) =>
        k.family === e.family &&
        k.direction === e.direction &&
        k.kind === e.kind &&
        Math.abs((k.C?.i || 0) - (e.C?.i || 0)) < 4
    );
    if (!dup) kept.push(e);
  }
  return kept.sort((a, b) => b.time - a.time);
}

// ───────────────────────────── chart SVG ─────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(t, tzMin) {
  const d = new Date((t + tzMin * 60) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6;
  return p.toFixed(dp);
}

export function buildHarmonicChartSvg(candles, ev, opts = {}) {
  const { symbol = '', tf = '', before = 30, after = 25, tzMin = 0, width = 900, height = 520 } = opts;
  const startI = Math.min(ev.X.i, ev.A.i);
  const endI = ev.D?.i != null ? ev.D.i : Math.min(candles.length - 1, (ev.C?.i || startI) + 20);
  const from = Math.max(0, startI - before);
  const to = Math.min(candles.length - 1, endI + after);
  const vis = candles.slice(from, to + 1);
  if (vis.length < 8) return null;

  const L = 10;
  const R = 78;
  const T = 50;
  const B = 36;
  const pw = width - L - R;
  const ph = height - T - B;
  const step = pw / vis.length;
  const bw = Math.max(1, Math.min(10, step * 0.65));

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of vis) {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  lo = Math.min(lo, ev.przLow ?? ev.entry, ev.X.price, ev.A.price, ev.B.price, ev.C.price, ev.D?.price ?? ev.entry);
  hi = Math.max(hi, ev.przHigh ?? ev.entry, ev.X.price, ev.A.price, ev.B.price, ev.C.price, ev.D?.price ?? ev.entry);
  if (ev.plan) {
    for (const k of ['sl', 'tp1', 'tp2', 'tp3', 'tp4', 'entry']) {
      if (ev.plan[k] != null) { lo = Math.min(lo, ev.plan[k]); hi = Math.max(hi, ev.plan[k]); }
    }
  }
  if (ev.ema200 != null) { lo = Math.min(lo, ev.ema200); hi = Math.max(hi, ev.ema200); }
  for (const br of [...(ev.breakers || []), ...(ev.allBreakers || [])].slice(0, 6)) {
    lo = Math.min(lo, br.bot, br.top);
    hi = Math.max(hi, br.bot, br.top);
  }
  const padP = (hi - lo) * 0.08 || hi * 0.01;
  lo -= padP;
  hi += padP;
  const y = (p) => T + ph - ((p - lo) / (hi - lo)) * ph;
  const x = (k) => L + step * k + step / 2;

  const dirColor = ev.direction === 'LONG' ? '#0ecb81' : '#f6465d';
  const zoneColor = '#7c3aed';
  const g = [];
  g.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,Helvetica,sans-serif">`);
  g.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

  for (let n = 0; n <= 6; n++) {
    const p = lo + ((hi - lo) * n) / 6;
    const yy = y(p).toFixed(1);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy}" y2="${yy}" stroke="#eceff3"/>`);
    g.push(`<text x="${L + pw + 6}" y="${(+yy + 4).toFixed(1)}" font-size="11" fill="#555">${fmtPrice(p)}</text>`);
  }

  const labelEvery = Math.max(1, Math.round(vis.length / 6));
  for (let k = 0; k < vis.length; k += labelEvery) {
    g.push(`<text x="${x(k).toFixed(1)}" y="${height - 12}" font-size="10" fill="#666" text-anchor="middle">${fmtTime(vis[k].time, tzMin).slice(5)}</text>`);
  }

  // D-zone / PRZ band with prices
  if (ev.przLow != null && ev.przHigh != null) {
    const yTop = y(ev.przHigh);
    const yBot = y(ev.przLow);
    const zoneFrom = Math.max(from, ev.C.i);
    const zoneTo = to;
    const x1 = x(zoneFrom - from);
    const x2 = x(zoneTo - from);
    g.push(
      `<rect x="${x1.toFixed(1)}" y="${Math.min(yTop, yBot).toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${Math.abs(yBot - yTop).toFixed(1)}" fill="${zoneColor}" opacity="0.14"/>`
    );
    g.push(
      `<line x1="${x1.toFixed(1)}" x2="${x2.toFixed(1)}" y1="${y(ev.entry).toFixed(1)}" y2="${y(ev.entry).toFixed(1)}" stroke="${zoneColor}" stroke-width="1.5" stroke-dasharray="5 3"/>`
    );
    g.push(`<text x="${(x1 + 4).toFixed(1)}" y="${(Math.min(yTop, yBot) - 4).toFixed(1)}" font-size="10" fill="${zoneColor}" font-weight="600">D zone ${fmtPrice(ev.przLow)} – ${fmtPrice(ev.przHigh)}</text>`);
    g.push(`<text x="${(x1 + 4).toFixed(1)}" y="${(y(ev.entry) - 4).toFixed(1)}" font-size="10" fill="${zoneColor}">D ${fmtPrice(ev.entry)}</text>`);
  }

  // EMA200 line
  if (opts.emaSeries) {
    let d = '';
    for (let k = 0; k < vis.length; k++) {
      const v = opts.emaSeries[from + k];
      if (v == null) continue;
      d += (d ? ' L ' : 'M ') + `${x(k).toFixed(1)} ${y(v).toFixed(1)}`;
    }
    if (d) g.push(`<path d="${d}" fill="none" stroke="#2962ff" stroke-width="1.8"/>`);
  } else if (ev.ema200 != null) {
    const ey = y(ev.ema200);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${ey.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#2962ff" stroke-width="1.4" stroke-dasharray="6 4"/>`);
    g.push(`<text x="${L + 4}" y="${(ey - 4).toFixed(1)}" font-size="10" fill="#2962ff">EMA200 ${fmtPrice(ev.ema200)}${ev.ema200InDzone ? ' · in D zone' : ''}</text>`);
  }

  // Plan SL / TPs
  if (ev.plan) {
    const levels = [
      [ev.plan.sl, '#EF4444', 'SL'],
      [ev.plan.tp1, '#10B981', 'TP1'],
      [ev.plan.tp2, '#10B981', 'TP2'],
      [ev.plan.tp3, '#059669', 'TP3'],
      [ev.plan.tp4, '#047857', 'TP4'],
    ];
    for (const [price, col, lab] of levels) {
      if (price == null || !Number.isFinite(price)) continue;
      const yy = y(price);
      g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="1.1" stroke-dasharray="4 3" opacity="0.85"/>`);
      g.push(`<text x="${L + pw - 4}" y="${(yy - 3).toFixed(1)}" font-size="10" fill="${col}" text-anchor="end">${lab} ${fmtPrice(price)}</text>`);
    }
  }

  // Breaker block zones
  {
    const brList = [...(ev.breakers || []), ...((ev.allBreakers || []).filter((b) => !(ev.breakers || []).some((m) => m.id === b.id)))].slice(0, 5);
    for (const br of brList) {
      const col = br.isBull ? '#22c5a6' : '#f472b6';
      const inD = (ev.breakers || []).some((m) => m.id === br.id);
      const yTop = y(br.top);
      const yBot = y(br.bot);
      const bi = Math.max(from, br.obBar ?? br.bornBar ?? from);
      const x1 = x(bi - from);
      const x2 = L + pw;
      g.push(`<rect x="${x1.toFixed(1)}" y="${Math.min(yTop, yBot).toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${Math.max(1, Math.abs(yBot - yTop)).toFixed(1)}" fill="${col}" opacity="${inD ? 0.22 : 0.1}" stroke="${col}" stroke-width="1"/>`);
      g.push(`<text x="${(x1 + 4).toFixed(1)}" y="${(Math.min(yTop, yBot) + 12).toFixed(1)}" font-size="10" font-weight="700" fill="${col}">${br.side} BB ${fmtPrice(br.bot)}–${fmtPrice(br.top)}${inD ? ' · D' : ''}</text>`);
    }
  }

  // candles
  for (let k = 0; k < vis.length; k++) {
    const c = vis[k];
    const col = c.close >= c.open ? '#089981' : '#f23645';
    const cx = x(k).toFixed(1);
    g.push(`<line x1="${cx}" x2="${cx}" y1="${y(c.high).toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}"/>`);
    const top = y(Math.max(c.open, c.close));
    const hgt = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    g.push(`<rect x="${(x(k) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"/>`);
  }

  // XABCD path
  const anchors = [
    { ...ev.X, label: 'X' },
    { ...ev.A, label: 'A' },
    { ...ev.B, label: 'B' },
    { ...ev.C, label: 'C' },
  ];
  if (ev.D?.i != null) {
    anchors.push({ ...ev.D, label: 'D' });
  } else if (ev.D?.price != null) {
    // projected D at current right edge of zone
    anchors.push({ i: Math.min(to, ev.C.i + Math.max(5, Math.round((ev.C.i - ev.X.i) * 0.35))), price: ev.D.price, label: 'D′' });
  }

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (a.i == null || b.i == null) continue;
    if (a.i < from || b.i > to) continue;
    g.push(
      `<line x1="${x(a.i - from).toFixed(1)}" y1="${y(a.price).toFixed(1)}" x2="${x(b.i - from).toFixed(1)}" y2="${y(b.price).toFixed(1)}" stroke="${dirColor}" stroke-width="1.8"/>`
    );
  }

  for (const m of anchors) {
    if (m.i == null || m.i < from || m.i > to) continue;
    const cx = x(m.i - from);
    const cy = y(m.price);
    g.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="${dirColor}" stroke="#fff" stroke-width="1.4"/>`);
    g.push(`<text x="${cx.toFixed(1)}" y="${(cy - 11).toFixed(1)}" font-size="11" font-weight="700" fill="${dirColor}" text-anchor="middle">${m.label} ${fmtPrice(m.price)}</text>`);
  }

  const statusTag = ev.status || ev.kind;
  const title = `${symbol} · ${tf} · ${ev.label || ev.family} · ${ev.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'} · ${statusTag}`;
  g.push(`<text x="${L}" y="18" font-size="14" font-weight="700" fill="${dirColor}">${title}</text>`);
  const r = ev.ratios || {};
  const ratioTxt = `XB ${r.xb?.toFixed?.(3) ?? '—'} · BC ${r.bc?.toFixed?.(3) ?? '—'} · XD ${r.xd?.toFixed?.(3) ?? '—'} · score ${ev.score}`;
  g.push(`<text x="${L}" y="36" font-size="11" fill="#444">${ratioTxt} · entry ${fmtPrice(ev.entry)}</text>`);
  g.push('</svg>');
  return g.join('');
}
