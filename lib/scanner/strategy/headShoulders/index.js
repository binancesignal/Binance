/**
 * Head & Shoulders / Inverse Head & Shoulders scanner.
 *
 * Classic H&S (bearish): Left Shoulder → Head (higher) → Right Shoulder ≈ LS, with a neckline
 * through the two troughs between the peaks. Break of neckline confirms.
 *
 * Inverse H&S (bullish): mirrored with troughs.
 *
 * Optional filter: pattern formed entirely above EMA200 (classic) or below EMA200 (inverse).
 * Chart SVG draws LS / Head / RS, neckline, and EMA200.
 *
 * Designed so more classic patterns (Double Top, etc.) can be added later under the same card.
 */
import { findSwings, calcATR, calcEMASeries } from '../../indicators.js';

export const HS_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

export const HS_DEFAULTS = {
  swingLeft: 3,
  swingRight: 3,
  // How equal shoulders must be (fraction of head→shoulder drop/rise)
  shoulderTolerance: 0.35,
  // Min pattern height in ATR
  minHeightAtr: 0.9,
  // Min bars between LS and RS
  minWidthBars: 8,
  // Max bars between LS and RS
  maxWidthBars: 180,
  // Lookback swings to consider
  swingLookback: 24,
  // EMA period for the "above EMA200" filter
  emaPeriod: 200,
  // requireAboveEma: only classic H&S whose structure sits above EMA200
  // requireBelowEma: only inverse H&S whose structure sits below EMA200
  requireAboveEma: false,
  requireBelowEma: false,
  // Include inverse H&S
  includeInverse: true,
  includeClassic: true,
  // How far past RS we still accept the pattern (bars)
  maxAgeBars: 80,
};

export function normalizeHsConfig(raw = {}) {
  const d = HS_DEFAULTS;
  const num = (v, fb, lo, hi) => {
    const n = Math.round(+v);
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  };
  const fnum = (v, fb, lo, hi) => {
    const n = +v;
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    swingLeft: num(raw.swingLeft, d.swingLeft, 2, 8),
    swingRight: num(raw.swingRight, d.swingRight, 2, 8),
    shoulderTolerance: fnum(raw.shoulderTolerance, d.shoulderTolerance, 0.1, 0.8),
    minHeightAtr: fnum(raw.minHeightAtr, d.minHeightAtr, 0.3, 5),
    minWidthBars: num(raw.minWidthBars, d.minWidthBars, 4, 60),
    maxWidthBars: num(raw.maxWidthBars, d.maxWidthBars, 20, 400),
    swingLookback: num(raw.swingLookback, d.swingLookback, 8, 60),
    emaPeriod: num(raw.emaPeriod, d.emaPeriod, 50, 300),
    requireAboveEma: raw.requireAboveEma === true || raw.requireAboveEma === 'true',
    requireBelowEma: raw.requireBelowEma === true || raw.requireBelowEma === 'true',
    includeInverse: raw.includeInverse !== false && raw.includeInverse !== 'false',
    includeClassic: raw.includeClassic !== false && raw.includeClassic !== 'false',
    maxAgeBars: num(raw.maxAgeBars, d.maxAgeBars, 10, 300),
  };
}

