function renderSubs(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Подписки на сериалы</h1>
      <div class="page-sub">Демон сам спрашивает трекер о новых сериях и сообщает о них в живую ленту — проверять руками ничего не надо.</div></div>
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
  toast('Новые серии: ' + (d.title || '') + where);
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
      <button data-subseries="${cleanSeriesName(head.title)}" title="Демон сам сообщит о новых сериях">Следить</button></div>
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
