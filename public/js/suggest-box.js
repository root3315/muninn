/**
 * The list under a search box: a combobox over the rows `suggest()` gives.
 *
 * ↑ and ↓ move through the rows, Enter takes the lit one (or, with none lit,
 * a target or field at the top or the only row, else submits the text), Escape closes, a press or a tap takes a row. The list
 * keeps the input's focus while it is pressed, and goes away when the input
 * loses it.
 */

import { shortPosition } from './suggest.js';

let boxes = 0;

/**
 * @param {HTMLInputElement} input
 * @param {object} how
 * @param {(text: string) => {coords: object|null, coordLike: boolean, rows: object[]}} how.query
 * @param {(row: object) => void} how.pick   a row, or `{kind: 'position', ra, dec}`
 * @param {(key: string) => string} how.say  the reader's strings
 * @param {boolean} [how.up]  always open upward, for a box at the foot of the screen
 */
export function attachSuggest(input, { query, pick, say, up = false }) {
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

  const take = (row) => { close(); pick(row); };

  const open = () => {
    const { coords, coordLike, rows } = query(input.value);
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
    for (const row of rows) options.push({ row, el: optionRow(row, say(`suggest.kind.${row.kind}`)) });
    options.forEach((o, i) => {
      o.el.id = `${id}-${i}`;
      o.el.addEventListener('click', () => take(o.row));
      o.el.addEventListener('pointermove', () => { if (active !== i) light(i); });
      list.append(o.el);
    });

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

  input.addEventListener('input', open);
  input.addEventListener('focus', open);
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

/** One row: the name, what it is, where it is. */
function optionRow(row, kind, name = row.label) {
  const li = document.createElement('li');
  li.className = 'suggest__row';
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');
  li.dataset.kind = row.kind;

  const label = document.createElement('span');
  label.className = 'suggest__name';
  label.textContent = name;
  if (row.alt) {
    const alt = document.createElement('span');
    alt.className = 'suggest__alt';
    alt.textContent = row.alt;
    label.append(' ', alt);
  }
  const what = document.createElement('span');
  what.className = 'suggest__kind';
  what.textContent = kind;
  const where = document.createElement('span');
  where.className = 'suggest__pos num';
  where.textContent = shortPosition(row.ra, row.dec);
  li.append(label, what, where);
  return li;
}
