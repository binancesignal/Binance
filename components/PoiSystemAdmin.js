'use client';

import { useCallback, useEffect, useState } from 'react';

async function api(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const Grid = ({ children }) => <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 12 }}>{children}</div>;
function Num({ label, k, cfg, set, step = 1 }) {
  return (
    <label style={{ display: 'block', fontSize: 12.5 }}>
      <span style={{ color: '#475569' }}>{label}</span>
      <input type="number" className="cs-input" step={step} style={{ width: '100%', marginTop: 2 }} value={cfg[k] ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? '' : +e.target.value })} />
    </label>
  );
}
function Sel({ label, k, cfg, set, opts }) {
  return (
    <label style={{ display: 'block', fontSize: 12.5 }}>
      <span style={{ color: '#475569' }}>{label}</span>
      <select className="cs-input" style={{ width: '100%', marginTop: 2 }} value={cfg[k]} onChange={(e) => set({ [k]: e.target.value })}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
function Chk({ label, k, cfg, set }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
      <input type="checkbox" checked={!!cfg[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      {label}
    </label>
  );
}
const WEIGHT_LABELS = {
  htfStrong: '1D + 4H agree', htfPartial: 'Only 4H agrees', htfConflict: '4H conflicts (negative)',
  locationExtreme: 'POI in extreme discount / premium', locationSide: 'POI on correct side of 50 %', locationWrong: 'POI on wrong side (negative)',
  fresh: 'Fresh / unmitigated', mitigated: 'Mitigated once', obQuality: 'OB displacement + structure break', fvgOverlap: 'FVG overlaps OB',
  doubleOb: 'Double order block', sweepRejected: 'Sweep + rejection', sweepOnly: 'Sweep (no rejection yet)', mss: '15M MSS confirmation', bos: '15M BOS only',
  orderFlow: '1H internal order flow', liquidityTarget: 'Open liquidity target', midTfSource: 'Zone from 4H / 1H / 30M',
};

/** Admin → ICT / SMC POI: every setting is validated server-side and read by the real scanner. */
export default function PoiSystemAdmin() {
  const [cfg, setCfg] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api('/api/poi-system');
      setCfg(d.config);
      setDefaults(d.defaults);
      setDirty(false);
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!cfg) return <div className="admin-section"><div className="card-subtitle">{msg?.text || 'Loading…'}</div></div>;
  const set = (patch) => { setCfg((c) => ({ ...c, ...patch })); setDirty(true); };
  const setW = (k, v) => { setCfg((c) => ({ ...c, weights: { ...c.weights, [k]: v === '' ? '' : +v } })); setDirty(true); };
  const save = async (body) => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api('/api/poi-system', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: body || cfg }) });
      setCfg(d.config);
      setDirty(false);
      setMsg({ ok: true, text: d.notes?.length ? `Saved. ${d.notes.join(' ')}` : 'Saved — the scanner uses these values on the next scan.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const card = { marginBottom: 14 };
  return (
    <div className="admin-section">
      <p className="card-subtitle" style={{ marginBottom: 12 }}>
        ICT / SMC PROBABILITY-BASED POI — independent strategy (paper / analysis only). 1D + 4H structure → 1H + 30M zones → 15M confirmation. A+ / B / C are setup-quality classes, not win probabilities.
      </p>
      <div className="card" style={card}>
        <Chk label="Strategy enabled" k="enabled" cfg={cfg} set={set} />
        <div className="card-subtitle">Timeframes are fixed by the method: 1D · 4H (bias) → 1H · 30M (zones) → 15M (confirmation).</div>
      </div>
      <div className="card" style={card}>
        <div className="card-title" style={{ marginBottom: 8 }}>Detection</div>
        <Grid>
          <Sel label="Swing sensitivity" k="swingSensitivity" cfg={cfg} set={set} opts={[['low', 'Low (5 bars)'], ['medium', 'Medium (3 bars)'], ['high', 'High (2 bars)']]} />
          <Sel label="Liquidity (equal H/L) sensitivity" k="liquiditySensitivity" cfg={cfg} set={set} opts={[['low', 'Loose (0.25 ATR)'], ['medium', 'Medium (0.15 ATR)'], ['high', 'Tight (0.08 ATR)']]} />
          <Sel label="BOS confirmation" k="bosConfirm" cfg={cfg} set={set} opts={[['close', 'Candle close'], ['wick', 'Wick']]} />
          <Sel label="MSS confirmation" k="mssConfirm" cfg={cfg} set={set} opts={[['close', 'Candle close'], ['wick', 'Wick']]} />
          <Num label="Extra closed candles that must hold" k="confirmCloseBars" cfg={cfg} set={set} />
          <Sel label="Order block invalidated by" k="obMitigation" cfg={cfg} set={set} opts={[['close', 'Close beyond the OB'], ['wick', 'Wick beyond the OB']]} />
          <Num label="OB min displacement (ATR)" k="obMinDisplacementAtr" cfg={cfg} set={set} step={0.1} />
          <Num label="FVG min size (ATR)" k="fvgMinAtr" cfg={cfg} set={set} step={0.05} />
          <Num label="POI overlap = same POI (%)" k="poiOverlapPct" cfg={cfg} set={set} />
          <Num label="POI max age (15M bars)" k="maxPoiAgeBars" cfg={cfg} set={set} />
        </Grid>
      </div>
      <div className="card" style={card}>
        <div className="card-title" style={{ marginBottom: 8 }}>Setup rules · classification · invalidation</div>
        <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          <Chk label="CONFIRMED needs a swept + rejected liquidity pool" k="requireSweep" cfg={cfg} set={set} />
          <Chk label="CONFIRMED needs a 15M MSS (off = BOS is enough)" k="requireMss" cfg={cfg} set={set} />
          <Chk label="Reject setups that conflict with the 4H bias" k="requireHtfAlignment" cfg={cfg} set={set} />
          <Chk label="Invalidate when a 15M candle closes beyond the POI" k="invalidateOnClose" cfg={cfg} set={set} />
          <Chk label="Invalidate on an opposite 4H MSS" k="invalidateOnBiasFlip" cfg={cfg} set={set} />
        </div>
        <Grid>
          <Num label="Minimum confluence score" k="minScore" cfg={cfg} set={set} />
          <Num label="A+ threshold" k="thresholdAplus" cfg={cfg} set={set} />
          <Num label="B threshold" k="thresholdB" cfg={cfg} set={set} />
          <Num label="C threshold" k="thresholdC" cfg={cfg} set={set} />
          <Num label="Max signals listed" k="maxSignals" cfg={cfg} set={set} />
          <Num label="Invalidation buffer (ATR)" k="invalidateBufferAtr" cfg={cfg} set={set} step={0.05} />
          <Num label="Paper SL buffer (ATR)" k="slBufferAtr" cfg={cfg} set={set} step={0.05} />
          <Num label="Minimum R:R" k="minRR" cfg={cfg} set={set} step={0.1} />
        </Grid>
      </div>
      <div className="card" style={card}>
        <div className="card-title" style={{ marginBottom: 8 }}>Score weights (each factor is counted once)</div>
        <Grid>
          {Object.keys(WEIGHT_LABELS).map((k) => (
            <label key={k} style={{ display: 'block', fontSize: 12.5 }}>
              <span style={{ color: '#475569' }}>{WEIGHT_LABELS[k]}</span>
              <input type="number" className="cs-input" style={{ width: '100%', marginTop: 2 }} value={cfg.weights?.[k] ?? ''} onChange={(e) => setW(k, e.target.value)} />
            </label>
          ))}
        </Grid>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => save()}>{busy ? 'Saving…' : dirty ? 'Save settings' : 'Saved'}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => window.confirm('Reset every POI setting to its default?') && save(defaults)}>Reset to defaults</button>
      </div>
      {msg && <div className="card-subtitle" style={{ marginTop: 8, color: msg.ok ? '#16A34A' : '#DC2626' }}>{msg.text}</div>}
    </div>
  );
}
