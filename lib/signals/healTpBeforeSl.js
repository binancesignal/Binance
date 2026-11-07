/**
 * Heal old STOPPED trades that were stored as a pure SL even though TP1/TP2 had been
 * touched before the stop.
 *
 * Why they exist: the monitor used to look at one forming 5m candle per tick, so a TP touch
 * between two ticks never set tp1_hit; the later SL then looked like a "pure SL".
 *
 * What it does: re-reads the candles between ENTRY and the stop-out for every recent STOPPED
 * trade that has no TP flag yet, walks them in time order and, if a TP was reached before
 * (or in the same candle as) the SL, writes tp1_hit / tp2_hit / tp3_hit (+ timestamps).
 * Results / Telegram / signal cards then count it as TP (never as SL).
 *
 * Every trade is checked once (metadata.tpHealChecked). When nothing is left the job
 * sleeps for 6h so it costs nothing on the normal cron runs.
 */
import { getClosedTradesSince, updateSignal } from '../database/signals.js';
import { getState, setState } from '../database/appState.js';
import { getKlines } from '../exchange/index.js';
import { SIGNAL_STATUS } from '../config/signalConfig.js';
import { scanPathHits, toMs } from './pathRange.js';

export const HEAL_STATE_KEY = 'tp_heal_state';
const IDLE_MS = 6 * 3600 * 1000;

function needsHeal(s) {
  if (String(s.status || '').toUpperCase() !== SIGNAL_STATUS.STOPPED) return false;
  if (s.tp1_hit || s.tp2_hit || s.tp3_hit) return false;
  if (s.metadata?.tpHealChecked) return false;
  return true;
}

export async function healTpBeforeSl({ days = 30, limit = 8, budgetMs = 20000, force = false } = {}) {
  const started = Date.now();
  const state = (await getState(HEAL_STATE_KEY, null)) || {};
  if (!force && state.idleUntil && +state.idleUntil > Date.now()) {
    return { ok: true, skipped: true, reason: 'idle', idleUntil: state.idleUntil };
  }

  const closed = await getClosedTradesSince(days);
  const todo = closed.filter(needsHeal);
  const out = { ok: true, candidates: todo.length, checked: 0, healed: 0, details: [], remaining: 0 };

  for (const sig of todo) {
    if (out.checked >= limit || Date.now() - started > budgetMs) break;
    out.checked++;
    const sinceMs = toMs(sig.entry_hit_at || sig.ready_at);
    const endMs = toMs(sig.stopped_at || sig.completed_at || sig.last_updated_at);
    let hits = null;
    let error = null;
    if (sinceMs != null && endMs != null && endMs > sinceMs) {
      try {
        const span = endMs - sinceMs;
        const iv = span <= 20 * 3600 * 1000 ? '5m' : '15m';
        const ivMs = iv === '5m' ? 300000 : 900000;
        const candles = await getKlines(
          sig.symbol,
          iv,
          Math.min(1000, Math.ceil(span / ivMs) + 6),
          {
            includeForming: true,
            startTime: Math.floor(sinceMs / ivMs) * ivMs,
            endTime: endMs + 2 * ivMs,
          }
        );
        hits = scanPathHits(sig, candles, sinceMs, ivMs);
      } catch (e) {
        error = e.message;
      }
    }
    if (error) {
      // network / ban problem — leave it for the next run instead of marking it checked
      out.details.push({ signal_id: sig.signal_id, symbol: sig.symbol, error });
      continue;
    }

    const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
    const updates = {
      metadata: {
        ...(sig.metadata || {}),
        tpHealChecked: true,
        ...(hits?.tp1
          ? { tpHealed: { at: new Date().toISOString(), tp1: !!hits.tp1, tp2: !!hits.tp2, tp3: !!hits.tp3 } }
          : {}),
      },
    };
    if (hits?.tp1) {
      updates.tp1_hit = true;
      updates.tp1_hit_at = sig.tp1_hit_at || iso(hits.tp1At);
      if (hits.tp2) {
        updates.tp2_hit = true;
        updates.tp2_hit_at = sig.tp2_hit_at || iso(hits.tp2At);
      }
      if (hits.tp3) {
        updates.tp3_hit = true;
        updates.tp3_hit_at = sig.tp3_hit_at || iso(hits.tp3At);
      }
      out.healed++;
    }
    try {
      await updateSignal(sig.signal_id, updates);
      out.details.push({
        signal_id: sig.signal_id,
        symbol: sig.symbol,
        healed: !!hits?.tp1,
        level: hits?.tp3 ? 'TP3' : hits?.tp2 ? 'TP2' : hits?.tp1 ? 'TP1' : null,
      });
    } catch (e) {
      out.details.push({ signal_id: sig.signal_id, symbol: sig.symbol, error: e.message });
    }
  }

  out.remaining = Math.max(0, todo.length - out.checked);
  try {
    await setState(HEAL_STATE_KEY, {
      lastRunAt: new Date().toISOString(),
      lastHealed: out.healed,
      lastChecked: out.checked,
      remaining: out.remaining,
      idleUntil: out.remaining === 0 && out.checked === todo.length ? Date.now() + IDLE_MS : null,
    });
  } catch (_) {}
  return out;
}
