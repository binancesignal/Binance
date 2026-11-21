/**
 * SK SYSTEM PRO — setup lifecycle tracker (pure).
 *
 * Replays the candles that came AFTER the entry was armed, with the entry / SL / TP levels that were
 * LOCKED when the setup became ENTRY_READY (so an old setup is never re-priced from today's market).
 *
 * Rules (conservative, same spirit as the platform's other strategies):
 *   - entry fills when a later candle's range touches the entry price
 *   - SL / TP1 touched BEFORE the fill → INVALIDATED (SL level reached / missed entry)
 *   - on the fill candle only the SL is checked; SL and a TP inside one candle → SL first
 *   - TPn reached then SL → stays a WIN at the highest TP (outcome TPn_THEN_SL)
 *   - TP3 closes the setup (D_TARGET_REACHED when D was reached as well)
 *   - pre-entry: a 4H close beyond A, or D reached without an entry, invalidates; time limits expire it
 */
import { SK_TERMINAL, stageRank, TF_SEC } from './config.js';

const iso = (sec) => new Date(sec * 1000).toISOString();
const ms = (v) => (v ? Date.parse(v) / 1000 : null);

/** which timeframe to replay: the finest one that still covers the whole age with ≤ 1400 candles */
export function trackingTf(ageSec) {
  for (const tf of ['5m', '15m', '1h', '4h']) if (ageSec / TF_SEC[tf] <= 1400) return tf;
  return '4h';
}

/**
 * @param {object} setup  stored setup (dir, stage, maxStage, status, A, D?, entry, hits, createdAt)
 * @param {object} ctx    { candles: finer candles since armedAt, c4h?: primary candles, price? }
 * @returns {{ patch, events }}
 */
