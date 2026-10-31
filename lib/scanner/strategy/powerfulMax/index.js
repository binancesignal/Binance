/**
 * POWERFUL MAX — multi-timeframe crypto confluence strategy
 *
 * Hard gates (structure must be valid):
 *   A. HTF context not strongly opposed
 *   B. Key location (HTF zone and/or Fib OTE)
 *   C. Valid Elliott primary count
 *   D. 15m CHoCH/BOS confirmation
 *   E. Valid risk / RR
 *
 * Soft confluence (score only — never mandatory alone):
 *   liquidity sweep, OB, FVG, Fib, volume, RSI divergence,
 *   harmonic, classic chart pattern
 *
 * Score 0–100 → REJECT / WATCHING / READY quality tiers
 */
import {
  calcATR,
  calcEMA,
  calcRSI,
  findSwings,
  relativeVolume,
  rsiDivergenceForDirection,
  fibConfluence,
  detectChartPatterns,
} from '../../indicators.js';
import { detectFVGs } from '../../fvg.js';
import { detectOrderBlocks } from '../../orderBlocks.js';
import { detectStructure } from '../../structure.js';
import { detectLiquidity } from '../../liquidity.js';
import { analyseElliottWave, elliottConfluence } from '../../engines/elliottWave.js';

const valid = (xs = []) =>
  (xs || []).filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(+v)));

const nearPct = (price, level, pct) => level > 0 && Math.abs(price - level) / level <= pct;

const MOTIVE = new Set(['IMPULSE', 'IMPULSE_PARTIAL', 'ENDING_DIAGONAL', 'LEADING_DIAGONAL']);
const CORRECTIVE = new Set(['CORRECTION', 'FLAT', 'DOUBLE_ZIGZAG', 'TRIANGLE']);

export const POWERFUL_MAX_DEFAULTS = {
  minScore: 75,
  watchingMin: 50,
  readyMin: 75,
  powerfulMin: 85,
  zonePct: 0.012,
  minRr: 1.4,
  minRiskAtr: 0.4,
  elliottMinConfidence: 48,
  requireElliott: true,
  requireLtfStructure: true,
  requireKeyLocation: true,
};

export function normalizePowerfulMaxConfig(raw = {}) {
  const d = POWERFUL_MAX_DEFAULTS;
  const n = (k, fb) => (Number.isFinite(+raw[k]) ? +raw[k] : fb);
  const b = (k, fb) => (raw[k] === true || raw[k] === false ? raw[k] : fb);
  return {
    minScore: n('minScore', d.minScore),
    watchingMin: n('watchingMin', d.watchingMin),
    readyMin: n('readyMin', d.readyMin),
    powerfulMin: n('powerfulMin', d.powerfulMin),
    zonePct: n('zonePct', d.zonePct),
    minRr: n('minRr', d.minRr),
    minRiskAtr: n('minRiskAtr', d.minRiskAtr),
    elliottMinConfidence: n('elliottMinConfidence', d.elliottMinConfidence),
    requireElliott: b('requireElliott', d.requireElliott),
    requireLtfStructure: b('requireLtfStructure', d.requireLtfStructure),
    requireKeyLocation: b('requireKeyLocation', d.requireKeyLocation),
  };
}

function keyLevels(h4, d1, h1) {
  const out = [];
  const add = (name, v, tf) => {
    if (Number.isFinite(+v) && +v > 0) out.push({ name, price: +v, tf });
  };
  const d = d1.slice(-40, -1);
  const h = h4.slice(-50, -1);
  const i1 = (h1 || []).slice(-60, -1);
  if (d.length) {
    add('Previous Day High', d.at(-1)?.high, '1D');
    add('Previous Day Low', d.at(-1)?.low, '1D');
    add('30D High', Math.max(...d.map((x) => +x.high)), '1D');
    add('30D Low', Math.min(...d.map((x) => +x.low)), '1D');
  }
  if (h.length) {
    add('4H Swing High', Math.max(...h.slice(-20).map((x) => +x.high)), '4H');
    add('4H Swing Low', Math.min(...h.slice(-20).map((x) => +x.low)), '4H');
  }
  if (i1.length) {
    add('1H Swing High', Math.max(...i1.slice(-24).map((x) => +x.high)), '1H');
    add('1H Swing Low', Math.min(...i1.slice(-24).map((x) => +x.low)), '1H');
  }
  return out;
}

