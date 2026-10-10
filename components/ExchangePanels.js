'use client';

import { useEffect, useState, useCallback } from 'react';

export const EX_LABEL = { bybit: 'Bybit', binance: 'Binance' };

const money = (n, d = 2) =>
  n == null || Number.isNaN(+n)
    ? '—'
    : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 2) => (n > 0 ? '+' : '') + money(n, d);
const px = (n) => {
  if (n == null || Number.isNaN(+n)) return '—';
  const a = Math.abs(+n);
  if (a >= 1000) return (+n).toFixed(2);
  if (a >= 1) return (+n).toFixed(4);
  return (+n).toFixed(6);
};

/** Exchange switch. A green dot shows which exchanges are connected. */
export function ExchangeSwitch({ selected, connections = [], onSelect, autoTradeExchange, exchanges = ['binance'] }) {
  const connected = new Set(connections.map((c) => c.exchange));
  return (
    <div className="ex-switch" role="tablist" aria-label="Exchange">
      {exchanges.map((ex) => (
        <button
          key={ex}
          role="tab"
          aria-selected={selected === ex}
          className={`ex-pill ${selected === ex ? 'active' : ''}`}
          onClick={() => onSelect(ex)}
        >
          <span className={`ex-dot ${connected.has(ex) ? 'on' : ''}`} />
          {EX_LABEL[ex]}
          {autoTradeExchange === ex && <span title="Auto-trade ON">⚡</span>}
        </button>
      ))}
    </div>
  );
}

function ModeBadge({ mode }) {
  return <span className={`mode-badge ${mode === 'live' ? 'mode-live' : 'mode-mock'}`}>{mode === 'live' ? 'LIVE' : 'MOCK'}</span>;
}

