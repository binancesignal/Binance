'use client';

/**
 * Head & Shoulders strategy — Signals-tab card (admin).
 * Classic + Inverse H&S, optional “formed above EMA200” filter,
 * Pick / Top N / All coins, multi-TF scan, chart with LS / Head / RS / neckline.
 * More patterns can be added later under this same card.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const BUCKETS = [
  ['all', 'All'],
  ['formed', 'Formed'],
  ['waiting', 'At neck'],
  ['entry_ready', 'Breakout'],
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
const post = (body) =>
  api('/api/head-shoulders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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

export function HeadShouldersPanel() {
  const [mode, setMode] = useState('pick');
  const [topN, setTopN] = useState(50);
  const [pick, setPick] = useState('SOL');
  const [tfs, setTfs] = useState(['3m', '15m', '1h']);
  const [bucket, setBucket] = useState('all');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [msg, setMsg] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [requireAboveEma, setRequireAboveEma] = useState(false);
  const [includeInverse, setIncludeInverse] = useState(true);
  const [includeClassic, setIncludeClassic] = useState(true);
  const [minHeightAtr, setMinHeightAtr] = useState(0.9);
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
            requireAboveEma,
            includeInverse,
            includeClassic,
            minHeightAtr,
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
            found.push({ symbol: r.symbol, ...x });
          }
        }
        setItems([...found].sort((a, b) => b.time - a.time));
        if (i + CHUNK < list.length) await sleep(GAP_MS);
      }
      setProgress({ done: list.length, total: list.length, current: '' });
      if (!stop.current) setMsg(`Done · ${found.length} patterns`);
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  }, [mode, topN, pick, tfs, requireAboveEma, includeInverse, includeClassic, minHeightAtr]);

  const filtered =
    bucket === 'all'
      ? items
      : items.filter((e) => {
          if (bucket === 'formed') return e.status === 'FORMED';
          if (bucket === 'waiting') return e.status === 'AT_NECK';
          if (bucket === 'entry_ready') return e.status === 'BREAKOUT';
          return true;
        });

  const counts = {
    all: items.length,
    formed: items.filter((e) => e.status === 'FORMED').length,
    waiting: items.filter((e) => e.status === 'AT_NECK').length,
    entry_ready: items.filter((e) => e.status === 'BREAKOUT').length,
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
          placeholder="e.g. SOL ADA ETH (space / comma)"
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              stop.current = true;
            }}
          >
            Stop
          </button>
        )}
      </div>

      {showSet && (
        <div style={{ background: 'rgba(128,128,128,0.08)', borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 13 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireAboveEma} onChange={(e) => setRequireAboveEma(e.target.checked)} />
            Only patterns formed <b>above EMA200</b>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeClassic} onChange={(e) => setIncludeClassic(e.target.checked)} />
            Classic Head &amp; Shoulders (short)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeInverse} onChange={(e) => setIncludeInverse(e.target.checked)} />
            Inverse Head &amp; Shoulders (long)
          </label>
          <div style={{ marginTop: 6 }}>
            <label style={{ fontSize: 11, opacity: 0.7 }}>Min height (ATR)</label>
            <input
              className="form-input"
              type="number"
              step="0.1"
              min={0.3}
              max={5}
              value={minHeightAtr}
              onChange={(e) => setMinHeightAtr(+e.target.value)}
              style={{ width: 100 }}
            />
          </div>
          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.65 }}>
            Later: Double Top / Bottom and other classic patterns can be added to this same card.
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        {CHUNK} coins per request · analysis only — no orders. Chart draws LS · Head · RS · neckline · EMA200.
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
          const key = `${e.symbol}|${e.tf}|${e.time}|${e.patternType}|${e.status}`;
          const isLong = e.direction === 'LONG';
          const open = openKey === key;
          const kind = e.patternType === 'INVERSE_HEAD_AND_SHOULDERS' ? 'Inverse H&S' : 'Head & Shoulders';
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
                    <span style={{ color: isLong ? '#16A34A' : '#DC2626' }}>{isLong ? '▲ LONG' : '▼ SHORT'}</span>{' '}
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 999,
                        background:
                          e.status === 'BREAKOUT' ? '#DBEAFE' : e.status === 'AT_NECK' ? '#FEF3C7' : '#F3F4F6',
                        color: e.status === 'BREAKOUT' ? '#1D4ED8' : e.status === 'AT_NECK' ? '#B45309' : '#374151',
                      }}
                    >
                      {e.status}
                    </span>
                    {e.aboveEma && (
                      <span
                        style={{
                          marginLeft: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 7px',
                          borderRadius: 999,
                          background: '#E0E7FF',
                          color: '#3730A3',
                        }}
                      >
                        Above EMA200
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 3 }}>
                    <b>{kind}</b> · conf {e.confidence} · RS {fmtDate(e.rs?.time || e.time)} {fmtClock(e.rs?.time || e.time)}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    LS {fmtP(e.ls?.price)} · Head {fmtP(e.head?.price)} · RS {fmtP(e.rs?.price)} · Neck{' '}
                    {fmtP(e.neckline?.atRs)} · Target {fmtP(e.target)}
                  </div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpenKey(open ? null : key)}>
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

export function HeadShouldersCard() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem('hs_card_open');
      if (v === '0') setOpen(false);
      if (v === '1') setOpen(true);
    } catch (_) {}
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem('hs_card_open', o ? '0' : '1');
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
            Head &amp; Shoulders Patterns
          </span>
          <span className="sg-results-sub" style={{ display: 'block' }}>
            Classic + Inverse H&amp;S · neckline · optional above EMA200 · chart with LS / Head / RS
          </span>
        </span>
        <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>
          {open ? 'Hide' : 'Open'}
        </span>
      </button>
      {open && <HeadShouldersPanel />}
    </div>
  );
}

export default HeadShouldersCard;
