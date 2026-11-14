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

test('an empty spot marked from a link is checked in every visit, not reported as SkyBoT failing', async () => {
  const { seenAt, skybotVerdict, skybotLine } = await import('../public/js/marks.js');
  const spot = { ra: 269.47, dec: 4.75, obsId: null };
  const empty = { track: [] };
  const seen = seenAt(empty, spot, ['v1', 'v2']);
  assert.deepEqual(seen, [{ ra: 269.47, dec: 4.75, obsId: 'v1' }, { ra: 269.47, dec: 4.75, obsId: 'v2' }]);
  const answered = new Map([['v1', []], ['v2', [{ ra: 269.6, dec: 4.9, err: 0 }]]]);
  const verdict = skybotVerdict(seen, { knownObjects: answered, failed: new Set(), on: true });
  assert.equal(verdict.state, 'none');
  assert.doesNotMatch(skybotLine(verdict, []), /did not answer/);
  assert.equal(skybotVerdict(seen, { knownObjects: new Map(), failed: new Set(['v1', 'v2']), on: true }).state, 'failed');
  assert.equal(skybotVerdict(seen, { knownObjects: new Map([['v1', []]]), failed: new Set(), on: true }).state, 'waiting');
});
