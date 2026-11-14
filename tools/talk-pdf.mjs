// The talk as two PDFs, one slide a page at 1920 × 1080, for a room where the
// live deck cannot run.
//
//   PORT=8080 node server.js
//   chrome --headless=new --remote-debugging-port=9222
//   node tools/talk-pdf.mjs 9222 http://127.0.0.1:8080
//
// Each slide is visited in turn and given time to play, so what it computes
// on arrival (the charts, the sky, the typed release line) is drawn; the live
// plate is held on the visit with (152) Atala. Then the print stylesheet lays
// every slide out as a page in the state its animations end in.
//
// The site's fonts are variable, and Chrome writes a variable font into a PDF
// as Type 3 drawings whose text reads back scrambled. Before printing, every
// face in use is swapped for its static instance from tools/print-fonts
// (made by tools/print-fonts.py), served to the page from here, so the PDF
// carries ordinary embedded fonts and a text layer that reads as set.
import { readFile, writeFile } from 'node:fs/promises';

const [cdpPort = '9222', base = 'http://127.0.0.1:8080'] = process.argv.slice(2);
const out = new URL('../public/', import.meta.url);
const printFonts = new URL('print-fonts/', import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  if (msg.method === 'Fetch.requestPaused') servePrintFont(msg.params, msg.sessionId);
});

/** A static font asked for under fonts/print/, from tools/print-fonts. */
async function servePrintFont({ requestId, request }, sessionId) {
  const name = new URL(request.url).pathname.split('/').pop();
  try {
    const body = (await readFile(new URL(name, printFonts))).toString('base64');
    send('Fetch.fulfillRequest', {
      requestId, responseCode: 200, body,
      responseHeaders: [{ name: 'Content-Type', value: 'font/woff2' }],
    }, sessionId);
  } catch {
    send('Fetch.failRequest', { requestId, errorReason: 'FileNotFound' }, sessionId);
  }
}

/**
 * Every loaded face of the deck's fonts again, at the same weight and over
 * the same characters, from its static instance; the later face wins.
 */
const STATIC_FACES = `(async () => {
  const subset = (range) => (range.startsWith('U+0-FF') ? 'latin' : range.startsWith('U+301') ? 'cyrillic' : null);
  const faces = [...document.fonts]
    .filter((f) => f.status === 'loaded' && /^(Unbounded|Onest|JetBrains Mono)$/.test(f.family.replace(/"/g, '')) && subset(f.unicodeRange))
    .map((f) => {
      const family = f.family.replace(/"/g, '');
      const file = family.toLowerCase().replace(/ /g, '-') + '-' + subset(f.unicodeRange) + '-' + f.weight + '.woff2';
      return new FontFace(family, 'url(fonts/print/' + file + ')', { weight: f.weight, style: f.style, unicodeRange: f.unicodeRange });
    });
  await Promise.all(faces.map(async (face) => { await face.load(); document.fonts.add(face); }));
  await document.fonts.ready;
  return faces.length;
})()`;
/** One DevTools call; one that hangs is given up on rather than holding the run. */
const send = (method, params = {}, sessionId, ms = 60000) => new Promise((resolve) => {
  const id = ++seq;
  const timer = setTimeout(() => { waiting.delete(id); console.warn(`${method}: no answer in ${ms} ms`); resolve({}); }, ms);
  waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const evaluate = async (expression, session) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)).result?.result?.value;

/** How long a slide needs before it has played out; the sky needs its card up. */
const settle = (n, count) => (n === 12 ? 6500 : n === count ? 5500 : 4500);

for (const [lang, file] of [['en', 'talk.pdf'], ['ru', 'talk.ru.pdf']]) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Target.activateTarget', { targetId });
  await send('Page.enable', {}, sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/fonts/print/*' }] }, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: `${base}/talk.html?lang=${lang}#1` }, sessionId);
  // The live plate: wait for its four visits, then hold the one with the asteroid.
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await evaluate('[...document.querySelectorAll("#reads button")].filter((b) => !b.disabled).length === 4', sessionId)) break;
  }
  await evaluate('document.querySelectorAll("#reads button")[1]?.click()', sessionId);
  const count = await evaluate('document.querySelectorAll("[data-slide]").length', sessionId);
  for (let n = 1; n <= count; n++) {
    await evaluate(`location.hash = '#${n}'`, sessionId);
    console.log(`${lang} ${n}/${count}`);
    await sleep(settle(n, count));
  }
  await evaluate('document.querySelectorAll("#reads button")[1]?.click()', sessionId);
  console.log(`${lang}: ${await evaluate(STATIC_FACES, sessionId)} faces made static`);
  await sleep(1000);
  const { result } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, sessionId, 300000);
  const pdf = Buffer.from(result.data, 'base64');
  await writeFile(new URL(file, out), pdf);
  console.log(`${file}: ${count} pages, ${(pdf.length / 1048576).toFixed(2)} MB`);
  await send('Target.closeTarget', { targetId });
}
ws.close();
