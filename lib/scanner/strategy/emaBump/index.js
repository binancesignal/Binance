/**
 * EMA Bump strategy (EMA 20 red / EMA 50 orange).
 *
 *  1. Price comes from below both EMAs, breaks UP through the red EMA 20 then the orange EMA 50.
 *  2. The push forms a TOP. The top's HIGH = ENTRY level.
 *  3. Price pulls back and touches the EMA 50 (EMA 20 may be touched too, but no candle may close
 *     beyond the EMA 20). That is when the signal is READY.
 *  4. A later break of the top's high = ONGOING (handled by the signal lifecycle).
 *
 * SHORT is the exact mirror (price series negated, then un-negated).
 */
import { calcATR, calcEMASeries, relativeVolume } from '../../indicators.js';
import { normalizeEmaBumpConfig, SOFT_PENALTY, htfFor } from './config.js';
import { evaluateEmaBumpGates, summariseGates } from './gates.js';
import { buildEmaBumpHarmonic, resolveHarmonicCTrade } from './harmonic.js';

const finite = (n) => Number.isFinite(+n);
const r8 = (n) => +(+n).toFixed(8);

function validCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter(
    (c) => finite(c?.open) && finite(c?.high) && finite(c?.low) && finite(c?.close) && +c.high >= +c.low
  );
}

/** Negate prices so a bearish setup can be detected with the bullish rules. */
function mirror(candles) {
  return candles.map((c) => ({ ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close }));
}

