'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import '../globals.css';
import { GATE_DEFS, defaultGateModes } from '../../lib/scanner/strategy/chartPattern/gates.js';
import { RECOMMENDED_SCANNER_SETTINGS } from '../../lib/config/recommendedScannerSettings.js';
import { EMA_BUMP_DEFAULTS, EMA_BUMP_GATES, ALL_TFS as EMA_BUMP_TFS } from '../../lib/scanner/strategy/emaBump/config.js';
import { tallyEmaBump } from '../../lib/scanner/strategy/emaBump/index.js';
import { tally as pivotTally, PIVOT_EMA_TFS } from '../../lib/scanner/strategy/pivotEma/index.js';
import { HIGH_RISK_DEFAULTS } from '../../lib/trading/riskSizing.js';
import { getVersionLabel } from '../../lib/version.js';
import ScanLogPanel from '../../components/ScanLogPanel.js';
import {
  ZONE_PATTERN_DEFAULTS,
  normalizeZonePatternConfig,
} from '../../lib/scanner/strategy/zonePattern/config.js';

const SECTIONS = [
  { id: 'users', label: 'Users' },
  { id: 'signals', label: 'Signals' },
  { id: 'news', label: 'News' },
  { id: 'branding', label: 'Branding' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'scanlog', label: 'Scan log' },
  { id: 'auto', label: 'Auto-trade' },
  { id: 'ai', label: 'AI Manager' },
  { id: 'reset', label: 'Reset' },
  { id: 'system', label: 'System' },
];

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiCfg, setAiCfg] = useState({ configured: false });
  const [aiKey, setAiKey] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [section, setSection] = useState('users');
  const [newsTitle, setNewsTitle] = useState('');
  const [newsBody, setNewsBody] = useState('');
  const [newsImage, setNewsImage] = useState('');
  const [newsList, setNewsList] = useState([]);
  const [newsBusy, setNewsBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // Branding (logo shown on login / signup)
  const [brand, setBrand] = useState({ logoUrl: null, appName: 'Signal Desk' });
  const [brandName, setBrandName] = useState('Signal Desk');
  const [brandBusy, setBrandBusy] = useState(false);

  // Users
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');

  // Telegram
  const [tg, setTg] = useState({
    bot_token: '',
    chat_id: '',
    bot_username: '',
    configured: false,
    token_preview: null,
    webhook_ok: false,
    webhook_url: '',
    expected_webhook_url: '',
    webhook_error: null,
  });
  const [tgBusy, setTgBusy] = useState(false);

  // Scanner / score / chart pattern
  const [scanBusy, setScanBusy] = useState(false);
  const [activeExchange, setActiveExchange] = useState('binance');
  const [minScore, setMinScore] = useState(RECOMMENDED_SCANNER_SETTINGS.minScore);
  const [minEntryAtr, setMinEntryAtr] = useState(RECOMMENDED_SCANNER_SETTINGS.minEntryATR);
  const [maxEntryAtr, setMaxEntryAtr] = useState(RECOMMENDED_SCANNER_SETTINGS.maxEntryATR);
  const [telegramMaxAtr, setTelegramMaxAtr] = useState(RECOMMENDED_SCANNER_SETTINGS.telegramMaxATR);
  const [maxGapPercent, setMaxGapPercent] = useState(RECOMMENDED_SCANNER_SETTINGS.maxGapPercent);
  const [requireHtf, setRequireHtf] = useState(RECOMMENDED_SCANNER_SETTINGS.requireHtfAligned);
  const [requireLiq, setRequireLiq] = useState(RECOMMENDED_SCANNER_SETTINGS.requireLiquidityEdge);
  const [requireSweepFvg, setRequireSweepFvg] = useState(RECOMMENDED_SCANNER_SETTINGS.requireSweepOrFvg);
  const [strategyMode, setStrategyMode] = useState('zone_pattern');
  const [doubleConfluenceConfig, setDoubleConfluenceConfig] = useState({});
  const [emaBumpConfig, setEmaBumpConfig] = useState({ ...EMA_BUMP_DEFAULTS });
  // Pivot + EMA cross backtest
  const [pivotTfs, setPivotTfs] = useState(['2h']);
  const [pivotUniverse, setPivotUniverse] = useState(100);
  const [pivotCrossDist, setPivotCrossDist] = useState(2.5);
  const [pivotSlMode, setPivotSlMode] = useState('swing'); // 'swing' | 'cross' | 'pivot'
  const [pivotSlFromCross, setPivotSlFromCross] = useState(0.6);
  const [pivotStopATR, setPivotStopATR] = useState(1);
  const [pivotTargetATR, setPivotTargetATR] = useState(1);
  const [pivotNoRecross, setPivotNoRecross] = useState(true);
  const [pivotBothSideCross, setPivotBothSideCross] = useState(false);
  const [pivotRejectChop, setPivotRejectChop] = useState(true);
  const [pivotMaxCrosses, setPivotMaxCrosses] = useState(3);
  const [pivotMaxCrossSpan, setPivotMaxCrossSpan] = useState(18);
  const [pivotBreakMode, setPivotBreakMode] = useState('wick');
  const [pivotUsePatterns, setPivotUsePatterns] = useState(true);
  const [pivotBreakBuf, setPivotBreakBuf] = useState(0.02);
  const [pivotMinRun, setPivotMinRun] = useState(0.3);
  const [pivotMinCrossAgo, setPivotMinCrossAgo] = useState(1);
  const [pivotCheckSymbol, setPivotCheckSymbol] = useState('');
  const [pivotRun, setPivotRun] = useState(null);
  const [pivotFilter, setPivotFilter] = useState('ALL');
  const pivotStop = useRef(false);
  // EMA Bump backtest
  const [emaBtUniverse, setEmaBtUniverse] = useState(100);
  const [emaBtCheckSymbol, setEmaBtCheckSymbol] = useState('');
  const [emaBtRun, setEmaBtRun] = useState(null);
  const [emaBtFilter, setEmaBtFilter] = useState('ALL');
  const emaBtStop = useRef(false);
  const [zonePatternConfig, setZonePatternConfig] = useState(() =>
    normalizeZonePatternConfig(ZONE_PATTERN_DEFAULTS)
  );
  const [smcSetupTf, setSmcSetupTf] = useState(RECOMMENDED_SCANNER_SETTINGS.smcConfig.setupTf);
  const [smcHtfTf, setSmcHtfTf] = useState(RECOMMENDED_SCANNER_SETTINGS.smcConfig.htfTf);
  const [cpMinScore, setCpMinScore] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.minSignalScore);
  const [cpNearMaxAge, setCpNearMaxAge] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.nearMaxPatternAge);
  const [cpStaleRescue, setCpStaleRescue] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.nearStaleRescue ?? true);
  const [cpRescueMaxAge, setCpRescueMaxAge] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.nearStaleRescueMaxAge ?? 150);
  const [cpRescueGap, setCpRescueGap] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.nearStaleRescueMaxGapATR ?? 1.5);
  const [cpMinRvol, setCpMinRvol] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.minRelativeVolume);
  const [cpMinRr, setCpMinRr] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.minRR);
  const [cpBreakoutAtr, setCpBreakoutAtr] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.breakoutAtrMin);
  const [cpMinTp1Rr, setCpMinTp1Rr] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.minTp1RR);
  const [cpLiveEntry, setCpLiveEntry] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.nearEntryOnLivePrice ?? true);
  const [cpFailedBo, setCpFailedBo] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.failedBreakoutInvalidate ?? true);
  const [cpWeakBoPromote, setCpWeakBoPromote] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.weakBreakoutPromote ?? false);
  const [cpWeakBoChaseR, setCpWeakBoChaseR] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.weakBreakoutMaxChaseR ?? 0.35);
  const [cpFbAtr, setCpFbAtr] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.failedBreakoutBufferATR ?? 0.5);
  const [cpFbCandles, setCpFbCandles] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.failedBreakoutConfirmCandles ?? 2);
  const [cpMinPillars, setCpMinPillars] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.minConfluencePillars ?? 1);
  const [cpElliottWave, setCpElliottWave] = useState(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.waveAnalysisEnabled);
  const [cpGateModes, setCpGateModes] = useState(() => ({
    ...defaultGateModes(RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig),
    ...RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.gateModes,
  }));
  const [cpPresetNote, setCpPresetNote] = useState('');
  const CP_PRESETS = {
    quality: {
      label: '🎯 Best quality',
      note: 'Fewest signals, cleanest setups: high score, volume + HTF + zone must agree, strict RR. Fake-breakout line 0.5 ATR.',
      score: 68, nearAge: 20, rvol: 1.5, rr: 1.5, tp1: 1.2, boAtr: 0.25, fbAtr: 0.5, fbCandles: 2, pillars: 2,
      gates: { htf: 'hard', volume: 'hard', retest: 'soft', pillars: 'hard', smc: 'soft', fib: 'soft', rejectionZone: 'hard', rejection: 'hard', location: 'hard', midRange: 'hard', wave: 'soft', blockedPath: 'hard', tp1rr: 'hard', tp2rr: 'hard', rsiDiv: 'hard', ema: 'hard' },
    },
    balanced: {
      label: '⚖️ Balanced',
      note: 'Recommended middle: decent score, reversals must sit on a zone, volume/HTF only reduce score. Fake-breakout line 0.5 ATR.',
      score: 60, nearAge: 30, rvol: 1.2, rr: 1.2, tp1: 1.0, boAtr: 0.2, fbAtr: 0.5, fbCandles: 2, pillars: 1,
      gates: { htf: 'soft', volume: 'soft', retest: 'soft', pillars: 'hard', smc: 'soft', fib: 'soft', rejectionZone: 'hard', rejection: 'soft', location: 'soft', midRange: 'hard', wave: 'soft', blockedPath: 'soft', tp1rr: 'hard', tp2rr: 'hard', rsiDiv: 'soft', ema: 'soft' },
    },
    more: {
      label: '📈 More signals',
      note: 'Most signals: low score, nearly all gates only reduce score (RR stays hard). Expect more noise. Fake-breakout line 0.7 ATR so fewer get cut early.',
      score: 50, nearAge: 40, rvol: 1.0, rr: 1.0, tp1: 1.0, boAtr: 0.12, fbAtr: 0.7, fbCandles: 2, pillars: 0,
      gates: { htf: 'soft', volume: 'soft', retest: 'soft', pillars: 'soft', smc: 'soft', fib: 'soft', rejectionZone: 'soft', rejection: 'soft', location: 'soft', midRange: 'soft', wave: 'soft', blockedPath: 'soft', tp1rr: 'hard', tp2rr: 'hard', rsiDiv: 'soft', ema: 'soft' },
    },
  };
  function applyCpPreset(key) {
    const p = CP_PRESETS[key];
    if (!p) return;
    setCpMinScore(p.score);
    setCpNearMaxAge(p.nearAge);
    setCpMinRvol(p.rvol);
    setCpMinRr(p.rr);
    setCpMinTp1Rr(p.tp1);
    setCpBreakoutAtr(p.boAtr);
    setCpFbAtr(p.fbAtr);
    setCpFbCandles(p.fbCandles);
    setCpMinPillars(p.pillars);
    setCpFailedBo(true);
    setCpGateModes((prev) => ({ ...prev, ...p.gates }));
    setCpPresetNote(`${p.label}: ${p.note}`);
  }
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
    'ALT_BAT_BULL', 'ALT_BAT_BEAR', 'THREE_DRIVES_BULL', 'THREE_DRIVES_BEAR',
    'WOLFE_WAVE_BULL', 'WOLFE_WAVE_BEAR',
    'QUASIMODO_BULL', 'QUASIMODO_BEAR', 'ONE_TWO_THREE_BULL', 'ONE_TWO_THREE_BEAR',
    'WYCKOFF_SPRING_BULL', 'WYCKOFF_UPTHRUST_BEAR', 'LIQUIDITY_SWEEP_BULL', 'LIQUIDITY_SWEEP_BEAR',
    'BREAKOUT_RETEST_BULL', 'BREAKOUT_RETEST_BEAR', 'CORRECTIVE_ABC_BULL', 'CORRECTIVE_ABC_BEAR',
    'ELLIOTT_WAVE_BULL', 'ELLIOTT_WAVE_BEAR',
  ];
  const [cpTfs, setCpTfs] = useState(
    RECOMMENDED_SCANNER_SETTINGS.chartPatternConfig.patternTfs || ['15m', '30m', '1h']
  );
  // null = ALL
  const [cpPatterns, setCpPatterns] = useState(null);

  // Auto-trade global
  const [autoCfg, setAutoCfg] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);

  // Reset
  const [resetBusy, setResetBusy] = useState(false);
  const [resetSecret, setResetSecret] = useState('');
  const [resetMode, setResetMode] = useState('history');
  const [resetPreview, setResetPreview] = useState(null);

  // System
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [fullScanInterval, setFullScanInterval] = useState(5);
  const [fullScanBudget, setFullScanBudget] = useState(40);
  const [fullScanParts, setFullScanParts] = useState(3);
  const [scanExchanges, setScanExchanges] = useState(['binance']);
  const [sysBusy, setSysBusy] = useState(false);

  // Bybit global keys (legacy shared)
  const [bybitKey, setBybitKey] = useState('');
  const [bybitSecret, setBybitSecret] = useState('');
  const [bybitInfo, setBybitInfo] = useState(null);

  // Signals (admin status control)
  const [sigData, setSigData] = useState({ watching: [], ready: [], ongoing: [], counts: {} });
  const [sigBusy, setSigBusy] = useState(false);
  const [sigFilter, setSigFilter] = useState('all'); // all | watching | ready | ongoing

  const flash = (text) => setMsg(text);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/auth/me');
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      const data = await res.json();
      if (data.user?.role !== 'admin') {
        router.replace('/');
        return;
      }
      setUser(data.user);
      await Promise.all([loadUsers(), loadTelegram(), loadAi(), loadScore(), loadAuto(), loadBybit(), loadScanFlag(), loadSignals(), loadNewsAdmin(), loadBranding()]);
      setLoading(false);
    })();
  }, [router]);

  async function loadUsers(q = search) {
    const res = await fetch(`/api/admin/users?search=${encodeURIComponent(q)}`);
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users || []);
    }
  }


  async function loadBranding() {
    try {
      const res = await fetch('/api/branding', { cache: 'no-store' });
      const data = await res.json();
      setBrand({ logoUrl: data.logoUrl || null, appName: data.appName || 'Signal Desk' });
      setBrandName(data.appName || 'Signal Desk');
    } catch (_) {}
  }
  async function saveBranding(payload, okText) {
    setBrandBusy(true);
    try {
      const res = await fetch('/api/branding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setBrand({ logoUrl: data.logoUrl || null, appName: data.appName || 'Signal Desk' });
      setBrandName(data.appName || 'Signal Desk');
      flash(okText);
    } catch (e) {
      flash(e.message || 'Error');
    } finally {
      setBrandBusy(false);
    }
  }
  // Shrink big images in the browser (max 600px on the long side) so the
  // stored logo stays small and loads instantly. PNG keeps transparency.
  function fileToLogoDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('No file'));
      if (file.type === 'image/svg+xml') {
        if (file.size > 400 * 1024) return reject(new Error('SVG is too large (max 400 KB)'));
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('Could not read file'));
        r.readAsDataURL(file);
        return;
      }
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Use a PNG, JPG, WebP or SVG image'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 600;
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open image')); };
      img.src = url;
    });
  }
  async function onLogoPicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToLogoDataUrl(file);
      await saveBranding({ logoUrl: dataUrl }, 'Logo updated');
    } catch (err) {
      flash(err.message || 'Error');
    }
  }
  async function loadNewsAdmin() {
    try {
      const res = await fetch('/api/news?limit=30');
      const data = await res.json();
      if (res.ok) setNewsList(data.items || []);
    } catch (_) {}
  }
  async function postNews() {
    setNewsBusy(true);
    try {
      const res = await fetch('/api/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newsTitle, body: newsBody, imageUrl: newsImage || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setNewsTitle(''); setNewsBody(''); setNewsImage('');
      flash('News published');
      await loadNewsAdmin();
    } catch (e) {
      flash(e.message || 'Error', true);
    } finally {
      setNewsBusy(false);
    }
  }
  async function removeNews(id) {
    if (!confirm('Delete this news post?')) return;
    setNewsBusy(true);
    try {
      const res = await fetch('/api/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      await loadNewsAdmin();
      flash('Deleted');
    } catch (e) {
      flash(e.message || 'Error', true);
    } finally {
      setNewsBusy(false);
    }
  }

  async function loadTelegram() {
    try {
      const res = await fetch('/api/settings/telegram');
      if (!res.ok) return;
      const data = await res.json();
      setTg((t) => ({
        ...t,
        configured: !!data.configured,
        token_preview: data.token_preview || null,
        chat_id: data.chat_id && data.chat_id !== '(from env)' ? String(data.chat_id) : t.chat_id,
        bot_username: data.bot_username || t.bot_username || '',
        webhook_ok: !!data.webhook_ok,
        webhook_url: data.webhook?.url || '',
        expected_webhook_url: data.expected_webhook_url || '',
        webhook_error: data.webhook?.last_error_message || null,
      }));
    } catch (_) {}
  }

  async function loadAi() {
    try {
      const res = await fetch('/api/admin/ai');
      if (!res.ok) return;
      setAiCfg(await res.json());
    } catch (_) {}
  }

  async function saveAiKey() {
    setAiBusy(true);
    try {
      const res = await fetch('/api/admin/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: aiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      flash('Gemini key saved — Nila is on for all users');
      setAiKey('');
      await loadAi();
    } catch (e) {
      flash(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function testAiKey() {
    setAiBusy(true);
    try {
      const res = await fetch('/api/admin/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test',
          ...(aiKey.trim() ? { api_key: aiKey.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test failed');
      flash(`OK: ${String(data.reply || 'Nila online').slice(0, 120)}`);
      await loadAi();
    } catch (e) {
      flash(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function loadScore() {
    try {
      const res = await fetch('/api/settings/score');
      if (!res.ok) return;
      const data = await res.json();
      if (data.minScore != null) setMinScore(+data.minScore);
      if (data.minEntryATR != null) setMinEntryAtr(+data.minEntryATR);
      if (data.maxEntryATR != null) setMaxEntryAtr(+data.maxEntryATR);
      if (data.telegramMaxATR != null) setTelegramMaxAtr(+data.telegramMaxATR);
      if (data.maxGapPercent != null) setMaxGapPercent(+data.maxGapPercent);
      if (typeof data.requireHtfAligned === 'boolean') setRequireHtf(data.requireHtfAligned);
      if (typeof data.requireLiquidityEdge === 'boolean') setRequireLiq(data.requireLiquidityEdge);
      if (typeof data.requireSweepOrFvg === 'boolean') setRequireSweepFvg(data.requireSweepOrFvg);
      if (data.strategyMode) setStrategyMode(data.strategyMode);
      if (data.zonePatternConfig) {
        setZonePatternConfig(normalizeZonePatternConfig(data.zonePatternConfig));
      }
      if (data.emaBumpConfig) setEmaBumpConfig({ ...EMA_BUMP_DEFAULTS, ...data.emaBumpConfig });
      const smc = data.smcConfig || {};
      if (smc.setupTf) setSmcSetupTf(smc.setupTf);
      if (smc.htfTf) setSmcHtfTf(smc.htfTf);
      const cpc = data.chartPatternConfig || {};
      if (cpc.minSignalScore != null) setCpMinScore(+cpc.minSignalScore);
      if (cpc.nearMaxPatternAge != null) setCpNearMaxAge(+cpc.nearMaxPatternAge);
      if (typeof cpc.nearStaleRescue === 'boolean') setCpStaleRescue(cpc.nearStaleRescue);
      if (cpc.nearStaleRescueMaxAge != null) setCpRescueMaxAge(+cpc.nearStaleRescueMaxAge);
      if (cpc.nearStaleRescueMaxGapATR != null) setCpRescueGap(+cpc.nearStaleRescueMaxGapATR);
      if (cpc.minRelativeVolume != null) setCpMinRvol(+cpc.minRelativeVolume);
      if (cpc.minRR != null) setCpMinRr(+cpc.minRR);
      if (cpc.breakoutAtrMin != null) setCpBreakoutAtr(+cpc.breakoutAtrMin);
      if (cpc.minTp1RR != null) setCpMinTp1Rr(+cpc.minTp1RR);
      if (typeof cpc.nearEntryOnLivePrice === 'boolean') setCpLiveEntry(cpc.nearEntryOnLivePrice);
      if (typeof cpc.weakBreakoutPromote === 'boolean') setCpWeakBoPromote(cpc.weakBreakoutPromote);
      if (cpc.weakBreakoutMaxChaseR != null) setCpWeakBoChaseR(+cpc.weakBreakoutMaxChaseR);
      if (typeof cpc.failedBreakoutInvalidate === 'boolean') setCpFailedBo(cpc.failedBreakoutInvalidate);
      if (cpc.failedBreakoutBufferATR != null) setCpFbAtr(+cpc.failedBreakoutBufferATR);
      if (cpc.failedBreakoutConfirmCandles != null) setCpFbCandles(+cpc.failedBreakoutConfirmCandles);
      if (cpc.minConfluencePillars != null) setCpMinPillars(+cpc.minConfluencePillars);
      if (typeof cpc.waveAnalysisEnabled === 'boolean') setCpElliottWave(cpc.waveAnalysisEnabled);
      if (Array.isArray(cpc.patternTfs) && cpc.patternTfs.length) setCpTfs(cpc.patternTfs);
      if (cpc.enabledPatterns === 'ALL' || cpc.enabledPatterns == null) setCpPatterns(null);
      else if (Array.isArray(cpc.enabledPatterns)) setCpPatterns(cpc.enabledPatterns);
      setCpGateModes({ ...defaultGateModes(cpc), ...(cpc.gateModes || {}) });
    } catch (_) {}
    try {
      const res = await fetch('/api/settings/exchange');
      if (res.ok) {
        const data = await res.json();
        if (data.exchange) setActiveExchange(data.exchange);
      }
    } catch (_) {}
  }

  async function loadAuto() {
    try {
      const res = await fetch('/api/auto-trading');
      if (!res.ok) return;
      const data = await res.json();
      setAutoCfg(data.config || data || null);
    } catch (_) {}
  }

  async function loadBybit() {
    try {
      const res = await fetch('/api/settings/bybit');
      if (res.ok) setBybitInfo(await res.json());
    } catch (_) {}
  }

  async function loadScanFlag() {
    try {
      // infer from scan start response or signals - try scan route
      const res = await fetch('/api/scan');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.auto_scan_enabled === 'boolean') setAutoScanEnabled(data.auto_scan_enabled);
        if (data.full_scan_interval_minutes != null) setFullScanInterval(+data.full_scan_interval_minutes || 5);
        if (data.full_scan_budget_seconds != null) setFullScanBudget(+data.full_scan_budget_seconds || 40);
        if (data.full_scan_parts != null) setFullScanParts(+data.full_scan_parts || 3);
        if (Array.isArray(data.scan_exchanges)) setScanExchanges(data.scan_exchanges);
        if (data.config?.exchange) setActiveExchange(data.config.exchange);
      }
    } catch (_) {}
  }

  async function loadSignals() {
    try {
      const res = await fetch('/api/admin/signals');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        flash(err.error || 'Failed to load signals');
        return;
      }
      const data = await res.json();
      setSigData({
        watching: data.watching || [],
        ready: data.ready || [],
        ongoing: data.ongoing || [],
        counts: data.counts || {},
      });
    } catch (e) {
      flash(e.message || 'Load signals failed');
    }
  }

  async function changeSignalStatus(signalId, action, status = null) {
    setSigBusy(true);
    try {
      const body = { signalId, action };
      if (status) body.status = status;
      const res = await fetch('/api/admin/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        flash(data.error || 'Status change failed');
      } else {
        flash(data.message || `${data.from} → ${data.to}`);
        await loadSignals();
      }
    } catch (e) {
      flash(e.message || 'Status change failed');
    } finally {
      setSigBusy(false);
    }
  }

  async function extendTrial(userId, days = 7) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'extend_trial', days }),
    });
    const data = await res.json();
    flash(data.error || 'Trial extended');
    await loadUsers();
  }

  async function assignPlan(userId, plan) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'assign_plan', plan }),
    });
    const data = await res.json();
    flash(data.error || `Plan → ${plan}`);
    await loadUsers();
  }

  async function toggleSuspend(userId, suspend) {
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: suspend ? 'suspend' : 'unsuspend' }),
    });
    const data = await res.json();
    flash(data.error || (suspend ? 'Suspended' : 'Unsuspended'));
    await loadUsers();
  }

  async function clearTradeHistory(u, force = false) {
    if (!force) {
      const ok = window.confirm(
        `Delete ALL trade history for ${u.email}?\n\n` +
          'This also turns auto-trade OFF and clears their starting capital, so they can start fresh.\n' +
          'This cannot be undone.'
      );
      if (!ok) return;
    }
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, action: 'clear_trade_history', force }),
    });
    const data = await res.json();
    if (res.status === 409 && data.code === 'OPEN_TRADES') {
      if (window.confirm(`${data.error}.\nClose them first, or delete anyway?\n\nDelete anyway?`)) {
        return clearTradeHistory(u, true);
      }
      return;
    }
    flash(data.error || `Deleted ${data.deleted} trade record(s)`);
    await loadUsers();
  }

  async function deleteAccount(u, force = false) {
    if (!force) {
      const typed = window.prompt(
        `PERMANENTLY delete the account ${u.email}?\n\n` +
          'This removes the user, their exchange API keys, trading settings, subscription and ALL trade history. ' +
          'It cannot be undone.\n\nType the email to confirm:'
      );
      if (typed == null) return;
      if (typed.trim().toLowerCase() !== String(u.email).toLowerCase()) {
        flash('Email did not match — nothing deleted');
        return;
      }
    }
    const res = await fetch('/api/admin/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, force }),
    });
    const data = await res.json();
    if (res.status === 409 && data.code === 'OPEN_TRADES') {
      if (window.confirm(`${data.error}.\nClose them on the exchange first.\n\nDelete the account anyway?`)) {
        return deleteAccount(u, true);
      }
      return;
    }
    flash(data.error || `Account deleted: ${data.deleted}`);
    await loadUsers();
  }

  /** Admin: log in as a user without their password */
  async function loginAsUser(u) {
    if (!window.confirm(`Log in as ${u.email}?\n\nYou will be switched to their account (no password needed).`)) {
      return;
    }
    const res = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, action: 'impersonate' }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      flash(data.error || 'Login as user failed');
      return;
    }
    flash(`Now logged in as ${u.email}`);
    // Full page navigation so the new session cookie is used everywhere
    window.location.href = data.redirect || '/';
  }

  async function saveTelegram(withTest) {
    setTgBusy(true);
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_token: tg.bot_token,
          chat_id: tg.chat_id,
          bot_username: tg.bot_username,
          test: !!withTest,
          set_webhook: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      const wh = data.webhook;
      let msg = withTest ? 'Saved + test sent' : 'Telegram saved';
      if (wh?.ok) msg += ' · webhook set';
      else if (wh && !wh.ok) msg += ` · webhook: ${wh.error || 'failed'}`;
      if (data.bot_username) msg += ` · @${data.bot_username}`;
      flash(msg);
      setTg((t) => ({
        ...t,
        bot_token: '',
        configured: true,
        bot_username: data.bot_username || t.bot_username,
      }));
      await loadTelegram();
    } catch (e) {
      flash(e.message);
    } finally {
      setTgBusy(false);
    }
  }

  async function setWebhookNow() {
    setTgBusy(true);
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_webhook' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Webhook failed');
      flash(`Webhook set → ${data.url || 'ok'}`);
      await loadTelegram();
    } catch (e) {
      flash(e.message);
    } finally {
      setTgBusy(false);
    }
  }

  async function refreshBoard() {
    setTgBusy(true);
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh_live_board' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refresh failed');
      flash('Live board refreshed');
    } catch (e) {
      flash(e.message);
    } finally {
      setTgBusy(false);
    }
  }

  async function switchExchange(ex) {
    setScanBusy(true);
    try {
      const res = await fetch('/api/settings/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: ex }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Switch failed');
      setActiveExchange(data.exchange || ex);
      flash(data.msg || `Exchange → ${ex}`);
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function saveScannerSettings() {
    setScanBusy(true);
    try {
      const payload = {
        strategyMode,
        ...(strategyMode === 'zone_pattern' ? { zonePatternConfig } : {}),
        ...(strategyMode === 'double_confluence' ? { doubleConfluenceConfig } : {}),
        ...(strategyMode === 'ema_bump' ? { emaBumpConfig } : {}),
      };
      if (strategyMode !== 'zone_pattern' && strategyMode !== 'double_confluence' && strategyMode !== 'ema_bump' && strategyMode !== 'pivot_ema') {
        Object.assign(payload, {
          minScore,
          minEntryATR: minEntryAtr,
          maxEntryATR: maxEntryAtr,
          telegramMaxATR: telegramMaxAtr,
          maxGapPercent,
          requireHtfAligned: requireHtf,
          requireLiquidityEdge: requireLiq,
          requireSweepOrFvg: requireSweepFvg,
          smcConfig: {
            setupTf: smcSetupTf,
            htfTf: smcHtfTf,
          },
          chartPatternConfig: {
            minSignalScore: cpMinScore,
            minFinalScore: cpMinScore,
            nearMaxPatternAge: cpNearMaxAge,
            nearStaleRescue: cpStaleRescue,
            nearStaleRescueMaxAge: cpRescueMaxAge,
            nearStaleRescueMaxGapATR: cpRescueGap,
            minRelativeVolume: cpMinRvol,
            minRR: cpMinRr,
            breakoutAtrMin: cpBreakoutAtr,
            minTp1RR: cpMinTp1Rr,
            nearEntryOnLivePrice: !!cpLiveEntry,
            weakBreakoutPromote: !!cpWeakBoPromote,
            weakBreakoutMaxChaseR: cpWeakBoChaseR,
            failedBreakoutInvalidate: cpFailedBo,
            failedBreakoutBufferATR: cpFbAtr,
            failedBreakoutConfirmCandles: cpFbCandles,
            minConfluencePillars: cpMinPillars,
            gateModes: cpGateModes,
            waveAnalysisEnabled: cpElliottWave || cpGateModes?.wave === 'hard',
            minWaveScore: cpGateModes?.wave === 'hard' ? 40 : undefined,
            patternTfs: cpTfs,
            enabledPatterns: cpPatterns == null ? 'ALL' : cpPatterns,
          },
        });
      }
      const res = await fetch('/api/settings/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      flash(data.msg || 'Scanner settings saved');
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function applyRecommendedScannerSettings() {
    setScanBusy(true);
    try {
      const res = await fetch('/api/settings/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(RECOMMENDED_SCANNER_SETTINGS),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not apply recommended settings');
      await loadScore();
      flash('Balanced ICT + Chart Pattern settings applied. Existing active signals are unchanged.');
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function applyRecommendedZonePatternSettings() {
    setScanBusy(true);
    try {
      const recommended = normalizeZonePatternConfig(ZONE_PATTERN_DEFAULTS);
      const res = await fetch('/api/settings/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategyMode: 'zone_pattern',
          zonePatternConfig: recommended,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not apply recommended zone + pattern settings');
      setStrategyMode('zone_pattern');
      setZonePatternConfig(recommended);
      flash('Recommended independent Zone + Pattern settings applied. Other strategy settings and active signals are unchanged.');
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function saveBybitKeys() {
    setScanBusy(true);
    try {
      const res = await fetch('/api/settings/bybit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: bybitKey, apiSecret: bybitSecret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bybit save failed');
      setBybitKey('');
      setBybitSecret('');
      setBybitInfo(data);
      flash(data.msg || 'Bybit keys saved');
      await loadBybit();
    } catch (e) {
      flash(e.message);
    } finally {
      setScanBusy(false);
    }
  }

  async function saveAutoConfig(patch) {
    setAutoBusy(true);
    try {
      const res = await fetch('/api/auto-trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveConfig', ...patch }),
      });
      const data = await res.json();
      if (!res.ok) {
        // try alternate body shape
        const res2 = await fetch('/api/auto-trading', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const data2 = await res2.json();
        if (!res2.ok) throw new Error(data2.error || data.error || 'Save failed');
        setAutoCfg(data2.config || data2);
        flash('Auto-trade config saved');
      } else {
        setAutoCfg(data.config || data);
        flash('Auto-trade config saved');
      }
      await loadAuto();
    } catch (e) {
      flash(e.message);
    } finally {
      setAutoBusy(false);
    }
  }

  async function toggleAutoScan() {
    setSysBusy(true);
    try {
      const path = autoScanEnabled ? '/api/scan/stop' : '/api/scan/start';
      const res = await fetch(path, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setAutoScanEnabled(!autoScanEnabled);
      flash(data.msg || (autoScanEnabled ? 'Auto-scan OFF' : 'Auto-scan ON'));
    } catch (e) {
      flash(e.message);
    } finally {
      setSysBusy(false);
    }
  }


  function pivotCfgBody(extra = {}) {
    return {
      timeframes: pivotTfs,
      universe: pivotUniverse,
      maxCrossDist: Math.max(0.05, +pivotCrossDist || 0.05),
      slMode: pivotSlMode,
      slFromCrossATR: pivotSlFromCross,
      stopATR: pivotStopATR,
      targetATR: pivotTargetATR,
      requireNoRecross: pivotNoRecross,
      requireBothSidePivotCross: pivotBothSideCross,
      rejectChop: pivotRejectChop,
      maxEmaCrossesInWindow: pivotMaxCrosses,
      maxBarsBetweenFirstSecondCross: pivotMaxCrossSpan,
      breakMode: pivotBreakMode,
      useLegPatterns: pivotUsePatterns,
      breakBeyondATR: pivotBreakBuf,
      minRunATR: pivotMinRun,
      minCrossBarsAgo: pivotMinCrossAgo,
      ...extra,
    };
  }

  async function runPivotBacktest() {
    pivotStop.current = false;
    const acc = { events: [], baseline: {}, errors: [], touches: 0, total: 0, offset: 0, done: false, running: true, tfs: [...pivotTfs] };
    setPivotRun({ ...acc });
    let offset = 0;
    try {
      while (!pivotStop.current) {
        const res = await fetch('/api/backtest/pivot-ema', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pivotCfgBody({ offset, limit: 8 })),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          acc.errors.push(data.error || `HTTP ${res.status}`);
          break;
        }
        acc.events.push(...data.events);
        acc.touches += data.touches || 0;
        acc.total = data.total;
        acc.offset = data.nextOffset;
        for (const [tf, b] of Object.entries(data.baseline || {})) {
          const cur = (acc.baseline[tf] ||= { total: 0, win: 0, loss: 0, timeout: 0, open: 0 });
          for (const k of Object.keys(cur)) cur[k] += b[k] || 0;
        }
        acc.errors.push(...(data.errors || []));
        setPivotRun({ ...acc, events: [...acc.events], baseline: { ...acc.baseline } });
        if (data.banned) {
          acc.errors.push('Binance rate limit / ban — stopped early');
          break;
        }
        if (data.done) {
          acc.done = true;
          break;
        }
        offset = data.nextOffset;
      }
    } catch (e) {
      acc.errors.push(e.message);
    }
    setPivotRun({ ...acc, events: [...acc.events], baseline: { ...acc.baseline }, running: false });
  }

  /** Single-coin setup check — type a symbol (e.g. JCTUSDT) and scan only that pair. */
  async function checkPivotCoin() {
    const sym = String(pivotCheckSymbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!sym) {
      flash('Type a coin symbol first (e.g. BTCUSDT or JCTUSDT)');
      return;
    }
    pivotStop.current = false;
    const acc = { events: [], baseline: {}, errors: [], touches: 0, total: 1, offset: 0, done: false, running: true, tfs: [...pivotTfs], checkSymbol: sym };
    setPivotRun({ ...acc });
    try {
      const res = await fetch('/api/backtest/pivot-ema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pivotCfgBody({ symbol: sym, offset: 0, limit: 1 })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        acc.errors.push(data.error || `HTTP ${res.status}`);
      } else {
        acc.events = data.events || [];
        acc.touches = data.touches || 0;
        acc.total = 1;
        acc.done = true;
        for (const [tf, b] of Object.entries(data.baseline || {})) {
          const cur = (acc.baseline[tf] ||= { total: 0, win: 0, loss: 0, timeout: 0, open: 0 });
          for (const k of Object.keys(cur)) cur[k] += b[k] || 0;
        }
        acc.errors.push(...(data.errors || []));
        if (!acc.events.length) acc.errors.push(`No clean Pivot+EMA setups found on ${sym} for selected TFs (last ~1000 candles).`);
      }
    } catch (e) {
      acc.errors.push(e.message);
    }
    setPivotRun({ ...acc, events: [...acc.events], baseline: { ...acc.baseline }, running: false });
  }

  function emaBtCfgBody(extra = {}) {
    const c = emaBumpConfig || {};
    return {
      timeframes: Array.isArray(c.timeframes) && c.timeframes.length ? c.timeframes : ['15m'],
      universe: emaBtUniverse,
      requirePriorSlowCross: !!c.requirePriorSlowCross,
      priorSlowCrossMaxBars: c.priorSlowCrossMaxBars,
      priorSlowCrossMaxLevelATR: c.priorSlowCrossMaxLevelATR,
      useHarmonicEntry: !!c.useHarmonicEntry,
      requireHarmonic: !!c.requireHarmonic,
      harmonicBcMin: c.harmonicBcMin,
      harmonicBcMax: c.harmonicBcMax,
      harmonicXLookback: c.harmonicXLookback,
      harmonicPatterns: c.harmonicPatterns,
      allowLong: c.allowLong !== false,
      allowShort: c.allowShort !== false,
      minDepthATR: c.minDepthATR,
      maxTouchAgeBars: c.maxTouchAgeBars,
      maxTopAgeBars: c.maxTopAgeBars,
      minBumpATR: c.minBumpATR,
      maxBumpATR: c.maxBumpATR,
      tp1R: c.tp1R,
      minRR: c.minRR,
      allowRecentCross: c.allowRecentCross !== false,
      ...extra,
    };
  }

  async function runEmaBumpBacktest() {
    emaBtStop.current = false;
    const acc = { events: [], errors: [], setups: 0, total: 0, offset: 0, done: false, running: true, tfs: [...(emaBumpConfig.timeframes || ['15m'])] };
    setEmaBtRun({ ...acc });
    let offset = 0;
    try {
      while (!emaBtStop.current) {
        const res = await fetch('/api/backtest/ema-bump', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emaBtCfgBody({ offset, limit: 8 })),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          acc.errors.push(data.error || `HTTP ${res.status}`);
          break;
        }
        acc.events.push(...(data.events || []));
        acc.setups += data.setups || 0;
        acc.total = data.total;
        acc.offset = data.nextOffset;
        acc.errors.push(...(data.errors || []));
        setEmaBtRun({ ...acc, events: [...acc.events] });
        if (data.banned) {
          acc.errors.push('Binance rate limit / ban — stopped early');
          break;
        }
        if (data.done) {
          acc.done = true;
          break;
        }
        offset = data.nextOffset;
      }
    } catch (e) {
      acc.errors.push(e.message);
    }
    setEmaBtRun({ ...acc, events: [...acc.events], running: false });
  }

  async function checkEmaBumpCoin() {
    const sym = String(emaBtCheckSymbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!sym) {
      flash('Type a coin symbol first (e.g. BTCUSDT)');
      return;
    }
    emaBtStop.current = false;
    const acc = { events: [], errors: [], setups: 0, total: 1, offset: 0, done: false, running: true, tfs: [...(emaBumpConfig.timeframes || ['15m'])], checkSymbol: sym };
    setEmaBtRun({ ...acc });
    try {
      const res = await fetch('/api/backtest/ema-bump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emaBtCfgBody({ symbol: sym, offset: 0, limit: 1 })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        acc.errors.push(data.error || `HTTP ${res.status}`);
      } else {
        acc.events = data.events || [];
        acc.setups = data.setups || 0;
        acc.total = 1;
        acc.done = true;
        acc.errors.push(...(data.errors || []));
        if (!acc.events.length) acc.errors.push(`No EMA Bump setups found on ${sym} for selected TFs (last ~1000 candles).`);
      }
    } catch (e) {
      acc.errors.push(e.message);
    }
    setEmaBtRun({ ...acc, events: [...acc.events], running: false });
  }

  async function runScanNow() {
    setSysBusy(true);
    try {
      // Manual scan (admin) — does not need CRON_SECRET; scans rotating chunk of full market
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          universe: 'all',
          chunkSize: 30,
          resetCursor: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      const n = data.symbolsScanned ?? data.symbols_scanned ?? '?';
      const created = data.signalsCreated ?? data.signals_created ?? 0;
      flash(`Scan done — ${n} symbols, +${created} new signals`);
    } catch (e) {
      flash(e.message);
    } finally {
      setSysBusy(false);
    }
  }

  async function loadResetPreview() {
    setResetBusy(true);
    try {
      const q = `?mode=${resetMode}${resetSecret ? `&secret=${encodeURIComponent(resetSecret)}` : ''}`;
      const res = await fetch(`/api/admin/reset-signals${q}`);
      const data = await res.json();
      if (res.ok && data?.ok) setResetPreview(data);
      else setResetPreview({ error: data?.error || 'Preview failed', total: 0, preview: [] });
    } catch (e) {
      setResetPreview({ error: e.message, total: 0, preview: [] });
    } finally {
      setResetBusy(false);
    }
  }

  async function confirmReset() {
    setResetBusy(true);
    try {
      const res = await fetch('/api/admin/reset-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, mode: resetMode, secret: resetSecret }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.hint || 'Reset failed');
      flash(data.msg || `Reset done (${data.deleted ?? data.total ?? '?'})`);
      setResetPreview(null);
      setResetSecret('');
    } catch (e) {
      flash(e.message);
    } finally {
      setResetBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-page">
        <div className="text-secondary">Loading admin…</div>
      </div>
    );
  }

  const field = (label, children) => (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {children}
    </div>
  );

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24, paddingBottom: 48 }}>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Admin Panel</h1>
          <p className="text-secondary" style={{ margin: '4px 0 0', fontSize: 13 }}>
            {user?.email} · {getVersionLabel()}
          </p>
        </div>
        <a href="/" className="btn btn-secondary btn-sm">
          ← App
        </a>
      </div>

      <div className="filter-row" style={{ marginBottom: 16 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`filter-pill ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="card" style={{ marginBottom: 12, background: 'var(--primary-soft)' }}>
          {msg}
          <button className="btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => setMsg(null)}>
            dismiss
          </button>
        </div>
      )}

      {/* ─── USERS ─── */}
      
      {section === 'branding' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 6 }}>Branding</div>
          <p className="card-subtitle" style={{ marginBottom: 16 }}>
            Your logo appears on the Sign in and Sign up pages. Any shape works — it is fitted automatically and never stretched. Best: a transparent PNG or SVG, at least 400 px wide.
          </p>

          <div className="brand-admin-preview">
            <div className="brand-admin-preview-label">Preview (as shown on the login page)</div>
            <div className="brand-mark" style={{ margin: 0 }}>
              {brand.logoUrl
                ? <img className="brand-mark-img" src={brand.logoUrl} alt="Logo preview" />
                : <span className="brand-mark-text">{brand.appName}</span>}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <label className="btn btn-primary" style={{ cursor: brandBusy ? 'wait' : 'pointer' }}>
              {brandBusy ? 'Saving…' : (brand.logoUrl ? 'Replace logo' : 'Upload logo')}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onLogoPicked} disabled={brandBusy} style={{ display: 'none' }} />
            </label>
            {brand.logoUrl && (
              <button className="btn btn-secondary" type="button" disabled={brandBusy} onClick={() => saveBranding({ removeLogo: true }, 'Logo removed')}>
                Remove logo
              </button>
            )}
          </div>

          <div style={{ marginTop: 22 }}>
            {field('Name (shown when there is no logo, and as the image description)', (
              <input className="form-input" value={brandName} maxLength={40} onChange={(e) => setBrandName(e.target.value)} placeholder="Signal Desk" />
            ))}
            <button className="btn btn-secondary" type="button" disabled={brandBusy || brandName.trim() === brand.appName} onClick={() => saveBranding({ appName: brandName }, 'Name saved')}>
              Save name
            </button>
          </div>
        </div>
      )}

      {section === 'news' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 12 }}>Dashboard news</div>
          <p className="card-subtitle" style={{ marginBottom: 12 }}>
            Posts appear as a rotating banner on the user Home tab. Banner size: 1344 × 352 px (ratio 3.8 : 1, shown at 672 × 176). With an image the banner shows the image only — put your text inside the image; tapping opens Title/Body if you add them. Without an image a blue text banner is shown.
          </p>
          {field('Title', (
            <input className="form-input" value={newsTitle} onChange={(e) => setNewsTitle(e.target.value)} placeholder="Headline" />
          ))}
          {field('Body', (
            <textarea className="form-input" rows={4} value={newsBody} onChange={(e) => setNewsBody(e.target.value)} placeholder="Message (optional if image only)" />
          ))}
          {field('Banner image URL — 1344×352 px (optional)', (
            <input className="form-input" value={newsImage} onChange={(e) => setNewsImage(e.target.value)} placeholder="https://…" />
          ))}
          <button className="btn btn-primary" disabled={newsBusy} onClick={postNews} style={{ marginTop: 8 }}>
            {newsBusy ? '…' : 'Publish news'}
          </button>
          <div style={{ marginTop: 20 }}>
            <div className="card-title" style={{ marginBottom: 10 }}>Published ({newsList.length})</div>
            {newsList.length === 0 && <p className="text-secondary" style={{ fontSize: 13 }}>No posts yet.</p>}
            {newsList.map((n) => (
              <div key={n.id} className="card" style={{ marginBottom: 10, padding: 12 }}>
                {n.imageUrl && (
                  <img src={n.imageUrl} alt="" style={{ width: '100%', maxHeight: 120, objectFit: 'cover', borderRadius: 8, marginBottom: 8 }} />
                )}
                <div style={{ fontWeight: 700 }}>{n.title}</div>
                {n.body && <div className="text-secondary" style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.body}</div>}
                <div className="flex-between" style={{ marginTop: 8 }}>
                  <span className="text-secondary" style={{ fontSize: 11 }}>{n.createdAt ? String(n.createdAt).slice(0, 16) : ''}</span>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => removeNews(n.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

{section === 'users' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 14 }}>
            <div className="card-title">Users</div>
            <div className="flex gap-8">
              <input
                className="form-input"
                style={{ width: 220, padding: '8px 12px' }}
                placeholder="Search email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadUsers()}
              />
              <button className="btn btn-primary btn-sm" onClick={() => loadUsers()}>
                Search
              </button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Trial</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.email}
                      {u.role === 'admin' && (
                        <span className="chip chip-muted" style={{ marginLeft: 6 }}>
                          admin
                        </span>
                      )}
                      {u.is_suspended && (
                        <span className="chip chip-ready" style={{ marginLeft: 6 }}>
                          suspended
                        </span>
                      )}
                    </td>
                    <td style={{ textTransform: 'capitalize' }}>{u.plan}</td>
                    <td>{u.subscription_status}</td>
                    <td style={{ fontSize: 12 }}>
                      {u.trial_ends_at ? new Date(u.trial_ends_at).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => extendTrial(u.id, 7)}>
                          +7d
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => assignPlan(u.id, 'auto')}>
                          Auto
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => assignPlan(u.id, 'pro')}>
                          Pro
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{
                            background: u.is_suspended ? 'var(--success)' : 'var(--danger)',
                            color: '#fff',
                          }}
                          onClick={() => toggleSuspend(u.id, !u.is_suspended)}
                        >
                          {u.is_suspended ? 'Unsuspend' : 'Suspend'}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => clearTradeHistory(u)}
                        >
                          Clear history
                        </button>
                        <button
                          className="btn btn-sm"
                          style={{ background: '#1d4ed8', color: '#fff' }}
                          onClick={() => loginAsUser(u)}
                          title="Log in as this user (no password)"
                        >
                          Login as
                        </button>
                        {u.role !== 'admin' && (
                          <button
                            className="btn btn-sm"
                            style={{ background: '#7f1d1d', color: '#fff' }}
                            onClick={() => deleteAccount(u)}
                          >
                            Delete account
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!users.length && (
                  <tr>
                    <td colSpan={5} className="text-muted" style={{ textAlign: 'center' }}>
                      No users
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── TELEGRAM ─── */}
      {section === 'telegram' && (
        <>
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <div className="card-title">Telegram bot</div>
              <span className={`chip ${tg.configured ? 'chip-ongoing' : 'chip-muted'}`}>
                {tg.configured ? 'Configured' : 'Missing'}
              </span>
            </div>
            {field(
              'Bot token',
              <input
                className="form-input"
                type="password"
                placeholder={tg.token_preview ? `Saved: ${tg.token_preview}` : 'from BotFather'}
                value={tg.bot_token}
                onChange={(e) => setTg((t) => ({ ...t, bot_token: e.target.value }))}
              />
            )}
            {field(
              'Live board chat ID',
              <input
                className="form-input"
                value={tg.chat_id}
                onChange={(e) => setTg((t) => ({ ...t, chat_id: e.target.value }))}
                placeholder="-100…"
              />
            )}
            {field(
              'Bot username (no @)',
              <input
                className="form-input"
                value={tg.bot_username}
                onChange={(e) => setTg((t) => ({ ...t, bot_username: e.target.value }))}
                placeholder="MySignalBot"
              />
            )}
            <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={tgBusy} onClick={() => saveTelegram(false)}>
                Save
              </button>
              <button className="btn btn-secondary" disabled={tgBusy} onClick={() => saveTelegram(true)}>
                Save + test
              </button>
              <button className="btn btn-secondary" disabled={tgBusy} onClick={refreshBoard}>
                Refresh live board
              </button>
            </div>
            <p className="text-secondary" style={{ fontSize: 12, marginTop: 10 }}>
              User Connect Telegram needs: valid token + bot username + webhook pointing at this site.
              Save auto-sets the webhook. Chat ID is the admin board only (not required for user DMs).
            </p>
          </div>
          <div className="card">
            <div className="flex-between" style={{ marginBottom: 8 }}>
              <div className="card-title">Webhook (user connect)</div>
              <span className={`chip ${tg.webhook_ok ? 'chip-ongoing' : 'chip-muted'}`}>
                {tg.webhook_ok ? 'OK' : 'Not set / mismatch'}
              </span>
            </div>
            <p className="text-secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              Current: <code style={{ wordBreak: 'break-all' }}>{tg.webhook_url || '—'}</code>
              <br />
              Expected: <code style={{ wordBreak: 'break-all' }}>{tg.expected_webhook_url || '—'}</code>
              {tg.webhook_error ? (
                <>
                  <br />
                  Last error: {tg.webhook_error}
                </>
              ) : null}
            </p>
            <button className="btn btn-primary btn-sm" disabled={tgBusy} onClick={setWebhookNow}>
              {tgBusy ? 'Working…' : 'Set webhook now'}
            </button>
          </div>
        </>
      )}

      {/* ─── SCANNER ─── */}
      {section === 'scanner' && (
        <>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Exchange
            </div>
            <div className="flex gap-8">
              <button
                className={`filter-pill ${activeExchange === 'binance' ? 'active' : ''}`}
                disabled={scanBusy}
                onClick={() => switchExchange('binance')}
              >
                Binance
              </button>
              <button
                className={`filter-pill ${activeExchange === 'bybit' ? 'active' : ''}`}
                disabled={scanBusy}
                onClick={() => switchExchange('bybit')}
              >
                Bybit
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Strategy selection
            </div>
            {strategyMode !== 'zone_pattern' && strategyMode !== 'double_confluence' && strategyMode !== 'ema_bump' && strategyMode !== 'pivot_ema' ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12 }}>
                  {field('Min score', <input className="form-input" type="number" value={minScore} onChange={(e) => setMinScore(+e.target.value)} />)}
                  {field('Entry ATR min', <input className="form-input" type="number" step={0.25} value={minEntryAtr} onChange={(e) => setMinEntryAtr(+e.target.value)} />)}
                  {field('Entry ATR max', <input className="form-input" type="number" step={0.5} value={maxEntryAtr} onChange={(e) => setMaxEntryAtr(+e.target.value)} />)}
                  {field('TG max ATR', <input className="form-input" type="number" step={0.5} value={telegramMaxAtr} onChange={(e) => setTelegramMaxAtr(+e.target.value)} />)}
                  {field('Max gap %', <input className="form-input" type="number" step={0.1} value={maxGapPercent} onChange={(e) => setMaxGapPercent(+e.target.value)} />)}
                </div>
                <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={requireHtf} onChange={(e) => setRequireHtf(e.target.checked)} /> HTF aligned
                  </label>
                  <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={requireLiq} onChange={(e) => setRequireLiq(e.target.checked)} /> Liquidity edge
                  </label>
                  <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={requireSweepFvg} onChange={(e) => setRequireSweepFvg(e.target.checked)} /> Sweep/FVG
                  </label>
                </div>
              </>
            ) : (
              <p className="form-hint">
                This strategy uses only its own Zone + Pattern settings below. Legacy score, HTF, liquidity, entry-distance, gap, and ICT/chart-pattern filters are not applied.
              </p>
            )}
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">Strategy mode</label>
              <select className="form-input" value={strategyMode} onChange={(e) => setStrategyMode(e.target.value)}>
                <option value="zone_pattern">Independent Zone + Pattern Confluence</option>
                <option value="chart_pattern">Chart Pattern</option>
                <option value="smc">ICT SMC (sweep → BOS → POI)</option>
                <option value="hybrid">ICT + Chart Pattern (Balanced)</option>
                <option value="ict_confluence">Strict ICT + Chart Pattern confirmation</option>
                <option value="double_confluence">Double Top / Bottom Confluence</option>
                <option value="ema_bump">EMA Bump (EMA 20 / EMA 50 + backtest)</option>
                <option value="pivot_ema">Pivot + EMA Cross (backtest)</option>
              </select>
              <div className="form-hint" style={{ marginTop: 6 }}>
                Zone + Pattern is an independent mode; its recommended preset uses two or more confluence sources, a pattern reaction, and a closed local structure break. Other modes retain their existing settings. Changes affect new signals only; signals are not guarantees of profit.
              </div>
            </div>
          </div>

          {strategyMode === 'zone_pattern' && (
            <div className="card">
              <div className="card-title" style={{ marginBottom: 8 }}>Zone + Pattern settings</div>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                A zone needs at least two different source types. A signal then needs two reactions at that zone and a closed-candle break of the pattern neckline. Fibonacci adds confluence points but is not a mandatory gate.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12 }}>
                {field('Setup timeframe', (
                  <select className="form-input" value={zonePatternConfig.setupTf} onChange={(e) => setZonePatternConfig((c) => ({ ...c, setupTf: e.target.value }))}>
                    <option value="5m">5 minutes</option>
                    <option value="15m">15 minutes</option>
                    <option value="30m">30 minutes</option>
                    <option value="1h">1 hour</option>
                  </select>
                ))}
                {field('Context timeframe', (
                  <select className="form-input" value={zonePatternConfig.contextTf} onChange={(e) => setZonePatternConfig((c) => ({ ...c, contextTf: e.target.value }))}>
                    <option value="1h">1 hour</option>
                    <option value="2h">2 hours</option>
                    <option value="4h">4 hours</option>
                    <option value="1d">1 day</option>
                  </select>
                ))}
                {field('Min zone sources', <input className="form-input" type="number" min={2} max={5} value={zonePatternConfig.minZoneSources} onChange={(e) => setZonePatternConfig((c) => ({ ...c, minZoneSources: +e.target.value }))} />)}
                {field('Zone width (ATR)', <input className="form-input" type="number" min={0.1} max={1.5} step={0.05} value={zonePatternConfig.zoneToleranceATR} onChange={(e) => setZonePatternConfig((c) => ({ ...c, zoneToleranceATR: +e.target.value }))} />)}
                {field('Max breakout chase (ATR)', <input className="form-input" type="number" min={0.1} max={3} step={0.1} value={zonePatternConfig.maxChaseATR} onChange={(e) => setZonePatternConfig((c) => ({ ...c, maxChaseATR: +e.target.value }))} />)}
                {field('Min signal score', <input className="form-input" type="number" min={40} max={95} value={zonePatternConfig.minSignalScore} onChange={(e) => setZonePatternConfig((c) => ({ ...c, minSignalScore: +e.target.value }))} />)}
                {field('Min TP1 R:R', <input className="form-input" type="number" min={0.8} max={5} step={0.1} value={zonePatternConfig.minRR} onChange={(e) => setZonePatternConfig((c) => ({ ...c, minRR: +e.target.value }))} />)}
              </div>
              <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 12 }}>
                {[
                  ['includeWeeklyLevels', 'Weekly highs/lows'],
                  ['includeDailyLevels', 'Daily highs/lows'],
                  ['includeSwingLevels', 'Swing levels'],
                  ['includeFibLevels', 'Fibonacci'],
                  ['includeOrderBlocks', 'Order blocks'],
                  ['includeFvgs', 'FVGs'],
                ].map(([key, label]) => (
                  <label key={key} className="chip chip-muted" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={!!zonePatternConfig[key]}
                      onChange={(e) => setZonePatternConfig((c) => ({ ...c, [key]: e.target.checked }))}
                    /> {label}
                  </label>
                ))}
              </div>
            </div>
          )}


          
          {strategyMode === 'ema_bump' && (
            <div className="card">
              <div className="card-title" style={{ marginBottom: 8 }}>EMA Bump (EMA 20 red / EMA 50 orange)</div>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                Price comes from below, breaks up through the red EMA 20 then the orange EMA 50 and forms a TOP. The top&apos;s high is the entry.
                When price pulls back and touches the EMA 50 (never closing beyond the EMA 20) the signal is READY. Breaking the top&apos;s high = ONGOING.
                SHORT is the mirror. Every selected time frame is scanned on its own.
              </p>

              <div className="card-title" style={{ margin: '8px 0', fontSize: 14 }}>Time frames to scan</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
                {EMA_BUMP_TFS.map((tf) => {
                  const list = Array.isArray(emaBumpConfig.timeframes) ? emaBumpConfig.timeframes : ['15m'];
                  const on = list.includes(tf);
                  return (
                    <label key={tf} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          setEmaBumpConfig((c) => {
                            const cur = Array.isArray(c.timeframes) ? [...c.timeframes] : ['15m'];
                            const next = on ? cur.filter((x) => x !== tf) : [...cur, tf];
                            return { ...c, timeframes: next.length ? next : ['15m'] };
                          });
                        }}
                      />
                      {tf}
                    </label>
                  );
                })}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 12 }}>
                {field('Fast EMA (red)', <input className="form-input" type="number" min={5} max={60} value={emaBumpConfig.fastPeriod ?? 20} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, fastPeriod: +e.target.value }))} />)}
                {field('Slow EMA (orange)', <input className="form-input" type="number" min={10} max={200} value={emaBumpConfig.slowPeriod ?? 50} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, slowPeriod: +e.target.value }))} />)}
                {field('Min score (0–100)', <input className="form-input" type="number" min={30} max={100} value={emaBumpConfig.minScore ?? 70} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, minScore: +e.target.value }))} />)}
                {field('Min dip depth (ATR)', <input className="form-input" type="number" min={0} max={10} step={0.25} value={emaBumpConfig.minDepthATR ?? 1.5} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, minDepthATR: +e.target.value }))} />)}
                {field('Min prior-trend bars', <input className="form-input" type="number" min={2} max={40} value={emaBumpConfig.minTrendBars ?? 8} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, minTrendBars: +e.target.value }))} />)}
                {field('Min bump above EMA50 (ATR)', <input className="form-input" type="number" min={0} max={5} step={0.1} value={emaBumpConfig.minBumpATR ?? 0.3} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, minBumpATR: +e.target.value }))} />)}
                {field('Max bump above EMA50 (ATR)', <input className="form-input" type="number" min={0.5} max={15} step={0.5} value={emaBumpConfig.maxBumpATR ?? 4} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, maxBumpATR: +e.target.value }))} />)}
                {field('Min pullback bars', <input className="form-input" type="number" min={1} max={20} value={emaBumpConfig.minPullBars ?? 2} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, minPullBars: +e.target.value }))} />)}
                {field('Max top age (bars)', <input className="form-input" type="number" min={5} max={150} value={emaBumpConfig.maxTopAgeBars ?? 40} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, maxTopAgeBars: +e.target.value }))} />)}
                {field('Max EMA50-touch age (bars)', <input className="form-input" type="number" min={1} max={60} value={emaBumpConfig.maxTouchAgeBars ?? 15} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, maxTouchAgeBars: +e.target.value }))} />)}
                {field('Touch tolerance (ATR)', <input className="form-input" type="number" min={0} max={1} step={0.05} value={emaBumpConfig.touchTolATR ?? 0.1} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, touchTolATR: +e.target.value }))} />)}
                {field('Max EMA gap (ATR)', <input className="form-input" type="number" min={0.1} max={8} step={0.1} value={emaBumpConfig.maxGapATR ?? 2} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, maxGapATR: +e.target.value }))} />)}
                {field('SL buffer (ATR)', <input className="form-input" type="number" min={0} max={2} step={0.05} value={emaBumpConfig.slBufferATR ?? 0.2} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, slBufferATR: +e.target.value }))} />)}
                {field('Max stop (ATR)', <input className="form-input" type="number" min={0.5} max={15} step={0.5} value={emaBumpConfig.maxStopATR ?? 5} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, maxStopATR: +e.target.value }))} />)}
                {field('Max entry distance (ATR)', <input className="form-input" type="number" min={0.2} max={10} step={0.1} value={emaBumpConfig.maxEntryDistanceATR ?? 3} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, maxEntryDistanceATR: +e.target.value }))} />)}
                {field('TP1 R', <input className="form-input" type="number" min={0.5} max={10} step={0.1} value={emaBumpConfig.tp1R ?? 1.2} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, tp1R: +e.target.value }))} />)}
                {field('TP2 R', <input className="form-input" type="number" min={1} max={15} step={0.1} value={emaBumpConfig.tp2R ?? 2} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, tp2R: +e.target.value }))} />)}
                {field('TP3 R', <input className="form-input" type="number" min={1.5} max={25} step={0.1} value={emaBumpConfig.tp3R ?? 3} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, tp3R: +e.target.value }))} />)}
              </div>

              <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 10 }}>
                {[
                  ['allowLong', 'LONG signals', true],
                  ['allowShort', 'SHORT signals', true],
                  ['allowRecentCross', 'Allow EMAs already crossed (recent)', true],
                  ['allowCloseBelowFast', 'Allow pullback closes beyond EMA 20 (not recommended)', false],
                  ['requirePriorSlowCross', 'Require prior EMA50 cross near touch level (re-test)', false],
                  ['useHarmonicEntry', 'Harmonic entry at C zone (X=HH A=LL B=TOP)', false],
                  ['requireHarmonic', 'Require valid harmonic XAB (reject if none)', false],
                ].map(([key, label, def]) => (
                  <label key={key} className="chip chip-muted" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={emaBumpConfig[key] != null ? !!emaBumpConfig[key] : def}
                      onChange={(e) => setEmaBumpConfig((c) => ({ ...c, [key]: e.target.checked }))}
                    />{' '}
                    {label}
                  </label>
                ))}
              </div>
              {emaBumpConfig.requirePriorSlowCross && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 10, marginTop: 8 }}>
                  {field('Prior EMA50 cross max bars', <input className="form-input" type="number" min={5} max={80} value={emaBumpConfig.priorSlowCrossMaxBars ?? 25} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, priorSlowCrossMaxBars: +e.target.value }))} />)}
                  {field('Prior cross level tol (ATR)', <input className="form-input" type="number" min={0.05} max={2} step={0.05} value={emaBumpConfig.priorSlowCrossMaxLevelATR ?? 0.4} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, priorSlowCrossMaxLevelATR: +e.target.value }))} />)}
                </div>
              )}
              {emaBumpConfig.useHarmonicEntry && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 10, marginTop: 8 }}>
                  {field('C zone BC min (of AB)', <input className="form-input" type="number" min={0.1} max={0.95} step={0.01} value={emaBumpConfig.harmonicBcMin ?? 0.382} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, harmonicBcMin: +e.target.value }))} />)}
                  {field('C zone BC max (of AB)', <input className="form-input" type="number" min={0.2} max={1} step={0.01} value={emaBumpConfig.harmonicBcMax ?? 0.886} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, harmonicBcMax: +e.target.value }))} />)}
                  {field('HH (X) lookback bars', <input className="form-input" type="number" min={10} max={120} value={emaBumpConfig.harmonicXLookback ?? 60} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, harmonicXLookback: +e.target.value }))} />)}
                </div>
              )}

              <div className="card-title" style={{ margin: '16px 0 4px', fontSize: 14 }}>Gates</div>
              <p className="form-hint" style={{ marginBottom: 8 }}>
                HARD = setup is rejected when it fails · SOFT = only costs score points · OFF = ignored. Fewer signals = more HARD gates and a higher Min score.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 10 }}>
                {EMA_BUMP_GATES.map((g) => {
                  const cur = (emaBumpConfig.gateModes || {})[g.key] || g.def;
                  return (
                    <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{g.label}</span>
                        <select
                          className="form-input"
                          style={{ width: 90 }}
                          value={cur}
                          onChange={(e) =>
                            setEmaBumpConfig((c) => ({ ...c, gateModes: { ...(c.gateModes || {}), [g.key]: e.target.value } }))
                          }
                        >
                          <option value="hard">HARD</option>
                          <option value="soft">SOFT</option>
                          <option value="off">OFF</option>
                        </select>
                      </div>
                      <span className="form-hint" style={{ fontSize: 12 }}>{g.hint}</span>
                    </div>
                  );
                })}
              </div>

              <div className="card-title" style={{ margin: '16px 0 8px', fontSize: 14 }}>Gate thresholds</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 12 }}>
                {field('RVOL min (volume gate)', <input className="form-input" type="number" min={0} max={10} step={0.1} value={emaBumpConfig.volumeMinRvol ?? 1.2} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, volumeMinRvol: +e.target.value }))} />)}
                {field('RSI max (rsi gate)', <input className="form-input" type="number" min={50} max={100} value={emaBumpConfig.rsiMax ?? 70} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, rsiMax: +e.target.value }))} />)}
                {field('RSI min (rsi gate)', <input className="form-input" type="number" min={0} max={50} value={emaBumpConfig.rsiMin ?? 30} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, rsiMin: +e.target.value }))} />)}
                {field('Max range position (location gate)', <input className="form-input" type="number" min={0.1} max={1} step={0.05} value={emaBumpConfig.locationMaxPos ?? 0.6} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, locationMaxPos: +e.target.value }))} />)}
                {field('Chop window (bars)', <input className="form-input" type="number" min={10} max={100} value={emaBumpConfig.chopWindow ?? 30} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, chopWindow: +e.target.value }))} />)}
                {field('Max EMA crosses (chop gate)', <input className="form-input" type="number" min={0} max={20} value={emaBumpConfig.chopMaxCrosses ?? 2} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, chopMaxCrosses: +e.target.value }))} />)}
                {field('Max pullback volume ratio', <input className="form-input" type="number" min={0.1} max={5} step={0.1} value={emaBumpConfig.pullbackVolMax ?? 1} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, pullbackVolMax: +e.target.value }))} />)}
                {field('Max FVG distance, ATR (FVG gate)', <input className="form-input" type="number" min={0.5} max={20} step={0.5} value={emaBumpConfig.fvgBlockMaxATR ?? 6} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, fvgBlockMaxATR: +e.target.value }))} />)}
                {field('Min stop % (risk gate)', <input className="form-input" type="number" min={0} max={10} step={0.05} value={emaBumpConfig.riskMinPercent ?? 0.25} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, riskMinPercent: +e.target.value }))} />)}
                {field('Max stop % (risk gate)', <input className="form-input" type="number" min={0.5} max={50} step={0.5} value={emaBumpConfig.riskMaxPercent ?? 8} onChange={(e) => setEmaBumpConfig((c) => ({ ...c, riskMaxPercent: +e.target.value }))} />)}
              </div>

              <div style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setEmaBumpConfig((c) => ({ ...EMA_BUMP_DEFAULTS, timeframes: Array.isArray(c.timeframes) ? c.timeframes : ['15m'] }))
                  }
                >
                  Reset to recommended (strict)
                </button>
              </div>

              {/* ---- EMA Bump historical backtest (same pattern as Pivot+EMA) ---- */}
              {(() => {
                const run = emaBtRun;
                const evs = run?.events || [];
                const fmtT = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');
                const filtered =
                  emaBtFilter === 'ALL' ? evs
                    : emaBtFilter === 'PRIOR' ? evs.filter((e) => e.hasPriorSlowCross)
                    : emaBtFilter === 'HARMONIC' ? evs.filter((e) => e.hasHarmonic || e.harmonicPattern)
                    : evs.filter((e) => e.outcome === emaBtFilter);
                const tall = tallyEmaBump(filtered);
                const tallAll = tallyEmaBump(evs);
                const tallPrior = tallyEmaBump(evs.filter((e) => e.hasPriorSlowCross));
                const wr = (t) => (t.winRate == null ? '—' : `${t.winRate}%`);
                const rowOf = (label, t) => (
                  <tr key={label}>
                    <td style={{ padding: '4px 8px' }}>{label}</td>
                    <td style={{ padding: '4px 8px' }}>{t.total}</td>
                    <td style={{ padding: '4px 8px', color: '#0ecb81' }}>{t.win}</td>
                    <td style={{ padding: '4px 8px', color: '#f6465d' }}>{t.loss}</td>
                    <td style={{ padding: '4px 8px' }}>{t.timeout || 0}</td>
                    <td style={{ padding: '4px 8px' }}>{t.noEntry || 0}</td>
                    <td style={{ padding: '4px 8px', fontWeight: 600 }}>{wr(t)}</td>
                  </tr>
                );
                return (
                  <div style={{ marginTop: 24, borderTop: '1px solid var(--border, #333)', paddingTop: 16 }}>
                    <div className="card-title" style={{ marginBottom: 8 }}>EMA Bump — scan &amp; backtest</div>
                    <p className="form-hint" style={{ marginBottom: 10 }}>
                      Walks last ~1000 candles per coin/TF using the same READY rules as live (dip → break-up → top → EMA50 pullback touch).
                      Then waits for a break of the top (entry fill) and resolves <b>TP1 vs SL</b>.
                      Uses the config above (TFs, prior-EMA50-cross option, depth, etc.). Live signals are <b>not</b> created — history only.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 10, marginBottom: 10 }}>
                      {field('Universe (top N by volume)', <input className="form-input" type="number" min={5} max={300} value={emaBtUniverse} onChange={(e) => setEmaBtUniverse(+e.target.value)} />)}
                      {field('Single-coin check', <input className="form-input" placeholder="BTCUSDT" value={emaBtCheckSymbol} onChange={(e) => setEmaBtCheckSymbol(e.target.value)} />)}
                    </div>
                    <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                      <button type="button" className="btn btn-primary" disabled={run?.running} onClick={runEmaBumpBacktest}>
                        {run?.running ? 'Scanning…' : 'Scan + Backtest'}
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={run?.running} onClick={checkEmaBumpCoin}>
                        Check coin
                      </button>
                      {run?.running && (
                        <button type="button" className="btn btn-secondary" onClick={() => { emaBtStop.current = true; }}>
                          Stop
                        </button>
                      )}
                    </div>
                    {run && (
                      <div>
                        <p className="form-hint" style={{ marginBottom: 8 }}>
                          {run.running ? `Running… ${run.offset || 0}/${run.total || '?'} coins` : run.done ? `Done · ${run.total} coins` : 'Stopped'}
                          {' · '}{evs.length} setups · TFs: {(run.tfs || []).join(', ')}
                          {run.checkSymbol ? ` · only ${run.checkSymbol}` : ''}
                        </p>
                        {!!run.errors?.length && (
                          <div style={{ color: '#f6465d', fontSize: 12, marginBottom: 8, maxHeight: 80, overflow: 'auto' }}>
                            {run.errors.slice(0, 8).map((e, i) => <div key={i}>{e}</div>)}
                          </div>
                        )}
                        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 12 }}>
                          <thead>
                            <tr style={{ textAlign: 'left', borderBottom: '1px solid #333' }}>
                              <th style={{ padding: '4px 8px' }}>Slice</th>
                              <th style={{ padding: '4px 8px' }}>N</th>
                              <th style={{ padding: '4px 8px' }}>Win</th>
                              <th style={{ padding: '4px 8px' }}>Loss</th>
                              <th style={{ padding: '4px 8px' }}>Timeout</th>
                              <th style={{ padding: '4px 8px' }}>No entry</th>
                              <th style={{ padding: '4px 8px' }}>WR</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rowOf('All READY setups', tallAll)}
                            {rowOf('With prior EMA50 cross (re-test)', tallPrior)}
                            {emaBtFilter !== 'ALL' && emaBtFilter !== 'PRIOR' && rowOf(`Filter: ${emaBtFilter}`, tall)}
                          </tbody>
                        </table>
                        <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                          {['ALL', 'WIN', 'LOSS', 'TIMEOUT', 'NO_ENTRY', 'OPEN', 'PRIOR', 'HARMONIC'].map((f) => (
                            <button
                              key={f}
                              type="button"
                              className={`chip ${emaBtFilter === f ? '' : 'chip-muted'}`}
                              style={{ cursor: 'pointer' }}
                              onClick={() => setEmaBtFilter(f)}
                            >
                              {f === 'PRIOR' ? 'Prior EMA50 cross' : f === 'HARMONIC' ? 'Harmonic XAB' : f}
                            </button>
                          ))}
                        </div>
                        <div style={{ maxHeight: 360, overflow: 'auto' }}>
                          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ textAlign: 'left', borderBottom: '1px solid #333', position: 'sticky', top: 0, background: 'var(--card, #111)' }}>
                                {['Coin', 'TF', 'Ready (UTC)', 'Side', 'Entry', 'SL', 'TP1', 'Harm', 'Prior X', 'Result', 'MFE', 'MAE', 'Bars'].map((h) => (
                                  <th key={h} style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {filtered.slice(0, 200).map((e, i) => (
                                <tr key={`${e.symbol}-${e.tf}-${e.time}-${i}`} style={{ borderBottom: '1px solid #222' }}>
                                  <td style={{ padding: '3px 6px' }}>{e.symbol}</td>
                                  <td style={{ padding: '3px 6px' }}>{String(e.tf || '').toUpperCase()}</td>
                                  <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{fmtT(e.time)}</td>
                                  <td style={{ padding: '3px 6px', color: e.dir === 'LONG' ? '#0ecb81' : '#f6465d' }}>{e.dir}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.entry}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.sl}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.tp1}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.harmonicPattern || (e.hasHarmonic ? '✓' : '—')}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.hasPriorSlowCross ? '✓' : '—'}</td>
                                  <td style={{
                                    padding: '3px 6px',
                                    fontWeight: 600,
                                    color: e.outcome === 'WIN' ? '#0ecb81' : e.outcome === 'LOSS' ? '#f6465d' : undefined,
                                  }}>{e.outcome}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.mfeATR}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.maeATR}</td>
                                  <td style={{ padding: '3px 6px' }}>{e.bars}</td>
                                </tr>
                              ))}
                              {!filtered.length && (
                                <tr><td colSpan={12} style={{ padding: 12, opacity: 0.6 }}>No events yet — run Scan + Backtest.</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {strategyMode === 'pivot_ema' && (() => {
            const run = pivotRun;
            const evs = run?.events || [];
            const fmtT = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
            const wr = (t) => (t.winRate == null ? '—' : `${t.winRate}%`);
            const rowOf = (label, t) => (
              <tr key={label}>
                <td style={{ padding: '4px 8px' }}>{label}</td>
                <td style={{ padding: '4px 8px' }}>{t.total}</td>
                <td style={{ padding: '4px 8px', color: '#0ecb81' }}>{t.win}</td>
                <td style={{ padding: '4px 8px', color: '#f6465d' }}>{t.loss}</td>
                <td style={{ padding: '4px 8px' }}>{(t.timeout || 0) + (t.open || 0)}</td>
                <td style={{ padding: '4px 8px', fontWeight: 700 }}>{wr(t)}</td>
              </tr>
            );
            const tfsSeen = run?.tfs || [];
            const baseAll = Object.values(run?.baseline || {}).reduce(
              (a, b) => ({ total: a.total + b.total, win: a.win + b.win, loss: a.loss + b.loss, timeout: a.timeout + b.timeout, open: a.open + b.open }),
              { total: 0, win: 0, loss: 0, timeout: 0, open: 0 }
            );
            baseAll.winRate = baseAll.win + baseAll.loss ? +((baseAll.win / (baseAll.win + baseAll.loss)) * 100).toFixed(1) : null;
            const shown = evs
              .filter((e) => pivotFilter === 'ALL' || (pivotFilter === 'OTHER' ? e.outcome !== 'WIN' && e.outcome !== 'LOSS' : e.outcome === pivotFilter))
              .sort((a, b) => b.time - a.time)
              .slice(0, 300);
            return (
              <div className="card">
                <div className="card-title" style={{ marginBottom: 8 }}>Pivot + EMA 20/50 cross — scan &amp; backtest</div>
                <p className="form-hint" style={{ marginBottom: 12 }}>
                  <b>Trendline-break entry</b> near pivot: EMA 20/50 crosses near P → left side must show a clean leg (rising lows or falling highs) with a drawable trendline → <b>entry when that trendline breaks</b> while price is still near the pivot.
                  <br />
                  Uptrend support break → <b>SHORT</b> · Downtrend resistance break → <b>LONG</b>. Rejects if EMAs re-cross before the break.
                  <br />
                  Chart marks Pivot, Trendline, EMA cross, Entry, SL, TP. Live signals are NOT created — history only.
                </p>

                <div className="card-title" style={{ margin: '8px 0', fontSize: 14 }}>Time frames</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
                  {PIVOT_EMA_TFS.map((tf) => (
                    <label key={tf} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={pivotTfs.includes(tf)}
                        onChange={() =>
                          setPivotTfs((cur) => {
                            const next = cur.includes(tf) ? cur.filter((x) => x !== tf) : [...cur, tf];
                            return next.length ? next : cur;
                          })
                        }
                      />
                      {tf}
                    </label>
                  ))}
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
                  {field('Coins (top by volume)', (
                    <select className="form-input" value={pivotUniverse} onChange={(e) => setPivotUniverse(+e.target.value)}>
                      {[30, 50, 100, 150, 200, 300].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ))}
                  {field('EMA cross ↔ Pivot max distance (ATR)', (
                    <input className="form-input" type="number" min={0.05} max={10} step={0.05}
                      value={pivotCrossDist}
                      onChange={(e) => setPivotCrossDist(Math.max(0.05, +e.target.value || 0.05))} />
                  ))}
                  {field('SL mode', (
                    <select className="form-input" value={pivotSlMode} onChange={(e) => setPivotSlMode(e.target.value)}>
                      <option value="swing">Beyond trend leg (recommended)</option>
                      <option value="cross">From EMA cross</option>
                      <option value="pivot">From Pivot (classic)</option>
                    </select>
                  ))}
                  {pivotSlMode === 'cross' && field('SL buffer beyond cross (ATR)', (
                    <input className="form-input" type="number" min={0.2} max={2} step={0.1}
                      value={pivotSlFromCross}
                      onChange={(e) => setPivotSlFromCross(+e.target.value)} />
                  ))}
                  {pivotSlMode === 'pivot' && field('Stop past Pivot (ATR)', (
                    <input className="form-input" type="number" min={0.3} max={3} step={0.1}
                      value={pivotStopATR}
                      onChange={(e) => setPivotStopATR(+e.target.value)} />
                  ))}
                  {field('Target / TP (ATR from Pivot)', (
                    <input className="form-input" type="number" min={0.3} max={3} step={0.1}
                      value={pivotTargetATR}
                      onChange={(e) => setPivotTargetATR(+e.target.value)} />
                  ))}
                  {field('Min leg height (ATR)', (
                    <input className="form-input" type="number" min={0} max={3} step={0.1}
                      value={pivotMinRun}
                      onChange={(e) => setPivotMinRun(+e.target.value)} />
                  ))}
                  {field('Min bars: cross → touch', (
                    <input className="form-input" type="number" min={0} max={20} step={1}
                      value={pivotMinCrossAgo}
                      onChange={(e) => setPivotMinCrossAgo(+e.target.value)} />
                  ))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', paddingBottom: 6 }}>
                    <input type="checkbox" checked={pivotNoRecross} onChange={(e) => setPivotNoRecross(e.target.checked)} />
                    Reject if EMA re-crosses before touch
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', paddingBottom: 6 }}>
                    <input type="checkbox" checked={pivotBothSideCross} onChange={(e) => setPivotBothSideCross(e.target.checked)} />
                    Both sides of leg: 1st EMA cross near same pivot
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', paddingBottom: 6 }}>
                    <input type="checkbox" checked={pivotRejectChop} onChange={(e) => setPivotRejectChop(e.target.checked)} />
                    Skip choppy EMA (too many flips)
                  </label>
                  {pivotRejectChop && field('Max EMA crosses in leg window', (
                    <input className="form-input" type="number" min={1} max={15} step={1}
                      value={pivotMaxCrosses}
                      onChange={(e) => setPivotMaxCrosses(+e.target.value)} />
                  ))}
                  {field('Max bars between 1st & 2nd EMA cross', (
                    <input className="form-input" type="number" min={3} max={80} step={1}
                      value={pivotMaxCrossSpan}
                      onChange={(e) => setPivotMaxCrossSpan(+e.target.value)} />
                  ))}
                  {field('TL break entry timing', (
                    <select className="form-input" value={pivotBreakMode} onChange={(e) => setPivotBreakMode(e.target.value)}>
                      <option value="wick">Wick pierce (earlier, better R:R)</option>
                      <option value="close">Candle close beyond line (safer, later)</option>
                    </select>
                  ))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', paddingBottom: 6 }}>
                    <input type="checkbox" checked={pivotUsePatterns} onChange={(e) => setPivotUsePatterns(e.target.checked)} />
                    Detect wedge / flag in leg (safer earlier entry)
                  </label>
                  {field('Break buffer (ATR)', (
                    <input className="form-input" type="number" min={0} max={0.5} step={0.01}
                      value={pivotBreakBuf}
                      onChange={(e) => setPivotBreakBuf(+e.target.value)} />
                  ))}
                  <button type="button" className="btn btn-primary" disabled={run?.running} onClick={runPivotBacktest}>
                    {run?.running ? 'Scanning…' : 'Scan + Backtest'}
                  </button>
                  {run?.running && (
                    <button type="button" className="btn btn-secondary" onClick={() => { pivotStop.current = true; }}>Stop</button>
                  )}
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 12, padding: '10px 12px', background: '#11151b', borderRadius: 8, border: '1px solid #2b3139' }}>
                  {field('Check one coin', (
                    <input className="form-input" placeholder="e.g. JCTUSDT" value={pivotCheckSymbol}
                      onChange={(e) => setPivotCheckSymbol(e.target.value.toUpperCase())}
                      onKeyDown={(e) => { if (e.key === 'Enter') checkPivotCoin(); }}
                      style={{ minWidth: 140 }} />
                  ))}
                  <button type="button" className="btn btn-secondary" disabled={run?.running} onClick={checkPivotCoin}>
                    {run?.running && run?.checkSymbol ? 'Checking…' : 'Check setup'}
                  </button>
                  <span className="form-hint" style={{ margin: 0 }}>Only scans that symbol on selected TFs (same filters).</span>
                </div>

                <p className="form-hint" style={{ marginBottom: 8 }}>
                  Looks back ~1000 candles per TF. Filter: EMA cross near P → clean left-side leg (min height ATR) → trendline break near P → no EMA re-cross before break.
                </p>

                {run && (
                  <div style={{ marginBottom: 10, fontSize: 13 }}>
                    {run.running ? 'Running' : run.done ? 'Finished' : 'Stopped'} · {Math.min(run.offset, run.total || 0)}/{run.total || '…'} coins · {evs.length} setups found
                    {run.errors?.length ? ` · ${run.errors.length} error(s)` : ''}
                  </div>
                )}

                {run && evs.length + (baseAll.total || 0) > 0 && (
                  <div style={{ overflowX: 'auto', marginBottom: 14 }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 460 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', borderBottom: '1px solid #2b3139' }}>
                          <th style={{ padding: '4px 8px' }}>Group</th>
                          <th style={{ padding: '4px 8px' }}>Setups</th>
                          <th style={{ padding: '4px 8px' }}>Win</th>
                          <th style={{ padding: '4px 8px' }}>Loss</th>
                          <th style={{ padding: '4px 8px' }}>Timeout/Open</th>
                          <th style={{ padding: '4px 8px' }}>Win %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rowOf('Pivot + EMA cross — ALL', pivotTally(evs))}
                        {tfsSeen.map((tf) => rowOf(`   ${tf}`, pivotTally(evs.filter((e) => e.tf === tf))))}
                        {rowOf('   LONG (came from above)', pivotTally(evs.filter((e) => e.dir === 'LONG')))}
                        {rowOf('   SHORT (came from below)', pivotTally(evs.filter((e) => e.dir === 'SHORT')))}
                        {rowOf('Baseline: pivot touch, NO EMA cross', baseAll)}
                      </tbody>
                    </table>
                    <p className="form-hint" style={{ marginTop: 6 }}>
                      If the EMA-cross win % is not clearly above the baseline win %, the EMA cross adds nothing. ~50% means a coin flip.
                    </p>
                  </div>
                )}

                {evs.length > 0 && (
                  <>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>Setups (newest first, max 300)</span>
                      <select className="form-input" style={{ width: 130 }} value={pivotFilter} onChange={(e) => setPivotFilter(e.target.value)}>
                        <option value="ALL">All</option>
                        <option value="WIN">Win</option>
                        <option value="LOSS">Loss</option>
                        <option value="OTHER">Timeout / Open</option>
                      </select>
                    </div>
                    <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 700 }}>
                        <thead>
                          <tr style={{ textAlign: 'left', borderBottom: '1px solid #2b3139', position: 'sticky', top: 0, background: '#11151b' }}>
                            {['Coin', 'TF', 'Touch time (UTC)', 'Side', 'Pivot', 'EMA cross', 'Cross→P', 'Run ATR', 'Result', 'Away / Past', 'Bars', ''].map((h) => (
                              <th key={h} style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((e) => (
                            <tr key={`${e.symbol}-${e.tf}-${e.time}`} style={{ borderBottom: '1px solid #1b212a' }}>
                              <td style={{ padding: '3px 8px', fontWeight: 600 }}>{e.symbol.replace('USDT', '')}</td>
                              <td style={{ padding: '3px 8px' }}>{e.tf}</td>
                              <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{fmtT(e.time)}</td>
                              <td style={{ padding: '3px 8px', color: e.dir === 'LONG' ? '#0ecb81' : '#f6465d' }}>{e.dir}</td>
                              <td style={{ padding: '3px 8px' }}>{+e.pivot.toPrecision(6)}</td>
                              <td style={{ padding: '3px 8px' }}>{e.crossType} · {e.crossBarsAgo === 0 ? 'same bar' : `${e.crossBarsAgo} bar ago`}{e.patternType ? ` · ${e.patternType}` : ''}</td>
                              <td style={{ padding: '3px 8px' }}>{e.crossDistATR}</td>
                              <td style={{ padding: '3px 8px' }}>{e.runATR != null ? e.runATR : '—'}</td>
                              <td style={{ padding: '3px 8px', fontWeight: 700, color: e.outcome === 'WIN' ? '#0ecb81' : e.outcome === 'LOSS' ? '#f6465d' : '#848e9c' }}>{e.outcome}</td>
                              <td style={{ padding: '3px 8px' }}>{e.mfeATR} / {e.maeATR}</td>
                              <td style={{ padding: '3px 8px' }}>{e.bars}</td>
                              <td style={{ padding: '3px 8px' }}>
                                <a href={`/api/backtest/pivot-ema/chart?symbol=${e.symbol}&tf=${e.tf}&time=${e.time}&slMode=${pivotSlMode}&slFromCrossATR=${pivotSlFromCross}&stopATR=${pivotStopATR}&targetATR=${pivotTargetATR}`} target="_blank" rel="noreferrer">chart</a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {run && !run.running && evs.length === 0 && (
                  <p className="form-hint">No setups found in that history — try more coins or a bigger time frame (4h / 1d have more history per pivot).</p>
                )}
                {run?.errors?.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ fontSize: 12, cursor: 'pointer' }}>{run.errors.length} error(s)</summary>
                    <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{run.errors.slice(0, 20).join('\n')}</pre>
                  </details>
                )}
              </div>
            );
          })()}

          {strategyMode === 'double_confluence' && (
            <div className="card">
              <div className="card-title" style={{ marginBottom: 8 }}>Double Top / Bottom Confluence</div>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                Pattern + HTF structure + Liquidity + SMC + Fib + Neckline breakout + Retest. Select one or more timeframe presets — scanner runs all selected combinations.
              </p>

              <div className="card-title" style={{ margin: '8px 0', fontSize: 14 }}>Timeframe presets (select one or more)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
                {[
                  { id: 'p1', label: '4H → 1H' },
                  { id: 'p2', label: '2H → 30M' },
                  { id: 'p3', label: '1H → 15M' },
                  { id: 'p4', label: '30M → 5M' },
                  { id: 'p5', label: '15M → 3M' },
                  { id: 'p6', label: '15M → 5M' },
                  { id: 'p7', label: '5M → 1M' },
                ].map(({ id, label }) => {
                  const list = Array.isArray(doubleConfluenceConfig.presets) ? doubleConfluenceConfig.presets : ['p3', 'p4', 'p6'];
                  const on = list.includes(id);
                  return (
                    <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          setDoubleConfluenceConfig((c) => {
                            const cur = Array.isArray(c.presets) ? [...c.presets] : ['p3'];
                            const next = on ? cur.filter((x) => x !== id) : [...cur, id];
                            return { ...c, presets: next.length ? next : ['p3'] };
                          });
                        }}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12 }}>
                {field('Confluence mode', (
                  <select className="form-input" value={doubleConfluenceConfig.confluenceMode || 'balanced'} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, confluenceMode: e.target.value }))}>
                    <option value="flexible">Flexible</option>
                    <option value="balanced">Balanced</option>
                    <option value="strict">Strict</option>
                  </select>
                ))}
                {field('Min score (0–14)', <input className="form-input" type="number" min={4} max={14} value={doubleConfluenceConfig.minScore ?? 8} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, minScore: +e.target.value }))} />)}
                {field('Low/High similarity %', <input className="form-input" type="number" min={0.2} max={5} step={0.1} value={doubleConfluenceConfig.lowSimilarityPercent ?? 1} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, lowSimilarityPercent: +e.target.value }))} />)}
                {field('Min RR', <input className="form-input" type="number" min={0.8} max={5} step={0.1} value={doubleConfluenceConfig.minRR ?? 1.2} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, minRR: +e.target.value }))} />)}
                {field('TP1 R', <input className="form-input" type="number" min={0.5} max={5} step={0.1} value={doubleConfluenceConfig.tp1R ?? 1} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, tp1R: +e.target.value }))} />)}
                {field('TP2 R', <input className="form-input" type="number" min={1} max={10} step={0.1} value={doubleConfluenceConfig.tp2R ?? 2} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, tp2R: +e.target.value }))} />)}
                {field('TP3 R', <input className="form-input" type="number" min={1.5} max={15} step={0.1} value={doubleConfluenceConfig.tp3R ?? 3} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, tp3R: +e.target.value }))} />)}
                {field('Breakout confirm', (
                  <select className="form-input" value={doubleConfluenceConfig.breakoutConfirmType || 'close'} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, breakoutConfirmType: e.target.value }))}>
                    <option value="close">Candle close</option>
                    <option value="strong_body">Strong body close</option>
                    <option value="multi_candle">Multi candle</option>
                  </select>
                ))}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 14 }}>
                {[
                  ['fibEnabled', 'Fib enabled', true],
                  ['strictFibMode', 'Strict Fib mode', false],
                  ['requireLiquidity', 'Require liquidity sweep', false],
                  ['requireRetest', 'Require retest', false],
                  ['requireBos', 'Require BOS', false],
                  ['requireSmc', 'Require SMC', false],
                ].map(([key, label, def]) => (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={doubleConfluenceConfig[key] != null ? !!doubleConfluenceConfig[key] : def}
                      onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, [key]: e.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>

              <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12 }}>
                {field('Custom HTF', (
                  <select className="form-input" value={doubleConfluenceConfig.customHtf || ''} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, customHtf: e.target.value || null }))}>
                    <option value="">—</option>
                    {['1m','3m','5m','15m','30m','1h','2h','4h'].map((tf) => <option key={tf} value={tf}>{tf}</option>)}
                  </select>
                ))}
                {field('Custom Entry TF', (
                  <select className="form-input" value={doubleConfluenceConfig.customEntry || ''} onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, customEntry: e.target.value || null }))}>
                    <option value="">—</option>
                    {['1m','3m','5m','15m','30m','1h','2h','4h'].map((tf) => <option key={tf} value={tf}>{tf}</option>)}
                  </select>
                ))}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginTop: 22 }}>
                  <input
                    type="checkbox"
                    checked={!!doubleConfluenceConfig.useCustom}
                    onChange={(e) => setDoubleConfluenceConfig((c) => ({ ...c, useCustom: e.target.checked }))}
                  />
                  Use custom pair too
                </label>
              </div>
            </div>
          )}

          {(strategyMode === 'smc' || strategyMode === 'hybrid' || strategyMode === 'ict_confluence') && (
            <div className="card">
              <div className="card-title" style={{ marginBottom: 8 }}>ICT SMC setup</div>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                Signals require a closed-candle liquidity sweep, displacement BOS, and a fresh Order Block/FVG point of interest.
                Watching = waiting for the POI · Ready = near/inside it · Ongoing = entry price reached.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12 }}>
                {field('Setup timeframe', (
                  <select className="form-input" value={smcSetupTf} onChange={(e) => setSmcSetupTf(e.target.value)}>
                    <option value="15m">15 minutes</option>
                    <option value="5m">5 minutes</option>
                    <option value="30m">30 minutes</option>
                  </select>
                ))}
                {field('Higher-timeframe bias', (
                  <select className="form-input" value={smcHtfTf} onChange={(e) => setSmcHtfTf(e.target.value)}>
                    <option value="1h">1 hour</option>
                    <option value="2h">2 hours</option>
                    <option value="4h">4 hours</option>
                  </select>
                ))}
              </div>
            </div>
          )}

          {(strategyMode === 'chart_pattern' || strategyMode === 'hybrid' || strategyMode === 'ict_confluence') && <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Chart pattern
            </div>
            <div className="form-hint" style={{ marginBottom: 6 }}>
              Quick presets — fills every input and gate below. Press the save button afterwards to apply.
            </div>
            <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
              {Object.entries(CP_PRESETS).map(([k, p]) => (
                <button key={k} type="button" className="chip" style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => applyCpPreset(k)}>
                  {p.label}
                </button>
              ))}
            </div>
            {cpPresetNote && <p className="form-hint" style={{ marginBottom: 10 }}>{cpPresetNote}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12 }}>
              {field('Min signal score', <input className="form-input" type="number" value={cpMinScore} onChange={(e) => setCpMinScore(+e.target.value)} />)}
              {field('Near max age (h)', <input className="form-input" type="number" value={cpNearMaxAge} onChange={(e) => setCpNearMaxAge(+e.target.value)} />)}
              {field('Rescue max age (candles)', <input className="form-input" type="number" min={0} value={cpRescueMaxAge} disabled={!cpStaleRescue} onChange={(e) => setCpRescueMaxAge(+e.target.value)} />)}
              {field('Rescue max gap (ATR)', <input className="form-input" type="number" step={0.1} min={0.3} value={cpRescueGap} disabled={!cpStaleRescue} onChange={(e) => setCpRescueGap(+e.target.value)} />)}
              {field('Min RVOL', <input className="form-input" type="number" step={0.1} value={cpMinRvol} onChange={(e) => setCpMinRvol(+e.target.value)} />)}
              {field('Min RR', <input className="form-input" type="number" step={0.1} value={cpMinRr} onChange={(e) => setCpMinRr(+e.target.value)} />)}
              {field('Breakout ATR min', <input className="form-input" type="number" step={0.05} value={cpBreakoutAtr} onChange={(e) => setCpBreakoutAtr(+e.target.value)} />)}
              {field('Min TP1 RR', <input className="form-input" type="number" step={0.1} value={cpMinTp1Rr} onChange={(e) => setCpMinTp1Rr(+e.target.value)} />)}
              {field('Fake BO ATR line', <input className="form-input" type="number" step={0.05} min={0.1} value={cpFbAtr} onChange={(e) => setCpFbAtr(+e.target.value)} />)}
              {field('Closes inside to fail', <input className="form-input" type="number" step={1} min={1} max={5} value={cpFbCandles} onChange={(e) => setCpFbCandles(+e.target.value)} />)}
              {field('Min pillars (0-3)', <input className="form-input" type="number" step={1} min={0} max={3} value={cpMinPillars} onChange={(e) => setCpMinPillars(+e.target.value)} />)}
            </div>
            <p className="form-hint" style={{ marginTop: 6 }}>
              Fake BO ATR line: one close this many ATR back inside the broken level = clear fake. Smaller closes
              (retest noise) fail only after "Closes inside to fail" consecutive closes. Harmonics are exempt.
            </p>
            <p className="form-hint" style={{ marginTop: 6 }}>
              Stale rescue (ON): a watched setup older than "Near max age" is NOT killed just for being old — it is
              invalidated only if price also drifted more than "Rescue max gap" ATR from the level, or it passes the
              "Rescue max age" hard cap (0 = no cap). Opposite-side failure still invalidates. OFF = old behaviour.
              Rescued signals carry a staleRescued tag so you can compare their results.
            </p>
            <div className="flex gap-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              {/* Live price touch entry removed — always: TF candle CLOSE beyond entry, enter on next candle */}
              <label className="chip chip-muted" style={{ cursor: 'pointer' }} title="Promote WATCHING to READY when price already closed beyond the level but strict breakout filters failed (min ATR, body…). Still skips if already chased past max R.">
                <input type="checkbox" checked={cpWeakBoPromote} onChange={(e) => setCpWeakBoPromote(e.target.checked)} /> Weak BO promote
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }} title="After READY: enter on live price touch of entry (no wait for next candle close). Use with Weak BO promote.">
                <input type="checkbox" checked={cpLiveEntry} onChange={(e) => setCpLiveEntry(e.target.checked)} /> Entry on live touch
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={cpFailedBo} onChange={(e) => setCpFailedBo(e.target.checked)} /> Failed BO invalidate
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={cpStaleRescue} onChange={(e) => setCpStaleRescue(e.target.checked)} /> Stale rescue
              </label>
              <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={cpElliottWave} onChange={(e) => setCpElliottWave(e.target.checked)} /> Elliott wave
              </label>
            </div>
            <div className="card-title" style={{ margin: '16px 0 8px', fontSize: 14 }}>
              Pattern timeframes
            </div>
            <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
              {['5m', '15m', '30m', '1h', '2h', '4h', '1d'].map((tf) => {
                const on = cpTfs.includes(tf);
                return (
                  <button
                    key={tf}
                    type="button"
                    className="chip"
                    onClick={() =>
                      setCpTfs((prev) =>
                        prev.includes(tf) ? (prev.length > 1 ? prev.filter((x) => x !== tf) : prev) : [...prev, tf]
                      )
                    }
                    style={{
                      cursor: 'pointer',
                      background: on ? '#f0b90b' : undefined,
                      color: on ? '#0b0e11' : undefined,
                      fontWeight: 700,
                    }}
                  >
                    {tf.toUpperCase()}
                  </button>
                );
              })}
              <button
                type="button"
                className="chip"
                onClick={() => setCpTfs(['5m', '15m', '30m', '1h', '2h', '4h', '1d'])}
                style={{ cursor: 'pointer' }}
              >
                All TF
              </button>
            </div>
            <div className="card-title" style={{ margin: '12px 0 8px', fontSize: 14 }}>
              Patterns to scan
            </div>
            <div className="flex gap-8" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
              <button
                type="button"
                className="chip"
                onClick={() => setCpPatterns(null)}
                style={{
                  cursor: 'pointer',
                  background: cpPatterns == null ? '#f0b90b' : undefined,
                  color: cpPatterns == null ? '#0b0e11' : undefined,
                  fontWeight: 700,
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
                    className="chip"
                    title={pt}
                    onClick={() =>
                      setCpPatterns((prev) => {
                        if (prev == null) return CP_PATTERN_OPTIONS.filter((x) => x !== pt);
                        if (prev.includes(pt)) {
                          const next = prev.filter((x) => x !== pt);
                          return next.length ? next : prev;
                        }
                        const next = [...prev, pt];
                        return next.length === CP_PATTERN_OPTIONS.length ? null : next;
                      })
                    }
                    style={{
                      cursor: 'pointer',
                      background: on ? '#0ecb81' : undefined,
                      color: on ? '#0b0e11' : '#848e9c',
                      fontSize: 11,
                    }}
                  >
                    {pt.replace(/_/g, ' ')}
                  </button>
                );
              })}
            </div>
            <p className="form-hint" style={{ marginBottom: 8 }}>
              Only selected patterns and timeframes produce signals. Same coin can signal on multiple TFs.
            </p>
            <div className="card-title" style={{ margin: '16px 0 8px', fontSize: 14 }}>
              Gates (hard / soft)
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {GATE_DEFS.map((g) => (
                <div key={g.key} className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{g.label}</div>
                    <div className="form-hint">{g.hint}</div>
                  </div>
                  <select
                    className="form-input"
                    style={{ width: 100, padding: '8px 10px' }}
                    value={cpGateModes[g.key] || g.def}
                    onChange={(e) => setCpGateModes((m) => ({ ...m, [g.key]: e.target.value }))}
                  >
                    <option value="hard">hard</option>
                    <option value="soft">soft</option>
                  </select>
                </div>
              ))}
            </div>
          </div>}

          <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
            {strategyMode === 'zone_pattern' ? (
              <button className="btn btn-secondary" disabled={scanBusy} onClick={applyRecommendedZonePatternSettings}>
                Apply recommended Zone + Pattern preset
              </button>
            ) : (
              <button className="btn btn-secondary" disabled={scanBusy} onClick={applyRecommendedScannerSettings}>
                Apply recommended ICT + Pattern defaults
              </button>
            )}
            <button className="btn btn-primary" disabled={scanBusy} onClick={saveScannerSettings}>
              {scanBusy ? 'Saving…' : 'Save scanner settings'}
            </button>
          </div>
          <p className="form-hint">
            Recommended Zone + Pattern preset: 15m setup, 4h context, ≥2 zone-source types, 0.45 ATR clustering, 0.8 ATR max chase, score 60, TP1 R:R 1.2; Fibonacci is optional. Active signals are unchanged. Review results before enabling live auto-trading.
          </p>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Global Bybit API (shared / testnet)
            </div>
            <p className="form-hint" style={{ marginBottom: 10 }}>
              Status: {bybitInfo?.configured ? 'Configured' : 'Not set'} {bybitInfo?.key_preview || bybitInfo?.preview || ''}
            </p>
            {field('API key', <input className="form-input" value={bybitKey} onChange={(e) => setBybitKey(e.target.value)} autoComplete="off" />)}
            {field('API secret', <input className="form-input" type="password" value={bybitSecret} onChange={(e) => setBybitSecret(e.target.value)} autoComplete="off" />)}
            <button className="btn btn-secondary" disabled={scanBusy || !bybitKey || !bybitSecret} onClick={saveBybitKeys}>
              Save Bybit keys
            </button>
          </div>
        </>
      )}

      {/* ─── AUTO TRADE ─── */}
      {section === 'auto' && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>
            Global auto-trade config
          </div>
          {!autoCfg ? (
            <p className="text-secondary">Loading or unavailable…</p>
          ) : (
            <>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <span>Enabled</span>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={!!autoCfg.autoTradingEnabled}
                    onChange={(e) => {
                      const next = { ...autoCfg, autoTradingEnabled: e.target.checked };
                      setAutoCfg(next);
                      saveAutoConfig({ autoTradingEnabled: e.target.checked });
                    }}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <div>
                  <div>Manual Market Entry</div>
                  <div className="text-secondary" style={{ fontSize: 12 }}>
                    Let users place a market order from READY signals
                  </div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={autoCfg.manualEntryEnabled !== false}
                    onChange={(e) => {
                      const next = { ...autoCfg, manualEntryEnabled: e.target.checked };
                      setAutoCfg(next);
                      saveAutoConfig({ manualEntryEnabled: e.target.checked });
                    }}
                  />
                  <span className="slider" />
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 12 }}>
                {field(
                  'Min score',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.minimumScore ?? 80}
                    onChange={(e) => setAutoCfg({ ...autoCfg, minimumScore: +e.target.value })}
                  />
                )}
                {field(
                  'Margin %',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.marginPercent ?? 2}
                    onChange={(e) => setAutoCfg({ ...autoCfg, marginPercent: +e.target.value })}
                  />
                )}
                {field(
                  'Leverage',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.defaultLeverage ?? 10}
                    onChange={(e) => setAutoCfg({ ...autoCfg, defaultLeverage: +e.target.value })}
                  />
                )}
                {field(
                  'Max positions',
                  <input
                    className="form-input"
                    type="number"
                    value={autoCfg.maxOpenPositions ?? 5}
                    onChange={(e) => setAutoCfg({ ...autoCfg, maxOpenPositions: +e.target.value })}
                  />
                )}
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                disabled={autoBusy}
                onClick={() =>
                  saveAutoConfig({
                    minimumScore: autoCfg.minimumScore,
                    marginPercent: autoCfg.marginPercent,
                    defaultLeverage: autoCfg.defaultLeverage,
                    maxOpenPositions: autoCfg.maxOpenPositions,
                    autoTradingEnabled: autoCfg.autoTradingEnabled,
                    manualEntryEnabled: autoCfg.manualEntryEnabled !== false,
                  })
                }
              >
                {autoBusy ? 'Saving…' : 'Save auto-trade'}
              </button>

              {/* ── High Risk mode parameters (users opt in from the Trade tab) ── */}
              {(() => {
                const hr = { ...HIGH_RISK_DEFAULTS, ...(autoCfg.highRisk || {}) };
                const setHr = (k, v) => setAutoCfg({ ...autoCfg, highRisk: { ...hr, [k]: v } });
                const num = (k, label, step = 1) =>
                  field(
                    label,
                    <input
                      className="form-input"
                      type="number"
                      step={step}
                      value={hr[k]}
                      onChange={(e) => setHr(k, +e.target.value)}
                    />
                  );
                return (
                  <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-light)' }}>
                    <div className="flex-between" style={{ marginBottom: 8 }}>
                      <div className="card-title">🔥 High Risk mode</div>
                    </div>
                    <p className="form-hint" style={{ marginBottom: 10 }}>
                      The only risk mode. Users confirm it once in the Trade tab. Margin per trade is fixed (never below 25%); leverage is derived
                      per trade from the SL distance so a stop-out costs at most the loss cap.
                    </p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 12 }}>
                      {num('marginPercent', 'Default margin % (min 25)')}
                      {num('maxMarginPercent', 'Max margin % a user may pick')}
                      {num('maxLossPerTradePercent', 'Max loss at SL (% of balance)', 0.5)}
                      {num('maximumLeverage', 'Max leverage')}
                      {num('minSlDistPct', 'Skip if SL tighter than (%)', 0.1)}
                      {num('maxSlDistPct', 'Skip if SL wider than (%)', 0.5)}
                      {num('maxTotalMarginPercent', 'Total margin cap (%)')}
                      {num('dailyLossLimitPercent', 'Daily loss stop (%)')}
                      {num('drawdownHaltPercent', 'Drawdown halt from peak (%)')}
                    </div>
                    <button
                      className="btn btn-primary"
                      style={{ marginTop: 12 }}
                      disabled={autoBusy}
                      onClick={() => saveAutoConfig({ highRisk: hr })}
                    >
                      {autoBusy ? 'Saving…' : 'Save High Risk settings'}
                    </button>
                    <p className="form-hint" style={{ marginTop: 8 }}>
                      Values are clamped to safe ranges when saved. Positions at once ≈ total margin cap ÷ margin %.
                    </p>
                  </div>
                );
              })()}
              <p className="form-hint" style={{ marginTop: 10 }}>
                Duplicate-order protection remains active. Prefer Testnet keys.
              </p>
            </>
          )}
        </div>
      )}

      {/* ─── SIGNALS (manual status) ─── */}
      {section === 'signals' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <div>
              <div className="card-title">Signal status control</div>
              <p className="card-subtitle" style={{ marginTop: 4 }}>
                WATCHING → READY → ONGOING. Setting READY → ONGOING marks entry hit so Bybit auto-trade fires on next cron (if enabled).
              </p>
            </div>
            <button className="btn btn-secondary" disabled={sigBusy} onClick={loadSignals}>
              Refresh
            </button>
          </div>

          <div className="flex gap-8" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            <span className="chip chip-muted">W {sigData.counts?.watching ?? 0}</span>
            <span className="chip chip-ready">R {sigData.counts?.ready ?? 0}</span>
            <span className="chip chip-ongoing">O {sigData.counts?.ongoing ?? 0}</span>
          </div>

          <div className="flex gap-8" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
            {['all', 'watching', 'ready', 'ongoing'].map((f) => (
              <button
                key={f}
                className={`filter-pill ${sigFilter === f ? 'active' : ''}`}
                onClick={() => setSigFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>

          {(() => {
            const rows = [];
            if (sigFilter === 'all' || sigFilter === 'watching') {
              (sigData.watching || []).forEach((s) => rows.push({ ...s, _bucket: 'WATCHING' }));
            }
            if (sigFilter === 'all' || sigFilter === 'ready') {
              (sigData.ready || []).forEach((s) => rows.push({ ...s, _bucket: 'READY' }));
            }
            if (sigFilter === 'all' || sigFilter === 'ongoing') {
              (sigData.ongoing || []).forEach((s) => rows.push({ ...s, _bucket: 'ONGOING' }));
            }
            if (!rows.length) {
              return <p className="form-hint">No signals in this filter.</p>;
            }
            return (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Dir</th>
                      <th>Status</th>
                      <th>Score</th>
                      <th>Entry</th>
                      <th>Price</th>
                      <th>Dist%</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => {
                      const st = String(s.status || s._bucket || '').toUpperCase();
                      const id = s.signal_id;
                      return (
                        <tr key={id}>
                          <td>
                            <b>{s.symbol}</b>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{id?.slice?.(0, 12)}…</div>
                          </td>
                          <td>{(s.direction || s.dir || '—').toUpperCase()}</td>
                          <td>
                            <span
                              className={`chip ${
                                st === 'READY' ? 'chip-ready' : st === 'ONGOING' ? 'chip-ongoing' : 'chip-muted'
                              }`}
                            >
                              {st}
                            </span>
                          </td>
                          <td>{s.score ?? '—'}</td>
                          <td>{s.entry ?? '—'}</td>
                          <td>{s.current_price ?? s.last_price ?? '—'}</td>
                          <td>
                            {s.distance_percent != null
                              ? Number(s.distance_percent).toFixed(2)
                              : '—'}
                          </td>
                          <td>
                            <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                              {st === 'WATCHING' && (
                                <button
                                  className="btn btn-primary"
                                  style={{ padding: '4px 10px', fontSize: 12 }}
                                  disabled={sigBusy}
                                  onClick={() => changeSignalStatus(id, 'promote_ready')}
                                  title="WATCHING → READY"
                                >
                                  → Ready
                                </button>
                              )}
                              {st === 'READY' && (
                                <button
                                  className="btn btn-primary"
                                  style={{ padding: '4px 10px', fontSize: 12 }}
                                  disabled={sigBusy}
                                  onClick={() => {
                                    if (
                                      confirm(
                                        'Set to ONGOING? This marks entry hit and will trigger Bybit auto-trade on next cron if enabled.'
                                      )
                                    ) {
                                      changeSignalStatus(id, 'promote_ongoing');
                                    }
                                  }}
                                  title="READY → ONGOING (triggers Bybit trade)"
                                >
                                  → Ongoing
                                </button>
                              )}
                              {st !== 'INVALIDATED' && st !== 'COMPLETED_PROFIT' && st !== 'STOPPED' && (
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: '4px 10px', fontSize: 12 }}
                                  disabled={sigBusy}
                                  onClick={() => {
                                    if (confirm(`Invalidate ${s.symbol}?`)) {
                                      changeSignalStatus(id, 'set_status', 'INVALIDATED');
                                    }
                                  }}
                                >
                                  Invalidate
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}

          <p className="form-hint" style={{ marginTop: 14 }}>
            <b>→ Ready</b> = WATCHING → READY (Telegram ready alerts can fire).{' '}
            <b>→ Ongoing</b> = READY → ONGOING with <code>entry_hit_at</code> set — auto-trader treats it as entry hit and places Bybit order if auto-trading is ON.
          </p>
        </div>
      )}

      {/* ─── AI MANAGER ─── */}
      {section === 'ai' && (
        <div className="card">
          <div className="flex-between" style={{ marginBottom: 12 }}>
            <div className="card-title">Gemini API key · Nila (AI Manager)</div>
            <span className={`chip ${aiCfg.configured ? 'chip-ongoing' : 'chip-muted'}`}>
              {aiCfg.configured ? 'Key saved' : 'No key'}
            </span>
          </div>
          <p className="card-subtitle" style={{ marginBottom: 12 }}>
            Free Gemini key paste කරලා Save කරන්න. ඊට පස්සේ සියලු users ට floating <b>AI</b> button එකෙන්
            Nila සමඟ chat / Talk කරන්න පුළුවන්.
          </p>
          <label className="form-label">Gemini API key</label>
          <input
            className="form-input"
            type="password"
            autoComplete="off"
            value={aiKey}
            onChange={(e) => setAiKey(e.target.value)}
            placeholder={aiCfg.configured ? 'Saved — new key paste කරලා replace කරන්න' : 'AIza…'}
          />
          <div className="flex gap-8" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              disabled={aiBusy || !aiKey.trim()}
              onClick={saveAiKey}
            >
              {aiBusy ? 'Working…' : 'Save Gemini key'}
            </button>
            <button
              className="btn btn-secondary"
              disabled={aiBusy || (!aiKey.trim() && !aiCfg.configured)}
              onClick={testAiKey}
            >
              {aiBusy ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          <p className="text-secondary" style={{ fontSize: 12, marginTop: 12 }}>
            Free key: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>
            <br />
            Optional env: <code>GEMINI_API_KEY</code>
            {aiCfg.model ? (
              <>
                <br />
                Model: {aiCfg.model}
              </>
            ) : null}
          </p>
        </div>
      )}

      {/* ─── RESET ─── */}
      {section === 'reset' && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>
            Reset signals
          </div>
          <p className="card-subtitle" style={{ marginBottom: 12 }}>
            Uses existing <code>/api/admin/reset-signals</code>. May require CRON_SECRET.
          </p>
          <div className="flex gap-8" style={{ marginBottom: 12 }}>
            <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
              <input type="radio" checked={resetMode === 'history'} onChange={() => setResetMode('history')} /> History only
            </label>
            <label className="chip chip-muted" style={{ cursor: 'pointer' }}>
              <input type="radio" checked={resetMode === 'all'} onChange={() => setResetMode('all')} /> All signals
            </label>
          </div>
          {field(
            'CRON_SECRET (if required)',
            <input
              className="form-input"
              type="password"
              value={resetSecret}
              onChange={(e) => setResetSecret(e.target.value)}
              placeholder="optional if not enforced"
            />
          )}
          <div className="flex gap-8">
            <button className="btn btn-secondary" disabled={resetBusy} onClick={loadResetPreview}>
              Preview
            </button>
            <button className="btn btn-danger" disabled={resetBusy} onClick={confirmReset}>
              Confirm reset
            </button>
          </div>
          {resetPreview && (
            <pre style={{ marginTop: 12, background: 'var(--border-light)', padding: 12, borderRadius: 12, fontSize: 12, overflow: 'auto' }}>
              {JSON.stringify(resetPreview, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* ─── SYSTEM ─── */}
      {section === 'scanlog' && <ScanLogPanel />}

      {section === 'system' && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Market scan</div>
          <p className="card-subtitle" style={{ marginBottom: 0 }}>
            Scan controls live on the <b>Home</b> dashboard only. Click <b>Scan now</b> once to run the first full market pass and turn Auto-scan ON.
            After that, cron-job.org runs full scan every N minutes (default 5) and lifecycle every 1 minute.
            Full-scan interval can still be set below.
          </p>
          <div style={{ marginTop: 16 }}>
            <label className="form-hint">Full scan interval (minutes)</label>
            <div className="flex gap-8" style={{ alignItems: 'center', marginTop: 6 }}>
              <input
                className="form-input"
                type="number"
                min={1}
                max={60}
                value={fullScanInterval}
                onChange={(e) => setFullScanInterval(+e.target.value || 5)}
                style={{ width: 100 }}
              />
              <button
                className="btn btn-secondary"
                disabled={sysBusy}
                onClick={async () => {
                  setSysBusy(true);
                  try {
                    const res = await fetch('/api/scan', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ full_scan_interval_minutes: fullScanInterval }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Save failed');
                    if (data.full_scan_interval_minutes) setFullScanInterval(data.full_scan_interval_minutes);
                    flash(data.msg || 'Full scan interval saved');
                  } catch (e) {
                    flash(e.message);
                  } finally {
                    setSysBusy(false);
                  }
                }}
              >
                Save interval
              </button>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <label className="form-hint">Exchanges the cron scans</label>
            <div className="flex gap-8" style={{ alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              {['bybit', 'binance'].map((ex) => (
                <label key={ex} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={scanExchanges.includes(ex)}
                    onChange={(e) =>
                      setScanExchanges((cur) =>
                        e.target.checked ? [...new Set([...cur, ex])] : cur.filter((x) => x !== ex)
                      )
                    }
                  />
                  {ex === 'bybit' ? 'Bybit' : 'Binance'}
                </label>
              ))}
              <button
                className="btn btn-secondary"
                disabled={sysBusy || !scanExchanges.length}
                onClick={async () => {
                  setSysBusy(true);
                  try {
                    const res = await fetch('/api/scan', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ scan_exchanges: scanExchanges }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Save failed');
                    if (data.scan_exchanges) setScanExchanges(data.scan_exchanges);
                    flash(data.msg || 'Saved');
                  } catch (e) {
                    flash(e.message);
                  } finally {
                    setSysBusy(false);
                  }
                }}
              >
                Save
              </button>
            </div>
            <p className="form-hint" style={{ marginTop: 6 }}>
              Binance is the default. Bybit analysis and signal generation run only while Bybit is selected here.
            </p>
          </div>
          <div style={{ marginTop: 16 }}>
            <label className="form-hint">Full scan time budget (seconds, 15–280)</label>
            <div className="flex gap-8" style={{ alignItems: 'center', marginTop: 6 }}>
              <input
                className="form-input"
                type="number"
                min={15}
                max={280}
                value={fullScanBudget}
                onChange={(e) => setFullScanBudget(+e.target.value || 40)}
                style={{ width: 100 }}
              />
              <button
                className="btn btn-secondary"
                disabled={sysBusy}
                onClick={async () => {
                  setSysBusy(true);
                  try {
                    const res = await fetch('/api/scan', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ full_scan_budget_seconds: fullScanBudget }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Save failed');
                    if (data.full_scan_budget_seconds) setFullScanBudget(data.full_scan_budget_seconds);
                    flash(data.msg || 'Time budget saved');
                  } catch (e) {
                    flash(e.message);
                  } finally {
                    setSysBusy(false);
                  }
                }}
              >
                Save budget
              </button>
            </div>
            <p className="form-hint" style={{ marginTop: 6 }}>
              How long one full scan may spend sweeping its part of the coins. The cron now answers
              instantly and scans in the background, so cron-job.org can no longer time out. Keep ~40s on a
              60s host limit; raise it (e.g. 150–240) if your host allows 300s functions. Coins not
              reached are continued on the next tick — see Scan log → “Not reached”.
            </p>
          </div>
          <div style={{ marginTop: 16 }}>
            <label className="form-hint">Split full scan into parts (1–10)</label>
            <div className="flex gap-8" style={{ alignItems: 'center', marginTop: 6 }}>
              <input
                className="form-input"
                type="number"
                min={1}
                max={10}
                value={fullScanParts}
                onChange={(e) => setFullScanParts(+e.target.value || 1)}
                style={{ width: 100 }}
              />
              <button
                className="btn btn-secondary"
                disabled={sysBusy}
                onClick={async () => {
                  setSysBusy(true);
                  try {
                    const res = await fetch('/api/scan', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ full_scan_parts: fullScanParts }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Save failed');
                    if (data.full_scan_parts) setFullScanParts(data.full_scan_parts);
                    flash(data.msg || 'Saved');
                  } catch (e) {
                    flash(e.message);
                  } finally {
                    setSysBusy(false);
                  }
                }}
              >
                Save parts
              </button>
            </div>
            <p className="form-hint" style={{ marginTop: 6 }}>
              Each full scan tick checks ONE part of the coin list (part 1 → 2 → 3 → 1 …), so every coin is
              scanned once per parts × interval minutes (3 parts × 5 min = 15 min). Pick the smallest number whose
              part still fits in the time budget (~170 coins per 40s). 1 = old behaviour (whole list every tick).
            </p>
          </div>
          <p className="form-hint" style={{ marginTop: 12 }}>
            Cron URLs: <code>/api/cron/scan</code> (1 min) · <code>/api/cron/full-scan</code> (5 min) with <code>?secret=CRON_SECRET</code>
          </p>
        </div>
      )}
    </div>
  );
}
