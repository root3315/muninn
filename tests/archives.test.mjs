/**
 * The question asked of CADC about other telescopes, and reading its answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archivesQuery, readArchives, ARCHIVE_RADIUS } from '../public/js/archives.js';

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
