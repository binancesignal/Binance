'use client';

import { useCallback, useEffect, useState } from 'react';

async function api(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function Num({ label, k, cfg, set, step = 1, hint }) {
  return (
    <label style={{ display: 'block', fontSize: 12.5 }}>
      <span style={{ color: '#475569' }}>{label}</span>
      <input type="number" className="cs-input" step={step} style={{ width: '100%', marginTop: 2 }} value={cfg[k] ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? '' : +e.target.value })} />
      {hint && <span style={{ color: '#94A3B8', fontSize: 11 }}>{hint}</span>}
    </label>
  );
}
function Sel({ label, k, cfg, set, opts }) {
  return (
    <label style={{ display: 'block', fontSize: 12.5 }}>
      <span style={{ color: '#475569' }}>{label}</span>
      <select className="cs-input" style={{ width: '100%', marginTop: 2 }} value={cfg[k]} onChange={(e) => set({ [k]: isNaN(+e.target.value) || e.target.value === '' ? e.target.value : +e.target.value })}>
        {opts.map(([v, l]) => <option key={String(v)} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
function Checks({ label, items, selected, onChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="form-label">{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {items.map((v) => (
          <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
            <input type="checkbox" checked={selected.includes(v)} onChange={(e) => onChange(e.target.checked ? [...selected, v] : selected.filter((x) => x !== v))} />
            {String(v).toUpperCase()}
          </label>
        ))}
      </div>
    </div>
  );
}
const Grid = ({ children }) => <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>{children}</div>;

/** Admin → SK System: every SK SYSTEM PRO setting (validated server-side; other strategies are not affected) */
export default function SkSystemAdmin() {
  const [snap, setSnap] = useState(null);
  const [cfgs, setCfgs] = useState(null); // { 1: Setup 1 config, 2: Setup 2 config }
  const [tab, setTab] = useState(1); // which setup is being edited
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api('/api/admin/sk-system');
      setSnap(d);
      setCfgs({ 1: d.config, 2: d.config2 });
      setDirty(false);
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!cfgs || !snap) return <div className="admin-section"><div className="card-subtitle">{msg?.text || 'Loading…'}</div></div>;
  const cfg = cfgs[tab] || cfgs[1];
  const two = tab === 2;
  const set = (patch) => { setCfgs((c) => ({ ...c, [tab]: { ...c[tab], ...patch } })); setDirty(true); };
  // Setup 2 has its own allowed time frames; the rest of the options are shared
  const o = two ? { ...snap.options, primaryTfs: snap.options2.primaryTfs, confirmTfs: snap.options2.confirmTfs } : snap.options;
  const T = two ? { hi: '1D', lo: '4H', pri: '1H', st: '15M', vol: '5M/3M', anchor: '1H C swing', tpStruct: '15M high → 1H B → D' } : { hi: '1W', lo: '1D', pri: '4H', st: '1H', vol: '15M/5M', anchor: '4H C swing', tpStruct: '1H high → 4H B → D' };
  const switchTab = (n) => {
    if (dirty && !window.confirm('You have unsaved changes in this setup — switch anyway? (they stay on screen until you reload)')) return;
    setTab(n);
  };

  const save = async () => {
    setBusy(true);
    try {
      const d = await api('/api/admin/sk-system', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setup: tab, config: cfg }) });
      setSnap(d);
      setCfgs({ 1: d.config, 2: d.config2 });
      setDirty(false);
      setMsg({ ok: true, text: d.notes?.length ? `Saved with adjustments: ${d.notes.join(' · ')}` : 'Saved.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
    setBusy(false);
  };
  const act = async (body, okText) => {
    setBusy(true);
    try {
      const d = await api('/api/admin/sk-system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (d.config) { setSnap(d); setCfgs({ 1: d.config, 2: d.config2 }); setDirty(false); }
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
    setBusy(false);
  };

  return (
    <div className="admin-section">
      <p className="card-subtitle" style={{ marginBottom: 12 }}>
        SK SYSTEM PRO has two independent setups. <b>Setup 1 (swing)</b>: 1W → 1D → 4H CHoCH · Fib · ABCD → C zone → 2H/1H/30M/15M/5M → entry → D. <b>Setup 2 (intraday)</b>: 1D → 4H → 1H CHoCH · Fib · ABCD → C zone → 30M/15M/5M/3M → entry → D. These settings affect only SK SYSTEM PRO.
      </p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button type="button" className={`cs-chip${tab === 1 ? ' on' : ''}`} onClick={() => switchTab(1)}>Setup 1 · 4H swing</button>
        <button type="button" className={`cs-chip${tab === 2 ? ' on' : ''}`} onClick={() => switchTab(2)}>Setup 2 · 1H intraday{cfgs[2]?.enabled ? '' : ' (off)'}</button>
      </div>
      {snap.migration === 'missing' && (
        <div className="card" style={{ marginBottom: 12, background: '#fee2e2' }}>
          Database tables missing — run <code>sql/012_sk_system.sql</code> (or <code>supabase/migrations/008_sk_system.sql</code>) in Supabase, then reload.
        </div>
      )}
      {msg && <div className="card" style={{ marginBottom: 12, background: msg.ok ? 'var(--primary-soft)' : '#fee2e2' }}>{msg.text}</div>}

      <div className="card" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div className="card-title" style={{ marginBottom: 2 }}>{two ? 'SETUP 2 · 1H intraday' : 'SK SYSTEM PRO (master switch · Setup 1)'}</div>
          <div className="card-subtitle">{cfg.enabled ? 'ENABLED' : 'DISABLED'}{two ? (cfgs[1].enabled ? '' : ' · master switch (Setup 1 tab) is OFF, so nothing scans') : ''}{snap.counts ? ` · ${snap.counts.total} setups stored (${snap.counts.open} open)` : ''}</div>
        </div>
        <button type="button" className={`btn ${cfg.enabled ? 'btn-secondary' : 'btn-primary'}`} onClick={() => set({ enabled: !cfg.enabled })}>{cfg.enabled ? 'Disable' : 'Enable'}</button>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Timeframes</div>
        <Grid>
          <Sel label="Primary setup timeframe" k="primaryTf" cfg={cfg} set={set} opts={o.primaryTfs.map((t) => [t, t.toUpperCase()])} />
          <Sel label={`${T.hi} / ${T.lo} alignment`} k="htfAlignment" cfg={cfg} set={set} opts={[['standard', `Standard (${T.lo} agrees, ${T.hi} not opposed)`], ['strict', `Strict (${T.hi} + ${T.lo} agree)`], ['off', 'Off']]} />
          <Sel label="Swing sensitivity" k="swingSensitivity" cfg={cfg} set={set} opts={[['low', 'Low (5 bars)'], ['medium', 'Medium (3 bars)'], ['high', 'High (2 bars)']]} />
        </Grid>
        <Checks label={`Secondary confirmation timeframes (${T.st} CHoCH is always required)`} items={o.confirmTfs} selected={cfg.confirmTfs} onChange={(v) => set({ confirmTfs: v })} />
        <div className="card-subtitle">{T.hi}, {T.lo}, {T.pri} and {T.st} are always loaded. Disabled confirmation steps are skipped.{two ? ' More confirmations = fewer but cleaner signals; fewer = more signals.' : ''}</div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>CHoCH · Fibonacci · ABCD</div>
        <Grid>
          <Sel label="CHoCH confirmation" k="chochMode" cfg={cfg} set={set} opts={[['close', 'Candle close beyond level'], ['close_atr', 'Close beyond level + ATR buffer']]} />
          <Num label="CHoCH ATR buffer" k="chochAtrBuffer" cfg={cfg} set={set} step={0.05} />
          <Num label="CHoCH max age (bars)" k="chochMaxAgeBars" cfg={cfg} set={set} />
          <Num label="Fib tolerance" k="fibTolerance" cfg={cfg} set={set} step={0.01} />
          <Num label="ABCD tolerance" k="abcdTolerance" cfg={cfg} set={set} step={0.01} />
          <Num label="Min BC retrace" k="abcdMinRetrace" cfg={cfg} set={set} step={0.01} />
          <Num label="Max BC retrace" k="abcdMaxRetrace" cfg={cfg} set={set} step={0.01} />
          <Num label="Min AB size (ATR)" k="minAbAtr" cfg={cfg} set={set} step={0.5} />
          <Num label="C zone from" k="cZoneFrom" cfg={cfg} set={set} step={0.01} />
          <Num label="C zone to" k="cZoneTo" cfg={cfg} set={set} step={0.01} />
          <Sel label="D extension (CD = AB ×)" k="dExtension" cfg={cfg} set={set} opts={[[1, '1.0'], [1.272, '1.272'], [1.618, '1.618']]} />
        </Grid>
        <Checks label="Fibonacci levels drawn / used" items={o.fibLevels} selected={cfg.fibLevels} onChange={(v) => set({ fibLevels: v })} />
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Entry · stop loss · targets</div>
        <Grid>
          <Num label={`${T.st} Fib entry zone from`} k="entryFibFrom" cfg={cfg} set={set} step={0.01} />
          <Num label={`${T.st} Fib entry zone to`} k="entryFibTo" cfg={cfg} set={set} step={0.01} />
          <Sel label="Entry mode" k="entryMode" cfg={cfg} set={set} opts={[['retest', 'Retest of the broken level (limit)'], ['close', 'Confirmation candle close']]} />
          <Sel label={`Volume confirmation (${T.vol})`} k="volumeConfirm" cfg={cfg} set={set} opts={[['off', 'Off'], ['prefer', 'Prefer (adds score)'], ['require', 'Require']]} />
          <Num label="Volume × average" k="volumeMult" cfg={cfg} set={set} step={0.1} />
          <Num label={`Stop loss buffer (ATR ${T.st})`} k="slBufferAtr" cfg={cfg} set={set} step={0.05} />
          <Sel label="Stop loss anchor" k="slAnchor" cfg={cfg} set={set} opts={[['ltf', 'Lower-TF pullback low'], ['c', T.anchor]]} />
          <Num label={`Max risk (ATR ${T.st})`} k="maxRiskAtr" cfg={cfg} set={set} step={0.5} />
          <Sel label="TP calculation" k="tpMethod" cfg={cfg} set={set} opts={[['structure', `Structure (${T.tpStruct})`], ['rr', 'R multiples']]} />
          <Num label="TP1 (R)" k="tp1R" cfg={cfg} set={set} step={0.1} />
          <Num label="TP2 (R)" k="tp2R" cfg={cfg} set={set} step={0.1} />
          <Num label="TP3 (R)" k="tp3R" cfg={cfg} set={set} step={0.1} />
          <Num label="Min risk : reward" k="minRR" cfg={cfg} set={set} step={0.1} />
          <Sel label="R:R measured to" k="minRRTarget" cfg={cfg} set={set} opts={[['tp1', 'TP1'], ['tp2', 'TP2'], ['tp3', 'TP3']]} />
          <Num label="Minimum setup score" k="minScore" cfg={cfg} set={set} />
          <Sel label="Store setups from stage" k="storeFromStage" cfg={cfg} set={set} opts={o.stages.slice(0, 8).map((s) => [s, s.replace(/_/g, ' ')])} />
        </Grid>
        {!two && (
          <Checks
            label="Public Scanner shows these buckets (everyone sees them)"
            items={['active', 'waiting', 'entry_ready', 'ongoing', 'completed', 'invalidated']}
            selected={cfg.visibleBuckets || []}
            onChange={(v) => set({ visibleBuckets: v })}
          />
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Scanning</div>
        {two && <div className="card-subtitle" style={{ marginBottom: 8 }}>Coin selection, Top N, ranking, speed, auto-scan and user limits are shared with Setup 1 (edit them on the Setup 1 tab). Every scan can run Setup 1, Setup 2 or both.</div>}
        {two ? (
          <Grid>
            <Num label="Max candle history" k="maxCandles" cfg={cfg} set={set} step={50} />
          </Grid>
        ) : (
        <Grid>
          <Sel label="Default scan universe" k="scanUniverse" cfg={cfg} set={set} opts={[['top', 'Top N'], ['all', 'All coins']]} />
          <Num label="Default Top N" k="topN" cfg={cfg} set={set} hint="presets 10 / 20 / 30 / 50 / 100 or any value" />
          <Sel label="Ranking method" k="rankingMethod" cfg={cfg} set={set} opts={o.rankings.map((r) => [r, r])} />
          <Num label="Max concurrent requests" k="maxConcurrent" cfg={cfg} set={set} />
          <Num label="Scan batch size" k="batchSize" cfg={cfg} set={set} />
          <Num label="Retry count" k="retryCount" cfg={cfg} set={set} />
          <Num label="Retry delay (ms)" k="retryDelayMs" cfg={cfg} set={set} step={100} />
          <Num label="Max candle history" k="maxCandles" cfg={cfg} set={set} step={50} />
          <Num label="Users: max coins per scan" k="userScanMax" cfg={cfg} set={set} step={10} hint="0 = users cannot scan · 600+ = all coins" />
          <Sel label="Auto-scan (cron)" k="autoScan" cfg={{ ...cfg, autoScan: cfg.autoScan ? 'on' : 'off' }} set={(p) => set({ autoScan: p.autoScan === 'on' })} opts={[['off', 'Off'], ['on', 'On']]} />
          <Num label="Auto-scan interval (min)" k="autoScanIntervalMin" cfg={cfg} set={set} />
        </Grid>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Lifecycle</div>
        <Grid>
          <Num label="Setup expiry (hours)" k="setupExpiryHours" cfg={cfg} set={set} />
          <Num label="Entry expiry after arming (hours)" k="entryExpiryHours" cfg={cfg} set={set} />
          {!two && <Num label="Max historical setups kept" k="maxHistory" cfg={cfg} set={set} />}
        </Grid>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={save}>Save settings</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'reset-defaults', setup: tab }, `Setup ${tab} defaults restored.`)}>Reset {two ? 'Setup 2' : 'Setup 1'} to defaults</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'unlock' }, 'Scan lock cleared.')}>Clear scan lock</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm('Delete ALL SK setups, events, snapshots and scan runs?') && window.prompt('Type DELETE to confirm') === 'DELETE') act({ action: 'clear-history', confirm: 'DELETE' }, 'SK history cleared.'); }}>Clear SK history</button>
      </div>
      {dirty && <div className="card-subtitle" style={{ marginTop: 6 }}>Unsaved changes.</div>}
    </div>
  );
}
