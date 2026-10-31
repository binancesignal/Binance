/**
 * OB + HTF Fib strategy — see ./config.js for the rules.
 */
import { calcATR } from '../../indicators.js';
import { detectLuxAlgoOrderBlocks, detectLuxAlgoOrderBlocksHistorical } from '../../orderBlocks.js';
import { normalizeObFibConfig } from './config.js';
export { normalizeObFibConfig } from './config.js';

const REF_LABEL = {
  '1d': 'Daily',
  '1w': 'Weekly',
  '1M': 'Monthly',
  '3M': '3-Month',
  '1Y': 'Yearly',
};

/** unix-sec when the candle that opened at `t` closes */
export function candleEnd(t, refTf) {
  if (refTf === '1d') return t + 86400;
  if (refTf === '1w') return t + 7 * 86400;
  if (refTf === '1M') {
    const d = new Date(t * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
  }
  if (refTf === '3M') {
    const d = new Date(t * 1000);
    // open is first day of a quarter (Jan/Apr/Jul/Oct); close = first day of next quarter
    const m = d.getUTCMonth();
    const nextQ = m - (m % 3) + 3;
    return Math.floor(Date.UTC(d.getUTCFullYear(), nextQ, 1) / 1000);
  }
  if (refTf === '1Y') {
    const d = new Date(t * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear() + 1, 0, 1) / 1000);
  }
  return t + 7 * 86400; // fallback weekly
}
const finite = (n) => Number.isFinite(+n);
const r8 = (n) => +(+n).toFixed(8);

function validCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter(
    (c) => finite(c?.open) && finite(c?.high) && finite(c?.low) && finite(c?.close) && +c.high >= +c.low
  );
}

/**
 * Fib levels of the LAST CLOSED reference candle (any HTF).
 *  bullish → drawn LOW → HIGH   (0 at the high, 1 at the low)
 *  bearish → drawn HIGH → LOW   (0 at the low,  1 at the high)
 * Returns null when there is no closed candle for that TF.
 */
export function computeWeeklyFib(weeklyCandles, cfgRaw = {}, nowSec = Math.floor(Date.now() / 1000), refTf = '1w') {
  const cfg = normalizeObFibConfig(cfgRaw);
  const wk = validCandles(weeklyCandles).filter((c) => candleEnd(+c.time, refTf) <= nowSec + 5); // never the ongoing candle
  if (!wk.length) return null;
  const back = Math.min(cfg.refCandleBack, wk.length);
  const c = wk[wk.length - back];
  const candleDir = +c.close >= +c.open ? 'bullish' : 'bearish';
  const dir = cfg.weeklyDirection === 'auto' ? candleDir : cfg.weeklyDirection;
  const high = +c.high;
  const low = +c.low;
  const range = high - low;
  if (!(range > 0)) return null;
  // bullish: Fib low→high ; bearish: Fib high→low
  const priceAt = (ratio) => (dir === 'bullish' ? high - range * ratio : low + range * ratio);
  const selected = new Set(cfg.fibLevels.map((x) => +x.toFixed(4)));
  const ratios = [...new Set([...cfg.fibLevels, 0, 0.5, 1])].sort((a, b) => a - b);
  const levels = ratios.map((ratio) => ({
    ratio,
    price: r8(priceAt(ratio)),
    selected: selected.has(+ratio.toFixed(4)),
  }));
  return {
    refTf,
    refLabel: REF_LABEL[refTf] || 'Weekly',
    time: +c.time,
    open: +c.open,
    high,
    low,
    close: +c.close,
    candleDir,
    dir,
    forced: cfg.weeklyDirection !== 'auto',
    levels,
  };
}

/** Does the fib price pass through (the middle of) the OB zone? */
function fibInZone(price, ob, cfg, atr) {
  const top = Math.max(ob.high, ob.low);
  const btm = Math.min(ob.high, ob.low);
  const tol = (cfg.fibTolATR || 0) * atr + ((cfg.fibTolPct || 0) / 100) * Math.abs(price);
  if (cfg.fibMatchMode === 'middle') {
    const mid = (top + btm) / 2;
    const half = ((top - btm) / 2) * (cfg.middleBandPct / 100);
    return Math.abs(price - mid) <= half + tol;
  }
  return price >= btm - tol && price <= top + tol;
}

