/**
 * EMA 2 Strategy — triple EMA (20/50/200) cross → first subsequent touch of EMA200.
 *
 * 1. Detect an EMA 20 / 50 / 200 "triple cross" (same modes as the classic triple-cross scanner).
 * 2. After the cross bar, scan forward for the FIRST candle whose high–low range touches EMA200
 *    (low ≤ ema200 ≤ high). That touch is the signal; its time is recorded and marked on the chart.
 * 3. Crosses that have not yet produced a touch remain as "pending" setups (still watching).
 *
 * History / backtest only — does not create live signals by itself.
 */
import { calcEMASeries } from '../../indicators.js';
import {
  findTripleCrosses,
  computeEmas,
  normalizeTripleConfig,
  TRIPLE_DEFAULTS,
  TRIPLE_TFS,
  tallyTriple,
} from '../emaTripleCross/index.js';

export { TRIPLE_TFS as EMA2_TFS };
export const EMA2_DEFAULTS = {
  ...TRIPLE_DEFAULTS,
  // How far after the cross we search for the first EMA200 touch (bars)
  maxTouchBars: 120,
  // Require the touch to come from the "expected" side after a directional cross
  // (DOWN cross → price was below EMA200 and rises into it; UP → price was above and falls into it)
  requireApproachSide: true,
  // Minimum bars after the cross before a touch is accepted (avoid same-bar noise)
  minBarsAfterCross: 1,
};

export function normalizeEma2Config(raw = {}) {
  const base = normalizeTripleConfig(raw);
  return {
    ...base,
    maxTouchBars: Math.min(500, Math.max(5, Math.round(+raw.maxTouchBars) || EMA2_DEFAULTS.maxTouchBars)),
    requireApproachSide: raw.requireApproachSide !== false && raw.requireApproachSide !== 'false',
    minBarsAfterCross: Math.min(20, Math.max(0, Math.round(+raw.minBarsAfterCross) || EMA2_DEFAULTS.minBarsAfterCross)),
  };
}

/**
 * Does candle i touch the EMA200 value?
 */
function touchesEma200(candle, e200) {
  if (e200 == null || !Number.isFinite(e200)) return false;
  return candle.low <= e200 && candle.high >= e200;
}

/**
 * Was price clearly on one side of EMA200 just before this bar?
 * side +1 = above, -1 = below.
 */
function sideOfEma(candle, e200) {
  if (e200 == null) return 0;
  if (candle.low > e200) return 1;
  if (candle.high < e200) return -1;
  return 0; // overlapping
}

/**
 * For a given triple-cross event, find the first subsequent EMA200 touch.
 * Returns null if none found within maxTouchBars.
 */
function findFirstTouch(candles, e200, crossEvent, cfg) {
  const start = crossEvent.index + cfg.minBarsAfterCross;
  const end = Math.min(candles.length - 1, crossEvent.index + cfg.maxTouchBars);
  const wantSide = crossEvent.dir === 'DOWN' ? -1 : 1; // after DOWN we expect approach from below

  for (let i = start; i <= end; i++) {
    const e = e200[i];
    if (!touchesEma200(candles[i], e)) continue;

    if (cfg.requireApproachSide) {
      // Look back a few bars for a clear side
      let approachedFromExpected = false;
      for (let b = 1; b <= 8 && i - b >= 0; b++) {
        const s = sideOfEma(candles[i - b], e200[i - b]);
        if (s === wantSide) {
          approachedFromExpected = true;
          break;
        }
        if (s === -wantSide) break; // came from the wrong side
      }
      if (!approachedFromExpected) continue;
    }

    return {
      index: i,
      time: candles[i].time,
      price: candles[i].close,
      high: candles[i].high,
      low: candles[i].low,
      ema200: e,
      barsAfterCross: i - crossEvent.index,
    };
  }
  return null;
}

/**
 * Forward performance measured from the touch bar (or from cross if still pending).
 */
