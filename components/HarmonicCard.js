'use client';

/**
 * Harmonic Patterns — Signals-tab card (admin).
 * Gartley / Bat / Butterfly / Crab / Cypher / Shark / AB=CD …
 * Projected XABC→D (Waiting / Entry ready) + completed XABCD (Formed).
 * Per-pattern Fib ratios editable in Settings.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import SkChart from './SkChart.js';
import EmaCross200Test from './EmaCross200Test.js';
import { harmonicCategory, pickBestPerCoin } from '../lib/scanner/strategy/harmonicScan/categories.js';

const BUCKETS = [
  ['all', 'All'],
  ['waiting', 'Waiting'],
  ['entry_ready', 'Entry ready'],
  ['formed', 'Formed'],
];
const SAVED_CATS = [
  ['all', 'All'],
  ['watching', 'Watching'],
  ['entry_ready', 'Entry ready'],
  ['in_trade', 'In trade'],
  ['tp_hit', 'TP hit'],
  ['sl_hit', 'SL hit'],
  ['invalid', 'Invalid / Missed'],
  ['formed', 'Formed'],
];
const TFS = [
  ['1m', '1M'],
  ['3m', '3M'],
  ['5m', '5M'],
  ['15m', '15M'],
  ['30m', '30M'],
  ['1h', '1H'],
  ['2h', '2H'],
  ['4h', '4H'],
  ['6h', '6H'],
  ['12h', '12H'],
  ['1d', '1D'],
];

const DEFAULT_RULES = {
  GARTLEY: { label: 'Gartley', xbMin: 0.55, xbMax: 0.68, bcMin: 0.382, bcMax: 0.886, xdMin: 0.75, xdMax: 0.82, target: 'xa', ratio: 0.786 },
  BAT: { label: 'Bat', xbMin: 0.35, xbMax: 0.55, bcMin: 0.382, bcMax: 0.886, xdMin: 0.85, xdMax: 0.92, target: 'xa', ratio: 0.886 },
  ALT_BAT: { label: 'Alternate Bat', xbMin: 0.33, xbMax: 0.45, bcMin: 0.382, bcMax: 0.886, xdMin: 1.08, xdMax: 1.18, target: 'xa', ratio: 1.13 },
  DEEP_BAT: { label: 'Deep Bat', xbMin: 0.82, xbMax: 0.95, bcMin: 0.382, bcMax: 0.886, xdMin: 0.85, xdMax: 0.92, target: 'xa', ratio: 0.886 },
  BUTTERFLY: { label: 'Butterfly', xbMin: 0.72, xbMax: 0.86, bcMin: 0.382, bcMax: 0.886, xdMin: 1.2, xdMax: 1.5, target: 'xa', ratio: 1.272 },
  CRAB: { label: 'Crab', xbMin: 0.35, xbMax: 0.65, bcMin: 0.382, bcMax: 0.886, xdMin: 1.5, xdMax: 1.72, target: 'xa', ratio: 1.618 },
  DEEP_CRAB: { label: 'Deep Crab', xbMin: 0.82, xbMax: 0.95, bcMin: 0.382, bcMax: 0.886, xdMin: 1.5, xdMax: 1.72, target: 'xa', ratio: 1.618 },
  CYPHER: { label: 'Cypher', xbMin: 0.35, xbMax: 0.65, bcMin: 0, bcMax: 99, xcMin: 1.13, xcMax: 1.414, xdMin: 0.75, xdMax: 0.82, target: 'xc', ratio: 0.786 },
  SHARK: { label: 'Shark', xbMin: 0.35, xbMax: 0.65, bcMin: 0, bcMax: 99, xcMin: 1.13, xcMax: 1.7, xdMin: 0.85, xdMax: 1.15, target: 'xc', ratio: 0.886 },
  ABCD: { label: 'AB=CD', xbMin: 0.35, xbMax: 0.92, bcMin: 0.35, bcMax: 0.92, cdAbMin: 0.88, cdAbMax: 1.2, target: 'ab', ratio: 1 },
};

const FAMILY_ORDER = ['GARTLEY', 'BAT', 'BUTTERFLY', 'CRAB', 'CYPHER', 'SHARK', 'ABCD', 'ALT_BAT', 'DEEP_BAT', 'DEEP_CRAB'];
/** Rate-limit safe scan: few coins per request, paced delays, longer rest every PART. */
const CHUNK = 2;           // coins per API request
const GAP_MS = 1800;       // pause between chunks
const PART_SIZE = 40;      // coins per "part" before a longer rest
const PART_REST_MS = 12000; // rest after each part (avoid Binance ban)
const BAN_BACKOFF_MS = 45000; // wait on rate-limit / ban then retry chunk
const MAX_CHUNK_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
const post = (body) =>
  api('/api/harmonic-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtClock = (t) => {
  const d = new Date(t * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtP = (p) => {
  if (p == null || !Number.isFinite(+p)) return '—';
  const a = Math.abs(+p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6;
  return (+p).toFixed(dp);
};
const fmtR = (v) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(3));

function signalKey(e) {
  return [e.symbol, e.tf, e.family, e.kind, e.C?.time || e.time, e.direction].join('|');
}
/** Strip heavy fields before save; chart rebuilt on refresh */
function toSavedPayload(e) {
  const { chartSvg, annotations, allBreakers, ...rest } = e;
  return {
    ...rest,
    savedAt: Math.floor(Date.now() / 1000),
    id: signalKey(e),
  };
}

function cloneRules() {
  const o = {};
  for (const k of Object.keys(DEFAULT_RULES)) o[k] = { ...DEFAULT_RULES[k] };
  return o;
}

/** Same chart as Scanner: respects chartMode, rebuilds via render_chart when SVG stripped from DB. */
function HarmonicChartPanel({ e, chartMode }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const isLong = String(e.direction || '').toUpperCase() === 'LONG';
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        // Prefer embedded payload
        if (e.chartSvg || (e.annotations && e.annotations.length)) {
          if (!alive) return;
          setData({ chartSvg: e.chartSvg, annotations: e.annotations || [] });
          setLoading(false);
          return;
        }
        const res = await post({
          action: 'render_chart',
          item: e,
          tzMin: -new Date().getTimezoneOffset(),
        });
        if (!alive) return;
        if (res.ok === false) throw new Error(res.error || 'Chart failed');
        setData({ chartSvg: res.chartSvg, annotations: res.annotations || [] });
      } catch (ex) {
        if (alive) setErr(ex.message || 'Chart failed');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [e?.id, e?.symbol, e?.tf, e?.direction, e?.family, e?.chartSvg]);

  const mode = ['svg', 'live', 'both'].includes(chartMode) ? chartMode : 'both';
  const chartSvg = data?.chartSvg;
  const annotations = data?.annotations || [];

  return (
    <div style={{ marginTop: 10 }}>
      {loading && <div style={{ fontSize: 12, opacity: 0.6 }}>Loading harmonic chart…</div>}
      {err && <div style={{ fontSize: 12, color: '#DC2626' }}>{err}</div>}
      {(mode === 'svg' || mode === 'both') && chartSvg && (
        <div style={{ overflowX: 'auto', marginBottom: mode === 'both' ? 12 : 0 }} dangerouslySetInnerHTML={{ __html: chartSvg }} />
      )}
      {(mode === 'live' || mode === 'both') && (
        <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(128,128,128,0.2)' }}>
          <div style={{ fontSize: 11, opacity: 0.65, padding: '6px 10px' }}>
            Live chart · pan / zoom · XABCD · D zone · SL/TP · EMA200 · RSI + divergence
          </div>
          <SkChart
            symbol={e.symbol}
            annotations={annotations}
            dir={isLong ? 'long' : 'short'}
            defaultTf={e.tf}
            fitFromTime={e.X?.time || e.C?.time}
            height={480}
            rsi
            divergence={e.divergence || null}
            divergenceTf={e.tf}
          />
        </div>
      )}
      {!loading && !err && !chartSvg && mode === 'svg' && (
        <div style={{ fontSize: 12, opacity: 0.6 }}>SVG chart not available.</div>
      )}
    </div>
  );
}

function HarmonicPanel() {
  // Always scan all coins — no Top N / Pick
  const mode = 'all';
  const [tfs, setTfs] = useState(['1h', '4h']);
  const [bucket, setBucket] = useState('all');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);
  const [items, setItems] = useState([]);
  const [msg, setMsg] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const [showSet, setShowSet] = useState(true);
  const [enabled, setEnabled] = useState(() => [...FAMILY_ORDER]);
  const [rules, setRules] = useState(cloneRules);
  const [includeProjected, setIncludeProjected] = useState(true);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [minScore, setMinScore] = useState(55);
  const [preferEma200, setPreferEma200] = useState(false);
  const [requireEma200, setRequireEma200] = useState(false);
  const [preferBreaker, setPreferBreaker] = useState(false);
  const [requireBreaker, setRequireBreaker] = useState(false);
  const [requireVolumeNode, setRequireVolumeNode] = useState(false);
  const [enableBreakers, setEnableBreakers] = useState(true);
  // X must be the top of an up-leg (bearish) / bottom of a down-leg (bullish)
  const [requireLegX, setRequireLegX] = useState(false);
  const [legLookback, setLegLookback] = useState(40);
  const [legMinAtr, setLegMinAtr] = useState(3);
  const [editFamily, setEditFamily] = useState('GARTLEY');
  const [chartMode, setChartMode] = useState('both'); // svg | live | both
  const [saved, setSaved] = useState([]);
  const [savedOpen, setSavedOpen] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [patternFilter, setPatternFilter] = useState([]);
  /** ON (default): only the best signal per coin is shown. OFF: every signal shows. Saved in DB. */
  const [onePerCoin, setOnePerCoin] = useState(true);
  const [savedCat, setSavedCat] = useState('all');
  const [cronMeta, setCronMeta] = useState(null);
  const [cronSecret, setCronSecret] = useState('');
  const [cronSecretInput, setCronSecretInput] = useState('');
  const [cronBox, setCronBox] = useState(false);
  const [showEc, setShowEc] = useState(false);
  const [scanSt, setScanSt] = useState(null);
  const [scanTfs, setScanTfs] = useState(['15m', '1h']);
  const [scanRest, setScanRest] = useState(5);
  const [scanChunk, setScanChunk] = useState(30);
  const [autoOn, setAutoOn] = useState(false);
  const [autoHours, setAutoHours] = useState(1);
  const [autoStartHour, setAutoStartHour] = useState(1);
  const [autoUpdateMin, setAutoUpdateMin] = useState(1);
  const [autoStatus, setAutoStatus] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [colomboNow, setColomboNow] = useState('');
  const stop = useRef(false);

  const refreshAuto = useCallback(() => {
    post({ action: 'get_auto' })
      .then((d) => {
        if (!d?.auto) return;
        setAutoOn(!!d.auto.enabled);
        if (Number.isFinite(+d.auto.intervalHours)) setAutoHours(+d.auto.intervalHours);
        if (Number.isFinite(+d.auto.startHour)) setAutoStartHour(+d.auto.startHour);
        if (Number.isFinite(+d.auto.updateMinutes)) setAutoUpdateMin(+d.auto.updateMinutes);
        if (d.auto.colomboNow) setColomboNow(d.auto.colomboNow);
        setAutoStatus(d.auto.status || null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    post({ action: 'list_saved' })
      .then((d) => setSaved(Array.isArray(d.items) ? d.items : []))
      .catch(() => setSaved([]));
    post({ action: 'set_auto', enabled: false }).catch(() => {});
    setAutoOn(false);
    // Load settings from database
    post({ action: 'get_config' })
      .then((d) => {
        const c = d?.config;
        if (!c || typeof c !== 'object') return;
        if (Array.isArray(c.tfs) && c.tfs.length) setTfs(c.tfs);
        if (Array.isArray(c.enabledFamilies) && c.enabledFamilies.length) setEnabled(c.enabledFamilies);
        if (c.ratioRules && typeof c.ratioRules === 'object') {
          setRules((prev) => {
            const next = { ...prev };
            for (const k of Object.keys(next)) {
              if (c.ratioRules[k]) next[k] = { ...next[k], ...c.ratioRules[k] };
            }
            return next;
          });
        }
        if (typeof c.includeProjected === 'boolean') setIncludeProjected(c.includeProjected);
        if (typeof c.includeCompleted === 'boolean') setIncludeCompleted(c.includeCompleted);
        if (Number.isFinite(+c.minScore)) setMinScore(+c.minScore);
        if (typeof c.preferEma200 === 'boolean') setPreferEma200(c.preferEma200);
        if (typeof c.requireEma200 === 'boolean') setRequireEma200(c.requireEma200);
        if (typeof c.preferBreaker === 'boolean') setPreferBreaker(c.preferBreaker);
        if (typeof c.requireBreaker === 'boolean') setRequireBreaker(c.requireBreaker);
        if (typeof c.requireVolumeNode === 'boolean') setRequireVolumeNode(c.requireVolumeNode);
        if (typeof c.enableBreakers === 'boolean') setEnableBreakers(c.enableBreakers);
        if (typeof c.requireLegX === 'boolean') setRequireLegX(c.requireLegX);
        if (Number.isFinite(+c.legLookbackBars)) setLegLookback(+c.legLookbackBars);
        if (Number.isFinite(+c.legMinAtr)) setLegMinAtr(+c.legMinAtr);
        if (typeof c.onePerCoin === 'boolean') setOnePerCoin(c.onePerCoin);
        if (['svg', 'live', 'both'].includes(c.chartMode)) setChartMode(c.chartMode);
      })
      .catch(() => {});
  }, []);

  const reloadSaved = useCallback(async () => {
    try {
      const d = await post({ action: 'list_saved' });
      setSaved(Array.isArray(d.items) ? d.items : []);
    } catch (_) {}
    try {
      const m = await post({ action: 'refresh_meta' });
      setCronMeta(m?.meta || null);
    } catch (_) {}
  }, []);

  // Server cron updates statuses in the DB — pull them in every minute (no button needed)
  useEffect(() => {
    reloadSaved();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      reloadSaved();
    }, 60_000);
    return () => clearInterval(id);
  }, [reloadSaved]);

  const loadCronSecret = async () => {
    try {
      const d = await post({ action: 'get_cron_secret' });
      setCronSecret(d.secret || '');
    } catch (e) {
      setMsg(e.message || 'Could not load cron secret');
    }
  };
  const saveCronSecret = async (generate) => {
    try {
      const d = await post({ action: 'set_cron_secret', generate: !!generate, secret: cronSecretInput });
      setCronSecret(d.secret || '');
      setCronSecretInput('');
      setMsg('Cron secret saved in the database — no redeploy needed');
    } catch (e) {
      setMsg(e.message || 'Could not save cron secret');
    }
  };
  const cronUrl = () =>
    `${typeof window !== 'undefined' ? window.location.origin : 'https://YOUR-DOMAIN'}/api/cron/harmonic-refresh?secret=${cronSecret || 'YOUR_SECRET'}`;

  const loadScanState = useCallback(async () => {
    try {
      const d = await post({ action: 'scan_cron_get' });
      if (d.state) setScanSt(d.state);
    } catch (_) {}
  }, []);
  useEffect(() => {
    if (!cronBox) return undefined;
    loadScanState();
    const id = setInterval(loadScanState, 10_000);
    return () => clearInterval(id);
  }, [cronBox, loadScanState]);
  useEffect(() => {
    if (!scanSt) return;
    setScanTfs(scanSt.tfs || ['15m', '1h']);
    setScanRest(scanSt.restMin ?? 5);
    setScanChunk(scanSt.coinsPerTick ?? 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanSt?.updatedAt, scanSt?.enabled]);

  const saveScanCron = async (patch = {}) => {
    try {
      const d = await post({
        action: 'scan_cron_set',
        tfs: scanTfs,
        restMin: scanRest,
        coinsPerTick: scanChunk,
        ...patch,
      });
      if (d.state) setScanSt(d.state);
      setMsg(patch.enabled === true ? 'Server full scan STARTED — it runs on every cron call' : patch.enabled === false ? 'Server full scan stopped' : 'Server scan settings saved');
    } catch (e) {
      setMsg(e.message || 'Could not save');
    }
  };
  const origin = () => (typeof window !== 'undefined' ? window.location.origin : 'https://YOUR-DOMAIN');
  const scanCronUrl = () => `${origin()}/api/cron/harmonic-scan?secret=${cronSecret || 'YOUR_SECRET'}`;
  const refreshCronUrl = () => `${origin()}/api/cron/harmonic-refresh?secret=${cronSecret || 'YOUR_SECRET'}`;
  const copyText = (t) => {
    try {
      navigator.clipboard.writeText(t);
      setMsg('Copied');
    } catch (_) {}
  };

  const toggleOnePerCoin = (v) => {
    setOnePerCoin(v);
    post({ action: 'set_view_prefs', onePerCoin: v }).catch(() => {});
  };

  const saveSettings = async () => {
    setSaving(true);
    setMsg('');
    try {
      const d = await post({
        action: 'save_config',
        config: {
          tfs,
          enabledFamilies: enabled,
          ratioRules: rules,
          includeProjected,
          includeCompleted,
          minScore,
          preferEma200,
          requireEma200,
          preferBreaker,
          requireBreaker,
          requireVolumeNode,
          enableBreakers,
          requireLegX,
          legLookbackBars: legLookback,
          legMinAtr,
          onePerCoin,
          chartMode,
        },
      });
      setMsg(d.msg || 'Settings saved to database');
    } catch (e) {
      setMsg(e.message || 'Save failed');
    }
    setSaving(false);
  };

  const clearHarmonicSignals = async () => {
    if (!confirm('Clear ALL harmonic signals (saved list in the database + live board)? Cannot be undone.')) return;
    setSaving(true);
    setMsg('');
    try {
      // 1) The harmonic saved list lives in the database — this is what actually must be emptied
      const cs = await post({ action: 'clear_saved' });
      const clearedSaved = cs.cleared ?? 0;
      // 2) Main live board (best effort — never blocks step 1)
      let boardSignals = 0;
      let boardEvents = 0;
      try {
        const res = await fetch('/api/admin/reset-signals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ confirm: true, mode: 'all' }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
          boardSignals = d.signalsDeleted ?? d.deleted ?? 0;
          boardEvents = d.eventsDeleted ?? 0;
        }
      } catch (_) {}
      setItems([]);
      setSaved([]);
      setMsg(`Cleared ${clearedSaved} harmonic signals from the database · live board: ${boardSignals} signals, ${boardEvents} events removed`);
      try {
        window.dispatchEvent(new CustomEvent('nexora:signals-cleared', { detail: { deleted: clearedSaved + boardSignals } }));
      } catch (_) {}
    } catch (e) {
      setMsg(e.message || 'Clear failed');
    }
    setSaving(false);
  };

  const toggleTf = (tf) => setTfs((p) => (p.includes(tf) ? p.filter((x) => x !== tf) : [...p, tf]));
  const toggleFamily = (k) =>
    setEnabled((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const setRuleField = (family, field, value) => {
    setRules((prev) => ({
      ...prev,
      [family]: { ...prev[family], [field]: value === '' ? '' : +value },
    }));
  };

  const scan = useCallback(async () => {
    stop.current = false;
    setBusy(true);
    setMsg('');
    setItems([]);
    setOpenKey(null);
    try {
      // Always full universe (all futures coins) — scanned in paced chunks to avoid API ban
      const u = await post({ action: 'universe', mode: 'all', ranking: 'volume' });
      const list = u.symbols || [];
      if (!list.length) throw new Error('No matching coins');
      const totalParts = Math.max(1, Math.ceil(list.length / PART_SIZE));
      setProgress({ done: 0, total: list.length, current: '' });
      setMsg(`Paced scan · ${list.length} coins · ${CHUNK}/req · ${totalParts} parts`);
      const found = [];
      let coinsSincePartRest = 0;

      for (let i = 0; i < list.length; i += CHUNK) {
        if (stop.current) {
          setMsg(`Scan stopped · ${found.length} setups · ${i}/${list.length} coins`);
          break;
        }
        const chunk = list.slice(i, i + CHUNK);
        const part = Math.floor(i / PART_SIZE) + 1;
        setProgress({
          done: i,
          total: list.length,
          current: `Part ${part}/${totalParts} · ${chunk.join(', ')}`,
        });

        let d = null;
        let attempt = 0;
        while (attempt < MAX_CHUNK_RETRIES) {
          attempt += 1;
          try {
            d = await post({
              action: 'analyze',
              symbols: chunk,
              tfs,
              includeCharts: true,
              enabledFamilies: enabled,
              ratioRules: rules,
              includeProjected,
              includeCompleted,
              minScore,
              preferEma200InDzone: preferEma200,
              requireEma200InDzone: requireEma200,
              enableBreakers,
              preferBreakerInDzone: preferBreaker,
              requireBreakerInDzone: requireBreaker,
              requireVolumeNodeInBreaker: requireVolumeNode,
              requireLegX,
              legLookbackBars: legLookback,
              legMinAtr,
            });
            break;
          } catch (e) {
            const limited = !!(e.data?.banned || e.data?.throttled || e.status === 429 || /ban|throttl|rate.?limit/i.test(String(e.message || '')));
            if (limited && attempt < MAX_CHUNK_RETRIES) {
              setMsg(`Rate-limit · waiting ${Math.round(BAN_BACKOFF_MS / 1000)}s then retry (${chunk[0]})…`);
              await sleep(BAN_BACKOFF_MS);
              if (stop.current) break;
              continue;
            }
            setMsg(
              limited
                ? `Exchange rate-limit: stopped at ${chunk[0]} after retries (${e.message})`
                : e.message
            );
            d = null;
            break;
          }
        }
        if (stop.current) {
          setMsg(`Scan stopped · ${found.length} setups · ${i}/${list.length} coins`);
          break;
        }
        if (!d) break;

        if (d.stopped) {
          // Server saw ban/throttle mid-chunk — back off and continue from next chunk
          setMsg(`Paused (${d.stopped}): cooling ${Math.round(BAN_BACKOFF_MS / 1000)}s…`);
          await sleep(BAN_BACKOFF_MS);
          if (stop.current) break;
          // still collect any partial results
        }

        for (const r of d.results || []) {
          if (!r.ok) continue;
          for (const x of r.results || []) {
            if (x.error) continue;
            const et = String(x.tf || x.patternTf || '');
            if (tfs.length && et && !tfs.includes(et)) continue;
            if (tfs.length && !et) continue;
            found.push({ symbol: r.symbol, ...x, tf: et || x.tf, patternTf: et || x.patternTf });
          }
        }
        setItems([...found].sort((a, b) => (b.time || 0) - (a.time || 0)));

        if (d.autoSaved?.added && (i / CHUNK) % 5 === 0) reloadSaved();
        coinsSincePartRest += chunk.length;
        const more = i + CHUNK < list.length;
        if (!more) break;

        if (coinsSincePartRest >= PART_SIZE) {
          coinsSincePartRest = 0;
          setMsg(`Part ${part}/${totalParts} done · rest ${Math.round(PART_REST_MS / 1000)}s (anti-ban) · ${found.length} setups so far`);
          await sleep(PART_REST_MS);
        } else {
          await sleep(GAP_MS);
        }
      }

      setProgress({ done: list.length, total: list.length, current: '' });
      if (!stop.current) {
        // Every chunk was already saved to the database by the server while scanning
        await reloadSaved();
        setMsg(`Done · ${found.length} setups · ${list.length} coins`);
      }
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  }, [tfs, enabled, rules, includeProjected, includeCompleted, minScore, preferEma200, requireEma200, preferBreaker, requireBreaker, requireVolumeNode, enableBreakers, requireLegX, legLookback, legMinAtr, reloadSaved]);

  const filtered = items.filter((e) => {
    const et = String(e.tf || e.patternTf || '');
    if (tfs.length && et && !tfs.includes(et)) return false;
    if (patternFilter.length && !patternFilter.includes(e.family)) return false;
    if (bucket === 'all') return true;
    if (bucket === 'waiting') return e.status === 'WAITING';
    if (bucket === 'entry_ready') return e.status === 'ENTRY_READY';
    if (bucket === 'formed') return e.status === 'FORMED' || e.kind === 'COMPLETED';
    return true;
  });

  const counts = {
    all: items.length,
    waiting: items.filter((e) => e.status === 'WAITING').length,
    entry_ready: items.filter((e) => e.status === 'ENTRY_READY').length,
    formed: items.filter((e) => e.status === 'FORMED' || e.kind === 'COMPLETED').length,
  };

  // Results list: ON = best signal per coin only, OFF = every signal as its own card
  const resultRows = (onePerCoin ? pickBestPerCoin(filtered) : filtered).map((e) => ({ type: 'item', e }));
  const hiddenByOnePerCoin = onePerCoin ? filtered.length - resultRows.length : 0;

  const rf = rules[editFamily] || DEFAULT_RULES[editFamily];

  const isSaved = (e) => saved.some((s) => s.id === signalKey(e));
  const unsaveSignal = async (id) => {
    try {
      const d = await post({ action: 'unsave', id });
      setSaved(Array.isArray(d.items) ? d.items : saved.filter((s) => s.id !== id));
    } catch (err) {
      setMsg(err.message || 'Remove failed');
    }
  };
  const [enterBusyId, setEnterBusyId] = useState(null);
  const manualEnterSignal = async (e) => {
    const id = e.id || signalKey(e);
    if (enterBusyId) return;
    setEnterBusyId(id);
    setMsg('');
    try {
      const payload = {
        signal_id: id,
        symbol: e.symbol,
        direction: e.direction || e.dir || 'LONG',
        status: e.status || 'ENTRY_READY',
        entry: e.entry ?? e.plan?.entry ?? e.D?.price,
        sl: e.sl ?? e.plan?.sl,
        tp1: e.tp1 ?? e.plan?.tp1,
        tp2: e.tp2 ?? e.plan?.tp2,
        tp3: e.tp3 ?? e.plan?.tp3,
        score: e.score,
        current_price: e.marketPrice ?? e.price,
        metadata: {
          strategy: 'harmonic',
          pattern: e.family || e.label,
          tf: e.tf,
          harmonic: e,
        },
      };
      const res = await fetch('/api/user/manual-entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal: payload, marketPrice: e.marketPrice ?? e.price, exchange: 'binance' }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok === false) throw new Error(d.error || 'Manual entry failed');
      setMsg(d.msg || 'Order placed');
    } catch (err) {
      setMsg(err.message || 'Manual entry failed');
    }
    setEnterBusyId(null);
  };


  const clearSaved = async () => {
    if (!confirm('Clear all saved signals from database?')) return;
    try {
      await post({ action: 'clear_saved' });
      setSaved([]);
    } catch (err) {
      setMsg(err.message || 'Clear failed');
    }
  };
  const refreshSaved = async () => {
    if (!saved.length || refreshing) return;
    setRefreshing(true);
    try {
      const strip = ({ chartSvg, annotations, allBreakers, ...rest }) => rest;
      // Final results (SL hit / TP3 / invalid / missed) stay frozen — only live ones are re-checked
      const isFinal = (e) => ['SL_HIT', 'TP3_HIT', 'INVALIDATED', 'MISSED'].includes(String(e.status || '').toUpperCase());
      const todo = saved.filter((e) => !isFinal(e));
      const byId = new Map(saved.map((e) => [e.id || signalKey(e), e]));
      for (let i = 0; i < todo.length; i += 20) {
        const slice = todo.slice(i, i + 20).map(strip);
        const res = await post({
          action: 'revalidate',
          items: slice,
          enabledFamilies: enabled,
          ratioRules: rules,
          enableBreakers,
          preferBreakerInDzone: preferBreaker,
          requireBreakerInDzone: requireBreaker,
              requireVolumeNodeInBreaker: requireVolumeNode,
          preferEma200InDzone: preferEma200,
          requireEma200InDzone: requireEma200,
        });
        const results = res.results || [];
        for (let j = 0; j < slice.length; j++) {
          const base = slice[j] || {};
          const r = results[j] || {};
          const id = base.id || signalKey(base);
          if (r.error) byId.set(id, { ...base, error: r.error });
          else byId.set(id, { ...base, ...r, id, error: undefined, refreshedAt: r.refreshedAt || Math.floor(Date.now() / 1000) });
        }
      }
      // Server already saved the new statuses to the database
      setSaved([...byId.values()]);
      await reloadSaved();
      setMsg(`Refreshed ${todo.length} live signals · statuses updated (finished ones kept as-is)`);
    } catch (e) {
      setMsg(e.message);
    }
    setRefreshing(false);
  };

  // Saved list view: optional one-per-coin, then status category tab
  const savedBase = onePerCoin ? pickBestPerCoin(saved) : saved;
  const savedCounts = { all: savedBase.length };
  for (const e of savedBase) {
    const c = harmonicCategory(e.status);
    savedCounts[c] = (savedCounts[c] || 0) + 1;
  }
  const savedShown = savedCat === 'all' ? savedBase : savedBase.filter((e) => harmonicCategory(e.status) === savedCat);

  const togglePatternFilter = (fam) =>
    setPatternFilter((p) => (p.includes(fam) ? p.filter((x) => x !== fam) : [...p, fam]));

  return (
    <div style={{ marginTop: 10 }}>
      <p style={{ fontSize: 12, opacity: 0.75, margin: '0 0 10px' }}>
        Time frames → <b>Scan all coins</b>. Results save automatically.
      </p>

      <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.75 }}>Time frames</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {TFS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className={tfs.includes(v) ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => toggleTf(v)}
            style={tfs.includes(v) ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : undefined}
          >
            {l}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={saving}
          onClick={saveSettings}
          style={{ background: '#16A34A', borderColor: '#16A34A', color: '#fff', fontWeight: 700 }}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={saving}
          onClick={clearHarmonicSignals}
          style={{ borderColor: '#DC2626', color: '#B91C1C' }}
        >
          Clear signals
        </button>
        <button type="button" className="btn btn-sm" disabled={busy || !tfs.length} onClick={scan}>
          {busy ? 'Scanning…' : 'Scan all coins'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowSet((s) => !s)}>
          {showSet ? 'Hide settings' : 'Show settings'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setShowEc((v) => !v)}
          style={{ background: showEc ? '#1D4ED8' : '#2563EB', borderColor: '#2563EB', color: '#fff', fontWeight: 700 }}
          title="Separate test (not harmonic): EMA20/50 cross where the candle touched EMA200"
        >
          {showEc ? 'Hide' : 'EMA 20/50 cross + 200 touch'}
        </button>
        {busy && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { stop.current = true; }}>
            Stop
          </button>
        )}
      </div>

      {showEc && <EmaCross200Test />}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={onePerCoin} onChange={(e) => toggleOnePerCoin(e.target.checked)} />
        <span>
          <b>One signal per coin</b> (best one only). Turn OFF to show every signal of the same coin.
          {onePerCoin && hiddenByOnePerCoin > 0 ? ` · ${hiddenByOnePerCoin} hidden` : ''}
        </span>
      </label>

      {msg && (
        <div style={{ fontSize: 12, marginBottom: 10, color: msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('error') ? '#DC2626' : '#15803D' }}>
          {msg}
        </div>
      )}

      {showSet && (
        <div style={{ background: 'rgba(128,128,128,0.08)', borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Patterns (tick to scan)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {FAMILY_ORDER.map((k) => (
              <label
                key={k}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  borderRadius: 8,
                  border: '1px solid rgba(128,128,128,0.25)',
                  cursor: 'pointer',
                  background: enabled.includes(k) ? 'rgba(22,163,74,0.12)' : 'transparent',
                }}
              >
                <input type="checkbox" checked={enabled.includes(k)} onChange={() => toggleFamily(k)} />
                {DEFAULT_RULES[k]?.label || k}
              </label>
            ))}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeProjected} onChange={(e) => setIncludeProjected(e.target.checked)} />
            Projected XABC → D (Waiting / Entry ready)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeCompleted} onChange={(e) => setIncludeCompleted(e.target.checked)} />
            Completed XABCD (Formed)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={preferEma200} onChange={(e) => setPreferEma200(e.target.checked)} />
            Prefer D zone near <b>EMA200</b> (score boost — mid / slightly above or below)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireEma200} onChange={(e) => setRequireEma200(e.target.checked)} />
            <b>Require</b> EMA200 inside / near D zone (filter)
          </label>
          <div style={{ fontWeight: 600, margin: '10px 0 6px' }}>Breaker Block Engine (defaults)</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={enableBreakers} onChange={(e) => setEnableBreakers(e.target.checked)} />
            Detect Bull / Bear breaker blocks on chart
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={preferBreaker} onChange={(e) => setPreferBreaker(e.target.checked)} />
            Prefer D zone with a <b>breaker block through the middle</b> (score boost)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireBreaker} onChange={(e) => setRequireBreaker(e.target.checked)} />
            <b>Require</b> breaker block overlapping D zone (only those setups)
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireVolumeNode} onChange={(e) => setRequireVolumeNode(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <b>Require</b> a <b style={{ color: '#2962ff' }}>blue Volume Profile peak zone</b> inside that breaker block
              (LuxAlgo “Volume Profile with Node Detection”, default settings: 360 bars · 100 rows · peaks 9 % · threshold 1 %).
              Only setups where <b>D zone ∩ breaker block ∩ blue zone</b> all overlap are kept; the blue zone is drawn on the chart.
              Needs breaker detection (switched on automatically).
            </span>
          </label>
          <div style={{ fontWeight: 600, margin: '10px 0 6px' }}>Leg filter — X at the extreme of the leg</div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={requireLegX} onChange={(e) => setRequireLegX(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <b>X must be the TOP of an up-leg</b> (bearish / W-shape) and <b>the BOTTOM of a down-leg</b> (bullish / M-shape).
              Only the move <i>before X</i> is checked — D going beyond X (Crab…) does not matter. Scan only returns such setups.
            </span>
          </label>
          {requireLegX && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '0 0 10px 24px', fontSize: 12 }}>
              <label>Look back (bars){' '}
                <input className="form-input" type="number" min="10" max="200" value={legLookback} onChange={(e) => setLegLookback(e.target.value)} style={{ width: 70 }} />
              </label>
              <label>Min leg size (× ATR){' '}
                <input className="form-input" type="number" step="0.5" min="0.5" max="20" value={legMinAtr} onChange={(e) => setLegMinAtr(e.target.value)} style={{ width: 70 }} />
              </label>
              <span style={{ opacity: 0.7 }}>Remember to <b>Save settings</b> — the server scan uses the saved values.</span>
            </div>
          )}
          <div style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 11, opacity: 0.7 }}>Chart view · </span>
            {[['both', 'SVG + Live'], ['svg', 'SVG only'], ['live', 'Live only']].map(([k, l]) => (
              <button
                key={k}
                type="button"
                className={chartMode === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
                style={{ marginRight: 4, ...(chartMode === k ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : {}) }}
                onClick={() => {
                  setChartMode(k);
                  post({ action: 'save_config', config: { chartMode: k, tfs, enabledFamilies: enabled, ratioRules: rules, includeProjected, includeCompleted, minScore, preferEma200, requireEma200, preferBreaker, requireBreaker, requireVolumeNode, enableBreakers, requireLegX, legLookbackBars: legLookback, legMinAtr, onePerCoin } }).catch(() => {});
                }}
              >
                {l}
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, opacity: 0.7 }}>Min score</label>
            <input
              className="form-input"
              type="number"
              min={30}
              max={95}
              value={minScore}
              onChange={(e) => setMinScore(+e.target.value)}
              style={{ width: 90 }}
            />
          </div>

          <div style={{ fontWeight: 600, marginBottom: 6 }}>Edit ratios — pick a pattern</div>
          <select
            className="form-input"
            value={editFamily}
            onChange={(e) => setEditFamily(e.target.value)}
            style={{ marginBottom: 8 }}
          >
            {FAMILY_ORDER.map((k) => (
              <option key={k} value={k}>
                {DEFAULT_RULES[k]?.label || k}
              </option>
            ))}
          </select>

          {rf && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(110px,1fr))', gap: 8 }}>
              {[
                ['xbMin', 'XB min'],
                ['xbMax', 'XB max'],
                ['bcMin', 'BC min'],
                ['bcMax', 'BC max'],
                ['xdMin', 'XD min'],
                ['xdMax', 'XD max'],
                ['xcMin', 'XC min'],
                ['xcMax', 'XC max'],
                ['cdAbMin', 'CD/AB min'],
                ['cdAbMax', 'CD/AB max'],
                ['ratio', 'D ratio'],
              ]
                .filter(([f]) => rf[f] != null || ['xcMin', 'xcMax', 'cdAbMin', 'cdAbMax'].includes(f))
                .map(([field, lab]) => (
                  <div key={field}>
                    <label style={{ fontSize: 10, opacity: 0.65 }}>{lab}</label>
                    <input
                      className="form-input"
                      type="number"
                      step="0.001"
                      value={rf[field] ?? ''}
                      onChange={(e) => setRuleField(editFamily, field, e.target.value)}
                    />
                  </div>
                ))}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>
            Defaults follow classic harmonic ratios (Gartley 0.786, Bat 0.886, Butterfly 1.272, Crab 1.618, Cypher 0.786 of XC…). Type new values to tighten or loosen detection.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={saving}
              onClick={saveSettings}
              style={{ background: '#16A34A', borderColor: '#16A34A', color: '#fff', fontWeight: 700 }}
            >
              {saving ? 'Saving…' : 'Save settings to database'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={saving}
              onClick={clearHarmonicSignals}
              style={{ borderColor: '#DC2626', color: '#B91C1C' }}
            >
              Clear harmonic signals
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setRules(cloneRules())}
            >
              Reset all ratios to defaults
            </button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        {CHUNK} coins/req · ~{PART_SIZE}/part + rest · paced to avoid API ban · XABC→D = Entry ready near PRZ
      </div>

      {progress && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          Progress: {progress.done}/{progress.total}
          {progress.current ? ` · ${progress.current}` : ''}
        </div>
      )}
      {msg && <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.85 }}>{msg}</div>}

      {/* ── Server crons: full scan + status refresh (no browser needed) ── */}
      <div style={{ border: '1px solid rgba(22,163,74,0.35)', borderRadius: 12, padding: 12, marginBottom: 14, background: 'rgba(22,163,74,0.04)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => { const n = !cronBox; setCronBox(n); if (n) loadCronSecret(); }}
          >
            {cronBox ? 'Hide' : 'Show'} server crons (auto scan + refresh)
          </button>
          {scanSt && (
            <span style={{ fontSize: 12, opacity: 0.85 }}>
              {scanSt.enabled ? '🟢' : '⚪'} {scanSt.pass ? `Scanning ${scanSt.pass.done}/${scanSt.pass.total}` : scanSt.status || (scanSt.enabled ? 'running' : 'stopped')}
            </span>
          )}
        </div>
        {cronBox && (
          <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>1 · Server full scan (chunks, API-ban safe)</div>
            <div style={{ opacity: 0.8, marginBottom: 6 }}>
              Every cron call scans the next {scanChunk} coins and saves them to the database at once, so new signals appear
              (admin + Scanner tab) while the pass is still running. After the whole list it rests, then starts again.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {TFS.map((t) => {
                const on = scanTfs.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={on ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
                    onClick={() => setScanTfs((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}
                    style={on ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : undefined}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              <label>Rest between passes (min){' '}
                <input className="form-input" type="number" min="0" max="240" value={scanRest} onChange={(e) => setScanRest(e.target.value)} style={{ width: 70 }} />
              </label>
              <label>Coins per cron call{' '}
                <input className="form-input" type="number" min="5" max="60" value={scanChunk} onChange={(e) => setScanChunk(e.target.value)} style={{ width: 70 }} />
              </label>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {scanSt?.enabled ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => saveScanCron({ enabled: false })} style={{ borderColor: '#DC2626', color: '#B91C1C' }}>
                  Stop server scan
                </button>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => saveScanCron({ enabled: true })} style={{ background: '#16A34A', borderColor: '#16A34A', color: '#fff', fontWeight: 700 }}>
                  Start server scan
                </button>
              )}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => saveScanCron({})}>Save settings</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => saveScanCron({ restart: true })}>Restart pass</button>
            </div>
            {scanSt && (
              <div style={{ opacity: 0.75, marginBottom: 10 }}>
                {scanSt.status ? `${scanSt.status}` : ''}
                {scanSt.lastTickAt ? ` · last cron call ${new Date(scanSt.lastTickAt).toLocaleTimeString()}` : ''}
                {scanSt.lastPass ? ` · last full pass: ${scanSt.lastPass.coins} coins, ${scanSt.lastPass.found} new signals` : ''}
                {scanSt.lastError ? <span style={{ color: '#DC2626' }}> · {scanSt.lastError}</span> : null}
              </div>
            )}

            <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>2 · Cron secret (saved in database — no redeploy)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => saveCronSecret(true)} style={{ background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' }}>
                {cronSecret ? 'Generate new secret' : 'Generate secret'}
              </button>
              <input className="form-input" placeholder="or type your own (12+ chars)" value={cronSecretInput} onChange={(e) => setCronSecretInput(e.target.value)} style={{ minWidth: 160, flex: 1 }} />
              <button type="button" className="btn btn-secondary btn-sm" disabled={!cronSecretInput} onClick={() => saveCronSecret(false)}>Save</button>
            </div>
            {cronSecret && (
              <>
                <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>3 · cron-job.org URLs (GET)</div>
                <div>Full scan — every <b>1 minute</b>:</div>
                <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 11, margin: '2px 0' }}>{scanCronUrl()}</div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyText(scanCronUrl())}>Copy scan URL</button>
                <div style={{ marginTop: 8 }}>Status refresh (all signals together) — every <b>1–2 minutes</b>:</div>
                <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 11, margin: '2px 0' }}>{refreshCronUrl()}</div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyText(refreshCronUrl())}>Copy refresh URL</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Saved signals (persist across refresh) ── */}
      <div style={{ border: '1px solid rgba(124,58,237,0.35)', borderRadius: 12, padding: 12, marginBottom: 14, background: 'rgba(124,58,237,0.04)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSavedOpen((o) => !o)}>
            {savedOpen ? 'Hide' : 'Show'} saved · {saved.length}
          </button>
          <button type="button" className="btn btn-sm" disabled={!saved.length || refreshing} onClick={refreshSaved}
            style={{ background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' }}>
            {refreshing ? 'Refreshing…' : 'Refresh saved'}
          </button>
          {saved.length > 0 && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={clearSaved}>
              Clear all
            </button>
          )}
        </div>
        {savedOpen && saved.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {SAVED_CATS.map(([k, l]) => (
              <button
                key={k}
                type="button"
                className={savedCat === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
                onClick={() => setSavedCat(k)}
                style={savedCat === k ? { background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' } : undefined}
              >
                {l} · {savedCounts[k] || 0}
              </button>
            ))}
          </div>
        )}
        {savedOpen && saved.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.6 }}>No saved signals yet.</div>
        )}
        {savedOpen && savedShown.map((e) => {
          const key = e.id || signalKey(e);
          const open = openKey === 'saved:' + key;
          const isLong = e.direction === 'LONG';
          const st = e.status || '—';
          const stColor =
            st === 'SL_HIT' || st === 'INVALIDATED' ? '#DC2626'
            : st === 'ENTRY_READY' || String(st).includes('TP') ? '#16A34A'
            : st === 'IN_TRADE' ? '#1D4ED8'
            : st === 'WAITING' || st === 'WATCHING' ? '#B45309' : '#374151';
          return (
            <div key={key} style={{ borderTop: '1px solid rgba(128,128,128,0.2)', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {(e.symbol || '').replace(/USDT$/, '')}/USDT · {String(e.tf || '').toUpperCase()}{' '}
                    <span style={{ color: isLong ? '#16A34A' : '#DC2626' }}>{isLong ? '▲ LONG' : '▼ SHORT'}</span>{' '}
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: '#F3F4F6', color: stColor }}>{st}</span>{' '}
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: '#EDE9FE', color: '#5B21B6' }}>{e.label || e.family}</span>
                    <DivChip d={e.divergence} />
                    {e.outcome && <span style={{ marginLeft: 6, fontSize: 11, color: stColor }}>{e.outcome}</span>}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    <b>X</b> {fmtP(e.X?.price)} · <b>A</b> {fmtP(e.A?.price)} · <b>B</b> {fmtP(e.B?.price)} · <b>C</b> {fmtP(e.C?.price)} · <b>D</b> {fmtP(e.D?.price ?? e.entry)}
                  </div>
                  {e.plan && (
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      Entry {fmtP(e.plan.entry)} · SL {fmtP(e.plan.sl)} · TP1 {fmtP(e.plan.tp1)}
                      {' · '}
                      <b style={{ color: '#15803D' }}>Market {fmtP(e.marketPrice ?? e.price)}</b>
                      {e.priceAt != null && (
                        <span style={{ opacity: 0.65, fontSize: 11 }}> · px {fmtClock(e.priceAt)}</span>
                      )}
                      {e.entryTouched ? ' · entry filled' : ' · entry not touched'}
                    </div>
                  )}
                  <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>
                    {e.marketTime != null && <>Last candle {fmtDate(e.marketTime)} {fmtClock(e.marketTime)} · </>}
                    {e.refreshedAt != null && <>Refreshed {fmtDate(e.refreshedAt)} {fmtClock(e.refreshedAt)}</>}
                  </div>
                  {e.error && <div style={{ fontSize: 12, color: '#DC2626' }}>{e.error}</div>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpenKey(open ? null : 'saved:' + key)}>
                    {open ? 'Hide' : 'Chart'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={enterBusyId === key || ['SL_HIT','TP3_HIT','INVALIDATED','MISSED'].includes(String(st))}
                    onClick={() => manualEnterSignal(e)}
                  >
                    {enterBusyId === key ? '…' : 'Manual Entry'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => unsaveSignal(key)}>Remove</button>
                </div>
              </div>
              {open && <HarmonicChartPanel e={e} chartMode={chartMode} />}
            </div>
          );
        })}
      </div>

      <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.75 }}>Filter by pattern (empty = all)</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {FAMILY_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            className={patternFilter.includes(k) ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => togglePatternFilter(k)}
            style={patternFilter.includes(k) ? { background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' } : undefined}
          >
            {DEFAULT_RULES[k]?.label || k}
          </button>
        ))}
        {patternFilter.length > 0 && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPatternFilter([])}>
            Clear filter
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {BUCKETS.map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={bucket === k ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setBucket(k)}
            style={bucket === k ? { background: '#16A34A', borderColor: '#16A34A', color: '#fff' } : undefined}
          >
            {l} · {counts[k] || 0}
          </button>
        ))}
      </div>

      {filtered.length === 0 && !busy && (
        <div style={{ fontSize: 13, opacity: 0.65, padding: '8px 0' }}>No setups in the selected stages.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {resultRows.map((row) => {
          const e = row.e;
          const key = `${e.symbol}|${e.tf}|${e.family}|${e.kind}|${e.C?.time || e.time}|${e.status}`;
          const isLong = e.direction === 'LONG';
          const open = openKey === key;
          const statusColor =
            e.status === 'ENTRY_READY' ? '#1D4ED8' : e.status === 'WAITING' ? '#B45309' : '#374151';
          const statusBg =
            e.status === 'ENTRY_READY' ? '#DBEAFE' : e.status === 'WAITING' ? '#FEF3C7' : '#F3F4F6';
          return (
            <div
              key={key}
              style={{
                border: '1px solid rgba(128,128,128,0.2)',
                borderRadius: 12,
                padding: 12,
                background: open ? 'rgba(124,58,237,0.04)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>
                    {e.symbol.replace(/USDT$/, '')}/USDT · {String(e.tf).toUpperCase()}{' '}
                    <span style={{ color: isLong ? '#16A34A' : '#DC2626' }}>{isLong ? '▲ LONG' : '▼ SHORT'}</span>{' '}
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 999,
                        background: statusBg,
                        color: statusColor,
                      }}
                    >
                      {e.status}
                    </span>
                    <span
                      style={{
                        marginLeft: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 999,
                        background: '#EDE9FE',
                        color: '#5B21B6',
                      }}
                    >
                      {e.label || e.family}
                    </span>
                    <DivChip d={e.divergence} />
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 3 }}>
                    {e.kind === 'PROJECTED' ? 'XABC → D projected' : 'XABCD completed'} · score {e.score} ·{' '}
                    {fmtDate(e.time)} {fmtClock(e.time)}
                    {e.ema200InDzone && (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: '#1D4ED8' }}>EMA200 in D zone</span>
                    )}
                    {e.breakerInDzone && (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: '#DB2777' }}>
                        Breaker in D · {(e.breakers || []).map((b) => b.side).join('/')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85, marginTop: 3, lineHeight: 1.45 }}>
                    <b>X</b> {fmtP(e.X?.price)} · <b>A</b> {fmtP(e.A?.price)} · <b>B</b> {fmtP(e.B?.price)} · <b>C</b>{' '}
                    {fmtP(e.C?.price)} · <b>D</b> {fmtP(e.D?.price ?? e.entry)}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    D zone <b>{fmtP(e.przLow)}</b> – <b>{fmtP(e.przHigh)}</b> · mid {fmtP(e.entry)}
                    {e.ema200 != null && <> · EMA200 {fmtP(e.ema200)}</>}
                  </div>
                  {(e.breakers || []).length > 0 && (
                    <div style={{ fontSize: 12, marginTop: 2, color: '#BE185D' }}>
                      {(e.breakers || []).map((b) => (
                        <div key={b.id}>
                          <b>{b.side} BREAKER</b> {fmtP(b.bot)}–{fmtP(b.top)} · Q{Math.round(b.quality)} · {b.action || b.state}
                          {' · '}inv {fmtP(b.invalidLevel)} · tgt {fmtP(b.targetLevel)}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                    XB {fmtR(e.ratios?.xb)} · BC {fmtR(e.ratios?.bc)} · XD {fmtR(e.ratios?.xd)}
                  </div>
                  {e.plan && (
                    <div style={{ fontSize: 12, marginTop: 3 }}>
                      <span style={{ color: '#16A34A' }}>Entry {fmtP(e.plan.entry)}</span>
                      {' · '}
                      <span style={{ color: '#DC2626' }}>SL {fmtP(e.plan.sl)}</span>
                      {' · '}
                      <span style={{ color: '#059669' }}>
                        TP1 {fmtP(e.plan.tp1)} (R{e.plan.rr1}) · TP2 {fmtP(e.plan.tp2)} (R{e.plan.rr2}) · TP3{' '}
                        {fmtP(e.plan.tp3)} · TP4 {fmtP(e.plan.tp4)}
                      </span>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpenKey(open ? null : key)}>
                    {open ? 'Hide' : 'Chart'}
                  </button>
                  <span style={{ fontSize: 11, textAlign: 'center', color: isSaved(e) ? '#15803D' : '#9CA3AF' }}>
                    {isSaved(e) ? '✓ saved' : 'saving…'}
                  </span>
                </div>
              </div>
              {open && <HarmonicChartPanel e={e} chartMode={chartMode} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** RSI divergence X ↔ D, judged when the signal became ENTRY READY (frozen afterwards). */
function DivChip({ d }) {
  if (!d || !d.evaluatedAt) return null;
  if (!d.found) {
    return (
      <span title={d.reason || 'RSI at X and D agree with price'} style={{ marginLeft: 4, fontSize: 11, padding: '2px 7px', borderRadius: 999, background: '#F3F4F6', color: '#6B7280' }}>
        No divergence
      </span>
    );
  }
  const bear = d.bias === 'BEARISH';
  return (
    <span
      title={`Price X ${d.xPrice} → D ${d.dPrice} · RSI ${d.xRsi} → ${d.dRsi}`}
      style={{ marginLeft: 4, fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: bear ? '#FEE2E2' : '#DCFCE7', color: bear ? '#B91C1C' : '#15803D' }}
    >
      {d.kind === 'HIDDEN' ? 'Hidden' : 'Regular'} {bear ? 'bearish' : 'bullish'} divergence · RSI {d.xRsi}→{d.dRsi}
    </span>
  );
}

export function HarmonicCard() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem('harmonic_card_open');
      if (v === '0') setOpen(false);
      if (v === '1') setOpen(true);
    } catch (_) {}
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem('harmonic_card_open', o ? '0' : '1');
      } catch (_) {}
      return !o;
    });

  return (
    <div className="sg-results" style={{ marginBottom: 14 }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          textAlign: 'left',
          background: 'none',
          border: 0,
          padding: 0,
          cursor: 'pointer',
          color: 'inherit',
        }}
        aria-expanded={open}
      >
        <span>
          <span className="sg-results-title" style={{ display: 'block' }}>
            Harmonic Patterns
          </span>
          <span className="sg-results-sub" style={{ display: 'block' }}>
            Gartley · Bat · Butterfly · Crab · Cypher · Shark · AB=CD · Breaker blocks · D zone confluence
          </span>
        </span>
        <span className="btn btn-secondary btn-sm" style={{ pointerEvents: 'none' }}>
          {open ? 'Hide' : 'Open'}
        </span>
      </button>
      {open && <HarmonicPanel />}
    </div>
  );
}

export default HarmonicCard;
