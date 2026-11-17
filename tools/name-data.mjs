#!/usr/bin/env node
/**
 * name-data.mjs — give the site's data files names the edge may keep.
 *
 *   node tools/name-data.mjs
 *
 * The box answers in milliseconds, but the tunnel in front of it sometimes
 * holds a request for many seconds, and Cloudflare keeps a file at its edge
 * only by the file's extension: a .js, .png or .bin, never a .json. So every
 * JSON file the page asked for went through the tunnel on every visit.
 *
 * This writes public/js/datanames.js: for each JSON file under public/data,
 * a name of the form `data/targets.<hash>.bin`, the hash being the file's
 * own (sha256, ten hex digits); for each picture and binary file
 * (data/fly/stars.bin, data/sky/milkyway.png), the same with its own
 * extension, which the edge does keep, but only for as long as the box said
 * (ten minutes) before asking the box again. The server answers that name with the file
 * itself, marked to be kept for good while the hash matches (server.js,
 * dataAlias); a changed file is a new hash and so a new name. Two small
 * lists the page needs before anything else, the ready fields
 * (data/fields/index.json) and which of them have kept pixels
 * (data/fields/baked.json), are written into the module whole, so they cost
 * no request at all. The module is code, so it travels under the code's tag.
 *
 * Run after anything that changes a file under public/data; bake-fields.mjs
 * runs it itself. A page that preloads one of these files (fly.html) is
 * given the same name here. tests/datanames.test.mjs fails while either is
 * behind.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = new URL('../public/', import.meta.url);
const OUT = new URL('js/datanames.js', ROOT);

/** The hashed name a data file is asked for under: a JSON file's as .bin, any other's with its own extension. */
export function hashedName(path, bytes) {
  const [, stem, ext] = /^(.*)\.(\w+)$/.exec(path);
  return `${stem}.${createHash('sha256').update(bytes).digest('hex').slice(0, 10)}.${ext === 'json' ? 'bin' : ext}`;
}

/** The files named: JSON, binary and pictures; a ready field's pixels are already named by their hash. */
const NAMED = /\.(json|bin|png|jpg)$/;
const ALREADY_HASHED = /^data\/fields\/.+\.bin$/;

async function dataFiles(dir = 'data') {
  const out = [];
  for (const entry of (await readdir(new URL(`${dir}/`, ROOT), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await dataFiles(path));
    else if (NAMED.test(entry.name) && !ALREADY_HASHED.test(path)) out.push(path);
  }
  return out;
}

async function dataNames() {
  const names = {};
  for (const path of await dataFiles()) names[path] = hashedName(path, await readFile(new URL(path, ROOT)));
  return names;
}

/** The pages that may preload a data file. */
const PAGES = ['index.html', 'fly.html', 'allsky.html', 'vr.html', 'talk.html'];

/** Whether `href` is `path` under its plain name or under any hashed one. */
function namesFile(href, path) {
  if (href === path) return true;
  const [, stem, ext] = /^(.*)\.(\w+)$/.exec(path);
  const hashed = `${ext === 'json' ? 'bin' : ext}`;
  return href.startsWith(`${stem}.`) && href.endsWith(`.${hashed}`)
    && /^[0-9a-f]{10}$/.test(href.slice(stem.length + 1, href.length - hashed.length - 1));
}

/** A page's text with every preloaded data file under its current hashed name. */
export function withDataNames(html, names) {
  return html.replace(/(<link rel="preload" href=")(data\/[^"]+)(")/g, (all, head, href, tail) => {
    const path = Object.keys(names).find((p) => namesFile(href, p));
    return path ? `${head}${names[path]}${tail}` : all;
  });
}

/** The pages as they are and as they should read: [file, text now, text with the current names]. */
export async function pagesWithNames() {
  const names = await dataNames();
  const out = [];
  for (const page of PAGES) {
    const text = await readFile(new URL(page, ROOT), 'utf8').catch(() => null);
    if (text != null) out.push([page, text, withDataNames(text, names)]);
  }
  return out;
}

/** The module's text, from the files as they are on disk now. */
export async function dataNamesSource() {
  const names = await dataNames();
  const read = (path, fallback) => readFile(new URL(path, ROOT), 'utf8').then(JSON.parse, () => fallback);
  const fieldList = await read('data/fields/index.json', []);
  const baked = await read('data/fields/baked.json', {});
  return `/**
 * datanames.js — written by tools/name-data.mjs; not edited by hand.
 *
 * Each data file under the name the edge may keep (its own hash, as .bin),
 * and the two lists the page needs first, whole.
 */

export const DATA_NAMES = ${JSON.stringify(names, null, 1)};

/** data/fields/index.json: the fields whose frame lists ship with the page. */
export const FIELD_LIST = ${JSON.stringify(fieldList)};

/** data/fields/baked.json: which fields and bands have kept pixels, and of when. */
export const BAKED_FIELDS = ${JSON.stringify(baked)};
`;
}

export async function writeDataNames() {
  await writeFile(OUT, await dataNamesSource());
  for (const [page, now, named] of await pagesWithNames()) {
    if (named !== now) await writeFile(new URL(page, ROOT), named);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeDataNames();
  console.log(`wrote ${fileURLToPath(OUT)}`);
}