export function evaluateSetup(setup, ctx, nowSec, cfg) {
  const out = { patch: {}, events: [] };
  if (!setup || setup.status === 'CLOSED' || SK_TERMINAL.has(setup.stage)) return out;
  const sign = setup.dir === 'LONG' ? 1 : -1;
  const hits = { ...(setup.hits || {}) };
  const events = [];
  const ev = (stage, at, price, note, type = 'STAGE') => events.push({ setupId: setup.id, type, stage, at: iso(at), price: price ?? null, note: note || null });
  const finish = (stage, outcome, at, reason) => ({
    stage,
    status: 'CLOSED',
    outcome,
    closedAt: iso(at),
    closeReason: reason || null,
  });
  const price = Number.isFinite(+ctx.price) ? +ctx.price : null;

  // ── pre-entry ─────────────────────────────────────────────────────────────────────────────
  if (!setup.entry?.locked) {
    const aTime = setup.A?.time || 0;
    const aPrice = setup.A?.price;
    for (const c of ctx.c4h || []) {
      if (c.time <= aTime) continue;
      const closedBeyondA = sign * (c.close - aPrice) < 0;
      if (closedBeyondA) {
        const note = `4H close ${c.close} beyond A ${aPrice}`;
        ev('INVALIDATED', c.time + (TF_SEC[setup.primaryTf] || 14400), c.close, note);
        return { patch: { ...finish('INVALIDATED', 'INVALID', c.time, note), invalidation: { reason: note, at: iso(c.time) } }, events };
      }
      if (setup.D?.price != null && sign * (c.close - setup.D.price) >= 0) {
        const note = `D ${setup.D.price} reached before any entry`;
        ev('INVALIDATED', c.time, c.close, note);
        return { patch: { ...finish('INVALIDATED', 'INVALID', c.time, note), invalidation: { reason: note, at: iso(c.time) } }, events };
      }
    }
    const created = ms(setup.createdAt) || nowSec;
    if (nowSec - created > cfg.setupExpiryHours * 3600) {
      ev('EXPIRED', nowSec, price, `no entry within ${cfg.setupExpiryHours}h`);
      return { patch: finish('EXPIRED', 'EXPIRED', nowSec, 'setup expired'), events };
    }
    return out;
  }

  // ── entry armed: replay ───────────────────────────────────────────────────────────────────
  const e = setup.entry;
  const touchSl = (c) => (sign === 1 ? c.low <= e.sl : c.high >= e.sl);
  const reach = (c, lvl) => (sign === 1 ? c.high >= lvl : c.low <= lvl);
  const touchEntry = (c) => c.low <= e.price && c.high >= e.price;
  const armed = e.armedAt;
  let fillT = hits.entryAt ? ms(hits.entryAt) : null;
  const tpT = [hits.tp1At ? ms(hits.tp1At) : null, hits.tp2At ? ms(hits.tp2At) : null, hits.tp3At ? ms(hits.tp3At) : null];
  let dT = hits.dAt ? ms(hits.dAt) : null;
  let slT = null;
  let closedAt = null;
  let invalid = null;

  const candles = (ctx.candles || []).filter((c) => c.time >= armed);
  fillT = null;
  tpT[0] = tpT[1] = tpT[2] = null;
  dT = null;
  for (const c of candles) {
    if (fillT == null) {
      const entered = touchEntry(c);
      if (entered) {
        fillT = c.time;
        if (touchSl(c)) {
          slT = c.time;
          closedAt = c.time;
          break;
        }
        continue;
      }
      if (touchSl(c)) {
        invalid = `SL level ${e.sl} reached before the entry filled`;
        closedAt = c.time;
        break;
      }
      if (reach(c, e.tp1)) {
        invalid = `Missed entry — TP1 ${e.tp1} reached before the entry filled`;
        closedAt = c.time;
        break;
      }
      continue;
    }
    // filled — SL first, then targets
    if (touchSl(c)) {
      slT = c.time;
      closedAt = c.time;
      break;
    }
    ['tp1', 'tp2', 'tp3'].forEach((k, i) => {
      if (tpT[i] == null && reach(c, e[k])) tpT[i] = c.time;
    });
    if (dT == null && e.d != null && reach(c, e.d)) dT = c.time;
    if (tpT[2] != null) {
      closedAt = c.time;
      break;
    }
  }

  const maxTp = tpT[2] != null ? 3 : tpT[1] != null ? 2 : tpT[0] != null ? 1 : 0;
  const hitsOut = {
    entryAt: fillT ? iso(fillT) : null,
    tp1At: tpT[0] ? iso(tpT[0]) : null,
    tp2At: tpT[1] ? iso(tpT[1]) : null,
    tp3At: tpT[2] ? iso(tpT[2]) : null,
    dAt: dT ? iso(dT) : null,
    slAt: slT ? iso(slT) : null,
  };

  // milestone events (each recorded once)
  const known = new Set((setup.eventKeys || []).map(String));
  const push = (key, stage, at, price, note) => {
    if (!known.has(key)) ev(stage, at, price, note);
  };
  if (fillT) push('ENTRY_ONGOING', 'ENTRY_ONGOING', fillT, e.price, `entry ${e.price} filled`);
  if (tpT[0]) push('TP1_HIT', 'TP1_HIT', tpT[0], e.tp1, `TP1 ${e.tp1}`);
  if (tpT[1]) push('TP2_HIT', 'TP2_HIT', tpT[1], e.tp2, `TP2 ${e.tp2}`);
  if (tpT[2]) push('TP3_HIT', 'TP3_HIT', tpT[2], e.tp3, `TP3 ${e.tp3}`);
  if (dT) push('D_TARGET_REACHED', 'D_TARGET_REACHED', dT, e.d, `D target ${e.d}`);
  if (slT) push('STOP_LOSS_HIT', 'STOP_LOSS_HIT', slT, e.sl, maxTp ? `stopped after TP${maxTp}` : `SL ${e.sl}`);
  if (invalid) push('INVALIDATED', 'INVALIDATED', closedAt, null, invalid);

  let patch;
  if (invalid) {
    patch = { ...finish('INVALIDATED', 'INVALID', closedAt, invalid), invalidation: { reason: invalid, at: iso(closedAt) } };
  } else if (slT) {
    patch = maxTp ? finish(['TP1_HIT', 'TP2_HIT', 'TP3_HIT'][maxTp - 1], `TP${maxTp}_THEN_SL`, slT, `stopped after TP${maxTp}`) : finish('STOP_LOSS_HIT', 'SL', slT, 'stop loss');
  } else if (tpT[2]) {
    patch = finish(dT ? 'D_TARGET_REACHED' : 'TP3_HIT', dT ? 'D_TARGET' : 'TP3', tpT[2], null);
  } else {
    const created = e.armedAt;
    if (!fillT && nowSec - created > cfg.entryExpiryHours * 3600) {
      push('EXPIRED', 'EXPIRED', nowSec, price, `entry not filled within ${cfg.entryExpiryHours}h`);
      patch = finish('EXPIRED', 'EXPIRED', nowSec, 'entry expired');
    } else {
      patch = {
        stage: !fillT ? 'ENTRY_READY' : maxTp ? ['TP1_HIT', 'TP2_HIT'][maxTp - 1] : 'ENTRY_ONGOING',
        status: 'OPEN',
        outcome: null,
      };
    }
  }
  patch.hits = hitsOut;
  if (price != null) patch.currentPrice = price;
  // never move backwards
  if (setup.maxStage && stageRank(patch.stage) < stageRank(setup.maxStage) && patch.status === 'OPEN') patch.stage = setup.maxStage;
  return { patch, events };
}

/** distance of the live price to the entry, in % (for the lists) */
export function entryDistancePct(setup, price) {
  const e = setup?.entry?.price;
  if (!(e > 0) || !(price > 0)) return null;
  return +(Math.abs(price - e) / e * 100).toFixed(3);
}

/** UI bucket of a stored setup */
export function bucketOf(s) {
  if (s.status === 'CLOSED') {
    if (s.stage === 'INVALIDATED') return 'invalidated';
    if (s.stage === 'EXPIRED') return 'expired';
    return 'completed';
  }
  if (s.stage === 'ENTRY_ONGOING' || s.stage === 'TP1_HIT' || s.stage === 'TP2_HIT') return 'ongoing';
  if (s.stage === 'ENTRY_READY') return 'entry_ready';
  if (s.stage === 'LTF_CONFIRMATION' || s.stage === 'C_ZONE_REACHED') return 'waiting';
  return 'active';
}
