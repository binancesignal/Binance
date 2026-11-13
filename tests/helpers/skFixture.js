// Deterministic multi-timeframe fixtures: ONE 5m master path → every other timeframe is its aggregation,
// so all timeframes are always consistent with each other (like real exchange data).
export const T0 = Date.UTC(2026, 0, 1) / 1000;
const TF = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800 };

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** waypoints: [{ bars, to, vol? }] → 5m candles (linear legs, small deterministic wicks) */
export function buildMaster(waypoints, start = 100, t0 = T0, seed = 7) {
  const rnd = rng(seed);
  const out = [];
  let prev = start;
  let t = t0;
  for (const w of waypoints) {
    for (let k = 1; k <= w.bars; k++) {
      const close = prev + ((w.to - prev) * 1) / (w.bars - k + 1);
      const wick = Math.abs(close) * 0.0004 * (0.5 + rnd());
      out.push({
        time: t,
        open: prev,
        close,
        high: Math.max(prev, close) + wick,
        low: Math.min(prev, close) - wick,
        volume: (100 + rnd() * 20) * (w.vol || 1),
      });
      prev = close;
      t += 300;
    }
  }
  return out;
}

export function aggregate(c5, tf) {
  const sec = TF[tf];
  if (tf === '5m') return c5.map((c) => ({ ...c }));
  const out = [];
  let cur = null;
  let n = 0;
  const per = sec / 300;
  for (const c of c5) {
    const bucket = Math.floor(c.time / sec) * sec;
    if (!cur || cur.time !== bucket) {
      if (cur && n === per) out.push(cur);
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      n = 1;
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      n++;
    }
  }
  if (cur && n === per) out.push(cur);
  return out;
}

/** mirror = true → the same market flipped around K (a SHORT scenario with positive prices) */
export const MIRROR_K = 600;
export function mirrorMaster(c5, K = MIRROR_K) {
  return c5.map((c) => ({ ...c, open: K - c.open, close: K - c.close, high: K - c.low, low: K - c.high }));
}
export function makeGetCandles(c5, { mirror = false } = {}) {
  const src = mirror ? mirrorMaster(c5) : c5;
  const cache = {};
  return async (tf, limit) => {
    cache[tf] ||= aggregate(src, tf);
    return cache[tf].slice(-limit);
  };
}

/** legs helper: zigzag of [price, bars] pairs */
const L = (to, bars, vol) => ({ to, bars, vol });

/**
 * LONG scenario (all prices in "LONG space"; SHORT tests mirror them).
 * base zigzag → 4H down-trend (LH/LL) → A=230 → CHoCH rally to B=300 → pull-back to C≈256.7 (0.618) with a 1H down-trend
 * → 1H CHoCH rally to B1=290 → pull-back into the 1H fib zone via 30M/15M/5M down-trend → LTF CHoCH.
 */
export function longWaypoints({ upToStage = 'entry' } = {}) {
  const w = [];
  for (let k = 0; k < 12; k++) {
    w.push(L(200 + k * 4 + 10, 240), L(200 + k * 4 + 4, 240));
  }
  // 4H down-trend: H1=262 L1=244 H2=254 A=230
  w.push(L(262, 480), L(244, 480), L(254, 480), L(230, 480));
  if (upToStage === 'trend') return w;
  // CHoCH rally to B
  w.push(L(300, 960));
  if (upToStage === 'swing') {
    w.push(L(296, 150), L(299, 40), L(295, 150)); // not yet any real pull-back
    return w;
  }
  // BC pull-back to C (≈0.618) as a 1H down-trend
  w.push(L(288, 96), L(294, 96), L(275, 96), L(280, 96), L(256.74, 144));
  if (upToStage === 'czone') return w;
  // 1H CHoCH rally
  w.push(L(290, 192));
  if (upToStage === '1h') return w;
  // pull-back into the 1H fib zone (lower-TF down-trend) then CHoCH
  w.push(L(280, 36), L(285, 36), L(270, 36), L(276, 36), L(266, 48));
  if (upToStage === 'pullback') return w;
  w.push(L(284, 60, 3), L(282, 12));
  return w;
}
