'use client';

import { useCallback, useEffect, useState } from 'react';

const COIN_COLORS = ['#F7931A', '#627EEA', '#26A17B', '#F0B90B', '#8247E5', '#E84142', '#00AEEF', '#16C784'];
const baseOf = (s) => String(s || '').toUpperCase().replace(/(USDT|USDC|BUSD|USD)$/, '');

function Coin({ symbol, size = 34 }) {
  const base = baseOf(symbol);
  const lower = base.toLowerCase();
  const src = [
    `https://assets.coincap.io/assets/icons/${lower}@2x.png`,
    `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${lower}.png`,
  ];
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [lower]);
  if (i >= src.length || !lower) {
    let h = 0;
    for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (
      <span
        style={{
          width: size, height: size, borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
          justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: size * 0.42,
          background: COIN_COLORS[h % COIN_COLORS.length], flexShrink: 0,
        }}
      >
        {base.slice(0, 1)}
      </span>
    );
  }
  return <img src={src[i]} alt="" width={size} height={size} style={{ borderRadius: '50%', flexShrink: 0 }} onError={() => setI((n) => n + 1)} />;
}

const px = (n) => {
  if (n == null || Number.isNaN(+n)) return '—';
  const a = Math.abs(+n);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 6 : 7;
  return (+n).toFixed(d);
};
const money = (n, d = 2) => (n == null || Number.isNaN(+n) ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const when = (iso) => {
  if (!iso) return '';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString();
};
const ago = (iso) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const STATUS = {
  PENDING: { label: 'Placing…', tone: '#f0b90b' },
  PLACING: { label: 'Placing…', tone: '#f0b90b' },
  PLACED: { label: 'Limit order waiting', tone: '#f0b90b' },
  WAITING_FILL: { label: 'Limit order waiting', tone: '#f0b90b' },
  VERIFY_UNKNOWN: { label: 'Not verified ⚠️', tone: '#f59e0b' },
  PROTECTING: { label: 'In trade · setting SL/TP', tone: '#0ecb81' },
  FILLED: { label: 'In trade', tone: '#0ecb81' },
  PROTECTED: { label: 'In trade · SL/TP set ✅', tone: '#0ecb81' },
  UNPROTECTED: { label: 'In trade · NO SL/TP ⚠️', tone: '#f6465d' },
  PARTIALLY_FILLED: { label: 'Partly filled', tone: '#0ecb81' },
  SKIPPED: { label: 'Not placed', tone: '#f6465d' },
  FAILED: { label: 'Failed', tone: '#f6465d' },
  REJECTED: { label: 'Rejected', tone: '#f6465d' },
  CANCELLED: { label: 'Cancelled', tone: '#94a3b8' },
  CANCELED: { label: 'Cancelled', tone: '#94a3b8' },
};

const SIGNAL_LABEL = {
  ENTRY_READY: 'Entry ready', WATCHING: 'Watching', WAITING: 'Waiting', IN_TRADE: 'In trade', SL_HIT: 'SL hit',
  TP1_HIT: 'TP1 hit', TP2_HIT: 'TP2 hit', TP3_HIT: 'TP3 hit', MISSED: 'Missed', INVALIDATED: 'Invalidated', FORMED: 'Formed',
};

function Cell({ k, v, tone, wide }) {
  return (
    <div style={{ background: 'var(--surface-2, rgba(128,128,128,.08))', borderRadius: 10, padding: '6px 9px', gridColumn: wide ? 'span 2' : undefined, minWidth: 0 }}>
      <div style={{ fontSize: 10.5, opacity: 0.65 }}>{k}</div>
      <div style={{ fontWeight: 700, fontSize: 13, color: tone, overflowWrap: 'anywhere' }}>{v}</div>
    </div>
  );
}

function OrderCard({ o }) {
  const [open, setOpen] = useState(o.group === 'problem');
  const st = STATUS[o.status] || { label: o.status, tone: '#94a3b8' };
  const isLong = o.side === 'LONG' || o.side === 'BUY';
  const sig = o.signal;
  const hit = sig?.tpLevel || 0;
  const bad = o.group === 'problem';
  return (
    <div className="card" style={{ padding: 12, marginBottom: 10, borderRadius: 16, borderLeft: `4px solid ${st.tone}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Coin symbol={o.symbol} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>
            {baseOf(o.symbol)}<small style={{ opacity: 0.6, fontWeight: 600 }}>/USDT</small>{' '}
            <span className={`chip ${isLong ? 'chip-long' : 'chip-short'}`}>{isLong ? 'Buy / Long' : 'Sell / Short'}</span>
          </div>
          <div style={{ fontSize: 11.5, opacity: 0.7 }}>
            {[o.orderType, o.pattern && String(o.pattern).replace(/_/g, ' '), o.tf && String(o.tf).toUpperCase(), o.score != null && `Score ${Math.round(o.score)}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: st.tone, textAlign: 'right' }}>{st.label}</span>
      </div>

      {sig && (
        <div style={{ marginTop: 8, fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span className="chip chip-muted">Signal: {SIGNAL_LABEL[sig.status] || sig.status}</span>
          {sig.price != null && (
            <span className="chip chip-muted">
              Market {px(sig.price)}
              {sig.distancePct != null && ` (${sig.distancePct > 0 ? '+' : ''}${sig.distancePct.toFixed(2)}% vs entry)`}
            </span>
          )}
          {[1, 2, 3].map((n) => (
            <span key={n} className="chip chip-muted" style={hit >= n ? { background: 'rgba(14,203,129,.18)', color: '#0ecb81', fontWeight: 800 } : undefined}>
              TP{n}{hit >= n ? ' ✅' : ''}
            </span>
          ))}
          {o.status === 'SKIPPED' && o.signal?.status && null}
        </div>
      )}

      {o.reason && (
        <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: bad || o.status === 'UNPROTECTED' ? '#f6465d' : '#f59e0b', lineHeight: 1.4 }}>
          {bad ? 'Why: ' : 'Note: '}{o.reason}
        </div>
      )}
      {o.replaces && (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
          🔁 Replaced the order on <b>{baseOf(o.replaces.symbol)}</b> (score {o.replaces.score ?? '—'}) — this signal has the higher score.
        </div>
      )}

      <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide details' : 'Show all details'}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 6 }}>
            <Cell k="Signal entry" v={px(o.entry)} />
            <Cell k={o.orderType === 'MARKET' ? 'Order type' : 'Limit price'} v={o.orderType === 'MARKET' ? 'MARKET' : px(o.limitPrice ?? o.entry)} />
            {o.actualEntry != null && <Cell k="Filled at" v={px(o.actualEntry)} tone="#0ecb81" />}
            <Cell k="Stop loss" v={px(o.sl)} tone="#f6465d" />
            <Cell k="TP1" v={`${px(o.tp1)}${hit >= 1 ? ' ✅' : ''}`} tone="#0ecb81" />
            <Cell k="TP2" v={`${px(o.tp2)}${hit >= 2 ? ' ✅' : ''}`} tone="#0ecb81" />
            <Cell k="TP3" v={`${px(o.tp3)}${hit >= 3 ? ' ✅' : ''}`} tone="#0ecb81" />
            <Cell k="Quantity" v={o.qty ?? '—'} />
            <Cell k="Position size" v={o.notional != null ? `$${money(o.notional)}` : '—'} />
            <Cell k="Margin" v={o.margin != null ? `$${money(o.margin)}` : '—'} />
            <Cell k="Leverage" v={o.leverage != null ? `${o.leverage}x${o.maxLeverage ? ` (max ${o.maxLeverage}x)` : ''}` : '—'} />
            {o.przLow != null && o.przHigh != null && <Cell k="D zone" v={`${px(o.przLow)} – ${px(o.przHigh)}`} wide />}
            {o.orderId && <Cell k="Binance order ID" v={o.orderId} />}
            {o.environment && <Cell k="Account" v={o.environment} />}
            {o.attempts > 1 && <Cell k="Attempts" v={o.attempts} />}
            <Cell k="Created" v={when(o.createdAt)} wide />
            {o.filledAt && <Cell k="Filled" v={when(o.filledAt)} wide />}
          </div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6, wordBreak: 'break-all' }}>Signal: {String(o.signalId || '').slice(0, 80)}</div>
          {o.events?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, opacity: 0.75, marginBottom: 4 }}>History</div>
              {[...o.events].reverse().map((ev, i) => (
                <div key={i} style={{ fontSize: 11.5, lineHeight: 1.45, opacity: 0.9 }}>
                  <span style={{ opacity: 0.6 }}>{when(ev.at)} · </span>
                  {ev.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const QUEUE_TONE = { ORDER_PLACED: '#f0b90b', IN_TRADE: '#0ecb81', NEXT: '#3b82f6', QUEUED: '#94a3b8', SKIPPED: '#f6465d', FAILED: '#f6465d', REJECTED: '#f6465d' };
const QUEUE_LABEL = { ORDER_PLACED: 'Order placed', IN_TRADE: 'In trade', NEXT: 'Placing next', QUEUED: 'Queued (lower score)', SKIPPED: 'Not placed', FAILED: 'Failed', REJECTED: 'Rejected' };

/**
 * Auto-trade orders of the signed-in user — refreshes itself every few seconds from the database
 * (no Binance call), so a new limit order / replacement / fill / failure appears without reloading.
 */
export default function AutoOrdersPanel({ refreshMs = 3000, onOpenTrade }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/user/auto-orders', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d);
      setErr('');
      setTick(Date.now());
    } catch (e) {
      setErr(e.message || 'Could not load orders');
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      load();
    }, Math.max(2000, refreshMs));
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, refreshMs]);

  const orders = data?.orders || [];
  const pending = orders.filter((o) => o.group === 'pending');
  const running = orders.filter((o) => o.group === 'running');
  const problems = orders.filter((o) => o.group === 'problem');
  const queue = (data?.queue || []).filter((q) => q.state !== 'IN_TRADE');
  const cfg = data?.config;
  const last = data?.lastRun;

  return (
    <>
      <div className="flex-between" style={{ margin: '18px 2px 6px', alignItems: 'flex-end' }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>Auto-trade orders</div>
          <div className="text-secondary" style={{ fontSize: 11.5, marginTop: 2 }}>
            Live · updates every {Math.round(refreshMs / 1000)}s{tick ? ` · ${new Date(tick).toLocaleTimeString()}` : ''}
            {cfg ? ` · ${cfg.orderType || 'Limit'} · ${cfg.maxPendingLimitOrders} waiting order${cfg.maxPendingLimitOrders > 1 ? 's' : ''} max` : ''}
          </div>
        </div>
        <span className="chip chip-muted">{pending.length} waiting · {running.length} in trade</span>
      </div>

      {err && <div className="warn-box" style={{ marginBottom: 8 }}>{err} — showing last data.</div>}
      {(data?.blockers || []).length > 0 && (
        <div className="warn-box" style={{ marginBottom: 8 }}>
          <b>Orders will NOT be placed because:</b>
          {onOpenTrade && (
            <div style={{ margin: '8px 0' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={onOpenTrade}>
                Open Auto-Trade settings →
              </button>
              <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>
                There: switch ON the Binance toggle (Auto-trade exchange) and confirm High Risk (Risk mode card).
              </div>
            </div>
          )}
          {data.blockers.map((b, i) => (
            <div key={i}>· {b}</div>
          ))}
          {data.blockerDebug && (
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.8 }}>
              Server sees account <b>{data.blockerDebug.account}</b>: auto-trade={String(data.blockerDebug.stored?.autoTradingEnabled)} · exchange={String(data.blockerDebug.stored?.autoTradeExchange)} · risk mode={String(data.blockerDebug.stored?.riskMode)}
            </div>
          )}
        </div>
      )}
      {last?.blocked && (
        <div className="warn-box" style={{ marginBottom: 8 }}>Last bot run could not trade: {last.blocked}</div>
      )}

      {queue.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 10, borderRadius: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 6 }}>Entry-ready queue (best score gets the order)</div>
          {queue.map((q) => (
            <div key={q.signalId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid rgba(128,128,128,.12)' }}>
              <Coin symbol={q.symbol} size={24} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {baseOf(q.symbol)} <span style={{ opacity: 0.6, fontWeight: 600 }}>{q.direction === 'SHORT' ? '▼' : '▲'} · Score {Math.round(q.score)}{q.tf ? ` · ${String(q.tf).toUpperCase()}` : ''}</span>
                </div>
                {q.note && q.state !== 'ORDER_PLACED' && <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.35 }}>{q.note}</div>}
              </div>
              <span style={{ fontSize: 11, fontWeight: 800, color: QUEUE_TONE[q.state] || '#94a3b8', whiteSpace: 'nowrap' }}>{QUEUE_LABEL[q.state] || q.state}</span>
            </div>
          ))}
        </div>
      )}

      {data && orders.length === 0 && (
        <div className="card" style={{ fontSize: 13, color: 'var(--text-secondary)', padding: 14, borderRadius: 16 }}>
          No auto-trade orders yet. When a signal becomes ENTRY READY the bot places a limit order here; if it cannot, the reason is shown.
        </div>
      )}

      {pending.map((o) => <OrderCard key={o.id} o={o} />)}
      {running.map((o) => <OrderCard key={o.id} o={o} />)}
      {problems.length > 0 && (
        <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.75, margin: '12px 2px 6px' }}>Not placed / cancelled · {problems.length}</div>
      )}
      {problems.map((o) => <OrderCard key={o.id} o={o} />)}

      {last && (
        <div className="card" style={{ padding: 12, marginTop: 4, borderRadius: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4 }}>Last bot run · {ago(last.at)}</div>
          <div className="text-secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
            Ready signals {last.readyCount ?? 0}
            {last.sync ? ` · checked ${last.sync.checked} order(s), ${last.sync.filled} filled, ${last.sync.cancelled} cancelled` : ''}
            {(last.cancelled || []).map((c, i) => (
              <div key={`c${i}`}>🔁 {baseOf(c.symbol)}: {c.reason}</div>
            ))}
            {(last.outcomes || []).map((x, i) => (
              <div key={`o${i}`} style={{ color: x.status === 'PLACED' ? '#0ecb81' : '#f6465d' }}>
                {x.status === 'PLACED' ? '✅' : '⚠️'} {baseOf(x.symbol)} (score {Math.round(x.score)}): {x.status === 'PLACED' ? 'limit order placed' : x.reason || x.status}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