function buildLevels(dir, entry, ob, atr, cfg) {
  const isLong = dir === 'LONG';
  const sign = isLong ? 1 : -1;
  const top = Math.max(ob.high, ob.low);
  const btm = Math.min(ob.high, ob.low);
  let sl = isLong ? btm - cfg.slBufferATR * atr : top + cfg.slBufferATR * atr;
  let risk = Math.abs(entry - sl);
  if (risk < cfg.minStopATR * atr) {
    risk = cfg.minStopATR * atr;
    sl = isLong ? entry - risk : entry + risk;
  }
  if (risk > cfg.maxStopATR * atr) return null;
  const tp1 = entry + sign * cfg.tp1R * risk;
  const tp2 = entry + sign * cfg.tp2R * risk;
  const tp3 = entry + sign * cfg.tp3R * risk;
  return {
    entry: r8(entry),
    sl: r8(sl),
    tp1: r8(tp1),
    tp2: r8(tp2),
    tp3: r8(tp3),
    rr: r8(Math.abs(tp1 - entry) / risk),
    riskATR: r8(risk / atr),
  };
}

function scoreSetup({ ob, fib, matches, weekly, dir, distATR, zoneMidDistPct }) {
  let s = 55;
  s += ob.status === 'FRESH' ? 10 : ob.status === 'TESTED ONCE' ? 4 : 0;
  s += Math.round((1 - Math.min(1, zoneMidDistPct)) * 10); // fib close to OB middle line
  if ([0.5, 0.618, 0.786].some((k) => Math.abs(k - fib.ratio) < 1e-9)) s += 5; // key fib
  if (matches > 1) s += 4;
  const aligned = (weekly.dir === 'bullish' && dir === 'LONG') || (weekly.dir === 'bearish' && dir === 'SHORT');
  if (aligned) s += 8;
  if (distATR <= 3) s += 5;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/**
 * Scan one symbol on one lower time frame.
 * @param {object} opts { symbol, price, candles (LTF closed), tf, weekly (computeWeeklyFib result), config }
 */
export function runObFibPair(opts = {}) {
  const { symbol, price, candles: raw, tf, weekly, config: rawConfig } = opts;
  const cfg = normalizeObFibConfig(rawConfig || {});
  if (!cfg.enabled || !weekly?.levels?.length) return [];
  const candles = validCandles(raw);
  if (candles.length < 60 || !finite(price)) return [];
  const atr = calcATR(candles, 14);
  if (!(atr > 0)) return [];

  const selectedFibs = weekly.levels.filter((l) => l.selected);
  if (!selectedFibs.length) return [];

  const obs = detectLuxAlgoOrderBlocks(candles, cfg.lookback, {
    length: cfg.obLength,
    bullExtLast: cfg.bullExtLast,
    bearExtLast: cfg.bearExtLast,
    mitigation: cfg.mitigation,
  });

  const out = [];
  const tfU = String(tf || '').toUpperCase();
  for (const ob of obs) {
    const dir = ob.type === 'bearish' ? 'SHORT' : 'LONG';
    if (dir === 'LONG' && !cfg.allowLong) continue;
    if (dir === 'SHORT' && !cfg.allowShort) continue;
    if (cfg.onlyFresh && ob.status !== 'FRESH') continue;

    const top = Math.max(ob.high, ob.low);
    const btm = Math.min(ob.high, ob.low);

    // OB candle must be at the extreme of its leg: bearish → near the swing HIGH, bullish → near the swing LOW
    if (cfg.requireExtremeOb) {
      const oi = candles.findIndex((c) => +c.time === +ob.time);
      if (oi < 0) continue;
      const a = Math.max(0, oi - cfg.extremeWindow);
      const b = Math.min(candles.length - 1, oi + cfg.extremeWindow);
      const tol = cfg.extremeTolATR * atr;
      if (dir === 'SHORT') {
        let mx = -Infinity;
        for (let k = a; k <= b; k++) mx = Math.max(mx, +candles[k].high);
        if (+candles[oi].high < mx - tol) continue;
      } else {
        let mn = Infinity;
        for (let k = a; k <= b; k++) mn = Math.min(mn, +candles[k].low);
        if (+candles[oi].low > mn + tol) continue;
      }
    }
    const mid = (top + btm) / 2;
    const half = Math.max((top - btm) / 2, 1e-12);

    if (cfg.maxObWidthATR > 0 && top - btm > cfg.maxObWidthATR * atr) continue; // too wide OB

    const hits = selectedFibs.filter((f) => fibInZone(f.price, { high: top, low: btm }, cfg, atr));
    if (!hits.length) continue; // OB without a selected fib line → no signal

    if (cfg.singleFibOnly && hits.length > 1) continue; // several fib lines in one OB = invalid

    // the fib line closest to the zone's middle line is the signal's fib
    const fib = [...hits].sort((a, b) => Math.abs(a.price - mid) - Math.abs(b.price - mid))[0];
    const entryRef = cfg.entryMode === 'mid' ? mid : Math.min(top, Math.max(btm, fib.price));
    const levels = buildLevels(dir, entryRef, { high: top, low: btm }, atr, cfg);
    if (!levels || levels.rr < cfg.minRR) continue;

    // price must come TO the entry from the correct side (BUY: from above · SELL: from below)
    if (cfg.requireApproachSide) {
      if (dir === 'LONG' && !(+price > levels.entry)) continue;
      if (dir === 'SHORT' && !(+price < levels.entry)) continue;
    }
    // entry level must not have been touched since the OB formed
    if (cfg.requireUntouchedEntry) {
      const obIdx = candles.findIndex((c) => +c.time === +ob.time);
      const from = obIdx >= 0 ? obIdx + 1 : Math.max(0, candles.length - cfg.lookback);
      let touched = false;
      for (let k = from; k < candles.length; k++) {
        if (+candles[k].low <= levels.entry && +candles[k].high >= levels.entry) {
          touched = true;
          break;
        }
      }
      if (touched) continue;
    }

    const distATR = Math.abs(+price - levels.entry) / atr;
    if (distATR > cfg.maxEntryDistanceATR) continue;
    // OB must still be on the correct side of price (LONG zone below / SHORT zone above)
    if (dir === 'LONG' && +price < btm) continue;
    if (dir === 'SHORT' && +price > top) continue;

    const zoneMidDistPct = Math.abs(fib.price - mid) / half;
    const score = scoreSetup({ ob, fib, matches: hits.length, weekly, dir, distATR, zoneMidDistPct });
    if (score < cfg.minScore) continue;

    const analysis = [
      `${symbol} — ${dir === 'LONG' ? 'BUY' : 'SELL'} · ${ob.type === 'bearish' ? 'Bearish' : 'Bullish'} OB + ${weekly.refLabel || 'Weekly'} Fib (${tfU})`,
      `${weekly.refLabel || 'HTF'} candle ${weekly.candleDir}${weekly.forced ? ` (forced ${weekly.dir})` : ''} · Fib ${weekly.dir === 'bullish' ? 'low→high' : 'high→low'} ${r8(weekly.low)} – ${r8(weekly.high)}`,
      `Fib ${fib.ratio} @ ${fib.price} passes through OB ${r8(btm)} – ${r8(top)} (${ob.status})`,
      `Entry ${levels.entry} · SL ${levels.sl} · TP1 ${levels.tp1} · RR ${levels.rr}`,
      `Score ${score}/100`,
    ].join('\n');

    out.push({
      symbol,
      dir,
      direction: dir,
      strategy: 'ob_fib',
      pattern: 'OB+FIB',
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
      ob: {
        time: ob.time,
        high: r8(top),
        low: r8(btm),
        type: ob.type,
        status: ob.status,
        tests: ob.tests,
        source: 'luxalgo',
      },
      metadata: {
        strategy: 'ob_fib',
        strategyName: 'OB + HTF Fib',
        patternTf: tf,
        entryTf: tf,
        setupTf: tf,
        obTf: tf,
        htf: weekly.refTf || '1w',
        pattern: 'OB+FIB',
        breakoutConfirmed: true,
        obFib: {
          tf,
          refTf: weekly.refTf || '1w',
          refLabel: weekly.refLabel || 'Weekly',
          weekly: {
            time: weekly.time,
            open: weekly.open,
            high: weekly.high,
            low: weekly.low,
            close: weekly.close,
            candleDir: weekly.candleDir,
            dir: weekly.dir,
            forced: weekly.forced,
          },
          levels: weekly.levels.map((l) => ({ ratio: l.ratio, price: l.price, selected: l.selected })),
          hitRatio: fib.ratio,
          hitPrice: fib.price,
          hitRatios: hits.map((h) => h.ratio),
          matchMode: cfg.fibMatchMode,
          chartEnabled: cfg.chartEnabled,
          mitigation: cfg.mitigation,
          entryMode: cfg.entryMode,
          // LuxAlgo parameters the OB was found with — used later to re-check that the OB still exists
          lux: {
            length: cfg.obLength,
            bullExtLast: cfg.bullExtLast,
            bearExtLast: cfg.bearExtLast,
            mitigation: cfg.mitigation,
          },
          zone: { high: r8(top), low: r8(btm), mid: r8(mid) },
        },
        minScoreAtCreate: cfg.minScore,
        minRR: cfg.minRR,
        riskATR: levels.riskATR,
      },
    });
  }
  return out;
}

// ───────────────────────────── Backtest ─────────────────────────────

/**
 * Walk candles after signal bar and resolve TP1 / SL.
 * Entry is taken from the OB (mid of zone by default when entryMode=mid, else fib-in-zone).
 * SL sits just beyond the OB band: LONG → below lower line · SHORT → above upper line.
 */
function resolveObFibTrade(candles, fromIdx, dir, entry, sl, tp1, maxBars = 80) {
  const isLong = dir === 'LONG';
  let mfe = 0;
  let mae = 0;
  const last = Math.min(candles.length - 1, fromIdx + maxBars);
  // entry bar itself: only count adverse if it already pierces SL
  const c0 = candles[fromIdx];
  if (c0) {
    const adv0 = isLong ? entry - +c0.low : +c0.high - entry;
    mae = Math.max(mae, adv0);
    if (isLong ? +c0.low <= sl : +c0.high >= sl) {
      return { outcome: 'LOSS', hit: 'SL', bars: 0, exitPrice: sl, mfePct: 0, maePct: +( (mae / entry) * 100 ).toFixed(3), retPct: isLong ? +(((sl - entry) / entry) * 100).toFixed(3) : +(((entry - sl) / entry) * 100).toFixed(3) };
    }
  }
  for (let j = fromIdx + 1; j <= last; j++) {
    const c = candles[j];
    const fav = isLong ? +c.high - entry : entry - +c.low;
    const adv = isLong ? entry - +c.low : +c.high - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    const hitSl = isLong ? +c.low <= sl : +c.high >= sl;
    const hitTp = isLong ? +c.high >= tp1 : +c.low <= tp1;
    // same bar: SL first (conservative)
    if (hitSl) {
      return {
        outcome: 'LOSS',
        hit: 'SL',
        bars: j - fromIdx,
        exitPrice: sl,
        mfePct: +((mfe / entry) * 100).toFixed(3),
        maePct: +((mae / entry) * 100).toFixed(3),
        retPct: isLong ? +(((sl - entry) / entry) * 100).toFixed(3) : +(((entry - sl) / entry) * 100).toFixed(3),
      };
    }
    if (hitTp) {
      return {
        outcome: 'WIN',
        hit: 'TP1',
        bars: j - fromIdx,
        exitPrice: tp1,
        mfePct: +((mfe / entry) * 100).toFixed(3),
        maePct: +((mae / entry) * 100).toFixed(3),
        retPct: isLong ? +(((tp1 - entry) / entry) * 100).toFixed(3) : +(((entry - tp1) / entry) * 100).toFixed(3),
      };
    }
  }
  const resolved = candles.length - 1 >= fromIdx + maxBars;
  const close = +candles[last].close;
  const retPct = isLong ? +(((close - entry) / entry) * 100).toFixed(3) : +(((entry - close) / entry) * 100).toFixed(3);
  return {
    outcome: resolved ? 'TIMEOUT' : 'OPEN',
    hit: resolved ? 'TIMEOUT' : 'OPEN',
    bars: last - fromIdx,
    exitPrice: close,
    mfePct: +((mfe / entry) * 100).toFixed(3),
    maePct: +((mae / entry) * 100).toFixed(3),
    retPct: resolved ? retPct : null,
  };
}

/**
 * Historical OB + HTF Fib events for one LTF candle series.
 * @param {object} opts
 *  candles (LTF), weeklyCandles (HTF), refTf, tf, config, maxBars (forward horizon)
 */
export function findObFibEvents(opts = {}) {
  const { candles: raw, weeklyCandles, refTf = '1w', tf = '15m', maxBars = 80 } = opts;
  const cfg = normalizeObFibConfig(opts.config || {});
  // Entry from OB: force mid of the zone for backtest unless caller overrides
  if (opts.entryFromOb !== false) cfg.entryMode = 'mid';
  const candles = validCandles(raw);
  if (candles.length < 80) return [];

  const atr = calcATR(candles, 14);
  if (!(atr > 0)) return [];

  // Historical detector keeps mitigated OBs with mitigatedAt index.
  // Live detector would DROP them → survivorship bias (win rate උඩට යයි).
  const obs = detectLuxAlgoOrderBlocksHistorical(candles, Math.min(Math.max(cfg.lookback, 500), candles.length), {
    length: cfg.obLength,
    bullExtLast: cfg.bullExtLast,
    bearExtLast: cfg.bearExtLast,
    mitigation: cfg.mitigation,
  });

  const events = [];
  const seen = new Set(); // de-dupe by ob time + dir

  for (const ob of obs) {
    const dir = ob.type === 'bearish' ? 'SHORT' : 'LONG';
    if (dir === 'LONG' && !cfg.allowLong) continue;
    if (dir === 'SHORT' && !cfg.allowShort) continue;

    const key = `${ob.time}:${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const top = Math.max(ob.high, ob.low);
    const btm = Math.min(ob.high, ob.low);
    const mid = (top + btm) / 2;
    const half = Math.max((top - btm) / 2, 1e-12);

    const obIdx = Number.isFinite(+ob.index) ? +ob.index : candles.findIndex((c) => +c.time === +ob.time);
    if (obIdx < 0 || obIdx >= candles.length - 2) continue;
    // Confirmation bar must exist (LuxAlgo waits length bars after pivot)
    const confBar = Number.isFinite(+ob.confBar) ? +ob.confBar : obIdx + (cfg.obLength || 5);
    if (confBar >= candles.length - 1) continue;

    // extreme filter (same as live)
    if (cfg.requireExtremeOb) {
      const a = Math.max(0, obIdx - cfg.extremeWindow);
      const b = Math.min(candles.length - 1, obIdx + cfg.extremeWindow);
      const tol = cfg.extremeTolATR * atr;
      if (dir === 'SHORT') {
        let mx = -Infinity;
        for (let k = a; k <= b; k++) mx = Math.max(mx, +candles[k].high);
        if (+candles[obIdx].high < mx - tol) continue;
      } else {
        let mn = Infinity;
        for (let k = a; k <= b; k++) mn = Math.min(mn, +candles[k].low);
        if (+candles[obIdx].low > mn + tol) continue;
      }
    }
    if (cfg.maxObWidthATR > 0 && top - btm > cfg.maxObWidthATR * atr) continue;

    // HTF fib as of the OB bar time (no look-ahead into forming HTF candle)
    const nowSec = +candles[obIdx].time;
    const weekly = computeWeeklyFib(weeklyCandles, cfg, nowSec, refTf);
    if (!weekly?.levels?.length) continue;

    const selectedFibs = weekly.levels.filter((l) => l.selected);
    const hits = selectedFibs.filter((f) => fibInZone(f.price, { high: top, low: btm }, cfg, atr));
    if (!hits.length) continue;
    if (cfg.singleFibOnly && hits.length > 1) continue;

    const fib = [...hits].sort((a, b) => Math.abs(a.price - mid) - Math.abs(b.price - mid))[0];
    // Entry from OB (mid of band)
    const entryRef = cfg.entryMode === 'mid' ? mid : Math.min(top, Math.max(btm, fib.price));
    const levels = buildLevels(dir, entryRef, { high: top, low: btm }, atr, cfg);
    if (!levels || levels.rr < cfg.minRR) continue;

    // First touch of entry after OB forms → signal bar
    let entryIdx = -1;
    for (let k = obIdx + 1; k < candles.length; k++) {
      if (+candles[k].low <= levels.entry && +candles[k].high >= levels.entry) {
        entryIdx = k;
        break;
      }
    }
    if (entryIdx < 0) continue; // never filled

    // LuxAlgo: if market already broke the OB zone BEFORE entry fill, zone is gone → no trade
    // mitigatedAt = first bar where wick/close pierced beyond the OB band
    if (ob.mitigatedAt != null && entryIdx >= ob.mitigatedAt) continue;
    // also require OB still alive at least until confBar (no trade on already-dead zone)
    if (ob.mitigatedAt != null && ob.mitigatedAt <= confBar) continue;

    const zoneMidDistPct = Math.abs(fib.price - mid) / half;
    const distATR = 0; // at fill
    const score = scoreSetup({ ob, fib, matches: hits.length, weekly, dir, distATR, zoneMidDistPct });
    if (score < cfg.minScore) continue;

    const res = resolveObFibTrade(candles, entryIdx, dir, levels.entry, levels.sl, levels.tp1, maxBars);

    events.push({
      index: entryIdx,
      time: +candles[entryIdx].time,
      obTime: +ob.time,
      dir,
      tf,
      refTf,
      refLabel: weekly.refLabel || refTf,
      fibRatio: fib.ratio,
      fibPrice: fib.price,
      entry: levels.entry,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rr: levels.rr,
      score,
      ob: { high: r8(top), low: r8(btm), type: ob.type, status: ob.status },
      weeklyDir: weekly.dir,
      ...res,
    });
  }

  events.sort((a, b) => a.time - b.time);
  return events;
}

export function tallyObFib(list) {
  const t = {
    total: list.length,
    win: 0,
    loss: 0,
    timeout: 0,
    open: 0,
    winRate: null,
    avgRetPct: null,
    avgMfePct: null,
    avgMaePct: null,
    avgBars: null,
  };
  let rs = 0;
  let rn = 0;
  let mf = 0;
  let ma = 0;
  let bars = 0;
  let bn = 0;
  for (const e of list) {
    if (e.outcome === 'WIN') t.win++;
    else if (e.outcome === 'LOSS') t.loss++;
    else if (e.outcome === 'TIMEOUT') t.timeout++;
    else t.open++;
    if (e.retPct != null) {
      rs += e.retPct;
      rn++;
      mf += e.mfePct || 0;
      ma += e.maePct || 0;
    }
    if (e.bars != null) {
      bars += e.bars;
      bn++;
    }
  }
  const done = t.win + t.loss;
  if (done) t.winRate = +((t.win / done) * 100).toFixed(1);
  if (rn) {
    t.avgRetPct = +(rs / rn).toFixed(3);
    t.avgMfePct = +(mf / rn).toFixed(3);
    t.avgMaePct = +(ma / rn).toFixed(3);
  }
  if (bn) t.avgBars = +(bars / bn).toFixed(1);
  return t;
}

/**
 * @param {object} opts { candles, weeklyCandles, refTf, tf, config, maxBars }
 */
export function backtestObFib(opts = {}) {
  const events = findObFibEvents(opts);
  return { events, tally: tallyObFib(events), cfg: normalizeObFibConfig(opts.config || {}) };
}

// ───────────────────────────── Chart (SVG) ─────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
function fmtChartTime(t, tzMin) {
  const d = new Date((t + (tzMin || 0) * 60) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
function fmtChartPrice(p) {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 5 : 6;
  return (+p).toFixed(dp);
}

/**
 * Candle chart for an OB+Fib backtest event: OB zone, entry/SL/TP1 lines, event bar.
 * opts: { symbol, tf, before, after, tzMin, width, height }
 */
export function buildObFibChartSvg(candles, ev, opts = {}) {
  const { symbol = '', tf = '', before = 60, after = 40, tzMin = 0, width = 900, height = 480 } = opts;
  const candlesV = validCandles(candles);
  const evIdx = Number.isFinite(+ev.index)
    ? +ev.index
    : candlesV.findIndex((c) => +c.time === +ev.time);
  if (evIdx < 0) return null;
  const from = Math.max(0, evIdx - before);
  const to = Math.min(candlesV.length - 1, evIdx + after);
  const vis = candlesV.slice(from, to + 1);
  if (vis.length < 8) return null;

  const L = 10;
  const R = 78;
  const T = 48;
  const B = 36;
  const pw = width - L - R;
  const ph = height - T - B;
  const step = pw / vis.length;
  const bw = Math.max(1, Math.min(10, step * 0.65));

  const levels = [ev.entry, ev.sl, ev.tp1, ev.ob?.high, ev.ob?.low].filter((x) => Number.isFinite(+x)).map(Number);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of vis) {
    lo = Math.min(lo, +c.low);
    hi = Math.max(hi, +c.high);
  }
  for (const p of levels) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const padP = (hi - lo) * 0.08 || hi * 0.01;
  lo -= padP;
  hi += padP;
  const y = (p) => T + ph - ((p - lo) / (hi - lo)) * ph;
  const x = (k) => L + step * k + step / 2;

  const isLong = ev.dir === 'LONG';
  const dirColor = isLong ? '#0ecb81' : '#f6465d';
  const g = [];
  g.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,Helvetica,sans-serif">`);
  g.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

  for (let n = 0; n <= 6; n++) {
    const p = lo + ((hi - lo) * n) / 6;
    const yy = y(p).toFixed(1);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy}" y2="${yy}" stroke="#eceff3"/>`);
    g.push(`<text x="${L + pw + 6}" y="${(+yy + 4).toFixed(1)}" font-size="11" fill="#555">${fmtChartPrice(p)}</text>`);
  }

  const labelEvery = Math.max(1, Math.round(vis.length / 6));
  for (let k = 0; k < vis.length; k += labelEvery) {
    g.push(`<text x="${x(k).toFixed(1)}" y="${height - 12}" font-size="10" fill="#666" text-anchor="middle">${fmtChartTime(vis[k].time, tzMin).slice(5)}</text>`);
  }

  // OB zone band
  if (ev.ob && Number.isFinite(+ev.ob.high) && Number.isFinite(+ev.ob.low)) {
    const top = Math.max(+ev.ob.high, +ev.ob.low);
    const btm = Math.min(+ev.ob.high, +ev.ob.low);
    const y1 = y(top);
    const y2 = y(btm);
    g.push(`<rect x="${L}" y="${Math.min(y1, y2).toFixed(1)}" width="${pw}" height="${Math.max(1, Math.abs(y2 - y1)).toFixed(1)}" fill="${dirColor}" opacity="0.12"/>`);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${y1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${dirColor}" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>`);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${y2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${dirColor}" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>`);
  }

  // entry / SL / TP1
  const hline = (price, color, label) => {
    if (!Number.isFinite(+price)) return;
    const yy = y(+price);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${color}" stroke-width="1.4"/>`);
    g.push(`<text x="${L + 4}" y="${(yy - 3).toFixed(1)}" font-size="10" fill="${color}" font-weight="600">${label} ${fmtChartPrice(price)}</text>`);
  };
  hline(ev.entry, '#2962ff', 'Entry');
  hline(ev.sl, '#f6465d', 'SL');
  hline(ev.tp1, '#0ecb81', 'TP1');

  // event bar highlight
  const ek = evIdx - from;
  g.push(`<rect x="${(x(ek) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" fill="${dirColor}" opacity="0.14"/>`);
  g.push(`<line x1="${x(ek).toFixed(1)}" x2="${x(ek).toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="${dirColor}" stroke-dasharray="4 3"/>`);

  // candles
  for (let k = 0; k < vis.length; k++) {
    const c = vis[k];
    const col = +c.close >= +c.open ? '#089981' : '#f23645';
    const cx = x(k).toFixed(1);
    g.push(`<line x1="${cx}" x2="${cx}" y1="${y(+c.high).toFixed(1)}" y2="${y(+c.low).toFixed(1)}" stroke="${col}"/>`);
    const top = y(Math.max(+c.open, +c.close));
    const hgt = Math.max(1, Math.abs(y(+c.open) - y(+c.close)));
    g.push(`<rect x="${(x(k) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"/>`);
  }

  const outcome = ev.outcome || '';
  const title = `${symbol || ev.symbol || ''} · ${tf || ev.tf || ''} · OB+Fib ${isLong ? '▲ LONG' : '▼ SHORT'} · ${outcome}`;
  g.push(`<text x="${L}" y="18" font-size="14" font-weight="700" fill="${dirColor}">${title}</text>`);
  g.push(
    `<text x="${L}" y="36" font-size="11" fill="#444">${fmtChartTime(ev.time, tzMin)} · Fib ${ev.fibRatio ?? '—'} @ ${fmtChartPrice(ev.fibPrice || 0)} · ${ev.refLabel || ev.refTf || ''} · RR ${ev.rr ?? '—'}</text>`
  );
  g.push('</svg>');
  return g.join('');
}
