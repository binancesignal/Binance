/**
 * FIB BREAKER 1:4 — analysis engine (paper / analysis only).
 * Reads CLOSED candles only. LONG runs on the real candles, SHORT on the price-mirrored candles, so both directions use
 * the same code. The scanner list, the chart annotations and the diagnostics all come from this one result.
 */
import { mirrorCandles, findPivots, alternatePivots, findBullishChoch } from '../skSystem/structure.js';
import { closedCandles, atrOf } from '../poiSystem/structure.js';
import { POI_TF_SEC } from '../poiSystem/config.js';
import { FB_STRATEGY, FB_STRATEGY_NAME } from './config.js';

const r8 = (n) => +(+n).toFixed(8);
const U = (tf) => String(tf).toUpperCase();
const LIMIT = 600;

export const fbId = (symbol, dir, tf, time) => `fb_${String(symbol).toUpperCase()}_${dir}_${tf}_${time}`;

/** @returns {{symbol, nowSec, results: {tf, dir, analysis|null, reason, steps}[]}} */
export async function analyzeFibBreaker(o) {
  const { symbol, cfg } = o;
  const nowSec = Number.isFinite(+o.nowSec) ? +o.nowSec : Math.floor(Date.now() / 1000);
  const tfs = (o.tfs && o.tfs.length ? o.tfs : cfg.tfs).filter((t) => POI_TF_SEC[t]);
  const results = [];
  for (const tf of tfs) {
    let candles;
    try {
      candles = closedCandles(await o.getCandles(tf, LIMIT), tf, nowSec);
    } catch (e) {
      if (e && typeof e === 'object') e.fetchFailed = true; // a data failure is a FAILED scan, never a silent "no setup"
      throw e;
    }
    for (const dir of o.dirs || ['LONG', 'SHORT']) {
      if (candles.length < 60) {
        results.push({ tf, dir, analysis: null, reason: `${U(tf)}: not enough closed candles (${candles.length}/60)`, steps: [] });
        continue;
      }
      try {
        // newest setup first, then older ones (each must end before the previous one's down-leg began)
        let cutoff = Infinity;
        for (let k = 0; k < (cfg.historyDepth || 1); k++) {
          const r = analyzeOne({ symbol, tf, dir, candles, cfg, nowSec, cutoff, latest: k === 0 });
          if (!r.analysis) {
            if (k === 0) results.push({ tf, dir, ...r });
            break;
          }
          results.push({ tf, dir, ...r });
          cutoff = r.analysis.anchor.h2Index;
        }
      } catch (e) {
        results.push({ tf, dir, analysis: null, reason: `error: ${e.message}`, steps: [] });
      }
    }
  }
  return { symbol, nowSec, results };
}

