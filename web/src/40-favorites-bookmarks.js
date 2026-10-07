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
  $('#favClear').addEventListener('click', () => { if (list.length && confirm('Очистить весь список избранного?')) { saveFavList([]); renderFavorites($('main')); } });
  const body = $('#favBody');
  if (!list.length) { body.innerHTML = '<div class="empty">Пусто. Нажмите ♥ на карточке в «Сейчас смотрят» или «⋮ → В избранное» в результатах поиска.</div>'; return; }
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
      ${raw(it.poster ? html`<img src="${pimg(it.poster)}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
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
      <button class="menu-ico" data-menu title="Ещё">⋮</button>
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
  act('[data-fa="play"]', () => { if (isTitleFav(it)) findBest(it.title, it.year ? +String(it.year).slice(0, 4) : 0); else playSearchLink(it); });
  act('[data-fa="magnet"]', () => copyToClip(it.magnet || magnetFromHash(it.hash, it.title), 'Магнит скопирован'));
  act('[data-fa="kp"]', () => openExternal(kpSearchUrl(it.title || '')));
  act('[data-fa="imdb"]', () => openExternal(imdbUrlFor(it)));
  act('[data-fa="trailer"]', () => openTrailer(it));
  act('[data-fa="del"]', () => { saveFavList(favList().filter(x => !favSame(x, it))); toast('Удалено из избранного'); renderFavorites($('main')); });
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

