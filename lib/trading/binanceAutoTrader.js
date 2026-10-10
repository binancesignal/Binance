import {
  getAnyExecutionBySignal,
  getExecutionBySignal,
  getExecutionsToday,
  getOpenExecutions,
  getLedgerExecutions,
  createExecution,
  updateExecution,
} from '../database/executions.js';
import { getActiveSignals, updateSignal } from '../database/signals.js';
import {
  canAutoTrade,
  getPlan,
  getExchangeKeys,
  getUserById,
  getUserTradingSettings,
  listUsersForAutoTrading,
} from '../database/users.js';
import { getScanExchanges, getKlines, runWithExchange } from '../exchange/index.js';
import { signalExchange } from '../exchange/context.js';
import { SIGNAL_STATUS, SIGNAL_CONFIG } from '../config/signalConfig.js';
import { revalidateEntryQuality } from '../signals/entryQuality.js';
import { priceBackInside } from '../signals/failedBreakout.js';
import { getAutoTradingConfig } from './autoConfig.js';
import { getState, setState } from '../database/appState.js';
import { sizeHighRiskTrade, resolveHighRiskConfig, evaluateGuard } from './riskSizing.js';
import { normalizeTpLevel, resolveTpPrice } from './tpSelect.js';
import {
  calculateQuantity,
  validateSignalForExecution,
} from './autoTrader.js';
import { rebaseSignalToExchangePrice } from './rebase.js';
import { getCapital, budgetState, applyBudgetCap } from './capital.js';
import { syncClosedTrades } from './pnlSync.js';
import * as binance from '../binance/private.js';
import { sendTelegramToChat, notifyAdminTradePlaced } from '../telegram/telegram.js';
import { formatLK } from '../utils/time.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OPEN_STATUSES = [
  'PENDING', 'PLACING', 'PLACED', 'WAITING_FILL', 'VERIFY_UNKNOWN',
  'PROTECTING', 'FILLED', 'PROTECTED', 'UNPROTECTED', 'PARTIALLY_FILLED',
];