function analyzeOne({ symbol, tf, dir, candles, cfg, nowSec, cutoff = Infinity, latest = true }) {
  const sign = dir === 'LONG' ? 1 : -1;
  const px = (p) => r8(sign * p);
  const cs = sign === 1 ? candles : mirrorCandles(candles);
  const n = cs.length;
  const sec = POI_TF_SEC[tf];
  const atr = atrOf(cs);
  const price = cs[n - 1].close;
  // names in the chart follow the REAL direction
  const NAME = sign === 1 ? { A: 'LL', H2: 'LH', brk: 'LH Breakout', NH: 'New High', HL: 'HL', HH: 'HH' } : { A: 'HH', H2: 'HL', brk: 'HL Breakout', NH: 'New Low', HL: 'LH', HH: 'LL' };
  const steps = [];
  const step = (id, label, done, detail) => steps.push({ id, label, status: done === true ? 'DONE' : done === false ? 'PENDING' : 'WAITING', detail });

  const alt = alternatePivots(findPivots(cs, cfg.swingBars, cfg.swingBars));
  // older setups: the breakout search is limited to pivots before the newer setup's LH; the chain after it still uses every pivot
  const chochAlt = cutoff < Infinity ? alt.filter((p) => p.i < cutoff) : alt;
  const ch = findBullishChoch(cs, chochAlt, { maxAgeBars: latest ? cfg.maxAgeBars : n, pick: 'latest', holdCheck: latest });
  if (!ch) {
    if (!latest) return { analysis: null, reason: 'no older setup', steps };
    step('trend', `${sign === 1 ? 'Down' : 'Up'}-trend (${NAME.H2} + ${NAME.A})`, false, 'no lower-high / lower-low sequence with a breakout inside the look-back');
    return { analysis: null, reason: `no ${NAME.brk} (structure shift) after a ${NAME.A} in the last ${cfg.maxAgeBars} bars`, steps };
  }
  const { A, H2 } = ch;
  step('trend', `${sign === 1 ? 'Down' : 'Up'}-trend (${NAME.H2} + ${NAME.A})`, true, `${NAME.A} ${px(A.price)}`);
  step('choch', NAME.brk, true, `closed beyond ${px(H2.price)}`);

  // chain after the breakout: New High → HL → HH (BOS)
  const after = alt.filter((p) => p.i > A.i);
  const NH = after.find((p) => p.type === 'high' && p.price > H2.price) || null;
  step('nh', NAME.NH, !!NH, NH ? `${px(NH.price)}` : 'the first rally after the breakout is still forming');
  const HL = NH ? after.find((p) => p.type === 'low' && p.i > NH.i && p.price > A.price) || null : null;
  step('hl', `${NAME.HL} (higher low above ${NAME.A})`, !!HL, HL ? `${px(HL.price)}` : NH ? 'pull-back from the New High is still forming' : '—');
  let HH = null;
  let bosIdx = -1;
  if (HL) {
    // HH = the FIRST top after the HL that closed above the New High …
    const highs = after.filter((p) => p.type === 'high' && p.i > HL.i && p.price > NH.price);
    for (const h of highs) {
      for (let j = HL.i + 1; j <= h.i; j++) if (cs[j].close > NH.price) { bosIdx = j; break; }
      if (bosIdx >= 0) { HH = h; break; }
    }
    // … moved up to a higher top only while the pull-backs in between never reached the entry band (the impulse is still running)
    while (HH) {
      const nextLow = after.find((p) => p.type === 'low' && p.i > HH.i);
      const nextHigh = nextLow ? after.find((p) => p.type === 'high' && p.i > nextLow.i) : null;
      if (!nextHigh || nextHigh.price <= HH.price) break;
      const bandTop = HH.price - cfg.entryFibFrom * (HH.price - HL.price);
      if (nextLow.price <= bandTop || nextLow.price < HL.price) break;
      HH = nextHigh;
    }
  }
  step('hh', `${NAME.HH} (break of the ${NAME.NH})`, !!HH, HH ? `${px(HH.price)}` : HL ? `waiting for a close above ${px(NH.price)}` : '—');

  const base = { symbol, tf, dir, strategy: FB_STRATEGY, strategyName: FB_STRATEGY_NAME, scannedAt: nowSec, price: px(price), isLatest: latest, anchor: { aIndex: A.i, h2Index: H2.i }, outcome: null };
  const levels = { A: pt(A, px), H2: pt(H2, px), NH: NH ? pt(NH, px) : null, HL: HL ? pt(HL, px) : null, HH: HH ? pt(HH, px) : null };
  const progress = steps.filter((s) => s.status === 'DONE').length;

  // ── structure not complete yet → WAITING (shows what is still missing) ────────────────────
  if (!HH) {
    if (!latest) return { analysis: null, reason: 'older structure never completed', steps };
    const next = steps.find((s) => s.status !== 'DONE');
    const analysis = { ...base, id: fbId(symbol, dir, tf, A.time), stage: 'WAITING', bucket: 'waiting', score: Math.min(45, progress * 9), quality: 'WEAK', steps, levels, names: NAME, listed: false, reason: `waiting: ${next?.label || 'structure'}`, progress: `${progress}/${steps.length}` };
    analysis.annotations = buildAnnotations({ cs, sign, px, NAME, A, H2, ch, NH, HL, HH, tf, sec });
    return { analysis, reason: analysis.reason, steps };
  }

  // ── Fib + Breaker + Trendline SUPPORT confluence (NOT a trendline break) ───────────────
  // User update (Fib method): take the two closed candles before the current forming candle.
  // They MUST be opposite colors (green-red or red-green). Number 1 = earlier, 2 = later.
  // If 1 green + 2 red → Fib first point at 1 HIGH, second at 2 LOW.
  // If 1 red + 2 green → Fib first point at 1 LOW, second at 2 HIGH.
  // Golden pocket = zone between 0.618 and 0.65 (configurable on settings).
  // Then require that zone to overlap the breaker block; trendline support adds confluence.
  let fibStart = null; // level-1 extreme (first candle)
  let fibEnd = null;   // level-0 extreme (second candle)
  let fibPair = null;
  // Search most recent consecutive opposite-color pair among closed candles (prefer last two)
  for (let i = n - 1; i >= 1; i--) {
    const c2 = cs[i];
    const c1 = cs[i - 1];
    const bull1 = c1.close > c1.open;
    const bull2 = c2.close > c2.open;
    if (bull1 === bull2) continue; // same color — skip
    if (bull1 && !bull2) {
      // 1 green, 2 red → first = 1 high, second = 2 low
      fibStart = c1.high;
      fibEnd = c2.low;
    } else {
      // 1 red, 2 green → first = 1 low, second = 2 high
      fibStart = c1.low;
      fibEnd = c2.high;
    }
    fibPair = { i1: i - 1, i2: i, time1: c1.time, time2: c2.time, start: fibStart, end: fibEnd };
    break;
  }
  // Fallback to structure HL→HH if no opposite pair found (rare on liquid markets)
  const useStructFib = !fibPair;
  const structLeg = HH.price - HL.price; // always keep structure leg for TP extensions
  const leg = useStructFib ? structLeg : Math.abs(fibStart - fibEnd);
  // Standard Fib: 0 at the "end" (second point), 1 at the "start" (first point)
  const fib = (r) => {
    if (useStructFib) return HH.price - r * structLeg;
    // fibStart is level 1, fibEnd is level 0
    return fibStart + (fibEnd - fibStart) * (1 - r);
  };
  const fibLevels = [0, 0.382, 0.5, 0.618, 0.65, 0.786, 1].map((r) => ({ ratio: r, price: px(fib(r)) }));
  // Band: ensure high > low regardless of direction
  const fFrom = fib(cfg.entryFibFrom);
  const fTo = fib(cfg.entryFibTo);
  const fibBand = { high: Math.max(fFrom, fTo), low: Math.min(fFrom, fTo) };
  const fib618 = fib(cfg.focusFib != null ? cfg.focusFib : 0.618);

  // Breaker block = last bullish candle at the New High that price later closed above (flips to support)
  let bi = NH.i;
  for (let k = NH.i; k >= Math.max(0, NH.i - 4); k--) if (cs[k].close > cs[k].open) { bi = k; break; }
  const breaker = { high: cs[bi].high, low: cs[bi].low, time: cs[bi].time, index: bi };

  // (1) Fib band ∩ Breaker block  → candidate zone
  const fibBreaker = { high: Math.min(fibBand.high, breaker.high), low: Math.max(fibBand.low, breaker.low) };
  const breakerOverlap = fibBreaker.high > fibBreaker.low;
  step('fib_breaker', 'Fib ∩ Breaker Block', breakerOverlap,
    breakerOverlap
      ? `${px(sign === 1 ? fibBreaker.low : fibBreaker.high)} – ${px(sign === 1 ? fibBreaker.high : fibBreaker.low)}`
      : 'breaker does not overlap the fib entry band');

  // (2) Trendline from structure low A → HL — SUPPORT only (must pass through the fib∩breaker zone)
  const slope = (HL.i !== A.i) ? (HL.price - A.price) / (HL.i - A.i) : 0;
  const tlAt = (idx) => A.price + slope * (idx - A.i);
  const tol = atr * (cfg.confluenceTolAtr != null ? cfg.confluenceTolAtr : 0.35);
  // Evaluate trendline at the midpoint of the fib∩breaker zone in time (after HH) / at HL extension
  const tlAtZone = tlAt(Math.max(HL.i, HH.i)); // line value near the structure that defines the zone
  const tlSupportsZone = slope > 0 && breakerOverlap
    && tlAtZone >= fibBreaker.low - tol
    && tlAtZone <= fibBreaker.high + tol;
  const trendline = slope > 0
    ? {
        a: { time: A.time, price: px(A.price) },
        b: { time: HL.time, price: px(HL.price) },
        valueAtZone: px(tlAtZone),
        valueNow: px(tlAt(n - 1)),
        confluence: tlSupportsZone, // true = SUPPORTS the zone (touches it), NOT a break
        role: 'support',
      }
    : null;
  step('trendline', 'Trendline SUPPORT at zone', !!tlSupportsZone,
    trendline
      ? `line at ${px(tlAtZone)} · ${tlSupportsZone ? 'SUPPORTS fib∩breaker zone (touches)' : 'does not touch the zone — no confluence'}`
      : 'no ascending trendline');

  // (3) Triple confluence zone — only when fib + breaker + trendline support all meet
  const needTl = cfg.requireTrendline !== false; // default true
  const needBr = cfg.requireBreaker !== false;
  let zone = null;
  if (breakerOverlap && (!needTl || tlSupportsZone)) {
    zone = fibBreaker;
  } else if (!needBr && (!needTl || tlSupportsZone)) {
    zone = fibBand;
  }
  // Prefer entry at 0.618 when it sits inside the triple zone
  const fibInZone = zone && fib618 >= zone.low && fib618 <= zone.high;
  step('confluence', 'Breaker + Fib + Trendline confluence', !!zone && (!needTl || tlSupportsZone) && fibInZone,
    zone
      ? (fibInZone
          ? `TRIPLE confluence · entry near fib ${(cfg.focusFib ?? 0.618)} @ ${px(fib618)}`
          : `zone ready but fib ${(cfg.focusFib ?? 0.618)} outside — using zone mid`)
      : 'need fib∩breaker AND trendline SUPPORT on the same zone');

  if (!zone) {
    const whyMiss = !breakerOverlap
      ? 'no fib ∩ breaker overlap'
      : 'trendline does not SUPPORT (touch) the fib∩breaker zone';
    const analysis = {
      ...base, id: fbId(symbol, dir, tf, A.time), stage: 'WAITING', bucket: 'waiting', score: Math.min(50, progress * 8),
      quality: 'WEAK', steps, levels, names: NAME, listed: false, reason: whyMiss, invalidatedBy: null,
      fib: { leg: r8(leg), levels: fibLevels, band: { from: cfg.entryFibFrom, to: cfg.entryFibTo }, source: useStructFib ? 'structure' : 'opposite_candles', pair: fibPair ? { t1: fibPair.time1, t2: fibPair.time2 } : null },
      breaker: { high: px(sign === 1 ? breaker.high : breaker.low), low: px(sign === 1 ? breaker.low : breaker.high), time: breaker.time, overlap: breakerOverlap },
      trendline,
    };
    analysis.annotations = buildAnnotations({ cs, sign, px, NAME, A, H2, ch, NH, HL, HH, tf, sec, fibLevels, fibPair, breaker, trendline, slope, tlAt, n });
    return { analysis, reason: analysis.reason, steps };
  }

  const entry = fibInZone ? fib618 : (zone.high + zone.low) / 2;
  const sl = Math.min(fib(cfg.entryFibTo), zone.low) - cfg.slBufferAtr * atr;
  const risk = entry - sl;
  const tp1 = HH.price;
  const tp2 = HH.price + (cfg.ext1 - 1) * structLeg;
  const tp3 = HH.price + (cfg.ext2 - 1) * structLeg;
  const tp4 = entry + (cfg.targetRR || 4) * risk;
  const rr1 = risk > 0 ? +((tp1 - entry) / risk).toFixed(2) : null;
  const rr2 = risk > 0 ? +((tp2 - entry) / risk).toFixed(2) : null;
  const rr3 = risk > 0 ? +((tp3 - entry) / risk).toFixed(2) : null;
  const rr4 = risk > 0 ? +(cfg.targetRR || 4) : null;
  const plan = {
    entry: px(entry), sl: px(sl),
    tp1: px(tp1), tp2: px(tp2), tp3: px(tp3), tp4: px(tp4),
    rr1, rr2, rr3, rr4, targetRR: cfg.targetRR || 4,
    rrOk: rr1 != null && rr1 >= cfg.minRR,
  };
  // ── lifecycle after HH: wait for price to RETURN to the confluence zone (support holds) ─
  const buf = cfg.slBufferAtr * atr;
  let touched = -1;
  let filled = -1;
  let invalid = null;
  let done = -1;
  let endIdx = n - 1;
  for (let j = HH.i + 1; j < n; j++) {
    const c = cs[j];
    if (touched < 0 && c.low <= zone.high) touched = j;
    if (filled < 0 && c.low <= entry) filled = j;
    // Invalidation = structure / stop broken — NOT "trendline break as entry signal"
    if (c.close < HL.price - buf) { invalid = `closed below the ${NAME.HL} (${px(HL.price)})`; endIdx = j; break; }
    if (c.close < sl) { invalid = `closed below the stop (${px(sl)})`; endIdx = j; break; }
    if (filled >= 0 && j > filled && c.high >= tp1) { done = j; endIdx = j; break; }
  }
  // Re-check trendline SUPPORT at the moment price first touches the zone (still support, not break)
  const tlIdx = touched >= 0 ? touched : n - 1;
  const tlNow = tlAt(tlIdx);
  if (trendline) {
    trendline.valueNow = px(tlNow);
    trendline.atTime = cs[tlIdx].time;
    // still must be supporting the zone at touch time
    trendline.confluence = tlNow >= zone.low - tol && tlNow <= zone.high + tol;
  }
  const hhExtending = Math.max(...cs.slice(HH.i + 1).map((c) => c.high), -Infinity) > HH.price;
  const barsSince = n - 1 - HH.i;
  const inZone = price <= zone.high && price >= sl;
  let stage = 'ENTRY_READY';
  let bucket = 'entry_ready';
  let reason = null;
  if (invalid) { stage = 'INVALIDATED'; bucket = 'invalidated'; reason = invalid; }
  else if (done >= 0) { stage = 'COMPLETED'; bucket = 'completed'; reason = `TP1 (${NAME.HH}) reached`; }
  else if (filled >= 0) { stage = 'ONGOING'; bucket = 'ongoing'; }
  else if (hhExtending && touched < 0) { stage = 'WAITING'; bucket = 'waiting'; reason = `${NAME.HH} is still extending — fib moves when it confirms`; }
  else if (touched < 0 && barsSince > cfg.maxSetupAgeBars) { stage = 'INVALIDATED'; bucket = 'invalidated'; reason = `price never came back to the zone (${barsSince} bars)`; }
  else if (touched < 0 && breakerOverlap && trendline?.confluence) { stage = 'ENTRY_READY'; bucket = 'confluence'; }
  let outcome = null;
  if (stage === 'COMPLETED') outcome = 'TP1 reached';
  else if (stage === 'INVALIDATED') outcome = filled >= 0 ? 'stopped out' : 'invalidated before entry';
  if (!latest) {
    // an OLDER setup is history: it either hit TP1, was stopped, or simply played out — never "waiting / ready"
    if (stage !== 'COMPLETED' && stage !== 'INVALIDATED') {
      stage = 'COMPLETED';
      bucket = 'completed';
      outcome = filled >= 0 ? 'older setup — entered, TP1 / stop not reached' : 'older setup — superseded by a newer structure';
      reason = outcome;
    }
  }
  step('entry', 'Retest of the zone / entry', stage === 'ONGOING' || stage === 'COMPLETED' ? true : inZone ? null : false, stage === 'ENTRY_READY' ? (inZone ? 'price is inside the zone now' : `${(((price - zone.high) / (atr || 1))).toFixed(1)} ATR above the zone`) : (reason || stage.toLowerCase()));

  // score (configurable weights — structure/BOS already in progress steps)
  let score = 0;
  const why = [];
  const add = (pts, msg) => { if (pts) { score += pts; why.push({ points: pts, why: msg }); } };
  add(cfg.scoreStructure || 15, 'valid market structure (HH/HL chain)');
  add(cfg.scoreBos || 15, 'BOS confirmed (HH)');
  if (breakerOverlap) add(cfg.scoreBreaker || 25, 'breaker block ∩ fib confluence');
  if (fib618 >= zone.low && fib618 <= zone.high) add(cfg.scoreFib618 || 20, 'fib 0.618 inside confluence zone');
  if (trendline?.confluence) add(cfg.scoreTrendline || 15, 'trendline SUPPORTS (touches) the confluence zone');
  if (inZone || filled >= 0) add(cfg.scoreEntry || 10, inZone ? 'price in zone / confirmation path' : 'zone entered');
  score = Math.max(0, Math.min(100, Math.round(score)));
  const quality = score >= 80 ? 'STRONG' : score >= 65 ? 'VALID' : 'WEAK';
  const reasons = [];
  if (cfg.requireTrendline !== false && !trendline?.confluence) reasons.push('trendline must SUPPORT (touch) the zone — not a break signal');
  if (!plan.rrOk) reasons.push(`R:R ${rr1} to ${NAME.HH} is below the minimum (${cfg.minRR})`);
  if (score < cfg.minScore) reasons.push(`score ${score} below the minimum (${cfg.minScore})`);
  if (stage === 'INVALIDATED' && reason) reasons.push(reason);
  const listed = !latest ? true : reasons.length === 0 || (stage === 'COMPLETED' && !reasons.some((r) => !/R:R|score/.test(r)));

  // granular lifecycle for dashboard (prompt stages)
  let lifecycleStage = stage;
  if (stage === 'ENTRY_READY') {
    if (trendline?.confluence && breakerOverlap) lifecycleStage = inZone ? 'ZONE_TOUCHED' : 'CONFLUENCE_FOUND';
    if (inZone) lifecycleStage = 'ZONE_TOUCHED';
    else if (touched < 0) lifecycleStage = 'WAITING_RETRACE';
    else lifecycleStage = 'ENTRY_READY';
  } else if (stage === 'ONGOING') lifecycleStage = 'TRADE_ACTIVE';
  else if (stage === 'COMPLETED') lifecycleStage = 'COMPLETED';
  else if (stage === 'INVALIDATED') lifecycleStage = 'INVALIDATED';
  else if (stage === 'WAITING') lifecycleStage = 'WAITING_RETRACE';

  const analysis = {
    ...base,
    id: fbId(symbol, dir, tf, A.time),
    stage,
    lifecycleStage,
    strategyName: FB_STRATEGY_NAME,
    bucket,
    score,
    quality,
    listed,
    reason,
    reasons,
    steps,
    levels,
    names: NAME,
    fib: { leg: r8(leg), levels: fibLevels, band: { from: cfg.entryFibFrom, to: cfg.entryFibTo }, source: useStructFib ? 'structure' : 'opposite_candles', pair: fibPair ? { t1: fibPair.time1, t2: fibPair.time2 } : null },
    breaker: { high: px(sign === 1 ? breaker.high : breaker.low), low: px(sign === 1 ? breaker.low : breaker.high), time: breaker.time, overlap: breakerOverlap },
    zone: sign === 1 ? { high: r8(zone.high), low: r8(zone.low) } : { high: r8(-zone.low), low: r8(-zone.high) },
    trendline,
    plan,
    inZone,
    distanceAtr: price <= zone.high ? 0 : +((price - zone.high) / (atr || 1)).toFixed(2),
    touchedTime: touched >= 0 ? cs[touched].time : null,
    filledTime: filled >= 0 ? cs[filled].time : null,
    breakdown: why,
    progress: `${steps.filter((s) => s.status === 'DONE').length}/${steps.length}`,
    hhTime: HH.time,
    isLatest: latest,
    outcome,
    anchor: { aIndex: A.i, h2Index: H2.i },
    endTime: cs[endIdx].time,
  };
  analysis.annotations = buildAnnotations({ cs, sign, px, NAME, A, H2, ch, NH, HL, HH, tf, sec, fibLevels, fibPair, breaker, zone, trendline, plan, slope, tlAt, n, filled: filled >= 0 ? cs[filled].time : null, endT: cs[endIdx].time });
  return { analysis, reason: listed ? null : reasons.join(' · ') || reason, steps };
}

