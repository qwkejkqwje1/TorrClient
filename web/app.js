/* TorrClient — web UI. Talks only to the local companion daemon (same origin). */
'use strict';

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* html`` — шаблон, в котором подстановки экранируются сами.
   Запись `${esc(x)}` защищена только дисциплиной: забыл esc — и название раздачи
   с трекера становится разметкой. Здесь экранирование встроено в сам шаблон:
   всё подставленное попадает в текст, а не в разметку, и «забыть» его нельзя.
   Готовый HTML передаётся через raw(): им оборачиваются вложенный html`` или
   заведомо свой значок. Массив подставляется поэлементно — так пишутся списки. */
function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += htmlValue(values[i]);
  });
  return out;
}
function htmlValue(v) {
  if (v == null || v === false) return '';
  if (v && v.__raw) return v.value;
  if (Array.isArray(v)) return v.map(htmlValue).join('');
  return esc(v);
}
function raw(value) { return { __raw: true, value: String(value == null ? '' : value) }; }
const fmtSize = n => n == null ? '' : n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : (n || 0) + ' B';
const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString('ru-RU') : '';
const fmtDur = s => { if (!s) return ''; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ' ч ' : '') + m + ' мин'; };

const state = {
  view: 'library', hello: null, profiles: [], active: null, players: [],
  lib: [], viewed: [], dlJobs: [], settings: null, watch: { folder: '', log: [] }, folders: null,
  query: '', category: 'all', searchState: { loading: false, results: [], provider: 'rutor', q: '' },
  series: { loading: false, rows: [] }, modal: null,
  // metaError — код причины, по которой метаданные не приходят («ключ не
  // задан», «ключ отклонён»). Пустая строка — «всё в порядке либо ещё не
  // спрашивали»: предупреждение показывается только по названной причине.
  metaError: '',
};
const libV = { version: 0 };
const LS = { prof: 'tc_profile', view: 'tc_view', last: 'tc_lastadd', order: 'tc_order', serorder: 'tc_serorder' };

/* ---------- helpers ---------- */
function toast(msg, isErr) {
  const el = document.createElement('div');
  if (isErr) el.className = 'err';
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { try { const j = await r.json(); throw new Error(j.error || j.message || r.status); } catch (e) { if (e.message) throw e; throw new Error('HTTP ' + r.status); } }
  return r.json();
}
function ts(path) { return '/ts' + path; }
function jFetch(path, body, method = 'POST') { return fetch(ts(path), { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
async function tsJson(path, body) { const r = await jFetch(path, body); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {} if (!r.ok) throw new Error(j.error || j.message || r.status); return j; }
async function tsGet(path) { const r = await fetch(ts(path)); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {} if (!r.ok) throw new Error(j.error || r.status); return j; }

function streamBase(fname) { return fname ? `/stream/${encodeURIComponent(fname)}` : '/stream'; }
function torrentStreamUrl(t, opts = {}) {
  let q = 'link=' + encodeURIComponent(t.hash) + (opts.index ? '&index=' + opts.index : '');
  if (opts.play) q += '&play';
  if (opts.title) q += '&title=' + encodeURIComponent(opts.title);
  if (opts.category) q += '&category=' + encodeURIComponent(opts.category);
  if (opts.poster) q += '&poster=' + encodeURIComponent(opts.poster);
  if (opts.save) q += '&save';
  // Параметра pos здесь нет и быть не может: TorrServer его не разбирает.
  // Продолжение с места остановки ставит флаг запуска самого плеера.
  return ts(streamBase(opts.fname)) + '?' + q;
}

/* ---------- boot ---------- */
(async function boot() {
  try { state.hello = await api('/api/hello'); }
  catch (e) { toast('Не удалось подключиться к демону: ' + e.message, true); return; }
  await loadUserData();
  state.profiles = state.hello.profiles || [];
  state.players = state.hello.players || [];
  state.active = state.hello.active_profile_id;
  // Состояние папок нужно до первой отрисовки: иначе предупреждение о
  // недоступной папке появилось бы только после перехода по вкладкам.
  await refreshFolders();
  renderTopbar();
  hookNav();
  hookGlobal();
  route();
  pollDownloads();
  /* Живая лента вместо опроса: демон сам сообщает об изменениях. Опрос оставлен
     запасным путём — для браузеров без EventSource. */
  if (!hookEvents()) {
    setInterval(pollDownloads, 3000);
    // Отметки ставит и сам демон — пока играет внешний плеер. Поэтому список
    // отметок спрашивается постоянно, а не только при открытии страницы.
    setInterval(refreshViewed, 10000);
  }
})();

/* ---------- папки загрузок и наблюдения ---------- */
/* Путь на несуществующем диске выглядит в настройках совершенно правильным, а
   закачки в него не идут: каталог не создаётся, и ошибку никто не читает. Это
   уже случилось — в настройках стоял D:\TorrClientPortable\downloads, а диска D:
   в машине нет. Поэтому состояние папок спрашивается у демона (он проверяет
   папку настоящей записью) и показывается рядом с полем. */
async function refreshFolders() {
  let f = null;
  try { f = await api('/api/folders'); } catch (e) { f = null; }
  // Ответ без разбора папок считается отсутствием сведений: показывать «папка
  // недоступна» на пустом ответе значило бы ругаться на исправные настройки.
  state.folders = (f && typeof f === 'object' && f.watch) ? f : null;
  return state.folders;
}

/* Папки, состояние которых спрашивается у демона: ключ ответа → поле настройки.
   Таблица, а не цепочка «which === 'watch' ? … : …»: папок стало четыре, и
   забытая ветка молча писала бы не в то поле. */
const FOLDER_FIELDS = {
  watch: 'watch_folder',
  downloads: 'download_folder',
  cache: 'cache_folder',
  data: 'data_folder',
};

// folderDefault — предложение «рядом с программой» для этой папки. Путь берётся
// из ответа демона: собирать его здесь значило бы угадывать.
function folderDefault(which) {
  return (state.folders && state.folders['default_' + which]) || '';
}

// folderNoticeHTML — предупреждение о недоступной папке. Когда папка в порядке,
// возвращается пустая строка: разметка вставляется в готовые карточки, и
// заглушка оставила бы в них пустое место.
function folderNoticeHTML(which) {
  const f = state.folders && state.folders[which];
  if (!f || f.ok) return '';
  const def = folderDefault(which);
  return html`<div class="folder-warn">
    <b>Папка недоступна</b> — <span class="mono">${f.path || 'путь не задан'}</span>
    <div class="page-sub">${f.reason || 'причина неизвестна'}</div>
    <div class="row wrap" style="margin-top:8px">
      <button data-folder-fix="${which}" class="primary">Взять папку рядом с программой</button>
      <span class="mono page-sub" style="margin:0">${def || ''}</span>
    </div>
  </div>`;
}

// folderFixBody — тело запроса для кнопки исправления. Вынесено отдельно,
// потому что проверять нужно именно его: в теле должна быть одна сломанная
// папка, иначе исправление заодно перепишет исправную соседнюю настройку.
function folderFixBody(which) {
  const field = FOLDER_FIELDS[which];
  const def = folderDefault(which);
  if (!field || !def) return null;
  const body = { action: 'dirs' };
  body[field] = def;
  return body;
}

// hookFolderFix — кнопка «рядом с программой». Меняется только сломанная папка:
// исправную соседнюю настройку трогать не за что.
function hookFolderFix(root) {
  $$('[data-folder-fix]', root).forEach(b => b.addEventListener('click', async () => {
    const which = b.dataset.folderFix;
    const body = folderFixBody(which);
    if (!body) return;
    const field = FOLDER_FIELDS[which];
    const def = folderDefault(which);
    try {
      await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { toast('Папка не сохранена: ' + e.message, true); return; }
    if (state.hello) state.hello[field] = def;
    await refreshFolders();
    toast('Папка теперь: ' + def);
    route();
  }));
}

// setFolderFromPrompt — смена папки через диалог. Поле берётся из той же
// таблицы, поэтому новая папка не требует новой ветки; ответ проверяется на
// перенос накопленного, о котором иначе никто не узнает.
async function setFolderFromPrompt(which, title) {
  const field = FOLDER_FIELDS[which];
  if (!field) return;
  const p = prompt(title, (state.hello && state.hello[field]) || '');
  if (!p) return;
  let r = null;
  try {
    r = await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dirs', [field]: p }) });
  } catch (e) { toast('Папка не сохранена: ' + e.message, true); return; }
  if (state.hello) state.hello[field] = p;
  // Демон мог перенести отметки и избранное в новую папку: сказать об этом
  // нужно, иначе перенос выглядел бы как «в прежнем месте всё пропало».
  if (r && r.moved && r.moved.length) toast('Перенесено: ' + r.moved.join(', '));
  await refreshFolders();
  route();
}

/* ---------- живая лента ---------- */
/* Прежде окно закачек переспрашивало список каждые три секунды, а отметки —
   каждые десять. Теперь демон сам присылает событие: прогресс виден сразу, а
   между изменениями запросов нет вовсе. */
let eventsSrc = null;
function hookEvents() {
  if (typeof EventSource !== 'function') return false;
  try { eventsSrc = new EventSource('/api/events'); } catch (e) { eventsSrc = null; return false; }
  eventsSrc.addEventListener('downloads', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch (err) { return; }
    if (!Array.isArray(d.jobs)) return;
    state.dlJobs = d.jobs;
    if ($('#dljobs')) paintDownloads();
  });
  eventsSrc.addEventListener('positions', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch (err) { return; }
    applyPosition(d);
  });
  eventsSrc.addEventListener('torrents', e => {
    let list = [];
    try { list = JSON.parse(e.data); } catch (err) { return; }
    if (!Array.isArray(list)) return;
    if ($('#dlTorrents')) { paintTorrentRows(list); paintCacheCard(list); }
  });
  eventsSrc.addEventListener('state', () => {
    loadUserData().then(() => { if (state.view === 'library') paintLibrary(); }).catch(() => {});
  });
  return true;
}

/* applyPosition вплетает пришедшую отметку в список и перерисовывает окно —
   ровно так же, как это делал опрос, но без ожидания. */
function applyPosition(d) {
  if (!d || !d.hash) return;
  if (!Array.isArray(state.viewed)) state.viewed = [];
  const row = {
    hash: d.hash, file_index: d.file_index,
    timecode: Number(d.pos) || 0, duration: Number(d.duration) || 0,
    done: !!d.done, updated: Number(d.updated) || 0,
  };
  const i = state.viewed.findIndex(v => v.hash === row.hash && v.file_index === row.file_index);
  if (i >= 0) state.viewed[i] = Object.assign({}, state.viewed[i], row);
  else state.viewed.push(row);

  const key = viewedSignature();
  if (key === viewedKey) return;
  const first = !viewedKey;
  viewedKey = key;
  // Первое событие — это то, что уже нарисовано. Открытое окно перерисовывать
  // нельзя: пользователь как раз выбирает серию или правит настройки.
  if (first || $('.overlay')) return;
  if (state.view === 'library') paintLibrary();
}

function hookGlobal() {
  document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  document.addEventListener('click', e => {
    if (e.target.closest('.ctxmenu') || e.target.closest('[data-menu]')) return;
    $$('.ctxmenu:not(.hidden)').forEach(m => m.classList.add('hidden'));
  });
  // Предупреждение о метаданных ведёт туда, где причина исправляется: ключ
  // TMDB вводится в настройках, и искать это место самому незачем.
  const mw = $('#metaWarn');
  if (mw) mw.addEventListener('click', () => setView('settings'));
  // red «наверх» button
  const topBtn = $('#toTop');
  if (topBtn) {
    const onScroll = () => topBtn.classList.toggle('show', (window.scrollY || document.documentElement.scrollTop) > 360);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    onScroll();
  }
  // drag&drop anywhere: add magnets / torrent files
  const drop = (pd) => { pd.preventDefault(); pd.stopPropagation(); };
  ['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, drop));
  window.addEventListener('drop', e => onDropFiles(e));
}
function openExternal(url) {
  if (!url) return;
  launchPlayer('browser', url, 'TorrClient');
}
const PH_SVG = `<svg class="ph" viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/></svg>`;
function kpSearchUrl(title) {
  const c = cleanSearchTitle(title || '');
  const t = (c.q + (c.year ? ' ' + c.year : '')).trim();
  return 'https://www.kinopoisk.ru/index.php?kp_query=' + encodeURIComponent(t || title || '');
}
function imdbUrlFor(r) {
  if (r && r.imdb_id) return 'https://www.imdb.com/title/' + encodeURIComponent(r.imdb_id) + '/';
  const c = cleanSearchTitle((r && (r.title || r.name)) || '');
  return 'https://www.imdb.com/find/?q=' + encodeURIComponent(c.q || '');
}

function setView(v) {
  state.view = v;
  try { localStorage.setItem(LS.view, v); } catch {}
  $$('#nav [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  route();
}
function route() {
  const v = state.view;
  const pages = { library: renderLibrary, search: renderSearch, favorites: renderFavorites, bookmarks: renderBookmarks, players: renderPlayers, downloads: renderDownloads, series: renderSeries, settings: renderSettings, server: renderServer };
  const fn = pages[v] || renderLibrary;
  const main = $('main'); main.innerHTML = '';
  fn(main);
}
function hookNav() {
  $('#nav').innerHTML = [
    ['library', 'Библиотека'], ['search', 'Поиск'], ['favorites', 'Избранное'], ['bookmarks', 'Закладки'], ['players', 'Плееры'],
    ['series', 'Сериалы'], ['downloads', 'Загрузки'], ['settings', 'Настройки'], ['server', 'Сервер'],
  ].map(([k, n]) => `<button data-view="${k}" class="${state.view === k ? 'on' : ''}">${n}</button>`).join('');
  $$('#nav [data-view]').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.ctxmenu').forEach(m => m.classList.add('hidden')); setView(b.dataset.view); }));
}
function renderTopbar() {
  const prof = state.profiles.find(p => p.id === state.active) || {};
  const cur = $('#activeselect');
  if (!cur) return;
  const sel = document.createElement('select');
  sel.className = 'tb-select';
  sel.id = 'activeselect';
  sel.innerHTML = state.profiles.map(p => html`<option value="${p.id}" ${p.id === state.active ? 'selected' : ''}>${p.name}</option>`).join('');
  sel.addEventListener('change', async () => { await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'active', id: sel.value }) }); state.active = sel.value; renderServerStatus(); if (state.view === 'library') route(); });
  sel.classList.toggle('hidden', state.profiles.length < 2);
  cur.replaceWith(sel);
  renderServerStatus();
  renderMetaWarn();
}
function renderServerStatus() {
  const el = $('#serverStatus');
  if (!el) return;
  const prof = state.profiles.find(p => p.id === state.active) || {};
  el.innerHTML = html`<span class="dot ${state.active ? 'ok' : 'err'}"></span><span title="${prof.name || '—'}">Локальный сервер</span>`;
}

/* ---------- почему нет постеров ---------- */
/* «Ключ не задан» и «ключ отклонён» — разные состояния, и каждое надо назвать
   словами. Прежде демон отвечал «не найдено» на любую из этих причин, и
   пропавшие постеры выглядели как «сервис ничего не знает об этом фильме»:
   настройки при этом выглядели заполненными, и искать причину было негде.
   Теперь причина приходит кодом и висит в верхней строке, пока не исправлена. */
const META_ERR_TEXT = {
  'tmdb key not configured': 'Постеры и оценки не загружаются: не задан ключ TMDB',
  'tmdb key rejected': 'Постеры и оценки не загружаются: ключ TMDB отклонён сервисом',
};
function metaErrText(err) { return META_ERR_TEXT[err] || ''; }
function noteMetaError(err) {
  const text = metaErrText(err);
  if (!text || state.metaError === err) return;
  state.metaError = err;
  renderMetaWarn();
}
function renderMetaWarn() {
  const el = $('#metaWarn');
  if (!el) return;
  const text = metaErrText(state.metaError);
  el.classList.toggle('hidden', !text);
  el.textContent = text ? text + ' · Настроить' : '';
  el.title = text ? 'Открыть Настройки → TMDB' : '';
}
/* Смена ключа отменяет прежние отказы: и заданные впустую вопросы, и
   запомненные «названий серий нет». Без этого свежий ключ не дал бы ничего до
   перезагрузки страницы, и «ключ не помог» выглядело бы новым дефектом. */
function forgetMetaMisses() {
  askedRatings.clear();
  for (const k of Object.keys(epSeasonCache)) delete epSeasonCache[k];
  state.metaError = '';
  renderMetaWarn();
}

