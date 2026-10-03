/**
 * Technical indicators preserved from original scanner.
 */

export function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function findSwings(candles, left = 3, right = 3) {
  const swings = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i].high <= candles[i - j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh)
      swings.push({
        i,
        type: 'H',
        price: candles[i].high,
        time: candles[i].time,
      });
    if (isLow)
      swings.push({
        i,
        type: 'L',
        price: candles[i].low,
        time: candles[i].time,
      });
  }
  return swings;
}

export function calcEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = avg(candles.slice(0, period).map((c) => c.close));
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

export function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

/** Simple ATR (Average True Range) on given candles */
export function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trs.push(tr);
  }
  if (trs.length < period) return avg(trs);
  return avg(trs.slice(-period));
}

export function relativeVolume(candles) {
  if (candles.length < 20) return 1;
  const recent = candles.slice(-5).map((c) => c.volume);
  const past = candles.slice(-25, -5).map((c) => c.volume);
  return avg(recent) / (avg(past) || 1);
}

export function premiumDiscount(candles) {
  const last50 = candles.slice(-50);
  const hi = Math.max(...last50.map((c) => c.high));
  const lo = Math.min(...last50.map((c) => c.low));
  const mid = (hi + lo) / 2;
  const price = candles[candles.length - 1].close;
  const pos = (price - lo) / (hi - lo || 1);
  return {
    high: hi,
    low: lo,
    eq: mid,
    zone: pos > 0.6 ? 'PREMIUM' : pos < 0.4 ? 'DISCOUNT' : 'EQUILIBRIUM',
    pos,
  };
}

/**
 * RSI series for divergence (last `period` bars of RSI values aligned with closes).
 */
export function calcRSISeries(candles, period = 14) {
  if (!candles || candles.length < period + 5) return [];
  const out = [];
  for (let i = period; i < candles.length; i++) {
    let gains = 0;
    let losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = candles[j].close - candles[j - 1].close;
      if (d >= 0) gains += d;
      else losses -= d;
    }
    const rs = gains / (losses || 0.0001);
    out.push({
      i,
      rsi: 100 - 100 / (1 + rs),
      close: candles[i].close,
      low: candles[i].low,
      high: candles[i].high,
      time: candles[i].time,
    });
  }
  return out;
}

/**
 * Bullish: price lower low + RSI higher low.
 * Bearish: price higher high + RSI lower high.
 * Looks at last ~40 RSI points / swing extremes.
 */
export function detectRsiDivergence(candles, period = 14) {
  const series = calcRSISeries(candles, period);
  if (series.length < 20) {
    return { bullish: false, bearish: false, type: null };
  }
  const window = series.slice(-40);
  // Find two significant swing lows / highs in price within window
  const lows = [];
  const highs = [];
  for (let i = 2; i < window.length - 2; i++) {
    const p = window[i];
    if (
      p.low <= window[i - 1].low &&
      p.low <= window[i - 2].low &&
      p.low <= window[i + 1].low &&
      p.low <= window[i + 2].low
    ) {
      lows.push(p);
    }
    if (
      p.high >= window[i - 1].high &&
      p.high >= window[i - 2].high &&
      p.high >= window[i + 1].high &&
      p.high >= window[i + 2].high
    ) {
      highs.push(p);
    }
  }
  let bullish = false;
  let bearish = false;
  if (lows.length >= 2) {
    const a = lows[lows.length - 2];
    const b = lows[lows.length - 1];
    if (b.low < a.low && b.rsi > a.rsi + 1.5) bullish = true;
  }
  if (highs.length >= 2) {
    const a = highs[highs.length - 2];
    const b = highs[highs.length - 1];
    if (b.high > a.high && b.rsi < a.rsi - 1.5) bearish = true;
  }
  return {
    bullish,
    bearish,
    type: bullish ? 'bullish' : bearish ? 'bearish' : null,
  };
}

/**
 * Fib retracement from last major swing leg on OB TF.
 * LONG: last swing high → swing low; OTE = 0.618–0.786 of the leg (from low upward).
 * SHORT: last swing low → swing high; OTE from high downward.
 */
