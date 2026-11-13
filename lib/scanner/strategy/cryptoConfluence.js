/**
 * Crypto Power Confluence strategy.
 *
 * Core sequence (unchanged):
 *   4H/1D key zone → liquidity sweep → OB/FVG → Fib → volume → 15m CHoCH/BOS → ENTRY
 *
 * Elliott Wave (when enabled / forced):
 *   - Hard gate: primary count required
 *   - Direction table (motive continuation vs corrective reversal)
 *   - Wave-5 same-direction → reject (exhaustion)
 *   - No-chase after C/Y/E: entry must be near extreme or pullback into OB
 *   - OB side must agree with trade direction
 *   - OB mitigation direction: SHORT from below into bearish OB; LONG from above into bullish OB
 */
import { calcATR, calcEMA, calcRSI, findSwings, relativeVolume, rsiDivergenceForDirection } from '../indicators.js';
import { detectFVGs } from '../fvg.js';
import { detectStructure } from '../structure.js';
import { analyseElliottWave, elliottConfluence } from '../engines/elliottWave.js';

const valid = (xs = []) => xs.filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(+v)));
const near = (price, level, pct) => level > 0 && Math.abs(price - level) / level <= pct;

const MOTIVE = new Set(['IMPULSE', 'IMPULSE_PARTIAL', 'ENDING_DIAGONAL', 'LEADING_DIAGONAL']);
const CORRECTIVE = new Set(['CORRECTION', 'FLAT', 'DOUBLE_ZIGZAG', 'TRIANGLE']);

function keyLevels(h4, d1) {
  const out = [];
  const add = (name, v, tf) => {
    if (Number.isFinite(+v) && +v > 0) out.push({ name, price: +v, tf });
  };
  const d = d1.slice(-31, -1);
  const h = h4.slice(-43, -1);
  if (d.length) {
    add('Previous Day High', d.at(-1)?.high, '1D');
    add('Previous Day Low', d.at(-1)?.low, '1D');
    add('30D High', Math.max(...d.map((x) => +x.high)), '1D');
    add('30D Low', Math.min(...d.map((x) => +x.low)), '1D');
  }
  if (h.length) {
    add('4H Swing High', Math.max(...h.slice(-18).map((x) => +x.high)), '4H');
    add('4H Swing Low', Math.min(...h.slice(-18).map((x) => +x.low)), '4H');
  }
  return out;
}

function sequence(c, dir, atr) {
  const swings = findSwings(c, 2, 2);
  const bull = dir === 'LONG';
  const sweepType = bull ? 'L' : 'H';
  const breakType = bull ? 'H' : 'L';
  const piv = swings.filter((s) => s.type === sweepType && s.i < c.length - 3).slice(-10).reverse();
  for (const p of piv) {
    for (let i = Math.max(p.i + 3, c.length - 34); i < c.length - 2; i++) {
      const x = c[i];
      const swept = bull
        ? x.low < p.price - atr * 0.02 && x.close > p.price
        : x.high > p.price + atr * 0.02 && x.close < p.price;
      if (!swept) continue;
      const opp = swings.filter((s) => s.type === breakType && s.i > i && s.i < c.length - 1).slice(0, 4);
      for (const q of opp) {
        for (let j = q.i + 2; j < c.length; j++) {
          const y = c[j];
          const body = Math.abs(y.close - y.open);
          const broke = bull ? y.close > q.price + atr * 0.015 : y.close < q.price - atr * 0.015;
          if (broke && body >= atr * 0.18) {
            return {
              sweep: { index: i, level: p.price, extreme: bull ? x.low : x.high, time: x.time },
              bos: { index: j, level: q.price, time: y.time },
            };
          }
        }
      }
    }
  }
  return null;
}

