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
  view: 'home', hello: null, profiles: [], active: null, players: [],
  lib: [], viewed: [], dlJobs: [], settings: null, watch: { folder: '', log: [] }, folders: null,
  query: '', category: 'all', searchState: { loading: false, results: [], provider: savedPref('tc_prov', ['rutor', 'torznab', 'kinozal', 'both'], 'both'), cat: savedPref('tc_cat', null, ''), q: '' },
  // seen — фильтр по состоянию просмотра, coll — выбранная подборка. Пустая
  // подборка означает «вся библиотека», 'fav' — избранное. Отдельно от query и
  // category: те фильтруют и поиск, а эти два — только библиотеку.
  seen: 'all', coll: '',
  // subs — подписки на сериалы. Ведёт их демон: он спрашивает трекер по
  // расписанию сам и присылает событие, поэтому список нужен только для показа.
  subs: [],
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
/* toastUndo — уведомление с кнопкой «Вернуть» вместо окна подтверждения.
   Действие уже выполнено (или отложено): пока уведомление на экране, его можно
   отменить. По истечении времени вызывается onExpire — там можно довести дело до
   конца (например, действительно удалить с сервера). */
function toastUndo(msg, onUndo, onExpire, ms) {
  const el = document.createElement('div');
  el.className = 'undo';
  const span = document.createElement('span'); span.textContent = msg;
  const b = document.createElement('button'); b.textContent = 'Вернуть'; b.className = 'undo-btn';
  el.append(span, b);
  $('#toast').appendChild(el);
  let done = false;
  const flush = () => finish(false);
  const finish = undo => {
    if (done) return; done = true; clearTimeout(timer); el.remove(); pendingUndo.delete(flush);
    if (undo) { try { onUndo && onUndo(); } catch (e) { toast('Не удалось вернуть: ' + e.message, true); } }
    else if (onExpire) { try { onExpire(); } catch {} }
  };
  const timer = setTimeout(() => finish(false), ms || 7000);
  b.addEventListener('click', () => finish(true));
  pendingUndo.add(flush);
  return el;
}
/* Окно закрывают — отложенное доводится до конца, а не теряется. */
const pendingUndo = new Set();
window.addEventListener('pagehide', () => { pendingUndo.forEach(f => f()); });
// ── Этап 6: тема, горячие клавиши, скелетоны ──
// Темы — только наборы цветов (переменные CSS), переключение мгновенное.
// sw — образец для выбора в настройках: фон, панель, акцент, второй акцент.
const THEME_LIST = [
  { id: 'dark', name: 'Графит', tone: 'dark', sw: ['#0f1012', '#1f2024', '#7cb0ff', '#5fcf8c'] },
  { id: 'light', name: 'Светлая', tone: 'light', sw: ['#f7f7f5', '#ffffff', '#1f6fd1', '#2f8f5c'] },
  { id: 'system', name: 'Как в системе', tone: 'auto', sw: ['#0f1012', '#f7f7f5', '#7cb0ff', '#1f6fd1'] },
  { id: 'oled', name: 'Чёрная (OLED)', tone: 'dark', sw: ['#000000', '#151517', '#7cb0ff', '#5fcf8c'] },
  { id: 'nord', name: 'Северная', tone: 'dark', sw: ['#2e3440', '#3b4252', '#88c0d0', '#a3be8c'] },
  { id: 'dracula', name: 'Дракула', tone: 'dark', sw: ['#1e1f29', '#2e303f', '#bd93f9', '#50fa7b'] },
  { id: 'forest', name: 'Лес', tone: 'dark', sw: ['#0f1512', '#1c2620', '#6fcf98', '#b5e06a'] },
  { id: 'sepia', name: 'Сепия', tone: 'light', sw: ['#f4ecdc', '#efe5d0', '#9a5a22', '#527a30'] },
  // Глобальная тема: не только цвета, но и шрифт, пиксельные рамки, ЭЛТ-развёртка
  // и свои анимации (95-retro.css, 78-fx.js).
  { id: 'retro', name: 'Денди 90-х', tone: 'dark', sw: ['#000000', '#1c1c3a', '#f83800', '#f8b800'] },
  { id: 'matrix', name: 'Матрица', tone: 'dark', sw: ['#000000', '#062014', '#39ff7a', '#a6ff3c'] },
  { id: 'neon', name: 'Кибер-неон', tone: 'dark', sw: ['#0d0221', '#22094a', '#ff2bd6', '#00f0ff'] },
  { id: 'sakura', name: 'Японский сад', tone: 'light', sw: ['#f6f0e4', '#fbf7ef', '#c2456e', '#5d8a4a'] },
  { id: 'sea', name: 'Девятый вал', tone: 'dark', sw: ['#06131f', '#122b40', '#f2c14e', '#5fc9b5'] },
];
const THEMES = THEME_LIST.map(t => t.id);
const THEME_NAMES = Object.fromEntries(THEME_LIST.map(t => [t.id, t.name.toLowerCase()]));
function themeMode() { const t = localStorage.getItem('tc_theme'); return THEMES.includes(t) ? t : 'dark'; }
function applyTheme() {
  const m = themeMode();
  let id = m;
  if (m === 'system') id = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const t = THEME_LIST.find(x => x.id === id) || THEME_LIST[0];
  document.documentElement.dataset.theme = t.id;
  document.documentElement.dataset.tone = t.tone;
  const b = document.getElementById('themeBtn');
  if (b) b.title = 'Тема: ' + THEME_NAMES[m] + ' — нажмите, чтобы сменить (клавиша T). Все темы — в Настройках';
  $$('.theme-sw').forEach(x => x.classList.toggle('on', x.dataset.theme === m));
}
function setTheme(id) {
  try { localStorage.setItem('tc_theme', id); } catch {}
  applyTheme(); toast('Тема: ' + THEME_NAMES[id]);
  if (id === 'retro' && typeof fxCrtOn === 'function') fxCrtOn();
}
function cycleTheme() { setTheme(THEMES[(THEMES.indexOf(themeMode()) + 1) % THEMES.length]); }
function themePickerHtml() {
  const m = themeMode();
  return `<div class="theme-grid">${THEME_LIST.map(t => `<button class="theme-sw${t.id === m ? ' on' : ''}" data-theme="${t.id}"><span class="sw">${t.sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>${t.name}</button>`).join('')}</div>`;
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('.theme-sw'); if (b) setTheme(b.dataset.theme); });
applyTheme();
if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

