'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** keep the picks while the user switches between Scan / Candles / Double OB / Backtest */
const KEEP = { tfs: ['15m', '1h', '4h'], topN: 100, side: 'ALL', aligned: false, alignTol: 10 };

const TF_OPTIONS = [['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['2h', '2h'], ['4h', '4h'], ['1d', 'Daily']];
const ALIGN_OPTIONS = [[5, '≤ 5%'], [10, '≤ 10%'], [20, '≤ 20%']];
const TOP_OPTIONS = [[50, 'Top 50'], [100, 'Top 100'], [200, 'Top 200'], [0, 'All coins']];
const tfLabel = (tf) => (tf === '1d' ? 'Daily' : tf);

const fmtPrice = (p) => {
  const n = +p;
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 100) return n.toFixed(3);
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.1) return n.toFixed(5);
  if (a >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
};
const fmtTime = (sec) =>
  new Date(sec * 1000).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const keyOf = (s) => `${s.symbol}|${s.tf}|${s.type}|${s.inner.time}`;
const base = (sym) => String(sym || '').replace(/USDT$/, '');

function niceTicks(min, max, count = 6) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(12));
  return out;
}

// ─────────────────────────────────────────────────────────────
// Chart — candles + the OUTER and INNER order block, drawn like the TradingView indicator:
// each zone starts at its own candle and runs to the right until it is broken.
// ─────────────────────────────────────────────────────────────
const MAX_STEP = 8; // px per candle when there is room
const MIN_STEP = 2.2; // never thinner than this (the chart scrolls instead)
const EXT = 18; // empty candles to the right so open zones visibly "run on"
const PAD_R = 62;
const PAD_T = 16;
const PAD_B = 26;
const H = 340;

