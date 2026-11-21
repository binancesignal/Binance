/**
 * Strategy 2 — Chart Pattern Breakout (independent of SMC Strategy 1)
 * Extended with Universal Pattern + Confluence + Elliott Wave engine.
 * Existing breakout / SMC / Fib path is fully preserved.
 */
import { calcATR, relativeVolume, rsiDivergenceForDirection, checkEmaAlignment } from '../../indicators.js';
import { detectStructure } from '../../structure.js';
import { CHART_PATTERN_CONFIG } from './config.js';
import { detectPatterns } from './patterns.js';
import { validateBreakout, evaluateNearBreakout } from './breakout.js';
import { validateHarmonic } from './harmonics.js';
import { validatePriceAction } from './priceAction.js';
import { computeConfluence } from './confluence.js';
import { scoreChartPatternSetup } from './scoring.js';
import { evaluateUniversalSetup } from '../../engines/universalPattern.js';
import { resolveGateConfig, isHard, SOFT_PENALTY, GATE_DEFS } from './gates.js';

/**
 * Per-gate checklist for the chart GATES panel.
 * pass: true = passed, false = failed (soft gate: only cost score), null = not evaluated / n/a
 */
function buildGateChecklist({ cfg, universal, htfAligned, htfStruct, rr, rrMeasured, pillars, cf, br, near = false, rsiOk = null, emaOk = null }) {
  const fails = universal?.gateFails || {};
  const ran = !!universal;
  const uni = (key) => (ran ? !(fails[key] && fails[key].length) : null);
  const ewOn = cfg.waveAnalysisEnabled !== false || isHard(cfg, 'wave');
  const pass = {
    htf: htfAligned || htfStruct?.bias === 'neutral',
    volume: near ? null : (+br?.rvol || 0) >= (cfg.minRelativeVolume ?? 1.3),
    retest: isHard(cfg, 'retest') && !near ? true : null,
    pillars: pillars >= (cfg.minConfluencePillars ?? 1),
    smc: !!cf?.smcOk,
    fib: !!cf?.fibOk,
    rejectionZone: ran && !(fails.rejectionZone && fails.rejectionZone.length) && universal?.chartZones?.some((z) => z.kind === 'REJECTION') ? true
      : ran && fails.rejectionZone?.length ? false : null,
    rejection: uni('rejection'),
    location: uni('location'),
    midRange: uni('midRange'),
    wave: ewOn ? uni('wave') : null,
    blockedPath: !(cf?.smc?.blocked || []).some((x) => /before TP1/.test(x)),
    tp1rr: rr + 1e-6 >= (cfg.minTp1RR ?? 1.0),
    tp2rr: rrMeasured >= (cfg.minRR ?? 1.5),
    rsiDiv: rsiOk,
    ema: emaOk,
  };
  return GATE_DEFS.map((g) => ({
    key: g.key,
    label: g.label,
    mode: isHard(cfg, g.key) ? 'hard' : 'soft',
    pass: pass[g.key] ?? null,
  }));
}

