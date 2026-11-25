'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const ALL_TFS = ['15m', '30m', '1h', '2h', '4h', '6h'];

const post = (body) =>
  fetch('/api/sp-abcd-scan', {
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
 * Admin card: SP Breaker + AB=CD — separate from Harmonic.
 * Shares only coin-universe scanning pattern (chunked).
 */
export function SpAbcdCard() {
  const [tfs, setTfs] = useState(['15m', '1h', '4h']);
  const [slBufferATR, setSlBufferATR] = useState(0.15);
  const [minScore, setMinScore] = useState(50);
  const [chunkSize, setChunkSize] = useState(8);
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
        if (c.slBufferATR != null) setSlBufferATR(+c.slBufferATR);
        if (c.minScore != null) setMinScore(+c.minScore);
      })
      .catch(() => {});
  }, []);

  const saveCfg = async () => {
    try {
      await post({
        action: 'save_config',
        config: {
          timeframes: tfs,
          slBufferATR,
          minScore,
          enabled: true,
        },
      });
      setMsg('SP AB=CD settings saved');
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
      await saveCfg();
      const uni = await post({ action: 'universe', mode: 'all', ranking: 'volume' });
      const symbols = uni.symbols || [];
      if (!symbols.length) throw new Error(uni.error || 'No symbols in universe');
      const chunk = Math.max(2, Math.min(20, chunkSize));
      const all = [];
      for (let i = 0; i < symbols.length; i += chunk) {
        if (stopRef.current) break;
        const slice = symbols.slice(i, i + chunk);
        setProgress({ done: i, total: symbols.length, found: all.length });
        const d = await post({
          action: 'analyze',
          symbols: slice,
          tfs,
          config: { slBufferATR, minScore, timeframes: tfs },
          autoSave: true,
          klineLimit: 400,
        });
        if (Array.isArray(d.items)) all.push(...d.items);
        setItems([...all]);
        await new Promise((r) => setTimeout(r, 400));
      }
      setProgress({ done: symbols.length, total: symbols.length, found: all.length });
      setMsg(
        stopRef.current
          ? `Stopped · ${all.length} SP AB=CD setups`
          : `Done · ${all.length} SP AB=CD setups (saved to Scanner board)`
      );
    } catch (e) {
      setMsg(e.message || 'Scan failed');
    }
    setBusy(false);
  }, [tfs, slBufferATR, minScore, chunkSize]);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title" style={{ marginBottom: 4 }}>
        SP Breaker + AB=CD
      </div>
      <p className="card-subtitle" style={{ marginBottom: 12, fontSize: 13 }}>
        Separate strategy (not Harmonic). Uses the same coin universe / chunk scan. Trend = EMA200.
        SP breaker from AB/BC touched by C. Entry at breaker edge; SL past opposite edge.
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 10, marginBottom: 12 }}>
        <label style={{ fontSize: 12 }}>
          SL buffer (ATR)
          <input
            className="form-input"
            type="number"
            step="0.05"
            min={0}
            max={2}
            value={slBufferATR}
            onChange={(e) => setSlBufferATR(+e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Min score
          <input
            className="form-input"
            type="number"
            min={0}
            max={100}
            value={minScore}
            onChange={(e) => setMinScore(+e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Chunk size
          <input
            className="form-input"
            type="number"
            min={2}
            max={20}
            value={chunkSize}
            onChange={(e) => setChunkSize(+e.target.value)}
          />
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <button type="button" className="btn btn-primary" disabled={busy || !tfs.length} onClick={scanAll}>
          {busy ? 'Scanning…' : 'Scan all coins (SP AB=CD)'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={!busy} onClick={() => { stopRef.current = true; }}>
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
          {items.slice(0, 40).map((e) => (
            <div
              key={e.id}
              style={{
                borderTop: '1px solid rgba(128,128,128,0.15)',
                padding: '8px 0',
                fontSize: 12,
              }}
            >
              <b>{String(e.symbol || '').replace(/USDT$/, '')}/USDT</b> · {String(e.tf || '').toUpperCase()}{' '}
              <span style={{ color: e.direction === 'LONG' ? '#16A34A' : '#DC2626', fontWeight: 700 }}>
                {e.direction}
              </span>{' '}
              · {e.status} · score {e.score} · trend {e.trend}
              <div style={{ opacity: 0.8, marginTop: 2 }}>
                Entry {fmtP(e.entry)} · SL {fmtP(e.sl)} · TP1 {fmtP(e.tp1)} · CD/AB {e.ratios?.cdAb ?? '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SpAbcdCard;