function poi(c, seq, dir, atr) {
  const bull = dir === 'LONG';
  let ob = null;
  for (let i = seq.bos.index - 1; i >= Math.max(seq.sweep.index, seq.bos.index - 8); i--) {
    const x = c[i];
    const opp = bull ? x.close < x.open : x.close > x.open;
    if (!opp) continue;
    ob = bull
      ? { low: x.low, high: Math.max(x.open, x.close) }
      : { low: Math.min(x.open, x.close), high: x.high };
    ob = {
      ...ob,
      mid: (ob.low + ob.high) / 2,
      index: i,
      time: x.time,
      type: bull ? 'bullish' : 'bearish',
      status: 'FRESH',
    };
    break;
  }
  const fvg = detectFVGs(c)
    .filter(
      (f) =>
        f.type === (bull ? 'bullish' : 'bearish') &&
        f.index >= seq.sweep.index &&
        f.index <= seq.bos.index + 2
    )
    .sort((a, b) => b.index - a.index)[0] || null;
  return { ob, fvg };
}

/**
 * EW direction gate.
 * Returns { ok, reason, mode: 'continuation'|'reversal'|null }
 */
function ewDirectionGate(pc, dir) {
  if (!pc) return { ok: false, reason: 'No EW count', mode: null };
  const long = dir === 'LONG';
  const waveBull = pc.direction === 'bullish';
  const w = pc.currentWave;
  const type = pc.type;

  // Wave 5 exhaustion in same direction as trade → reject
  if (MOTIVE.has(type) && w === 5 && waveBull === long) {
    return { ok: false, reason: 'Wave 5 exhaustion (same direction)', mode: null };
  }

  // Motive continuation: trade with impulse, waves 2/3/4 (or partial)
  if (MOTIVE.has(type)) {
    if (waveBull === long && (w === 2 || w === 3 || w === 4 || type === 'IMPULSE_PARTIAL')) {
      return { ok: true, reason: `Motive continuation W${w}`, mode: 'continuation' };
    }
    // Wave 5 opposite = reversal short/long against completed impulse
    if (w === 5 && waveBull !== long) {
      return { ok: true, reason: 'Wave 5 exhaustion reversal', mode: 'reversal' };
    }
    return { ok: false, reason: `Motive not aligned (${type} ${pc.direction} W${w})`, mode: null };
  }

  // Corrective complete → trade opposite to correction direction (reversal)
  if (CORRECTIVE.has(type)) {
    const done =
      (type === 'TRIANGLE' && w === 'E') ||
      (type === 'DOUBLE_ZIGZAG' && w === 'Y') ||
      ((type === 'CORRECTION' || type === 'FLAT') && w === 'C');
    if (!done) {
      return { ok: false, reason: `Corrective incomplete (${type} ${w})`, mode: null };
    }
    // After bearish ABC → long; after bullish ABC → short
    if (waveBull !== long) {
      return { ok: true, reason: `Corrective complete reversal (${type} ${w})`, mode: 'reversal' };
    }
    // Same direction as correction = continuation of larger trend only if we treat it as such —
    // require explicit continuation label; default reject to avoid the OABC+short conflict
    return { ok: false, reason: `Corrective complete but trade with correction (chase risk)`, mode: null };
  }

  return { ok: false, reason: `Unsupported EW type ${type}`, mode: null };
}

/**
 * No-chase rule after corrective C/Y/E or wave-5 reversal:
 * entry must be within maxAtr of the completion extreme, OR price still overlapping the OB.
 */
