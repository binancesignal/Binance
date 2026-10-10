import { NextResponse } from 'next/server';
import {
  getAutoTradingConfig,
  setAutoTradingConfig,
  AUTO_TRADE_DEFAULTS,
} from '../../../lib/trading/autoConfig.js';
import {
  getOpenExecutions,
  getRecentExecutions,
  getExecutionsToday,
  getExecutionById,
  updateExecution,
} from '../../../lib/database/executions.js';
import { getState } from '../../../lib/database/appState.js';
import { processSignal } from '../../../lib/trading/autoTrader.js';
import { SIGNAL_STATUS } from '../../../lib/config/signalConfig.js';
import {
  setTradingStop,
  closePosition,
  getPositions,
  roundPriceToTick,
  getInstrumentInfo,
} from '../../../lib/bybit/client.js';

export const dynamic = 'force-dynamic';

async function keys() {
  const apiKey = await getState('bybit_api_key', null);
  const apiSecret = await getState('bybit_api_secret', null);
  if (!apiKey || !apiSecret) throw new Error('Bybit keys not configured');
  return { apiKey, apiSecret };
}

function livePositionForExecution(positions, execution) {
  const targetSide = execution.side === 'LONG' ? 'Buy' : 'Sell';
  return (positions || []).find(
    (position) =>
      position.symbol === execution.symbol &&
      position.side === targetSide &&
      Math.abs(Number(position.size)) > 0
  ) || null;
}

function priceMatches(actual, expected, tickSize) {
  const value = Number(actual);
  const target = Number(expected);
  return (
    Number.isFinite(value) &&
    Number.isFinite(target) &&
    value > 0 &&
    target > 0 &&
    Math.abs(value - target) <= Math.max(Number(tickSize) / 2, 1e-10)
  );
}

