/**
 * Auto-trading engine — reuses existing signals, places Bybit linear perps.
 */
import { getAutoTradingConfig } from './autoConfig.js';
import { getState } from '../database/appState.js';
import {
  getExecutionBySignal,
  getAnyExecutionBySignal,
  getOpenExecutions,
  getExecutionsToday,
  createExecution,
  updateExecution,
} from '../database/executions.js';
import { getActiveSignals } from '../database/signals.js';
import { SIGNAL_STATUS } from '../config/signalConfig.js';
import { revalidateEntryQuality } from '../signals/entryQuality.js';
import { getKlines } from '../exchange/index.js';
import { SIGNAL_CONFIG } from '../config/signalConfig.js';
import { priceBackInside } from '../signals/failedBreakout.js';
import { rebaseSignalToTestnet } from './rebase.js';
import { placeVerifyAndProtect } from './orderExecutionFlow.js';
import { randomUUID } from 'node:crypto';
import {
  getBaseUrl,
  getTestnetPrice,
  getWalletBalance,
  getPositions,
  getInstrumentInfo,
  setLeverage,
  placeOrder,
  setTradingStop,
  getOrderRealtime,
  roundToStep,
  roundPriceToTick,
} from '../bybit/client.js';
import { sendTelegramMessage } from '../telegram/telegram.js';
import { formatLK } from '../utils/time.js';

function log(msg, extra = {}) {
  console.log(
    `[auto-trade] ${msg}`,
    Object.keys(extra).length ? JSON.stringify(extra) : ''
  );
}