/** compact, JSON-safe pattern geometry (times, not indexes) so the chart can be redrawn later */
function buildPatternGeom(pattern, br, candles, { tf, htf, tp2, tp3, cf, pending = false, elliott = null, gates = null, uni = null }) {
  const t = (i) => candles[Math.max(0, Math.min(candles.length - 1, Math.round(i)))]?.time;
  const i0 = Math.max(0, pattern.startIndex ?? 0);
  const iB = br.breakoutIndex;
  const seg = (ln, kind) =>
    ln
      ? { kind, t1: t(i0), p1: ln.a + ln.b * i0, t2: t(iB), p2: ln.a + ln.b * iB }
      : null;
  const upper = seg(pattern.upperLine, 'upper');
  const lower = seg(pattern.lowerLine, 'lower');
  const broken = pending ? null : br.direction === 'LONG' ? 'upper' : 'lower';

  // Elliott pivots → times for chart redraw
  let elliottGeom = null;
  const primary = elliott?.primary || elliott?.primaryCount || null;
  if (primary?.pivots?.length) {
    elliottGeom = {
      type: primary.type || null,
      direction: primary.direction || null,
      currentWave: primary.currentWave ?? null,
      confidence: primary.confidence ?? null,
      invalidation: primary.invalidation ?? null,
      pivots: primary.pivots.map((p) => ({
        label: p.label,
        p: p.price,
        t: t(p.i),
      })),
    };
  }

  return {
    type: pattern.patternType,
    direction: br.direction,
    pending,
    tf,
    htf,
    t0: t(i0),
    t1: t(pattern.endIndex),
    tb: t(iB),
    lines: [upper, lower].filter(Boolean).map((l) => ({ ...l, broken: l.kind === broken })),
    anchors: (pattern.anchors || []).map((a) => ({ t: t(a.i), p: a.price, label: a.label })),
    flagStartT: pattern.flagStartIndex != null ? t(pattern.flagStartIndex) : null,
    harmonic: !!pattern.harmonic,
    harmonicFamily: pattern.harmonicFamily || null,
    priceAction: !!pattern.priceAction,
    paFamily: pattern.paFamily || null,
    przLow: pattern.przLow ?? null,
    przHigh: pattern.przHigh ?? null,
    ratios: pattern.ratios || null,
    level: br.level,
    top: pattern.resistance,
    bottom: pattern.support,
    height: pattern.patternHeight,
    tp2,
    tp3,
    smc: cf ? { ob: cf.smc.ob || null, fvg: cf.smc.fvg || null, sweep: cf.smc.sweep || null, notes: cf.smc.notes, blocked: cf.smc.blocked, points: cf.smc.points } : null,
    fib: cf ? { level: cf.fib.level ?? null, price: cf.fib.price ?? null, kind: cf.fib.kind || null, leg: cf.fib.leg || null, ext: cf.fib.ext || null, notes: cf.fib.notes, points: cf.fib.points } : null,
    elliott: elliottGeom,
    gates,
    zones: uni?.chartZones || [],
    liqLevels: uni?.liqLevels || [],
    pd: uni?.pdZone || null,
    events: uni?.events || [],
    locationNotes: uni?.locationNotes || [],
    touches: pattern.touches,
    fit: pattern.fit != null ? +Math.max(0, Math.min(1, pattern.fit)).toFixed(2) : null,
    breakoutDistAtr: br.distAtr != null ? +br.distAtr.toFixed(2) : null,
    bodyRatio: br.bodyRatio != null ? +br.bodyRatio.toFixed(2) : null,
  };
}


/** SL / measured-move TPs for a breakout at `entry` through `level` (same rules as live breakouts) */
function computeLevels({ pattern, direction, entry, level, atr, cfg }) {
  const A = atr || entry * 0.004;
  const slBuf = (cfg.slAtrBuffer ?? 0.35) * A;
  const maxSl = (cfg.maxSlATR ?? 1.8) * A;
  const behind = (cfg.slBelowLevelATR ?? 0.5) * A;
  const height = pattern.patternHeight || Math.abs((pattern.resistance || entry) - (pattern.support || entry));
  let sl, tp1, tp2, tp3;
  if (direction === 'LONG') {
    const structural = Math.min(pattern.support ?? entry, level) - slBuf;
    sl = Math.max(structural, entry - maxSl);
    sl = Math.min(sl, level - behind);
    if (!(sl < entry)) sl = entry - Math.max(slBuf, entry * 0.005);
    const risk = entry - sl;
    tp1 = entry + Math.max(height * 0.5, risk);
    tp2 = entry + height;
    tp3 = entry + height * 1.618;
  } else {
    const structural = Math.max(pattern.resistance ?? entry, level) + slBuf;
    sl = Math.min(structural, entry + maxSl);
    sl = Math.max(sl, level + behind);
    if (!(sl > entry)) sl = entry + Math.max(slBuf, entry * 0.005);
    const risk = sl - entry;
    tp1 = entry - Math.max(height * 0.5, risk);
    tp2 = entry - height;
    tp3 = entry - height * 1.618;
  }
  return { sl, tp1, tp2, tp3, height };
}

/**
 * Pre-breakout setup: pattern formed, price pressing on the boundary, no valid breakout close yet.
 * Entry shown = the price a confirming close must reach (level ± breakoutAtrMin × ATR).
 */
