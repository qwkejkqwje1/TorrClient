// Проверка логики сериалов и панели подгрузки — без сети и без демона.
//
// Живая проверка интерфейса (tools/check-ui.cjs) ходит на трекер и в демон, и
// поэтому доказательством служить не может: без демона она падает по любой
// причине, и откат правки выглядел бы доказанным. Здесь всё замкнуто на себя,
// поэтому каждый отказ указывает ровно на то поведение, которое проверяется, и
// правку можно доказать откатом (tools/prove-fix.py).
//
// Запуск из корня проекта:  node tools/check-series.js
//
// Файл интерфейса можно подменить переменной окружения TC_APP_JS — так
// проверяется кандидат (например, результат массовой правки) до того, как он
// займёт место рабочего web/app.js:
//     TC_APP_JS=C:/tmp/app.try.js node tools/check-series.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const code = fs.readFileSync(process.env.TC_APP_JS || path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

let fails = 0;
const check = (ok, label, detail) => {
  console.log((ok ? '  ок   ' : '  ПЛОХО') + ' | ' + label + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
};

/* Заглушка узла: панель наполняется по частям, поэтому один и тот же запрос
   должен отдавать один и тот же узел — иначе её нечем проверить. */
const node = () => {
  const kids = {};
  return {
    style: {}, dataset: {}, className: '', innerHTML: '', textContent: '', value: '', children: [],
    removed: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; },
    setAttribute() {}, getAttribute: () => null, click() {},
    querySelector(sel) { if (!kids[sel]) kids[sel] = node(); return kids[sel]; },
    querySelectorAll: () => [],
  };
};

let cleared = 0;
const store = new Map();
/* Верхние узлы запоминаются так же, как вложенные: код, который наполняет окно
   по частям, иначе писал бы в один узел, а проверка читала бы другой. */
const topEls = new Map();
const top = s => { if (!topEls.has(s)) topEls.set(s, node()); return topEls.get(s); };
const sandbox = {
  console, setTimeout, clearTimeout,
  setInterval: () => 1,
  clearInterval: () => { cleared++; },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  location: { href: 'http://127.0.0.1:8123/', origin: 'http://127.0.0.1:8123', replace() {}, hash: '', pathname: '/' },
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  document: {
    querySelector: top, querySelectorAll: () => [], getElementById: top,
    createElement: () => node(), addEventListener() {}, body: node(), documentElement: node(),
  },
  addEventListener() {}, removeEventListener() {}, alert() {},
  requestAnimationFrame: cb => setTimeout(cb, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code, ctx, { filename: 'app.js' });
} catch (e) {
  console.log('загрузка app.js прервана на: ' + String(e.message).split('\n')[0]);
}

const call = (expr) => vm.runInContext(expr, ctx);

console.log('\n1. Сезон из названия раздачи');
const cases = [
  ['Сериал [Сезон 3] (2020) BDRip', 3, '«Сезон 3»'],
  ['Доктор Хаус (2004) [1-8 сезон] HDTVRip', 1, '«[1-8 сезон]»'],
  ['Сериал 5 сезон 1080p', 5, '«5 сезон»'],
  ['Кухня (2012) [1080p] 6 сезон', 6, '«6 сезон» в конце названия'],
  ['Сериал сезон 1080p', 0, '«сезон» без номера — сезона нет'],
  ['Сериал S07 WEB-DL', 7, '«S07»'],
  ['Матрица (1999) 1080p', 0, 'у фильма сезона нет'],
  ['Сезон 1-8', 1, '«Сезон 1-8» — начало диапазона'],
];
for (const [title, want, label] of cases) {
  const got = call('seasonOf(' + JSON.stringify(title) + ')');
  check(got === want, label, 'получилось ' + got + ', ждали ' + want);
}

console.log('\n2. Раздача с диапазоном сезонов попадает во вкладку «Сериалы»');
const info = call("JSON.stringify(seriesInfo('Доктор Хаус (2004) [1-8 сезон]'))");
check(info === '{"s":1,"e":0,"e2":0}', 'разбор названия раздачи', info);
check(call("isSeries('Доктор Хаус (2004) [1-8 сезон] HDTVRip')") === true, 'раздача считается сериалом');
check(call("isSeries('Матрица (1999) 1080p')") === false, 'фильм сериалом не считается');

console.log('\n3. Панель подгрузки: новая закрывает прежнюю');
const first = ctx.progressPanel({ hash: 'aa', title: 'Первая' }, { id: 1, path: 'S01E01.mkv' });
check(call('activePanel !== null') === true, 'текущая панель записана');
check(cleared === 0, 'до второго запуска прежнюю закрывать нечего', 'снято ' + cleared);
const second = ctx.progressPanel({ hash: 'aa', title: 'Вторая' }, { id: 2, path: 'S01E02.mkv' });
check(cleared === 1, 'вторая панель сняла первую', 'снято ' + cleared);
first.stop();
check(cleared === 1, 'повторное закрытие первой ничего не снимает', 'снято ' + cleared);
second.stop();
check(call('activePanel === null') === true, 'после закрытия текущей панели нет');

console.log('\n4. «Продолжить просмотр» собирается по отметкам, а не по порядку файлов');
const lib = [
  { hash: 'h1', title: 'Сериал [Сезон 1] (2020) WEB-DL', file_stats: [{ id: 1, path: 'Сериал/S01E01.mkv' }, { id: 2, path: 'Сериал/S01E02.mkv' }] },
  { hash: 'h2', title: 'Фильм (2019) BDRip', file_stats: [{ id: 1, path: 'Фильм.mkv' }] },
  { hash: 'h3', title: 'Второй фильм (2021)', file_stats: [{ id: 1, path: 'Второй.mkv' }] },
];
const viewed = [
  { hash: 'h1', file_index: 2, timecode: 600, duration: 2700, updated: 200 },
  { hash: 'h1', file_index: 1, timecode: 0, duration: 2700, done: true, updated: 300 },
  { hash: 'h2', file_index: 1, timecode: 1200, duration: 5400, updated: 400 },
  { hash: 'h3', file_index: 1, timecode: 0, duration: 2700, updated: 800 },
  { hash: 'h9', file_index: 1, timecode: 100, duration: 600, updated: 500 },
  { hash: 'h1', file_index: 9, timecode: 100, duration: 600, updated: 600 },
];
call('state.lib = ' + JSON.stringify(lib) + ';');
call('state.viewed = ' + JSON.stringify(viewed) + ';');
const got = call("continueItems().map(x => x.t.hash + ':' + x.f.id).join(',')");
check(got === 'h2:1,h1:2', 'недосмотренные, свежие сверху', got || 'пусто');
check(!got.includes('h9'), 'раздача не из библиотеки не показывается');
check(!got.includes('h1:1'), 'досмотренная серия не показывается');
check(!got.includes('h3'), 'нулевая позиция не показывается');
check(!got.includes('h1:9'), 'отметка на исчезнувший файл не показывается');
const card = call('continueCard(continueItems()[0])');
check(card.includes('▶ Продолжить'), 'в карточке есть кнопка «Продолжить»');
check(card.includes('data-cont-done'), 'в карточке есть отметка «просмотрено»');
check(/width:22%/.test(card), 'полоса показана по доле просмотра', (card.match(/width:\d+%/) || ['нет'])[0]);
check(card.includes('Фильм.mkv'), 'подпись файла показана');

console.log('\n5. Карточка сериала: постер, а не пустое место');
const serGroup = (poster) => ({
  key: 'сериал',
  items: [{ hash: 'p1'.repeat(20), title: 'Сериал [Сезон 1] (2020) WEB-DL',
    file_stats: [{ id: 1, path: 'Сериал/S01E01.mkv' }], poster }],
});
const withPoster = call('seriesCard(' + JSON.stringify(serGroup('http://p/1.jpg')) + ')');
check(/<img src="http:\/\/p\/1\.jpg"/.test(withPoster), 'постер показан картинкой',
  (withPoster.match(/<img[^>]*>/) || ['нет'])[0]);
check(withPoster.includes('class="ser-poster"'), 'у постера своё место в разметке');
check(withPoster.includes('data-tmdb'), 'в постере есть место для оценки');
const withoutPoster = call('seriesCard(' + JSON.stringify(serGroup('')) + ')');
check(withoutPoster.includes('<svg class="ph"'), 'без постера показана заглушка');
check(!withoutPoster.includes('<img'), 'без постера картинка не выводится');
check(withoutPoster.includes('Серия 1'), 'сезоны и серии остались на месте');

