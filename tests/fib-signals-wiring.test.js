import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('admin API is admin-only and saving a new selection restarts the sweep', () => {
  const api = read('app/api/admin/fib-signals/route.js');
  assert.match(api, /session\.role !== 'admin'/);
  assert.match(api, /export async function PUT/);
  assert.match(api, /FIB_SIGNALS_CURSOR_KEY, \{ offset: 0/);
});

test('cron: dedicated route + the existing full-scan tick both drive Fib Signals, even when auto-scan is OFF', () => {
  const full = read('app/api/cron/full-scan/route.js');
  assert.match(full, /runFibSignalsPass/);
  assert.match(full, /fibSignals: 'started'/);
  const own = read('app/api/cron/fib-signals/route.js');
  assert.match(own, /CRON_SECRET/);
  assert.match(own, /Fib Signals is OFF/);
});

test('Scanner tab shows the signal feed first; it is called (not mounted as an inline component) so it never remounts/flickers', () => {
  const page = read('app/page.js');
  assert.match(page, /scanner: tab === 'scanner' \? ScannerTab\(\)/);
  assert.match(page, /<ScannerFeed isAdmin=\{user\.role === 'admin'\}/);
  const feed = read('components/ScannerFeed.js');
  assert.match(feed, /let CACHE = /); // module-level cache survives re-mounts
  assert.ok(!/WATCHING|READY|Watching|Ready/.test(feed));
  assert.match(feed, /ONGOING/); // the reference design shows filled signals as ongoing
  assert.match(feed, /PATH UNCONFIRMED/); // ambiguous paths stay neutral
  assert.match(feed, /settings\.maxVisibleSignals/);
  assert.deepEqual([...feed.matchAll(/setSide\('(ALL|BUY|SELL)'\)/g)].map((m) => m[1]), ['ALL', 'BUY', 'SELL']);
});

test('strategy UI is admin-only: Coin Scan card, OB+Fib board cards, strategy text in the chart modal', () => {
  const page = read('app/page.js');
  assert.match(page, /user\.role === 'admin' && \(\s*<>\s*\{\/\* ── Coin search \+ OB\+Fib scan/);
  assert.match(page, /user\.role === 'admin' \|\| \(sg\.metadata\?\.strategy \|\| sg\.strategy\) !== 'ob_fib'/);
  assert.match(page, /chartTarget\?\.sid\s*\?\s*\(user\.role === 'admin' \? 'Order Block \+ Fib chart' : 'Signal chart'\)/);
});

test('public API is role-aware and uses neutral names', () => {
  const api = read('app/api/scanner-feed/route.js');
  assert.match(api, /session\?\.role === 'admin'/);
  assert.match(api, /toPublicSignal/);
  assert.ok(!fs.existsSync(new URL('../app/api/fib-signals', import.meta.url)));
});

test('chart: stored signals render from saved levels; users get the plain chart', () => {
  const chart = read('app/api/chart/route.js');
  assert.match(chart, /searchParams\.get\('sid'\)/);
  assert.ok(chart.indexOf("searchParams.get('sid')") < chart.indexOf("if (!symbol)"));
  assert.match(chart, /buildPlainSignalChartSvg/);
  assert.match(chart, /if \(!isAdmin && !isPublicVisible\(fs\)\)/);
});

test('Admin has a Fib Signals section', () => {
  const admin = read('app/admin/page.js');
  assert.match(admin, /id: 'fibsignals'/);
  assert.match(admin, /<FibSignalsAdmin \/>/);
});
