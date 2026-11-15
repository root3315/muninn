/**
 * vr.html names every module the VR page imports as a modulepreload, so the
 * browser asks for all of them at once instead of one level of imports at a
 * time. A module added to the graph and not to the page would quietly bring
 * the waterfall back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const IMPORT = /(?:\bfrom\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+\.js)['"]/g;

function graph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(PUBLIC + file, 'utf8').matchAll(IMPORT)) walk(posix.normalize(posix.join(posix.dirname(file), m[1])));
  };
  walk(entry);
  return seen;
}

test('vr.html preloads the whole VR module graph, and nothing else', () => {
  const page = readFileSync(`${PUBLIC}vr.html`, 'utf8');
  const preloaded = new Set([...page.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]));
  assert.deepEqual([...graph('js/vr/main.js')].sort(), [...preloaded].sort());
});
