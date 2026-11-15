import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tileOf, tilesNear, separation, parseRegion, footprintMeetsCone, footprintReach,
  indexRowFromObscore, frameFromIndexRow, folderVersions, versionIn, spreadCap, ROW,
} from '../public/js/frameindex.js';
import { COLLECTIONS } from '../public/js/release.js';

/** A real DR1 frame over Atala's field, as IRSA's ObsCore lists it. */
const ATALA_ROW = {
  obs_id: '2025W26_2A_0530_1', obs_collection: 'spherex_dr1', energy_bandpassname: 'SPHEREx-D1',
  em_min: '7.4550e-07', em_max: '1.1167e-06', t_min: '60855.150367', t_exptime: '113.582600',
  s_ra: '13.34991872', s_dec: '3.96530538',
  s_region: 'POLYGON ICRS 15.583097775073883 3.0526734279311327 12.394230105175726 1.6613778332389744 '
    + '11.097592214705832 4.89667625698104 14.322380189739699 6.309210036754286 15.583097775073883 3.0526734279311327',
};

test('a footprint meets a cone over it, or reaching its edge, and not one beside it', () => {
  const corners = parseRegion(ATALA_ROW.s_region);
  assert.equal(corners.length, 8);
  assert.equal(footprintMeetsCone(corners, 13.4194, 3.8459, 0.006), true);
  assert.equal(footprintMeetsCone(corners, 20, 3.8459, 0.006), false);
  // Just outside the edge from (15.583, 3.053) to (12.394, 1.661): out for a
  // point, in for a cone that reaches over the edge.
  const outside = [13.99, 2.30];
  assert.equal(footprintMeetsCone(corners, ...outside, 0.0001), false);
  assert.equal(footprintMeetsCone(corners, ...outside, 0.1), true);
  // Either winding.
  const reversed = [];
  for (let i = corners.length - 2; i >= 0; i -= 2) reversed.push(corners[i], corners[i + 1]);
  assert.equal(footprintMeetsCone(reversed, 13.4194, 3.8459, 0.006), true);
  assert.equal(footprintMeetsCone(reversed, ...outside, 0.0001), false);
});

test('a footprint across RA 0 and one over a pole', () => {
  const across = [358.5, -1.5, 1.5, -1.5, 1.5, 1.5, 358.5, 1.5];
  assert.equal(footprintMeetsCone(across, 0, 0, 0.006), true);
  assert.equal(footprintMeetsCone(across, 359.9, 1, 0.006), true);
  assert.equal(footprintMeetsCone(across, 2, 0, 0.006), false);
  const polar = [0, 88, 90, 88, 180, 88, 270, 88];
  assert.equal(footprintMeetsCone(polar, 123, 90, 0.006), true);
  assert.equal(footprintMeetsCone(polar, 45, 89.5, 0.006), true);
  assert.equal(footprintMeetsCone(polar, 45, 86, 0.006), false);
});

test('every cell a point within reach is filed under is among the cells read', () => {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const spots = [[0, 0], [359.999, 10], [0.001, -45], [13.4194, 3.8459], [270, 66.56], [90, -66.56], [10, 89.9], [200, -89.99], [180, 87.5]];
  for (let i = 0; i < 200; i += 1) spots.push([random() * 360, Math.asin(2 * random() - 1) * 180 / Math.PI]);
  const reach = 2.6;
  for (const [ra, dec] of spots) {
    const cells = new Set(tilesNear(ra, dec, reach));
    for (let k = 0; k < 300; k += 1) {
      // A point within reach, in a random direction.
      const d = random() * reach;
      const az = random() * 2 * Math.PI;
      const r = Math.PI / 180;
      const sinDec = Math.sin(dec * r) * Math.cos(d * r) + Math.cos(dec * r) * Math.sin(d * r) * Math.cos(az);
      const dec2 = Math.asin(sinDec) / r;
      const ra2 = ra + Math.atan2(Math.sin(az) * Math.sin(d * r) * Math.cos(dec * r), Math.cos(d * r) - Math.sin(dec * r) * sinDec) / r;
      assert.ok(separation(ra, dec, ra2, dec2) <= reach + 1e-9);
      assert.ok(cells.has(tileOf(ra2, dec2)), `${ra},${dec} → ${ra2},${dec2} in ${tileOf(ra2, dec2)}`);
    }
  }
});

