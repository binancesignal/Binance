'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SkChart from './SkChart.js';
import { harmonicCategory, pickBestPerCoin } from '../lib/scanner/strategy/harmonicScan/categories.js';

const COIN_COLORS = ['#F7931A', '#627EEA', '#26A17B', '#F0B90B', '#8247E5', '#E84142', '#00AEEF', '#16C784'];

const ADMIN_STATUSES = [
  'WAITING',
  'WATCHING',
  'ENTRY_READY',
  'IN_TRADE',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'SL_HIT',
  'INVALIDATED',
  'MISSED',
  'FORMED',
];

const TABS = [
  ['all', 'All'],
  ['entry_ready', 'Entry ready'],
  ['watching', 'Watching'],
  ['in_trade', 'In trade'],
  ['tp_hit', 'TP hit'],
  ['sl_hit', 'SL hit'],
  ['invalid', 'Missed'],
];

const STAGE = {
  entry_ready: { key: 'ready', label: 'Entry ready' },
  watching: { key: 'watching', label: 'Watching' },
  in_trade: { key: 'ongoing', label: 'In trade' },
  tp_hit: { key: 'tp', label: 'TP hit' },
  sl_hit: { key: 'sl', label: 'SL hit' },
  invalid: { key: 'watching', label: 'Missed' },
};

const RANK = { entry_ready: 0, in_trade: 1, watching: 2, tp_hit: 3, sl_hit: 4, invalid: 5 };

function baseAsset(sym) {
  return String(sym || '').toUpperCase().replace(/(USDT|USDC|BUSD|USD)$/, '');
}

function CoinIcon({ symbol, size = 46 }) {
  const base = baseAsset(symbol);
  const lower = base.toLowerCase();
  const sources = [
    `https://assets.coincap.io/assets/icons/${lower}@2x.png`,
    `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${lower}.png`,
  ];
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [lower]);
  const style = { width: size, height: size };
  if (i >= sources.length || !lower) {
    let h = 0;
    for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (
      <span className="coin-icon coin-icon-fallback" style={{ ...style, background: COIN_COLORS[h % COIN_COLORS.length] }}>
        {base.slice(0, 1)}
      </span>
    );
  }
  return <img className="coin-icon" style={style} src={sources[i]} alt="" loading="lazy" onError={() => setI((n) => n + 1)} />;
}

function fmtP(p) {
  if (p == null || !Number.isFinite(+p)) return '—';
  const a = Math.abs(+p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 6 : 7;
  return (+p).toFixed(dp);
}

function ago(sec) {
  if (!sec) return '—';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

const catOf = (e) => {
  const c = harmonicCategory(e.status);
  return c === 'formed' || c === 'other' ? 'watching' : c;
};

function DivBadge({ d }) {
  if (!d || !d.evaluatedAt) return null;
  if (!d.found) return <span className="sg-tag" style={{ opacity: 0.65 }}>No divergence</span>;
  const bear = d.bias === 'BEARISH';
  return (
    <span
      className="sg-tag"
      title={`Price X ${d.xPrice} → D ${d.dPrice} · RSI ${d.xRsi} → ${d.dRsi}`}
      style={{ fontWeight: 700, background: bear ? '#FEE2E2' : '#DCFCE7', color: bear ? '#B91C1C' : '#15803D' }}
    >
      {d.kind === 'HIDDEN' ? 'Hidden' : 'Regular'} {bear ? 'bearish' : 'bullish'} divergence
    </span>
  );
}

function statusLine(e, cat) {
  if (cat === 'tp_hit') {
    return e.tpLevel >= 3 ? 'All targets reached — TP1 ✅ TP2 ✅ TP3 ✅' : `TP${e.tpLevel} reached ✅ — remaining targets still open`;
  }
  if (cat === 'sl_hit') return 'Stop loss was hit.';
  if (cat === 'invalid') return String(e.status).toUpperCase() === 'MISSED' ? 'Price left the zone without entering — missed.' : 'Pattern invalidated.';
  if (cat === 'in_trade') return 'Price entered the entry zone — trade is live.';
  if (cat === 'entry_ready') return 'Price is at the entry zone — ready.';
  return 'Waiting for price to reach the entry zone.';
}

function FeedChart({ e, chartMode, isAdmin }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const isLong = String(e.direction || '').toUpperCase() === 'LONG';
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const res = await fetch('/api/harmonic-feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'render_chart', id: e.id, tzMin: -new Date().getTimezoneOffset() }),
          cache: 'no-store',
        });
        const d = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok || d.ok === false) throw new Error(d.error || 'Chart failed');
        setData(d);
      } catch (ex) {
        if (alive) setErr(ex.message || 'Chart failed');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [e.id]);

  // The live (interactive) chart needs the admin-only candle API → only admins get it
  const wantLive = isAdmin && (chartMode === 'live' || chartMode === 'both');
  return (
    <div style={{ marginTop: 12 }} onClick={(ev) => ev.stopPropagation()}>
      {loading && <div style={{ fontSize: 12, opacity: 0.65, padding: 8 }}>Loading chart…</div>}
      {err && <div style={{ fontSize: 12, color: '#DC2626', padding: 8 }}>{err}</div>}
      {data?.chartSvg && (
        <div style={{ overflowX: 'auto', marginBottom: wantLive ? 12 : 0, borderRadius: 12 }} dangerouslySetInnerHTML={{ __html: data.chartSvg }} />
      )}
      {wantLive && (
        <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(128,128,128,0.2)' }}>
          <SkChart
            symbol={e.symbol}
            annotations={data?.annotations || []}
            dir={isLong ? 'long' : 'short'}
            defaultTf={e.tf}
            fitFromTime={e.X?.time || e.C?.time}
            height={480}
            rsi
            divergence={e.divergence || null}
            divergenceTf={e.tf}
          />
        </div>
      )}
    </div>
  );
}