function nearEqual(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

/** Neckline through two points (sloping allowed). */
function necklineThrough(a, b) {
  if (!a || !b || a.i === b.i) return null;
  const slope = (b.price - a.price) / (b.i - a.i);
  const intercept = a.price - slope * a.i;
  return {
    a: intercept,
    b: slope,
    p1: { i: a.i, price: a.price, time: a.time },
    p2: { i: b.i, price: b.price, time: b.time },
    at: (i) => intercept + slope * i,
  };
}

function statusOf(candles, pattern, neck) {
  const last = candles.length - 1;
  const lastC = candles[last];
  const neckNow = neck.at(last);
  const broken =
    pattern.direction === 'SHORT'
      ? lastC.close < neckNow
      : lastC.close > neckNow;
  // In zone: price near neckline after RS
  const atr = calcATR(candles, 14) || lastC.close * 0.01;
  const near = Math.abs(lastC.close - neckNow) <= atr * 0.6;
  if (broken) return 'BREAKOUT';
  if (near) return 'AT_NECK';
  return 'FORMED';
}

/**
 * Detect classic Head & Shoulders (SHORT) and Inverse (LONG).
 */
export function findHeadShoulders(candles, cfgIn = {}) {
  const cfg = normalizeHsConfig(cfgIn);
  if (!candles || candles.length < cfg.emaPeriod + 30) return [];

  const closed = candles; // use full series; last bar is live context
  const swings = findSwings(closed, cfg.swingLeft, cfg.swingRight);
  if (swings.length < 5) return [];

  const atr = calcATR(closed, 14) || 0;
  const lastClose = closed[closed.length - 1].close;
  const tol = atr > 0 ? atr * 0.4 : lastClose * 0.004;
  const ema = calcEMASeries(closed, cfg.emaPeriod);
  const recent = swings.slice(-cfg.swingLookback);
  const highs = recent.filter((s) => s.type === 'H');
  const lows = recent.filter((s) => s.type === 'L');
  const events = [];
  const lastIdx = closed.length - 1;

  // ── Classic H&S (bearish) ──────────────────────────────────────────
  if (cfg.includeClassic && highs.length >= 3) {
    for (let i = 0; i <= highs.length - 3; i++) {
      const ls = highs[i];
      const head = highs[i + 1];
      const rs = highs[i + 2];
      const width = rs.i - ls.i;
      if (width < cfg.minWidthBars || width > cfg.maxWidthBars) continue;
      if (lastIdx - rs.i > cfg.maxAgeBars) continue;

      // Head must be clearly higher than both shoulders
      if (!(head.price > ls.price + tol && head.price > rs.price + tol)) continue;

      // Shoulders roughly equal
      const dropL = head.price - ls.price;
      const dropR = head.price - rs.price;
      const shoulderTol = Math.max(tol, Math.min(dropL, dropR) * cfg.shoulderTolerance);
      if (!nearEqual(ls.price, rs.price, shoulderTol * 1.6)) continue;
      // Prefer RS not higher than LS by much (weak right shoulder is ok but not inverted)
      if (rs.price > ls.price + shoulderTol * 1.2) continue;

      // Two troughs between LS-Head and Head-RS for neckline
      const troughsL = lows.filter((l) => l.i > ls.i && l.i < head.i);
      const troughsR = lows.filter((l) => l.i > head.i && l.i < rs.i);
      if (!troughsL.length || !troughsR.length) continue;
      const n1 = troughsL.reduce((a, b) => (a.price <= b.price ? a : b));
      const n2 = troughsR.reduce((a, b) => (a.price <= b.price ? a : b));
      const neck = necklineThrough(n1, n2);
      if (!neck) continue;

      const neckAtHead = neck.at(head.i);
      const height = head.price - neckAtHead;
      if (atr > 0 && height < atr * cfg.minHeightAtr) continue;
      if (height <= 0) continue;

      // EMA200 filter: entire structure (lowest neck point) above EMA
      if (cfg.requireAboveEma) {
        const e1 = ema[n1.i];
        const e2 = ema[n2.i];
        const eh = ema[head.i];
        if (e1 == null || e2 == null || eh == null) continue;
        if (n1.price < e1 || n2.price < e2 || head.price < eh) continue;
      }

      const status = statusOf(closed, { direction: 'SHORT' }, neck);
      const conf =
        55 +
        Math.min(25, (height / (atr || height)) * 8) +
        (nearEqual(ls.price, rs.price, shoulderTol) ? 10 : 0) +
        (status === 'BREAKOUT' ? 5 : 0);

      events.push({
        patternType: 'HEAD_AND_SHOULDERS',
        direction: 'SHORT',
        status,
        time: closed[rs.i].time,
        index: rs.i,
        ls: { i: ls.i, price: ls.price, time: closed[ls.i].time },
        head: { i: head.i, price: head.price, time: closed[head.i].time },
        rs: { i: rs.i, price: rs.price, time: closed[rs.i].time },
        neck1: { i: n1.i, price: n1.price, time: closed[n1.i].time },
        neck2: { i: n2.i, price: n2.price, time: closed[n2.i].time },
        neckline: { a: neck.a, b: neck.b, atRs: neck.at(rs.i), atLast: neck.at(lastIdx) },
        height,
        target: neck.at(rs.i) - height, // measured move
        confidence: Math.min(95, Math.round(conf)),
        ema200AtRs: ema[rs.i],
        aboveEma: ema[n1.i] != null && n1.price > ema[n1.i] && n2.price > ema[n2.i],
        price: closed[lastIdx].close,
      });
    }
  }

  // ── Inverse H&S (bullish) ──────────────────────────────────────────
  if (cfg.includeInverse && lows.length >= 3) {
    for (let i = 0; i <= lows.length - 3; i++) {
      const ls = lows[i];
      const head = lows[i + 1];
      const rs = lows[i + 2];
      const width = rs.i - ls.i;
      if (width < cfg.minWidthBars || width > cfg.maxWidthBars) continue;
      if (lastIdx - rs.i > cfg.maxAgeBars) continue;

      if (!(head.price < ls.price - tol && head.price < rs.price - tol)) continue;

      const riseL = ls.price - head.price;
      const riseR = rs.price - head.price;
      const shoulderTol = Math.max(tol, Math.min(riseL, riseR) * cfg.shoulderTolerance);
      if (!nearEqual(ls.price, rs.price, shoulderTol * 1.6)) continue;
      if (rs.price < ls.price - shoulderTol * 1.2) continue;

      const peaksL = highs.filter((h) => h.i > ls.i && h.i < head.i);
      const peaksR = highs.filter((h) => h.i > head.i && h.i < rs.i);
      if (!peaksL.length || !peaksR.length) continue;
      const n1 = peaksL.reduce((a, b) => (a.price >= b.price ? a : b));
      const n2 = peaksR.reduce((a, b) => (a.price >= b.price ? a : b));
      const neck = necklineThrough(n1, n2);
      if (!neck) continue;

      const neckAtHead = neck.at(head.i);
      const height = neckAtHead - head.price;
      if (atr > 0 && height < atr * cfg.minHeightAtr) continue;
      if (height <= 0) continue;

      if (cfg.requireBelowEma) {
        const e1 = ema[n1.i];
        const e2 = ema[n2.i];
        const eh = ema[head.i];
        if (e1 == null || e2 == null || eh == null) continue;
        if (n1.price > e1 || n2.price > e2 || head.price > eh) continue;
      }
      // "above EMA200" filter for inverse: structure still above EMA (bullish continuation zone)
      if (cfg.requireAboveEma) {
        const eh = ema[head.i];
        if (eh == null || head.price < eh) continue;
      }

      const status = statusOf(closed, { direction: 'LONG' }, neck);
      const conf =
        55 +
        Math.min(25, (height / (atr || height)) * 8) +
        (nearEqual(ls.price, rs.price, shoulderTol) ? 10 : 0) +
        (status === 'BREAKOUT' ? 5 : 0);

      events.push({
        patternType: 'INVERSE_HEAD_AND_SHOULDERS',
        direction: 'LONG',
        status,
        time: closed[rs.i].time,
        index: rs.i,
        ls: { i: ls.i, price: ls.price, time: closed[ls.i].time },
        head: { i: head.i, price: head.price, time: closed[head.i].time },
        rs: { i: rs.i, price: rs.price, time: closed[rs.i].time },
        neck1: { i: n1.i, price: n1.price, time: closed[n1.i].time },
        neck2: { i: n2.i, price: n2.price, time: closed[n2.i].time },
        neckline: { a: neck.a, b: neck.b, atRs: neck.at(rs.i), atLast: neck.at(lastIdx) },
        height,
        target: neck.at(rs.i) + height,
        confidence: Math.min(95, Math.round(conf)),
        ema200AtRs: ema[rs.i],
        aboveEma: ema[head.i] != null && head.price > ema[head.i],
        price: closed[lastIdx].close,
      });
    }
  }

  // Deduplicate: keep best confidence per direction overlapping windows
  events.sort((a, b) => b.confidence - a.confidence || b.time - a.time);
  const kept = [];
  for (const e of events) {
    const overlap = kept.some(
      (k) =>
        k.direction === e.direction &&
        Math.abs(k.index - e.index) < Math.max(5, (e.rs.i - e.ls.i) * 0.4)
    );
    if (!overlap) kept.push(e);
  }
  return kept.sort((a, b) => b.time - a.time);
}

export function backtestHeadShoulders(candles, cfgIn = {}) {
  const cfg = normalizeHsConfig(cfgIn);
  return { events: findHeadShoulders(candles, cfg), cfg };
}

// ───────────────────────────── chart SVG ─────────────────────────────

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
  if (p == null || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6;
  return p.toFixed(dp);
}

/**
 * Candle chart with EMA200, H&S anchors (LS/Head/RS), neckline, target.
 */
export function buildHsChartSvg(candles, ev, opts = {}) {
  const { symbol = '', tf = '', before = 40, after = 30, tzMin = 0, width = 900, height = 520, emaPeriod = 200 } = opts;
  const from = Math.max(0, ev.ls.i - before);
  const to = Math.min(candles.length - 1, Math.max(ev.rs.i, ev.index) + after);
  const vis = candles.slice(from, to + 1);
  if (vis.length < 10) return null;

  const ema = calcEMASeries(candles, emaPeriod);

  const L = 10;
  const R = 78;
  const T = 48;
  const B = 36;
  const pw = width - L - R;
  const ph = height - T - B;
  const step = pw / vis.length;
  const bw = Math.max(1, Math.min(10, step * 0.65));

  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < vis.length; k++) {
    lo = Math.min(lo, vis[k].low);
    hi = Math.max(hi, vis[k].high);
    const e = ema[from + k];
    if (e != null) {
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
    }
  }
  if (ev.target != null) {
    lo = Math.min(lo, ev.target);
    hi = Math.max(hi, ev.target);
  }
  const padP = (hi - lo) * 0.08 || hi * 0.01;
  lo -= padP;
  hi += padP;
  const y = (p) => T + ph - ((p - lo) / (hi - lo)) * ph;
  const x = (k) => L + step * k + step / 2;

  const dirColor = ev.direction === 'LONG' ? '#0ecb81' : '#f6465d';
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

  // candles
  for (let k = 0; k < vis.length; k++) {
    const c = vis[k];
    const col = c.close >= c.open ? '#089981' : '#f23645';
    const cx = x(k).toFixed(1);
    g.push(`<line x1="${cx}" x2="${cx}" y1="${y(c.high).toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}"/>`);
    const top = y(Math.max(c.open, c.close));
    const hgt = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    g.push(`<rect x="${(x(k) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}"/>`);
  }

  // EMA200
  {
    let d = '';
    for (let k = 0; k < vis.length; k++) {
      const v = ema[from + k];
      if (v == null) continue;
      d += (d ? ' L ' : 'M ') + `${x(k).toFixed(1)} ${y(v).toFixed(1)}`;
    }
    if (d) g.push(`<path d="${d}" fill="none" stroke="#2962ff" stroke-width="2"/>`);
  }

  // Neckline extended
  if (ev.neckline) {
    const nFrom = Math.max(from, Math.min(ev.neck1.i, ev.neck2.i) - 2);
    const nTo = Math.min(to, lastExtend(ev, to));
    const y1 = y(ev.neckline.a + ev.neckline.b * nFrom);
    const y2 = y(ev.neckline.a + ev.neckline.b * nTo);
    g.push(
      `<line x1="${x(nFrom - from).toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x(nTo - from).toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${dirColor}" stroke-width="1.8" stroke-dasharray="6 4"/>`
    );
  }

  // Structure polyline LS → neck1 → Head → neck2 → RS
  const pts = [ev.ls, ev.neck1, ev.head, ev.neck2, ev.rs];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.i < from || b.i > to) continue;
    g.push(
      `<line x1="${x(a.i - from).toFixed(1)}" y1="${y(a.price).toFixed(1)}" x2="${x(b.i - from).toFixed(1)}" y2="${y(b.price).toFixed(1)}" stroke="${dirColor}" stroke-width="1.6" opacity="0.85"/>`
    );
  }

  // Point markers
  const markers = [
    { p: ev.ls, label: 'LS' },
    { p: ev.head, label: 'HEAD' },
    { p: ev.rs, label: 'RS' },
    { p: ev.neck1, label: 'N1' },
    { p: ev.neck2, label: 'N2' },
  ];
  for (const m of markers) {
    if (m.p.i < from || m.p.i > to) continue;
    const cx = x(m.p.i - from);
    const cy = y(m.p.price);
    g.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${dirColor}" stroke="#fff" stroke-width="1.4"/>`);
    g.push(`<text x="${cx.toFixed(1)}" y="${(cy - 10).toFixed(1)}" font-size="11" font-weight="700" fill="${dirColor}" text-anchor="middle">${m.label}</text>`);
  }

  // Target line
  if (ev.target != null && Number.isFinite(ev.target)) {
    const ty = y(ev.target);
    g.push(`<line x1="${L}" x2="${L + pw}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="#9c27b0" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.7"/>`);
    g.push(`<text x="${L + 4}" y="${(ty - 4).toFixed(1)}" font-size="10" fill="#9c27b0">Target ${fmtPrice(ev.target)}</text>`);
  }

  const kind = ev.patternType === 'INVERSE_HEAD_AND_SHOULDERS' ? 'Inverse H&S' : 'Head & Shoulders';
  const title = `${symbol} · ${tf} · ${kind} · ${ev.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'} · ${ev.status}`;
  g.push(`<text x="${L}" y="18" font-size="14" font-weight="700" fill="${dirColor}">${title}</text>`);
  g.push(
    `<text x="${L}" y="36" font-size="11" fill="#444">RS ${fmtTime(ev.rs.time, tzMin)} (${tzLabel(tzMin)}) · conf ${ev.confidence} · neck ${fmtPrice(ev.neckline?.atRs)} · ${ev.aboveEma ? 'above EMA200' : 'EMA filter n/a'}</text>`
  );

  const lx = width - R - 160;
  g.push(`<text x="${lx}" y="18" font-size="11" fill="#2962ff">● EMA${emaPeriod}</text>`);
  g.push(`<text x="${lx + 80}" y="18" font-size="11" fill="${dirColor}">● Pattern</text>`);
  g.push('</svg>');
  return g.join('');
}

function lastExtend(ev, to) {
  // extend neckline a bit past RS / last bar
  return Math.min(to, Math.max(ev.rs.i + 15, ev.index + 5));
}
