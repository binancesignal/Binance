'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const ALL_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h'];

const post = (body) =>
  fetch('/api/abcd-sp-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  });

function fmtP(p) {
  if (p == null || !Number.isFinite(+p)) return '—';
  const a = Math.abs(+p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6;
  return (+p).toFixed(dp);
}

/**
 * Admin: ABCD + SP breaker as its own strategy (not a Harmonic checkbox).
 * Logic is the same findAbcdSpEvents implementation — only the UI / scan entry point is separate.
 * Coin universe + chunks match Harmonic Patterns.
 */
export function AbcdSpCard() {
  const [tfs, setTfs] = useState(['15m', '1h', '4h']);
  const [stopBufferAtr, setStopBufferAtr] = useState(0.25);
  const [minLegAtr, setMinLegAtr] = useState(0.8);
  const [swingLeft, setSwingLeft] = useState(5);
  const [swingRight, setSwingRight] = useState(5);
  const [chunkSize, setChunkSize] = useState(6);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [msg, setMsg] = useState('');
  const stopRef = useRef(false);

  useEffect(() => {
    post({ action: 'get_config' })
      .then((d) => {
        const c = d.config || {};
        if (Array.isArray(c.timeframes) && c.timeframes.length) setTfs(c.timeframes);
        if (c.stopBufferAtr != null) setStopBufferAtr(+c.stopBufferAtr);
        if (c.minLegAtr != null) setMinLegAtr(+c.minLegAtr);
        if (c.swingLeft != null) setSwingLeft(+c.swingLeft);
        if (c.swingRight != null) setSwingRight(+c.swingRight);
      })
      .catch(() => {});
  }, []);

  const cfgPayload = () => ({
    timeframes: tfs,
    stopBufferAtr,
    minLegAtr,
    swingLeft,
    swingRight,
  });

  const saveCfg = async () => {
    try {
      await post({ action: 'save_config', config: cfgPayload() });
      setMsg('ABCD + SP breaker settings saved');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const toggleTf = (tf) => {
    setTfs((prev) => (prev.includes(tf) ? prev.filter((x) => x !== tf) : [...prev, tf]));
  };

  const scanAll = useCallback(async () => {
    stopRef.current = false;
    setBusy(true);
    setMsg('');
    setItems([]);
    try {
      await post({ action: 'save_config', config: cfgPayload() });
      const uni = await post({ action: 'universe', mode: 'all', ranking: 'volume' });
      const symbols = uni.symbols || [];
      if (!symbols.length) throw new Error(uni.error || 'No symbols in universe');
      const chunk = Math.max(2, Math.min(12, chunkSize));
      const all = [];
      let patternsSeen = 0;
      let sampleNote = '';
      for (let i = 0; i < symbols.length; i += chunk) {
        if (stopRef.current) break;
        const slice = symbols.slice(i, i + chunk);
        setProgress({ done: i, total: symbols.length, found: all.length });
        const d = await post({
          action: 'analyze',
          symbols: slice,
          tfs,
          config: cfgPayload(),
          autoSave: true,
          klineLimit: 400,
        });
        if (Array.isArray(d.items)) all.push(...d.items);
        if (d.diag?.patterns) patternsSeen += d.diag.patterns;
        if (!sampleNote && d.diag?.sample?.length) {
          sampleNote = d.diag.sample
            .slice(0, 3)
            .map((s) => `${s.symbol} ${s.tf}: ${s.patterns} ABCD`)
            .join(' · ');
        }
        setItems([...all]);
        await new Promise((r) => setTimeout(r, 350));
      }
      setProgress({ done: symbols.length, total: symbols.length, found: all.length });
      const base = stopRef.current
        ? `Stopped · ${all.length} ABCD+SP setups`
        : `Done · ${all.length} ABCD+SP setups (saved to Scanner)`;
      setMsg(
        all.length
          ? base
          : `${base}. Raw ABCD patterns seen: ${patternsSeen}.${sampleNote ? ' e.g. ' + sampleNote : ''} If patterns>0 but setups=0, trend/SP filters removed them — try lower Min AB leg.`
      );
    } catch (e) {
      setMsg(e.message || 'Scan failed');
    }
    setBusy(false);
  }, [tfs, stopBufferAtr, minLegAtr, swingLeft, swingRight, chunkSize]);

  return (
    <div className="card" style={{ marginBottom: 16, borderTop: '3px solid #7c3aed' }}>
      <div className="card-title" style={{ marginBottom: 4 }}>
        ABCD + SP breaker
      </div>
      <p className="card-subtitle" style={{ marginBottom: 12, fontSize: 13 }}>
        Separate strategy (not under Harmonic). Same coin universe &amp; chunks as Harmonic scan. Logic: EMA200 trend ·
        upward ABCD in downtrend → LONG at SP top · downward ABCD in uptrend → SHORT at SP bottom · SP origin on AB/BC,
        touches C, born ≤ C.
      </p>

      <div style={{ fontWeight: 600, marginBottom: 6 }}>Timeframes</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {ALL_TFS.map((tf) => (
          <button
            key={tf}
            type="button"
            className={tfs.includes(tf) ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => toggleTf(tf)}
            style={tfs.includes(tf) ? { background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' } : undefined}
          >
            {tf}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <label style={{ fontSize: 12 }}>
          Stop buffer (×ATR)
          <input
            className="form-input"
            type="number"
            step="0.05"
            min={0}
            max={5}
            value={stopBufferAtr}
            onChange={(e) => setStopBufferAtr(+e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Min AB leg (×ATR)
          <input
            className="form-input"
            type="number"
            step="0.1"
            min={0}
            max={20}
            value={minLegAtr}
            onChange={(e) => setMinLegAtr(+e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Swing left
          <input
            className="form-input"
            type="number"
            min={1}
            max={20}
            value={swingLeft}
            onChange={(e) => setSwingLeft(+e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Swing right
          <input
            className="form-input"
            type="number"
            min={1}
            max={20}
            value={swingRight}
            onChange={(e) => setSwingRight(+e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Chunk size
          <input
            className="form-input"
            type="number"
            min={2}
            max={12}
            value={chunkSize}
            onChange={(e) => setChunkSize(+e.target.value)}
          />
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <button type="button" className="btn btn-primary" disabled={busy || !tfs.length} onClick={scanAll}>
          {busy ? 'Scanning…' : 'Scan all coins (ABCD + SP)'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!busy}
          onClick={() => {
            stopRef.current = true;
          }}
        >
          Stop
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={saveCfg}>
          Save settings
        </button>
      </div>

      {progress && (
        <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.8 }}>
          Progress {progress.done}/{progress.total} · found {progress.found}
        </div>
      )}
      {msg && <div style={{ fontSize: 13, marginBottom: 10 }}>{msg}</div>}

      {items.length > 0 && (
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          {items.slice(0, 50).map((e) => (
            <div
              key={e.id || `${e.symbol}-${e.tf}-${e.direction}-${e.index}`}
              style={{ borderTop: '1px solid rgba(128,128,128,0.15)', padding: '8px 0', fontSize: 12 }}
            >
              <b>{String(e.symbol || '').replace(/USDT$/, '')}/USDT</b> · {String(e.tf || '').toUpperCase()}{' '}
              <span style={{ color: e.direction === 'LONG' ? '#16A34A' : '#DC2626', fontWeight: 700 }}>
                {e.direction}
              </span>{' '}
              · {e.status} · score {e.score}
              {e.trend ? ` · trend ${e.trend}` : ''}
              <div style={{ opacity: 0.8, marginTop: 2 }}>
                Entry {fmtP(e.plan?.entry ?? e.entry)} · SL {fmtP(e.plan?.sl ?? e.sl)} · TP1{' '}
                {fmtP(e.plan?.tp1 ?? e.tp1)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AbcdSpCard;
