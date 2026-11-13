'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';

const RESULT_META = {
  created: { label: 'Signal created', color: '#16a34a' },
  updated: { label: 'Signal updated', color: '#0ea5e9' },
  skipped: { label: 'Skipped', color: '#f59e0b' },
  filtered: { label: 'Setup filtered out', color: '#a855f7' },
  no_setup: { label: 'No setup', color: '#94a3b8' },
  no_price: { label: 'No price', color: '#f97316' },
  error: { label: 'Error', color: '#dc2626' },
};

const fmtAgo = (iso, now) => {
  if (!iso) return '—';
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s ago`;
  const h = Math.floor(sec / 3600);
  return `${h}h ${Math.floor((sec % 3600) / 60)}m ago`;
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtDur = (ms) =>
  ms == null
    ? '—'
    : ms >= 60000
      ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
      : `${(ms / 1000).toFixed(1)}s`;

function Badge({ r }) {
  const m = RESULT_META[r] || { label: r, color: '#64748b' };
  return (
    <span
      style={{
        background: m.color + '22',
        color: m.color,
        border: `1px solid ${m.color}55`,
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}
    >
      {m.label}
    </span>
  );
}

function Stat({ label, value, tone, sub }) {
  return (
    <div
      style={{
        flex: '1 1 110px',
        minWidth: 100,
        padding: '8px 10px',
        border: '1px solid var(--border, #e2e8f0)',
        borderRadius: 10,
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 600, color: tone }}>{value}</div>
      {sub ? <div style={{ fontSize: 10, opacity: 0.65, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

export default function ScanLogPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [auto, setAuto] = useState(true);
  const [tab, setTab] = useState('latest');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [now, setNow] = useState(Date.now());
  const [resetBusy, setResetBusy] = useState(false);
  const [flash, setFlash] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/scan-log', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Load failed');
      setData(json);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [auto, load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const run = data?.lastFull || null;
  const coins = run?.coins || [];

  const counts = useMemo(() => {
    const c = {};
    for (const x of coins) c[x.r] = (c[x.r] || 0) + 1;
    return c;
  }, [coins]);

  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return coins.filter((c) => (filter === 'all' || c.r === filter) && (!needle || c.s.includes(needle)));
  }, [coins, filter, q]);

  const parts = data?.parts || 3;
  const intervalMin = data?.intervalMinutes || 5;
  const budgetSec = data?.budgetSeconds ?? 40;
  const cycleMin = parts * intervalMin;

  const coverage = useMemo(() => {
    const map = data?.coinStatus || {};
    const cycleMs = cycleMin * 60000;
    const rows = Object.entries(map).map(([s, v]) => ({
      s,
      ...v,
      ageMs: now - new Date(v.at).getTime(),
    }));
    rows.sort((a, b) => a.ageMs - b.ageMs); // newest first for "recent"
    const fresh = rows.filter((r) => r.ageMs <= cycleMs).length;
    const totalUniverse = Math.max(run?.totalSymbols || 0, rows.length, (run?.pending?.length || 0) + coins.length);
    const pending = run?.pending?.length || 0;
    const scannedThisRun = coins.length;
    const pct = totalUniverse > 0 ? Math.min(100, Math.round((fresh / totalUniverse) * 100)) : 0;
    return {
      rows,
      fresh,
      totalUniverse,
      pending,
      scannedThisRun,
      pct,
      oldest: rows.length ? rows[rows.length - 1] : null,
      newest: rows[0] || null,
    };
  }, [data, now, cycleMin, run, coins.length]);

  async function resetProgress() {
    if (
      !window.confirm(
        'Clear all scan progress for this exchange and start from coin #1 on the next run?\n\n(Does NOT delete signals — only scan cursors / logs.)'
      )
    ) {
      return;
    }
    setResetBusy(true);
    setFlash(null);
    try {
      const res = await fetch('/api/admin/scan-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_progress', exchange: data?.exchange || 'binance' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Reset failed');
      setFlash(json.msg || 'Scan progress cleared — next run starts from the beginning');
      await load();
    } catch (e) {
      setFlash(e.message);
    } finally {
      setResetBusy(false);
    }
  }

  if (err && !data) return <div className="card">Scan log error: {err}</div>;
  if (!data) return <div className="card">Loading scan log…</div>;

  const live = data.live;
  const running = live?.status === 'running';
  const lastFinishedMs = run?.finishedAt ? now - new Date(run.finishedAt).getTime() : null;
  const stale =
    data.autoScanEnabled &&
    (lastFinishedMs == null || lastFinishedMs > (intervalMin * 2 + 1) * 60000);

  const health = data.ban
    ? {
        tone: '#dc2626',
        text: `Binance temporarily blocked this server IP until ${fmtTime(data.ban.until)}. Scans pause automatically.`,
      }
    : !data.autoScanEnabled
      ? { tone: '#f59e0b', text: 'Auto-scan is OFF — turn it on from Home.' }
      : stale && !running
        ? {
            tone: '#dc2626',
            text: `No full-scan finished in ~${intervalMin * 2 + 1} min — check cron-job.org URL/secret.`,
          }
        : {
            tone: '#16a34a',
            text: running ? 'A scan is running right now.' : 'Scans are running normally.',
          };

  const stoppedEarly =
    run?.stoppedBy === 'ban' ||
    run?.stoppedBy === 'weight' ||
    run?.partial ||
    (run?.pending && run.pending.length > 0);

  const th = { textAlign: 'left', whiteSpace: 'nowrap' };

  return (
    <div className="card">
      <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <div className="card-title" style={{ marginRight: 'auto' }}>
          Scan log · {data.exchange}
        </div>
        <label className="form-hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh
        </label>
        <button className="btn btn-secondary btn-sm" type="button" onClick={load}>
          Refresh
        </button>
        <button className="btn btn-secondary btn-sm" type="button" disabled={resetBusy} onClick={resetProgress}>
          {resetBusy ? 'Resetting…' : 'Reset progress'}
        </button>
      </div>

      {flash && (
        <p className="form-hint" style={{ marginBottom: 10, color: 'var(--primary)' }}>
          {flash}
        </p>
      )}

      {/* ── Easy progress board ── */}
      <div
        style={{
          marginBottom: 14,
          padding: 12,
          borderRadius: 14,
          border: '1px solid var(--border)',
          background: 'var(--border-light, #f8fafc)',
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Progress (easy view)</div>
        <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
          Coin list is split into <b>{parts} parts</b>. Each full-scan tick does <b>1 part</b> for up to{' '}
          <b>{budgetSec}s</b>, every <b>{intervalMin} min</b>.
          <br />
          Full board once ≈ <b>{cycleMin} minutes</b> ({parts} × {intervalMin} min).
        </div>

        <div style={{ height: 12, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden', marginBottom: 8 }}>
          <div
            style={{
              height: '100%',
              width: `${coverage.pct}%`,
              background: 'linear-gradient(90deg, #3b82f6, #22c55e)',
              transition: 'width .4s ease',
            }}
          />
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          This cycle: ~{coverage.fresh} / {coverage.totalUniverse || '—'} coins scanned recently ({coverage.pct}%)
        </div>

        <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <Stat label="Last run scanned" value={coverage.scannedThisRun} sub={run?.finishedAt ? fmtAgo(run.finishedAt, now) : '—'} />
          <Stat
            label="Left for later ticks"
            value={coverage.pending}
            tone={coverage.pending ? '#f59e0b' : '#16a34a'}
            sub={coverage.pending ? 'Normal — next ticks continue' : 'None pending'}
          />
          <Stat
            label="Part this run"
            value={run?.part != null ? `${run.part} / ${run.parts || parts}` : `— / ${parts}`}
            sub={`Budget ${fmtDur(run?.budgetMs ?? budgetSec * 1000)}`}
          />
          <Stat
            label="Full cycle ETA"
            value={`~${cycleMin} min`}
            sub={`Next full-scan: ${data.nextFullScanAt ? fmtAgo(data.nextFullScanAt, now).replace(' ago', '') : '—'}`}
          />
        </div>

        <div
          style={{
            fontSize: 12,
            lineHeight: 1.45,
            padding: '8px 10px',
            borderRadius: 10,
            background: stoppedEarly ? '#fff7ed' : '#f0fdf4',
            border: `1px solid ${stoppedEarly ? '#fed7aa' : '#bbf7d0'}`,
            color: '#0f172a',
          }}
        >
          {stoppedEarly ? (
            <>
              <b>Why “left for later”?</b> Last run stopped early on purpose — either the{' '}
              <b>{budgetSec}s time budget</b> ended, or Binance <b>API weight</b> got high (IP protection).
              Those coins are <b>not failed</b>; the next ticks pick them up. Example: 410 left means
              more ticks still needed before the whole list is covered (~{cycleMin} min cycle).
            </>
          ) : (
            <>
              <b>Status:</b> Last run finished its slice. Watch the bar above — when it nears 100% within
              a ~{cycleMin} min window, the whole list was touched recently.
            </>
          )}
        </div>

        {coverage.newest && (
          <div className="form-hint" style={{ marginTop: 8 }}>
            Newest coin scan: <b>{coverage.newest.s}</b> ({fmtAgo(coverage.newest.at, now)}) · Oldest in
            map: <b>{coverage.oldest?.s || '—'}</b> ({coverage.oldest ? fmtAgo(coverage.oldest.at, now) : '—'}
            )
          </div>
        )}
      </div>

      <div
        style={{
          padding: '8px 10px',
          borderRadius: 10,
          marginBottom: 12,
          border: `1px solid ${health.tone}44`,
          background: health.tone + '14',
          color: health.tone,
          fontSize: 13,
        }}
      >
        {health.text}
      </div>

      <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="Auto-scan" value={data.autoScanEnabled ? 'ON' : 'OFF'} tone={data.autoScanEnabled ? '#16a34a' : '#f59e0b'} />
        <Stat label="Interval" value={`${intervalMin} min`} />
        <Stat label="Parts" value={parts} />
        <Stat label="Live" value={running ? 'RUNNING' : 'idle'} tone={running ? '#0ea5e9' : undefined} />
      </div>

      <div className="flex gap-8" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {['latest', 'history', 'coins'].map((t) => (
          <button
            key={t}
            type="button"
            className={`filter-pill ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'latest' ? 'Last full run' : t === 'history' ? 'History' : 'Per-coin map'}
          </button>
        ))}
      </div>

      {tab === 'latest' && (
        <>
          {!run ? (
            <p className="form-hint">No full-scan recorded yet for {data.exchange}.</p>
          ) : (
            <>
              <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
                <Stat label="Finished" value={fmtAgo(run.finishedAt, now)} sub={fmtTime(run.finishedAt)} />
                <Stat label="Duration" value={fmtDur(run.durationMs)} />
                <Stat label="Created" value={run.created ?? 0} tone="#16a34a" />
                <Stat label="Updated" value={run.updated ?? 0} tone="#0ea5e9" />
                <Stat label="Errors" value={run.errorCount ?? 0} tone={(run.errorCount || 0) > 0 ? '#dc2626' : undefined} />
              </div>

              {stoppedEarly && (
                <p className="form-hint" style={{ marginBottom: 10 }}>
                  Last run was stopped early to protect the IP (
                  {run.stoppedBy === 'ban' ? 'Binance ban' : 'Binance used-weight / time budget'}
                  ); {run.pending?.length || 0} coins left for later ticks.
                </p>
              )}

              <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                {Object.keys(RESULT_META).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`filter-pill ${filter === k ? 'active' : ''}`}
                    onClick={() => setFilter(filter === k ? 'all' : k)}
                  >
                    {RESULT_META[k].label} ({counts[k] || 0})
                  </button>
                ))}
                <button type="button" className={`filter-pill ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
                  All ({coins.length})
                </button>
                <input
                  className="form-input"
                  style={{ maxWidth: 160 }}
                  placeholder="Search symbol"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>

              <div style={{ overflowX: 'auto', maxHeight: 420 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={th}>#</th>
                      <th style={th}>Symbol</th>
                      <th style={th}>Result</th>
                      <th style={th}>ms</th>
                      <th style={th}>f/c/u</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((c, i) => (
                      <tr key={c.s + i} style={{ borderTop: '1px solid var(--border-light)' }}>
                        <td>{i + 1}</td>
                        <td style={{ fontWeight: 700 }}>{c.s}</td>
                        <td>
                          <Badge r={c.r} />
                        </td>
                        <td>{c.ms ?? '—'}</td>
                        <td>
                          {c.f || 0}/{c.c || 0}/{c.u || 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {run.pending?.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary className="form-hint">
                    Left for later ticks ({run.pending.length}) — not errors; next ticks continue
                  </summary>
                  <p style={{ fontSize: 12, lineHeight: 1.5, marginTop: 6, wordBreak: 'break-word' }}>
                    {run.pending.join(', ')}
                  </p>
                </details>
              )}
            </>
          )}
        </>
      )}

      {tab === 'history' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={th}>Finished</th>
                <th style={th}>Part</th>
                <th style={th}>Duration</th>
                <th style={th}>Created</th>
                <th style={th}>Pending</th>
              </tr>
            </thead>
            <tbody>
              {(data.historyFull || []).map((h, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border-light)' }}>
                  <td>{fmtAgo(h.finishedAt, now)}</td>
                  <td>
                    {h.part != null ? `${h.part}/${h.parts || parts}` : '—'}
                  </td>
                  <td>{fmtDur(h.durationMs)}</td>
                  <td>{h.created ?? 0}</td>
                  <td>{h.pendingCount ?? h.pending?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(data.historyFull || []).length && <p className="form-hint">No history yet.</p>}
        </div>
      )}

      {tab === 'coins' && (
        <div style={{ overflowX: 'auto', maxHeight: 480 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={th}>Symbol</th>
                <th style={th}>Last scan</th>
                <th style={th}>Result</th>
                <th style={th}>Part</th>
              </tr>
            </thead>
            <tbody>
              {coverage.rows.slice(0, 400).map((r) => (
                <tr key={r.s} style={{ borderTop: '1px solid var(--border-light)' }}>
                  <td style={{ fontWeight: 700 }}>{r.s}</td>
                  <td>{fmtAgo(r.at, now)}</td>
                  <td>
                    <Badge r={r.r} />
                  </td>
                  <td>{r.part ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!coverage.rows.length && <p className="form-hint">No per-coin data yet.</p>}
        </div>
      )}
    </div>
  );
}
