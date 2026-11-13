/**
 * Breaker Block Engine — port of AGPro Breaker Block Engine [v2.1] core logic.
 *
 * Tracks failed order-block transitions after displacement break:
 *  - Pivot high → last opposite (bearish) candle behind it = bear source
 *  - Close breaks above source top + displacement → Bullish Breaker
 *  - Pivot low → last bullish candle behind it = bull source
 *  - Close breaks below source bot − displacement → Bearish Breaker
 *
 * Lifecycle: Fresh → retests/holds → READY / Weakening / Invalidated
 */
import { calcATR } from '../../indicators.js';

export const BREAKER_DEFAULTS = {
  sensitivityMode: 'Balanced', // Conservative | Balanced | Aggressive
  pivotLen: 5,
  sourceSearchBars: 10,
  maxActive: 4,
  overlapRetirePct: 60,
  atrLen: 14,
  dispMult: 0.75,
  confirmationMode: 'Close + Retest', // Close Only | Close + Retest | Close + Volume
  minReadyScore: 65,
  volLen: 20,
  invalidBuf: 0.12,
  targetRR: 1.5,
  retestGap: 5,
  timeDecayBars: 160,
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeCfg(raw = {}) {
  const d = BREAKER_DEFAULTS;
  const num = (v, fb, lo, hi) => {
    const n = +v;
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    sensitivityMode: ['Conservative', 'Balanced', 'Aggressive'].includes(raw.sensitivityMode)
      ? raw.sensitivityMode
      : d.sensitivityMode,
    pivotLen: Math.round(num(raw.pivotLen, d.pivotLen, 2, 20)),
    sourceSearchBars: Math.round(num(raw.sourceSearchBars, d.sourceSearchBars, 3, 30)),
    maxActive: Math.round(num(raw.maxActive, d.maxActive, 1, 8)),
    overlapRetirePct: num(raw.overlapRetirePct, d.overlapRetirePct, 25, 95),
    atrLen: Math.round(num(raw.atrLen, d.atrLen, 5, 100)),
    dispMult: num(raw.dispMult, d.dispMult, 0.1, 3),
    confirmationMode: ['Close Only', 'Close + Retest', 'Close + Volume'].includes(raw.confirmationMode)
      ? raw.confirmationMode
      : d.confirmationMode,
    minReadyScore: Math.round(num(raw.minReadyScore, d.minReadyScore, 0, 100)),
    volLen: Math.round(num(raw.volLen, d.volLen, 5, 100)),
    invalidBuf: num(raw.invalidBuf, d.invalidBuf, 0, 1),
    targetRR: num(raw.targetRR, d.targetRR, 0.5, 5),
    retestGap: Math.round(num(raw.retestGap, d.retestGap, 1, 30)),
    timeDecayBars: Math.round(num(raw.timeDecayBars, d.timeDecayBars, 30, 600)),
  };
}

/** Pivot high/low at index i (confirmed with left/right lookback). */
function findPivots(candles, left, right) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isH = true;
    let isL = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i].high <= candles[i - j].high) isH = false;
      if (candles[i].low >= candles[i - j].low) isL = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i].high <= candles[i + j].high) isH = false;
      if (candles[i].low >= candles[i + j].low) isL = false;
    }
    if (isH) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (isL) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

function smaVol(candles, i, len) {
  let s = 0;
  let n = 0;
  for (let k = Math.max(0, i - len + 1); k <= i; k++) {
    s += +candles[k].volume || 0;
    n++;
  }
  return n ? s / n : 0;
}

function originScore(top, bot, breakLvl, close, breakThr, atr, volRatio) {
  const zoneHeight = Math.max(top - bot, 1e-12);
  const dispScore = clamp(Math.abs(close - breakLvl) / Math.max(breakThr, 1e-12) * 14, 0, 14);
  const volumeScore = clamp(((volRatio - 0.8) / 1.2) * 8, 0, 8);
  const compactScore = clamp(8 - Math.max(0, zoneHeight / Math.max(atr, 1e-12) - 1.35) * 4, 2, 8);
  return clamp(dispScore + volumeScore + compactScore, 0, 30);
}

