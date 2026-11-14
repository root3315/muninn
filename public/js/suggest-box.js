/**
 * The list under a search box: a combobox over the rows `suggest()` gives,
 * the stars with planets (hosts.js), and, once the typing pauses, what
 * SIMBAD, NED and JPL say (lookup.js). While they are asked a row says so;
 * when none knows the name, a row says that too, naming them.
 *
 * ↑ and ↓ move through the rows, Enter takes the lit one (or, with none lit,
 * a target or field at the top or the only row, else submits the text), Escape closes, a press or a tap takes a row. The list
 * keeps the input's focus while it is pressed, and goes away when the input
 * loses it.
 */

import { shortPosition, mergeRows, fold, SUGGEST_MAX } from './suggest.js';
import { hostRows, loadHostIndex } from './hosts.js';
import { lookUp, worthAsking, asteroidNumber, hitOfRow } from './lookup.js';
import { smallBodyQuery } from './smallbody.js';

let boxes = 0;

/** How long the typing must pause before the remote resolvers are asked. */
const REMOTE_PAUSE_MS = 400;

/**
 * @param {HTMLInputElement} input
 * @param {object} how
 * @param {(text: string) => {coords: object|null, coordLike: boolean, rows: object[]}} how.query
 * @param {(row: object) => void} how.pick   a row, or `{kind: 'position', ra, dec}`
 * @param {(key: string) => string} how.say  the reader's strings
 * @param {boolean} [how.up]  always open upward, for a box at the foot of the screen
 * @param {Function} [how.remote]  the remote resolvers, lookUp() unless a test says otherwise
 * @param {Function} [how.hosts]   the planet hosts' index, loadHostIndex() likewise
 */
