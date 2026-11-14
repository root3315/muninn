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

test('a held visit is found again by its file, then by its moment and band', async () => {
  const { findHeldVisit } = await import('../public/js/catalog.js');
  const list = [
    { url: 'a', mjd: 100, band: 'D1' },
    { url: 'b', mjd: 200, band: 'D1' },
    { url: 'c', mjd: 200, band: 'D4' },
    { url: 'd', mjd: 300, band: 'D4' },
  ];
  assert.equal(findHeldVisit(list, { url: 'c', mjd: 200, band: 'D4' }), 2, 'the same file');
  assert.equal(findHeldVisit(list, { url: 'gone', mjd: 200, band: 'D4' }), 2, 'same moment, same band, not the first');
  assert.equal(findHeldVisit(list, { url: 'gone', mjd: 200.00001, band: 'D2' }), 1, 'same moment, another band: the first of it');
  assert.equal(findHeldVisit(list, { mjd: 290, band: 'D1' }), 3, 'otherwise the nearest night');
  assert.equal(findHeldVisit(list, null), -1);
  assert.equal(findHeldVisit([], { mjd: 1 }), -1);
});

test('a star with planets is found within reach, and only within it', async () => {
  const { nearestHost } = await import('../public/js/catalog.js');
  const hosts = [[269.44861, 4.73798, 4, "Barnard's star"], [344.36754, 20.7691, 1, '51 Peg'], [344.4, 20.77, 2, 'near 51 Peg']];
  assert.equal(nearestHost(hosts, 269.4485, 4.7395, 90)?.[3], "Barnard's star", 'a 2025 position, 6″ from the archive’s');
  assert.equal(nearestHost(hosts, 344.3676, 20.7692, 90)?.[3], '51 Peg', 'the nearest of two');
  assert.equal(nearestHost(hosts, 344.3676, 20.80, 90), null, '110″ away is another star');
  assert.equal(nearestHost([], 0, 0, 90), null);
});

test('coordinates as the page itself prints them, and with a typographic minus', async () => {
  const { parseCoordinates } = await import('../public/js/catalog.js');
  const close = (a, b) => Math.abs(a - b) < 1e-4;
  const p = parseCoordinates('08ʰ 55ᵐ 10.83ˢ −07° 14′ 42.5″');
  assert.ok(p && close(p.ra, 133.795125) && close(p.dec, -7.245139), JSON.stringify(p));
  const q = parseCoordinates('133.795, −7.245');
  assert.ok(q && close(q.ra, 133.795) && close(q.dec, -7.245));
  const r = parseCoordinates('08h55m10.831s -07d14m42.53s');
  assert.ok(r && close(r.dec, -7.245147));
  assert.equal(parseCoordinates('10 75 00 +10 00 00'), null, 'minutes of 75');
  assert.equal(parseCoordinates('-01 00 00 +10 00 00'), null, 'a negative right ascension');
});

test('coordinates with a decimal comma, degree signs, tabs, or no seconds', async () => {
  const { parseCoordinates } = await import('../public/js/catalog.js');
  const close = (a, b) => Math.abs(a - b) < 1e-4;
  const comma = parseCoordinates('13,4194 3,8459');
  assert.ok(comma && close(comma.ra, 13.4194) && close(comma.dec, 3.8459), JSON.stringify(comma));
  const listed = parseCoordinates('13.4194,3.8459');
  assert.ok(listed && close(listed.ra, 13.4194) && close(listed.dec, 3.8459), 'a point and a comma is a list');
  const deg = parseCoordinates('133.7951° -7.2451°');
  assert.ok(deg && close(deg.ra, 133.7951) && close(deg.dec, -7.2451));
  const tab = parseCoordinates('133.7951\t-7.2451');
  assert.ok(tab && close(tab.ra, 133.7951) && close(tab.dec, -7.2451));
  const short = parseCoordinates('08 55 -07 14');
  assert.ok(short && close(short.ra, 133.75) && close(short.dec, -(7 + 14 / 60)), JSON.stringify(short));
  const card = parseCoordinates('00ʰ 53ᵐ +03° 50′');
  assert.ok(card && close(card.ra, 13.25) && close(card.dec, 3 + 50 / 60), JSON.stringify(card));
  assert.equal(parseCoordinates('08 75 -07 14'), null, 'minutes of 75, no seconds');
  assert.equal(parseCoordinates('-08 55 -07 14'), null, 'a negative right ascension');
  assert.equal(parseCoordinates('10 20 +95 00'), null, 'declination beyond the pole');
  assert.equal(parseCoordinates('1 2 3'), null, 'three numbers fit no format');
  assert.equal(parseCoordinates('1e1 0x10'), null, 'not plain decimals');
});

test('a rounded-up second carries into minutes and hours', async () => {
  const { formatRA, formatDec } = await import('../public/js/catalog.js');
  assert.equal(formatRA(359.99999), '00ʰ 00ᵐ 00.00ˢ');
  assert.equal(formatRA(14.99999), '01ʰ 00ᵐ 00.00ˢ');
  assert.equal(formatRA(133.795125), '08ʰ 55ᵐ 10.83ˢ');
  assert.equal(formatDec(-7.99999999), '−08° 00′ 00.0″');
  assert.equal(formatDec(10.9999999), '+11° 00′ 00.0″');
  assert.equal(formatDec(-7.245139), '−07° 14′ 42.5″');
});
