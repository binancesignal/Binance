/**
 * Pure AB=CD live signal strategy (equality only — no EMA).
 *
 * WATCHING — A/B/C confirmed; D not formed yet (projected completion zone)
 * READY    — D swing just completed classic AB=CD (|CD| ≈ |AB|)
 * ONGOING  — D complete and next candle has printed
 */
import { calcATR, findSwings } from '../../indicators.js';
import { ABCD_DEFAULTS, normalizeAbcdConfig } from './config.js';

const finite = (n) => Number.isFinite(+n);
const r8 = (n) => +(+n).toFixed(8);
const ratioAbs = (a, b) => (Math.abs(b) > 1e-12 ? Math.abs(a) / Math.abs(b) : 0);

function validCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter(
    (c) => finite(c?.open) && finite(c?.high) && finite(c?.low) && finite(c?.close) && +c.high >= +c.low
  );
}

/**
 * Alternating A-B-C-(D?) legs.
 * Bullish completion: D is swing LOW  → LONG
 * Bearish completion: D is swing HIGH → SHORT
 */
function legOk(A, B, C, atr, cfg) {
  if (A.type === B.type || B.type === C.type) return null;
  const ab = B.price - A.price;
  const bc = C.price - B.price;
  if (ab === 0 || bc === 0) return null;
  // BC must retrace against AB
  if (Math.sign(bc) === Math.sign(ab)) return null;
  const abLen = Math.abs(ab);
  const bcLen = Math.abs(bc);
  if (abLen < atr * cfg.minLegATR || bcLen < atr * cfg.minLegATR * 0.4) return null;
  const bcR = ratioAbs(bc, ab);
  if (bcR < cfg.bcMin || bcR > cfg.bcMax) return null;
  // Direction of expected CD = same as AB → D type opposite of C
  // AB up (A low → B high) → CD up → D is high → SHORT
  // AB down (A high → B low) → CD down → D is low → LONG
  const abUp = ab > 0;
  const direction = abUp ? 'SHORT' : 'LONG';
  const expectedDType = abUp ? 'H' : 'L';
  const projectedD = C.price + ab; // C + (B-A)
  return { ab, bc, abLen, bcLen, bcR, direction, expectedDType, projectedD };
}

