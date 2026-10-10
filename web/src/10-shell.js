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

// Кэш и данные в одной папке — самая дорогая поломка из возможных: папку кэша
// принято уводить на очищаемый диск, и вместе с ней уезжают подписки и отметки
// просмотра, которые заново не собрать. Само сравнение делает демон
// (см. sameFolder), потому что на Windows регистр букв не различает папки.
function folderOverlapHTML() {
  const f = state.folders;
  if (!f || !f.cache || !f.data) return '';
  if (!samePath(f.cache.path, f.data.path)) return '';
  return html`<div class="folder-warn" style="margin-top:10px">
    <b>Кэш и постоянные данные лежат в одной папке</b>
    <div class="page-sub">Кэш можно увести на очищаемый диск — постеры и оценки соберутся заново. А вот подписки и отметки просмотра заново не собрать: они уедут вместе с кэшем при первой же очистке. Разведите папки: укажите кэшу отдельный путь.</div>
  </div>`;
}

// samePath сравнивает пути как папки, а не как строки: хвостовой слеш и регистр
// букв не должны выдавать одну и ту же папку за две разные.
function samePath(a, b) {
  const norm = s => String(s || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  const x = norm(a);
  return !!x && x === norm(b);
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
  // Новые серии по подписке: демон нашёл их сам, интерфейс только показывает.
  eventsSrc.addEventListener('subs', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch (err) { return; }
    subsArrived(d);
  });
  eventsSrc.addEventListener('handoff', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch (err) { return; }
    handoffArrived(d);
  });
  eventsSrc.addEventListener('sleep', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch (err) { return; }
    sleepEvent(d);
  });
  // Подписка проверена (например, только что заведённая) — перечитать список.
  eventsSrc.addEventListener('subs_changed', () => {
    loadSubs().then(() => { if (state.view === 'subs') paintSubsBody(); else if (state.view === 'home') paintHome(); }).catch(() => {});
  });
  eventsSrc.addEventListener('torrents', e => {
    let list = [];
    try { list = JSON.parse(e.data); } catch (err) { return; }
    if (!Array.isArray(list)) return;
    if ($('#dlTorrents')) { paintTorrentRows(list); paintCacheCard(list); }
  });
  eventsSrc.addEventListener('state', () => {
    loadUserData().then(() => { if (state.view === 'library') paintLibrary(); else if (state.view === 'home') paintHome(); }).catch(() => {});
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
  invalidateMarks();

  const key = viewedSignature();
  if (key === viewedKey) return;
  const first = !viewedKey;
  viewedKey = key;
  // Первое событие — это то, что уже нарисовано. Открытое окно перерисовывать
  // нельзя: пользователь как раз выбирает серию или правит настройки.
  if (first || $('.overlay')) return;
  if (state.view === 'library') paintLibrary();
  else if (state.view === 'home') paintHome();
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
// pimg — картинку TMDB берём через демон: у части провайдеров image.tmdb.org
// не открывается, а демон умеет зеркало и держит кэш на диске.
function pimg(u) {
  const m = /^https?:\/\/image\.tmdb\.org(\/t\/p\/[^?#]+)$/.exec(String(u || ''));
  return m ? '/api/img?p=' + encodeURIComponent(m[1]) : (u || '');
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

/* ---------- переходы и история ----------
   Каждый переход — запись в истории браузера, поэтому «назад» и «вперёд» работают
   и кнопками мыши (боковые), и Alt+←/→, и жестом на телефоне. Параметры страницы
   (например, какой фильм открыт) лежат в записи истории — так они переживают и
   возврат, и перезагрузку. */
function sameParams(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }
function setView(v, params, opts) {
  const same = state.view === v && sameParams(state.params, params);
  state.view = v;
  state.params = params || null;
  try { localStorage.setItem(LS.view, v); } catch {}
  if (!(opts && opts.noPush)) {
    try {
      const rec = { v, p: state.params };
      if (same) history.replaceState(rec, '', '#/' + v);
      else history.pushState(rec, '', '#/' + v);
    } catch {}
  }
  markNav();
  closeSheet();
  route();
  // Новый раздел открывается с начала, а не с прокрутки прошлого.
  try { window.scrollTo(0, 0); } catch {}
}
window.addEventListener('popstate', e => {
  const st = e.state;
  if (!st || !st.v) return;
  setView(st.v, st.p, { noPush: true });
});
/* Боковые кнопки мыши: в браузере они ходят по истории сами, но в окне
   приложения (WebView) — не всегда, поэтому ход делаем сами и гасим
   штатный, чтобы не получить двойной шаг. */
['mousedown', 'auxclick'].forEach(ev => window.addEventListener(ev, e => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true));
window.addEventListener('mouseup', e => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  if (e.button === 3) history.back(); else history.forward();
}, true);
/* Стартовая страница: любой раздел или «последний открытый». */
const START_KEY = 'tc_start';
function startView() {
  let s = ''; try { s = localStorage.getItem(START_KEY) || ''; } catch {}
  if (s === 'last') { let l = ''; try { l = localStorage.getItem(LS.view) || ''; } catch {} if (l && l !== 'movie' && NAV_ITEMS.some(x => x[0] === l)) return l; return 'home'; }
  return NAV_ITEMS.some(x => x[0] === s) ? s : 'home';
}
function setStartView(v) {
  try { localStorage.setItem(START_KEY, v); } catch {}
  const it = NAV_ITEMS.find(x => x[0] === v);
  toast(v === 'last' ? 'Приложение будет открываться на последнем разделе' : 'Стартовая страница: «' + (it ? it[1] : v) + '»');
  $$('[data-view]').forEach(b => { if (b.closest('#nav')) b.classList.toggle('is-start', b.dataset.view === v); });
}
function route() {
  const v = state.view;
  // Модальные окна живут прямо в document.body, а не внутри <main>, и переход
  // по навигации оставлял их поверх чужой страницы: окно «Изменить торрент»
  // продолжало висеть над «Настройками», а закрыть его было нечем, кроме Esc.
  $$('body > .overlay:not(.whatsnew-ov)').forEach(o => o.remove());
  const pages = { movie: renderMovie, home: renderHome, library: renderLibrary, search: renderSearch, music: renderMusic, together: renderTogether, favorites: renderFavorites, bookmarks: renderBookmarks, players: renderPlayers, downloads: renderDownloads, series: renderSeries, subs: renderSubs, settings: renderSettings, server: renderServer };
  const fn = pages[v] || renderHome;
  const main = $('main'); main.innerHTML = '';
  main.dataset.view = v;
  main.classList.remove('rt-enter'); void main.offsetWidth; main.classList.add('rt-enter');
  // Крестики в полях ставятся и сразу, и после асинхронной отрисовки.
  Promise.resolve(fn(main)).finally(() => addClears(main));
  addClears(main);
}
function hookNav() {
  renderSidebarNav();
  paintShellIcons();
  applySideCollapsed();
  markNav();
  $$('#nav [data-view], #tabbar [data-view]').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.ctxmenu').forEach(m => m.classList.add('hidden')); setView(b.dataset.view); }));
  // Правый клик по разделу в панели — сделать его стартовым.
  $$('#nav [data-view]').forEach(b => b.addEventListener('contextmenu', e => { e.preventDefault(); setStartView(b.dataset.view); }));
  const sc = $('#sideCollapse'); if (sc) sc.addEventListener('click', toggleSide);
  const om = $('#omni'); if (om) om.addEventListener('click', () => openPalette());
  const ad = $('#addBtn'); if (ad) ad.addEventListener('click', () => openAddModal());
  // Число новых серий на вкладке: подписки проверяет демон и без открытой
  // страницы, а узнать об этом было бы неоткуда.
  loadSubs().catch(() => {});
}
function renderTopbar() {
  const prof = state.profiles.find(p => p.id === state.active) || {};
  const cur = $('#activeselect');
  if (!cur) return;
  const sel = document.createElement('select');
  sel.className = 'tb-select';
  sel.id = 'activeselect';
  sel.innerHTML = state.profiles.map(p => html`<option value="${p.id}" ${p.id === state.active ? 'selected' : ''}>${p.name}</option>`).join('');
  sel.addEventListener('change', async () => {
    // Смена активного сервера — запрос к демону, и он может не пройти. Прежде
    // отказ был не виден: селект и надпись уже показывали новый сервер, а
    // библиотека грузилась со старого.
    const prev = state.active;
    try {
      await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'active', id: sel.value }) });
      state.active = sel.value; renderServerStatus(); if (state.view === 'library') route();
    } catch (e) {
      toast('Сервер не переключился: ' + e.message, true);
      sel.value = prev;
    }
  });
  sel.classList.toggle('hidden', state.profiles.length < 2);
  cur.replaceWith(sel);
  renderServerStatus();
  renderMetaWarn();
}
function renderServerStatus() {
  const el = $('#serverStatus');
  if (!el) return;
  const prof = state.profiles.find(p => p.id === state.active) || {};
  el.innerHTML = html`<span class="dot ${state.active ? 'ok' : 'err'}"></span><span class="st-txt" title="${prof.name || '—'}"><b>${state.active ? 'Сервер на связи' : 'Нет сервера'}</b><small>${prof.name || 'TorrServer'}</small></span>`;
  el.title = 'Профиль TorrServer: ' + (prof.name || '—') + ' — открыть раздел «Сервер»';
  el.onclick = () => setView('server');
}

