import { avg } from './indicators.js';

/**
 * Order Block detection — dual source:
 *  1) Legacy displacement OBs (unchanged zones for existing strategy/charts)
 *  2) LuxAlgo volume-pivot OBs — tagged source: 'luxalgo' → drawn as "OTHER OB"
 *
 * detectOrderBlocks() returns BOTH (legacy first, then lux), same shape as before.
 */

const LUX_DEFAULTS = {
  length: 5,
  bullExtLast: 3,
  bearExtLast: 3,
  mitigation: 'Wick',
};

/**
 * Original displacement-based order blocks (preserved exactly).
 */
export function detectLegacyOrderBlocks(candles, lookback = 80) {
  const obs = [];
  const len = candles.length;
  if (len < 20) return obs;
  const ranges = candles.slice(-30).map((c) => c.high - c.low);
  const avgRange = avg(ranges) || 0.001;

  for (let i = Math.max(3, len - lookback); i < len - 5; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const isBull = c.close > c.open;
    const isBear = c.close < c.open;

    // Bullish OB
    if (isBear && body > avgRange * 0.4) {
      let disp = 0;
      let volExp = false;
      for (let j = 1; j <= 6; j++) {
        if (i + j >= len) break;
        const n = candles[i + j];
        if (n.close > n.open) {
          disp += n.close - n.open;
          if (n.volume > candles[i].volume * 1.3) volExp = true;
        }
      }
      if (disp > avgRange * 1.8) {
        const high = c.high;
        const low = Math.min(c.open, c.close);
        const mid = (high + low) / 2;
        let tests = 0;
        let mitigated = false;
        for (let k = i + 1; k < len; k++) {
          if (candles[k].low <= high && candles[k].high >= low) {
            tests++;
            if (candles[k].close < low) mitigated = true;
          }
        }
        let status = 'FRESH';
        if (mitigated) status = 'INVALIDATED';
        else if (tests >= 3) status = 'TESTED MULTIPLE';
        else if (tests >= 1) status = 'TESTED ONCE';

        obs.push({
          type: 'bullish',
          high,
          low,
          mid,
          index: i,
          time: c.time,
          status,
          tests,
          displacement: disp,
          volumeExp: volExp,
          strength: Math.min(
            100,
            (disp / avgRange) * 25 +
              (volExp ? 15 : 0) +
              (status === 'FRESH' ? 20 : status === 'TESTED ONCE' ? 10 : 0)
          ),
          source: 'legacy',
        });
      }
    }

    // Bearish OB
    if (isBull && body > avgRange * 0.4) {
      let disp = 0;
      let volExp = false;
      for (let j = 1; j <= 6; j++) {
        if (i + j >= len) break;
        const n = candles[i + j];
        if (n.close < n.open) {
          disp += n.open - n.close;
          if (n.volume > candles[i].volume * 1.3) volExp = true;
        }
      }
      if (disp > avgRange * 1.8) {
        const low = c.low;
        const high = Math.max(c.open, c.close);
        const mid = (high + low) / 2;
        let tests = 0;
        let mitigated = false;
        for (let k = i + 1; k < len; k++) {
          if (candles[k].low <= high && candles[k].high >= low) {
            tests++;
            if (candles[k].close > high) mitigated = true;
          }
        }
        let status = 'FRESH';
        if (mitigated) status = 'INVALIDATED';
        else if (tests >= 3) status = 'TESTED MULTIPLE';
        else if (tests >= 1) status = 'TESTED ONCE';

        obs.push({
          type: 'bearish',
          high,
          low,
          mid,
          index: i,
          time: c.time,
          status,
          tests,
          displacement: disp,
          volumeExp: volExp,
          strength: Math.min(
            100,
            (disp / avgRange) * 25 +
              (volExp ? 15 : 0) +
              (status === 'FRESH' ? 20 : status === 'TESTED ONCE' ? 10 : 0)
          ),
          source: 'legacy',
        });
      }
    }
  }
  return obs;
}

/**
 * LuxAlgo Order Block Detector port (volume pivot + os bias + wick/close mitigation).
 */