/** Find the break-up → top → pullback-to-EMA50 sequence ending at the last closed bar. */
function detectBull(cs, cfg) {
  const n = cs.length;
  if (n < cfg.slowPeriod + cfg.slowSlopeBars + 10) return null;
  const fast = calcEMASeries(cs, cfg.fastPeriod);
  const slow = calcEMASeries(cs, cfg.slowPeriod);
  const atr = calcATR(cs, cfg.atrPeriod);
  if (!(atr > 0)) return null;
  const N = n - 1;
  if (fast[N] == null || slow[N] == null) return null;

  // ---- the dip: lowest low inside the window ----
  const w0 = Math.max(cfg.slowPeriod, N - cfg.depthWindow);
  let lo = w0;
  for (let i = w0; i <= N; i++) if (cs[i].low < cs[lo].low) lo = i;
  if (lo > N - cfg.minPullBars - 1) return null;

  // ---- break-up: first close above BOTH EMAs after the dip ----
  let c = -1;
  for (let i = lo + 1; i <= N; i++) {
    if (fast[i] != null && slow[i] != null && cs[i].close > fast[i] && cs[i].close > slow[i]) { c = i; break; }
  }
  if (c < 0) return null;

  // ---- the top: highest high from the break-up to now ----
  let th = c;
  for (let i = c; i <= N; i++) if (cs[i].high > cs[th].high) th = i;
  if (N - th < cfg.minPullBars || N - th > cfg.maxTopAgeBars) return null;
  const topHigh = cs[th].high;
  const bumpATR = (topHigh - slow[th]) / atr;
  if (bumpATR < cfg.minBumpATR || bumpATR > cfg.maxBumpATR) return null;

  // ---- prior down-trend before the break-up ----
  if (c - cfg.slowSlopeBars < 0 || slow[c - cfg.slowSlopeBars] == null) return null;
  let trendBars = 0;
  for (let i = Math.max(0, c - cfg.trendWindow); i < c; i++) {
    if (fast[i] != null && slow[i] != null && fast[i] < slow[i]) trendBars++;
  }
  if (trendBars < cfg.minTrendBars) return null;
  const slowSlope = slow[c] - slow[c - cfg.slowSlopeBars];
  if (slowSlope > cfg.slowFlatTolATR * atr) return null;
  const depthATR = (slow[c] - cs[lo].low) / atr;
  if (depthATR < cfg.minDepthATR) return null;

  // ---- the pullback: must touch EMA 50, must never close beyond EMA 20 ----
  const tol = cfg.touchTolATR * atr;
  let touchIdx = -1;
  let touchedFast = false;
  let pullLow = Infinity;
  let pullLowIdx = -1;
  for (let p = th + 1; p <= N; p++) {
    if (cs[p].low < pullLow) { pullLow = cs[p].low; pullLowIdx = p; }
    if (slow[p] != null && cs[p].low <= slow[p] + tol) touchIdx = p;
    if (fast[p] != null && cs[p].low <= fast[p] + tol) touchedFast = true;
    if (!cfg.allowCloseBelowFast && fast[p] != null && cs[p].close < fast[p]) return null; // broke + closed below the red EMA
    if (cs[p].high > topHigh) return null; // top already broken
  }
  if (touchIdx < 0 || N - touchIdx > cfg.maxTouchAgeBars) return null;

  // ---- prior EMA50 (slow) price-cross near the current touch level ----
  // Looks for an earlier bar where price crossed the slow EMA, and that cross
  // happened at nearly the same level as the current touch (re-test / double-touch).
  let priorSlowCrossIdx = -1;
  let priorSlowCrossLevel = null;
  const touchSlow = slow[touchIdx];
  if (touchSlow != null) {
    const lookFrom = Math.max(1, touchIdx - (cfg.priorSlowCrossMaxBars || 25));
    const levelTol = (cfg.priorSlowCrossMaxLevelATR || 0.4) * atr;
    for (let i = touchIdx - 1; i >= lookFrom; i--) {
      if (slow[i] == null || slow[i - 1] == null) continue;
      const prevAbove = cs[i - 1].close > slow[i - 1];
      const nowAbove = cs[i].close > slow[i];
      // also count wick crosses of the slow line
      const wickCross =
        (cs[i].low <= slow[i] + tol && cs[i].high >= slow[i] - tol) ||
        (cs[i - 1].low <= slow[i - 1] + tol && cs[i - 1].high >= slow[i - 1] - tol);
      const closedCross = prevAbove !== nowAbove;
      if (closedCross || wickCross) {
        const crossLvl = slow[i];
        if (Math.abs(crossLvl - touchSlow) <= levelTol) {
          priorSlowCrossIdx = i;
          priorSlowCrossLevel = crossLvl;
          break;
        }
      }
    }
  }
  if (cfg.requirePriorSlowCross && priorSlowCrossIdx < 0) return null;

  // ---- EMA shape right now ----
  const gap = slow[N] - fast[N];
  const gapATR = Math.abs(gap) / atr;
  if (gapATR > cfg.maxGapATR) return null;
  let barsSinceCross = null;
  if (gap < 0) {
    if (!cfg.allowRecentCross) return null;
    let k = 0;
    for (let i = N; i >= 0 && fast[i] != null && slow[i] != null && fast[i] > slow[i]; i--) k++;
    barsSinceCross = k;
    if (k > cfg.maxBarsSinceCross) return null;
  }

  // ---- levels ----
  const entry = topHigh + cfg.entryBufferATR * atr;
  const sl = pullLow - cfg.slBufferATR * atr;
  const risk = entry - sl;
  const riskATR = risk / atr;
  if (!(risk > 0) || riskATR < cfg.minStopATR || riskATR > cfg.maxStopATR) return null;

  const retrace = (topHigh - pullLow) / Math.max(topHigh - cs[lo].low, 1e-12);

  // Harmonic XAB (X=HH, A=LL, B=TOP) → C entry zone + D TP
  let harm = null;
  try {
    harm = buildEmaBumpHarmonic(cs, { lo, th }, atr, cfg);
  } catch (_) { harm = null; }
  if (cfg.requireHarmonic && !harm) return null;

  // Optional: replace classic top-break entry with C-zone harmonic entry
  let levels = {
    entry, sl,
    tp1: entry + risk * cfg.tp1R,
    tp2: entry + risk * cfg.tp2R,
    tp3: entry + risk * cfg.tp3R,
    rr: cfg.tp1R,
    riskATR,
    mode: 'top_break',
  };
  if (cfg.useHarmonicEntry && harm) {
    const hEntry = harm.C.mid;
    const hSl = harm.A.price - (cfg.slBufferATR || 0) * atr;
    const hRisk = hEntry - hSl;
    if (hRisk > 0) {
      const hRiskATR = hRisk / atr;
      if (hRiskATR >= cfg.minStopATR && hRiskATR <= cfg.maxStopATR) {
        const hTp1 = Math.max(harm.D.price, hEntry + hRisk * cfg.tp1R);
        levels = {
          entry: hEntry,
          sl: hSl,
          tp1: hTp1,
          tp2: hEntry + hRisk * cfg.tp2R,
          tp3: hEntry + hRisk * cfg.tp3R,
          rr: cfg.tp1R,
          riskATR: hRiskATR,
          mode: 'harmonic_c',
          zoneHigh: harm.C.zoneHigh,
          zoneLow: harm.C.zoneLow,
        };
      }
    }
  }

  return {
    atr,
    fast,
    slow,
    harm,
    d: {
      N, lo, c, th, touchIdx, pullLowIdx, touchedFast,
      bumpATR, trendBars, depthATR, gap, gapATR, barsSinceCross, retrace,
      slowSlopeATR: slowSlope / atr,
      fastTurnATR: (fast[N] - fast[Math.max(0, N - 3)]) / atr,
      pullBars: N - th,
      touchAge: N - touchIdx,
      priorSlowCrossIdx,
      priorSlowCrossLevel,
      hasPriorSlowCross: priorSlowCrossIdx >= 0,
    },
    levels,
  };
}