function ZoneChart({ candles, setup }) {
  const wrap = useRef(null);
  const [avail, setAvail] = useState(340);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (el && el.clientWidth) setAvail(el.clientWidth);
  }, []);

  const geo = useMemo(() => {
    const len = candles.length;
    const idxOf = (t) => {
      const i = candles.findIndex((c) => c.time >= t);
      return i < 0 ? len - 1 : i;
    };
    const oi = idxOf(setup.outer.time);
    const ii = idxOf(setup.inner.time);
    const mi = setup.mitigation === 'broken' && setup.mitigatedTime ? idxOf(setup.mitigatedTime) : null;
    const ti = setup.mitigation === 'touched' && setup.mitigatedTime ? idxOf(setup.mitigatedTime) : null;
    let start = Math.max(0, Math.min(oi, ii) - 24);
    start = Math.min(start, Math.max(0, len - 90)); // always show at least ~90 candles
    const win = candles.slice(start);
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of win) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    // the zones must always fit, even when their candles are far from price
    lo = Math.min(lo, setup.outer.low, setup.inner.low, setup.price);
    hi = Math.max(hi, setup.outer.high, setup.inner.high, setup.price);
    const pad = (hi - lo) * 0.07 || hi * 0.01;
    return { win, start, oi: oi - start, ii: ii - start, mi: mi != null ? mi - start : null, ti: ti != null ? ti - start : null, min: lo - pad, max: hi + pad };
  }, [candles, setup]);

  const n = geo.win.length;
  // fit the whole picture (both zones + price) on screen when it can; otherwise scroll sideways
  const STEP = Math.max(MIN_STEP, Math.min(MAX_STEP, Math.floor(((avail - PAD_R) / (n + EXT)) * 10) / 10));
  const bodyW = Math.max(1.4, STEP * 0.62);
  const plotW = (n + EXT) * STEP;
  const width = plotW + PAD_R;
  const y = (p) => PAD_T + ((geo.max - p) / (geo.max - geo.min)) * (H - PAD_T - PAD_B);
  const x = (i) => i * STEP + STEP / 2;
  const bear = setup.type === 'bearish';
  const rgb = bear ? '239,68,68' : '34,197,94';
  const col = bear ? '#ef4444' : '#22c55e';

  useEffect(() => {
    const el = wrap.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [candles, setup, avail]);

  const ticks = niceTicks(geo.min, geo.max, 6);

  const zone = (z, startI, strong, label) => {
    const x1 = Math.max(0, x(startI) - STEP / 2);
    const x2 = geo.mi != null ? x(geo.mi) + STEP / 2 : plotW;
    const yTop = y(z.high);
    const yBot = y(z.low);
    const h = Math.max(3, yBot - yTop);
    return (
      <g key={label}>
        <rect x={x1} y={yTop} width={Math.max(2, x2 - x1)} height={h} fill={`rgba(${rgb},${strong ? 0.34 : 0.16})`} stroke={`rgba(${rgb},${strong ? 0.95 : 0.6})`} strokeWidth={strong ? 1.3 : 1} />
        <line x1={x1} x2={x2} y1={y(z.mid)} y2={y(z.mid)} stroke={`rgba(${rgb},${strong ? 1 : 0.7})`} strokeWidth="1" strokeDasharray={strong ? '0' : '4 3'} />
        <text x={x1 + 4} y={yTop + 11} fill="#fff" fontSize="10" fontWeight="700" opacity="0.92">{label}</text>
      </g>
    );
  };

  const tag = (price, text, bg, fg = '#fff') => (
    <g key={text + price}>
      <rect x={plotW + 3} y={y(price) - 8} width={PAD_R - 5} height="16" rx="3" fill={bg} />
      <text x={plotW + 3 + (PAD_R - 5) / 2} y={y(price) + 3.5} fill={fg} fontSize="10" fontWeight="700" textAnchor="middle">{text}</text>
    </g>
  );

  return (
    <div className="dob-chart" ref={wrap}>
      <svg width={width} height={H} role="img" aria-label={`${setup.symbol || ''} ${setup.tf || ''} double order block chart`}>
        <rect x="0" y="0" width={width} height={H} fill="#0b1220" />
        {ticks.map((t) => (
          <g key={t}>
            <line x1="0" x2={plotW} y1={y(t)} y2={y(t)} stroke="#17233a" strokeWidth="1" />
            <text x={plotW + 6} y={y(t) + 3} fill="#7f92b0" fontSize="10">{fmtPrice(t)}</text>
          </g>
        ))}

        {zone(setup.outer, geo.oi, false, 'OB 1')}
        {zone(setup.inner, geo.ii, true, 'OB 2 · entry')}

        {geo.win.map((c, i) => {
          const up = c.close >= c.open;
          const cc = up ? '#22c55e' : '#ef4444';
          const yo = y(c.open);
          const yc = y(c.close);
          return (
            <g key={c.time}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={cc} strokeWidth="1" />
              <rect x={x(i) - bodyW / 2} y={Math.min(yo, yc)} width={bodyW} height={Math.max(1, Math.abs(yo - yc))} fill={cc} />
            </g>
          );
        })}

        {geo.ti != null && (
          <g>
            <circle cx={x(geo.ti)} cy={y(bear ? Math.max(setup.inner.low, Math.min(setup.inner.high, geo.win[geo.ti].high)) : Math.min(setup.inner.high, Math.max(setup.inner.low, geo.win[geo.ti].low)))} r="4.5" fill="none" stroke="#fbbf24" strokeWidth="1.6" />
            <text x={x(geo.ti) + 7} y={y(setup.inner.mid) - 6} fill="#fbbf24" fontSize="10" fontWeight="700">touched</text>
          </g>
        )}
        {geo.mi != null && (
          <text x={x(geo.mi) + 6} y={y(setup.inner.mid) - 6} fill="#fbbf24" fontSize="10" fontWeight="700">broken</text>
        )}

        {/* current price */}
        <line x1="0" x2={plotW} y1={y(setup.price)} y2={y(setup.price)} stroke="#60a5fa" strokeWidth="1" strokeDasharray="2 3" />
        {tag(setup.price, fmtPrice(setup.price), '#2563eb')}
        {tag(setup.inner.mid, fmtPrice(setup.inner.mid), col)}

        {geo.win.map((c, i) =>
          i % Math.max(4, Math.ceil(78 / STEP)) === 0 ? (
            <text key={`t${c.time}`} x={x(i)} y={H - 8} fill="#7f92b0" fontSize="9.5" textAnchor="middle">{fmtTime(c.time)}</text>
          ) : null
        )}
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
function SetupCard({ s, open, onToggle, chart }) {
  const bear = s.type === 'bearish';
  const waiting = s.status === 'UNMITIGATED';
  const tone = s.proximityPct >= 70 ? 'near' : s.proximityPct >= 40 ? 'mid' : 'far';
  return (
    <article className={`dob-card ${bear ? 'bear' : 'bull'}${waiting ? '' : ' done'}${open ? ' open' : ''}`}>
      <button type="button" className="dob-card-head" onClick={onToggle} aria-expanded={open}>
        <div className="dob-top">
          <span className={`dob-side ${bear ? 'bear' : 'bull'}`}>{bear ? '▼ SELL' : '▲ BUY'}</span>
          <span className="dob-sym">{base(s.symbol)}<small>/USDT</small></span>
          <span className="dob-tf">{tfLabel(s.tf)}</span>
          {waiting ? (
            <span className={`dob-prox ${tone}`}>{s.proximityPct != null ? `${s.proximityPct}%` : '—'}<small> to entry</small></span>
          ) : (
            <span className="dob-state">{s.mitigation === 'broken' ? 'Broken' : 'Touched'} · {s.mitigatedAgo === 0 ? 'now' : `${s.mitigatedAgo} candles ago`}</span>
          )}
        </div>
        <div className="dob-line">
          <span><em>Entry</em> <b>{fmtPrice(s.entry)}</b></span>
          <span><em>Now</em> <b>{fmtPrice(s.price)}</b></span>
          {waiting && s.distPct != null && <span><b>{s.distPct}%</b> away</span>}
        </div>
        <div className="dob-zones">
          <span><i className="o" /> OB 1 {fmtPrice(s.outer.low)} – {fmtPrice(s.outer.high)}</span>
          <span><i className="n" /> OB 2 {fmtPrice(s.inner.low)} – {fmtPrice(s.inner.high)}</span>
          {Number.isFinite(+s.midGapPct) && (
            <span className={`dob-gap${s.midGapPct <= 5 ? ' tight' : s.midGapPct <= 10 ? ' close' : ''}`}>
              Mid gap {s.midGapPct === 0 ? '0%' : `${s.midGapPct}%`}{s.midGapPct <= 5 ? ' · same line ✓' : s.midGapPct <= 10 ? ' · very close ✓' : ''}
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="dob-open">
          {chart?.loading && <div className="dob-note">Chart loading…</div>}
          {chart?.error && <div className="cp-err">{chart.error}</div>}
          {chart?.candles?.length > 0 && <ZoneChart candles={chart.candles} setup={chart.setup || s} />}
          {chart?.candles?.length > 0 && (
            <div className="cp-legend">
              OB 1 = පිටත order block · OB 2 = ඇතුළත order block (entry zone, මැද ඉර = entry). Zone එක කැඩෙනකම් දකුණට දිගු වෙනවා.
              {!waiting && ' මේක දැනටමත් mitigate වෙලා.'}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function DoubleObScanner({ symbol, runToken }) {
  const [tfs, setTfs] = useState(KEEP.tfs);
  const [topN, setTopN] = useState(KEEP.topN);
  const [side, setSide] = useState(KEEP.side);
  const [aligned, setAligned] = useState(KEEP.aligned);
  const [alignTol, setAlignTol] = useState(KEEP.alignTol);
  const [setups, setSetups] = useState(null); // null = nothing scanned yet
  const [info, setInfo] = useState(null); // { mode, symbol, running, scanned, total, note, errors, stopped, done }
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const [charts, setCharts] = useState({});
  const stopRef = useRef(false);
  const lastRun = useRef(0);
  const store = useRef({}); // candles from a single-coin scan: "SYMBOL|tf" → candles

  useEffect(() => { KEEP.tfs = tfs; KEEP.topN = topN; KEEP.side = side; KEEP.aligned = aligned; KEEP.alignTol = alignTol; }, [tfs, topN, side, aligned, alignTol]);

  async function singleScan(sym) {
    setInfo({ mode: 'coin', symbol: sym, running: true, errors: [] });
    const res = await fetch('/api/scan/double-ob', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, timeframes: tfs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);
    const all = [];
    for (const g of data.groups || []) {
      if (g.candles?.length) store.current[`${data.symbol}|${g.tf}`] = g.candles;
      for (const s of g.setups || []) all.push(s);
    }
    setSetups(all);
    setInfo({ mode: 'coin', symbol: data.symbol, running: false, done: true, errors: data.errors || [], price: data.price });
  }

  async function marketScan() {
    stopRef.current = false;
    const CHUNK = 8;
    const seen = new Set();
    const acc = { mode: 'market', running: true, scanned: 0, total: 0, note: '', errors: [], stopped: false, done: false };
    let list = [];
    const snap = () => { setInfo({ ...acc, errors: [...acc.errors] }); setSetups([...list]); };
    snap();
    let offset = 0;
    let symbols = null;
    let total = 0;
    let retries = 0;
    while (!stopRef.current) {
      const slice = symbols ? symbols.slice(offset, offset + CHUNK) : null;
      const res = await fetch('/api/scan/double-ob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeframes: tfs, offset, limit: CHUNK, topN, ...(slice ? { symbols: slice, total } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Login කරලා නැහැ');
      if (!res.ok) {
        if (data.banned) { acc.errors.push('Binance rate limit (ban) — scan නතර කළා, පස්සේ try කරන්න'); break; }
        throw new Error(data.error || `Scan failed (${res.status})`);
      }
      if (data.symbols) symbols = data.symbols;
      total = data.total || total;
      for (const s of data.setups || []) {
        const k = keyOf(s);
        if (seen.has(k)) continue;
        seen.add(k);
        list.push(s);
      }
      acc.errors.push(...(data.errors || []));
      if (data.banned) { acc.errors.push('Binance rate limit (ban) — scan නතර කළා, පස්සේ try කරන්න'); break; }
      if (data.throttled) {
        retries++;
        if (retries > 6) { acc.errors.push('Binance rate limit — නැවත නැවත hit වුණා, නතර කළා'); break; }
        acc.note = 'Binance rate limit — තත්පර 20ක් ඉඳලා ඉදිරියට යනවා…';
        snap();
        await new Promise((r) => setTimeout(r, data.retryAfterMs || 20000));
        acc.note = '';
        continue;
      }
      retries = 0;
      acc.total = total;
      offset = data.nextOffset;
      acc.scanned = Math.min(total, offset);
      snap();
      if (data.done || !total) { acc.done = true; break; }
    }
    acc.stopped = stopRef.current && !acc.done;
    acc.running = false;
    acc.note = '';
    snap();
  }

  async function run() {
    setErr('');
    if (!tfs.length) { setErr('Timeframe එකක් හරි select කරන්න'); return; }
    if (info?.running) return;
    const compact = String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    setOpen(null);
    setCharts({});
    store.current = {};
    setSetups(null);
    try {
      if (compact) await singleScan(compact);
      else await marketScan();
    } catch (e) {
      setErr(e.message || 'Scan failed');
      setInfo((i) => (i ? { ...i, running: false } : i));
    }
  }

  // the parent's scan button bumps runToken
  useEffect(() => {
    if (runToken && runToken !== lastRun.current) {
      lastRun.current = runToken;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  async function toggle(s) {
    const k = keyOf(s);
    if (open === k) { setOpen(null); return; }
    setOpen(k);
    if (charts[k]?.candles) return;
    const cached = store.current[`${s.symbol}|${s.tf}`];
    if (cached) { setCharts((c) => ({ ...c, [k]: { candles: cached, setup: s } })); return; }
    setCharts((c) => ({ ...c, [k]: { loading: true } }));
    try {
      const res = await fetch('/api/scan/double-ob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: s.symbol, timeframes: [s.tf] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Chart load failed');
      const g = (data.groups || [])[0];
      if (!g?.candles?.length) throw new Error('Candles නැහැ');
      // re-use the fresh copy of this setup (indexes belong to THIS candle set); fall back to the scanned one
      const fresh = (g.setups || []).find((x) => x.type === s.type && x.inner.time === s.inner.time && x.outer.time === s.outer.time);
      setCharts((c) => ({ ...c, [k]: { candles: g.candles, setup: fresh ? { ...fresh, symbol: s.symbol, tf: s.tf } : s } }));
    } catch (e) {
      setCharts((c) => ({ ...c, [k]: { error: e.message } }));
    }
  }

  const all = setups || [];
  const gapOf = (s) => (Number.isFinite(+s.midGapPct) ? +s.midGapPct : (Math.abs(s.outer.mid - s.inner.mid) / (s.outer.high - s.outer.low || 1)) * 100);
  const shown = all.filter((s) => (side === 'ALL' || s.side === side) && (!aligned || gapOf(s) <= alignTol));
  const hiddenByAlign = aligned ? all.filter((s) => side === 'ALL' || s.side === side).length - shown.length : 0;
  const waiting = shown.filter((s) => s.status === 'UNMITIGATED').sort((a, b) => (a.distAtr ?? Infinity) - (b.distAtr ?? Infinity));
  const done = shown.filter((s) => s.status === 'MITIGATED').sort((a, b) => (a.mitigatedAgo ?? Infinity) - (b.mitigatedAgo ?? Infinity));
  const running = !!info?.running && info.mode === 'market';
  const pct = info?.total ? Math.round((info.scanned / info.total) * 100) : 0;

  const list = (arr) => arr.map((s) => <SetupCard key={keyOf(s)} s={s} open={open === keyOf(s)} onToggle={() => toggle(s)} chart={charts[keyOf(s)]} />);

  return (
    <div className="dob-wrap">
      <div className="cs-chip-label">Timeframes</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {TF_OPTIONS.map(([v, l]) => {
          const on = tfs.includes(v);
          return (
            <button key={v} type="button" className={`cs-chip${on ? ' on' : ''}`} onClick={() => setTfs(on ? tfs.filter((x) => x !== v) : [...tfs, v])}>
              {l}
            </button>
          );
        })}
      </div>

      {!String(symbol || '').trim() && (
        <div style={{ marginTop: 10 }}>
          <div className="cs-chip-label">Scan කරන coins (volume අනුව)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TOP_OPTIONS.map(([v, l]) => (
              <button key={v} type="button" className={`cs-chip${topN === v ? ' on' : ''}`} onClick={() => setTopN(v)}>{l}</button>
            ))}
          </div>
        </div>
      )}

      <label className={`cp-trend${aligned ? ' on' : ''}`}>
        <input type="checkbox" checked={aligned} onChange={(e) => setAligned(e.target.checked)} />
        <span>
          <strong>Mid lines align</strong>
          <br />
          <small>OB 1 ගේ mid line එකයි OB 2 ගේ mid line එකයි එකම / ගොඩක් ළඟම තියෙන ඒවා විතරක් (gap එක OB 1 උසෙන් %)</small>
        </span>
      </label>
      {aligned && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {ALIGN_OPTIONS.map(([v, l]) => (
            <button key={v} type="button" className={`cs-chip${alignTol === v ? ' on' : ''}`} onClick={() => setAlignTol(v)}>{l}</button>
          ))}
        </div>
      )}

      <p className="dob-explain">
        <b>Double OB</b> = Order Block එකක් ඇතුළේ තව Order Block එකක් (එකම දිශාවට) හැදිලා තියෙන තැන්. ඇතුළේ OB එකේ මැද ඉර entry එක; price එක ඒකට එනකම් බලාගෙන ඉන්නවා.
        හිස්ව ඇති input එකකින් scan කළොත් top coins ඔක්කොම scan වෙනවා.
      </p>

      {err && <div className="cp-err">{err}</div>}

      {info && info.mode === 'market' && (
        <div className="dob-progress">
          <div className="dob-bar"><i style={{ width: `${pct}%` }} /></div>
          <div className="dob-progress-row">
            <span>{info.scanned}/{info.total || '—'} coins · {pct}%{info.note ? ` · ${info.note}` : ''}</span>
            {running && <button type="button" onClick={() => { stopRef.current = true; }}>Stop</button>}
            {!running && info.stopped && <span className="muted">නතර කළා</span>}
            {!running && info.done && <span className="muted">Done ✓</span>}
          </div>
        </div>
      )}
      {info && info.mode === 'coin' && info.running && <div className="cp-busy">Scanning {info.symbol}…</div>}

      {setups && (
        <>
          <div className="dob-filter">
            {[['ALL', 'All'], ['BUY', '▲ Buy'], ['SELL', '▼ Sell']].map(([v, l]) => (
              <button key={v} type="button" className={side === v ? 'on' : ''} onClick={() => setSide(v)}>{l}</button>
            ))}
          </div>

          {aligned && (
            <div className="dob-sub" style={{ marginTop: 10 }}>
              Mid lines align filter ON (gap {ALIGN_OPTIONS.find((o) => o[0] === alignTol)?.[1]}) · {shown.length} පෙන්වනවා{hiddenByAlign > 0 ? ` · ${hiddenByAlign} සඟවලා` : ''}
            </div>
          )}

          <h3 className="dob-h waiting">⏳ Not mitigated <span>{waiting.length}</span></h3>
          <div className="dob-sub">Inner OB එකට price එක තවම ඇවිත් නෑ · entry එකට ළඟම ඒවා උඩින්</div>
          {waiting.length ? list(waiting) : <div className="cp-empty">{running ? 'Scanning…' : aligned ? 'Mid line ළඟම තියෙන Not mitigated Double OB කිසිවක් නැහැ' : 'Not mitigated Double OB කිසිවක් නැහැ'}</div>}

          <h3 className="dob-h done">✅ Mitigated <span>{done.length}</span></h3>
          <div className="dob-sub">Inner OB එකට price එක දැනටමත් ඇවිත් (touched) හෝ කැඩිලා (broken) · අලුත්ම ඒවා උඩින්</div>
          {done.length ? list(done) : <div className="cp-empty">{running ? 'Scanning…' : aligned ? 'Mid line ළඟම තියෙන Mitigated Double OB කිසිවක් නැහැ' : 'Mitigated Double OB කිසිවක් නැහැ'}</div>}

          {info?.errors?.length > 0 && !running && (
            <div className="dob-sub" style={{ marginTop: 12 }}>⚠ {info.errors.length} error(s): {info.errors[0]}</div>
          )}
        </>
      )}
    </div>
  );
}