export function detectLuxAlgoOrderBlocks(candles, lookback = 150, opts = {}) {
  const length = Math.max(1, Number(opts.length ?? LUX_DEFAULTS.length));
  const bullExtLast = Math.max(1, Number(opts.bullExtLast ?? LUX_DEFAULTS.bullExtLast));
  const bearExtLast = Math.max(1, Number(opts.bearExtLast ?? LUX_DEFAULTS.bearExtLast));
  const mitigation = opts.mitigation === 'Close' ? 'Close' : 'Wick';

  const len = candles?.length || 0;
  if (len < length * 2 + 5) return [];

  const start = Math.max(0, len - Math.max(lookback, length * 4 + 20));

  function highestHigh(i, n) {
    let m = -Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (k >= 0 && candles[k].high > m) m = candles[k].high;
    }
    return m;
  }
  function lowestLow(i, n) {
    let m = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (k >= 0 && candles[k].low < m) m = candles[k].low;
    }
    return m;
  }
  function lowestClose(i, n) {
    let m = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (k >= 0 && candles[k].close < m) m = candles[k].close;
    }
    return m;
  }
  function highestClose(i, n) {
    let m = -Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (k >= 0 && candles[k].close > m) m = candles[k].close;
    }
    return m;
  }

  function isVolumePivotHigh(i) {
    if (i - length < 0 || i + length >= len) return false;
    const v = Number(candles[i].volume) || 0;
    for (let k = i - length; k <= i + length; k++) {
      if (k === i) continue;
      if ((Number(candles[k].volume) || 0) >= v) return false;
    }
    return true;
  }

  const os = new Array(len).fill(0);
  for (let i = length; i < len; i++) {
    const upper = highestHigh(i, length);
    const lower = lowestLow(i, length);
    const hiL = candles[i - length].high;
    const loL = candles[i - length].low;
    if (hiL > upper) os[i] = 0;
    else if (loL < lower) os[i] = 1;
    else os[i] = os[i - 1];
  }

  const bullRaw = [];
  const bearRaw = [];

  for (let pivotIndex = Math.max(start, length); pivotIndex < len - length; pivotIndex++) {
    if (!isVolumePivotHigh(pivotIndex)) continue;
    const confBar = pivotIndex + length;
    if (confBar >= len) continue;
    const state = os[confBar];
    const c = candles[pivotIndex];
    const hl2 = (c.high + c.low) / 2;

    if (state === 1) {
      bullRaw.push({
        top: hl2,
        btm: c.low,
        avg: (hl2 + c.low) / 2,
        leftIndex: pivotIndex,
        pivotIndex,
        time: c.time,
      });
    } else if (state === 0) {
      bearRaw.push({
        top: c.high,
        btm: hl2,
        avg: (c.high + hl2) / 2,
        leftIndex: pivotIndex,
        pivotIndex,
        time: c.time,
      });
    }
  }

  bullRaw.reverse();
  bearRaw.reverse();

  function filterMitigated(list, bull) {
    const kept = [];
    for (const ob of list) {
      let mitigated = false;
      let tests = 0;
      const from = ob.pivotIndex + length + 1;
      for (let i = from; i < len; i++) {
        const target =
          mitigation === 'Close'
            ? bull
              ? lowestClose(i, length)
              : highestClose(i, length)
            : bull
              ? lowestLow(i, length)
              : highestHigh(i, length);
        const c = candles[i];
        if (c.low <= ob.top && c.high >= ob.btm) tests++;
        if (bull ? target < ob.btm : target > ob.top) {
          mitigated = true;
          break;
        }
      }
      if (!mitigated) kept.push({ ...ob, tests });
    }
    return kept;
  }

  const bullActive = filterMitigated(bullRaw, true).slice(0, bullExtLast);
  const bearActive = filterMitigated(bearRaw, false).slice(0, bearExtLast);
  const ranges = candles.slice(-30).map((c) => c.high - c.low);
  const avgRange = avg(ranges) || 0.001;
  const out = [];

  for (const ob of bullActive) {
    const height = Math.abs(ob.top - ob.btm) || avgRange;
    const status = ob.tests >= 3 ? 'TESTED MULTIPLE' : ob.tests >= 1 ? 'TESTED ONCE' : 'FRESH';
    out.push({
      type: 'bullish',
      high: ob.top,
      low: ob.btm,
      mid: ob.avg,
      avg: ob.avg,
      index: ob.leftIndex,
      time: ob.time,
      status,
      tests: ob.tests || 0,
      displacement: height,
      volumeExp: true,
      strength: Math.min(
        100,
        40 +
          (status === 'FRESH' ? 25 : status === 'TESTED ONCE' ? 12 : 5) +
          Math.min(20, (height / avgRange) * 8)
      ),
      source: 'luxalgo',
      mitigation,
    });
  }

  for (const ob of bearActive) {
    const height = Math.abs(ob.top - ob.btm) || avgRange;
    const status = ob.tests >= 3 ? 'TESTED MULTIPLE' : ob.tests >= 1 ? 'TESTED ONCE' : 'FRESH';
    out.push({
      type: 'bearish',
      high: ob.top,
      low: ob.btm,
      mid: ob.avg,
      avg: ob.avg,
      index: ob.leftIndex,
      time: ob.time,
      status,
      tests: ob.tests || 0,
      displacement: height,
      volumeExp: true,
      strength: Math.min(
        100,
        40 +
          (status === 'FRESH' ? 25 : status === 'TESTED ONCE' ? 12 : 5) +
          Math.min(20, (height / avgRange) * 8)
      ),
      source: 'luxalgo',
      mitigation,
    });
  }

  out.sort((a, b) => (a.index || 0) - (b.index || 0));
  return out;
}

/**
 * Combined: legacy OBs (strategy primary) + LuxAlgo as "other" OBs.
 * Strategy/scoring still prefers non-INVALIDATED; luxalgo tagged for chart.
 */
export function detectOrderBlocks(candles, lookback = 80, opts = {}) {
  const legacy = detectLegacyOrderBlocks(candles, lookback);
  const lux = detectLuxAlgoOrderBlocks(candles, Math.max(lookback, 120), opts);
  return [...legacy, ...lux];
}
