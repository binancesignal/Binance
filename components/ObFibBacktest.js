'use client';

import { useRef, useState } from 'react';

const LTFS = ['5m', '15m', '30m', '1h', '2h', '4h'];
const REFS = [
  ['1d', 'Daily'],
  ['1w', 'Weekly'],
  ['1M', 'Month'],
  ['3M', '3M'],
  ['1Y', 'Year'],
];

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const tallyOf = (list) => {
  const t = { n: list.length, win: 0, loss: 0, timeout: 0, open: 0, ret: 0, rn: 0 };
  for (const e of list) {
    if (e.outcome === 'WIN') t.win++;
    else if (e.outcome === 'LOSS') t.loss++;
    else if (e.outcome === 'TIMEOUT') t.timeout++;
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
  chip: (on) => ({
    padding: '6px 12px',
    borderRadius: 16,
    border: '1px solid ' + (on ? '#2962ff' : '#d5d9e0'),
    background: on ? '#2962ff' : '#fff',
    color: on ? '#fff' : '#333',
    fontSize: 13,
    cursor: 'pointer',
  }),
  btn: (kind) => ({
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    background: kind === 'primary' ? '#2962ff' : '#e6e9ef',
    color: kind === 'primary' ? '#fff' : '#222',
  }),
  pill: (ok) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    background: ok === 'WIN' ? '#d1fae5' : ok === 'LOSS' ? '#fee2e2' : '#f3f4f6',
    color: ok === 'WIN' ? '#065f46' : ok === 'LOSS' ? '#991b1b' : '#374151',
  }),
};

