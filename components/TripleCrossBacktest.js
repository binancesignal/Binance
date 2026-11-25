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
};

const css = {
  page: { background: '#F4F5F7', minHeight: '100vh', padding: 12, fontFamily: 'system-ui, Arial, sans-serif', color: '#111' },
  card: { background: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,.06)' },
  label: { fontSize: 12, color: '#555', marginBottom: 4, display: 'block' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #d5d9e0', borderRadius: 8, fontSize: 14, background: '#fff', color: '#111' },
  chip: (on) => ({ padding: '6px 12px', borderRadius: 16, border: '1px solid ' + (on ? '#2962ff' : '#d5d9e0'), background: on ? '#2962ff' : '#fff', color: on ? '#fff' : '#333', fontSize: 13, cursor: 'pointer' }),
  btn: (kind) => ({ padding: '10px 16px', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', background: kind === 'primary' ? '#2962ff' : '#e6e9ef', color: kind === 'primary' ? '#fff' : '#222' }),
};

export default function TripleCrossBacktest({ embedded = false }) {
  const [tfs, setTfs] = useState(['15m', '1h']);
  const [direction, setDirection] = useState('BOTH');
  const [mode, setMode] = useState('fast');
  const [windowBars, setWindowBars] = useState(5);
  const [forwardBars, setForwardBars] = useState(20);
  const [universe, setUniverse] = useState(100);
  const [symbol, setSymbol] = useState('');
  const [requireAbcd, setRequireAbcd] = useState(false);
  const [run, setRun] = useState(null);
  const [open, setOpen] = useState(null); // key of row with chart expanded
  const stop = useRef(false);

  const body = (extra = {}) => ({
    timeframes: tfs, direction, mode, windowBars, forwardBars, universe, requireAbcd, ...extra,
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
        const res = await fetch('/api/backtest/ema-triple-cross', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(single ? { symbol: sym } : { offset, limit: 8 })),
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

  const evs = (run?.events || []).slice().sort((a, b) => b.time - a.time);
  const tzMin = -new Date().getTimezoneOffset();
  const chartUrl = (e) =>
    `/api/backtest/ema-triple-cross/chart?symbol=${e.symbol}&tf=${e.tf}&time=${e.time}` +
    `&windowBars=${run?.cfg?.windowBars ?? windowBars}&mode=${run?.cfg?.mode ?? mode}` +
    `&forwardBars=${run?.cfg?.forwardBars ?? forwardBars}&requireAbcd=${run?.cfg?.requireAbcd ?? requireAbcd}&tz=${tzMin}`;
  const all = tallyOf(evs);
  const up = tallyOf(evs.filter((e) => e.dir === 'UP'));
  const down = tallyOf(evs.filter((e) => e.dir === 'DOWN'));
  const withAbcd = tallyOf(evs.filter((e) => e.abcd));
  const fb = run?.cfg?.forwardBars ?? forwardBars;

  return (
    <div style={embedded ? { fontFamily: 'inherit', color: 'inherit' } : css.page}>
      <h2 style={{ margin: '4px 0 10px', fontSize: 18 }}>EMA 20 / 50 / 200 — Triple Cross Scan &amp; Backtest</h2>

      <div style={css.card}>
        <span style={css.label}>Time frames</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {TFS.map((t) => (
            <button key={t} type="button" style={css.chip(tfs.includes(t))}
              onClick={() => setTfs((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}>{t}</button>
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
            <label style={css.label}>Window (bars)</label>
            <input style={css.input} type="number" min={1} max={30} value={windowBars} onChange={(e) => setWindowBars(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Look-ahead (bars)</label>
            <input style={css.input} type="number" min={3} max={100} value={forwardBars} onChange={(e) => setForwardBars(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Universe (top N volume)</label>
            <input style={css.input} type="number" min={5} max={300} value={universe} onChange={(e) => setUniverse(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Single coin</label>
            <input style={css.input} placeholder="AINUSDT" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </div>
          <div>
            <label style={css.label}>AB=CD filter</label>
            <button
              type="button"
              style={css.chip(requireAbcd)}
              onClick={() => setRequireAbcd((v) => !v)}
              title="Only keep triple crosses that sit inside a completed AB=CD harmonic (cross inside AB or CD leg)"
            >
              {requireAbcd ? 'ON · require AB=CD' : 'OFF · any triple cross'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={css.btn('primary')} disabled={run?.running || !tfs.length} onClick={() => scan(false)}>
            {run?.running ? 'Scanning…' : 'Scan all'}
          </button>
          <button type="button" style={css.btn()} disabled={run?.running || !symbol} onClick={() => scan(true)}>Check coin</button>
          {run?.running && <button type="button" style={css.btn()} onClick={() => { stop.current = true; }}>Stop</button>}
        </div>
      </div>

      {run && (
        <div style={css.card}>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
            {run.running ? `Running… ${run.offset || 0}/${run.total || '?'} coins` : run.done ? `Done · ${run.total} coins` : 'Stopped'}
            {' · '}{evs.length} events · {(run.tfs || []).join(', ')}
          </div>
          {!!run.errors?.length && (
            <div style={{ color: '#f6465d', fontSize: 12, marginBottom: 8, maxHeight: 80, overflow: 'auto' }}>
              {run.errors.slice(0, 8).map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                  {['', 'N', 'Win', 'Loss', 'Open', 'WR %', `Avg ret ${fb}b %`].map((h) => <th key={h} style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {[['All', all], ['▲ UP', up], ['▼ DOWN', down], ['AB=CD', withAbcd]].map(([l, t]) => (
                  <tr key={l}>
                    <td style={{ padding: '4px 8px' }}>{l}</td><td style={{ padding: '4px 8px' }}>{t.n}</td>
                    <td style={{ padding: '4px 8px', color: '#089981' }}>{t.win}</td>
                    <td style={{ padding: '4px 8px', color: '#f23645' }}>{t.loss}</td>
                    <td style={{ padding: '4px 8px' }}>{t.open}</td>
                    <td style={{ padding: '4px 8px', fontWeight: 600 }}>{t.wr}</td>
                    <td style={{ padding: '4px 8px' }}>{t.avg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: '#777', marginBottom: 10 }}>
            WIN = price moved in the cross direction after {fb} bars (UP → higher, DOWN → lower). Return is measured from the close of the bar where the cross completed. Times shown in your local time.
            {requireAbcd || run?.cfg?.requireAbcd
              ? ' AB=CD filter is ON: keeps crosses inside a completed measured move (AB=CD, 1.272, 1.414, 1.618, 0.786, 0.618).'
              : ' Turn on “AB=CD filter” for classic + alternate measured moves (1.0 / 1.272 / 1.414 / 1.618 / 0.786 / 0.618 × AB = CD).'}
          </div>

          {evs.map((e) => {
            const key = `${e.symbol}|${e.tf}|${e.time}`;
            const isUp = e.dir === 'UP';
            return (
              <div key={key} style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {e.symbol} <span style={{ color: '#777', fontWeight: 400 }}>· {e.tf}</span>{' '}
                      <span style={{ color: isUp ? '#089981' : '#f23645' }}>{isUp ? '▲ UP' : '▼ DOWN'}</span>
                      {e.abcd && (
                        <span style={{ marginLeft: 6, fontSize: 11, padding: '2px 6px', borderRadius: 6, background: e.abcd.dir === 'UP' ? '#e6f7f0' : '#fde8eb', color: e.abcd.dir === 'UP' ? '#089981' : '#f23645' }}>
                          {e.abcd.label || e.abcd.family || 'AB=CD'} {e.abcd.dir} · {e.abcd.crossIn}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#555' }}>
                      {fmtDate(e.time)} · {fmtClock(e.time)} · {(e.crosses || []).map((c) => c.pair).join(' + ')} · {e.price}
                      {e.abcd?.ratios && (
                        <span> · CD/AB {e.abcd.ratios.cdAb} (tgt {e.abcd.ratios.target ?? e.abcd.target ?? '—'}) · BC {e.abcd.ratios.bc}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12 }}>
                      {e.outcome === 'OPEN' ? <span style={{ color: '#777' }}>open ({e.barsAvailable} bars so far)</span>
                        : <span style={{ color: e.outcome === 'WIN' ? '#089981' : '#f23645' }}>{e.outcome} {e.retPct}%</span>}
                      <span style={{ color: '#777' }}> · best +{e.mfePct}% / worst −{e.maePct}%</span>
                    </div>
                  </div>
                  <button type="button" style={css.btn()} onClick={() => setOpen(open === key ? null : key)}>
                    {open === key ? 'Hide' : 'Chart'}
                  </button>
                </div>
                {open === key && (
                  <div style={{ marginTop: 8 }}>
                    <img src={chartUrl(e)} alt={`${e.symbol} ${e.tf}`} style={{ width: '100%', borderRadius: 8, border: '1px solid #eee' }} />
                    <a href={chartUrl(e)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>open full size</a>
                  </div>
                )}
              </div>
            );
          })}
          {!evs.length && !run.running && (
            <div style={{ color: '#777', fontSize: 13 }}>
              No events found. Try a wider window, the &quot;Any 2 pairs&quot; rule
              {(requireAbcd || run?.cfg?.requireAbcd) ? ', or turn off the AB=CD filter' : ''}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