function htfContext(h4s, d1s, h1s) {
  const scoreSide = (s) => {
    if (!s) return 0;
    if (s.bias === 'bullish' || s.bos === 'bullish') return 1;
    if (s.bias === 'bearish' || s.bos === 'bearish') return -1;
    return 0;
  };
  const v = scoreSide(d1s) * 2 + scoreSide(h4s) * 2 + scoreSide(h1s);
  if (v >= 3) return { bias: 'bullish', strength: 'strong', raw: v };
  if (v >= 1) return { bias: 'bullish', strength: 'moderate', raw: v };
  if (v <= -3) return { bias: 'bearish', strength: 'strong', raw: v };
  if (v <= -1) return { bias: 'bearish', strength: 'moderate', raw: v };
  return { bias: 'neutral', strength: 'ranging', raw: v };
}

/** 15m sweep + BOS/CHoCH sequence */
function ltfSequence(c, dir, atr) {
  const swings = findSwings(c, 2, 2);
  const bull = dir === 'LONG';
  const sweepType = bull ? 'L' : 'H';
  const breakType = bull ? 'H' : 'L';
  const piv = swings.filter((s) => s.type === sweepType && s.i < c.length - 3).slice(-12).reverse();
  for (const p of piv) {
    for (let i = Math.max(p.i + 2, c.length - 40); i < c.length - 2; i++) {
      const x = c[i];
      const swept = bull
        ? x.low < p.price - atr * 0.02 && x.close > p.price
        : x.high > p.price + atr * 0.02 && x.close < p.price;
      if (!swept) continue;
      const opp = swings.filter((s) => s.type === breakType && s.i > i && s.i < c.length - 1).slice(0, 5);
      for (const q of opp) {
        for (let j = q.i + 1; j < c.length; j++) {
          const y = c[j];
          const body = Math.abs(y.close - y.open);
          const broke = bull ? y.close > q.price + atr * 0.012 : y.close < q.price - atr * 0.012;
          if (broke && body >= atr * 0.15) {
            return {
              sweep: { index: i, level: p.price, extreme: bull ? x.low : x.high, time: x.time },
              bos: { index: j, level: q.price, time: y.time },
              hasSweep: true,
            };
          }
        }
      }
    }
  }
  // Fallback: pure BOS without explicit sweep (softer — scored lower later)
  const lastSwings = swings.slice(-8);
  for (let k = lastSwings.length - 1; k >= 1; k--) {
    const q = lastSwings[k];
    if (q.type !== breakType) continue;
    for (let j = q.i + 1; j < c.length; j++) {
      const y = c[j];
      const broke = bull ? y.close > q.price + atr * 0.015 : y.close < q.price - atr * 0.015;
      if (broke) {
        return {
          sweep: null,
          bos: { index: j, level: q.price, time: y.time },
          hasSweep: false,
        };
      }
    }
  }
  return null;
}

function pickOb(c, seq, dir, atr) {
  const bull = dir === 'LONG';
  const from = seq.bos ? Math.max(0, seq.bos.index - 10) : Math.max(0, c.length - 20);
  const to = seq.bos ? seq.bos.index : c.length - 1;
  let best = null;
  for (let i = to - 1; i >= from; i--) {
    const x = c[i];
    const opp = bull ? x.close < x.open : x.close > x.open;
    if (!opp) continue;
    const body = Math.abs(x.close - x.open);
    if (body < atr * 0.12) continue;
    const ob = bull
      ? { low: x.low, high: Math.max(x.open, x.close) }
      : { low: Math.min(x.open, x.close), high: x.high };
    best = {
      ...ob,
      mid: (ob.low + ob.high) / 2,
      index: i,
      time: x.time,
      type: bull ? 'bullish' : 'bearish',
      status: 'FRESH',
    };
    break;
  }
  return best;
}

