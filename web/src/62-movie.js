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
