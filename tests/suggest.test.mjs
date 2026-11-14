/**
 * The search box's suggestions: what matches, in which order, in both
 * languages, and when the text is a position instead of a name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildIndex, suggest, fold, looksLikeCoordinates, SUGGEST_MAX } from '../public/js/suggest.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const presets = read('../public/data/targets.json').targets;
const stars = read('../public/data/sky/stars.json');
const deep = read('../public/data/sky/deepsky.json');
const planets = [{ key: 'mars', ra: 10, dec: 5 }, { key: 'venus', ra: 20, dec: -3 }];

const NAMES = {
  en: { 'preset.rdra': 'R Dra', 'preset.wise0855': 'WISE 0855', 'preset.m51': 'M51', 'planet.mars': 'Mars', 'planet.venus': 'Venus' },
  ru: { 'preset.rdra': 'R Дракона', 'preset.wise0855': 'WISE 0855', 'preset.m51': 'M51', 'planet.mars': 'Марс', 'planet.venus': 'Венера' },
};
const say = (lang, key) => NAMES[lang][key] ?? key;
const index = (lang = 'en') => buildIndex({ presets, stars, deep, planets, lang, say });
const labels = (text, lang) => suggest(text, index(lang)).rows.map((r) => r.label);

test('folding drops case, accents and ё', () => {
  assert.equal(fold('  Ёлка  Café '), 'елка cafe');
  assert.equal(fold('α¹ Cen'), 'α1 cen');
});

test('a name is found from its first letters, in English and in Russian', () => {
  assert.equal(labels('veg')[0], 'Vega');
  assert.equal(labels('вег', 'ru')[0], 'Вега');
  // The other language's name finds it too, shown in the reader's.
  assert.equal(labels('vega', 'ru')[0], 'Вега');
  assert.equal(labels('ВЕГА', 'en')[0], 'Vega');
});

test('accents and letter case do not matter', () => {
  assert.equal(labels('ALDÉBARAN')[0], 'Aldebaran');
  assert.equal(labels('плеяд', 'ru')[0], 'M45 · Плеяды');
});

test('a word inside a name counts, not a stretch inside a word', () => {
  assert.ok(labels('kentaurus').includes('Rigil Kentaurus'));
  assert.ok(!labels('ega').includes('Vega'));
});

test('Greek letters are found by symbol and by name in both languages', () => {
  const alpha = (q, lang) => suggest(q, index(lang)).rows.map((r) => r.alt);
  assert.ok(alpha('α lyr').includes('α Lyr'));
  assert.ok(alpha('alpha lyr').includes('α Lyr'));
  assert.ok(alpha('альфа', 'ru').every((b) => b.startsWith('α')));
});

test('an exact name comes first, then the targets, then other starts', () => {
  const m5 = labels('M5');
  assert.equal(m5[0], 'M5');
  assert.equal(m5[1], 'M51', 'the ready field M51 before M50, M52…');
  assert.deepEqual(labels('R Dra').slice(0, 1), ['R Dra']);
  const wise = suggest('wise', index()).rows;
  assert.equal(wise[0].kind, 'target');
  assert.equal(labels('M3')[0], 'M3');
});

test('a ready field is offered once, not again as a Messier object', () => {
  const m51 = suggest('M51', index()).rows;
  assert.equal(m51.filter((r) => r.ra.toFixed(1) === '202.5').length, 1);
  assert.equal(m51[0].kind, 'field');
});

test('kinds: star, galaxy, nebula, cluster, planet', () => {
  const kindOf = (q, lang) => suggest(q, index(lang)).rows[0].kind;
  assert.equal(kindOf('sirius'), 'star');
  assert.equal(kindOf('andromeda'), 'galaxy');
  assert.equal(kindOf('crab'), 'nebula');
  assert.equal(kindOf('M13'), 'cluster');
  assert.equal(kindOf('мар', 'ru'), 'planet');
  assert.equal(kindOf('mars', 'ru'), 'planet');
});

test('never more than the maximum', () => {
  assert.equal(suggest('m', index()).rows.length, SUGGEST_MAX);
  assert.equal(suggest('a', index(), { max: 3 }).rows.length, 3);
});

test('an empty box offers the five challenge targets', () => {
  const { rows } = suggest('  ', index());
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.kind === 'target'));
});

test('a position is told from a name, and checked', () => {
  assert.ok(looksLikeCoordinates('13.4 3.8'));
  assert.ok(looksLikeCoordinates('10 00 34.7 +01 00 11'));
  assert.ok(looksLikeCoordinates('-5'));
  assert.ok(!looksLikeCoordinates('M3'));
  assert.ok(!looksLikeCoordinates('wise 0855'));

  const good = suggest('13.4 3.8', index());
  assert.ok(good.coordLike);
  assert.deepEqual(good.coords, { ra: 13.4, dec: 3.8 });
  assert.ok(good.rows.length <= SUGGEST_MAX - 1, 'the position row takes one place');

  const sex = suggest('10 00 34.7 +01 00 11', index());
  assert.ok(Math.abs(sex.coords.ra - 150.1446) < 1e-3);

  const half = suggest('13.4', index());
  assert.ok(half.coordLike);
  assert.equal(half.coords, null);

  assert.equal(suggest('400 95', index()).coords, null);
});

test("a preset's date is written in the reader's language", () => {
  const sayAtala = (lang, key) => (key === 'preset.atala' ? '(152) Atala' : key);
  const atala = (lang) => suggest('atala', buildIndex({ presets, lang, say: sayAtala })).rows.find((r) => r.label === '(152) Atala');
  assert.equal(atala('en').alt, '25 Dec 2025');
  assert.equal(atala('ru').alt, '25 дек 2025');
});
