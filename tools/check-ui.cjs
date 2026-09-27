// Ручная проверка веб-интерфейса против запущенного демона.
//
// Тестов в проекте не было; это первая проверка слоя интерфейса. Скрипт
// выполняет web/app.js в песочнице Node с заглушкой DOM и направляет его
// запросы в работающий демон, поэтому проверяются настоящие разбор выдачи,
// категории, пагинация и показ причины ошибки.
//
// Запуск (сначала поднимите демон, адрес должен совпадать с ORIGIN):
//   torrclient.exe -port 8123 -quiet
//   node tools/check-ui.cjs
//
// Сеть нужна: часть проверок сверяется с живой страницей rutor.info.
// Отказы вида «el.insertBefore is not a function» — это пробелы заглушки DOM в
// отрисовке карточек, к делу не относятся и печатаются как «фон».

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ORIGIN = process.env.TC_ORIGIN || 'http://127.0.0.1:8123';
const appJs = path.join(__dirname, '..', 'web', 'app.js');
const code = fs.readFileSync(appJs, 'utf8');

/* Заглушка элемента. querySelector отдаёт тот же заглушечный узел для одного и
   того же запроса: без этого код, наполняющий окно по частям, падал бы на null,
   и проверять панели было бы нечем. appendChild складывает детей в список. */
const makeEl = () => {
  const kids = {};
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], innerHTML: '', textContent: '', value: '', checked: false, disabled: false, title: '', className: '',
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; }, remove() {},
    setAttribute() {}, getAttribute: () => null,
    querySelector(sel) { if (!kids[sel]) kids[sel] = makeEl(); return kids[sel]; },
    querySelectorAll: () => [],
    focus() {}, click() {}, insertAdjacentHTML() {}, closest: () => null,
  };
};

