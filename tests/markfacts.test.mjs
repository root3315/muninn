/**
 * A mark's facts line: the band, where, the number the verdict rests on, and
 * in how many visits it was seen, in both languages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLanguage, t, fmt } from '../public/js/i18n.js';
import { markFacts } from '../public/js/markfacts.js';

globalThis.document ??= { documentElement: {} };

const helpers = { t, fmt, day: () => '25 Dec' };
const where = { band: 'D2', ra: 13.4194, dec: 3.8459 };
const text = (bits) => bits.map((b) => b.text).join(' · ');
const keys = (bits) => bits.filter((b) => b.key).map((b) => b.text);

test('a flash in one visit: its date and its sigma, the sigma the key', () => {
  setLanguage('en');
  const bits = markFacts({ kind: 'transient', at: { mjd: 61034.2, snr: 403.2 }, seen: 1, total: 5 }, where, helpers);
  assert.equal(text(bits), 'D2 · 13.419° +3.846° · 25 Dec · 403σ · 1 of 5 visits');
  assert.deepEqual(keys(bits), ['403σ']);
});

test('nothing seen says so in a count, with no number to stress', () => {
  setLanguage('ru');
  const bits = markFacts({ kind: 'none', seen: 0, total: 5 }, where, helpers);
  assert.equal(text(bits), 'D2 · 13,419° +3,846° · 0 из 5 заходов');
  assert.deepEqual(keys(bits), []);
  setLanguage('en');
  assert.equal(markFacts({ kind: 'none', total: 1 }, where, helpers).at(-1).text, '0 of 1 visit');
});

test('a mover keys its rate; a still source its brightness; saturated light quotes none', () => {
  setLanguage('en');
  assert.deepEqual(keys(markFacts({ kind: 'moving', ratePerHour: 21.04, seen: 3, total: 9 }, where, helpers)), ['21.0″/h']);
  assert.deepEqual(keys(markFacts({ kind: 'fixed', brightness: { brightest: 12.34 }, seen: 9, total: 9 }, where, helpers)), ['12.3 AB']);
  const sat = markFacts({ kind: 'saturated', brightness: { brightest: 6.9 }, saturated: 7, seen: 9, total: 9 }, where, helpers);
  assert.ok(!text(sat).includes('AB'));
  assert.equal(sat.at(-1).text, '7 of 9 visits');
});

test('a southern mark and a mark still being measured', () => {
  setLanguage('en');
  assert.equal(text(markFacts(null, { band: null, ra: 269.4485, dec: -4.7394 }, helpers)), '269.449° −4.739°');
});
