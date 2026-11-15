/**
 * frameindex.js — Muninn's own index of SPHEREx frames: the sky grid it is
 * filed under, the footprint test a cone search makes, and a stored row turned
 * back into the frame the page reads.
 *
 * The index is built by tools/build-frame-index.mjs from IRSA's ObsCore table
 * and read by the relay when IRSA does not answer. A frame is filed once, in
 * the cell that holds its centre; a search reads every cell whose centres can
 * reach the position, then keeps the frames whose footprint meets the cone.
 * That is what IRSA's SIA does with POS=CIRCLE: a frame is listed when its
 * footprint polygon and the circle overlap, with the polygon's edges taken as
 * great-circle arcs.
 */

/** The grid: bands of TILE_DEG in Dec, each cut into near-square cells in RA. */
export const TILE_DEG = 2;
const BANDS = 180 / TILE_DEG;

const RAD = Math.PI / 180;

/** How many RA cells band `b` is cut into: about TILE_DEG wide at the band's widest. */
export function cellsInBand(b) {
  const lo = -90 + b * TILE_DEG;
  const hi = lo + TILE_DEG;
  const widest = lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
  return Math.max(1, Math.floor((360 * Math.cos(widest * RAD)) / TILE_DEG));
}

const bandOf = (dec) => Math.min(BANDS - 1, Math.max(0, Math.floor((dec + 90) / TILE_DEG)));
const wrapRa = (ra) => ((ra % 360) + 360) % 360;

/** The cell a position is filed under, as "band-cell". */
export function tileOf(ra, dec) {
  const b = bandOf(dec);
  const n = cellsInBand(b);
  return `${b}-${Math.min(n - 1, Math.floor((wrapRa(ra) / 360) * n))}`;
}

/**
 * Every cell holding a point within `reach` degrees of (ra, dec): the cells a
 * frame filed by its centre can sit in and still cover the position.
 */
export function tilesNear(ra, dec, reach) {
  const tiles = [];
  const b0 = bandOf(Math.max(-90, dec - reach));
  const b1 = bandOf(Math.min(90, dec + reach));
  // The widest a cap of `reach` round (ra, dec) spans in RA, at any Dec; a
  // cap over a pole spans all of it.
  const overPole = Math.abs(dec) + reach >= 90;
  const halfWidth = overPole ? 180 : Math.asin(Math.sin(reach * RAD) / Math.cos(dec * RAD)) / RAD;
  for (let b = b0; b <= b1; b += 1) {
    const n = cellsInBand(b);
    if (overPole) {
      for (let c = 0; c < n; c += 1) tiles.push(`${b}-${c}`);
      continue;
    }
    const first = Math.floor(((ra - halfWidth) / 360) * n);
    const last = Math.floor(((ra + halfWidth) / 360) * n);
    const seen = new Set();
    for (let c = first; c <= last; c += 1) {
      const cell = ((c % n) + n) % n;
      if (!seen.has(cell)) { seen.add(cell); tiles.push(`${b}-${cell}`); }
    }
  }
  return tiles;
}

/* ------------------------------------------------------------ the sphere */