function scoreSetup(d) {
  const parts = {};
  parts.base = 50;
  parts.trend = Math.round(Math.min(1, d.trendBars / 20) * 10);
  parts.depth = Math.round(Math.min(1, d.depthATR / 4) * 10);
  parts.bump = d.bumpATR >= 0.5 && d.bumpATR <= 2.5 ? 6 : 2;
  parts.convergence = (d.gapATR <= 0.7 ? 6 : d.gapATR <= 1.3 ? 3 : 0) + (d.barsSinceCross == null ? 2 : 0);
  parts.fastTurn = Math.round(Math.min(1, Math.max(0, d.fastTurnATR) / 0.5) * 6);
  parts.pullback = (d.retrace >= 0.25 && d.retrace <= 0.7 ? 6 : 2) + (d.touchedFast ? 2 : 0);
  parts.fresh = d.touchAge <= 3 ? 4 : d.touchAge <= 8 ? 2 : 0;
  // Bonus: prior EMA50 cross at nearly the same level (re-test / double-touch)
  parts.priorSlowCross = d.hasPriorSlowCross ? 5 : 0;
  const total = Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0));
  return { total, parts };
}

/**
 * Run the strategy for one coin on ONE time frame.
 * @param {{symbol:string, price:number, candles:Array, tf:string, config?:object,
 *          htfCandles?:Array, reportAll?:boolean}} opts
 *   htfCandles — closed candles of htfFor(tf); without them the HTF gate is not evaluated.
 *   reportAll  — (chart preview) return the setup even when gates / score / distance reject it,
 *                flagged with metadata.gateRejected + metadata.rejectReasons.
 */
