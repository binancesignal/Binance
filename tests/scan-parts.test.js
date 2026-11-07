import test from 'node:test';
import assert from 'node:assert/strict';
import { planPart, nextPartOffset, stableOrder, partSize, normalizeParts } from '../lib/scanner/scanParts.js';

const coins = (n) => Array.from({ length: n }, (_, i) => `C${String(i).padStart(3, '0')}USDT`);

test('525 coins / 3 parts → 175 each, three ticks cover every coin exactly once', () => {
  const list = stableOrder(coins(525).reverse());
  let offset = 0;
  const seen = [];
  const parts = [];
  for (let tick = 0; tick < 3; tick++) {
    const plan = planPart(list, 3, offset);
    parts.push(plan.part);
    seen.push(...plan.chunk);
    offset = nextPartOffset(plan.start, plan.chunk.length, list.length); // all processed
  }
  assert.deepEqual(parts, [1, 2, 3]);
  assert.equal(seen.length, 525);
  assert.equal(new Set(seen).size, 525);
  assert.equal(offset, 0, 'wraps back to part 1');
  assert.equal(partSize(525, 3), 175);
});

test('a part cut short by the time budget is continued, nothing is skipped', () => {
  const list = stableOrder(coins(525));
  const t1 = planPart(list, 3, 0);
  const done1 = 160; // only 160 of 175 finished
  const off = nextPartOffset(t1.start, done1, list.length);
  const t2 = planPart(list, 3, off);
  assert.equal(t2.chunk[0], list[160]);
});

test('uneven split: last part is shorter, no wrap-around duplicates', () => {
  const list = stableOrder(coins(100));
  const seen = [];
  let off = 0;
  for (let i = 0; i < 3; i++) {
    const p = planPart(list, 3, off);
    seen.push(...p.chunk);
    off = nextPartOffset(p.start, p.chunk.length, list.length);
  }
  assert.equal(seen.length, 100);
  assert.equal(new Set(seen).size, 100);
});

test('normalizeParts clamps and defaults', () => {
  assert.equal(normalizeParts(undefined), 3);
  assert.equal(normalizeParts(0), 3);
  assert.equal(normalizeParts(1), 1);
  assert.equal(normalizeParts(99), 10);
});
