const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiErrorText(error) {
  if (error?.retCode != null) {
    return `Bybit retCode=${error.retCode} retMsg=${error.retMsg || error.message}`;
  }
  return error?.message || String(error);
}

function normalizeOrderStatus(order) {
  const status = String(order?.orderStatus || '').toLowerCase();
  if (status === 'filled') return 'FILLED';
  if (status === 'partiallyfilled' || status === 'partiallyfilledcanceled') {
    return 'PARTIALLY_FILLED';
  }
  if (status === 'cancelled' || status === 'canceled') return 'CANCELLED';
  if (status === 'rejected') return 'REJECTED';
  if (status === 'new' || status === 'created' || status === 'untriggered' || status === 'triggered') {
    return 'WAITING_FILL';
  }
  return 'ACCEPTED';
}

function hasFill(order) {
  return Number(order?.cumExecQty) > 0;
}

function matchingPosition(positions, symbol, orderSide) {
  const wantedSide = orderSide === 'Buy' ? 'Buy' : 'Sell';
  return (positions || []).find(
    (position) =>
      position.symbol === symbol &&
      position.side === wantedSide &&
      Math.abs(Number(position.size)) > 0
  ) || null;
}

function priceMatches(actual, expected, tickSize) {
  const value = Number(actual);
  const target = Number(expected);
  if (!Number.isFinite(value) || !Number.isFinite(target) || value <= 0 || target <= 0) {
    return false;
  }
  return Math.abs(value - target) <= Math.max(Number(tickSize) / 2, 1e-10);
}

function decimalPlaces(value) {
  const text = String(Number(value));
  if (text.includes('e-')) {
    const [mantissa, exponent] = text.split('e-');
    return (mantissa.split('.')[1] || '').length + Number(exponent);
  }
  return (text.split('.')[1] || '').length;
}

function tickPrice(value, tickSize) {
  const price = Number(value);
  const tick = Number(tickSize);
  if (!Number.isFinite(price) || !(tick > 0)) return price;
  return Number((Math.round(price / tick) * tick).toFixed(decimalPlaces(tick)));
}

