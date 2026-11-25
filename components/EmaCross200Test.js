'use client';

import { useEffect, useRef, useState } from 'react';

const TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
const STORE_KEY = 'ec200_last_scan_v1';
const MAX_KEEP = 1500;
const CHUNK = 6; // coins per request
const GAP_MS = 1500; // pause between requests → far below Binance weight limits

const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtP = (p) => {
  if (p == null || !Number.isFinite(+p)) return '—';
  const a = Math.abs(+p);
  return (+p).toFixed(a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (e) => `${e.symbol}|${e.tf}|${e.time}|${e.dir}`;

function tally(list) {
  const t = { n: list.length, win: 0, loss: 0, open: 0, ret: 0, rn: 0 };
  for (const e of list) {
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
}

const ZONE_TEXT = { ABOVE_200: 'cross above EMA200', BELOW_200: 'cross below EMA200', ON_200: 'cross on EMA200' };
const TOUCH_TEXT = { BODY: 'body', WICK_LOW: 'lower wick', WICK_HIGH: 'upper wick' };

export default function EmaCross200Test() {
  const [tfs, setTfs] = useState(['15m', '1h', '4h']);
  const [direction, setDirection] = useState('BOTH');
  const [tol, setTol] = useState(0);
  const [maxAge, setMaxAge] = useState(300);
  const [perCoin, setPerCoin] = useState(6);
  const [forward, setForward] = useState(20);
  const [symbol, setSymbol] = useState('');
  const [events, setEvents] = useState([]);
  const [prog, setProg] = useState(null); // { running, offset, total, note }
  const [errors, setErrors] = useState([]);
  const [tfFilter, setTfFilter] = useState('ALL');
  const [dirFilter, setDirFilter] = useState('ALL');
  const [open, setOpen] = useState(null);
  const stop = useRef(false);
  const cfgRef = useRef(null);

  // restore the last scan (survives a page refresh)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.events)) setEvents(d.events);
      if (d.cfg) cfgRef.current = d.cfg;
      if (d.prog) setProg({ ...d.prog, running: false });
    } catch (_) {}
  }, []);

  const persist = (evs, cfg, p) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ events: evs.slice(0, MAX_KEEP), cfg, prog: p, at: Date.now() }));
    } catch (_) {}
  };

  const body = (extra = {}) => ({
    timeframes: tfs,
    direction,
    touchTolerancePct: +tol || 0,
    maxAgeBars: +maxAge || 300,
    maxPerCoin: +perCoin || 6,
    forwardBars: +forward || 20,
    ...extra,
  });

  async function call(extra) {
    const res = await fetch('/api/backtest/ema-cross-200', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body(extra)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function scan(single) {
    if (!tfs.length) return;
    const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (single && !sym) return;
    stop.current = false;
    setOpen(null);
    setErrors([]);
    const map = new Map();
    const cfg = body();
    cfgRef.current = cfg;
    setEvents([]);
    let offset = 0;
    let total = 0;
    let throttleHits = 0;
    const errs = [];
    setProg({ running: true, offset: 0, total: 0, note: '' });
    try {
      while (!stop.current) {
        const data = await call(single ? { symbol: sym } : { offset, limit: CHUNK });
        total = data.total;
        for (const e of data.events || []) map.set(keyOf(e), e);
        errs.push(...(data.errors || []));
        const list = [...map.values()];
        setEvents(list);
        setErrors(errs.slice(0, 8));
        offset = data.nextOffset;
        setProg({ running: true, offset, total, note: '' });
        if (data.banned) {
          errs.push('Binance ban / rate limit — stopped early to stay safe');
          setErrors(errs.slice(0, 8));
          break;
        }
        if (data.throttled) {
          throttleHits += 1;
          if (throttleHits > 6) {
            errs.push('Rate guard kept pausing the scan — stopped. Run again in a minute.');
            break;
          }
          setProg({ running: true, offset, total, note: 'Rate guard: waiting 40s so Binance is never overloaded…' });
          await sleep(40_000);
          continue;
        }
        if (data.done) {
          setProg({ running: false, offset: total, total, done: true, note: '' });
          persist([...map.values()], cfg, { offset: total, total, done: true });
          return;
        }
        persist([...map.values()], cfg, { offset, total, done: false });
        await sleep(GAP_MS);
      }
    } catch (e) {
      errs.push(e.message);
      setErrors(errs.slice(0, 8));
    }
    setProg((p) => ({ ...(p || {}), running: false, note: stop.current ? 'Stopped' : '' }));
    persist([...map.values()], cfg, { offset, total, done: false });
  }

  const clearAll = () => {
    setEvents([]);
    setProg(null);
    setErrors([]);
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (_) {}
  };

  const running = !!prog?.running;
  const shown = events
    .filter((e) => (tfFilter === 'ALL' || e.tf === tfFilter) && (dirFilter === 'ALL' || e.dir === dirFilter))
    .sort((a, b) => b.time - a.time);
  const all = tally(shown);
  const up = tally(shown.filter((e) => e.dir === 'UP'));
  const down = tally(shown.filter((e) => e.dir === 'DOWN'));
  const fb = cfgRef.current?.forwardBars ?? forward;
  const tzMin = -new Date().getTimezoneOffset();
  const chartUrl = (e) =>
    `/api/backtest/ema-cross-200/chart?symbol=${e.symbol}&tf=${e.tf}&time=${e.time}` +
    `&tolerance=${cfgRef.current?.touchTolerancePct ?? tol}&forwardBars=${fb}&tz=${tzMin}`;
  const tfsInResults = [...new Set(events.map((e) => e.tf))];

  return (
    <div style={{ border: '1px solid rgba(37,99,235,0.35)', borderRadius: 12, padding: 12, marginBottom: 14, background: 'rgba(37,99,235,0.04)' }}>
      <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>EMA 20/50 cross + EMA 200 touch — test scan</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10, lineHeight: 1.5 }}>
        Not a harmonic pattern. Finds past (formed) EMA20/EMA50 crosses where the candle on the cross line
        touched the <b>same time frame&apos;s EMA200</b>. Scans every USDT-perp coin in small chunks.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {TFS.map((t) => {
          const on = tfs.includes(t);
          return (
            <button
              key={t}
              type="button"
              className={on ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => setTfs((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}
              style={on ? { background: '#2563EB', borderColor: '#2563EB', color: '#fff' } : undefined}
            >
              {t}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8, marginBottom: 10, fontSize: 12 }}>
        <label>Cross direction
          <select className="form-input" value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="BOTH">Both</option>
            <option value="UP">▲ EMA20 up through 50</option>
            <option value="DOWN">▼ EMA20 down through 50</option>
          </select>
        </label>
        <label>EMA200 touch tolerance %
          <input className="form-input" type="number" step="0.05" min="0" max="2" value={tol} onChange={(e) => setTol(e.target.value)} />
        </label>
        <label>History (bars)
          <input className="form-input" type="number" min="5" max="900" value={maxAge} onChange={(e) => setMaxAge(e.target.value)} />
        </label>
        <label>Newest per coin/TF
          <input className="form-input" type="number" min="1" max="50" value={perCoin} onChange={(e) => setPerCoin(e.target.value)} />
        </label>
        <label>Look-ahead (bars)
          <input className="form-input" type="number" min="3" max="200" value={forward} onChange={(e) => setForward(e.target.value)} />
        </label>
        <label>Single coin
          <input className="form-input" placeholder="AINUSDT" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <button type="button" className="btn btn-sm" disabled={running || !tfs.length} onClick={() => scan(false)} style={{ background: '#2563EB', borderColor: '#2563EB', color: '#fff', fontWeight: 700 }}>
          {running ? 'Scanning…' : 'Scan all coins'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={running || !symbol || !tfs.length} onClick={() => scan(true)}>Check coin</button>
        {running && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { stop.current = true; }}>Stop</button>}
        {!!events.length && !running && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll} style={{ borderColor: '#DC2626', color: '#B91C1C' }}>Clear results</button>
        )}
      </div>

      {prog && (
        <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.85 }}>
          {running ? `Scanning ${prog.offset}/${prog.total || '?'} coins` : prog.done ? `Done · ${prog.total} coins` : prog.note || 'Stopped'}
          {' · '}{events.length} events
          {prog.note && running ? ` · ${prog.note}` : ''}
          {!running && prog.total ? <span style={{ opacity: 0.7 }}> · results are kept after a page refresh</span> : null}
        </div>
      )}
      {!!errors.length && (
        <div style={{ color: '#DC2626', fontSize: 12, marginBottom: 8, maxHeight: 70, overflow: 'auto' }}>
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {!!events.length && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {['ALL', ...tfsInResults].map((t) => (
              <button key={t} type="button" className={tfFilter === t ? 'btn btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setTfFilter(t)}
                style={tfFilter === t ? { background: '#2563EB', borderColor: '#2563EB', color: '#fff' } : undefined}>
                {t === 'ALL' ? 'All TF' : t}
              </button>
            ))}
            {[['ALL', 'Both'], ['UP', '▲ Up'], ['DOWN', '▼ Down']].map(([k, l]) => (
              <button key={k} type="button" className={dirFilter === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setDirFilter(k)}
                style={dirFilter === k ? { background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' } : undefined}>
                {l}
              </button>
            ))}
          </div>

          <div style={{ overflowX: 'auto', marginBottom: 6 }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(128,128,128,0.35)' }}>
                  {['', 'N', 'Win', 'Loss', 'Open', 'WR %', `Avg ${fb}b %`].map((h) => <th key={h} style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {[['All', all], ['▲ Up', up], ['▼ Down', down]].map(([l, t]) => (
                  <tr key={l}>
                    <td style={{ padding: '4px 8px' }}>{l}</td>
                    <td style={{ padding: '4px 8px' }}>{t.n}</td>
                    <td style={{ padding: '4px 8px', color: '#089981' }}>{t.win}</td>
                    <td style={{ padding: '4px 8px', color: '#f23645' }}>{t.loss}</td>
                    <td style={{ padding: '4px 8px' }}>{t.open}</td>
                    <td style={{ padding: '4px 8px', fontWeight: 700 }}>{t.wr}</td>
                    <td style={{ padding: '4px 8px' }}>{t.avg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 10 }}>
            WIN = after {fb} bars price is beyond the close of the bar where the cross was confirmed, in the cross direction
            (▲ higher, ▼ lower). Times are your local time.
          </div>

          {shown.slice(0, 200).map((e) => {
            const key = keyOf(e);
            const isUp = e.dir === 'UP';
            return (
              <div key={key} style={{ borderTop: '1px solid rgba(128,128,128,0.25)', padding: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>
                      {e.symbol.replace(/USDT$/, '')}<small style={{ opacity: 0.6 }}>/USDT</small>{' '}
                      <span style={{ opacity: 0.65, fontWeight: 400 }}>· {e.tf}</span>{' '}
                      <span style={{ color: isUp ? '#089981' : '#f23645' }}>{isUp ? '▲ EMA20 up' : '▼ EMA20 down'}</span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      {fmtLocal(e.time)} · {e.barsAgo} bars ago · touched EMA200 {fmtP(e.ema200)} with {TOUCH_TEXT[e.touchKind] || e.touchKind}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      candle {fmtP(e.candle.low)}–{fmtP(e.candle.high)} · {ZONE_TEXT[e.zone] || e.zone} ({e.crossVsEma200Pct}%) · price now {fmtP(e.price)}
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {e.outcome === 'OPEN'
                        ? <span style={{ opacity: 0.7 }}>open ({e.barsAvailable} bars so far)</span>
                        : <span style={{ color: e.outcome === 'WIN' ? '#089981' : '#f23645', fontWeight: 600 }}>{e.outcome} {e.retPct}%</span>}
                      <span style={{ opacity: 0.7 }}> · best +{e.mfePct}% / worst −{e.maePct}% · since cross {e.movedPct > 0 ? '+' : ''}{e.movedPct}%</span>
                    </div>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(open === key ? null : key)}>
                    {open === key ? 'Hide' : 'Chart'}
                  </button>
                </div>
                {open === key && (
                  <div style={{ marginTop: 8 }}>
                    <img src={chartUrl(e)} alt={`${e.symbol} ${e.tf}`} style={{ width: '100%', borderRadius: 8, border: '1px solid rgba(128,128,128,0.25)', background: '#fff' }} />
                    <a href={chartUrl(e)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>open full size</a>
                  </div>
                )}
              </div>
            );
          })}
          {shown.length > 200 && <div style={{ fontSize: 12, opacity: 0.7, paddingTop: 6 }}>Showing newest 200 of {shown.length} — use the filters above to narrow.</div>}
          {!shown.length && <div style={{ fontSize: 12, opacity: 0.7 }}>No events match these filters.</div>}
        </>
      )}
      {!events.length && prog && !running && prog.done && (
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          No coin matched. Try a bigger touch tolerance (e.g. 0.1%), more history bars, or more time frames.
        </div>
      )}
    </div>
  );
}
