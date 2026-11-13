/**
 * SK SYSTEM PRO — analysis engine (pure; candles in, analysis out).
 *
 *  1W direction → 1D bias → 4H trend + CHoCH → 4H swings (A, B) → 4H Fibonacci → Elliott ABCD
 *  → C zone → 2H validation → 1H CHoCH + Fib → 30M refinement → 15M confirmation → 5M entry → D target   (SETUP 1)
 *  SETUP 2 runs the SAME chain one level down (see SK_TF_PROFILES in config.js):
 *  1D direction → 4H bias → 1H trend + CHoCH + ABCD → C zone → 30M validation → 15M CHoCH + Fib → 5M / 3M confirmation → D target
 *
 * The 4H structure is the PRIMARY setup; lower time frames only confirm / refine it and are fetched
 * only after the 4H price has reached the C zone (cheap scans, and they can never create an unrelated trade).
 * Confirmed closes + confirmed pivots only → a past result never repaints.
 *
 * SHORT = the same code on mirrored candles (price × −1). `px()` maps analysis-space prices back.
 */
import { swingBars, TF_SEC, SK_STAGES, SK_STRATEGY, SK_STRATEGY_NAME, stageRank, skTfs, skSetupNo } from './config.js';
import {
  cleanCandles,
  mirrorCandles,
  atr,
  sma,
  swings,
  trendOf,
  findBullishChoch,
  findBosPoints,
  findSweeps,
  findBullFvgs,
  findBullOb,
  highestAfter,
  lowestAfter,
  idxAtOrAfter,
} from './structure.js';

const r8 = (n) => +(+n).toFixed(8);
const iso = (t) => new Date(t * 1000).toISOString();

/** deterministic id: the same 4H structure (symbol + direction + A swing) is always the same setup */
export function skSetupId(symbol, dir, aTime, setup = 1) {
  // Setup 1 keeps the original id format (old data stays valid); Setup 2 has its own prefix, so the two never collide
  return `${skSetupNo(setup) === 2 ? 'sk2' : 'sk'}_${String(symbol).toUpperCase()}_${dir}_${aTime}`;
}

export function skQuality(score) {
  return score >= 80 ? 'STRONG' : score >= 65 ? 'VALID' : 'WEAK';
}

const zn = (a, b) => ({ top: Math.max(a, b), bottom: Math.min(a, b) }); // real-space zone: top = higher price
const LTF_BARS = 2; // pivot sensitivity on the lower time frames

/** 1W / 1D direction from confirmed swings (real price space) */
function htfTrend(candles, bars) {
  if (candles.length < 20) return 'RANGE';
  return trendOf(swings(candles, bars));
}

const U = (tf) => String(tf).toUpperCase();
/** step labels follow the setup's time-frame roles (Setup 1: 4H chain · Setup 2: 1H chain) */
function stepLabels(cfg) {
  const t = skTfs(cfg);
  const L = {
    trend: `${U(t.primary)} prior trend`,
    choch: `${U(t.primary)} CHoCH`,
    swings: `${U(t.primary)} swings A / B`,
    fib: `${U(t.primary)} Fibonacci`,
    abcd: 'Elliott ABCD',
    czone: 'C zone',
    entry: 'Entry',
    target: 'D target',
  };
  L[t.htfHigh] = `${U(t.htfHigh)} major direction`;
  L[t.htfLow] = `${U(t.htfLow)} market bias`;
  L[t.validate] = `${U(t.validate)} validation`;
  L[t.struct] = `${U(t.struct)} CHoCH + Fib`;
  t.mids.forEach((m, i) => {
    L[m] = `${U(m)} ${i === t.mids.length - 1 ? 'precision entry' : i === 0 && t.mids.length > 2 ? 'refinement' : 'confirmation'}`;
  });
  return L;
}

/**
 * @param {object} o { symbol, getCandles(tf, limit) → closed candles, cfg, nowSec?, price?, dirs? }
 * @returns {{symbol, price, results:[{dir, analysis, reason}]}}
 */
export async function analyzeSymbol(o) {
  const { symbol, cfg } = o;
  const nowSec = Number.isFinite(+o.nowSec) ? +o.nowSec : Math.floor(Date.now() / 1000);
  const memo = new Map();
  const get = (tf, limit) => {
    const key = `${tf}|${limit}`;
    if (!memo.has(key)) {
      memo.set(
        key,
        Promise.resolve()
          .then(() => o.getCandles(tf, limit))
          .then(cleanCandles)
          .catch((err) => {
            if (err && typeof err === 'object') err.fetchFailed = true; // a data failure is a FAILED analysis, never a silent "no setup"
            throw err;
          })
      );
    }
    return memo.get(key);
  };
  const results = [];
  for (const dir of o.dirs || ['LONG', 'SHORT']) {
    try {
      results.push({ dir, ...(await analyzeDir(dir, { symbol, cfg, nowSec, get, price: o.price })) });
    } catch (e) {
      if (e?.banned || e?.throttled || e?.fetchFailed) throw e;
      results.push({ dir, analysis: null, reason: `error: ${e.message}` });
    }
  }
  return { symbol, results };
}

