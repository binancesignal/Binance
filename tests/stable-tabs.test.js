import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

test('inner tab screens with their own input state are hosted by a stable component (no remount on polling)', () => {
  assert.match(src, /function StableTab\(\{ render \}\)/);
  for (const [name, key] of [
    ['PlansTab', 'plans'],
    ['SettingsTab', 'settings'],
    ['ReferralTab', 'referral'],
  ]) {
    assert.ok(src.includes(`<StableTab key="${key}" render={${name}} />`), `${name} must go through StableTab`);
    assert.ok(!src.includes(`<${name} />`), `${name} must not be mounted inline`);
  }
});
