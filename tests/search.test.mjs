/**
 * The wider search: names put the way Sesame reads them, asteroids and
 * comets told from other names, JPL's answers read, the planet hosts found
 * from their first letters and from a planet's name, and the rows merged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normaliseName } from '../public/js/names.js';
import { smallBodyQuery, SBDB_TEXT, readSbdb, horizonsCommand, horizonsUrl, readHorizons } from '../public/js/smallbody.js';
import { indexHosts, planetOf, hostRows } from '../public/js/hosts.js';
import { kindOfOtype, worthAsking, hitOfRow, asteroidNumber } from '../public/js/lookup.js';
import { buildIndex, suggest, mergeRows } from '../public/js/suggest.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const hosts = indexHosts(read('../public/data/planet-hosts.json').hosts);

test('catalogue names are put the way Sesame reads them', () => {
  const gaia = '4472832130942575872';
  assert.equal(normaliseName(`Gaia ${gaia}`), `Gaia DR3 ${gaia}`);
  assert.equal(normaliseName(`gaia${gaia}`), `Gaia DR3 ${gaia}`);
  assert.equal(normaliseName(`Gaia EDR3 ${gaia}`), `Gaia DR3 ${gaia}`, 'EDR3 and DR3 share their numbers');
  assert.equal(normaliseName(`Gaia DR2 ${gaia}`), `Gaia DR2 ${gaia}`);
  assert.equal(normaliseName('TIC-25155310'), 'TIC 25155310');
  assert.equal(normaliseName('tic_25155310'), 'TIC 25155310');
  assert.equal(normaliseName('2MASS 05551028+0724255'), '2MASS J05551028+0724255');
  assert.equal(normaliseName('2MASS J05551028−0724255'), '2MASS J05551028-0724255');
  // What Sesame already reads goes through as typed.
  for (const name of ['HD 209458', 'NGC 4565', 'TRAPPIST-1 e', 'M51', "Barnard's star"]) {
    assert.equal(normaliseName(name), name);
  }
});

test('asteroids and comets are told by their designations', () => {
  const ask = (text) => smallBodyQuery(text);
  assert.deepEqual(ask('(152) Atala'), { sstr: '152', sure: true });
  assert.deepEqual(ask('(152)'), { sstr: '152', sure: true });
  assert.deepEqual(ask('433 Eros'), { sstr: '433', sure: true });
  assert.deepEqual(ask('2024 YR4'), { sstr: '2024 YR4', sure: true });
  assert.deepEqual(ask('2024yr4'), { sstr: '2024 YR4', sure: true });
  assert.deepEqual(ask('1P/Halley'), { sstr: '1P', sure: true });
  assert.deepEqual(ask('67p'), { sstr: '67P', sure: true });
  assert.deepEqual(ask('C/2020 F3 (NEOWISE)'), { sstr: 'C/2020 F3', sure: true });
  // A plain word might be one: asked about, not taken for one.
  assert.deepEqual(ask('Ceres'), { sstr: 'Ceres', sure: false });
  for (const text of ['TRAPPIST-1', 'M51', 'NGC 4565', 'Gaia DR3 4472832130942575872', '148.1 +1.0', "Barnard's star", 'TIC 25155310', '', 'ab']) {
    assert.equal(ask(text), null, text);
  }
  // Whatever it writes, the relay lets through; nothing else gets to JPL.
  for (const text of ['(152) Atala', '2024 YR4', 'C/2020 F3', 'Церера']) assert.match(ask(text).sstr, SBDB_TEXT);
  assert.doesNotMatch('Ceres&sb-kind=a', SBDB_TEXT);
});

test("JPL's answers are read: one body, a shared name, none", () => {
  const one = { signature: {}, object: { des: '433', shortname: '433 Eros', fullname: '433 Eros (A898 PA)', kind: 'an' } };
  assert.deepEqual(readSbdb(one, '433'), [{ des: '433', name: '433 Eros', comet: false }]);
  const shared = {
    code: '300',
    list: [{ pdes: '2688', name: '2688 Halley (1982 HG1)' }, { pdes: '1P', name: '1P/Halley' }, { pdes: '9999', name: '9999 Halleyfield' }],
  };
  // The comet a person means by "Halley" comes first, the asteroid after it.
  assert.deepEqual(readSbdb(shared, 'Halley'), [
    { des: '1P', name: '1P/Halley', comet: true },
    { des: '2688', name: '2688 Halley', comet: false },
  ]);
  assert.deepEqual(readSbdb({ code: '200', message: 'specified object was not found' }, 'Sirius'), []);

  assert.equal(horizonsCommand({ des: '433' }), '433;');
  assert.equal(horizonsCommand({ des: '1P', comet: true }), 'DES=1P;CAP;NOFRAG;');
  assert.equal(horizonsCommand({ des: '2024 YR4' }), 'DES=2024 YR4;');
  const url = new URL(horizonsUrl({ des: '433' }, '2026-11-14'));
  assert.equal(url.host, 'ssd.jpl.nasa.gov');
  assert.equal(url.searchParams.get('START_TIME'), "'2026-11-14'");
  assert.equal(url.searchParams.get('STOP_TIME'), "'2026-11-15'");
  assert.equal(url.searchParams.get('CENTER'), "'500@399'");

  const answer = (name) => ({
    result: `Target body name: ${name}              {source: JPL#659}\n$$SOE\n 2026-Nov-14 00:00, , ,   265.24782,  -26.00474,\n$$EOE\n`,
  });
  assert.deepEqual(readHorizons(answer('433 Eros (A898 PA)'), { des: '433' }), { ra: 265.24782, dec: -26.00474 });
  assert.equal(readHorizons(answer('248370 (2005 QN173)'), { des: '433' }), null, 'another body is no answer');
  assert.ok(readHorizons(answer('NEOWISE (C/2020 F3)'), { des: '2020 F3' }));
  assert.equal(readHorizons({ result: 'No matches found.' }), null);
});

test('a planet by its name is its star', () => {
  const trappist = planetOf('TRAPPIST-1 e', hosts);
  assert.equal(trappist.host.name, 'TRAPPIST-1');
  assert.equal(trappist.letter, 'e');
  assert.equal(planetOf('trappist-1e', hosts)?.host.name, 'TRAPPIST-1');
  assert.equal(planetOf('Kepler-22 b', hosts)?.host.name, 'Kepler-22');
  assert.equal(planetOf('kepler 22b', hosts)?.host.name, 'Kepler-22');
  assert.equal(planetOf('TRAPPIST-1 z', hosts), null, 'no such planet');
  assert.equal(planetOf('Vega b', hosts), null, 'not a known host');
  // Every host carries its letters, one per planet in the archive.
  assert.ok(hosts.hosts.every((h) => /^[b-z]+$/.test(h.letters)));
});

test('stars with planets are offered from their first letters, the shortest name first', () => {
  const rows = hostRows('trappist', hosts);
  assert.equal(rows[0].label, 'TRAPPIST-1');
  assert.equal(rows[0].kind, 'host');
  assert.equal(rows[0].planets, 7);
  const planet = hostRows('TRAPPIST-1 e', hosts);
  assert.equal(planet[0].label, 'TRAPPIST-1 e');
  assert.equal(planet[0].host, 'TRAPPIST-1');
  assert.equal(hostRows('kepler-22', hosts)[0].label, 'Kepler-22');
  assert.equal(hostRows('hd209458', hosts)[0].label, 'HD 209458');
  assert.deepEqual(hostRows('k', hosts), [], 'one letter says nothing');

  // A keystroke is a binary search and a short walk, not a pass over the list.
  const started = performance.now();
  for (let i = 0; i < 2000; i++) hostRows(['ke', 'kepler-1', 'hd 1', 'toi-7', 'wasp'][i % 5], hosts);
  assert.ok((performance.now() - started) / 2000 < 2, 'under 2 ms a keystroke');
});

test("SIMBAD's object types become the kinds the list names", () => {
  assert.equal(kindOfOtype('Sy2'), 'galaxy');
  assert.equal(kindOfOtype('GiG'), 'galaxy');
  assert.equal(kindOfOtype('BLL'), 'quasar');
  assert.equal(kindOfOtype('QSO'), 'quasar');
  assert.equal(kindOfOtype('Pl'), 'exoplanet');
  assert.equal(kindOfOtype('BY*'), 'star');
  assert.equal(kindOfOtype('PM*'), 'star');
  assert.equal(kindOfOtype('PN'), 'nebula');
  assert.equal(kindOfOtype('GlC'), 'cluster');
  assert.equal(kindOfOtype(''), 'object', 'VizieR gives no type');
  assert.ok(worthAsking('Ceres'));
  assert.ok(!worthAsking('Ce'));
  assert.ok(!worthAsking('148.1 +1.0'));
});

test('a row from beyond the page opens as a star, or as a thing named by its kind', () => {
  const say = (key, vars) => (vars?.day ? `${key} ${vars.day}` : key);
  const planet = hostRows('TRAPPIST-1 e', hosts)[0];
  assert.deepEqual(hitOfRow(planet, say), {
    kind: 'star', ra: planet.ra, dec: planet.dec, label: 'TRAPPIST-1', sub: '', what: 'suggest.kind.host · TRAPPIST-1 e',
  });
  const eros = { kind: 'smallbody', label: '433 Eros', ra: 265.25, dec: -26.0, day: '2026-11-14', ref: { des: '433' } };
  const hit = hitOfRow(eros, say);
  assert.equal(hit.kind, 'deep');
  assert.equal(hit.note, 'search.today 2026-11-14');
  assert.equal(asteroidNumber(eros), '433');
  assert.equal(asteroidNumber({ kind: 'smallbody', ref: { des: '2024 YR4' } }), null);
});

test('the rows merge: a planet named in full first, nothing twice', () => {
  const presets = read('../public/data/targets.json').targets;
  const index = buildIndex({ presets, say: (lang, key) => key });
  const text = 'TRAPPIST-1 e';
  const merged = mergeRows(text, suggest(text, index).rows, hostRows(text, hosts));
  assert.equal(merged[0].label, 'TRAPPIST-1 e');

  const sirius = { kind: 'star', label: 'Sirius', ra: 101.287, dec: -16.716 };
  const again = { kind: 'star', label: '* alf CMa', ra: 101.2872, dec: -16.7161, remote: true };
  const far = { kind: 'galaxy', label: 'NGC 4565', ra: 189.0867, dec: 25.9874, remote: true };
  assert.deepEqual(mergeRows('sirius', [sirius], [again, far]).map((r) => r.label), ['Sirius', 'NGC 4565']);
  assert.equal(mergeRows('x', [sirius], [far], 1).length, 1, 'never past the room');

  // "152 Atala" and "(152) Atala" are one name: the ready field is offered.
  assert.equal(suggest('152 atala', index).rows[0]?.ref?.key, 'atala');
});
