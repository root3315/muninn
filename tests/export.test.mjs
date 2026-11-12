import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackCSV } from '../public/js/export.js';

const point = {
  mjd: 61034.690000, obsId: '2025W52_1A_0502_3', band: 'D2',
  ra: 13.4194012, dec: 3.8459034, flux: 10, mag: 13.527, snr: 417.26,
};

test('a track becomes one header and one row a visit', () => {
  const lines = trackCSV([point, { ...point, obsId: 'next' }]).trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'date_utc,mjd,obs_id,band,ra_deg,dec_deg,flux_mjy,mag_ab,peak_snr');
  const row = lines[1].split(',');
  assert.equal(row[0], '2025-12-25T16:33:36');
  assert.equal(row[2], '2025W52_1A_0502_3');
  assert.equal(row[4], '13.419401');
  // 10 MJy/sr over one 6.15" pixel is 8.889 mJy.
  assert.ok(Math.abs(Number(row[6]) - 8.889) < 0.01, row[6]);
  assert.equal(row[8], '417.26');
});

test('a visit with a holed aperture keeps its row and leaves the brightness empty', () => {
  const [, row] = trackCSV([{ ...point, flux: null, mag: null }]).trimEnd().split('\r\n');
  const cells = row.split(',');
  assert.equal(cells[6], '');
  assert.equal(cells[7], '');
  assert.equal(cells.length, 9);
});

test('a cell with a comma or a quote is quoted', () => {
  const [, row] = trackCSV([{ ...point, obsId: 'a,"b"' }]).trimEnd().split('\r\n');
  assert.ok(row.includes('"a,""b"""'), row);
});
