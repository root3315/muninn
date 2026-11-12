/**
 * talk.js — Muninn in seven slides.
 *
 * The first slide is not a screenshot. It reads four visits of the Atala field
 * from the archive with the same modules the tool uses, and blinks them; the
 * second slide reports what that read actually cost. Every other figure on the
 * slides is one the README derives and the tools in tools/ reproduce.
 */

import { loadStamp } from './stamp.js';
import { TangentGrid } from './wcs.js';
import { toS3 } from './catalog.js';
import { sortedFinite, limitsFromSorted, paint, rampFromToken } from './render.js';
import { FRAME_FILE_MB } from './release.js';
import { deadline, CATALOG_DEADLINE_MS } from './net.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ words */

const WORDS = {
  en: {
    event: 'NASA Space Apps 2026 · Planet X and SPHEREx · team Yggdrasil',
    openTool: 'Open the tool',
    prev: 'Previous slide',
    next: 'Next slide',
    langOther: 'RU',
    's1.claim': 'See what changed between two SPHEREx visits.',
    's1.say': 'SPHEREx images the whole sky about twice a year. Stars stay put; anything bound to the Sun does not. Muninn puts the visits on one grid and blinks them.',
    's1.src': 'These frames are being read from the NASA archive right now, in this browser.',
    's1.alt': 'Four SPHEREx visits of one field, blinking. One dot is present on 25 Dec 2025 only.',
    's1.wait': 'Reading the archive…',
    's1.prevVisit': 'Previous visit',
    's1.nextVisit': 'Next visit',
    's1.play': 'Blink the visits',
    's1.failed': 'The archive did not answer. The tool itself is one click away.',
    's2.claim': 'A 70 MB file, read a megabyte or two at a time.',
    's2.say': 'The browser asks the public AWS mirror for byte ranges: the header, then only the detector rows this field lands on, then the pipeline’s quality flags for the same rows. No pixels pass through our server.',
    's2.src': 'File size 68.3 MB per Level-2 frame; bytes read are measured on the previous slide.',
    's2.head': 'What the four frames on slide 1 cost',
    's2.sum': 'Read {read} MB of {total} MB held at the archive: {pct} %',
    's2.pending': 'Measured once slide 1 has finished reading.',
    's2.share': 'of each file is read',
    's2.size1': '64 KB',
    's2.size2': '1–3 MB',
    's2.step1': 'FITS header and the WCS: where each pixel is on the sky',
    's2.step2': 'only the detector rows the field covers',
    's2.step3': 'the same rows of the FLAGS plane',
    's3.claim': 'It finds a mover, and names it.',
    's3.say': 'Fifteen visits of one spot over 369 days. Fourteen are background. On 25 Dec 2025 SkyBoT places asteroid (152) Atala, V 13.8, 2.3″ from the centre at that exposure’s own timestamp.',
    's3.src': 'tools/verify-mover.mjs 13.4194 3.8459 0.15: brightest pixel against the noise of the ring around it. The tool’s own 3×3-pixel aperture reads about 417σ for the same visit. SkyBoT, IMCCE.',
    's3.head': 'Signal-to-noise at the field centre, visit by visit',
    's4.claim': 'It refuses a false discovery.',
    's4.say': 'On 6 Jul 2025 the same spot flashed at SNR 206 and no catalogue explained it. It was one detector pixel, and the SPHEREx pipeline had already said what: a cosmic-ray hit. Muninn reads those flags and masks the pixel before anything is measured.',
    's4.src': 'Atala’s own pixels on 25 Dec carry only OUTLIER, and spread like a real source.',
    's4.head': '6 Jul 2025, the centre of the Atala field',
    's4.before': 'SNR without the flags',
    's4.beforeSay': 'one pixel at 11× its neighbours',
    's4.after': 'SNR with the flags read',
    's4.afterSay': 'background, like the other visits',
    's4.note': 'A jump in the up-the-ramp samples, caught during readout. The pipeline marked it; a viewer that ignores FLAGS collects cosmic rays.',
    's5.claim': 'The challenge’s five test targets open in one press.',
    's5.say': 'Each opens in the band that suits it, from a frame index that ships with the page. Press a row to open it in the tool.',
    's5.src': 'Visit counts from IRSA SIA at bake time, 11 Nov 2026.',
    's5.head': 'Five targets named by the challenge',
    's5.visits': '{n} visits · {days} d',
    's6.claim': 'Even 200 added visits leave SPHEREx 1.5 to 4.5 magnitudes short of Planet X.',
    's6.say': 'We measured the depth from delivered detector pixels instead of quoting a mission page. One visit is 4.4 to 7.4 magnitudes short; the deepest polar field, 1.5 to 4.5. The page says so on screen.',
    's6.src': 'tools/sensitivity.mjs: 5σ point source, 3×3-pixel aperture. Prediction: Linder & Mordasini 2016, A&A 589, A134, V 22.6–24.3 near aphelion.',
    's6.head': 'Faintest point source at 5σ, AB magnitudes',
    's6.alt': 'A scale from 14 to 26 magnitudes: SPHEREx reaches 17.6 in one visit and 20.5 in two hundred; Planet X is predicted between 22 and 25.',
    's6.here': 'SPHEREx',
    's6.target': 'Planet X, predicted',
    's6.one': 'one visit',
    's6.ten': '10 visits added',
    's6.hundred': '100 visits added',
    's6.deep': '200 visits, deep field',
    's6.short': 'at best short by 1.5–4.5 mag',
    's7.claim': 'What Muninn searches today, and where it stops.',
    's7.say': 'Slow movers brighter than 17.6 AB per visit, season stacks, and a stated depth for every field examined. A null result at a known depth is a constraint.',
    's7.link': 'muninn.mydevbox.xyz',
    's7.does': 'Does today',
    's7.does1': 'Blink, wipe, difference and season stack on one north-up grid',
    's7.does2': 'Measures a marked spot in every visit: position, AB magnitude, verdict',
    's7.does3': 'Names known asteroids at each exposure, identifies stars through Gaia and WISE catalogues and lays their positions over the frame',
    's7.does4': 'Reports the depth each search worked at',
    's7.does5': 'Reads a spectrum of a marked source: one point per band, at the wavelength the file gives for its pixel',
    's7.not': 'Does not yet',
    's7.not1': 'Show WISE and Gaia images beside the frame: only their catalogue positions are overlaid',
    's7.not2': 'Link a slow mover from one season to the next',
    's7.not3': 'Compare brightness at one wavelength: it differs by visit inside a band',
    's7.credit': 'Data: NASA/JPL-Caltech · SPHEREx · IPAC/IRSA. SkyBoT, IMCCE. SIMBAD and VizieR, CDS. Muninn is not affiliated with NASA.',
    read: 'reading', queued: 'queued', failed: 'not read', mb: '{mb} MB',
    at: '{n} / {total}',
  },
  ru: {
    event: 'NASA Space Apps 2026 · Planet X and SPHEREx · команда Yggdrasil',
    openTool: 'Открыть инструмент',
    prev: 'Предыдущий слайд',
    next: 'Следующий слайд',
    langOther: 'EN',
    's1.claim': 'Видно, что изменилось между двумя заходами SPHEREx.',
    's1.say': 'SPHEREx снимает всё небо примерно дважды в год. Звёзды стоят на месте, тела Солнечной системы нет. Muninn приводит заходы к одной сетке и мигает ими.',
    's1.src': 'Эти кадры читаются из архива NASA прямо сейчас, в этом браузере.',
    's1.alt': 'Четыре захода SPHEREx на одно поле, мигание. Одна точка есть только 25 декабря 2025.',
    's1.wait': 'Читаю архив…',
    's1.prevVisit': 'Предыдущий заход',
    's1.nextVisit': 'Следующий заход',
    's1.play': 'Мигать заходами',
    's1.failed': 'Архив не ответил. Сам инструмент открывается одним нажатием.',
    's2.claim': 'Файл в 70 МБ читается по мегабайту-два.',
    's2.say': 'Браузер запрашивает у открытого зеркала AWS диапазоны байтов: заголовок, затем только строки детектора, на которые попадает поле, затем флаги качества для тех же строк. Через наш сервер пиксели не идут.',
    's2.src': 'Размер кадра Level-2: 68,3 МБ; прочитанные байты измерены на предыдущем слайде.',
    's2.head': 'Во что обошлись четыре кадра со слайда 1',
    's2.sum': 'Прочитано {read} МБ из {total} МБ, лежащих в архиве: {pct} %',
    's2.pending': 'Будет измерено, когда слайд 1 дочитает кадры.',
    's2.share': 'от каждого файла читается',
    's2.size1': '64 КБ',
    's2.size2': '1–3 МБ',
    's2.step1': 'заголовок FITS и WCS: где каждый пиксель на небе',
    's2.step2': 'только строки детектора, которые покрывает поле',
    's2.step3': 'те же строки плоскости FLAGS',
    's3.claim': 'Находит движущееся тело и называет его.',
    's3.say': 'Пятнадцать заходов в одну точку за 369 дней. В четырнадцати только фон. 25 декабря 2025 SkyBoT ставит астероид (152) Atala, V 13,8, в 2,3″ от центра на момент самой экспозиции.',
    's3.src': 'tools/verify-mover.mjs 13.4194 3.8459 0.15: самый яркий пиксель против шума кольца вокруг. Апертура 3×3 пикселя в самом инструменте даёт для того же захода около 417σ. SkyBoT, IMCCE.',
    's3.head': 'Сигнал/шум в центре поля, заход за заходом',
    's4.claim': 'Отказывается от ложного открытия.',
    's4.say': '6 июля 2025 в той же точке была вспышка с SNR 206, и каталоги её не объясняли. Это один пиксель детектора, и конвейер SPHEREx уже сказал, что это: попадание космической частицы. Muninn читает эти флаги и маскирует пиксель до любых измерений.',
    's4.src': 'У пикселей самой Atala 25 декабря только OUTLIER, и они размыты как настоящий источник.',
    's4.head': '6 июля 2025, центр поля Atala',
    's4.before': 'SNR без флагов',
    's4.beforeSay': 'один пиксель в 11 раз ярче соседей',
    's4.after': 'SNR с прочитанными флагами',
    's4.afterSay': 'фон, как в остальных заходах',
    's4.note': 'Скачок, пойманный при считывании. Конвейер его пометил; просмотрщик, который не читает FLAGS, собирает космические частицы.',
    's5.claim': 'Пять целей задания открываются одним нажатием.',
    's5.say': 'Каждая открывается в подходящей полосе, а список кадров уже лежит в странице. Нажмите строку, чтобы открыть её в инструменте.',
    's5.src': 'Число заходов: IRSA SIA на момент сборки, 11 ноября 2026.',
    's5.head': 'Пять целей из задания',
    's5.visits': 'заходов: {n} · {days} дн.',
    's6.claim': 'Даже 200 сложенных заходов не дотягивают до Планеты X на 1,5–4,5 величины.',
    's6.say': 'Глубину мы измерили по настоящим пикселям детектора, а не взяли со страницы миссии. Одному заходу не хватает 4,4–7,4 величины, самому глубокому полю у полюса 1,5–4,5. Страница говорит это прямо.',
    's6.src': 'tools/sensitivity.mjs: точечный источник 5σ, апертура 3×3 пикселя. Предсказание: Linder, Mordasini, 2016, A&A 589, A134, V 22,6–24,3 вблизи афелия.',
    's6.head': 'Слабейший точечный источник при 5σ, величины AB',
    's6.alt': 'Шкала от 14 до 26 величин: SPHEREx достаёт до 17,6 за заход и до 20,5 за двести; Планета X предсказана между 22 и 25.',
    's6.here': 'SPHEREx',
    's6.target': 'Планета X, предсказание',
    's6.one': 'один заход',
    's6.ten': '10 сложенных заходов',
    's6.hundred': '100 сложенных заходов',
    's6.deep': '200 заходов, глубокое поле',
    's6.short': 'в лучшем случае не хватает 1,5–4,5',
    's7.claim': 'Что Muninn ищет уже сейчас и где останавливается.',
    's7.say': 'Медленные тела ярче 17,6 AB за заход, стек сезона и названная глубина для каждого просмотренного поля. Нулевой результат на известной глубине тоже ограничение.',
    's7.link': 'muninn.mydevbox.xyz',
    's7.does': 'Умеет сейчас',
    's7.does1': 'Мигание, шторка, разность и стек сезона на одной сетке с севером вверх',
    's7.does2': 'Измеряет отмеченную точку в каждом заходе: положение, величина AB, вердикт',
    's7.does3': 'Называет известные астероиды на момент экспозиции, опознаёт звёзды по каталогам Gaia и WISE и накладывает их положения на кадр',
    's7.does4': 'Сообщает глубину, на которой шёл поиск',
    's7.does5': 'Снимает спектр отмеченного источника: по точке на полосу, на длине волны, которую файл даёт для его пикселя',
    's7.not': 'Пока не умеет',
    's7.not1': 'Показывать снимки WISE и Gaia рядом с кадром: наложены только положения из каталогов',
    's7.not2': 'Связывать медленное тело между сезонами',
    's7.not3': 'Сравнивать блеск на одной длине волны: внутри полосы она от захода к заходу разная',
    's7.credit': 'Данные: NASA/JPL-Caltech · SPHEREx · IPAC/IRSA. SkyBoT, IMCCE. SIMBAD и VizieR, CDS. Muninn не связан с NASA.',
    read: 'читаю', queued: 'в очереди', failed: 'не прочитан', mb: '{mb} МБ',
    at: '{n} / {total}',
  },
};

