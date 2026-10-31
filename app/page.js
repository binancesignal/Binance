'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
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
import NexoraSplashScreen from '../components/NexoraSplashScreen.js';
import ScanLogPanel from '../components/ScanLogPanel.js';
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
    // A trade that touched a TP before the stop is a TP result — only a stop with no TP is an SL
    if (signal?.tp3_hit || signal?.tp3Hit) return <span className="chip chip-ongoing">✅ TP3</span>;
    if (signal?.tp2_hit || signal?.tp2Hit) return <span className="chip chip-ongoing">🎯 TP2 hit</span>;
    if (signal?.tp1_hit || signal?.tp1Hit) return <span className="chip chip-ongoing">🎯 TP1 hit</span>;
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
    if (tp2) return { key: 'tp', label: 'TP2 hit', lamp: 'tp', rank: 4 };
    if (tp1) return { key: 'tp', label: 'TP1 hit', lamp: 'tp', rank: 4 };
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
  if (strat === 'powerful_max_gpt') {
    const pm = s.metadata?.powerfulMax || {};
    const ew = pm.primaryElliott;
    return { text: `PMax GPT · ${ew?.type || 'EW'}${ew?.currentWave != null ? ` W${ew.currentWave}` : ''} · ${Math.round(s.score || 0)}` };
  }
  if (strat === 'harmonic') {
    const family = s.metadata?.harmonic?.family || pat.replace(/_(BULL|BEAR)$/i, '');
    const dPrice = s.metadata?.harmonic?.D?.price ?? s.entry;
    return {
      text: `Harmonic · ${String(family).replace(/_/g, ' ')}${s.metadata?.patternTf ? ` · ${s.metadata.patternTf}` : ''}${dPrice != null ? ` · D ${fmt(dPrice)}` : ''}`,
    };
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
  if (strat === 'ob_fib') {
    const f = s.metadata?.obFib;
    const ltf = String(s.metadata?.patternTf || f?.tf || '').toUpperCase();
    const head = `${f?.refLabel || f?.refTf || 'HTF'} Fib ${f?.hitRatio ?? ''}${f?.hitPrice != null ? ` @ ${fmt(f.hitPrice)}` : ''}${ltf ? ` · LTF ${ltf}` : ''}`;
    const tail =
      st === 'WATCHING'
        ? 'Waiting for price to return to the Fib ∩ Order Block zone'
        : st === 'READY'
          ? 'Price is near the Fib ∩ Order Block entry'
          : st === 'ONGOING'
            ? 'Entry reached · trade in progress'
            : st === 'INVALIDATED' && s.metadata?.invalidation?.reason
              ? s.metadata.invalidation.reason
              : '';
    return { text: `OB · ${head}${tail ? ` — ${tail}` : ''}` };
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
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  wallet: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
    </svg>
  ),
  refer: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      <path d="M19 8v6" />
      <path d="M22 11h-6" />
    </svg>
  ),
  gift: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="13" rx="2" />
      <path d="M12 8v13" />
      <path d="M19 12H5" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
    </svg>
  ),
  trophy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="M7 4h10v4a5 5 0 0 1-10 0V4z" />
      <path d="M17 8h1a3 3 0 0 0 0-6h-1" />
      <path d="M7 8H6a3 3 0 0 1 0-6h1" />
    </svg>
  ),
  eye: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};