/* ---------- почему нет постеров ---------- */
/* «Ключ не задан» и «ключ отклонён» — разные состояния, и каждое надо назвать
   словами. Прежде демон отвечал «не найдено» на любую из этих причин, и
   пропавшие постеры выглядели как «сервис ничего не знает об этом фильме»:
   настройки при этом выглядели заполненными, и искать причину было негде.
   Теперь причина приходит кодом и висит в верхней строке, пока не исправлена. */
// Короткая надпись для шапки; полная причина — во всплывающей подсказке.
const META_ERR_SHORT = { 'tmdb key not configured': 'Нет ключа TMDB', 'tmdb key rejected': 'Ключ TMDB отклонён' };
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
  el.innerHTML = text ? ico('info', 15) + '<span class="tbw-l">' + esc(META_ERR_SHORT[state.metaError] || text) + '</span>' : '';
  el.title = text ? text + ' — открыть Настройки → TMDB' : '';
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
  if (!Array.isArray(arr)) { try { arr = await tsJson('/torrents', { action: 'list' }); } catch (e) { arr = null; } }
  // Сервер не ответил — это ошибка, а не пустая библиотека: после запуска
  // TorrServer поднимается не сразу, и пустой список прежде оставался на
  // экране до ручного обновления.
  if (!Array.isArray(arr)) throw new Error('TorrServer не отвечает');
  return pendingDrop.size ? arr.filter(t => !pendingDrop.has(t.hash)) : arr;
}
async function statTorrent(hash) {
  const r = await fetch(ts('/stream?link=' + encodeURIComponent(hash) + '&stat'));
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return j;
}
const statCache = {};
/* mergeStat кладёт статистику TorrServer поверх раздачи, не затирая известное
   пустым. TorrServer отдаёт poster: "" (и бывает title: "") у каждой раздачи,
   добавленной без постера, — а постеры библиотеки приходят из TMDB и хранятся
   у нас. Прежде Object.assign(cur, stat) через секунду после показа стирал
   только что поставленные обложки: в поиске они были, в библиотеке — нет. */