function ewAllows(pc, dir) {
  if (!pc) return { ok: false, reason: 'No Elliott count', mode: null, points: 0 };
  const long = dir === 'LONG';
  const waveBull = pc.direction === 'bullish';
  const w = pc.currentWave;
  const type = pc.type;
  const conf = Number(pc.confidence) || 0;

  if (MOTIVE.has(type) && w === 5 && waveBull === long) {
    return { ok: false, reason: 'Wave 5 exhaustion same direction', mode: null, points: 0 };
  }
  if (MOTIVE.has(type)) {
    if (waveBull === long && (w === 2 || w === 3 || w === 4 || type === 'IMPULSE_PARTIAL')) {
      return { ok: true, reason: `Motive continuation W${w}`, mode: 'continuation', points: 12 + Math.min(3, Math.floor(conf / 30)) };
    }
    if (w === 5 && waveBull !== long) {
      return { ok: true, reason: 'Wave 5 exhaustion reversal', mode: 'reversal', points: 14 };
    }
    return { ok: false, reason: `Motive misaligned (${type} ${pc.direction} W${w})`, mode: null, points: 0 };
  }
  if (CORRECTIVE.has(type)) {
    const done =
      (type === 'TRIANGLE' && w === 'E') ||
      (type === 'DOUBLE_ZIGZAG' && w === 'Y') ||
      ((type === 'CORRECTION' || type === 'FLAT') && w === 'C');
    if (done && waveBull !== long) {
      return { ok: true, reason: `Corrective complete (${type} ${w}) → reversal`, mode: 'reversal', points: 13 };
    }
    if (!done && waveBull === long) {
      return { ok: true, reason: `Corrective developing with trade`, mode: 'continuation', points: 6 };
    }
    return { ok: false, reason: `Corrective not aligned (${type} ${w})`, mode: null, points: 0 };
  }
  return { ok: false, reason: `Unsupported EW ${type}`, mode: null, points: 0 };
}

function qualityTier(score, cfg) {
  if (score >= cfg.powerfulMin) return 'POWERFUL_MAX';
  if (score >= cfg.readyMin) return 'STRONG';
  if (score >= 65) return 'MODERATE';
  if (score >= cfg.watchingMin) return 'WATCHING';
  return 'REJECT';
}

/**
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {array} opts.setupCandles 15m
 * @param {array} opts.h1Candles
 * @param {array} opts.h4Candles
 * @param {array} opts.d1Candles
 * @param {number} opts.price
 * @param {object} opts.cfg
 */