export function attachSuggest(input, { query, pick, say, up = false, remote = lookUp, hosts = loadHostIndex }) {
  const id = `suggest-${++boxes}`;
  const list = document.createElement('ul');
  list.className = 'suggest';
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.closest('form').append(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');

  let options = [];
  let active = -1;
  let hostIndex = null;
  /** The remote answer for one text: `{ text, busy }` while asked, then with `rows` and `missed`. */
  let asked = null;
  let pause = 0;
  let pending = null;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const light = (i) => {
    active = i;
    options.forEach((o, k) => o.el.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', options[i].el.id);
      options[i].el.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  // A row from beyond the page carries the hit it stands for, built in the reader's language.
  const take = (row) => { close(); pick(row.remote || row.kind === 'host' ? { ...row, hit: hitOfRow(row, say) } : row); };

  /** The page's rows, the planet hosts, and the remote answer for this text once it is in. */
  const rowsFor = (text, rows, room) => {
    const answer = asked && !asked.busy && asked.text === text.trim() ? asked.rows : [];
    // A numbered asteroid that is also a ready field opens as the field, on its own date.
    const ready = rows.filter((r) => r.kind === 'target' || r.kind === 'field');
    const remoteRows = answer.filter((r) => {
      const n = asteroidNumber(r);
      return !n || !ready.some((p) => String(p.ref?.name ?? '').startsWith(`(${n})`));
    });
    const found = hostIndex ? hostRows(text, hostIndex, room) : [];
    const free = room - rows.length;
    const hostCap = Math.max(found.filter((r) => r.host).length, free - remoteRows.length);
    return mergeRows(text, rows, [...found.slice(0, hostCap), ...remoteRows], room);
  };

  /** The line under the rows that says the remote resolvers are being asked, or knew nothing. */
  const statusLine = (text) => {
    if (!asked || asked.text !== text.trim()) return '';
    if (asked.busy) return say(asked.smallBody ? 'search.searchingJpl' : 'search.searching');
    if (options.length) return '';
    if (asked.missed.length >= (asked.smallBody ? 2 : 1)) return say('search.offline');
    if (asked.missed.includes('jpl')) return say('search.notFoundNoJpl');
    return say(asked.smallBody ? 'search.notFoundJpl' : 'search.notFound');
  };

  const open = () => {
    const text = input.value;
    const { coords, coordLike, rows: own } = query(text);
    const rows = rowsFor(text, own, coordLike ? SUGGEST_MAX - 1 : SUGGEST_MAX);
    list.setAttribute('aria-label', say('suggest.label'));
    list.replaceChildren();
    options = [];
    active = -1;

    if (coordLike) {
      if (coords) {
        const row = { kind: 'position', ra: coords.ra, dec: coords.dec, label: shortPosition(coords.ra, coords.dec) };
        options.push({ row, el: optionRow(row, say('suggest.kind.position'), say('suggest.position')) });
      } else {
        const hint = document.createElement('li');
        hint.className = 'suggest__hint';
        hint.setAttribute('role', 'presentation');
        hint.textContent = say('suggest.coordsHint');
        list.append(hint);
      }
    }
    for (const row of rows) {
      options.push({ row, el: optionRow(row, say(`suggest.kind.${row.kind}`), row.label, altOf(row, say), noteOf(row, say)) });
    }
    options.forEach((o, i) => {
      o.el.id = `${id}-${i}`;
      o.el.addEventListener('click', () => take(o.row));
      o.el.addEventListener('pointermove', () => { if (active !== i) light(i); });
      list.append(o.el);
    });
    const status = statusLine(text);
    if (status) {
      const line = document.createElement('li');
      line.className = 'suggest__hint suggest__status';
      line.setAttribute('role', 'presentation');
      line.dataset.state = asked.busy ? 'busy' : 'none';
      line.textContent = status;
      list.append(line);
    }

    const any = list.children.length > 0;
    list.hidden = !any;
    input.setAttribute('aria-expanded', String(any));
    if (any) place();
  };

  // Down, unless asked otherwise or the room below is short and above is not.
  const place = () => {
    list.dataset.up = String(up);
    if (up) return;
    const box = input.closest('form').getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    const need = Math.min(list.scrollHeight, 360) + 12;
    list.dataset.up = String(below < need && box.top > below);
  };

  /**
   * Ask the remote resolvers about the text once the typing pauses, unless
   * the page already has it by that very name, or it is a position.
   */
  const askAfterPause = () => {
    const text = input.value.trim();
    if (asked?.text === text) return;
    clearTimeout(pause);
    pending?.abort();
    pending = null;
    asked = null;
    const q = fold(text);
    const known = options.some((o) => o.row.kind === 'position' || o.row.folded?.includes(q) || fold(o.row.label) === q);
    if (!worthAsking(text) || known) return;
    asked = { text, busy: true, smallBody: Boolean(smallBodyQuery(text)) };
    open();
    pause = setTimeout(async () => {
      const mine = new AbortController();
      pending = mine;
      let answer;
      try {
        answer = await remote(text, { signal: mine.signal });
      } catch {
        if (mine.signal.aborted) return;
        answer = { rows: [], missed: ['sesame', 'jpl'], smallBody: true };
      }
      if (asked?.text !== text) return;
      asked = { text, busy: false, ...answer };
      if (document.activeElement === input) open();
    }, REMOTE_PAUSE_MS);
  };

  // The planet hosts load the first time the box is used; the list is redrawn once they are in.
  const loadHosts = () => {
    if (hostIndex) return;
    hosts().then((index) => {
      hostIndex = index;
      if (document.activeElement === input) open();
    });
  };

  input.addEventListener('input', () => { loadHosts(); open(); askAfterPause(); });
  input.addEventListener('focus', () => { loadHosts(); open(); });
  input.addEventListener('blur', close);
  // A press on the list must not take the focus away and close it first.
  list.addEventListener('pointerdown', (e) => e.preventDefault());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) { open(); if (list.hidden) return; }
      e.preventDefault();
      if (!options.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = active + step;
      light(next < -1 ? options.length - 1 : next >= options.length ? -1 : next);
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0) { e.preventDefault(); take(options[active].row); return; }
      // Nothing lit: a challenge target or a prepared field at the top of the
      // list is what was meant ("WISE 0855", "Atala"), and so is the only
      // row there is. A name the archive's resolver does not know would
      // otherwise go to it and come back "not found". Positions are left to
      // the form, which reads them itself.
      const first = options.find((o) => o.row.kind !== 'position');
      const rows = options.filter((o) => o.row.kind !== 'position');
      if (!list.hidden && first && (['target', 'field'].includes(first.row.kind) || rows.length === 1)) {
        e.preventDefault();
        take(first.row);
        return;
      }
      close();
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    }
  });

  return { close, refresh: () => { if (!list.hidden) open(); } };
}

/** What a row says beside its name: its other name, or how many planets its star has. */
function altOf(row, say) {
  if (row.kind !== 'host') return row.alt ?? '';
  const planets = say('search.planets', { n: row.planets });
  return row.host ? `${row.host} · ${planets}` : planets;
}

/** The line under a row: for a small body, that its place is today's. */
const noteOf = (row, say) => (row.kind === 'smallbody' ? say('search.today', { day: row.day }) : '');

/** One row: the name, what it is, where it is, and a note under them when there is one. */
function optionRow(row, kind, name = row.label, altText = row.alt, note = '') {
  const li = document.createElement('li');
  li.className = 'suggest__row';
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');
  li.dataset.kind = row.kind;

  const label = document.createElement('span');
  label.className = 'suggest__name';
  label.textContent = name;
  if (altText) {
    const alt = document.createElement('span');
    alt.className = 'suggest__alt';
    alt.textContent = altText;
    label.append(' ', alt);
  }
  const what = document.createElement('span');
  what.className = 'suggest__kind';
  what.textContent = kind;
  const where = document.createElement('span');
  where.className = 'suggest__pos num';
  where.textContent = shortPosition(row.ra, row.dec);
  li.append(label, what, where);
  if (note) {
    const under = document.createElement('span');
    under.className = 'suggest__note';
    under.textContent = note;
    li.append(under);
  }
  return li;
}
