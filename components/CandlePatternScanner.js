'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/** keep the picks while the user switches between Scan / Candles / Backtest */
const KEEP = { patterns: null, tfs: ['15m', '1h', '4h'], trend: true };

const TF_OPTIONS = [['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['2h', '2h'], ['4h', '4h'], ['1d', 'Daily']];

const STEP = 8; // px per candle
const PAD_R = 58;
const PAD_T = 14;
const PAD_B = 24;
const H = 320;

const fmtPrice = (p) => {
  const n = +p;
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
};
const fmtTime = (sec) =>
  new Date(sec * 1000).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

function PatternChart({ candles, detections, focus }) {
  const wrap = useRef(null);
  const width = candles.length * STEP + PAD_R + 10;

  const { min, max } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    const pad = (hi - lo) * 0.08 || hi * 0.01;
    return { min: lo - pad, max: hi + pad };
  }, [candles]);

  const y = (p) => PAD_T + ((max - p) / (max - min)) * (H - PAD_T - PAD_B);
  const x = (i) => i * STEP + STEP / 2;

  // scroll to the newest candles, or to the picked pattern
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const target = focus != null ? x(focus.index) - el.clientWidth / 2 : el.scrollWidth;
    el.scrollTo({ left: Math.max(0, target), behavior: focus != null ? 'smooth' : 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, focus]);

  const gridPrices = [0, 1, 2, 3, 4].map((k) => min + ((max - min) * k) / 4);
  const labelEvery = 16;

  // stack labels of patterns that end on the same candle
  const stack = {};
  const marks = detections.map((d) => {
    const k = `${d.index}_${d.dir}`;
    stack[k] = (stack[k] || 0) + 1;
    return { d, row: stack[k] - 1 };
  });

  return (
    <div className="cp-chart" ref={wrap}>
      <svg width={width} height={H} role="img" aria-label="Candlestick chart with detected patterns">
        <rect x="0" y="0" width={width} height={H} fill="#0b1220" />
        {gridPrices.map((p) => (
          <g key={p}>
            <line x1="0" x2={width - PAD_R + 4} y1={y(p)} y2={y(p)} stroke="#1c2840" strokeWidth="1" />
            <text x={width - PAD_R + 8} y={y(p) + 3} fill="#7f92b0" fontSize="10">{fmtPrice(p)}</text>
          </g>
        ))}

        {marks.map(({ d }) => {
          const x1 = x(d.startIndex) - STEP / 2 - 1;
          const x2 = x(d.index) + STEP / 2 + 1;
          const on = focus && focus.index === d.index && focus.id === d.id;
          const col = d.dir === 'BULLISH' ? '34,197,94' : '239,68,68';
          return (
            <rect
              key={`z${d.id}${d.index}`}
              x={x1}
              y={y(d.high) - 3}
              width={x2 - x1}
              height={Math.max(8, y(d.low) - y(d.high) + 6)}
              rx="3"
              fill={`rgba(${col},${on ? 0.32 : 0.16})`}
              stroke={`rgba(${col},${on ? 1 : 0.55})`}
              strokeWidth={on ? 1.6 : 1}
            />
          );
        })}

        {candles.map((c, i) => {
          const up = c.close >= c.open;
          const col = up ? '#22c55e' : '#ef4444';
          const yo = y(c.open);
          const yc = y(c.close);
          return (
            <g key={c.time}>
              <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1" />
              <rect x={x(i) - 2.5} y={Math.min(yo, yc)} width="5" height={Math.max(1, Math.abs(yo - yc))} fill={col} />
            </g>
          );
        })}

        {marks.map(({ d, row }) => {
          const bullish = d.dir === 'BULLISH';
          const cx = x(d.index);
          const tipY = bullish ? y(d.low) + 8 + row * 22 : y(d.high) - 8 - row * 22;
          const col = bullish ? '#22c55e' : '#ef4444';
          const tri = bullish
            ? `${cx},${tipY} ${cx - 4.5},${tipY + 8} ${cx + 4.5},${tipY + 8}`
            : `${cx},${tipY} ${cx - 4.5},${tipY - 8} ${cx + 4.5},${tipY - 8}`;
          const textY = bullish ? tipY + 19 : tipY - 12;
          const anchor = cx > width - 120 ? 'end' : 'start';
          return (
            <g key={`m${d.id}${d.index}`}>
              <polygon points={tri} fill={col} />
              <text x={anchor === 'end' ? cx + 4 : cx - 4} y={textY} fill={col} fontSize="10" fontWeight="700" textAnchor={anchor}>
                {d.name}
              </text>
            </g>
          );
        })}

        {candles.map((c, i) =>
          i % labelEvery === 0 ? (
            <text key={`t${c.time}`} x={x(i)} y={H - 7} fill="#7f92b0" fontSize="9.5" textAnchor="middle">
              {fmtTime(c.time)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

export default function CandlePatternScanner({ symbol, runToken }) {
  const [catalog, setCatalog] = useState([]);
  const [picked, setPicked] = useState(KEEP.patterns);
  const [tfs, setTfs] = useState(KEEP.tfs);
  const [trend, setTrend] = useState(KEEP.trend);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [activeTf, setActiveTf] = useState(null);
  const [focus, setFocus] = useState(null);
  const lastRun = useRef(0);

  useEffect(() => {
    let off = false;
    fetch('/api/scan/candles')
      .then((r) => r.json())
      .then((d) => {
        if (off || !Array.isArray(d.patterns)) return;
        setCatalog(d.patterns);
        setPicked((p) => p || d.patterns.map((x) => x.id));
      })
      .catch(() => {});
    return () => { off = true; };
  }, []);

  useEffect(() => { KEEP.patterns = picked; KEEP.tfs = tfs; KEEP.trend = trend; }, [picked, tfs, trend]);

  async function run() {
    setErr('');
    if (!String(symbol || '').trim()) { setErr('Coin එකක් ගහන්න (උදා: BTC)'); return; }
    if (!picked?.length) { setErr('Pattern එකක් හරි select කරන්න'); return; }
    if (!tfs.length) { setErr('Timeframe එකක් හරි select කරන්න'); return; }
    setBusy(true);
    setFocus(null);
    try {
      const res = await fetch('/api/scan/candles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, timeframes: tfs, patterns: picked, requireTrend: trend }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      setResult(data);
      const best = data.groups.find((g) => g.detections.length) || data.groups[0];
      setActiveTf(best?.tf || null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // the parent's "Scan candles" button bumps runToken
  useEffect(() => {
    if (runToken && runToken !== lastRun.current) {
      lastRun.current = runToken;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  const set = new Set(picked || []);
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const setGroup = (dir, on) =>
    setPicked((p) => {
      const ids = catalog.filter((c) => c.dir === dir).map((c) => c.id);
      const rest = (p || []).filter((x) => !ids.includes(x));
      return on ? [...rest, ...ids] : rest;
    });

  const group = result?.groups.find((g) => g.tf === activeTf) || null;
  const bullCount = group ? group.detections.filter((d) => d.dir === 'BULLISH').length : 0;
  const bearCount = group ? group.detections.length - bullCount : 0;

  const section = (dir, title, tone) => {
    const list = catalog.filter((c) => c.dir === dir);
    const all = list.every((c) => set.has(c.id));
    return (
      <div className={`cp-section ${tone}`}>
        <div className="cp-section-head">
          <span className="cp-section-title">{title}</span>
          <span className="cp-section-actions">
            <button type="button" onClick={() => setGroup(dir, true)} disabled={all}>All</button>
            <button type="button" onClick={() => setGroup(dir, false)}>None</button>
          </span>
        </div>
        <div className="cp-chips">
          {list.map((c) => (
            <button key={c.id} type="button" title={c.hint} className={`cs-chip${set.has(c.id) ? ' on' : ''}`} onClick={() => toggle(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="cp-wrap">
      {section('BULLISH', '▲ Bullish reversal', 'bull')}
      {section('BEARISH', '▼ Bearish reversal', 'bear')}

      <div style={{ marginTop: 10 }}>
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
      </div>

      <label className={`cp-trend${trend ? ' on' : ''}`}>
        <input type="checkbox" checked={trend} onChange={(e) => setTrend(e.target.checked)} />
        <span>
          <strong>Prior trend required</strong>
          <br />
          <small>Reversal pattern එකට කලින් trend එකක් තියෙන්න ඕනේ — Bullish ට කලින් පහළට, Bearish ට කලින් ඉහළට move එකක්</small>
        </span>
      </label>

      {err && <div className="cp-err">{err}</div>}
      {busy && <div className="cp-busy">Scanning candles…</div>}

      {result && !busy && (
        <div className="cp-result">
          <div className="cp-result-head">
            <b>{result.symbol}</b> · ${fmtPrice(result.price)} · <span>{fmtTime(Date.parse(result.scannedAt) / 1000)}</span>
          </div>

          <div className="cp-tabs" role="tablist">
            {result.groups.map((g) => (
              <button key={g.tf} type="button" role="tab" aria-selected={g.tf === activeTf} className={g.tf === activeTf ? 'on' : ''} onClick={() => { setActiveTf(g.tf); setFocus(null); }}>
                {g.tf === '1d' ? 'Daily' : g.tf}
                <i className={g.detections.length ? 'has' : ''}>{g.detections.length}</i>
              </button>
            ))}
          </div>

          {group && group.candles.length > 0 && (
            <>
              <div className="cp-summary">
                <span className="bull">▲ {bullCount} bullish</span>
                <span className="bear">▼ {bearCount} bearish</span>
                <span className="muted">{group.candles.length} candles</span>
              </div>
              <PatternChart candles={group.candles} detections={group.detections} focus={focus} />
              <div className="cp-legend">Pattern එක ඇති candles highlight කරලා, ඊතලයක් + නමත් එක්ක පෙන්නනවා. List එකේ එකක් tap කරොත් chart එකේ ඒ තැනට යනවා.</div>

              {group.detections.length === 0 ? (
                <div className="cp-empty">මේ timeframe එකේ select කරපු pattern කිසිවක් හම්බුණේ නෑ.</div>
              ) : (
                <div className="cp-list">
                  {group.detections.map((d) => {
                    const on = focus && focus.index === d.index && focus.id === d.id;
                    return (
                      <button key={`${d.id}${d.index}`} type="button" className={`cp-row ${d.dir === 'BULLISH' ? 'bull' : 'bear'}${on ? ' on' : ''}`} onClick={() => setFocus({ index: d.index, id: d.id })}>
                        <span className="cp-badge">{d.dir === 'BULLISH' ? '▲ Bullish' : '▼ Bearish'}</span>
                        <span className="cp-name">{d.name}</span>
                        <span className="cp-meta">{fmtTime(d.time)} · {d.candles} candle{d.candles > 1 ? 's' : ''} · ${fmtPrice(d.close)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {group && group.error && <div className="cp-err">{group.tf}: {group.error}</div>}
        </div>
      )}
    </div>
  );
}
