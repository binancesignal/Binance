'use client';

import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SkChart, { fmtP } from './SkChart.js';

const BUCKETS = [
  ['new', 'New'],
  ['active', 'Active'],
  ['waiting', 'Waiting'],
  ['entry_ready', 'Entry ready'],
  ['ongoing', 'Ongoing'],
  ['completed', 'Completed'],
  ['invalidated', 'Invalidated'],
  ['history', 'History'],
];
const STAGES = ['TREND_DETECTED', 'CHOCH_CONFIRMED', 'SWING_CONFIRMED', 'FIBONACCI_ACTIVE', 'ABCD_DEVELOPING', 'C_ZONE_REACHED', 'LTF_CONFIRMATION', 'ENTRY_READY', 'ENTRY_ONGOING', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'D_TARGET_REACHED', 'STOP_LOSS_HIT', 'INVALIDATED', 'EXPIRED'];
const TOPS = [10, 20, 30, 50, 100];
const STATE_COLOR = { CONFIRMED: '#16A34A', WAITING: '#D97706', PENDING: '#64748B', INVALIDATED: '#DC2626', COMPLETED: '#2563EB', SKIPPED: '#94A3B8' };
const STAGE_TONE = (s) =>
  ['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'D_TARGET_REACHED'].includes(s) ? '#16A34A' : ['STOP_LOSS_HIT', 'INVALIDATED'].includes(s) ? '#DC2626' : s === 'EXPIRED' ? '#94A3B8' : ['ENTRY_READY', 'ENTRY_ONGOING'].includes(s) ? '#2563EB' : '#D97706';

// Setup 1 = 4H swing setup · Setup 2 = 1H intraday setup (its ids start with sk2_)
const isS2 = (s) => s?.setup === 2 || String(s?.id || '').startsWith('sk2_');
const setupLabel = (s) => (isS2(s) ? `SETUP 2 · ${String(s?.primaryTf || '1h').toUpperCase()}` : `SETUP 1 · ${String(s?.primaryTf || '4h').toUpperCase()}`);
const SETUP_TONE = (s) => (isS2(s) ? '#0D9488' : '#475569');
const base = (s) => String(s || '').replace(/USDT$/, '');
const pretty = (s) => String(s || '').replace(/_/g, ' ');
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(+d) ? '—' : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};
const chip = (text, color) => (
  <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, padding: '2px 7px', borderRadius: 999, color, background: `${color}1A`, border: `1px solid ${color}55`, whiteSpace: 'nowrap' }}>{text}</span>
);

async function api(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** keeps a chart / detail error local — the rest of the app keeps working */
class SkBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('[SK System]', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ background: '#fee2e2', fontSize: 13 }}>
          Chart could not be shown: {String(this.state.error?.message || this.state.error)}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Explanation panel: WHY the setup is valid / waiting / invalid ─────────────────────────────