async function analyzeDir(dir, ctx) {
  const { symbol, cfg, nowSec, get } = ctx;
  const sign = dir === 'LONG' ? 1 : -1;
  const px = (p) => r8(sign * p);
  const M = (cs) => (sign === 1 ? cs : mirrorCandles(cs));
  const want = dir === 'LONG' ? 'UP' : 'DOWN';
  const opp = dir === 'LONG' ? 'DOWN' : 'UP';
  const bars = swingBars(cfg);
  const tol = cfg.abcdTolerance;
  const tfs = skTfs(cfg);
  const setupNo = skSetupNo(cfg.setup);

  // ── 1) high-TF direction + bias (real space) — Setup 1: 1W + 1D · Setup 2: 1D + 4H ───────
  const [weekly, daily] = await Promise.all([get(tfs.htfHigh, 150), get(tfs.htfLow, 250)]);
  const wDir = htfTrend(weekly, 2);
  const dBias = htfTrend(daily, 3);
  const aligned =
    cfg.htfAlignment === 'off' ||
    (cfg.htfAlignment === 'strict' ? wDir === want && dBias === want : dBias === want && wDir !== opp);
  const htf = { weekly: wDir, daily: dBias, aligned, mode: cfg.htfAlignment, want, tfHigh: tfs.htfHigh, tfLow: tfs.htfLow }; // weekly/daily = the HIGH / LOW role of this setup
  if (!aligned) return { analysis: null, reason: `HTF not aligned (${U(tfs.htfHigh)} ${wDir} · ${U(tfs.htfLow)} ${dBias})`, htf };

  // ── 2) 4H trend + CHoCH ────────────────────────────────────────────────────────────────
  const primary = cfg.primaryTf;
  const real4 = await get(primary, cfg.maxCandles);
  if (real4.length < 60) return { analysis: null, reason: 'not enough candles', htf };
  const c4 = M(real4);
  const alt4 = swings(c4, bars);
  const atr4 = atr(c4, 14);
  if (!(atr4 > 0)) return { analysis: null, reason: 'no ATR', htf };
  const buf = cfg.chochMode === 'close_atr' ? cfg.chochAtrBuffer * atr4 : 0;
  const choch = findBullishChoch(c4, alt4, { maxAgeBars: cfg.chochMaxAgeBars, buffer: buf });
  if (!choch) {
    const broken = findBullishChoch(c4, alt4, { maxAgeBars: cfg.chochMaxAgeBars, buffer: buf, holdCheck: false });
    return { analysis: null, reason: broken ? 'A swing low was broken after the CHoCH (setup invalid)' : `no ${U(primary)} CHoCH`, htf };
  }

  // ── 3) swings A / B ────────────────────────────────────────────────────────────────────
  const A = choch.A; // the swing low that ended the down-trend
  const bi = highestAfter(c4, A.i);
  if (bi < 0) return { analysis: null, reason: 'no B', htf };
  const B = { i: bi, time: c4[bi].time, price: c4[bi].high };
  const bConfirmed = alt4.some((p) => p.type === 'high' && p.i === bi);
  const AB = B.price - A.price;
  if (!(AB > 0) || AB < cfg.minAbAtr * atr4) return { analysis: null, reason: 'AB leg too small', htf };

  // ── 4) Fibonacci + ABCD ────────────────────────────────────────────────────────────────
  const lvl = (ratio) => B.price - AB * ratio;
  const ratios = [...new Set([0, ...cfg.fibLevels, 1])].sort((x, y) => x - y);
  const ci = bi < c4.length - 1 ? lowestAfter(c4, bi) : -1;
  const C = ci >= 0 ? { i: ci, time: c4[ci].time, price: c4[ci].low, confirmed: alt4.some((p) => p.type === 'low' && p.i === ci) } : null;
  const retr = C ? (B.price - C.price) / AB : 0;
  if (C && C.price <= A.price) return { analysis: null, reason: 'C broke A (ABCD invalid)', htf };
  if (C && retr > cfg.abcdMaxRetrace + tol) return { analysis: null, reason: `BC retrace ${retr.toFixed(3)} > max (ABCD invalid)`, htf };

  let stage = 'CHOCH_CONFIRMED';
  if (bConfirmed) stage = 'SWING_CONFIRMED';
  if (bConfirmed && C && retr > 0) stage = 'FIBONACCI_ACTIVE';
  if (bConfirmed && C && retr >= cfg.abcdMinRetrace - tol) stage = 'ABCD_DEVELOPING';
  const zoneTop = lvl(cfg.cZoneFrom);
  const zoneBottom = lvl(cfg.cZoneTo);
  let reachedIdx = -1;
  if (bConfirmed && C) {
    for (let i = bi + 1; i < c4.length; i++) {
      if (c4[i].low <= lvl(cfg.cZoneFrom - tol)) {
        reachedIdx = i;
        break;
      }
    }
  }
  const zoneReached = reachedIdx >= 0 && retr >= cfg.cZoneFrom - tol;
  if (zoneReached) stage = 'C_ZONE_REACHED';
  const D = C ? { price: C.price + AB * cfg.dExtension } : null;

  const price = Number.isFinite(+ctx.price) ? sign * +ctx.price : c4[c4.length - 1].close;

  const a = {
    v: 1,
    strategy: SK_STRATEGY,
    strategyName: SK_STRATEGY_NAME,
    setup: setupNo,
    tfs: { htfHigh: tfs.htfHigh, htfLow: tfs.htfLow, primary, validate: tfs.validate, struct: tfs.struct, mids: tfs.mids },
    symbol,
    dir,
    primaryTf: primary,
    asOf: nowSec,
    asOfIso: iso(nowSec),
    htf,
    stage,
    h4: {
      priorTrend: dir === 'LONG' ? 'DOWN' : 'UP',
      choch: {
        tf: primary,
        level: px(choch.level),
        levelTime: choch.H2.time,
        breakTime: choch.breakTime,
        breakClose: px(choch.breakClose),
      },
      priorLegs: [choch.H1, choch.L1, choch.H2, choch.A].map((p) => ({ time: p.time, price: px(p.price), type: sign === 1 ? p.type : p.type === 'high' ? 'low' : 'high' })),
      bos: [
        ...findBosPoints(c4, alt4.filter((p) => p.i <= A.i), { side: 'bear' }).filter((b) => b.time <= A.time),
        ...findBosPoints(c4, alt4, { fromIdx: A.i, side: 'bull' }),
      ].map((b) => ({ ...b, level: px(b.level), side: sign === 1 ? b.side : b.side === 'bull' ? 'bear' : 'bull' })),
      swings: alt4.slice(-12).map((p) => ({ time: p.time, price: px(p.price), type: sign === 1 ? p.type : p.type === 'high' ? 'low' : 'high' })),
      A: { time: A.time, price: px(A.price) },
      B: { time: B.time, price: px(B.price), confirmed: bConfirmed },
      C: C ? { time: C.time, price: px(C.price), confirmed: C.confirmed, ratio: r8(retr) } : null,
      D: D ? { price: px(D.price), extension: cfg.dExtension, projectedTime: C.time + (B.time - A.time) } : null,
      fib: {
        anchor: dir === 'LONG' ? 'low→high' : 'high→low',
        levels: ratios.map((ra) => ({ ratio: ra, price: px(lvl(ra)), selected: cfg.fibLevels.includes(ra) })),
        extensions: C ? [1, 1.272, 1.618].map((ex) => ({ ratio: ex, price: px(C.price + AB * ex) })) : [],
      },
      abcd: {
        valid: !!C && retr >= cfg.abcdMinRetrace - tol && retr <= cfg.abcdMaxRetrace + tol,
        retrace: C ? r8(retr) : null,
        abAtr: r8(AB / atr4),
        rule: `BC retrace ${cfg.abcdMinRetrace}–${cfg.abcdMaxRetrace} of AB (±${tol}), C above A`,
      },
      czone: {
        from: cfg.cZoneFrom,
        to: cfg.cZoneTo,
        ...zn(px(zoneTop), px(zoneBottom)),
        reached: zoneReached,
        reachedTime: zoneReached ? c4[reachedIdx].time : null,
        status: !C ? 'PENDING' : zoneReached ? (retr > cfg.cZoneTo + tol ? 'OVERSHOT' : 'CONFIRMED') : 'WAITING',
      },
    },
    ltf: {},
    entry: null,
    notes: [],
    invalidation: null,
  };

  // ── 5) lower time frames (only once the 4H price is in the C zone) ────────────────────
  let ltfCtx = null;
  if (zoneReached) {
    ltfCtx = await analyzeLtf({ dir, sign, px, M, get, cfg, a, A, B, C, AB, zoneTop, tol, reachedTime: c4[reachedIdx].time, nowSec, atr4, tfs, setupNo });
    a.ltf = ltfCtx.ltf;
    a.notes.push(...ltfCtx.notes);
    if (ltfCtx.stage) stage = stageRank(ltfCtx.stage) > stageRank(stage) ? ltfCtx.stage : stage;
    if (ltfCtx.entry) a.entry = ltfCtx.entry;
  }
  a.stage = stage;

  // ── 6) score + steps + annotations ───────────────────────────────────────────────────
  a.score = scoreAnalysis(a, cfg);
  a.quality = skQuality(a.score);
  if (stage === 'ENTRY_READY' && a.score < cfg.minScore) {
    a.stage = 'LTF_CONFIRMATION';
    a.entry = null;
    a.notes.push(`score ${a.score} < min ${cfg.minScore} — entry not armed`);
  }
  a.steps = buildSteps(a, cfg, sign);
  a.annotations = buildAnnotations(a);
  return { analysis: a, reason: null, htf, currentPrice: px(price) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════
async function analyzeLtf(x) {
  const { M, get, cfg, A, B, C, AB, zoneTop, tol, reachedTime, px, tfs, nowSec, setupNo } = x;
  const S = tfs.struct; // Setup 1: 1H · Setup 2: 15M
  const notes = [];
  const ltf = {};
  const aFloor = A.price;
  const tfBars = LTF_BARS;
  // Setup 2 works on small bars: make sure the window still reaches back to the moment the C zone was hit
  const lim = (tf) => (setupNo === 2 ? Math.max(cfg.maxCandles, Math.min(1500, Math.ceil((nowSec - reachedTime) / TF_SEC[tf]) + 120)) : cfg.maxCandles);

  // structural CHoCH + Fib (Setup 1: 1H · Setup 2: 15M) -----------------------------------
  const real1 = await get(S, lim(S));
  const c1 = M(real1);
  if (c1.length < 60) return { ltf, notes: [`${U(S)}: not enough candles`], stage: null, entry: null };
  const atr1 = atr(c1, 14);
  const startIdx = Math.max(0, idxAtOrAfter(c1, B.time) - 12);
  const w1 = c1.slice(startIdx);
  const alt1 = swings(w1, tfBars);
  const minLowIdx = idxAtOrAfter(w1, reachedTime);
  // the 1H CHoCH must come from the swing low INSIDE the 4H C zone (never from a later micro structure)
  const ch1 = findBullishChoch(w1, alt1, { maxAgeBars: 1000, minLowIdx, minLowPrice: aFloor, pick: 'first', accept: ({ L2 }) => L2.price <= zoneTop + tol * AB });
  if (!ch1) {
    ltf[S] = { status: 'WAITING', detail: `no ${U(S)} CHoCH yet inside the C zone` };
    return { ltf, notes, stage: null, entry: null };
  }
  const b1i = highestAfter(w1, ch1.A.i);
  const B1 = { time: w1[b1i].time, price: w1[b1i].high };
  const AB1 = B1.price - ch1.A.price;
  const lv1 = (ratio) => B1.price - AB1 * ratio;
  const zone1 = { top: lv1(cfg.entryFibFrom), bottom: lv1(cfg.entryFibTo) };
  ltf[S] = {
    status: 'CONFIRMED',
    tf: S,
    choch: { level: px(ch1.level), levelTime: ch1.H2.time, breakTime: ch1.breakTime },
    A1: { time: ch1.A.time, price: px(ch1.A.price) },
    B1: { time: B1.time, price: px(B1.price) },
    fib: [0.382, cfg.entryFibFrom, 0.618, cfg.entryFibTo].filter((v, i, arr) => arr.indexOf(v) === i).sort((p, q) => p - q).map((ra) => ({ ratio: ra, price: px(lv1(ra)) })),
    zone: zn(px(zone1.top), px(zone1.bottom)),
    detail: `${U(S)} CHoCH @ ${px(ch1.level)}`,
  };
  const stage = 'LTF_CONFIRMATION';
  const zoneTol = tol * AB1;

  const confirmed = [{ tf: S, ch: ch1, lowPrice: ch1.A.price, time: ch1.breakTime + TF_SEC[S], structural: true }];
  const mandatory = [S, ...cfg.confirmTfs];
  const V = tfs.validate; // Setup 1: 2H · Setup 2: 30M

  // validation: a confirmed swing low inside the C zone, above A, still holding ----------------
  if (cfg.confirmTfs.includes(V)) {
    const c2 = M(await get(V, lim(V)));
    const alt2 = swings(c2, tfBars);
    const cand = alt2.filter((p) => p.type === 'low' && p.time >= reachedTime && p.price > aFloor && p.price <= zoneTop + tol * AB).pop();
    const holding = cand && c2[c2.length - 1].close > cand.price;
    ltf[V] = cand && holding
      ? { status: 'CONFIRMED', tf: V, low: { time: cand.time, price: px(cand.price) }, detail: `${U(V)} swing low ${px(cand.price)} holding` }
      : { status: 'WAITING', detail: cand ? `${U(V)} swing low lost` : `no confirmed ${U(V)} swing low in the C zone` };
    if (cand && holding) confirmed.push({ tf: V, time: cand.time + TF_SEC[V], lowPrice: cand.price, noChoch: true });
  }

  // lower CHoCH confirmations (Setup 1: 30M/15M/5M · Setup 2: 5M/3M): bullish CHoCH inside the structural Fib entry zone, after its high (B1)
  const volTf = new Set(tfs.volTfs);
  for (const tf of tfs.mids) {
    if (!cfg.confirmTfs.includes(tf)) continue;
    const c = M(await get(tf, lim(tf)));
    if (c.length < 60) {
      ltf[tf] = { status: 'WAITING', detail: 'not enough candles' };
      continue;
    }
    const s = Math.max(0, idxAtOrAfter(c, B1.time) - 12);
    const w = c.slice(s);
    const alt = swings(w, tfBars);
    const ch = findBullishChoch(w, alt, { maxAgeBars: 5000, minLowIdx: idxAtOrAfter(w, B1.time), minLowPrice: ch1.A.price });
    const inZone = ch && ch.A.price <= zone1.top + zoneTol;
    if (!ch || !inZone) {
      ltf[tf] = { status: 'WAITING', detail: ch ? `${tf.toUpperCase()} CHoCH low is above the ${U(S)} Fib zone` : `no ${tf.toUpperCase()} CHoCH yet` };
      continue;
    }
    // volume confirmation
    let volOk = null;
    if (volTf.has(tf)) {
      const vols = w.slice(Math.max(0, ch.breakIdx - 20), ch.breakIdx).map((k) => k.volume);
      const base = sma(vols, Math.min(20, vols.length) || 1);
      volOk = base > 0 ? w[ch.breakIdx].volume >= cfg.volumeMult * base : null;
      if (cfg.volumeConfirm === 'require' && volOk === false) {
        ltf[tf] = { status: 'WAITING', detail: `${tf.toUpperCase()} CHoCH without volume confirmation` };
        continue;
      }
    }
    const fvg = findBullFvgs(w, Math.max(0, ch.A.i)).slice(-1)[0] || null;
    const ob = findBullOb(w, ch.breakIdx);
    ltf[tf] = {
      status: 'CONFIRMED',
      tf,
      choch: { level: px(ch.level), levelTime: ch.H2.time, breakTime: ch.breakTime, breakClose: px(ch.breakClose) },
      low: { time: ch.A.time, price: px(ch.A.price) },
      volumeOk: volOk,
      volume: volOk ? { time: ch.breakTime, price: px(w[ch.breakIdx].close) } : null,
      fvg: fvg ? { time: fvg.time, top: px(fvg.top), bottom: px(fvg.bottom) } : null,
      ob: ob ? { time: ob.time, top: px(ob.top), bottom: px(ob.bottom) } : null,
      sweeps: findSweeps(w, alt, { fromIdx: ch.A.i - 20 }).map((sw) => ({ time: sw.time, level: px(sw.level), fromTime: sw.fromTime })),
      detail: `${tf.toUpperCase()} CHoCH @ ${px(ch.level)}${volOk ? ' · volume ↑' : ''}`,
      _ch: ch,
    };
    confirmed.push({ tf, ch, lowPrice: ch.A.price, time: ch.breakTime + TF_SEC[tf] });
  }

  // structural-TF liquidity sweep around the C zone (quality marker; key kept as `sweeps1h` for stored data)
  ltf.sweeps1h = findSweeps(w1, alt1, { fromIdx: Math.max(0, ch1.A.i - 20) }).map((sw) => ({ time: sw.time, level: px(sw.level), fromTime: sw.fromTime }));

  const allOk = mandatory.every((tf) => ltf[tf]?.status === 'CONFIRMED');
  let entry = null;
  if (allOk) {
    const entryTf = [...tfs.mids].reverse().find((t) => cfg.confirmTfs.includes(t) && ltf[t]?.status === 'CONFIRMED') || S; // the lowest confirmed time frame
    const ech = entryTf === S ? ch1 : ltf[entryTf]._ch;
    const lowers = confirmed.filter((k) => !k.structural && k.lowPrice !== undefined);
    const P = Math.min(...(lowers.length ? lowers : confirmed).map((k) => k.lowPrice)); // pullback low (structural swing only when nothing lower is enabled)
    const anchor = cfg.slAnchor === 'c' && C ? C.price : P;
    const slA = anchor - cfg.slBufferAtr * atr1;
    const entryA = cfg.entryMode === 'close' ? ech.breakClose : ech.level;
    const risk = entryA - slA;
    const armedAt = Math.max(...confirmed.map((k) => k.time));
    if (!(risk > 0) || risk > cfg.maxRiskAtr * atr1) {
      notes.push(!(risk > 0) ? 'entry is below the stop (invalid)' : `risk ${(risk / atr1).toFixed(1)} ATR > max ${cfg.maxRiskAtr}`);
    } else {
      const R = (m) => entryA + risk * m;
      let tp1 = R(cfg.tp1R);
      let tp2 = R(cfg.tp2R);
      let tp3 = R(cfg.tp3R);
      if (cfg.tpMethod === 'structure') {
        if (B1.price - entryA >= risk) tp1 = B1.price;
        if (B.price > tp1 + 0.2 * risk) tp2 = B.price;
        const dA = C ? C.price + AB * cfg.dExtension : null;
        if (dA && dA > tp2 + 0.2 * risk) tp3 = dA;
        if (!(tp2 > tp1)) tp2 = R(cfg.tp2R);
        if (!(tp3 > tp2)) tp3 = R(cfg.tp3R);
      }
      const tgt = { tp1, tp2, tp3 }[cfg.minRRTarget];
      const rr = (tgt - entryA) / risk;
      const lastClose = c1[c1.length - 1].close;
      if (rr < cfg.minRR) notes.push(`R:R ${rr.toFixed(2)} < min ${cfg.minRR}`);
      else if (lastClose >= tp1) notes.push('price is already beyond TP1 — entry missed');
      else {
        entry = {
          tf: entryTf,
          mode: cfg.entryMode,
          armedAt,
          armedAtIso: iso(armedAt),
          zone: cfg.entryMode === 'close' ? zn(px(entryA), px(ech.level)) : zn(px(entryA), px(entryA - 0.5 * (entryA - ech.A.price))),
          price: px(entryA),
          sl: px(slA),
          tp1: px(tp1),
          tp2: px(tp2),
          tp3: px(tp3),
          d: C ? px(C.price + AB * cfg.dExtension) : null,
          rr: r8(rr),
          riskAtr: r8(risk / atr1),
          pullbackLow: px(P),
        };
      }
    }
  }
  for (const t of Object.keys(ltf)) if (ltf[t] && ltf[t]._ch) delete ltf[t]._ch;
  return { ltf, notes, stage: entry ? 'ENTRY_READY' : stage, entry };
}

// ═════════════════════════════════════════════════════════════════════════════════════════
export function scoreAnalysis(a, cfg) {
  let s = 40;
  const h = a.htf;
  if (h.weekly === h.want) s += 5;
  if (h.daily === h.want) s += 5;
  const r = a.h4.abcd.retrace;
  if (r != null) {
    s += Math.round(8 * Math.max(0, 1 - Math.abs(r - 0.618) / 0.3)); // closer to 0.618 = cleaner ABCD
    if (a.h4.abcd.valid) s += 4;
  }
  if (a.h4.czone.reached) s += 6;
  const L = a.ltf || {};
  const tfs = skTfs(cfg);
  if (L[tfs.validate]?.status === 'CONFIRMED') s += 3;
  if (L[tfs.struct]?.status === 'CONFIRMED') s += 8;
  const W = { '30m': 4, '15m': 5, '5m': 4, '3m': 4 }; // points per confirmed CHoCH time frame (+2 with volume on the volume TFs)
  for (const t of tfs.mids) if (L[t]?.status === 'CONFIRMED') s += (W[t] || 4) + (tfs.volTfs.includes(t) && L[t].volumeOk ? 2 : 0);
  const sweeps = (L.sweeps1h?.length || 0) + tfs.mids.reduce((n, t) => n + (L[t]?.sweeps?.length || 0), 0);
  if (sweeps) s += 3;
  if (tfs.mids.some((t) => L[t]?.fvg || L[t]?.ob)) s += 2;
  if (a.entry && a.entry.rr >= 3) s += 3;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function buildSteps(a, cfg, sign) {
  const tfs = skTfs(cfg);
  const LBL = stepLabels(cfg);
  const h = a.htf;
  const L = a.ltf || {};
  const reached = a.h4.czone.reached;
  const st = (id, status, detail, tf) => ({ id, label: LBL[id] || id, tf: tf || id, status, detail });
  const dirTxt = (v) => (v === 'UP' ? 'up' : v === 'DOWN' ? 'down' : 'range');
  const steps = [
    st(tfs.htfHigh, h.weekly === h.want ? 'CONFIRMED' : h.weekly === 'RANGE' ? 'WAITING' : 'INVALIDATED', `${U(tfs.htfHigh)} trend ${dirTxt(h.weekly)}`, tfs.htfHigh),
    st(tfs.htfLow, h.daily === h.want ? 'CONFIRMED' : h.daily === 'RANGE' ? 'WAITING' : 'INVALIDATED', `${U(tfs.htfLow)} bias ${dirTxt(h.daily)}`, tfs.htfLow),
    st('trend', 'CONFIRMED', `${a.primaryTf.toUpperCase()} prior ${a.h4.priorTrend === 'DOWN' ? 'down' : 'up'}-trend (LH + LL)`, a.primaryTf),
    st('choch', 'CONFIRMED', `${a.dir === 'LONG' ? 'Bullish' : 'Bearish'} CHoCH — close beyond ${a.h4.choch.level}`, a.primaryTf),
    st('swings', a.h4.B.confirmed ? 'CONFIRMED' : 'WAITING', `A ${a.h4.A.price} → B ${a.h4.B.price}${a.h4.B.confirmed ? '' : ' (B not confirmed yet)'}`, a.primaryTf),
    st('fib', a.h4.B.confirmed ? 'CONFIRMED' : 'PENDING', `Fib ${a.h4.fib.anchor}: ${a.h4.fib.levels.filter((l) => l.selected).map((l) => `${l.ratio} @ ${l.price}`).join(' · ')}`, a.primaryTf),
    st('abcd', !a.h4.C ? 'PENDING' : a.h4.abcd.valid ? 'CONFIRMED' : 'WAITING', a.h4.C ? `BC retrace ${a.h4.abcd.retrace} · AB ${a.h4.abcd.abAtr} ATR · D → ${a.h4.D?.price ?? '—'}` : 'waiting for the BC pullback', a.primaryTf),
    st('czone', a.h4.czone.status === 'OVERSHOT' ? 'CONFIRMED' : a.h4.czone.status, `C zone ${a.h4.czone.bottom} – ${a.h4.czone.top} (${a.h4.czone.from}–${a.h4.czone.to})${a.h4.czone.status === 'OVERSHOT' ? ' · deeper than zone' : ''}`, a.primaryTf),
  ];
  for (const tf of [tfs.validate, tfs.struct, ...tfs.mids]) {
    const enabled = tf === tfs.struct || cfg.confirmTfs.includes(tf);
    if (!enabled) {
      steps.push(st(tf, 'SKIPPED', 'disabled in admin settings', tf));
      continue;
    }
    if (!reached) steps.push(st(tf, 'PENDING', `waits for the ${U(a.primaryTf)} C zone`, tf));
    else steps.push(st(tf, L[tf]?.status || 'WAITING', L[tf]?.detail || 'waiting', tf));
  }
  const closed = a.stage === 'INVALIDATED';
  steps.push(
    a.entry
      ? st('entry', 'CONFIRMED', `Entry ${a.entry.price} · SL ${a.entry.sl} · TP1 ${a.entry.tp1} · TP2 ${a.entry.tp2} · TP3 ${a.entry.tp3} · R:R ${a.entry.rr}`, a.entry.tf)
      : st('entry', closed ? 'INVALIDATED' : reached ? 'WAITING' : 'PENDING', a.notes.slice(-1)[0] || 'waiting for the lower-time-frame confirmations', 'entry')
  );
  steps.push(st('target', 'PENDING', a.h4.D ? `Projected D ${a.h4.D.price} (CD = AB × ${a.h4.D.extension})` : 'D not projected yet', a.primaryTf));
  return steps;
}

/**
 * Chart annotations — every item comes from the calculated analysis (nothing decorative).
 * group: trend swings choch bos fib abcd czone ltf entry targets liquidity obfvg volume
 * kinds: hline {t1,t2?,p1} · zone {t1,t2?,p1(top),p2(bottom)} · poly {points} · marker {t,p,shape}
 */
export function buildAnnotations(a) {
  const tfs = a.tfs || skTfs({ setup: a.setup, primaryTf: a.primaryTf });
  const S = tfs.struct;
  const SU = U(S);
  const out = [];
  const tf4 = a.primaryTf.toUpperCase();
  const side = a.dir === 'LONG' ? 'bull' : 'bear';
  const add = (o) => out.push({ id: `${o.group}:${out.length}`, side, ...o });
  const h = a.h4;
  const B = h.B;

  add({ group: 'trend', kind: 'poly', tf: a.primaryTf, label: `${tf4} prior ${h.priorTrend === 'DOWN' ? 'down' : 'up'}-trend`, points: h.priorLegs.map((p) => ({ t: p.time, p: p.price })), style: 'dashed' });
  for (const sw of h.swings) {
    add({ group: 'swings', kind: 'marker', tf: a.primaryTf, t: sw.time, p: sw.price, shape: sw.type === 'high' ? 'down' : 'up', label: sw.type === 'high' ? 'SH' : 'SL', small: true });
  }
  add({ group: 'choch', kind: 'hline', tf: a.primaryTf, t1: h.choch.levelTime, t2: h.choch.breakTime, p1: h.choch.level, label: `${tf4} CHoCH ${h.choch.level}` });
  add({ group: 'choch', kind: 'marker', tf: a.primaryTf, t: h.choch.breakTime, p: h.choch.breakClose, shape: a.dir === 'LONG' ? 'up' : 'down', label: 'CHoCH' });
  for (const b of h.bos) add({ group: 'bos', kind: 'hline', tf: a.primaryTf, t1: b.fromTime, t2: b.time, p1: b.level, label: 'BOS', side: b.side });

  for (const l of h.fib.levels) {
    if (!l.selected && l.ratio !== 0 && l.ratio !== 1) continue;
    add({ group: 'fib', kind: 'hline', tf: a.primaryTf, t1: h.A.time, t2: null, p1: l.price, label: `${tf4} Fib ${l.ratio} · ${l.price}`, ratio: l.ratio, style: l.ratio === 0 || l.ratio === 1 ? 'solid' : 'dashed' });
  }
  for (const e of h.fib.extensions) add({ group: 'fib', kind: 'hline', tf: a.primaryTf, t1: h.C.time, t2: null, p1: e.price, label: `${tf4} Ext ${e.ratio} · ${e.price}`, ratio: e.ratio, style: 'dotted' });

  const pts = [{ t: h.A.time, p: h.A.price, n: 'A' }, { t: B.time, p: B.price, n: 'B' }];
  if (h.C) pts.push({ t: h.C.time, p: h.C.price, n: 'C' });
  add({ group: 'abcd', kind: 'poly', tf: a.primaryTf, label: `${tf4} ABCD`, points: pts.map((q) => ({ t: q.t, p: q.p })) });
  for (const q of pts) add({ group: 'abcd', kind: 'marker', tf: a.primaryTf, t: q.t, p: q.p, shape: q.n === 'B' ? (a.dir === 'LONG' ? 'down' : 'up') : q.n === 'C' ? (a.dir === 'LONG' ? 'up' : 'down') : a.dir === 'LONG' ? 'up' : 'down', label: q.n, bold: true });
  if (h.D) {
    add({ group: 'abcd', kind: 'poly', tf: a.primaryTf, label: `${tf4} projected D`, points: [{ t: h.C.time, p: h.C.price }, { t: h.D.projectedTime, p: h.D.price }], style: 'dashed' });
    add({ group: 'abcd', kind: 'marker', tf: a.primaryTf, t: h.D.projectedTime, p: h.D.price, shape: 'dot', label: `D ${h.D.price}`, bold: true, projected: true });
  }
  add({ group: 'czone', kind: 'zone', tf: a.primaryTf, t1: B.time, t2: null, p1: h.czone.top, p2: h.czone.bottom, label: `${tf4} C zone` });

  const L = a.ltf || {};
  const h1 = L[S];
  if (h1?.status === 'CONFIRMED') {
    add({ group: 'ltf', kind: 'hline', tf: S, t1: h1.choch.levelTime, t2: h1.choch.breakTime, p1: h1.choch.level, label: `${SU} CHoCH ${h1.choch.level}` });
    add({ group: 'ltf', kind: 'marker', tf: S, t: h1.choch.breakTime, p: h1.choch.level, shape: a.dir === 'LONG' ? 'up' : 'down', label: `${SU} CHoCH` });
    for (const f of h1.fib) add({ group: 'ltf', kind: 'hline', tf: S, t1: h1.A1.time, t2: null, p1: f.price, label: `${SU} Fib ${f.ratio} · ${f.price}`, ratio: f.ratio, style: 'dotted' });
    add({ group: 'ltf', kind: 'zone', tf: S, t1: h1.B1.time, t2: null, p1: h1.zone.top, p2: h1.zone.bottom, label: `${SU} Fib entry zone` });
  }
  const V = tfs.validate;
  if (L[V]?.status === 'CONFIRMED') add({ group: 'ltf', kind: 'marker', tf: V, t: L[V].low.time, p: L[V].low.price, shape: a.dir === 'LONG' ? 'up' : 'down', label: `${U(V)} hold` });
  for (const [mi, tf] of tfs.mids.entries()) {
    const s = L[tf];
    if (s?.status !== 'CONFIRMED') continue;
    const T = tf.toUpperCase();
    add({ group: 'ltf', kind: 'hline', tf, t1: s.choch.levelTime, t2: s.choch.breakTime, p1: s.choch.level, label: `${T} ${tf === a.entry?.tf || mi === tfs.mids.length - 1 ? 'entry' : mi === 0 && tfs.mids.length > 2 ? 'CHoCH' : 'confirm'} ${s.choch.level}` });
    add({ group: 'ltf', kind: 'marker', tf, t: s.choch.breakTime, p: s.choch.level, shape: a.dir === 'LONG' ? 'up' : 'down', label: `${T} CHoCH` });
    if (s.volume) add({ group: 'volume', kind: 'marker', tf, t: s.volume.time, p: s.volume.price, shape: 'dot', label: `${T} vol ↑`, small: true });
    if (s.fvg) add({ group: 'obfvg', kind: 'zone', tf, t1: s.fvg.time, t2: null, p1: s.fvg.top, p2: s.fvg.bottom, label: `${T} FVG` });
    if (s.ob) add({ group: 'obfvg', kind: 'zone', tf, t1: s.ob.time, t2: null, p1: s.ob.top, p2: s.ob.bottom, label: `${T} OB` });
    for (const sw of s.sweeps || []) add({ group: 'liquidity', kind: 'hline', tf, t1: sw.fromTime, t2: sw.time, p1: sw.level, label: `${T} sweep`, style: 'dotted' });
  }
  for (const sw of L.sweeps1h || []) add({ group: 'liquidity', kind: 'hline', tf: S, t1: sw.fromTime, t2: sw.time, p1: sw.level, label: `${SU} sweep`, style: 'dotted' });

  if (a.entry) {
    const e = a.entry;
    add({ group: 'entry', kind: 'zone', tf: e.tf, t1: e.armedAt, t2: null, p1: e.zone.top, p2: e.zone.bottom, label: 'Entry zone' });
    add({ group: 'entry', kind: 'hline', tf: e.tf, t1: e.armedAt, t2: null, p1: e.price, label: `Entry ${e.price}` });
    add({ group: 'entry', kind: 'hline', tf: e.tf, t1: e.armedAt, t2: null, p1: e.sl, label: `SL ${e.sl}`, tone: 'sl' });
    for (const k of ['tp1', 'tp2', 'tp3']) add({ group: 'targets', kind: 'hline', tf: e.tf, t1: e.armedAt, t2: null, p1: e[k], label: `${k.toUpperCase()} ${e[k]}`, tone: 'tp' });
    if (e.d) add({ group: 'targets', kind: 'hline', tf: a.primaryTf, t1: e.armedAt, t2: null, p1: e.d, label: `D target ${e.d}`, tone: 'tp', style: 'dashed' });
  }
  return out;
}

export { SK_STAGES };
export const TF_ORDER = ['1w', '1d', '4h', '2h', '1h', '30m', '15m', '5m', '3m'];
export { TF_SEC };