console.log('\n6. Раздел «Загрузки»: подгрузка, кэш и скорость на виду');
call('state.cache = { CacheSize: 67108864, PreloadCache: 50, ReaderReadAHead: 95, ConnectionsLimit: 25 };');
call("dlRowsKey = '';");
const stats = [
  { hash: 's1'.repeat(20), title: 'Раздача с загрузкой', stat: 2, stat_string: 'Подгрузка начала файла',
    torrent_size: 8 * (1 << 30), loaded_size: 2 * (1 << 30), preload_size: 33554432, preloaded_bytes: 8388608,
    download_speed: 2.5 * (1 << 20), upload_speed: 0, connected_seeders: 12, active_peers: 30, bytes_read: 1048576 },
  { hash: 's2'.repeat(20), title: 'Спокойная раздача', stat: 4, stat_string: 'Раздача закрыта',
    torrent_size: 1 << 30, loaded_size: 0, download_speed: 0, connected_seeders: 0, active_peers: 0 },
];
const row = (hash, sel) => String(call(`$('#dlTorrents').querySelector(${JSON.stringify('[data-th="' + hash + '"]')}).querySelector(${JSON.stringify(sel)}).textContent`));
const barWidth = hash => String(call(`$('#dlTorrents').querySelector(${JSON.stringify('[data-th="' + hash + '"]')}).querySelector('[data-f="bar"]').style.width`));
call('paintTorrentRows(' + JSON.stringify(stats) + ');');
const tHtml = String(call("$('#dlTorrents').innerHTML"));
check(tHtml.includes('Раздача с загрузкой'), 'раздача показана в таблице');
check(row(stats[0].hash, '[data-f="dl"]') === '2.5 МБ/с', 'скорость загрузки видна',
  row(stats[0].hash, '[data-f="dl"]'));
check(row(stats[0].hash, '.tstat') === 'Подгрузка начала файла', 'состояние раздачи названо словами',
  row(stats[0].hash, '.tstat'));
check(row(stats[0].hash, '[data-f="peers"]') === '12 / 30', 'сиды и пиры видны',
  row(stats[0].hash, '[data-f="peers"]'));
check(row(stats[0].hash, '[data-f="pre"]') === '8.0 MB из 32.0 MB', 'подгруженное к кэше видно',
  row(stats[0].hash, '[data-f="pre"]'));
check(row(stats[0].hash, '[data-f="read"]') === '1.0 MB', 'прочитанное плеером видно',
  row(stats[0].hash, '[data-f="read"]'));
check(barWidth(stats[0].hash) === '25%', 'полоса подгрузки по доле кэша', barWidth(stats[0].hash));
check(row(stats[1].hash, '[data-f="dl"]') === '—', 'у спокойной раздачи вместо нуля прочерк',
  row(stats[1].hash, '[data-f="dl"]'));
check(tHtml.indexOf('Раздача с загрузкой') < tHtml.indexOf('Спокойная раздача'), 'быстрая раздача выше');

console.log('\n7. Сведения о серии: дата, длительность, описание, кадр');
call('state.viewed = [];');
check(call("fmtAirDate('2019-09-01')") === '01.09.2019', 'дата выхода читается по-русски',
  String(call("fmtAirDate('2019-09-01')")));
check(call("fmtAirDate('')") === '', 'пустая дата остаётся пустой');
const season = {
  number: 2, name: 'Сезон 2', episodes: [
    { number: 1, name: 'Первый', air_date: '2019-09-01', runtime: 52, overview: 'Начало.', still: 'http://s/1.jpg', rating: 8.4 },
    { number: 2, name: 'Второй', air_date: '2020-05-20', runtime: 50, overview: '', still: '', rating: 7.6 },
  ],
};
const head = String(call('seasonHead(' + JSON.stringify(season) + ', 2)'));
check(head.includes('Сезон 2'), 'заголовок называет сезон');
check(head.includes('2 серии'), 'заголовок считает серии', (head.match(/\d+ сери\w*/) || ['нет'])[0]);
check(head.includes('01.09.2019 — 20.05.2020'), 'заголовок показывает даты выхода',
  (head.match(/\d\d\.\d\d\.\d{4}[^<]*/) || ['нет'])[0]);
check(head.includes('8.0 из 10'), 'заголовок показывает среднюю оценку',
  (head.match(/[\d.]+ из 10/) || ['нет'])[0]);
const named = String(call('JSON.stringify(epByName(' + JSON.stringify(season) + '))'));
check(named === '{"1":"Первый","2":"Второй"}', 'названия серий по номерам', named);
const erow = String(call('epRow(' + JSON.stringify({ hash: 'x', title: 'Сериал' }) + ', '
  + JSON.stringify({ id: 7, path: 'Сериал/S02E01.mkv' }) + ', null, 2)'));
check(erow.includes('ep-still'), 'в строке серии есть место под кадр');
check(erow.includes('ep-meta'), 'в строке серии есть место под дату и длительность');
check(erow.includes('ep-over'), 'в строке серии есть место под описание');
check(erow.includes('data-ep-num="1"'), 'номер серии есть на строке',
  (erow.match(/data-ep-num="\d+"/) || ['нет'])[0]);
check(erow.includes('Сезон 2 · Серия 1'), 'подпись серии по-русски');

console.log('\n8. Поиск плееров: видно, где искали');
call("state.scanRoots = []; state.players = [{ key: 'vlc', name: 'VLC', found: true }];");
call('paintScanInfo();');
const noScan = String(call("$('#scanInfo').textContent"));
check(noScan.includes('дисках C:'), 'до поиска сказано, где плееры ищутся', noScan.slice(0, 70));
call('state.scanRoots = ' + JSON.stringify(['C:\\Program Files', 'D:\\']) + ';'
  + " state.players = " + JSON.stringify([{ key: 'vlc', found: true }, { key: 'mpv', found: false }]) + ';');
call('paintScanInfo();');
const scanInfo = String(call("$('#scanInfo').textContent"));
check(scanInfo.includes('Проверено папок: 2'), 'после поиска видно, сколько папок проверено', scanInfo);
check(scanInfo.includes('D:\\'), 'видно сами папки поиска', scanInfo);
check(scanInfo.includes('Найдено плееров: 1'), 'видно, сколько плееров нашлось', scanInfo);

console.log('\n9. Отметки просмотра: перерисовка только при изменении');
call('state.viewed = ' + JSON.stringify([{ hash: 'h1', file_index: 1, timecode: 10 }]) + ';');
const sigPos = String(call('viewedSignature()'));
call('state.viewed = ' + JSON.stringify([{ hash: 'h1', file_index: 1, timecode: 11 }]) + ';');
check(sigPos !== String(call('viewedSignature()')), 'сдвиг позиции меняет подпись отметок', sigPos);
call('state.viewed = ' + JSON.stringify([{ hash: 'h1', file_index: 1, timecode: 11, done: true }]) + ';');
const sigDone = String(call('viewedSignature()'));
check(sigDone !== sigPos, 'досмотр меняет подпись отметок', sigDone);
call('state.viewed = ' + JSON.stringify([{ hash: 'b', file_index: 1 }, { hash: 'a', file_index: 1 }]) + ';');
const sigOne = String(call('viewedSignature()'));
call('state.viewed = ' + JSON.stringify([{ hash: 'a', file_index: 1 }, { hash: 'b', file_index: 1 }]) + ';');
check(sigOne === String(call('viewedSignature()')), 'порядок отметок на подпись не влияет', sigOne);
call('state.viewed = [];');

/* Сводка собирается асинхронно: она спрашивает у сервера настройки кэша. Здесь
   они уже заданы, но ждать ответа всё равно нужно — иначе проверка прочтёт
   разметку до того, как её написали. */
