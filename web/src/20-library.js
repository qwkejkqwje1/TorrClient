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
  try { const rows = await api('/api/positions'); if (Array.isArray(rows)) { state.viewed = rows; invalidateMarks(); } }
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
        if (cur) { Object.assign(cur, s); cur.hasStat = true; }
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
  if (!list.length) { grid.innerHTML = ''; $('#libEmpty').classList.remove('hidden'); $('#libEmpty').textContent = libFiltered() ? 'Ничего не подошло под фильтр.' : 'Библиотека пуста. Добавьте магнит или .torrent.'; return; }
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
    const resume = v => {
      const f = fileOf(v);
      return f ? {
        t, f, kind: 'resume', pos: v.timecode, duration: v.duration || 0,
        share: v.duration > 0 ? Math.min(1, v.timecode / v.duration) : 0, updated: v.updated || 0,
      } : null;
    };
    const last = list[0];
    let it = null;
    if (!last.done && last.timecode > 0) it = resume(last);
    else if (last.done && fileOf(last)) {
      const vids = files.filter(x => isVideo(x.path));
      const nf = vids.length > 1 ? nextAfter(t, vids, fileOf(last)) : null;
      if (nf && !isWatched(t, nf.id)) {
        const pos = currentTc(t, nf.id) || 0;
        it = { t, f: nf, kind: pos > 0 ? 'resume' : 'next', pos, duration: 0, share: 0, updated: last.updated || 0 };
      }
    }
    // Последняя серия досмотрена, а следующей нет — но могла остаться начатая.
    if (!it) { const v = list.find(x => !x.done && x.timecode > 0); if (v) it = resume(v); }
    if (it) out.push(it);
  });
  return out.sort((a, b) => b.updated - a.updated);
}
function continueCard(it) {
  const title = it.t.title || it.t.name || it.t.hash;
  const next = it.kind === 'next';
  return html`
  <div class="cont-card${next ? ' is-next' : ''}" data-cont data-cont-hash="${it.t.hash}" data-cont-file="${it.f.id}">
    <div class="cont-top">
      ${raw(it.t.poster ? html`<img class="cont-poster" src="${it.t.poster}" loading="lazy" alt="" onerror="this.remove()">` : '')}
      <div class="cont-txt">
        <div class="cont-title" title="${title}">${title}</div>
        <div class="cont-sub">${next ? 'Дальше: ' : ''}${epLabel(it.f, it.t)}</div>
      </div>
    </div>
    <div class="cont-bar"><i style="width:${Math.round(it.share * 100)}%"></i></div>
    <div class="cont-foot">
      <span class="cont-pos">${next ? 'следующая серия' : fmtPos(it.pos) + (it.duration ? ' из ' + fmtPos(it.duration) : '')}</span>
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
      ${raw(t.poster ? html`<img src="${t.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
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
      ${raw(ser ? '<button data-act="subs">Следить за новыми сериями</button>' : '')}
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
const SERIES_RE = /\b[sс]\d{1,2}(?:\s*[eе]\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b|\bseason\b|\bepisodes?\b|sezon|сезон|сери[яий]|эпизод|\d{1,3}\s*(?:-\s*\d{1,3}\s*)?из\s*\d{1,3}/i;
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