export function runEmaBumpPair(opts = {}) {
  const { symbol, price, candles: raw, tf, config: rawConfig, htfCandles, reportAll = false } = opts;
  const cfg = normalizeEmaBumpConfig(rawConfig || {});
  if (!cfg.enabled) return [];

  const candles = validCandles(raw);
  if (candles.length < cfg.slowPeriod + cfg.slowSlopeBars + 10 || !finite(price)) return [];
  const live = +price;
  const htfReal = htfCandles ? validCandles(htfCandles) : null;

  const out = [];
  const dirs = [];
  if (cfg.allowLong) dirs.push('LONG');
  if (cfg.allowShort) dirs.push('SHORT');

  for (const dir of dirs) {
    const isShort = dir === 'SHORT';
    const sign = isShort ? -1 : 1;
    const cs = isShort ? mirror(candles) : candles;
    const found = detectBull(cs, cfg);
    if (!found) continue;

    const { atr, fast, slow, d, harm: harmBull } = found;
    const L = found.levels;
    const entry = r8(sign * L.entry);
    const sl = r8(sign * L.sl);
    const tp1 = r8(sign * L.tp1);
    const tp2 = r8(sign * L.tp2);
    const tp3 = r8(sign * L.tp3);
    // Un-mirror harmonic geometry for real chart coordinates
    const harm = harmBull
      ? {
          pattern: harmBull.pattern,
          score: harmBull.score,
          XB: harmBull.XB,
          hits: harmBull.hits,
          XA: harmBull.XA,
          AB: harmBull.AB,
          X: { time: harmBull.X.time, price: r8(sign * harmBull.X.price) },
          A: { time: harmBull.A.time, price: r8(sign * harmBull.A.price) },
          B: { time: harmBull.B.time, price: r8(sign * harmBull.B.price) },
          C: {
            high: r8(sign * (isShort ? harmBull.C.low : harmBull.C.high)),
            low: r8(sign * (isShort ? harmBull.C.high : harmBull.C.low)),
            mid: r8(sign * harmBull.C.mid),
            zoneHigh: r8(sign * (isShort ? harmBull.C.zoneLow : harmBull.C.zoneHigh)),
            zoneLow: r8(sign * (isShort ? harmBull.C.zoneHigh : harmBull.C.zoneLow)),
          },
          D: { price: r8(sign * harmBull.D.price), ratio: harmBull.D.ratio },
          dLevels: (harmBull.dLevels || []).map((x) => ({
            price: r8(sign * x.price),
            ratio: x.ratio,
            from: x.from,
          })),
          entryMode: L.mode || 'top_break',
        }
      : null;

    const rejectReasons = [];

    // live price too far from the entry → not actionable now
    if (Math.abs(live - entry) > cfg.maxEntryDistanceATR * atr) rejectReasons.push('entry too far from price');
    if (L.rr < cfg.minRR) rejectReasons.push('RR below minimum');

    // ---- gates ----
    const rvol = relativeVolume(candles.slice(0, d.th + 1));
    const gates = evaluateEmaBumpGates({
      cs, fast, slow, atr, t: d.N, d, levels: L,
      realEntry: entry, realSl: sl, rvol,
      htfCs: htfReal ? (isShort ? mirror(htfReal) : htfReal) : null,
      cfg,
    });
    const { hardFails, softFails } = summariseGates(gates);
    for (const g of hardFails) rejectReasons.push(`HARD gate failed: ${g.label}${g.detail ? ` (${g.detail})` : ''}`);

    // ---- score (soft gate failures cost points) ----
    const sc = scoreSetup(d);
    const score = Math.max(0, sc.total - SOFT_PENALTY * softFails.length);
    if (score < cfg.minScore) rejectReasons.push(`score ${score} < ${cfg.minScore}`);

    if (rejectReasons.length && !reportAll) continue;

    const topReal = candles[d.th];
    const touchReal = candles[d.touchIdx];
    const dipReal = candles[d.lo];
    const crossReal = candles[d.c];
    const priorCrossReal = d.priorSlowCrossIdx >= 0 ? candles[d.priorSlowCrossIdx] : null;
    const tfU = String(tf || '').toUpperCase();
    const analysis = [
      `${symbol} — ${dir} EMA BUMP (${tfU})`,
      `Break-up above EMA${cfg.fastPeriod} + EMA${cfg.slowPeriod} → top ${entry} (${d.pullBars} bar(s) ago)`,
      `Pullback touched EMA${cfg.slowPeriod}${d.touchedFast ? ` and EMA${cfg.fastPeriod}` : ''} ${d.touchAge} bar(s) ago · no close beyond EMA${cfg.fastPeriod}`,
      d.hasPriorSlowCross
        ? `Prior EMA${cfg.slowPeriod} cross near touch level ${d.touchAge + (d.N - d.priorSlowCrossIdx)} bar(s) before touch (same-level re-test)`
        : null,
      harm
        ? `Harmonic ${harm.pattern} (XB ${harm.XB}) · X→A→B → C zone entry ${harm.C.low}–${harm.C.high} · D/TP ${harm.D.price}`
        : null,
      L.mode === 'harmonic_c' ? `ENTRY MODE: harmonic C zone (not top-break)` : null,
      `EMA gap ${d.gapATR.toFixed(2)} ATR` + (d.barsSinceCross != null ? ` · crossed ${d.barsSinceCross} bar(s) ago` : ' · not crossed yet') + ` · dip ${d.depthATR.toFixed(1)} ATR`,
      `READY — ONGOING when price breaks the top ${isShort ? 'low' : 'high'}: ${entry}`,
      `SL: ${sl}  TP1: ${tp1}  TP2: ${tp2}  TP3: ${tp3}`,
      `Score: ${score}/100${softFails.length ? ` (soft gates failed: ${softFails.map((g) => g.label).join(', ')})` : ''}`,
    ].filter(Boolean).join('\n');

    out.push({
      symbol,
      dir,
      direction: dir,
      strategy: 'ema_bump',
      pattern: 'EMA Bump',
      score,
      quality: score >= 85 ? 'STRONG' : score >= 70 ? 'VALID' : 'WEAK',
      entry, sl, tp1, tp2, tp3,
      rr: r8(L.rr),
      atr,
      rvol: rvol != null ? +(+rvol).toFixed(2) : null,
      analysis,
      ob: { time: topReal.time, high: topReal.high, low: topReal.low },
      metadata: {
        strategy: 'ema_bump',
        strategyName: 'EMA Bump (EMA 20 / EMA 50)',
        patternTf: tf,
        entryTf: tf,
        setupTf: tf,
        htfTf: htfFor(tf),
        pattern: 'EMA Bump',
        emaFast: cfg.fastPeriod,
        emaSlow: cfg.slowPeriod,
        emaValues: { fast: r8(sign * fast[d.N]), slow: r8(sign * slow[d.N]) },
        // geometry for the chart (times, not indexes)
        emaGeom: {
          fast: cfg.fastPeriod,
          slow: cfg.slowPeriod,
          dip: { time: dipReal.time, price: isShort ? dipReal.high : dipReal.low },
          breakUp: { time: crossReal.time },
          top: { time: topReal.time, price: isShort ? topReal.low : topReal.high },
          touch: { time: touchReal.time, price: isShort ? touchReal.high : touchReal.low },
          pullLow: { time: candles[d.pullLowIdx].time, price: isShort ? candles[d.pullLowIdx].high : candles[d.pullLowIdx].low },
          priorSlowCross: priorCrossReal
            ? { time: priorCrossReal.time, price: r8(sign * (d.priorSlowCrossLevel ?? 0)) }
            : null,
          harmonic: harm,
        },
        harmonic: harm,
        entryMode: L.mode || 'top_break',
        gates: gates.map((g) => ({ key: g.key, label: g.label, mode: g.mode, pass: g.pass, detail: g.detail })),
        softFails: softFails.map((g) => g.key),
        gateRejected: rejectReasons.length > 0,
        rejectReasons,
        bumpATR: +d.bumpATR.toFixed(3),
        gapATR: +d.gapATR.toFixed(3),
        barsSinceCross: d.barsSinceCross,
        trendBars: d.trendBars,
        depthATR: +d.depthATR.toFixed(3),
        retrace: +d.retrace.toFixed(3),
        touchedFast: d.touchedFast,
        pullBars: d.pullBars,
        touchAge: d.touchAge,
        hasPriorSlowCross: !!d.hasPriorSlowCross,
        priorSlowCrossAge: d.priorSlowCrossIdx >= 0 ? d.N - d.priorSlowCrossIdx : null,
        rvol: rvol != null ? +(+rvol).toFixed(2) : null,
        scoreBreakdown: sc.parts,
        riskATR: +L.riskATR.toFixed(3),
        minScoreAtCreate: cfg.minScore,
        minRrAtEntry: cfg.minRR,
        minRR: cfg.minRR,
        breakoutLevel: entry,
        breakoutConfirmed: false, // confirmed later by a close beyond the top
      },
    });
  }
  return out;
}

