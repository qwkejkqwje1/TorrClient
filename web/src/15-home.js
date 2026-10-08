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

  if (on('cont')) paintRail(railDomId('cont'), 'Продолжить просмотр', cont.length, cont.slice(0, 16).map(contBig).join(''), 'library', 'Библиотека', 'cw');
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