let lang = 'en';
const t = (key, vars = {}) => (WORDS[lang][key] ?? WORDS.en[key] ?? key)
  .replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const num = (v, digits) => v.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});
// Russian dates come back with a trailing "г."; a figure does not need it.
const day = (iso) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(
  lang === 'ru' ? 'ru-RU' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' },
).replace(/\s*г\.$/, '');

function startLanguage() {
  const asked = new URLSearchParams(location.search).get('lang');
  let saved = null;
  try { saved = localStorage.getItem('muninn.lang'); } catch { /* private window */ }
  const pick = asked ?? saved ?? (navigator.language?.startsWith('ru') ? 'ru' : 'en');
  lang = pick === 'ru' ? 'ru' : 'en';
}

function relabel() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', t(el.dataset.tLabel));
  for (const el of document.querySelectorAll('[data-n]')) el.textContent = num(Number(el.dataset.n), Number(el.dataset.digits));
  $('lang').textContent = t('langOther');
  renderSNR();
  renderReach();
  renderTargets();
  renderReads();
  renderBytes();
  showSlide(current);
}

/* ----------------------------------------------------------------- slides */

const slides = [...document.querySelectorAll('[data-slide]')];
let current = 0;

/** Whether the reader has asked for stillness. */
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
let shown = -1;