function logger(userId, mode, signalId, message, extra = {}) {
  console.log(
    `[auto-trade][binance] ${message}`,
    JSON.stringify({ userId, mode, signalId, ...extra })
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function timingLines(signal, attemptAt = new Date()) {
  const rawHit = signal?.entry_hit_at || signal?.last_updated_at || null;
  const hit = rawHit ? new Date(rawHit) : null;
  const validHit = hit && Number.isFinite(hit.getTime());
  const attempt = attemptAt instanceof Date ? attemptAt : new Date(attemptAt);
  let delay = '—';
  if (validHit) {
    const seconds = Math.max(0, Math.round((attempt.getTime() - hit.getTime()) / 1000));
    if (seconds < 60) delay = `${seconds}s`;
    else if (seconds < 3600) delay = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    else delay = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `Entry hit (ONGOING): ${validHit ? formatLK(hit) : '—'}\nBinance attempt: ${formatLK(attempt)}\nDelay: ${delay}`;
}

async function notify(user, message, context) {
  if (!user?.telegram_chat_id) {
    console.info('[auto-trade][binance] no linked Telegram chat; notification skipped', context);
    return;
  }
  try {
    const result = await sendTelegramToChat(user.telegram_chat_id, message);
    if (!result?.ok && !result?.skipped) {
      console.warn('[auto-trade][binance] Telegram notification failed', {
        ...context,
        error: result?.error?.description || result?.error || null,
      });
    }
  } catch (error) {
    console.warn('[auto-trade][binance] Telegram notification failed', {
      ...context,
      error: error.message,
    });
  }
}

function noticeText(kind, signal, mode, reason, result = {}) {
  const symbol = escapeHtml(signal.symbol);
  const direction = escapeHtml(signal.direction || signal.dir);
  const modeLabel = String(mode || '—').toUpperCase();
  const timing = timingLines(signal);
  if (kind === 'placed') {
    const sz = result.sizing;
    const sizingLines = sz
      ? `Risk mode: 🔥 HIGH RISK\nMargin: $${(+sz.margin).toFixed(2)}${sz.marginPercent != null ? ` (${(+sz.marginPercent).toFixed(0)}% of balance)` : ''}\n` +
        (sz.lossAtSl != null ? `Max loss at SL: $${(+sz.lossAtSl).toFixed(2)} (${(+sz.lossAtSlPct).toFixed(1)}%)\n` : '')
      : '';
    return `✅ <b>Binance order placed</b>\n${symbol} ${direction}\nMode: ${modeLabel}\nStatus: ${escapeHtml(result.status || 'PLACED')}\nQty: ${escapeHtml(result.qty ?? '—')}\nLeverage: ${escapeHtml(result.leverage ?? '—')}x\n${sizingLines}${timing}`;
  }
  if (kind === 'failed') {
    return `❌ <b>Binance order FAILED</b>\n${symbol} ${direction}\nMode: ${modeLabel}\nReason: ${escapeHtml(reason || 'unknown')}\n${timing}`;
  }
  return `⚠️ <b>Binance order SKIPPED</b>\n${symbol} ${direction}\nMode: ${modeLabel}\nReason: ${escapeHtml(reason || 'not eligible')}\n${timing}`;
}

async function recordSkip(user, signal, mode, reason) {
  try {
    return await createExecution({
      user_id: user.id,
      exchange: 'binance',
      mode: mode || null,
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
        environment: mode === 'live' ? 'BINANCE LIVE' : 'BINANCE TESTNET',
        skipReason: reason,
        entry_hit_at: signal.entry_hit_at || null,
      },
    });
  } catch (error) {
    logger(user.id, mode, signal.signal_id, 'skip record failed (likely duplicate)', {
      error: error.message,
    });
    return null;
  }
}

async function sendSkipped(user, signal, mode, reason) {
  await recordSkip(user, signal, mode, reason);
  logger(user.id, mode, signal.signal_id, 'signal skipped', { reason });
  return { skipped: true, notify: true, reason };
}

function signalAtrPercent(signal) {
  const atr = +signal.atr_5m || +signal.metadata?.atr || 0;
  const price = +signal.entry || +signal.current_price || +signal.last_price || 0;
  return atr > 0 && price > 0 ? (atr / price) * 100 : null;
}

// sizing details of the trade just placed, handed to the notifier (key: userId:signalId)
const lastSizing = new Map();

/** Margin currently tied up: open positions + orders that have not become positions yet. */
/** Margin tied up in open exchange positions + pending bot orders (USDT). */
async function usedMarginUsdt(userId, positions) {
  const fromPositions = (positions || []).reduce((sum, p) => {
    // Prefer explicit margin from the exchange; fall back to notional/leverage.
    const m =
      +p.margin > 0
        ? +p.margin
        : (+p.positionValue || 0) / (+p.leverage > 0 ? +p.leverage : 1);
    return sum + (Number.isFinite(m) && m > 0 ? m : 0);
  }, 0);
  let pendingMargin = 0;
  try {
    const keys = new Set(positions.map((p) => `${p.symbol}:${p.side === 'Buy' ? 'LONG' : 'SHORT'}`));
    const open = await getOpenExecutions({ userId, exchange: 'binance' });
    pendingMargin = open
      .filter((e) =>
        ['PENDING', 'PLACING', 'PLACED', 'WAITING_FILL', 'VERIFY_UNKNOWN', 'PROTECTING', 'PARTIALLY_FILLED'].includes(
          e.status
        )
      )
      .filter((e) => !keys.has(`${e.symbol}:${e.side}`))
      .reduce((sum, e) => sum + (+e.margin || 0), 0);
  } catch (_) {}
  return fromPositions + pendingMargin;
}

/** Persisted account brakes for High Risk mode (daily loss / drawdown from peak). */
async function applyEquityGuard(userId, equity, hr) {
  const key = `risk_guard:${userId}`;
  const prev = await getState(key, null);
  const res = evaluateGuard(prev, equity, new Date(), hr);
  if (JSON.stringify(res.state) !== JSON.stringify(prev)) await setState(key, res.state);
  return res;
}

function isFilled(order) {
  return Number(order?.executedQty) > 0;
}

async function checkRiskLimits(cfg, userId, symbol, equity, accountPositions = []) {
  const open = await getOpenExecutions({ userId, exchange: 'binance' });
  const live = open.filter((execution) => OPEN_STATUSES.includes(execution.status));
  const positionKeys = new Set(
    accountPositions.map((position) => `${position.symbol}:${position.side === 'Buy' ? 'LONG' : 'SHORT'}`)
  );
  const pending = live.filter((execution) =>
    ['PENDING', 'PLACING', 'PLACED', 'WAITING_FILL', 'VERIFY_UNKNOWN', 'PROTECTING', 'PARTIALLY_FILLED'].includes(execution.status)
  );
  const pendingWithoutPosition = pending.filter(
    (execution) => !positionKeys.has(`${execution.symbol}:${execution.side}`)
  );
  const openCount = accountPositions.length + pendingWithoutPosition.length;
  if (openCount >= cfg.maxOpenPositions) {
    return { ok: false, reason: `Max open positions ${cfg.maxOpenPositions}` };
  }
  if (
    pendingWithoutPosition.filter((execution) => execution.symbol === symbol).length >= cfg.maxPositionsPerSymbol ||
    accountPositions.some((position) => position.symbol === symbol && +position.size > 0)
  ) {
    return { ok: false, reason: `Max positions for ${symbol}` };
  }
  const today = await getExecutionsToday({ userId, exchange: 'binance' });
  const attempts = today.filter((execution) => !['FAILED', 'CANCELLED', 'REJECTED'].includes(execution.status));
  if (attempts.length >= cfg.maxDailyTrades) {
    return { ok: false, reason: `Max daily trades ${cfg.maxDailyTrades}` };
  }
  const realized = today.reduce((sum, execution) => sum + (+execution.realized_pnl || 0), 0);
  if (
    cfg.maxDailyLossPercent > 0 &&
    equity > 0 &&
    realized < 0 &&
    (Math.abs(realized) / equity) * 100 >= cfg.maxDailyLossPercent
  ) {
    return { ok: false, reason: `Daily loss limit ${cfg.maxDailyLossPercent}%` };
  }
  return { ok: true };
}

async function confirmEntryQuality(signal, cfg) {
  const strategy = signal.metadata?.strategy || signal.strategy;
  if (strategy === 'chart_pattern' || strategy === 'zone_pattern' || strategy === 'ema_bump') return { ok: true };
  try {
    const [htfCandles, obCandles] = await runWithExchange('binance', () =>
      Promise.all([
        getKlines(signal.symbol, SIGNAL_CONFIG.htf || '4h', SIGNAL_CONFIG.htfKlineLimit || 80),
        getKlines(signal.symbol, SIGNAL_CONFIG.obTf || '1h', SIGNAL_CONFIG.obKlineLimit || 100),
      ])
    );
    return revalidateEntryQuality(
      signal,
      htfCandles,
      obCandles,
      signal.entry_hit_price || signal.entry || signal.current_price,
      {
        minScore: cfg.minimumScore ?? SIGNAL_CONFIG.minScore,
        atr5m: signal.atr_5m,
      }
    );
  } catch (error) {
    return { ok: false, reason: `Quality re-check unavailable: ${error.message}` };
  }
}

async function processUserSignal(user, userSettings, signal, baseCfg, keys, options = {}) {
  const signalId = signal.signal_id;
  const mode = keys.mode;
  const userId = user.id;
  const isManual = !!options.manual;

  try {
    if (!['mock', 'live'].includes(mode)) {
      return sendSkipped(user, signal, mode, 'Binance connection mode is not verified as mock or live');
    }

    // Auto-trade: block any prior attempt (including SKIPPED) to stop spam.
    // Manual entry: only block if a real order already exists (not SKIPPED/FAILED).
    if (isManual) {
      const priorLive = await getExecutionBySignal(signalId, signal.direction || signal.dir, {
        userId,
        exchange: 'binance',
      });
      if (priorLive) {
        const st = String(priorLive.status || '').toUpperCase();
        return {
          skipped: true,
          reason: `Already entered this signal (status: ${st})`,
        };
      }
    } else {
      const prior = await getAnyExecutionBySignal(signalId, signal.direction || signal.dir, {
        userId,
        exchange: 'binance',
      });
      if (prior) {
        logger(userId, mode, signalId, 'already attempted; no retry or Telegram');
        return { skipped: true, silent: true, reason: 'Already attempted this signal' };
      }
    }

    // High Risk is the only risk mode. userSettings.highRisk is the resolved admin config.
    const hr = userSettings.highRisk;
    const cfg = {
      ...baseCfg,
      autoTradingEnabled: true,
      marginPercent: Math.min(
        Number(userSettings.marginPercent) > 0 ? Number(userSettings.marginPercent) : baseCfg.marginPercent,
        baseCfg.maximumMarginPercent
      ),
      defaultLeverage: Math.min(
        Number(userSettings.defaultLeverage) > 0 ? Number(userSettings.defaultLeverage) : baseCfg.defaultLeverage,
        baseCfg.maximumLeverage
      ),
      maxOpenPositions: Number(userSettings.maxOpenPositions) > 0 ? Number(userSettings.maxOpenPositions) : 1000,
      // High Risk: the total-margin cap and the equity guard limit exposure instead of trade counts
      maxDailyTrades: 1000,
      maxDailyLossPercent: 0,
      // Manual market entry: user override — do not require the lifecycle entry-hit path
      requireEntryHit: isManual ? false : baseCfg.requireEntryHit,
      requireSignalReady: isManual ? false : baseCfg.requireSignalReady,
      // Manual: allow entry even if price is back inside the pattern (user clicked Market Entry)
      skipFailedBreakoutGuard: isManual === true,
    };
    const userSignal = { ...signal };
    if (String(userSignal.status || '').toUpperCase() === SIGNAL_STATUS.ONGOING && !userSignal.entry_hit_at) {
      userSignal.entry_hit_at = userSignal.last_updated_at || userSignal.updated_at || new Date().toISOString();
      try {
        await updateSignal(signalId, { entry_hit_at: userSignal.entry_hit_at });
      } catch (error) {
        logger(userId, mode, signalId, 'entry-hit timestamp repair could not be persisted', {
          error: error.message,
        });
      }
    }

    const valid = validateSignalForExecution(userSignal, cfg);
    if (!valid.ok) return sendSkipped(user, userSignal, mode, valid.reason);
    // Manual entry: user explicitly chose market entry — skip failed-breakout / quality soft-blocks
    if (!isManual) {
      if (priceBackInside(userSignal, +userSignal.current_price || +userSignal.last_price)) {
        return sendSkipped(user, userSignal, mode, 'Price back inside pattern (failed breakout)');
      }
      const quality = await confirmEntryQuality(userSignal, cfg);
      if (!quality.ok) return sendSkipped(user, userSignal, mode, `Quality: ${quality.reason}`);
    }

    const expectedBase = mode === 'live' ? 'https://fapi.binance.com' : 'https://testnet.binancefuture.com';
    if (binance.baseUrlForMode(mode) !== expectedBase) {
      return sendSkipped(user, userSignal, mode, 'Binance endpoint/mode mismatch; order blocked');
    }

    const account = await binance.getAccountSummary(keys.apiKey, keys.apiSecret, mode);
    let available = +account.availableBalance || 0;
    let equity = +account.totalMarginBalance || +account.totalWalletBalance || available;
    const positions = await binance.getPositionRisk(keys.apiKey, keys.apiSecret, mode);

    // Starting-capital budget: the wallet may hold far more than the user allotted to the bot.
    // Size every trade from  startingCapital + closed PnL  instead of the whole wallet.
    const capital = getCapital(userSettings, mode);
    let budgetInfo = null;
    if (capital) {
      try {
        await syncClosedTrades({ userId, keys }); // book finished trades so the balance is current
      } catch (error) {
        logger(userId, mode, signalId, 'pnl sync failed before sizing', { error: error.message });
      }
      const ledgerRows = await getLedgerExecutions({ userId, exchange: 'binance', mode }, capital.startedAt);
      const budget = budgetState(capital, ledgerRows, mode);
      const capped = applyBudgetCap({ equity, available }, budget, budget.usedMargin);
      if (capped.exhausted) {
        return sendSkipped(user, userSignal, mode, `Trading capital used up (balance ${budget.balance.toFixed(2)} USDT)`);
      }
      equity = capped.equity;
      available = capped.available;
      budgetInfo = { startingCapital: capital.startingCapital, balance: budget.balance, usedMargin: budget.usedMargin };
    }
    {
      const guard = await applyEquityGuard(userId, equity, hr);
      if (!guard.ok) {
        logger(userId, mode, signalId, 'high-risk guard halted new trades', { reason: guard.reason });
        await recordSkip(user, userSignal, mode, guard.reason);
        // alert once when the brake engages; later signals are skipped quietly
        return { skipped: true, notify: guard.justHalted, reason: guard.reason };
      }
    }
    const risk = await checkRiskLimits(cfg, userId, signal.symbol, equity, positions);
    if (!risk.ok) return sendSkipped(user, userSignal, mode, risk.reason);

    const instrument = await binance.getInstrumentInfo(signal.symbol, mode);
    // exchangeInfo carries no leverage limit, so ask for the symbol's real maximum. Without this the
    // sizing could pick a leverage the symbol does not allow (new / small coins often cap at 20-50x).
    try {
      const symMax = await binance.getMaxLeverage(signal.symbol, keys.apiKey, keys.apiSecret, mode);
      if (symMax) instrument.maxLeverage = Math.min(instrument.maxLeverage, symMax);
    } catch (error) {
      logger(userId, mode, signalId, 'leverage bracket lookup failed (using default cap)', { error: error.message });
    }
    const hedgeMode = await binance.getPositionMode(keys.apiKey, keys.apiSecret, mode);
    const atrPct = signalAtrPercent(signal);

    // When starting-capital budget is on, the total-margin cap must use the bot's
    // own open-trade margins (budget.usedMargin) — not the whole wallet's positions.
    // Otherwise a small budget + any large exchange position reports absurd % like 11419%.
    let usedMargin = await usedMarginUsdt(userId, positions);
    if (budgetInfo && Number.isFinite(+budgetInfo.usedMargin)) {
      usedMargin = Math.max(0, +budgetInfo.usedMargin);
    }
    // Sanity: never treat used margin as > 5× equity for the cap check (data glitch guard)
    if (equity > 0 && usedMargin > equity * 5) {
      logger(userId, mode, signalId, 'usedMargin clamped (implausible vs equity)', {
        usedMargin,
        equity,
      });
      usedMargin = equity * 5;
    }
    const hs = sizeHighRiskTrade({
      equity,
      available,
      usedMargin,
      entry: +userSignal.entry_hit_price || +userSignal.entry,
      sl: +userSignal.sl,
      instrument,
      cfg: hr,
    });
    if (hs.reject) return sendSkipped(user, userSignal, mode, `High Risk: ${hs.reason}`);
    const margin = { margin: hs.margin };
    const leverage = { leverage: hs.leverage };
    const sizing = {
      mode: 'high',
      marginPercent: hs.marginPercent,
      margin: hs.margin,
      leverage: hs.leverage,
      slDistPct: hs.slDistPct,
      lossAtSl: hs.lossAtSl,
      lossAtSlPct: hs.lossAtSlPct,
      limitedBy: hs.limitedBy,
      usedMarginBefore: usedMargin,
      totalMarginAfterPct: hs.totalMarginAfterPct,
    };

    let exchangeSignal = userSignal;
    let rebaseRatio = 1;
    if (mode === 'mock') {
      const mockPrice = await binance.getMarkPrice(signal.symbol, 'mock');
      const rebased = rebaseSignalToExchangePrice(userSignal, mockPrice, 'binanceMock');
      if (!rebased.ok) return sendSkipped(user, userSignal, mode, rebased.reason);
      exchangeSignal = rebased.signal;
      rebaseRatio = rebased.ratio;
    }
    logger(userId, mode, signalId, 'execution prepared', {
      symbol: signal.symbol,
      rebaseRatio,
    });

    const entryPrice = +exchangeSignal.entry_hit_price || +exchangeSignal.entry;
    const quantity = calculateQuantity({
      margin: margin.margin,
      leverage: leverage.leverage,
      entryPrice,
      instrument,
    });
    if (quantity.reject) return sendSkipped(user, userSignal, mode, quantity.reason);
    // report the loss of the quantity that is really sent (after step rounding)
    sizing.lossAtSl = quantity.notional * (sizing.slDistPct / 100);
    sizing.lossAtSlPct = equity > 0 ? (sizing.lossAtSl / equity) * 100 : null;
    sizing.margin = quantity.notional / leverage.leverage;
    lastSizing.set(`${userId}:${signalId}`, sizing);

    const executionPayload = {
      user_id: userId,
      exchange: 'binance',
      mode,
      signal_id: signalId,
      symbol: signal.symbol,
      side: signal.direction || signal.dir,
      status: 'PENDING',
      score: +signal.score || null,
      signal_entry: +signal.entry || null,
      quantity: quantity.qty,
      margin: margin.margin,
      notional: quantity.notional,
      leverage: leverage.leverage,
      tp1: exchangeSignal.tp1 != null ? +exchangeSignal.tp1 : null,
      tp2: exchangeSignal.tp2 != null ? +exchangeSignal.tp2 : null,
      tp3: exchangeSignal.tp3 != null ? +exchangeSignal.tp3 : null,
      sl: exchangeSignal.sl != null ? +exchangeSignal.sl : null,
      atr_pct: atrPct,
      dry_run: false,
      error: null,
      metadata: {
        environment: mode === 'live' ? 'BINANCE LIVE' : 'BINANCE TESTNET',
        orderType: cfg.orderType,
        riskMode: sizing.mode,
        sizing,
        hedgeMode,
        requireEntryHit: !isManual,
        manualEntry: isManual,
        preferredTpLevel: normalizeTpLevel(
          exchangeSignal.metadata?.preferredTpLevel ?? userSettings?.preferredTpLevel ?? 1,
          1
        ),
        activeTpLevel: normalizeTpLevel(
          exchangeSignal.metadata?.preferredTpLevel ?? userSettings?.preferredTpLevel ?? 1,
          1
        ),
        rebaseRatio,
        mainnetLevels: exchangeSignal.metadata?.mainnetLevels || {
          entry: signal.entry,
          entry_hit_price: signal.entry_hit_price ?? null,
          sl: signal.sl ?? null,
          tp1: signal.tp1 ?? null,
          tp2: signal.tp2 ?? null,
          tp3: signal.tp3 ?? null,
        },
        exchangeLevels: exchangeSignal.metadata?.exchangeLevels || {
          entry: exchangeSignal.entry,
          entry_hit_price: exchangeSignal.entry_hit_price ?? null,
          sl: exchangeSignal.sl ?? null,
          tp1: exchangeSignal.tp1 ?? null,
          tp2: exchangeSignal.tp2 ?? null,
          tp3: exchangeSignal.tp3 ?? null,
        },
        available,
        equity,
        budget: budgetInfo,
      },
    };

    let execution;
    try {
      // Manual retry: reuse a prior SKIPPED row (unique index still holds SKIPPED rows)
      if (isManual) {
        const priorAny = await getAnyExecutionBySignal(signalId, signal.direction || signal.dir, {
          userId,
          exchange: 'binance',
        }).catch(() => null);
        const priorSt = String(priorAny?.status || '').toUpperCase();
        if (priorAny && priorSt === 'SKIPPED') {
          execution = await updateExecution(priorAny.id, executionPayload);
        }
      }
      if (!execution) {
        execution = await createExecution(executionPayload);
      }
    } catch (error) {
      logger(userId, mode, signalId, 'execution lock create failed', { error: error.message });
      const existing = await getAnyExecutionBySignal(signalId, signal.direction || signal.dir, {
        userId,
        exchange: 'binance',
      }).catch(() => null);
      if (existing) {
        const st = String(existing.status || '').toUpperCase();
        // Manual: only treat non-skip/fail as a hard lock; auto still blocks everything
        if (!isManual || !['SKIPPED', 'FAILED', 'CANCELLED', 'REJECTED'].includes(st)) {
          return {
            skipped: true,
            silent: !isManual,
            reason: `Already have an execution for this signal (${st || 'unknown'})`,
          };
        }
        // Last resort for manual: force-update the existing SKIPPED/FAILED row
        if (isManual && ['SKIPPED', 'FAILED', 'CANCELLED', 'REJECTED'].includes(st)) {
          try {
            execution = await updateExecution(existing.id, executionPayload);
          } catch (updateErr) {
            return sendSkipped(user, userSignal, mode, `Execution record: ${updateErr.message}`);
          }
        }
      }
      if (!execution) {
        return sendSkipped(user, userSignal, mode, `Execution record: ${error.message}`);
      }
    }

    const dir = signal.direction || signal.dir;
    const orderSide = dir === 'LONG' ? 'BUY' : 'SELL';
    let orderSubmitted = false;
    try {
      await updateExecution(execution.id, {
        status: 'PLACING',
        error: null,
        metadata: { ...execution.metadata, verificationStatus: 'PENDING' },
      });
      await binance.setLeverageSafe(signal.symbol, leverage.leverage, keys.apiKey, keys.apiSecret, mode);
      const order = {
        symbol: signal.symbol,
        side: orderSide,
        type: String(cfg.orderType).toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET',
        quantity: quantity.qty,
      };
      if (hedgeMode) order.positionSide = dir;
      else order.reduceOnly = false;
      if (order.type === 'LIMIT') {
        order.price = binance.roundPriceToTick(entryPrice, instrument.tickSize);
        order.timeInForce = 'GTC';
      }
      orderSubmitted = true;
      const placed = await binance.placeOrder(order, keys.apiKey, keys.apiSecret, mode);
      const orderId = placed?.orderId;
      if (!orderId) {
        const message = 'Binance accepted no verifiable order id; execution state is unknown and retry is blocked';
        await updateExecution(execution.id, {
          status: 'VERIFY_UNKNOWN',
          error: message,
          metadata: { ...execution.metadata, verificationStatus: 'UNKNOWN', placeResponse: placed || null },
        });
        return { unknown: true, reason: message, status: 'VERIFY_UNKNOWN', executionId: execution.id };
      }

      await updateExecution(execution.id, {
        status: 'PLACED',
        entry_order_id: String(orderId),
        error: null,
        metadata: { ...execution.metadata, orderId: String(orderId), verificationStatus: 'PENDING' },
      });

      let verifiedOrder = null;
      let lastError = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          verifiedOrder = await binance.getOrderRealtime(
            { symbol: signal.symbol, orderId },
            keys.apiKey,
            keys.apiSecret,
            mode
          );
          if (verifiedOrder?.orderId === String(orderId)) break;
        } catch (error) {
          lastError = error;
        }
        if (attempt < 5) await sleep(700);
      }
      if (!verifiedOrder?.orderId || verifiedOrder.orderId !== String(orderId)) {
        const message = `Binance accepted the order but verification is unknown${lastError ? `: ${lastError.message}` : ''}`;
        await updateExecution(execution.id, {
          status: 'WAITING_FILL',
          error: message,
          metadata: { ...execution.metadata, verificationStatus: 'UNKNOWN', verificationError: lastError?.message || null },
        });
        return {
          placed: true,
          accepted: true,
          status: 'WAITING_FILL',
          qty: quantity.qty,
          leverage: leverage.leverage,
          reason: message,
        };
      }

      const rawStatus = String(verifiedOrder.status || '').toUpperCase();
      const executedQty = +verifiedOrder.executedQty || 0;
      if (rawStatus === 'REJECTED' || (rawStatus === 'CANCELED' && !executedQty)) {
        const reason = `Binance order ${rawStatus.toLowerCase()}`;
        await updateExecution(execution.id, {
          status: rawStatus === 'REJECTED' ? 'REJECTED' : 'CANCELLED',
          error: reason,
          metadata: { ...execution.metadata, orderStatus: rawStatus, verificationStatus: 'VERIFIED' },
        });
        return { failed: true, cancelled: rawStatus === 'CANCELED', reason, status: rawStatus };
      }
      if (!isFilled(verifiedOrder)) {
        await updateExecution(execution.id, {
          status: 'WAITING_FILL',
          error: null,
          metadata: { ...execution.metadata, orderStatus: rawStatus, verificationStatus: 'VERIFIED', filledQuantity: 0 },
        });
        return { placed: true, status: 'WAITING_FILL', qty: quantity.qty, leverage: leverage.leverage };
      }

      const expectedPositionSide = dir === 'LONG' ? 'Buy' : 'Sell';
      let position = null;
      let positionError = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const positionsNow = await binance.getPositionRisk(keys.apiKey, keys.apiSecret, mode);
          position = positionsNow.find((p) => p.symbol === signal.symbol && p.side === expectedPositionSide && +p.size > 0);
          if (position) break;
        } catch (error) {
          positionError = error;
        }
        if (attempt < 4) await sleep(700);
      }
      const filledAt = verifiedOrder.updateTime
        ? new Date(+verifiedOrder.updateTime).toISOString()
        : new Date().toISOString();
      const fillPrice = +verifiedOrder.avgPrice || +position?.avgPrice || null;
      const filledQuantity = +position?.size || executedQty;
      if (!position) {
        const message = positionError
          ? `Order fill confirmed; position verification unknown: ${positionError.message}`
          : 'Order fill confirmed, but Binance position was not visible during verification';
        await updateExecution(execution.id, {
          status: 'FILLED',
          actual_entry: fillPrice,
          quantity: filledQuantity,
          filled_at: filledAt,
          error: message,
          metadata: {
            ...execution.metadata,
            orderStatus: rawStatus,
            verificationStatus: positionError ? 'UNKNOWN' : 'VERIFIED',
            positionVerification: positionError ? 'UNKNOWN' : 'NOT_FOUND',
            filledQuantity: executedQty,
          },
        });
        return { placed: true, filled: true, waitingPosition: true, status: 'FILLED', qty: filledQuantity, leverage: leverage.leverage, error: message };
      }

      const stopLoss = cfg.slEnabled && exchangeSignal.sl != null
        ? binance.roundPriceToTick(exchangeSignal.sl, instrument.tickSize)
        : null;
      // User-preferred TP level (1/2/3) — default TP1. Manual entry can override via signal.metadata.preferredTpLevel.
      const tpLevel = normalizeTpLevel(
        exchangeSignal.metadata?.preferredTpLevel ?? userSettings?.preferredTpLevel ?? 1,
        1
      );
      const tpPick = resolveTpPrice(exchangeSignal, tpLevel);
      const takeProfit = cfg.tpEnabled && tpPick.price != null
        ? binance.roundPriceToTick(tpPick.price, instrument.tickSize)
        : null;
      const shouldProtect = stopLoss != null || takeProfit != null;
      await updateExecution(execution.id, {
        status: shouldProtect ? 'PROTECTING' : 'FILLED',
        actual_entry: +position.avgPrice || fillPrice,
        quantity: filledQuantity,
        filled_at: filledAt,
        error: null,
        metadata: {
          ...execution.metadata,
          orderStatus: rawStatus,
          verificationStatus: 'VERIFIED',
          positionVerification: 'VERIFIED',
          positionSide: position.side,
          positionSize: position.size,
          avgPrice: +position.avgPrice || fillPrice,
        },
      });

      let protection = { stopLoss: null, takeProfit: null, errors: [] };
      if (shouldProtect) {
        protection = await binance.setStopLossTakeProfit(
          {
            symbol: signal.symbol,
            positionSide: dir,
            stopLoss,
            takeProfit,
            hedgeMode,
            quantity: filledQuantity,
          },
          keys.apiKey,
          keys.apiSecret,
          mode
        );
      }
      const protectedOk = !shouldProtect || (
        (!stopLoss || protection.stopLoss?.algoId) &&
        (!takeProfit || protection.takeProfit?.algoId) &&
        !(protection.errors || []).length
      );
      const finalStatus = !shouldProtect ? 'FILLED' : protectedOk ? 'PROTECTED' : 'UNPROTECTED';
      const protectionError = (protection.errors || []).map((item) => item.message).join('; ') || null;
      await updateExecution(execution.id, {
        status: finalStatus,
        protected_at: protectedOk && shouldProtect ? new Date().toISOString() : null,
        sl_order_id: protection.stopLoss?.algoId ? String(protection.stopLoss.algoId) : null,
        tp1_order_id: protection.takeProfit?.algoId ? String(protection.takeProfit.algoId) : null,
        error: protectionError,
        metadata: {
          ...execution.metadata,
          orderStatus: rawStatus,
          verificationStatus: 'VERIFIED',
          protectionStatus: protectedOk ? (shouldProtect ? 'PROTECTED' : 'NOT_APPLICABLE') : 'PROTECTION_FAILED',
          protectionOrderIds: {
            stopLoss: protection.stopLoss?.algoId || null,
            takeProfit: protection.takeProfit?.algoId || null,
          },
          protectionError,
        },
      });
      logger(userId, mode, signalId, 'trade execution complete', {
        status: finalStatus,
        rebaseRatio,
      });
      return {
        placed: true,
        filled: true,
        protected: protectedOk,
        status: finalStatus,
        qty: filledQuantity,
        leverage: leverage.leverage,
        reason: protectionError,
        executionId: execution.id,
      };
    } catch (error) {
      const message = orderSubmitted
        ? `Execution state is unknown; automatic retry blocked: ${error.message}`
        : `Binance order was not submitted: ${error.message}`;
      await updateExecution(execution.id, {
        status: orderSubmitted ? 'VERIFY_UNKNOWN' : 'FAILED',
        error: message,
        metadata: {
          ...execution.metadata,
          environment: mode === 'live' ? 'BINANCE LIVE' : 'BINANCE TESTNET',
          verificationStatus: orderSubmitted ? 'UNKNOWN' : 'FAILED',
        },
      }).catch(() => {});
      return {
        ...(orderSubmitted ? { unknown: true } : { failed: true }),
        reason: message,
        status: orderSubmitted ? 'VERIFY_UNKNOWN' : 'FAILED',
        executionId: execution.id,
      };
    }
  } catch (error) {
    logger(userId, mode, signalId, 'trade attempt failed before order', { error: error.message });
    return sendSkipped(user, signal, mode, error.message);
  }
}

