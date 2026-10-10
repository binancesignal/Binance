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
  const [preferredTpLevel, setPreferredTpLevel] = useState(1);
  const [signals, setSignals] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [sheet, setSheet] = useState(null); // selected signal
  const [enterBusyId, setEnterBusyId] = useState(null);
  const [mtSymbol, setMtSymbol] = useState('');
  const [mtDir, setMtDir] = useState('LONG');
  const [mtLev, setMtLev] = useState(10);
  const [mtMargin, setMtMargin] = useState(10);
  const [mtBusy, setMtBusy] = useState(false);
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

  async function placeFreeManualTrade() {
    if (!user?.can_auto_trade) {
      showToast('Upgrade to Auto plan for manual trade');
      setTab('plans');
      return;
    }
    if (settings?.freeManualTradeEnabled === false) {
      showToast('Manual trade is disabled by admin');
      return;
    }
    const sym = String(mtSymbol || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!sym) {
      showToast('Enter a coin name (e.g. BTC or BTCUSDT)');
      return;
    }
    const lev = Math.floor(Number(mtLev));
    const margin = Number(mtMargin);
    if (!(lev >= 1 && lev <= 125)) {
      showToast('Leverage must be 1–125');
      return;
    }
    if (!(margin > 0)) {
      showToast('Margin (USDT) must be > 0');
      return;
    }
    const ok = window.confirm(
      `Place ${mtDir} market order?\n\n` +
        `Symbol: ${sym.endsWith('USDT') ? sym : sym + 'USDT'}\n` +
        `Leverage: ${lev}x\n` +
        `Margin: ${margin} USDT\n` +
        `Notional ≈ ${(margin * lev).toFixed(2)} USDT`
    );
    if (!ok) return;
    setMtBusy(true);
    try {
      const res = await fetch('/api/user/manual-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: selectedExchange || 'binance',
          symbol: sym,
          direction: mtDir,
          leverage: lev,
          marginUsdt: margin,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Trade failed');
      showToast(data.msg || 'Market order placed');
      setMtSymbol('');
    } catch (err) {
      showToast(err.message);
    } finally {
      setMtBusy(false);
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

  // ─── Tab content ────────────────────────────────────────
  function HomeTab() {
    return (
      <>
        <ExchangeSwitch
          selected={selectedExchange}
          connections={exState.connections}
          autoTradeExchange={exState.autoTradeExchange}
          onSelect={selectExchange}
          exchanges={['binance']}
        />
        <div className="greeting">
          <h1>Hello{user.email ? `, ${user.email.split('@')[0]}` : ''}</h1>
          <p>
            Plan: <strong style={{ textTransform: 'capitalize' }}>{user.plan}</strong>
            {isTrial && daysLeft > 0 && ` · ${daysLeft} days left in free trial`}
          </p>
        </div>

        <div className="card">
          <div className="progress-ring-wrap" style={{ alignItems: 'center' }}>
            <FullScanRing
              lastAt={lastFullScanAt}
              nextAt={nextFullScanAt}
              intervalMin={fullScanInterval}
              running={!!scanMeta?.full_scan_running}
            />
            <div>
              <div className="card-title">Next market scan</div>
              <div className="card-subtitle">
                Full scan every <strong>{fullScanInterval} min</strong>
                {autoScanEnabled ? ' · Auto-scan ON' : ' · Auto-scan off'}
              </div>
              <div className="card-subtitle" style={{ marginTop: 4 }}>
                {fullScanCaption({
                  running: !!scanMeta?.full_scan_running,
                  summary: scanMeta?.last_full_scan_summary,
                  lastAt: lastFullScanAt,
                  intervalMin: fullScanInterval,
                })}
              </div>
              {lastFullScanAt && (
                <div className="card-subtitle" style={{ marginTop: 4, fontSize: 12 }}>
                  Last full scan:{' '}
                  <strong>{new Date(lastFullScanAt).toLocaleString()}</strong>
                </div>
              )}
            </div>
          </div>
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
            <span className="text-secondary" style={{ fontSize: 13 }}>{EX_LABEL[selectedExchange]} account</span>
            <span className={`chip ${connectionOf(selectedExchange) ? 'chip-ongoing' : 'chip-muted'}`}>
              {connectionOf(selectedExchange)
                ? `${EX_LABEL[selectedExchange]} · ${connectionOf(selectedExchange).mode === 'live' ? 'Live' : 'Mock'}`
                : `${EX_LABEL[selectedExchange]} not connected`}
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
        <ExchangeSwitch
          selected={selectedExchange}
          connections={exState.connections}
          autoTradeExchange={exState.autoTradeExchange}
          onSelect={selectExchange}
          exchanges={['binance']}
        />
        <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
          <div className="flex-between" style={{ alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Next market scan</div>
              <div className="text-secondary" style={{ fontSize: 12 }}>
                Every {fullScanInterval} min · shared feed
              </div>
            </div>
            <FullScanRing
              lastAt={lastFullScanAt}
              nextAt={nextFullScanAt}
              intervalMin={fullScanInterval}
              running={!!scanMeta?.full_scan_running}
            />
          </div>
        </div>
        <div className="filter-row">
          {['ALL', 'WATCHING', 'READY', 'ONGOING', 'TP1', 'TP2', 'TP3', 'SL_HIT', 'INVALIDATED'].map((f) => (
            <button
              key={f}
              className={`filter-pill ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'ALL' ? 'All' : f === 'SL_HIT' ? 'SL Hit' : f === 'INVALIDATED' ? 'Invalid' : f === 'TP1' ? 'TP1' : f === 'TP2' ? 'TP2' : f === 'TP3' ? 'TP3' : f.charAt(0) + f.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        {hasAccess && (
          <button
            className="btn btn-secondary btn-block ict-analysis-launch"
            onClick={() => openIctChart()}
          >
            {Icons.scan}
            Analyze any coin with ICT/SMC
          </button>
        )}

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
                {statusChip(s.status, s)}
              </div>
              <div className="signal-meta">
                {dirChip(s.direction || s.side)}
                {s.score != null && (
                  <span className="chip chip-muted">Score {Number(s.score).toFixed(0)}</span>
                )}
                {(s.metadata?.pattern || s.pattern || s.metadata?.patternGeom?.type) && (
                  <span className="chip chip-muted">
                    {String(s.metadata?.pattern || s.pattern || s.metadata?.patternGeom?.type).replace(/_/g, ' ')}
                  </span>
                )}
              </div>
              {s.metadata?.confluenceMode === 'ict_chart_pattern' && (
                <div className="card-subtitle" style={{ marginTop: 4 }}>
                  ICT + Chart Pattern · {s.metadata.chartPatternConfirmation?.pattern || 'confirmed'}
                  {s.metadata.chartPatternConfirmation?.timeframe
                    ? ` · ${s.metadata.chartPatternConfirmation.timeframe}`
                    : ''}
                </div>
              )}
              {(s.metadata?.strategy || s.strategy) === 'chart_pattern' && (
                <div className="card-subtitle" style={{ marginTop: 4 }}>
                  Chart Pattern · {String(s.metadata?.pattern || s.pattern || s.metadata?.patternGeom?.type || 'setup').replace(/_/g, ' ')}
                  {s.metadata?.patternTf ? ` · ${s.metadata.patternTf}` : ''}
                  {s.metadata?.universal?.elliott?.primary?.type
                    ? ` · EW ${s.metadata.universal.elliott.primary.type}${s.metadata.universal.elliott.primary.currentWave != null ? ` W${s.metadata.universal.elliott.primary.currentWave}` : ''}`
                    : s.metadata?.patternGeom?.elliott?.type
                      ? ` · EW ${s.metadata.patternGeom.elliott.type}`
                      : ''}
                </div>
              )}
              {(s.metadata?.strategy || s.strategy) === 'ict_smc' && (
                <div className="card-subtitle" style={{ marginTop: 4 }}>
                  {String(s.status).toUpperCase() === 'WATCHING'
                    ? 'Waiting for price to return to the SMC point of interest'
                    : String(s.status).toUpperCase() === 'READY'
                      ? 'Price is near or inside the SMC point of interest'
                      : String(s.status).toUpperCase() === 'ONGOING'
                        ? 'Entry level reached · trade in progress'
                        : 'ICT SMC setup'}
                </div>
              )}
              {(s.metadata?.strategy || s.strategy) === 'zone_pattern' && (
                <div className="card-subtitle" style={{ marginTop: 4 }}>
                  Zone + Pattern · {s.metadata?.pattern || s.pattern || 'confirmed'}
                  {s.metadata?.zone?.families?.length
                    ? ` · ${s.metadata.zone.families.length} confluence sources`
                    : ''}
                </div>
              )}
              {(s.metadata?.strategy || s.strategy) === 'ema_bump' && (
                <div className="card-subtitle" style={{ marginTop: 4 }}>
                  EMA Bump · {String(s.metadata?.patternTf || '').toUpperCase() || 'TF'}
                  {s.metadata?.gapATR != null ? ` · EMA gap ${s.metadata.gapATR} ATR` : ''}
                  {s.metadata?.depthATR != null ? ` · dip ${s.metadata.depthATR} ATR` : ''}
                </div>
              )}
              {(s.metadata?.strategy || s.strategy) === 'double_confluence' && (
                <div className="card-subtitle" style={{ marginTop: 4 }}>
                  Double Top/Bottom · {s.metadata?.pattern || s.pattern || 'setup'}
                  {s.metadata?.quality ? ` · ${s.metadata.quality}` : ''}
                  {s.metadata?.entryTf ? ` · ${s.metadata.harmonic.type}` : ''}
                </div>
              )}
              <div className="signal-prices">
                <span>Entry <strong>{fmt(s.entry || s.entry_price)}</strong></span>
                {s.sl != null && <span>SL <strong>{fmt(s.sl)}</strong></span>}
                {s.tp1 != null && <span>TP1 <strong>{fmt(s.tp1)}</strong></span>}
              </div>
              {String(s.status || '').toUpperCase() === 'INVALIDATED' && (
                <div className="card-subtitle" style={{ marginTop: 6, color: '#f6465d' }}>
                  <strong>Invalid:</strong>{' '}
                  {s.metadata?.invalidation?.reasons?.[0]?.reason
                    || s.metadata?.invalidation?.reason
                    || s.metadata?.entryConfirmReason
                    || s.invalidation_reason
                    || 'Setup invalidated'}
                </div>
              )}
              {(s.metadata?.entryConfirmReason || s.metadata?.entryClassReason) &&
                String(s.status || '').toUpperCase() !== 'INVALIDATED' &&
                String(s.status || '').toUpperCase() !== 'ONGOING' && (
                <div className="card-subtitle" style={{ marginTop: 6, color: '#848e9c', fontSize: 12 }}>
                  {s.metadata?.entryConfirmReason || s.metadata?.entryClassReason}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="text-secondary" style={{ fontSize: 12 }}>TP target:</span>
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="chip"
                    onClick={(e) => { e.stopPropagation(); savePreferredTp(n); }}
                    style={{
                      cursor: 'pointer',
                      fontWeight: 700,
                      background: preferredTpLevel === n ? '#0ecb81' : undefined,
                      color: preferredTpLevel === n ? '#0b0e11' : undefined,
                      padding: '4px 10px',
                    }}
                  >
                    TP{n}
                  </button>
                ))}
              </div>
              {String(s.status || '').toUpperCase() === 'READY' &&
                settings?.manualEntryEnabled !== false &&
                user?.can_auto_trade && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: 10, width: '100%' }}
                  disabled={enterBusyId === (s.signal_id || `${s.symbol}_${s.direction || s.dir || ''}`)}
                  onClick={(e) => {
                    e.stopPropagation();
                    enterNowMarket(s);
                  }}
                >
                  {enterBusyId === (s.signal_id || `${s.symbol}_${s.direction || s.dir || ''}`)
                    ? 'Placing…'
                    : 'Market Entry'}
                </button>
              )}
            </div>
          ))
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

        {settings?.freeManualTradeEnabled !== false && (
          <div className="card">
            <div className="card-title">Manual Trade</div>
            <p className="card-subtitle" style={{ marginBottom: 12 }}>
              Search a coin, set leverage &amp; margin (USDT), then place a market order.
            </p>
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <label className="form-label" style={{ fontSize: 12 }}>Coin name</label>
                <input
                  className="form-input"
                  placeholder="BTC / ETH / SOL …"
                  value={mtSymbol}
                  onChange={(e) => setMtSymbol(e.target.value.toUpperCase())}
                  disabled={locked || mtBusy}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="chip"
                  onClick={() => setMtDir('LONG')}
                  disabled={locked || mtBusy}
                  style={{
                    flex: 1,
                    cursor: 'pointer',
                    fontWeight: 700,
                    background: mtDir === 'LONG' ? '#0ecb81' : undefined,
                    color: mtDir === 'LONG' ? '#0b0e11' : undefined,
                  }}
                >
                  Long
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => setMtDir('SHORT')}
                  disabled={locked || mtBusy}
                  style={{
                    flex: 1,
                    cursor: 'pointer',
                    fontWeight: 700,
                    background: mtDir === 'SHORT' ? '#f6465d' : undefined,
                    color: mtDir === 'SHORT' ? '#fff' : undefined,
                  }}
                >
                  Short
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label className="form-label" style={{ fontSize: 12 }}>Leverage</label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    max={125}
                    value={mtLev}
                    onChange={(e) => setMtLev(e.target.value)}
                    disabled={locked || mtBusy}
                  />
                </div>
                <div>
                  <label className="form-label" style={{ fontSize: 12 }}>Margin (USDT)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    step={0.5}
                    value={mtMargin}
                    onChange={(e) => setMtMargin(e.target.value)}
                    disabled={locked || mtBusy}
                  />
                </div>
              </div>
              <div className="text-secondary" style={{ fontSize: 12 }}>
                Notional ≈ {(Number(mtMargin) * Math.floor(Number(mtLev) || 0) || 0).toFixed(2)} USDT
              </div>
              <button
                className="btn btn-primary btn-block"
                disabled={locked || mtBusy || !String(mtSymbol || '').trim()}
                onClick={placeFreeManualTrade}
              >
                {mtBusy ? 'Placing…' : 'Place market order'}
              </button>
            </div>
          </div>
        )}

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

  function ProfileTab() {
    return (
      <>
        <div className="card">
          <div className="card-title">{user.email}</div>
          <div className="card-subtitle" style={{ marginTop: 4, textTransform: 'capitalize' }}>
            Role: {user.role} · Plan: {user.plan}
          </div>
          <div className="card-subtitle" style={{ marginTop: 8, fontSize: 12 }}>
            App {getVersionLabel()}
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
    trade: TradeTab(),
    plans: <PlansTab />,
    profile: <ProfileTab />,
    keys: KeysTab(),
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
          {tab === 'keys' && 'Exchanges'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="text-secondary" style={{ fontSize: 11 }} title="App version">
            {getVersionLabel()}
          </span>
          <span className="topbar-badge">{user.plan}</span>
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

      {toast && <div className="toast">{toast}</div>}

      {/* AI Manager floating button + panel */}
      <button
        type="button"
        className="ai-fab"
        onClick={() => setAiOpen(true)}
        title="Talk to Nila"
        aria-label="Open AI Manager Nila"
      >
        AI
      </button>
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
