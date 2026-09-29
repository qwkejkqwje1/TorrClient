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
      ${raw(r.poster ? html`<img src="${r.poster}" loading="lazy" onerror="this.remove();this.parentElement.querySelector('svg').classList.remove('hidden')">` : '')}
      <button class="play-ov" data-sa="play" title="Смотреть"><span class="tri"></span></button>
      <button class="fav-ov" data-sa="fav" title="В избранное">♥</button>
      <div class="badges">
        ${raw(q ? html`<span class="chip ${q}">${q === 'q2160' ? '4K' : '1080p'}</span>` : '')}
        ${raw(isSer ? '<span class="chip series">Сериал</span>' : '')}
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
function cleanSearchTitle(t) {
  let s0 = String(t || '');
  const ym = s0.match(/(19|20)\d{2}/);
  const year = ym ? ym[0] : '';
  const parts = s0.split('/').map(p => p.trim()).filter(Boolean);
  let pick = '';
  for (const p of parts) { if (/[а-яёЁ]/.test(p)) { pick = p; break; } }
  if (!pick) pick = parts[0] || s0;
  let s = pick;
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
  img.src = url;
}
// libRatings подтягивает постеры и оценки к плиткам библиотеки.
//
// Прежде запросы шли строго по одному, с паузой 60 мс на карточку: сорок плиток
// — это два с половиной секунды ожидания плюс сеть, а на большой библиотеке
// очередь не доходила до конца. Теперь запросы идут в несколько дорожек, а ответ
// на одно и то же название берётся один раз: в библиотеке оно встречается в
// разных качествах, и спрашивать его столько же раз незачем.
const LIB_RATINGS_MAX = 60;

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
      const rr = await fetch('/api/kinozal/add?url=' + encodeURIComponent(r.get || r.link), { method: 'POST' });
      const j = await rr.json();
      if (!rr.ok || !j.ok) throw new Error((j && j.error) || 'HTTP ' + rr.status);
      const hash = ((j.hash || '').match(/btih:([0-9a-fA-F]{40})/) || [null, j.hash || ''])[1].toLowerCase();
      if (hash) await playHashLoop(hash);
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
  ov.innerHTML = html`<img src="${p}" style="max-width:90vw; max-height:90vh; border-radius:10px" onclick="this.parentElement.remove()">`;
  document.body.appendChild(ov); ov.addEventListener('click', () => ov.remove());
}

