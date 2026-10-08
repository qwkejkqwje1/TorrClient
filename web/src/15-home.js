
/* ================= ГЛАВНАЯ =================
   Стартовый экран 2.0: всё, с чего обычно начинается вечер, — на одном
   экране и без поиска по разделам. Полосы появляются только тогда, когда им
   есть что показать: пустая полоса места не занимает. */
const homeState = { trend: null, trendAt: 0, trendErr: '', trendBusy: false };

function greeting() {
  const h = new Date().getHours();
  return h >= 5 && h < 12 ? 'Доброе утро' : h >= 12 && h < 17 ? 'Добрый день' : h >= 17 && h < 23 ? 'Добрый вечер' : 'Доброй ночи';
}

async function renderHome(root) {
  root.innerHTML = html`
    <section class="home-hero">
      <div class="hh-txt">
        <h1 class="hh-hello">${greeting()}</h1>
        <div class="hh-sum" id="homeSum">Собираю, что у вас есть…</div>
      </div>
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
    </section>
    <section class="rail hidden" id="railCont"></section>
    <section class="rail hidden" id="railNew"></section>
    <section class="rail hidden" id="railFav"></section>
    <section class="rail hidden" id="railTrend"></section>
    <section class="rail hidden" id="railRecent"></section>
    <div id="homeEmpty"></div>`;

  const q = $('#homeQ');
  $('#homeSearch').addEventListener('submit', e => { e.preventDefault(); const v = q.value.trim(); if (v) searchFor(v); else q.focus(); });
  $('#homeBest').addEventListener('click', () => { const v = q.value.trim(); if (!v) { q.focus(); toast('Введите название'); return; } pushSearchHistory(v); findBest(v, 0); });
  $$('[data-home]', root).forEach(b => b.addEventListener('click', () => homeGo(b.dataset.home)));
  root.addEventListener('click', onHomeClick);
  bindRailScroll(root);

  paintHome();
  const jobs = [];
  if (!(state.lib || []).length) jobs.push(loadLibrary(false).then(() => applyStoredMeta()).catch(() => {}));
  else jobs.push(loadPositions().catch(() => {}));
  jobs.push(loadSubs().catch(() => {}));
  await Promise.all(jobs);
  if (state.view !== 'home') return;
  paintHome();
  loadTrend().then(() => { if (state.view === 'home') paintTrend(); });
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

  paintRail('railCont', 'Продолжить просмотр', cont.length, cont.slice(0, 16).map(contBig).join(''), 'library', 'Библиотека', 'cw');
  paintRail('railNew', 'Новые серии по подпискам', newSubs.length, newSubs.map(newSubCard).join(''), 'subs', 'Все подписки', 'ns');
  paintRail('railFav', 'Избранное', favs.length, favs.slice(0, 18).map((f, i) => favMini(f, favs.length - 1 - i)).join(''), 'favorites', 'Всё избранное', 'pc');
  paintRail('railRecent', 'Недавно добавлено', recent.length, recent.map(recentMini).join(''), 'library', 'Вся библиотека', 'pc');
  paintTrend();

  const empty = $('#homeEmpty');
  if (empty) {
    const nothing = !n && !favs.length && !cont.length;
    empty.innerHTML = nothing ? html`<div class="home-empty">
      <div class="he-art">${raw(ico('film', 34))}</div>
      <h2>С чего начать</h2>
      <p>Найдите фильм в строке выше — TorrClient опросит трекеры и предложит лучшую раздачу. Или перетащите магнит либо .torrent прямо в окно.</p>
      <div class="row" style="justify-content:center"><button class="primary" data-home-add>${raw(ico('plus', 16))} Добавить торрент</button><button data-home="top2">${raw(ico('flame', 16))} Что свежего</button></div>
    </div>` : '';
  }
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
function trendMini(it, i) {
  return html`<div class="pcard disc-card" data-trend="${i}" tabindex="0" role="button" title="${it.title}">
    <div class="pc-poster disc-poster">${raw(posterImg(it.poster))}<span class="pc-ph">${raw(ico('film', 28))}</span><span class="pc-play">${raw(ico('star', 22))}</span>${raw(discFavHtml(it))}
      ${raw(it.rating ? html`<span class="chip rating pc-rate">${Number(it.rating).toFixed(1)}</span>` : '')}</div>
    <div class="pc-title">${it.title}</div>
    <div class="pc-sub">${it.kind === 'tv' ? 'Сериал' : 'Фильм'}${it.year ? ' · ' + String(it.year).slice(0, 4) : ''}</div>
  </div>`;
}

/* «Сейчас смотрят»: тренды TMDB за неделю — фильмы и сериалы вперемешку.
   Ответ помнится полчаса: Главную открывают часто, а тренды меняются медленно. */
async function loadTrend() {
  if (homeState.trendBusy || (homeState.trend && Date.now() - homeState.trendAt < 30 * 60000)) return;
  homeState.trendBusy = true;
  try {
    const [m, t] = await Promise.all(['movie', 'tv'].map(k => apiGetJSON('/api/discover?kind=' + k + '&cat=trending&origin=any&page=1').catch(e => ({ ok: false, error: e.message }))));
    const items = [];
    const a = (m && m.ok && m.items) || [], b = (t && t.ok && t.items) || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) items.push(a[i]); if (b[i]) items.push(b[i]); }
    homeState.trend = items.slice(0, 24); homeState.trendAt = Date.now();
    homeState.trendErr = items.length ? '' : ((m && m.error) || (t && t.error) || 'пустой ответ');
    if (homeState.trendErr) noteMetaError(homeState.trendErr);
  } finally { homeState.trendBusy = false; }
}
function paintTrend() {
  const el = $('#railTrend'); if (!el) return;
  const items = homeState.trend || [];
  if (items.length) { paintRail('railTrend', 'Сейчас смотрят', items.length, items.map(trendMini).join(''), '', '', 'pc'); return; }
  if (homeState.trendErr && metaErrText(homeState.trendErr)) {
    el.classList.remove('hidden');
    el.innerHTML = html`<div class="rail-h"><h2>Сейчас смотрят</h2></div><div class="note-card">${raw(ico('info', 18))}<div><b>Нужен ключ TMDB</b><div class="page-sub">С ним здесь появятся тренды недели, а в библиотеке — постеры и оценки. Ключ бесплатный.</div></div><button data-go="settings">Открыть настройки</button></div>`;
    return;
  }
  el.classList.add('hidden');
}

function onHomeClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) { setView(go.dataset.go); return; }
  const rs = e.target.closest('[data-rs]');
  if (rs) { const row = rs.parentElement.querySelector('.rail-row'); row.scrollBy({ left: Number(rs.dataset.rs) * row.clientWidth * 0.85, behavior: 'smooth' }); setTimeout(() => syncRailBtns(rs.closest('.rail')), 450); return; }
  if (e.target.closest('[data-home-add]')) { openAddModal(); return; }
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
    findBest(s.query || s.title, 0); return;
  }
  const fv = e.target.closest('.disc-fav');
  if (fv) { e.stopPropagation(); toggleDiscFav((homeState.trend || []).find(x => discFavKey(x) === fv.dataset.fk)); paintHome(); return; }
  const tr = e.target.closest('[data-trend]');
  if (tr) { const it = (homeState.trend || [])[+tr.dataset.trend]; if (it) findBest(it.title, it.year ? +String(it.year).slice(0, 4) : 0); return; }
  const fc = e.target.closest('[data-fav-ix]');
  if (fc) { const f = favList()[+fc.dataset.favIx]; if (!f) return; if (isTitleFav(f)) findBest(f.title, f.year ? +String(f.year).slice(0, 4) : 0); else playSearchLink(f); return; }
  const lc = e.target.closest('[data-lib-hash]');
  if (lc) { const t = (state.lib || []).find(x => x.hash === lc.dataset.libHash); if (t) watchNow(t); }
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || state.view !== 'home') return;
  const c = e.target.closest && e.target.closest('.pcard, .cw-card');
  if (c && e.target === c) { e.preventDefault(); c.click(); }
});
