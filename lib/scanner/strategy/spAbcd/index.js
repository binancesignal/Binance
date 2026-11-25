/**
 * SP Breaker + AB=CD — standalone strategy (not part of Harmonic).
 * Reuses only: coin universe / chunk scan plumbing + chart annotation shape.
 */
import { calcATR, findSwings, calcEMASeries } from '../../indicators.js';
import { detectBreakers } from '../harmonicScan/breakerBlock.js';
import { SP_ABCD_DEFAULTS, normalizeSpAbcdConfig } from './config.js';

export { SP_ABCD_DEFAULTS, normalizeSpAbcdConfig };

const finite = (n) => Number.isFinite(+n);
const r8 = (n) => +(+n).toFixed(8);
const ratioAbs = (a, b) => (Math.abs(b) > 1e-12 ? Math.abs(a) / Math.abs(b) : 0);

function cTouchesZone(c, top, bot) {
  if (!c) return false;
  const zoneTop = Math.max(+top, +bot);
  const zoneBot = Math.min(+top, +bot);
  const hi = +c.high;
  const lo = +c.low;
  return lo <= zoneTop && hi >= zoneBot;
}

/**
 * SP breaker: OB source (obBar) in AB or BC; born (break) not after C; C touches zone.
 * Fallback: opposing candle body in A..C that C touches.
 */