/* ---------- proxy helpers ---------- */
async function listTorrents() {
  let arr;
  try { arr = await tsGet('/torrents'); } catch (e) { arr = null; }
  if (!Array.isArray(arr)) { try { arr = await tsJson('/torrents', { action: 'list' }); } catch (e) { arr = []; } }
  return Array.isArray(arr) ? arr : [];
}
async function statTorrent(hash) {
  const r = await fetch(ts('/stream?link=' + encodeURIComponent(hash) + '&stat'));
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return j;
}
const statCache = {};
async function enrichStats(t) {
  const c = statCache[t.hash];
  if (c && Date.now() - c.at < 30000) { return Object.assign({}, t, c.data); }
  const s = await statTorrent(t.hash).catch(() => null);
  if (s && typeof s === 'object') { statCache[t.hash] = { at: Date.now(), data: s }; return Object.assign({}, t, s); }
  return Object.assign({}, t);
}
async function torrentAction(a, o = {}) { return tsJson('/torrents', Object.assign({ action: a }, o)); }
async function addTorrentRes(link, save) { const r = await jFetch('/stream', 'link=' + encodeURIComponent(link) + '&save&title=&category='); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

/* ================= LIBRARY ================= */
/* lookupView — отметки раздачи по номерам файлов. Форма записи та же, что у
   демона: позиция, длительность, признак «просмотрено». */
function lookupView(hash) { const m = {}; (state.viewed || []).forEach(v => { if (v.hash === hash) m[v.file_index] = v; }); return m; }

async function renderLibrary(root) {
  const lv = localStorage.getItem('tc_libview') || 'grid';
  root.innerHTML = html`
    <div class="toolbar">
      <h1 class="page-title">Библиотека</h1>
      <input class="search-input" id="libQuery" placeholder="Фильтр по названию..." value="${state.query}">
      <select id="libCat" style="width:auto">
        <option value="all">Все категории</option>
        <option value="movie">Фильмы</option>
        <option value="tv">Сериалы</option>
        <option value="music">Музыка</option>
        <option value="other">Другое</option>
      </select>
      <select id="libOrder" style="width:auto">
        <option value="name">По названию</option>
        <option value="date">По дате</option>
        <option value="size">По размеру</option>
      </select>
      <button data-act="refresh" class="iconbtn" title="Обновить">⟳</button>
      <span class="spacer"></span>
      <div class="seg" id="libViewSeg">
        <button data-vw="grid" class="${lv === 'grid' ? 'on' : ''}" title="Сетка">▦</button>
        <button data-vw="list" class="${lv === 'list' ? 'on' : ''}" title="Список">☰</button>
      </div>
      <button class="primary" data-open="add">+ Добавить торрент</button>
    </div>
    <div class="page-sub" id="libSub"></div>
    <div id="libContinue" class="cont-strip hidden"></div>
    <div id="libGrid" class="grid ${lv === 'list' ? 'list' : ''}"></div>
    <div id="libEmpty" class="empty hidden">Библиотека пуста. Добавьте магнит или .torrent.</div>`;

  $('#libQuery').value = state.query;
  $('#libCat').value = state.category;
  $('#libQuery').addEventListener('input', () => { state.query = $('#libQuery').value; paintLibrary(); });
  $('#libCat').addEventListener('change', () => { state.category = $('#libCat').value; paintLibrary(); });
  $('#libOrder').value = localStorage.getItem(LS.order) || 'name';
  $('#libOrder').addEventListener('change', () => { localStorage.setItem(LS.order, $('#libOrder').value); paintLibrary(); });
  $('[data-open="add"]').addEventListener('click', openAddModal);
  $('[data-act="refresh"]').addEventListener('click', () => { refreshLibrary(); });
  $$('#libViewSeg [data-vw]').forEach(b => b.addEventListener('click', () => {
    localStorage.setItem('tc_libview', b.dataset.vw);
    $('#libGrid').className = 'grid' + (b.dataset.vw === 'list' ? ' list' : '');
    $$('#libViewSeg [data-vw]').forEach(x => x.classList.toggle('on', x.dataset.vw === b.dataset.vw));
    paintLibrary();
  }));

  applyStoredMeta();
  paintLibrary();
  bindContinue();
  // Постеры запрашиваются после загрузки списка. Прежде libRatings() вызывался
  // до неё: state.lib в этот момент ещё пуст, libRatings выходил сразу, и в
  // библиотеке постеры не появлялись вовсе.
  refreshLibrary();
}

// refreshLibrary — «перезагрузить список и подтянуть метаданные». Один порядок
// для всех мест: сперва список, потом постеры и оценки из хранилища, потом
// запрос в TMDB. loadLibrary зовётся без отрисовки: плитки собираются один раз —
// уже с тем, что помнится с прошлого раза.
function refreshLibrary() {
  return loadLibrary(false).then(() => {
    applyStoredMeta();
    paintLibrary();
    libRatings();
  });
}

/* Paint-first library: list is shown immediately, per-torrent stats are
   enriched in background (limited concurrency, cached 30 s) so opening the
   library never blocks on N /stream?stat round-trips. */
async function loadLibrary(paint) {
  try { state.lib = await listTorrents(); }
  catch (e) { toast('Ошибка загрузки библиотеки: ' + e.message, true); state.lib = []; }
  await loadPositions();
  if (paint) paintLibrary();
  const need = state.lib.filter(t => !t.hasStat && !statCache[t.hash]);
  if (need.length) enrichBackground(need);
  return state.lib;
}

/* Отметки просмотра ведёт демон: он один знает позицию от самого плеера, а не
   по времени с момента запуска. Список /viewed у TorrServer отмечает файл
   просмотренным уже в момент начала потока и позицию не хранит. */
async function loadPositions() {
  try { const rows = await api('/api/positions'); if (Array.isArray(rows)) state.viewed = rows; }
  catch {}
}
async function savePosition(hash, fi, pos, duration, done) {
  const body = { hash, file_index: fi };
  if (pos != null) body.timecode = Math.max(0, Math.round(pos));
  if (duration) body.duration = duration;
  if (done != null) body.done = !!done;
  try {
    await api('/api/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const row = (state.viewed || []).find(v => v.hash === hash && v.file_index === fi);
    if (row) {
      if (body.timecode != null) row.timecode = body.timecode;
      if (body.duration) row.duration = body.duration;
      if (body.done != null) row.done = body.done;
    } else {
      state.viewed.push({ hash, file_index: fi, timecode: body.timecode || 0, duration: body.duration || 0, done: !!body.done });
    }
    return true;
  } catch (e) { toast('Не удалось сохранить отметку: ' + e.message, true); return false; }
}
const enrichCache = { at: 0 };
async function enrichBackground(need) {
  if (enrichCache.at && Date.now() - enrichCache.at < 5000) return;
  enrichCache.at = Date.now();
  const jobs = need.slice(0, 120);
  let i = 0;
  const w = async () => {
    while (i < jobs.length) {
      const t = jobs[i++];
      const s = await statTorrent(t.hash).catch(() => null);
      if (s && typeof s === 'object') {
        statCache[t.hash] = { at: Date.now(), data: s };
        const cur = state.lib.find(x => x.hash === t.hash);
        if (cur) { Object.assign(cur, s); cur.hasStat = true; }
      }
    }
  };
  await Promise.all([w(), w(), w(), w()]);
  if (state.view === 'library') paintLibrary();
}

function filterLib() {
  const q = state.query.trim().toLowerCase();
  const cat = state.category;
  return state.lib.filter(t => {
    const title = (t.title || t.name || '').toLowerCase();
    if (q && !title.includes(q)) return false;
    if (cat !== 'all') { const c = (t.category || '').toLowerCase(); if (cat === 'uncategorized' ? c : c !== cat) return false; }
    return true;
  });
}

function painting() {
  const list = filterLib();
  paintContinue();
  const order = localStorage.getItem(LS.order) || 'name';
  const cmp = {
    name: (a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || '', 'ru'),
    date: (a, b) => b.timestamp - a.timestamp,
    size: (a, b) => b.torrent_size - a.torrent_size,
  }[order] || ((a, b) => 0);
  list.sort(cmp);
  $('#libSub').textContent = `Торрентов: ${state.lib.length}`;
  const grid = $('#libGrid');
  if (!list.length) { grid.innerHTML = ''; $('#libEmpty').classList.remove('hidden'); $('#libEmpty').textContent = state.lib.length ? 'Нет совпадений.' : 'Библиотека пуста. Добавьте магнит или .torrent.'; return; }
  $('#libEmpty').classList.add('hidden');
  grid.innerHTML = list.map(t => tile(t)).join('');
  bindTiles(grid);
}
const paintLibrary = () => painting();

/* Ход просмотра раздачи. У сериала он важнее хода загрузки: видно, сколько
   серий уже посмотрено и какая начата. */
function seriesProgress(t) {
  const vids = playableOf(t).filter(f => isVideo(f.path));
  if (vids.length < 2) return null;
  let sum = 0, done = 0, started = 0;
  vids.forEach(f => {
    if (isWatched(t, f.id)) { sum += 1; done++; return; }
    const share = viewedShare(t, f.id);
    if (share > 0) { sum += share; started++; }
  });
  if (!done && !started) return null;
  return { done, started, total: vids.length, share: sum / vids.length };
}

/* continueItems — что недосмотрено: отметка есть, позиция больше нуля, досмотр
   не отмечен и раздача ещё в библиотеке. Свежие сверху: список показывает то, к
   чему возвращаются, а не порядок серий в раздаче. */
function continueItems() {
  const lib = {};
  (state.lib || []).forEach(t => { lib[t.hash] = t; });
  return (state.viewed || [])
    .filter(v => v && !v.done && v.timecode > 0 && lib[v.hash])
    .map(v => {
      const t = lib[v.hash];
      const f = (t.file_stats || []).find(x => x.id === v.file_index);
      if (!f) return null;
      return {
        t, f, pos: v.timecode, duration: v.duration || 0,
        share: v.duration > 0 ? Math.min(1, v.timecode / v.duration) : 0,
        updated: v.updated || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.updated - a.updated);
}
function continueCard(it) {
  const title = it.t.title || it.t.name || it.t.hash;
  return html`
  <div class="cont-card" data-cont data-cont-hash="${it.t.hash}" data-cont-file="${it.f.id}">
    <div class="cont-title" title="${title}">${title}</div>
    <div class="cont-sub">${epLabel(it.f, it.t)}</div>
    <div class="cont-bar"><i style="width:${Math.round(it.share * 100)}%"></i></div>
    <div class="cont-foot">
      <span class="cont-pos">${fmtPos(it.pos)}${it.duration ? ' из ' + fmtPos(it.duration) : ''}</span>
      <button class="chip-btn" data-cont-play>▶ Продолжить</button>
      <button class="chip-btn" data-cont-done title="Отметить просмотренной">✓</button>
    </div>
  </div>`;
}
/* paintContinue наполняет полосу. Пустая полоса не показывается: место в
   библиотеке дороже, чем надпись «здесь пока пусто». */
function paintContinue() {
  const box = $('#libContinue');
  if (!box) return;
  const items = continueItems();
  if (!items.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = html`<div class="cont-head">Продолжить просмотр <span class="cont-n">${items.length}</span></div>`
    + html`<div class="cont-row">${raw(items.slice(0, 20).map(continueCard).join(''))}</div>`;
}
function bindContinue() {
  const box = $('#libContinue');
  if (!box) return;
  box.addEventListener('click', e => {
    const card = e.target.closest('[data-cont]');
    if (!card) return;
    const it = continueItems().find(x => x.t.hash === card.dataset.contHash && x.f.id === Number(card.dataset.contFile));
    if (!it) return;
    // Отметка досмотра обнуляет позицию: возвращаться к серии больше некуда.
    if (e.target.closest('[data-cont-done]')) {
      savePosition(it.t.hash, it.f.id, 0, it.duration, true).then(() => { paintContinue(); paintLibrary(); });
      return;
    }
    playSelected(it.t, it.f);
  });
}

function tile(t) {
  const hasMedia = (t.file_stats || []).some(f => isPlayable(f.path));
  const loaded = t.torrent_size ? (t.bytes_read || 0) / t.torrent_size : 0;
  const sp = seriesProgress(t);
  const q = qTag(t.title || t.name || '');
  const ser = isSeries(t.title || t.name || '');
  const title = t.title || t.name || (t.hash || '').slice(0, 12);
  const st = String(t.stat_string || t.stat || '');
  let scls = 'idle';
  if (/download/i.test(st)) scls = 'dl'; else if (loaded >= 1 && t.torrent_size) scls = 'ok';
  // Оценки уже известны — показываются сразу, а не после ответа TMDB: иначе
  // каждая перерисовка плитки гасила бы чипы до следующего запроса.
  const rt = ratingFor(t);
  const rtTmdb = rt && rt.rating > 0 ? rt.rating.toFixed(1) : '';
  const rtImdb = rt && rt.imdb > 0 ? rt.imdb.toFixed(1) : '';
  const metaBits = [];
  if (t.year) metaBits.push(t.year);
  if (t.torrent_size) metaBits.push(fmtSize(t.torrent_size));
  if (t.connected_seeders != null) metaBits.push('⬆ ' + t.connected_seeders);
  if (t.total_peers != null) metaBits.push('👥 ' + t.total_peers);
  if (t.download_speed || t.upload_speed) metaBits.push((t.download_speed ? '↓ ' + fmtSpeed(t.download_speed) : '') + (t.upload_speed ? ' ↑ ' + fmtSpeed(t.upload_speed) : ''));
  if (!metaBits.length && fmtDate(t.timestamp)) metaBits.push('добавлен ' + fmtDate(t.timestamp));
  const pg = hasMedia ? `<div class="progress"${sp ? ` title="просмотрено ${sp.done} из ${sp.total}"` : ''}><i style="width:${Math.min(100, (sp ? sp.share : loaded) * 100).toFixed(0)}%"></i></div>` : '';
  const pgNote = sp ? `<div class="page-sub">просмотрено ${sp.done} из ${sp.total}${sp.started ? ' · начато ' + sp.started : ''}</div>` : '';
  return html`
  <div class="tile" data-hash="${t.hash}">
    <div class="poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (t.poster ? 'hidden' : '') + '"'))}
      ${raw(t.poster ? html`<img src="${t.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-act="watch" title="Смотреть"><span class="tri"></span></button>
      <div class="badges">
        ${raw(q ? html`<span class="chip ${q}">${q === 'q2160' ? '4K' : '1080p'}</span>` : '')}
        ${raw(ser ? '<span class="chip series">Сериал</span>' : '')}
        <span class="statusdot ${scls}" title="${st || 'статус'}"></span>
      </div>
      <div class="rate-stack">
        <span class="chip rating" data-tmdb${rtTmdb ? '' : ' hidden'}>${rtTmdb}</span>
        <span class="chip rt-imdb" data-imdb${rtImdb ? '' : ' hidden'}>${rtImdb}</span>
      </div>
      <div class="poster-flinks">
        <a class="flink" data-sa="kp">Кинопоиск</a>
        <a class="flink" data-sa="imdb">IMDb</a>
      </div>
    </div>
    <div class="body">
      <div class="title-row"><span class="title clamp2${ser ? ' clickable' : ''}" data-act="titled" title="${t.title || t.name || ''}">${title}</span></div>
      ${raw(pg)}
      ${raw(pgNote)}
      <div class="metabar">
        <span class="mb-stats">${raw(metaBits.map(b => b).join(' &nbsp;·&nbsp; ') || '—')}</span>
      </div>
      <button class="menu-ico" data-menu title="Ещё">⋮</button>
    </div>
    <div class="ctxmenu hidden">
      <button data-act="info">Инфо о раздаче</button>
      <button data-act="edit">Изменить</button>
      <button data-act="autoposter">Подгрузить постер (TMDB)</button>
      <button data-act="bm">Закладка просмотра</button>
      <div class="sep"></div>
      <button data-sa="kp">Кинопоиск</button>
      <button data-sa="imdb">IMDb</button>
      <div class="sep"></div>
      <button data-act="m3u">M3U-плейлист</button>
      <button data-act="copy">Магнит-ссылка</button>
      <div class="sep"></div>
      <button data-act="drop" class="danger">Убрать торрент</button>
    </div>
  </div>`;
}
function fmtSpeed(s) { return s >= 1 << 20 ? (s / (1 << 20)).toFixed(1) + ' МБ/с' : (s / 1024).toFixed(0) + ' КБ/с'; }
function isVideo(p) { return /\.(mp4|mkv|avi|mov|webm|m4v|ts|wmv|flv|mpg|mpeg|m2ts|3gp)$/i.test(p || ''); }
function isAudio(p) { return /\.(mp3|flac|wav|m4a|aac|ogg|opus|ac3|dts)$/i.test(p || ''); }
function isSub(p) { return /\.(srt|ass|ssa|sub|vtt|idx)$/i.test(p || ''); }
function isPlayable(p) { return isVideo(p) || isAudio(p); }
function isSeries(name) { return /(s\d{1,2}e\d{1,2}|sezon|сезон|\d{1,2}\s*листа|\d+\.{1,2}05|\bx0|\bread|\bсерия)/i.test(name || ''); }
function qTag(name) {
  if (/(2160|4k|uhd)/i.test(name)) return 'q2160';
  if (/(1080|fullhd|fhd|blu-ray|bdrip|web-dl.*1080|hd)\b/i.test(name)) return 'q1080';
  return '';
}

function bindTiles(grid) {
  $$('.tile', grid).forEach(tileEl => {
    const hash = tileEl.dataset.hash;
    const t = state.lib.find(x => x.hash === hash); if (!t) return;
    const w = tileEl.querySelector('[data-act="watch"]'); if (w) w.addEventListener('click', () => watchNow(t));
    tileEl.addEventListener('dblclick', e => { if (e.target.closest('.ctxmenu') || e.target.closest('.menu-ico')) return; watchNow(t); });
    const titleEl = tileEl.querySelector('[data-act="titled"]');
    if (titleEl) titleEl.addEventListener('click', e => { e.stopPropagation(); if (isSeries(t.title || t.name)) openEpisodesPicker(t); });
    const menuBtn = tileEl.querySelector('[data-menu]');
    const menu = tileEl.querySelector('.ctxmenu');
    if (menuBtn && menu) menuBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    const act = (sel, fn) => tileEl.querySelectorAll(sel).forEach(b => b.addEventListener('click', () => { menu && menu.classList.add('hidden'); fn(); }));
    act('[data-act="info"]', () => openTorrentModal(t));
    act('[data-act="edit"]', () => openEditModal(t));
    act('[data-act="m3u"]', () => downloadM3u(t));
    act('[data-act="copy"]', () => copyTorrentMagnet(t));
    act('[data-act="drop"]', () => dropTorrent(t));
    act('[data-del]', () => dropTorrent(t));
    act('[data-act="autoposter"]', () => autoPoster(t));
    act('[data-act="bm"]', () => { const f = firstPlayable(t); if (!f) return toast('Нет воспроизводимых файлов', true); addBookmark(t, f.id, basename(f.path)); });
    act('[data-sa="kp"]', () => openExternal(kpSearchUrl(t.title || t.name || '')));
    act('[data-sa="imdb"]', () => openExternal(imdbUrlFor(t)));
  });
}

async function autoPoster(t) {
  const c = cleanSearchTitle(t.title || t.name || '');
  if (!c.q) return toast('Не удалось определить название', true);
  let j;
  try {
    const rr = await fetch('/api/tmdb?q=' + encodeURIComponent(c.q) + (c.year ? '&year=' + c.year : ''));
    j = await rr.json();
  } catch (e) { return toast('Ошибка TMDB: ' + e.message, true); }
  if (!j.ok || !j.poster) {
    noteMetaError(j.error);
    // Причину по-русски называет metaErrText; остальное — отказ самого
    // сервиса, и он показывается как есть.
    return toast(metaErrText(j.error) || ('Постер не найден: ' + (j.error || 'нет в TMDB')), true);
  }
  try {
    await torrentAction('set', { hash: t.hash, poster: j.poster, title: j.title || t.title || t.name });
    toast('Постер подгружен');
    rememberMeta(c, j);
    const cur = state.lib.find(x => x.hash === t.hash); if (cur) { cur.poster = j.poster; cur.title = j.title || cur.title; }
    delete statCache[t.hash];
    paintLibrary();
  } catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
}

async function copyTorrentMagnet(t) {
  const link = await magnetFor(t);
  if (link) { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }
}
async function magnetFor(t) {
  if (t.torrs_hash) return 'torrs://' + t.torrs_hash.replace(/^torrs:\/\//, '');
  if (t.hash) return 'magnet:?xt=urn:btih:' + t.hash + (t.title ? '&dn=' + encodeURIComponent(t.title) : '');
  return '';
}

async function openAddModal() {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="modal">
    <button class="modal-close" data-close>✕</button><h2>Добавить торрент</h2>
    <div id="dropZone" class="card" style="text-align:center; padding:26px; border-style:dashed">
      Перетащите сюда .torrent файлы или магниты<br><small>(Drag&drop)</small>
      <button id="pickFile" style="margin-top:10px">Выбрать файл</button><input type="file" id="fileInput" multiple accept=".torrent" hidden>
    </div>
    <div class="divider"></div>
    <label>Магнитная ссылка / hash / ссылка на .torrent</label>
    <textarea id="addLink" rows="3" placeholder="magnet:?xt=urn:btih:..."></textarea>
    <label>Заголовок (необязательно)</label><input id="addTitle" placeholder="Название">
    <div class="row" style="margin-top:12px">
      <label style="flex:1"><input type="checkbox" id="addSave" checked> Сохранить в библиотеке сервера</label>
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end">
      <button data-close>Отмена</button><button id="addGo" class="primary">Добавить</button>
    </div></div>`;
  document.body.appendChild(ov);
  const dz = ov.querySelector('#dropZone');
  const fileInput = ov.querySelector('#fileInput');
  ov.querySelector('#pickFile').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => uploadFiles([...fileInput.files], ov));
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
  dz.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); ov.remove(); onDropFiles(e); });
  ov.querySelector('#addGo').addEventListener('click', async () => {
    const link = ov.querySelector('#addLink').value.trim();
    const title = ov.querySelector('#addTitle').value.trim();
    const save = ov.querySelector('#addSave').checked;
    if (!link) return toast('Введите магнит или ссылку', true);
    const btn = ov.querySelector('#addGo'); btn.disabled = true; btn.textContent = 'Добавление...';
    try {
      const raw = link.includes('/') && !link.startsWith('magnet:') ? link : link;
      let tmp;
      if (link.startsWith('magnet:') || /^[0-9a-f]{40}$/.test(link) || /^[A-Za-z0-9+/]{40,}=*$/.test(link.replace(/^torrs:\/\//i, ''))) {
        tmp = await torrentAction('add', { link, save_to_db: save });
      } else if (/^[a-f0-9]{40}$/i.test(link)) {
        tmp = await torrentAction('add', { link, save_to_db: save });
      } else {
        // could be a http(s) magnet handler
        tmp = await torrentAction('add', { link, save_to_db: save });
      }
      ov.remove(); toast('Торрент добавлен'); loadLibrary().then(() => { state.view = 'library'; route(); });
    } catch (e) { btn.disabled = false; btn.textContent = 'Добавить'; toast('Ошибка: ' + e.message, true); }
  });
}

let uploadBusy = false;
async function onDropFiles(e) {
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  let texts = [];
  if (e.dataTransfer && e.dataTransfer.items) {
    for (const it of e.dataTransfer.items) { if (it.kind === 'string' && it.type === 'text/plain') { const t = await new Promise(r => it.getAsString(r)); texts.push(t); } }
  }
  const magnets = texts.filter(t => t.toLowerCase().includes('magnet:'));
  if (magnets.length) { for (const m of magnets) { try { await torrentAction('add', { link: m.trim(), save_to_db: true }); toast('Добавлен: ' + short(m)); } catch (err) { toast('Ошибка магнита: ' + err.message, true); } } refreshLibrary(); }
  const tf = files.filter(f => /\.torrent$/i.test(f.name)) || files.filter(f => /\.(torrent|magnet)$/i.test(f.name));
  if (tf.length) { for (const f of tf) { await uploadFile(f); } }
  if (texts.length && !magnets.length) { const l = texts.join('\n'); showAddFromText(l); }
}
function short(s) { const m = s.match(/dn=([^&]+)/); return m ? decodeURIComponent(m[1]).slice(0, 40) : s.slice(0, 40); }
function showAddFromText(text) {
  const add = $('.overlay #addLink'); if (add) { add.value = text; return; }
  toast('Вставьте текст в окно добавления');
  state.view = 'library'; route(); openAddModal();
}
async function uploadFile(file) {
  const fd = new FormData(); fd.append('file', file); fd.append('save', '1');
  try {
    const r = await fetch(ts('/torrent/upload'), { method: 'POST', body: fd });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('Загружен: ' + file.name);
  } catch (e) { toast('Ошибка загрузки ' + file.name + ': ' + e.message, true); }
  refreshLibrary();
}
async function uploadFiles(files, ov) {
  for (const f of files) await uploadFile(f);
  if (ov) ov.remove();
}

async function dropTorrent(t) {
  if (!confirm('Убрать торрент с сервера?')) return;
  try { await torrentAction('rem', { hash: t.hash }); delete statCache[t.hash]; toast('Торрент удалён'); } catch (e) { toast('Ошибка: ' + e.message, true); }
  refreshLibrary();
}
function downloadM3u(t) {
  const url = ts(`/playlist?hash=${encodeURIComponent(t.hash)}&m3u`);
  const a = document.createElement('a'); a.href = url; a.download = (t.title || 'all') + '.m3u';
  document.body.appendChild(a); a.click(); a.remove();
}
function openEditModal(t) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal">
    <button class="modal-close" data-close>✕</button><h2>Изменить торрент</h2>
    <label>Название</label><input id="edTitle" value="${t.title || t.name || ''}">
    <label>Категория</label><select id="edCat">
      <option value="">(без категории)</option>
      <option value="movie" ${t.category === 'movie' ? 'selected' : ''}>Фильм</option>
      <option value="tv" ${t.category === 'tv' ? 'selected' : ''}>Сериал</option>
      <option value="music" ${t.category === 'music' ? 'selected' : ''}>Музыка</option>
      <option value="other" ${t.category === 'other' ? 'selected' : ''}>Другое</option>
    </select>
    <label>Постер (URL)</label><input id="edPoster" value="${t.poster || ''}">
    <div class="row" style="justify-content:flex-end; margin-top:12px">
      <button data-close>Отмена</button><button id="edGo" class="primary">Сохранить</button>
    </div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#edGo').addEventListener('click', async () => {
    const title = ov.querySelector('#edTitle').value;
    const poster = ov.querySelector('#edPoster').value.trim();
    await torrentAction('set', { hash: t.hash, title: title, category: ov.querySelector('#edCat').value, poster: poster });
    // TorrServer поле poster не хранит, поэтому введённый вручную адрес
    // запоминается отдельно — иначе он пропадал бы при первой же перезагрузке
    // списка (loadLibrary заменяет state.lib новым массивом).
    const c = cleanSearchTitle(title || t.title || t.name || '');
    if (poster) rememberPoster(c, poster); else forgetPoster(c);
    ov.remove(); refreshLibrary();
  });
}
function copyToClip(txt, msg) { navigator.clipboard.writeText(txt).then(() => toast(msg || 'Скопировано')); }

/* ---------- torrent info modal ---------- */
function openTorrentModal(t) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  const files = t.file_stats || [];
  const vm = lookupView(t.hash);
  ov.innerHTML = html`<div class="modal wide">
    <button class="modal-close" data-close>✕</button>
    <div class="row"><div style="flex:1"><h2 style="margin-top:0">${t.title || t.name || t.hash}</h2>
      <div class="row wrap">
        ${raw(t.category ? html`<span class="chip grey">${t.category}</span>` : '')}
        ${raw(t.torrent_size ? html`<span class="chip">${fmtSize(t.torrent_size)}</span>` : '')}
        ${raw(t.duration_seconds ? html`<span class="chip">${fmtDur(t.duration_seconds)}</span>` : '')}
        ${raw(isSeries(t.title || '') ? '<span class="chip series">Сериал</span>' : '')}
        ${raw(t.bit_rate ? html`<span class="chip">${t.bit_rate}</span>` : '')}
      </div></div>
      ${raw(t.poster ? html`<img src="${t.poster}" style="height:110px; border-radius:8px" onerror="this.remove()">` : '')}
    </div>
    <div class="divider"></div>
    <div class="tabs" id="infoTabs">
      <button data-tab="files" class="on">Файлы (${files.length})</button>
      <button data-tab="media">Информация о медиа</button>
      <button data-tab="stats">Статистика</button>
    </div>
    <div id="infoFiles"></div>
    <div id="infoMedia" class="hidden media-info"></div>
    <div id="infoStats" class="hidden"></div>
    <div class="divider"></div>
    <div id="infoPlayer"></div>
  </div>`;
  document.body.appendChild(ov);
  const paintFiles = () => {
    const el = ov.querySelector('#infoFiles');
    el.innerHTML = html`<table><thead><tr><th>Файл</th><th>Размер</th><th>Статус</th></tr></thead><tbody>${raw(files.map(f => html`
      <tr><td><code class="inline">${f.path}</code></td><td>${fmtSize(f.length)}</td>
      <td>${raw(vm[f.id] && vm[f.id].done ? '<span class="chip">просмотрено</span>' : (vm[f.id] && vm[f.id].timecode ? html`<span class="chip">${fmtDur(vm[f.id].timecode)}</span>` : ''))}</td></tr>`).join(''))}</tbody></table>`;
  };
  paintFiles();
  ov.querySelector('#infoTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    $$('#infoTabs button').forEach(x => x.classList.remove('on')); b.classList.add('on');
    const tab = b.dataset.tab;
    ['#infoFiles', '#infoMedia', '#infoStats'].forEach(s => ov.querySelector(s).classList.add('hidden'));
    if (tab === 'files') { ov.querySelector('#infoFiles').classList.remove('hidden'); paintFiles(); }
    if (tab === 'media') { ov.querySelector('#infoMedia').classList.remove('hidden'); paintMedia(ov, t); }
    if (tab === 'stats') { ov.querySelector('#infoStats').classList.remove('hidden'); paintStats(ov, t); }
  });
  bindTorrentPlay(ov, t, files);
}

function paintStats(ov, t) {
  let h = '<div class="stat-line" style="display:grid; grid-template-columns:1fr 1fr; gap:6px 20px; max-width:520px">';
  const rows = [
    ['Статус', t.stat_string || t.stat], ['Загружено', fmtSize(t.loaded_size)],
    ['Размер торрента', fmtSize(t.torrent_size)], ['Скорость (вниз)', fmtSpeed(t.download_speed || 0)],
    ['Скорость (вверх)', fmtSpeed(t.upload_speed || 0)], ['Пиры (всего)', t.total_peers],
    ['Активные пиры', t.active_peers], ['Сиды', t.connected_seeders],
    ['Прочитано', fmtSize(t.bytes_read)], ['Записано', fmtSize(t.bytes_written)],
  ];
  rows.forEach(([k, v]) => h += html`<div><b>${k}:</b> ${v}</div>`);
  h += '</div>';
  ov.querySelector('#infoStats').innerHTML = h;
}

async function paintMedia(ov, t) {
  const el = ov.querySelector('#infoMedia');
  el.classList.remove('hidden');
  el.innerHTML = '<div class="stat-line">Анализ потоков (ffprobe)...</div>';
  const vf = (t.file_stats || []).find(f => isVideo(f.path));
  if (!vf) { el.innerHTML = '<div class="empty">Видео не найдено</div>'; return; }
  try {
    const r = await fetch(ts(`/ffp/${t.hash}/${vf.id}`));
    const txt = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = JSON.parse(txt);
    const fmt = j.format || {};
    const streams = (j.streams || []).map(s => {
      const kind = s.codec_type === 'video' ? 'Видео' : s.codec_type === 'audio' ? 'Звук' : s.codec_type === 'subtitle' ? 'Субтитры' : s.codec_type;
      return html`<div><b>${kind}:</b> ${s.codec_name || ''} ${raw(s.width ? html`${s.width}×${s.height}` : '')} ${s.bit_rate ? fmtSize(parseInt(s.bit_rate)) + '/с' : ''} ${s.duration ? fmtDur(parseFloat(s.duration)) : ''}</div>`;
    }).join('');
    const fileDura = t.file_stats_rev ? (t.file_stats_rev[vf.id] && t.file_stats_rev[vf.id].length) : '';
    el.innerHTML = html`<div class="stat-line">
      <div><b>Контейнер:</b> ${fmt.format_name || ''} · ${fmt.format_long_name || ''}</div>
      <div><b>Длительность:</b> ${fmt.duration ? fmtDur(parseFloat(fmt.duration)) : ''}</div>
      <div><b>Размер:</b> ${fmt.size ? fmtSize(parseInt(fmt.size)) : ''}</div>
      ${raw(t.bit_rate ? html`<div><b>Битрейт:</b> ${t.bit_rate}</div>` : '')}
      <div class="divider"></div>${raw(streams || '—')}
    </div>`;
  } catch (e) { el.innerHTML = html`<div class="empty">Не удалось проанализировать (возможно, ffmpeg недоступен на сервере): ${e.message}</div>`; }
}

