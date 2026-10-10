'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';

const money = (n, d = 2) =>
  n == null || Number.isNaN(+n)
    ? '—'
    : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 2) => (n > 0 ? '+' : '') + money(n, d);
const pct = (n, d = 1) => (n == null || Number.isNaN(+n) ? '—' : `${n > 0 ? '+' : ''}${(+n).toFixed(d)}%`);
const dt = (v) =>
  v
    ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

function duration(a, b) {
  const ms = new Date(b) - new Date(a);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ─── the chart ───────────────────────────────────────────────
const W = 360;
const H = 210;
const PAD = { l: 46, r: 14, t: 16, b: 26 };

function BalanceChart({ series, start, selected, onSelect }) {
  const n = series.length;
  const balances = series.map((p) => p.balance);
  let lo = Math.min(start, ...balances);
  let hi = Math.max(start, ...balances);
  if (hi - lo < start * 0.02) {
    lo -= start * 0.01;
    hi += start * 0.01;
  }
  const padY = (hi - lo) * 0.12;
  lo -= padY;
  hi += padY;

  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * ih;

  const up = balances[n - 1] >= start;
  const color = up ? 'var(--success)' : 'var(--danger)';
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${(PAD.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(PAD.t + ih).toFixed(1)} Z`;
  const grid = [0, 1, 2, 3].map((k) => lo + ((hi - lo) * k) / 3);
  const step = Math.max(1, Math.ceil(n / 9));
  const r = n > 40 ? 2.4 : n > 20 ? 3.2 : 4.2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ej-svg" role="img" aria-label="Balance after each trade">
      <defs>
        <linearGradient id="ej-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={up ? '#10B981' : '#EF4444'} stopOpacity="0.28" />
          <stop offset="100%" stopColor={up ? '#10B981' : '#EF4444'} stopOpacity="0" />
        </linearGradient>
      </defs>

      {grid.map((v, k) => (
        <g key={k}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
          <text x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end" className="ej-axis">
            {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 100 ? 1 : 0)}
          </text>
        </g>
      ))}

      {/* where it all started */}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(start)} y2={y(start)} stroke="var(--primary)" strokeWidth="1.2" strokeDasharray="4 4" />
      <text x={W - PAD.r} y={y(start) - 4} textAnchor="end" className="ej-axis" fill="var(--primary)">
        start {money(start, 0)}
      </text>

      {n > 1 && <path d={area} fill="url(#ej-fill)" />}
      {n > 1 && <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />}

      {series.map((p, i) => {
        const isSel = i === selected;
        const fill = i === 0 ? 'var(--primary)' : p.win ? 'var(--success)' : 'var(--danger)';
        return (
          <g key={i}>
            {isSel && <circle cx={x(i)} cy={y(p.balance)} r={r + 5} fill={fill} opacity="0.18" />}
            <circle cx={x(i)} cy={y(p.balance)} r={isSel ? r + 1.5 : r} fill={fill} stroke="#fff" strokeWidth="1.5" />
            {(i % step === 0 || isSel || i === n - 1) && (
              <text x={x(i)} y={H - 8} textAnchor="middle" className={`ej-axis ${isSel ? 'ej-axis-on' : ''}`}>
                {i === 0 ? 'Start' : p.label.length > 6 ? p.label.slice(0, 6) : p.label}
              </text>
            )}
          </g>
        );
      })}

      {/* tap targets */}
      {series.map((p, i) => (
        <rect
          key={`t${i}`}
          x={x(i) - iw / Math.max(n - 1, 1) / 2}
          y={PAD.t}
          width={Math.max(iw / Math.max(n - 1, 1), 14)}
          height={ih + PAD.b}
          fill="transparent"
          style={{ cursor: 'pointer' }}
          onClick={() => onSelect(i)}
          onMouseEnter={() => onSelect(i)}
        />
      ))}
    </svg>
  );
}

function PnlBars({ series, selected, onSelect }) {
  const trades = series.slice(1);
  if (!trades.length) return null;
  const h = 64;
  const max = Math.max(...trades.map((t) => Math.abs(t.pnl)), 0.0001);
  const iw = W - PAD.l - PAD.r;
  const slot = iw / trades.length;
  const bw = Math.max(2, Math.min(18, slot * 0.62));
  const mid = h / 2;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} className="ej-svg ej-bars" role="img" aria-label="Profit or loss per trade">
      <line x1={PAD.l} x2={W - PAD.r} y1={mid} y2={mid} stroke="var(--border)" />
      <text x={PAD.l - 6} y={mid + 3.5} textAnchor="end" className="ej-axis">
        P&amp;L
      </text>
      {trades.map((t, k) => {
        const bh = (Math.abs(t.pnl) / max) * (mid - 6);
        const cx = PAD.l + slot * k + slot / 2;
        const sel = k + 1 === selected;
        return (
          <rect
            key={k}
            x={cx - bw / 2}
            y={t.pnl >= 0 ? mid - bh : mid}
            width={bw}
            height={Math.max(bh, 1.5)}
            rx="2"
            fill={t.pnl >= 0 ? 'var(--success)' : 'var(--danger)'}
            opacity={sel ? 1 : 0.62}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(k + 1)}
          />
        );
      })}
    </svg>
  );
}

// ─── one trade, step by step ─────────────────────────────────
function TradeFlow({ t }) {
  const win = t.pnl >= 0;
  return (
    <div className="ej-flow-wrap">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <div>
          <strong style={{ fontSize: 16 }}>{t.coin}</strong>{' '}
          <span className={`chip ${t.side === 'LONG' ? 'chip-long' : 'chip-short'}`}>{t.side}</span>{' '}
          <span className="text-secondary" style={{ fontSize: 12 }}>
            {t.leverage}x · #{t.n}
          </span>
        </div>
        <span className="text-secondary" style={{ fontSize: 11 }}>
          {dt(t.openedAt)} · {duration(t.openedAt, t.closedAt)}
        </span>
      </div>

      <div className="ej-flow">
        <div className="ej-step">
          <div className="k">Balance</div>
          <div className="v">{money(t.balanceAtEntry)}</div>
          <div className="s">before trade</div>
        </div>
        <div className="ej-arrow">→</div>
        <div className="ej-step">
          <div className="k">Taken</div>
          <div className="v">{money(t.margin)}</div>
          <div className="s">{t.marginPctOfBalance != null ? `${t.marginPctOfBalance.toFixed(0)}% as margin` : 'margin'}</div>
        </div>
        <div className="ej-arrow">→</div>
        <div className={`ej-step ${win ? 'ej-win' : 'ej-loss'}`}>
          <div className="k">{win ? 'Profit' : 'Loss'}</div>
          <div className="v">{signed(t.pnl)}</div>
          <div className="s">{pct(t.roiOnMargin, 0)} on margin</div>
        </div>
        <div className="ej-arrow">→</div>
        <div className="ej-step ej-final">
          <div className="k">Balance</div>
          <div className="v">{money(t.balanceAfter)}</div>
          <div className="s">{pct(t.pnlPctOfBalance, 2)} of balance</div>
        </div>
      </div>
      {t.fees !== 0 && (
        <div className="text-secondary" style={{ fontSize: 11, marginTop: 8 }}>
          Net of fees &amp; funding: {signed(t.fees)} USDT
        </div>
      )}
    </div>
  );
}

// ─── starting capital card ───────────────────────────────────
function CapitalCard({ data, onChanged }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [restart, setRestart] = useState(false);
  const cap = data.capital;
  const wallet = data.wallet;

  async function call(body) {
    setBusy(true);
    setMsg('');
    try {
      const r = await fetch('/api/user/capital', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      setAmount('');
      setRestart(false);
      onChanged();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <>
      <div className="form-group">
        <label className="form-label">
          Starting capital (USDT){wallet ? ` — wallet has ${money(wallet.equity)}` : ''}
        </label>
        <input
          className="form-input"
          type="number"
          inputMode="decimal"
          min={data.minStartingCapital}
          placeholder={`min ${data.minStartingCapital}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      {wallet && (
        <div className="ej-quick">
          {[25, 50, 100].map((p) => (
            <button key={p} type="button" onClick={() => setAmount(String(Math.floor((wallet.equity * p) / 100 * 100) / 100))}>
              {p}%
            </button>
          ))}
        </div>
      )}
      <button
        className="btn btn-primary"
        style={{ width: '100%', marginTop: 8 }}
        disabled={busy || !(Number(amount) > 0)}
        onClick={() => call({ action: 'start', startingCapital: Number(amount) })}
      >
        {busy ? 'Saving…' : cap ? 'Restart with this amount' : 'Start with this amount'}
      </button>
    </>
  );

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: 8 }}>
        <div className="card-title">Trading capital</div>
        <span className={`mode-badge ${data.mode === 'live' ? 'mode-live' : 'mode-mock'}`}>{data.mode === 'live' ? 'LIVE' : 'MOCK'}</span>
      </div>

      {!cap && (
        <>
          <p className="card-subtitle" style={{ marginBottom: 12 }}>
            Your futures wallet can hold any amount. Choose how much the bot may trade with. That is your starting capital:
            every trade is sized from it, profits are added, losses are taken off, and it keeps going from there.
          </p>
          {form}
        </>
      )}

      {cap && (
        <>
          <div className="flex-between" style={{ marginBottom: 6 }}>
            <span className="text-secondary" style={{ fontSize: 13 }}>Started with</span>
            <strong>{money(cap.startingCapital)} USDT</strong>
          </div>
          <div className="flex-between" style={{ marginBottom: 6 }}>
            <span className="text-secondary" style={{ fontSize: 13 }}>Since</span>
            <strong style={{ fontSize: 13 }}>{dt(cap.startedAt)}</strong>
          </div>
          {wallet && (
            <div className="flex-between" style={{ marginBottom: 10 }}>
              <span className="text-secondary" style={{ fontSize: 13 }}>Futures wallet (not touched)</span>
              <strong>{money(wallet.equity)} USDT</strong>
            </div>
          )}
          {!restart ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => setRestart(true)}>
                Restart capital
              </button>
              <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => confirm('Stop using a capital limit? The bot will size trades from your whole wallet again.') && call({ action: 'stop' })}>
                Use whole wallet
              </button>
            </div>
          ) : (
            <>
              <div className="warn-box">Restarting begins a fresh chart from the new amount. Old trades leave the chart.</div>
              {form}
              <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => setRestart(false)}>
                Cancel
              </button>
            </>
          )}
        </>
      )}
      {msg && <p className="form-hint" style={{ marginTop: 8, color: 'var(--danger)' }}>{msg}</p>}
    </div>
  );
}