function PositionCard({ p, exchange, mode, onClosed }) {
  const up = p.pnl >= 0;
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState('');
  const [tpBusy, setTpBusy] = useState(false);
  const [tpMsg, setTpMsg] = useState('');
  const [activeTp, setActiveTp] = useState(p.activeTpLevel || 1);
  const tpOptions = Array.isArray(p.tpOptions) ? p.tpOptions : [];

  async function closeNow() {
    const ok = window.confirm(
      `Close ${p.symbol} ${p.direction} now at market price?\n\n` +
        `Current P&L: ${signed(p.pnl)} USDT${mode === 'live' ? '\n\nThis is a LIVE account - real money.' : ''}`
    );
    if (!ok) return;
    setClosing(true);
    setCloseErr('');
    try {
      const r = await fetch('/api/user/positions/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange, symbol: p.symbol, direction: p.direction }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) setCloseErr(d.error || 'Close failed');
      else if (onClosed) onClosed();
    } catch (e) {
      setCloseErr(e.message);
    } finally {
      setClosing(false);
    }
  }

  async function setTpLevel(level) {
    if (exchange !== 'binance' || tpBusy) return;
    setTpBusy(true);
    setTpMsg('');
    setCloseErr('');
    try {
      const r = await fetch('/api/user/positions/tp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange, symbol: p.symbol, direction: p.direction, tpLevel: level }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) {
        setCloseErr(d.error || 'TP change failed');
      } else {
        setActiveTp(d.tpLevel || level);
        setTpMsg(`TP set to ${d.label || 'TP' + level} @ ${d.tpPrice}`);
        if (onClosed) onClosed();
      }
    } catch (e) {
      setCloseErr(e.message);
    } finally {
      setTpBusy(false);
    }
  }
  // where is mark price between SL and TP (only when both are set)
  let pos = null;
  if (p.sl && p.tp && p.mark) {
    const lo = Math.min(p.sl, p.tp);
    const hi = Math.max(p.sl, p.tp);
    // keep the SL on the red side, TP on the green side
    const raw = (p.mark - lo) / (hi - lo);
    const t = p.direction === 'LONG' ? raw : 1 - raw;
    pos = Math.max(0, Math.min(1, t)) * 100;
  }
  return (
    <div className={`pos-card ${p.direction === 'LONG' ? 'long' : 'short'}`}>
      <div className="pos-head">
        <div>
          <div className="pos-sym">{p.symbol}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <span className={`chip ${p.direction === 'LONG' ? 'chip-long' : 'chip-short'}`}>{p.direction === 'LONG' ? 'Long' : 'Short'}</span>
            <span className="chip chip-muted">{p.leverage}x</span>
          </div>
        </div>
        <div className="pos-pnl">
          <div className={`amt ${up ? 'pnl-up' : 'pnl-down'}`}>{signed(p.pnl)}</div>
          <div className={`pct ${up ? 'pnl-up' : 'pnl-down'}`}>{signed(p.pnlPct, 2)}%</div>
        </div>
      </div>
      <div className="pos-grid">
        <div><div className="k">Entry</div><div className="v">{px(p.entry)}</div></div>
        <div><div className="k">Mark</div><div className="v">{px(p.mark)}</div></div>
        <div><div className="k">Liq.</div><div className="v">{p.liq ? px(p.liq) : '—'}</div></div>
        <div><div className="k">Size</div><div className="v">{p.size}</div></div>
        <div><div className="k">Value</div><div className="v">${money(p.value, 0)}</div></div>
        <div><div className="k">Margin</div><div className="v">${money(p.margin, 2)}</div></div>
      </div>
      {pos != null ? (
        <>
          <div className="pos-range"><span className="dot" style={{ left: `${pos}%` }} /></div>
          <div className="pos-range-lbl">
            <span className="pnl-down">SL {px(p.sl)}</span>
            <span className="pnl-up">TP {px(p.tp)}</span>
          </div>
        </>
      ) : (
        (p.sl || p.tp) && (
          <div className="pos-range-lbl" style={{ marginTop: 12 }}>
            <span className="pnl-down">SL {p.sl ? px(p.sl) : '—'}</span>
            <span className="pnl-up">TP {p.tp ? px(p.tp) : '—'}</span>
          </div>
        )
      )}
      {exchange === 'binance' && tpOptions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="k" style={{ marginBottom: 6 }}>Take profit target</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {tpOptions.map((o) => (
              <button
                key={o.level}
                type="button"
                className="chip"
                disabled={tpBusy}
                onClick={() => setTpLevel(o.level)}
                style={{
                  cursor: 'pointer',
                  fontWeight: 700,
                  background: activeTp === o.level || (+p.tp > 0 && Math.abs(+p.tp - o.price) / o.price < 1e-6) ? '#0ecb81' : undefined,
                  color: activeTp === o.level || (+p.tp > 0 && Math.abs(+p.tp - o.price) / o.price < 1e-6) ? '#0b0e11' : undefined,
                }}
                title={`${o.label} @ ${o.price}`}
              >
                {o.label} · {px(o.price)}
              </button>
            ))}
          </div>
          {tpBusy && <div className="text-secondary" style={{ marginTop: 6, fontSize: 12 }}>Updating TP on exchange…</div>}
          {tpMsg && <div className="text-secondary" style={{ marginTop: 6, fontSize: 12 }}>{tpMsg}</div>}
        </div>
      )}
      {exchange === 'binance' && (
        <>
          <button
            className="btn btn-danger btn-sm"
            style={{ width: '100%', marginTop: 12 }}
            onClick={closeNow}
            disabled={closing || tpBusy}
          >
            {closing ? 'Closing…' : 'Close position now'}
          </button>
          {closeErr && <div className="warn-box" style={{ marginTop: 8 }}>{closeErr}</div>}
        </>
      )}
    </div>
  );
}

