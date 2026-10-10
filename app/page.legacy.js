'use client';

import BybitTradingDesk from '../components/BybitTradingDesk';
import { apiFetch as fetch } from '../lib/apiFetch.js';

import { useEffect, useState, useCallback, useRef, Component } from 'react';
import './globals.css';
import { GATE_DEFS, defaultGateModes } from '../lib/scanner/strategy/chartPattern/gates.js';

class ClientErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: error?.message || String(error) };
  }
  componentDidCatch(error) {
    console.error('[ClientErrorBoundary]', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="section error-box" style={{ margin: 12 }}>
          ⚠️ UI error: {this.state.error}
          <div style={{ marginTop: 8 }}>
            <button
              className="scan-btn"
              onClick={() => this.setState({ error: null })}
              style={{ background: '#2b3139' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}


function fmt(n, d) {
  if (n == null || Number.isNaN(+n)) return '—';
  const v = Number(n);
  // Adaptive decimals: micro-priced coins need more places
  if (d != null) return v.toFixed(d);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  if (a >= 0.01) return v.toFixed(5);
  if (a >= 0.0001) return v.toFixed(6);
  return v.toFixed(8);
}

function fmtPct(n) {
  if (n == null) return '—';
  const v = +n;
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function formatLK(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).replace(',', '') + ' LK';
  } catch {
    return String(iso).replace('T', ' ').slice(0, 19);
  }
}


// Vercel returns a plain-text/HTML error page (not JSON) for platform-level
// failures like function timeouts or crashes. res.json() throws a confusing
// "Unexpected token" error in that case — this reads the body safely and
// surfaces the real message instead.
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160);
    return {
      error: `Server returned a non-JSON response (HTTP ${res.status}): ${
        snippet || 'empty body'
      }`,
    };
  }
}

function ProximityBar({ score, label }) {
  const s = Math.max(0, Math.min(100, Math.round(score || 0)));
  // green = close, yellow = mid, red-ish = far
  const color =
    s >= 75 ? '#0ecb81' : s >= 50 ? '#f0b90b' : s >= 25 ? '#f0a020' : '#f6465d';
  return (
    <div className="prox-bar">
      <div
        className="prox-fill"
        style={{ width: `${s}%`, background: color }}
      />
      <span className="prox-label">
        {label ? `${label} · ${s}%` : `${s}%`}
      </span>
    </div>
  );
}

