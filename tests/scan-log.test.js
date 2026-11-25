import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCoin, mergeCoinStatus, logKind, recordScanStart, recordScanFinish, recordScanFailure } from '../lib/scanner/scanLog.js';
import { getState } from '../lib/database/appState.js';

test('classifyCoin priority: no_price > error > created > updated > skipped > filtered > no_setup', () => {
  assert.equal(classifyCoin({ noPrice: true, error: 'x' }), 'no_price');
  assert.equal(classifyCoin({ error: 'boom', created: 1 }), 'error');
  assert.equal(classifyCoin({ created: 1, updated: 2 }), 'created');
  assert.equal(classifyCoin({ updated: 1 }), 'updated');
  assert.equal(classifyCoin({ skipped: 1, found: 3 }), 'skipped');
  assert.equal(classifyCoin({ found: 2 }), 'filtered');
  assert.equal(classifyCoin({}), 'no_setup');
});

test('logKind: only the 5-min full scan is kind=full', () => {
  assert.equal(logKind('cron-full'), 'full');
  assert.equal(logKind('cron', true), 'full');
  assert.equal(logKind('cron'), 'cron');
  assert.equal(logKind('manual'), 'cron');
});

test('mergeCoinStatus updates in place and prunes the oldest beyond max', () => {
  const m1 = mergeCoinStatus({}, [{ s: 'AAAUSDT', r: 'no_setup', ms: 10 }, { s: 'BBBUSDT', r: 'created', ms: 20, c: 1 }], { at: '2026-10-08T10:00:00Z', kind: 'full', part: 1 });
  assert.equal(m1.BBBUSDT.c, 1);
  const m2 = mergeCoinStatus(m1, [{ s: 'AAAUSDT', r: 'error', ms: 5, e: 'x'.repeat(500) }], { at: '2026-10-08T10:05:00Z', kind: 'full', part: 2 }, 2);
  assert.equal(m2.AAAUSDT.r, 'error');
  assert.equal(m2.AAAUSDT.e.length, 120);
  const m3 = mergeCoinStatus(m2, [{ s: 'CCCUSDT', r: 'no_setup', ms: 1 }], { at: '2026-10-08T10:10:00Z', kind: 'cron' }, 2);
  assert.deepEqual(Object.keys(m3).sort(), ['AAAUSDT', 'CCCUSDT'], 'oldest (BBB) pruned');
});

test('start → finish writes live marker, last run, history and coin map', async () => {
  await recordScanStart({ runId: 'r1', kind: 'full', exchange: 'binance' });
  assert.equal((await getState('scan_live')).status, 'running');
  await recordScanFinish(
    { runId: 'r1', kind: 'full', exchange: 'binance', part: 2, parts: 3, planned: 2, totalSymbols: 6, created: 1, updated: 0, errorCount: 0, errors: [], status: 'PARTIAL', partial: true },
    [{ s: 'AAAUSDT', r: 'created', ms: 12, c: 1 }, { s: 'BBBUSDT', r: 'no_setup', ms: 8 }],
    ['CCCUSDT']
  );
  const live = await getState('scan_live');
  assert.equal(live.status, 'idle');
  const last = await getState('scan_last_run:full:binance');
  assert.equal(last.scanned, 2);
  assert.deepEqual(last.counts, { created: 1, no_setup: 1 });
  assert.deepEqual(last.pending, ['CCCUSDT']);
  const hist = await getState('scan_run_history:full:binance');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].coins, undefined, 'history rows carry no coin list');
  assert.equal(hist[0].pendingCount, 1);
  const map = await getState('coin_scan_status:binance');
  assert.equal(map.AAAUSDT.r, 'created');
  assert.equal(map.AAAUSDT.part, 2);
});

test('failure is recorded in history and clears the running marker', async () => {
  await recordScanStart({ runId: 'r2', kind: 'cron', exchange: 'binance' });
  await recordScanFailure({ runId: 'r2', kind: 'cron', exchange: 'binance' }, 'binance 451');
  assert.equal((await getState('scan_live')).status, 'idle');
  const hist = await getState('scan_run_history:cron:binance');
  assert.equal(hist[0].status, 'FAILED');
});