export function runPowerfulMaxStrategy({
  symbol,
  setupCandles,
  h1Candles = [],
  h4Candles = [],
  d1Candles = [],
  price,
  cfg: rawCfg = {},
} = {}) {
  const cfg = normalizePowerfulMaxConfig(rawCfg);
  const c = valid(setupCandles);
  const h1 = valid(h1Candles);
  const h4 = valid(h4Candles);
  const d1 = valid(d1Candles);
  const current = Number.isFinite(+price) ? +price : c.at(-1)?.close;
  if (c.length < 80 || h4.length < 30 || d1.length < 20 || !(current > 0)) return [];

  const atr = calcATR(c, 14);
  if (!(atr > 0)) return [];

  const h4s = detectStructure(h4);
  const d1s = detectStructure(d1);
  const h1s = h1.length >= 30 ? detectStructure(h1) : { bias: 'neutral', bos: null };
  const ctx = htfContext(h4s, d1s, h1s);
  const levels = keyLevels(h4, d1, h1);
  const rvol = relativeVolume(c);
  const ema21 = calcEMA(c, 21);
  const ema50 = calcEMA(c, 50);
  const rsi = calcRSI(c, 14);
  const swings15 = findSwings(c, 3, 3);
  const liq = detectLiquidity(c, swings15);
  const allObs = detectOrderBlocks(c, 90);
  const allFvgs = detectFVGs(c);

  let ewResult = null;
  try {
    ewResult = analyseElliottWave(c, {
      zigzag: true,
      minConfidence: cfg.elliottMinConfidence,
      minLegAtr: 0.85,
    });
  } catch (_) {
    ewResult = null;
  }

  const out = [];

  for (const dir of ['LONG', 'SHORT']) {
    const bull = dir === 'LONG';

    // ── Hard A: HTF not strongly opposed ───────────────────────────
    if (ctx.strength === 'strong' && ctx.bias === (bull ? 'bearish' : 'bullish')) continue;
    // moderate opposition allowed only with strong reversal EW later

    // ── Hard D: LTF structure ──────────────────────────────────────
    const seq = ltfSequence(c, dir, atr);
    if (cfg.requireLtfStructure && !seq?.bos) continue;
    if (!seq?.bos) continue;

    const ob = pickOb(c, seq, dir, atr);
    if (!ob || ob.type !== (bull ? 'bullish' : 'bearish')) continue;

    // ── Hard E: risk geometry ──────────────────────────────────────
    const buffer = Math.max(atr * 0.35, current * 0.001);
    const sl = bull
      ? Math.min(ob.low, seq.sweep?.extreme ?? ob.low) - buffer
      : Math.max(ob.high, seq.sweep?.extreme ?? ob.high) + buffer;
    const entry = ob.mid;
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) continue;
    if (risk < atr * cfg.minRiskAtr || risk / current < 0.004) continue;

    const rr = cfg.minRr;
    const tp1 = entry + (bull ? 1 : -1) * risk * rr;
    const tp2 = entry + (bull ? 1 : -1) * risk * (rr + 1);
    const tp3 = entry + (bull ? 1 : -1) * risk * (rr + 2);
    if ((bull && (current <= sl || current >= tp1)) || (!bull && (current >= sl || current <= tp1))) continue;

    // ── Hard B: key location ───────────────────────────────────────
    const key =
      levels
        .filter((l) => nearPct(ob.mid, l.price, cfg.zonePct))
        .sort((a, b) => Math.abs(a.price - ob.mid) - Math.abs(b.price - ob.mid))[0] || null;

    const anchor = seq.sweep?.extreme ?? (bull ? ob.low : ob.high);
    const impulse = c[seq.bos.index]?.close;
    const range = Math.abs((impulse || entry) - anchor) || atr * 2;
    const fib618 = bull ? impulse - range * 0.618 : impulse + range * 0.618;
    const fib786 = bull ? impulse - range * 0.786 : impulse + range * 0.786;
    const fibLow = Math.min(fib618, fib786);
    const fibHigh = Math.max(fib618, fib786);
    const fibHit = ob.high >= fibLow - atr * 0.2 && ob.low <= fibHigh + atr * 0.2;

    const fibExtra = fibConfluence(c, swings15, entry, dir) || {};
    const fibOk = fibHit || !!fibExtra.hit;

    if (cfg.requireKeyLocation && !key && !fibOk) continue;

    // ── Hard C: Elliott ────────────────────────────────────────────
    const pc = ewResult?.primaryCount || null;
    if (cfg.requireElliott && !pc) continue;
    const ewGate = ewAllows(pc, dir);
    if (cfg.requireElliott && !ewGate.ok) continue;

    // Moderate HTF opposition only allowed on EW reversal
    if (
      ctx.strength === 'moderate' &&
      ctx.bias === (bull ? 'bearish' : 'bullish') &&
      ewGate.mode !== 'reversal'
    ) {
      continue;
    }

    // ── Soft scoring (normalize ~0–100) ────────────────────────────
    // Core structure max ~50
    let score = 0;
    const conf = [];
    const missing = [];

    // HTF context 0–10
    if (ctx.bias === (bull ? 'bullish' : 'bearish')) {
      score += ctx.strength === 'strong' ? 10 : 7;
      conf.push(`HTF ${ctx.bias} (${ctx.strength})`);
    } else if (ctx.bias === 'neutral') {
      score += 4;
      conf.push('HTF neutral / ranging');
    } else {
      score += ewGate.mode === 'reversal' ? 3 : 0;
      conf.push('HTF opposed — reversal path');
    }

    // Key zone 0–10
    if (key) {
      score += 10;
      conf.push(`${key.tf} key zone: ${key.name}`);
    } else {
      score += fibOk ? 4 : 0;
      missing.push('HTF key zone');
    }

    // Elliott 0–15
    if (pc && ewGate.ok) {
      score += Math.min(15, ewGate.points);
      conf.push(`EW ${ewGate.reason}`);
    } else {
      missing.push('Clear Elliott structure');
    }

    // 15m structure 0–15
    if (seq.hasSweep && seq.bos) {
      score += 15;
      conf.push('15m liquidity sweep + BOS/CHoCH');
    } else if (seq.bos) {
      score += 10;
      conf.push('15m BOS/CHoCH (no sweep)');
      missing.push('Liquidity sweep');
    }

    // Soft: liquidity detail 0–10
    let liqPts = 0;
    if (seq.hasSweep) liqPts += 6;
    if (bull && (liq?.equalLows?.length || 0) > 0) liqPts += 2;
    if (!bull && (liq?.equalHighs?.length || 0) > 0) liqPts += 2;
    if (liqPts > 0) {
      score += Math.min(10, liqPts);
      if (seq.hasSweep) conf.push('Liquidity pool engagement');
    } else missing.push('Liquidity sweep');

    // Soft: OB 0–8 (fresh aligned already required for geometry)
    score += 6;
    conf.push(`${ob.type} order block`);
    const htfObBonus = allObs.some(
      (o) =>
        o.type === ob.type &&
        Math.abs(((o.high + o.low) / 2) - ob.mid) / ob.mid < 0.01
    );
    if (htfObBonus) score += 2;

    // Soft: FVG 0–7
    const fvg = allFvgs
      .filter(
        (f) =>
          f.type === (bull ? 'bullish' : 'bearish') &&
          f.status !== 'FILLED' &&
          f.index >= (seq.sweep?.index ?? seq.bos.index - 8)
      )
      .sort((a, b) => b.index - a.index)[0];
    if (fvg) {
      score += fvg.status === 'OPEN' ? 7 : 4;
      conf.push(`${fvg.type} FVG (${fvg.status})`);
    } else missing.push('FVG');

    // Soft: Fib 0–8
    if (fibOk) {
      score += 8;
      conf.push('Fib 0.618–0.786 / confluence');
    } else missing.push('Fib OTE');

    // Soft: volume/momentum 0–6
    let volPts = 0;
    if (rvol >= 1.2) volPts += 4;
    else if (rvol >= 0.95) volPts += 2;
    const lastEma21 = Array.isArray(ema21) ? ema21[ema21.length - 1] : ema21;
    const lastEma50 = Array.isArray(ema50) ? ema50[ema50.length - 1] : ema50;
    const emaAligned =
      Number.isFinite(+lastEma21) &&
      Number.isFinite(+lastEma50) &&
      (bull ? +lastEma21 >= +lastEma50 : +lastEma21 <= +lastEma50);
    if (emaAligned) volPts += 2;
    score += Math.min(6, volPts);
    if (volPts >= 2) conf.push(`Volume/momentum rvol ${rvol.toFixed(2)}x`);
    else missing.push('Volume expansion');

    // Soft: divergence 0–3
    const rsiDiv = rsiDivergenceForDirection(c, dir) || { ok: false };
    if (rsiDiv.ok) {
      score += 3;
      conf.push(rsiDiv.detail || 'RSI divergence');
    } else missing.push('RSI divergence');

    // Soft: chart pattern 0–4
    try {
      const pats = detectChartPatterns(swings15, dir) || [];
      if (pats.length) {
        score += 4;
        conf.push(`Chart pattern: ${pats[0].type || pats[0]}`);
      } else missing.push('Chart pattern');
    } catch (_) {
      missing.push('Chart pattern');
    }

    // Soft: harmonic 0–4 (lightweight — skip heavy engine if not needed)
    // Reserved: pattern detector may be expensive; leave as missing unless simple XABCD later
    missing.push('Harmonic confirmation');

    score = Math.max(0, Math.min(100, Math.round(score)));
    const tier = qualityTier(score, cfg);
    if (score < cfg.watchingMin) continue;

    // READY-class signals for scanner publish
    const qualifies = score >= cfg.minScore;
    if (!qualifies && score < cfg.readyMin) {
      // still can emit watching-only if above watchingMin — scanner may filter
    }

    const bosAge = c.length - 1 - seq.bos.index;
    if (bosAge > 14) continue;

    const invalidation =
      Number.isFinite(+pc?.invalidation) ? +pc.invalidation : sl;

    const explanation = [
      `POWERFUL MAX — ${dir}`,
      `Elliott: ${ewGate.reason || 'n/a'}`,
      `HTF: ${ctx.bias} (${ctx.strength})`,
      `Structure: 15m ${seq.hasSweep ? 'sweep + ' : ''}BOS/CHoCH`,
      `Confluence: ${conf.slice(0, 8).join(' · ')}`,
      `Score: ${score}/100 (${tier})`,
      `Entry: ${entry}`,
      `SL: ${sl}`,
      `TP1: ${tp1} · TP2: ${tp2} · TP3: ${tp3}`,
      `Missing: ${missing.slice(0, 6).join(', ') || 'none'}`,
    ].join('\n');

    const ewMeta = pc
      ? {
          enabled: true,
          hard: true,
          label: ewResult?.context?.label || null,
          direction: pc.direction,
          type: pc.type,
          currentWave: pc.currentWave,
          confidence: pc.confidence,
          mode: ewGate.mode,
          gateReason: ewGate.reason,
          invalidation: Number.isFinite(+pc.invalidation) ? +pc.invalidation : null,
          pivots: (pc.pivots || []).map((pv) => ({
            label: pv.label,
            price: pv.price,
            time: pv.time ?? null,
            i: pv.i,
          })),
        }
      : { enabled: false };

    out.push({
      symbol,
      dir,
      strategy: 'powerful_max',
      score,
      qualifies: score >= cfg.minScore,
      conf,
      ob,
      fvgs: fvg ? [fvg] : [],
      entry,
      sl,
      tp1,
      tp2,
      tp3,
      rr: String(rr),
      price: current,
      rvol,
      atr,
      quality: {
        htfAligned: ctx.bias === (bull ? 'bullish' : 'bearish'),
        htfNeutral: ctx.bias === 'neutral',
        hasLiqEdge: !!seq.hasSweep,
        hasSweep: !!seq.hasSweep,
        hasFvg: !!fvg,
        displacement: true,
        fibOte: fibOk,
        strongSetup: score >= cfg.readyMin,
        emaAligned,
        tier,
        ewHard: true,
        ewMode: ewGate.mode,
      },
      metadata: {
        strategy: 'powerful_max',
        patternTf: '15m',
        htf: '1D/4H/1H',
        conf,
        missing,
        explanation,
        tier,
        ob,
        fvgs: fvg ? [fvg] : [],
        rvol,
        powerfulMax: {
          sequence:
            '1D/4H context → Elliott → HTF key zone → 1H refine → OB/FVG/Fib/Liq → 15m BOS → score',
          htf: ctx,
          keyZone: key,
          fib: { low: fibLow, high: fibHigh, hit: fibOk },
          h4Bias: h4s.bias,
          d1Bias: d1s.bias,
          h1Bias: h1s.bias,
          bosAgeCandles: bosAge,
          sweep: seq.sweep,
          bos: seq.bos,
          elliott: ewMeta,
          invalidation,
          minScore: cfg.minScore,
          watchingMin: cfg.watchingMin,
          readyMin: cfg.readyMin,
          powerfulMin: cfg.powerfulMin,
        },
        // chart helpers (reuse crypto confluence chart paths)
        cryptoConfluence: {
          keyZone: key,
          fib: { low: fibLow, high: fibHigh, hit: fibOk },
          sweep: seq.sweep,
          bos: seq.bos,
          elliott: ewMeta,
          h4Bias: h4s.bias,
          d1Bias: d1s.bias,
        },
      },
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

export default runPowerfulMaxStrategy;
