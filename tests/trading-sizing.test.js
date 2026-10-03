import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLeverage, calculateQuantity } from '../lib/trading/autoTrader.js';
import { roundToStep } from '../lib/bybit/client.js';

const leverageConfig = (defaultLeverage) => ({
  defaultLeverage,
  volatilityAwareLeverage: false,
  minimumLeverage: 1,
  maximumLeverage: 20,
});

test('leverage is clamped to the instrument maximum and floored to its exchange step', () => {
  const result = calculateLeverage(leverageConfig(15), null, 13, 5);

  assert.equal(result.reject, false);
  assert.equal(result.leverage, 10);
});

test('quantity rejects an order below the exchange minimum notional', () => {
  const result = calculateQuantity({
    margin: 2.5,
    leverage: 2,
    entryPrice: 100,
    instrument: {
      qtyStep: 0.01,
      minOrderQty: 0.01,
      maxOrderQty: 0,
      minNotionalValue: 10,
    },
  });

  assert.equal(result.reject, true);
  assert.match(result.reason, /minimum 10/);
});

test('quantity rejects a maximum-size cap that rounds below minOrderQty', () => {
  const result = calculateQuantity({
    margin: 100,
    leverage: 1,
    entryPrice: 100,
    instrument: {
      qtyStep: 0.1,
      minOrderQty: 0.15,
      maxOrderQty: 0.15,
      minNotionalValue: 0,
    },
  });

  assert.equal(result.reject, true);
  assert.match(result.reason, /rounds below minimum/);
});

test('roundToStep preserves precision for very small exchange ticks', () => {
  assert.equal(roundToStep(0.123456789, 0.00000001), 0.12345678);
});
