'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

let CACHE = { data: null, at: 0 };
let BUCKET = 'all';
let LIMIT = 20;

const base = (s) => String(s || '').replace(/USDT$/i, '').replace(/USD$/i, '');
const fp = (n) => {
  const v = +n;
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 6 : 8;
  return v.toLocaleString(undefined, { maximumFractionDigits: d });
};
const ago = (iso) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};
const pretty = (s) => String(s || '').replace(/_/g, ' ');

const BUCKETS = [
  ['all', 'All'],
  ['waiting', 'Waiting'],
  ['entry_ready', 'Entry ready'],
  ['ongoing', 'Ongoing'],
  ['active', 'Active'],
  ['completed', 'Completed'],
];

const BUCKET_TONE = {
  waiting: '#D97706',
  entry_ready: '#2563EB',
  ongoing: '#16A34A',
  active: '#64748B',
  completed: '#2563EB',
  invalidated: '#DC2626',
};

function coinIconCandidates(symbol) {
  const ticker = base(symbol);
  const b = ticker.toLowerCase();
  return [
    `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${b}.png`,
    `https://assets.coincap.io/assets/icons/${b}@2x.png`,
  ];
}

function CoinIcon({ symbol }) {
  const [i, setI] = useState(0);
  const cands = coinIconCandidates(symbol);
  if (i >= cands.length) {
    return <span className="sc-coin-fallback">{base(symbol).slice(0, 3)}</span>;
  }
  return (
    <img
      className="sc-coin-icon"
      src={cands[i]}
      alt=""
      width={28}
      height={28}
      onError={() => setI((x) => x + 1)}
    />
  );
}

