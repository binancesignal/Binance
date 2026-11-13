'use client';

/**
 * EMA 2 Strategy — Signals-tab card (admin).
 * Triple EMA (20/50/200) cross → first subsequent price touch of EMA200.
 * Pick coins / Top N / All coins, multi-TF scan, TOUCHED + PENDING buckets.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const BUCKETS = [
  ['waiting', 'Waiting'],
  ['entry_ready', 'Touched'],
  ['all', 'All'],
];
const TFS = [
  ['1m', '1M'],
  ['3m', '3M'],
  ['5m', '5M'],
  ['15m', '15M'],
  ['30m', '30M'],
  ['1h', '1H'],
  ['2h', '2H'],
  ['4h', '4H'],
  ['6h', '6H'],
  ['12h', '12H'],
  ['1d', '1D'],
];
const CHUNK = 3;
const GAP_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
const post = (body) => api('/api/ema2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtClock = (t) => {
  const d = new Date(t * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtP = (p) => {
  if (p == null || !Number.isFinite(+p)) return '—';
  const a = Math.abs(+p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6;
  return (+p).toFixed(dp);
};

export function Ema2Panel() {
  const [mode, setMode] = useState('pick');
  const [topN, setTopN] = useState(50);
  const [pick, setPick] = useState('ADA');
  const [tfs, setTfs] = useState(['30m', '1h', '4h']);
  const [bucket, setBucket] = useState('all');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [msg, setMsg] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [crossMode, setCrossMode] = useState('fast');
  const [windowBars, setWindowBars] = useState(5);
  const [maxTouchBars, setMaxTouchBars] = useState(120);
  const [requireApproachSide, setRequireApproachSide] = useState(true);
  const [showSet, setShowSet] = useState(false);
  const stop = useRef(false);

  const toggleTf = (tf) => setTfs((p) => (p.includes(tf) ? p.filter((x) => x !== tf) : [...p, tf]));

  const scan = useCallback(async () => {
    stop.current = false;
    setBusy(true);
    setMsg('');
    setItems([]);
    setOpenKey(null);
    try {
      const u = await post(
        mode === 'pick'
          ? { action: 'universe', symbols: pick }
          : { action: 'universe', mode, topN, ranking: 'volume' }
      );
      const list = u.symbols || [];
      if (!list.length) throw new Error('No matching coins');
      setProgress({ done: 0, total: list.length, current: '' });
      const found = [];
      for (let i = 0; i < list.length; i += CHUNK) {
        if (stop.current) {
          setMsg('Scan stopped.');
          break;
        }
        const chunk = list.slice(i, i + CHUNK);
        setProgress({ done: i, total: list.length, current: chunk.join(', ') });
        let d;
        try {
          d = await post({
            action: 'analyze',
            symbols: chunk,
            tfs,
            includeCharts: true,
            mode: crossMode,
            windowBars,
            maxTouchBars,
            requireApproachSide,
            direction: 'BOTH',
          });
        } catch (e) {
          setMsg(
            e.data?.banned || e.data?.throttled
              ? `Exchange rate-limit: paused at ${chunk[0]} (${e.message})`
              : e.message
          );
          break;
        }
        if (d.stopped) {
          setMsg(`Stopped: ${d.stopped} — ${d.stoppedError || ''}`);
          break;
        }
        for (const r of d.results || []) {
          if (!r.ok) continue;
          for (const x of r.results || []) {
            if (x.error) continue;
            found.push({
              symbol: r.symbol,
              ...x,
            });
          }
        }
        setItems([...found].sort((a, b) => b.time - a.time));
        if (i + CHUNK < list.length) await sleep(GAP_MS);
      }
      setProgress({ done: list.length, total: list.length, current: '' });
      if (!stop.current && !msg) setMsg(`Done · ${found.length} events`);
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  }, [mode, topN, pick, tfs, crossMode, windowBars, maxTouchBars, requireApproachSide, msg]);

  const filtered =
    bucket === 'all'
      ? items
      : items.filter((e) => (bucket === 'waiting' ? e.status === 'PENDING' : e.status === 'TOUCHED'));

  const counts = {
    waiting: items.filter((e) => e.status === 'PENDING').length,
    entry_ready: items.filter((e) => e.status === 'TOUCHED').length,
    all: items.length,
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {[
          ['pick', 'Pick coins'],
          ['top', 'Top N'],
          ['all', 'All coins'],
        ].map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={mode === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setMode(k)}
            style={mode === k ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : undefined}
          >
            {l}
          </button>
        ))}
      </div>

      {mode === 'pick' && (
        <input
          className="form-input"
          style={{ marginBottom: 10 }}
          placeholder="e.g. ADA ETH BTC (space / comma)"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        />
      )}
      {mode === 'top' && (
        <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13 }}>Top N</label>
          <input
            className="form-input"
            type="number"
            min={5}
            max={300}
            value={topN}
            onChange={(e) => setTopN(+e.target.value)}
            style={{ width: 90 }}
          />
        </div>
      )}

      <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.75 }}>Time frames</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {TFS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className={tfs.includes(v) ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => toggleTf(v)}
            style={tfs.includes(v) ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : undefined}
          >
            {l}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <button type="button" className="btn btn-sm" disabled={busy || !tfs.length} onClick={scan}>
          {busy ? 'Scanning…' : 'Scan'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowSet((s) => !s)}>
          Settings
        </button>
        {busy && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { stop.current = true; }}>
            Stop
          </button>
        )}
      </div>

      {showSet && (
        <div style={{ background: 'rgba(128,128,128,0.08)', borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 13 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 8 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>Cross rule</label>
              <select className="form-input" value={crossMode} onChange={(e) => setCrossMode(e.target.value)}>
                <option value="fast">EMA20 crosses 50+200</option>
                <option value="all3">All 3 pairs</option>
                <option value="any2">Any 2 pairs</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>Cross window</label>
              <input className="form-input" type="number" min={1} max={30} value={windowBars} onChange={(e) => setWindowBars(+e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>Max bars to touch</label>
              <input className="form-input" type="number" min={10} max={400} value={maxTouchBars} onChange={(e) => setMaxTouchBars(+e.target.value)} />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireApproachSide} onChange={(e) => setRequireApproachSide(e.target.checked)} />
            Require approach from expected side
          </label>
        </div>
      )}

      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        {CHUNK} coins per request with a short pause (rate-limit safe). Analysis only — no orders.
      </div>

      {progress && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          Progress: {progress.done}/{progress.total}
          {progress.current ? ` · ${progress.current}` : ''}
        </div>
      )}
      {msg && <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.85 }}>{msg}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {BUCKETS.map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={bucket === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setBucket(k)}
            style={bucket === k ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : undefined}
          >
            {l} · {counts[k] || 0}
          </button>
        ))}
      </div>

      {filtered.length === 0 && !busy && (
        <div style={{ fontSize: 13, opacity: 0.65, padding: '8px 0' }}>No setups in the selected stages.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {filtered.map((e) => {
          const key = `${e.symbol}|${e.tf}|${e.crossTime || e.time}|${e.status}`;
          const isUp = e.dir === 'UP';
          const open = openKey === key;
          return (
            <div
              key={key}
              style={{
                border: '1px solid rgba(128,128,128,0.2)',
                borderRadius: 12,
                padding: 12,
                background: open ? 'rgba(37,99,235,0.04)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>
                    {e.symbol.replace(/USDT$/, '')}/USDT · {String(e.tf).toUpperCase()}{' '}
                    <span style={{ color: isUp ? '#16A34A' : '#DC2626' }}>{isUp ? '▲ UP' : '▼ DOWN'}</span>{' '}
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 999,
                        background: e.status === 'TOUCHED' ? '#DBEAFE' : '#FFEDD5',
                        color: e.status === 'TOUCHED' ? '#1D4ED8' : '#C2410C',
                      }}
                    >
                      {e.status === 'TOUCHED' ? 'TOUCHED' : 'WAITING'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 3 }}>
                    <b>Cross:</b> {fmtDate(e.crossTime || e.time)} {fmtClock(e.crossTime || e.time)} ·{' '}
                    {(e.crosses || []).map((c) => c.pair).join(' + ') || '—'} · {fmtP(e.crossPrice)}
                  </div>
                  {e.touch ? (
                    <div style={{ fontSize: 12, color: '#1D4ED8', marginTop: 2 }}>
                      <b>EMA200 touch:</b> {fmtDate(e.touch.time)} {fmtClock(e.touch.time)} · {e.touch.barsAfterCross}{' '}
                      bars later · {fmtP(e.touch.price)}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#C2410C', marginTop: 2 }}>
                      Waiting for first EMA200 touch after the cross
                    </div>
                  )}
                  {e.status === 'TOUCHED' && e.outcome && e.outcome !== 'OPEN' && (
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      Outcome:{' '}
                      <span style={{ color: e.outcome === 'WIN' ? '#16A34A' : '#DC2626' }}>
                        {e.outcome} {e.retPct != null ? `${e.retPct}%` : ''}
                      </span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setOpenKey(open ? null : key)}
                >
                  {open ? 'Hide' : 'Chart'}
                </button>
              </div>
              {open && e.chartSvg && (
                <div style={{ marginTop: 10, overflowX: 'auto' }} dangerouslySetInnerHTML={{ __html: e.chartSvg }} />
              )}
              {open && !e.chartSvg && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}>Chart not available.</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Ema2Card() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem('ema2_card_open');
      if (v === '0') setOpen(false);
      if (v === '1') setOpen(true);
    } catch (_) {}
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem('ema2_card_open', o ? '0' : '1');
      } catch (_) {}
      return !o;
    });

  return (
    <div className="sg-results" style={{ marginBottom: 14 }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          textAlign: 'left',
          background: 'none',
          border: 0,
          padding: 0,
          cursor: 'pointer',
          color: 'inherit',
        }}
        aria-expanded={open}
      >
        <span>
          <span className="sg-results-title" style={{ display: 'block' }}>
            EMA 2 Strategy
          </span>
          <span className="sg-results-sub" style={{ display: 'block' }}>
            EMA 20 / 50 / 200 triple cross → first EMA200 touch · Waiting / Touched
          </span>
        </span>
        <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>
          {open ? 'Hide' : 'Open'}
        </span>
      </button>
      {open && <Ema2Panel />}
    </div>
  );
}

export default Ema2Card;
