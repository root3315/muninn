/**
 * What the search box offers while it is being typed into.
 *
 * Everything here is already in the page: the challenge targets and ready
 * fields, the named bright stars, the Messier list and the planets, and the
 * stars with known planets (hosts.js). Nothing here goes over the network;
 * the box asks SIMBAD, NED and JPL itself (lookup.js) once typing pauses,
 * and the form asks them when the text is submitted.
 *
 * Matching folds case, accents and the Greek letters (α, alpha, альфа are one
 * word), and counts a hit at the start of the name or of any word in it.
 */

import { parseCoordinates } from './catalog.js';

export const SUGGEST_MAX = 8;

/** Russian names for the named stars, where Russian has its own spelling. */
const STAR_RU = {
  Sirius: 'Сириус', Canopus: 'Канопус', Arcturus: 'Арктур', 'Rigil Kentaurus': 'Ригиль Кентаурус',
  Vega: 'Вега', Capella: 'Капелла', Rigel: 'Ригель', Procyon: 'Процион', Achernar: 'Ахернар',
  Betelgeuse: 'Бетельгейзе', Hadar: 'Хадар', Altair: 'Альтаир', Aldebaran: 'Альдебаран',
  Antares: 'Антарес', Spica: 'Спика', Pollux: 'Поллукс', Fomalhaut: 'Фомальгаут', Mimosa: 'Мимоза',
  Deneb: 'Денеб', Acrux: 'Акрукс', Toliman: 'Толиман', Regulus: 'Регул', Adhara: 'Адара',
  Gacrux: 'Гакрукс', Shaula: 'Шаула', Bellatrix: 'Беллатрикс', Elnath: 'Эльнат',
  Miaplacidus: 'Миаплацидус', Alnilam: 'Альнилам', Alnair: 'Альнаир', Alioth: 'Алиот', Regor: 'Регор',
  Mirfak: 'Мирфак', Dubhe: 'Дубхе', Wezen: 'Везен', 'Kaus Australis': 'Каус Аустралис', Avior: 'Авиор',
  Alkaid: 'Алькаид', Sargas: 'Саргас', Menkalinan: 'Менкалинан', Atria: 'Атриа', Peacock: 'Пикок',
  Castor: 'Кастор', Alphard: 'Альфард', Hamal: 'Хамаль', Polaris: 'Полярная', Nunki: 'Нунки',
  Diphda: 'Дифда', Alnitak: 'Альнитак', Alpheratz: 'Альферац', Mirach: 'Мирах', Kochab: 'Кохаб',
  Rasalhague: 'Рас Альхаг', Tiaki: 'Тиаки', Algol: 'Алголь', Denebola: 'Денебола', Sadr: 'Садр',
  Schedar: 'Шедар', Mintaka: 'Минтака', Alphecca: 'Альфекка', Eltanin: 'Этамин', Naos: 'Наос',
  Aspidiske: 'Аспидиске', Caph: 'Каф', Mizar: 'Мицар', Kakkab: 'Каккаб', Dschubba: 'Джубба',
  Merak: 'Мерак', Ankaa: 'Анкаа', Enif: 'Эниф', Girtab: 'Гиртаб', Scheat: 'Шеат', Sabik: 'Сабик',
  Phecda: 'Фекда', Alderamin: 'Альдерамин', Markab: 'Маркаб', Menkar: 'Менкар', Zosma: 'Зосма',
  Arneb: 'Арнеб', Zubeneschamali: 'Зубен Эльшемали', Sheratan: 'Шератан', Phact: 'Факт',
  Unukalhai: 'Унук аль Хайя', Muphrid: 'Муфрид', Kornephoros: 'Корнефорос', Algenib: 'Альгениб',
  Alcyone: 'Альциона', Fawaris: 'Фаварис', 'Deneb Algedi': 'Денеб Альгеди', Sadalsuud: 'Садальсууд',
  Sadalmelik: 'Садальмелик',
};

/** Russian names for the Messier objects that have a common one. */
const DEEP_RU = {
  M1: 'Крабовидная туманность', M6: 'скопление Бабочка', M7: 'скопление Птолемея',
  M8: 'туманность Лагуна', M11: 'скопление Дикая Утка', M13: 'скопление в Геркулесе',
  M16: 'туманность Орёл', M17: 'туманность Омега', M20: 'туманность Трёхраздельная',
  M24: 'звёздное облако Стрельца', M27: 'туманность Гантель', M31: 'галактика Андромеды',
  M33: 'галактика Треугольника', M42: 'туманность Ориона', M43: 'туманность де Мерана',
  M44: 'Ясли', M45: 'Плеяды', M51: 'галактика Водоворот', M57: 'туманность Кольцо',
  M63: 'галактика Подсолнух', M64: 'галактика Чёрный Глаз', M76: 'туманность Малая Гантель',
  M81: 'галактика Боде', M82: 'галактика Сигара', M83: 'Южная Вертушка', M87: 'Дева A',
  M97: 'туманность Сова', M101: 'галактика Вертушка', M104: 'галактика Сомбреро',
};

