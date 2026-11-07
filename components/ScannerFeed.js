'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

let CACHE = { data: null, at: 0 };
let SIDE = 'ALL';
let LIMIT = 10;
let VIEW = 'signals';

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
const fmtT = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(+date) ? '—' : date.toLocaleString([], { hour: '2-digit', minute: '2-digit' });
};

export function setupLine(s) {
  return `${s.ob?.type === 'bearish' ? 'Bearish' : 'Bullish'} Order Block (${String(s.ltf || '').toUpperCase()}) + ${s.fib?.refLabel} Fib ${s.fib?.ratio} @ ${fp(s.fib?.price)}`;
}

export function signalText(s, isAdmin) {
  const buy = s.side === 'BUY';
  const lines = [`${buy ? 'BUY' : 'SELL'} #${s.symbol} (Futures)`, ''];
  if (isAdmin && s.fib) lines.splice(1, 0, setupLine(s));
  lines.push(
    `Current: ${fp(s.lastPrice ?? s.priceAtIssue ?? s.currentPrice)}`,
    `Entry: ${fp(s.entry)}`,
    `Stop Loss: ${fp(s.sl)}  (-${s.riskPct}%)`,
    `TP1: ${fp(s.tp1)}  (+${s.tpPct?.[0]}%)`,
    `TP2: ${fp(s.tp2)}  (+${s.tpPct?.[1]}%)`,
    `TP3: ${fp(s.tp3)}  (+${s.tpPct?.[2]}%)`,
    `R:R ${s.rr}`,
    '',
    `Issued ${ago(s.createdAt)}. Use your own risk management.`
  );
  return lines.join('\n');
}

function entryProximityPct(s) {
  // ATR-normalised on the server, so 92 % means "very close" for every coin, whatever its volatility
  return Number.isFinite(+s.proximityPct) ? Math.max(0, Math.min(100, Math.round(+s.proximityPct))) : null;
}

const proxTone = (pct) => (pct >= 70 ? 'near' : pct >= 40 ? 'mid' : 'far');
const TONE_COLOR = { near: '#15965b', mid: '#f59e0b', far: '#d84a54' };

function coinIconCandidates(symbol) {
  const ticker = base(symbol);
  const b = ticker.toLowerCase();
  return [
    `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${b}.png`,
    `https://bin.bnbstatic.com/static/assets/logos/${ticker.toUpperCase()}.png`,
    `https://cryptoicons.org/api/icon/${b}/200`,
  ];
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function CoinRing({ symbol, side, pct, enabled, color }) {
  const radius = 24;
  const circumference = 2 * Math.PI * radius;
  const buy = side === 'BUY';
  const hasPct = Number.isFinite(pct);
  const offset = circumference * (1 - (hasPct ? Math.max(0, Math.min(100, pct)) : 0) / 100);
  const candidates = coinIconCandidates(symbol);
  const [srcIdx, setSrcIdx] = useState(0);
  const ticker = base(symbol);
  const hue = hashHue(ticker);
  const showImg = srcIdx < candidates.length;

  return (
    <div className={`sc-coin-ring ${enabled ? '' : 'ring-disabled'}`} aria-hidden="true">
      <svg width="60" height="60" viewBox="0 0 60 60" className="sc-ring-svg">
        <circle cx="30" cy="30" r={radius} fill="none" stroke="currentColor" strokeWidth="3.5" />
        {enabled && hasPct && (
          <circle
            cx="30"
            cy="30"
            r={radius}
            fill="none"
            stroke={color || (buy ? '#15965b' : '#d84a54')}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 30 30)"
          />
        )}
      </svg>
      <div className={`sc-coin-face ${buy ? 'buy' : 'sell'}`} style={!showImg ? { background: `hsl(${hue} 42% 42%)` } : undefined}>
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={candidates[srcIdx]} src={candidates[srcIdx]} alt="" width={34} height={34} onError={() => setSrcIdx((i) => i + 1)} />
        ) : <span>{ticker.slice(0, 1) || '?'}</span>}
      </div>
    </div>
  );
}