function SkCard({ s, onChart }) {
  const long = s.dir === 'LONG';
  const tone = BUCKET_TONE[s.bucket] || '#64748B';
  const entry = s.entry?.price ?? s.entry;
  const sl = s.entry?.sl ?? s.invalidation?.price;
  const tp1 = s.entry?.tp1 ?? s.hits?.tp1;
  const score = s.score;
  return (
    <article className="sc-card" data-side={long ? 'BUY' : 'SELL'}>
      <div className="sc-card-top">
        <div className="sc-coin">
          <CoinIcon symbol={s.symbol} />
          <div>
            <div className="sc-symbol">{base(s.symbol)}</div>
            <div className="sc-meta">
              {s.setup === 2 ? 'SETUP 2' : 'SETUP 1'} · {String(s.primaryTf || '').toUpperCase()} · {pretty(s.stage)}
            </div>
          </div>
        </div>
        <div className="sc-side-wrap">
          <span className={`sc-side ${long ? 'buy' : 'sell'}`}>{long ? '▲ LONG' : '▼ SHORT'}</span>
          <span
            className="sc-badge"
            style={{ background: `${tone}1A`, color: tone, border: `1px solid ${tone}55` }}
          >
            {pretty(s.bucket || s.stage)}
          </span>
        </div>
      </div>
      <div className="sc-levels">
        <div><span>Entry</span><strong>{fp(entry)}</strong></div>
        <div><span>SL</span><strong>{fp(sl)}</strong></div>
        <div><span>TP1</span><strong>{fp(tp1)}</strong></div>
        <div><span>Score</span><strong>{score ?? '—'}</strong></div>
      </div>
      <div className="sc-card-foot">
        <span className="sc-ago">{ago(s.updatedAt || s.createdAt)}</span>
        {onChart && (
          <button type="button" className="sc-chart-btn" onClick={() => onChart(s)}>
            Chart
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Public Scanner — shows SK SYSTEM results (configured + scanned by admin).
 * Buy / Sell / Invalid filters removed. Everyone with an active plan sees the same feed.
 */
export default function ScannerFeed({ isAdmin, onChart, showToast }) {
  const [data, setData] = useState(CACHE.data);
  const [err, setErr] = useState('');
  const [bucket, setBucketState] = useState(BUCKET);
  const [limit, setLimitState] = useState(LIMIT);
  const alive = useRef(true);
  const setBucket = (v) => { BUCKET = v; setBucketState(v); };
  const setLimit = (v) => { LIMIT = v; setLimitState(v); };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/sk-system?limit=300', { cache: 'no-store' });
      const response = await res.json();
      if (!res.ok || response.ok === false) throw new Error(response.error || 'Load failed');
      CACHE = { data: response, at: Date.now() };
      if (alive.current) {
        setData(response);
        setErr('');
      }
    } catch (error) {
      if (alive.current) setErr(error.message || 'Unable to load signals.');
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!CACHE.data || Date.now() - CACHE.at > 15000) load();
    const id = setInterval(load, 20000);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load]);

  const setups = data?.setups || [];
  const counts = data?.counts || {};
  const visible = data?.visibleBuckets;
  const skOn = data?.skEnabled !== false && (data?.config?.enabled !== false);

  // Respect admin-configured visible buckets for the filter chips too
  const allowedBuckets = Array.isArray(visible) && visible.length
    ? BUCKETS.filter(([k]) => k === 'all' || visible.includes(k))
    : BUCKETS;

  const filtered = bucket === 'all'
    ? setups
    : setups.filter((s) => s.bucket === bucket);

  const limitOptions = [10, 20, 30, 50];

  const chart = (s) => {
    onChart?.({
      sid: s.id,
      symbol: s.symbol,
      direction: s.dir,
      strategy: 'sk_system_pro',
      metadata: { strategy: 'sk_system_pro', primaryTf: s.primaryTf, setup: s.setup },
      caption: `SK ${s.setup === 2 ? 'Setup 2' : 'Setup 1'} · ${pretty(s.stage)}`,
    });
  };

  const run = data?.run;
  const scanning = run && (run.status === 'running' || run.status === 'paused');
  const scanPct = run?.total ? Math.round((run.analyzed / run.total) * 100) : scanning ? 50 : 0;

  return (
    <section className="sc-feed" aria-label="Scanner signals">
      <header className="sc-heading">
        <div>
          <h1>Scanner</h1>
          <p>Live SK System signals, clearly tracked.</p>
        </div>
        <span className="sc-live-indicator"><i />LIVE</span>
      </header>

      {/* Market scan progress — visible to everyone */}
      <div className={`scan-card scan-${skOn ? (scanning ? 'running' : 'idle') : 'paused'}`} style={{ margin: '0 0 12px' }}>
        <div className="scan-head">
          <span className="scan-dot" />
          <span className="scan-title">{skOn ? (scanning ? 'Market scanning' : 'SK System live') : 'Scanner paused'}</span>
          <span className="scan-pct">{skOn ? `${scanning ? scanPct : '—'}%` : '—'}</span>
        </div>
        <div className="scan-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={scanPct}>
          <div className="scan-bar-fill" style={{ width: `${skOn ? (scanning ? Math.max(scanPct, 5) : 100) : 0}%` }} />
        </div>
        <div className="scan-sub">
          {skOn
            ? scanning
              ? `Scanning… ${run?.analyzed || 0}/${run?.total || 0} coins`
              : 'Scanning the market for new setups…'
            : 'SK System is off — admin must enable it'}
        </div>
        <div className="scan-stats">
          <div className="scan-stat">
            <div className="scan-stat-val">{counts.waiting || 0}</div>
            <div className="scan-stat-label"><i className="dot dot-watching" />Waiting</div>
          </div>
          <div className="scan-stat">
            <div className="scan-stat-val">{counts.entry_ready || 0}</div>
            <div className="scan-stat-label"><i className="dot dot-ready" />Entry ready</div>
          </div>
          <div className="scan-stat">
            <div className="scan-stat-val">{counts.ongoing || 0}</div>
            <div className="scan-stat-label"><i className="dot dot-ongoing" />Ongoing</div>
          </div>
        </div>
      </div>

      {/* Bucket filters — no Buy / Sell / Invalid */}
      <div className="sc-filters" role="group" aria-label="Filter by stage">
        {allowedBuckets.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`sc-chip ${bucket === k ? 'on' : ''}`}
            onClick={() => setBucket(k)}
            aria-pressed={bucket === k}
          >
            {label}{k !== 'all' && counts[k] ? ` ${counts[k]}` : ''}
          </button>
        ))}
        <label className="sc-limit-label">
          <span className="sr-only">Maximum signals to show</span>
          <select className="sc-limit" value={limit} onChange={(e) => setLimit(+e.target.value)} aria-label="Maximum signals to show">
            {limitOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div className="sc-feed-list" aria-live="polite">
        {err && (
          <div className="sc-error" role="alert">
            <span>{err}</span>
            <button type="button" onClick={load}>Retry</button>
          </div>
        )}
        {!data && !err && (
          <div className="sc-loading" aria-label="Loading signals">
            <div className="sc-empty"><strong>Loading…</strong></div>
          </div>
        )}
        {data && filtered.length === 0 && (
          <div className="sc-empty">
            <div className="sc-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32"><path d="M5 24V8m0 16h22M9 20l5-6 4 3 6-8" /></svg>
            </div>
            <strong>No signals in this view</strong>
            <p>
              {skOn
                ? 'New SK setups will appear here after the admin scan / cron finds them.'
                : 'Admin must enable SK System and run a scan.'}
            </p>
          </div>
        )}
        {filtered.slice(0, limit).map((s) => (
          <SkCard key={s.id} s={s} onChart={chart} />
        ))}
        {err && data && <div className="sc-stale-note">Showing the last available feed. Retrying automatically.</div>}
      </div>
    </section>
  );
}

// keep named export for any old imports

