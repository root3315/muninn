/**
 * A mark's words: a saturated star quotes no brightness, a measured one does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { documentElement: {} };
const { setLanguage } = await import('../public/js/i18n.js');
const { brightnessWords } = await import('../public/js/marks.js');

setLanguage('en');
const brightness = { brightest: 6.9, faintest: 6.9, band: 'D2' };

test('a saturated mark quotes no brightness', () => {
  assert.equal(brightnessWords({ kind: 'saturated', seen: 10, brightness }), null);
});

test('a fixed mark seen more than once gives its range', () => {
  assert.match(brightnessWords({ kind: 'fixed', seen: 10, brightness: { brightest: 12.1, faintest: 12.4, band: 'D2' } }), /12\.1–12\.4 AB in D2/);
});
