/**
 * ICT / SMC PROBABILITY-BASED POI — analysis engine (paper / analysis only, never places orders).
 *
 *   1D + 4H  → market structure (HH/HL/LH/LL, BOS / MSS), dealing range, premium / discount, HTF bias
 *   1H + 30M → order blocks, FVGs, double OBs, liquidity pools and sweeps  → POIs
 *   15M      → entry confirmation (MSS / BOS after the POI was reached, after the sweep)
 *
 * LONG is analysed on the real candles, SHORT on the price-mirrored candles (price × −1), so both directions run
 * the exact same code and every output is converted back to real prices. Only CLOSED candles are used.
 * The scanner, the chart annotations and the diagnostics all come from this one result.
 */
import { mirrorCandles } from '../skSystem/structure.js';
import { findDoubleObs } from '../doubleOb/detect.js';
import { POI_STRATEGY, POI_STRATEGY_NAME, POI_TF_SEC, swingBarsOf, liqTolAtr } from './config.js';
import { closedCandles, atrOf, pivots, labelPivots, walkStructure, dealingRange, rangePos, liquidityPools, findSweeps, findFvgs, findOrderBlocks, overlapFrac } from './structure.js';

const r8 = (n) => +(+n).toFixed(8);
const U = (tf) => String(tf).toUpperCase();
const LIMITS = { '1d': 300, '4h': 500, '1h': 600, '30m': 600, '15m': 700 };
const SOURCE_TFS = ['4h', '1h', '30m', '15m'];
const STATE_RANK = { INVALIDATED: 0, WATCHING: 1, READY: 2, CONFIRMED: 3 };

export const poiId = (symbol, dir, tf, time) => `poi_${String(symbol).toUpperCase()}_${dir}_${tf}_${time}`;

/**
 * @param {{symbol:string, getCandles:(tf:string, limit:number)=>Promise<object[]>, cfg:object, nowSec?:number, dirs?:string[]}} o
 * @returns {Promise<{symbol:string, nowSec:number, results:object[]}>}  results[i] = { dir, analysis|null, reason }
 */
export async function analyzePoiSymbol(o) {
  const { symbol, cfg } = o;
  const nowSec = Number.isFinite(+o.nowSec) ? +o.nowSec : Math.floor(Date.now() / 1000);
  const real = {};
  for (const tf of Object.keys(LIMITS)) {
    try {
      real[tf] = closedCandles(await o.getCandles(tf, LIMITS[tf]), tf, nowSec);
    } catch (e) {
      if (e && typeof e === 'object') e.fetchFailed = true; // a data failure is a FAILED analysis, never a silent "no setup"
      throw e;
    }
  }
  const missing = Object.entries({ '1d': 40, '4h': 80, '1h': 80, '30m': 60, '15m': 80 }).filter(([tf, n]) => real[tf].length < n);
  if (missing.length) {
    const reason = `not enough closed candles: ${missing.map(([tf, n]) => `${U(tf)} ${real[tf].length}/${n}`).join(', ')}`;
    return { symbol, nowSec, results: (o.dirs || ['LONG', 'SHORT']).map((dir) => ({ dir, analysis: null, reason })) };
  }
  // double order blocks (nested OBs) are found once on the real candles
  const dbl = {};
  for (const tf of ['4h', '1h', '30m', '15m']) {
    if (o.doubleObs) { dbl[tf] = o.doubleObs[tf] || []; continue; } // precomputed pairs (tests / caching)
    try {
      dbl[tf] = findDoubleObs(real[tf], { symbol, tf });
    } catch (_) {
      dbl[tf] = [];
    }
  }
  const results = [];
  for (const dir of o.dirs || ['LONG', 'SHORT']) {
    try {
      results.push({ dir, ...analyzeDirection(dir, { symbol, cfg, nowSec, real, dbl, price: o.price }) });
    } catch (e) {
      results.push({ dir, analysis: null, reason: `error: ${e.message}` });
    }
  }
  return { symbol, nowSec, results };
}