function buildNearSetup({ symbol, pattern, patternCandles, htfStruct, atr, price, cfg }) {
  const nb = evaluateNearBreakout(pattern, patternCandles, atr, price, cfg);
  if (!nb.ok) return { reject: nb.reason };

  const direction = nb.direction;
  const htfAligned =
    direction === 'LONG'
      ? htfStruct.bias === 'bullish' || htfStruct.bos === 'bullish' || htfStruct.choch === 'bullish'
      : htfStruct.bias === 'bearish' || htfStruct.bos === 'bearish' || htfStruct.choch === 'bearish';
  const softFails = [];
  if (!htfAligned && htfStruct.bias !== 'neutral') {
    if (cfg.nearRequireHtfAlign !== false && isHard(cfg, 'htf')) {
      return { reject: `HTF ${htfStruct.bias} contradicts ${direction}` };
    }
    if (!isHard(cfg, 'htf')) softFails.push(`HTF ${htfStruct.bias} contradicts ${direction}`);
  }

  const A = atr || price * 0.004;
  const trigger = nb.level;
  const off = (cfg.breakoutAtrMin ?? 0.2) * A;
  const entry = direction === 'LONG' ? trigger + off : trigger - off;
  const { sl, tp1, tp2, tp3 } = computeLevels({ pattern, direction, entry, level: trigger, atr: A, cfg });

  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  const rrMeasured = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
  if (rr + 1e-6 < (cfg.minTp1RR ?? 1.0)) {
    if (isHard(cfg, 'tp1rr')) return { reject: `TP1 RR ${rr.toFixed(2)} < min ${cfg.minTp1RR ?? 1.0}` };
    softFails.push(`TP1 RR ${rr.toFixed(2)} < ${cfg.minTp1RR ?? 1.0}`);
  }
  if (rrMeasured < (cfg.minRR ?? 1.5)) {
    if (isHard(cfg, 'tp2rr')) return { reject: `Measured-move RR ${rrMeasured.toFixed(2)} < min ${cfg.minRR}` };
    softFails.push(`Measured RR ${rrMeasured.toFixed(2)} < ${cfg.minRR}`);
  }

  const brLike = { breakoutIndex: nb.breakoutIndex, level: trigger, direction };
  const cf = computeConfluence({ pattern, br: brLike, direction, candles: patternCandles, atr: A, entry, tp1, tp2, tp3, cfg });
  const pillars = (htfAligned ? 1 : 0) + (cf.smcOk ? 1 : 0) + (cf.fibOk ? 1 : 0);
  if (pillars < (cfg.nearMinPillars ?? 1)) {
    if (isHard(cfg, 'pillars')) return { reject: `Confluence ${pillars}/3 too low` };
    softFails.push(`Confluence ${pillars}/3 too low`);
  }

  let rsiOk = null;
  let emaOk = null;
  try {
    const rsi = rsiDivergenceForDirection(patternCandles, direction, cfg.rsiPeriod ?? 14);
    rsiOk = !!rsi.ok;
    if (!rsi.ok) {
      const why = `RSI div: ${rsi.detail}`;
      if (isHard(cfg, 'rsiDiv')) return { reject: why };
      softFails.push(why);
    }
  } catch (_) {
    if (isHard(cfg, 'rsiDiv')) return { reject: 'RSI divergence could not be evaluated' };
  }
  try {
    const ema = checkEmaAlignment(patternCandles, direction, {
      fast: cfg.emaFast ?? 21,
      slow: cfg.emaSlow ?? 50,
    });
    emaOk = !!ema.aligned;
    if (!ema.aligned) {
      const why = `EMA: ${ema.reason}`;
      if (isHard(cfg, 'ema')) return { reject: why };
      softFails.push(why);
    }
  } catch (_) {
    if (isHard(cfg, 'ema')) return { reject: 'EMA alignment could not be evaluated' };
  }

  // readiness score = pattern/confluence quality (no breakout-candle points) + proximity bonus
  const { score: base, conf } = scoreChartPatternSetup({
    pattern,
    breakout: { ok: false, rvol: nb.volBuild, bodyRatio: 0, distAtr: 9 },
    htfAligned,
    confluence: cf,
    cfg,
  });
  if (rsiOk) conf.push('RSI divergence confirms direction');
  if (emaOk) conf.push('EMA21/50 trend aligns');
  let score = Math.max(0, base - SOFT_PENALTY * softFails.length);
  if (softFails.length) conf.push(...softFails.map((w) => `⚠ soft: ${w}`));
  if (nb.state === 'BREAKING_NOW' || nb.state === 'AT_LEVEL') { score += 8; conf.push('Price at breakout level'); }
  else if (nb.gapAtr <= 0.4) { score += 4; conf.push('Very close to level'); }
  if (nb.approaching) { score += 2; conf.push('Pressing toward level'); }
  if (nb.volBuild >= 1.2) conf.push(`Volume building x${nb.volBuild.toFixed(2)}`);
  score = Math.min(100, Math.round(score));
  // STRICT: admin "Min signal score" is a real floor for watching setups too
  // (previously capped at 65, so a 70 setting still let 65-69 through).
  const nearFloor = Math.max(cfg.nearMinScore ?? 0, cfg.minSignalScore ?? 50);
  if (score < nearFloor) return { reject: `Near score ${score} < min ${nearFloor}` };

  // Run the SAME universal engine (Elliott Wave / location / rejection / mid-range gates)
  // that confirmed breakouts go through, so HARD gates also apply to WATCHING setups.
  let universal = null;
  if (cfg.universalEngineEnabled !== false) {
    try {
      universal = evaluateUniversalSetup({
        symbol,
        pattern,
        breakout: { ...brLike, ok: false },
        candles: patternCandles,
        htfCandles: null,
        direction,
        price,
        atr: A,
        cfg,
      });
    } catch (e) {
      // fail CLOSED when Elliott is a hard gate - never let an engine error bypass it
      if (isHard(cfg, 'wave')) return { reject: `Elliott hard gate could not be evaluated (${e.message})` };
      universal = null;
    }
    if (universal && Array.isArray(universal.whyRejected) && universal.whyRejected.length) {
      return { reject: `Universal filter: ${universal.whyRejected.join('; ')}` };
    }
    if (universal?.softFails?.length) {
      softFails.push(...universal.softFails);
      conf.push(...universal.softFails.map((w) => `⚠ soft: ${w}`));
    }
    if (universal?.finalScore) {
      score = Math.round(score * 0.7 + universal.finalScore * 0.3);
      if (score < nearFloor) return { reject: `Near score ${score} < min ${nearFloor} (after confluence blend)` };
    }
  }

  const tf = cfg.patternTf;
  // geometry so the Telegram chart can draw the forming pattern (trendlines, anchors, level)
  const gates = buildGateChecklist({
    cfg, universal, htfAligned, htfStruct, rr, rrMeasured, pillars, cf, br: brLike, near: true, rsiOk, emaOk,
  });
  const patternGeom = buildPatternGeom(pattern, brLike, patternCandles, {
      elliott: typeof universal !== 'undefined' ? universal?.elliott : null,
    tf, htf: cfg.htf, tp2, tp3, cf, pending: true, gates, uni: universal,
  });
  return {
    setup: {
      patternGeom,
      kind: 'NEAR_BREAKOUT',
      strategy: 'chart_pattern',
      signal_id: `NB_${symbol}_${pattern.patternType}_${tf}_${direction}`,
      symbol,
      pattern: pattern.patternType,
      patternTf: tf,
      htf: cfg.htf,
      direction,
      dir: direction,
      state: nb.state,
      score,
      price,
      trigger,
      entry,
      sl,
      tp1,
      tp2,
      tp3,
      rr: rr.toFixed(1),
      rrMeasured: +rrMeasured.toFixed(2),
      gapAtr: +nb.gapAtr.toFixed(2),
      gapPct: +nb.gapPct.toFixed(2),
      approaching: nb.approaching,
      volBuild: +nb.volBuild.toFixed(2),
      age: nb.age,
      htfAligned,
      touches: pattern.touches,
      conf,
      blockers: cf.smc.blocked,
    },
  };
}

