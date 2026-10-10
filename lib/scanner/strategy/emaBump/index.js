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
  return {
    atr,
    fast,
    slow,
    d: {
      N, lo, c, th, touchIdx, pullLowIdx, touchedFast,
      bumpATR, trendBars, depthATR, gap, gapATR, barsSinceCross, retrace,
      slowSlopeATR: slowSlope / atr,
      fastTurnATR: (fast[N] - fast[Math.max(0, N - 3)]) / atr,
      pullBars: N - th,
      touchAge: N - touchIdx,
    },
    levels: {
      entry, sl,
      tp1: entry + risk * cfg.tp1R,
      tp2: entry + risk * cfg.tp2R,
      tp3: entry + risk * cfg.tp3R,
      rr: cfg.tp1R,
      riskATR,
    },
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

    const { atr, fast, slow, d } = found;
    const L = found.levels;
    const entry = r8(sign * L.entry);
    const sl = r8(sign * L.sl);
    const tp1 = r8(sign * L.tp1);
    const tp2 = r8(sign * L.tp2);
    const tp3 = r8(sign * L.tp3);

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
    const tfU = String(tf || '').toUpperCase();
    const analysis = [
      `${symbol} — ${dir} EMA BUMP (${tfU})`,
      `Break-up above EMA${cfg.fastPeriod} + EMA${cfg.slowPeriod} → top ${entry} (${d.pullBars} bar(s) ago)`,
      `Pullback touched EMA${cfg.slowPeriod}${d.touchedFast ? ` and EMA${cfg.fastPeriod}` : ''} ${d.touchAge} bar(s) ago · no close beyond EMA${cfg.fastPeriod}`,
      `EMA gap ${d.gapATR.toFixed(2)} ATR` + (d.barsSinceCross != null ? ` · crossed ${d.barsSinceCross} bar(s) ago` : ' · not crossed yet') + ` · dip ${d.depthATR.toFixed(1)} ATR`,
      `READY — ONGOING when price breaks the top ${isShort ? 'low' : 'high'}: ${entry}`,
      `SL: ${sl}  TP1: ${tp1}  TP2: ${tp2}  TP3: ${tp3}`,
      `Score: ${score}/100${softFails.length ? ` (soft gates failed: ${softFails.map((g) => g.label).join(', ')})` : ''}`,
    ].join('\n');

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
        },
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