function analyzeDirection(dir, ctx) {
  const { symbol, cfg, nowSec } = ctx;
  const sign = dir === 'LONG' ? 1 : -1;
  const px = (p) => r8(sign * p);
  const zoneReal = (z) => (sign === 1 ? { high: r8(z.high), low: r8(z.low) } : { high: r8(-z.low), low: r8(-z.high) });
  const C = {};
  for (const tf of Object.keys(ctx.real)) C[tf] = sign === 1 ? ctx.real[tf] : mirrorCandles(ctx.real[tf]);
  const bars = swingBarsOf(cfg);
  const diag = [];
  const step = (id, label, ok, detail) => diag.push({ id, label, ok, detail });
  const m15 = C['15m'];
  const last = m15[m15.length - 1];
  const price = Number.isFinite(+ctx.price) && +ctx.price > 0 ? sign * +ctx.price : last.close;
  const atr15 = atrOf(m15);
  const atr1h = atrOf(C['1h']);

  // ── 1) higher-time-frame structure + bias (1D, 4H) ──────────────────────────────────────
  const hs = {};
  for (const tf of ['1d', '4h', '1h']) {
    const alt = pivots(C[tf], tf === '1d' ? Math.max(2, bars - 1) : bars);
    const lab = labelPivots(alt);
    const ws = walkStructure(C[tf], alt, { confirm: cfg.bosConfirm === 'wick' ? 'wick' : 'close', holdBars: cfg.confirmCloseBars });
    hs[tf] = { alt, lab, ws, trend: ws.trend === 'NONE' ? lab.trend : ws.trend };
  }
  const t1d = hs['1d'].trend;
  const t4h = hs['4h'].trend;
  const align = t4h === 'BEARISH' || (t4h === 'RANGE' && t1d === 'BEARISH') ? 'CONFLICT' : t4h === 'BULLISH' ? (t1d === 'BULLISH' ? 'STRONG' : 'PARTIAL') : t1d === 'BULLISH' ? 'PARTIAL' : 'NEUTRAL';
  const htfBiasReal = (t) => (t === 'RANGE' || t === 'NONE' ? 'RANGE' : (sign === 1) === (t === 'BULLISH') ? 'BULLISH' : 'BEARISH');
  const htf = {
    bias: htfBiasReal(t4h === 'RANGE' ? t1d : t4h),
    d1: htfBiasReal(t1d),
    h4: htfBiasReal(t4h),
    align,
    // HH / HL / LH / LL labels are always shown on the REAL 4H pivots
    labels4h: (sign === 1 ? hs['4h'].lab : labelPivots(pivots(ctx.real['4h'], bars))).labeled.slice(-6).map((p) => ({ label: p.label, time: p.time, price: r8(p.price) })),
  };
  step('htf', '1D / 4H structure', align !== 'CONFLICT', `1D ${htf.d1} · 4H ${htf.h4} · alignment ${align}`);

  // ── 2) dealing range → premium / discount ────────────────────────────────────────────────
  // the range comes from MAJOR 4H swings (twice the normal pivot width) so a small pull-back leg is never mistaken for the range
  const range = dealingRange(C['4h'], pivots(C['4h'], Math.max(5, bars * 2))) || dealingRange(C['4h'], hs['4h'].alt);
  if (!range) {
    step('range', 'Dealing range (swing high / low)', false, 'no confirmed major swing high and low on 4H');
    return { analysis: null, reason: 'no major swing range on 4H', diagnostics: diag };
  }
  // real-price view of the range (premium is always the upper half of the REAL range)
  const realRange = sign === 1 ? { high: range.high, low: range.low, eq: range.eq, highTime: range.highTime, lowTime: range.lowTime } : { high: r8(-range.low), low: r8(-range.high), eq: r8(-range.eq), highTime: range.lowTime, lowTime: range.highTime };
  const realPrice = sign * price;
  const pd = { zone: realPrice >= realRange.eq ? 'PREMIUM' : 'DISCOUNT', pos: +((realPrice - realRange.low) / (realRange.high - realRange.low || 1)).toFixed(3), eq: realRange.eq, swingHigh: realRange.high, swingLow: realRange.low };
  step('range', 'Dealing range (swing high / low)', true, `${realRange.low} – ${realRange.high} · equilibrium ${realRange.eq} · price in ${pd.zone}`);

  // ── 3) structure on 15M (entry) + liquidity pools / sweeps ───────────────────────────────
  const alt15 = pivots(m15, bars);
  const ws15 = walkStructure(m15, alt15, { confirm: cfg.mssConfirm === 'wick' ? 'wick' : 'close', holdBars: cfg.confirmCloseBars });
  const tol = liqTolAtr(cfg);
  const pools = {
    '4h': liquidityPools(C['4h'], hs['4h'].alt, { tolAtr: tol, range }),
    '1h': liquidityPools(C['1h'], hs['1h'].alt, { tolAtr: tol, range }),
    '15m': liquidityPools(m15, alt15, { tolAtr: tol, range }),
  };
  const sweeps = [];
  for (const tf of ['4h', '1h', '15m']) for (const s of findSweeps(C[tf], pools[tf], { holdBars: Math.max(1, cfg.confirmCloseBars + 1) })) sweeps.push({ ...s, tf });
  const bullSweeps = sweeps.filter((s) => s.side === 'BULL'); // sell-side liquidity taken (in this direction's space)
  const bslOpen = [...pools['1h'], ...pools['4h']].filter((p) => p.type === 'BSL' && !p.taken && p.price > price).sort((a, b) => a.price - b.price);

  // ── 4) zones per source time frame ────────────────────────────────────────────────────────
  const cand = [];
  const maxAge = cfg.maxPoiAgeBars;
  for (const tf of SOURCE_TFS) {
    const cs = C[tf];
    const sec = POI_TF_SEC[tf];
    const obs = findOrderBlocks(cs, { lookback: cfg.obLookback, mitigation: cfg.obMitigation, minDisplacementAtr: cfg.obMinDisplacementAtr });
    const fvgs = findFvgs(cs, { minAtr: cfg.fvgMinAtr, lookback: cfg.fvgLookback });
    for (const ob of obs) {
      if (ob.type !== 'BULL' || ob.status === 'INVALIDATED' || !ob.valid) continue;
      if (cs.length - 1 - ob.index > maxAge) continue;
      cand.push({ src: 'OB', tf, high: ob.high, low: ob.low, createdTime: ob.time, availableTime: cs[ob.confBar].time + sec, status: ob.status, ob });
    }
    for (const f of fvgs) {
      if (f.type !== 'BULL' || (f.status !== 'FRESH' && f.status !== 'PARTIAL')) continue;
      cand.push({ src: 'FVG', tf, high: f.high, low: f.low, createdTime: f.startTime, availableTime: f.time + sec, status: f.status, fvg: f });
    }
    // double order blocks come from the real candles: LONG uses bullish pairs, SHORT bearish pairs (mirrored here)
    for (const d of ctx.dbl[tf] || []) {
      if (d.type !== (sign === 1 ? 'bullish' : 'bearish') || d.status !== 'UNMITIGATED') continue;
      const z = sign === 1 ? { high: d.inner.high, low: d.inner.low } : { high: -d.inner.low, low: -d.inner.high };
      const o = sign === 1 ? { high: d.outer.high, low: d.outer.low } : { high: -d.outer.low, low: -d.outer.high };
      cand.push({ src: 'DOUBLE_OB', tf, high: z.high, low: z.low, createdTime: d.inner.time, availableTime: (cs[Math.min(cs.length - 1, d.inner.confBar ?? d.inner.index)]?.time ?? d.inner.time) + sec, status: 'FRESH', outer: o, dbl: d });
    }
  }
  const live = cand.filter((c) => c.low <= price + atr1h * 0.25); // a bullish POI sits at / below price
  step('zones', 'Order blocks · FVGs · double OBs', live.length > 0, `${live.length} usable zone(s) (${live.filter((c) => c.src === 'OB').length} OB · ${live.filter((c) => c.src === 'FVG').length} FVG · ${live.filter((c) => c.src === 'DOUBLE_OB').length} double OB)`);

  // ── 5) POI engine: merge overlapping zones into ONE POI (no duplicates) ─────────────────
  const prio = (c) => (c.src === 'DOUBLE_OB' ? 0 : c.src === 'OB' ? 1 : 2) * 10 + SOURCE_TFS.indexOf(c.tf);
  const pois = [];
  for (const c of [...live].sort((a, b) => prio(a) - prio(b))) {
    const host = pois.find((p) => overlapFrac(p, c) * 100 >= cfg.poiOverlapPct);
    if (host) {
      host.sources.push({ src: c.src, tf: c.tf });
      if (c.src === 'FVG') host.fvg = host.fvg || c.fvg;
      if (c.src === 'OB') host.ob = host.ob || c.ob;
      if (c.src === 'DOUBLE_OB') { host.dbl = host.dbl || c.dbl; host.outer = host.outer || c.outer; }
      continue;
    }
    pois.push({ ...c, sources: [{ src: c.src, tf: c.tf }], fvg: c.fvg || null, ob: c.ob || null, dbl: c.dbl || null, outer: c.outer || null });
  }
  if (!pois.length) {
    step('poi', 'Point of Interest', false, 'no valid bullish/bearish POI at or near price');
    return { analysis: null, reason: 'no valid POI near price', diagnostics: diag, htf };
  }

  // ── 6) evaluate every POI (state machine + score), keep the best ───────────────────────
  const evals = pois.map((p) => evaluatePoi(p, { dir, sign, cfg, nowSec, C, m15, ws15, hs, bullSweeps, bslOpen, range, price, atr15, atr1h, align, symbol, pools }));
  const rank = (e) => STATE_RANK[e.state] * 1000 + e.score * 10 - Math.abs(e.zone.mid - price) / (atr1h || 1);
  evals.sort((a, b) => rank(b) - rank(a));
  const best = evals[0];
  step('poi', 'Point of Interest', true, `${best.poi.type} ${U(best.poi.tf)} ${best.poi.low}–${best.poi.high} · ${best.location.zone}${best.location.extreme ? ' (extreme)' : ''} · ${best.poi.mitigation}`);
  for (const d of best.diag) diag.push(d);

  // gates
  const reasons = [];
  if (best.state === 'INVALIDATED') reasons.push(best.invalidatedBy || 'POI invalidated');
  if (cfg.requireHtfAlignment && align === 'CONFLICT') reasons.push('4H structure conflicts with this direction');
  if (best.class === 'NONE') reasons.push(`score ${best.score} below the C threshold (${cfg.thresholdC})`);
  else if (best.score < cfg.minScore) reasons.push(`score ${best.score} below the minimum (${cfg.minScore})`);
  const listed = reasons.length === 0;

  const out = {
    id: poiId(symbol, dir, best.poi.tf, best.poi.createdTime),
    strategy: POI_STRATEGY,
    strategyName: POI_STRATEGY_NAME,
    symbol,
    dir,
    state: best.state,
    class: best.class,
    score: best.score,
    listed,
    htf,
    poi: best.poi,
    location: best.location,
    premiumDiscount: pd,
    liquidity: { sweep: best.sweep, associatedLevel: best.liqLevel, openBuySide: bslOpen.slice(0, 3).map((p) => ({ price: px(p.price), kind: p.kind, scope: p.scope })) },
    bos: best.bos,
    mss: best.mss,
    ob: best.ob,
    fvg: best.fvg,
    confirmationTf: '15m',
    signalTime: best.confirm ? best.confirm.time : best.poi.createdTime,
    scannedAt: nowSec,
    price: px(price),
    invalidation: best.invalidation,
    invalidatedBy: best.invalidatedBy || null,
    plan: best.plan,
    breakdown: best.breakdown,
    diagnostics: diag,
    reasons,
    alternatives: evals.slice(1, 4).map((e) => ({ id: poiId(symbol, dir, e.poi.tf, e.poi.createdTime), state: e.state, class: e.class, score: e.score, breakdown: e.breakdown, poi: { type: e.poi.type, sources: e.poi.sources, tf: e.poi.tf, high: e.poi.high, low: e.poi.low } })),
  };
  out.annotations = buildAnnotations({ out, best, evals, sign, px, realRange, hs, ctx, ws15, pools, sweeps, bslOpen });
  return { analysis: out, reason: listed ? null : reasons.join(' · '), diagnostics: diag, htf };
}

