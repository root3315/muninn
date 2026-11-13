/**
 * Which visits a field reads first, and which ten "Load more" adds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spread, nextVisits, VISITS_PER_BATCH } from '../public/js/visits.js';

// Fifty-five visits in two seasons a year, like a field near the ecliptic:
// clusters of a few days, six months apart.
const archive = [];
for (let season = 0; season < 3; season++) {
  for (let k = 0; k < (season === 1 ? 25 : 15); k++) {
    archive.push({ obsId: `v${season}-${k}`, mjd: 60800 + season * 182 + k * 0.6 });
  }
}

const gaps = (list) => {
  const m = list.map((v) => v.mjd).sort((a, b) => a - b);
  return m.slice(1).map((x, i) => x - m[i]);
};

test('the first batch keeps both ends of the baseline', () => {
  const first = spread(archive, VISITS_PER_BATCH);
  assert.equal(first.length, 10);
  assert.equal(first[0], archive[0]);
  assert.equal(first.at(-1), archive.at(-1));
});

test('load more adds ten new visits, in date order, none read before', () => {
  const first = spread(archive, VISITS_PER_BATCH);
  const more = nextVisits(archive, first);
  assert.equal(more.length, 10);
  const firstIds = new Set(first.map((v) => v.obsId));
  assert.ok(more.every((v) => !firstIds.has(v.obsId)));
  assert.deepEqual(more.map((v) => v.mjd), more.map((v) => v.mjd).slice().sort((a, b) => a - b));
  assert.equal(new Set(more.map((v) => v.obsId)).size, 10);
});

test('load more fills the widest gaps first', () => {
  const first = spread(archive, VISITS_PER_BATCH);
  const before = Math.max(...gaps(first).filter((g) => g < 100));
  const after = Math.max(...gaps([...first, ...nextVisits(archive, first)]).filter((g) => g < 100));
  // Inside a season the widest gap shrinks: the batch went where it was thin.
  assert.ok(after < before, `${after} < ${before}`);
});

test('the last batch is whatever is left, and then nothing', () => {
  let read = spread(archive, VISITS_PER_BATCH);
  for (let k = 0; k < 10 && read.length < archive.length; k++) read = [...read, ...nextVisits(archive, read)];
  assert.equal(read.length, archive.length);
  assert.equal(new Set(read.map((v) => v.obsId)).size, archive.length);
  assert.deepEqual(nextVisits(archive, read), []);
});

test('the choice is the same every time', () => {
  const first = spread(archive, VISITS_PER_BATCH);
  assert.deepEqual(nextVisits(archive, first), nextVisits(archive, first.slice().reverse()));
});
