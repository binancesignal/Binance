import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// scanner.js can't be imported in unit tests (needs Supabase), so guard the parity rules at source level:
// the all-market scan must not apply gates to OB+Fib that the per-coin Coin Scan does not apply.
const src = fs.readFileSync(new URL('../lib/scanner/scanner.js', import.meta.url), 'utf8');

test('candle-quality gate never applies to ob_fib (it silently dropped valid OB+Fib signals)', () => {
  assert.match(src, /candleQuality\?\.enabled !== false && !isHarmonic && !isObFib/);
});

test('every ob_fib drop is written to the scan log', () => {
  const start = src.indexOf('} else if (isObFib) {');
  const end = src.indexOf('} else if (isDoubleConfluence) {', start);
  const block = src.slice(start, end);
  assert.ok(block.includes('obfSkip('));
  // no bare `continue;` without a logged reason inside the ob_fib branch
  const lines = block.split('\n');
  const bare = lines.filter((l, i) => /\bcontinue;/.test(l) && !/obfSkip\(/.test(l) && !/obfSkip\(/.test(lines[i - 1] || ''));
  assert.deepEqual(bare, []);
});

test('scanner uses the same core as Coin Scan', () => {
  assert.match(src, /scanObFibCore\(\{/);
});

test('one-off OB+Fib override: admin-only API, never saved, forces ob_fib for that run only', () => {
  assert.match(src, /options\.strategyOverride === 'ob_fib'/);
  assert.match(src, /strategyMode = 'ob_fib';\n\s+const ov = options\.obFibOverride/);
  const api = fs.readFileSync(new URL('../app/api/scan/route.js', import.meta.url), 'utf8');
  assert.match(api, /body\.strategyOverride === 'ob_fib'/);
  assert.match(api, /session\.role !== 'admin'/);
  assert.ok(!/setState\('strategy_mode'/.test(api));
});
