'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { normalizeSignalsPayload } from '../lib/signals/normalizePayload.js';
import {
  RiskModeCard,
  ExchangeSwitch,
  PortfolioView,
  ConnectCard,
  AutoTradeSelector,
  EX_LABEL,
} from '../components/ExchangePanels.js';
import { EquityJourney } from '../components/EquityJourney.js';
import { getVersionLabel } from '../lib/version.js';
import './globals.css';

// ─── helpers ────────────────────────────────────────────────
function fmt(n, d) {
  if (n == null || Number.isNaN(+n)) return '—';
  const v = Number(n);
  if (d != null) return v.toFixed(d);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  if (a >= 0.01) return v.toFixed(5);
  return v.toFixed(6);
}

function statusChip(status, signal) {
  const s = (status || '').toUpperCase();
  if (s === 'WATCHING') return <span className="chip chip-watching">👀 Watching</span>;
  if (s === 'READY') return <span className="chip chip-ready">🚀 Ready</span>;
  if (s === 'ONGOING') {
    if (signal?.tp3_hit || signal?.tp3Hit) return <span className="chip chip-ongoing">✅ TP3</span>;
    if (signal?.tp2_hit || signal?.tp2Hit) return <span className="chip chip-ongoing">🎯 TP2</span>;
    if (signal?.tp1_hit || signal?.tp1Hit) return <span className="chip chip-ongoing">🎯 TP1</span>;
    return <span className="chip chip-ongoing">🟢 Ongoing</span>;
  }
  if (s === 'STOPPED') {
    // Prefer TP category if TP was hit before SL
    if (signal?.tp3_hit || signal?.tp3Hit) return <span className="chip chip-ongoing">✅ TP3</span>;
    if (signal?.tp2_hit || signal?.tp2Hit) return <span className="chip chip-ongoing">🎯 TP2 → SL</span>;
    if (signal?.tp1_hit || signal?.tp1Hit) return <span className="chip chip-ongoing">🎯 TP1 → SL</span>;
    return <span className="chip chip-short">🔴 SL Hit</span>;
  }
  if (s === 'COMPLETED_PROFIT') return <span className="chip chip-ongoing">✅ TP3 Hit</span>;
  if (s === 'INVALIDATED') return <span className="chip chip-muted">Invalidated</span>;
  return <span className="chip chip-muted">{status || '—'}</span>;
}

function dirChip(dir) {
  const d = (dir || '').toUpperCase();
  if (d === 'LONG') return <span className="chip chip-long">Long</span>;
  if (d === 'SHORT') return <span className="chip chip-short">Short</span>;
  return null;
}

/** "BTCUSDT" / "1000PEPEUSDT" / "BTC/USDT" → "BTC" / "PEPE" / "BTC" */
function baseAsset(sym) {
  let b = String(sym || '').toUpperCase().replace(/[-_/:]/g, '');
  b = b.replace(/(USDT|USDC|BUSD|USD|PERP)$/, '');
  b = b.replace(/^(1000000|100000|10000|1000)(?=[A-Z])/, '');
  return b || String(sym || '').toUpperCase();
}

/** % distance between live price and entry (smaller = closer to triggering). */
function entryDistancePct(s) {
  const entry = Number(s.entry ?? s.entry_price);
  const cur = Number(s.current_price ?? s.last_price ?? s.price);
  if (entry > 0 && cur > 0) return (Math.abs(cur - entry) / entry) * 100;
  const d = Number(s.distance_percent);
  return Number.isFinite(d) ? Math.abs(d) : Infinity;
}

const COIN_COLORS = ['#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

function CoinIcon({ symbol, size = 44 }) {
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
  return (
    <img
      className="coin-icon"
      style={style}
      src={sources[i]}
      alt=""
      loading="lazy"
      onError={() => setI((n) => n + 1)}
    />
  );
}

function BalanceAmount({ value }) {
  const v = Number(value);
  if (!Number.isFinite(v)) return <div className="bal-amount"><span className="bal-cur">$</span>—</div>;
  const neg = v < 0;
  const [whole, dec] = Math.abs(v).toFixed(2).split('.');
  return (
    <div className="bal-amount">
      <span className="bal-cur">{neg ? '-$' : '$'}</span>
      {Number(whole).toLocaleString('en-US')}
      <span className="bal-dec">.{dec}</span>
    </div>
  );
}

function VerifyRing({ pct, size = 52 }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="verify-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.22,1,0.36,1)' }}
        />
      </svg>
      <span>{pct}%</span>
    </div>
  );
}

/**
 * Home news banner. Fixed 672:176 (≈3.8:1) like the wallet-style promo strip,
 * so admin images should be 1344×352 px (or any image with that ratio).
 */
function NewsBanner({ items, idx, setIdx, onOpen, onDismiss }) {
  const touchX = useRef(null);
  const [failed, setFailed] = useState({});
  const n = items[idx] || items[0];
  if (!n) return null;
  const isDefaultTitle = !n.title || n.title === 'Update' || n.title === 'News';
  const hasImg = !!n.imageUrl && !failed[n.id];
  const openable = !!(n.body || !isDefaultTitle);
  const go = (d) => setIdx((i) => (i + d + items.length) % items.length);

  return (
    <div
      className={`news-banner ${hasImg ? 'has-image' : 'is-text'}`}
      onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touchX.current == null || items.length < 2) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
      }}
      onClick={() => openable && onOpen(n)}
      role={openable ? 'button' : undefined}
    >
      {hasImg ? (
        <img
          key={n.id}
          className="news-banner-img"
          src={n.imageUrl}
          alt={isDefaultTitle ? '' : n.title}
          onError={() => setFailed((f) => ({ ...f, [n.id]: true }))}
        />
      ) : (
        <div className="news-banner-copy">
          <div className="news-banner-title">{n.title}</div>
          {n.body && <div className="news-banner-body">{n.body}</div>}
          {openable && <div className="news-banner-more">Learn more ›</div>}
        </div>
      )}
      {items.length > 1 && (
        <div className="news-dots">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              aria-label={`News ${i + 1}`}
              className={i === idx ? 'on' : ''}
              onClick={(e) => { e.stopPropagation(); setIdx(i); }}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className="news-close"
        aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}
      >
        ✕
      </button>
    </div>
  );
}

function ProgressRing({ daysLeft, total = 7 }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(1, Math.max(0, daysLeft / total));
  const offset = circ * (1 - pct);
  return (
    <div className="progress-ring">
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle className="bg" cx="32" cy="32" r={r} />
        <circle
          className="fg"
          cx="32"
          cy="32"
          r={r}
          strokeDasharray={circ}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="label">{daysLeft}d</div>
    </div>
  );
}

// ─── Icons (inline SVG) ─────────────────────────────────────

/** Countdown ring until next full market scan (default 5 min). */
function FullScanRing({ lastAt, nextAt, intervalMin = 5, running = false }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const intervalMs = Math.max(1, intervalMin) * 60 * 1000;

  // Base "next" from server; if overdue, roll forward in full intervals so UI never sticks at 00:00
  let end = nextAt ? new Date(nextAt).getTime() : NaN;
  if (!Number.isFinite(end) && lastAt) end = new Date(lastAt).getTime() + intervalMs;
  if (!Number.isFinite(end)) end = now + intervalMs;
  // Roll past due deadlines into the current cycle
  if (end <= now) {
    const overdue = now - end;
    const steps = Math.floor(overdue / intervalMs) + 1;
    end = end + steps * intervalMs;
  }
  const start = end - intervalMs;
  const leftMs = Math.max(0, end - now);
  const elapsed = Math.min(intervalMs, Math.max(0, now - start));
  const pct = Math.min(1, Math.max(0, elapsed / intervalMs));
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct);
  const sec = Math.ceil(leftMs / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  const overdueServer = nextAt && new Date(nextAt).getTime() <= now;
  // Cron looks stopped: no completed full scan for 2 intervals + 90s grace
  const delayed =
    !running && lastAt && now - new Date(lastAt).getTime() > intervalMs * 2 + 90 * 1000;
  const state = running ? 'scanning' : delayed ? 'delayed' : 'idle';
  return (
    <div
      className={`progress-ring ring-${state}`}
      title={
        running
          ? 'Scanning all coins now…'
          : delayed
            ? 'Scan delayed — the scheduler may be stopped'
            : overdueServer
              ? 'Scan due — waiting for cron / refresh'
              : `Next full scan in ${mm}:${ss}`
      }
    >
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle className="bg" cx="36" cy="36" r={r} />
        <circle
          className="fg"
          cx="36"
          cy="36"
          r={r}
          strokeDasharray={circ}
          strokeDashoffset={running ? circ * 0.7 : offset}
          style={{ transition: running ? 'none' : 'stroke-dashoffset 0.5s linear' }}
        />
      </svg>
      <div className="label" style={{ fontSize: running || delayed ? 10 : 12, fontWeight: 700 }}>
        {running ? 'Scanning' : delayed ? 'Delayed' : `${mm}:${ss}`}
      </div>
    </div>
  );
}


/** One-line, user-friendly status under the scan ring. */
function fullScanCaption({ running, summary, lastAt, intervalMin }) {
  if (running) return 'Scanning all coins now — signals update when it finishes';
  if (summary && summary.total && summary.parts > 1) {
    const cycle = summary.parts * intervalMin;
    const late = summary.partial ? ' · time ran out, continues next scan' : '';
    return `Part ${summary.part}/${summary.parts} · ${summary.scanned} of ${summary.total} coins · +${summary.created} new · ${summary.updated} updated · every coin checked every ${cycle} min${late}`;
  }
  if (summary && summary.total) {
    const part = summary.partial ? ' (rest continues in the background)' : '';
    return `Last scan: ${summary.scanned}/${summary.total} coins · +${summary.created} new · ${summary.updated} updated${part}`;
  }
  if (lastAt) return `Last scan: ${new Date(lastAt).toLocaleTimeString()} · every ${intervalMin} min`;
  return `Scans every ${intervalMin} min`;
}


/** Stage → lamp tone. "Server lamp" metaphor: dark = watching, amber = ready, green = running. */
function signalStage(s) {
  const st = String(s.status || '').toUpperCase();
  const tp1 = !!(s.tp1_hit || s.tp1Hit);
  const tp2 = !!(s.tp2_hit || s.tp2Hit);
  const tp3 = !!(s.tp3_hit || s.tp3Hit);
  if (st === 'WATCHING') return { key: 'watching', label: 'Watching', lamp: 'off', rank: 3 };
  if (st === 'READY') return { key: 'ready', label: 'Ready', lamp: 'ready', rank: 1 };
  if (st === 'ONGOING') {
    const label = tp3 ? 'TP3 hit' : tp2 ? 'TP2 hit' : tp1 ? 'TP1 hit' : 'Ongoing';
    return { key: 'ongoing', label, lamp: 'live', rank: 2 };
  }
  if (st === 'COMPLETED_PROFIT') return { key: 'tp', label: 'Profit', lamp: 'tp', rank: 4 };
  if (st === 'STOPPED') {
    if (tp3) return { key: 'tp', label: 'TP3 hit', lamp: 'tp', rank: 4 };
    if (tp2) return { key: 'tp', label: 'TP2 → SL', lamp: 'tp', rank: 4 };
    if (tp1) return { key: 'tp', label: 'TP1 → SL', lamp: 'tp', rank: 4 };
    return { key: 'sl', label: 'SL hit', lamp: 'sl', rank: 5 };
  }
  if (st === 'INVALIDATED') return { key: 'invalid', label: 'Invalid', lamp: 'dead', rank: 6 };
  return { key: 'other', label: st || '—', lamp: 'off', rank: 7 };
}

function signalKey(s) {
  return s.signal_id || s.id || `${s.symbol}_${s.direction || s.dir || s.side || ''}`;
}

