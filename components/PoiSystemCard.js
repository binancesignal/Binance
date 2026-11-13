'use client';

/**
 * ICT / SMC PROBABILITY-BASED POI — Signals-tab card (admin account only).
 * Scan one coin (e.g. ETH) or many coins in small chunks (never one big burst → no rate-limit ban).
 * The list, the chart annotations and the diagnostics all come from the same engine result.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import SkChart, { fmtP } from './SkChart.js';

const CLASS_COLOR = { 'A+': '#16A34A', B: '#D97706', C: '#DC2626', NONE: '#64748B' };
const STATE_COLOR = { WATCHING: '#64748B', READY: '#2563EB', CONFIRMED: '#16A34A', INVALIDATED: '#DC2626' };
const CHUNK = 3; // coins per request
const GAP_MS = 700; // pause between chunks

const chip = (text, color) => (
  <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, padding: '2px 7px', borderRadius: 999, color, background: `${color}1A`, border: `1px solid ${color}55`, whiteSpace: 'nowrap' }}>{text}</span>
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (t) => {
  if (!t) return '—';
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  return m < 90 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

async function api(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
const post = (body) => api('/api/poi-system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function Detail({ item, onClose }) {
  const a = item.analysis;
  const [full, setFull] = useState(a?.annotations ? a : null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (full) return;
    let off = false;
    post({ action: 'analyze', symbols: [item.symbol], full: true })
      .then((d) => {
        const r = d.results?.[0]?.results?.find((x) => x.dir === item.dir)?.analysis;
        if (!off) setFull(r || null);
      })
      .catch((e) => !off && setErr(e.message));
    return () => { off = true; };
  }, [full, item.symbol, item.dir]);
  const x = full || a;
  const row = (k, v) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
      <span style={{ opacity: 0.7 }}>{k}</span>
      <b style={{ textAlign: 'right' }}>{v}</b>
    </div>
  );
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <b>{item.symbol.replace('USDT', '')}/USDT · {item.dir}</b>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
      </div>
      {err && <div className="card-subtitle" style={{ color: '#DC2626' }}>{err}</div>}
      {full?.annotations ? (
        <SkChart symbol={item.symbol} annotations={full.annotations} dir={item.dir} defaultTf="1h" />
      ) : (
        !err && <div className="card-subtitle">Loading chart…</div>
      )}
      {x && (
        <div style={{ marginTop: 10 }}>
          {row('State', x.state)}
          {row('Probability class', `${x.class} (setup quality, not a win rate)`)}
          {row('Confluence score', x.score)}
          {row('HTF bias', `${x.htf.bias} · 1D ${x.htf.d1} · 4H ${x.htf.h4} · ${x.htf.align}`)}
          {row('POI', `${x.poi.type} ${String(x.poi.tf).toUpperCase()} · ${fmtP(x.poi.low)} – ${fmtP(x.poi.high)}`)}
          {row('Zone status', `${x.poi.mitigation}${x.poi.invalidated ? ' · invalidated' : ''}`)}
          {row('Premium / Discount', `${x.location.zone} · ${(x.location.pos * 100).toFixed(0)} %${x.location.extreme ? ' · extreme' : ''} (price in ${x.premiumDiscount.zone})`)}
          {row('Liquidity sweep', x.liquidity.sweep.status === 'NONE' ? 'none' : `${x.liquidity.sweep.status} · ${String(x.liquidity.sweep.tf).toUpperCase()} @ ${fmtP(x.liquidity.sweep.level)}`)}
          {row('Associated liquidity', x.liquidity.associatedLevel ? `${x.liquidity.associatedLevel.kind.replace('_', ' ').toLowerCase()} @ ${fmtP(x.liquidity.associatedLevel.price)}` : '—')}
          {row('MSS (15M)', x.mss ? `@ ${fmtP(x.mss.level)}${x.mss.pending ? ' (pending)' : ''}` : '—')}
          {row('BOS (15M)', x.bos ? `@ ${fmtP(x.bos.level)}${x.bos.pending ? ' (pending)' : ''}` : '—')}
          {row('OB', x.ob.status === 'NONE' ? '—' : `${x.ob.status} · ${x.ob.displacementAtr} ATR`)}
          {row('FVG', x.fvg.status === 'NONE' ? '—' : `${x.fvg.status}`)}
          {x.plan && row('Paper plan', `entry ${fmtP(x.plan.entry)} · SL ${fmtP(x.plan.sl)} · TP1 ${x.plan.tp1 ? fmtP(x.plan.tp1) : '—'} · R:R ${x.plan.rr ?? '—'}${x.plan.rrOk ? '' : ' (below min)'}`)}
          {row('Signal time', ago(x.signalTime))}
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <b>Score breakdown</b>
            {x.breakdown.map((b) => (
              <div key={b.factor} style={{ opacity: 0.85 }}>{b.points > 0 ? '+' : ''}{b.points} · {b.why}</div>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <b>Why / why not</b>
            {x.diagnostics.map((d) => (
              <div key={d.id} style={{ opacity: 0.9 }}>{d.ok === true ? '✅' : d.ok === false ? '❌' : '⏳'} {d.label}: {d.detail}</div>
            ))}
            {x.reasons.length > 0 && <div style={{ color: '#DC2626', marginTop: 4 }}>Not listed: {x.reasons.join(' · ')}</div>}
          </div>
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <b>Invalidation</b>
            {x.invalidation.map((t, i) => <div key={i} style={{ opacity: 0.85 }}>• {t}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function PoiPanel() {
  const [mode, setMode] = useState('top'); // top | all | pick
  const [topN, setTopN] = useState(50);
  const [ranking, setRanking] = useState('volume');
  const [pick, setPick] = useState('ETH');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total, current }
  const [items, setItems] = useState([]); // one per coin × direction
  const [diag, setDiag] = useState([]); // coins without a listed setup (why)
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('listed');
  const [bt, setBt] = useState(null);
  const [maxSignals, setMaxSignals] = useState(30);
  const stop = useRef(false);

  const scan = useCallback(async () => {
    stop.current = false;
    setBusy(true);
    setMsg('');
    setItems([]);
    setDiag([]);
    setOpen(null);
    try {
      const u = await post(mode === 'pick' ? { action: 'universe', symbols: pick } : { action: 'universe', mode, topN, ranking });
      const list = u.symbols;
      if (u.maxSignals) setMaxSignals(u.maxSignals);
      if (!list.length) throw new Error('No matching coins');
      setProgress({ done: 0, total: list.length, current: '' });
      const found = [];
      const none = [];
      for (let i = 0; i < list.length; i += CHUNK) {
        if (stop.current) { setMsg('Scan stopped.'); break; }
        const chunk = list.slice(i, i + CHUNK);
        setProgress({ done: i, total: list.length, current: chunk.join(', ') });
        let d;
        try {
          d = await post({ action: 'analyze', symbols: chunk });
        } catch (e) {
          setMsg(e.data?.banned || e.data?.throttled ? `Exchange rate-limit: scan paused at ${chunk[0]} (${e.message})` : e.message);
          break;
        }
        for (const r of d.results) {
          if (!r.ok) { none.push({ symbol: r.symbol, dir: '—', reason: `failed: ${r.error}` }); continue; }
          for (const x of r.results) {
            if (x.analysis?.listed) found.push({ symbol: r.symbol, dir: x.dir, analysis: x.analysis });
            else none.push({ symbol: r.symbol, dir: x.dir, reason: x.reason || 'no setup', analysis: x.analysis, diagnostics: x.diagnostics });
          }
        }
        setItems([...found]);
        setDiag([...none]);
        if (d.stopped) { setMsg(`Exchange ${d.stopped}: scan paused at ${chunk[0]}. ${d.stoppedError || ''}`); break; }
        await sleep(GAP_MS);
      }
      setProgress((p) => (p ? { ...p, done: Math.min(p.total, p.done + CHUNK), current: '' } : p));
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }, [mode, topN, ranking, pick]);

  const runBt = async () => {
    setBt({ loading: true });
    try {
      const sym = (pick.split(/[\s,;]+/)[0] || 'ETH').toUpperCase();
      setBt(await post({ action: 'backtest', symbol: sym, days: 5, step: 7200 }));
    } catch (e) {
      setBt({ error: e.message });
    }
  };

  const RANK = { 'A+': 3, B: 2, C: 1 };
  const shown = (filter === 'listed' ? items : diag)
    .slice()
    .sort((a, b) => (RANK[b.analysis?.class] || 0) - (RANK[a.analysis?.class] || 0) || (b.analysis?.score || 0) - (a.analysis?.score || 0))
    .slice(0, filter === 'listed' ? maxSignals : 200); // admin setting: most signals displayed
  const lbl = { fontSize: 11, opacity: 0.7 };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
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
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={scan}>{busy ? 'Scanning…' : 'Scan'}</button>
        {busy && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { stop.current = true; }}>Stop</button>}
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || bt?.loading} onClick={runBt}>{bt?.loading ? 'Replaying…' : 'Paper backtest (first coin)'}</button>
      </div>
      <div className="card-subtitle" style={{ marginTop: 6 }}>
        Coins are scanned {CHUNK} at a time with a short pause (rate-limit safe). Paper / analysis only — no orders are ever placed.
      </div>
      {progress && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 8, borderRadius: 6, background: 'rgba(128,128,128,0.2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`, background: '#16A34A', transition: 'width .3s' }} />
          </div>
          <div style={{ ...lbl, marginTop: 4 }}>{Math.min(progress.done, progress.total)} / {progress.total} coins{progress.current ? ` · ${progress.current}` : ''} · {items.length} listed</div>
        </div>
      )}
      {msg && <div className="card-subtitle" style={{ color: '#DC2626', marginTop: 6 }}>{msg}</div>}

      {bt && !bt.loading && (
        <div style={{ marginTop: 10, fontSize: 12.5, padding: 10, borderRadius: 10, border: '1px solid rgba(128,128,128,0.25)' }}>
          {bt.error ? <span style={{ color: '#DC2626' }}>{bt.error}</span> : (
            <>
              <b>Paper replay · {bt.symbol} · last ~5 days · fee {bt.costs.feePct}% + slippage {bt.costs.slippagePct}% per side</b>
              <div>{bt.stats.trades} trades · win {bt.stats.winRate}% · avg {bt.stats.avgNetR}R · total {bt.stats.totalNetR}R · PF {bt.stats.profitFactor ?? '—'} · max DD {bt.stats.maxDrawdownR}R</div>
              <div style={{ opacity: 0.7, marginTop: 4 }}>{bt.stats.trades < 20 ? 'Too few trades to say anything statistically. ' : ''}{bt.note}</div>
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button type="button" className={`cs-chip${filter === 'listed' ? ' on' : ''}`} onClick={() => setFilter('listed')}>Signals · {Math.min(items.length, maxSignals)}{items.length > maxSignals ? ` of ${items.length}` : ''}</button>
        <button type="button" className={`cs-chip${filter === 'diag' ? ' on' : ''}`} onClick={() => setFilter('diag')}>Not listed (why) · {diag.length}</button>
      </div>
      <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
        {shown.length === 0 && !busy && <div className="card-subtitle">{filter === 'listed' ? 'No listed setups yet.' : 'Nothing to show.'}</div>}
        {shown.map((it, i) => {
          const a = it.analysis;
          const key = `${it.symbol}-${it.dir}-${i}`;
          return (
            <div key={key} style={{ border: '1px solid rgba(128,128,128,0.25)', borderRadius: 12, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b>{it.symbol.replace('USDT', '')} · {it.dir}</b>
                <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {a && chip(a.class, CLASS_COLOR[a.class] || '#64748B')}
                  {a && chip(a.state, STATE_COLOR[a.state] || '#64748B')}
                  {a && chip(`${a.score}`, '#2563EB')}
                </span>
              </div>
              {a ? (
                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                  {a.poi.type} {String(a.poi.tf).toUpperCase()} · {fmtP(a.poi.low)} – {fmtP(a.poi.high)} · {a.location.zone}{a.location.extreme ? ' (extreme)' : ''} · HTF {a.htf.align}
                  {a.liquidity.sweep.status !== 'NONE' ? ` · sweep ${a.liquidity.sweep.status.toLowerCase()}` : ''}
                </div>
              ) : null}
              {!filter.startsWith('listed') && <div style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>{it.reason}</div>}
              {a && (
                <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={() => setOpen(open === key ? null : key)}>{open === key ? 'Hide chart' : 'Chart + why'}</button>
              )}
              {open === key && <Detail item={it} onClose={() => setOpen(null)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PoiSystemCard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem('poi_card_open') === '1'); } catch (_) {}
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try { window.localStorage.setItem('poi_card_open', o ? '0' : '1'); } catch (_) {}
      return !o;
    });
  return (
    <div className="sg-results" style={{ marginBottom: 14 }}>
      <button type="button" onClick={toggle} style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }} aria-expanded={open}>
        <span>
          <span className="sg-results-title" style={{ display: 'block' }}>ICT / SMC POI</span>
          <span className="sg-results-sub" style={{ display: 'block' }}>Probability-based POI · A+ / B / C · double OB · liquidity sweeps</span>
        </span>
        <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>{open ? 'Hide' : 'Open'}</span>
      </button>
      {open && <PoiPanel />}
    </div>
  );
}

export default PoiSystemCard;