(async () => {
  await ctx.paintCacheCard(stats);
  const sum = String(call("$('#dlSummary').innerHTML"));
  check(sum.includes('раздач: 2'), 'счётчик раздач в сводке');
  check(sum.includes('↓ 2.5 МБ/с'), 'суммарная скорость в сводке');
  check(sum.includes('кэш 64.0 MB'), 'размер кэша сервера показан');
  check(sum.includes('предзагрузка 50% (32.0 MB)'), 'предзагрузка показана процентом и объёмом',
    (sum.match(/предзагрузка[^·<]*/) || ['нет'])[0]);
  check(sum.includes('чтение вперёд 95%'), 'чтение вперёд показано');

  console.log('\n10. Настройки BitTorr: набор «только оперативная память, без следов»');
  const preset = ctx.ramOnlyPreset();
  check(preset.UseDisk === false, 'кэш не пишется на диск', String(preset.UseDisk));
  check(preset.TorrentsSavePath === '', 'папка сохранения пуста', JSON.stringify(preset.TorrentsSavePath));
  check(preset.RemoveCacheOnDrop === true, 'кэш освобождается при снятии раздачи', String(preset.RemoveCacheOnDrop));
  check(preset.DisableUpload === true, 'отдача выключена', String(preset.DisableUpload));
  check(preset.CacheSize === 128 * 1024 * 1024, 'кэш 128 МБ в байтах', String(preset.CacheSize));
  check(preset.PreloadCache === 30, 'предзагрузка 30 %', String(preset.PreloadCache));
  check(preset.TorrentDisconnectTimeout === 15, 'простаивающая раздача снимается через 15 с', String(preset.TorrentDisconnectTimeout));
  check(preset.EnableLPD === false && preset.EnableBonjour === false, 'локальное обнаружение выключено');

  /* Набор не должен тянуть за собой чужие поля. Настройки уходят на сервер
     целиком, а недостающие он обнуляет: лишний ключ в наборе означал бы потерю
     чужого значения — так уже пропадал список трекеров. */
  const strangers = ['TrackersListURL', 'DefaultTrackers', 'TMDBSettings', 'SslCert', 'SslKey', 'EnableRutorSearch'];
  const extra = strangers.filter(k => k in preset);
  check(extra.length === 0, 'набор не трогает список трекеров, ключи SSL и настройки TMDB',
    extra.length ? 'лишние поля: ' + extra.join(', ') : 'лишних полей нет');

  /* Настройки уходят на сервер целиком: частичный набор он обнуляет. Проверка
     стережёт именно это — иначе «оптимизация» отправки одними правками снова
     снесёт список трекеров, как это уже случилось живьём. */
  const base = { TrackersListURL: 'http://tracker.example/announce', CacheSize: 1, EnableRutorSearch: true };
  const merged = ctx.mergeServerSets(base, ctx.ramOnlyPreset());
  check(merged.TrackersListURL === 'http://tracker.example/announce', 'при отправке набора список трекеров сохраняется', String(merged.TrackersListURL));
  check(merged.EnableRutorSearch === true, 'посторонние переключатели сохраняются', String(merged.EnableRutorSearch));
  check(merged.CacheSize === 128 * 1024 * 1024, 'правки набора перекрывают прочитанное', String(merged.CacheSize));
  check('TorrentsSavePath' in merged && merged.TorrentsSavePath === '', 'поля из набора в отправке есть');

  /* Панель наполняется настоящей функцией, а сервер подменяется заглушкой:
     без неё проверить нечего — заглушка fetch по умолчанию отдаёт пустой объект. */
  const fakeSets = {
    CacheSize: 67108864, PreloadCache: 50, ReaderReadAHead: 95, ConnectionsLimit: 25,
    RemoveCacheOnDrop: false, UseDisk: false, TorrentsSavePath: '', EnableLPD: true,
  };
  const prevFetch = sandbox.fetch;
  sandbox.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(fakeSets),
    json: async () => fakeSets,
  });
  try { await ctx.renderServerPane('settings'); } finally { sandbox.fetch = prevFetch; }
  const paneHtml = String(top('#serverPane').innerHTML);
  check(paneHtml.includes('id="ssPreset"'), 'в панели есть кнопка набора');
  check(paneHtml.includes('data-k="RemoveCacheOnDrop"'), 'в панели есть поле «освобождать кэш при снятии раздачи»');
  check(paneHtml.includes('data-k="ReaderReadAHead"'), 'чтение вперёд под настоящим именем сервера');
  check(!paneHtml.includes('ReadAheadBytes'), 'выдуманного поля ReadAheadBytes в панели нет');
  check(!paneHtml.includes('RemoteDownloads'), 'выдуманного поля RemoteDownloads в панели нет');
  check(/data-k="CacheSize"[^>]*value="64"/.test(paneHtml), 'размер кэша показан в мегабайтах',
    (paneHtml.match(/data-k="CacheSize"[^>]*/) || ['нет'])[0]);

  console.log('\n11. Папки: отказ видно, и он исправим одним нажатием');
  /* Путь на несуществующем диске выглядит в настройках правильным: пока отказ не
     показан рядом с полем, о нём узнают по пустым загрузкам. Живьём это уже
     случилось — в настройках стояла папка на диске D:, которого в машине нет. */
  call('state.view = "library";');
  call('state.hello = { watch_folder: "D:\\\\TC\\\\watch", download_folder: "D:\\\\TC\\\\downloads", cache_folder: "D:\\\\TC\\\\cache", data_folder: "D:\\\\TC\\\\data" };');
  call('state.folders = null;');
  check(String(call("folderNoticeHTML('watch')")) === '', 'без сведений о папках предупреждения нет',
    JSON.stringify(String(call("folderNoticeHTML('watch')"))));

  const folders = {
    watch: { path: 'D:\\TC\\watch', ok: false, reason: 'mkdir D:\\TC\\watch: The system cannot find the path specified.' },
    downloads: { path: 'D:\\TC\\downloads', ok: true },
    cache: { path: 'D:\\TC\\cache', ok: true },
    data: { path: 'D:\\TC\\data', ok: true },
    default_watch: 'Y:\\TorrClientPortableX\\watch',
    default_downloads: 'Y:\\TorrClientPortableX\\downloads',
    default_cache: 'Y:\\TorrClientPortableX',
    default_data: 'Y:\\TorrClientPortableX',
  };
  call('state.folders = ' + JSON.stringify(folders) + ';');

  const warn = String(call("folderNoticeHTML('watch')"));
  check(warn.includes('Папка недоступна'), 'недоступная папка показана предупреждением');
  check(warn.includes('D:\\TC\\watch'), 'в предупреждении виден сам путь');
  check(warn.includes('cannot find the path'), 'в предупреждении видна причина отказа');
  check(warn.includes('Y:\\TorrClientPortableX\\watch'), 'предложена папка рядом с программой',
    (warn.match(/Y:\\[^<]*/) || ['нет'])[0]);
  check(warn.includes('data-folder-fix="watch"'), 'есть кнопка исправления');
  check(String(call("folderNoticeHTML('downloads')")) === '', 'исправная папка предупреждения не даёт');

  /* В теле запроса должна быть только сломанная папка: исправную соседнюю
     настройку трогать не за что — заодно переписанная, она выглядела бы как
     «исправление», а на деле была бы потерей настройки. */
  const fixDl = call("folderFixBody('downloads')");
  check(fixDl && fixDl.action === 'dirs' && fixDl.download_folder === 'Y:\\TorrClientPortableX\\downloads',
    'кнопка ставит папку загрузок рядом с программой', JSON.stringify(fixDl));
  check(fixDl && !('watch_folder' in fixDl), 'исправная папка наблюдения в запросе не упоминается', JSON.stringify(fixDl));
  const fixW = call("folderFixBody('watch')");
  check(fixW && fixW.watch_folder === 'Y:\\TorrClientPortableX\\watch' && !('download_folder' in fixW),
    'кнопка для наблюдения трогает только свою папку', JSON.stringify(fixW));

  /* Кэш и постоянные данные — такие же папки, и отказ на них виден так же.
     Кэш можно указать на диск, который очищается при перезагрузке; отметки
     просмотра и избранное — нельзя, и путать эти папки нельзя тоже. */
  call('state.folders = ' + JSON.stringify(Object.assign({}, folders, {
    cache: { path: 'R:\\cache', ok: false, reason: 'диск не найден' },
  })) + ';');
  const warnCache = String(call("folderNoticeHTML('cache')"));
  check(warnCache.includes('R:\\cache'), 'отказ папки кэша виден вместе с путём', warnCache.slice(0, 80));
  check(warnCache.includes('диск не найден'), 'у отказа папки кэша названа причина');
  check(warnCache.includes('data-folder-fix="cache"'), 'у отказа папки кэша своя кнопка исправления');
  check(warnCache.includes('Y:\\TorrClientPortableX<') || warnCache.includes('Y:\\TorrClientPortableX</span>'),
    'для кэша предложен каталог программы, а не выдуманный подкаталог', warnCache.slice(0, 120));
  check(String(call("folderNoticeHTML('data')")) === '', 'исправная папка постоянных данных молчит');
  const fixCache = call("folderFixBody('cache')");
  check(fixCache && fixCache.cache_folder === 'Y:\\TorrClientPortableX' && !('data_folder' in fixCache),
    'кнопка кэша трогает только папку кэша', JSON.stringify(fixCache));
  const fixData = call("folderFixBody('data')");
  check(fixData && fixData.data_folder === 'Y:\\TorrClientPortableX' && !('cache_folder' in fixData),
    'кнопка постоянных данных трогает только свою папку', JSON.stringify(fixData));
  call('state.folders = ' + JSON.stringify(folders) + ';');

  /* Панели наполняются настоящими функциями: предупреждение должно стоять там,
     где задаётся путь, а не только существовать отдельной функцией. */
  const setRoot = node();
  ctx.renderSettings(setRoot);
  const setHtml = String(setRoot.innerHTML);
  check(setHtml.includes('Папка недоступна'), 'во вкладке «Настройки» отказ видно');
  check(setHtml.includes('Y:\\TorrClientPortableX\\watch'), 'во вкладке «Настройки» есть предложение исправить');
  check(setHtml.includes('id="cfPath"') && setHtml.includes('D:\\TC\\cache'), 'в настройках есть поле папки кэша');
  check(setHtml.includes('id="dfPath"') && setHtml.includes('D:\\TC\\data'), 'в настройках есть поле постоянных данных');

  /* Список загрузок спрашивается у демона при отрисовке, поэтому на время
     отрисовки ответ подменяется: пустой ответ уронил бы отрисовку на разборе
     заданий, и проверка читала бы не то, что пишет панель. */
  const prevDlFetch = sandbox.fetch;
  const dlAnswer = async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({ jobs: [], folder: 'D:\\TC\\downloads' }) });
  sandbox.fetch = dlAnswer;
  const dlRoot = node();
  try { ctx.renderDownloads(dlRoot); } finally { sandbox.fetch = prevDlFetch; }
  check(!String(dlRoot.innerHTML).includes('Папка недоступна'), 'в «Загрузках» исправная папка молчит');

  const brokenDl = Object.assign({}, folders, { downloads: { path: 'D:\\TC\\downloads', ok: false, reason: 'отказ в доступе' } });
  call('state.folders = ' + JSON.stringify(brokenDl) + ';');
  const dlRoot2 = node();
  sandbox.fetch = dlAnswer;
  try { ctx.renderDownloads(dlRoot2); } finally { sandbox.fetch = prevDlFetch; }
  check(String(dlRoot2.innerHTML).includes('Папка недоступна'), 'во вкладке «Загрузки» отказ видно');
  check(String(dlRoot2.innerHTML).includes('Y:\\TorrClientPortableX\\downloads'), 'в «Загрузках» предложена своя папка');

  /* Ответ без разбора папок — это отсутствие сведений, а не отказ: иначе
     предупреждение висело бы на исправных настройках. */
  sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) });
  try { await ctx.refreshFolders(); } finally { sandbox.fetch = prevDlFetch; }
  check(String(call('state.folders')) === 'null', 'ответ без разбора папок не выдаётся за отказ', String(call('state.folders')));
  check(String(call("folderNoticeHTML('watch')")) === '', 'после такого ответа предупреждения нет');

  console.log('\n12. Поиск: игры, софт и книги не попадают в выдачу фильмов');

  /* Поиск по умолчанию идёт по всем категориям трекера (cat=0), поэтому на
     запрос «ведьмак» приходят и сериал, и одноимённая игра. Первые четыре строки
     — ловушки: отсев по одному слову «игра» выбросил бы половину каталога. */
  const nvCases = [
    ['Игра престолов / Game of Thrones [S01] (2011) WEB-DL 1080p', '', '«Игра престолов» — сериал, а не игра'],
    ['Голодные игры / The Hunger Games (2012) BDRip 1080p', '', '«Голодные игры» — фильм'],
    ['Игры разума / A Beautiful Mind (2001) 1080p', '', '«Игры разума» — фильм'],
    ['Матрица: Перезагрузка / The Matrix Reloaded (2003) 1080p', '', '«Reloaded» в названии фильма'],
    ['Ведьмак 3: Дикая Охота / The Witcher 3: Wild Hunt [v 1.32 + DLCs] (2015) PC | RePack от xatab', 'игра', 'перепаковка с версией'],
    ['Cyberpunk 2077 [v 2.1] (2023) PC | RePack от FitGirl', 'игра', 'перепаковщик FitGirl'],
    ['GTA V [v 1.0.2944] (2013) PC | SteamRip', 'игра', 'SteamRip'],
    ['S.T.A.L.K.E.R.: Тень Чернобыля (2007) PC | RePack от R.G. Механики', 'игра', 'R.G. Механики'],
    ['The Last of Us Part I (2023) PlayStation 5 | DODI', 'игра', 'игровая платформа'],
    ['Windows 10 Pro [v 22H2] (2023) | RUS | x64', 'софт', 'разрядность x64'],
    ['Adobe Photoshop 2024 v25.9.1 Portable', 'софт', 'portable-сборка'],
    ['Microsoft Office 2021 Pro Plus + Активатор (2022)', 'софт', 'активатор'],
    ['Дюна / Dune (Фрэнк Герберт) [fb2] (1965)', 'книга', 'формат fb2'],
    ['Аудиокнига: Метро 2033 (Д. Глуховский) MP3', 'книга', 'аудиокнига'],
    ['Анджей Сапковский - Ведьмак. Перекрёсток воронов (2025) MP3', 'книга', 'аудиокнига без слова «книга»'],
    ['Гоблин, Каин - Тёмный ведьмак 1. Морозов (2024) МР3', 'книга', 'МР3 кириллицей'],
    ['Джозеф Дилейни - Ученик Ведьмака [Книга 1-4] (2025-2026) MP3', 'книга', 'счётчик книг в скобках'],
    ['Матрица (1999) DVDRip | MP3', '', 'у старого DVDRip звук MP3 — это фильм'],
  ];
  for (const [title, want, label] of nvCases) {
    const got = call('nonVideoKind(' + JSON.stringify(title) + ')');
    check(got === want, label, 'получилось «' + got + '», ждали «' + want + '»');
  }

  const sp = call('splitNonVideo([{title:"Матрица (1999) 1080p"},{title:"Counter-Strike 2 (2023) PC | RePack"},{title:"Игра престолов (2011) 1080p"}])');
  check(sp.keep.length === 2, 'видео остаётся в выдаче', String(sp.keep.length));
  check(sp.drop.length === 1, 'игра уходит в скрытые', String(sp.drop.length));
  check(sp.keep.length + sp.drop.length === 3, 'скрытое откладывается, а не выбрасывается');
  check(call('splitNonVideo([]).keep.length') === 0, 'пустая выдача не ломает отсев');
  check(call('splitNonVideo([null]).drop.length') === 0, 'пустая строка выдачи не считается не-видео');

  /* Выбрав «Игры», пользователь просит именно их: отсев уничтожил бы выдачу. */
  call('state.searchState.showAll = false;');
  call('$("#searchCat").value = "";');
  check(call('videoOnlyOn()') === true, 'при «всех категориях» не-видео скрывается');
  call('$("#searchCat").value = "игры";');
  check(call('videoOnlyOn()') === false, 'выбрав «Игры», пользователь их видит');
  call('$("#searchCat").value = "софт";');
  check(call('videoOnlyOn()') === false, 'выбрав «Софт», софт не скрывается');
  call('$("#searchCat").value = "фильм";');
  check(call('videoOnlyOn()') === true, 'в категории «Фильмы» отсев работает');
  call('$("#searchCat").value = "";');
  call('state.searchState.showAll = true;');
  check(call('videoOnlyOn()') === false, '«показать всё» снимает отсев');
  call('state.searchState.showAll = false;');

  /* Настройка запоминается: иначе отсев приходится снимать каждым поиском, а
     игра или софт иногда и есть цель поиска. */
  call('setVideoOnlyPref(true);');
  check(call('videoOnlyPref()') === true, 'по умолчанию «только видео» включено');
  check(call('videoOnlyOn()') === true, 'включённая настройка скрывает не-видео');
  call('setVideoOnlyPref(false);');
  check(call('videoOnlyOn()') === false, 'выключенная настройка показывает всё, что нашлось');
  call('$("#searchCat").value = "игры";');
  check(call('videoOnlyOn()') === false, 'выключенная настройка не ломает категорию «Игры»');
  call('$("#searchCat").value = "";');
  call('setVideoOnlyPref(true);');
  check(call('videoOnlyOn()') === true, 'настройка возвращается');

  /* Переключатель виден в панели поиска. Выдача и запрос заданы заранее, иначе
     renderSearch сам уйдёт за ТОП-24 и проверит не то. */
  call('state.searchState = { results: [{title:"Матрица (1999) 1080p"}], q: "матрица", cat: "", provider: "rutor", status: [], sort: "seed" };');
  const srRoot = node();
  try { ctx.renderSearch(srRoot).catch(() => {}); } catch (e) { /* панель частично требует настоящего DOM */ }
  check(String(srRoot.innerHTML).includes('searchVid'), 'в панели поиска есть переключатель «только видео»');

  /* Отрисовка: скрытое показывается числом, а не пропадает молча, и возвращается
     по нажатию без повторного запроса к трекеру. */
  call('state.searchState = { results: [{title:"Матрица (1999) 1080p"},{title:"Counter-Strike 2 (2023) PC | RePack"}], status: [], cat: "", showAll: false, sort: "seed" };');
  const boxNV = node();
  try { ctx.paintResults(boxNV); } catch (e) { /* карточки требуют настоящего DOM, нам нужен заголовок */ }
  check(String(boxNV.innerHTML).includes('скрыто 1 не-видео'), 'скрытое показано числом', String(boxNV.innerHTML).slice(0, 120));
  check(String(boxNV.innerHTML).includes('showAllBtn'), 'есть кнопка возврата скрытого');

  call('state.searchState.results = [{title:"Counter-Strike 2 (2023) PC | RePack"}];');
  const boxOnly = node();
  try { ctx.paintResults(boxOnly); } catch (e) { /* см. выше */ }
  check(String(boxOnly.innerHTML).includes('только игры, софт или книги'), 'выдача из одних игр объясняет, а не молчит');

  call('state.searchState.showAll = true;');
  const boxAll = node();
  try { ctx.paintResults(boxAll); } catch (e) { /* см. выше */ }
  check(!String(boxAll.innerHTML).includes('скрыто'), 'по «показать всё» отсев снят');
  check(String(boxAll.innerHTML).includes('Counter-Strike'), 'и сама раздача вернулась на место');

  /* ТОП-24 приходит полным блоком суток — 30 раздач, а фильтр качества, включённый
     по умолчанию, оставляет 24. Заголовок обязан называть оба числа и отсев по
     имени фильтра: иначе блок суток читается как «двадцать четыре раздачи», и
     человек ищет несуществующее ограничение в трекере, вместо того чтобы снять
     фильтр. Числа взяты настоящие: так выглядел настоящий ответ rutor.info. */
  const topRows = [];
  for (let i = 0; i < 30; i++) topRows.push({ title: 'Раздача ' + i + ' (2026) WEB-DL 1080p', seed: 300 - i, peer: 10, provider: 'top24' });
  for (let i = 0; i < 6; i++) topRows[i] = { title: 'Передача ' + i + ' (2026) HDTVRip 720p', seed: 200 - i, peer: 5, provider: 'top24' };
  call('state.searchState = { results: ' + JSON.stringify(topRows) + ', status: [], cat: "", showAll: false, sort: "seed" };');
  const boxTop = node();
  try { ctx.paintResults(boxTop); } catch (e) { /* нам нужен заголовок */ }
  const hTop = String(boxTop.innerHTML);
  check(hTop.includes('24 из 30'), 'заголовок называет и показанное, и пришедшее число', hTop.slice(0, 160));
  check(/отсеяно 6[^<]*1080p и выше|отсеяно 6 фильтром/i.test(hTop), 'отсев по качеству назван числом и фильтром', hTop.slice(0, 200));
  check(hTop.includes('anyQualBtn'), 'есть кнопка «показать без фильтра качества»');
  const boxTop2 = node();
  call('state.searchState.showAnyQual = true;');
  try { ctx.paintResults(boxTop2); } catch (e) { /* см. выше */ }
  const hTop2 = String(boxTop2.innerHTML);
  check(hTop2.includes('(30)') && !hTop2.includes('отсеяно'), 'по кнопке виден весь блок суток', hTop2.slice(0, 160));

  console.log('\n13. Запрос с исключением: «ведьмак -игра»');

  /* Исключение не уходит на трекер: rutor ищет фразу целиком, и «ведьмак -игра»
     отдал бы раздачи со словом «игра» в названии. Слова вынимаются из запроса,
     а отсев делается по названию раздачи. */
  const exCases = [
    ['ведьмак -игра', 'ведьмак', 'игра', 'одно исключение'],
    ['ведьмак -игра -репак', 'ведьмак', 'игра репак', 'два исключения'],
    ['Ведьмак -ИГРА', 'Ведьмак', 'игра', 'исключение приводится к нижнему регистру'],
    ['ведьмак', 'ведьмак', '', 'без исключений'],
    ['ведьмак-игра', 'ведьмак-игра', '', 'дефис внутри слова — не исключение'],
    ['-игра', '', 'игра', 'одно лишь исключение — запрос пуст'],
  ];
  for (const [input, wantQ, wantDrop, label] of exCases) {
    const got = call('splitExclusions(' + JSON.stringify(input) + ')');
    const dropStr = (got.drop || []).join(' ');
    check(got.q === wantQ && dropStr === wantDrop, label,
      'получилось q=«' + got.q + '», исключения=«' + dropStr + '»');
  }

  check(call('excludedBy("Ведьмак 3: Дикая Охота (2015) PC | RePack", ["repack"])') === 'repack', 'раздача уходит по слову-исключению');
  check(call('excludedBy("Ведьмак / The Witcher [S04] (2025) WEB-DL 1080p", ["игра"])') === '', 'сериал под исключение не подпадает');
  check(call('excludedBy("что угодно", [])') === '', 'без исключений ничего не отсекается');
  check(call('excludedBy("", ["игра"])') === '', 'пустое название не подпадает под исключение');
  /* Исключение ищется по названию как есть: «репак» кириллицей до латинского
     RePack не дойдёт. Транслит здесь не помощник — «репак» даёт «repak», а в
     названии английское «repack». Латинские перепаковщики ловит отсев
     не-видео, поэтому склеивать две письменности незачем. */
  check(call('excludedBy("Ведьмак 3: Дикая Охота (2015) PC | RePack", ["репак"])') === '', 'исключение кириллицей не ловит латиницу в названии');

  /* Исключение задал сам пользователь, поэтому скрытое надо показывать числом и
     объяснять пустую выдачу — иначе это выглядит как «ничего не найдено».
     Названия взяты так, чтобы отсев не-видео их заведомо не трогал: иначе
     проверка доказала бы не исключение, а фильтр игр. */
  call('state.searchState = { results: [{title:"Матрица (1999) 1080p"},{title:"Ведьмак (2019) [Сезон 2] WEB-DL 1080p"}], exclude: ["сезон"], status: [], cat: "", showAll: false, sort: "seed" };');
  const boxEx = node();
  try { ctx.paintResults(boxEx); } catch (e) { /* карточки требуют настоящего DOM */ }
  check(String(boxEx.innerHTML).includes('скрыто 1 по'), 'скрытое по исключению показано числом');
  check(String(boxEx.innerHTML).includes('-сезон'), 'и видно, по какому слову');

  call('state.searchState.results = [{title:"Ведьмак (2019) [Сезон 2] WEB-DL 1080p"}];');
  const boxExOnly = node();
  try { ctx.paintResults(boxExOnly); } catch (e) { /* см. выше */ }
  check(String(boxExOnly.innerHTML).includes('подпадает под исключение'), 'выдача из одного исключённого объясняет, а не молчит');

  /* «Показать всё» возвращает лишь то, что спрятано по умолчанию. Исключение
     пользователь написал сам, и отменять его той же кнопкой нельзя. */
  call('state.searchState = { results: [{title:"Матрица (1999) 1080p"},{title:"Ведьмак (2019) [Сезон 2] WEB-DL 1080p"}], exclude: ["сезон"], status: [], cat: "", showAll: true, sort: "seed" };');
  const boxExAll = node();
  try { ctx.paintResults(boxExAll); } catch (e) { /* см. выше */ }
  check(String(boxExAll.innerHTML).includes('скрыто 1 по'), '«показать всё» не отменяет исключение из запроса');
  check(!String(boxExAll.innerHTML).includes('не-видео'), 'и не подменяет его отсевом не-видео');

  /* Слово приходит от пользователя и попадает в разметку — обязано экранироваться. */
  call('state.searchState = { results: [{title:"Матрица (1999) 1080p"},{title:"Фильм <b>x</b> (2001)"}], exclude: ["<b>"], status: [], cat: "", showAll: false, sort: "seed" };');
  const boxEsc = node();
  try { ctx.paintResults(boxEsc); } catch (e) { /* см. выше */ }
  check(!String(boxEsc.innerHTML).includes('<b>'), 'слово-исключение не попадает в разметку как тег');

  console.log('\n14. Почему нет постеров');
  /* Разбор случая «постеры сломались»: демон отвечал «не найдено» и на
     незаданный ключ, и на отклонённый, и причина пропажи картинок не
     называлась нигде. Проверяется именно название причины: иначе отказ
     выглядит как «сервис ничего не знает об этом фильме», и искать его
     начинают в разборе ответа и в адресе картинки. */
  call("state.metaError = ''; renderMetaWarn();");
  check(String(top('#metaWarn').textContent) === '', 'без причины предупреждения нет');

  check(call("metaErrText('not found')") === '', 'на «не найдено» предупреждение не выдумывается');
  check(call("metaErrText('tmdb http 500')") === '', 'отказ самого сервиса предупреждением не считается');

  call("noteMetaError('tmdb key not configured')");
  const warnNoKey = String(top('#metaWarn').textContent);
  check(warnNoKey.includes('не задан ключ TMDB'), 'незаданный ключ назван словами', warnNoKey);
  check(warnNoKey.includes('Настроить'), 'и рядом есть куда пойти за исправлением', warnNoKey);

  call("noteMetaError('tmdb key rejected')");
  const warnBadKey = String(top('#metaWarn').textContent);
  check(warnBadKey.includes('отклонён'), 'отклонённый ключ назван отдельно', warnBadKey);

  /* Смена ключа снимает предупреждение: причина исправлена, и висеть дальше
     ему незачем. Отказы, запомненные по прежнему ключу, при этом забываются —
     иначе свежий ключ не дал бы постеров до перезагрузки страницы. */
  call("askedRatings.set('матрица|1999', Promise.resolve(null)); epSeasonCache['хаус|s1'] = null; forgetMetaMisses();");
  check(String(top('#metaWarn').textContent) === '', 'после смены ключа предупреждение снято');
  check(call('state.metaError') === '', 'и причина забыта');
  check(String(call('askedRatings.size')) === '0', 'вопросы, заданные с прежним ключом, забыты');
  check(String(call("Object.keys(epSeasonCache).length")) === '0', 'и запомненные «серий нет» тоже');

  console.log('\n15. Постеры библиотеки: список перезагрузили — постер на месте');
  /* Разбор случая «нет постеров». Причин было две, и обе в интерфейсе.
     Первая: libRatings() вызывался до loadLibrary(), а state.lib в тот момент
     ещё пуст — libRatings выходил на первой же строке, и в библиотеке постеры
     не появлялись вовсе. Вторая: постер лежал прямо в поле плитки, а
     loadLibrary() заменяет state.lib новым массивом — постер исчезал вместе со
     старым. Проверяется вторая причина: постер должен помниться отдельно. */
  call("forgetPosters(); localStorage.removeItem('tc_posters'); state.lib = [];");
  check(call('applyStoredMeta()') === 0, 'в пустом хранилище возвращать нечего');

  const poster = 'https://image.tmdb.org/t/p/w342/kEDbym5htJgDQNenjUtSJxAHysB.jpg';
  call(`rememberPoster(cleanSearchTitle('Ведьмак (2019) [1080p] WEB-DL'), ${JSON.stringify(poster)})`);
  check(String(call('posterStore.size')) === '1', 'постер запомнен по названию с годом');

  call("state.lib = [{ hash: 'aa', title: 'Ведьмак (2019) [1080p] WEB-DL' }];");
  check(call('applyStoredMeta()') === 1, 'постер вернулся на плитку');
  check(call('state.lib[0].poster') === poster, 'и это тот самый адрес');

  call("state.lib = [{ hash: 'aa', title: 'Ведьмак (2019) [1080p] WEB-DL' }];");
  check(call('applyStoredMeta()') === 1, 'и после следующей перезагрузки списка тоже');

  call("state.lib[0].poster = 'https://example.org/own.jpg';");
  check(call('applyStoredMeta()') === 0, 'свой постер запомненным не подменяется');

  call("forgetPoster(cleanSearchTitle('Ведьмак (2019)'))");
  check(String(call('posterStore.size')) === '0', 'снятый постер уходит из хранилища');

  /* Оценки переживают перезапуск окна. Прежде они жили в sessionStorage и
     умирали вместе с ним: после каждого запуска библиотека показывала постеры
     сразу, а оценки спрашивала у TMDB заново — шесть дорожек по десятки
     названий, отсюда «подгружает потихоньку». */
  call("forgetPosters(); ratingStore.clear(); state.lib = [];");
  call(`rememberMeta(cleanSearchTitle('Ведьмак (2019)'), { ok: true, poster: ${JSON.stringify(poster)}, rating: 7.9, imdb: 8.1, imdb_id: 'tt5180504', title: 'Ведьмак' });`);
  check(String(call('posterStore.size')) === '1', 'ответ TMDB лёг одной записью');
  call("state.lib = [{ hash: 'cc', title: 'Ведьмак (2019) 1080p', file_stats: [] }];");
  call('applyStoredMeta()');
  const stored = call('ratingFor(state.lib[0])');
  check(!!stored && stored.rating === 7.9 && stored.imdb === 8.1, 'оценки вернулись из хранилища, без запроса к TMDB');
  const tileStored = String(call('tile(state.lib[0])'));
  check(tileStored.includes('>7.9</span>'), 'плитка рисует оценку TMDB сразу');
  check(tileStored.includes('>8.1</span>'), 'и оценку IMDb рядом');
  check(tileStored.includes(poster), 'вместе с постером');

  /* Ответ без постера или без оценки не должен отменять уже найденное: отказ
     сервиса — не повод забыть то, что нашлось в прошлый раз. */
  call("forgetPosters(); ratingStore.clear();");
  call(`rememberMeta(cleanSearchTitle('Матрица (1999)'), { ok: true, poster: ${JSON.stringify(poster)}, rating: 8.2, imdb_id: 'tt0133093' });`);
  call("rememberMeta(cleanSearchTitle('Матрица (1999)'), { ok: true, rating: 0, title: 'Матрица' });");
  check(call("posterStore.get(posterKey(cleanSearchTitle('Матрица (1999)'))).p") === poster, 'ответ без постера не стирает найденный прежде');
  check(call("posterStore.get(posterKey(cleanSearchTitle('Матрица (1999)'))).r") === 8.2, 'и оценку тоже');
  check(call("posterStore.get(posterKey(cleanSearchTitle('Матрица (1999)'))).d") === 'tt0133093', 'и признак IMDb');

  /* Прежний формат хранилища — одна строка с адресом: окно могло остаться
     открытым с прошлой версией, и её записи обязаны читаться. */
  call("posterStore.clear(); posterStoreLoaded = false; localStorage.setItem('tc_posters', JSON.stringify({ 'матрица|1999': 'https://example.org/old.jpg' })); loadPosterStore();");
  check(call("posterStore.get('матрица|1999').p") === 'https://example.org/old.jpg', 'записи прежнего формата читаются');

  /* Запомненный ответ свежее суток отменяет запрос: демон держит ровно тот же
     ответ в своём кэше (tmdbCacheTTL = 24 ч), и запрос вернул бы его же. Без
     этого сорок плиток библиотеки — это сорок запросов при каждом заходе, и
     оценки снова «подгружаются потихоньку». */
  call("forgetPosters(); askedRatings.clear();");
  call(`rememberMeta(cleanSearchTitle('Матрица (1999)'), { ok: true, poster: ${JSON.stringify(poster)}, rating: 8.2, imdb: 8.7, imdb_id: 'tt0133093', title: 'Матрица' });`);
  check(Number(call("posterStore.get(posterKey(cleanSearchTitle('Матрица (1999)'))).s")) > 0, 'у записи есть отметка времени');
  check(call("storedFresh(cleanSearchTitle('Матрица (1999)')) !== null") === true, 'свежая запись признаётся свежей');

  const realFetch = sandbox.fetch;
  let metaCalls = 0;
  sandbox.fetch = async () => { metaCalls++; return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true, rating: 9.9, title: 'Матрица' }) }; };
  const answered = await call("getRatings(cleanSearchTitle('Матрица (1999)'))");
  check(metaCalls === 0, 'свежая запись отвечает без запроса к сервису');
  check(!!answered && answered.ok === true && answered.rating === 8.2 && answered.imdb === 8.7, 'и отвечает тем, что помнится');

  // Устаревшая запись спрашивается заново — иначе оценка не обновилась бы никогда.
  call("posterStore.get(posterKey(cleanSearchTitle('Матрица (1999)'))).s = Date.now() - 25 * 60 * 60 * 1000;");
  check(call("storedFresh(cleanSearchTitle('Матрица (1999)')) === null") === true, 'запись старше суток свежей не считается');
  metaCalls = 0;
  const refreshed = await call("getRatings(cleanSearchTitle('Матрица (1999)'))");
  sandbox.fetch = realFetch;
  check(metaCalls === 1, 'устаревшая запись спрашивает сервис заново');
  check(!!refreshed && refreshed.rating === 9.9, 'и берёт свежий ответ');
  check(call("posterStore.get(posterKey(cleanSearchTitle('Матрица (1999)'))).p") === poster, 'свежий ответ без постера не стёр найденный прежде');

  // Запись без отметки времени свежей не считается: спросить про неё один раз
  // дешевле, чем доверять неизвестно когда полученному ответу.
  call("forgetPosters(); rememberPoster(cleanSearchTitle('Матрица (1999)'), 'https://example.org/manual.jpg');");
  check(call("storedFresh(cleanSearchTitle('Матрица (1999)')) === null") === true, 'постер, введённый вручную, свежим не отмечается');
  check(call("posterStore.get(posterKey(cleanSearchTitle('Матрица (1999)'))).p") === 'https://example.org/manual.jpg', 'но сам постер запоминается');

  /* Порядок вызовов: список обязан загрузиться раньше, чем спрашиваются
     постеры, иначе запрос уходит при пустом state.lib. Комментарии из среза
     выбрасываются: в них та же причина описана словами, и по тексту комментария
     проверка «нет вызова libRatings» ложно срабатывала бы. */
  const libSrc = code.slice(code.indexOf('async function renderLibrary'), code.indexOf('// refreshLibrary —')).replace(/\/\/[^\n]*/g, '');
  check(!/libRatings\s*\(/.test(libSrc), 'renderLibrary не спрашивает постеры до загрузки списка');
  check(/refreshLibrary\s*\(/.test(libSrc), 'вместо этого зовётся общий refreshLibrary');
  const refSrc = code.slice(code.indexOf('function refreshLibrary'), code.indexOf('/* Paint-first library'));
  check(/loadLibrary\s*\(/.test(refSrc) && /libRatings\s*\(/.test(refSrc), 'refreshLibrary грузит список и только потом спрашивает постеры');
  check(refSrc.indexOf('loadLibrary') < refSrc.indexOf('libRatings'), 'и именно в этом порядке');

  /* Запись в постоянное хранилище делает getRatings — единственное место, которое
     разговаривает с /api/ratings. Через него проходят и поиск, и библиотека,
     поэтому хранилище наполняется ещё до того, как библиотеку открыли. */
  const grSrc = code.slice(code.indexOf('async function getRatings'), code.indexOf('function applyRatingChips'));
  check(/rememberMeta\s*\(/.test(grSrc), 'ответ TMDB уходит в постоянное хранилище из getRatings');
  /* Свежий отказ не должен гасить известную оценку: ответ без оценки — не повод
     забыть то, что нашлось в прошлый раз. */
  const lrSrc = code.slice(code.indexOf('async function libRatings'), code.indexOf('async function bindResult'));
  check(/ratingStore\.get\(/.test(lrSrc), 'при отказе берётся оценка из хранилища, а не пустота');

  /* Место карточки в разметке (data-ix) считается по полной выдаче, а постеры
     искали карточку по месту в показанном списке. На отфильтрованной выдаче
     («Full HD» включён по умолчанию) индексы расходятся, и постер либо не
     находил своей карточки, либо попадал на чужую.

     Место берётся из карты, собранной по полной выдаче один раз: прежде оно
     искалось через base.indexOf внутри прохода по показанным строкам, то есть
     квадратом на большой выдаче. Проверяется и то, и другое: источник места —
     полная выдача, поиск перебором — убран. */
  const epSrc = code.slice(code.indexOf('async function enrichPosters'), code.indexOf('function setPosterImage'));
  check(/enrichPosters\s*\(\s*visible\s*,\s*all\s*\)/.test(epSrc), 'постеры получают и полную выдачу, и показанную');
  check(!/base\.indexOf\(/.test(epSrc), 'место карточки больше не ищется перебором полной выдачи');
  check(/base\.forEach\(\(r,\s*i\)\s*=>/.test(epSrc) && /ixOf\.get\(r\)/.test(epSrc), 'место карточки берётся из карты мест полной выдачи, а не показанной');

  call("state.searchState = { results: [], exclude: [], status: [], cat: '', showAll: false, sort: 'name' };");
  call("state.searchState.results = [{ title: 'Раздача 720p RIP', name: 'Раздача 720p RIP' }, { title: 'Ведьмак (2019) 1080p', name: 'Ведьмак (2019) 1080p' }];");
  call('askedRatings.clear();');
  const wasFetch = sandbox.fetch;
  sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ ok: true, poster, rating: 8.1, title: 'Ведьмак' }) });
  await call('enrichPosters([state.searchState.results[1]], state.searchState.results)');
  sandbox.fetch = wasFetch;
  check(topEls.has('.result[data-ix="1"] .result-poster'), 'постер достаётся карточке по её месту в полной выдаче');
  check(!topEls.has('.result[data-ix="0"] .result-poster'), 'и не достаётся чужой карточке');

  /* Оценки держатся рядом с постерами, а не в разметке: после подгрузки постеров
     плитка перерисовывается целиком, и чипы, поставленные прямо в DOM, пропадали
     бы вместе со старой разметкой. Проверяется, что плитка рисует оценку сама. */
  call("ratingStore.clear(); state.lib = [{ hash: 'bb', title: 'Ведьмак (2019) 1080p', file_stats: [] }];");
  const tileBare = String(call('tile(state.lib[0])'));
  check(tileBare.includes('data-tmdb hidden'), 'без оценки чип TMDB скрыт');
  check(tileBare.includes('data-imdb hidden'), 'и чип IMDb тоже');

  call("ratingStore.set(posterKey(cleanSearchTitle('Ведьмак (2019)')), { ok: true, rating: 8.1, imdb: 7.9 });");
  const tileRated = String(call('tile(state.lib[0])'));
  check(tileRated.includes('>8.1</span>'), 'оценка TMDB видна в разметке плитки сразу');
  check(tileRated.includes('>7.9</span>'), 'и оценка IMDb рядом с ней');
  check(!tileRated.includes('data-tmdb hidden'), 'скрытым чип после ответа не остаётся');

  console.log('\n16. ТОП-24 не режется по числу строк');

  /* «24» в названии кнопки — это часы, а не количество раздач. Блок суток на
     живой странице rutor содержит ровно 30 строк, и прежняя обрезка до 24
     молча выбрасывала последние шесть. Проверяется на тридцати строках: список
     должен дойти до конца, а заголовок — назвать число. */
  const top30 = [];
  for (let i = 1; i <= 30; i++) {
    top30.push({
      title: 'Раздача ' + i + ' (2026) 1080p', size: '1 GB', seed: 100 - i, peer: i,
      link: 'http://rutor.info/torrent/' + i, hash: 'h' + i, magnet: 'magnet:?xt=urn:btih:' + i,
    });
  }
  const wasTopFetch = sandbox.fetch;
  sandbox.fetch = async () => ({
    ok: true, status: 200, text: async () => '',
    json: async () => ({ ok: true, items: top30 }),
  });
  try { await ctx.fetchTop24(); } catch (e) { /* карточки требуют настоящего DOM, нам нужен список */ }
  sandbox.fetch = wasTopFetch;

  check(call('state.searchState.results.length') === 30,
    'показаны все раздачи блока суток, а не 24',
    'в списке ' + call('state.searchState.results.length'));
  check(call('state.searchState.results[29] && state.searchState.results[29].title') === 'Раздача 30 (2026) 1080p',
    'тридцатая раздача не потерялась');

  const topBox = topEls.get('#searchResults');
  const topHTML = String((topBox && topBox.innerHTML) || '');
  check(topHTML.includes('за последние 24 часа (30)'),
    'в заголовке видно, сколько раздач в блоке суток',
    topHTML.slice(0, 90));

  console.log('\n17. Подборки и фильтры библиотеки');

  /* Библиотека на сотни раздач без фильтров нечитаема, а единственного
     «Избранного» мало: разложить по полкам его было нельзя. Проверяется то,
     что нельзя увидеть глазами на живой странице: что фильтр по просмотру
     различает не начатое, начатое и досмотренное (у сериала — по сериям), что
     подборка отбирает ровно свои раздачи и что подборки едут на сервер вместе
     с избранным. */
  call("localStorage.removeItem('tc_colls'); localStorage.setItem('tc_userlist', '[]');" +
    "state.query = ''; state.category = 'all'; state.seen = 'all'; state.coll = '';");
  call(`state.lib = [
    { hash: 'h1', title: 'Фильм один (2020) 1080p', file_stats: [{ id: 1, path: 'Фильм один.mkv' }] },
    { hash: 'h2', title: 'Фильм два (2021) 1080p', file_stats: [{ id: 1, path: 'Фильм два.mkv' }] },
    { hash: 'h3', title: 'Сериал три (2022) 1080p', file_stats: [{ id: 1, path: 's01e01.mkv' }, { id: 2, path: 's01e02.mkv' }] },
  ];`);
  call(`state.viewed = [
    { hash: 'h2', file_index: 1, timecode: 600, duration: 1000, done: false },
    { hash: 'h3', file_index: 1, timecode: 100, duration: 100, done: true },
    { hash: 'h3', file_index: 2, timecode: 100, duration: 100, done: true },
  ];`);

  check(call("watchState(state.lib[0])") === 'new', 'неначатая раздача — «не начато»');
  check(call("watchState(state.lib[1])") === 'started', 'начатая, но не досмотренная — «начато»');
  check(call("watchState(state.lib[2])") === 'done', 'сериал со всеми сериями — «досмотрено»');

  const bySeen = want => call(`state.seen = '${want}'; filterLib().map(t => t.hash).join(',')`);
  check(bySeen('new') === 'h1', 'фильтр «не начато» оставляет не начатое', bySeen('new'));
  check(bySeen('started') === 'h2', 'фильтр «начато» — начатое, но не досмотренное', bySeen('started'));
  check(bySeen('done') === 'h3', 'фильтр «досмотрено» — досмотренное', bySeen('done'));
  call("state.seen = 'all';");
  check(call('filterLib().length') === 3, 'без фильтра показывается всё');

  const cid = call("collCreate('Смотреть вечером')");
  check(call(`collHas('${cid}', 'h1')`) === false, 'новая подборка пустая');
  check(call(`collToggle('${cid}', 'h1')`) === true, 'раздача добавляется в подборку');
  check(call(`collHas('${cid}', 'h1')`) === true, 'и лежит в ней');
  check(call(`collToggle('${cid}', 'h1')`) === false, 'повторное добавление убирает раздачу');
  call(`collToggle('${cid}', 'h1'); collToggle('${cid}', 'h2');`);
  const inColl = call(`state.coll = '${cid}'; filterLib().map(t => t.hash).join(',')`);
  check(inColl === 'h1,h2', 'фильтр по подборке показывает только её раздачи', inColl);
  check(call("state.coll = 'fav'; filterLib().length") === 0, 'пустое избранное даёт пустую выдачу');
  check(call("state.coll = ''; libFiltered()") === false, 'без фильтров сброс не нужен');
  check(call("state.seen = 'new'; libFiltered()") === true, 'с фильтром сброс нужен');

  call("state.seen = 'all'; localStorage.setItem('tc_order', 'progress');");
  call('painting();');
  const orderHTML = String((topEls.get('#libGrid') || {}).innerHTML || '');
  const at = s => orderHTML.indexOf(s);
  check(at('Сериал три') < at('Фильм два') && at('Фильм два') < at('Фильм один') && at('Фильм один') >= 0,
    'сортировка «по просмотру» поднимает начатое выше не начатого',
    orderHTML.slice(0, 60));
  call("localStorage.setItem('tc_order', 'name');");

  check(call('userDataPayload().collections.length') === 1,
    'подборки уходят в /api/userdata вместе с избранным');
  call(`collRemove('${cid}');`);
  check(call('collList().length') === 0, 'подборка удаляется');
  check(call('state.coll') === '', 'удалённая подборка больше не выбрана');

  /* Кэш и постоянные данные в одной папке: очистка кэша уносит подписки и
     отметки просмотра. Проверяются и сравнение путей, и сама плашка. */
  console.log('\nКэш и данные в одной папке');
  call("state.folders = { cache: { path: 'C:\\\\TC', ok: true }, data: { path: 'c:\\\\tc\\\\', ok: true } };");
  check(call('samePath("C:\\\\TC", "c:\\\\tc\\\\")') === true,
    'пути сравниваются как папки: регистр и хвостовой слеш не важны');
  check(call('samePath("C:\\\\TC", "C:\\\\TC\\\\data")') === false,
    'подпапка — не та же папка');
  check(call('samePath("C:\\\\TC", "")') === false,
    'пустой путь не совпадает с заданным');
  const overlap = String(call('folderOverlapHTML()'));
  check(overlap.indexOf('одной папке') >= 0, 'плашка о совпадении папок появляется', overlap.slice(0, 70));
  check(overlap.indexOf('не собрать') >= 0, 'плашка говорит, что пропадёт при очистке');
  call("state.folders = { cache: { path: 'C:\\\\TC\\\\cache', ok: true }, data: { path: 'D:\\\\TC\\\\data', ok: true } };");
  check(String(call('folderOverlapHTML()')) === '', 'при разных папках плашки нет');

  console.log('\nОтчёт о состоянии');
  check(call('typeof showDiagnostics') === 'function', 'функция отчёта на месте');
  check(call('typeof diagFallbackCopy') === 'function', 'запасной путь копирования на месте');
  check(String(call('typeof navigator.clipboard')) !== 'function',
    'в песочнице буфера обмена нет — значит отчёт обязан уметь обойтись без него');

  /* ---------- Torznab ----------
     Проверяется главное: поиск ушёл в свой демон, а не обратно в TorrServer.
     Возврат на прокси выглядел бы рабочим ровно до того дня, когда у человека
     не окажется настроенного EnableTorznabSearch на сервере, — и отказ пришёл
     бы как пустая выдача без внятной причины. */
  console.log('\nTorznab: свой поиск вместо прокси через сервер');
  check(code.indexOf("ts('/torznab/search") < 0, 'прокси /ts/torznab/search больше не используется');
  check(code.indexOf('/api/torznab/search') > 0, 'поиск идёт в свой демон');
  check(code.indexOf('/api/torznab/test') > 0, 'проверка индексатора на месте');
  check(code.indexOf('/api/torznab/sources') > 0, 'список источников на месте');
  check(String(call('SRC_PAGE.torznab')) === '100', 'размер страницы Torznab известен интерфейсу');
  check(code.indexOf('searchTorznab(s.query, s.page + 1)') > 0, 'кнопка «ещё» догружает следующую страницу Torznab');
  check(code.indexOf('moreSources.torznab') > 0, 'источник Torznab попадает в список догружаемых');

  // Разбор по индексаторам: упавший не должен выглядеть как «пусто».
  const tzItem = {
    title: 'Матрица 1999 1080p BluRay', size: '8.6 ГБ', seed: 120, peer: 7,
    magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', link: 'http://x/dl/a.torrent',
  };
  const wasTzFetch = sandbox.fetch;
  let tzUrl = '';
  sandbox.fetch = async (u) => {
    /* Ловим только свой адрес: в песочнице параллельно висят запросы от более
       ранних проверок, и без фильтра сюда попадает чужой /api/ratings. */
    if (String(u).indexOf('torznab') >= 0) tzUrl = String(u);
    return { ok: true, status: 200, json: async () => ({ items: [tzItem], sources: [{ name: 'Джекетт', ok: true, items: 1 }] }) };
  };
  let rows = [];
  try { rows = await call("searchTorznab('матрица', 0)"); } finally { sandbox.fetch = wasTzFetch; }
  check(tzUrl.indexOf('/api/torznab/search') === 0, 'запрос уходит в /api/torznab/search', tzUrl);
  check(tzUrl.indexOf('page=0') > 0, 'номер страницы передаётся', tzUrl);
  check(rows.length === 1 && rows[0]._p === 'torznab', 'раздача разложена по полям');
  check(rows[0] && rows[0].seed === 120, 'сиды доехали до интерфейса');
  check(rows[0] && rows[0].size_bytes > 0, 'размер разобран в байты из строки', String(rows[0] && rows[0].size_bytes));

  // Один индексатор упал, второй ответил: показываем выдачу и говорим про упавший.
  call("state.searchState.tznabOff = null;");
  sandbox.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ items: [tzItem], sources: [{ name: 'Джекетт', ok: true, items: 1 }, { name: 'Prowlarr', ok: false, error: 'индексатор отклонил ключ: код 403' }] }),
  });
  try { rows = await call("searchTorznab('матрица', 0)"); } finally { sandbox.fetch = wasTzFetch; }
  check(rows.length === 1, 'упавший индексатор не выбрасывает выдачу остальных');
  check(String(call('state.searchState.tznabOff')).indexOf('Prowlarr') >= 0,
    'причина по упавшему индексатору названа', String(call('state.searchState.tznabOff')));

  // Упали все: причина обязана дойти до человека, иначе он ищет не там.
  sandbox.fetch = async () => ({ ok: false, status: 502, json: async () => ({ error: 'ни один индексатор не ответил — Prowlarr: индексатор отклонил ключ: код 403' }) });
  let tzErr = '';
  try { await call("searchTorznab('матрица', 0)"); } catch (e) { tzErr = String(e.message || e); }
  finally { sandbox.fetch = wasTzFetch; }
  check(tzErr.indexOf('Prowlarr') >= 0, 'причина по всем индексаторам дошла до интерфейса', tzErr);
  check(tzErr.indexOf('не настроены') >= 0 || tzErr.indexOf('не ответил') >= 0, 'ошибка названа словом, а не кодом', tzErr);

  console.log('\nTorznab: настройки индексаторов');
  check(code.indexOf('id="tzList"') > 0, 'список индексаторов отрисован');
  check(code.indexOf('id="tzTest"') > 0, 'кнопка проверки на месте');
  check(code.indexOf('id="tzAdd"') > 0, 'кнопка добавления на месте');
  check(code.indexOf('id="tzKey"') > 0, 'поле ключа на месте');
  check(code.indexOf('Индексаторы Torznab') > 0, 'карточка настроек подписана');
  // Ключ не должен возвращаться в браузер целиком: он попал бы в буфер обмена
  // вместе с «экспортом» и в отчёт о состоянии.
  check(code.indexOf('key_hint') > 0, 'ключ приходит замаскированным');
  check(code.indexOf('has_key') > 0, 'есть признак «ключ задан»');
  check(code.indexOf('Проверка не удалась') > 0, 'неудачная проверка объясняет причину');
  check(code.indexOf('отвечает') > 0 && code.indexOf(' мс') > 0, 'удачная проверка показывает время ответа');
  // Правка источника не должна обнулять ключ: сервер сам достроит прежний.
  check(code.indexOf('api_key: f.api_key') > 0, 'при отправке ключ не подставляется чужой');

  console.log('\nСерии: название и разметка окна');
  const epName = f => call('epFileName(' + JSON.stringify(f) + ')');
  const nm = [
    ['Тёмная материя - Dark Matter S02 E01 (Тихая жизнь) WEB-DL 1080p (2026).mkv', 'Тихая жизнь', 'название в скобках после номера'],
    ['Show.S02E03.Pilot.1080p.WEB-DL.mkv', 'Pilot', 'точками вместо пробелов'],
    ['Show S02 E04 - The Wall [1080p].mkv', 'The Wall', 'тире, а не скобки'],
    ['Show.S02E02.(2026).1080p.mkv', '', 'год — не название серии'],
    ['Show.S02E02.(1080p).mkv', '', 'разрешение — не название серии'],
    ['Show S02 E05 1080p WEB-DL.mkv', '', 'без скобок названия нет'],
    ['Show.S02E06.1080p.WEB-DL.x264.mkv', '', 'только техника — названия нет'],
    ['Show S02E07 - Sci-Fi Night.mkv', 'Sci-Fi Night', 'дефис внутри названия не рвётся'],
  ];
  nm.forEach(([f, want, why]) => check(epName(f) === want, 'название серии: ' + why, JSON.stringify(epName(f))));
  check(epName('Тёмная материя S02 E01 (Тихая жизнь) WEB-DL 1080p (2026).mkv') === 'Тихая жизнь',
    'название серии читается по-русски');
  // Разметка строки серии обязана попадать в окно разобранной, а не текстом:
  // без raw() шаблон экранирует её, и пользователь видит теги вместо серий.
  check(code.indexOf('${raw(groups.get(sn).map(f => epRow') > 0, 'строки серий вставлены как разметка, а не как текст');
  check(/<span class="epname">\$\{fb \? ' · ' \+ fb : ''\}<\/span>/.test(code), 'в строке серии есть место под название из имени файла');

  console.log('\n' + (fails ? 'ПРОВАЛОВ: ' + fails : 'все проверки пройдены'));
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.log('\nПРОВЕРКА ПРЕРВАНА: ' + ((e && e.stack) || e));
  process.exit(1);
});
