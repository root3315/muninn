/**
 * bodycard.js — what a marked thing is, before what SPHEREx measured of it.
 *
 * An asteroid or comet SkyBoT named goes round the Sun: its class, its orbit
 * in figures, and a sketch of that orbit from above with where it and the
 * Earth are today, worked out from JPL's elements (orbit.js); then who else
 * goes round on nearly the same orbit, the closest of them drawn faintly
 * beside it. A star goes round the centre of the Milky Way: its type, its
 * distance where its parallax is good enough to give one, whether it is a
 * pair, and its planets and companion stars if it has known planets. A
 * galaxy: its redshift.
 *
 * The answers that take a question (JPL's orbit and its neighbours, the
 * planet hosts) are kept on the mark, asked once, and the card is drawn
 * again when they come.
 */

import {
  orbitPath, positionAt, earthAt, referencesFor, sketchReach, julianDay, drawable,
  closestOrbits, crossesEarth, trojanPoint, NEAR_BOX,
} from './orbit.js';
import { smallBodyOrbit, orbitNeighbours } from './catalog.js';
import { planetHostNear, systemUrl, detectorUrl } from './exovision.js';
import { whoSoFar } from './marks.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A planet host this close to a mark is the mark: a SPHEREx pixel is 6″. */
const HOST_REACH_ARCSEC = 12;
/** A parallax gives a distance worth quoting from five times its error. */
const PARALLAX_MIN_SNR = 5;
const LY_PER_MAS = 3261.56;
const STAR_FAMILIES = new Set(['star', 'variable', 'double', 'eclipsing']);
const PAIR_FAMILIES = new Set(['double', 'eclipsing']);
const FAR_FAMILIES = new Set(['galaxy', 'agn', 'quasar']);
/** Half the sketch's width, in its own units. */
const HALF = 100;
/** Neighbours named on the card and drawn in the sketch. */
const CLOSEST_SHOWN = 5;

/** The designation JPL knows a SkyBoT body by: its number when it has one. */
function designationOf(catalog) {
  if (catalog?.state !== 'match') return null;
  const o = catalog.object ?? {};
  return o.num ? String(o.num) : (o.name ? String(o.name) : null);
}

/** Ask JPL for a named body's orbit once, keeping the answer on the mark. */
function askOrbit(m, des, { live, onChange }) {
  if (m.orbitAsk?.des === des) return m.orbitAsk;
  const ask = { des, state: 'asking', orbit: null };
  m.orbitAsk = ask;
  smallBodyOrbit(des)
    .then((orbit) => { ask.state = orbit ? 'done' : 'failed'; ask.orbit = orbit; })
    .catch(() => { ask.state = 'failed'; })
    .finally(() => { if (m.orbitAsk === ask && live()) onChange(); });
  return ask;
}

/** Ask JPL once for the bodies on nearly the same orbit, keeping the answer on the mark. */
function askNear(m, k, { live, onChange }) {
  if (m.nearAsk?.des === k.des) return m.nearAsk;
  const ask = { des: k.des, state: 'asking', count: 0, closest: [], scale: 1, read: 0 };
  m.nearAsk = ask;
  orbitNeighbours(k)
    .then(({ count, rows, scale }) => {
      ask.state = 'done';
      ask.count = count;
      ask.read = rows.length;
      ask.scale = scale;
      ask.closest = closestOrbits(k, rows, CLOSEST_SHOWN);
    })
    .catch(() => { ask.state = 'failed'; })
    .finally(() => { if (m.nearAsk === ask && live()) onChange(); });
  return ask;
}

/** Ask once whether a star with known planets sits on the mark. */
function askHost(m, { live, onChange }) {
  const at = m.who?.at ?? { ra: m.ra, dec: m.dec };
  const key = `${at.ra.toFixed(4)} ${at.dec.toFixed(4)}`;
  if (m.hostAsk?.key === key) return m.hostAsk;
  const ask = { key, state: 'asking', host: null };
  m.hostAsk = ask;
  planetHostNear(at.ra, at.dec, HOST_REACH_ARCSEC)
    .then((host) => {
      ask.state = 'done';
      ask.host = host;
      if (host && m.hostAsk === ask && live()) onChange();
    })
    .catch(() => { ask.state = 'failed'; });
  return ask;
}

const line = (text, className = 'body__line') => {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
};

/** Figures to a sensible number of places: fewer the bigger they are. */
const figure = (x, fmt) => fmt(x, Math.abs(x) < 10 ? 2 : 1);