function noChaseOk(pc, mode, dir, entry, atr, ob, c) {
  if (mode !== 'reversal') return { ok: true, reason: null };
  const extreme = (() => {
    const piv = pc.pivots || [];
    if (!piv.length) return null;
    const last = piv[piv.length - 1];
    return Number.isFinite(+last.price) ? +last.price : null;
  })();
  if (extreme == null || !(atr > 0)) return { ok: true, reason: null };

  const dist = Math.abs(entry - extreme);
  const nearExtreme = dist <= atr * 1.0; // within 1 ATR of C/Y/E/W5 extreme

  // Pullback into OB still OK even if price ran
  const inOb =
    ob &&
    Number.isFinite(+ob.low) &&
    Number.isFinite(+ob.high) &&
    entry >= ob.low - atr * 0.15 &&
    entry <= ob.high + atr * 0.15;

  // Current price should not have already run > 1.5 ATR past extreme against the pullback
  const lastClose = c[c.length - 1]?.close;
  let ranAway = false;
  if (Number.isFinite(+lastClose) && extreme != null) {
    if (dir === 'LONG' && lastClose > extreme + atr * 1.5) ranAway = true;
    if (dir === 'SHORT' && lastClose < extreme - atr * 1.5) ranAway = true;
  }

  if (ranAway && !inOb) {
    return { ok: false, reason: 'Chase: price already extended past EW extreme' };
  }
  if (nearExtreme || inOb) {
    return { ok: true, reason: nearExtreme ? 'Entry near EW extreme' : 'Entry in OB pullback' };
  }
  return { ok: false, reason: 'Chase: entry too far from EW extreme / OB' };
}

/**
 * Shared runner.
 * @param {object} opts
 * @param {boolean} [opts.forceEw=false] — always require EW (crypto_confluence_ew)
 * @param {string}  [opts.strategyName='crypto_confluence']
 */

/**
 * Classic OB mitigation direction (ICT-style):
 *  SHORT / bearish OB: after displacement down, price must leave BELOW the OB,
 *    then return FROM BELOW back up into the zone (reject = sell).
 *  LONG  / bullish OB: after displacement up, price must leave ABOVE the OB,
 *    then return FROM ABOVE back down into the zone (reject = buy).
 *
 * Rejects "sell into OB while dumping through it from above" and the long mirror.
 */
function obMitigationOk(c, seq, ob, dir, atr, current) {
  if (!ob || !seq || !c?.length || !(atr > 0)) {
    return { ok: false, reason: 'OB mitigation: missing data' };
  }
  const bull = dir === 'LONG';
  const bosI = seq.bos.index;
  if (!(bosI >= 0 && bosI < c.length - 1)) {
    return { ok: false, reason: 'OB mitigation: bad BOS index' };
  }

  const pad = atr * 0.05;
  // 1) Price must leave the OB in the displacement direction after BOS
  let left = false;
  let leftIdx = null;
  for (let i = bosI; i < c.length; i++) {
    const x = c[i];
    if (bull) {
      // bullish OB: leave above
      if (x.low > ob.high + pad) {
        left = true;
        leftIdx = i;
        break;
      }
    } else {
      // bearish OB: leave below
      if (x.high < ob.low - pad) {
        left = true;
        leftIdx = i;
        break;
      }
    }
  }
  if (!left || leftIdx == null) {
    return {
      ok: false,
      reason: bull
        ? 'OB not left above after BOS (no bullish mitigation setup)'
        : 'OB not left below after BOS (no bearish mitigation setup)',
    };
  }

  // 2) After leaving, price must return into the OB from the correct side
  let returned = false;
  let returnIdx = null;
  for (let i = leftIdx + 1; i < c.length; i++) {
    const x = c[i];
    const touches =
      x.low <= ob.high + pad && x.high >= ob.low - pad;
    if (!touches) continue;
    if (bull) {
      // approach from above: prior swing / this candle came down into zone
      // require that since leave, we had a high above OB then dipped in
      const hadAbove = c.slice(leftIdx, i + 1).some((y) => y.high > ob.high - pad);
      if (hadAbove && x.low <= ob.high + pad) {
        returned = true;
        returnIdx = i;
        break;
      }
    } else {
      const hadBelow = c.slice(leftIdx, i + 1).some((y) => y.low < ob.low + pad);
      if (hadBelow && x.high >= ob.low - pad) {
        returned = true;
        returnIdx = i;
        break;
      }
    }
  }
  if (!returned) {
    return {
      ok: false,
      reason: bull
        ? 'No return into bullish OB from above'
        : 'No return into bearish OB from below',
    };
  }

  // 3) Current price still near the OB (not already blasted through the other side)
  const nearOb =
    current <= ob.high + atr * 0.6 && current >= ob.low - atr * 0.6;
  if (!nearOb) {
    return { ok: false, reason: 'Price too far from OB for mitigation entry' };
  }

  // 4) Wrong-side chase: shorting while still above OB and only falling through
  if (!bull && current > ob.high + atr * 0.15) {
    return { ok: false, reason: 'SHORT while still above bearish OB (not mitigation from below)' };
  }
  if (bull && current < ob.low - atr * 0.15) {
    return { ok: false, reason: 'LONG while still below bullish OB (not mitigation from above)' };
  }

  return {
    ok: true,
    reason: bull
      ? 'Bullish OB mitigation from above'
      : 'Bearish OB mitigation from below',
    leftIdx,
    returnIdx,
  };
}

