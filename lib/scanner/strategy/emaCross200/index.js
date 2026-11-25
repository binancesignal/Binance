/**
 * EMA 20 / 50 cross  +  EMA 200 touch   (test strategy — not harmonic)
 *
 * Theory (admin's chart idea):
 *   1. wait for the EMA20 and EMA50 to CROSS
 *   2. draw a vertical line through the cross point
 *   3. the candle that sits on that line must have TOUCHED the EMA200 of the SAME time frame
 *      (EMA200 value inside the candle's low–high range)
 *
 * The real crossing point lies BETWEEN two bars (EMA values are per-bar). We interpolate where
 * EMA20 − EMA50 hits zero, and take the candle nearest to that vertical line:
 *   t < 0.5  → the bar before the sign change,  t ≥ 0.5 → the bar after.
 * Only past ("formed") crosses are reported; the newest bar counts only when it is closed.
 */
import { calcEMASeries } from '../../indicators.js';

export const EC_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

export const EC_DEFAULTS = Object.freeze({
  fast: 20,
  slow: 50,
  trend: 200,
  direction: 'BOTH', // BOTH | UP (EMA20 crosses above 50) | DOWN
  touchTolerancePct: 0, // 0 = EMA200 must be inside the candle's range; 0.1 = allow 0.1% miss
  maxAgeBars: 300, // only crosses within the last N bars (past ones included)
  maxPerCoin: 6, // newest N per coin + timeframe
  forwardBars: 20, // look-ahead used for the win/loss test
});

const clamp = (v, lo, hi, fb) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};

export function normalizeEcConfig(raw = {}) {
  const dir = String(raw.direction || 'BOTH').toUpperCase();
  return {
    fast: Math.round(clamp(raw.fast, 2, 100, EC_DEFAULTS.fast)),
    slow: Math.round(clamp(raw.slow, 3, 200, EC_DEFAULTS.slow)),
    trend: Math.round(clamp(raw.trend, 10, 500, EC_DEFAULTS.trend)),
    direction: dir === 'UP' || dir === 'DOWN' ? dir : 'BOTH',
    touchTolerancePct: clamp(raw.touchTolerancePct, 0, 2, EC_DEFAULTS.touchTolerancePct),
    maxAgeBars: Math.round(clamp(raw.maxAgeBars, 5, 900, EC_DEFAULTS.maxAgeBars)),
    maxPerCoin: Math.round(clamp(raw.maxPerCoin, 1, 50, EC_DEFAULTS.maxPerCoin)),
    forwardBars: Math.round(clamp(raw.forwardBars, 3, 200, EC_DEFAULTS.forwardBars)),
  };
}

export function computeEmas(candles, cfg = EC_DEFAULTS) {
  return {
    e20: calcEMASeries(candles, cfg.fast),
    e50: calcEMASeries(candles, cfg.slow),
    e200: calcEMASeries(candles, cfg.trend),
  };
}