/** An orbit class in words: ours where there is one, else JPL's own English name. */
function classWords({ code, name }, t) {
  const key = `body.cls.${code}`;
  const words = t(key);
  return words === key ? name : words;
}

/** The orbit seen from above the planets' plane, with the Sun, the planets for scale, and today's places. */
function orbitSketch(k, { t, now, near = [] }) {
  const reach = sketchReach(k) * 1.08;
  const s = HALF / reach;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${-HALF} ${-HALF} ${2 * HALF} ${2 * HALF}`);
  svg.setAttribute('class', 'body-sketch');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('body.sketchNote'));
  const add = (tag, attrs, text) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [name, v] of Object.entries(attrs)) el.setAttribute(name, v);
    if (text) el.textContent = text;
    svg.append(el);
    return el;
  };
  const xy = (p) => [p.x * s, -p.y * s];

  for (const planet of referencesFor(k)) {
    const r = planet.a * s;
    add('circle', { cx: 0, cy: 0, r, class: 'body-sketch__ref' });
    // A circle too small to carry its name goes without one: the caption says what the circles are.
    if (r > 16) add('text', { x: 0, y: -r - 3, class: 'body-sketch__label' }, t(planet.key === 'earth' ? 'body.earth' : `planet.${planet.key}`));
  }
  const pathOf = (orbit, steps, className) => {
    const path = orbitPath(orbit, steps).map(xy);
    if (path.length) add('path', { d: `M${path.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z`, class: className });
  };
  // The neighbours under the body's own orbit, so that it stays on top.
  for (const other of near) pathOf(other, 120, 'body-sketch__near');
  pathOf(k, 180, 'body-sketch__orbit');
  add('circle', { cx: 0, cy: 0, r: 3.2, class: 'body-sketch__sun' });
  const [ex, ey] = xy(earthAt(now));
  add('circle', { cx: ex, cy: ey, r: 2.6, class: 'body-sketch__earth' });
  const here = positionAt(k, now);
  if (here) {
    const [bx, by] = xy(here);
    add('circle', { cx: bx, cy: by, r: 3.4, class: 'body-sketch__now' });
  }
  return svg;
}

/** A small body's lines: what it goes round, its class, its orbit in figures and drawn. */
function smallBodyNodes(m, des, { t, fmt, live, onChange }) {
  const ask = askOrbit(m, des, { live, onChange });
  if (ask.state === 'asking') return [line(t('body.roundSun'))];
  if (ask.state === 'failed' || !ask.orbit) return [line(t('body.roundSun')), line(t('body.orbitFailed'), 'body__line body__line--dim')];
  const k = ask.orbit;
  const cls = k.cls ? classWords(k.cls, t) : null;
  const nodes = [line([t('body.roundSun'), cls].filter(Boolean).join(' · '))];
  if (!drawable(k)) return nodes;
  nodes.push(line(t('body.orbitLine', {
    a: figure(k.a, fmt), e: fmt(k.e, 3), i: fmt(k.i, 1), p: figure(k.years, fmt),
  }), 'body__line body__figures num'));
  const now = julianDay(Date.now());
  if (k.cls?.code === 'TJN') {
    const point = trojanPoint(k, now);
    nodes.push(line(point ? t(`body.trojan${point}`) : t('body.trojan')));
  }
  if (k.neo && crossesEarth(k)) {
    nodes.push(line(t('body.crossesEarth', { q: fmt(k.q, 3), Q: fmt(k.Q, 3) }), 'body__line body__figures num'));
  }
  const near = askNear(m, k, { live, onChange });
  const figureBox = document.createElement('figure');
  figureBox.className = 'body__sketch';
  const caption = document.createElement('figcaption');
  caption.textContent = near.closest.length ? `${t('body.sketchNote')}; ${t('body.sketchNear')}` : t('body.sketchNote');
  figureBox.append(orbitSketch(k, { t, now, near: near.closest }), caption);
  nodes.push(figureBox, ...nearNodes(near, { t, fmt }));
  return nodes;
}

/**
 * Who else goes round on nearly the same orbit: JPL's count of the bodies in
 * the box round this one (itself left out), and the closest of them by the
 * D-criterion, worked out here from JPL's elements.
 */
function nearNodes(near, { t, fmt }) {
  const dim = 'body__line body__line--dim';
  if (near.state === 'asking') return [line(t('body.nearAsking'), dim)];
  if (near.state === 'failed') return [line(t('body.nearFailed'), dim)];
  const others = Math.max(0, near.count - 1);
  const box = t('body.nearBox', { a: fmt(NEAR_BOX.a * 100, 0), e: fmt(NEAR_BOX.e, 2), i: fmt(NEAR_BOX.i, 1) });
  if (!others) return [line(t('body.nearNone')), line(box, dim)];
  const nodes = [line(t('body.nearCount', { n: others, count: fmt(others, 0) })), line(box, dim)];
  if (!near.closest.length) return nodes;
  // A box of thousands is shrunk at JPL until it sends them all: the closest are chosen from those.
  nodes.push(line(near.scale < 1 ? t('body.nearClosestOf', { n: near.read }) : t('body.nearClosest'), dim));
  const list = document.createElement('ol');
  list.className = 'body__near num';
  for (const other of near.closest) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = other.name.replace(/^\((.+)\)$/, '$1');
    const d = document.createElement('span');
    d.className = 'body__near-d';
    d.textContent = `D ${fmt(other.d, 3)}`;
    item.append(name, d);
    list.append(item);
  }
  nodes.push(list);
  return nodes;
}

/** The kind of thing SIMBAD calls it, in words. */
const kindWords = (simbad, t) => (simbad.family ? t(`kind.${simbad.family}`) : t('kind.other', { code: simbad.otype }));

/** A star's or a galaxy's lines, from what SIMBAD said and the planet hosts. */
function fixedNodes(m, { t, fmt, lang, live, onChange }) {
  const simbad = whoSoFar(m)?.simbad ?? null;
  const host = askHost(m, { live, onChange }).host;
  const family = simbad?.family ?? null;
  const nodes = [];
  if (STAR_FAMILIES.has(family) || (host && !FAR_FAMILIES.has(family))) {
    nodes.push(line([simbad ? kindWords(simbad, t) : t('kind.star'), t('body.galacticOrbit')].join(' · ')));
    if (PAIR_FAMILIES.has(family)) nodes.push(line(t('body.pair')));
    const plx = simbad?.plx;
    if (plx > 0 && simbad.plxErr > 0 && plx / simbad.plxErr >= PARALLAX_MIN_SNR) {
      const ly = LY_PER_MAS / plx;
      nodes.push(line(t('body.distance', { ly: fmt(ly, ly < 100 ? 1 : 0) }), 'body__line num'));
    }
  } else if (FAR_FAMILIES.has(family)) {
    nodes.push(line(kindWords(simbad, t)));
    if (Number.isFinite(simbad.z)) nodes.push(line(t('body.redshift', { z: fmt(simbad.z, Math.abs(simbad.z) < 0.01 ? 4 : 3) }), 'body__line num'));
  } else if (!simbad) {
    // Still in every visit and in no list of names: a star, most likely, or
    // a galaxy too small to show its shape; SIMBAD has nothing on it.
    nodes.push(line(t('body.unnamed')));
  }
  // Any star, planets known or not, can be searched for transits in ExoVision.
  if (!FAR_FAMILIES.has(family)) {
    const p = line(`${t('body.detect')} · `);
    const a = document.createElement('a');
    a.className = 'mark__who-name';
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = detectorUrl({ name: simbad?.name ?? null, ra: m.ra, dec: m.dec }, lang);
    a.textContent = 'ExoVision';
    p.append(a);
    nodes.push(p);
  }
  if (host) {
    const [, , n, name, letters = '', stars = 1] = host;
    const p = line(t('body.planets', { n }));
    if (letters) p.append(` (${[...letters].join(', ')})`);
    p.append(' · ');
    const a = document.createElement('a');
    a.className = 'mark__who-name';
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = systemUrl(host, simbad?.name ?? name, lang);
    a.textContent = 'ExoVision';
    p.append(a);
    nodes.push(p);
    // The archive counts the system's stars; the others go round with this one.
    if (stars > 1) nodes.push(line(t('body.companions', { n: stars - 1 })));
  }
  return nodes;
}

/**
 * The lines of a mark's "What it is" group, or none when nothing is known
 * yet. `live()` says whether the mark is still kept, `onChange` redraws the
 * marks when an answer comes, `showInSpace` opens the flight facing the mark.
 */
export function bodyNodes(m, { t, fmt, lang, live, onChange, showInSpace }) {
  const des = designationOf(m.catalog);
  const nodes = des
    ? smallBodyNodes(m, des, { t, fmt, live, onChange })
    : (m.analysis ? fixedNodes(m, { t, fmt, lang, live, onChange }) : []);
  if (!nodes.length) return [];
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'body__space';
  go.textContent = t('body.showInSpace');
  go.addEventListener('click', () => showInSpace(m));
  return [...nodes, go];
}
