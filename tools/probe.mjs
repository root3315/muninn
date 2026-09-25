// Round-trip check for the WCS implementation against a real SPHEREx header.
import { readHeader, scanHDUs } from '../public/js/fits.js';
import { WCS } from '../public/js/wcs.js';

const URL_ = process.argv[2] ?? 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr2/level2/2025W47_1A/l2b-v20-2025-324/2/level2_2025W47_1A_0419_1D2_spx_l2b-v20-2025-324.fits';

const res = await fetch(URL_, { headers: { Range: 'bytes=0-65535' } });
console.log('HTTP', res.status, res.headers.get('content-range'));
const buf = await res.arrayBuffer();

const hdus = scanHDUs(buf, { limit: 2 });
const img = hdus.find((h) => h.name === 'IMAGE') ?? hdus[1];
console.log('HDU:', img.name, img.cards.get('NAXIS1') + '×' + img.cards.get('NAXIS2'),
  'BITPIX', img.cards.get('BITPIX'), 'data@', img.dataStart, 'bytes', img.dataBytes);
console.log('DATE-OBS', img.cards.get('DATE-OBS'), 'MJD', img.cards.get('MJD-OBS'));

const w = new WCS(img.cards);
console.log('scale', (w.scale * 3600).toFixed(4), 'arcsec/px · roll', w.rollDeg.toFixed(3), 'deg');

let worst = 0;
let worstAt = null;
for (let y = 20; y <= 2020; y += 143) {
  for (let x = 20; x <= 2020; x += 143) {
    const [ra, dec] = w.pixToWorld(x, y);
    const back = w.worldToPix(ra, dec);
    const err = Math.hypot(back[0] - x, back[1] - y);
    if (err > worst) { worst = err; worstAt = [x, y]; }
  }
}
console.log('round-trip worst error:', worst.toExponential(3), 'px at', worstAt);

const c = w.pixToWorld(1020.5, 1020.5);
console.log('centre  →', c[0].toFixed(6), c[1].toFixed(6), '(CRVAL', w.crval1, w.crval2, ')');
const corners = [[1, 1], [2040, 1], [2040, 2040], [1, 2040]].map((p) => w.pixToWorld(p[0], p[1]));
console.log('corners →', corners.map((p) => p.map((v) => v.toFixed(4)).join(',')).join('  |  '));