function invalidLevel(br, atr, invalidBuf) {
  return br.isBull ? br.bot - atr * invalidBuf : br.top + atr * invalidBuf;
}

function targetLevel(br, atr, invalidBuf, targetRR) {
  const inv = invalidLevel(br, atr, invalidBuf);
  const riskRef = br.isBull ? br.top - inv : inv - br.bot;
  return br.isBull ? br.top + riskRef * targetRR : br.bot - riskRef * targetRR;
}

function reclaimScore(br, close) {
  const mid = (br.top + br.bot) / 2;
  if (br.isBull) {
    if (close > br.top) return 20;
    if (close >= mid) return 14;
    if (close >= br.bot) return 8;
    return 0;
  }
  if (close < br.bot) return 20;
  if (close <= mid) return 14;
  if (close <= br.top) return 8;
  return 0;
}

function qualityOf(br, close, atr, timeDecayBars, barIndex) {
  const retestComponent = br.retests > 0 ? (25 * br.holds) / br.retests : 12;
  const reclaimComponent = reclaimScore(br, close);
  const reactionComponent = clamp(br.holds * 5, 0, 10);
  const age = barIndex - br.bornBar;
  const freshnessComponent = clamp(15 * (1 - age / timeDecayBars), 0, 15);
  return clamp(br.originScore + retestComponent + reclaimComponent + reactionComponent + freshnessComponent, 0, 100);
}

function defenseState(br, close, timeDecayBars, barIndex) {
  if (!br.alive) return 'Invalidated';
  if (br.retests === 0) return 'Fresh';
  const holdRate = br.retests > 0 ? (100 * br.holds) / br.retests : null;
  if (holdRate != null && holdRate >= 70 && reclaimScore(br, close) >= 14) return 'Defended';
  if (holdRate != null && holdRate < 50) return 'Weakening';
  if (barIndex - br.bornBar > timeDecayBars) return 'Aging';
  return 'Testing';
}

function actionOf(br, close, cfg, timeDecayBars, barIndex) {
  const state = defenseState(br, close, timeDecayBars, barIndex);
  const readyNeedsRetest = cfg.confirmationMode === 'Close + Retest';
  const retestOk = !readyNeedsRetest || br.retests > 0;
  if (!br.alive) return 'Remove Context';
  if (br.quality >= cfg.minReadyScore && retestOk && state !== 'Weakening') return 'READY';
  if (br.retests === 0 && readyNeedsRetest) return 'Wait Retest';
  if (state === 'Weakening') return 'Reduce Trust';
  if (br.quality >= Math.max(40, cfg.minReadyScore - 15)) return 'Monitor';
  return 'Stand Aside';
}

function overlapRatio(a, b) {
  const overlapHeight = Math.max(0, Math.min(a.top, b.top) - Math.max(a.bot, b.bot));
  const smallerHeight = Math.max(Math.min(a.top - a.bot, b.top - b.bot), 1e-12);
  return overlapHeight / smallerHeight;
}

/**
 * Scan candles left→right and return all breakers still relevant near the end
 * (alive + recently invalidated), with lifecycle updated.
 */