export async function placeVerifyAndProtect({
  execution,
  signal,
  orderBody,
  api,
  cfg,
  instrument,
  updateExecution,
  logger = () => {},
  timing = {},
}) {
  const orderPolls = timing.orderPolls ?? 8;
  const positionPolls = timing.positionPolls ?? 5;
  const protectionPolls = timing.protectionPolls ?? 4;
  const pollIntervalMs = timing.pollIntervalMs ?? 700;
  let metadata = { ...(execution.metadata || {}) };

  const persist = async (status, orderStatus, protectionStatus, patch = {}) => {
    const metadataPatch = patch.metadata || {};
    const { metadata: _ignored, ...columns } = patch;
    metadata = {
      ...metadata,
      orderStatus,
      protectionStatus,
      ...metadataPatch,
    };
    execution = await updateExecution(execution.id, {
      ...columns,
      status,
      metadata,
    });
    logger('execution status', {
      signalId: signal.signal_id,
      status,
      orderStatus,
      protectionStatus,
    });
    return execution;
  };

  await persist('PLACING', 'PLACING', 'NOT_APPLICABLE', {
    error: null,
    metadata: { environment: 'BYBIT TESTNET', verificationStatus: 'PENDING' },
  });

  let placement;
  try {
    await api.setLeverage(instrument.symbol, cfg.leverage);
    logger('leverage', { symbol: instrument.symbol, leverage: cfg.leverage });
    logger('order request', {
      symbol: orderBody.symbol,
      side: orderBody.side,
      orderType: orderBody.orderType,
      qty: orderBody.qty,
      price: orderBody.price,
      orderLinkId: orderBody.orderLinkId,
    });
    placement = await api.placeOrder(orderBody);
  } catch (error) {
    const rejected = error?.retCode != null;
    const status = rejected ? 'REJECTED' : 'FAILED';
    const message = apiErrorText(error);
    logger('Bybit response', {
      symbol: orderBody.symbol,
      retCode: error?.retCode ?? null,
      retMsg: error?.retMsg || error?.message || 'Request failed',
    });
    await persist(status, status, 'NOT_APPLICABLE', {
      error: message,
      metadata: {
        verificationStatus: rejected ? 'REJECTED' : 'FAILED',
        bybitRetCode: error?.retCode ?? null,
        bybitRetMsg: error?.retMsg || error?.message || 'Request failed',
      },
    });
    return { failed: true, rejected, reason: message, status, executionId: execution.id };
  }

  const orderId = placement?.orderId;
  const orderLinkId = orderBody.orderLinkId || null;
  logger('Bybit response', {
    symbol: orderBody.symbol,
    retCode: placement?.retCode ?? null,
    retMsg: placement?.retMsg || null,
    orderId: orderId || null,
    orderLinkId: placement?.orderLinkId || null,
  });

  if (Number(placement?.retCode) !== 0) {
    const message = `Bybit retCode=${placement?.retCode ?? 'missing'} retMsg=${placement?.retMsg || 'No response message'}`;
    const rejected = placement?.retCode != null;
    const status = rejected ? 'REJECTED' : 'FAILED';
    await persist(status, status, 'NOT_APPLICABLE', {
      error: message,
      metadata: {
        verificationStatus: rejected ? 'REJECTED' : 'FAILED',
        bybitRetCode: placement?.retCode ?? null,
        bybitRetMsg: placement?.retMsg || null,
      },
    });
    return { failed: true, rejected, reason: message, status, executionId: execution.id };
  }

  if (!orderId) {
    const message = `Bybit returned retCode=0 retMsg=${placement?.retMsg || 'OK'} without orderId; order acceptance cannot be verified.`;
    await persist('VERIFY_UNKNOWN', 'ACCEPTED', 'NOT_APPLICABLE', {
      error: message,
      metadata: {
        verificationStatus: 'UNKNOWN',
        bybitRetCode: placement?.retCode ?? 0,
        bybitRetMsg: placement?.retMsg || 'OK',
        orderLinkId,
      },
    });
    return {
      accepted: false,
      unknown: true,
      reason: message,
      status: 'VERIFY_UNKNOWN',
      executionId: execution.id,
    };
  }

  if (orderLinkId && placement.orderLinkId && placement.orderLinkId !== orderLinkId) {
    const message = `Bybit response orderLinkId mismatch (expected ${orderLinkId}, received ${placement.orderLinkId}).`;
    await persist('VERIFY_UNKNOWN', 'ACCEPTED', 'NOT_APPLICABLE', {
      entry_order_id: orderId,
      bybit_order_id: orderId,
      error: message,
      metadata: {
        verificationStatus: 'UNKNOWN',
        bybitRetCode: placement.retCode,
        bybitRetMsg: placement.retMsg || 'OK',
        orderLinkId,
        responseOrderLinkId: placement.orderLinkId,
      },
    });
    return {
      accepted: true,
      unknown: true,
      orderId,
      reason: message,
      status: 'VERIFY_UNKNOWN',
      executionId: execution.id,
    };
  }

  await persist('PLACED', 'ACCEPTED', 'WAITING_POSITION', {
    entry_order_id: orderId,
    bybit_order_id: orderId,
    error: null,
    metadata: {
      orderLinkId,
      bybitRetCode: placement.retCode,
      bybitRetMsg: placement.retMsg || 'OK',
      verificationStatus: 'PENDING',
    },
  });

  let verifiedOrder = null;
  let lastOrderError = null;
  for (let attempt = 0; attempt < orderPolls; attempt += 1) {
    try {
      const found = await api.getOrderRealtime({
        symbol: orderBody.symbol,
        orderId,
        orderLinkId,
      });
      if (found) {
        const orderMatches =
          found.orderId === orderId &&
          (!orderLinkId || found.orderLinkId === orderLinkId);
        if (orderMatches) {
          verifiedOrder = found;
          break;
        }
        lastOrderError = new Error('Bybit returned an order that did not match the submitted identifiers');
      }
    } catch (error) {
      lastOrderError = error;
    }
    if (attempt + 1 < orderPolls) await sleep(pollIntervalMs);
  }

  if (!verifiedOrder) {
    const message = lastOrderError
      ? `Order accepted but verification is unknown: ${apiErrorText(lastOrderError)}`
      : 'Order accepted by Bybit, but no matching realtime/history record appeared during verification.';
    await persist('WAITING_FILL', 'ACCEPTED', 'WAITING_POSITION', {
      error: message,
      metadata: { verificationStatus: 'UNKNOWN', lastVerificationError: lastOrderError?.message || null },
    });
    return {
      placed: true,
      accepted: true,
      filled: false,
      protected: false,
      executionId: execution.id,
      orderId,
      status: 'WAITING_FILL',
      error: message,
    };
  }

  const rawOrderStatus = verifiedOrder.orderStatus || '';
  const orderStatus = normalizeOrderStatus(verifiedOrder);
  const executedQty = Number(verifiedOrder.cumExecQty) || 0;
  logger('order verification', {
    symbol: orderBody.symbol,
    orderId,
    orderStatus: rawOrderStatus || orderStatus,
    cumExecQty: executedQty,
    avgPrice: Number(verifiedOrder.avgPrice) || null,
  });

  if (orderStatus === 'REJECTED' || (orderStatus === 'CANCELLED' && !hasFill(verifiedOrder))) {
    const message =
      verifiedOrder.rejectReason ||
      `Bybit order ${orderStatus.toLowerCase()} (orderStatus=${rawOrderStatus || orderStatus})`;
    await persist(orderStatus, orderStatus, 'NOT_APPLICABLE', {
      error: message,
      metadata: {
        verificationStatus: 'VERIFIED',
        bybitOrderStatus: rawOrderStatus,
        filledQuantity: executedQty,
      },
    });
    return {
      failed: orderStatus === 'REJECTED',
      cancelled: orderStatus === 'CANCELLED',
      accepted: true,
      filled: false,
      protected: false,
      executionId: execution.id,
      orderId,
      status: orderStatus,
      reason: message,
    };
  }

  if (!hasFill(verifiedOrder)) {
    await persist('WAITING_FILL', orderStatus, 'WAITING_POSITION', {
      error: null,
      metadata: {
        verificationStatus: 'VERIFIED',
        bybitOrderStatus: rawOrderStatus,
        filledQuantity: 0,
      },
    });
    return {
      placed: true,
      accepted: true,
      filled: false,
      protected: false,
      executionId: execution.id,
      orderId,
      status: 'WAITING_FILL',
    };
  }

  let position = null;
  let lastPositionError = null;
  for (let attempt = 0; attempt < positionPolls; attempt += 1) {
    try {
      const positions = await api.getPositions();
      position = matchingPosition(positions, orderBody.symbol, orderBody.side);
      if (position) break;
    } catch (error) {
      lastPositionError = error;
    }
    if (attempt + 1 < positionPolls) await sleep(pollIntervalMs);
  }

  const baseFilledStatus = orderStatus === 'FILLED' ? 'FILLED' : 'PARTIALLY_FILLED';
  const fillPrice = Number(verifiedOrder.avgPrice) || Number(position?.avgPrice) || null;
  const actualQty = Number(position?.size) || executedQty;
  logger('position verification', {
    symbol: orderBody.symbol,
    orderId,
    positionSize: position?.size || 0,
    avgPrice: position?.avgPrice || fillPrice,
    positionIdx: position?.positionIdx ?? null,
  });

  if (!position) {
    const message = lastPositionError
      ? `Order fill confirmed; position verification unknown: ${apiErrorText(lastPositionError)}`
      : 'Order fill confirmed, but no matching Bybit position appeared during verification.';
    await persist(baseFilledStatus, orderStatus, 'WAITING_POSITION', {
      actual_entry: fillPrice,
      quantity: actualQty,
      filled_at: verifiedOrder.updatedTime
        ? new Date(Number(verifiedOrder.updatedTime)).toISOString()
        : new Date().toISOString(),
      error: message,
      metadata: {
        verificationStatus: lastPositionError ? 'UNKNOWN' : 'VERIFIED',
        positionVerification: lastPositionError ? 'UNKNOWN' : 'NOT_FOUND',
        bybitOrderStatus: rawOrderStatus,
        filledQuantity: executedQty,
      },
    });
    return {
      placed: true,
      accepted: true,
      filled: true,
      protected: false,
      waitingPosition: true,
      executionId: execution.id,
      orderId,
      status: baseFilledStatus,
      error: message,
    };
  }

  const hasProtection =
    (cfg.slEnabled && signal.sl != null) ||
    (cfg.tpEnabled && signal.tp1 != null);
  await persist('PROTECTING', orderStatus, hasProtection ? 'PROTECTING' : 'NOT_APPLICABLE', {
    actual_entry: Number(position.avgPrice) || fillPrice,
    quantity: actualQty,
    filled_at: verifiedOrder.updatedTime
      ? new Date(Number(verifiedOrder.updatedTime)).toISOString()
      : new Date().toISOString(),
    error: null,
    metadata: {
      verificationStatus: 'VERIFIED',
      positionVerification: 'VERIFIED',
      positionIdx: Number(position.positionIdx ?? 0),
      positionSide: position.side,
      positionSize: Number(position.size),
      avgPrice: Number(position.avgPrice) || fillPrice,
      bybitOrderStatus: rawOrderStatus,
      filledQuantity: executedQty,
    },
  });

  if (!hasProtection) {
    await persist(baseFilledStatus, orderStatus, 'NOT_APPLICABLE', { error: null });
    return {
      placed: true,
      accepted: true,
      filled: true,
      protected: false,
      executionId: execution.id,
      orderId,
      status: baseFilledStatus,
    };
  }

  const stopBody = {
    symbol: orderBody.symbol,
    positionIdx: Number(position.positionIdx ?? 0),
    tpslMode: 'Full',
  };
  const expectedStop = cfg.slEnabled && signal.sl != null
    ? String(tickPrice(signal.sl, instrument.tickSize))
    : null;
  const expectedTakeProfit = cfg.tpEnabled && signal.tp1 != null
    ? String(tickPrice(signal.tp1, instrument.tickSize))
    : null;
  if (expectedStop) stopBody.stopLoss = expectedStop;
  if (expectedTakeProfit) stopBody.takeProfit = expectedTakeProfit;

  try {
    logger('TP/SL request', {
      symbol: stopBody.symbol,
      positionIdx: stopBody.positionIdx,
      tpslMode: stopBody.tpslMode,
      stopLoss: stopBody.stopLoss || null,
      takeProfit: stopBody.takeProfit || null,
    });
    const stopResponse = await api.setTradingStop(stopBody);
    logger('TP/SL response', {
      retCode: stopResponse?.retCode ?? 0,
      retMsg: stopResponse?.retMsg || 'OK',
    });
  } catch (error) {
    const message = apiErrorText(error);
    let stillOpen = null;
    let positionCheckError = null;
    try {
      stillOpen = matchingPosition(
        await api.getPositions(),
        orderBody.symbol,
        orderBody.side
      );
    } catch (checkError) {
      positionCheckError = checkError;
    }
    if (!stillOpen) {
      if (positionCheckError) {
        const unknownMessage =
          `TP/SL request failed (${message}) and live-position state is unknown: ${apiErrorText(positionCheckError)}`;
        await persist('VERIFY_UNKNOWN', orderStatus, 'VERIFY_UNKNOWN', {
          error: unknownMessage,
          metadata: {
            protectionError: message,
            positionVerification: 'UNKNOWN',
            protectionVerification: 'UNKNOWN',
          },
        });
        return {
          placed: true,
          accepted: true,
          filled: true,
          protected: false,
          unknown: true,
          executionId: execution.id,
          orderId,
          status: 'VERIFY_UNKNOWN',
          error: unknownMessage,
        };
      }
      await persist(baseFilledStatus, orderStatus, 'NOT_APPLICABLE', {
        error: `Protection was not applied because the position is no longer open: ${message}`,
        metadata: { protectionError: message, positionVerification: 'CLOSED' },
      });
      return {
        placed: true,
        accepted: true,
        filled: true,
        protected: false,
        executionId: execution.id,
        orderId,
        status: baseFilledStatus,
        error: message,
      };
    }
    await persist('UNPROTECTED', orderStatus, 'PROTECTION_FAILED', {
      error: message,
      metadata: {
        protectionError: message,
        positionVerification: 'VERIFIED',
        positionIdx: Number(stillOpen.positionIdx ?? 0),
        positionSize: Number(stillOpen.size),
      },
    });
    return {
      placed: true,
      accepted: true,
      filled: true,
      protected: false,
      executionId: execution.id,
      orderId,
      status: 'UNPROTECTED',
      error: message,
    };
  }

  let protectedPosition = null;
  let lastProtectionError = null;
  for (let attempt = 0; attempt < protectionPolls; attempt += 1) {
    try {
      const positions = await api.getPositions();
      protectedPosition = matchingPosition(positions, orderBody.symbol, orderBody.side);
      if (
        protectedPosition &&
        (!expectedStop || priceMatches(protectedPosition.stopLoss, expectedStop, instrument.tickSize)) &&
        (!expectedTakeProfit ||
          priceMatches(protectedPosition.takeProfit, expectedTakeProfit, instrument.tickSize))
      ) {
        break;
      }
    } catch (error) {
      lastProtectionError = error;
    }
    if (attempt + 1 < protectionPolls) await sleep(pollIntervalMs);
  }

  if (
    protectedPosition &&
    (!expectedStop || priceMatches(protectedPosition.stopLoss, expectedStop, instrument.tickSize)) &&
    (!expectedTakeProfit ||
      priceMatches(protectedPosition.takeProfit, expectedTakeProfit, instrument.tickSize))
  ) {
    await persist('PROTECTED', orderStatus, 'PROTECTED', {
      protected_at: new Date().toISOString(),
      actual_entry: Number(protectedPosition.avgPrice) || fillPrice,
      quantity: Number(protectedPosition.size) || actualQty,
      error: null,
      metadata: {
        positionVerification: 'VERIFIED',
        protectionVerification: 'VERIFIED',
        positionIdx: Number(protectedPosition.positionIdx ?? 0),
        positionSize: Number(protectedPosition.size),
        avgPrice: Number(protectedPosition.avgPrice) || fillPrice,
        stopLoss: protectedPosition.stopLoss || null,
        takeProfit: protectedPosition.takeProfit || null,
      },
    });
    return {
      placed: true,
      accepted: true,
      filled: true,
      protected: true,
      executionId: execution.id,
      orderId,
      status: 'PROTECTED',
      quantity: Number(protectedPosition.size) || actualQty,
      actualEntry: Number(protectedPosition.avgPrice) || fillPrice,
    };
  }

  let positionStillOpen = protectedPosition;
  if (!positionStillOpen) {
    try {
      positionStillOpen = matchingPosition(
        await api.getPositions(),
        orderBody.symbol,
        orderBody.side
      );
    } catch (error) {
      lastProtectionError = lastProtectionError || error;
    }
  }
  if (!positionStillOpen) {
    const message = lastProtectionError
      ? `TP/SL was submitted, but position/protection verification is unknown: ${apiErrorText(lastProtectionError)}`
      : 'TP/SL was submitted, but Bybit no longer reports an open position.';
    const verificationUnknown = !!lastProtectionError;
    await persist(
      verificationUnknown ? 'VERIFY_UNKNOWN' : baseFilledStatus,
      orderStatus,
      verificationUnknown ? 'VERIFY_UNKNOWN' : 'NOT_APPLICABLE',
      {
      error: message,
      metadata: {
        protectionVerification: verificationUnknown ? 'UNKNOWN' : 'CLOSED',
        positionVerification: verificationUnknown ? 'UNKNOWN' : 'CLOSED',
      },
      }
    );
    return {
      placed: true,
      accepted: true,
      filled: true,
      protected: false,
      unknown: verificationUnknown,
      executionId: execution.id,
      orderId,
      status: verificationUnknown ? 'VERIFY_UNKNOWN' : baseFilledStatus,
      error: message,
    };
  }

  const protectionError = lastProtectionError
    ? apiErrorText(lastProtectionError)
    : `Bybit position does not confirm requested TP/SL (stopLoss=${positionStillOpen.stopLoss || 'unset'}, takeProfit=${positionStillOpen.takeProfit || 'unset'}).`;
  await persist('UNPROTECTED', orderStatus, 'PROTECTION_FAILED', {
    error: protectionError,
    metadata: {
      protectionError,
      positionVerification: 'VERIFIED',
      protectionVerification: 'FAILED',
      positionIdx: Number(positionStillOpen.positionIdx ?? 0),
      positionSize: Number(positionStillOpen.size),
      stopLoss: positionStillOpen.stopLoss || null,
      takeProfit: positionStillOpen.takeProfit || null,
    },
  });
  return {
    placed: true,
    accepted: true,
    filled: true,
    protected: false,
    executionId: execution.id,
    orderId,
    status: 'UNPROTECTED',
    error: protectionError,
  };
}
