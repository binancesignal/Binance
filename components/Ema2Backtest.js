'use client';

import { useRef, useState } from 'react';

const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtClock = (t) => {
  const d = new Date(t * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const tallyOf = (list) => {
  const t = { n: list.length, win: 0, loss: 0, open: 0, ret: 0, rn: 0, pending: 0, touched: 0 };
  for (const e of list) {
    if (e.status === 'PENDING') t.pending++;
    else t.touched++;
    if (e.outcome === 'WIN') t.win++;
    else if (e.outcome === 'LOSS') t.loss++;
    else t.open++;
    if (e.retPct != null) {
      t.ret += e.retPct;
      t.rn++;
    }
  }
  t.wr = t.win + t.loss ? ((t.win / (t.win + t.loss)) * 100).toFixed(1) : '—';
  t.avg = t.rn ? (t.ret / t.rn).toFixed(2) : '—';
  return t;
};

const css = {
  page: { background: '#F4F5F7', minHeight: '100vh', padding: 12, fontFamily: 'system-ui, Arial, sans-serif', color: '#111' },
  card: { background: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,.06)' },
  label: { fontSize: 12, color: '#555', marginBottom: 4, display: 'block' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #d5d9e0', borderRadius: 8, fontSize: 14, background: '#fff', color: '#111' },
  chip: (on) => ({ padding: '6px 12px', borderRadius: 16, border: '1px solid ' + (on ? '#2962ff' : '#d5d9e0'), background: on ? '#2962ff' : '#fff', color: on ? '#fff' : '#333', fontSize: 13, cursor: 'pointer' }),
  btn: (kind) => ({ padding: '10px 16px', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', background: kind === 'primary' ? '#2962ff' : '#e6e9ef', color: kind === 'primary' ? '#fff' : '#222' }),
  badge: (kind) => ({
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 6,
    marginLeft: 6,
    background: kind === 'TOUCHED' ? '#e8f0fe' : '#fff3e0',
    color: kind === 'TOUCHED' ? '#1967d2' : '#e65100',
  }),
};

export default function Ema2Backtest({ embedded = false }) {
  const [tfs, setTfs] = useState(['15m', '30m', '1h']);
  const [direction, setDirection] = useState('BOTH');
  const [mode, setMode] = useState('fast');
  const [windowBars, setWindowBars] = useState(5);
  const [forwardBars, setForwardBars] = useState(20);
  const [maxTouchBars, setMaxTouchBars] = useState(120);
  const [requireApproachSide, setRequireApproachSide] = useState(true);
  const [universe, setUniverse] = useState(100);
  const [symbol, setSymbol] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL'); // ALL | TOUCHED | PENDING
  const [run, setRun] = useState(null);
  const [open, setOpen] = useState(null);
  const stop = useRef(false);

  const body = (extra = {}) => ({
    timeframes: tfs,
    direction,
    mode,
    windowBars,
    forwardBars,
    maxTouchBars,
    requireApproachSide,
    universe,
    includeCharts: true,
    tzMin: -new Date().getTimezoneOffset(),
    ...extra,
  });

  async function scan(single) {
    if (!tfs.length) return;
    const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (single && !sym) return;
    stop.current = false;
    setOpen(null);
    const acc = { events: [], errors: [], total: 0, offset: 0, done: false, running: true, tfs: [...tfs], cfg: body() };
    setRun({ ...acc });
    let offset = 0;
    try {
      while (!stop.current) {
        const res = await fetch('/api/backtest/ema2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(single ? { symbol: sym } : { offset, limit: 6 })),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          acc.errors.push(data.error || `HTTP ${res.status}`);
          break;
        }
        acc.events.push(...(data.events || []));
        acc.total = data.total;
        acc.offset = data.nextOffset;
        acc.errors.push(...(data.errors || []));
        setRun({ ...acc, events: [...acc.events] });
        if (data.banned) {
          acc.errors.push('Binance rate limit / ban — stopped early');
          break;
        }
        if (data.done) {
          acc.done = true;
          break;
        }
        offset = data.nextOffset;
      }
    } catch (e) {
      acc.errors.push(e.message);
    }
    setRun({ ...acc, events: [...acc.events], running: false });
  }

  const raw = run?.events || [];
  const filtered = statusFilter === 'ALL' ? raw : raw.filter((e) => e.status === statusFilter);
  const evs = filtered.slice().sort((a, b) => b.time - a.time);
  const all = tallyOf(raw);
  const up = tallyOf(raw.filter((e) => e.dir === 'UP'));
  const down = tallyOf(raw.filter((e) => e.dir === 'DOWN'));
  const fb = run?.cfg?.forwardBars ?? forwardBars;

  return (
    <div style={embedded ? { fontFamily: 'inherit', color: 'inherit' } : css.page}>
      <h2 style={{ margin: '4px 0 10px', fontSize: 18 }}>
        EMA 2 Strategy — Triple Cross → First EMA200 Touch
      </h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: '#555', maxWidth: 720 }}>
        Detects EMA 20 / 50 / 200 triple crosses, then finds the <strong>first time price touches EMA200</strong> after the cross.
        That touch is the signal (time + price marked on the chart). Crosses that have not yet touched EMA200 stay as <em>PENDING</em>.
      </p>

      <div style={css.card}>
        <span style={css.label}>Time frames</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              style={css.chip(tfs.includes(t))}
              onClick={() => setTfs((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}
            >
              {t}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={css.label}>Direction</label>
            <select style={css.input} value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="BOTH">Both (up + down)</option>
              <option value="DOWN">Down only</option>
              <option value="UP">Up only</option>
            </select>
          </div>
          <div>
            <label style={css.label}>Cross rule</label>
            <select style={css.input} value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="fast">EMA20 crosses 50 + 200</option>
              <option value="all3">All 3 pairs cross</option>
              <option value="any2">Any 2 pairs cross</option>
            </select>
          </div>
          <div>
            <label style={css.label}>Cross window (bars)</label>
            <input style={css.input} type="number" min={1} max={30} value={windowBars} onChange={(e) => setWindowBars(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Max bars to find touch</label>
            <input style={css.input} type="number" min={10} max={400} value={maxTouchBars} onChange={(e) => setMaxTouchBars(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Forward bars (stats)</label>
            <input style={css.input} type="number" min={5} max={100} value={forwardBars} onChange={(e) => setForwardBars(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Universe (top N by volume)</label>
            <input style={css.input} type="number" min={5} max={300} value={universe} onChange={(e) => setUniverse(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Single symbol (optional)</label>
            <input style={css.input} placeholder="e.g. ADAUSDT" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={requireApproachSide} onChange={(e) => setRequireApproachSide(e.target.checked)} />
          Require approach from expected side (DOWN → from below, UP → from above)
        </label>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button type="button" style={css.btn('primary')} disabled={!!run?.running || !tfs.length} onClick={() => scan(false)}>
            {run?.running ? 'Scanning…' : 'Scan universe'}
          </button>
          <button type="button" style={css.btn()} disabled={!!run?.running || !symbol.trim()} onClick={() => scan(true)}>
            Scan symbol
          </button>
          {run?.running && (
            <button type="button" style={css.btn()} onClick={() => { stop.current = true; }}>
              Stop
            </button>
          )}
          {run && !run.running && (
            <span style={{ fontSize: 13, color: '#555' }}>
              {run.done ? 'Done' : 'Partial'} · {raw.length} events · universe {run.total}
            </span>
          )}
        </div>

        {run?.errors?.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#c62828' }}>
            {run.errors.slice(0, 8).map((err, i) => (
              <div key={i}>{err}</div>
            ))}
          </div>
        )}
      </div>

      {run && (
        <div style={css.card}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12, fontSize: 13 }}>
            <div>
              <strong>All</strong> {all.n} · touched {all.touched} · pending {all.pending}
              <br />
              WR {all.wr}% · avg {all.avg}% ({fb} bars)
            </div>
            <div>
              <strong>UP</strong> {up.n} · WR {up.wr}% · avg {up.avg}%
            </div>
            <div>
              <strong>DOWN</strong> {down.n} · WR {down.wr}% · avg {down.avg}%
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {['ALL', 'TOUCHED', 'PENDING'].map((s) => (
              <button key={s} type="button" style={css.chip(statusFilter === s)} onClick={() => setStatusFilter(s)}>
                {s === 'ALL' ? 'All' : s === 'TOUCHED' ? 'Touched' : 'Pending'}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
            Sorted by signal time (touch time when available, otherwise cross time). Click Chart to expand the marked SVG.
          </div>

          {evs.length === 0 && <div style={{ color: '#777', padding: 12 }}>No events for the current filter.</div>}

          {evs.map((e) => {
            const key = `${e.symbol}|${e.tf}|${e.crossTime || e.time}|${e.status}`;
            const isUp = e.dir === 'UP';
            return (
              <div key={key} style={{ borderTop: '1px solid #eee', padding: '10px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>
                      {e.symbol} <span style={{ color: '#777', fontWeight: 400 }}>· {e.tf}</span>{' '}
                      <span style={{ color: isUp ? '#089981' : '#f23645' }}>{isUp ? '▲ UP' : '▼ DOWN'}</span>
                      <span style={css.badge(e.status)}>{e.status}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>
                      <strong>Cross:</strong> {fmtDate(e.crossTime || e.time)} · {fmtClock(e.crossTime || e.time)} ·{' '}
                      {(e.crosses || []).map((c) => c.pair).join(' + ')} · {e.crossPrice ?? e.price}
                    </div>
                    {e.touch ? (
                      <div style={{ fontSize: 12, color: '#1967d2', marginTop: 2 }}>
                        <strong>EMA200 touch:</strong> {fmtDate(e.touch.time)} · {fmtClock(e.touch.time)} ·{' '}
                        {e.touch.barsAfterCross} bars after cross · price {e.touch.price} · ema200 {Number(e.touch.ema200).toPrecision(6)}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: '#e65100', marginTop: 2 }}>
                        Still waiting for first EMA200 touch (scanned up to {run?.cfg?.maxTouchBars ?? maxTouchBars} bars)
                      </div>
                    )}
                    {e.status === 'TOUCHED' && (
                      <div style={{ fontSize: 12, marginTop: 2 }}>
                        {e.outcome === 'OPEN' ? (
                          <span style={{ color: '#777' }}>open ({e.barsAvailable} bars so far)</span>
                        ) : (
                          <span style={{ color: e.outcome === 'WIN' ? '#089981' : '#f23645' }}>
                            {e.outcome} {e.retPct}%
                          </span>
                        )}
                        {e.mfePct != null && (
                          <span style={{ color: '#777' }}> · best +{e.mfePct}% / worst −{e.maePct}%</span>
                        )}
                      </div>
                    )}
                  </div>
                  <button type="button" style={css.btn()} onClick={() => setOpen(open === key ? null : key)}>
                    {open === key ? 'Hide' : 'Chart'}
                  </button>
                </div>
                {open === key && e.chartSvg && (
                  <div style={{ marginTop: 10, overflowX: 'auto' }}>
                    <div dangerouslySetInnerHTML={{ __html: e.chartSvg }} />
                  </div>
                )}
                {open === key && !e.chartSvg && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#777' }}>Chart not available for this event.</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