/** one POI → state (WATCHING → READY → CONFIRMED | INVALIDATED), probability class and score */
function evaluatePoi(p, x) {
  const { cfg, sign, m15, ws15, hs, bullSweeps, range, price, atr15, atr1h, align, C } = x;
  const px = (v) => r8(sign * v);
  const zoneL = { high: p.high, low: p.low, mid: (p.high + p.low) / 2 }; // long space
  const zr = sign === 1 ? { high: r8(p.high), low: r8(p.low) } : { high: r8(-p.low), low: r8(-p.high) };
  const diag = [];
  const step = (id, label, ok, detail) => diag.push({ id, label, ok, detail });
  const w = cfg.weights;
  const used = new Set();
  const breakdown = [];
  let score = 0;
  const add = (key, pts, why) => {
    if (used.has(key) || !pts) return;
    used.add(key);
    score += pts;
    breakdown.push({ factor: key, points: pts, why });
  };

  // premium / discount location (one factor: extreme > correct side > wrong side)
  const posMid = rangePos(range, zoneL.mid);
  const extreme = posMid <= 0.25;
  const insideDiscount = zoneL.high <= range.eq;
  const location = { zone: posMid < 0.5 ? 'DISCOUNT' : 'PREMIUM', pos: +posMid.toFixed(3), extreme, fullyInside: insideDiscount };
  location.zone = sign === 1 ? location.zone : location.zone === 'DISCOUNT' ? 'PREMIUM' : 'DISCOUNT'; // real-space name
  if (extreme) add('location', w.locationExtreme, 'POI in the outer 25 % of the range');
  else if (posMid < 0.5) add('location', w.locationSide, 'POI on the correct side of equilibrium');
  else add('location', w.locationWrong, 'POI on the wrong side of equilibrium');
  step('location', 'Premium / Discount', posMid < 0.5, `${location.zone} · ${(posMid * 100).toFixed(0)} % of range${extreme ? ' · extreme' : ''}`);

  // HTF alignment (one factor)
  add('htf', align === 'STRONG' ? w.htfStrong : align === 'PARTIAL' ? w.htfPartial : align === 'CONFLICT' ? w.htfConflict : 0, `HTF alignment ${align}`);

  // zone quality
  const fresh = p.status === 'FRESH';
  add('fresh', fresh ? w.fresh : w.mitigated, fresh ? 'unmitigated zone' : 'zone already tested once');
  if (p.ob) add('obQuality', w.obQuality, `OB with ${p.ob.displacementAtr} ATR displacement after a structure break`);
  if (p.fvg && p.ob) add('fvgOverlap', w.fvgOverlap, 'FVG overlaps the order block');
  if (p.dbl) add('doubleOb', w.doubleOb, 'a smaller order block sits inside the larger one (double OB)');
  if (['4h', '1h', '30m'].includes(p.tf)) add('midTfSource', w.midTfSource, `zone formed on ${U(p.tf)}`);
  step('zone', 'Zone quality', true, `${p.status}${p.ob ? ` · OB ${p.ob.displacementAtr} ATR` : ''}${p.fvg ? ' · FVG overlap' : ''}${p.dbl ? ' · double OB' : ''}`);

  // touch → READY
  const sec = POI_TF_SEC['15m'];
  let touchIdx = -1;
  for (let i = 0; i < m15.length; i++) {
    if (m15[i].time < p.availableTime) continue;
    if (m15[i].low <= p.high && m15[i].high >= p.low) { touchIdx = i; break; }
  }
  const touched = touchIdx >= 0;

  // invalidation: close beyond the far side · opposite 4H MSS after creation · expiry
  const buf = cfg.invalidateBufferAtr * atr15;
  let invalidatedBy = null;
  let invIdx = -1;
  if (cfg.invalidateOnClose) {
    for (let i = 0; i < m15.length; i++) {
      if (m15[i].time < p.availableTime) continue;
      if (m15[i].close < p.low - buf) { invIdx = i; invalidatedBy = `closed below the POI (${px(p.low - buf)})`; break; }
    }
  }
  if (!invalidatedBy && cfg.invalidateOnBiasFlip) {
    const flip = hs['4h'].ws.events.find((e) => e.dir === 'BEAR' && e.kind === 'MSS' && !e.pending && e.time > p.availableTime);
    if (flip) invalidatedBy = `opposite 4H MSS at ${px(flip.level)}`;
  }
  const barsSince = m15.filter((c) => c.time >= p.availableTime).length;
  if (!invalidatedBy && !touched && barsSince > cfg.maxPoiAgeBars) invalidatedBy = `POI untouched for ${barsSince} bars (expired)`;

  // liquidity sweep associated with this POI (sell-side taken near / inside the zone, at or after its creation)
  const near = (s) => s.extreme <= p.high + atr1h * 0.5 && s.extreme >= p.low - atr1h * 1.5 && s.time >= p.createdTime;
  const sweep = [...bullSweeps].filter(near).sort((a, b) => (b.status === 'REJECTED') - (a.status === 'REJECTED') || b.time - a.time)[0] || null;
  const sweepOut = sweep ? { status: sweep.status, tf: sweep.tf, level: px(sweep.level), extreme: px(sweep.extreme), time: sweep.time, kind: sweep.kind, scope: sweep.scope } : { status: 'NONE' };
  if (sweep?.status === 'REJECTED') add('sweep', w.sweepRejected, `${U(sweep.tf)} ${sweep.kind.toLowerCase().replace('_', ' ')} swept and rejected`);
  else if (sweep && sweep.status !== 'FAILED') add('sweep', w.sweepOnly, 'liquidity swept — rejection not confirmed yet');
  step('sweep', 'Liquidity sweep', sweep?.status === 'REJECTED' ? true : sweep ? null : false, sweep ? `${sweep.status} · ${U(sweep.tf)} ${sweepOut.level}` : 'no sweep of sell-side liquidity around this POI');

  // entry-TF confirmation (MSS preferred, BOS accepted when MSS is not required)
  let confirm = null;
  if (touched && !invalidatedBy) {
    const after = (e) => e.dir === 'BULL' && !e.pending && e.time > m15[touchIdx].time && (!sweep || sweep.status === 'FAILED' || e.time > sweep.time);
    const mss = ws15.events.find((e) => after(e) && e.kind === 'MSS');
    const bos = ws15.events.find((e) => after(e) && e.kind === 'BOS');
    confirm = mss || (!cfg.requireMss ? bos : null);
  }
  const confMss = confirm && confirm.kind === 'MSS';
  if (confirm) add('structure', confMss ? w.mss : w.bos, `15M ${confirm.kind} after the POI was reached`);
  step('confirm', '15M structure shift', confirm ? true : touched ? null : false, confirm ? `${confirm.kind} @ ${px(confirm.level)} (closed candle)` : touched ? 'POI reached — waiting for a 15M MSS' : 'price has not reached the POI yet');

  const flowBull = hs['1h'].trend === 'BULLISH';
  if (flowBull) add('orderFlow', w.orderFlow, '1H internal order flow is bullish');
  if (x.bslOpen.length) add('liquidityTarget', w.liquidityTarget, 'untouched buy-side liquidity above as a target');

  score = Math.max(0, Math.min(100, Math.round(score)));
  const sweepOk = sweep?.status === 'REJECTED';
  const needsSweep = cfg.requireSweep && !sweepOk;

  // paper plan
  const entry = confirm ? m15[confirm.index].close : zoneL.mid;
  const slBase = Math.min(p.low, sweep ? sweep.extreme : Infinity);
  const sl = slBase - cfg.slBufferAtr * atr15;
  const risk = entry - sl;
  const tp1 = x.bslOpen.find((b) => b.price > entry + risk * 0.5)?.price ?? null;
  const tp2 = range.high > (tp1 ?? entry) ? range.high : null;
  const rr = tp1 && risk > 0 ? +((tp1 - entry) / risk).toFixed(2) : null;
  const plan = risk > 0 ? { entry: px(entry), sl: px(sl), tp1: tp1 != null ? px(tp1) : null, tp2: tp2 != null ? px(tp2) : null, rr, basis: confirm ? '15M confirmation close' : 'POI midpoint', rrOk: rr != null && rr >= cfg.minRR } : null;
  step('plan', 'Risk : reward', plan?.rrOk ? true : plan ? null : false, plan ? `entry ${plan.entry} · SL ${plan.sl} · TP1 ${plan.tp1 ?? '—'} · R:R ${rr ?? '—'}` : 'no valid stop');

  // state
  let state = 'WATCHING';
  if (invalidatedBy) state = 'INVALIDATED';
  else if (confirm && !needsSweep) state = 'CONFIRMED';
  else if (touched) state = 'READY';

  // class — internal setup quality, NOT a win probability
  const independent = ['fvgOverlap', 'doubleOb', 'sweep', 'structure', 'orderFlow'].filter((k) => used.has(k) && !(k === 'sweep' && !sweepOk) && !(k === 'structure' && !confMss)).length;
  let cls = 'NONE';
  if (score >= cfg.thresholdAplus && align === 'STRONG' && fresh && extreme && sweepOk && state === 'CONFIRMED' && confMss && independent >= 3 && (plan?.rrOk ?? false)) cls = 'A+';
  else if (score >= cfg.thresholdB && align !== 'CONFLICT' && posMid < 0.5) cls = 'B';
  else if (score >= cfg.thresholdC) cls = 'C';
  if (state === 'INVALIDATED') cls = cls === 'NONE' ? 'NONE' : 'C';

  const invalidation = [
    cfg.invalidateOnClose ? `15M close below ${px(p.low - buf)} (far side of the POI${sign === -1 ? ', mirrored for SHORT' : ''})` : null,
    cfg.invalidateOnBiasFlip ? 'an opposite 4H MSS after the POI was created' : null,
    `POI untouched for more than ${cfg.maxPoiAgeBars} × 15M bars`,
    confirm ? `15M close beyond the confirmation low (${px(Math.min(...m15.slice(Math.max(0, touchIdx), confirm.index + 1).map((c) => c.low)))})` : null,
  ].filter(Boolean);

  const mit = p.status === 'FRESH' ? 'FRESH' : p.status;
  return {
    state,
    class: cls,
    score,
    zone: zoneL,
    location,
    sweep: sweepOut,
    liqLevel: sweep ? { price: px(sweep.level), kind: sweep.kind, scope: sweep.scope, swept: true } : (() => { const q = x.pools['1h'].filter((q2) => q2.type === 'SSL' && q2.price <= p.high).sort((a, b) => b.price - a.price)[0]; return q ? { price: px(q.price), kind: q.kind, scope: q.scope, swept: q.taken } : null; })(),
    bos: ws15.events.filter((e) => e.kind === 'BOS' && e.dir === 'BULL').slice(-1).map((e) => ({ tf: '15m', level: px(e.level), time: e.time, pending: !!e.pending }))[0] || null,
    mss: ws15.events.filter((e) => e.kind === 'MSS' && e.dir === 'BULL').slice(-1).map((e) => ({ tf: '15m', level: px(e.level), time: e.time, pending: !!e.pending }))[0] || null,
    confirm,
    invalidatedBy,
    invalidation,
    plan,
    breakdown,
    diag,
    ob: p.ob ? { status: p.ob.status, tf: p.tf, displacementAtr: p.ob.displacementAtr, high: zr.high, low: zr.low } : { status: 'NONE' },
    fvg: p.fvg ? { status: p.fvg.status, filled: p.fvg.filled, ...(sign === 1 ? { high: p.fvg.high, low: p.fvg.low } : { high: r8(-p.fvg.low), low: r8(-p.fvg.high) }) } : { status: 'NONE' },
    poi: {
      type: p.dbl ? 'DOUBLE_OB' : p.ob ? (p.fvg ? 'OB+FVG' : 'OB') : 'FVG',
      sources: p.sources,
      tf: p.tf,
      high: zr.high,
      low: zr.low,
      mid: r8((zr.high + zr.low) / 2),
      createdTime: p.createdTime,
      availableTime: p.availableTime,
      mitigation: mit,
      touchedTime: touched ? m15[touchIdx].time : null,
      invalidated: !!invalidatedBy,
      outer: p.outer ? (sign === 1 ? p.outer : { high: r8(-p.outer.low), low: r8(-p.outer.high) }) : null,
    },
  };
}

