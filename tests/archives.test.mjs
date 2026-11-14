/**
 * The question asked of CADC about other telescopes, and reading its answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archivesQuery, readArchives, cadcSearchUrl, CADC_SEARCH, ARCHIVE_RADIUS } from '../public/js/archives.js';

test('the CADC question carries only three numbers from outside', () => {
  const q = archivesQuery({ ra: 269.452, dec: 4.693, radiusDeg: 0.1 });
  assert.match(q, /CIRCLE\('ICRS', 269\.452000, 4\.693000, 0\.10000\)/);
  assert.match(q, /o\.intent = 'science'/);
  assert.throws(() => archivesQuery({ ra: '1); DROP TABLE x; --', dec: 0, radiusDeg: 0.1 }), /not a number/);
});

test('the radius is clamped, so no query covers the whole sky', () => {
  assert.match(archivesQuery({ ra: 10, dec: 10, radiusDeg: 90 }), new RegExp(`, ${ARCHIVE_RADIUS.max.toFixed(5)}\\)`));
  assert.match(archivesQuery({ ra: 10, dec: 10, radiusDeg: 0 }), new RegExp(`, ${ARCHIVE_RADIUS.min.toFixed(5)}\\)`));
});

test('archives come back largest first, with years, and derived copies left out', () => {
  // As CADC answered for Barnard's Star, 13 Nov 2026 (distinct observations), trimmed.
  const rows = [
    { collection: 'CFHT', n: '1970', first: '49896.247245', last: '59830.3828655' },
    { collection: 'HST', n: '826', first: '49025.633796180555', last: '60812.483245104166' },
    { collection: 'HSTHLA', n: '297', first: '49829.5571419', last: '50712.922794' },
    { collection: 'NEOSSAT', n: '572', first: '58769.06014008102', last: '58820.05889074074' },
    { collection: 'IRIS', n: '8', first: '', last: '' },
    { collection: '', n: '3', first: '', last: '' },
  ];
  const list = readArchives(rows);
  assert.deepEqual(list.map((a) => a.name), ['CFHT', 'HST', 'NEOSSAT', 'IRIS']);
  assert.deepEqual(list[2], { name: 'NEOSSAT', n: 572, from: 2019, to: 2019 });
  assert.deepEqual([list[1].from, list[1].to], [1993, 2025]);
  assert.equal(list[3].from, null);
});

test('NEOSSat: the newest frame, its preview and FITS, and nothing that is not a CADC NEOSSat file', async () => {
  const { neossatQuery, neossatFilesQuery, readNeossat, CADC_FILES } = await import('../public/js/archives.js');
  assert.match(neossatQuery({ ra: 269.452, dec: 4.693, radiusDeg: 0.05, last: '58820.0588907' }), /time_bounds_lower >= 58820.0588897/);
  assert.throws(() => neossatQuery({ ra: 'x', dec: 0, radiusDeg: 0.1, last: 1 }), /not a number/);
  assert.throws(() => neossatFilesQuery("x' OR '1'='1"), /not a plane id/);
  assert.match(neossatFilesQuery('483ae3a3-e2b7-4fa7-9800-24146c498f8d'), /planeID = '483ae3a3/);
  // As CADC answered for Barnard's Star, 13 Nov 2026, trimmed.
  const obs = { observationID: '2019304000624', target_name: 'BarnardStar', time_bounds_lower: '58787.00444572917', time_exposure: '1.1005', planeID: '483ae3a3-e2b7-4fa7-9800-24146c498f8d' };
  const files = [
    { uri: 'cadc:NEOSSAT/2019304000624_raw_prev.png' },
    { uri: 'cadc:NEOSSAT/2019304000624_raw_prev_256.png' },
    { uri: 'cadc:NEOSSAT/NEOS_SCI_2019304000624.fits' },
  ];
  assert.deepEqual(readNeossat(obs, files), {
    id: '2019304000624', target: 'BarnardStar', iso: '2019-10-31', exposure: 1.1005,
    preview: `${CADC_FILES}cadc:NEOSSAT/2019304000624_raw_prev_256.png`,
    fits: `${CADC_FILES}cadc:NEOSSAT/NEOS_SCI_2019304000624.fits`,
  });
  assert.equal(readNeossat(null, []), null);
  assert.equal(readNeossat(obs, [{ uri: 'https://evil.example/x_prev.png' }]), null);
});

test('a link to CADC opens its search on the field, for one collection or all', () => {
  const field = { ra: 13.4194, dec: 3.8459, radiusDeg: 0.163 };
  const one = new URL(cadcSearchUrl(field, 'CFHT'));
  assert.equal(`${one.origin}${one.pathname}`, CADC_SEARCH);
  assert.equal(one.hash, '#resultTableTab');
  assert.equal(one.searchParams.get('Observation.collection'), 'CFHT');
  assert.equal(one.searchParams.get('Plane.position.bounds'), '13.41940 3.84590 0.1630');
  assert.equal(one.searchParams.get('Plane.position.bounds@Shape1Resolver.value'), 'ALL');
  assert.ok(!one.search.includes('+'), 'spaces are written as %20');
  assert.ok(one.search.includes('Plane.position.bounds@Shape1Resolver.value=ALL'), 'the "@" is left as it is');
  assert.equal(new URL(cadcSearchUrl(field)).searchParams.has('Observation.collection'), false);
  // The circle is clamped as the count's own question is.
  assert.match(new URL(cadcSearchUrl({ ...field, radiusDeg: 40 })).searchParams.get('Plane.position.bounds'), / 0\.3000$/);
  assert.throws(() => cadcSearchUrl({ ra: NaN, dec: 1, radiusDeg: 0.1 }));
});