// ─── main ────────────────────────────────────────────────────
export function EquityJourney({ connected, refreshMs = 30000 }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/user/capital', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      setData(d);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    if (!connected) return undefined;
    load();
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [connected, load, refreshMs]);

  const ledger = data?.ledger;
  const series = ledger?.series || [];
  const selected = sel != null && sel < series.length ? sel : series.length - 1;
  const trade = selected > 0 ? ledger.trades[selected - 1] : null;
  const listed = useMemo(() => {
    const rows = [...(ledger?.trades || [])].reverse();
    return showAll ? rows : rows.slice(0, 8);
  }, [ledger, showAll]);

  if (!connected) return null;
  if (err && !data) return <div className="card"><p className="form-hint">{err}</p></div>;
  if (!data) return <div className="card"><p className="form-hint">Loading capital…</p></div>;
  if (!data.connected) return null;

  const s = ledger?.stats;
  const up = (s?.totalPnl ?? 0) >= 0;

  return (
    <>
      <CapitalCard data={data} onChanged={load} />

      {ledger && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 4 }}>
            <div className="card-title">Balance journey</div>
            <span className="text-secondary" style={{ fontSize: 11 }}>tap a point</span>
          </div>

          <div className="ej-hero">
            <div>
              <div className="ej-hero-k">Balance now</div>
              <div className="ej-hero-v">{money(s.balanceNow)} <small>USDT</small></div>
            </div>
            <div className={`ej-pill ${up ? 'ej-win' : 'ej-loss'}`}>
              {signed(s.totalPnl)} · {pct(s.roiPct)}
            </div>
          </div>

          {s.trades === 0 ? (
            <p className="card-subtitle" style={{ margin: '14px 0 4px' }}>
              No finished trades yet. When the bot closes its first trade, the chart starts moving from{' '}
              {money(ledger.startingCapital)} USDT.
            </p>
          ) : (
            <>
              <BalanceChart series={series} start={ledger.startingCapital} selected={selected} onSelect={setSel} />
              <PnlBars series={series} selected={selected} onSelect={setSel} />
            </>
          )}

          <div className="ej-stats">
            <div><span>Trades</span><b>{s.trades}</b></div>
            <div><span>Win rate</span><b>{s.winRate == null ? '—' : `${s.winRate.toFixed(0)}%`}</b></div>
            <div><span>Max drop</span><b>{s.maxDrawdownPct ? `-${s.maxDrawdownPct.toFixed(1)}%` : '0%'}</b></div>
            <div><span>In trades</span><b>{money(s.usedMargin)}</b></div>
            <div><span>Free</span><b>{money(s.free)}</b></div>
            <div><span>Profit factor</span><b>{s.profitFactor == null ? '—' : s.profitFactor.toFixed(2)}</b></div>
          </div>

          {trade && <TradeFlow t={trade} />}
          {selected === 0 && s.trades > 0 && (
            <div className="ej-flow-wrap">
              <strong>Start</strong>
              <div className="text-secondary" style={{ fontSize: 12, marginTop: 4 }}>
                {money(ledger.startingCapital)} USDT on {dt(ledger.startedAt)}
              </div>
            </div>
          )}

          {ledger.open.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="card-title" style={{ fontSize: 13, marginBottom: 6 }}>Running now</div>
              {ledger.open.map((o) => (
                <div key={o.id} className="flex-between ej-row">
                  <span>
                    <b>{o.coin}</b>{' '}
                    <span className={`chip ${o.side === 'LONG' ? 'chip-long' : 'chip-short'}`}>{o.side}</span>
                  </span>
                  <span className="text-secondary" style={{ fontSize: 12 }}>
                    {money(o.margin)} margin · {o.leverage}x
                  </span>
                </div>
              ))}
            </div>
          )}

          {listed.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="card-title" style={{ fontSize: 13, marginBottom: 6 }}>Every trade</div>
              {listed.map((t) => (
                <button key={t.id} type="button" className={`ej-row ej-rowbtn ${t.n === selected ? 'on' : ''}`} onClick={() => setSel(t.n)}>
                  <span style={{ textAlign: 'left' }}>
                    <b>#{t.n} {t.coin}</b>{' '}
                    <span className={`chip ${t.side === 'LONG' ? 'chip-long' : 'chip-short'}`}>{t.side}</span>
                    <div className="text-secondary" style={{ fontSize: 11 }}>
                      {money(t.balanceAtEntry)} → {money(t.balanceAfter)}
                    </div>
                  </span>
                  <span style={{ textAlign: 'right', color: t.pnl >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 800 }}>
                    {signed(t.pnl)}
                    <div className="text-secondary" style={{ fontSize: 11, fontWeight: 600 }}>{money(t.margin)} used</div>
                  </span>
                </button>
              ))}
              {ledger.trades.length > 8 && (
                <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${ledger.trades.length} trades`}
                </button>
              )}
            </div>
          )}
          {data.syncNote && <p className="form-hint" style={{ marginTop: 8 }}>PnL sync: {data.syncNote}</p>}
        </div>
      )}
    </>
  );
}