function buildAnnotations({ out, best, evals, sign, px, realRange, hs, ctx, ws15, pools, sweeps, bslOpen }) {
  const A = [];
  const add = (a) => A.push(a);
  const t0 = Math.min(realRange.highTime, realRange.lowTime);
  // swings + premium / discount + equilibrium (real prices)
  add({ group: 'swings', kind: 'hline', tf: '4h', t1: realRange.highTime, t2: null, p1: realRange.high, label: 'SWING HIGH', style: 'dashed' });
  add({ group: 'swings', kind: 'hline', tf: '4h', t1: realRange.lowTime, t2: null, p1: realRange.low, label: 'SWING LOW', style: 'dashed' });
  add({ group: 'premium', kind: 'zone', tf: '4h', t1: t0, t2: null, p1: realRange.high, p2: realRange.eq, label: 'PREMIUM' });
  add({ group: 'discount', kind: 'zone', tf: '4h', t1: t0, t2: null, p1: realRange.eq, p2: realRange.low, label: 'DISCOUNT' });
  add({ group: 'eq', kind: 'hline', tf: '4h', t1: t0, t2: null, p1: realRange.eq, label: 'EQ 50%', style: 'dotted' });
  // liquidity (untaken pools only, nearest few)
  const lp = [...pools['4h'], ...pools['1h']].filter((p) => !p.taken);
  const seen = new Set();
  for (const p of lp.slice(-24)) {
    const key = `${p.type}:${p.price.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const real = px(p.price);
    add({ group: 'liquidity', kind: 'hline', tf: '1h', t1: p.time, t2: null, p1: real, label: `${sign === 1 ? p.type : p.type === 'BSL' ? 'SSL' : 'BSL'}${p.kind.startsWith('EQUAL') ? ' EQ' : ''} · ${p.scope === 'EXTERNAL' ? 'ext' : 'int'}`, style: 'dotted' });
  }
  // OB / FVG zones of the evaluated POIs
  for (const e of evals.slice(0, 4)) {
    const z = e.poi;
    if (e.ob?.status && e.ob.status !== 'NONE') add({ group: 'ob', kind: 'zone', tf: e.ob.tf, t1: z.createdTime, t2: null, p1: z.high, p2: z.low, side: sign === 1 ? 'bull' : 'bear', label: `${U(e.ob.tf)} ${sign === 1 ? 'Bull' : 'Bear'} OB · ${e.ob.status.toLowerCase()}` });
    if (e.fvg?.status && e.fvg.status !== 'NONE') add({ group: 'fvg', kind: 'zone', tf: z.tf, t1: z.createdTime, t2: null, p1: e.fvg.high, p2: e.fvg.low, side: sign === 1 ? 'bull' : 'bear', label: `${U(z.tf)} FVG · ${e.fvg.status.toLowerCase()}` });
  }
  // POI rectangles (best one bold, label carries the class)
  evals.slice(0, 3).forEach((e, i) => add({ group: 'poi', kind: 'zone', tf: e.poi.tf, t1: e.poi.createdTime, t2: null, p1: e.poi.high, p2: e.poi.low, label: `${i === 0 ? `POI ${e.class} · ${e.state}` : `POI ${e.class}`} · ${e.poi.type} ${U(e.poi.tf)}`}));
  // BOS / MSS on 15M (+ 4H major) — real calculated levels and candle times
  const mk = (e, tf) => {
    const bull = (e.dir === 'BULL') === (sign === 1);
    add({ group: e.kind === 'MSS' ? 'mss' : 'bos', kind: 'hline', tf, t1: e.levelTime, t2: e.time, p1: px(e.level), label: `${e.kind} ${U(tf)}${e.pending ? ' (pending)' : ''}`, style: 'dashed', side: bull ? 'bull' : 'bear' });
    add({ group: e.kind === 'MSS' ? 'mss' : 'bos', kind: 'marker', tf, t: e.time, p: px(e.level), shape: bull ? 'up' : 'down', label: e.kind, small: true });
  };
  ws15.events.slice(-6).forEach((e) => mk(e, '15m'));
  hs['4h'].ws.events.slice(-3).forEach((e) => mk(e, '4h'));
  // liquidity sweeps
  for (const s of sweeps.filter((x) => x.status !== 'FAILED').slice(-6)) {
    const real = sign === 1 ? s.extreme : -s.extreme;
    add({ group: 'sweep', kind: 'marker', tf: s.tf, t: s.time, p: r8(real), shape: s.poolType === 'SSL' === (sign === 1) ? 'up' : 'down', label: `sweep ${s.status.toLowerCase()}`, small: true });
  }
  // entry confirmation + paper plan
  if (best.confirm) add({ group: 'confirm', kind: 'marker', tf: '15m', t: best.confirm.time, p: px(best.confirm.level), shape: sign === 1 ? 'up' : 'down', label: 'CONFIRMED', bold: true });
  if (out.plan) {
    add({ group: 'plan', kind: 'hline', tf: '15m', t1: best.poi.createdTime, t2: null, p1: out.plan.entry, label: 'entry', tone: 'tp' });
    add({ group: 'plan', kind: 'hline', tf: '15m', t1: best.poi.createdTime, t2: null, p1: out.plan.sl, label: 'SL', tone: 'sl' });
    if (out.plan.tp1) add({ group: 'plan', kind: 'hline', tf: '15m', t1: best.poi.createdTime, t2: null, p1: out.plan.tp1, label: 'TP1', tone: 'tp' });
  }
  return A;
}