const STAT_KEEP = ['poster', 'title', 'category'];
function mergeStat(t, s) {
  const keep = {};
  for (const k of STAT_KEEP) if (t[k] && !(s && s[k])) keep[k] = t[k];
  return Object.assign(t, s, keep);
}
async function enrichStats(t) {
  const c = statCache[t.hash];
  if (c && Date.now() - c.at < 30000) { return mergeStat(Object.assign({}, t), c.data); }
  const s = await statTorrent(t.hash).catch(() => null);
  if (s && typeof s === 'object') { statCache[t.hash] = { at: Date.now(), data: s }; return mergeStat(Object.assign({}, t), s); }
  return Object.assign({}, t);
}
async function torrentAction(a, o = {}) { return tsJson('/torrents', Object.assign({ action: a }, o)); }
async function addTorrentRes(link, save) { const r = await jFetch('/stream', 'link=' + encodeURIComponent(link) + '&save&title=&category='); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

/* ================= LIBRARY ================= */
/* lookupView — отметки раздачи по номерам файлов. Форма записи та же, что у
   демона: позиция, длительность, признак «просмотрено». */
function lookupView(hash) { const m = {}; (state.viewed || []).forEach(v => { if (v.hash === hash) m[v.file_index] = v; }); return m; }


/* ================= ТАЙМЕР СНА =================
   Отсчёт ведёт демон: закрытое окно или телефон не останавливают таймер.
   Здесь только меню, обратный отсчёт на кнопке и предупреждение за минуту. */
const SLEEP_ACTIONS = { stop: 'остановить плеер', sleep: 'усыпить компьютер', shutdown: 'выключить компьютер' };
let sleepState = { active: false }, sleepTick = null;
async function sleepApi(body) {
  const j = await api('/api/sleep', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  sleepState = Object.assign({}, j, { until: Date.now() + (j.left || 0) * 1000 });
  paintSleep();
  return j;
}
function sleepRefresh() { sleepApi().catch(() => {}); }
function paintSleep() {
  const b = document.getElementById('sleepBtn'), l = document.getElementById('sleepLeft');
  if (!b || !l) return;
  clearInterval(sleepTick);
  if (!sleepState.active) { l.textContent = ''; b.classList.remove('on'); return; }
  b.classList.add('on');
  const draw = () => {
    if (sleepState.mode === 'episode') { l.textContent = ' после серии'; return; }
    const s = Math.max(0, Math.round((sleepState.until - Date.now()) / 1000));
    l.textContent = ' ' + (s >= 60 ? Math.ceil(s / 60) + ' мин' : s + ' с');
  };
  draw(); sleepTick = setInterval(draw, 1000);
}
function openSleepMenu(ev) {
  if (ev) ev.stopPropagation();
  let m = document.getElementById('sleepMenu');
  if (m) { m.remove(); return; }
  m = document.createElement('div'); m.id = 'sleepMenu'; m.className = 'sleep-menu';
  const act = localStorage.getItem('tc_sleep_act') || 'stop';
  const on = sleepState.active;
  m.innerHTML = html`<div class="sm-title">Таймер сна</div>
    ${raw(on ? html`<div class="page-sub">Сработает ${sleepState.mode === 'episode' ? 'после текущей серии' : 'через ' + Math.ceil(Math.max(0, sleepState.until - Date.now()) / 60000) + ' мин'}: ${SLEEP_ACTIONS[sleepState.action] || ''}</div>
      <div class="row wrap"><button data-ext="15">+15 мин</button><button data-cancel class="danger">Отменить</button></div><div class="divider"></div>` : '')}
    <label class="page-sub">Что сделать</label>
    <select id="sleepAct">${raw(Object.keys(SLEEP_ACTIONS).map(k => html`<option value="${k}"${k === act ? ' selected' : ''}>${SLEEP_ACTIONS[k][0].toUpperCase() + SLEEP_ACTIONS[k].slice(1)}</option>`).join(''))}</select>
    <div class="sm-grid">${raw([15, 30, 45, 60, 90, 120].map(n => html`<button data-min="${n}">${n} мин</button>`).join(''))}</div>
    <button data-ep class="primary" style="width:100%">После этой серии</button>
    <div class="page-sub" style="margin-top:6px">Перед выключением компьютера приложение предупредит за минуту — можно будет отложить.</div>`;
  document.body.appendChild(m);
  const sel = m.querySelector('#sleepAct');
  sel.addEventListener('change', () => localStorage.setItem('tc_sleep_act', sel.value));
  const go = body => sleepApi(body).then(j => {
    m.remove();
    if (body.cancel) toast('Таймер сна отменён');
    else if (j.active) toast('Таймер сна: ' + (j.mode === 'episode' ? 'после текущей серии' : 'через ' + Math.ceil(j.left / 60) + ' мин') + ' — ' + SLEEP_ACTIONS[j.action]);
  }).catch(e => toast('Таймер не завёлся: ' + e.message, true));
  m.querySelectorAll('[data-min]').forEach(b => b.onclick = () => go({ minutes: +b.dataset.min, action: sel.value }));
  m.querySelector('[data-ep]').onclick = () => go({ mode: 'episode', action: sel.value });
  const c = m.querySelector('[data-cancel]'); if (c) c.onclick = () => go({ cancel: true });
  const x = m.querySelector('[data-ext]'); if (x) x.onclick = () => go({ extend: 15 });
  setTimeout(() => document.addEventListener('click', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', off); } }), 0);
}
function sleepEvent(d) {
  if (d.warn) {
    sleepState.until = Date.now() + (d.left || 60) * 1000;
    let w = document.getElementById('sleepWarn'); if (w) w.remove();
    w = document.createElement('div'); w.id = 'sleepWarn'; w.className = 'sleep-warn';
    w.innerHTML = html`<b>Таймер сна:</b> через минуту — ${SLEEP_ACTIONS[d.action] || 'остановка'}.
      <button data-ext class="primary">Отложить на 15 мин</button><button data-cancel>Отменить</button>`;
    document.body.appendChild(w);
    w.querySelector('[data-ext]').onclick = () => { sleepApi({ extend: 15 }).catch(() => {}); w.remove(); };
    w.querySelector('[data-cancel]').onclick = () => { sleepApi({ cancel: true }).catch(() => {}); w.remove(); };
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('TorrClient', { body: 'Таймер сна: через минуту — ' + (SLEEP_ACTIONS[d.action] || '') }); } catch (_) { /* нет уведомлений */ }
    return;
  }
  const w = document.getElementById('sleepWarn'); if (w) w.remove();
  if (d.fired) {
    // Видео, открытое в окне программы, тоже останавливается.
    document.querySelectorAll('video').forEach(v => { try { v.pause(); } catch (_) { /* уже закрыто */ } });
    toast('Таймер сна сработал: ' + (SLEEP_ACTIONS[d.action] || ''));
  }
  sleepState = { active: false }; paintSleep();
}
