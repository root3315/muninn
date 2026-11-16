import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moonGeocentric } from '../public/js/fly/solar.js';

/*
 * The Moon from the Earth's centre, km, ICRF axes, geometric (no light time),
 * from JPL Horizons (DE441), asked on 2026-11-17:
 * COMMAND=301, CENTER=500@399, EPHEM_TYPE=VECTORS, REF_PLANE=FRAME,
 * REF_SYSTEM=ICRF, TIME_TYPE=UT. Julian date (UT) and x, y, z.
 */
const HORIZONS = [
  [2451545.0, -2.915670760779644e5, -2.667595825881826e5, -7.612182661145244e4],
  [2460000.5, 2.996205478050650e5, 2.166584458064773e5, 9.572421671738554e4],
  [2461000.25, -1.815061140370363e5, -3.184437114208919e5, -1.759020368776144e5],
  [2461361.5, 3.006120879746720e5, -2.399641100528821e5, -1.080128102435152e5],
  [2462500.75, -3.087790738702047e5, -1.706040120949776e5, -1.032339335914954e5],
];

const OBLIQUITY = (23.43928 * Math.PI) / 180;
const AU_KM = 149597870.7;
const toEquatorialKm = ([x, y, z]) => [
  x * AU_KM,
  (y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY)) * AU_KM,
  (y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY)) * AU_KM,
];
const len = (a) => Math.hypot(...a);

for (const [jd, ...want] of HORIZONS) {
  test(`the Moon at JD ${jd} is where JPL Horizons has it`, () => {
    const got = toEquatorialKm(moonGeocentric(new Date((jd - 2440587.5) * 86400000)));
    const cos = (got[0] * want[0] + got[1] * want[1] + got[2] * want[2]) / (len(got) * len(want));
    const degrees = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
    const km = Math.abs(len(got) - len(want));
    assert.ok(degrees < 0.05, `${degrees.toFixed(4)}° off`);
    assert.ok(km < 60, `${km.toFixed(0)} km off in distance`);
  });
}
