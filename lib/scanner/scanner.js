/**
 * Server-side market scanner.
 * Preserves original TA + scores; adds lifecycle + dedup.
 */
import {
  loadExchangeInfo,
  loadTickers,
  getKlines,
  clearKlineCache,
  getActiveExchange,
  getScanExchanges,
  runWithExchange,
} from '../exchange/index.js';
import { signalExchange } from '../exchange/context.js';
import { runChartPatternStrategy } from './strategy/chartPattern/index.js';
import { CHART_PATTERN_CONFIG } from './strategy/chartPattern/config.js';
import { revalidateChartPatternSignal } from './strategy/chartPattern/revalidate.js';
import { runIctSmcStrategy } from './strategy/ictSmc/index.js';
import { runZonePatternStrategy } from './strategy/zonePattern/index.js';
import {
  ZONE_PATTERN_DEFAULTS,
  normalizeZonePatternConfig,
} from './strategy/zonePattern/config.js';
import { runDoubleConfluenceStrategy, runDoubleConfluencePair } from './strategy/doubleConfluence/index.js';
import { runEmaBumpPair } from './strategy/emaBump/index.js';
import { EMA_BUMP_DEFAULTS, normalizeEmaBumpConfig, gateMode, htfFor } from './strategy/emaBump/config.js';
import {
  DOUBLE_CONFLUENCE_DEFAULTS,
  normalizeDoubleConfluenceConfig,
  resolveTfPairs,
} from './strategy/doubleConfluence/config.js';
import { requireIctPatternConfluence } from './strategyConfluence.js';
import { calcATR } from './indicators.js';
import { revalidateEntryQuality } from '../signals/entryQuality.js';
import { buildInvalidationRecord } from '../signals/invalidation.js';
import { getState, setState } from '../database/appState.js';
import { SIGNAL_CONFIG, SIGNAL_STATUS } from '../config/signalConfig.js';
import { RECOMMENDED_SCANNER_SETTINGS } from '../config/recommendedScannerSettings.js';
import { buildSignalId } from '../signals/signalId.js';
import {
  applyLifecycle,
  // entry quality used inline via revalidateEntryQuality
  buildNewSignalRecord,
} from '../signals/signalLifecycle.js';
import {
  getSignalById,
  getActiveSignals,
  createSignal,
  upsertSignal,
  updateSignal,
  createSignalEvent,
  markNotified,
} from '../database/signals.js';
import {
  completeScanRun,
  acquireScanRun,
  releaseScanLock,
  getPendingFullScan,
  consumePendingFullScan,
  markPendingFullScan,
} from '../database/scanRuns.js';
import { dispatchNotifications } from '../telegram/telegram.js';
import { getEntryProximity } from '../signals/proximity.js';
import { isUpdatableStatus } from '../signals/sibling.js';
import { classifyNewSignalEntry, mergeEntryConfirmCfg } from '../signals/entryConfirm.js';
import { checkFailedBreakout, isConfirmedPatternBreakout } from '../signals/failedBreakout.js';
import { planPart, nextPartOffset, stableOrder } from './scanParts.js';
import { getBanUntil, isRateGuardTripped, resetRateGuard, BAN_STATE_KEY } from '../binance/client.js';
import { classifyCoin, logKind, recordScanStart, recordScanFinish, recordScanFailure } from './scanLog.js';
import {
  persistNearBreakout,
  recheckNearBreakout,
} from './nearBreakoutLifecycle.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Time budget (ms) for one full-scan sweep over ALL coins.
 * app_state `full_scan_budget_seconds` > env FULL_SCAN_BUDGET_SECONDS > 40s.
 * 40s keeps lock-wait (15s) + sweep + finishing inside a 60s host limit; raise it
 * (e.g. 240) if the host allows long functions.
 */
export async function getFullScanBudgetMs(defaultSec = 40) {
  let sec = defaultSec;
  const env = +process.env.FULL_SCAN_BUDGET_SECONDS;
  if (Number.isFinite(env) && env > 0) sec = env;
  try {
    const st = +(await getState('full_scan_budget_seconds', null));
    if (Number.isFinite(st) && st > 0) sec = st;
  } catch (_) {}
  return Math.round(Math.min(280, Math.max(15, sec)) * 1000);
}

function buildLiveEvaluation(signal, price, priceSource, atr5m, candleRange, qualityCheck, at = new Date()) {
  const previous = signal.metadata?.liveEvaluation || {};
  const proximity = getEntryProximity(signal, price, atr5m, candleRange);
  const entry = +signal.entry;
  const direction = String(signal.direction || signal.dir || '').toUpperCase();
  const signedMove = direction === 'SHORT' ? entry - price : price - entry;
  const atEntryTolerance = Math.max(Math.abs(entry) * 1e-8, 1e-10);
  const marketPosition =
    proximity.distanceToEntry <= atEntryTolerance
      ? 'AT_ENTRY'
      : signedMove > 0
        ? 'IN_FAVOR'
        : 'AGAINST';
  const checkedAt = at.toISOString();
  const qualityDetails = qualityCheck?.details || {};
  const stop = +signal.sl;
  const target = +signal.tp1;
  const isLong = direction !== 'SHORT';
  const remainingRisk = isLong ? price - stop : stop - price;
  const remainingReward = isLong ? target - price : price - target;
  const currentRrToTp1 =
    Number.isFinite(remainingRisk) &&
    Number.isFinite(remainingReward) &&
    remainingRisk > 0 &&
    remainingReward >= 0
      ? Math.round((remainingReward / remainingRisk) * 100) / 100
      : null;

  return {
    evaluatedAt: checkedAt,
    markPrice: priceSource === 'MARK_PRICE' ? price : null,
    price,
    priceSource,
    marketPosition,
    priceVsEntry: price > entry ? 'ABOVE_ENTRY' : price < entry ? 'BELOW_ENTRY' : 'AT_ENTRY',
    atr5m: atr5m || null,
    atrDistance: proximity.atrDistance,
    distanceToEntry: proximity.distanceToEntry,
    distancePercent: proximity.distancePercent,
    proximityScore: proximity.proximityScore,
    plannedRr: signal.rr ?? qualityDetails.rr ?? null,
    currentRrToTp1,
    currentScore:
      qualityCheck?.reScore ?? previous.currentScore ?? (+signal.score || null),
    reScore: qualityCheck?.reScore ?? previous.reScore ?? null,
    reScoreCheckedAt: qualityCheck ? checkedAt : previous.reScoreCheckedAt ?? null,
    htfState: qualityCheck
      ? {
          bias: qualityDetails.htfBias ?? null,
          bos: qualityDetails.htfBos ?? null,
          choch: qualityDetails.htfChoch ?? null,
        }
      : previous.htfState ?? null,
    entryQuality: qualityCheck
      ? {
          ok: !!qualityCheck.ok,
          reason: qualityCheck.reason || null,
          failures: qualityCheck.failures || [],
          details: qualityDetails,
          checkedAt,
        }
      : previous.entryQuality ?? null,
  };
}

// Manual scans retain a short soft deadline. The cron route has maxDuration=300
// and must finish the complete active-signal pass before spending time on discovery.
const SOFT_DEADLINE_MS = 40 * 1000;
const CRON_SOFT_DEADLINE_MS = 280 * 1000;