async function setAndVerifyStops(apiKey, apiSecret, execution, instrument, stopBody) {
  await setTradingStop(apiKey, apiSecret, stopBody);
  let position = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const positions = await getPositions(apiKey, apiSecret);
    position = livePositionForExecution(positions, execution);
    if (
      position &&
      (stopBody.stopLoss == null ||
        priceMatches(position.stopLoss, stopBody.stopLoss, instrument.tickSize)) &&
      (stopBody.takeProfit == null ||
        priceMatches(position.takeProfit, stopBody.takeProfit, instrument.tickSize))
    ) {
      return position;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Bybit accepted the TP/SL request but did not confirm the requested protection on positionIdx=${stopBody.positionIdx}`
  );
}

export async function GET() {
  try {
    const config = await getAutoTradingConfig();
    let open = [];
    let recent = [];
    let today = [];
    let tableReady = true;
    try {
      [open, recent, today] = await Promise.all([
        getOpenExecutions({ exchange: 'bybit' }),
        getRecentExecutions(30, { exchange: 'bybit' }),
        getExecutionsToday({ exchange: 'bybit' }),
      ]);
    } catch (dbErr) {
      tableReady = false;
      console.warn('[auto-trading] executions table?', dbErr.message);
    }
    const todayPnl = today.reduce((s, e) => s + (+e.realized_pnl || 0), 0);
    return NextResponse.json({
      ok: true,
      environment: 'BYBIT TESTNET',
      config,
      defaults: AUTO_TRADE_DEFAULTS,
      openExecutions: open,
      recentExecutions: recent,
      tableReady,
      tableHint: tableReady
        ? null
        : 'Run supabase/migrations/003_trade_executions.sql for auto-trade history',
      today: {
        trades: today.length,
        realizedPnl: todayPnl,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action || 'saveConfig';

    if (action === 'saveConfig') {
      const { action: _, ...partial } = body;
      const config = await setAutoTradingConfig(partial);
      return NextResponse.json({ ok: true, config, msg: 'Auto-trading settings saved' });
    }

    if (action === 'toggle') {
      const config = await setAutoTradingConfig({
        autoTradingEnabled: !!body.enabled,
      });
      return NextResponse.json({
        ok: true,
        config,
        msg: config.autoTradingEnabled ? 'Auto trading ON' : 'Auto trading OFF',
      });
    }

    if (action === 'updateProtection') {
      const { id, sl, tp1, tp2, tp3 } = body;
      const ex = await getExecutionById(id);
      if (!ex) return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
      const entry = +ex.actual_entry || +ex.signal_entry;
      const side = ex.side;
      if (sl != null) {
        if (side === 'LONG' && +sl >= entry) {
          return NextResponse.json({ error: 'LONG SL must be < entry' }, { status: 400 });
        }
        if (side === 'SHORT' && +sl <= entry) {
          return NextResponse.json({ error: 'SHORT SL must be > entry' }, { status: 400 });
        }
      }
      for (const [label, tp] of [['tp1', tp1], ['tp2', tp2], ['tp3', tp3]]) {
        if (tp == null) continue;
        if (side === 'LONG' && +tp <= entry) {
          return NextResponse.json({ error: `${label} must be > entry for LONG` }, { status: 400 });
        }
        if (side === 'SHORT' && +tp >= entry) {
          return NextResponse.json({ error: `${label} must be < entry for SHORT` }, { status: 400 });
        }
      }
      if (!ex.dry_run) {
        const { apiKey, apiSecret } = await keys();
        const inst = await getInstrumentInfo(ex.symbol);
        const position = livePositionForExecution(await getPositions(apiKey, apiSecret), ex);
        if (!position) {
          return NextResponse.json(
            { error: 'No matching live Bybit position; protection was not changed' },
            { status: 409 }
          );
        }
        const stopBody = {
          symbol: ex.symbol,
          positionIdx: Number(position.positionIdx ?? 0),
          tpslMode: 'Full',
          stopLoss:
            sl != null
              ? String(roundPriceToTick(+sl, inst.tickSize))
              : position.stopLoss || undefined,
          takeProfit:
            tp1 != null
              ? String(roundPriceToTick(+tp1, inst.tickSize))
              : position.takeProfit || undefined,
        };
        if (!stopBody.stopLoss && !stopBody.takeProfit) {
          return NextResponse.json(
            { error: 'Set a stop-loss or take-profit before updating protection' },
            { status: 400 }
          );
        }
        const verified = await setAndVerifyStops(apiKey, apiSecret, ex, inst, stopBody);
        const metadata = {
          ...(ex.metadata || {}),
          protectionStatus: 'PROTECTED',
          protectionVerification: 'VERIFIED',
          positionIdx: Number(verified.positionIdx ?? 0),
          stopLoss: verified.stopLoss || null,
          takeProfit: verified.takeProfit || null,
        };
        const patch = {
          status: 'PROTECTED',
          protected_at: new Date().toISOString(),
          metadata,
        };
        if (sl != null) patch.sl = +sl;
        if (tp1 != null) patch.tp1 = +tp1;
        if (tp2 != null) patch.tp2 = +tp2;
        if (tp3 != null) patch.tp3 = +tp3;
        const updated = await updateExecution(id, patch);
        return NextResponse.json({ ok: true, execution: updated, msg: 'Protection verified' });
      }
      const patch = {};
      if (sl != null) patch.sl = +sl;
      if (tp1 != null) patch.tp1 = +tp1;
      if (tp2 != null) patch.tp2 = +tp2;
      if (tp3 != null) patch.tp3 = +tp3;
      const updated = await updateExecution(id, patch);
      return NextResponse.json({ ok: true, execution: updated, msg: 'Protection updated' });
    }

    if (action === 'breakeven') {
      const ex = await getExecutionById(body.id);
      if (!ex) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const be = +ex.actual_entry || +ex.signal_entry;
      if (!ex.dry_run) {
        const { apiKey, apiSecret } = await keys();
        const inst = await getInstrumentInfo(ex.symbol);
        const position = livePositionForExecution(await getPositions(apiKey, apiSecret), ex);
        if (!position) {
          return NextResponse.json(
            { error: 'No matching live Bybit position; breakeven stop was not set' },
            { status: 409 }
          );
        }
        const stopBody = {
          symbol: ex.symbol,
          positionIdx: Number(position.positionIdx ?? 0),
          tpslMode: 'Full',
          stopLoss: String(roundPriceToTick(be, inst.tickSize)),
        };
        if (position.takeProfit) stopBody.takeProfit = position.takeProfit;
        const verified = await setAndVerifyStops(apiKey, apiSecret, ex, inst, stopBody);
        const updated = await updateExecution(ex.id, {
          status: 'PROTECTED',
          protected_at: new Date().toISOString(),
          sl: be,
          metadata: {
            ...(ex.metadata || {}),
            protectionStatus: 'PROTECTED',
            protectionVerification: 'VERIFIED',
            positionIdx: Number(verified.positionIdx ?? 0),
            stopLoss: verified.stopLoss || null,
            takeProfit: verified.takeProfit || null,
          },
        });
        return NextResponse.json({ ok: true, execution: updated, msg: 'Protection verified at breakeven' });
      }
      const updated = await updateExecution(ex.id, { sl: be });
      return NextResponse.json({ ok: true, execution: updated, msg: 'SL → breakeven' });
    }

    if (action === 'close') {
      const ex = await getExecutionById(body.id);
      if (!ex) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!ex.dry_run) {
        const { apiKey, apiSecret } = await keys();
        await closePosition(apiKey, apiSecret, {
          symbol: ex.symbol,
          side: ex.side,
          qty: ex.quantity,
        });
      }
      const updated = await updateExecution(ex.id, {
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
      });
      return NextResponse.json({ ok: true, execution: updated, msg: 'Position close requested' });
    }

    /**
     * Manual "Enter now" — force market entry for one signal at current price.
     * body.signal = signal object from live scan / dashboard
     */
    if (action === 'enterNow') {
      const raw = body.signal;
      if (!raw?.symbol) {
        return NextResponse.json({ error: 'signal.symbol required' }, { status: 400 });
      }
      const market =
        body.marketPrice != null
          ? +body.marketPrice
          : +(raw.current_price ?? raw.price ?? raw.entry);
      if (!market || !Number.isFinite(market)) {
        return NextResponse.json({ error: 'Valid market price required' }, { status: 400 });
      }

      const cfg = await getAutoTradingConfig();
      if (!cfg.autoTradingEnabled) {
        return NextResponse.json(
          { error: 'Auto Trade is OFF — no order placed.' },
          { status: 409 }
        );
      }
      const effective = {
        ...cfg,
        orderType: 'Market',
        requireEntryHit: false, // manual override
        requireSignalReady: false,
      };

      const signal = {
        ...raw,
        signal_id:
          raw.signal_id ||
          `manual_${raw.symbol}_${raw.direction || raw.dir || 'LONG'}_${Date.now()}`,
        direction: raw.direction || raw.dir || 'LONG',
        status: SIGNAL_STATUS.ONGOING,
        entry_hit_at: new Date().toISOString(),
        entry_hit_price: market,
        current_price: market,
        // Keep planned entry for records; fill uses market
        entry: raw.entry != null ? +raw.entry : market,
      };

      const apiKey = await getState('bybit_api_key', null);
      const apiSecret = await getState('bybit_api_secret', null);
      if (!apiKey || !apiSecret) {
        return NextResponse.json(
          { error: 'Bybit API keys not configured' },
          { status: 400 }
        );
      }

      const result = await processSignal(signal, effective, { apiKey, apiSecret });
      if (result.failed) {
        return NextResponse.json(
          { ok: false, error: result.reason || 'Entry failed', result },
          { status: 400 }
        );
      }
      if (result.skipped) {
        return NextResponse.json(
          { ok: false, error: result.reason || 'Skipped', result },
          { status: 400 }
        );
      }
      if (result.unknown || result.status === 'VERIFY_UNKNOWN') {
        return NextResponse.json(
          {
            ok: false,
            error: result.reason || result.error || 'Order state is unknown; do not retry automatically.',
            result,
            testnet: true,
          },
          { status: 202 }
        );
      }
      if (result.status === 'UNPROTECTED') {
        return NextResponse.json(
          {
            ok: false,
            error: result.error || 'Bybit position is live but TP/SL protection was not verified.',
            result,
            testnet: true,
          },
          { status: 502 }
        );
      }
      if (result.waitingPosition || result.status === 'WAITING_FILL') {
        return NextResponse.json(
          {
            ok: true,
            msg: `Bybit TESTNET order accepted; current status: ${result.status}.`,
            result,
            testnet: true,
          },
          { status: 202 }
        );
      }
      return NextResponse.json({
        ok: true,
        msg: `Bybit TESTNET execution ${result.status || 'submitted'} for ${signal.symbol}.`,
        result,
        testnet: true,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
