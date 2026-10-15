'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch as fetch } from '../lib/apiFetch.js';

const inputStyle = {
  background: '#ffffff',
  border: '1px solid #cbd5e1',
  color: '#1d2939',
  borderRadius: 8,
  padding: '8px 10px',
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 13,
};

const tabStyle = (active) => ({
  padding: '8px 14px',
  border: 'none',
  cursor: 'pointer',
  background: active ? '#e8efff' : 'transparent',
  color: active ? '#2459c6' : '#526176',
  borderBottom: active ? '2px solid #326de6' : '2px solid transparent',
  fontWeight: active ? 600 : 400,
  fontSize: 13,
});

function fmt(n, d = 4) {
  if (n == null || Number.isNaN(+n)) return '—';
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: d,
  });
}


function KeysBar({ onSaved }) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const refreshInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/bybit');
      const j = await res.json();
      if (res.ok) {
        setInfo(j);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshInfo();
  }, [refreshInfo]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings/bybit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret, testnet: true }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: j.error || 'Save failed' });
        return;
      }
      setApiKey('');
      setApiSecret('');
      setMsg({ ok: true, text: j.msg || 'Keys saved' });
      await refreshInfo();
      onSaved?.();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        marginBottom: 14,
        padding: 12,
        background: '#f8fafc',
        borderRadius: 8,
        border: '1px solid #dce3ed',
      }}
    >
      <div style={{ fontSize: 12, color: '#526176', marginBottom: 8 }}>
        API keys · Contracts Orders/Positions · Unified Trade · Wallet transfer enabled on key.
        Withdraw stays OFF recommended.
        {info?.configured && (
          <span style={{ color: '#12805c' }}> · Linked {info.apiKeyMasked}</span>
        )}
        <span style={{ color: '#855b0a', marginLeft: 6 }}>· TESTNET ONLY</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            padding: '6px 10px',
            color: '#855b0a',
            background: '#fff7df',
            border: '1px solid #edd28a',
            borderRadius: 6,
          }}
        >
          Bybit TESTNET · enforced
        </span>
        <input
          style={inputStyle}
          placeholder="Testnet API Key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <input
          style={{ ...inputStyle, flex: '1 1 160px' }}
          type="password"
          placeholder="Testnet API Secret"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          autoComplete="off"
        />
        <button className="scan-btn" disabled={busy || !apiKey || !apiSecret} onClick={save}>
          {busy ? '…' : 'Save keys'}
        </button>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: '#526176' }}>
        Use API credentials created on testnet.bybit.com. Production endpoints cannot be selected.
      </div>
      {msg && (
        <div style={{ marginTop: 8, fontSize: 12, color: msg.ok ? '#12805c' : '#b4233c' }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

export default function BybitTradingDesk() {
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    qty: '',
    price: '',
    reduceOnly: false,
    takeProfit: '',
    stopLoss: '',
  });
  const [transfer, setTransfer] = useState({
    coin: 'USDT',
    amount: '',
    fromAccountType: 'UNIFIED',
    toAccountType: 'CONTRACT',
  });
  const [autoData, setAutoData] = useState(null);
  const [autoCfg, setAutoCfg] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/bybit/trading');
      const text = await res.text();
      let j = {};
      try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 120) || 'Bad response' }; }
      if (!res.ok) {
        setMsg({ ok: false, text: j.error || 'Load failed' });
        setData(null);
      } else {
        setData(j);
        setMsg(null);
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
    try {
      const ar = await fetch('/api/auto-trading');
      const text = await ar.text();
      let aj = {};
      try { aj = JSON.parse(text); } catch { aj = {}; }
      if (ar.ok && aj.config) {
        setAutoData(aj);
        setAutoCfg(aj.config || null);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (body) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/bybit/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: j.error || 'Action failed' });
        return;
      }
      setMsg({ ok: true, text: j.msg || 'OK' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const bal = data?.balance;

  return (
    <div className="card desk-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <h3 style={{ margin: 0, color: '#f7a600', letterSpacing: 0.5 }}>
          Bybit Trading Desk
        </h3>
        <button
          className="scan-btn"
          onClick={load}
          disabled={busy}
          style={{ padding: '4px 12px', fontSize: 12, background: '#2b3139' }}
        >
          Refresh
        </button>
      </div>

      <KeysBar onSaved={load} />

      <div className="desk-tabs">
        {['overview', 'auto', 'positions', 'orders', 'trade', 'wallet'].map((t) => (
          <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {msg && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 6,
            background: msg.ok ? 'rgba(14,203,129,0.12)' : 'rgba(246,70,93,0.12)',
            color: msg.ok ? '#0ecb81' : '#f6465d',
            fontSize: 13,
          }}
        >
          {msg.text}
        </div>
      )}

      {tab === 'overview' && (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
              marginBottom: 14,
            }}
          >
            {[
              ['Total Equity', bal?.totalEquity, 'USDT'],
              ['Wallet', bal?.totalWalletBalance, 'USDT'],
              ['Available', bal?.totalAvailableBalance, 'USDT'],
              ['Positions', data?.positions?.length ?? '—', ''],
              ['Open orders', data?.openOrders?.length ?? '—', ''],
            ].map(([label, val, unit]) => (
              <div
                key={label}
                style={{
                  background: '#1e2329',
                  borderRadius: 8,
                  padding: '12px 14px',
                  border: '1px solid #2b3139',
                }}
              >
                <div style={{ color: '#848e9c', fontSize: 11 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>
                  {typeof val === 'number' ? fmt(val) : val}{' '}
                  <span style={{ fontSize: 11, color: '#848e9c' }}>{unit}</span>
                </div>
              </div>
            ))}
          </div>
          {data?.balanceError && (
            <div style={{ color: '#f6465d', fontSize: 12 }}>{data.balanceError}</div>
          )}
          <p style={{ color: '#848e9c', fontSize: 12, margin: 0 }}>
            Permissions used: Unified/Contract trade · Positions · Orders · Wallet
            transfer (Wallet tab). Spot/Earn/Convert can be extended later with the
            same keys.
          </p>
        </div>
      )}

      {tab === 'positions' && (
        <div style={{ overflowX: 'auto' }}>
          {data?.positionsError && (
            <div style={{ color: '#f6465d', fontSize: 12 }}>{data.positionsError}</div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#848e9c', textAlign: 'left' }}>
                {['Symbol', 'Side', 'Size', 'Entry', 'Mark', 'uPnL', 'Lev', 'Liq'].map(
                  (h) => (
                    <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #2b3139' }}>
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {(data?.positions || []).length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 16, color: '#848e9c' }}>
                    No open positions
                  </td>
                </tr>
              )}
              {(data?.positions || []).map((p) => (
                <tr key={p.symbol + p.side}>
                  <td style={{ padding: '8px', borderBottom: '1px solid #1e2329' }}>
                    {p.symbol}
                  </td>
                  <td
                    style={{
                      padding: '8px',
                      color: p.side === 'Buy' ? '#0ecb81' : '#f6465d',
                    }}
                  >
                    {p.side}
                  </td>
                  <td style={{ padding: '8px' }}>{fmt(p.size, 6)}</td>
                  <td style={{ padding: '8px' }}>{fmt(p.avgPrice)}</td>
                  <td style={{ padding: '8px' }}>{fmt(p.markPrice)}</td>
                  <td
                    style={{
                      padding: '8px',
                      color: p.unrealisedPnl >= 0 ? '#0ecb81' : '#f6465d',
                    }}
                  >
                    {fmt(p.unrealisedPnl)}
                  </td>
                  <td style={{ padding: '8px' }}>{p.leverage}x</td>
                  <td style={{ padding: '8px' }}>{fmt(p.liqPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'orders' && (
        <div style={{ overflowX: 'auto' }}>
          <h4 style={{ color: '#eaecef', margin: '0 0 8px' }}>Open orders</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 20 }}>
            <thead>
              <tr style={{ color: '#848e9c', textAlign: 'left' }}>
                {['Symbol', 'Side', 'Type', 'Price', 'Qty', 'Status', ''].map((h) => (
                  <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #2b3139' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.openOrders || []).length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 16, color: '#848e9c' }}>
                    No open orders
                  </td>
                </tr>
              )}
              {(data?.openOrders || []).map((o) => (
                <tr key={o.orderId}>
                  <td style={{ padding: '8px' }}>{o.symbol}</td>
                  <td style={{ padding: '8px', color: o.side === 'Buy' ? '#0ecb81' : '#f6465d' }}>
                    {o.side}
                  </td>
                  <td style={{ padding: '8px' }}>{o.orderType}</td>
                  <td style={{ padding: '8px' }}>{fmt(o.price)}</td>
                  <td style={{ padding: '8px' }}>{fmt(o.qty, 6)}</td>
                  <td style={{ padding: '8px' }}>{o.orderStatus}</td>
                  <td style={{ padding: '8px' }}>
                    <button
                      className="scan-btn"
                      disabled={busy}
                      style={{ padding: '2px 8px', fontSize: 11, background: '#f6465d' }}
                      onClick={() =>
                        act({ action: 'cancel', symbol: o.symbol, orderId: o.orderId })
                      }
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ color: '#eaecef', margin: '0 0 8px' }}>Recent history</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#848e9c', textAlign: 'left' }}>
                {['Symbol', 'Side', 'Type', 'Avg', 'Qty', 'Status'].map((h) => (
                  <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #2b3139' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.history || []).slice(0, 15).map((o) => (
                <tr key={o.orderId + o.updatedTime}>
                  <td style={{ padding: '8px' }}>{o.symbol}</td>
                  <td style={{ padding: '8px' }}>{o.side}</td>
                  <td style={{ padding: '8px' }}>{o.orderType}</td>
                  <td style={{ padding: '8px' }}>{fmt(o.avgPrice || o.price)}</td>
                  <td style={{ padding: '8px' }}>{fmt(o.cumExecQty || o.qty, 6)}</td>
                  <td style={{ padding: '8px' }}>{o.orderStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'trade' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
            maxWidth: 520,
          }}
        >
          {[
            ['Symbol', 'symbol', 'text'],
            ['Side', 'side', 'select', ['Buy', 'Sell']],
            ['Type', 'orderType', 'select', ['Limit', 'Market']],
            ['Qty', 'qty', 'text'],
            ['Price', 'price', 'text'],
            ['Take profit', 'takeProfit', 'text'],
            ['Stop loss', 'stopLoss', 'text'],
          ].map(([label, key, type, opts]) => (
            <label key={key} style={{ fontSize: 12, color: '#848e9c' }}>
              {label}
              {type === 'select' ? (
                <select
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  style={{ ...inputStyle, marginTop: 4 }}
                >
                  {opts.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  style={{ ...inputStyle, marginTop: 4 }}
                  placeholder={key === 'price' && form.orderType === 'Market' ? 'N/A' : ''}
                  disabled={key === 'price' && form.orderType === 'Market'}
                />
              )}
            </label>
          ))}
          <label style={{ fontSize: 12, color: '#848e9c', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={form.reduceOnly}
              onChange={(e) => setForm({ ...form, reduceOnly: e.target.checked })}
            />
            Reduce only
          </label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <button
              className="scan-btn"
              disabled={busy}
              style={{
                flex: 1,
                background: form.side === 'Buy' ? '#0ecb81' : '#f6465d',
                color: '#0b0e11',
                fontWeight: 700,
              }}
              onClick={() =>
                act({
                  action: 'place',
                  symbol: form.symbol.toUpperCase(),
                  side: form.side,
                  orderType: form.orderType,
                  qty: form.qty,
                  price: form.orderType === 'Market' ? undefined : form.price,
                  reduceOnly: form.reduceOnly,
                  takeProfit: form.takeProfit || undefined,
                  stopLoss: form.stopLoss || undefined,
                })
              }
            >
              {form.side} {form.orderType}
            </button>
          </div>
        </div>
      )}


      {tab === 'auto' && autoCfg && (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
              marginBottom: 14,
            }}
          >
            {[
              ['BYBIT NETWORK', 'TESTNET ONLY', '#855b0a'],
              ['Entry condition', 'Entry hit required', '#326de6'],
              ['Margin %', autoCfg.marginPercent, '#eaecef'],
              ['Default lev', autoCfg.defaultLeverage + 'x', '#eaecef'],
              ['Max lev', autoCfg.maximumLeverage + 'x', '#eaecef'],
              ['Max positions', autoCfg.maxOpenPositions, '#eaecef'],
              ['Daily trades', autoCfg.maxDailyTrades, '#eaecef'],
              ['Daily loss %', autoCfg.maxDailyLossPercent, '#eaecef'],
              ['TP / SL', (autoCfg.tpEnabled ? 'ON' : 'OFF') + ' / ' + (autoCfg.slEnabled ? 'ON' : 'OFF'), '#eaecef'],
            ].map(([label, val, color]) => (
              <div
                key={label}
                style={{
                  background: '#f8fafc',
                  borderRadius: 8,
                  padding: '12px 14px',
                  border: '1px solid #dce3ed',
                }}
              >
                <div style={{ color: '#526176', fontSize: 11 }}>{label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color }}>{val}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            <button
              className={`scan-btn ${autoCfg.autoTradingEnabled ? 'danger-btn' : 'success-btn'}`}
              disabled={autoBusy}
              aria-pressed={!!autoCfg.autoTradingEnabled}
              onClick={async () => {
                setAutoBusy(true);
                await fetch('/api/auto-trading', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'toggle', enabled: !autoCfg.autoTradingEnabled }),
                });
                await load();
                setAutoBusy(false);
              }}
            >
              {autoCfg.autoTradingEnabled ? 'Auto Trade ON · Turn OFF' : 'Auto Trade OFF · Turn ON'}
            </button>
          </div>

          <h4 style={{ color: '#1d2939', margin: '0 0 8px' }}>Risk settings</h4>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 8,
              marginBottom: 12,
            }}
          >
            {[
              ['marginPercent', 'Margin %'],
              ['defaultLeverage', 'Default lev'],
              ['maximumLeverage', 'Max lev'],
              ['minimumLeverage', 'Min lev'],
              ['minimumScore', 'Min score'],
              ['maxOpenPositions', 'Max open'],
              ['maxDailyTrades', 'Max daily trades'],
              ['maxDailyLossPercent', 'Max daily loss %'],
              ['requireMinimumRR', 'Min RR'],
              ['atrLowPct', 'ATR% low'],
              ['atrMidPct', 'ATR% mid'],
              ['atrHighPct', 'ATR% high'],
              ['leverageMidVol', 'Lev mid vol'],
              ['leverageHighVol', 'Lev high vol'],
              ['leverageExtremeVol', 'Lev extreme'],
            ].map(([key, label]) => (
              <label key={key} style={{ fontSize: 11, color: '#526176' }}>
                {label}
                <input
                  type="number"
                  step="any"
                  value={autoCfg[key] ?? ''}
                  onChange={(e) =>
                    setAutoCfg({ ...autoCfg, [key]: e.target.value === '' ? '' : +e.target.value })
                  }
                  style={{ ...inputStyle, marginTop: 4 }}
                />
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12, fontSize: 12, color: '#eaecef' }}>
            {[
              ['volatilityAwareLeverage', 'Vol-aware lev'],
              ['tpEnabled', 'TP auto'],
              ['slEnabled', 'SL auto'],
              ['allowLong', 'Allow LONG'],
              ['allowShort', 'Allow SHORT'],
              ['moveSLToBreakevenAfterTP1', 'BE after TP1'],
            ].map(([key, label]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!autoCfg[key]}
                  onChange={(e) => setAutoCfg({ ...autoCfg, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          <button
            className="scan-btn"
            disabled={autoBusy}
            style={{ background: '#f7a600', color: '#0b0e11', marginBottom: 16 }}
            onClick={async () => {
              setAutoBusy(true);
              setMsg(null);
              try {
                const res = await fetch('/api/auto-trading', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'saveConfig', ...autoCfg }),
                });
                const j = await res.json();
                if (!res.ok) setMsg({ ok: false, text: j.error });
                else {
                  setMsg({ ok: true, text: j.msg });
                  setAutoCfg(j.config);
                }
              } catch (e) {
                setMsg({ ok: false, text: e.message });
              }
              setAutoBusy(false);
            }}
          >
            Save auto-trading settings
          </button>

          <h4 style={{ color: '#1d2939' }}>
            Open auto executions ({autoData?.openExecutions?.length || 0}) · {autoData?.environment || 'BYBIT TESTNET'}
          </h4>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#848e9c', textAlign: 'left' }}>
                  {['Symbol', 'Side', 'Score', 'Entry', 'Fill', 'Margin', 'Lev', 'Qty', 'SL', 'TP1', 'State', 'Order', 'Protection', ''].map(
                    (h) => (
                      <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #2b3139' }}>
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {(autoData?.openExecutions || []).length === 0 && (
                  <tr>
                    <td colSpan={14} style={{ padding: 12, color: '#526176' }}>
                      No auto executions yet — turn Auto Trade ON and wait for a valid Bybit entry condition.
                    </td>
                  </tr>
                )}
                {(autoData?.openExecutions || []).map((ex) => (
                  <tr key={ex.id}>
                    <td style={{ padding: 8 }}>{ex.symbol}</td>
                    <td style={{ padding: 8, color: ex.side === 'LONG' ? '#0ecb81' : '#f6465d' }}>{ex.side}</td>
                    <td style={{ padding: 8 }}>{ex.score}</td>
                    <td style={{ padding: 8 }}>{fmt(ex.signal_entry)}</td>
                    <td style={{ padding: 8 }}>{fmt(ex.actual_entry)}</td>
                    <td style={{ padding: 8 }}>{fmt(ex.margin, 2)}</td>
                    <td style={{ padding: 8 }}>{ex.leverage}x</td>
                    <td style={{ padding: 8 }}>{fmt(ex.quantity, 6)}</td>
                    <td style={{ padding: 8 }}>{fmt(ex.sl)}</td>
                    <td style={{ padding: 8 }}>{fmt(ex.tp1)}</td>
                    <td style={{ padding: 8 }}>
                      {ex.status}
                      {ex.dry_run ? ' · legacy paper' : ''}
                      {ex.status === 'UNPROTECTED' ? ' ⚠' : ''}
                    </td>
                    <td style={{ padding: 8 }}>
                      {ex.metadata?.bybitOrderStatus || ex.metadata?.orderStatus || '—'}
                    </td>
                    <td
                      style={{
                        padding: 8,
                        color:
                          ex.metadata?.protectionStatus === 'PROTECTED'
                            ? '#0ecb81'
                            : ['PROTECTION_FAILED', 'VERIFY_UNKNOWN'].includes(
                                ex.metadata?.protectionStatus
                              )
                              ? '#f6465d'
                              : '#848e9c',
                      }}
                    >
                      {ex.metadata?.protectionStatus || '—'}
                    </td>
                    <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                      <button
                        className="scan-btn"
                        style={{ padding: '2px 6px', fontSize: 10, marginRight: 4, background: '#2b3139' }}
                        disabled={autoBusy}
                        onClick={async () => {
                          setAutoBusy(true);
                          await fetch('/api/auto-trading', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'breakeven', id: ex.id }),
                          });
                          await load();
                          setAutoBusy(false);
                        }}
                      >
                        BE
                      </button>
                      <button
                        className="scan-btn danger-btn"
                        style={{ padding: '2px 6px', fontSize: 10, background: '#f6465d' }}
                        disabled={autoBusy}
                        onClick={async () => {
                          if (!confirm('Close position?')) return;
                          setAutoBusy(true);
                          await fetch('/api/auto-trading', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'close', id: ex.id }),
                          });
                          await load();
                          setAutoBusy(false);
                        }}
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: '#526176', fontSize: 12, marginTop: 12 }}>
            Flow: Cron scan → validated entry condition → Auto Trade switch → existing risk sizing → Bybit TESTNET order → TP/SL.
            Auto Trade OFF places no automated signal order.
          </p>
        </div>
      )}

      {tab === 'wallet' && (
        <div>
          <h4 style={{ color: '#eaecef', marginTop: 0 }}>Balances</h4>
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#848e9c', textAlign: 'left' }}>
                  {['Coin', 'Equity', 'Wallet', 'Available', 'USD'].map((h) => (
                    <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #2b3139' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(bal?.coins || []).map((c) => (
                  <tr key={c.coin}>
                    <td style={{ padding: '8px' }}>{c.coin}</td>
                    <td style={{ padding: '8px' }}>{fmt(c.equity, 6)}</td>
                    <td style={{ padding: '8px' }}>{fmt(c.wallet, 6)}</td>
                    <td style={{ padding: '8px' }}>{fmt(c.available, 6)}</td>
                    <td style={{ padding: '8px' }}>{fmt(c.usdValue, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4 style={{ color: '#eaecef' }}>Internal transfer</h4>
          <p style={{ color: '#848e9c', fontSize: 12 }}>
            Needs Wallet → Account Transfer permission. Account types e.g. UNIFIED,
            CONTRACT, SPOT, FUND.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 8,
              maxWidth: 560,
            }}
          >
            {['coin', 'amount', 'fromAccountType', 'toAccountType'].map((k) => (
              <label key={k} style={{ fontSize: 12, color: '#848e9c' }}>
                {k}
                <input
                  value={transfer[k]}
                  onChange={(e) => setTransfer({ ...transfer, [k]: e.target.value })}
                  style={{ ...inputStyle, marginTop: 4 }}
                />
              </label>
            ))}
            <button
              className="scan-btn"
              disabled={busy}
              style={{ alignSelf: 'end', background: '#f7a600', color: '#0b0e11' }}
              onClick={() => act({ action: 'transfer', ...transfer })}
            >
              Transfer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
