/**
 * EMA triple + AB=CD live signal strategy.
 *
 * WATCHING  — EMA cross (mode: triple / any_two / any_pair / off) + clear AB=CD complete
 *             (D is a confirmed swing high/low — not a messy mid-leg label).
 * READY     — From D, price rejects toward the trade and that rejection TOUCHES EMA 20.
 * ONGOING   — Same rejection move continues and touches EMA 50 (after EMA20 touch).
 * INVALID   — After D, BEFORE the EMA20 touch:
 *               1) two or more EMA pairs re-cross, OR
 *               2) a candle CLOSES beyond the D extreme (new high after bearish D /
 *                  new low after bullish D).
 *
 * This is a LIVE scanner strategy (not the historical triple-cross backtest).
 */
import { calcATR, calcEMASeries, findSwings } from '../../indicators.js';
import { EMA_ABCD_DEFAULTS, normalizeEmaAbcdConfig } from './config.js';

const finite = (n) => Number.isFinite(+n);
const r8 = (n) => +(+n).toFixed(8);
const ratioAbs = (a, b) => (Math.abs(b) > 1e-12 ? Math.abs(a) / Math.abs(b) : 0);

function validCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter(
    (c) => finite(c?.open) && finite(c?.high) && finite(c?.low) && finite(c?.close) && +c.high >= +c.low
  );
}

function pairCrosses(a, b) {
  const out = [];
  let prevSign = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] == null || b[i] == null) continue;
    const d = a[i] - b[i];
    const s = d > 0 ? 1 : d < 0 ? -1 : prevSign;
    if (prevSign !== 0 && s !== 0 && s !== prevSign) out.push({ i, dir: s });
    if (s !== 0) prevSign = s;
  }
  return out;
}