function SignalCard({ e, chartMode, isAdmin, onStatusChange, onStatusRelease, statusBusyId }) {
  const [open, setOpen] = useState(false);
  const cat = catOf(e);
  const stage = STAGE[cat] || STAGE.watching;
  const isLong = String(e.direction || '').toUpperCase() === 'LONG';
  const hitN = e.tpLevel || 0;
  const pillText = cat === 'tp_hit' ? `TP${hitN} ✅` : cat === 'sl_hit' ? 'SL hit ❌' : stage.label;
  const dist = e.price != null && e.entry ? ((e.price - e.entry) / e.entry) * 100 : null;
  const showDist = dist != null && Number.isFinite(dist) && (cat === 'watching' || cat === 'entry_ready');
  const tp = (n, v) => (
    <div className={`sg-lv lv-tp${hitN >= n ? ' hit' : ''}`}>
      <span>TP{n}{hitN >= n ? ' ✅' : ''}</span>
      <b>{fmtP(v)}</b>
    </div>
  );

  return (
    <div
      className={`sg-card stage-${stage.key}${open ? ' is-open' : ''}`}
      onClick={() => setOpen((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          setOpen((v) => !v);
        }
      }}
    >
      <div className="sg-card-top">
        <CoinIcon symbol={e.symbol} size={46} />
        <div className="sg-id">
          <div className="sg-sym">
            {baseAsset(e.symbol)}
            <small>/USDT</small>
          </div>
          <div className="sg-tags">
            <span className={`sg-dir ${isLong ? 'long' : 'short'}`}>{isLong ? '▲ Long' : '▼ Short'}</span>
            <span className="sg-tag">{String(e.tf || '').toUpperCase()}</span>
            {(e.label || e.family) && <span className="sg-tag">{String(e.label || e.family).replace(/_/g, ' ')}</span>}
            {e.score != null && <span className="sg-tag">Score {Number(e.score).toFixed(0)}</span>}
            <DivBadge d={e.divergence} />
            {e.adminStatusOverride && <span className="sg-tag" title="Status set by admin">📌 Admin</span>}
            {e.myOrder && <span className="sg-tag" title={e.myOrder.reason || ''}>🧾 {e.myOrder.label}</span>}
          </div>
        </div>
        <div className="sg-stage">
          <span className={`sg-stage-pill s-${stage.key}`}>{pillText}</span>
          {showDist && (
            <div className="sg-dist">
              {Math.abs(dist).toFixed(2)}% {dist > 0 ? 'above' : 'below'} entry
            </div>
          )}
        </div>
      </div>

      <div className="sg-levels">
        <div className="sg-lv">
          <span>Entry{e.entryTouched ? ' ✅' : ''}</span>
          <b>{fmtP(e.entry)}</b>
        </div>
        <div className="sg-lv lv-sl">
          <span>SL{cat === 'sl_hit' ? ' ❌' : ''}</span>
          <b>{fmtP(e.sl)}</b>
        </div>
        <div className="sg-lv" style={{ outline: '1px solid rgba(22,163,74,0.35)' }}>
          <span>Market</span>
          <b style={{ color: '#15803D' }}>{fmtP(e.price)}</b>
        </div>
        {tp(1, e.tp1)}
        {tp(2, e.tp2)}
        {tp(3, e.tp3)}
      </div>

      <div className={`sg-note${cat === 'sl_hit' ? ' bad' : ''}`}>{statusLine(e, cat)}</div>

      <div className="sg-foot">
        <span className="sg-foot-label">
          {e.rr1 != null ? `RR 1:${Number(e.rr1).toFixed(1)}` : ''}
          {e.rr2 != null ? ` · 1:${Number(e.rr2).toFixed(1)}` : ''}
        </span>
        <span className="sg-foot-label" style={{ opacity: 0.7 }}>
          updated {ago(e.refreshedAt || e.savedAt)}
        </span>
      </div>


      {isAdmin && (
        <div
          onClick={(ev) => ev.stopPropagation()}
          style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(128,128,128,0.15)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.75 }}>Admin status</span>
          <select
            className="form-input"
            style={{ flex: 1, minWidth: 130, fontSize: 12.5, padding: '4px 8px' }}
            value={String(e.status || 'WAITING').toUpperCase()}
            disabled={statusBusyId === e.id}
            onChange={(ev) => {
              const next = ev.target.value;
              if (next && next !== String(e.status || '').toUpperCase()) onStatusChange?.(e, next);
            }}
          >
            {!ADMIN_STATUSES.includes(String(e.status || '').toUpperCase()) && (
              <option value={String(e.status || '').toUpperCase()}>{String(e.status || '—')}</option>
            )}
            {ADMIN_STATUSES.map((st) => (
              <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>
            ))}
          </select>
          {e.adminStatusOverride && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={statusBusyId === e.id}
              onClick={() => onStatusRelease?.(e)}
              title="Remove the manual status — the market decides again"
            >
              Auto
            </button>
          )}
          {statusBusyId === e.id && <span style={{ fontSize: 12, opacity: 0.7 }}>Saving…</span>}
        </div>
      )}
      {open && (
        <div onClick={(ev) => ev.stopPropagation()} style={{ marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 6, fontSize: 12 }}>
            {['X', 'A', 'B', 'C', 'D'].map((k) =>
              e[k]?.price != null ? (
                <div key={k} className="sg-lv">
                  <span>{k}</span>
                  <b>{fmtP(e[k].price)}</b>
                </div>
              ) : null
            )}
            {e.przLow != null && e.przHigh != null && (
              <div className="sg-lv">
                <span>D zone</span>
                <b>
                  {fmtP(e.przLow)}–{fmtP(e.przHigh)}
                </b>
              </div>
            )}
            {e.ema200 != null && (
              <div className="sg-lv">
                <span>EMA200</span>
                <b>{fmtP(e.ema200)}</b>
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 8 }}>
            Found {ago(e.savedAt)} · {String(e.status || '').replace(/_/g, ' ')}
            {e.adminStatusOverride ? ' · admin override' : ''}
          </div>
          <FeedChart e={e} chartMode={chartMode} isAdmin={isAdmin} />
        </div>
      )}
    </div>
  );
}