function Explain({ setup, analysis, events }) {
  if (!analysis) return <div className="card-subtitle">No stored analysis for this snapshot.</div>;
  const closedBad = setup.stage === 'INVALIDATED' || setup.stage === 'EXPIRED' || setup.stage === 'STOP_LOSS_HIT';
  const done = ['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'D_TARGET_REACHED'].includes(setup.stage) && setup.status === 'CLOSED';
  const h = analysis.htf || {};
  const e = setup.entry || analysis.entry;
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        {chip(setupLabel(setup), SETUP_TONE(setup))}
        {chip(pretty(setup.stage), STAGE_TONE(setup.stage))}
        {setup.outcome && chip(pretty(setup.outcome), setup.outcome.includes('SL') && !setup.outcome.includes('TP') ? '#DC2626' : '#16A34A')}
        {chip(`${analysis.score ?? setup.score}/100 · ${analysis.quality || setup.quality}`, '#2563EB')}
        {done && chip('COMPLETED', STATE_COLOR.COMPLETED)}
        {closedBad && chip(setup.stage === 'INVALIDATED' ? 'INVALIDATED' : pretty(setup.stage), STATE_COLOR.INVALIDATED)}
      </div>
      {setup.invalidation?.reason && (
        <div className="card" style={{ background: '#fee2e2', marginBottom: 10, fontSize: 13 }}>
          <b>Why it was invalidated:</b> {setup.invalidation.reason}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: '#475569', marginBottom: 8 }}>
        {String(h.tfHigh || '1w').toUpperCase()} {h.weekly || '—'} · {String(h.tfLow || '1d').toUpperCase()} {h.daily || '—'} · {h.aligned ? 'aligned with the setup' : 'NOT aligned'} ({h.mode})
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {(analysis.steps || []).map((s) => (
          <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: 8, alignItems: 'start', fontSize: 12.5 }}>
            <div>{chip(s.status, STATE_COLOR[s.status] || '#64748B')}</div>
            <div>
              <b>{s.label}</b> <span style={{ color: '#94A3B8' }}>{String(s.tf).toUpperCase()}</span>
              <div style={{ color: '#475569' }}>{s.detail}</div>
            </div>
          </div>
        ))}
      </div>
      {analysis.notes?.length > 0 && <div className="card-subtitle" style={{ marginTop: 8 }}>Notes: {analysis.notes.join(' · ')}</div>}
      {e && (
        <div className="card" style={{ marginTop: 12, fontSize: 13, lineHeight: 1.7 }}>
          <b>Trade plan {e.locked ? '(locked)' : ''}</b>
          <div>Entry zone {fmtP(e.zone?.bottom)} – {fmtP(e.zone?.top)} · <b>Entry {fmtP(e.price)}</b> ({e.mode})</div>
          <div style={{ color: '#DC2626' }}>Stop loss {fmtP(e.sl)}</div>
          <div style={{ color: '#16A34A' }}>TP1 {fmtP(e.tp1)} · TP2 {fmtP(e.tp2)} · TP3 {fmtP(e.tp3)}{e.d ? ` · D ${fmtP(e.d)}` : ''}</div>
          <div>R:R {e.rr} · risk {e.riskAtr} ATR({String(analysis.tfs?.struct || '1h').toUpperCase()})</div>
        </div>
      )}
      {analysis.h4?.D && (
        <div className="card-subtitle" style={{ marginTop: 8 }}>
          A {fmtP(analysis.h4.A.price)} · B {fmtP(analysis.h4.B.price)} · C {analysis.h4.C ? fmtP(analysis.h4.C.price) : '—'} · projected D {fmtP(analysis.h4.D.price)}
        </div>
      )}
      {events?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="form-label">Lifecycle</div>
          {events.map((ev, i) => (
            <div key={`${ev.stage}-${i}`} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', borderTop: '1px solid rgba(128,128,128,0.15)' }}>
              <span style={{ color: '#94A3B8', minWidth: 96 }}>{when(ev.at)}</span>
              <b style={{ color: STAGE_TONE(ev.stage) }}>{pretty(ev.stage)}</b>
              <span style={{ color: '#475569' }}>{ev.note || ''}{ev.price != null ? ` @ ${fmtP(ev.price)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Setup detail (chart + explanation) ───────────────────────────────────────────────────────
function SetupDetail({ id, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [stage, setStage] = useState('');

  useEffect(() => {
    let alive = true;
    setErr('');
    api(`/api/sk-system/setup?id=${encodeURIComponent(id)}${stage ? `&stage=${stage}` : ''}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [id, stage]);

  const setup = data?.setup;
  const analysis = data?.analysis;
  const focus = useMemo(() => {
    const e = setup?.entry || analysis?.entry;
    return e ? [e.price, e.sl, e.tp1] : [];
  }, [setup, analysis]);
  // closed setups open on their own period; open setups are live
  const historicalAt = setup && setup.status === 'CLOSED' ? Math.floor(Date.parse(setup.entry?.armedAtIso || setup.updatedAt) / 1000) : null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(2,6,23,0.72)', overflowY: 'auto', padding: 'max(10px, env(safe-area-inset-top)) 10px 24px' }} onClick={onClose}>
      <div style={{ maxWidth: 1100, margin: '0 auto', background: 'var(--card, #fff)', borderRadius: 14, padding: 12 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>
            {setup ? `${base(setup.symbol)}/USDT` : '…'} {setup && chip(setup.dir, setup.dir === 'LONG' ? '#16A34A' : '#DC2626')}
          </h3>
          {data?.snapshots?.length > 0 && (
            <select className="cs-input" value={stage} onChange={(e) => setStage(e.target.value)} style={{ minWidth: 190, marginLeft: 'auto' }} title="Original analysis at each stage">
              <option value="">Latest analysis</option>
              {data.snapshots.map((s) => (
                <option key={s.stage} value={s.stage}>Original @ {pretty(s.stage)} · {when(s.created_at)}</option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
        {err && <div style={{ color: '#DC2626', fontSize: 13 }}>{err}</div>}
        {!data && !err && <div className="card-subtitle">Loading setup…</div>}
        {setup && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
            <SkBoundary>
            <SkChart symbol={setup.symbol} annotations={analysis?.annotations || []} dir={setup.dir} historicalAt={historicalAt} defaultTf={setup.primaryTf || '4h'} focus={focus} />
            </SkBoundary>
            {stage && <div className="card-subtitle">Showing the stored analysis from when this setup reached {pretty(stage)} — not recalculated.</div>}
            <SkBoundary>
              <Explain setup={setup} analysis={analysis} events={data.events} />
            </SkBoundary>
          </div>
        )}
      </div>
    </div>
  );
}

function SetupCard({ s, onView }) {
  const e = s.entry;
  const tone = s.dir === 'LONG' ? '#16A34A' : '#DC2626';
  return (
    <div className="card" style={{ padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>{base(s.symbol)}<small style={{ color: '#94A3B8' }}>/USDT</small></b>
        {chip(s.dir, tone)}
        {chip(setupLabel(s), SETUP_TONE(s))}
        {chip(pretty(s.stage), STAGE_TONE(s.stage))}
        {chip(`${s.score} · ${s.quality}`, '#2563EB')}
        {s.isNew && chip('NEW', '#7C3AED')}
        <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => onView(s.id)}>View chart</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6, marginTop: 8, fontSize: 12.5 }}>
        <div><span style={{ color: '#94A3B8' }}>A→B</span><br />{fmtP(s.A?.price)} → {fmtP(s.B?.price)}</div>
        <div><span style={{ color: '#94A3B8' }}>C / D</span><br />{s.C ? fmtP(s.C.price) : '—'} / {s.D ? fmtP(s.D.price) : '—'}</div>
        <div><span style={{ color: '#94A3B8' }}>Entry zone</span><br />{e ? `${fmtP(e.zone?.bottom)} – ${fmtP(e.zone?.top)}` : '—'}</div>
        <div><span style={{ color: '#94A3B8' }}>SL</span><br />{e ? fmtP(e.sl) : '—'}</div>
        <div><span style={{ color: '#94A3B8' }}>TP1 / 2 / 3</span><br />{e ? `${fmtP(e.tp1)} / ${fmtP(e.tp2)} / ${fmtP(e.tp3)}` : '—'}</div>
        <div><span style={{ color: '#94A3B8' }}>Price</span><br />{s.currentPrice != null ? fmtP(s.currentPrice) : '—'}</div>
      </div>
      <div className="card-subtitle" style={{ marginTop: 6 }}>
        {s.stepsDone != null && `${s.stepsDone}/${s.stepsTotal} steps confirmed · `}created {when(s.createdAt)} · updated {when(s.updatedAt)}
        {s.invalidation?.reason ? ` · ${s.invalidation.reason}` : ''}
      </div>
    </div>
  );
}

export default function SkSystemPanel() {
  const [bucket, setBucket] = useState('active');
  const [filters, setFilters] = useState({ symbol: '', dir: '', stage: '', tf: '', setup: '', from: '', to: '', quality: '' });
  const [scanSetups, setScanSetups] = useState('both'); // which setup(s) the next scan runs: both · 1 · 2
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState(null);
  // scan
  const [mode, setMode] = useState('top');
  const [topN, setTopN] = useState(50);
  const [ranking, setRanking] = useState('volume');
  const [coins, setCoins] = useState('');
  const [run, setRun] = useState(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const stopRef = useRef(false);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set('bucket', bucket);
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  }, [bucket, filters]);

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/sk-system?${qs}`);
      setData(d);
      setErr('');
      if (d.run) setRun((r) => (scanBusy ? r : d.run));
    } catch (e) {
      setErr(e.message);
    }
  }, [qs, scanBusy]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const isAdmin = !!data?.isAdmin;
  const pct = run?.total ? Math.round((run.analyzed / run.total) * 100) : 0;

  // client loop: one chunk per request until the persisted run is completed / paused / stopped
  const drive = async (first, notice = '') => {
    setScanBusy(true);
    stopRef.current = false;
    setScanMsg(notice);
    try {
      let r = first;
      while (r && r.status === 'running' && !stopRef.current) {
        setRun(r);
        const d = await api('/api/sk-system/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'chunk', runId: r.id }) });
        r = d.run;
        if (d.skipped) await new Promise((res) => setTimeout(res, 2500));
      }
      setRun(r);
      if (r?.status === 'paused') setScanMsg(`Paused — ${r.pausedReason || 'rate limit'}. Press Resume to continue.`);
      else if (r?.status === 'completed') setScanMsg(`Scan completed — ${r.analyzed}/${r.total} coins analysed, ${r.setupsFound} setup update(s)${r.failed ? `, ${r.failed} failed` : ''}.`);
    } catch (e) {
      setScanMsg(e.message);
    } finally {
      setScanBusy(false);
      load();
    }
  };

  const start = async () => {
    setScanBusy(true);
    setScanMsg('');
    try {
      const symbols = coins.split(/[\s,;]+/).filter(Boolean);
      const d = await api('/api/sk-system/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', mode, topN, ranking, symbols: symbols.length ? symbols : undefined, setups: data?.config2?.enabled ? (scanSetups === 'both' ? [1, 2] : [+scanSetups]) : [1] }) });
      await drive(d.run, d.notice || '');
    } catch (e) {
      setScanMsg(e.message);
      setScanBusy(false);
    }
  };
  const resume = async () => {
    setScanBusy(true);
    try {
      const d = await api('/api/sk-system/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume', runId: run.id }) });
      await drive(d.run);
    } catch (e) {
      setScanMsg(e.message);
      setScanBusy(false);
    }
  };
  const stop = async () => {
    stopRef.current = true;
    try {
      if (run?.id) setRun((await api('/api/sk-system/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', runId: run.id }) })).run);
    } catch (_) {}
  };

  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const counts = data?.counts || {};

  return (
    <div style={{ marginTop: 12 }}>
      {data && !data.canScan && <div className="card-subtitle" style={{ marginBottom: 10 }}>{data.config?.enabled === false ? 'SK SYSTEM PRO is switched off by the admin.' : 'Scanning is not enabled for your account — setups found by scans appear below.'}</div>}
      {data?.canScan && (
        <div style={{ marginBottom: 12 }}>
          <div className="cs-chip-label">Scan settings{!isAdmin ? ` · up to ${data.scanMax} coins per scan` : ''}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {data.canAll && <button type="button" className={`cs-chip${mode === 'all' ? ' on' : ''}`} disabled={scanBusy} onClick={() => setMode('all')}>All coins</button>}
            {TOPS.filter((n) => n <= (data.scanMax || 600)).map((n) => (
              <button key={n} type="button" className={`cs-chip${mode === 'top' && topN === n ? ' on' : ''}`} disabled={scanBusy} onClick={() => { setMode('top'); setTopN(n); }}>Top {n}</button>
            ))}
            <input type="number" min={1} max={data.scanMax || 600} className="cs-input" style={{ width: 84, minWidth: 84 }} value={topN} disabled={scanBusy} onChange={(e) => { setMode('top'); setTopN(+e.target.value); }} title="Custom Top N" />
            <select className="cs-input" value={ranking} disabled={scanBusy} onChange={(e) => setRanking(e.target.value)} style={{ minWidth: 120 }}>
              <option value="volume">Rank: 24h volume</option>
              <option value="gainers">Rank: top gainers</option>
              <option value="losers">Rank: top losers</option>
              <option value="volatility">Rank: volatility</option>
            </select>
          </div>
          {data.config2?.enabled && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
              <span className="cs-chip-label" style={{ margin: 0 }}>Setups</span>
              {[['both', 'Setup 1 + 2'], ['1', 'Setup 1 · 4H'], ['2', 'Setup 2 · 1H']].map(([k, l]) => (
                <button key={k} type="button" className={`cs-chip${scanSetups === k ? ' on' : ''}`} disabled={scanBusy} onClick={() => setScanSetups(k)}>{l}</button>
              ))}
            </div>
          )}
          <input className="cs-input" style={{ marginTop: 8, width: '100%' }} placeholder="…or pick coins: LTC, BTC, ETH (leave empty to scan the Top N above)" value={coins} disabled={scanBusy} onChange={(e) => setCoins(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={scanBusy} onClick={start}>{scanBusy ? 'Scanning…' : mode === 'all' && !coins.trim() ? 'Scan all coins' : 'Scan'}</button>
            {scanBusy && <button type="button" className="btn btn-secondary" onClick={stop}>Stop</button>}
            {!scanBusy && run && (run.status === 'paused' || run.status === 'stopped') && run.analyzed < run.total && (
              <button type="button" className="btn btn-secondary" onClick={resume}>Resume ({run.analyzed}/{run.total})</button>
            )}
            {!scanBusy && run?.status === 'running' && <button type="button" className="btn btn-secondary" onClick={() => drive(run)}>Continue scan</button>}
          </div>
        </div>
      )}

      {data?.config && (
        <details style={{ marginBottom: 10, fontSize: 12.5, color: '#475569' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Strategy settings{isAdmin ? ' (edit in Admin → SK System)' : ' (set by the admin)'}</summary>
          <div style={{ lineHeight: 1.7, marginTop: 4 }}>
            Primary {String(data.config.primaryTf).toUpperCase()} · confirm {['1H', ...(data.config.confirmTfs || []).map((t) => t.toUpperCase())].join(' / ')} · 1W/1D alignment: {data.config.htfAlignment} · swings: {data.config.swingSensitivity}
            <br />Fib {data.config.fibLevels?.join(' / ')} · C zone {data.config.cZone?.join('–')} · entry Fib {data.config.entryFib?.join('–')} · D = AB × {data.config.dExtension}
            <br />Entry {data.config.entryMode} · SL buffer {data.config.slBufferAtr} ATR · TP {data.config.tpMethod} · min R:R {data.config.minRR} · min score {data.config.minScore}
            {data.config2 && (
              <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(128,128,128,0.2)' }}>
                <b>Setup 2 · intraday{data.config2.enabled ? '' : ' (switched off)'}</b>
                <br />Primary {String(data.config2.primaryTf).toUpperCase()} · 15M CHoCH{(data.config2.confirmTfs || []).length ? ` + ${data.config2.confirmTfs.map((t) => t.toUpperCase()).join(' / ')}` : ''} · 1D/4H alignment: {data.config2.htfAlignment} · swings: {data.config2.swingSensitivity}
                <br />Fib {data.config2.fibLevels?.join(' / ')} · C zone {data.config2.cZone?.join('–')} · entry Fib {data.config2.entryFib?.join('–')} · D = AB × {data.config2.dExtension}
                <br />Entry {data.config2.entryMode} · SL buffer {data.config2.slBufferAtr} ATR · TP {data.config2.tpMethod} · min R:R {data.config2.minRR} · min score {data.config2.minScore}
              </div>
            )}
          </div>
        </details>
      )}

      {run && (
        <div className="card" style={{ marginBottom: 12, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>
            <b>
              {run.status === 'completed' ? 'Last scan' : run.status === 'running' ? 'Scanning' : pretty(run.status).replace(/^./, (c) => c.toUpperCase())}{' '}
              {run.analyzed} / {run.total} coins
            </b>
            <span>{run.universe === 'all' ? 'All coins' : `Top ${run.topN}`} · {run.ranking}{run.setups?.length ? ` · ${run.setups.map((n) => `Setup ${n}`).join(' + ')}` : ''}</span>
          </div>
          <div style={{ height: 8, background: '#E2E8F0', borderRadius: 99, margin: '8px 0', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: run.status === 'completed' ? '#16A34A' : '#2563EB', transition: 'width .3s' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6, fontSize: 12.5 }}>
            <div><span style={{ color: '#94A3B8' }}>Progress</span><br /><b>{pct}%</b></div>
            <div><span style={{ color: '#94A3B8' }}>Selected</span><br /><b>{run.total}</b></div>
            <div><span style={{ color: '#94A3B8' }}>Analysed</span><br /><b>{run.analyzed}</b></div>
            <div><span style={{ color: '#94A3B8' }}>Remaining</span><br /><b>{Math.max(0, run.total - run.analyzed)}</b></div>
            <div><span style={{ color: '#94A3B8' }}>Successful</span><br /><b style={{ color: '#16A34A' }}>{run.ok}</b></div>
            <div><span style={{ color: '#94A3B8' }}>Failed</span><br /><b style={{ color: run.failed ? '#DC2626' : undefined }}>{run.failed}</b></div>
            <div><span style={{ color: '#94A3B8' }}>Valid setups found</span><br /><b>{run.setupsFound}</b></div>
            {run.status === 'running' && run.currentSymbol && <div><span style={{ color: '#94A3B8' }}>Now</span><br /><b>{base(run.currentSymbol)}</b></div>}
          </div>
          {run.failedSymbols?.length > 0 && <div className="card-subtitle" style={{ marginTop: 6 }}>Failed: {run.failedSymbols.slice(-6).map((f) => `${base(f.symbol)} (${f.error})`).join(' · ')}</div>}
          {run.status === 'paused' && <div style={{ marginTop: 6, color: '#D97706', fontSize: 13 }}>Paused: {run.pausedReason || 'rate limit'} — progress is saved.</div>}
        </div>
      )}
      {scanMsg && <div className="card-subtitle" style={{ marginBottom: 8 }}>{scanMsg}</div>}

      {data?.config2?.enabled && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <span className="cs-chip-label" style={{ margin: 0 }}>Show</span>
          {[['', 'All setups'], ['1', 'Setup 1 · 4H'], ['2', 'Setup 2 · 1H']].map(([k, l]) => (
            <button key={k || 'all'} type="button" className={`cs-chip${filters.setup === k ? ' on' : ''}`} onClick={() => setFilters((f) => ({ ...f, setup: k }))}>{l}</button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {BUCKETS.map(([k, l]) => (
          <button key={k} type="button" className={`cs-chip${bucket === k ? ' on' : ''}`} onClick={() => setBucket(k)}>
            {l}{counts[k === 'history' ? 'all' : k] != null ? ` · ${counts[k === 'history' ? 'all' : k]}` : ''}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 6, marginBottom: 12 }}>
        <input className="cs-input" placeholder="Symbol" value={filters.symbol} onChange={setF('symbol')} />
        <select className="cs-input" value={filters.dir} onChange={setF('dir')}>
          <option value="">Long + Short</option>
          <option value="LONG">LONG</option>
          <option value="SHORT">SHORT</option>
        </select>
        <select className="cs-input" value={filters.stage} onChange={setF('stage')}>
          <option value="">Any status</option>
          {STAGES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
        </select>
        <select className="cs-input" value={filters.tf} onChange={setF('tf')}>
          <option value="">Any timeframe</option>
          <option value="4h">4H primary</option>
          <option value="2h">2H primary</option>
          <option value="1h">1H primary</option>
        </select>
        <select className="cs-input" value={filters.quality} onChange={setF('quality')}>
          <option value="">Any quality</option>
          <option value="STRONG">Strong (80+)</option>
          <option value="VALID">Valid (65–79)</option>
          <option value="WEAK">Weak (&lt;65)</option>
        </select>
        <input className="cs-input" type="date" value={filters.from} onChange={setF('from')} title="From" />
        <input className="cs-input" type="date" value={filters.to} onChange={setF('to')} title="To" />
      </div>

      {err && <div style={{ color: '#DC2626', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {data && !data.setups.length && !err && <div className="card-subtitle">No setups in this list yet. Run a scan{isAdmin ? '' : ' (admin)'} — setups appear here and stay in History.</div>}
      {data?.setups.map((s) => <SetupCard key={s.id} s={s} onView={setView} />)}
      {view && (
        <SkBoundary>
          <SetupDetail id={view} onClose={() => setView(null)} />
        </SkBoundary>
      )}
    </div>
  );
}

/** Signals-tab card: admin account only, tap to open (remembers the choice) */
export function SkSystemCard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem('sk_card_open') === '1');
    } catch (_) {}
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem('sk_card_open', o ? '0' : '1');
      } catch (_) {}
      return !o;
    });
  return (
    <div className="sg-results" style={{ marginBottom: 14 }}>
      <button type="button" onClick={toggle} style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }} aria-expanded={open}>
        <span>
          <span className="sg-results-title" style={{ display: 'block' }}>SK System</span>
          <span className="sg-results-sub" style={{ display: 'block' }}>Scan coins · setups · chart · explanation</span>
        </span>
        <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>{open ? 'Hide' : 'Open'}</span>
      </button>
      {open && <SkSystemPanel />}
    </div>
  );
}