/** The Greek letters of the Bayer names, spelled out in both languages. */
const GREEK = {
  α: ['alpha', 'альфа'], β: ['beta', 'бета'], γ: ['gamma', 'гамма'], δ: ['delta', 'дельта'],
  ε: ['epsilon', 'эпсилон'], ζ: ['zeta', 'дзета'], η: ['eta', 'эта'], θ: ['theta', 'тета'],
  ι: ['iota', 'йота'], κ: ['kappa', 'каппа'], λ: ['lambda', 'лямбда'], μ: ['mu', 'мю'],
  ν: ['nu', 'ню'], ξ: ['xi', 'кси'], ο: ['omicron', 'омикрон'], π: ['pi', 'пи'], ρ: ['rho', 'ро'],
  σ: ['sigma', 'сигма'], τ: ['tau', 'тау'], υ: ['upsilon', 'ипсилон'], φ: ['phi', 'фи'],
  χ: ['chi', 'хи'], ψ: ['psi', 'пси'], ω: ['omega', 'омега'],
};

/** What a Messier object's catalogue kind is called in the list. */
const DEEP_KIND = {
  galaxy: 'galaxy', globular: 'cluster', open: 'cluster', asterism: 'cluster',
  nebula: 'nebula', planetary: 'nebula', remnant: 'nebula', star: 'star',
};

/** Which kinds come first when two names match equally well. */
const KIND_ORDER = { target: 0, field: 1, planet: 2, star: 3, galaxy: 4, nebula: 4, cluster: 4 };

/** Rows this close (degrees) are the same thing, found twice. */
const SAME_PLACE_DEG = 0.01;

/** Lower case, no accents, ё as е, the typographic minus as a hyphen. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Brackets go too: "152 atala" and "(152) atala" are one name.
const compact = (s) => s.replace(/[\s·.'’()-]+/g, '');

/** A Bayer name with its Greek letter spelled out: "α Lyr" also reads "alpha Lyr". */
function spelledBayer(bayer) {
  const letter = [...bayer][0];
  const words = GREEK[letter];
  if (!words) return [];
  const rest = bayer.slice(letter.length).replace(/^[¹²³\d]*/, '');
  return words.map((w) => `${w}${rest}`);
}