// Скелетон вместо текста «Загрузка…»: видно форму будущей выдачи.
function skeleton(label, n = 6, grid = false) {
  const rows = '<div class="skel-row"></div>'.repeat(n);
  return `<div class="skel-label">${label}</div><div class="skel${grid ? ' skel-grid' : ''}">${rows}</div>`;
}

// Разделы и их порядок задаёт NAV_GROUPS (05-ui.js); Alt+цифра — первые десять.
const navKeys = () => NAV_ITEMS.map(x => x[0]).slice(0, 10);
function showKeys() {
  const rows = [['Ctrl+K', 'палитра: разделы, команды, раздачи, поиск'], ['/', 'перейти к поиску'], ['T', 'сменить тему'], ['R', 'обновить раздел'], ['[', 'свернуть / развернуть панель'], ['Esc в поле', 'очистить поле'], ['Alt+1 … Alt+0', 'разделы по порядку'], ['Esc', 'закрыть окно'], ['?', 'этот список']];
  const nav = navKeys().map((k, i) => `Alt+${(i + 1) % 10} — ${NAV_ITEMS[i][1]}`).join(' · ');
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="modal" style="max-width:560px"><h3>Горячие клавиши</h3><table class="keys-table">${rows.map(([k, d]) => `<tr><td><span class="kbd">${k}</span></td><td>${d}</td></tr>`).join('')}</table><p class="page-sub">${nav}</p><div class="row"><button class="primary" id="keysOk">Понятно</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#keysOk').addEventListener('click', close);
}
function focusSearch() {
  if (state.view !== 'search') setView('search');
  setTimeout(() => { const i = document.getElementById('searchInput'); if (i) { i.focus(); i.select(); } }, 30);
}
document.addEventListener('keydown', e => {
  const t = e.target; const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'л')) { e.preventDefault(); openPalette(); return; }
  if (e.altKey && !e.ctrlKey && /^[0-9]$/.test(e.key)) {
    const k = navKeys()[(+e.key + 9) % 10]; if (k) { e.preventDefault(); setView(k); } return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('body > .overlay')) return;
  if (e.key === '/') { e.preventDefault(); focusSearch(); }
  else if (e.key === '?') { e.preventDefault(); showKeys(); }
  else if (e.key === 't' || e.key === 'T' || e.key === 'е' || e.key === 'Е') cycleTheme();
  else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') refreshView();
  else if (e.key === '[' || e.key === 'х' || e.key === 'Х') toggleSide();
});

