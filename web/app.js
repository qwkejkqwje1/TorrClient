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
  query: '', category: 'all', searchState: { loading: false, results: [], provider: savedPref('tc_prov', ['rutor', 'torznab', 'kinozal', 'both'], 'rutor'), cat: savedPref('tc_cat', null, ''), q: '' },
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
// ── Этап 6: тема, горячие клавиши, скелетоны ──
// Темы — только наборы цветов (переменные CSS), переключение мгновенное.
// sw — образец для выбора в настройках: фон, панель, акцент, второй акцент.
const THEME_LIST = [
  { id: 'dark', name: 'Тёмная', tone: 'dark', sw: ['#0e131a', '#1c2532', '#4f8cff', '#7ce08a'] },
  { id: 'light', name: 'Светлая', tone: 'light', sw: ['#f3f5f9', '#ffffff', '#2f6fe6', '#1f9d45'] },
  { id: 'system', name: 'Как в системе', tone: 'auto', sw: ['#0e131a', '#f3f5f9', '#4f8cff', '#2f6fe6'] },
  { id: 'oled', name: 'Чёрная (OLED)', tone: 'dark', sw: ['#000000', '#161616', '#4f8cff', '#7ce08a'] },
  { id: 'nord', name: 'Северная', tone: 'dark', sw: ['#2e3440', '#434c5e', '#88c0d0', '#a3be8c'] },
  { id: 'dracula', name: 'Дракула', tone: 'dark', sw: ['#1e1f29', '#343746', '#bd93f9', '#50fa7b'] },
  { id: 'forest', name: 'Лес', tone: 'dark', sw: ['#0f1712', '#1e2d23', '#4caf7a', '#b5e06a'] },
  { id: 'sepia', name: 'Сепия', tone: 'light', sw: ['#f4ecdc', '#eadfc8', '#a0602a', '#5f8a3a'] },
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

const NAV_KEYS = ['library', 'search', 'favorites', 'bookmarks', 'players', 'series', 'subs', 'downloads', 'settings', 'server'];
const NAV_LABELS = { library: 'Библиотека', search: 'Поиск', favorites: 'Избранное', bookmarks: 'Закладки', players: 'Плееры', series: 'Сериалы', subs: 'Подписки', downloads: 'Загрузки', settings: 'Настройки', server: 'Сервер' };
function showKeys() {
  const rows = [['/ или Ctrl+K', 'перейти к поиску'], ['T', 'сменить тему'], ['R', 'обновить раздел'], ['Esc в поле', 'очистить поле'], ['Alt+1 … Alt+0', 'разделы по порядку'], ['Esc', 'закрыть окно'], ['?', 'этот список']];
  const nav = NAV_KEYS.map((k, i) => `Alt+${(i + 1) % 10} — ${NAV_LABELS[k]}`).join(' · ');
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="modal" style="max-width:520px"><h3>Горячие клавиши</h3><table class="keys-table">${rows.map(([k, d]) => `<tr><td><span class="kbd">${k}</span></td><td>${d}</td></tr>`).join('')}</table><p class="page-sub">${nav}</p><div class="row"><button class="primary" id="keysOk">Понятно</button></div></div>`;
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); return; }
  if (e.altKey && !e.ctrlKey && /^[0-9]$/.test(e.key)) {
    const k = NAV_KEYS[(+e.key + 9) % 10]; if (k) { e.preventDefault(); setView(k); } return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('body > .overlay')) return;
  if (e.key === '/') { e.preventDefault(); focusSearch(); }
  else if (e.key === '?') { e.preventDefault(); showKeys(); }
  else if (e.key === 't' || e.key === 'T' || e.key === 'е' || e.key === 'Е') cycleTheme();
  else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') refreshView();
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
  eventsSrc.addEventListener('sleep', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch (err) { return; }
    sleepEvent(d);
  });
  // Подписка проверена (например, только что заведённая) — перечитать список.
  eventsSrc.addEventListener('subs_changed', () => {
    loadSubs().then(() => { if (state.view === 'subs') paintSubsBody(); }).catch(() => {});
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
  invalidateMarks();

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

function setView(v) {
  state.view = v;
  try { localStorage.setItem(LS.view, v); } catch {}
  $$('#nav [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  route();
}
function route() {
  const v = state.view;
  // Модальные окна живут прямо в document.body, а не внутри <main>, и переход
  // по навигации оставлял их поверх чужой страницы: окно «Изменить торрент»
  // продолжало висеть над «Настройками», а закрыть его было нечем, кроме Esc.
  $$('body > .overlay:not(.whatsnew-ov)').forEach(o => o.remove());
  const pages = { library: renderLibrary, search: renderSearch, favorites: renderFavorites, bookmarks: renderBookmarks, players: renderPlayers, downloads: renderDownloads, series: renderSeries, subs: renderSubs, settings: renderSettings, server: renderServer };
  const fn = pages[v] || renderLibrary;
  const main = $('main'); main.innerHTML = '';
  // Крестики в полях ставятся и сразу, и после асинхронной отрисовки.
  Promise.resolve(fn(main)).finally(() => addClears(main));
  addClears(main);
}
function hookNav() {
  $('#nav').innerHTML = [
    ['library', 'Библиотека'], ['search', 'Поиск'], ['favorites', 'Избранное'], ['bookmarks', 'Закладки'], ['players', 'Плееры'],
    ['series', 'Сериалы'], ['subs', 'Подписки'], ['downloads', 'Загрузки'], ['settings', 'Настройки'], ['server', 'Сервер'],
  ].map(([k, n]) => `<button data-view="${k}" class="${state.view === k ? 'on' : ''}">${n}</button>`).join('');
  $$('#nav [data-view]').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.ctxmenu').forEach(m => m.classList.add('hidden')); setView(b.dataset.view); }));
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
  if (!Array.isArray(arr)) { try { arr = await tsJson('/torrents', { action: 'list' }); } catch (e) { arr = null; } }
  // Сервер не ответил — это ошибка, а не пустая библиотека: после запуска
  // TorrServer поднимается не сразу, и пустой список прежде оставался на
  // экране до ручного обновления.
  if (!Array.isArray(arr)) throw new Error('TorrServer не отвечает');
  return arr;
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
        <option value="progress">По просмотру</option>
      </select>
      <select id="libSeen" style="width:auto" title="Что показать по просмотру">
        <option value="all">Любой просмотр</option>
        <option value="new">Не начато</option>
        <option value="started">Начато</option>
        <option value="done">Досмотрено</option>
      </select>
      <select id="libColl" style="width:auto" title="Подборка"></select>
      <button id="collNew" class="iconbtn" title="Новая подборка">＋</button>
      <button id="libReset" class="iconbtn hidden" title="Сбросить фильтры">✕</button>
      <button data-act="refresh" class="iconbtn" title="Обновить">⟳</button>
      <button id="libRec" title="Фильмы и сериалы, похожие на те, что в библиотеке (нужен ключ TMDB)">✨ Рекомендации</button>
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
const libRetry = { timer: 0, n: 0 };
async function loadLibrary(paint) {
  try { state.lib = await listTorrents(); state.libError = ''; libRetry.n = 0; }
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
  return out.sort((a, b) => b.updated - a.updated);
}
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
    if (!it.f.unknown) { playSelected(it.t, it.f); return; }
    // Файлы раздачи ещё не известны — сначала спрашиваем их у TorrServer.
    waitForFiles(it.t).then(st => {
      const f = st && (st.file_stats || []).find(x => x.id === it.f.id);
      if (f) playSelected(Object.assign(it.t, { file_stats: st.file_stats }), f);
      else if (st) toast('Файл не найден в раздаче', true);
    });
  });
}

function tile(t) {
  const hasMedia = (t.file_stats || []).some(f => isPlayable(f.path));
  const loaded = t.torrent_size ? (t.bytes_read || 0) / t.torrent_size : 0;
  const sp = seriesProgress(t);
  const q = qTag(t.title || t.name || '');
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
  const pg = hasMedia ? `<div class="progress"${sp ? ` title="просмотрено ${sp.done} из ${sp.total}"` : ''}><i style="width:${Math.min(100, (sp ? sp.share : loaded) * 100).toFixed(0)}%"></i></div>` : '';
  const pgNote = sp ? `<div class="page-sub">просмотрено ${sp.done} из ${sp.total}${sp.started ? ' · начато ' + sp.started : ''}</div>` : '';
  return html`
  <div class="tile" data-hash="${t.hash}">
    <div class="poster">
      ${raw(PH_SVG.replace('class="ph"', 'class="ph ' + (t.poster ? 'hidden' : '') + '"'))}
      ${raw(t.poster ? html`<img src="${pimg(t.poster)}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-act="watch" title="Смотреть"><span class="tri"></span></button>
      <div class="badges">
        ${raw(q ? html`<span class="chip ${q}">${q === 'q2160' ? '4K' : '1080p'}</span>` : '')}
        ${raw(ser ? html`<span class="chip series">${seriesTag(t.title || t.name || '')}</span>` : '')}
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
        <span class="mb-stats">${raw(metaBits.map(esc).join(' &nbsp;·&nbsp; ') || '—')}</span>
      </div>
      <button class="menu-ico" data-menu title="Ещё">⋮</button>
    </div>
    <div class="ctxmenu hidden">
      <button data-act="info">Инфо о раздаче</button>
      <button data-act="edit">Изменить</button>
      <button data-act="autoposter">Подгрузить постер (TMDB)</button>
      ${raw(multi ? '<button data-act="subs">Следить за новыми сериями</button>' : '')}
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
  const seeds = Math.max(0, Number(r && r.seed) || 0);
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
  const seedPts = Math.min(15, Math.round(5 * Math.log10(seeds + 1)));
  if (!seeds) out.notes.push('нет сидов');

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
  if (!seeds) score = Math.min(score, 30);
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
    // Подписка ведётся по названию сериала, а не по раздаче: сезон выходит
    // новыми раздачами, и следить за одной из них нечем.
    act('[data-act="subs"]', () => subsAdd(subsName(t.title || t.name || '')));
    act('[data-act="bm"]', () => { const f = firstPlayable(t); if (!f) return toast('Нет воспроизводимых файлов', true); addBookmark(t, f.id, basename(f.path)); });
    act('[data-act="coll"]', () => openCollectionPicker(t));
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
    if (typeof confirm === 'function' && !confirm('Удалить подборку «' + c.name + '»? Раздачи останутся в библиотеке.')) return;
    collRemove(b.dataset.cdel);
    fillCollSelect($('#libColl'), state.coll);
    close();
    paintLibrary();
    toast('Подборка удалена');
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
      ${raw(it.poster ? html`<img src="${pimg(it.poster)}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
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
    <div class="page-sub">Позиции, которые плееры не запоминают. Сохраняются в карточке торрента («⋮ → Закладка») или в окне «Инфо».</div>
    <span class="spacer"></span>
    <button id="bmClear" class="danger">Очистить</button></div>
    <div id="bmBody"></div>`;
  $('#bmClear').addEventListener('click', () => { if (list.length && confirm('Удалить все закладки?')) { saveBookmarks([]); renderBookmarks($('main')); } });
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
      ${raw(b.poster ? html`<img src="${pimg(b.poster)}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
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
const SRC_PAGE = { rutor: 100, kinozal: 50, torznab: 100, popular: 1 };
function hasMore() {
  return Object.entries(moreSources).some(([p, s]) => s.count >= (SRC_PAGE[p] || 0));
}

async function renderSearch(root) {
  const sd = state.searchState;
  const hist = searchHistory();
  root.innerHTML = html`
    <div class="toolbar">
      <h1 class="page-title">Поиск</h1>
      <input class="search-input" id="searchInput" list="searchHistList" autocomplete="off" placeholder="Название фильма или сериала..." title="/ или Ctrl+K — сюда, ? — все клавиши" value="${sd.q}">
      <datalist id="searchHistList">${raw(searchHistoryAll().map(h => html`<option value="${h}">`).join(''))}</datalist>
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
      <button id="bestBtn" title="Опросить все источники и выбрать лучшую раздачу по запросу">★ Лучшая</button>
      <button id="popBtn" class="top24btn" title="Раздачи выбранной категории rutor за всё время, по числу сидов">Популярное</button>
      <button id="recBtn" title="Похожее на фильмы и сериалы из вашей библиотеки (нужен ключ TMDB)">✨ Для вас</button>
      <span class="spacer"></span>
      <button class="primary" data-open="add" title="Добавить торрент">+ Добавить</button>
    </div>
    <div class="quick">
      <span class="qlabel">Быстро:</span>
      ${raw(CATS.filter(c => c.v).slice(0, 5).map(c => html`<button data-cat="${c.v}">${c.label}</button>`).join(''))}
      <span class="spacer"></span>
      <label style="margin:0;display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:12px"><input type="checkbox" id="searchAppend"> добавить к текущим</label>
    </div>
    ${raw(hist.length ? html`<div class="quick"><span class="qlabel">История:</span>${raw(hist.map(h => html`<span class="hq-chip"><button data-hq="${h}">${h}</button><button class="hq-x" data-hqx="${h}" title="Удалить из истории">×</button></span>`).join(''))}<button id="hqClear" class="hq-x" title="Очистить историю">очистить</button></div>` : '')}
    <div class="quick" id="discBar">
      <span class="qlabel">Топ за всё время:</span>
      <select id="dKind" style="width:auto"><option value="trending">🔥 Сейчас смотрят (неделя)</option><option value="trending_day">🔥 Сейчас смотрят (сегодня)</option><option value="movie" selected>Фильмы</option><option value="tv">Сериалы</option><option value="anime">Аниме</option><option value="cartoon">Мультфильмы</option><option value="doc">Документальное</option></select>
      <select id="dOrigin" style="width:auto"><option value="foreign">Зарубежное</option><option value="any">Любое</option><option value="ru">Русское</option></select>
      <select id="dGenre" style="width:auto"></select>
      <button id="dGo" title="Самое популярное по числу голосов TMDB. Нужен ключ TMDB">Показать</button>
    </div>
    <div id="searchResults"></div>`;

  initDiscoverBar();
  $('#searchProv').value = sd.provider;
  $('#searchCat').value = sd.cat || '';
  $('#searchQual').value = qualOn();
  $('#searchBtn').addEventListener('click', () => doSearch());
  $('#recBtn').addEventListener('click', () => showRecommendations());
  $('#bestBtn').addEventListener('click', () => { const q = $('#searchInput').value.trim(); if (q) { pushSearchHistory(q); findBest(q, 0); } else toast('Введите название'); });
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
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
  $('[data-open="add"]').addEventListener('click', openAddModal);
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
  if (resp.source === 'indexers') toast('rutor не ответил — ТОП собран через индексаторы по трендам дня');
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
  sd().showAnyQual = false; // и снова применяет выбранное качество
  sd().exclude = parts.drop; // «ведьмак -игра» отсекает игру по названию
  state.searchState.results = sd().append ? state.searchState.results : [];
  moreSources = {};
  if (prov === 'rutor' || prov === 'both') moreSources.rutor = { query: q, page: 0, count: 0, cat };
  if (prov === 'torznab' || prov === 'both') moreSources.torznab = { query: q, page: 0, count: 0, cat: 0 };
  if (prov === 'kinozal' || prov === 'both') moreSources.kinozal = { query: q, page: 0, count: 0, cat: 0 };
  paintResults($('#searchResults'));
  const el = $('#searchResults');
  el.innerHTML = skeleton('Поиск…');
  state.searchState.tznabOff = null;
  const jobs = [];
  const errs = [];
  const add = (p, promise) => jobs.push(promise.catch(e => {
    /* Torznab разбирает источники построчно, и причина там длиннее одной
       строки всплывающей подсказки, поэтому она уходит в разбор под списком,
       а не в toast. Для остальных источников поведение прежнее. */
    if (p === 'torznab') { state.searchState.tznabOff = 'Torznab: ' + e.message; return; }
    errs.push(p + ': ' + e.message);
    toast(p + ': ' + e.message, true);
  }).then(r => {
    if (r && r.length) { state.searchState.results = mergeResults(state.searchState.results, r); }
    else if (p !== 'torznab') errs.push(p + ': 0 результатов');
  }));
  if (moreSources.rutor) add('rutor', searchRutor(q, 0, cat).then(r => { moreSources.rutor.count = r.length; return r; }));
  if (prov === 'torznab' || prov === 'both') add('torznab', searchTorznabStream(q, el).then(n => { moreSources.torznab.count = n; return []; }));
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

// searchTorznabStream ищет по всем индексаторам сразу и рисует выдачу по мере
// ответов: медленный индексатор больше не задерживает быстрые. Возвращает число
// полученных раздач (нужно для «Показать ещё»). Поток читается вручную:
// EventSource не умеет обрывать запрос при смене вкладки.
async function searchTorznabStream(q, el) {
  const ss = state.searchState;
  const r = await fetch('/api/torznab/stream?query=' + encodeURIComponent(q));
  if (!r.ok || !r.body) {
    let body = null;
    try { body = await r.json(); } catch { /* не JSON */ }
    ss.tznabOff = 'Torznab: ' + ((body && body.error) || ('HTTP ' + r.status));
    return 0;
  }
  const bad = [];
  let total = 0;
  const onEvent = (name, data) => {
    if (name !== 'source' || !data) return;
    const rep = data.source || {};
    if (!rep.ok && rep.error) bad.push((rep.name || '?') + ' — ' + rep.error);
    const items = (data.items || []).map(mapTorznab);
    if (!items.length) return;
    total += items.length;
    ss.results = mergeResults(ss.results, items);
    ss.tznabOff = bad.length ? 'Индексатор не ответил: ' + bad.join('; ') : null;
    paintResults(el);
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
  if (bad.length) ss.tznabOff = 'Индексатор не ответил: ' + bad.join('; ');
  else if (!total) ss.tznabOff = null;
  return total;
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
      <div class="disc-poster">${raw(it.poster ? html`<img loading="lazy" src="${pimg(it.poster)}" alt="">` : '')}</div>
      <div class="disc-title">${it.title}</div>
      <div class="disc-meta">${it.kind === 'tv' ? 'Сериал · ' : ''}${it.year || ''}${it.rating ? ' · ★ ' + it.rating.toFixed(1) : ''}</div>
    </div>`).join('');
  el.innerHTML = html`<div class="disc-head">${discState.params && isTrending(discState.params.kind) ? (discState.params.kind === 'trending_day' ? 'Сейчас смотрят — тренды дня' : 'Сейчас смотрят — тренды недели') : 'Популярное за всё время'} (${discState.items.length})</div>
    <div class="disc-grid">${raw(cards)}</div>
    ${raw(discState.hasMore ? '<div style="text-align:center;margin:14px"><button id="discMore" class="primary">Показать ещё</button></div>' : '')}`;
  $$('.disc-card').forEach(c => c.addEventListener('click', () => {
    const it = discState.items[+c.dataset.di];
    if (!it) return;
    findBest(it.title, it.year ? +String(it.year).slice(0, 4) : 0);
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
      ${raw(r.poster ? html`<img src="${pimg(r.poster)}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-sa="play" title="Смотреть"><span class="tri"></span></button>
      <button class="fav-ov" data-sa="fav" title="В избранное">♥</button>
      <div class="badges">
        ${raw(q ? html`<span class="chip ${q}">${q === 'q2160' ? '4K' : '1080p'}</span>` : '')}
        ${raw(isSer ? html`<span class="chip series">${seriesTag(title)}</span>` : '')}
        <span class="chip rq rq-${rq.tier}" title="${rateTip(rq)}">${rq.score}${rq.ru ? ' · RU' : ''}</span>
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
        <button class="rec-x" data-hide="${it.kind + ':' + it.id}" title="Не показывать">✕</button></div>
      <div class="disc-title">${it.title}</div>
      <div class="disc-meta">${it.kind === 'tv' ? 'Сериал · ' : ''}${it.year || ''}${it.rating ? ' · ★ ' + it.rating.toFixed(1) : ''}</div>
      ${raw((it.because || []).length ? html`<div class="rec-why">Похоже на: ${it.because.join(', ')}</div>` : '')}
    </div>`).join('');
  el.innerHTML = html`<div class="disc-head">Рекомендации по библиотеке (${list.length}) <span class="page-sub" style="font-weight:400">— по ${recState.matched} из ${recState.seeds} названий, найденных в TMDB</span></div>
    <div class="disc-grid">${raw(cards)}</div>`;
  el.querySelector('.disc-grid').addEventListener('click', e => {
    const x = e.target.closest('[data-hide]');
    if (x) { e.stopPropagation(); recHide(x.dataset.hide); paintRecommendations(el); return; }
    const c = e.target.closest('[data-rk]'); if (!c) return;
    const it = recState.items.find(i => i.kind + ':' + i.id === c.dataset.rk);
    if (it) findBest(it.title, it.year ? +String(it.year).slice(0, 4) : 0);
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
  ov.innerHTML = html`<div class="modal" style="max-width:720px"><h3>Лучшая раздача: ${q}${year ? ' (' + year + ')' : ''}</h3><div id="bestBody">${raw(skeleton('Опрашиваю rutor, Кинозал и Torznab…', 3))}</div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  const body = ov.querySelector('#bestBody');
  const jobs = [['rutor', () => searchRutor(q, 0, 0)], ['kinozal', () => searchKinozal(q, 0)], ['torznab', () => searchTorznab(q, 0)]];
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
      <button data-hide title="Скрыть">✕</button></div>
    <div class="dlpanel-sub" data-sub>${epSuffix(f).replace(/^ — /, '') || basename(f.path)}</div>
    <div class="prep-bar"><i data-bar></i></div>
    <div class="prep-stats"><span data-st="stage">—</span>${raw(PREP_STAT_SPANS.map(k => '<span data-st="' + k + '">—</span>').join(''))}</div>
    <div class="prep-hint" data-hint></div>
    <div class="prep-next hidden" data-nextbox></div>`;
  document.body.appendChild(ov);
  const el = s => ov.querySelector(s);
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
  const btn = $('#nav [data-view="subs"]');
  if (!btn) return;
  const n = subsNewTotal();
  btn.textContent = n ? 'Подписки (' + n + ')' : 'Подписки';
  btn.classList.toggle('hasnew', n > 0);
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
      <div class="page-sub">Раз в полчаса приложение ищет новые серии на rutor и в подключённых индексаторах — сериалы, аниме и мультсериалы. С ключом TMDB оно знает и дату выхода следующей серии. О находке сообщит уведомлением.</div></div>
      <input class="search-input" id="subNew" placeholder="Название сериала или запрос для трекера...">
      <button id="subAdd" class="primary">＋ Следить</button>
      <button id="subCheck" class="iconbtn" title="Проверить трекер сейчас">⟳</button>
    </div>
    <div id="subBody"><div class="empty">Загрузка подписок...</div></div>`;
  const add = () => { const inp = $('#subNew'); subsAdd(inp.value).then(() => { inp.value = ''; }); };
  $('#subAdd').addEventListener('click', add);
  $('#subNew').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  $('#subCheck').addEventListener('click', subsCheck);
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
  // Системное уведомление — когда окно свёрнуто, тост не увидеть.
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('TorrClient', { body: msg });
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
      ${raw(head.poster ? html`<img src="${head.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
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
  el.innerHTML = line + (j.error ? '<div class="err-text">' + esc(j.error) + '</div>' : '') + (act ? '<div>' + act + '</div>' : '') + '<div class="row wrap" style="margin-top:6px">' + btn + ' <button id="tsUpdCheck" class="iconbtn" title="Проверить на GitHub">⟳</button></div>';
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