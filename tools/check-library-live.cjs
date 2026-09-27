// Живая приёмка: библиотека показывает постеры и оценки сразу, без запроса к TMDB.
//
// Не доказательство (нужны живой демон и сеть) — приёмка после пересборки. Главное
// здесь то, чего не видит ни одна проверка на заглушках: файл берётся **у самого
// демона**, а не с диска. Именно на этом провалилась итерация 9: правки лежали в
// web/app.js, а окно показывало копию, вшитую в exe при сборке.
//
// Запуск из корня проекта (демон должен быть поднят):
//     node tools/check-library-live.cjs [порт]

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8099', 10);
const BASE = 'http://127.0.0.1:' + PORT;

let fails = 0;
const check = (ok, label, detail) => {
  console.log((ok ? '  ок   ' : '  ПЛОХО') + ' | ' + label + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
};

/* Фоновая отрисовка окна идёт своим ходом и может споткнуться о неполноту
   заглушки. Гасить из-за этого весь прогон нельзя, но и молчать нельзя:
   показываем отдельной строкой, чтобы пробел в заглушке не сошёл за успех. */
process.on('unhandledRejection', e => {
  console.log('  (фон: ' + String((e && e.message) || e).split('\n')[0] + ')');
});

/* Заглушка узла: код наполняет окно по частям, поэтому один и тот же запрос
   обязан отдавать один и тот же узел — иначе проверка читала бы не то, что
   заполнил код. Методы перечислены по тому, что интерфейс действительно
   зовёт: без них фоновая отрисовка окна рвётся и гасит весь прогон. */
const node = () => {
  const kids = {};
  const n = {
    style: {}, dataset: {}, className: '', innerHTML: '', textContent: '', value: '', children: [],
    hidden: false, disabled: false, checked: false, parentNode: null, firstChild: null, nextSibling: null,
    removed: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    click() {}, focus() {}, blur() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    replaceWith() {}, insertBefore() {}, insertAdjacentHTML() {}, append() {}, prepend() {}, before() {}, after() {},
    closest: () => null, matches: () => false, contains: () => false, cloneNode() { return node(); },
    querySelector(sel) { if (!kids[sel]) kids[sel] = node(); return kids[sel]; },
    querySelectorAll: () => [],
  };
  return n;
};
const store = new Map();
const topEls = new Map();
const top = s => { if (!topEls.has(s)) topEls.set(s, node()); return topEls.get(s); };

/* Раздача для TorrServer: только то, что нужно плитке. */
const TORRENTS = [
  { hash: 'a'.repeat(40), title: 'Ведьмак (2019) [1080p] WEB-DL', torrent_size: 1 << 30, file_stats: [] },
  { hash: 'b'.repeat(40), title: 'Матрица (1999) [1080p] BDRip', torrent_size: 2 << 30, file_stats: [] },
];

/* Одна запись уже помнится с прошлого раза и свежая; вторую окно не знает и
   обязано спросить. Так на одном прогоне видно и то, что постер с оценкой
   берутся из хранилища, и то, что незапомненное всё-таки спрашивается. */
const WITCHER_KEY = 'Ведьмак|2019';
const WITCHER_POSTER = 'https://image.tmdb.org/t/p/w342/rY2c2LhN07CRKlAbRaDZxN2XjvK.jpg';

const ratingsCalls = [];
const jsonResp = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });

async function main() {
  // 1. Файл берётся у демона, а не с диска: иначе проверка не поймала бы
  //    устаревшую копию, вшитую в exe.
  let served;
  try {
    const r = await fetch(BASE + '/app.js');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    served = await r.text();
  } catch (e) {
    console.log('демон не отвечает на ' + BASE + '/app.js: ' + e.message);
    console.log('поднимите его: torrclient.exe --port ' + PORT + ' --host 127.0.0.1 --open=false --quiet');
    return 1;
  }
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  console.log('\n1. Демон отдаёт тот же файл, что лежит на диске');
  // length — это символы, а не байты: в файле кириллица, и байтов заметно
  // больше. Для отчёта берём байты, сравниваем по содержимому.
  const bytes = n => Buffer.byteLength(n, 'utf8');
  check(served === onDisk, 'содержимое совпадает байт в байт',
    served === onDisk ? (bytes(served) + ' байт, ' + served.length + ' знаков')
      : ('демон ' + bytes(served) + ', на диске ' + bytes(onDisk)));

  // 2. Окно с прошлого раза: хранилище заполнено, список ещё не загружен.
  store.set('tc_posters', JSON.stringify({
    [WITCHER_KEY]: { p: WITCHER_POSTER, r: 7.889, i: 7.9, d: 'tt5180504', t: 'Ведьмак', s: Date.now() },
  }));

  const realFetch = globalThis.fetch;
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    location: { href: BASE + '/', origin: BASE, replace() {}, hash: '', pathname: '/' },
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
    document: {
      querySelector: top, querySelectorAll: () => [], getElementById: top,
      createElement: () => node(), addEventListener() {}, body: node(), documentElement: node(),
    },
    addEventListener() {}, removeEventListener() {}, alert() {},
    requestAnimationFrame: cb => setTimeout(cb, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  // Всё, что интерфейс просит у TorrServer, отдаётся заглушкой; всё остальное —
  // настоящему демону, а он уже ходит в TMDB. Так проверяются реальные ответы.
  sandbox.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : String((input && input.url) || input);
    const abs = /^https?:/i.test(u) ? u : BASE + u;
    const p = abs.slice(BASE.length);
    if (p.startsWith('/ts/torrents')) return jsonResp(TORRENTS);
    if (p.startsWith('/ts/stream')) return jsonResp({});
    if (p.startsWith('/ts/')) return jsonResp({});
    if (p.startsWith('/api/ratings')) ratingsCalls.push(p);
    return realFetch(abs, init);
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(served, ctx, { filename: 'app.js' });
  } catch (e) {
    console.log('\nзагрузка app.js прервана на: ' + String(e.message).split('\n')[0]);
    return 1;
  }
  /* Объявления function становятся свойствами контекста сами, а state и
     paintLibrary объявлены через const — такие имена остаются в лексической
     области скрипта. Достаём их вторым прогоном в том же контексте: он видит
     ту же область. */
  vm.runInContext('globalThis.__probe = { state, paintLibrary };', ctx, { filename: 'probe.js' });
  const probe = ctx.__probe || {};
  const app = Object.assign({}, probe, {
    renderLibrary: ctx.renderLibrary, loadLibrary: ctx.loadLibrary, applyStoredMeta: ctx.applyStoredMeta,
  });

  // 3. Открытие библиотеки: список, постеры из хранилища, запрос за неизвестным.
  console.log('\n2. Библиотека: список, постеры, оценки');
  await app.renderLibrary(top('main'));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60 && String(app.state.lib.length) !== '2'; i++) await wait(250);
  check(String(app.state.lib.length) === '2', 'список загрузился', 'торрентов: ' + app.state.lib.length);
  for (let i = 0; i < 60; i++) { await wait(250); if (/image\.tmdb\.org/.test(String(top('#libGrid').innerHTML))) break; }

  const html = String(top('#libGrid').innerHTML);
  const tiles = html.split('<div class="tile"').slice(1);
  check(tiles.length === 2, 'плиток нарисовано', String(tiles.length));

  const witch = tiles.find(t => t.includes('Ведьмак')) || '';
  const matrix = tiles.find(t => t.includes('Матрица')) || '';
  check(witch.includes(WITCHER_POSTER), 'запомненный постер стоит на плитке');
  check(/>7\.9</.test(witch), 'и запомненная оценка IMDb');
  check(/>7\.9</.test(witch) && /data-tmdb[^>]*>7\.9</.test(witch), 'оценка TMDB тоже на месте');
  check(/image\.tmdb\.org/.test(matrix), 'незапомненная раздача получила постер от TMDB');

  // 4. Главное: за запомненным не ходят. Иначе сорок плиток библиотеки — это
  //    сорок запросов при каждом заходе.
  console.log('\n3. Запомненное не спрашивается заново');
  const asked = ratingsCalls.map(c => decodeURIComponent(c));
  const askedWitcher = asked.filter(c => c.includes('q=Ведьмак'));
  const askedMatrix = asked.filter(c => c.includes('q=Матрица'));
  check(askedWitcher.length === 0, 'за свежей записью в TMDB не ходили', 'запросов: ' + askedWitcher.length);
  check(askedMatrix.length > 0, 'а за неизвестной — сходили', 'запросов: ' + askedMatrix.length);

  // 5. Постер и оценка на плитке появляются до ответа TMDB, а не после: список
  //    перезагружен, метаданные взяты из хранилища, запрос ещё не сделан.
  console.log('\n4. Плитка собрана сразу, а не после ответа сервиса');
  ratingsCalls.length = 0;
  await app.loadLibrary(false);
  app.applyStoredMeta();
  app.paintLibrary();
  const early = String(top('#libGrid').innerHTML);
  const earlyWitch = early.split('<div class="tile"').slice(1).find(t => t.includes('Ведьмак')) || '';
  check(earlyWitch.includes(WITCHER_POSTER), 'постер на плитке до запроса');
  check(/>7\.9</.test(earlyWitch), 'и оценка тоже');
  check(ratingsCalls.length === 0, 'при этом запросов к TMDB не было', 'запросов: ' + ratingsCalls.length);

  console.log('\n' + (fails ? 'ПРОВАЛОВ: ' + fails : 'все проверки пройдены'));
  return fails ? 1 : 0;
}

main().then(code => process.exit(code)).catch(e => {
  console.log('\nПРОВЕРКА ПРЕРВАНА: ' + ((e && e.stack) || e));
  process.exit(1);
});
