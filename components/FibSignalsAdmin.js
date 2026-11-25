'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const REF_LABEL = { '1d': 'Daily', '1w': 'Weekly', '1M': 'Month', '3M': '3 Month', '1Y': '1 Year' };
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(+d) ? '—' : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

function CheckRow({ items, selected, onChange, label }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
      {items.map((it) => {
        const v = typeof it === 'object' ? it.value : it;
        const text = typeof it === 'object' ? it.label : label ? label(it) : String(it);
        const on = selected.some((x) => (typeof v === 'number' ? Math.abs(x - v) < 1e-9 : x === v));
        return (
          <label key={String(v)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => onChange(e.target.checked ? [...selected, v] : selected.filter((x) => (typeof v === 'number' ? Math.abs(x - v) > 1e-9 : x !== v)))}
            />
            {text}
          </label>
        );
      })}
    </div>
  );
}

export default function FibSignalsAdmin() {
  const [snap, setSnap] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [msg, setMsg] = useState(null);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/fib-signals', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      setSnap(data);
      setCfg((c) => c || data.config);
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (!running) load();
    }, 20000);
    return () => clearInterval(id);
  }, [load, running]);

  if (!snap || !cfg) return <div className="card">{msg ? msg.text : 'Loading…'}</div>;

  const opts = snap.options;
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));

  async function save(next) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/fib-signals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: next || cfg }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSnap(data);
      setCfg(data.config);
      setMsg({ ok: true, text: data.config.enabled ? 'Saved — strategy scan is ON. Cron scans all coins and publishes signals to the Scanner tab.' : 'Saved — strategy scan is OFF.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function scanAllNow() {
    stopRef.current = false;
    setRunning(true);
    setMsg(null);
    let created = 0;
    let scanned = 0;
    let first = true;
    try {
      await fetch('/api/admin/fib-signals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unlock' }) }).catch(() => null);
      for (let i = 0; i < 80 && !stopRef.current; i++) {
        const res = await fetch('/api/admin/fib-signals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run', reset: first }),
        });
        first = false;
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scan failed');
        setSnap(data);
        const r = data.result || {};
        if (r.skipped) throw new Error(r.reason || 'skipped');
        created += r.created || 0;
        scanned += r.scanned || 0;
        setProgress({ offset: r.offset ?? 0, total: r.total || 0, scanned, created, stopped: r.stopped, sweepDone: r.sweepDone });
        if (r.stopped === 'banned') throw new Error('Binance rate limit (ban) — stopped. Try again later.');
        if (r.stopped === 'throttled') await new Promise((x) => setTimeout(x, 20000));
        if (r.sweepDone) break;
      }
      setMsg({ ok: true, text: `Done — ${scanned} coins scanned · +${created} new signal(s).` });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setRunning(false);
      setProgress(null);
      load();
    }
  }

  async function clearAll() {
    if (!window.confirm('Delete ALL published Fib Signals (active + closed)?')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/fib-signals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clear' }) });
      const data = await res.json();
      if (res.ok) setSnap(data);
    } finally {
      setBusy(false);
    }
  }

  const st = snap.status || {};
  const pct = progress?.total ? Math.round((progress.offset / progress.total) * 100) : 0;
  const dirty = JSON.stringify(cfg) !== JSON.stringify(snap.config);

  return (
    <div className="admin-section">
      <h2>Strategy — OB + HTF Fib signals</h2>
      <p className="card-subtitle" style={{ marginBottom: 12 }}>
        Pick the Fib time frames, Fib lines and LTFs → Save → switch ON. Cron then scans every Binance coin and publishes plain, professional signals
        (Entry · SL · TP1-3 · RR) for manual trading. No Watching / Ready / Ongoing stages and no strategy gates.
      </p>

      {msg && (
        <div className="card" style={{ marginBottom: 12, background: msg.ok ? 'var(--primary-soft)' : '#fee2e2' }}>
          {msg.text}
        </div>
      )}

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="card-title" style={{ marginBottom: 2 }}>Strategy scan</div>
            <div className="card-subtitle">{snap.config.enabled ? 'ON — runs on every cron tick' : 'OFF'}</div>
          </div>
          <button
            type="button"
            className={`btn ${snap.config.enabled ? 'btn-secondary' : 'btn-primary'}`}
            disabled={busy || running}
            onClick={() => save({ ...cfg, enabled: !snap.config.enabled })}
          >
            {snap.config.enabled ? 'Turn OFF' : 'Turn ON'}
          </button>
        </div>
        <div style={{ fontSize: 12, marginTop: 10, color: '#64748b', lineHeight: 1.6 }}>
          Last pass: <b>{fmtTime(st.at)}</b> · this pass {st.scanned ?? 0}/{st.total ?? '—'} coins · sweeps completed: <b>{snap.cursor?.cycles ?? 0}</b> · next starts at coin #
          {snap.cursor?.offset ?? 0}
          <br />
          Active signals: <b>{snap.counts.active}</b> · closed (14d): {snap.counts.closed}
          {st.errors?.length ? <><br />Last errors: {st.errors.slice(0, 3).join(' · ')}</> : null}
        </div>
      </div>

      <div className="card">
        <div className="form-label">Fib time frames (HTF)</div>
        <CheckRow items={opts.refTfs} selected={cfg.refTimeframes} onChange={(v) => set({ refTimeframes: v })} label={(t) => REF_LABEL[t] || t} />

        <div className="form-label">LTF (Order Block)</div>
        <CheckRow items={opts.ltfs} selected={cfg.timeframes} onChange={(v) => set({ timeframes: v })} />

        <div className="form-label">Fib lines (price levels)</div>
        <CheckRow items={opts.levels} selected={cfg.fibLevels} onChange={(v) => set({ fibLevels: [...v].sort((a, b) => a - b) })} />

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 4, fontSize: 13 }}>
          <input type="checkbox" checked={!!cfg.firstTouchOnly} onChange={(e) => set({ firstTouchOnly: e.target.checked })} style={{ marginTop: 3 }} />
          <span>
            <b>First-touch Fib only</b>
            <span className="card-subtitle" style={{ display: 'block' }}>
              ON → only Fib lines that price has NEVER touched since that Fib candle closed (the first reaction is the strongest). Checked on daily candles, so it covers
              every intraday touch.
            </span>
          </span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
          Retire un-filled signals after
          <input
            type="number"
            min={0}
            max={60}
            value={cfg.expireDays}
            onChange={(e) => set({ expireDays: +e.target.value })}
            style={{ width: 64, padding: '4px 6px', borderRadius: 8, border: '1px solid var(--border, #cbd5e1)' }}
          />
          days (0 = never)
        </label>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-primary" disabled={busy || running || !dirty} onClick={() => save()}>
            {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          {!running ? (
            <button type="button" className="btn btn-secondary" disabled={busy || dirty} onClick={scanAllNow}>
              Scan all coins now
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => { stopRef.current = true; }}>
              Stop
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={busy || running} onClick={clearAll}>
            Clear all signals
          </button>
        </div>
        {dirty && <div className="card-subtitle" style={{ marginTop: 6 }}>Unsaved changes — Save first (a new selection restarts the sweep).</div>}

        {progress && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>
              Scanning… coin {progress.offset}/{progress.total || '…'} ({pct}%) · +{progress.created} new signal(s)
              {progress.stopped === 'throttled' ? ' · rate limit, waiting 20s…' : ''}
            </div>
            <div style={{ height: 6, borderRadius: 4, background: '#E2E8F0', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: '#16A34A', transition: 'width .3s' }} />
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 12, fontSize: 12, color: '#64748b', lineHeight: 1.7 }}>
        <b>How it runs:</b> while ON, every tick of your existing cron job (<code>/api/cron/full-scan</code>) also runs one Fib Signals pass — it works even if the main
        auto-scan is OFF. You can alternatively point a cron job at <code>/api/cron/fib-signals?secret=…</code>. Each pass scans the next slice of coins (highest volume first)
        and tracks entry / TP / SL of published signals; repeated passes sweep the whole market.
      </div>
    </div>
  );
}
