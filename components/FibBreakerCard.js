'use client';

/**
 * FIBONACCI BREAKER BLOCK CONFLUENCE STRATEGY — Signals-tab card (admin account only).
 * Structure → BOS → Breaker Block → Fib 0.618 → Trendline → Confluence → Entry → 1:4 RR.
 * Scans Pick / Top N / All coins in chunks. Chart + cards from the same engine result.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import SkChart, { fmtP } from './SkChart.js';

const BUCKETS = [['waiting', 'Waiting'], ['confluence', 'Confluence'], ['entry_ready', 'Entry ready'], ['ongoing', 'Active'], ['completed', 'Completed'], ['invalidated', 'Invalidated']];
const BUCKET_COLOR = { waiting: '#64748B', entry_ready: '#2563EB', ongoing: '#D97706', completed: '#16A34A', invalidated: '#DC2626' };
const TFS = [['1d', '1D'], ['4h', '4H'], ['1h', '1H'], ['30m', '30M'], ['15m', '15M']];
const CHUNK = 3;
const GAP_MS = 700;

const chip = (text, color) => (
  <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, padding: '2px 7px', borderRadius: 999, color, background: `${color}1A`, border: `1px solid ${color}55`, whiteSpace: 'nowrap' }}>{text}</span>
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
const post = (body) => api('/api/fib-breaker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function Detail({ item }) {
  const [full, setFull] = useState(item.analysis?.annotations ? item.analysis : null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (full) return undefined;
    let off = false;
    post({ action: 'analyze', symbols: [item.symbol], tfs: [item.analysis.tf], full: true })
      .then((d) => {
        const r = d.results?.[0]?.results?.find((x) => x.dir === item.analysis.dir && x.tf === item.analysis.tf)?.analysis;
        if (!off) setFull(r || null);
      })
      .catch((e) => !off && setErr(e.message));
    return () => { off = true; };
  }, [full, item.symbol, item.analysis.dir, item.analysis.tf]);
  const x = full || item.analysis;
  const L = x.levels || {};
  const fitFrom = L.H2?.time || L.A?.time || null;
  const row = (k, v) => (
    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
      <span style={{ opacity: 0.7 }}>{k}</span>
      <b style={{ textAlign: 'right' }}>{v}</b>
    </div>
  );
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        {item.symbol.replace('USDT', '')}/USDT · {x.dir} · {String(x.tf).toUpperCase()}{!x.isLatest ? ' · older setup' : ''}
      </div>
      {err && <div className="card-subtitle" style={{ color: '#DC2626' }}>{err}</div>}
      {full?.annotations ? <SkChart symbol={item.symbol} annotations={full.annotations} dir={x.dir} defaultTf={x.tf} fitFromTime={fitFrom} /> : !err && <div className="card-subtitle">Loading chart…</div>}
      <div style={{ marginTop: 10 }}>
        {row('Stage', `${x.lifecycleStage || x.stage}${x.isLatest && x.inZone ? ' · IN ZONE' : x.isLatest && x.distanceAtr ? ` · ${x.distanceAtr} ATR away` : ''}`)}
        {x.outcome && row('Outcome', x.outcome)}
        {row('Score', `${x.score} · ${x.quality}`)}
        {x.zone && row('Entry zone', `${fmtP(x.zone.low)} – ${fmtP(x.zone.high)}`)}
        {x.plan && row('Entry / SL', `${fmtP(x.plan.entry)} / ${fmtP(x.plan.sl)}`)}
        {x.plan && row('TP1 · TP2 · TP3 · TP4', `${fmtP(x.plan.tp1)} · ${fmtP(x.plan.tp2)} · ${fmtP(x.plan.tp3)} · ${fmtP(x.plan.tp4)}`)}
        {x.plan && row('R:R', `${x.plan.rr1} (TP1) · ${x.plan.rr2} (TP2) · ${x.plan.rr3} (TP3) · 1:${x.plan.targetRR || 4} (TP4)`)}
        {x.trendline && row('Trend line', x.trendline.confluence ? 'supports the zone' : 'not at the zone')}
      </div>
      <div style={{ marginTop: 8, fontSize: 12 }}>
        <b>Setup steps</b>
        {x.steps.map((s) => (
          <div key={s.id} style={{ opacity: 0.9 }}>{s.status === 'DONE' ? '✅' : s.status === 'WAITING' ? '⏳' : '▫️'} {s.label}: {s.detail}</div>
        ))}
      </div>
      {x.breakdown?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <b>Score</b>
          {x.breakdown.map((b, i) => <div key={i} style={{ opacity: 0.85 }}>+{b.points} · {b.why}</div>)}
        </div>
      )}
      {x.reasons?.length > 0 && <div style={{ color: '#DC2626', fontSize: 12, marginTop: 6 }}>Not listed: {x.reasons.join(' · ')}</div>}
    </div>
  );
}

function Settings({ onSaved }) {
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api('/api/fib-breaker').then((d) => setCfg(d.config)).catch((e) => setMsg(e.message)); }, []);
  if (!cfg) return <div className="card-subtitle">{msg || 'Loading settings…'}</div>;
  const set = (p) => setCfg((c) => ({ ...c, ...p }));
  const N = ({ k, label, step = 1 }) => (
    <label style={{ fontSize: 12.5 }}>
      <span style={{ color: '#475569' }}>{label}</span>
      <input type="number" className="cs-input" step={step} style={{ width: '100%', marginTop: 2 }} value={cfg[k] ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? '' : +e.target.value })} />
    </label>
  );
  const C = ({ k, label }) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      <input type="checkbox" checked={!!cfg[k]} onChange={(e) => set({ [k]: e.target.checked })} />{label}
    </label>
  );
  const save = async () => {
    try {
      const d = await api('/api/fib-breaker', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: cfg }) });
      setCfg(d.config);
      setMsg(d.notes?.length ? `Saved. ${d.notes.join(' ')}` : 'Saved.');
      onSaved?.(d.config);
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div style={{ marginTop: 8, padding: 10, borderRadius: 10, border: '1px solid rgba(128,128,128,0.25)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <N k="swingBars" label="Swing width (bars)" />
        <N k="maxAgeBars" label="Breakout max age (bars)" />
        <N k="maxSetupAgeBars" label="Waiting max age (bars)" />
        <N k="historyDepth" label="Older setups per coin (history)" />
        <N k="entryFibFrom" label="Entry fib from" step={0.01} />
        <N k="entryFibTo" label="Entry fib to" step={0.01} />
        <N k="slBufferAtr" label="SL buffer (ATR)" step={0.05} />
        <N k="minRR" label="Min R:R (to TP1)" step={0.1} />
        <N k="minScore" label="Min score" />
        <N k="maxSignals" label="Max signals shown" />
      </div>
      <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
        <C k="enabled" label="Strategy enabled" />
        <C k="requireBreaker" label="Zone must overlap the breaker block" />
        <C k="requireTrendline" label="Trend line must support the zone" />
      </div>
      <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={save}>Save settings</button>
      {msg && <div className="card-subtitle" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

export function FibBreakerPanel() {
  const [mode, setMode] = useState('pick');
  const [topN, setTopN] = useState(50);
  const [ranking, setRanking] = useState('volume');
  const [pick, setPick] = useState('ETH');
  const [tfs, setTfs] = useState(['4h', '1h']);
  const [sel, setSel] = useState(['entry_ready', 'waiting']); // stages shown
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [diag, setDiag] = useState([]);
  const [msg, setMsg] = useState('');
  const [selKey, setSelKey] = useState(null);
  const chartRef = useRef(null);
  const [view, setView] = useState('setups');
  const [maxSignals, setMaxSignals] = useState(40);
  const [showSet, setShowSet] = useState(false);
  const stop = useRef(false);

  useEffect(() => { api('/api/fib-breaker').then((d) => { setTfs(d.config.tfs); setMaxSignals(d.config.maxSignals); }).catch(() => {}); }, []);
  const toggle = (arr, v, set) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const scan = useCallback(async () => {
    stop.current = false;
    setBusy(true);
    setMsg('');
    setItems([]);
    setDiag([]);
    setSelKey(null);
    try {
      const u = await post(mode === 'pick' ? { action: 'universe', symbols: pick } : { action: 'universe', mode, topN, ranking });
      const list = u.symbols;
      if (!list.length) throw new Error('No matching coins');
      if (u.maxSignals) setMaxSignals(u.maxSignals);
      setProgress({ done: 0, total: list.length, current: '' });
      const found = [];
      const none = [];
      for (let i = 0; i < list.length; i += CHUNK) {
        if (stop.current) { setMsg('Scan stopped.'); break; }
        const chunk = list.slice(i, i + CHUNK);
        setProgress({ done: i, total: list.length, current: chunk.join(', ') });
        let d;
        try {
          d = await post({ action: 'analyze', symbols: chunk, tfs });
        } catch (e) {
          setMsg(e.data?.banned || e.data?.throttled ? `Exchange rate-limit: paused at ${chunk[0]} (${e.message})` : e.message);
          break;
        }
        for (const r of d.results) {
          if (!r.ok) { none.push({ symbol: r.symbol, tf: '—', dir: '—', reason: `failed: ${r.error}` }); continue; }
          for (const x of r.results) {
            if (x.analysis && (x.analysis.listed || x.analysis.bucket === 'waiting' || x.analysis.bucket === 'invalidated' || !x.analysis.isLatest)) found.push({ symbol: r.symbol, analysis: x.analysis });
            else none.push({ symbol: r.symbol, tf: x.tf, dir: x.dir, reason: x.reason || x.analysis?.reasons?.join(' · ') || 'no setup', analysis: x.analysis, steps: x.steps });
          }
        }
        setItems([...found]);
        setDiag([...none]);
        if (d.stopped) { setMsg(`Exchange ${d.stopped}: paused at ${chunk[0]}. ${d.stoppedError || ''}`); break; }
        await sleep(GAP_MS);
      }
      setProgress((p) => (p ? { ...p, done: Math.min(p.total, p.done + CHUNK), current: '' } : p));
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }, [mode, topN, ranking, pick, tfs]);

  const count = (b) => items.filter((i) => i.analysis.bucket === b).length;
  const keyOf = (it) => `${it.symbol}|${it.analysis.id}`;
  const wins = items.filter((i) => i.analysis.outcome === 'TP1 reached').length;
  const stops = items.filter((i) => i.analysis.outcome === 'stopped out').length;
  const shown = items
    .filter((i) => sel.includes(i.analysis.bucket))
    .sort((a, b) => (a.analysis.bucket === 'entry_ready' ? 0 : 1) - (b.analysis.bucket === 'entry_ready' ? 0 : 1) || b.analysis.score - a.analysis.score || (a.analysis.distanceAtr || 0) - (b.analysis.distanceAtr || 0))
    .slice(0, maxSignals);
  const selItem = shown.find((i) => keyOf(i) === selKey) || shown[0] || null;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[['pick', 'Pick coins'], ['top', 'Top N'], ['all', 'All coins']].map(([k, l]) => (
          <button key={k} type="button" className={`cs-chip${mode === k ? ' on' : ''}`} disabled={busy} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>
      {mode === 'pick' && <input className="cs-input" style={{ marginTop: 8, width: '100%' }} value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)} placeholder="ETH, BTC, SOL" />}
      {mode === 'top' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input className="cs-input" type="number" min={1} max={700} style={{ width: 90 }} value={topN} disabled={busy} onChange={(e) => setTopN(e.target.value)} />
          <select className="cs-input" value={ranking} disabled={busy} onChange={(e) => setRanking(e.target.value)}>
            <option value="volume">Rank: 24h volume</option>
            <option value="gainers">Rank: gainers</option>
            <option value="losers">Rank: losers</option>
            <option value="volatility">Rank: volatility</option>
          </select>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>Time frames</span>
        {TFS.map(([k, l]) => (
          <button key={k} type="button" className={`cs-chip${tfs.includes(k) ? ' on' : ''}`} disabled={busy} onClick={() => tfs.length > 1 || !tfs.includes(k) ? toggle(tfs, k, setTfs) : null}>{l}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={scan}>{busy ? 'Scanning…' : 'Scan'}</button>
        {busy && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { stop.current = true; }}>Stop</button>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowSet((v) => !v)}>{showSet ? 'Hide settings' : 'Settings'}</button>
      </div>
      {showSet && <Settings onSaved={(c) => { setTfs(c.tfs); setMaxSignals(c.maxSignals); }} />}
      <div className="card-subtitle" style={{ marginTop: 6 }}>{CHUNK} coins per request with a short pause (rate-limit safe). Paper / analysis only — no orders are placed.</div>
      {progress && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 8, borderRadius: 6, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`, background: '#16A34A', transition: 'width .3s' }} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{Math.min(progress.done, progress.total)} / {progress.total} coins{progress.current ? ` · ${progress.current}` : ''}</div>
        </div>
      )}
      {msg && <div className="card-subtitle" style={{ color: '#DC2626', marginTop: 6 }}>{msg}</div>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        {BUCKETS.map(([k, l]) => (
          <button key={k} type="button" className={`cs-chip${sel.includes(k) ? ' on' : ''}`} onClick={() => toggle(sel, k, setSel)}>{l} · {count(k)}</button>
        ))}
        <button type="button" className={`cs-chip${view === 'diag' ? ' on' : ''}`} onClick={() => setView(view === 'diag' ? 'setups' : 'diag')}>Not listed (why) · {diag.length}</button>
      </div>

      {wins + stops > 0 && (
        <div className="card-subtitle" style={{ marginTop: 8 }}>
          History: {wins} reached TP1 · {stops} stopped out · win {Math.round((wins / (wins + stops)) * 100)}% <span style={{ opacity: 0.7 }}>(setups found in the loaded candles — not a forecast)</span>
        </div>
      )}
      {view !== 'diag' && selItem && (
        <div ref={chartRef} style={{ marginTop: 10, padding: 10, border: '1px solid rgba(128,128,128,0.25)', borderRadius: 12 }}>
          <Detail key={keyOf(selItem)} item={selItem} />
        </div>
      )}

      {view === 'diag' ? (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          {diag.length === 0 && <div className="card-subtitle">Nothing to show.</div>}
          {diag.slice(0, 200).map((d, i) => (
            <div key={i} style={{ fontSize: 12, padding: 8, border: '1px solid rgba(128,128,128,0.25)', borderRadius: 10 }}>
              <b>{d.symbol.replace('USDT', '')}</b> · {String(d.tf).toUpperCase()} · {d.dir} — <span style={{ color: '#DC2626' }}>{d.reason}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          {shown.length === 0 && !busy && <div className="card-subtitle">No setups in the selected stages.</div>}
          {shown.map((it, i) => {
            const a = it.analysis;
            const key = keyOf(it);
            return (
              <div key={`${key}-${i}`} style={{ border: `1px solid ${selItem && keyOf(selItem) === key ? '#2563EB' : 'rgba(128,128,128,0.25)'}`, borderRadius: 12, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <b>{it.symbol.replace('USDT', '')} · {a.dir} · {String(a.tf).toUpperCase()}</b>
                  <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {!a.isLatest && chip('OLD', '#64748B')}
                    {chip(a.stage.replace('_', ' '), BUCKET_COLOR[a.bucket])}
                    {a.bucket === 'entry_ready' && a.isLatest && chip(a.inZone ? 'IN ZONE NOW' : `${a.distanceAtr} ATR away`, a.inZone ? '#16A34A' : '#64748B')}
                    {chip(`${a.score}`, '#2563EB')}
                  </span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                  {a.zone ? `Zone ${fmtP(a.zone.low)} – ${fmtP(a.zone.high)} · entry ${fmtP(a.plan.entry)} · SL ${fmtP(a.plan.sl)} · TP1 ${fmtP(a.plan.tp1)} · R:R ${a.plan.rr1}/${a.plan.rr2}` : `Steps ${a.progress} · ${a.reason || ''}`}
                  {a.trendline?.confluence ? ' · trend line ✓' : ''}
                </div>
                {a.outcome && <div style={{ fontSize: 12, marginTop: 2, opacity: 0.8 }}>Outcome: {a.outcome}</div>}
                <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={() => { setSelKey(key); setView('setups'); setTimeout(() => chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}>Show on chart</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function FibBreakerCard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem('fb_card_open') === '1'); } catch (_) {}
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try { window.localStorage.setItem('fb_card_open', o ? '0' : '1'); } catch (_) {}
      return !o;
    });
  return (
    <div className="sg-results" style={{ marginBottom: 14 }}>
      <button type="button" onClick={toggle} style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }} aria-expanded={open}>
        <span>
          <span className="sg-results-title" style={{ display: 'block' }}>Fibonacci Breaker Block Confluence</span>
          <span className="sg-results-sub" style={{ display: 'block' }}>Structure · BOS · Breaker · Fib Golden Pocket (0.618–0.65) · Trendline · 1:4 RR</span>
        </span>
        <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>{open ? 'Hide' : 'Open'}</span>
      </button>
      {open && <FibBreakerPanel />}
    </div>
  );
}

export default FibBreakerCard;