const vec = (ra, dec) => {
  const r = ra * RAD;
  const d = dec * RAD;
  return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const angle = (a, b) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

/** The angle in degrees between two positions. */
export function separation(ra1, dec1, ra2, dec2) {
  return angle(vec(ra1, dec1), vec(ra2, dec2)) / RAD;
}

/** The corners of an ObsCore s_region ("POLYGON ICRS ra dec ra dec …"), without a repeated last corner. */
export function parseRegion(region) {
  const nums = String(region ?? '').trim().split(/\s+/).slice(2).map(Number);
  if (nums.length < 6 || nums.length % 2 || nums.some((n) => !Number.isFinite(n))) return null;
  const n = nums.length;
  if (n >= 8 && nums[0] === nums[n - 2] && nums[1] === nums[n - 1]) nums.length = n - 2;
  return nums;
}

/** The shortest angle from p to the great-circle arc a→b. */
function arcDistance(p, a, b) {
  const n = cross(a, b);
  const len = Math.hypot(...n);
  if (len < 1e-15) return angle(p, a);
  const unit = [n[0] / len, n[1] / len, n[2] / len];
  const h = dot(p, unit);
  const foot = norm([p[0] - h * unit[0], p[1] - h * unit[1], p[2] - h * unit[2]]);
  // The foot of the perpendicular lies on the arc when it sits between a and b.
  if (dot(cross(a, foot), unit) >= 0 && dot(cross(foot, b), unit) >= 0) return Math.asin(Math.min(1, Math.abs(h)));
  return Math.min(angle(p, a), angle(p, b));
}

/**
 * Whether a circle of `radius` degrees round (ra, dec) and a convex footprint
 * (flat [ra, dec, ra, dec, …] corners, in either winding) meet.
 */
export function footprintMeetsCone(corners, ra, dec, radius) {
  const p = vec(ra, dec);
  const pts = [];
  for (let i = 0; i < corners.length; i += 2) pts.push(vec(corners[i], corners[i + 1]));
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const side = dot(cross(pts[i], pts[(i + 1) % pts.length]), p);
    if (side > 0) pos += 1; else if (side < 0) neg += 1;
  }
  if (!pos || !neg) return true;
  const r = radius * RAD;
  for (let i = 0; i < pts.length; i += 1) {
    if (arcDistance(p, pts[i], pts[(i + 1) % pts.length]) <= r) return true;
  }
  return false;
}

/** The farthest a footprint's corner lies from its centre, in degrees. */
export function footprintReach(corners, ra, dec) {
  let far = 0;
  for (let i = 0; i < corners.length; i += 2) far = Math.max(far, separation(ra, dec, corners[i], corners[i + 1]));
  return far;
}

/* ---------------------------------------------------------------- rows */

/**
 * One stored row: [obsId, detector, mjd, exptime, ra, dec, corners,
 * collection index, emMin µm, emMax µm, version index]. The file's address at
 * IRSA is rebuilt from the obsId, the detector and the processing version.
 */
export const ROW = { obsId: 0, det: 1, mjd: 2, exp: 3, ra: 4, dec: 5, corners: 6, coll: 7, emMin: 8, emMax: 9, ver: 10 };

const IRSA_DATA = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';

/** "2025W18_1B_0224_2" → "2025W18_1B": the week folder the frame is filed under. */
export const weekDirOf = (obsId) => obsId.split('_').slice(0, 2).join('_');

/** "spherex_dr1_deep" → "dr1": the release folder at IRSA and on the S3 mirror. */
export const releaseOf = (collection) => collection.split('_')[1];

/** The key of a frame's file under the release, as IRSA and the S3 mirror name it. */
export function frameKey(collection, obsId, det, version) {
  return `${releaseOf(collection)}/level2/${weekDirOf(obsId)}/${version}/${det}/level2_${obsId}D${det}_spx_${version}.fits`;
}

/**
 * A cone search over an index: `readCell(id)` gives a cell's stored rows, and
 * the answer is every frame of the collection whose footprint meets the cone,
 * uncapped, in the cells' order.
 */
export async function searchIndex(readCell, meta, collection, ra, dec, radius) {
  const which = meta.collections.indexOf(collection);
  const reach = meta.reachDeg + radius;
  const frames = [];
  for (const id of tilesNear(ra, dec, reach)) {
    for (const row of await readCell(id)) {
      if (row[ROW.coll] !== which || Math.abs(row[ROW.dec] - dec) > reach) continue;
      if (footprintMeetsCone(row[ROW.corners], ra, dec, radius)) frames.push(frameFromIndexRow(row, meta));
    }
  }
  return frames;
}

/* ------------------------------------------------- versions on the mirror */

const S3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';

