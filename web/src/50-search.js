async function renderSearch(root) {
  const sd = state.searchState;
  const hist = searchHistory();
  root.innerHTML = html`
    <div class="toolbar">
      <h1 class="page-title">Поиск</h1>
      <input class="search-input" id="searchInput" list="searchHistList" autocomplete="off" placeholder="Название фильма или сериала..." title="/ или Ctrl+K — сюда, ? — все клавиши" value="${sd.q}">
      <datalist id="searchHistList">${raw(searchHistoryAll().map(h => html`<option value="${h}">`).join(''))}</datalist>
      <button id="searchBtn" class="primary">Найти</button>
      <select id="searchCat" title="Категория" style="width:auto">
        ${raw(CATS.map(c => html`<option value="${c.v}">${c.label}</option>`).join(''))}
      </select>
      <select id="searchQual" title="Качество раздачи" style="width:auto">
        ${raw(Object.entries(QUAL).map(([v, q]) => html`<option value="${v}">${q.label}</option>`).join(''))}
      </select>
      <label style="margin:0;display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:12px" title="Прятать из выдачи игры, софт и книги"><input type="checkbox" id="searchVid"> только видео</label>
      <select id="searchProv" title="Источник" style="width:auto">
        <option value="rutor">rutor</option>
        <option value="torznab">Torznab</option>
        <option value="kinozal">Кинозал.ТВ</option>
        <option value="both">Все источники</option>
      </select>
      <button id="top24Btn" class="top24btn">ТОП-24</button>
      <button id="bestBtn" title="Опросить все источники и выбрать лучшую раздачу по запросу">★ Лучшая</button>
      <button id="popBtn" class="top24btn" title="Раздачи выбранной категории за всё время, по числу сидов (rutor или индексаторы)">Популярное</button>
      <button id="recBtn" title="Похожее на фильмы и сериалы из вашей библиотеки (нужен ключ TMDB)">✨ Для вас</button>
      <span class="spacer"></span>
      <button class="primary" data-open="add" title="Добавить торрент">+ Добавить</button>
    </div>
    <div class="quick">
      <span class="qlabel">Быстро:</span>
      ${raw(CATS.filter(c => c.v).slice(0, 5).map(c => html`<button data-cat="${c.v}">${c.label}</button>`).join(''))}
      <span class="spacer"></span>
      <label style="margin:0;display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:12px"><input type="checkbox" id="searchAppend"> добавить к текущим</label>
    </div>
    ${raw(hist.length ? html`<div class="quick"><span class="qlabel">История:</span>${raw(hist.map(h => html`<span class="hq-chip"><button data-hq="${h}">${h}</button><button class="hq-x" data-hqx="${h}" title="Удалить из истории">×</button></span>`).join(''))}<button id="hqClear" class="hq-x" title="Очистить историю">очистить</button></div>` : '')}
    <div class="quick" id="discBar">
      <span class="qlabel">Топ за всё время:</span>
      <select id="dKind" style="width:auto"><option value="trending">🔥 Сейчас смотрят (неделя)</option><option value="trending_day">🔥 Сейчас смотрят (сегодня)</option><option value="movie" selected>Фильмы</option><option value="tv">Сериалы</option><option value="anime">Аниме</option><option value="cartoon">Мультфильмы</option><option value="doc">Документальное</option></select>
      <select id="dOrigin" style="width:auto"><option value="foreign">Зарубежное</option><option value="any">Любое</option><option value="ru">Русское</option></select>
      <select id="dGenre" style="width:auto"></select>
      <button id="dGo" title="Самое популярное по числу голосов TMDB. Нужен ключ TMDB">Показать</button>
    </div>
    <div id="searchResults"></div>`;

  initDiscoverBar();
  $('#searchProv').value = sd.provider;
  loadRutorFlag();
  $('#searchCat').value = sd.cat || '';
  $('#searchQual').value = qualOn();
  $('#searchBtn').addEventListener('click', () => doSearch());
  $('#recBtn').addEventListener('click', () => showRecommendations());
  $('#bestBtn').addEventListener('click', () => { const q = $('#searchInput').value.trim(); if (q) { pushSearchHistory(q); findBest(q, 0); } else toast('Введите название'); });
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  // Источник и категория запоминаются: после перезапуска поиск шёл снова по
  // rutor, и выбор «Все источники» приходилось делать каждый раз.
  $('#searchProv').addEventListener('change', () => { sd.provider = $('#searchProv').value; savePref('tc_prov', sd.provider); });
  $('#searchCat').addEventListener('change', () => { sd.cat = $('#searchCat').value; savePref('tc_cat', sd.cat); sd.showAll = false; updateTopBtnLabel(); paintResults($('#searchResults')); });
  $('#searchQual').addEventListener('change', () => { setQual($('#searchQual').value); state.searchState.showAnyQual = false; paintResults($('#searchResults')); });
  const vidBox = $('#searchVid');
  if (vidBox) {
    vidBox.checked = videoOnlyPref();
    vidBox.addEventListener('change', () => {
      setVideoOnlyPref(vidBox.checked);
      state.searchState.showAll = false; // настройка важнее разового «показать всё»
      paintResults($('#searchResults'));
    });
  }
  $$('[data-cat]').forEach(b => b.addEventListener('click', () => {
    $('#searchCat').value = b.dataset.cat;
    savePref('tc_cat', b.dataset.cat);
    sd.cat = b.dataset.cat;
    updateTopBtnLabel();
    doSearch();
  }));
  $$('[data-hq]').forEach(b => b.addEventListener('click', () => { $('#searchInput').value = b.dataset.hq; doSearch(); }));
  $$('[data-hqx]').forEach(b => b.addEventListener('click', () => { dropSearchHistory(b.dataset.hqx); const c = b.closest('.hq-chip'); if (c) c.remove(); }));
  { const c = $('#hqClear'); if (c) c.addEventListener('click', () => { saveSearchHistory([]); const q = c.closest('.quick'); if (q) q.remove(); }); }
  $('#top24Btn').addEventListener('click', onTopClick);
  $('#popBtn').addEventListener('click', () => fetchPopular());
  $('[data-open="add"]').addEventListener('click', openAddModal);
  updateTopBtnLabel();
  paintResults($('#searchResults'));
  // Раздел открыт ради рекомендаций — ТОП-24 не загружается поверх них.
  if (state.skipAutoTop) state.skipAutoTop = false;
  else if (!state.searchState.results.length && !sd.q) onTopClick();
}