function forwardFrom(candles, i, sign, entry, n) {
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
  let outcome = 'OPEN';
  if (complete && retPct != null) {
    outcome = retPct > 0 ? 'WIN' : retPct < 0 ? 'LOSS' : 'OPEN';
  }
  return {
    barsAvailable: end - i,
    complete,
    retPct: retPct != null ? +retPct.toFixed(3) : null,
    mfePct: +(mfe * 100).toFixed(3),
    maePct: +(mae * 100).toFixed(3),
    outcome,
  };
}

/**
 * Main detector.
 * Returns array of events:
 *   - status: 'TOUCHED' | 'PENDING'
 *   - cross: original triple-cross fields
 *   - touch: { index, time, price, ... } when status === 'TOUCHED'
 */
export function findEma2Events(candles, cfgIn = {}) {
  const cfg = normalizeEma2Config(cfgIn);
  if (!candles || candles.length < cfg.slow + 30) return [];

  const crossEvents = findTripleCrosses(candles, cfg);
  const { e200 } = computeEmas(candles, cfg);
  const out = [];

  for (const cross of crossEvents) {
    const touch = findFirstTouch(candles, e200, cross, cfg);
    const sign = cross.dir === 'UP' ? 1 : -1;

    if (touch) {
      const stats = forwardFrom(candles, touch.index, sign, touch.price, cfg.forwardBars);
      out.push({
        status: 'TOUCHED',
        // primary timestamp for sorting / display = the touch
        time: touch.time,
        index: touch.index,
        dir: cross.dir,
        price: touch.price,
        // cross metadata
        crossIndex: cross.index,
        crossTime: cross.time,
        crossPrice: cross.price,
        pairsCrossed: cross.pairsCrossed,
        crosses: cross.crosses,
        spanBars: cross.spanBars,
        ema20: cross.ema20,
        ema50: cross.ema50,
        ema200AtCross: cross.ema200,
        abcd: cross.abcd || null,
        // touch details
        touch,
        barsAfterCross: touch.barsAfterCross,
        ema200AtTouch: touch.ema200,
        ...stats,
      });
    } else {
      // still waiting for the first EMA200 touch
      out.push({
        status: 'PENDING',
        time: cross.time,
        index: cross.index,
        dir: cross.dir,
        price: cross.price,
        crossIndex: cross.index,
        crossTime: cross.time,
        crossPrice: cross.price,
        pairsCrossed: cross.pairsCrossed,
        crosses: cross.crosses,
        spanBars: cross.spanBars,
        ema20: cross.ema20,
        ema50: cross.ema50,
        ema200AtCross: cross.ema200,
        abcd: cross.abcd || null,
        touch: null,
        barsAfterCross: null,
        ema200AtTouch: null,
        outcome: 'OPEN',
        retPct: null,
        mfePct: null,
        maePct: null,
        barsAvailable: candles.length - 1 - cross.index,
        complete: false,
      });
    }
  }
  return out;
}

export function backtestEma2(candles, cfgIn = {}) {
  const cfg = normalizeEma2Config(cfgIn);
  return { events: findEma2Events(candles, cfg), cfg };
}