export function runCryptoConfluenceStrategy({
  symbol,
  setupCandles,
  h4Candles,
  d1Candles,
  price,
  cfg = {},
  forceEw = false,
  strategyName = 'crypto_confluence',
} = {}) {
  const c = valid(setupCandles);
  const h4 = valid(h4Candles);
  const d1 = valid(d1Candles);
  const current = Number.isFinite(+price) ? +price : c.at(-1)?.close;
  if (c.length < 60 || h4.length < 30 || d1.length < 20 || !(current > 0)) return [];

  const atr = calcATR(c, 14);
  if (!(atr > 0)) return [];

  const levels = keyLevels(h4, d1);
  const h4s = detectStructure(h4);
  const d1s = detectStructure(d1);
  const rvol = relativeVolume(c);
  const ema21 = calcEMA(c, 21);
  const ema50 = calcEMA(c, 50);
  const rsi = calcRSI(c, 14);
  const minScore = Number.isFinite(+cfg.minScore) ? +cfg.minScore : 68;
  const zonePct = Number.isFinite(+cfg.zonePct) ? +cfg.zonePct : 0.012;

  // EW hard when toggle ON, or when this is the dedicated EW strategy
  const ewEnabled = forceEw || cfg.elliottConfluenceEnabled !== false;
  let ewResult = null;
  if (ewEnabled) {
    try {
      ewResult = analyseElliottWave(c, { zigzag: true, minConfidence: 48, minLegAtr: 0.85 });
    } catch (_) {
      ewResult = null;
    }
  }

  const out = [];
  for (const dir of ['LONG', 'SHORT']) {
    const bull = dir === 'LONG';
    const seq = sequence(c, dir, atr);
    if (!seq) continue;

    const { ob, fvg } = poi(c, seq, dir, atr);
    if (!ob) continue;

    // OB side must agree with trade direction
    if (ob.type !== (bull ? 'bullish' : 'bearish')) continue;

    // OB mitigation direction (ICT): short = touch from below; long = touch from above
    const mitig = obMitigationOk(c, seq, ob, dir, atr, current);
    if (!mitig.ok) continue;

    const anchor = seq.sweep.extreme;
    const impulse = c[seq.bos.index]?.close;
    if (!Number.isFinite(+impulse)) continue;

    const range = Math.abs(impulse - anchor);
    const fib618 = bull ? impulse - range * 0.618 : impulse + range * 0.618;
    const fib786 = bull ? impulse - range * 0.786 : impulse + range * 0.786;
    const fibLow = Math.min(fib618, fib786);
    const fibHigh = Math.max(fib618, fib786);
    const fibHit = ob.high >= fibLow - atr * 0.15 && ob.low <= fibHigh + atr * 0.15;

    const key =
      levels
        .filter((l) => near(ob.mid, l.price, zonePct))
        .sort((a, b) => Math.abs(a.price - ob.mid) - Math.abs(b.price - ob.mid))[0] || null;

    const h4Aligned = bull
      ? h4s.bias === 'bullish' || h4s.bos === 'bullish'
      : h4s.bias === 'bearish' || h4s.bos === 'bearish';
    const d1Aligned = bull
      ? d1s.bias === 'bullish' || d1s.bos === 'bullish'
      : d1s.bias === 'bearish' || d1s.bos === 'bearish';
    const h4Opposed = bull
      ? h4s.bias === 'bearish' && h4s.bos === 'bearish'
      : h4s.bias === 'bullish' && h4s.bos === 'bullish';
    const d1Opposed = bull
      ? d1s.bias === 'bearish' && d1s.bos === 'bearish'
      : d1s.bias === 'bullish' && d1s.bos === 'bullish';
    if (h4Opposed || d1Opposed) continue;

    const aligned = h4Aligned || d1Aligned;
    const neutral = !aligned;
    const volumeOk = rvol >= 0.9;

    const lastEma21 = Array.isArray(ema21) ? ema21[ema21.length - 1] : ema21;
    const lastEma50 = Array.isArray(ema50) ? ema50[ema50.length - 1] : ema50;
    const emaAligned = bull
      ? Number.isFinite(+lastEma21) && Number.isFinite(+lastEma50) && +lastEma21 >= +lastEma50
      : Number.isFinite(+lastEma21) && Number.isFinite(+lastEma50) && +lastEma21 <= +lastEma50;

    const keySideOk = !key
      ? true
      : bull
        ? current <= key.price * 1.008
        : current >= key.price * 0.992;

    const bosAge = c.length - 1 - seq.bos.index;
    if (bosAge > 12) continue;

    const rsiDiv = rsiDivergenceForDirection(c, dir) || { ok: false, detail: null };

    let score =
      45 +
      (key ? 16 : 0) +
      (fibHit ? 12 : 0) +
      (fvg ? 8 : 0) +
      (aligned ? 10 : 0) +
      (volumeOk ? 5 : 0) +
      (rvol >= 1.25 ? 4 : 0) +
      (emaAligned ? 8 : 0);
    if (neutral) score -= 2;
    if (key && !keySideOk) score -= 6;
    score = Math.min(100, score);
    if (score < minScore || (!key && !fibHit)) continue;

    const buffer = Math.max(atr * 0.35, current * 0.001);
    const sl = bull
      ? Math.min(ob.low, seq.sweep.extreme) - buffer
      : Math.max(ob.high, seq.sweep.extreme) + buffer;
    const entry = ob.mid;
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) continue;
    if (risk < atr * 0.45 || risk / current < 0.0045) continue;

    const tp1 = entry + (bull ? 1 : -1) * risk * 1.5;
    const tp2 = entry + (bull ? 1 : -1) * risk * 2.5;
    const tp3 = entry + (bull ? 1 : -1) * risk * 3.5;
    if ((bull && (current <= sl || current >= tp1)) || (!bull && (current >= sl || current <= tp1))) continue;

    const conf = ['15m liquidity sweep', '15m CHoCH/BOS close', 'Fresh Order Block / FVG', mitig.reason];
    if (key) conf.push(`${key.tf} key zone: ${key.name}`);
    if (fibHit) conf.push('Fib 0.618–0.786 confluence');
    if (aligned) conf.push('4H/1D structure aligned');
    if (emaAligned) conf.push(`15m EMA21/EMA50 aligned (${bull ? 'bull' : 'bear'})`);
    if (volumeOk) conf.push(`Volume confirmation ${rvol.toFixed(2)}x`);
    if (rsiDiv.ok) conf.push(rsiDiv.detail);

    // ─── Elliott Wave hard layer ───────────────────────────────────────
    let ewMeta = { enabled: false, bonus: 0 };
    if (ewEnabled) {
      if (!ewResult?.primaryCount) continue; // hard: no count

      const pc = ewResult.primaryCount;
      const gate = ewDirectionGate(pc, dir);
      if (!gate.ok) continue;

      const chase = noChaseOk(pc, gate.mode, dir, entry, atr, ob, c);
      if (!chase.ok) continue;

      const ew = elliottConfluence(ewResult, dir, null);
      let bonus = Math.max(0, Math.min(12, ew.points));
      if (gate.mode === 'continuation') bonus = Math.max(bonus, 8);
      if (gate.mode === 'reversal') bonus = Math.max(bonus, 8);
      if (MOTIVE.has(pc.type) && (pc.currentWave === 3 || pc.currentWave === 4)) {
        bonus = Math.max(bonus, 10);
      }

      score = Math.min(100, score + bonus);
      if (score < minScore) continue;

      conf.push(`EW ${gate.reason}`);
      if (chase.reason) conf.push(chase.reason);

      ewMeta = {
        enabled: true,
        hard: true,
        label: ewResult.context?.label || null,
        direction: pc.direction,
        type: pc.type,
        currentWave: pc.currentWave,
        confidence: pc.confidence,
        mode: gate.mode,
        gateReason: gate.reason,
        bonus,
        notes: ew.notes || [],
        invalidation: Number.isFinite(+pc.invalidation) ? +pc.invalidation : null,
        pivots: (pc.pivots || []).map((pv) => ({
          label: pv.label,
          price: pv.price,
          time: pv.time ?? null,
          i: pv.i,
        })),
      };
    }

    out.push({
      symbol,
      dir,
      strategy: strategyName,
      score,
      qualifies: true,
      conf,
      ob,
      fvgs: fvg ? [fvg] : [],
      entry,
      sl,
      tp1,
      tp2,
      tp3,
      rr: '1.5',
      price: current,
      rvol,
      atr,
      quality: {
        htfAligned: aligned,
        htfNeutral: neutral,
        hasLiqEdge: true,
        hasSweep: true,
        hasFvg: !!fvg,
        displacement: true,
        fibOte: fibHit,
        strongSetup: true,
        emaAligned,
        keySideOk,
        rsiDivAgainst: false,
        rsiDivOk: !!rsiDiv.ok,
        ewHard: ewEnabled,
        ewMode: ewMeta.mode || null,
      },
      metadata: {
        strategy: strategyName,
        patternTf: '15m',
        htf: '4h/1d',
        conf,
        ob,
        fvgs: fvg ? [fvg] : [],
        rvol,
        cryptoConfluence: {
          sequence:
            '4H/1D KEY ZONE → LIQUIDITY SWEEP → OB/FVG → FIB → VOLUME → 15m CHoCH/BOS → EW HARD GATE → ENTRY',
          keyZone: key,
          fib: { low: fibLow, high: fibHigh, hit: fibHit },
          h4Bias: h4s.bias,
          d1Bias: d1s.bias,
          htfNeutral: neutral,
          bosAgeCandles: bosAge,
          sweep: seq.sweep,
          bos: seq.bos,
          ema21,
          ema50,
          rsi,
          emaAligned,
          keySideOk,
          rsiDiv: rsiDiv.detail,
          rsiDivAgainst: false,
          elliott: ewMeta,
          minRiskAtr: 0.45,
          ewRules:
            'motive W2-4 continuation · corrective C/Y/E opposite reversal · W5 same-dir reject · no-chase · OB mitigation side',
          targetSignalsPerDay:
            '3-8 target; EW hard filters reduce count vs soft confluence',
        },
      },
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Dedicated strategy: always EW-hard */
export function runCryptoConfluenceEwStrategy(opts = {}) {
  return runCryptoConfluenceStrategy({
    ...opts,
    forceEw: true,
    strategyName: 'crypto_confluence_ew',
  });
}