// Категории поиска.
//
// Ключ — значение выпадающего списка, оно же имя раздела для топа Кинозала.
// Рядом стоит код категории rutor: у трекера категория это поле адреса выдачи,
// а не слово запроса. Коды сняты с <select name="category"> на живой странице
// 20.09.2026 и проверены запросами (8 — игры, 1 — зарубежные фильмы,
// 11 — книги).
const CATS = [
  { v: '', rutor: 0, top: '', label: 'Все категории' },
  { v: 'фильм', rutor: 1, top: 'kino', label: 'Зарубежные фильмы' },
  { v: 'нашфильм', rutor: 5, top: 'kino', label: 'Наши фильмы' },
  { v: 'сериал', rutor: 4, top: 'seriali', label: 'Зарубежные сериалы' },
  { v: 'нашесериал', rutor: 16, top: 'seriali', label: 'Наши сериалы' },
  { v: 'мультфильм', rutor: 7, top: 'multiki', label: 'Мультфильмы' },
  { v: 'аниме', rutor: 10, top: 'anime', label: 'Аниме' },
  { v: 'музыка', rutor: 2, top: 'audio', label: 'Музыка' },
  { v: 'софт', rutor: 9, top: 'soft', label: 'Софт' },
  { v: 'игры', rutor: 8, top: '', label: 'Игры' },
  { v: 'книги', rutor: 11, top: '', label: 'Книги' },
];
const TOPCAT = Object.fromEntries(CATS.map(c => [c.v, { sec: c.top, label: c.label }]));
function topSel() {
  const el = $('#searchCat');
  return TOPCAT[el ? el.value : ''] || TOPCAT[''];
}
// rutorCat переводит значение списка в код категории, понятный трекеру.
function rutorCat() {
  const el = $('#searchCat');
  const c = CATS.find(x => x.v === (el ? el.value : ''));
  return c ? c.rutor : 0;
}
function updateTopBtnLabel() {
  const b = $('#top24Btn'); if (!b) return;
  if (b.disabled) { b.textContent = 'Загрузка...'; return; }
  const t = topSel();
  b.textContent = t.sec ? 'ТОП-24: ' + t.label : 'ТОП-24';
}

// Фильтр качества раздачи.
//
// Прежде рядом стояли кнопки «1080p» и «2160p», которые дописывали в запрос
// «!1080» и «!2160». Такого оператора у rutor нет: запрос уходил фразой целиком,
// и выдача была пустой всегда. Качество отбирается здесь, по названию раздачи.
const QUAL = {
  '': { label: 'Любое качество', ok: () => true },
  'fhd': { label: '1080p и выше', ok: t => isFullHD(t) },
  '4k': { label: '4K', ok: t => /(2160|4k|uhd)/i.test(String(t || '')) },
};
function qualOn() { const q = localStorage.getItem('tc_qual'); return QUAL[q] ? q : 'fhd'; }
function setQual(q) { localStorage.setItem('tc_qual', QUAL[q] ? q : 'fhd'); }
function isFullHD(title) {
  const t = String(title || '').toLowerCase();
  if (/(2160|4k|uhd|1080)/.test(t)) return true;
  return !/(720p|576p|480p|540p|360p|240p|hdtv|sdtv|satrip|tvrip|dvbrip|dvb\b|iptvrip|camrip|\bcam\b|vhsrip|vhs\b|dvdscr|\bdvd5\b|\bdvd9\b|\bwebrip\b|\bts\b)/.test(t);
}

