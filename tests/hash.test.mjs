/**
 * A field's link carries the marks, the mode and the visit held on screen,
 * and reads back to the same thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeHash, decodeHash, parseMarks } from '../public/js/hash.js';

const field = {
  ra: 269.4463, dec: 4.768, fov: 0.3, band: 'D2', lang: 'ru', name: "Barnard's Star",
  survey: 'gaia', mode: 'single', visit: 4,
  marks: [{ ra: 269.44, dec: 4.77 }, { ra: 269.45123, dec: -4.76 }],
};

test('a link reads back to the field it was written from', () => {
  const back = decodeHash(`#${encodeHash(field)}`);
  assert.deepEqual(back.position, { ra: 269.4463, dec: 4.768 });
  assert.equal(back.fov, 0.3);
  assert.equal(back.band, 'D2');
  assert.equal(back.lang, 'ru');
  assert.equal(back.name, "Barnard's Star");
  assert.equal(back.survey, 'gaia');
  assert.equal(back.mode, 'single');
  assert.equal(back.visit, 4);
  assert.deepEqual(back.marks, [{ ra: 269.44, dec: 4.77 }, { ra: 269.45123, dec: -4.76 }]);
});

test('marks are written readably, as ra,dec;ra,dec', () => {
  const hash = encodeHash(field);
  assert.match(hash, /marks=269\.44000,4\.77000;269\.45123,-4\.76000/);
});

test('the language goes in once', () => {
  const hash = encodeHash(field);
  assert.equal(hash.match(/lang=/g).length, 1);
});

test('blink, no marks and no held visit leave nothing in the link', () => {
  const hash = encodeHash({ ...field, mode: 'blink', visit: null, marks: [] });
  assert.doesNotMatch(hash, /(^|&)(mode|v|marks)=/);
  const back = decodeHash(hash);
  assert.equal(back.mode, null);
  assert.equal(back.visit, null);
  assert.deepEqual(back.marks, []);
});

test('anything that is not a place, a mode or a size is dropped', () => {
  const back = decodeHash('#ra=400&dec=5&fov=0.33&mode=zoom&v=-1&marks=10,95;abc;20,30;,5');
  assert.equal(back.position, null);
  assert.equal(back.fov, null);
  assert.equal(back.mode, null);
  assert.equal(back.visit, null);
  assert.deepEqual(back.marks, [{ ra: 20, dec: 30 }]);
});

test('an empty hash is no field, not the vernal equinox', () => {
  const back = decodeHash('');
  assert.equal(back.position, null);
  assert.equal(back.band, 'all');
  assert.equal(back.survey, 'off');
});

test('escaped separators from an older copy still read', () => {
  assert.deepEqual(parseMarks('1.5,2.5;3,4'), decodeHash('#marks=1.5%2C2.5%3B3%2C4').marks);
});
