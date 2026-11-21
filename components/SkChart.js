'use client';

/**
 * SK SYSTEM PRO chart — real exchange candles on a canvas (zoom · pan · pinch · crosshair · volume · live price),
 * with the setup's calculated annotations drawn on top. Annotations are DATA (never baked into the candles):
 * every item has a group (toggle) and the time frame that produced it (shown in its label).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TFS = [['1w', '1W'], ['1d', '1D'], ['4h', '4H'], ['2h', '2H'], ['1h', '1H'], ['30m', '30M'], ['15m', '15M'], ['5m', '5M'], ['3m', '3M']];
const TF_SEC = { '1w': 604800, '1d': 86400, '4h': 14400, '2h': 7200, '1h': 3600, '30m': 1800, '15m': 900, '5m': 300, '3m': 180 };

export const GROUPS = [
  ['trend', 'Trend', '#94A3B8'],
  ['swings', 'Swings', '#64748B'],
  ['choch', 'CHoCH', '#F59E0B'],
  ['bos', 'BOS', '#A855F7'],
  ['fib', 'Fibonacci', '#3B82F6'],
  ['abcd', 'ABCD', '#0EA5E9'],
  ['czone', 'C zone', '#F97316'],
  ['ltf', 'LTF structure', '#EAB308'],
  ['entry', 'Entry / SL', '#22C55E'],
  ['targets', 'TP / D target', '#10B981'],
  ['liquidity', 'Liquidity sweeps', '#EC4899'],
  ['obfvg', 'OB / FVG', '#8B5CF6'],
  ['volume', 'Volume', '#14B8A6'],
  // ICT / SMC POI strategy groups (only shown when a POI analysis supplies them)
  ['premium', 'Premium', '#EF4444'],
  ['discount', 'Discount', '#22C55E'],
  ['eq', 'Equilibrium', '#94A3B8'],
  ['ob', 'Order blocks', '#8B5CF6'],
  ['fvg', 'FVG', '#38BDF8'],
  ['poi', 'POI', '#F59E0B'],
  ['mss', 'MSS', '#F97316'],
  ['sweep', 'Sweeps', '#EC4899'],
  ['confirm', 'Confirmation', '#22C55E'],
  ['plan', 'Entry / SL / TP', '#10B981'],
  // FIB BREAKER strategy groups
  ['structure', 'Structure (LL · HL · HH)', '#A855F7'],
  ['breaker', 'Breaker block', '#F59E0B'],
  ['trendline', 'Trend line', '#38BDF8'],
];
const G_COLOR = Object.fromEntries(GROUPS.map(([k, , c]) => [k, c]));
const UP = '#26A69A';
const DOWN = '#EF5350';
const BG = '#0B1220';
const GRID = 'rgba(148,163,184,0.10)';
const TXT = '#94A3B8';

// module-level candle cache (shared by every chart instance → switching timeframes back and forth is free)
const CACHE = new Map();
const CACHE_TTL = 20_000;
const inflight = new Map();

async function loadCandles(symbol, tf, around, force) {
  const key = `${symbol}|${tf}|${around || 0}`;
  const hit = CACHE.get(key);
  if (hit && !force && Date.now() - hit.at < (around ? 10 * 60_000 : CACHE_TTL)) return hit.candles;
  if (inflight.has(key)) return inflight.get(key);
  const p = fetch(`/api/sk-system/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=600${around ? `&around=${around}` : ''}`, { cache: 'no-store' })
    .then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `candles ${r.status}`);
      CACHE.set(key, { candles: d.candles, at: Date.now() });
      return d.candles;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function niceTicks(min, max, count) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(12));
  return out;
}
export const fmtP = (p) => {
  const n = +p;
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 100) return n.toFixed(2);
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.1) return n.toFixed(5);
  return n.toPrecision(4);
};
const fmtT = (sec, tf) => {
  const d = new Date(sec * 1000);
  if (tf === '1w' || tf === '1d') return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' });
  return d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};

export default function SkChart({ symbol, annotations = [], dir, historicalAt = null, defaultTf = '4h', focus = [], height = 440, onTfChange, fitFromTime = null }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [tf, setTf] = useState(defaultTf);
  const [candles, setCandles] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ w: 600, h: height });
  const [off, setOff] = useState({ barW: 8, right: 0 }); // barW px per candle · right = float index at the right edge
  const [hover, setHover] = useState(null);
  const [hidden, setHidden] = useState({ swings: true, bos: false, volume: false });
  const [onlyTf, setOnlyTf] = useState(false);
  const ptr = useRef(new Map());
  const drag = useRef(null);
  const live = historicalAt == null;

  // ── data ──────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    loadCandles(symbol, tf, historicalAt)
      .then((c) => {
        if (!alive) return;
        setCandles(c);
        setOff((o) => {
          // optional: zoom so that the whole pattern (from `fitFromTime` to now) is visible at once
          let barW = o.barW;
          if (fitFromTime && c.length) {
            const first = c.findIndex((x) => x.t >= fitFromTime);
            const bars = c.length - (first < 0 ? 0 : first) + 16;
            const w = (typeof window !== 'undefined' ? Math.min(window.innerWidth - 40, 900) : 600) - 54;
            barW = Math.max(2.2, Math.min(14, w / Math.max(20, bars)));
          }
          return { barW, right: c.length - 1 + 8 };
        });
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e.message);
        setCandles([]);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol, tf, historicalAt]);

  // incremental live update: only the newest candles are requested and merged
  useEffect(() => {
    if (!live || !candles.length) return undefined;
    const id = setInterval(async () => {
      try {
        const since = candles[Math.max(0, candles.length - 2)].t;
        const r = await fetch(`/api/sk-system/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&since=${since}`, { cache: 'no-store' });
        const d = await r.json();
        if (!r.ok || !d.candles?.length) return;
        setCandles((prev) => {
          const map = new Map(prev.map((c) => [c.t, c]));
          d.candles.forEach((c) => map.set(c.t, c));
          const next = [...map.values()].sort((a, b) => a.t - b.t);
          CACHE.set(`${symbol}|${tf}|0`, { candles: next, at: Date.now() });
          return next;
        });
      } catch (_) {}
    }, 10_000);
    return () => clearInterval(id);
  }, [live, symbol, tf, candles.length ? candles[candles.length - 1].t : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!wrapRef.current) return undefined;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(280, Math.floor(e.contentRect.width));
      setSize({ w, h: w < 520 ? Math.min(height, 360) : height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [height]);

  const pickTf = (t) => {
    setTf(t);
    onTfChange?.(t);
  };

  // ── geometry ──────────────────────────────────────────────────────────────────────────
  const mobile = size.w < 520;
  const axisW = mobile ? 54 : 70;
  const axisH = 22;
  const plotW = size.w - axisW;
  const plotH = size.h - axisH;
  const volH = Math.round(plotH * 0.14);
  const priceH = plotH - volH - 4;
  const sec = TF_SEC[tf];

  const idxOfTime = useCallback(
    (t) => {
      const n = candles.length;
      if (!n) return 0;
      if (t >= candles[n - 1].t) return n - 1 + (t - candles[n - 1].t) / sec;
      if (t <= candles[0].t) return (t - candles[0].t) / sec;
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (candles[m].t <= t) lo = m;
        else hi = m;
      }
      return lo + (t - candles[lo].t) / Math.max(1, candles[lo + 1].t - candles[lo].t);
    },
    [candles, sec]
  );

  const view = useMemo(() => {
    const n = candles.length;
    const first = Math.max(0, Math.floor(off.right - plotW / off.barW) - 1);
    const last = Math.min(n - 1, Math.ceil(off.right) + 1);
    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 0;
    for (let i = first; i <= last; i++) {
      const c = candles[i];
      if (!c) continue;
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
      vmax = Math.max(vmax, c.v);
    }
    if (!Number.isFinite(lo)) return { first, last, lo: 0, hi: 1, vmax: 1 };
    // keep the trade levels in view when they are close to the candles
    for (const f of focus) if (Number.isFinite(+f) && +f > lo - (hi - lo) * 1.2 && +f < hi + (hi - lo) * 1.2) { lo = Math.min(lo, +f); hi = Math.max(hi, +f); }
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    return { first, last, lo: lo - pad, hi: hi + pad, vmax: vmax || 1 };
  }, [candles, off, plotW, focus]);

  const xOf = (i) => plotW - (off.right - i) * off.barW;
  const yOf = (p) => ((view.hi - p) / (view.hi - view.lo)) * priceH;
  const pOfY = (y) => view.hi - (y / priceH) * (view.hi - view.lo);

  // ── drawing ───────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      draw();
    } catch (e) {
      setErr(`chart draw error: ${e?.message || e}`);
    }
    function draw() {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = size.w * dpr;
    cv.height = size.h * dpr;
    cv.style.width = `${size.w}px`;
    cv.style.height = `${size.h}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, size.w, size.h);
    g.font = `${mobile ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    if (!candles.length) {
      g.fillStyle = TXT;
      g.fillText(loading ? 'Loading candles…' : err || 'No candles', 16, 28);
      return;
    }
    g.save();
    g.beginPath();
    g.rect(0, 0, plotW, plotH);
    g.clip();

    // grid + price axis
    const ticks = niceTicks(view.lo, view.hi, mobile ? 5 : 7);
    g.strokeStyle = GRID;
    g.lineWidth = 1;
    ticks.forEach((p) => {
      const y = Math.round(yOf(p)) + 0.5;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(plotW, y);
      g.stroke();
    });
    // time grid
    const stepBars = Math.max(1, Math.round(110 / off.barW));
    for (let i = Math.ceil(view.first / stepBars) * stepBars; i <= view.last; i += stepBars) {
      const x = Math.round(xOf(i)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, plotH);
      g.stroke();
    }

    // volume
    const vTop = priceH + 4;
    for (let i = view.first; i <= view.last; i++) {
      const c = candles[i];
      if (!c) continue;
      const h = Math.max(1, (c.v / view.vmax) * volH);
      g.fillStyle = c.c >= c.o ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)';
      g.fillRect(xOf(i) - off.barW * 0.4, vTop + volH - h, Math.max(1, off.barW * 0.8), h);
    }

    // annotations (under candles: zones + lines)
    const vis = (a) => !hidden[a.group] && (!onlyTf || a.tf === tf);
    const labels = [];
    const colorOf = (a) => (a.tone === 'sl' ? '#EF4444' : a.tone === 'tp' ? '#10B981' : a.side === 'bear' && (a.group === 'bos') ? '#F472B6' : G_COLOR[a.group] || '#fff');
    const dash = (a) => (a.style === 'dashed' ? [6, 4] : a.style === 'dotted' ? [2, 3] : []);
    for (const a of annotations) {
      if (!vis(a) || a.kind !== 'zone') continue;
      const x1 = xOf(idxOfTime(a.t1));
      const x2 = a.t2 == null ? plotW : xOf(idxOfTime(a.t2));
      const y1 = yOf(a.p1);
      const y2 = yOf(a.p2);
      g.fillStyle = `${colorOf(a)}22`;
      g.strokeStyle = `${colorOf(a)}88`;
      g.setLineDash([]);
      g.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
      g.strokeRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
      labels.push({ x: Math.max(4, x1 + 4), y: Math.min(y1, y2) + 11, text: a.label, color: colorOf(a), left: true });
    }
    g.lineWidth = 1;

    // candles
    for (let i = view.first; i <= view.last; i++) {
      const c = candles[i];
      if (!c) continue;
      const x = xOf(i);
      const up = c.c >= c.o;
      g.strokeStyle = up ? UP : DOWN;
      g.fillStyle = up ? UP : DOWN;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, yOf(c.h));
      g.lineTo(Math.round(x) + 0.5, yOf(c.l));
      g.stroke();
      const bw = Math.max(1, off.barW * 0.72);
      const y1 = yOf(Math.max(c.o, c.c));
      const y2 = yOf(Math.min(c.o, c.c));
      g.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
    }

    // lines / polylines / markers
    for (const a of annotations) {
      if (!vis(a)) continue;
      const col = colorOf(a);
      if (a.kind === 'hline') {
        const x1 = xOf(idxOfTime(a.t1));
        const x2 = a.t2 == null ? plotW : xOf(idxOfTime(a.t2));
        const y = yOf(a.p1);
        g.strokeStyle = col;
        g.lineWidth = a.tone ? 1.4 : 1;
        g.setLineDash(dash(a));
        g.beginPath();
        g.moveTo(x1, Math.round(y) + 0.5);
        g.lineTo(x2, Math.round(y) + 0.5);
        g.stroke();
        g.setLineDash([]);
        if (a.label && x2 > -50 && x1 < plotW) labels.push({ x: Math.min(plotW - 4, x2 - 4), y: y - 3, text: a.label, color: col, right: true, strong: !!a.tone });
      } else if (a.kind === 'poly') {
        g.strokeStyle = col;
        g.lineWidth = a.group === 'abcd' ? 1.8 : 1.2;
        g.setLineDash(dash(a));
        g.beginPath();
        a.points.forEach((p, k) => {
          const x = xOf(idxOfTime(p.t));
          const y = yOf(p.p);
          if (k) g.lineTo(x, y);
          else g.moveTo(x, y);
        });
        g.stroke();
        g.setLineDash([]);
      } else if (a.kind === 'marker') {
        const x = xOf(idxOfTime(a.t));
        const y = yOf(a.p);
        if (x < -10 || x > plotW + 10) continue;
        g.fillStyle = col;
        const s = a.bold ? 6 : a.small ? 3.5 : 5;
        g.beginPath();
        if (a.shape === 'up') {
          g.moveTo(x, y + 3);
          g.lineTo(x - s, y + 3 + s * 1.6);
          g.lineTo(x + s, y + 3 + s * 1.6);
        } else if (a.shape === 'down') {
          g.moveTo(x, y - 3);
          g.lineTo(x - s, y - 3 - s * 1.6);
          g.lineTo(x + s, y - 3 - s * 1.6);
        } else g.arc(x, y, s * 0.8, 0, Math.PI * 2);
        g.closePath();
        g.fill();
        if (a.label && (!a.small || off.barW > 7)) {
          const dy = a.shape === 'up' ? y + 3 + s * 1.6 + 11 : a.shape === 'down' ? y - 3 - s * 1.6 - 4 : y - 9;
          g.font = `${a.bold ? 'bold ' : ''}${mobile ? 10 : 11}px ui-monospace, monospace`;
          g.fillStyle = col;
          g.textAlign = 'center';
          g.fillText(a.label, x, dy);
          g.textAlign = 'left';
          g.font = `${mobile ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        }
      }
    }

    // current price
    const last = candles[candles.length - 1];
    const yl = yOf(last.c);
    g.strokeStyle = last.c >= last.o ? UP : DOWN;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(0, Math.round(yl) + 0.5);
    g.lineTo(plotW, Math.round(yl) + 0.5);
    g.stroke();
    g.setLineDash([]);

    // line labels without overlap (sorted by y, nudged apart; right-aligned labels first)
    const placed = [];
    labels.sort((a, b) => a.y - b.y);
    g.font = `${mobile ? 9.5 : 10.5}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    for (const L of labels) {
      let y = L.y;
      for (const p of placed) if (Math.abs(p.y - y) < 12 && (p.right === L.right) && Math.abs(p.x - L.x) < 170) y = p.y + 12;
      L.y = y;
      placed.push(L);
      g.fillStyle = L.color;
      g.textAlign = L.right ? 'right' : 'left';
      g.fillText(L.text, L.x, y);
    }
    g.textAlign = 'left';
    g.restore();

    // price axis
    g.fillStyle = BG;
    g.fillRect(plotW, 0, axisW, size.h);
    g.fillStyle = TXT;
    g.font = `${mobile ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ticks.forEach((p) => g.fillText(fmtP(p), plotW + 5, yOf(p) + 4));
    g.fillStyle = last.c >= last.o ? UP : DOWN;
    g.fillRect(plotW, yl - 9, axisW, 18);
    g.fillStyle = '#fff';
    g.fillText(fmtP(last.c), plotW + 5, yl + 4);

    // time axis
    g.fillStyle = BG;
    g.fillRect(0, plotH, size.w, axisH);
    g.fillStyle = TXT;
    for (let i = Math.ceil(view.first / stepBars) * stepBars; i <= view.last; i += stepBars) {
      const c = candles[i];
      if (c) g.fillText(fmtT(c.t, tf), Math.max(2, xOf(i) - 28), plotH + 15);
    }

    // crosshair
    if (hover && hover.x < plotW && hover.y < plotH) {
      g.strokeStyle = 'rgba(203,213,225,0.45)';
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(hover.x + 0.5, 0);
      g.lineTo(hover.x + 0.5, plotH);
      g.moveTo(0, hover.y + 0.5);
      g.lineTo(plotW, hover.y + 0.5);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#334155';
      g.fillRect(plotW, hover.y - 9, axisW, 18);
      g.fillStyle = '#fff';
      g.fillText(fmtP(pOfY(hover.y)), plotW + 5, hover.y + 4);
      const idx = Math.round(off.right - (plotW - hover.x) / off.barW);
      const c = candles[idx];
      if (c) {
        const label = fmtT(c.t, tf);
        const w = g.measureText(label).width + 12;
        g.fillStyle = '#334155';
        g.fillRect(Math.min(Math.max(0, hover.x - w / 2), plotW - w), plotH + 2, w, 18);
        g.fillStyle = '#fff';
        g.fillText(label, Math.min(Math.max(6, hover.x - w / 2 + 6), plotW - w + 6), plotH + 15);
      }
    }
    }
  }, [candles, size, off, view, hover, hidden, onlyTf, annotations, loading, err, tf]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── interaction: drag-pan · wheel zoom · pinch ───────────────────────────────────────
  const clampRight = (r, n) => Math.min(n - 1 + Math.max(8, plotW / off.barW / 2), Math.max(Math.min(n - 1, plotW / off.barW / 2), r));
  const onDown = (e) => {
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch (_) {}
    ptr.current.set(e.pointerId, { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });
    drag.current = { x: e.nativeEvent.offsetX, right: off.right, barW: off.barW, dist: null };
  };
  const onMove = (e) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    if (ptr.current.has(e.pointerId)) ptr.current.set(e.pointerId, { x, y });
    if (ptr.current.size === 2) {
      const [a, b] = [...ptr.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cur = drag.current || (drag.current = { x: 0, right: off.right, barW: off.barW, dist: null });
      if (cur.dist == null) cur.dist = d;
      else if (cur.dist > 0) {
        const k = d / cur.dist;
        cur.dist = d;
        if (Number.isFinite(k) && k > 0) setOff((o) => ({ ...o, barW: Math.min(40, Math.max(2, o.barW * k)) }));
      }
      return;
    }
    const d0 = drag.current; // copy now: the ref is cleared on pointer-up, before React runs the updater below
    if (ptr.current.size === 1 && d0) {
      const dx = x - d0.x;
      const startRight = d0.right;
      const n = candles.length;
      setOff((o) => ({ ...o, right: clampRight(startRight - dx / o.barW, n) }));
      setHover(null);
      return;
    }
    setHover({ x, y });
  };
  const onUp = (e) => {
    ptr.current.delete(e.pointerId);
    if (ptr.current.size === 1) {
      // one finger left after a pinch: continue as a pan from where that finger is
      const [p] = [...ptr.current.values()];
      drag.current = { x: p.x, right: off.right, barW: off.barW, dist: null };
    } else drag.current = null;
  };
  const onWheel = (e) => {
    e.preventDefault();
    const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const x = e.nativeEvent.offsetX;
    setOff((o) => {
      const barW = Math.min(40, Math.max(2, o.barW * k));
      const idxAt = o.right - (plotW - x) / o.barW; // keep the candle under the cursor fixed
      return { barW, right: clampRight(idxAt + (plotW - x) / barW, candles.length) };
    });
  };
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const h = (e) => e.preventDefault();
    cv.addEventListener('wheel', h, { passive: false });
    return () => cv.removeEventListener('wheel', h);
  }, []);

  const fit = () => setOff({ barW: 8, right: candles.length - 1 + 6 });
  const hv = hover && candles.length ? candles[Math.min(candles.length - 1, Math.max(0, Math.round(off.right - (plotW - hover.x) / off.barW)))] : null;
  const info = hv || candles[candles.length - 1];
  const groupsPresent = new Set(annotations.map((a) => a.group));

  return (
    <div style={{ background: BG, borderRadius: 12, overflow: 'hidden', border: '1px solid #1E293B' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 8px 4px', alignItems: 'center' }}>
        {TFS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            onClick={() => pickTf(v)}
            style={{ padding: '4px 9px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: '1px solid #334155', background: tf === v ? '#2563EB' : 'transparent', color: tf === v ? '#fff' : '#CBD5E1', cursor: 'pointer' }}
          >
            {l}
          </button>
        ))}
        <button type="button" onClick={fit} style={{ marginLeft: 'auto', padding: '4px 9px', fontSize: 12, borderRadius: 6, border: '1px solid #334155', background: 'transparent', color: '#CBD5E1', cursor: 'pointer' }}>
          Fit
        </button>
      </div>
      <div ref={wrapRef} style={{ position: 'relative', touchAction: 'none', userSelect: 'none' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => !drag.current && setHover(null)}
          onWheel={onWheel}
          style={{ display: 'block', cursor: drag.current ? 'grabbing' : 'crosshair', touchAction: 'none' }}
        />
        {info && (
          <div style={{ position: 'absolute', left: 8, top: 6, fontSize: mobile ? 10 : 11, color: '#CBD5E1', fontFamily: 'ui-monospace, monospace', pointerEvents: 'none', textShadow: '0 1px 2px #000' }}>
            <b>{symbol.replace('USDT', '')}/USDT · {TFS.find(([v]) => v === tf)?.[1]}</b>
            {' '}O {fmtP(info.o)} H {fmtP(info.h)} L {fmtP(info.l)} C {fmtP(info.c)}{' '}
            <span style={{ color: info.c >= info.o ? UP : DOWN }}>{(((info.c - info.o) / info.o) * 100).toFixed(2)}%</span>
            {!mobile && <> · Vol {Math.round(info.v).toLocaleString()}</>}
          </div>
        )}
        {historicalAt != null && (
          <div style={{ position: 'absolute', right: axisW + 8, top: 6, fontSize: 10, color: '#FBBF24', background: 'rgba(15,23,42,0.8)', padding: '2px 6px', borderRadius: 4 }}>
            setup period
          </div>
        )}
      </div>
      {err && <div style={{ padding: '4px 10px', color: '#FCA5A5', fontSize: 12 }}>{err}</div>}
      {annotations.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 8px 8px', alignItems: 'center' }}>
          {GROUPS.filter(([k]) => groupsPresent.has(k)).map(([k, l, c]) => {
            const on = !hidden[k];
            return (
              <button key={k} type="button" onClick={() => setHidden((h) => ({ ...h, [k]: on }))} title={on ? 'Hide' : 'Show'} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 8px', borderRadius: 999, border: `1px solid ${on ? c : '#334155'}`, background: on ? `${c}22` : 'transparent', color: on ? '#E2E8F0' : '#64748B', cursor: 'pointer' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: on ? c : '#475569' }} />
                {l}
              </button>
            );
          })}
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94A3B8', marginLeft: 'auto' }}>
            <input type="checkbox" checked={onlyTf} onChange={(e) => setOnlyTf(e.target.checked)} />
            only {tf.toUpperCase()} annotations
          </label>
        </div>
      )}
    </div>
  );
}
