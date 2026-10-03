import test from 'node:test';
import assert from 'node:assert/strict';
import { placeVerifyAndProtect } from '../lib/trading/orderExecutionFlow.js';

function setup(apiOverrides = {}) {
  let row = {
    id: 'execution-test-1',
    status: 'PENDING',
    metadata: { environment: 'BYBIT TESTNET' },
  };
  const writes = [];
  const api = {
    setLeverage: async () => ({ retCode: 0 }),
    placeOrder: async () => ({
      retCode: 0,
      retMsg: 'OK',
      orderId: 'bybit-order-1',
      orderLinkId: 'test-link-1',
    }),
    getOrderRealtime: async () => ({
      orderId: 'bybit-order-1',
      orderLinkId: 'test-link-1',
      orderStatus: 'New',
      cumExecQty: '0',
    }),
    getPositions: async () => [],
    setTradingStop: async () => ({ retCode: 0, retMsg: 'OK' }),
    ...apiOverrides,
  };
  const updateExecution = async (id, patch) => {
    assert.equal(id, row.id);
    row = { ...row, ...patch };
    writes.push({ ...row });
    return row;
  };
  const common = {
    execution: row,
    signal: { signal_id: 'signal-test-1', sl: 95, tp1: 110 },
    orderBody: {
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Market',
      qty: 0.01,
      orderLinkId: 'test-link-1',
    },
    api,
    cfg: { leverage: 2, slEnabled: true, tpEnabled: true },
    instrument: { symbol: 'BTCUSDT', tickSize: 0.5 },
    updateExecution,
    timing: { orderPolls: 1, positionPolls: 1, protectionPolls: 1, pollIntervalMs: 0 },
  };
  return { common, api, writes, getRow: () => row };
}

test('retCode success without orderId is unknown, not a fill', async () => {
  const { common, writes, getRow } = setup({
    placeOrder: async () => ({ retCode: 0, retMsg: 'OK', orderLinkId: 'test-link-1' }),
    getOrderRealtime: async () => {
      assert.fail('must not look up an order without its exchange orderId');
    },
  });

  const result = await placeVerifyAndProtect(common);

  assert.equal(result.status, 'VERIFY_UNKNOWN');
  assert.equal(getRow().status, 'VERIFY_UNKNOWN');
  assert.equal(getRow().actual_entry, undefined);
  assert.match(getRow().error, /without orderId/);
  assert.equal(writes.some((write) => write.status === 'FILLED'), false);
});

test('accepted but unfilled order remains WAITING_FILL and is not protected', async () => {
  const { common, api } = setup();
  let positionCalls = 0;
  let stopCalls = 0;
  api.getPositions = async () => {
    positionCalls += 1;
    return [];
  };
  api.setTradingStop = async () => {
    stopCalls += 1;
    return { retCode: 0 };
  };

  const result = await placeVerifyAndProtect(common);

  assert.equal(result.status, 'WAITING_FILL');
  assert.equal(result.filled, false);
  assert.equal(positionCalls, 0);
  assert.equal(stopCalls, 0);
});

test('an exchange order with a different orderLinkId is not treated as this execution', async () => {
  const { common, getRow } = setup({
    getOrderRealtime: async () => ({
      orderId: 'bybit-order-1',
      orderLinkId: 'different-execution',
      orderStatus: 'Filled',
      cumExecQty: '0.01',
      avgPrice: '100',
    }),
  });

  const result = await placeVerifyAndProtect(common);

  assert.equal(result.status, 'WAITING_FILL');
  assert.equal(getRow().metadata.verificationStatus, 'UNKNOWN');
  assert.equal(getRow().actual_entry, undefined);
});

test('verified fill without a live position is not marked protected', async () => {
  const { common, api, getRow } = setup({
    getOrderRealtime: async () => ({
      orderId: 'bybit-order-1',
      orderLinkId: 'test-link-1',
      orderStatus: 'Filled',
      cumExecQty: '0.01',
      avgPrice: '100',
    }),
  });
  let stopCalls = 0;
  api.setTradingStop = async () => {
    stopCalls += 1;
    return { retCode: 0 };
  };

  const result = await placeVerifyAndProtect(common);

  assert.equal(result.status, 'FILLED');
  assert.equal(result.filled, true);
  assert.equal(result.protected, false);
  assert.equal(getRow().status, 'FILLED');
  assert.equal(stopCalls, 0);
});

test('protection uses the verified positionIdx and requires TP/SL confirmation', async () => {
  let protection = null;
  const position = () => ({
    symbol: 'BTCUSDT',
    side: 'Buy',
    size: 0.01,
    avgPrice: 100.25,
    positionIdx: 1,
    stopLoss: protection?.stopLoss || null,
    takeProfit: protection?.takeProfit || null,
  });
  const { common, api, getRow } = setup({
    getOrderRealtime: async () => ({
      orderId: 'bybit-order-1',
      orderLinkId: 'test-link-1',
      orderStatus: 'Filled',
      cumExecQty: '0.01',
      avgPrice: '100.25',
    }),
  });
  api.getPositions = async () => [position()];
  api.setTradingStop = async (body) => {
    protection = body;
    return { retCode: 0, retMsg: 'OK' };
  };

  const result = await placeVerifyAndProtect(common);

  assert.equal(result.status, 'PROTECTED');
  assert.equal(result.protected, true);
  assert.equal(protection.positionIdx, 1);
  assert.equal(protection.tpslMode, 'Full');
  assert.equal(protection.stopLoss, '95');
  assert.equal(protection.takeProfit, '110');
  assert.equal(getRow().metadata.protectionVerification, 'VERIFIED');
  assert.equal(getRow().metadata.positionIdx, 1);
});

test('a live position after a rejected TP/SL request is recorded as UNPROTECTED', async () => {
  const { common, api, getRow } = setup({
    getOrderRealtime: async () => ({
      orderId: 'bybit-order-1',
      orderLinkId: 'test-link-1',
      orderStatus: 'Filled',
      cumExecQty: '0.01',
      avgPrice: '100',
    }),
    getPositions: async () => [{
      symbol: 'BTCUSDT',
      side: 'Buy',
      size: 0.01,
      avgPrice: 100,
      positionIdx: 1,
      stopLoss: null,
      takeProfit: null,
    }],
  });
  api.setTradingStop = async () => {
    const error = new Error('Bybit retCode=110001 retMsg=Invalid stop price');
    error.retCode = 110001;
    error.retMsg = 'Invalid stop price';
    throw error;
  };

  const result = await placeVerifyAndProtect(common);

  assert.equal(result.status, 'UNPROTECTED');
  assert.equal(result.protected, false);
  assert.equal(getRow().status, 'UNPROTECTED');
  assert.equal(getRow().metadata.protectionStatus, 'PROTECTION_FAILED');
  assert.equal(getRow().error, 'Bybit retCode=110001 retMsg=Invalid stop price');
});

test('Bybit rejection records the exact retCode and retMsg', async () => {
  const { common, getRow } = setup({
    placeOrder: async () => ({
      retCode: 110007,
      retMsg: 'Insufficient available balance',
    }),
  });

  const result = await placeVerifyAndProtect(common);

  assert.equal(result.status, 'REJECTED');
  assert.equal(getRow().status, 'REJECTED');
  assert.equal(
    getRow().error,
    'Bybit retCode=110007 retMsg=Insufficient available balance'
  );
  assert.equal(getRow().metadata.bybitRetCode, 110007);
  assert.equal(getRow().metadata.bybitRetMsg, 'Insufficient available balance');
});