export function detectBreakers(candles, cfgIn = {}) {
  const cfg = normalizeCfg(cfgIn);
  if (!candles || candles.length < cfg.pivotLen * 2 + 20) return [];

  const atrSeries = [];
  // simple rolling ATR via calcATR on prefixes is expensive; use final ATR for thresholds
  const atr = calcATR(candles, cfg.atrLen) || candles[candles.length - 1].close * 0.01;
  const sens = cfg.sensitivityMode === 'Conservative' ? 1.15 : cfg.sensitivityMode === 'Aggressive' ? 0.85 : 1;
  const breakThr = atr * cfg.dispMult * sens;

  const { highs, lows } = findPivots(candles, cfg.pivotLen, cfg.pivotLen);
  // Map: after pivot confirms at index pivot+right, we can use source
  // We'll iterate bar by bar for breaks, looking up latest confirmed pivots

  const bulls = [];
  const bears = [];
  let nextId = 0;

  let bearSource = null; // { top, bot, bar }
  let bullSource = null;

  const highByConfirm = new Map(); // confirmBar -> pivot
  const lowByConfirm = new Map();
  for (const h of highs) {
    highByConfirm.set(h.i + cfg.pivotLen, h);
  }
  for (const l of lows) {
    lowByConfirm.set(l.i + cfg.pivotLen, l);
  }

  const pushBreaker = (list, other, br) => {
    // retire overlaps
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].alive && overlapRatio(list[i], br) * 100 >= cfg.overlapRetirePct) {
        list[i].alive = false;
        list[i].deadSince = br.bornBar;
      }
    }
    for (let i = other.length - 1; i >= 0; i--) {
      if (other[i].alive && overlapRatio(other[i], br) * 100 >= cfg.overlapRetirePct) {
        other[i].alive = false;
        other[i].deadSince = br.bornBar;
      }
    }
    list.push(br);
    while (list.filter((x) => x.alive).length > cfg.maxActive) {
      const idx = list.findIndex((x) => x.alive);
      if (idx < 0) break;
      list[idx].alive = false;
      list[idx].deadSince = br.bornBar;
    }
  };

  const start = cfg.pivotLen * 2 + 5;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const close = +c.close;
    const high = +c.high;
    const low = +c.low;
    const volAvg = smaVol(candles, i, cfg.volLen);
    const volRatio = volAvg > 0 ? (+c.volume || 0) / volAvg : 1;
    const volumeConfirmed = (+c.volume || 0) > volAvg;
    const volumeModeOk = cfg.confirmationMode !== 'Close + Volume' || volumeConfirmed;

    // Update sources when pivots confirm
    if (highByConfirm.has(i)) {
      const pivot = highByConfirm.get(i);
      // search behind pivot for last bearish candle
      for (let k = pivot.i; k >= Math.max(0, pivot.i - cfg.sourceSearchBars); k--) {
        if (candles[k].close < candles[k].open) {
          bearSource = { top: +candles[k].high, bot: +candles[k].low, bar: k, time: candles[k].time };
          break;
        }
      }
    }
    if (lowByConfirm.has(i)) {
      const pivot = lowByConfirm.get(i);
      for (let k = pivot.i; k >= Math.max(0, pivot.i - cfg.sourceSearchBars); k--) {
        if (candles[k].close > candles[k].open) {
          bullSource = { top: +candles[k].high, bot: +candles[k].low, bar: k, time: candles[k].time };
          break;
        }
      }
    }

    // New bullish breaker
    if (bearSource && volumeModeOk && close > bearSource.top + breakThr) {
      nextId += 1;
      const origin = originScore(bearSource.top, bearSource.bot, bearSource.top, close, breakThr, atr, volRatio);
      const br = {
        id: nextId,
        isBull: true,
        side: 'BULL',
        top: bearSource.top,
        bot: bearSource.bot,
        bornBar: i,
        bornTime: c.time,
        obBar: bearSource.bar,
        obTime: bearSource.time,
        breakLevel: bearSource.top,
        originScore: origin,
        quality: origin + 12,
        retests: 0,
        holds: 0,
        alive: true,
        lastRetestBar: i,
        deadSince: 0,
      };
      pushBreaker(bulls, bears, br);
      bearSource = null;
    }

    // New bearish breaker
    if (bullSource && volumeModeOk && close < bullSource.bot - breakThr) {
      nextId += 1;
      const origin = originScore(bullSource.top, bullSource.bot, bullSource.bot, close, breakThr, atr, volRatio);
      const br = {
        id: nextId,
        isBull: false,
        side: 'BEAR',
        top: bullSource.top,
        bot: bullSource.bot,
        bornBar: i,
        bornTime: c.time,
        obBar: bullSource.bar,
        obTime: bullSource.time,
        breakLevel: bullSource.bot,
        originScore: origin,
        quality: origin + 12,
        retests: 0,
        holds: 0,
        alive: true,
        lastRetestBar: i,
        deadSince: 0,
      };
      pushBreaker(bears, bulls, br);
      bullSource = null;
    }

    // Update lifecycle for all active
    const update = (list) => {
      for (const br of list) {
        if (!br.alive) continue;
        const inv = invalidLevel(br, atr, cfg.invalidBuf);
        const invalidated = br.isBull ? close < inv : close > inv;
        if (invalidated) {
          br.alive = false;
          br.deadSince = i;
          br.quality = Math.min(br.quality, 20);
          continue;
        }
        const inZone = low <= br.top && high >= br.bot;
        const spaced = i - br.lastRetestBar >= cfg.retestGap;
        if (inZone && spaced) {
          br.retests += 1;
          br.lastRetestBar = i;
          const held = br.isBull ? close > br.bot : close < br.top;
          if (held) br.holds += 1;
        }
        br.quality = qualityOf(br, close, atr, cfg.timeDecayBars, i);
        br.state = defenseState(br, close, cfg.timeDecayBars, i);
        br.action = actionOf(br, close, cfg, cfg.timeDecayBars, i);
        br.invalidLevel = inv;
        br.targetLevel = targetLevel(br, atr, cfg.invalidBuf, cfg.targetRR);
      }
    };
    update(bulls);
    update(bears);
  }

  const last = candles.length - 1;
  const close = +candles[last].close;
  const all = [...bulls, ...bears].map((br) => {
    const state = br.state || defenseState(br, close, cfg.timeDecayBars, last);
    const action = br.action || actionOf(br, close, cfg, cfg.timeDecayBars, last);
    return {
      id: br.id,
      isBull: br.isBull,
      side: br.side,
      top: br.top,
      bot: br.bot,
      mid: (br.top + br.bot) / 2,
      bornBar: br.bornBar,
      bornTime: br.bornTime,
      obBar: br.obBar,
      obTime: br.obTime,
      breakLevel: br.breakLevel,
      quality: +br.quality.toFixed(1),
      retests: br.retests,
      holds: br.holds,
      alive: br.alive,
      state,
      action,
      invalidLevel: br.invalidLevel ?? invalidLevel(br, atr, cfg.invalidBuf),
      targetLevel: br.targetLevel ?? targetLevel(br, atr, cfg.invalidBuf, cfg.targetRR),
    };
  });

  // Prefer alive; keep recent dead for context
  return all
    .filter((b) => b.alive || last - (b.bornBar || 0) < 80)
    .sort((a, b) => Number(b.alive) - Number(a.alive) || b.quality - a.quality);
}

