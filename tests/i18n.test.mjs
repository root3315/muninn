/**
 * Both languages carry the same keys and the same placeholders, and no string
 * names a colour the interface no longer draws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { setLanguage, t } from '../public/js/i18n.js';

// setLanguage marks <html lang>; there is no page here, so a stand-in.
globalThis.document ??= { documentElement: {} };

const source = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');

/** The keys of one language table, straight from the source. */
function keysOf(lang) {
  const start = source.indexOf(`${lang}: {`);
  assert.ok(start >= 0, `table ${lang} present`);
  const body = source.slice(start, source.indexOf('\n  },', start));
  return new Set([...body.matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]));
}

test('EN and RU have the same keys', () => {
  const en = keysOf('en');
  const ru = keysOf('ru');
  assert.ok(en.size > 200);
  assert.deepEqual([...en].filter((k) => !ru.has(k)), [], 'missing in RU');
  assert.deepEqual([...ru].filter((k) => !en.has(k)), [], 'missing in EN');
});

test('every placeholder survives translation', () => {
  // {n} and {n:заход|захода|заходов} are the same hole, filled from the same value.
  const holes = (s) => [...new Set([...String(s).matchAll(/\{(\w+)(?::[^}]*)?\}/g)].map((m) => m[1]))].sort().join(',');
  for (const key of keysOf('en')) {
    setLanguage('en');
    const en = t(key);
    setLanguage('ru');
    const ru = t(key);
    assert.equal(holes(ru), holes(en), key);
  }
});

test('no string describes a colour that is not drawn', () => {
  assert.doesNotMatch(source, /\b[Pp]ink\b|[Рр]озов/, 'the palette has no pink');
});
