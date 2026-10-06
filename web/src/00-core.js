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