export default function HarmonicFeed() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('all');
  const [statusBusyId, setStatusBusyId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const stampRef = useRef(null);

  const changeStatus = useCallback(async (item, nextStatus) => {
    if (!item?.id || !nextStatus) return;
    setStatusBusyId(item.id);
    setStatusMsg('');
    try {
      const res = await fetch('/api/harmonic-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_status', id: item.id, status: nextStatus }),
        cache: 'no-store',
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok === false) throw new Error(d.error || 'Status update failed');
      setData((prev) => {
        if (!prev?.items) return prev;
        return {
          ...prev,
          items: prev.items.map((x) =>
            x.id === item.id
              ? {
                  ...x,
                  status: d.status || nextStatus,
                  adminStatusOverride: true,
                  outcome: d.item?.outcome ?? x.outcome,
                  entryTouched: d.item?.entryTouched ?? x.entryTouched,
                }
              : x
          ),
        };
      });
      const t = d.trade;
      let extra = '';
      if (t) {
        if (t.timeout) extra = ' · bot is still working — see Portfolio';
        else if (t.error) extra = ` · bot error: ${t.error}`;
        else if (t.already) extra = ` · ${t.already}`;
        else if (t.placed > 0) extra = ' · ✅ limit order placed';
        else extra = ` · ⚠️ no order placed${t.reasons?.length ? ': ' + t.reasons.join(' | ') : ' (see Portfolio → Auto-trade orders)'}`;
      }
      setStatusMsg(`${String(item.symbol || '').replace(/USDT$/i, '')} → ${nextStatus.replace(/_/g, ' ')}${extra}`);
    } catch (e) {
      setStatusMsg(e.message || 'Failed');
    }
    setStatusBusyId(null);
  }, []);

  const releaseStatus = useCallback(async (item) => {
    if (!item?.id) return;
    setStatusBusyId(item.id);
    setStatusMsg('');
    try {
      const res = await fetch('/api/harmonic-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'release_status', id: item.id }),
        cache: 'no-store',
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok === false) throw new Error(d.error || 'Release failed');
      setData((prev) =>
        prev?.items ? { ...prev, items: prev.items.map((x) => (x.id === item.id ? { ...x, adminStatusOverride: false } : x)) } : prev
      );
      setStatusMsg(`${String(item.symbol || '').replace(/USDT$/i, '')} → auto (market decides)`);
    } catch (e) {
      setStatusMsg(e.message || 'Failed');
    }
    setStatusBusyId(null);
  }, []);

  const load = useCallback(async (force = false) => {
    try {
      const res = await fetch('/api/harmonic-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', since: force ? null : stampRef.current, force }),
        cache: 'no-store',
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setErr('');
      if (d.notModified) {
        setData((prev) => (prev ? { ...prev, scan: d.scan, refreshAt: d.refreshAt } : prev));
        return;
      }
      stampRef.current = d.updatedAt || null;
      setData(d);
    } catch (e) {
      setErr(e.message || 'Could not load');
    }
  }, []);

  useEffect(() => {
    load(true);
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      load(false);
    }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const items = useMemo(() => (data?.items || []).filter((e) => e && e.symbol), [data]);
  const onePerCoin = data?.onePerCoin !== false;

  const counts = useMemo(() => {
    const base = onePerCoin ? pickBestPerCoin(items) : items;
    const c = { all: base.length };
    for (const t of TABS.slice(1)) {
      const inCat = items.filter((e) => catOf(e) === t[0]);
      c[t[0]] = (onePerCoin ? pickBestPerCoin(inCat) : inCat).length;
    }
    return c;
  }, [items, onePerCoin]);

  const shown = useMemo(() => {
    let list = tab === 'all' ? (onePerCoin ? pickBestPerCoin(items) : items) : items.filter((e) => catOf(e) === tab);
    if (tab !== 'all' && onePerCoin) list = pickBestPerCoin(list);
    return [...list]
      .sort((a, b) => (RANK[catOf(a)] ?? 9) - (RANK[catOf(b)] ?? 9) || (b.score || 0) - (a.score || 0) || (b.refreshedAt || 0) - (a.refreshedAt || 0))
      .slice(0, 120);
  }, [items, tab, onePerCoin]);

  const scan = data?.scan;
  const scanLine = scan?.enabled
    ? scan.pass
      ? `Scanning ${scan.pass.done}/${scan.pass.total} coins`
      : scan.status || 'Scanner running'
    : null;

  return (
    <>
      <div className="xm-section-head">
        <h2>Harmonic signals</h2>
        <span className="see-all" style={{ opacity: 0.7 }}>{counts.all} live</span>
      </div>
      <div style={{ margin: '0 10px 6px', fontSize: 11.5, opacity: 0.65 }}>
        {scanLine ? `${scanLine} · ` : ''}
        {data?.refreshAt ? `statuses updated ${ago(Math.floor(new Date(data.refreshAt).getTime() / 1000))}` : 'waiting for first update'}
      </div>

      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '0 10px 10px', paddingBottom: 4 }}>
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={tab === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setTab(k)}
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            {label} · {counts[k] || 0}
          </button>
        ))}
      </div>

      <div style={{ margin: '0 10px 16px' }}>
        {statusMsg && (
          <div className="card" style={{ marginBottom: 10, padding: 10, fontSize: 13 }}>
            {statusMsg}
          </div>
        )}
        {err && <div className="coins-empty" style={{ color: '#DC2626' }}>{err}</div>}
        {!err && !data && <div className="coins-empty">Loading harmonic signals…</div>}
        {!err && data && !shown.length && (
          <div className="coins-empty">{tab === 'all' ? 'No harmonic signals yet.' : 'No signals in this category right now.'}</div>
        )}
        {shown.map((e) => (
          <SignalCard key={e.id} e={e} chartMode={data?.chartMode || 'both'} isAdmin={!!data?.isAdmin} onStatusChange={changeStatus} onStatusRelease={releaseStatus} statusBusyId={statusBusyId} />
        ))}
      </div>
    </>
  );
}
