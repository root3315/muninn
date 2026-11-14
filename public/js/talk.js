/**
 * talk.js — Muninn in ten slides for the jury, then an appendix.
 *
 * The main deck runs problem, evidence, limits, what is next. Its second slide
 * is not a screenshot: it reads four visits of the Atala field from the
 * archive with the same modules the tool uses, and blinks them; an appendix
 * slide reports what that read actually cost, and another runs the tool's own
 * sky. The pictures are crops of the running tool, and every other figure is
 * one the README derives and the tools in tools/ reproduce, or one computed on
 * the slide by the module the tool uses.
 */

import { loadStamp } from './stamp.js';
import { TangentGrid } from './wcs.js';
import { toS3 } from './catalog.js';
import { sortedFinite, limitsFromSorted, paint, rampFromToken } from './render.js';
import { FRAME_FILE_MB } from './release.js';
import { deadline, CATALOG_DEADLINE_MS } from './net.js';
import { COLLECTIONS } from './release.js';
import { Gate, loadStars } from './gate.js';
import { t as tool, setLanguage as setToolLanguage } from './i18n.js';
import { rateAtAU } from './hunt.js';
import { trackCSV } from './export.js';

const $ = (id) => document.getElementById(id);
/** How much larger than a 16-pixel root the deck is set: charts scale their offsets by it. */
const remScale = () => (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;

/* ------------------------------------------------------------------ words */

const WORDS = {
  en: {
    event: 'NASA Space Apps 2026 · Planet X and SPHEREx · team Yggdrasil',
    openTool: 'Open the tool',
    pdf: 'PDF',
    prev: 'Previous slide',
    next: 'Next slide',
    langOther: 'RU',
    'p.claim': 'Find what moves in the SPHEREx sky.',
    'p.say': 'Planet X is a giant planet predicted far beyond Neptune and never seen. Between two pictures of the same sky stars stay put; anything bound to the Sun does not. Muninn turns SPHEREx visits into that comparison, in a browser.',
    'p.src': 'From the NASA Space Apps 2026 challenge “Planet X and SPHEREx”.',
    'p.f1': 'The whole sky',
    'p.f1v': 'every six months',
    'p.f2': '102 bands',
    'p.f2v': '0.75–5 µm, the near infrared',
    'p.f3': 'Since May 2025',
    'p.f3v': 'surveying, release after release',
    'p.for': 'Who it is for',
    'p.for1': 'The public: one link, nothing to install',
    'p.for2': 'Volunteers in the Backyard Worlds style, blinking for movers',
    'p.for3': 'Teachers: real NASA frames in class',
    's1.claim': 'See what changed between two SPHEREx visits.',
    's1.say': 'Muninn puts the visits of one field on one grid and blinks them: stars hold still, a mover jumps.',
    's1.src': 'These frames are being read from the NASA archive right now, in this browser.',
    's1.alt': 'Four SPHEREx visits of one field, blinking. One dot is present on 25 Dec 2025 only.',
    's1.wait': 'Reading the archive…',
    's1.prevVisit': 'Previous visit',
    's1.nextVisit': 'Next visit',
    's1.play': 'Blink the visits',
    's1.failed': 'The archive did not answer. The tool itself is one click away.',
    's2.claim': 'A 65 MB file, read a megabyte or two at a time.',
    's2.say': 'The browser asks the public AWS mirror for byte ranges: the header, the detector rows the field covers, and their flags. No pixels pass through our server.',
    's2.src': '65.4 MB per Level-2 frame; bytes measured on slide 2, as it reads.',
    's2.head': 'What the four frames on slide 2 cost',
    's2.sum': 'Read {read} MB of {total} MB held at the archive: {pct} %',
    's2.pending': 'Measured once slide 2 has finished reading.',
    's2.share': 'of each file is read',
    's2.size1': '64 KB',
    's2.size2': '1–3 MB',
    's2.step1': 'FITS header and the WCS: where each pixel is on the sky',
    's2.step2': 'only the detector rows the field covers',
    's2.step3': 'the same rows of the FLAGS plane',
    's3.claim': 'It finds a mover, and names it.',
    's3.say': 'Fifteen D2 visits of one spot. Fourteen are background, SNR 0.5 to 2.4. On 25 Dec 2025 it is 374, and SkyBoT places asteroid (152) Atala, V 13.8, 2.3″ from the centre at that exposure’s own time.',
    's3.src': '15 D2 visits over 369 days; SkyBoT, IMCCE.',
    's3.head': 'Signal-to-noise at the field centre, visit by visit',
    's4.claim': 'It refuses a false discovery.',
    's4.say': 'On 6 Jul 2025 the same spot flashed at SNR 140, and no catalogue explained it. It was one detector pixel the SPHEREx pipeline had already flagged as a cosmic-ray hit. Muninn reads those flags and masks it before measuring.',
    's4.src': 'Atala’s own pixels on 25 Dec carry only OUTLIER, and spread like a real source.',
    's4.head': '6 Jul 2025, the centre of the Atala field',
    's4.before': 'SNR without the flags',
    's4.beforeSay': 'one pixel at 11× its neighbours',
    's4.after': 'SNR with the flags read',
    's4.afterSay': 'background, like the other visits',
    's4.flagsNote': 'The pipeline’s own label for that pixel: TRANSIENT — its signal jumped while the detector was read, as a cosmic ray does; SUR_ERROR — the readout could not be fitted; NONFUNC — not usable.',
    's5.claim': 'The challenge’s five test targets, one press each.',
    's5.say': 'Each opens in the band that suits it. The crosshair marks the target on a real SPHEREx frame.',
    's5.src': 'Visit counts from NASA IRSA, SPHEREx DR1 and QR3, 13 Nov 2026.',
    's5.head': 'Five targets named by the challenge',
    's5.visits': '{n} visits · {days} d',
    's6.claim': 'Even 200 visits added would leave SPHEREx 2.1 to 3.8 magnitudes short of Planet X.',
    's6.say': 'Measured from delivered detector pixels: 17.61 AB for one visit, 5.0 to 6.7 magnitudes short. Two hundred visits, extrapolated as √N, reach 20.48: still short, and 1.2 short even of the bright 21.7 case.',
    's6.src': 'Prediction: Linder & Mordasini 2016, A&A 589, A134, V 22.6–24.3 near aphelion.',
    's6.assume': 'Assumed: the V-band prediction against SPHEREx AB depth at 1.1–1.6 µm, a fair best case for a sunlike reflector.',
    's6.head': 'Faintest point source at 5σ, AB magnitudes',
    's6.alt': 'A scale from 14 to 26 magnitudes: SPHEREx reaches 17.61 in one visit and 20.48 for two hundred, extrapolated; Planet X is predicted between 22.6 and 24.3, and 21.7 in the bright case.',
    's6.here': 'SPHEREx',
    's6.target': 'Planet X, predicted',
    's6.bright': '21.7, bright case',
    's6.one': 'one visit, measured',
    's6.deep': '200 visits, extrapolated as √N',
    's6.short': 'short by 2.1–3.8 mag',
    'src.claim': 'Built on the challenge’s resources, each one named.',
    'src.src': 'Every service is asked live; the page stores no pixels. Muninn is not affiliated with NASA.',
    'src.nasa': 'Challenge resources · NASA',
    'src.csa': 'Challenge resources · CSA',
    'src.also': 'Also used',
    'end.claim': 'Open it and blink a field yourself.',
    'end.live': 'Live',
    'end.repo': 'Code',
    'end.team': 'Team Yggdrasil · Uzbekistan',
    'end.owner': '(team owner)',
    'end.nextK': 'Next:',
    'end.next': 'the full 102-channel spectrum, visits added along a trial orbit for fainter bodies, and every season linked, not only the nearest.',
    's7.does': 'Does today',
    's7.does1': 'Blink, wipe, difference and season stack on one north-up grid',
    's7.does2': 'Measures a marked spot in every visit, and links it across seasons',
    's7.does3': 'Names known asteroids; lays Gaia and WISE over the frame',
    's7.does4': 'States the depth every search worked at',
    's7.does5': 'Compares brightness at one wavelength across visits',
    's7.not': 'Does not',
    's7.not1': 'Reach Planet X: 2.1–3.8 mag short even with 200 visits',
    's7.not2': 'Show a Gaia image: it is a catalogue, so the wipe draws a model from it',
    'app.claim': 'Appendix',
    'app.say': 'How each part works, for questions.',
    'sky.claim': 'Enter through the real sky.',
    'sky.say': 'The first screen is the sky: 15 568 catalogued stars, turning. Press a star and a reticle closes on it; a card brings a real SPHEREx frame of that place.',
    'sky.beat1': 'The sky turns',
    'sky.beat2': 'A press: the reticle closes',
    'sky.beat3': 'The card: a real SPHEREx frame',
    'sky.beat4': 'The dive into the field',
    'sky.src': 'Drawn by the tool’s own sky code. Bright Star Catalogue and Hipparcos.',
    'sky.open': 'Open the field',
    'sky.visits': '{n} visits, {d} d',
    'modes.claim': 'Five ways to compare one patch of sky.',
    'modes.say': 'Every visit is resampled onto one north-up grid. A is 25 Dec 2025 with (152) Atala ringed; B is 1 Jan 2026, when it has gone.',
    'modes.src': 'The Atala field, D2, as the tool draws it.',
    'modes.season': 'December season, D2',
    'bands.claim': 'Six bands, any field size, one link.',
    'bands.say': 'Six bands, D1 to D6, and the page takes the hue of the band in the beam. The field runs 6′ to 36′; the address carries place, size, band and language.',
    'bands.src': 'Band edges read from the Atala field’s frame index.',
    'bands.head': 'Wavelength, µm',
    'bands.width': 'Field size, short side',
    'bands.link': 'The address',
    'mark.claim': 'Click a spot: it is measured in every visit.',
    'mark.say': 'Position, AB magnitude in a 3×3-pixel aperture, a verdict and what catalogues know, saved as CSV. One more press reads a spectrum: one point per band.',
    'mark.src': 'A star in the Atala field, marked in the tool.',
    'mark.csv': 'CSV columns',
    'ov.claim': 'Gaia and WISE, laid over the frame.',
    'ov.say': 'Gaia DR3 positions are moved from 2016 to the date of the visit; AllWISE positions stay where WISE saw them in 2010.',
    'ov.src': 'Barnard’s Star, D2, 12′ × 9′; its core masked by the pipeline’s flags.',
    'ov.gaia': 'Gaia DR3 (ESA): moved to the date of this visit',
    'ov.wise': 'AllWISE (NASA WISE): where they were in 2010',
    'ov.head': 'Asked for a marked source',
    'wise.claim': 'Fifteen years on, Barnard’s Star is not where WISE saw it.',
    'wise.say': 'B of the wipe can be the AllWISE picture at 3.4 or 4.6 µm, on the same grid as a SPHEREx visit. The idea is WiseView’s, the blink tool the challenge names.',
    'wise.src': 'AllWISE Atlas through NASA IRSA. Markers: the star’s peak on each picture.',
    'wise.tagA': 'SPHEREx 2025',
    'wise.tagB': 'WISE 2010',
    'wise.a': 'SPHEREx, D2, 21 Aug 2025',
    'wise.b': 'AllWISE W1, 3.4 µm, 2010–2011',
    'wise.f1': 'WISE peak from the star’s 2016 place',
    'wise.f1v': '56″',
    'wise.f2': 'from Gaia carried back to 2010',
    'wise.f2v': '2.5″',
    'wise.f3': 'Barnard’s Star’s proper motion',
    'wise.f3v': '10.3″ a year',
    'hunt.claim': 'At 400–800 AU the motion test within a season is blind; the season link checks the parallax arc.',
    'hunt.say': 'Inside one season Hunter X needs three pixels in eleven days, 0.07″ an hour. SPHEREx sees Planet X near quadrature, at about 0.006–0.02″ an hour: it would read as fixed.',
    'hunt.src': 'Curve computed on this slide: the fastest a body at that distance moves, at opposition.',
    'hunt.head': 'Apparent rate against distance from the Sun',
    'hunt.alt': 'Apparent motion falls from arcseconds an hour in the asteroid belt to a third of an arcsecond an hour at 400 AU.',
    'hunt.axisX': 'distance, AU',
    'hunt.axisY': '″ per hour',
    'hunt.px': 'Planet X',
    'hunt.perHour': '″/h',
    'hunt.floor': 'three pixels in one season',
    'hunt.quad': 'near quadrature',
    'link.head': 'The season link, one season to the next',
    'link.s1': 'A body is put on the mark’s line of sight at each distance from 30 to 2000 AU.',
    'link.s2': 'The Earth’s move across the Sun throws it along an arc in the next season: 13.6′ at 500 AU.',
    'link.s3': 'A source on the arc counts only if that spot was empty in every visit of the first season.',
    'link.test': 'On a synthetic two-season sky, a source placed at 300 AU links at 300 AU, range 269–321.',
    'arc.claim': 'Which other telescopes looked at the same field.',
    'arc.say': 'For every field the page asks the Canadian Astronomy Data Centre how many science observations each archive holds, and shows NEOSSat’s newest raw frame of it.',
    'arc.src': 'CADC, within 0.1° of Barnard’s Star; log scale.',
    'arc.head': 'In other archives: Barnard’s Star',
    'rel.claim': 'A new SPHEREx release is one line.',
    'rel.say': 'IRSA publishes each release as its own collection, and the page names them in one list. On 13 Nov 2026 it moved from Quick Release 2 to DR1 and QR3.',
    'rel.src': 'The page stores no pixels, so new data need no rebuild.',
    'rel.when': '13 Nov 2026',
    'rel.step1': 'the list of collections changes',
    'rel.step2': 'the ten ready fields get new frame indexes',
    'rel.step3': 'checked offline, then deployed',
    read: 'reading', queued: 'queued', failed: 'not read', mb: '{mb} MB',
    at: '{n} / {total}',
    atApp: 'Appendix {n} / {total}',
  },
  ru: {
    event: 'NASA Space Apps 2026 · Planet X and SPHEREx · команда Yggdrasil',
    openTool: 'Открыть инструмент',
    pdf: 'PDF',
    prev: 'Предыдущий слайд',
    next: 'Следующий слайд',
    langOther: 'EN',
    'p.claim': 'Найти то, что движется на небе SPHEREx.',
    'p.say': 'Планета X — планета-гигант, предсказанная далеко за Нептуном и никем не виденная. Между двумя снимками одного неба звёзды стоят на месте, а тела, связанные с Солнцем, сдвигаются. Muninn превращает заходы SPHEREx в такое сравнение прямо в браузере.',
    'p.src': 'Из задания NASA Space Apps 2026 «Planet X and SPHEREx».',
    'p.f1': 'Всё небо',
    'p.f1v': 'каждые полгода',
    'p.f2': '102 полосы',
    'p.f2v': '0,75–5 мкм, ближний инфракрасный',
    'p.f3': 'С мая 2025',
    'p.f3v': 'съёмка идёт, выпуск за выпуском',
    'p.for': 'Для кого',
    'p.for1': 'Публика: одна ссылка, ничего не ставить',
    'p.for2': 'Волонтёры в духе Backyard Worlds, ищущие движущееся миганием',
    'p.for3': 'Учителя: настоящие кадры NASA на уроке',
    's1.claim': 'Видно, что изменилось между двумя заходами SPHEREx.',
    's1.say': 'Muninn приводит заходы одного поля к одной сетке и мигает ими: звёзды стоят, движущееся прыгает.',
    's1.src': 'Эти кадры читаются из архива NASA прямо сейчас, в этом браузере.',
    's1.alt': 'Четыре захода SPHEREx на одно поле, мигание. Одна точка есть только 25 декабря 2025.',
    's1.wait': 'Читаю архив…',
    's1.prevVisit': 'Предыдущий заход',
    's1.nextVisit': 'Следующий заход',
    's1.play': 'Мигать заходами',
    's1.failed': 'Архив не ответил. Сам инструмент открывается одним нажатием.',
    's2.claim': 'Файл в 65 МБ читается по мегабайту-два.',
    's2.say': 'Браузер запрашивает у открытого зеркала AWS диапазоны байтов: заголовок, строки детектора, которые покрывает поле, и их флаги. Через наш сервер пиксели не идут.',
    's2.src': '65,4 МБ на кадр Level-2; байты измерены на слайде 2, пока он читает.',
    's2.head': 'Во что обошлись четыре кадра со слайда 2',
    's2.sum': 'Прочитано {read} МБ из {total} МБ, лежащих в архиве: {pct} %',
    's2.pending': 'Будет измерено, когда слайд 2 дочитает кадры.',
    's2.share': 'от каждого файла читается',
    's2.size1': '64 КБ',
    's2.size2': '1–3 МБ',
    's2.step1': 'заголовок FITS и WCS: где каждый пиксель на небе',
    's2.step2': 'только строки детектора, которые покрывает поле',
    's2.step3': 'те же строки плоскости FLAGS',
    's3.claim': 'Находит движущееся тело и называет его.',
    's3.say': 'Пятнадцать заходов D2 в одну точку. В четырнадцати только фон, SNR от 0,5 до 2,4. 25 декабря 2025 — 374, и SkyBoT ставит туда астероид (152) Atala, V 13,8, в 2,3″ от центра на момент самой экспозиции.',
    's3.src': '15 заходов D2 за 369 дней; SkyBoT, IMCCE.',
    's3.head': 'Сигнал/шум в центре поля, заход за заходом',
    's4.claim': 'Отказывается от ложного открытия.',
    's4.say': '6 июля 2025 в той же точке была вспышка с SNR 140, и каталоги её не объясняли. Это один пиксель детектора, который конвейер SPHEREx уже пометил как попадание космической частицы. Muninn читает эти флаги и маскирует его до измерений.',
    's4.src': 'У пикселей самой Atala 25 декабря только OUTLIER, и они размыты как настоящий источник.',
    's4.head': '6 июля 2025, центр поля Atala',
    's4.before': 'SNR без флагов',
    's4.beforeSay': 'один пиксель в 11 раз ярче соседей',
    's4.after': 'SNR с прочитанными флагами',
    's4.afterSay': 'фон, как в остальных заходах',
    's4.flagsNote': 'Собственная пометка конвейера SPHEREx для этого пикселя: TRANSIENT — сигнал скакнул во время считывания, как от космической частицы; SUR_ERROR — считывание не удалось подогнать; NONFUNC — пиксель непригоден.',
    's5.claim': 'Пять целей задания — по одному нажатию.',
    's5.say': 'Каждая открывается в подходящей полосе. Перекрестие отмечает цель на настоящем кадре SPHEREx.',
    's5.src': 'Число заходов: NASA IRSA, SPHEREx DR1 и QR3, 13 ноября 2026.',
    's5.head': 'Пять целей из задания',
    's5.visits': '{n} зах. · {days} дн.',
    's6.claim': 'Даже 200 сложенных заходов не дотянули бы до Планеты X 2,1–3,8 величины.',
    's6.say': 'Измерено по настоящим пикселям детектора: 17,61 AB за один заход, не хватает 5,0–6,7 величины. Двести заходов, пересчитанные как √N, дают 20,48: всё ещё мало, и даже до яркого случая 21,7 не хватает 1,2.',
    's6.src': 'Предсказание: Linder, Mordasini, 2016, A&A 589, A134, V 22,6–24,3 вблизи афелия.',
    's6.assume': 'Допущение: предсказание в полосе V против глубины SPHEREx в AB на 1,1–1,6 мкм — честный лучший случай для отражателя солнечного типа.',
    's6.head': 'Слабейший точечный источник при 5σ, величины AB',
    's6.alt': 'Шкала от 14 до 26 величин: SPHEREx достаёт до 17,61 за заход и до 20,48 за двести по пересчёту; Планета X предсказана между 22,6 и 24,3, в ярком случае 21,7.',
    's6.here': 'SPHEREx',
    's6.target': 'Планета X, предсказание',
    's6.bright': '21,7, яркий случай',
    's6.one': 'один заход, измерено',
    's6.deep': '200 заходов, пересчёт как √N',
    's6.short': 'не хватает 2,1–3,8',
    'src.claim': 'Построено на ресурсах задания, каждый назван.',
    'src.src': 'Каждый сервис спрашивается вживую; страница не хранит пикселей. Muninn не связан с NASA.',
    'src.nasa': 'Ресурсы задания · NASA',
    'src.csa': 'Ресурсы задания · CSA',
    'src.also': 'Также',
    'end.claim': 'Откройте и сравните заходы сами.',
    'end.live': 'Сайт',
    'end.repo': 'Код',
    'end.team': 'Команда Yggdrasil · Узбекистан',
    'end.owner': '(руководитель команды)',
    'end.nextK': 'Дальше:',
    'end.next': 'полный спектр в 102 канала, сложение заходов вдоль пробной орбиты для более слабых тел и связка всех сезонов, а не только ближайшего.',
    's7.does': 'Умеет сейчас',
    's7.does1': 'Мигание, шторка, разность и стек сезона на одной сетке с севером вверх',
    's7.does2': 'Измеряет отмеченную точку в каждом заходе и связывает её между сезонами',
    's7.does3': 'Называет известные астероиды; кладёт Gaia и WISE поверх кадра',
    's7.does4': 'Называет глубину, на которой шёл каждый поиск',
    's7.does5': 'Сравнивает блеск на одной длине волны между заходами',
    's7.not': 'Не умеет',
    's7.not1': 'Достать Планету X: даже с 200 заходами не хватает 2,1–3,8 величины',
    's7.not2': 'Показывать снимок Gaia: это каталог, и шторка рисует по нему модель',
    'app.claim': 'Приложение',
    'app.say': 'Как устроена каждая часть — для вопросов.',
    'sky.claim': 'Вход — через настоящее небо.',
    'sky.say': 'Первый экран — само небо: 15 568 звёзд из каталогов, и оно поворачивается. Нажмите звезду — на ней сходится прицел, а карточка показывает настоящий кадр SPHEREx этого места.',
    'sky.beat1': 'Небо поворачивается',
    'sky.beat2': 'Нажатие: сходится прицел',
    'sky.beat3': 'Карточка: настоящий кадр SPHEREx',
    'sky.beat4': 'Нырок в поле',
    'sky.src': 'Рисует тот же код неба, что и в инструменте. Bright Star Catalogue и Hipparcos.',
    'sky.open': 'Открыть поле',
    'sky.visits': 'заходов: {n}, {d} дн.',
    'modes.claim': 'Пять способов сравнить один участок неба.',
    'modes.say': 'Каждый заход пересчитан на одну сетку с севером вверх. A — 25 декабря 2025, (152) Atala в кольце; B — 1 января 2026, когда её уже нет.',
    'modes.src': 'Поле Atala, D2, как его рисует инструмент.',
    'modes.season': 'декабрьский сезон, D2',
    'bands.claim': 'Шесть полос, любой размер поля, одна ссылка.',
    'bands.say': 'Шесть полос, от D1 до D6, и страница принимает цвет той, что в луче. Поле — от 6′ до 36′; адрес хранит место, размер, полосу и язык.',
    'bands.src': 'Границы полос — из списка кадров поля Atala.',
    'bands.head': 'Длина волны, мкм',
    'bands.width': 'Размер поля по короткой стороне',
    'bands.link': 'Адрес',
    'mark.claim': 'Щелчок по точке — и она измерена в каждом заходе.',
    'mark.say': 'Положение, величина AB в апертуре 3×3 пикселя, вердикт и то, что знают каталоги, — всё в CSV. Ещё одно нажатие снимает спектр: по точке на полосу.',
    'mark.src': 'Звезда в поле Atala, отмеченная в инструменте.',
    'mark.csv': 'Столбцы CSV',
    'ov.claim': 'Gaia и WISE поверх кадра.',
    'ov.say': 'Положения Gaia DR3 перенесены с 2016 года на дату захода, положения AllWISE стоят там, где их видел WISE в 2010-м.',
    'ov.src': 'Звезда Барнарда, D2, 12′ × 9′; ядро замаскировано флагами конвейера.',
    'ov.gaia': 'Gaia DR3 (ESA): на дату захода',
    'ov.wise': 'AllWISE (NASA WISE): где были в 2010 году',
    'ov.head': 'Кого спрашивают об отмеченном источнике',
    'wise.claim': 'Через пятнадцать лет звезда Барнарда не там, где её видел WISE.',
    'wise.say': 'Вместо второго захода под шторку можно поставить снимок AllWISE на 3,4 или 4,6 мкм, на той же сетке, что и заход SPHEREx. Идея взята у WiseView — мигалки, которую называет задание.',
    'wise.src': 'Атлас AllWISE через NASA IRSA. Метки — пик звезды на каждом снимке.',
    'wise.tagA': 'SPHEREx 2025',
    'wise.tagB': 'WISE 2010',
    'wise.a': 'SPHEREx, D2, 21 августа 2025',
    'wise.b': 'AllWISE W1, 3,4 мкм, 2010–2011',
    'wise.f1': 'Пик WISE от места звезды в 2016 году',
    'wise.f1v': '56″',
    'wise.f2': 'от Gaia, перенесённой назад на 2010 год',
    'wise.f2v': '2,5″',
    'wise.f3': 'собственное движение звезды Барнарда',
    'wise.f3v': '10,3″ в год',
    'hunt.claim': 'На 400–800 а.е. проверка движения внутри сезона слепа; связь сезонов проверяет дугу параллакса.',
    'hunt.say': 'Внутри сезона Hunter X нужны три пикселя за одиннадцать дней, 0,07″ в час. SPHEREx видит Планету X у квадратуры, около 0,006–0,02″ в час: она выглядела бы неподвижной.',
    'hunt.src': 'Кривая посчитана на этом слайде: предельная скорость тела на таком расстоянии, у противостояния.',
    'hunt.head': 'Видимая скорость против расстояния от Солнца',
    'hunt.alt': 'Видимое движение падает с угловых секунд в час в поясе астероидов до трети секунды в час на 400 а.е.',
    'hunt.axisX': 'расстояние, а.е.',
    'hunt.axisY': '″ в час',
    'hunt.px': 'Планета X',
    'hunt.perHour': '″/ч',
    'hunt.floor': 'три пикселя за один сезон',
    'hunt.quad': 'у квадратуры',
    'link.head': 'Связь сезонов: от одного к следующему',
    'link.s1': 'Тело ставится на луч зрения метки на каждом расстоянии от 30 до 2000 а.е.',
    'link.s2': 'Переход Земли на другую сторону Солнца уводит его по дуге в следующем сезоне: 13,6′ на 500 а.е.',
    'link.s3': 'Источник на дуге засчитывается, только если это место было пустым во всех заходах первого сезона.',
    'link.test': 'На синтетическом небе из двух сезонов источник на 300 а.е. связывается на 300 а.е., диапазон 269–321.',
    'arc.claim': 'Какие ещё телескопы смотрели на это поле.',
    'arc.say': 'Для каждого поля страница спрашивает Канадский центр астрономических данных, сколько научных наблюдений есть в каждом архиве, и показывает самый новый сырой кадр NEOSSat.',
    'arc.src': 'CADC, в пределах 0,1° от звезды Барнарда; шкала логарифмическая.',
    'arc.head': 'В других архивах: звезда Барнарда',
    'rel.claim': 'Новый выпуск SPHEREx — одна строка.',
    'rel.say': 'IRSA публикует каждый выпуск отдельной коллекцией, а страница перечисляет их в одном списке. 13 ноября 2026 он перешёл с Quick Release 2 на DR1 и QR3.',
    'rel.src': 'Страница не хранит пикселей, поэтому для новых данных пересборка не нужна.',
    'rel.when': '13 ноября 2026',
    'rel.step1': 'меняется список коллекций',
    'rel.step2': 'десять готовых полей получают новые списки кадров',
    'rel.step3': 'проверка без сети, затем выкладка',
    read: 'читаю', queued: 'в очереди', failed: 'не прочитан', mb: '{mb} МБ',
    at: '{n} / {total}',
    atApp: 'Приложение {n} / {total}',
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
  setToolLanguage(lang);
  relabelImages();
  renderModes();
  renderBands();
  renderCsv();
  renderAsks();
  renderRate();
  renderArchives();
  renderSNR();
  renderReach();
  renderTargets();
  renderReads();
  renderBytes();
  renderSources();
  renderContents();
  $('pdf').href = lang === 'ru' ? 'talk.ru.pdf' : 'talk.pdf';
  showSlide(current);
}

/* ------------------------------------------------------------ 9 · sources */

/**
 * The challenge's Resources tab first, every item by name, NASA then CSA;
 * then the other services the page or its relay asks.
 */
const SOURCES = {
  nasa: [
    { name: 'NASA IRSA · SPHEREx', en: 'Every pixel, DR1 and QR3; the frame index; the FLAGS plane', ru: 'Каждый пиксель, DR1 и QR3; список кадров; плоскость FLAGS' },
    { name: 'SPHEREx Tutorial Notebooks', en: 'The reference for the DR1 file layout', ru: 'Образец устройства файлов DR1' },
    { name: 'WiseView', en: 'The model for the WISE wipe', ru: 'Образец для шторки с WISE' },
    { name: 'Gaia DR3', host: 'MAST, STScI', en: 'What a marked star is, in a second or two', ru: 'Что за отмеченная звезда, за секунду-две' },
  ],
  csa: [
    { name: 'CADC', en: 'Which other telescopes looked at a field', ru: 'Какие ещё телескопы смотрели на поле' },
    { name: 'NEOSSat', en: 'Muninn shows NEOSSat’s newest raw frame of a field, from CADC', ru: 'Muninn показывает самый новый сырой кадр поля с NEOSSat, из CADC' },
  ],
  also: [
    { name: 'ESA Gaia / DPAC', en: 'Star positions over the frame, moved to the visit date', ru: 'Положения звёзд поверх кадра, на дату захода' },
    { name: 'NASA WISE / NEOWISE', en: 'AllWISE pictures; CatWISE2020 motions', ru: 'Снимки AllWISE; движения CatWISE2020' },
    { name: '2MASS', en: 'J, H and K of a marked source', ru: 'J, H и K отмеченного источника' },
    { name: 'IMCCE SkyBoT', en: 'Known asteroids at each exposure', ru: 'Известные астероиды на момент экспозиции' },
    { name: 'JPL SSD', en: 'Small-Body Identification, beside SkyBoT', ru: 'Small-Body Identification, рядом со SkyBoT' },
    { name: 'CDS', en: 'SIMBAD, Sesame and VizieR', ru: 'SIMBAD, Sesame и VizieR' },
  ],
};

function renderSources() {
  let at = 0;
  for (const [group, rows] of Object.entries(SOURCES)) {
    $(`sources-${group}`).replaceChildren(...rows.map((row) => {
      const item = document.createElement('div');
      item.className = 'sources__row';
      item.style.setProperty('--l', String(at++));
      const dt = document.createElement('dt');
      dt.append(row.name);
      if (row.host) {
        const host = document.createElement('span');
        host.textContent = row.host;
        dt.append(host);
      }
      const dd = document.createElement('dd');
      dd.textContent = row[lang] ?? row.en;
      item.append(dt, dd);
      return item;
    }));
  }
}

/* ----------------------------------------------------------------- slides */

const slides = [...document.querySelectorAll('[data-slide]')];
/** The jury's deck ends where the appendix begins, at its divider. */
const MAIN = slides.findIndex((s) => s.dataset.part === 'appendix');
let current = 0;

/** The appendix, listed on its divider: each entry turns to its slide. */
function renderContents() {
  $('contents').replaceChildren(...slides.slice(MAIN + 1).map((slide, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', String(i));
    const b = document.createElement('button');
    b.type = 'button';
    const n = document.createElement('span');
    n.className = 'num';
    n.textContent = String(i + 1);
    b.append(n, t(slide.querySelector('.slide__claim').dataset.t));
    b.addEventListener('click', () => showSlide(MAIN + 1 + i));
    li.append(b);
    return li;
  }));
}

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
  // A hidden slide has no width to draw a chart to; it is drawn on arrival.
  if (slides[current].contains($('reach'))) renderReach();
  if (slides[current].contains($('rate'))) renderRate();
  if (arriving) switchRun(slides[current]);
  [...$('scale').children].forEach((li, i) => {
    li.toggleAttribute('data-on', i === current);
    li.toggleAttribute('data-done', i < current);
  });
  $('prev').disabled = current === 0;
  $('next').disabled = current === slides.length - 1;
  $('at').textContent = current === MAIN ? t('app.claim') : current < MAIN
    ? t('at', { n: String(current + 1).padStart(2, '0'), total: String(MAIN).padStart(2, '0') })
    : t('atApp', { n: String(current - MAIN), total: String(slides.length - MAIN - 1) });
  history.replaceState(null, '', `#${current + 1}`);
}

function buildScale() {
  slides.forEach((_, i) => {
    const li = document.createElement('li');
    li.toggleAttribute('data-appendix', i >= MAIN);
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
  // An address typed or pasted with another #N turns to that slide.
  window.addEventListener('hashchange', () => {
    const n = Number(location.hash.slice(1));
    if (Number.isInteger(n) && n >= 1 && n - 1 !== current) showSlide(n - 1);
  });
  window.addEventListener('resize', () => { renderReach(); renderRate(); if (running === RUNS.sky) dome?.gate.resize(); });
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

/* ------------------------------------------ 2 and 15 · the frames, read live */

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
  ['2025-07-06', 1.2], ['2025-07-07', 2.0], ['2025-07-09', 0.5], ['2025-07-19', 1.6],
  ['2025-12-24', 2.2], ['2025-12-25', 374.3], ['2026-01-01', 1.5], ['2026-01-01', 0.9],
  ['2026-01-03', 2.4], ['2026-01-04', 0.8], ['2026-07-03', 1.9], ['2026-07-03', 1.4],
  ['2026-07-04', 1.3], ['2026-07-05', 1.2], ['2026-07-10', 0.9],
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

/* -------------------------------------------------------- 6 · the targets */

/**
 * The deck's own line for each target, short enough to read from the back of
 * a room. Every thumbnail is centred on the target's position, so the
 * crosshair is drawn at its middle. WISE 0855 is too faint for one frame, and
 * its card says so instead of pointing at noise (README, the targets table).
 */
const TARGET_LINES = {
  barnard: { en: 'Fastest star in the sky, 10.3″ a year', ru: 'Самая быстрая звезда неба, 10,3″ в год' },
  epsindib: { en: 'A pair of brown dwarfs beside ε Indi A', ru: 'Пара коричневых карликов рядом с ε Indi A' },
  wise0855: {
    en: 'Coldest known brown dwarf', ru: 'Самый холодный известный коричневый карлик',
    unseen: {
      en: 'Too faint for one frame: about 17.2 AB against a 16.7 AB limit in D6. The crosshair is the challenge’s position.',
      ru: 'Слишком слаб для одного кадра: около 17,2 AB при пределе 16,7 AB в D6. Перекрестие — позиция из задания.',
    },
  },
  rwaur: { en: 'A young variable star', ru: 'Молодая переменная звезда' },
  rdra: { en: 'A Mira variable near the north ecliptic pole', ru: 'Мирида у северного полюса эклиптики' },
};

/** Four ticks around the middle, leaving the target itself clear. */
function crosshair() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'targets__cross');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M50 22v16M50 62v16M22 50h16M62 50h16');
  svg.append(path);
  return svg;
}

let targets = [];
let targetsLoaded;
const targetsReady = new Promise((resolve) => { targetsLoaded = resolve; });

function renderTargets() {
  $('targets').replaceChildren(...targets.map((tg, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', String(i));
    const a = document.createElement('a');
    const hash = new URLSearchParams({
      ra: tg.ra.toFixed(5), dec: tg.dec.toFixed(5), fov: String(tg.fov), band: tg.band, lang, name: tg.name,
    });
    a.href = `./#${hash}`;
    const line = TARGET_LINES[tg.key];
    // One real frame of the field, the same picture its card on the sky shows.
    const frame = document.createElement('span');
    frame.className = 'targets__frame';
    frame.toggleAttribute('data-unseen', Boolean(line?.unseen));
    const shot = document.createElement('img');
    shot.className = 'targets__shot';
    shot.src = `img/fields/${tg.key}.png`;
    shot.alt = '';
    shot.width = 280;
    shot.height = 280;
    shot.addEventListener('error', () => frame.remove());
    frame.append(shot, crosshair());
    a.append(frame);
    const name = document.createElement('span');
    name.className = 'targets__name';
    name.textContent = tg.name;
    const why = document.createElement('span');
    why.className = 'targets__why';
    why.textContent = line?.[lang] ?? tg.why?.[lang] ?? tg.why?.en ?? '';
    const n = document.createElement('span');
    n.className = 'targets__n';
    n.textContent = `${tg.band} · ${t('s5.visits', { n: tg.visits, days: tg.spanDays })}`;
    a.append(name, why, n);
    if (line?.unseen) {
      const unseen = document.createElement('span');
      unseen.className = 'targets__unseen';
      unseen.textContent = line.unseen[lang] ?? line.unseen.en;
      a.append(unseen);
    }
    li.append(a);
    return li;
  }));
}

async function loadTargets() {
  try {
    const all = await (await fetch('data/targets.json', { signal: deadline(null, CATALOG_DEADLINE_MS) })).json();
    allTargets = all.targets;
    targets = all.targets.filter((tg) => tg.group === 'challenge');
  } catch {
    targets = [];
  }
  targetsLoaded();
  renderTargets();
}

/* ---------------------------------------------------------- 8 · the reach */

/**
 * tools/sensitivity.mjs: 5σ point source in a 3×3-pixel aperture, AB, the
 * Atala field in D2; the second row is the first extrapolated as √N. The
 * prediction is in V: Linder & Mordasini 2016 near aphelion, and their bright
 * case.
 */
const REACH = [['s6.one', 17.61], ['s6.deep', 20.48]];
const PLANET_NINE = [22.6, 24.3];
const PLANET_NINE_BRIGHT = 21.7;
const AXIS = [14, 26];

function renderReach() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('reach');
  // Drawn at the width it is shown at, so the type stays the size it was set:
  // a fixed drawing scaled down to a phone left the labels four pixels tall.
  const W = Math.max(280, Math.min(2600, Math.round(svg.getBoundingClientRect().width) || 640));
  const k = remScale();
  const H = 172 * k;
  const pad = 8 * k;
  const y = 84 * k;
  const x = (mag) => pad + ((mag - AXIS[0]) / (AXIS[1] - AXIS[0])) * (W - 2 * pad);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const el = (name, attrs, text) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  };
  const deepest = REACH.at(-1)[1];
  // The shortfall, from the deepest reach to the prediction, as one band that
  // turns from the instrument's colour into the target's.
  const stop = (offset, colour, opacity) => el('stop', { offset, style: `stop-color: var(${colour}); stop-opacity: ${opacity}` });
  const fade = el('linearGradient', { id: 'reach-fade', x1: 0, x2: 1, y1: 0, y2: 0 });
  fade.append(stop('0', '--color-accent', 0.35), stop('1', '--color-counter', 0.85));
  const defs = el('defs', {});
  defs.append(fade);
  const parts = [
    defs,
    el('line', { class: 'reach__base', x1: x(AXIS[0]), x2: x(AXIS[1]), y1: y + 7 * k, y2: y + 7 * k }),
    el('rect', { class: 'reach__here', x: x(AXIS[0]), y, width: x(deepest) - x(AXIS[0]), height: 14 * k, opacity: 0.35 }),
    el('rect', { class: 'reach__here', x: x(AXIS[0]), y, width: x(REACH[0][1]) - x(AXIS[0]), height: 14 * k }),
    el('rect', { class: 'reach__target', x: x(PLANET_NINE[0]), y, width: x(PLANET_NINE[1]) - x(PLANET_NINE[0]), height: 14 * k }),
    el('rect', { class: 'reach__gap', x: x(deepest), y, width: x(PLANET_NINE[0]) - x(deepest), height: 14 * k, fill: 'url(#reach-fade)' }),
    el('text', { class: 'reach__label reach__label--here', x: x(AXIS[0]), y: y - 14 * k }, t('s6.here')),
    el('text', { class: 'reach__label reach__label--target', x: x(AXIS[1]), y: y - 14 * k, 'text-anchor': 'end' }, t('s6.target')),
    el('text', { class: 'reach__label', x: (x(deepest) + x(PLANET_NINE[0])) / 2, y: y - 38 * k, 'text-anchor': 'middle' }, t('s6.short')),
    el('line', { class: 'reach__bright', x1: x(PLANET_NINE_BRIGHT), x2: x(PLANET_NINE_BRIGHT), y1: y - 2 * k, y2: y + 16 * k }),
    el('text', { class: 'reach__label reach__label--bright', x: x(PLANET_NINE_BRIGHT), y: y + 66 * k, 'text-anchor': 'middle' }, t('s6.bright')),
  ];
  for (const [, mag] of REACH) {
    parts.push(el('line', { class: 'reach__pin', x1: x(mag), x2: x(mag), y1: y - 5 * k, y2: y + 19 * k }));
  }
  for (let mag = AXIS[0]; mag <= AXIS[1]; mag += 2) {
    parts.push(el('line', { class: 'reach__tick', x1: x(mag), x2: x(mag), y1: y + 22 * k, y2: y + 28 * k }));
    parts.push(el('text', { class: 'reach__axis', x: x(mag), y: y + 44 * k, 'text-anchor': 'middle' }, String(mag)));
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

/* ------------------------------------------------- slide lifecycles */

/**
 * A slide that runs something while it is on screen: the sky turning, the
 * modes cycling, the bands stepping. Each gets `enter` when it arrives and
 * `leave` when it goes, so nothing animates behind a slide no one sees.
 */
const RUNS = {};
let running = null;

function runFor(slide) {
  const kind = [...slide.classList].find((c) => c.startsWith('slide--'))?.slice(7);
  return kind ? RUNS[kind] : null;
}

function switchRun(slide) {
  const next = runFor(slide);
  if (running === next) return;
  running?.leave?.();
  running = next;
  running?.enter?.();
}

/** A pause that a slide leaving can cut short. */
const later = (ms, token) => new Promise((resolve) => {
  setTimeout(() => resolve(token.alive), ms);
});

/** Images whose file carries the language, redrawn on a change of language. */
function relabelImages() {
  for (const img of document.querySelectorAll('img[data-src-lang]')) {
    const src = img.dataset.srcLang.replace('{lang}', lang);
    if (img.getAttribute('src') !== src) img.src = src;
  }
}

/* ------------------------------------------------------------ 12 · the sky */

/**
 * Three places, three kinds of card: a ready field with two visits stored, a
 * Messier object and a named star, each with the frame the tool's own card
 * shows. Every figure on the card is read from the files the tool reads.
 */
const PICKS = [
  { kind: 'field', key: 'atala' },
  { kind: 'deep', key: 'M42' },
  { kind: 'star', key: 's279.23_38.78', star: 'Vega' },
];
const DEEP_SHAPE = {
  galaxy: 'galaxy', globular: 'cluster', open: 'cluster', asterism: 'cluster',
  nebula: 'nebula', planetary: 'nebula', remnant: 'nebula',
};
let dome = null;
let domeReady = null;
let allTargets = [];

async function getJSON(url) {
  const res = await fetch(url, { signal: deadline(null, CATALOG_DEADLINE_MS) });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function buildDome() {
  domeReady ??= (async () => {
    const [stars, deep, fieldThumbs, skyThumbs] = await Promise.all([
      loadStars(), getJSON('data/sky/deepsky.json'), getJSON('data/thumbs.json'), getJSON('data/sky/thumbs.json'),
    ]);
    await targetsReady;
    const gate = new Gate($('dome'), { onPick: () => {}, onName: () => {} });
    gate.setStars(stars);
    gate.setTargets([
      ...allTargets.map((tg) => ({ kind: 'field', key: tg.key, ra: tg.ra, dec: tg.dec, label: tool(`preset.${tg.key}`) })),
      ...deep.objects.map((o) => ({
        kind: 'deep', shape: DEEP_SHAPE[o.kind] ?? 'other', key: o.id, ra: o.ra, dec: o.dec,
        label: o.name ? `${o.id} · ${o.name}` : o.id,
      })),
    ]);
    const picks = PICKS.map((p) => {
      if (p.kind === 'field') {
        const tg = allTargets.find((x) => x.key === p.key);
        return { ...p, ra: tg.ra, dec: tg.dec, target: tg, thumb: fieldThumbs[p.key], img: `img/fields/${p.key}` };
      }
      if (p.kind === 'deep') {
        const o = deep.objects.find((x) => x.id === p.key);
        return { ...p, ra: o.ra, dec: o.dec, object: o, thumb: skyThumbs[p.key], img: `img/sky/${p.key}` };
      }
      const i = stars.named.find((s) => s.name === p.star).i;
      return {
        ...p, ra: stars.ra[i], dec: stars.dec[i], mag: stars.mag[i], bayer: stars.named.find((s) => s.i === i).bayer,
        thumb: skyThumbs[p.key], img: `img/sky/${p.key}`,
      };
    });
    dome = { gate, picks, stars };
    return dome;
  })();
  return domeReady;
}

const sexa = (deg, hours) => {
  const v = hours ? deg / 15 : Math.abs(deg);
  const a = Math.floor(v);
  const b = Math.floor((v - a) * 60);
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${pad(a)}ʰ ${pad(b)}ᵐ` : `${deg < 0 ? '−' : '+'}${pad(a)}° ${pad(b)}′`;
};

function fact(name, value) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = name;
  const dd = document.createElement('dd');
  dd.className = 'num';
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

/** Fill the card for one pick, the way the tool's card is filled. */
function fillCard(pick) {
  const { thumb } = pick;
  $('card-img').src = `${pick.img}.png`;
  $('card-tag').textContent = `${thumb.band} · ${day(thumb.iso)}`;
  const facts = [];
  if (pick.kind === 'field') {
    $('card-name').textContent = tool(`preset.${pick.key}`);
    $('card-kind').textContent = pick.target.why?.[lang] ?? pick.target.why?.en ?? '';
    facts.push(fact(tool('card.visits'), t('sky.visits', { n: pick.target.visits, d: pick.target.spanDays })));
  } else if (pick.kind === 'deep') {
    $('card-name').textContent = `${pick.object.id} · ${pick.object.name}`;
    $('card-kind').textContent = tool(`deep.${pick.object.kind}`);
    facts.push(fact(tool('card.bandVisits', { band: thumb.band }), String(thumb.visits)));
  } else {
    $('card-name').textContent = pick.star;
    $('card-kind').textContent = tool('card.star');
    facts.push(fact(tool('card.name'), pick.bayer));
    facts.push(fact(tool('card.mag'), `V ${num(pick.mag, 1)}`));
    facts.push(fact(tool('card.bandVisits', { band: thumb.band }), String(thumb.visits)));
  }
  facts.push(fact(tool('card.pos'), `${sexa(pick.ra, true)} ${sexa(pick.dec, false)}`));
  $('card-facts').replaceChildren(...facts);
}

function beat(n) {
  [...$('sky-beats').children].forEach((li, i) => {
    li.toggleAttribute('data-on', i === n - 1);
    li.toggleAttribute('data-done', i < n - 1);
  });
}

/** Turn the camera onto a place, the short way round, and settle. */
function turnTo(gate, at, ms, token) {
  const from = { ra: gate.cam.ra, dec: gate.cam.dec };
  const dRA = ((at.ra - from.ra + 540) % 360) - 180;
  const dDec = at.dec - from.dec;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now) => {
      if (!token.alive) { resolve(false); return; }
      const k = Math.min(1, (now - t0) / ms);
      const e = k * k * (3 - 2 * k);
      gate.cam.ra = (from.ra + dRA * e + 360) % 360;
      gate.cam.dec = from.dec + dDec * e;
      gate.draw();
      if (k < 1) requestAnimationFrame(step); else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

let skyToken = { alive: false };
let fieldBlink = 0;

function showField(pick) {
  const img = $('dome-field');
  img.src = `${pick.img}.png`;
  $('dome-at').textContent = `${pick.thumb.band} · ${day(pick.thumb.iso)}`;
  $('dome').parentElement.dataset.field = 'true';
  clearInterval(fieldBlink);
  // Where a second visit is stored, the field opens blinking, as the card does.
  if (pick.thumb.blink && !STILL) {
    const shots = [[`${pick.img}.png`, pick.thumb.iso], [`${pick.img}-2.png`, pick.thumb.blink]];
    let at = 0;
    fieldBlink = setInterval(() => {
      at = 1 - at;
      img.src = shots[at][0];
      $('dome-at').textContent = `${pick.thumb.band} · ${day(shots[at][1])}`;
    }, 900);
  }
}

function hideField() {
  clearInterval(fieldBlink);
  delete $('dome').parentElement.dataset.field;
}

async function runSky(token) {
  let built;
  try { built = await buildDome(); } catch { return; }
  if (!token.alive) return;
  const { gate, picks } = built;
  gate.resize();
  if (STILL) {
    const pick = picks[0];
    gate.cam.ra = pick.ra;
    gate.cam.dec = pick.dec;
    gate.select(pick);
    gate.draw();
    fillCard(pick);
    $('card').dataset.on = 'true';
    beat(3);
    return;
  }
  for (let i = 0; token.alive; i = (i + 1) % picks.length) {
    const pick = picks[i];
    beat(1);
    gate.select(null);
    gate.start();
    if (!await later(2400, token)) return;
    gate.stop();
    if (!await turnTo(gate, pick, 1500, token)) return;
    beat(2);
    gate.select(pick);
    gate.start();
    if (!await later(800, token)) return;
    beat(3);
    fillCard(pick);
    $('card').dataset.on = 'true';
    if (!await later(4200, token)) return;
    beat(4);
    delete $('card').dataset.on;
    gate.select(null);
    gate.stop();
    await gate.fly(pick, { ms: 2400 });
    if (!token.alive) return;
    showField(pick);
    if (!await later(pick.thumb.blink ? 3600 : 2600, token)) return;
    hideField();
    gate.cam.fov = 78;
    gate.measure();
  }
}

RUNS.sky = {
  enter() {
    skyToken.alive = false;
    skyToken = { alive: true };
    runSky(skyToken);
  },
  leave() {
    skyToken.alive = false;
    dome?.gate.stop();
    hideField();
  },
};

/* ----------------------------------------------------------- 13 · the modes */

const MODES = [
  { key: 'blink', name: 'mode.blink', when: 'mode.blinkWhen' },
  { key: 'wipe', name: 'mode.wipe', when: 'mode.wipeWhen' },
  { key: 'difference', name: 'mode.diff', when: 'mode.diffWhen' },
  { key: 'single', name: 'mode.single', when: 'mode.singleWhen' },
  { key: 'stack', name: 'mode.stack', when: 'mode.stackWhen' },
];
const VIEW_A = '2025-12-25';
const VIEW_B = '2026-01-01';
const MODE_MS = 5200;
let modeAt = 0;
let modeHeld = false;
let modeTimer = 0;
let viewBlink = 0;

function renderModes() {
  $('modes').replaceChildren(...MODES.map((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'modes__pill';
    b.textContent = tool(m.name);
    b.setAttribute('aria-pressed', String(i === modeAt));
    b.addEventListener('click', () => { modeHeld = true; setMode(i); });
    return b;
  }));
  setMode(modeAt, false);
}

function setMode(i, restart = true) {
  modeAt = i;
  const m = MODES[i];
  const view = $('view');
  view.dataset.mode = m.key;
  [...$('modes').children].forEach((b, k) => {
    b.setAttribute('aria-pressed', String(k === i));
    b.toggleAttribute('data-running', k === i && !modeHeld && !STILL);
  });
  $('view-what').textContent = tool(m.when);
  clearInterval(viewBlink);
  const label = {
    blink: day(VIEW_A), wipe: `A ${day(VIEW_A)} · B ${day(VIEW_B)}`, difference: `A − B`,
    single: day(VIEW_A), stack: t('modes.season'),
  }[m.key];
  $('view-date').textContent = label;
  view.dataset.show = 'a';
  if (m.key === 'blink' && !STILL) {
    viewBlink = setInterval(() => {
      view.dataset.show = view.dataset.show === 'a' ? 'b' : 'a';
      $('view-date').textContent = day(view.dataset.show === 'a' ? VIEW_A : VIEW_B);
    }, 800);
  }
  // Restart the sweep and the timer bar, so each arrival plays from the start.
  if (restart) {
    view.classList.remove('is-playing');
    void view.offsetWidth;
    view.classList.add('is-playing');
  }
}

RUNS.modes = {
  enter() {
    modeHeld = false;
    setMode(0);
    if (STILL) return;
    clearInterval(modeTimer);
    modeTimer = setInterval(() => { if (!modeHeld) setMode((modeAt + 1) % MODES.length); }, MODE_MS);
  },
  leave() { clearInterval(modeTimer); clearInterval(viewBlink); },
};

/* ----------------------------------------------------------- 14 · the bands */

const BAND_HUES = { D1: 285, D2: 235, D3: 160, D4: 100, D5: 60, D6: 25 };
const WIDTHS = [0.1, 0.15, 0.2, 0.3, 0.45, 0.6];
const SITE = 'https://muninn.mydevbox.xyz/';
let bandRanges = null;
let bandAt = 1;
let bandTimer = 0;

async function loadBandRanges() {
  try {
    const index = await getJSON('data/fields/atala.json');
    const out = {};
    for (const f of index.frames) {
      if (!Number.isFinite(f.emMin) || !Number.isFinite(f.emMax)) continue;
      const r = out[f.band] ??= [Infinity, -Infinity];
      r[0] = Math.min(r[0], f.emMin);
      r[1] = Math.max(r[1], f.emMax);
    }
    bandRanges = out;
  } catch {
    bandRanges = {};
  }
  renderBands();
}

function renderBands() {
  if (!bandRanges) return;
  const bands = Object.keys(BAND_HUES).filter((b) => bandRanges[b]);
  if (!bands.length) return;
  const lo = Math.min(...bands.map((b) => bandRanges[b][0]));
  const hi = Math.max(...bands.map((b) => bandRanges[b][1]));
  const at = (um) => ((um - lo) / (hi - lo)) * 100;
  $('bands').replaceChildren(...bands.map((b, i) => {
    const [a, z] = bandRanges[b];
    const li = document.createElement('li');
    li.className = 'lambdas__row';
    li.dataset.band = b;
    li.style.setProperty('--i', String(i));
    li.style.setProperty('--h', String(BAND_HUES[b]));
    li.style.setProperty('--from', `${at(a).toFixed(2)}%`);
    li.style.setProperty('--to', `${(100 - at(z)).toFixed(2)}%`);
    const name = document.createElement('span');
    name.className = 'lambdas__name';
    name.textContent = b;
    const track = document.createElement('span');
    track.className = 'lambdas__track';
    const bar = document.createElement('span');
    bar.className = 'lambdas__bar';
    track.append(bar);
    const um = document.createElement('span');
    um.className = 'lambdas__um num';
    um.textContent = `${num(a, 2)}–${num(z, 2)}`;
    li.append(name, track, um);
    return li;
  }));
  $('widths').replaceChildren(...WIDTHS.map((w) => {
    const li = document.createElement('li');
    li.textContent = `${num(w * 60, 0)}′`;
    return li;
  }));
  stepBand(bandAt);
}

function stepBand(i) {
  bandAt = i;
  const band = `D${i + 1}`;
  for (const row of $('bands').children) row.toggleAttribute('data-on', row.dataset.band === band);
  [...$('widths').children].forEach((li, k) => li.toggleAttribute('data-on', k === i));
  // The chrome takes the band's hue, as the tool's does.
  if (slides[current]?.classList.contains('slide--bands')) document.documentElement.dataset.band = band;
  const params = [
    ['ra', '13.41940'], ['dec', '3.84590'], ['fov', String(WIDTHS[i])], ['band', band], ['lang', lang],
  ];
  const parts = [document.createTextNode(`${SITE}#`)];
  params.forEach(([k, v], n) => {
    // A long address breaks before a parameter, never inside one.
    if (n) parts.push(document.createElement('wbr'), document.createTextNode('&'));
    const span = document.createElement('span');
    span.textContent = `${k}=${v}`;
    if (k === 'fov' || k === 'band') span.className = 'address__live';
    parts.push(span);
  });
  $('address').replaceChildren(...parts);
}

RUNS.bands = {
  enter() {
    stepBand(1);
    if (STILL) return;
    clearInterval(bandTimer);
    bandTimer = setInterval(() => stepBand((bandAt + 1) % 6), 1700);
  },
  leave() {
    clearInterval(bandTimer);
    document.documentElement.dataset.band = 'D2';
  },
};

/* -------------------------------------------------------- 16 · the mark */

function renderCsv() {
  $('csv').replaceChildren(
    Object.assign(document.createElement('span'), { className: 'csv__k', textContent: t('mark.csv') }),
    document.createTextNode(trackCSV([]).trim()),
  );
}

/* ------------------------------------------------------ 17 · the overlay */

const ASKS = [
  { name: 'Gaia DR3', host: 'NASA MAST',
    en: 'what the star is, in a second or two', ru: 'что это за звезда, за секунду-две' },
  { name: 'Gaia DR3 · AllWISE · 2MASS', host: 'NASA IRSA · CDS VizieR',
    en: 'the same catalogues raced: the first answer is used', ru: 'те же каталоги наперегонки: берётся первый ответ' },
  { name: 'CatWISE2020', host: 'NASA IRSA',
    en: 'a proper motion from ten years of WISE, said only at five times its error', ru: 'собственное движение за десять лет WISE, только если оно впятеро больше ошибки' },
  { name: 'SIMBAD', host: 'CDS',
    en: 'what it is called', ru: 'как она называется' },
  { name: 'VSX', host: 'AAVSO',
    en: 'whether it is a known variable', ru: 'известная ли это переменная' },
];

function renderAsks() {
  $('asks').replaceChildren(...ASKS.map((a, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', String(i));
    const head = document.createElement('p');
    head.className = 'asks__name';
    const host = document.createElement('span');
    host.className = 'num';
    host.textContent = a.host;
    head.append(a.name, host);
    const what = document.createElement('p');
    what.className = 'asks__what';
    what.textContent = a[lang] ?? a.en;
    li.append(head, what);
    return li;
  }));
}

/* ----------------------------------- 7 · Hunter X and the season link */

const RATE_AXIS = { au: [1.5, 2000], rate: [0.001, 100] };
const PLANET_X_AU = [400, 800];
/** README: Hunter X's three-pixel floor (18.45″) inside one season of about eleven days, 264 h. */
const ASTROMETRY_FLOOR = 0.07;

function renderRate() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('rate');
  // Drawn at the size it is shown at, so the type is the size it was set.
  const W = Math.max(300, Math.min(2000, Math.round(svg.getBoundingClientRect().width) || 560));
  const k = remScale();
  const H = Math.round(Math.min(W * 0.62, Math.max(180 * k, innerHeight * 0.4)));
  svg.style.blockSize = `${H}px`;
  const pad = { l: 64 * k, r: 12 * k, t: 34 * k, b: 46 * k };
  const lx = (au) => pad.l + (Math.log10(au / RATE_AXIS.au[0]) / Math.log10(RATE_AXIS.au[1] / RATE_AXIS.au[0])) * (W - pad.l - pad.r);
  const ly = (r) => H - pad.b - (Math.log10(r / RATE_AXIS.rate[0]) / Math.log10(RATE_AXIS.rate[1] / RATE_AXIS.rate[0])) * (H - pad.t - pad.b);
  const el = (name, attrs, text) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const parts = [];
  for (const au of [2, 10, 100, 1000]) {
    parts.push(el('line', { class: 'rate__grid', x1: lx(au), x2: lx(au), y1: pad.t, y2: H - pad.b }));
    parts.push(el('text', { class: 'rate__tick', x: lx(au), y: H - pad.b + 22 * k, 'text-anchor': 'middle' }, num(au, 0)));
  }
  for (const r of [0.001, 0.01, 0.1, 1, 10, 100]) {
    parts.push(el('line', { class: 'rate__grid', x1: pad.l, x2: W - pad.r, y1: ly(r), y2: ly(r) }));
    parts.push(el('text', { class: 'rate__tick', x: pad.l - 8 * k, y: ly(r) + 6 * k, 'text-anchor': 'end' }, num(r, r < 1 ? Math.round(-Math.log10(r)) : 0)));
  }
  parts.push(el('text', { class: 'rate__axis', x: W - pad.r, y: H - 4 * k, 'text-anchor': 'end' }, t('hunt.axisX')));
  parts.push(el('text', { class: 'rate__axis', x: pad.l, y: pad.t - 12 * k }, t('hunt.axisY')));
  // Planet X's distance and the rates it gives, from the same function.
  const [near, far] = PLANET_X_AU;
  parts.push(el('rect', {
    class: 'rate__px', x: lx(near), y: pad.t, width: lx(far) - lx(near), height: H - pad.t - pad.b,
  }));
  parts.push(el('text', { class: 'rate__pxk', x: lx(near) - 10 * k, y: pad.t + 22 * k, 'text-anchor': 'end' }, t('hunt.px')));
  parts.push(el('line', { class: 'rate__floor', x1: pad.l, x2: W - pad.r, y1: ly(ASTROMETRY_FLOOR), y2: ly(ASTROMETRY_FLOOR) }));
  parts.push(el('text', { class: 'rate__floork', x: pad.l + 8 * k, y: ly(ASTROMETRY_FLOOR) - 8 * k }, t('hunt.floor')));
  let d = '';
  for (let k = 0; k <= 160; k++) {
    const au = RATE_AXIS.au[0] * (RATE_AXIS.au[1] / RATE_AXIS.au[0]) ** (k / 160);
    d += `${k ? 'L' : 'M'}${lx(au).toFixed(1)},${ly(rateAtAU(au)).toFixed(1)}`;
  }
  parts.push(el('path', { class: 'rate__curve', d, pathLength: '1' }));
  for (const au of PLANET_X_AU) {
    parts.push(el('circle', { class: 'rate__pin', cx: lx(au), cy: ly(rateAtAU(au)), r: 5 * k }));
  }
  // Where SPHEREx actually sees it: near quadrature, a twentieth of the rate
  // at opposition and under the season's floor (README, Hunter X).
  const q = { lo: 0.006, hi: 0.02 };
  const qx = (lx(near) + lx(far)) / 2;
  parts.push(el('line', { class: 'rate__quad', x1: qx, x2: qx, y1: ly(q.lo), y2: ly(q.hi) }));
  parts.push(el('text', { class: 'rate__quadk', x: lx(near) - 10 * k, y: ly(Math.sqrt(q.lo * q.hi)) + 6 * k, 'text-anchor': 'end' }, t('hunt.quad')));
  const mid = rateAtAU(far);
  parts.push(el('text', { class: 'rate__val', x: lx(far) + 10 * k, y: ly(mid) - 12 * k },
    `${num(rateAtAU(far), 2)}–${num(rateAtAU(near), 2)}${t('hunt.perHour')}`));
  svg.replaceChildren(...parts);
}

/* ----------------------------------------------------- 18 · other archives */

/** CADC, distinct science observations within 0.1° of Barnard's Star. */
const ARCHIVES = [
  ['TESS', 10664], ['CFHT', 1970], ['HST', 826], ['NEOSSat', 572], ['Gemini', 379],
  ['DAO', 36], ['APASS', 20], ['SDSS', 10],
];

function renderArchives() {
  const top = Math.log10(Math.max(...ARCHIVES.map(([, n]) => n)));
  $('archives').replaceChildren(...ARCHIVES.map(([name, n], i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', String(i));
    li.style.setProperty('--v', (Math.log10(n) / top).toFixed(4));
    if (name === 'NEOSSat') li.toggleAttribute('data-hit', true);
    const k = document.createElement('span');
    k.className = 'archives__name';
    k.textContent = name;
    const bar = document.createElement('span');
    bar.className = 'archives__bar';
    const v = document.createElement('span');
    v.className = 'archives__n num';
    v.dataset.n = String(n);
    v.dataset.digits = '0';
    v.textContent = num(n, 0);
    li.append(k, bar, v);
    return li;
  }));
}

/* --------------------------------------------------------- 19 · a release */

let typing = 0;
let typingStart = 0;

RUNS.release = {
  enter() {
    const line = COLLECTIONS.map((c) => `'${c}'`).join(', ');
    const out = $('typed');
    clearInterval(typing);
    clearTimeout(typingStart);
    if (STILL) { out.textContent = line; return; }
    out.textContent = '';
    let n = 0;
    // The old line is struck first; then the new one is written out.
    typingStart = setTimeout(() => {
      typing = setInterval(() => {
        n += 1;
        out.textContent = line.slice(0, n);
        if (n >= line.length) clearInterval(typing);
      }, 38);
    }, 1500);
  },
  leave() { clearInterval(typing); clearTimeout(typingStart); },
};

/* -------------------------------------------------------------------- start */

startLanguage();
buildScale();
wire();
current = Math.max(0, (Number(location.hash.slice(1)) || 1) - 1);
relabel();
loadTargets();
readFrames();
loadBandRanges();