// addClear — крестик «×» в поле ввода: одним щелчком (или Esc) очищает поле и
// возвращает в него курсор. Слушатели поля узнают об очистке событием input —
// фильтры перерисовываются сами, как при ручном стирании.
function addClear(input) {
  if (!input || input.dataset.clear) return;
  input.dataset.clear = '1';
  const w = document.createElement('span'); w.className = 'clear-wrap';
  input.before(w); w.appendChild(input);
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'clear-x'; b.textContent = '×';
  b.title = 'Очистить (Esc)'; b.setAttribute('aria-label', 'Очистить');
  w.appendChild(b);
  const sync = () => w.classList.toggle('has', !!input.value);
  const clear = () => {
    input.value = ''; sync(); input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); clear(); } });
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', clear);
  sync();
}
function addClears(root) { (root || document).querySelectorAll('input.search-input, input[type=search]').forEach(addClear); }

// refreshView — кнопка ⟳ и клавиша R: перечитать текущий раздел. Поиск
// повторяется с тем же запросом, библиотека запрашивается у сервера заново.
async function refreshView() {
  const b = document.getElementById('refreshBtn');
  if (b) { if (b.classList.contains('spin')) return; b.classList.add('spin'); }
  try {
    if (state.view === 'search' && state.searchState.q) await doSearch();
    else if (state.view === 'library' || !state.view) await refreshLibrary();
    else route();
  } catch (e) { toast(e.message, true); }
  finally { if (b) setTimeout(() => b.classList.remove('spin'), 400); }
}