test('a stored row comes back as the frame IRSA lists, file address included', () => {
  const row = indexRowFromObscore(ATALA_ROW, COLLECTIONS, 0);
  const frame = frameFromIndexRow(row, { collections: COLLECTIONS, versions: ['l2b-v27-2026-214'] });
  assert.deepEqual(frame, {
    obsId: '2025W26_2A_0530_1', mjd: 60855.150367, iso: '2025-06-29T03:36:31.708', band: 'D1', detector: 1,
    emMin: 0.7455, emMax: 1.1167, ra: 13.349919, dec: 3.965305, exptime: 113.5826, collection: 'spherex_dr1',
    url: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W26_2A/l2b-v27-2026-214/1/level2_2025W26_2A_0530_1D1_spx_l2b-v27-2026-214.fits',
  });
  assert.ok(footprintReach(row[ROW.corners], row[ROW.ra], row[ROW.dec]) < 2.6);
  assert.equal(indexRowFromObscore({ ...ATALA_ROW, obs_collection: 'spherex_dr1_cal' }, COLLECTIONS, 0), null);
  assert.equal(indexRowFromObscore({ ...ATALA_ROW, s_region: '' }, COLLECTIONS, 0), null);
});

test("a week folder's version: one name, or file by file when the week was reprocessed in part", async () => {
  const listing = {
    'dr1/level2/2025W18_1B/': { folders: ['dr1/level2/2025W18_1B/l2b-v27-2026-196/'], keys: [] },
    'dr1/level2/2025W19_1A/': {
      folders: ['dr1/level2/2025W19_1A/l2b-v27-2026-196/', 'dr1/level2/2025W19_1A/l2b-v28-2026-250/'],
      keys: [
        'dr1/level2/2025W19_1A/l2b-v27-2026-196/1/level2_2025W19_1A_0001_1D1_spx_l2b-v27-2026-196.fits',
        'dr1/level2/2025W19_1A/l2b-v27-2026-196/1/level2_2025W19_1A_0002_1D1_spx_l2b-v27-2026-196.fits',
        'dr1/level2/2025W19_1A/l2b-v28-2026-250/1/level2_2025W19_1A_0002_1D1_spx_l2b-v28-2026-250.fits',
      ],
    },
  };
  const list = async (prefix, { delimiter } = {}) => {
    const entry = listing[prefix] ?? { folders: [], keys: [] };
    return delimiter ? { folders: entry.folders, keys: [] } : { folders: [], keys: entry.keys };
  };
  const one = await folderVersions('dr1/level2/2025W18_1B', list);
  assert.equal(one, 'l2b-v27-2026-196');
  assert.equal(versionIn(one, '2025W18_1B_0001_1', 3), 'l2b-v27-2026-196');
  const mixed = await folderVersions('dr1/level2/2025W19_1A', list);
  assert.equal(versionIn(mixed, '2025W19_1A_0001_1', 1), 'l2b-v27-2026-196');
  assert.equal(versionIn(mixed, '2025W19_1A_0002_1', 1), 'l2b-v28-2026-250');
  assert.equal(versionIn(mixed, '2025W19_1A_0003_1', 1), null);
  assert.equal(await folderVersions('dr1/level2/2099W01_1A', list), null);
});

test('a long list is capped evenly over time, a short one kept whole', () => {
  const frames = Array.from({ length: 1000 }, (_, i) => ({ mjd: 61000 - i }));
  const capped = spreadCap(frames, 100);
  assert.equal(capped.length, 100);
  assert.equal(capped[0].mjd, 60001);
  assert.ok(capped[99].mjd > 60980);
  assert.equal(spreadCap(frames.slice(0, 5), 100).length, 5);
});