/** Every key and sub-folder the public S3 mirror lists under a prefix. */
export async function s3List(prefix, { delimiter = '', timeoutMs = 60_000, base = S3 } = {}) {
  const keys = [];
  const folders = [];
  let token = '';
  do {
    const params = new URLSearchParams({ 'list-type': '2', prefix });
    if (delimiter) params.set('delimiter', delimiter);
    if (token) params.set('continuation-token', token);
    const res = await fetch(`${base}?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw Object.assign(new Error(`S3 HTTP ${res.status}`), { status: res.status });
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) folders.push(m[1]);
    token = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? '';
  } while (token);
  return { keys, folders };
}

/** "dr1/level2/2025W18_1B": the week folder a frame of a collection sits in. */
export const folderOf = (collection, obsId) => `${releaseOf(collection)}/level2/${weekDirOf(obsId)}`;

/**
 * The processing version of a week folder on the mirror: its name when the
 * folder holds one, null when it holds none, and when a week was reprocessed
 * in part, the newest version of each file by "<obsId>D<det>".
 */
export async function folderVersions(folder, list = s3List) {
  const { folders } = await list(`${folder}/`, { delimiter: '/' });
  const names = folders.map((v) => v.slice(folder.length + 1, -1)).sort().reverse();
  if (names.length <= 1) return names[0] ?? null;
  const files = {};
  for (const key of (await list(`${folder}/`)).keys) {
    const m = /\/([^/]+)\/\d\/level2_(.+)_spx_[^/]+\.fits$/.exec(key);
    if (m && !(files[m[2]] > m[1])) files[m[2]] = m[1];
  }
  return { versions: names, files };
}

/** The version one frame's file carries, from a folderVersions answer. */
export function versionIn(entry, obsId, det) {
  if (!entry || typeof entry === 'string') return entry ?? null;
  return entry.files[`${obsId}D${det}`] ?? null;
}

/**
 * At most `cap` frames, spread evenly over time, as IRSA caps a long list.
 * The page reads changes between visits, so a cap that kept only the first
 * months would hide the rest.
 */
export function spreadCap(frames, cap) {
  if (frames.length <= cap) return frames;
  const sorted = frames.slice().sort((a, b) => a.mjd - b.mjd);
  return Array.from({ length: cap }, (_, i) => sorted[Math.floor((i * sorted.length) / cap)]);
}

const round = (value, places) => Number(value.toFixed(places));

/** A stored row as the frame /api/search answers with, the shape frameFromRow gives. */
export function frameFromIndexRow(row, meta, version = meta.versions[row[ROW.ver]]) {
  const collection = meta.collections[row[ROW.coll]];
  const det = row[ROW.det];
  const mjd = row[ROW.mjd];
  return {
    obsId: row[ROW.obsId],
    mjd,
    iso: new Date((mjd - 40587) * 86400000).toISOString().replace('Z', ''),
    band: `D${det}`,
    detector: det,
    emMin: row[ROW.emMin],
    emMax: row[ROW.emMax],
    ra: row[ROW.ra],
    dec: row[ROW.dec],
    exptime: row[ROW.exp] || null,
    collection,
    url: `${IRSA_DATA}${frameKey(collection, row[ROW.obsId], det, version)}`,
  };
}

/**
 * A row from IRSA's ObsCore CSV as stored, or null for a row that is not a
 * frame. Numbers are kept to what they mean: 1e-6 of a degree, of a day.
 */
export function indexRowFromObscore(row, collections, versionIndex) {
  const obsId = String(row.obs_id ?? '').trim();
  const det = Number(String(row.energy_bandpassname ?? '').replace('SPHEREx-D', ''));
  const corners = parseRegion(row.s_region);
  const mjd = Number(row.t_min);
  const coll = collections.indexOf(String(row.obs_collection ?? '').trim());
  if (!obsId || !(det >= 1 && det <= 6) || !corners || !Number.isFinite(mjd) || coll < 0) return null;
  return [
    obsId, det, round(mjd, 6), round(Number(row.t_exptime) || 0, 4),
    round(Number(row.s_ra), 6), round(Number(row.s_dec), 6), corners.map((c) => round(c, 6)),
    coll, round(Number(row.em_min) * 1e6, 4), round(Number(row.em_max) * 1e6, 4), versionIndex,
  ];
}