/** Text that is starting to look like a position rather than a name. */
export function looksLikeCoordinates(text) {
  const s = String(text ?? '').trim();
  return /^[+\-−]?\d/.test(s) && /^[\s\d.,:+\-−hmsd°'′"″ʰᵐˢ]+$/i.test(s);
}

/**
 * Everything the box can offer, built once per opening.
 *
 * @param {object} from
 * @param {object[]} [from.presets]  targets.json entries
 * @param {object} [from.stars]      stars.json (ra, dec, mag, bv arrays and `named`)
 * @param {object} [from.deep]       deepsky.json
 * @param {object[]} [from.planets]  planetsNow()
 * @param {string} [from.lang]       the reader's language
 * @param {(lang: string, key: string) => string} [from.say]  a string in a given language
 */
export function buildIndex({ presets = [], stars = null, deep = null, planets = [], lang = 'en', say = (l, k) => k } = {}) {
  const out = [];
  const add = (entry) => {
    const names = [...new Set(entry.names.filter(Boolean))];
    out.push({ ...entry, seq: out.length, names, folded: names.map(fold) });
  };
  const other = lang === 'ru' ? 'en' : 'ru';

  const ready = presets.filter((p) => Number.isFinite(p.ra) && Number.isFinite(p.dec));
  for (const p of ready) {
    const label = p.key ? say(lang, `preset.${p.key}`) : p.name;
    // The catalogue name beside the short one, unless it says the same thing.
    const [head, tail = ''] = (p.name ?? '').split(' · ');
    add({
      kind: p.group === 'challenge' ? 'target' : 'field',
      label, alt: fold(head) === fold(label) ? tail : head,
      names: [label, p.key ? say(other, `preset.${p.key}`) : '', p.name, ...(p.name ?? '').split(' · ')],
      ra: p.ra, dec: p.dec, ref: p,
    });
  }

  for (const p of planets) {
    add({
      kind: 'planet', label: say(lang, `planet.${p.key}`), alt: '',
      names: [say(lang, `planet.${p.key}`), say(other, `planet.${p.key}`), p.key],
      ra: p.ra, dec: p.dec, ref: p,
    });
  }

  for (const entry of stars?.named ?? []) {
    const i = entry.i;
    const ru = STAR_RU[entry.name];
    const label = (lang === 'ru' && ru) || entry.name || entry.bayer;
    add({
      kind: 'star', label, alt: entry.name ? entry.bayer : '',
      names: [entry.name, ru, entry.bayer, ...spelledBayer(entry.bayer)],
      ra: stars.ra[i], dec: stars.dec[i], mag: stars.mag?.[i],
      ref: { ...entry, mag: stars.mag?.[i], bv: stars.bv?.[i] },
    });
  }

  // A Messier object that is also a ready field is offered once, as the field.
  const isField = (o) => ready.some((p) => Math.abs(p.ra - o.ra) < 0.05 && Math.abs(p.dec - o.dec) < 0.05);
  for (const o of deep?.objects ?? []) {
    if (isField(o)) continue;
    const ru = DEEP_RU[o.id];
    const common = (lang === 'ru' && ru) || o.name;
    add({
      kind: DEEP_KIND[o.kind] ?? (/^G/.test(o.otype ?? '') ? 'galaxy' : 'cluster'),
      label: common ? `${o.id} · ${common}` : o.id, alt: '',
      names: [o.id, o.name, ru],
      ra: o.ra, dec: o.dec, mag: o.mag, ref: o,
    });
  }
  return out;
}

/**
 * How well one entry answers the query: 0 an exact name, 1 the start of a
 * name, 2 the start of a word inside one; null when it does not.
 */
function quality(entry, q) {
  let best = null;
  const qc = compact(q);
  for (const name of entry.folded) {
    if (name === q) return 0;
    if (name.startsWith(q) || (qc.length >= 2 && compact(name).startsWith(qc))) { best = 1; continue; }
    if (best == null && wordStart(name, q)) best = 2;
  }
  return best;
}

function wordStart(name, q) {
  for (let i = name.indexOf(q, 1); i > 0; i = name.indexOf(q, i + 1)) {
    if (!/[\p{L}\p{N}]/u.test(name[i - 1])) return true;
  }
  return false;
}

/**
 * The rows for what has been typed so far.
 *
 * @returns {{coords: {ra:number, dec:number}|null, coordLike: boolean, rows: object[]}}
 *   `coordLike` asks for a hint row; `coords` is set when the text is already a
 *   position. The hint row counts against the maximum.
 */
export function suggest(text, index, { max = SUGGEST_MAX } = {}) {
  const q = fold(text);
  if (!q) {
    const rows = index.filter((e) => e.kind === 'target').slice(0, max);
    return { coords: null, coordLike: false, rows };
  }
  const coordLike = looksLikeCoordinates(text);
  const coords = coordLike ? parseCoordinates(String(text).replace(/−/g, '-')) : null;
  const room = coordLike ? max - 1 : max;

  const hits = [];
  for (const entry of index) {
    const qual = quality(entry, q);
    if (qual != null) hits.push({ entry, qual });
  }
  hits.sort((a, b) => (
    (a.qual === 0 ? 0 : 1) - (b.qual === 0 ? 0 : 1)
    || isReady(a.entry) - isReady(b.entry)
    || a.qual - b.qual
    || KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind]
    || a.entry.seq - b.entry.seq
  ));
  return { coords, coordLike, rows: hits.slice(0, Math.max(0, room)).map((h) => h.entry) };
}

const isReady = (e) => (e.kind === 'target' || e.kind === 'field' ? 0 : 1);

/** A position in the list's own short form: degrees, three places. */
export function shortPosition(ra, dec) {
  const sign = dec < 0 ? '−' : '+';
  return `${ra.toFixed(3)} ${sign}${Math.abs(dec).toFixed(3)}`;
}

/**
 * The box's own rows with rows from elsewhere (the planet hosts, the remote
 * resolvers) after them, up to `room`. A planet named in full ("TRAPPIST-1
 * e") goes first unless an entry here is named exactly what was typed. A row
 * already in the list, by name or by place, is not repeated.
 */
export function mergeRows(text, local, extra, room = SUGGEST_MAX) {
  const q = fold(text);
  const exact = local.some((r) => r.folded?.includes(q));
  const lead = exact ? [] : extra.filter((r) => r.host);
  const out = [...lead, ...local];
  const seen = (row) => out.some((r) => fold(r.label) === fold(row.label)
    || (r.kind !== 'position' && Math.abs(r.ra - row.ra) < SAME_PLACE_DEG && Math.abs(r.dec - row.dec) < SAME_PLACE_DEG
      && (row.kind !== 'host' || r.kind === 'star')));
  for (const row of extra) {
    if (out.length >= room) break;
    if (!out.includes(row) && !seen(row)) out.push(row);
  }
  return out.slice(0, Math.max(0, room));
}