/** Run a figure up to its value, so the number is seen being reached. */
function countUp(el, ms = 900) {
  const to = Number(el.dataset.n);
  const digits = Number(el.dataset.digits ?? 0);
  if (STILL || !Number.isFinite(to)) { el.textContent = num(to, digits); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    // Fast at first, settling: 1 - (1 - k)^3.
    el.textContent = num(to * (1 - (1 - k) ** 3), digits);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function showSlide(n) {
  current = Math.max(0, Math.min(slides.length - 1, n));
  const arriving = current !== shown;
  if (arriving) {
    // The slide leaving goes the way the reader is not going.
    $('deck').style.setProperty('--dir', current >= shown ? '1' : '-1');
    slides.forEach((s, i) => s.toggleAttribute('data-was', i === shown));
    shown = current;
  }
  slides.forEach((s, i) => s.toggleAttribute('data-on', i === current));
  if (arriving) for (const el of slides[current].querySelectorAll('[data-n]')) countUp(el);
  // A hidden slide has no width to draw the scale to; it is drawn on arrival.
  if (slides[current].contains($('reach'))) renderReach();
  [...$('scale').children].forEach((li, i) => {
    li.toggleAttribute('data-on', i === current);
    li.toggleAttribute('data-done', i < current);
  });
  $('prev').disabled = current === 0;
  $('next').disabled = current === slides.length - 1;
  $('at').textContent = t('at', {
    n: String(current + 1).padStart(2, '0'), total: String(slides.length).padStart(2, '0'),
  });
  history.replaceState(null, '', `#${current + 1}`);
}

function buildScale() {
  slides.forEach((_, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', String(i + 1));
    b.addEventListener('click', () => showSlide(i));
    li.append(b);
    $('scale').append(li);
  });
}

function wire() {
  const toggle = () => { held = !held; $('blink-play').setAttribute('aria-pressed', String(!held)); };
  $('blink').addEventListener('click', toggle);
  $('blink-play').addEventListener('click', toggle);
  $('blink-prev').addEventListener('click', () => stepVisit(-1));
  $('blink-next').addEventListener('click', () => stepVisit(1));
  $('prev').addEventListener('click', () => showSlide(current - 1));
  $('next').addEventListener('click', () => showSlide(current + 1));
  $('lang').addEventListener('click', () => {
    lang = lang === 'en' ? 'ru' : 'en';
    try { localStorage.setItem('muninn.lang', lang); } catch { /* private window */ }
    relabel();
  });
  window.addEventListener('resize', renderReach);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Space on a focused button or link presses it; it turns the slide only
    // when nothing that Space already operates has the focus.
    const pressable = e.target instanceof Element && e.target.closest('button, a[href]');
    if (e.key === ' ' && pressable) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); showSlide(current + 1); }
    if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); showSlide(current - 1); }
    if (e.key === 'Home') showSlide(0);
    if (e.key === 'End') showSlide(slides.length - 1);
  });
}