function findSpBreaker(breakers, A, B, C, candles) {
  const aI = A.i;
  const cI = C.i;
  const candidates = [];

  for (const br of breakers || []) {
    const src = br.obBar ?? br.sourceBar ?? br.bar;
    const born = br.bornBar ?? br.breakBar;
    if (src == null) continue;
    if (src < aI - 1 || src > cI) continue;
    if (born != null && born > cI) continue;
    const top = +br.top;
    const bot = +br.bot;
    if (!finite(top) || !finite(bot)) continue;
    if (!cTouchesZone(candles[cI], top, bot)) continue;
    candidates.push({
      top: Math.max(top, bot),
      bot: Math.min(top, bot),
      quality: +(br.quality || 50),
      obBar: src,
      bornBar: born,
      side: br.side || (br.isBull ? 'BULL' : 'BEAR'),
      fromEngine: true,
    });
  }

  if (!candidates.length) {
    // Fallback order-block style: candle in A..C whose range C touches
    for (let k = aI; k <= cI; k++) {
      const bar = candles[k];
      if (!bar) continue;
      const top = +bar.high;
      const bot = +bar.low;
      if (!cTouchesZone(candles[cI], top, bot)) continue;
      // prefer opposing colour vs AB direction
      const bearish = +bar.close < +bar.open;
      const bullish = +bar.close > +bar.open;
      candidates.push({
        top,
        bot,
        quality: 40 + (k === cI ? 0 : 5),
        obBar: k,
        bornBar: k,
        side: bearish ? 'BEAR' : bullish ? 'BULL' : 'NA',
        fromEngine: false,
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality;
    return (b.obBar || 0) - (a.obBar || 0);
  });
  return candidates[0];
}

function trendFromEma(A, B, C, D, emaAt) {
  if (!finite(emaAt)) return { trend: null, reject: true };
  const prices = [A.price, B.price, C.price, D.price];
  const mid = prices.reduce((s, p) => s + p, 0) / 4;
  const hi = Math.max(...prices);
  const lo = Math.min(...prices);
  // soft touch: only reject if mid is within 0.15% of EMA (true straddle)
  const span = Math.max(hi - lo, Math.abs(mid) * 0.001);
  const touchesHard = lo < emaAt && hi > emaAt && Math.abs(mid - emaAt) < span * 0.15;
  if (touchesHard) return { trend: null, reject: true, ema: emaAt };
  const trend = mid < emaAt ? 'DOWN' : 'UP';
  return { trend, reject: false, ema: emaAt, mid };
}

function classifyStatus(price, entry, cfg) {
  if (!(price > 0) || !(entry > 0)) return 'WATCHING';
  const distPct = (Math.abs(price - entry) / entry) * 100;
  if (distPct <= cfg.readyProximityPercent) return 'ENTRY_READY';
  if (distPct <= cfg.watchingProximityPercent) return 'WATCHING';
  return 'WAITING';
}

/**
 * @returns {Array} board-compatible events
 */
export function findSpAbcdEvents(candles, opts = {}) {
  const cfg = normalizeSpAbcdConfig({ ...opts, enabled: true });
  const list = (Array.isArray(candles) ? candles : []).filter(
    (c) => finite(c?.high) && finite(c?.low) && finite(c?.close)
  );
  if (list.length < 60) return [];

  const atr = calcATR(list, 14) || list[list.length - 1].close * 0.01;
  const emaSeries = calcEMASeries(list, cfg.emaPeriod) || [];
  const swings = findSwings(list, cfg.swingLeft, cfg.swingRight) || [];
  if (swings.length < 4) return [];

  let breakers = [];
  try {
    breakers = detectBreakers(list, opts.breakerCfg || {}) || [];
  } catch (_) {
    breakers = [];
  }

  const out = [];
  const lastI = list.length - 1;
  const price = +list[lastI].close;

  for (let i = 0; i < swings.length - 3; i++) {
    const A = swings[i];
    const B = swings[i + 1];
    const C = swings[i + 2];
    const D = swings[i + 3];
    if (!A || !B || !C || !D) continue;
    if (A.type === B.type || B.type === C.type || C.type === D.type) continue;
    const span = D.i - A.i;
    if (span < cfg.minPatternBars || span > cfg.maxPatternBars) continue;
    if (lastI - D.i > cfg.maxDAgeBars) continue;

    const ab = B.price - A.price;
    const bc = C.price - B.price;
    const cd = D.price - C.price;
    if (!ab || !bc || !cd) continue;
    if (Math.sign(bc) === Math.sign(ab)) continue;
    if (Math.sign(cd) !== Math.sign(ab)) continue;

    const abLen = Math.abs(ab);
    const bcLen = Math.abs(bc);
    const cdLen = Math.abs(cd);
    if (abLen < atr * cfg.minLegATR) continue;
    if (bcLen < atr * cfg.minLegATR * 0.3) continue;
    if (cdLen < atr * cfg.minLegATR * 0.4) continue;

    const bcR = ratioAbs(bc, ab);
    if (bcR < cfg.bcMin || bcR > cfg.bcMax) continue;
    const cdAb = ratioAbs(cd, ab);
    if (cdAb < cfg.cdAbMin || cdAb > cfg.cdAbMax) continue;

    const abUp = ab > 0; // up structure (HH/HL style)
    const emaAt = emaSeries[D.i] ?? emaSeries[emaSeries.length - 1];
    const { trend, reject } = trendFromEma(A, B, C, D, emaAt);
    if (reject || !trend) continue;
    // DOWN trend → need up-built AB=CD; UP trend → need down-built
    if (trend === 'DOWN' && !abUp) continue;
    if (trend === 'UP' && abUp) continue;

    const sp = findSpBreaker(breakers, A, B, C, list);
    if (!sp) continue;

    const direction = trend === 'DOWN' ? 'LONG' : 'SHORT';
    const isLong = direction === 'LONG';
    const entry = isLong ? sp.top : sp.bot;
    const height = Math.max(1e-12, sp.top - sp.bot);
    const slBuf = atr * cfg.slBufferATR + height * cfg.slBufferPctOfHeight;
    const sl = isLong ? sp.bot - slBuf : sp.top + slBuf;
    const risk = Math.abs(entry - sl) || atr;
    const tp1 = isLong ? entry + risk * 1.2 : entry - risk * 1.2;
    const tp2 = isLong ? entry + risk * 2.0 : entry - risk * 2.0;
    const tp3 = isLong ? entry + risk * 3.0 : entry - risk * 3.0;

    let status = classifyStatus(price, entry, cfg);
    if (isLong && price > entry * 1.003) status = 'FORMED';
    if (!isLong && price < entry * 0.997) status = 'FORMED';

    let score = 52;
    score += Math.max(0, 22 - Math.abs(cdAb - cfg.cdAbTarget) * 70);
    if (sp.fromEngine) score += 12;
    score += 8; // trend filter passed
    score = Math.round(Math.min(98, Math.max(0, score)));
    if (score < cfg.minScore) continue;

    const symbol = opts.symbol || '';
    const tf = opts.tf || '';
    const id = ['SPABCD', symbol, tf, direction, A.time || A.i, C.time || C.i, D.time || D.i].join('|');

    out.push({
      id,
      symbol,
      tf,
      family: 'SP_ABCD',
      label: 'SP AB=CD',
      kind: 'COMPLETED',
      direction,
      status,
      score,
      entry: r8(entry),
      price: r8(price),
      marketPrice: r8(price),
      X: { price: r8(A.price), time: A.time, i: A.i },
      A: { price: r8(A.price), time: A.time, i: A.i },
      B: { price: r8(B.price), time: B.time, i: B.i },
      C: { price: r8(C.price), time: C.time, i: C.i },
      D: { price: r8(D.price), time: D.time, i: D.i },
      plan: { entry: r8(entry), sl: r8(sl), tp1: r8(tp1), tp2: r8(tp2), tp3: r8(tp3) },
      sl: r8(sl),
      tp1: r8(tp1),
      tp2: r8(tp2),
      tp3: r8(tp3),
      ratios: { bcAb: r8(bcR), cdAb: r8(cdAb) },
      trend,
      spBreaker: {
        top: r8(sp.top),
        bot: r8(sp.bot),
        quality: sp.quality,
        obBar: sp.obBar,
        bornBar: sp.bornBar,
        side: sp.side,
        fromEngine: !!sp.fromEngine,
      },
      metadata: {
        strategy: 'sp_abcd',
        strategyName: 'SP AB=CD',
        pattern: 'SP_ABCD',
        trend,
        spBreaker: true,
      },
    });
  }

  const byKey = new Map();
  for (const e of out) {
    const k = `${e.symbol}|${e.tf}|${e.direction}|${e.C?.time || e.C?.i}`;
    const prev = byKey.get(k);
    if (!prev || e.score > prev.score) byKey.set(k, e);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

export function runSpAbcdStrategy({ symbol, tf, candles, config = {} }) {
  return findSpAbcdEvents(candles, {
    ...normalizeSpAbcdConfig({ ...config, enabled: true }),
    symbol,
    tf,
    breakerCfg: config.breakerCfg,
  });
}