/** One-line context under a signal card. */
function signalNote(s) {
  const st = String(s.status || '').toUpperCase();
  const strat = s.metadata?.strategy || s.strategy;
  if (st === 'INVALIDATED') {
    const why =
      s.metadata?.invalidation?.reasons?.[0]?.reason ||
      s.metadata?.invalidation?.reason ||
      s.metadata?.entryConfirmReason ||
      s.invalidation_reason ||
      'Setup invalidated';
    return { text: `Invalid: ${why}`, bad: true };
  }
  const pat = String(s.metadata?.pattern || s.pattern || s.metadata?.patternGeom?.type || '').replace(/_/g, ' ');
  if (s.metadata?.confluenceMode === 'ict_chart_pattern') {
    const c = s.metadata.chartPatternConfirmation;
    return { text: `ICT + Chart Pattern · ${c?.pattern || 'confirmed'}${c?.timeframe ? ` · ${c.timeframe}` : ''}` };
  }
  if (strat === 'chart_pattern') {
    const ew = s.metadata?.universal?.elliott?.primary;
    const ewTxt = ew?.type
      ? ` · EW ${ew.type}${ew.currentWave != null ? ` W${ew.currentWave}` : ''}`
      : s.metadata?.patternGeom?.elliott?.type
        ? ` · EW ${s.metadata.patternGeom.elliott.type}`
        : '';
    return { text: `Chart Pattern · ${pat || 'setup'}${s.metadata?.patternTf ? ` · ${s.metadata.patternTf}` : ''}${ewTxt}` };
  }
  if (strat === 'ict_smc') {
    return {
      text:
        st === 'WATCHING'
          ? 'Waiting for price to return to the SMC point of interest'
          : st === 'READY'
            ? 'Price is near or inside the SMC point of interest'
            : st === 'ONGOING'
              ? 'Entry level reached · trade in progress'
              : 'ICT SMC setup',
    };
  }
  if (strat === 'zone_pattern') {
    const n = s.metadata?.zone?.families?.length;
    return { text: `Zone + Pattern · ${s.metadata?.pattern || s.pattern || 'confirmed'}${n ? ` · ${n} confluence sources` : ''}` };
  }
  if (strat === 'ema_bump') {
    return {
      text: `EMA Bump · ${String(s.metadata?.patternTf || '').toUpperCase() || 'TF'}${s.metadata?.gapATR != null ? ` · EMA gap ${s.metadata.gapATR} ATR` : ''}${s.metadata?.depthATR != null ? ` · dip ${s.metadata.depthATR} ATR` : ''}`,
    };
  }
  if (strat === 'double_confluence') {
    return {
      text: `Double Top/Bottom · ${s.metadata?.pattern || s.pattern || 'setup'}${s.metadata?.quality ? ` · ${s.metadata.quality}` : ''}${s.metadata?.entryTf ? ` · ${s.metadata.entryTf}` : ''}`,
    };
  }
  const reason = s.metadata?.entryConfirmReason || s.metadata?.entryClassReason;
  if (reason && st !== 'ONGOING') return { text: reason };
  return null;
}

function BulbIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g className="bulb-rays">
        <path d="M12 0.6v1.6M4.2 3.4l1.1 1.1M19.8 3.4l-1.1 1.1M1.6 10.2h1.6M20.8 10.2h1.6" />
      </g>
      <path
        className="bulb-glass"
        d="M12 3.8a6.2 6.2 0 00-3.7 11.2c.5.4.8 1 .8 1.6v.6h5.8v-.6c0-.6.3-1.2.8-1.6A6.2 6.2 0 0012 3.8z"
      />
      <path className="bulb-fil" d="M10.4 13.6l1.6-3.2 1.6 3.2" />
      <path className="bulb-base" d="M9.5 19.1h5M10.5 21.3h3" />
    </svg>
  );
}