export async function processBinanceUserAutoTrades() {
  const summary = {
    autoTradingEnabled: false,
    autoTradesAttempted: 0,
    autoTradesPlaced: 0,
    autoTradesSkipped: 0,
    autoTradesFailed: 0,
    reasons: [],
  };

  if (!(await getScanExchanges()).includes('binance')) {
    summary.reasons.push('Binance scanning is disabled in scan_exchanges');
    return summary;
  }

  const [baseCfg, armedUsers, activeSignals] = await Promise.all([
    getAutoTradingConfig(),
    listUsersForAutoTrading('binance'),
    getActiveSignals(),
  ]);
  const signals = activeSignals
    .filter((signal) => signalExchange(signal) === 'binance')
    .filter((signal) => String(signal.status || '').toUpperCase() === SIGNAL_STATUS.ONGOING)
    .sort((a, b) => (+b.score || 0) - (+a.score || 0));
  summary.autoTradingEnabled = armedUsers.length > 0;

  for (const { user, settings } of armedUsers) {
    try {
      const plan = await getPlan(user.plan);
      if (!canAutoTrade(user, plan)) continue;
      const planCap = Number.isFinite(Number(plan?.max_positions))
        ? Math.max(0, Number(plan.max_positions))
        : baseCfg.maxOpenPositions;
      // High Risk is the only risk mode, and it needs the user's one-time confirmation
      // (Trade tab → Risk mode). Until then nothing is traded for this user.
      if (settings.riskMode !== 'high') {
        summary.reasons.push(`user ${user.id}: High Risk mode not confirmed (Trade tab → Risk mode)`);
        continue;
      }
      const hrCfg = resolveHighRiskConfig(baseCfg.highRisk, settings);
      const userRiskSettings = {
        ...settings,
        riskMode: 'high',
        highRisk: hrCfg,
        // High Risk: positions are limited by the total-margin cap; only the PLAN cap still applies.
        maxOpenPositions: planCap > 0 ? planCap : 1000,
      };
      const keys = await getExchangeKeys(user.id, 'binance');
      if (!keys?.apiKey || !keys?.apiSecret) {
        for (const signal of signals) {
          const already = await getAnyExecutionBySignal(signal.signal_id, signal.direction || signal.dir, {
            userId: user.id,
            exchange: 'binance',
          });
          if (already) continue;
          const result = await sendSkipped(user, signal, null, 'No verified Binance API keys are connected');
          summary.autoTradesAttempted += 1;
          summary.autoTradesSkipped += 1;
          summary.reasons.push(`${signal.symbol}: ${result.reason}`);
          await notify(user, noticeText('skipped', signal, null, result.reason), {
            userId: user.id,
            mode: null,
            signalId: signal.signal_id,
          });
        }
        continue;
      }

      for (const signal of signals) {
        const result = await processUserSignal(user, userRiskSettings, signal, baseCfg, keys);
        const sizingInfo = lastSizing.get(`${user.id}:${signal.signal_id}`);
        lastSizing.delete(`${user.id}:${signal.signal_id}`); // never leak entries
        if (result.silent) continue;
        summary.autoTradesAttempted += 1;
        if (result.placed) {
          summary.autoTradesPlaced += 1;
          if (result.error || result.reason) summary.reasons.push(`${signal.symbol}: ${result.error || result.reason}`);
          await notify(user, noticeText('placed', signal, keys.mode, null, { ...result, sizing: sizingInfo }), {
            userId: user.id,
            mode: keys.mode,
            signalId: signal.signal_id,
          });
          try {
            await notifyAdminTradePlaced({
              user,
              signal,
              mode: keys.mode,
              result: { ...result, sizing: sizingInfo },
              manual: false,
              kind: 'placed',
              reason: result.error || result.reason || null,
            });
          } catch (_) {}
        } else if (result.failed || result.unknown) {
          summary.autoTradesFailed += 1;
          const reason = result.reason || 'Binance execution state is unknown';
          summary.reasons.push(`${signal.symbol}: ${reason}`);
          await notify(user, noticeText('failed', signal, keys.mode, reason), {
            userId: user.id,
            mode: keys.mode,
            signalId: signal.signal_id,
          });
          try {
            await notifyAdminTradePlaced({
              user,
              signal,
              mode: keys.mode,
              result,
              manual: false,
              kind: result.unknown ? 'unknown' : 'failed',
              reason,
            });
          } catch (_) {}
        } else {
          summary.autoTradesSkipped += 1;
          if (result.reason) summary.reasons.push(`${signal.symbol}: ${result.reason}`);
          if (result.notify && result.reason) {
            await notify(user, noticeText('skipped', signal, keys.mode, result.reason), {
              userId: user.id,
              mode: keys.mode,
              signalId: signal.signal_id,
            });
          }
          if (result.reason) {
            try {
              await notifyAdminTradePlaced({
                user,
                signal,
                mode: keys.mode,
                result,
                manual: false,
                kind: 'skipped',
                reason: result.reason,
              });
            } catch (_) {}
          }
        }
      }
    } catch (error) {
      console.error('[auto-trade][binance] user batch failed', { userId: user.id, error: error.message });
      summary.reasons.push(`user ${user.id}: ${error.message}`);
    }
  }
  return summary;
}