function buildLevels(direction, entryRef, atr, cfg, C, D) {
  const isLong = direction === 'LONG';
  const sign = isLong ? 1 : -1;
  const entry = isLong
    ? entryRef + cfg.entryBufferATR * atr
    : entryRef - cfg.entryBufferATR * atr;
  let sl = isLong
    ? entryRef - cfg.slBufferATR * atr
    : entryRef + cfg.slBufferATR * atr;
  const risk = Math.abs(entry - sl);
  const riskClamped = Math.min(cfg.maxStopATR * atr, Math.max(cfg.minStopATR * atr, risk));
  if (riskClamped !== risk) {
    sl = isLong ? entry - riskClamped : entry + riskClamped;
  }
  const r = Math.abs(entry - sl) || atr;
  const tp1 = entry + sign * cfg.tp1R * r;
  const tp2 = entry + sign * cfg.tp2R * r;
  const structureTp = C && D ? Math.abs(C.price - D.price) : r;
  const tp3 = entry + sign * Math.max(cfg.tp3R * r, structureTp);
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

function scoreSetup(status, fit, age, levels) {
  let s = 48;
  if (status === 'READY') s += 14;
  if (status === 'ONGOING') s += 10;
  if (status === 'WATCHING') s += 4;
  s += Math.round(fit * 22);
  if (age <= 4) s += 5;
  if (levels.rr >= 1.2) s += 4;
  return Math.min(100, Math.max(0, s));
}

/**
 * Live scan one symbol / TF.
 * @returns {Array} signals with suggestedStatus WATCHING | READY | ONGOING
 */
export function runAbcdPair(opts = {}) {
  const { symbol, price, candles: raw, tf, config: rawConfig } = opts;
  const cfg = normalizeAbcdConfig(rawConfig || {});
  if (!cfg.enabled) return [];

  const candles = validCandles(raw);
  if (candles.length < 60 || !finite(price)) return [];

  const atr = calcATR(candles, 14);
  if (!(atr > 0)) return [];

  const swings = findSwings(candles, cfg.swingLeft, cfg.swingRight);
  if (swings.length < 3) return [];

  const last = candles.length - 1;
  const out = [];
  const seen = new Set();

  // ---- Completed AB=CD (READY / ONGOING) ----
  for (let i = 0; i + 3 < swings.length; i++) {
    const A = swings[i];
    const B = swings[i + 1];
    const C = swings[i + 2];
    const D = swings[i + 3];
    if (A.type === B.type || B.type === C.type || C.type === D.type) continue;

    const meta = legOk(A, B, C, atr, cfg);
    if (!meta) continue;
    if (D.type !== meta.expectedDType) continue;

    const span = D.i - A.i;
    if (span < cfg.minPatternBars || span > cfg.maxPatternBars) continue;

    const age = last - D.i;
    // Need confirm bars on the right of D
    if (age < cfg.swingConfirmBars) continue;
    if (age > cfg.maxDAgeBars) continue;

    const cd = D.price - C.price;
    if (Math.sign(cd) !== Math.sign(meta.ab)) continue;
    const cdLen = Math.abs(cd);
    if (cdLen < atr * cfg.minLegATR) continue;
    const cdAb = ratioAbs(cd, meta.ab);
    if (cdAb < cfg.cdAbMin || cdAb > cfg.cdAbMax) continue;

    // D still extreme since C (clarity)
    let clear = true;
    if (D.type === 'H') {
      for (let k = C.i; k <= last; k++) {
        if (k !== D.i && candles[k].high > D.price) {
          clear = false;
          break;
        }
      }
    } else {
      for (let k = C.i; k <= last; k++) {
        if (k !== D.i && candles[k].low < D.price) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;

    const { direction } = meta;
    if (direction === 'LONG' && !cfg.allowLong) continue;
    if (direction === 'SHORT' && !cfg.allowShort) continue;

    // bars after confirm window: age - swingConfirmBars
    const postConfirm = age - cfg.swingConfirmBars;
    const status = postConfirm <= cfg.readyMaxAgeBars ? 'READY' : 'ONGOING';

    const fit = 1 - Math.abs(cdAb - cfg.cdAbTarget) / Math.max(cfg.cdAbTarget, 0.5);
    const key = `${direction}:D:${D.time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const levels = buildLevels(direction, D.price, atr, cfg, C, D);
    if (levels.rr < cfg.minRR) continue;
    if (Math.abs(+price - levels.entry) > cfg.maxEntryDistanceATR * atr) continue;

    const score = scoreSetup(status, fit, age, levels);
    if (score < cfg.minScore) continue;

    const tfU = String(tf || '').toUpperCase();
    const analysis = [
      `${symbol} — ${direction} AB=CD (${tfU})`,
      `A ${A.type}@${r8(A.price)} → B ${B.type}@${r8(B.price)} → C ${C.type}@${r8(C.price)} → D ${D.type}@${r8(D.price)}`,
      `CD/AB ${cdAb.toFixed(3)} (target ${cfg.cdAbTarget}) · BC/AB ${meta.bcR.toFixed(3)}`,
      status === 'READY'
        ? `READY — D just completed AB=CD equality`
        : `ONGOING — D complete, next candle(s) printing`,
      `Entry ${levels.entry} · SL ${levels.sl} · TP1 ${levels.tp1} · RR ${levels.rr}`,
      `Score ${score}/100`,
    ].join('\n');

    out.push({
      symbol,
      dir: direction,
      direction,
      strategy: 'abcd',
      pattern: 'AB=CD',
      score,
      quality: score >= 80 ? 'STRONG' : score >= 60 ? 'VALID' : 'WEAK',
      entry: levels.entry,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rr: levels.rr,
      atr: r8(atr),
      analysis,
      suggestedStatus: status,
      ob: {
        time: D.time,
        high: D.type === 'H' ? D.price : C.price,
        low: D.type === 'L' ? D.price : C.price,
      },
      metadata: {
        strategy: 'abcd',
        strategyName: 'AB=CD',
        patternTf: tf,
        entryTf: tf,
        setupTf: tf,
        pattern: 'AB=CD',
        abcd: {
          family: 'AB=CD',
          label: 'AB=CD',
          direction,
          A: { price: A.price, time: A.time, type: A.type, i: A.i },
          B: { price: B.price, time: B.time, type: B.type, i: B.i },
          C: { price: C.price, time: C.time, type: C.type, i: C.i },
          D: { price: D.price, time: D.time, type: D.type, i: D.i },
          ratios: { bc: +meta.bcR.toFixed(3), cdAb: +cdAb.toFixed(3), target: cfg.cdAbTarget },
          projected: false,
        },
        lifecycle: { status, reason: status === 'READY' ? 'd_complete' : 'post_d', dAge: age },
        breakoutLevel: levels.entry,
        breakoutConfirmed: status === 'ONGOING',
        minScoreAtCreate: cfg.minScore,
        minRrAtEntry: cfg.minRR,
        minRR: cfg.minRR,
        riskATR: levels.riskATR,
      },
    });
  }

  // ---- Incomplete: A/B/C only → WATCHING (projected D) ----
  for (let i = 0; i + 2 < swings.length; i++) {
    const A = swings[i];
    const B = swings[i + 1];
    const C = swings[i + 2];
    // Prefer latest C — skip if a later swing already forms D for this triple in completed pass
    const meta = legOk(A, B, C, atr, cfg);
    if (!meta) continue;

    const cAge = last - C.i;
    if (cAge < cfg.swingConfirmBars) continue;
    if (cAge > cfg.maxCAgeBars) continue;

    const span = C.i - A.i;
    if (span < Math.max(4, cfg.minPatternBars - 2) || span > cfg.maxPatternBars) continue;

    // If a D swing already exists after C matching expected type with equality, skip (handled above)
    let hasD = false;
    for (let j = i + 3; j < swings.length; j++) {
      const D = swings[j];
      if (D.type !== meta.expectedDType) continue;
      if (D.i <= C.i) continue;
      const cdAb = ratioAbs(D.price - C.price, meta.ab);
      if (cdAb >= cfg.cdAbMin * 0.85 && cdAb <= cfg.cdAbMax * 1.15) {
        hasD = true;
        break;
      }
      // any later opposite extreme may mean structure moved on
      if (D.i > C.i) break;
    }
    if (hasD) continue;

    // Price should still be between C and projected D (not already past it by a lot)
    const proj = meta.projectedD;
    const zone = cfg.projectZoneATR * atr;
    const isLong = meta.direction === 'LONG';
    // For LONG, D is below; for SHORT, D is above
    if (isLong && +price < proj - zone * 3) continue; // already way past projected low
    if (!isLong && +price > proj + zone * 3) continue;

    if (meta.direction === 'LONG' && !cfg.allowLong) continue;
    if (meta.direction === 'SHORT' && !cfg.allowShort) continue;

    const key = `${meta.direction}:C:${C.time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const entryRef = proj;
    const levels = buildLevels(meta.direction, entryRef, atr, cfg, C, { price: proj });
    if (levels.rr < cfg.minRR) continue;
    // Watching can be farther from entry
    if (Math.abs(+price - levels.entry) > cfg.maxEntryDistanceATR * atr * 1.5) continue;

    const fit = 0.85; // projected
    const score = scoreSetup('WATCHING', fit, cAge, levels);
    if (score < cfg.minScore - 5) continue;

    const tfU = String(tf || '').toUpperCase();
    const analysis = [
      `${symbol} — ${meta.direction} AB=CD projected (${tfU})`,
      `A ${A.type}@${r8(A.price)} → B ${B.type}@${r8(B.price)} → C ${C.type}@${r8(C.price)} · D pending @ ~${r8(proj)}`,
      `BC/AB ${meta.bcR.toFixed(3)} · expected CD = AB (${cfg.cdAbTarget})`,
      `WATCHING — C confirmed, waiting for D to complete AB=CD`,
      `Projected entry ${levels.entry} · SL ${levels.sl} · TP1 ${levels.tp1}`,
      `Score ${score}/100`,
    ].join('\n');

    out.push({
      symbol,
      dir: meta.direction,
      direction: meta.direction,
      strategy: 'abcd',
      pattern: 'AB=CD',
      score,
      quality: score >= 70 ? 'VALID' : 'WEAK',
      entry: levels.entry,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rr: levels.rr,
      atr: r8(atr),
      analysis,
      suggestedStatus: 'WATCHING',
      ob: {
        time: C.time,
        high: isLong ? C.price : Math.max(C.price, proj),
        low: isLong ? Math.min(C.price, proj) : C.price,
      },
      metadata: {
        strategy: 'abcd',
        strategyName: 'AB=CD',
        patternTf: tf,
        entryTf: tf,
        setupTf: tf,
        pattern: 'AB=CD',
        abcd: {
          family: 'AB=CD',
          label: 'AB=CD',
          direction: meta.direction,
          A: { price: A.price, time: A.time, type: A.type, i: A.i },
          B: { price: B.price, time: B.time, type: B.type, i: B.i },
          C: { price: C.price, time: C.time, type: C.type, i: C.i },
          D: { price: proj, time: null, type: meta.expectedDType, i: null, projected: true },
          ratios: { bc: +meta.bcR.toFixed(3), cdAb: null, target: cfg.cdAbTarget },
          projected: true,
          projectedD: r8(proj),
          projectZone: r8(zone),
        },
        lifecycle: { status: 'WATCHING', reason: 'awaiting_d', cAge },
        breakoutLevel: levels.entry,
        breakoutConfirmed: false,
        minScoreAtCreate: cfg.minScore,
        minRrAtEntry: cfg.minRR,
        minRR: cfg.minRR,
        riskATR: levels.riskATR,
      },
    });
  }

  // Prefer completed over projected, higher score, fresher
  out.sort((a, b) => {
    const rank = { ONGOING: 0, READY: 1, WATCHING: 2 };
    return (rank[a.suggestedStatus] ?? 9) - (rank[b.suggestedStatus] ?? 9) || b.score - a.score;
  });

  return out;
}

export { normalizeAbcdConfig, ABCD_DEFAULTS };