async function runScanOne(source = 'cron', options = {}) {
  let startedAt = Date.now();
  const isFullSource = source === 'cron-full' || options.mode === 'full' || options.fullScan === true;
  // Full-scan gets an explicit time budget (counted from lock acquisition) so the sweep over ALL
  // coins stops cleanly before the host kills the function; the rotating cursor continues from there.
  let budgetMs = +options.budgetMs > 0 ? +options.budgetMs : 0;
  let deadlineMs = budgetMs
    ? budgetMs
    : source === 'cron' || source === 'cron-full' ? CRON_SOFT_DEADLINE_MS : SOFT_DEADLINE_MS;
  const timeLeft = () => deadlineMs - (Date.now() - startedAt);

  // Circuit breaker: while Binance has this IP banned (HTTP 418) make NO requests at all —
  // hammering a banned IP only extends the ban. The ban end time is stored by the Binance client.
  try {
    if ((await getActiveExchange()) === 'binance') {
      const ban = await getState(BAN_STATE_KEY, null);
      if (ban && +ban.until > Date.now()) {
        return {
          ok: true,
          skipped: true,
          banned: true,
          banUntil: +ban.until,
          reason: `Binance IP banned until ${new Date(+ban.until).toISOString()} — scans paused, no requests sent`,
        };
      }
    }
  } catch (_) {}

  // If a previous full-scan was deferred (lock busy), upgrade this run to full discovery
  let promotedFromPending = false;
  let resetCursor = !!options.resetCursor;
  if (options._promoted) {
    // wrapper already consumed the pending flag for the whole multi-exchange run
    resetCursor = true;
    promotedFromPending = true;
  } else if (!isFullSource && (source === 'cron' || source === 'manual')) {
    try {
      const pending = await getPendingFullScan();
      if (pending) {
        await consumePendingFullScan();
        resetCursor = true;
        promotedFromPending = true;
      }
    } catch (_) {}
  }
  // Split scan: the cron full-scan walks the universe in N parts (one part per tick) with its own cursor
  const lifecycleForParts = options.lifecycle === 'skip' || options.lifecycle === 'only';
  const partsN = isFullSource && !lifecycleForParts && !promotedFromPending ? Math.round(+options.parts) || 0 : 0;
  const partsMode = partsN > 1;
  if (isFullSource && !partsMode) resetCursor = true;
  // A promoted (previously deferred) full scan gets the same budget as a scheduled one
  if (promotedFromPending && !budgetMs) {
    budgetMs = await getFullScanBudgetMs();
    deadlineMs = budgetMs;
  }

  // Allow Scan Now UI to override universe / chunk size per request
  const universe = options.universe != null && options.universe !== ''
    ? options.universe
    : SIGNAL_CONFIG.scanUniverse;
  const chunkSizeCfg = options.chunkSize != null && +options.chunkSize > 0
    ? +options.chunkSize
    : SIGNAL_CONFIG.scanChunkSize;
  // Manual "Scan Now" runs in chunks. To keep statuses stable until the WHOLE scan is done:
  //   lifecycle 'skip' → chunk run: only monitor ONGOING (TP/SL); WATCHING/READY are NOT touched
  //   lifecycle 'only' → final run after the last chunk: status updates only (no discovery)
  //   (default / cron) → monitor + discover as before
  const lifecycleMode = options.lifecycle === 'skip' || options.lifecycle === 'only' ? options.lifecycle : null;

  const lockMode = isFullSource || promotedFromPending ? 'full' : 'normal';
  // Lock TTL of a full run = its budget + margin, so the 1-min cron does not treat a live
  // full-scan as stale (default TTL is only 70s).
  const lockTtlMs = lockMode === 'full' && budgetMs ? budgetMs + 25_000 : undefined;
  const acq = await acquireScanRun(
    { source, universe, chunkSize: chunkSizeCfg, full: lockMode === 'full', promotedFromPending },
    {
      mode: lockMode,
      // Full / pending-full: wait for the 1-min scan to finish instead of skipping
      waitMs: lockMode === 'full' ? (options.lockWaitMs ?? 15_000) : 0,
      ttlMs: lockTtlMs,
    }
  );
  const lock = acq;
  if (!lock.acquired) {
    // Never drop a full-scan cycle: queue it for the next cron
    if (lockMode === 'full' || isFullSource) {
      try {
        await markPendingFullScan(lock.reason || 'lock_busy');
      } catch (_) {}
      return {
        ok: true,
        skipped: false,
        deferred: true,
        pendingFullScan: true,
        reason: `Full scan deferred (lock busy): ${lock.reason || 'busy'} — will run on next cron`,
        waitedMs: lock.waitedMs ?? 0,
      };
    }
    return {
      ok: false,
      skipped: true,
      reason: lock.reason,
    };
  }

  const scanRun = acq.run;
  startedAt = Date.now(); // budget starts once we actually own the lock
  clearKlineCache();
  resetRateGuard();

  let symbolsScanned = 0;
  let signalsCreated = 0;
  const createdSummaries = [];
  const nearBreakouts = []; // pre-breakout radar (manual scan only, never persisted)
  let signalsUpdated = 0;
  let telegramSent = 0;
  let errorCount = 0;
  let timedOutSoft = false;
  let stoppedBy = null; // 'ban' | 'rate_guard' when the loop was cut short to protect the IP
  const errors = [];

  try {
    const symbols = await loadExchangeInfo();
    const activeExchange = await getActiveExchange();
    const tickers = await loadTickers();

    let sorted = Object.entries(tickers)
      .filter(([s]) => symbols.includes(s))
      .sort((a, b) => b[1].volume - a[1].volume)
      .map((e) => e[0]);

    // Top-N by 24h quote volume (e.g. top 200 futures)
    let fullMarket = sorted;
    if (universe !== 'all' && +universe > 0) {
      fullMarket = fullMarket.slice(0, +universe);
    }

    // Rotating chunk so each Vercel request stays under Hobby 60s limit
    let coverage = null;
    let cursorOffset = 0;
    let usingCursor = false;
    let cursorKey = `scan_cursor:${activeExchange}`;
    let cursorUniverse = `${activeExchange}:${universe}`;
    // Full sweep (5-min cron / promoted pending): walk the WHOLE universe, highest volume first,
    // until the time budget runs out; the persisted cursor lets the 1-min cron continue the rest.
    const fullSweep = (isFullSource || promotedFromPending) && !lifecycleMode && !partsMode;
    if (fullSweep || partsMode || (chunkSizeCfg > 0 && chunkSizeCfg < fullMarket.length)) {
      usingCursor = true;
      // split scan keeps its own cursor so the 1-min cron rotation cannot shift the parts
      cursorKey = partsMode ? `scan_cursor_full:${activeExchange}` : `scan_cursor:${activeExchange}`;
      cursorUniverse = partsMode
        ? `${activeExchange}:${universe}:p${partsN}`
        : `${activeExchange}:${universe}`;
      const chunkSize = fullSweep
        ? fullMarket.length
        : partsMode
          ? Math.ceil(fullMarket.length / partsN)
          : Math.min(+chunkSizeCfg, fullMarket.length);
      let cursorState = (await getState(cursorKey)) || { offset: 0, universe: null };
      if (resetCursor || String(cursorState.universe) !== cursorUniverse) {
        cursorOffset = 0;
      } else {
        cursorOffset = cursorState.offset % fullMarket.length || 0;
      }

      let part = null;
      if (partsMode) {
        const plan = planPart(stableOrder(fullMarket), partsN, cursorOffset);
        cursorOffset = plan.start;
        sorted = plan.chunk;
        part = plan.part;
      } else {
        let chunk = fullMarket.slice(cursorOffset, cursorOffset + chunkSize);
        if (chunk.length < chunkSize) {
          chunk = chunk.concat(fullMarket.slice(0, chunkSize - chunk.length));
        }
        sorted = chunk;
      }

      coverage = {
        chunkSize,
        totalSymbols: fullMarket.length,
        cyclesToFullCoverage: partsMode ? partsN : Math.ceil(fullMarket.length / chunkSize),
        cursorOffset,
        universe: +universe || universe,
        fullSweep,
        ...(partsMode ? { partsMode: true, parts: partsN, part } : {}),
      };
    } else {
      sorted = fullMarket;
      coverage = {
        chunkSize: fullMarket.length,
        totalSymbols: fullMarket.length,
        cyclesToFullCoverage: 1,
        cursorOffset: 0,
        universe: +universe || universe,
      };
    }
    // ---- scan log (admin → Scan log): per-coin record of this run ----
    const coinLog = [];
    const logMeta = {
      runId: scanRun.id ?? null,
      kind: logKind(source, promotedFromPending),
      source,
      exchange: activeExchange,
      part: coverage?.partsMode ? coverage.part : null,
      parts: coverage?.partsMode ? coverage.parts : null,
      totalSymbols: coverage?.totalSymbols ?? sorted.length,
      planned: sorted.length,
      budgetMs: budgetMs || null,
      startedAt: new Date(startedAt).toISOString(),
    };
    await recordScanStart(logMeta);
    const htf = SIGNAL_CONFIG.htf;
    const obtf = SIGNAL_CONFIG.obTf;
    const entryStyle = SIGNAL_CONFIG.entryStyle;
    // Authoritative settings from dashboard (app_state) — NEW signals only
    let threshold = SIGNAL_CONFIG.minScore;
    let minEntryATR = SIGNAL_CONFIG.minEntryDistanceATR ?? 0.75;
    let maxEntryATR = SIGNAL_CONFIG.maxEntryDistanceATR ?? 4;
    let telegramMaxATR = SIGNAL_CONFIG.telegramMaxDistanceATR ?? 2;
    let maxGapPercent = SIGNAL_CONFIG.maxGapPercent ?? 3;
    let requireHtf = SIGNAL_CONFIG.requireHtfAligned !== false;
    let requireLiq = SIGNAL_CONFIG.requireLiquidityEdge !== false;
    let requireSweepOrFvg = !!SIGNAL_CONFIG.requireSweepOrFvg;
    let strategyMode = 'zone_pattern';
    let smcConfig = { ...RECOMMENDED_SCANNER_SETTINGS.smcConfig };
    let zonePatternConfig = normalizeZonePatternConfig(ZONE_PATTERN_DEFAULTS);
    let doubleConfluenceConfig = normalizeDoubleConfluenceConfig(DOUBLE_CONFLUENCE_DEFAULTS);
    let emaBumpConfig = normalizeEmaBumpConfig(EMA_BUMP_DEFAULTS);
    try {
      const savedMode = await getState('strategy_mode', null);
      if (['chart_pattern', 'smc', 'hybrid', 'ict_confluence', 'zone_pattern', 'double_confluence', 'ema_bump'].includes(savedMode)) strategyMode = savedMode;
      const savedSmcConfig = await getState('smc_config', null);
      if (savedSmcConfig && typeof savedSmcConfig === 'object') smcConfig = savedSmcConfig;
      const savedZonePatternConfig = await getState('zone_pattern_config', null);
      if (savedZonePatternConfig && typeof savedZonePatternConfig === 'object') {
        zonePatternConfig = normalizeZonePatternConfig(savedZonePatternConfig);
      }
      const savedEmaBumpConfig = await getState('ema_bump_config', null);
      if (savedEmaBumpConfig && typeof savedEmaBumpConfig === 'object') {
        emaBumpConfig = normalizeEmaBumpConfig(savedEmaBumpConfig);
      }
      const savedDcConfig = await getState('double_confluence_config', null);
      if (savedDcConfig && typeof savedDcConfig === 'object') {
        doubleConfluenceConfig = normalizeDoubleConfluenceConfig(savedDcConfig);
      }
      const storedScore = await getState('min_score', null);
      if (storedScore != null && Number.isFinite(+storedScore)) {
        const n = Math.round(+storedScore);
        if (n >= 50 && n <= 100) threshold = n;
      }
      const storedAtr = await getState('min_entry_atr', null);
      if (storedAtr != null && Number.isFinite(+storedAtr)) {
        const a = +storedAtr;
        if (a >= 0 && a <= 5) minEntryATR = a;
      }
      const storedMax = await getState('max_entry_atr', null);
      if (storedMax != null && Number.isFinite(+storedMax)) {
        const a = +storedMax;
        if (a > 0 && a <= 20) maxEntryATR = a;
      }
      const storedTg = await getState('telegram_max_atr', null);
      if (storedTg != null && Number.isFinite(+storedTg)) {
        const a = +storedTg;
        if (a > 0 && a <= 20) telegramMaxATR = a;
      }
      const storedGap = await getState('max_gap_percent', null);
      if (storedGap != null && Number.isFinite(+storedGap)) {
        const g = +storedGap;
        if (g > 0 && g <= 50) maxGapPercent = g;
      }
      const sHtf = await getState('require_htf_aligned', null);
      if (sHtf === true || sHtf === false) requireHtf = sHtf;
      const sLiq = await getState('require_liquidity_edge', null);
      if (sLiq === true || sLiq === false) requireLiq = sLiq;
      const sSw = await getState('require_sweep_or_fvg', null);
      if (sSw === true || sSw === false) requireSweepOrFvg = sSw;
    } catch (_) {}
    threshold = Math.round(+threshold);
    if (maxEntryATR < minEntryATR) maxEntryATR = minEntryATR;
    const batchSize = SIGNAL_CONFIG.batchSize;
    const pause = SIGNAL_CONFIG.batchPauseMs;

    // ============================================================
    // JOB B — ACTIVE SIGNAL MONITOR (independent of rotating chunk)
    // Monitors ALL WATCHING / READY / ONGOING every cron run.
    // Price events only — no full SMC rescore.
    // ============================================================
    // only this exchange's signals are priced from this exchange's tickers
    const activeAll = (await getActiveSignals()).filter((x) => signalExchange(x) === activeExchange);
    // WATCHING/READY signals whose levels a rescan may move in place (never ONGOING / closed).
    const siblingPool = activeAll.filter((x) => isUpdatableStatus(x.status));
    const claimedIds = new Set(); // signals already updated / created during this run
    // chunk run of a manual scan: WATCHING/READY stay frozen until the final lifecycle run
    const active =
      lifecycleMode === 'skip' ? activeAll.filter((s) => s.status === SIGNAL_STATUS.ONGOING) : activeAll;
    // Priority: ONGOING (in trade) first, then READY, then WATCHING
    const prio = { ONGOING: 0, READY: 1, WATCHING: 2 };
    const activeList = [...active].sort(
      (a, b) => (prio[a.status] ?? 9) - (prio[b.status] ?? 9)
    );
    for (let i = 0; i < activeList.length; i += batchSize) {
      const batch = activeList.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (sig) => {
          try {
            const ticker = tickers[sig.symbol] || {};
            const price = +ticker.markPrice > 0 ? +ticker.markPrice : +ticker.price;
            const priceSource =
              +ticker.markPrice > 0 ? 'MARK_PRICE' : 'LAST_PRICE_FALLBACK';
            if (!(price > 0) || !Number.isFinite(price)) {
              throw new Error('No current mark or last price returned');
            }
            let atr5m = sig.atr_5m;
            let candleRange = null;
            let closedCandles = null;
            try {
              // includeForming: need live bar high/low for entry/TP/SL touch
              const c5 = await getKlines(sig.symbol, '5m', 30, {
                includeForming: true,
              });
              if (c5?.length) {
                atr5m = calcATR(c5.slice(0, -1), 14) || atr5m; // ATR on closed
                const last = c5[c5.length - 1];
                candleRange = { high: last.high, low: last.low };
              }
              // Pattern / setup TF closed candles for entry confirmation (close beyond → next candle)
              const entryTf =
                sig.metadata?.patternTf ||
                sig.metadata?.setupTf ||
                sig.metadata?.entryTf ||
                '15m';
              const cTf = await getKlines(sig.symbol, entryTf, 40, { includeForming: true });
              if (cTf?.length >= 3) {
                closedCandles = cTf.slice(0, -1);
              } else if (c5?.length >= 3) {
                closedCandles = c5.slice(0, -1);
              }
            } catch (_) {}

            // Entry-time quality re-check when near entry or about to hit
            let qualityCheck = null;
            const st = String(sig.status || '').toUpperCase();
            // Strategy 2 (chart pattern) is a breakout setup — the SMC order-block re-score
            // does not apply to it and would wrongly invalidate valid pattern signals.
            const activeStrategy = sig.metadata?.strategy || sig.strategy;
            const isPatternSig = activeStrategy === 'chart_pattern';
            const isZonePatternSig = activeStrategy === 'zone_pattern';
            const isEmaBumpSig = activeStrategy === 'ema_bump';
            const isBreakoutAtMarketSig = isPatternSig || isZonePatternSig || isEmaBumpSig;
            // ICT signals carry their own sweep/BOS/POI validation; do not apply the
            // legacy OB scorer while they approach entry. Lifecycle price checks still run.
            const isIctSmcSig = (sig.metadata?.strategy || sig.strategy) === 'ict_smc';
            // Near-breakout: enter at market as soon as LIVE price crosses entry (no candle-close wait)
            let nearLiveEntry = false; // never enter on live touch; candle close + next bar
            // --- Near-breakout radar: recheck & promote on candle close ---
            if (
              (sig.metadata?.nearBreakout || sig.metadata?.kind === 'NEAR_BREAKOUT') &&
              (st === 'WATCHING' || st === 'READY')
            ) {
              try {
                let cpCfg = {};
                try {
                  const cpc = await getState('chart_pattern_config', null);
                  if (cpc && typeof cpc === 'object') cpCfg = cpc;
                } catch (_) {}
                nearLiveEntry = cpCfg.nearEntryOnLivePrice !== false;
                const nr = await recheckNearBreakout(sig, price, cpCfg);
                if (nr.action === 'promote' && nr.updates) {
                  const evaluatedAt = new Date();
                  nr.updates.current_price = price;
                  nr.updates.last_price = price;
                  nr.updates.last_checked_at = evaluatedAt.toISOString();
                  nr.updates.last_updated_at = evaluatedAt.toISOString();
                  nr.updates.metadata = {
                    ...(sig.metadata || {}),
                    ...(nr.updates.metadata || {}),
                    liveEvaluation: buildLiveEvaluation(
                      sig, price, priceSource, atr5m, candleRange, null, evaluatedAt
                    ),
                  };
                  await updateSignal(sig.signal_id, nr.updates);
                  signalsUpdated++;
                  try {
                    await createSignalEvent({
                      signal_id: sig.signal_id,
                      event_type: 'BREAKOUT_CONFIRMED',
                      old_status: st,
                      new_status: 'READY',
                      price,
                      message: nr.reason || 'Breakout confirmed',
                    });
                  } catch (_) {}
                  // Let auto-trader see READY on this same scan via later processAutoTrades
                  return;
                }
                if (nr.action === 'invalidate' && nr.updates) {
                  const category = /stale/i.test(nr.reason || '') ? 'Expired' : 'Breakout';
                  const invalidation = nr.invalidation || buildInvalidationRecord({
                    signal: sig,
                    previousStatus: st,
                    category,
                    reasons: [{
                      category,
                      reason: nr.reason || 'Near-breakout validation failed',
                      actual: nr.actual ?? null,
                      required: nr.required ?? null,
                    }],
                    price,
                  });
                  const evaluatedAt = new Date();
                  nr.updates.metadata = {
                    ...(nr.updates.metadata || sig.metadata || {}),
                    invalidation,
                    liveEvaluation: buildLiveEvaluation(
                      sig, price, priceSource, atr5m, candleRange, null, evaluatedAt
                    ),
                  };
                  nr.updates.current_price = price;
                  nr.updates.last_price = price;
                  nr.updates.last_checked_at = evaluatedAt.toISOString();
                  nr.updates.last_updated_at = evaluatedAt.toISOString();
                  await updateSignal(sig.signal_id, nr.updates);
                  await createSignalEvent({
                    signal_id: sig.signal_id,
                    event_type: 'INVALIDATED',
                    old_status: st,
                    new_status: 'INVALIDATED',
                    price,
                    message: invalidation.reason,
                    metadata: { invalidation },
                  });
                  signalsUpdated++;
                  return;
                }
                if (nr.action === 'hold' && nr.updates) {
                  await updateSignal(sig.signal_id, nr.updates);
                  signalsUpdated++;
                  // still run normal proximity updates below with merged state
                  Object.assign(sig, nr.updates);
                }
              } catch (ne) {
                console.warn('[near-recheck]', sig.symbol, ne.message);
              }
            }
            // --- Failed breakout: confirmed READY pattern whose candle closed back inside ---
            if (isPatternSig && st === 'READY' && isConfirmedPatternBreakout(sig)) {
              try {
                let fcfg = {};
                try {
                  const c = await getState('chart_pattern_config', null);
                  if (c && typeof c === 'object') fcfg = c;
                } catch (_) {}
                if (fcfg.failedBreakoutInvalidate !== false) {
                  const tf = sig.metadata?.patternTf || CHART_PATTERN_CONFIG.patternTf || '1h';
                  const pc = await getKlines(sig.symbol, tf, 60);
                  const atrP = calcATR((pc || []).slice(0, -1), 14) || 0;
                  const fb = checkFailedBreakout(sig, pc, {
                    atr: atrP,
                    bufferAtr: fcfg.failedBreakoutBufferATR ?? CHART_PATTERN_CONFIG.failedBreakoutBufferATR ?? 0.5,
                    confirmCandles:
                      fcfg.failedBreakoutConfirmCandles ?? CHART_PATTERN_CONFIG.failedBreakoutConfirmCandles ?? 2,
                  });
                  if (fb.failed) {
                    const dirTxt = (sig.direction || sig.dir) === 'SHORT' ? 'above' : 'below';
                    const how =
                      fb.kind === 'deep'
                        ? `${(+fb.depthAtr).toFixed(2)} ATR back inside (line ${(+fb.atrLine).toFixed(2)} ATR)`
                        : `${fb.closes} closes held back inside`;
                    const reason = `Failed breakout — ${how}, closed ${dirTxt} level ${(+fb.level).toFixed(4)} (close ${(+fb.close).toFixed(4)})`;
                    const invalidation = buildInvalidationRecord({
                      signal: sig,
                      previousStatus: st,
                      category: 'Breakout',
                      reasons: [{ category: 'Breakout', reason, actual: +(+fb.close).toFixed(6), required: `${dirTxt === 'above' ? '≤' : '≥'} ${(+fb.level).toFixed(4)}` }],
                      price,
                    });
                    const evaluatedAt = new Date();
                    await updateSignal(sig.signal_id, {
                      status: SIGNAL_STATUS.INVALIDATED,
                      invalidated_at: invalidation.time,
                      current_price: price,
                      last_price: price,
                      last_checked_at: evaluatedAt.toISOString(),
                      last_updated_at: evaluatedAt.toISOString(),
                      metadata: {
                        ...(sig.metadata || {}),
                        invalidateReason: 'failed_breakout',
                        invalidation,
                        liveEvaluation: buildLiveEvaluation(sig, price, priceSource, atr5m, candleRange, null, evaluatedAt),
                      },
                    });
                    await createSignalEvent({
                      signal_id: sig.signal_id,
                      event_type: 'INVALIDATED',
                      old_status: st,
                      new_status: 'INVALIDATED',
                      price,
                      message: invalidation.reason,
                      metadata: { invalidation },
                    });
                    signalsUpdated++;
                    return;
                  }
                }
              } catch (fe) {
                console.warn('[failed-breakout]', sig.symbol, fe.message);
              }
            }

            // --- Strategy-settings revalidate: WATCHING/READY chart_pattern must pass
            // current HARD gates (RSI div, EMA, HTF, RR, …). Soft fails only score new
            // discoveries; existing open setups are only killed by hard gate failures so
            // an admin strategy update takes effect on the next scan without waiting for
            // price invalidation.
            if (isPatternSig && (st === 'WATCHING' || st === 'READY')) {
              try {
                let cpCfg = {};
                try {
                  const c = await getState('chart_pattern_config', null);
                  if (c && typeof c === 'object') cpCfg = c;
                } catch (_) {}
                const tf = sig.metadata?.patternTf || cpCfg.patternTf || CHART_PATTERN_CONFIG.patternTf || '15m';
                const htfKey =
                  (cpCfg.htfByPatternTf && cpCfg.htfByPatternTf[tf]) ||
                  cpCfg.htf ||
                  CHART_PATTERN_CONFIG.htf ||
                  '1h';
                const limit = Math.max(80, +(cpCfg.patternKlineLimit || CHART_PATTERN_CONFIG.patternKlineLimit || 120));
                const [pc, htfC] = await Promise.all([
                  getKlines(sig.symbol, tf, limit),
                  getKlines(sig.symbol, htfKey, SIGNAL_CONFIG.htfKlineLimit || 80),
                ]);
                const rv = revalidateChartPatternSignal(sig, pc, htfC, cpCfg);
                // Store last check on metadata for UI / audit (even when ok)
                if (rv?.checks) {
                  sig.metadata = {
                    ...(sig.metadata || {}),
                    strategyRevalidate: {
                      at: new Date().toISOString(),
                      ok: rv.ok,
                      reason: rv.reason,
                      checks: rv.checks,
                    },
                  };
                }
                if (rv && rv.ok === false) {
                  const invalidation = buildInvalidationRecord({
                    signal: sig,
                    previousStatus: st,
                    category: 'Strategy',
                    reasons: [{ category: 'Strategy', reason: rv.reason, actual: rv.checks, required: 'pass current hard gates' }],
                    price,
                  });
                  const evaluatedAt = new Date();
                  await updateSignal(sig.signal_id, {
                    status: SIGNAL_STATUS.INVALIDATED,
                    invalidated_at: invalidation.time,
                    current_price: price,
                    last_price: price,
                    last_checked_at: evaluatedAt.toISOString(),
                    last_updated_at: evaluatedAt.toISOString(),
                    metadata: {
                      ...(sig.metadata || {}),
                      invalidateReason: 'strategy_revalidate',
                      strategyRevalidate: { at: evaluatedAt.toISOString(), ok: false, reason: rv.reason, checks: rv.checks },
                      invalidation,
                      liveEvaluation: buildLiveEvaluation(sig, price, priceSource, atr5m, candleRange, null, evaluatedAt),
                    },
                  });
                  await createSignalEvent({
                    signal_id: sig.signal_id,
                    event_type: 'INVALIDATED',
                    old_status: st,
                    new_status: 'INVALIDATED',
                    price,
                    message: invalidation.reason,
                    metadata: { invalidation, strategyRevalidate: rv },
                  });
                  signalsUpdated++;
                  return;
                }
                // When still ok, strategyRevalidate stays on sig.metadata and is
                // written by the normal lifecycle update below.
              } catch (sre) {
                console.warn('[strategy-revalidate]', sig.symbol, sre.message);
              }
            }

            const nearEntry =
              !isBreakoutAtMarketSig && !isIctSmcSig && (st === 'WATCHING' || st === 'READY')
                ? true
                : false;
            if (nearEntry) {
              try {
                // Saved distance is a snapshot. Recalculate with this scan's
                // live price and latest ATR before entry-time decisions.
                const liveProximity = getEntryProximity(sig, price, atr5m, candleRange);
                const atrDist = liveProximity.atrDistance;
                // Only deep-revalidate when close (saves API) or always for READY
                const shouldDeep =
                  st === 'READY' || atrDist <= 1.5 || (sig.proximity_score != null && +sig.proximity_score >= 40);
                if (shouldDeep) {
                  const htf = SIGNAL_CONFIG.htf || '4h';
                  const obtf = SIGNAL_CONFIG.obTf || '1h';
                  const [htfC, obC] = await Promise.all([
                    getKlines(sig.symbol, htf, SIGNAL_CONFIG.htfKlineLimit || 80),
                    getKlines(sig.symbol, obtf, SIGNAL_CONFIG.obKlineLimit || 100),
                  ]);
                  let minScore = SIGNAL_CONFIG.minScore ?? 80;
                  try {
                    const stored = await getState('min_score', null);
                    if (stored != null && +stored >= 50) minScore = +stored;
                  } catch (_) {}
                  qualityCheck = revalidateEntryQuality(sig, htfC, obC, price, {
                    minScore,
                    atr5m,
                  });
                }
              } catch (qe) {
                console.warn('[entry-quality]', sig.symbol, qe.message);
              }
            }

            // If quality already failed while near entry, invalidate without waiting for exact fill
            let qualityForLife = qualityCheck;
            if (
              qualityCheck &&
              qualityCheck.ok === false &&
              (st === 'WATCHING' || st === 'READY')
            ) {
              const liveProximity = getEntryProximity(sig, price, atr5m, candleRange);
              const ad = liveProximity.atrDistance;
              if (ad <= 1.25) {
                qualityForLife = qualityCheck;
                // applyLifecycle only invalidates on entryHit — handle near-entry decay here
                try {
                  const now = new Date().toISOString();
                  const reasons = qualityCheck.failures?.length
                    ? qualityCheck.failures
                    : [{
                        category: 'Entry Quality',
                        reason: qualityCheck.reason || 'Entry quality re-check failed',
                        actual: qualityCheck.reScore ?? null,
                        required: qualityCheck.details?.requiredScore ?? null,
                      }];
                  const invalidation = buildInvalidationRecord({
                    signal: sig,
                    previousStatus: st,
                    category: reasons[0]?.category || 'Entry Quality',
                    reasons,
                    price,
                    at: now,
                  });
                  const evaluatedAt = new Date(now);
                  await updateSignal(sig.signal_id, {
                    status: 'INVALIDATED',
                    invalidated_at: now,
                    last_checked_at: now,
                    last_updated_at: now,
                    current_price: price,
                    last_price: price,
                    distance_to_entry: liveProximity.distanceToEntry,
                    distance_percent: liveProximity.distancePercent,
                    atr_distance: ad,
                    proximity_score: liveProximity.proximityScore,
                    metadata: {
                      ...(sig.metadata || {}),
                      entryQualityFail: qualityCheck.reason,
                      ...(qualityCheck.reScore != null ? { reScoreAtEntry: qualityCheck.reScore } : {}),
                      invalidation,
                      liveEvaluation: buildLiveEvaluation(
                        sig, price, priceSource, atr5m, candleRange, qualityCheck, evaluatedAt
                      ),
                    },
                  });
                  await createSignalEvent({
                    signal_id: sig.signal_id,
                    event_type: 'INVALIDATED',
                    price,
                    old_status: st,
                    new_status: 'INVALIDATED',
                    message: invalidation.reason,
                    metadata: { invalidation },
                  });
                  signalsUpdated++;
                  return;
                } catch (ie) {
                  console.warn('[entry-quality] invalidate', ie.message);
                }
              }
            }

            const { updates, events, notifications } = applyLifecycle(
              sig,
              price,
              atr5m,
              new Date(),
              candleRange,
              qualityForLife,
              { nearLiveEntry, closedCandles }
            );

            updates.metadata = {
              ...(sig.metadata || {}),
              ...(updates.metadata || {}),
              liveEvaluation: buildLiveEvaluation(
                sig, price, priceSource, atr5m, candleRange, qualityCheck
              ),
            };
            if (Object.keys(updates).length) {
              await updateSignal(sig.signal_id, updates);
              signalsUpdated++;
            }
            for (const ev of events) {
              await createSignalEvent({
                signal_id: sig.signal_id,
                event_type: ev.event_type,
                price: ev.price,
                old_status: ev.old_status,
                new_status: ev.new_status,
                message: ev.message,
                metadata: ev.metadata,
              });
            }
            if (notifications.length) {
              const sent = await dispatchNotifications(notifications);
              for (const s of sent) {
                if (s.ok) {
                  const flagMap = {
                    READY: 'ready_notified',
                    ENTRY_HIT: 'entry_notified',
                    TP1: 'tp1_notified',
                    TP2: 'tp2_notified',
                    TP3: 'tp3_notified',
                    SL: 'sl_notified',
                    INVALIDATED: 'invalidated_notified',
                  };
                  const flag = flagMap[s.type];
                  if (flag) await markNotified(sig.signal_id, flag);
                }
              }
            }
          } catch (e) {
            errorCount++;
            errors.push(`${sig.symbol}: ${e.message}`);
          }
        })
      );
      if (pause) await sleep(Math.min(pause, 150));
    }

    // ============================================================
    // JOB A — NEW SIGNAL SCANNER (rotating chunk ONLY)
    // Does NOT analyze all 250 coins. Uses persisted cursor.
    // ============================================================
    let processedCount = 0;
    if (lifecycleMode === 'only') sorted = []; // final status-update run: no discovery
    for (let i = 0; i < sorted.length; i += batchSize) {
      if (getBanUntil() > Date.now() || isRateGuardTripped()) {
        stoppedBy = getBanUntil() > Date.now() ? 'ban' : 'rate_guard';
        timedOutSoft = true;
        break;
      }
      if (timeLeft() < 6000) {
        timedOutSoft = true;
        break;
      }
      const batch = sorted.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (sym) => {
          const symT0 = Date.now();
          const symStat = { created: 0, updated: 0, skipped: [], found: 0, noPrice: false, error: null };
          try {
            const price = tickers[sym]?.price;
            if (!price) {
              symStat.noPrice = true;
              return;
            }

            const [htfC, obC, c5] = await Promise.all([
              strategyMode === 'zone_pattern' || strategyMode === 'ema_bump'
                ? Promise.resolve([])
                : getKlines(sym, htf, SIGNAL_CONFIG.htfKlineLimit || 80),
              strategyMode === 'zone_pattern' || strategyMode === 'ema_bump'
                ? Promise.resolve([])
                : getKlines(sym, obtf, SIGNAL_CONFIG.obKlineLimit || 100),
              getKlines(sym, '5m', SIGNAL_CONFIG.atrKlineLimit || 30),
            ]);
            const atr5m = calcATR(c5, 14);

            // Run only the strategy selected by the admin; hybrid and ICT confluence are explicit.
            const allResults = [];
            let chartPatternCfg = {};

            if (strategyMode === 'zone_pattern') {
              try {
                const getTf = (tf, limit) =>
                  tf === htf && htfC.length
                    ? Promise.resolve(htfC)
                    : tf === obtf && obC.length
                      ? Promise.resolve(obC)
                      : getKlines(sym, tf, limit);
                const [setupCandles, contextCandles, weeklyCandles, dailyCandles] =
                  await Promise.all([
                    getTf(zonePatternConfig.setupTf, zonePatternConfig.setupLookback),
                    getTf(zonePatternConfig.contextTf, zonePatternConfig.contextLookback),
                    getKlines(sym, '1w', zonePatternConfig.weeklyLookback),
                    getKlines(sym, '1d', zonePatternConfig.dailyLookback),
                  ]);
                allResults.push(...runZonePatternStrategy({
                  symbol: sym,
                  setupCandles,
                  contextCandles,
                  weeklyCandles,
                  dailyCandles,
                  price,
                  cfg: zonePatternConfig,
                }));
              } catch (zoneErr) {
                errors.push(`${sym} zone_pattern: ${zoneErr.message}`);
              }
            }

            if (strategyMode === 'ema_bump') {
              try {
                const perTf = await Promise.all(
                  emaBumpConfig.timeframes.map(async (tf) => {
                    try {
                      const candles = await getKlines(sym, tf, emaBumpConfig.lookback);
                      // Phase 1: cheap own-candle detection + gates. HTF candles are only fetched
                      // for coins that already have a candidate (keeps API usage low).
                      let found = runEmaBumpPair({ symbol: sym, price, candles, tf, config: emaBumpConfig });
                      if (found.length && gateMode(emaBumpConfig, 'htf') !== 'off') {
                        const htfCandles = await getKlines(sym, htfFor(tf), 120);
                        found = runEmaBumpPair({ symbol: sym, price, candles, tf, config: emaBumpConfig, htfCandles });
                      }
                      return found;
                    } catch (tfErr) {
                      errors.push(`${sym} ema_bump ${tf}: ${tfErr.message}`);
                      return [];
                    }
                  })
                );
                allResults.push(...perTf.flat());
              } catch (ebErr) {
                errors.push(`${sym} ema_bump: ${ebErr.message}`);
              }
            }

            if (strategyMode === 'double_confluence') {
              try {
                const dcCfg = doubleConfluenceConfig;
                const pairs = resolveTfPairs(dcCfg);
                const getTf = (tf, limit) =>
                  tf === htf && htfC.length
                    ? Promise.resolve(htfC)
                    : tf === obtf && obC.length
                      ? Promise.resolve(obC)
                      : getKlines(sym, tf, limit);
                // Unique TFs needed
                const needed = [...new Set(pairs.flatMap((p) => [p.htf, p.entry]))];
                const candleMap = {};
                await Promise.all(
                  needed.map(async (tf) => {
                    candleMap[tf] = await getTf(tf, tf === pairs[0]?.htf ? dcCfg.htfLookback : dcCfg.entryLookback);
                  })
                );
                const perPair = await Promise.all(
                  pairs.map(async (pair) => {
                    try {
                      return runDoubleConfluencePair({
                        symbol: sym,
                        price,
                        htfCandles: candleMap[pair.htf] || [],
                        entryCandles: candleMap[pair.entry] || [],
                        htf: pair.htf,
                        entryTf: pair.entry,
                        presetId: pair.presetId,
                        presetLabel: pair.label,
                        config: dcCfg,
                      });
                    } catch (pairErr) {
                      errors.push(`${sym} double_confluence ${pair.label}: ${pairErr.message}`);
                      return [];
                    }
                  })
                );
                allResults.push(...perPair.flat());
              } catch (dcErr) {
                errors.push(`${sym} double_confluence: ${dcErr.message}`);
              }
            }

            if (
              strategyMode === 'chart_pattern' ||
              strategyMode === 'hybrid' ||
              strategyMode === 'ict_confluence'
            ) {
              try {
                try {
                  const cpc = await getState('chart_pattern_config', null);
                  if (cpc && typeof cpc === 'object') chartPatternCfg = cpc;
                } catch (_) {}
                const ALLOWED_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '1d'];
                let tfs = Array.isArray(chartPatternCfg.patternTfs) && chartPatternCfg.patternTfs.length
                  ? chartPatternCfg.patternTfs
                  : (CHART_PATTERN_CONFIG.patternTfs || [chartPatternCfg.patternTf || '15m']);
                tfs = tfs.filter((t) => ALLOWED_TFS.includes(t));
                if (!tfs.length) tfs = ['15m'];
                const htfMap = { ...CHART_PATTERN_CONFIG.htfByPatternTf, ...(chartPatternCfg.htfByPatternTf || {}) };
                const limit = chartPatternCfg.patternKlineLimit || 120;

                // every selected timeframe is scanned in parallel for this symbol
                const perTf = await Promise.all(
                  tfs.map(async (tf) => {
                    try {
                      const patternC = await getKlines(sym, tf, limit);
                      const htfTf = htfMap[tf] || '1h';
                      const htfCandles = htfTf === '4h' ? htfC : htfTf === '1h' ? obC : await getKlines(sym, htfTf, 80);
                      const { setups, near } = runChartPatternStrategy({
                        symbol: sym,
                        patternCandles: patternC,
                        htfCandles,
                        entryCandles: c5,
                        price,
                        // Persist near-breakouts on both manual + cron so refresh still shows them
                        includeNear: strategyMode !== 'ict_confluence',
                        cfg: { ...chartPatternCfg, patternTf: tf, htf: htfTf },
                      });
                      if (strategyMode !== 'ict_confluence') {
                        for (const n of near || []) nearBreakouts.push(n);
                      }
                      return setups;
                    } catch (tfErr) {
                      errors.push(`${sym} ${tf}: ${tfErr.message}`);
                      return [];
                    }
                  })
                );
                const cpSetups = perTf.flat();
                for (const r of cpSetups) {
                  allResults.push(r);
                }
              } catch (cpErr) {
                errors.push(`${sym} chart_pattern: ${cpErr.message}`);
              }
            }

            if (
              strategyMode === 'smc' ||
              strategyMode === 'hybrid' ||
              strategyMode === 'ict_confluence'
            ) {
              try {
                const setupTf = ['5m', '15m', '30m'].includes(smcConfig.setupTf)
                  ? smcConfig.setupTf
                  : '15m';
                const smcHtf = ['1h', '2h', '4h'].includes(smcConfig.htfTf)
                  ? smcConfig.htfTf
                  : '1h';
                const [setupCandles, smcHtfCandles] = await Promise.all([
                  setupTf === obtf ? Promise.resolve(obC) : getKlines(sym, setupTf, 120),
                  smcHtf === htf
                    ? Promise.resolve(htfC)
                    : smcHtf === obtf
                      ? Promise.resolve(obC)
                      : getKlines(sym, smcHtf, 80),
                ]);
                allResults.push(...runIctSmcStrategy({
                  symbol: sym,
                  setupCandles,
                  htfCandles: smcHtfCandles,
                  price,
                  cfg: smcConfig,
                  setupTf,
                  htfTf: smcHtf,
                }));
              } catch (smcErr) {
                errors.push(`${sym} ict_smc: ${smcErr.message}`);
              }
            }

            const qualifiedResults = strategyMode === 'ict_confluence'
              ? requireIctPatternConfluence(allResults)
              : allResults;
            symStat.found = qualifiedResults.length;
            const idOf = (r) =>
              buildSignalId(
                  r.symbol,
                  r.dir,
                (r.strategy === 'chart_pattern'
                    ? `CP_${r.pattern || 'PAT'}_${r.metadata?.patternTf && r.metadata.patternTf !== '15m' ? r.metadata.patternTf + '_' : ''}`
                    : r.strategy === 'ict_smc'
                      ? `${strategyMode === 'ict_confluence' ? 'ICTCP' : 'ICT'}_${r.metadata?.patternTf || '15m'}_`
                    : r.strategy === 'zone_pattern'
                      ? `ZP_${r.pattern || 'PAT'}_${r.metadata?.setupTf || '15m'}_`
                    : r.strategy === 'double_confluence'
                      ? `DC_${r.metadata?.pattern?.type || r.pattern || 'DBL'}_${r.metadata?.entryTf || '15m'}_`
                    : r.strategy === 'ema_bump'
                      ? `EB_${r.metadata?.patternTf || '15m'}_`
                    : '') +
                    String(r.ob?.time || r.metadata?.breakoutLevel || r.metadata?.harmonic?.D?.time || ''),
                  r.entry,
                  activeExchange
                );
            // ids of every result found for this coin in this run: an exact-id signal must never be
            // 'stolen' as the sibling of a different result
            const reservedIds = new Set(qualifiedResults.map((x) => idOf(x)));
            for (const r of qualifiedResults) {
              const signalId = idOf(r);

              // ATR-based proximity (not fixed %)
              const prox = getEntryProximity(
                {
                  entry: r.entry,
                  sl: r.sl,
                  direction: r.dir,
                  ob_high: r.ob?.high,
                  ob_low: r.ob?.low,
                  ob: r.ob,
                  strategy: r.strategy,
                  metadata: r.metadata,
                },
                price,
                atr5m
              );

              // ============================================================
              // FINAL NEW-SIGNAL QUALIFICATION
              // SMC = limit-order filters; Chart pattern = breakout-at-market
              // ============================================================
              const scoreNum = Math.round(+r.score);
              const q = r.quality || {};
              const isChart = r.strategy === 'chart_pattern';
              const isIctSmc = r.strategy === 'ict_smc';
              const isZonePattern = r.strategy === 'zone_pattern';
              const isDoubleConfluence = r.strategy === 'double_confluence';
              const isEmaBump = r.strategy === 'ema_bump';

              let atrVal = (prox.atr5m > 0 ? prox.atr5m : atr5m) || 0;
              let distAbs = Math.abs(+price - +r.entry);
              let atrDistUnits = atrVal > 0 ? distAbs / atrVal : prox.atrDistance;
              let gapPct = +r.entry ? (distAbs / +r.entry) * 100 : prox.distancePercent;

              if (isEmaBump) {
                // Dedicated qualification: own score floor, RR floor and entry distance (in the
                // setup TF's ATR, not 5m ATR). Legacy SMC gates do not apply.
                if (!Number.isFinite(scoreNum) || scoreNum < emaBumpConfig.minScore) continue;
                if (r.rr == null || r.rr === '—' || !Number.isFinite(+r.rr) || +r.rr < emaBumpConfig.minRR) continue;
                const riskAbs = Math.abs(+r.entry - +r.sl);
                if (!Number.isFinite(riskAbs) || riskAbs <= 0) continue;
                const ebClass = classifyNewSignalEntry(
                  { entry: r.entry, sl: r.sl, tp1: r.tp1, direction: r.dir, dir: r.dir },
                  price,
                  r.atr || atr5m || atrVal,
                );
                if (!ebClass.accept) continue; // TP1 already hit — missed
                if (ebClass.entryMode === 'RETEST') {
                  r.metadata = {
                    ...(r.metadata || {}),
                    entryMode: 'RETEST',
                    retestWatching: true,
                    entryClassReason: ebClass.reason,
                  };
                }
                const tfAtr = +r.atr > 0 ? +r.atr : atrVal;
                atrDistUnits = tfAtr > 0 ? distAbs / tfAtr : atrDistUnits;
                if (emaBumpConfig.maxEntryDistanceATR > 0 && atrDistUnits > emaBumpConfig.maxEntryDistanceATR) continue;
              } else if (isDoubleConfluence) {
                const dcMin14 = doubleConfluenceConfig.minScore ?? 8;
                const dcMin100 = Math.round((dcMin14 / 14) * 100);
                const confScore = r.confluenceScore != null ? +r.confluenceScore : null;
                if (confScore != null) {
                  if (confScore < dcMin14) continue;
                } else if (!Number.isFinite(scoreNum) || scoreNum < dcMin100) {
                  continue;
                }
                if (r.rr == null || r.rr === '—' || +r.rr < (doubleConfluenceConfig.minRR ?? 1.2)) continue;
                const riskAbs = Math.abs(+r.entry - +r.sl);
                if (!Number.isFinite(riskAbs) || riskAbs <= 0) continue;
                atrDistUnits = Math.min(atrDistUnits, 3.5);
                gapPct = Math.min(gapPct, 5);
              } else if (isZonePattern) {
                // Dedicated qualification: no legacy score, HTF, liquidity, entry-distance,
                // gap, displacement, or old global RR gates apply to this mode.
                if (!Number.isFinite(scoreNum) || scoreNum < zonePatternConfig.minSignalScore) continue;
                if (
                  !q.zoneConfluence ||
                  !q.patternAtZone ||
                  !q.localStructureBreak ||
                  !r.metadata?.breakoutConfirmed
                ) continue;
                if (r.rr == null || r.rr === '—' || +r.rr < zonePatternConfig.minRR) continue;
                const riskAbs = Math.abs(+r.entry - +r.sl);
                if (!Number.isFinite(riskAbs) || riskAbs <= 0) continue;
                if (+r.metadata?.riskATR > zonePatternConfig.maxStopATR) continue;
                if (+r.metadata?.chaseATR > zonePatternConfig.maxChaseATR) continue;
                atrDistUnits = 0.2;
                gapPct = 0;
                distAbs = Math.abs(+price - +r.entry);
              } else if (!isChart) {
                if (!Number.isFinite(scoreNum) || scoreNum < threshold) continue;

                if (requireHtf && q.htfAligned === false) continue;
                if (requireLiq && q.hasLiqEdge === false && q.hasSweep === false) continue;
                if (requireSweepOrFvg && !q.hasSweep && !q.hasFvg) continue;
                if (
                  SIGNAL_CONFIG.requireDisplacementOrOte &&
                  !q.displacement &&
                  !q.fibOte &&
                  !q.rsiDiv
                )
                  continue;
                if (SIGNAL_CONFIG.requireStrongSetup && !q.strongSetup) continue;

                if (!isIctSmc) {
                  try {
                    const discQ = revalidateEntryQuality(
                      {
                        symbol: r.symbol,
                        direction: r.dir,
                        entry: r.entry,
                        sl: r.sl,
                        tp1: r.tp1,
                        score: scoreNum,
                        ob_low: r.ob?.low,
                        ob_high: r.ob?.high,
                        atr_5m: atr5m,
                      },
                      htfC,
                      obC,
                      price,
                      { minScore: threshold, atr5m, scoreDropTolerance: 100 }
                    );
                    if (!discQ.ok) continue;
                  } catch (_) {}
                }

                // Do not create new limit-order signals after their entry was already reached.
                // Existing READY ICT signals transition to ONGOING through the lifecycle monitor.
                if (prox.entryHit) continue;
                const limClass = classifyNewSignalEntry(
                  { entry: r.entry, sl: r.sl, tp1: r.tp1, direction: r.dir, dir: r.dir },
                  price,
                  atr5m || atrVal,
                );
                if (!limClass.accept) continue; // TP1 already hit
                if (limClass.entryMode === 'RETEST') {
                  r.metadata = {
                    ...(r.metadata || {}),
                    entryMode: 'RETEST',
                    retestWatching: true,
                    entryClassReason: limClass.reason,
                  };
                }

                const riskAbs = Math.abs(+r.entry - +r.sl);
                const riskPct = +r.entry ? (riskAbs / +r.entry) * 100 : 0;
                if (isIctSmc) {
                  const setupAtr = +r.metadata?.ictAnalysis?.atr || 0;
                  if (!riskAbs || riskPct < 0.05 || (setupAtr > 0 && riskAbs < setupAtr * 0.12)) continue;
                  if (setupAtr > 0 && distAbs > setupAtr * 3.5) continue;
                } else {
                  const minRiskPct = SIGNAL_CONFIG.minRiskPercent ?? 1.0;
                  if (!riskAbs || riskPct < Math.max(0.05, minRiskPct)) continue;
                  const minRiskAtr = SIGNAL_CONFIG.minRiskATR ?? 0.6;
                  if (atrVal > 0 && riskAbs < atrVal * minRiskAtr) continue;
                }
                if (r.rr == null || r.rr === '—' || +r.rr < 1.2) continue;

                const minDist = atrVal * minEntryATR;
                if (!isIctSmc && minEntryATR > 0 && distAbs < minDist) continue;
                const maxDist = atrVal * maxEntryATR;
                if (!isIctSmc && maxEntryATR > 0 && atrVal > 0 && distAbs > maxDist) continue;
                if (maxGapPercent > 0 && gapPct > maxGapPercent) continue;
              } else {
                // Chart pattern: breakout already validated in strategy module
                if (!r.metadata?.breakoutConfirmed && !q.breakoutConfirmed) continue;
                // TP1 already hit at scan → skip (invalid)
                const scanClass = classifyNewSignalEntry(
                  { entry: r.entry, sl: r.sl, tp1: r.tp1, direction: r.dir, dir: r.dir },
                  price,
                  atr5m || atrVal,
                );
                if (!scanClass.accept) continue;
                if (scanClass.entryMode === 'RETEST') {
                  r.metadata = {
                    ...(r.metadata || {}),
                    entryMode: 'RETEST',
                    retestWatching: true,
                    entryClassReason: scanClass.reason,
                  };
                }
                // TP1 RR floor for chart patterns = 1.0 (config.minTp1RR); small epsilon avoids 0.9999 float misses
                // (TP1 RR is already gated HARD/SOFT inside the strategy; here only guard bad data)
                if (r.rr == null || r.rr === '—' || !Number.isFinite(+r.rr)) continue;
                const riskAbs = Math.abs(+r.entry - +r.sl);
                if (!riskAbs) continue;
                // At-market breakout → treat as CLOSE/READY for Telegram
                atrDistUnits = 0.2;
                gapPct = 0;
                distAbs = Math.abs(+price - +r.entry);
              }

                            const closeLabel =
                atrDistUnits <= 0.3
                  ? 'VERY CLOSE'
                  : atrDistUnits <= 0.5
                    ? 'CLOSE'
                    : atrDistUnits <= 1.0
                      ? 'NEAR'
                      : 'FAR';

              const live = {
                signal_id: signalId,
                symbol: r.symbol,
                direction: r.dir,
                status: isChart || isZonePattern || isEmaBump
                  ? 'READY'
                  : isDoubleConfluence
                    ? (r.suggestedStatus === 'READY' || prox.isReady ? 'READY' : 'WATCHING')
                    : prox.isReady ? 'READY' : 'WATCHING',
                score: scoreNum,
                entry: r.entry,
                sl: r.sl,
                tp1: r.tp1,
                tp2: r.tp2,
                tp3: r.tp3,
                rr: r.rr,
                current_price: price,
                price,
                conf: r.conf || [],
                structure: r.structure,
                pd: r.pd,
                rvol: r.rvol,
                fvgs: r.fvgs,
                liq: r.liq,
                metadata: {
                  conf: r.conf,
                  structure: r.structure,
                  ob: r.ob,
                  pd: r.pd,
                  rvol: r.rvol,
                  fvgs: r.fvgs,
                  liq: r.liq,
                  htf: isZonePattern ? zonePatternConfig.contextTf : SIGNAL_CONFIG.htf,
                  obTf: isZonePattern ? zonePatternConfig.setupTf : SIGNAL_CONFIG.obTf,
                  entryStyle: SIGNAL_CONFIG.entryStyle,
                  minScore: isZonePattern ? zonePatternConfig.minSignalScore : threshold,
                  minEntryDistanceATR: isZonePattern ? null : minEntryATR,
                  maxEntryDistanceATR: isZonePattern ? null : maxEntryATR,
                  entryDistanceATR: atrDistUnits,
                  maxGapPercent: isZonePattern ? null : maxGapPercent,
                  gapPercent: gapPct,
                  strategy: r.strategy || 'existing_smc',
                  pattern: r.pattern || r.metadata?.pattern || null,
                  breakoutLevel: r.metadata?.breakoutLevel ?? null,
                  breakoutConfirmed: r.metadata?.breakoutConfirmed ?? null,
                  ...(r.metadata || {}),
                  minScoreAtCreate: isZonePattern
                    ? zonePatternConfig.minSignalScore
                    : isChart
                      ? (chartPatternCfg.minSignalScore ?? 70)
                      : threshold,
                  minRrAtEntry: isZonePattern
                    ? zonePatternConfig.minRR
                    : isChart
                      ? (chartPatternCfg.minTp1RR ?? 1.0)
                      : 1.2,
                  minRR: isZonePattern
                    ? zonePatternConfig.minRR
                    : isChart
                      ? (chartPatternCfg.minRR ?? 1.2)
                      : 1.2,
                  entryDistanceATR: atrDistUnits,
                  gapPercent: gapPct,
                  fib: r.fib ?? r.metadata?.fib,
                  quality: r.quality ?? r.metadata?.quality,
                  rejection: r.rejection ?? r.metadata?.rejection,
                  elliottWave: r.elliottWave ?? r.metadata?.elliottWave,
                  universal: r.universal ?? r.metadata?.universal,
                },
                strategy: r.strategy || 'existing_smc',
                pattern: r.pattern || null,
                ob_low: r.ob?.low,
                ob_high: r.ob?.high,
                atr_5m: atrVal,
                distance_to_entry: distAbs,
                distance_percent: prox.distancePercent,
                atr_distance: atrDistUnits,
                proximity_score: prox.proximityScore,
                ready_threshold: prox.readyThreshold,
                ready_threshold_atr: prox.readyThresholdATR,
                is_close: isChart || isZonePattern || isEmaBump ? true : prox.isReady,
                close_label: isChart || isZonePattern ? 'BREAKOUT' : isEmaBump ? closeLabel : closeLabel,
                last_updated_at: new Date().toISOString(),
              };
              createdSummaries.push(live);

              console.log('[SIGNAL_DB] detected', JSON.stringify({
                signal_id: signalId, symbol: r.symbol, status: live.status, operation: 'detected',
              }));
              if (SIGNAL_CONFIG.persistSignals) {
                // ---- 1) PERSIST FIRST (database is the source of truth) ----
                let record = null;
                let persistOp = null;
                try {
                  record = buildNewSignalRecord(
                    { ...r, price, score: scoreNum },
                    signalId,
                    atrVal
                  );
                  let skipReason = null;
                  if (isZonePattern) record.status = SIGNAL_STATUS.READY;
                  if (isEmaBump) {
                    record.status = SIGNAL_STATUS.READY;
                    record.ready_at = record.ready_at || new Date().toISOString();
                    record.atr_distance = atrDistUnits;
                  }
                  if (isDoubleConfluence && r.suggestedStatus === 'READY') {
                    record.status = SIGNAL_STATUS.READY;
                    record.ready_at = record.ready_at || new Date().toISOString();
                  }
                  if (record.status === SIGNAL_STATUS.ONGOING) skipReason = 'already ONGOING at birth';
                  else if (
                    r.strategy !== 'chart_pattern' &&
                    r.strategy !== 'zone_pattern' &&
                    r.strategy !== 'double_confluence' &&
                    r.strategy !== 'ema_bump' &&
                    Math.round(+record.score) < threshold
                  ) {
                    skipReason = 'below min score';
                  }
                  else if (
                    r.strategy === 'ema_bump' &&
                    Math.round(+record.score) < emaBumpConfig.minScore
                  ) {
                    skipReason = 'below ema_bump min score';
                  }
                  else if (
                    r.strategy === 'double_confluence' &&
                    Math.round(+record.score) < Math.round(((doubleConfluenceConfig.minScore ?? 8) / 14) * 100)
                  ) {
                    skipReason = 'below double_confluence min score';
                  }
                  if (skipReason) {
                    symStat.skipped.push(skipReason);
                    live.persisted = false;
                    live.persist_error = skipReason;
                    console.log('[SIGNAL_DB] skipped', JSON.stringify({
                      signal_id: signalId, symbol: r.symbol, status: record.status, operation: 'skip', reason: skipReason,
                    }));
                    continue;
                  }
                  // Chart pattern breakouts are at-market → always READY in DB
                  if (isChart || isZonePattern) {
                    record.status = SIGNAL_STATUS.READY;
                    record.ready_at = record.ready_at || new Date().toISOString();
                    record.atr_distance = atrDistUnits;
                    record.distance_percent = gapPct;
                    record.proximity_score = 90;
                  }
                  // Tag strategy on persisted record
                  if (r.strategy) {
                    record.metadata = {
                      ...(record.metadata || {}),
                      strategy: r.strategy,
                      pattern: r.pattern || r.metadata?.pattern || null,
                      breakoutLevel: r.metadata?.breakoutLevel ?? null,
                      breakoutConfirmed: r.metadata?.breakoutConfirmed ?? null,
                      conf: r.conf || record.metadata?.conf,
                      // Strategy 2: keep the drawn-pattern geometry + its own timeframes for the Telegram chart
                      ...(r.strategy === 'chart_pattern'
                        ? {
                            patternGeom: r.metadata?.patternGeom ?? null,
                            patternTf: r.metadata?.patternTf ?? null,
                            htf: r.metadata?.htf ?? null,
                            obTf: r.metadata?.obTf ?? null,
                            rvol: r.metadata?.rvol ?? record.metadata?.rvol,
                            rrMeasured: r.metadata?.rrMeasured ?? null,
                          }
                        : {}),
                    };
                  }
                  const excludeIds = new Set([...reservedIds, ...claimedIds]);
                  excludeIds.delete(signalId);
                  const saved = await upsertSignal(record, { siblingPool, excludeIds });
                  persistOp = saved.operation;
                  live.persisted = true;
                  live.persist_operation = persistOp;
                  live.status = saved.data?.status || record.status;
                  // Canonical id: when an existing signal was updated in place its id differs
                  // from the freshly computed one (entry is part of the id).
                  const canonicalId = saved.data?.signal_id || saved.replacedSignalId || signalId;
                  live.signal_id = canonicalId;
                  claimedIds.add(canonicalId);
                  if (saved.replacedSignalId) {
                    live.replaced_signal_id = saved.replacedSignalId;
                    live.levels_changed = !!saved.levelsChanged;
                  }
                  if (persistOp === 'inserted') {
                    signalsCreated++;
                    symStat.created++;
                    if (saved.data && isUpdatableStatus(saved.data.status)) siblingPool.push(saved.data);
                  } else {
                    signalsUpdated++;
                    symStat.updated++;
                  }
                } catch (pe) {
                  // Persistence failed: surface it, never pretend it was saved.
                  live.persisted = false;
                  live.persist_error = pe.message;
                  errorCount++;
                  errors.push(`persist ${r.symbol}: ${pe.message}`);
                  console.error('[SIGNAL_DB] Supabase error', JSON.stringify({
                    signal_id: signalId, symbol: r.symbol, status: record?.status, operation: 'persist', error: pe.message,
                  }));
                  continue; // no event / notification for a signal that is not in the DB
                }

                // ---- 2) Event log (failure must not undo persistence) ----
                if (persistOp === 'inserted') {
                  try {
                    await createSignalEvent({
                      signal_id: signalId,
                      event_type: 'SIGNAL_CREATED',
                      price,
                      old_status: null,
                      new_status: record.status,
                      message: `Created score ${scoreNum} distATR=${atrDistUnits.toFixed(2)} (min ${minEntryATR})`,
                    });
                  } catch (ee) {
                    errors.push(`event ${r.symbol}: ${ee.message}`);
                  }
                }

                // ---- 3) Notification AFTER persistence; failure never affects the saved row ----
                // Far setups are stored silently; lifecycle sends READY later.
                if (persistOp === 'inserted' && atrDistUnits <= telegramMaxATR) {
                  try {
                    const sent = await dispatchNotifications([
                      {
                        type: 'READY',
                        signal: {
                          ...record,
                          current_price: price,
                          atr_distance: atrDistUnits,
                          distance_to_entry: distAbs,
                          distance_percent: prox.distancePercent,
                          close_label: closeLabel,
                        },
                      },
                    ]);
                    if (sent[0]?.ok) {
                      telegramSent++;
                      try {
                        await updateSignal(signalId, { ready_notified: true });
                      } catch (_) {}
                    }
                  } catch (te) {
                    errors.push(`telegram ${r.symbol}: ${te.message}`);
                  }
                }
              }
            }
            symbolsScanned++;
          } catch (e) {
            errorCount++;
            symStat.error = e.message;
            errors.push(`${sym}: ${e.message}`);
          } finally {
            processedCount++;
            try {
              const symErrs = errors.filter((x) => x.startsWith(`${sym} `) || x.startsWith(`${sym}:`));
              const errText = symStat.error || symErrs[0] || null;
              coinLog.push({
                s: sym,
                r: classifyCoin({
                  noPrice: symStat.noPrice,
                  error: errText,
                  created: symStat.created,
                  updated: symStat.updated,
                  skipped: symStat.skipped.length,
                  found: symStat.found,
                }),
                ms: Date.now() - symT0,
                price: tickers[sym]?.price ?? null,
                f: symStat.found,
                c: symStat.created,
                u: symStat.updated,
                sk: symStat.skipped.slice(0, 3),
                e: errText ? String(errText).slice(0, 160) : null,
              });
            } catch (_) {}
          }
        })
      );
      if (pause) await sleep(Math.min(pause, 100));
    }

    // Advance the rotating cursor only by what was actually processed, so
    // a soft-timeout resumes from the right place next time instead of
    // skipping the symbols it didn't get to.
    if (usingCursor) {
      const nextOffset = partsMode
        ? nextPartOffset(cursorOffset, processedCount, fullMarket.length)
        : (cursorOffset + processedCount) % fullMarket.length;
      await setState(cursorKey, {
        offset: nextOffset,
        universe: cursorUniverse,
      });
      if (coverage) {
        coverage.symbolsThisRun = processedCount;
        coverage.nextOffset = nextOffset;
      }
    }

    // Telegram for CLOSE-TO-ENTRY setups found this run (limit-order alerts).
    // Works for newly created AND existing signals that were never notified.
    if (createdSummaries.length) {
      const maxAtr = telegramMaxATR;
      const maxN = SIGNAL_CONFIG.telegramLiveMaxPerScan ?? 5;
      const closeOnes = createdSummaries
        .filter(
          (s) =>
            s.persisted !== false && // never alert on a signal that is not in the DB
            s.atr_distance != null && s.atr_distance <= maxAtr
        )
        .sort((a, b) => (a.atr_distance ?? 99) - (b.atr_distance ?? 99))
        .slice(0, maxN);

      for (const s of closeOnes) {
        try {
          let already = false;
          if (s.signal_id && SIGNAL_CONFIG.persistSignals) {
            const row = await getSignalById(s.signal_id);
            if (row?.ready_notified) already = true;
          }
          if (already) continue;

          const sent = await dispatchNotifications([
            { type: 'READY', signal: s },
          ]);
          if (sent[0]?.ok) {
            telegramSent++;
            if (s.signal_id && SIGNAL_CONFIG.persistSignals) {
              await updateSignal(s.signal_id, { ready_notified: true });
            }
          } else if (sent[0]?.skipped) {
            errors.push('telegram not configured (set TELEGRAM_BOT_TOKEN + CHAT_ID)');
            break;
          } else if (sent[0]?.error) {
            errors.push(
              `telegram ${s.symbol}: ${String(JSON.stringify(sent[0].error)).slice(0, 120)}`
            );
            errorCount++;
          }
        } catch (e) {
          errors.push(`telegram ${s.symbol}: ${e.message}`);
          errorCount++;
        }
      }
    }

    // Counts — live mode: from this scan only
    let watching_count = 0;
    let ready_count = 0;
    let ongoing_count = 0;
    if (SIGNAL_CONFIG.persistSignals && !SIGNAL_CONFIG.skipLifecycle) {
      const afterActive = (await getActiveSignals()).filter((x) => signalExchange(x) === activeExchange);
      watching_count = afterActive.filter((s) => s.status === SIGNAL_STATUS.WATCHING).length;
      ready_count = afterActive.filter((s) => s.status === SIGNAL_STATUS.READY).length;
      ongoing_count = afterActive.filter((s) => s.status === SIGNAL_STATUS.ONGOING).length;
    } else {
      ready_count = createdSummaries.length;
    }

    await completeScanRun(scanRun.id, {
      symbols_scanned: symbolsScanned,
      signals_created: signalsCreated,
      signals_updated: signalsUpdated,
      ready_count,
      ongoing_count,
      watching_count,
      error_count: errorCount,
      error_message: errors.length ? errors.slice(0, 20).join('; ') : null,
      metadata: {
        totalSymbols: sorted.length,
        coverage,
        timedOutSoft,
        errors: errors.slice(0, 50),
      },
    });

    await recordScanFinish(
      {
        ...logMeta,
        strategy: strategyMode,
        status: stoppedBy === 'ban' ? 'BANNED' : stoppedBy === 'rate_guard' ? 'THROTTLED' : timedOutSoft ? 'PARTIAL' : 'COMPLETED',
        stoppedBy,
        banUntil: stoppedBy === 'ban' ? getBanUntil() : null,
        partial: timedOutSoft,
        durationMs: Date.now() - startedAt,
        created: signalsCreated,
        updated: signalsUpdated,
        errorCount,
        errors: errors.slice(0, 20),
        telegramSent,
      },
      coinLog,
      sorted.slice(processedCount)
    );

    await releaseScanLock();

    // Stamp full-scan schedule when this run was a real full discovery
    if (isFullSource || promotedFromPending) {
      try {
        const { setState } = await import('../database/appState.js');
        const nowIso = new Date().toISOString();
        await setState('last_full_scan_at', nowIso);
        const intervalMin = Math.max(1, +(await (await import('../database/appState.js')).getState('full_scan_interval_minutes', 5)) || 5);
        await setState('next_full_scan_at', new Date(Date.now() + intervalMin * 60000).toISOString());
        await setState('pending_full_scan', null);
      } catch (_) {}
    }

    // Single editable Telegram Live Board (no per-scan spam)
    try {
      const { upsertLiveBoard, getLiveBoardEvents } = await import('../telegram/liveBoard.js');
      const events = await getLiveBoardEvents();
      await upsertLiveBoard(
        {
          symbolsScanned,
          signalsCreated,
          signalsUpdated,
          watching: watching_count,
          ready: ready_count,
          ongoing: ongoing_count,
        },
        events
      );
    } catch (lbErr) {
      console.warn('[scanner] live board', lbErr.message);
    }

    // Cron / external services (cron-job.org) abort on large bodies.
    // Always return a tiny summary for cron; full payload only for manual/UI.
    if (source === 'cron') {
      return {
        ok: true,
        partial: timedOutSoft,
        scanRunId: scanRun.id,
        symbolsScanned,
        signalsCreated,
        signalsUpdated,
        watching: watching_count,
        ready: ready_count,
        ongoing: ongoing_count,
        telegramSent,
        errorCount,
        msg: `${activeExchange}: scanned ${symbolsScanned}, created ${signalsCreated}, updated ${signalsUpdated}, tg ${telegramSent}`,
      };
    }

    // Persist near-breakouts as WATCHING so UI refresh still shows them
    let nearPersisted = 0;
    let nearPersistFailed = 0;
    if (nearBreakouts.length) {
      for (const n of nearBreakouts) {
        try {
          const res = await persistNearBreakout(n, null);
          if (res.created || res.updated) nearPersisted++;
          if (res.created) signalsCreated++;
          if (!res.ok && res.reason) {
            // terminal / already confirmed — not an error
          }
        } catch (e) {
          nearPersistFailed++;
          errors.push(`persist near ${n.symbol}: ${e.message}`);
          errorCount++;
          console.error('[persistNear]', n.symbol, n.signal_id, e.message);
        }
      }
    }

    // Telegram: ABOUT TO BREAK OUT (near-breakout radar) — same labels as UI
    if (nearBreakouts.length) {
      const maxNear = SIGNAL_CONFIG.telegramNearMaxPerScan ?? 5;
      const sortedNear = [...nearBreakouts]
        .filter((n) => n && n.symbol)
        .sort((a, b) => (a.gapAtr ?? 99) - (b.gapAtr ?? 99))
        .slice(0, maxNear);
      let nearNotified = {};
      try {
        nearNotified = (await getState('near_tg_notified', null)) || {};
        if (typeof nearNotified !== 'object') nearNotified = {};
      } catch (_) {
        nearNotified = {};
      }
      const nowMs = Date.now();
      // prune entries older than 2h
      for (const [k, ts] of Object.entries(nearNotified)) {
        if (!ts || nowMs - ts > 2 * 3600 * 1000) delete nearNotified[k];
      }
      for (const n of sortedNear) {
        try {
          const id = n.signal_id || `${n.symbol}_${n.pattern}_${n.patternTf}_${n.direction}`;
          if (nearNotified[id] && nowMs - nearNotified[id] < 30 * 60 * 1000) continue; // 30m dedupe
          const sent = await dispatchNotifications([
            { type: 'NEAR_BREAKOUT', signal: n, near: n },
          ]);
          if (sent[0]?.ok) {
            telegramSent++;
            nearNotified[id] = nowMs;
          } else if (sent[0]?.skipped) {
            break;
          }
        } catch (e) {
          errors.push(`telegram near ${n.symbol}: ${e.message}`);
          errorCount++;
        }
      }
      try {
        await setState('near_tg_notified', nearNotified);
      } catch (_) {}
    }

    console.log('[SIGNAL_DB] scan persistence summary', JSON.stringify({
      scanRunId: scanRun.id,
      detected: createdSummaries.length,
      saved: createdSummaries.filter((signal) => signal.persisted === true).length,
      inserted: createdSummaries.filter((signal) => signal.persist_operation === 'inserted').length,
      updated: createdSummaries.filter((signal) => signal.persist_operation === 'updated').length,
      failed: createdSummaries.filter((signal) => signal.persisted === false).length,
      nearBreakoutsSaved: nearPersisted,
    }));

    return {
      ok: true,
      partial: timedOutSoft,
      scanRunId: scanRun.id,
      symbolsScanned,
      signalsCreated,
      signalsUpdated,
      watching_count,
      ready_count,
      ongoing_count,
      errorCount,
      coverage,
      created: createdSummaries,
      liveSignals: createdSummaries,
      signalsPersisted: createdSummaries.filter((x) => x.persisted).length,
      signalsNotPersisted: createdSummaries.filter((x) => x.persisted === false).length,
      nearBreakouts,
      nearPersisted,
      nearPersistFailed,
      telegramSent,
    };
  } catch (e) {
    await recordScanFailure(
      {
        runId: scanRun.id ?? null,
        kind: logKind(source, promotedFromPending),
        source,
        exchange: options.exchange || 'binance',
        durationMs: Date.now() - startedAt,
        startedAt: new Date(startedAt).toISOString(),
      },
      e.message
    );
    await completeScanRun(scanRun.id, {
      status: 'FAILED',
      error_message: e.message,
      symbols_scanned: symbolsScanned,
      signals_created: signalsCreated,
      signals_updated: signalsUpdated,
      error_count: errorCount + 1,
    });
    await releaseScanLock();
    throw e;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Multi-exchange entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the scanner for every enabled exchange (Binance by default) one after another.
 * Each pass is isolated in its own exchange context: its own coin list, tickers, klines,
 * cursor, active-signal monitor and signal rows. A failing exchange (e.g. Binance geo-block)
 * never stops the other one.
 *
 * options.exchange  → run only that exchange (manual Scan Now from a user's selected exchange)
 * options.budgetMs  → TOTAL time for a full sweep; split evenly between the exchanges
 */
export async function runFullScan(source = 'cron', options = {}) {
  const requested = options.exchange ? String(options.exchange).toLowerCase() : '';
  const enabledExchanges = await getScanExchanges();
  let exchanges;
  if (requested === 'bybit' || requested === 'binance') {
    if (!enabledExchanges.includes(requested)) {
      return {
        ok: true,
        skipped: true,
        exchange: requested,
        reason: `${requested} scanning is disabled in scan_exchanges`,
        byExchange: {},
      };
    }
    exchanges = [requested];
  } else if (source === 'manual' && requested !== 'all') {
    const active = await getActiveExchange();
    // A dashboard-selected exchange must not bypass the admin scan gate.
    exchanges = [enabledExchanges.includes(active) ? active : enabledExchanges[0]];
  } else {
    exchanges = enabledExchanges;
  }
  const n = Math.max(1, exchanges.length);

  const isFullSource = source === 'cron-full' || options.mode === 'full' || options.fullScan === true;

  // A deferred full scan (lock busy last time) upgrades THIS run to a full sweep for all exchanges.
  let promoted = false;
  if (!isFullSource && (source === 'cron' || source === 'manual') && !options.lifecycle) {
    try {
      const pending = await getPendingFullScan();
      if (pending) {
        await consumePendingFullScan();
        promoted = true;
      }
    } catch (_) {}
  }

  const totalBudget =
    +options.budgetMs > 0 ? +options.budgetMs : promoted ? await getFullScanBudgetMs() : 0;
  const perBudget = totalBudget ? Math.max(8_000, Math.floor(totalBudget / n)) : 0;

  const results = [];
  const deferred = [];
  for (const ex of exchanges) {
    try {
      const r = await runWithExchange(ex, () =>
        runScanOne(source, {
          ...options,
          exchange: ex,
          ...(perBudget ? { budgetMs: perBudget } : {}),
          ...(promoted ? { _promoted: true } : {}),
        })
      );
      if (r?.deferred) deferred.push(ex);
      results.push({ exchange: ex, ...r });
    } catch (e) {
      console.error(`[scanner:${ex}]`, e.message);
      results.push({ exchange: ex, ok: false, error: String(e.message || e).slice(0, 200), errorCount: 1 });
    }
  }

  // Keep the "run a full scan next" flag if any exchange could not get the lock.
  if (deferred.length) {
    try {
      await markPendingFullScan(`deferred:${deferred.join(',')}`);
    } catch (_) {}
  }

  const ran = results.filter((r) => r.ok && !r.deferred && !r.skipped);
  if (results.length === 1) {
    const only = results[0];
    return { ...only, byExchange: { [only.exchange]: summarizePass(only) } };
  }
  if (!ran.length) {
    // nothing ran: report the most informative reason
    const d = results.find((r) => r.deferred);
    if (d && results.every((r) => r.deferred)) return { ...d, byExchange: summaryMap(results) };
    const sk = results.find((r) => r.skipped);
    if (sk) return { ...sk, byExchange: summaryMap(results) };
    return {
      ok: false,
      error: results.map((r) => `${r.exchange}: ${r.error || r.reason || 'failed'}`).join(' | '),
      byExchange: summaryMap(results),
    };
  }

  const sum = (k) => ran.reduce((a, r) => a + (+r[k] || 0), 0);
  const cov = ran.map((r) => r.coverage).filter(Boolean);
  const last = ran[ran.length - 1];
  return {
    ok: true,
    partial: ran.some((r) => r.partial) || deferred.length > 0,
    deferred: false,
    pendingFullScan: deferred.length > 0,
    deferredExchanges: deferred,
    scanRunId: last.scanRunId,
    symbolsScanned: sum('symbolsScanned'),
    signalsCreated: sum('signalsCreated'),
    signalsUpdated: sum('signalsUpdated'),
    // watching/ready/ongoing are counted per exchange: report the total of all exchanges
    watching_count: sum('watching_count') || sum('watching'),
    ready_count: sum('ready_count') || sum('ready'),
    ongoing_count: sum('ongoing_count') || sum('ongoing'),
    errorCount: sum('errorCount'),
    telegramSent: sum('telegramSent'),
    waitedMs: sum('waitedMs'),
    coverage: cov.length
      ? {
          chunkSize: cov.reduce((a, c) => a + (c.chunkSize || 0), 0),
          totalSymbols: cov.reduce((a, c) => a + (c.totalSymbols || 0), 0),
          fullSweep: cov.some((c) => c.fullSweep),
          ...(cov.some((c) => c.partsMode)
            ? { partsMode: true, parts: cov.find((c) => c.partsMode).parts, part: cov.find((c) => c.partsMode).part }
            : {}),
        }
      : null,
    created: ran.flatMap((r) => r.created || []),
    liveSignals: ran.flatMap((r) => r.liveSignals || []),
    nearBreakouts: ran.flatMap((r) => r.nearBreakouts || []),
    byExchange: summaryMap(results),
  };
}

function summarizePass(r) {
  return {
    ok: !!r.ok,
    skipped: !!r.skipped,
    deferred: !!r.deferred,
    scanned: r.symbolsScanned ?? 0,
    total: r.coverage?.totalSymbols ?? null,
    created: r.signalsCreated ?? 0,
    updated: r.signalsUpdated ?? 0,
    partial: !!r.partial,
    error: r.error || (r.ok === false ? r.reason : null) || null,
  };
}

function summaryMap(results) {
  return Object.fromEntries(results.map((r) => [r.exchange, summarizePass(r)]));
}