/**
 * Manual market entry for a READY (or ONGOING) signal on the signed-in user's Binance account.
 * Admin must have manualEntryEnabled; user must have Auto/Pro plan, High Risk confirmed, and keys.
 * Admin board is notified on placed / failed / skipped (with user email + reason).
 */
export async function manualEnterBinanceSignal({ userId, signal, marketPrice }) {
  const baseCfg = await getAutoTradingConfig();
  const user = await getUserById(userId);

  const adminNote = async (kind, reason, opts = {}) => {
    if (!user) return;
    try {
      await notifyAdminTradePlaced({
        user,
        signal: opts.signal || signal,
        mode: opts.mode || null,
        result: opts.result || {},
        manual: true,
        kind,
        reason,
      });
    } catch (_) {}
  };

  if (!baseCfg.manualEntryEnabled) {
    const reason = 'Manual market entry is disabled by admin';
    await adminNote('skipped', reason);
    return { failed: true, reason };
  }

  if (!user) return { failed: true, reason: 'User not found' };

  const plan = await getPlan(user.plan);
  if (!canAutoTrade(user, plan)) {
    const reason = 'Auto-trade plan required for manual entry';
    await adminNote('skipped', reason);
    return { failed: true, reason };
  }

  const settings = await getUserTradingSettings(userId);
  if (settings.riskMode !== 'high') {
    const reason = 'Confirm High Risk mode on the Trade tab first';
    await adminNote('skipped', reason);
    return { failed: true, reason };
  }

  const keys = await getExchangeKeys(userId, 'binance');
  if (!keys?.apiKey || !keys?.apiSecret) {
    const reason = 'Connect Binance API keys first';
    await adminNote('skipped', reason);
    return { failed: true, reason };
  }

  const market =
    marketPrice != null && Number.isFinite(+marketPrice)
      ? +marketPrice
      : +(signal.current_price ?? signal.price ?? signal.entry);
  if (!market || !Number.isFinite(market)) {
    const reason = 'Valid market price required';
    await adminNote('skipped', reason, { mode: keys.mode });
    return { failed: true, reason };
  }

  const status = String(signal.status || '').toUpperCase();
  if (status !== SIGNAL_STATUS.READY && status !== SIGNAL_STATUS.ONGOING) {
    const reason = `Manual entry only for READY signals (got ${status || '—'})`;
    await adminNote('skipped', reason, { mode: keys.mode });
    return { failed: true, reason };
  }

  const hrCfg = resolveHighRiskConfig(baseCfg.highRisk, settings);
  const planCap = Number.isFinite(Number(plan?.max_positions))
    ? Math.max(0, Number(plan.max_positions))
    : baseCfg.maxOpenPositions;

  const userRiskSettings = {
    ...settings,
    riskMode: 'high',
    highRisk: hrCfg,
    maxOpenPositions: planCap > 0 ? planCap : 1000,
  };

  const prepared = {
    ...signal,
    signal_id:
      signal.signal_id ||
      `manual_${signal.symbol}_${signal.direction || signal.dir || 'LONG'}_${Date.now()}`,
    direction: signal.direction || signal.dir || 'LONG',
    status: SIGNAL_STATUS.ONGOING,
    entry_hit_at: new Date().toISOString(),
    entry_hit_price: market,
    current_price: market,
    entry: signal.entry != null ? +signal.entry : market,
    metadata: {
      ...(signal.metadata || {}),
      manualEntry: true,
      manualEntryAt: new Date().toISOString(),
      manualEntryPrice: market,
    },
  };

  const result = await processUserSignal(user, userRiskSettings, prepared, baseCfg, keys, { manual: true });
  const sizingInfo = lastSizing.get(`${userId}:${prepared.signal_id}`);
  lastSizing.delete(`${userId}:${prepared.signal_id}`);

  if (result?.placed || result?.status === 'FILLED' || result?.status === 'PROTECTED' || result?.status === 'PLACED' || result?.status === 'WAITING_FILL') {
    const enriched = { ...result, sizing: sizingInfo };
    try {
      await notify(user, noticeText('placed', prepared, keys.mode, null, enriched), {
        userId,
        mode: keys.mode,
        signalId: prepared.signal_id,
      });
    } catch (_) {}
    await adminNote('placed', result.error || result.reason || null, {
      signal: prepared,
      mode: keys.mode,
      result: enriched,
    });
    return { ok: true, ...enriched };
  }
  if (result?.skipped) {
    const reason = result.reason || 'Skipped';
    await adminNote('skipped', reason, { signal: prepared, mode: keys.mode, result });
    return { skipped: true, reason, ...result };
  }
  if (result?.failed || result?.unknown) {
    const reason = result.reason || 'Order failed';
    await adminNote(result.unknown ? 'unknown' : 'failed', reason, {
      signal: prepared,
      mode: keys.mode,
      result,
    });
    return {
      failed: true,
      reason,
      ...result,
    };
  }
  if (result?.executionId || result?.qty) {
    await adminNote('placed', null, {
      signal: prepared,
      mode: keys.mode,
      result: { ...result, sizing: sizingInfo },
    });
    return { ok: true, ...result };
  }
  const reason = result?.reason || 'Entry failed';
  await adminNote('failed', reason, { signal: prepared, mode: keys.mode, result: result || {} });
  return { failed: true, reason, ...result };
}