function Lamp({ tone = 'off', size = 44, flash = false, small = false }) {
  return (
    <span
      className={`lamp lamp-${tone}${small ? ' lamp-sm' : ''}${flash ? ' is-flash' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <BulbIcon />
    </span>
  );
}

/** User-facing market scan status: progress bar + % + Watching / Ready / Ongoing counts. */
function MarketScanCard({ lastAt, nextAt, intervalMin = 5, running = false, enabled = true, counts }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const intervalMs = Math.max(1, intervalMin) * 60 * 1000;
  let end = nextAt ? new Date(nextAt).getTime() : NaN;
  if (!Number.isFinite(end) && lastAt) end = new Date(lastAt).getTime() + intervalMs;
  if (!Number.isFinite(end)) end = now + intervalMs;
  if (end <= now) {
    const steps = Math.floor((now - end) / intervalMs) + 1;
    end += steps * intervalMs;
  }
  const start = end - intervalMs;
  const cyclePct = Math.min(100, Math.max(0, Math.round(((now - start) / intervalMs) * 100)));
  const pct = !enabled ? 0 : running ? 100 : cyclePct;
  const state = !enabled ? 'paused' : running ? 'running' : 'idle';
  return (
    <div className={`scan-card scan-${state}`}>
      <div className="scan-head">
        <span className="scan-dot" />
        <span className="scan-title">{enabled ? 'Market scanning' : 'Scanner paused'}</span>
        <span className="scan-pct">{enabled ? `${pct}%` : '—'}</span>
      </div>
      <div className="scan-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="scan-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="scan-sub">
        {enabled ? 'Scanning the market for new setups…' : 'Auto-scan is turned off right now'}
      </div>
      <div className="scan-stats">
        <div className="scan-stat">
          <div className="scan-stat-val">{counts.watching}</div>
          <div className="scan-stat-label"><i className="dot dot-watching" />Watching</div>
        </div>
        <div className="scan-stat">
          <div className="scan-stat-val">{counts.ready}</div>
          <div className="scan-stat-label"><i className="dot dot-ready" />Ready</div>
        </div>
        <div className="scan-stat">
          <div className="scan-stat-val">{counts.ongoing}</div>
          <div className="scan-stat-label"><i className="dot dot-ongoing" />Ongoing</div>
        </div>
      </div>
    </div>
  );
}

/** Big progress ring for the Verify page. */
function VerifyRingBig({ pct, done, total }) {
  const size = 176;
  const r = 78;
  const c = 2 * Math.PI * r;
  return (
    <div className="vp-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <span>{pct}%</span>
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function displayNameFromEmail(email) {
  const raw = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!raw) return 'Trader';
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

function initialOf(email) {
  return (String(email || '?').trim()[0] || '?').toUpperCase();
}

const Icons = {
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  verified: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 1.8l2.5 1.7 3-.2 1.3 2.7 2.6 1.5-.5 3 1.2 2.7-2 2.3-.3 3-2.9.9-1.9 2.4L12 20.6l-2.6 1.3-1.9-2.4-2.9-.9-.3-3-2-2.3 1.2-2.7-.5-3 2.6-1.5 1.3-2.7 3 .2L12 1.8z"
        fill="currentColor"
      />
      <path d="M8.2 12.3l2.6 2.6 5-5.4" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  whatsapp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 01-12.4 7.4L3 20.5l1.7-5.4A8.4 8.4 0 1121 11.5z" />
      <path d="M9 9.5c.5 2.5 2.5 4.5 5 5l1.2-1.2-1.8-1-.8.6a3.6 3.6 0 01-1.6-1.6l.6-.8-1-1.8L9 9.5z" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </svg>
  ),
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9.5z" />
    </svg>
  ),
  signals: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
    </svg>
  ),
  trade: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  plans: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
    </svg>
  ),
  profile: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  ),
  scan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" />
    </svg>
  ),
  key: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="8" cy="15" r="4" />
      <path d="M11.5 12.5L20 4m-3 0h3v3" />
    </svg>
  ),
  telegram: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  ),
  auto: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
};

// ─── Main App ───────────────────────────────────────────────
export default function App() {
  const router = useRouter();
  const [tab, setTab] = useState('home');
  const [user, setUser] = useState(null);
  const [plan, setPlan] = useState(null);
  const [keyStatus, setKeyStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [preferredTpLevel, setPreferredTpLevel] = useState(1);
  const [signals, setSignals] = useState([]);
  const [perf, setPerf] = useState(null);
  const [perfPeriod, setPerfPeriod] = useState('24h');
  const [perfDir, setPerfDir] = useState('ALL'); // ALL | LONG | SHORT
  const [flashIds, setFlashIds] = useState({});
  const prevStageRef = useRef(new Map());
  const [filter, setFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [sheet, setSheet] = useState(null); // selected signal
  const [enterBusyId, setEnterBusyId] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiListening, setAiListening] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiMessages, setAiMessages] = useState([
    {
      role: 'assistant',
      text: 'ආයුබෝවන් — මම Nila, ඔබේ AI Manager. Signals, Market Entry, High Risk, Telegram, plans වගේ ඕනෑම දෙයක් අහන්න. Talk බටන් එක ඔබලා කතා කරන්නත් පුළුවන්.',
    },
  ]);
  const aiRecognitionRef = useRef(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportMode, setSupportMode] = useState(null); // null | 'choose' | 'ai' | 'live'
  const [supportMsgs, setSupportMsgs] = useState([]);
  const [supportInput, setSupportInput] = useState('');
  const [supportBusy, setSupportBusy] = useState(false);
  const [newsItems, setNewsItems] = useState([]);
  const [newsIdx, setNewsIdx] = useState(0);
  const [newsDismissed, setNewsDismissed] = useState([]);
  const [newsOpen, setNewsOpen] = useState(null);
  const [homeBal, setHomeBal] = useState(null);
  const [homeBalErr, setHomeBalErr] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [waBusy, setWaBusy] = useState(false);
  const [chartTarget, setChartTarget] = useState(null);
  const [chartSymbolInput, setChartSymbolInput] = useState('');
  const [chartTimeframe, setChartTimeframe] = useState('15m');
  const [chartSvgUrl, setChartSvgUrl] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState('');
  const [chartMeta, setChartMeta] = useState(null);
  const [keysForm, setKeysForm] = useState({ apiKey: '', apiSecret: '' });
  const [keysBusy, setKeysBusy] = useState(false);
  const [tgStatus, setTgStatus] = useState(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanMsg, setScanMsg] = useState(null);
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [autoScanBusy, setAutoScanBusy] = useState(false);
  const [scanMeta, setScanMeta] = useState(null);
  const fullScanInterval = scanMeta?.full_scan_interval_minutes ?? 5;
  const nextFullScanAt = scanMeta?.next_full_scan_at ?? null;
  const lastFullScanAt = scanMeta?.last_full_scan_at ?? null;
  const pollRef = useRef(null);

  // ── multi-exchange: which exchange the user views, what is connected, auto-trade target ──
  const [exState, setExState] = useState({ connections: [], selectedExchange: 'binance', autoTradeExchange: null });
  const [exBusy, setExBusy] = useState(false);
  const selectedExchange = exState.selectedExchange || 'binance';
  const connectionOf = (ex) => exState.connections.find((c) => c.exchange === ex) || null;

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  async function loadNews() {
    try {
      const res = await fetch('/api/news?limit=15');
      const data = await res.json();
      if (res.ok && Array.isArray(data.items)) {
        setNewsItems(data.items);
        setNewsIdx(0);
      }
    } catch (_) {}
  }

  async function loadSupportThread() {
    try {
      const res = await fetch('/api/support');
      const data = await res.json();
      if (res.ok) setSupportMsgs(data.messages || []);
    } catch (_) {}
  }

  async function sendSupportMsg() {
    const text = supportInput.trim();
    if (!text || supportBusy) return;
    setSupportBusy(true);
    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      setSupportInput('');
      await loadSupportThread();
      showToast('Message sent — admin will reply soon');
    } catch (e) {
      showToast(e.message || 'Failed');
    } finally {
      setSupportBusy(false);
    }
  }

  async function saveWhatsapp() {
    setWaBusy(true);
    try {
      const res = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp: String(whatsapp || '').trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSettings((s) => ({ ...(s || {}), whatsapp: String(whatsapp || '').trim() }));
      showToast('WhatsApp saved');
    } catch (e) {
      showToast(e.message || 'Failed');
    } finally {
      setWaBusy(false);
    }
  }



  function openIctChart(signal = null) {
    const symbol = String(signal?.symbol || signal?.pair || 'BTCUSDT').toUpperCase();
    const direction = String(signal?.direction || signal?.side || '').toUpperCase();
    const strategy = String(signal?.metadata?.strategy || signal?.strategy || '').toLowerCase();
    const signalTf =
      signal?.metadata?.patternTf ||
      signal?.metadata?.setupTf ||
      signal?.structure?.setupTf ||
      signal?.metadata?.structure?.setupTf ||
      signal?.metadata?.entryTf ||
      signal?.metadata?.obTf;
    const timeframe = ['5m', '15m', '30m', '1h', '2h', '4h'].includes(signalTf)
      ? signalTf
      : '15m';
    setSheet(null);
    setChartSymbolInput(symbol);
    setChartTimeframe(timeframe);
    setChartError('');
    setChartSvgUrl(null);
    setChartMeta(null);
    setChartTarget({
      symbol,
      direction: ['LONG', 'SHORT'].includes(direction) ? direction : '',
      strategy: strategy || '',
      signalId: signal?.signal_id || signal?.id || '',
    });
  }

  function submitIctChart(event) {
    event.preventDefault();
    const compact = chartSymbolInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!compact) {
      setChartError('Enter a coin symbol, such as BTC or ETHUSDT.');
      return;
    }
    const symbol = compact.endsWith('USDT') ? compact : `${compact}USDT`;
    setChartError('');
    setChartTarget({ symbol, direction: '' });
  }

  function closeIctChart() {
    setChartTarget(null);
    setChartSvgUrl(null);
    setChartError('');
    setChartMeta(null);
  }

  // Auth bootstrap
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        const data = await res.json();
        setUser(data.user);
        setPlan(data.plan);
        setKeyStatus(data.key_status);
        setSettings(data.settings);
        if (data.settings?.preferredTpLevel) setPreferredTpLevel(+data.settings.preferredTpLevel);
        if (data.user?.role === 'admin') {
          try {
            const sr = await fetch('/api/scan');
            if (sr.ok) {
              const sd = await sr.json();
              if (typeof sd.auto_scan_enabled === 'boolean') setAutoScanEnabled(sd.auto_scan_enabled);
              setScanMeta(sd);
            }
          } catch (_) {}
        }
      } catch {
        router.replace('/login');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  // Signals poll

  const loadSignals = useCallback(async () => {
    try {
      const res = await fetch(`/api/signals?exchange=${selectedExchange}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok === false) return;
      if (data.exchange && data.exchange !== selectedExchange) return; // stale response after a switch
      setSignals(normalizeSignalsPayload(data));
    } catch (_) {}
  }, [selectedExchange]);

  useEffect(() => {
    if (!user) return;
    loadSignals();
    pollRef.current = setInterval(loadSignals, 45000);
    return () => clearInterval(pollRef.current);
  }, [user, loadSignals]);

  const loadExchanges = useCallback(async () => {
    try {
      const r = await fetch('/api/user/exchanges', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      setExState({
        connections: d.connections || [],
        selectedExchange: d.selectedExchange || 'binance',
        autoTradeExchange: d.autoTradeExchange || null,
      });
      setSettings((s) => ({ ...(s || {}), autoTradingEnabled: !!d.autoTradingEnabled, autoTradeExchange: d.autoTradeExchange || null }));
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (user) loadExchanges();
  }, [user, loadExchanges]);

  async function exchangeAction(payload) {
    setExBusy(true);
    try {
      const r = await fetch('/api/user/exchanges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      setExState({
        connections: d.connections || [],
        selectedExchange: d.selectedExchange || 'binance',
        autoTradeExchange: d.autoTradeExchange || null,
      });
      setSettings((s) => ({ ...(s || {}), autoTradingEnabled: !!d.autoTradingEnabled, autoTradeExchange: d.autoTradeExchange || null }));
      if (d.msg) showToast(d.msg);
      return true;
    } catch (e) {
      showToast(e.message);
      return false;
    } finally {
      setExBusy(false);
    }
  }

  async function selectExchange(ex) {
    if (ex === selectedExchange) return;
    setSignals([]); // never show the other exchange's coins under the new label
    setExState((s) => ({ ...s, selectedExchange: ex }));
    exchangeAction({ action: 'select', exchange: ex });
  }

  async function setAutoTradeExchange(ex) {
    if (!user?.can_auto_trade) {
      showToast('Upgrade to Auto plan to enable auto-trade');
      setTab('plans');
      return;
    }
    await exchangeAction(ex ? { action: 'autotrade', exchange: ex, enabled: true } : { action: 'autotrade', exchange: null, enabled: false });
  }

  // Refresh full-scan countdown when cron updates last/next timestamps
  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    async function loadScanMeta() {
      try {
        const res = await fetch('/api/scan');
        if (!res.ok || !alive) return;
        const sd = await res.json();
        setScanMeta(sd);
        if (typeof sd.auto_scan_enabled === 'boolean') setAutoScanEnabled(sd.auto_scan_enabled);
      } catch (_) {}
    }
    loadScanMeta();
    const id = setInterval(loadScanMeta, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [user]);

  useEffect(() => {
    if (!chartTarget?.symbol) return undefined;
    let cancelled = false;
    let objectUrl = null;
    const params = new URLSearchParams({
      symbol: chartTarget.symbol,
      strategy: chartTarget.strategy || 'ict_smc',
      timeframe: chartTimeframe,
      format: 'svg',
    });
    if (chartTarget.direction) params.set('dir', chartTarget.direction);
    if (chartTarget.signalId) params.set('signal_id', chartTarget.signalId);

    setChartLoading(true);
    setChartError('');
    setChartSvgUrl(null);
    setChartMeta(null);
    (async () => {
      try {
        const response = await fetch(`/api/chart?${params.toString()}`, { cache: 'no-store' });
        const body = await response.text();
        if (!response.ok || !/image\/svg\+xml/i.test(response.headers.get('content-type') || '')) {
          let message = `Could not analyze ${chartTarget.symbol}.`;
          try {
            const data = JSON.parse(body);
            if (data.error) message = data.error;
          } catch (_) {}
          throw new Error(message);
        }
        objectUrl = URL.createObjectURL(new Blob([body], { type: 'image/svg+xml' }));
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setChartMeta({
          status: response.headers.get('x-ict-status') || 'ANALYZED',
          price: response.headers.get('x-ict-price'),
        });
        setChartSvgUrl(objectUrl);
      } catch (error) {
        if (!cancelled) setChartError(error.message || 'Chart analysis failed.');
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [chartTarget?.symbol, chartTarget?.direction, chartTarget?.strategy, chartTarget?.signalId, chartTimeframe]);

  useEffect(() => {
    if (!user || tab !== 'profile') return;
    (async () => {
      try {
        const res = await fetch('/api/user/telegram');
        if (res.ok) setTgStatus(await res.json());
      } catch (_) {}
    })();
  }, [tab, user]);

  async function connectTelegram() {
    setTgBusy(true);
    try {
      const res = await fetch('/api/user/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.deep_link) {
        window.open(data.deep_link, '_blank');
        showToast('Telegram opened — tap Start to link');
      } else {
        showToast(data.message || 'Send /start CODE to the bot');
      }
      const st = await fetch('/api/user/telegram');
      if (st.ok) setTgStatus(await st.json());
    } catch (e) {
      showToast(e.message);
    } finally {
      setTgBusy(false);
    }
  }

  async function disconnectTelegram() {
    setTgBusy(true);
    try {
      await fetch('/api/user/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unlink' }),
      });
      setTgStatus({ linked: false });
      showToast('Telegram disconnected');
    } catch (e) {
      showToast(e.message);
    } finally {
      setTgBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  }

  async function saveKeys(e) {
    e.preventDefault();
    setKeysBusy(true);
    try {
      const res = await fetch('/api/user/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keysForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setKeyStatus({ connected: true, key_hint: data.key_hint });
      setKeysForm({ apiKey: '', apiSecret: '' });
      showToast('API keys saved securely');
    } catch (err) {
      showToast(err.message);
    } finally {
      setKeysBusy(false);
    }
  }

  async function toggleAutoTrade() {
    if (!user?.can_auto_trade) {
      showToast('Upgrade to Auto plan to enable auto-trade');
      setTab('plans');
      return;
    }
    const next = !settings?.autoTradingEnabled;
    try {
      const res = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoTradingEnabled: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setSettings((s) => ({ ...s, autoTradingEnabled: next }));
      showToast(next ? 'Auto-trade armed' : 'Auto-trade paused');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function savePreferredTp(level) {
    const n = [1, 2, 3].includes(+level) ? +level : 1;
    setPreferredTpLevel(n);
    try {
      const res = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredTpLevel: n }),
      });
      const data = await res.json();
      if (res.ok) setSettings((s) => ({ ...s, preferredTpLevel: n }));
      else showToast(data.error || 'Could not save TP preference');
    } catch (e) {
      showToast(e.message);
    }
  }

  async function enterNowMarket(s) {
    if (!user?.can_auto_trade) {
      showToast('Upgrade to Auto plan for manual entry');
      setTab('plans');
      return;
    }
    if (settings?.manualEntryEnabled === false) {
      showToast('Manual market entry is disabled');
      return;
    }
    const sid = s.signal_id || `${s.symbol}_${s.direction || s.dir || ''}`;
    setEnterBusyId(sid);
    try {
      const res = await fetch('/api/user/manual-entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: selectedExchange || 'binance',
          signal: {
            ...s,
            metadata: { ...(s.metadata || {}), preferredTpLevel },
          },
          marketPrice: s.current_price ?? s.price ?? s.entry,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Entry failed');
      showToast(data.msg || 'Market order placed');
      setSheet(null);
    } catch (err) {
      showToast(err.message);
    } finally {
      setEnterBusyId(null);
    }
  }

  function stopAiSpeech() {
    try {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch (_) {}
  }

  function speakAiText(text) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    stopAiSpeech();
    const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 1200));
    // Prefer Sinhala voice when available, else default
    const voices = window.speechSynthesis.getVoices?.() || [];
    const si = voices.find((v) => /si[-_]?LK|Sinhala/i.test(`${v.lang} ${v.name}`));
    if (si) {
      u.voice = si;
      u.lang = si.lang || 'si-LK';
    } else {
      u.lang = /[\u0D80-\u0DFF]/.test(text) ? 'si-LK' : 'en-US';
    }
    u.rate = 1;
    window.speechSynthesis.speak(u);
  }

  async function askAi(text, { speak = false } = {}) {
    const q = String(text || '').trim();
    if (!q || aiBusy) return;
    const nextHistory = [...aiMessages, { role: 'user', text: q }];
    setAiMessages(nextHistory);
    setAiBusy(true);
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: q,
          history: nextHistory.slice(-8).map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI failed');
      const reply = data.reply || '—';
      setAiMessages((m) => [...m, { role: 'assistant', text: reply }]);
      if (speak) speakAiText(reply);
    } catch (err) {
      const msg = `Error: ${err.message}`;
      setAiMessages((m) => [...m, { role: 'assistant', text: msg }]);
      if (speak) speakAiText(msg);
    } finally {
      setAiBusy(false);
    }
  }

  async function sendAiMessage(e) {
    e?.preventDefault?.();
    const text = String(aiInput || '').trim();
    if (!text || aiBusy) return;
    setAiInput('');
    await askAi(text, { speak: false });
  }

  function stopVoiceListen() {
    try {
      aiRecognitionRef.current?.stop?.();
    } catch (_) {}
    aiRecognitionRef.current = null;
    setAiListening(false);
  }

  function startVoiceTalk() {
    if (typeof window === 'undefined') return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      showToast('Voice not supported on this browser — use Chrome');
      return;
    }
    if (aiBusy || aiListening) {
      stopVoiceListen();
      return;
    }
    setAiOpen(true);
    stopAiSpeech();
    // Introduce herself, then listen
    speakAiText('ආයුබෝවන්, මම Nila. ඔබේ ප්‍රශ්නය අහන්න.');
    const rec = new SR();
    rec.lang = 'si-LK';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setAiListening(true);
    rec.onerror = () => {
      setAiListening(false);
      showToast('Mic error — allow microphone permission');
    };
    rec.onend = () => setAiListening(false);
    rec.onresult = async (ev) => {
      const said = ev?.results?.[0]?.[0]?.transcript || '';
      setAiListening(false);
      if (!said.trim()) {
        showToast('කිසිවක් ඇසුණේ නැහැ — නැවත Talk ඔබන්න');
        return;
      }
      await askAi(said.trim(), { speak: true });
    };
    aiRecognitionRef.current = rec;
    // Small delay so intro speech starts before mic (some browsers)
    setTimeout(() => {
      try {
        rec.start();
      } catch (e) {
        setAiListening(false);
        showToast(e.message || 'Could not start mic');
      }
    }, 600);
  }

  async function toggleAutoScan() {
    setAutoScanBusy(true);
    try {
      const path = autoScanEnabled ? '/api/scan/stop' : '/api/scan/start';
      const res = await fetch(path, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Toggle failed');
      setAutoScanEnabled(!!data.auto_scan_enabled);
      setScanMsg({ ok: true, text: data.msg || (data.auto_scan_enabled ? 'Auto-scan ON' : 'Auto-scan OFF') });
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setAutoScanBusy(false);
    }
  }

  /**
   * First-time "Scan now":
   * 1) clear stuck lock
   * 2) turn Auto-scan ON (cron continues every 5 min full-scan + 1 min lifecycle)
   * 3) run one full multi-chunk market pass with live progress
   * After this, button stays off while auto is ON — only Stop.
   */
  async function scanNow() {
    if (autoScanEnabled && !scanning) {
      setScanMsg({
        ok: true,
        text: 'Auto-scan already ON — full scan runs every 5 min via cron. Use Stop to pause.',
      });
      return;
    }

    setScanning(true);
    setScanMsg(null);
    setScanProgress(null);

    const chunkSize = 15;
    let totalChunks = 1;
    let chunkIndex = 1;
    let sumSymbols = 0;
    let sumCreated = 0;
    let sumTelegram = 0;
    let totalMarket = null;
    let partialRetries = 0;
    const MAX_PARTIAL_RETRIES = 3;
    let first = true;
    let failed = false;

    try {
      // Clear stuck "Previous scan still RUNNING" locks
      try {
        await fetch('/api/scan/unlock', { method: 'POST' });
      } catch (_) {}

      // Arm cron (1-min + 5-min full-scan)
      try {
        const sr = await fetch('/api/scan/start', { method: 'POST' });
        const sd = await sr.json().catch(() => ({}));
        if (sr.ok) setAutoScanEnabled(true);
        else console.warn('auto-scan start', sd.error);
      } catch (_) {}

      // Stamp schedule so ring starts from this first pass
      try {
        await fetch('/api/scan', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_scan_interval_minutes: fullScanInterval || 5 }),
        });
      } catch (_) {}

      while (chunkIndex <= totalChunks) {
        setScanProgress({
          chunk: chunkIndex,
          total: totalChunks,
          symbols: sumSymbols,
          market: totalMarket,
          retrying: partialRetries > 0,
        });

        let result = null;
        let res = null;
        // One retry after force-unlock if lock still reported busy
        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              universe: 'all',
              exchange: selectedExchange,
              chunkSize,
              resetCursor: first,
              lifecycle: 'skip',
            }),
          });
          result = await res.json().catch(() => null);
          if (result?.skipped && /RUNNING|lock|busy/i.test(String(result.reason || ''))) {
            await fetch('/api/scan/unlock', { method: 'POST' }).catch(() => null);
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          break;
        }
        first = false;

        if (!result || typeof result !== 'object') {
          failed = true;
          setScanMsg({ ok: false, text: 'Invalid scan response' });
          break;
        }
        if (!res.ok || result.error) {
          failed = true;
          setScanMsg({ ok: false, text: result.error || 'Scan failed' });
          break;
        }
        if (result.skipped) {
          failed = true;
          setScanMsg({ ok: false, text: result.reason || 'Scan already running — wait ~1 min' });
          break;
        }

        const got = result.symbolsScanned || 0;
        sumSymbols += got;
        sumCreated += result.signalsCreated || 0;
        sumTelegram += result.telegramSent || 0;

        if (result.coverage) {
          totalChunks = result.coverage.cyclesToFullCoverage || 1;
          totalMarket = result.coverage.totalSymbols;
        }

        try {
          const sigRes = await fetch(`/api/signals?exchange=${selectedExchange}`);
          if (sigRes.ok) {
            const sd = await sigRes.json();
            setSignals(normalizeSignalsPayload(sd));
          }
        } catch (_) {}

        if (result.partial) {
          if (got > 0) {
            partialRetries = 0;
            if (chunkIndex >= totalChunks) break;
            chunkIndex++;
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          partialRetries++;
          if (partialRetries > MAX_PARTIAL_RETRIES) {
            failed = true;
            setScanMsg({
              ok: false,
              text: `Chunk ${chunkIndex}/${totalChunks} timed out (0 symbols). Try again.`,
            });
            break;
          }
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }

        partialRetries = 0;
        if (chunkIndex >= totalChunks) break;
        chunkIndex++;
        await new Promise((r) => setTimeout(r, 400));
      }

      // Final lifecycle-only pass
      try {
        await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lifecycle: 'only', exchange: selectedExchange }),
        });
      } catch (_) {}

      try {
        const sigRes = await fetch(`/api/signals?exchange=${selectedExchange}`);
        if (sigRes.ok) setSignals(normalizeSignalsPayload(await sigRes.json()));
        const st = await fetch('/api/scan');
        if (st.ok) setScanMeta(await st.json());
      } catch (_) {}

      // Mark first full pass time for countdown ring
      try {
        await fetch('/api/scan', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_scan_interval_minutes: fullScanInterval || 5,
            mark_full_scan_done: true,
          }),
        });
      } catch (_) {}

      if (!failed) {
        setAutoScanEnabled(true);
        setScanMsg({
          ok: true,
          text: `First full scan done — ${sumSymbols} coins · +${sumCreated} new · TG ${sumTelegram}. Auto-scan ON: cron continues every ${fullScanInterval || 5} min.`,
        });
      }
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }


  // ─── Home balance (connected exchange) ──────────────────
  const hasExchangeConn = !!connectionOf('binance');
  useEffect(() => {
    if (!user || !hasExchangeConn) {
      setHomeBal(null);
      setHomeBalErr('');
      return undefined;
    }
    let stop = false;
    const loadBal = async () => {
      try {
        const r = await fetch('/api/user/portfolio?exchange=binance', { cache: 'no-store' });
        const d = await r.json();
        if (stop) return;
        if (d.ok === false) setHomeBalErr(d.error || 'Could not load balance');
        else if (d.connected) {
          setHomeBal(d);
          setHomeBalErr('');
        }
      } catch (e) {
        if (!stop) setHomeBalErr(e.message || 'Could not load balance');
      }
    };
    loadBal();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadBal();
    }, 20000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [user, hasExchangeConn]);

  // dismissed news banners are remembered on this device
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('dismissed_news') || '[]');
      if (Array.isArray(raw)) setNewsDismissed(raw);
    } catch (_) {}
  }, []);
  const dismissNews = (id) => {
    setNewsDismissed((prev) => {
      const next = [...new Set([...prev, id])];
      try { localStorage.setItem('dismissed_news', JSON.stringify(next.slice(-60))); } catch (_) {}
      return next;
    });
    setNewsIdx(0);
  };
  const visibleNews = newsItems.filter((x) => !newsDismissed.includes(x.id));

  useEffect(() => {
    if (!user) return;
    loadNews();
    const id = setInterval(loadNews, 120000);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    if (settings?.whatsapp != null) setWhatsapp(String(settings.whatsapp || ''));
  }, [settings?.whatsapp]);

  useEffect(() => {
    if (visibleNews.length < 2) return undefined;
    const id = setInterval(() => {
      setNewsIdx((i) => (i + 1) % visibleNews.length);
    }, 6000);
    return () => clearInterval(id);
  }, [visibleNews.length]);

  useEffect(() => {
    if (supportMode !== 'live' || !supportOpen) return;
    loadSupportThread();
    const id = setInterval(loadSupportThread, 8000);
    return () => clearInterval(id);
  }, [supportMode, supportOpen]);

  // Results summary (TP1 / TP2 / TP3 / SL) — Signals, Trade & Profile tabs
  useEffect(() => {
    if (!user || !user.has_access) return undefined;
    if (!['signals', 'trade', 'profile'].includes(tab)) return undefined;
    let stop = false;
    const loadPerf = async () => {
      try {
        const r = await fetch(`/api/performance?period=${perfPeriod}&direction=${perfDir}`, { cache: 'no-store' });
        const d = await r.json();
        if (!stop && d?.ok !== false && d?.totals) setPerf(d);
      } catch (_) {}
    };
    loadPerf();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadPerf();
    }, 60000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [user, tab, perfPeriod, perfDir]);

  // Lamp switch: when a coin moves stage (e.g. Watching → Ready) flash its lamp
  useEffect(() => {
    const next = new Map();
    const flashes = {};
    const becameReady = [];
    for (const sg of signals) {
      const key = signalKey(sg);
      const stage = signalStage(sg).key;
      next.set(key, stage);
      const prev = prevStageRef.current.get(key);
      if (prev && prev !== stage) {
        flashes[key] = stage;
        if (stage === 'ready') becameReady.push(baseAsset(sg.symbol));
      }
    }
    const hadPrev = prevStageRef.current.size > 0;
    prevStageRef.current = next;
    if (!hadPrev || !Object.keys(flashes).length) return undefined;
    setFlashIds((f) => ({ ...f, ...flashes }));
    if (becameReady.length === 1) showToast(`${becameReady[0]} is now READY`);
    else if (becameReady.length > 1) showToast(`${becameReady.length} coins are now READY`);
    const t = setTimeout(() => {
      setFlashIds((f) => {
        const c = { ...f };
        for (const k of Object.keys(flashes)) delete c[k];
        return c;
      });
    }, 6000);
    return () => clearTimeout(t);
  }, [signals]);

  if (loading) {
    return (
      <div className="auth-page">
        <div style={{ color: 'var(--text-secondary)' }}>Loading…</div>
      </div>
    );
  }

  if (!user) return null;

  const daysLeft = user.trial_days_left ?? 0;
  const isTrial = user.subscription_status === 'trialing';
  const hasAccess = user.has_access;

  const filtered = signals.filter((s) => {
    if (filter === 'ALL') return true;
    if (filter === 'SL_HIT') {
      const st = (s.status || '').toUpperCase();
      return st === 'STOPPED' && !(s.tp1_hit || s.tp1Hit);
    }
    if (filter === 'TP1') return !!(s.tp1_hit || s.tp1Hit) && !(s.tp2_hit || s.tp2Hit) && !(s.tp3_hit || s.tp3Hit);
    if (filter === 'TP2') return !!(s.tp2_hit || s.tp2Hit) && !(s.tp3_hit || s.tp3Hit);
    if (filter === 'TP3') return !!(s.tp3_hit || s.tp3Hit) || (s.status || '').toUpperCase() === 'COMPLETED_PROFIT';
    return (s.status || '').toUpperCase() === filter;
  });

  const counts = {
    watching: signals.filter((s) => (s.status || '').toUpperCase() === 'WATCHING').length,
    ready: signals.filter((s) => (s.status || '').toUpperCase() === 'READY').length,
    ongoing: signals.filter((s) => (s.status || '').toUpperCase() === 'ONGOING').length,
  };

  // ─── Profile verification (shared by Home + Profile) ────
  const verify = (() => {
    const hasWa = !!(settings?.whatsapp || whatsapp);
    const hasKeys = (exState.connections || []).some((c) => c.connected || c.apiKey || c.key_hint || c.exchange);
    const hasTg = !!tgStatus?.linked;
    const steps = [
      { id: 'wa', label: 'WhatsApp', done: hasWa, icon: Icons.whatsapp, go: () => setTab('profile') },
      { id: 'keys', label: 'API keys', done: hasKeys, icon: Icons.key, go: () => setTab('keys') },
      { id: 'tg', label: 'Telegram', done: hasTg, icon: Icons.telegram, go: () => setTab('profile') },
    ];
    const doneCount = steps.filter((x) => x.done).length;
    return {
      steps,
      doneCount,
      pct: Math.round((doneCount / steps.length) * 100),
      verified: doneCount === steps.length,
    };
  })();

  // ─── Tab content ────────────────────────────────────────
  function HomeTab() {
    const bal = homeBal?.balance;
    const nextStep = verify.steps.find((x) => !x.done);
    const remaining = verify.steps.length - verify.doneCount;
    const readyCoins = (() => {
      const best = new Map();
      for (const sg of signals) {
        if (String(sg.status || '').toUpperCase() !== 'READY') continue;
        const key = String(sg.symbol || '').toUpperCase();
        const d = entryDistancePct(sg);
        const prev = best.get(key);
        if (!prev || d < prev.d) best.set(key, { s: sg, d });
      }
      return [...best.values()].sort((x, y) => x.d - y.d).slice(0, 5);
    })();
    const readyTotal = counts.ready;

    return (
      <>
        <div className="home-top">
          <button type="button" className="home-avatar" onClick={() => setTab('profile')} aria-label="Open profile">
            {initialOf(user.email)}
          </button>
          <div className="home-who">
            <div className="home-name">
              {displayNameFromEmail(user.email)}
              {verify.verified && <span className="verified-badge" title="Verified profile">{Icons.verified}</span>}
            </div>
          </div>
        </div>

        <div className="balance-block">
          {!hasExchangeConn ? (
            <>
              <button type="button" className="btn btn-primary bal-cta" onClick={() => setTab('keys')}>
                {Icons.key}
                Set API key
              </button>
              <div className="bal-hint">Connect your exchange to see your live balance</div>
            </>
          ) : bal ? (
            <>
              <BalanceAmount value={bal.equity} />
            </>
          ) : homeBalErr ? (
            <>
              <BalanceAmount value={NaN} />
              <div className="bal-hint" style={{ color: 'var(--danger)' }}>{homeBalErr}</div>
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setTab('keys')}>
                Check API key
              </button>
            </>
          ) : (
            <div className="skeleton" style={{ height: 52, width: 190, margin: '8px auto 0', borderRadius: 14 }} />
          )}
        </div>

        {verify.verified ? (
          <button type="button" className="verify-card is-verified" onClick={() => setTab('verify')}>
            <span className="verified-badge verified-badge-lg">{Icons.verified}</span>
            <div className="verify-text">
              <div className="verify-title">Profile verified</div>
              <div className="verify-sub">WhatsApp, API key and Telegram are all set</div>
            </div>
            <span className="verify-chevron">{Icons.chevron}</span>
          </button>
        ) : (
          <button type="button" className="verify-card" onClick={() => setTab('verify')}>
            <VerifyRing pct={verify.pct} />
            <div className="verify-text">
              <div className="verify-title">Verify your profile</div>
              <div className="verify-sub">
                {remaining === 1 ? 'Just one more step' : `${remaining} steps left`}
                {nextStep ? ` · ${nextStep.label}` : ''}
              </div>
            </div>
            <span className="verify-chevron">{Icons.chevron}</span>
          </button>
        )}

        {!hasAccess && (
          <div className="promo-banner">
            <h3>Trial ended</h3>
            <p>Upgrade to continue viewing live signals and auto-trade.</p>
            <button className="btn" onClick={() => setTab('plans')}>
              View plans
            </button>
          </div>
        )}

        {hasAccess && isTrial && daysLeft <= 2 && (
          <div className="promo-banner">
            <h3>Trial ending soon</h3>
            <p>Only {daysLeft} day{daysLeft === 1 ? '' : 's'} left. Upgrade to keep access.</p>
            <button className="btn" onClick={() => setTab('plans')}>
              Upgrade now
            </button>
          </div>
        )}


        <div className="qa-grid">
          <button className="qa-btn" onClick={() => setTab('signals')}>
            {Icons.signals}
            <span>Signals</span>
          </button>
          <button className="qa-btn" onClick={() => setTab('trade')}>
            {Icons.auto}
            <span>Auto</span>
          </button>
          <button className="qa-btn" onClick={() => setTab('keys')}>
            {Icons.key}
            <span>Keys</span>
          </button>
          <button className="qa-btn" onClick={() => setTab('profile')}>
            {Icons.profile}
            <span>Account</span>
          </button>
        </div>

        {visibleNews.length > 0 && (
          <NewsBanner
            items={visibleNews}
            idx={Math.min(newsIdx, visibleNews.length - 1)}
            setIdx={setNewsIdx}
            onOpen={setNewsOpen}
            onDismiss={dismissNews}
          />
        )}

        <MarketScanCard
          lastAt={lastFullScanAt}
          nextAt={nextFullScanAt}
          intervalMin={fullScanInterval}
          running={!!scanMeta?.full_scan_running}
          enabled={autoScanEnabled}
          counts={counts}
        />

        <div className="coins-card">
          <div className="coins-head">
            <div className="coins-title">
              <span>Ready coins</span>
              <span className="coins-total">Total: {readyTotal}</span>
            </div>
            {readyTotal > 0 && (
              <button type="button" className="coins-all" onClick={() => { setFilter('READY'); setTab('signals'); }}>
                See all
              </button>
            )}
          </div>

          {!hasAccess ? (
            <div className="coins-empty">
              Your trial has ended — upgrade to see ready coins.
              <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => setTab('plans')}>View plans</button>
            </div>
          ) : readyCoins.length === 0 ? (
            <div className="coins-empty">No coins are ready right now. The scanner keeps watching the market.</div>
          ) : (
            readyCoins.map(({ s: sg, d }) => {
              const price = sg.current_price ?? sg.last_price ?? sg.price;
              const isLong = String(sg.direction || sg.side || '').toUpperCase() === 'LONG';
              return (
                <button
                  key={sg.signal_id || sg.id || sg.symbol}
                  type="button"
                  className="coin-row"
                  onClick={() => setSheet(sg)}
                >
                  <CoinIcon symbol={sg.symbol} />
                  <div className="coin-main">
                    <div className="coin-name">{baseAsset(sg.symbol)}</div>
                    <div className="coin-sub">
                      <span className={isLong ? 'coin-dir-long' : 'coin-dir-short'}>{isLong ? 'Long' : 'Short'}</span>
                      {' · Entry '}
                      {fmt(sg.entry ?? sg.entry_price)}
                    </div>
                  </div>
                  <div className="coin-price">
                    <div className="coin-price-main">${price != null ? fmt(price) : '—'}</div>
                    <div className="coin-price-sub">{Number.isFinite(d) ? `${d.toFixed(2)}% to entry` : 'Ready'}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {user.role === 'admin' && (
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 10 }}>
              <div>
                <div className="card-title">Market scan</div>
                <div className="card-subtitle">
                  Click <b>Scan now</b> once — first full pass, then every {fullScanInterval} min via cron (chunk 15 · all users)
                </div>
              </div>
              <span className={`chip ${autoScanEnabled ? 'chip-ongoing' : 'chip-muted'}`}>
                Auto {autoScanEnabled ? 'ON' : 'OFF'}
              </span>
            </div>

            {scanProgress && (
              <div style={{ marginBottom: 12 }}>
                <div className="flex-between" style={{ fontSize: 13, marginBottom: 6 }}>
                  <span>
                    Chunk {scanProgress.chunk}/{scanProgress.total}
                    {scanProgress.retrying ? ' · retry…' : ''}
                  </span>
                  <span className="text-secondary">
                    {scanProgress.symbols || 0}
                    {scanProgress.market ? ` / ~${scanProgress.market}` : ''} coins
                  </span>
                </div>
                <div style={{ height: 8, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, (100 * (scanProgress.chunk - (scanProgress.retrying ? 0.5 : 0))) / Math.max(1, scanProgress.total))}%`,
                      background: 'var(--primary)',
                      transition: 'width 0.3s',
                    }}
                  />
                </div>
              </div>
            )}

            {scanMsg && (
              <div
                className="card-subtitle"
                style={{
                  marginBottom: 12,
                  padding: 10,
                  borderRadius: 12,
                  background: scanMsg.ok ? 'var(--success-soft)' : 'var(--danger-soft)',
                  color: scanMsg.ok ? 'var(--success)' : 'var(--danger)',
                }}
              >
                {scanMsg.ok ? '✅' : '⚠️'} {scanMsg.text}
              </div>
            )}

            <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                          <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
              {!autoScanEnabled ? (
                <button className="btn btn-primary" disabled={scanning} onClick={scanNow}>
                  {scanning ? 'Scanning…' : 'Scan now'}
                </button>
              ) : (
                <button className="btn btn-secondary" disabled={autoScanBusy || scanning} onClick={toggleAutoScan}>
                  {autoScanBusy ? '…' : 'Stop auto-scan'}
                </button>
              )}
              {autoScanEnabled && scanning && (
                <span className="chip chip-ongoing">First pass running…</span>
              )}
            </div>

            </div>
            <p className="form-hint" style={{ marginTop: 10 }}>
              Progress updates each chunk. New signals go to all users + Telegram board/DMs.
              {scanMeta?.exchange ? ` Exchange: ${scanMeta.exchange}.` : ''}
              {scanMeta?.lastScan?.completed_at ? ` Last: ${String(scanMeta.lastScan.completed_at).slice(0, 19)}.` : ''}
            </p>
          </div>
        )}

      </>
    );
  }

  function SignalsTab() {
    // Results period (24h / 7d / 30d) also limits the signal list below.
    // Same timestamp logic as /api/performance so tiles and cards always agree.
    const periodMs = { '24h': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000, '30d': 30 * 24 * 3600 * 1000 }[perfPeriod] || 24 * 3600 * 1000;
    const periodFrom = Date.now() - periodMs;
    const inPeriod = (sg) => {
      const t = new Date(
        sg.completed_at || sg.stopped_at || sg.invalidated_at || sg.entry_hit_at ||
        sg.ready_at || sg.created_at || sg.last_updated_at || 0
      ).getTime();
      return Number.isFinite(t) && t > 0 && t >= periodFrom;
    };
    // Long / Short filter applies to Results tiles, win rate, live board and cards.
    const dirOf = (sg) => String(sg.direction || sg.dir || sg.side || '').toUpperCase();
    const visibleSignals = signals.filter((sg) => perfDir === 'ALL' || dirOf(sg) === perfDir);
    const matches = (sg, f) => {
      const st = String(sg.status || '').toUpperCase();
      const isLive = st === 'WATCHING' || st === 'READY' || st === 'ONGOING';
      // Live board stages stay visible; every closed / TP / SL / invalid card obeys the period.
      if (f === 'ALL') return isLive || inPeriod(sg);
      if (f === 'WATCHING' || f === 'READY' || f === 'ONGOING') return st === f;
      if (!inPeriod(sg)) return false;
      const tp1 = !!(sg.tp1_hit || sg.tp1Hit);
      const tp2 = !!(sg.tp2_hit || sg.tp2Hit);
      const tp3 = !!(sg.tp3_hit || sg.tp3Hit);
      if (f === 'SL_HIT') return st === 'STOPPED' && !tp1;
      if (f === 'TP1') return tp1 && !tp2 && !tp3;
      if (f === 'TP2') return tp2 && !tp3;
      if (f === 'TP3') return tp3 || st === 'COMPLETED_PROFIT';
      return st === f;
    };
    const FILTERS = [
      ['ALL', 'All'],
      ['READY', 'Ready'],
      ['ONGOING', 'Ongoing'],
      ['WATCHING', 'Watching'],
      ['TP1', 'TP1'],
      ['TP2', 'TP2'],
      ['TP3', 'TP3'],
      ['SL_HIT', 'SL'],
      ['INVALIDATED', 'Invalid'],
    ];
    const countOf = (f) => visibleSignals.filter((x) => matches(x, f)).length;

    const list = visibleSignals
      .filter((x) => matches(x, filter))
      .map((x, i) => ({ x, i, st: signalStage(x), d: entryDistancePct(x) }))
      .sort((p, q) => p.st.rank - q.st.rank || (p.st.rank <= 3 ? p.d - q.d : 0) || p.i - q.i);

    // lamp board lanes
    const lane = (key) =>
      visibleSignals
        .map((x) => ({ x, st: signalStage(x), d: entryDistancePct(x) }))
        .filter((r) => r.st.key === key)
        .sort((p, q) => p.d - q.d);
    const lanes = [
      { key: 'watching', title: 'Watching', filter: 'WATCHING', tone: 'off', rows: lane('watching') },
      { key: 'ready', title: 'Ready', filter: 'READY', tone: 'ready', rows: lane('ready') },
      { key: 'ongoing', title: 'Ongoing', filter: 'ONGOING', tone: 'live', rows: lane('ongoing') },
    ];
    const LANE_MAX = 5;

    const tot = perf?.totals;
    const wins = tot?.profitTrades ?? 0;
    const slPure = tot?.slHit ?? 0; // pure SL only (no TP touched) — TP→SL skipped
    const tpThenSl = tot?.tpThenSl ?? 0; // tracked but not shown / not in win-rate
    // Win rate = pure profit vs pure SL only (TP→SL skipped as neutral)
    const winPct = wins + slPure > 0 ? Math.round((wins / (wins + slPure)) * 100) : null;

    return (
      <>
        {!hasAccess ? (
          <div className="promo-banner">
            <h3>Signals locked</h3>
            <p>Your trial has ended. Upgrade to view the live board.</p>
            <button className="btn" onClick={() => setTab('plans')}>Upgrade</button>
          </div>
        ) : (
          <>
            {/* ── Results summary ───────────────────────────── */}
            <div className="sg-results">
              <div className="sg-results-head">
                <div>
                  <div className="sg-results-title">Results</div>
                  <div className="sg-results-sub">
                    {tot ? `${tot.signals} signals · ${tot.completedTrades} closed` : 'Loading performance…'}
                  </div>
                </div>
                <div className="sg-seg" role="tablist">
                  {[['24h', '24h'], ['7d', '7d'], ['30d', '30d']].map(([v, l]) => (
                    <button key={v} type="button" className={perfPeriod === v ? 'on' : ''} onClick={() => setPerfPeriod(v)}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sg-seg sg-dir-seg" role="tablist" style={{ marginBottom: 12 }}>
                {[['ALL', 'All'], ['LONG', '▲ Long'], ['SHORT', '▼ Short']].map(([v, l]) => (
                  <button key={v} type="button" className={perfDir === v ? 'on' : ''} onClick={() => setPerfDir(v)}>
                    {l}
                  </button>
                ))}
              </div>
              <div className="sg-tiles">
                <div className="sg-tile t-tp1">
                  <div className="sg-tile-val">{tot ? tot.tp1 : '–'}</div>
                  <div className="sg-tile-label">TP1 hit</div>
                </div>
                <div className="sg-tile t-tp2">
                  <div className="sg-tile-val">{tot ? tot.tp2 : '–'}</div>
                  <div className="sg-tile-label">TP2 hit</div>
                </div>
                <div className="sg-tile t-tp3">
                  <div className="sg-tile-val">{tot ? tot.tp3 : '–'}</div>
                  <div className="sg-tile-label">TP3 hit</div>
                </div>
                <div className="sg-tile t-sl">
                  <div className="sg-tile-val">{tot ? slPure : '–'}</div>
                  <div className="sg-tile-label">SL hit</div>
                </div>
              </div>
              {tot && (
                <div className="sg-win">
                  <div className="sg-win-row">
                    <span>Win rate</span>
                    <strong>{winPct != null ? `${winPct}%` : '—'}</strong>
                  </div>
                  <div className="sg-win-bar">
                    <span className="g" style={{ width: `${winPct ?? 0}%` }} />
                    <span className="r" style={{ width: winPct != null ? `${100 - winPct}%` : '0%' }} />
                  </div>
                  <div className="sg-win-cap">{wins} profit · {slPure} SL{tpThenSl > 0 ? ` · ${tpThenSl} TP→SL skipped` : ''}</div>
                </div>
              )}
            </div>

            {/* ── Lamp board ────────────────────────────────── */}
            <div className="sg-board">
              <div className="sg-board-head">
                <div className="sg-board-title">Live board</div>
                <div className="sg-board-sub"><i className="sg-live-dot" />Updates automatically</div>
              </div>
              <div className="sg-lanes">
                {lanes.map((ln) => (
                  <div key={ln.key} className={`sg-lane lane-${ln.key}`}>
                    <div className="sg-lane-head">
                      <Lamp tone={ln.rows.length ? ln.tone : 'off'} size={34} />
                      <div className="sg-lane-count">{ln.rows.length}</div>
                      <div className="sg-lane-title">{ln.title}</div>
                    </div>
                    <div className="sg-lane-list">
                      {ln.rows.length === 0 && <div className="sg-lane-empty">—</div>}
                      {ln.rows.slice(0, LANE_MAX).map(({ x }) => {
                        const k = signalKey(x);
                        const isLong = String(x.direction || x.dir || x.side || '').toUpperCase() === 'LONG';
                        return (
                          <button
                            key={k}
                            type="button"
                            className={`sg-pill pill-${ln.key}${flashIds[k] ? ' is-flash' : ''}`}
                            onClick={() => setSheet(x)}
                          >
                            <Lamp tone={ln.tone} size={20} small flash={!!flashIds[k]} />
                            <span className="sg-pill-sym">{baseAsset(x.symbol)}</span>
                            <i className={isLong ? 'up' : 'down'}>{isLong ? '▲' : '▼'}</i>
                          </button>
                        );
                      })}
                      {ln.rows.length > LANE_MAX && (
                        <button type="button" className="sg-more" onClick={() => setFilter(ln.filter)}>
                          +{ln.rows.length - LANE_MAX} more
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Filters ───────────────────────────────────── */}
            <div className="filter-row sg-filters">
              {FILTERS.map(([f, label]) => (
                <button key={f} className={`filter-pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                  {label}
                  <span className="filter-count">{countOf(f)}</span>
                </button>
              ))}
            </div>

            <button className="btn btn-secondary btn-block ict-analysis-launch" onClick={() => openIctChart()}>
              {Icons.scan}
              Analyze any coin with ICT/SMC
            </button>

            {/* ── Signal list ───────────────────────────────── */}
            {list.length === 0 ? (
              <div className="sg-empty">
                <Lamp tone="off" size={64} />
                <h3>No signals here</h3>
                <p>The scanner runs every few minutes — new setups appear here the moment they light up.</p>
              </div>
            ) : (
              list.map(({ x: sg, st, d }) => {
                const key = signalKey(sg);
                const flash = flashIds[key];
                const isLong = String(sg.direction || sg.dir || sg.side || '').toUpperCase() === 'LONG';
                const note = signalNote(sg);
                const price = sg.current_price ?? sg.last_price ?? sg.price;
                const tp1 = !!(sg.tp1_hit || sg.tp1Hit);
                const tp2 = !!(sg.tp2_hit || sg.tp2Hit);
                const tp3 = !!(sg.tp3_hit || sg.tp3Hit);
                const pat = sg.metadata?.pattern || sg.pattern || sg.metadata?.patternGeom?.type;
                const open = ['watching', 'ready', 'ongoing'].includes(st.key);
                const val = (v) => (v != null && v !== '' ? fmt(v) : '—');
                const busyId = sg.signal_id || `${sg.symbol}_${sg.direction || sg.dir || ''}`;
                return (
                  <div
                    key={key || sg.symbol + sg.status}
                    className={`sg-card stage-${st.key}${flash ? ' is-flash' : ''}`}
                    onClick={() => setSheet(sg)}
                  >
                    <div className="sg-card-top">
                      <CoinIcon symbol={sg.symbol || sg.pair} size={46} />
                      <div className="sg-id">
                        <div className="sg-sym">
                          {baseAsset(sg.symbol || sg.pair)}
                          <small>/USDT</small>
                        </div>
                        <div className="sg-tags">
                          <span className={`sg-dir ${isLong ? 'long' : 'short'}`}>{isLong ? '▲ Long' : '▼ Short'}</span>
                          {sg.score != null && <span className="sg-tag">Score {Number(sg.score).toFixed(0)}</span>}
                          {pat && <span className="sg-tag">{String(pat).replace(/_/g, ' ')}</span>}
                        </div>
                      </div>
                      <div className="sg-stage">
                        <span className={`sg-stage-pill s-${st.key}`}>{st.label}</span>
                        {(st.key === 'ready' || st.key === 'watching') && Number.isFinite(d) && (
                          <div className="sg-dist">{d.toFixed(2)}% to entry</div>
                        )}
                      </div>
                    </div>

                    {note && <div className={`sg-note${note.bad ? ' bad' : ''}`}>{note.text}</div>}

                    <div className="sg-levels">
                      <div className="sg-lv"><span>Entry</span><b>{val(sg.entry ?? sg.entry_price)}</b></div>
                      <div className="sg-lv lv-sl"><span>SL</span><b>{val(sg.sl)}</b></div>
                      <div className="sg-lv">
                        <span>{price != null ? 'Now' : 'R:R'}</span>
                        <b>{price != null ? val(price) : sg.rr != null ? Number(sg.rr).toFixed(2) : '—'}</b>
                      </div>
                      <div className={`sg-lv lv-tp${tp1 ? ' hit' : ''}`}><span>TP1{tp1 ? ' ✓' : ''}</span><b>{val(sg.tp1)}</b></div>
                      <div className={`sg-lv lv-tp${tp2 ? ' hit' : ''}`}><span>TP2{tp2 ? ' ✓' : ''}</span><b>{val(sg.tp2)}</b></div>
                      <div className={`sg-lv lv-tp${tp3 ? ' hit' : ''}`}><span>TP3{tp3 ? ' ✓' : ''}</span><b>{val(sg.tp3)}</b></div>
                    </div>

                    {open && (
                      <div className="sg-foot" onClick={(e) => e.stopPropagation()}>
                        <span className="sg-foot-label">TP target</span>
                        <div className="sg-seg sm">
                          {[1, 2, 3].map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={preferredTpLevel === n ? 'on' : ''}
                              onClick={(e) => { e.stopPropagation(); savePreferredTp(n); }}
                            >
                              TP{n}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {st.key === 'ready' && settings?.manualEntryEnabled !== false && user?.can_auto_trade && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        style={{ marginTop: 12 }}
                        disabled={enterBusyId === busyId}
                        onClick={(e) => {
                          e.stopPropagation();
                          enterNowMarket(sg);
                        }}
                      >
                        {enterBusyId === busyId ? 'Placing…' : 'Market Entry'}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </>
        )}
      </>
    );
  }

  function TradeTab() {
    const locked = !user.can_auto_trade;
    const conn = connectionOf(selectedExchange);
    return (
      <>
        <ExchangeSwitch
          selected={selectedExchange}
          connections={exState.connections}
          autoTradeExchange={exState.autoTradeExchange}
          onSelect={selectExchange}
          exchanges={['binance']}
        />

        {hasAccess && <WatchlistSummaryCard />}

        <PortfolioView
          key={selectedExchange}
          exchange={selectedExchange}
          connected={!!conn}
          onConnect={() => setTab('keys')}
        />

        {locked && (
          <div className="promo-banner">
            <h3>Unlock auto-trade</h3>
            <p>Upgrade to the Auto plan to let signals trade on your own exchange account.</p>
            <button className="btn" onClick={() => setTab('plans')}>See plans</button>
          </div>
        )}

        <AutoTradeSelector
          connections={exState.connections}
          autoTradeExchange={exState.autoTradeExchange}
          locked={locked}
          busy={exBusy}
          onSet={setAutoTradeExchange}
          exchanges={['binance']}
        />

        <EquityJourney connected={!!conn && !locked} />

        <RiskModeCard
          settings={settings}
          locked={locked}
          onSaved={(d) => setSettings((s) => ({ ...(s || {}), ...d }))}
        />

        <div className="card">
          <div className="card-title">Default take profit</div>
          <p className="card-subtitle" style={{ marginBottom: 10 }}>
            New trades use this TP. You can still change TP1 / TP2 / TP3 on any open position anytime.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                className="chip"
                onClick={() => savePreferredTp(n)}
                style={{
                  cursor: 'pointer',
                  fontWeight: 700,
                  background: preferredTpLevel === n ? '#0ecb81' : undefined,
                  color: preferredTpLevel === n ? '#0b0e11' : undefined,
                }}
              >
                TP{n}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Heads-up</div>
          <p className="card-subtitle" style={{ marginTop: 6 }}>
            Binance auto-trading uses your connected account. Mock mode routes orders to Binance
            Futures Testnet; Live mode uses Binance Futures mainnet.
          </p>
        </div>
      </>
    );
  }

  function VerifyTab() {
    const conn = connectionOf('binance');
    const waValue = String(settings?.whatsapp || '').trim();
    const waDirty = String(whatsapp || '').trim() !== waValue;
    const meta = {
      wa: {
        n: 1,
        title: 'WhatsApp number',
        desc: 'Used for setup progress and support contact.',
        iconCls: 'vp-icon-wa',
        doneSub: waValue || String(whatsapp || '').trim(),
      },
      keys: {
        n: 2,
        title: 'Exchange API key',
        desc: 'Connect your exchange to see your live balance and enable auto-trading.',
        iconCls: 'vp-icon-key',
        doneSub: `Connected · ${conn?.mode === 'live' ? 'Live' : 'Mock'} account`,
      },
      tg: {
        n: 3,
        title: 'Telegram alerts',
        desc: 'Get READY, TP and SL alerts as private messages.',
        iconCls: 'vp-icon-tg',
        doneSub: 'Connected · alerts are on',
      },
    };
    const todo = verify.steps.filter((x) => !x.done);
    const doneSteps = verify.steps.filter((x) => x.done);

    return (
      <>
        <div className={`vp-hero ${verify.verified ? 'is-verified' : ''}`}>
          {verify.verified ? (
            <>
              <span className="vp-seal">{Icons.verified}</span>
              <div className="vp-hero-title">You&apos;re verified</div>
              <div className="vp-hero-sub">Your profile is fully set up — alerts, balance and auto-trading are ready.</div>
            </>
          ) : (
            <>
              <VerifyRingBig pct={verify.pct} done={verify.doneCount} total={verify.steps.length} />
              <div className="vp-hero-title">{verify.doneCount} of {verify.steps.length} steps completed</div>
              <div className="vp-hero-sub">Finish the steps below to unlock live balance, alerts and auto-trading.</div>
            </>
          )}
          <div className="vp-segs">
            {verify.steps.map((st) => (
              <span key={st.id} className={`vp-seg ${st.done ? 'on' : ''}`} />
            ))}
          </div>
        </div>

        {todo.length > 0 && (
          <>
            <div className="vp-label">To do · {todo.length}</div>
            {todo.map((st) => {
              const m = meta[st.id];
              return (
                <div className="vp-card" key={st.id}>
                  <div className="vp-card-top">
                    <span className={`vp-icon ${m.iconCls}`}>{st.icon}</span>
                    <div className="vp-card-text">
                      <div className="vp-card-title">{m.title}</div>
                      <div className="vp-card-desc">{m.desc}</div>
                    </div>
                    <span className="vp-step">Step {m.n}</span>
                  </div>
                  {st.id === 'wa' && (
                    <input
                      className="form-input"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="+94 7X XXX XXXX"
                      value={whatsapp}
                      onChange={(e) => setWhatsapp(e.target.value)}
                      style={{ marginTop: 14 }}
                    />
                  )}
                  {st.id === 'wa' && (
                    <button className="vp-btn" disabled={waBusy || !waDirty || !String(whatsapp || '').trim()} onClick={saveWhatsapp}>
                      {waBusy ? 'Saving…' : 'Save number'}
                    </button>
                  )}
                  {st.id === 'keys' && (
                    <>
                      <button className="vp-btn" onClick={() => setTab('keys')}>Add API key</button>
                      <div className="vp-note">Enable Read + Trade only — never Withdraw.</div>
                    </>
                  )}
                  {st.id === 'tg' && (
                    <button className="vp-btn" disabled={tgBusy} onClick={connectTelegram}>
                      {tgBusy ? 'Opening…' : 'Connect Telegram'}
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}

        {doneSteps.length > 0 && (
          <>
            <div className="vp-label">Completed · {doneSteps.length}</div>
            <div className="vp-card vp-done-list">
              {doneSteps.map((st) => {
                const m = meta[st.id];
                return (
                  <div className="vp-done-row" key={st.id}>
                    <span className="vp-tick">{Icons.check}</span>
                    <div className="vp-card-text">
                      <div className="vp-card-title">{m.title}</div>
                      <div className="vp-card-desc">{m.doneSub}</div>
                    </div>
                    <span className="vp-done-chip">Done</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </>
    );
  }

  function KeysTab() {
    return (
      <>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title">Your exchanges</div>
          <p className="card-subtitle" style={{ marginTop: 6 }}>
            Connect Binance to view your account and use auto-trading. Start with <b>Mock</b> keys to practice; switch to Live when you are comfortable.
          </p>
        </div>
        {['binance'].map((ex) => (
          <ConnectCard
            key={ex}
            exchange={ex}
            connection={connectionOf(ex)}
            busy={exBusy}
            defaultOpen={ex === selectedExchange && !connectionOf(ex)}
            onConnect={(payload) => exchangeAction({ action: 'connect', ...payload })}
            onDisconnect={(e) => {
              if (typeof window === 'undefined' || window.confirm(`Disconnect ${EX_LABEL[e]}? Auto-trade for it will be turned off.`)) {
                exchangeAction({ action: 'disconnect', exchange: e });
              }
            }}
          />
        ))}
      </>
    );
  }

  function PlansTab() {
    const plans = [
      { id: 'signal', name: 'Signal', price: '$19', desc: 'Live board + Telegram signals', features: ['Signals view', 'Telegram board', 'No auto-trade'] },
      { id: 'auto', name: 'Auto', price: '$49', desc: 'Signals + Binance auto-trade', features: ['Everything in Signal', 'Auto-trade', 'Up to 5 positions'] },
      { id: 'pro', name: 'Pro', price: '$99', desc: 'Higher limits & priority', features: ['Everything in Auto', '15 positions', 'Priority scan'] },
    ];
    return (
      <>
        <div className="card">
          <div className="card-title">Current plan</div>
          <div className="card-subtitle" style={{ marginTop: 4, textTransform: 'capitalize' }}>
            {user.plan} · {user.subscription_status}
            {isTrial && ` · ${daysLeft} days left`}
          </div>
        </div>

        {plans.map((p) => (
          <div className="card" key={p.id}>
            <div className="flex-between" style={{ marginBottom: 8 }}>
              <div className="card-title">{p.name}</div>
              <div className="fw-700" style={{ fontSize: 18 }}>{p.price}<span className="text-muted" style={{ fontSize: 13 }}>/mo</span></div>
            </div>
            <p className="card-subtitle" style={{ marginBottom: 10 }}>{p.desc}</p>
            <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)' }}>
              {p.features.map((f) => <li key={f}>{f}</li>)}
            </ul>
            <button
              className={`btn ${user.plan === p.id ? 'btn-secondary' : 'btn-primary'} btn-block btn-sm`}
              onClick={() => showToast('Stripe checkout coming soon — contact admin to upgrade')}
            >
              {user.plan === p.id ? 'Current plan' : 'Upgrade'}
            </button>
          </div>
        ))}

        <p className="form-hint" style={{ textAlign: 'center' }}>
          Billing via Stripe. Cancel anytime — access until period end.
        </p>
      </>
    );
  }


  function WatchlistSummaryCard() {
    const watching = signals.filter((x) => signalStage(x).key === 'watching').length;
    const ready = signals.filter((x) => signalStage(x).key === 'ready').length;
    const ongoing = signals.filter((x) => signalStage(x).key === 'ongoing').length;
    const tot = perf?.totals;
    const wins = tot?.profitTrades ?? 0;
    const slPure = tot?.slHit ?? 0;
    const tpThenSl = tot?.tpThenSl ?? 0;
    const winPct = wins + slPure > 0 ? Math.round((wins / (wins + slPure)) * 100) : null;
    return (
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ marginBottom: 10 }}>Watchlist &amp; results</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span className="chip chip-muted">Watching {watching}</span>
          <span className="chip chip-ready">Ready {ready}</span>
          <span className="chip chip-ongoing">Ongoing {ongoing}</span>
        </div>
        {tot ? (
          <>
            <div className="sg-tiles" style={{ marginBottom: 8 }}>
              <div className="sg-tile t-tp1"><div className="sg-tile-val">{tot.tp1}</div><div className="sg-tile-label">TP1</div></div>
              <div className="sg-tile t-tp2"><div className="sg-tile-val">{tot.tp2}</div><div className="sg-tile-label">TP2</div></div>
              <div className="sg-tile t-tp3"><div className="sg-tile-val">{tot.tp3}</div><div className="sg-tile-label">TP3</div></div>
              <div className="sg-tile t-sl"><div className="sg-tile-val">{slPure}</div><div className="sg-tile-label">SL</div></div>
            </div>
            <div className="sg-win-cap">
              {wins} profit · {slPure} SL · win {winPct != null ? `${winPct}%` : '—'}
              {tpThenSl > 0 ? ` · ${tpThenSl} TP→SL skipped` : ''}
              <span style={{ opacity: 0.65 }}> · {perfPeriod}{perfDir !== 'ALL' ? ` · ${perfDir}` : ''}</span>
            </div>
          </>
        ) : (
          <div className="card-subtitle">Loading results…</div>
        )}
      </div>
    );
  }

  function ProfileTab() {
    const waSaved = !!(settings?.whatsapp);
    const waDirty = String(whatsapp || '').trim() !== String(settings?.whatsapp || '').trim();
    const subStatus = String(user.subscription_status || (hasAccess ? 'active' : 'inactive')).replace(/_/g, ' ');
    return (
      <>
        {hasAccess && <WatchlistSummaryCard />}
        <div className="profile-hero">
          <div className="profile-hero-banner" />
          <div className="profile-hero-body">
            <div className="profile-avatar" aria-hidden="true">{initialOf(user.email)}</div>
            <div className="profile-name">
              {displayNameFromEmail(user.email)}
              {verify.verified && <span className="verified-badge verified-badge-lg" title="Verified profile">{Icons.verified}</span>}
            </div>
            <div className="profile-email">{user.email}</div>
            <div className="profile-chips">
              <span className="plan-pill">{user.plan}</span>
              <span className="chip chip-muted" style={{ textTransform: 'capitalize' }}>{user.role}</span>
              {isTrial && daysLeft > 0 && <span className="chip chip-ready">{daysLeft}d trial</span>}
            </div>
          </div>
        </div>

        <div className="section-label">Contact &amp; alerts</div>

        <div className="card setting-card">
          <div className="setting-head">
            <div className="setting-icon setting-icon-wa">{Icons.whatsapp}</div>
            <div className="setting-head-text">
              <div className="card-title">WhatsApp number</div>
              <div className="card-subtitle">Used for setup progress and support contact</div>
            </div>
            <span className={`chip ${waSaved ? 'chip-ongoing' : 'chip-muted'}`}>
              {waSaved ? 'Saved' : 'Required'}
            </span>
          </div>
          <input
            className="form-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+94 7X XXX XXXX"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            style={{ marginTop: 14, marginBottom: 12 }}
          />
          <button className="btn btn-primary btn-block" disabled={waBusy || !waDirty} onClick={saveWhatsapp}>
            {waBusy ? 'Saving…' : waSaved && !waDirty ? 'Saved' : 'Save number'}
          </button>
        </div>

        <div className="card setting-card">
          <div className="setting-head">
            <div className="setting-icon setting-icon-tg">{Icons.telegram}</div>
            <div className="setting-head-text">
              <div className="card-title">Personal Telegram</div>
              <div className="card-subtitle">Private READY · ONGOING · TP · SL alerts</div>
            </div>
            <span className={`chip ${tgStatus?.linked ? 'chip-ongoing' : 'chip-muted'}`}>
              {tgStatus?.linked ? 'Connected' : 'Not linked'}
            </span>
          </div>
          <p className="setting-note">
            Link once to receive alerts as private messages. One shared bot — you do not create your own.
          </p>
          {tgStatus?.linked ? (
            <button className="btn btn-secondary btn-block" disabled={tgBusy} onClick={disconnectTelegram}>
              Disconnect Telegram
            </button>
          ) : (
            <button className="btn btn-primary btn-block" disabled={tgBusy} onClick={connectTelegram}>
              {tgBusy ? 'Opening…' : 'Connect Telegram'}
            </button>
          )}
        </div>

        <div className="section-label">Account</div>

        <div className="card kv-card">
          <div className="kv-row">
            <span className="kv-key">Email</span>
            <span className="kv-val">{user.email}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">Plan</span>
            <span className="kv-val" style={{ textTransform: 'capitalize' }}>{user.plan}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">Status</span>
            <span className={`chip ${hasAccess ? 'chip-ongoing' : 'chip-muted'}`} style={{ textTransform: 'capitalize' }}>
              {subStatus}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">Role</span>
            <span className="kv-val" style={{ textTransform: 'capitalize' }}>{user.role}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">App version</span>
            <span className="kv-val">{getVersionLabel()}</span>
          </div>
        </div>

        {user.role === 'admin' && (
          <a href="/admin" className="btn btn-secondary btn-block" style={{ marginBottom: 12 }}>
            {Icons.shield}
            Open Admin Panel
          </a>
        )}

        <div className="disclaimer">
          <div className="disclaimer-title">Risk disclaimer</div>
          <p>
            Cryptocurrency trading involves substantial risk of loss. Past performance is not
            indicative of future results. This software does not guarantee profits. Use at your own risk.
            Prefer Testnet keys until you fully understand the system.
          </p>
        </div>

        <button className="btn btn-signout btn-block" onClick={logout}>
          {Icons.logout}
          Sign out
        </button>
      </>
    );
  }

  const tabs = {
    home: <HomeTab />,
    signals: <SignalsTab />,
    trade: TradeTab(),
    plans: <PlansTab />,
    profile: ProfileTab(),
    keys: KeysTab(),
    verify: VerifyTab(),
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          {tab === 'verify' && (
            <button type="button" className="topbar-back" aria-label="Back" onClick={() => setTab('home')}>
              <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>{Icons.chevron}</span>
            </button>
          )}
          <div className={`topbar-title ${tab === 'verify' ? 'is-center' : ''}`}>
            {tab === 'verify' && 'Verify your profile'}
            {tab === 'home' && 'Home'}
            {tab === 'signals' && 'Signals'}
            {tab === 'trade' && 'Auto-Trade'}
            {tab === 'plans' && 'Plans'}
            {tab === 'profile' && 'Profile'}
            {tab === 'keys' && 'Exchanges'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="text-secondary" style={{ fontSize: 11 }} title="App version">
              {getVersionLabel()}
            </span>
          </div>
        </div>
      </header>

      <main className="main-content">{tabs[tab] || tabs.home}</main>

      <nav className="bottom-nav">
        {[
          { id: 'home', label: 'Home', icon: Icons.home },
          { id: 'signals', label: 'Signals', icon: Icons.signals },
          { id: 'trade', label: 'Trade', icon: Icons.trade },
          { id: 'plans', label: 'Plans', icon: Icons.plans },
          { id: 'profile', label: 'Profile', icon: Icons.profile },
        ].map((t) => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      {newsOpen && (
        <>
          <div className="sheet-overlay" onClick={() => setNewsOpen(null)} />
          <div className="sheet" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <div className="sheet-handle" />
            {newsOpen.imageUrl && (
              <img src={newsOpen.imageUrl} alt="" style={{ width: '100%', borderRadius: 16, marginBottom: 12 }} />
            )}
            <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>{newsOpen.title}</div>
            {newsOpen.body && (
              <div className="text-secondary" style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                {newsOpen.body}
              </div>
            )}
            <div className="text-secondary" style={{ fontSize: 11, marginTop: 10 }}>
              {newsOpen.createdAt ? String(newsOpen.createdAt).slice(0, 16).replace('T', ' ') : ''}
            </div>
            <button className="btn btn-secondary btn-block" style={{ marginTop: 14 }} onClick={() => setNewsOpen(null)}>
              Close
            </button>
          </div>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* Support floating button */}
      <button
        type="button"
        className="ai-fab"
        onClick={() => { setSupportOpen(true); setSupportMode('choose'); }}
        title="Support"
        aria-label="Open Support"
        style={{ fontSize: 12, fontWeight: 700 }}
      >
        Help
      </button>
      {supportOpen && supportMode === 'choose' && (
        <>
          <div className="sheet-overlay" onClick={() => setSupportOpen(false)} />
          <div className="sheet" style={{ maxHeight: '50vh' }}>
            <div className="sheet-handle" />
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Support</div>
            <p className="text-secondary" style={{ fontSize: 13, marginBottom: 14 }}>
              How do you want help?
            </p>
            <button
              className="btn btn-primary btn-block"
              style={{ marginBottom: 10 }}
              type="button"
              onClick={() => { setSupportMode('ai'); setAiOpen(true); }}
            >
              AI Assistant (Nila)
            </button>
            <button
              className="btn btn-secondary btn-block"
              type="button"
              onClick={() => { setSupportMode('live'); loadSupportThread(); }}
            >
              Live chat with admin
            </button>
            <button className="btn btn-secondary btn-block" style={{ marginTop: 10 }} type="button" onClick={() => setSupportOpen(false)}>
              Close
            </button>
          </div>
        </>
      )}
      {supportOpen && supportMode === 'live' && (
        <>
          <div className="sheet-overlay" onClick={() => setSupportOpen(false)} />
          <div className="sheet" style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
            <div className="sheet-handle" />
            <div className="flex-between" style={{ marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Live support</div>
                <div className="text-secondary" style={{ fontSize: 12 }}>Admin replies from Telegram · shows here</div>
              </div>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setSupportOpen(false); setSupportMode(null); }}>
                Close
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(supportMsgs || []).length === 0 && (
                <div className="text-secondary" style={{ fontSize: 13 }}>No messages yet. Say hello below.</div>
              )}
              {(supportMsgs || []).map((m) => (
                <div
                  key={m.id}
                  style={{
                    alignSelf: m.from === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    padding: '8px 12px',
                    borderRadius: 14,
                    background: m.from === 'user' ? 'var(--accent)' : 'var(--bg-elevated, #1a1d24)',
                    color: m.from === 'user' ? '#fff' : 'inherit',
                    fontSize: 13,
                    lineHeight: 1.4,
                  }}
                >
                  {m.text}
                  <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>
                    {m.from === 'admin' ? 'Admin' : 'You'} · {m.at ? String(m.at).slice(11, 16) : ''}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="form-input"
                style={{ flex: 1 }}
                placeholder="Type a message…"
                value={supportInput}
                onChange={(e) => setSupportInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendSupportMsg(); }}
              />
              <button className="btn btn-primary" type="button" disabled={supportBusy} onClick={sendSupportMsg}>
                Send
              </button>
            </div>
          </div>
        </>
      )}
      {aiOpen && (
        <>
          <div className="sheet-overlay" onClick={() => setAiOpen(false)} />
          <div
            className="sheet"
            style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="sheet-handle" />
            <div className="flex-between" style={{ marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Nila · AI Manager</div>
                <div className="text-secondary" style={{ fontSize: 12 }}>
                  Talk button → she listens & answers by voice
                </div>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => {
                  stopVoiceListen();
                  stopAiSpeech();
                  setAiOpen(false);
                }}
              >
                Close
              </button>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={aiBusy}
              onClick={startVoiceTalk}
              style={{
                marginBottom: 12,
                background: aiListening
                  ? 'linear-gradient(135deg, #ef4444, #f97316)'
                  : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                fontSize: 16,
                padding: '14px 16px',
              }}
            >
              {aiListening ? 'Listening… (tap to stop)' : aiBusy ? 'Nila is thinking…' : '🎤 Talk to Nila'}
            </button>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                paddingBottom: 8,
                minHeight: 180,
                maxHeight: '42vh',
              }}
            >
              {aiMessages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '92%',
                    background:
                      m.role === 'user' ? 'var(--primary-soft, #1e3a5f)' : 'var(--border-light, #1f2937)',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: '10px 12px',
                    fontSize: 13,
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {m.text}
                </div>
              ))}
              {aiBusy && (
                <div className="text-secondary" style={{ fontSize: 12 }}>
                  Nila is thinking…
                </div>
              )}
            </div>
            <form onSubmit={sendAiMessage} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input
                className="form-input"
                value={aiInput}
                onChange={(e) => setAiInput(e.target.value)}
                placeholder="Type instead…"
                disabled={aiBusy}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary" type="submit" disabled={aiBusy || !aiInput.trim()}>
                Send
              </button>
            </form>
          </div>
        </>
      )}

      {sheet && (
        <>
          <div className="sheet-overlay" onClick={() => setSheet(null)} />
          <div className="sheet">
            <div className="sheet-handle" />
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <span className="signal-symbol" style={{ fontSize: 18 }}>{sheet.symbol}</span>
              {statusChip(sheet.status, sheet)}
            </div>
            <div className="signal-meta" style={{ marginBottom: 14 }}>
              {dirChip(sheet.direction || sheet.side)}
              {sheet.score != null && <span className="chip chip-muted">Score {Number(sheet.score).toFixed(0)}</span>}
            </div>
            <div className="card" style={{ boxShadow: 'none', border: '1px solid var(--border)' }}>
              <div className="flex-between" style={{ marginBottom: 8 }}>
                <span className="text-secondary">Entry</span>
                <strong>{fmt(sheet.entry || sheet.entry_price)}</strong>
              </div>
              <div className="flex-between" style={{ marginBottom: 8 }}>
                <span className="text-secondary">SL</span>
                <strong>{fmt(sheet.sl)}</strong>
              </div>
              <div className="flex-between" style={{ marginBottom: 8 }}>
                <span className="text-secondary">TP1</span>
                <strong>{fmt(sheet.tp1)}</strong>
              </div>
              <div className="flex-between" style={{ marginBottom: 8 }}>
                <span className="text-secondary">TP2</span>
                <strong>{fmt(sheet.tp2)}</strong>
              </div>
              <div className="flex-between">
                <span className="text-secondary">TP3</span>
                <strong>{fmt(sheet.tp3)}</strong>
              </div>
            </div>
            {String(sheet.status || '').toUpperCase() === 'INVALIDATED' && (
              <div className="card" style={{ boxShadow: 'none', border: '1px solid #f6465d55', marginTop: 12 }}>
                <div style={{ fontWeight: 700, color: '#f6465d', marginBottom: 8 }}>Why invalidated</div>
                {(Array.isArray(sheet.metadata?.invalidation?.reasons) && sheet.metadata.invalidation.reasons.length
                  ? sheet.metadata.invalidation.reasons
                  : [{
                      category: sheet.metadata?.invalidation?.category || 'Missed Entry',
                      reason: sheet.metadata?.invalidation?.reason
                        || sheet.metadata?.entryConfirmReason
                        || 'Setup invalidated',
                      actual: sheet.metadata?.invalidation?.actual ?? sheet.current_price,
                      required: sheet.metadata?.invalidation?.required,
                    }]
                ).map((r, i) => (
                  <div key={i} style={{ marginBottom: 10, fontSize: 13 }}>
                    <div className="text-secondary">{r.category || 'Reason'}</div>
                    <div style={{ fontWeight: 600 }}>{r.reason}</div>
                    {(r.actual != null || r.required != null) && (
                      <div className="text-secondary" style={{ marginTop: 4, fontSize: 12 }}>
                        {r.actual != null && <span>Actual: {String(typeof r.actual === 'object' ? JSON.stringify(r.actual) : r.actual)} </span>}
                        {r.required != null && <span>· Required: {String(r.required)}</span>}
                      </div>
                    )}
                  </div>
                ))}
                {sheet.metadata?.invalidation?.previousStatus && (
                  <div className="text-secondary" style={{ fontSize: 12 }}>
                    Was: {sheet.metadata.invalidation.previousStatus}
                  </div>
                )}
              </div>
            )}
            {(sheet.metadata?.entryConfirmReason || sheet.metadata?.entryClassReason) &&
              String(sheet.status || '').toUpperCase() !== 'INVALIDATED' && (
              <div className="card" style={{ boxShadow: 'none', border: '1px solid var(--border)', marginTop: 12 }}>
                <div className="text-secondary" style={{ fontSize: 12, marginBottom: 4 }}>Entry status</div>
                <div style={{ fontSize: 13 }}>{sheet.metadata?.entryConfirmReason || sheet.metadata?.entryClassReason}</div>
                {sheet.metadata?.entryMode === 'RETEST' && (
                  <div className="text-secondary" style={{ fontSize: 12, marginTop: 4 }}>Mode: Retest watching</div>
                )}
              </div>
            )}
            {String(sheet.status || '').toUpperCase() === 'READY' &&
              settings?.manualEntryEnabled !== false &&
              user?.can_auto_trade && (
              <button
                type="button"
                className="btn btn-primary btn-block"
                style={{ marginTop: 12 }}
                disabled={
                  enterBusyId ===
                  (sheet.signal_id || `${sheet.symbol}_${sheet.direction || sheet.dir || ''}`)
                }
                onClick={() => enterNowMarket(sheet)}
              >
                {enterBusyId ===
                (sheet.signal_id || `${sheet.symbol}_${sheet.direction || sheet.dir || ''}`)
                  ? 'Placing order…'
                  : 'Market Entry'}
              </button>
            )}
            <button
              className="btn btn-primary btn-block"
              style={{ marginTop: 12 }}
              onClick={() => openIctChart(sheet)}
            >
              {Icons.signals}
              View chart analysis
            </button>
            <button className="btn btn-secondary btn-block" style={{ marginTop: 12 }} onClick={() => setSheet(null)}>
              Close
            </button>
          </div>
        </>
      )}

      {chartTarget && (
        <div className="ict-chart-overlay" onClick={closeIctChart}>
          <section
            className="ict-chart-modal"
            role="dialog"
            aria-modal="true"
            aria-label="ICT and SMC chart analysis"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="ict-chart-header">
              <div>
                <div className="ict-chart-title">
                  {chartTarget?.strategy === 'chart_pattern'
                    ? 'Chart Pattern analysis'
                    : chartTarget?.strategy === 'zone_pattern'
                      ? 'Zone + Pattern analysis'
                      : chartTarget?.strategy === 'double_confluence'
                        ? 'Double Top/Bottom analysis'
                        : chartTarget?.strategy === 'ema_bump'
                          ? 'EMA Bump analysis'
                          : 'ICT / SMC chart analysis'}
                </div>
                <div className="card-subtitle">{chartTarget.symbol} · {chartTimeframe}</div>
              </div>
              <button className="btn btn-secondary ict-chart-close" onClick={closeIctChart}>
                Close
              </button>
            </header>

            <form className="ict-chart-form" onSubmit={submitIctChart}>
              <label>
                Coin symbol
                <input
                  value={chartSymbolInput}
                  onChange={(event) => setChartSymbolInput(event.target.value)}
                  placeholder="BTC, ETH, or SOLUSDT"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={chartLoading}>
                {chartLoading ? 'Analyzing…' : 'Analyze'}
              </button>
            </form>

            <div className="ict-timeframes" aria-label="Chart timeframe">
              {['5m', '15m', '30m', '1h', '2h', '4h'].map((timeframe) => (
                <button
                  key={timeframe}
                  className={`filter-pill ${chartTimeframe === timeframe ? 'active' : ''}`}
                  aria-pressed={chartTimeframe === timeframe}
                  onClick={() => setChartTimeframe(timeframe)}
                >
                  {timeframe}
                </button>
              ))}
            </div>

            {chartMeta && (
              <div className="ict-chart-summary">
                <span className={`chip ${chartMeta.status === 'READY' ? 'chip-ready' : 'chip-muted'}`}>
                  {chartMeta.status === 'READY' ? 'ICT setup found' : 'Market context'}
                </span>
                {chartMeta.price && <span className="text-secondary">Price {fmt(chartMeta.price)}</span>}
                {chartMeta.status !== 'READY' && (
                  <span className="text-secondary ict-chart-note">
                    No active setup in this direction and timeframe; the chart still shows current ICT/SMC context.
                  </span>
                )}
              </div>
            )}
            {chartLoading && <div className="ict-chart-state">Loading live candles and ICT/SMC levels…</div>}
            {chartError && <div className="ict-chart-error">{chartError}</div>}
            {chartSvgUrl && (
              <div className="ict-chart-image-wrap">
                <img
                  className="ict-chart-image"
                  src={chartSvgUrl}
                  alt={`${chartTarget.symbol} ${chartTimeframe} ICT/SMC candlestick analysis`}
                />
              </div>
            )}
            <p className="ict-chart-disclaimer">
              Analysis uses closed candles and is informational only, not financial advice.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
