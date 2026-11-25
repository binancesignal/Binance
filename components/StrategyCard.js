'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_TFS_ALL = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

async function post(body) {
  const r = await fetch('/api/harmonic-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const Num = ({ label, value, onChange, min, max, step, w = 96 }) => (
  <label style={{ fontSize: 12 }}>
    {label}
    <input className="form-input" type="number" min={min} max={max} step={step} value={value} style={{ width: w, display: 'block' }} onChange={(e) => onChange(+e.target.value)} />
  </label>
);

function Funnel({ title, rows }) {
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>
      <b>{title}</b>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
        {rows.map(([lab, n], i) => (
          <span key={lab} className="chip chip-muted">
            {i > 0 ? '→ ' : ''}{lab}: <b>{n ?? 0}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Separate strategies on the Harmonic board: Elliott Wave Impulse and ABCD + SP breaker.
 * Own settings and timeframes. Shared with the Harmonic card: the coin-scan system (universe, chunks, cron)
 * and the chart setting. Results appear on the Scanner tab with a strategy badge.
 */
export default function StrategyCard() {
  const [cfg, setCfg] = useState(null);
  const [tfsAll, setTfsAll] = useState(DEFAULT_TFS_ALL);
  const [scan, setScan] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [coins, setCoins] = useState('BTCUSDT, ETHUSDT');
  const [test, setTest] = useState(null);
  const [driving, setDriving] = useState(false);
  const [log, setLog] = useState('');
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await post({ action: 'strategy_get' });
      setCfg((prev) => prev || d.cfg);
      if (Array.isArray(d.tfsAll)) setTfsAll(d.tfsAll);
      setScan(d.scan);
    } catch (e) {
      setMsg(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.hidden) return;
      post({ action: 'scan_cron_get' }).then((d) => setScan(d.state)).catch(() => {});
    }, 8000);
    return () => clearInterval(id);
  }, [load]);

  if (!cfg) return <div className="card"><div className="card-title">Strategies</div><div className="text-secondary" style={{ fontSize: 13 }}>{msg || 'Loading…'}</div></div>;

  const set = (k, v) => setCfg((p) => ({ ...p, [k]: v }));
  const sub = (g, k, v) => setCfg((p) => ({ ...p, [g]: { ...p[g], [k]: v } }));
  const toggleTf = (tf) => set('tfs', cfg.tfs.includes(tf) ? cfg.tfs.filter((x) => x !== tf) : [...cfg.tfs, tf]);

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      const d = await post({ action: 'strategy_save', config: cfg });
      setCfg(d.cfg);
      setMsg(d.msg || 'Saved');
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  };

  const runTest = async () => {
    setBusy(true);
    setMsg('');
    setTest(null);
    try {
      await post({ action: 'strategy_save', config: cfg }); // test with what is on screen
      const d = await post({ action: 'strategy_scan', symbols: coins.split(/[\s,]+/).filter(Boolean) });
      setTest(d);
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  };

  /** Run server ticks one after another while this page is open → live progress, no external cron needed. */
  const drive = async () => {
    if (driving) return;
    stopRef.current = false;
    setDriving(true);
    setLog('');
    let errors = 0;
    try {
      for (let n = 0; n < 3000 && !stopRef.current; n++) {
        const d = await post({ action: 'scan_tick' });
        setScan(d.state);
        const r = d.result || {};
        if (r.finishedPass) {
          setLog(`Full scan finished — ${d.state?.lastPass?.coins ?? ''} coins, ${d.state?.lastPass?.found ?? 0} new signals`);
          break;
        }
        if (r.skipped) {
          const why = String(r.reason || '');
          if (/disabled/i.test(why)) { setLog('Scan is switched off'); break; }
          if (/resting between passes/i.test(why)) { setLog('Last pass is finished — resting before the next one'); break; }
          setLog(why.includes('paused') || r.banned ? 'Binance asked us to slow down — waiting…' : 'Waiting for the previous tick…');
          await sleep(why.includes('paused') || r.banned ? 10000 : 4000);
          continue;
        }
        if (r.ok === false) {
          setLog(`Tick error: ${r.error || 'unknown'}`);
          errors += 1;
          if (errors > 5) break;
          await sleep(8000);
          continue;
        }
        errors = 0;
        if (r.stopReason && r.stopReason !== 'time budget') setLog(`Paused: ${r.stopReason}`);
        await sleep(600);
      }
    } catch (e) {
      setMsg(e.message);
    }
    setDriving(false);
  };

  const startFull = async () => {
    setBusy(true);
    setMsg('');
    setLog('Starting…');
    try {
      await post({ action: 'strategy_save', config: cfg });
      const d = await post({ action: 'scan_cron_set', enabled: true, restart: true });
      setScan(d.state);
    } catch (e) {
      setMsg(e.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    drive();
  };

  const stopAll = async () => {
    stopRef.current = true;
    try {
      const d = await post({ action: 'scan_cron_set', enabled: false });
      setScan(d.state);
      setLog('Stopped');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const diag = scan?.pass?.diag || scan?.lastPass?.diag || null;
  const anyOn = cfg.enableElliott || cfg.enableAbcdSp;

  return (
    <div className="card">
      <div className="card-title">Strategies · Elliott Wave + ABCD / SP breaker</div>
      <p className="form-hint" style={{ marginTop: 4 }}>
        These are <b>separate from the Harmonic settings</b> (families, ratios, score, EMA / breaker / volume filters do not apply here).
        They share only the <b>coin-scan system</b> (coins, chunks, cron) and the <b>chart setting</b>. Results show on the Scanner tab with a strategy badge.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 6px', cursor: 'pointer' }}>
        <input type="checkbox" checked={cfg.harmonicEnabled} onChange={(e) => set('harmonicEnabled', e.target.checked)} />
        <span><b>Also scan Harmonic patterns</b> in the same pass (turn OFF to scan only the strategies below)</span>
      </label>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '10px 0 6px', cursor: 'pointer' }}>
        <input type="checkbox" checked={cfg.enableElliott} onChange={(e) => set('enableElliott', e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          <b>🌊 Elliott Wave – Impulse</b> — wave 1 + wave 2 (W2/W1 ≈ 0.5 / 0.618 / 0.764 / 0.854 ±error). Entry = wave 2 end ± entry % of wave 2 ·
          stop = start of wave 1 · targets = wave 2 × 1.618 / 2.0 / 2.618 / 3.236.
        </span>
      </label>
      {cfg.enableElliott && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 10px 26px' }}>
          <Num label="Zigzag length" value={cfg.elliott.zigzagLength} onChange={(v) => sub('elliott', 'zigzagLength', v)} min={2} max={60} step={1} />
          <Num label="Fib error %" value={cfg.elliott.errorPercent} onChange={(v) => sub('elliott', 'errorPercent', v)} min={1} max={20} step={1} />
          <Num label="Entry % of wave 2" value={cfg.elliott.entryPercent} onChange={(v) => sub('elliott', 'entryPercent', v)} min={5} max={100} step={5} w={120} />
          <Num label="Max age (bars)" value={cfg.elliott.maxAgeBars} onChange={(v) => sub('elliott', 'maxAgeBars', v)} min={5} max={400} step={5} />
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '10px 0 6px', cursor: 'pointer' }}>
        <input type="checkbox" checked={cfg.enableAbcdSp} onChange={(e) => set('enableAbcdSp', e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          <b>📐 ABCD + SP breaker</b> — EMA200 trend. Trend down + upward ABCD (HH, HL) → <b>LONG</b> at the SP breaker's top line, SL under its bottom line;
          trend up + downward ABCD (LL, LH) → <b>SHORT</b> at its bottom line, SL above its top line. SP breaker = breaker block that starts on the AB / BC wave
          and touches the C candle (wick or body). Patterns touching the EMA200 are skipped.
        </span>
      </label>
      {cfg.enableAbcdSp && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 8px 26px' }}>
            <Num label="Swing left bars" value={cfg.abcd.swingLeft} onChange={(v) => sub('abcd', 'swingLeft', v)} min={1} max={20} step={1} />
            <Num label="Swing right bars" value={cfg.abcd.swingRight} onChange={(v) => sub('abcd', 'swingRight', v)} min={1} max={20} step={1} />
            <Num label="Min AB leg (×ATR)" value={cfg.abcd.minLegAtr} onChange={(v) => sub('abcd', 'minLegAtr', v)} min={0} max={20} step={0.1} w={110} />
            <Num label="SL buffer (×ATR)" value={cfg.abcd.stopBufferAtr} onChange={(v) => sub('abcd', 'stopBufferAtr', v)} min={0} max={5} step={0.05} />
            <Num label="Max age (bars)" value={cfg.abcd.maxAgeBars} onChange={(v) => sub('abcd', 'maxAgeBars', v)} min={10} max={400} step={10} />
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 10px 26px', cursor: 'pointer', fontSize: 12.5 }}>
            <input type="checkbox" checked={cfg.abcd.spStrictBorn} onChange={(e) => sub('abcd', 'spStrictBorn', e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <b>Strict:</b> the SP breaker must also have been <i>confirmed (broken)</i> at or before C. OFF = only its starting candle must be at / before C
              (finds many more setups).
            </span>
          </label>
        </>
      )}

      <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>Timeframes for these strategies</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {tfsAll.map((tf) => (
          <button key={tf} type="button" className={`btn btn-sm ${cfg.tfs.includes(tf) ? 'btn-primary' : 'btn-secondary'}`} onClick={() => toggleTf(tf)}>
            {tf}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save strategy settings</button>
        {msg && <span style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>

      <div style={{ fontWeight: 700, margin: '16px 0 4px' }}>Scan coins (server cron — same coin system as Harmonic)</div>
      <div className="form-hint" style={{ marginBottom: 6 }}>
        Coins, chunk size and rest time are the ones in the Harmonic card's cron box. One pass scans every coin once for Harmonic (if ON) and for these strategies.
      </div>
      {scan?.pass && (
        <div style={{ margin: '4px 0 8px' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Scanning {scan.pass.done} / {scan.pass.total} coins
            {scan.pass.total ? ` · ${Math.round((scan.pass.done / scan.pass.total) * 100)}%` : ''}
            {scan.pass.current ? ` · next: ${scan.pass.current}` : ''}
          </div>
          <div style={{ height: 8, borderRadius: 6, background: 'rgba(128,128,128,.2)', overflow: 'hidden', margin: '4px 0' }}>
            <div style={{ width: `${scan.pass.total ? (scan.pass.done / scan.pass.total) * 100 : 0}%`, height: '100%', background: '#16A34A', transition: 'width .4s' }} />
          </div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Signals found so far: <b>{scan.pass.found}</b>
            {scan.pass.errors ? ` · coins with errors: ${scan.pass.errors}` : ''}
          </div>
          {scan.pass.recent?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {[...scan.pass.recent].reverse().map((c, i) => (
                <span key={`${c}${i}`} className="chip chip-muted">{String(c).replace(/USDT$/, '')} ✓</span>
              ))}
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 6 }}>
        {driving ? '🟢 This page is running the scan now (keep it open). ' : scan?.enabled ? '🟡 Cron is ON but this page is not driving it — progress only moves when your cron-job.org call arrives. ' : '⚪ Not running. '}
        {log && <b>{log}</b>}
        {!scan?.pass && scan?.status ? ` · ${scan.status}` : ''}
        {scan?.lastError ? <span style={{ color: '#f6465d' }}> · {scan.lastError}</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={busy || driving || !anyOn} onClick={startFull}>
          Save + start a full scan now
        </button>
        {!driving && scan?.pass && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={drive}>Continue scanning here</button>
        )}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={stopAll}>Stop</button>
      </div>
      {!anyOn && <div className="form-hint" style={{ marginTop: 6 }}>Switch ON Elliott and / or ABCD + SP breaker first.</div>}
      <div className="form-hint" style={{ marginTop: 6 }}>
        While this page is open it runs the scan itself, tick by tick, and shows every coin as it finishes. To keep scanning with the page closed, your cron-job.org call to the scan URL (Harmonic card → cron box) must be set.
      </div>

      {diag && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Why many / few results (last {scan?.pass?.diag ? 'running' : 'finished'} pass · {diag.windows} coin/timeframe windows)</div>
          {cfg.enableElliott && (
            <Funnel
              title="🌊 Elliott"
              rows={[['wave 1+2 structures', diag.elliottPivotSets], ['recent', diag.elliottRecent], ['listed (alive)', diag.elliottListed]]}
            />
          )}
          {cfg.enableAbcdSp && (
            <Funnel
              title="📐 ABCD + SP"
              rows={[['ABCD found', diag.abcdPatterns], ['recent', diag.abcdRecent], ['not touching EMA200', diag.abcdEmaSide], ['right trend + shape', diag.abcdTrendShape], ['SP breaker found', diag.abcdSpBreaker], ['listed (alive)', diag.abcdListed]]}
            />
          )}
        </div>
      )}

      <div style={{ fontWeight: 700, margin: '16px 0 4px' }}>Test coins now</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="form-input" style={{ flex: 1, minWidth: 180 }} value={coins} onChange={(e) => setCoins(e.target.value)} placeholder="BTCUSDT, ETHUSDT (max 2)" />
        <button type="button" className="btn btn-secondary" disabled={busy || !anyOn} onClick={runTest}>Scan these coins</button>
      </div>
      {test && (
        <div style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.6 }}>
          <div>Found <b>{test.found.length}</b> setup(s) on {test.tfs.join(', ')} · saved to the Scanner board</div>
          {test.found.map((f, i) => (
            <div key={i}>{f.strategy === 'ELLIOTT' ? '🌊' : '📐'} {f.symbol} {f.tf} · {f.direction} · {String(f.status).replace(/_/g, ' ')} · score {f.score}</div>
          ))}
          {test.errors?.length > 0 && <div style={{ color: '#f6465d' }}>{test.errors.join(' | ')}</div>}
          <Funnel
            title="Funnel for these coins"
            rows={[
              ['Elliott structures', test.diag.elliottPivotSets], ['recent', test.diag.elliottRecent], ['Elliott listed', test.diag.elliottListed],
            ]}
          />
          <Funnel
            title=""
            rows={[['ABCD found', test.diag.abcdPatterns], ['recent', test.diag.abcdRecent], ['not touching EMA', test.diag.abcdEmaSide], ['trend+shape', test.diag.abcdTrendShape], ['SP breaker', test.diag.abcdSpBreaker], ['ABCD listed', test.diag.abcdListed]]}
          />
        </div>
      )}
    </div>
  );
}
