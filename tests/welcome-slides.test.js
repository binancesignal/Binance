import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSlides, slidesOrDefault, DEFAULT_SLIDES, MAX_SLIDES } from '../lib/branding/welcomeSlides.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('valid slides are trimmed and kept', () => {
  const out = sanitizeSlides([{ title: '  Hello  ', subtitle: ' world ', imageUrl: PNG }]);
  assert.deepEqual(out, [{ title: 'Hello', subtitle: 'world', imageUrl: PNG }]);
});

test('empty slide, bad image, or too many slides are rejected', () => {
  assert.throws(() => sanitizeSlides([{ title: '', subtitle: '', imageUrl: null }]), /empty/);
  assert.throws(() => sanitizeSlides([{ title: 'x', imageUrl: 'javascript:alert(1)' }]), /image must be/);
  assert.throws(() => sanitizeSlides([{ title: 'x', imageUrl: 'data:image/svg+xml;base64,AAAA' }]), /image must be/);
  assert.throws(() => sanitizeSlides(Array.from({ length: MAX_SLIDES + 1 }, () => ({ title: 'x' }))), /Maximum/);
});

test('no saved slides → built-in defaults', () => {
  assert.equal(slidesOrDefault(null), DEFAULT_SLIDES);
  assert.equal(slidesOrDefault([]), DEFAULT_SLIDES);
  assert.equal(slidesOrDefault([{ title: 'a' }]).length, 1);
});
