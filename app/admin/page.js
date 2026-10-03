'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import '../globals.css';
import { GATE_DEFS, defaultGateModes } from '../../lib/scanner/strategy/chartPattern/gates.js';

const SECTIONS = [
  { id: 'users', label: 'Users' },
  { id: 'signals', label: 'Signals' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'auto', label: 'Auto-trade' },
  { id: 'reset', label: 'Reset' },
  { id: 'system', label: 'System' },
];

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState('users');
  const [msg, setMsg] = useState(null);

  // Users
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');

  // Telegram
  const [tg, setTg] = useState({
    bot_token: '',
    chat_id: '',
    bot_username: '',
    configured: false,
    token_preview: null,
  });
  const [tgBusy, setTgBusy] = useState(false);

  // Scanner / score / chart pattern
  const [scanBusy, setScanBusy] = useState(false);
  const [activeExchange, setActiveExchange] = useState('binance');
  const [minScore, setMinScore] = useState(80);
  const [minEntryAtr, setMinEntryAtr] = useState(0.75);
  const [maxEntryAtr, setMaxEntryAtr] = useState(4);
  const [telegramMaxAtr, setTelegramMaxAtr] = useState(2);
  const [maxGapPercent, setMaxGapPercent] = useState(1.5);
  const [requireHtf, setRequireHtf] = useState(true);
  const [requireLiq, setRequireLiq] = useState(false);
  const [requireSweepFvg, setRequireSweepFvg] = useState(false);
  const [strategyMode, setStrategyMode] = useState('chart_pattern');
  const [cpMinScore, setCpMinScore] = useState(70);
  const [cpNearMaxAge, setCpNearMaxAge] = useState(48);
  const [cpMinRvol, setCpMinRvol] = useState(1.2);
  const [cpMinRr, setCpMinRr] = useState(1.2);
  const [cpBreakoutAtr, setCpBreakoutAtr] = useState(0.3);
  const [cpMinTp1Rr, setCpMinTp1Rr] = useState(0.8);
  const [cpLiveEntry, setCpLiveEntry] = useState(true);
  const [cpFailedBo, setCpFailedBo] = useState(true);
  const [cpElliottWave, setCpElliottWave] = useState(false);
  const [cpGateModes, setCpGateModes] = useState(() => defaultGateModes({}));

  // Auto-trade global
  const [autoCfg, setAutoCfg] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);

  // Reset
  const [resetBusy, setResetBusy] = useState(false);
  const [resetSecret, setResetSecret] = useState('');
  const [resetMode, setResetMode] = useState('history');
  const [resetPreview, setResetPreview] = useState(null);

  // System
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [sysBusy, setSysBusy] = useState(false);

  // Bybit global keys (legacy shared)
  const [bybitKey, setBybitKey] = useState('');
  const [bybitSecret, setBybitSecret] = useState('');
  const [bybitInfo, setBybitInfo] = useState(null);

  // Signals (admin status control)
  const [sigData, setSigData] = useState({ watching: [], ready: [], ongoing: [], counts: {} });
  const [sigBusy, setSigBusy] = useState(false);
  const [sigFilter, setSigFilter] = useState('all'); // all | watching | ready | ongoing

  const flash = (text) => setMsg(text);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/auth/me');
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      const data = await res.json();
      if (data.user?.role !== 'admin') {
        router.replace('/');
        return;
      }
      setUser(data.user);
      await Promise.all([loadUsers(), loadTelegram(), loadScore(), loadAuto(), loadBybit(), loadScanFlag(), loadSignals()]);
      setLoading(false);
    })();
  }, [router]);

  async function loadUsers(q = search) {
    const res = await fetch(`/api/admin/users?search=${encodeURIComponent(q)}`);
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users || []);
    }
  }

  async function loadTelegram() {
    try {
      const res = await fetch('/api/settings/telegram');
      if (!res.ok) return;
      const data = await res.json();
      setTg((t) => ({
        ...t,
        configured: !!data.configured,
        token_preview: data.token_preview || null,
        chat_id: data.chat_id && data.chat_id !== '(from env)' ? String(data.chat_id) : t.chat_id,
        bot_username: data.bot_username || t.bot_username || '',
      }));
    } catch (_) {}
  }

  async function loadScore() {
    try {
      const res = await fetch('/api/settings/score');
      if (!res.ok) return;
      const data = await res.json();
      if (data.minScore != null) setMinScore(+data.minScore);
      if (data.minEntryATR != null) setMinEntryAtr(+data.minEntryATR);
      if (data.maxEntryATR != null) setMaxEntryAtr(+data.maxEntryATR);
      if (data.telegramMaxATR != null) setTelegramMaxAtr(+data.telegramMaxATR);
      if (data.maxGapPercent != null) setMaxGapPercent(+data.maxGapPercent);
      if (typeof data.requireHtfAligned === 'boolean') setRequireHtf(data.requireHtfAligned);
      if (typeof data.requireLiquidityEdge === 'boolean') setRequireLiq(data.requireLiquidityEdge);
      if (typeof data.requireSweepOrFvg === 'boolean') setRequireSweepFvg(data.requireSweepOrFvg);
      if (data.strategyMode) setStrategyMode(data.strategyMode);
      const cpc = data.chartPatternConfig || {};
      if (cpc.minSignalScore != null) setCpMinScore(+cpc.minSignalScore);
      if (cpc.nearMaxPatternAge != null) setCpNearMaxAge(+cpc.nearMaxPatternAge);
      if (cpc.minRelativeVolume != null) setCpMinRvol(+cpc.minRelativeVolume);
      if (cpc.minRR != null) setCpMinRr(+cpc.minRR);
      if (cpc.breakoutAtrMin != null) setCpBreakoutAtr(+cpc.breakoutAtrMin);
      if (cpc.minTp1RR != null) setCpMinTp1Rr(+cpc.minTp1RR);
      if (typeof cpc.nearEntryOnLivePrice === 'boolean') setCpLiveEntry(cpc.nearEntryOnLivePrice);
      if (typeof cpc.failedBreakoutInvalidate === 'boolean') setCpFailedBo(cpc.failedBreakoutInvalidate);
      if (typeof cpc.waveAnalysisEnabled === 'boolean') setCpElliottWave(cpc.waveAnalysisEnabled);
      setCpGateModes({ ...defaultGateModes(cpc), ...(cpc.gateModes || {}) });
    } catch (_) {}
    try {
      const res = await fetch('/api/settings/exchange');
      if (res.ok) {
        const data = await res.json();
        if (data.exchange) setActiveExchange(data.exchange);
      }
    } catch (_) {}
  }

  async function loadAuto() {
    try {
      const res = await fetch('/api/auto-trading');
      if (!res.ok) return;
      const data = await res.json();
      setAutoCfg(data.config || data || null);
    } catch (_) {}
  }

  async function loadBybit() {
    try {
      const res = await fetch('/api/settings/bybit');
      if (res.ok) setBybitInfo(await res.json());
    } catch (_) {}
  }

  async function loadScanFlag() {
    try {
      // infer from scan start response or signals - try scan route
      const res = await fetch('/api/scan');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.auto_scan_enabled === 'boolean') setAutoScanEnabled(data.auto_scan_enabled);
        if (data.config?.exchange) setActiveExchange(data.config.exchange);
      }
    } catch (_) {}
  }

  async function loadSignals() {
    try {
      const res = await fetch('/api/admin/signals');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        flash(err.error || 'Failed to load signals');
        return;
      }
      const data = await res.json();
      setSigData({
        watching: data.watching || [],
        ready: data.ready || [],
        ongoing: data.ongoing || [],
        counts: data.counts || {},
      });
    } catch (e) {
      flash(e.message || 'Load signals failed');
    }
  }

  async function changeSignalStatus(signalId, action, status = null) {
    setSigBusy(true);
    try {
      const body = { signalId, action };
      if (status) body.status = status;
      const res = await fetch('/api/admin/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        flash(data.error || 'Status change failed');
      } else {
        flash(data.message || `${data.from} → ${data.to}`);
        await loadSignals();
      }
    } catch (e) {
      flash(e.message || 'Status change failed');
    } finally {
      setSigBusy(false);
    }
  }

  async function extendTrial(userId, days = 7) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'extend_trial', days }),
    });
    const data = await res.json();
    flash(data.error || 'Trial extended');
    await loadUsers();
  }

  async function assignPlan(userId, plan) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'assign_plan', plan }),
    });
    const data = await res.json();
    flash(data.error || `Plan → ${plan}`);
    await loadUsers();
  }

  async function toggleSuspend(userId, suspend) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: suspend ? 'suspend' : 'unsuspend' }),
    });
    const data = await res.json();
    flash(data.error || (suspend ? 'Suspended' : 'Unsuspended'));
    await loadUsers();
  }

  async function saveTelegram(withTest) {
    setTgBusy(true);
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_token: tg.bot_token,
          chat_id: tg.chat_id,
          bot_username: tg.bot_username,
          test: !!withTest,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      flash(withTest ? 'Saved + test sent' : 'Telegram saved');
      setTg((t) => ({ ...t, bot_token: '', configured: true }));
      await loadTelegram();
    } catch (e) {
      flash(e.message);
    } finally {
      setTgBusy(false);
    }
  }

  async function refreshBoard() {
    setTgBusy(true);
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh_live_board' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refresh failed');
      flash('Live board refreshed');
    } catch (e) {
      flash(e.message);
    } finally {
      setTgBusy(false);
    }
  }

  async function switchExchange(ex) {
    setScanBusy(true);
    try {
      const res = await fetch('/api/settings/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: ex }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Switch failed');
      setActiveExchange(data.exchange || ex);
      flash(data.msg || `Exchange → ${ex}`);
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function saveScannerSettings() {
    setScanBusy(true);
    try {
      const res = await fetch('/api/settings/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minScore,
          minEntryATR: minEntryAtr,
          maxEntryATR: maxEntryAtr,
          telegramMaxATR: telegramMaxAtr,
          maxGapPercent,
          requireHtfAligned: requireHtf,
          requireLiquidityEdge: requireLiq,
          requireSweepOrFvg: requireSweepFvg,
          strategyMode,
          chartPatternConfig: {
            minSignalScore: cpMinScore,
            nearMaxPatternAge: cpNearMaxAge,
            minRelativeVolume: cpMinRvol,
            minRR: cpMinRr,
            breakoutAtrMin: cpBreakoutAtr,
            minTp1RR: cpMinTp1Rr,
            nearEntryOnLivePrice: cpLiveEntry,
            failedBreakoutInvalidate: cpFailedBo,
            gateModes: cpGateModes,
            waveAnalysisEnabled: cpElliottWave,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      flash(data.msg || 'Scanner settings saved');
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function saveBybitKeys() {
    setScanBusy(true);
    try {
      const res = await fetch('/api/settings/bybit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: bybitKey, apiSecret: bybitSecret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bybit save failed');
      setBybitKey('');
      setBybitSecret('');
      setBybitInfo(data);
      flash(data.msg || 'Bybit keys saved');
      await loadBybit();
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function saveAutoConfig(patch) {
    setAutoBusy(true);
    try {
      const res = await fetch('/api/auto-trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveConfig', ...patch }),
      });
      const data = await res.json();
      if (!res.ok) {
        // try alternate body shape
        const res2 = await fetch('/api/auto-trading', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const data2 = await res2.json();
        if (!res2.ok) throw new Error(data2.error || data.error || 'Save failed');
        setAutoCfg(data2.config || data2);
        flash('Auto-trade config saved');
      } else {
        setAutoCfg(data.config || data);
        flash('Auto-trade config saved');
      }
      await loadAuto();
    } catch (e) {
      flash(e.message);
    } finally {
      setAutoBusy(false);
    }
  }

  async function toggleAutoScan() {
    setSysBusy(true);
    try {
      const path = autoScanEnabled ? '/api/scan/stop' : '/api/scan/start';
      const res = await fetch(path, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setAutoScanEnabled(!autoScanEnabled);
      flash(data.msg || (autoScanEnabled ? 'Auto-scan OFF' : 'Auto-scan ON'));
    } catch (e) {
      flash(e.message);
    } finally {
      setSysBusy(false);
    }
  }

  async function runScanNow() {
    setSysBusy(true);
    try {
      // Manual scan (admin) — does not need CRON_SECRET; scans rotating chunk of full market
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          universe: 'all',
          chunkSize: 30,
          resetCursor: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      const n = data.symbolsScanned ?? data.symbols_scanned ?? '?';
      const created = data.signalsCreated ?? data.signals_created ?? 0;
      flash(`Scan done — ${n} symbols, +${created} new signals`);
    } catch (e) {
      flash(e.message);
    } finally {
      setSysBusy(false);
    }
  }

  async function loadResetPreview() {
    setResetBusy(true);
    try {
      const q = `?mode=${resetMode}${resetSecret ? `&secret=${encodeURIComponent(resetSecret)}` : ''}`;
      const res = await fetch(`/api/admin/reset-signals${q}`);
      const data = await res.json();
      if (res.ok && data?.ok) setResetPreview(data);
      else setResetPreview({ error: data?.error || 'Preview failed', total: 0, preview: [] });
    } catch (e) {
      setResetPreview({ error: e.message, total: 0, preview: [] });
    } finally {
      setResetBusy(false);
    }
  }

  async function confirmReset() {
    setResetBusy(true);
    try {
      const res = await fetch('/api/admin/reset-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, mode: resetMode, secret: resetSecret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.hint || 'Reset failed');
      flash(data.msg || `Reset done (${data.deleted ?? data.total ?? '?'})`);
      setResetPreview(null);
      setResetSecret('');
    } catch (e) {
      flash(e.message);
    } finally {
      setResetBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-page">
        <div className="text-secondary">Loading admin…</div>
      </div>
    );
  }

  const field = (label, children) => (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {children}
    </div>
  );

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24, paddingBottom: 48 }}>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Admin Panel</h1>
          <p className="text-secondary" style={{ margin: '4px 0 0', fontSize: 13 }}>
            {user?.email}
          </p>
        </div>
        <a href="/" className="btn btn-secondary btn-sm">
          ← App
        </a>
      </div>

      <div className="filter-row" style={{ marginBottom: 16 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`filter-pill ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="card" style={{ marginBottom: 12, background: 'var(--primary-soft)' }}>
          {msg}
          <button className="btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => setMsg(null)}>
            dismiss
          </button>
        </div>
      )}

      {/* ─── USERS ─── */}
      {section === 'users' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 14 }}>
            <div className="card-title">Users</div>
            <div className="flex gap-8">
              <input
                className="form-input"
                style={{ width: 220, padding: '8px 12px' }}
                placeholder="Search email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadUsers()}
              />
              <button className="btn btn-primary btn-sm" onClick={() => loadUsers()}>
                Search
              </button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Trial</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.email}
                      {u.role === 'admin' && (
                        <span className="chip chip-muted" style={{ marginLeft: 6 }}>
                          admin
                        </span>
                      )}
                      {u.is_suspended && (
                        <span className="chip chip-ready" style={{ marginLeft: 6 }}>
                          suspended
                        </span>
                      )}
                    </td>
                    <td style={{ textTransform: 'capitalize' }}>{u.plan}</td>
                    <td>{u.subscription_status}</td>
                    <td style={{ fontSize: 12 }}>
                      {u.trial_ends_at ? new Date(u.trial_ends_at).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => extendTrial(u.id, 7)}>
                          +7d
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => assignPlan(u.id, 'auto')}>
                          Auto
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => assignPlan(u.id, 'pro')}>
                          Pro
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{
                            background: u.is_suspended ? 'var(--success)' : 'var(--danger)',
                            color: '#fff',
                          }}
                          onClick={() => toggleSuspend(u.id, !u.is_suspended)}
                        >
                          {u.is_suspended ? 'Unsuspend' : 'Suspend'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!users.length && (
                  <tr>
                    <td colSpan={5} className="text-muted" style={{ textAlign: 'center' }}>
                      No users
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── TELEGRAM ─── */}
      {section === 'telegram' && (
        <>
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <div className="card-title">Telegram bot</div>
              <span className={`chip ${tg.configured ? 'chip-ongoing' : 'chip-muted'}`}>
                {tg.configured ? 'Configured' : 'Missing'}
              </span>
            </div>
            {field(
              'Bot token',
              <input
                className="form-input"
                type="password"
                placeholder={tg.token_preview ? `Saved: ${tg.token_preview}` : 'from BotFather'}
                value={tg.bot_token}
                onChange={(e) => setTg((t) => ({ ...t, bot_token: e.target.value }))}
              />
            )}
            {field(
              'Live board chat ID',
              <input
                className="form-input"
                value={tg.chat_id}
                onChange={(e) => setTg((t) => ({ ...t, chat_id: e.target.value }))}
                placeholder="-100…"
              />
            )}
            {field(
              'Bot username (no @)',
              <input
                className="form-input"
                value={tg.bot_username}
                onChange={(e) => setTg((t) => ({ ...t, bot_username: e.target.value }))}
                placeholder="MySignalBot"
              />
            )}
            <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={tgBusy} onClick={() => saveTelegram(false)}>
                Save
              </button>
              <button className="btn btn-secondary" disabled={tgBusy} onClick={() => saveTelegram(true)}>
                Save + test
              </button>
              <button className="btn btn-secondary" disabled={tgBusy} onClick={refreshBoard}>
                Refresh live board
              </button>
            </div>
          </div>
          <div className="card">
            <div className="card-title">Webhook</div>
            <pre style={{ background: 'var(--border-light)', padding: 12, borderRadius: 12, fontSize: 12, overflowX: 'auto' }}>
{`curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram/webhook"`}
            </pre>
          </div>
        </>
      )}

      {/* ─── SCANNER ─── */}
      {section === 'scanner' && (
        <>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Exchange
            </div>
            <div className="flex gap-8">
              <button
                className={`filter-pill ${activeExchange === 'binance' ? 'active' : ''}`}
                disabled={scanBusy}
                onClick={() => switchExchange('binance')}
              >
                Binance
              </button>
              <button
                className={`filter-pill ${activeExchange === 'bybit' ? 'active' : ''}`}
                disabled={scanBusy}
                onClick={() => switchExchange('bybit')}
              >
                Bybit
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Score & filters
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12 }}>
              {field('Min score', <input className="form-input" type="number" value={minScore} onChange={(e) => setMinScore(+e.target.value)} />)}
              {field('Entry ATR min', <input className="form-input" type="number" step={0.25} value={minEntryAtr} onChange={(e) => setMinEntryAtr(+e.target.value)} />)}
              {field('Entry ATR max', <input className="form-input" type="number" step={0.5} value={maxEntryAtr} onChange={(e) => setMaxEntryAtr(+e.target.value)} />)}
              {field('TG max ATR', <input className="form-input" type="number" step={0.5} value={telegramMaxAtr} onChange={(e) => setTelegramMaxAtr(+e.target.value)} />)}
              {field('Max gap %', <input className="form-input" type="number" step={0.1} value={maxGapPercent} onChange={(e) => setMaxGapPercent(+e.target.value)} />)}
            </div>
            <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={requireHtf} onChange={(e) => setRequireHtf(e.target.checked)} /> HTF aligned
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={requireLiq} onChange={(e) => setRequireLiq(e.target.checked)} /> Liquidity edge
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={requireSweepFvg} onChange={(e) => setRequireSweepFvg(e.target.checked)} /> Sweep/FVG
              </label>
            </div>
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">Strategy mode</label>
              <select className="form-input" value={strategyMode} onChange={(e) => setStrategyMode(e.target.value)}>
                <option value="chart_pattern">chart_pattern</option>
                <option value="smc">smc</option>
                <option value="hybrid">hybrid</option>
              </select>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Chart pattern
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12 }}>
              {field('Min signal score', <input className="form-input" type="number" value={cpMinScore} onChange={(e) => setCpMinScore(+e.target.value)} />)}
              {field('Near max age (h)', <input className="form-input" type="number" value={cpNearMaxAge} onChange={(e) => setCpNearMaxAge(+e.target.value)} />)}
              {field('Min RVOL', <input className="form-input" type="number" step={0.1} value={cpMinRvol} onChange={(e) => setCpMinRvol(+e.target.value)} />)}
              {field('Min RR', <input className="form-input" type="number" step={0.1} value={cpMinRr} onChange={(e) => setCpMinRr(+e.target.value)} />)}
              {field('Breakout ATR min', <input className="form-input" type="number" step={0.05} value={cpBreakoutAtr} onChange={(e) => setCpBreakoutAtr(+e.target.value)} />)}
              {field('Min TP1 RR', <input className="form-input" type="number" step={0.1} value={cpMinTp1Rr} onChange={(e) => setCpMinTp1Rr(+e.target.value)} />)}
            </div>
            <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={cpLiveEntry} onChange={(e) => setCpLiveEntry(e.target.checked)} /> Live entry
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={cpFailedBo} onChange={(e) => setCpFailedBo(e.target.checked)} /> Failed BO invalidate
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={cpElliottWave} onChange={(e) => setCpElliottWave(e.target.checked)} /> Elliott wave
              </label>
            </div>
            <div className="card-title" style={{ margin: '16px 0 8px', fontSize: 14 }}>
              Gates (hard / soft)
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {GATE_DEFS.map((g) => (
                <div key={g.key} className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{g.label}</div>
                    <div className="form-hint">{g.hint}</div>
                  </div>
                  <select
                    className="form-input"
                    style={{ width: 100, padding: '8px 10px' }}
                    value={cpGateModes[g.key] || g.def}
                    onChange={(e) => setCpGateModes((m) => ({ ...m, [g.key]: e.target.value }))}
                  >
                    <option value="hard">hard</option>
                    <option value="soft">soft</option>
                  </select>
                </div>
              ))}
            </div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={scanBusy} onClick={saveScannerSettings}>
              {scanBusy ? 'Saving…' : 'Save scanner settings'}
            </button>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Global Bybit API (shared / testnet)
            </div>
            <p className="form-hint" style={{ marginBottom: 10 }}>
              Status: {bybitInfo?.configured ? 'Configured' : 'Not set'} {bybitInfo?.key_preview || bybitInfo?.preview || ''}
            </p>
            {field('API key', <input className="form-input" value={bybitKey} onChange={(e) => setBybitKey(e.target.value)} autoComplete="off" />)}
            {field('API secret', <input className="form-input" type="password" value={bybitSecret} onChange={(e) => setBybitSecret(e.target.value)} autoComplete="off" />)}
            <button className="btn btn-secondary" disabled={scanBusy || !bybitKey || !bybitSecret} onClick={saveBybitKeys}>
              Save Bybit keys
            </button>
          </div>
        </>
      )}

      {/* ─── AUTO TRADE ─── */}
      {section === 'auto' && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>
            Global auto-trade config
          </div>
          {!autoCfg ? (
            <p className="text-secondary">Loading or unavailable…</p>
          ) : (
            <>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <span>Enabled</span>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={!!autoCfg.autoTradingEnabled}
                    onChange={(e) => {
                      const next = { ...autoCfg, autoTradingEnabled: e.target.checked };
                      setAutoCfg(next);
                      saveAutoConfig({ autoTradingEnabled: e.target.checked });
                    }}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12 }}>
                {field(
                  'Min score',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.minimumScore ?? 80}
                    onChange={(e) => setAutoCfg({ ...autoCfg, minimumScore: +e.target.value })}
                  />
                )}
                {field(
                  'Margin %',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.marginPercent ?? 2}
                    onChange={(e) => setAutoCfg({ ...autoCfg, marginPercent: +e.target.value })}
                  />
                )}
                {field(
                  'Leverage',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.defaultLeverage ?? 10}
                    onChange={(e) => setAutoCfg({ ...autoCfg, defaultLeverage: +e.target.value })}
                  />
                )}
                {field(
                  'Max positions',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.maxOpenPositions ?? 5}
                    onChange={(e) => setAutoCfg({ ...autoCfg, maxOpenPositions: +e.target.value })}
                  />
                )}
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                disabled={autoBusy}
                onClick={() =>
                  saveAutoConfig({
                    minimumScore: autoCfg.minimumScore,
                    marginPercent: autoCfg.marginPercent,
                    defaultLeverage: autoCfg.defaultLeverage,
                    maxOpenPositions: autoCfg.maxOpenPositions,
                    autoTradingEnabled: autoCfg.autoTradingEnabled,
                  })
                }
              >
                {autoBusy ? 'Saving…' : 'Save auto-trade'}
              </button>
              <p className="form-hint" style={{ marginTop: 10 }}>
                Duplicate-order protection remains active. Prefer Testnet keys.
              </p>
            </>
          )}
        </div>
      )}

      {/* ─── SIGNALS (manual status) ─── */}
      {section === 'signals' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <div>
              <div className="card-title">Signal status control</div>
              <p className="card-subtitle" style={{ marginTop: 4 }}>
                WATCHING → READY → ONGOING. Setting READY → ONGOING marks entry hit so Bybit auto-trade fires on next cron (if enabled).
              </p>
            </div>
            <button className="btn btn-secondary" disabled={sigBusy} onClick={loadSignals}>
              Refresh
            </button>
          </div>

          <div className="flex gap-8" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            <span className="chip chip-muted">W {sigData.counts?.watching ?? 0}</span>
            <span className="chip chip-ready">R {sigData.counts?.ready ?? 0}</span>
            <span className="chip chip-ongoing">O {sigData.counts?.ongoing ?? 0}</span>
          </div>

          <div className="flex gap-8" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            {['all', 'watching', 'ready', 'ongoing'].map((f) => (
              <button
                key={f}
                className={`filter-pill ${sigFilter === f ? 'active' : ''}`}
                onClick={() => setSigFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>

          {(() => {
            const rows = [];
            if (sigFilter === 'all' || sigFilter === 'watching') {
              (sigData.watching || []).forEach((s) => rows.push({ ...s, _bucket: 'WATCHING' }));
            }
            if (sigFilter === 'all' || sigFilter === 'ready') {
              (sigData.ready || []).forEach((s) => rows.push({ ...s, _bucket: 'READY' }));
            }
            if (sigFilter === 'all' || sigFilter === 'ongoing') {
              (sigData.ongoing || []).forEach((s) => rows.push({ ...s, _bucket: 'ONGOING' }));
            }
            if (!rows.length) {
              return <p className="form-hint">No signals in this filter.</p>;
            }
            return (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Dir</th>
                      <th>Status</th>
                      <th>Score</th>
                      <th>Entry</th>
                      <th>Price</th>
                      <th>Dist%</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => {
                      const st = String(s.status || s._bucket || '').toUpperCase();
                      const id = s.signal_id;
                      return (
                        <tr key={id}>
                          <td>
                            <b>{s.symbol}</b>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{id?.slice?.(0, 12)}…</div>
                          </td>
                          <td>{(s.direction || s.dir || '—').toUpperCase()}</td>
                          <td>
                            <span
                              className={`chip ${
                                st === 'READY' ? 'chip-ready' : st === 'ONGOING' ? 'chip-ongoing' : 'chip-muted'
                              }`}
                            >
                              {st}
                            </span>
                          </td>
                          <td>{s.score ?? '—'}</td>
                          <td>{s.entry ?? '—'}</td>
                          <td>{s.current_price ?? s.last_price ?? '—'}</td>
                          <td>
                            {s.distance_percent != null
                              ? Number(s.distance_percent).toFixed(2)
                              : '—'}
                          </td>
                          <td>
                            <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                              {st === 'WATCHING' && (
                                <button
                                  className="btn btn-primary"
                                  style={{ padding: '4px 10px', fontSize: 12 }}
                                  disabled={sigBusy}
                                  onClick={() => changeSignalStatus(id, 'promote_ready')}
                                  title="WATCHING → READY"
                                >
                                  → Ready
                                </button>
                              )}
                              {st === 'READY' && (
                                <button
                                  className="btn btn-primary"
                                  style={{ padding: '4px 10px', fontSize: 12 }}
                                  disabled={sigBusy}
                                  onClick={() => {
                                    if (
                                      confirm(
                                        'Set to ONGOING? This marks entry hit and will trigger Bybit auto-trade on next cron if enabled.'
                                      )
                                    ) {
                                      changeSignalStatus(id, 'promote_ongoing');
                                    }
                                  }}
                                  title="READY → ONGOING (triggers Bybit trade)"
                                >
                                  → Ongoing
                                </button>
                              )}
                              {st !== 'INVALIDATED' && st !== 'COMPLETED_PROFIT' && st !== 'STOPPED' && (
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: '4px 10px', fontSize: 12 }}
                                  disabled={sigBusy}
                                  onClick={() => {
                                    if (confirm(`Invalidate ${s.symbol}?`)) {
                                      changeSignalStatus(id, 'set_status', 'INVALIDATED');
                                    }
                                  }}
                                >
                                  Invalidate
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}

          <p className="form-hint" style={{ marginTop: 14 }}>
            <b>→ Ready</b> = WATCHING → READY (Telegram ready alerts can fire).{' '}
            <b>→ Ongoing</b> = READY → ONGOING with <code>entry_hit_at</code> set — auto-trader treats it as entry hit and places Bybit order if auto-trading is ON.
          </p>
        </div>
      )}

      {/* ─── RESET ─── */}
      {section === 'reset' && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>
            Reset signals
          </div>
          <p className="card-subtitle" style={{ marginBottom: 12 }}>
            Uses existing <code>/api/admin/reset-signals</code>. May require CRON_SECRET.
          </p>
          <div className="flex gap-8" style={{ marginBottom: 12 }}>
            <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
              <input type="radio" checked={resetMode === 'history'} onChange={() => setResetMode('history')} /> History only
            </label>
            <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
              <input type="radio" checked={resetMode === 'all'} onChange={() => setResetMode('all')} /> All signals
            </label>
          </div>
          {field(
            'CRON_SECRET (if required)',
            <input
              className="form-input"
              type="password"
              value={resetSecret}
              onChange={(e) => setResetSecret(e.target.value)}
              placeholder="optional if not enforced"
            />
          )}
          <div className="flex gap-8">
            <button className="btn btn-secondary" disabled={resetBusy} onClick={loadResetPreview}>
              Preview
            </button>
            <button className="btn btn-danger" disabled={resetBusy} onClick={confirmReset}>
              Confirm reset
            </button>
          </div>
          {resetPreview && (
            <pre style={{ marginTop: 12, background: 'var(--border-light)', padding: 12, borderRadius: 12, fontSize: 12, overflow: 'auto' }}>
              {JSON.stringify(resetPreview, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* ─── SYSTEM ─── */}
      {section === 'system' && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>
            Scan control
          </div>
          <p className="card-subtitle" style={{ marginBottom: 12 }}>Full multi-chunk Scan Now is on the <b>Home</b> dashboard (admin account). Use this for auto-scan flag + emergency trigger.</p>
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <span>Auto-scan (cron)</span>
            <span className={`chip ${autoScanEnabled ? 'chip-ongoing' : 'chip-muted'}`}>
              {autoScanEnabled ? 'ON' : 'OFF'}
            </span>
          </div>
          <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={sysBusy} onClick={toggleAutoScan}>
              {autoScanEnabled ? 'Stop auto-scan' : 'Start auto-scan'}
            </button>
            <button className="btn btn-secondary" disabled={sysBusy} onClick={runScanNow}>
              Trigger scan now
            </button>
          </div>
          <p className="form-hint" style={{ marginTop: 12 }}>
            <b>Start auto-scan</b> = allow cron-job.org to run. <b>Trigger scan now</b> = run one pass immediately (all coins universe, ~30 coins per pass on Vercel Hobby).
            Cron every 1–2 min rotates through the full Bybit/Binance market. New users see the same shared signals — no per-user scan.
          </p>
        </div>
      )}
    </div>
  );
}
