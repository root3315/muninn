/**
 * check-vr-layout.mjs — every VR panel opened in a headless Chrome, in
 * Russian and in English, with long content, and checked for text or
 * buttons over each other or past their plate (panel.js layoutIssues).
 *
 *   npm run check:vr-layout            exits 1 on any overlap or clipping
 *
 * The long content: a field with a long name and many bodies, three marks
 * (one on a Gaia star with a nineteen-digit name), its spectrum, the
 * walk-through's every step and its end card, "How to read this", the sky
 * card of a star, the field's list as the relay gives it from its own index
 * with a part missing (LIST_PARTIAL=0 for the index note alone), and the
 * depth view with every failure note on (its
 * catalogues refused for the run). Needs Chrome (CHROME to point elsewhere)
 * and a free port; the server is started here.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 5290;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FIELD = process.env.FIELD || 'epsindib';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'muninn-layout-'));
const debugPort = PORT + 1000;
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--ignore-gpu-blocklist', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

async function finish(code) {
  chrome.kill();
  server.kill();
  for (let k = 0; k < 10; k++) { await sleep(500); try { rmSync(profile, { recursive: true, force: true }); break; } catch { /* still held */ } }
  process.exit(code);
}

let targets = null;
for (let k = 0; k < 60 && !targets; k++) { try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { await sleep(250); } }
if (!targets) { console.error('Chrome did not start'); await finish(2); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const waiting = new Map();
const thrown = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params.exceptionDetails.exception?.description?.slice(0, 200) ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const n = ++seq; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const run = async (js) => (await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })).result.result?.value;
const until = async (js, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run(js) === true) return true; await sleep(400); } return false; };
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

/** Every problem the panels report now, each panel once, shown or not. */
const collect = async (into, where) => {
  for (const p of JSON.parse(await run('JSON.stringify(muninnVR.layout({ shownOnly: false }))'))) {
    for (const issue of p.issues) into.add(`${where} · ${p.name}: ${issue}`);
  }
};

const problems = new Set();
for (const lang of ['ru', 'en']) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/vr.html?lang=${lang}` });
  if (!await until('!!window.muninnVR', 30000)) { problems.add(`${lang}: the page did not start`); continue; }
  // The depth catalogues refused, so every failure note and retry is on.
  await run(`(() => { const real = window.fetch.bind(window); window.fetch = (u, o) => (/api\\/depth|simbad|vizier/i.test(String(u)) ? Promise.resolve(new Response('down', { status: 503 })) : real(u, o)); return 1; })()`);
  await sleep(1500);
  await run('muninnVR.tour.start()');
  await collect(problems, `${lang} welcome`);
  for (let k = 0; k < 13; k++) { await run("muninnVR.tour.press('next')"); await sleep(150); await collect(problems, `${lang} tour`); }
  await run("muninnVR.tour.press('close')");
  // The field's list as the relay gives it with IRSA down: from Muninn's own index, one collection
  // missing, so the own-index note, the partial-list note and its retry are all on the side panel.
  await run(`(() => { const real = window.fetch; window.fetch = async (u, o) => {
    const url = String(u);
    if (/data\\/fields\\/(?!index)/.test(url)) return new Response('no', { status: 404 });
    if (/api\\/search/.test(url)) {
      const field = await (await real(\`data/fields/${FIELD}.json\`)).json();
      return new Response(JSON.stringify({ ok: true, source: 'own-index', indexDate: '2026-11-15T06:33:45.390Z', frames: field.frames,
        partial: ${process.env.LIST_PARTIAL !== '0'}, missing: ${process.env.LIST_PARTIAL !== '0' ? "['spherex_qr3_deep']" : '[]'}, warnings: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return real(u, o);
  }; return 1; })()`);
  await run(`muninnVR.open(${JSON.stringify(FIELD)})`);
  if (!await until("muninnVR.field?.stats.status === 'ready'", 240000)) { problems.add(`${lang}: the field did not open`); continue; }
  await run('(() => { const f = muninnVR.field; f.markAt(0.5, 0.5); f.markAt(0.3, 0.62); f.markAt(0.72, 0.38); f.markAct("spectrum", 0); f.act("read"); return 1; })()');
  await sleep(15000);
  await collect(problems, `${lang} field`);
  await run('muninnVR.flip()');
  await sleep(3000);
  await run("muninnVR.pressDepth('gaia', 0)");
  await sleep(800);
  await collect(problems, `${lang} depth`);
}
if (thrown.length) for (const t of thrown) problems.add(`error: ${t}`);
for (const p of problems) console.log(p);
console.log(problems.size ? `${problems.size} layout problem(s)` : 'no layout problems');
ws.close();
await finish(problems.size ? 1 : 0);