export default function ObFibBacktest({ embedded = false }) {
  const [ltfs, setLtfs] = useState(['15m', '1h']);
  const [refs, setRefs] = useState(['1w', '1M']);
  const [direction, setDirection] = useState('BOTH');
  const [maxBars, setMaxBars] = useState(80);
  const [universe, setUniverse] = useState(50);
  const [symbol, setSymbol] = useState('');
  const [entryMode, setEntryMode] = useState('mid'); // mid = OB mid (entry from OB)
  const [run, setRun] = useState(null);
  const stop = useRef(false);

  const body = (extra = {}) => ({
    timeframes: ltfs,
    refTimeframes: refs,
    direction,
    maxBars,
    universe,
    entryMode,
    ...extra,
  });

  async function scan(single) {
    if (!ltfs.length || !refs.length) return;
    const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (single && !sym) return;
    stop.current = false;
    const acc = {
      events: [],
      errors: [],
      total: 0,
      offset: 0,
      done: false,
      running: true,
      ltfs: [...ltfs],
      refs: [...refs],
      cfg: body(),
    };
    setRun({ ...acc });
    let offset = 0;
    try {
      while (!stop.current) {
        const res = await fetch('/api/backtest/ob-fib', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(single ? { symbol: sym } : { offset, limit: 5 })),
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
  const all = tallyOf(evs);
  const longs = tallyOf(evs.filter((e) => e.dir === 'LONG'));
  const shorts = tallyOf(evs.filter((e) => e.dir === 'SHORT'));

  return (
    <div style={embedded ? { fontFamily: 'inherit', color: 'inherit' } : css.page}>
      <h2 style={{ margin: '4px 0 10px', fontSize: 18 }}>OB + HTF Fib — Backtest</h2>
      <p style={{ fontSize: 13, color: '#555', marginTop: 0, marginBottom: 12 }}>
        Entry = OB zone mid · SL = OB band එකට පිටින් (bullish OB යටින් / bearish OB උඩින්) · TP1 = 1R
      </p>

      <div style={css.card}>
        <span style={css.label}>Fib time frames (HTF)</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {REFS.map(([v, l]) => (
            <button
              key={v}
              type="button"
              style={css.chip(refs.includes(v))}
              onClick={() => setRefs((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))}
            >
              {l}
            </button>
          ))}
        </div>

        <span style={css.label}>LTF (Order Block)</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {LTFS.map((t) => (
            <button
              key={t}
              type="button"
              style={css.chip(ltfs.includes(t))}
              onClick={() => setLtfs((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}
            >
              {t}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={css.label}>Direction</label>
            <select style={css.input} value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="BOTH">Both (long + short)</option>
              <option value="LONG">Long only</option>
              <option value="SHORT">Short only</option>
            </select>
          </div>
          <div>
            <label style={css.label}>Entry</label>
            <select style={css.input} value={entryMode} onChange={(e) => setEntryMode(e.target.value)}>
              <option value="mid">OB mid (entry from OB)</option>
              <option value="fib">Matched Fib price</option>
            </select>
          </div>
          <div>
            <label style={css.label}>Max bars to TP/SL</label>
            <input style={css.input} type="number" min={10} max={200} value={maxBars} onChange={(e) => setMaxBars(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Universe (top N volume)</label>
            <input style={css.input} type="number" min={5} max={200} value={universe} onChange={(e) => setUniverse(+e.target.value)} />
          </div>
          <div>
            <label style={css.label}>Single coin</label>
            <input style={css.input} placeholder="BTCUSDT / LTC …" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={css.btn('primary')} disabled={run?.running || !ltfs.length || !refs.length} onClick={() => scan(false)}>
            {run?.running ? 'Scanning…' : 'Scan all'}
          </button>
          <button type="button" style={css.btn()} disabled={run?.running || !symbol} onClick={() => scan(true)}>
            Check coin
          </button>
          {run?.running && (
            <button type="button" style={css.btn()} onClick={() => { stop.current = true; }}>
              Stop
            </button>
          )}
        </div>
      </div>

      {run && (
        <div style={css.card}>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
            {run.running ? `Running… ${run.offset || 0}/${run.total || '?'} coins` : run.done ? `Done · ${run.total} coins` : 'Stopped'}
            {' · '}
            {evs.length} trades · LTF {(run.ltfs || []).join(', ')} · Fib {(run.refs || []).join(', ')}
          </div>
          {!!run.errors?.length && (
            <div style={{ color: '#f6465d', fontSize: 12, marginBottom: 8, maxHeight: 80, overflow: 'auto' }}>
              {run.errors.slice(0, 10).map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}

          {/* Percentage summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 10, marginBottom: 14 }}>
            {[
              ['All', all],
              ['Long', longs],
              ['Short', shorts],
            ].map(([label, t]) => (
              <div key={label} style={{ background: '#f8fafc', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#64748b' }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{t.wr}%</div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {t.win}W / {t.loss}L · n={t.n}
                  {t.timeout ? ` · ${t.timeout} TO` : ''}
                </div>
                <div style={{ fontSize: 12 }}>avg {t.avg}%</div>
              </div>
            ))}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                  <th style={{ padding: '6px 8px' }}>Time</th>
                  <th style={{ padding: '6px 8px' }}>Symbol</th>
                  <th style={{ padding: '6px 8px' }}>Dir</th>
                  <th style={{ padding: '6px 8px' }}>TF</th>
                  <th style={{ padding: '6px 8px' }}>Fib</th>
                  <th style={{ padding: '6px 8px' }}>Entry</th>
                  <th style={{ padding: '6px 8px' }}>SL</th>
                  <th style={{ padding: '6px 8px' }}>TP1</th>
                  <th style={{ padding: '6px 8px' }}>Result</th>
                  <th style={{ padding: '6px 8px' }}>Ret%</th>
                  <th style={{ padding: '6px 8px' }}>Bars</th>
                </tr>
              </thead>
              <tbody>
                {evs.slice(0, 200).map((e, i) => (
                  <tr key={`${e.symbol}-${e.time}-${e.tf}-${e.refTf}-${i}`} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtDate(e.time)}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{e.symbol}</td>
                    <td style={{ padding: '6px 8px', color: e.dir === 'LONG' ? '#059669' : '#dc2626' }}>{e.dir}</td>
                    <td style={{ padding: '6px 8px' }}>{e.tf} / {e.refLabel || e.refTf}</td>
                    <td style={{ padding: '6px 8px' }}>{e.fibRatio}</td>
                    <td style={{ padding: '6px 8px' }}>{e.entry}</td>
                    <td style={{ padding: '6px 8px' }}>{e.sl}</td>
                    <td style={{ padding: '6px 8px' }}>{e.tp1}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={css.pill(e.outcome)}>{e.outcome}</span>
                    </td>
                    <td style={{ padding: '6px 8px' }}>{e.retPct != null ? e.retPct : '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{e.bars}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {evs.length > 200 && (
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>Showing first 200 of {evs.length}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