export { normalizeEmaBumpConfig, EMA_BUMP_DEFAULTS, EMA_BUMP_GATES, ALL_TFS, htfFor } from './config.js';

/** Tally WIN/LOSS/TIMEOUT/OPEN counts + win rate. */
export function tallyEmaBump(list) {
  const t = { total: list.length, win: 0, loss: 0, timeout: 0, open: 0, noEntry: 0 };
  for (const e of list) {
    if (e.outcome === 'WIN') t.win++;
    else if (e.outcome === 'LOSS') t.loss++;
    else if (e.outcome === 'TIMEOUT') t.timeout++;
    else if (e.outcome === 'NO_ENTRY') t.noEntry++;
    else t.open++;
  }
  const decided = t.win + t.loss;
  t.winRate = decided ? +((t.win / decided) * 100).toFixed(1) : null;
  return t;
}

/**
 * After READY: wait for break of the top (entry), then resolve TP1 vs SL.
 * @returns {{ outcome, mfe, mae, bars, entryBar, fillBar }}
 */
function resolveEmaBumpTrade(cs, readyIdx, entry, sl, tp1, isLong, maxBars = 80, maxEntryWait = 40) {
  const n = cs.length;
  let fillBar = -1;
  const waitEnd = Math.min(n - 1, readyIdx + maxEntryWait);
  for (let j = readyIdx + 1; j <= waitEnd; j++) {
    if (isLong ? cs[j].high >= entry : cs[j].low <= entry) {
      fillBar = j;
      break;
    }
  }
  if (fillBar < 0) {
    return { outcome: 'NO_ENTRY', mfe: 0, mae: 0, bars: waitEnd - readyIdx, entryBar: readyIdx, fillBar: -1 };
  }

  let mfe = 0;
  let mae = 0;
  const last = Math.min(n - 1, fillBar + maxBars);
  for (let j = fillBar; j <= last; j++) {
    const c = cs[j];
    if (isLong) {
      mfe = Math.max(mfe, c.high - entry);
      mae = Math.max(mae, entry - c.low);
      if (c.low <= sl) return { outcome: 'LOSS', mfe, mae, bars: j - fillBar, entryBar: readyIdx, fillBar };
      if (c.high >= tp1) return { outcome: 'WIN', mfe, mae, bars: j - fillBar, entryBar: readyIdx, fillBar };
    } else {
      mfe = Math.max(mfe, entry - c.low);
      mae = Math.max(mae, c.high - entry);
      if (c.high >= sl) return { outcome: 'LOSS', mfe, mae, bars: j - fillBar, entryBar: readyIdx, fillBar };
      if (c.low <= tp1) return { outcome: 'WIN', mfe, mae, bars: j - fillBar, entryBar: readyIdx, fillBar };
    }
  }
  const resolved = n - 1 >= fillBar + maxBars;
  return {
    outcome: resolved ? 'TIMEOUT' : 'OPEN',
    mfe, mae,
    bars: last - fillBar,
    entryBar: readyIdx,
    fillBar,
  };
}

