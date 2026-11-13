import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackCSV, markRows } from '../public/js/export.js';

const point = {
  mjd: 61034.690000, obsId: '2025W52_1A_0502_3', band: 'D2',
  ra: 13.4194012, dec: 3.8459034, flux: 10, mag: 13.527, snr: 417.26, noise: 0.02, aperturePx: 9,
};

const HEADER = 'date_utc,mjd,obs_id,band,wavelength_um,bandwidth_um,ra_deg,dec_deg,result,flux_mjy,flux_err_mjy,limit_5sigma_mjy,mag_ab,peak_snr';
const col = (name) => HEADER.split(',').indexOf(name);

test('a track becomes one header and one row a visit', () => {
  const lines = trackCSV([point, { ...point, obsId: 'next' }]).trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], HEADER);
  const row = lines[1].split(',');
  assert.equal(row[col('date_utc')], '2025-12-25T16:33:36');
  assert.equal(row[col('obs_id')], '2025W52_1A_0502_3');
  assert.equal(row[col('ra_deg')], '13.419401');
  assert.equal(row[col('result')], 'detection');
  // 10 MJy/sr over one 6.15" pixel is 8.889 mJy.
  assert.ok(Math.abs(Number(row[col('flux_mjy')]) - 8.889) < 0.01, row[col('flux_mjy')]);
  assert.ok(Math.abs(Number(row[col('flux_err_mjy')]) - 0.0533) < 0.001, 'nine pixels of 0.02 noise');
  assert.equal(row[col('wavelength_um')], '', 'no wavelength until the spectrum is read');
  assert.equal(row[col('peak_snr')], '417.26');
});

test('a visit with a holed aperture keeps its row and leaves the brightness empty', () => {
  const [, row] = trackCSV([{ ...point, flux: null, mag: null }]).trimEnd().split('\r\n');
  const cells = row.split(',');
  assert.equal(cells[col('flux_mjy')], '');
  assert.equal(cells[col('mag_ab')], '');
  assert.equal(cells[col('result')], '');
  assert.equal(cells.length, HEADER.split(',').length);
});

test('the spectrum’s exposures join the track: wavelength on shared rows, new rows for the rest', () => {
  const place = { um: 1.4523, width: 0.0352, measured: true };
  const exposures = [
    // The same visit as the track point: one row, now with its wavelength.
    { frame: { obsId: point.obsId, band: 'D2', mjd: point.mjd }, place, point: { kind: 'detection', mJy: 8.9, err: 0.05 } },
    // The same exposure id in D5: another detector, another row.
    {
      frame: { obsId: point.obsId, band: 'D5', mjd: point.mjd }, at: { ra: 13.42, dec: 3.85 },
      place: { um: 4.1, width: 0.037, measured: true },
      point: { kind: 'limit', mJy: 0.4, err: 0.08 }, measurement: { limit: true, noise: 0.03 },
    },
    {
      frame: { obsId: 'later', band: 'D3', mjd: point.mjd + 3 }, at: { ra: 13.42, dec: 3.85 },
      place: { um: 2.0, width: 0.05, measured: true }, point: { kind: 'saturated' }, measurement: { saturated: true, ra: 13.4201, dec: 3.8501 },
    },
  ];
  const rows = markRows([point], exposures);
  assert.equal(rows.length, 3);
  const lines = trackCSV([point], exposures).trimEnd().split('\r\n').map((l) => l.split(','));
  const [d2, d5, d3] = lines.slice(1);
  assert.equal(d2[col('band')], 'D2');
  assert.equal(d2[col('wavelength_um')], '1.4523');
  assert.equal(d2[col('bandwidth_um')], '0.0352');
  assert.equal(d2[col('peak_snr')], '417.26', 'the track’s own numbers stay');
  assert.equal(d5[col('band')], 'D5');
  assert.equal(d5[col('result')], 'limit');
  assert.equal(d5[col('flux_mjy')], '');
  assert.equal(d5[col('limit_5sigma_mjy')], '0.4000');
  assert.equal(d5[col('ra_deg')], '13.420000', 'where it was looked for');
  assert.equal(d3[col('result')], 'saturated');
  assert.equal(d3[col('flux_mjy')], '');
  assert.equal(d3[col('ra_deg')], '13.420100', 'where the saturated core was found');
});

test('a cell with a comma or a quote is quoted', () => {
  const [, row] = trackCSV([{ ...point, obsId: 'a,"b"' }]).trimEnd().split('\r\n');
  assert.ok(row.includes('"a,""b"""'), row);
});
