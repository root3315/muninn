/**
 * The page's names for its data files (public/js/datanames.js) are those of
 * the files on disk now: a data file changed without running
 * tools/name-data.mjs would still be served, but through the tunnel every
 * time instead of from the edge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dataNamesSource, pagesWithNames } from '../tools/name-data.mjs';

test('datanames.js is current with the files under public/data', async () => {
  const written = await readFile(new URL('../public/js/datanames.js', import.meta.url), 'utf8');
  assert.equal(written, await dataNamesSource(), 'run node tools/name-data.mjs');
});

test('the lists the page needs first travel inside the module', async () => {
  const { FIELD_LIST, BAKED_FIELDS, DATA_NAMES } = await import('../public/js/datanames.js');
  assert.ok(FIELD_LIST.some((f) => f.key === 'barnard'));
  assert.ok(BAKED_FIELDS.barnard?.bands);
  for (const [key, field] of Object.entries(BAKED_FIELDS)) {
    for (const band of Object.keys(field.bands)) {
      assert.ok(DATA_NAMES[`data/fields/${key}/${band}/manifest.json`], `${key} ${band} manifest has a hashed name`);
    }
  }
});

test('a page preloads a data file under the name the code asks for it by', async () => {
  for (const [page, now, named] of await pagesWithNames()) assert.equal(now, named, `${page}: run node tools/name-data.mjs`);
  const fly = (await pagesWithNames()).find(([page]) => page === 'fly.html')[1];
  const { DATA_NAMES } = await import('../public/js/datanames.js');
  assert.ok(fly.includes(`href="${DATA_NAMES['data/fly/stars.bin']}"`));
});
