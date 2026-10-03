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
} from '../exchange/index.js';
import { runChartPatternStrategy } from './strategy/chartPattern/index.js';
import { CHART_PATTERN_CONFIG } from './strategy/chartPattern/config.js';
import { calcATR } from './indicators.js';
import { revalidateEntryQuality } from '../signals/entryQuality.js';
import { buildInvalidationRecord } from '../signals/invalidation.js';
import { getState, setState } from '../database/appState.js';
import { SIGNAL_CONFIG, SIGNAL_STATUS } from '../config/signalConfig.js';
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
  createScanRun,
  completeScanRun,
  acquireScanLock,
  releaseScanLock,
} from '../database/scanRuns.js';
import { dispatchNotifications } from '../telegram/telegram.js';
import { getEntryProximity } from '../signals/proximity.js';
import { checkFailedBreakout, isConfirmedPatternBreakout } from '../signals/failedBreakout.js';
import {
  persistNearBreakout,
  recheckNearBreakout,
} from './nearBreakoutLifecycle.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function runFullScan(source = 'cron', options = {}) {
  const startedAt = Date.now();
  const deadlineMs = source === 'cron' ? CRON_SOFT_DEADLINE_MS : SOFT_DEADLINE_MS;
  const timeLeft = () => deadlineMs - (Date.now() - startedAt);

  // Allow Scan Now UI to override universe / chunk size per request
  const universe = options.universe != null && options.universe !== ''
    ? options.universe
    : SIGNAL_CONFIG.scanUniverse;
  const chunkSizeCfg = options.chunkSize != null && +options.chunkSize > 0
    ? +options.chunkSize
    : SIGNAL_CONFIG.scanChunkSize;
  // Reset cursor when universe size changes so we start from top volume again
  const resetCursor = !!options.resetCursor;
  // Manual "Scan Now" runs in chunks. To keep statuses stable until the WHOLE scan is done:
  //   lifecycle 'skip' → chunk run: only monitor ONGOING (TP/SL); WATCHING/READY are NOT touched
  //   lifecycle 'only' → final run after the last chunk: status updates only (no discovery)
  //   (default / cron) → monitor + discover as before
  const lifecycleMode = options.lifecycle === 'skip' || options.lifecycle === 'only' ? options.lifecycle : null;

  const lock = await acquireScanLock();
  if (!lock.acquired) {
    return {
      ok: false,
      skipped: true,
      reason: lock.reason,
    };
  }

  const scanRun = await createScanRun({ source, universe, chunkSize: chunkSizeCfg });
  clearKlineCache();

  let symbolsScanned = 0;
  let signalsCreated = 0;
  const createdSummaries = [];
  const nearBreakouts = []; // pre-breakout radar (manual scan only, never persisted)
  let signalsUpdated = 0;
  let telegramSent = 0;
  let errorCount = 0;
  let timedOutSoft = false;
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
    if (chunkSizeCfg > 0 && chunkSizeCfg < fullMarket.length) {
      usingCursor = true;
      const chunkSize = Math.min(+chunkSizeCfg, fullMarket.length);
      let cursorState = (await getState('scan_cursor')) || { offset: 0, universe: null };
      if (resetCursor || String(cursorState.universe) !== `${activeExchange}:${universe}`) {
        cursorOffset = 0;
      } else {
        cursorOffset = cursorState.offset % fullMarket.length || 0;
      }

      let chunk = fullMarket.slice(cursorOffset, cursorOffset + chunkSize);
      if (chunk.length < chunkSize) {
        chunk = chunk.concat(fullMarket.slice(0, chunkSize - chunk.length));
      }
      sorted = chunk;

      coverage = {
        chunkSize,
        totalSymbols: fullMarket.length,
        cyclesToFullCoverage: Math.ceil(fullMarket.length / chunkSize),
        cursorOffset,
        universe: +universe || universe,
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
    // Strategy 1 (SMC) removed — Chart Pattern (Strategy 2) is the only strategy.
    const strategyMode = 'chart_pattern';
    try {
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
    const activeAll = await getActiveSignals();
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
            } catch (_) {}

            // Entry-time quality re-check when near entry or about to hit
            let qualityCheck = null;
            const st = String(sig.status || '').toUpperCase();
            // Strategy 2 (chart pattern) is a breakout setup — the SMC order-block re-score
            // does not apply to it and would wrongly invalidate valid pattern signals.
            const isPatternSig = (sig.metadata?.strategy || sig.strategy) === 'chart_pattern';
            // Near-breakout: enter at market as soon as LIVE price crosses entry (no candle-close wait)
            let nearLiveEntry = true;
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
                    bufferAtr: fcfg.failedBreakoutBufferATR ?? CHART_PATTERN_CONFIG.failedBreakoutBufferATR ?? 0.1,
                  });
                  if (fb.failed) {
                    const dirTxt = (sig.direction || sig.dir) === 'SHORT' ? 'above' : 'below';
                    const reason = `Failed breakout — candle closed back ${dirTxt} level ${(+fb.level).toFixed(4)} (close ${(+fb.close).toFixed(4)})`;
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
            const nearEntry =
              !isPatternSig && (st === 'WATCHING' || st === 'READY')
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
              { nearLiveEntry }
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
      if (timeLeft() < 6000) {
        timedOutSoft = true;
        break;
      }
      const batch = sorted.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (sym) => {
          try {
            const price = tickers[sym]?.price;
            if (!price) return;

            const [htfC, obC, c5] = await Promise.all([
              getKlines(sym, htf, SIGNAL_CONFIG.htfKlineLimit || 80),
              getKlines(sym, obtf, SIGNAL_CONFIG.obKlineLimit || 100),
              getKlines(sym, '5m', SIGNAL_CONFIG.atrKlineLimit || 30),
            ]);
            const atr5m = calcATR(c5, 14);

            // ---- Strategy 2 (Chart Pattern) only ----
            const allResults = [];

            if (strategyMode === 'chart_pattern' || strategyMode === 'both') {
              try {
                let chartPatternCfg = {};
                try {
                  const cpc = await getState('chart_pattern_config', null);
                  if (cpc && typeof cpc === 'object') chartPatternCfg = cpc;
                } catch (_) {}
                const ALLOWED_TFS = ['5m', '15m', '30m', '1h', '2h'];
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
                        includeNear: true,
                        cfg: { ...chartPatternCfg, patternTf: tf, htf: htfTf },
                      });
                      for (const n of near || []) nearBreakouts.push(n);
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

            for (const r of allResults) {
              const signalId = buildSignalId(
                r.symbol,
                r.dir,
                (r.strategy === 'chart_pattern'
                  ? `CP_${r.pattern || 'PAT'}_${r.metadata?.patternTf && r.metadata.patternTf !== '15m' ? r.metadata.patternTf + '_' : ''}`
                  : '') +
                  String(r.ob?.time || r.metadata?.breakoutLevel || ''),
                r.entry
              );

              // ATR-based proximity (not fixed %)
              const prox = getEntryProximity(
                {
                  entry: r.entry,
                  sl: r.sl,
                  direction: r.dir,
                  ob_high: r.ob?.high,
                  ob_low: r.ob?.low,
                  ob: r.ob,
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

              let atrVal = (prox.atr5m > 0 ? prox.atr5m : atr5m) || 0;
              let distAbs = Math.abs(+price - +r.entry);
              let atrDistUnits = atrVal > 0 ? distAbs / atrVal : prox.atrDistance;
              let gapPct = +r.entry ? (distAbs / +r.entry) * 100 : prox.distancePercent;

              if (!isChart) {
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

                if (prox.entryHit) continue;

                const riskAbs = Math.abs(+r.entry - +r.sl);
                const riskPct = +r.entry ? (riskAbs / +r.entry) * 100 : 0;
                const minRiskPct = SIGNAL_CONFIG.minRiskPercent ?? 1.0;
                if (!riskAbs || riskPct < Math.max(0.05, minRiskPct)) continue;
                const minRiskAtr = SIGNAL_CONFIG.minRiskATR ?? 0.6;
                if (atrVal > 0 && riskAbs < atrVal * minRiskAtr) continue;
                if (r.rr == null || r.rr === '—' || +r.rr < 1.2) continue;

                const minDist = atrVal * minEntryATR;
                if (minEntryATR > 0 && distAbs < minDist) continue;
                const maxDist = atrVal * maxEntryATR;
                if (maxEntryATR > 0 && atrVal > 0 && distAbs > maxDist) continue;
                if (maxGapPercent > 0 && gapPct > maxGapPercent) continue;
              } else {
                // Chart pattern: breakout already validated in strategy module
                if (!r.metadata?.breakoutConfirmed && !q.breakoutConfirmed) continue;
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
                status: isChart ? 'READY' : prox.isReady ? 'READY' : 'WATCHING',
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
                  htf: SIGNAL_CONFIG.htf,
                  obTf: SIGNAL_CONFIG.obTf,
                  entryStyle: SIGNAL_CONFIG.entryStyle,
                  minScore: threshold,
                  minEntryDistanceATR: minEntryATR,
                  maxEntryDistanceATR: maxEntryATR,
                  entryDistanceATR: atrDistUnits,
                  maxGapPercent,
                  gapPercent: gapPct,
                  strategy: r.strategy || 'existing_smc',
                  pattern: r.pattern || r.metadata?.pattern || null,
                  breakoutLevel: r.metadata?.breakoutLevel ?? null,
                  breakoutConfirmed: r.metadata?.breakoutConfirmed ?? null,
                  ...(r.metadata || {}),
                  minScoreAtCreate: isChart ? (chartPatternCfg.minSignalScore ?? 70) : threshold,
                  minRrAtEntry: isChart ? (chartPatternCfg.minTp1RR ?? 1.0) : 1.2,
                  minRR: isChart ? (chartPatternCfg.minRR ?? 1.2) : 1.2,
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
                is_close: isChart ? true : prox.isReady,
                close_label: isChart ? 'BREAKOUT' : closeLabel,
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
                  if (record.status === SIGNAL_STATUS.ONGOING) skipReason = 'already ONGOING at birth';
                  // Re-check score on record (SMC threshold only)
                  else if (r.strategy !== 'chart_pattern' && Math.round(+record.score) < threshold) {
                    skipReason = 'below min score';
                  }
                  if (skipReason) {
                    live.persisted = false;
                    live.persist_error = skipReason;
                    console.log('[SIGNAL_DB] skipped', JSON.stringify({
                      signal_id: signalId, symbol: r.symbol, status: record.status, operation: 'skip', reason: skipReason,
                    }));
                    continue;
                  }
                  // Chart pattern breakouts are at-market → always READY in DB
                  if (isChart) {
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
                  const saved = await upsertSignal(record);
                  persistOp = saved.operation;
                  live.persisted = true;
                  live.persist_operation = persistOp;
                  live.status = saved.data?.status || record.status;
                  if (persistOp === 'inserted') signalsCreated++;
                  else signalsUpdated++;
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
            errors.push(`${sym}: ${e.message}`);
          } finally {
            processedCount++;
          }
        })
      );
      if (pause) await sleep(Math.min(pause, 100));
    }

    // Advance the rotating cursor only by what was actually processed, so
    // a soft-timeout resumes from the right place next time instead of
    // skipping the symbols it didn't get to.
    if (usingCursor) {
      const nextOffset = (cursorOffset + processedCount) % fullMarket.length;
      await setState('scan_cursor', {
        offset: nextOffset,
        universe: `${activeExchange}:${universe}`,
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
      const afterActive = await getActiveSignals();
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

    await releaseScanLock();

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