export function fibConfluence(candles, swings, entry, dir) {
  if (!candles?.length || !swings?.length || entry == null) {
    return { inOte: false, level: null, ratio: null, swingHigh: null, swingLow: null };
  }
  const recent = swings.slice(-12);
  const highs = recent.filter((s) => s.type === 'H');
  const lows = recent.filter((s) => s.type === 'L');
  if (!highs.length || !lows.length) {
    return { inOte: false, level: null, ratio: null, swingHigh: null, swingLow: null };
  }

  let swingHigh;
  let swingLow;
  if (dir === 'LONG') {
    // Prefer most recent major down leg: H then L after it
    swingLow = lows[lows.length - 1];
    swingHigh =
      [...highs].reverse().find((h) => h.i < swingLow.i) || highs[highs.length - 1];
  } else {
    swingHigh = highs[highs.length - 1];
    swingLow =
      [...lows].reverse().find((l) => l.i < swingHigh.i) || lows[lows.length - 1];
  }

  const hi = swingHigh.price;
  const lo = swingLow.price;
  const range = hi - lo;
  if (range <= 0) {
    return { inOte: false, level: null, ratio: null, swingHigh: hi, swingLow: lo };
  }

  // Retracement from impulse extreme toward pullback
  // LONG (buy discount after sell-off): entry near lo + range * (0.618..0.786) measured from high down
  // Classic OTE for bullish: retrace of bearish leg = levels from high: 0.618, 0.705, 0.786
  let ratio;
  if (dir === 'LONG') {
    // how far price recovered from low toward high
    ratio = (entry - lo) / range;
  } else {
    ratio = (hi - entry) / range;
  }

  const inOte = ratio >= 0.55 && ratio <= 0.85; // soft band around 0.618–0.786
  const deepOte = ratio >= 0.618 && ratio <= 0.786;

  return {
    inOte,
    deepOte,
    level: deepOte ? 'OTE' : inOte ? 'Fib zone' : null,
    ratio: +ratio.toFixed(3),
    swingHigh: hi,
    swingLow: lo,
    fib618: dir === 'LONG' ? lo + range * 0.618 : hi - range * 0.618,
    fib786: dir === 'LONG' ? lo + range * 0.786 : hi - range * 0.786,
  };
}

/**
 * Simple chart patterns near current structure:
 * - Double bottom (bullish) / double top (bearish)
 * - HH-HL bullish structure / LH-LL bearish on last swings
 */
export function detectChartPatterns(swings, dir) {
  const out = { doubleBottom: false, doubleTop: false, structure: null, label: null };
  if (!swings?.length || swings.length < 4) return out;
  const recent = swings.slice(-10);
  const lows = recent.filter((s) => s.type === 'L');
  const highs = recent.filter((s) => s.type === 'H');

  if (lows.length >= 2) {
    const a = lows[lows.length - 2].price;
    const b = lows[lows.length - 1].price;
    const tol = Math.abs(a) * 0.004; // 0.4%
    if (Math.abs(a - b) <= tol) {
      out.doubleBottom = true;
      if (dir === 'LONG') out.label = 'Double Bottom';
    }
  }
  if (highs.length >= 2) {
    const a = highs[highs.length - 2].price;
    const b = highs[highs.length - 1].price;
    const tol = Math.abs(a) * 0.004;
    if (Math.abs(a - b) <= tol) {
      out.doubleTop = true;
      if (dir === 'SHORT') out.label = 'Double Top';
    }
  }

  if (lows.length >= 2 && highs.length >= 2) {
    const l1 = lows[lows.length - 2].price;
    const l2 = lows[lows.length - 1].price;
    const h1 = highs[highs.length - 2].price;
    const h2 = highs[highs.length - 1].price;
    if (l2 > l1 && h2 > h1) {
      out.structure = 'HH-HL';
      if (dir === 'LONG' && !out.label) out.label = 'HH-HL';
    } else if (l2 < l1 && h2 < h1) {
      out.structure = 'LH-LL';
      if (dir === 'SHORT' && !out.label) out.label = 'LH-LL';
    }
  }
  return out;
}