/**
 * True if D-zone (przLow–przHigh) significantly overlaps a breaker zone,
 * or the D mid sits inside the breaker (slightly above/below allowed via pad).
 */
export function breakerOverlapsDzone(breaker, przLow, przHigh, atr = 0, padAtr = 0.25) {
  if (!breaker || przLow == null || przHigh == null) return false;
  const pad = (atr || 0) * padAtr;
  const dLo = Math.min(przLow, przHigh) - pad;
  const dHi = Math.max(przLow, przHigh) + pad;
  const overlap = Math.max(0, Math.min(breaker.top, dHi) - Math.max(breaker.bot, dLo));
  const dHeight = Math.max(dHi - dLo, 1e-12);
  const brHeight = Math.max(breaker.top - breaker.bot, 1e-12);
  // mid of D inside breaker, or ≥35% overlap of smaller height
  const dMid = (przLow + przHigh) / 2;
  const midIn = dMid >= breaker.bot - pad && dMid <= breaker.top + pad;
  const ratio = overlap / Math.min(dHeight, brHeight);
  return midIn || ratio >= 0.35;
}

export function findBreakersForDzone(breakers, przLow, przHigh, direction, atr, padAtr = 0.25) {
  const list = (breakers || []).filter((b) => b.alive);
  // Prefer matching side: LONG entry likes bull breaker, SHORT likes bear
  const ranked = list
    .map((b) => ({
      b,
      overlap: breakerOverlapsDzone(b, przLow, przHigh, atr, padAtr),
      sideMatch: direction === 'LONG' ? b.isBull : !b.isBull,
    }))
    .filter((x) => x.overlap)
    .sort((a, b) => Number(b.sideMatch) - Number(a.sideMatch) || b.b.quality - a.b.quality);
  return ranked.map((x) => x.b);
}

export { normalizeCfg as normalizeBreakerConfig };