function describeValue(value) {
  if (value == null || value === '') return 'Not recorded';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function getSignalStages(signal) {
  const meta = signal?.metadata || {};
  const universal = meta.universal || {};
  const direction = String(signal?.direction || signal?.dir || '').toUpperCase();
  const pattern = meta.pattern || meta.patternType || signal?.pattern || null;
  const strategy = meta.strategy || signal?.strategy || '';
  const isChart = strategy === 'chart_pattern' || meta.nearBreakout || meta.kind === 'NEAR_BREAKOUT';
  const structure = meta.structure || signal?.structure || universal.structure || null;
  const bias = structure?.bias;
  const bos = structure?.bos;
  const choch = structure?.choch;
  const opposite = direction === 'LONG'
    ? bos === 'bearish' || choch === 'bearish'
    : bos === 'bullish' || choch === 'bullish';
  const aligned = direction === 'LONG'
    ? bias === 'bullish' || bos === 'bullish' || choch === 'bullish'
    : bias === 'bearish' || bos === 'bearish' || choch === 'bearish';
  const conf = Array.isArray(meta.conf) ? meta.conf.join(' · ') : '';
  const invalidation = meta.invalidation || {};
  const failures = Array.isArray(invalidation.reasons) ? invalidation.reasons : [];
  const entryGateFailures = failures.filter((failure) =>
    ['Entry Quality', 'HTF / Structure', 'SMC / Order Block', 'Score / Quality', 'Risk / RR'].includes(failure.category)
  );
  const qualityFail = meta.entryQualityFail || entryGateFailures.map((failure) => failure.reason).join('; ');
  const score = invalidation.currentScore ?? signal?.score;
  const requiredScore = meta.minScoreAtCreate ?? meta.minScore ?? null;
  const rr = signal?.rr == null || signal?.rr === '' ? NaN : Number(signal.rr);
  // Chart-pattern signals: TP1 RR floor is 1.0 (older stored signals still carry 1.2 in metadata)
  const requiredRr = isChart ? Number(meta.minRrAtEntry ?? 1.0) : Number(meta.minRrAtEntry ?? 1.2);
  const fib = meta.fib || universal.fib || null;
  const elliott = meta.elliottWave || meta.elliott || universal.elliott || null;
  const rejection = meta.rejection || universal.rejection || null;
  const ob = meta.ob || null;
  const add = (name, state, value, actual = null, required = null) => ({
    name, state, value, actual, required,
  });

  return [
    add('Pattern', pattern ? 'PASS' : 'NOT RECORDED', pattern || (isChart ? 'Pattern name not stored' : 'SMC setup; no chart pattern required')),
    add(
      'Breakout',
      isChart ? (meta.breakoutConfirmed || meta.liveEntry ? 'PASS' : meta.nearBreakout ? 'WAIT' : 'NOT RECORDED') : 'N/A',
      isChart
        ? `${meta.breakoutConfirmed ? 'Confirmed' : meta.liveEntry ? 'Live price crossed entry (candle close not awaited)' : meta.nearBreakout ? 'Waiting for candle close' : 'No breakout snapshot'}${meta.breakoutLevel != null ? ` · level ${fmt(meta.breakoutLevel)}` : ''}${meta.rvol != null ? ` · RVOL ${fmt(meta.rvol, 2)}` : ''}`
        : 'Not required for this strategy'
    ),
    add(
      'HTF / Structure',
      !structure ? 'NOT RECORDED' : opposite ? 'FAIL' : aligned || bias === 'neutral' ? 'PASS' : 'FAIL',
      structure ? `Bias ${bias || '—'} · BOS ${bos || '—'} · CHOCH ${choch || '—'}` : 'Structure snapshot not stored',
      structure ? { bias, bos, choch } : null,
      `No opposite ${direction} structure; aligned bias or neutral`
    ),
    add(
      'SMC / Order Block',
      isChart ? 'N/A' : (ob || (meta.ob_low != null && meta.ob_high != null) ? 'PASS' : 'NOT RECORDED'),
      ob ? `${ob.type || 'OB'} · ${ob.status || 'status not recorded'} · ${fmt(ob.low)}–${fmt(ob.high)}` : meta.ob_low != null && meta.ob_high != null ? `Stored zone ${fmt(meta.ob_low)}–${fmt(meta.ob_high)}` : 'Order-block snapshot not stored',
      ob ? { type: ob.type, status: ob.status, low: ob.low, high: ob.high } : null,
      'Direction-matched order block valid and near entry'
    ),
    add(
      'Fibonacci',
      fib ? (fib.deepOte || fib.inOte ? 'PASS' : 'FAIL') : conf.includes('Fib OTE') || conf.includes('Fib zone') ? 'PASS' : 'NOT RECORDED',
      fib ? `Deep OTE ${fib.deepOte ? 'yes' : 'no'} · OTE ${fib.inOte ? 'yes' : 'no'}` : conf.includes('Fib OTE') || conf.includes('Fib zone') ? 'Fib confluence recorded at scan' : 'Fib snapshot not stored',
      fib ? { deepOte: fib.deepOte, inOte: fib.inOte } : null,
      'Fib confluence per configured strategy'
    ),
    add(
      'Rejection',
      rejection ? (rejection.ok === false ? 'FAIL' : 'PASS') : /rejection/i.test(conf) ? 'PASS' : 'NOT RECORDED',
      rejection ? describeValue(rejection.label || rejection.reason || rejection.score) : /rejection/i.test(conf) ? 'Rejection confluence recorded' : 'Rejection snapshot not stored'
    ),
    add(
      'Elliott Wave',
      elliott ? 'PASS' : conf.toLowerCase().includes('wave') ? 'PASS' : 'NOT RECORDED',
      elliott ? describeValue(elliott.context?.label || elliott.label || elliott.waveCount || elliott.score) : conf.toLowerCase().includes('wave') ? 'Wave confluence recorded' : 'Wave snapshot not stored'
    ),
    add(
      'Score / Quality',
      requiredScore == null ? 'NOT RECORDED' : Number(score) >= Number(requiredScore) ? 'PASS' : 'FAIL',
      `Score ${score ?? '—'} · required ${requiredScore ?? 'not recorded'}`,
      score ?? null,
      requiredScore
    ),
    add(
      'Risk / RR',
      Number.isFinite(rr) ? (rr + 1e-6 >= requiredRr ? 'PASS' : 'FAIL') : 'NOT RECORDED',
      `RR ${Number.isFinite(rr) ? rr.toFixed(2) : '—'} · required ${requiredRr.toFixed(2)}`,
      Number.isFinite(rr) ? rr : null,
      requiredRr
    ),
    add(
      'Entry Quality',
      entryGateFailures.length || meta.entryQualityFail
        ? 'FAIL'
        : signal?.entry_hit_at || ['ONGOING', 'COMPLETED_PROFIT', 'STOPPED'].includes(signal?.status)
          ? 'PASS'
          : signal?.status === 'INVALIDATED' ? 'N/A' : 'PENDING',
      qualityFail || (signal?.entry_hit_at ? `Entry accepted at ${fmt(signal.entry_hit_price || signal.entry)}` : signal?.status === 'INVALIDATED' ? 'Invalidated before an entry-quality pass was recorded' : 'Re-check occurs as price approaches entry')
    ),
    add('Final Status', signal?.status === 'INVALIDATED' ? 'FAIL' : 'PASS', signal?.status || 'Unknown'),
  ];
}

function ExplainSignal({ signal }) {
  const [open, setOpen] = useState(false);
  const stages = getSignalStages(signal);
  return (
    <div className="explain-wrap">
      <button className="secondary-btn explain-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide signal explanation' : 'Explain signal'}
      </button>
      {open && (
        <div className="explain-panel">
          {stages.map((stage) => (
            <div className="explain-stage" key={stage.name}>
              <span className={`stage-state ${stage.state.toLowerCase().replaceAll(' ', '-')}`}>{stage.state}</span>
              <div className="stage-copy">
                <b>{stage.name}</b>
                <span>{stage.value}</span>
                {(stage.actual != null || stage.required != null) && (
                  <small>Actual: {describeValue(stage.actual)} · Required: {describeValue(stage.required)}</small>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const NEAR_STATE = {
  BREAKING_NOW: { label: '⚡ BREAKING NOW · candle close බලාපොරොත්තුවෙන්', color: '#f0b90b' },
  AT_LEVEL: { label: '🎯 AT LEVEL', color: '#0ecb81' },
  APPROACHING: { label: '⏳ APPROACHING', color: '#5b9dff' },
};

function NearCard({ n }) {
  if (!n || !n.symbol) return null;
  const dir = n.direction || 'LONG';
  const dirCls = dir === 'LONG' ? 'long' : 'short';
  const st = NEAR_STATE[n.state] || NEAR_STATE.APPROACHING;
  const conf = (Array.isArray(n.conf) ? n.conf : []).filter(Boolean);
  const gap = n.gapAtr != null ? Number(n.gapAtr) : null;
  const dirWord = dir === 'LONG' ? 'above' : 'below';
  return (
    <div className={`signal-card ${dirCls}`}>
      <div className="card-head">
        <span className="sym">{n.symbol}</span>
        <span className={`dir ${dirCls}`}>{dir === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</span>
        <span className="score">{n.score ?? '—'}/100</span>
      </div>
      <div style={{ padding: '4px 0', fontSize: 11, color: st.color, fontWeight: 700 }}>{st.label}</div>
      <div className="meta">
        {String(n.pattern || '').replace(/_/g, ' ')} · {String(n.patternTf || '').toUpperCase()}
        {gap != null ? (gap > 0 ? ` · ${gap.toFixed(2)} ATR (${n.gapPct}%) to level` : ' · already through level (forming candle)') : ''}
      </div>
      <div className="levels">
        <div><span>Market (now)</span><span className="pos">{fmt(n.price)}</span></div>
        <div><span>Breakout level</span><span>{fmt(n.trigger)}</span></div>
        <div><span>Confirm close {dirWord}</span><span>{fmt(n.entry)}</span></div>
        <div><span>SL (if it breaks)</span><span className="neg">{fmt(n.sl)}</span></div>
        <div><span>TP1 / TP2</span><span className="pos">{fmt(n.tp1)} / {fmt(n.tp2)}</span></div>
        <div><span>R:R (TP1 / measured)</span><span>{n.rr} / {n.rrMeasured}</span></div>
      </div>
      <div className="confluence">
        {n.approaching ? <span>Pressing to level</span> : null}
        {n.volBuild != null ? <span>Vol x{n.volBuild}</span> : null}
        {n.htfAligned ? <span>HTF ✓</span> : null}
        {conf.slice(0, 8).map((c, i) => <span key={i}>{c}</span>)}
      </div>
      <div className="prox-meta">Alert only — breakout candle close ekak (volume ekka) thama real signal eka.</div>
    </div>
  );
}

function SignalCard({ s, kind, onEnterNow, enterBusyId }) {
  if (!s || !s.symbol) return null;
  const dir = s.direction || s.dir || 'LONG';
  const dirCls = dir === 'LONG' ? 'long' : 'short';
  const rawConf = s.metadata?.conf || s.conf || [];
  const conf = (Array.isArray(rawConf) ? rawConf : [])
    .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' ? (c.label || c.type || JSON.stringify(c)) : String(c ?? '')))
    .filter(Boolean);
  const sid = s.signal_id || `${s.symbol}_${dir}`;
  const busy = enterBusyId === sid;
  const distPct =
    s.distance_percent != null && Number.isFinite(+s.distance_percent)
      ? Number(s.distance_percent).toFixed(2)
      : null;
  const liveEvaluation = s.metadata?.liveEvaluation;
  return (
    <div className={`signal-card ${dirCls}`}>
      <div className="card-head">
        <span className="sym">{s.symbol}</span>
        <span className={`dir ${dirCls}`}>
          {dir === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}
        </span>
        <span className="score">{s.score ?? '—'}/100</span>
      </div>
      {(s.strategy === 'chart_pattern' || s.metadata?.strategy === 'chart_pattern' || s.pattern || s.metadata?.nearBreakout) && (
        <div style={{ padding: '4px 12px', fontSize: 11, color: '#f0b90b' }}>
          STRATEGY: CHART PATTERN{(s.metadata?.patternTf || s.patternTf) ? ` · ${String(s.metadata?.patternTf || s.patternTf).toUpperCase()}` : ''}
          {s.pattern || s.metadata?.pattern ? ` · ${s.pattern || s.metadata?.pattern}` : ''}
          {s.metadata?.breakoutConfirmed ? ' · Breakout ✓' : ''}
          {s.metadata?.nearBreakout && !s.metadata?.breakoutConfirmed
            ? ` · ⚡ ${s.metadata?.nearState || 'NEAR'} · waiting close`
            : ''}
        </div>
      )}
      <div className="meta">
        {s.status || 'LIVE'} · Score {s.score ?? '—'}
        {liveEvaluation?.reScore != null
          ? ` · Re-score ${liveEvaluation.reScore}`
          : ''}
        {distPct != null ? ` · Dist ${distPct}%` : ''}
        {liveEvaluation?.evaluatedAt || s.last_checked_at || s.last_updated_at
          ? ` · Checked ${formatLK(liveEvaluation?.evaluatedAt || s.last_checked_at || s.last_updated_at)}`
          : ''}
      </div>
      <div className="levels">
        <div>
          <span>{liveEvaluation?.priceSource === 'MARK_PRICE' ? 'Mark price (now)' : 'Market (now)'}</span>
          <span className="pos">{fmt(s.current_price ?? s.price)}</span>
        </div>
        {liveEvaluation?.marketPosition && (
          <div>
            <span>Price vs entry</span>
            <span>{liveEvaluation.marketPosition.replaceAll('_', ' ')}</span>
          </div>
        )}
        {liveEvaluation?.htfState && (
          liveEvaluation.htfState.bias != null ||
          liveEvaluation.htfState.bos != null ||
          liveEvaluation.htfState.choch != null
        ) && (
          <div>
            <span>HTF / structure</span>
            <span>
              {[liveEvaluation.htfState.bias, liveEvaluation.htfState.bos, liveEvaluation.htfState.choch]
                .filter((value) => value != null && value !== '')
                .join(' · ')}
            </span>
          </div>
        )}
        {liveEvaluation?.entryQuality && (
          <div>
            <span>Entry quality</span>
            <span className={liveEvaluation.entryQuality.ok ? 'pos' : 'neg'}>
              {liveEvaluation.entryQuality.ok ? 'PASS' : `FAIL · ${liveEvaluation.entryQuality.reason || 're-check'}`}
              {liveEvaluation.entryQuality.checkedAt
                ? ` · ${formatLK(liveEvaluation.entryQuality.checkedAt)}`
                : ''}
            </span>
          </div>
        )}
        <div><span>Entry</span><span>{fmt(s.entry)}</span></div>
        {kind === 'ongoing' && (
          <div><span>Entry Hit</span><span>{fmt(s.entry_hit_price)}</span></div>
        )}
        {kind === 'ongoing' && (
          <div className={`live-pnl ${+s.current_pnl_percent >= 0 ? 'positive' : 'negative'}`}>
            <span className="live-pnl-label">LIVE PnL</span>
            <strong>{fmtPct(s.current_pnl_percent)}</strong>
            <span className="live-pnl-caption">Price-based return since entry</span>
          </div>
        )}
        <div><span>SL</span><span className="neg">{fmt(s.sl)}</span></div>
        <div>
          <span>TP1 / TP2 / TP3</span>
          <span className="pos">
            {fmt(s.tp1)} {s.tp1_hit ? '✓' : ''} / {fmt(s.tp2)}{' '}
            {s.tp2_hit ? '✓' : ''} / {fmt(s.tp3)} {s.tp3_hit ? '✓' : ''}
          </span>
        </div>
        <div>
          <span>Planned R:R</span>
          <span>1:{(liveEvaluation?.plannedRr ?? s.rr) != null ? String(liveEvaluation?.plannedRr ?? s.rr) : '—'}</span>
        </div>
        {liveEvaluation?.currentRrToTp1 != null && (
          <div>
            <span>Current R:R to TP1</span>
            <span>1:{liveEvaluation.currentRrToTp1}</span>
          </div>
        )}
      </div>
      <div className="proximity">
        <div className="prox-title">
          ENTRY PROXIMITY (ATR){' '}
          {s.close_label ? (
            <b style={{ color: s.is_close ? 'var(--green)' : 'var(--yellow)' }}>
              {s.close_label}
            </b>
          ) : null}
        </div>
        <ProximityBar score={s.proximity_score} label={s.close_label} />
        <div className="prox-meta">
          ATR dist: <b>{fmt(s.atr_distance, 2)}</b> ATR
          {' · '}
          Threshold: {fmt(s.ready_threshold_atr ?? 0.5, 2)} ATR
          {' · '}
          Price gap: {fmt(s.distance_percent, 2)}%
        </div>
      </div>
      {conf.length > 0 && (
        <div className="confluence">
          {conf.slice(0, 8).map((c, i) => (
            <span key={i}>✓ {c}</span>
          ))}
        </div>
      )}
      {(() => {
        const u = s.metadata?.universal;
        if (!u) return null;
        return (
          <div style={{ padding: '6px 12px', fontSize: 11, borderTop: '1px solid #2a2e39', marginTop: 4 }}>
            <div style={{ color: '#848e9c', marginBottom: 4 }}>
              UNIVERSAL · {u.setupType || '—'}
              {u.elliott?.context?.label ? ` · ${u.elliott.context.label}` : ''}
              {u.finalScore != null ? ` · Final ${u.finalScore}` : ''}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
              {u.patternScore != null && <span>Pat {u.patternScore}</span>}
              {u.locationScore != null && <span>Loc {u.locationScore}</span>}
              {u.liquidityScore != null && <span>Liq {u.liquidityScore}</span>}
              {u.rejectionScore != null && <span>Rej {u.rejectionScore}</span>}
              {u.structureScore != null && <span>Str {u.structureScore}</span>}
              {u.waveScore != null && <span>Wave {u.waveScore}</span>}
            </div>
            {(u.whyAccepted || []).length > 0 && (
              <div style={{ color: '#0ecb81', marginBottom: 2 }}>
                WHY ACCEPTED: {(u.whyAccepted || []).slice(0, 4).join(' · ')}
              </div>
            )}
            {(u.whyRejected || []).length > 0 && (
              <div style={{ color: '#f6465d' }}>
                WHY REJECTED: {(u.whyRejected || []).slice(0, 3).join(' · ')}
              </div>
            )}
            {u.cluster && (
              <div style={{ color: '#f0b90b', marginTop: 2 }}>
                Cluster: {(u.cluster.sources || []).join('+')} (str {u.cluster.strength})
              </div>
            )}
          </div>
        );
      })()}
      <ExplainSignal signal={s} />
    </div>
  );
}

function HistoryRow({ h }) {
  return (
    <div className="hist-row">
      <b>{h.symbol}</b> {h.direction} · Score {h.score} ·{' '}
      <span className={h.status === 'COMPLETED_PROFIT' ? 'pos' : h.status === 'STOPPED' ? 'neg' : ''}>
        {h.status}
      </span>
      {' · '}
      PnL {fmtPct(h.current_pnl_percent)} · Entry {fmt(h.entry)} ·{' '}
      {formatLK(h.completed_at || h.last_updated_at)}
    </div>
  );
}

function InvalidationCard({ signal }) {
  const inv = signal?.metadata?.invalidation || {};
  const reasons = Array.isArray(inv.reasons) && inv.reasons.length
    ? inv.reasons
    : [{
        category: inv.category || 'Entry Quality',
        reason: inv.reason || 'Reason not recorded',
        actual: inv.actual ?? null,
        required: inv.required ?? null,
      }];
  const pattern = signal?.metadata?.pattern || signal?.metadata?.patternType || signal?.pattern || '—';
  return (
    <article className="invalidation-card">
      <div className="invalidation-title">
        <div>
          <b>{signal.symbol}</b>
          <span className={`dir ${signal.direction === 'SHORT' ? 'short' : 'long'}`}>{signal.direction}</span>
          <span className="pattern-name">{String(pattern).replaceAll('_', ' ')}</span>
        </div>
        <span className="invalid-pill">INVALIDATED</span>
      </div>
      <div className="invalidation-facts">
        <div><span>Previous status</span><b>{inv.previousStatus || 'Not recorded'}</b></div>
        <div><span>Price</span><b>{fmt(inv.price ?? signal.current_price ?? signal.last_price)}</b></div>
        <div><span>Time</span><b>{formatLK(inv.time || signal.invalidated_at || signal.last_updated_at)}</b></div>
        <div><span>Original score</span><b>{inv.originalScore ?? signal.score ?? '—'}</b></div>
      </div>
      <div className="invalidation-reasons">
        {reasons.map((failure, index) => (
          <div className="invalidation-reason" key={`${failure.code || failure.category}-${index}`}>
            <div className="reason-category">{failure.category || inv.category || 'Entry Quality'}</div>
            <b>{failure.reason || inv.reason || 'Validation failed'}</b>
            <div className="actual-required">
              <span>Actual: <b>{describeValue(failure.actual ?? inv.actual)}</b></span>
              <span>Required: <b>{describeValue(failure.required ?? inv.required)}</b></span>
            </div>
          </div>
        ))}
      </div>
      <ExplainSignal signal={signal} />
    </article>
  );
}

function SetupRow({ s }) {
  const dirCls = s.dir === 'LONG' ? 'long' : 'short';
  return (
    <div className={`signal-card ${dirCls}`} style={{ opacity: s.qualifies ? 1 : 0.7 }}>
      <div className="card-head">
        <span className={`dir ${dirCls}`}>{s.dir === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</span>
        <span className="score">{s.score}/100</span>
        <span className={`badge ${s.qualifies ? '' : 'muted'}`} style={{ marginLeft: 'auto' }}>
          {s.qualifies ? '✅ QUALIFIES' : '❌ below threshold'}
        </span>
      </div>
      <div className="levels">
        <div><span>Entry</span><span>{fmt(s.entry)}</span></div>
        <div><span>SL</span><span className="neg">{fmt(s.sl)}</span></div>
        <div><span>TP1 / TP2 / TP3</span><span className="pos">{fmt(s.tp1)} / {fmt(s.tp2)} / {fmt(s.tp3)}</span></div>
        <div><span>R:R</span><span>1:{s.rr != null ? String(s.rr) : '—'}</span></div>
      </div>
      {s.conf?.length > 0 && (
        <div className="confluence">
          {s.conf.map((c, i) => (
            <span key={i}>✓ {c}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalyzePanel() {
  const [symbolInput, setSymbolInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const analyze = useCallback(async () => {
    if (!symbolInput.trim()) return;
    setLoading(true);
    setErr(null);
    setResult(null);
    try {
      const res = await fetch(`/api/analyze?symbol=${encodeURIComponent(symbolInput.trim())}`);
      const data = await safeJson(res);
      if (!res.ok || data.error) setErr(data.error || 'Analysis failed');
      else setResult(data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbolInput]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') analyze();
  };

  return (
    <div className="section">
      <div className="section-header">🔎 ANALYZE ONE COIN</div>
      <div className="section-body">
        <div className="analyze-bar">
          <input
            className="analyze-input"
            placeholder="e.g. BTC or BTCUSDT"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="scan-btn" onClick={analyze} disabled={loading}>
            {loading ? '⏳ Analyzing…' : 'Analyze'}
          </button>
        </div>

        {err && <div className="muted small" style={{ color: 'var(--red)', marginTop: 10 }}>⚠️ {err}</div>}

        {result && (
          <div style={{ marginTop: 14 }}>
            <div className="flex" style={{ marginBottom: 10 }}>
              <div><b className="sym">{result.symbol}</b></div>
              <div>Price: <b>{fmt(result.price)}</b></div>
              <div>ATR(5m): <b>{fmt(result.atr5m)}</b></div>
              <div>Threshold to qualify: <b>{result.minScoreThreshold}/100</b></div>
            </div>

            <div className="flex muted small" style={{ marginBottom: 14 }}>
              <div>HTF Bias ({result.timeframes.htf}): <b>{result.context.structure?.bias ?? '—'}</b></div>
              <div>BOS: <b>{result.context.structure?.bos ?? '—'}</b></div>
              <div>CHOCH: <b>{result.context.structure?.choch ?? '—'}</b></div>
              <div>Zone: <b>{result.context.premiumDiscount?.zone ?? '—'}</b></div>
              <div>RSI: <b>{fmt(result.context.rsi, 1)}</b></div>
              <div>EMA20: <b>{fmt(result.context.ema20)}</b></div>
              <div>RVOL: <b>{fmt(result.context.relativeVolume, 2)}</b></div>
              <div>Order blocks found: <b>{result.context.orderBlocksFound}</b></div>
              <div>FVGs found: <b>{result.context.fvgsFound}</b></div>
            </div>

            <div style={{ fontWeight: 600, margin: '0 0 8px', color: '#f0b90b' }}>
              Chart Pattern Breakout
            </div>
            {result.chartPattern?.summary ? (
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
                <div>Pattern: <b>{result.chartPattern.summary.pattern || result.chartPattern.summary.metadata?.pattern}</b></div>
                <div>Direction: <b>{result.chartPattern.summary.dir || result.chartPattern.summary.direction}</b></div>
                <div>Score: <b>{result.chartPattern.summary.score}/100</b></div>
                <div>Entry: {fmt(result.chartPattern.summary.entry)} · SL: {fmt(result.chartPattern.summary.sl)}</div>
                <div>TP1/2/3: {fmt(result.chartPattern.summary.tp1)} / {fmt(result.chartPattern.summary.tp2)} / {fmt(result.chartPattern.summary.tp3)}</div>
                <div>RR: 1:{result.chartPattern.summary.rr}</div>
                <div>Breakout: {result.chartPattern.summary.metadata?.breakoutLevel != null ? fmt(result.chartPattern.summary.metadata.breakoutLevel) : '—'} · RVOL {fmt(result.chartPattern.summary.rvol || result.chartPattern.summary.metadata?.rvol, 2)}</div>
                {(result.chartPattern.summary.conf || []).length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {(result.chartPattern.summary.conf || []).slice(0, 8).map((c, i) => (
                      <span key={i} style={{ marginRight: 8 }}>✓ {c}</span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="muted">
                No valid chart pattern breakout detected.
                {result.chartPattern?.rejected?.[0]?.reason
                  ? ` (${result.chartPattern.rejected[0].reason})`
                  : ''}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


function TelegramSettingsPanel() {
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [status, setStatus] = useState(null);
  const [notify, setNotify] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/settings/telegram')
      .then((r) => r.json())
      .then((d) => {
        setStatus(d);
        if (d.notify) setNotify(d.notify);
      })
      .catch(() => {});
  }, []);

  const save = async (withTest) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token: token, chat_id: chatId, test: withTest }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        setMsg({ ok: false, text: data.error || 'Save failed' });
        return;
      }
      setStatus((s) => ({
        ...(s || {}),
        configured: true,
        has_token: true,
        has_chat_id: true,
        source: 'database',
        token_preview: token.slice(0, 6) + '…',
        chat_id: chatId,
      }));
      if (withTest && data.test && !data.test.ok && !data.test.skipped) {
        setMsg({ ok: false, text: 'Saved but test message failed — check token/chat id' });
      } else if (withTest) {
        setMsg({ ok: true, text: 'Saved + test message sent to Telegram' });
      } else {
        setMsg({ ok: true, text: 'Telegram settings saved' });
      }
      setToken('');
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const saveNotify = async () => {
    if (!notify) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save_notify', notify }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        setMsg({ ok: false, text: data.error || 'Notify save failed' });
        return;
      }
      setNotify(data.notify);
      setMsg({ ok: true, text: 'Telegram notification preferences saved' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const refreshBoard = async () => {
    setBusy(true);
    setMsg({ ok: true, text: 'Sending Live Board…' });
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh_live_board' }),
      });
      const data = await safeJson(res);
      if (data.ok) {
        setMsg({
          ok: true,
          text: data.sent
            ? `✅ New Live Board sent (msg ${data.message_id || ''})`
            : data.edited
              ? '✅ Live Board updated'
              : '✅ Live Board OK',
        });
      } else {
        const err =
          data.error ||
          data.reason ||
          data.description ||
          (typeof data.error === 'object' ? JSON.stringify(data.error) : null) ||
          `HTTP ${res.status}`;
        setMsg({
          ok: false,
          text: `Board failed: ${err}. Check Master ON + bot token/chat id.`,
        });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key) => setNotify((n) => ({ ...n, [key]: !n[key] }));

  return (
    <div className="section settings-support">
      <div className="section-header">
        📱 TELEGRAM SETTINGS{' '}
        {status?.configured ? (
          <span className="badge live">CONNECTED</span>
        ) : (
          <span className="badge">NOT SET</span>
        )}
      </div>
      <div className="section-body">
        <p className="muted small" style={{ marginBottom: 12 }}>
          Bot Token + Chat ID. Supabase <code>app_state</code> එකේ save වෙනවා.
        </p>
        {status?.configured && (
          <div className="muted small" style={{ marginBottom: 10 }}>
            Status: {status.source} · Token: {status.token_preview || '—'} · Chat:{' '}
            {status.chat_id || '—'}
            {status.liveBoardMessageId != null && (
              <> · Board msg: {status.liveBoardMessageId}</>
            )}
          </div>
        )}
        <div className="analyze-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input
            className="analyze-input"
            type="password"
            placeholder="Bot token (from @BotFather)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ minWidth: 220, flex: 1 }}
          />
          <input
            className="analyze-input"
            placeholder="Chat ID (number)"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            style={{ minWidth: 140 }}
          />
          <button className="scan-btn" disabled={busy || !token || !chatId} onClick={() => save(false)}>
            Save
          </button>
          <button className="scan-btn" disabled={busy || !token || !chatId} onClick={() => save(true)}>
            Save + Test
          </button>
        </div>

        {notify && (
          <div style={{ marginTop: 16 }}>
            <div className="section-header" style={{ fontSize: 13 }}>Notification mode</div>
            <div className="analyze-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {[
                ['live_board', 'Live Board (no spam)'],
                ['live_board_plus', 'Live Board + important'],
                ['every_event', 'Every event'],
              ].map(([val, label]) => (
                <label key={val} className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="radio"
                    name="tgMode"
                    checked={notify.notificationMode === val}
                    onChange={() => setNotify((n) => ({ ...n, notificationMode: val }))}
                  />
                  {label}
                </label>
              ))}
            </div>

            <div className="muted small" style={{ marginBottom: 6 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={!!notify.masterEnabled} onChange={() => toggle('masterEnabled')} />
                Master Telegram ON
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
              {[
                ['watching', 'Watching'],
                ['ready', 'Ready'],
                ['breakout', 'Breakout'],
                ['ongoing', 'Ongoing / Entry'],
                ['tp1', 'TP1'],
                ['tp2', 'TP2'],
                ['tp3', 'TP3'],
                ['stopLoss', 'Stop Loss'],
                ['completed', 'Completed'],
                ['invalidated', 'Invalidated'],
                ['scanSummary', 'Scan summary on board'],
              ].map(([k, label]) => (
                <label key={k} className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={!!notify[k]} onChange={() => toggle(k)} />
                  {label}
                </label>
              ))}
            </div>

            <div className="section-header" style={{ fontSize: 13 }}>Charts (event messages)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
              {[
                ['chartWatching', 'Watching chart'],
                ['chartReady', 'Ready chart'],
                ['chartBreakout', 'Breakout chart'],
                ['chartOngoing', 'Ongoing chart'],
                ['chartTpSl', 'TP/SL chart'],
              ].map(([k, label]) => (
                <label key={k} className="muted small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={!!notify[k]} onChange={() => toggle(k)} />
                  {label}
                </label>
              ))}
            </div>

            <div className="analyze-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <label className="muted small">
                Max Watching on board{' '}
                <input
                  type="number"
                  className="settings-input"
                  style={{ width: 70 }}
                  value={notify.maxWatchingInBoard ?? 10}
                  onChange={(e) =>
                    setNotify((n) => ({ ...n, maxWatchingInBoard: +e.target.value }))
                  }
                />
              </label>
              <label className="muted small">
                Recent events{' '}
                <input
                  type="number"
                  className="settings-input"
                  style={{ width: 70 }}
                  value={notify.recentEventsLimit ?? 10}
                  onChange={(e) =>
                    setNotify((n) => ({ ...n, recentEventsLimit: +e.target.value }))
                  }
                />
              </label>
            </div>

            <div className="analyze-bar" style={{ gap: 8 }}>
              <button className="scan-btn" disabled={busy} onClick={saveNotify}>
                Save notification prefs
              </button>
              <button className="scan-btn" disabled={busy} onClick={refreshBoard}>
                Refresh Live Board now
              </button>
            </div>
          </div>
        )}

        {msg && (
          <div className="muted small" style={{ marginTop: 10, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>
            {msg.ok ? '✅' : '⚠️'} {msg.text}
          </div>
        )}
      </div>
    </div>
  );
}

function PerformancePanel() {
  const [period, setPeriod] = useState('24h');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async (p = period) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/performance?period=${encodeURIComponent(p)}&_=${Date.now()}`, {
        cache: 'no-store',
      });
      const json = await safeJson(res);
      if (!res.ok || json.ok === false) {
        setMsg({ ok: false, text: json.error || 'Load failed' });
        return;
      }
      setData(json);
      setMsg(null);
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }, [period]);

  useEffect(() => {
    load(period);
  }, [period, load]);

  const startPeriod = async () => {
    if (!window.confirm('Start a new performance tracking period? History is NOT deleted.')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/performance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const json = await safeJson(res);
      if (!res.ok) {
        setMsg({ ok: false, text: json.error || 'Failed' });
        return;
      }
      setPeriod('since');
      setMsg({ ok: true, text: `Tracking since ${json.performanceTrackingStartedAt}` });
      await load('since');
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const t = data?.totals || {};
  const profit = data?.profit || {};

  return (
    <div className="section">
      <div className="section-header">📊 PERFORMANCE</div>
      <div className="section-body">
        <div className="analyze-bar" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {[
            ['24h', 'Last 24H'],
            ['7d', 'Last 7D'],
            ['30d', 'Last 30D'],
            ['all', 'All Time'],
            ['since', 'Since enabled'],
          ].map(([val, label]) => (
            <button
              key={val}
              className={`scan-btn ${period === val ? '' : ''}`}
              style={{
                opacity: period === val ? 1 : 0.7,
                borderBottom: period === val ? '2px solid var(--accent, #326de6)' : 'none',
              }}
              disabled={busy}
              onClick={() => setPeriod(val)}
            >
              {label}
            </button>
          ))}
          <button className="scan-btn" disabled={busy} onClick={startPeriod}>
            Start New Period
          </button>
        </div>
        {data?.performanceTrackingStartedAt && (
          <div className="muted small" style={{ marginBottom: 10 }}>
            Performance tracking started: {data.performanceTrackingStartedAt}
          </div>
        )}
        {msg && (
          <div className="muted small" style={{ marginBottom: 8, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>
            {msg.text}
          </div>
        )}
        <div className="stats-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
          {[
            ['Signals', t.signals],
            ['Profit', t.profitTrades],
            ['SL', t.stoppedTrades],
            ['Win %', t.winRate != null ? `${t.winRate}%` : 'N/A'],
            ['TP1', t.tp1],
            ['TP2', t.tp2],
            ['TP3', t.tp3],
            ['Avg profit', profit.avgProfitPct != null ? `${profit.avgProfitPct}%` : 'N/A'],
          ].map(([label, val]) => (
            <div key={label} className="card" style={{ padding: 10, textAlign: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{val ?? '—'}</div>
              <div className="muted small">{label}</div>
            </div>
          ))}
        </div>

        {data?.statusCounts && (
          <div className="muted small" style={{ marginBottom: 12 }}>
            WATCHING {data.statusCounts.WATCHING} · READY {data.statusCounts.READY} · ONGOING{' '}
            {data.statusCounts.ONGOING} · PROFIT {data.statusCounts.COMPLETED_PROFIT} · STOPPED{' '}
            {data.statusCounts.STOPPED} · INVALIDATED {data.statusCounts.INVALIDATED}
          </div>
        )}

        <div className="section-header" style={{ fontSize: 13 }}>By coin</div>
        <div style={{ overflowX: 'auto', marginBottom: 14 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted">
                <th align="left">Coin</th>
                <th>Sig</th>
                <th>Profit</th>
                <th>SL</th>
                <th>TP1</th>
                <th>TP2</th>
                <th>TP3</th>
              </tr>
            </thead>
            <tbody>
              {(data?.coinStats || []).slice(0, 30).map((r) => (
                <tr key={r.symbol}>
                  <td>{r.symbol}</td>
                  <td align="center">{r.signals}</td>
                  <td align="center">{r.profit}</td>
                  <td align="center">{r.sl}</td>
                  <td align="center">{r.tp1}</td>
                  <td align="center">{r.tp2}</td>
                  <td align="center">{r.tp3}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.coinStats?.length && <div className="muted small">No data</div>}
        </div>

        <div className="section-header" style={{ fontSize: 13 }}>By pattern</div>
        <div style={{ overflowX: 'auto', marginBottom: 14 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted">
                <th align="left">Pattern</th>
                <th>Sig</th>
                <th>Profit</th>
                <th>SL</th>
                <th>TP1</th>
                <th>TP2</th>
                <th>TP3</th>
              </tr>
            </thead>
            <tbody>
              {(data?.patternStats || []).slice(0, 30).map((r) => (
                <tr key={r.pattern}>
                  <td>{r.pattern}</td>
                  <td align="center">{r.signals}</td>
                  <td align="center">{r.profit}</td>
                  <td align="center">{r.sl}</td>
                  <td align="center">{r.tp1}</td>
                  <td align="center">{r.tp2}</td>
                  <td align="center">{r.tp3}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="section-header" style={{ fontSize: 13 }}>Recent completed</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted">
                <th align="left">Time</th>
                <th>Coin</th>
                <th>Dir</th>
                <th>Pattern</th>
                <th>Result</th>
                <th>Hits</th>
                <th>PnL%</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentCompleted || []).map((r, i) => (
                <tr key={i}>
                  <td>{r.time ? String(r.time).slice(0, 16) : '—'}</td>
                  <td>{r.symbol}</td>
                  <td>{r.direction}</td>
                  <td>{r.pattern}</td>
                  <td>{r.result}</td>
                  <td>{r.tpHits}</td>
                  <td>{r.profitPct != null ? r.profitPct : 'N/A'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


export default function HomePage() {
  const [data, setData] = useState({
    ongoing: [],
    ready: [],
    watching: [],
    history: [],
    invalidationCatalog: [],
    recent: [],
    lastScan: null,
    counts: {},
  });
  const [scanStatus, setScanStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const [scanProgress, setScanProgress] = useState(null);
  const [universe, setUniverse] = useState('all'); // 'all' = every coin on the active exchange
  const [liveSignals, setLiveSignals] = useState([]); // this scan only — live prices
  const [nearList, setNearList] = useState([]); // about-to-break radar (manual scan only)
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [autoScanBusy, setAutoScanBusy] = useState(false);
  const [minScoreInput, setMinScoreInput] = useState(80);
  const [minScoreBusy, setMinScoreBusy] = useState(false);
  const [minEntryAtrInput, setMinEntryAtrInput] = useState(0.75);
  const [maxEntryAtrInput, setMaxEntryAtrInput] = useState(4);
  const [telegramMaxAtrInput, setTelegramMaxAtrInput] = useState(2);
  const [maxGapPercentInput, setMaxGapPercentInput] = useState(3);
  const [activeExchange, setActiveExchange] = useState('binance');
  const [bybitKey, setBybitKey] = useState('');
  const [bybitSecret, setBybitSecret] = useState('');
  const [bybitInfo, setBybitInfo] = useState(null);
  const [exBusy, setExBusy] = useState(false);
  const [requireHtf, setRequireHtf] = useState(true);
  const [requireLiq, setRequireLiq] = useState(true);
  const [requireSweepFvg, setRequireSweepFvg] = useState(false);
  const [strategyMode, setStrategyMode] = useState('chart_pattern');
  const [cpMinScore, setCpMinScore] = useState(70);
  const [cpNearMaxAge, setCpNearMaxAge] = useState(30);
  const [cpMinRvol, setCpMinRvol] = useState(1.2);
  const [cpMinRr, setCpMinRr] = useState(1.5);
  const [cpBreakoutAtr, setCpBreakoutAtr] = useState(0.15);
  const [cpMinTp1Rr, setCpMinTp1Rr] = useState(1.0);
  const [cpLiveEntry, setCpLiveEntry] = useState(true);
  const [cpFailedBo, setCpFailedBo] = useState(true);
  const [cpGateModes, setCpGateModes] = useState(() => defaultGateModes({}));
  const [cpElliottWave, setCpElliottWave] = useState(true);
  const [cpTfs, setCpTfs] = useState(['5m', '15m', '30m', '1h', '2h']);
  const CP_PATTERN_OPTIONS = [
    'DOUBLE_TOP', 'DOUBLE_BOTTOM', 'TRIPLE_TOP', 'TRIPLE_BOTTOM',
    'HEAD_AND_SHOULDERS', 'INVERSE_HEAD_AND_SHOULDERS',
    'RECTANGLE', 'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE', 'SYMMETRICAL_TRIANGLE',
    'RISING_WEDGE', 'FALLING_WEDGE', 'BULL_FLAG', 'BEAR_FLAG',
    'CUP_AND_HANDLE', 'INVERSE_CUP_AND_HANDLE', 'ROUNDING_BOTTOM', 'ROUNDING_TOP',
    'BROADENING', 'ASCENDING_BROADENING_WEDGE', 'DESCENDING_BROADENING_WEDGE',
    'BULL_PENNANT', 'BEAR_PENNANT',
    'HORIZONTAL_CHANNEL', 'ASCENDING_CHANNEL', 'DESCENDING_CHANNEL',
    'DIAMOND_TOP', 'DIAMOND_BOTTOM',
    'GARTLEY_BULL', 'GARTLEY_BEAR', 'BAT_BULL', 'BAT_BEAR',
    'BUTTERFLY_BULL', 'BUTTERFLY_BEAR', 'CRAB_BULL', 'CRAB_BEAR',
    'DEEP_CRAB_BULL', 'DEEP_CRAB_BEAR', 'CYPHER_BULL', 'CYPHER_BEAR',
    'SHARK_BULL', 'SHARK_BEAR', 'ABCD_BULL', 'ABCD_BEAR',
    'FIVE_O_BULL', 'FIVE_O_BEAR',
  ];
  // null = ALL selected
  const [cpPatterns, setCpPatterns] = useState(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetSecret, setResetSecret] = useState('');
  const [resetPreview, setResetPreview] = useState(null);
  const [resetMode, setResetMode] = useState('all'); // 'all' | 'history'
  const [enterBusyId, setEnterBusyId] = useState(null);
  const [activeTab, setActiveTab] = useState('signals');

  // Polling safety: one request at a time; a refresh requested while one is
  // in flight is queued once (never overlapping / never a request storm).
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  // Bumped by Reset: responses that started before a reset are discarded so
  // deleted signals can never reappear from a slow in-flight request.
  const epochRef = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const myEpoch = epochRef.current;
    try {
      const noStore = { cache: 'no-store' };
      const [sigRes, scanRes] = await Promise.all([
        fetch(`/api/signals?_=${Date.now()}`, noStore),
        fetch(`/api/scan?_=${Date.now()}`, noStore),
      ]);
      const sig = await safeJson(sigRes);
      const scan = await safeJson(scanRes);
      if (myEpoch !== epochRef.current) return; // stale (reset happened meanwhile)
      if (!sigRes.ok || sig.ok === false || (sig.error && !Array.isArray(sig.ongoing))) {
        // Real DB/API error: show it, keep last good data (do NOT blank the dashboard)
        setError(sig.error || `Signals API error (${sigRes.status})`);
        return;
      }
      setError(null);
      // Always keep a stable shape — prevents client crash if API returns error-only JSON
      const watching = Array.isArray(sig.watching) ? sig.watching : [];
      setData({
        ongoing: Array.isArray(sig.ongoing) ? sig.ongoing : [],
        ready: Array.isArray(sig.ready) ? sig.ready : [],
        watching,
        history: Array.isArray(sig.history) ? sig.history : [],
        invalidationCatalog: Array.isArray(sig.invalidationCatalog) ? sig.invalidationCatalog : [],
        recent: Array.isArray(sig.recent) ? sig.recent : [],
        lastScan: sig.lastScan ?? null,
        counts: sig.counts && typeof sig.counts === 'object' ? sig.counts : {},
        error: sig.error || null,
      });
      // Near-breakouts from DB (API builds nearBreakouts from WATCHING metadata)
      if (Array.isArray(sig.nearBreakouts)) {
        setNearList(sig.nearBreakouts);
      } else {
        const fromDbNear = watching
          .filter((s) => s?.metadata?.nearBreakout || s?.metadata?.kind === 'NEAR_BREAKOUT')
          .map((s) => ({
            signal_id: s.signal_id,
            symbol: s.symbol,
            pattern: s.metadata?.pattern || s.metadata?.patternType,
            patternTf: s.metadata?.patternTf,
            direction: s.direction,
            dir: s.direction,
            state: s.metadata?.nearState || 'NEAR',
            score: s.score,
            price: s.current_price ?? s.last_price,
            entry: s.entry,
            sl: s.sl,
            tp1: s.tp1,
            tp2: s.tp2,
            tp3: s.tp3,
            rr: s.rr,
            gapAtr: s.atr_distance ?? s.metadata?.gapAtr,
            gapPct: s.distance_percent ?? s.metadata?.gapPct,
            conf: s.metadata?.conf,
            trigger: s.metadata?.trigger || s.metadata?.breakoutLevel,
          }));
        setNearList(fromDbNear);
      }
      setScanStatus(scan && typeof scan === 'object' ? scan : null);
      if (typeof scan.auto_scan_enabled === 'boolean') setAutoScanEnabled(scan.auto_scan_enabled);
      if (scan.config?.minScore != null) setMinScoreInput(scan.config.minScore);
      if (scan.config?.minEntryATR != null) setMinEntryAtrInput(scan.config.minEntryATR);
      if (scan.config?.maxEntryATR != null) setMaxEntryAtrInput(scan.config.maxEntryATR);
      if (scan.config?.telegramMaxATR != null) setTelegramMaxAtrInput(scan.config.telegramMaxATR);
      if (scan.config?.maxGapPercent != null) setMaxGapPercentInput(scan.config.maxGapPercent);
      if (scan.exchange) setActiveExchange(scan.exchange);
      else if (scan.config?.exchange) setActiveExchange(scan.config.exchange);
      if (typeof scan.config?.requireHtfAligned === 'boolean') setRequireHtf(scan.config.requireHtfAligned);
      if (typeof scan.config?.requireLiquidityEdge === 'boolean') setRequireLiq(scan.config.requireLiquidityEdge);
      if (typeof scan.config?.requireSweepOrFvg === 'boolean') setRequireSweepFvg(scan.config.requireSweepOrFvg);
      const cpc = scan.config?.chartPatternConfig;
      if (cpc && typeof cpc === 'object') {
        if (cpc.minSignalScore != null) setCpMinScore(+cpc.minSignalScore);
        if (cpc.nearMaxPatternAge != null) setCpNearMaxAge(+cpc.nearMaxPatternAge);
        if (cpc.minRelativeVolume != null) setCpMinRvol(+cpc.minRelativeVolume);
        if (cpc.minRR != null) setCpMinRr(+cpc.minRR);
        if (cpc.breakoutAtrMin != null) setCpBreakoutAtr(+cpc.breakoutAtrMin);
        if (cpc.minTp1RR != null) setCpMinTp1Rr(+cpc.minTp1RR);
        if (typeof cpc.nearEntryOnLivePrice === 'boolean') setCpLiveEntry(cpc.nearEntryOnLivePrice);
        if (typeof cpc.failedBreakoutInvalidate === 'boolean') setCpFailedBo(cpc.failedBreakoutInvalidate);
        setCpGateModes({ ...defaultGateModes(cpc), ...(cpc.gateModes || {}) });
        if (typeof cpc.waveAnalysisEnabled === 'boolean') setCpElliottWave(cpc.waveAnalysisEnabled);
        if (Array.isArray(cpc.patternTfs) && cpc.patternTfs.length) setCpTfs(cpc.patternTfs);
        if (cpc.enabledPatterns === 'ALL' || cpc.enabledPatterns == null) setCpPatterns(null);
        else if (Array.isArray(cpc.enabledPatterns)) setCpPatterns(cpc.enabledPatterns);
      }
      if (scan.config?.scanUniverse != null) setUniverse(scan.config.scanUniverse);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      // A request orphaned by Reset must not release the lock of the newer request
      if (myEpoch === epochRef.current) {
        inFlightRef.current = false;
        if (queuedRef.current) {
          queuedRef.current = false;
          refresh();
        }
      }
    }
  }, []);

  useEffect(() => {
    // Database-backed refresh every ~7s while the tab is visible (single interval,
    // cleaned up on unmount). Realtime is not required — polling is the source.
    refresh();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    }, 7000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const toggleAutoScan = useCallback(async () => {
    setAutoScanBusy(true);
    try {
      const path = autoScanEnabled ? '/api/scan/stop' : '/api/scan/start';
      const res = await fetch(path, { method: 'POST' });
      const data = await safeJson(res);
      if (!res.ok) {
        setScanMsg({ ok: false, text: data.error || 'Toggle failed' });
        return;
      }
      setAutoScanEnabled(!!data.auto_scan_enabled);
      setScanMsg({
        ok: true,
        text: data.auto_scan_enabled
          ? 'Auto-scan ON — cron will run when scheduled (or external cron)'
          : 'Auto-scan OFF — cron will skip',
      });
      refresh();
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setAutoScanBusy(false);
    }
  }, [autoScanEnabled, refresh]);

  const saveMinScore = useCallback(async () => {
    setMinScoreBusy(true);
    try {
      const res = await fetch('/api/settings/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minScore: minScoreInput,
          minEntryATR: minEntryAtrInput,
          maxEntryATR: maxEntryAtrInput,
          telegramMaxATR: telegramMaxAtrInput,
          maxGapPercent: maxGapPercentInput,
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
            patternTfs: cpTfs,
            enabledPatterns: cpPatterns == null ? 'ALL' : cpPatterns,
          },
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        setScanMsg({ ok: false, text: data.error || 'Failed to save settings' });
        return;
      }
      if (data.minScore != null) setMinScoreInput(data.minScore);
      if (data.minEntryATR != null) setMinEntryAtrInput(data.minEntryATR);
      if (data.maxEntryATR != null) setMaxEntryAtrInput(data.maxEntryATR);
      if (data.telegramMaxATR != null) setTelegramMaxAtrInput(data.telegramMaxATR);
      if (data.maxGapPercent != null) setMaxGapPercentInput(data.maxGapPercent);
      if (typeof data.requireHtfAligned === 'boolean') setRequireHtf(data.requireHtfAligned);
      if (typeof data.requireLiquidityEdge === 'boolean') setRequireLiq(data.requireLiquidityEdge);
      if (typeof data.requireSweepOrFvg === 'boolean') setRequireSweepFvg(data.requireSweepOrFvg);
      if (data.strategyMode) setStrategyMode(data.strategyMode);
      if (data.chartPatternConfig?.nearMaxPatternAge != null) {
        setCpNearMaxAge(+data.chartPatternConfig.nearMaxPatternAge);
      }
      setScanMsg({ ok: true, text: data.msg || 'Settings saved' });
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setMinScoreBusy(false);
    }
  }, [minScoreInput, minEntryAtrInput, maxEntryAtrInput, telegramMaxAtrInput, maxGapPercentInput, requireHtf, requireLiq, requireSweepFvg, strategyMode, cpMinScore, cpNearMaxAge, cpMinRvol, cpMinRr, cpBreakoutAtr, cpMinTp1Rr, cpLiveEntry, cpFailedBo, cpGateModes, cpElliottWave, cpTfs, cpPatterns]);

  const loadBybit = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/bybit');
      const data = await safeJson(res);
      if (res.ok) setBybitInfo(data);
    } catch (_) {}
  }, []);

  const switchExchange = useCallback(async (ex) => {
    setExBusy(true);
    try {
      const res = await fetch('/api/settings/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: ex }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        setScanMsg({ ok: false, text: data.error || 'Switch failed' });
        return;
      }
      setActiveExchange(data.exchange);
      setScanMsg({ ok: true, text: data.msg });
      await refresh();
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setExBusy(false);
    }
  }, [refresh]);

  const saveBybitKeys = useCallback(async () => {
    setExBusy(true);
    try {
      const res = await fetch('/api/settings/bybit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: bybitKey, apiSecret: bybitSecret }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        setScanMsg({ ok: false, text: data.error || 'Bybit save failed' });
        return;
      }
      setBybitKey('');
      setBybitSecret('');
      setBybitInfo(data);
      setScanMsg({ ok: true, text: data.msg || 'Bybit keys saved' });
      await loadBybit();
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setExBusy(false);
    }
  }, [bybitKey, bybitSecret, loadBybit]);

  const enterNowMarket = useCallback(async (s) => {
    const sid = s.signal_id || s.symbol + (s.direction || '');
    setEnterBusyId(sid);
    setScanMsg(null);
    try {
      const res = await fetch('/api/auto-trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enterNow',
          signal: s,
          marketPrice: s.current_price ?? s.price ?? s.entry,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScanMsg({ ok: false, text: data.error || 'Enter failed' });
      } else {
        setScanMsg({
          ok: true,
          text: data.msg || 'Bybit TESTNET order placed',
        });
      }
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setEnterBusyId(null);
    }
  }, []);


  const openResetModal = useCallback(async () => {
    setShowResetConfirm(true);
    setResetPreview(null);
    setResetMode('all');
    try {
      const q = resetSecret ? `?secret=${encodeURIComponent(resetSecret)}` : '';
      const res = await fetch(`/api/admin/reset-signals${q}`);
      const data = await safeJson(res);
      if (res.ok && data?.ok) setResetPreview(data);
      else if (data?.error) setResetPreview({ error: data.error, total: 0, preview: [] });
    } catch (e) {
      setResetPreview({ error: e.message, total: 0, preview: [] });
    }
  }, [resetSecret]);

  const loadResetPreview = useCallback(async () => {
    setResetBusy(true);
    try {
      const q = resetSecret ? `?secret=${encodeURIComponent(resetSecret)}` : '';
      const res = await fetch(`/api/admin/reset-signals${q}`);
      const data = await safeJson(res);
      if (res.ok && data?.ok) setResetPreview(data);
      else setResetPreview({ error: data?.error || 'Preview failed', total: 0, preview: [] });
    } catch (e) {
      setResetPreview({ error: e.message, total: 0, preview: [] });
    } finally {
      setResetBusy(false);
    }
  }, [resetSecret]);

  const confirmResetSignals = useCallback(async () => {
    setResetBusy(true);
    try {
      const res = await fetch('/api/admin/reset-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, secret: resetSecret, mode: resetMode }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        setScanMsg({
          ok: false,
          text: data.error || data.hint || 'Reset failed',
        });
        return;
      }
      setShowResetConfirm(false);
      setResetSecret('');
      setResetPreview(null);
      setScanMsg({
        ok: true,
        text: data.msg || `Deleted ${data.signalsDeleted ?? '?'} signals`,
      });
      // Invalidate any in-flight refresh, then clear ALL signal-related UI state
      epochRef.current += 1;
      inFlightRef.current = false;
      queuedRef.current = false;
      if (resetMode === 'all') {
        setData({
          ongoing: [], ready: [], watching: [], history: [], recent: [],
          invalidationCatalog: [],
          lastScan: null, counts: {},
        });
        setScanStatus(null);
        setLiveSignals([]);
        setNearList([]);
      } else {
        setLiveSignals((prev) => prev.filter((x) => ['WATCHING', 'READY', 'ONGOING'].includes(String(x?.status || '').toUpperCase())));
      }
      setScanProgress(null);
      await refresh(); // authoritative state straight from the (now empty) DB
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      setResetBusy(false);
    }
  }, [refresh, resetSecret, resetMode]);

  const scanNow = useCallback(async () => {
    setScanning(true);
    setScanMsg(null);
    setScanProgress(null);
    setLiveSignals([]); // temporary scan-result list only; persistent list comes from /api/signals
    let nearAcc = [];

    let totalChunks = 1;
    let chunkIndex = 1;
    let sumSymbols = 0;
    let sumCreated = 0;
    let sumTelegram = 0;
    let sumWatching = 0;
    let sumReady = 0;
    let sumOngoing = 0;
    let createdList = [];
    let totalMarket = null;
    let partialRetries = 0;
    const MAX_PARTIAL_RETRIES = 3;
    let ranAnyChunk = false;
    // Hobby-safe: ~15 symbols per request (~20–35s)
    const chunkSize = 15;

    try {
      let first = true;
      while (chunkIndex <= totalChunks) {
        setScanProgress({ chunk: chunkIndex, total: totalChunks, retrying: partialRetries > 0 });
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            universe: universe,
            chunkSize,
            resetCursor: first,
            lifecycle: 'skip', // statuses (watching/ready/ongoing) update only after ALL chunks finish
          }),
        });
        first = false;
        ranAnyChunk = true;
        const result = await safeJson(res);
        if (!result || typeof result !== 'object') {
          setScanMsg({ ok: false, text: 'Invalid scan response' });
          break;
        }

        if (!res.ok || result.error) {
          setScanMsg({ ok: false, text: result.error || 'Scan failed' });
          break;
        }
        if (result.skipped) {
          setScanMsg({ ok: false, text: result.reason || 'Scan already running — wait ~1 min' });
          break;
        }

        const got = result.symbolsScanned || 0;
        sumSymbols += got;
        sumCreated += result.signalsCreated || 0;
        sumTelegram += result.telegramSent || 0;
        if (result.watching_count != null) sumWatching = result.watching_count;
        if (result.ready_count != null) sumReady = result.ready_count;
        if (result.ongoing_count != null) sumOngoing = result.ongoing_count;
        if (Array.isArray(result.nearBreakouts) && result.nearBreakouts.length) {
          const m = new Map(nearAcc.map((x) => [x.signal_id, x]));
          for (const x of result.nearBreakouts) {
            const prev = m.get(x.signal_id);
            if (!prev || (x.score || 0) > (prev.score || 0)) m.set(x.signal_id, x);
          }
          nearAcc = [...m.values()].sort((a, b) => {
            const ga = Math.max(0, a.gapAtr ?? 9);
            const gb = Math.max(0, b.gapAtr ?? 9);
            if (Math.abs(ga - gb) > 0.02) return ga - gb; // closest to the level first
            return (b.score || 0) - (a.score || 0);
          });
          setNearList(nearAcc);
        }
        if (Array.isArray(result.created)) createdList = createdList.concat(result.created);
        if (Array.isArray(result.liveSignals)) {
          createdList = createdList.concat(
            result.liveSignals.filter(
              (x) => !createdList.some((y) => y.signal_id === x.signal_id)
            )
          );
        }

        if (result.coverage) {
          totalChunks = result.coverage.cyclesToFullCoverage || 1;
          totalMarket = result.coverage.totalSymbols;
        } else {
          totalChunks = 1;
        }

        await refresh();

        // Soft timeout but some work done → cursor advanced; move to next chunk
        if (result.partial) {
          if (got > 0) {
            partialRetries = 0;
            if (chunkIndex >= totalChunks) {
              const map = new Map();
              for (const s of createdList) {
                if (!s?.signal_id) continue;
                const prev = map.get(s.signal_id);
                if (!prev || (s.score || 0) > (prev.score || 0)) map.set(s.signal_id, s);
              }
              const live = [...map.values()].sort((a, b) => {
                const da = a.atr_distance ?? 999;
                const db = b.atr_distance ?? 999;
                if (Math.abs(da - db) > 0.01) return da - db;
                return (b.score || 0) - (a.score || 0);
              });
              setLiveSignals(live);
              const closeN = live.filter((x) => x.is_close || (x.atr_distance != null && x.atr_distance <= 0.5)).length;
              const at = result.autoTrade;
              const atMsg = at
                ? ` · auto ${at.autoTradesPlaced ?? 0}/${at.autoTradesAttempted ?? 0}`
                : '';
              setScanMsg({
                ok: true,
                text: `Done — ${sumSymbols} coins · ${live.length} signals · ${nearAcc.length} about to break · ${closeN} close · TG ${sumTelegram} · ${universe === 'all' ? 'All coins' : 'Top ' + universe}${atMsg}`,
              });
              break;
            }
            chunkIndex++;
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          partialRetries++;
          if (partialRetries > MAX_PARTIAL_RETRIES) {
            setScanMsg({
              ok: false,
              text: `Chunk ${chunkIndex}/${totalChunks} timed out with 0 symbols. Click Scan Now again. (${universe === 'all' ? 'All coins' : 'Top ' + universe})`,
            });
            break;
          }
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }

        partialRetries = 0;

        if (chunkIndex >= totalChunks) {
          const marketText = totalMarket
            ? ` — top ${totalMarket} coins fully scanned`
            : '';
          // Dedupe by signal_id, sort by score
          const map = new Map();
          for (const s of createdList) {
            if (!s?.signal_id) continue;
            const prev = map.get(s.signal_id);
            if (!prev || (s.score || 0) > (prev.score || 0)) map.set(s.signal_id, s);
          }
          const live = [...map.values()].sort((a, b) => {
            const da = a.atr_distance ?? 999;
            const db = b.atr_distance ?? 999;
            if (Math.abs(da - db) > 0.01) return da - db; // closest entry first
            return (b.score || 0) - (a.score || 0);
          });
          setLiveSignals(live);
          const closeN = live.filter((x) => x.is_close || (x.atr_distance != null && x.atr_distance <= 0.5)).length;
          const at = result.autoTrade;
          const atMsg = at
            ? ` · auto ${at.autoTradesPlaced ?? 0}/${at.autoTradesAttempted ?? 0}`
            : '';
          setScanMsg({
            ok: true,
            text: `Done — ${sumSymbols} coins · ${live.length} signals · ${nearAcc.length} about to break · ${closeN} close · ${universe === 'all' ? 'All coins' : 'Top ' + universe}${atMsg}`,
          });
          break;
        }
        chunkIndex++;
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) {
      setScanMsg({ ok: false, text: e.message });
    } finally {
      // All chunks are finished → NOW update WATCHING / READY (and READY → ONGOING for signals
      // that were already READY before this scan began).
      if (ranAnyChunk) {
        try {
          setScanProgress({ chunk: totalChunks, total: totalChunks, finalizing: true });
          const fr = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ universe, chunkSize, lifecycle: 'only' }),
          });
          const fj = await safeJson(fr);
          if (!fr.ok || fj?.error) {
            setScanMsg({ ok: false, text: `Scan finished but status update failed: ${fj?.error || fr.status}` });
          }
        } catch (fe) {
          setScanMsg({ ok: false, text: `Scan finished but status update failed: ${fe.message}` });
        }
      }
      setScanning(false);
      setScanProgress(null);
      // Always finish by loading the persisted signals from the database
      await refresh();
    }
  }, [refresh, universe]);

  const safeData = data && typeof data === 'object' ? data : { counts: {}, history: [], lastScan: null };
  const c = safeData.counts || {};
  const last = safeData.lastScan || scanStatus?.lastScan;

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="header-brand">
            <h1>CRYPTO SIGNAL DESK</h1>
            <span className="badge live">LIVE</span>
            <span className="badge muted-badge">{activeExchange === 'bybit' ? 'BYBIT' : 'BINANCE'}</span>
          </div>
          <div className="header-actions">
            <select
              className="scan-select"
              value={universe}
              disabled={scanning}
              onChange={(e) => setUniverse(e.target.value === 'all' ? 'all' : +e.target.value)}
              title="Top N by volume"
            >
              <option value="all">All coins</option>
              <option value={50}>Top 50</option>
              <option value={100}>Top 100</option>
              <option value={150}>Top 150</option>
              <option value={200}>Top 200</option>
              <option value={250}>Top 250</option>
            </select>
            <button className="scan-btn" onClick={scanNow} disabled={scanning}>
              {scanning
                ? scanProgress
                  ? scanProgress.finalizing
                    ? '⏳ Updating statuses…'
                    : `⏳ ${scanProgress.chunk}/${scanProgress.total}`
                  : '⏳ Scanning…'
                : '🔍 Scan Now'}
            </button>
            <button
              className="scan-btn"
              onClick={toggleAutoScan}
              disabled={autoScanBusy}
              style={{
                background: autoScanEnabled ? 'var(--green)' : '#1e2329',
                color: autoScanEnabled ? '#000' : 'var(--text)',
              }}
            >
              {autoScanBusy ? '…' : autoScanEnabled ? '⏹ Auto ON' : '▶ Auto OFF'}
            </button>
          </div>
          <div className="counts">
            <span className="c-on">ON {c.ongoing ?? 0}</span>
            <span className="c-re">RD {c.ready ?? 0}</span>
            <span className="c-wa">WT {c.watching ?? 0}</span>
            <span className="c-re">LIVE {liveSignals.length}</span>
          </div>
        </div>
        <div className="header-meta">
          <span className="meta-item">Last: {last?.completed_at ? formatLK(last.completed_at) : '—'}</span>
          <span className="meta-item">Next: {scanStatus?.nextScan ? formatLK(scanStatus.nextScan) : '—'}</span>
          <span className="meta-item">Score ≥ {scanStatus?.config?.minScore ?? minScoreInput}</span>
          <span className="meta-item">Gap ≤ {scanStatus?.config?.maxGapPercent ?? maxGapPercentInput}%</span>
        </div>
      </header>

{showResetConfirm && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.7)',
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
            }}
          >
            <div
              className="reset-dialog"
              style={{
                background: '#ffffff',
                border: '1px solid #dce3ed',
                borderRadius: 12,
                padding: 24,
                maxWidth: 480,
                width: '100%',
              }}
            >
              <h3 style={{ marginTop: 0, color: '#2459c6' }}>Saved signals — review before delete</h3>
              <p style={{ color: '#526176', fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                Database එකේ තියෙන signals මුලින්ම බලන්න. ඊට පස්සේ delete mode එක තෝරලා confirm කරන්න.
                Settings / Telegram නැති වෙන්නේ නෑ.
              </p>
              <label style={{ display: 'block', fontSize: 13, color: '#526176', marginTop: 8 }}>
                CRON_SECRET
                <input
                  type="password"
                  value={resetSecret}
                  onChange={(e) => setResetSecret(e.target.value)}
                  placeholder="Vercel CRON_SECRET"
                  autoComplete="off"
                  style={{
                    display: 'block',
                    width: '100%',
                    marginTop: 6,
                    padding: '8px 10px',
                    background: '#ffffff',
                    border: '1px solid #cbd5e1',
                    borderRadius: 6,
                    color: 'var(--text)',
                    boxSizing: 'border-box',
                  }}
                />
              </label>
              <button
                className="scan-btn"
                onClick={loadResetPreview}
                disabled={resetBusy}
                style={{ marginTop: 10, background: '#326de6', color: '#fff', width: '100%' }}
              >
                {resetBusy ? '…' : '🔄 Load saved signals from DB'}
              </button>
              {resetPreview && (
                <div style={{ marginTop: 12, fontSize: 13, color: '#1d2939', maxHeight: 220, overflow: 'auto', border: '1px solid #dce3ed', borderRadius: 8, padding: 10, background: '#f8fafc' }}>
                  {resetPreview.error ? (
                    <div style={{ color: '#f6465d' }}>{resetPreview.error}</div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 8, color: '#855b0a' }}>
                        Total <b>{resetPreview.total ?? 0}</b>
                        {' · '}Active <b>{resetPreview.activeCount ?? 0}</b>
                        {' · '}History <b>{resetPreview.historyCount ?? 0}</b>
                      </div>
                      {resetPreview.counts && (
                        <div style={{ color: '#526176', marginBottom: 8, fontSize: 12 }}>
                          WT {resetPreview.counts.WATCHING || 0}
                          {' · '}RD {resetPreview.counts.READY || 0}
                          {' · '}ON {resetPreview.counts.ONGOING || 0}
                          {' · '}Done {resetPreview.counts.COMPLETED_PROFIT || 0}
                          {' · '}Stop {resetPreview.counts.STOPPED || 0}
                          {' · '}Inv {resetPreview.counts.INVALIDATED || 0}
                        </div>
                      )}
                      {(resetPreview.preview || []).slice(0, 25).map((s) => (
                        <div key={s.signal_id} style={{ padding: '4px 0', borderBottom: '1px solid #dce3ed', fontSize: 12 }}>
                          <b>{s.symbol}</b> {s.direction} · {s.status} · score {s.score ?? '—'}
                          {s.pattern ? ` · ${s.pattern}` : ''}
                        </div>
                      ))}
                      {(resetPreview.preview || []).length === 0 && (
                        <div className="muted">No rows in database.</div>
                      )}
                    </>
                  )}
                </div>
              )}
              <div style={{ marginTop: 12, fontSize: 13 }}>
                <div style={{ color: '#526176', marginBottom: 6 }}>Delete mode</div>
                <label className="chip-check" style={{ marginRight: 12 }}>
                  <input type="radio" name="resetMode" checked={resetMode === 'history'} onChange={() => setResetMode('history')} />
                  {' '}History only (COMPLETED / STOPPED / INVALIDATED)
                </label>
                <label className="chip-check">
                  <input type="radio" name="resetMode" checked={resetMode === 'all'} onChange={() => setResetMode('all')} />
                  {' '}All signals (WATCHING + READY + ONGOING + history)
                </label>
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  className="scan-btn"
                  onClick={() => { setShowResetConfirm(false); setResetPreview(null); }}
                  disabled={resetBusy}
                  style={{ background: '#eef2f7', color: '#334155' }}
                >
                  Cancel
                </button>
                <button
                  className="scan-btn"
                  onClick={confirmResetSignals}
                  disabled={resetBusy}
                  style={{ background: '#b4233c', color: '#fff' }}
                >
                  {resetBusy ? '…' : resetMode === 'history' ? 'Delete history only' : 'Delete ALL signals'}
                </button>
              </div>
            </div>
          </div>
        )}
      <main className="main">
        {scanMsg && (
          <div className={`section scan-msg-box ${scanMsg.ok ? 'ok' : 'error-box'}`}>
            {scanMsg.ok ? '✅' : '⚠️'} {scanMsg.text}
          </div>
        )}

        {activeTab === 'settings' && (
        <>
        {/* Scanner settings — not in sticky header so nothing is clipped */}
        <div className="section settings-panel">
          <div className="section-header">⚙️ SCANNER SETTINGS</div>
          <div className="section-body settings-grid">
            <div className="settings-group">
              <div className="settings-label">Exchange</div>
              <div className="btn-row">
                <button
                  className={`chip-btn ${activeExchange === 'binance' ? 'chip-on' : ''}`}
                  disabled={exBusy}
                  onClick={() => switchExchange('binance')}
                >
                  Binance
                </button>
                <button
                  className={`chip-btn ${activeExchange === 'bybit' ? 'chip-on bybit' : ''}`}
                  disabled={exBusy}
                  onClick={() => switchExchange('bybit')}
                >
                  Bybit
                </button>
              </div>
            </div>
            <div className="settings-group">
              <div className="settings-label">Min score</div>
              <input type="number" min={50} max={100} className="settings-input" value={minScoreInput}
                disabled={minScoreBusy} onChange={(e) => setMinScoreInput(+e.target.value)} />
            </div>
            <div className="settings-group">
              <div className="settings-label">Entry ATR min–max</div>
              <div className="btn-row">
                <input type="number" min={0} max={5} step={0.25} className="settings-input narrow" value={minEntryAtrInput}
                  disabled={minScoreBusy} onChange={(e) => setMinEntryAtrInput(+e.target.value)} />
                <span className="muted">–</span>
                <input type="number" min={0.5} max={20} step={0.5} className="settings-input narrow" value={maxEntryAtrInput}
                  disabled={minScoreBusy} onChange={(e) => setMaxEntryAtrInput(+e.target.value)} />
              </div>
            </div>
            <div className="settings-group">
              <div className="settings-label">TG max ATR</div>
              <input type="number" min={0.5} max={20} step={0.5} className="settings-input narrow" value={telegramMaxAtrInput}
                disabled={minScoreBusy} onChange={(e) => setTelegramMaxAtrInput(+e.target.value)} />
            </div>
            <div className="settings-group">
              <div className="settings-label">Max gap %</div>
              <input type="number" min={0.5} max={50} step={0.5} className="settings-input narrow" value={maxGapPercentInput}
                disabled={minScoreBusy} onChange={(e) => setMaxGapPercentInput(+e.target.value)} />
            </div>
            {(
              <>
                <div className="settings-group" style={{ gridColumn: '1 / -1' }}>
                  <div className="settings-label" style={{ color: '#855b0a' }}>Strategy 2 — Chart Pattern settings</div>
                </div>
                <div className="settings-group">
                  <div className="settings-label">CP min score</div>
                  <input type="number" min={50} max={100} className="settings-input" value={cpMinScore}
                    disabled={minScoreBusy} onChange={(e) => setCpMinScore(+e.target.value)} />
                  <label className="muted small">Max pattern age (candles, 0=off)
                    <input type="number" min={0} max={500} className="settings-input" value={cpNearMaxAge}
                      disabled={minScoreBusy} onChange={(e) => setCpNearMaxAge(+e.target.value)} />
                  </label>
                </div>
                <div className="settings-group">
                  <div className="settings-label">Min RVOL</div>
                  <input type="number" min={0.5} max={5} step={0.1} className="settings-input narrow" value={cpMinRvol}
                    disabled={minScoreBusy} onChange={(e) => setCpMinRvol(+e.target.value)} />
                </div>
                <div className="settings-group">
                  <div className="settings-label">Min RR</div>
                  <input type="number" min={1} max={5} step={0.1} className="settings-input narrow" value={cpMinRr}
                    disabled={minScoreBusy} onChange={(e) => setCpMinRr(+e.target.value)} />
                </div>
                <div className="settings-group">
                  <div className="settings-label">Min TP1 RR</div>
                  <input type="number" min={0.5} max={5} step={0.1} className="settings-input narrow" value={cpMinTp1Rr}
                    disabled={minScoreBusy} onChange={(e) => setCpMinTp1Rr(+e.target.value)} />
                </div>
                <div className="settings-group">
                  <div className="settings-label">Breakout min ATR</div>
                  <input type="number" min={0.05} max={2} step={0.05} className="settings-input narrow" value={cpBreakoutAtr}
                    disabled={minScoreBusy} onChange={(e) => setCpBreakoutAtr(+e.target.value)} />
                </div>
                <div className="settings-group" style={{ gridColumn: '1 / -1' }}>
                  <div className="settings-label">Pattern timeframes (scan all selected)</div>
                  <div className="btn-row wrap" style={{ gap: 8 }}>
                    {['5m', '15m', '30m', '1h', '2h', '4h', '1d'].map((tf) => {
                      const on = cpTfs.includes(tf);
                      return (
                        <button
                          key={tf}
                          type="button"
                          className={`chip-btn ${on ? 'chip-on' : ''}`}
                          disabled={minScoreBusy}
                          onClick={() =>
                            setCpTfs((prev) =>
                              prev.includes(tf) ? (prev.length > 1 ? prev.filter((x) => x !== tf) : prev) : [...prev, tf]
                            )
                          }
                          style={{
                            background: on ? '#f0b90b' : '#1e2329',
                            color: on ? '#0b0e11' : '#eaecef',
                            fontWeight: 700,
                            padding: '8px 14px',
                          }}
                        >
                          {tf.toUpperCase()}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={minScoreBusy}
                      onClick={() => setCpTfs(['5m', '15m', '30m', '1h', '2h', '4h', '1d'])}
                      style={{ background: '#2b3139', color: '#eaecef', fontWeight: 600, padding: '8px 14px' }}
                    >
                      All TF
                    </button>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    Select timeframes then press Save filters. More timeframes = slower full-market cycle.
                  </div>
                </div>
                <div className="settings-group" style={{ gridColumn: '1 / -1' }}>
                  <div className="settings-label">Patterns to scan (select which types fire signals)</div>
                  <div className="btn-row wrap" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="chip-btn"
                      disabled={minScoreBusy}
                      onClick={() => setCpPatterns(null)}
                      style={{
                        background: cpPatterns == null ? '#f0b90b' : '#1e2329',
                        color: cpPatterns == null ? '#0b0e11' : '#eaecef',
                        fontWeight: 700,
                        padding: '6px 12px',
                      }}
                    >
                      All patterns
                    </button>
                    {CP_PATTERN_OPTIONS.map((pt) => {
                      const on = cpPatterns == null ? true : cpPatterns.includes(pt);
                      return (
                        <button
                          key={pt}
                          type="button"
                          className={`chip-btn ${on ? 'chip-on' : ''}`}
                          disabled={minScoreBusy}
                          onClick={() =>
                            setCpPatterns((prev) => {
                              if (prev == null) {
                                // was ALL → now only this one off means all except this
                                return CP_PATTERN_OPTIONS.filter((x) => x !== pt);
                              }
                              if (prev.includes(pt)) {
                                const next = prev.filter((x) => x !== pt);
                                return next.length ? next : prev; // keep at least one
                              }
                              const next = [...prev, pt];
                              return next.length === CP_PATTERN_OPTIONS.length ? null : next;
                            })
                          }
                          style={{
                            background: on ? '#0ecb81' : '#1e2329',
                            color: on ? '#0b0e11' : '#848e9c',
                            fontWeight: 600,
                            padding: '6px 10px',
                            fontSize: 11,
                          }}
                          title={pt}
                        >
                          {pt.replace(/_/g, ' ')}
                        </button>
                      );
                    })}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    Only selected pattern types produce signals. Save filters after changing.
                  </div>
                </div>
                <div className="settings-group" style={{ gridColumn: '1 / -1' }}>
                  <div className="btn-row wrap">
                    <label className="chip-check"><input type="checkbox" checked={cpElliottWave} disabled={minScoreBusy}
                      onChange={(e) => setCpElliottWave(e.target.checked)} /> Elliott Wave analysis</label>
                    <label className="chip-check"><input type="checkbox" checked={cpLiveEntry} disabled={minScoreBusy}
                      onChange={(e) => setCpLiveEntry(e.target.checked)} /> Enter when live price crosses entry (don't wait candle close)</label>
                    <label className="chip-check"><input type="checkbox" checked={cpFailedBo} disabled={minScoreBusy}
                      onChange={(e) => setCpFailedBo(e.target.checked)} /> Invalidate when candle closes back inside (failed breakout)</label>
                  </div>
                </div>
                <div className="settings-group" style={{ gridColumn: '1 / -1' }}>
                  <div className="settings-label">Gates — HARD = fail → signal rejected · SOFT = fail → only score −6</div>
                  <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
                    {GATE_DEFS.map((g) => {
                      const hard = cpGateModes[g.key] !== 'soft';
                      return (
                        <div key={g.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{g.label}</div>
                            <div className="muted" style={{ fontSize: 12 }}>{g.hint}</div>
                          </div>
                          <button
                            type="button"
                            disabled={minScoreBusy}
                            onClick={() => setCpGateModes((prev) => ({ ...prev, [g.key]: hard ? 'soft' : 'hard' }))}
                            style={{
                              flex: '0 0 auto',
                              minWidth: 72,
                              padding: '8px 12px',
                              borderRadius: 999,
                              border: 'none',
                              fontWeight: 700,
                              background: hard ? '#d6455d' : '#e6a700',
                              color: '#fff',
                            }}
                          >
                            {hard ? 'HARD' : 'SOFT'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    Change then press Save filters. Minimum score still applies, so too many SOFT fails can still drop a signal.
                  </div>
                </div>
              </>
            )}

            <div className="settings-group settings-actions">
              <button className="scan-btn" onClick={saveMinScore} disabled={minScoreBusy}>
                {minScoreBusy ? '…' : 'Save filters'}
              </button>
              <button className="scan-btn danger-btn" onClick={openResetModal} disabled={resetBusy}>
                Reset signals
              </button>
            </div>
          </div>
        </div>
        </>
        )}


        {error && (
          <div className="section error-box">
            <b>Error:</b> {error}
            {process.env.NODE_ENV !== 'production' && (
              <div className="muted small">
                Dev tip: run without Supabase uses in-memory store. For production set SUPABASE_* env vars.
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && <ClientErrorBoundary><BybitTradingDesk /></ClientErrorBoundary>}

        {activeTab === 'scanner' && <AnalyzePanel />}
        {activeTab === 'settings' && <TelegramSettingsPanel />}

        {activeTab === 'settings' && (
        <div className="section settings-support">
          <div className="section-header">📊 SERVER STATUS</div>
          <div className="section-body flex">
            <div>
              Status:{' '}
              <b className="pos">
                {scanStatus?.dbReady ? 'ONLINE' : 'DB NOT READY'}
              </b>
            </div>
            <div>
              Score ≥ <b>{scanStatus?.config?.minScore ?? minScoreInput}</b> · Entry <b>{scanStatus?.config?.minEntryATR ?? minEntryAtrInput}</b>–<b>{scanStatus?.config?.maxEntryATR ?? maxEntryAtrInput}</b> ATR · TG ≤ <b>{scanStatus?.config?.telegramMaxATR ?? telegramMaxAtrInput}</b> ATR · Max gap <b>{scanStatus?.config?.maxGapPercent ?? maxGapPercentInput}</b>% · {(scanStatus?.config?.scanUniverse ?? 'all') === 'all' ? <b>All coins</b> : <>Top <b>{scanStatus?.config?.scanUniverse}</b></>}
            </div>
            <div>
              Symbols scanned (last): <b>{last?.symbols_scanned ?? '—'}</b>
            </div>
            <div>
              Created / Updated:{' '}
              <b>
                {last?.signals_created ?? 0} / {last?.signals_updated ?? 0}
              </b>
            </div>
            <div>
              Errors: <b>{last?.error_count ?? 0}</b>
            </div>
            <div className="muted small">
              HQ: 4H→1H · Conservative · Score≥70 · Cron every 5 min
            </div>
          </div>
        </div>
        )}

        {/* ===== DB-backed lists (survive refresh / poll) ===== */}
        {activeTab === 'signals' && (
        <>
        <section className="dashboard-summary">
          <div className="summary-head">
            <div>
              <div className="summary-eyebrow">LIVE MARKET DESK</div>
              <h2>Signal overview</h2>
              <p>{scanStatus?.dbReady ? 'Monitoring is connected to saved signal history.' : 'Waiting for the database connection.'}</p>
            </div>
            <span className={`connection-dot ${scanStatus?.dbReady ? 'online' : ''}`}>{scanStatus?.dbReady ? '● LIVE' : '● OFFLINE'}</span>
          </div>
          <div className="summary-metrics">
            <div><b>{c.ongoing ?? 0}</b><span>Ongoing</span></div>
            <div><b>{c.ready ?? 0}</b><span>Ready</span></div>
            <div><b>{c.watching ?? 0}</b><span>Watching</span></div>
            <div><b>{safeData.invalidationCatalog?.length ?? 0}</b><span>Invalidated</span></div>
          </div>
          <div className="quick-actions">
            <button className="primary-action" type="button" onClick={scanNow} disabled={scanning}>{scanning ? 'Scanning…' : '↻ Scan market'}</button>
            <button className="secondary-btn" type="button" onClick={() => setActiveTab('scanner')}>⌕ Open scanner</button>
            <button className="secondary-btn" type="button" onClick={() => setActiveTab('catalog')}>▤ Review invalidations</button>
          </div>
        </section>

        <div className="section">
          <div className="section-header">
            🟢 ONGOING ({(safeData.ongoing || []).length}) — entry hit · in trade
          </div>
          <div className="section-body">
            <ClientErrorBoundary>
              {!(safeData.ongoing || []).length ? (
                <div className="muted">No open trades.</div>
              ) : (
                <div className="signal-grid">
                  {(safeData.ongoing || []).filter((s) => s && s.symbol).map((s) => (
                    <SignalCard key={s.signal_id || `on_${s.symbol}`} s={s} kind="ongoing" />
                  ))}
                </div>
              )}
            </ClientErrorBoundary>
          </div>
        </div>

        <div className="section">
          <div className="section-header">
            🟡 READY ({(safeData.ready || []).length}) — close to entry · DB saved
          </div>
          <div className="section-body">
            <ClientErrorBoundary>
              {!(safeData.ready || []).length ? (
                <div className="muted">No READY signals in database.</div>
              ) : (
                <div className="signal-grid">
                  {(safeData.ready || []).filter((s) => s && s.symbol).map((s) => (
                    <SignalCard key={s.signal_id || `rd_${s.symbol}`} s={s} kind="ready" />
                  ))}
                </div>
              )}
            </ClientErrorBoundary>
          </div>
        </div>

        <div className="section">
          <div className="section-header">
            🔵 WATCHING ({(safeData.watching || []).length}) — waiting · DB saved
          </div>
          <div className="section-body">
            <ClientErrorBoundary>
              {!(safeData.watching || []).length ? (
                <div className="muted">No WATCHING signals in database.</div>
              ) : (
                <div className="signal-grid">
                  {(safeData.watching || []).filter((s) => s && s.symbol).map((s) => (
                    <SignalCard key={s.signal_id || `wt_${s.symbol}`} s={s} kind="watching" />
                  ))}
                </div>
              )}
            </ClientErrorBoundary>
          </div>
        </div>
        </>
        )}

        {activeTab === 'history' && (
        <div className="section">
          <div className="section-header">History · completed, stopped, and invalidated ({(safeData.history || []).length})</div>
          <div className="section-body">
            {(safeData.history || []).length ? (
              <div className="history-list">
                {(safeData.history || []).map((item) => (
                  <div className="history-item" key={item.signal_id || `${item.symbol}-${item.status}-${item.created_at}`}>
                    <HistoryRow h={item} />
                    <ExplainSignal signal={item} />
                  </div>
                ))}
              </div>
            ) : <div className="empty-state">No completed signal history yet.</div>}
          </div>
        </div>
        )}

        {activeTab === 'catalog' && (
        <div className="catalog-page">
          <div className="page-intro">
            <div><div className="summary-eyebrow">AUDIT TRAIL</div><h2>Invalidation catalog</h2>
              <p>Every invalidated signal remains saved with its previous status, failing checks, values, price, and time.</p></div>
            <span className="catalog-count">{safeData.invalidationCatalog?.length ?? 0} records</span>
          </div>
          {(safeData.invalidationCatalog || []).length ? (
            <div className="invalidation-list">
              {safeData.invalidationCatalog.map((signal) => (
                <InvalidationCard key={signal.signal_id} signal={signal} />
              ))}
            </div>
          ) : <div className="empty-state">No invalidated signals are stored.</div>}
        </div>
        )}

        {activeTab === 'performance' && (
          <ClientErrorBoundary>
            <PerformancePanel />
          </ClientErrorBoundary>
        )}

        {activeTab === 'scanner' && (
        <>
        <div className="section">
          <div className="section-header">
            🔥 LIVE SCAN SIGNALS ({liveSignals.length}) — this scan only (saved ones appear in the DB lists above)
            {liveSignals.some((x) => x?.persisted === false) && (
              <span style={{ color: '#f0b90b' }}>
                {' '}· {liveSignals.filter((x) => x?.persisted === false).length} NOT saved (see scan errors)
              </span>
            )}
          </div>
          <div className="section-body">
            <ClientErrorBoundary>
              {scanning ? (
                <div className="muted">Scanning… signals appear when done.</div>
              ) : !liveSignals.length ? (
                <div className="muted">
                  Scan Now click කරන්න. New setups මෙතනත් පේනවා; DB lists උඩින් permanent.
                </div>
              ) : (
                <div className="signal-grid">
                  {liveSignals.filter((s) => s && s.symbol).map((s) => (
                    <SignalCard
                      key={s.signal_id || `${s.symbol}_${s.direction || s.dir || 'X'}`}
                      s={s}
                      kind="ready"
                    />
                  ))}
                </div>
              )}
            </ClientErrorBoundary>
          </div>
        </div>

        <div className="section">
          <div className="section-header">
            ⏳ ABOUT TO BREAK OUT ({nearList.length}) — pattern ready, waiting candle close · saved in DB (survives refresh)
          </div>
          <div className="section-body">
            <ClientErrorBoundary>
              {scanning && !nearList.length ? (
                <div className="muted">Scanning… results appear as chunks finish.</div>
              ) : !nearList.length ? (
                <div className="muted">
                  Scan Now click කරාම breakout වෙන්න ආසන්න setups මෙතන පෙනෙයි (level එකට ළඟම ඒවා මුලින්ම).
                </div>
              ) : (
                <div className="signal-grid">
                  {nearList.filter((n) => n && n.symbol).map((n) => (
                    <NearCard key={n.signal_id || `${n.symbol}_${n.pattern}_${n.patternTf}`} n={n} />
                  ))}
                </div>
              )}
            </ClientErrorBoundary>
          </div>
        </div>
        </>
        )}


      </main>
      <nav className="bottom-nav" aria-label="Main navigation">
        {[
          { id: 'signals', icon: '◈', label: 'Signals' },
          { id: 'scanner', icon: '⌕', label: 'Scanner' },
          { id: 'history', icon: '↺', label: 'History' },
          { id: 'performance', icon: '📊', label: 'Stats' },
          { id: 'catalog', icon: '▤', label: 'Catalog' },
          { id: 'settings', icon: '⚙', label: 'Settings' },
        ].map((item) => (
          <button
            className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
            type="button"
            key={item.id}
            aria-current={activeTab === item.id ? 'page' : undefined}
            onClick={() => setActiveTab(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
            {item.id === 'catalog' && safeData.invalidationCatalog?.length > 0 && (
              <span className="nav-count">{safeData.invalidationCatalog.length}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