function matchVariant(cdAb, variants) {
  let best = null;
  let bestDist = Infinity;
  for (const v of variants) {
    if (cdAb < v.min || cdAb > v.max) continue;
    const dist = Math.abs(cdAb - v.target);
    if (dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  }
  return best;
}

/**
 * EMA pair crosses near endIdx, filtered by mode:
 *   triple   — 20/50 AND 20/200 same direction
 *   any_two  — any 2 of the 3 pairs same direction
 *   any_pair — any 1 pair (20/50 OR 20/200 OR 50/200)
 *   off      — always null (caller skips EMA gate)
 * Returns { dir: +1|-1, crosses: [{pair,index}] } or null.
 */
function findEmaCrossNear(e20, e50, e200, endIdx, windowBars, mode) {
  if (mode === 'off') return null;
  const from = Math.max(1, endIdx - windowBars + 1);
  const pairs = [
    { name: '20/50', list: pairCrosses(e20, e50).filter((c) => c.i >= from && c.i <= endIdx) },
    { name: '20/200', list: pairCrosses(e20, e200).filter((c) => c.i >= from && c.i <= endIdx) },
    { name: '50/200', list: pairCrosses(e50, e200).filter((c) => c.i >= from && c.i <= endIdx) },
  ];
  for (const dir of [1, -1]) {
    const hits = pairs
      .map((p) => {
        const last = p.list.filter((c) => c.dir === dir);
        return last.length ? { pair: p.name, index: last[last.length - 1].i } : null;
      })
      .filter(Boolean);
    if (mode === 'triple') {
      const has2050 = hits.some((h) => h.pair === '20/50');
      const has20200 = hits.some((h) => h.pair === '20/200');
      if (has2050 && has20200) {
        return { dir, crosses: hits.filter((h) => h.pair === '20/50' || h.pair === '20/200') };
      }
    } else if (mode === 'any_two') {
      if (hits.length >= 2) return { dir, crosses: hits };
    } else {
      // any_pair
      if (hits.length >= 1) return { dir, crosses: hits };
    }
  }
  return null;
}

/** @deprecated use findEmaCrossNear(..., 'triple') */
function findTripleCrossNear(e20, e50, e200, endIdx, windowBars) {
  return findEmaCrossNear(e20, e50, e200, endIdx, windowBars, 'triple');
}

/** Count how many of the three pairs crossed (any dir) between fromIdx+1 .. toIdx inclusive. */
function countPairCrossesAfter(e20, e50, e200, fromIdx, toIdx) {
  let n = 0;
  const ranges = [
    pairCrosses(e20, e50),
    pairCrosses(e20, e200),
    pairCrosses(e50, e200),
  ];
  for (const list of ranges) {
    if (list.some((c) => c.i > fromIdx && c.i <= toIdx)) n += 1;
  }
  return n;
}

/**
 * Find clear completed AB=CD patterns ending with a confirmed D swing.
 * D is a swing high → bearish setup (SHORT); D is swing low → bullish (LONG).
 */
function findClearAbcd(candles, atr, cfg, e20, e50, e200) {
  const swings = findSwings(candles, cfg.swingLeft, cfg.swingRight);
  if (swings.length < 4 || !(atr > 0)) return [];

  const last = candles.length - 1;
  const out = [];

  for (let i = 0; i + 3 < swings.length; i++) {
    const A = swings[i];
    const B = swings[i + 1];
    const C = swings[i + 2];
    const D = swings[i + 3];
    if (A.type === B.type || B.type === C.type || C.type === D.type) continue;

    const age = last - D.i;
    if (age < cfg.dConfirmBars || age > cfg.maxDAgeBars) continue;
    const span = D.i - A.i;
    if (span < cfg.minPatternBars || span > cfg.maxPatternBars) continue;

    const ab = B.price - A.price;
    const bc = C.price - B.price;
    const cd = D.price - C.price;
    if (ab === 0 || cd === 0) continue;
    if (Math.sign(ab) !== Math.sign(cd)) continue;
    if (Math.sign(bc) === Math.sign(ab)) continue;

    const abLen = Math.abs(ab);
    const bcLen = Math.abs(bc);
    const cdLen = Math.abs(cd);
    if (abLen < atr * cfg.minLegATR || bcLen < atr * cfg.minLegATR * 0.5 || cdLen < atr * cfg.minLegATR) continue;

    const bcR = ratioAbs(bc, ab);
    const cdAb = ratioAbs(cd, ab);
    if (bcR < cfg.bcMin || bcR > cfg.bcMax) continue;
    const variant = matchVariant(cdAb, cfg.variants);
    if (!variant) continue;

    // D must still be the extreme since C (no equal/beyond wick that invalidates clarity)
    let dStillExtreme = true;
    if (D.type === 'H') {
      for (let k = C.i; k <= last; k++) {
        if (k !== D.i && candles[k].high > D.price) {
          dStillExtreme = false;
          break;
        }
      }
    } else {
      for (let k = C.i; k <= last; k++) {
        if (k !== D.i && candles[k].low < D.price) {
          dStillExtreme = false;
          break;
        }
      }
    }
    if (!dStillExtreme) continue;

    // Trade direction: D low → LONG (buy), D high → SHORT (sell)
    const direction = D.type === 'L' ? 'LONG' : 'SHORT';

    // EMA cross gate near D (mode: triple | any_two | any_pair | off)
    let triple = null;
    const mode = cfg.emaCrossMode || (cfg.requireTripleCross ? 'triple' : 'off');
    if (mode !== 'off') {
      triple = findEmaCrossNear(e20, e50, e200, D.i, cfg.crossWindowBars, mode);
      if (!triple) continue;
      // Cross direction should agree with trade (UP cross → LONG, DOWN → SHORT)
      const want = direction === 'LONG' ? 1 : -1;
      if (triple.dir !== want) continue;
    }

    const fit = 1 - Math.abs(cdAb - variant.target) / Math.max(variant.target, 0.5);
    out.push({
      A, B, C, D,
      direction,
      variant,
      ratios: { bc: +bcR.toFixed(3), cdAb: +cdAb.toFixed(3), target: variant.target },
      fit,
      triple,
      age,
    });
  }

  // Prefer fresher + better fit
  out.sort((a, b) => b.fit - a.fit || a.age - b.age);
  return out;
}

/**
 * Evaluate lifecycle for one AB=CD setup against current candles.
 * Returns { status: 'WATCHING'|'READY'|'ONGOING'|'INVALID', reason, touch20?, touch50?, rejectBars? }
 */
function evaluateLifecycle(candles, setup, e20, e50, e200, atr, cfg) {
  const { D, direction } = setup;
  const last = candles.length - 1;
  const tol = cfg.touchTolATR * atr;
  const dPrice = D.price;
  const isLong = direction === 'LONG';

  // Scan bars AFTER D for invalidation first, then READY / ONGOING conditions
  let touched20 = false;
  let touched50 = false;
  let touch20Idx = -1;
  let touch50Idx = -1;
  let maxFavorable = 0; // how far price moved from D toward trade

  for (let i = D.i + 1; i <= last; i++) {
    const c = candles[i];

    // --- INVALID: new extreme close beyond D (before 20 touch) ---
    if (!touched20 && cfg.invalidateOnNewExtreme) {
      if (isLong && +c.close < dPrice) {
        // For LONG, D is a low — close making a new low invalidates
        return { status: 'INVALID', reason: 'new_low_beyond_D', at: i };
      }
      if (!isLong && +c.close > dPrice) {
        return { status: 'INVALID', reason: 'new_high_beyond_D', at: i };
      }
    }

    // --- INVALID: ≥2 EMA pairs re-cross after D before 20 touch ---
    if (!touched20 && cfg.invalidateOnEmaCross) {
      const crosses = countPairCrossesAfter(e20, e50, e200, D.i, i);
      if (crosses >= 2) {
        return { status: 'INVALID', reason: 'ema_pairs_recross', at: i, crosses };
      }
    }

    // Rejection progress from D
    const fav = isLong ? dPrice - +c.low : +c.high - dPrice;
    if (fav > maxFavorable) maxFavorable = fav;

    // EMA20 touch on the rejection move
    if (!touched20 && e20[i] != null) {
      const ema = e20[i];
      const hit = +c.low <= ema + tol && +c.high >= ema - tol;
      // Also require we have started rejecting (moved toward trade a bit)
      if (hit && maxFavorable >= cfg.minRejectATR * atr) {
        touched20 = true;
        touch20Idx = i;
      }
    }

    // EMA50 touch (same rejection wave after 20) → ONGOING
    if (touched20 && !touched50 && cfg.trackEma50Touch && e50[i] != null) {
      const ema = e50[i];
      if (+c.low <= ema + tol && +c.high >= ema - tol) {
        touched50 = true;
        touch50Idx = i;
      }
    }
  }

  if (touched20) {
    // Extra guard: rejection must still be "from D" — not ancient
    if (touch20Idx - D.i > cfg.maxRejectBars) {
      return { status: 'INVALID', reason: 'reject_too_slow', at: touch20Idx };
    }
    if (touched50) {
      return {
        status: 'ONGOING',
        reason: 'ema20_and_ema50_touch',
        touch20Idx,
        touch50Idx,
        touched50: true,
        rejectBars: touch20Idx - D.i,
        rejectATR: +(maxFavorable / atr).toFixed(3),
      };
    }
    return {
      status: 'READY',
      reason: 'ema20_touch',
      touch20Idx,
      touch50Idx: -1,
      touched50: false,
      rejectBars: touch20Idx - D.i,
      rejectATR: +(maxFavorable / atr).toFixed(3),
    };
  }

  // Still watching — D is clear, no 20 touch yet, not invalidated
  return {
    status: 'WATCHING',
    reason: 'awaiting_ema20_rejection_touch',
    rejectATR: +(maxFavorable / atr).toFixed(3),
  };
}

function buildLevels(setup, life, candles, atr, cfg) {
  const { D, direction, C } = setup;
  const isLong = direction === 'LONG';
  const sign = isLong ? 1 : -1;
  // Entry: break of a small structure beyond the rejection — use C as first target idea;
  // entry itself = D extreme ± buffer (break of D for continuation is common; here we
  // enter on rejection zone: use EMA20 area approximated by last touch or D±buffer)
  const entry =
    isLong
      ? D.price + cfg.entryBufferATR * atr
      : D.price - cfg.entryBufferATR * atr;

  // SL beyond D
  let sl = isLong
    ? D.price - cfg.slBufferATR * atr
    : D.price + cfg.slBufferATR * atr;
  const risk = Math.abs(entry - sl);
  const riskClamped = Math.min(cfg.maxStopATR * atr, Math.max(cfg.minStopATR * atr, risk));
  if (riskClamped !== risk) {
    sl = isLong ? entry - riskClamped : entry + riskClamped;
  }
  const r = Math.abs(entry - sl) || atr;
  const tp1 = entry + sign * cfg.tp1R * r;
  const tp2 = entry + sign * cfg.tp2R * r;
  const tp3 = entry + sign * Math.max(cfg.tp3R * r, Math.abs(C.price - D.price));
  const rr = r > 0 ? Math.abs(tp1 - entry) / r : 0;
  return {
    entry: r8(entry),
    sl: r8(sl),
    tp1: r8(tp1),
    tp2: r8(tp2),
    tp3: r8(tp3),
    rr: r8(rr),
    riskATR: r8(r / atr),
  };
}

function scoreSetup(setup, life, levels) {
  let s = 50;
  s += Math.round(setup.fit * 20);
  if (life.status === 'READY') s += 12;
  if (life.status === 'ONGOING') s += 18;
  else if (life.touched50) s += 6;
  if (setup.variant?.target === 1.0) s += 4;
  if (setup.age <= 8) s += 4;
  if (levels.rr >= 1.5) s += 4;
  if (setup.triple) s += 4;
  return Math.min(100, Math.max(0, s));
}

/**
 * Live scan for one symbol / one TF.
 * @returns {Array} signal objects with suggestedStatus WATCHING | READY | ONGOING
 *          (INVALID setups are not emitted — they simply disappear / never created)
 */
export function runEmaAbcdPair(opts = {}) {
  const { symbol, price, candles: raw, tf, config: rawConfig } = opts;
  const cfg = normalizeEmaAbcdConfig(rawConfig || {});
  if (!cfg.enabled) return [];

  const candles = validCandles(raw);
  if (candles.length < cfg.slow + 30 || !finite(price)) return [];

  const e20 = calcEMASeries(candles, cfg.fast);
  const e50 = calcEMASeries(candles, cfg.mid);
  const e200 = calcEMASeries(candles, cfg.slow);
  const atr = calcATR(candles, 14);
  if (!(atr > 0)) return [];

  const patterns = findClearAbcd(candles, atr, cfg, e20, e50, e200);
  const out = [];
  const seen = new Set();

  for (const setup of patterns) {
    if (setup.direction === 'LONG' && !cfg.allowLong) continue;
    if (setup.direction === 'SHORT' && !cfg.allowShort) continue;

    const key = `${setup.direction}:${setup.D.time}:${setup.variant.key}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const life = evaluateLifecycle(candles, setup, e20, e50, e200, atr, cfg);
    if (life.status === 'INVALID') continue;

    const levels = buildLevels(setup, life, candles, atr, cfg);
    if (levels.rr < cfg.minRR) continue;

    const live = +price;
    if (Math.abs(live - levels.entry) > cfg.maxEntryDistanceATR * atr) continue;

    const score = scoreSetup(setup, life, levels);
    if (score < cfg.minScore) continue;

    const dir = setup.direction;
    const tfU = String(tf || '').toUpperCase();
    const abcdName = setup.variant.label || setup.variant.key;
    const analysis = [
      `${symbol} — ${dir} ${abcdName} + EMA (${tfU})`,
      `Clear D ${setup.D.type === 'H' ? 'high' : 'low'} @ ${r8(setup.D.price)} · CD/AB ${setup.ratios.cdAb} (tgt ${setup.ratios.target}) · BC ${setup.ratios.bc}`,
      setup.triple
        ? `EMA cross (${setup.triple.crosses.map((c) => c.pair).join(' + ')}) near D`
        : null,
      life.status === 'ONGOING'
        ? `ONGOING — rejection from D touched EMA20 + EMA50 (${life.rejectBars} bars, ${life.rejectATR} ATR)`
        : life.status === 'READY'
          ? `READY — rejection from D touched EMA20 (${life.rejectBars} bars, ${life.rejectATR} ATR)`
          : `WATCHING — waiting for rejection from D to touch EMA20`,
      `INVALID if before EMA20 touch: ≥2 EMA pairs re-cross, or close beyond D extreme`,
      `Entry ${levels.entry} · SL ${levels.sl} · TP1 ${levels.tp1} · RR ${levels.rr}`,
      `Score ${score}/100`,
    ]
      .filter(Boolean)
      .join('\n');

    out.push({
      symbol,
      dir,
      direction: dir,
      strategy: 'ema_triple',
      pattern: abcdName,
      score,
      quality: score >= 80 ? 'STRONG' : score >= 65 ? 'VALID' : 'WEAK',
      entry: levels.entry,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rr: levels.rr,
      atr: r8(atr),
      analysis,
      suggestedStatus: life.status, // WATCHING | READY
      ob: {
        time: setup.D.time,
        high: setup.D.type === 'H' ? setup.D.price : setup.C.price,
        low: setup.D.type === 'L' ? setup.D.price : setup.C.price,
      },
      metadata: {
        strategy: 'ema_triple',
        strategyName: 'EMA Triple + AB=CD',
        patternTf: tf,
        entryTf: tf,
        setupTf: tf,
        pattern: abcdName,
        abcd: {
          family: setup.variant.key,
          label: setup.variant.label,
          direction: dir,
          A: { price: setup.A.price, time: setup.A.time, type: setup.A.type },
          B: { price: setup.B.price, time: setup.B.time, type: setup.B.type },
          C: { price: setup.C.price, time: setup.C.time, type: setup.C.type },
          D: { price: setup.D.price, time: setup.D.time, type: setup.D.type },
          ratios: setup.ratios,
        },
        tripleCross: setup.triple,
        lifecycle: {
          status: life.status,
          reason: life.reason,
          touch20Idx: life.touch20Idx ?? null,
          touch50Idx: life.touch50Idx ?? null,
          touched50: !!life.touched50,
          rejectBars: life.rejectBars ?? null,
          rejectATR: life.rejectATR ?? null,
        },
        ema: { fast: cfg.fast, mid: cfg.mid, slow: cfg.slow },
        breakoutLevel: levels.entry,
        breakoutConfirmed: false,
        minScoreAtCreate: cfg.minScore,
        minRrAtEntry: cfg.minRR,
        minRR: cfg.minRR,
        riskATR: levels.riskATR,
      },
    });
  }

  return out;
}

export { normalizeEmaAbcdConfig, EMA_ABCD_DEFAULTS };