function Trophy() {
  return <span className="sc-result-mark" aria-hidden="true">🏆</span>;
}

function TargetTracker({ s, showPercentages }) {
  const buy = s.side === 'BUY';
  const entry = +s.entry;
  const completed = !!s.tp3Hit;
  const stopped = !!s.slHit && !completed;
  const reached = [s.tp1Hit, s.tp2Hit, s.tp3Hit].filter(Boolean).length;
  const levels = [
    { key: 'tp1', label: 'TP1', price: s.tp1, hit: !!s.tp1Hit },
    { key: 'tp2', label: 'TP2', price: s.tp2, hit: !!s.tp2Hit },
    { key: 'tp3', label: 'TP3', price: s.tp3, hit: !!s.tp3Hit },
    { key: 'sl', label: 'SL', price: s.sl, hit: stopped, sl: true },
  ];
  return (
    <div className="sc-tracker" aria-label="Signal target progress">
      <div className="sc-tracker-row">
        {levels.map((level, index) => {
          const pct = !level.sl && Number.isFinite(entry) && entry && Number.isFinite(+level.price)
            ? ((buy ? +level.price - entry : entry - +level.price) / entry) * 100
            : null;
          const previousReached = index > 0 && levels[index - 1].hit;
          return (
            <div key={level.key} className={`sc-tp ${level.hit ? (level.sl ? 'sl-hit' : 'hit') : ''} ${level.sl ? 'is-sl' : ''}`}>
              {index > 0 && <span className={`sc-tp-line ${previousReached ? 'on' : ''}`} />}
              <span className={`sc-tp-dot ${level.hit ? 'on' : ''}`} aria-label={level.hit ? 'Reached' : 'Not reached'}>
                {level.hit ? (level.sl ? '×' : '✓') : ''}
              </span>
              <span className="sc-tp-label">{level.label}</span>
              <strong className={`sc-tp-price ${level.sl ? 'sl' : ''}`}>{fp(level.price)}</strong>
              {showPercentages && pct != null && !level.sl && (
                <span className="sc-tp-pct">{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>
              )}
            </div>
          );
        })}
      </div>
      {completed && <div className="sc-result-banner completed"><Trophy />3 / 3 Targets Reached</div>}
      {stopped && <div className="sc-result-banner stopped">STOP LOSS HIT</div>}
      {!completed && !stopped && reached > 0 && <div className="sc-result-banner progress"><Trophy />{reached} / 3 Targets Reached</div>}
      {!completed && !stopped && reached === 0 && <div className="sc-result-banner wait">Entry reached · waiting for TP1</div>}
    </div>
  );
}

function resultStatus(s) {
  if (s.trackingPaused) return { text: 'PATH UNCONFIRMED', kind: 'paused' };
  if (s.tp3Hit) return { text: 'COMPLETED', kind: 'completed' };
  if (s.slHit) return { text: 'SL HIT', kind: 'sl' };
  if (s.tp2Hit) return { text: 'TP2 HIT', kind: 'ongoing' };
  if (s.tp1Hit) return { text: 'TP1 HIT', kind: 'ongoing' };
  if (s.entryHit) return { text: 'ONGOING', kind: 'ongoing' };
  return { text: s.side === 'BUY' ? 'BUY' : 'SELL', kind: s.side === 'BUY' ? 'buy' : 'sell' };
}

function Card({ s, isAdmin, onChart, onCopy, preferences, ringEnabled }) {
  const buy = s.side === 'BUY';
  const status = resultStatus(s);
  const ongoing = !!(s.entryHit || s.tp1Hit || s.tp2Hit || s.tp3Hit) || s.status !== 'ACTIVE';
  const proximity = entryProximityPct(s);
  const tone = proxTone(proximity ?? 0);
  const ringPct = ongoing ? 100 : proximity;
  const ringColor = ongoing ? (s.slHit && !s.tp3Hit ? '#d84a54' : '#15965b') : TONE_COLOR[tone];
  const price = s.lastPrice ?? s.priceAtIssue ?? s.currentPrice;
  const parsedEntryTime = s.entryTime ? new Date(+s.entryTime > 1e12 ? +s.entryTime : +s.entryTime * 1000) : null;
  const entryTime = parsedEntryTime && !Number.isNaN(+parsedEntryTime) ? fmtT(parsedEntryTime) : fmtT(s.createdAt);

  return (
    <article className={`sc-card ${buy ? 'buy' : 'sell'} ${ongoing ? 'ongoing' : ''} ${s.status !== 'ACTIVE' ? 'closed' : ''}`}>
      <div className="sc-card-top">
        <div className="sc-card-identity">
          <CoinRing symbol={s.symbol} side={s.side} pct={ringPct} color={ringColor} enabled={ringEnabled} />
          <div className="sc-card-mid">
            <div className="sc-sym">{base(s.symbol)}<span>/USDT</span></div>
            <div className="sc-cur"><span>Current</span><strong>{fp(price)}</strong></div>
          </div>
        </div>
        <div className="sc-meta">
          <span
            className={`sc-badge ${status.kind}`}
            title={status.kind === 'paused' ? 'Tracking paused because the exact candle path is unconfirmed.' : undefined}
            aria-label={status.kind === 'paused' ? 'Tracking paused. Path unconfirmed.' : undefined}
            style={status.kind === 'paused' ? { background: '#eef1f6', color: '#68758c', borderColor: '#d9deea' } : undefined}
          >
            <span className="sc-status-symbol" aria-hidden="true">{status.kind === 'buy' ? '▲' : status.kind === 'sell' ? '▼' : status.kind === 'sl' ? '×' : status.kind === 'paused' ? '–' : '✓'}</span>
            {status.text}
          </span>
          {preferences.showSignalAge !== false && <span className="sc-ago">{ongoing ? `Entry: ${entryTime}` : ago(s.createdAt)}</span>}
        </div>
      </div>

      {!ongoing && (
        <div className="sc-entry-panel">
          <div className={`sc-proximity ${tone}`} aria-label={proximity != null ? `Entry proximity ${proximity}%` : 'Entry proximity unavailable'}>
            <strong>{proximity != null ? `${proximity}%` : '—'}</strong>
            <span>to Entry</span>
          </div>
          <div className="sc-watch-levels">
            <div className="sc-level entry"><span>Entry</span><b>{fp(s.entry)}</b></div>
            <div className="sc-level"><span>TP1</span><b>{fp(s.tp1)}</b><small>{preferences.showTargetPercentages !== false && s.tpPct?.[0] != null ? `+${s.tpPct[0]}%` : ''}</small></div>
            <div className="sc-level"><span>TP2</span><b>{fp(s.tp2)}</b><small>{preferences.showTargetPercentages !== false && s.tpPct?.[1] != null ? `+${s.tpPct[1]}%` : ''}</small></div>
            <div className="sc-level"><span>TP3</span><b>{fp(s.tp3)}</b><small>{preferences.showTargetPercentages !== false && s.tpPct?.[2] != null ? `+${s.tpPct[2]}%` : ''}</small></div>
            <div className="sc-level stop"><span>SL</span><b>{fp(s.sl)}</b></div>
          </div>
        </div>
      )}
      {ongoing && (
        <div className="sc-live-details">
          <div className="sc-entry-value"><span>Entry</span><strong>{fp(s.entry)}</strong></div>
          <TargetTracker s={s} showPercentages={preferences.showTargetPercentages !== false} />
        </div>
      )}
      {isAdmin && s.fib && <div className="sc-admin-line">{setupLine(s)}</div>}
      <div className="sc-card-actions">
        <button type="button" className="sc-action" onClick={() => onChart?.(s)} aria-label={`Open chart for ${base(s.symbol)}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15.5V4.5M3 15.5h14M5.5 12l3-3 2.5 2 4.5-5" /></svg>
          Chart
        </button>
        {isAdmin && <button type="button" className="sc-action" onClick={() => onCopy(s)} aria-label={`Copy ${base(s.symbol)} signal`}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="10" height="11" rx="1.8" /><path d="M13.5 6V4.8A1.8 1.8 0 0 0 11.7 3H5A2 2 0 0 0 3 5v8a2 2 0 0 0 2 2h1" /></svg>
          Copy signal
        </button>}
      </div>
    </article>
  );
}

function InvalidCard({ s, onCopy }) {
  const buy = s.side === 'BUY';
  const used = s.entryUsedAt ? new Date(s.entryUsedAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  return (
    <article className={`sc-card invalid ${buy ? 'buy' : 'sell'}`}>
      <div className="sc-card-top">
        <div className="sc-card-identity">
          <div className="sc-card-mid">
            <div className="sc-sym">{base(s.symbol)}<span>/USDT</span></div>
            <div className="sc-cur"><span>Entry</span><strong>{fp(s.entry)}</strong></div>
          </div>
        </div>
        <div className="sc-meta">
          <span className={`sc-badge ${buy ? 'buy' : 'sell'}`}><span className="sc-status-symbol" aria-hidden="true">{buy ? '▲' : '▼'}</span>{buy ? 'BUY' : 'SELL'}</span>
          <span className="sc-ago">{ago(s.invalidAt || s.createdAt)}</span>
        </div>
      </div>
      <div className="sc-invalid-note"><b>Entry already used</b> — price touched the entry at {used}, after the order block formed. An OB entry works only once.</div>
      {s.fib && <div className="sc-admin-line">{setupLine(s)}</div>}
    </article>
  );
}

function SkeletonCard() {
  return <div className="sc-skeleton" aria-hidden="true"><div /><div /><div /></div>;
}

export default function ScannerFeed({ isAdmin, onChart, showToast }) {
  const [data, setData] = useState(CACHE.data);
  const [err, setErr] = useState('');
  const [side, setSideState] = useState(SIDE);
  const [limit, setLimitState] = useState(LIMIT);
  const [view, setViewState] = useState(VIEW);
  const setView = (value) => { VIEW = value; setViewState(value); };
  const alive = useRef(true);
  const setSide = (value) => { SIDE = value; setSideState(value); };
  const setLimit = (value) => { LIMIT = value; setLimitState(value); };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/scanner-feed', { cache: 'no-store' });
      const response = await res.json();
      if (!res.ok || response.ok === false) throw new Error(response.error || 'Load failed');
      CACHE = { data: response, at: Date.now() };
      if (alive.current) { setData(response); setErr(''); }
    } catch (error) {
      if (alive.current) setErr(error.message || 'Unable to load signals.');
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!CACHE.data || Date.now() - CACHE.at > 15000) load();
    const id = setInterval(load, 30000);
    return () => { alive.current = false; clearInterval(id); };
  }, [load]);

  const settings = data?.settings || {};
  const preferences = settings.cardPreferences || {};
  const maxVisible = Number.isFinite(+settings.maxVisibleSignals) && +settings.maxVisibleSignals > 0
    ? Math.floor(+settings.maxVisibleSignals)
    : 50;
  const all = data?.signals || [];
  const bySide = all.filter((signal) => side === 'ALL' || signal.side === side);
  const active = bySide.filter((signal) => signal.status === 'ACTIVE');
  const closed = bySide.filter((signal) => signal.status !== 'ACTIVE');
  const rows = [
    ...active,
    ...(preferences.showRecentResults === false ? [] : closed),
  ];
  const visibleLimit = Math.min(limit, maxVisible);
  const limitOptions = [...new Set([10, 20, 30, 50].filter((n) => n <= maxVisible).concat(maxVisible))].sort((a, b) => a - b);

  async function copy(signal) {
    const text = signalText(signal, isAdmin);
    try {
      await navigator.clipboard.writeText(text);
      showToast?.('Signal copied');
    } catch (_) {
      window.prompt('Copy signal', text);
    }
  }

  const chart = (signal) => {
    onChart?.({
      sid: signal.id,
      symbol: signal.symbol,
      direction: signal.side === 'BUY' ? 'LONG' : 'SHORT',
      ...(isAdmin && signal.fib ? {
        strategy: 'ob_fib',
        metadata: { strategy: 'ob_fib', patternTf: signal.ltf },
        caption: setupLine(signal),
      } : {}),
    });
  };

  return (
    <section className="sc-feed" aria-label="Scanner signals">
      <header className="sc-heading">
        <div><h1>Scanner</h1><p>Live signals, clearly tracked.</p></div>
        <span className="sc-live-indicator"><i />LIVE</span>
      </header>
      <div className="sc-filters" role="group" aria-label="Filter signals by direction">
        <button type="button" className={`sc-chip ${side === 'ALL' ? 'on' : ''}`} onClick={() => setSide('ALL')} aria-pressed={side === 'ALL'}>
          <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="11" y="2" width="5" height="5" rx="1" /><rect x="2" y="11" width="5" height="5" rx="1" /><rect x="11" y="11" width="5" height="5" rx="1" /></svg>All
        </button>
        <button type="button" className={`sc-chip ${side === 'BUY' ? 'on buy' : ''}`} onClick={() => setSide('BUY')} aria-pressed={side === 'BUY'}><span className="sc-filter-arrow buy">▲</span>Buy</button>
        <button type="button" className={`sc-chip ${side === 'SELL' ? 'on sell' : ''}`} onClick={() => setSide('SELL')} aria-pressed={side === 'SELL'}><span className="sc-filter-arrow sell">▼</span>Sell</button>
        {isAdmin && (
          <button type="button" className={`sc-chip ${view === 'invalid' ? 'on' : ''}`} onClick={() => setView(view === 'invalid' ? 'signals' : 'invalid')} aria-pressed={view === 'invalid'}>
            Invalid{data?.invalid?.length ? ` ${data.invalid.length}` : ''}
          </button>
        )}
        <label className="sc-limit-label"><span className="sr-only">Maximum signals to show</span>
           <select className="sc-limit" value={visibleLimit} onChange={(event) => setLimit(+event.target.value)} aria-label="Maximum signals to show">
             {limitOptions.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="sc-feed-list" aria-live="polite">
        {err && <div className="sc-error" role="alert"><span>{err}</span><button type="button" onClick={load}>Retry</button></div>}
        {!data && !err && <div className="sc-loading" aria-label="Loading signals"><SkeletonCard /><SkeletonCard /></div>}
        {isAdmin && view === 'invalid' && data && (
          data.invalid?.length
            ? data.invalid.filter((x) => side === 'ALL' || x.side === side).map((x) => <InvalidCard key={x.id} s={x} />)
            : <div className="sc-empty"><strong>No invalid setups</strong><p>Setups whose entry was already touched appear here.</p></div>
        )}
        {data && !(isAdmin && view === 'invalid') && rows.length === 0 && (
          <div className="sc-empty"><div className="sc-empty-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 24V8m0 16h22M9 20l5-6 4 3 6-8" /></svg></div><strong>No signals in this view</strong><p>New opportunities will appear here as they are issued.</p></div>
        )}
        {!(isAdmin && view === 'invalid') && rows.slice(0, visibleLimit).map((signal, index) => (
          <div key={signal.id || signal.signal_id || index}>
            {preferences.showRecentResults !== false && closed.length > 0 && index === active.length && active.length > 0 && <div className="sc-section-label">Recent results</div>}
            <Card
              s={signal}
              isAdmin={isAdmin}
              onCopy={copy}
              onChart={chart}
              preferences={preferences}
              ringEnabled={settings.entryProximityRingEnabled !== false}
            />
          </div>
        ))}
        {err && data && <div className="sc-stale-note">Showing the last available feed. Retrying automatically.</div>}
      </div>
    </section>
  );
}