/* ------------------------------------------- 1 and 2 · the frames, read live */

const FIELD = { ra: 13.4194, dec: 3.8459, fovDeg: 0.15, band: 'D2' };
const GRID_PX = 264;
/** One exposure from each of four visits around the night Atala crossed. */
const VISITS = ['2025-12-24T11:12:16', '2025-12-25T16:33:36', '2026-01-01T01:44:29', '2026-01-03T05:59:11'];
const BLINK_MS = 1200;
/** One visit gives way to the next over this long, rather than cutting. */
const FADE_MS = 320;
let fade = 0;
/** The visit on which SkyBoT places (152) Atala 2.3″ from the field centre. */
const ATALA_VISIT = '2025-12-25T16:33:36';

/** @type {{iso: string, status: string, bytes?: number, canvas?: HTMLCanvasElement}[]} */
const reads = VISITS.map((iso) => ({ iso, status: 'queued' }));
let live = -1;
/** The speaker can hold one visit still: press its date; press the plate to run again. */
let held = false;

function renderReads() {
  $('reads').replaceChildren(...reads.map((r, i) => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.disabled = r.status !== 'ready';
    row.dataset.status = r.status;
    row.toggleAttribute('data-live', i === live);
    row.addEventListener('click', () => { held = true; show(i); });
    const when = document.createElement('span');
    when.textContent = day(r.iso);
    const what = document.createElement('span');
    what.textContent = r.status === 'ready' ? t('mb', { mb: num(r.bytes / 1048576, 1) })
      : t(r.status === 'reading' ? 'read' : r.status === 'failed' ? 'failed' : 'queued');
    row.append(when, what);
    li.append(row);
    return li;
  }));
}

