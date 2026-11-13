/**
 * One date formatter for the whole page: the same month names whatever the
 * browser's own locale data says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLanguage, fmtDate, fmtDay, formatDay } from '../public/js/i18n.js';

globalThis.document ??= { documentElement: {} };

test('September is "Sep" everywhere, never "Sept"', () => {
  setLanguage('en');
  assert.equal(fmtDate('2025-09-05T10:00:00'), '5 Sep 2025');
  assert.equal(fmtDay('2025-09-05T10:00:00'), '5 Sep');
});

test('Russian dates take the genitive and no abbreviation dots', () => {
  setLanguage('ru');
  assert.equal(fmtDate('2026-05-21T00:00:00Z'), '21 мая 2026');
  assert.equal(fmtDay('2026-02-03T00:00:00'), '3 фев');
  setLanguage('en');
});

test('a short year tells two 21 Augusts apart', () => {
  const a = formatDay(new Date(Date.UTC(2025, 7, 21)), { year: 'short', lang: 'en' });
  const b = formatDay(new Date(Date.UTC(2026, 7, 21)), { year: 'short', lang: 'en' });
  assert.equal(a, '21 Aug ’25');
  assert.notEqual(a, b);
});