// Отсев не-видео.
//
// Поиск по умолчанию идёт по всем категориям трекера (cat=0), поэтому на запрос
// «ведьмак» приходят и сериал, и одноимённая игра, и книга по вселенной, а
// приложение — для фильмов и сериалов.
//
// Слово «игра» как признак не годится: «Игра престолов», «Голодные игры» и «Игры
// разума» — фильмы, и по одному слову выбросилась бы половина каталога. Смотрятся
// только маркеры, которых в названиях фильмов не бывает: имена перепаковщиков,
// «RePack», платформа «PC», версия вида «[v 1.32]», кодеки активации, книжные
// форматы.
const NON_VIDEO = [
  { kind: 'игра', re: /(re-?pack|fitgirl|\bdodi\b|elamigos|xatab|steam-?rip|r\.?g\.?[\s.-]*mechanics|skidrow|\bcpy\b|\bflt\b|tenoke|insaneramzes|hoodlum|mr[ _]?dj|kaoskrew|\bsebik\b)/i },
  { kind: 'игра', re: /(^|[\s|[(])PC([\s|)\]]|$)/i },
  { kind: 'игра', re: /\[v\s*\d+(?:\.\d+){1,3}[^\]]*\]/i },
  { kind: 'игра', re: /\b(playstation|xbox|nintendo|\bps[2-5]\b)\b/i },
  { kind: 'софт', re: /\b(x64|x86|win64|win32|portable|activat\w*|keygen|crack)\b/i },
  /* Без \b: в JavaScript граница слова считается только по \w, а это одна
     латиница и цифры — \bактиватор не совпадает никогда. */
  { kind: 'софт', re: /(активатор|кейген|кряк|взломанн\w*|лекарство)/i },
  { kind: 'софт', re: /\bwindows\s*(?:xp|vista|7|8|10|11)\b/i },
  { kind: 'книга', re: /\b(fb2|epub|djvu|mobi)\b/i },
  { kind: 'книга', re: /аудиокниг/i },
  /* Только со счётчиком в скобках: просто «книга» ловит и «Книгу джунглей». */
  { kind: 'книга', re: /\[\s*\d+\s*книг/i },
  { kind: 'книга', re: /\[\s*книг/i },
];

// Признак видеораздачи: качество, кодек, раздача сериала. Нужен не для отсева, а
// чтобы не принять за книгу старый DVDRip — у него звук тоже MP3.
const VIDEO_MARK = /(1080|720|2160|4k|uhd|480|360|bdrip|brrip|web-?dl|webrip|hdrip|dvdrip|hdtv|sdtv|remux|\bavc\b|hevc|x26[45]|\bdts\b|\bac3\b|\baac\b|сезон|\bs\d{1,2}e\d{1,2}|\[s\d{1,2})/i;

// nonVideoKind отвечает, на что похожа раздача: '' — видео, иначе род («игра»,
// «софт», «книга»). Род нужен не только для отсева, но и для объяснения: «в
// выдаче только игры» понятнее, чем «ничего не найдено».
function nonVideoKind(title) {
  const t = String(title || '');
  for (const p of NON_VIDEO) {
    if (p.re.test(t)) return p.kind;
  }
  /* Аудиокнига: сам по себе MP3 ничего не значит — у старых DVDRip звук тоже
     MP3, и поэтому одна книга не должна выбросить половину старого каталога.
     Книга — это MP3 без единого признака видеораздачи. */
  if (/(?:^|[\s|(])(?:MP3|МР3)\b/.test(t) && !VIDEO_MARK.test(t)) return 'книга';
  return '';
}

// splitNonVideo делит выдачу на видео и остальное, **ничего не выбрасывая**:
// скрытые раздачи остаются в state.searchState.results, поэтому «показать всё»
// возвращает их без повторного запроса к трекеру.
function splitNonVideo(rows) {
  const keep = [];
  const drop = [];
  for (const r of rows || []) {
    if (!r) continue;
    (nonVideoKind(r.title || r.name || '') ? drop : keep).push(r);
  }
  return { keep, drop };
}

// videoOnlyPref — настройка «только видео», она запоминается (как и качество) в
// localStorage. Выключенная означает «показывать всё, что нашлось»: иногда игра
// или софт и есть цель поиска, и заставлять человека снимать отсев каждый раз
// нельзя. Ключ 'tc_vid', значение '0' — выключено; отсутствие ключа — включено.
function videoOnlyPref() { return localStorage.getItem('tc_vid') !== '0'; }
function setVideoOnlyPref(v) { localStorage.setItem('tc_vid', v ? '1' : '0'); }

// videoOnlyOn: не-видео скрывается при «всех категориях». Выбрав «Игры», «Софт»,
// «Книги» или «Музыку», пользователь просит именно их — отсев молча уничтожил бы
// всю выдачу. showAll снимает отсев на текущий поиск.
function videoOnlyOn() {
  const st = state.searchState;
  if (st && st.showAll) return false;
  if (!videoOnlyPref()) return false;
  const el = $('#searchCat');
  const c = el ? el.value : '';
  return !(c === 'игры' || c === 'софт' || c === 'книги' || c === 'музыка');
}
async function onTopClick() {
  let t = topSel();
  if (!t.sec && (sd.provider === 'kinozal' || sd.provider === 'both')) {
    t = { sec: 'kino', label: 'Кинозал → Фильмы' };
  }
  return t.sec ? fetchTopCat(t.sec, t.label) : fetchTop24();
}

// История поиска: хранится 30 запросов (для автодополнения), кнопками
// показываются последние 8. Запись можно удалить крестиком.
function searchHistoryAll() {
  try { const h = JSON.parse(localStorage.getItem('tc_sq') || '[]'); return Array.isArray(h) ? h.filter(x => typeof x === 'string').slice(0, 30) : []; } catch { return []; }
}
function searchHistory() { return searchHistoryAll().slice(0, 8); }
function saveSearchHistory(h) { try { localStorage.setItem('tc_sq', JSON.stringify(h.slice(0, 30))); } catch {} }
function pushSearchHistory(q) {
  if (!q) return;
  const h = searchHistoryAll().filter(x => x.toLowerCase() !== q.toLowerCase());
  h.unshift(q); saveSearchHistory(h);
}
function dropSearchHistory(q) { saveSearchHistory(searchHistoryAll().filter(x => x !== q)); }

async function fetchTop24() {
  const button = $('#top24Btn');
  const el = $('#searchResults');
  if (!button) return;
  button.disabled = true; button.textContent = 'Загрузка...';
  el.innerHTML = skeleton('Сбор ТОП-24 за последние 24 часа…');
  let resp = null;
  try {
    const rr = await fetch('/api/top24');
    resp = await rr.json();
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
  } catch (e) {
    button.disabled = false; updateTopBtnLabel();
    el.innerHTML = html`<div class="empty">Не удалось получить ТОП-24: ${e.message}</div>`;
    return;
  }
  const items = (resp.items || []).map(r => row2res(r, 'top24')).filter(x => x !== null);
  items.sort((a, b) => (b.seed || 0) - (a.seed || 0));
  // Число 24 в названии кнопки — это часы, а не количество строк. Показывается
  // весь блок «Топ торренты за последние 24 часа» (на живой странице — 30
  // раздач): прежняя обрезка до 24 выбрасывала из топа суток свежие раздачи с
  // меньшим числом сидов, и выдача молча обрывалась на двадцать четвёртой.
  state.searchState.results = items;
  state.searchState.q = '';
  state.searchState.topLabel = '';
  state.searchState.showAnyQual = false;
  moreSources = {};
  state.top24Hash = resp.hash || '';
  button.disabled = false; updateTopBtnLabel();
  if (resp.source === 'indexers' && !resp.rutor_off) toast('rutor не ответил — ТОП собран через индексаторы');
  paintResults(el);
}
async function fetchTopCat(sec, label) {
  const button = $('#top24Btn');
  const el = $('#searchResults');
  if (!button) return;
  button.disabled = true; button.textContent = 'Загрузка...';
  el.innerHTML = html`<div class="empty">Сбор ТОП раздела «${label}» (по сидам)...</div>`;
  let resp = null;
  try {
    const rr = await fetch('/api/topcat?cat=' + encodeURIComponent(sec));
    resp = await rr.json();
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
  } catch (e) {
    button.disabled = false; updateTopBtnLabel();
    el.innerHTML = html`<div class="empty">Не удалось получить ТОП: ${e.message}</div>`;
    return;
  }
  const items = (resp.items || []).map(r => row2res(r, 'topcat')).filter(x => x !== null);
  items.sort((a, b) => (b.seed || 0) - (a.seed || 0));
  // Топ раздела — та же кнопка ТОП-24, и обрезка по числу строк здесь так же
  // неуместна: демон отдаёт до сотни свежих раздач раздела, и все они нужны.
  state.searchState.results = items;
  state.searchState.q = '';
  state.searchState.topLabel = label;
  state.searchState.showAnyQual = false;
  moreSources = {};
  state.top24Hash = '';
  button.disabled = false; updateTopBtnLabel();
  paintResults(el);
}
function parseSizeBytes(s) {
  if (s == null) return null;
  if (typeof s === 'number' && isFinite(s)) return s;
  const m = String(s).match(/([\d.]+)\s*([KMGT]?B?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const mult = { '': 1, B: 1, K: 1e3, KB: 1e3, M: 1e6, MB: 1e6, G: 1e9, GB: 1e9, T: 1e12, TB: 1e12 }[(m[2] || '').toUpperCase()];
  return mult ? Math.round(n * mult) : null;
}
function row2res(r, provider) {
  if (!r || !r.title) return null;
  const sz = r.size ? r.size.match(/([\d.]+)\s*([KMGT]?B)/i) : null;
  const sizeBytes = sz ? parseFloat(sz[1]) * ({ K: 1e3, M: 1e6, G: 1e9, T: 1e12 })[(sz[2] || '').charAt(0).toUpperCase()] || 0 : 0;
  return {
    title: r.title, size_bytes: sizeBytes, size: r.size || '',
    seed: r.seed, peer: r.peer, link: r.link, hash: r.hash, magnet: r.magnet,
    date: r.date, provider: provider || 'top24'
  };
}

// splitExclusions вынимает из запроса слова-исключения: «ведьмак -игра» ищет
// «ведьмак», но выбрасывает из выдачи всё, в названии чего есть «игра».
//
// Исключение не уходит на трекер: rutor ищет фразу целиком, и «ведьмак -игра»
// отдал бы раздачи, в названии которых стоит слово «игра». Поэтому слова
// вынимаются из запроса, а отсев делается здесь, по названию раздачи.
function splitExclusions(q) {
  const keep = [];
  const drop = [];
  for (const w of String(q || '').split(/\s+/)) {
    if (!w) continue;
    if (w.length > 1 && w[0] === '-') {
      const t = w.slice(1).toLowerCase();
      if (t) drop.push(t);
      continue;
    }
    keep.push(w);
  }
  return { q: keep.join(' '), drop };
}

// excludedBy отвечает, из-за какого слова раздача уходит из выдачи.
function excludedBy(title, drop) {
  if (!drop || !drop.length) return '';
  const t = String(title || '').toLowerCase();
  for (const w of drop) {
    if (t.indexOf(w) >= 0) return w;
  }
  return '';
}

async function doSearch() {
  const input = $('#searchInput');
  const raw = (input ? input.value || '' : '').trim();
  const parts = splitExclusions(raw);
  const q = parts.q;
  state.searchState.q = raw; // в поле остаётся то, что ввёл пользователь
  state.searchState.topLabel = '';
  if (!q) return toast('Введите запрос', true);
  const prov = state.searchState.provider;
  // Категория уходит на трекер отдельным полем адреса, а не словом запроса:
  // «фильм 2024» искало раздачи, в названии которых есть слово «фильм», и
  // выдача сужалась до пустоты.
  const cat = rutorCat();
  sd().append = $('#searchAppend') && $('#searchAppend').checked;
  sd().showAll = false; // новый поиск снова прячет не-видео
  sd().showAnyQual = false; // и снова применяет выбранное качество
  sd().exclude = parts.drop; // «ведьмак -игра» отсекает игру по названию
  state.searchState.results = sd().append ? state.searchState.results : [];
  moreSources = {};
  if (prov === 'rutor' || (prov === 'both' && !state.rutorOff)) moreSources.rutor = { query: q, page: 0, count: 0, cat };
  if (prov === 'torznab' || prov === 'both') moreSources.torznab = { query: q, page: 0, count: 0, cat: 0 };
  if (prov === 'kinozal' || prov === 'both') moreSources.kinozal = { query: q, page: 0, count: 0, cat: 0 };
  paintResults($('#searchResults'));
  const el = $('#searchResults');
  el.innerHTML = skeleton('Поиск…');
  state.searchState.tznabOff = null;
  const jobs = [];
  const errs = [];
  const add = (p, promise) => jobs.push(promise.catch(e => {
    /* Torznab разбирает источники построчно, и причина там длиннее одной
       строки всплывающей подсказки, поэтому она уходит в разбор под списком,
       а не в toast. Для остальных источников поведение прежнее. */
    if (p === 'torznab') { state.searchState.tznabOff = 'Torznab: ' + e.message; return; }
    errs.push(p + ': ' + e.message);
    toast(p + ': ' + e.message, true);
  }).then(r => {
    if (r && r.length) { state.searchState.results = mergeResults(state.searchState.results, r); }
    else if (p !== 'torznab') errs.push(p + ': 0 результатов');
  }));
  if (moreSources.rutor) add('rutor', searchRutor(q, 0, cat).then(r => { moreSources.rutor.count = r.length; return r; }));
  if (prov === 'torznab' || prov === 'both') add('torznab', searchTorznabStream(q, el).then(n => { moreSources.torznab.count = n; return []; }));
  if (moreSources.kinozal) add('kinozal', searchKinozal(q, 0).then(r => { moreSources.kinozal.count = r.length; return r; }));
  await Promise.all(jobs);
  state.searchState.status = errs;
  pushSearchHistory(q);
  paintResults(el);
}
const sd = () => state.searchState;

// mergeResults добавляет новое к уже показанному, выбрасывая повторы.
//
// Одна и та же раздача приходит и от rutor, и от Кинозала, а при догрузке
// страниц повторяется ещё раз: у трекера нумерация сдвигается, если между
// запросами добавили новую раздачу. Ключ — хеш, а при его отсутствии название
// с размером (у Кинозала магнита в выдаче нет, и хеша тоже).
function mergeResults(base, add) {
  const seen = new Set();
  const out = [];
  for (const r of (base || []).concat(add || [])) {
    if (!r) continue;
    const key = r.hash
      ? String(r.hash).toLowerCase()
      : (String(r.title || r.name || '').toLowerCase() + '\u0000' + (r.size || ''));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function searchKinozal(q, page) {
  const arr = await apiGetJSON('/api/kinozal/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0));
  if (!Array.isArray(arr)) throw new Error((arr && arr.error) || 'пустой ответ Кинозал');
  return (arr || []).map(it => ({
    _p: 'kinozal', title: it.title, name: it.title, size: it.size, size_bytes: parseSizeBytes(it.size) || it.size_bytes || null,
    seed: it.seed, peer: it.peer, magnet: it.magnet, hash: it.hash, link: it.link, get: it.get, date: it.date,
  }));
}

// apiGetJSON читает ответ как JSON и достаёт причину из тела при ошибке.
// Раньше на любой не-200 показывалось «HTTP 502», и настоящая причина
// («трекер не ответил», «капча») терялась, а пустая выдача выглядела как
// «ничего не найдено».
async function apiGetJSON(url) {
  const r = await fetch(url);
  let body = null;
  try { body = await r.json(); } catch { /* тело не JSON — покажем код */ }
  if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
  return body;
}

async function searchRutor(q, page, cat) {
  const arr = await apiGetJSON('/api/rutor/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0) + '&cat=' + (cat | 0));
  if (!Array.isArray(arr)) throw new Error((arr && arr.error) || 'пустой ответ rutor');
  return mapRutorItems(arr);
}
function mapRutorItems(arr) {
  return (arr || []).map(it => {
    const g = (a, b) => (it[a] != null ? it[a] : it[b]);
    return {
      _p: 'rutor', title: g('title', 'Title') || g('name', 'Name'), name: g('name', 'Name'), year: g('year', 'Year'),
      categories: g('categories', 'Categories'), size: g('size', 'Size'), size_bytes: parseSizeBytes(g('size', 'Size')), tracker: g('tracker', 'Tracker'),
      seed: g('seed', 'Seed'), peer: g('peer', 'Peer'), magnet: g('magnet', 'Magnet'), hash: g('hash', 'Hash'), link: g('link', 'Link'),
      imdb_id: g('imdb_id', 'IMDBID') || g('imdb', 'IMDB'),
      video_quality: g('video_quality', 'VideoQuality'),
      audio_quality: g('audio_quality', 'AudioQuality'),
      poster: g('poster', 'Poster'),
      data: it,
    };
  });
}
// loadMore догружает следующую страницу тех источников, которые отдали полную
// страницу. Страницы у трекеров нумеруются с нуля, поэтому первая уже
// загружена как 0.
async function loadMore() {
  const targets = Object.entries(moreSources).filter(([p, s]) => s.count >= (SRC_PAGE[p] || 0));
  if (!targets.length) return;
  const btn = $('#moreBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Загрузка...'; }
  for (const [p, s] of targets) {
    try {
      let next;
      if (p === 'popular') {
        const resp = await apiGetJSON('/api/popular?page=' + (s.page + 1) + '&cat=' + (s.cat | 0));
        next = mapRutorItems(resp && resp.items);
        s.page += 1;
        s.count = resp && resp.has_more ? 1 : 0;
        if (next.length) state.searchState.results = mergeResults(state.searchState.results, next);
        else s.count = 0;
        continue;
      }
      if (p === 'kinozal') next = await searchKinozal(s.query, s.page + 1);
      else if (p === 'torznab') next = await searchTorznab(s.query, s.page + 1);
      else next = await searchRutor(s.query, s.page + 1, s.cat);
      s.page += 1;
      s.count = next.length;
      if (next.length) state.searchState.results = mergeResults(state.searchState.results, next);
    } catch (e) {
      toast(p + ': ' + e.message, true);
      s.count = 0;
    }
  }
  paintResults($('#searchResults'));
}

// searchTorznabStream ищет по всем индексаторам сразу и рисует выдачу по мере
// ответов: медленный индексатор больше не задерживает быстрые. Возвращает число
// полученных раздач (нужно для «Показать ещё»). Поток читается вручную:
// EventSource не умеет обрывать запрос при смене вкладки.
async function searchTorznabStream(q, el) {
  const ss = state.searchState;
  const r = await fetch('/api/torznab/stream?query=' + encodeURIComponent(q));
  if (!r.ok || !r.body) {
    let body = null;
    try { body = await r.json(); } catch { /* не JSON */ }
    ss.tznabOff = 'Torznab: ' + ((body && body.error) || ('HTTP ' + r.status));
    return 0;
  }
  const bad = [];
  let total = 0;
  const onEvent = (name, data) => {
    if (name !== 'source' || !data) return;
    const rep = data.source || {};
    if (!rep.ok && rep.error) bad.push((rep.name || '?') + ' — ' + rep.error);
    const items = (data.items || []).map(mapTorznab);
    if (!items.length) return;
    total += items.length;
    ss.results = mergeResults(ss.results, items);
    ss.tznabOff = bad.length ? 'Индексатор не ответил: ' + bad.join('; ') : null;
    paintResults(el);
  };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let name = 'message', dataLine = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      try { onEvent(name, JSON.parse(dataLine)); } catch { /* битый кадр пропускаем */ }
    }
  }
  if (bad.length) ss.tznabOff = 'Индексатор не ответил: ' + bad.join('; ');
  else if (!total) ss.tznabOff = null;
  return total;
}

// ---- Подборки TMDB: «самое популярное за всё время» по виду, жанру и происхождению ----
const DISC_GENRES = {
  movie: [['', 'Любой жанр'], [28, 'Боевик'], [12, 'Приключения'], [16, 'Мультфильм'], [35, 'Комедия'], [80, 'Криминал'], [99, 'Документальный'], [18, 'Драма'], [10751, 'Семейный'], [14, 'Фэнтези'], [36, 'История'], [27, 'Ужасы'], [10402, 'Музыка'], [9648, 'Детектив'], [10749, 'Мелодрама'], [878, 'Фантастика'], [53, 'Триллер'], [10752, 'Военный'], [37, 'Вестерн']],
  tv: [['', 'Любой жанр'], [10759, 'Боевик и приключения'], [16, 'Мультсериал'], [35, 'Комедия'], [80, 'Криминал'], [99, 'Документальный'], [18, 'Драма'], [10751, 'Семейный'], [10762, 'Детский'], [9648, 'Детектив'], [10765, 'Фантастика и фэнтези'], [10768, 'Война и политика'], [37, 'Вестерн'], [10764, 'Реалити']],
};
const discState = { items: [], page: 0, hasMore: false, params: null, busy: false };
const DISC_BATCH = 60;

/* Разделы «Аниме», «Мультфильмы», «Документальное» сами задают жанр, поэтому
   второй список у них выбирает не жанр, а вид: фильмы или сериалы. Аниме чаще
   смотрят сериалами, остальное — фильмами. У аниме нет выбора происхождения:
   оно японское по определению. */
const DISC_SECTIONS = { anime: 'tv', cartoon: 'movie', doc: 'movie', trending: 'movie', trending_day: 'movie' };
const isTrending = k => k === 'trending' || k === 'trending_day';
function fillDiscGenres() {
  const kind = $('#dKind').value;
  const sec = DISC_SECTIONS[kind];
  // В трендах второй список выбирает и аниме с мультфильмами: в общих
  // трендах TMDB их почти нет.
  $('#dGenre').innerHTML = sec
    ? html`<option value="tv">Сериалы</option><option value="movie">Фильмы</option>` + (isTrending(kind) ? html`<option value="anime">Аниме</option><option value="cartoon">Мультфильмы</option><option value="anime_movie">Аниме-фильмы</option>` : '')
    : DISC_GENRES[kind].map(g => html`<option value="${g[0]}">${g[1]}</option>`).join('');
  if (sec) $('#dGenre').value = sec;
  // «Сейчас смотрят» — тренды недели: подпись панели говорит об этом прямо.
  const lab = $('#discBar .qlabel');
  if (lab) lab.textContent = isTrending(kind) ? 'Сейчас смотрят:' : 'Топ за всё время:';
  const o = $('#dOrigin');
  if (o) {
    o.disabled = kind === 'anime'; o.classList.toggle('hidden', kind === 'anime');
    // В трендах «Зарубежное» по умолчанию выбрасывало всё русское, и выдача
    // выглядела урезанной. Здесь по умолчанию — всё подряд.
    if (isTrending(kind) && !o.dataset.touched) o.value = 'any';
    else if (!isTrending(kind) && !o.dataset.touched) o.value = 'foreign';
  }
}
/* discQuery — параметры запроса подборки по выбору в панели. */
function discQuery(p) {
  const sec = DISC_SECTIONS[p.kind];
  if (isTrending(p.kind) && (p.genre === 'anime' || p.genre === 'anime_movie')) return 'kind=' + (p.genre === 'anime' ? 'tv' : 'movie') + '&cat=trend_anime&origin=any';
  if (isTrending(p.kind) && p.genre === 'cartoon') return 'kind=movie&cat=trend_cartoon&origin=' + p.origin;
  if (sec) return 'kind=' + (p.genre === 'tv' ? 'tv' : 'movie') + '&cat=' + p.kind + '&origin=' + p.origin;
  return 'kind=' + p.kind + '&origin=' + p.origin + '&genre=' + encodeURIComponent(p.genre);
}
function initDiscoverBar() {
  if (!$('#dKind')) return;
  // Раздел, вид и происхождение подборки помнятся, как и источник поиска.
  const kinds = [...$('#dKind').options].map(o => o.value);
  $('#dKind').value = savedPref('tc_dkind', kinds, 'movie');
  const org = savedPref('tc_dorigin', ['foreign', 'any', 'ru'], '');
  if (org) { $('#dOrigin').value = org; $('#dOrigin').dataset.touched = '1'; }
  fillDiscGenres();
  const g = savedPref('tc_dgenre', null, '');
  if (g && [...$('#dGenre').options].some(o => o.value === g)) $('#dGenre').value = g;
  $('#dKind').addEventListener('change', () => { fillDiscGenres(); savePref('tc_dkind', $('#dKind').value); savePref('tc_dgenre', $('#dGenre').value); });
  $('#dGenre').addEventListener('change', () => savePref('tc_dgenre', $('#dGenre').value));
  $('#dOrigin').addEventListener('change', () => { $('#dOrigin').dataset.touched = '1'; savePref('tc_dorigin', $('#dOrigin').value); });
  $('#dGo').addEventListener('click', () => fetchDiscover(true));
}
async function fetchDiscover(reset) {
  const el = $('#searchResults');
  if (!el || discState.busy) return;
  if (reset) {
    discState.params = { kind: $('#dKind').value, origin: $('#dOrigin').value, genre: $('#dGenre').value };
    discState.items = []; discState.page = 0; discState.hasMore = false;
    el.innerHTML = skeleton('Собираю подборку…', 12, true);
  }
  const p = discState.params;
  if (!p) return;
  discState.busy = true;
  try {
    // За одно нажатие набирается не меньше DISC_BATCH карточек: страница TMDB —
    // двадцать названий, а после фильтра по происхождению бывает и две.
    // Пять страниц — предел, чтобы кнопка не превращалась в долгую загрузку.
    const want = discState.items.length + DISC_BATCH;
    for (let n = 0; n < 5; n++) {
      const url = '/api/discover?' + discQuery(p) + '&page=' + (discState.page + 1);
      const resp = await apiGetJSON(url);
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
      discState.page = resp.page;
      discState.hasMore = !!resp.has_more;
      const seen = new Set(discState.items.map(x => x.id + ':' + x.kind));
      for (const it of resp.items || []) if (!seen.has(it.id + ':' + it.kind)) discState.items.push(it);
      if (discState.items.length >= want || !discState.hasMore) break;
    }
  } catch (e) {
    discState.busy = false;
    if (reset && !discState.items.length) el.innerHTML = html`<div class="empty">Не удалось получить подборку: ${e.message}</div>`;
    else { toast(e.message, true); paintDiscover(el); }
    return;
  }
  discState.busy = false;
  paintDiscover(el);
}
function paintDiscover(el) {
  if (!discState.items.length) { el.innerHTML = '<div class="empty">В подборке пусто</div>'; return; }
  const cards = discState.items.map((it, i) => html`
    <div class="disc-card" data-di="${i}" title="Подобрать лучшую раздачу из всех источников">
      <div class="disc-poster">${raw(it.poster ? html`<img loading="lazy" src="${pimg(it.poster)}" alt="">` : '')}${raw(discFavHtml(it))}</div>
      <div class="disc-title">${it.title}</div>
      <div class="disc-meta">${it.kind === 'tv' ? 'Сериал · ' : ''}${it.year || ''}${it.rating ? ' · ★ ' + it.rating.toFixed(1) : ''}</div>
    </div>`).join('');
  el.innerHTML = html`<div class="disc-head">${discState.params && isTrending(discState.params.kind) ? (discState.params.kind === 'trending_day' ? 'Сейчас смотрят — тренды дня' : 'Сейчас смотрят — тренды недели') : 'Популярное за всё время'} (${discState.items.length})</div>
    <div class="disc-grid">${raw(cards)}</div>
    ${raw(discState.hasMore ? '<div style="text-align:center;margin:14px"><button id="discMore" class="primary">Показать ещё</button></div>' : '')}`;
  $$('.disc-fav', el).forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    toggleDiscFav(discState.items.find(x => discFavKey(x) === b.dataset.fk));
  }));
  $$('.disc-card').forEach(c => c.addEventListener('click', () => {
    const it = discState.items[+c.dataset.di];
    if (!it) return;
    findBest(it.title, it.year ? +String(it.year).slice(0, 4) : 0);
  }));
  const more = $('#discMore');
  if (more) more.addEventListener('click', () => { more.disabled = true; more.textContent = 'Загрузка...'; fetchDiscover(false); });
}

// «Популярное за всё время»: раздачи категории rutor по числу сидов, страница
// за страницей. Догрузка идёт через общую кнопку «Показать ещё».
const POP_LABEL = 'Популярное за всё время';
async function fetchPopular() {
  const el = $('#searchResults');
  const btn = $('#popBtn');
  if (!el) return;
  const cat = rutorCat();
  if (btn) btn.disabled = true;
  el.innerHTML = skeleton('Собираю популярное за всё время…');
  try {
    const resp = await apiGetJSON('/api/popular?page=0&cat=' + (cat | 0));
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'пустой ответ');
    const items = mapRutorItems(resp.items);
    const ss = state.searchState;
    ss.results = items;
    ss.q = '';
    ss.topLabel = POP_LABEL;
    ss.showAnyQual = false;
    state.top24Hash = '';
    moreSources = { popular: { query: '', page: 0, count: resp.has_more ? 1 : 0, cat } };
  } catch (e) {
    el.innerHTML = html`<div class="empty">Не удалось получить популярное: ${e.message}</div>`;
    if (btn) btn.disabled = false;
    return;
  }
  if (btn) btn.disabled = false;
  paintResults(el);
}

async function searchTorznab(q, page) {
  /* Свой Torznab отдаёт не голый список, а разбор по индексаторам: упал ли
     какой-то из них и почему. Раньше эта причина терялась, и пустая выдача
     выглядела так же, как «все индексаторы молчат». */
  const env = await apiGetJSON('/api/torznab/search?query=' + encodeURIComponent(q) + '&page=' + (page | 0));
  const arr = env && Array.isArray(env.items) ? env.items : [];
  if (env && Array.isArray(env.sources)) {
    const bad = env.sources.filter(s => !s.ok && s.error);
    if (bad.length) {
      const names = bad.map(s => s.name + ' — ' + s.error).join('; ');
      if (!arr.length) throw new Error(names);
      state.searchState.tznabOff = 'Индексатор не ответил: ' + names;
    }
  }
  return (arr || []).map(mapTorznab);
}

function mapTorznab(it) {
    const g = (a, b) => (it[a] != null ? it[a] : it[b]);
    return {
      _p: 'torznab', title: g('title', 'Title') || g('name', 'Name'), name: g('title', 'Title') || g('name', 'Name'),
      size: g('size', 'Size'), size_bytes: parseSizeBytes(g('size', 'Size')),
      seed: g('seed', 'Seed'), peer: g('peer', 'Peer'),
      magnet: g('magnet', 'Magnet'), hash: g('hash', 'Hash'), link: g('link', 'Link'),
      imdb_id: g('imdb', 'IMDB') || g('imdb_id', 'IMDBID'),
      categories: g('categories', 'Categories'),
      data: it,
    };
}

function paintResults(el) {
  const needProvider = el || $('#searchResults');
  const rows = state.searchState ? state.searchState.results : [];
  const qual = QUAL[qualOn()] || QUAL['fhd'];
  const status = state.searchState.status || [];
  if (!rows.length) {
    if (needProvider) needProvider.innerHTML = '<div class="empty">Нет результатов.' + (status.length ? '' : ' Проверьте индексаторы: Настройки → Torznab.') + '</div>'
      + (status.length ? html`<div class="hint" style="text-align:center;margin-top:8px">${status.join(' · ')}</div>` : '');
    return;
  }
  /* Фильтр качества включён по умолчанию, и на живом блоке суток он снимает
     несколько раздач: 720p и HDTVRip не 1080p. Раньше заголовок писал число
     уже отфильтрованных строк, из-за чего «ТОП-24 за последние 24 часа (24)»
     читалось как «трекер отдал двадцать четыре раздачи» — и человек искал
     ограничение там, где его нет. Теперь показываются оба числа, отсев
     называется своим фильтром, и его можно снять одной кнопкой. */
  const qualTotal = rows.length;
  const qualFilter = qualOn() && !(state.searchState && state.searchState.showAnyQual);
  let rows2 = qualFilter ? rows.filter(r => qual.ok(r.title || r.name || '')) : rows.slice();
  const hiddenQual = qualTotal - rows2.length;
  /* Не-видео скрывается при «всех категориях»: выбрав «Игры» или «Софт»,
     пользователь просит именно их. Скрытые раздачи из выдачи не выбрасываются —
     их вернёт «показать всё». */
  const onlyVideo = videoOnlyOn();
  let hidden = 0;
  if (onlyVideo) {
    const parts = splitNonVideo(rows2);
    rows2 = parts.keep;
    hidden = parts.drop.length;
  }
  /* Слова-исключения из запроса («ведьмак -игра»). Исключение задал сам
     пользователь, поэтому «показать всё» его не отменяет — отменяет только
     отсев не-видео, который включён по умолчанию. */
  const excl = (state.searchState && state.searchState.exclude) || [];
  let hiddenEx = 0;
  if (excl.length) {
    const kept = [];
    for (const r of rows2) {
      if (excludedBy(r.title || r.name || '', excl)) { hiddenEx++; continue; }
      kept.push(r);
    }
    rows2 = kept;
  }
  if (!rows2.length) {
    let why = 'Нет результатов по фильтру Full HD. Снимите галочку «Full HD».';
    if (hiddenEx) why = 'Всё, что нашлось, подпадает под исключение ' + excl.map(w => '-' + w).join(' ') + '. Уберите его из запроса.';
    else if (hidden) why = 'В выдаче только игры, софт или книги. Нажмите «показать всё» рядом с сортировкой.';
    needProvider.innerHTML = html`<div class="empty">${why}</div>`;
    return;
  }
  const sort = state.searchState.sort || 'seed';
  const sorted = [...rows2].sort((a, b) => {
    if (sort === 'size') return (b.size_bytes || b.size || 0) - (a.size_bytes || a.size || 0);
    if (sort === 'name') return (a.title || a.name || '').localeCompare(b.title || b.name || '', 'ru');
    if (sort === 'peer') return (b.peer || 0) - (a.peer || 0);
    if (sort === 'quality') return rateRelease(b).score - rateRelease(a).score || (b.seed || 0) - (a.seed || 0);
    return (b.seed || 0) - (a.seed || 0);
  });
  const isTop = rows2.length && rows2.every(r => r.provider === 'top24' || r.provider === 'topcat');
  const fhdNote = qualFilter ? ' · ' + qual.label : '';
  const topLabel = state.searchState.topLabel || '';
  const sortLabel = sort === 'peer' ? 'по личам' : sort === 'quality' ? 'по качеству' : 'по сидам';
  // В заголовке видно, сколько раздач в блоке суток: иначе «ТОП-24» читается
  // как «двадцать четыре строки», и обрыв выдачи выглядит нормой. Число пришло
  // одно, а показано другое — пишем оба, иначе отсев остаётся невидимым.
  const shown = rows2.length + (hidden || 0) + hiddenEx;
  const cnt = hiddenQual ? shown + ' из ' + qualTotal : '' + shown;
  const head = topLabel === POP_LABEL ? POP_LABEL + ' (' + cnt + ')' : topLabel ? 'ТОП раздела: ' + topLabel + ' (' + sortLabel + ')' : (isTop ? 'ТОП-24 за последние 24 часа (' + cnt + ')' : 'Результаты (' + cnt + ')' + fhdNote);
  // Индекс строки в полной выдаче: по нему карточка находит свой data-ix.
  // Прежде он искался через rows.indexOf внутри map — проход по всей выдаче на
  // каждую показанную строку, то есть квадрат на больших выдачах.
  const rowIx = new Map();
  rows.forEach((r, i) => { if (!rowIx.has(r)) rowIx.set(r, i); });
  needProvider.innerHTML = html`<h2 class="section">${head}
    <select id="resSort" style="width:auto" title="Сортировка">
      <option value="quality" ${sort === 'quality' ? 'selected' : ''}>по качеству</option>
      <option value="seed" ${sort === 'seed' ? 'selected' : ''}>по сидам</option>
      <option value="peer" ${sort === 'peer' ? 'selected' : ''}>по личам</option>
      <option value="size" ${sort === 'size' ? 'selected' : ''}>по размеру</option>
      <option value="name" ${sort === 'name' ? 'selected' : ''}>по имени</option>
    </select>
    ${raw(hasMore() ? '<button id="moreBtn" class="primary" style="margin-left:8px" title="Следующая страница выдачи">Показать ещё</button>' : '')}
    ${raw(hidden ? html`<span class="hint" style="margin:0">скрыто ${hidden} не-видео</span><button id="showAllBtn" style="width:auto" title="Вернуть игры, софт и книги в выдачу">показать всё</button>` : '')}
    ${raw(hiddenQual ? html`<span class="hint" style="margin:0">отсеяно ${hiddenQual} фильтром «${qual.label}»</span><button id="anyQualBtn" style="width:auto" title="Показать раздачи ниже выбранного качества — например, 720p и HDTVRip">показать без фильтра качества</button>` : '')}
    ${raw(hiddenEx ? html`<span class="hint" style="margin:0">скрыто ${hiddenEx} по «${excl.map(w => '-' + w).join(' ')}»</span>` : '')}
    ${raw(state.searchState.tznabOff ? html`<span class="hint" style="margin:0">${state.searchState.tznabOff}</span>` : '')}
    ${raw(status.length ? html`<span class="hint" style="margin:0">${status.join(' · ')}</span>` : '')}
  </h2>
  <div class="grid results">` +
    sorted.map(res => resultRow(res, rowIx.has(res) ? rowIx.get(res) : -1)).join('') +
    `</div>`;
  const so = $('#resSort'); if (so) so.addEventListener('change', () => { state.searchState.sort = so.value; paintResults($('#searchResults')); });
  const mb = $('#moreBtn'); if (mb) mb.addEventListener('click', loadMore);
  const sab = $('#showAllBtn'); if (sab) sab.addEventListener('click', () => { state.searchState.showAll = true; paintResults($('#searchResults')); });
  const aqb = $('#anyQualBtn'); if (aqb) aqb.addEventListener('click', () => { state.searchState.showAnyQual = true; paintResults($('#searchResults')); });
  $$('.result', needProvider).forEach(row => bindResult(row));
  updateFavMarks();
  enrichPosters(sorted, rows);
}