function renderBytes() {
  const done = reads.filter((r) => r.status === 'ready');
  // Every visit has its row from the start: a list that grows one line at a
  // time on a slow link reads as if the others were never asked for.
  $('bytes').replaceChildren(...reads.map((r) => {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'bytes__when';
    when.textContent = day(r.iso);
    const bar = document.createElement('span');
    bar.className = 'bytes__bar';
    const fill = document.createElement('span');
    if (r.status === 'ready') {
      fill.style.inlineSize = `${(r.bytes / 1048576 / FRAME_FILE_MB) * 100}%`;
      bar.append(fill);
    }
    const mb = document.createElement('span');
    mb.className = 'bytes__mb';
    mb.textContent = r.status === 'ready' ? t('mb', { mb: num(r.bytes / 1048576, 1) })
      : t(r.status === 'reading' ? 'read' : r.status === 'failed' ? 'failed' : 'queued');
    li.dataset.status = r.status;
    li.append(when, bar, mb);
    return li;
  }));
  const settled = reads.every((r) => r.status === 'ready' || r.status === 'failed');
  // The share is per file, so it is true from the first frame read; a visit
  // that is slow to arrive does not hold the figure back.
  $('bytes-pct').parentElement.hidden = !done.length;
  $('filebar-read').parentElement.hidden = !done.length;
  if (!done.length) { $('bytes-sum').textContent = t(settled ? 's1.failed' : 's2.pending'); return; }
  const read = done.reduce((s, r) => s + r.bytes, 0) / 1048576;
  const total = done.length * FRAME_FILE_MB;
  // The headline of the slide is this measurement, at the size of a headline.
  const share = $('bytes-pct');
  share.dataset.n = String((read / total) * 100);
  share.dataset.digits = '1';
  share.textContent = num((read / total) * 100, 1);
  $('filebar-read').style.inlineSize = `${(read / total) * 100}%`;
  $('bytes-sum').textContent = t('s2.sum', {
    read: num(read, 1), total: num(total, 0), pct: num((read / total) * 100, 1),
  });
}