// Настройки зеркал Кинозала: свой список, запрет неофициальных, проверка всех
// зеркал параллельно — видно, какое сейчас отдаёт выдачу.
async function initKinozalMirrors() {
  const box = $('#kzHosts'); if (!box) return;
  const show = j => {
    box.value = (j.hosts || []).join('\n');
    $('#kzOfficial').checked = !!j.official_only;
    $('#kzLast').textContent = j.last_good ? 'Последнее рабочее: ' + j.last_good.replace('https://', '') : '';
    if ($('#kzUser')) { $('#kzUser').value = j.user || ''; $('#kzPass').value = ''; $('#kzPass').placeholder = j.pass_set ? 'Пароль сохранён' : 'Пароль'; }
  };
  try { show(await apiGetJSON('/api/kinozal/mirrors')); } catch (e) { $('#kzLast').textContent = 'Не загружено: ' + e.message; }
  const post = body => fetch('/api/kinozal/mirrors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status); return j; });
  const save = async () => {
    try {
      show(await post({ hosts: box.value.split(/[\s,;]+/).filter(Boolean), official_only: $('#kzOfficial').checked, user: $('#kzUser') ? $('#kzUser').value : undefined, pass: $('#kzPass') ? $('#kzPass').value : undefined }));
      toast('Зеркала Кинозала сохранены');
    } catch (e) { toast('Не сохранено: ' + e.message, true); }
  };
  $('#kzSave').addEventListener('click', save);
  $('#kzOfficial').addEventListener('change', save);
  $('#kzProbe').addEventListener('click', async () => {
    const btn = $('#kzProbe'), out = $('#kzProbeOut');
    btn.disabled = true; btn.textContent = 'Проверяю…'; out.innerHTML = skeleton('Опрашиваю зеркала параллельно…', 3);
    try {
      const j = await post({ probe: true });
      const rows = (j.results || []).sort((a, b) => (b.ok - a.ok) || (b.official - a.official) || (a.ms - b.ms));
      out.innerHTML = html`<table style="width:100%;margin-top:8px"><tr><th align="left">Зеркало</th><th align="left">Статус</th><th align="right">мс</th></tr>${raw(rows.map(r => html`<tr><td>${r.host}${raw(r.official ? ' <span class="chip q1080">официальное</span>' : '')}</td><td style="color:${r.ok ? 'var(--acc2)' : 'var(--red)'}">${r.ok ? 'отдаёт выдачу' : (r.reason || 'нет ответа')}</td><td align="right">${r.ms}</td></tr>`).join(''))}</table>`;
      if (!rows.some(r => r.ok)) out.insertAdjacentHTML('beforeend', '<div class="hint">Ни одно зеркало не отдало выдачу. Если сайт открывается у вас в браузере, добавьте рабочий адрес в «Свои зеркала».</div>');
    } catch (e) { out.innerHTML = html`<div class="hint">Проверка не удалась: ${e.message}</div>`; }
    btn.disabled = false; btn.textContent = 'Проверить зеркала';
  });
}

// rutor можно выключить в настройках: тогда поиск, ТОП, «Популярное» и подписки
// живут на индексаторах и Кинозале. Флаг читается с сервера и лежит в state.
async function loadRutorFlag() {
  try {
    const j = await apiGetJSON('/api/rutor/settings');
    state.rutorOff = !!j && j.enabled === false;
  } catch {}
  const prov = $('#searchProv');
  if (prov) {
    const o = [...prov.options].find(x => x.value === 'rutor');
    if (o) o.textContent = state.rutorOff ? 'rutor (выключен)' : 'rutor';
    if (state.rutorOff && prov.value === 'rutor') { prov.value = 'both'; state.searchState.provider = 'both'; savePref('tc_prov', 'both'); }
  }
  return !state.rutorOff;
}
async function initRutorToggle() {
  const box = $('#rutorOn'); if (!box) return;
  box.checked = await loadRutorFlag();
  box.addEventListener('change', async () => {
    try {
      const r = await fetch('/api/rutor/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: box.checked }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
      state.rutorOff = j.enabled === false;
      toast(state.rutorOff ? 'rutor выключен: поиск идёт через индексаторы и Кинозал' : 'rutor включён');
    } catch (e) { box.checked = !box.checked; toast('Не сохранено: ' + e.message, true); }
  });
}

// Что нового — по версиям, новые сверху. Номер берётся из файла VERSION
// (ответ /api/hello → app_version); при каждом этапе он повышается.
/* savedPref — выбор, запомненный в браузере: источник поиска, категория,
   раздел подборки. ok — допустимые значения (null — любое непустое). */
function savedPref(key, ok, def) {
  let v = null;
  try { v = localStorage.getItem(key); } catch {}
  if (v == null) return def;
  return !ok || ok.includes(v) ? v : def;
}
function savePref(key, v) { try { localStorage.setItem(key, String(v == null ? '' : v)); } catch {} }

const WHATSNEW = [
  ['2.2.0', ['Поиск сразу открывает карточку фильма, если название нашлось в TMDB (галочка «сразу карточка»); над раздачами — карточка названия', 'Крестик и Esc в поле поиска очищают запрос', 'В карточке фильма у каждой раздачи «♥» — именно эта раздача уходит в избранное', 'Исправлен размер раздач Кинозала: «37.85 ГБ» показывалось как 38 байт', '«Продолжить просмотр» — от последнего открытого и не больше 6 карточек', 'Оценка качества у аниме и мультсериалов в Библиотеке — по именам файлов', 'Новое «Сейчас играет» в шапке: что открыто в плеере или какой трек звучит', 'Колокольчик уведомлений: новые серии больше не теряются', 'Сериалы из Библиотеки отслеживаются сами — о новых сериях приходит уведомление', 'Раздел «Музыка»: только аудиораздачи и плеер прямо в окне; музыка не попадает в Библиотеку', 'Новая тема «Денди 90-х», звёздное небо у «Графита» и варп-прыжок при запуске просмотра (выключается в Настройках → Оформление)']],
  ['2.1.0', ['Карточка фильма: постер, описание, сезоны и серии с отметками просмотра, все раздачи с оценкой качества и числом раздающих, «Смотреть» и «Следить». Открывается с любой карточки названия и с раздач поиска, кроме ТОПа за 24 часа', 'Лучшая раздача считается по качеству, русской дорожке, раздающим и размеру; для сериала выберите сезон — лишние раздачи уйдут', 'Поиск показывает раздачи по мере ответа каждого источника, а зависший отрезается через 12 секунд', 'Главная настраивается: включить, выключить и переставить ряды, свои ряды (подборка TMDB, ТОП раздела, поиск — например «Новинки аниме»), ряд «Детское»; приветствие убрано', 'Любой раздел можно сделать стартовым: правый клик по нему в панели или «Настроить» на Главной', 'Кнопки мыши «назад» и «вперёд» ходят по разделам и карточкам', 'Удаление без окна подтверждения: «Удалено · Вернуть»', 'В библиотеке у раздач — оценка качества и источник/кодек/звук', 'Исправлена кнопка «Смотреть» на постере (вместо значка был синий круг); сердечки — по центру сверху']],
  ['2.0.0', ['Новый облик: спокойная графитовая тема по умолчанию, крупные постеры, единые карточки, кнопки и окна во всех разделах; все восемь тем перерисованы', 'Разделы теперь в боковой панели тремя группами — основное, «Моё» и «Система»; панель сворачивается до значков (клавиша [ ). На телефоне — полоса вкладок внизу и лист «Ещё»', '«Главная» — новый стартовый раздел: продолжить просмотр крупными карточками, новые серии по подпискам, избранное, «Сейчас смотрят» и недавно добавленное — всё на одном экране', 'Палитра команд Ctrl+K: любой раздел, действие, тема, раздача из библиотеки или избранного — по нескольким буквам; Enter ищет набранное на трекерах, вторая строка — лучшая раздача', 'Поиск: большое поле, фильтры одной строкой, подборки (ТОП-24, Популярное, Для вас, Сейчас смотрят) отдельными кнопками', 'Кнопка «Добавить» всегда в шапке, а не только в Библиотеке и Поиске']],
  ['1.20.0', ['♥ «Сейчас смотрят» и «Для вас»: сердечко на карточке добавляет название в избранное — оттуда одним нажатием подбирается лучшая раздача', 'Больше нет привязки к одному источнику: ТОП за 24 часа собирается из rutor и индексаторов (JacRed, Jackett, Prowlarr) разом, а без ключа TMDB — из ленты свежих раздач индексатора', '«Популярное» при недоступном rutor строится через индексаторы', 'Настройки → «Источники поиска»: rutor можно выключить совсем; по умолчанию поиск идёт по всем источникам', 'Удаление из «Избранного» снова работает']],
  ['1.19.0', ['📲 Отправить на устройство: продолжить просмотр с того же места на телефоне, планшете, другом компьютере с открытым TorrClient или на телевизоре с DLNA в той же сети (меню плитки и кнопка в панели показа)', '⏾ Таймер сна в шапке: через 15–120 минут или после текущей серии — остановить плеер, усыпить или выключить компьютер; предупреждение за минуту с «Отложить»', 'Поиск по настройкам: несколько слов в любом порядке, синонимы, подсветка найденного, Enter — к первому, Ctrl+F или «/»', 'ТОП за 24 часа без ограничения в 24 раздачи: свежие раздачи всех категорий rutor; если rutor не отвечает — ТОП собирается через индексаторы по трендам TMDB', 'Учёт просмотра при плейлисте VLC: серия определяется по текущему элементу плейлиста, позиции следующих серий больше не пишутся на первую', '«Сейчас смотрят»: в жанрах появились Аниме, Мультфильмы и Аниме-фильмы', 'Кинозал: вход по логину и паролю в настройках, проверка файла, а если .torrent не скачивается — та же раздача ищется на rutor и в индексаторах', 'Подписки на сериалы: поиск по rutor и индексаторам, понятная запись аниме и мультиков («[1-12 из 24]», «TV-2», «эпизоды»), чистый запрос вместо названия раздачи со скобками, проверка сразу после подписки, дата следующей серии по TMDB, системные уведомления', 'Обновление TorrServer MatriX в разделе «Сервер»: версия, скачивание с GitHub и перезапуск одной кнопкой', 'Библиотека после запуска больше не остаётся пустой: пока TorrServer поднимается, список запрашивается повторно сам']],
  ['1.18.3', ['«Продолжить просмотр» показывает и то, что запускали в плеере без отчёта о позиции или с телефона: по списку просмотренного TorrServer']],
  ['1.18.2', ['Постер сериала в библиотеке: из ответов TMDB выбирается совпадающее название с обложкой, а не первый попавшийся фильм (так было с «Rick and Morty»); старые ответы без постера перепроверяются', 'Кнопка «Следующая серия» видна сразу после запуска серии и не пропадает вместе с панелью']],
  ['1.18.1', ['Постеры в библиотеке: их стирала статистика TorrServer через секунду после показа — больше не стирает', 'Постеры находятся и для раздач с именем файла или папки («Курьер.2026.MVO.WEB-DLRip…», «Игра.престолов.S01…») и для русских названий латиницей («Trudno.byt.bogom»)', '«Продолжить просмотр» показывает и начатое, у которого плеер не сообщил позицию, и раздачи, чей список файлов ещё не загружен', 'Понятное сообщение, если постер не нашёлся: с каким названием искали и что сделать']],
  ['1.18.0', ['Обложки идут через TorrClient: если image.tmdb.org у провайдера не открывается, берутся с зеркала и сохраняются на диске — библиотека открывается сразу и с постерами', '«Продолжить просмотр» больше не пропадает после обновления списка', 'Запуск фильма на компьютере с телефона или планшета снова работает', 'Значок в трее: появляется надёжнее (и после перезапуска Проводника), с иконкой программы; автозапуск открывает окно свёрнутым в трей, повторный запуск показывает уже открытое окно', 'Подробная статистика предзагрузки: буфер в процентах, сколько осталось ждать, пиры, отдача, всего скачано — панель не исчезает, пока буфер не набран', '«Сейчас смотрят»: за неделю или за сегодня, по 60 карточек за раз, по умолчанию и русское', 'Поиск запоминает источник, категорию и выбор в панели подборок']],
  ['1.17.1', ['Доступ с телефона: кнопка «Разрешить в брандмауэре» (Windows) — снимает запрет, который Windows ставит после «Отмены», и открывает порт для всех сетей', 'QR строится по адресу Wi-Fi/Ethernet, а не виртуального адаптера (WSL, VirtualBox, VPN); адрес можно выбрать', 'Подсказки «Не открывается на телефоне или планшете?»']],
  ['1.17.0', ['Онлайн-JacRed без установки Jackett: Настройки → Torznab → «＋ JacRed» — rutor, Кинозал, NNM-Club, RuTracker и др. одним источником', 'Поддержка JSON-ручки Jackett: источники без Torznab (jac-red.ru) тоже ищут']],
  ['1.16.0', ['С телефона «Смотреть» теперь спрашивает, где играть: в плеере телефона (VLC, MX Player), в браузере телефона или на компьютере — раньше плеер молча открывался на компьютере', '«🔥 Сейчас смотрят» — тренды TMDB за неделю (Поиск → панель топа)', '«Продолжить просмотр»: по карточке на сериал, после досмотренной серии сразу предлагается следующая, с постером', 'Рекомендации учитывают всю библиотеку и Избранное; досмотренное и Избранное весят больше']],
  ['1.15.0', ['«Топ за всё время»: разделы Аниме, Мультфильмы и Документальное — фильмы или сериалы', 'В Мультфильмах нет аниме, в Аниме — только японская анимация']],
  ['1.14.0', ['Исправлено: следующая серия в плейлисте начиналась с позиции прошлой — теперь каждая продолжается со своего места (mpv, VLC)', 'Отметки просмотра записываются той серии, что играет сейчас, а не первой', 'Сериалы с многими сезонами: вкладки сезонов с прогрессом, открывается сезон следующей серии, «Отметить сезон» одним нажатием', 'Во время просмотра не показываются неверные цифры подгрузки, а сервер опрашивается реже', 'Кнопка «Следующая серия» на панели показа снова появляется']],
  ['1.13.0', ['Рекомендации по библиотеке: «✨ Рекомендации» в Библиотеке и «✨ Для вас» в Поиске (нужен ключ TMDB)', 'Что советуют сразу к нескольким вашим фильмам — выше; видно, на что похоже; лишнее прячется ✕', 'Щелчок по рекомендации сразу ищет лучшую раздачу']],
  ['1.12.0', ['Крестик «×» в полях поиска и фильтра (или Esc) — очистить одним щелчком', 'Кнопка ⟳ в шапке (клавиша R) — обновить раздел или повторить поиск', 'Лоток: «Выход» в меню теперь действительно закрывает программу; щелчок по иконке открывает окно (меню раньше не работало)']],
  ['1.11.1', ['Окно в релизе называется TorrClientDesktop.exe: на Windows TorrClient.exe затирал демон torrclient.exe при распаковке', 'Автообновление без окна: программа перезапускается сама уже новой версией (раньше просто закрывалась)', 'Доступ с телефона сохраняется после перезапуска при обновлении']],
  ['1.11.0', ['Автообновление: кнопка ⬆ рядом с версией, установка в один клик (архив сверяется с SHA256)', 'В релизе есть окно программы (Wails)', 'Настройки → О программе: «Проверить обновления» и автопроверка']],
  ['1.10.0', ['Доступ с телефона: QR-код и PIN в Настройках', '★ Лучшая раздача: rutor, Кинозал и Torznab разом, одна кнопка «Смотреть» (и по клику на постер)', 'Автонастройка буфера по скорости канала (Сервер → Настройки)', 'Установка и запуск Jackett/Prowlarr из Настроек (Windows, winget)', 'Метка «Сериал» с сезоном и числом серий', 'Исправлено «Популярное» (rutor отдавал пустую страницу)', 'Исправлено: индексаторы Torznab и зеркала Кинозала пропадали после перезапуска', 'MPC-HC тоже продолжает с места остановки']],
  ['1.9.0', ['Интерфейс разбит на части (web/src), app.js собирается из них', 'Проверено: сортировка rutor по сидам (код 2) и формат Prowlarr — по его исходникам', 'Тесты реестра Windows (своя ветка, ассоциации не трогаются); ошибки регистрации magnet больше не теряются', 'Окно «Что нового» один раз после обновления', 'Поиск по настройкам']],
  ['1.8.0', ['Кинозал: сначала официальные зеркала (kinozal.tv, .me, .guru), поддельные убраны', 'Кинозал: следующий поиск начинается с зеркала, ответившего последним', 'Настройки → Кинозал: свои зеркала, «только официальные», проверка всех зеркал', 'Автопроверка сборки и тестов на GitHub, готовый архив для Windows в релизах']],
  ['1.7.0', ['5 новых тем: Чёрная (OLED), Северная, Дракула, Лес, Сепия — выбор в Настройках → Оформление', 'Кнопки «Быстро» больше не повторяются', 'Метки качества и рейтинга читаются в светлых темах', 'Список «Что нового» в «О программе» показывался с HTML-тегами', 'В «О программе» видна настоящая система (была всегда windows)']],
  ['1.6.0', ['Светлая тема и «как в системе» (кнопка 🌓 или T)', 'Горячие клавиши: / — поиск, Alt+1…0 — разделы, ? — список', 'Скелетоны вместо «Загрузка…»', 'Автодополнение из истории поиска, удаление записей']],
  ['1.5.0', ['Сборка под Linux и macOS, режим без окна', 'Автозапуск при входе в систему', 'magnet: и .torrent на Linux', 'Поиск плееров без реестра']],
  ['1.4.0', ['Помощник Torznab: поиск Jackett и Prowlarr на компьютере и в сети']],
  ['1.3.0', ['Оценка качества раздачи 0–100 и сортировка «по качеству»', 'Вердикт ffprobe: сыграет ли в окне программы']],
  ['1.2.0', ['Топ за всё время по жанрам (TMDB)', 'Потоковый поиск Torznab, «Популярное», «Показать ещё»']],
];
function paintVersion() {
  const tb = document.getElementById('themeBtn'); if (tb && !tb.onclick) tb.onclick = cycleTheme;
  const rb = document.getElementById('refreshBtn'); if (rb && !rb.onclick) rb.onclick = refreshView;
  const sb = document.getElementById('sleepBtn'); if (sb && !sb.onclick) { sb.onclick = openSleepMenu; sleepRefresh(); }
  const el = document.getElementById('appVer'); if (!el || !state.hello) return;
  const v = state.hello.app_version || '';
  el.textContent = v ? 'v' + v : '';
  el.title = (state.hello.version || '') + ' — нажмите, чтобы увидеть, что нового';
  el.onclick = () => showWhatsNew(v, '');
  const seen = localStorage.getItem('tc_seen_ver');
  if (v && seen !== v) {
    try { localStorage.setItem('tc_seen_ver', v); } catch {}
    // Первый запуск — без окна: «что нового» относительно ничего не нужно.
    if (seen) showWhatsNew(v, seen);
  }
  if (typeof autoCheckUpdate === 'function') autoCheckUpdate();
  if (typeof paintUpdateBadge === 'function') paintUpdateBadge();
}

// cmpVer сравнивает номера вида 1.2.3.
function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
  return 0;
}

// showWhatsNew — окно «Что нового». since — прежняя версия: тогда показываются
// только изменения после неё (один раз после обновления).
function showWhatsNew(cur, since) {
  const list = WHATSNEW.filter(([ver]) => !since || cmpVer(ver, since) > 0);
  if (!list.length) return;
  $$('body > .overlay.whatsnew-ov').forEach(o => o.remove());
  const ov = document.createElement('div'); ov.className = 'overlay whatsnew-ov';
  ov.innerHTML = html`<div class="modal" style="max-width:560px"><h3>${since ? 'Обновлено до ' + cur : 'Что нового'}</h3>
    ${raw(list.map(([ver, items]) => html`<div style="margin:10px 0 4px"><b>${ver}</b>${ver === cur ? ' — установлена' : ''}</div><ul class="whatsnew">${raw(items.map(i => html`<li>${i}</li>`).join(''))}</ul>`).join(''))}
    <div class="row"><button class="primary" id="wnOk">Понятно</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#wnOk').addEventListener('click', close);
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

/* ---------- boot ---------- */
(async function boot() {
  try { state.hello = await api('/api/hello'); }
  catch (e) { toast('Не удалось подключиться к демону: ' + e.message, true); return; }
  await loadUserData();
  state.profiles = state.hello.profiles || [];
  paintVersion();
  state.players = state.hello.players || [];
  state.active = state.hello.active_profile_id;
  // Состояние папок нужно до первой отрисовки: иначе предупреждение о
  // недоступной папке появилось бы только после перехода по вкладкам.
  await refreshFolders();
  renderTopbar();
  hookNav();
  hookGlobal();
  // Первая страница: при перезагрузке — та, что в истории (с параметрами), иначе
  // стартовая, которую выбрал пользователь.
  const hs = history.state;
  if (hs && hs.v) { state.view = hs.v; state.params = hs.p || null; }
  else { state.view = startView(); state.params = null; try { history.replaceState({ v: state.view, p: null }, '', '#/' + state.view); } catch {} }
  markNav();
  $$('#nav [data-view]').forEach(b => b.classList.toggle('is-start', b.dataset.view === (localStorage.getItem(START_KEY) || 'home')));
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
  extrasBoot();
})();

