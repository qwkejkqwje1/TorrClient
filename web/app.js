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
  ['2.4.0', ['👥 «Смотрим вместе»: комната по коду приглашения, плееры mpv/VLC идут в ногу (пауза, перемотка, отсчёт 3-2-1, ожидание отстающего), чат и реакции поверх видео, голос и показ экрана. Связь — WebRTC напрямую, запасной путь — зашифрованный MQTT', '«Музыка» стала «Аудио»: вкладки Музыка, Аудиокниги и Радио; обложки альбомов, рекомендации, перемешивание, скорость и буфер под плеером, сам переключается на другую раздачу, если трек не играет', 'Аудиокниги: полка, продолжение с места, скорость чтения, закладки с подписью, скачать для офлайна', 'Радио: Nightride FM, Radio Paradise, EVE и тысячи станций Radio Browser, название песни и осциллограф', 'Поиск музыки сам выбирает лучшую раздачу по качеству и скорости', 'Вместо голограммы танцуют Резе и Волк — случайный танец на каждый трек (🎲 на сцене закрепляет танцора); оба умеют «ихвильнихт» из мема с волком, у Резе это любимый танец']],
  ['2.3.0', ['В разделе «Музыка» живёт неоновая танцовщица-голограмма: слышит трек, сама находит темп и танцует под него (× убирает её)', 'Новые темы с живым фоном: «Матрица», «Кибер-неон», светлая «Японский сад» с лепестками сакуры и «Девятый вал» в духе Айвазовского и Ван Гога', 'Анимации запуска просмотра: варп, «Матрица», «Киноплёнка» с отсчётом 3-2-1, «Вихрь сакуры», «Неон», «Девятый вал» — по теме, случайная или своя (Настройки → Оформление)', 'Звездопад у «Графита» стал случайным: звёзды падают в разное время и в разных местах']],
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


/* ================= КАРКАС 2.0: значки, разделы, палитра команд =================
   Разделов стало одиннадцать — строкой вкладок они уже не читались. Теперь они
   живут в боковой панели тремя группами (смотреть / моё / система), а на
   телефоне — полосой внизу. Любой раздел, действие, раздача из библиотеки или
   запрос к трекерам доступны с клавиатуры через палитру (Ctrl+K). */

/* ico — значок одной линией (stroke = currentColor), чтобы он брал цвет текста
   и одинаково выглядел во всех темах. Набор свой и маленький: портативная
   сборка не тянет шрифтов значков. */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  heart: '<path d="M19.5 12.6 12 20l-7.5-7.4A4.8 4.8 0 0 1 12 6.3a4.8 4.8 0 0 1 7.5 6.3Z"/>',
  bookmark: '<path d="M6.5 3h11a1 1 0 0 1 1 1v17L12 17l-6.5 4V4a1 1 0 0 1 1-1Z"/>',
  player: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="m10 8.3 4.6 2.7-4.6 2.7Z"/>',
  tv: '<rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="m8 3 4 4 4-4"/>',
  bell: '<path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 3 8 3 8H3s3-1.5 3-8"/><path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0"/>',
  download: '<path d="M12 3.5v11.5"/><path d="m7 10.5 5 5 5-5"/><path d="M5 20.5h14"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  server: '<rect x="3" y="3.5" width="18" height="7" rx="2"/><rect x="3" y="13.5" width="18" height="7" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V9H15"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  collapse: '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8Z"/>',
  sparkles: '<path d="M11 4.5 12.8 9l4.7 1.8-4.7 1.8L11 17.2l-1.8-4.6-4.7-1.8L9.2 9Z"/><path d="M18.5 3v4M16.5 5h4M18 16v3M16.5 17.5h3"/>',
  flame: '<path d="M12 21c3.9 0 7-2.8 7-6.8 0-3.8-2.6-6.3-4.6-8.7-.4 2.3-1.5 3.6-3 4.3.3-2.8-.7-5.4-3-7.3C8.6 6 5 9 5 14.2 5 18.2 8.1 21 12 21Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  play: '<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7Z" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  more: '<circle cx="12" cy="5.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none"/>',
  dots: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 8.5l3 3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1"/><path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6M18.5 14.3a5 5 0 0 1 3 4.7v1"/>',
  music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  prev: '<path d="M6 5v14"/><path d="M19 5.5v13L9 12Z" fill="currentColor"/>',
  next: '<path d="M18 5v14"/><path d="M5 5.5v13L15 12Z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  film: '<rect x="3" y="3.5" width="18" height="17" rx="2"/><path d="M7.5 3.5v17M16.5 3.5v17M3 8.5h4.5M3 15.5h4.5M16.5 8.5H21M16.5 15.5H21"/>',
};
function ico(name, size) {
  const s = size || 18;
  return `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* Разделы по группам. Порядок задаёт и Alt+1…Alt+0 (первые десять). */
const NAV_GROUPS = [
  { label: '', items: [['home', 'Главная', 'home'], ['library', 'Библиотека', 'grid'], ['search', 'Поиск', 'search'], ['music', 'Аудио', 'music'], ['together', 'Вместе', 'users']] },
  { label: 'Моё', items: [['favorites', 'Избранное', 'heart'], ['bookmarks', 'Закладки', 'bookmark'], ['series', 'Сериалы', 'tv'], ['subs', 'Подписки', 'bell']] },
  { label: 'Система', items: [['downloads', 'Загрузки', 'download'], ['players', 'Плееры', 'player'], ['settings', 'Настройки', 'sliders'], ['server', 'Сервер', 'server']] },
];
const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items);
const NAV_ICON = Object.fromEntries(NAV_ITEMS.map(([k, , i]) => [k, i]));
// На телефоне внизу помещаются четыре раздела и «Ещё» — остальные в листе.
const TABBAR_KEYS = ['home', 'library', 'search', 'favorites'];

function navBtnHtml(k, label, icon, n) {
  return `<button data-view="${k}" class="${state.view === k ? 'on' : ''}" title="${label}${n ? ' — Alt+' + (n % 10) : ''}"><span class="nav-ico">${ico(icon, 19)}</span><span class="nav-l">${label}</span><span class="nav-badge hidden"></span></button>`;
}
function renderSidebarNav() {
  let n = 0;
  $('#nav').innerHTML = NAV_GROUPS.map(g => `<div class="nav-group">${g.label ? `<div class="nav-h">${g.label}</div>` : ''}${g.items.map(([k, l, i]) => navBtnHtml(k, l, i, ++n <= 10 ? n : 0)).join('')}</div>`).join('');
  const tb = $('#tabbar');
  if (tb) {
    tb.innerHTML = TABBAR_KEYS.map(k => { const it = NAV_ITEMS.find(x => x[0] === k); return `<button data-view="${k}" class="${state.view === k ? 'on' : ''}">${ico(it[2], 22)}<span>${it[1]}</span><span class="nav-badge hidden"></span></button>`; }).join('')
      + `<button data-more class="${TABBAR_KEYS.includes(state.view) ? '' : 'on'}">${ico('dots', 22)}<span>Ещё</span><span class="nav-badge hidden"></span></button>`;
    tb.querySelector('[data-more]').addEventListener('click', openMoreSheet);
  }
}
/* markNav — подсветка текущего раздела в панели, внизу и в заголовке окна. */
function markNav() {
  $$('[data-view]').forEach(b => { if (b.closest('#nav, #tabbar, .sheet')) b.classList.toggle('on', b.dataset.view === state.view); });
  const more = $('#tabbar [data-more]');
  if (more) more.classList.toggle('on', !TABBAR_KEYS.includes(state.view));
  const it = NAV_ITEMS.find(x => x[0] === state.view);
  document.title = it && state.view !== 'home' ? it[1] + ' — TorrClient' : 'TorrClient';
}
/* setNavBadge — число на разделе (новые серии по подпискам). Ставится на все
   копии кнопки: в панели, в нижней полосе и на «Ещё». */
function setNavBadge(view, n) {
  $$(`#nav [data-view="${view}"] .nav-badge, #tabbar [data-view="${view}"] .nav-badge`).forEach(b => { b.textContent = n > 99 ? '99+' : String(n || ''); b.classList.toggle('hidden', !n); });
  $$(`#nav [data-view="${view}"]`).forEach(b => b.classList.toggle('hasnew', n > 0));
  const more = $('#tabbar [data-more] .nav-badge');
  if (more && !TABBAR_KEYS.includes(view)) { more.textContent = n ? '•' : ''; more.classList.toggle('hidden', !n); }
}

/* Свёрнутая панель: только значки. Выбор помнится. */
function applySideCollapsed() {
  const c = localStorage.getItem('tc_side') === 'mini';
  document.documentElement.classList.toggle('side-mini', c);
  const b = $('#sideCollapse');
  if (b) { b.innerHTML = ico('collapse', 17); b.title = c ? 'Развернуть панель' : 'Свернуть панель'; }
}
function toggleSide() {
  try { localStorage.setItem('tc_side', localStorage.getItem('tc_side') === 'mini' ? 'full' : 'mini'); } catch {}
  applySideCollapsed();
}

/* Лист «Ещё» на телефоне: все разделы плиткой. */
function openMoreSheet() {
  closeSheet();
  const ov = document.createElement('div'); ov.className = 'overlay sheet-ov';
  ov.innerHTML = `<div class="sheet" role="dialog" aria-label="Все разделы"><div class="sheet-grip"></div>${NAV_GROUPS.map(g => `${g.label ? `<div class="nav-h">${g.label}</div>` : ''}<div class="sheet-grid">${g.items.map(([k, l, i]) => `<button data-view="${k}" class="${state.view === k ? 'on' : ''}">${ico(i, 22)}<span>${l}</span></button>`).join('')}</div>`).join('')}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (b) { closeSheet(); setView(b.dataset.view); return; }
    if (e.target === ov) closeSheet();
  });
}
function closeSheet() { $$('body > .sheet-ov').forEach(o => o.remove()); }

/* Иконки в шапке ставятся из кода: разметка index.html остаётся короткой. */
function paintShellIcons() {
  const put = (sel, html) => { const el = $(sel); if (el) el.insertAdjacentHTML('afterbegin', html); };
  const r = $('#refreshBtn'); if (r && !r.firstChild) r.innerHTML = ico('refresh', 18);
  const t = $('#themeBtn'); if (t && !t.firstChild) t.innerHTML = ico('theme', 18);
  const s = $('#sleepBtn .tb-ico'); if (s && !s.firstChild) s.innerHTML = ico('moon', 18);
  const a = $('#addBtn .tb-ico'); if (a && !a.firstChild) a.innerHTML = ico('plus', 17);
  const o = $('#omni .omni-ico'); if (o && !o.firstChild) o.innerHTML = ico('search', 17);
  const u = $('#toTop'); if (u && !u.firstChild) u.innerHTML = ico('up', 20);
  if (/Mac|iPhone|iPad/.test(navigator.platform || '')) { const k = $('#omni .omni-kbd'); if (k) k.textContent = '⌘K'; }
  void put;
}

/* ---------- палитра команд (Ctrl+K) ---------- */
/* Один вход ко всему: разделы, действия, темы, раздачи библиотеки, избранное и
   поиск по трекерам. Совпадение — по всем словам запроса в любом порядке
   (ё = е), выше — то, что начинается с запроса. */
const palNorm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
function palScore(text, words) {
  if (!words.length) return 1;
  const t = palNorm(text);
  let sc = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return 0;
    sc += i === 0 ? 3 : (/[\s\-/(«"]/.test(t[i - 1]) ? 2 : 1);
  }
  return sc;
}
function searchFor(q) {
  q = String(q || '').trim(); if (!q) return;
  state.searchState.q = q;
  state.skipAutoTop = true;
  setView('search');
  const i = $('#searchInput'); if (i) i.value = q;
  if (typeof pushSearchHistory === 'function') pushSearchHistory(q);
  doSearch();
}
function palItems(q) {
  const words = palNorm(q).split(/\s+/).filter(Boolean);
  const out = [];
  const add = (group, label, icon, run, extra) => {
    const sc = palScore(label + ' ' + ((extra && extra.kw) || ''), words);
    if (sc) out.push(Object.assign({ group, label, icon, run, sc }, extra || {}));
  };
  const qq = String(q || '').trim();
  if (qq) {
    out.push({ group: 'Поиск', label: `Искать «${qq}» на трекерах`, icon: 'search', run: () => searchFor(qq), sc: 99, hint: 'Enter' });
    out.push({ group: 'Поиск', label: `Лучшая раздача: «${qq}»`, icon: 'star', run: () => { if (typeof pushSearchHistory === 'function') pushSearchHistory(qq); findBest(qq, 0); }, sc: 98, sub: 'rutor, Кинозал и индексаторы разом — одна кнопка «Смотреть»' });
  }
  NAV_ITEMS.forEach(([k, l, i]) => add('Разделы', l, i, () => setView(k), { kw: 'раздел перейти ' + k }));
  const acts = [
    ['Добавить магнит или .torrent', 'plus', () => openAddModal(), 'добавить торрент магнит файл'],
    ['Обновить раздел', 'refresh', () => refreshView(), 'обновить перезагрузить'],
    ['Рекомендации по библиотеке', 'sparkles', () => showRecommendations(), 'для вас похожее'],
    ['ТОП за 24 часа', 'flame', () => homeGo('top'), 'топ 24 свежие'],
    ['Популярное за всё время', 'film', () => homeGo('pop'), 'популярное сиды'],
    ['Сейчас смотрят (тренды недели)', 'clock', () => homeGo('trend'), 'тренды tmdb'],
    ['Таймер сна', 'moon', () => openSleepMenu(), 'сон выключить усыпить'],
    ['Проверить подписки сейчас', 'bell', () => subsCheck(), 'новые серии проверить'],
    ['Сменить тему', 'theme', () => cycleTheme(), 'тема оформление светлая темная'],
    ['Свернуть или развернуть панель', 'collapse', () => toggleSide(), 'панель боковая'],
    ['Горячие клавиши', 'keyboard', () => showKeys(), 'клавиши справка'],
    ['Что нового', 'info', () => showWhatsNew((state.hello && state.hello.app_version) || '', ''), 'версия изменения'],
  ];
  acts.forEach(([l, i, run, kw]) => add('Действия', l, i, run, { kw }));
  if (words.length) THEME_LIST.forEach(t => add('Темы', 'Тема: ' + t.name, 'theme', () => setTheme(t.id), { kw: 'тема оформление' }));
  if (words.length) {
    const lib = (state.lib || []).map(t => ({ t, sc: palScore(t.title || t.name || '', words) })).filter(x => x.sc).sort((a, b) => b.sc - a.sc).slice(0, 6);
    lib.forEach(({ t, sc }) => out.push({ group: 'Библиотека', label: t.title || t.name || t.hash, icon: 'play', run: () => watchNow(t), sc: sc + 0.5, poster: t.poster }));
    const fav = favList().map(f => ({ f, sc: palScore(f.title || '', words) })).filter(x => x.sc).slice(0, 4);
    fav.forEach(({ f, sc }) => out.push({ group: 'Избранное', label: f.title || 'магнит', icon: 'heart', run: () => (isTitleFav(f) ? openMovie({ title: f.title, year: f.year, kind: f.kind, tmdb: f.tmdb, poster: f.poster }) : playSearchLink(f)), sc, poster: f.poster }));
  }
  const order = ['Поиск', 'Библиотека', 'Избранное', 'Разделы', 'Действия', 'Темы'];
  if (!words.length) return out.filter(x => x.group !== 'Поиск');
  return out.sort((a, b) => (order.indexOf(a.group) - order.indexOf(b.group)) || (b.sc - a.sc));
}
function openPalette(initial) {
  if ($('body > .pal-ov')) { const i = $('.pal-input'); if (i) i.focus(); return; }
  closeSheet();
  const ov = document.createElement('div'); ov.className = 'overlay pal-ov';
  ov.innerHTML = `<div class="pal" role="dialog" aria-label="Палитра команд">
    <div class="pal-head">${ico('search', 18)}<input class="pal-input" placeholder="Раздел, команда, раздача из библиотеки или название для трекеров…" autocomplete="off" spellcheck="false"><span class="kbd">Esc</span></div>
    <div class="pal-list" role="listbox"></div>
    <div class="pal-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> выбрать</span><span><span class="kbd">Enter</span> открыть</span><span><span class="kbd">Esc</span> закрыть</span></div>
  </div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('.pal-input'), list = ov.querySelector('.pal-list');
  let items = [], sel = 0;
  const paint = () => {
    items = palItems(input.value);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let g = '';
    list.innerHTML = items.length ? items.map((it, i) => {
      const head = it.group !== g ? `<div class="pal-g">${esc(g = it.group)}</div>` : '';
      const lead = it.poster ? `<img class="pal-poster" src="${esc(pimg(it.poster))}" alt="" onerror="this.replaceWith(document.createElement('span'))">` : `<span class="pal-ico">${ico(it.icon, 17)}</span>`;
      return head + `<button class="pal-item${i === sel ? ' on' : ''}" data-i="${i}" role="option">${lead}<span class="pal-txt"><span class="pal-l">${esc(it.label)}</span>${it.sub ? `<span class="pal-sub">${esc(it.sub)}</span>` : ''}</span>${it.hint ? `<span class="kbd">${esc(it.hint)}</span>` : ''}</button>`;
    }).join('') : '<div class="pal-empty">Ничего не нашлось</div>';
    const on = list.querySelector('.pal-item.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const close = () => ov.remove();
  const run = i => { const it = items[i]; if (!it) return; close(); try { it.run(); } catch (e) { toast(e.message, true); } };
  input.addEventListener('input', () => { sel = 0; paint(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  list.addEventListener('mousemove', e => { const b = e.target.closest('.pal-item'); if (b && +b.dataset.i !== sel) { sel = +b.dataset.i; $$('.pal-item', list).forEach(x => x.classList.toggle('on', +x.dataset.i === sel)); } });
  list.addEventListener('click', e => { const b = e.target.closest('.pal-item'); if (b) run(+b.dataset.i); });
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  if (initial) input.value = initial;
  paint();
  setTimeout(() => input.focus(), 0);
}

/* pageHead — единая шапка раздела: заголовок, подпись и действия справа. */
function pageHead(title, sub, actions) {
  return html`<div class="page-head"><div class="ph-txt"><h1 class="page-title">${title}</h1>${raw(sub ? html`<div class="page-sub">${sub}</div>` : '')}</div>${raw(actions ? '<div class="ph-act">' + actions + '</div>' : '')}</div>`;
}
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
/* ================= ГЛАВНАЯ =================
   Стартовый экран собирается из рядов, и состав ряда задаёт пользователь:
   включить, выключить, поменять порядок, добавить свой. Встроенные ряды —
   поиск, «Продолжить», новые серии, избранное, «Сейчас смотрят», «Детское»,
   «Недавно добавлено». Свои — подборка TMDB, ТОП раздела трекера или поиск по
   трекерам (например, «новинки аниме» или «мультфильмы Full HD»).
   Пустой ряд места не занимает. */
const homeState = { feeds: {}, trendErr: '' };
const HOME_KEY = 'tc_home';
const HOME_BUILTIN = [
  { id: 'search', title: 'Поиск и подборки', on: true },
  { id: 'cont', title: 'Продолжить просмотр', on: true },
  { id: 'new', title: 'Новые серии по подпискам', on: true },
  { id: 'fav', title: 'Избранное', on: true },
  { id: 'trend', title: 'Сейчас смотрят', on: true },
  { id: 'kids', title: 'Детское', on: true },
  { id: 'recent', title: 'Недавно добавлено', on: true },
];
function homeConfig() {
  let saved = [];
  try { const a = JSON.parse(localStorage.getItem(HOME_KEY) || '[]'); if (Array.isArray(a)) saved = a; } catch {}
  const out = [];
  const seen = new Set();
  for (const x of saved) {
    if (!x || !x.id || seen.has(x.id)) continue;
    const b = HOME_BUILTIN.find(y => y.id === x.id);
    if (b) { out.push({ id: b.id, title: b.title, on: x.on !== false }); seen.add(x.id); }
    else if (x.custom) { out.push(Object.assign({}, x, { on: x.on !== false })); seen.add(x.id); }
  }
  // Встроенный ряд, которого нет в сохранённом, — новый в этой версии: в конец.
  for (const b of HOME_BUILTIN) if (!seen.has(b.id)) out.push(Object.assign({}, b));
  return out;
}
function saveHomeConfig(list) {
  try { localStorage.setItem(HOME_KEY, JSON.stringify(list.map(x => x.custom ? x : { id: x.id, on: x.on !== false }))); } catch {}
}
const railDomId = id => 'rail-' + id;

async function renderHome(root) {
  const cfg = homeConfig();
  const parts = cfg.filter(x => x.on).map(x => x.id === 'search'
    ? html`<section class="home-hero">
      <form class="hh-search" id="homeSearch" autocomplete="off">
        <span class="hh-ico">${raw(ico('search', 20))}</span>
        <input id="homeQ" placeholder="Что посмотрим? Название фильма или сериала" aria-label="Название для поиска">
        <button type="button" id="homeBest" title="Опросить все источники и выбрать лучшую раздачу">${raw(ico('star', 16))}<span>Лучшая</span></button>
        <button type="submit" class="primary">Найти</button>
      </form>
      <div class="hh-chips">
        <button data-home="top">${raw(ico('flame', 16))}ТОП за 24 часа</button>
        <button data-home="pop">${raw(ico('film', 16))}Популярное</button>
        <button data-home="trend">${raw(ico('clock', 16))}Сейчас смотрят</button>
        <button data-home="rec">${raw(ico('sparkles', 16))}Для вас</button>
      </div>
    </section>`
    : html`<section class="rail hidden" id="${railDomId(x.id)}" data-rail="${x.id}"></section>`);
  root.innerHTML = html`<div class="home-bar"><span class="hb-sum" id="homeSum">Собираю, что у вас есть…</span><span class="spacer"></span>
      <button class="ghost" id="homeCfg" title="Включить, выключить и переставить ряды, добавить свои">${raw(ico('sliders', 16))}Настроить</button></div>
    ${raw(parts.join(''))}
    <div id="homeEmpty"></div>`;

  const q = $('#homeQ');
  const hs = $('#homeSearch');
  if (hs) {
    hs.addEventListener('submit', e => { e.preventDefault(); const v = q.value.trim(); if (v) searchFor(v); else q.focus(); });
    $('#homeBest').addEventListener('click', () => { const v = q.value.trim(); if (!v) { q.focus(); toast('Введите название'); return; } pushSearchHistory(v); findBest(v, 0); });
    $$('[data-home]', root).forEach(b => b.addEventListener('click', () => homeGo(b.dataset.home)));
  }
  $('#homeCfg').addEventListener('click', openHomeEditor);
  if (!root._homeBound) { root._homeBound = true; root.addEventListener('click', e => { if (state.view === 'home') onHomeClick(e); }); bindRailScroll(root); }

  paintHome();
  const jobs = [];
  if (!(state.lib || []).length) jobs.push(loadLibrary(false).then(() => applyStoredMeta()).catch(() => {}));
  else jobs.push(loadPositions().catch(() => {}));
  jobs.push(loadSubs().catch(() => {}));
  await Promise.all(jobs);
  if (state.view !== 'home') return;
  paintHome();
  loadHomeFeeds();
}

/* homeGo — подборки из шапки Главной открываются в Поиске, как и прежде. */
function homeGo(what) {
  if (what === 'rec') { showRecommendations(); return; }
  state.skipAutoTop = true;
  setView('search');
  if (what === 'top') onTopClick();
  else if (what === 'pop') fetchPopular();
  else if (what === 'trend') { const k = $('#dKind'); if (k) { k.value = 'trending'; fillDiscGenres(); } fetchDiscover(true); }
}

function paintHome() {
  if (state.view !== 'home') return;
  const cfg = homeConfig().filter(x => x.on);
  const on = id => cfg.some(x => x.id === id);
  const cont = continueItems();
  const newSubs = (state.subs || []).filter(s => Number(s.new_count) > 0);
  const favs = favList().slice().reverse();
  const recent = (state.lib || []).slice().sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)).slice(0, 14);
  const sum = [];
  const n = (state.lib || []).length;
  sum.push(n ? n + ' ' + plural(n, 'раздача', 'раздачи', 'раздач') + ' в библиотеке' : 'Библиотека пока пуста');
  if (cont.length) sum.push(cont.length + ' — продолжить');
  const nn = subsNewTotal();
  if (nn) sum.push(nn + ' ' + plural(nn, 'новая серия', 'новые серии', 'новых серий'));
  const s = $('#homeSum'); if (s) s.textContent = state.libError && !n ? 'TorrServer ещё не ответил — библиотека появится, как только он поднимется' : sum.join(' · ');

  if (on('cont')) paintRail(railDomId('cont'), 'Продолжить просмотр', Math.min(cont.length, CONT_MAX), cont.slice(0, CONT_MAX).map(contBig).join(''), 'library', 'Библиотека', 'cw');
  if (on('new')) paintRail(railDomId('new'), 'Новые серии по подпискам', newSubs.length, newSubs.map(newSubCard).join(''), 'subs', 'Все подписки', 'ns');
  if (on('fav')) paintRail(railDomId('fav'), 'Избранное', favs.length, favs.slice(0, 18).map((f, i) => favMini(f, favs.length - 1 - i)).join(''), 'favorites', 'Всё избранное', 'pc');
  if (on('recent')) paintRail(railDomId('recent'), 'Недавно добавлено', recent.length, recent.map(recentMini).join(''), 'library', 'Вся библиотека', 'pc');
  cfg.forEach(x => { if (x.id === 'trend' || x.id === 'kids' || x.custom) paintFeed(x); });

  const empty = $('#homeEmpty');
  if (empty) {
    const nothing = !n && !favs.length && !cont.length;
    empty.innerHTML = !cfg.length ? html`<div class="home-empty"><div class="he-art">${raw(ico('sliders', 34))}</div><h2>Все ряды выключены</h2>
      <p>Включите нужные в настройке Главной.</p><div class="row" style="justify-content:center"><button class="primary" data-home-cfg>Настроить</button></div></div>`
      : nothing && on('search') ? html`<div class="home-empty">
      <div class="he-art">${raw(ico('film', 34))}</div>
      <h2>С чего начать</h2>
      <p>Найдите фильм в строке выше — TorrClient опросит трекеры и предложит лучшую раздачу. Или перетащите магнит либо .torrent прямо в окно.</p>
      <div class="row" style="justify-content:center"><button class="primary" data-home-add>${raw(ico('plus', 16))} Добавить торрент</button><button data-home="top2">${raw(ico('flame', 16))} Что свежего</button></div>
    </div>` : '';
  }
}

/* ---------- ряды из внешних источников ----------
   Каждый ряд — «ленты»: список карточек, который грузится сам и помнится
   полчаса (Главную открывают часто, а подборки меняются медленно). У ленты
   TMDB карточки — названия, у трекерной — раздачи. */
const FEED_TTL = 30 * 60000;
const DISC_FEEDS = {
  trending: ['Сейчас смотрят', 'trending'],
  trend_anime: ['Аниме сейчас', 'trend_anime'],
  trend_cartoon: ['Мультфильмы сейчас', 'trend_cartoon'],
  anime: ['Аниме — лучшее', 'anime'],
  cartoon: ['Мультфильмы — лучшее', 'cartoon'],
  doc: ['Документальное', 'doc'],
  genre: ['По жанру', ''],
};
// Запросы к TMDB для готового ряда: [вид, cat, жанр, происхождение].
function feedQueries(def) {
  if (def.id === 'trend') return [['movie', 'trending', '', 'any'], ['tv', 'trending', '', 'any']];
  if (def.id === 'kids') return [['movie', 'trend_cartoon', '', 'any'], ['tv', 'trend_cartoon', '', 'any'], ['movie', '', '10751', 'any']];
  const f = DISC_FEEDS[def.feed] || DISC_FEEDS.trending;
  const kinds = def.kind === 'movie' ? ['movie'] : def.kind === 'tv' ? ['tv'] : ['movie', 'tv'];
  return kinds.map(k => [k, f[1], def.feed === 'genre' ? String(def.genre || '') : '', def.origin || 'any']);
}
async function loadFeed(def) {
  const st = homeState.feeds[def.id] || (homeState.feeds[def.id] = { items: null, at: 0, err: '', busy: false });
  if (st.busy || (st.items && Date.now() - st.at < FEED_TTL)) return;
  st.busy = true;
  try {
    if (def.source === 'tracker' || def.source === 'search') st.items = await loadTrackerFeed(def);
    else {
      const res = await Promise.all(feedQueries(def).map(([k, cat, genre, origin]) =>
        apiGetJSON('/api/discover?kind=' + k + '&cat=' + cat + '&origin=' + origin + (genre ? '&genre=' + genre : '') + '&page=1').catch(e => ({ ok: false, error: e.message }))));
      const lists = res.map(r => (r && r.ok && r.items) || []);
      const items = [], seen = new Set();
      for (let i = 0; i < Math.max(0, ...lists.map(l => l.length)); i++) {
        for (const l of lists) { const it = l[i]; if (it && !seen.has(it.kind + ':' + it.id)) { seen.add(it.kind + ':' + it.id); items.push(it); } }
      }
      st.items = items.slice(0, 24);
      st.err = items.length ? '' : ((res.find(r => r && r.error) || {}).error || 'пустой ответ');
      if (st.err) noteMetaError(st.err);
    }
    st.at = Date.now();
  } catch (e) { st.err = e.message; st.items = st.items || []; }
  finally { st.busy = false; }
}
// Раздачи с трекера: ТОП раздела (свежее, по сидам) или поиск по запросу.
async function loadTrackerFeed(def) {
  const cat = CATS.find(c => c.v === (def.cat || '')) || CATS[0];
  let rows = [];
  if (def.source === 'tracker') {
    const j = await apiGetJSON('/api/topcat?cat=' + encodeURIComponent(cat.top || ''));
    if (!j || !j.ok) throw new Error((j && j.error) || 'пустой ответ');
    rows = (j.items || []).map(r => row2res(r, 'topcat')).filter(Boolean);
  } else {
    const q = String(def.query || '').trim();
    if (!q) return [];
    rows = await withTimeout(searchRutor(q, 0, cat.rutor), SEARCH_TIMEOUT, 'rutor не ответил');
  }
  if (def.hd) rows = rows.filter(r => isFullHD(r.title || r.name || ''));
  // Экранки и совсем пустые раздачи в ряд не попадают; остальные — по пригодности для просмотра.
  rows = rows.filter(r => videoLike(r.title || r.name || '') && !rateRelease(r).bad);
  rows.sort((a, b) => bestScore(b, rateRelease(b)) - bestScore(a, rateRelease(a)));
  // Одно кино в разном качестве — одна карточка: берём лучшую раздачу.
  const byTitle = new Map();
  for (const r of rows) {
    const c = cleanSearchTitle(r.title || r.name || '');
    if (!c.q) continue;
    const k = bestNorm(c.q) + '|' + c.year + (isSeries(r.title) ? '|' + seasonOf(r.title) : '');
    if (!byTitle.has(k)) byTitle.set(k, Object.assign({ _c: c }, r));
  }
  return [...byTitle.values()].slice(0, 24);
}
function videoLike(title) { return !nonVideoKind(title); }
function loadHomeFeeds() {
  homeConfig().filter(x => x.on && (x.id === 'trend' || x.id === 'kids' || x.custom)).forEach(def => {
    loadFeed(def).then(() => { if (state.view === 'home') paintFeed(def); });
  });
}
function relMini(r, i, feed) {
  const c = r._c || cleanSearchTitle(r.title || r.name || '');
  const q = rateRelease(r);
  const sub = [c.year, isSeries(r.title) ? seriesTag(r.title).replace('Сериал · ', '') || 'Сериал' : '', r.seed != null ? '⬆ ' + r.seed : ''].filter(Boolean).join(' · ');
  return html`<div class="pcard" data-trend="${feed}:${i}" data-rel-title="${c.q}|${c.year}" tabindex="0" role="button" title="${r.title || ''}">
    <div class="pc-poster"><span class="pc-ph">${raw(ico('film', 28))}</span><span class="pc-play">${raw(ico('star', 22))}</span>
      <span class="chip rq rq-${q.tier} pc-tag">${q.res || q.source || q.score}</span>
      ${raw(isSeries(r.title) ? html`<span class="chip series pc-tag2">Сериал</span>` : '')}</div>
    <div class="pc-title">${c.q || r.title}</div>
    <div class="pc-sub">${sub}</div>
  </div>`;
}
function paintFeed(def) {
  const el = $('#' + railDomId(def.id)); if (!el) return;
  const st = homeState.feeds[def.id];
  const items = (st && st.items) || [];
  const title = def.title || (HOME_BUILTIN.find(x => x.id === def.id) || {}).title || 'Ряд';
  if (items.length) {
    const body = items.map((it, i) => it.id && it.kind ? trendMini(it, i, def.id) : relMini(it, i, def.id)).join('');
    paintRail(railDomId(def.id), title, items.length, body, '', '', 'pc');
    if (!(items[0].id && items[0].kind)) loadRelPosters(el, items);
    return;
  }
  // Подсказка про ключ TMDB — только в «Сейчас смотрят»: остальные ряды молчат.
  if (def.id === 'trend' && st && st.err && metaErrText(st.err)) {
    el.classList.remove('hidden');
    el.innerHTML = html`<div class="rail-h"><h2>${title}</h2></div><div class="note-card">${raw(ico('info', 18))}<div><b>Нужен ключ TMDB</b><div class="page-sub">${metaErrText(st.err)}</div></div><button data-go="settings">Настройки</button></div>`;
    return;
  }
  el.classList.add('hidden');
}
/* Постеры к карточкам-раздачам: по названию, через тот же кэш, что и в поиске. */
async function loadRelPosters(el, items) {
  const tasks = items.map((r, i) => ({ c: r._c || cleanSearchTitle(r.title || ''), i })).filter(t => t.c.q);
  await ratingsByTitle(tasks, (j, task) => {
    if (!j || !j.ok || !j.poster) return;
    const card = el.querySelector('[data-rel-title="' + CSS.escape(task.c.q + '|' + task.c.year) + '"] .pc-poster');
    if (card && !card.querySelector('img')) { card.insertAdjacentHTML('afterbegin', posterImg(j.poster)); }
    if (items[task.i]) items[task.i].poster = j.poster;
  });
}

function paintRail(id, title, count, body, goView, goLabel, kind) {
  const el = $('#' + id); if (!el) return;
  if (!count) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = html`<div class="rail-h"><h2>${title}</h2><span class="rail-n">${count}</span><span class="spacer"></span>
    ${raw(goView ? html`<button class="link-btn" data-go="${goView}">${goLabel}${raw(ico('arrow', 15))}</button>` : '')}</div>
    <div class="rail-wrap"><button class="rail-btn prev" data-rs="-1" aria-label="Назад">${raw(ico('collapse', 16))}</button><div class="rail-row rail-${kind}">${raw(body)}</div><button class="rail-btn next" data-rs="1" aria-label="Вперёд">${raw(ico('collapse', 16))}</button></div>`;
  syncRailBtns(el);
}
function bindRailScroll(root) {
  root.addEventListener('scroll', e => { const w = e.target.closest && e.target.closest('.rail'); if (w) syncRailBtns(w); }, true);
}
function syncRailBtns(rail) {
  const row = rail.querySelector('.rail-row'); if (!row) return;
  const p = rail.querySelector('.rail-btn.prev'), n = rail.querySelector('.rail-btn.next');
  requestAnimationFrame(() => {
    if (p) p.classList.toggle('off', row.scrollLeft < 8);
    if (n) n.classList.toggle('off', row.scrollLeft + row.clientWidth >= row.scrollWidth - 8);
  });
}

function posterImg(url, cls) {
  return url ? html`<img class="${cls || ''}" src="${pimg(url)}" loading="lazy" alt="" onerror="this.remove()">` : '';
}

/* Крупная карточка «продолжить»: размытая обложка фоном, постер, серия,
   сколько осталось. */
function contBig(it) {
  const title = cleanSearchTitle(it.t.title || it.t.name || '').q || it.t.title || it.t.name || it.t.hash;
  const next = it.kind === 'next';
  const left = it.duration > 0 && it.pos > 0 ? Math.max(0, it.duration - it.pos) : 0;
  const c = cleanSearchTitle(it.t.title || it.t.name || '');
  const film = !isSeries(it.t.title || it.t.name) && playableOf(it.t).length <= 1;
  const sub = film ? ['Фильм', c.year].filter(Boolean).join(' · ') : it.f.unknown ? 'с места остановки' : epLabel(it.f, it.t);
  return html`<div class="cw-card${next ? ' is-next' : ''}" data-cont data-cont-hash="${it.t.hash}" data-cont-file="${it.f.id}" tabindex="0">
    ${raw(posterImg(it.t.poster, 'cw-bg'))}
    <div class="cw-in">
      <div class="cw-poster">${raw(posterImg(it.t.poster))}${raw(it.t.poster ? '' : ico('film', 26))}</div>
      <div class="cw-txt">
        <div class="cw-kicker">${next ? 'Следующая серия' : (left ? 'Осталось ' + fmtDur(left) : 'Начато')}</div>
        <div class="cw-title" title="${it.t.title || it.t.name || ''}">${title}</div>
        <div class="cw-sub">${sub}</div>
        <div class="cw-bar"><i style="width:${Math.round((next ? 0 : it.share) * 100)}%"></i></div>
        <div class="cw-act">
          <button class="primary" data-cont-play>${raw(ico('play', 15))}${next ? 'Смотреть' : 'Продолжить'}</button>
          <button class="ghost" data-cont-done title="Отметить просмотренной">${raw(ico('check', 16))}</button>
        </div>
      </div>
    </div>
  </div>`;
}
function newSubCard(s) {
  return html`<div class="ns-card" data-ns="${s.id}">
    <div class="ns-top"><span class="ns-ico">${raw(ico('bell', 18))}</span><span class="chip hasnew">${s.new_count} ${plural(s.new_count, 'новая', 'новые', 'новых')}</span></div>
    <div class="ns-title">${s.title}</div>
    <div class="ns-sub">${s.last_seen || ('сезон ' + (s.season || '?') + (s.episode ? ', серия ' + s.episode : ''))}</div>
    <div class="ns-act"><button class="primary" data-ns-find>${raw(ico('star', 15))}Найти раздачу</button><button class="ghost" data-ns-seen title="Отметить прочитанным">${raw(ico('check', 16))}</button></div>
  </div>`;
}
function favMini(f, ix) {
  const isT = isTitleFav(f);
  const title = isT ? f.title : (cleanSearchTitle(f.title || '').q || f.title || 'магнит');
  return html`<div class="pcard" data-fav-ix="${ix}" tabindex="0" role="button" title="${f.title || ''}">
    <div class="pc-poster">${raw(posterImg(f.poster))}<span class="pc-ph">${raw(ico('film', 28))}</span><span class="pc-play">${raw(ico('play', 22))}</span></div>
    <div class="pc-title">${title}</div>
    <div class="pc-sub">${isT ? (f.kind === 'tv' ? 'Сериал' : 'Фильм') + (f.year ? ' · ' + String(f.year).slice(0, 4) : '') + ' · подберу раздачу' : (f.size || 'раздача')}</div>
  </div>`;
}
function recentMini(t) {
  const c = cleanSearchTitle(t.title || t.name || '');
  return html`<div class="pcard" data-lib-hash="${t.hash}" tabindex="0" role="button" title="${t.title || t.name || ''}">
    <div class="pc-poster">${raw(posterImg(t.poster))}<span class="pc-ph">${raw(ico('film', 28))}</span><span class="pc-play">${raw(ico('play', 22))}</span>
      ${raw(isSeries(t.title || t.name) ? html`<span class="chip series pc-tag">Сериал</span>` : '')}</div>
    <div class="pc-title">${c.q || t.title || t.name || t.hash}</div>
    <div class="pc-sub">${[c.year, t.torrent_size ? fmtSize(t.torrent_size) : '', fmtDate(t.timestamp)].filter(Boolean).join(' · ')}</div>
  </div>`;
}
function trendMini(it, i, feed) {
  return html`<div class="pcard disc-card" data-trend="${feed}:${i}" tabindex="0" role="button" title="${it.title}">
    <div class="pc-poster disc-poster">${raw(posterImg(it.poster))}<span class="pc-ph">${raw(ico('film', 28))}</span><span class="pc-play">${raw(ico('star', 22))}</span>${raw(discFavHtml(it))}
      ${raw(it.rating ? html`<span class="chip rating pc-rate">${Number(it.rating).toFixed(1)}</span>` : '')}</div>
    <div class="pc-title">${it.title}</div>
    <div class="pc-sub">${it.kind === 'tv' ? 'Сериал' : 'Фильм'}${it.year ? ' · ' + String(it.year).slice(0, 4) : ''}</div>
  </div>`;
}

/* ---------- настройка Главной ---------- */
function homeDefLabel(x) {
  if (!x.custom) return '';
  if (x.source === 'tmdb') return 'подборка TMDB: ' + ((DISC_FEEDS[x.feed] || [])[0] || '');
  if (x.source === 'tracker') return 'ТОП раздела: ' + ((CATS.find(c => c.v === (x.cat || '')) || {}).label || 'все');
  return 'поиск: «' + (x.query || '') + '»';
}
function openHomeEditor() {
  $$('body > .overlay.home-ed').forEach(o => o.remove());
  const ov = document.createElement('div'); ov.className = 'overlay home-ed';
  document.body.appendChild(ov);
  let list = homeConfig();
  let editing = null; // свой ряд, который сейчас правится (или новый)
  const close = () => { ov.remove(); if (state.view === 'home') { route(); } };
  const commit = () => saveHomeConfig(list);
  const paint = () => {
    const startNow = (localStorage.getItem(START_KEY) || 'home');
    if (editing) { paintCustomForm(); return; }
    ov.innerHTML = html`<div class="modal home-modal"><h3>Настройка Главной</h3>
      <div class="page-sub">Включайте, переставляйте и добавляйте ряды. Изменения сохраняются сразу.</div>
      <div class="he-list">${raw(list.map((x, i) => {
        const title = x.title || (HOME_BUILTIN.find(b => b.id === x.id) || {}).title;
        return html`<div class="he-row${x.on ? '' : ' off'}" data-i="${i}">
          <label class="he-sw"><input type="checkbox" data-on ${x.on ? 'checked' : ''}><span></span></label>
          <div class="he-t"><b>${title}</b>${raw(x.custom ? html`<div class="page-sub">${homeDefLabel(x)}</div>` : '')}</div>
          ${raw(x.custom ? '<button class="ghost" data-edit title="Изменить">' + ico('edit', 15) + '</button><button class="ghost danger" data-del title="Удалить ряд">' + ico('trash', 15) + '</button>' : '')}
          <button class="ghost" data-up ${i === 0 ? 'disabled' : ''} title="Выше">↑</button><button class="ghost" data-down ${i === list.length - 1 ? 'disabled' : ''} title="Ниже">↓</button>
        </div>`;
      }).join(''))}</div>
      <div class="row" style="margin-top:12px"><button id="heAdd" class="primary">${raw(ico('plus', 15))} Свой ряд</button><button id="heReset">Сбросить</button><span class="spacer"></span></div>
      <div class="he-start"><label>Стартовая страница
        <select id="heStart"><option value="home">Главная</option><option value="last">Последний открытый раздел</option>${raw(NAV_ITEMS.filter(x => x[0] !== 'home').map(x => html`<option value="${x[0]}">${x[1]}</option>`).join(''))}</select></label>
        <div class="page-sub">Любой раздел можно сделать стартовым и правым кликом по нему в боковой панели.</div></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button id="heDone" class="primary">Готово</button></div></div>`;
    $('#heStart', ov).value = startNow;
    $('#heStart', ov).addEventListener('change', e => setStartView(e.target.value));
    $$('.he-row', ov).forEach(row => {
      const i = +row.dataset.i;
      row.querySelector('[data-on]').addEventListener('change', e => { list[i].on = e.target.checked; commit(); row.classList.toggle('off', !e.target.checked); });
      const mv = d => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; commit(); paint(); };
      row.querySelector('[data-up]').addEventListener('click', () => mv(-1));
      row.querySelector('[data-down]').addEventListener('click', () => mv(1));
      const ed = row.querySelector('[data-edit]'); if (ed) ed.addEventListener('click', () => { editing = Object.assign({}, list[i]); paint(); });
      const dl = row.querySelector('[data-del]'); if (dl) dl.addEventListener('click', () => {
        const gone = list[i];
        list.splice(i, 1); commit(); paint();
        toastUndo('Ряд «' + gone.title + '» удалён', () => { list.splice(Math.min(i, list.length), 0, gone); commit(); if (document.body.contains(ov)) paint(); });
      });
    });
    $('#heAdd', ov).addEventListener('click', () => { editing = { id: 'c' + Date.now().toString(36), custom: true, on: true, source: 'tmdb', feed: 'trend_anime', kind: 'mix', title: '', fresh: true }; paint(); });
    $('#heReset', ov).addEventListener('click', () => {
      const keep = list.filter(x => x.custom);
      list = HOME_BUILTIN.map(b => Object.assign({}, b)).concat(keep);
      commit(); paint(); toast('Порядок и видимость рядов сброшены');
    });
    $('#heDone', ov).addEventListener('click', close);
  };
  const paintCustomForm = () => {
    const e = editing;
    const isNew = !list.some(x => x.id === e.id);
    const catOpts = CATS.filter(c => c.v !== '' && c.top).map(c => html`<option value="${c.v}" ${e.cat === c.v ? 'selected' : ''}>${c.label}</option>`).join('');
    const catOptsAll = CATS.filter(c => c.v !== '').map(c => html`<option value="${c.v}" ${e.cat === c.v ? 'selected' : ''}>${c.label}</option>`).join('');
    ov.innerHTML = html`<div class="modal home-modal"><h3>${isNew ? 'Новый ряд' : 'Ряд «' + (e.title || '') + '»'}</h3>
      <label>Название ряда</label><input id="ceTitle" value="${e.title || ''}" placeholder="например, Новинки аниме">
      <label>Откуда брать</label>
      <select id="ceSrc"><option value="tmdb" ${e.source === 'tmdb' ? 'selected' : ''}>Подборка TMDB (названия фильмов и сериалов)</option>
        <option value="tracker" ${e.source === 'tracker' ? 'selected' : ''}>ТОП раздела на трекере (свежие раздачи)</option>
        <option value="search" ${e.source === 'search' ? 'selected' : ''}>Поиск по трекеру (по вашему запросу)</option></select>
      <div id="ceTmdb" class="${e.source === 'tmdb' ? '' : 'hidden'}">
        <label>Подборка</label><select id="ceFeed">${raw(Object.entries(DISC_FEEDS).map(([k, v]) => html`<option value="${k}" ${e.feed === k ? 'selected' : ''}>${v[0]}</option>`).join(''))}</select>
        <label>Что показывать</label><select id="ceKind"><option value="mix" ${e.kind === 'mix' ? 'selected' : ''}>Фильмы и сериалы</option><option value="movie" ${e.kind === 'movie' ? 'selected' : ''}>Только фильмы</option><option value="tv" ${e.kind === 'tv' ? 'selected' : ''}>Только сериалы</option></select>
        <div id="ceGenreBox" class="${e.feed === 'genre' ? '' : 'hidden'}"><label>Жанр</label><select id="ceGenre">${raw(DISC_GENRES.movie.filter(g => g[0] !== '').map(g => html`<option value="${g[0]}" ${String(e.genre) === String(g[0]) ? 'selected' : ''}>${g[1]}</option>`).join(''))}</select></div>
        <label>Происхождение</label><select id="ceOrigin"><option value="any" ${e.origin !== 'ru' ? 'selected' : ''}>Любое</option><option value="ru" ${e.origin === 'ru' ? 'selected' : ''}>Русское</option></select>
      </div>
      <div id="ceTr" class="${e.source === 'tracker' ? '' : 'hidden'}"><label>Раздел трекера</label><select id="ceCatTop">${raw(catOpts)}</select></div>
      <div id="ceSe" class="${e.source === 'search' ? '' : 'hidden'}"><label>Запрос</label><input id="ceQuery" value="${e.query || ''}" placeholder="например, мультфильм 2025">
        <label>Категория</label><select id="ceCatAll"><option value="">Все категории</option>${raw(catOptsAll)}</select></div>
      <label class="fhd" id="ceHdBox" style="margin-top:10px"><input type="checkbox" id="ceHd" ${e.hd ? 'checked' : ''}> только Full HD и выше</label>
      <div class="row" style="margin-top:14px"><button id="ceBack">Назад</button><span class="spacer"></span><button id="ceSave" class="primary">Сохранить</button></div></div>`;
    const src = $('#ceSrc', ov);
    const sync = () => {
      $('#ceTmdb', ov).classList.toggle('hidden', src.value !== 'tmdb');
      $('#ceTr', ov).classList.toggle('hidden', src.value !== 'tracker');
      $('#ceSe', ov).classList.toggle('hidden', src.value !== 'search');
      $('#ceHdBox', ov).classList.toggle('hidden', src.value === 'tmdb');
      $('#ceGenreBox', ov).classList.toggle('hidden', !($('#ceFeed', ov).value === 'genre' && src.value === 'tmdb'));
    };
    src.addEventListener('change', sync); $('#ceFeed', ov).addEventListener('change', sync); sync();
    if (e.source === 'tracker' && e.cat) $('#ceCatTop', ov).value = e.cat;
    $('#ceBack', ov).addEventListener('click', () => { editing = null; paint(); });
    $('#ceSave', ov).addEventListener('click', () => {
      const def = { id: e.id, custom: true, on: e.on !== false, source: src.value };
      def.title = $('#ceTitle', ov).value.trim();
      if (def.source === 'tmdb') {
        def.feed = $('#ceFeed', ov).value; def.kind = $('#ceKind', ov).value; def.origin = $('#ceOrigin', ov).value;
        if (def.feed === 'genre') def.genre = $('#ceGenre', ov).value;
        if (!def.title) def.title = DISC_FEEDS[def.feed][0];
      } else if (def.source === 'tracker') {
        def.cat = $('#ceCatTop', ov).value; def.hd = $('#ceHd', ov).checked;
        if (!def.title) def.title = 'Свежее: ' + ((CATS.find(c => c.v === def.cat) || {}).label || 'трекер');
      } else {
        def.query = $('#ceQuery', ov).value.trim(); def.cat = $('#ceCatAll', ov).value; def.hd = $('#ceHd', ov).checked;
        if (!def.query) { toast('Введите запрос', true); return; }
        if (!def.title) def.title = def.query;
      }
      const i = list.findIndex(x => x.id === def.id);
      if (i >= 0) list[i] = def; else list.push(def);
      delete homeState.feeds[def.id];
      commit(); editing = null; paint();
    });
  };
  ov.addEventListener('click', ev => { if (ev.target === ov) close(); });
  paint();
}

function onHomeClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) { setView(go.dataset.go); return; }
  const rs = e.target.closest('[data-rs]');
  if (rs) { const row = rs.parentElement.querySelector('.rail-row'); row.scrollBy({ left: Number(rs.dataset.rs) * row.clientWidth * 0.85, behavior: 'smooth' }); setTimeout(() => syncRailBtns(rs.closest('.rail')), 450); return; }
  if (e.target.closest('[data-home-add]')) { openAddModal(); return; }
  if (e.target.closest('[data-home-cfg]')) { openHomeEditor(); return; }
  if (e.target.closest('[data-home="top2"]')) { homeGo('top'); return; }
  const cw = e.target.closest('[data-cont]');
  if (cw) {
    const it = continueItems().find(x => x.t.hash === cw.dataset.contHash && x.f.id === Number(cw.dataset.contFile));
    if (!it) return;
    if (e.target.closest('[data-cont-done]')) { doneContinue(it).then(paintHome); return; }
    playContinue(it); return;
  }
  const ns = e.target.closest('[data-ns]');
  if (ns) {
    const s = (state.subs || []).find(x => x.id === ns.dataset.ns); if (!s) return;
    if (e.target.closest('[data-ns-seen]')) { subsSeen(s.id).then(paintHome); return; }
    openMovie({ title: s.title || s.query, kind: 'tv', season: Number(s.season) || 0, query: s.query }); return;
  }
  const fv = e.target.closest('.disc-fav');
  if (fv) {
    e.stopPropagation();
    const all = Object.values(homeState.feeds).flatMap(f => f.items || []);
    toggleDiscFav(all.find(x => x.id && x.kind && discFavKey(x) === fv.dataset.fk));
    paintHome(); return;
  }
  const tr = e.target.closest('[data-trend]');
  if (tr) {
    const [fid, ix] = tr.dataset.trend.split(':');
    const it = ((homeState.feeds[fid] || {}).items || [])[+ix]; if (!it) return;
    if (it.id && it.kind) openMovie({ title: it.title, year: it.year, kind: it.kind, tmdb: it.id, poster: it.poster, overview: it.overview, rating: it.rating });
    else openMovie(fromRelease(it));
    return;
  }
  const fc = e.target.closest('[data-fav-ix]');
  if (fc) { const f = favList()[+fc.dataset.favIx]; if (!f) return; if (isTitleFav(f)) openMovie({ title: f.title, year: f.year, kind: f.kind, tmdb: f.tmdb, poster: f.poster }); else playSearchLink(f); return; }
  const lc = e.target.closest('[data-lib-hash]');
  if (lc) { const t = (state.lib || []).find(x => x.hash === lc.dataset.libHash); if (t) watchNow(t); }
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || state.view !== 'home') return;
  const c = e.target.closest && e.target.closest('.pcard, .cw-card');
  if (c && e.target === c) { e.preventDefault(); c.click(); }
});
async function renderLibrary(root) {
  const lv = localStorage.getItem('tc_libview') || 'grid';
  root.innerHTML = html`
    <div class="page-head">
      <div class="ph-txt"><h1 class="page-title">Библиотека</h1><div class="page-sub" id="libSub"></div></div>
      <div class="ph-act">
        <button id="libRec" title="Фильмы и сериалы, похожие на те, что в библиотеке (нужен ключ TMDB)">${raw(ico('sparkles', 16))}Рекомендации</button>
        <div class="seg" id="libViewSeg">
          <button data-vw="grid" class="${lv === 'grid' ? 'on' : ''}" title="Сетка">${raw(ico('grid', 16))}</button>
          <button data-vw="list" class="${lv === 'list' ? 'on' : ''}" title="Список">${raw(ico('list', 16))}</button>
        </div>
      </div>
    </div>
    <div class="filterbar">
      <input class="search-input" id="libQuery" placeholder="Фильтр по названию…" value="${state.query}">
      <select id="libCat">
        <option value="all">Все категории</option>
        <option value="movie">Фильмы</option>
        <option value="tv">Сериалы</option>
        <option value="music">Музыка</option>
        <option value="other">Другое</option>
      </select>
      <select id="libOrder">
        <option value="name">По названию</option>
        <option value="date">По дате</option>
        <option value="size">По размеру</option>
        <option value="progress">По просмотру</option>
      </select>
      <select id="libSeen" title="Что показать по просмотру">
        <option value="all">Любой просмотр</option>
        <option value="new">Не начато</option>
        <option value="started">Начато</option>
        <option value="done">Досмотрено</option>
      </select>
      <select id="libColl" title="Подборка"></select>
      <button id="collNew" class="iconbtn" title="Новая подборка">${raw(ico('plus', 16))}</button>
      <button id="libReset" class="iconbtn hidden" title="Сбросить фильтры">${raw(ico('x', 16))}</button>
    </div>
    <div id="libGrid" class="grid ${lv === 'list' ? 'list' : ''}"></div>
    <div id="libEmpty" class="empty hidden">${raw(ico('film', 34))}<b>Библиотека пуста</b>Перетащите магнит или .torrent в окно либо нажмите «Добавить» вверху.</div>`;

  $('#libQuery').value = state.query;
  $('#libCat').value = state.category;
  $('#libQuery').addEventListener('input', () => { state.query = $('#libQuery').value; paintLibrary(); });
  $('#libCat').addEventListener('change', () => { state.category = $('#libCat').value; paintLibrary(); });
  $('#libOrder').value = localStorage.getItem(LS.order) || 'name';
  $('#libOrder').addEventListener('change', () => { localStorage.setItem(LS.order, $('#libOrder').value); paintLibrary(); });
  $('#libSeen').value = state.seen || 'all';
  $('#libSeen').addEventListener('change', () => { state.seen = $('#libSeen').value; paintLibrary(); });
  fillCollSelect($('#libColl'), state.coll);
  $('#libColl').addEventListener('change', () => { state.coll = $('#libColl').value; paintLibrary(); });
  $('#collNew').addEventListener('click', () => {
    const name = (typeof prompt === 'function' ? prompt('Название подборки:') : '') || '';
    if (!name.trim()) return;
    // Сразу выбрать новую подборку: иначе непонятно, создалась ли она, и куда
    // попадёт следующая раздача.
    state.coll = collCreate(name.trim());
    fillCollSelect($('#libColl'), state.coll);
    paintLibrary();
    toast('Подборка создана');
  });
  $('#libRec').addEventListener('click', () => showRecommendations());
  $('#libReset').addEventListener('click', () => {
    state.query = ''; state.category = 'all'; state.seen = 'all'; state.coll = '';
    $('#libQuery').value = ''; $('#libCat').value = 'all';
    $('#libSeen').value = 'all'; $('#libColl').value = '';
    paintLibrary();
  });
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
const libRetry = { timer: 0, n: 0 };
async function loadLibrary(paint) {
  // Музыка живёт в своём разделе: в Библиотеку, «Продолжить» и Сериалы она не идёт.
  try { const ms = musicHashes(); state.lib = (await listTorrents()).filter(t => !isMusicTorrent(t, ms)); state.libError = ''; libRetry.n = 0; }
  catch (e) {
    // Сервер ещё поднимается (так бывает сразу после запуска) — список
    // запрашивается снова сам, всё реже: 1,5 с, 3 с, 6 с… до 30 с.
    state.libError = e.message;
    if (!Array.isArray(state.lib)) state.lib = [];
    if (!libRetry.timer) {
      const delay = Math.min(30000, 1500 * Math.pow(2, libRetry.n++));
      libRetry.timer = setTimeout(() => { libRetry.timer = 0; if (state.view === 'library') refreshLibrary(); }, delay);
    }
  }
  await loadPositions();
  state.lib.forEach(keepFiles);
  if (paint) paintLibrary();
  // Сначала — раздачи с отметками просмотра: их файлы нужны полосе
  // «Продолжить просмотр», и ждать очереди из сотни плиток им незачем.
  const marked = new Set((state.viewed || []).map(v => v && v.hash));
  const need = state.lib.filter(t => !t.hasStat && !statCache[t.hash])
    .sort((a, b) => (marked.has(b.hash) ? 1 : 0) - (marked.has(a.hash) ? 1 : 0));
  if (need.length) enrichBackground(need);
  return state.lib;
}

/* keepFiles возвращает раздаче список файлов, если свежий список пришёл без
   него. Без file_stats «Продолжить просмотр» не может найти серию и молча
   пропадал: после перезагрузки списка файлы терялись, а повторно их не
   спрашивали — раздача уже числилась в кэше. Берём из кэша статистики, а если
   его нет — из поля data, в котором TorrServer хранит список файлов. */
function keepFiles(t) {
  if (!t || (Array.isArray(t.file_stats) && t.file_stats.length)) return;
  const c = statCache[t.hash];
  if (c && c.data && Array.isArray(c.data.file_stats) && c.data.file_stats.length) {
    Object.assign(t, mergeStat(Object.assign({}, c.data), t), { file_stats: c.data.file_stats, hasStat: true });
    return;
  }
  if (typeof t.data !== 'string' || t.data.indexOf('Files') < 0) return;
  try {
    const d = JSON.parse(t.data);
    const files = d && d.TorrServer && d.TorrServer.Files;
    if (Array.isArray(files) && files.length) t.file_stats = files;
  } catch {}
}

/* Отметки просмотра ведёт демон: он один знает позицию от самого плеера, а не
   по времени с момента запуска. Список /viewed у TorrServer отмечает файл
   просмотренным уже в момент начала потока и позицию не хранит. */
async function loadPositions() {
  // Список TorrServer читается рядом, но отдельно: позиции в нём нет, зато он
  // помнит всё, что хоть раз запускали — и в плеере, за которым демон не
  // следит, и с телефона. По нему «Продолжить просмотр» не пустеет, даже
  // когда демон позиций не знает.
  const ts = tsJson('/viewed', { action: 'list' }).catch(() => null);
  try { const rows = await api('/api/positions'); if (Array.isArray(rows)) { state.viewed = rows; invalidateMarks(); } }
  catch {}
  const tv = await ts;
  if (Array.isArray(tv)) state.tsViewed = tv.filter(v => v && v.hash);
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
    invalidateMarks();
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
        if (cur) { mergeStat(cur, s); cur.hasStat = true; }
      }
    }
  };
  await Promise.all([w(), w(), w(), w()]);
  if (state.view === 'library') paintLibrary();
}

/* fillCollSelect наполняет список подборок. Отдельной функцией, потому что
   наполнять приходится не один раз: подборку создают, переименовывают и
   удаляют, не переходя на другую страницу. */
function fillCollSelect(sel, value) {
  if (!sel) return;
  sel.innerHTML = html`
    <option value="">Вся библиотека</option>
    <option value="fav">Избранное</option>
    ${raw(collList().map(c => html`<option value="${c.id}">${c.name} (${(c.items || []).length})</option>`).join(''))}`;
  sel.value = value || '';
}

// libFiltered — включён ли хоть один фильтр. По нему показывается кнопка
// сброса: без неё «библиотека пуста» при включённом фильтре выглядела бы как
// пропавшие раздачи, а не как отфильтрованная выдача.
function libFiltered() {
  return !!(state.query.trim() || state.category !== 'all' || (state.seen && state.seen !== 'all') || state.coll);
}

function filterLib() {
  const q = state.query.trim().toLowerCase();
  const cat = state.category;
  const seen = state.seen || 'all';
  const coll = state.coll || '';
  // Наборы хешей готовятся один раз, а не ищутся внутри фильтра: раздач в
  // библиотеке сотни, и поиск по массиву на каждую делал фильтр квадратичным.
  const favHashes = new Set(favList().map(f => (f && f.hash ? f.hash : f)));
  const collItem = coll && coll !== 'fav' ? collById(coll) : null;
  const collHashes = new Set(collItem ? (collItem.items || []) : []);
  return state.lib.filter(t => {
    const title = (t.title || t.name || '').toLowerCase();
    if (q && !title.includes(q)) return false;
    if (cat !== 'all') { const c = (t.category || '').toLowerCase(); if (cat === 'uncategorized' ? c : c !== cat) return false; }
    if (seen !== 'all' && watchState(t) !== seen) return false;
    if (coll === 'fav') { if (!favHashes.has(t.hash)) return false; }
    else if (coll) { if (!collItem || !collHashes.has(t.hash)) return false; }
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
    // «По просмотру»: начатое выше не начатого. У сериала доля считается по
    // сериям, поэтому начатый сезон поднимается выше просмотренного фильма.
    progress: (a, b) => libProgress(b) - libProgress(a),
  }[order] || ((a, b) => 0);
  list.sort(cmp);
  $('#libSub').textContent = libFiltered()
    ? `Показано ${list.length} из ${state.lib.length}`
    : `Торрентов: ${state.lib.length}`;
  const reset = $('#libReset');
  if (reset) reset.classList.toggle('hidden', !libFiltered());
  const grid = $('#libGrid');
  if (!list.length) { grid.innerHTML = ''; $('#libEmpty').classList.remove('hidden'); $('#libEmpty').textContent = state.libError ? 'Сервер пока не отвечает (' + state.libError + ') — пробую снова…' : libFiltered() ? 'Ничего не подошло под фильтр.' : 'Библиотека пуста. Добавьте магнит или .torrent.'; return; }
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

/* continueItems — к чему вернуться: по карточке на раздачу. Если последней
   тронутой была недосмотренная серия — она с места остановки. Если серию
   досмотрели — следующая по номеру, с начала: иначе после конца серии полоса
   пустела, и следующую приходилось искать в списке. Свежие сверху. */
function continueItems() {
  const lib = {};
  (state.lib || []).forEach(t => { lib[t.hash] = t; });
  const groups = {};
  (state.viewed || []).forEach(v => {
    if (!v || !lib[v.hash]) return;
    (groups[v.hash] = groups[v.hash] || []).push(v);
  });
  const out = [];
  Object.keys(groups).forEach(hash => {
    const t = lib[hash];
    const files = t.file_stats || [];
    const fileOf = v => files.find(x => x.id === v.file_index);
    const list = groups[hash].slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
    // Список файлов раздачи приходит не сразу (а у закрытой раздачи — только
    // после запроса к TorrServer). Карточка от этого не пропадает: файл
    // известен по номеру, а имя подтянется при запуске.
    const resume = v => {
      const f = fileOf(v) || (files.length ? null : { id: v.file_index, path: '', unknown: true });
      return f ? {
        t, f, kind: 'resume', pos: v.timecode || 0, duration: v.duration || 0,
        share: v.duration > 0 ? Math.min(1, (v.timecode || 0) / v.duration) : 0, updated: v.updated || 0,
      } : null;
    };
    const last = list[0];
    let it = null;
    // Последней открыли недосмотренную серию — к ней и возвращаемся, даже если
    // плеер не сообщил позицию (отметка с нулём): прежде такая раздача из
    // полосы выпадала целиком.
    if (!last.done) it = resume(last);
    else if (last.done && fileOf(last)) {
      const vids = files.filter(x => isVideo(x.path));
      const nf = vids.length > 1 ? nextAfter(t, vids, fileOf(last)) : null;
      if (nf && !isWatched(t, nf.id)) {
        const pos = currentTc(t, nf.id) || 0;
        it = { t, f: nf, kind: pos > 0 ? 'resume' : 'next', pos, duration: 0, share: 0, updated: last.updated || 0 };
      }
    }
    // Последняя серия досмотрена, а следующей нет — но могла остаться начатая.
    if (!it) { const v = list.find(x => !x.done); if (v) it = resume(v); }
    if (it) out.push(it);
  });
  // Раздачи, которые запускали, но позиции демон не знает: берём последнюю по
  // порядку тронутую серию и предлагаем вернуться к ней. Они идут после
  // раздач с настоящей позицией.
  const tsGroups = {};
  (state.tsViewed || []).forEach(v => {
    if (groups[v.hash] || !lib[v.hash]) return;
    (tsGroups[v.hash] = tsGroups[v.hash] || []).push(v.file_index);
  });
  Object.keys(tsGroups).forEach(hash => {
    const t = lib[hash];
    const files = t.file_stats || [];
    const ids = tsGroups[hash];
    let f = null;
    if (files.length) {
      const vids = files.filter(x => isVideo(x.path));
      const sorted = vids.slice().sort((a, b) => epIdx(a.path) - epIdx(b.path) || a.path.localeCompare(b.path, 'ru', { numeric: true }));
      for (const x of sorted) if (ids.includes(x.id)) f = x;
    } else {
      f = { id: Math.max.apply(null, ids), path: '', unknown: true };
    }
    if (f) out.push({ t, f, kind: 'resume', pos: 0, duration: 0, share: 0, updated: 0 });
  });
  /* Порядок — от последнего открытого. Демон пишет время в секундах, запуск
     из окна помнится в миллисекундах; берётся более свежее из двух. Прежде
     раздачи без отметки демона (updated = 0) уходили в конец, даже если их
     запустили минуту назад. */
  const lp = lastPlayed();
  out.forEach(it => { const l = lp[it.t.hash]; it.recent = Math.max((it.updated || 0) * 1000, l ? l.at : 0); });
  return out.sort((a, b) => b.recent - a.recent);
}
// Сколько карточек «Продолжить просмотр» показывать: больше шести — уже не
// «продолжить», а список всего начатого (он — в Библиотеке и Закладках).
const CONT_MAX = 6;
function continueCard(it) {
  const title = it.t.title || it.t.name || it.t.hash;
  const next = it.kind === 'next';
  return html`
  <div class="cont-card${next ? ' is-next' : ''}" data-cont data-cont-hash="${it.t.hash}" data-cont-file="${it.f.id}">
    <div class="cont-top">
      ${raw(it.t.poster ? html`<img class="cont-poster" src="${pimg(it.t.poster)}" loading="lazy" alt="" onerror="this.remove()">` : '')}
      <div class="cont-txt">
        <div class="cont-title" title="${title}">${title}</div>
        <div class="cont-sub">${next ? 'Дальше: ' : ''}${it.f.unknown ? 'с места остановки' : epLabel(it.f, it.t)}</div>
      </div>
    </div>
    <div class="cont-bar"><i style="width:${Math.round(it.share * 100)}%"></i></div>
    <div class="cont-foot">
      <span class="cont-pos">${next ? 'следующая серия' : (it.pos > 0 ? fmtPos(it.pos) + (it.duration ? ' из ' + fmtPos(it.duration) : '') : 'начато')}</span>
      <button class="chip-btn" data-cont-play>${next ? '▶ Смотреть' : '▶ Продолжить'}</button>
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
  box.innerHTML = html`<div class="cont-head">Продолжить просмотр <span class="cont-n">${Math.min(items.length, CONT_MAX)}</span></div>`
    + html`<div class="cont-row">${raw(items.slice(0, CONT_MAX).map(continueCard).join(''))}</div>`;
}
function bindContinue() {
  const box = $('#libContinue');
  if (!box) return;
  box.addEventListener('click', e => {
    const card = e.target.closest('[data-cont]');
    if (!card) return;
    const it = continueItems().find(x => x.t.hash === card.dataset.contHash && x.f.id === Number(card.dataset.contFile));
    if (!it) return;
    if (e.target.closest('[data-cont-done]')) { doneContinue(it).then(() => { paintContinue(); paintLibrary(); }); return; }
    playContinue(it);
  });
}
// Отметка досмотра обнуляет позицию: возвращаться к серии больше некуда.
function doneContinue(it) { return savePosition(it.t.hash, it.f.id, 0, it.duration, true); }
// playContinue — запуск с места остановки (Библиотека и Главная).
function playContinue(it) {
  if (!it.f.unknown) { playSelected(it.t, it.f); return; }
  // Файлы раздачи ещё не известны — сначала спрашиваем их у TorrServer.
  waitForFiles(it.t).then(st => {
    const f = st && (st.file_stats || []).find(x => x.id === it.f.id);
    if (f) playSelected(Object.assign(it.t, { file_stats: st.file_stats }), f);
    else if (st) toast('Файл не найден в раздаче', true);
  });
}

function tile(t) {
  const hasMedia = (t.file_stats || []).some(f => isPlayable(f.path));
  const loaded = t.torrent_size ? (t.bytes_read || 0) / t.torrent_size : 0;
  const sp = seriesProgress(t);
  const q = qTag(t.title || t.name || '');
  const lq = libQuality(t);
  const ser = isSeries(t.title || t.name || '');
  // Многосерийная раздача без пометок в названии (часто у аниме и мультиков)
  // — тоже сериал для подписки.
  const multi = ser || (t.file_stats || []).filter(f => isPlayable(f.path)).length > 1;
  const title = t.title || t.name || (t.hash || '').slice(0, 12);
  const st = String(t.stat_string || t.stat || '');
  let scls = 'idle';
  if (/download/i.test(st)) scls = 'dl'; else if (loaded >= 1 && t.torrent_size) scls = 'ok';
  // Оценки уже известны — показываются сразу, а не после ответа TMDB: иначе
  // каждая перерисовка плитки гасила бы чипы до следующего запроса.
  const rt = ratingFor(t);
  const rtTmdb = rt && rt.rating > 0 ? rt.rating.toFixed(1) : '';
  const rtImdb = rt && rt.imdb > 0 ? rt.imdb.toFixed(1) : '';
  // Байты метаданных (год, размер, сиды) приходят из ответа TorrServer: год и
  // счётчики там не обязаны быть числами, а название раздачи пишет трекер.
  // Каждый байт экранируется по отдельности — разделитель между ними остаётся
  // разметкой, а подставленное значение ею стать не может.
  const metaBits = [];
  if (t.year) metaBits.push(t.year);
  if (t.torrent_size) metaBits.push(fmtSize(t.torrent_size));
  if (t.connected_seeders != null) metaBits.push('⬆ ' + t.connected_seeders);
  if (t.total_peers != null) metaBits.push('👥 ' + t.total_peers);
  // Скорость в карточке не показывается: это снимок на момент открытия
  // библиотеки, и во время просмотра он застывал на случайной цифре. Живые
  // скорости — в окне «Закачки».
  if (!metaBits.length && fmtDate(t.timestamp)) metaBits.push('добавлен ' + fmtDate(t.timestamp));
  // Пустая полоса под каждой плиткой — шум: полоса видна, когда есть что показать.
  const pg = hasMedia && (sp ? sp.share : loaded) > 0.004 ? `<div class="progress"${sp ? ` title="просмотрено ${sp.done} из ${sp.total}"` : ''}><i style="width:${Math.min(100, (sp ? sp.share : loaded) * 100).toFixed(0)}%"></i></div>` : '';
  const pgNote = sp ? `<div class="page-sub">просмотрено ${sp.done} из ${sp.total}${sp.started ? ' · начато ' + sp.started : ''}</div>` : '';
  return html`
  <div class="tile" data-hash="${t.hash}">
    <div class="poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (t.poster ? 'hidden' : '') + '"'))}
      ${raw(t.poster ? html`<img src="${pimg(t.poster)}" loading="lazy" onerror="var p=this.parentElement;this.remove();p.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-act="watch" title="Смотреть"><span class="tri"></span></button>
      <div class="badges">
        ${raw(lq.q.res ? html`<span class="chip ${q}">${lq.q.res}</span>` : '')}
        ${raw(ser ? html`<span class="chip series">${seriesTag(t.title || t.name || '')}</span>` : '')}
        ${raw(lq.q.res || lq.q.source || lq.q.audio ? html`<span class="chip rq rq-${lq.q.tier}" title="${lq.tip}">${lq.q.score}${lq.q.ru ? ' · RU' : ''}</span>` : '')}
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
      ${raw(lq.line ? html`<div class="qline" title="${lq.tip}">${lq.line}</div>` : '')}
      ${raw(pg)}
      ${raw(pgNote)}
      <div class="metabar">
        <span class="mb-stats">${raw(metaBits.map(esc).join(' &nbsp;·&nbsp; ') || '—')}</span>
      </div>
      <button class="menu-ico" data-menu title="Ещё" aria-label="Ещё">${raw(ico('more', 18))}</button>
    </div>
    <div class="ctxmenu hidden">
      <button data-act="card">Карточка фильма</button>
      <button data-act="info">Инфо о раздаче</button>
      <button data-act="edit">Изменить</button>
      <button data-act="autoposter">Подгрузить постер (TMDB)</button>
      ${raw(multi ? '<button data-act="subs">Следить за новыми сериями</button>' : '')}
      <button data-act="send">📲 Отправить на устройство…</button>
      <button data-act="bm">Закладка просмотра</button>
      <button data-act="coll">В подборку…</button>
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
function isPlayable(p) { return isVideo(p) || isAudio(p); }
// Сериал по названию раздачи. Трекеры пишут по-разному: [S02], S01E01-08,
// [02x01-02 из 10], «1 сезон: 1-8 серии из 8», «Сезон 3». Прежняя проверка
// ловила только S01E01 и «сезон» — раздачи вида [S02] шли как фильмы.
const SERIES_RE = /\b[sс]\d{1,2}(?:\s*[eе]\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b|\bseason\b|\bepisodes?\b|sezon|сезон|сери[яий]|эпизод|\d{1,4}\s*(?:-\s*\d{1,4}\s*)?из\s*(?:\d{1,4}|xx)|\[(?:tv|тв)(?:-\d)?\]|\[\d{1,4}\s*-\s*\d{1,4}\]/i;
function isSeries(name) { return SERIES_RE.test(name || ''); }
// seriesTag — короткая метка «Сериал · S02» / «Сериал · S02, 1–2 из 10».
function seriesTag(name) {
  const t = name || ''; if (!isSeries(t)) return '';
  let season = (t.match(/\b[sс](\d{1,2})(?:\s*[eе]\d{1,3})?\b/i) || t.match(/\b(\d{1,2})x\d{1,3}\b/i) || t.match(/(\d{1,2})\s*сезон/i) || t.match(/сезон\s*(\d{1,2})/i) || [])[1];
  const eps = t.match(/(\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?из\s*(\d{1,3})/i);
  const parts = [];
  if (season) parts.push('S' + String(+season).padStart(2, '0'));
  if (eps) parts.push((eps[2] ? (+eps[1]) + '–' + (+eps[2]) : +eps[1]) + ' из ' + (+eps[3]));
  return 'Сериал' + (parts.length ? ' · ' + parts.join(', ') : '');
}
/* QUALITY-BEGIN */
// rateRelease оценивает раздачу по названию, размеру и сидам: разрешение,
// источник, кодек, HDR, русская дорожка. Возвращает оценку 0–100 и подписи для
// подсказки. Оценка эвристическая: по названию нельзя узнать всё, поэтому
// честно говорит «по названию» и не заменяет ffprobe в карточке раздачи.
function rateRelease(r) {
  const t = String((r && (r.title || r.name)) || '');
  // seed не задан (раздача из библиотеки: число сидов там — снимок, а не оценка) —
  // сиды не оцениваются: ни штрафа за «нет сидов», ни потолка.
  const seedKnown = !!r && r.seed != null && r.seed !== '' && !isNaN(Number(r.seed));
  const seeds = seedKnown ? Math.max(0, Number(r.seed)) : 0;
  const bytes = Number(r && r.size_bytes) || 0;
  const has = re => re.test(t);
  const out = { score: 0, res: '', source: '', codec: '', hdr: '', audio: '', ru: false, bad: false, notes: [] };

  // Разрешение
  let resPts = 0;
  if (has(/\b(2160p?|4k|uhd)\b/i)) { out.res = '4K'; resPts = 40; }
  else if (has(/\b1080[pi]?\b|\bfull\s?hd\b|\bfhd\b/i)) { out.res = '1080p'; resPts = 32; }
  else if (has(/\b720p?\b|\bhd\b(?!tv|rip)/i)) { out.res = '720p'; resPts = 20; }
  else if (has(/\b(480p?|576p?|dvd-?rip|dvd-?9|dvd5|sdtv|sd)\b/i)) { out.res = 'SD'; resPts = 8; }

  // Источник
  let srcPts = 10;
  if (has(/\b(cam-?rip|camrip|hdcam|cam|telesync|ts|hdts|tc|telecine|scr|screener)\b/i) && !has(/\b(web|bd|blu)/i)) { out.source = 'Экранка'; out.bad = true; srcPts = 0; }
  else if (has(/\bremux\b|bd-?remux/i)) { out.source = 'Remux'; srcPts = 20; }
  else if (has(/\bblu-?ray\b|\bbdrip\b|\bbrrip\b|\bbd-?rip\b|\bbd(?:25|50|66|100)\b/i)) { out.source = 'BluRay'; srcPts = 18; }
  else if (has(/\bweb-?dl\b/i)) { out.source = 'WEB-DL'; srcPts = 17; }
  else if (has(/\bweb-?rip\b|\bwebdlrip\b/i)) { out.source = 'WEBRip'; srcPts = 13; }
  else if (has(/\bhdtv|\bhdtvrip\b|\bsat-?rip\b|\btv-?rip\b/i)) { out.source = 'HDTV'; srcPts = 9; }
  else if (has(/\bdvd-?rip\b|\bdvd\b/i)) { out.source = 'DVD'; srcPts = 8; }

  // Кодек и HDR
  let extra = 0;
  if (has(/\bav1\b/i)) { out.codec = 'AV1'; extra += 3; }
  else if (has(/\b(hevc|x265|h\.?265)\b/i)) { out.codec = 'HEVC'; extra += 3; }
  else if (has(/\b(avc|x264|h\.?264)\b/i)) { out.codec = 'AVC'; extra += 2; }
  if (has(/dolby.?vision|\bdv\b/i)) { out.hdr = 'Dolby Vision'; extra += 2; }
  else if (has(/\bhdr10\+?\b|\bhdr\b/i)) { out.hdr = 'HDR'; extra += 2; }

  // Русская дорожка: лицензия и дубляж лучше многоголоски, та лучше одноголоски
  let ruPts = 0;
  if (has(/дубл|\bdub\b|лицензи|\bлицуха\b|\bdubbed\b/i)) { out.audio = 'Дубляж'; out.ru = true; ruPts = 15; }
  else if (has(/\bmvo\b|многоголос|\bпм\b/i)) { out.audio = 'Многоголосый'; out.ru = true; ruPts = 12; }
  else if (has(/\bdvo\b|двухголос|\bдм\b/i)) { out.audio = 'Двухголосый'; out.ru = true; ruPts = 9; }
  else if (has(/\bavo\b|\bvo\b|одноголос|\bлм\b|\bлюбительск/i)) { out.audio = 'Одноголосый'; out.ru = true; ruPts = 6; }
  else if (has(/озвучк|\brus\b|русск|\bru\b|\brusdub\b/i)) { out.audio = 'Русская'; out.ru = true; ruPts = 8; }
  if (has(/\b(atmos|truehd|dts-?hd|dts-?x)\b/i)) extra += 1;
  if (has(/\bsub\b|субтитр|\bsubs?\b/i) && !out.ru) { out.notes.push('только субтитры'); ruPts = 2; }

  // Сиды: логарифм, чтобы 1000 сидов не давили всё остальное
  const seedPts = seedKnown ? Math.min(15, Math.round(5 * Math.log10(seeds + 1))) : 8;
  if (seedKnown && !seeds) out.notes.push('нет сидов');

  // Размер: у «1080p» на полтора гигабайта или 720p на пять терабайт что-то не так
  let sizePts = 3;
  if (bytes) {
    const gb = bytes / 1e9;
    const lo = { '4K': 8, '1080p': 1.2, '720p': 0.5, 'SD': 0.3 }[out.res];
    const hi = { '4K': 120, '1080p': 80, '720p': 25, 'SD': 12 }[out.res];
    if (lo && gb < lo) { sizePts = 0; out.notes.push('размер мал для ' + out.res); }
    else if (hi && gb > hi) { sizePts = 1; out.notes.push('очень большой'); }
    else sizePts = 5;
  }

  let score = resPts + srcPts + seedPts + ruPts + extra + sizePts;
  if (out.bad) score = Math.min(score, 15);
  if (seedKnown && !seeds) score = Math.min(score, 30);
  out.score = Math.max(0, Math.min(100, Math.round(score)));
  out.tier = out.score >= 75 ? 'good' : out.score >= 50 ? 'ok' : 'low';
  return out;
}
function rateTip(q) {
  const parts = [];
  if (q.res) parts.push(q.res);
  if (q.source) parts.push(q.source);
  if (q.codec) parts.push(q.codec);
  if (q.hdr) parts.push(q.hdr);
  parts.push(q.audio ? 'звук: ' + q.audio : 'русская дорожка не указана');
  return 'Оценка по названию: ' + q.score + '/100 · ' + parts.join(' · ') + (q.notes.length ? ' · ' + q.notes.join(', ') : '');
}
// playVerdict по потокам ffprobe говорит, сыграет ли файл в окне программы, а
// если нет — почему и что делать. Честнее, чем ждать ошибку <video>.
function playVerdict(j) {
  const streams = (j && j.streams) || [];
  const v = streams.find(s => s.codec_type === 'video');
  const audio = streams.filter(s => s.codec_type === 'audio');
  const langs = audio.map(a => ((a.tags && (a.tags.language || a.tags.LANGUAGE)) || '').toLowerCase());
  const hasRu = langs.some(l => l === 'rus' || l === 'ru');
  const vOk = !v || /^(h264|vp8|vp9|av1)$/i.test(v.codec_name || '');
  const aOk = audio.length === 0 || audio.some(a => /^(aac|mp3|opus|vorbis|flac)$/i.test(a.codec_name || ''));
  const problems = [];
  if (!vOk) problems.push('видео ' + String(v.codec_name).toUpperCase() + ' не поддерживается браузером');
  if (!aOk) problems.push('звук ' + audio.map(a => String(a.codec_name).toUpperCase()).join('/') + ' не поддерживается браузером');
  return {
    ok: problems.length === 0,
    ru: hasRu,
    problems,
    text: problems.length
      ? 'В окне программы может не играть: ' + problems.join('; ') + '. Откройте во внешнем плеере.'
      : 'Кодеки подходят для воспроизведения в окне программы.',
  };
}
/* QUALITY-END */

/* libQuality — оценка раздачи в библиотеке: качество по названию и размеру,
   без сидов (в библиотеке это снимок, а не свойство раздачи). */
function libQuality(t) {
  const title = (t && (t.title || t.name)) || '';
  /* У аниме и многосерийных мультфильмов название раздачи часто без
     пометок: «Наруто [1-220 из 220]». Разрешение и источник там стоят в
     именах файлов — «[SubsPlease] Frieren - 01 (1080p).mkv». Без них оценка
     не показывалась вовсе. Имя торрента (name) и первый видеофайл дописываются
     к названию, а размер берётся на серию: 80 ГБ на сезон в 1080p — норма,
     а не «очень большой». */
  const files = ((t && t.file_stats) || []).filter(f => isVideo(f.path));
  const extra = [];
  if (t && t.name && t.name !== title) extra.push(t.name);
  if (files.length) extra.push(basename(files[0].path).replace(/[._]+/g, ' '));
  const probe = rateRelease({ title });
  const full = probe.res && probe.source ? title : [title].concat(extra).join(' ');
  const per = files.length > 1 && t.torrent_size ? t.torrent_size / files.length : t && t.torrent_size;
  const q = rateRelease({ title: full, size_bytes: per });
  const bits = [q.source, q.codec, q.hdr, q.audio].filter(Boolean);
  if (files.length > 1) bits.push(files.length + ' ' + plural(files.length, 'файл', 'файла', 'файлов'));
  return { q, line: bits.join(' · '), tip: rateTip(q) + (full !== title ? ' · учтены имена файлов' : '') };
}

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
    act('[data-act="card"]', () => openMovie(Object.assign(fromRelease(t), { poster: t.poster || '' })));
    act('[data-act="drop"]', () => dropTorrent(t));
    act('[data-del]', () => dropTorrent(t));
    act('[data-act="autoposter"]', () => autoPoster(t));
    // Подписка ведётся по названию сериала, а не по раздаче: сезон выходит
    // новыми раздачами, и следить за одной из них нечем.
    act('[data-act="subs"]', () => subsAdd(subsName(t.title || t.name || '')));
    act('[data-act="bm"]', () => { const f = firstPlayable(t); if (!f) return toast('Нет воспроизводимых файлов', true); addBookmark(t, f.id, basename(f.path)); });
    act('[data-act="coll"]', () => openCollectionPicker(t));
    act('[data-act="send"]', () => { const vids = playableOf(t).filter(x => isVideo(x.path)); const f = vids.find(x => currentTc(t, x.id) > 0 && !isWatched(t, x.id)) || (vids.length ? nextEpisode(t, vids) : firstPlayable(t)); if (!f) return toast('Нет воспроизводимых файлов', true); sendToDevice(t, f); });
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
    if (metaErrText(j.error)) return toast(metaErrText(j.error), true);
    return toast('В TMDB не нашлось «' + c.q + (c.year ? ' (' + c.year + ')' : '') + '». Поправьте название через «Изменить» — и попробуйте снова', true);
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

/* openCollectionPicker — окно «в какие подборки положить раздачу».
   Одна раздача может лежать в нескольких подборках, поэтому это не выбор
   одного значения, а набор отметок. Удалить подборку можно тут же: отдельной
   страницы ради трёх списков делать незачем. */
function openCollectionPicker(t) {
  const list = collList();
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal">
    <button class="modal-close" data-close>✕</button>
    <h2>В подборку</h2>
    <div class="page-sub">${t.title || t.name || ''}</div>
    <div id="collPick">${raw(list.length
      ? list.map(c => html`<div class="row"><label style="flex:1"><input type="checkbox" data-coll="${c.id}"${collHas(c.id, t.hash) ? ' checked' : ''}> ${c.name}</label><button class="iconbtn" data-cdel="${c.id}" title="Удалить подборку">✕</button></div>`).join('')
      : '<div class="empty">Подборок пока нет — создайте первую ниже.</div>')}</div>
    <div class="divider"></div>
    <label>Новая подборка</label>
    <div class="row">
      <input id="collNewName" placeholder="Например: смотреть вечером" style="flex:1">
      <button id="collNewGo">Создать</button>
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end">
      <button data-close>Готово</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-coll]').forEach(cb => cb.addEventListener('change', () => {
    const added = collToggle(cb.dataset.coll, t.hash);
    toast(added ? 'Добавлено в подборку' : 'Убрано из подборки');
    fillCollSelect($('#libColl'), state.coll);
    if (state.coll) paintLibrary();
  }));
  ov.querySelectorAll('[data-cdel]').forEach(b => b.addEventListener('click', () => {
    const c = collById(b.dataset.cdel);
    if (!c) return;
    const snap = localStorage.getItem(COLLS_KEY);
    collRemove(b.dataset.cdel);
    fillCollSelect($('#libColl'), state.coll);
    close();
    paintLibrary();
    toastUndo('Подборка «' + c.name + '» удалена · раздачи остались в библиотеке', () => {
      try { localStorage.setItem(COLLS_KEY, snap || '[]'); } catch {}
      syncUserData(); fillCollSelect($('#libColl'), state.coll); if (state.view === 'library') paintLibrary();
    });
  }));
  ov.querySelector('#collNewGo').addEventListener('click', () => {
    const name = (ov.querySelector('#collNewName').value || '').trim();
    if (!name) return toast('Введите название подборки', true);
    const id = collCreate(name);
    collToggle(id, t.hash);
    fillCollSelect($('#libColl'), state.coll);
    close();
    toast('Подборка создана, раздача в ней');
    paintLibrary();
  });
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

/* dropTorrent убирает раздачу без окна подтверждения: плитка исчезает сразу,
   а сервер получает команду только когда уведомление «Вернуть» истекло. Нажали
   «Вернуть» — ничего с сервера не пропадало, плитка встаёт на место. */
// Раздачи, ожидающие удаления: список с сервера их пока скрывает.
const pendingDrop = new Set();
async function dropTorrent(t) {
  const at = state.lib.indexOf(t);
  if (at < 0) return;
  state.lib.splice(at, 1);
  pendingDrop.add(t.hash);
  if (state.view === 'library') paintLibrary();
  const name = cleanSearchTitle(t.title || t.name || '').q || t.title || t.name || 'Торрент';
  toastUndo('Удалено · ' + (name.length > 48 ? name.slice(0, 47) + '…' : name), () => {
    pendingDrop.delete(t.hash);
    if (!state.lib.includes(t)) state.lib.splice(Math.min(at, state.lib.length), 0, t);
    if (state.view === 'library') paintLibrary(); else if (state.view === 'home') paintHome();
  }, async () => {
    try { await torrentAction('rem', { hash: t.hash }); delete statCache[t.hash]; }
    catch (e) { toast('Не удалось удалить на сервере: ' + e.message, true); }
    pendingDrop.delete(t.hash);
    refreshLibrary();
  });
  if (state.view === 'home') paintHome();
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
    // Кнопка гасится на время запроса: без этого второе нажатие уходило вторым
    // запросом, а окно закрывалось только по ответу первого — и «сохранил, но
    // ничего не изменилось» выглядело как потеря правки.
    const go = ov.querySelector('#edGo');
    go.disabled = true;
    try {
      await torrentAction('set', { hash: t.hash, title: title, category: ov.querySelector('#edCat').value, poster: poster });
      // TorrServer поле poster не хранит, поэтому введённый вручную адрес
      // запоминается отдельно — иначе он пропадал бы при первой же перезагрузке
      // списка (loadLibrary заменяет state.lib новым массивом).
      const c = cleanSearchTitle(title || t.title || t.name || '');
      if (poster) rememberPoster(c, poster); else forgetPoster(c);
      ov.remove(); refreshLibrary();
    } catch (e) {
      toast('Не сохранилось: ' + e.message, true);
      go.disabled = false;
    }
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
        ${raw(isSeries(t.title || '') ? html`<span class="chip series">${seriesTag(t.title || '')}</span>` : '')}
        ${raw(t.bit_rate ? html`<span class="chip">${t.bit_rate}</span>` : '')}
      </div></div>
      ${raw(t.poster ? html`<img src="${pimg(t.poster)}" style="height:110px; border-radius:8px" onerror="this.remove()">` : '')}
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
    const pv = playVerdict(j);
    const fileDura = t.file_stats_rev ? (t.file_stats_rev[vf.id] && t.file_stats_rev[vf.id].length) : '';
    el.innerHTML = html`<div class="stat-line">
      <div><b>Контейнер:</b> ${fmt.format_name || ''} · ${fmt.format_long_name || ''}</div>
      <div><b>Длительность:</b> ${fmt.duration ? fmtDur(parseFloat(fmt.duration)) : ''}</div>
      <div><b>Размер:</b> ${fmt.size ? fmtSize(parseInt(fmt.size)) : ''}</div>
      ${raw(t.bit_rate ? html`<div><b>Битрейт:</b> ${t.bit_rate}</div>` : '')}
      <div class="divider"></div>${raw(streams || '—')}
      <div class="divider"></div>
      <div class="${pv.ok ? '' : 'hint'}"><b>${pv.ok ? '✔' : '⚠'}</b> ${pv.text}${pv.ru ? ' Русская дорожка есть.' : ''}</div>
    </div>`;
  } catch (e) { el.innerHTML = html`<div class="empty">Не удалось проанализировать (возможно, ffmpeg недоступен на сервере): ${e.message}</div>`; }
}

/* ================= FAVORITES + BOOKMARKS ================= */
function favList() { try { const a = JSON.parse(localStorage.getItem('tc_userlist') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveFavList(l) { try { localStorage.setItem('tc_userlist', JSON.stringify(l)); } catch {} syncUserData(); }
function getBookmarks() { try { const a = JSON.parse(localStorage.getItem('tc_bm') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveBookmarks(l) { try { localStorage.setItem('tc_bm', JSON.stringify(l)); } catch {} syncUserData(); }
function userDataPayload() {
  let fav = [], bm = [], colls = [];
  try { fav = JSON.parse(localStorage.getItem('tc_userlist') || '[]'); } catch {}
  try { bm = JSON.parse(localStorage.getItem('tc_bm') || '[]'); } catch {}
  try { colls = JSON.parse(localStorage.getItem(COLLS_KEY) || '[]'); } catch {}
  return {
    favorites: Array.isArray(fav) ? fav : [],
    bookmarks: Array.isArray(bm) ? bm : [],
    collections: Array.isArray(colls) ? colls : [],
  };
}
function syncUserData() { fetch('/api/userdata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(userDataPayload()) }).catch(() => {}); }
async function loadUserData() {
  try {
    const j = await api('/api/userdata');
    /* Склад рядом с демоном — источник правды, но только если в него хоть раз
       писали: у свежей сборки он пуст, и «на сервере пусто» означало бы
       стирание списка, накопленного в браузере до первого сохранения. Прежде
       пустой серверный список просто игнорировался, поэтому удалённое в одном
       браузере возвращалось из другого: устаревшее локальное всегда побеждало. */
    if (!j.stored) {
      if (favList().length || getBookmarks().length || collList().length) syncUserData();
      return;
    }
    localStorage.setItem('tc_userlist', JSON.stringify(Array.isArray(j.favorites) ? j.favorites : []));
    localStorage.setItem('tc_bm', JSON.stringify(Array.isArray(j.bookmarks) ? j.bookmarks : []));
    // Подборки, как и избранное, лежат на сервере: они переживают переустановку
    // браузера и едут в архив состояния вместе с остальным.
    localStorage.setItem(COLLS_KEY, JSON.stringify(Array.isArray(j.collections) ? j.collections : []));
  } catch {}
}

/* ---------- подборки ----------
   Подборка — именованный список раздач. Ими заменяется единственное
   «Избранное»: одного списка мало, когда библиотека на сотни раздач, а
   переименовать или разложить по полкам его было нельзя.

   В списке хранятся хеши: сама раздача живёт на сервере, и дублировать её
   описание в подборке незачем — название и постер берутся из библиотеки. Хеш
   переживает переименование раздачи, а вот название раздачи — нет. */
const COLLS_KEY = 'tc_colls';

function collList() {
  try {
    const a = JSON.parse(localStorage.getItem(COLLS_KEY) || '[]');
    return Array.isArray(a) ? a.filter(c => c && typeof c === 'object' && c.id) : [];
  } catch { return []; }
}
function saveCollList(l) { try { localStorage.setItem(COLLS_KEY, JSON.stringify(l)); } catch {} syncUserData(); }
function collById(id) { return collList().find(c => c.id === id) || null; }
function collHas(id, hash) { const c = collById(id); return !!(c && (c.items || []).indexOf(hash) >= 0); }
function collCreate(name) {
  const list = collList();
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  list.push({ id, name: String(name || 'Подборка').slice(0, 60), items: [] });
  saveCollList(list);
  return id;
}
// Возвращает признак «теперь в подборке»: по нему интерфейс говорит, что
// добавлено, а что убрано, — не переспрашивая список заново.
function collToggle(id, hash) {
  const list = collList();
  const c = list.find(x => x.id === id);
  if (!c) return false;
  const items = Array.isArray(c.items) ? c.items : [];
  const at = items.indexOf(hash);
  if (at >= 0) { items.splice(at, 1); c.items = items; saveCollList(list); return false; }
  c.items = items.concat([hash]);
  saveCollList(list);
  return true;
}
function collRemove(id) {
  const list = collList().filter(c => c.id !== id);
  saveCollList(list);
  if (state.coll === id) state.coll = '';
}

/* watchState — состояние просмотра раздачи: не начато, начато, досмотрено.
   Считается по видеофайлам: у сериала «досмотрено» означает все серии, одна
   начатая серия делает раздачу начатой. Нет известных файлов (статистика ещё не
   подгружена) — раздача считается не начатой, а не пропадает из выдачи. */
function watchState(t) {
  const vids = playableOf(t).filter(f => isVideo(f.path));
  if (!vids.length) return 'new';
  const done = vids.filter(f => isWatched(t, f.id)).length;
  if (done >= vids.length) return 'done';
  if (done > 0 || vids.some(f => viewedShare(t, f.id) > 0)) return 'started';
  return 'new';
}
// Доля просмотренного: у сериала — по сериям, у фильма — по первому файлу.
function libProgress(t) {
  const sp = seriesProgress(t);
  if (sp) return sp.share;
  const f = playableOf(t).filter(x => isVideo(x.path))[0];
  return f ? viewedShare(t, f.id) : 0;
}
/* Отметка одного файла. Досмотр и позиция — разные вещи: у досмотренной серии
   позиция обнуляется, поэтому «просмотрено» определяется признаком done, а не
   положительным временем. По времени досмотренная серия выглядела непросмотренной. */
/* marksIndex — те же отметки, разложенные по хешу раздачи. Строится по
   требованию и живёт до первого изменения отметок.

   Прежде поиск шёл по всему массиву на каждый файл: плитка сериала спрашивает
   про каждый файл дважды (досмотр и позиция), то есть 200 раздач × 100 файлов ×
   500 отметок давали на каждую перерисовку миллионы сравнений. Перерисовка же
   идёт на каждый ввод буквы в фильтре и на каждое событие positions. Индекс
   строится один раз за весь проход — столько же работы, сколько один поиск. */
let marksIndex = null;
let marksIndexArr = null;
let marksIndexLen = -1;

/* Сброс нужен ровно там, где запись отметки заменяется на месте новым объектом
   (так приходит событие positions): смену самого массива и его рост индекс
   замечает сам, и вызывать сброс из каждого места не требуется — забытый сброс
   означал бы устаревшие отметки на экране. */
function invalidateMarks() { marksIndex = null; }
function marksFor(hash) {
  const arr = state.viewed || [];
  if (!marksIndex || marksIndexArr !== arr || marksIndexLen !== arr.length) {
    marksIndex = {};
    marksIndexArr = arr;
    marksIndexLen = arr.length;
    arr.forEach(v => {
      if (!v) return;
      let m = marksIndex[v.hash];
      if (!m) m = marksIndex[v.hash] = {};
      m[v.file_index] = v;
    });
  }
  return marksIndex[hash] || null;
}
function markOf(t, fi) { const m = marksFor(t.hash); return (m && m[fi]) || null; }
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
  notePlayed(hash, fi);
}
/* Когда раздачу запускали в последний раз. Отметка демона обновляется, только
   пока плеер сообщает позицию; раздача, запущенная в плеере без канала, с
   телефона или из списка TorrServer, шла с нулевым временем в самый конец
   «Продолжить просмотр» — хотя её открыли только что. */
const LASTPLAY_KEY = 'tc_lastplay';
function lastPlayed() { try { const o = JSON.parse(localStorage.getItem(LASTPLAY_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function notePlayed(hash, fi) {
  if (!hash) return;
  const o = lastPlayed();
  o[hash] = { at: Date.now(), fi: fi | 0 };
  // Хранится только свежее: сотня записей с запасом покрывает полосу.
  const keep = Object.entries(o).sort((a, b) => b[1].at - a[1].at).slice(0, 100);
  try { localStorage.setItem(LASTPLAY_KEY, JSON.stringify(Object.fromEntries(keep))); } catch {}
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
// В избранном лежат два вида записей: раздача (магнит) и «название» — карточка
// из «Сейчас смотрят» / «Для вас», у которой раздачи ещё нет. Для названия
// раздача подбирается в момент просмотра (★ Лучшая раздача по всем источникам).
const isTitleFav = x => !!x && x.fav === 'title';
function favSame(a, b) {
  if (isTitleFav(a) || isTitleFav(b)) return isTitleFav(a) && isTitleFav(b) && a.kind === b.kind && String(a.tmdb) === String(b.tmdb);
  return (a.hash || '') + '|' + (a.title || '') === (b.hash || '') + '|' + (b.title || '');
}
const discFavKey = it => it.kind + ':' + it.id;
function discFavHtml(it) {
  const on = favList().some(x => isTitleFav(x) && x.kind + ':' + x.tmdb === discFavKey(it));
  return html`<button class="disc-fav${on ? ' on' : ''}" data-fk="${discFavKey(it)}" title="${on ? 'Убрать из избранного' : 'В избранное'}">♥</button>`;
}
function markDiscFavs() {
  const keys = new Set(favList().filter(isTitleFav).map(x => x.kind + ':' + x.tmdb));
  $$('.disc-fav').forEach(b => { const on = keys.has(b.dataset.fk); b.classList.toggle('on', on); b.title = on ? 'Убрать из избранного' : 'В избранное'; });
}
function toggleDiscFav(it) {
  if (!it) return;
  const ul = favList();
  const i = ul.findIndex(x => isTitleFav(x) && x.kind + ':' + x.tmdb === discFavKey(it));
  if (i >= 0) { ul.splice(i, 1); toast('Удалено из избранного'); }
  else { ul.push({ fav: 'title', title: it.title, year: it.year || '', kind: it.kind, tmdb: it.id, poster: it.poster || '', time: Date.now() }); toast('Добавлено в избранное'); }
  saveFavList(ul);
  markDiscFavs();
}
async function renderFavorites(root) {
  const list = favList();
  root.innerHTML = `<div class="toolbar"><h1 class="page-title">Избранное</h1>
    <div class="page-sub">Раздачи и названия, отложенные в поиске и в «Сейчас смотрят» · кнопка «♥»</div>
    <span class="spacer"></span>
    <button id="favClear" class="danger">Очистить список</button></div>
    <div id="favBody"></div>`;
  $('#favClear').addEventListener('click', () => {
    if (!list.length) return;
    const snap = favList();
    saveFavList([]); renderFavorites($('main'));
    toastUndo('Избранное очищено · ' + snap.length, () => { saveFavList(snap); if (state.view === 'favorites') renderFavorites($('main')); });
  });
  const body = $('#favBody');
  if (!list.length) { body.innerHTML = '<div class="empty">Пусто. Нажмите ♥ на карточке в «Сейчас смотрят» или «Ещё → В избранное» в результатах поиска.</div>'; return; }
  const sorted = [...list].sort((a, b) => (b.time || 0) - (a.time || 0));
  body.innerHTML = '<div class="grid results">' + sorted.map((it, i) => favCard(it, i)).join('') + '</div>';
  $$('.tile.fav', body).forEach(card => bindFavCard(card, sorted[parseInt(card.dataset.ix, 10)]));
  favEnrich(sorted);
}
function favCard(it, ix) {
  const title = it.title || 'магнит';
  const isT = isTitleFav(it);
  return html`
  <div class="tile result fav" data-ix="${ix}">
    <div class="result-poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (it.poster ? 'hidden' : '') + '"'))}
      ${raw(it.poster ? html`<img src="${pimg(it.poster)}" loading="lazy" onerror="var p=this.parentElement;this.remove();p.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-fa="play" title="${isT ? 'Подобрать лучшую раздачу' : 'Смотреть'}"><span class="tri"></span></button>
      <div class="badges"><span class="chip grey">${isT ? 'название' : 'избранное'}</span></div>
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
        <span class="mb-stats">${isT ? (it.kind === 'tv' ? 'Сериал · ' : '') + (it.year || '') + ' · ' : ''}${it.time ? 'добавлено ' + new Date(it.time).toLocaleDateString('ru-RU') : '—'}</span>
      </div>
      <button class="menu-ico" data-menu title="Ещё" aria-label="Ещё">${raw(ico('more', 18))}</button>
    </div>
    <div class="ctxmenu hidden">
      ${raw(isT ? '' : '<button data-fa="magnet">Магнит-ссылка</button>')}
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
  act('[data-fa="play"]', () => { if (isTitleFav(it)) openMovie({ title: it.title, year: it.year, kind: it.kind, tmdb: it.tmdb, poster: it.poster }); else playSearchLink(it); });
  act('[data-fa="magnet"]', () => copyToClip(it.magnet || magnetFromHash(it.hash, it.title), 'Магнит скопирован'));
  act('[data-fa="kp"]', () => openExternal(kpSearchUrl(it.title || '')));
  act('[data-fa="imdb"]', () => openExternal(imdbUrlFor(it)));
  act('[data-fa="trailer"]', () => openTrailer(it));
  act('[data-fa="del"]', () => {
    const snap = favList();
    saveFavList(snap.filter(x => !favSame(x, it))); renderFavorites($('main'));
    toastUndo('Удалено из избранного', () => { saveFavList(snap); if (state.view === 'favorites') renderFavorites($('main')); });
  });
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
          if (el) { const svg = el.querySelector('svg'); if (svg) svg.classList.add('hidden'); el.insertAdjacentHTML('beforeend', html`<img src="${pimg(j.poster)}" loading="lazy" onerror="this.remove()">`); }
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
    <div class="page-sub">Позиции, которые плееры не запоминают. Сохраняются в карточке торрента («Ещё → Закладка») или в окне «Инфо».</div>
    <span class="spacer"></span>
    <button id="bmClear" class="danger">Очистить</button></div>
    <div id="bmBody"></div>`;
  $('#bmClear').addEventListener('click', () => {
    if (!list.length) return;
    const snap = getBookmarks();
    saveBookmarks([]); renderBookmarks($('main'));
    toastUndo('Закладки удалены · ' + snap.length, () => { saveBookmarks(snap); if (state.view === 'bookmarks') renderBookmarks($('main')); });
  });
  const body = $('#bmBody');
  if (!list.length) { body.innerHTML = '<div class="empty">Закладок пока нет.</div>'; return; }
  // Список читается только для этой страницы и НЕ подменяет общий: у TorrServer
  // отметка означает «файл тронут», позиции в ней нет вовсе, а общий список
  // ведёт демон — он один знает время. Подмена затирала бы позиции всех раздач
  // после простого открытия «Закладок».
  let viewed = []; try { viewed = await tsJson('/viewed', { action: 'list' }); } catch {}
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
      ${raw(b.poster ? html`<img src="${pimg(b.poster)}" loading="lazy" onerror="var p=this.parentElement;this.remove();p.querySelector('svg').classList.remove('hidden')">` : '')}
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
      <button class="menu-ico" data-menu title="Ещё" aria-label="Ещё">${raw(ico('more', 18))}</button>
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
  act('[data-bm="del"]', () => {
    const snap = getBookmarks();
    delBookmark(b); renderBookmarks($('main'));
    toastUndo('Закладка удалена', () => { saveBookmarks(snap); if (state.view === 'bookmarks') renderBookmarks($('main')); });
  });
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
const SRC_PAGE = { rutor: 100, kinozal: 50, torznab: 100, popular: 1 };
function hasMore() {
  return Object.entries(moreSources).some(([p, s]) => s.count >= (SRC_PAGE[p] || 0));
}

async function renderSearch(root) {
  const sd = state.searchState;
  const hist = searchHistory();
  root.innerHTML = html`
    <div class="search-hero">
      <h1 class="page-title">Поиск раздач</h1>
      <div class="search-box">
        <span class="sb-ico">${raw(ico('search', 20))}</span>
        <input id="searchInput" list="searchHistList" autocomplete="off" placeholder="Название фильма или сериала — можно с годом, «-слово» исключает" title="/ — сюда, Ctrl+K — палитра, ? — все клавиши" value="${sd.q}">
        <button id="searchClear" class="sb-clear${sd.q ? '' : ' hidden'}" type="button" title="Очистить запрос (Esc)" aria-label="Очистить запрос">${raw(ico('x', 16))}</button>
        <datalist id="searchHistList">${raw(searchHistoryAll().map(h => html`<option value="${h}">`).join(''))}</datalist>
        <button id="bestBtn" title="Опросить все источники и выбрать лучшую раздачу по запросу">${raw(ico('star', 16))}<span>Лучшая</span></button>
        <button id="searchBtn" class="primary">Найти</button>
      </div>
      <div class="filterbar compact">
        <select id="searchProv" title="Источник">
          <option value="rutor">rutor</option>
          <option value="torznab">Torznab</option>
          <option value="kinozal">Кинозал.ТВ</option>
          <option value="both">Все источники</option>
        </select>
        <select id="searchCat" title="Категория">
          ${raw(CATS.map(c => html`<option value="${c.v}">${c.label}</option>`).join(''))}
        </select>
        <select id="searchQual" title="Качество раздачи">
          ${raw(Object.entries(QUAL).map(([v, q]) => html`<option value="${v}">${q.label}</option>`).join(''))}
        </select>
        <label class="check" title="Прятать из выдачи игры, софт и книги"><input type="checkbox" id="searchVid"> только видео</label>
        <label class="check" title="Новая выдача добавится к текущей, а не заменит её"><input type="checkbox" id="searchAppend"> добавить к текущим</label>
        <label class="check" title="Нашёлся фильм или сериал с таким названием — сразу открыть его карточку с раздачами"><input type="checkbox" id="searchCard"> сразу карточка</label>
      </div>
    </div>
    <div class="quick collections">
      <button id="top24Btn" class="top24btn">ТОП-24</button>
      <button id="popBtn" class="top24btn pop" title="Раздачи выбранной категории за всё время, по числу сидов (rutor или индексаторы)">${raw(ico('film', 16))}Популярное</button>
      <button id="recBtn" title="Похожее на фильмы и сериалы из вашей библиотеки (нужен ключ TMDB)">${raw(ico('sparkles', 16))}Для вас</button>
      <span class="q-sep"></span>
      ${raw(CATS.filter(c => c.v).slice(0, 5).map(c => html`<button class="cat" data-cat="${c.v}">${c.label}</button>`).join(''))}
    </div>
    ${raw(hist.length ? html`<div class="quick"><span class="qlabel">История:</span>${raw(hist.map(h => html`<span class="hq-chip"><button data-hq="${h}">${h}</button><button class="hq-x" data-hqx="${h}" title="Удалить из истории">×</button></span>`).join(''))}<button id="hqClear" class="hq-x" title="Очистить историю">очистить</button></div>` : '')}
    <div class="quick" id="discBar">
      <span class="qlabel">Топ за всё время:</span>
      <select id="dKind" style="width:auto"><option value="trending">🔥 Сейчас смотрят (неделя)</option><option value="trending_day">🔥 Сейчас смотрят (сегодня)</option><option value="movie" selected>Фильмы</option><option value="tv">Сериалы</option><option value="anime">Аниме</option><option value="cartoon">Мультфильмы</option><option value="doc">Документальное</option></select>
      <select id="dOrigin" style="width:auto"><option value="foreign">Зарубежное</option><option value="any">Любое</option><option value="ru">Русское</option></select>
      <select id="dGenre" style="width:auto"></select>
      <button id="dGo" title="Самое популярное по числу голосов TMDB. Нужен ключ TMDB">Показать</button>
    </div>
    <div id="searchTitle"></div>
    <div id="searchResults"></div>`;

  initDiscoverBar();
  $('#searchProv').value = sd.provider;
  loadRutorFlag();
  $('#searchCat').value = sd.cat || '';
  $('#searchQual').value = qualOn();
  $('#searchBtn').addEventListener('click', () => doSearch());
  $('#recBtn').addEventListener('click', () => showRecommendations());
  $('#bestBtn').addEventListener('click', () => { const q = $('#searchInput').value.trim(); if (q) { pushSearchHistory(q); findBest(q, 0); } else toast('Введите название'); });
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
    else if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); clearSearchQuery(); }
  });
  /* Крестик в поле: общий addClears ставится только полям-фильтрам
     (.search-input), а у главного поиска своя рамка — крестика не было. */
  $('#searchInput').addEventListener('input', e => { const c = $('#searchClear'); if (c) c.classList.toggle('hidden', !e.target.value); });
  $('#searchClear').addEventListener('mousedown', e => e.preventDefault());
  $('#searchClear').addEventListener('click', clearSearchQuery);
  { const sc = $('#searchCard'); sc.checked = searchCardPref(); sc.addEventListener('change', () => savePref('tc_scard', sc.checked ? '1' : '0')); }
  paintSearchTitle();
  // Источник и категория запоминаются: после перезапуска поиск шёл снова по
  // rutor, и выбор «Все источники» приходилось делать каждый раз.
  $('#searchProv').addEventListener('change', () => { sd.provider = $('#searchProv').value; savePref('tc_prov', sd.provider); });
  $('#searchCat').addEventListener('change', () => { sd.cat = $('#searchCat').value; savePref('tc_cat', sd.cat); sd.showAll = false; updateTopBtnLabel(); paintResults($('#searchResults')); });
  $('#searchQual').addEventListener('change', () => { setQual($('#searchQual').value); state.searchState.showAnyQual = false; paintResults($('#searchResults')); });
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
    savePref('tc_cat', b.dataset.cat);
    sd.cat = b.dataset.cat;
    updateTopBtnLabel();
    doSearch();
  }));
  $$('[data-hq]').forEach(b => b.addEventListener('click', () => { $('#searchInput').value = b.dataset.hq; doSearch(); }));
  $$('[data-hqx]').forEach(b => b.addEventListener('click', () => { dropSearchHistory(b.dataset.hqx); const c = b.closest('.hq-chip'); if (c) c.remove(); }));
  { const c = $('#hqClear'); if (c) c.addEventListener('click', () => { saveSearchHistory([]); const q = c.closest('.quick'); if (q) q.remove(); }); }
  $('#top24Btn').addEventListener('click', onTopClick);
  $('#popBtn').addEventListener('click', () => fetchPopular());
  updateTopBtnLabel();
  paintResults($('#searchResults'));
  // Раздел открыт ради рекомендаций — ТОП-24 не загружается поверх них.
  if (state.skipAutoTop) state.skipAutoTop = false;
  else if (!state.searchState.results.length && !sd.q) onTopClick();
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

// История поиска: хранится 30 запросов (для автодополнения), кнопками
// показываются последние 8. Запись можно удалить крестиком.
function clearSearchQuery() {
  const i = $('#searchInput'); if (!i) return;
  i.value = ''; state.searchState.q = ''; state.searchState.title = null;
  const c = $('#searchClear'); if (c) c.classList.add('hidden');
  paintSearchTitle();
  i.focus();
}
function searchCardPref() { return localStorage.getItem('tc_scard') !== '0'; }

/* Карточка названия над выдачей. Поиск «Дюна» искал только раздачи, и
   страницу фильма (описание, сезоны, ранжированные раздачи, избранное)
   приходилось открывать отдельным кликом по строке. Теперь параллельно с
   трекерами спрашивается TMDB: нашлось название — оно стоит первым, а при
   дословном совпадении и включённой «сразу карточка» открывается само. */
const tmdbNormJS = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/gi, '');
async function lookupSearchTitle(q, run) {
  const c = cleanSearchTitle(q);
  const qq = c.q || q;
  try {
    const j = await withTimeout(apiGetJSON('/api/tmdb?q=' + encodeURIComponent(qq) + (c.year ? '&year=' + c.year : '')), 5000, 'TMDB не ответил');
    if (searchRun !== run || !j || !j.ok || !j.title) return null;
    const it = { title: j.title, year: j.year ? String(j.year) : '', kind: j.type === 'tv' ? 'tv' : 'movie', tmdb: j.id, poster: j.poster || '', overview: j.overview || '', rating: j.rating || 0, imdb: j.imdb || 0 };
    it.exact = tmdbNormJS(it.title) === tmdbNormJS(qq);
    return it;
  } catch { return null; }
}
function paintSearchTitle() {
  const el = $('#searchTitle'); if (!el) return;
  const it = state.searchState.title;
  if (!it) { el.innerHTML = ''; return; }
  el.innerHTML = html`<div class="st-card" data-st-open tabindex="0" title="Открыть карточку: описание, сезоны, лучшие раздачи">
    <div class="st-poster">${raw(it.poster ? html`<img src="${pimg(it.poster)}" alt="" onerror="this.remove()">` : ico('film', 30))}</div>
    <div class="st-info">
      <div class="st-k">${it.kind === 'tv' ? 'Сериал' : 'Фильм'}${it.rating > 0 ? ' · TMDB ' + Number(it.rating).toFixed(1) : ''}</div>
      <div class="st-t">${it.title}${raw(it.year ? html` <span class="mv-year">${it.year}</span>` : '')}</div>
      <div class="st-o">${(it.overview || '').slice(0, 220)}${(it.overview || '').length > 220 ? '…' : ''}</div>
    </div>
    <button class="primary" data-st-open>${raw(ico('arrow', 15))}Открыть карточку</button>
  </div>`;
  const open = () => openMovie(it);
  el.querySelectorAll('[data-st-open]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); open(); }));
  el.firstElementChild.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
}
function searchHistoryAll() {
  try { const h = JSON.parse(localStorage.getItem('tc_sq') || '[]'); return Array.isArray(h) ? h.filter(x => typeof x === 'string').slice(0, 30) : []; } catch { return []; }
}
function searchHistory() { return searchHistoryAll().slice(0, 8); }
function saveSearchHistory(h) { try { localStorage.setItem('tc_sq', JSON.stringify(h.slice(0, 30))); } catch {} }
function pushSearchHistory(q) {
  if (!q) return;
  const h = searchHistoryAll().filter(x => x.toLowerCase() !== q.toLowerCase());
  h.unshift(q); saveSearchHistory(h);
}
function dropSearchHistory(q) { saveSearchHistory(searchHistoryAll().filter(x => x !== q)); }

async function fetchTop24() {
  const button = $('#top24Btn');
  const el = $('#searchResults');
  if (!button) return;
  button.disabled = true; button.textContent = 'Загрузка...';
  el.innerHTML = skeleton('Сбор ТОП-24 за последние 24 часа…');
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
  state.searchState.showAnyQual = false;
  moreSources = {};
  state.top24Hash = resp.hash || '';
  button.disabled = false; updateTopBtnLabel();
  if (resp.source === 'indexers' && !resp.rutor_off) toast('rutor не ответил — ТОП собран через индексаторы');
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
  state.searchState.showAnyQual = false;
  moreSources = {};
  state.top24Hash = '';
  button.disabled = false; updateTopBtnLabel();
  paintResults(el);
}
/* parseSizeBytes понимает и «1.46 GB», и «37,85 ГБ». Кинозал пишет единицы
   по-русски, а прежний разбор знал только латиницу: «37.85 ГБ» превращалось
   в 38 байт, и у раздач Кинозала стоял размер «38 Б», а сортировка по
   размеру ставила их в конец. */
const SIZE_MULT = { '': 1, B: 1, Б: 1, K: 1e3, КБ: 1e3, KB: 1e3, KIB: 1024, M: 1e6, MB: 1e6, МБ: 1e6, MIB: 1048576, G: 1e9, GB: 1e9, ГБ: 1e9, GIB: 1073741824, T: 1e12, TB: 1e12, ТБ: 1e12, TIB: 1099511627776 };
function parseSizeBytes(s) {
  if (s == null) return null;
  if (typeof s === 'number' && isFinite(s)) return s;
  const m = String(s).replace(/\u00a0/g, ' ').match(/(\d+(?:[.,]\d+)?)\s*([KMGT]i?B?|[КМГТ]Б|Б|B)?(?![a-zа-я])/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(n)) return null;
  const mult = SIZE_MULT[(m[2] || '').toUpperCase()];
  if (!m[2] && n < 1e4) return null; // голое «1» — не размер
  return mult ? Math.round(n * mult) : null;
}
function row2res(r, provider) {
  if (!r || !r.title) return null;
  const sizeBytes = parseSizeBytes(r.size) || 0;
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
  sd().showAnyQual = false; // и снова применяет выбранное качество
  sd().exclude = parts.drop; // «ведьмак -игра» отсекает игру по названию
  state.searchState.results = sd().append ? state.searchState.results : [];
  moreSources = {};
  if (prov === 'rutor' || (prov === 'both' && !state.rutorOff)) moreSources.rutor = { query: q, page: 0, count: 0, cat };
  if (prov === 'torznab' || prov === 'both') moreSources.torznab = { query: q, page: 0, count: 0, cat: 0 };
  if (prov === 'kinozal' || prov === 'both') moreSources.kinozal = { query: q, page: 0, count: 0, cat: 0 };
  paintResults($('#searchResults'));
  const el = $('#searchResults');
  el.innerHTML = skeleton('Поиск…');
  state.searchState.tznabOff = null;
  /* Поиск «по готовности»: каждый источник сам кладёт свои раздачи в выдачу и
     перерисовывает её, не дожидаясь остальных. Источник, который завис, отрезается
     по таймауту — выдача остаётся с тем, что успели ответить остальные. */
  const run = ++searchRun;
  const ss = state.searchState;
  ss.run = run;
  ss.title = null; paintSearchTitle();
  // Категория «Музыка», «Софт», «Игры» — названия фильма там не ищем.
  const videoCat = !cat || [1, 4, 5, 7, 10, 16].includes(cat);
  if (videoCat) lookupSearchTitle(q, run).then(it => {
    if (!it || ss.run !== run) return;
    ss.title = it;
    if (state.view !== 'search') return;
    paintSearchTitle();
    if (it.exact && !parts.drop.length && searchCardPref()) { pushSearchHistory(q); openMovie(it); }
  });
  ss.pending = {};
  const live = () => ss.run === run;
  const jobs = [];
  const errs = [];
  const SRC_NAME = { rutor: 'rutor', torznab: 'Torznab', kinozal: 'Кинозал' };
  const start = (p, make, ms) => {
    ss.pending[p] = SRC_NAME[p] || p;
    const ac = new AbortController();
    jobs.push(withTimeout(make(ac.signal), ms, SRC_NAME[p] + ' не ответил за ' + Math.round(ms / 1000) + ' с', () => ac.abort())
      .then(r => {
        if (!live()) return;
        if (r && r.length) ss.results = mergeResults(ss.results, r);
        else if (p !== 'torznab') errs.push(SRC_NAME[p] + ': 0 результатов');
      })
      .catch(e => {
        if (!live()) return;
        /* Torznab разбирает источники построчно, и причина там длиннее одной
           строки всплывающей подсказки, поэтому она уходит в разбор под списком,
           а не в toast. Для остальных источников поведение прежнее. */
        if (p === 'torznab') { ss.tznabOff = 'Torznab: ' + e.message; return; }
        const why = e.message.indexOf(SRC_NAME[p]) === 0 ? e.message : SRC_NAME[p] + ': ' + e.message;
        errs.push(why);
        toast(why, true);
      })
      .then(() => {
        if (!live()) return;
        delete ss.pending[p];
        ss.status = errs.slice();
        schedulePaintResults();
      }));
  };
  if (moreSources.rutor) start('rutor', sig => searchRutor(q, 0, cat, sig).then(r => { moreSources.rutor.count = r.length; return r; }), SEARCH_TIMEOUT);
  if (prov === 'torznab' || prov === 'both') start('torznab', sig => searchTorznabStream(q, el, sig).then(n => { moreSources.torznab.count = n; return []; }), SEARCH_TIMEOUT + 8000);
  if (moreSources.kinozal) start('kinozal', sig => searchKinozal(q, 0, sig).then(r => { moreSources.kinozal.count = r.length; return r; }), SEARCH_TIMEOUT);
  await Promise.all(jobs);
  if (!live()) return;
  ss.pending = {};
  ss.status = errs;
  pushSearchHistory(q);
  paintResults(el);
}
let searchRun = 0;
const SEARCH_TIMEOUT = 12000; // мс: дольше этого источник считается зависшим
/* withTimeout — как Promise.race с таймером. При срабатывании вызывает onTimeout
   (обрыв запроса), чтобы зависший ответ не копил соединения. */
function withTimeout(promise, ms, msg, onTimeout) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => { try { onTimeout && onTimeout(); } catch {} rej(new Error(msg)); }, ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
/* schedulePaintResults склеивает частые перерисовки: ответы источников могут
   прийти почти одновременно. */
let paintTimer = 0;
function schedulePaintResults() {
  if (paintTimer) return;
  paintTimer = setTimeout(() => { paintTimer = 0; if (state.view === 'search') paintResults($('#searchResults')); }, 120);
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

async function searchKinozal(q, page, signal) {
  const arr = await apiGetJSON('/api/kinozal/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0), signal);
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
async function apiGetJSON(url, signal) {
  const r = await fetch(url, signal ? { signal } : undefined);
  let body = null;
  try { body = await r.json(); } catch { /* тело не JSON — покажем код */ }
  if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
  return body;
}

async function searchRutor(q, page, cat, signal) {
  const arr = await apiGetJSON('/api/rutor/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0) + '&cat=' + (cat | 0), signal);
  if (!Array.isArray(arr)) throw new Error((arr && arr.error) || 'пустой ответ rutor');
  return mapRutorItems(arr);
}
function mapRutorItems(arr) {
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
      let next;
      if (p === 'popular') {
        const resp = await apiGetJSON('/api/popular?page=' + (s.page + 1) + '&cat=' + (s.cat | 0));
        next = mapRutorItems(resp && resp.items);
        s.page += 1;
        s.count = resp && resp.has_more ? 1 : 0;
        if (next.length) state.searchState.results = mergeResults(state.searchState.results, next);
        else s.count = 0;
        continue;
      }
      if (p === 'kinozal') next = await searchKinozal(s.query, s.page + 1);
      else if (p === 'torznab') next = await searchTorznab(s.query, s.page + 1);
      else next = await searchRutor(s.query, s.page + 1, s.cat);
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

// readTorznabStream читает поток ответов индексаторов: onSource вызывается на
// каждый ответивший источник (items — уже приведённые раздачи, bad — список тех,
// кто не ответил). Читается вручную: EventSource не умеет обрывать запрос.
// Возвращает {total, off}: сколько раздач получено и причину отказа всего потока.
async function readTorznabStream(q, signal, onSource) {
  const r = await fetch('/api/torznab/stream?query=' + encodeURIComponent(q), signal ? { signal } : undefined);
  if (!r.ok || !r.body) {
    let body = null;
    try { body = await r.json(); } catch { /* не JSON */ }
    return { total: 0, off: 'Torznab: ' + ((body && body.error) || ('HTTP ' + r.status)), bad: [] };
  }
  const bad = [];
  let total = 0;
  const onEvent = (name, data) => {
    if (name !== 'source' || !data) return;
    const rep = data.source || {};
    if (!rep.ok && rep.error) bad.push((rep.name || '?') + ' — ' + rep.error);
    const items = (data.items || []).map(mapTorznab);
    total += items.length;
    if (items.length || bad.length) onSource(items, bad);
  };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let name = 'message', dataLine = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      try { onEvent(name, JSON.parse(dataLine)); } catch { /* битый кадр пропускаем */ }
    }
  }
  return { total, off: bad.length ? 'Индексатор не ответил: ' + bad.join('; ') : null, bad };
}
// searchTorznabStream ищет по всем индексаторам сразу и рисует выдачу по мере
// ответов: медленный индексатор больше не задерживает быстрые. Возвращает число
// полученных раздач (нужно для «Показать ещё»).
async function searchTorznabStream(q, el, signal) {
  const ss = state.searchState;
  const res = await readTorznabStream(q, signal, (items, bad) => {
    if (items.length) ss.results = mergeResults(ss.results, items);
    ss.tznabOff = bad.length ? 'Индексатор не ответил: ' + bad.join('; ') : null;
    schedulePaintResults();
  });
  ss.tznabOff = res.off;
  return res.total;
}

// ---- Подборки TMDB: «самое популярное за всё время» по виду, жанру и происхождению ----
const DISC_GENRES = {
  movie: [['', 'Любой жанр'], [28, 'Боевик'], [12, 'Приключения'], [16, 'Мультфильм'], [35, 'Комедия'], [80, 'Криминал'], [99, 'Документальный'], [18, 'Драма'], [10751, 'Семейный'], [14, 'Фэнтези'], [36, 'История'], [27, 'Ужасы'], [10402, 'Музыка'], [9648, 'Детектив'], [10749, 'Мелодрама'], [878, 'Фантастика'], [53, 'Триллер'], [10752, 'Военный'], [37, 'Вестерн']],
  tv: [['', 'Любой жанр'], [10759, 'Боевик и приключения'], [16, 'Мультсериал'], [35, 'Комедия'], [80, 'Криминал'], [99, 'Документальный'], [18, 'Драма'], [10751, 'Семейный'], [10762, 'Детский'], [9648, 'Детектив'], [10765, 'Фантастика и фэнтези'], [10768, 'Война и политика'], [37, 'Вестерн'], [10764, 'Реалити']],
};
const discState = { items: [], page: 0, hasMore: false, params: null, busy: false };
const DISC_BATCH = 60;

/* Разделы «Аниме», «Мультфильмы», «Документальное» сами задают жанр, поэтому
   второй список у них выбирает не жанр, а вид: фильмы или сериалы. Аниме чаще
   смотрят сериалами, остальное — фильмами. У аниме нет выбора происхождения:
   оно японское по определению. */
const DISC_SECTIONS = { anime: 'tv', cartoon: 'movie', doc: 'movie', trending: 'movie', trending_day: 'movie' };
const isTrending = k => k === 'trending' || k === 'trending_day';
function fillDiscGenres() {
  const kind = $('#dKind').value;
  const sec = DISC_SECTIONS[kind];
  // В трендах второй список выбирает и аниме с мультфильмами: в общих
  // трендах TMDB их почти нет.
  $('#dGenre').innerHTML = sec
    ? html`<option value="tv">Сериалы</option><option value="movie">Фильмы</option>` + (isTrending(kind) ? html`<option value="anime">Аниме</option><option value="cartoon">Мультфильмы</option><option value="anime_movie">Аниме-фильмы</option>` : '')
    : DISC_GENRES[kind].map(g => html`<option value="${g[0]}">${g[1]}</option>`).join('');
  if (sec) $('#dGenre').value = sec;
  // «Сейчас смотрят» — тренды недели: подпись панели говорит об этом прямо.
  const lab = $('#discBar .qlabel');
  if (lab) lab.textContent = isTrending(kind) ? 'Сейчас смотрят:' : 'Топ за всё время:';
  const o = $('#dOrigin');
  if (o) {
    o.disabled = kind === 'anime'; o.classList.toggle('hidden', kind === 'anime');
    // В трендах «Зарубежное» по умолчанию выбрасывало всё русское, и выдача
    // выглядела урезанной. Здесь по умолчанию — всё подряд.
    if (isTrending(kind) && !o.dataset.touched) o.value = 'any';
    else if (!isTrending(kind) && !o.dataset.touched) o.value = 'foreign';
  }
}
/* discQuery — параметры запроса подборки по выбору в панели. */
function discQuery(p) {
  const sec = DISC_SECTIONS[p.kind];
  if (isTrending(p.kind) && (p.genre === 'anime' || p.genre === 'anime_movie')) return 'kind=' + (p.genre === 'anime' ? 'tv' : 'movie') + '&cat=trend_anime&origin=any';
  if (isTrending(p.kind) && p.genre === 'cartoon') return 'kind=movie&cat=trend_cartoon&origin=' + p.origin;
  if (sec) return 'kind=' + (p.genre === 'tv' ? 'tv' : 'movie') + '&cat=' + p.kind + '&origin=' + p.origin;
  return 'kind=' + p.kind + '&origin=' + p.origin + '&genre=' + encodeURIComponent(p.genre);
}
function initDiscoverBar() {
  if (!$('#dKind')) return;
  // Раздел, вид и происхождение подборки помнятся, как и источник поиска.
  const kinds = [...$('#dKind').options].map(o => o.value);
  $('#dKind').value = savedPref('tc_dkind', kinds, 'movie');
  const org = savedPref('tc_dorigin', ['foreign', 'any', 'ru'], '');
  if (org) { $('#dOrigin').value = org; $('#dOrigin').dataset.touched = '1'; }
  fillDiscGenres();
  const g = savedPref('tc_dgenre', null, '');
  if (g && [...$('#dGenre').options].some(o => o.value === g)) $('#dGenre').value = g;
  $('#dKind').addEventListener('change', () => { fillDiscGenres(); savePref('tc_dkind', $('#dKind').value); savePref('tc_dgenre', $('#dGenre').value); });
  $('#dGenre').addEventListener('change', () => savePref('tc_dgenre', $('#dGenre').value));
  $('#dOrigin').addEventListener('change', () => { $('#dOrigin').dataset.touched = '1'; savePref('tc_dorigin', $('#dOrigin').value); });
  $('#dGo').addEventListener('click', () => fetchDiscover(true));
}
async function fetchDiscover(reset) {
  const el = $('#searchResults');
  if (!el || discState.busy) return;
  if (reset) {
    discState.params = { kind: $('#dKind').value, origin: $('#dOrigin').value, genre: $('#dGenre').value };
    discState.items = []; discState.page = 0; discState.hasMore = false;
    el.innerHTML = skeleton('Собираю подборку…', 12, true);
  }
  const p = discState.params;
  if (!p) return;
  discState.busy = true;
  try {
    // За одно нажатие набирается не меньше DISC_BATCH карточек: страница TMDB —
    // двадцать названий, а после фильтра по происхождению бывает и две.
    // Пять страниц — предел, чтобы кнопка не превращалась в долгую загрузку.
    const want = discState.items.length + DISC_BATCH;
    for (let n = 0; n < 5; n++) {
      const url = '/api/discover?' + discQuery(p) + '&page=' + (discState.page + 1);
      const resp = await apiGetJSON(url);
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
      discState.page = resp.page;
      discState.hasMore = !!resp.has_more;
      const seen = new Set(discState.items.map(x => x.id + ':' + x.kind));
      for (const it of resp.items || []) if (!seen.has(it.id + ':' + it.kind)) discState.items.push(it);
      if (discState.items.length >= want || !discState.hasMore) break;
    }
  } catch (e) {
    discState.busy = false;
    if (reset && !discState.items.length) el.innerHTML = html`<div class="empty">Не удалось получить подборку: ${e.message}</div>`;
    else { toast(e.message, true); paintDiscover(el); }
    return;
  }
  discState.busy = false;
  paintDiscover(el);
}
function paintDiscover(el) {
  if (!discState.items.length) { el.innerHTML = '<div class="empty">В подборке пусто</div>'; return; }
  const cards = discState.items.map((it, i) => html`
    <div class="disc-card" data-di="${i}" title="Подобрать лучшую раздачу из всех источников">
      <div class="disc-poster">${raw(it.poster ? html`<img loading="lazy" src="${pimg(it.poster)}" alt="">` : '')}${raw(discFavHtml(it))}</div>
      <div class="disc-title">${it.title}</div>
      <div class="disc-meta">${it.kind === 'tv' ? 'Сериал · ' : ''}${it.year || ''}${it.rating ? ' · ★ ' + it.rating.toFixed(1) : ''}</div>
    </div>`).join('');
  el.innerHTML = html`<div class="disc-head">${discState.params && isTrending(discState.params.kind) ? (discState.params.kind === 'trending_day' ? 'Сейчас смотрят — тренды дня' : 'Сейчас смотрят — тренды недели') : 'Популярное за всё время'} (${discState.items.length})</div>
    <div class="disc-grid">${raw(cards)}</div>
    ${raw(discState.hasMore ? '<div style="text-align:center;margin:14px"><button id="discMore" class="primary">Показать ещё</button></div>' : '')}`;
  $$('.disc-fav', el).forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    toggleDiscFav(discState.items.find(x => discFavKey(x) === b.dataset.fk));
  }));
  $$('.disc-card').forEach(c => c.addEventListener('click', () => {
    const it = discState.items[+c.dataset.di];
    if (!it) return;
    openMovie({ title: it.title, year: it.year, kind: it.kind, tmdb: it.id, poster: it.poster, overview: it.overview, rating: it.rating });
  }));
  const more = $('#discMore');
  if (more) more.addEventListener('click', () => { more.disabled = true; more.textContent = 'Загрузка...'; fetchDiscover(false); });
}

// «Популярное за всё время»: раздачи категории rutor по числу сидов, страница
// за страницей. Догрузка идёт через общую кнопку «Показать ещё».
const POP_LABEL = 'Популярное за всё время';
async function fetchPopular() {
  const el = $('#searchResults');
  const btn = $('#popBtn');
  if (!el) return;
  const cat = rutorCat();
  if (btn) btn.disabled = true;
  el.innerHTML = skeleton('Собираю популярное за всё время…');
  try {
    const resp = await apiGetJSON('/api/popular?page=0&cat=' + (cat | 0));
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
    const items = mapRutorItems(resp.items);
    const ss = state.searchState;
    ss.results = items;
    ss.q = '';
    ss.topLabel = POP_LABEL;
    ss.showAnyQual = false;
    state.top24Hash = '';
    moreSources = { popular: { query: '', page: 0, count: resp.has_more ? 1 : 0, cat } };
  } catch (e) {
    el.innerHTML = html`<div class="empty">Не удалось получить популярное: ${e.message}</div>`;
    if (btn) btn.disabled = false;
    return;
  }
  if (btn) btn.disabled = false;
  paintResults(el);
}

async function searchTorznab(q, page) {
  /* Свой Torznab отдаёт не голый список, а разбор по индексаторам: упал ли
     какой-то из них и почему. Раньше эта причина терялась, и пустая выдача
     выглядела так же, как «все индексаторы молчат». */
  const env = await apiGetJSON('/api/torznab/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0));
  const arr = env && Array.isArray(env.items) ? env.items : [];
  if (env && Array.isArray(env.sources)) {
    const bad = env.sources.filter(s => !s.ok && s.error);
    if (bad.length) {
      const names = bad.map(s => s.name + ' — ' + s.error).join('; ');
      if (!arr.length) throw new Error(names);
      state.searchState.tznabOff = 'Индексатор не ответил: ' + names;
    }
  }
  return (arr || []).map(mapTorznab);
}

function mapTorznab(it) {
    const g = (a, b) => (it[a] != null ? it[a] : it[b]);
    return {
      _p: 'torznab', title: g('title', 'Title') || g('name', 'Name'), name: g('title', 'Title') || g('name', 'Name'),
      size: g('size', 'Size'), size_bytes: parseSizeBytes(g('size', 'Size')),
      seed: g('seed', 'Seed'), peer: g('peer', 'Peer'),
      magnet: g('magnet', 'Magnet'), hash: g('hash', 'Hash'), link: g('link', 'Link'),
      imdb_id: g('imdb', 'IMDB') || g('imdb_id', 'IMDBID'),
      categories: g('categories', 'Categories'),
      data: it,
    };
}

function paintResults(el) {
  const needProvider = el || $('#searchResults');
  const rows = state.searchState ? state.searchState.results : [];
  const qual = QUAL[qualOn()] || QUAL['fhd'];
  const status = state.searchState.status || [];
  const pend = Object.values(state.searchState.pending || {});
  if (!rows.length && pend.length) {
    if (needProvider) needProvider.innerHTML = skeleton('Ищем: ' + pend.join(', ') + '…');
    return;
  }
  if (!rows.length) {
    if (needProvider) needProvider.innerHTML = '<div class="empty">Нет результатов.' + (status.length ? '' : ' Проверьте индексаторы: Настройки → Torznab.') + '</div>'
      + (status.length ? html`<div class="hint" style="text-align:center;margin-top:8px">${status.join(' · ')}</div>` : '');
    return;
  }
  /* Фильтр качества включён по умолчанию, и на живом блоке суток он снимает
     несколько раздач: 720p и HDTVRip не 1080p. Раньше заголовок писал число
     уже отфильтрованных строк, из-за чего «ТОП-24 за последние 24 часа (24)»
     читалось как «трекер отдал двадцать четыре раздачи» — и человек искал
     ограничение там, где его нет. Теперь показываются оба числа, отсев
     называется своим фильтром, и его можно снять одной кнопкой. */
  const qualTotal = rows.length;
  const qualFilter = qualOn() && !(state.searchState && state.searchState.showAnyQual);
  let rows2 = qualFilter ? rows.filter(r => qual.ok(r.title || r.name || '')) : rows.slice();
  const hiddenQual = qualTotal - rows2.length;
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
    if (sort === 'quality') return rateRelease(b).score - rateRelease(a).score || (b.seed || 0) - (a.seed || 0);
    return (b.seed || 0) - (a.seed || 0);
  });
  const isTop = rows2.length && rows2.every(r => r.provider === 'top24' || r.provider === 'topcat');
  const fhdNote = qualFilter ? ' · ' + qual.label : '';
  const topLabel = state.searchState.topLabel || '';
  const sortLabel = sort === 'peer' ? 'по личам' : sort === 'quality' ? 'по качеству' : 'по сидам';
  // В заголовке видно, сколько раздач в блоке суток: иначе «ТОП-24» читается
  // как «двадцать четыре строки», и обрыв выдачи выглядит нормой. Число пришло
  // одно, а показано другое — пишем оба, иначе отсев остаётся невидимым.
  const shown = rows2.length + (hidden || 0) + hiddenEx;
  const cnt = hiddenQual ? shown + ' из ' + qualTotal : '' + shown;
  const head = topLabel === POP_LABEL ? POP_LABEL + ' (' + cnt + ')' : topLabel ? 'ТОП раздела: ' + topLabel + ' (' + sortLabel + ')' : (isTop ? 'ТОП-24 за последние 24 часа (' + cnt + ')' : 'Результаты (' + cnt + ')' + fhdNote);
  // Индекс строки в полной выдаче: по нему карточка находит свой data-ix.
  // Прежде он искался через rows.indexOf внутри map — проход по всей выдаче на
  // каждую показанную строку, то есть квадрат на больших выдачах.
  const rowIx = new Map();
  rows.forEach((r, i) => { if (!rowIx.has(r)) rowIx.set(r, i); });
  needProvider.innerHTML = html`<h2 class="section">${head}
    <select id="resSort" style="width:auto" title="Сортировка">
      <option value="quality" ${sort === 'quality' ? 'selected' : ''}>по качеству</option>
      <option value="seed" ${sort === 'seed' ? 'selected' : ''}>по сидам</option>
      <option value="peer" ${sort === 'peer' ? 'selected' : ''}>по личам</option>
      <option value="size" ${sort === 'size' ? 'selected' : ''}>по размеру</option>
      <option value="name" ${sort === 'name' ? 'selected' : ''}>по имени</option>
    </select>
    ${raw(hasMore() ? '<button id="moreBtn" class="primary" style="margin-left:8px" title="Следующая страница выдачи">Показать ещё</button>' : '')}
    ${raw(hidden ? html`<span class="hint" style="margin:0">скрыто ${hidden} не-видео</span><button id="showAllBtn" style="width:auto" title="Вернуть игры, софт и книги в выдачу">показать всё</button>` : '')}
    ${raw(hiddenQual ? html`<span class="hint" style="margin:0">отсеяно ${hiddenQual} фильтром «${qual.label}»</span><button id="anyQualBtn" style="width:auto" title="Показать раздачи ниже выбранного качества — например, 720p и HDTVRip">показать без фильтра качества</button>` : '')}
    ${raw(hiddenEx ? html`<span class="hint" style="margin:0">скрыто ${hiddenEx} по «${excl.map(w => '-' + w).join(' ')}»</span>` : '')}
    ${raw(pend.length ? html`<span class="hint src-wait" style="margin:0"><i class="spin"></i> ещё ищем: ${pend.join(', ')}</span>` : '')}
    ${raw(state.searchState.tznabOff ? html`<span class="hint" style="margin:0">${state.searchState.tznabOff}</span>` : '')}
    ${raw(status.length ? html`<span class="hint" style="margin:0">${status.join(' · ')}</span>` : '')}
  </h2>
  <div class="grid results">` +
    sorted.map(res => resultRow(res, rowIx.has(res) ? rowIx.get(res) : -1)).join('') +
    `</div>`;
  const so = $('#resSort'); if (so) so.addEventListener('change', () => { state.searchState.sort = so.value; paintResults($('#searchResults')); });
  const mb = $('#moreBtn'); if (mb) mb.addEventListener('click', loadMore);
  const sab = $('#showAllBtn'); if (sab) sab.addEventListener('click', () => { state.searchState.showAll = true; paintResults($('#searchResults')); });
  const aqb = $('#anyQualBtn'); if (aqb) aqb.addEventListener('click', () => { state.searchState.showAnyQual = true; paintResults($('#searchResults')); });
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
  const rq = rateRelease(r);
  return html`
  <div class="tile result" data-ix="${ix}">
    <div class="result-poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (r.poster ? 'hidden' : '') + '"'))}
      ${raw(r.poster ? html`<img src="${pimg(r.poster)}" loading="lazy" onerror="var p=this.parentElement;this.remove();p.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-sa="play" title="${r.provider === 'top24' || r.provider === 'topcat' ? 'Смотреть' : 'Открыть карточку фильма'}"><span class="tri"></span></button>
      <button class="fav-ov" data-sa="fav" title="В избранное">♥</button>
      <div class="badges">
        ${raw(q ? html`<span class="chip ${q}">${q === 'q2160' ? '4K' : '1080p'}</span>` : '')}
        ${raw(isSer ? html`<span class="chip series">${seriesTag(title)}</span>` : '')}
        <span class="chip rq rq-${rq.tier}" title="${rateTip(rq)}">${rq.score}${rq.ru ? ' · RU' : ''}</span>
        ${raw(r._p ? html`<span class="chip grey src">${SRC_NAME[r._p] || r._p}</span>` : '')}
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
      <button class="menu-ico" data-menu title="Ещё" aria-label="Ещё">${raw(ico('more', 18))}</button>
    </div>
    <div class="ctxmenu hidden">
      ${raw(r.provider === 'top24' || r.provider === 'topcat' ? '' : '<button data-sa="playnow">Смотреть сразу</button><div class="sep"></div>')}
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
/* Названия раздач приходят в двух видах. С трекера — «Название / Original
   (2008) WEB-DL 1080p», их разбирать просто. А в библиотеке TorrServer
   хранит и имя папки или файла: «Игра.престолов.S01.WEB-DL.2160p»,
   «Курьер.2026.MVO.WEB-DLRip.x264.seleZen.mkv». Прежде из такого имени
   в TMDB уходило «Курьер 2026 MVO seleZen mkv» — и постера не находилось:
   в поиске обложки были, а в библиотеке нет. Поэтому имя-файл сначала
   приводится к словам, а название обрезается на первом техническом слове. */
const VIDEO_EXT_RE = /\.(mkv|avi|mp4|m4v|ts|m2ts|wmv|mov|webm|flv|mpe?g|vob|iso)$/i;
const TITLE_STOP_RE = /(?:^|[\s\-])(?:S\d{1,2}(?:\s*E\d{1,3})?|сезон|season|серии|\d{3,4}[pi]|4k|uhd|web-?dl\w*|web-?rip|bd-?rip|bdremux|blu-?ray|hdrip|dvdrip|hdtvrip|hdtv|remux|x26[45]|h26[45]|hevc|avc|mvo|dvo|avo|itunes|amzn|10\s?bit)(?=$|[\s\-])/i;
function cleanSearchTitle(t) {
  let s0 = String(t || '').trim().replace(VIDEO_EXT_RE, '');
  // Имя папки или файла: слова через точки или подчёркивания.
  if ((s0.match(/[0-9A-Za-zА-Яа-яЁё][._][0-9A-Za-zА-Яа-яЁё]/g) || []).length >= 2) s0 = s0.replace(/[._]+/g, ' ');
  // Год — отдельное число, лучше в скобках: «Бегущий по лезвию 2049 (2017)».
  const yp = s0.match(/[(\[]((?:19|20)\d{2})[)\]]/);
  const ym = yp || s0.match(/(?:^|[^\dxх])((?:19|20)\d{2})(?![\dpрxх])/i);
  const year = ym ? ym[1] : '';
  const parts = s0.split('/').map(p => p.trim()).filter(Boolean);
  let pick = '';
  for (const p of parts) { if (/[а-яёЁ]/.test(p)) { pick = p; break; } }
  if (!pick) pick = parts[0] || s0;
  let s = pick;
  // Обрезаем на первом техническом слове, скобке или (если скобок нет) годе.
  let cut = s.search(TITLE_STOP_RE);
  const br = s.search(/[(\[]/);
  if (br > 0 && (cut < 0 || br < cut)) cut = br;
  if (!yp && year) {
    const yi = s.search(new RegExp('(?:^|\\s)' + year + '(?!\\d)'));
    if (yi > 0 && (cut < 0 || yi < cut)) cut = yi;
  }
  if (cut > 1) s = s.slice(0, cut);
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
  // Индекс строки в полном списке — по карте, а не поиском: прежде на каждой
  // показанной строке просматривалась вся выдача целиком (200 × N сравнений на
  // каждую перерисовку постеров).
  const ixOf = new Map();
  base.forEach((r, i) => { if (!ixOf.has(r)) ixOf.set(r, i); });
  (visible || []).slice(0, POSTER_MAX).forEach(r => {
    const c = cleanSearchTitle(r.title || r.name || '');
    if (!c.q) return;
    const ix = ixOf.has(r) ? ixOf.get(r) : -1;
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
  img.src = pimg(url);
}
// libRatings подтягивает постеры и оценки к плиткам библиотеки.
//
// Прежде запросы шли строго по одному, с паузой 60 мс на карточку: сорок плиток
// — это два с половиной секунды ожидания плюс сеть, а на большой библиотеке
// очередь не доходила до конца. Теперь запросы идут в несколько дорожек, а ответ
// на одно и то же название берётся один раз: в библиотеке оно встречается в
// разных качествах, и спрашивать его столько же раз незачем.
const LIB_RATINGS_MAX = 300;

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
// META_VER — версия правил поиска: записи прежних правил перепроверяются.
const META_VER = 2;

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
    v: META_VER,
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
  // Запись без постера свежей не считается: прежде такой ответ на сутки
  // закрывал плитке дорогу к обложке («Rick and Morty» без постера, хотя в
  // поиске он был). Демон держит свой кэш, так что спросить его дёшево.
  if (!rec.p || (rec.v || 0) < META_VER) return null;
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
  // Клик по карточке раздачи открывает страницу фильма. Исключение — ТОП за
  // 24 часа и ТОП раздела: раздача там уже выбрана, её запускают кнопкой.
  const isTopRow = r.provider === 'top24' || r.provider === 'topcat';
  if (!isTopRow) {
    row.classList.add('has-card');
    row.addEventListener('click', e => { if (e.target.closest('button, a, .ctxmenu, select, input')) return; openMovie(fromRelease(r)); });
  }
  // Крупная кнопка на постере: у обычной раздачи открывает карточку фильма,
  // «Смотреть сразу» — в меню «Ещё». У раздач из ТОПа запускает сразу.
  act('[data-sa="play"]', () => (isTopRow ? playSearchLink(r) : openMovie(fromRelease(r))));
  act('[data-sa="playnow"]', () => playSearchLink(r));
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
  // Раздача Кинозала приходит без магнита: без адреса get.php избранное
  // было нечем запустить. Постер и название фильма — для карточки избранного.
  const it = { title: r.title || r.name || '', magnet: r.magnet || magnetFromHash(r.hash, r.title), hash: r.hash, time: Date.now() };
  ['link', 'get', '_p', 'size', 'size_bytes', 'poster', 'film', 'year'].forEach(k => { if (r[k]) it[k] = r[k]; });
  ul.push(it);
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
      const rr = await fetch('/api/kinozal/add?url=' + encodeURIComponent(r.get || r.link) + '&title=' + encodeURIComponent(r.title || r.name || '') + '&size=' + encodeURIComponent(r.size || ''), { method: 'POST' });
      const j = await rr.json().catch(() => null);
      if (!rr.ok || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + rr.status);
      // .torrent не отдали — демон нашёл ту же раздачу в другом источнике.
      if (j.magnet) {
        toast('Кинозал не отдал .torrent — запускаю ту же раздачу из другого источника');
        await torrentAction('add', { link: j.magnet, save_to_db: true });
      }
      const hash = ((j.hash || '').match(/btih:([0-9a-fA-F]{40})/) || [null, j.hash || ''])[1].toLowerCase()
        || ((j.magnet || '').match(/btih:([0-9a-fA-F]{40})/i) || [null, ''])[1].toLowerCase();
      if (!hash) throw new Error('не удалось узнать хеш раздачи');
      await playHashLoop(hash);
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
    try { const ms = musicHashes(); state.lib = (await listTorrents()).filter(t => !isMusicTorrent(t, ms)); } catch {}
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
  ov.innerHTML = html`<img src="${pimg(p)}" style="max-width:90vw; max-height:90vh; border-radius:10px" onclick="this.parentElement.remove()">`;
  document.body.appendChild(ov); ov.addEventListener('click', () => ov.remove());
}

// ── Рекомендации по библиотеке ──
// Названия из библиотеки уходят демону, он сопоставляет их с TMDB и
// складывает рекомендации: что советуют сразу к нескольким вашим — выше.
// Щелчок по карточке ищет лучшую раздачу (findBest). Лишнее прячется «✕».

const REC_HIDE = 'tc_rec_hide';
const recState = { items: [], matched: 0, seeds: 0 };

function recHidden() { try { return new Set(JSON.parse(localStorage.getItem(REC_HIDE) || '[]')); } catch { return new Set(); } }
function recHide(key) {
  const s = recHidden(); s.add(key);
  try { localStorage.setItem(REC_HIDE, JSON.stringify([...s].slice(-500))); } catch {}
}

/* librarySeeds — названия для рекомендаций с весом. Досмотренное и
   Избранное говорят о вкусе больше, чем раздача, добавленная «на потом»:
   Избранное ×2, досмотренное ×1.8, начатое ×1.3, остальное ×1. Отправляются
   самые весомые, при равенстве — свежие: демон берёт не больше 60. */
function recWeight(t) {
  const vids = (t.file_stats || []).filter(f => isVideo(f.path));
  if (!vids.length) return 1;
  const done = vids.filter(f => isWatched(t, f.id)).length;
  if (done && done >= Math.ceil(vids.length / 2)) return 1.8;
  if (done || vids.some(f => currentTc(t, f.id) > 0)) return 1.3;
  return 1;
}
async function librarySeeds() {
  if (!(state.lib || []).length) { try { await loadLibrary(false); } catch {} }
  const by = new Map();
  const add = (title, w, at) => {
    const c = cleanSearchTitle(title || '');
    if (!c.q) return;
    const k = c.q.toLowerCase() + '|' + (c.year || '');
    const cur = by.get(k);
    if (cur) { cur.w = Math.max(cur.w, w); cur.at = Math.max(cur.at, at); return; }
    by.set(k, { q: c.q, year: +c.year || 0, w, at });
  };
  for (const t of state.lib || []) add(t.title || t.name, recWeight(t), Number(t.timestamp) || 0);
  for (const f of favList()) add(f.title, 2, Number(f.added || f.at) || 0);
  return [...by.values()]
    .sort((a, b) => b.w - a.w || b.at - a.at)
    .slice(0, 60)
    .map(({ q, year, w }) => ({ q, year, w }));
}

async function showRecommendations() {
  if (state.view !== 'search') { state.skipAutoTop = true; setView('search'); await new Promise(r => setTimeout(r, 30)); }
  const el = $('#searchResults'); if (!el) return;
  el.innerHTML = skeleton('Подбираю рекомендации по вашей библиотеке…', 12, true);
  const seeds = await librarySeeds();
  if (!seeds.length) { el.innerHTML = '<div class="empty">Библиотека пуста — рекомендовать не к чему. Добавьте пару фильмов.</div>'; return; }
  try {
    const r = await api('/api/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: seeds }) });
    recState.items = r.items || []; recState.matched = r.matched || 0; recState.seeds = r.seeds || 0;
  } catch (e) {
    el.innerHTML = html`<div class="empty">Не удалось подобрать: ${e.message}</div>`;
    return;
  }
  paintRecommendations(el);
}

function paintRecommendations(el) {
  const hidden = recHidden();
  const list = recState.items.filter(it => !hidden.has(it.kind + ':' + it.id));
  if (!list.length) {
    el.innerHTML = html`<div class="empty">Рекомендаций нет${recState.matched ? '' : ': ни одно название из библиотеки не нашлось в TMDB'}.</div>`;
    return;
  }
  const cards = list.map(it => html`
    <div class="disc-card" data-rk="${it.kind + ':' + it.id}" title="${it.overview || 'Подобрать лучшую раздачу из всех источников'}">
      <div class="disc-poster">${raw(it.poster ? html`<img loading="lazy" src="${pimg(it.poster)}" alt="">` : '')}
        ${raw(discFavHtml(it))}<button class="rec-x" data-hide="${it.kind + ':' + it.id}" title="Не показывать">✕</button></div>
      <div class="disc-title">${it.title}</div>
      <div class="disc-meta">${it.kind === 'tv' ? 'Сериал · ' : ''}${it.year || ''}${it.rating ? ' · ★ ' + it.rating.toFixed(1) : ''}</div>
      ${raw((it.because || []).length ? html`<div class="rec-why">Похоже на: ${it.because.join(', ')}</div>` : '')}
    </div>`).join('');
  el.innerHTML = html`<div class="disc-head">Рекомендации по библиотеке (${list.length}) <span class="page-sub" style="font-weight:400">— по ${recState.matched} из ${recState.seeds} названий, найденных в TMDB</span></div>
    <div class="disc-grid">${raw(cards)}</div>`;
  el.querySelector('.disc-grid').addEventListener('click', e => {
    const fv = e.target.closest('[data-fk]');
    if (fv) { e.stopPropagation(); toggleDiscFav(recState.items.find(i => discFavKey(i) === fv.dataset.fk)); return; }
    const x = e.target.closest('[data-hide]');
    if (x) { e.stopPropagation(); recHide(x.dataset.hide); paintRecommendations(el); return; }
    const c = e.target.closest('[data-rk]'); if (!c) return;
    const it = recState.items.find(i => i.kind + ':' + i.id === c.dataset.rk);
    if (it) openMovie({ title: it.title, year: it.year, kind: it.kind, tmdb: it.id, poster: it.poster, overview: it.overview, rating: it.rating });
  });
}
/* ---------- лучшая раздача из всех источников ---------- */
// По нажатию: rutor, Кинозал и Torznab опрашиваются разом, одинаковые раздачи
// (тот же хэш, а без хэша — то же название и размер) сливаются в одну со
// списком источников, и выбирается лучшая по оценке качества, затем по сидам.

function bestNorm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}
// bestRelevant — название раздачи содержит все значимые слова запроса и, если
// известен год, год рядом: иначе «Дюна» подтянет «Дюну» 1984 года и сборники.
function bestRelevant(r, q, year) {
  const t = bestNorm(r.title || r.name);
  const words = bestNorm(q).split(' ').filter(w => w.length > 1);
  if (!words.every(w => t.includes(w))) return false;
  if (year) {
    const ys = (String(r.title || '').match(/\b(19|20)\d{2}\b/g) || []).map(Number);
    if (ys.length && !ys.some(y => Math.abs(y - year) <= 1)) return false;
  }
  return true;
}
function bestKey(r) {
  if (r.hash) return 'h:' + String(r.hash).toLowerCase();
  const gb = r.size_bytes ? Math.round(r.size_bytes / (64 * 1048576)) : '';
  return 't:' + bestNorm(r.title || r.name) + '|' + gb;
}
function mergeBest(lists) {
  const map = new Map();
  for (const r of lists.flat()) {
    if (!r) continue;
    const k = bestKey(r);
    const cur = map.get(k);
    const src = r._p || '?';
    if (!cur) { map.set(k, { ...r, _srcs: [src] }); continue; }
    if (!cur._srcs.includes(src)) cur._srcs.push(src);
    // Сиды одной раздачи на разных трекерах — один рой, считается максимум.
    if ((r.seed || 0) > (cur.seed || 0)) cur.seed = r.seed;
    if (!cur.magnet && r.magnet) cur.magnet = r.magnet;
    if (!cur.hash && r.hash) cur.hash = r.hash;
  }
  return [...map.values()];
}
// Для просмотра «сразу» сиды важны не меньше качества: раздача с одним сидом
// не раскачается, какой бы хорошей ни была. Поэтому к оценке качества
// прибавляется вес сидов (логарифм, до +20), а почти пустые раздачи штрафуются.
function bestScore(r, q) {
  const s = r.seed || 0;
  return q.score + Math.min(20, 8 * Math.log10(1 + s)) - (s < 3 ? 15 : 0);
}
function rankBest(rows) {
  return rows.filter(r => (r.seed || 0) > 0)
    .map(r => { const q = rateRelease(r); return { r, q, w: bestScore(r, q) }; })
    .sort((a, b) => (b.w - a.w) || ((b.r.seed || 0) - (a.r.seed || 0)));
}

const SRC_NAME = { rutor: 'rutor', kinozal: 'Кинозал', torznab: 'Torznab', popular: 'rutor' };

async function findBest(q, year) {
  q = String(q || '').trim(); if (!q) return;
  $$('body > .overlay.best-ov').forEach(o => o.remove());
  const ov = document.createElement('div'); ov.className = 'overlay best-ov';
  ov.innerHTML = html`<div class="modal" style="max-width:720px"><h3>Лучшая раздача: ${q}${year ? ' (' + year + ')' : ''}</h3><div id="bestBody">${raw(skeleton('Опрашиваю все источники…', 3))}</div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  const body = ov.querySelector('#bestBody');
  const jobs = [['kinozal', () => searchKinozal(q, 0)], ['torznab', () => searchTorznab(q, 0)]];
  if (!state.rutorOff) jobs.unshift(['rutor', () => searchRutor(q, 0, 0)]);
  const res = await Promise.allSettled(jobs.map(([, f]) => f()));
  const failed = res.map((x, i) => x.status === 'rejected' ? SRC_NAME[jobs[i][0]] : '').filter(Boolean);
  const lists = res.map((x, i) => (x.status === 'fulfilled' ? x.value : []).map(r => ({ ...r, _p: r._p || jobs[i][0] })));
  let rows = mergeBest(lists).filter(r => bestRelevant(r, q, year));
  const ranked = rankBest(rows);
  if (!ranked.length) {
    body.innerHTML = html`<div class="empty">Живых раздач не найдено${failed.length ? ' (не ответили: ' + failed.join(', ') + ')' : ''}.</div><div class="row"><button class="primary" id="bestAll">Обычный поиск</button></div>`;
  } else {
    const line = ({ r, q: rq }, big) => html`<div class="best-row${big ? ' best-top' : ''}">
      <div class="best-title">${r.title || r.name}</div>
      <div class="best-meta">
        <span class="chip rq rq-${rq.tier}" title="${rateTip(rq)}">${rq.score}${rq.ru ? ' · RU' : ''}</span>
        ${raw(isSeries(r.title) ? html`<span class="chip series">${seriesTag(r.title)}</span>` : '')}
        <span>${r.size_bytes ? fmtSize(r.size_bytes) : (r.size || '')}</span><span>⬆ ${r.seed || 0}</span>
        <span class="page-sub" style="margin:0">${r._srcs.map(s => SRC_NAME[s] || s).join(' + ')}</span>
        <span class="spacer"></span><button class="${big ? 'primary' : ''}" data-bplay="${ranked.indexOf(ranked.find(x => x.r === r))}">▶ Смотреть</button>
      </div></div>`;
    body.innerHTML = html`${raw(line(ranked[0], true))}
      ${raw(ranked.length > 1 ? '<div class="page-sub" style="margin:10px 0 4px">Другие варианты</div>' + ranked.slice(1, 6).map(x => line(x, false)).join('') : '')}
      <div class="page-sub" style="margin-top:8px">Выбрано из ${rows.length} раздач (одинаковые с разных трекеров объединены)${failed.length ? '; не ответили: ' + failed.join(', ') : ''}.</div>
      <div class="row" style="margin-top:8px"><button id="bestAll">Все раздачи</button><span class="spacer"></span><button id="bestClose">Закрыть</button></div>`;
    $$('[data-bplay]', body).forEach(b => b.addEventListener('click', () => { const x = ranked[+b.dataset.bplay]; ov.remove(); playSearchLink(x.r); }));
  }
  const all = body.querySelector('#bestAll');
  if (all) all.addEventListener('click', () => { ov.remove(); if (state.view !== 'search') setView('search'); setTimeout(() => { $('#searchInput').value = q; doSearch(); }, 30); });
  const cl = body.querySelector('#bestClose'); if (cl) cl.addEventListener('click', () => ov.remove());
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

/* prepFigures — цифры ожидания в одном месте: и окно подготовки, и панель в
   углу показывают одно и то же. Буфер — то, сколько плееру нужно до старта;
   по скорости считается, сколько ещё ждать. */
function prepFigures(st, started) {
  const n = k => Number(st && st[k]) || 0;
  const stat = Number(st && st.stat);
  const pre = n('preload_size'), preBytes = n('preloaded_bytes');
  const total = n('torrent_size'), loaded = n('loaded_size');
  const sp = n('download_speed'), up = n('upload_speed');
  const seeds = n('connected_seeders'), active = n('active_peers'), all = n('total_peers');
  const pending = n('pending_peers') + n('half_open_peers');
  const part = pre > 0 ? preBytes / pre : (total > 0 ? loaded / total : 0);
  const left = pre > 0 ? Math.max(0, pre - preBytes) : 0;
  const eta = left > 0 && sp > 0 ? left / sp : 0;
  return {
    stat, pre, preBytes, total, loaded, sp, seeds, active, all, part,
    stage: PREP_STAGES[stat] || 'Раздача',
    text: {
      seeds: 'сиды: ' + seeds,
      peers: 'пиры: ' + active + (all > active ? ' из ' + all : '') + (pending > 0 ? ' · ждут ' + pending : ''),
      speed: 'скорость: ' + (sp > 0 ? fmtSize(sp) + '/с' : '0') + (up > 0 ? ' · отдача ' + fmtSize(up) + '/с' : ''),
      // До начала показа важен буфер, а не вся раздача: у сезона целиком
      // «300 МБ из 40 ГБ» выглядело как бесконечное ожидание.
      loaded: pre > 0 ? 'буфер: ' + fmtSize(preBytes) + ' из ' + fmtSize(pre) + ' (' + Math.round(Math.min(1, part) * 100) + '%)'
        : (total > 0 ? 'загружено: ' + fmtSize(loaded) : 'загружено: —'),
      eta: eta > 0 ? 'осталось ≈ ' + fmtPos(Math.max(1, eta)) : (pre > 0 && left === 0 ? 'буфер готов' : 'осталось: —'),
      total: total > 0 ? 'скачано: ' + fmtSize(loaded) + ' из ' + fmtSize(total) : 'скачано: —',
      time: 'прошло: ' + fmtPos((Date.now() - started) / 1000),
    },
  };
}
function paintPrepStats(el, fig) {
  Object.keys(fig.text).forEach(k => { const x = el('[data-st="' + k + '"]'); if (x) x.textContent = fig.text[k]; });
  const bar = el('[data-bar]'); if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, fig.part)) * 100) + '%';
}
const PREP_STAT_SPANS = ['seeds', 'peers', 'speed', 'loaded', 'eta', 'total', 'time'];

/* Пока сервер не сообщил сведения о раздаче, плееру нечего играть: он
   откроется на пустом месте. Поэтому ожидание показывается: этап, сиды, пиры,
   скорость и ход подгрузки, — а рядом кнопка отказа. */
function prepOverlay(title) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal prep">
    <h2>${title || 'Раздача'}</h2>
    <div class="prep-stage"><span class="spin"></span><span data-stage>Торрент добавлен</span></div>
    <div class="prep-bar"><i data-bar></i></div>
    <div class="prep-stats">${raw(PREP_STAT_SPANS.map(k => '<span data-st="' + k + '">—</span>').join(''))}</div>
    <div class="prep-hint" data-hint>Плеер откроется сам, когда появятся файлы раздачи.</div>
    <div class="btn-group"><button data-cancel>Отмена</button></div>
  </div>`;
  document.body.appendChild(ov);
  // Пока раздача ищет раздающих — полёт в гиперпространстве за окном.
  const warpEnd = fxWarpCruise(ov);
  const started = Date.now();
  const el = s => ov.querySelector(s);
  const api = {
    cancelled: false,
    update(st) {
      const fig = prepFigures(st, started);
      el('[data-stage]').textContent = fig.stage;
      paintPrepStats(el, fig);
      const stat = fig.stat, seeds = fig.seeds;
      if (stat <= 1 && seeds === 0) el('[data-hint]').textContent = 'Сервер ищет раздающих. Если сидов нет, показ не начнётся — можно попробовать другую раздачу.';
    },
    hint(text) { el('[data-hint]').textContent = text; },
    fail(text) { el('[data-stage]').textContent = text; ov.querySelector('.spin').classList.add('stop'); },
    close(ok) { api.cancelled = true; warpEnd(!!ok); ov.remove(); },
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
  if (cur) { mergeStat(cur, st); cur.hasStat = true; }
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
      <button data-send title="Отправить на устройство: телефон, планшет, телевизор">📲</button>
      <button data-hide title="Скрыть">✕</button></div>
    <div class="dlpanel-sub" data-sub>${epSuffix(f).replace(/^ — /, '') || basename(f.path)}</div>
    <div class="prep-bar"><i data-bar></i></div>
    <div class="prep-stats"><span data-st="stage">—</span>${raw(PREP_STAT_SPANS.map(k => '<span data-st="' + k + '">—</span>').join(''))}</div>
    <div class="prep-hint" data-hint></div>
    <div class="prep-next hidden" data-nextbox></div>`;
  document.body.appendChild(ov);
  const el = s => ov.querySelector(s);
  el('[data-send]').addEventListener('click', () => sendToDevice(t, f));
  const started = Date.now();
  let stopped = false;
  let announced = false;
  let lastBytes = 0, lastLoaded = 0, lastMove = Date.now(), sawPreload = false;

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
      // Во время показа цифры подгрузки только врут: плеер читает с опережением,
      // скорость скачет, а «загружено» относится ко всей раздаче. Поэтому они
      // убираются, и опрос сервера прекращается — просмотру ничего не мешает.
      clearInterval(timer);
      ['.prep-bar', '.prep-stats', '[data-hint]'].forEach(s => { const x = el(s); if (x) x.remove(); });
      const sp = ov.querySelector('.spin'); if (sp) sp.remove();
      el('[data-sub]').textContent = 'Показ идёт · ' + el('[data-sub]').textContent;
      ov.classList.add('done');
      if (next) {
        // Серия с серией: панель не уходит, а предлагает следующую. Искать
        // раздачу и серию заново после каждой серии — обычная работа, которую
        // тут делает одна кнопка.
        panel.showNextButton();
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
  // Кнопка следующей серии видна сразу, а не только после старта показа:
  // о старте демон судит по цифрам TorrServer, и они бывают неточны.
  if (next) panel.showNextButton();

  const tick = async () => {
    if (stopped || announced) return;
    const st = await statTorrent(t.hash).catch(() => null);
    if (stopped || !st || typeof st !== 'object') return;
    if (Array.isArray(st.file_stats) && st.file_stats.length) rememberStat(t.hash, st);
    const fig = prepFigures(st, started);
    const stat = fig.stat, seeds = fig.seeds, peers = fig.active;
    el('[data-st="stage"]').textContent = fig.stage;
    paintPrepStats(el, fig);
    // Показ начался, когда буфер набран. Раньше панель уходила при первом же
    // байте — и самое интересное, ход предзагрузки, увидеть было нельзя.
    // bytes_read у TorrServer — принятое от пиров, а не прочитанное плеером,
    // поэтому по нему о старте судить нельзя.
    // Признаки старта: буфер набран; или предзагрузка шла (стадия 2) и
    // закончилась; или стадии предзагрузки так и не было (она выключена или
    // прошла между опросами), а раздача работает уже 15 секунд. Прежде
    // панель ждала буфер до конца, TorrServer же часто заканчивает
    // предзагрузку раньше и обнуляет счётчик — и панель вместе с кнопкой
    // «Следующая серия» уходила по сроку, так и не показав её.
    if (stat === 2) sawPreload = true;
    const age = Date.now() - started;
    if ((fig.pre > 0 && fig.preBytes >= fig.pre * 0.97)
      || (stat === 3 && sawPreload)
      || (stat === 3 && age > 15000 && (fig.loaded > 0 || fig.sp > 0))) { panel.ready(); return; }
    if (fig.preBytes > lastBytes || fig.loaded > lastLoaded) { lastBytes = fig.preBytes; lastLoaded = fig.loaded; lastMove = Date.now(); }
    if (seeds === 0 && peers === 0) {
      el('[data-hint]').textContent = 'Раздающих нет: показ не начнётся, пока не появятся сиды. Попробуйте другую раздачу.';
    } else if (stat <= 1) {
      el('[data-hint]').textContent = 'Сервер ищет раздающих...';
    } else if (fig.pre > 0) {
      el('[data-hint]').textContent = 'Набирается буфер: показ начнётся, когда он заполнится.';
    } else {
      el('[data-hint]').textContent = 'Плеер открыт и ждёт данных.';
    }
    // Долгое ожидание без движения не должно висеть вечно; пока буфер
    // растёт, панель остаётся.
    // Для серии панель не пропадает молча: кнопка следующей серии нужна и тогда,
    // когда о старте судить не по чему.
    if (Date.now() - lastMove > 90000) { if (next) panel.ready(); else panel.stop(); }
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
  el.querySelector('[data-pk="copy"]').addEventListener('click', () => copyToClip(isRemoteUI() ? phoneStreamUrl(t, curFile) : makeStreamUrlFor(t, curFile), 'Ссылка скопирована'));
  el.querySelector('[data-pk="dl"]').addEventListener('click', async () => {
    const q = 'action=start&hash=' + encodeURIComponent(t.hash) + '&index=' + curFile.id + '&name=' + encodeURIComponent(t.title || 'file') + '&file=' + encodeURIComponent(basename(curFile.path)) + '&size=' + (curFile.length || 0);
    // Запуск закачки — POST: GET-адрес с чужой страницы могла бы дёрнуть даже картинка.
    try { await api('/api/download?' + q, { method: 'POST' }); toast('Загрузка начата'); loadDownloads(); }
    catch (e) { toast('Не удалось начать загрузку: ' + e.message, true); }
  });
  el.querySelector('[data-pk="bm"]').addEventListener('click', () => { addBookmark(t, curFile.id, basename(curFile.path), estimatePos(t.hash, curFile.id)); });
}
function basename(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }
function makeStreamUrlFor(t, f) {
  // Ссылка на один файл: плейлист всей раздачи собирает демон, когда получает
  // раздачу и номер файла. Продолжение с места остановки ставит плеер флагом
  // запуска — параметр pos TorrServer не разбирает.
  return location.origin + ts(`/stream/${encodeURIComponent(basename(f.path))}?link=${encodeURIComponent(t.hash)}&index=${f.id}&play`);
}
function inBrowser(t, f) {
  // На телефоне «в браузере» — это браузер телефона, а не компьютера.
  if (isRemoteUI()) { trackPlay(t.hash, f.id, currentTc(t, f.id)); return phoneBrowser(phoneStreamUrl(t, f), (t.title || t.name || 'stream') + epSuffix(f), t, f); }
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
  // С телефона «Смотреть» раньше запускало плеер на компьютере, и на телефоне
  // ничего не происходило. Теперь спрашиваем, где смотреть.
  if (isRemoteUI() && !opts.player && !opts.onPC) return phonePlay(cur, f, opts);
  const key = opts.player || pickPlayer();
  fxWarp(); // прыжок к фильму: запуск плеера
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
function openEpisodesPicker(t, files, opts) {
  opts = opts || {};
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
  // Много сезонов — вкладки: одним списком в сотню серий приходилось листать
  // до нужного сезона. Открывается сезон следующей серии (или тот, что был
  // выбран до перерисовки), остальные — одним нажатием.
  const tabs = seasons.length > 1;
  const nextSn = ((p => (p && p.s) || 0)(parseSeriesEp(basename(next.path))));
  let cur = tabs ? (opts.season != null && groups.has(opts.season) ? opts.season : (groups.has(nextSn) ? nextSn : seasons[0])) : null;
  const tabHtml = !tabs ? '' : html`<div class="eps-tabs">${raw(seasons.map(sn => {
    const list = groups.get(sn);
    const w = list.filter(f => isWatched(t, f.id)).length;
    const full = w === list.length;
    return html`<button class="eps-tab${sn === cur ? ' on' : ''}${full ? ' full' : ''}" data-sn-tab="${sn}" title="просмотрено ${w} из ${list.length}">${sn ? 'Сезон ' + sn : 'Прочее'} <small>${full ? '✓' : w + '/' + list.length}</small></button>`;
  }).join(''))}</div>
    <div class="row eps-tools"><span class="page-sub" data-sn-sum></span><span style="flex:1"></span>
      <button class="ghost" data-sn-mark>✓ Отметить сезон</button></div>`;
  ov.innerHTML = html`<div class="modal wide">
    <button class="modal-close" data-close>✕</button>
    <div class="row"><div style="flex:1"><h2 style="margin-top:0">${t.title || t.name || t.hash}</h2>
      <div class="page-sub">Серий: ${files.length} · просмотрено: ${done} · следующая — ${epLabel(next, t)}</div></div>
      <button data-next>▶ Смотреть следующую</button></div>
    <div class="divider"></div>
    ${raw(tabHtml)}
    <div class="eps-list" style="max-height:60vh;overflow:auto">
      ${raw(seasons.map(sn => html`<div class="eps-season${tabs && sn !== cur ? ' hidden' : ''}" data-sn="${sn}">
        <div class="eps-season-h">${sn ? 'Сезон ' + sn : 'Эпизоды'}</div>
        ${raw(groups.get(sn).map(f => epRow(t, f, next, sn)).join(''))}
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
    close(); openEpisodesPicker(t, files, { season: cur });
  }));
  const list = ov.querySelector('.eps-list');
  const showSeason = sn => {
    cur = sn;
    $$('.eps-season', ov).forEach(b => b.classList.toggle('hidden', parseInt(b.dataset.sn, 10) !== sn));
    $$('[data-sn-tab]', ov).forEach(b => b.classList.toggle('on', parseInt(b.dataset.snTab, 10) === sn));
    const g = groups.get(sn) || [];
    const w = g.filter(f => isWatched(t, f.id)).length;
    const sum = ov.querySelector('[data-sn-sum]');
    if (sum) sum.textContent = 'Серий в сезоне: ' + g.length + ' · просмотрено: ' + w;
    const mk = ov.querySelector('[data-sn-mark]');
    if (mk) mk.textContent = w === g.length ? '↺ Снять отметки сезона' : '✓ Отметить сезон';
    // Прокрутка — к следующей серии, если она в этом сезоне, иначе к началу.
    const row = ov.querySelector('.eps-season[data-sn="' + sn + '"] .eprow.next');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' }); else list.scrollTop = 0;
    loadEpDetails(ov, t, sn);
  };
  $$('[data-sn-tab]', ov).forEach(b => b.addEventListener('click', () => showSeason(parseInt(b.dataset.snTab, 10))));
  // Сезон целиком — одно нажатие, а не двадцать галочек: так начинают
  // смотреть с середины сериала или отмечают уже увиденное.
  const mark = ov.querySelector('[data-sn-mark]');
  if (mark) mark.addEventListener('click', async () => {
    const g = groups.get(cur) || [];
    const all = g.every(f => isWatched(t, f.id));
    mark.disabled = true;
    let ok = true;
    for (const f of g) {
      if (isWatched(t, f.id) !== all) continue;
      if (!(await savePosition(t.hash, f.id, all ? 0 : null, 0, !all))) { ok = false; break; }
    }
    mark.disabled = false;
    if (ok) toast(all ? 'Отметки сезона сняты' : 'Сезон отмечен просмотренным');
    close(); openEpisodesPicker(t, files, { season: cur });
  });
  if (tabs) showSeason(cur);
  else {
    const row = ov.querySelector('.eprow.next');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    loadEpDetails(ov, t);
  }
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
/* epFileName — название серии из имени файла. Релиз пишет его в скобках сразу
   после номера: «S02 E01 (Тихая жизнь) WEB-DL 1080p». TMDB отвечает не всегда
   (у него своя сеть и ключ), а имя серии нужно всегда, поэтому это запасной
   источник: разметку и год релизера именем серии не считаем. Когда TMDB ответит,
   loadEpDetails подставит своё, каноническое название. */
const RE_EP_NAME_JUNK = /^(?:\d{4}|2160p?|1080p?|720p?|480p?|4k|uhd|bdrip|blu-?ray|web-?dl|web-?rip|hdrip|hdtv|dvdrip|remux|sdr|hdr10?|hevc|x26[45]|mkv|avi|mp4|mov)$/i;
function epFileName(path) {
  const s = basename(path);
  const m = s.match(RE_SXEX) || s.match(RE_RU_EP);
  if (!m) return '';
  const tail = s.slice(m.index + m[0].length);
  const clean = x => x.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const junk = w => !w || RE_EP_NAME_JUNK.test(w) || /^\d+$/.test(w);
  // Скобки сразу после номера: «S02E01 (Тихая жизнь)». В скобках может
  // оказаться год или разрешение — тогда ищем дальше, а не выдаём мусор.
  const g = tail.match(/[[(]([^[\]()]{2,60})[\])]/);
  if (g) {
    const inBrackets = clean(g[1]);
    if (inBrackets && !junk(inBrackets)) return inBrackets;
  }
  // Иначе — слова после номера до первой технической приметы: год,
  // разрешение, кодек, «WEB-DL». Название может идти через дефис или точки,
  // поэтому режем только по пробелу и точке: «Sci-Fi» и «WEB-DL» останутся
  // целыми, а мусор справа отбросится.
  let rest = tail.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/^[\s\-–—:]+/, '');
  const words = [];
  for (const w of rest.split(/[.\s·]+/)) {
    const t = w.trim();
    if (!t) continue;
    if (/^[[(]/.test(t) || junk(t)) break;
    words.push(t);
    if (words.join(' ').length > 60) break;
  }
  const name = clean(words.join(' '));
  if (!name || junk(name) || !/[\p{L}]/u.test(name)) return '';
  return name;
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
  const fb = epFileName(f.path);
  return html`<div class="${cls.join(' ')}" data-ep-row="${f.id}" data-ep-num="${p.e || 0}" data-sn="${season}">
    <button class="ep-main" data-ep="${f.id}" data-ep-num="${p.e || 0}" data-sn="${season}" title="${basename(f.path)}">
      <span class="ep-still"></span>
      <span class="ep-body">
        <span class="ep-line1"><span class="ep-label">${epLabel(f, t)}</span><span class="epname">${fb ? ' · ' + fb : ''}</span></span>
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
async function loadEpDetails(ov, t, only) {
  const q = cleanSeriesName(t.title || t.name || '');
  if (!q) return;
  // Сезоны подгружаются по мере открытия вкладок: у сериала на десять сезонов
  // десять запросов подряд задерживали как раз тот, что открыт.
  const blocks = $$('.eps-season', ov).filter(b => only == null || parseInt(b.dataset.sn, 10) === only);
  for (const block of blocks) {
    const sn = parseInt(block.dataset.sn, 10);
    if (!sn || block.dataset.loaded) continue;
    block.dataset.loaded = '1';
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
      if (still && ep.still) still.innerHTML = html`<img src="${pimg(ep.still)}" loading="lazy" alt="">`;
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


/* ---------- просмотр на телефоне ---------- */
function isRemoteUI() { return !!(state.hello && state.hello.remote); }
/* phoneStreamUrl — ссылка на серию для плеера телефона. Плеер не знает cookie
   браузера, поэтому пропуск (только к потоку) идёт в самой ссылке. */
function phoneStreamUrl(t, f) {
  const tk = (state.hello && state.hello.stream_token) || '';
  return makeStreamUrlFor(t, f) + (tk ? '&tk=' + encodeURIComponent(tk) : '');
}
function isAndroid() { return /android/i.test(navigator.userAgent || ''); }
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent || ''); }
/* phoneOpenPlayer открывает ссылку в плеере телефона. Android показывает выбор
   установленных плееров (VLC, MX Player…) по типу video/*; на iPhone — VLC. */
function phoneOpenPlayer(url, title) {
  if (isAndroid()) {
    const u = new URL(url);
    location.href = 'intent://' + u.host + u.pathname + u.search + '#Intent;scheme=' + u.protocol.replace(':', '') +
      ';type=video/*;S.title=' + encodeURIComponent(title || '') + ';end';
  } else if (isIOS()) {
    location.href = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(url);
  } else {
    window.open(url, '_blank');
  }
}
/* phoneBrowser — встроенный проигрыватель страницы. Браузер телефона играет
   MP4/H.264 и часто MKV с H.264; HEVC и AC3 — нет, тогда нужен плеер. */
function phoneBrowser(url, title, t, f) {
  const ov = document.createElement('div'); ov.className = 'overlay phone-video';
  ov.innerHTML = html`<div class="modal wide"><button class="modal-close" data-close>✕</button>
    <h3 style="margin-top:0">${title}</h3>
    <video controls autoplay playsinline preload="auto" src="${url}" style="width:100%;max-height:70vh;background:#000"></video>
    <div class="page-sub" data-vmsg>Если видео не идёт (кодек HEVC или звук AC3) — откройте в плеере.</div>
    <div class="row" style="margin-top:8px"><button data-ext>▶ В плеере телефона</button></div></div>`;
  document.body.appendChild(ov);
  const v = ov.querySelector('video');
  const pos = currentTc(t, f.id);
  if (pos > 5) v.addEventListener('loadedmetadata', () => { try { v.currentTime = pos; } catch (e) {} }, { once: true });
  // Позиция из браузера телефона сохраняется так же, как от плеера на компьютере.
  let last = 0;
  v.addEventListener('timeupdate', () => {
    if (Date.now() - last < 15000 || !v.duration) return;
    last = Date.now();
    const done = v.currentTime >= v.duration * 0.92;
    savePosition(t.hash, f.id, done ? 0 : v.currentTime, v.duration, done);
  });
  v.addEventListener('error', () => { ov.querySelector('[data-vmsg]').textContent = 'Браузер телефона не может показать этот файл — откройте в плеере.'; });
  ov.querySelector('[data-ext]').addEventListener('click', () => { v.pause(); phoneOpenPlayer(url, title); });
  ov.querySelector('[data-close]').addEventListener('click', () => { v.pause(); v.removeAttribute('src'); v.load(); ov.remove(); });
}
function phonePlay(t, f, opts) {
  const title = (t.title || t.name || 'stream') + epSuffix(f);
  const url = phoneStreamUrl(t, f);
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal"><button class="modal-close" data-close>✕</button>
    <h3 style="margin-top:0">Где смотреть?</h3>
    <div class="page-sub" style="margin-bottom:10px">${title}</div>
    <div class="phone-play">
      <button class="primary" data-pp="player">📱 В плеере телефона<small>VLC, MX Player — играет любые файлы</small></button>
      <button data-pp="browser">🌐 В браузере телефона<small>без установки, но не все кодеки</small></button>
      <button data-pp="pc">💻 На компьютере<small>телефон как пульт: плеер откроется там</small></button>
      <button class="ghost" data-pp="copy">🔗 Скопировать ссылку</button>
    </div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.querySelector('[data-close]').addEventListener('click', () => ov.remove());
  ov.querySelectorAll('[data-pp]').forEach(b => b.addEventListener('click', async () => {
    const how = b.dataset.pp;
    if (how === 'copy') {
      try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); } catch (e) { prompt('Ссылка на серию', url); }
      return;
    }
    ov.remove();
    trackPlay(t.hash, f.id, opts.fromZero ? 0 : currentTc(t, f.id));
    if (how === 'pc') return playSelected(t, f, Object.assign({}, opts, { onPC: true }));
    if (how === 'browser') return phoneBrowser(url, title, t, f);
    phoneOpenPlayer(url, title);
    refreshViewedSoon();
  }));
}

/* ================= ОТПРАВИТЬ НА УСТРОЙСТВО =================
   Каждое открытое окно TorrClient (компьютер, телефон, планшет) отмечается у
   демона. Отправка приходит на выбранное устройство событием handoff — там
   появляется «Смотреть здесь» с того же места. Телевизоры с DLNA в той же
   сети демон находит сам и включает им поток с нужного времени. */
function devId() {
  let id = localStorage.getItem('tc_dev_id');
  if (!id) { id = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('tc_dev_id', id); }
  return id;
}
function devKind() {
  const ua = navigator.userAgent || '';
  if (/ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'tablet';
  if (/iphone|ipod|android|mobile/i.test(ua)) return 'phone';
  return 'pc';
}
function devName() {
  const own = localStorage.getItem('tc_dev_name'); if (own) return own;
  const ua = navigator.userAgent || '';
  const k = devKind();
  const os = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : '';
  return (k === 'phone' ? 'Телефон' : k === 'tablet' ? 'Планшет' : isRemoteUI() ? 'Браузер' : 'Этот компьютер') + (os ? ' · ' + os : '');
}
const DEV_ICON = { phone: '📱', tablet: '📱', pc: '💻', tv: '📺' };
function devHeartbeat() {
  api('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: devId(), name: devName(), kind: devKind() }) }).catch(() => {});
}
setTimeout(devHeartbeat, 1500);
setInterval(devHeartbeat, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) devHeartbeat(); });

async function sendToDevice(t, f) {
  const title = (t.title || t.name || 'stream') + epSuffix(f);
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal"><button class="modal-close" data-close>✕</button>
    <h3 style="margin-top:0">📲 Отправить на устройство</h3>
    <div class="page-sub" style="margin-bottom:8px">${title}${raw(currentTc(t, f.id) > 5 ? ' · с ' + esc(fmtPos(currentTc(t, f.id))) : '')}</div>
    <div class="dev-list" data-list><div class="empty">Ищу устройства в сети…</div></div>
    <label class="row" style="gap:6px;margin:8px 0"><input type="checkbox" data-stop${isRemoteUI() ? '' : ' checked'}> Остановить плеер на компьютере</label>
    <div class="row wrap"><button data-scan>Искать снова</button>
      <span class="page-sub" style="flex:1;margin:0">Устройство — это открытый TorrClient на телефоне или планшете (по адресу удалённого доступа) либо телевизор с DLNA в той же сети.</span></div>
    <div class="row" style="margin-top:6px;gap:6px"><span class="page-sub" style="margin:0">Имя этого устройства:</span><input data-myname value="${devName()}" style="flex:1"></div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('[data-close]').onclick = close;
  const nm = ov.querySelector('[data-myname]');
  nm.addEventListener('change', () => { const v = nm.value.trim(); if (v) localStorage.setItem('tc_dev_name', v); else localStorage.removeItem('tc_dev_name'); devHeartbeat(); });
  const list = ov.querySelector('[data-list]');
  const load = async scan => {
    list.innerHTML = '<div class="empty">Ищу устройства в сети…</div>';
    let j;
    try { j = await api('/api/devices?self=' + encodeURIComponent(devId()) + (scan ? '&scan=1' : '')); } catch (e) { list.innerHTML = html`<div class="empty">Не удалось спросить демон: ${e.message}</div>`; return; }
    const devs = (j.devices || []).sort((a, b) => (a.type === 'app' ? 0 : 1) - (b.type === 'app' ? 0 : 1));
    if (!devs.length) { list.innerHTML = '<div class="empty">Устройств не видно. Откройте TorrClient на телефоне (Настройки → Удалённый доступ, QR-код) или включите телевизор.</div>'; return; }
    list.innerHTML = devs.map(d => html`<button class="dev-item" data-dev="${d.id}">${DEV_ICON[d.kind] || '🖥'} ${d.name}<small>${d.type === 'dlna' ? 'телевизор · DLNA' : 'TorrClient'}</small></button>`).join('');
    list.querySelectorAll('[data-dev]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: b.dataset.dev, from: devId(), hash: t.hash, index: f.id, pos: currentTc(t, f.id), title, stop_local: ov.querySelector('[data-stop]').checked }) });
        toast('Отправлено на «' + (r.name || '') + '»' + (r.pos > 5 ? ' — с ' + fmtPos(r.pos) : ''));
        if (ov.querySelector('[data-stop]').checked && activePanel) activePanel.stop();
        close();
      } catch (e) { b.disabled = false; toast(e.message, true); }
    });
  };
  ov.querySelector('[data-scan]').onclick = () => load(true);
  load(false);
}
async function handoffArrived(d) {
  if (!d || d.target !== devId()) return;
  let w = document.getElementById('handoffBox'); if (w) w.remove();
  w = document.createElement('div'); w.id = 'handoffBox'; w.className = 'sleep-warn';
  w.innerHTML = html`<span>📲 ${d.from ? 'С устройства «' + d.from + '»: ' : ''}<b>${d.title || 'видео'}</b>${raw(d.pos > 5 ? ' — с ' + esc(fmtPos(d.pos)) : '')}</span>
    <button data-go class="primary">▶ Смотреть здесь</button><button data-x>✕</button>`;
  document.body.appendChild(w);
  w.querySelector('[data-x]').onclick = () => w.remove();
  try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('TorrClient', { body: 'Продолжить просмотр: ' + (d.title || '') }); } catch (_) { /* нет уведомлений */ }
  w.querySelector('[data-go]').onclick = async () => {
    w.remove();
    let t = (state.lib || []).find(x => x.hash === d.hash);
    if (!t || !(t.file_stats || []).length) { try { await loadLibrary(); } catch (_) { /* ниже — запасной вариант */ } t = (state.lib || []).find(x => x.hash === d.hash) || t; }
    if (!t) t = { hash: d.hash, title: d.title, file_stats: [] };
    if (!(t.file_stats || []).length) t = await waitForFiles(t, 20000) || t;
    const f = (t.file_stats || []).find(x => x.id === d.index) || { id: d.index, path: (d.title || 'video') + '.mkv' };
    if (d.pos > 5) await savePosition(d.hash, d.index, d.pos, 0, false);
    playSelected(t, f, {});
  };
}
/* ================= КАРТОЧКА ФИЛЬМА =================
   Одна страница на название: постер, описание, сезоны и серии с отметками
   просмотра, все найденные раздачи с качеством и числом раздающих и кнопки
   «Смотреть» и «Следить». Открывается с любой карточки названия — из «Сейчас
   смотрят», «Для вас», избранного, поиска. Исключение — ТОП за 24 часа: там
   раздача уже выбрана, и она запускается сразу.
   Раздачи ищутся по готовности: каждый источник ложится в список сам, а
   зависший отрезается по таймауту. Список ранжируется по «пригодности для
   просмотра сразу»: качество, русская дорожка, число раздающих и разумный
   размер. Для сериала можно выбрать сезон — раздачи другого сезона уходят. */

const MV_CACHE_TTL = 10 * 60000;
const mvCache = new Map();
const mv = { run: 0, key: '', spec: null, rows: [], pending: {}, errs: [], meta: null, eps: null, season: 0, qual: '', ru: false, sort: 'best', started: 0 };

/* fromRelease — заготовка карточки по раздаче: чистое название и год из
   названия раздачи, сезон — если он в нём указан. */
function fromRelease(r) {
  const c = cleanSearchTitle(r.title || r.name || '');
  const ser = isSeries(r.title || r.name || '');
  return { title: c.q || r.title || r.name || '', year: c.year || '', kind: ser ? 'tv' : '', poster: r.poster || '', season: ser ? seasonOf(r.title || r.name || '') : 0 };
}
function openMovie(spec) {
  if (!spec || !String(spec.title || '').trim()) return;
  const clean = { title: String(spec.title).trim() };
  ['year', 'kind', 'tmdb', 'poster', 'overview', 'rating', 'season', 'query'].forEach(k => { if (spec[k]) clean[k] = spec[k]; });
  if (clean.year) clean.year = String(clean.year).slice(0, 4);
  setView('movie', { movie: clean });
}
const mvKey = m => bestNorm(m.title) + '|' + (m.year || '') + '|' + (m.query || '');

/* Сезоны, которые покрывает раздача: одиночный, диапазон («1-5 сезон», S01-S05)
   или «все сезоны». null — сезон по названию не определить. */
function releaseSeasons(title) {
  const t = String(title || '');
  let m = t.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*сезон/i) || t.match(/сезон[ыа]?[ ._-]*(\d{1,2})\s*[-–—]\s*(\d{1,2})/i)
    || t.match(/\bS(\d{1,2})\s*[-–—]\s*S?(\d{1,2})\b/i);
  if (m && +m[2] >= +m[1]) return { from: +m[1], to: +m[2] };
  if (/все\s+сезон|полная\s+серия|complete\s+series|все\s+серии/i.test(t)) return { from: 1, to: 99 };
  const one = seasonOf(t);
  return one ? { from: one, to: one } : null;
}

/* Оценка раздачи для просмотра сразу. Качество уже знает rateRelease; здесь —
   баланс с раздающими и размером: огромный ремукс с горстью сидов стартует
   медленно, а раздача с тысячей сидов в 720p стартует мгновенно. */
function movieScore(r, q, season) {
  const seeds = r.seed || 0;
  let w = bestScore(r, q);
  const gb = (r.size_bytes || 0) / 1e9;
  if (gb > 40 && seeds < 30) w -= 10;
  else if (gb > 15 && seeds < 8) w -= 8;
  if (!seeds) w -= 30;
  if (season) {
    const cov = releaseSeasons(r.title || r.name);
    if (cov) {
      if (cov.from === season && cov.to === season) w += 25;
      else if (cov.from <= season && cov.to >= season) w += 8; // сборник покрывает, но тащит лишнее
      else w -= 60;
    }
  }
  return w;
}

async function renderMovie(root) {
  const m = state.params && state.params.movie;
  if (!m || !m.title) { root.innerHTML = '<div class="empty">Карточка не открыта. <button data-go="home" class="link-btn">На главную</button></div>'; if (!root._mvBound) { root._mvBound = true; root.addEventListener('click', onMovieClick); } return; }
  const key = mvKey(m);
  const run = ++mv.run;
  const fresh = mvCache.get(key);
  const same = mv.key === key;
  if (!same) {
    Object.assign(mv, { key, spec: m, rows: [], pending: {}, errs: [], meta: null, eps: null, season: Number(m.season) || 0, qual: '', ru: false, sort: 'best', started: Date.now() });
    if (fresh && Date.now() - fresh.at < MV_CACHE_TTL) { mv.rows = fresh.rows.slice(); mv.meta = fresh.meta; mv.eps = fresh.eps; mv.errs = fresh.errs; mv.cached = true; }
    else mv.cached = false;
  }
  mv.spec = m;
  root.innerHTML = '<div class="mv" id="mv"></div>';
  paintMovie();
  if (!root._mvBound) { root._mvBound = true; root.addEventListener('click', onMovieClick); }
  if (!mv.cached) { loadMovieMeta(run); searchMovieReleases(run); }
  else if (mv.meta) paintMovieEps();
  if (isMovieSeries() && !mv.eps) loadMovieEps(run);
}
const mvLive = run => run === mv.run && state.view === 'movie';

function isMovieSeries() {
  const m = mv.spec || {};
  if (m.kind) return m.kind === 'tv';
  if (mv.meta && mv.meta.type) return mv.meta.type === 'tv';
  const hits = mv.rows.filter(r => isSeries(r.title || r.name)).length;
  return mv.rows.length >= 3 && hits > mv.rows.length / 2;
}
function mvTitleClean() { return String((mv.spec && mv.spec.title) || '').replace(/[:!?,.«»"“”]/g, ' ').replace(/\s+/g, ' ').trim(); }

async function loadMovieMeta(run) {
  const m = mv.spec;
  const q = mvTitleClean();
  try {
    const [rat, tm] = await Promise.all([
      getRatings({ q, year: m.year || '' }).catch(() => null),
      apiGetJSON('/api/tmdb?q=' + encodeURIComponent(q) + (m.year ? '&year=' + encodeURIComponent(m.year) : '')).catch(() => null),
    ]);
    if (!mvLive(run)) return;
    const meta = {};
    if (rat && rat.ok) Object.assign(meta, { poster: rat.poster, rating: rat.rating, imdb: rat.imdb, type: rat.type, id: rat.id });
    if (tm && tm.ok) Object.assign(meta, { poster: meta.poster || tm.poster, overview: tm.overview, type: tm.type || meta.type, id: tm.id || meta.id, rating: meta.rating || tm.rating, year: tm.year });
    if (tm && tm.error) noteMetaError(tm.error);
    mv.meta = meta;
    paintMovie();
    if (isMovieSeries() && !mv.eps) loadMovieEps(run);
  } catch { /* без метаданных страница остаётся рабочей */ }
}
async function loadMovieEps(run) {
  if (mv.epsBusy) return; mv.epsBusy = true;
  try {
    const j = await apiGetJSON('/api/tv_eps?q=' + encodeURIComponent(mvTitleClean()));
    if (!mvLive(run)) return;
    if (j && j.ok) { mv.eps = j; if (!mv.season && mv.spec.season) mv.season = mv.spec.season; paintMovie(); }
    else { mv.eps = { ok: false, seasons: [] }; paintMovie(); }
  } catch { mv.eps = { ok: false, seasons: [] }; paintMovie(); }
  finally { mv.epsBusy = false; }
}

/* Поиск раздач по всем источникам: каждый кладёт своё сразу, зависший — по таймауту. */
function searchMovieReleases(run) {
  const q = mv.spec.query || mvTitleClean();
  const names = { rutor: 'rutor', kinozal: 'Кинозал', torznab: 'Torznab' };
  const add = items => {
    if (!mvLive(run) || !items || !items.length) return;
    // Раздачи с разных трекеров с одним хешем — одна строка со списком источников.
    const byKey = new Map(mv.rows.map(r => [bestKey(r), r]));
    for (const it of items) {
      const k = bestKey(it), src = it._p || '?', cur = byKey.get(k);
      if (!cur) { const n = Object.assign({}, it, { _srcs: [src] }); byKey.set(k, n); mv.rows.push(n); continue; }
      if (!cur._srcs.includes(src)) cur._srcs.push(src);
      if ((it.seed || 0) > (cur.seed || 0)) cur.seed = it.seed;
      if (!cur.magnet && it.magnet) cur.magnet = it.magnet;
      if (!cur.hash && it.hash) cur.hash = it.hash;
    }
    schedulePaintMovie();
  };
  const start = (p, make, ms) => {
    mv.pending[p] = names[p];
    const ac = new AbortController();
    withTimeout(make(ac.signal), ms, names[p] + ' не ответил за ' + Math.round(ms / 1000) + ' с', () => ac.abort())
      .then(r => { if (r) add(r); })
      .catch(e => { if (mvLive(run)) mv.errs.push(e.message.indexOf(names[p]) === 0 ? e.message : names[p] + ': ' + e.message); })
      .then(() => {
        if (run !== mv.run) return;
        delete mv.pending[p];
        if (!Object.keys(mv.pending).length) mvCache.set(mv.key, { at: Date.now(), rows: mv.rows.slice(), meta: mv.meta, eps: mv.eps, errs: mv.errs.slice() });
        schedulePaintMovie();
      });
  };
  if (!state.rutorOff) start('rutor', sig => searchRutor(q, 0, 0, sig), SEARCH_TIMEOUT);
  start('kinozal', sig => searchKinozal(q, 0, sig), SEARCH_TIMEOUT);
  start('torznab', async sig => {
    const res = await readTorznabStream(q, sig, items => add(items));
    if (res.off && !res.total) throw new Error(res.off.replace(/^Torznab: /, ''));
    return [];
  }, SEARCH_TIMEOUT + 8000);
}
let mvPaintTimer = 0;
function schedulePaintMovie() {
  if (mvPaintTimer) return;
  mvPaintTimer = setTimeout(() => { mvPaintTimer = 0; if (state.view === 'movie') { paintMovieReleases(); paintMovieHeadBits(); } }, 150);
}

/* Раздачи, подходящие к названию. Для фильма — по году, для сериала год не
   проверяется: он у раздач бывает любым. */
function mvRelevant() {
  const m = mv.spec;
  const q = m.query || mvTitleClean();
  const year = isMovieSeries() ? 0 : Number(m.year) || 0;
  return mv.rows.filter(r => bestRelevant(r, q, year) && !nonVideoKind(r.title || r.name || ''));
}
function mvRanked() {
  const rows = mvRelevant().map(r => ({ r, q: rateRelease(r) }));
  return rows.map(x => Object.assign(x, { w: movieScore(x.r, x.q, isMovieSeries() ? mv.season : 0) }));
}
function mvFiltered(list) {
  return list.filter(({ r, q }) => {
    if (mv.qual === '4k' && q.res !== '4K') return false;
    if (mv.qual === 'fhd' && !(q.res === '4K' || q.res === '1080p')) return false;
    if (mv.qual === 'hd' && !(q.res === '720p' || q.res === 'SD' || !q.res)) return false;
    if (mv.ru && !q.ru) return false;
    if (isMovieSeries() && mv.season) {
      const cov = releaseSeasons(r.title || r.name);
      if (cov && !(cov.from <= mv.season && cov.to >= mv.season)) return false;
    }
    return true;
  });
}
function mvSorted(list) {
  const by = {
    best: (a, b) => b.w - a.w || (b.r.seed || 0) - (a.r.seed || 0),
    seed: (a, b) => (b.r.seed || 0) - (a.r.seed || 0),
    quality: (a, b) => b.q.score - a.q.score || (b.r.seed || 0) - (a.r.seed || 0),
    size: (a, b) => (b.r.size_bytes || 0) - (a.r.size_bytes || 0),
  };
  return list.slice().sort(by[mv.sort] || by.best);
}
function mvBestPick() {
  const list = mvFiltered(mvRanked()).filter(x => (x.r.seed || 0) > 0 && !x.q.bad).sort((a, b) => b.w - a.w);
  return list[0] || null;
}
/* Раздачи из библиотеки, подходящие к названию. */
function mvLibMatches() {
  const m = mv.spec;
  const year = isMovieSeries() ? 0 : Number(m.year) || 0;
  return (state.lib || []).filter(t => bestRelevant({ title: cleanSearchTitle(t.title || t.name || '').q || t.title }, mvTitleClean(), year) || bestRelevant({ title: t.title || t.name }, mvTitleClean(), year));
}

function mvPoster() { return (mv.meta && mv.meta.poster) || (mv.spec && mv.spec.poster) || ''; }
function paintMovie() {
  const el = $('#mv'); if (!el) return;
  const m = mv.spec;
  const meta = mv.meta || {};
  const tv = isMovieSeries();
  const poster = mvPoster();
  const year = m.year || (meta.year ? String(meta.year) : '');
  const over = meta.overview || m.overview || '';
  const rating = meta.rating || m.rating;
  const favIt = { kind: tv ? 'tv' : 'movie', id: meta.id || m.tmdb || 't_' + bestNorm(m.title), title: m.title, year, poster };
  el.innerHTML = html`
    <div class="mv-top"><button class="ghost" data-mv="back">${raw(ico('arrow', 15))}<span>Назад</span></button></div>
    <section class="mv-hero">
      ${raw(poster ? html`<img class="mv-bg" src="${pimg(poster)}" alt="">` : '')}
      <div class="mv-hero-in">
        <div class="mv-poster">${raw(poster ? html`<img src="${pimg(poster)}" alt="" onerror="this.remove()">` : ico('film', 44))}${raw(discFavHtml(favIt))}</div>
        <div class="mv-info">
          <h1 class="mv-title">${m.title}${raw(year ? html` <span class="mv-year">${year}</span>` : '')}</h1>
          <div class="mv-chips" id="mvChips"></div>
          <p class="mv-over" id="mvOver">${over || (mv.meta ? 'Описание не найдено.' : 'Загружаю описание…')}</p>
          <div class="mv-act">
            <button class="primary" id="mvWatch" data-mv="watch"></button>
            ${raw(tv ? '<button data-mv="follow" title="Демон сам сообщит о новых сериях">' + ico('bell', 16) + 'Следить</button>' : '')}
            <button data-mv="fav" class="${isFavTitle(favIt) ? 'on' : ''}">${raw(ico('heart', 16))}<span>${isFavTitle(favIt) ? 'В избранном' : 'В избранное'}</span></button>
            <button data-mv="trailer" class="ghost">${raw(ico('play', 15))}Трейлер</button>
            <button data-mv="kp" class="ghost">Кинопоиск</button>
          </div>
          <div class="mv-pick" id="mvPick"></div>
        </div>
      </div>
    </section>
    <section id="mvLib"></section>
    <section id="mvEps"></section>
    <section id="mvRel"></section>`;
  const fav = favIt; el._fav = fav;
  paintMovieHeadBits();
  paintMovieEps();
  paintMovieReleases();
}
function isFavTitle(it) { return favList().some(x => isTitleFav(x) && x.kind + ':' + x.tmdb === discFavKey(it)); }

function paintMovieHeadBits() {
  const meta = mv.meta || {};
  const chips = $('#mvChips'); if (!chips) return;
  const tv = isMovieSeries();
  const rating = meta.rating || (mv.spec && mv.spec.rating);
  chips.innerHTML = html`<span class="chip">${tv ? 'Сериал' : 'Фильм'}</span>
    ${raw(rating > 0 ? html`<span class="chip rating">TMDB ${Number(rating).toFixed(1)}</span>` : '')}
    ${raw(meta.imdb > 0 ? html`<span class="chip rt-imdb">IMDb ${Number(meta.imdb).toFixed(1)}</span>` : '')}
    ${raw(tv && mv.eps && mv.eps.seasons && mv.eps.seasons.length ? html`<span class="chip">${mv.eps.seasons.length} ${plural(mv.eps.seasons.length, 'сезон', 'сезона', 'сезонов')}</span>` : '')}`;
  const over = $('#mvOver');
  if (over && meta.overview && over.textContent !== meta.overview) over.textContent = meta.overview;
  const pick = mvBestPick();
  const lib = mvLibMatches();
  const w = $('#mvWatch');
  if (w) {
    const busy = Object.keys(mv.pending).length;
    if (lib.length && !tv) { w.innerHTML = ico('play', 16) + 'Смотреть из библиотеки'; w.disabled = false; w.dataset.mode = 'lib'; }
    else if (pick) { w.innerHTML = ico('play', 16) + 'Смотреть лучшую'; w.disabled = false; w.dataset.mode = 'best'; }
    else if (busy) { w.innerHTML = '<i class="spin"></i> Ищу раздачи…'; w.disabled = true; w.dataset.mode = ''; }
    else if (lib.length) { w.innerHTML = ico('play', 16) + 'Смотреть из библиотеки'; w.disabled = false; w.dataset.mode = 'lib'; }
    else { w.innerHTML = 'Живых раздач нет'; w.disabled = true; w.dataset.mode = ''; }
  }
  const pk = $('#mvPick');
  if (pk) {
    if (pick) {
      const rq = pick.q;
      pk.innerHTML = html`<span class="mv-pick-k">Лучший выбор</span> ${[rq.res, rq.source, rq.audio].filter(Boolean).join(' · ') || 'без пометок'} · ⬆ ${pick.r.seed || 0} раздающих${pick.r.size_bytes ? ' · ' + fmtSize(pick.r.size_bytes) : ''}${tv && mv.season ? ' · сезон ' + mv.season : ''}`;
    } else pk.textContent = '';
  }
}

/* ---- сезоны и серии ---- */
function mvEpisodeIndex() {
  // «сезон×серия» → где лежит серия в библиотеке и что с ней по просмотру.
  const idx = new Map();
  mvLibMatches().forEach(t => {
    const stat = (statCache[t.hash] && statCache[t.hash].data) || t;
    const tseason = (seriesInfo(t.title || '') || {}).s || 0;
    playableOf(stat).filter(f => isVideo(f.path)).forEach(f => {
      const pe = parseSeriesEp(basename(f.path));
      const s = (pe && pe.s) || tseason || 1;
      const e = pe && pe.e;
      if (!e) return;
      const k = s + 'x' + e;
      if (!idx.has(k)) idx.set(k, { t, f, mark: markOf(t, f.id) });
    });
  });
  return idx;
}
function mvSeasonList() {
  const out = new Map();
  ((mv.eps && mv.eps.seasons) || []).forEach(s => { if (s.number > 0) out.set(s.number, { n: s.number, eps: s.episodes || [], air: s.air_date, name: s.name }); });
  // Сезоны, которые видны только по раздачам и библиотеке.
  mvRelevant().forEach(r => { const c = releaseSeasons(r.title || r.name); if (c && c.to < 40) for (let n = c.from; n <= c.to; n++) if (!out.has(n)) out.set(n, { n, eps: [] }); });
  mvLibMatches().forEach(t => { const s = (seriesInfo(t.title || '') || {}).s; if (s && !out.has(s)) out.set(s, { n: s, eps: [] }); });
  return [...out.values()].sort((a, b) => a.n - b.n);
}
function paintMovieEps() {
  const el = $('#mvEps'); if (!el) return;
  if (!isMovieSeries()) { el.innerHTML = ''; return; }
  const seasons = mvSeasonList();
  if (!seasons.length) { el.innerHTML = mv.eps ? '' : html`<div class="mv-sec"><h2>Сезоны</h2><div class="page-sub">Загружаю список сезонов…</div></div>`; return; }
  const idx = mvEpisodeIndex();
  const cur = mv.season ? seasons.find(s => s.n === mv.season) : null;
  let seen = 0, have = 0, total = 0;
  seasons.forEach(s => { total += s.eps.length; s.eps.forEach(ep => { const it = idx.get(s.n + 'x' + ep.number); if (it) { have++; if (it.mark && it.mark.done) seen++; } }); });
  const chips = ['<button class="mv-ch' + (mv.season ? '' : ' on') + '" data-mv-season="0">Все</button>'].concat(seasons.map(s => {
    let sn = 0, sh = 0;
    s.eps.forEach(ep => { const it = idx.get(s.n + 'x' + ep.number); if (it) { sh++; if (it.mark && it.mark.done) sn++; } });
    return html`<button class="mv-ch${mv.season === s.n ? ' on' : ''}" data-mv-season="${s.n}" title="${s.eps.length ? 'серий: ' + s.eps.length + ', в библиотеке ' + sh + ', просмотрено ' + sn : ''}">Сезон ${s.n}${sn && s.eps.length ? raw(html` <i class="mv-ck">${sn}/${s.eps.length}</i>`) : ''}</button>`;
  })).join('');
  let list = '';
  if (cur && cur.eps.length) {
    list = '<div class="mv-eps">' + cur.eps.map(ep => {
      const it = idx.get(cur.n + 'x' + ep.number);
      const done = it && it.mark && it.mark.done;
      const tc = it && it.mark && !it.mark.done ? it.mark.timecode || 0 : 0;
      const aired = ep.air_date && new Date(ep.air_date) > new Date();
      const st = done ? '<span class="mv-ep-st ok">' + ico('check', 14) + 'просмотрено</span>' : tc > 0 ? '<span class="mv-ep-st cont">с ' + fmtPos(tc) + '</span>'
        : it ? '<span class="mv-ep-st lib">в библиотеке</span>' : aired ? '<span class="mv-ep-st soon">выйдет ' + esc(ep.air_date) + '</span>' : '<span class="mv-ep-st none">нет раздачи</span>';
      return html`<button class="mv-ep${done ? ' done' : ''}${it ? '' : ' off'}" data-mv-ep="${cur.n}x${ep.number}">
        <span class="mv-ep-n">${ep.number}</span>
        <span class="mv-ep-t"><b>${ep.name || 'Серия ' + ep.number}</b><small>${[ep.air_date, ep.runtime ? ep.runtime + ' мин' : ''].filter(Boolean).join(' · ')}</small></span>
        ${raw(st)}</button>`;
    }).join('') + '</div>';
  } else if (cur) list = '<div class="page-sub" style="margin:10px 0">Список серий этого сезона недоступен — раздачи ниже отфильтрованы по сезону.</div>';
  el.innerHTML = html`<div class="mv-sec"><div class="mv-sec-h"><h2>Сезоны и серии</h2>
      ${raw(total ? html`<span class="chip">просмотрено ${seen} из ${total}${have ? ' · в библиотеке ' + have : ''}</span>` : '')}</div>
    <div class="mv-chs">${raw(chips)}</div>${raw(list)}
    ${raw(cur && cur.air ? '' : '')}</div>`;
}

/* ---- раздачи ---- */
function paintMovieReleases() {
  const el = $('#mvRel'); if (!el) return;
  const libEl = $('#mvLib');
  const tv = isMovieSeries();
  const lib = mvLibMatches();
  if (libEl) {
    libEl.innerHTML = lib.length ? html`<div class="mv-sec"><div class="mv-sec-h"><h2>В вашей библиотеке</h2><span class="chip">${lib.length}</span></div>
      <div class="mv-rels">${raw(lib.slice(0, 8).map(t => { const l = libQuality(t); return html`<div class="rel-row lib">
        <span class="chip rq rq-${l.q.tier}" title="${l.tip}">${l.q.score}</span>
        <div class="rel-main"><div class="rel-title">${t.title || t.name}</div><div class="rel-tags">${[l.line, t.torrent_size ? fmtSize(t.torrent_size) : ''].filter(Boolean).join(' · ')}</div></div>
        <button class="primary" data-mv-lib="${t.hash}">${raw(ico('play', 15))}Смотреть</button></div>`; }).join(''))}</div></div>` : '';
  }
  const pend = Object.values(mv.pending);
  const all = mvRanked();
  const flt = mvSorted(mvFiltered(all));
  const bestKeyNow = (mvBestPick() || {}).r;
  const maxQ = all.length ? Math.max(...all.map(x => x.q.score)) : 0;
  const q = k => `<button class="mv-ch${mv.qual === k ? ' on' : ''}" data-mv-q="${k}">`;
  const rows = flt.slice(0, 60).map(x => {
    const { r, q: rq } = x;
    const cov = tv ? releaseSeasons(r.title || r.name) : null;
    const tags = [];
    if (r === bestKeyNow) tags.push('<span class="chip best">★ Лучший выбор</span>');
    if ((r.seed || 0) >= 30 && !rq.bad) tags.push('<span class="chip fast">быстрый старт</span>');
    if (rq.score === maxQ && r !== bestKeyNow && rq.score >= 60) tags.push('<span class="chip hq">лучшее качество</span>');
    if (cov && tv) tags.push('<span class="chip series">' + (cov.from === cov.to ? 'сезон ' + cov.from : cov.to >= 99 ? 'все сезоны' : 'сезоны ' + cov.from + '–' + cov.to) + '</span>');
    const meta = [rq.res, rq.source, rq.codec, rq.hdr, rq.audio].filter(Boolean).join(' · ');
    return html`<div class="rel-row${r === bestKeyNow ? ' top' : ''}">
      <span class="chip rq rq-${rq.tier}" title="${rateTip(rq)}">${rq.score}</span>
      <div class="rel-main">
        <div class="rel-title" title="${r.title || r.name}">${r.title || r.name}</div>
        <div class="rel-tags">${raw(tags.join(''))}<span>${meta || 'без пометок о качестве'}</span></div>
        <div class="rel-nums"><span>${r.size_bytes ? fmtSize(r.size_bytes) : (r.size || '')}</span><span class="${(r.seed || 0) >= 10 ? 'good' : (r.seed || 0) ? '' : 'bad'}">⬆ ${r.seed || 0}</span>${raw(r.peer != null ? '<span>⬇ ' + esc(r.peer) + '</span>' : '')}<span class="page-sub" style="margin:0">${(r._srcs || [r._p]).map(s => SRC_NAME[s] || s).join(' + ')}</span>${raw(rq.notes.length ? '<span class="rel-note">' + esc(rq.notes.join(', ')) + '</span>' : '')}</div>
      </div>
      <button class="iconbtn mv-relfav${relFav(r) ? ' on' : ''}" data-mv-relfav="${mv.rows.indexOf(r)}" title="${relFav(r) ? 'Убрать раздачу из избранного' : 'Эту раздачу — в избранное'}">${raw(ico('heart', 16))}</button>
      <button class="${r === bestKeyNow ? 'primary' : ''}" data-mv-rel="${mv.rows.indexOf(r)}">${raw(ico('play', 15))}Смотреть</button>
    </div>`;
  }).join('');
  el.innerHTML = html`<div class="mv-sec"><div class="mv-sec-h"><h2>Раздачи</h2><span class="chip">${flt.length}${flt.length !== all.length ? ' из ' + all.length : ''}</span>
      ${raw(pend.length ? html`<span class="hint src-wait" style="margin:0"><i class="spin"></i> ещё ищем: ${pend.join(', ')}</span>` : '')}<span class="spacer"></span>
      <select id="mvSort" style="width:auto" title="Сортировка"><option value="best" ${mv.sort === 'best' ? 'selected' : ''}>лучшие для просмотра</option><option value="seed" ${mv.sort === 'seed' ? 'selected' : ''}>по раздающим</option><option value="quality" ${mv.sort === 'quality' ? 'selected' : ''}>по качеству</option><option value="size" ${mv.sort === 'size' ? 'selected' : ''}>по размеру</option></select></div>
    <div class="mv-chs">${raw(q('') + 'Любое качество</button>' + q('4k') + '4K</button>' + q('fhd') + '1080p и выше</button>' + q('hd') + '720p и ниже</button>')}
      <button class="mv-ch${mv.ru ? ' on' : ''}" data-mv-ru>Русская дорожка</button></div>
    ${raw(tv && mv.season ? html`<div class="page-sub" style="margin:6px 0">Показаны раздачи сезона ${mv.season} и сборники, где он есть. <button class="link-btn" data-mv-season="0">Все сезоны</button></div>` : '')}
    ${raw(rows ? '<div class="mv-rels">' + rows + '</div>' : (pend.length ? skeleton('Ищу раздачи…', 4) : '<div class="empty">' + (all.length ? 'Под выбранные фильтры раздач нет.' : 'Живых раздач не нашлось.') + (mv.errs.length ? '</div><div class="hint" style="text-align:center">' + esc(mv.errs.join(' · ')) + '</div>' : '</div>')))}
    ${raw(rows && mv.errs.length ? html`<div class="hint">${mv.errs.join(' · ')}</div>` : '')}
    ${raw(flt.length > 60 ? html`<div class="page-sub" style="text-align:center;margin-top:8px">Показаны первые 60 из ${flt.length}. Уточните фильтры.</div>` : '')}</div>`;
  const so = $('#mvSort'); if (so) so.addEventListener('change', () => { mv.sort = so.value; paintMovieReleases(); });
}

/* Раздача из карточки — в избранное. В избранном она лежит как обычная
   раздача (запускается сразу), но с постером и названием фильма. */
const relFavKey = r => (r.hash || '') + '|' + (r.title || r.name || '');
function relFav(r) { const k = relFavKey(r); return favList().some(x => !isTitleFav(x) && (x.hash || '') + '|' + (x.title || '') === k); }
function toggleRelFav(r) {
  const m = mv.spec || {};
  addToUserlist(Object.assign({}, r, { poster: r.poster || mvPoster(), film: m.title, year: m.year || (mv.meta && mv.meta.year) || '' }));
  paintMovieReleases();
}
function onMovieClick(e) {
  if (state.view !== 'movie') return;
  const t = e.target;
  const go = t.closest('[data-go]'); if (go) { setView(go.dataset.go); return; }
  const fv = t.closest('.disc-fav');
  if (fv) { e.stopPropagation(); const it = $('#mv') && $('#mv')._fav; if (it) { toggleDiscFav(it); paintMovie(); } return; }
  const act = t.closest('[data-mv]');
  if (act) {
    const m = mv.spec, k = act.dataset.mv;
    if (k === 'back') { if (history.length > 1) history.back(); else setView('home'); }
    else if (k === 'watch') {
      if (act.dataset.mode === 'lib') { const l = mvLibMatches(); if (l.length) watchNow(l.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0]); }
      else { const p = mvBestPick(); if (p) playSearchLink(p.r); }
    }
    else if (k === 'follow') subsAdd(subsName(m.title), m.query || '');
    else if (k === 'fav') { const it = $('#mv')._fav; toggleDiscFav(it); paintMovie(); }
    else if (k === 'trailer') openTrailer({ title: m.title + (m.year ? ' ' + m.year : '') });
    else if (k === 'kp') openExternal(kpSearchUrl(m.title + (m.year ? ' ' + m.year : '')));
    return;
  }
  const se = t.closest('[data-mv-season]');
  if (se) { mv.season = Number(se.dataset.mvSeason) || 0; paintMovieEps(); paintMovieReleases(); paintMovieHeadBits(); return; }
  const q = t.closest('[data-mv-q]'); if (q) { mv.qual = q.dataset.mvQ; paintMovieReleases(); return; }
  if (t.closest('[data-mv-ru]')) { mv.ru = !mv.ru; paintMovieReleases(); return; }
  const rf = t.closest('[data-mv-relfav]'); if (rf) { const r = mv.rows[+rf.dataset.mvRelfav]; if (r) toggleRelFav(r); return; }
  const rel = t.closest('[data-mv-rel]'); if (rel) { const r = mv.rows[+rel.dataset.mvRel]; if (r) playSearchLink(r); return; }
  const lb = t.closest('[data-mv-lib]'); if (lb) { const x = (state.lib || []).find(y => y.hash === lb.dataset.mvLib); if (x) watchNow(x); return; }
  const ep = t.closest('[data-mv-ep]');
  if (ep) {
    const it = mvEpisodeIndex().get(ep.dataset.mvEp);
    if (it) { playSelected(it.t, it.f); return; }
    const sn = Number(ep.dataset.mvEp.split('x')[0]);
    mv.season = sn; paintMovieReleases(); paintMovieHeadBits();
    toast('Этой серии нет в библиотеке — выберите раздачу сезона ' + sn + ' ниже');
    const rel = $('#mvRel'); if (rel) rel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
/* ================= АУДИО =================
   Раздел с тремя вкладками: музыка, аудиокниги и радио. Всё играет прямо в
   окне одним плеером внизу раздела. Аудиораздачи живут здесь и не расходятся
   по программе: в Библиотеку, «Продолжить просмотр», Сериалы и Главную они не
   попадают (категории TorrServer music и audiobook).
   Строгость отбора — в два слоя: трекер ищет в своём разделе (rutor: 2 —
   музыка, 11 — книги), а выдача ещё раз проверяется по названию.
   Здесь — общее ядро: плеер, звук для танцовщицы и осциллографа, скорость и
   буфер, диагностика зависшей раздачи, перемешивание, обложки, вкладка
   «Музыка» с рекомендациями. Книги — 66-audiobooks.js, радио — 67-radio.js. */

const MUSIC_KEY = 'tc_music';
const MUSIC_AUDIO_RE = /\b(flac|mp3|aac|alac|ape|wav|wv|ogg|opus|m4a|dsd|dsf|lossless|hi-?res|\d{2,3}\s?kbps|\d{2}\s?bit|24-?bit|16-?bit|vbr|cbr|cue)\b|дискограф|discograph|альбом|album|сингл|single\b|\bep\b|\blp\b|саундтрек|soundtrack|\bost\b|сборник|compilation|мп3/i;
const MUSIC_VIDEO_RE = /\b(2160p|1080[pi]|720p|480p|bdrip|bd-?remux|blu-?ray|web-?dl|web-?rip|hdtv|dvd-?rip|dvd5|dvd9|x264|x265|hevc|avc|xvid|mkv|avi)\b|клип[ыа]?\b|концерт.*(видео|dvd)|video/i;
function isMusicRelease(title) {
  const t = String(title || '');
  return MUSIC_AUDIO_RE.test(t) && !MUSIC_VIDEO_RE.test(t);
}
function jsonPref(key, def) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? def : v; } catch { return def; } }
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
function musicList() { const a = jsonPref(MUSIC_KEY, []); return Array.isArray(a) ? a : []; }
function saveMusicList(l) { saveJson(MUSIC_KEY, l.slice(0, 300)); }
function musicHashes() { const s = new Set(musicList().map(x => x.hash).filter(Boolean)); (typeof bookList === 'function' ? bookList() : []).forEach(b => s.add(b.hash)); return s; }
/* isMusicTorrent — раздача принадлежит разделу «Аудио»: её добавили отсюда
   (категория music/audiobook у TorrServer или запись в списке). Раздачу со
   звуком, добавленную через Библиотеку, раздел не забирает. */
function isMusicTorrent(t, set) {
  if (!t) return false;
  const c = String(t.category || '').toLowerCase();
  if (c === 'music' || c === 'audiobook') return true;
  return (set || musicHashes()).has(t.hash);
}

const mu = { tab: savedPref('tc_autab', ['music', 'books', 'radio'], 'music'), q: '', rows: [], busy: false, err: '', queue: [], ix: -1, t: null, audio: null,
  kind: '', shuffle: localStorage.getItem('tc_mushuf') === '1', order: [], stats: null, statsAt: 0, diag: '', wd: null, switches: 0, alts: [], recs: null, recBusy: false };

/* ── звук: один граф Web Audio на все элементы ──
   Танцовщице и осциллографу радио нужен анализатор. createMediaElementSource
   можно вызвать на элементе один раз, и дальше звук идёт только через граф,
   поэтому подключаются лишь элементы, чей звук разрешено читать: свои потоки
   (/ts, /api/audio) и радио, ответившее с CORS. Чужой поток без CORS граф
   превратил бы в тишину. */
const auGraph = { ac: null, an: null, srcs: new WeakMap(), buf: null, wave: null };
function auHook(el) {
  if (!el || !window.AudioContext) return null;
  try {
    if (!auGraph.ac) {
      auGraph.ac = new AudioContext();
      auGraph.an = auGraph.ac.createAnalyser(); auGraph.an.fftSize = 2048; auGraph.an.smoothingTimeConstant = 0.5;
      auGraph.an.connect(auGraph.ac.destination);
      auGraph.buf = new Uint8Array(auGraph.an.frequencyBinCount); auGraph.wave = new Uint8Array(auGraph.an.fftSize);
    }
    if (!auGraph.srcs.has(el)) {
      const s = auGraph.ac.createMediaElementSource(el); s.connect(auGraph.an); auGraph.srcs.set(el, s);
      el.addEventListener('play', () => auGraph.ac.resume().catch(() => {}));
    }
    if (!el.paused) auGraph.ac.resume().catch(() => {});
    return auGraph.an;
  } catch { return null; }
}
// Что играет сейчас: элемент и можно ли читать его звук.
function auCurrent() {
  if (mu.kind === 'radio' && typeof radioEl === 'function') { const r = radioEl(); return r ? { el: r.el, analysable: r.cors } : null; }
  if (mu.audio && mu.audio.src && mu.ix >= 0) return { el: mu.audio, analysable: true };
  return null;
}
function auPlaying() { const c = auCurrent(); return !!(c && !c.el.paused && !c.el.ended); }
function auAnalyser() { const c = auCurrent(); if (!c || !c.analysable) return null; return auHook(c.el); }

/* ── вкладки ── */
async function renderMusic(root) {
  root.innerHTML = html`<div class="mu-wrap"><div class="mu">
    <div class="mu-head"><h1 class="page-title">Аудио</h1>
      <div class="au-tabs" role="tablist">${raw([['music', 'Музыка', 'music'], ['books', 'Аудиокниги', 'bookmark'], ['radio', 'Радио', 'sparkles']].map(([k, l, i]) => html`<button role="tab" class="${mu.tab === k ? 'on' : ''}" data-au-tab="${k}">${raw(ico(i, 15))}${l}</button>`).join(''))}</div></div>
    <div id="auBody"></div>
    <div id="muPlayer"></div>
  </div>${raw(dancerHtml())}</div>`;
  if (!root._muBound) { root._muBound = true; root.addEventListener('click', onMusicClick); }
  paintAudioTab();
  paintMusicPlayer();
  bindDancer();
}
function paintAudioTab() {
  const b = $('#auBody'); if (!b) return;
  document.querySelectorAll('[data-au-tab]').forEach(x => x.classList.toggle('on', x.dataset.auTab === mu.tab));
  if (mu.tab === 'books') return renderBooks(b);
  if (mu.tab === 'radio') return renderRadio(b);
  b.innerHTML = html`<div class="mu-search">
      <span class="sb-ico">${raw(ico('search', 18))}</span>
      <input id="muQ" placeholder="Исполнитель, альбом, саундтрек…" value="${mu.q}" autocomplete="off">
      <button id="muX" class="sb-clear${mu.q ? '' : ' hidden'}" type="button" title="Очистить (Esc)" aria-label="Очистить">${raw(ico('x', 15))}</button>
      <button id="muGo" class="primary">Найти</button>
    </div>
    <div id="muRes"></div>
    <div id="muMine"></div>
    <div id="muRecs"></div>`;
  const q = $('#muQ');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') musicSearch(); else if (e.key === 'Escape' && q.value) { e.preventDefault(); e.stopPropagation(); q.value = ''; mu.q = ''; $('#muX').classList.add('hidden'); paintMusicRes(); } });
  q.addEventListener('input', () => $('#muX').classList.toggle('hidden', !q.value));
  $('#muX').addEventListener('click', () => { q.value = ''; mu.q = ''; $('#muX').classList.add('hidden'); paintMusicRes(); q.focus(); });
  $('#muGo').addEventListener('click', () => musicSearch());
  paintMusicMine(); paintMusicRes(); paintRecs();
}

/* ── лучшая раздача: качество × скорость ──
   Качество — по формату и битрейту, и только то, что окно умеет играть: APE,
   WMA, DSD и ALAC встроенный плеер не откроет, такие раздачи идут вниз.
   Скорость — по числу раздающих (логарифм: разница 1 и 10 важнее, чем 100 и
   110). Раздача без раздающих почти обнуляется. */
function audioQuality(t) {
  t = String(t || '');
  const br = +(t.match(/\b(\d{2,3})\s?kbps\b/i) || [])[1] || 0;
  if (/\b(ape|wma|dsd|dsf|wv|wavpack)\b/i.test(t) && !/\b(flac|mp3)\b/i.test(t)) return 0.2;
  if (/\balac\b/i.test(t)) return 0.35;
  if (/\bflac\b|lossless|\bwav\b/i.test(t)) return /\b24\s?-?bit|hi-?res|96\s?khz|192\s?khz/i.test(t) ? 1 : 0.9;
  if (br >= 320) return 0.78; if (br >= 256) return 0.66; if (br >= 192) return 0.5; if (br >= 128) return 0.32;
  if (/\b(aac|m4a|opus|ogg)\b/i.test(t)) return 0.62;
  if (/\bmp3\b|мп3/i.test(t)) return 0.55;
  return 0.5;
}
function audioScore(r, speedW = 0.45) {
  const s = Number(r.seed) || 0;
  const sp = Math.min(1, Math.log10(1 + s) / Math.log10(51));
  let v = audioQuality(r.title || r.name) * (1 - speedW) + sp * speedW;
  if (s === 0) v *= 0.1;
  const sz = Number(r.size_bytes) || 0;
  if (sz > 8 * 2 ** 30) v *= 0.85; // огромные дискографии: первый трек дольше ищется
  return v;
}
function musicFmt(r) {
  const t = r.title || r.name || '';
  const fmt = (t.match(/\b(flac|alac|ape|wav|dsd|mp3|aac|ogg|opus|m4a)\b/i) || [])[1];
  const br = (t.match(/\b(\d{2,3})\s?kbps\b/i) || [])[1];
  const bit = (t.match(/\b(24|16)\s?-?bit\b/i) || [])[1];
  return [fmt && fmt.toUpperCase(), br && br + ' kbps', bit && bit + ' bit'].filter(Boolean).join(' · ');
}

async function audioTrackerSearch(q, cat, filter, speedW) {
  const got = [], jobs = [];
  let err = '';
  if (!state.rutorOff) jobs.push(withTimeout(searchRutor(q, 0, cat), SEARCH_TIMEOUT, 'rutor не ответил').then(r => got.push(...r)).catch(e => { err = e.message; }));
  jobs.push(withTimeout(searchKinozal(q, 0), SEARCH_TIMEOUT, 'Кинозал не ответил').then(r => got.push(...r)).catch(() => {}));
  await Promise.all(jobs);
  const seen = new Set();
  const rows = mergeResults([], got).filter(r => filter(r.title || r.name))
    .filter(r => { const k = r.hash || r.title; if (seen.has(k)) return false; seen.add(k); return true; });
  rows.forEach(r => { r._score = audioScore(r, speedW); });
  rows.sort((a, b) => b._score - a._score);
  return { rows: rows.slice(0, 60), err };
}
async function musicSearch(text, autoplay) {
  const q = (text != null ? text : ($('#muQ') && $('#muQ').value) || '').trim();
  if (!q) return toast('Введите исполнителя или альбом', true);
  if (mu.tab !== 'music') { mu.tab = 'music'; savePref('tc_autab', 'music'); paintAudioTab(); }
  const inp = $('#muQ'); if (inp && inp.value !== q) { inp.value = q; $('#muX').classList.remove('hidden'); }
  mu.q = q; mu.busy = true; mu.err = ''; mu.rows = [];
  paintMusicRes();
  const res = await audioTrackerSearch(q, 2, isMusicRelease, 0.45);
  if (mu.q !== q) return;
  mu.rows = res.rows; mu.err = res.err; mu.busy = false;
  paintMusicRes();
  if (autoplay && mu.rows.length) musicOpen(mu.rows[0], false, mu.rows.slice(1));
}
function paintMusicRes() {
  const el = $('#muRes'); if (!el) return;
  if (mu.busy) { el.innerHTML = skeleton('Ищу музыку и выбираю лучшую раздачу…', 3); return; }
  if (!mu.q) { el.innerHTML = ''; return; }
  if (!mu.rows.length) { el.innerHTML = html`<div class="empty">Музыкальных раздач не нашлось.${mu.err ? ' ' + mu.err : ''}</div>`; return; }
  const mine = musicHashes();
  el.innerHTML = html`<div class="mu-h">Найдено ${mu.rows.length} · сверху лучшая по качеству и скорости
      <button class="btn sm primary mu-best" data-mu-play="0">${raw(ico('play', 13))} Слушать лучшую</button></div>
    <div class="mu-list">${raw(mu.rows.map((r, i) => html`
    <div class="mu-row${i === 0 ? ' best' : ''}">
      <button class="mu-play" data-mu-play="${i}" title="Слушать">${raw(ico('play', 14))}</button>
      <div class="mu-main"><div class="mu-t" title="${r.title || r.name}">${i === 0 ? raw('<span class="mu-badge">лучшая</span>') : ''}${r.title || r.name}</div>
        <div class="mu-s">${[musicFmt(r), r.size_bytes ? fmtSize(r.size_bytes) : r.size || '', '⬆ ' + (r.seed || 0), audioQuality(r.title) <= 0.35 ? 'не играет в окне' : ''].filter(Boolean).join(' · ')}</div></div>
      <span class="mu-score" title="Оценка: качество и скорость">${Math.round((r._score || 0) * 100)}</span>
      <button class="iconbtn${r.hash && mine.has(r.hash) ? ' on' : ''}" data-mu-save="${i}" title="В мою музыку">${raw(ico('plus', 15))}</button>
    </div>`).join(''))}</div>`;
  hydrateCovers(el);
}

/* ── моя музыка: сетка обложек ── */
function paintMusicMine() {
  const el = $('#muMine'); if (!el) return;
  const l = musicList();
  if (!l.length) { el.innerHTML = ''; return; }
  el.innerHTML = html`<div class="mu-h">Моя музыка</div><div class="au-grid">${raw(l.map((x, i) => html`
    <div class="au-card${mu.t && mu.t.hash === x.hash ? ' on' : ''}">
      <button class="au-cover" data-mu-mine="${i}" title="Слушать: ${x.title}">${raw(coverImg(x.title, x.hash))}<span class="au-cover-play">${raw(ico(mu.t && mu.t.hash === x.hash && auPlaying() ? 'pause' : 'play', 22))}</span></button>
      <div class="au-card-t" title="${x.title}">${x.title}</div>
      <button class="au-card-x" data-mu-drop="${i}" title="Убрать из моей музыки">×</button>
    </div>`).join(''))}</div>`;
  hydrateCovers(el);
}

/* Раздача добавляется в TorrServer с категорией: так её узнают и после
   перезапуска, и с другого окна, где нет записи в localStorage. */
async function audioAddRelease(r, category) {
  let hash = r.hash || ((r.magnet || '').match(/btih:([0-9a-fA-F]{40})/i) || [])[1] || '';
  if (!hash && (r.get || r.link)) {
    toast('Забираю раздачу с Кинозала…');
    const rr = await fetch('/api/kinozal/add?url=' + encodeURIComponent(r.get || r.link) + '&title=' + encodeURIComponent(r.title || '') + '&size=' + encodeURIComponent(r.size || ''), { method: 'POST' });
    const j = await rr.json().catch(() => null);
    if (!rr.ok || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + rr.status);
    if (j.magnet) await torrentAction('add', { link: j.magnet, save_to_db: true, category }).catch(() => {});
    hash = ((j.hash || j.magnet || '').match(/([0-9a-fA-F]{40})/) || [])[1] || '';
  }
  hash = String(hash).toLowerCase();
  if (!hash) throw new Error('не удалось узнать хеш раздачи');
  const title = cleanMusicTitle(r.title || r.name || hash);
  await torrentAction('add', { link: r.magnet || magnetFromHash(hash, title), title, category, save_to_db: true }).catch(() => {});
  await torrentAction('set', { hash, title, category }).catch(() => {});
  return { hash, title };
}
async function musicOpen(r, keep, alts) {
  try {
    const { hash, title } = await audioAddRelease(r, 'music');
    const l = musicList();
    if (!l.some(x => x.hash === hash)) { l.unshift({ hash, title, added: Date.now() }); saveMusicList(l); }
    else if (keep) toast('Уже в вашей музыке');
    paintMusicMine(); paintMusicRes();
    if (keep) { toast('Добавлено в музыку'); return; }
    // Запасные раздачи того же запроса — для переключения, если эта не отдаёт.
    mu.alts = alts || mu.rows.filter(x => x !== r);
    await musicPlayHash(hash, title);
  } catch (e) { toast('Музыка: ' + e.message, true); }
}
function cleanMusicTitle(t) {
  const s = String(t || '').replace(/\s*[\[(](?:flac|mp3|aac|alac|ape|\d{2,3}\s?kbps|lossless|24.?bit|16.?bit|web|cd)[^\])]*[\])]/gi, '').replace(/\s*\|\s*.*$/, '').replace(/\s{2,}/g, ' ').trim();
  return s.length > 2 ? s.slice(0, 120) : String(t || '').slice(0, 120);
}
const COVER_FILE_RE = /(^|\/)(cover|folder|front|albumart[^/]*|обложка)\.(jpe?g|png|webp)$/i;
async function musicPlayHash(hash, title, kind, known) {
  // known — список файлов, сохранённый заранее: книге, скачанной для
  // офлайна, TorrServer и сеть для старта не нужны.
  const st = known ? { file_stats: known } : await waitForFiles({ hash, title });
  if (!st) { audioDiag('Раздача не отдала список файлов — нет раздающих или TorrServer не ответил', true); return musicFallback('нет списка файлов'); }
  const files = (st.file_stats || []).filter(f => isAudio(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'ru', { numeric: true }));
  if (!files.length) { toast('В раздаче нет аудиофайлов, которые играют в окне', true); return musicFallback('нет аудио'); }
  if (kind === 'book' && typeof bookKeepFiles === 'function') bookKeepFiles(hash, files);
  const cov = (st.file_stats || []).find(f => COVER_FILE_RE.test(f.path));
  if (cov) coverRemember(title, hash, ts(`/stream/${encodeURIComponent(basename(cov.path))}?link=${encodeURIComponent(hash)}&index=${cov.id}&play`));
  if (typeof radioStop === 'function' && rd.station) radioStop();
  mu.kind = kind || 'track';
  mu.t = { hash, title }; mu.queue = files; mu.order = [];
  const start = kind === 'book' && typeof bookResumeIx === 'function' ? bookResumeIx(hash, files) : (mu.shuffle ? Math.floor(Math.random() * files.length) : 0);
  musicPlayIx(start);
  paintMusicMine();
}
function musicAudio() {
  if (mu.audio) return mu.audio;
  // Элемент живёт в body: переход по разделам не обрывает трек на середине.
  const a = document.createElement('audio');
  a.preload = 'auto'; a.id = 'muAudio';
  a.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('tc_muvol') || 0.8)));
  a.addEventListener('ended', () => { if (mu.kind === 'book') bookSavePos(true); musicNext(1, true); });
  a.addEventListener('timeupdate', () => { paintMusicProgress(); auNoteListen(); if (mu.kind === 'book') bookSavePos(); });
  a.addEventListener('playing', () => { if (mu.wd) { mu.wd.playing = true; mu.wd.stall = 0; } mu.switches = 0; audioDiag(''); });
  a.addEventListener('waiting', () => { if (mu.wd) mu.wd.stall = mu.wd.stall || Date.now(); });
  a.addEventListener('stalled', () => { if (mu.wd) mu.wd.stall = mu.wd.stall || Date.now(); });
  a.addEventListener('play', () => { paintMusicPlayer(); paintNowPlaying(); paintMusicMine(); });
  a.addEventListener('pause', () => { paintMusicPlayer(); paintNowPlaying(); paintMusicMine(); if (mu.kind === 'book') bookSavePos(true); });
  a.addEventListener('error', () => { if (mu.ix >= 0 && mu.kind !== 'radio') audioOnError(); });
  document.body.appendChild(a);
  mu.audio = a;
  return a;
}
function musicSrcFor(f) {
  const off = mu.kind === 'book' && typeof bookOfflinePath === 'function' ? bookOfflinePath(mu.t.hash, f.id) : '';
  if (off) return '/api/audio/local?p=' + encodeURIComponent(off);
  return ts(`/stream/${encodeURIComponent(basename(f.path))}?link=${encodeURIComponent(mu.t.hash)}&index=${f.id}&play`);
}
function musicPlayIx(i, at) {
  if (i < 0 || i >= mu.queue.length) return;
  mu.ix = i;
  const f = mu.queue[i];
  const a = musicAudio();
  a.src = musicSrcFor(f);
  a.playbackRate = mu.kind === 'book' ? bookSpeed() : 1;
  const resume = at != null ? at : (mu.kind === 'book' && typeof bookResumeAt === 'function' ? bookResumeAt(mu.t.hash, i) : 0);
  if (resume > 1) a.addEventListener('loadedmetadata', () => { try { a.currentTime = resume; } catch {} }, { once: true });
  a.play().catch(() => {});
  mu.wd = { ix: i, start: Date.now(), playing: false, stall: 0, src: a.src, noted: false };
  mu.diag = '';
  dancerNewTrack();
  paintMusicPlayer(); paintNowPlaying();
  statsTick(true);
}
/* Перемешивание: порядок — случайная перестановка, без повторов, пока не
   пройдены все треки; включается и выключается на ходу. */
function shuffleOrder() {
  const n = mu.queue.length, rest = [...Array(n).keys()].filter(i => i !== mu.ix);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  mu.order = rest;
}
function musicNext(d, auto) {
  if (mu.kind === 'radio') return radioNext(d);
  if (mu.shuffle && mu.kind !== 'book' && d > 0) {
    if (!mu.order.length) { if (auto && mu.wd && mu.wd.looped) return musicEnd(); shuffleOrder(); if (mu.wd) mu.wd.looped = true; }
    return musicPlayIx(mu.order.shift());
  }
  if (mu.ix + d >= 0 && mu.ix + d < mu.queue.length) musicPlayIx(mu.ix + d); else musicEnd();
}
function musicEnd() { paintMusicPlayer(); paintNowPlaying(); }
function musicToggle() {
  if (mu.kind === 'radio') return radioToggle();
  const a = musicAudio(); if (!a.src) return; if (a.paused) a.play().catch(() => {}); else a.pause();
}
function musicStop() {
  if (mu.kind === 'radio') { radioStop(); }
  if (mu.audio) { if (mu.kind === 'book') bookSavePos(true); mu.audio.pause(); mu.audio.removeAttribute('src'); mu.audio.load(); }
  mu.ix = -1; mu.t = null; mu.queue = []; mu.kind = ''; mu.wd = null; mu.diag = '';
  paintMusicPlayer(); paintNowPlaying(); paintMusicMine();
}
function musicTrackName(f) { return f ? basename(f.path).replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, '') : ''; }
// для «Сейчас играет» в шапке
function auNowInfo() {
  if (mu.kind === 'radio' && typeof radioNow === 'function') return radioNow();
  if (mu.t && mu.ix >= 0 && mu.audio && mu.audio.src) return { label: musicTrackName(mu.queue[mu.ix]), sub: mu.audio.paused ? 'пауза' : mu.kind === 'book' ? 'аудиокнига' : 'музыка', paused: mu.audio.paused };
  return null;
}
function toggleShuffle() {
  mu.shuffle = !mu.shuffle; savePref('tc_mushuf', mu.shuffle ? '1' : '0'); mu.order = [];
  toast(mu.shuffle ? 'Вперемешку: включено' : 'Вперемешку: выключено');
  paintMusicPlayer();
}

/* ── плеер внизу раздела ── */
function paintMusicPlayer() {
  const el = $('#muPlayer'); if (!el) return;
  if (mu.kind === 'radio' && typeof radioBarHtml === 'function') { el.innerHTML = radioBarHtml(); bindRadioBar(); return; }
  if (!mu.t || mu.ix < 0) { el.innerHTML = ''; return; }
  const a = mu.audio;
  const f = mu.queue[mu.ix];
  const book = mu.kind === 'book';
  el.innerHTML = html`<div class="mu-bar">
    <div class="mu-bar-cov">${raw(coverImg(mu.t.title, mu.t.hash))}</div>
    <div class="mu-bar-t"><b title="${musicTrackName(f)}">${musicTrackName(f)}</b><small>${mu.t.title} · ${mu.ix + 1}/${mu.queue.length}</small></div>
    <div class="mu-ctl">
      ${raw(book ? html`<button class="iconbtn" data-bk-back title="Назад на 15 секунд">↺15</button>` : html`<button class="iconbtn${mu.shuffle ? ' on' : ''}" data-mu-shuf title="Вперемешку">🔀</button>`)}
      <button class="iconbtn" data-mu-prev title="Предыдущий" ${mu.ix > 0 || mu.shuffle ? '' : 'disabled'}>${raw(ico('prev', 16))}</button>
      <button class="iconbtn mu-pp" data-mu-pp title="Пауза / играть">${raw(ico(a && !a.paused ? 'pause' : 'play', 17))}</button>
      <button class="iconbtn" data-mu-next title="Следующий" ${mu.ix < mu.queue.length - 1 || mu.shuffle ? '' : 'disabled'}>${raw(ico('next', 16))}</button>
      ${raw(book ? html`<button class="iconbtn" data-bk-fwd title="Вперёд на 30 секунд">30↻</button><button class="iconbtn" data-bk-mark title="Закладка здесь">${raw(ico('bookmark', 15))}</button>` : '')}
      <button class="iconbtn" data-mu-stop title="Остановить">${raw(ico('stop', 14))}</button>
    </div>
    <input type="range" class="mu-seek" min="0" max="1000" value="0" id="muSeek" title="Перемотка">
    <span class="mu-time" id="muTime">0:00</span>
    ${raw(book ? html`<select id="bkSpeed" class="mu-speed" title="Скорость чтения">${raw([0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}" ${Math.abs(bookSpeed() - v) < 0.01 ? 'selected' : ''}>${v}×</option>`).join(''))}</select>` : '')}
    <input type="range" class="mu-vol" min="0" max="100" value="${Math.round((a ? a.volume : 0.8) * 100)}" id="muVol" title="Громкость">
    <details class="mu-q"><summary title="Список треков">≡</summary><div>${raw(mu.queue.map((x, i) => html`<button class="${i === mu.ix ? 'on' : ''}" data-mu-ix="${i}">${i + 1}. ${musicTrackName(x)}</button>`).join(''))}</div></details>
    <div class="mu-stat" id="muStat">${raw(statsHtml())}</div>
  </div>`;
  const sk = $('#muSeek'); sk.addEventListener('input', () => { const au = mu.audio; if (au && isFinite(au.duration)) au.currentTime = au.duration * sk.value / 1000; });
  const vo = $('#muVol'); vo.addEventListener('input', () => { const au = musicAudio(); au.volume = vo.value / 100; savePref('tc_muvol', au.volume); });
  const sp = $('#bkSpeed'); if (sp) sp.addEventListener('change', () => { bookSetSpeed(+sp.value); if (mu.audio) mu.audio.playbackRate = +sp.value; });
  hydrateCovers(el);
  paintMusicProgress();
}
function paintMusicProgress() {
  const a = mu.audio; if (!a || mu.kind === 'radio') return;
  const sk = $('#muSeek'), tm = $('#muTime');
  if (sk && isFinite(a.duration) && a.duration > 0 && document.activeElement !== sk) sk.value = Math.round(a.currentTime / a.duration * 1000);
  if (tm) tm.textContent = fmtPos(a.currentTime || 0) + (isFinite(a.duration) ? ' / ' + fmtPos(a.duration) : '');
}

/* ── скорость, раздающие, буфер ── */
function audioBufferedAhead() {
  const a = mu.audio; if (!a || !a.buffered) return 0;
  for (let i = 0; i < a.buffered.length; i++) if (a.buffered.start(i) <= a.currentTime + 0.5 && a.buffered.end(i) >= a.currentTime) return Math.max(0, a.buffered.end(i) - a.currentTime);
  return 0;
}
function statsHtml() {
  if (mu.kind === 'radio') return '';
  const s = mu.stats, off = mu.kind === 'book' && mu.t && bookOfflinePath(mu.t.hash, (mu.queue[mu.ix] || {}).id);
  const parts = [];
  if (off) parts.push('<span class="ok">● офлайн, с диска</span>');
  else if (s) {
    parts.push('↓ ' + fmtSpeed(Number(s.download_speed) || 0));
    parts.push((s.active_peers || 0) + ' из ' + (s.total_peers || 0) + ' пиров' + (s.connected_seeders != null ? ' · ' + s.connected_seeders + ' разд.' : ''));
  }
  const ahead = audioBufferedAhead();
  if (mu.audio && mu.audio.src) parts.push('буфер ' + (ahead >= 600 ? '10+ мин' : Math.round(ahead) + ' с'));
  if (mu.wd && !mu.wd.playing && !mu.diag) parts.push('подгружаю… ' + Math.round((Date.now() - mu.wd.start) / 1000) + ' с');
  if (mu.diag) parts.push(`<span class="err">⚠ ${esc(mu.diag)}</span>`);
  return parts.join('<i>·</i>');
}
let statsTimer = 0;
async function statsTick(now) {
  clearTimeout(statsTimer);
  if (!mu.t || mu.ix < 0 || mu.kind === 'radio') return;
  statsTimer = setTimeout(statsTick, 2000);
  if (!now && document.hidden) return;
  if (!(mu.kind === 'book' && bookOfflinePath(mu.t.hash, (mu.queue[mu.ix] || {}).id))) {
    try { const st = await torrentAction('get', { hash: mu.t.hash }); mu.stats = st; } catch { mu.stats = null; }
  }
  audioWatchdog();
  const el = $('#muStat'); if (el) el.innerHTML = statsHtml();
}

/* ── диагностика: почему не играет, и что делать ──
   Трек не начался за 20 с или стоит 25 с: смотрим на раздачу. Нет пиров —
   раздача мёртвая, переключаемся на следующую лучшую из того же поиска.
   Пиры есть, но скорость ниже 16 КБ/с — то же самое. Ошибка формата —
   пропускаем трек. Переключений не больше трёх подряд, чтобы не бегать по
   кругу. */
function audioDiag(text, bad) { mu.diag = text || ''; const el = $('#muStat'); if (el) el.innerHTML = statsHtml(); if (text && bad) notifPush({ kind: 'warn', title: 'Аудио', text }); }
function audioWatchdog() {
  const w = mu.wd, a = mu.audio; if (!w || !a || mu.kind === 'radio' || a.paused && w.playing) return;
  const now = Date.now(), s = mu.stats || {};
  const notStarted = !w.playing && now - w.start > 20000;
  const stalled = w.playing && w.stall && now - w.stall > 25000;
  if (!notStarted && !stalled) return;
  const peers = Number(s.active_peers) || 0, speed = Number(s.download_speed) || 0;
  let why = '';
  if (!mu.stats) why = 'TorrServer не отвечает о раздаче';
  else if (!peers && !Number(s.total_peers)) why = 'нет раздающих — раздача мёртвая';
  else if (!peers) why = 'пиры известны, но ни один не подключился';
  else if (speed < 16 * 1024) why = 'раздающие почти не отдают (' + fmtSpeed(speed) + ')';
  else why = 'данные идут, но плеер не стартует — возможно, формат';
  w.start = now; w.stall = 0;
  audioDiag(why);
  if (/формат/.test(why)) return audioOnError();
  musicFallback(why);
}
function audioOnError() {
  const f = mu.queue[mu.ix] || {}, ext = ((f.path || '').match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const err = mu.audio && mu.audio.error;
  const why = err && err.code === 4 ? 'формат .' + ext + ' не играет в окне' : 'поток оборвался';
  audioDiag(why);
  if (mu.switches++ < 6 && mu.ix < mu.queue.length - 1) { toast('Пропускаю трек: ' + why); setTimeout(() => musicNext(1, true), 600); }
}
async function musicFallback(why) {
  if (mu.kind === 'book') { toast('Аудиокнига: ' + why + '. Попробуйте позже или скачайте для офлайна', true); return; }
  const alt = (mu.alts || []).find(r => (Number(r.seed) || 0) > 0 && audioQuality(r.title) > 0.35 && r.hash !== (mu.t && mu.t.hash));
  if (!alt || mu.switches >= 3) { toast('Раздача не отдаёт: ' + why + '. Других живых раздач нет', true); return; }
  mu.switches++;
  mu.alts = mu.alts.filter(r => r !== alt);
  toast('Раздача не отдаёт (' + why + ') — переключаюсь на другую: ' + cleanMusicTitle(alt.title));
  await musicOpen(alt, false, mu.alts);
}

/* ── вкус: кого вы слушаете ── */
function artistOf(title) {
  const t = cleanMusicTitle(title).replace(/^\s*\(?\d{4}\)?\s*[-–—]?\s*/, '');
  const m = t.split(/\s+[-–—]\s+/);
  const a = (m.length > 1 ? m[0] : t.replace(/\s*[\[(].*$/, '')).replace(/\s*\b(дискография|discography)\b.*$/i, '').trim();
  return a.length > 1 && a.length < 60 ? a : '';
}
function albumOf(title) {
  const t = cleanMusicTitle(title), m = t.split(/\s+[-–—]\s+/);
  return (m.length > 1 ? m.slice(1).join(' ') : '').replace(/\s*[\[(]\d{4}[\])]/g, '').replace(/\s*[\[(][^\])]*[\])]\s*$/g, '').trim();
}
function auNoteListen() {
  const w = mu.wd, a = mu.audio;
  if (!w || w.noted || mu.kind !== 'track' || !a || a.currentTime < 30) return;
  w.noted = true;
  const name = artistOf(mu.t.title); if (!name) return;
  const h = jsonPref('tc_muhist', {}), k = name.toLowerCase();
  h[k] = { name, plays: ((h[k] && h[k].plays) || 0) + 1, last: Date.now() };
  const keys = Object.keys(h); if (keys.length > 300) keys.sort((x, y) => h[x].last - h[y].last).slice(0, keys.length - 300).forEach(x => delete h[x]);
  saveJson('tc_muhist', h);
  mu.recs = null;
}
function topArtists(n) {
  const h = jsonPref('tc_muhist', {});
  musicList().forEach(x => { const a = artistOf(x.title); if (a && !h[a.toLowerCase()]) h[a.toLowerCase()] = { name: a, plays: 0.5, last: x.added || 0 }; });
  const now = Date.now();
  return Object.values(h).map(x => Object.assign({}, x, { w: x.plays * Math.exp(-(now - x.last) / (60 * 864e5)) + 0.1 })).sort((a, b) => b.w - a.w).slice(0, n);
}

/* ── обложки ──
   Сначала картинка из самой раздачи (cover.jpg, folder.jpg), потом Deezer,
   потом iTunes. Найденное запоминается; картинки идут через демон и лежат на
   диске. Не нашлось — градиент с инициалами. */
const coverMem = jsonPref('tc_mucover', {});
let coverSaveT = 0;
function coverKey(title) { return (artistOf(title) + ' ' + albumOf(title)).toLowerCase().trim() || cleanMusicTitle(title).toLowerCase(); }
function coverRemember(title, hash, url) {
  coverMem['h:' + hash] = url; if (title) coverMem[coverKey(title)] = coverMem[coverKey(title)] || url;
  clearTimeout(coverSaveT); coverSaveT = setTimeout(() => { const k = Object.keys(coverMem); if (k.length > 600) k.slice(0, k.length - 600).forEach(x => delete coverMem[x]); saveJson('tc_mucover', coverMem); }, 800);
}
function coverProxy(u) { return /^https:\/\//.test(u) ? '/api/audio/img?u=' + encodeURIComponent(u) : u; }
function coverFallback(title) {
  const s = artistOf(title) || cleanMusicTitle(title) || '?';
  let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const ini = s.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return `<span class="au-ph" style="--h1:${h % 360};--h2:${(h >> 8) % 360}">${esc(ini)}</span>`;
}
function coverImg(title, hash, kind) {
  const u = (hash && coverMem['h:' + hash]) || coverMem[coverKey(title)];
  if (u) return `<img src="${esc(coverProxy(u))}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'au-ph'}))">`;
  if (u === '') return coverFallback(title);
  return `<span class="au-cv" data-cover="${esc(title)}" data-cover-kind="${kind || 'album'}">${coverFallback(title)}</span>`;
}
const coverQueue = new Set();
let coverBusy = 0;
function hydrateCovers(root) {
  (root || document).querySelectorAll('[data-cover]').forEach(el => { if (!el._q) { el._q = 1; coverQueue.add(el); } });
  pumpCovers();
}
async function pumpCovers() {
  while (coverBusy < 3 && coverQueue.size) {
    const el = coverQueue.values().next().value; coverQueue.delete(el);
    if (!el.isConnected) continue;
    coverBusy++;
    coverFind(el.dataset.cover, el.dataset.coverKind).then(u => {
      document.querySelectorAll('[data-cover]').forEach(x => { if (x.dataset.cover === el.dataset.cover) x.outerHTML = u ? `<img src="${esc(coverProxy(u))}" alt="" loading="lazy">` : coverFallback(el.dataset.cover); });
    }).finally(() => { coverBusy--; pumpCovers(); });
  }
}
async function coverFind(title, kind) {
  const key = coverKey(title);
  if (coverMem[key] != null) return coverMem[key];
  const artist = artistOf(title), album = albumOf(title);
  const q = (artist + ' ' + album).trim() || cleanMusicTitle(title);
  let url = '';
  try {
    if (kind === 'book') {
      const j = await api('/api/audio/itunes?entity=audiobook&term=' + encodeURIComponent(q));
      const r = (j.results || [])[0]; if (r && r.artworkUrl100) url = r.artworkUrl100.replace(/100x100bb/, '600x600bb');
    } else {
      const j = await api('/api/audio/deezer?p=' + encodeURIComponent('search/album?q=' + encodeURIComponent(q) + '&limit=1'));
      const r = (j.data || [])[0]; if (r) url = r.cover_xl || r.cover_big || '';
      if (!url && artist) { const a = await api('/api/audio/deezer?p=' + encodeURIComponent('search/artist?q=' + encodeURIComponent(artist) + '&limit=1')); const x = (a.data || [])[0]; if (x) url = x.picture_xl || x.picture_big || ''; }
    }
  } catch {}
  if (!url) { try { const j = await api('/api/audio/itunes?entity=album&term=' + encodeURIComponent(q)); const r = (j.results || [])[0]; if (r && r.artworkUrl100) url = r.artworkUrl100.replace(/100x100bb/, '600x600bb'); } catch {} }
  coverMem[key] = url; coverRemember('', '_', ''); delete coverMem['h:_'];
  return url;
}

/* ── рекомендации ──
   Ваши исполнители (что дослушиваете, что в «Моей музыке») → похожие у
   Deezer, сложенные по всем вашим исполнителям: кто похож на нескольких
   сразу, тот выше. Плюс свежие альбомы ваших исполнителей. Без истории —
   чарт. Клик — поиск лучшей раздачи. */
const deezer = p => api('/api/audio/deezer?p=' + encodeURIComponent(p));
async function buildRecs() {
  const seeds = topArtists(5), out = { similar: [], fresh: [], chart: [] };
  const own = new Set(topArtists(60).map(x => x.name.toLowerCase()));
  const score = new Map();
  await Promise.all(seeds.map(async (s, si) => {
    try {
      const a = ((await deezer('search/artist?q=' + encodeURIComponent(s.name) + '&limit=1')).data || [])[0]; if (!a) return;
      const [rel, alb] = await Promise.all([deezer('artist/' + a.id + '/related?limit=12'), deezer('artist/' + a.id + '/albums?limit=8')]);
      (rel.data || []).forEach((r, i) => {
        if (own.has(String(r.name).toLowerCase())) return;
        const cur = score.get(r.id) || { a: r, v: 0, because: [] };
        cur.v += (12 - i) * (5 - si); if (cur.because.length < 2) cur.because.push(s.name); score.set(r.id, cur);
      });
      const half = Date.now() - 200 * 864e5;
      (alb.data || []).filter(x => x.release_date && Date.parse(x.release_date) > half).forEach(x => out.fresh.push({ artist: a.name, title: x.title, cover: x.cover_xl || x.cover_big, date: x.release_date }));
    } catch {}
  }));
  out.similar = [...score.values()].sort((a, b) => b.v - a.v).slice(0, 14).map(x => ({ name: x.a.name, pic: x.a.picture_xl || x.a.picture_big, fans: x.a.nb_fan, because: x.because, id: x.a.id }));
  out.fresh.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  if (!out.similar.length) { try { out.chart = ((await deezer('chart/0/albums?limit=14')).data || []).map(x => ({ artist: x.artist && x.artist.name, title: x.title, cover: x.cover_xl || x.cover_big })); } catch {} }
  return out;
}
async function paintRecs(force) {
  const el = $('#muRecs'); if (!el) return;
  if (!mu.recs || force) {
    if (mu.recBusy) return;
    mu.recBusy = true; el.innerHTML = skeleton('Подбираю музыку под ваш вкус…', 1);
    try { mu.recs = await buildRecs(); } catch { mu.recs = { similar: [], fresh: [], chart: [], err: true }; }
    mu.recBusy = false;
    if (!$('#muRecs')) return;
  }
  const r = mu.recs;
  const card = (q, img, t1, t2, extra) => html`<div class="au-card rec"><button class="au-cover" data-mu-find="${q}" title="Найти лучшую раздачу и слушать">${raw(img ? `<img src="${esc(coverProxy(img))}" alt="" loading="lazy">` : coverFallback(q))}<span class="au-cover-play">${raw(ico('play', 22))}</span></button>
    <div class="au-card-t" title="${t1}">${t1}</div><div class="au-card-s">${t2}</div>${raw(extra || '')}</div>`;
  let h = '';
  if (r.similar.length) h += html`<div class="mu-h">Похоже на ваше <button class="btn sm ghost" data-mu-recs title="Обновить">${raw(ico('refresh', 13))}</button></div><div class="au-grid">${raw(r.similar.map(x => card(x.name, x.pic, x.name, 'как ' + x.because.join(', '), x.id ? html`<button class="au-prev" data-mu-preview="${x.id}" title="Отрывок 30 с">▶ отрывок</button>` : '')).join(''))}</div>`;
  if (r.fresh.length) h += html`<div class="mu-h">Новинки ваших исполнителей</div><div class="au-grid">${raw(r.fresh.slice(0, 10).map(x => card(x.artist + ' - ' + x.title, x.cover, x.title, x.artist + ' · ' + fmtAirDate(x.date))).join(''))}</div>`;
  if (r.chart.length) h += html`<div class="mu-h">Чарт — пока мы не знаем ваш вкус</div><div class="au-grid">${raw(r.chart.map(x => card(x.artist + ' - ' + x.title, x.cover, x.title, x.artist || '')).join(''))}</div>`;
  if (!h) h = html`<div class="empty sm">${r.err ? 'Сервисы рекомендаций сейчас не отвечают.' : 'Послушайте что-нибудь — и здесь появятся похожие исполнители и новинки.'}</div>`;
  el.innerHTML = h;
}
let previewEl = null;
async function playPreview(artistId, btn) {
  try {
    if (previewEl && !previewEl.paused && previewEl._id === artistId) { previewEl.pause(); btn.textContent = '▶ отрывок'; return; }
    const top = ((await deezer('artist/' + artistId + '/top?limit=3')).data || []).find(x => x.preview);
    if (!top) return toast('Отрывков нет', true);
    if (!previewEl) previewEl = new Audio();
    if (mu.audio && !mu.audio.paused) mu.audio.pause();
    previewEl.src = top.preview; previewEl._id = artistId; previewEl.volume = mu.audio ? mu.audio.volume : 0.8;
    await previewEl.play();
    document.querySelectorAll('[data-mu-preview]').forEach(b => { b.textContent = '▶ отрывок'; });
    btn.textContent = '❚❚ ' + top.title.slice(0, 18);
    previewEl.onended = () => { btn.textContent = '▶ отрывок'; };
  } catch { toast('Отрывок не играет', true); }
}

function onMusicClick(e) {
  if (state.view !== 'music') return;
  const t = e.target;
  const g = (sel, k) => { const b = t.closest(sel); return b ? b.dataset[k] : null; };
  let v;
  if ((v = g('[data-au-tab]', 'auTab')) != null) { mu.tab = v; savePref('tc_autab', v); paintAudioTab(); return; }
  if ((v = g('[data-mu-play]', 'muPlay')) != null) { const r = mu.rows[+v]; if (r) musicOpen(r, false, mu.rows.filter(x => x !== r)); return; }
  if ((v = g('[data-mu-save]', 'muSave')) != null) { const r = mu.rows[+v]; if (r) musicOpen(r, true); return; }
  if ((v = g('[data-mu-mine]', 'muMine')) != null) { const x = musicList()[+v]; if (!x) return; if (mu.t && mu.t.hash === x.hash && mu.kind === 'track') return musicToggle(); mu.alts = []; musicPlayHash(x.hash, x.title); return; }
  if ((v = g('[data-mu-drop]', 'muDrop')) != null) { const l = musicList(); const [gone] = l.splice(+v, 1); saveMusicList(l); paintMusicMine(); if (gone) toastUndo('Убрано из музыки: ' + gone.title, () => { const ll = musicList(); ll.splice(+v, 0, gone); saveMusicList(ll); paintMusicMine(); }); return; }
  if ((v = g('[data-mu-preview]', 'muPreview')) != null) { playPreview(+v, t.closest('[data-mu-preview]')); return; }
  if ((v = g('[data-mu-find]', 'muFind')) != null) { musicSearch(v, true); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (t.closest('[data-mu-recs]')) return paintRecs(true);
  if ((v = g('[data-mu-ix]', 'muIx')) != null) { musicPlayIx(+v); return; }
  if (t.closest('[data-mu-shuf]')) return toggleShuffle();
  if (t.closest('[data-mu-pp]')) return musicToggle();
  if (t.closest('[data-mu-prev]')) return musicNext(-1);
  if (t.closest('[data-mu-next]')) return musicNext(1);
  if (t.closest('[data-mu-stop]')) return musicStop();
  if (typeof onBookClick === 'function' && onBookClick(t)) return;
  if (typeof onRadioClick === 'function' && onRadioClick(t)) return;
}
/* ───────────── аудио: танцоры ─────────────
   На сцене раздела «Аудио» танцует персонаж, нарисованный в духе аниме
   (заливка и тёмный контур): Резе — каре, зелёные глаза, белая рубашка и
   чокер — или серый волк с хвостом. На каждый трек выбирается случайный
   танцор и танец (или тот, кого закрепили кнопкой). Слух: удары баса из
   Web Audio дают темп и фазу «метронома»; если звук прочитать нельзя
   (радио без CORS), танцор держит свой темп ~118 BPM. Руки и ноги — через
   обратную кинематику к целям кистей и стоп. Рисуется 30 кадров/с, только
   пока раздел открыт и окно видно. */
const dz = { cv: null, ctx: null, raf: 0, last: 0, w: 0, h: 0, dpr: 1,
  who: 'reze', b: 0, bpm: 118, onsets: [], lastOn: 0, eMean: 0, eVar: 0, energy: 0, prevE: 0, spec: null, bassIx: [1, 6],
  move: 'idle', prevMove: 'idle', moveAt: 0, pose: null, hair: 0, hairV: 0, skirt: 0, skirtV: 0, lastHx: 0, lastPx: 0,
  tail: [], fw: [], stars: [], trees: [], flies: [], lastBurst: -1, flash: 0 };
// «ихвильнихт» — танец волка из мема, его делают оба; у Резе он любимый
const DZ_MOVES = { reze: ['ichwill', 'ichwill', 'iris', 'clap', 'point', 'hop'], wolf: ['ichwill', 'howl', 'stomp', 'shuffle', 'shake'] };
const DZ_LEN = { ichwill: 16 };
const DZ_NAMES = { iris: 'IRIS OUT', clap: 'хлопки', point: 'указка', hop: 'прыжки', howl: 'вой', ichwill: 'ихвильнихт', stomp: 'топот', shuffle: 'шаффл', shake: 'тряска', idle: '' };
function dancerOn() { return localStorage.getItem('tc_dancer') !== '0'; }
function dancerWho() { const v = localStorage.getItem('tc_dancer_who'); return v === 'reze' || v === 'wolf' ? v : 'random'; }
function dancerHtml() {
  const on = dancerOn(), w = dancerWho();
  return html`<aside class="mu-stage${on ? '' : ' off'}" id="muStage">
    <canvas id="muDance"></canvas>
    ${on ? raw(html`<button class="iconbtn mu-stage-who" id="muDanceWho" title="Кто танцует: ${w === 'random' ? 'случайно на каждый трек' : w === 'reze' ? 'Резе' : 'Волк'}">${w === 'random' ? '🎲' : w === 'reze' ? '💃' : '🐺'}</button>`) : ''}
    <button class="iconbtn mu-stage-x" id="muDanceX" title="${on ? 'Убрать танцора' : 'Позвать танцора'}">${on ? '×' : '💃'}</button>
    <div class="mu-stage-cap" id="muDanceCap"></div>
  </aside>`;
}
function bindDancer() {
  const x = $('#muDanceX'); if (!x) return;
  const redraw = () => { const st = $('#muStage'); st.outerHTML = dancerHtml(); bindDancer(); };
  x.addEventListener('click', () => { savePref('tc_dancer', dancerOn() ? '0' : '1'); redraw(); });
  const w = $('#muDanceWho');
  if (w) w.addEventListener('click', () => {
    const order = ['random', 'reze', 'wolf'], next = order[(order.indexOf(dancerWho()) + 1) % 3];
    savePref('tc_dancer_who', next); dancerNewTrack(); redraw();
    toast(next === 'random' ? 'Танцор — случайный на каждый трек' : next === 'reze' ? 'Танцует Резе' : 'Танцует волк');
  });
  if (dancerOn()) dancerStart();
}
// Новый трек: новый танцор (если не закреплён) и новый танец.
function dancerNewTrack() {
  const w = dancerWho();
  const who = w === 'random' ? (Math.random() < 0.5 ? 'reze' : 'wolf') : w;
  if (who !== dz.who) { dz.who = who; dz.pose = null; dz.tail = []; dz.fw = []; }
  const list = DZ_MOVES[dz.who];
  dz.prevMove = dz.move; dz.move = list[Math.floor(Math.random() * list.length)]; dz.moveAt = Math.floor(dz.b);
  if (dz.move === 'ichwill') dz.ichAt = dz.moveAt;
  dz.onsets = [];
}
function dancerStart() {
  const cv = $('#muDance'); if (!cv) return;
  if (!dz.who || (dancerWho() !== 'random' && dz.who !== dancerWho())) dz.who = dancerWho() === 'random' ? dz.who : dancerWho();
  dz.cv = cv; dz.ctx = cv.getContext('2d');
  dancerResize();
  cancelAnimationFrame(dz.raf); dz.last = 0;
  dz.raf = requestAnimationFrame(dancerFrame);
}
function dancerResize() {
  const r = dz.cv.getBoundingClientRect();
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  dz.w = Math.max(10, r.width); dz.h = Math.max(10, r.height); dz.dpr = dpr;
  dz.cv.width = Math.round(dz.w * dpr); dz.cv.height = Math.round(dz.h * dpr);
  const W = dz.w, H = dz.h;
  dz.stars = Array.from({ length: 60 }, () => ({ x: Math.random() * W, y: Math.random() * H * 0.6, r: Math.random() * 1.2 + 0.3, f: Math.random() * 6 }));
  dz.trees = Array.from({ length: 16 }, (_, i) => ({ x: (i + Math.random() * 0.8) / 16 * W * 1.1 - W * 0.05, h: H * (0.16 + Math.random() * 0.16), far: i % 2 }));
  dz.trees.sort((a, b) => b.far - a.far);
  dz.flies = Array.from({ length: 16 }, () => ({ x: Math.random() * W, y: H * (0.45 + Math.random() * 0.45), a: Math.random() * 6, s: 6 + Math.random() * 12, f: Math.random() * 6 }));
}

/* ── слух: удары баса и темп ── */
function dancerListen(dt, now) {
  const playing = typeof auPlaying === 'function' && auPlaying();
  const an = playing && typeof auAnalyser === 'function' ? auAnalyser() : null;
  let bass = 0, all = 0;
  if (an) {
    if (!dz.spec || dz.spec.length !== an.frequencyBinCount) {
      dz.spec = new Uint8Array(an.frequencyBinCount);
      const bw = an.context.sampleRate / an.fftSize;
      dz.bassIx = [Math.max(1, Math.round(40 / bw)), Math.max(2, Math.round(150 / bw))];
    }
    an.getByteFrequencyData(dz.spec);
    const s = dz.spec, [b0, b1] = dz.bassIx, top = Math.min(s.length, Math.round(s.length * 0.3));
    for (let i = b0; i <= b1; i++) bass += s[i];
    for (let i = 0; i < top; i++) all += s[i];
    bass /= (b1 - b0 + 1) * 255; all /= top * 255;
  }
  // без анализа (радио без CORS) — ровная «внутренняя» энергия
  const target = !playing ? 0 : an ? Math.min(1, all * 2.2) : 0.6;
  dz.energy += (target - dz.energy) * Math.min(1, dt * 3);
  const d = bass - dz.eMean;
  dz.eMean += d * Math.min(1, dt * 2.2); dz.eVar += (d * d - dz.eVar) * Math.min(1, dt * 2.2);
  const rise = bass - dz.prevE; dz.prevE = bass;
  if (an && bass > 0.3 && d > Math.sqrt(dz.eVar) * 1.15 && rise > 0 && now - dz.lastOn > 260) {
    const gap = now - dz.lastOn; dz.lastOn = now;
    if (gap < 2000) { dz.onsets.push(gap); if (dz.onsets.length > 24) dz.onsets.shift(); }
    if (dz.onsets.length >= 4) {
      const g = dz.onsets.slice().sort((x, y) => x - y)[dz.onsets.length >> 1];
      let bpm = 60000 / g; while (bpm < 85) bpm *= 2; while (bpm > 170) bpm /= 2;
      dz.bpm += (bpm - dz.bpm) * 0.25;
    }
    const fr = dz.b - Math.floor(dz.b);
    dz.b += fr > 0.5 ? (1 - fr) * 0.35 : -fr * 0.35;
  }
  if (playing && !an) dz.bpm += (118 - dz.bpm) * Math.min(1, dt);
  dz.b += dt * (playing ? dz.bpm : 40) / 60;
  return { playing, heard: !!an };
}

/* ── хореография: цели кистей (в осях торса от груди), стоп и таза ── */
const TAU = Math.PI * 2;
function dzPose(m, b, e) {
  const fr = b - Math.floor(b), beat = Math.floor(b), dn = Math.pow(1 - fr, 3), A = 0.55 + e * 0.6;
  const p = { px: 0, py: dn * 4 * A, tl: 0, ht: 0, lh: [-17, 40], rh: [17, 40], lf: [-12, 0], rf: [12, 0], muz: 0, ring: 0, spark: 0, kn: 0.4, mo: 0 };
  const sw = Math.sin(Math.PI * b);
  switch (m) {
    case 'idle':
      p.px = Math.sin(b * Math.PI / 2) * 2; p.py = 1; p.tl = Math.sin(b * Math.PI / 2) * 0.03; p.ht = -p.tl;
      p.lh = [-16, 41]; p.rh = [16, 41]; break;
    case 'ichwill': { // по мему: подскоки со скрещенной ногой → лапы-мельница → присед-пружинка
      const rb = ((b - (dz.ichAt || 0)) % 16 + 16) % 16, s = Math.floor(rb) % 2 ? 1 : -1, flop = Math.sin(TAU * b) * 3;
      p.mo = 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * b));
      if (rb < 8) { // стоит на одной ноге, другая согнута и заходит за опорную; лапки висят у груди
        const hop = Math.sin(Math.PI * fr) * 5 * A;
        p.py = -hop + 2; p.tl = -s * 0.08; p.ht = s * 0.1 - 0.06; p.px = s * 2;
        if (s > 0) { p.rf = [5, hop]; p.lf = [9, 20 + hop]; } else { p.lf = [-5, hop]; p.rf = [-9, 20 + hop]; }
        p.lh = [-8, 6 + flop]; p.rh = [8, 6 - flop];
      } else if (rb < 12) { // лапы машут в стороны по очереди, корпус крутится
        const a = Math.PI * b, w = Math.sin(a);
        p.lh = [-14 - 26 * Math.max(0, w), 2 - 12 * w]; p.rh = [14 + 26 * Math.max(0, -w), 2 + 12 * w];
        p.px = 4 * w; p.tl = 0.1 * w; p.ht = -0.15 * w;
        if (Math.floor(rb) % 2) p.lf = [-12, Math.sin(Math.PI * fr) * 7]; else p.rf = [12, Math.sin(Math.PI * fr) * 7];
      } else { // широкий присед, колени в стороны, пружинит на долю
        p.lf = [-23, 0]; p.rf = [23, 0]; p.kn = 1; p.py = 9 + dn * 6 * A;
        p.tl = Math.sin(Math.PI * b) * 0.08; p.ht = -p.tl;
        p.lh = [-9, 8 + flop]; p.rh = [9, 8 - flop];
      }
      break;
    }
    case 'iris': { // кисть кольцом у глаза, другая на бедре; стороны меняются каждые 2 доли
      const s = Math.floor(b / 4) % 2 ? 1 : -1, a = TAU * b;
      const hand = [s * 8 + Math.cos(a) * 2.5 * A, -25 + Math.sin(a) * 2.5 * A];
      if (s < 0) { p.lh = hand; p.rh = [16, 39]; } else { p.rh = hand; p.lh = [-16, 39]; }
      p.px = -s * 5 * A; p.tl = s * 0.07; p.ht = s * 0.16 + Math.sin(a) * 0.03;
      if (s < 0) p.rf = [12, 3]; else p.lf = [-12, 3];
      p.ring = 1; break;
    }
    case 'clap': {
      const sep = Math.sin(Math.PI * fr), hi = beat % 4 === 3 ? -22 : 12;
      p.lh = [-3 - 19 * sep, hi + sep * 6]; p.rh = [3 + 19 * sep, hi + sep * 6];
      p.px = Math.sin(Math.PI * b) * 4 * A; p.tl = -p.px * 0.012;
      if (beat % 2) p.lf = [-16, 0]; else p.rf = [16, 0];
      p.spark = fr < 0.18 ? 1 - fr / 0.18 : 0; break;
    }
    case 'point': {
      const s = Math.floor(b / 2) % 2 ? 1 : -1, pop = Math.pow(1 - (b / 2 - Math.floor(b / 2)), 2);
      const up = [s * (38 + 3 * pop), -36 - 4 * pop];
      if (s < 0) { p.lh = up; p.rh = [16, 39]; } else { p.rh = up; p.lh = [-16, 39]; }
      p.px = s * 5 * A * (0.5 + pop); p.tl = -s * 0.06; p.ht = s * 0.12;
      if (s < 0) p.lf = [-17, 0]; else p.rf = [17, 0];
      break;
    }
    case 'hop': {
      const h = Math.sin(Math.PI * fr) * 9 * A;
      p.py = -h + dn * 3; p.lf = [-10, h]; p.rf = [10, h];
      p.lh = [-22, 30 - 16 * sw]; p.rh = [22, 30 + 16 * sw];
      p.tl = sw * 0.04; p.ht = -sw * 0.08; break;
    }
    case 'howl': { // 2 доли — вой, задрав морду, 2 доли — покачивание
      const ph = (b / 4 - Math.floor(b / 4)) * 4, hw = ph < 2 ? Math.sin(Math.min(1, ph / 0.4) * Math.PI / 2) * (ph > 1.7 ? (2 - ph) / 0.3 : 1) : 0;
      p.muz = hw; p.py = 2 + (1 - hw) * dn * 4 * A;
      p.lh = [-13 - (1 - hw) * 4, -12 + (1 - hw) * 28]; p.rh = [13 + (1 - hw) * 4, -12 + (1 - hw) * 28];
      p.px = (1 - hw) * Math.sin(Math.PI * b) * 3; p.lf = [-14, 0]; p.rf = [14, 0]; break;
    }
    case 'stomp': {
      const s = beat % 2 ? 1 : -1, lift = Math.sin(Math.PI * Math.min(1, fr * 1.4)) * 20 * A;
      if (s < 0) p.lf = [-13, lift]; else p.rf = [13, lift];
      p.px = -s * 3; p.py = 3 + dn * 5 * A; p.tl = s * 0.04;
      p.lh = [-18, s < 0 ? 26 : 6 - 6 * A]; p.rh = [18, s > 0 ? 26 : 6 - 6 * A]; break;
    }
    case 'shuffle': {
      const k = Math.sin(TAU * b / 2), l = Math.max(0, Math.sin(TAU * b)) * 8 * A;
      p.lf = [-12 + 9 * k, beat % 2 ? l : 0]; p.rf = [12 + 9 * k, beat % 2 ? 0 : l];
      p.px = 5 * k; p.py = 3 + dn * 3; p.tl = -k * 0.04;
      p.lh = [-17, 18 + 10 * sw]; p.rh = [17, 18 - 10 * sw]; break;
    }
    case 'shake': {
      const q = Math.sin(TAU * b * 2);
      p.px = q * 6 * A; p.tl = -q * 0.06; p.ht = q * 0.08; p.py = 3;
      p.lh = [-42, -4 + 6 * q]; p.rh = [42, -4 - 6 * q]; p.lf = [-15, 0]; p.rf = [15, 0]; break;
    }
  }
  return p;
}
function dzLerp(a, b, t) {
  const o = {};
  for (const k in b) o[k] = Array.isArray(b[k]) ? [a[k][0] + (b[k][0] - a[k][0]) * t, a[k][1] + (b[k][1] - a[k][1]) * t] : a[k] + (b[k] - a[k]) * t;
  return o;
}
function dzChoreo(playing) {
  if (!playing) { if (dz.move !== 'idle') { dz.prevMove = dz.move; dz.move = 'idle'; dz.moveAt = dz.b; } return; }
  if (dz.move === 'idle' || dz.b - dz.moveAt >= (DZ_LEN[dz.move] || 8)) {
    const list = DZ_MOVES[dz.who].filter(m => m !== dz.move);
    dz.prevMove = dz.move; dz.move = list[Math.floor(Math.random() * list.length)]; dz.moveAt = Math.floor(dz.b);
    if (dz.move === 'ichwill') dz.ichAt = dz.moveAt;
  }
}

/* ── скелет ── */
function dzRot(v, a) { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; }
function dzAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
// Двухзвенная ОК: сустав выбирается «наружу» (out = −1 влево, +1 вправо).
function dzIK(root, tgt, l1, l2, out) {
  let dx = tgt[0] - root[0], dy = tgt[1] - root[1], d = Math.hypot(dx, dy) || 0.001;
  const dm = Math.min(l1 + l2 - 0.01, Math.max(Math.abs(l1 - l2) + 0.01, d));
  dx *= dm / d; dy *= dm / d; d = dm;
  const th = Math.atan2(dy, dx), al = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const j1 = [root[0] + Math.cos(th + al) * l1, root[1] + Math.sin(th + al) * l1], j2 = [root[0] + Math.cos(th - al) * l1, root[1] + Math.sin(th - al) * l1];
  return { j: (j1[0] - j2[0]) * out > 0 ? j1 : j2, e: [root[0] + dx, root[1] + dy] };
}
function dzSkeleton(p) {
  const pel = [p.px, p.py], chest = dzAdd(pel, dzRot([0, -46], p.tl));
  const loc = v => dzAdd(chest, dzRot(v, p.tl));
  const g = { pel, chest, tl: p.tl, ht: p.ht, neck: loc([0, -6]) };
  g.head = dzAdd(g.neck, dzRot([0, -16], p.tl + p.ht));
  g.ls = loc([-14, 2]); g.rs = loc([14, 2]);
  const la = dzIK(g.ls, loc(p.lh), 28, 27, -1), ra = dzIK(g.rs, loc(p.rh), 28, 27, 1);
  g.le = la.j; g.lw = la.e; g.re = ra.j; g.rw = ra.e;
  g.lhip = dzAdd(pel, dzRot([-9, 4], p.tl * 0.5)); g.rhip = dzAdd(pel, dzRot([9, 4], p.tl * 0.5));
  const ll = dzIK(g.lhip, [p.lf[0], 92 - p.lf[1]], 47, 46, -1), rl = dzIK(g.rhip, [p.rf[0], 92 - p.rf[1]], 47, 46, 1);
  // колени гнутся к зрителю, а не в стороны: боковой вынос сильно сжат
  const knee = (h, k, a) => { const mx = h[0] + (a[0] - h[0]) * 47 / 93; return [mx + (k[0] - mx) * p.kn, k[1]]; };
  g.lk = knee(g.lhip, ll.j, ll.e); g.la = ll.e; g.rk = knee(g.rhip, rl.j, rl.e); g.ra = rl.e;
  return g;
}

/* ── рисование в cel-стиле ── */
const OL = '#1b1424';
function dzLimb(c, pts, w, col, ol = OL) {
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.strokeStyle = ol; c.lineWidth = w + 3; c.stroke();
  c.strokeStyle = col; c.lineWidth = w; c.stroke();
}
function dzFill(c, col, ol = OL, lw = 1.6) { c.fillStyle = col; c.fill(); c.strokeStyle = ol; c.lineWidth = lw; c.stroke(); }
function dzDot(c, p, r, col) { c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); dzFill(c, col); }
function dzShoe(c, a, col, side) {
  c.beginPath(); c.ellipse(a[0] + side * 3, a[1] + 1.5, 7, 3.6, 0, 0, TAU); dzFill(c, col);
}
// Пружинка для волос, юбки и прочего, что догоняет тело.
function dzSpring(k, v, tgt, dt, stiff = 70, damp = 7) { const a = (tgt - dz[k]) * stiff - dz[v] * damp; dz[v] += a * dt; dz[k] += dz[v] * dt; }

function dzDrawReze(c, g, p, dt) {
  const SKIN = '#f6dccd', HAIR = '#3a2346', HAIR2 = '#5b3a6e', SHIRT = '#f5f3ef', SKIRT = '#262a3d', SHOE = '#221c28';
  const hv = (g.head[0] - dz.lastHx) / Math.max(dt, 0.01); dz.lastHx = g.head[0];
  dzSpring('hair', 'hairV', Math.max(-0.7, Math.min(0.7, -hv * 0.012)), dt);
  const pv = (g.pel[0] - dz.lastPx) / Math.max(dt, 0.01); dz.lastPx = g.pel[0];
  dzSpring('skirt', 'skirtV', Math.max(-0.5, Math.min(0.5, -pv * 0.01)), dt, 55, 6);
  const H = g.head, ha = g.tl + g.ht;
  // волосы сзади: каре до подбородка
  c.save(); c.translate(H[0], H[1]); c.rotate(ha); c.scale(1.25, 1.25);
  c.beginPath(); c.moveTo(-14, -2); c.quadraticCurveTo(-16, -17, 0, -17); c.quadraticCurveTo(16, -17, 14, -2);
  c.quadraticCurveTo(15 + dz.hair * 4, 10, 12 + dz.hair * 5, 15); c.lineTo(-12 + dz.hair * 5, 15); c.quadraticCurveTo(-15 + dz.hair * 4, 10, -14, -2); dzFill(c, HAIR);
  c.restore();
  // ноги
  dzLimb(c, [g.lhip, g.lk, g.la], 8, SKIN); dzLimb(c, [g.rhip, g.rk, g.ra], 8, SKIN);
  dzShoe(c, g.la, SHOE, -1); dzShoe(c, g.ra, SHOE, 1);
  // юбка
  c.save(); c.translate(g.pel[0], g.pel[1]); c.rotate(g.tl * 0.5);
  const sk = dz.skirt * 10, fl = 2 + dz.energy * 3;
  c.beginPath(); c.moveTo(-11, -6); c.lineTo(11, -6); c.lineTo(17 + fl + sk, 24); c.quadraticCurveTo(sk, 27, -17 - fl + sk, 24); c.closePath(); dzFill(c, SKIRT);
  c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1; c.beginPath(); c.moveTo(-4, -4); c.lineTo(-6 + sk * 0.6, 23); c.moveTo(5, -4); c.lineTo(7 + sk * 0.6, 23); c.stroke();
  c.restore();
  // рубашка
  c.save(); c.translate(g.chest[0], g.chest[1]); c.rotate(g.tl);
  c.beginPath(); c.moveTo(-15, 0); c.quadraticCurveTo(0, -5, 15, 0); c.lineTo(11, 41); c.quadraticCurveTo(0, 43, -11, 41); c.closePath(); dzFill(c, SHIRT);
  c.strokeStyle = '#c9c4cf'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, 2); c.lineTo(0, 40); c.stroke();
  for (let y = 9; y < 40; y += 9) { c.fillStyle = '#b8b2c0'; c.beginPath(); c.arc(1.8, y, 0.9, 0, TAU); c.fill(); }
  c.beginPath(); c.moveTo(-6, -3); c.lineTo(0, 5); c.lineTo(6, -3); dzFill(c, SHIRT, OL, 1.2); // воротник
  c.restore();
  // шея с чокером
  dzLimb(c, [g.chest, g.neck], 6, SKIN);
  c.save(); c.translate(g.neck[0], g.neck[1]); c.rotate(g.tl); c.fillStyle = '#111'; c.fillRect(-4, -1.5, 8, 2.6); c.restore();
  // голова и лицо
  c.save(); c.translate(H[0], H[1]); c.rotate(ha); c.scale(1.25, 1.25);
  c.beginPath(); c.ellipse(0, 0, 10.5, 12.5, 0, 0, TAU); dzFill(c, SKIN);
  for (const s of [-1, 1]) {
    c.fillStyle = '#fff'; c.beginPath(); c.ellipse(s * 4.4, 1, 2.6, 2.9, 0, 0, TAU); c.fill();
    c.fillStyle = '#2f9e6e'; c.beginPath(); c.ellipse(s * 4.2, 1.4, 1.8, 2.4, 0, 0, TAU); c.fill();
    c.fillStyle = '#0c2a1e'; c.beginPath(); c.arc(s * 4.2, 1.6, 0.9, 0, TAU); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(s * 4.7, 0.6, 0.6, 0, TAU); c.fill();
    c.strokeStyle = OL; c.lineWidth = 1.3; c.beginPath(); c.moveTo(s * 1.8, -1.2); c.quadraticCurveTo(s * 4.4, -2.6, s * 7.2, -1); c.stroke();
    c.fillStyle = 'rgba(255,120,140,.35)'; c.beginPath(); c.ellipse(s * 6, 5, 1.8, 1, 0, 0, TAU); c.fill();
  }
  c.strokeStyle = '#a0505a'; c.lineWidth = 1; c.beginPath();
  if (p.mo > 0.3) { c.closePath(); c.fillStyle = '#7a2a3a'; c.beginPath(); c.ellipse(0, 7.6, 1.6, 1.1 + p.mo * 1.1, 0, 0, TAU); c.fill(); }
  else if (dz.energy > 0.5) { c.arc(0, 7, 1.8, 0.1, Math.PI - 0.1); } else { c.moveTo(-1.6, 7.6); c.quadraticCurveTo(0, 8.6, 1.6, 7.6); }
  c.stroke();
  // чёлка и боковые пряди на пружинах
  c.beginPath(); c.moveTo(-11.5, -1); c.quadraticCurveTo(-12, -14, 0, -14.5); c.quadraticCurveTo(12, -14, 11.5, -1);
  c.lineTo(8, -5); c.lineTo(5.5, -1.5); c.lineTo(3, -6); c.lineTo(0, -2.5); c.lineTo(-3, -6.5); c.lineTo(-5.5, -2); c.lineTo(-8.5, -5.5); c.closePath(); dzFill(c, HAIR);
  c.strokeStyle = HAIR2; c.lineWidth = 1.4; c.beginPath(); c.moveTo(-6, -11); c.quadraticCurveTo(0, -13, 5, -11); c.stroke();
  for (const s of [-1, 1]) {
    const sw = dz.hair * 6;
    c.beginPath(); c.moveTo(s * 11, -4); c.quadraticCurveTo(s * 13 + sw * 0.5, 6, s * 11 + sw, 15); c.lineTo(s * 8 + sw * 0.8, 12); c.quadraticCurveTo(s * 9, 4, s * 8.5, -3); c.closePath(); dzFill(c, HAIR);
  }
  c.restore();
  // руки: рукав до локтя, дальше кожа
  for (const [s, e, w] of [[g.ls, g.le, g.lw], [g.rs, g.re, g.rw]]) {
    dzLimb(c, [s, e], 8, SHIRT); dzLimb(c, [e, w], 6, SKIN);
    dzDot(c, w, 3.4, SKIN);
  }
  // «IRIS OUT»: кольцо из пальцев у глаза
  if (p.ring > 0.5) {
    const dl = Math.hypot(g.lw[0] - H[0], g.lw[1] - H[1]), dr = Math.hypot(g.rw[0] - H[0], g.rw[1] - H[1]);
    const hand = dl < dr ? g.lw : g.rw;
    if (Math.min(dl, dr) < 18) {
    c.strokeStyle = OL; c.lineWidth = 2.6; c.beginPath(); c.arc(hand[0], hand[1], 4.2, 0, TAU); c.stroke();
    c.strokeStyle = SKIN; c.lineWidth = 1.4; c.stroke(); }
  }
  if (p.spark > 0) {
    const m = [(g.lw[0] + g.rw[0]) / 2, (g.lw[1] + g.rw[1]) / 2];
    c.strokeStyle = `rgba(255,230,140,${p.spark})`; c.lineWidth = 1.4; c.beginPath();
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU, r0 = 6, r1 = 6 + 7 * p.spark; c.moveTo(m[0] + Math.cos(a) * r0, m[1] + Math.sin(a) * r0); c.lineTo(m[0] + Math.cos(a) * r1, m[1] + Math.sin(a) * r1); }
    c.stroke();
  }
}

function dzDrawWolf(c, g, p, dt) {
  const FUR = '#8e97a8', FUR2 = '#6c7486', BELLY = '#dfe3ea', JEANS = '#34466b', SHOE = '#f2f2f2', OLW = '#1a1d27';
  // хвост — цепочка звеньев, каждое догоняет предыдущее: так и виляет
  const wag = Math.sin(TAU * dz.b * (dz.move === 'shake' ? 2 : 1)) * (0.35 + dz.energy * 0.55);
  if (dz.tail.length !== 8) dz.tail = Array(8).fill(-0.4);
  dz.tail[0] = -0.3 + wag;
  for (let i = 1; i < 8; i++) dz.tail[i] += (dz.tail[i - 1] - dz.tail[i]) * Math.min(1, dt * 14);
  const pts = []; let q = dzAdd(g.pel, [6, 6]);
  for (let i = 0; i < 8; i++) { pts.push(q); const a = dz.tail[i] - i * 0.12; q = dzAdd(q, [Math.cos(a) * 6.5, -Math.sin(a) * 6.5]); }
  const rr = i => 8.5 - i * 0.5;
  c.fillStyle = OLW; pts.forEach((t, i) => { c.beginPath(); c.arc(t[0], t[1], rr(i) + 1.6, 0, TAU); c.fill(); });
  pts.forEach((t, i) => { c.fillStyle = i > 5 ? BELLY : FUR; c.beginPath(); c.arc(t[0], t[1], rr(i), 0, TAU); c.fill(); });
  // ноги в джинсах, кроссовки
  dzLimb(c, [g.lhip, g.lk, g.la], 11, JEANS, OLW); dzLimb(c, [g.rhip, g.rk, g.ra], 11, JEANS, OLW);
  dzShoe(c, g.la, SHOE, -1); dzShoe(c, g.ra, SHOE, 1);
  // торс: мех, светлая грудь
  c.save(); c.translate(g.chest[0], g.chest[1]); c.rotate(g.tl);
  c.beginPath(); c.moveTo(-17, 0); c.quadraticCurveTo(0, -6, 17, 0); c.quadraticCurveTo(15, 24, 12, 46); c.quadraticCurveTo(0, 49, -12, 46); c.quadraticCurveTo(-15, 24, -17, 0); dzFill(c, FUR, OLW);
  c.beginPath(); c.moveTo(-8, 1); c.lineTo(-4, 6); c.lineTo(0, 2); c.lineTo(4, 6); c.lineTo(8, 1); c.quadraticCurveTo(9, 26, 0, 34); c.quadraticCurveTo(-9, 26, -8, 1); c.fillStyle = BELLY; c.fill();
  c.fillStyle = '#26324d'; c.fillRect(-12.5, 40, 25, 6); // пояс джинсов
  c.restore();
  // голова
  const H = g.head, ha = g.tl + g.ht, m = Math.max(p.muz, p.mo * 0.55);
  c.save(); c.translate(H[0], H[1] - m * 1.5); c.rotate(ha); c.scale(1.2, 1.2);
  for (const s of [-1, 1]) {
    const flick = Math.max(0, Math.sin(TAU * dz.b + s)) * 0.12 * dz.energy;
    c.save(); c.translate(s * 7.5, -8); c.rotate(s * (0.18 + flick));
    c.beginPath(); c.moveTo(-4.5, 2); c.lineTo(0, -13); c.lineTo(4.5, 2); c.closePath(); dzFill(c, FUR2, OLW);
    c.beginPath(); c.moveTo(-2.3, 0.5); c.lineTo(0, -8.5); c.lineTo(2.3, 0.5); c.fillStyle = '#d99aa8'; c.fill();
    c.restore();
  }
  c.beginPath(); c.moveTo(-12, -4); c.quadraticCurveTo(-12, -14, 0, -14); c.quadraticCurveTo(12, -14, 12, -4);
  c.lineTo(15, 3); c.lineTo(11, 4); c.lineTo(13, 9); c.quadraticCurveTo(0, 16, -13, 9); c.lineTo(-11, 4); c.lineTo(-15, 3); c.closePath(); dzFill(c, FUR, OLW);
  // морда: при вое уходит вверх, глаза закрываются
  const sy = 5 - m * 5;
  c.beginPath(); c.ellipse(0, sy, 6.8 + m, 5.4 + m * 1.5, 0, 0, TAU); dzFill(c, BELLY, OLW, 1.3);
  for (const s of [-1, 1]) {
    if (p.muz > 0.4) { c.strokeStyle = OLW; c.lineWidth = 1.4; c.beginPath(); c.arc(s * 5, -3, 2, Math.PI * 1.1, Math.PI * 1.9); c.stroke(); }
    else {
      c.beginPath(); c.ellipse(s * 5, -3.5, 2.5, 2.2, s * 0.25, 0, TAU); dzFill(c, '#ffc93c', OLW, 1);
      c.fillStyle = '#111'; c.beginPath(); c.ellipse(s * 5, -3.3, 0.8, 1.6, 0, 0, TAU); c.fill();
    }
    c.strokeStyle = OLW; c.lineWidth = 1.3; c.beginPath(); c.moveTo(s * 2.4, -6.6 - m); c.lineTo(s * 7.6, -7.4 + m); c.stroke();
  }
  c.fillStyle = '#15161c'; c.beginPath(); c.ellipse(0, sy - 2.6 - m, 2.6, 1.8, 0, 0, TAU); c.fill();
  if (m > 0.3) { c.fillStyle = '#5b1f2c'; c.beginPath(); c.ellipse(0, sy + 2.2, 2 * m + 0.6, 2.4 * m, 0, 0, TAU); c.fill(); }
  else { c.strokeStyle = OLW; c.lineWidth = 1; c.beginPath(); c.moveTo(0, sy - 1); c.lineTo(0, sy + 1.5); c.moveTo(-2.5, sy + 2.5); c.quadraticCurveTo(0, sy + 3.6, 2.5, sy + 2.5); c.stroke(); }
  c.restore();
  // руки в меху, лапы темнее
  for (const [s, e, w] of [[g.ls, g.le, g.lw], [g.rs, g.re, g.rw]]) {
    dzLimb(c, [s, e, w], 8.5, FUR, OLW); dzDot(c, w, 4, FUR2);
  }
  if (m > 0.6) {
    c.save(); c.globalAlpha = (m - 0.6) / 0.4; c.fillStyle = '#e8eefc'; c.font = 'italic 700 9px sans-serif'; c.textAlign = 'center';
    c.fillText('А-у-у-у!', H[0] + 26, H[1] - 26 - (dz.b % 4) * 3); c.restore();
  }
}

/* ── сцены ── */
function dzSceneReze(c, W, H, dt, pl, t, floorY) {
  const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0a0f2e'); bg.addColorStop(0.55, '#2b1a4d'); bg.addColorStop(1, '#4a2550');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  if (dz.flash > 0) { c.fillStyle = `rgba(255,200,230,${dz.flash * 0.12})`; c.fillRect(0, 0, W, H); dz.flash = Math.max(0, dz.flash - dt * 2.5); }
  for (const s of dz.stars) { c.fillStyle = `rgba(255,255,255,${0.35 + 0.35 * Math.sin(t * 1.3 + s.f)})`; c.fillRect(s.x, s.y, s.r, s.r); }
  // фейерверк на каждую четвёртую долю (без музыки — изредка)
  const bar = Math.floor(dz.b / 4);
  if ((pl && bar !== dz.lastBurst) || (!pl && Math.random() < dt * 0.15)) {
    dz.lastBurst = bar;
    const x = W * (0.15 + Math.random() * 0.7), y = H * (0.1 + Math.random() * 0.25), hue = Math.floor(Math.random() * 360);
    for (let i = 0; i < 46; i++) { const a = i / 46 * TAU, v = 50 + Math.random() * 60; dz.fw.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, hue: hue + Math.random() * 40 }); }
    if (dz.fw.length > 400) dz.fw.splice(0, dz.fw.length - 400);
    dz.flash = 1;
  }
  c.globalCompositeOperation = 'lighter'; c.lineWidth = 1.6;
  for (const f of dz.fw) {
    f.vy += 38 * dt; f.vx *= 1 - dt * 0.9; f.vy *= 1 - dt * 0.9; f.x += f.vx * dt; f.y += f.vy * dt; f.life -= dt * 0.65;
    if (f.life <= 0) continue;
    c.strokeStyle = `hsla(${f.hue},100%,65%,${f.life})`; c.beginPath(); c.moveTo(f.x, f.y); c.lineTo(f.x - f.vx * 0.06, f.y - f.vy * 0.06); c.stroke();
  }
  dz.fw = dz.fw.filter(f => f.life > 0);
  c.globalCompositeOperation = 'source-over';
  // гирлянда фонариков
  c.strokeStyle = 'rgba(30,15,30,.8)'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, H * 0.42);
  c.quadraticCurveTo(W / 2, H * 0.5, W, H * 0.4); c.stroke();
  for (let i = 1; i < 7; i++) {
    const u = i / 7, x = W * u, y = (1 - u) * (1 - u) * H * 0.42 + 2 * (1 - u) * u * H * 0.5 + u * u * H * 0.4 + 6, sw = Math.sin(t * 1.5 + i) * 2;
    const glow = 0.6 + 0.4 * (pl ? Math.pow(1 - (dz.b % 1), 2) : 0.4);
    c.fillStyle = `rgba(255,120,60,${0.15 * glow})`; c.beginPath(); c.arc(x + sw, y, 13, 0, TAU); c.fill();
    c.fillStyle = i % 2 ? '#e8463a' : '#f29a3a'; c.beginPath(); c.ellipse(x + sw, y, 5, 6.5, 0, 0, TAU); c.fill();
  }
  // холмы и крыши
  c.fillStyle = '#1b1030'; c.beginPath(); c.moveTo(0, floorY - 40);
  c.quadraticCurveTo(W * 0.3, floorY - 70, W * 0.55, floorY - 45); c.quadraticCurveTo(W * 0.8, floorY - 25, W, floorY - 55); c.lineTo(W, H); c.lineTo(0, H); c.fill();
  c.fillStyle = '#130a22'; c.fillRect(0, floorY - 6, W, H - floorY + 6);
}
function dzSceneWolf(c, W, H, dt, pl, t, floorY) {
  const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#050b18'); bg.addColorStop(0.6, '#0f2238'); bg.addColorStop(1, '#0b1a28');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  for (const s of dz.stars) { c.fillStyle = `rgba(220,235,255,${0.3 + 0.3 * Math.sin(t + s.f)})`; c.fillRect(s.x, s.y, s.r, s.r); }
  const mx = W * 0.27, my = H * 0.16, mr = Math.min(W, H) * 0.09, howl = dz.move === 'howl' && dz.pose ? dz.pose.muz : 0;
  const gl = c.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * (3.2 + howl));
  gl.addColorStop(0, `rgba(220,230,255,${0.25 + howl * 0.2})`); gl.addColorStop(1, 'rgba(220,230,255,0)');
  c.fillStyle = gl; c.fillRect(0, 0, W, H * 0.6);
  c.fillStyle = '#eef1f8'; c.beginPath(); c.arc(mx, my, mr, 0, TAU); c.fill();
  c.fillStyle = 'rgba(160,170,195,.35)'; for (const [dx, dy, r] of [[-0.3, -0.2, 0.22], [0.25, 0.15, 0.16], [-0.05, 0.35, 0.12]]) { c.beginPath(); c.arc(mx + dx * mr, my + dy * mr, r * mr, 0, TAU); c.fill(); }
  // ели в два ряда
  for (const tr of dz.trees) {
    c.fillStyle = tr.far ? '#0d1d2e' : '#081320';
    const base = floorY - (tr.far ? 22 : 0), h = tr.h * (tr.far ? 0.8 : 1);
    for (let k = 0; k < 3; k++) {
      const y0 = base - h * k * 0.28, w = h * (0.32 - k * 0.07);
      c.beginPath(); c.moveTo(tr.x - w, y0); c.lineTo(tr.x, y0 - h * 0.48); c.lineTo(tr.x + w, y0); c.fill();
    }
  }
  c.fillStyle = '#0a1622'; c.fillRect(0, floorY - 4, W, H - floorY + 4);
  // светлячки — вспыхивают на долю
  const pulse = pl ? Math.pow(1 - (dz.b % 1), 2) : 0.3;
  c.globalCompositeOperation = 'lighter';
  for (const f of dz.flies) {
    f.a += dt * 0.6; f.x += Math.cos(f.a + f.f) * f.s * dt; f.y += Math.sin(f.a * 1.3) * f.s * 0.5 * dt;
    if (f.x < 0) f.x += W; if (f.x > W) f.x -= W;
    const al = 0.25 + 0.5 * Math.max(0, Math.sin(t * 2 + f.f)) + 0.3 * pulse;
    const gr = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, 7); gr.addColorStop(0, `rgba(210,255,120,${al})`); gr.addColorStop(1, 'rgba(210,255,120,0)');
    c.fillStyle = gr; c.fillRect(f.x - 7, f.y - 7, 14, 14);
  }
  c.globalCompositeOperation = 'source-over';
}

/* ── кадр ── */
function dancerFrame(now) {
  if (!dz.cv || !dz.cv.isConnected) { dz.raf = 0; return; }
  dz.raf = requestAnimationFrame(dancerFrame);
  if (document.hidden || now - dz.last < 32) return;
  const dt = dz.last ? Math.min(0.1, (now - dz.last) / 1000) : 0.033; dz.last = now;
  const r = dz.cv.getBoundingClientRect();
  if (Math.abs(r.width - dz.w) > 1 || Math.abs(r.height - dz.h) > 1) dancerResize();
  const { playing, heard } = dancerListen(dt, now);
  dzChoreo(playing);
  const W = dz.w, H = dz.h, c = dz.ctx, dpr = dz.dpr, t = now / 1000;
  const cap = $('#muDanceCap');
  if (cap) cap.textContent = !playing ? 'включите трек — потанцуем'
    : `${dz.who === 'reze' ? 'Резе' : 'Волк'} · ${DZ_NAMES[dz.move] || ''} · ${heard ? '' : '≈'}${Math.round(dz.bpm)} BPM`;
  const S = Math.min(W / 150, H / 255), cx = W / 2, floorY = H * 0.87, hipY = floorY - 92 * S;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (dz.who === 'reze') dzSceneReze(c, W, H, dt, playing, t, floorY); else dzSceneWolf(c, W, H, dt, playing, t, floorY);
  // поза: смена движения за долю, тело догоняет цель
  const k = Math.min(1, Math.max(0, dz.b - dz.moveAt));
  let pose = dzPose(dz.move, dz.b, dz.energy);
  if (k < 1) pose = dzLerp(dzPose(dz.prevMove, dz.b, dz.energy), pose, k * k * (3 - 2 * k));
  dz.pose = dz.pose ? dzLerp(dz.pose, pose, 1 - Math.exp(-dt * 16)) : pose;
  const g = dzSkeleton(dz.pose);
  // тень: меньше, когда ноги в воздухе
  const lift = Math.min(dz.pose.lf[1], dz.pose.rf[1]);
  c.fillStyle = `rgba(0,0,0,${0.4 - Math.min(0.25, lift / 60)})`;
  c.beginPath(); c.ellipse(cx + dz.pose.px * S * 0.5, floorY + 2, (30 - Math.min(14, lift)) * S, 5 * S, 0, 0, TAU); c.fill();
  c.setTransform(dpr * S, 0, 0, dpr * S, cx * dpr, hipY * dpr);
  if (dz.who === 'reze') dzDrawReze(c, g, dz.pose, dt); else dzDrawWolf(c, g, dz.pose, dt);
  c.setTransform(1, 0, 0, 1, 0, 0);
}
/* ================= АУДИО · АУДИОКНИГИ =================
   Полка книг с прогрессом, продолжение с места, закладки с подписью, скорость
   чтения и скачивание для офлайна. Позиция пишется каждые 5 секунд и при
   паузе; при продолжении плеер отступает на 3 секунды назад, чтобы не терять
   фразу. Офлайн — файлы книги скачиваются в папку загрузок (как обычные
   загрузки) и дальше играют с диска через демон, без TorrServer и сети. */

const bk = { q: '', rows: [], busy: false, err: '', open: null, files: {}, dlPoll: 0 };
const BOOK_RE = /аудиокниг|audio\s?book|аудиоспектакл|радиоспектакл|радиопостановк|чита(ет|ют|ла)\b|чтец|исполнител[ья]|\bm4b\b|\bmp3\b|\baac\b|kbps|аудио/i;
const BOOK_NOT_RE = /\b(pdf|fb2|epub|djvu|mobi|azw3?|docx?|rtf|txt)\b/i;
function isBookRelease(t) { t = String(t || ''); return BOOK_RE.test(t) && !(BOOK_NOT_RE.test(t) && !/\bmp3\b|аудио/i.test(t)) && !MUSIC_VIDEO_RE.test(t); }
function bookList() { const a = jsonPref('tc_books', []); return Array.isArray(a) ? a : []; }
function saveBooks(l) { saveJson('tc_books', l.slice(0, 200)); }
function bookPosAll() { return jsonPref('tc_bookpos', {}); }
function bookSpeed() { const v = Number(localStorage.getItem('tc_bkspeed') || 1); return v >= 0.5 && v <= 3 ? v : 1; }
function bookSetSpeed(v) { savePref('tc_bkspeed', v); }
function bookMarks(hash) { return (jsonPref('tc_bookmarks', {})[hash] || []); }
function saveBookMarks(hash, l) { const all = jsonPref('tc_bookmarks', {}); all[hash] = l.slice(0, 200); saveJson('tc_bookmarks', all); }
function bookOffAll() { return jsonPref('tc_bookoff', {}); }
function bookOfflinePath(hash, id) { const o = bookOffAll()[hash]; return (o && o.files && o.files[id]) || ''; }
function bookKeepFiles(hash, files) {
  bk.files[hash] = files;
  const meta = jsonPref('tc_bookmeta', {}); meta[hash] = files.map(f => ({ id: f.id, path: f.path, length: f.length })); saveJson('tc_bookmeta', meta);
}
function bookFiles(hash) { return bk.files[hash] || jsonPref('tc_bookmeta', {})[hash] || null; }
function bookResumeIx(hash, files) { const p = bookPosAll()[hash]; return p && p.ix < files.length ? p.ix : 0; }
function bookResumeAt(hash, i) { const p = bookPosAll()[hash]; return p && p.ix === i ? Math.max(0, p.t - 3) : 0; }
let bookSaveAt = 0;
function bookSavePos(force) {
  const a = mu.audio; if (mu.kind !== 'book' || !mu.t || !a) return;
  if (!force && Date.now() - bookSaveAt < 5000) return;
  bookSaveAt = Date.now();
  const all = bookPosAll();
  all[mu.t.hash] = { ix: mu.ix, t: a.ended ? 0 : a.currentTime || 0, d: isFinite(a.duration) ? a.duration : 0, n: mu.queue.length, at: Date.now() };
  if (a.ended && mu.ix + 1 < mu.queue.length) all[mu.t.hash].ix = mu.ix + 1;
  saveJson('tc_bookpos', all);
}
function bookProgress(hash) {
  const p = bookPosAll()[hash]; if (!p || !p.n) return 0;
  return Math.min(1, (p.ix + (p.d ? p.t / p.d : 0)) / p.n);
}

function renderBooks(el) {
  el.innerHTML = html`<div class="mu-search">
      <span class="sb-ico">${raw(ico('search', 18))}</span>
      <input id="bkQ" placeholder="Название книги или автор…" value="${bk.q}" autocomplete="off">
      <button id="bkGo" class="primary">Найти</button>
    </div>
    <div id="bkBody"></div>`;
  const q = $('#bkQ');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') bookSearch(); });
  $('#bkGo').addEventListener('click', bookSearch);
  paintBooks();
}
async function bookSearch() {
  const q = ($('#bkQ').value || '').trim(); if (!q) return toast('Введите название или автора', true);
  bk.q = q; bk.busy = true; bk.rows = []; bk.open = null; paintBooks();
  const res = await audioTrackerSearch(q, 11, isBookRelease, 0.7);
  if (bk.q !== q) return;
  bk.rows = res.rows; bk.err = res.err; bk.busy = false; paintBooks();
}
function paintBooks() {
  const el = $('#bkBody'); if (!el) return;
  if (bk.open) return paintBookOpen(el);
  let h = '';
  const shelf = bookList();
  if (bk.busy) h += skeleton('Ищу аудиокниги и выбираю раздачу побыстрее…', 3);
  else if (bk.q) {
    h += bk.rows.length ? html`<div class="mu-h">Найдено ${bk.rows.length} · сверху самая быстрая</div><div class="mu-list">${raw(bk.rows.map((r, i) => html`
      <div class="mu-row${i === 0 ? ' best' : ''}">
        <button class="mu-play" data-bk-add="${i}" data-play="1" title="Слушать">${raw(ico('play', 14))}</button>
        <div class="mu-main"><div class="mu-t" title="${r.title}">${i === 0 ? raw('<span class="mu-badge">быстрее всех</span>') : ''}${r.title}</div>
          <div class="mu-s">${[musicFmt(r), r.size_bytes ? fmtSize(r.size_bytes) : r.size || '', '⬆ ' + (r.seed || 0)].filter(Boolean).join(' · ')}</div></div>
        <button class="iconbtn" data-bk-add="${i}" title="На полку">${raw(ico('plus', 15))}</button>
      </div>`).join(''))}</div>` : html`<div class="empty">Аудиокниг не нашлось.${bk.err ? ' ' + bk.err : ''}</div>`;
  }
  if (shelf.length) {
    const off = bookOffAll();
    h += html`<div class="mu-h">Моя полка</div><div class="au-grid">${raw(shelf.map((b, i) => { const p = bookProgress(b.hash); return html`
      <div class="au-card book${mu.t && mu.t.hash === b.hash ? ' on' : ''}">
        <button class="au-cover" data-bk-open="${i}" title="${b.title}">${raw(coverImg(b.title, b.hash, 'book'))}${raw(off[b.hash] && off[b.hash].done ? '<span class="au-off" title="Доступна офлайн">⤓</span>' : '')}</button>
        <div class="au-prog"><i style="width:${Math.round(p * 100)}%"></i></div>
        <div class="au-card-t" title="${b.title}">${b.title}</div>
        <div class="au-card-s">${p ? Math.round(p * 100) + '% прослушано' : 'не начата'}</div>
      </div>`; }).join(''))}</div>`;
  } else if (!bk.q && !bk.busy) h += html`<div class="empty">Найдите книгу — она ляжет на полку, а место, где вы остановились, запомнится.</div>`;
  el.innerHTML = h;
  hydrateCovers(el);
}
async function paintBookOpen(el) {
  const b = bookList().find(x => x.hash === bk.open); if (!b) { bk.open = null; return paintBooks(); }
  let files = bookFiles(b.hash);
  const pos = bookPosAll()[b.hash], marks = bookMarks(b.hash), off = bookOffAll()[b.hash], p = bookProgress(b.hash);
  const playingHere = mu.t && mu.t.hash === b.hash && mu.kind === 'book';
  el.innerHTML = html`<div class="bk-open">
    <button class="btn sm ghost" data-bk-back-shelf>← Полка</button>
    <div class="bk-hero">
      <div class="bk-cov">${raw(coverImg(b.title, b.hash, 'book'))}</div>
      <div class="bk-info"><h2>${b.title}</h2>
        <div class="au-prog big"><i style="width:${Math.round(p * 100)}%"></i></div>
        <div class="mu-s">${p ? Math.round(p * 100) + '% · глава ' + ((pos && pos.ix) + 1) + (files ? ' из ' + files.length : '') + ' · ' + fmtPos((pos && pos.t) || 0) : 'не начата'}</div>
        <div class="bk-acts">
          <button class="btn primary" data-bk-play>${raw(ico(playingHere && auPlaying() ? 'pause' : 'play', 15))} ${p ? 'Продолжить' : 'Слушать'}</button>
          ${raw(off && off.done ? html`<span class="bk-offok">⤓ Доступна офлайн</span>` : off && off.jobs ? html`<span class="bk-offok" id="bkDl">Скачиваю…</span>` : html`<button class="btn" data-bk-dl>${raw(ico('download', 15))} Скачать для офлайна</button>`)}
          <button class="btn ghost" data-bk-drop>Убрать с полки</button>
        </div></div></div>
    <div class="mu-h">Закладки</div>
    ${raw(marks.length ? html`<div class="mu-list">${raw(marks.map((m, i) => html`<div class="mu-row"><button class="mu-play" data-bk-go="${i}" title="Перейти">${raw(ico('bookmark', 14))}</button><div class="mu-main"><div class="mu-t">${m.note || 'Закладка'}</div><div class="mu-s">глава ${m.ix + 1} · ${fmtPos(m.t)} · ${new Date(m.at).toLocaleDateString('ru-RU')}</div></div><button class="iconbtn" data-bk-unmark="${i}" title="Удалить закладку">×</button></div>`).join(''))}</div>` : html`<div class="empty sm">Пока нет. Во время прослушивания нажмите ${raw(ico('bookmark', 13))} в плеере.</div>`)}
    <div class="mu-h">Главы</div><div class="mu-list" id="bkCh">${raw(files ? bookChaptersHtml(b.hash, files) : skeleton('Получаю список глав…', 2))}</div>
  </div>`;
  hydrateCovers(el);
  if (off && off.jobs) bookDlWatch();
  if (!files) {
    const st = await waitForFiles({ hash: b.hash, title: b.title });
    if (st && bk.open === b.hash) { files = (st.file_stats || []).filter(f => isAudio(f.path)).sort((a, c) => a.path.localeCompare(c.path, 'ru', { numeric: true })); bookKeepFiles(b.hash, files); const ch = $('#bkCh'); if (ch) ch.innerHTML = bookChaptersHtml(b.hash, files); }
  }
}
function bookChaptersHtml(hash, files) {
  const pos = bookPosAll()[hash] || { ix: -1 };
  return files.map((f, i) => html`<div class="mu-row${i === pos.ix ? ' best' : ''}"><button class="mu-play" data-bk-ch="${i}">${raw(i < pos.ix ? '✓' : ico('play', 13))}</button><div class="mu-main"><div class="mu-t">${musicTrackName(f)}</div><div class="mu-s">${[f.length ? fmtSize(f.length) : '', bookOfflinePath(hash, f.id) ? 'на диске' : '', i === pos.ix ? 'остановились на ' + fmtPos(pos.t) : ''].filter(Boolean).join(' · ')}</div></div></div>`).join('');
}
async function bookPlay(hash, ix, at) {
  const b = bookList().find(x => x.hash === hash); if (!b) return;
  if (mu.t && mu.t.hash === hash && mu.kind === 'book' && ix == null) return musicToggle();
  const files = bookFiles(hash);
  const allOff = files && files.every(f => bookOfflinePath(hash, f.id));
  if (ix != null) { const all = bookPosAll(); all[hash] = Object.assign(all[hash] || {}, { ix, t: at || 0, n: files ? files.length : 0 }); saveJson('tc_bookpos', all); }
  await musicPlayHash(hash, b.title, 'book', allOff ? files : null);
  if (bk.open) paintBooks();
}
async function bookAdd(r, play) {
  try {
    const { hash, title } = await audioAddRelease(r, 'audiobook');
    const l = bookList();
    if (!l.some(x => x.hash === hash)) { l.unshift({ hash, title, added: Date.now() }); saveBooks(l); }
    bk.open = hash; paintBooks();
    if (play) bookPlay(hash);
  } catch (e) { toast('Аудиокнига: ' + e.message, true); }
}
function bookMarkHere() {
  if (mu.kind !== 'book' || !mu.audio) return;
  const t = mu.audio.currentTime || 0, ix = mu.ix, hash = mu.t.hash;
  const note = prompt('Подпись к закладке (можно оставить пустой):', '') ;
  if (note === null) return;
  const l = bookMarks(hash); l.unshift({ ix, t, note: note.trim().slice(0, 140), at: Date.now() }); saveBookMarks(hash, l);
  toast('Закладка: глава ' + (ix + 1) + ', ' + fmtPos(t));
  if (bk.open === hash) paintBooks();
}

/* офлайн: каждый файл книги — отдельная загрузка в папку загрузок */
async function bookDownload(hash) {
  const b = bookList().find(x => x.hash === hash); if (!b) return;
  let files = bookFiles(hash);
  if (!files) { const st = await waitForFiles({ hash, title: b.title }); if (!st) return toast('Раздача не отдаёт список файлов', true); files = (st.file_stats || []).filter(f => isAudio(f.path)).sort((a, c) => a.path.localeCompare(c.path, 'ru', { numeric: true })); bookKeepFiles(hash, files); }
  const jobs = {};
  for (const f of files) {
    if (bookOfflinePath(hash, f.id)) continue;
    const name = (b.title.slice(0, 60) + ' - ' + basename(f.path)).replace(/[\\/:*?"<>|]/g, '_');
    try {
      const r = await fetch('/api/download?action=start&hash=' + encodeURIComponent(hash) + '&index=' + f.id + '&file=' + encodeURIComponent(name) + '&name=' + encodeURIComponent(b.title) + '&size=' + (f.length || 0), { method: 'POST' });
      const j = await r.json(); if (j.ok) jobs[j.id] = f.id;
    } catch {}
  }
  const all = bookOffAll(); all[hash] = Object.assign(all[hash] || { files: {} }, { jobs, done: false }); saveJson('tc_bookoff', all);
  toast('Скачиваю «' + b.title + '» для офлайна: ' + Object.keys(jobs).length + ' файлов. Видно и в «Загрузках»');
  paintBooks(); bookDlWatch();
}
function bookDlWatch() {
  clearTimeout(bk.dlPoll);
  bk.dlPoll = setTimeout(async () => {
    const all = bookOffAll(); let pending = false;
    try {
      const j = await api('/api/download?action=list');
      const byId = Object.fromEntries((j.jobs || []).map(x => [x.id, x]));
      for (const [hash, o] of Object.entries(all)) {
        if (!o.jobs) continue;
        let done = 0, total = 0, bytes = 0, size = 0;
        for (const [id, fid] of Object.entries(o.jobs)) {
          const x = byId[id]; total++;
          if (!x) continue;
          bytes += x.done || 0; size += x.total || 0;
          if (x.status === 'done') { o.files[fid] = x.path; done++; }
          else if (x.status === 'error' || x.status === 'cancelled') done++;
          else pending = true;
        }
        if (!pending || done === total) { delete o.jobs; const files = bookFiles(hash) || []; o.done = files.length > 0 && files.every(f => o.files[f.id]); if (o.done) toast('Аудиокнига скачана — слушается без сети'); }
        const el = $('#bkDl'); if (el && bk.open === hash) el.textContent = 'Скачиваю… ' + done + ' из ' + total + (size ? ' · ' + Math.round(bytes / size * 100) + '%' : '');
      }
      saveJson('tc_bookoff', all);
    } catch { pending = true; }
    if (pending) bookDlWatch(); else if (bk.open) paintBooks();
  }, 3000);
}

function onBookClick(t) {
  const g = (sel, k) => { const b = t.closest(sel); return b ? b.dataset[k] : null; };
  let v;
  if ((v = g('[data-bk-add]', 'bkAdd')) != null) { const r = bk.rows[+v]; if (r) bookAdd(r, !!t.closest('[data-play]')); return true; }
  if ((v = g('[data-bk-open]', 'bkOpen')) != null) { const b = bookList()[+v]; if (b) { bk.open = b.hash; paintBooks(); } return true; }
  if (t.closest('[data-bk-back-shelf]')) { bk.open = null; paintBooks(); return true; }
  if (t.closest('[data-bk-play]')) { bookPlay(bk.open); return true; }
  if ((v = g('[data-bk-ch]', 'bkCh')) != null) { bookPlay(bk.open, +v, 0); return true; }
  if ((v = g('[data-bk-go]', 'bkGo')) != null) { const m = bookMarks(bk.open)[+v]; if (m) bookPlay(bk.open, m.ix, m.t); return true; }
  if ((v = g('[data-bk-unmark]', 'bkUnmark')) != null) { const l = bookMarks(bk.open); l.splice(+v, 1); saveBookMarks(bk.open, l); paintBooks(); return true; }
  if (t.closest('[data-bk-dl]')) { bookDownload(bk.open); return true; }
  if (t.closest('[data-bk-drop]')) { const h = bk.open, l = bookList(), i = l.findIndex(x => x.hash === h); if (i >= 0) { const [gone] = l.splice(i, 1); saveBooks(l); bk.open = null; paintBooks(); toastUndo('Убрано с полки: ' + gone.title, () => { const ll = bookList(); ll.splice(i, 0, gone); saveBooks(ll); paintBooks(); }); } return true; }
  if (t.closest('[data-bk-mark]')) { bookMarkHere(); return true; }
  if (t.closest('[data-bk-back]')) { if (mu.audio) mu.audio.currentTime = Math.max(0, mu.audio.currentTime - 15); return true; }
  if (t.closest('[data-bk-fwd]')) { if (mu.audio) mu.audio.currentTime = mu.audio.currentTime + 30; return true; }
  return false;
}
/* ================= АУДИО · РАДИО =================
   Те же станции, что в радио Hermes Agent: Nightride FM (Chillsynth,
   Nightride, Darksynth, Spacesynth), Radio Paradise (Main и Mellow Mix) и EVE
   Radio, плюс поиск по каталогу Radio Browser (50 тысяч станций), жанры и
   «Россия». Закреплённые станции, громкость, следующая станция, ссылка на
   сайт вещателя, название песни (где вещатель его отдаёт) и живая форма
   волны по настоящему звуку.
   Звук читается, только если станция отвечает с CORS: тогда она подключается
   к общему графу (осциллограф, танцовщица). Если нет — поток играет мимо
   графа, а вместо волны показывается индикатор активности, а не выдуманные
   уровни. Пауза отпускает поток; «играть» возвращает в прямой эфир. */

const NIGHTRIDE = 'https://stream.nightride.fm/';
const RADIO_PRESETS = [
  { id: 'chillsynth', name: 'Chillsynth', description: 'Мягкий фокус · тёплые синты', provider: 'Nightride FM', url: NIGHTRIDE + 'chillsynth.mp3', homepage: 'https://nightride.fm/?station=chillsynth' },
  { id: 'nightride', name: 'Nightride', description: 'Синтвейв · после полуночи', provider: 'Nightride FM', url: NIGHTRIDE + 'nightride.mp3', homepage: 'https://nightride.fm/' },
  { id: 'darksynth', name: 'Darksynth', description: 'Тёмная электроника · высокая энергия', provider: 'Nightride FM', url: NIGHTRIDE + 'darksynth.mp3', homepage: 'https://nightride.fm/?station=darksynth' },
  { id: 'spacesynth', name: 'Spacesynth', description: 'Космические синты · ретро-будущее', provider: 'Nightride FM', url: NIGHTRIDE + 'spacesynth.mp3', homepage: 'https://nightride.fm/?station=spacesynth' },
  { id: 'paradise-main', name: 'Main Mix', description: 'Эклектика · подобрано людьми', provider: 'Radio Paradise', url: 'https://stream.radioparadise.com/aac-128', homepage: 'https://radioparadise.com/' },
  { id: 'paradise-mellow', name: 'Mellow Mix', description: 'Помедленнее и помягче', provider: 'Radio Paradise', url: 'https://stream.radioparadise.com/mellow-flac', homepage: 'https://radioparadise.com/' },
  { id: 'eve-radio', name: 'EVE Radio', description: 'GamingNow · радио сообщества EVE', provider: 'GamingNow', url: 'https://media01.gamingnow.net:8010/erweb.mp3', homepage: 'https://gamingnow.net/eve-radio/' },
];
const RADIO_META = { 'stream.nightride.fm': NIGHTRIDE + 'status-json.xsl', 'media01.gamingnow.net': 'https://media01.gamingnow.net:8010/status-json.xsl' };
const RADIO_TAGS = [['', 'Популярные'], ['@RU', 'Россия'], ['synthwave', 'Синтвейв'], ['lofi', 'Lo-fi'], ['chillout', 'Чилаут'], ['electronic', 'Электроника'], ['rock', 'Рок'], ['jazz', 'Джаз'], ['classical', 'Классика'], ['80s', '80-е'], ['news', 'Новости']];
const rd = { list: null, q: '', busy: false, err: '', station: null, status: 'idle', title: '', a: null, b: null, cors: true, servers: ['https://de1.api.radio-browser.info'], discovered: false, metaT: 0, raf: 0, traces: [] };

function radioPins() { const a = jsonPref('tc_radiopins', null); return Array.isArray(a) ? a : RADIO_PRESETS.slice(0, 3); }
function saveRadioPins(l) { saveJson('tc_radiopins', l.slice(0, 40)); }
function sameStation(a, b) { return a && b && (a.id === b.id || a.url === b.url); }
function radioEl() { if (!rd.station) return null; return { el: rd.cors ? rd.a : rd.b, cors: rd.cors }; }
function radioElem(cors) {
  const k = cors ? 'a' : 'b';
  if (rd[k]) return rd[k];
  const el = document.createElement('audio');
  if (cors) el.crossOrigin = 'anonymous';
  el.preload = 'none';
  el.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('tc_muvol') || 0.8)));
  el.addEventListener('playing', () => { rd.status = 'live'; paintRadioStatus(); radioMeta(); });
  el.addEventListener('waiting', () => { if (rd.status === 'live') { rd.status = 'connecting'; paintRadioStatus(); } });
  el.addEventListener('pause', () => { paintMusicPlayer(); paintNowPlaying(); });
  el.addEventListener('error', () => {
    if (!rd.station || el !== (rd.cors ? rd.a : rd.b) || !el.getAttribute('src')) return;
    // Станция без CORS: повторяем без анализа, как обычный поток.
    if (cors) { rd.cors = false; const b = radioElem(false); b.src = rd.station.url; b.play().catch(() => {}); return; }
    rd.status = 'error'; paintRadioStatus(); toast('Станция не отвечает: ' + rd.station.name, true);
  });
  document.body.appendChild(el);
  rd[k] = el;
  return el;
}
function radioPlay(st) {
  if (mu.audio && !mu.audio.paused) mu.audio.pause();
  if (mu.kind === 'book') bookSavePos(true);
  radioStop(true);
  rd.station = st; rd.cors = true; rd.status = 'connecting'; rd.title = '';
  mu.kind = 'radio';
  savePref('tc_radiolast', JSON.stringify(st));
  const el = radioElem(true);
  auHook(el);
  el.src = st.url; el.play().catch(() => {});
  dancerNewTrack();
  paintMusicPlayer(); paintNowPlaying(); paintRadioList();
}
function radioStop(keepKind) {
  for (const el of [rd.a, rd.b]) if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
  clearTimeout(rd.metaT);
  if (!keepKind) { rd.station = null; rd.status = 'idle'; if (mu.kind === 'radio') mu.kind = ''; paintMusicPlayer(); paintNowPlaying(); paintRadioList(); }
}
function radioToggle() {
  const r = radioEl(); if (!r) return;
  // Пауза отпускает поток: вернуться можно только в прямой эфир.
  if (!r.el.paused) { r.el.pause(); r.el.removeAttribute('src'); r.el.load(); rd.status = 'paused'; paintMusicPlayer(); paintNowPlaying(); return; }
  radioPlay(rd.station);
}
function radioCurrentList() { return rd.list && rd.list.length ? rd.list : radioPins().concat(RADIO_PRESETS.filter(p => !radioPins().some(x => sameStation(x, p)))); }
function radioNext(d) {
  const l = radioCurrentList(); if (!l.length) return;
  const i = l.findIndex(x => sameStation(x, rd.station));
  radioPlay(l[(i + (d || 1) + l.length) % l.length]);
}
function radioNow() {
  if (!rd.station) return null;
  const r = radioEl();
  return { label: rd.title || rd.station.name, sub: (r && r.el.paused ? 'пауза · ' : 'радио · ') + rd.station.name, paused: !r || r.el.paused };
}

/* ── каталог Radio Browser ── */
async function rbFetch(path) {
  if (!rd.discovered) {
    rd.discovered = true;
    try {
      const s = await (await fetch(rd.servers[0] + '/json/servers', { signal: AbortSignal.timeout(8000) })).json();
      const hosts = [...new Set(s.map(x => x.name).filter(n => /^[a-z0-9-]+\.api\.radio-browser\.info$/.test(n)))];
      if (hosts.length) rd.servers = hosts.map(n => 'https://' + n).sort(() => Math.random() - 0.5);
    } catch {}
  }
  let last;
  for (const srv of rd.servers.slice(0, 3)) {
    try { const r = await fetch(srv + path, { signal: AbortSignal.timeout(10000), credentials: 'omit' }); if (r.ok) return await r.json(); last = new Error('HTTP ' + r.status); } catch (e) { last = e; }
  }
  throw last || new Error('каталог не отвечает');
}
function rbStations(rows) {
  const seen = new Set();
  return (rows || []).flatMap(r => {
    const url = r.url_resolved || r.url;
    if (!/^https?:\/\//.test(url || '') || !r.stationuuid || !r.name || r.hls || seen.has(url)) return [];
    seen.add(url);
    return [{ id: r.stationuuid, name: r.name.trim().slice(0, 80), url, provider: [r.country, r.codec && r.codec + (r.bitrate ? ' ' + r.bitrate : '')].filter(Boolean).join(' · '), description: (r.tags || '').split(',').filter(Boolean).slice(0, 3).join(' · '), homepage: /^https?:/.test(r.homepage || '') ? r.homepage : '', favicon: /^https:/.test(r.favicon || '') ? r.favicon : '' }];
  });
}
async function radioSearch(q, tag) {
  rd.busy = true; rd.err = ''; paintRadioList();
  try {
    const base = 'limit=60&hidebroken=true&order=votes&reverse=true';
    let path;
    if (tag === '@RU') path = '/json/stations/bycountrycodeexact/RU?' + base;
    else if (tag) path = '/json/stations/bytagexact/' + encodeURIComponent(tag) + '?' + base;
    else if (q) path = '/json/stations/search?name=' + encodeURIComponent(q) + '&' + base;
    else path = '/json/stations/topvote/60?hidebroken=true';
    const local = q ? RADIO_PRESETS.filter(p => (p.name + ' ' + p.provider + ' ' + p.description).toLowerCase().includes(q.toLowerCase())) : [];
    const found = rbStations(await rbFetch(path));
    rd.list = local.concat(found.filter(f => !local.some(l => sameStation(l, f))));
  } catch (e) { rd.err = e.message; rd.list = []; }
  rd.busy = false; paintRadioList();
}

/* ── вкладка ── */
function renderRadio(el) {
  el.innerHTML = html`<div class="rd-now" id="rdNow"></div>
    <div class="mu-search">
      <span class="sb-ico">${raw(ico('search', 18))}</span>
      <input id="rdQ" placeholder="Станция, город, жанр…" value="${rd.q}" autocomplete="off">
      <button id="rdGo" class="primary">Найти</button>
    </div>
    <div class="rd-tags">${raw(RADIO_TAGS.map(([t, l]) => html`<button class="chip" data-rd-tag="${t}">${l}</button>`).join(''))}</div>
    <div id="rdList"></div>`;
  const q = $('#rdQ');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { rd.q = q.value.trim(); radioSearch(rd.q); } });
  $('#rdGo').addEventListener('click', () => { rd.q = q.value.trim(); radioSearch(rd.q); });
  paintRadioStatus(); paintRadioList();
}
function stationRow(s, i, from) {
  const cur = sameStation(s, rd.station), pinned = radioPins().some(x => sameStation(x, s));
  const playing = cur && rd.status !== 'paused' && rd.status !== 'idle';
  return html`<div class="mu-row rd-row${cur ? ' best' : ''}">
    <button class="mu-play" data-rd-play="${from}:${i}" title="${playing ? 'Пауза' : 'Слушать'}">${raw(ico(playing ? 'pause' : 'play', 14))}</button>
    ${raw(s.favicon ? `<img class="rd-ico" src="${esc(s.favicon)}" alt="" loading="lazy" onerror="this.remove()">` : '')}
    <div class="mu-main"><div class="mu-t">${s.name}</div><div class="mu-s">${[s.provider, s.description].filter(Boolean).join(' · ')}</div></div>
    <button class="iconbtn${pinned ? ' on' : ''}" data-rd-pin="${from}:${i}" title="${pinned ? 'Открепить' : 'Закрепить'}">${raw(ico('star', 15))}</button>
  </div>`;
}
function paintRadioList() {
  const el = $('#rdList'); if (!el) return;
  const pins = radioPins();
  let h = '';
  if (rd.busy) h += skeleton('Ищу станции…', 3);
  else if (rd.list) h += rd.list.length ? html`<div class="mu-h">Найдено ${rd.list.length} <button class="btn sm ghost" data-rd-clear>×</button></div><div class="mu-list">${raw(rd.list.map((s, i) => stationRow(s, i, 'l')).join(''))}</div>` : html`<div class="empty">Станций не нашлось.${rd.err ? ' ' + rd.err : ''}</div>`;
  if (pins.length) h += html`<div class="mu-h">Закреплённые</div><div class="mu-list">${raw(pins.map((s, i) => stationRow(s, i, 'p')).join(''))}</div>`;
  h += html`<div class="mu-h">Подборка</div><div class="mu-list">${raw(RADIO_PRESETS.map((s, i) => stationRow(s, i, 'r')).join(''))}</div>`;
  el.innerHTML = h;
}
function stationFrom(ref) { const [w, i] = String(ref).split(':'); const l = w === 'l' ? rd.list || [] : w === 'p' ? radioPins() : RADIO_PRESETS; return l[+i]; }
function paintRadioStatus() {
  const el = $('#rdNow');
  if (el) {
    if (!rd.station) el.innerHTML = '';
    else {
      el.innerHTML = html`<canvas id="rdWave"></canvas><div class="rd-now-t"><small>${rd.station.provider || 'Радио'} · ${({ live: '● в эфире', connecting: 'подключаюсь…', paused: 'пауза', error: 'не отвечает' })[rd.status] || ''}${rd.cors ? '' : ' · звук без анализа'}</small><b>${rd.title || rd.station.name}</b>${raw(rd.title ? html`<span>${rd.station.name}</span>` : '')}</div>
        ${raw(rd.station.homepage ? html`<button class="btn sm ghost" data-rd-site>Сайт станции ↗</button>` : '')}`;
      radioWaveStart();
    }
  }
  const t = $('#rdBarT'); if (t) t.innerHTML = radioBarTitle();
  paintNowPlaying();
}

/* название песни: Icecast-статус Nightride и EVE, пока играет */
async function radioMeta() {
  clearTimeout(rd.metaT);
  const st = rd.station; if (!st || rd.status !== 'live') return;
  let u; try { u = new URL(st.url); } catch { return; }
  const ep = RADIO_META[u.hostname]; if (!ep) return;
  try {
    const j = await (await fetch(ep, { signal: AbortSignal.timeout(8000), credentials: 'omit' })).json();
    const src = [].concat((j.icestats && j.icestats.source) || []).find(s => String(s.listenurl || '').endsWith(u.pathname));
    const title = src && typeof src.title === 'string' ? src.title.trim() : '';
    if (sameStation(st, rd.station) && title !== rd.title) { rd.title = title; paintRadioStatus(); dancerNewTrack(); }
  } catch {}
  rd.metaT = setTimeout(radioMeta, 25000);
}

/* живая волна с двумя тусклыми следами прошлых кадров */
function radioWaveStart() {
  cancelAnimationFrame(rd.raf);
  const cv = $('#rdWave'); if (!cv) return;
  const draw = () => {
    if (!cv.isConnected) return;
    rd.raf = requestAnimationFrame(draw);
    if (document.hidden) return;
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#7cb0ff';
    const r = radioEl(), an = r && r.cors && !r.el.paused ? auHook(r.el) : null;
    if (an) {
      an.getByteTimeDomainData(auGraph.wave);
      const pts = []; const n = 160, step = Math.floor(auGraph.wave.length / n);
      for (let i = 0; i < n; i++) pts.push((auGraph.wave[i * step] - 128) / 128);
      rd.traces.unshift(pts); rd.traces.length = Math.min(rd.traces.length, 3);
      rd.traces.slice().reverse().forEach((p, k, arr) => {
        const age = arr.length - 1 - k;
        c.strokeStyle = acc; c.globalAlpha = age ? 0.18 / age : 0.95; c.lineWidth = age ? 1 : 1.6;
        c.beginPath(); p.forEach((v, i) => { const x = i / (n - 1) * w, y = h / 2 + v * h * 0.45; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
      });
      c.globalAlpha = 1;
    } else {
      // без доступа к звуку — честный индикатор активности, а не выдуманная волна
      const t = performance.now() / 1000, live = r && !r.el.paused;
      c.fillStyle = acc;
      for (let i = 0; i < 5; i++) { c.globalAlpha = live ? 0.3 + 0.7 * Math.max(0, Math.sin(t * 4 - i * 0.7)) : 0.2; c.beginPath(); c.arc(w / 2 + (i - 2) * 14, h / 2, 3.5, 0, Math.PI * 2); c.fill(); }
      c.globalAlpha = 1;
    }
  };
  draw();
}

function radioBarTitle() {
  if (!rd.station) return '';
  return html`<b title="${rd.title || rd.station.name}">${rd.title || rd.station.name}</b><small>${rd.station.name} · ${({ live: 'в эфире', connecting: 'подключаюсь…', paused: 'пауза — «играть» вернёт в эфир', error: 'станция не отвечает' })[rd.status] || ''}</small>`;
}
function radioBarHtml() {
  const r = radioEl(), playing = r && !r.el.paused;
  const pinned = radioPins().some(x => sameStation(x, rd.station));
  return html`<div class="mu-bar">
    <div class="mu-bar-cov rd-cov">${raw(rd.station.favicon ? `<img src="${esc(rd.station.favicon)}" alt="">` : '📻')}</div>
    <div class="mu-bar-t" id="rdBarT">${raw(radioBarTitle())}</div>
    <div class="mu-ctl">
      <button class="iconbtn mu-pp" data-mu-pp title="${playing ? 'Пауза (отпустить поток)' : 'Играть — в прямой эфир'}">${raw(ico(playing ? 'pause' : 'play', 17))}</button>
      <button class="iconbtn" data-mu-next title="Следующая станция">⏭</button>
      <button class="iconbtn${pinned ? ' on' : ''}" data-rd-pinnow title="Закрепить станцию">${raw(ico('star', 15))}</button>
      <button class="iconbtn" data-mu-stop title="Выключить радио">${raw(ico('stop', 14))}</button>
    </div>
    <input type="range" class="mu-vol" min="0" max="100" value="${Math.round((r ? r.el.volume : 0.8) * 100)}" id="rdVol" title="Громкость">
  </div>`;
}
function bindRadioBar() {
  const v = $('#rdVol'); if (v) v.addEventListener('input', () => { for (const el of [rd.a, rd.b, mu.audio]) if (el) el.volume = v.value / 100; savePref('tc_muvol', v.value / 100); });
}
function togglePin(s) {
  const l = radioPins(), i = l.findIndex(x => sameStation(x, s));
  if (i >= 0) l.splice(i, 1); else l.unshift(s);
  saveRadioPins(l); paintRadioList(); if (mu.kind === 'radio') paintMusicPlayer();
}
function onRadioClick(t) {
  const g = (sel, k) => { const b = t.closest(sel); return b ? b.dataset[k] : null; };
  let v;
  if ((v = g('[data-rd-play]', 'rdPlay')) != null) { const s = stationFrom(v); if (!s) return true; if (sameStation(s, rd.station) && rd.status !== 'paused') radioToggle(); else radioPlay(s); return true; }
  if ((v = g('[data-rd-pin]', 'rdPin')) != null) { const s = stationFrom(v); if (s) togglePin(s); return true; }
  if (t.closest('[data-rd-pinnow]')) { if (rd.station) togglePin(rd.station); return true; }
  if ((v = g('[data-rd-tag]', 'rdTag')) != null) { document.querySelectorAll('[data-rd-tag]').forEach(b => b.classList.toggle('on', b.dataset.rdTag === v)); radioSearch('', v); return true; }
  if (t.closest('[data-rd-clear]')) { rd.list = null; rd.q = ''; const q = $('#rdQ'); if (q) q.value = ''; document.querySelectorAll('[data-rd-tag]').forEach(b => b.classList.remove('on')); paintRadioList(); return true; }
  if (t.closest('[data-rd-site]')) { if (rd.station && rd.station.homepage) launchPlayer('browser', rd.station.homepage); return true; }
  return false;
}
/* ───────────── смотрим вместе ─────────────
   Комната на двоих (и больше): у каждого свой TorrClient и своя раздача,
   а по сети ходят только команды, чат, голос и показ экрана.
   • Связь: WebRTC напрямую (STUN Google и Cloudflare, свой TURN — по
     желанию). Найти друг друга и передать предложения WebRTC помогает
     публичный MQTT-брокер по WebSocket; он же — запасной путь, если
     напрямую не вышло. Всё, что идёт через брокер, зашифровано AES-GCM
     ключом из приглашения: брокер видит только шум.
   • Синхронизация: ведущий (создатель) — источник правды. Его плеер
     (mpv или VLC, через /api/together/player) раз в 2 с рассылает позицию;
     у гостя небольшое расхождение выбирается скоростью ±5 %, большое —
     перемоткой. Пауза или перемотка у гостя уходит ведущему и дальше всем.
     Если у кого-то не грузится — пауза у всех и отсчёт 3-2-1. */
const TG_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const TG_REACT = ['😂', '😱', '❤️', '👍', '🔥', '🍿'];
const tg = { on: false, room: '', key: null, keyB64: '', host: false, me: '', name: '', peers: new Map(), mq: [], seen: new Map(),
  media: null, chat: [], mic: null, screen: null, hostId: '', off: [], st: null, stAt: 0, mine: null, prev: null, adj: false,
  cmdAt: 0, hold: 0, stall: 0, waitAt: 0, waitFor: '', timers: [], unread: 0, sync: '', lastSt: '', pingN: 0 };
const tgRid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const tgB64e = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const tgB64d = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

/* ── MQTT 3.1.1 поверх WebSocket: CONNECT, SUBSCRIBE, PUBLISH (QoS 0), PING ── */
function mqStr(s) { const b = new TextEncoder().encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function mqLen(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return o; }
function mqPkt(h, body) { const head = [h, ...mqLen(body.length)], out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out; }
class TgMqtt {
  constructor(url, topic, onMsg, onState) { Object.assign(this, { url, topic, onMsg, onState, ok: false, fail: 0, closed: false }); this.connect(); }
  connect() {
    if (this.closed) return;
    let ws; try { ws = new WebSocket(this.url, 'mqtt'); } catch { this.retry(); return; }
    ws.binaryType = 'arraybuffer'; this.ws = ws; this.buf = new Uint8Array(0); this.ok = false;
    ws.onopen = () => ws.send(mqPkt(0x10, [...mqStr('MQTT'), 4, 2, 0, 60, ...mqStr('tc' + tgRid(6))]));
    ws.onmessage = e => this.feed(new Uint8Array(e.data));
    ws.onclose = () => { const was = this.ok; this.ok = false; clearInterval(this.ping); if (was) this.onState(); this.retry(); };
    ws.onerror = () => {};
  }
  retry() { if (this.closed) return; this.fail++; clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), Math.min(30000, 1500 * this.fail)); }
  feed(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
    for (;;) {
      const B = this.buf; if (B.length < 2) return;
      let len = 0, mul = 1, i = 1;
      for (;; i++) { if (i >= B.length) return; len += (B[i] & 127) * mul; mul *= 128; if (!(B[i] & 128)) break; if (i > 4) { this.ws.close(); return; } }
      const start = i + 1; if (B.length < start + len) return;
      this.handle(B[0] >> 4, B[0] & 15, B.subarray(start, start + len));
      this.buf = B.slice(start + len);
    }
  }
  handle(type, flags, body) {
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws.close(); return; }
      this.ok = true; this.fail = 0;
      this.ws.send(mqPkt(0x82, [0, 1, ...mqStr(this.topic), 0]));
      clearInterval(this.ping); this.ping = setInterval(() => { try { this.ws.send(new Uint8Array([0xC0, 0])); } catch {} }, 30000);
      this.onState();
    } else if (type === 3) { // PUBLISH
      const tl = (body[0] << 8) | body[1]; let i = 2 + tl; if ((flags >> 1) & 3) i += 2;
      this.onMsg(body.slice(i));
    }
  }
  pub(payload) {
    if (!this.ok) return false;
    const t = mqStr(this.topic), p = new Uint8Array(t.length + payload.length); p.set(t); p.set(payload, t.length);
    try { this.ws.send(mqPkt(0x30, p)); return true; } catch { return false; }
  }
  close() { this.closed = true; clearInterval(this.ping); clearTimeout(this.rt); try { this.ws && this.ws.close(); } catch {} }
}

/* ── шифрование ── */
async function tgSeal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tg.key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
async function tgUnseal(bytes) {
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, tg.key, bytes.slice(12)))); } catch { return null; }
}

/* ── приглашение ── */
function tgCode() {
  const m = tg.media || {};
  const o = { r: tg.room, k: tg.keyB64, h: m.h || '', f: m.f, t: m.t || '', b: localStorage.getItem('tc_tg_broker') || '' };
  return 'TC1.' + tgB64e(new TextEncoder().encode(JSON.stringify(o)));
}
function tgParse(code) {
  const s = String(code || '').trim().replace(/\s+/g, ''), m = s.match(/TC1\.([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try { const o = JSON.parse(new TextDecoder().decode(tgB64d(m[1]))); return o && /^[0-9a-f]{16,64}$/.test(o.r) && o.k ? o : null; } catch { return null; }
}

/* ── вход и выход ── */
function tgIce() {
  const s = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const t = (localStorage.getItem('tc_tg_turn') || '').trim();
  if (t) s.push({ urls: t, username: localStorage.getItem('tc_tg_turnu') || '', credential: localStorage.getItem('tc_tg_turnp') || '' });
  return s;
}
function tgCanRun() { return !!(window.crypto && crypto.subtle && window.RTCPeerConnection && window.isSecureContext); }
function tgMyName() { return (localStorage.getItem('tc_tg_name') || '').trim() || (typeof devName === 'function' ? devName() : 'Гость'); }
async function tgStart(o, host) {
  if (!tgCanRun()) { toast('Браузер разрешает шифрование и звонки только на защищённом адресе — откройте TorrClient на этом компьютере (localhost)', true); return false; }
  if (tg.on) tgLeave(true);
  tg.room = o.r; tg.keyB64 = o.k; tg.host = host; tg.me = tgRid(6); tg.name = tgMyName();
  try { tg.key = await crypto.subtle.importKey('raw', tgB64d(o.k), 'AES-GCM', false, ['encrypt', 'decrypt']); } catch { toast('Код приглашения повреждён', true); return false; }
  tg.on = true; tg.chat = []; tg.unread = 0; tg.off = []; tg.st = null; tg.mine = null; tg.prev = null; tg.sync = ''; tg.lastSt = '';
  tg.media = o.h ? { h: o.h, f: o.f, t: o.t } : null;
  const own = (localStorage.getItem('tc_tg_broker') || o.b || '').trim();
  const list = own ? [own] : TG_BROKERS;
  tg.mq = list.map(u => new TgMqtt(u, 'torrclient/v1/' + tg.room, b => tgUnseal(b).then(m => tgRecv(m, 'mqtt')), () => { if (tg.mq.some(c => c.ok)) tgHello(); tgPaint(); }));
  tg.timers = [setInterval(tgTick, 1000), setInterval(tgHello, 15000)];
  try { sessionStorage.setItem('tc_tg', JSON.stringify({ o, host })); } catch {}
  tgNote(host ? 'Комната создана — отправьте другу код приглашения' : 'Подключаюсь к комнате…');
  tgPaint();
  return true;
}
function tgCreate() { return tgStart({ r: tgRid(12), k: tgB64e(crypto.getRandomValues(new Uint8Array(16))), h: '' }, true).then(ok => { if (ok) tgTick(); }); }
function tgLeave(quiet) {
  if (!tg.on) return;
  try { tgSend({ k: 'bye' }); } catch {}
  for (const p of [...tg.peers.values()]) tgDropPeer(p, true);
  tg.peers.clear();
  const mq = tg.mq; setTimeout(() => mq.forEach(c => c.close()), 300);
  tg.timers.forEach(clearInterval); tg.timers = [];
  for (const s of [tg.mic, tg.screen]) if (s) s.getTracks().forEach(t => t.stop());
  tg.mic = tg.screen = null; tg.on = false; tg.st = null;
  if (tg.adj && tg.mine && tg.mine.active) tgCmd('rate', 1);
  tg.adj = false;
  try { sessionStorage.removeItem('tc_tg'); } catch {}
  tgHideScreen();
  if (!quiet) toast('Вы вышли из комнаты');
  tgPaint();
}

/* ── отправка и приём ── */
function tgSeen(id) {
  if (tg.seen.has(id)) return true;
  tg.seen.set(id, 1);
  if (tg.seen.size > 600) [...tg.seen.keys()].slice(0, 200).forEach(k => tg.seen.delete(k));
  return false;
}
async function tgSend(m, viaMqtt) {
  if (!tg.on) return;
  m.id = m.id || tgRid(6); m.from = tg.me; m.name = tg.name; if (tg.host) m.host = 1;
  tgSeen(m.id);
  const targets = m.to ? [tg.peers.get(m.to)].filter(Boolean) : [...tg.peers.values()];
  let mq = !!viaMqtt || !targets.length;
  if (!viaMqtt) for (const p of targets) {
    if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(JSON.stringify(m)); continue; } catch {} }
    mq = true;
  }
  if (mq) { const b = await tgSeal(m); tg.mq.forEach(c => c.pub(b)); }
}
function tgHello() { if (tg.on) tgSend({ k: 'hello', media: tg.host ? tg.media : undefined }, true); }
function tgRecv(m, via) {
  if (!tg.on || !m || !m.id || !m.from || m.from === tg.me || tgSeen(m.id)) return;
  if (m.to && m.to !== tg.me) return;
  if (m.k === 'bye') { const p = tg.peers.get(m.from); if (p) { tgNote(`${p.name} вышел(а)`); tgDropPeer(p); } return; }
  const known = tg.peers.has(m.from);
  const p = tgPeer(m.from, m.name, m.host);
  if (!known) { tgNote(`${p.name} в комнате`); tgPaint(); if (m.k === 'hello') tgSend({ k: 'hello', to: m.from, media: tg.host ? tg.media : undefined }, true); }
  if (m.host && m.media && !tg.host) tg.media = m.media;
  switch (m.k) {
    case 'sig': p.q = p.q.then(() => tgSig(p, m)); break;
    case 'chat': tgChatIn(p, String(m.text || '').slice(0, 500)); break;
    case 'react': if (TG_REACT.includes(m.e)) tgReactIn(p, m.e); break;
    case 'st': if (m.host) tgFollow(m); break;
    case 'ping': tgSend({ k: 'pong', to: m.from, t0: m.t0, t1: Date.now() }); break;
    case 'pong': tgPong(m); break;
    case 'req': if (tg.host) tgHostReq(p, m); break;
    case 'wait': if (tg.host) tgHostWait(p); break;
    case 'ready': if (tg.host && tg.waitFor === p.id) { tg.waitFor = ''; tgCountdown(); } break;
    case 'cd': if (m.host) tgRunCountdown(m.pos, m.at - tgOffset()); break;
    case 'screen': if (!m.on) tgHideScreen(p.id); break;
  }
}

/* ── WebRTC: «вежливые переговоры», канал данных согласован заранее ── */
function tgPeer(id, name, isHost) {
  let p = tg.peers.get(id);
  if (!p) {
    p = { id, name: 'Гость', last: Date.now(), polite: tg.me > id, making: false, ignore: false, q: Promise.resolve(), cands: [], auds: {} };
    tg.peers.set(id, p); tgPc(p);
  }
  p.last = Date.now(); if (name) p.name = String(name).slice(0, 40);
  if (isHost) { p.host = true; tg.hostId = id; }
  return p;
}
function tgPc(p) {
  const pc = new RTCPeerConnection({ iceServers: tgIce() });
  p.pc = pc;
  p.dc = pc.createDataChannel('tc', { negotiated: true, id: 0 });
  p.dc.onopen = () => { tgNote(`С ${p.name} — напрямую (P2P)`); tgPaint(); };
  p.dc.onclose = () => tgPaint();
  p.dc.onmessage = e => { try { tgRecv(JSON.parse(e.data), 'p2p'); } catch {} };
  pc.onnegotiationneeded = async () => {
    try { p.making = true; await pc.setLocalDescription(); tgSend({ k: 'sig', to: p.id, desc: pc.localDescription.toJSON() }); } catch {} finally { p.making = false; }
  };
  pc.onicecandidate = e => { if (e.candidate) tgSend({ k: 'sig', to: p.id, cand: e.candidate.toJSON() }); };
  pc.ontrack = e => tgTrack(p, e);
  pc.onconnectionstatechange = () => { tgPaint(); if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch {} } };
  for (const s of [tg.mic, tg.screen]) if (s) s.getTracks().forEach(t => { try { pc.addTrack(t, s); } catch {} });
}
async function tgSig(p, m) {
  const pc = p.pc;
  try {
    if (m.desc) {
      const collision = m.desc.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision; if (p.ignore) return;
      await pc.setRemoteDescription(m.desc);
      for (const c of p.cands.splice(0)) { try { await pc.addIceCandidate(c); } catch {} }
      if (m.desc.type === 'offer') { await pc.setLocalDescription(); tgSend({ k: 'sig', to: p.id, desc: pc.localDescription.toJSON() }); }
    } else if (m.cand) {
      // кандидат мог обогнать предложение (разные брокеры) — подождёт
      if (!pc.remoteDescription) { p.cands.push(m.cand); return; }
      try { await pc.addIceCandidate(m.cand); } catch {}
    }
  } catch {}
}
function tgDropPeer(p, quiet) {
  try { p.pc.close(); } catch {}
  Object.values(p.auds).forEach(a => { try { a.srcObject = null; } catch {} });
  tg.peers.delete(p.id); if (tg.hostId === p.id) tg.hostId = '';
  tgHideScreen(p.id);
  if (!quiet) tgPaint();
}
function tgLink(p) {
  if (p.dc && p.dc.readyState === 'open') return 'P2P';
  return tg.mq.some(c => c.ok) ? 'через MQTT' : 'нет связи';
}

/* ── голос и экран ── */
function tgTrack(p, e) {
  const s = e.streams[0] || new MediaStream([e.track]);
  if (e.track.kind === 'video') { tgShowScreen(p, s); return; }
  let a = p.auds[s.id]; if (!a) { a = p.auds[s.id] = new Audio(); a.autoplay = true; }
  a.srcObject = s; a.play().catch(() => {});
}
function tgAddTracks(s) { for (const p of tg.peers.values()) s.getTracks().forEach(t => { try { p.pc.addTrack(t, s); } catch {} }); }
function tgDropTracks(s) {
  const ids = new Set(s.getTracks().map(t => t.id));
  for (const p of tg.peers.values()) p.pc.getSenders().forEach(x => { if (x.track && ids.has(x.track.id)) { try { p.pc.removeTrack(x); } catch {} } });
}
async function tgMic() {
  if (tg.mic) { tgDropTracks(tg.mic); tg.mic.getTracks().forEach(t => t.stop()); tg.mic = null; tgPaint(); return; }
  try { tg.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { toast('Микрофон недоступен: ' + (e.message || e.name), true); return; }
  tgAddTracks(tg.mic); tgPaint();
}
async function tgScreenToggle() {
  if (tg.screen) { tgStopScreen(); return; }
  try { tg.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }); }
  catch (e) { if (e.name !== 'NotAllowedError') toast('Показ экрана недоступен: ' + (e.message || e.name), true); return; }
  tg.screen.getVideoTracks().forEach(t => { t.onended = tgStopScreen; try { t.contentHint = 'motion'; } catch {} });
  tgAddTracks(tg.screen); tgSend({ k: 'screen', on: true }); tgPaint();
}
function tgStopScreen() {
  if (!tg.screen) return;
  tgDropTracks(tg.screen); tg.screen.getTracks().forEach(t => t.stop()); tg.screen = null;
  tgSend({ k: 'screen', on: false }); tgPaint();
}
function tgShowScreen(p, s) {
  let w = $('#tgScreen');
  if (!w) {
    w = document.createElement('div'); w.id = 'tgScreen'; w.className = 'tg-screen';
    w.innerHTML = '<div class="tg-screen-h"><span></span><button class="iconbtn" data-big title="Во весь экран">⛶</button><button class="iconbtn" data-x title="Скрыть">×</button></div><video autoplay playsinline muted></video>';
    document.body.appendChild(w);
    w.querySelector('[data-x]').onclick = () => tgHideScreen();
    w.querySelector('[data-big]').onclick = () => { const v = w.querySelector('video'); if (v.requestFullscreen) v.requestFullscreen().catch(() => {}); };
  }
  w.dataset.peer = p.id; w.querySelector('span').textContent = 'Экран: ' + p.name;
  const v = w.querySelector('video'); v.srcObject = s; v.play().catch(() => {});
}
function tgHideScreen(peer) { const w = $('#tgScreen'); if (w && (!peer || w.dataset.peer === peer)) { const v = w.querySelector('video'); if (v) v.srcObject = null; w.remove(); } }

/* ── плеер ── */
async function tgCmd(action, val, text) {
  if (action !== 'osd') tg.cmdAt = Date.now();
  try { return await api('/api/together/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, val: val || 0, text: text || '', ms: 4000 }) }); } catch { return null; }
}
function tgOsd(text) { if (tg.mine && tg.mine.active && tg.mine.osd) tgCmd('osd', 0, text); }
async function tgReadPlayer() {
  const t0 = Date.now();
  let st; try { st = await api('/api/together/player'); } catch { st = { active: false }; }
  st.local = (t0 + Date.now()) / 2;
  tg.prev = tg.mine; tg.mine = st; return st;
}
function tgOffset() { return tg.off.length ? tg.off.slice().sort((a, b) => a.rtt - b.rtt)[0].o : 0; }
function tgPong(m) {
  const t3 = Date.now(), rtt = t3 - m.t0; if (!(rtt >= 0 && rtt < 10000)) return;
  tg.off.push({ o: m.t1 - (m.t0 + t3) / 2, rtt }); if (tg.off.length > 6) tg.off.shift();
}
async function tgTick() {
  if (!tg.on || tg.busy) return;
  tg.busy = true;
  try {
    const now = Date.now();
    for (const p of [...tg.peers.values()]) if (now - p.last > 45000) { tgNote(`${p.name} пропал(а) из сети`); tgDropPeer(p); }
    const st = await tgReadPlayer();
    if (!tg.on) return;
    if (tg.host) tgHostTick(st); else tgGuestTick(st);
    tgPaintSync();
  } finally { tg.busy = false; }
}
/* ведущий: рассылает своё состояние раз в 2 с и сразу при изменении */
function tgHostTick(st) {
  if (st.active && !st.error) {
    const t = (state.lib || []).find(x => x.hash === st.hash);
    const media = { h: st.hash, f: st.file, t: t ? (t.title || t.name) : (tg.media && tg.media.h === st.hash ? tg.media.t : '') };
    if (!tg.media || tg.media.h !== media.h || tg.media.f !== media.f) { tg.media = media; tgPaint(); }
  }
  const sig = st.active ? `${st.hash}|${st.file}|${st.paused}|${Math.round((st.rate || 1) * 100)}` : 'off';
  const jumped = tg.prev && tg.prev.active && st.active && !st.paused && Math.abs(st.pos - tg.prev.pos - (st.local - tg.prev.local) / 1000 * (st.rate || 1)) > 2.5;
  tg.pingN = (tg.pingN + 1) % 2;
  if (sig !== tg.lastSt || jumped || tg.pingN === 0) {
    tg.lastSt = sig;
    tgSend({ k: 'st', a: !!st.active, h: st.hash, f: st.file, pos: st.pos || 0, paused: !!st.paused, rate: st.rate || 1, at: st.local, media: tg.media });
  }
  tg.sync = !st.active ? 'Включите фильм в mpv или VLC — гости пойдут следом' : st.error ? 'Плеер не отвечает' : st.paused ? 'Пауза у всех' : 'Вы ведёте показ';
}
function tgHostReq(p, m) {
  const act = m.action;
  if (act === 'pause' || act === 'play') { tgCmd(act); tgOsd(`${p.name}: ${act === 'pause' ? 'пауза' : 'продолжаем'}`); }
  else if (act === 'seek' && m.val >= 0) { tgCmd('seek', m.val); tgOsd(`${p.name}: перемотка`); }
  else return;
  tg.lastSt = ''; setTimeout(tgTick, 400);
}
function tgHostWait(p) {
  if (!tg.mine || !tg.mine.active || tg.mine.paused) return;
  tg.waitFor = p.id; tgCmd('pause'); tgOsd(`Ждём ${p.name} — подгружается…`); tgNote(`Ждём ${p.name} — подгружается`);
  tg.lastSt = ''; setTimeout(tgTick, 300);
  setTimeout(() => { if (tg.waitFor === p.id) { tg.waitFor = ''; tgCountdown(); } }, 15000);
}
function tgCountdown() {
  if (!tg.host || !tg.mine || !tg.mine.active) { toast('Сначала включите фильм в mpv или VLC', true); return; }
  const at = Date.now() + 3600, pos = Math.max(0, (tg.mine.pos || 0) - 1);
  tgSend({ k: 'cd', pos, at }); tgRunCountdown(pos, at);
}
// Отсчёт 3-2-1: пауза и перемотка в одну точку, старт в один момент.
function tgRunCountdown(pos, at) {
  tg.hold = at + 2500;
  tgCmd('pause'); setTimeout(() => tgCmd('seek', pos), 150);
  for (const n of [3, 2, 1]) setTimeout(() => { tgOsd(String(n)); tgNote('Старт через ' + n); }, Math.max(0, at - Date.now() - n * 1000));
  setTimeout(() => { tgCmd('play'); tgOsd('▶ Поехали!'); tgNote('Поехали!'); tg.lastSt = ''; }, Math.max(0, at - Date.now()));
}
/* гость: догоняет ведущего */
function tgFollow(m) {
  tg.st = m; tg.stAt = Date.now();
  if (m.media) tg.media = m.media;
  if (tg.off.length < 3 || Math.random() < 0.15) tgSend({ k: 'ping', to: m.from, t0: Date.now() });
}
function tgGuestTick(mine) {
  const st = tg.st, now = Date.now();
  if (!st || now - tg.stAt > 8000) { tg.sync = tg.peers.size ? 'Жду ведущего…' : 'Ищу участников…'; return; }
  if (!st.a) { tg.sync = 'У ведущего фильм не запущен'; return; }
  if (!mine.active || mine.hash !== st.h || mine.file !== st.f) { tg.sync = 'open'; return; }
  if (mine.error) { tg.sync = 'Плеер не отвечает'; return; }
  if (now < tg.hold || now - tg.cmdAt < 1500) return;
  const expect = st.pos + (st.paused ? 0 : Math.max(0, now + tgOffset() - st.at) / 1000 * (st.rate || 1));
  const prev = tg.prev && tg.prev.active && tg.prev.hash === mine.hash ? tg.prev : null;
  // своё действие гостя — просьба ведущему
  if (prev && prev.paused !== mine.paused && mine.paused !== st.paused) {
    tgSend({ k: 'req', to: st.from, action: mine.paused ? 'pause' : 'play' }); tg.cmdAt = now; tg.sync = 'Попросил ведущего: ' + (mine.paused ? 'пауза' : 'продолжить'); return;
  }
  if (prev && !st.paused && Math.abs(mine.pos - expect) > 5 && Math.abs(prev.pos - expect) < 1.5) {
    tgSend({ k: 'req', to: st.from, action: 'seek', val: mine.pos }); tg.cmdAt = now; tg.sync = 'Попросил ведущего перемотать'; return;
  }
  if (mine.paused !== st.paused) { tgCmd(st.paused ? 'pause' : 'play'); tg.sync = st.paused ? 'Пауза у ведущего' : 'Продолжаем'; return; }
  const diff = mine.pos - expect, base = st.rate || 1;
  if (st.paused) { if (Math.abs(diff) > 0.5) tgCmd('seek', expect); tg.sync = 'Пауза у всех'; return; }
  // буфер: позиция стоит, а у ведущего идёт
  if (prev && mine.pos - prev.pos < 0.15) tg.stall++; else tg.stall = 0;
  if (tg.stall >= 3 && now - tg.waitAt > 30000) {
    tg.waitAt = now; tg.stall = 0;
    tgSend({ k: 'wait', to: st.from }); tg.sync = 'Подгружается — попросил подождать';
    setTimeout(() => tgSend({ k: 'ready', to: st.from }), 7000);
    return;
  }
  if (Math.abs(diff) > 2) { tgCmd('seek', expect + 0.2); if (tg.adj) { tgCmd('rate', base); tg.adj = false; } tg.sync = 'Перемотал к ведущему'; return; }
  if (Math.abs(diff) > 0.4) { tgCmd('rate', base * (diff > 0 ? 0.95 : 1.05)); tg.adj = true; tg.sync = diff > 0 ? 'Чуть притормаживаю' : 'Чуть догоняю'; return; }
  if (tg.adj && Math.abs(diff) < 0.15) { tgCmd('rate', base); tg.adj = false; }
  tg.sync = `В синхроне · ±${Math.abs(diff).toFixed(1).replace('.', ',')} с`;
}
async function tgOpenMedia() {
  const m = tg.media; if (!m || !m.h) return;
  let t = (state.lib || []).find(x => x.hash === m.h);
  if (!t) {
    try { await addTorrentRes(magnetFromHash(m.h, m.t || '')); await loadLibrary(); }
    catch (e) { toast('Не удалось добавить раздачу: ' + e.message, true); return; }
    t = (state.lib || []).find(x => x.hash === m.h) || { hash: m.h, title: m.t, file_stats: [] };
  }
  if (!(t.file_stats || []).length) { toast('Получаю список файлов…'); t = await waitForFiles(t, 30000) || t; }
  const f = (t.file_stats || []).find(x => x.id === m.f);
  if (!f) { toast('Файлы раздачи ещё не получены — попробуйте через минуту', true); return; }
  const pl = pickPlayer();
  if (pl !== 'mpv' && pl !== 'vlc') toast('Для синхронизации нужен mpv или VLC — выберите его в «Плеерах»', true);
  playSelected(t, f, { fromZero: true, onPC: true });
}

/* ── чат ── */
function tgNote(text) { tgChatPush({ sys: true, text }); }
function tgChatPush(m) {
  m.at = Date.now(); tg.chat.push(m); if (tg.chat.length > 200) tg.chat.shift();
  const box = $('#tgChat');
  if (box) { box.insertAdjacentHTML('beforeend', tgMsgHtml(m)); box.scrollTop = box.scrollHeight; }
  else if (!m.sys && !m.mine) { tg.unread++; toast(`${m.name}: ${m.text}`); }
  tgPaintDock();
}
function tgMsgHtml(m) {
  const tm = new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (m.sys) return html`<div class="tg-msg sys">${m.text}</div>`;
  return html`<div class="tg-msg${m.mine ? ' me' : ''}${m.react ? ' react' : ''}"><b>${m.name}</b><span>${m.text}</span><time>${tm}</time></div>`;
}
function tgChatIn(p, text) { if (!text) return; tgChatPush({ name: p.name, text }); tgOsd(`💬 ${p.name}: ${text}`); }
function tgReactIn(p, e) { tgChatPush({ name: p.name, text: e, react: true }); tgOsd(`${e} ${p.name}`); tgBurst(e); }
function tgSay(text) {
  text = String(text || '').trim().slice(0, 500); if (!text || !tg.on) return;
  tgSend({ k: 'chat', text }); tgChatPush({ name: tg.name, text, mine: true });
}
function tgReact(e) { tgSend({ k: 'react', e }); tgChatPush({ name: tg.name, text: e, mine: true, react: true }); tgBurst(e); }
function tgBurst(e) {
  const box = $('#tgRoot'); if (!box) return;
  const s = document.createElement('span'); s.className = 'tg-burst'; s.textContent = e;
  s.style.left = (20 + Math.random() * 60) + '%'; box.appendChild(s); setTimeout(() => s.remove(), 2200);
}

/* ── раздел ── */
function renderTogether(root) {
  root.innerHTML = '<div class="tg" id="tgRoot"></div>';
  tg.unread = 0; tgPaint();
}
function tgPaint() {
  tgPaintDock();
  const root = $('#tgRoot'); if (!root) return;
  if (!root._bound) {
    root._bound = true;
    root.addEventListener('click', tgOnClick);
    root.addEventListener('change', tgOnChange);
    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'tgIn') { tgSay(e.target.value); e.target.value = ''; }
      if (e.target.id === 'tgCodeIn') tgOnClick({ target: $('[data-tg=join]') });
    });
  }
  if (!tg.on) { root.innerHTML = tgLobbyHtml(); return; }
  if (!$('#tgChat')) {
    root.innerHTML = html`<div class="mu-head"><h1 class="page-title">Смотрим вместе</h1><span class="tg-role">${tg.host ? 'вы ведущий' : 'вы гость'}</span></div>
      <div class="tg-grid">
        <div class="tg-side">
          <div class="card tg-card" id="tgStatus"></div>
          <div class="card tg-card"><div class="tg-h">Пригласить</div>
            <div class="tg-code"><code id="tgCode"></code><button class="btn" data-tg="copy">Скопировать</button></div>
            <div class="muted sm">Друг вставляет код в «Вместе → Присоединиться». В коде — ключ шифрования, поэтому отправляйте его лично.</div></div>
        </div>
        <div class="card tg-chatcard">
          <div class="tg-chat" id="tgChat">${raw(tg.chat.map(tgMsgHtml).join(''))}</div>
          <div class="tg-reacts">${raw(TG_REACT.map(e => `<button class="iconbtn" data-tg-react="${e}">${e}</button>`).join(''))}</div>
          <div class="tg-input"><input id="tgIn" maxlength="500" placeholder="Сообщение — увидят в чате и поверх видео в mpv" autocomplete="off"><button class="btn primary" data-tg="send">Отправить</button></div>
        </div>
      </div>`;
    const c = $('#tgChat'); c.scrollTop = c.scrollHeight;
  }
  const code = $('#tgCode'); if (code) code.textContent = tgCode();
  tgPaintStatus();
}
function tgLobbyHtml() {
  const can = tgCanRun(), v = k => localStorage.getItem(k) || '';
  return html`<div class="mu-head"><h1 class="page-title">Смотрим вместе</h1></div>
    <p class="muted tg-lead">Смотрите фильм с другом на разных компьютерах: плееры идут в ногу, есть чат, голос и показ экрана. У каждого свой TorrClient и своя раздача — по сети идут только команды.</p>
    ${can ? '' : raw('<div class="card tg-warn">Браузер разрешает звонки и шифрование только на защищённом адресе. Откройте TorrClient на самом компьютере (адрес <code>localhost</code>) или в приложении.</div>')}
    <label class="tg-name">Ваше имя <input id="tgName" maxlength="40" value="${tgMyName()}"></label>
    <div class="tg-lobby">
      <div class="card tg-card"><div class="tg-h">Создать комнату</div>
        <p class="muted sm">Включите фильм в mpv или VLC — до или после создания комнаты. Гости увидят, что смотреть, и откроют ту же раздачу у себя.</p>
        <button class="btn primary" data-tg="create"${raw(can ? '' : ' disabled')}>Создать комнату</button></div>
      <div class="card tg-card"><div class="tg-h">Присоединиться</div>
        <input id="tgCodeIn" placeholder="Код приглашения TC1.…" autocomplete="off">
        <button class="btn primary" data-tg="join"${raw(can ? '' : ' disabled')}>Присоединиться</button></div>
    </div>
    <details class="tg-adv"><summary>Соединение</summary>
      <p class="muted sm">Участники находят друг друга через публичные MQTT-брокеры (EMQX, HiveMQ, Mosquitto); сообщения зашифрованы. Можно указать свой брокер (WebSocket, wss://…/mqtt) — его адрес попадёт в приглашение. Если напрямую соединиться не выходит (строгий NAT), поможет свой TURN-сервер.</p>
      <label>Свой MQTT-брокер <input data-tg-set="tc_tg_broker" value="${v('tc_tg_broker')}" placeholder="wss://broker.example.com:8084/mqtt"></label>
      <label>TURN <input data-tg-set="tc_tg_turn" value="${v('tc_tg_turn')}" placeholder="turn:turn.example.com:3478"></label>
      <label>TURN логин <input data-tg-set="tc_tg_turnu" value="${v('tc_tg_turnu')}"></label>
      <label>TURN пароль <input type="password" data-tg-set="tc_tg_turnp" value="${v('tc_tg_turnp')}"></label>
    </details>`;
}
function tgPaintStatus() {
  const box = $('#tgStatus'); if (!box) return;
  const brokers = tg.mq.filter(c => c.ok).length, peers = [...tg.peers.values()], m = tg.media;
  box.innerHTML = html`<div class="tg-h">Комната</div>
    <div class="tg-people">
      <div class="tg-person me"><i>${tg.name.slice(0, 1).toUpperCase()}</i><span>${tg.name}<small>вы${tg.host ? ' · ведущий' : ''}${tg.mic ? ' · 🎤' : ''}${tg.screen ? ' · 🖥' : ''}</small></span></div>
      ${peers.map(p => raw(html`<div class="tg-person"><i>${p.name.slice(0, 1).toUpperCase()}</i><span>${p.name}<small>${p.host ? 'ведущий · ' : ''}${tgLink(p)}</small></span></div>`))}
      ${peers.length ? '' : raw('<div class="muted sm">Пока никого. Отправьте код приглашения.</div>')}
    </div>
    <div class="tg-media">${m && m.h ? raw(html`🎬 <b>${m.t || 'Фильм'}</b>`) : raw('<span class="muted">Фильм не выбран</span>')}</div>
    <div class="tg-sync" id="tgSync"></div>
    <div class="tg-acts">
      <button class="btn${tg.mic ? ' on' : ''}" data-tg="mic">${tg.mic ? '🎤 Выключить микрофон' : '🎤 Микрофон'}</button>
      <button class="btn${tg.screen ? ' on' : ''}" data-tg="screen">${tg.screen ? '🖥 Остановить показ' : '🖥 Показать экран'}</button>
      ${tg.host ? raw('<button class="btn" data-tg="cd" title="Пауза у всех, перемотка в одну точку и старт после 3-2-1">⏱ Старт с отсчётом</button>') : ''}
      <button class="btn danger" data-tg="leave">Выйти</button>
    </div>
    <div class="muted sm">${brokers ? `Брокеров на связи: ${brokers} из ${tg.mq.length}` : 'Брокеры недоступны — переподключаюсь…'}</div>`;
  tgPaintSync();
}
function tgPaintSync() {
  const el = $('#tgSync'); if (!el) return;
  if (tg.sync === 'open') { if (!el.querySelector('[data-tg=open]')) el.innerHTML = '<span>У вас открыт другой фильм или плеер закрыт.</span> <button class="btn primary sm" data-tg="open">▶ Открыть у себя</button>'; }
  else el.textContent = tg.sync || '';
}
function tgPaintDock() {
  let d = $('#tgDock');
  if (!tg.on || state.view === 'together') { if (d) d.remove(); return; }
  if (!d) { d = document.createElement('button'); d.id = 'tgDock'; d.className = 'tg-dock'; d.onclick = () => setView('together'); document.body.appendChild(d); }
  d.innerHTML = html`👥 Вместе · ${tg.peers.size + 1}${tg.unread ? raw(`<b>${tg.unread}</b>`) : ''}`;
}
async function tgOnClick(e) {
  const t = e.target && e.target.closest ? e.target : null; if (!t) return;
  const r = t.closest('[data-tg-react]'); if (r) { tgReact(r.dataset.tgReact); return; }
  const b = t.closest('[data-tg]'); if (!b) return;
  const a = b.dataset.tg;
  if (a === 'create') { tgSaveName(); await tgCreate(); }
  else if (a === 'join') {
    tgSaveName();
    const o = tgParse(($('#tgCodeIn') || {}).value);
    if (!o) { toast('Это не код приглашения — он начинается с TC1.', true); return; }
    await tgStart(o, false);
  }
  else if (a === 'copy') { const c = tgCode(); try { await navigator.clipboard.writeText(c); toast('Код скопирован'); } catch { prompt('Скопируйте код:', c); } }
  else if (a === 'send') { const i = $('#tgIn'); tgSay(i.value); i.value = ''; i.focus(); }
  else if (a === 'mic') tgMic();
  else if (a === 'screen') tgScreenToggle();
  else if (a === 'cd') tgCountdown();
  else if (a === 'leave') tgLeave();
  else if (a === 'open') tgOpenMedia();
}
function tgOnChange(e) { const k = e.target.dataset && e.target.dataset.tgSet; if (k) savePref(k, e.target.value.trim()); if (e.target.id === 'tgName') tgSaveName(); }
function tgSaveName() { const i = $('#tgName'); if (i && i.value.trim()) savePref('tc_tg_name', i.value.trim().slice(0, 40)); }
// После перезагрузки страницы — обратно в ту же комнату.
function tgBoot() {
  let s; try { s = JSON.parse(sessionStorage.getItem('tc_tg') || 'null'); } catch {}
  if (s && s.o && !tg.on) tgStart(s.o, !!s.host);
}
window.addEventListener('beforeunload', () => { if (tg.on) try { tgSend({ k: 'bye' }); } catch {} });
setTimeout(tgBoot, 1200);/* ================= PLAYERS PAGE ================= */
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
      // «Сохранено» показывается только по успешному ответу: прежде надпись
      // появлялась и при 500, и человек уходил с мыслью, что путь записан.
      try {
        const r = await fetch('/api/player/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.players) });
        if (!r.ok) { toast('Не сохранилось: HTTP ' + r.status, true); return; }
        toast('Сохранено');
        route();
      } catch (e) { toast('Не сохранилось: ' + e.message, true); }
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
      <button data-act="dlrefresh" class="iconbtn" title="Обновить">${raw(ico('refresh'))}</button></div>
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

/* ================= ПОДПИСКИ НА СЕРИАЛЫ =================
   Демон сам спрашивает трекер о новых сериях и присылает событие subs: своей
   проверки у интерфейса нет. Здесь только список подписок, число непрочитанных
   находок и кнопки «завести», «проверить», «прочитано», «снять».

   Первая проверка новой подписки ничего не объявляет — она запоминает, что уже
   вышло. Иначе свежая подписка принесла бы разом все серии сериала как новые. */

/* subsKey приводит название к виду сравнения — так же, как это делает демон:
   без регистра, без знаков и с «ё», приведённой к «е». Нужен, чтобы повторная
   подписка на тот же сериал не заводилась второй раз молча. */
function subsKey(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}
function subsKnown(title) {
  const key = subsKey(title);
  return (state.subs || []).some(s => subsKey(s.title) === key || subsKey(s.query) === key);
}
async function loadSubs() {
  try {
    const j = await api('/api/subs');
    state.subs = Array.isArray(j.subs) ? j.subs.filter(s => s && s.id) : [];
  } catch { state.subs = []; }
  paintSubsBadge();
  return state.subs;
}
function subsNewTotal() { return (state.subs || []).reduce((n, s) => n + (Number(s.new_count) || 0), 0); }
/* paintSubsBadge — число непрочитанных находок на самой вкладке: без него о
   новой серии узнают, только заглянув в раздел. */
function paintSubsBadge() {
  setNavBadge('subs', subsNewTotal());
}
async function subsAction(action, body) {
  return api('/api/subs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action }, body || {})) });
}
async function subsAdd(title, query) {
  const t = String(title || '').trim();
  if (!t) { toast('Нечего отслеживать: пустое название', true); return; }
  const was = subsKnown(t);
  // Разрешение на уведомления спрашивается по нажатию — иначе браузер откажет.
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) { /* нет уведомлений */ }
  try {
    await subsAction('add', { title: t, query: query || '' });
    await loadSubs();
    toast(was ? 'Уже отслеживается: ' + t : 'Следим за «' + t + '»');
    if (state.view === 'subs') route();
  } catch (e) { toast('Не удалось подписаться: ' + e.message, true); }
}
async function subsRemove(id) {
  try {
    // Снятую руками подписку автослежение больше не заводит.
    const gone = (state.subs || []).find(s => s.id === id);
    if (gone) autoFollowSkip(gone.title);
    await subsAction('remove', { id });
    state.subs = (state.subs || []).filter(s => s.id !== id);
    paintSubsBadge();
    if (state.view === 'subs') route();
    toast('Подписка снята');
  } catch (e) { toast('Не удалось снять подписку: ' + e.message, true); }
}
async function subsSeen(id) {
  try { await subsAction('seen', { id }); await loadSubs(); if (state.view === 'subs') paintSubsBody(); }
  catch (e) { toast('Не удалось сбросить новизну: ' + e.message, true); }
}
async function subsCheck() {
  try {
    await subsAction('check');
    // Проверка идёт на демоне и отвечает сразу, а список обновится позже: ответ
    // ручки означает «принято», а не «проверено». Поэтому список перечитывается
    // ещё раз через несколько секунд, и о находках сообщает событие subs.
    toast('Проверяю трекер — о новых сериях сообщу');
    setTimeout(loadSubs, 4000);
    setTimeout(loadSubs, 15000);
  } catch (e) { toast('Проверка не запустилась: ' + e.message, true); }
}

function fmtWhen(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/* subsAirLine — расписание по TMDB: что уже вышло в эфир и когда следующая. */
function subsAirLine(s) {
  const se = (a, b) => 'S' + String(a).padStart(2, '0') + (b ? 'E' + String(b).padStart(2, '0') : '');
  const day = v => { const d = new Date(v); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); };
  const parts = [];
  if (s.air_season) parts.push('в эфире вышла ' + se(s.air_season, s.air_episode) + (s.air_date ? ' (' + day(s.air_date) + ')' : ''));
  if (s.next_air) parts.push('следующая ' + se(s.next_season, s.next_episode) + ' — ' + day(s.next_air));
  else if (s.ended) parts.push('сериал завершён');
  return parts.length ? html`<div class="page-sub" style="margin:0">По TMDB: ${parts.join(' · ')}</div>` : '';
}
function subsCard(s) {
  const known = s.season ? 'известно: сезон ' + s.season + (s.episode ? ', серия ' + s.episode : '') : 'ещё не проверялась';
  const check = fmtWhen(s.checked);
  return html`<div class="card sub-card" data-sub="${s.id}">
    <div class="row wrap">
      <h3 style="flex:1;margin:0">${s.title}</h3>
      ${raw(s.new_count ? html`<span class="chip hasnew">${s.new_count} ${plural(s.new_count, 'новая серия', 'новые серии', 'новых серий')}</span>` : '')}
      <button data-sub-check>Проверить</button>
      ${raw(s.new_count ? html`<button data-sub-seen>Прочитано</button>` : '')}
      <button data-sub-del class="danger">Снять</button>
    </div>
    <div class="page-sub" style="margin:6px 0 0">Ищу на трекерах: ${s.query || s.title} · ${known}${check ? ' · проверено ' + check : ''}</div>
    ${raw(s.last_seen ? html`<div class="page-sub" style="margin:0">Последняя находка: ${s.last_seen}</div>` : '')}
    ${raw(subsAirLine(s))}
  </div>`;
}
function renderSubs(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Подписки на сериалы</h1>
      <div class="page-sub">Раз в полчаса приложение ищет новые серии на rutor и в подключённых индексаторах (источники — в Настройках) — сериалы, аниме и мультсериалы. С ключом TMDB оно знает и дату выхода следующей серии. О находке сообщит уведомлением.</div></div>
      <input class="search-input" id="subNew" placeholder="Название сериала или запрос для трекера...">
      <button id="subAdd" class="primary">${raw(ico('plus',16))} Следить</button>
      <button id="subCheck" class="iconbtn" title="Проверить трекер сейчас">${raw(ico('refresh'))}</button>
      <label class="check" title="Каждый сериал, аниме и многосерийный мультфильм из Библиотеки получает подписку сам. Снятая руками подписка сама не вернётся"><input type="checkbox" id="subAuto"> следить за сериалами из Библиотеки</label>
    </div>
    <div id="subBody"><div class="empty">Загрузка подписок...</div></div>`;
  const add = () => { const inp = $('#subNew'); subsAdd(inp.value).then(() => { inp.value = ''; }); };
  $('#subAdd').addEventListener('click', add);
  $('#subNew').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  $('#subCheck').addEventListener('click', subsCheck);
  { const a = $('#subAuto'); a.checked = autoFollowOn(); a.addEventListener('change', () => { savePref(AF_KEY, a.checked ? '1' : '0'); if (a.checked) autoFollowSeries(true); }); }
  paintSubsBody();
  // Список спрашивается у демона, а не берётся из памяти: подписки живут с ним
  // и меняются в том числе пока страница была закрыта.
  loadSubs().then(paintSubsBody).catch(() => {});
}
function paintSubsBody() {
  const body = $('#subBody'); if (!body) return;
  const list = state.subs || [];
  if (!list.length) {
    body.innerHTML = html`<div class="empty">Подписок нет. Заведите её здесь или в карточке сериала: демон сам проверит трекер и сообщит о новой серии.</div>`;
    return;
  }
  body.innerHTML = html`<div class="page-sub">Подписок: ${list.length}${subsNewTotal() ? ' · новых серий: ' + subsNewTotal() : ''}</div>` + list.map(subsCard).join('');
  $$('[data-sub]', body).forEach(card => {
    const id = card.dataset.sub;
    const b = (sel, fn) => { const el = card.querySelector(sel); if (el) el.addEventListener('click', fn); };
    b('[data-sub-check]', subsCheck);
    b('[data-sub-seen]', () => subsSeen(id));
    b('[data-sub-del]', () => subsRemove(id));
  });
}
/* subsArrived — демон нашёл новые серии. Счётчик подписки растёт сразу, чтобы
   вкладка показала это без перезагрузки, а полный список перечитывается только
   тогда, когда открыт раздел подписок. */
function subsArrived(d) {
  if (!d || !d.id) return;
  const s = (state.subs || []).find(x => x.id === d.id);
  if (!s) { loadSubs(); return; }
  s.new_count = (Number(s.new_count) || 0) + (Number(d.count) || 0);
  if (d.season) s.season = d.season;
  if (d.episode) s.episode = d.episode;
  if (d.items && d.items[0]) s.last_seen = d.items[0].title;
  paintSubsBadge();
  const where = d.season ? ' — сезон ' + d.season + (d.episode ? ', серия ' + d.episode : '') : '';
  const msg = d.aired
    ? 'Вышла серия: ' + (d.title || '') + where + '. Раздачи пока нет — сообщу, когда появится'
    : 'Новые серии: ' + (d.title || '') + where;
  toast(msg);
  notifPush({ kind: 'ep', title: d.title || s.title || '', text: msg, sub: d.id });
  // Системное уведомление — когда окно свёрнуто, тост не увидеть.
  try {
    if ((document.hidden || !document.hasFocus()) && 'Notification' in window && Notification.permission === 'granted') new Notification('TorrClient', { body: msg });
  } catch (_) { /* уведомления недоступны */ }
  if (state.view === 'subs') paintSubsBody();
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
  loadLibrary().catch(() => {}).then(() => { paintSeriesBody(); autoFollowSeries(); });
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
/* subsName — название для подписки: без «/ English», скобок, сезона, серий и
   качества. Целое название раздачи трекер не находил — подписки на аниме и
   мультсериалы молчали всегда. */
function subsName(raw) {
  let s = String(raw || '').trim();
  if (!/\s/.test(s) && (s.match(/\./g) || []).length >= 2) s = s.replace(/[._]/g, ' ');
  for (const sep of [' / ', ' | ', '[', '(', '{']) { const i = s.indexOf(sep); if (i > 0) s = s.slice(0, i); }
  s = s.replace(/(?:^|[\s._-])s\d{1,2}(?:[\s._-]*e\d{1,4})?(?:[\s._-]|$).*$/i, '')
    .replace(/(?:\d{1,2}\s*[-–—]\s*)?\d{1,2}\s*сезон.*$|сезон\s*\d.*$|season\s*\d.*$/i, '')
    .replace(/\d{1,4}\s*(?:[-–—]\s*\d{1,4}\s*)?(?:сери|эпизод|из\s).*$/i, '')
    .replace(/(?:^|\s)(?:2160p|1080p|720p|480p|4k|web-?dl|webrip|hdtv|bdrip|hdrip)\b.*$/i, '')
    .replace(/^[\s.,:;_\-–—]+|[\s.,:;_\-–—]+$/g, '');
  return s.length >= 2 ? s : (cleanSeriesName(raw) || String(raw || '').trim());
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
  // Слежение за сериалом заводится по названию без сезона и раздачи: новая
  // серия выходит отдельной раздачей, и подписка на конкретную её не найдёт.
  $$('[data-subseries]', body).forEach(b => b.addEventListener('click', e => { e.stopPropagation(); subsAdd(b.dataset.subseries); }));
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
      return { fid: v.id, s: (pe && pe.s) || s, e: (pe && pe.e) || 0, name: epFileName(v.path) };
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
      ${raw(head.poster ? html`<img src="${head.poster}" loading="lazy" onerror="var p=this.parentElement;this.remove();p.querySelector('svg').classList.remove('hidden')">` : '')}
      <span class="chip rating" data-tmdb hidden></span>
    </div>
    <div class="ser-main">
    <div class="row wrap"><h3 style="flex:1;margin:0">${cleanSeriesName(head.title)}</h3>
      <span class="chip">${g.items.length} ${plural(g.items.length, 'торрент', 'торрента', 'торрентов')}</span>
      ${raw(all ? html`<span class="chip">${seen} из ${all} ${plural(all, 'серии', 'серий', 'серий')}</span>` : '')}
      <button data-watch="${head.hash}">▶ Смотреть</button>
      <button data-subseries="${subsName(head.title)}" title="Демон сам сообщит о новых сериях">Следить</button></div>
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
          return html`<button data-series="${it.t.hash}|${sn}|${ep.e}|${ep.fid}" data-ep-num="${ep.e || 0}" data-sn="${sn}" class="${cls}" title="${title}">${lab}<span class="epname">${ep.name ? ' · ' + ep.name : ''}</span>${raw(tc > 0 ? html` <span class="epstate">${fmtPos(tc)}</span>` : '')}</button>`;
        }).join('')).join(''))}</span></div>`;
    }).join('') + `</div></div></div>`;
}
/* ================= УВЕДОМЛЕНИЯ, «СЕЙЧАС ИГРАЕТ», АВТОСЛЕЖЕНИЕ =================
   Находка демона (новая серия) раньше показывалась тостом на четыре секунды
   и пропадала: не заметил — не узнал. Теперь у неё есть место — колокольчик в
   шапке со счётчиком и списком, который переживает перезапуск. Рядом —
   «Сейчас играет»: что открыто во внешнем плеере (демон сообщает событием
   nowplaying) и какой трек играет в разделе «Музыка». */

const NOTIF_KEY = 'tc_notifs';
function notifList() { try { const a = JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveNotifs(l) { try { localStorage.setItem(NOTIF_KEY, JSON.stringify(l.slice(0, 50))); } catch {} }
function notifPush(n) {
  const l = notifList();
  // Повтор той же находки (демон перепроверил подписку) не плодит строки.
  const dup = l.findIndex(x => x.text === n.text && Date.now() - (x.at || 0) < 6 * 3600e3);
  if (dup >= 0) l.splice(dup, 1);
  l.unshift(Object.assign({ at: Date.now(), read: false }, n));
  saveNotifs(l);
  paintNotifBtn();
  const bell = $('#notifBtn'); if (bell) { bell.classList.remove('ring'); void bell.offsetWidth; bell.classList.add('ring'); }
}
function notifUnread() { return notifList().filter(x => !x.read).length; }
function paintNotifBtn() {
  const b = $('#notifBtn'); if (!b) return;
  const n = notifUnread();
  b.innerHTML = ico('bell', 18) + (n ? '<span class="tb-badge">' + (n > 9 ? '9+' : n) + '</span>' : '');
  b.title = n ? 'Уведомления: новых ' + n : 'Уведомления';
}
function openNotifs() {
  closeNotifs();
  const l = notifList();
  const pop = document.createElement('div');
  pop.className = 'notif-pop'; pop.id = 'notifPop';
  pop.innerHTML = html`<div class="notif-h"><b>Уведомления</b><span class="spacer"></span>
      ${raw(l.length ? '<button class="link-btn" data-nf-clear>очистить</button>' : '')}
      <button class="link-btn" data-nf-subs>подписки</button></div>
    ${raw(l.length ? l.map((x, i) => html`<button class="notif-it${x.read ? '' : ' new'}" data-nf="${i}">
        <span class="notif-ico">${raw(ico(x.kind === 'ep' ? 'tv' : 'info', 16))}</span>
        <span class="notif-tx"><span>${x.text}</span><small>${new Date(x.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></span></button>`).join('')
      : '<div class="notif-empty">Пока пусто. О новых сериях сериалов из Библиотеки сообщу здесь.</div>')}`;
  document.body.appendChild(pop);
  const r = $('#notifBtn').getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  pop.addEventListener('click', e => {
    const it = e.target.closest('[data-nf]');
    if (it) {
      const x = l[+it.dataset.nf]; closeNotifs();
      if (x && x.kind === 'ep') openMovie({ title: subsName(x.title || ''), kind: 'tv' });
      return;
    }
    if (e.target.closest('[data-nf-clear]')) { saveNotifs([]); closeNotifs(); paintNotifBtn(); return; }
    if (e.target.closest('[data-nf-subs]')) { closeNotifs(); setView('subs'); }
  });
  // Открыл список — значит увидел.
  saveNotifs(l.map(x => Object.assign({}, x, { read: true })));
  setTimeout(paintNotifBtn, 0);
  setTimeout(() => document.addEventListener('click', notifOutside, true), 0);
}
function notifOutside(e) { if (!e.target.closest('#notifPop, #notifBtn')) closeNotifs(); }
function closeNotifs() { const p = $('#notifPop'); if (p) p.remove(); document.removeEventListener('click', notifOutside, true); }

/* Разрешение на системные уведомления браузер даёт только по жесту
   пользователя: спрашиваем один раз, при первом клике по окну. */
document.addEventListener('click', function askNotif() {
  document.removeEventListener('click', askNotif, true);
  try { if ('Notification' in window && Notification.permission === 'default' && localStorage.getItem('tc_notif_asked') !== '1') { localStorage.setItem('tc_notif_asked', '1'); Notification.requestPermission(); } } catch (_) { /* нет уведомлений */ }
}, true);

/* ---- автослежение за сериалами ----
   Подписку раньше заводили руками кнопкой «Следить», и о новых сериях не
   узнавали, потому что подписок просто не было. Теперь каждый сериал из
   Библиотеки (по названию раздачи или по номерам серий в именах файлов —
   так у аниме и мультсериалов) получает подписку сам. Снятая руками подписка
   запоминается и сама больше не возвращается. */
const AF_KEY = 'tc_autofollow';
const AF_SKIP = 'tc_af_skip';
function autoFollowOn() { return localStorage.getItem(AF_KEY) !== '0'; }
function autoFollowSkip(title) {
  let l = []; try { l = JSON.parse(localStorage.getItem(AF_SKIP) || '[]'); } catch {}
  const k = subsKey(subsName(title || ''));
  if (k && !l.includes(k)) { l.push(k); try { localStorage.setItem(AF_SKIP, JSON.stringify(l.slice(-300))); } catch {} }
}
let afBusy = false;
async function autoFollowSeries(loud) {
  if (!autoFollowOn() || afBusy || !Array.isArray(state.lib) || !state.lib.length) return;
  afBusy = true;
  try {
    if (!Array.isArray(state.subs)) await loadSubs();
    let skip = []; try { skip = JSON.parse(localStorage.getItem(AF_SKIP) || '[]'); } catch {}
    const names = new Map();
    state.lib.forEach(t => {
      const title = t.title || t.name || '';
      const stat = (statCache[t.hash] && statCache[t.hash].data) || t;
      const eps = (stat.file_stats || []).filter(f => isVideo(f.path) && (parseSeriesEp(basename(f.path)) || {}).e).length;
      if (!isSeries(title) && eps < 3) return;
      const n = subsName(title);
      const k = subsKey(n);
      if (n && n.length >= 2 && k && !skip.includes(k)) names.set(k, n);
    });
    const add = [...names.values()].filter(n => !subsKnown(n)).slice(0, 25);
    let ok = 0;
    for (const n of add) { try { await subsAction('add', { title: n, query: '' }); ok++; } catch { /* следующий */ } }
    if (ok) { await loadSubs(); paintSubsBadge(); toast('Слежу за новыми сериями: ' + ok + ' ' + plural(ok, 'сериал', 'сериала', 'сериалов')); if (state.view === 'subs') paintSubsBody(); }
    else if (loud) toast('Все сериалы из Библиотеки уже отслеживаются');
  } finally { afBusy = false; }
}

/* ---- сейчас играет ---- */
state.now = [];
async function loadNowPlaying() {
  try { const j = await api('/api/nowplaying'); state.now = Array.isArray(j.items) ? j.items : []; } catch { state.now = []; }
  paintNowPlaying();
}
function paintNowPlaying() {
  const b = $('#nowBtn'); if (!b) return;
  let label = '', sub = '', kind = '';
  const au = auNowInfo();
  if (au) {
    kind = 'music';
    label = au.label;
    sub = au.sub;
  } else if (state.now && state.now.length) {
    const it = state.now[0];
    const t = (state.lib || []).find(x => x.hash === it.hash);
    kind = 'video';
    label = t ? (t.title || t.name) : 'Видео';
    const f = t && (((statCache[t.hash] && statCache[t.hash].data) || t).file_stats || []).find(x => x.id === it.file_index);
    sub = (f && isSeries(t.title || t.name || '') ? epLabel(f, t) + ' · ' : '') + (it.player || 'плеер');
  }
  b.classList.toggle('hidden', !kind);
  b.dataset.kind = kind;
  if (!kind) { b.innerHTML = ''; return; }
  b.innerHTML = html`<span class="np-eq${kind === 'music' && au && au.paused ? ' paused' : ''}"><i></i><i></i><i></i></span><span class="np-tx"><b>${label}</b><small>Сейчас играет · ${sub}</small></span>`;
  b.title = 'Сейчас играет: ' + label;
}
function onNowClick() {
  const b = $('#nowBtn'); if (!b) return;
  if (b.dataset.kind === 'music') { if (state.view === 'music') musicToggle(); else setView('music'); return; }
  const it = state.now && state.now[0];
  const t = it && (state.lib || []).find(x => x.hash === it.hash);
  if (t) openMovie(Object.assign(fromRelease(t), { poster: t.poster || '' }));
}

/* extrasBoot — вызывается после запуска ленты событий. */
function extrasBoot() {
  paintNotifBtn();
  const nb = $('#notifBtn'); if (nb) nb.addEventListener('click', e => { e.stopPropagation(); if ($('#notifPop')) closeNotifs(); else openNotifs(); });
  const np = $('#nowBtn'); if (np) np.addEventListener('click', onNowClick);
  loadNowPlaying();
  if (eventsSrc) eventsSrc.addEventListener('nowplaying', e => {
    try { const d = JSON.parse(e.data); state.now = Array.isArray(d.items) ? d.items : []; } catch { return; }
    paintNowPlaying();
  });
  else setInterval(loadNowPlaying, 10000);
  // Автослежение — когда библиотека уже прочитана (её грузит первая страница).
  setTimeout(() => { if (Array.isArray(state.lib) && state.lib.length) autoFollowSeries(); else loadLibrary().then(() => autoFollowSeries()).catch(() => {}); }, 20000);
  fxBoot();
}
/* ================= ЭФФЕКТЫ: ФОН ТЕМЫ И АНИМАЦИЯ ЗАПУСКА =================
   Фон рисуется одним <canvas> под содержимым, у каждой темы свой:
   «Графит» — звёздное небо со звездопадом, «Денди» — пиксельные звёзды,
   «Матрица» — зелёный дождь символов, «Кибер-неон» — сетка до горизонта,
   «Японский сад» — лепестки сакуры, «Девятый вал» — небо мазками Ван Гога
   над морем Айвазовского.
   Анимация запуска — отдельно: у темы есть своя, но в Настройках можно
   поставить любую или случайную. Она играет за окном ожидания, пока раздача
   ищет раздающих, и коротким разгоном при запуске плеера.
   Расход: фон — 20–30 кадров в секунду, на кадр уходит доли миллисекунды
   (fx.cost — скользящее среднее). Свёрнутое окно не рисуется вовсе, а при
   «уменьшить движение» в системе и по галочке в Настройках фон выключается. */

const FX_KEY = 'tc_fx';
const FXL_KEY = 'tc_fxl';
function fxOn() {
  if (localStorage.getItem(FX_KEY) === '0') return false;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch {}
  return true;
}
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const RETRO_PAL = ['#fcfcfc', '#3cbcfc', '#f8b800', '#f83800', '#58d854', '#fc74b4'];
const MATRIX_CH = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789';

/* ---------- фоны ---------- */
const BG = {};
// Звёздное небо. Падающая звезда появляется в случайный момент (между
// звёздами — случайная пауза, в среднем 7 с), в случайном месте и летит в
// случайную сторону вниз; иногда — две-три подряд.
BG.sky = {
  fps: 30,
  seed(s) {
    s.stars = Array.from({ length: Math.round(Math.min(220, s.w * s.h / 9000)) }, () => ({ x: Math.random() * s.w, y: Math.random() * s.h, z: Math.random(), tw: Math.random() * 6.28 }));
    s.shoot = []; s.next = rnd(1.5, 8);
  },
  draw(s, c, dt, t) {
    c.clearRect(0, 0, s.w, s.h);
    for (const p of s.stars) {
      p.tw += dt * (0.6 + p.z * 1.8);
      c.fillStyle = 'rgba(200,220,255,' + (0.18 + 0.5 * p.z * (0.6 + 0.4 * Math.sin(p.tw))).toFixed(3) + ')';
      c.beginPath(); c.arc(p.x, p.y, 0.4 + p.z * 1.1, 0, 6.283); c.fill();
    }
    if ((s.next -= dt) <= 0) {
      const n = Math.random() < 0.15 ? 2 + (Math.random() < 0.4 ? 1 : 0) : 1;
      for (let i = 0; i < n; i++) {
        const ang = rnd(0.08, 0.92) * Math.PI; // любая сторона вниз
        const sp = rnd(320, 900);
        s.shoot.push({ x: rnd(0, s.w), y: rnd(-20, s.h * 0.75), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, len: rnd(0.08, 0.22), w: rnd(0.8, 2.2), a: rnd(0.5, 1), life: -i * rnd(0.15, 0.5), max: rnd(0.45, 1.4) });
      }
      // Экспоненциальная пауза: моменты непредсказуемы, но в среднем ~7 с.
      s.next = Math.min(25, Math.max(0.8, -Math.log(1 - Math.random()) * 7));
    }
    s.shoot = s.shoot.filter(p => (p.life += dt) < p.max);
    for (const p of s.shoot) {
      if (p.life < 0) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const k = Math.min(1, p.life / 0.12) * (1 - p.life / p.max);
      const tx = p.x - p.vx * p.len, ty = p.y - p.vy * p.len;
      const g = c.createLinearGradient(p.x, p.y, tx, ty);
      g.addColorStop(0, 'rgba(255,255,255,' + (p.a * k).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(124,176,255,0)');
      c.strokeStyle = g; c.lineWidth = p.w; c.lineCap = 'round';
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(tx, ty); c.stroke();
    }
  },
};
BG.pixel = {
  fps: 30,
  seed(s) { s.stars = Array.from({ length: Math.round(Math.min(200, s.w * s.h / 9000)) }, () => ({ x: Math.random() * s.w, y: Math.random() * s.h, z: Math.random(), tw: Math.random() * 6 })); },
  draw(s, c, dt) {
    c.clearRect(0, 0, s.w, s.h);
    for (const p of s.stars) {
      p.y += dt * (12 + p.z * 70);
      if (p.y > s.h) { p.y = -4; p.x = Math.random() * s.w; }
      const sz = p.z > 0.85 ? 3 : p.z > 0.5 ? 2 : 1;
      p.tw += dt * 3;
      c.globalAlpha = p.z > 0.85 && Math.sin(p.tw) < -0.6 ? 0.25 : 0.35 + p.z * 0.5;
      c.fillStyle = RETRO_PAL[Math.floor(p.z * 97) % RETRO_PAL.length];
      c.fillRect(Math.round(p.x), Math.round(p.y), sz, sz);
    }
    c.globalAlpha = 1;
  },
};
// Дождь символов. След не перерисовывается: старые символы гаснут сами
// (destination-out), а на кадр рисуется только голова каждой колонки.
BG.rain = {
  fps: 20,
  seed(s) { const n = Math.ceil(s.w / 18); s.cols = Array.from({ length: n }, () => ({ y: rnd(-s.h, s.h), v: rnd(40, 140), on: Math.random() < 0.55 })); },
  draw(s, c, dt) {
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,.09)'; c.fillRect(0, 0, s.w, s.h);
    c.globalCompositeOperation = 'source-over';
    c.font = '15px "MS Gothic","Lucida Console",monospace';
    s.cols.forEach((col, i) => {
      if (!col.on) { if (Math.random() < dt * 0.05) col.on = true; return; }
      const prev = col.y; col.y += col.v * dt;
      if (Math.floor(prev / 18) !== Math.floor(col.y / 18)) {
        c.fillStyle = 'rgba(57,255,122,.32)'; c.fillText(pick(MATRIX_CH), i * 18, prev);
        c.fillStyle = 'rgba(210,255,225,.55)'; c.fillText(pick(MATRIX_CH), i * 18, col.y);
      }
      if (col.y > s.h + 40) { col.y = rnd(-200, 0); col.v = rnd(40, 140); col.on = Math.random() < 0.6; }
    });
  },
};
// Синтвейв: солнце в полосах и сетка, бегущая к зрителю.
function drawNeonScene(s, c, t, speed, alpha) {
  const hz = s.h * 0.64, cx = s.w / 2;
  const sun = c.createLinearGradient(0, hz - s.h * 0.34, 0, hz);
  sun.addColorStop(0, 'rgba(255,214,63,' + alpha + ')'); sun.addColorStop(1, 'rgba(255,43,214,' + alpha + ')');
  c.save(); c.beginPath(); c.arc(cx, hz, s.h * 0.2, Math.PI, 0); c.closePath(); c.clip();
  c.fillStyle = sun; c.fillRect(cx - s.h * 0.2, hz - s.h * 0.2, s.h * 0.4, s.h * 0.2);
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 6; i++) { const y = hz - s.h * 0.012 - i * s.h * 0.028; c.fillRect(0, y, s.w, 2 + i * 0.9); }
  c.restore();
  c.strokeStyle = 'rgba(255,43,214,' + (alpha * 0.9) + ')'; c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(0, hz); c.lineTo(s.w, hz); c.stroke();
  c.strokeStyle = 'rgba(0,240,255,' + (alpha * 0.7) + ')';
  for (let i = -14; i <= 14; i++) { c.beginPath(); c.moveTo(cx + i * 22, hz); c.lineTo(cx + i * s.w * 0.16, s.h); c.stroke(); }
  const off = (t * speed) % 1;
  for (let k = 0; k < 14; k++) { const z = (k + off) / 14; const y = hz + (s.h - hz) * z * z; c.globalAlpha = Math.min(1, z * 2); c.beginPath(); c.moveTo(0, y); c.lineTo(s.w, y); c.stroke(); }
  c.globalAlpha = 1;
}
BG.grid = {
  fps: 30,
  seed(s) { s.stars = Array.from({ length: 70 }, () => ({ x: Math.random() * s.w, y: Math.random() * s.h * 0.6, z: Math.random() })); },
  draw(s, c, dt, t) {
    c.clearRect(0, 0, s.w, s.h);
    for (const p of s.stars) { c.fillStyle = 'rgba(255,200,255,' + (0.15 + p.z * 0.4 * (0.6 + 0.4 * Math.sin(t * 2 + p.x))).toFixed(3) + ')'; c.fillRect(p.x, p.y, 1.4, 1.4); }
    drawNeonScene(s, c, t, 0.35, 0.22);
  },
};
// Лепестки сакуры: падают, кружатся и покачиваются на ветру.
function petal(c, x, y, r, rot, a) {
  c.save(); c.translate(x, y); c.rotate(rot); c.globalAlpha = a;
  c.beginPath(); c.moveTo(0, -r); c.quadraticCurveTo(r * 0.9, -r * 0.2, 0, r); c.quadraticCurveTo(-r * 0.9, -r * 0.2, 0, -r); c.fill();
  c.restore();
}
const PETAL_COL = ['#f6b6c8', '#f2a2b9', '#fbd0dc', '#eb8fab'];
BG.petals = {
  fps: 30,
  seed(s) { s.p = Array.from({ length: Math.round(Math.min(42, s.w / 34)) }, () => ({ x: rnd(0, s.w), y: rnd(-s.h, s.h), r: rnd(4, 9), rot: rnd(0, 6), vr: rnd(-1.5, 1.5), vy: rnd(18, 45), ph: rnd(0, 6), col: pick(PETAL_COL) })); },
  draw(s, c, dt, t) {
    c.clearRect(0, 0, s.w, s.h);
    const wind = Math.sin(t * 0.17) * 22;
    for (const p of s.p) {
      p.y += p.vy * dt; p.x += (wind + Math.sin(t * 1.1 + p.ph) * 18) * dt; p.rot += p.vr * dt;
      if (p.y > s.h + 20) { p.y = -20; p.x = rnd(-40, s.w); }
      if (p.x > s.w + 30) p.x = -20; if (p.x < -40) p.x = s.w + 10;
      c.fillStyle = p.col; petal(c, p.x, p.y, p.r, p.rot, 0.55);
    }
    c.globalAlpha = 1;
  },
};
// «Девятый вал»: вихри неба мазками (Ван Гог), луна в кольцах, а внизу —
// тяжёлые волны с пеной и лунной дорожкой (Айвазовский).
const SEA_STROKE = ['#1d4e89', '#2f6fb3', '#5b93cf', '#8fb8de', '#f2c14e', '#f7e3a1'];
function seaField(s, x, y, t) {
  let a = Math.sin(x * 0.0042 + t * 0.07) * Math.cos(y * 0.006 - t * 0.05) * 1.6;
  for (const v of s.vort) { const dx = x - v.x, dy = y - v.y, d2 = dx * dx + dy * dy; const k = Math.exp(-d2 / (v.r * v.r)); a = a * (1 - k) + (Math.atan2(dy, dx) + Math.PI / 2 * v.dir) * k; }
  return a;
}
function drawSea(s, c, t, top, amp, alpha) {
  const layers = 4;
  for (let L = 0; L < layers; L++) {
    const base = top + (s.h - top) * (L / layers) * 0.85;
    const A = amp * (0.5 + L * 0.35), k = 0.006 + L * 0.0018, sp = 0.5 + L * 0.25;
    const yAt = x => base + A * Math.sin(x * k - t * sp + L * 1.7) + A * 0.35 * Math.sin(x * k * 2.3 + t * sp * 1.4 + L);
    const g = c.createLinearGradient(0, base - A, 0, s.h);
    g.addColorStop(0, 'rgba(' + (28 + L * 6) + ',' + (70 + L * 10) + ',' + (96 + L * 8) + ',' + alpha + ')');
    g.addColorStop(1, 'rgba(4,16,28,' + Math.min(1, alpha + 0.2) + ')');
    c.fillStyle = g; c.beginPath(); c.moveTo(0, s.h);
    for (let x = 0; x <= s.w + 12; x += 12) c.lineTo(x, yAt(x));
    c.lineTo(s.w, s.h); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(235,245,240,' + (alpha * 0.55) + ')'; c.lineWidth = 1.4; c.beginPath();
    for (let x = 0; x <= s.w; x += 12) { const y = yAt(x), y2 = yAt(x + 12); if (y2 < y - 1.5) { c.moveTo(x, y); c.lineTo(x + 12, y2); } }
    c.stroke();
  }
  const mx = s.w * 0.78;
  c.fillStyle = 'rgba(247,227,161,' + (alpha * 0.7) + ')';
  for (let i = 0; i < 26; i++) { const y = top + 6 + i * (s.h - top) / 26, w = 6 + i * 2.2; const x = mx + Math.sin(t * 1.3 + i * 1.7) * w * 0.8; c.fillRect(x - w / 2, y, w, 1.6); }
}
BG.sea = {
  fps: 24,
  seed(s) {
    s.top = s.h * 0.66;
    s.vort = [{ x: s.w * 0.32, y: s.h * 0.24, r: s.h * 0.16, dir: 1 }, { x: s.w * 0.58, y: s.h * 0.4, r: s.h * 0.12, dir: -1 }];
    s.p = Array.from({ length: 240 }, () => ({ x: rnd(0, s.w), y: rnd(0, s.top), life: rnd(0, 4), col: pick(SEA_STROKE) }));
  },
  draw(s, c, dt, t) {
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,.05)'; c.fillRect(0, 0, s.w, s.top);
    c.globalCompositeOperation = 'source-over';
    c.lineCap = 'round'; c.lineWidth = 2.2;
    for (const p of s.p) {
      const a = seaField(s, p.x, p.y, t);
      const nx = p.x + Math.cos(a) * 26 * dt, ny = p.y + Math.sin(a) * 26 * dt;
      c.strokeStyle = p.col; c.globalAlpha = 0.28;
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(nx, ny); c.stroke();
      p.x = nx; p.y = ny;
      if ((p.life -= dt) < 0 || p.x < 0 || p.x > s.w || p.y < 0 || p.y > s.top) { p.x = rnd(0, s.w); p.y = rnd(0, s.top); p.life = rnd(2, 5); }
    }
    c.globalAlpha = 1;
    // Луна в кольцах — как на «Звёздной ночи».
    const mx = s.w * 0.78, my = s.h * 0.17;
    c.clearRect(mx - 70, my - 70, 140, 140);
    for (let i = 4; i >= 1; i--) { c.strokeStyle = 'rgba(247,227,161,' + (0.07 * i) + ')'; c.lineWidth = 3; c.beginPath(); c.arc(mx, my, 18 + i * 11 + Math.sin(t + i) * 1.5, 0, 6.283); c.stroke(); }
    c.fillStyle = 'rgba(247,227,161,.85)'; c.beginPath(); c.arc(mx, my, 16, 0, 6.283); c.fill();
    c.clearRect(0, s.top - 40, s.w, s.h - s.top + 40);
    drawSea(s, c, t, s.top, 9, 0.5);
  },
};
const THEME_BG = { dark: 'sky', oled: 'sky', retro: 'pixel', matrix: 'rain', neon: 'grid', sakura: 'petals', sea: 'sea' };

const fx = { cv: null, ctx: null, raf: 0, mode: '', last: 0, t: 0, s: null, cost: 0 };
function fxMode() { return THEME_BG[document.documentElement.dataset.theme] || ''; }
function fxResize() {
  if (!fx.cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  fx.cv.width = Math.round(w * dpr); fx.cv.height = Math.round(h * dpr);
  fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fx.s = { w, h };
  BG[fx.mode].seed(fx.s);
}
function fxFrame(ts) {
  fx.raf = 0;
  if (!fx.cv || !fx.mode || document.hidden) return;
  const bg = BG[fx.mode];
  if (ts - fx.last < 1000 / bg.fps - 2) { fx.raf = requestAnimationFrame(fxFrame); return; }
  const dt = Math.min(0.1, (ts - (fx.last || ts)) / 1000); fx.last = ts; fx.t += dt;
  const t0 = performance.now();
  bg.draw(fx.s, fx.ctx, dt, fx.t);
  fx.cost = fx.cost * 0.95 + (performance.now() - t0) * 0.05;
  fx.raf = requestAnimationFrame(fxFrame);
}
function fxApply() {
  const mode = fxOn() ? fxMode() : '';
  if (mode !== fx.mode && fx.cv) { fx.cv.remove(); fx.cv = null; }
  fx.mode = mode;
  if (!mode) return;
  if (!fx.cv) {
    fx.cv = document.createElement('canvas'); fx.cv.id = 'fxSky'; fx.cv.setAttribute('aria-hidden', 'true');
    document.body.prepend(fx.cv);
    fx.ctx = fx.cv.getContext('2d');
    fxResize();
  }
  if (!fx.raf) { fx.last = 0; fx.raf = requestAnimationFrame(fxFrame); }
}

/* ---------- анимации запуска ----------
   Каждая — draw(o, c, dt, t, v): v — «скорость», в ожидании ровная, при
   запуске разгоняется. burst — длительность разгона, flash — цвет вспышки. */
const LAUNCH = {};
LAUNCH.warp = {
  name: 'Варп-прыжок', burst: 1.1, flash: '',
  init(o) { o.st = Array.from({ length: o.retro ? 160 : 340 }, () => ({ a: Math.random() * 6.283, d: Math.random() * 0.9 + 0.02, s: Math.random() * 0.7 + 0.3, col: pick(RETRO_PAL) })); },
  draw(o, c, dt, t, v) {
    const { w, h, retro } = o, cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
    c.fillStyle = retro ? 'rgba(0,0,0,.5)' : 'rgba(2,4,12,' + (v > 2 ? 0.28 : 0.45) + ')'; c.fillRect(0, 0, w, h);
    for (const s of o.st) {
      const d0 = s.d; s.d += (0.004 + s.d * 0.9) * v * s.s * 0.05;
      if (s.d > 1.15) { s.d = 0.02 + Math.random() * 0.05; s.a = Math.random() * 6.283; continue; }
      const x0 = cx + Math.cos(s.a) * d0 * R, y0 = cy + Math.sin(s.a) * d0 * R, x1 = cx + Math.cos(s.a) * s.d * R, y1 = cy + Math.sin(s.a) * s.d * R;
      if (retro) { c.fillStyle = s.col; const n = Math.max(1, Math.round((s.d - d0) * R / 6)); for (let i = 0; i <= n; i++) { const k = i / n; c.fillRect(Math.round((x0 + (x1 - x0) * k) / 3) * 3, Math.round((y0 + (y1 - y0) * k) / 3) * 3, 3, 3); } }
      else { c.strokeStyle = 'rgba(' + (190 + Math.round(65 * s.s)) + ',' + (215 + Math.round(40 * s.s)) + ',255,' + Math.min(1, 0.25 + s.d).toFixed(2) + ')'; c.lineWidth = 0.6 + s.d * 2.2; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
    }
  },
};
LAUNCH.matrix = {
  name: 'Матрица', burst: 1.3, flash: 'matrix',
  init(o) { o.cols = Array.from({ length: Math.ceil(o.w / 16) }, () => ({ y: rnd(-o.h, 0), v: rnd(0.6, 1.4) })); o.c.fillStyle = '#000'; o.c.fillRect(0, 0, o.w, o.h); },
  draw(o, c, dt, t, v) {
    c.fillStyle = 'rgba(0,0,0,.12)'; c.fillRect(0, 0, o.w, o.h);
    c.font = 'bold 16px "MS Gothic","Lucida Console",monospace';
    o.cols.forEach((col, i) => {
      const step = col.v * (120 + v * 90) * dt;
      for (let y = col.y; y < col.y + step; y += 16) { c.fillStyle = 'rgba(57,255,122,.85)'; c.fillText(pick(MATRIX_CH), i * 16, y); }
      col.y += step; c.fillStyle = '#e6ffe9'; c.fillText(pick(MATRIX_CH), i * 16, col.y);
      if (col.y > o.h + 20) { col.y = rnd(-120, 0); col.v = rnd(0.6, 1.4); }
    });
  },
};
// Ракорд старой плёнки: круг, перекрестье, бегущий сектор и цифра 3-2-1.
LAUNCH.film = {
  name: 'Киноплёнка', burst: 2.1, flash: 'film',
  init() {},
  draw(o, c, dt, t, v, burst) {
    const { w, h } = o, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3;
    const fl = 0.92 + Math.random() * 0.08;
    c.fillStyle = 'rgb(' + Math.round(214 * fl) + ',' + Math.round(192 * fl) + ',' + Math.round(150 * fl) + ')'; c.fillRect(0, 0, w, h);
    const per = burst ? burst / 3 : 1;
    const ph = (t % per) / per;
    const num = burst ? Math.max(1, 3 - Math.floor(t / per)) : 3 - Math.floor(t / per) % 3;
    c.fillStyle = 'rgba(70,52,30,.33)'; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R * 1.6, -Math.PI / 2, -Math.PI / 2 + ph * 6.283); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(40,28,14,.85)'; c.lineWidth = 3;
    c.beginPath(); c.arc(cx, cy, R, 0, 6.283); c.stroke();
    c.beginPath(); c.arc(cx, cy, R * 0.82, 0, 6.283); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.moveTo(0, cy); c.lineTo(w, cy); c.moveTo(cx, 0); c.lineTo(cx, h); c.stroke();
    c.fillStyle = 'rgba(30,20,10,.9)'; c.font = 'bold ' + Math.round(R * 1.1) + 'px Georgia,"Times New Roman",serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(num), cx, cy + R * 0.05); c.textAlign = 'start'; c.textBaseline = 'alphabetic';
    // зерно и царапины
    c.fillStyle = 'rgba(40,28,14,.35)';
    for (let i = 0; i < 260; i++) c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    c.fillStyle = 'rgba(255,248,230,.25)';
    for (let i = 0; i < 90; i++) c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    if (Math.random() < 0.7) { c.strokeStyle = 'rgba(40,28,14,.4)'; c.lineWidth = 1; const x = Math.random() * w; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + rnd(-8, 8), h); c.stroke(); }
    const vg = c.createRadialGradient(cx, cy, R * 0.8, cx, cy, Math.hypot(cx, cy));
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(40,24,8,.7)'); c.fillStyle = vg; c.fillRect(0, 0, w, h);
  },
};
LAUNCH.sakura = {
  name: 'Вихрь лепестков', burst: 1.4, flash: 'sakura',
  init(o) { const m = Math.hypot(o.w, o.h) / 2; o.p = Array.from({ length: 180 }, () => ({ a: rnd(0, 6.283), r: rnd(40, m), r0: 0, rot: rnd(0, 6), sz: rnd(5, 12), col: pick(PETAL_COL) })); o.p.forEach(p => { p.r0 = p.r; }); },
  draw(o, c, dt, t, v) {
    c.fillStyle = 'rgba(246,240,228,.38)'; c.fillRect(0, 0, o.w, o.h);
    const cx = o.w / 2, cy = o.h / 2;
    for (const p of o.p) {
      p.a += dt * (0.5 + v * 0.22) * (220 / (p.r + 60));
      p.r = v > 3 ? p.r + dt * v * 40 : p.r0 * (0.75 + 0.25 * Math.sin(t * 0.8 + p.a));
      p.rot += dt * 3;
      c.fillStyle = p.col; petal(c, cx + Math.cos(p.a) * p.r, cy + Math.sin(p.a) * p.r * 0.8, p.sz, p.rot + p.a, 0.85);
    }
    c.globalAlpha = 1;
  },
};
LAUNCH.neon = {
  name: 'Неоновый горизонт', burst: 1.2, flash: 'neon',
  init() {},
  draw(o, c, dt, t, v) {
    c.fillStyle = 'rgba(13,2,33,.55)'; c.fillRect(0, 0, o.w, o.h);
    o.tt = (o.tt || 0) + dt * (0.5 + v * 0.35);
    drawNeonScene(o, c, o.tt, 1, Math.min(1, 0.55 + v * 0.03));
  },
};
LAUNCH.wave = {
  name: 'Девятый вал', burst: 1.5, flash: 'sea',
  init() {},
  draw(o, c, dt, t, v, burst) {
    const g = c.createLinearGradient(0, 0, 0, o.h);
    g.addColorStop(0, '#08182a'); g.addColorStop(1, '#0f3049'); c.fillStyle = g; c.fillRect(0, 0, o.w, o.h);
    o.tt = (o.tt || 0) + dt * (1 + v * 0.15);
    const k = burst ? Math.min(1, t / burst) : 0;
    // Вал поднимается и накрывает экран к концу разгона.
    drawSea(o, c, o.tt, o.h * (0.62 - 0.75 * k * k), 14 + v * 2.5, 0.95);
  },
};
const LAUNCH_THEME = { matrix: 'matrix', neon: 'neon', sakura: 'sakura', sea: 'wave' };
function launchPref() { const v = localStorage.getItem(FXL_KEY) || 'auto'; return v === 'auto' || v === 'random' || v === 'off' || LAUNCH[v] ? v : 'auto'; }
let launchPick = { k: '', at: 0 };
function launchKind() {
  const p = launchPref();
  if (p === 'off') return '';
  if (p !== 'random' && p !== 'auto') return p;
  // Ожидание и запуск идут подряд — случайный выбор держится десять секунд,
  // чтобы ожидание и разгон были одной анимацией.
  if (launchPick.k && Date.now() - launchPick.at < 10000) return launchPick.k;
  const k = p === 'random' ? pick(Object.keys(LAUNCH)) : LAUNCH_THEME[document.documentElement.dataset.theme] || 'warp';
  launchPick = { k, at: Date.now() };
  return k;
}
function fxLaunchCanvas(kind) {
  const cv = document.createElement('canvas'); cv.className = 'fx-warp fx-' + kind;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.body.appendChild(cv);
  const o = { cv, c, w, h, kind, retro: document.documentElement.dataset.theme === 'retro' };
  LAUNCH[kind].init(o);
  return o;
}
function fxLaunchRun(o, speedAt, total, onEnd) {
  const an = LAUNCH[o.kind];
  let t0 = 0, last = 0, raf = 0, stopped = false;
  const frame = ts => {
    if (stopped) return;
    if (!t0) t0 = last = ts;
    const t = (ts - t0) / 1000, dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    an.draw(o, o.c, dt, t, speedAt(t), total);
    if (total && t >= total) { stop(); if (onEnd) onEnd(); return; }
    raf = requestAnimationFrame(frame);
  };
  const stop = () => { stopped = true; cancelAnimationFrame(raf); };
  raf = requestAnimationFrame(frame);
  return stop;
}
function fxFlash(kind, retro) {
  const f = document.createElement('div'); f.className = 'fx-flash' + (retro ? ' retro' : '') + (kind ? ' ' + kind : '');
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 700);
}
function fxFinish(o) { fxFlash(LAUNCH[o.kind].flash, o.retro); o.cv.classList.add('out'); setTimeout(() => o.cv.remove(), 380); }
let warpBusy = false;
// fxWarp — короткий разгон при запуске плеера (имя прежнее: так его зовёт код).
function fxWarp(kindForce) {
  const kind = kindForce || launchKind();
  if (!kind || !fxLaunchOn() || warpBusy) return;
  warpBusy = true;
  const o = fxLaunchCanvas(kind), T = LAUNCH[kind].burst;
  fxLaunchRun(o, t => 0.4 + Math.pow(t / T, 3) * 28, T, () => { fxFinish(o); setTimeout(() => { warpBusy = false; }, 380); });
}
// fxWarpCruise — фон окна ожидания; возвращает остановку (ok — с разгоном).
function fxWarpCruise(host) {
  const kind = launchKind();
  if (!kind || !fxLaunchOn()) return () => {};
  const o = fxLaunchCanvas(kind);
  o.cv.classList.add('cruise');
  if (host) host.classList.add('warp-host');
  let stop = fxLaunchRun(o, () => 2.2, 0);
  return ok => {
    stop();
    if (!ok) { o.cv.classList.add('out'); setTimeout(() => o.cv.remove(), 380); return; }
    stop = fxLaunchRun(o, t => 2.2 + Math.pow(t / 0.6, 3) * 26, 0.6, () => fxFinish(o));
  };
}
// Анимацию запуска можно оставить и при выключенном фоне — это разные галочки.
function fxLaunchOn() {
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch {}
  return launchPref() !== 'off';
}
function launchSelectHtml() {
  const v = launchPref();
  const opt = (k, l) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`;
  return `<select id="fxLaunch" style="width:auto">${opt('auto', 'Как у темы')}${opt('random', 'Случайная')}${Object.entries(LAUNCH).map(([k, a]) => opt(k, a.name)).join('')}${opt('off', 'Без анимации')}</select> <button id="fxTry" type="button">Показать</button>`;
}
function bindLaunchSelect() {
  const s = $('#fxLaunch'); if (!s) return;
  s.addEventListener('change', () => { savePref(FXL_KEY, s.value); launchPick = { k: '', at: 0 }; });
  const b = $('#fxTry'); if (b) b.addEventListener('click', () => { launchPick = { k: '', at: 0 }; const k = launchKind() || 'warp'; warpBusy = false; fxWarp(k); });
}

/* ---- ретро: включение ЭЛТ при выборе темы ---- */
function fxCrtOn() {
  if (!fxOn()) return;
  document.documentElement.classList.remove('crt-on'); void document.documentElement.offsetWidth;
  document.documentElement.classList.add('crt-on');
  setTimeout(() => document.documentElement.classList.remove('crt-on'), 900);
}

function fxBoot() {
  fxApply();
  window.addEventListener('resize', () => { if (fx.cv) fxResize(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && fx.mode && !fx.raf) { fx.last = 0; fx.raf = requestAnimationFrame(fxFrame); } });
  new MutationObserver(() => fxApply()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
/* Онлайн-экземпляры JacRed: агрегатор русских трекеров с ручками Jackett.
   jr.maxvol.pro отвечает Torznab, jac-red.ru — только JSON-ручкой Jackett
   (демон переходит на неё сам). */
const JACRED_ONLINE = [
  { name: 'JacRed (maxvol)', url: 'https://jr.maxvol.pro/api/v2.0/indexers/all/results/torznab/api' },
  { name: 'JacRed (jac-red.ru)', url: 'https://jac-red.ru/api/v2.0/indexers/all/results/torznab/api' },
];
/* ================= SETTINGS ================= */
function renderSettings(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Настройки TorrClient</h1></div><input class="search-input" id="setFilter" type="search" placeholder="🔍 Найти настройку (Ctrl+F)…" style="max-width:320px"></div>
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
    <div class="card"><h3>Индексаторы Torznab</h3>
      <p class="page-sub">Поиск идёт напрямую в индексатор, без TorrServer. Обычно это Jackett или Prowlarr: у него есть кнопка копирования адреса Torznab вместе с ключом — вставьте эту строку целиком, ключ выделится сам.</p>
      <div id="tzList"></div>
      <div class="row wrap" style="margin-top:8px">
        <button id="tzFind" title="Ищет Jackett и Prowlarr на этом компьютере и в вашей локальной сети (порты 9117 и 9696)">Найти Jackett / Prowlarr</button>
        <span class="page-sub" id="tzFindNote" style="margin:0"></span>
      </div>
      <div id="tzFound"></div>
      <details id="tzHelp" style="margin-top:8px"><summary>Нет Jackett или Prowlarr? Установить и настроить</summary>
        <p class="page-sub">Jackett и Prowlarr — отдельные бесплатные программы: они ищут по десяткам трекеров сразу, а TorrClient спрашивает их одним запросом. Нужна одна из двух; Prowlarr новее и удобнее.</p>
        <div id="tzApps"></div>
        <ol class="page-sub" style="margin:6px 0 0 18px;padding:0">
          <li>Установите и запустите программу кнопкой выше (или скачайте с сайта).</li>
          <li>Откройте её страницу и добавьте трекеры: <b>Indexers → Add Indexer</b>. Публичные (rutor, NNM-Club, RuTor, 1337x и др.) работают без входа; для закрытых нужен ваш логин на трекере.</li>
          <li>Нажмите «Найти Jackett / Prowlarr» — адрес и ключ подставятся сами.</li>
        </ol>
      </details>
      <div class="row wrap" style="margin-top:8px">
        <input id="tzName" placeholder="Название" style="flex:1;min-width:110px">
        <input id="tzUrl" placeholder="http://127.0.0.1:9117/results/torznab/api" style="flex:2;min-width:220px">
        <input id="tzKey" placeholder="API key (если есть)" style="flex:1;min-width:130px">
        <button id="tzTest">Проверить</button>
        <button id="tzAdd" class="primary">Добавить</button>
      </div>
      <div id="tzNote" class="page-sub" style="margin-top:6px"></div>
      <div class="row wrap" style="margin-top:8px;align-items:center">
        <span class="page-sub">Онлайн, без установки (JacRed — rutor, Кинозал, NNM, RuTracker и др. сразу):</span>
        ${raw(JACRED_ONLINE.map(j => html`<button class="ghost" data-jacred="${j.url}" data-jname="${j.name}" title="${j.url}">＋ ${j.name}</button>`).join(''))}
      </div>
      <div class="page-sub" style="margin-top:4px">Это чужие общедоступные серверы: они видят ваши запросы и могут пропасть. Ключ не нужен.</div>
    </div>
    <div class="card"><h3>Автодобавление .torrent</h3>
      <p class="page-sub">Файлы .torrent, которые сохранены вашим браузером (Firefox/Chrome) из «Просмотровать в приложениях», автоматически добавятся через watch-папку.</p>
      <div class="row wrap">
        <input id="wfPath" value="${state.hello.watch_folder}" style="flex:2">
        <button id="wfBrowse">Обзор</button>
        <button id="wfReg" class="primary">Зарегистрировать magnet:// и .torrent</button>
        <label style="margin:0;display:inline-flex;align-items:center;gap:6px" title="Демон запускается при входе в систему, без окна и без открытия браузера"><input type="checkbox" id="autoStart" disabled> запускать при входе в систему</label>
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
      ${raw(folderOverlapHTML())}
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
    <div class="card"><h3>Источники поиска</h3>
      <p class="page-sub">Поиск, ТОП за 24 часа, «Популярное», «Лучшая раздача» и подписки работают с любым набором источников: rutor, Кинозал и индексаторы Torznab (JacRed, Jackett, Prowlarr). Если rutor закрыт или не нужен — выключите его, остальные продолжат работать.</p>
      <label style="margin:0"><input type="checkbox" id="rutorOn" checked> Использовать rutor</label>
    </div>
    <div class="card"><h3>Кинозал: зеркала</h3>
      <p class="page-sub">Официальные: kinozal.tv, kinozal.me, kinozal.guru — они проверяются первыми. Неофициальные зеркала — запасной путь, если официальные не отдают выдачу.</p>
      <p class="page-sub">Файл .torrent Кинозал отдаёт только вошедшим. Укажите свой логин — программа войдёт сама, когда понадобится. Без логина раздача ищется в других источниках (JacRed, rutor) и запускается по магниту.</p>
      <div class="row wrap"><input id="kzUser" placeholder="Логин Кинозала" autocomplete="username" style="max-width:200px"><input id="kzPass" type="password" placeholder="Пароль" autocomplete="current-password" style="max-width:200px"></div>
      <label style="margin:0"><input type="checkbox" id="kzOfficial"> Только официальные зеркала (и свои из списка ниже)</label>
      <label>Свои зеркала (через запятую или с новой строки), проверяются первыми</label>
      <textarea id="kzHosts" rows="2" placeholder="kinozal.tv"></textarea>
      <div class="row wrap" style="margin-top:8px"><button id="kzSave">Сохранить</button><button id="kzProbe" class="primary">Проверить зеркала</button><span id="kzLast" class="page-sub"></span></div>
      <div id="kzProbeOut"></div>
    </div>
    <div class="card"><h3>Оформление</h3>
      ${raw(themePickerHtml())}
      <p class="page-sub">Кнопка 🌓 в шапке и клавиша T перебирают темы по кругу.</p>
      <label class="check" title="Звездопад на фоне «Графита», пиксельные звёзды «Денди», варп-прыжок при запуске просмотра"><input type="checkbox" id="fxToggle" ${localStorage.getItem('tc_fx') === '0' ? '' : 'checked'}> Живой фон темы (звёзды, дождь символов, лепестки, море)</label>
      <div class="row wrap" style="margin-top:8px; align-items:center; gap:8px"><span>Анимация запуска просмотра:</span>${raw(launchSelectHtml())}</div>
    </div>
    <div class="card" id="remoteCard"><h3>Доступ с телефона</h3>
      <p class="page-sub">Откройте TorrClient на телефоне в той же Wi-Fi-сети: наведите камеру на QR-код или введите адрес и PIN. С телефона можно искать, добавлять раздачи и запускать просмотр на компьютере.</p>
      <div id="remoteBox"><div class="hint">Загрузка…</div></div>
    </div>
    <div class="card"><h3>Автооткрытие и встроенные</h3>
      <label style="margin:0"><input type="checkbox" id="autoOpen" ${localStorage.getItem('tc_autoopen') !== '0' ? 'checked' : ''}> Автоматически открывать UI после добавления торрента</label>
    </div>
    <div class="card"><h3>О программе</h3>
      <div class="stat-line">
        <div><b>Версия:</b> ${state.hello.app_version || '?'} <span class="mono">${(state.hello.version || '').replace(/^TorrClient\s*/, '')}</span></div>
        <div><b>Система:</b> ${state.hello.os || ''}</div>
        <div><b>Папка программы:</b> <span class="mono">${state.hello.exe || '—'}</span></div>
      </div>
      <ul class="whatsnew">${raw(WHATSNEW.map(([v, items]) => html`<li><b>${v}</b>: ${items.join('; ')}</li>`).join(''))}</ul>
      <p class="page-sub">Версия подставляется при сборке. По ней видно, какая копия запущена, когда на диске лежит несколько сборок.</p>
      <div class="row wrap" style="margin-bottom:8px">
        <button id="updCheck">Проверить обновления</button>
        <label style="margin:0"><input type="checkbox" id="updAuto" ${localStorage.getItem('tc_autoupd') !== '0' ? 'checked' : ''}> Проверять автоматически</label>
      </div>
      <div class="row wrap">
        <button id="diagBtn" class="primary">Собрать отчёт о состоянии</button>
        <span class="page-sub" style="margin:0">Версии, папки, серверы и файлы данных разом. Ключ TMDB и пароли в отчёт не попадают.</span>
      </div>
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
  { const fxt = $('#fxToggle'); if (fxt) fxt.addEventListener('change', () => { savePref('tc_fx', fxt.checked ? '1' : '0'); fxApply(); }); }
  bindLaunchSelect();
  $('#wfReg').addEventListener('click', async () => {
    try { await api('/api/reg?action=install', { method: 'POST' }); toast('Протокол magnet:// зарегистрирован. Проверьте, что TorrClient — браузер по умолчанию для magnet.'); renderServerStatus(); } catch (e) { toast(e.message, true); }
  });
  const asBox = $('#autoStart');
  if (asBox) {
    api('/api/autostart').then(j => {
      if (!j.supported) { asBox.parentElement.title = 'На этой системе автозапуск не поддерживается'; return; }
      asBox.checked = !!j.enabled; asBox.disabled = false;
    }).catch(() => {});
    asBox.addEventListener('change', async () => {
      asBox.disabled = true;
      try {
        const j = await api('/api/autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: asBox.checked }) });
        asBox.checked = !!j.enabled;
        toast(j.enabled ? 'Автозапуск включён' : 'Автозапуск выключен');
      } catch (e) { asBox.checked = !asBox.checked; toast(e.message, true); }
      asBox.disabled = false;
    });
  }
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
  initKinozalMirrors();
  initRutorToggle();
  initSettingsFilter(root);
  const diagBtn = $('#diagBtn');
  if (diagBtn) diagBtn.addEventListener('click', () => showDiagnostics(diagBtn));
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

  /* ---------- индексаторы Torznab ----------
     Проверка идёт по тому, что человек ввёл в поля, а не по сохранённому:
     иначе «Проверить» перед добавлением было бы некуда нажать. И проверка
     ничего не сохраняет — иначе кнопка «проверить» была бы кнопкой
     «применить», и об этом нигде не написано. */
  let tzSources = [];
  const tzDraw = () => {
    const rows = tzSources.map(s => html`
      <div class="row wrap" style="align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line,#eee)">
        <b style="flex:1;min-width:110px">${s.name}</b>
        <span class="mono page-sub" style="flex:2;min-width:180px">${s.url}</span>
        ${raw(s.has_key ? html`<span class="chip grey" title="ключ сохранён">ключ ${s.key_hint || '••••'}</span>` : html`<span class="chip grey">без ключа</span>`)}
        <button data-tz="test" data-name="${s.name}">Проверить</button>
        <button data-tz="del" data-name="${s.name}" class="danger">Удалить</button>
      </div>`).join('');
    $('#tzList').innerHTML = rows || '<div class="empty">Индексаторы не заданы — поиск по Torznab сейчас ничего не вернёт.</div>';
    $$('#tzList [data-tz]').forEach(b => b.addEventListener('click', () => {
      const name = b.dataset.name;
      if (b.dataset.tz === 'del') {
        if (!confirm('Удалить индексатор ' + name + '?')) return;
        return tzSave(tzSources.filter(s => s.name !== name), name)
          .then(() => { toast('Индексатор удалён'); renderSettings(root); })
          .catch(e => toast('Не удалось удалить: ' + e.message, true));
      }
      const btn = b; btn.disabled = true; btn.textContent = 'Проверка...';
      tzTest({ name })
        .then(res => { tzTestShow(res); })
        .catch(e => { $('#tzNote').innerHTML = html`<span style="color:#c0392b">Проверка не удалась: ${e.message}</span>`; })
        .finally(() => { btn.disabled = false; btn.textContent = 'Проверить'; });
    }));
  };
  /* tzSave шлёт весь список: составной PUT без чтения здесь был бы источником
     тихой потери — удалил одну строку в интерфейсе, а на сервере пропала
     соседняя. */
  const tzSave = (list, remove) => api('/api/torznab/sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(remove ? { remove } : { sources: list.map(s => ({ name: s.name, url: s.url, api_key: s.api_key || '' })) }),
  }).then(j => { tzSources = j.sources || []; tzDraw(); return j; });
  const tzTest = body => api('/api/torznab/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const tzTestShow = res => {
    const caps = res.caps || {};
    const kinds = [
      caps.search && 'обычный', caps.tv_search && 'сериалы', caps.movie_search && 'фильмы',
      caps.music_search && 'музыка', caps.book_search && 'книги',
    ].filter(Boolean).join(', ');
    const bits = [`<b>${res.name || 'Индексатор'}</b> ${res.ok ? 'отвечает' : 'не отвечает'} за ${res.ms || 0} мс`];
    if (res.ok) bits.push(`раздач на пробный запрос: ${res.items}${kinds ? ' · поиск: ' + kinds : ''}`);
    if ((res.notes || []).length) bits.push('<div class="page-sub" style="margin-top:4px">' + res.notes.join('<br>') + '</div>');
    if (!res.ok && res.error) bits.push(`<div style="color:#c0392b;margin-top:4px">${res.error}</div>`);
    $('#tzNote').innerHTML = bits.join(' ');
  };
  const tzFromForm = () => ({
    name: ($('#tzName').value || '').trim(),
    url: ($('#tzUrl').value || '').trim(),
    api_key: ($('#tzKey').value || '').trim(),
  });
  initTorznabApps();
  initRemote();
  $('#updCheck').addEventListener('click', async e => {
    e.target.disabled = true;
    const u = await checkUpdate(true);
    e.target.disabled = false;
    if (u && u.error) toast(u.error, true); else if (u) showUpdate();
  });
  $('#updAuto').addEventListener('change', e => { localStorage.setItem('tc_autoupd', e.target.checked ? '1' : '0'); });
  $('#tzFind').addEventListener('click', async () => {
    const btn = $('#tzFind'), note = $('#tzFindNote'), box = $('#tzFound');
    btn.disabled = true; btn.textContent = 'Ищу...'; note.textContent = ''; box.innerHTML = '';
    try {
      const res = await api('/api/torznab/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const found = res.found || [];
      note.textContent = found.length ? 'Найдено: ' + found.length + ' (проверено адресов: ' + res.scanned + ')'
        : 'Ничего не найдено (проверено адресов: ' + res.scanned + '). Запущены ли Jackett или Prowlarr? Адрес можно ввести вручную ниже.';
      box.innerHTML = found.map((f, i) => html`<div class="row wrap" style="margin-top:6px" data-fi="${i}">
        <b>${f.kind === 'jackett' ? 'Jackett' : 'Prowlarr'}</b>
        <span class="page-sub" style="margin:0">${f.host}:${f.port}${f.local ? ' · этот компьютер' : ''}</span>
        ${raw(f.key_found ? '<span class="chip grey">ключ найден</span>' : html`<input class="fkey" placeholder="API key" style="flex:1;min-width:150px">`)}
        <button class="primary fadd">Добавить</button>
      </div>`).join('');
      $$('.fadd', box).forEach(b => b.addEventListener('click', async () => {
        const row = b.closest('[data-fi]'), f = found[+row.dataset.fi];
        const keyEl = $('.fkey', row);
        b.disabled = true; b.textContent = 'Добавляю...';
        try {
          const j = await api('/api/torznab/discover/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: f.kind, base: f.base, api_key: keyEl ? keyEl.value.trim() : '' }),
          });
          tzSources = j.sources || []; tzDraw();
          b.textContent = 'Добавлено: ' + j.added;
          toast('Индексаторов добавлено: ' + j.added);
        } catch (e) { b.disabled = false; b.textContent = 'Добавить'; toast(e.message, true); }
      }));
    } catch (e) { note.textContent = 'Поиск не удался: ' + e.message; }
    finally { btn.disabled = false; btn.textContent = 'Найти Jackett / Prowlarr'; }
  });
  api('/api/torznab/sources').then(j => { tzSources = j.sources || []; tzDraw(); }).catch(() => { $('#tzList').innerHTML = '<div class="empty">Не удалось прочитать список индексаторов</div>'; });
  $('#tzTest').addEventListener('click', async () => {
    const f = tzFromForm();
    if (!f.url) return toast('Укажите адрес индексатора', true);
    const btn = $('#tzTest'); btn.disabled = true; btn.textContent = 'Проверка...';
    try { tzTestShow(await tzTest(f)); } catch (e) { $('#tzNote').innerHTML = html`<span style="color:#c0392b">Проверка не удалась: ${e.message}</span>`; }
    finally { btn.disabled = false; btn.textContent = 'Проверить'; }
  });
  // Онлайн-JacRed: проверка и добавление одним нажатием.
  $$('[data-jacred]').forEach(b => b.addEventListener('click', async () => {
    const f = { name: b.dataset.jname, url: b.dataset.jacred, api_key: '' };
    if (tzSources.some(s => (s.url || '').replace(/\/+$/, '') === f.url || (s.name || '').toLowerCase() === f.name.toLowerCase()))
      return toast('Этот источник уже добавлен');
    b.disabled = true; b.textContent = 'Проверяю…';
    try {
      const res = await tzTest(f);
      tzTestShow(res);
      if (!res.ok) { toast('Сервер не отвечает — попробуйте другой', true); return; }
      await tzSave(tzSources.concat([f]));
      toast(f.name + ' добавлен — поиск Torznab идёт и через него');
      renderSettings(root);
    } catch (e) { toast('Не удалось добавить: ' + e.message, true); }
    finally { b.disabled = false; b.textContent = '＋ ' + f.name; }
  }));
  $('#tzAdd').addEventListener('click', async () => {
    const f = tzFromForm();
    if (!f.url) return toast('Укажите адрес индексатора', true);
    if (tzSources.some(s => s.name && s.name.toLowerCase() === f.name.toLowerCase()))
      return toast('Индексатор с таким именем уже есть', true);
    try {
      /* Ключ приходит из формы, а у уже сохранённых источников форма его не
         знает: сервер оставит прежний ключ, когда в записи ключ пуст. */
      await tzSave(tzSources.concat([{ name: f.name, url: f.url, api_key: f.api_key }]));
      toast('Индексатор добавлен');
      $('#tzName').value = ''; $('#tzUrl').value = ''; $('#tzKey').value = '';
      renderSettings(root);
    } catch (e) { toast('Не удалось добавить: ' + e.message, true); }
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
    const was = { name: p.name, url: p.url, user: p.user, pass: p.pass };
    p.name = ov.querySelector('#epName').value; p.url = ov.querySelector('#epUrl').value; p.user = ov.querySelector('#epUser').value; p.pass = ov.querySelector('#epPass').value;
    // Окно не закрывается до ответа и ошибка называется: прежде окно исчезало
    // сразу, а отказ демона терялся в консоли — правка выглядела сохранённой.
    const go = ov.querySelector('#epGo');
    go.disabled = true;
    try {
      await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', profile: p }) });
      ov.remove(); state.profiles = await (await api('/api/profiles')).profiles; renderTopbar(); route();
    } catch (e) {
      // Правка откатывается вместе с отказом: иначе в памяти остался бы сервер,
      // которого нет на диске, и следующее сохранение записало бы его молча.
      Object.assign(p, was);
      toast('Сервер не сохранён: ' + e.message, true);
      go.disabled = false;
    }
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
    try {
      const arr = JSON.parse(r.result);
      if (!Array.isArray(arr)) { toast('В файле не список избранного', true); return; }
      // Через saveFavList, а не прямо в localStorage: он же отправляет список
      // демону. Прежде импорт жил только в браузере и исчезал при первом
      // обновлении склада — «Импортировано N» и пустое избранное.
      saveFavList(arr);
      toast('Импортировано ' + arr.length + ' позиций');
      if (state.view === 'favorites') route();
    } catch (e) { toast('Ошибка импорта: ' + e.message, true); }
  };
  r.onerror = () => toast('Не удалось прочитать файл', true);
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
  paintVersion();
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


// Поиск по настройкам: прячет разделы без совпадений и подсвечивает строки,
// где нашлись слова. Слова ищутся все сразу и в любом порядке, «ё» = «е»;
// учитываются подсказки полей, подписи кнопок и пункты списков. Enter —
// прокрутка к первому совпадению, Ctrl+F или «/» — к полю поиска.
const SET_SYNONYMS = { плеер: 'vlc mpc potplayer mpv', язык: 'озвучк субтитр', пароль: 'логин вход', обложк: 'постер tmdb', постер: 'tmdb обложк', ключ: 'tmdb api', телефон: 'удалён qr', порт: 'адрес сервер', тема: 'оформлен вид', качество: '1080 2160 4k hdr', кэш: 'cache предзагруз', автозапуск: 'трей windows' };
function setNorm(v) { return String(v || '').toLowerCase().replace(/ё/g, 'е'); }
function initSettingsFilter(root) {
  const inp = $('#setFilter'); if (!inp) return;
  const bar = inp.closest('.toolbar'); if (bar) bar.classList.add('set-sticky');
  const cards = [...root.querySelectorAll('.card')];
  const textOf = el => setNorm(el.textContent + ' ' + [...el.querySelectorAll('input,textarea,select,button,[title]')]
    .map(x => (x.placeholder || '') + ' ' + (x.title || '') + ' ' + (x.tagName === 'SELECT' ? [...x.options].map(o => o.text).join(' ') : '')).join(' '));
  const info = document.createElement('div'); info.className = 'page-sub'; info.style.display = 'none';
  if (bar) bar.after(info);
  let first = null;
  const run = () => {
    const words = setNorm(inp.value).split(/\s+/).filter(w => w.length > 1);
    $$('.set-hit', root).forEach(e => e.classList.remove('set-hit'));
    first = null;
    let shown = 0;
    for (const c of cards) {
      const t = textOf(c);
      const hit = !words.length || words.every(w => t.includes(w) || (SET_SYNONYMS[w] || '').split(' ').some(x => x && t.includes(x)));
      c.style.display = hit ? '' : 'none';
      if (!hit) continue;
      shown++;
      if (!words.length) continue;
      // Подсветка самых мелких подходящих строк раздела.
      for (const el of c.querySelectorAll('h3,label,.page-sub,button,.row > span,.field-label,summary')) {
        const et = textOf(el);
        if (words.some(w => et.includes(w))) { el.classList.add('set-hit'); if (!first) first = el; }
      }
      if (!first) first = c;
    }
    info.style.display = words.length ? '' : 'none';
    info.textContent = shown ? 'Найдено разделов: ' + shown + (first ? ' · Enter — перейти к первому' : '') : 'Такой настройки нет — попробуйте другое слово';
  };
  inp.addEventListener('input', run);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && first) { e.preventDefault(); first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    if (e.key === 'Escape') { inp.value = ''; run(); }
  });
  if (!window.__setFindKey) {
    window.__setFindKey = true;
    document.addEventListener('keydown', e => {
      if (state.view !== 'settings') return;
      const f = $('#setFilter'); if (!f || document.activeElement === f) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) { e.preventDefault(); f.focus(); f.select(); }
    });
  }
}

// Установка и запуск Jackett/Prowlarr из настроек (winget на Windows).
function initRemote() {
  const box = $('#remoteBox'); if (!box) return;
  let pick = 0;
  const draw = st => {
    const on = st.enabled;
    const addrs = st.addrs || [];
    if (pick >= addrs.length) pick = 0;
    const cur = addrs[pick];
    const fw = st.firewall || {};
    box.innerHTML = html`
      <label style="margin:0"><input type="checkbox" id="remoteOn" ${on ? 'checked' : ''}> Разрешить вход с телефона</label>
      ${raw(on ? html`
        <div class="row wrap" style="margin-top:10px;align-items:flex-start;gap:16px">
          ${raw(cur && cur.qr ? html`<img src="${cur.qr}" alt="QR-код для телефона" width="180" height="180" style="background:#fff;border-radius:8px;padding:6px">` : '')}
          <div style="flex:1;min-width:220px">
            <div><b>PIN:</b> <span class="mono" style="font-size:1.4em;letter-spacing:3px">${st.pin}</span></div>
            <div style="margin-top:6px"><b>Адрес${addrs.length > 1 ? ' (выберите сеть, в которой телефон)' : ''}:</b>
              ${raw(addrs.length ? addrs.map((x, i) => html`<label class="addr-pick"><input type="radio" name="remoteAddr" value="${i}" ${i === pick ? 'checked' : ''}>
                <span class="mono">http://${x.ip}:${st.port}</span><span class="page-sub">${x.iface}${x.virtual ? ' · виртуальный, телефон его не увидит' : ''}</span></label>`).join('') : '<div class="hint">Компьютер не подключён к локальной сети.</div>')}</div>
            ${raw(st.error ? html`<div class="hint" style="color:var(--red)">Не удалось открыть порт ${st.port}: ${st.error}</div>` : '')}
            ${raw(fw.supported ? (fw.rule
              ? '<div style="margin-top:6px;color:var(--acc2)">🛡 Брандмауэр Windows: вход разрешён</div>'
              : '<div style="margin-top:6px;color:var(--gold)">🛡 Брандмауэр Windows может не пускать телефон</div><button id="remoteFw" class="primary" style="margin-top:4px">Разрешить в брандмауэре</button><span class="page-sub"> — Windows спросит права администратора</span>') : '')}
            <div class="row wrap" style="margin-top:8px"><button id="remotePin">Новый PIN</button>
              <label style="margin:0">Порт <input id="remotePort" type="number" min="1024" max="65535" value="${st.port}" style="width:90px"></label></div>
            <details style="margin-top:8px"><summary>Не открывается на телефоне или планшете?</summary>
              <ol class="page-sub" style="margin:6px 0 0 18px;padding:0">
                <li>Нажмите «Разрешить в брандмауэре» (Windows). Если при первом запуске нажали «Отмена», Windows запретила вход сама.</li>
                <li>Телефон — в той же сети Wi-Fi, что и компьютер, и не в «гостевой»: гостевая сеть не пускает к другим устройствам.</li>
                <li>Если адресов несколько — выберите другой и отсканируйте QR заново.</li>
                <li>Выключите VPN на компьютере и на телефоне.</li>
                <li>Откройте адрес на телефоне вручную: <span class="mono">${cur ? 'http://' + cur.ip + ':' + st.port : ''}</span>. Если не открывается даже страница PIN — мешает сеть или брандмауэр, а не PIN.</li>
                <li>В роутере бывает «изоляция клиентов» (AP isolation) — её нужно выключить.</li>
              </ol></details>
          </div>
        </div>` : '')}`;
  };
  let last = null;
  const show = st => { last = st; draw(st); };
  const send = async body => {
    try { show(await api('/api/remote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); return true; }
    catch (e) { toast(e.message, true); load(); return false; }
  };
  const load = () => api('/api/remote').then(show).catch(() => { $('#remoteCard') && $('#remoteCard').remove(); });
  box.addEventListener('change', e => {
    if (e.target.id === 'remoteOn') send({ enabled: e.target.checked });
    if (e.target.id === 'remotePort') send({ port: +e.target.value });
    if (e.target.name === 'remoteAddr') { pick = +e.target.value; if (last) draw(last); }
  });
  box.addEventListener('click', async e => {
    if (e.target.id === 'remotePin' && confirm('Сменить PIN? Телефоны, вошедшие по старому, придётся подключить заново.')) send({ new_pin: true });
    if (e.target.id === 'remoteFw') {
      e.target.disabled = true; e.target.textContent = 'Жду подтверждения Windows…';
      if (await send({ firewall: true })) toast('Брандмауэр пускает телефон — отсканируйте QR ещё раз');
    }
  });
  load();
}

function initTorznabApps() {
  const box = $('#tzApps'); if (!box) return;
  let timer = null;
  const draw = st => {
    box.innerHTML = (st.apps || []).map(a => {
      const status = a.running ? '<span style="color:var(--acc2)">работает</span>'
        : a.job && a.job.state === 'installing' ? 'устанавливается…'
        : a.installed ? 'установлен, не запущен' : 'не установлен';
      const btns = [];
      if (a.running) btns.push(html`<button data-open-url="${a.url}">Открыть ${a.name}</button>`);
      else if (a.installed && a.exe) btns.push(html`<button class="primary" data-app="${a.kind}" data-act="start">Запустить</button>`);
      else if (st.winget && !(a.job && a.job.state === 'installing')) btns.push(html`<button class="primary" data-app="${a.kind}" data-act="install">Установить</button>`);
      btns.push(html`<button data-open-url="${a.site}">Сайт загрузки</button>`);
      const note = a.job && a.job.note && a.job.state !== 'installing' ? html`<div class="page-sub" style="margin:2px 0 0">${a.job.note}</div>` : '';
      return html`<div class="row wrap" style="margin-top:6px"><b style="min-width:80px">${a.name}</b><span class="page-sub" style="margin:0;min-width:170px">${raw(status)}</span>${raw(btns.join(''))}</div>${raw(note)}`;
    }).join('') + (st.os === 'windows' && !st.winget ? '<div class="hint">winget не найден — установите «Установщик приложений» из Microsoft Store или скачайте программу с сайта.</div>' : '');
    const busy = (st.apps || []).some(a => a.job && a.job.state === 'installing');
    clearTimeout(timer);
    if (busy) timer = setTimeout(load, 3000);
    const justDone = (st.apps || []).some(a => a.job && a.job.state === 'done' && a.running);
    if (justDone && !box.dataset.rescanned) { box.dataset.rescanned = '1'; $('#tzFind') && $('#tzFind').click(); }
  };
  const load = () => api('/api/torznab/apps').then(draw).catch(e => { box.innerHTML = html`<div class="hint">${e.message}</div>`; });
  box.addEventListener('click', async e => {
    const u = e.target.closest('[data-open-url]');
    if (u) { openExternal(u.dataset.openUrl); return; }
    const b = e.target.closest('[data-app]'); if (!b) return;
    b.disabled = true; b.textContent = b.dataset.act === 'install' ? 'Запускаю установку…' : 'Запускаю…';
    try {
      draw(await api('/api/torznab/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: b.dataset.app, action: b.dataset.act }) }));
      if (b.dataset.act === 'install') toast('Установка идёт в фоне. Windows может попросить подтверждение.');
      else setTimeout(load, 4000);
    } catch (err) { toast(err.message, true); load(); }
  });
  $('#tzHelp').addEventListener('toggle', () => { if ($('#tzHelp').open) load(); });
  load();
}
// ── Автообновление ──
// Демон спрашивает GitHub Releases; интерфейс показывает кнопку «⬆ версия»
// рядом со значком версии и окно с установкой в один клик.

let updInfo = null;

async function checkUpdate(force) {
  try { updInfo = await api('/api/update' + (force ? '?force=1' : '')); }
  catch (e) { if (force) toast(e.message, true); return null; }
  paintUpdateBadge();
  return updInfo;
}

function paintUpdateBadge() {
  const ver = document.getElementById('appVer'); if (!ver) return;
  let b = document.getElementById('updBtn');
  if (!updInfo || !updInfo.newer) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('button'); b.id = 'updBtn'; b.className = 'upd-btn';
    b.addEventListener('click', showUpdate);
    ver.after(b);
  }
  b.textContent = '⬆ ' + updInfo.latest;
  b.title = 'Доступна версия ' + updInfo.latest + ' — нажмите, чтобы обновить';
}

function showUpdate() {
  if (!updInfo) return;
  $$('body > .overlay.upd-ov').forEach(o => o.remove());
  const ov = document.createElement('div'); ov.className = 'overlay upd-ov';
  const notes = String(updInfo.notes || '').replace(/^#+\s*/gm, '').replace(/\*\*|`/g, '').trim();
  ov.innerHTML = html`<div class="modal" style="max-width:560px">
    <h3>${updInfo.newer ? 'Доступна версия ' + updInfo.latest : 'Установлена последняя версия'}</h3>
    <div class="page-sub">Сейчас: ${updInfo.current}${updInfo.latest ? ' · последняя: ' + updInfo.latest : ''}</div>
    ${raw(notes ? html`<div class="upd-notes">${notes}</div>` : '')}
    <div id="updState" class="page-sub"></div>
    <div class="row wrap">
      ${raw(updInfo.newer && updInfo.installable ? '<button class="primary" id="updGo">Обновить сейчас</button>' : '')}
      ${raw(updInfo.page ? '<button id="updPage">Страница релиза</button>' : '')}
      <button id="updClose">${updInfo.newer ? 'Не сейчас' : 'Закрыть'}</button>
    </div>
    <p class="page-sub" style="margin:8px 0 0">Архив скачивается с GitHub и сверяется с контрольной суммой. Настройки, избранное и отметки просмотра не затрагиваются. Окно программы обновится при следующем запуске.</p></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#updClose').addEventListener('click', close);
  const pg = ov.querySelector('#updPage'); if (pg) pg.addEventListener('click', () => openExternal(updInfo.page));
  const go = ov.querySelector('#updGo');
  if (go) go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Обновляю…';
    const st = ov.querySelector('#updState');
    try { await api('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install' }) }); }
    catch (e) { st.textContent = e.message; go.disabled = false; go.textContent = 'Повторить'; return; }
    const target = updInfo.latest;
    const poll = async () => {
      let s = null;
      try { s = await api('/api/update'); } catch {}
      if (s && s.state === 'failed') { st.textContent = 'Не удалось: ' + s.note; go.disabled = false; go.textContent = 'Повторить'; return; }
      if (s && s.state === 'installing') { st.textContent = s.note || 'Скачиваю…'; setTimeout(poll, 1500); return; }
      // Установлено или демон уже перезапускается: ждём ответа новой версии.
      st.textContent = 'Установлено, перезапуск…';
      try { const h = await api('/api/hello'); if (h.app_version === target) { location.reload(); return; } } catch {}
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 800);
  });
}

// Автопроверка — один раз за сеанс интерфейса (демон и сам не спрашивает
// GitHub чаще раза в 6 часов). Отключается в Настройках → «О программе».
function autoCheckUpdate() {
  if (localStorage.getItem('tc_autoupd') === '0' || autoCheckUpdate.done) return;
  autoCheckUpdate.done = true;
  setTimeout(() => checkUpdate(false), 3000);
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
    <div class="card" id="tsUpdCard"><h3>Обновление TorrServer MatriX</h3><div id="tsUpdBody" class="page-sub">Проверяю версию…</div></div>
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
  paintTsUpdate(false);
}
/* paintTsUpdate — текущая и последняя версия TorrServer и кнопка обновления.
   Скачивает и ставит демон; здесь только кнопка и ход процесса. */
let tsUpdPoll = null;
async function paintTsUpdate(force, body) {
  const el = $('#tsUpdBody'); if (!el) { clearTimeout(tsUpdPoll); return; }
  let j;
  try {
    j = await api('/api/tsupdate' + (force ? '?force=1' : ''), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  } catch (e) { el.innerHTML = html`<span class="err-text">${e.message}</span> <button id="tsUpdRetry">Проверить снова</button>`; const b = $('#tsUpdRetry'); if (b) b.onclick = () => paintTsUpdate(true); return; }
  const mb = n => (n / 1048576).toFixed(1) + ' МБ';
  const busy = j.state === 'downloading' || j.state === 'restarting';
  let line = 'Установлена: <b>' + (j.current ? esc(j.current) : 'не отвечает') + '</b> · последняя: <b>' + (j.latest ? esc(j.latest) : '—') + '</b>' + (j.size ? ' (' + mb(j.size) + ')' : '');
  let act = '';
  if (busy) act = esc(j.note || '') + (j.state === 'downloading' && j.total ? ' — ' + Math.round(100 * j.got / j.total) + '%' : '') + '…';
  else if (j.state === 'done') act = '✓ ' + esc(j.note || 'Обновлено');
  else if (j.state === 'failed') act = '<span class="err-text">Не удалось: ' + esc(j.note || '') + '</span>';
  let btn = '';
  if (!busy) {
    if (!j.local) btn = '<div>Активный сервер не на этом компьютере — обновите TorrServer там, где он установлен.</div>';
    else if (!j.found) btn = '<div>Файл TorrServer не найден рядом с программой — обновить можно только тот, что поставлен вместе с TorrClient.</div>';
    else if (j.newer) btn = '<button id="tsUpdGo" class="primary">Обновить до ' + esc(j.latest) + '</button>';
    else if (j.latest && j.current) btn = '<span>Установлена последняя версия.</span> <button id="tsUpdGo">Переустановить</button>';
  }
  el.innerHTML = line + (j.error ? '<div class="err-text">' + esc(j.error) + '</div>' : '') + (act ? '<div>' + act + '</div>' : '') + '<div class="row wrap" style="margin-top:6px">' + btn + ' <button id="tsUpdCheck" class="iconbtn" title="Проверить на GitHub">' + ico('refresh') + '</button></div>';
  const go = $('#tsUpdGo'); if (go) go.onclick = () => { if (confirm('TorrServer перезапустится — текущий просмотр прервётся. Обновить?')) paintTsUpdate(false, { action: 'install' }); };
  const ck = $('#tsUpdCheck'); if (ck) ck.onclick = () => paintTsUpdate(true);
  clearTimeout(tsUpdPoll);
  if (busy) tsUpdPoll = setTimeout(() => paintTsUpdate(false), 1000);
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
      <div><b>Папка программы:</b> <span class="mono">${state.hello.exe || '—'}</span></div>
      <div><b>Демон:</b> локальный компаньон на порту 8099</div>
      <div class="divider"></div>
      <div class="mono" style="white-space:pre-wrap">${JSON.stringify(state.hello, null, 2)}</div>
    </div>`;
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
      <button id="ssAuto" class="primary" title="Замерит скорость интернета и подберёт кэш, предзагрузку и число соединений">Автонастройка буфера</button>
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

  const auto = $('#ssAuto');
  if (auto) auto.addEventListener('click', async () => {
    auto.disabled = true; auto.textContent = 'Замеряю скорость…';
    try {
      const p = await api('/api/autobuffer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const txt = `Скорость ≈ ${Math.round(p.mbps)} Мбит/с — ${p.why}.\n\nКэш ${Math.round(p.CacheSize / 1048576)} МБ, предзагрузка ${p.PreloadCache}%, чтение вперёд ${p.ReaderReadAHead}%, соединений ${p.ConnectionsLimit}.\n\nПрименить?`;
      if (confirm(txt)) {
        await saveServerSets({ CacheSize: p.CacheSize, PreloadCache: p.PreloadCache, ReaderReadAHead: p.ReaderReadAHead, ConnectionsLimit: p.ConnectionsLimit });
        toast('Буфер настроен под ' + Math.round(p.mbps) + ' Мбит/с');
        renderServerPane(tab);
        return;
      }
    } catch (e) { toast(e.message, true); }
    auto.disabled = false; auto.textContent = 'Автонастройка буфера';
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
/* Закрывается верхнее окно, а не первое найденное: окна открываются друг из
   друга (например, «Инфо о раздаче» → выбор плеера), и прежде закрывалось то,
   что лежит ниже, — верхнее оставалось висеть поверх страницы. */
function closeModal() { const all = $$('body > .overlay'); if (all.length) all[all.length - 1].remove(); }

/* ---------- отчёт о состоянии ---------- */
/* Отчёт собирают, когда что-то уже сломалось, и разбираться будут не здесь, а
   там, куда его ушлют. Поэтому он обязан быть цельным: текст, а не «посмотрите
   в консоли». Копирование в буфер — основной путь, и оно сделано вручную через
   execCommand, потому что navigator.clipboard у file:// и wails.localhost
   недоступен без разрешения, а спрашивать его посреди поломки лишне. */
function diagFallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

async function showDiagnostics(btn) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Собираю…'; }
  let text = '';
  try {
    const r = await fetch('/api/diagnostics?format=text');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = old; }
    toast('Не удалось собрать отчёт: ' + e.message, true);
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = old; }

  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal diag">
    <h2>Отчёт о состоянии</h2>
    <p class="page-sub">Скопируйте и приложите к письму. Ключ TMDB и пароли серверов в отчёт не попадают.</p>
    <div class="mono diag-text">${text}</div>
    <div class="row" style="justify-content:flex-end;gap:8px">
      <button data-d="copy" class="primary">Скопировать</button>
      <button data-d="save">Сохранить файл</button>
      <button data-d="close">Закрыть</button>
    </div>
  </div>`;
  document.body.appendChild(ov);

  ov.querySelector('[data-d="copy"]').addEventListener('click', async () => {
    // Сначала пробуем современный буфер, и только потом запасной путь: первый
    // надёжнее, второй работает везде.
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
    if (!ok) ok = diagFallbackCopy(text);
    toast(ok ? 'Отчёт скопирован' : 'Не удалось скопировать — выделите текст вручную', !ok);
  });
  ov.querySelector('[data-d="save"]').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'torrclient-diagnostic-' + stamp + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Освобождение отложено: освобождать сразу — значит отменить скачивание в
    // некоторых браузерах, файл не успевает начать качаться.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  ov.querySelector('[data-d="close"]').addEventListener('click', () => ov.remove());
}


/* ---------- auto-open added hint ---------- */
document.addEventListener('DOMContentLoaded', () => { if (localStorage.getItem('tc_first') !== '1') { localStorage.setItem('tc_first', '1'); } });