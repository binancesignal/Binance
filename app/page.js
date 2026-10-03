'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
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

function statusChip(status) {
  const s = (status || '').toUpperCase();
  if (s === 'WATCHING') return <span className="chip chip-watching">👀 Watching</span>;
  if (s === 'READY') return <span className="chip chip-ready">🚀 Ready</span>;
  if (s === 'ONGOING') return <span className="chip chip-ongoing">🟢 Ongoing</span>;
  return <span className="chip chip-muted">{status || '—'}</span>;
}

function dirChip(dir) {
  const d = (dir || '').toUpperCase();
  if (d === 'LONG') return <span className="chip chip-long">Long</span>;
  if (d === 'SHORT') return <span className="chip chip-short">Short</span>;
  return null;
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
const Icons = {
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
  const [signals, setSignals] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [sheet, setSheet] = useState(null); // selected signal
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
  const pollRef = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

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

  function normalizeSignalsPayload(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.signals)) return data.signals;
    if (Array.isArray(data.active)) return data.active;
    const merged = [
      ...(Array.isArray(data.ongoing) ? data.ongoing : []),
      ...(Array.isArray(data.ready) ? data.ready : []),
      ...(Array.isArray(data.watching) ? data.watching : []),
    ];
    if (merged.length) return merged;
    if (Array.isArray(data)) return data;
    return [];
  }

  const loadSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/signals');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok === false) return;
      setSignals(normalizeSignalsPayload(data));
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!user) return;
    loadSignals();
    pollRef.current = setInterval(loadSignals, 45000);
    return () => clearInterval(pollRef.current);
  }, [user, loadSignals]);

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

  /** Multi-chunk full-market scan (same behaviour as original dashboard). */
  async function scanNow() {
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
      while (chunkIndex <= totalChunks) {
        setScanProgress({
          chunk: chunkIndex,
          total: totalChunks,
          symbols: sumSymbols,
          market: totalMarket,
          retrying: partialRetries > 0,
        });

        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            universe: 'all',
            chunkSize,
            resetCursor: first,
            lifecycle: 'skip',
          }),
        });
        first = false;
        const result = await res.json().catch(() => null);
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

        // refresh signals list for UI
        try {
          const sr = await fetch('/api/signals');
          if (sr.ok) {
            const sd = await sr.json();
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

      // Final lifecycle-only pass so WATCHING/READY/ONGOING update after all chunks
      try {
        await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lifecycle: 'only' }),
        });
      } catch (_) {}

      try {
        const sr = await fetch('/api/signals');
        if (sr.ok) {
          const sd = await sr.json();
          setSignals(normalizeSignalsPayload(sd));
        }
        const st = await fetch('/api/scan');
        if (st.ok) setScanMeta(await st.json());
      } catch (_) {}

      if (!failed) {
        setScanMsg({
          ok: true,
          text: `Done — ${sumSymbols} coins · +${sumCreated} new · TG ${sumTelegram} · All coins${totalMarket ? ` (${totalMarket} market)` : ''}`,
        });
      }
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

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
    return (s.status || '').toUpperCase() === filter;
  });

  const counts = {
    watching: signals.filter((s) => (s.status || '').toUpperCase() === 'WATCHING').length,
    ready: signals.filter((s) => (s.status || '').toUpperCase() === 'READY').length,
    ongoing: signals.filter((s) => (s.status || '').toUpperCase() === 'ONGOING').length,
  };

  // ─── Tab content ────────────────────────────────────────
  function HomeTab() {
    return (
      <>
        <div className="greeting">
          <h1>Hello{user.email ? `, ${user.email.split('@')[0]}` : ''}</h1>
          <p>
            Plan: <strong style={{ textTransform: 'capitalize' }}>{user.plan}</strong>
            {isTrial && daysLeft > 0 && ` · ${daysLeft} days left in free trial`}
          </p>
        </div>

        {isTrial && daysLeft > 0 && (
          <div className="card">
            <div className="progress-ring-wrap">
              <ProgressRing daysLeft={daysLeft} />
              <div>
                <div className="card-title">{daysLeft} days left in free trial</div>
                <div className="card-subtitle">Upgrade anytime to keep signals & auto-trade</div>
              </div>
            </div>
          </div>
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


        {user.role === 'admin' && (
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 10 }}>
              <div>
                <div className="card-title">Market scan</div>
                <div className="card-subtitle">
                  Full market (all coins) · chunk 15 · shared feed for every user
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
              <button className="btn btn-primary" disabled={scanning} onClick={scanNow}>
                {scanning ? 'Scanning…' : 'Scan now'}
              </button>
              <button className="btn btn-secondary" disabled={autoScanBusy || scanning} onClick={toggleAutoScan}>
                {autoScanBusy ? '…' : autoScanEnabled ? 'Stop auto-scan' : 'Start auto-scan'}
              </button>
            </div>
            <p className="form-hint" style={{ marginTop: 10 }}>
              Progress updates each chunk. New signals go to all users + Telegram board/DMs.
              {scanMeta?.exchange ? ` Exchange: ${scanMeta.exchange}.` : ''}
              {scanMeta?.lastScan?.completed_at ? ` Last: ${String(scanMeta.lastScan.completed_at).slice(0, 19)}.` : ''}
            </p>
          </div>
        )}

        <div className="icon-grid">
          <button className="icon-action" onClick={() => setTab('signals')}>
            <div className="icon-circle">{Icons.signals}</div>
            Signals
          </button>
          <button className="icon-action" onClick={() => setTab('trade')}>
            <div className="icon-circle">{Icons.auto}</div>
            Auto
          </button>
          <button className="icon-action" onClick={() => setTab('keys')}>
            <div className="icon-circle">{Icons.key}</div>
            Keys
          </button>
          <button className="icon-action" onClick={() => setTab('profile')}>
            <div className="icon-circle">{Icons.telegram}</div>
            Account
          </button>
        </div>

        <div className="stat-row">
          <div className="stat-box">
            <div className="stat-val">{counts.watching}</div>
            <div className="stat-label">👀 Watching</div>
          </div>
          <div className="stat-box">
            <div className="stat-val">{counts.ready}</div>
            <div className="stat-label">🚀 Ready</div>
          </div>
          <div className="stat-box">
            <div className="stat-val">{counts.ongoing}</div>
            <div className="stat-label">🟢 Ongoing</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Quick status</div>
          </div>
          <div className="flex-between" style={{ marginBottom: 8 }}>
            <span className="text-secondary" style={{ fontSize: 13 }}>Bybit keys</span>
            <span className={`chip ${keyStatus?.connected ? 'chip-ongoing' : 'chip-muted'}`}>
              {keyStatus?.connected ? 'Connected' : 'Missing'}
            </span>
          </div>
          <div className="flex-between" style={{ marginBottom: 8 }}>
            <span className="text-secondary" style={{ fontSize: 13 }}>Auto-trade</span>
            <span className={`chip ${settings?.autoTradingEnabled ? 'chip-ongoing' : 'chip-muted'}`}>
              {settings?.autoTradingEnabled ? 'Armed' : 'Paused'}
            </span>
          </div>
          <div className="flex-between">
            <span className="text-secondary" style={{ fontSize: 13 }}>Access</span>
            <span className={`chip ${hasAccess ? 'chip-ongoing' : 'chip-ready'}`}>
              {hasAccess ? 'Active' : 'Locked'}
            </span>
          </div>
        </div>
      </>
    );
  }

  function SignalsTab() {
    return (
      <>
        <div className="filter-row">
          {['ALL', 'WATCHING', 'READY', 'ONGOING'].map((f) => (
            <button
              key={f}
              className={`filter-pill ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        {!hasAccess ? (
          <div className="promo-banner">
            <h3>Signals locked</h3>
            <p>Your trial has ended. Upgrade to view the live board.</p>
            <button className="btn" onClick={() => setTab('plans')}>Upgrade</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📡</div>
            <h3>No signals yet</h3>
            <p>Scanner runs every few minutes. Pull to refresh soon.</p>
          </div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.signal_id || s.id || s.symbol + s.status}
              className="signal-card"
              onClick={() => setSheet(s)}
            >
              <div className="signal-card-top">
                <span className="signal-symbol">{s.symbol || s.pair || '—'}</span>
                {statusChip(s.status)}
              </div>
              <div className="signal-meta">
                {dirChip(s.direction || s.side)}
                {s.score != null && (
                  <span className="chip chip-muted">Score {Number(s.score).toFixed(0)}</span>
                )}
              </div>
              <div className="signal-prices">
                <span>Entry <strong>{fmt(s.entry || s.entry_price)}</strong></span>
                {s.sl != null && <span>SL <strong>{fmt(s.sl)}</strong></span>}
                {s.tp1 != null && <span>TP1 <strong>{fmt(s.tp1)}</strong></span>}
              </div>
            </div>
          ))
        )}
      </>
    );
  }

  function TradeTab() {
    const locked = !user.can_auto_trade;
    return (
      <>
        <div className="card">
          <div className="flex-between">
            <div>
              <div className="card-title">Auto-trade</div>
              <div className="card-subtitle">
                {locked
                  ? 'Requires Auto or Pro plan'
                  : settings?.autoTradingEnabled
                    ? 'Armed — will execute eligible signals'
                    : 'Paused'}
              </div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!settings?.autoTradingEnabled && !locked}
                onChange={toggleAutoTrade}
                disabled={locked}
              />
              <span className="slider" />
            </label>
          </div>
        </div>

        {locked && (
          <div className="promo-banner">
            <h3>Unlock auto-trade</h3>
            <p>Upgrade to Auto plan for Bybit auto-execution with your keys.</p>
            <button className="btn" onClick={() => setTab('plans')}>See plans</button>
          </div>
        )}

        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>Risk settings</div>
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <span className="text-secondary" style={{ fontSize: 13 }}>Margin %</span>
            <strong>{settings?.marginPercent ?? 2}%</strong>
          </div>
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <span className="text-secondary" style={{ fontSize: 13 }}>Leverage</span>
            <strong>{settings?.defaultLeverage ?? 10}x</strong>
          </div>
          <div className="flex-between">
            <span className="text-secondary" style={{ fontSize: 13 }}>Max positions</span>
            <strong>{settings?.maxOpenPositions ?? 3}</strong>
          </div>
          <p className="form-hint" style={{ marginTop: 12 }}>
            Settings are clamped by your plan limits. Always use Testnet first.
          </p>
        </div>

        <div className="card">
          <div className="card-title">Safety</div>
          <p className="card-subtitle" style={{ marginTop: 6 }}>
            Auto-trade uses your own Bybit API keys. Orders go to Testnet unless you explicitly
            configure mainnet (not recommended). Existing risk gates remain active.
          </p>
        </div>
      </>
    );
  }

  function KeysTab() {
    return (
      <>
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <div className="card-title">Bybit API keys</div>
            <span className={`chip ${keyStatus?.connected ? 'chip-ongoing' : 'chip-muted'}`}>
              {keyStatus?.connected ? 'Connected' : 'Missing'}
            </span>
          </div>
          {keyStatus?.key_hint && (
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Current: {keyStatus.key_hint}
            </p>
          )}
          <form onSubmit={saveKeys}>
            <div className="form-group">
              <label className="form-label">API Key</label>
              <input
                className="form-input"
                value={keysForm.apiKey}
                onChange={(e) => setKeysForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="Enter API key"
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label className="form-label">API Secret</label>
              <input
                className="form-input"
                type="password"
                value={keysForm.apiSecret}
                onChange={(e) => setKeysForm((f) => ({ ...f, apiSecret: e.target.value }))}
                placeholder="Enter API secret"
                autoComplete="off"
              />
            </div>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Keys are encrypted at rest. Prefer Testnet keys. Never share mainnet withdrawal-enabled keys.
            </p>
            <button className="btn btn-primary btn-block" type="submit" disabled={keysBusy}>
              {keysBusy ? 'Saving…' : 'Save keys'}
            </button>
          </form>
        </div>
      </>
    );
  }

  function PlansTab() {
    const plans = [
      { id: 'signal', name: 'Signal', price: '$19', desc: 'Live board + Telegram signals', features: ['Signals view', 'Telegram board', 'No auto-trade'] },
      { id: 'auto', name: 'Auto', price: '$49', desc: 'Signals + Bybit auto-trade', features: ['Everything in Signal', 'Auto-trade', 'Up to 5 positions'] },
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

  function ProfileTab() {
    return (
      <>
        <div className="card">
          <div className="card-title">{user.email}</div>
          <div className="card-subtitle" style={{ marginTop: 4, textTransform: 'capitalize' }}>
            Role: {user.role} · Plan: {user.plan}
          </div>
        </div>

        <div className="card">
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <div className="card-title">Personal Telegram</div>
            <span className={`chip ${tgStatus?.linked ? 'chip-ongoing' : 'chip-muted'}`}>
              {tgStatus?.linked ? 'Connected' : 'Not linked'}
            </span>
          </div>
          <p className="card-subtitle" style={{ marginBottom: 12 }}>
            Link once to receive READY / ONGOING / TP / SL alerts as private messages.
            One shared bot — you do not create your own bot.
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

        {user.role === 'admin' && (
          <a href="/admin" className="btn btn-secondary btn-block" style={{ marginBottom: 12 }}>
            Open Admin Panel
          </a>
        )}

        <div className="card">
          <div className="card-title">Risk disclaimer</div>
          <p className="card-subtitle" style={{ marginTop: 8, lineHeight: 1.5 }}>
            Cryptocurrency trading involves substantial risk of loss. Past performance is not
            indicative of future results. This software does not guarantee profits. Use at your own risk.
            Prefer Testnet keys until you fully understand the system.
          </p>
        </div>

        <button className="btn btn-secondary btn-block" onClick={logout}>
          Sign out
        </button>
      </>
    );
  }

  const tabs = {
    home: <HomeTab />,
    signals: <SignalsTab />,
    trade: <TradeTab />,
    plans: <PlansTab />,
    profile: <ProfileTab />,
    keys: <KeysTab />,
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          {tab === 'home' && 'Home'}
          {tab === 'signals' && 'Signals'}
          {tab === 'trade' && 'Auto-Trade'}
          {tab === 'plans' && 'Plans'}
          {tab === 'profile' && 'Profile'}
          {tab === 'keys' && 'API Keys'}
        </div>
        <span className="topbar-badge">{user.plan}</span>
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

      {toast && <div className="toast">{toast}</div>}

      {sheet && (
        <>
          <div className="sheet-overlay" onClick={() => setSheet(null)} />
          <div className="sheet">
            <div className="sheet-handle" />
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <span className="signal-symbol" style={{ fontSize: 18 }}>{sheet.symbol}</span>
              {statusChip(sheet.status)}
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
            <button className="btn btn-secondary btn-block" style={{ marginTop: 12 }} onClick={() => setSheet(null)}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