export function tallyEma2(list) {
  const touched = list.filter((e) => e.status === 'TOUCHED');
  const pending = list.filter((e) => e.status === 'PENDING');
  const t = tallyTriple(touched);
  t.pending = pending.length;
  t.touched = touched.length;
  t.total = list.length;
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
  if (p == null || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 5 : 6;
  return p.toFixed(dp);
}

/**
 * Chart with EMA20 (red), EMA50 (orange), EMA200 (blue).
 * Marks the triple-cross bar and (if present) the first EMA200 touch bar.
 */
export function buildEma2ChartSvg(candles, ev, emas, opts = {}) {
  const { symbol = '', tf = '', before = 80, after = 50, tzMin = 0, width = 900, height = 520 } = opts;
  const crossIdx = ev.crossIndex ?? ev.index;
  const touchIdx = ev.touch?.index ?? null;
  const focusIdx = touchIdx != null ? touchIdx : crossIdx;
  const from = Math.max(0, Math.min(crossIdx, focusIdx) - before);
  const to = Math.min(candles.length - 1, Math.max(crossIdx, focusIdx || crossIdx) + after);
  const vis = candles.slice(from, to + 1);
  if (vis.length < 10) return null;

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

  const crossColor = ev.dir === 'UP' ? '#0ecb81' : '#f6465d';
  const touchColor = '#2962ff';

  // cross bar highlight
  const ck = crossIdx - from;
  if (ck >= 0 && ck < vis.length) {
    g.push(`<rect x="${(x(ck) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" fill="${crossColor}" opacity="0.12"/>`);
    g.push(`<line x1="${x(ck).toFixed(1)}" x2="${x(ck).toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="${crossColor}" stroke-dasharray="4 3"/>`);
  }

  // touch bar highlight
  if (touchIdx != null) {
    const tk = touchIdx - from;
    if (tk >= 0 && tk < vis.length) {
      g.push(`<rect x="${(x(tk) - step / 2).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" fill="${touchColor}" opacity="0.16"/>`);
      g.push(`<line x1="${x(tk).toFixed(1)}" x2="${x(tk).toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="${touchColor}" stroke-width="1.6"/>`);
    }
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

  // EMA lines
  const line = (series, color, sw) => {
    let d = '';
    for (let k = 0; k < vis.length; k++) {
      const v = series[from + k];
      if (v == null) continue;
      d += (d ? ' L ' : 'M ') + `${x(k).toFixed(1)} ${y(v).toFixed(1)}`;
    }
    if (d) g.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}"/>`);
  };
  line(emas.e200, '#2962ff', 2.2);
  line(emas.e50, '#ff9800', 1.8);
  line(emas.e20, '#f23645', 1.4);

  // markers on cross & touch
  if (ck >= 0 && ck < vis.length) {
    const cy = y(candles[crossIdx].close);
    g.push(`<circle cx="${x(ck).toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${crossColor}" stroke="#fff" stroke-width="1.5"/>`);
    g.push(`<text x="${x(ck).toFixed(1)}" y="${(cy - 10).toFixed(1)}" font-size="11" font-weight="700" fill="${crossColor}" text-anchor="middle">CROSS</text>`);
  }
  if (touchIdx != null) {
    const tk = touchIdx - from;
    if (tk >= 0 && tk < vis.length) {
      const ty = y(ev.touch.ema200);
      g.push(`<circle cx="${x(tk).toFixed(1)}" cy="${ty.toFixed(1)}" r="6" fill="${touchColor}" stroke="#fff" stroke-width="1.5"/>`);
      g.push(`<text x="${x(tk).toFixed(1)}" y="${(ty - 11).toFixed(1)}" font-size="11" font-weight="700" fill="${touchColor}" text-anchor="middle">TOUCH 200</text>`);
    }
  }

  // header
  const statusTag = ev.status === 'TOUCHED' ? 'TOUCHED' : 'PENDING (no touch yet)';
  const title = `${symbol} · ${tf} · EMA 2 Strategy · ${ev.dir === 'UP' ? '▲ UP' : '▼ DOWN'} · ${statusTag}`;
  g.push(`<text x="${L}" y="18" font-size="14" font-weight="700" fill="${crossColor}">${title}</text>`);

  let sub = `Cross: ${fmtTime(ev.crossTime || ev.time, tzMin)} (${tzLabel(tzMin)}) · close ${fmtPrice(ev.crossPrice || ev.price)}`;
  if (ev.touch) {
    sub += `  →  Touch EMA200: ${fmtTime(ev.touch.time, tzMin)} · ${ev.touch.barsAfterCross} bars later · price ${fmtPrice(ev.touch.price)}`;
  } else {
    sub += '  →  still waiting for first EMA200 touch';
  }
  g.push(`<text x="${L}" y="36" font-size="11" fill="#444">${sub}</text>`);

  // legend
  const lx = width - R - 210;
  g.push(`<text x="${lx}" y="18" font-size="11" fill="#f23645">● EMA20</text>`);
  g.push(`<text x="${lx + 62}" y="18" font-size="11" fill="#ff9800">● EMA50</text>`);
  g.push(`<text x="${lx + 124}" y="18" font-size="11" fill="#2962ff">● EMA200</text>`);
  g.push('</svg>');
  return g.join('');
}

export { computeEmas };