/** Live balance + running positions + open orders for the selected exchange. */
export function PortfolioView({ exchange, connected, onConnect, refreshMs = 15000 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/user/portfolio?exchange=${exchange}`, { cache: 'no-store' });
      const d = await r.json();
      if (d.ok === false) setErr(d.error || 'Could not load account');
      else setErr('');
      if (d.connected) setData((prev) => (d.ok === false ? prev && prev.exchange === exchange ? prev : { ...d } : d));
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [exchange, connected]);

  useEffect(() => {
    setData(null);
    setErr('');
    if (!connected) return undefined;
    load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, refreshMs);
    return () => clearInterval(id);
  }, [exchange, connected, load, refreshMs]);

  if (!connected) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 28 }}>
        <div style={{ fontSize: 40 }}>🔌</div>
        <div className="card-title" style={{ marginTop: 8 }}>{EX_LABEL[exchange]} not connected</div>
        <p className="card-subtitle" style={{ margin: '6px 0 16px' }}>
          Connect your {EX_LABEL[exchange]} account (start with a mock key) to see your balance and positions here.
        </p>
        <button className="btn btn-primary" onClick={onConnect}>Connect {EX_LABEL[exchange]}</button>
      </div>
    );
  }

  if (!data) {
    return (
      <>
        <div className="skeleton" style={{ height: 150, marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 90, marginBottom: 12 }} />
        {err && <div className="warn-box">{err}</div>}
      </>
    );
  }

  const b = data.balance;
  const positions = data.positions || [];
  const orders = data.orders || [];
  const upnl = b?.unrealizedPnl || 0;
  const usage = b && b.equity > 0 ? Math.min(100, (b.usedMargin / b.equity) * 100) : 0;

  return (
    <>
      {err && <div className="warn-box">{err} — showing last known data.</div>}
      {b && (
        <div className={`port-hero ${exchange}`}>
          <div className="row">
            <span className="lbl">{EX_LABEL[exchange].toUpperCase()} · TOTAL EQUITY</span>
            <ModeBadge mode={data.mode} />
          </div>
          <div className="big">${money(b.equity)}<small>USDT</small></div>
          <div className="row">
            <span className="pnl">{upnl >= 0 ? '▲' : '▼'} {signed(upnl)} unrealized</span>
            <button className="btn-sm" style={{ color: '#fff', opacity: 0.9, fontWeight: 700 }} onClick={load} disabled={loading}>
              {loading ? 'Updating…' : '↻ Refresh'}
            </button>
          </div>
          <div className="usage-bar"><i style={{ width: `${usage}%` }} /></div>
          <div className="row" style={{ marginTop: 6, fontSize: 11, opacity: 0.9 }}>
            <span>Margin used {usage.toFixed(0)}%</span>
            <span>{positions.length} open position{positions.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      )}

      {b && (
        <div className="port-stats">
          <div className="port-stat"><div className="k">Available</div><div className="v">${money(b.available)}</div></div>
          <div className="port-stat"><div className="k">Wallet</div><div className="v">${money(b.wallet)}</div></div>
          <div className="port-stat">
            <div className="k">Unrealized P&amp;L</div>
            <div className={`v ${upnl >= 0 ? 'pnl-up' : 'pnl-down'}`}>{signed(upnl)}</div>
          </div>
          <div className="port-stat"><div className="k">In positions</div><div className="v">${money(b.usedMargin)}</div></div>
        </div>
      )}

      <div className="flex-between" style={{ margin: '4px 2px 10px' }}>
        <div className="card-title">Running positions</div>
        <span className="chip chip-muted">{positions.length}</span>
      </div>
      {positions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
          No open positions right now.
        </div>
      ) : (
        positions.map((p) => (
          <PositionCard key={`${p.symbol}-${p.direction}`} p={p} exchange={exchange} mode={data.mode} onClosed={load} />
        ))
      )}

      {orders.length > 0 && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 6 }}>Open orders ({orders.length})</div>
          {orders.map((o) => (
            <div className="ord-row" key={o.id}>
              <div>
                <strong>{o.symbol}</strong>{' '}
                <span className={`chip ${o.direction === 'LONG' ? 'chip-long' : 'chip-short'}`}>{o.direction === 'LONG' ? 'Buy' : 'Sell'}</span>
                {o.reduceOnly && <span className="chip chip-muted" style={{ marginLeft: 4 }}>reduce</span>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700 }}>{o.type} {o.price ? `@ ${px(o.price)}` : ''}</div>
                <div className="text-secondary" style={{ fontSize: 11 }}>{o.filled}/{o.qty}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Connect / manage one exchange. Mock is the default and recommended starting point. */
export function ConnectCard({ exchange, connection, busy, onConnect, onDisconnect, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState('mock');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);
  const name = EX_LABEL[exchange];

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  async function submit(e) {
    e.preventDefault();
    const ok = await onConnect({ exchange, mode, apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), confirmLive });
    if (ok) {
      setApiKey('');
      setApiSecret('');
      setConfirmLive(false);
      setOpen(false);
    }
  }

  const mockHelp =
    exchange === 'bybit'
      ? 'Create keys at testnet.bybit.com → API (Read + Trade permissions).'
      : 'Create keys at testnet.binancefuture.com → API Key (Futures testnet).';

  return (
    <div className="conn-card">
      <div className="flex-between">
        <div>
          <div className="card-title">{name} Futures</div>
          <div className="card-subtitle" style={{ marginTop: 2 }}>
            {connection ? (
              <>
                <ModeBadge mode={connection.mode} /> <span style={{ marginLeft: 6 }}>{connection.key_hint}</span>
              </>
            ) : (
              'Not connected'
            )}
          </div>
        </div>
        <span className={`chip ${connection ? 'chip-ongoing' : 'chip-muted'}`}>{connection ? 'Connected' : 'Missing'}</span>
      </div>

      {!open && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
            {connection ? 'Replace keys' : `Connect ${name}`}
          </button>
          {connection && (
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onDisconnect(exchange)}>
              Disconnect
            </button>
          )}
        </div>
      )}

      {open && (
        <form onSubmit={submit} style={{ marginTop: 14 }}>
          <div className="seg">
            <button type="button" className={mode === 'mock' ? 'active' : ''} onClick={() => setMode('mock')}>
              🧪 Mock (practice)
            </button>
            <button type="button" className={mode === 'live' ? 'active live' : ''} onClick={() => setMode('live')}>
              💰 Live (real money)
            </button>
          </div>
          {mode === 'mock' ? (
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Practice with fake funds first. {mockHelp}
            </p>
          ) : (
            <div className="warn-box">
              <strong>Real money.</strong> Orders placed by auto-trade will use your real balance. Use a key with
              Read + Trade only — <strong>never enable Withdraw</strong>. Start with Mock if you are unsure.
              <label style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start', fontWeight: 600 }}>
                <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} style={{ marginTop: 2 }} />
                I understand this is a live account and I accept the risk.
              </label>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">API Key</label>
            <input className="form-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" autoComplete="off" />
          </div>
          <div className="form-group">
            <label className="form-label">API Secret</label>
            <input className="form-input" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="API secret" autoComplete="off" />
          </div>
          <p className="form-hint" style={{ marginBottom: 12 }}>
            Keys are verified with {name} before saving and stored encrypted.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary"
              type="submit"
              style={{ flex: 1 }}
              disabled={busy || !apiKey || !apiSecret || (mode === 'live' && !confirmLive)}
            >
              {busy ? 'Verifying…' : `Verify & connect`}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** One exchange row for the auto-trade selector (only one can be armed). */
export function AutoTradeSelector({ connections, autoTradeExchange, locked, onSet, busy, exchanges = ['binance'] }) {
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>Auto-trade exchange</div>
      <p className="card-subtitle" style={{ marginBottom: 12 }}>
        Auto-trade runs on <b>one</b> exchange at a time. Turning it on for one switches the other off.
      </p>
      {exchanges.map((ex) => {
        const conn = connections.find((c) => c.exchange === ex);
        const on = autoTradeExchange === ex;
        return (
          <div key={ex} className="flex-between" style={{ padding: '10px 0', borderTop: '1px solid var(--border-light)' }}>
            <div>
              <div style={{ fontWeight: 700 }}>
                {EX_LABEL[ex]} {conn && <ModeBadge mode={conn.mode} />}
              </div>
              <div className="text-secondary" style={{ fontSize: 12 }}>
                {!conn ? 'Connect first' : on ? 'Armed — executes eligible signals' : 'Off'}
              </div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={on}
                disabled={!conn || locked || busy}
                onChange={() => onSet(on ? null : ex)}
              />
              <span className="slider" />
            </label>
          </div>
        );
      })}
    </div>
  );
}


/** High Risk settings (the only risk mode) for Binance auto-trade sizing. */
export function RiskModeCard({ settings, onSaved, locked }) {
  const [cfg, setCfg] = useState(null);
  const [pct, setPct] = useState(25);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/user/settings', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        setCfg(d.highRiskConfig || null);
        setPct(d.highRiskConfig?.marginPercent ?? 25);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [settings?.riskMode]);

  if (!cfg) return null;
  const confirmed = settings?.riskMode === 'high';
  const dirty = !confirmed || Number(pct) !== Number(cfg.marginPercent);

  // worked example so the user sees what a trade will look like
  const ex = (slPct) => {
    const lev = Math.max(1, Math.min(cfg.maximumLeverage, Math.floor(cfg.maxLossPerTradePercent / 100 / ((pct / 100) * (slPct / 100)))));
    const loss = Math.min(cfg.maxLossPerTradePercent, pct * lev * (slPct / 100));
    return { lev, loss };
  };

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      const body = {
        riskMode: 'high',
        highRiskMarginPercent: Number(pct),
        confirmHighRisk: confirm || confirmed,
      };
      const r = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Save failed');
      setConfirm(false);
      setMsg('High Risk mode saved');
      onSaved?.(d);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <div className="card-title">Risk mode</div>
        <span className={`chip ${confirmed ? 'chip-short' : 'chip-muted'}`}>
          {confirmed ? '🔥 High Risk' : 'Not confirmed'}
        </span>
      </div>
      {!confirmed && (
        <p className="form-hint" style={{ marginBottom: 10 }}>
          Auto-trade places no trades until you confirm High Risk mode below.
        </p>
      )}

      <div className="form-group">
        <label className="form-label">Margin per trade (% of balance, min {25}%, max {cfg.maxMarginPercent}%)</label>
        <input
          className="form-input"
          type="number"
          min={25}
          max={cfg.maxMarginPercent}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
        />
      </div>
      <div className="port-stats" style={{ marginBottom: 10 }}>
        {[1, 2, 5].map((sl) => {
          const e = ex(sl);
          return (
            <div className="port-stat" key={sl} style={{ gridColumn: 'span 1' }}>
              <div className="k">SL {sl}%</div>
              <div className="v">{e.lev}x</div>
              <div className="text-secondary" style={{ fontSize: 11 }}>risk ≈ {e.loss.toFixed(1)}%</div>
            </div>
          );
        })}
      </div>
      <p className="form-hint" style={{ marginBottom: 10 }}>
        Every trade uses {pct}% of your balance as margin. Leverage is set per trade from the SL distance so a
        stop-out costs at most ~{cfg.maxLossPerTradePercent}% of your balance (tight SL → more leverage, wide SL → less).
        Up to {Math.floor(cfg.maxTotalMarginPercent / pct)} trades at once (total margin ≤ {cfg.maxTotalMarginPercent}%).
        New trades stop for the day after a {cfg.dailyLossLimitPercent}% daily loss, and halt after a {cfg.drawdownHaltPercent}% drop from your peak until you re-arm auto-trade.
      </p>
      {!confirmed && (
        <div className="warn-box">
          <strong>High Risk can lose a large part of your balance quickly.</strong> Losing streaks happen even with a good
          strategy. Try it on a Mock connection first.
          <label style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start', fontWeight: 600 }}>
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} style={{ marginTop: 2 }} />
            I understand and accept this risk.
          </label>
        </div>
      )}

      <button
        className="btn btn-primary"
        style={{ width: '100%' }}
        disabled={busy || locked || !dirty || (!confirmed && !confirm)}
        onClick={save}
      >
        {busy ? 'Saving…' : confirmed ? 'Save margin %' : 'Confirm & enable High Risk'}
      </button>
      {msg && <p className="form-hint" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