function mergeCfg(overrides) {
  return resolveGateConfig(CHART_PATTERN_CONFIG, overrides);
}

/**
 * Run chart pattern strategy on one symbol.
 * @param {object} args
 * @returns {{ setups: array, rejected: array }}
 */
export function runChartPatternStrategy({
  symbol,
  patternCandles,
  htfCandles,
  entryCandles,
  price,
  cfg: cfgOver,
  includeNear = false,
}) {
  const cfg = mergeCfg(cfgOver);
  const rejected = [];
  const setups = [];
  const near = [];

  if (!patternCandles?.length || !price) {
    return { setups, near, rejected: [{ reason: 'Missing data' }] };
  }

  const atr = calcATR(patternCandles.slice(0, -1), 14) || calcATR(patternCandles, 14) || 0;
  let patterns = detectPatterns(patternCandles, atr);

  // Optional filter: only keep user-selected pattern types (enabledPatterns)
  const ep = cfg.enabledPatterns;
  if (Array.isArray(ep) && ep.length > 0 && ep !== 'ALL' && !(ep.length === 1 && ep[0] === 'ALL')) {
    const allow = new Set(ep.map((x) => String(x).toUpperCase()));
    patterns = patterns.filter((p) => allow.has(String(p.patternType || '').toUpperCase()));
  }

  if (!patterns.length) {
    return { setups, near, rejected: [{ reason: 'No valid chart pattern detected' }] };
  }

  const htfStruct = htfCandles?.length ? detectStructure(htfCandles) : { bias: 'neutral' };
  for (const pattern of patterns) {
    const br = pattern.priceAction
      ? validatePriceAction(pattern, patternCandles, atr, cfg)
      : pattern.harmonic
        ? validateHarmonic(pattern, patternCandles, atr, cfg)
        : validateBreakout(pattern, patternCandles, atr, cfg);
    if (!br.ok) {
      // no valid breakout close yet → maybe it is about to break (manual scan radar)
      // (price-action patterns have no breakout boundary, so they never appear on the radar)
      if (includeNear && cfg.nearBreakoutEnabled !== false && !pattern.priceAction) {
        try {
          const nr = buildNearSetup({ symbol, pattern, patternCandles, htfStruct, atr, price, cfg });
          if (nr.setup) near.push(nr.setup);
        } catch (_) {}
      }
      rejected.push({
        pattern: pattern.patternType,
        reason: br.reason,
        rvol: br.rvol,
      });
      continue;
    }

    const direction = br.direction;
    const softFails = [...(br.softFails || [])]; // SOFT gates that failed → score penalty only
    const htfAligned =
      direction === 'LONG'
        ? htfStruct.bias === 'bullish' || htfStruct.bos === 'bullish' || htfStruct.choch === 'bullish'
        : htfStruct.bias === 'bearish' || htfStruct.bos === 'bearish' || htfStruct.choch === 'bearish';

    if (!htfAligned && htfStruct.bias !== 'neutral') {
      if (isHard(cfg, 'htf')) {
        rejected.push({
          pattern: pattern.patternType,
          reason: `HTF ${htfStruct.bias} contradicts ${direction}`,
        });
        continue;
      }
      softFails.push(`HTF ${htfStruct.bias} contradicts ${direction}`);
    }

    // SL / TP from pattern structure
    //  - SL: behind the pattern, but capped (maxSlATR) and always behind the broken level
    //  - TP: measured moves (0.5x / 1x / 1.618x pattern height); TP1 never closer than 1R
    const entry = br.entry;
    const A = atr || entry * 0.004;
    const slBuf = (cfg.slAtrBuffer ?? 0.35) * A;
    const maxSl = (cfg.maxSlATR ?? 1.8) * A;
    const behind = (cfg.slBelowLevelATR ?? 0.5) * A;
    const height = pattern.patternHeight || Math.abs((pattern.resistance || entry) - (pattern.support || entry));
    let sl, tp1, tp2, tp3;

    if (direction === 'LONG') {
      const structural = Math.min(pattern.support ?? entry, br.level) - slBuf;
      sl = Math.max(structural, entry - maxSl); // cap distance
      sl = Math.min(sl, br.level - behind); // stay behind the broken level
      if (!(sl < entry)) sl = entry - Math.max(slBuf, entry * 0.005);
      const risk = entry - sl;
      tp1 = entry + Math.max(height * 0.5, risk);
      tp2 = entry + height;
      tp3 = entry + height * 1.618;
    } else {
      const structural = Math.max(pattern.resistance ?? entry, br.level) + slBuf;
      sl = Math.min(structural, entry + maxSl);
      sl = Math.max(sl, br.level + behind);
      if (!(sl > entry)) sl = entry + Math.max(slBuf, entry * 0.005);
      const risk = sl - entry;
      tp1 = entry - Math.max(height * 0.5, risk);
      tp2 = entry - height;
      tp3 = entry - height * 1.618;
    }

    const risk = Math.abs(entry - sl);
    const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0; // TP1 R:R (shown in Telegram)
    const rrMeasured = risk > 0 ? Math.abs(tp2 - entry) / risk : 0; // real quality filter
    if (rr + 1e-6 < (cfg.minTp1RR ?? 1.0)) {
      if (isHard(cfg, 'tp1rr')) {
        rejected.push({ pattern: pattern.patternType, reason: `TP1 RR ${rr.toFixed(2)} < min ${cfg.minTp1RR ?? 1.0}` });
        continue;
      }
      softFails.push(`TP1 RR ${rr.toFixed(2)} < ${cfg.minTp1RR ?? 1.0}`);
    }
    if (rrMeasured < (cfg.minRR ?? 1.5)) {
      if (isHard(cfg, 'tp2rr')) {
        rejected.push({
          pattern: pattern.patternType,
          reason: `Measured-move RR ${rrMeasured.toFixed(2)} < min ${cfg.minRR}`,
        });
        continue;
      }
      softFails.push(`Measured RR ${rrMeasured.toFixed(2)} < ${cfg.minRR}`);
    }

    // ---------- confluence (real SMC + Fib checks) ----------
    const cf = computeConfluence({
      pattern, br, direction, candles: patternCandles, atr, entry, tp1, tp2, tp3, cfg,
    });
    const pillars = (htfAligned ? 1 : 0) + (cf.smcOk ? 1 : 0) + (cf.fibOk ? 1 : 0);

    if (cfg.requireSmcConfluence && !cf.smcOk) {
      rejected.push({ pattern: pattern.patternType, reason: 'SMC confluence required but missing' });
      continue;
    }
    if (cfg.requireFibConfluence && !cf.fibOk) {
      rejected.push({ pattern: pattern.patternType, reason: 'Fib confluence required but missing' });
      continue;
    }
    if (pillars < (cfg.minConfluencePillars ?? 2)) {
      const why = `Confluence ${pillars}/3 < min ${cfg.minConfluencePillars ?? 2} (HTF ${htfAligned ? 'yes' : 'no'} · SMC ${cf.smcOk ? 'yes' : 'no'} · Fib ${cf.fibOk ? 'yes' : 'no'})`;
      if (isHard(cfg, 'pillars')) {
        rejected.push({ pattern: pattern.patternType, reason: why });
        continue;
      }
      softFails.push(why);
    }
    if (cfg.rejectBlockedPath && cf.smc.blocked.some((x) => /before TP1/.test(x))) {
      rejected.push({ pattern: pattern.patternType, reason: `Path blocked: ${cf.smc.blocked.join(', ')}` });
      continue;
    }

    // ---------- RSI divergence + EMA trend gates (combine with chart pattern) ----------
    let rsiOk = null;
    let emaOk = null;
    try {
      const rsi = rsiDivergenceForDirection(patternCandles, direction, cfg.rsiPeriod ?? 14);
      rsiOk = !!rsi.ok;
      if (!rsi.ok) {
        const why = `RSI div: ${rsi.detail}`;
        if (isHard(cfg, 'rsiDiv')) {
          rejected.push({ pattern: pattern.patternType, reason: why });
          continue;
        }
        softFails.push(why); // soft gate → score penalty only
      }
    } catch (_) {
      rsiOk = null;
      if (isHard(cfg, 'rsiDiv')) {
        rejected.push({ pattern: pattern.patternType, reason: 'RSI divergence could not be evaluated' });
        continue;
      }
    }
    try {
      const ema = checkEmaAlignment(patternCandles, direction, {
        fast: cfg.emaFast ?? 21,
        slow: cfg.emaSlow ?? 50,
      });
      emaOk = !!ema.aligned;
      if (!ema.aligned) {
        const why = `EMA: ${ema.reason}`;
        if (isHard(cfg, 'ema')) {
          rejected.push({ pattern: pattern.patternType, reason: why });
          continue;
        }
        softFails.push(why); // soft gate → score penalty only
      }
    } catch (_) {
      emaOk = null;
      if (isHard(cfg, 'ema')) {
        rejected.push({ pattern: pattern.patternType, reason: 'EMA alignment could not be evaluated' });
        continue;
      }
    }

    const { score: rawBaseScore, conf } = scoreChartPatternSetup({
      pattern,
      breakout: br,
      htfAligned,
      confluence: cf,
      cfg,
    });
    if (rsiOk) conf.push('RSI bullish/bearish divergence confirms direction');
    if (emaOk) conf.push('EMA21/50 trend aligns with direction');
    // SOFT gates that failed so far cost points instead of rejecting
    let baseScore = Math.max(0, rawBaseScore - SOFT_PENALTY * softFails.length);
    if (softFails.length) conf.push(...softFails.map((w) => `⚠ soft: ${w}`));
    if (baseScore < (cfg.minSignalScore ?? 70)) {
      rejected.push({ pattern: pattern.patternType, reason: `Score ${baseScore} < min ${cfg.minSignalScore}`, score: baseScore });
      continue;
    }

    // ---------- Universal Pattern + Confluence + Elliott Wave layer ----------
    // Runs after existing gates so we never break the original path.
    // When enabled, further filters weak mid-range / unconfirmed / ambiguous setups.
    let universal = null;
    let score = baseScore;
    if (cfg.universalEngineEnabled !== false) {
      try {
        universal = evaluateUniversalSetup({
          symbol,
          pattern,
          breakout: br,
          candles: patternCandles,
          htfCandles,
          direction,
          price,
          atr: A,
          cfg,
        });
        if (universal?.softFails?.length) {
          softFails.push(...universal.softFails);
          conf.push(...universal.softFails.map((w) => `⚠ soft: ${w}`));
        }
        // Blend: keep original score dominant, but allow universal finalScore to gate
        // Hard-gate failures from universal always reject (wave / location / midRange / …)
        if (universal && Array.isArray(universal.whyRejected) && universal.whyRejected.length) {
          rejected.push({
            pattern: pattern.patternType,
            reason: `Universal filter: ${universal.reject || universal.whyRejected.join('; ')}`,
            score: baseScore,
            universalScore: universal.finalScore,
            whyRejected: universal.whyRejected,
          });
          continue;
        }
        if (universal && !universal.ok) {
          rejected.push({
            pattern: pattern.patternType,
            reason: `Universal filter: ${universal.reject || 'below min final score'}`,
            score: baseScore,
            universalScore: universal.finalScore,
            whyRejected: universal.whyRejected,
          });
          continue;
        }
        if (universal?.finalScore) {
          // Soft blend: 70% original + 30% universal
          score = Math.round(baseScore * 0.7 + universal.finalScore * 0.3);
          if (universal.whyAccepted?.length) conf.push(...universal.whyAccepted.map((w) => `U: ${w}`));
        }
        // Re-apply admin min score AFTER blend so a 70 setting cannot pass a 50 blended score
        const minScore = cfg.minSignalScore ?? cfg.minFinalScore ?? 70;
        if (score < minScore) {
          rejected.push({
            pattern: pattern.patternType,
            reason: `Score ${score} < min ${minScore} (after confluence blend)`,
            score,
          });
          continue;
        }
      } catch (e) {
        // Hard Elliott gate must never be bypassed by an engine error (fail closed)
        if (isHard(cfg, 'wave')) {
          rejected.push({
            pattern: pattern.patternType,
            reason: `Elliott hard gate could not be evaluated (${e.message})`,
            score: baseScore,
          });
          continue;
        }
        universal = null;
      }
    }

    const gates = buildGateChecklist({
      cfg, universal, htfAligned, htfStruct, rr, rrMeasured, pillars, cf, br,
      rsiOk, emaOk,
    });
    const patternGeom = buildPatternGeom(pattern, br, patternCandles, {
      elliott: typeof universal !== 'undefined' ? universal?.elliott : null,
      tf: cfg.patternTf, htf: cfg.htf, tp2, tp3, cf, gates, uni: universal,
    });

    setups.push({
      strategy: 'chart_pattern',
      pattern: pattern.patternType,
      symbol,
      dir: direction,
      direction,
      score,
      qualifies: true,
      conf,
      entry,
      sl,
      tp1,
      tp2,
      tp3,
      rr: rr.toFixed(1),
      price,
      ob: {
        low: pattern.support,
        high: pattern.resistance,
        mid: ((pattern.support || 0) + (pattern.resistance || 0)) / 2,
        time: patternCandles[pattern.endIndex]?.time || patternCandles[patternCandles.length - 1]?.time,
        strength: pattern.confidence,
        type: direction === 'LONG' ? 'bullish' : 'bearish',
        status: 'ACTIVE',
        displacement: 0,
      },
      quality: {
        htfAligned,
        hasLiqEdge: cf.smcOk,
        hasSweep: !!cf.smc.sweep,
        hasFvg: !!cf.smc.fvg,
        displacement: false,
        breakoutConfirmed: true,
        pattern: pattern.patternType,
        // Universal engine extras (backward-compatible)
        setupType: universal?.setupType || null,
        locationScore: universal?.locationScore ?? null,
        rejectionScore: universal?.rejectionScore ?? null,
        waveScore: universal?.waveScore ?? null,
        structureScore: universal?.structureScore ?? null,
      },
      metadata: {
        strategy: 'chart_pattern',
        pattern: pattern.patternType,
        patternType: pattern.patternType,
        breakoutLevel: br.level,
        breakoutCandleTime: br.breakoutCandle?.time ?? null,
        breakoutConfirmed: true,
        rvol: br.rvol,
        rrMeasured: +rrMeasured.toFixed(2),
        patternTf: cfg.patternTf,
        htf: cfg.htf,
        obTf: cfg.patternTf,
        patternGeom,
        fibLevel: cf.fib.level ?? null,
        confluencePillars: pillars,
        blockers: cf.smc.blocked,
        htfBias: htfStruct.bias,
        smcConfirmation: cf.smcOk,
        // Universal engine detail for dashboard / Telegram
        universal: universal
          ? {
              setupType: universal.setupType,
              finalScore: universal.finalScore,
              patternScore: universal.patternScore,
              locationScore: universal.locationScore,
              liquidityScore: universal.liquidityScore,
              rejectionScore: universal.rejectionScore,
              structureScore: universal.structureScore,
              waveScore: universal.waveScore,
              momentumScore: universal.momentumScore,
              riskScore: universal.riskScore,
              pathScore: universal.pathScore,
              whyAccepted: universal.whyAccepted,
              whyRejected: universal.whyRejected,
              events: universal.events,
              elliott: universal.elliott
                ? {
                    context: universal.elliott.context,
                    waveScore: universal.elliott.waveScore,
                    primary: universal.elliott.primary
                      ? {
                          type: universal.elliott.primary.type,
                          direction: universal.elliott.primary.direction,
                          currentWave: universal.elliott.primary.currentWave,
                          confidence: universal.elliott.primary.confidence,
                          invalidation: universal.elliott.primary.invalidation,
                          pivots: (universal.elliott.primary.pivots || []).map((p) => ({
                            label: p.label,
                            price: p.price,
                            i: p.i,
                          })),
                        }
                      : null,
                    alternative: universal.elliott.alternative
                      ? {
                          type: universal.elliott.alternative.type,
                          direction: universal.elliott.alternative.direction,
                          currentWave: universal.elliott.alternative.currentWave,
                          confidence: universal.elliott.alternative.confidence,
                        }
                      : null,
                  }
                : null,
              cluster: universal.cluster
                ? {
                    label: universal.cluster.label,
                    high: universal.cluster.high,
                    low: universal.cluster.low,
                    midpoint: universal.cluster.midpoint,
                    strength: universal.cluster.strength,
                    sources: universal.cluster.sources,
                    sourceCount: universal.cluster.sourceCount,
                  }
                : null,
            }
          : null,
        patternHeight: pattern.patternHeight,
        touches: pattern.touches,
        conf,
      },
      structure: htfStruct,
      fvgs: [],
      liq: {},
      pd: {},
      rvol: br.rvol,
    });
  }

  // best setup only per symbol to avoid spam
  setups.sort((a, b) => b.score - a.score);
  near.sort((a, b) => b.score - a.score);
  return { setups: setups.slice(0, 2), near: near.slice(0, 2), rejected: rejected.slice(0, 12) };
}

export { CHART_PATTERN_CONFIG };