// ─── Main App ───────────────────────────────────────────────
function AppInner({ onGate }) {
  const router = useRouter();
  const [tab, setTab] = useState('home');
  const [levelInfo, setLevelInfo] = useState(null); // My Profile: level + trading volume
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
  const [sigStrategy, setSigStrategy] = useState('ALL'); // 'ALL' | 'OB_FIB' (board filter, follows Coin Scan selection)
  const [signalDisplayLimit, setSignalDisplayLimit] = useState(10);
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
  const [chartLabels, setChartLabels] = useState('clean'); // 'clean' | 'full' chart text labels
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState('');
  const [chartMeta, setChartMeta] = useState(null);
  // Single-coin OB+Fib scan (user can type any symbol and scan)
  const [coinScanInput, setCoinScanInput] = useState('');
  const [coinScanBusy, setCoinScanBusy] = useState(false);
  const [coinScanErr, setCoinScanErr] = useState('');
  const [coinScanResult, setCoinScanResult] = useState(null); // { symbol, price, groups, signals, scannedAt, ... }
  const [coinScanRefs, setCoinScanRefs] = useState(['1w', '1M', '3M', '1Y']); // HTF fib timeframes
  const [coinScanLtfs, setCoinScanLtfs] = useState(['5m', '15m', '30m', '1h', '2h', '4h']); // LTF order-block timeframes
  const [coinScanMode, setCoinScanMode] = useState('scan'); // 'scan' | 'backtest'
  const [coinBtBusy, setCoinBtBusy] = useState(false);
  const [coinBtErr, setCoinBtErr] = useState('');
  const [coinBtResult, setCoinBtResult] = useState(null); // { events, symbol?, universe, tally }
  const [coinBtUniverse, setCoinBtUniverse] = useState(20); // top-N volume coins when no symbol
  const [coinBtOpen, setCoinBtOpen] = useState(null); // unused — chart opens via openIctChart
  const [coinBtFibs, setCoinBtFibs] = useState([0.382, 0.5, 0.618, 0.65, 0.786]); // selected fib ratios for backtest
  const coinBtStop = useRef(false);
  const marketStop = useRef(false);
  const [marketScan, setMarketScan] = useState(null); // all-coins scan: { running, scanned, total, signals, errors, ... }
  const [marketSort, setMarketSort] = useState('near'); // 'near' | 'score'
  const [marketDir, setMarketDir] = useState('ALL'); // 'ALL' | 'LONG' | 'SHORT'
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
    const direction = String(signal?.direction || signal?.dir || signal?.side || '').toUpperCase();
    const strategy = String(signal?.metadata?.strategy || signal?.strategy || '').toLowerCase();
    const signalTf =
      signal?.metadata?.patternTf ||
      signal?.metadata?.setupTf ||
      signal?.structure?.setupTf ||
      signal?.metadata?.structure?.setupTf ||
      signal?.metadata?.entryTf ||
      signal?.metadata?.obTf ||
      signal?.tf;
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
      refTf: signal?.refTf || '',
      fibRatio: signal?.fibRatio ?? '',
      obTime: signal?.obTime || signal?.ob?.time || '',
      fibLevels: signal?.fibLevels || null,
      entry: signal?.entry ?? '',
      sl: signal?.sl ?? '',
      tp1: signal?.tp1 ?? '',
      obHigh: signal?.ob?.high ?? signal?.obHigh ?? '',
      obLow: signal?.ob?.low ?? signal?.obLow ?? '',
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

  async function runCoinScan(e) {
    if (e) e.preventDefault();
    const compact = String(coinScanInput || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!compact) {
      // no coin typed → scan EVERY Binance coin with the selected Fib TF / LTF / fib lines
      return runMarketScan();
    }
    setMarketScan(null);
    if (!coinScanRefs.length || !coinScanLtfs.length) {
      setCoinScanErr('අඩුම තරමින් Fib time frame එකක් සහ LTF එකක් select කරන්න');
      return;
    }
    const symbol = compact.endsWith('USDT') ? compact : `${compact}USDT`;
    setCoinScanBusy(true);
    setCoinScanErr('');
    setCoinScanResult(null);
    try {
      const res = await fetch('/api/scan/symbol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, refTimeframes: coinScanRefs, timeframes: coinScanLtfs, fibLevels: coinBtFibs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);
      setCoinScanResult(data);
      if (!data.signalCount) showToast(`${symbol} — signals නැත`);
      else showToast(`${symbol} — ${data.signalCount} signal(s)`);
    } catch (err) {
      setCoinScanErr(err.message || 'Scan failed');
    } finally {
      setCoinScanBusy(false);
    }
  }

  /**
   * Scan all coins → the SAME chunked scanner the cron job uses (/api/scan, chunks of 15, rotating cursor),
   * forced to OB + HTF Fib for this run with the Fib TF / LTF / fib lines selected above.
   * Signals are saved as normal WATCHING / READY / ONGOING signals and shown as the usual signal cards below.
   */
  async function runPipelineScan() {
    marketStop.current = false;
    setCoinScanBusy(true);
    setCoinScanErr('');
    setCoinScanResult(null);
    setSigStrategy('OB_FIB');
    setFilter('ALL');
    const chunkSize = 15;
    const acc = { pipeline: true, running: true, scanned: 0, total: 0, created: 0, signals: [], errors: [], note: '', stopped: false, done: false };
    const snap = () => setMarketScan({ ...acc, signals: [], errors: [...acc.errors] });
    snap();
    let totalChunks = 1;
    let chunkIndex = 1;
    let first = true;
    let partialRetries = 0;
    try {
      try {
        await fetch('/api/scan/unlock', { method: 'POST' });
      } catch (_) {}
      while (chunkIndex <= totalChunks && !marketStop.current) {
        let result = null;
        let res = null;
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
              strategyOverride: 'ob_fib',
              obFibOverride: { refTimeframes: coinScanRefs, timeframes: coinScanLtfs, fibLevels: coinBtFibs },
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
        if (!result || typeof result !== 'object') throw new Error('Invalid scan response');
        if (res.status === 403) throw new Error('Admin only — admin account එකෙන් scan කරන්න');
        if (!res.ok || result.error) throw new Error(result.error || 'Scan failed');
        if (result.skipped) throw new Error(result.reason || 'Scan already running — wait ~1 min');

        const got = result.symbolsScanned || 0;
        acc.scanned += got;
        acc.created += result.signalsCreated || 0;
        if (result.coverage) {
          totalChunks = result.coverage.cyclesToFullCoverage || 1;
          acc.total = result.coverage.totalSymbols || acc.total;
        }
        snap();
        try {
          const sigRes = await fetch(`/api/signals?exchange=${selectedExchange}`);
          if (sigRes.ok) setSignals(normalizeSignalsPayload(await sigRes.json()));
        } catch (_) {}

        if (result.partial && got === 0) {
          partialRetries++;
          if (partialRetries > 3) throw new Error(`Chunk ${chunkIndex}/${totalChunks} timed out (0 symbols). Try again.`);
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        partialRetries = 0;
        if (chunkIndex >= totalChunks) {
          acc.done = true;
          break;
        }
        chunkIndex++;
        await new Promise((r) => setTimeout(r, 400));
      }
      // final lifecycle pass → watching / ready / ongoing statuses refreshed for every active signal
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
    } catch (err) {
      setCoinScanErr(err.message || 'Scan failed');
    }
    acc.stopped = marketStop.current && !acc.done;
    acc.running = false;
    snap();
    setCoinScanBusy(false);
    showToast(`Coins ${acc.scanned}${acc.total ? '/' + acc.total : ''} scan කළා — +${acc.created} new signal(s)`);
    try {
      setTimeout(() => document.querySelector('.sg-board')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    } catch (_) {}
  }

  async function runMarketScan() {
    // admin → the real chunked scanner (cards on the board); everyone else → read-only preview list
    if (user?.role === 'admin') return runPipelineScan();
    if (!coinScanRefs.length || !coinScanLtfs.length) {
      setCoinScanErr('අඩුම තරමින් Fib time frame එකක් සහ LTF එකක් select කරන්න');
      return;
    }
    if (!coinBtFibs.length) {
      setCoinScanErr('අඩුම තරමින් Fib line එකක් select කරන්න');
      return;
    }
    marketStop.current = false;
    setCoinScanBusy(true);
    setCoinScanErr('');
    setCoinScanResult(null);
    const CHUNK = 8;
    const seen = new Set();
    const acc = { running: true, scanned: 0, total: 0, signals: [], errors: [], note: '', stopped: false, done: false };
    const snap = () => setMarketScan({ ...acc, signals: [...acc.signals], errors: [...acc.errors] });
    snap();
    let offset = 0;
    let symbols = null;
    let total = 0;
    let retries = 0;
    try {
      while (!marketStop.current) {
        const slice = symbols ? symbols.slice(offset, offset + CHUNK) : null;
        const res = await fetch('/api/scan/market', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            refTimeframes: coinScanRefs,
            timeframes: coinScanLtfs,
            fibLevels: coinBtFibs,
            offset,
            limit: CHUNK,
            ...(slice ? { symbols: slice, total } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error('Login කරලා නැහැ');
        if (!res.ok) {
          if (data.banned) {
            acc.errors.push('Binance rate limit (ban) — scan නතර කළා, පස්සේ try කරන්න');
            break;
          }
          throw new Error(data.error || `Scan failed (${res.status})`);
        }
        if (data.symbols) symbols = data.symbols;
        total = data.total || total;
        for (const sg of data.signals || []) {
          const k = [sg.symbol, sg.refTf, sg.ltf, sg.dir, sg.obTime, sg.fibRatio].join('|');
          if (seen.has(k)) continue;
          seen.add(k);
          acc.signals.push(sg);
        }
        acc.errors.push(...(data.errors || []));
        if (data.banned) {
          acc.errors.push('Binance rate limit (ban) — scan නතර කළා, පස්සේ try කරන්න');
          break;
        }
        if (data.throttled) {
          retries++;
          if (retries > 6) {
            acc.errors.push('Binance rate limit — නැවත නැවත hit වුණා, නතර කළා');
            break;
          }
          acc.note = 'Binance rate limit — තත්පර 20ක් ඉඳලා ඉදිරියට යනවා…';
          snap();
          await new Promise((r) => setTimeout(r, data.retryAfterMs || 20000));
          acc.note = '';
          continue;
        }
        retries = 0;
        acc.total = total;
        offset = data.nextOffset;
        acc.scanned = Math.min(total, offset);
        snap();
        if (data.done || !total) {
          acc.done = true;
          break;
        }
      }
    } catch (err) {
      setCoinScanErr(err.message || 'Scan failed');
    }
    acc.stopped = marketStop.current && !acc.done;
    acc.running = false;
    acc.note = '';
    snap();
    setCoinScanBusy(false);
    showToast(`Coins ${acc.scanned}/${acc.total || '—'} scan කළා — ${acc.signals.length} signal(s)`);
  }

  async function runCoinBacktest(e) {
    if (e) e.preventDefault();
    if (!coinScanRefs.length || !coinScanLtfs.length) {
      setCoinBtErr('අඩුම තරමින් Fib time frame එකක් සහ LTF එකක් select කරන්න');
      return;
    }
    const compact = String(coinScanInput || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const single = compact ? (compact.endsWith('USDT') ? compact : `${compact}USDT`) : '';
    const universe = Math.min(100, Math.max(5, Math.round(+coinBtUniverse) || 20));
    coinBtStop.current = false;
    setCoinBtBusy(true);
    setCoinBtErr('');
    setCoinBtOpen(null);
    const acc = {
      symbol: single || null,
      universe: single ? 1 : universe,
      events: [],
      errors: [],
      win: 0,
      loss: 0,
      timeout: 0,
      open: 0,
      total: 0,
      winRate: null,
      avgRet: null,
      offset: 0,
      done: false,
      running: true,
    };
    setCoinBtResult({ ...acc });

    const tally = (events) => {
      let win = 0, loss = 0, timeout = 0, open = 0, retSum = 0, retN = 0;
      for (const ev of events) {
        if (ev.outcome === 'WIN') win++;
        else if (ev.outcome === 'LOSS') loss++;
        else if (ev.outcome === 'TIMEOUT') timeout++;
        else open++;
        if (ev.retPct != null) { retSum += ev.retPct; retN++; }
      }
      const done = win + loss;
      return {
        win, loss, timeout, open,
        total: events.length,
        winRate: done ? +((win / done) * 100).toFixed(1) : null,
        avgRet: retN ? +(retSum / retN).toFixed(2) : null,
      };
    };

    let offset = 0;
    try {
      while (!coinBtStop.current) {
        const body = {
          refTimeframes: coinScanRefs,
          timeframes: coinScanLtfs,
          fibLevels: coinBtFibs.length ? coinBtFibs : [0.382, 0.5, 0.618, 0.786],
          entryMode: 'mid',
          maxBars: 80,
          direction: 'BOTH',
        };
        if (single) {
          body.symbol = single;
        } else {
          body.universe = universe;
          body.offset = offset;
          body.limit = 5;
        }
        const res = await fetch('/api/backtest/ob-fib', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Backtest failed (${res.status})`);
        acc.events.push(...(data.events || []));
        acc.errors.push(...(data.errors || []));
        acc.offset = data.nextOffset ?? offset;
        Object.assign(acc, tally(acc.events));
        setCoinBtResult({ ...acc, events: [...acc.events], running: true });
        if (data.banned) {
          acc.errors.push('Binance rate limit — stopped early');
          break;
        }
        if (single || data.done) {
          acc.done = true;
          break;
        }
        offset = data.nextOffset;
      }
    } catch (err) {
      setCoinBtErr(err.message || 'Backtest failed');
    }
    Object.assign(acc, tally(acc.events));
    acc.running = false;
    setCoinBtResult({ ...acc, events: [...acc.events] });
    setCoinBtBusy(false);
    if (acc.events.length) {
      showToast(`${single || 'Top ' + universe} — ${acc.total} trades · ${acc.winRate != null ? acc.winRate + '%' : '—'} win`);
    } else if (!acc.errors.length) {
      showToast('Backtest trades නැත');
    }
  }

  function openCoinScanChart(sig) {
    // Opens the live OB + HTF Fib chart for this exact (HTF × LTF) pair
    openIctChart({
      symbol: sig.symbol,
      direction: sig.dir || sig.direction,
      strategy: 'ob_fib',
      metadata: { strategy: 'ob_fib', patternTf: sig.ltf || sig.metadata?.patternTf },
      refTf: sig.refTf || sig.metadata?.obFib?.refTf,
      fibRatio: sig.fibRatio ?? sig.metadata?.obFib?.hitRatio,
      obTime: sig.obTime || sig.ob?.time,
      fibLevels: coinBtFibs,
    });
  }

  // Auth bootstrap
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.status === 401) {
          router.replace('/welcome');
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
        router.replace('/welcome');
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
      labels: chartLabels,
    });
    if (chartTarget.direction) params.set('dir', chartTarget.direction);
    if (chartTarget.signalId) params.set('signal_id', chartTarget.signalId);
    if (chartTarget.refTf) params.set('ref', chartTarget.refTf);
    if (chartTarget.fibRatio !== undefined && chartTarget.fibRatio !== '') params.set('fib', String(chartTarget.fibRatio));
    if (chartTarget.obTime) params.set('ob_time', String(chartTarget.obTime));
    if (Array.isArray(chartTarget.fibLevels) && chartTarget.fibLevels.length) params.set('fibs', chartTarget.fibLevels.join(','));

        if (chartTarget.entry !== '' && chartTarget.entry != null) params.set('entry', String(chartTarget.entry));
        if (chartTarget.sl !== '' && chartTarget.sl != null) params.set('sl', String(chartTarget.sl));
        if (chartTarget.tp1 !== '' && chartTarget.tp1 != null) params.set('tp1', String(chartTarget.tp1));
        if (chartTarget.obHigh !== '' && chartTarget.obHigh != null) params.set('ob_high', String(chartTarget.obHigh));
        if (chartTarget.obLow !== '' && chartTarget.obLow != null) params.set('ob_low', String(chartTarget.obLow));

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
  }, [chartTarget?.symbol, chartTarget?.direction, chartTarget?.strategy, chartTarget?.signalId, chartTarget?.refTf, chartTarget?.fibRatio, chartTarget?.obTime, JSON.stringify(chartTarget?.fibLevels || []), chartTimeframe, chartLabels]);

  // My Profile: level / trading volume
  useEffect(() => {
    if (!user || tab !== 'profile') return;
    (async () => {
      try {
        const res = await fetch('/api/user/level', { cache: 'no-store' });
        if (res.ok) setLevelInfo(await res.json());
      } catch (_) {}
    })();
  }, [tab, user]);

  useEffect(() => {
    if (!user || tab !== 'settings') return;
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
    router.replace('/welcome');
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
    if (!['signals', 'trade', 'settings'].includes(tab)) return undefined;
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

  // Report the (unchanged) auth/loading state to the POFIT splash overlay.
  useEffect(() => {
    onGate?.({ loading, hasUser: !!user });
  }, [loading, user, onGate]);

  // The POFIT splash (rendered by <App/>) covers the screen while loading.
  if (loading) return null;

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
      { id: 'wa', label: 'WhatsApp', done: hasWa, icon: Icons.whatsapp, go: () => setTab('settings') },
      { id: 'keys', label: 'API keys', done: hasKeys, icon: Icons.key, go: () => setTab('keys') },
      { id: 'tg', label: 'Telegram', done: hasTg, icon: Icons.telegram, go: () => setTab('settings') },
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



/** Compact level lines (home cards) */
function LevelSparkline({ sg, height = 56 }) {
  const entry = Number(sg.entry ?? sg.entry_price);
  const sl = Number(sg.sl ?? sg.stop_loss ?? sg.stopLoss);
  const tp1 = Number(sg.tp1);
  const tp2 = Number(sg.tp2);
  const tp3 = Number(sg.tp3);
  const cur = Number(sg.current_price ?? sg.last_price ?? sg.price);
  const levels = [entry, sl, tp1, tp2, tp3, cur].filter((n) => Number.isFinite(n) && n > 0);
  if (levels.length < 2) return <div className="level-spark empty" style={{ height }} />;
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  const pad = (max - min) * 0.1 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const w = 100;
  const y = (v) => ((hi - v) / (hi - lo)) * (height - 10) + 5;
  const lines = [
    { v: sl, c: '#EF4444' },
    { v: entry, c: '#3B82F6' },
    { v: tp1, c: '#10B981' },
    { v: tp2, c: '#059669' },
    { v: tp3, c: '#047857' },
  ].filter((x) => Number.isFinite(x.v) && x.v > 0);
  const cy = Number.isFinite(cur) ? y(cur) : null;
  return (
    <svg className="level-spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height, width: '100%' }}>
      <rect x="0" y="0" width={w} height={height} fill="#FFFFFF" rx="6" />
      {lines.map((L, i) => (
        <line key={i} x1="2" y1={y(L.v)} x2={w - 2} y2={y(L.v)} stroke={L.c} strokeWidth="1.3" opacity="0.9" />
      ))}
      {cy != null && <circle cx={w - 8} cy={cy} r="2.5" fill="#0F172A" stroke="#fff" strokeWidth="1" />}
    </svg>
  );
}

/** Red/green candlestick chart with Entry / SL / TP overlays */
function CandleChart({ sg, height = 240 }) {
  const [candles, setCandles] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const symbol = String(sg?.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sym = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr('');
    setCandles(null);
    (async () => {
      try {
        // Binance public klines – no API key needed
        const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=15m&limit=48`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Could not load candles');
        const raw = await res.json();
        if (!Array.isArray(raw) || !raw.length) throw new Error('No candle data');
        const list = raw.map((k) => ({
          t: k[0],
          o: +k[1],
          h: +k[2],
          l: +k[3],
          c: +k[4],
        }));
        if (!cancelled) setCandles(list);
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Chart failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sym]);

  const entry = Number(sg?.entry ?? sg?.entry_price);
  const sl = Number(sg?.sl ?? sg?.stop_loss);
  const tp1 = Number(sg?.tp1);
  const tp2 = Number(sg?.tp2);
  const tp3 = Number(sg?.tp3);

  if (loading) {
    return (
      <div className="candle-chart loading" style={{ height }}>
        Loading candles…
      </div>
    );
  }
  if (err || !candles?.length) {
    return (
      <div className="candle-chart loading" style={{ height }}>
        {err || 'No data'} · <LevelSparkline sg={sg} height={height - 20} />
      </div>
    );
  }

  const levelVals = [entry, sl, tp1, tp2, tp3].filter((n) => Number.isFinite(n) && n > 0);
  let min = Math.min(...candles.map((c) => c.l), ...levelVals);
  let max = Math.max(...candles.map((c) => c.h), ...levelVals);
  const pad = (max - min) * 0.06 || 1;
  min -= pad;
  max += pad;

  const W = 360;
  const H = height;
  const padL = 4;
  const padR = 52;
  const padT = 10;
  const padB = 16;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = candles.length;
  const gap = 1.5;
  const cw = Math.max(2, plotW / n - gap);
  const y = (v) => padT + ((max - v) / (max - min)) * plotH;
  const x = (i) => padL + i * (plotW / n) + (plotW / n - cw) / 2;

  const levels = [
    { v: sl, c: '#EF4444', label: 'SL' },
    { v: entry, c: '#3B82F6', label: 'Entry' },
    { v: tp1, c: '#10B981', label: 'TP1' },
    { v: tp2, c: '#059669', label: 'TP2' },
    { v: tp3, c: '#047857', label: 'TP3' },
  ].filter((L) => Number.isFinite(L.v) && L.v > 0);

  return (
    <svg className="candle-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
      <rect x="0" y="0" width={W} height={H} fill="#FFFFFF" rx="10" />
      {/* grid */}
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={padL} y1={padT + plotH * g} x2={W - padR} y2={padT + plotH * g} stroke="#F1F5F9" strokeWidth="1" />
      ))}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const color = up ? '#10B981' : '#EF4444';
        const bodyTop = y(Math.max(c.o, c.c));
        const bodyBot = y(Math.min(c.o, c.c));
        const bodyH = Math.max(1, bodyBot - bodyTop);
        const cx = x(i) + cw / 2;
        return (
          <g key={c.t || i}>
            <line x1={cx} y1={y(c.h)} x2={cx} y2={y(c.l)} stroke={color} strokeWidth="1.2" />
            <rect x={x(i)} y={bodyTop} width={cw} height={bodyH} fill={color} rx="0.5" />
          </g>
        );
      })}
      {levels.map((L) => (
        <g key={L.label}>
          <line
            x1={padL}
            y1={y(L.v)}
            x2={W - padR}
            y2={y(L.v)}
            stroke={L.c}
            strokeWidth={L.label === 'Entry' ? 1.8 : 1.3}
            strokeDasharray={L.label === 'Entry' ? undefined : '4 3'}
            opacity="0.95"
          />
          <text x={W - padR + 4} y={y(L.v) + 3} fontSize="9" fontWeight="700" fill={L.c}>
            {L.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function buildDemoPositions() {
  const pool = [
    { symbol: 'BTCUSDT', entry: 64250, price: 65120, side: 'LONG', tp1: 65500, tp2: 66200, tp3: 67500, sl: 62800 },
    { symbol: 'ETHUSDT', entry: 3420, price: 3385, side: 'SHORT', tp1: 3350, tp2: 3280, tp3: 3180, sl: 3520 },
    { symbol: 'SOLUSDT', entry: 148.2, price: 152.6, side: 'LONG', tp1: 155, tp2: 160, tp3: 168, sl: 142 },
    { symbol: 'BNBUSDT', entry: 595, price: 588, side: 'SHORT', tp1: 580, tp2: 570, tp3: 555, sl: 612 },
    { symbol: 'XRPUSDT', entry: 0.62, price: 0.641, side: 'LONG', tp1: 0.65, tp2: 0.68, tp3: 0.72, sl: 0.59 },
    { symbol: 'DOGEUSDT', entry: 0.142, price: 0.138, side: 'SHORT', tp1: 0.135, tp2: 0.128, tp3: 0.12, sl: 0.15 },
    { symbol: 'ADAUSDT', entry: 0.45, price: 0.468, side: 'LONG', tp1: 0.48, tp2: 0.5, tp3: 0.54, sl: 0.43 },
    { symbol: 'AVAXUSDT', entry: 38.5, price: 37.2, side: 'SHORT', tp1: 36.5, tp2: 35, tp3: 33, sl: 40.2 },
  ];
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 4);
  return shuffled.map((c, i) => ({
    signal_id: `demo-${c.symbol}-${i}`,
    symbol: c.symbol,
    direction: c.side,
    side: c.side,
    entry: c.entry,
    entry_price: c.entry,
    current_price: c.price,
    last_price: c.price,
    price: c.price,
    tp1: c.tp1,
    tp2: c.tp2,
    tp3: c.tp3,
    sl: c.sl,
    status: 'ONGOING',
    _demo: true,
  }));
}

  function HomeTab() {
    const bal = homeBal?.balance;
    const equity = bal?.equity ?? (hasExchangeConn ? null : 0);

    const userDisplayId = (() => {
      const e = (user?.email || 'user@pofit.com').split('@')[0];
      let h = 0;
      for (let i = 0; i < e.length; i++) h = (h * 31 + e.charCodeAt(i)) >>> 0;
      return String(100000000 + (h % 900000000)).slice(0, 9);
    })();

    const ongoingTrades = (() => {
      const list = [];
      for (const sg of signals) {
        if (String(sg.status || '').toUpperCase() !== 'ONGOING') continue;
        const entry = Number(sg.entry ?? sg.entry_price);
        const cur = Number(sg.current_price ?? sg.last_price ?? sg.price);
        let pnlPct = null;
        if (entry > 0 && cur > 0) {
          const isLong = String(sg.direction || sg.side || '').toUpperCase() === 'LONG';
          pnlPct = isLong ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100;
        }
        list.push({ sg, pnlPct, cur, entry });
      }
      return list.slice(0, 4);
    })();

    return (
      <>
        <div className="xm-balance-card">
          <div className="xm-bal-top">
            <div className="xm-account-pill">
              <span className="xm-dot" />
              User #{userDisplayId}
            </div>
          </div>

          <div className="xm-tags">
            <span className="tag">Real</span>
            <span className="tag">Binance</span>
          </div>

          <div className="xm-balance-row">
            <div className="bal-main">
              {equity == null ? (
                <span style={{ opacity: 0.55 }}>…</span>
              ) : (
                <>${Number(equity).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
              )}
            </div>
            <button type="button" className="eye-btn" aria-label="Toggle balance visibility">
              {Icons.eye}
            </button>
          </div>
          <div className="xm-bal-sub">
            {equity == null ? '—' : `$${Number(equity).toFixed(2)}`}
          </div>

          <div className="xm-actions">
            <button type="button" className="xm-btn secondary" onClick={() => setTab('keys')}>
              {hasExchangeConn ? 'Manage Keys' : 'Connect Binance'}
            </button>
            <button type="button" className="xm-btn" onClick={() => setTab('verify')}>
              Verify Account
            </button>
          </div>
        </div>

        <div className="xm-qa">
          <button type="button" className="xm-qa-btn" onClick={() => setTab('referral')}>
            <div className="qa-icon">{Icons.refer}</div>
            <span>Refer a Friend</span>
          </button>
          <button type="button" className="xm-qa-btn" onClick={() => setTab('plans')}>
            <div className="qa-icon">{Icons.gift}</div>
            <span>Bonuses</span>
          </button>
          <button type="button" className="xm-qa-btn" onClick={() => setTab('trade')}>
            <div className="qa-icon">{Icons.chart}</div>
            <span>Trade</span>
          </button>
          <button type="button" className="xm-qa-btn" onClick={() => setTab('signals')}>
            <div className="qa-icon">{Icons.trophy}</div>
            <span>Free Earn</span>
          </button>
        </div>

        {/* Admin news – directly under quick actions */}
        {visibleNews.length > 0 && (
          <div className="xm-news-wrap">
            <NewsBanner
              items={visibleNews}
              idx={Math.min(newsIdx, visibleNews.length - 1)}
              setIdx={setNewsIdx}
              onOpen={setNewsOpen}
              onDismiss={dismissNews}
            />
          </div>
        )}

        <div className="xm-section-head">
          <h2>Profit Trading Club</h2>
          <button type="button" className="see-all" onClick={() => setTab('profile')}>›</button>
        </div>
        <div className="xm-club-card">
          <div className="xm-club-top">
            <div className="xm-club-logo">PF</div>
            <div className="xm-club-bal">
              Balance
              <strong>0 XMC</strong>
            </div>
          </div>
          <div className="xm-club-status">
            <div>
              <div className="xm-club-status-label">Your Status in Profit Trading Club</div>
              <div className="xm-club-status-val">Bronze</div>
            </div>
            <div className="xm-club-medal" aria-hidden="true">{Icons.trophy}</div>
          </div>
          <div className="xm-club-progress">
            <div>
              <div className="label">Current Trading Volume</div>
              <div className="val">$0</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="label">Target Trading Volume</div>
              <div className="val">$1,000,000</div>
            </div>
          </div>
        </div>

        <div className="xm-section-head">
          <h2>Ongoing Trades</h2>
          {ongoingTrades.length > 0 && (
            <button type="button" className="see-all" onClick={() => { setFilter('ONGOING'); setTab('signals'); }}>
              See all
            </button>
          )}
        </div>

        {ongoingTrades.length === 0 ? (
          <div className="xm-empty-trades">
            No active trades at the moment.<br />
            Once a signal goes live, it will appear here.
            <div style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setTab('signals')}>
                View Signals
              </button>
            </div>
          </div>
        ) : (
          <div className="xm-ongoing-grid">
            {ongoingTrades.map(({ sg, pnlPct, cur }) => {
              const up = pnlPct == null ? true : pnlPct >= 0;
              const pctStr = pnlPct == null ? '—' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
              return (
                <button
                  key={sg.signal_id || sg.id || sg.symbol}
                  type="button"
                  className="xm-trade-card"
                  onClick={() => setSheet(sg)}
                >
                  <div className="sym-row">
                    <CoinIcon symbol={sg.symbol} size={28} />
                    <div>
                      <div className="sym-name">{baseAsset(sg.symbol)}</div>
                      <div className="sym-sub">{String(sg.direction || sg.side || '').toUpperCase() || '—'}</div>
                    </div>
                  </div>
                  <div className="price">{cur != null ? fmt(cur) : '—'}</div>
                  <div className={`chg ${up ? 'up' : 'down'}`}>{pctStr}</div>
                  <LevelSparkline sg={sg} />
                </button>
              );
            })}
          </div>
        )}

        {user.role === 'admin' && (
          <div style={{ padding: '0 10px 16px' }}>
            <MarketScanCard
              lastAt={lastFullScanAt}
              nextAt={nextFullScanAt}
              intervalMin={fullScanInterval}
              running={!!scanMeta?.full_scan_running}
              enabled={autoScanEnabled}
              counts={counts}
            />
          </div>
        )}

        {!verify.verified && (
          <div className="xm-bottom-bar" onClick={() => setTab('verify')} role="button" tabIndex={0}>
            <div className="shield">{Icons.shield}</div>
            <div className="xm-bottom-text">Verify your account and get 7 days free trial</div>
            <div className="bonus-pill">Bonus</div>
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
    const isObFibSg = (sg) => (sg.metadata?.strategy || sg.strategy) === 'ob_fib';
    const obFibSelected = (sg) => {
      const f = sg.metadata?.obFib || {};
      const ltf = sg.metadata?.patternTf || f.tf;
      const ratio = +f.hitRatio;
      return (
        coinScanRefs.includes(f.refTf) &&
        coinScanLtfs.includes(ltf) &&
        (!coinBtFibs.length || coinBtFibs.some((v) => Math.abs(+v - ratio) < 1e-6))
      );
    };
    const visibleSignals = signals.filter(
      (sg) =>
        (perfDir === 'ALL' || dirOf(sg) === perfDir) &&
        (sigStrategy !== 'OB_FIB' || (isObFibSg(sg) && obFibSelected(sg)))
    );
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

    // Render signals progressively so a coin never becomes inaccessible just because
    // its live rank moved outside the first 10. Start light, then load the rest in batches.
    const DISPLAY_BATCH = 10;
    const displayList = list.slice(0, signalDisplayLimit);
    const hasMoreSignals = list.length > signalDisplayLimit;

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
    const slPure = tot?.slHit ?? 0; // SL = stopped WITHOUT touching any TP
    const tpThenSl = tot?.tpThenSl ?? 0; // TP1/TP2 then stopped — already counted in the TP tiles
    // Every trade that reached a TP is a win (TP3 profit + TP→SL); only a no-TP stop is a loss
    const winCount = tot?.winTrades ?? wins + tpThenSl;
    const winPct = winCount + slPure > 0 ? Math.round((winCount / (winCount + slPure)) * 100) : null;

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
            {/* ── Coin search + OB+Fib scan / backtest ─────────────────── */}
            <div className="sg-results" style={{ marginBottom: 14 }}>
              <div className="sg-results-head">
                <div>
                  <div className="sg-results-title">Coin Scan</div>
                  <div className="sg-results-sub">
                    {coinScanMode === 'backtest'
                      ? 'Coin select කරලා history backtest · Entry OB mid · SL band එකට පිටින් · Win %'
                      : 'Coin එකක් select කරන්න · හැම Fib TF එකකටම වෙන වෙනම Fib ඇඳලා, හැම LTF එකකම Order Block බලනවා'}
                  </div>
                </div>
                <div className="sg-seg" role="tablist">
                  <button type="button" className={coinScanMode === 'scan' ? 'on' : ''} onClick={() => setCoinScanMode('scan')}>Scan</button>
                  <button type="button" className={coinScanMode === 'backtest' ? 'on' : ''} onClick={() => setCoinScanMode('backtest')}>Backtest</button>
                </div>
              </div>
              <form onSubmit={coinScanMode === 'backtest' ? runCoinBacktest : runCoinScan} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                <input
                  type="text"
                  className="cs-input"
                  value={coinScanInput}
                  onChange={(e) => setCoinScanInput(e.target.value)}
                  placeholder={coinScanMode === 'backtest' ? 'Coin (optional) — හිස්නම් top volume' : 'Coin (optional) — හිස්නම් Binance coins ඔක්කොම'}
                  autoComplete="off"
                  spellCheck={false}
                />
                {coinScanMode === 'backtest' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#555' }}>
                    Coins
                    <input
                      type="number"
                      min={5}
                      max={100}
                      value={coinBtUniverse}
                      onChange={(e) => setCoinBtUniverse(+e.target.value)}
                      className="cs-input"
                      style={{ width: 72, minWidth: 72 }}
                      title="Top volume coin ගණන (coin type නොකළ විට)"
                    />
                  </label>
                )}
                <button type="submit" className="btn" disabled={coinScanMode === 'backtest' ? coinBtBusy : coinScanBusy} style={{ minWidth: 110 }}>
                  {coinScanMode === 'backtest'
                    ? (coinBtBusy ? 'Backtesting…' : (coinScanInput.trim() ? 'Backtest coin' : 'Scan top volume'))
                    : (coinScanBusy ? 'Scanning…' : (coinScanInput.trim() ? 'Scan coin' : 'Scan all coins'))}
                </button>
                {coinScanMode === 'backtest' && coinBtBusy && (
                  <button type="button" className="btn btn-secondary" onClick={() => { coinBtStop.current = true; }}>Stop</button>
                )}
                {coinScanMode === 'scan' && coinScanBusy && marketScan?.running && (
                  <button type="button" className="btn btn-secondary" onClick={() => { marketStop.current = true; }}>Stop</button>
                )}
              </form>

              {[
                ['Fib time frames', [['1d', 'Daily'], ['1w', 'Weekly'], ['1M', 'Month'], ['3M', '3 Month'], ['1Y', '1 Year']], coinScanRefs, setCoinScanRefs],
                ['LTF (Order Block)', ['5m', '15m', '30m', '1h', '2h', '4h'].map((t) => [t, t]), coinScanLtfs, setCoinScanLtfs],
              ].map(([label, opts, sel, setSel]) => (
                <div key={label} style={{ marginTop: 10 }}>
                  <div className="cs-chip-label">{label}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {opts.map(([v, l]) => {
                      const on = sel.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          className={`cs-chip${on ? ' on' : ''}`}
                          onClick={() => setSel(on ? sel.filter((x) => x !== v) : [...sel, v])}
                        >
                          {l}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {(
                <div style={{ marginTop: 10 }}>
                  <div className="cs-chip-label">Fib lines (filter) — select කරපු lines විතරයි බලන්නේ</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {[-0.272, 0, 0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786, 0.886, 1, 1.272].map((v) => {
                      const on = coinBtFibs.some((x) => Math.abs(x - v) < 1e-9);
                      return (
                        <button
                          key={v}
                          type="button"
                          className={`cs-chip${on ? ' on' : ''}`}
                          onClick={() =>
                            setCoinBtFibs((p) =>
                              on ? p.filter((x) => Math.abs(x - v) > 1e-9) : [...p, v].sort((a, b) => a - b)
                            )
                          }
                        >
                          {v}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {coinScanMode === 'scan' && coinScanErr && <div style={{ marginTop: 8, color: '#DC2626', fontSize: 13 }}>{coinScanErr}</div>}
              {coinScanMode === 'backtest' && coinBtErr && <div style={{ marginTop: 8, color: '#DC2626', fontSize: 13 }}>{coinBtErr}</div>}

              {coinScanMode === 'backtest' && coinBtResult && (() => {
                const r = coinBtResult;
                const tzMin = -new Date().getTimezoneOffset();
                const fmtT = (sec) => {
                  if (!sec) return '—';
                  const d = new Date(+sec * 1000);
                  return Number.isNaN(+d) ? '—' : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                };
                const longs = r.events.filter((e) => e.dir === 'LONG');
                const shorts = r.events.filter((e) => e.dir === 'SHORT');
                const wr = (list) => {
                  const w = list.filter((e) => e.outcome === 'WIN').length;
                  const l = list.filter((e) => e.outcome === 'LOSS').length;
                  return w + l ? ((w / (w + l)) * 100).toFixed(1) : '—';
                };
                const openBtChart = (ev) => {
                  openIctChart({
                    symbol: ev.symbol,
                    direction: ev.dir,
                    dir: ev.dir,
                    strategy: 'ob_fib',
                    metadata: { strategy: 'ob_fib', patternTf: ev.tf },
                    tf: ev.tf,
                    refTf: ev.refTf,
                    fibRatio: ev.fibRatio,
                    obTime: ev.obTime,
                    entry: ev.entry,
                    sl: ev.sl,
                    tp1: ev.tp1,
                    ob: ev.ob,
                  });
                };
                const rowKey = (ev, i) => `${ev.symbol}-${ev.time}-${ev.tf}-${ev.refTf}-${i}`;
                return (
                  <div className="cs-wrap">
                    <div className="cs-summary">
                      <strong>{r.symbol || `Top ${r.universe}`}</strong>
                      {r.running ? <span> · scanning… {r.offset || 0}/{r.universe}</span> : null}
                      <span> · <b>{r.total}</b> trade(s)</span>
                      {r.winRate != null ? <span> · Win <b>{r.winRate}%</b></span> : null}
                      {r.avgRet != null ? <span> · avg {r.avgRet}%</span> : null}
                      <span> · {r.win}W / {r.loss}L{r.timeout ? ` / ${r.timeout}TO` : ''}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                      <div className="cs-ltf hit" style={{ padding: '8px 12px' }}>All {r.winRate != null ? r.winRate + '%' : '—'} · n={r.total}</div>
                      <div className="cs-ltf" style={{ padding: '8px 12px' }}>Long {wr(longs)}% · n={longs.length}</div>
                      <div className="cs-ltf" style={{ padding: '8px 12px' }}>Short {wr(shorts)}% · n={shorts.length}</div>
                    </div>
                    <div style={{ marginTop: 12, overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                            <th style={{ padding: '4px 6px' }}>Time</th>
                            <th style={{ padding: '4px 6px' }}>Coin</th>
                            <th style={{ padding: '4px 6px' }}>Dir</th>
                            <th style={{ padding: '4px 6px' }}>TF</th>
                            <th style={{ padding: '4px 6px' }}>Fib</th>
                            <th style={{ padding: '4px 6px' }}>Entry</th>
                            <th style={{ padding: '4px 6px' }}>Result</th>
                            <th style={{ padding: '4px 6px' }}>Ret%</th>
                            <th style={{ padding: '4px 6px' }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.events.slice(0, 80).map((ev, i) => {
                            const key = rowKey(ev, i);
                            return (
                              <tr key={key} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{fmtT(ev.time)}</td>
                                <td style={{ padding: '4px 6px', fontWeight: 600 }}>{ev.symbol}</td>
                                <td style={{ padding: '4px 6px', color: ev.dir === 'LONG' ? '#059669' : '#dc2626' }}>{ev.dir}</td>
                                <td style={{ padding: '4px 6px' }}>{ev.tf}/{ev.refLabel || ev.refTf}</td>
                                <td style={{ padding: '4px 6px' }}>{ev.fibRatio}</td>
                                <td style={{ padding: '4px 6px' }}>{ev.entry}</td>
                                <td style={{ padding: '4px 6px' }}>
                                  <span className={`sg-stage-pill ${ev.outcome === 'WIN' ? 's-ongoing' : ev.outcome === 'LOSS' ? 's-watching' : ''}`}>
                                    {ev.outcome}
                                  </span>
                                </td>
                                <td style={{ padding: '4px 6px' }}>{ev.retPct != null ? ev.retPct : '—'}</td>
                                <td style={{ padding: '4px 6px' }}>
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ padding: '2px 8px', fontSize: 11, minWidth: 0 }}
                                    onClick={() => openBtChart(ev)}
                                  >
                                    Chart
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {r.events.length > 80 && <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>Showing 80 of {r.events.length}</div>}
                    </div>
                    {r.errors?.length > 0 && <div className="cs-errors">{r.errors.slice(0, 6).join(' · ')}</div>}
                  </div>
                );
              })()}

              {coinScanMode === 'scan' && marketScan && (() => {
                const m = marketScan;
                const fmtT = (iso) => {
                  if (!iso) return '—';
                  const d = new Date(iso);
                  return Number.isNaN(+d) ? '—' : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                };
                const val = (v) => (v != null && v !== '' && Number.isFinite(+v) ? fmt(v) : '—');
                if (m.pipeline) {
                  const ppct = m.total ? Math.round((m.scanned / m.total) * 100) : 0;
                  return (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ fontSize: 13, marginBottom: 6 }}>
                        {m.running ? 'Scanning…' : m.stopped ? 'Stopped' : 'Done'} · <strong>{m.scanned}</strong>/{m.total || '…'} coins ({ppct}%) ·{' '}
                        <strong>+{m.created}</strong> new signal(s)
                      </div>
                      <div style={{ height: 6, borderRadius: 4, background: '#E2E8F0', overflow: 'hidden', marginBottom: 8 }}>
                        <div style={{ width: `${ppct}%`, height: '100%', background: '#16A34A', transition: 'width .3s' }} />
                      </div>
                      <div style={{ fontSize: 12, color: '#475569' }}>
                        Signals පහළ Live board / cards වල පේනවා (OB + Fib filter on) ↓
                      </div>
                      {m.errors?.length > 0 && <div className="cs-errors">{m.errors.slice(0, 5).join(' · ')}</div>}
                    </div>
                  );
                }
                const list = m.signals
                  .filter((x) => marketDir === 'ALL' || String(x.dir).toUpperCase() === marketDir)
                  .sort((a, b) =>
                    marketSort === 'score'
                      ? (b.score || 0) - (a.score || 0)
                      : (a.distPct ?? 99) - (b.distPct ?? 99)
                  );
                const coins = new Set(list.map((x) => x.symbol)).size;
                const pct = m.total ? Math.round((m.scanned / m.total) * 100) : 0;
                return (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>
                      {m.running ? 'Scanning…' : m.stopped ? 'Stopped' : 'Done'} · <strong>{m.scanned}</strong>/{m.total || '…'} coins ({pct}%) ·{' '}
                      <strong>{list.length}</strong> signal(s) · {coins} coin(s)
                    </div>
                    <div style={{ height: 6, borderRadius: 4, background: '#E2E8F0', overflow: 'hidden', marginBottom: 8 }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: '#16A34A', transition: 'width .3s' }} />
                    </div>
                    {m.note && <div style={{ fontSize: 12, color: '#B45309', marginBottom: 6 }}>{m.note}</div>}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {[['ALL', 'All'], ['LONG', '▲ Buy'], ['SHORT', '▼ Sell']].map(([v, l]) => (
                        <button key={v} type="button" className={`cs-chip${marketDir === v ? ' on' : ''}`} onClick={() => setMarketDir(v)}>{l}</button>
                      ))}
                      <span style={{ width: 8 }} />
                      {[['near', 'Nearest entry'], ['score', 'Score']].map(([v, l]) => (
                        <button key={v} type="button" className={`cs-chip${marketSort === v ? ' on' : ''}`} onClick={() => setMarketSort(v)}>{l}</button>
                      ))}
                    </div>
                    {list.length === 0 && !m.running && (
                      <div style={{ fontSize: 13, color: '#64748b' }}>මේ filters වලට signal නැත.</div>
                    )}
                    {list.slice(0, 100).map((sg) => {
                      const isLong = String(sg.dir).toUpperCase() === 'LONG';
                      return (
                        <div
                          key={`${sg.symbol}|${sg.refTf}|${sg.ltf}|${sg.dir}|${sg.obTime}|${sg.fibRatio}`}
                          style={{ padding: '8px 0', borderTop: '1px solid #E2E8F0' }}
                        >
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                            <strong style={{ fontSize: 14 }}>{String(sg.symbol).replace(/USDT$/, '')}</strong>
                            <span className={`chip ${isLong ? 'chip-ready' : 'chip-watching'}`} style={{ fontWeight: 700 }}>{isLong ? '▲ BUY' : '▼ SELL'}</span>
                            <span style={{ fontSize: 12 }}>{sg.refLabel || sg.refTf} Fib {sg.fibRatio}{sg.fibPrice != null ? ` @ ${val(sg.fibPrice)}` : ''}</span>
                            <span style={{ fontSize: 12 }}>LTF {String(sg.ltf || '').toUpperCase()}</span>
                            <button type="button" className="btn btn-secondary" style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 12, minWidth: 0 }} onClick={() => openCoinScanChart({ ...sg, direction: sg.dir })}>Chart</button>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, color: '#475569', marginTop: 3 }}>
                            <span>Entry {val(sg.entry)}</span>
                            <span>SL {val(sg.sl)}</span>
                            <span>TP1 {val(sg.tp1)}</span>
                            <span>RR {sg.rr != null ? (+sg.rr).toFixed(2) : '—'}</span>
                            <span>Score {sg.score != null ? Math.round(+sg.score) : '—'}</span>
                            <span>Price {val(sg.price)} ({sg.distPct != null ? `${sg.distPct}%` : '—'} away)</span>
                            <span>OB {fmtT(sg.obTimeIso)}</span>
                          </div>
                        </div>
                      );
                    })}
                    {list.length > 100 && <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>Showing 100 of {list.length}</div>}
                    {m.errors?.length > 0 && <div className="cs-errors">{m.errors.slice(0, 5).join(' · ')}</div>}
                  </div>
                );
              })()}

              {coinScanMode === 'scan' && coinScanResult && (() => {
                const fmtT = (iso) => {
                  if (!iso) return '—';
                  const d = new Date(iso);
                  return Number.isNaN(+d) ? '—' : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                };
                const val = (v) => (v != null && v !== '' && Number.isFinite(+v) ? fmt(v) : '—');
                const groups = Array.isArray(coinScanResult.groups) ? coinScanResult.groups : [];
                const scanPrice = Number.isFinite(+coinScanResult.price) ? +coinScanResult.price : null;
                return (
                  <div className="cs-wrap">
                    <div className="cs-summary">
                      <strong>{coinScanResult.symbol}</strong>
                      {scanPrice != null ? <span> · ${val(scanPrice)}</span> : null}
                      <span> · <b>{coinScanResult.signalCount || 0}</b> signal(s)</span>
                      {coinScanResult.scannedAt ? <span> · scanned {fmtT(coinScanResult.scannedAt)}</span> : null}
                    </div>

                    {groups.map((g) => {
                      const sigCount = g.ltf.reduce((n, r) => n + r.signals.length, 0);
                      return (
                        <div key={g.refTf} className="cs-group">
                          <div className="cs-group-head">
                            <div className="cs-group-title">{g.refLabel} Fib</div>
                            <span className={`sg-stage-pill ${sigCount ? 's-ongoing' : 's-watching'}`}>
                              {sigCount ? `${sigCount} signal` : 'signal නැත'}
                            </span>
                          </div>
                          {g.fib ? (
                            <div className="cs-group-sub">
                              {g.fib.candleDir === 'bullish' ? '▲ bullish' : '▼ bearish'} candle ({fmtT(g.fib.candleTimeIso)}) · High {val(g.fib.high)} · Low {val(g.fib.low)}
                              <div className="cs-fibline">
                                {g.fib.levels.filter((l) => l.selected).map((l) => `${l.ratio} @ ${val(l.price)}`).join(' · ')}
                              </div>
                            </div>
                          ) : (
                            <div className="cs-group-sub bad">{g.note || 'no data'}</div>
                          )}

                          <div className="cs-ltf-row">
                            {g.ltf.map((row) => (
                              <span
                                key={row.tf}
                                className={`cs-ltf ${!row.checked ? 'skip' : row.signals.length ? 'hit' : ''}`}
                                title={!row.checked ? 'skipped' : row.signals.length ? `${row.signals.length} signal` : 'signal නැත'}
                              >
                                {row.tf.toUpperCase()} {!row.checked ? '–' : row.signals.length ? `✓ ${row.signals.length}` : '·'}
                              </span>
                            ))}
                          </div>

                          {g.ltf.flatMap((row) => row.signals.map((sig, idx) => {
                            const isLong = String(sig.dir || sig.direction).toUpperCase() === 'LONG';
                            const entry = +sig.entry;
                            const nowP = Number.isFinite(+sig.priceAtScan) ? +sig.priceAtScan : scanPrice;
                            const dist = Number.isFinite(entry) && entry > 0 && nowP != null ? (Math.abs(nowP - entry) / entry) * 100 : null;
                            const ready = dist != null && dist <= 0.5;
                            const stKey = ready ? 'ready' : 'watching';
                            const fibInfo = sig.metadata?.obFib;
                            return (
                              <div
                                key={`${g.refTf}-${row.tf}-${sig.obTime}-${idx}`}
                                className={`sg-card stage-${stKey}`}
                                onClick={() => openCoinScanChart(sig)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter') openCoinScanChart(sig); }}
                              >
                                <div className="sg-card-top">
                                  <CoinIcon symbol={sig.symbol || coinScanResult.symbol} size={46} />
                                  <div className="sg-id">
                                    <div className="sg-sym">
                                      {baseAsset(sig.symbol || coinScanResult.symbol)}
                                      <small>/USDT</small>
                                    </div>
                                    <div className="sg-tags">
                                      <span className={`sg-dir ${isLong ? 'long' : 'short'}`}>{isLong ? '▲ Long' : '▼ Short'}</span>
                                      {sig.score != null && <span className="sg-tag">Score {Number(sig.score).toFixed(0)}</span>}
                                      <span className="sg-tag">{g.refLabel} Fib {fibInfo?.hitRatio ?? ''}</span>
                                      <span className="sg-tag">{row.tf.toUpperCase()} OB</span>
                                    </div>
                                  </div>
                                  <div className="sg-stage">
                                    <span className={`sg-stage-pill s-${stKey}`}>{ready ? 'Ready' : 'Watching'}</span>
                                    {dist != null && <div className="sg-dist">{dist.toFixed(2)}% to entry</div>}
                                  </div>
                                </div>

                                <div className="sg-note">
                                  OB · {g.refLabel} Fib {fibInfo?.hitRatio ?? ''}{fibInfo?.hitPrice != null ? ` @ ${val(fibInfo.hitPrice)}` : ''} · {row.tf}
                                  <br />
                                  OB candle: {fmtT(sig.obTimeIso)} · Scanned: {fmtT(sig.scannedAt)}
                                </div>

                                <div className="sg-levels">
                                  <div className="sg-lv"><span>Entry</span><b>{val(sig.entry)}</b></div>
                                  <div className="sg-lv lv-sl"><span>SL</span><b>{val(sig.sl)}</b></div>
                                  <div className="sg-lv"><span>{nowP != null ? 'Now' : 'R:R'}</span><b>{nowP != null ? val(nowP) : sig.rr != null ? Number(sig.rr).toFixed(2) : '—'}</b></div>
                                  <div className="sg-lv lv-tp"><span>TP1</span><b>{val(sig.tp1)}</b></div>
                                  <div className="sg-lv lv-tp"><span>TP2</span><b>{val(sig.tp2)}</b></div>
                                  <div className="sg-lv lv-tp"><span>TP3</span><b>{val(sig.tp3)}</b></div>
                                </div>

                                <div className="cs-tap">📈 Chart බලන්න — card එක tap කරන්න{sig.rr != null ? ` · R:R ${Number(sig.rr).toFixed(2)}` : ''}</div>
                              </div>
                            );
                          }))}
                        </div>
                      );
                    })}
                    {Array.isArray(coinScanResult.errors) && coinScanResult.errors.length > 0 && (
                      <div className="cs-errors">{coinScanResult.errors.slice(0, 4).join(' · ')}</div>
                    )}
                  </div>
                );
              })()}
            </div>

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
                  <div className="sg-win-cap">{winCount} TP · {slPure} SL</div>
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

            {/* ── Strategy filter (OB + Fib follows the Coin Scan selection above) ── */}
            <div className="filter-row sg-filters" style={{ marginBottom: 6 }}>
              {[['ALL', 'All strategies'], ['OB_FIB', 'OB + Fib (selected)']].map(([v, l]) => (
                <button key={v} className={`filter-pill ${sigStrategy === v ? 'active' : ''}`} onClick={() => setSigStrategy(v)}>
                  {l}
                </button>
              ))}
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
              <>
              {displayList.map(({ x: sg, st, d }) => {
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
              })}
              {hasMoreSignals && (
                <div className="sg-more-hint" style={{ textAlign: 'center', padding: '12px 8px', color: 'var(--text-secondary)', fontSize: 13 }}>
                  <div style={{ marginBottom: 8 }}>Showing {displayList.length} of {list.length} signals. Coins stay available even when their live rank changes.</div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSignalDisplayLimit((n) => Math.min(n + DISPLAY_BATCH, list.length))}
                  >
                    Load next {Math.min(DISPLAY_BATCH, list.length - displayList.length)}
                  </button>
                  {list.length - displayList.length > DISPLAY_BATCH && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ marginLeft: 8 }}
                      onClick={() => setSignalDisplayLimit(list.length)}
                    >
                      Load all
                    </button>
                  )}
                </div>
              )}
              </>
            )}
          </>
        )}
      </>
    );
  }


  function ScannerTab() {
    return (
      <>
        <div style={{ padding: '0 10px 12px' }}>
          <MarketScanCard
            lastAt={lastFullScanAt}
            nextAt={nextFullScanAt}
            intervalMin={fullScanInterval}
            running={!!scanMeta?.full_scan_running}
            enabled={autoScanEnabled}
            counts={counts}
          />
        </div>

        {user.role === 'admin' && (
          <div className="card" style={{ margin: '0 10px 12px' }}>
            <div className="card-title" style={{ marginBottom: 8 }}>Scan controls</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={scanning} onClick={scanNow}>
                {scanning ? 'Scanning…' : 'Scan now'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={autoScanBusy || scanning}
                onClick={toggleAutoScan}
              >
                {autoScanBusy ? '…' : autoScanEnabled ? 'Stop auto-scan' : 'Start auto-scan'}
              </button>
            </div>
            {scanMsg && (
              <div className="card-subtitle" style={{ marginTop: 10 }}>
                {scanMsg.ok ? '✅' : '⚠️'} {scanMsg.text}
              </div>
            )}
          </div>
        )}

        <div className="xm-section-head">
          <h2>Ready coins</h2>
          <button type="button" className="see-all" onClick={() => { setFilter('READY'); setTab('signals'); }}>See all</button>
        </div>
        <div className="coins-card" style={{ margin: '0 10px 16px' }}>
          {(() => {
            const ready = signals
              .filter((s) => String(s.status || '').toUpperCase() === 'READY')
              .slice(0, 8);
            if (!ready.length) {
              return <div className="coins-empty">No ready coins right now. Scanner is watching the market.</div>;
            }
            return ready.map((sg) => {
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
                  </div>
                </button>
              );
            });
          })()}
        </div>

        {user.role === 'admin' && (
          <div style={{ margin: '0 10px 24px' }}>
            <div className="xm-section-head" style={{ paddingLeft: 0, paddingRight: 0 }}>
              <h2>Scan log</h2>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <ScanLogPanel />
            </div>
          </div>
        )}
      </>
    );
  }

  function PortfolioTab() {
    const serverOngoing = signals.filter((s) => String(s.status || '').toUpperCase() === 'ONGOING');
    const [sub, setSub] = useState('open');
    const [demoOn, setDemoOn] = useState(false);
    const [demoPos, setDemoPos] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [chartOpen, setChartOpen] = useState(false);

    const autoPositions = demoOn ? demoPos : []; // real auto-trades later from API
    const allOpen = [...autoPositions, ...serverOngoing.filter((s) => !autoPositions.some((d) => d.symbol === s.symbol))];

    function pnlOf(sg) {
      const entry = Number(sg.entry ?? sg.entry_price);
      const cur = Number(sg.current_price ?? sg.last_price ?? sg.price);
      const isLong = String(sg.direction || sg.side || '').toUpperCase() !== 'SHORT';
      if (!(entry > 0 && cur > 0)) return null;
      return isLong ? ((cur - entry) / entry) * 100 : ((entry - cur) / entry) * 100;
    }

    const selected = allOpen.find((s) => (s.signal_id || s.id) === selectedId) || allOpen[0] || null;

    function runDemo() {
      const list = buildDemoPositions();
      setDemoPos(list);
      setDemoOn(true);
      setSelectedId(list[0]?.signal_id || null);
      setChartOpen(true);
      showToast('Test run: 4 demo positions loaded');
    }

    function clearDemo() {
      setDemoOn(false);
      setDemoPos([]);
      setSelectedId(null);
      setChartOpen(false);
    }

    return (
      <>
        <div className="pf-tabs">
          <button type="button" className={sub === 'open' ? 'on' : ''} onClick={() => setSub('open')}>Open Positions</button>
          <button type="button" className={sub === 'server' ? 'on' : ''} onClick={() => setSub('server')}>Server signals</button>
          <button type="button" className={sub === 'pending' ? 'on' : ''} onClick={() => setSub('pending')}>Pending</button>
          <button type="button" className={sub === 'history' ? 'on' : ''} onClick={() => setSub('history')}>History</button>
        </div>

        {user.role === 'admin' && sub === 'open' && (
          <div className="pf-admin-bar">
            {!demoOn ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={runDemo}>
                Test run (4 coins)
              </button>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={clearDemo}>
                Clear test positions
              </button>
            )}
            <span className="pf-admin-hint">Admin only · demo open positions</span>
          </div>
        )}

        {sub === 'open' && (
          allOpen.length === 0 ? (
            <div className="pf-empty">
              <div className="pf-empty-ring"><span>+</span></div>
              <div className="pf-empty-title">Nothing here yet!</div>
              <button
                type="button"
                className="pf-empty-btn"
                onClick={() => setTab(hasExchangeConn ? 'signals' : 'keys')}
              >
                {hasExchangeConn ? 'View Signals & Start' : 'Connect Binance and start'}
              </button>
              {user.role === 'admin' && (
                <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={runDemo}>
                  Admin test run
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Compact coin strip with PnL */}
              <div className="pf-coin-strip">
                {allOpen.map((sg) => {
                  const id = sg.signal_id || sg.id;
                  const pnl = pnlOf(sg);
                  const up = pnl == null ? true : pnl >= 0;
                  const active = selected && (selected.signal_id || selected.id) === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`pf-coin-chip${active ? ' on' : ''}`}
                      onClick={() => { setSelectedId(id); setChartOpen(true); }}
                    >
                      <CoinIcon symbol={sg.symbol} size={22} />
                      <div className="pf-coin-chip-txt">
                        <span className="n">{baseAsset(sg.symbol)}</span>
                        <span className={`p ${up ? 'up' : 'down'}`}>
                          {pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Large chart for selected */}
              {selected && chartOpen && (
                <div className="pf-chart-panel">
                  <div className="pf-chart-head">
                    <div className="pf-chart-title">
                      <CoinIcon symbol={selected.symbol} size={28} />
                      <div>
                        <div className="t">{baseAsset(selected.symbol)} <span className={String(selected.direction || selected.side || '').toUpperCase() === 'SHORT' ? 'short' : 'long'}>{String(selected.direction || selected.side || 'LONG').toUpperCase()}</span></div>
                        <div className="s">
                          Entry {fmt(selected.entry ?? selected.entry_price)} · Now {fmt(selected.current_price ?? selected.price)}
                          {selected._demo && <span className="demo-tag"> DEMO</span>}
                        </div>
                      </div>
                    </div>
                    <button type="button" className="pf-chart-close" onClick={() => setChartOpen(false)} aria-label="Close chart">✕</button>
                  </div>
                  <CandleChart sg={selected} height={260} />
                  <div className="pf-levels big">
                    <span className="sl">SL {fmt(selected.sl)}</span>
                    <span className="en">Entry {fmt(selected.entry ?? selected.entry_price)}</span>
                    <span className="tp">TP1 {fmt(selected.tp1)}</span>
                    <span className="tp">TP2 {fmt(selected.tp2)}</span>
                    <span className="tp">TP3 {fmt(selected.tp3)}</span>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => setSheet(selected)}>
                    Open full analysis
                  </button>
                </div>
              )}

              {!chartOpen && selected && (
                <button type="button" className="pf-open-chart-hint" onClick={() => setChartOpen(true)}>
                  Tap a coin above to open chart
                </button>
              )}
            </>
          )
        )}

        {sub === 'server' && (
          serverOngoing.length === 0 ? (
            <div className="pf-empty">
              <div className="pf-empty-title" style={{ marginTop: 40 }}>No server ongoing signals</div>
            </div>
          ) : (
            <div className="pf-list">
              {serverOngoing.map((sg) => {
                const pnl = pnlOf(sg);
                const up = pnl == null ? true : pnl >= 0;
                const isLong = String(sg.direction || sg.side || '').toUpperCase() !== 'SHORT';
                return (
                  <button
                    key={sg.signal_id || sg.id || sg.symbol}
                    type="button"
                    className="pf-card"
                    onClick={() => setSheet(sg)}
                  >
                    <div className="pf-card-head">
                      <CoinIcon symbol={sg.symbol} size={32} />
                      <div className="pf-card-meta">
                        <div className="pf-sym">{baseAsset(sg.symbol)} <span className={isLong ? 'long' : 'short'}>{isLong ? 'LONG' : 'SHORT'}</span></div>
                        <div className="pf-sub">Entry {fmt(sg.entry ?? sg.entry_price)} · Now {fmt(sg.current_price ?? sg.price)}</div>
                      </div>
                      <div className={`pf-pnl ${up ? 'up' : 'down'}`}>
                        {pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`}
                      </div>
                    </div>
                    <LevelSparkline sg={sg} height={72} />
                    <div className="pf-levels">
                      <span className="sl">SL {fmt(sg.sl)}</span>
                      <span className="en">E {fmt(sg.entry ?? sg.entry_price)}</span>
                      <span className="tp">TP1 {fmt(sg.tp1)}</span>
                      <span className="tp">TP2 {fmt(sg.tp2)}</span>
                      <span className="tp">TP3 {fmt(sg.tp3)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )
        )}

        {sub === 'pending' && (
          <div className="pf-empty">
            <div className="pf-empty-title" style={{ marginTop: 40 }}>No pending orders</div>
          </div>
        )}

        {sub === 'history' && (
          <div className="pf-empty">
            <div className="pf-empty-title" style={{ marginTop: 40 }}>No history yet</div>
          </div>
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
    const [planData, setPlanData] = useState(null);
    const [busy, setBusy] = useState(false);
    const [deposit, setDeposit] = useState(null);
    const [step, setStep] = useState('methods'); // methods | pay

    const loadPlan = useCallback(async () => {
      try {
        const res = await fetch('/api/user/plan', { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) setPlanData(data);
      } catch (_) {}
    }, []);

    useEffect(() => {
      loadPlan();
      const t = setInterval(loadPlan, 20000);
      return () => clearInterval(t);
    }, [loadPlan]);

    const settings = planData?.settings;
    const methods = planData?.methods || {};
    const cd = planData?.countdown;
    const days = settings?.plan_duration_days ?? 30;
    const planName = settings?.plan_name || 'Pro';
    const priceBase = Number(methods.usdt?.price ?? settings?.plan_price_usdt ?? 49);
    const activePending = (planData?.deposits || []).find((d) => d.status === 'pending' || d.status === 'submitted');

    const priceOf = (m) => {
      const row = methods[m];
      if (!row) return priceBase;
      const fee = Number(row.fee_pct) || 0;
      return Math.round(Number(row.price) * (1 + fee / 100) * 100) / 100;
    };

    async function startDeposit(m) {
      if (m === 'bank') {
        showToast('Bank transfer is suspended');
        return;
      }
      setBusy(true);
      try {
        const res = await fetch('/api/user/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create_deposit', method: m }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        setDeposit(data);
        setStep('pay');
        showToast(m === 'usdt' ? 'Send exact USDT — activates automatically' : 'Payment order created');
        loadPlan();
      } catch (e) {
        showToast(e.message || 'Error');
      } finally {
        setBusy(false);
      }
    }

    function copyText(text) {
      if (!text) return;
      navigator.clipboard?.writeText(text).then(() => showToast('Copied')).catch(() => showToast(String(text)));
    }

    // method cards: enabled first, then disabled (locked)
    const methodCards = [
      {
        id: 'usdt',
        label: 'USDT',
        sub: methods.usdt?.network || 'TRC20',
        enabled: methods.usdt?.enabled !== false,
        logo: '₮',
        color: '#26a17b',
      },
      {
        id: 'paypal',
        label: 'PayPal',
        sub: 'USD',
        enabled: methods.paypal?.enabled !== false,
        logo: 'P',
        color: '#003087',
      },
      {
        id: 'bank',
        label: 'Bank transfer',
        sub: 'Suspended',
        enabled: false,
        logo: '🏦',
        color: '#64748b',
      },
    ];
    const enabledMethods = methodCards.filter((x) => x.enabled);
    const disabledMethods = methodCards.filter((x) => !x.enabled);

    if (step === 'pay' && (deposit || activePending)) {
      const d = deposit?.deposit || activePending;
      const info = deposit || {};
      const amt = info.amount || d?.unique_amount || d?.expected_amount;
      const m = info.method || d?.method || 'usdt';
      return (
        <div className="dm-page">
          <div className="dm-topbar">
            <button type="button" className="dm-icon-btn" aria-label="Back" onClick={() => { setStep('methods'); setDeposit(null); }}>←</button>
            <div className="dm-topbar-title">Deposit</div>
            <button type="button" className="dm-icon-btn" aria-label="Close" onClick={() => setTab('home')}>✕</button>
          </div>

          <div className="dm-account-card">
            <div className="dm-account-row">
              <span className="dm-account-name">{planName}</span>
              <span className="dm-badge-real">Real</span>
            </div>
            <div className="dm-account-bal">{amt} {m === 'paypal' ? 'USD' : 'USDT'}</div>
            <div className="dm-account-id">#{String(d?.id || '').replace(/-/g, '').slice(0, 10)}</div>
          </div>

          <div className="dm-pay-box">
            <div className="dm-pay-label">Send exactly</div>
            <div className="dm-pay-amt">{amt} {m === 'paypal' ? 'USD' : 'USDT'}</div>
            {m === 'usdt' && (
              <>
                <div className="dm-pay-meta">Network · {info.network || d?.network || 'TRC20'}</div>
                <div className="dm-pay-addr">{info.address || d?.address || '—'}</div>
                <div className="dm-pay-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => copyText(info.address || d?.address)}>Copy address</button>
                  <button type="button" className="btn btn-secondary" onClick={() => copyText(String(amt))}>Copy amount</button>
                </div>
                {(info.address || d?.address) && (
                  <div className="dm-qr-wrap">
                    <img
                      alt="QR"
                      width={180}
                      height={180}
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(info.address || d?.address)}`}
                    />
                    <div className="form-hint">Scan deposit address</div>
                  </div>
                )}
                <p className="dm-hint">Plan activates automatically after on-chain confirmation. No “I paid” button.</p>
              </>
            )}
            {m === 'paypal' && (
              <>
                {info.paypal_me_link && (
                  <a className="btn btn-primary btn-block" style={{ marginTop: 12 }} href={info.paypal_me_link} target="_blank" rel="noreferrer">Open PayPal</a>
                )}
                {info.paypal_email && (
                  <div style={{ marginTop: 10 }}>
                    <div className="form-hint">PayPal email</div>
                    <div>{info.paypal_email}</div>
                    <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => copyText(info.paypal_email)}>Copy email</button>
                  </div>
                )}
                {(info.paypal_me_link || info.paypal_email) && (
                  <div className="dm-qr-wrap">
                    <img
                      alt="PayPal QR"
                      width={180}
                      height={180}
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(info.paypal_me_link || info.paypal_email)}`}
                    />
                  </div>
                )}
                <p className="dm-hint">Include your account email in the PayPal note.</p>
              </>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="dm-page">
        <div className="dm-topbar">
          <button type="button" className="dm-icon-btn" aria-label="Back" onClick={() => setTab('home')}>←</button>
          <div className="dm-topbar-title">Deposit Methods</div>
          <button type="button" className="dm-icon-btn" aria-label="Close" onClick={() => setTab('home')}>✕</button>
        </div>

        {/* Account strip — like screenshot */}
        <div className="dm-account-card">
          <div className="dm-account-row">
            <span className="dm-account-name">{planName}</span>
            <span className={`dm-badge-real ${user.subscription_status === 'active' ? '' : 'muted'}`}>
              {user.subscription_status === 'active' ? 'Active' : (user.subscription_status || 'Trial')}
            </span>
          </div>
          <div className="dm-account-bal">
            {cd && !cd.expired
              ? `${cd.days}d ${cd.hours}h left`
              : cd?.expired
                ? 'Expired'
                : isTrial
                  ? `${daysLeft}d trial`
                  : `${priceBase.toFixed(2)} USD`}
          </div>
          <div className="dm-account-id">
            {user.email || user.id || '—'}
            {cd?.expires_at ? ` · exp ${new Date(cd.expires_at).toLocaleDateString()}` : ''}
          </div>
          {cd && !cd.expired && (
            <div className="dm-progress">
              <div
                className="dm-progress-fill"
                style={{ width: `${Math.min(100, Math.max(4, ((cd.total_hours || 0) / (days * 24)) * 100))}%` }}
              />
            </div>
          )}
        </div>

        {/* Enabled methods */}
        {enabledMethods.length > 0 && (
          <>
            <div className="dm-section-label">Payment methods</div>
            <div className="dm-grid">
              {enabledMethods.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className="dm-card"
                  disabled={busy}
                  onClick={() => startDeposit(x.id)}
                >
                  <div className="dm-card-logo" style={{ color: x.color, borderColor: x.color + '44' }}>{x.logo}</div>
                  <div className="dm-card-label">{x.label}</div>
                  <div className="dm-card-sub">${priceOf(x.id).toFixed(2)} · {x.sub}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Disabled / locked — screenshot style */}
        {disabledMethods.length > 0 && (
          <>
            <div className="dm-section-label" style={{ marginTop: 22 }}>Disabled methods</div>
            <p className="dm-disabled-note">
              These payment methods cannot be used right now (suspended or admin-off).
            </p>
            <div className="dm-grid">
              {disabledMethods.map((x) => (
                <div key={x.id} className="dm-card dm-card-locked">
                  <span className="dm-lock" aria-hidden>🔒</span>
                  <div className="dm-card-logo muted">{x.logo}</div>
                  <div className="dm-card-label">{x.label}</div>
                  <div className="dm-card-sub">{x.sub}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="dm-footer-hint">
          Unverified accounts can pay with enabled methods. USDT activates automatically after network confirmation.
        </p>
      </div>
    );
  }


  function ReferralTab() {
    const [refData, setRefData] = useState(null);
    const [wallet, setWallet] = useState(null);
    const [busy, setBusy] = useState(false);
    const [wd, setWd] = useState({ amount_usdt: '', coin: 'USDT', address: '' });

    const load = useCallback(async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch('/api/user/referral', { cache: 'no-store' }),
          fetch('/api/user/wallet', { cache: 'no-store' }),
        ]);
        const d1 = await r1.json();
        const d2 = await r2.json();
        if (r1.ok) setRefData(d1);
        if (r2.ok) setWallet(d2);
      } catch (_) {}
    }, []);

    useEffect(() => { load(); }, [load]);

    function copyText(text) {
      if (!text) return;
      navigator.clipboard?.writeText(text).then(() => showToast('Copied')).catch(() => {});
    }

    async function doWithdraw() {
      setBusy(true);
      try {
        const res = await fetch('/api/user/wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount_usdt: Number(wd.amount_usdt),
            coin: wd.coin,
            address: wd.address,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        showToast(data.message || 'Withdraw submitted');
        setWd({ amount_usdt: '', coin: wd.coin, address: '' });
        load();
      } catch (e) {
        showToast(e.message || 'Error');
      } finally {
        setBusy(false);
      }
    }

    const rates = refData?.rates || [];
    const coins = wallet?.withdraw_coins || ['USDT'];
    const price = wallet?.prices?.[wd.coin] || 1;
    const amt = Number(wd.amount_usdt) || 0;
    const coinAmt = wd.coin === 'USDT' ? amt : (price > 0 ? amt / price : 0);

    return (
      <>
        <div className="card">
          <div className="card-title">Referral link</div>
          <div
            className="card"
            style={{ padding: 10, marginTop: 8, wordBreak: 'break-all', fontSize: 13, cursor: 'pointer' }}
            onClick={() => copyText(refData?.referral_link || '')}
          >
            {refData?.referral_link || 'Loading…'}
          </div>
          <div className="form-hint" style={{ marginTop: 6 }}>
            Code: <b>{refData?.referral_code || '—'}</b> · Directs: {refData?.direct_count ?? 0}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Commission levels</div>
          <div className="card-subtitle" style={{ marginBottom: 8 }}>
            When someone you referred buys a plan, you earn:
          </div>
          {(rates.length ? rates : [10, 5, 3, 2]).map((r, i) => (
            <div key={i} className="flex-between" style={{ fontSize: 14, padding: '4px 0' }}>
              <span>Level {i + 1}</span>
              <span className="fw-700">{r}%</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="flex-between">
            <div className="card-title">Wallet balance</div>
            <div className="fw-700" style={{ fontSize: 20 }}>
              ${Number(refData?.wallet_balance ?? wallet?.balance ?? 0).toFixed(2)}
            </div>
          </div>
          <div className="form-hint">
            Total earned: ${Number(refData?.total_earned || 0).toFixed(2)}
            {wallet && ` · Min withdraw ${wallet.withdraw_min_usdt} USDT · Fee ${wallet.withdraw_fee_usdt} USDT`}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Withdraw</div>
          <label className="form-hint">Amount (USDT)</label>
          <input
            className="input"
            type="number"
            value={wd.amount_usdt}
            onChange={(e) => setWd({ ...wd, amount_usdt: e.target.value })}
            placeholder="e.g. 20"
            style={{ marginBottom: 8 }}
          />
          <label className="form-hint">Coin</label>
          <select
            className="input"
            value={wd.coin}
            onChange={(e) => setWd({ ...wd, coin: e.target.value })}
            style={{ marginBottom: 8 }}
          >
            {coins.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {wd.coin !== 'USDT' && amt > 0 && (
            <div className="form-hint" style={{ marginBottom: 8 }}>
              ≈ {coinAmt.toFixed(8)} {wd.coin} @ ${Number(price).toFixed(2)}
            </div>
          )}
          <label className="form-hint">Wallet address</label>
          <input
            className="input"
            value={wd.address}
            onChange={(e) => setWd({ ...wd, address: e.target.value })}
            placeholder="Your USDT / coin address"
            style={{ marginBottom: 10 }}
          />
          <button className="btn btn-primary btn-block" disabled={busy} onClick={doWithdraw}>
            {busy ? 'Submitting…' : 'Request withdraw'}
          </button>
        </div>

        {wallet?.withdrawals?.length > 0 && (
          <div className="card">
            <div className="card-title">Withdraw history</div>
            {wallet.withdrawals.map((w) => (
              <div key={w.id} className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border, #eee)', fontSize: 13 }}>
                <div>
                  <div>{w.amount_usdt} USDT → {w.coin_amount} {w.coin}</div>
                  <div className="text-muted">{new Date(w.created_at).toLocaleString()}</div>
                </div>
                <span className="chip">{w.status}</span>
              </div>
            ))}
          </div>
        )}

        {refData?.directs?.length > 0 && (
          <div className="card">
            <div className="card-title">Your referrals</div>
            {refData.directs.map((d) => (
              <div key={d.id} className="flex-between" style={{ padding: '6px 0', fontSize: 13 }}>
                <span>{d.email}</span>
                <span className="chip">{d.plan}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  function SettingsTab() {
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

  // ─── My Profile (opened from "More" / the profile icon) ──────────────
  function MyProfileTab() {
    const lv = levelInfo || { level: 'Bronze', color: '#C98A5E', nextColor: '#A8B0BC', volume: 0, target: 1000000, progress: 0 };
    const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
    const medal = (color) => (
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
        <path d="M10 18l-3 11 9-4 9 4-3-11" fill={color} opacity="0.55" />
        <circle cx="16" cy="13" r="10" fill={color} />
        <circle cx="16" cy="13" r="7.2" fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="1.2" />
        <path d="M16 8.2l1.5 3.1 3.4.5-2.5 2.4.6 3.4-3-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5z" fill="rgba(255,255,255,.92)" />
      </svg>
    );
    const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
    const openSupport = () => { setSupportOpen(true); setSupportMode('choose'); };
    return (
      <div className="mp">
        <div className="mp-head">
          <h1 className="mp-title">My Profile</h1>
          <div className="mp-head-actions">
            <button type="button" className="mp-icon-btn" aria-label="Support" onClick={openSupport}>
              <svg viewBox="0 0 24 24" width="26" height="26" {...stroke}><path d="M4 14v-2a8 8 0 0116 0v2" /><rect x="3" y="14" width="4" height="6" rx="2" /><rect x="17" y="14" width="4" height="6" rx="2" /><path d="M19 20c0 1.5-1.5 2-4 2h-2" /></svg>
            </button>
            <button type="button" className="mp-icon-btn" aria-label="Close" onClick={() => setTab('home')}>
              <svg viewBox="0 0 24 24" width="28" height="28" {...stroke} strokeWidth="2.2"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
        </div>

        <div className="mp-user">
          <div className="mp-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30" {...stroke} strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1.5A5.5 5.5 0 019.5 14h5a5.5 5.5 0 015.5 5.5V21z" /></svg>
          </div>
          <div className="mp-email">{user.email}</div>
        </div>

        <div className="mp-level">
          <div className="mp-level-top">
            <div>
              <div className="mp-muted">Level</div>
              <div className="mp-level-name">{lv.level}</div>
            </div>
            <div className="mp-right">
              <div className="mp-muted">Trading Volume</div>
              <div className="mp-level-name">{money(lv.volume)}<span className="mp-muted mp-target"> /{money(lv.target)}</span></div>
            </div>
          </div>
          <div className="mp-level-bar">
            {medal(lv.color)}
            <div className="mp-track"><div className="mp-fill" style={{ width: `${Math.max(0, Math.min(100, Math.round((lv.progress || 0) * 100)))}%` }} /></div>
            {medal(lv.nextColor || lv.color)}
          </div>
        </div>

        <button type="button" className="mp-verify" onClick={() => setTab('verify')}>
          <svg viewBox="0 0 24 24" width="26" height="26" {...stroke}><rect x="4" y="3" width="16" height="18" rx="3" /><circle cx="12" cy="10" r="2.6" /><path d="M7.5 17c.8-2 2.4-3 4.5-3s3.7 1 4.5 3" /></svg>
          <span className="mp-verify-row">
            <span className="mp-verify-label">Verification</span>
            <span className={`mp-badge ${verify.verified ? 'is-ok' : ''}`}>{verify.verified ? 'Verified' : 'Unverified'}</span>
          </span>
        </button>

        <div className="mp-list">
          <button type="button" className="mp-item" onClick={() => setTab('settings')}>
            <svg viewBox="0 0 24 24" width="24" height="24" {...stroke}><circle cx="7" cy="8" r="2.2" /><path d="M9.2 8H21" /><circle cx="17" cy="16" r="2.2" /><path d="M14.8 16H3" /></svg>
            <span className="mp-item-label">Settings</span>
            <span className="mp-chev">{Icons.chevron}</span>
          </button>
          <button type="button" className="mp-item" onClick={openSupport}>
            <svg viewBox="0 0 24 24" width="24" height="24" {...stroke}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.6" /><path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9" /></svg>
            <span className="mp-item-label">Support</span>
            <span className="mp-chev">{Icons.chevron}</span>
          </button>
          {user.role === 'admin' && (
            <a href="/admin" className="mp-item">
              <span style={{ display: 'inline-flex', width: 24, height: 24 }}>{Icons.shield}</span>
              <span className="mp-item-label">Admin Panel</span>
              <span className="mp-chev">{Icons.chevron}</span>
            </a>
          )}
        </div>

        <button type="button" className="mp-signout" onClick={logout}>
          <svg viewBox="0 0 24 24" width="26" height="26" {...stroke}><path d="M9 4H6a2 2 0 00-2 2v12a2 2 0 002 2h3" /><path d="M16 8l4 4-4 4M20 12H9" /></svg>
          <span>Sign Out</span>
        </button>

        <button
          type="button"
          className="mp-suggest"
          onClick={() => { setSupportOpen(true); setSupportMode('live'); loadSupportThread(); }}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" {...stroke}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0012 3z" /></svg>
          <span className="mp-suggest-text">Suggest new features or share your opinion</span>
          <span className="mp-chev">{Icons.chevron}</span>
        </button>
      </div>
    );
  }

  const tabs = {
    home: <HomeTab />,
    portfolio: <PortfolioTab />,
    scanner: <ScannerTab />,
    signals: <SignalsTab />,
    trade: <TradeTab />,
    plans: <PlansTab />,
    referral: <ReferralTab />,
    profile: <MyProfileTab />,
    settings: <SettingsTab />,
    keys: <KeysTab />,
    verify: <VerifyTab />,
  };

  return (
    <div className="app-shell">
      {tab !== 'profile' && (
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          {(tab === 'verify' || tab === 'settings') && (
            <button type="button" className="topbar-back" aria-label="Back" onClick={() => setTab(tab === 'settings' ? 'profile' : 'home')}>
              <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>{Icons.chevron}</span>
            </button>
          )}
          <div className={`topbar-title ${tab === 'verify' || tab === 'settings' ? 'is-center' : ''}`}>
            {tab === 'verify' && 'Verify your profile'}
            {tab === 'settings' && 'Settings'}
            {tab === 'home' && 'Home'}
            {tab === 'portfolio' && 'Portfolio'}
            {tab === 'scanner' && 'Scanner'}
            {tab === 'signals' && 'Signals'}
            {tab === 'trade' && 'Auto-Trade'}
            {tab === 'plans' && 'Plan'}
            {tab === 'referral' && 'Referral'}
            {tab === 'profile' && 'More'}
            {tab === 'keys' && 'Exchanges'}
          </div>
          <div className="topbar-actions">
            {tab === 'home' || tab === 'portfolio' ? (
              <>
                <button type="button" className="topbar-icon-btn" aria-label="Notifications" onClick={() => showToast('No new notifications')}>
                  {Icons.bell}
                  <span className="topbar-dot" />
                </button>
                <button type="button" className="topbar-icon-btn" aria-label="Wallet" onClick={() => setTab('plans')}>
                  {Icons.wallet}
                </button>
                <button type="button" className="topbar-icon-btn" aria-label="Profile" onClick={() => setTab('profile')}>
                  {Icons.profile}
                </button>
              </>
            ) : (
              <span className="text-secondary" style={{ fontSize: 11 }} title="App version">
                {getVersionLabel()}
              </span>
            )}
          </div>
        </div>
      </header>
      )}

      <main className="main-content">{tabs[tab] || tabs.home}</main>

      <nav className="bottom-nav">
        {[
          { id: 'home', label: 'Home', icon: Icons.home },
          { id: 'portfolio', label: 'Portfolio', icon: Icons.plans },
          { id: 'scanner', label: 'Scanner', icon: Icons.scan },
          { id: 'referral', label: 'Referral', icon: Icons.refer },
          { id: 'profile', label: 'More', icon: Icons.profile },
        ].map((t) => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id || (t.id === 'profile' && tab === 'settings') ? 'active' : ''}`}
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
            {(() => {
              const strat = String(sheet.metadata?.strategy || sheet.strategy || '').toLowerCase();
              if (strat !== 'harmonic') return null;
              const h = sheet.metadata?.harmonic || sheet.metadata?.harmonicGeometry || {};
              const family = h.family || (sheet.metadata?.pattern || '').replace(/_(BULL|BEAR)$/i, '') || 'Harmonic';
              const dir = String(sheet.direction || h.direction || '').toUpperCase();
              const ratios = h.ratios || {};
              const points = ['X', 'A', 'B', 'C', 'D'].map((lab) => {
                const p = h[lab];
                return p && p.price != null ? { lab, price: p.price } : null;
              }).filter(Boolean);
              const przLow = h.przLow ?? h.prz?.low;
              const przHigh = h.przHigh ?? h.prz?.high;
              const tf = sheet.metadata?.patternTf || sheet.metadata?.setupTf || '—';
              return (
                <div className="card" style={{ boxShadow: 'none', border: '1px solid #a78bfa55', marginTop: 12 }}>
                  <div style={{ fontWeight: 700, color: '#a78bfa', marginBottom: 8 }}>
                    Harmonic · {String(family).replace(/_/g, ' ')} {dir === 'LONG' ? 'Bullish' : dir === 'SHORT' ? 'Bearish' : ''}
                  </div>
                  <div className="text-secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                    Timeframe {tf} · XABCD structure with Potential Reversal Zone (PRZ)
                  </div>
                  {points.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 10, fontSize: 12 }}>
                      {points.map((p) => (
                        <div key={p.lab} style={{ textAlign: 'center' }}>
                          <div className="text-secondary">{p.lab}</div>
                          <strong>{fmt(p.price)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  {(przLow != null || przHigh != null) && (
                    <div className="flex-between" style={{ marginBottom: 6, fontSize: 13 }}>
                      <span className="text-secondary">PRZ (D zone)</span>
                      <strong>
                        {przLow != null ? fmt(przLow) : '—'} – {przHigh != null ? fmt(przHigh) : '—'}
                      </strong>
                    </div>
                  )}
                  {Object.keys(ratios).length > 0 && (
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      <div className="text-secondary" style={{ marginBottom: 4 }}>Key ratios</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {Object.entries(ratios).map(([k, v]) => (
                          <span key={k} className="chip chip-muted" style={{ fontSize: 11 }}>
                            {k.toUpperCase()} {typeof v === 'number' ? v.toFixed(3) : String(v)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {h.emaCross && (
                    <div style={{ fontSize: 12, marginTop: 10 }}>
                      <div className="text-secondary" style={{ marginBottom: 4 }}>
                        First EMA cross inside D zone (same TF, from left)
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <span
                          className="chip"
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            background: h.emaCross.ok ? '#0ecb8133' : '#f6465d33',
                            color: h.emaCross.ok ? '#0ecb81' : '#f6465d',
                          }}
                        >
                          {h.emaCross.type === 'bullish' ? 'Golden cross' : 'Death cross'}
                          {h.emaCross.tf ? ` · ${h.emaCross.tf}` : ''}
                          {h.emaCross.ok ? ' ✓' : ''}
                        </span>
                        {h.emaCross.price != null && (
                          <span className="chip chip-muted" style={{ fontSize: 11 }}>
                            @ {fmt(h.emaCross.price)}
                          </span>
                        )}
                        {h.emaCross.required && (
                          <span className="text-secondary" style={{ fontSize: 11 }}>
                            Confirm required
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="text-secondary" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.4 }}>
                    Professional note: Harmonic patterns use Fibonacci ratios between swing points X-A-B-C-D.
                    Entry is typically at the PRZ (point D). Confirm with price action / volume at the zone.
                    When EMA cross confirm is ON, the first left-side EMA20/50 cross <strong>inside the D zone</strong> on the same timeframe is required.
                    This is structural analysis only — not financial advice.
                  </div>
                </div>
              );
            })()}
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
            aria-label={chartTarget?.strategy === 'harmonic' ? 'Harmonic XABCD chart analysis' : 'ICT and SMC chart analysis'}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="ict-chart-header">
              <div>
                <div className="ict-chart-title">
                  {chartTarget?.strategy === 'harmonic'
                    ? 'Harmonic Pattern analysis'
                    : chartTarget?.strategy === 'chart_pattern'
                    ? 'Chart Pattern analysis'
                    : chartTarget?.strategy === 'zone_pattern'
                      ? 'Zone + Pattern analysis'
                      : chartTarget?.strategy === 'double_confluence'
                        ? 'Double Top/Bottom analysis'
                        : chartTarget?.strategy === 'ema_bump'
                          ? 'EMA Bump analysis'
                          : chartTarget?.strategy === 'ob_fib'
                            ? 'OB + HTF Fib analysis'
                            : 'ICT / SMC chart analysis'}
                </div>
                <div className="card-subtitle">{chartTarget.symbol} · {chartTimeframe}{chartTarget.refTf ? ` · Fib ${chartTarget.refTf}` : ''}</div>
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
              <button
                className={`filter-pill ${chartLabels === 'full' ? 'active' : ''}`}
                aria-pressed={chartLabels === 'full'}
                title="Show all zone / swing text labels"
                onClick={() => setChartLabels((v) => (v === 'full' ? 'clean' : 'full'))}
              >
                {chartLabels === 'full' ? 'Labels: all' : 'Labels: clean'}
              </button>
            </div>

            {chartMeta && (
              <div className="ict-chart-summary">
                <span className={`chip ${chartMeta.status === 'READY' ? 'chip-ready' : 'chip-muted'}`}>
                  {chartTarget?.strategy === 'harmonic'
                    ? 'Professional Harmonic XABCD analysis'
                    : chartMeta.status === 'READY'
                      ? 'ICT setup found'
                      : 'Market context'}
                </span>
                {chartMeta.price && <span className="text-secondary">Price {fmt(chartMeta.price)}</span>}
                {chartTarget?.strategy === 'harmonic' && (
                  <span className="text-secondary ict-chart-note">
                    X–A–B–C pivots + projected D / PRZ drawn on closed candles. Confirm structure at the zone before entry.
                  </span>
                )}
                {chartTarget?.strategy !== 'harmonic' && chartMeta.status !== 'READY' && (
                  <span className="text-secondary ict-chart-note">
                    No active setup in this direction and timeframe; the chart still shows current ICT/SMC context.
                  </span>
                )}
              </div>
            )}
            {chartLoading && (
              <div className="ict-chart-state">
                {chartTarget?.strategy === 'harmonic'
                  ? 'Loading candles and drawing professional harmonic XABCD pattern…'
                  : 'Loading live candles and ICT/SMC levels…'}
              </div>
            )}
            {chartError && <div className="ict-chart-error">{chartError}</div>}
            {chartSvgUrl && (
              <div className="ict-chart-image-wrap">
                <img
                  className="ict-chart-image"
                  src={chartSvgUrl}
                  alt={`${chartTarget.symbol} ${chartTimeframe} ${chartTarget?.strategy === 'harmonic' ? 'harmonic XABCD' : 'ICT/SMC'} candlestick analysis`}
                />
              </div>
            )}
            <p className="ict-chart-disclaimer">
              Analysis uses closed candles and is informational only, not financial advice.
              {chartTarget?.strategy === 'harmonic' && ' Harmonic ratios and PRZ are structural — always confirm with price action.'}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * Page entry. Keeps the POFIT splash mounted on top of the app so it can fade
 * out smoothly (and reveal the already-rendered dashboard) the moment the
 * existing auth/data loading state finishes — no artificial delay.
 */
export default function App() {
  const [gate, setGate] = useState({ loading: true, hasUser: false });
  const [giveUp, setGiveUp] = useState(false);

  // Failsafe: finished loading but no user and the /login redirect never happened
  // → never leave the splash up forever.
  useEffect(() => {
    if (gate.loading || gate.hasUser) {
      setGiveUp(false);
      return undefined;
    }
    const t = setTimeout(() => setGiveUp(true), 2500);
    return () => clearTimeout(t);
  }, [gate]);

  const splashActive = (gate.loading || !gate.hasUser) && !giveUp;

  return (
    <>
      <NexoraSplashScreen active={splashActive} />
      <AppInner onGate={setGate} />
    </>
  );
}