const pt = (p, px) => ({ time: p.time, price: px(p.price) });

function buildAnnotations({ cs, sign, px, NAME, A, H2, ch, NH, HL, HH, tf, sec, fibLevels, fibPair, breaker, zone, trendline, plan, slope, tlAt, n, filled, endT }) {
  const out = [];
  const add = (a) => out.push({ tf, ...a });
  const lastT = endT || cs[cs.length - 1].time; // a finished (older) setup is drawn only up to where it ended
  const isLowReal = (p) => (sign === 1 ? p.type === 'low' : p.type === 'high'); // real-space low?
  const mark = (p, label) => add({ group: 'structure', kind: 'marker', t: p.time, p: px(p.price), shape: isLowReal(p) ? 'up' : 'down', label, bold: true });
  // zig-zag through the real structure points
  const chain = [H2, A, NH, HL, HH].filter(Boolean);
  if (chain.length > 1) add({ group: 'structure', kind: 'poly', points: chain.map((p) => ({ t: p.time, p: px(p.price) })), style: 'dashed' });
  mark(H2, NAME.H2);
  mark(A, NAME.A);
  add({ group: 'choch', kind: 'hline', t1: H2.time, t2: ch.breakTime, p1: px(H2.price), label: NAME.brk, style: 'dashed' });
  if (NH) mark(NH, NAME.NH);
  if (HL) mark(HL, NAME.HL);
  if (HH) mark(HH, NAME.HH);
  if (!HH) return out;

  // Fib drawing: prefer the opposite-color candle pair (user rule). Fallback to structure HL→HH.
  if (fibPair && fibLevels && fibLevels.length) {
    // Anchor lines between the two candle extremes; label 1 = first candle extreme, 0 = second
    const t1 = fibPair.time1;
    const t2 = fibPair.time2;
    for (const f of fibLevels) {
      const isAnchor = f.ratio === 0 || f.ratio === 1;
      const label = f.ratio === 1 ? '1 (candle)' : f.ratio === 0 ? '0 (candle)' : String(f.ratio);
      add({ group: 'fib', kind: 'hline', t1: t1, t2: null, p1: f.price, label, style: isAnchor ? undefined : 'dotted' });
    }
    // small markers on the two extremes used for Fib
    add({ group: 'fib', kind: 'marker', t: t1, p: px(fibPair.start), shape: 'down', label: '1', bold: true });
    add({ group: 'fib', kind: 'marker', t: t2, p: px(fibPair.end), shape: 'up', label: '0', bold: true });
  } else if (fibLevels && fibLevels.length) {
    // structure fallback
    for (const f of fibLevels) add({ group: 'fib', kind: 'hline', t1: HL.time, t2: null, p1: f.price, label: f.ratio === 0 ? `0 (${NAME.HH})` : f.ratio === 1 ? `1 (${NAME.HL})` : String(f.ratio), style: f.ratio === 0 || f.ratio === 1 ? undefined : 'dotted' });
  }

  if (breaker) {
    const bh = sign === 1 ? breaker.high : -breaker.low;
    const bl = sign === 1 ? breaker.low : -breaker.high;
    add({ group: 'breaker', kind: 'zone', t1: breaker.time, t2: null, p1: bh, p2: bl, label: 'Breaker block' });
  }
  if (zone && plan) {
    const real = sign === 1 ? { high: zone.high, low: zone.low } : { high: -zone.low, low: -zone.high };
    const label = (breaker && zone && trendline?.confluence)
      ? 'BREAKER BLOCK + FIB 0.618 + TRENDLINE'
      : ['Fib Level', breaker && zone ? 'Breaker Block' : null, trendline?.confluence ? 'Trendline' : null].filter(Boolean).join(' + ');
    add({ group: 'entry', kind: 'zone', t1: HH.time, t2: null, p1: real.high, p2: real.low, label: label || 'Entry zone' });
    const t1 = filled || lastT;
    add({ group: 'entry', kind: 'zone', t1, t2: lastT + 14 * sec, p1: plan.entry, p2: plan.sl, label: 'SL', tone: 'sl' });
    add({ group: 'targets', kind: 'zone', t1, t2: lastT + 14 * sec, p1: plan.tp1, p2: plan.entry, label: `TP1 · R:R ${plan.rr1}`, tone: 'tp' });
    add({ group: 'targets', kind: 'hline', t1, t2: lastT + 14 * sec, p1: plan.tp2, label: `TP2 · R:R ${plan.rr2}`, tone: 'tp' });
    add({ group: 'targets', kind: 'hline', t1, t2: lastT + 14 * sec, p1: plan.tp3, label: 'TP3', tone: 'tp', style: 'dashed' });
    if (plan.tp4) add({ group: 'targets', kind: 'hline', t1, t2: lastT + 14 * sec, p1: plan.tp4, label: `TP4 · 1:${plan.targetRR || 4}`, tone: 'tp', style: 'dashed' });
    add({ group: 'entry', kind: 'hline', t1: HH.time, t2: null, p1: plan.entry, label: 'entry', tone: 'tp' });
  }
  if (trendline && slope > 0) {
    const endIdx = Math.max(HL.i, Math.round((lastT - cs[0].time) / sec));
    add({ group: 'trendline', kind: 'poly', points: [{ t: A.time, p: px(A.price) }, { t: lastT, p: px(tlAt(endIdx)) }], style: 'dashed', label: 'Trendline SUPPORT' });
  }
  return out;
}
