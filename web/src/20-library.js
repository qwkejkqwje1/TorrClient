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
        ${raw(lq.q.res || lq.q.source ? html`<span class="chip rq rq-${lq.q.tier}" title="${lq.tip}">${lq.q.score}${lq.q.ru ? ' · RU' : ''}</span>` : '')}
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
