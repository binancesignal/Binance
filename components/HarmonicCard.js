'use client';

/**
 * Harmonic Patterns — Signals-tab card (admin).
 * Gartley / Bat / Butterfly / Crab / Cypher / Shark / AB=CD …
 * Projected XABC→D (Waiting / Entry ready) + completed XABCD (Formed).
 * Per-pattern Fib ratios editable in Settings.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import SkChart from './SkChart.js';

const BUCKETS = [
  ['all', 'All'],
  ['waiting', 'Waiting'],
  ['entry_ready', 'Entry ready'],
  ['formed', 'Formed'],
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

const DEFAULT_RULES = {
  GARTLEY: { label: 'Gartley', xbMin: 0.55, xbMax: 0.68, bcMin: 0.382, bcMax: 0.886, xdMin: 0.75, xdMax: 0.82, target: 'xa', ratio: 0.786 },
  BAT: { label: 'Bat', xbMin: 0.35, xbMax: 0.55, bcMin: 0.382, bcMax: 0.886, xdMin: 0.85, xdMax: 0.92, target: 'xa', ratio: 0.886 },
  ALT_BAT: { label: 'Alternate Bat', xbMin: 0.33, xbMax: 0.45, bcMin: 0.382, bcMax: 0.886, xdMin: 1.08, xdMax: 1.18, target: 'xa', ratio: 1.13 },
  DEEP_BAT: { label: 'Deep Bat', xbMin: 0.82, xbMax: 0.95, bcMin: 0.382, bcMax: 0.886, xdMin: 0.85, xdMax: 0.92, target: 'xa', ratio: 0.886 },
  BUTTERFLY: { label: 'Butterfly', xbMin: 0.72, xbMax: 0.86, bcMin: 0.382, bcMax: 0.886, xdMin: 1.2, xdMax: 1.5, target: 'xa', ratio: 1.272 },
  CRAB: { label: 'Crab', xbMin: 0.35, xbMax: 0.65, bcMin: 0.382, bcMax: 0.886, xdMin: 1.5, xdMax: 1.72, target: 'xa', ratio: 1.618 },
  DEEP_CRAB: { label: 'Deep Crab', xbMin: 0.82, xbMax: 0.95, bcMin: 0.382, bcMax: 0.886, xdMin: 1.5, xdMax: 1.72, target: 'xa', ratio: 1.618 },
  CYPHER: { label: 'Cypher', xbMin: 0.35, xbMax: 0.65, bcMin: 0, bcMax: 99, xcMin: 1.13, xcMax: 1.414, xdMin: 0.75, xdMax: 0.82, target: 'xc', ratio: 0.786 },
  SHARK: { label: 'Shark', xbMin: 0.35, xbMax: 0.65, bcMin: 0, bcMax: 99, xcMin: 1.13, xcMax: 1.7, xdMin: 0.85, xdMax: 1.15, target: 'xc', ratio: 0.886 },
  ABCD: { label: 'AB=CD', xbMin: 0.35, xbMax: 0.92, bcMin: 0.35, bcMax: 0.92, cdAbMin: 0.88, cdAbMax: 1.2, target: 'ab', ratio: 1 },
};

const FAMILY_ORDER = ['GARTLEY', 'BAT', 'BUTTERFLY', 'CRAB', 'CYPHER', 'SHARK', 'ABCD', 'ALT_BAT', 'DEEP_BAT', 'DEEP_CRAB'];
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
  api('/api/harmonic-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
const fmtR = (v) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(3));

function cloneRules() {
  const o = {};
  for (const k of Object.keys(DEFAULT_RULES)) o[k] = { ...DEFAULT_RULES[k] };
  return o;
}

export function HarmonicPanel() {
  const [mode, setMode] = useState('pick');
  const [topN, setTopN] = useState(50);
  const [pick, setPick] = useState('BTC ETH SOL');
  const [tfs, setTfs] = useState(['15m', '1h', '4h']);
  const [bucket, setBucket] = useState('all');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [msg, setMsg] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [showSet, setShowSet] = useState(false);
  const [enabled, setEnabled] = useState(() => [...FAMILY_ORDER]);
  const [rules, setRules] = useState(cloneRules);
  const [includeProjected, setIncludeProjected] = useState(true);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [minScore, setMinScore] = useState(55);
  const [preferEma200, setPreferEma200] = useState(false);
  const [requireEma200, setRequireEma200] = useState(false);
  const [preferBreaker, setPreferBreaker] = useState(false);
  const [requireBreaker, setRequireBreaker] = useState(false);
  const [enableBreakers, setEnableBreakers] = useState(true);
  const [editFamily, setEditFamily] = useState('GARTLEY');
  const [chartMode, setChartMode] = useState('both'); // svg | live | both
  const stop = useRef(false);

  const toggleTf = (tf) => setTfs((p) => (p.includes(tf) ? p.filter((x) => x !== tf) : [...p, tf]));
  const toggleFamily = (k) =>
    setEnabled((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const setRuleField = (family, field, value) => {
    setRules((prev) => ({
      ...prev,
      [family]: { ...prev[family], [field]: value === '' ? '' : +value },
    }));
  };

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
            enabledFamilies: enabled,
            ratioRules: rules,
            includeProjected,
            includeCompleted,
            minScore,
            preferEma200InDzone: preferEma200,
            requireEma200InDzone: requireEma200,
            enableBreakers,
            preferBreakerInDzone: preferBreaker,
            requireBreakerInDzone: requireBreaker,
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
      if (!stop.current) setMsg(`Done · ${found.length} setups`);
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  }, [mode, topN, pick, tfs, enabled, rules, includeProjected, includeCompleted, minScore, preferEma200, requireEma200, preferBreaker, requireBreaker, enableBreakers]);

  const filtered =
    bucket === 'all'
      ? items
      : items.filter((e) => {
          if (bucket === 'waiting') return e.status === 'WAITING';
          if (bucket === 'entry_ready') return e.status === 'ENTRY_READY';
          if (bucket === 'formed') return e.status === 'FORMED' || e.kind === 'COMPLETED';
          return true;
        });

  const counts = {
    all: items.length,
    waiting: items.filter((e) => e.status === 'WAITING').length,
    entry_ready: items.filter((e) => e.status === 'ENTRY_READY').length,
    formed: items.filter((e) => e.status === 'FORMED' || e.kind === 'COMPLETED').length,
  };

  const rf = rules[editFamily] || DEFAULT_RULES[editFamily];

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
          placeholder="e.g. BTC ETH SOL"
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
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { stop.current = true; }}>
            Stop
          </button>
        )}
      </div>

      {showSet && (
        <div style={{ background: 'rgba(128,128,128,0.08)', borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Patterns (tick to scan)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {FAMILY_ORDER.map((k) => (
              <label
                key={k}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  borderRadius: 8,
                  border: '1px solid rgba(128,128,128,0.25)',
                  cursor: 'pointer',
                  background: enabled.includes(k) ? 'rgba(22,163,74,0.12)' : 'transparent',
                }}
              >
                <input type="checkbox" checked={enabled.includes(k)} onChange={() => toggleFamily(k)} />
                {DEFAULT_RULES[k]?.label || k}
              </label>
            ))}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeProjected} onChange={(e) => setIncludeProjected(e.target.checked)} />
            Projected XABC → D (Waiting / Entry ready)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeCompleted} onChange={(e) => setIncludeCompleted(e.target.checked)} />
            Completed XABCD (Formed)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={preferEma200} onChange={(e) => setPreferEma200(e.target.checked)} />
            Prefer D zone near <b>EMA200</b> (score boost — mid / slightly above or below)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireEma200} onChange={(e) => setRequireEma200(e.target.checked)} />
            <b>Require</b> EMA200 inside / near D zone (filter)
          </label>
          <div style={{ fontWeight: 600, margin: '10px 0 6px' }}>Breaker Block Engine (defaults)</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={enableBreakers} onChange={(e) => setEnableBreakers(e.target.checked)} />
            Detect Bull / Bear breaker blocks on chart
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={preferBreaker} onChange={(e) => setPreferBreaker(e.target.checked)} />
            Prefer D zone with a <b>breaker block through the middle</b> (score boost)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireBreaker} onChange={(e) => setRequireBreaker(e.target.checked)} />
            <b>Require</b> breaker block overlapping D zone (only those setups)
          </label>
          <div style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 11, opacity: 0.7 }}>Chart view · </span>
            {[['both', 'SVG + Live'], ['svg', 'SVG only'], ['live', 'Live only']].map(([k, l]) => (
              <button
                key={k}
                type="button"
                className={chartMode === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
                style={{ marginRight: 4, ...(chartMode === k ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : {}) }}
                onClick={() => setChartMode(k)}
              >
                {l}
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, opacity: 0.7 }}>Min score</label>
            <input
              className="form-input"
              type="number"
              min={30}
              max={95}
              value={minScore}
              onChange={(e) => setMinScore(+e.target.value)}
              style={{ width: 90 }}
            />
          </div>

          <div style={{ fontWeight: 600, marginBottom: 6 }}>Edit ratios — pick a pattern</div>
          <select
            className="form-input"
            value={editFamily}
            onChange={(e) => setEditFamily(e.target.value)}
            style={{ marginBottom: 8 }}
          >
            {FAMILY_ORDER.map((k) => (
              <option key={k} value={k}>
                {DEFAULT_RULES[k]?.label || k}
              </option>
            ))}
          </select>

          {rf && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(110px,1fr))', gap: 8 }}>
              {[
                ['xbMin', 'XB min'],
                ['xbMax', 'XB max'],
                ['bcMin', 'BC min'],
                ['bcMax', 'BC max'],
                ['xdMin', 'XD min'],
                ['xdMax', 'XD max'],
                ['xcMin', 'XC min'],
                ['xcMax', 'XC max'],
                ['cdAbMin', 'CD/AB min'],
                ['cdAbMax', 'CD/AB max'],
                ['ratio', 'D ratio'],
              ]
                .filter(([f]) => rf[f] != null || ['xcMin', 'xcMax', 'cdAbMin', 'cdAbMax'].includes(f))
                .map(([field, lab]) => (
                  <div key={field}>
                    <label style={{ fontSize: 10, opacity: 0.65 }}>{lab}</label>
                    <input
                      className="form-input"
                      type="number"
                      step="0.001"
                      value={rf[field] ?? ''}
                      onChange={(e) => setRuleField(editFamily, field, e.target.value)}
                    />
                  </div>
                ))}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>
            Defaults follow classic harmonic ratios (Gartley 0.786, Bat 0.886, Butterfly 1.272, Crab 1.618, Cypher 0.786 of XC…). Type new values to tighten or loosen detection.
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => setRules(cloneRules())}
          >
            Reset all ratios to defaults
          </button>
        </div>
      )}

      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        {CHUNK} coins per request · XABC→D = Entry ready when price nears PRZ · chart shows D zone
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
          const key = `${e.symbol}|${e.tf}|${e.family}|${e.kind}|${e.C?.time || e.time}|${e.status}`;
          const isLong = e.direction === 'LONG';
          const open = openKey === key;
          const statusColor =
            e.status === 'ENTRY_READY' ? '#1D4ED8' : e.status === 'WAITING' ? '#B45309' : '#374151';
          const statusBg =
            e.status === 'ENTRY_READY' ? '#DBEAFE' : e.status === 'WAITING' ? '#FEF3C7' : '#F3F4F6';
          return (
            <div
              key={key}
              style={{
                border: '1px solid rgba(128,128,128,0.2)',
                borderRadius: 12,
                padding: 12,
                background: open ? 'rgba(124,58,237,0.04)' : 'transparent',
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
                        background: statusBg,
                        color: statusColor,
                      }}
                    >
                      {e.status}
                    </span>
                    <span
                      style={{
                        marginLeft: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 999,
                        background: '#EDE9FE',
                        color: '#5B21B6',
                      }}
                    >
                      {e.label || e.family}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 3 }}>
                    {e.kind === 'PROJECTED' ? 'XABC → D projected' : 'XABCD completed'} · score {e.score} ·{' '}
                    {fmtDate(e.time)} {fmtClock(e.time)}
                    {e.ema200InDzone && (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: '#1D4ED8' }}>EMA200 in D zone</span>
                    )}
                    {e.breakerInDzone && (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: '#DB2777' }}>
                        Breaker in D · {(e.breakers || []).map((b) => b.side).join('/')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 3, lineHeight: 1.45 }}>
                    <b>X</b> {fmtP(e.X?.price)} · <b>A</b> {fmtP(e.A?.price)} · <b>B</b> {fmtP(e.B?.price)} · <b>C</b>{' '}
                    {fmtP(e.C?.price)} · <b>D</b> {fmtP(e.D?.price ?? e.entry)}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    D zone <b>{fmtP(e.przLow)}</b> – <b>{fmtP(e.przHigh)}</b> · mid {fmtP(e.entry)}
                    {e.ema200 != null && <> · EMA200 {fmtP(e.ema200)}</>}
                  </div>
                  {(e.breakers || []).length > 0 && (
                    <div style={{ fontSize: 12, marginTop: 2, color: '#BE185D' }}>
                      {(e.breakers || []).map((b) => (
                        <div key={b.id}>
                          <b>{b.side} BREAKER</b> {fmtP(b.bot)}–{fmtP(b.top)} · Q{Math.round(b.quality)} · {b.action || b.state}
                          {' · '}inv {fmtP(b.invalidLevel)} · tgt {fmtP(b.targetLevel)}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    XB {fmtR(e.ratios?.xb)} · BC {fmtR(e.ratios?.bc)} · XD {fmtR(e.ratios?.xd)}
                  </div>
                  {e.plan && (
                    <div style={{ fontSize: 12, marginTop: 3 }}>
                      <span style={{ color: '#16A34A' }}>Entry {fmtP(e.plan.entry)}</span>
                      {' · '}
                      <span style={{ color: '#DC2626' }}>SL {fmtP(e.plan.sl)}</span>
                      {' · '}
                      <span style={{ color: '#059669' }}>
                        TP1 {fmtP(e.plan.tp1)} (R{e.plan.rr1}) · TP2 {fmtP(e.plan.tp2)} (R{e.plan.rr2}) · TP3{' '}
                        {fmtP(e.plan.tp3)} · TP4 {fmtP(e.plan.tp4)}
                      </span>
                    </div>
                  )}
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpenKey(open ? null : key)}>
                  {open ? 'Hide' : 'Chart'}
                </button>
              </div>
              {open && (
                <div style={{ marginTop: 10 }}>
                  {(chartMode === 'svg' || chartMode === 'both') && e.chartSvg && (
                    <div style={{ overflowX: 'auto', marginBottom: chartMode === 'both' ? 12 : 0 }} dangerouslySetInnerHTML={{ __html: e.chartSvg }} />
                  )}
                  {(chartMode === 'live' || chartMode === 'both') && (
                    <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(128,128,128,0.2)' }}>
                      <div style={{ fontSize: 11, opacity: 0.65, padding: '6px 10px' }}>
                        Live chart · pan / zoom · XABCD · D zone · SL/TP · EMA200
                      </div>
                      <SkChart
                        symbol={e.symbol}
                        annotations={e.annotations || []}
                        dir={e.direction === 'LONG' ? 'long' : 'short'}
                        defaultTf={e.tf}
                        fitFromTime={e.X?.time || e.C?.time}
                        height={420}
                      />
                    </div>
                  )}
                  {!e.chartSvg && chartMode === 'svg' && (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>Chart not available.</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HarmonicCard() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem('harmonic_card_open');
      if (v === '0') setOpen(false);
      if (v === '1') setOpen(true);
    } catch (_) {}
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem('harmonic_card_open', o ? '0' : '1');
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
            Harmonic Patterns
          </span>
          <span className="sg-results-sub" style={{ display: 'block' }}>
            Gartley · Bat · Butterfly · Crab · Cypher · Shark · AB=CD · Breaker blocks · D zone confluence
          </span>
        </span>
        <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>
          {open ? 'Hide' : 'Open'}
        </span>
      </button>
      {open && <HarmonicPanel />}
    </div>
  );
}

export default HarmonicCard;