/* ================= FAVORITES + BOOKMARKS ================= */
function favList() { try { const a = JSON.parse(localStorage.getItem('tc_userlist') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveFavList(l) { try { localStorage.setItem('tc_userlist', JSON.stringify(l)); } catch {} syncUserData(); }
function getBookmarks() { try { const a = JSON.parse(localStorage.getItem('tc_bm') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveBookmarks(l) { try { localStorage.setItem('tc_bm', JSON.stringify(l)); } catch {} syncUserData(); }
function userDataPayload() {
  let fav = [], bm = [];
  try { fav = JSON.parse(localStorage.getItem('tc_userlist') || '[]'); } catch {}
  try { bm = JSON.parse(localStorage.getItem('tc_bm') || '[]'); } catch {}
  return { favorites: Array.isArray(fav) ? fav : [], bookmarks: Array.isArray(bm) ? bm : [] };
}
function syncUserData() { fetch('/api/userdata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(userDataPayload()) }).catch(() => {}); }
async function loadUserData() {
  try {
    const j = await api('/api/userdata');
    if (Array.isArray(j.favorites) && j.favorites.length) localStorage.setItem('tc_userlist', JSON.stringify(j.favorites));
    if (Array.isArray(j.bookmarks) && j.bookmarks.length) localStorage.setItem('tc_bm', JSON.stringify(j.bookmarks));
  } catch {}
}
/* Отметка одного файла. Досмотр и позиция — разные вещи: у досмотренной серии
   позиция обнуляется, поэтому «просмотрено» определяется признаком done, а не
   положительным временем. По времени досмотренная серия выглядела непросмотренной. */
function markOf(t, fi) { return (state.viewed || []).find(x => x.hash === t.hash && x.file_index === fi) || null; }
function currentTc(t, fi) { const v = markOf(t, fi); return v && !v.done ? (v.timecode || 0) : 0; }
function isWatched(t, fi) { const v = markOf(t, fi); return !!(v && v.done); }
function viewedShare(t, fi) { const v = markOf(t, fi); return v && v.duration > 0 ? Math.min(1, (v.timecode || 0) / v.duration) : 0; }
function fmtPos(s) {
  if (!s) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
  return (h ? h + ' ч ' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
/* tracking реальной позиции: сервер /viewed не ведёт время, считаем от момента запуска */
function trackPlay(hash, fi, base) {
  state.play = { hash, fi, base: base || 0, at: Date.now() };
}
function estimatePos(hash, fi) {
  const p = state.play;
  if (p && p.hash === hash && p.fi === fi) {
    const sec = (Date.now() - p.at) / 1000;
    if (sec >= 0 && sec < 6 * 3600) return Math.round(p.base + sec);
  }
  return 0;
}
function addBookmark(t, fi, fname, explicitPos) {
  let list = getBookmarks();
  // Позицию ведёт демон, пока играет плеер. Оценка по времени с момента запуска
  // — запасной путь для плеера, который о себе не сообщает.
  const pos = explicitPos != null && explicitPos > 0 ? explicitPos : (currentTc(t, fi) || estimatePos(t.hash, fi));
  const prev = list.find(x => x.hash === t.hash && x.file_index === fi);
  list = list.filter(x => !(x.hash === t.hash && x.file_index === fi));
  list.unshift({ hash: t.hash, file_index: fi, file: fname || (prev && prev.file) || '', title: t.title || t.name || (prev && prev.title) || '', poster: t.poster || (prev && prev.poster) || '', pos, updated: Date.now() });
  saveBookmarks(list);
  toast(pos > 0 ? 'Закладка: ' + fmtPos(pos) : 'Закладка сохранена (с 0:00)');
}
function delBookmark(b) { saveBookmarks(getBookmarks().filter(x => !(x.hash === b.hash && x.file_index === b.file_index))); }

/* ----- Избранное ----- */
async function renderFavorites(root) {
  const list = favList();
  root.innerHTML = `<div class="toolbar"><h1 class="page-title">Избранное</h1>
    <div class="page-sub">Магниты, отложенные в поиске · кнопка «В избранное»</div>
    <span class="spacer"></span>
    <button id="favClear" class="danger">Очистить список</button></div>
    <div id="favBody"></div>`;
  $('#favClear').addEventListener('click', () => { if (list.length && confirm('Очистить весь список избранного?')) { saveFavList([]); renderFavorites($('main')); } });
  const body = $('#favBody');
  if (!list.length) { body.innerHTML = '<div class="empty">Пусто. В результатах поиска нажмите «⋮ → В избранное».</div>'; return; }
  const sorted = [...list].sort((a, b) => (b.time || 0) - (a.time || 0));
  body.innerHTML = '<div class="grid results">' + sorted.map((it, i) => favCard(it, i)).join('') + '</div>';
  $$('.tile.fav', body).forEach(card => bindFavCard(card, sorted[parseInt(card.dataset.ix, 10)]));
  favEnrich(sorted);
}
function favCard(it, ix) {
  const title = it.title || 'магнит';
  return html`
  <div class="tile result fav" data-ix="${ix}">
    <div class="result-poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (it.poster ? 'hidden' : '') + '"'))}
      ${raw(it.poster ? html`<img src="${it.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-fa="play" title="Смотреть"><span class="tri"></span></button>
      <div class="badges"><span class="chip grey">избранное</span></div>
      <div class="rate-stack">
        <span class="chip rating" data-tmdb hidden></span>
        <span class="chip rt-imdb" data-imdb hidden></span>
      </div>
      <div class="poster-flinks">
        <a class="flink" data-fa="kp">Кинопоиск</a>
        <a class="flink" data-fa="imdb">IMDb</a>
      </div>
    </div>
    <div class="body">
      <div class="title-row"><span class="title clamp2" title="${title}">${title}</span></div>
      <div class="metabar">
        <span class="mb-stats">${it.time ? 'добавлено ' + new Date(it.time).toLocaleDateString('ru-RU') : '—'}</span>
      </div>
      <button class="menu-ico" data-menu title="Ещё">⋮</button>
    </div>
    <div class="ctxmenu hidden">
      <button data-fa="magnet">Магнит-ссылка</button>
      <button data-fa="kp">Кинопоиск</button>
      <button data-fa="imdb">IMDb</button>
      <button data-fa="trailer">Трейлер</button>
      <div class="sep"></div>
      <button data-fa="del" class="danger">Удалить</button>
    </div>
  </div>`;
}
function bindFavCard(card, it) {
  if (!it) return;
  const menuBtn = card.querySelector('[data-menu]'); const menu = card.querySelector('.ctxmenu');
  if (menuBtn && menu) menuBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  const act = (sel, fn) => card.querySelectorAll(sel).forEach(b => b.addEventListener('click', () => { if (menu) menu.classList.add('hidden'); fn(); }));
  act('[data-fa="play"]', () => playSearchLink(it));
  act('[data-fa="magnet"]', () => copyToClip(it.magnet || magnetFromHash(it.hash, it.title), 'Магнит скопирован'));
  act('[data-fa="kp"]', () => openExternal(kpSearchUrl(it.title || '')));
  act('[data-fa="imdb"]', () => openExternal(imdbUrlFor(it)));
  act('[data-fa="trailer"]', () => openTrailer(it));
  act('[data-fa="del"]', () => { saveFavList(favList().filter(x => x !== it)); toast('Удалено из избранного'); renderFavorites($('main')); });
}
async function favEnrich(list) {
  /* Та же схема дорожек, что и у библиотеки (ratingsOnce + RATING_WORKERS):
     прежний последовательный обход с паузой 60 мс на карточку растягивал показ
     избранного на секунды, а повтор одного названия спрашивал сервис дважды. */
  const tasks = [];
  const byKey = new Map();
  list.forEach((it, i) => {
    const c = cleanSearchTitle(it.title || '');
    if (!c.q) return;
    const key = c.q + '|' + c.year;
    const known = byKey.get(key);
    if (known) { known.ixs.push(i); return; }
    const task = { c, ixs: [i] };
    byKey.set(key, task);
    tasks.push(task);
  });
  let next = 0;
  const worker = async () => {
    for (;;) {
      const n = next++;
      if (n >= tasks.length) return;
      const t = tasks[n];
      const j = await ratingsOnce(t.c);
      for (const i of t.ixs) {
        const it = list[i];
        if (j && j.ok && j.poster && !it.poster) {
          it.poster = j.poster;
          saveFavList(list);
          const el = document.querySelector(`.tile.fav[data-ix="${i}"] .result-poster`);
          if (el) { const svg = el.querySelector('svg'); if (svg) svg.classList.add('hidden'); el.insertAdjacentHTML('beforeend', html`<img src="${j.poster}" loading="lazy" onerror="this.remove()">`); }
        }
        applyRatingChips(`.tile.fav[data-ix="${i}"]`, j);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RATING_WORKERS, tasks.length) }, worker));
}

/* ----- Закладки просмотра ----- */
async function renderBookmarks(root) {
  const list = getBookmarks();
  root.innerHTML = `<div class="toolbar"><h1 class="page-title">Закладки просмотра</h1>
    <div class="page-sub">Позиции, которые плееры не запоминают. Сохраняются в карточке торрента («⋮ → Закладка») или в окне «Инфо».</div>
    <span class="spacer"></span>
    <button id="bmClear" class="danger">Очистить</button></div>
    <div id="bmBody"></div>`;
  $('#bmClear').addEventListener('click', () => { if (list.length && confirm('Удалить все закладки?')) { saveBookmarks([]); renderBookmarks($('main')); } });
  const body = $('#bmBody');
  if (!list.length) { body.innerHTML = '<div class="empty">Закладок пока нет.</div>'; return; }
  let viewed = []; try { viewed = await tsJson('/viewed', { action: 'list' }); state.viewed = viewed; } catch {}
  const rows = list.map(b => {
    const v = viewed.find(x => x.hash === b.hash && x.file_index === b.file_index);
    const cur = v && v.timecode > 0 ? v.timecode : (b.pos || 0);
    return Object.assign({}, b, { cur });
  });
  body.innerHTML = '<div class="grid results">' + rows.map((b, i) => bookmarkCard(b, i)).join('') + '</div>';
  $$('.tile.bm', body).forEach(card => bindBookmarkCard(card, rows[parseInt(card.dataset.ix, 10)]));
  bookmarkEnrich(rows);
}
async function bookmarkEnrich(list) {
  // Как и favEnrich: несколько дорожек вместо последовательного обхода с
  // паузой 60 мс на карточку.
  const tasks = [];
  const byKey = new Map();
  list.forEach((b, i) => {
    const c = cleanSearchTitle(b.title || '');
    if (!c.q) return;
    const key = c.q + '|' + c.year;
    const known = byKey.get(key);
    if (known) { known.ixs.push(i); return; }
    const task = { c, ixs: [i] };
    byKey.set(key, task);
    tasks.push(task);
  });
  let next = 0;
  const worker = async () => {
    for (;;) {
      const n = next++;
      if (n >= tasks.length) return;
      const t = tasks[n];
      const j = await ratingsOnce(t.c);
      for (const i of t.ixs) applyRatingChips(`.tile.bm[data-ix="${i}"]`, j);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RATING_WORKERS, tasks.length) }, worker));
}
function bookmarkPos(b) { return Number(b.pos || b.cur || 0); }
function bookmarkCard(b, ix) {
  const title = b.title || '—';
  const pos = bookmarkPos(b) > 0 ? fmtPos(bookmarkPos(b)) : null;
  return html`
  <div class="tile result bm" data-ix="${ix}">
    <div class="result-poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (b.poster ? 'hidden' : '') + '"'))}
      ${raw(b.poster ? html`<img src="${b.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-bm="resume" title="${pos ? 'Продолжить' : 'Смотреть'}"><span class="tri"></span></button>
      <div class="badges"><span class="chip series">закладка</span></div>
      <div class="rate-stack">
        <span class="chip rating" data-tmdb hidden></span>
        <span class="chip rt-imdb" data-imdb hidden></span>
      </div>
      <div class="poster-flinks">
        <a class="flink" data-bm="kp">Кинопоиск</a>
        <a class="flink" data-bm="imdb">IMDb</a>
      </div>
    </div>
    <div class="body">
      <div class="title-row"><span class="title clamp2" title="${title}">${title}</span></div>
      <div class="metabar">
        <span class="mb-stats">${b.file ? b.file : 'файл ' + b.file_index}${raw(pos ? ' &nbsp;·&nbsp; ' + pos : '')}</span>
      </div>
      <button class="menu-ico" data-menu title="Ещё">⋮</button>
    </div>
    <div class="ctxmenu hidden">
      <button data-bm="resume">Продолжить (${pos ? pos : 'с начала'})</button>
      <button data-bm="from0">С начала</button>
      <div class="sep"></div>
      <button data-bm="kp">Кинопоиск</button>
      <button data-bm="imdb">IMDb</button>
      <div class="sep"></div>
      <button data-bm="del" class="danger">Удалить закладку</button>
    </div>
  </div>`;
}
/* playBookmark открывает сохранённую закладку. Раздачу и номер файла получает
   демон: он отдаёт плееру плейлист раздачи и ставит продолжение с места
   остановки. Параметра pos в адресе потока нет — TorrServer его не разбирает. */
async function playBookmark(b, fromZero) {
  const known = (state.lib || []).find(x => x.hash === b.hash);
  if (!known) { try { await torrentAction('add', { link: b.hash, save_to_db: true }); } catch {} }
  await torrentAction('start', { hash: b.hash }).catch(() => {});
  const st = await statTorrent(b.hash).catch(() => null);
  if (st && Array.isArray(st.file_stats)) rememberStat(b.hash, st);
  const files = (st && st.file_stats) || (known && known.file_stats) || [];
  const f = files.find(x => x.id === b.file_index) || files.find(x => isPlayable(x.path));
  if (!f) { toast('Файл закладки в раздаче не найден', true); return; }
  const t = Object.assign({}, known || { hash: b.hash, title: b.title, name: b.title }, { file_stats: files });
  const at = fromZero ? 0 : bookmarkPos(b);
  await savePosition(b.hash, f.id, at, 0, false);
  toast(fromZero ? 'Смотрим с начала' : (at > 0 ? 'Продолжаем с ' + fmtPos(at) : 'Запуск...'));
  saveBookmarks(getBookmarks().map(x => x === b ? Object.assign(x, { pos: at }) : x));
  return playSelected(t, f, { fromZero });
}
function bindBookmarkCard(card, b) {
  if (!b) return;
  const menuBtn = card.querySelector('[data-menu]'); const menu = card.querySelector('.ctxmenu');
  if (menuBtn && menu) menuBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  const act = (sel, fn) => card.querySelectorAll(sel).forEach(x => x.addEventListener('click', () => { if (menu) menu.classList.add('hidden'); fn(); }));
  act('[data-bm="resume"]', () => playBookmark(b, false));
  act('[data-bm="from0"]', () => playBookmark(b, true));
  act('[data-bm="kp"]', () => openExternal(kpSearchUrl(b.title || '')));
  act('[data-bm="imdb"]', () => openExternal(imdbUrlFor(b)));
  act('[data-bm="del"]', () => { delBookmark(b); toast('Закладка удалена'); renderBookmarks($('main')); });
}

/* ================= SEARCH ================= */
const SEARCH_PROVIDERS = ['rutor', 'torznab', 'kinozal', 'both'];
let searchAbort = null;

// Состояние постраничной выдачи. Ключ — источник: у rutor и Кинозала страницы
// независимы, и «Показать ещё» должно продолжать тот источник, который
// показан, а не всегда rutor.
//
// Раньше клиент брал первые 40 строк из 100 и следующую страницу не давал вовсе,
// поэтому нужная раздача могла быть просто не видна.
let moreSources = {};
const SRC_PAGE = { rutor: 100, kinozal: 50 };
function hasMore() {
  return Object.entries(moreSources).some(([p, s]) => s.count >= (SRC_PAGE[p] || 0));
}

async function renderSearch(root) {
  const sd = state.searchState;
  const hist = searchHistory();
  root.innerHTML = html`
    <div class="toolbar">
      <h1 class="page-title">Поиск</h1>
      <input class="search-input" id="searchInput" placeholder="Название фильма или сериала..." value="${sd.q}">
      <button id="searchBtn" class="primary">Найти</button>
      <select id="searchCat" title="Категория" style="width:auto">
        ${raw(CATS.map(c => html`<option value="${c.v}">${c.label}</option>`).join(''))}
      </select>
      <select id="searchQual" title="Качество раздачи" style="width:auto">
        ${raw(Object.entries(QUAL).map(([v, q]) => html`<option value="${v}">${q.label}</option>`).join(''))}
      </select>
      <label style="margin:0;display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:12px" title="Прятать из выдачи игры, софт и книги"><input type="checkbox" id="searchVid"> только видео</label>
      <select id="searchProv" title="Источник" style="width:auto">
        <option value="rutor">rutor</option>
        <option value="torznab">Torznab</option>
        <option value="kinozal">Кинозал.ТВ</option>
        <option value="both">Все источники</option>
      </select>
      <button id="top24Btn" class="top24btn">ТОП-24</button>
      <span class="spacer"></span>
      <button class="primary" data-open="add" title="Добавить торрент">+ Добавить</button>
    </div>
    <div class="quick">
      <span class="qlabel">Быстро:</span>
      ${raw(CATS.filter(c => c.v).slice(0, 5).map(c => html`<button data-cat="${c.v}">${c.label.split(' ').pop()}</button>`).join(''))}
      <span class="spacer"></span>
      <label style="margin:0;display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:12px"><input type="checkbox" id="searchAppend"> добавить к текущим</label>
    </div>
    ${raw(hist.length ? html`<div class="quick"><span class="qlabel">История:</span>${raw(hist.map(h => html`<button data-hq="${h}">${h}</button>`).join(''))}</div>` : '')}
    <div id="searchResults"></div>`;

  $('#searchProv').value = sd.provider;
  $('#searchCat').value = sd.cat || '';
  $('#searchQual').value = qualOn();
  $('#searchBtn').addEventListener('click', () => doSearch());
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#searchProv').addEventListener('change', () => sd.provider = $('#searchProv').value);
  $('#searchCat').addEventListener('change', () => { sd.cat = $('#searchCat').value; sd.showAll = false; updateTopBtnLabel(); paintResults($('#searchResults')); });
  $('#searchQual').addEventListener('change', () => { setQual($('#searchQual').value); paintResults($('#searchResults')); });
  const vidBox = $('#searchVid');
  if (vidBox) {
    vidBox.checked = videoOnlyPref();
    vidBox.addEventListener('change', () => {
      setVideoOnlyPref(vidBox.checked);
      state.searchState.showAll = false; // настройка важнее разового «показать всё»
      paintResults($('#searchResults'));
    });
  }
  $$('[data-cat]').forEach(b => b.addEventListener('click', () => {
    $('#searchCat').value = b.dataset.cat;
    sd.cat = b.dataset.cat;
    updateTopBtnLabel();
    doSearch();
  }));
  $$('[data-hq]').forEach(b => b.addEventListener('click', () => { $('#searchInput').value = b.dataset.hq; doSearch(); }));
  $('#top24Btn').addEventListener('click', onTopClick);
  $('[data-open="add"]').addEventListener('click', openAddModal);
  updateTopBtnLabel();
  paintResults($('#searchResults'));
  if (!state.searchState.results.length && !sd.q) onTopClick();
}

// Категории поиска.
//
// Ключ — значение выпадающего списка, оно же имя раздела для топа Кинозала.
// Рядом стоит код категории rutor: у трекера категория это поле адреса выдачи,
// а не слово запроса. Коды сняты с <select name="category"> на живой странице
// 20.09.2026 и проверены запросами (8 — игры, 1 — зарубежные фильмы,
// 11 — книги).
const CATS = [
  { v: '', rutor: 0, top: '', label: 'Все категории' },
  { v: 'фильм', rutor: 1, top: 'kino', label: 'Зарубежные фильмы' },
  { v: 'нашфильм', rutor: 5, top: 'kino', label: 'Наши фильмы' },
  { v: 'сериал', rutor: 4, top: 'seriali', label: 'Зарубежные сериалы' },
  { v: 'нашесериал', rutor: 16, top: 'seriali', label: 'Наши сериалы' },
  { v: 'мультфильм', rutor: 7, top: 'multiki', label: 'Мультфильмы' },
  { v: 'аниме', rutor: 10, top: 'anime', label: 'Аниме' },
  { v: 'музыка', rutor: 2, top: 'audio', label: 'Музыка' },
  { v: 'софт', rutor: 9, top: 'soft', label: 'Софт' },
  { v: 'игры', rutor: 8, top: '', label: 'Игры' },
  { v: 'книги', rutor: 11, top: '', label: 'Книги' },
];
const TOPCAT = Object.fromEntries(CATS.map(c => [c.v, { sec: c.top, label: c.label }]));
function topSel() {
  const el = $('#searchCat');
  return TOPCAT[el ? el.value : ''] || TOPCAT[''];
}
// rutorCat переводит значение списка в код категории, понятный трекеру.
function rutorCat() {
  const el = $('#searchCat');
  const c = CATS.find(x => x.v === (el ? el.value : ''));
  return c ? c.rutor : 0;
}
function updateTopBtnLabel() {
  const b = $('#top24Btn'); if (!b) return;
  if (b.disabled) { b.textContent = 'Загрузка...'; return; }
  const t = topSel();
  b.textContent = t.sec ? 'ТОП-24: ' + t.label : 'ТОП-24';
}

// Фильтр качества раздачи.
//
// Прежде рядом стояли кнопки «1080p» и «2160p», которые дописывали в запрос
// «!1080» и «!2160». Такого оператора у rutor нет: запрос уходил фразой целиком,
// и выдача была пустой всегда. Качество отбирается здесь, по названию раздачи.
const QUAL = {
  '': { label: 'Любое качество', ok: () => true },
  'fhd': { label: '1080p и выше', ok: t => isFullHD(t) },
  '4k': { label: '4K', ok: t => /(2160|4k|uhd)/i.test(String(t || '')) },
};
function qualOn() { const q = localStorage.getItem('tc_qual'); return QUAL[q] ? q : 'fhd'; }
function setQual(q) { localStorage.setItem('tc_qual', QUAL[q] ? q : 'fhd'); }
function isFullHD(title) {
  const t = String(title || '').toLowerCase();
  if (/(2160|4k|uhd|1080)/.test(t)) return true;
  return !/(720p|576p|480p|540p|360p|240p|hdtv|sdtv|satrip|tvrip|dvbrip|dvb\b|iptvrip|camrip|\bcam\b|vhsrip|vhs\b|dvdscr|\bdvd5\b|\bdvd9\b|\bwebrip\b|\bts\b)/.test(t);
}

// Отсев не-видео.
//
// Поиск по умолчанию идёт по всем категориям трекера (cat=0), поэтому на запрос
// «ведьмак» приходят и сериал, и одноимённая игра, и книга по вселенной, а
// приложение — для фильмов и сериалов.
//
// Слово «игра» как признак не годится: «Игра престолов», «Голодные игры» и «Игры
// разума» — фильмы, и по одному слову выбросилась бы половина каталога. Смотрятся
// только маркеры, которых в названиях фильмов не бывает: имена перепаковщиков,
// «RePack», платформа «PC», версия вида «[v 1.32]», кодеки активации, книжные
// форматы.
const NON_VIDEO = [
  { kind: 'игра', re: /(re-?pack|fitgirl|\bdodi\b|elamigos|xatab|steam-?rip|r\.?g\.?[\s.-]*mechanics|skidrow|\bcpy\b|\bflt\b|tenoke|insaneramzes|hoodlum|mr[ _]?dj|kaoskrew|\bsebik\b)/i },
  { kind: 'игра', re: /(^|[\s|[(])PC([\s|)\]]|$)/i },
  { kind: 'игра', re: /\[v\s*\d+(?:\.\d+){1,3}[^\]]*\]/i },
  { kind: 'игра', re: /\b(playstation|xbox|nintendo|\bps[2-5]\b)\b/i },
  { kind: 'софт', re: /\b(x64|x86|win64|win32|portable|activat\w*|keygen|crack)\b/i },
  /* Без \b: в JavaScript граница слова считается только по \w, а это одна
     латиница и цифры — \bактиватор не совпадает никогда. */
  { kind: 'софт', re: /(активатор|кейген|кряк|взломанн\w*|лекарство)/i },
  { kind: 'софт', re: /\bwindows\s*(?:xp|vista|7|8|10|11)\b/i },
  { kind: 'книга', re: /\b(fb2|epub|djvu|mobi)\b/i },
  { kind: 'книга', re: /аудиокниг/i },
  /* Только со счётчиком в скобках: просто «книга» ловит и «Книгу джунглей». */
  { kind: 'книга', re: /\[\s*\d+\s*книг/i },
  { kind: 'книга', re: /\[\s*книг/i },
];

// Признак видеораздачи: качество, кодек, раздача сериала. Нужен не для отсева, а
// чтобы не принять за книгу старый DVDRip — у него звук тоже MP3.
const VIDEO_MARK = /(1080|720|2160|4k|uhd|480|360|bdrip|brrip|web-?dl|webrip|hdrip|dvdrip|hdtv|sdtv|remux|\bavc\b|hevc|x26[45]|\bdts\b|\bac3\b|\baac\b|сезон|\bs\d{1,2}e\d{1,2}|\[s\d{1,2})/i;

// nonVideoKind отвечает, на что похожа раздача: '' — видео, иначе род («игра»,
// «софт», «книга»). Род нужен не только для отсева, но и для объяснения: «в
// выдаче только игры» понятнее, чем «ничего не найдено».
function nonVideoKind(title) {
  const t = String(title || '');
  for (const p of NON_VIDEO) {
    if (p.re.test(t)) return p.kind;
  }
  /* Аудиокнига: сам по себе MP3 ничего не значит — у старых DVDRip звук тоже
     MP3, и поэтому одна книга не должна выбросить половину старого каталога.
     Книга — это MP3 без единого признака видеораздачи. */
  if (/(?:^|[\s|(])(?:MP3|МР3)\b/.test(t) && !VIDEO_MARK.test(t)) return 'книга';
  return '';
}

// splitNonVideo делит выдачу на видео и остальное, **ничего не выбрасывая**:
// скрытые раздачи остаются в state.searchState.results, поэтому «показать всё»
// возвращает их без повторного запроса к трекеру.
function splitNonVideo(rows) {
  const keep = [];
  const drop = [];
  for (const r of rows || []) {
    if (!r) continue;
    (nonVideoKind(r.title || r.name || '') ? drop : keep).push(r);
  }
  return { keep, drop };
}

// videoOnlyPref — настройка «только видео», она запоминается (как и качество) в
// localStorage. Выключенная означает «показывать всё, что нашлось»: иногда игра
// или софт и есть цель поиска, и заставлять человека снимать отсев каждый раз
// нельзя. Ключ 'tc_vid', значение '0' — выключено; отсутствие ключа — включено.
function videoOnlyPref() { return localStorage.getItem('tc_vid') !== '0'; }
function setVideoOnlyPref(v) { localStorage.setItem('tc_vid', v ? '1' : '0'); }

// videoOnlyOn: не-видео скрывается при «всех категориях». Выбрав «Игры», «Софт»,
// «Книги» или «Музыку», пользователь просит именно их — отсев молча уничтожил бы
// всю выдачу. showAll снимает отсев на текущий поиск.
function videoOnlyOn() {
  const st = state.searchState;
  if (st && st.showAll) return false;
  if (!videoOnlyPref()) return false;
  const el = $('#searchCat');
  const c = el ? el.value : '';
  return !(c === 'игры' || c === 'софт' || c === 'книги' || c === 'музыка');
}
async function onTopClick() {
  let t = topSel();
  if (!t.sec && (sd.provider === 'kinozal' || sd.provider === 'both')) {
    t = { sec: 'kino', label: 'Кинозал → Фильмы' };
  }
  return t.sec ? fetchTopCat(t.sec, t.label) : fetchTop24();
}

function searchHistory() {
  try { const h = JSON.parse(localStorage.getItem('tc_sq') || '[]'); return Array.isArray(h) ? h.slice(0, 8) : []; } catch { return []; }
}
function pushSearchHistory(q) {
  if (!q) return;
  let h = searchHistory().filter(x => x.toLowerCase() !== q.toLowerCase());
  h.unshift(q);
  try { localStorage.setItem('tc_sq', JSON.stringify(h.slice(0, 8))); } catch {}
}

async function fetchTop24() {
  const button = $('#top24Btn');
  const el = $('#searchResults');
  if (!button) return;
  button.disabled = true; button.textContent = 'Загрузка...';
  el.innerHTML = '<div class="empty">Сбор ТОП-24 за последние 24 часа...</div>';
  let resp = null;
  try {
    const rr = await fetch('/api/top24');
    resp = await rr.json();
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
  } catch (e) {
    button.disabled = false; updateTopBtnLabel();
    el.innerHTML = html`<div class="empty">Не удалось получить ТОП-24: ${e.message}</div>`;
    return;
  }
  const items = (resp.items || []).map(r => row2res(r, 'top24')).filter(x => x !== null);
  items.sort((a, b) => (b.seed || 0) - (a.seed || 0));
  // Число 24 в названии кнопки — это часы, а не количество строк. Показывается
  // весь блок «Топ торренты за последние 24 часа» (на живой странице — 30
  // раздач): прежняя обрезка до 24 выбрасывала из топа суток свежие раздачи с
  // меньшим числом сидов, и выдача молча обрывалась на двадцать четвёртой.
  state.searchState.results = items;
  state.searchState.q = '';
  state.searchState.topLabel = '';
  moreSources = {};
  state.top24Hash = resp.hash || '';
  button.disabled = false; updateTopBtnLabel();
  paintResults(el);
}
async function fetchTopCat(sec, label) {
  const button = $('#top24Btn');
  const el = $('#searchResults');
  if (!button) return;
  button.disabled = true; button.textContent = 'Загрузка...';
  el.innerHTML = html`<div class="empty">Сбор ТОП раздела «${label}» (по сидам)...</div>`;
  let resp = null;
  try {
    const rr = await fetch('/api/topcat?cat=' + encodeURIComponent(sec));
    resp = await rr.json();
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
  } catch (e) {
    button.disabled = false; updateTopBtnLabel();
    el.innerHTML = html`<div class="empty">Не удалось получить ТОП: ${e.message}</div>`;
    return;
  }
  const items = (resp.items || []).map(r => row2res(r, 'topcat')).filter(x => x !== null);
  items.sort((a, b) => (b.seed || 0) - (a.seed || 0));
  // Топ раздела — та же кнопка ТОП-24, и обрезка по числу строк здесь так же
  // неуместна: демон отдаёт до сотни свежих раздач раздела, и все они нужны.
  state.searchState.results = items;
  state.searchState.q = '';
  state.searchState.topLabel = label;
  moreSources = {};
  state.top24Hash = '';
  button.disabled = false; updateTopBtnLabel();
  paintResults(el);
}
function parseSizeBytes(s) {
  if (s == null) return null;
  if (typeof s === 'number' && isFinite(s)) return s;
  const m = String(s).match(/([\d.]+)\s*([KMGT]?B?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const mult = { '': 1, B: 1, K: 1e3, KB: 1e3, M: 1e6, MB: 1e6, G: 1e9, GB: 1e9, T: 1e12, TB: 1e12 }[(m[2] || '').toUpperCase()];
  return mult ? Math.round(n * mult) : null;
}
function row2res(r, provider) {
  if (!r || !r.title) return null;
  const sz = r.size ? r.size.match(/([\d.]+)\s*([KMGT]?B)/i) : null;
  const sizeBytes = sz ? parseFloat(sz[1]) * ({ K: 1e3, M: 1e6, G: 1e9, T: 1e12 })[(sz[2] || '').charAt(0).toUpperCase()] || 0 : 0;
  return {
    title: r.title, size_bytes: sizeBytes, size: r.size || '',
    seed: r.seed, peer: r.peer, link: r.link, hash: r.hash, magnet: r.magnet,
    date: r.date, provider: provider || 'top24'
  };
}

// splitExclusions вынимает из запроса слова-исключения: «ведьмак -игра» ищет
// «ведьмак», но выбрасывает из выдачи всё, в названии чего есть «игра».
//
// Исключение не уходит на трекер: rutor ищет фразу целиком, и «ведьмак -игра»
// отдал бы раздачи, в названии которых стоит слово «игра». Поэтому слова
// вынимаются из запроса, а отсев делается здесь, по названию раздачи.
function splitExclusions(q) {
  const keep = [];
  const drop = [];
  for (const w of String(q || '').split(/\s+/)) {
    if (!w) continue;
    if (w.length > 1 && w[0] === '-') {
      const t = w.slice(1).toLowerCase();
      if (t) drop.push(t);
      continue;
    }
    keep.push(w);
  }
  return { q: keep.join(' '), drop };
}

// excludedBy отвечает, из-за какого слова раздача уходит из выдачи.
function excludedBy(title, drop) {
  if (!drop || !drop.length) return '';
  const t = String(title || '').toLowerCase();
  for (const w of drop) {
    if (t.indexOf(w) >= 0) return w;
  }
  return '';
}

async function doSearch() {
  const input = $('#searchInput');
  const raw = (input ? input.value || '' : '').trim();
  const parts = splitExclusions(raw);
  const q = parts.q;
  state.searchState.q = raw; // в поле остаётся то, что ввёл пользователь
  state.searchState.topLabel = '';
  if (!q) return toast('Введите запрос', true);
  const prov = state.searchState.provider;
  // Категория уходит на трекер отдельным полем адреса, а не словом запроса:
  // «фильм 2024» искало раздачи, в названии которых есть слово «фильм», и
  // выдача сужалась до пустоты.
  const cat = rutorCat();
  sd().append = $('#searchAppend') && $('#searchAppend').checked;
  sd().showAll = false; // новый поиск снова прячет не-видео
  sd().exclude = parts.drop; // «ведьмак -игра» отсекает игру по названию
  state.searchState.results = sd().append ? state.searchState.results : [];
  moreSources = {};
  if (prov === 'rutor' || prov === 'both') moreSources.rutor = { query: q, page: 0, count: 0, cat };
  if (prov === 'kinozal' || prov === 'both') moreSources.kinozal = { query: q, page: 0, count: 0, cat: 0 };
  paintResults($('#searchResults'));
  const el = $('#searchResults');
  el.innerHTML = '<div class="empty">Поиск...</div>';
  state.searchState.tznabOff = null;
  const jobs = [];
  const errs = [];
  const add = (p, promise) => jobs.push(promise.catch(e => {
    errs.push(p + ': ' + e.message);
    if (p === 'torznab') { state.searchState.tznabOff = 'Torznab не настроен на сервере — поиск ведётся только по остальным источникам'; return; }
    toast(p + ': ' + e.message, true);
  }).then(r => {
    if (r && r.length) { state.searchState.results = mergeResults(state.searchState.results, r); }
    else if (p !== 'torznab') errs.push(p + ': 0 результатов');
  }));
  if (moreSources.rutor) add('rutor', searchRutor(q, 0, cat).then(r => { moreSources.rutor.count = r.length; return r; }));
  if (prov === 'torznab' || prov === 'both') add('torznab', searchTorznab(q));
  if (moreSources.kinozal) add('kinozal', searchKinozal(q, 0).then(r => { moreSources.kinozal.count = r.length; return r; }));
  await Promise.all(jobs);
  state.searchState.status = errs;
  pushSearchHistory(q);
  paintResults(el);
}
const sd = () => state.searchState;

// mergeResults добавляет новое к уже показанному, выбрасывая повторы.
//
// Одна и та же раздача приходит и от rutor, и от Кинозала, а при догрузке
// страниц повторяется ещё раз: у трекера нумерация сдвигается, если между
// запросами добавили новую раздачу. Ключ — хеш, а при его отсутствии название
// с размером (у Кинозала магнита в выдаче нет, и хеша тоже).
function mergeResults(base, add) {
  const seen = new Set();
  const out = [];
  for (const r of (base || []).concat(add || [])) {
    if (!r) continue;
    const key = r.hash
      ? String(r.hash).toLowerCase()
      : (String(r.title || r.name || '').toLowerCase() + '\u0000' + (r.size || ''));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function searchKinozal(q, page) {
  const arr = await apiGetJSON('/api/kinozal/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0));
  if (!Array.isArray(arr)) throw new Error((arr && arr.error) || 'пустой ответ Кинозал');
  return (arr || []).map(it => ({
    _p: 'kinozal', title: it.title, name: it.title, size: it.size, size_bytes: parseSizeBytes(it.size) || it.size_bytes || null,
    seed: it.seed, peer: it.peer, magnet: it.magnet, hash: it.hash, link: it.link, get: it.get, date: it.date,
  }));
}

// apiGetJSON читает ответ как JSON и достаёт причину из тела при ошибке.
// Раньше на любой не-200 показывалось «HTTP 502», и настоящая причина
// («трекер не ответил», «капча») терялась, а пустая выдача выглядела как
// «ничего не найдено».
async function apiGetJSON(url) {
  const r = await fetch(url);
  let body = null;
  try { body = await r.json(); } catch { /* тело не JSON — покажем код */ }
  if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
  return body;
}

async function searchRutor(q, page, cat) {
  const arr = await apiGetJSON('/api/rutor/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0) + '&cat=' + (cat | 0));
  if (!Array.isArray(arr)) throw new Error((arr && arr.error) || 'пустой ответ rutor');
  return (arr || []).map(it => {
    const g = (a, b) => (it[a] != null ? it[a] : it[b]);
    return {
      _p: 'rutor', title: g('title', 'Title') || g('name', 'Name'), name: g('name', 'Name'), year: g('year', 'Year'),
      categories: g('categories', 'Categories'), size: g('size', 'Size'), size_bytes: parseSizeBytes(g('size', 'Size')), tracker: g('tracker', 'Tracker'),
      seed: g('seed', 'Seed'), peer: g('peer', 'Peer'), magnet: g('magnet', 'Magnet'), hash: g('hash', 'Hash'), link: g('link', 'Link'),
      imdb_id: g('imdb_id', 'IMDBID') || g('imdb', 'IMDB'),
      video_quality: g('video_quality', 'VideoQuality'),
      audio_quality: g('audio_quality', 'AudioQuality'),
      poster: g('poster', 'Poster'),
      data: it,
    };
  });
}
// loadMore догружает следующую страницу тех источников, которые отдали полную
// страницу. Страницы у трекеров нумеруются с нуля, поэтому первая уже
// загружена как 0.
async function loadMore() {
  const targets = Object.entries(moreSources).filter(([p, s]) => s.count >= (SRC_PAGE[p] || 0));
  if (!targets.length) return;
  const btn = $('#moreBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Загрузка...'; }
  for (const [p, s] of targets) {
    try {
      const next = p === 'kinozal'
        ? await searchKinozal(s.query, s.page + 1)
        : await searchRutor(s.query, s.page + 1, s.cat);
      s.page += 1;
      s.count = next.length;
      if (next.length) state.searchState.results = mergeResults(state.searchState.results, next);
    } catch (e) {
      toast(p + ': ' + e.message, true);
      s.count = 0;
    }
  }
  paintResults($('#searchResults'));
}

async function searchTorznab(q) {
  const arr = await apiGetJSON(ts('/torznab/search?query=' + encodeURIComponent(q)));
  return (arr || []).map(it => {
    const g = (a, b) => (it[a] != null ? it[a] : it[b]);
    return {
      _p: 'torznab', title: g('name', 'Name') || g('title', 'Title'), name: g('name', 'Name'), year: g('year', 'Year'),
      size_bytes: parseSizeBytes(g('size_bytes', 'Size')), size: g('size', 'Size'), seed: g('seed', 'Seed'), peer: g('peer', 'Peer'),
      magnet: g('magnet', 'Magnet'), hash: g('hash', 'Hash'), poster: g('poster', 'Poster'), imdb_id: g('imdb_id', 'IMDBID'), link: g('link', 'Link'), data: it,
    };
  });
}

function paintResults(el) {
  const needProvider = el || $('#searchResults');
  const rows = state.searchState ? state.searchState.results : [];
  const qual = QUAL[qualOn()] || QUAL['fhd'];
  const status = state.searchState.status || [];
  if (!rows.length) {
    if (needProvider) needProvider.innerHTML = '<div class="empty">Нет результатов.' + (status.length ? '' : ' Включите поиск на сервере (вкладка Сервер → rutor/Torznab).') + '</div>'
      + (status.length ? html`<div class="hint" style="text-align:center;margin-top:8px">${status.join(' · ')}</div>` : '');
    return;
  }
  let rows2 = rows.filter(r => qual.ok(r.title || r.name || ''));
  /* Не-видео скрывается при «всех категориях»: выбрав «Игры» или «Софт»,
     пользователь просит именно их. Скрытые раздачи из выдачи не выбрасываются —
     их вернёт «показать всё». */
  const onlyVideo = videoOnlyOn();
  let hidden = 0;
  if (onlyVideo) {
    const parts = splitNonVideo(rows2);
    rows2 = parts.keep;
    hidden = parts.drop.length;
  }
  /* Слова-исключения из запроса («ведьмак -игра»). Исключение задал сам
     пользователь, поэтому «показать всё» его не отменяет — отменяет только
     отсев не-видео, который включён по умолчанию. */
  const excl = (state.searchState && state.searchState.exclude) || [];
  let hiddenEx = 0;
  if (excl.length) {
    const kept = [];
    for (const r of rows2) {
      if (excludedBy(r.title || r.name || '', excl)) { hiddenEx++; continue; }
      kept.push(r);
    }
    rows2 = kept;
  }
  if (!rows2.length) {
    let why = 'Нет результатов по фильтру Full HD. Снимите галочку «Full HD».';
    if (hiddenEx) why = 'Всё, что нашлось, подпадает под исключение ' + excl.map(w => '-' + w).join(' ') + '. Уберите его из запроса.';
    else if (hidden) why = 'В выдаче только игры, софт или книги. Нажмите «показать всё» рядом с сортировкой.';
    needProvider.innerHTML = html`<div class="empty">${why}</div>`;
    return;
  }
  const sort = state.searchState.sort || 'seed';
  const sorted = [...rows2].sort((a, b) => {
    if (sort === 'size') return (b.size_bytes || b.size || 0) - (a.size_bytes || a.size || 0);
    if (sort === 'name') return (a.title || a.name || '').localeCompare(b.title || b.name || '', 'ru');
    if (sort === 'peer') return (b.peer || 0) - (a.peer || 0);
    return (b.seed || 0) - (a.seed || 0);
  });
  const isTop = rows2.length && rows2.every(r => r.provider === 'top24' || r.provider === 'topcat');
  const fhdNote = qualOn() ? ' · ' + qual.label : '';
  const topLabel = state.searchState.topLabel || '';
  const sortLabel = sort === 'peer' ? 'по личам' : 'по сидам';
  // В заголовке видно, сколько раздач в блоке суток: иначе «ТОП-24» читается
  // как «двадцать четыре строки», и обрыв выдачи выглядит нормой.
  const head = topLabel ? 'ТОП раздела: ' + topLabel + ' (' + sortLabel + ')' : (isTop ? 'ТОП-24 за последние 24 часа (' + rows2.length + ')' : 'Результаты (' + rows2.length + ')' + fhdNote);
  needProvider.innerHTML = html`<h2 class="section">${head}
    <select id="resSort" style="width:auto" title="Сортировка">
      <option value="seed" ${sort === 'seed' ? 'selected' : ''}>по сидам</option>
      <option value="peer" ${sort === 'peer' ? 'selected' : ''}>по личам</option>
      <option value="size" ${sort === 'size' ? 'selected' : ''}>по размеру</option>
      <option value="name" ${sort === 'name' ? 'selected' : ''}>по имени</option>
    </select>
    ${raw(hasMore() ? '<button id="moreBtn" class="primary" style="margin-left:8px" title="Следующая страница выдачи">Показать ещё</button>' : '')}
    ${raw(hidden ? html`<span class="hint" style="margin:0">скрыто ${hidden} не-видео</span><button id="showAllBtn" style="width:auto" title="Вернуть игры, софт и книги в выдачу">показать всё</button>` : '')}
    ${raw(hiddenEx ? html`<span class="hint" style="margin:0">скрыто ${hiddenEx} по «${excl.map(w => '-' + w).join(' ')}»</span>` : '')}
    ${raw(state.searchState.tznabOff ? html`<span class="hint" style="margin:0">${state.searchState.tznabOff}</span>` : '')}
    ${raw(status.length ? html`<span class="hint" style="margin:0">${status.join(' · ')}</span>` : '')}
  </h2>
  <div class="grid results">` +
    sorted.map((res, i) => resultRow(res, rows.indexOf(res))).join('') +
    `</div>`;
  const so = $('#resSort'); if (so) so.addEventListener('change', () => { state.searchState.sort = so.value; paintResults($('#searchResults')); });
  const mb = $('#moreBtn'); if (mb) mb.addEventListener('click', loadMore);
  const sab = $('#showAllBtn'); if (sab) sab.addEventListener('click', () => { state.searchState.showAll = true; paintResults($('#searchResults')); });
  $$('.result', needProvider).forEach(row => bindResult(row));
  updateFavMarks();
  enrichPosters(sorted, rows);
}

/* ---------- result card (grid) ---------- */
function resultRow(r, ix) {
  const q = qTag(r.title || '');
  const isSer = isSeries(r.title || '');
  const sz = r.size_bytes ? fmtSize(r.size_bytes) : (r.size || '');
  const title = r.title || r.name || '';
  const mb = [];
  if (r.year) mb.push(r.year);
  if (sz) mb.push(sz);
  if (r.seed != null) mb.push('⬆ ' + r.seed);
  if (r.peer != null) mb.push('👥 ' + r.peer);
  return html`
  <div class="tile result" data-ix="${ix}">
    <div class="result-poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (r.poster ? 'hidden' : '') + '"'))}
      ${raw(r.poster ? html`<img src="${r.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-sa="play" title="Смотреть"><span class="tri"></span></button>
      <button class="fav-ov" data-sa="fav" title="В избранное">♥</button>
      <div class="badges">
        ${raw(q ? html`<span class="chip ${q}">${q === 'q2160' ? '4K' : '1080p'}</span>` : '')}
        ${raw(isSer ? '<span class="chip series">Сериал</span>' : '')}
        <span class="chip grey">${r._p || ''}</span>
      </div>
      <div class="rate-stack">
        <span class="chip rating" data-tmdb hidden></span>
        <span class="chip rt-imdb" data-imdb hidden></span>
      </div>
      <div class="poster-flinks">
        <a class="flink" data-sa="kp">Кинопоиск</a>
        <a class="flink" data-sa="imdb">IMDb</a>
      </div>
    </div>
    <div class="body">
      <div class="title-row"><span class="title clamp2" title="${title}">${title}</span></div>
      <div class="metabar">
        <span class="mb-stats">${raw(mb.map(esc).join(' &nbsp;·&nbsp; ') || '—')}</span>
      </div>
      <button class="menu-ico" data-menu title="Ещё">⋮</button>
    </div>
    <div class="ctxmenu hidden">
      <button data-sa="kp">Кинопоиск</button>
      <button data-sa="imdb">IMDb</button>
      <div class="sep"></div>
      <button data-sa="magnet">Магнит-ссылка</button>
      <button data-sa="userlist">В избранное</button>
      <button data-sa="trailer">Трейлер на YouTube</button>
      ${raw(r.link ? html`<button data-sa="open">Открыть раздачу</button>` : '')}
      ${raw(r.poster ? html`<button data-sa="poster">Постер</button>` : '')}
    </div>
  </div>`;
}
function cleanSearchTitle(t) {
  let s0 = String(t || '');
  const ym = s0.match(/(19|20)\d{2}/);
  const year = ym ? ym[0] : '';
  const parts = s0.split('/').map(p => p.trim()).filter(Boolean);
  let pick = '';
  for (const p of parts) { if (/[а-яёЁ]/.test(p)) { pick = p; break; } }
  if (!pick) pick = parts[0] || s0;
  let s = pick;
  s = s.replace(/[\[\(][^\]]*?[\]\)]/g, ' ');
  s = s.replace(/(?:^|\s)(от|from)\s+[\wа-яёЁ-]+/gi, ' ');
  s = s.replace(/\b(сезон|листа|из)\s*\d+|S\d{1,2}\s*E\d{1,3}|\d+x\d{1,3}\b|\bобновл\.?\b|\bраздача\b|\bпостер\b|\bлицензи[яе]\b/gi, ' ');
  s = s.replace(/\b(2160p?|4k|uhd|1080p?|720p?|480p?|bdrip|bdremux|web-?dl|web-?d?l?rip|hdrip|dvdrip|hdtv|hdr|sdr|dolby.?vision|avc|hevc|x26[45]|aac|ac3|dts|multi|lossless|remaster(?:ed)?)\b/gi, ' ');
  s = s.replace(/\b[а-яёЁ]\b/g, ' ');
  s = s.replace(/(?:^|\s)[A-Z]\b/g, ' ');
  s = s.replace(/\b(studio|team|hdrezka|rezka|coldfilm|lostfilm|newteam|domino|videofilm|voidfilm|gidonline|kinopub|moviedalen|replica|webdl)\b/gi, ' ');
  s = s.replace(/\s*&\s*\S+/g, ' ');
  s = s.replace(/\s*-\s*/g, ' ');
  s = s.replace(/[|()\[\]_*.,!?;:"'«»«»]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return { q: (s.length > 3 ? s.slice(0, 80) : ''), year };
}
async function getRatings(c) {
  if (!c || !c.q) return null;
  const ck = c.q + '|' + c.year;
  let j = null;
  try { j = JSON.parse(sessionStorage.getItem('rat:' + ck)); } catch {}
  if (j) return j;
  // Запомненный ответ свежее суток — спрашивать нечего: демон держит ровно тот
  // же ответ в своём кэше (tmdbCacheTTL), и запрос вернул бы его же. Это и есть
  // «мгновенная библиотека»: сорок плиток не превращаются в сорок запросов.
  const rec = storedFresh(c);
  if (rec) {
    const a = storedAnswer(rec);
    try { sessionStorage.setItem('rat:' + ck, JSON.stringify(a)); } catch {}
    return a;
  }
  try {
    const u = '/api/ratings?q=' + encodeURIComponent(c.q) + (c.year ? '&year=' + c.year : '');
    const rr = await fetch(u);
    j = await rr.json();
    // Причина отказа — часть ответа: «ключ не задан» и «ключ отклонён» не
    // должны выглядеть как «постера нет у этого фильма».
    if (j && j.error) noteMetaError(j.error);
    if (j && j.ok) {
      try { sessionStorage.setItem('rat:' + ck, JSON.stringify(j)); } catch {}
      // Постоянное хранилище: следующий показ библиотеки возьмёт постер и оценку
      // отсюда, а не из нового запроса к TMDB. Пишется и из поиска — так
      // библиотека наполняется ещё до того, как её открыли.
      rememberMeta(c, j);
    }
  } catch { j = null; }
  return j;
}
function applyRatingChips(scope, j) {
  const tmdb = j && j.ok && j.rating > 0;
  const imdb = j && j.ok && j.imdb > 0;
  function show(el, on, txt, tip) {
    if (on) { el.textContent = txt; el.title = tip || ''; el.removeAttribute('hidden'); }
    else { el.textContent = ''; el.setAttribute('hidden', ''); }
  }
  if (!tmdb && !imdb) {
    $$(String(scope) + ' [data-tmdb]').forEach(el => el.setAttribute('hidden', ''));
    $$(String(scope) + ' [data-imdb]').forEach(el => el.setAttribute('hidden', ''));
    return;
  }
  $$(String(scope) + ' [data-tmdb]').forEach(el => { show(el, tmdb, tmdb ? j.rating.toFixed(1) : '', tmdb ? ('TMDB ' + (j.title || '')) : ''); });
  $$(String(scope) + ' [data-imdb]').forEach(el => { show(el, imdb, imdb ? j.imdb.toFixed(1) : '', imdb ? ('IMDb ' + j.imdb_id) : ''); });
}
/* ---------- запросы к метаданным ---------- */

// Дорожек немного: сервис отвечает не мгновенно, и десяток одновременных
// запросов не ускорит показ, а только упрётся в предел самого сервиса.
const RATING_WORKERS = 6;

// askedRatings — уже заданные вопросы. Одно и то же название встречается и в
// поиске, и в библиотеке, и сразу в нескольких качествах: спрашивать его второй
// раз незачем, а при быстрой перерисовке — вредно.
const askedRatings = new Map();

function ratingsOnce(c) {
  const ck = c.q + '|' + c.year;
  let p = askedRatings.get(ck);
  if (!p) {
    p = getRatings(c);
    askedRatings.set(ck, p);
    // Неудачный ответ не запоминаем: следующий показ должен попробовать снова.
    p.then(j => { if (!j || !j.ok) askedRatings.delete(ck); });
  }
  return p;
}

// ratingsByTitle проходит задания в несколько дорожек и возвращает ответ вместе
// с заданием: по заданию видно, какие карточки этим ответом наполнять.
async function ratingsByTitle(tasks, apply) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      const t = tasks[i];
      await apply(await ratingsOnce(t.c), t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RATING_WORKERS, tasks.length) }, worker));
}

// groupByTitle собирает задания: одно название — один вопрос, а карточки этого
// названия перечислены в задании. Прежде ответ доставался только первой карточке,
// и у остальных раздач того же сериала постер не появлялся.
function groupByTitle(items) {
  const tasks = [];
  const byKey = new Map();
  for (const t of items) {
    const c = cleanSearchTitle(t.title || t.name || '');
    if (!c.q) continue;
    const key = c.q + '|' + c.year;
    const known = byKey.get(key);
    if (known) { known.ts.push(t); continue; }
    const task = { c, ts: [t] };
    byKey.set(key, task);
    tasks.push(task);
  }
  return tasks;
}

// enrichPosters подтягивает постеры и оценки к уже показанным строкам.
//
// Прежде запросы шли строго по одному, с задержкой 80 мс на карточку: сотня
// строк — это минимум восемь секунд ожидания, и постеры «приползали» по одному,
// а на больших выдачах очередь просто не доходила до конца. Теперь запросы идут
// в несколько потоков.
const POSTER_WORKERS = 6;
const POSTER_MAX = 200;

// Номер отрисовки: если список перерисовали (смена сортировки, догрузка
// страницы), старые задачи не должны писать в новые карточки — индекс строки
// после перерисовки указывает уже на другое.
let posterGen = 0;

// visible — что показано на экране, all — полный список выдачи. Индекс карточки
// в разметке (data-ix) считается по полному списку: фильтр «Full HD» и слова-
// исключения выбрасывают часть строк, и по видимому списку индекс уезжает. Прежде
// здесь брался индекс по показанным строкам, и на отфильтрованной выдаче постер
// либо не находил своей карточки, либо попадал на чужую.
async function enrichPosters(visible, all) {
  const gen = ++posterGen;
  const base = all || visible;
  const items = [];
  const byKey = new Map();
  (visible || []).slice(0, POSTER_MAX).forEach(r => {
    const c = cleanSearchTitle(r.title || r.name || '');
    if (!c.q) return;
    const ix = base.indexOf(r);
    if (ix < 0) return;
    const key = c.q + '|' + c.year;
    // Одно и то же кино в разном качестве спрашивается один раз: строка
    // попадает в список адресатов уже готовой задачи, а не в отдельную.
    const known = byKey.get(key);
    if (known) { known.ixs.push(ix); return; }
    const item = { c, ixs: [ix] };
    byKey.set(key, item);
    items.push(item);
  });
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const it = items[i];
      const j = await ratingsOnce(it.c);
      if (gen !== posterGen) return;
      for (const ix of it.ixs) {
        if (j && j.ok && j.poster) {
          const el = document.querySelector(`.result[data-ix="${ix}"] .result-poster`);
          if (el) setPosterImage(el, j.poster);
        }
        applyRatingChips(`.result[data-ix="${ix}"]`, j);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POSTER_WORKERS, items.length) }, worker));
}
function setPosterImage(el, url) {
  const ph = el.querySelector('svg.ph');
  if (ph) ph.classList.add('hidden');
  let img = el.querySelector('img.pg');
  if (!img) {
    img = document.createElement('img');
    img.className = 'pg';
    img.loading = 'lazy';
    img.onerror = function(){ this.remove(); const s = el.querySelector('svg.ph'); if (s) s.classList.remove('hidden'); };
    el.insertBefore(img, el.firstChild);
  }
  img.onerror = function(){ this.remove(); const s = el.querySelector('svg.ph'); if (s) s.classList.remove('hidden'); };
  img.src = url;
}
// libRatings подтягивает постеры и оценки к плиткам библиотеки.
//
// Прежде запросы шли строго по одному, с паузой 60 мс на карточку: сорок плиток
// — это два с половиной секунды ожидания плюс сеть, а на большой библиотеке
// очередь не доходила до конца. Теперь запросы идут в несколько дорожек, а ответ
// на одно и то же название берётся один раз: в библиотеке оно встречается в
// разных качествах, и спрашивать его столько же раз незачем.
const LIB_RATINGS_MAX = 60;

/* ---------- Постеры и оценки библиотеки ----------
   TorrServer ни постеров, ни оценок не хранит: /torrents их не отдаёт, и
   единственный источник — ответ TMDB. Прежде постер лежал прямо в поле плитки
   (state.lib), а loadLibrary() каждый раз заменяет state.lib новым массивом —
   постер исчезал вместе со старым. Поэтому и постер, и оценки живут отдельно,
   по названию с годом: список перезагрузился — вернулись на место, окно
   перезапустилось — тоже.

   Оценки прежде лежали в sessionStorage и умирали вместе с окном: после каждого
   запуска библиотека показывала постеры сразу, а оценки спрашивала у TMDB заново
   — шесть дорожек по десятки названий, отсюда «подгружает потихоньку». */
const POSTER_LS = 'tc_posters';
const POSTER_LS_MAX = 800;
const posterStore = new Map();
let posterStoreLoaded = false;
let posterStoreTimer = 0;

/* META_TTL — сколько интерфейс доверяет запомненному ответу, не спрашивая сервис
   заново. Ровно столько же держит положительный ответ сам демон (tmdbCacheTTL в
   tmdb.go): спросить раньше — значит получить тот же ответ из его кэша, то есть
   потратить запрос впустую. Сорок плиток библиотеки иначе превращаются в сорок
   запросов при каждом заходе. */
const META_TTL = 24 * 60 * 60 * 1000;

/* Оценки держатся рядом с постерами, а не в разметке: после подгрузки постеров
   плитка перерисовывается целиком, и чипы, поставленные прямо в DOM, пропадали
   бы вместе со старой разметкой. */
const ratingStore = new Map();

function posterKey(c) { return c && c.q ? c.q + '|' + (c.year || '') : ''; }
function loadPosterStore() {
  if (posterStoreLoaded) return;
  posterStoreLoaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(POSTER_LS) || '{}');
    if (!raw || typeof raw !== 'object') return;
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (!v) continue;
      // Прежний формат — одна строка с адресом картинки: оценки в нём не было.
      posterStore.set(k, typeof v === 'string' ? { p: v } : v);
    }
  } catch {}
}
function savePosterStoreSoon() {
  clearTimeout(posterStoreTimer);
  posterStoreTimer = setTimeout(() => {
    try {
      const obj = {};
      // Хранилище ограничено: старые записи вытесняются, а их постеры и оценки
      // перезапрашиваются при следующем показе.
      const keys = Array.from(posterStore.keys()).slice(-POSTER_LS_MAX);
      for (const k of keys) obj[k] = posterStore.get(k);
      localStorage.setItem(POSTER_LS, JSON.stringify(obj));
    } catch {}
  }, 400);
}
// rememberMeta складывает в хранилище всё, что пришло от TMDB. Пустое значение
// не затирает прежнее: ответ без постера не должен отменять уже найденный.
// s — когда ответ получен: по нему решается, спрашивать ли сервис снова.
function rememberMeta(c, j) {
  const k = posterKey(c);
  if (!k || !j) return false;
  loadPosterStore();
  const prev = posterStore.get(k) || {};
  const next = {
    p: j.poster || prev.p || '',
    r: j.rating > 0 ? j.rating : (prev.r || 0),
    i: j.imdb > 0 ? j.imdb : (prev.i || 0),
    d: j.imdb_id || prev.d || '',
    t: j.title || prev.t || '',
    s: Date.now(),
  };
  const same = prev.p === next.p && prev.r === next.r && prev.i === next.i && prev.d === next.d && prev.t === next.t;
  posterStore.set(k, next);
  savePosterStoreSoon();
  return !same;
}
// storedFresh отдаёт запись, если она ещё не устарела. Записи прежнего формата
// (и любые без отметки времени) считаются устаревшими: спросить про них один раз
// дешевле, чем доверять неизвестно когда полученному ответу.
function storedFresh(c) {
  loadPosterStore();
  const rec = posterStore.get(posterKey(c));
  if (!rec || !rec.s) return null;
  return (Date.now() - rec.s) < META_TTL ? rec : null;
}
// storedAnswer превращает запись хранилища в ответ того же вида, что даёт
// /api/ratings: остальной код разбирает его теми же полями.
function storedAnswer(rec) {
  return { ok: true, poster: rec.p || '', rating: rec.r || 0, imdb: rec.i || 0, imdb_id: rec.d || '', title: rec.t || '' };
}
// rememberPoster — постер, введённый вручную в окне «Изменить». Отметку времени
// не ставит: ручной адрес картинки не значит, что оценка уже спрашивалась, и
// отмечать запись свежей — значит на сутки лишить её оценки.
function rememberPoster(c, url) {
  const k = posterKey(c);
  if (!k || !url) return false;
  loadPosterStore();
  const prev = posterStore.get(k) || {};
  posterStore.set(k, { p: url, r: prev.r || 0, i: prev.i || 0, d: prev.d || '', t: prev.t || '', s: prev.s || 0 });
  savePosterStoreSoon();
  return prev.p !== url;
}
// applyStoredMeta возвращает число плиток, которым вернули постер; оценки при
// этом кладутся в ratingStore, откуда их читает tile().
function applyStoredMeta() {
  loadPosterStore();
  if (!posterStore.size) return 0;
  let n = 0;
  for (const t of (state.lib || [])) {
    const k = posterKey(cleanSearchTitle(t.title || t.name || ''));
    if (!k) continue;
    const rec = posterStore.get(k);
    if (!rec) continue;
    if (rec.r > 0 || rec.i > 0) ratingStore.set(k, { ok: true, rating: rec.r || 0, imdb: rec.i || 0, imdb_id: rec.d || '', title: rec.t || '' });
    if (rec.p && !t.poster) { t.poster = rec.p; n++; }
  }
  return n;
}
function forgetPoster(c) {
  const k = posterKey(c);
  if (!k) return false;
  loadPosterStore();
  if (!posterStore.delete(k)) return false;
  savePosterStoreSoon();
  return true;
}
function forgetPosters() {
  posterStore.clear();
  posterStoreLoaded = true;
  savePosterStoreSoon();
}
function ratingFor(t) {
  return ratingStore.get(posterKey(cleanSearchTitle(t.title || t.name || ''))) || null;
}

async function libRatings() {
  const items = (state.lib || []).filter(t => t.title || t.name).slice(0, LIB_RATINGS_MAX);
  if (!items.length) return;
  let changed = applyStoredMeta() > 0;
  // Плитку ищем в текущем state.lib: пока шёл запрос, список могли перезагрузить,
  // и объект из задания уже не тот, что на экране.
  const liveOf = t => (state.lib || []).find(x => x.hash === t.hash) || t;
  await ratingsByTitle(groupByTitle(items), (j, task) => {
    // В постоянное хранилище пишет getRatings: он единственный, кто разговаривает
    // с /api/ratings, и через него проходят и поиск, и библиотека.
    // Ответ без оценки не должен гасить уже известную: свежий отказ — не повод
    // забыть то, что нашлось в прошлый раз.
    const eff = (j && j.ok) ? j : (ratingStore.get(posterKey(task.c)) || j);
    for (const t of task.ts) {
      const cur = liveOf(t);
      applyRatingChips(`.tile[data-hash="${esc(cur.hash)}"]`, eff);
      if (eff && eff.ok && eff.poster && !cur.poster) { cur.poster = eff.poster; changed = true; }
    }
  });
  if (changed) paintLibrary();
}
async function bindResult(row) {
  const r = (state.searchState.results || [])[parseInt(row.dataset.ix, 10)];
  if (!r) return;
  const menuBtn = row.querySelector('[data-menu]');
  const menu = row.querySelector('.ctxmenu');
  if (menuBtn && menu) menuBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  const act = (sel, fn) => row.querySelectorAll(sel).forEach(b => b.addEventListener('click', () => { if (menu) menu.classList.add('hidden'); fn(); }));
  act('[data-sa="play"]', () => playSearchLink(r));
  act('[data-sa="fav"]', () => addToUserlist(r));
  act('[data-sa="magnet"]', () => copyToClip(r.magnet || magnetFromHash(r.hash, r.title), 'Магнит скопирован'));
  act('[data-sa="userlist"]', () => addToUserlist(r));
  act('[data-sa="trailer"]', () => openTrailer(r));
  act('[data-sa="kp"]', () => openExternal(kpSearchUrl(r.title || r.name || '')));
  act('[data-sa="imdb"]', () => openExternal(imdbUrlFor(r)));
  act('[data-sa="poster"]', () => openPoster(r.poster));
  act('[data-sa="open"]', () => { if (/^https?:/i.test(r.link || '')) openExternal(r.link); else copyToClip(r.magnet || r.link || '', 'Ссылка скопирована'); });
}
function magnetFromHash(h, t) { return h ? (t ? 'magnet:?xt=urn:btih:' + h + '&dn=' + encodeURIComponent(t) : 'magnet:?xt=urn:btih:' + h) : ''; }

async function addToUserlist(r) {
  const ul = favList();
  const key = (r.hash || '') + '|' + (r.title || r.name || '');
  const idx = ul.findIndex(x => (x.hash || '') + '|' + (x.title || '') === key);
  if (idx >= 0) { ul.splice(idx, 1); saveFavList(ul); toast('Удалено из избранного'); updateFavMarks(); return; }
  ul.push({ title: r.title || r.name || '', magnet: r.magnet || magnetFromHash(r.hash, r.title), hash: r.hash, time: Date.now() });
  saveFavList(ul);
  toast('Добавлено в избранное');
  updateFavMarks();
}
function updateFavMarks() {
  const keys = new Set((favList() || []).map(x => (x.hash || '') + '|' + (x.title || '')));
  $$('.fav-ov').forEach(b => {
    const row = b.closest('.result');
    if (!row) return;
    const r = state.searchState.results ? state.searchState.results[parseInt(row.dataset.ix, 10)] : null;
    if (!r) return;
    b.classList.toggle('on', keys.has((r.hash || '') + '|' + (r.title || r.name || '')));
  });
}
async function playSearchLink(r) {
  try {
    const magnet = r.magnet || (r.hash ? magnetFromHash(r.hash, r.title || r.name) : '');
    if (!magnet && (r._p === 'kinozal' || /get\.php|details\.php/i.test(r.link || '')) && (r.get || r.link)) {
      toast('Добавляю из Кинозал.ТВ...');
      const rr = await fetch('/api/kinozal/add?url=' + encodeURIComponent(r.get || r.link), { method: 'POST' });
      const j = await rr.json();
      if (!rr.ok || !j.ok) throw new Error((j && j.error) || 'HTTP ' + rr.status);
      const hash = ((j.hash || '').match(/btih:([0-9a-fA-F]{40})/) || [null, j.hash || ''])[1].toLowerCase();
      if (hash) await playHashLoop(hash);
      return;
    }
    const hash = (magnet.match(/btih:([0-9a-fA-F]{40})/) || [null, ''])[1].toLowerCase();
    if (!hash) return toast('Не удалось определить hash раздачи', true);
    const t = state.lib.find(x => x.hash === hash);
    if (t) return watchNow(t);
    toast('Добавляю раздачу...');
    await torrentAction('add', { link: magnet, save_to_db: true });
    await playHashLoop(hash);
  } catch (e) { toast('Ошибка запуска: ' + e.message, true); }
}
async function playHashLoop(hash) {
  for (let i = 0; i < 12; i++) {
    await new Promise(res => setTimeout(res, 1000));
    try { state.lib = await listTorrents(); } catch {}
    const t = state.lib.find(x => x.hash === hash);
    if (t) { watchNow(t); return; }
  }
  toast('Раздача добавлена — открыта без воспроизведения. Смотрите её в Библиотеке.', true);
}
function openTrailer(r) {
  const q = encodeURIComponent((r.title || r.name || '') + ' трейлер');
  launchPlayer('browser', 'https://www.youtube.com/results?search_query=' + q, 'YouTube');
}
function openPoster(p) {
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.style.alignItems = 'center';
  ov.innerHTML = html`<img src="${p}" style="max-width:90vw; max-height:90vh; border-radius:10px" onclick="this.parentElement.remove()">`;
  document.body.appendChild(ov); ov.addEventListener('click', () => ov.remove());
}

/* ---------- подготовка торрента перед показом ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Состояния раздачи у TorrServer — числами. Названия нужны, чтобы объяснить
   ожидание словами, а не показать «stat 1». */
const PREP_STAGES = [
  'Торрент добавлен',
  'Получаем сведения о раздаче',
  'Подгрузка начала файла',
  'Раздача работает',
  'Торрент закрыт',
  'Торрент в базе',
];

/* Пока сервер не сообщил сведения о раздаче, плееру нечего играть: он
   откроется на пустом месте. Поэтому ожидание показывается: этап, сиды, пиры,
   скорость и ход подгрузки, — а рядом кнопка отказа. */
function prepOverlay(title) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal prep">
    <h2>${title || 'Раздача'}</h2>
    <div class="prep-stage"><span class="spin"></span><span data-stage>Торрент добавлен</span></div>
    <div class="prep-bar"><i data-bar></i></div>
    <div class="prep-stats">
      <span data-st="seeds">сиды: —</span>
      <span data-st="peers">пиры: —</span>
      <span data-st="speed">скорость: —</span>
      <span data-st="loaded">загружено: —</span>
      <span data-st="time">прошло: 0:00</span>
    </div>
    <div class="prep-hint" data-hint>Плеер откроется сам, когда появятся файлы раздачи.</div>
    <div class="btn-group"><button data-cancel>Отмена</button></div>
  </div>`;
  document.body.appendChild(ov);
  const started = Date.now();
  const el = s => ov.querySelector(s);
  const api = {
    cancelled: false,
    update(st) {
      const stat = Number(st && st.stat);
      el('[data-stage]').textContent = PREP_STAGES[stat] || 'Раздача';
      const total = Number(st && st.torrent_size) || 0;
      const loaded = Number(st && st.loaded_size) || 0;
      const pre = Number(st && st.preload_size) || 0;
      const preBytes = Number(st && st.preloaded_bytes) || 0;
      // Полоса показывает то, что известно: ход предзагрузки, а без него —
      // долю загруженного от всего размера.
      const part = pre > 0 ? preBytes / pre : (total > 0 ? loaded / total : 0);
      el('[data-bar]').style.width = Math.round(Math.max(0, Math.min(1, part)) * 100) + '%';
      const seeds = Number(st && st.connected_seeders) || 0;
      const peers = Number(st && st.active_peers) || 0;
      const sp = Number(st && st.download_speed) || 0;
      el('[data-st="seeds"]').textContent = 'сиды: ' + seeds;
      el('[data-st="peers"]').textContent = 'пиры: ' + peers;
      el('[data-st="speed"]').textContent = 'скорость: ' + (sp > 0 ? fmtSize(sp) + '/с' : '0');
      el('[data-st="loaded"]').textContent = total > 0 ? 'загружено: ' + fmtSize(loaded) + ' из ' + fmtSize(total) : 'загружено: —';
      el('[data-st="time"]').textContent = 'прошло: ' + fmtPos((Date.now() - started) / 1000);
      if (stat <= 1 && seeds === 0) el('[data-hint]').textContent = 'Сервер ищет раздающих. Если сидов нет, показ не начнётся — можно попробовать другую раздачу.';
    },
    hint(text) { el('[data-hint]').textContent = text; },
    fail(text) { el('[data-stage]').textContent = text; ov.querySelector('.spin').classList.add('stop'); },
    close() { api.cancelled = true; ov.remove(); },
  };
  ov.querySelector('[data-cancel]').addEventListener('click', () => api.close());
  ov.addEventListener('click', e => { if (e.target === ov) api.close(); });
  return api;
}

/* waitForFiles ждёт, пока сервер сообщит файлы раздачи.
   Возвращает состояние раздачи или null, если ожидание прервали. */
async function waitForFiles(t, waitMs) {
  const hash = t.hash;
  const quick = await statTorrent(hash).catch(() => null);
  if (quick && Array.isArray(quick.file_stats) && quick.file_stats.length) return rememberStat(hash, quick);

  const ov = prepOverlay(t.title || t.name || hash);
  const deadline = Date.now() + (waitMs || 120000);
  // Свежую раздачу сервер добавляет сам, но уже известную надо разбудить.
  await torrentAction('add', { link: hash, save_to_db: true }).catch(() => {});
  await torrentAction('start', { hash }).catch(() => {});
  try {
    while (!ov.cancelled && Date.now() < deadline) {
      const st = await statTorrent(hash).catch(() => null);
      if (ov.cancelled) break;
      if (st && typeof st === 'object') {
        ov.update(st);
        if (Array.isArray(st.file_stats) && st.file_stats.length) return rememberStat(hash, st);
      }
      await sleep(1000);
    }
    if (!ov.cancelled) ov.fail('Сведения о раздаче не получены');
    await sleep(900);
    return null;
  } finally { ov.close(); }
}
function rememberStat(hash, st) {
  statCache[hash] = { at: Date.now(), data: st };
  const cur = state.lib.find(x => x.hash === hash);
  if (cur) Object.assign(cur, st, { hasStat: true });
  return st;
}
/* Предупреждение после запуска: без раздающих показ не начнётся, и молчащий
   плеер на пустом месте выглядит поломкой. */
async function warnIfNoSeeds(t) {
  const st = await statTorrent(t.hash).catch(() => null);
  if (!st || typeof st !== 'object') return;
  const seeds = Number(st.connected_seeders) || 0;
  const peers = Number(st.total_peers) || 0;
  if (seeds === 0 && peers === 0) toast('Раздающих пока нет — загрузка может не начаться', true);
}

/* ---------- ход подгрузки во время показа ---------- */

/* Панель в углу: пока данных мало, плеер показывает «буферизацию», и без
   объяснения это выглядит поломкой. Панель живёт от нажатия «play» до первых
   прочитанных байтов, а если раздающих нет — остаётся и говорит об этом. */
let activePanel = null;

function progressPanel(t, f, next) {
  if (activePanel) activePanel.stop();
  const ov = document.createElement('div');
  ov.className = 'dlpanel';
  ov.innerHTML = html`<div class="dlpanel-h"><span class="spin"></span>
      <b data-title>${t.title || t.name || t.hash}</b>
      <button data-hide title="Скрыть">✕</button></div>
    <div class="dlpanel-sub" data-sub>${epSuffix(f).replace(/^ — /, '') || basename(f.path)}</div>
    <div class="prep-bar"><i data-bar></i></div>
    <div class="prep-stats">
      <span data-st="stage">—</span>
      <span data-st="seeds">сиды: —</span>
      <span data-st="peers">пиры: —</span>
      <span data-st="speed">скорость: —</span>
      <span data-st="loaded">загружено: —</span>
    </div>
    <div class="prep-hint" data-hint></div>
    <div class="prep-next hidden" data-nextbox></div>`;
  document.body.appendChild(ov);
  const el = s => ov.querySelector(s);
  const started = Date.now();
  let stopped = false;
  let announced = false;

  const panel = {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (activePanel === panel) activePanel = null;
      ov.remove();
    },
    /** ready — показ начался: панель сообщает это и уходит сама. */
    ready() {
      if (stopped || announced) return;
      announced = true;
      el('[data-st="stage"]').textContent = 'Показ идёт';
      ov.classList.add('done');
      if (next) {
        // Серия с серией: панель не уходит, а предлагает следующую. Искать
        // раздачу и серию заново после каждой серии — обычная работа, которую
        // тут делает одна кнопка.
        showNextButton();
        clearInterval(timer);
        return;
      }
      setTimeout(() => panel.stop(), 4000);
    },
    /** showNextButton — кнопка «следующая серия» рядом с панелью. */
    showNextButton() {
      const box = el('[data-nextbox]');
      if (!box || box.querySelector('button')) return;
      const p = parseSeriesEp(basename(next.path)) || {};
      const num = p.e ? ' E' + String(p.e).padStart(2, '0') : '';
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.dataset.nextEp = String(next.id);
      btn.textContent = 'Следующая серия' + num + ' ▶';
      btn.title = basename(next.path);
      btn.addEventListener('click', () => {
        panel.stop();
        playSelected(t, next);
      });
      box.appendChild(btn);
      box.classList.remove('hidden');
    },
  };
  // Текущая панель запоминается: иначе предыдущая оставалась на экране до
  // своего девяностасекундного срока, и после второго запуска их висело две.
  activePanel = panel;
  el('[data-hide]').addEventListener('click', () => panel.stop());

  const tick = async () => {
    if (stopped || announced) return;
    const st = await statTorrent(t.hash).catch(() => null);
    if (stopped || !st || typeof st !== 'object') return;
    if (Array.isArray(st.file_stats) && st.file_stats.length) rememberStat(t.hash, st);
    const stat = Number(st.stat);
    el('[data-st="stage"]').textContent = PREP_STAGES[stat] || 'Раздача';
    const total = Number(st.torrent_size) || 0;
    const loaded = Number(st.loaded_size) || 0;
    const pre = Number(st.preload_size) || 0;
    const preBytes = Number(st.preloaded_bytes) || 0;
    const read = Number(st.bytes_read) || 0;
    const part = pre > 0 ? preBytes / pre : (total > 0 ? loaded / total : 0);
    el('[data-bar]').style.width = Math.round(Math.max(0, Math.min(1, part)) * 100) + '%';
    const seeds = Number(st.connected_seeders) || 0;
    const peers = Number(st.active_peers) || 0;
    const sp = Number(st.download_speed) || 0;
    el('[data-st="seeds"]').textContent = 'сиды: ' + seeds;
    el('[data-st="peers"]').textContent = 'пиры: ' + peers;
    el('[data-st="speed"]').textContent = 'скорость: ' + (sp > 0 ? fmtSize(sp) + '/с' : '0');
    el('[data-st="loaded"]').textContent = total > 0 ? 'загружено: ' + fmtSize(loaded) + ' из ' + fmtSize(total) : 'загружено: —';
    // Плеер начал читать данные — значит показ пошёл.
    if (preBytes > 0 || read > 0) { panel.ready(); return; }
    if (seeds === 0 && peers === 0) {
      el('[data-hint]').textContent = 'Раздающих нет: показ не начнётся, пока не появятся сиды. Попробуйте другую раздачу.';
    } else if (stat <= 1) {
      el('[data-hint]').textContent = 'Сервер ищет раздающих...';
    } else {
      el('[data-hint]').textContent = 'Плеер открыт и ждёт данных.';
    }
    // Долгое ожидание без движения не должно висеть вечно.
    if (Date.now() - started > 90000) panel.stop();
  };
  const timer = setInterval(tick, 1500);
  tick();
  return panel;
}

/* ---------- player switcher + play ---------- */
function bindTorrentPlay(ov, t, files) {
  const el = ov.querySelector('#infoPlayer');
  let vf = files.filter(f => isVideo(f.path));
  let af = files.filter(f => isAudio(f.path));
  const allPlayable = files.filter(f => isPlayable(f.path));
  const vid = vf.length ? vf : files.filter(f => isPlayable(f.path));
  const target = vid.length ? vid : [];
  if (!target.length) { el.innerHTML = '<div class="empty">Нет воспроизводимых файлов</div>'; return; }
  let curFile = target[0];
  const fileChip = f => {
    const mark = markOf(t, f.id);
    const st = mark && mark.done ? ' ✓' : (mark && mark.timecode > 0 ? ' · ' + fmtPos(mark.timecode) : '');
    return html`<button class="chip-btn${f.id === target[0].id ? ' on' : ''}${mark && mark.done ? ' watched' : ''}" data-file="${f.id}">${basename(f.path)}${st}</button>`;
  };
  el.innerHTML = html`<div><b>Воспроизведение файла:</b> <code class="inline">${target[0].path}</code></div>
    <div style="margin-top:6px">${raw(allPlayable.map(fileChip).join(''))}</div>
    <div class="btn-group" style="margin-top:8px">
      <button data-pk="switcher">Плееры ▾</button>
      <button data-pk="browser">В браузере</button>
      <a class="btn" data-pk="m3u" href="#" download>M3U</a>
      <button data-pk="copy">Копировать ссылку</button>
      <button data-pk="dl">Скачать файл</button>
      <button data-pk="bm">Сохранить закладку</button>
      <button data-pk="eps">Список серий</button>
    </div>
    <div id="pkMode" class="switch" style="margin-top:8px"></div>`;
  const redoPicker = () => {
    el.querySelector('#pkMode').innerHTML = state.players.map(p => {
      const miss = (p.key !== 'browser' && !p.found) ? 'miss' : '';
      const base = makeStreamUrlFor(t, curFile);
      return html`<div class="player ${miss}" data-pk2="${p.key}" data-stream="${base}">
        <div class="pname">${p.name}</div><div class="plink mono">${base}</div>
      </div>`;
    }).join('');
    $$('#pkMode .player', el).forEach(p => p.addEventListener('click', () => {
      if (p.dataset.pk2 === 'browser') return inBrowser(t, curFile);
      ov.remove();
      playSelected(t, curFile, { player: p.dataset.pk2 });
    }));
  };
  redoPicker();
  $$('button[data-file]', el).forEach(b => b.addEventListener('click', () => {
    curFile = files.find(f => String(f.id) === b.dataset.file); if (!curFile) return;
    $$('button[data-file]', el).forEach(x => x.classList.remove('on'));
    b.classList.add('on'); redoPicker();
  }));
  el.querySelector('[data-pk="switcher"]').addEventListener('click', () => {
    const sw = el.querySelector('#pkMode'); sw.classList.toggle('hidden');
  });
  el.querySelector('[data-pk="eps"]').addEventListener('click', () => {
    const vids = playableOf(t).filter(f => isVideo(f.path));
    if (vids.length < 2) return toast('В раздаче одна серия', true);
    ov.remove(); openEpisodesPicker(t, vids);
  });
  el.querySelector('[data-pk="browser"]').addEventListener('click', () => { inBrowser(t, curFile); });
  el.querySelector('[data-pk="m3u"]').addEventListener('click', e => { e.preventDefault(); m3uForFile(t, curFile); });
  el.querySelector('[data-pk="copy"]').addEventListener('click', () => copyToClip(makeStreamUrlFor(t, curFile), 'Ссылка скопирована'));
  el.querySelector('[data-pk="dl"]').addEventListener('click', async () => {
    const q = 'action=start&hash=' + encodeURIComponent(t.hash) + '&index=' + curFile.id + '&name=' + encodeURIComponent(t.title || 'file') + '&file=' + encodeURIComponent(basename(curFile.path)) + '&size=' + (curFile.length || 0);
    // Запуск закачки — POST: GET-адрес с чужой страницы могла бы дёрнуть даже картинка.
    try { await api('/api/download?' + q, { method: 'POST' }); toast('Загрузка начата'); loadDownloads(); }
    catch (e) { toast('Не удалось начать загрузку: ' + e.message, true); }
  });
  el.querySelector('[data-pk="bm"]').addEventListener('click', () => { addBookmark(t, curFile.id, basename(curFile.path), estimatePos(t.hash, curFile.id)); });
}
function basename(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }
function urlSafe(p) { return p.replace(/[\s]/g, '%20'); }
function makeStreamUrlFor(t, f) {
  // Ссылка на один файл: плейлист всей раздачи собирает демон, когда получает
  // раздачу и номер файла. Продолжение с места остановки ставит плеер флагом
  // запуска — параметр pos TorrServer не разбирает.
  return location.origin + ts(`/stream/${encodeURIComponent(basename(f.path))}?link=${encodeURIComponent(t.hash)}&index=${f.id}&play`);
}
function inBrowser(t, f) {
  const url = makeStreamUrlFor(t, f);
  trackPlay(t.hash, f.id, currentTc(t, f.id));
  launchPlayer('browser', url, t.title || 'stream');
}
function m3uForFile(t, f) {
  const url = ts(`/playlist?hash=${encodeURIComponent(t.hash)}&index=${f.id}&m3u`);
  const a = document.createElement('a'); a.href = url; a.download = (t.title || 'file') + '.m3u'; document.body.appendChild(a); a.click(); a.remove();
}
function firstPlayable(t) {
  const files = t.file_stats || [];
  return files.find(x => isPlayable(x.path)) || (files.length === 1 ? files[0] : null);
}
function playableOf(t) { return (t.file_stats || []).filter(x => isPlayable(x.path)); }

/* playSelected запускает показ выбранного файла.
   Раздача и номер файла уходят демону: он отдаёт плееру плейлист всей раздачи
   с выбранной серии, поэтому у плеера есть список серий, а не одна ссылка.
   Позиция продолжения ставится флагом запуска — параметр pos в адресе потока
   TorrServer не разбирает. */
function playSelected(cur, f, opts = {}) {
  const key = opts.player || pickPlayer();
  const title = (cur.title || cur.name || 'stream') + epSuffix(f);
  trackPlay(cur.hash, f.id, opts.fromZero ? 0 : currentTc(cur, f.id));
  // Ход подгрузки виден всегда, а не только пока сервер не отдал список файлов:
  // иначе нажатие «play» на известной раздаче выглядит как молчание. В браузере
  // панель не нужна — там свой значок ожидания, а раздающих проверяет тост.
  const vids = playableOf(cur).filter(x => isVideo(x.path));
  const next = vids.length > 1 ? nextAfter(cur, vids, f) : null;
  const panel = key === 'browser' ? null : progressPanel(cur, f, next);
  return launchPlayer(key, makeStreamUrlFor(cur, f), title, { hash: cur.hash, index: f.id })
    .then(res => {
      if (!res) { if (panel) panel.stop(); return; }
      if (!panel) warnIfNoSeeds(cur);
      refreshViewedSoon();
    });
}
/* Отметки ставит и сам демон: он считает, сколько байт ушло плееру, и отмечает
   серию просмотренной, когда файл прочитан до конца, — даже если плеер о позиции
   не сообщает вовсе. Интерфейс об этом не знает, пока не спросит, поэтому список
   отметок обновляется сам, а не только по нажатию. */
let viewedKey = '';
function viewedSignature() {
  return (state.viewed || [])
    .map(v => v.hash + ':' + v.file_index + ':' + Math.round(v.timecode || 0) + ':' + (v.done ? 1 : 0))
    .sort()
    .join('|');
}
async function refreshViewed() {
  await loadPositions();
  const key = viewedSignature();
  if (key === viewedKey) return;
  const first = !viewedKey;
  viewedKey = key;
  // Первый ответ — это то, что уже нарисовано. Открытое окно перерисовывать
  // нельзя: пользователь как раз выбирает серию или правит настройки.
  if (first || $('.overlay')) return;
  if (state.view === 'library') paintLibrary();
}
function refreshViewedSoon() {
  [1500, 4000, 8000].forEach(ms => setTimeout(refreshViewed, ms));
}
function epSuffix(f) {
  const p = parseSeriesEp(basename(f.path));
  if (!p || !(p.s || p.e)) return '';
  return ' — ' + (p.s ? 'Сезон ' + p.s + ' · ' : '') + (p.e ? 'Серия ' + p.e : 'сезон');
}

/* Нажатие «play». Сериал не открывается первой серией молча: показывается
   список серий, и уже оттуда запускается выбранная. Для фильма ожидание
   сведений о раздаче видно — этап, сиды, скорость. */
async function watchNow(t) {
  const hash = (t && t.hash) || '';
  if (!hash) return;
  let cur = t;
  let files = playableOf(cur);
  if (!files.length) {
    const st = await waitForFiles(cur);
    if (!st) return;
    cur = Object.assign({}, cur, st);
    files = playableOf(cur);
  }
  if (!files.length) { toast('В раздаче нет воспроизводимых файлов', true); return; }
  const vids = files.filter(x => isVideo(x.path));
  if (vids.length === 1) return playSelected(cur, vids[0]);
  if (!vids.length) return playSelected(cur, files[0]);
  /* Несколько серий: выбор делает пользователь, а не догадка «начнём с первой». */
  return openEpisodesPicker(cur, vids);
}
/* nextEpisode — серия, которую логично смотреть дальше: первая не начатая,
   а если все начаты — самая ранняя. Отметка досмотра сильнее позиции. */
function nextEpisode(t, vids) {
  const sorted = vids.slice().sort((a, b) => epIdx(a.path) - epIdx(b.path) || a.path.localeCompare(b.path, 'ru', { numeric: true }));
  return sorted.find(f => !isWatched(t, f.id) && !(currentTc(t, f.id) > 0)) || sorted.find(f => !isWatched(t, f.id)) || sorted[0];
}
function epIdx(name) {
  const p = parseSeriesEp(name);
  if (!p) return Infinity;
  return (p.s || 0) * 1000 + (p.e || 0);
}
/* nextAfter — серия, идущая сразу за текущей по номерам. Это не то же самое, что
   nextEpisode («что смотреть дальше» по отметкам): кнопка «следующая серия»
   должна вести на E07 после E06, а не на пропущенную ранее серию. */
function nextAfter(t, vids, cur) {
  const sorted = vids.slice().sort((a, b) => epIdx(a.path) - epIdx(b.path) || a.path.localeCompare(b.path, 'ru', { numeric: true }));
  const i = sorted.findIndex(f => f.id === cur.id);
  return i >= 0 ? (sorted[i + 1] || null) : null;
}
function openEpisodesPicker(t, files) {
  if (!files) {
    const cached = statCache[t.hash] && statCache[t.hash].data;
    if (cached && cached.file_stats) { files = playableOf(cached); }
  }
  if (!files || !files.length) {
    statTorrent(t.hash).then(s => {
      if (s && s.file_stats) {
        rememberStat(t.hash, s);
        const vids = playableOf(s).filter(x => isVideo(x.path));
        if (vids.length) openEpisodesPicker(t, vids);
        else toast('Нет воспроизводимых файлов', true);
      } else toast('Нет воспроизводимых файлов', true);
    }).catch(() => toast('Не удалось получить список файлов', true));
    return;
  }
  const ov = document.createElement('div'); ov.className = 'overlay';
  const next = nextEpisode(t, files);
  // Порядок раздачи — по сезону и серии, затем по имени: так же, как нумерует
  // файлы сервер, и так же, как это делал прежний клиент.
  const groups = new Map();
  files.forEach(f => {
    const p = parseSeriesEp(basename(f.path));
    const s = (p && p.s) || 0;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(f);
  });
  const seasons = [...groups.keys()].sort((a, b) => a - b);
  seasons.forEach(s => groups.get(s).sort((a, b) => epIdx(a.path) - epIdx(b.path) || basename(a.path).localeCompare(basename(b.path), 'ru', { numeric: true })));
  const done = files.filter(f => isWatched(t, f.id)).length;
  ov.innerHTML = html`<div class="modal wide">
    <button class="modal-close" data-close>✕</button>
    <div class="row"><div style="flex:1"><h2 style="margin-top:0">${t.title || t.name || t.hash}</h2>
      <div class="page-sub">Серий: ${files.length} · просмотрено: ${done} · следующая — ${epLabel(next, t)}</div></div>
      <button data-next>▶ Смотреть следующую</button></div>
    <div class="divider"></div>
    <div class="eps-list" style="max-height:60vh;overflow:auto">
      ${raw(seasons.map(sn => html`<div class="eps-season" data-sn="${sn}">
        <div class="eps-season-h">${sn ? 'Сезон ' + sn : 'Эпизоды'}</div>
        ${groups.get(sn).map(f => epRow(t, f, next, sn)).join('')}
      </div>`).join(''))}
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  const cb = ov.querySelector('[data-close]'); if (cb) cb.addEventListener('click', close);
  ov.querySelector('[data-next]').addEventListener('click', () => { close(); playSelected(t, next); });
  $$('[data-ep]', ov).forEach(b => b.addEventListener('click', () => {
    const f = files.find(x => String(x.id) === b.dataset.ep); if (!f) return;
    close(); playSelected(t, f);
  }));
  // Отметка просмотра — прямое действие пользователя: позиция от плеера может
  // не дойти, если плеер о ней не сообщает.
  $$('[data-toggle]', ov).forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const id = parseInt(b.dataset.toggle, 10);
    const f = files.find(x => x.id === id); if (!f) return;
    const wasWatched = isWatched(t, id);
    b.disabled = true;
    const ok = await savePosition(t.hash, id, wasWatched ? 0 : null, 0, !wasWatched);
    b.disabled = false;
    if (!ok) return;
    toast(wasWatched ? 'Отметка снята' : 'Отмечено просмотренным');
    close(); openEpisodesPicker(t, files);
  }));
  loadEpDetails(ov, t);
}
/* epLabel — человеческая подпись серии: «Сезон 1 · Серия 2». Так же называл
   серии прежний клиент, и так их понятнее искать глазами, чем «S01E02». */
function epLabel(f, t) {
  const p = parseSeriesEp(basename(f.path));
  if (p && (p.s || p.e)) {
    const s = p.s || (parseSeriesEp(t && t.title) || {}).s || 0;
    let lab = s ? 'Сезон ' + s + ' · ' : '';
    lab += p.e ? 'Серия ' + p.e + (p.e2 && p.e2 > p.e ? '–' + p.e2 : '') : 'сезон целиком';
    return lab;
  }
  return basename(f.path);
}
/* epRow — строка списка серий: подпись, название, дата выхода, длительность,
   описание и кадр из метаданных, состояние (просмотрено / продолжение / не
   начата) и отметка просмотра. Номер серии стоит и на строке, и на кнопке:
   подробности подставляются в строку, а нажатие обрабатывает кнопка. */
function epRow(t, f, next, season) {
  const tc = currentTc(t, f.id);
  const watched = isWatched(t, f.id);
  const isNext = next && next.id === f.id;
  const stateText = watched ? 'просмотрено' : (tc > 0 ? 'продолжить с ' + fmtPos(tc) : (isNext ? 'следующая' : 'не начата'));
  const cls = ['eprow'];
  if (watched) cls.push('watched');
  if (tc > 0) cls.push('started');
  if (isNext) cls.push('next');
  const p = parseSeriesEp(basename(f.path)) || {};
  return html`<div class="${cls.join(' ')}" data-ep-row="${f.id}" data-ep-num="${p.e || 0}" data-sn="${season}">
    <button class="ep-main" data-ep="${f.id}" data-ep-num="${p.e || 0}" data-sn="${season}" title="${basename(f.path)}">
      <span class="ep-still"></span>
      <span class="ep-body">
        <span class="ep-line1"><span class="ep-label">${epLabel(f, t)}</span><span class="epname"></span></span>
        <span class="ep-meta"></span>
        <span class="ep-over"></span>
        <span class="ep-state">${stateText}</span>
      </span>
    </button>
    <button class="ep-toggle${watched ? ' on' : ''}" data-toggle="${f.id}" title="${watched ? 'Снять отметку просмотра' : 'Отметить просмотренной'}">✓</button>
  </div>`;
}
/* Сведения о сезоне спрашиваются один раз на сериал и сезон и хранятся в памяти
   вкладки: и список серий в карточке, и окно выбора серии берут их оттуда. */
const epSeasonCache = {};
async function seasonInfo(q, sn) {
  const ck = q.toLowerCase() + '|s' + sn;
  if (epSeasonCache[ck] !== undefined) return epSeasonCache[ck];
  let season = null;
  try {
    const r = await fetch('/api/tv_eps?q=' + encodeURIComponent(q) + '&season=' + sn);
    const j = await r.json();
    // Отказ по ключу виден и здесь: без названий серий причина та же.
    if (j && j.error) noteMetaError(j.error);
    if (j && j.ok && Array.isArray(j.seasons)) season = j.seasons.find(x => Number(x.number) === sn) || null;
    // Запасной разбор: ответ прежнего вида — одни названия серий.
    if (!season && j && j.ok && j.name_by && j.name_by[sn]) {
      season = { number: sn, episodes: Object.keys(j.name_by[sn]).map(k => ({ number: Number(k), name: j.name_by[sn][k] })) };
    }
  } catch { season = null; }
  epSeasonCache[ck] = season;
  return season;
}
function epByName(season) {
  const by = {};
  ((season && season.episodes) || []).forEach(e => { if (e.name) by[e.number] = e.name; });
  return by;
}
function fmtAirDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '.' + m[2] + '.' + m[1] : String(s || '');
}
/* seasonHead — заголовок сезона: сколько серий, когда вышли. По нему видно, что
   перед вами целый сезон, а не одна раздача. */
function seasonHead(season, sn) {
  const eps = (season && season.episodes) || [];
  const dates = eps.map(e => e.air_date).filter(Boolean).sort();
  const bits = [];
  if (eps.length) bits.push(eps.length + ' ' + plural(eps.length, 'серия', 'серии', 'серий'));
  if (dates.length) {
    const a = fmtAirDate(dates[0]), b = fmtAirDate(dates[dates.length - 1]);
    bits.push(a === b ? a : a + ' — ' + b);
  }
  const rated = eps.filter(e => e.rating > 0);
  if (rated.length) bits.push((rated.reduce((n, e) => n + e.rating, 0) / rated.length).toFixed(1) + ' из 10');
  const name = season && season.name && !/^сезон\s*\d+$/i.test(season.name.trim()) ? season.name.trim() : '';
  return html`${sn ? 'Сезон ' + sn : 'Эпизоды'}${name ? ' · ' + name : ''}`
    + (bits.length ? html`<span class="ep-season-meta">${bits.join(' · ')}</span>` : '');
}
/* Названия серий подставляются и в списке серий, и во вкладке «Сериалы»,
   поэтому выборка идёт по номеру серии, а не по кнопке списка. */
async function loadEpNames(ov, t) {
  const q = cleanSeriesName(t.title || t.name || '');
  if (!q) return;
  const blocks = $$('.eps-season', ov);
  for (const block of blocks) {
    const sn = parseInt(block.dataset.sn, 10);
    if (!sn) continue;
    const by = epByName(await seasonInfo(q, sn));
    if (!Object.keys(by).length) continue;
    $$('[data-ep-num]', block).forEach(b => {
      const num = parseInt(b.dataset.epNum, 10);
      if (!num || !by[num]) return;
      const nm = b.querySelector('.epname');
      if (nm) nm.textContent = ' · ' + by[num];
      if (!b.title.includes(by[num])) b.title += ' — ' + by[num];
    });
  }
}
/* loadEpDetails наполняет окно выбора серии: заголовок сезона, дата выхода,
   длительность, оценка, описание и кадр. Список серий в карточке остаётся
   коротким — там для этого нет места. */
async function loadEpDetails(ov, t) {
  const q = cleanSeriesName(t.title || t.name || '');
  if (!q) return;
  const blocks = $$('.eps-season', ov);
  for (const block of blocks) {
    const sn = parseInt(block.dataset.sn, 10);
    if (!sn) continue;
    const season = await seasonInfo(q, sn);
    if (!season) continue;
    const head = block.querySelector('.eps-season-h');
    if (head) head.innerHTML = seasonHead(season, sn);
    (season.episodes || []).forEach(ep => {
      const row = block.querySelector('[data-ep-num="' + ep.number + '"]');
      if (!row) return;
      const nm = row.querySelector('.epname');
      if (nm && ep.name) nm.textContent = ' · ' + ep.name;
      const meta = row.querySelector('.ep-meta');
      if (meta) {
        meta.textContent = [
          ep.air_date ? fmtAirDate(ep.air_date) : '',
          ep.runtime ? ep.runtime + ' мин' : '',
          ep.rating > 0 ? ep.rating.toFixed(1) : '',
        ].filter(Boolean).join(' · ');
      }
      const over = row.querySelector('.ep-over');
      if (over && ep.overview) over.textContent = ep.overview;
      const still = row.querySelector('.ep-still');
      if (still && ep.still) still.innerHTML = html`<img src="${ep.still}" loading="lazy" alt="">`;
      if (ep.name && !row.title.includes(ep.name)) row.title += ' — ' + ep.name;
      if (ep.overview) row.title += '\n' + ep.overview;
    });
  }
}
function openServerInBrowser() {
  const p = state.profiles.find(x => x.id === state.active) || state.profiles[0];
  if (!p) return toast('Нет активного сервера', true);
  launchPlayer('browser', p.url, 'TorrServer');
}
function pickPlayer() {
  const def = localStorage.getItem('tc_defplayer');
  if (def && def !== 'browser') { const p = state.players.find(x => x.key === def && x.found); if (p) return def; }
  const pl = state.players.find(p => p.key !== 'browser' && p.found);
  return pl ? pl.key : 'browser';
}
async function launchPlayer(key, url, title, extra) {
  if (key === 'browser') {
    const r = await fetch('/api/player/launch?player=browser&url=' + encodeURIComponent(url), { method: 'POST' });
    try { const j = await r.json(); if (j.ok) return j; } catch {}
    toast('Не удалось открыть браузер', true);
    return null;
  }
  /* Раздачу и номер файла передаём демону: он отдаёт плееру плейлист всей
     раздачи, а не ссылку на одну серию, и сам ставит продолжение с места
     остановки. Без этого VLC видел одну серию и не видел списка. */
  let q = 'player=' + encodeURIComponent(key) + '&url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title || '');
  if (extra && extra.hash) {
    q += '&hash=' + encodeURIComponent(extra.hash);
    if (extra.index) q += '&index=' + encodeURIComponent(extra.index);
  }
  const r = await fetch('/api/player/launch?' + q, { method: 'POST' });
  let j = null;
  try { j = await r.json(); } catch {}
  if (j && j.ok) {
    if (j.url_mode === 'playlist') toast('Плееру передан список серий' + (j.resume ? ' — продолжение с места остановки' : ''));
    else if (!j.watching) toast('Плеер не сообщает позицию — отметку придётся ставить вручную');
    return j;
  }
  toast('Плеер не найден или не запустился', true);
  return null;
}

/* ---------- add magnet from search via appended event ---------- */
window.addEventListener('tc:runadd', e => {
  const hash = ((e.detail || '').match(/btih:([0-9a-fA-F]{40})/) || [null, e.detail || ''])[1].toLowerCase();
  setTimeout(() => { const t = state.lib.find(x => x.hash === hash); if (t) watchNow(t); else toast('Раздача добавлена — ищите в Библиотеке'); }, 900);
});

/* ================= PLAYERS PAGE ================= */
function renderPlayers(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Плееры</h1>
      <div class="page-sub">Выберите, каким плеером открывать видео. Можно настроить пути и аргументы.</div></div></div>
    <div class="card"><div class="row wrap">
      <label style="flex:1;margin:0;display:inline-flex;gap:8px;align-items:center">Плеер для запуска по умолчанию:
        <select id="defPlayer" style="width:auto">
          <option value="">(автовыбор первого найденного)</option>
          ${raw(state.players.filter(p => p.key !== 'browser').map(p => html`<option value="${p.key}" ${localStorage.getItem('tc_defplayer') === p.key ? 'selected' : ''}>${p.name}</option>`).join(''))}
          <option value="browser" ${localStorage.getItem('tc_defplayer') === 'browser' ? 'selected' : ''}>Браузер</option>
        </select>
      </label>
      <button id="scanPlayers" class="primary">Найти плееры заново</button>
    </div>
    <div class="page-sub" id="scanInfo" style="margin-top:8px"></div></div>
    <div class="card"><div class="tabs" id="pmodeBtn"><button data-v="continue" class="on">Продолжить с позиции</button><button data-v="fresh">Просто открыть ссылку</button></div></div>
    <div id="playersList"></div>
    <div class="divider"></div>
    <div class="card">
      <label>Получите ссылку на поток для любого внешнего плеера:</label>
      <div class="row"><input id="pMagnet" placeholder="Вставьте магнитную ссылку или hash"><button id="pGo">Открыть</button></div>
      <div id="pOut"></div>
    </div>
    <div class="card">
      <h3>HTTP-ссылки (например для VLC, PotPlayer):</h3>
      <div class="mono" id="pHttp"></div>
    </div>`;
  paintPlayersList(root);
  paintScanInfo();
  const defSel = $('#defPlayer');
  if (defSel) defSel.addEventListener('change', () => {
    localStorage.setItem('tc_defplayer', defSel.value);
    const nm = defSel.options[defSel.selectedIndex] && defSel.options[defSel.selectedIndex].text;
    toast('Плеер по умолчанию: ' + (nm || '(автовыбор)'));
    route();
  });
  $('#scanPlayers').addEventListener('click', async () => {
    const btn = $('#scanPlayers');
    if (btn) { btn.disabled = true; btn.textContent = 'Ищу…'; }
    try {
      const r = await fetch('/api/player/scan', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
      state.players = j.players.filter(p => p.key !== 'browser');
      state.scanRoots = Array.isArray(j.roots) ? j.roots : [];
      const found = state.players.filter(p => p.found).map(p => p.name).join(', ');
      toast(found ? 'Обнаружены: ' + found : 'Установленных плееров не найдено');
      route();
    } catch (e) {
      toast('Ошибка сканирования: ' + e.message, true);
      if (btn) { btn.disabled = false; btn.textContent = 'Найти плееры заново'; }
    }
  });
  const mode = localStorage.getItem('tc_pmode') || 'continue';
  $$('#pmodeBtn [data-v]').forEach(b => {
    b.classList.toggle('on', b.dataset.v === mode);
    b.addEventListener('click', () => togglePlayerMode(b.dataset.v));
  });
  $('#pGo').addEventListener('click', async () => {
    const link = $('#pMagnet').value.trim(); if (!link) return;
    $('#pOut').innerHTML = '<div class="empty">Получение информации...</div>';
    try {
      const st = await tsGet('/stream?link=' + encodeURIComponent(link) + '&stat&save');
      const t = st;
      const files = (st.file_stats || []).filter(f => isVideo(f.path));
      const main = files[0];
      const base = t.hash && main ? ts(`/stream/${encodeURIComponent(basename(main.path))}?link=${encodeURIComponent(t.hash)}&index=${main.id}&play`) : '';
      $('#pOut').innerHTML = html`
        <div class="row wrap"><div style="flex:1"><b>${st.title || ''}</b> · ${fmtSize(st.torrent_size)} <br>
        <span class="mono">${st.hash || ''}</span></div>
        <button class="primary" id="pCopy" ${base ? '' : 'disabled'}>Скопировать</button>
        <button id="pOpen" ${base ? '' : 'disabled'}>Открыть VLC</button></div>
        ${raw(base ? html`<div class="mono" style="margin-top:8px">${base}</div>` : '')}`;
      if (base) { $('#pCopy').addEventListener('click', () => copyToClip(base, 'Скопировано')); $('#pOpen').addEventListener('click', () => launchPlayer('vlc', base, st.title)); }
    } catch (e) { $('#pOut').innerHTML = html`<div class="empty">Ошибка: ${e.message}</div>`; }
  });
}
function togglePlayerMode(mode) {
  localStorage.setItem('tc_pmode', mode);
  renderPlayers(document.querySelector('main'));
}

/* Где искали плееры. Без этого кнопка «Найти плееры заново» молчит одинаково и
   когда плееров на машине нет, и когда искала не там. */
function paintScanInfo() {
  const box = $('#scanInfo');
  if (!box) return;
  const roots = state.scanRoots || [];
  if (!roots.length) {
    box.textContent = 'Плееры ищутся в системных папках программ, на дисках C:–J:, рядом с программой и в PATH. Нажмите «Найти плееры заново», чтобы обновить список.';
    return;
  }
  const head = roots.slice(0, 8).join(' · ');
  const tail = roots.length > 8 ? ' и ещё ' + (roots.length - 8) : '';
  const found = (state.players || []).filter(p => p.found).length;
  box.textContent = 'Проверено папок: ' + roots.length + ' — ' + head + tail + '. Найдено плееров: ' + found + '.';
}

function paintPlayersList(root) {
  const el = document.createElement('div'); el.id = 'playersList';
  el.innerHTML = state.players.map(p => html`
    <div class="card" data-pp="${p.key}">
      <div class="row"><h3 style="flex:1;margin:0">${p.name}</h3>
        <span class="chip ${p.found ? '' : 'grey'}">${p.found ? '✓ найден' : 'не найден'}</span>
        ${raw(localStorage.getItem('tc_defplayer') === p.key ? '<span class="chip">по умолчанию</span>' : '')}
        ${raw(p.key && p.key !== 'browser' ? html`<button data-dl="${p.path}">Скачать exe</button>` : '')}
      </div>
      <label>Путь к исполняемому файлу</label>
      <div class="row"><input data-f="path" value="${p.path}" placeholder="C:\\Program Files\\...">
        <button data-browse>Обзор</button></div>
      <label>Аргументы (подставка: {url} — ссылка на поток, {path} — путь к exe)</label>
      <input data-f="args" value="${p.args || ''}" placeholder='"{url}"'>
      <div style="margin-top:8px"><button data-save>Сохранить</button></div>
    </div>`).join('') || '<div class="empty">Нет плееров</div>';
  root.querySelector('#playersList').replaceWith(el);
  $$('.card[data-pp]').forEach(card => {
    const key = card.dataset.pp;
    const getVal = (f) => card.querySelector(`[data-f="${f}"]`).value;
    const p = state.players.find(x => x.key === key);
    if (!p) return;
    card.querySelector('[data-save]').addEventListener('click', async () => {
      p.path = getVal('path'); p.args = getVal('args'); p.found = !!p.path;
      await fetch('/api/player/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.players) });
      toast('Сохранено'); route();
    });
    const browse = card.querySelector('[data-browse]'); if (browse) browse.addEventListener('click', () => {
      const inp = card.querySelector('[data-f="path"]');
      const pth = prompt('Введите путь к исполняемому файлу (или поставьте вручную)', inp.value);
      if (pth) inp.value = pth;
    });
    const dl = card.querySelector('[data-dl]'); if (dl && p && dl.dataset.dl) dl.addEventListener('click', () => {
      const path = p.path; if (!path) return toast('Сначала укажите путь', true);
      toast('Плеер уже найден по пути: ' + path);
    });
  });
}

/* ================= DOWNLOADS ================= */
function loadDownloads() { return api('/api/download?action=list'); }
function pollDownloads() {
  if (state.view !== 'downloads') return;
  loadDownloads().then(j => { state.dlJobs = j.jobs; if (document.querySelector('#dljobs')) paintDownloads(); }).catch(() => {});
  pollTorrents();
}

/* ---------- что происходит на сервере ---------- */
/* Прежде раздел «Загрузки» показывал только сохранение на диск и при пустом
   списке заданий писал «Нет активных загрузок» — хотя сервер в это время качал
   раздачу. Теперь сверху видно состояние раздач, подгрузку, кэш и скорость: то,
   что раньше мелькало только в панели при запуске показа. */
let dlRowsKey = '';
async function pollTorrents() {
  const box = $('#dlTorrents');
  if (!box) return;
  let list = null;
  try {
    list = await tsJson('/torrents', { action: 'list' });
  } catch (e) {
    if (dlRowsKey !== 'error') { box.innerHTML = html`<div class="empty">Сервер не отвечает: ${e.message}</div>`; dlRowsKey = 'error'; }
    const sum = $('#dlSummary'); if (sum) sum.innerHTML = '';
    return;
  }
  if (!Array.isArray(list)) list = [];
  if (dlRowsKey === 'error') dlRowsKey = '';
  paintTorrentRows(list);
  await paintCacheCard(list);
}

/* Сводка: суммарные скорости, объёмы и настройки кэша самого сервера. Настройки
   спрашиваются один раз — они меняются редко. */
async function paintCacheCard(list) {
  const box = $('#dlSummary');
  if (!box) return;
  const sum = k => list.reduce((n, t) => n + (Number(t[k]) || 0), 0);
  const bits = [
    ['↓ ' + fmtSpeed(sum('download_speed')), 'суммарная скорость загрузки'],
    ['↑ ' + fmtSpeed(sum('upload_speed')), 'суммарная скорость отдачи'],
    ['раздач: ' + list.length, 'раздач на сервере'],
    ['подгружено: ' + fmtSize(sum('preloaded_bytes')), 'готово к показу, лежит в кэше'],
    ['прочитано: ' + fmtSize(sum('bytes_read')), 'столько прочитал плеер'],
  ];
  /* Сводка пишется сразу, а настройки сервера дописываются, когда придут: ждать
     их перед первой отрисовкой — значит показывать пустое место, пока идёт
     запрос. PreloadCache и ReaderReadAHead — проценты, CacheSize — байты. */
  const render = () => {
    const c = state.cache || {};
    const preBytes = c.CacheSize && c.PreloadCache ? (c.CacheSize / 100) * c.PreloadCache : 0;
    const cache = [];
    if (c.CacheSize) cache.push('кэш ' + fmtSize(c.CacheSize));
    if (c.PreloadCache) cache.push('предзагрузка ' + c.PreloadCache + '%' + (preBytes ? ' (' + fmtSize(preBytes) + ')' : ''));
    if (c.ReaderReadAHead) cache.push('чтение вперёд ' + c.ReaderReadAHead + '%');
    if (c.ConnectionsLimit) cache.push('соединений ' + c.ConnectionsLimit);
    box.innerHTML = `<div class="row wrap stats-row">`
      + bits.map(([v, tip]) => html`<span class="stat" title="${tip}">${v}</span>`).join('')
      + `</div>`
      + (cache.length ? html`<div class="page-sub" style="margin-top:8px">Настройки сервера: ${cache.join(' · ')}</div>` : '');
  };
  render();
  if (state.cache == null) {
    // Настройки отдаются только запросом POST {"action":"get"}: на GET /settings
    // сервер отвечает 404.
    try { state.cache = await tsJson('/settings', { action: 'get' }); } catch { state.cache = null; }
    if (state.cache) render();
  }
}

/* Строки раздач обновляются на месте: перерисовка всего списка каждые три
   секунды сбрасывала бы прокрутку, а раздачи с нулевой скоростью прыгали бы
   вверх-вниз. Порядок — по скорости, затем по времени добавления. */
function paintTorrentRows(list) {
  const box = $('#dlTorrents');
  if (!box) return;
  const rows = list.map(t => {
    const total = Number(t.torrent_size) || 0;
    const loaded = Number(t.loaded_size) || 0;
    const pre = Number(t.preload_size) || 0;
    const preB = Number(t.preloaded_bytes) || 0;
    const part = pre > 0 ? preB / pre : (total > 0 ? loaded / total : 0);
    return { t, total, pre, preB, part: Math.max(0, Math.min(1, part)), speed: Number(t.download_speed) || 0 };
  }).sort((a, b) => (b.speed - a.speed) || ((b.t.timestamp || 0) - (a.t.timestamp || 0)));
  const key = rows.map(r => r.t.hash).join(',');
  if (key !== dlRowsKey) {
    dlRowsKey = key;
    box.innerHTML = rows.length
      ? `<div class="trow thead"><div>Раздача</div><div>Подгрузка</div><div>Размер</div><div>↓</div><div>↑</div><div>Сиды/пиры</div><div>В кэше</div><div>Прочитано</div></div>`
        + rows.map(r => html`<div class="trow" data-th="${r.t.hash}">
          <div class="tname" title="${r.t.title || r.t.hash}"><span class="tlabel">${r.t.title || r.t.hash}</span><span class="chip tstat"></span></div>
          <div><div class="progress"><i data-f="bar"></i></div></div>
          <div class="tcell" data-f="size"></div>
          <div class="tcell" data-f="dl"></div>
          <div class="tcell" data-f="ul"></div>
          <div class="tcell" data-f="peers"></div>
          <div class="tcell" data-f="pre"></div>
          <div class="tcell" data-f="read"></div>
        </div>`).join('')
      : '<div class="empty">На сервере нет раздач</div>';
    if (!rows.length) return;
  }
  rows.forEach(r => {
    const row = box.querySelector('[data-th="' + r.t.hash + '"]');
    if (!row) return;
    const set = (f, v) => { const e = row.querySelector('[data-f="' + f + '"]'); if (e) e.textContent = v; };
    const bar = row.querySelector('[data-f="bar"]');
    if (bar) bar.style.width = Math.round(r.part * 100) + '%';
    set('size', r.total ? fmtSize(r.total) : '—');
    set('dl', r.speed > 0 ? fmtSpeed(r.speed) : '—');
    set('ul', Number(r.t.upload_speed) > 0 ? fmtSpeed(Number(r.t.upload_speed)) : '—');
    set('peers', (Number(r.t.connected_seeders) || 0) + ' / ' + (Number(r.t.active_peers) || 0));
    set('pre', r.pre ? fmtSize(r.preB) + ' из ' + fmtSize(r.pre) : '—');
    set('read', Number(r.t.bytes_read) ? fmtSize(Number(r.t.bytes_read)) : '—');
    const st = row.querySelector('.tstat');
    if (st) {
      st.textContent = String(r.t.stat_string || PREP_STAGES[Number(r.t.stat)] || '');
      st.title = r.part > 0 ? 'подгружено ' + Math.round(r.part * 100) + '%' : '';
    }
    row.classList.toggle('busy', r.speed > 0);
  });
}
function renderDownloads(root) {
  dlRowsKey = '';
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Загрузки</h1>
    <div class="page-sub" id="dlFolder"></div></div>
      <button data-act="dlrefresh" class="iconbtn" title="Обновить">⟳</button></div>
    <div class="card" id="dlSummary"><div class="empty">Сведения о сервере...</div></div>
    <div class="card" id="dlTorrents"><div class="empty">Сведения о раздачах...</div></div>
    <div class="card"><div class="row wrap"><b>Папка для сохранения:</b> <code id="dlPath"></code>
      <button data-dlpath>Изменить</button></div>
      ${raw(folderNoticeHTML('downloads'))}</div>
    <h2 class="sec-h">Сохранение на диск</h2>
    <div id="dljobs"></div>`;
  loadDownloads().then(j => { state.dlJobs = j.jobs; $('#dlPath').textContent = j.folder || state.hello.download_folder || '—'; paintDownloads(); });
  $('[data-act="dlrefresh"]').addEventListener('click', () => { state.cache = null; dlRowsKey = ''; pollDownloads(); });
  pollDownloads();
  $('[data-dlpath]').addEventListener('click', async () => {
    const p = prompt('Папка для загрузок:', state.hello.download_folder); if (!p) return;
    await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dirs', download_folder: p }) });
    state.hello.download_folder = p; $('#dlPath').textContent = p;
    // Перерисовка целиком, а не правка одной строки: предупреждение о
    // недоступной папке должно появиться (или исчезнуть) вместе с новым путём.
    await refreshFolders(); toast('Папка обновлена'); route();
  });
  hookFolderFix(root);
}
function paintDownloads() {
  const el = $('#dljobs'); if (!el) return;
  if (!state.dlJobs.length) { el.innerHTML = '<div class="empty">Нет активных загрузок</div>'; return; }
  el.innerHTML = state.dlJobs.map((j, i) => html`
    <div class="card">
      <div class="row wrap">
        <div style="flex:1"><b>${j.file_name || j.name}</b> <span class="chip">${j.status}</span>
        ${raw(j.error ? html` <span class="chip" style="background:#3a1d22;color:#ff9d9d">${j.error}</span>` : '')}</div>
        <span>${fmtSize(j.done)} / ${j.total ? fmtSize(j.total) : '?'}</span>
        ${raw(j.status === 'done' ? html`<button data-openfolder="${i}">Открыть папку</button>` : '')}
      </div>
      <div class="progress"><i style="width:${j.total ? Math.min(100, j.done / j.total * 100) : 5}%"></i></div>
    </div>`).join('');
  $$('#dljobs [data-openfolder]').forEach(b => b.addEventListener('click', () => {
    const j = state.dlJobs[parseInt(b.dataset.openfolder, 10)];
    if (!j || !j.path) return;
    const dir = j.path.substring(0, j.path.lastIndexOf('\\'));
    if (dir) window.open('file:///' + encodeURI(dir.replace(/\\/g, '/')));
  }));
}

/* ================= SERIES ================= */
function renderSeries(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Сериалы</h1>
      <div class="page-sub">Все сезоны и серии из вашей библиотеки — клик по серии запускает просмотр</div></div>
      <input class="search-input" id="serQuery" placeholder="Фильтр сериалов..." value="${localStorage.getItem('tc_serq') || ''}">
    </div>
    <div id="serBody"><div class="empty">Загрузка библиотеки...</div></div>`;
  $('#serQuery').addEventListener('input', () => { localStorage.setItem('tc_serq', $('#serQuery').value); paintSeriesBody(); });
  loadLibrary().catch(() => {}).then(paintSeriesBody);
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
/* Разбор номера серии. Порядок образцов взят у прежнего клиента: сначала
   S01E02 (в том числе диапазон S01E01-10), затем «Сезон 1 Серия 2», затем
   привычные 1x02 и, как крайний случай, один «Сезон 1» без серии. */
const RE_SXEX = /(?:^|[^\p{L}\p{N}])s(\d{1,3})\s*e(\d{1,4})(?:-e?(\d{1,4}))?(?:$|[^\p{L}\p{N}])/iu;
const RE_RU_EP = /(?:^|[^\p{L}\p{N}])сезон[ ._-]*(\d{1,3})[ ._-]+серия[ ._-]*(\d{1,4})(?:$|[^\p{L}\p{N}])/iu;
const RE_SEASON_WORD = /[Ss](?:eason)?\.?\s*(\d{1,2})\s*[Ee](?:p|pisode)?\.?\s*(\d{1,3})(?:$|[^\p{L}\p{N}])/;
function parseSeriesEp(name) {
  const s = String(name || '');
  let m = s.match(RE_SXEX);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10), e2: m[3] ? parseInt(m[3], 10) : 0 };
  m = s.match(RE_RU_EP);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10), e2: 0 };
  m = s.match(/(?:^|[^\p{L}\p{N}])[Ss]?(\d{1,2})[xX]\s*(\d{1,3})(?:$|[^\p{L}\p{N}])/u);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10), e2: 0 };
  m = s.match(RE_SEASON_WORD);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10), e2: 0 };
  m = s.match(/Сезон\s*(\d{1,2})/i);
  if (m) return { s: parseInt(m[1], 10), e: 0, e2: 0 };
  return null;
}
function cleanSeriesName(s) {
  return String(s || '')
    .replace(/(?:^|[Ss])\d{1,2}[xX]\s*\d{1,3}\b/gi, ' ')
    .replace(/[Ss](?:eason)?\.?\s*\d{1,2}\s*[Ee](?:p|pisode)?\.?\s*\d{1,3}/gi, ' ')
    .replace(/Сезон\s*\d{1,2}/gi, ' ')
    .replace(/[\[\(]?(?:19|20)\d{2}[\]\)]?/g, ' ')
    .replace(/\b(2160p?|4k|uhd|1080p?|720p?|480p?|bdrip|blu-?ray|web-?dl|web-?d?l?rip|hdrip|dvdrip|hdtv|hdr|sdr|avc|hevc|x26[45])\b/gi, ' ')
    .replace(/\b[а-яёЁ]\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/* seasonOf достаёт номер сезона из названия раздачи.
   На трекере сезон пишут по-разному: «Сезон 3», «[1-8 сезон]», «3 сезон»,
   «S03». Прежний разбор знал только «Сезон N» — и раздача с записью
   «[1-8 сезон]», которых на трекере большинство, пропадала из вкладки
   «Сериалы» целиком, хотя isSeries её сериалом считает. */
function seasonOf(title) {
  const s = String(title || '');
  // «1-8 сезон» — диапазон перед словом, сезоном считается его начало.
  let m = s.match(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*сезон/iu);
  if (m) return parseInt(m[1], 10);
  // «5 сезон» — число перед словом.
  m = s.match(/(?:^|[^\p{L}\p{N}])(\d{1,2})\s+сезон/iu);
  if (m) return parseInt(m[1], 10);
  // «Сезон 3» — число после слова. Хвост обязателен: без него «сезон 1080p»
  // читался бы как десятый сезон, и раздача попадала не в свою группу.
  m = s.match(/сезон[ыа]?[ ._-]*(\d{1,2})(?:$|[^\p{L}\p{N}])/iu);
  if (m) return parseInt(m[1], 10);
  m = s.match(/(?:^|[^\p{L}\p{N}])s(\d{1,2})(?:$|[^\p{L}\p{N}])/iu);
  if (m) return parseInt(m[1], 10);
  return 0;
}
/* seriesInfo — то же, что parseSeriesEp, но с запасным разбором одного сезона:
   для названия раздачи этого достаточно, а для имени файла — нет. */
function seriesInfo(title) {
  const p = parseSeriesEp(title);
  if (p) return p;
  const s = seasonOf(title);
  return s ? { s, e: 0, e2: 0 } : null;
}
function paintSeriesBody() {
  const body = $('#serBody'); if (!body) return;
  const q = ($('#serQuery').value || '').trim().toLowerCase();
  const groups = new Map();
  (state.lib || []).forEach(t => {
    if (!isSeries(t.title || '')) return;
    const info = seriesInfo(t.title);
    if (!info) return;
    const key = cleanSeriesName(t.title).toLowerCase();
    if (!key) return;
    if (q && !(key.includes(q) || (t.title || '').toLowerCase().includes(q))) return;
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(t);
  });
  const list = [...groups.values()].sort((a, b) => cleanSeriesName(a.items[0].title || '').localeCompare(cleanSeriesName(b.items[0].title || ''), 'ru'));
  if (!list.length) {
    body.innerHTML = html`<div class="empty">${q ? 'Нет совпадений.' : 'Сериалов в библиотеке нет. Добавьте торренты сериалов в Библиотеку.'}</div>`;
    return;
  }
  body.innerHTML = html`<div class="page-sub">Сериалов: ${list.length}</div>` + list.map(g => seriesCard(g)).join('');
  $$('[data-series]', body).forEach(b => b.addEventListener('click', () => {
    const parts = b.dataset.series.split('|');
    const [hash, sn, e, fid] = [parts[0], parts[1], parts[2], parts[3] || ''];
    const t = state.lib.find(x => x.hash === hash); if (!t) return;
    if (fid) {
      const stat = (statCache[t.hash] && statCache[t.hash].data) || t;
      const f = (stat.file_stats || []).find(x => String(x.id) === fid);
      if (f) return playSelected(t, f);
    }
    watchNow(t);
  }));
  $$('[data-watch]', body).forEach(b => b.addEventListener('click', () => {
    const t = state.lib.find(x => x.hash === b.dataset.watch);
    if (t) watchNow(t);
  }));
  // Названия серий подгружаются по каждой карточке отдельно: ключ запроса — имя
  // сериала, и для всех карточек сразу он был бы один.
  $$('.card[data-sername]', body).forEach(card => {
    const t = (state.lib || []).find(x => x.hash === card.dataset.serhash);
    if (t) loadEpNames(card, t);
  });
  seriesPosters(list);
}
/* seriesPosters подтягивает постеры и оценку к карточкам сериала.
   Ключ запроса — название сериала без сезона и раздачи: у одной группы бывает
   несколько раздач, и спрашивать по каждой незачем. Уже полученные постеры
   хранятся в самой раздаче, поэтому повторный проход не начинается. */
const SERIES_POSTER_MAX = 40;

async function seriesPosters(list) {
  const heads = (list || []).map(g => g.items[0]).filter(t => t && !t.poster).slice(0, SERIES_POSTER_MAX);
  if (!heads.length) return;
  let changed = false;
  await ratingsByTitle(groupByTitle(heads), (j, task) => {
    if (!j || !j.ok) return;
    for (const t of task.ts) {
      if (j.poster && !t.poster) { t.poster = j.poster; changed = true; }
      applyRatingChips('.ser-card[data-serhash="' + t.hash + '"]', j);
    }
  });
  if (changed) paintSeriesBody();
}
function seriesCard(g) {
  const seasons = new Map();
  g.items.forEach(t => {
    const e = seriesInfo(t.title) || {};
    const s = e.s || 0;
    if (!seasons.has(s)) seasons.set(s, []);
    const stat = (statCache[t.hash] && statCache[t.hash].data) || t;
    const vids = playableOf(stat).filter(v => isVideo(v.path));
    const eps = vids.map(v => {
      const pe = parseSeriesEp(basename(v.path));
      return { fid: v.id, s: (pe && pe.s) || s, e: (pe && pe.e) || 0 };
    });
    // Список файлов ещё не пришёл: показываем одну кнопку сезона, по ней
    // откроется список серий — он и запросит сведения у сервера.
    if (!eps.length) eps.push({ fid: 0, s, e: e.e || 0 });
    seasons.get(s).push({ t, eps });
  });
  const sels = [...seasons.keys()].sort((a, b) => a - b);
  const head = g.items[0];
  const all = g.items.reduce((n, t) => {
    const stat = (statCache[t.hash] && statCache[t.hash].data) || t;
    return n + playableOf(stat).filter(v => isVideo(v.path)).length;
  }, 0);
  const seen = g.items.reduce((n, t) => {
    const stat = (statCache[t.hash] && statCache[t.hash].data) || t;
    return n + playableOf(stat).filter(v => isVideo(v.path) && isWatched(t, v.id)).length;
  }, 0);
  return html`<div class="card ser-card" data-sername="${cleanSeriesName(head.title)}" data-serhash="${head.hash}">
    <div class="ser-poster">
      ${raw(PH_SVG.replace('class="ph"', head.poster ? 'class="ph hidden"' : 'class="ph"'))}
      ${raw(head.poster ? html`<img src="${head.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <span class="chip rating" data-tmdb hidden></span>
    </div>
    <div class="ser-main">
    <div class="row wrap"><h3 style="flex:1;margin:0">${cleanSeriesName(head.title)}</h3>
      <span class="chip">${g.items.length} ${plural(g.items.length, 'торрент', 'торрента', 'торрентов')}</span>
      ${raw(all ? html`<span class="chip">${seen} из ${all} ${plural(all, 'серии', 'серий', 'серий')}</span>` : '')}
      <button data-watch="${head.hash}">▶ Смотреть</button></div>
    <div style="margin-top:10px">` + sels.map(sn => {
      const srows = seasons.get(sn);
      return html`<div class="eps-season" data-sn="${sn}">
        <div class="eps-season-h">${sn ? 'Сезон ' + sn : 'Сезон не указан'}</div>
        <span class="eps">${raw(srows.map(it => it.eps.map(ep => {
          const mark = ep.fid ? markOf(it.t, ep.fid) : null;
          const watched = !!(mark && mark.done);
          const tc = mark && !mark.done ? mark.timecode || 0 : 0;
          const cls = [watched ? 'viewed' : '', tc > 0 ? 'cont' : ''].filter(Boolean).join(' ');
          const lab = ep.e ? 'Серия ' + ep.e : (sn ? 'Сезон ' + sn : 'Сезон');
          const state = watched ? ' · просмотрено' : (tc > 0 ? ' · с ' + fmtPos(tc) : '');
          const title = (sn ? 'Сезон ' + sn + ' · ' : '') + lab + ' — ' + (it.t.title || '') + state;
          return html`<button data-series="${it.t.hash}|${sn}|${ep.e}|${ep.fid}" data-ep-num="${ep.e || 0}" data-sn="${sn}" class="${cls}" title="${title}">${lab}<span class="epname"></span>${raw(tc > 0 ? html` <span class="epstate">${fmtPos(tc)}</span>` : '')}</button>`;
        }).join('')).join(''))}</span></div>`;
    }).join('') + `</div></div></div>`;
}
/* ================= SETTINGS ================= */
function renderSettings(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Настройки TorrClient</h1></div></div>
    <div class="card"><h3>Серверы TorrServer <button id="setOpenTs" style="float:right">Открыть сервер в браузере</button></h3>
      <div id="profList"></div>
      <div class="divider"></div>
      <h3>Добавить сервер</h3>
      <div class="row wrap">
        <input id="npName" placeholder="Название" style="flex:1;min-width:120px">
        <input id="npUrl" placeholder="http://192.168.1.10:8090" style="flex:2;min-width:200px">
        <input id="npUser" placeholder="Логин (если включён auth)" style="flex:1">
        <input id="npPass" placeholder="Пароль" type="password" style="flex:1">
        <button id="npAdd" class="primary">Добавить</button>
      </div>
      <div class="page-sub">По умолчанию уже добавлен локальный сервер 127.0.0.1:8090. Для удалённого сервера укажите его адрес (поддержаны security-сертификаты — включите Skip SSL в полях).</div>
    </div>
    <div class="card"><h3>Постеры и рейтинги (TMDB)</h3>
      <p class="page-sub">API Key themoviedb.org — автоматически подставляем постеры в результаты поиска. Заполните на <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a>.</p>
      <div class="row wrap">
        <input id="tmdbKey" placeholder="API Key (v3) — 32 знака" style="flex:2;min-width:200px">
        <button id="tmdbSave" class="primary">Сохранить</button>
        <span id="tmdbStat" class="chip grey"></span>
      </div>
    </div>
    <div class="card"><h3>Автодобавление .torrent</h3>
      <p class="page-sub">Файлы .torrent, которые сохранены вашим браузером (Firefox/Chrome) из «Просмотровать в приложениях», автоматически добавятся через watch-папку.</p>
      <div class="row wrap">
        <input id="wfPath" value="${state.hello.watch_folder}" style="flex:2">
        <button id="wfBrowse">Обзор</button>
        <button id="wfReg" class="primary">Зарегистрировать magnet:// и .torrent</button>
      </div>
      ${raw(folderNoticeHTML('watch'))}
      <div class="row wrap" style="margin-top:8px">
        <label style="margin:0"><input type="checkbox" id="wfEnabled" ${state.watchOk !== false ? 'checked' : ''}> Включить автозагрузку</label>
      </div>
      <div id="wfLog" class="mono" style="margin-top:10px; max-height:160px; overflow:auto; white-space:pre-wrap"></div>
    </div>
    <div class="card"><h3>Где хранятся данные</h3>
      <p class="page-sub">Кэш — постеры, оценки и журнал работы. Потерять его не страшно: постеры и оценки соберутся заново. Поэтому папку кэша можно указать на диск, который очищается при перезагрузке.</p>
      <div class="row wrap">
        <input id="cfPath" value="${state.hello.cache_folder || ''}" style="flex:2">
        <button id="cfBrowse">Обзор</button>
      </div>
      ${raw(folderNoticeHTML('cache'))}
      <div class="divider"></div>
      <p class="page-sub">Постоянные данные — отметки просмотра («продолжить просмотр») и избранное с закладками. Заново их не собрать, поэтому папка должна лежать на постоянном диске. Сами настройки остаются рядом с программой: в них записаны обе эти папки.</p>
      <div class="row wrap">
        <input id="dfPath" value="${state.hello.data_folder || ''}" style="flex:2">
        <button id="dfBrowse">Обзор</button>
      </div>
      ${raw(folderNoticeHTML('data'))}
    </div>
    <div class="card"><h3>Свой список</h3>
      <p class="page-sub">Импорт/экспорт избранных магнитов (сохраняется локально в безе браузера).</p>
      <div class="row"><button id="expList">Экспорт JSON</button><button id="impList">Импорт JSON</button><input type="file" id="impInput" accept=".json,.txt" hidden></div>
    </div>
    <div class="card"><h3>Перенос состояния</h3>
      <p class="page-sub">Один архив со всем состоянием: настройки серверов и плееров, избранное, отметки просмотра. Кэш постеров и закачки в архив не входят — это не состояние, а временные данные.</p>
      <div class="row">
        <button id="backupDl">Скачать архив</button>
        <button id="restoreBtn">Восстановить из архива</button>
        <input type="file" id="restoreInput" accept=".zip" hidden>
      </div>
    </div>
    <div class="card"><h3>Автооткрытие и встроенные</h3>
      <label style="margin:0"><input type="checkbox" id="autoOpen" ${localStorage.getItem('tc_autoopen') !== '0' ? 'checked' : ''}> Автоматически открывать UI после добавления торрента</label>
    </div>`;

  const pp = state.profiles.map(p => html`
    <div class="row wrap" style="margin:6px 0">
      <b style="flex:1; min-width:120px">${p.name}</b>
      <span class="mono" style="flex:2">${p.url}</span>
      ${raw(p.id === state.active ? html`<span class="chip">активный</span>` : html`<button data-act="act" data-id="${p.id}">Сделать активным</button>`)}
      <button data-act="set" data-id="${p.id}">Править</button>
      <button data-act="del" data-id="${p.id}" class="danger">Удалить</button>
    </div>`).join('');
  $('#profList').innerHTML = pp || '<div class="empty">Нет серверов</div>';
  $$('#profList [data-act]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id; const p = state.profiles.find(x => x.id === id); if (!p) return;
      const act = b.dataset.act;
      if (act === 'act') { await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'active', id }) }); state.active = id; renderTopbar(); renderServerStatus(); route(); }
      if (act === 'set') { editProfileModal(p); }
      if (act === 'del') { if (confirm('Удалить сервер ' + p.name + '?')) { await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'del', id }) }); route(); } }
    });
  });
  $('#npAdd').addEventListener('click', addProfile);
  $('#wfReg').addEventListener('click', async () => {
    try { await api('/api/reg?action=install', { method: 'POST' }); toast('Протокол magnet:// зарегистрирован. Проверьте, что TorrClient — браузер по умолчанию для magnet.'); renderServerStatus(); } catch (e) { toast(e.message, true); }
  });
  $('#expList').addEventListener('click', exportList);
  $('#impList').addEventListener('click', () => $('#impInput').click());
  $('#impInput').addEventListener('change', e => importList(e.target.files[0]));
  const rb = $('#restoreBtn');
  if (rb) rb.addEventListener('click', () => $('#restoreInput').click());
  const ri = $('#restoreInput');
  if (ri) ri.addEventListener('change', e => restoreBackup(e.target.files[0]));
  const bd = $('#backupDl');
  // Переход по адресу, а не fetch: ответ отдаётся вложением, и браузер сам
  // показывает сохранение файла.
  if (bd) bd.addEventListener('click', () => { window.location.href = '/api/backup'; });
  $('#autoOpen').addEventListener('change', e => localStorage.setItem('tc_autoopen', e.target.checked ? '1' : '0'));
  // Папки меняются одним и тем же диалогом: различаются только подпись и поле
  // настройки, поэтому отдельная ветка на каждую папку ничего не добавляла бы,
  // кроме повода забыть про новую.
  $('#wfBrowse').addEventListener('click', () => setFolderFromPrompt('watch', 'Папка для watch (.torrent):'));
  $('#cfBrowse').addEventListener('click', () => setFolderFromPrompt('cache', 'Папка кэша (постеры, оценки, журнал):'));
  $('#dfBrowse').addEventListener('click', () => setFolderFromPrompt('data', 'Папка постоянных данных (отметки просмотра, избранное):'));
  hookFolderFix(root);
  const so = $('#setOpenTs'); if (so) so.addEventListener('click', openServerInBrowser);
  (async () => { try { const m = await api('/api/meta'); $('#tmdbStat').textContent = m.configured ? 'ключ сохранён' : 'ключ не задан'; } catch {} })();
  $('#tmdbSave').addEventListener('click', async () => {
    const k = $('#tmdbKey').value.trim(); if (!k) return toast('Введите API Key', true);
    try {
      await api('/api/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k }) });
      toast('TMDB ключ сохранён'); $('#tmdbStat').textContent = 'ключ сохранён';
      // Демон уже забыл отказы, запомненные по прежнему ключу; здесь то же
      // самое делается для отказов, запомненных интерфейсом.
      forgetMetaMisses();
      // То, что не нашлось по прежнему ключу, спрашивается заново — иначе
      // библиотека осталась бы без постеров до перезапуска окна.
      if ((state.lib || []).length) libRatings();
    }
    catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
  });
  refreshWatchLog();
}
function editProfileModal(p) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal"><button class="modal-close" data-close>✕</button><h2>Изменить сервер</h2>
    <label>Название</label><input id="epName" value="${p.name}">
    <label>URL</label><input id="epUrl" value="${p.url}">
    <label>Логин</label><input id="epUser" value="${p.user || ''}">
    <label>Пароль</label><input id="epPass" type="password" value="${p.pass || ''}">
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button data-close>Отмена</button><button id="epGo" class="primary">Сохранить</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#epGo').addEventListener('click', async () => {
    p.name = ov.querySelector('#epName').value; p.url = ov.querySelector('#epUrl').value; p.user = ov.querySelector('#epUser').value; p.pass = ov.querySelector('#epPass').value;
    await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', profile: p }) });
    ov.remove(); state.profiles = await (await api('/api/profiles')).profiles; renderTopbar(); route();
  });
}
async function addProfile() {
  const name = $('#npName').value.trim(); const url = $('#npUrl').value.trim();
  if (!name || !url) return toast('Заполните название и URL', true);
  const res = await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', profile: { name, url, user: $('#npUser').value, pass: $('#npPass').value } }) });
  state.profiles = (await api('/api/profiles')).profiles || state.profiles;
  state.active = (res && res.id) || (state.profiles.length ? state.profiles[0].id : '');
  renderTopbar(); route();
}
function exportList() {
  const ul = JSON.parse(localStorage.getItem('tc_userlist') || '[]');
  const data = JSON.stringify(ul, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'torrclient-list.json'; a.click();
}
function importList(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try { const arr = JSON.parse(r.result); if (Array.isArray(arr)) { localStorage.setItem('tc_userlist', JSON.stringify(arr)); toast('Импортировано ' + arr.length + ' позиций'); } } catch (e) { toast('Ошибка импорта: ' + e.message, true); }
  };
  r.readAsText(file);
}
async function refreshWatchLog() {
  const el = $('#wfLog'); if (!el) return;
  try { const j = await api('/api/watch'); $('#wfLog').textContent = (j.log || []).join('\n'); } catch {}
}
/* restoreBackup возвращает состояние из архива. Подтверждение обязательно:
   возврат затирает текущие настройки, избранное и отметки, а отменить это нечем. */
async function restoreBackup(file) {
  if (!file) return;
  if (typeof confirm === 'function' && !confirm('Заменить текущие настройки, избранное и отметки содержимым архива?')) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/restore', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    toast('Состояние восстановлено: ' + (j.files || []).join(', '));
    state.hello = await api('/api/hello');
    state.profiles = state.hello.profiles || [];
    state.players = state.hello.players || [];
    state.active = state.hello.active_profile_id;
    await loadUserData();
    await loadPositions();
    renderTopbar();
    route();
  } catch (e) {
    toast('Восстановление не удалось: ' + e.message, true);
  }
}

/* ================= SERVER ================= */
function renderServer(root) {
  root.innerHTML = `
    <div class="toolbar"><div class="grow"><h1 class="page-title">Настройки сервера</h1>
    <div class="page-sub" id="serAct"></div></div></div>
    <div class="card"><div class="row">
      <div class="grow">Веб-интерфейс TorrServer для углублённых настроек.</div>
      <button id="openTs" class="primary">Открыть сервер в браузере</button>
    </div></div>
    <div class="card"><div class="tabs">
      <button data-ss="settings" class="on">BitTorr</button>
      <button data-ss="info">О сервере</button>
    </div><div id="serverPane"></div></div>`;
  const prof = state.profiles.find(p => p.id === state.active) || {};
  $('#serAct').textContent = 'Активный сервер: ' + prof.name;
  $$('[data-ss]').forEach(b => b.addEventListener('click', () => {
    $$('[data-ss]').forEach(x => x.classList.remove('on')); b.classList.add('on');
    renderServerPane(b.dataset.ss);
  }));
  renderServerPane('settings');
  const ob = $('#openTs'); if (ob) ob.addEventListener('click', openServerInBrowser);
}
let _serverSets = null;

/* Набор «только оперативная память, без следов». Кэш живёт в RAM и
   освобождается при снятии раздачи, на диск не пишется ничего, отдача
   выключена — сервер не раздаёт и не копит за собой данных.

   Числа подобраны под стриминг: кэш 128 МБ (вдвое больше умолчания — хватает
   на 4K без постоянных докачек), предзагрузка 30 % (старт быстрый, и RAM не
   занимается зря), лимит соединений скромный, простаивающая раздача снимается
   через 15 с и сразу отпускает память.

   DHT и PEX нарочно оставлены включёнными: без них публичные раздачи ищут
   пиров заметно медленнее. А вот локальное обнаружение (LPD/Bonjour) выключено —
   на одной машине оно бесполезно, а в сеть болтает лишнее.

   Набор НЕ трогает список трекеров, ключи SSL и настройки TMDB: отправка
   настроек у TorrServer заменяет объект целиком, и лишний ключ в наборе
   означал бы потерю чужих значений. */
function ramOnlyPreset() {
  return {
    UseDisk: false,
    TorrentsSavePath: '',
    RemoveCacheOnDrop: true,
    DisableUpload: true,
    EnableLPD: false,
    EnableBonjour: false,
    CacheSize: 128 * 1024 * 1024,
    PreloadCache: 30,
    ConnectionsLimit: 25,
    TorrentDisconnectTimeout: 15,
  };
}

/* Полный объект настроек для отправки на сервер: прочитанное плюс правки.

   Отдельная функция не для красоты. action:set у TorrServer не сливает
   присланное с текущим — недостающие поля обнуляются. Отправишь только правки
   («так ведь короче») — и сервер потеряет список трекеров, предзагрузку и всё
   остальное, чего в правках не было. Проверено живьём: частичный набор ровно
   так и сбросил TrackersListURL. Поэтому основа — прочитанное, а правки лишь
   накладываются сверху. */
function mergeServerSets(base, edits) {
  return { ...(base || {}), ...(edits || {}) };
}

/* Поля настроек BitTorr по группам: [ключ, подпись, вид]. Вид: 'bool' —
   переключатель, 'mb' — размер в мегабайтах (сервер хранит байты), иначе число
   или строка.

   Ключи сверены с ответом сервера: прежние ReadAheadBytes и RemoteDownloads в
   нём отсутствуют, а чтение вперёд называется ReaderReadAHead. */
const serverFields = [
  ['Память и кэш', [
    ['CacheSize', 'Размер кэша', 'mb'],
    ['PreloadCache', 'Предзагрузка, %'],
    ['ReaderReadAHead', 'Чтение вперёд, %'],
    ['UseDisk', 'Кэш на диске', 'bool'],
    ['RemoveCacheOnDrop', 'Освобождать кэш при снятии раздачи', 'bool'],
    ['TorrentDisconnectTimeout', 'Снимать простаивающую раздачу, с'],
    ['TorrentsSavePath', 'Папка сохранения (пусто — не сохранять)'],
  ]],
  ['Сеть и нагрузка', [
    ['ConnectionsLimit', 'Лимит соединений'],
    ['DownloadRateLimit', 'Ограничение скачивания, байт/с (0 — без)'],
    ['UploadRateLimit', 'Ограничение отдачи, байт/с (0 — без)'],
    ['DisableUpload', 'Не отдавать (только смотреть)', 'bool'],
    ['DisableDHT', 'Отключить DHT', 'bool'],
    ['DisablePEX', 'Отключить PEX', 'bool'],
    ['EnableLPD', 'Локальное обнаружение (LPD)', 'bool'],
    ['EnableBonjour', 'Bonjour', 'bool'],
    ['EnableIPv6', 'IPv6', 'bool'],
    ['ForceEncrypt', 'Принудительное шифрование', 'bool'],
    ['PeersListenPort', 'Порт пиров (0 — случайный)'],
  ]],
  ['Прочее', [
    ['ResponsiveMode', 'Режим отзывчивости', 'bool'],
    ['EnableDLNA', 'DLNA', 'bool'],
    ['EnableRutorSearch', 'Поиск rutor на сервере', 'bool'],
    ['EnableTorznabSearch', 'Поиск Torznab', 'bool'],
    ['RetrackersMode', 'Режим трекеров'],
  ]],
];

/* Значение поля для отправки на сервер: переключатель — булево, мегабайты —
   обратно в байты, пустая строка остаётся пустой (сервер понимает её как
   «не задано»), остальное — число, если им является. */
function serverFieldValue(inp) {
  const v = inp.value;
  if (inp.dataset.kind === 'bool') return v === 'true';
  if (inp.dataset.kind === 'mb') return Math.max(0, Math.round(Number(v) || 0)) * 1048576;
  if (v === '') return '';
  return isNaN(v) ? v : Number(v);
}

async function renderServerPane(tab) {
  const pane = document.querySelector('#serverPane'); if (!pane) return;
  if (tab === 'info') {
    pane.innerHTML = html`<div class="stat-line">
      <div><b>TorrClient:</b> ${state.hello.version || ''} · ОС ${state.hello.os || ''}</div>
      <div><b>Демон:</b> локальный компаньон на порту 8099</div>
      <div class="divider"></div>
      <div class="mono" style="white-space:pre-wrap">${JSON.stringify(state.hello, null, 2)}</div></div>`;
    return;
  }
  pane.innerHTML = '<div class="empty">Загрузка настроек BitTorr...</div>';
  try { _serverSets = await tsGet('/settings?action=get').catch(async () => (await jFetch('/settings', { action: 'get' })).json()); } catch (e) { _serverSets = null; }
  if (!_serverSets || typeof _serverSets === 'string') {
    // try POST action get
    try { const r = await fetch(ts('/settings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get' }) }); _serverSets = await r.json(); } catch (e) { _serverSets = null; }
  }
  if (!_serverSets) { pane.innerHTML = '<div class="empty">Не удалось получить настройки сервера (нужен auth?)</div>'; return; }
  const s = _serverSets.BitTorr || _serverSets || {};
  const mb = n => Math.round(Number(n || 0) / 1048576);
  pane.innerHTML = html`
    <div class="row wrap" style="align-items:center;gap:10px;margin-bottom:6px">
      <button id="ssPreset">Только оперативная память, без следов</button>
      <span class="page-sub" style="margin:0">Кэш живёт в RAM и освобождается при снятии раздачи, на диск не пишется ничего, отдача выключена.</span>
    </div>
    ${raw(serverFields.map(([group, list]) => html`
      <div class="divider"></div>
      <h3>${group}</h3>
      <div class="stat-line" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:8px 24px">
        ${raw(list.map(([k, label, kind]) => {
          if (kind === 'bool') return html`<div><b>${label}:</b> <select data-k="${k}" data-kind="bool"><option ${s[k] ? 'selected' : ''}>true</option><option ${s[k] ? '' : 'selected'}>false</option></select></div>`;
          if (kind === 'mb') return html`<div><b>${label}:</b> <input data-k="${k}" data-kind="mb" value="${mb(s[k])}" style="width:90px"> МБ</div>`;
          return html`<div><b>${label}:</b> <input data-k="${k}" value="${s[k]}" style="width:150px"></div>`;
        }).join(''))}
      </div>`).join(''))}
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="ssSave" class="primary">Сохранить</button></div>
    <details style="margin-top:10px"><summary class="page-sub" style="cursor:pointer">Все поля, как их отдаёт сервер</summary>
      <div class="mono" style="font-size:11px;white-space:pre-wrap">${JSON.stringify(s, null, 1)}</div>
    </details>`;

  const saveServerSets = async edits => {
    const r = await jFetch('/settings', { action: 'set', sets: mergeServerSets(s, edits) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  };

  const save = $('#ssSave');
  if (save) save.addEventListener('click', async () => {
    const edits = {};
    $$('[data-k]', pane).forEach(inp => { edits[inp.dataset.k] = serverFieldValue(inp); });
    try {
      await saveServerSets(edits);
      toast('Настройки сохранены');
      await refreshLibrary();
    } catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
  });

  const preset = $('#ssPreset');
  if (preset) preset.addEventListener('click', async () => {
    try {
      await saveServerSets(ramOnlyPreset());
      toast('Режим «только оперативная память» включён');
      renderServerPane('settings');
    } catch (e) { toast('Не удалось применить режим: ' + e.message, true); }
  });
}

/* ---------- modal helpers ---------- */
function closeModal() { const o = $('.overlay'); if (o) o.remove(); }
function openModal(html) {
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.innerHTML = html; document.body.appendChild(ov); return ov;
}

/* ---------- magnet/url fallback: open stream/save ---------- */
async function refreshServerOnView() {}

/* ---------- auto-open added hint ---------- */
document.addEventListener('DOMContentLoaded', () => { if (localStorage.getItem('tc_first') !== '1') { localStorage.setItem('tc_first', '1'); } });