/** Build timing lines for Telegram: entry-hit time, attempt time, delay. */
function timingLines(signal, attemptAt = new Date()) {
  const hitRaw = signal?.entry_hit_at || signal?.last_updated_at || null;
  const hitAt = hitRaw ? new Date(hitRaw) : null;
  const hitOk = hitAt && Number.isFinite(hitAt.getTime());
  const attempt = attemptAt instanceof Date ? attemptAt : new Date(attemptAt);
  let delayStr = '—';
  if (hitOk) {
    const sec = Math.max(0, Math.round((attempt.getTime() - hitAt.getTime()) / 1000));
    if (sec < 60) delayStr = `${sec}s`;
    else if (sec < 3600) delayStr = `${Math.floor(sec / 60)}m ${sec % 60}s`;
    else delayStr = `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  }
  return (
    `Entry hit (ONGOING): ${hitOk ? formatLK(hitAt) : '—'}\n` +
    `Bybit attempt: ${formatLK(attempt)}\n` +
    `Delay: ${delayStr}`
  );
}

async function bybitKeys() {
  const apiKey = await getState('bybit_api_key', null);
  const apiSecret = await getState('bybit_api_secret', null);
  if (!apiKey || !apiSecret) throw new Error('Bybit API keys not configured');
  return { apiKey, apiSecret };
}

async function getAvailableUsdt(apiKey, apiSecret) {
  let bal = null;
  let lastErr = null;
  for (const accountType of ['UNIFIED', 'CONTRACT']) {
    try {
      bal = await getWalletBalance(apiKey, apiSecret, accountType);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!bal) {
    throw lastErr || new Error('Could not read Bybit wallet balance');
  }
  const usdt = (bal.coins || []).find((c) => c.coin === 'USDT');
  const reportedAvailable =
    bal.totalAvailableBalance != null
      ? Number(bal.totalAvailableBalance)
      : usdt?.available != null
        ? Number(usdt.available)
        : 0;
  const avail =
    Number.isFinite(reportedAvailable) && reportedAvailable > 0
      ? reportedAvailable
      : 0;
  return {
    available: avail,
    equity: +(bal.totalEquity || avail),
    balance: bal,
  };
}

export function calculateLeverage(cfg, atrPct, symbolMaxLev, symbolLeverageStep = 1) {
  let lev = cfg.defaultLeverage;
  if (cfg.volatilityAwareLeverage && atrPct != null && Number.isFinite(+atrPct)) {
    const a = +atrPct;
    if (a <= cfg.atrLowPct) {
      lev = cfg.leverageLowVol ?? cfg.defaultLeverage;
    } else if (a <= cfg.atrMidPct) {
      lev = cfg.leverageMidVol ?? Math.min(cfg.defaultLeverage, 8);
    } else if (a <= cfg.atrHighPct) {
      lev = cfg.leverageHighVol ?? 5;
    } else {
      if (cfg.rejectExtremeVol) return { leverage: 0, reject: true, reason: `ATR% ${a.toFixed(2)} extreme` };
      lev = cfg.leverageExtremeVol ?? cfg.minimumLeverage;
    }
  }
  const minLev = Math.max(cfg.minimumLeverage, 1);
  const maxLev = Math.min(cfg.maximumLeverage, symbolMaxLev > 0 ? symbolMaxLev : cfg.maximumLeverage);
  lev = Math.min(maxLev, Math.max(minLev, lev));
  const step = +symbolLeverageStep || 1;
  if (step > 0) {
    const precision = Math.max(0, (String(step).split('.')[1] || '').length);
    lev = +(Math.floor(lev / step + 1e-12) * step).toFixed(precision);
  }
  if (lev < minLev) {
    return { leverage: 0, reject: true, reason: `Instrument leverage step ${step} is below minimum ${minLev}` };
  }
  return { leverage: lev, reject: false };
}

export function calculateMargin(cfg, availableUsdt) {
  let margin = availableUsdt * (cfg.marginPercent / 100);
  const maxByPct = availableUsdt * (cfg.maximumMarginPercent / 100);
  margin = Math.min(margin, maxByPct, cfg.maxMarginUsdt);
  if (margin < cfg.minMarginUsdt) {
    return { margin: 0, reject: true, reason: `Margin ${margin.toFixed(2)} < min ${cfg.minMarginUsdt}` };
  }
  if (margin > availableUsdt) {
    return { margin: 0, reject: true, reason: 'Insufficient available balance' };
  }
  return { margin, reject: false };
}

export function calculateQuantity({ margin, leverage, entryPrice, instrument }) {
  const notional = margin * leverage;
  let qty = notional / entryPrice;
  qty = roundToStep(qty, instrument.qtyStep);
  if (qty < instrument.minOrderQty) {
    return { qty: 0, notional: 0, reject: true, reason: `Qty ${qty} < min ${instrument.minOrderQty}` };
  }
  if (instrument.maxOrderQty > 0 && qty > instrument.maxOrderQty) {
    qty = roundToStep(instrument.maxOrderQty, instrument.qtyStep);
  }
  if (qty < instrument.minOrderQty) {
    return {
      qty: 0,
      notional: 0,
      reject: true,
      reason: `Maximum order quantity rounds below minimum ${instrument.minOrderQty}`,
    };
  }
  const actualNotional = qty * entryPrice;
  if (instrument.minNotionalValue > 0 && actualNotional < instrument.minNotionalValue) {
    return {
      qty: 0,
      notional: actualNotional,
      reject: true,
      reason: `Order value ${actualNotional.toFixed(8)} < minimum ${instrument.minNotionalValue}`,
    };
  }
  return { qty, notional: actualNotional, reject: false };
}

function atrPercent(signal) {
  const atr = +signal.atr_5m || +signal.metadata?.atr || 0;
  const px = +signal.entry || +signal.current_price || +signal.last_price || 0;
  if (!atr || !px) return null;
  return (atr / px) * 100;
}

function riskOk(signal, cfg) {
  const entry = +signal.entry;
  const sl = +signal.sl;
  if (!entry || !sl) return { ok: false, reason: 'Missing entry or SL' };
  if (cfg.requireSl && !sl) return { ok: false, reason: 'SL required' };
  const dir = signal.direction || signal.dir;
  if (dir === 'LONG' && !(sl < entry)) return { ok: false, reason: 'LONG SL must be below entry' };
  if (dir === 'SHORT' && !(sl > entry)) return { ok: false, reason: 'SHORT SL must be above entry' };
  const riskDist = Math.abs(entry - sl);
  if (riskDist <= 0) return { ok: false, reason: 'Zero risk distance' };
  const rr = +signal.rr || (signal.tp1 ? Math.abs(+signal.tp1 - entry) / riskDist : 0);
  // chart-pattern signals use their own TP1-RR floor (1.0), not the SMC 1.2 floor
  const isPattern = (signal.metadata?.strategy || signal.strategy) === 'chart_pattern';
  const minRr = isPattern
    ? Math.min(cfg.requireMinimumRR || 0, +signal.metadata?.minRrAtEntry || 1.0)
    : cfg.requireMinimumRR;
  if (minRr > 0 && rr + 1e-6 < minRr) {
    return { ok: false, reason: `RR ${rr.toFixed(2)} < min ${minRr}` };
  }
  return { ok: true, rr };
}

export function validateSignalForExecution(signal, cfg) {
  if (!signal?.signal_id) return { ok: false, reason: 'No signal_id' };
  const score = +signal.score || 0;
  if (score < cfg.minimumScore) return { ok: false, reason: `Score ${score} < ${cfg.minimumScore}` };

  const dir = signal.direction || signal.dir;
  if (dir === 'LONG' && !cfg.allowLong) return { ok: false, reason: 'Longs disabled' };
  if (dir === 'SHORT' && !cfg.allowShort) return { ok: false, reason: 'Shorts disabled' };

  const status = String(signal.status || '').toUpperCase();
  // Trade only after the lifecycle has recorded an actual entry hit as ONGOING.
  // The cron route runs this immediately after persisting the lifecycle update.
  if (cfg.requireEntryHit) {
    if (status !== SIGNAL_STATUS.ONGOING) {
      return { ok: false, reason: `Entry not hit (status=${status})` };
    }
    // Prefer both timestamps, but allow ONGOING + entry_hit_at (ready_at may be missing on legacy / chart-pattern rows)
    if (!signal.entry_hit_at) {
      return {
        ok: false,
        reason: 'Missing entry_hit_at; refusing an unverified lifecycle transition',
      };
    }
  } else if (cfg.requireSignalReady) {
    if (![SIGNAL_STATUS.READY, SIGNAL_STATUS.ONGOING].includes(status)) {
      return { ok: false, reason: `Not READY/ONGOING (${status})` };
    }
  }

  if (!signal.entry) return { ok: false, reason: 'No entry' };
  // Failed breakout guard: live price already back inside the pattern → don't enter
  if (priceBackInside(signal, +signal.current_price || +signal.last_price)) {
    return { ok: false, reason: 'Price back inside pattern (failed breakout)' };
  }
  if (cfg.tpEnabled && !signal.tp1) return { ok: false, reason: 'No TP1' };

  const risk = riskOk(signal, cfg);
  if (!risk.ok) return risk;

  // age
  const created = signal.created_at ? new Date(signal.created_at).getTime() : 0;
  if (created && Date.now() - created > 48 * 3600 * 1000) {
    return { ok: false, reason: 'Signal too old (>48h)' };
  }

  return { ok: true };
}

async function checkRiskLimits(cfg, symbol) {
  if (!cfg.autoTradingEnabled) return { ok: false, reason: 'Auto trading disabled' };

  const open = await getOpenExecutions();
  const openLive = open.filter((e) =>
    [
      'PENDING',
      'PLACING',
      'PLACED',
      'WAITING_FILL',
      'VERIFY_UNKNOWN',
      'PROTECTING',
      'FILLED',
      'PROTECTED',
      'UNPROTECTED',
      'PARTIALLY_FILLED',
    ].includes(e.status)
  );
  if (openLive.length >= cfg.maxOpenPositions) {
    return { ok: false, reason: `Max open positions ${cfg.maxOpenPositions}` };
  }
  const perSym = openLive.filter((e) => e.symbol === symbol).length;
  if (perSym >= cfg.maxPositionsPerSymbol) {
    return { ok: false, reason: `Max positions for ${symbol}` };
  }

  const today = await getExecutionsToday();
  const attempts = today.filter(
    (e) => !['FAILED', 'CANCELLED', 'REJECTED'].includes(e.status)
  );
  if (attempts.length >= cfg.maxDailyTrades) {
    return { ok: false, reason: `Max daily trades ${cfg.maxDailyTrades}` };
  }
  const realized = today.reduce((s, e) => s + (+e.realized_pnl || 0), 0);
  // need equity for % — approximate from loss absolute if we stored equity in metadata
  // use sum of margins as rough account proxy only for blocking large losses
  if (cfg.maxDailyLossPercent > 0 && realized < 0) {
    const lossAbs = Math.abs(realized);
    const margins = today.reduce((s, e) => s + (+e.margin || 0), 0) || 1;
    // if realized loss > maxDailyLossPercent of sum of today's margins * leverage proxy — simpler:
    // store equity on first trade of day in state
    const dayEquity = await getState('auto_trade_day_equity', null);
    if (dayEquity && +dayEquity > 0) {
      const lossPct = (lossAbs / +dayEquity) * 100;
      if (lossPct >= cfg.maxDailyLossPercent) {
        return { ok: false, reason: `Daily loss limit ${cfg.maxDailyLossPercent}%` };
      }
    }
  }
  return { ok: true };
}

async function checkDuplicate(signalId, side, apiKey, apiSecret, symbol) {
  const existing = await getExecutionBySignal(signalId, side);
  if (existing) return { duplicate: true, reason: 'Execution already exists for signal', existing };

  try {
    const positions = await getPositions(apiKey, apiSecret);
    const pos = positions.find((p) => p.symbol === symbol);
    if (pos && Math.abs(pos.size) > 0) {
      const posSide = pos.side === 'Buy' ? 'LONG' : 'SHORT';
      if (posSide === side) {
        return { duplicate: true, reason: 'Bybit already has same-side position', existing: null };
      }
      return { duplicate: true, reason: 'Bybit has opposite position — skip', existing: null };
    }
  } catch (e) {
    log('position check failed', { error: e.message });
    return {
      duplicate: false,
      error: `Could not verify existing Bybit positions; refusing a potentially duplicate order: ${e.message}`,
    };
  }
  return { duplicate: false };
}

/** Record a terminal SKIPPED attempt so the next cron does not retry this signal. */
async function recordSkippedAttempt(signal, reason) {
  try {
    await createExecution({
      signal_id: signal.signal_id,
      symbol: signal.symbol,
      side: signal.direction || signal.dir,
      status: 'SKIPPED',
      score: +signal.score || null,
      signal_entry: signal.entry != null ? +signal.entry : null,
      quantity: null,
      margin: null,
      notional: null,
      leverage: null,
      tp1: signal.tp1 != null ? +signal.tp1 : null,
      tp2: signal.tp2 != null ? +signal.tp2 : null,
      tp3: signal.tp3 != null ? +signal.tp3 : null,
      sl: signal.sl != null ? +signal.sl : null,
      dry_run: false,
      error: String(reason || 'skipped').slice(0, 500),
      metadata: {
        environment: 'BYBIT TESTNET',
        skipReason: reason,
        entry_hit_at: signal.entry_hit_at || null,
      },
    });
  } catch (e) {
    // Unique / race — already recorded; fine
    log('recordSkippedAttempt', { signalId: signal.signal_id, error: e.message });
  }
}

/**
 * Process one signal → optional order.
 * Attempt at most ONCE per signal (READY→ONGOING transition window).
 * Further cron runs see the SKIPPED/FAILED/PLACED row and stay silent.
 */
export async function processSignal(signal, cfg, keys) {
  const signalId = signal.signal_id;
  const side = signal.direction || signal.dir;
  const symbol = signal.symbol;

  log('signal detected', { signalId, symbol, side, status: signal.status, score: signal.score });

  // Already attempted (placed, failed, or skipped) → never retry, no Telegram spam
  try {
    const prior = await getAnyExecutionBySignal(signalId, side);
    if (prior) {
      log('already attempted', { signalId, status: prior.status });
      return { skipped: true, reason: null, silent: true };
    }
  } catch (e) {
    log('prior-attempt check failed', { error: e.message });
  }

  // Heal missing entry_hit_at on ONGOING rows so late crons don't false-skip or refuse forever.
  // 15-minute auto-trade window removed — ongoing signals can place even if entry was hit earlier.
  const statusU = String(signal.status || '').toUpperCase();
  if (statusU === SIGNAL_STATUS.ONGOING && !signal.entry_hit_at) {
    const healed =
      signal.last_updated_at ||
      signal.updated_at ||
      new Date().toISOString();
    log('healing missing entry_hit_at on ONGOING', { signalId, healed });
    signal.entry_hit_at = healed;
    try {
      const { updateSignal } = await import('../database/signals.js');
      await updateSignal(signalId, { entry_hit_at: healed });
    } catch (e) {
      log('entry_hit_at heal persist failed', { error: e.message });
    }
  }

  const v = validateSignalForExecution(signal, cfg);
  if (!v.ok) {
    log('signal validated FAIL', { signalId, reason: v.reason });
    // Don't lock the signal for transient status issues (e.g. not yet ONGOING)
    return { skipped: true, reason: v.reason, silent: true };
  }
  log('signal validated');

  // Entry-time quality re-check before placing order (SMC only — chart-pattern breakouts skip the OB re-score)
  const isPatternSignal = (signal.metadata?.strategy || signal.strategy) === 'chart_pattern';
  try {
    if (isPatternSignal) throw Object.assign(new Error('skip'), { skipQuality: true });
    const htf = SIGNAL_CONFIG.htf || '4h';
    const obtf = SIGNAL_CONFIG.obTf || '1h';
    const [htfC, obC] = await Promise.all([
      getKlines(symbol, htf, SIGNAL_CONFIG.htfKlineLimit || 80),
      getKlines(symbol, obtf, SIGNAL_CONFIG.obKlineLimit || 100),
    ]);
    const q = revalidateEntryQuality(signal, htfC, obC, signal.entry_hit_price || signal.entry || signal.current_price, {
      minScore: cfg.minimumScore ?? SIGNAL_CONFIG.minScore,
      atr5m: signal.atr_5m,
    });
    if (!q.ok) {
      log('entry quality FAIL', { signalId, reason: q.reason, reScore: q.reScore });
      const reason = `Quality: ${q.reason}`;
      await recordSkippedAttempt(signal, reason);
      return { skipped: true, reason, notify: true };
    }
    log('entry quality OK', { reScore: q.reScore });
  } catch (qe) {
    if (!qe?.skipQuality) {
      log('entry quality unavailable — fail closed', { error: qe.message });
      const reason = `Quality re-check unavailable: ${qe.message}`;
      await recordSkippedAttempt(signal, reason);
      return { skipped: true, reason, notify: true };
    }
  }

  const limits = await checkRiskLimits(cfg, symbol);
  if (!limits.ok) {
    log('risk check failed', { signalId, reason: limits.reason });
    // Risk limits (max positions / daily) can clear later — do not lock signal forever
    return { skipped: true, reason: limits.reason, silent: true };
  }
  log('risk check passed');

  const dup = await checkDuplicate(signalId, side, keys.apiKey, keys.apiSecret, symbol);
  if (dup.duplicate) {
    log('duplicate check', { signalId, reason: dup.reason });
    // Position already open — record so we don't spam
    await recordSkippedAttempt(signal, dup.reason);
    return { skipped: true, reason: dup.reason, notify: true };
  }
  if (dup.error) {
    log('duplicate check unavailable', { signalId, error: dup.error });
    return { skipped: true, reason: dup.error, silent: true };
  }

  let { available, equity } = await getAvailableUsdt(keys.apiKey, keys.apiSecret);
  log('balance', { available, equity });

  // seed day equity once
  const dayEq = await getState('auto_trade_day_equity', null);
  if (!dayEq) {
    try {
      const { setState } = await import('../database/appState.js');
      const todayKey = new Date().toISOString().slice(0, 10);
      const storedDay = await getState('auto_trade_day_key', null);
      if (storedDay !== todayKey) {
        await setState('auto_trade_day_key', todayKey);
        await setState('auto_trade_day_equity', equity || available);
      }
    } catch (_) {}
  }

  const m = calculateMargin(cfg, available);
  if (m.reject) {
    log('margin reject', { reason: m.reason, available });
    const reason =
      m.reason +
      (available <= 0
        ? ' — Bybit USDT available = 0. Check UNIFIED transfer / API key Read+Trade.'
        : '');
    // Balance can be topped up — don't permanent-lock; but avoid per-minute spam via silent after first? 
    // Record skip so user gets one msg; they can manually enter later.
    await recordSkippedAttempt(signal, reason);
    return { skipped: true, reason, notify: true };
  }

  let instrument;
  try {
    instrument = await getInstrumentInfo(symbol);
  } catch (e) {
    const reason = `Instrument: ${e.message}`;
    await recordSkippedAttempt(signal, reason);
    return { skipped: true, reason, notify: true };
  }

  // Preserve the scanner's MAINNET ATR% for leverage selection. Only the
  // execution prices are rebased for Bybit TESTNET.
  const atrPct = atrPercent(signal);

  // Signal levels are MAINNET prices; the order goes to the TESTNET book → rebase levels
  let rebaseRatio = 1;
  try {
    const tnPrice = await getTestnetPrice(symbol);
    const rb = rebaseSignalToTestnet(signal, tnPrice);
    if (!rb.ok) {
      log('testnet rebase skip', { signalId, reason: rb.reason });
      await recordSkippedAttempt(signal, rb.reason);
      return { skipped: true, reason: rb.reason, notify: true };
    }
    if (rb.rebased) {
      log('rebased to testnet', { signalId, symbol, ratio: rb.ratio, testnetPrice: tnPrice });
      signal = rb.signal;
      rebaseRatio = rb.ratio;
    }
  } catch (e) {
    const reason = `Testnet price: ${e.message}`;
    await recordSkippedAttempt(signal, reason);
    return { skipped: true, reason, notify: true };
  }

  const levRes = calculateLeverage(
    cfg,
    atrPct,
    instrument.maxLeverage,
    instrument.leverageStep
  );
  if (levRes.reject) {
    await recordSkippedAttempt(signal, levRes.reason);
    return { skipped: true, reason: levRes.reason, notify: true };
  }

  const entryPrice = +signal.entry_hit_price || +signal.entry;
  const q = calculateQuantity({
    margin: m.margin,
    leverage: levRes.leverage,
    entryPrice,
    instrument,
  });
  if (q.reject) {
    await recordSkippedAttempt(signal, q.reason);
    return { skipped: true, reason: q.reason, notify: true };
  }

  log('sizing', {
    margin: m.margin,
    leverage: levRes.leverage,
    qty: q.qty,
    notional: q.notional,
    atrPct,
  });

  // Create PENDING record first (idempotency unique)
  let execution;
  try {
    execution = await createExecution({
      signal_id: signalId,
      symbol,
      side,
      status: 'PENDING',
      score: +signal.score || null,
      signal_entry: +signal.entry,
      quantity: q.qty,
      margin: m.margin,
      notional: q.notional,
      leverage: levRes.leverage,
      tp1: signal.tp1 != null ? +signal.tp1 : null,
      tp2: signal.tp2 != null ? +signal.tp2 : null,
      tp3: signal.tp3 != null ? +signal.tp3 : null,
      sl: signal.sl != null ? +signal.sl : null,
      atr_pct: atrPct,
      dry_run: false,
      metadata: {
        environment: 'BYBIT TESTNET',
        orderType: cfg.orderType,
        requireEntryHit: cfg.requireEntryHit,
        testnetRebaseRatio: rebaseRatio,
        mainnetLevels: signal.metadata?.mainnetLevels || {
          entry: signal.entry,
          entry_hit_price: signal.entry_hit_price ?? null,
          sl: signal.sl ?? null,
          tp1: signal.tp1 ?? null,
          tp2: signal.tp2 ?? null,
          tp3: signal.tp3 ?? null,
        },
        testnetLevels: {
          entry: signal.entry,
          entry_hit_price: signal.entry_hit_price ?? null,
          sl: signal.sl ?? null,
          tp1: signal.tp1 ?? null,
          tp2: signal.tp2 ?? null,
          tp3: signal.tp3 ?? null,
        },
        available,
        equity,
      },
    });
  } catch (e) {
    // unique violation = duplicate
    log('create execution failed (likely duplicate)', { error: e.message });
    return { skipped: true, reason: `DB lock/duplicate: ${e.message}` };
  }

  const apiBase = await getBaseUrl();
  if (!/api-testnet\.bybit\.com$/i.test(apiBase)) {
    await updateExecution(execution.id, {
      status: 'FAILED',
      error: `Blocked non-TESTNET Bybit endpoint: ${apiBase}`,
    });
    return { failed: true, reason: 'Bybit endpoint is not TESTNET' };
  }

  const bybitSide = side === 'LONG' ? 'Buy' : 'Sell';
  const orderLinkId = `tm${randomUUID().replaceAll('-', '').slice(0, 32)}`;
  const orderBody = {
    symbol,
    side: bybitSide,
    orderType: cfg.orderType === 'Limit' ? 'Limit' : 'Market',
    qty: q.qty,
    reduceOnly: false,
    orderLinkId,
  };
  if (cfg.orderType === 'Limit') {
    orderBody.price = roundPriceToTick(entryPrice, instrument.tickSize);
  }

  try {
    const result = await placeVerifyAndProtect({
      execution,
      signal,
      orderBody,
      cfg: { ...cfg, leverage: levRes.leverage },
      instrument,
      updateExecution,
      logger: log,
      api: {
        setLeverage: (targetSymbol, leverage) =>
          setLeverage(keys.apiKey, keys.apiSecret, targetSymbol, leverage),
        placeOrder: (body) => placeOrder(keys.apiKey, keys.apiSecret, body),
        getOrderRealtime: (query) =>
          getOrderRealtime(keys.apiKey, keys.apiSecret, query),
        getPositions: () => getPositions(keys.apiKey, keys.apiSecret),
        setTradingStop: (body) =>
          setTradingStop(keys.apiKey, keys.apiSecret, body),
      },
    });
    log('final status', { signalId, status: result.status });
    return {
      ...result,
      symbol,
      side,
      qty: result.quantity ?? q.qty,
      leverage: levRes.leverage,
      margin: m.margin,
    };
  } catch (e) {
    // An unexpected failure after submitting an order is not proof that the
    // exchange rejected it. Keep the signal locked against automatic retries.
    const message = `Execution state is unknown; automatic retry blocked: ${e.message}`;
    log('execution state unknown', { signalId, error: e.message });
    try {
      await updateExecution(execution.id, {
        status: 'VERIFY_UNKNOWN',
        error: message,
        metadata: {
          ...(execution.metadata || {}),
          environment: 'BYBIT TESTNET',
          verificationStatus: 'UNKNOWN',
        },
      });
    } catch (_) {}
    return {
      unknown: true,
      reason: message,
      status: 'VERIFY_UNKNOWN',
      executionId: execution.id,
    };
  }
}

/**
 * Main entry: process executable active signals after scan.
 */
export async function processAutoTrades(options = {}) {
  const summary = {
    autoTradingEnabled: false,
    autoTradesAttempted: 0,
    autoTradesPlaced: 0,
    autoTradesSkipped: 0,
    autoTradesFailed: 0,
    reasons: [],
  };

  try {
    const exchange = await getState('active_exchange', 'binance');
    if (exchange !== 'bybit') {
      summary.reasons.push('Active exchange is not bybit');
      log('skip', { reason: 'Active exchange is not bybit', exchange });
      return summary;
    }

    const cfg = await getAutoTradingConfig();
    summary.autoTradingEnabled = !!cfg.autoTradingEnabled;
    if (!cfg.autoTradingEnabled) {
      summary.reasons.push('autoTradingEnabled=false');
      log('skip', { reason: 'autoTradingEnabled=false' });
      return summary;
    }

    let keys;
    try {
      keys = await bybitKeys();
    } catch (e) {
      summary.reasons.push(e.message);
      log('skip', { reason: e.message });
      try {
        await sendTelegramMessage(
          `⚠️ <b>Auto-trade blocked</b>\n${e.message}\nSet Bybit TESTNET API keys (Read + Trade) in settings.`
        );
      } catch (_) {}
      return summary;
    }

    const active = await getActiveSignals();
    const candidates = active.filter((s) => {
      const st = String(s.status || '').toUpperCase();
      // Only ONGOING signals are traded; the lifecycle update is persisted before this pass.
      if (cfg.requireEntryHit) return st === SIGNAL_STATUS.ONGOING;
      return st === SIGNAL_STATUS.READY || st === SIGNAL_STATUS.ONGOING;
    });

    // Sort by score desc, limit per cron
    candidates.sort((a, b) => (+b.score || 0) - (+a.score || 0));
    const batch = candidates.slice(0, Math.min(5, cfg.maxOpenPositions));

    for (const signal of batch) {
      try {
        const res = await processSignal(signal, cfg, keys);
        // Silent = already attempted / not in window — do not count or spam Telegram
        if (res.silent) continue;

        summary.autoTradesAttempted++;

        if (res.placed) {
          summary.autoTradesPlaced++;
          if (res.status === 'UNPROTECTED') {
            summary.reasons.push(
              `${signal.symbol}: Bybit position remains UNPROTECTED: ${res.error || 'protection verification failed'}`
            );
          } else if (res.waitingPosition || res.status === 'WAITING_FILL') {
            summary.reasons.push(
              `${signal.symbol}: order accepted; waiting for fill/position verification`
            );
          }
          try {
            await sendTelegramMessage(
              `✅ <b>Bybit order placed</b>\n` +
                `${signal.symbol} ${signal.direction || signal.dir}\n` +
                `Status: ${res.status || 'PLACED'}\n` +
                `Qty: ${res.qty ?? '—'}\n` +
                `Leverage: ${res.leverage ?? '—'}x\n` +
                timingLines(signal)
            );
          } catch (_) {}
        } else if (res.failed) {
          summary.autoTradesFailed++;
          summary.reasons.push(`${signal.symbol}: ${res.reason}`);
          try {
            await sendTelegramMessage(
              `❌ <b>Bybit order FAILED</b>\n` +
                `${signal.symbol} ${signal.direction || signal.dir}\n` +
                `Reason: ${res.reason || 'unknown'}\n` +
                timingLines(signal)
            );
          } catch (_) {}
        } else {
          summary.autoTradesSkipped++;
          if (res.reason) summary.reasons.push(`${signal.symbol}: ${res.reason}`);
          // Only notify on the first attempt (notify: true), never every cron tick
          if (res.notify && res.reason) {
            try {
              await sendTelegramMessage(
                `⚠️ <b>Bybit order SKIPPED</b>\n` +
                  `${signal.symbol} ${signal.direction || signal.dir} (ONGOING)\n` +
                  `Reason: ${res.reason}\n` +
                  timingLines(signal)
              );
            } catch (_) {}
          }
        }
      } catch (e) {
        summary.autoTradesFailed++;
        summary.reasons.push(`${signal.symbol}: ${e.message}`);
        try {
          await sendTelegramMessage(
            `❌ <b>Bybit order ERROR</b>\n` +
              `${signal.symbol} ${signal.direction || signal.dir}\n` +
              `Error: ${e.message}\n` +
              timingLines(signal)
          );
        } catch (_) {}
      }
    }

    // trim reasons
    summary.reasons = summary.reasons.slice(0, 15);
    return summary;
  } catch (e) {
    summary.reasons.push(e.message);
    return summary;
  }
}