/** Put one visit on the plate. */
function show(i) {
  const from = reads[live]?.canvas;
  const to = reads[i].canvas;
  live = i;
  const ctx = $('blink').getContext('2d');
  cancelAnimationFrame(fade);
  if (!from || from === to || STILL) {
    ctx.globalAlpha = 1;
    ctx.drawImage(to, 0, 0);
  } else {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / FADE_MS);
      ctx.globalAlpha = 1;
      ctx.drawImage(from, 0, 0);
      ctx.globalAlpha = k;
      ctx.drawImage(to, 0, 0);
      ctx.globalAlpha = 1;
      if (k < 1) fade = requestAnimationFrame(step);
    };
    fade = requestAnimationFrame(step);
  }
  $('blink-date').textContent = day(reads[i].iso);
  $('blink-ring').hidden = reads[i].iso !== ATALA_VISIT;
  $('blink-play').setAttribute('aria-pressed', String(!held));
  renderReads();
}

/** Step to the visit before or after the one on the plate, and hold it. */
function stepVisit(dir) {
  const ready = reads.map((r, i) => (r.status === 'ready' ? i : -1)).filter((i) => i >= 0);
  if (!ready.length) return;
  held = true;
  const at = Math.max(0, ready.indexOf(live));
  show(ready[(at + dir + ready.length) % ready.length]);
}

/** The blink: the next visit that has arrived, unless one is being held. */
function drawLive() {
  if (held) return;
  const ready = reads.map((r, i) => (r.status === 'ready' ? i : -1)).filter((i) => i >= 0);
  if (ready.length) show(ready[(ready.indexOf(live) + 1) % ready.length]);
}

