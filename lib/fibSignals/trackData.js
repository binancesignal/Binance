const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function touches(price, low, high) {
  const level = toNumber(price);
  return level != null && low <= level && high >= level;
}

function candleHasEvent(signal, candle) {
  const low = toNumber(candle.low);
  const high = toNumber(candle.high);
  if (low == null || high == null) return false;

  if (!signal.entryHit && touches(signal.entry, low, high)) return true;

  const targetTouched = [signal.tp1, signal.tp2, signal.tp3]
    .some((target) => touches(target, low, high));
  const stopTouched = touches(signal.sl, low, high);
  return targetTouched && stopTouched;
}

function minuteNeedsTradePath(signal, candle) {
  const low = toNumber(candle.low);
  const high = toNumber(candle.high);
  if (low == null || high == null) return false;

  if (!signal.entryHit && touches(signal.entry, low, high)) return true;

  const targetTouched = [signal.tp1, signal.tp2, signal.tp3]
    .some((target) => touches(target, low, high));
  return targetTouched && touches(signal.sl, low, high);
}

function normalizeTradeResult(result) {
  if (Array.isArray(result)) return { trades: result, complete: true };
  if (!result || typeof result !== 'object') return { trades: [], complete: false };
  return {
    trades: Array.isArray(result.trades) ? result.trades : [],
    complete: result.complete === true,
  };
}

/**
 * Replace event-containing signal candles with 1-minute candles. When a minute
 * contains an entry touch or both a target and the stop, attach ordered
 * aggregate trades so the evaluator can establish the actual path.
 */
export async function refineSignalCandles(signal, candles, deps = {}) {
  const { getKlines, getAggTrades } = deps;
  const ltf = String(signal.ltf || '').toLowerCase();
  const minutes = ltf.endsWith('m')
    ? Number.parseInt(ltf, 10)
    : ltf.endsWith('h')
      ? Number.parseInt(ltf, 10) * 60
      : 1;
  const spanMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
  const refined = [];

  for (const candle of candles || []) {
    const candleTime = toNumber(candle.time);
    if (candleTime == null || !candleHasEvent(signal, candle) || spanMinutes === 1) {
      if (candleTime != null && candleHasEvent(signal, candle) && spanMinutes === 1) {
        refined.push(await attachTradePath(signal, candle, getAggTrades));
      } else {
        refined.push(candle);
      }
      continue;
    }

    const startMs = candleTime * 1000;
    const endMs = startMs + spanMinutes * 60_000 - 1;
    let minuteCandles = [];
    try {
      if (typeof getKlines === 'function') {
        minuteCandles = await getKlines(
          signal.symbol,
          '1m',
          Math.min(spanMinutes + 1, 1500),
          { startTime: startMs, endTime: endMs }
        );
      }
    } catch (_) {
      minuteCandles = [];
    }

    minuteCandles = (minuteCandles || []).filter((minute) => {
      const time = toNumber(minute.time);
      return time != null && time >= candleTime && time < candleTime + spanMinutes * 60;
    });

    if (!minuteCandles.length) {
      refined.push({
        ...candle,
        requiresTradePath: minuteNeedsTradePath(signal, candle),
        refinementUnavailable: true,
      });
      continue;
    }

    for (const minute of minuteCandles) {
      refined.push(candleHasEvent(signal, minute)
        ? await attachTradePath(signal, minute, getAggTrades)
        : minute);
    }
  }

  return refined.sort((a, b) => (+a.time || 0) - (+b.time || 0));
}

async function attachTradePath(signal, candle, getAggTrades) {
  if (!minuteNeedsTradePath(signal, candle)) return candle;
  const time = toNumber(candle.time);
  if (time == null || typeof getAggTrades !== 'function') {
    return { ...candle, requiresTradePath: true, tradesComplete: false };
  }

  try {
    const result = normalizeTradeResult(
      await getAggTrades(signal.symbol, time * 1000, (time + 60) * 1000 - 1)
    );
    const trades = result.trades
      .map((trade) => ({
        price: toNumber(trade.price ?? trade.p),
        time: toNumber(trade.time ?? trade.T ?? trade.timestamp),
        id: trade.id ?? trade.a ?? null,
      }))
      .filter((trade) => trade.price != null && trade.time != null)
      .sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id)));

    return {
      ...candle,
      requiresTradePath: true,
      trades,
      tradesComplete: result.complete,
    };
  } catch (_) {
    return { ...candle, requiresTradePath: true, trades: [], tradesComplete: false };
  }
}
