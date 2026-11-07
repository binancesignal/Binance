/**
 * Pure outcome tracker for a stored Fib Signal.
 *
 * Price touches are processed in timestamp order. A candle that touches both
 * a target and the stop is never resolved from OHLC alone: the caller must
 * attach a complete aggregate-trade path, otherwise tracking pauses at that
 * candle without changing its outcome flags.
 */
const num = (value) => {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

function priceReached(dirLong, price, level, target) {
  const value = num(price);
  const threshold = num(level);
  if (value == null || threshold == null) return false;
  if (target) return dirLong ? value >= threshold : value <= threshold;
  return dirLong ? value <= threshold : value >= threshold;
}

function touchedByRange(dirLong, low, high, level, target) {
  const threshold = num(level);
  if (threshold == null) return false;
  return target
    ? (dirLong ? high >= threshold : low <= threshold)
    : (dirLong ? low <= threshold : high >= threshold);
}

function closePatch(state, reason, timeMs, fallbackSec) {
  state.status = 'CLOSED';
  state.closeReason = reason;
  state.closedAt = new Date(timeMs || fallbackSec * 1000).toISOString();
  if (reason === 'TP3') {
    state.tp1Hit = true;
    state.tp2Hit = true;
    state.tp3Hit = true;
    state.slHit = false;
  }
  if (reason === 'SL') {
    state.slHit = true;
    state.tp3Hit = false;
  }
}

function applyTrades(signal, candle, state, dirLong, levels, nowSec) {
  const trades = (candle.trades || [])
    .map((trade) => ({
      price: num(trade.price ?? trade.p),
      time: num(trade.time ?? trade.T ?? trade.timestamp),
    }))
    .filter((trade) => trade.price != null && trade.time != null)
    .sort((a, b) => a.time - b.time);

  if (candle.tradesComplete !== true || !trades.length) {
    return { issue: 'TRADE_PATH_UNAVAILABLE' };
  }

  const entry = num(signal.entry);
  const stop = num(signal.sl);
  if (entry == null || stop == null || levels.some((level) => level == null)) {
    return { issue: 'INVALID_LEVELS' };
  }

  for (const trade of trades) {
    const { price, time } = trade;

    if (!state.entryHit) {
      const entered = dirLong ? price <= entry : price >= entry;
      if (entered) {
        state.entryHit = true;
        state.entryTime = time;
        state.entryTimeExact = true;
      } else if (priceReached(dirLong, price, levels[0], true)) {
        closePatch(state, 'MISSED', time, nowSec);
        return { closed: true };
      }
    }

    if (!state.entryHit) continue;

    const stopHit = priceReached(dirLong, price, stop, false);
    const targetHits = levels.map((level) => priceReached(dirLong, price, level, true));
    const tp3Hit = targetHits[2];

    // Valid signal levels cannot put TP3 and SL on the same executed price.
    // If stored levels are malformed, leave the path unresolved rather than
    // reporting a result that the price record cannot establish.
    if (stopHit && tp3Hit) return { issue: 'INVALID_LEVEL_ORDER' };

    if (tp3Hit) {
      closePatch(state, 'TP3', time, nowSec);
      return { closed: true };
    }
    if (stopHit) {
      closePatch(state, 'SL', time, nowSec);
      return { closed: true };
    }
    if (targetHits[0]) state.tp1Hit = true;
    if (targetHits[1]) state.tp2Hit = true;
  }

  return { closed: false };
}

/** @returns {{patch: object, closed: boolean}} */
export function evaluateFibSignal(sig, candles, nowSec = Math.floor(Date.now() / 1000), opts = {}) {
  const isLong = String(sig.dir || '').toUpperCase() === 'LONG';
  const entry = num(sig.entry);
  const stop = num(sig.sl);
  const levels = [num(sig.tp1), num(sig.tp2), num(sig.tp3)];
  const createdSec = Math.floor(Date.parse(sig.createdAt) / 1000) || 0;
  const state = {
    entryHit: !!sig.entryHit,
    entryTime: sig.entryTime || null,
    entryTimeExact: !!sig.entryTimeExact,
    tp1Hit: !!sig.tp1Hit,
    tp2Hit: !!sig.tp2Hit,
    tp3Hit: !!sig.tp3Hit,
    slHit: !!sig.slHit,
  };

  let evalFrom = Math.max(+sig.evalFrom || 0, createdSec);
  let trackingIssue = null;
  let trackingIssueAt = null;

  // Final results are immutable, including legacy closed rows.
  if (String(sig.status || '').toUpperCase() === 'CLOSED') {
    return {
      patch: {
        ...state,
        status: sig.status,
        closeReason: sig.closeReason || null,
        closedAt: sig.closedAt || null,
        evalFrom,
      },
      closed: true,
    };
  }

  for (const candle of candles || []) {
    const time = num(candle.time);
    const high = num(candle.high);
    const low = num(candle.low);
    if (time == null || high == null || low == null || time < evalFrom) continue;

    const entryTouched = entry != null && low <= entry && high >= entry;
    const targetTouched = levels.map((level) =>
      level != null && touchedByRange(isLong, low, high, level, true)
    );
    const stopTouched = stop != null && touchedByRange(isLong, low, high, stop, false);
    const needsTradePath =
      candle.requiresTradePath === true ||
      (!state.entryHit && entryTouched) ||
      (stopTouched && targetTouched.some(Boolean));

    if (needsTradePath) {
      const path = applyTrades(sig, candle, state, isLong, levels, nowSec);
      if (path.issue) {
        trackingIssue = path.issue;
        trackingIssueAt = time;
        evalFrom = time;
        break;
      }
      if (path.closed) {
        evalFrom = time + 1;
        break;
      }
      evalFrom = time + 1;
      continue;
    }

    if (!state.entryHit) {
      const missed = isLong
        ? low > entry && targetTouched[0]
        : high < entry && targetTouched[0];
      if (missed) {
        closePatch(state, 'MISSED', time * 1000, nowSec);
        evalFrom = time + 1;
        break;
      }
      evalFrom = time + 1;
      continue;
    }

    if (stopTouched) {
      closePatch(state, 'SL', time * 1000, nowSec);
      evalFrom = time + 1;
      break;
    }

    if (targetTouched[0]) state.tp1Hit = true;
    if (targetTouched[1]) state.tp2Hit = true;
    if (targetTouched[2]) {
      closePatch(state, 'TP3', time * 1000, nowSec);
      evalFrom = time + 1;
      break;
    }
    evalFrom = time + 1;
  }

  if (!state.closeReason && !trackingIssue) {
    const ageDays = (nowSec - createdSec) / 86400;
    const limit = state.entryHit ? 30 : opts.expireDays > 0 ? opts.expireDays : 0;
    if (limit > 0 && ageDays > limit) closePatch(state, 'EXPIRED', nowSec * 1000, nowSec);
  }

  return {
    patch: {
      ...state,
      evalFrom,
      trackingIssue,
      trackingIssueAt,
      _lastCheckedAt: nowSec * 1000,
      ...(state.closeReason ? {
        status: 'CLOSED',
        closeReason: state.closeReason,
        closedAt: state.closedAt,
      } : {}),
    },
    closed: !!state.closeReason,
  };
}

export function outcomeLabel(sig) {
  if (sig.closeReason === 'TP3' || (sig.tp3Hit && sig.status !== 'ACTIVE')) return 'TP3 ✓';
  if (sig.closeReason === 'SL' || (sig.slHit && sig.status !== 'ACTIVE')) {
    if (sig.tp2Hit) return 'TP2 → SL';
    if (sig.tp1Hit) return 'TP1 → SL';
    return 'SL hit';
  }
  if (sig.closeReason === 'INVALID') return 'Invalid';
  if (sig.closeReason === 'TOUCHED') return 'Fib touched';
  if (sig.closeReason === 'MISSED') return 'Missed (no fill)';
  if (sig.closeReason === 'EXPIRED') return 'Expired';
  if (sig.trackingIssue) return 'Path unconfirmed';
  if (sig.status === 'ACTIVE' || !sig.closeReason) {
    if (sig.tp3Hit) return 'TP3 ✓';
    if (sig.tp2Hit) return 'TP2 ✓';
    if (sig.tp1Hit) return 'TP1 ✓';
    if (sig.entryHit) return 'Entry reached';
    return 'Watching';
  }
  return 'Closed';
}