function forwardStats(candles, i, sign, entry, n) {
  const last = candles.length - 1;
  const end = Math.min(last, i + n);
  let mfe = 0;
  let mae = 0;
  for (let k = i + 1; k <= end; k++) {
    const fav = sign > 0 ? candles[k].high / entry - 1 : 1 - candles[k].low / entry;
    const adv = sign > 0 ? 1 - candles[k].low / entry : candles[k].high / entry - 1;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  const complete = i + n <= last;
  const retPct = complete ? sign * (candles[i + n].close / entry - 1) * 100 : null;
  return {
    barsAvailable: end - i,
    retPct: retPct == null ? null : +retPct.toFixed(3),
    mfePct: +(mfe * 100).toFixed(3),
    maePct: +(mae * 100).toFixed(3),
    outcome: !complete ? 'OPEN' : retPct > 0 ? 'WIN' : 'LOSS',
  };
}

/**
 * Every EMA20/50 cross whose vertical-line candle touched the EMA200 (oldest → newest).
 * `candles` must be CLOSED candles, oldest first.
 */
export function findCrossTouches(candlesIn, cfgIn = {}, emasIn = null) {
  const cfg = normalizeEcConfig(cfgIn);
  const candles = candlesIn || [];
  const n = candles.length;
  if (n < cfg.trend + 5) return [];
  const emas = emasIn || computeEmas(candles, cfg);
  const { e20, e50, e200 } = emas;

  const events = [];
  const startI = Math.max(cfg.trend, n - cfg.maxAgeBars); // EMA200 must exist on the touched candle
  for (let i = Math.max(startI, 1); i < n; i++) {
    const a0 = e20[i - 1];
    const b0 = e50[i - 1];
    const a1 = e20[i];
    const b1 = e50[i];
    if (a0 == null || b0 == null || a1 == null || b1 == null) continue;
    const d0 = a0 - b0;
    const d1 = a1 - b1;
    const up = d0 <= 0 && d1 > 0;
    const down = d0 >= 0 && d1 < 0;
    if (!up && !down) continue;
    const dir = up ? 'UP' : 'DOWN';
    if (cfg.direction !== 'BOTH' && cfg.direction !== dir) continue;

    // where between bar i-1 and bar i the two EMAs are equal
    const denom = d0 - d1;
    const t = denom === 0 ? 1 : Math.min(1, Math.max(0, d0 / denom));
    const lineIdx = t < 0.5 ? i - 1 : i;
    const c = candles[lineIdx];
    const e = e200[lineIdx];
    if (!c || e == null) continue;

    const tol = (e * cfg.touchTolerancePct) / 100;
    const touched = c.low - tol <= e && e <= c.high + tol;
    if (!touched) continue;

    const bodyHi = Math.max(c.open, c.close);
    const bodyLo = Math.min(c.open, c.close);
    const touchKind = e >= bodyLo && e <= bodyHi ? 'BODY' : e > bodyHi ? 'WICK_HIGH' : 'WICK_LOW';
    const crossLevel = a0 + (a1 - a0) * t; // EMA20 value at the interpolated cross point
    const e200AtCross = e200[i - 1] != null && e200[i] != null ? e200[i - 1] + (e200[i] - e200[i - 1]) * t : e;

    // entry for the look-ahead test = close of the bar where the cross is confirmed
    const entry = candles[i].close;
    const sign = dir === 'UP' ? 1 : -1;
    const last = candles[n - 1];
    events.push({
      dir,
      index: lineIdx, // candle on the vertical line
      crossIndex: i, // bar where EMA20 is first on the other side of EMA50
      time: c.time,
      confirmTime: candles[i].time,
      t: +t.toFixed(3),
      barsAgo: n - 1 - lineIdx,
      candle: { open: c.open, high: c.high, low: c.low, close: c.close },
      touchKind,
      ema20: +a1,
      ema50: +b1,
      ema200: +e,
      crossLevel: +crossLevel,
      crossVsEma200Pct: +(((crossLevel - e200AtCross) / e200AtCross) * 100).toFixed(3),
      // where EMA20/50 sit versus EMA200 at the cross: both above / both below / on the 200
      zone: crossLevel > e200AtCross * 1.0005 ? 'ABOVE_200' : crossLevel < e200AtCross * 0.9995 ? 'BELOW_200' : 'ON_200',
      closeVsEma200: c.close >= e ? 'ABOVE' : 'BELOW',
      price: last.close,
      entry,
      movedPct: +(sign * (last.close / entry - 1) * 100).toFixed(3), // since the cross, in the cross direction
      ...forwardStats(candles, i, sign, entry, cfg.forwardBars),
    });
  }
  // newest N only
  return events.slice(-cfg.maxPerCoin);
}

/**
 * How far a chunked scan may advance. Normal chunk → all coins. If the rate guard / a ban stopped the
 * chunk, only the LEADING coins that were fully handled count, so the stopped coin is retried later.
 */
export function advanceOffset(doneFlags, stopped) {
  if (!stopped) return doneFlags.length;
  let n = 0;
  while (n < doneFlags.length && doneFlags[n]) n += 1;
  return n;
}

export function scanEmaCross200(candles, cfgIn = {}) {
  const cfg = normalizeEcConfig(cfgIn);
  return { events: findCrossTouches(candles, cfg), cfg };
}

export function tallyEc(list) {
  const t = { total: list.length, win: 0, loss: 0, open: 0, winRate: null, avgRetPct: null };
  let rs = 0;
  let rn = 0;
  for (const e of list) {
    if (e.outcome === 'WIN') t.win++;
    else if (e.outcome === 'LOSS') t.loss++;
    else t.open++;
    if (e.retPct != null) {
      rs += e.retPct;
      rn++;
    }
  }
  const done = t.win + t.loss;
  if (done) t.winRate = +((t.win / done) * 100).toFixed(1);
  if (rn) t.avgRetPct = +(rs / rn).toFixed(3);
  return t;
}

// ───────────────────────────── chart (SVG) ─────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(t, tzMin) {
  const d = new Date((t + tzMin * 60) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
function tzLabel(tzMin) {
  if (!tzMin) return 'UTC';
  const s = tzMin < 0 ? '-' : '+';
  const a = Math.abs(tzMin);
  return `UTC${s}${Math.floor(a / 60)}${a % 60 ? ':' + pad2(a % 60) : ''}`;
}
function fmtPrice(p) {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 5 : 6;
  return p.toFixed(dp);
}

/** Candle chart + EMA20 (red) / EMA50 (orange) / EMA200 (blue); vertical dotted line at the cross point. */
export function buildEcChartSvg(candles, ev, emas, opts = {}) {
  const { symbol = '', tf = '', before = 90, after = 40, tzMin = 0, width = 900, height = 520 } = opts;
  const evIdx = ev.index;
  const from = Math.max(0, evIdx - before);
  const to = Math.min(candles.length - 1, evIdx + after);
  const vis = candles.slice(from, to + 1);
  if (vis.length < 10) return null;

  const L = 10;
  const R = 78;
  const T = 44;
  const B = 34;
  const pw = width - L - R;
  const ph = height - T - B;
  const step = pw / vis.length;
  const bw = Math.max(1, Math.min(10, step * 0.65));

  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < vis.length; k++) {
    lo = Math.min(lo, vis[k].low);
    hi = Math.max(hi, vis[k].high);
    for (const s of [emas.e20, emas.e50, emas.e200]) {
      const v = s[from + k];
      if (v != null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  const padP = (hi - lo) * 0.06 || hi * 0.01;
  lo -= padP;
  hi += padP;
  const y = (p) => T + ph - ((p - lo) / (hi - lo)) * ph;
  const x = (k) => L + step * k + step / 2;
  const evColor = ev.dir === 'UP' ? '#0ecb81' : '#f6465d';

  const g = [];
  g.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial,Helvetica,sans-serif">`);
  g.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

  for (let n = 0; n <= 6; n++) {
    const p = lo + ((hi - lo) * n) / 6;
    const yy = y(p).toFixed(1);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${yy}" y2="${yy}" stroke="#eceff3"/>`);
    g.push(`<text x="${L + pw + 6}" y="${(+yy + 4).toFixed(1)}" font-size="11" fill="#555">${fmtPrice(p)}</text>`);
  }
  const labelEvery = Math.max(1, Math.round(vis.length / 6));
  for (let k = 0; k < vis.length; k += labelEvery) {
    g.push(`<text x="${x(k).toFixed(1)}" y="${height - 12}" font-size="10" fill="#666" text-anchor="middle">${fmtTime(vis[k].time, tzMin).slice(5)}</text>`);
  }

  // vertical line through the interpolated cross point (between bar i-1 and bar i)
  const ek = evIdx - from;
  const crossK = ev.crossIndex - 1 - from + ev.t; // fractional bar position of the real cross
  g.push(`<rect x="${(x(ek) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" fill="${evColor}" opacity="0.14"/>`);
  g.push(`<line x1="${x(crossK).toFixed(1)}" x2="${x(crossK).toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="#333" stroke-dasharray="4 3"/>`);

  for (let k = 0; k < vis.length; k++) {
    const c = vis[k];
    const col = c.close >= c.open ? '#089981' : '#f23645';
    const cx = x(k).toFixed(1);
    g.push(`<line x1="${cx}" x2="${cx}" y1="${y(c.high).toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}"/>`);
    const top = y(Math.max(c.open, c.close));
    const hgt = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    g.push(`<rect x="${(x(k) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"/>`);
  }

  const line = (series, color, w) => {
    const pts = [];
    for (let k = 0; k < vis.length; k++) {
      const v = series[from + k];
      if (v != null) pts.push(`${x(k).toFixed(1)},${y(v).toFixed(1)}`);
    }
    if (pts.length > 1) g.push(`<polyline fill="none" stroke="${color}" stroke-width="${w}" points="${pts.join(' ')}"/>`);
  };
  line(emas.e200, '#2962ff', 2);
  line(emas.e50, '#ff9800', 2);
  line(emas.e20, '#f23645', 1.4);

  // touch marker: circle on the EMA200 at the candle on the line
  g.push(`<circle cx="${x(ek).toFixed(1)}" cy="${y(ev.ema200).toFixed(1)}" r="6" fill="none" stroke="#2962ff" stroke-width="2"/>`);

  const title = `${symbol} · ${tf} · EMA20/50 cross ${ev.dir === 'UP' ? '▲ UP' : '▼ DOWN'} + EMA200 touch`;
  g.push(`<text x="${L}" y="18" font-size="14" font-weight="700" fill="${evColor}">${title}</text>`);
  g.push(`<text x="${L}" y="35" font-size="11" fill="#444">${fmtTime(ev.time, tzMin)} (${tzLabel(tzMin)}) · candle ${fmtPrice(ev.candle.low)}–${fmtPrice(ev.candle.high)} · EMA200 ${fmtPrice(ev.ema200)} (${ev.touchKind.replace('_', ' ').toLowerCase()})</text>`);
  const lx = width - R - 190;
  g.push(`<text x="${lx}" y="18" font-size="11" fill="#f23645">● EMA20</text>`);
  g.push(`<text x="${lx + 62}" y="18" font-size="11" fill="#ff9800">● EMA50</text>`);
  g.push(`<text x="${lx + 124}" y="18" font-size="11" fill="#2962ff">● EMA200</text>`);
  g.push('</svg>');
  return g.join('');
}