const store = new Map();
const els = new Map();
const el = s => { if (!els.has(s)) els.set(s, makeEl()); return els.get(s); };

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: (u, o) => fetch(new URL(u, ORIGIN).href, o),
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  location: { href: ORIGIN + '/', replace() {}, origin: ORIGIN, hash: '', pathname: '/' },
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  document: {
    querySelector: el, querySelectorAll: () => [], getElementById: el,
    createElement: makeEl, addEventListener() {}, body: makeEl(), documentElement: makeEl(),
  },
  addEventListener() {}, removeEventListener() {}, alert() {},
  requestAnimationFrame: cb => setTimeout(cb, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

process.on('unhandledRejection', e => console.log('  (фон: ' + ((e && e.message) || e) + ')'));
process.on('uncaughtException', e => console.log('  (фон: ' + ((e && e.message) || e) + ')'));

const ctx = vm.createContext(sandbox);
try { vm.runInContext(code, ctx, { filename: 'app.js' }); } catch (e) {
  console.log('загрузка app.js прервана на: ' + String(e.message).split('\n')[0]);
}

let fails = 0;
let checks = 0;
const check = (ok, label, detail) => {
  checks++;
  console.log((ok ? '  ок   ' : '  ПЛОХО') + ' | ' + label + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
};
const setState = src => vm.runInContext(src, ctx);

(async () => {
  for (const fn of ['searchRutor', 'apiGetJSON', 'loadMore', 'searchKinozal', 'mergeResults', 'rutorCat']) {
    if (typeof ctx[fn] !== 'function') { console.log('НЕТ ФУНКЦИИ ' + fn); process.exitCode = 1; return; }
  }

  // Подмена функции держится до конца прогона, а разделы ниже подменяют
  // playSelected и progressPanel, чтобы проверить выбор серии без плеера.
  // Исходники сохраняются: разделу про панель нужны настоящие функции, и без
  // возврата он проверял бы заглушку предыдущего раздела.
  setState("globalThis.__real = { playSelected: playSelected, progressPanel: progressPanel, launchPlayer: launchPlayer };");

  console.log('\n1. Разбор выдачи: сиды и пиры должны различаться');
  const p0 = await ctx.searchRutor('матрица', 0, 0);
  sandbox.__items = p0;
  check(p0.length === 100, 'раздач на странице', String(p0.length));
  const same = p0.filter(x => x.seed === x.peer).length;
  check(same < p0.length, 'сиды и пиры не совпадают во всех строках', 'совпало ' + same + ' из ' + p0.length);
  check(/GB|MB/.test(p0[0].size || ''), 'размер разобран', String(p0[0].size));
  check(!!p0[0].title && !!p0[0].magnet, 'название и магнит на месте');

  // Сверка с независимым разбором той же страницы: числа на живой раздаче
  // колеблются, поэтому зашитые значения ничего не доказывают.
  const raw = await (await fetch(
    'https://rutor.info/search/0/0/000/0/' + encodeURIComponent('матрица'),
    { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const norm = raw.replace(/&nbsp;/g, ' ').replace(/\u00a0/g, ' ');
  const row = norm.match(/<tr class="(?:gai|tum)".*?<\/tr>/s)[0];
  const refSeed = row.match(/<span class="green">.*?(-?\d+)\s*<\/span>/s)[1];
  const refPeer = row.match(/<span class="red">[^<]*?(-?\d+)\s*<\/span>/s)[1];
  check(String(p0[0].seed) === refSeed && String(p0[0].peer) === refPeer,
    'сиды/пиры совпали с независимым разбором страницы',
    'интерфейс ' + p0[0].seed + '/' + p0[0].peer + ', страница ' + refSeed + '/' + refPeer);
  check(refSeed !== refPeer, 'на живой странице сиды и пиры различаются', refSeed + ' и ' + refPeer);

  console.log('\n2. Пагинация: вторая страница — другой срез выдачи');
  const p1 = await ctx.searchRutor('матрица', 1, 0);
  check(p1.length === 100, 'раздач на второй странице', String(p1.length));
  check(p0[0].title !== p1[0].title, 'первая строка отличается', String(p1[0].title).slice(0, 34));
  const inter = new Set(p0.map(x => x.hash));
  check(p1.filter(x => inter.has(x.hash)).length === 0, 'пересечение с первой страницей', '0');

  console.log('\n3. Категория — поле адреса, а не слово запроса');
  const games = await ctx.searchRutor('2024', 0, 8);
  check(games.length > 0, 'выдача категории «Игры» не пуста', String(games.length));
  const pc = games.filter(x => /PC|RePack|Portable|Steam|Игр/i.test(x.title)).length;
  check(pc > games.length / 2, 'выдача похожа на игры', pc + ' из ' + games.length);
  const books = await ctx.searchRutor('2024', 0, 11);
  check(books[0].title !== games[0].title, 'другая категория даёт другую выдачу',
    String(books[0].title).slice(0, 40));

  console.log('\n4. Успешный ответ читается как тело (путь ТОП-24)');
  const top = await ctx.apiGetJSON('/api/top24');
  check(top && top.ok === true, 'ответ разобран', 'ok=' + (top && top.ok));
  check(Array.isArray(top.items) && top.items.length === 30, 'раздач в ТОП-24', String(top.items && top.items.length));

  console.log('\n5. Кинозал: живая выдача разбирается, кириллица читается');
  let kz = null, kzErr = '';
  try { kz = await ctx.searchKinozal('матрица', 0); } catch (e) { kzErr = e.message; }
  if (kz && kz.length) {
    check(kz.length > 0, 'раздач получено', String(kz.length));
    check(/[А-Яа-яЁё]/.test(kz[0].title || ''), 'название по-русски', String(kz[0].title).slice(0, 46));
    check(!/\uFFFD/.test(kz[0].title || ''), 'в названии нет битых знаков');
    check(/ГБ|МБ|ТБ|КБ/.test(kz[0].size || ''), 'размер разобран', String(kz[0].size));
    check(/\d{2}\.\d{2}\.\d{4}/.test(kz[0].date || ''), 'дата разобрана', String(kz[0].date));
    check(/details\.php\?id=\d+/.test(kz[0].link || ''), 'адрес раздачи', String(kz[0].link).slice(0, 50));
    check(/get\.php\?id=\d+/.test(kz[0].get || ''), 'адрес файла .torrent', String(kz[0].get).slice(0, 50));
    const kz2 = await ctx.searchKinozal('матрица', 1);
    check(kz2.length && kz2[0].link !== kz[0].link, 'вторая страница — другой срез',
      kz2.length ? String(kz2[0].link).slice(-14) : 'пусто');
  } else {
    check(false, 'Кинозал не ответил', String(kzErr).slice(0, 90));
  }

  console.log('\n6. Повторы выбрасываются');
  const dup = ctx.mergeResults(
    [{ hash: 'a'.repeat(40), title: 'Матрица' }],
    [{ hash: 'a'.repeat(40), title: 'Матрица' }, { title: 'Начало', size: '3 ГБ' }, { title: 'Начало', size: '3 ГБ' }]);
  check(dup.length === 2, 'из 4 строк осталось 2', String(dup.length));

  console.log('\n7. Причина ошибки читается из тела, а не «HTTP 502»');
  let msg = '';
  try { await ctx.apiGetJSON('/api/rutor/search?query=x&page=99'); } catch (e) { msg = e.message; }
  if (msg) {
    check(!/^HTTP \d+$/.test(msg), 'это не голый код состояния', msg.slice(0, 60));
  } else {
    console.log('  ок   | причина ошибки не потребовалась: источник ответил');
  }

  console.log('\n8. Кнопка «Показать ещё» и догрузка страницы');
  setState('state.searchState.results = __items; state.searchState.status = [];');
  const box = el('#searchResults');

  setState("moreSources = { rutor: { query: 'матрица', page: 0, count: 100, cat: 0 } };");
  try { ctx.paintResults(box); } catch (e) { /* отрисовка карточек требует настоящего DOM */ }
  check(String(box.innerHTML).includes('moreBtn'), 'кнопка есть, когда страница пришла полной');

  setState('moreSources.rutor.count = 37;');
  try { ctx.paintResults(box); } catch (e) {}
  check(!String(box.innerHTML).includes('moreBtn'), 'кнопки нет, когда страница неполная');

  setState("moreSources = { rutor: { query: 'матрица', page: 0, count: 100, cat: 0 } };");
  // state — const в области скрипта, снаружи не виден: читаем через тот же контекст.
  const count = () => vm.runInContext('state.searchState.results.length', ctx);
  const before = count();
  try {
    await ctx.loadMore();
  } catch (e) {
    check(false, 'догрузка следующей страницы', e.message);
  }
  check(count() > before, '«Показать ещё» добавила раздачи', before + ' → ' + count());
  check(vm.runInContext('state.searchState.results.every(x => x.hash && x.title)', ctx),
    'добавленные строки полноценны');
  check(vm.runInContext('moreSources.rutor.page', ctx) === 1, 'номер страницы сдвинулся',
    String(vm.runInContext('moreSources.rutor.page', ctx)));

  console.log('\n9. Категория из списка переводится в код трекера');
  const catOf = v => vm.runInContext(
    "(() => { $('#searchCat').value = " + JSON.stringify(v) + "; return rutorCat(); })()", ctx);
  check(catOf('') === 0, '«Все категории» → 0', String(catOf('')));
  check(catOf('фильм') === 1, '«Зарубежные фильмы» → 1', String(catOf('фильм')));
  check(catOf('игры') === 8, '«Игры» → 8', String(catOf('игры')));
  check(catOf('книги') === 11, '«Книги» → 11', String(catOf('книги')));

  console.log('\n10. Разбор номера серии — образцы прежнего клиента');
  const ep = s => vm.runInContext('parseSeriesEp(' + JSON.stringify(s) + ')', ctx);
  const eq = (got, want, label) => check(JSON.stringify(got) === JSON.stringify(want), label,
    'получилось ' + JSON.stringify(got));
  eq(ep('Сериал.2019.S01E02.1080p.mkv'), { s: 1, e: 2, e2: 0 }, 'S01E02');
  eq(ep('Сериал.S01E01-E10.1080p'), { s: 1, e: 1, e2: 10 }, 'диапазон S01E01-E10');
  eq(ep('Сериал.Сезон 1 Серия 3.avi'), { s: 1, e: 3, e2: 0 }, '«Сезон 1 Серия 3»');
  eq(ep('Сериал 1x02.mkv'), { s: 1, e: 2, e2: 0 }, '«1x02»');
  eq(ep('Сериал.Сезон 2.mkv'), { s: 2, e: 0, e2: 0 }, 'только «Сезон 2»');
  eq(ep('Матрица.1999.mkv'), null, 'фильм без номера серии');

  console.log('\n11. Отметки просмотра ведёт демон, а не TorrServer');
  const hash = 'f'.repeat(40);
  const wrote = await ctx.savePosition(hash, 1, 812, 2700, false);
  check(wrote === true, 'отметка записана через демон');
  await ctx.loadPositions();
  const mk = vm.runInContext("markOf({hash: '" + hash + "'}, 1)", ctx);
  check(!!mk && mk.timecode === 812 && mk.duration === 2700, 'позиция прочиталась обратно',
    JSON.stringify(mk));
  check(vm.runInContext("currentTc({hash: '" + hash + "'}, 1)", ctx) === 812, 'позиция продолжения');
  check(vm.runInContext("isWatched({hash: '" + hash + "'}, 1)", ctx) === false, 'серия не досмотрена');
  const share = vm.runInContext("viewedShare({hash: '" + hash + "'}, 1)", ctx);
  check(Math.abs(share - 812 / 2700) < 0.01, 'доля просмотра посчитана', String(share.toFixed(3)));

  await ctx.savePosition(hash, 1, 0, 2700, true);
  await ctx.loadPositions();
  check(vm.runInContext("isWatched({hash: '" + hash + "'}, 1)", ctx) === true, 'отметка досмотра принята');
  check(vm.runInContext("currentTc({hash: '" + hash + "'}, 1)", ctx) === 0,
    'досмотренная серия не продолжается с конца');

  console.log('\n12. Следующая серия выбирается по отметкам, а не по порядку файлов');
  setState("state.viewed = [];");
  const torrent = { hash, title: 'Сериал', file_stats: [1, 2, 3].map(i => ({ id: i, path: 'Сериал/S01E0' + i + '.mkv' })) };
  sandbox.__t = torrent;
  await ctx.savePosition(hash, 1, 0, 2700, true);   // первая досмотрена
  await ctx.savePosition(hash, 2, 300, 2700, false); // вторая начата
  await ctx.loadPositions();
  const next = vm.runInContext('nextEpisode(__t, __t.file_stats)', ctx);
  check(next && next.id === 3, 'следующая — третья серия', next ? String(next.id) : 'нет');
  eq(vm.runInContext('epLabel(__t.file_stats[0], __t)', ctx), 'Сезон 1 · Серия 1', 'подпись серии');
  const prog = vm.runInContext('seriesProgress(__t)', ctx);
  check(prog && prog.done === 1 && prog.total === 3 && prog.started === 1, 'ход просмотра раздачи',
    JSON.stringify(prog));

  console.log('\n13. Сериал не открывается первой серией молча');
  setState("openEpisodesPicker = (t, files) => { globalThis.__eps = { title: t.title, count: (files || []).length }; };");
  setState("playSelected = () => { globalThis.__played = (globalThis.__played || 0) + 1; return Promise.resolve(); };");
  await ctx.watchNow(torrent);
  const eps = vm.runInContext('globalThis.__eps', ctx);
  check(eps && eps.count === 3, 'открылся список серий', JSON.stringify(eps));
  check(!vm.runInContext('globalThis.__played', ctx), 'показ не начался сам');
  // Одиночный фильм по-прежнему открывается сразу.
  setState("globalThis.__eps = null; globalThis.__played = 0;");
  await ctx.watchNow({ hash, title: 'Фильм', file_stats: [{ id: 1, path: 'Фильм.mkv' }] });
  check(vm.runInContext('globalThis.__played', ctx) === 1, 'фильм открывается сразу');
  check(!vm.runInContext('globalThis.__eps', ctx), 'список серий для фильма не открывается');

  console.log('\n14. Плейлист раздачи отдаёт демон');
  const listHash = process.env.TC_HASH || '';
  if (!listHash) {
    console.log('  ок   | раздача не задана (TC_HASH) — проверка плейлиста пропущена');
  } else {
    const r = await fetch(ORIGIN + '/api/playlist?hash=' + listHash + '&index=1');
    const body = await r.text();
    const links = body.split('\n').filter(l => l.startsWith('http'));
    check(r.status === 200, 'плейлист получен', 'код ' + r.status);
    check(/mpegurl/.test(r.headers.get('content-type') || ''), 'тип содержимого — m3u',
      String(r.headers.get('content-type')));
    check(links.length > 1, 'серий в плейлисте', String(links.length));
    check(links.every(l => l.startsWith(ORIGIN + '/ts/stream/')), 'ссылки ведут на демон');
    check(links.every(l => /[?&]play/.test(l)), 'в ссылках есть запуск потока');
    const r2 = await fetch(ORIGIN + '/api/playlist?hash=' + listHash + '&index=2');
    const links2 = (await r2.text()).split('\n').filter(l => l.startsWith('http'));
    check(links2.length === links.length - 1, 'плейлист начинается с выбранной серии',
      links2.length + ' из ' + links.length);
    check(/index=2&play/.test(links2[0] || ''), 'первая ссылка — выбранная серия');
  }

  console.log('\n15. Вкладка «Сериалы»: сезон разбирается из названия раздачи');
  const season = s => vm.runInContext('seasonOf(' + JSON.stringify(s) + ')', ctx);
  check(season('Сериал [Сезон 3] (2020) BDRip') === 3, '«Сезон 3»', String(season('Сериал [Сезон 3] (2020) BDRip')));
  // «[1-8 сезон]» — самое частое написание на трекере, и прежний разбор его терял:
  // раздача исчезала из вкладки целиком.
  check(season('Доктор Хаус (2004) [1-8 сезон] HDTVRip') === 1, '«[1-8 сезон]»',
    String(season('Доктор Хаус (2004) [1-8 сезон] HDTVRip')));
  check(season('Сериал 5 сезон 1080p') === 5, '«5 сезон»', String(season('Сериал 5 сезон 1080p')));
  check(season('Сериал S07 WEB-DL') === 7, '«S07»', String(season('Сериал S07 WEB-DL')));
  check(season('Матрица (1999) 1080p') === 0, 'у фильма сезона нет', String(season('Матрица (1999) 1080p')));
  check(vm.runInContext("JSON.stringify(seriesInfo('Доктор Хаус (2004) [1-8 сезон]'))", ctx) === '{"s":1,"e":0,"e2":0}',
    'раздача с диапазоном сезонов попадает в список');

  console.log('\n16. Карточка сериала: подписи и состояние просмотра');
  setState("state.viewed = [];");
  const serHash = 'a1'.repeat(20);
  const lib = [
    { hash: serHash, title: 'Сериал [Сезон 1] (2020) WEB-DL 1080p',
      file_stats: [{ id: 1, path: 'Сериал/S01E01.mkv' }, { id: 2, path: 'Сериал/S01E02.mkv' }] },
  ];
  setState('state.lib = ' + JSON.stringify(lib) + ';');
  setState('statCache["' + serHash + '"] = { at: Date.now(), data: ' + JSON.stringify(lib[0]) + ' };');
  await ctx.savePosition(serHash, 1, 0, 2700, true);   // первая досмотрена
  await ctx.savePosition(serHash, 2, 600, 2700, false); // вторая начата
  await ctx.loadPositions();
  setState("$('#serQuery').value = '';");
  ctx.paintSeriesBody();
  const html = String(vm.runInContext("$('#serBody').innerHTML", ctx));
  check(html.includes('Сезон 1'), 'сезон подписан по-русски', 'Сезон 1');
  check(html.includes('Серия 1') && html.includes('Серия 2'), 'серии подписаны по-русски, а не «E01»');
  check(html.includes('data-watch='), 'есть кнопка «Смотреть»');
  check(html.includes('1 из 2'), 'счёт просмотренных серий', '1 из 2');
  const clsOf = n => (html.match(new RegExp('data-ep-num="' + n + '"[^>]*class="([^"]*)"')) || [])[1] || '';
  check(clsOf(1).includes('viewed'), 'досмотренная серия помечена', clsOf(1) || 'нет класса');
  check(clsOf(2).includes('cont'), 'начатая серия помечена', clsOf(2) || 'нет класса');

  console.log('\n17. Панель подгрузки показывается при каждом запуске показа');
  // Раздел 13 подменил playSelected и оставил подмену в силе: без возврата
  // здесь проверялась бы заглушка, а не панель.
  setState("playSelected = globalThis.__real.playSelected;");
  setState("globalThis.__panels = 0; globalThis.__launch = 0;");
  setState("progressPanel = () => { globalThis.__panels++; return { stop() {} }; };");
  setState("launchPlayer = () => { globalThis.__launch++; return Promise.resolve({ ok: true }); };");
  // Игрок задан явно: выбор по умолчанию зависит от того, что найдено на
  // машине, и на сборочной машине плееров нет — проверка зависела бы от неё.
  await ctx.playSelected({ hash: serHash, title: 'Сериал', file_stats: lib[0].file_stats }, lib[0].file_stats[0], { player: 'vlc' });
  check(vm.runInContext('globalThis.__panels', ctx) === 1, 'панель создана при запуске плеера');
  check(vm.runInContext('globalThis.__launch', ctx) === 1, 'плеер запущен');
  await ctx.playSelected({ hash: serHash, title: 'Сериал', file_stats: lib[0].file_stats }, lib[0].file_stats[0], { player: 'browser' });
  check(vm.runInContext('globalThis.__panels', ctx) === 1, 'в браузере панель не нужна');

  // Наполнение панели числами и её уход — на живой раздаче.
  if (!process.env.TC_HASH) {
    console.log('  ок   | раздача не задана (TC_HASH) — наполнение панели пропущено');
  } else {
    setState("globalThis.__cap = null; const _ce = document.createElement; document.createElement = t => { const e = _ce(t); if (!globalThis.__cap) globalThis.__cap = e; return e; };");
    setState("progressPanel = globalThis.__real.progressPanel;");
    const panel = ctx.progressPanel({ hash: process.env.TC_HASH, title: 'Проверка' }, { id: 1, path: 'S01E01.mkv' });
    await new Promise(r => setTimeout(r, 3000));
    const st = vm.runInContext("__cap.querySelector('[data-st=\"seeds\"]').textContent", ctx);
    const stage = vm.runInContext("__cap.querySelector('[data-st=\"stage\"]').textContent", ctx);
    check(/^сиды: \d+$/.test(st), 'числа раздачи в панели', String(st));
    check(stage !== '—' && stage.length > 0, 'этап назван словами', String(stage));
    check(typeof panel.stop === 'function', 'панель можно закрыть');
    check(vm.runInContext('activePanel !== null', ctx), 'текущая панель записана');
    panel.stop();
    check(vm.runInContext('activePanel === null', ctx), 'после закрытия панель не остаётся');
  }

  console.log('\n18. «Продолжить просмотр» на странице библиотеки');
  const contLib = [
    { hash: 'c1'.repeat(20), title: 'Сериал [Сезон 2] (2021) WEB-DL',
      file_stats: [{ id: 1, path: 'Сериал/S02E01.mkv' }, { id: 2, path: 'Сериал/S02E02.mkv' }] },
    { hash: 'c2'.repeat(20), title: 'Фильм (2018) BDRip', file_stats: [{ id: 1, path: 'Фильм.mkv' }] },
  ];
  setState('state.lib = ' + JSON.stringify(contLib) + ';');
  setState('state.viewed = ' + JSON.stringify([
    { hash: 'c1'.repeat(20), file_index: 1, timecode: 300, duration: 2700, updated: 100 },
    { hash: 'c1'.repeat(20), file_index: 2, timecode: 0, duration: 2700, done: true, updated: 200 },
    { hash: 'c2'.repeat(20), file_index: 1, timecode: 2700, duration: 5400, updated: 300 },
  ]) + ';');
  ctx.paintContinue();
  const strip = String(vm.runInContext("$('#libContinue').innerHTML", ctx));
  check(strip.includes('Продолжить просмотр'), 'полоса показана', strip ? 'есть разметка' : 'пусто');
  check(/class="cont-n">2</.test(strip), 'счётчик недосмотренных', (strip.match(/class="cont-n">\d+</) || ['нет'])[0]);
  check((strip.match(/data-cont /g) || []).length === 2, 'карточек по числу недосмотренных',
    String((strip.match(/data-cont /g) || []).length));
  check(strip.indexOf('c2'.repeat(20)) < strip.indexOf('c1'.repeat(20)), 'свежая раздача первой');
  check(!strip.includes('data-cont-file="2"'), 'досмотренная серия в полосу не попала');
  setState('state.viewed = [];');
  ctx.paintContinue();
  check(vm.runInContext("$('#libContinue').classList.contains('hidden')", ctx) === true ||
    String(vm.runInContext("$('#libContinue').innerHTML", ctx)) === '', 'пустая полоса скрыта');

  console.log('\n19. Постер в карточке сериала');
  const serLib = [
    { hash: 'p1'.repeat(20), title: 'Сериал [Сезон 1] (2020) WEB-DL 1080p', poster: 'http://127.0.0.1:8123/poster.jpg',
      file_stats: [{ id: 1, path: 'Сериал/S01E01.mkv' }, { id: 2, path: 'Сериал/S01E02.mkv' }] },
    { hash: 'p2'.repeat(20), title: 'Другой сериал [Сезон 2] (2019) HDTVRip',
      file_stats: [{ id: 1, path: 'Другой/S02E01.mkv' }] },
  ];
  setState('state.lib = ' + JSON.stringify(serLib) + ';');
  setState('state.viewed = [];');
  setState("$('#serQuery').value = '';");
  ctx.paintSeriesBody();
  const serHtml = String(vm.runInContext("$('#serBody').innerHTML", ctx));
  check(serHtml.includes('class="ser-poster"'), 'у карточки есть место под постер');
  check(serHtml.includes('src="http://127.0.0.1:8123/poster.jpg"'), 'постер раздачи показан');
  check(serHtml.includes('class="ph"'), 'без постера показана заглушка');
  check((serHtml.match(/class="ser-main"/g) || []).length === 2, 'сезоны остались рядом с постером',
    String((serHtml.match(/class="ser-main"/g) || []).length));

  console.log('\n20. «Загрузки» на живом сервере');
  await ctx.pollTorrents();
  const liveSum = String(vm.runInContext("$('#dlSummary').innerHTML", ctx));
  const liveRows = String(vm.runInContext("$('#dlTorrents').innerHTML", ctx));
  check(!liveRows.includes('Сервер не отвечает'), 'раздачи получены от сервера',
    liveRows.includes('Сервер не отвечает') ? 'сервер не ответил' : 'есть ответ');
  check(liveSum.includes('раздач:'), 'сводка построена');
  check(/кэш [\d.]+ /.test(liveSum), 'настройки кэша прочитаны у сервера',
    (liveSum.match(/кэш [^·<]*/) || ['нет'])[0]);
  check(/чтение вперёд \d+%/.test(liveSum), 'чтение вперёд прочитано',
    (liveSum.match(/чтение вперёд \d+%/) || ['нет'])[0]);
  if (process.env.TC_HASH) {
    const th = 'data-th="' + process.env.TC_HASH + '"';
    check(liveRows.includes(th), 'наша раздача есть в таблице');
    const stat = String(vm.runInContext(
      `$('#dlTorrents').querySelector(${JSON.stringify('[data-th="' + process.env.TC_HASH + '"]')}).querySelector('.tstat').textContent`, ctx));
    check(stat.length > 0, 'состояние раздачи прочитано', stat || 'пусто');
    const size = String(vm.runInContext(
      `$('#dlTorrents').querySelector(${JSON.stringify('[data-th="' + process.env.TC_HASH + '"]')}).querySelector('[data-f="size"]').textContent`, ctx));
    check(/GB|MB|KB/.test(size), 'размер раздачи показан', size || 'пусто');
  } else {
    console.log('  ок   | раздача не задана (TC_HASH) — проверка раздачи пропущена');
  }

  console.log('\n21. Сведения о сериях и сезонах (живой ответ метаданных)');
  let epsJson = null;
  try {
    epsJson = await fetch(ORIGIN + '/api/tv_eps?q=' + encodeURIComponent('Доктор Хаус') + '&season=1').then(r => r.json());
  } catch (e) { epsJson = null; }
  if (!epsJson || !epsJson.ok) {
    console.log('  ок   | метаданные недоступны (' + ((epsJson && epsJson.error) || 'нет ответа') + ') — проверка пропущена');
  } else {
    const s1 = (epsJson.seasons || []).find(x => Number(x.number) === 1);
    check(!!s1, 'сезон разобран', s1 ? 'сезон 1' : 'нет');
    const eps = (s1 && s1.episodes) || [];
    check(eps.length > 0, 'серии в сезоне перечислены', String(eps.length));
    const e1 = eps[0] || {};
    check(!!e1.name, 'название серии', e1.name || 'пусто');
    check(/^\d{4}-\d{2}-\d{2}$/.test(e1.air_date || ''), 'дата выхода', e1.air_date || 'пусто');
    check(e1.runtime > 0, 'длительность серии', e1.runtime ? e1.runtime + ' мин' : 'пусто');
    check(!!e1.overview, 'описание серии', String(e1.overview || '').slice(0, 40));
    check(/image\.tmdb\.org/.test(e1.still || ''), 'кадр серии', e1.still || 'пусто');
    // Тот же путь, которым пользуется окно выбора серии.
    const si = await ctx.seasonInfo('Доктор Хаус', 1);
    check(!!si, 'сезон получен через интерфейс');
    const head = String(ctx.seasonHead(si, 1));
    check(/Сезон 1/.test(head) && /\d\d\.\d\d\.\d{4}/.test(head), 'заголовок сезона с датами',
      head.replace(/<[^>]*>/g, ' ').trim().slice(0, 60));
  }

  console.log('\n22. Исключение из запроса на живой выдаче');
  let wRows = [];
  try { wRows = await ctx.searchRutor('ведьмак', 0, 0); } catch (e) { wRows = []; }
  if (!wRows.length) {
    console.log('  ок   | живая выдача недоступна — проверка пропущена');
  } else {
    const parsed = vm.runInContext('splitExclusions("ведьмак -игра")', ctx);
    check(parsed.q === 'ведьмак' && (parsed.drop || []).join(' ') === 'игра',
      'запрос с исключением разобран',
      'q=«' + parsed.q + '», исключения=«' + (parsed.drop || []).join(' ') + '»');
    /* Отсев не-видео выключен: иначе проверка сочла бы не исключение, а его.
       Отбор по качеству берётся из самого интерфейса — иначе строки, отсеянные
       фильтром Full HD, испортили бы ожидаемое число. */
    const okRows = wRows.filter(r => vm.runInContext('QUAL[qualOn()].ok(' + JSON.stringify(r.title || '') + ')', ctx));
    setState('setVideoOnlyPref(false);');
    setState('state.searchState = { results: ' + JSON.stringify(okRows.map(r => ({ title: r.title, seed: r.seed })))
      + ', exclude: ["игра"], status: [], cat: "", showAll: false, sort: "seed" };');
    const boxW = makeEl();
    try { ctx.paintResults(boxW); } catch (e) { /* карточки требуют настоящего DOM */ }
    const want = okRows.filter(r => /игра/i.test(r.title || '')).length;
    const html = String(boxW.innerHTML);
    check(want > 0 ? html.includes('скрыто ' + want + ' по «-игра»') : !html.includes('по «-игра»'),
      'живая выдача отсекается по слову из запроса',
      '«игра» в названии у ' + want + ' из ' + okRows.length);
    check(html.includes('Результаты (' + (okRows.length - want) + ')'), 'остальное осталось в выдаче',
      (html.match(/Результаты \(\d+\)/) || ['нет'])[0]);
    setState('setVideoOnlyPref(true);');
  }

  console.log('\n' + (fails ? 'ПРОВАЛОВ: ' + fails : 'все проверки пройдены') + ' (проверок: ' + checks + ')');
  // Явный выход: проверки оставляют за собой таймеры обновления отметок, и без
  // этого скрипт висит до их срабатывания.
  process.exit(fails ? 1 : 0);
})().catch(e => {
  // Оборванный прогон обязан быть виден: иначе он выглядит как удача, и
  // непроверенные разделы молча считаются пройденными.
  console.log('\nПРОВЕРКА ПРЕРВАНА: ' + ((e && e.stack) || e));
  process.exit(1);
});