/**
 * Historical backtest for one coin / one TF.
 * Walks candles, detects READY EMA-bump setups (same rules as live), then resolves
 * entry-break → TP1 vs SL.
 *
 * Event shape (admin table compatible):
 *   { time, index, dir, entry, sl, tp1, atr, outcome, mfeATR, maeATR, bars,
 *     bumpATR, depthATR, hasPriorSlowCross, touchAge, pullBars, topTime }
 */
export function backtestEmaBump(candles, tf, rawConfig = {}) {
  const cfg = normalizeEmaBumpConfig(rawConfig);
  const cs = validCandles(candles);
  const n = cs.length;
  const minBars = cfg.slowPeriod + cfg.slowSlopeBars + 15;
  if (n < minBars + 10) return { events: [], tally: tallyEmaBump([]) };

  const events = [];
  const seenTops = new Set(); // dedupe by top-bar time + direction
  const slowAll = calcEMASeries(cs, cfg.slowPeriod);

  // For each bar as potential READY end; skip bars far from EMA50 (cheap filter)
  for (let end = minBars; end < n - 1; end++) {
    if (slowAll[end] == null) continue;
    const nearTouch =
      cs[end].low <= slowAll[end] * 1.02 && cs[end].high >= slowAll[end] * 0.98;
    if (!nearTouch && end % 4 !== 0) continue;

    const prefix = cs.slice(0, end + 1);
    // LONG
    if (cfg.allowLong !== false) {
      const found = detectBull(prefix, cfg);
      if (found && found.d.touchAge <= cfg.maxTouchAgeBars) {
        const key = `L:${cs[found.d.th].time}`;
        if (!seenTops.has(key)) {
          seenTops.add(key);
          const { levels: L, atr, d, harm } = found;
          let entry = L.entry, sl = L.sl, tp1 = L.tp1, res, entryMode = L.mode || 'top_break';
          let harmMeta = null;
          if (cfg.useHarmonicEntry && harm) {
            res = resolveHarmonicCTrade(cs, end, harm, atr, cfg);
            entry = res.entry; sl = res.sl; tp1 = res.tp1;
            entryMode = 'harmonic_c';
            harmMeta = { pattern: harm.pattern, XB: harm.XB, C: harm.C, D: harm.D };
          } else {
            res = resolveEmaBumpTrade(cs, end, entry, sl, tp1, true, 80, 40);
          }
          events.push({
            time: cs[end].time,
            index: end,
            dir: 'LONG',
            entry: r8(entry),
            sl: r8(sl),
            tp1: r8(tp1),
            atr: +atr.toFixed(8),
            outcome: res.outcome,
            mfeATR: atr > 0 ? +(res.mfe / atr).toFixed(2) : 0,
            maeATR: atr > 0 ? +(res.mae / atr).toFixed(2) : 0,
            bars: res.bars,
            fillBar: res.fillBar,
            bumpATR: +d.bumpATR.toFixed(3),
            depthATR: +d.depthATR.toFixed(3),
            hasPriorSlowCross: !!d.hasPriorSlowCross,
            touchAge: d.touchAge,
            pullBars: d.pullBars,
            topTime: cs[d.th].time,
            gapATR: +d.gapATR.toFixed(3),
            riskATR: +L.riskATR.toFixed(3),
            rr: L.rr,
            entryMode,
            harmonic: harmMeta,
            hasHarmonic: !!harm,
            harmonicPattern: harm?.pattern || null,
          });
        }
      }
    }
    // SHORT (mirrored)
    if (cfg.allowShort !== false) {
      const foundS = detectBull(mirror(prefix), cfg);
      if (foundS && foundS.d.touchAge <= cfg.maxTouchAgeBars) {
        const topReal = cs[foundS.d.th];
        const key = `S:${topReal.time}`;
        if (!seenTops.has(key)) {
          seenTops.add(key);
          const { levels: L, atr, d, harm: harmBull } = foundS;
          let entry = r8(-L.entry), sl = r8(-L.sl), tp1 = r8(-L.tp1), res, entryMode = L.mode || 'top_break';
          let harmMeta = null;
          if (cfg.useHarmonicEntry && harmBull) {
            // resolve on mirrored series then flip levels
            res = resolveHarmonicCTrade(mirror(cs), end, harmBull, atr, cfg);
            entry = r8(-res.entry); sl = r8(-res.sl); tp1 = r8(-res.tp1);
            // mfe/mae stay magnitude-correct
            entryMode = 'harmonic_c';
            harmMeta = { pattern: harmBull.pattern, XB: harmBull.XB };
          } else {
            res = resolveEmaBumpTrade(cs, end, entry, sl, tp1, false, 80, 40);
          }
          events.push({
            time: cs[end].time,
            index: end,
            dir: 'SHORT',
            entry,
            sl,
            tp1,
            atr: +atr.toFixed(8),
            outcome: res.outcome,
            mfeATR: atr > 0 ? +(res.mfe / atr).toFixed(2) : 0,
            maeATR: atr > 0 ? +(res.mae / atr).toFixed(2) : 0,
            bars: res.bars,
            fillBar: res.fillBar,
            bumpATR: +d.bumpATR.toFixed(3),
            depthATR: +d.depthATR.toFixed(3),
            hasPriorSlowCross: !!d.hasPriorSlowCross,
            touchAge: d.touchAge,
            pullBars: d.pullBars,
            topTime: topReal.time,
            gapATR: +d.gapATR.toFixed(3),
            riskATR: +L.riskATR.toFixed(3),
            rr: L.rr,
            entryMode,
            harmonic: harmMeta,
            hasHarmonic: !!harmBull,
            harmonicPattern: harmBull?.pattern || null,
          });
        }
      }
    }
  }

  return { events, tally: tallyEmaBump(events) };
}

export { SOFT_PENALTY };
