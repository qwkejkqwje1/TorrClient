
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
  film: '<rect x="3" y="3.5" width="18" height="17" rx="2"/><path d="M7.5 3.5v17M16.5 3.5v17M3 8.5h4.5M3 15.5h4.5M16.5 8.5H21M16.5 15.5H21"/>',
};
function ico(name, size) {
  const s = size || 18;
  return `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* Разделы по группам. Порядок задаёт и Alt+1…Alt+0 (первые десять). */
const NAV_GROUPS = [
  { label: '', items: [['home', 'Главная', 'home'], ['library', 'Библиотека', 'grid'], ['search', 'Поиск', 'search']] },
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