/** Paint one visit the way the tool does: its own black and white point, asinh. */
function toCanvas(stamp, lut) {
  const canvas = document.createElement('canvas');
  canvas.width = stamp.width;
  canvas.height = stamp.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(stamp.width, stamp.height);
  const { lo, hi } = limitsFromSorted(sortedFinite(stamp.data));
  paint(img, stamp.data, lut, { lo, hi, stretch: 'asinh', blankAlpha: 255 });
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function readFrames() {
  renderReads();
  const lut = rampFromToken(document.documentElement, '--cmap-deep');
  const grid = new TangentGrid(FIELD.ra, FIELD.dec, FIELD.fovDeg, GRID_PX, GRID_PX);
  let frames;
  try {
    const index = await (await fetch('data/fields/atala.json', { signal: deadline(null, CATALOG_DEADLINE_MS) })).json();
    frames = index.frames.filter((f) => f.band === FIELD.band);
  } catch {
    frames = [];
  }

  let timer = null;
  await Promise.all(reads.map(async (r) => {
    const frame = frames.find((f) => f.iso.startsWith(r.iso));
    try {
      if (!frame) throw new Error('not in the index');
      r.status = 'reading';
      renderReads();
      const stamp = await loadStamp(toS3(frame.url), grid);
      if (!stamp) throw new Error('frame misses the field');
      r.canvas = toCanvas(stamp, lut);
      r.bytes = stamp.meta.bytesRead;
      r.status = 'ready';
      $('blink-wait').hidden = true;
      // Asked for stillness, the plate holds on the visit with the asteroid;
      // the dates beside it still step by hand.
      if (STILL) { held = true; if (r.iso === ATALA_VISIT) show(reads.indexOf(r)); else if (live < 0) show(reads.indexOf(r)); }
      else if (!timer) { drawLive(); timer = setInterval(drawLive, BLINK_MS); }
    } catch {
      r.status = 'failed';
    }
    renderReads();
    renderBytes();
  }));
  // Said through the same key the label is redrawn from, so a change of
  // language does not put "reading" back over a read that has failed.
  if (!reads.some((r) => r.status === 'ready')) {
    $('blink-wait').dataset.t = 's1.failed';
    $('blink-wait').textContent = t('s1.failed');
  }
  renderBytes();
}

/* ---------------------------------------------------------- 3 · the SNR run */

/** tools/verify-mover.mjs 13.4194 3.8459 0.15, as printed in the README. */
const SNR = [
  ['2025-07-06', 1.4], ['2025-07-07', 3.0], ['2025-07-09', 0.8], ['2025-07-19', 2.2],
  ['2025-12-24', 3.3], ['2025-12-25', 534.2], ['2026-01-01', 2.7], ['2026-01-01', 1.3],
  ['2026-01-03', 3.6], ['2026-01-04', 1.2], ['2026-07-03', 3.0], ['2026-07-03', 2.0],
  ['2026-07-04', 2.1], ['2026-07-05', 1.9], ['2026-07-10', 1.2],
];

function renderSNR() {
  const top = Math.max(...SNR.map(([, v]) => v));
  let season = '';
  const rows = [];
  for (const [iso, v] of SNR) {
    // A blank line where half a year passes: the seasons are the shape of the data.
    const now = iso.slice(0, 7) < '2025-10' ? 'a' : iso.slice(0, 7) < '2026-04' ? 'b' : 'c';
    if (season && now !== season) {
      const gap = document.createElement('li');
      gap.className = 'snr__gap';
      gap.setAttribute('aria-hidden', 'true');
      rows.push(gap);
    }
    season = now;
    const li = document.createElement('li');
    li.style.setProperty('--i', String(rows.length));
    if (v > 5) li.toggleAttribute('data-hit', true);
    const when = document.createElement('span');
    when.textContent = day(iso);
    const bar = document.createElement('span');
    bar.className = 'snr__bar';
    // As a share of the tallest; the stylesheet decides which way it grows.
    li.style.setProperty('--v', (v / top).toFixed(4));
    const val = document.createElement('span');
    val.className = 'snr__v';
    val.textContent = num(v, 1);
    // The one that matters is counted up to when its slide arrives.
    if (v > 5) { val.dataset.n = String(v); val.dataset.digits = '1'; }
    li.append(when, bar, val);
    rows.push(li);
  }
  $('snr').replaceChildren(...rows);
}

/* -------------------------------------------------------- 5 · the targets */

let targets = [];

function renderTargets() {
  $('targets').replaceChildren(...targets.map((tg, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', String(i));
    const a = document.createElement('a');
    const hash = new URLSearchParams({
      ra: tg.ra.toFixed(5), dec: tg.dec.toFixed(5), fov: String(tg.fov), band: tg.band, lang, name: tg.name,
    });
    a.href = `./#${hash}`;
    // One real frame of the field, the same picture its card on the sky shows.
    const shot = document.createElement('img');
    shot.className = 'targets__shot';
    shot.src = `img/fields/${tg.key}.png`;
    shot.alt = '';
    shot.width = 280;
    shot.height = 280;
    shot.addEventListener('error', () => shot.remove());
    a.append(shot);
    const name = document.createElement('span');
    name.className = 'targets__name';
    name.textContent = tg.name;
    const why = document.createElement('span');
    why.className = 'targets__why';
    why.textContent = tg.why?.[lang] ?? tg.why?.en ?? '';
    const n = document.createElement('span');
    n.className = 'targets__n';
    n.textContent = `${tg.band} · ${t('s5.visits', { n: tg.visits, days: tg.spanDays })}`;
    a.append(name, why, n);
    li.append(a);
    return li;
  }));
}

async function loadTargets() {
  try {
    const all = await (await fetch('data/targets.json', { signal: deadline(null, CATALOG_DEADLINE_MS) })).json();
    targets = all.targets.filter((tg) => tg.group === 'challenge');
  } catch {
    targets = [];
  }
  renderTargets();
}

/* ---------------------------------------------------------- 6 · the reach */

/** tools/sensitivity.mjs: 5σ point source, AB. The prediction is in V. */
const REACH = [['s6.one', 17.60], ['s6.ten', 18.85], ['s6.hundred', 20.10], ['s6.deep', 20.47]];
const PLANET_NINE = [22, 25];
const AXIS = [14, 26];

function renderReach() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('reach');
  // Drawn at the width it is shown at, so the type stays the size it was set:
  // a fixed drawing scaled down to a phone left the labels four pixels tall.
  const W = Math.max(280, Math.min(1400, Math.round(svg.getBoundingClientRect().width) || 640));
  const H = 150;
  const pad = 8;
  const y = 84;
  const x = (mag) => pad + ((mag - AXIS[0]) / (AXIS[1] - AXIS[0])) * (W - 2 * pad);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const el = (name, attrs, text) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  };
  const deepest = REACH.at(-1)[1];
  const parts = [
    el('line', { class: 'reach__base', x1: x(AXIS[0]), x2: x(AXIS[1]), y1: y + 7, y2: y + 7 }),
    el('rect', { class: 'reach__here', x: x(AXIS[0]), y, width: x(deepest) - x(AXIS[0]), height: 14, opacity: 0.35 }),
    el('rect', { class: 'reach__here', x: x(AXIS[0]), y, width: x(REACH[0][1]) - x(AXIS[0]), height: 14 }),
    el('rect', { class: 'reach__target', x: x(PLANET_NINE[0]), y, width: x(PLANET_NINE[1]) - x(PLANET_NINE[0]), height: 14 }),
    el('line', { class: 'reach__gap', x1: x(deepest), x2: x(PLANET_NINE[0]), y1: y + 7, y2: y + 7 }),
    el('text', { class: 'reach__label reach__label--here', x: x(AXIS[0]), y: y - 14 }, t('s6.here')),
    el('text', { class: 'reach__label reach__label--target', x: x(AXIS[1]), y: y - 14, 'text-anchor': 'end' }, t('s6.target')),
    el('text', { class: 'reach__label', x: (x(deepest) + x(PLANET_NINE[0])) / 2, y: y - 38, 'text-anchor': 'middle' }, t('s6.short')),
  ];
  for (const [, mag] of REACH) {
    parts.push(el('line', { class: 'reach__pin', x1: x(mag), x2: x(mag), y1: y - 5, y2: y + 19 }));
  }
  for (let mag = AXIS[0]; mag <= AXIS[1]; mag += 2) {
    parts.push(el('line', { class: 'reach__tick', x1: x(mag), x2: x(mag), y1: y + 22, y2: y + 28 }));
    parts.push(el('text', { class: 'reach__axis', x: x(mag), y: y + 44, 'text-anchor': 'middle' }, String(mag)));
  }
  svg.replaceChildren(...parts);

  $('reach-rows').replaceChildren(...REACH.flatMap(([key, mag], i) => {
    const dt = document.createElement('dt');
    dt.textContent = t(key);
    const dd = document.createElement('dd');
    dd.textContent = `${num(mag, 2)} AB`;
    if (i === 0) dd.className = 'is-first';
    return [dt, dd];
  }));
}

/* -------------------------------------------------------------------- start */

startLanguage();
buildScale();
wire();
current = Math.max(0, (Number(location.hash.slice(1)) || 1) - 1);
relabel();
loadTargets();
readFrames();
