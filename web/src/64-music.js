/* ================= АУДИО =================
   Раздел с тремя вкладками: музыка, аудиокниги и радио. Всё играет прямо в
   окне одним плеером внизу раздела. Аудиораздачи живут здесь и не расходятся
   по программе: в Библиотеку, «Продолжить просмотр», Сериалы и Главную они не
   попадают (категории TorrServer music и audiobook).
   Строгость отбора — в два слоя: трекер ищет в своём разделе (rutor: 2 —
   музыка, 11 — книги), а выдача ещё раз проверяется по названию.
   Здесь — общее ядро: плеер, звук для танцовщицы и осциллографа, скорость и
   буфер, диагностика зависшей раздачи, перемешивание, обложки, вкладка
   «Музыка» с рекомендациями. Книги — 66-audiobooks.js, радио — 67-radio.js. */

const MUSIC_KEY = 'tc_music';
const MUSIC_AUDIO_RE = /\b(flac|mp3|aac|alac|ape|wav|wv|ogg|opus|m4a|dsd|dsf|lossless|hi-?res|\d{2,3}\s?kbps|\d{2}\s?bit|24-?bit|16-?bit|vbr|cbr|cue)\b|дискограф|discograph|альбом|album|сингл|single\b|\bep\b|\blp\b|саундтрек|soundtrack|\bost\b|сборник|compilation|мп3/i;
const MUSIC_VIDEO_RE = /\b(2160p|1080[pi]|720p|480p|bdrip|bd-?remux|blu-?ray|web-?dl|web-?rip|hdtv|dvd-?rip|dvd5|dvd9|x264|x265|hevc|avc|xvid|mkv|avi)\b|клип[ыа]?\b|концерт.*(видео|dvd)|video/i;
function isMusicRelease(title) {
  const t = String(title || '');
  return MUSIC_AUDIO_RE.test(t) && !MUSIC_VIDEO_RE.test(t);
}
function jsonPref(key, def) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? def : v; } catch { return def; } }
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
function musicList() { const a = jsonPref(MUSIC_KEY, []); return Array.isArray(a) ? a : []; }
function saveMusicList(l) { saveJson(MUSIC_KEY, l.slice(0, 300)); }
function musicHashes() { const s = new Set(musicList().map(x => x.hash).filter(Boolean)); (typeof bookList === 'function' ? bookList() : []).forEach(b => s.add(b.hash)); return s; }
/* isMusicTorrent — раздача принадлежит разделу «Аудио»: её добавили отсюда
   (категория music/audiobook у TorrServer или запись в списке). Раздачу со
   звуком, добавленную через Библиотеку, раздел не забирает. */
function isMusicTorrent(t, set) {
  if (!t) return false;
  const c = String(t.category || '').toLowerCase();
  if (c === 'music' || c === 'audiobook') return true;
  return (set || musicHashes()).has(t.hash);
}

const mu = { tab: savedPref('tc_autab', ['music', 'books', 'radio'], 'music'), q: '', rows: [], busy: false, err: '', queue: [], ix: -1, t: null, audio: null,
  kind: '', shuffle: localStorage.getItem('tc_mushuf') === '1', order: [], stats: null, statsAt: 0, diag: '', wd: null, switches: 0, alts: [], recs: null, recBusy: false };

/* ── звук: один граф Web Audio на все элементы ──
   Танцовщице и осциллографу радио нужен анализатор. createMediaElementSource
   можно вызвать на элементе один раз, и дальше звук идёт только через граф,
   поэтому подключаются лишь элементы, чей звук разрешено читать: свои потоки
   (/ts, /api/audio) и радио, ответившее с CORS. Чужой поток без CORS граф
   превратил бы в тишину. */
const auGraph = { ac: null, an: null, srcs: new WeakMap(), buf: null, wave: null };
function auHook(el) {
  if (!el || !window.AudioContext) return null;
  try {
    if (!auGraph.ac) {
      auGraph.ac = new AudioContext();
      auGraph.an = auGraph.ac.createAnalyser(); auGraph.an.fftSize = 2048; auGraph.an.smoothingTimeConstant = 0.5;
      auGraph.an.connect(auGraph.ac.destination);
      auGraph.buf = new Uint8Array(auGraph.an.frequencyBinCount); auGraph.wave = new Uint8Array(auGraph.an.fftSize);
    }
    if (!auGraph.srcs.has(el)) {
      const s = auGraph.ac.createMediaElementSource(el); s.connect(auGraph.an); auGraph.srcs.set(el, s);
      el.addEventListener('play', () => auGraph.ac.resume().catch(() => {}));
    }
    if (!el.paused) auGraph.ac.resume().catch(() => {});
    return auGraph.an;
  } catch { return null; }
}
// Что играет сейчас: элемент и можно ли читать его звук.
function auCurrent() {
  if (mu.kind === 'radio' && typeof radioEl === 'function') { const r = radioEl(); return r ? { el: r.el, analysable: r.cors } : null; }
  if (mu.audio && mu.audio.src && mu.ix >= 0) return { el: mu.audio, analysable: true };
  return null;
}
function auPlaying() { const c = auCurrent(); return !!(c && !c.el.paused && !c.el.ended); }
function auAnalyser() { const c = auCurrent(); if (!c || !c.analysable) return null; return auHook(c.el); }

/* ── вкладки ── */
async function renderMusic(root) {
  root.innerHTML = html`<div class="mu-wrap"><div class="mu">
    <div class="mu-head"><h1 class="page-title">Аудио</h1>
      <div class="au-tabs" role="tablist">${raw([['music', 'Музыка', 'music'], ['books', 'Аудиокниги', 'bookmark'], ['radio', 'Радио', 'sparkles']].map(([k, l, i]) => html`<button role="tab" class="${mu.tab === k ? 'on' : ''}" data-au-tab="${k}">${raw(ico(i, 15))}${l}</button>`).join(''))}</div></div>
    <div id="auBody"></div>
    <div id="muPlayer"></div>
  </div>${raw(dancerHtml())}</div>`;
  if (!root._muBound) { root._muBound = true; root.addEventListener('click', onMusicClick); }
  paintAudioTab();
  paintMusicPlayer();
  bindDancer();
}
function paintAudioTab() {
  const b = $('#auBody'); if (!b) return;
  document.querySelectorAll('[data-au-tab]').forEach(x => x.classList.toggle('on', x.dataset.auTab === mu.tab));
  if (mu.tab === 'books') return renderBooks(b);
  if (mu.tab === 'radio') return renderRadio(b);
  b.innerHTML = html`<div class="mu-search">
      <span class="sb-ico">${raw(ico('search', 18))}</span>
      <input id="muQ" placeholder="Исполнитель, альбом, саундтрек…" value="${mu.q}" autocomplete="off">
      <button id="muX" class="sb-clear${mu.q ? '' : ' hidden'}" type="button" title="Очистить (Esc)" aria-label="Очистить">${raw(ico('x', 15))}</button>
      <button id="muGo" class="primary">Найти</button>
    </div>
    <div id="muRes"></div>
    <div id="muMine"></div>
    <div id="muRecs"></div>`;
  const q = $('#muQ');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') musicSearch(); else if (e.key === 'Escape' && q.value) { e.preventDefault(); e.stopPropagation(); q.value = ''; mu.q = ''; $('#muX').classList.add('hidden'); paintMusicRes(); } });
  q.addEventListener('input', () => $('#muX').classList.toggle('hidden', !q.value));
  $('#muX').addEventListener('click', () => { q.value = ''; mu.q = ''; $('#muX').classList.add('hidden'); paintMusicRes(); q.focus(); });
  $('#muGo').addEventListener('click', () => musicSearch());
  paintMusicMine(); paintMusicRes(); paintRecs();
}

/* ── лучшая раздача: качество × скорость ──
   Качество — по формату и битрейту, и только то, что окно умеет играть: APE,
   WMA, DSD и ALAC встроенный плеер не откроет, такие раздачи идут вниз.
   Скорость — по числу раздающих (логарифм: разница 1 и 10 важнее, чем 100 и
   110). Раздача без раздающих почти обнуляется. */
function audioQuality(t) {
  t = String(t || '');
  const br = +(t.match(/\b(\d{2,3})\s?kbps\b/i) || [])[1] || 0;
  if (/\b(ape|wma|dsd|dsf|wv|wavpack)\b/i.test(t) && !/\b(flac|mp3)\b/i.test(t)) return 0.2;
  if (/\balac\b/i.test(t)) return 0.35;
  if (/\bflac\b|lossless|\bwav\b/i.test(t)) return /\b24\s?-?bit|hi-?res|96\s?khz|192\s?khz/i.test(t) ? 1 : 0.9;
  if (br >= 320) return 0.78; if (br >= 256) return 0.66; if (br >= 192) return 0.5; if (br >= 128) return 0.32;
  if (/\b(aac|m4a|opus|ogg)\b/i.test(t)) return 0.62;
  if (/\bmp3\b|мп3/i.test(t)) return 0.55;
  return 0.5;
}
function audioScore(r, speedW = 0.45) {
  const s = Number(r.seed) || 0;
  const sp = Math.min(1, Math.log10(1 + s) / Math.log10(51));
  let v = audioQuality(r.title || r.name) * (1 - speedW) + sp * speedW;
  if (s === 0) v *= 0.1;
  const sz = Number(r.size_bytes) || 0;
  if (sz > 8 * 2 ** 30) v *= 0.85; // огромные дискографии: первый трек дольше ищется
  return v;
}
function musicFmt(r) {
  const t = r.title || r.name || '';
  const fmt = (t.match(/\b(flac|alac|ape|wav|dsd|mp3|aac|ogg|opus|m4a)\b/i) || [])[1];
  const br = (t.match(/\b(\d{2,3})\s?kbps\b/i) || [])[1];
  const bit = (t.match(/\b(24|16)\s?-?bit\b/i) || [])[1];
  return [fmt && fmt.toUpperCase(), br && br + ' kbps', bit && bit + ' bit'].filter(Boolean).join(' · ');
}

async function audioTrackerSearch(q, cat, filter, speedW) {
  const got = [], jobs = [];
  let err = '';
  if (!state.rutorOff) jobs.push(withTimeout(searchRutor(q, 0, cat), SEARCH_TIMEOUT, 'rutor не ответил').then(r => got.push(...r)).catch(e => { err = e.message; }));
  jobs.push(withTimeout(searchKinozal(q, 0), SEARCH_TIMEOUT, 'Кинозал не ответил').then(r => got.push(...r)).catch(() => {}));
  await Promise.all(jobs);
  const seen = new Set();
  const rows = mergeResults([], got).filter(r => filter(r.title || r.name))
    .filter(r => { const k = r.hash || r.title; if (seen.has(k)) return false; seen.add(k); return true; });
  rows.forEach(r => { r._score = audioScore(r, speedW); });
  rows.sort((a, b) => b._score - a._score);
  return { rows: rows.slice(0, 60), err };
}
async function musicSearch(text, autoplay) {
  const q = (text != null ? text : ($('#muQ') && $('#muQ').value) || '').trim();
  if (!q) return toast('Введите исполнителя или альбом', true);
  if (mu.tab !== 'music') { mu.tab = 'music'; savePref('tc_autab', 'music'); paintAudioTab(); }
  const inp = $('#muQ'); if (inp && inp.value !== q) { inp.value = q; $('#muX').classList.remove('hidden'); }
  mu.q = q; mu.busy = true; mu.err = ''; mu.rows = [];
  paintMusicRes();
  const res = await audioTrackerSearch(q, 2, isMusicRelease, 0.45);
  if (mu.q !== q) return;
  mu.rows = res.rows; mu.err = res.err; mu.busy = false;
  paintMusicRes();
  if (autoplay && mu.rows.length) musicOpen(mu.rows[0], false, mu.rows.slice(1));
}
function paintMusicRes() {
  const el = $('#muRes'); if (!el) return;
  if (mu.busy) { el.innerHTML = skeleton('Ищу музыку и выбираю лучшую раздачу…', 3); return; }
  if (!mu.q) { el.innerHTML = ''; return; }
  if (!mu.rows.length) { el.innerHTML = html`<div class="empty">Музыкальных раздач не нашлось.${mu.err ? ' ' + mu.err : ''}</div>`; return; }
  const mine = musicHashes();
  el.innerHTML = html`<div class="mu-h">Найдено ${mu.rows.length} · сверху лучшая по качеству и скорости
      <button class="btn sm primary mu-best" data-mu-play="0">${raw(ico('play', 13))} Слушать лучшую</button></div>
    <div class="mu-list">${raw(mu.rows.map((r, i) => html`
    <div class="mu-row${i === 0 ? ' best' : ''}">
      <button class="mu-play" data-mu-play="${i}" title="Слушать">${raw(ico('play', 14))}</button>
      <div class="mu-main"><div class="mu-t" title="${r.title || r.name}">${i === 0 ? raw('<span class="mu-badge">лучшая</span>') : ''}${r.title || r.name}</div>
        <div class="mu-s">${[musicFmt(r), r.size_bytes ? fmtSize(r.size_bytes) : r.size || '', '⬆ ' + (r.seed || 0), audioQuality(r.title) <= 0.35 ? 'не играет в окне' : ''].filter(Boolean).join(' · ')}</div></div>
      <span class="mu-score" title="Оценка: качество и скорость">${Math.round((r._score || 0) * 100)}</span>
      <button class="iconbtn${r.hash && mine.has(r.hash) ? ' on' : ''}" data-mu-save="${i}" title="В мою музыку">${raw(ico('plus', 15))}</button>
    </div>`).join(''))}</div>`;
  hydrateCovers(el);
}

/* ── моя музыка: сетка обложек ── */
function paintMusicMine() {
  const el = $('#muMine'); if (!el) return;
  const l = musicList();
  if (!l.length) { el.innerHTML = ''; return; }
  el.innerHTML = html`<div class="mu-h">Моя музыка</div><div class="au-grid">${raw(l.map((x, i) => html`
    <div class="au-card${mu.t && mu.t.hash === x.hash ? ' on' : ''}">
      <button class="au-cover" data-mu-mine="${i}" title="Слушать: ${x.title}">${raw(coverImg(x.title, x.hash))}<span class="au-cover-play">${raw(ico(mu.t && mu.t.hash === x.hash && auPlaying() ? 'pause' : 'play', 22))}</span></button>
      <div class="au-card-t" title="${x.title}">${x.title}</div>
      <button class="au-card-x" data-mu-drop="${i}" title="Убрать из моей музыки">×</button>
    </div>`).join(''))}</div>`;
  hydrateCovers(el);
}

/* Раздача добавляется в TorrServer с категорией: так её узнают и после
   перезапуска, и с другого окна, где нет записи в localStorage. */
async function audioAddRelease(r, category) {
  let hash = r.hash || ((r.magnet || '').match(/btih:([0-9a-fA-F]{40})/i) || [])[1] || '';
  if (!hash && (r.get || r.link)) {
    toast('Забираю раздачу с Кинозала…');
    const rr = await fetch('/api/kinozal/add?url=' + encodeURIComponent(r.get || r.link) + '&title=' + encodeURIComponent(r.title || '') + '&size=' + encodeURIComponent(r.size || ''), { method: 'POST' });
    const j = await rr.json().catch(() => null);
    if (!rr.ok || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + rr.status);
    if (j.magnet) await torrentAction('add', { link: j.magnet, save_to_db: true, category }).catch(() => {});
    hash = ((j.hash || j.magnet || '').match(/([0-9a-fA-F]{40})/) || [])[1] || '';
  }
  hash = String(hash).toLowerCase();
  if (!hash) throw new Error('не удалось узнать хеш раздачи');
  const title = cleanMusicTitle(r.title || r.name || hash);
  await torrentAction('add', { link: r.magnet || magnetFromHash(hash, title), title, category, save_to_db: true }).catch(() => {});
  await torrentAction('set', { hash, title, category }).catch(() => {});
  return { hash, title };
}
async function musicOpen(r, keep, alts) {
  try {
    const { hash, title } = await audioAddRelease(r, 'music');
    const l = musicList();
    if (!l.some(x => x.hash === hash)) { l.unshift({ hash, title, added: Date.now() }); saveMusicList(l); }
    else if (keep) toast('Уже в вашей музыке');
    paintMusicMine(); paintMusicRes();
    if (keep) { toast('Добавлено в музыку'); return; }
    // Запасные раздачи того же запроса — для переключения, если эта не отдаёт.
    mu.alts = alts || mu.rows.filter(x => x !== r);
    await musicPlayHash(hash, title);
  } catch (e) { toast('Музыка: ' + e.message, true); }
}
function cleanMusicTitle(t) {
  const s = String(t || '').replace(/\s*[\[(](?:flac|mp3|aac|alac|ape|\d{2,3}\s?kbps|lossless|24.?bit|16.?bit|web|cd)[^\])]*[\])]/gi, '').replace(/\s*\|\s*.*$/, '').replace(/\s{2,}/g, ' ').trim();
  return s.length > 2 ? s.slice(0, 120) : String(t || '').slice(0, 120);
}
const COVER_FILE_RE = /(^|\/)(cover|folder|front|albumart[^/]*|обложка)\.(jpe?g|png|webp)$/i;
async function musicPlayHash(hash, title, kind, known) {
  // known — список файлов, сохранённый заранее: книге, скачанной для
  // офлайна, TorrServer и сеть для старта не нужны.
  const st = known ? { file_stats: known } : await waitForFiles({ hash, title });
  if (!st) { audioDiag('Раздача не отдала список файлов — нет раздающих или TorrServer не ответил', true); return musicFallback('нет списка файлов'); }
  const files = (st.file_stats || []).filter(f => isAudio(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'ru', { numeric: true }));
  if (!files.length) { toast('В раздаче нет аудиофайлов, которые играют в окне', true); return musicFallback('нет аудио'); }
  if (kind === 'book' && typeof bookKeepFiles === 'function') bookKeepFiles(hash, files);
  const cov = (st.file_stats || []).find(f => COVER_FILE_RE.test(f.path));
  if (cov) coverRemember(title, hash, ts(`/stream/${encodeURIComponent(basename(cov.path))}?link=${encodeURIComponent(hash)}&index=${cov.id}&play`));
  if (typeof radioStop === 'function' && rd.station) radioStop();
  mu.kind = kind || 'track';
  mu.t = { hash, title }; mu.queue = files; mu.order = [];
  const start = kind === 'book' && typeof bookResumeIx === 'function' ? bookResumeIx(hash, files) : (mu.shuffle ? Math.floor(Math.random() * files.length) : 0);
  musicPlayIx(start);
  paintMusicMine();
}
function musicAudio() {
  if (mu.audio) return mu.audio;
  // Элемент живёт в body: переход по разделам не обрывает трек на середине.
  const a = document.createElement('audio');
  a.preload = 'auto'; a.id = 'muAudio';
  a.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('tc_muvol') || 0.8)));
  a.addEventListener('ended', () => { if (mu.kind === 'book') bookSavePos(true); musicNext(1, true); });
  a.addEventListener('timeupdate', () => { paintMusicProgress(); auNoteListen(); if (mu.kind === 'book') bookSavePos(); });
  a.addEventListener('playing', () => { if (mu.wd) { mu.wd.playing = true; mu.wd.stall = 0; } mu.switches = 0; audioDiag(''); });
  a.addEventListener('waiting', () => { if (mu.wd) mu.wd.stall = mu.wd.stall || Date.now(); });
  a.addEventListener('stalled', () => { if (mu.wd) mu.wd.stall = mu.wd.stall || Date.now(); });
  a.addEventListener('play', () => { paintMusicPlayer(); paintNowPlaying(); paintMusicMine(); });
  a.addEventListener('pause', () => { paintMusicPlayer(); paintNowPlaying(); paintMusicMine(); if (mu.kind === 'book') bookSavePos(true); });
  a.addEventListener('error', () => { if (mu.ix >= 0 && mu.kind !== 'radio') audioOnError(); });
  document.body.appendChild(a);
  mu.audio = a;
  return a;
}
function musicSrcFor(f) {
  const off = mu.kind === 'book' && typeof bookOfflinePath === 'function' ? bookOfflinePath(mu.t.hash, f.id) : '';
  if (off) return '/api/audio/local?p=' + encodeURIComponent(off);
  return ts(`/stream/${encodeURIComponent(basename(f.path))}?link=${encodeURIComponent(mu.t.hash)}&index=${f.id}&play`);
}
function musicPlayIx(i, at) {
  if (i < 0 || i >= mu.queue.length) return;
  mu.ix = i;
  const f = mu.queue[i];
  const a = musicAudio();
  a.src = musicSrcFor(f);
  a.playbackRate = mu.kind === 'book' ? bookSpeed() : 1;
  const resume = at != null ? at : (mu.kind === 'book' && typeof bookResumeAt === 'function' ? bookResumeAt(mu.t.hash, i) : 0);
  if (resume > 1) a.addEventListener('loadedmetadata', () => { try { a.currentTime = resume; } catch {} }, { once: true });
  a.play().catch(() => {});
  mu.wd = { ix: i, start: Date.now(), playing: false, stall: 0, src: a.src, noted: false };
  mu.diag = '';
  dancerNewTrack();
  paintMusicPlayer(); paintNowPlaying();
  statsTick(true);
}
/* Перемешивание: порядок — случайная перестановка, без повторов, пока не
   пройдены все треки; включается и выключается на ходу. */
function shuffleOrder() {
  const n = mu.queue.length, rest = [...Array(n).keys()].filter(i => i !== mu.ix);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  mu.order = rest;
}
function musicNext(d, auto) {
  if (mu.kind === 'radio') return radioNext(d);
  if (mu.shuffle && mu.kind !== 'book' && d > 0) {
    if (!mu.order.length) { if (auto && mu.wd && mu.wd.looped) return musicEnd(); shuffleOrder(); if (mu.wd) mu.wd.looped = true; }
    return musicPlayIx(mu.order.shift());
  }
  if (mu.ix + d >= 0 && mu.ix + d < mu.queue.length) musicPlayIx(mu.ix + d); else musicEnd();
}
function musicEnd() { paintMusicPlayer(); paintNowPlaying(); }
function musicToggle() {
  if (mu.kind === 'radio') return radioToggle();
  const a = musicAudio(); if (!a.src) return; if (a.paused) a.play().catch(() => {}); else a.pause();
}
function musicStop() {
  if (mu.kind === 'radio') { radioStop(); }
  if (mu.audio) { if (mu.kind === 'book') bookSavePos(true); mu.audio.pause(); mu.audio.removeAttribute('src'); mu.audio.load(); }
  mu.ix = -1; mu.t = null; mu.queue = []; mu.kind = ''; mu.wd = null; mu.diag = '';
  paintMusicPlayer(); paintNowPlaying(); paintMusicMine();
}
function musicTrackName(f) { return f ? basename(f.path).replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, '') : ''; }
// для «Сейчас играет» в шапке
function auNowInfo() {
  if (mu.kind === 'radio' && typeof radioNow === 'function') return radioNow();
  if (mu.t && mu.ix >= 0 && mu.audio && mu.audio.src) return { label: musicTrackName(mu.queue[mu.ix]), sub: mu.audio.paused ? 'пауза' : mu.kind === 'book' ? 'аудиокнига' : 'музыка', paused: mu.audio.paused };
  return null;
}
function toggleShuffle() {
  mu.shuffle = !mu.shuffle; savePref('tc_mushuf', mu.shuffle ? '1' : '0'); mu.order = [];
  toast(mu.shuffle ? 'Вперемешку: включено' : 'Вперемешку: выключено');
  paintMusicPlayer();
}

/* ── плеер внизу раздела ── */
function paintMusicPlayer() {
  const el = $('#muPlayer'); if (!el) return;
  if (mu.kind === 'radio' && typeof radioBarHtml === 'function') { el.innerHTML = radioBarHtml(); bindRadioBar(); return; }
  if (!mu.t || mu.ix < 0) { el.innerHTML = ''; return; }
  const a = mu.audio;
  const f = mu.queue[mu.ix];
  const book = mu.kind === 'book';
  el.innerHTML = html`<div class="mu-bar">
    <div class="mu-bar-cov">${raw(coverImg(mu.t.title, mu.t.hash))}</div>
    <div class="mu-bar-t"><b title="${musicTrackName(f)}">${musicTrackName(f)}</b><small>${mu.t.title} · ${mu.ix + 1}/${mu.queue.length}</small></div>
    <div class="mu-ctl">
      ${raw(book ? html`<button class="iconbtn" data-bk-back title="Назад на 15 секунд">↺15</button>` : html`<button class="iconbtn${mu.shuffle ? ' on' : ''}" data-mu-shuf title="Вперемешку">🔀</button>`)}
      <button class="iconbtn" data-mu-prev title="Предыдущий" ${mu.ix > 0 || mu.shuffle ? '' : 'disabled'}>${raw(ico('prev', 16))}</button>
      <button class="iconbtn mu-pp" data-mu-pp title="Пауза / играть">${raw(ico(a && !a.paused ? 'pause' : 'play', 17))}</button>
      <button class="iconbtn" data-mu-next title="Следующий" ${mu.ix < mu.queue.length - 1 || mu.shuffle ? '' : 'disabled'}>${raw(ico('next', 16))}</button>
      ${raw(book ? html`<button class="iconbtn" data-bk-fwd title="Вперёд на 30 секунд">30↻</button><button class="iconbtn" data-bk-mark title="Закладка здесь">${raw(ico('bookmark', 15))}</button>` : '')}
      <button class="iconbtn" data-mu-stop title="Остановить">${raw(ico('stop', 14))}</button>
    </div>
    <input type="range" class="mu-seek" min="0" max="1000" value="0" id="muSeek" title="Перемотка">
    <span class="mu-time" id="muTime">0:00</span>
    ${raw(book ? html`<select id="bkSpeed" class="mu-speed" title="Скорость чтения">${raw([0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}" ${Math.abs(bookSpeed() - v) < 0.01 ? 'selected' : ''}>${v}×</option>`).join(''))}</select>` : '')}
    <input type="range" class="mu-vol" min="0" max="100" value="${Math.round((a ? a.volume : 0.8) * 100)}" id="muVol" title="Громкость">
    <details class="mu-q"><summary title="Список треков">≡</summary><div>${raw(mu.queue.map((x, i) => html`<button class="${i === mu.ix ? 'on' : ''}" data-mu-ix="${i}">${i + 1}. ${musicTrackName(x)}</button>`).join(''))}</div></details>
    <div class="mu-stat" id="muStat">${raw(statsHtml())}</div>
  </div>`;
  const sk = $('#muSeek'); sk.addEventListener('input', () => { const au = mu.audio; if (au && isFinite(au.duration)) au.currentTime = au.duration * sk.value / 1000; });
  const vo = $('#muVol'); vo.addEventListener('input', () => { const au = musicAudio(); au.volume = vo.value / 100; savePref('tc_muvol', au.volume); });
  const sp = $('#bkSpeed'); if (sp) sp.addEventListener('change', () => { bookSetSpeed(+sp.value); if (mu.audio) mu.audio.playbackRate = +sp.value; });
  hydrateCovers(el);
  paintMusicProgress();
}
function paintMusicProgress() {
  const a = mu.audio; if (!a || mu.kind === 'radio') return;
  const sk = $('#muSeek'), tm = $('#muTime');
  if (sk && isFinite(a.duration) && a.duration > 0 && document.activeElement !== sk) sk.value = Math.round(a.currentTime / a.duration * 1000);
  if (tm) tm.textContent = fmtPos(a.currentTime || 0) + (isFinite(a.duration) ? ' / ' + fmtPos(a.duration) : '');
}

/* ── скорость, раздающие, буфер ── */
function audioBufferedAhead() {
  const a = mu.audio; if (!a || !a.buffered) return 0;
  for (let i = 0; i < a.buffered.length; i++) if (a.buffered.start(i) <= a.currentTime + 0.5 && a.buffered.end(i) >= a.currentTime) return Math.max(0, a.buffered.end(i) - a.currentTime);
  return 0;
}
function statsHtml() {
  if (mu.kind === 'radio') return '';
  const s = mu.stats, off = mu.kind === 'book' && mu.t && bookOfflinePath(mu.t.hash, (mu.queue[mu.ix] || {}).id);
  const parts = [];
  if (off) parts.push('<span class="ok">● офлайн, с диска</span>');
  else if (s) {
    parts.push('↓ ' + fmtSpeed(Number(s.download_speed) || 0));
    parts.push((s.active_peers || 0) + ' из ' + (s.total_peers || 0) + ' пиров' + (s.connected_seeders != null ? ' · ' + s.connected_seeders + ' разд.' : ''));
  }
  const ahead = audioBufferedAhead();
  if (mu.audio && mu.audio.src) parts.push('буфер ' + (ahead >= 600 ? '10+ мин' : Math.round(ahead) + ' с'));
  if (mu.wd && !mu.wd.playing && !mu.diag) parts.push('подгружаю… ' + Math.round((Date.now() - mu.wd.start) / 1000) + ' с');
  if (mu.diag) parts.push(`<span class="err">⚠ ${esc(mu.diag)}</span>`);
  return parts.join('<i>·</i>');
}
let statsTimer = 0;
async function statsTick(now) {
  clearTimeout(statsTimer);
  if (!mu.t || mu.ix < 0 || mu.kind === 'radio') return;
  statsTimer = setTimeout(statsTick, 2000);
  if (!now && document.hidden) return;
  if (!(mu.kind === 'book' && bookOfflinePath(mu.t.hash, (mu.queue[mu.ix] || {}).id))) {
    try { const st = await torrentAction('get', { hash: mu.t.hash }); mu.stats = st; } catch { mu.stats = null; }
  }
  audioWatchdog();
  const el = $('#muStat'); if (el) el.innerHTML = statsHtml();
}

/* ── диагностика: почему не играет, и что делать ──
   Трек не начался за 20 с или стоит 25 с: смотрим на раздачу. Нет пиров —
   раздача мёртвая, переключаемся на следующую лучшую из того же поиска.
   Пиры есть, но скорость ниже 16 КБ/с — то же самое. Ошибка формата —
   пропускаем трек. Переключений не больше трёх подряд, чтобы не бегать по
   кругу. */
function audioDiag(text, bad) { mu.diag = text || ''; const el = $('#muStat'); if (el) el.innerHTML = statsHtml(); if (text && bad) notifPush({ kind: 'warn', title: 'Аудио', text }); }
function audioWatchdog() {
  const w = mu.wd, a = mu.audio; if (!w || !a || mu.kind === 'radio' || a.paused && w.playing) return;
  const now = Date.now(), s = mu.stats || {};
  const notStarted = !w.playing && now - w.start > 20000;
  const stalled = w.playing && w.stall && now - w.stall > 25000;
  if (!notStarted && !stalled) return;
  const peers = Number(s.active_peers) || 0, speed = Number(s.download_speed) || 0;
  let why = '';
  if (!mu.stats) why = 'TorrServer не отвечает о раздаче';
  else if (!peers && !Number(s.total_peers)) why = 'нет раздающих — раздача мёртвая';
  else if (!peers) why = 'пиры известны, но ни один не подключился';
  else if (speed < 16 * 1024) why = 'раздающие почти не отдают (' + fmtSpeed(speed) + ')';
  else why = 'данные идут, но плеер не стартует — возможно, формат';
  w.start = now; w.stall = 0;
  audioDiag(why);
  if (/формат/.test(why)) return audioOnError();
  musicFallback(why);
}
function audioOnError() {
  const f = mu.queue[mu.ix] || {}, ext = ((f.path || '').match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const err = mu.audio && mu.audio.error;
  const why = err && err.code === 4 ? 'формат .' + ext + ' не играет в окне' : 'поток оборвался';
  audioDiag(why);
  if (mu.switches++ < 6 && mu.ix < mu.queue.length - 1) { toast('Пропускаю трек: ' + why); setTimeout(() => musicNext(1, true), 600); }
}
async function musicFallback(why) {
  if (mu.kind === 'book') { toast('Аудиокнига: ' + why + '. Попробуйте позже или скачайте для офлайна', true); return; }
  const alt = (mu.alts || []).find(r => (Number(r.seed) || 0) > 0 && audioQuality(r.title) > 0.35 && r.hash !== (mu.t && mu.t.hash));
  if (!alt || mu.switches >= 3) { toast('Раздача не отдаёт: ' + why + '. Других живых раздач нет', true); return; }
  mu.switches++;
  mu.alts = mu.alts.filter(r => r !== alt);
  toast('Раздача не отдаёт (' + why + ') — переключаюсь на другую: ' + cleanMusicTitle(alt.title));
  await musicOpen(alt, false, mu.alts);
}

/* ── вкус: кого вы слушаете ── */
function artistOf(title) {
  const t = cleanMusicTitle(title).replace(/^\s*\(?\d{4}\)?\s*[-–—]?\s*/, '');
  const m = t.split(/\s+[-–—]\s+/);
  const a = (m.length > 1 ? m[0] : t.replace(/\s*[\[(].*$/, '')).replace(/\s*\b(дискография|discography)\b.*$/i, '').trim();
  return a.length > 1 && a.length < 60 ? a : '';
}
function albumOf(title) {
  const t = cleanMusicTitle(title), m = t.split(/\s+[-–—]\s+/);
  return (m.length > 1 ? m.slice(1).join(' ') : '').replace(/\s*[\[(]\d{4}[\])]/g, '').replace(/\s*[\[(][^\])]*[\])]\s*$/g, '').trim();
}
function auNoteListen() {
  const w = mu.wd, a = mu.audio;
  if (!w || w.noted || mu.kind !== 'track' || !a || a.currentTime < 30) return;
  w.noted = true;
  const name = artistOf(mu.t.title); if (!name) return;
  const h = jsonPref('tc_muhist', {}), k = name.toLowerCase();
  h[k] = { name, plays: ((h[k] && h[k].plays) || 0) + 1, last: Date.now() };
  const keys = Object.keys(h); if (keys.length > 300) keys.sort((x, y) => h[x].last - h[y].last).slice(0, keys.length - 300).forEach(x => delete h[x]);
  saveJson('tc_muhist', h);
  mu.recs = null;
}
function topArtists(n) {
  const h = jsonPref('tc_muhist', {});
  musicList().forEach(x => { const a = artistOf(x.title); if (a && !h[a.toLowerCase()]) h[a.toLowerCase()] = { name: a, plays: 0.5, last: x.added || 0 }; });
  const now = Date.now();
  return Object.values(h).map(x => Object.assign({}, x, { w: x.plays * Math.exp(-(now - x.last) / (60 * 864e5)) + 0.1 })).sort((a, b) => b.w - a.w).slice(0, n);
}

/* ── обложки ──
   Сначала картинка из самой раздачи (cover.jpg, folder.jpg), потом Deezer,
   потом iTunes. Найденное запоминается; картинки идут через демон и лежат на
   диске. Не нашлось — градиент с инициалами. */
const coverMem = jsonPref('tc_mucover', {});
let coverSaveT = 0;
function coverKey(title) { return (artistOf(title) + ' ' + albumOf(title)).toLowerCase().trim() || cleanMusicTitle(title).toLowerCase(); }
function coverRemember(title, hash, url) {
  coverMem['h:' + hash] = url; if (title) coverMem[coverKey(title)] = coverMem[coverKey(title)] || url;
  clearTimeout(coverSaveT); coverSaveT = setTimeout(() => { const k = Object.keys(coverMem); if (k.length > 600) k.slice(0, k.length - 600).forEach(x => delete coverMem[x]); saveJson('tc_mucover', coverMem); }, 800);
}
function coverProxy(u) { return /^https:\/\//.test(u) ? '/api/audio/img?u=' + encodeURIComponent(u) : u; }
function coverFallback(title) {
  const s = artistOf(title) || cleanMusicTitle(title) || '?';
  let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const ini = s.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return `<span class="au-ph" style="--h1:${h % 360};--h2:${(h >> 8) % 360}">${esc(ini)}</span>`;
}
function coverImg(title, hash, kind) {
  const u = (hash && coverMem['h:' + hash]) || coverMem[coverKey(title)];
  if (u) return `<img src="${esc(coverProxy(u))}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'au-ph'}))">`;
  if (u === '') return coverFallback(title);
  return `<span class="au-cv" data-cover="${esc(title)}" data-cover-kind="${kind || 'album'}">${coverFallback(title)}</span>`;
}
const coverQueue = new Set();
let coverBusy = 0;
function hydrateCovers(root) {
  (root || document).querySelectorAll('[data-cover]').forEach(el => { if (!el._q) { el._q = 1; coverQueue.add(el); } });
  pumpCovers();
}
async function pumpCovers() {
  while (coverBusy < 3 && coverQueue.size) {
    const el = coverQueue.values().next().value; coverQueue.delete(el);
    if (!el.isConnected) continue;
    coverBusy++;
    coverFind(el.dataset.cover, el.dataset.coverKind).then(u => {
      document.querySelectorAll('[data-cover]').forEach(x => { if (x.dataset.cover === el.dataset.cover) x.outerHTML = u ? `<img src="${esc(coverProxy(u))}" alt="" loading="lazy">` : coverFallback(el.dataset.cover); });
    }).finally(() => { coverBusy--; pumpCovers(); });
  }
}
async function coverFind(title, kind) {
  const key = coverKey(title);
  if (coverMem[key] != null) return coverMem[key];
  const artist = artistOf(title), album = albumOf(title);
  const q = (artist + ' ' + album).trim() || cleanMusicTitle(title);
  let url = '';
  try {
    if (kind === 'book') {
      const j = await api('/api/audio/itunes?entity=audiobook&term=' + encodeURIComponent(q));
      const r = (j.results || [])[0]; if (r && r.artworkUrl100) url = r.artworkUrl100.replace(/100x100bb/, '600x600bb');
    } else {
      const j = await api('/api/audio/deezer?p=' + encodeURIComponent('search/album?q=' + encodeURIComponent(q) + '&limit=1'));
      const r = (j.data || [])[0]; if (r) url = r.cover_xl || r.cover_big || '';
      if (!url && artist) { const a = await api('/api/audio/deezer?p=' + encodeURIComponent('search/artist?q=' + encodeURIComponent(artist) + '&limit=1')); const x = (a.data || [])[0]; if (x) url = x.picture_xl || x.picture_big || ''; }
    }
  } catch {}
  if (!url) { try { const j = await api('/api/audio/itunes?entity=album&term=' + encodeURIComponent(q)); const r = (j.results || [])[0]; if (r && r.artworkUrl100) url = r.artworkUrl100.replace(/100x100bb/, '600x600bb'); } catch {} }
  coverMem[key] = url; coverRemember('', '_', ''); delete coverMem['h:_'];
  return url;
}

/* ── рекомендации ──
   Ваши исполнители (что дослушиваете, что в «Моей музыке») → похожие у
   Deezer, сложенные по всем вашим исполнителям: кто похож на нескольких
   сразу, тот выше. Плюс свежие альбомы ваших исполнителей. Без истории —
   чарт. Клик — поиск лучшей раздачи. */
const deezer = p => api('/api/audio/deezer?p=' + encodeURIComponent(p));
async function buildRecs() {
  const seeds = topArtists(5), out = { similar: [], fresh: [], chart: [] };
  const own = new Set(topArtists(60).map(x => x.name.toLowerCase()));
  const score = new Map();
  await Promise.all(seeds.map(async (s, si) => {
    try {
      const a = ((await deezer('search/artist?q=' + encodeURIComponent(s.name) + '&limit=1')).data || [])[0]; if (!a) return;
      const [rel, alb] = await Promise.all([deezer('artist/' + a.id + '/related?limit=12'), deezer('artist/' + a.id + '/albums?limit=8')]);
      (rel.data || []).forEach((r, i) => {
        if (own.has(String(r.name).toLowerCase())) return;
        const cur = score.get(r.id) || { a: r, v: 0, because: [] };
        cur.v += (12 - i) * (5 - si); if (cur.because.length < 2) cur.because.push(s.name); score.set(r.id, cur);
      });
      const half = Date.now() - 200 * 864e5;
      (alb.data || []).filter(x => x.release_date && Date.parse(x.release_date) > half).forEach(x => out.fresh.push({ artist: a.name, title: x.title, cover: x.cover_xl || x.cover_big, date: x.release_date }));
    } catch {}
  }));
  out.similar = [...score.values()].sort((a, b) => b.v - a.v).slice(0, 14).map(x => ({ name: x.a.name, pic: x.a.picture_xl || x.a.picture_big, fans: x.a.nb_fan, because: x.because, id: x.a.id }));
  out.fresh.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  if (!out.similar.length) { try { out.chart = ((await deezer('chart/0/albums?limit=14')).data || []).map(x => ({ artist: x.artist && x.artist.name, title: x.title, cover: x.cover_xl || x.cover_big })); } catch {} }
  return out;
}
async function paintRecs(force) {
  const el = $('#muRecs'); if (!el) return;
  if (!mu.recs || force) {
    if (mu.recBusy) return;
    mu.recBusy = true; el.innerHTML = skeleton('Подбираю музыку под ваш вкус…', 1);
    try { mu.recs = await buildRecs(); } catch { mu.recs = { similar: [], fresh: [], chart: [], err: true }; }
    mu.recBusy = false;
    if (!$('#muRecs')) return;
  }
  const r = mu.recs;
  const card = (q, img, t1, t2, extra) => html`<div class="au-card rec"><button class="au-cover" data-mu-find="${q}" title="Найти лучшую раздачу и слушать">${raw(img ? `<img src="${esc(coverProxy(img))}" alt="" loading="lazy">` : coverFallback(q))}<span class="au-cover-play">${raw(ico('play', 22))}</span></button>
    <div class="au-card-t" title="${t1}">${t1}</div><div class="au-card-s">${t2}</div>${raw(extra || '')}</div>`;
  let h = '';
  if (r.similar.length) h += html`<div class="mu-h">Похоже на ваше <button class="btn sm ghost" data-mu-recs title="Обновить">${raw(ico('refresh', 13))}</button></div><div class="au-grid">${raw(r.similar.map(x => card(x.name, x.pic, x.name, 'как ' + x.because.join(', '), x.id ? html`<button class="au-prev" data-mu-preview="${x.id}" title="Отрывок 30 с">▶ отрывок</button>` : '')).join(''))}</div>`;
  if (r.fresh.length) h += html`<div class="mu-h">Новинки ваших исполнителей</div><div class="au-grid">${raw(r.fresh.slice(0, 10).map(x => card(x.artist + ' - ' + x.title, x.cover, x.title, x.artist + ' · ' + fmtAirDate(x.date))).join(''))}</div>`;
  if (r.chart.length) h += html`<div class="mu-h">Чарт — пока мы не знаем ваш вкус</div><div class="au-grid">${raw(r.chart.map(x => card(x.artist + ' - ' + x.title, x.cover, x.title, x.artist || '')).join(''))}</div>`;
  if (!h) h = html`<div class="empty sm">${r.err ? 'Сервисы рекомендаций сейчас не отвечают.' : 'Послушайте что-нибудь — и здесь появятся похожие исполнители и новинки.'}</div>`;
  el.innerHTML = h;
}
let previewEl = null;
async function playPreview(artistId, btn) {
  try {
    if (previewEl && !previewEl.paused && previewEl._id === artistId) { previewEl.pause(); btn.textContent = '▶ отрывок'; return; }
    const top = ((await deezer('artist/' + artistId + '/top?limit=3')).data || []).find(x => x.preview);
    if (!top) return toast('Отрывков нет', true);
    if (!previewEl) previewEl = new Audio();
    if (mu.audio && !mu.audio.paused) mu.audio.pause();
    previewEl.src = top.preview; previewEl._id = artistId; previewEl.volume = mu.audio ? mu.audio.volume : 0.8;
    await previewEl.play();
    document.querySelectorAll('[data-mu-preview]').forEach(b => { b.textContent = '▶ отрывок'; });
    btn.textContent = '❚❚ ' + top.title.slice(0, 18);
    previewEl.onended = () => { btn.textContent = '▶ отрывок'; };
  } catch { toast('Отрывок не играет', true); }
}

function onMusicClick(e) {
  if (state.view !== 'music') return;
  const t = e.target;
  const g = (sel, k) => { const b = t.closest(sel); return b ? b.dataset[k] : null; };
  let v;
  if ((v = g('[data-au-tab]', 'auTab')) != null) { mu.tab = v; savePref('tc_autab', v); paintAudioTab(); return; }
  if ((v = g('[data-mu-play]', 'muPlay')) != null) { const r = mu.rows[+v]; if (r) musicOpen(r, false, mu.rows.filter(x => x !== r)); return; }
  if ((v = g('[data-mu-save]', 'muSave')) != null) { const r = mu.rows[+v]; if (r) musicOpen(r, true); return; }
  if ((v = g('[data-mu-mine]', 'muMine')) != null) { const x = musicList()[+v]; if (!x) return; if (mu.t && mu.t.hash === x.hash && mu.kind === 'track') return musicToggle(); mu.alts = []; musicPlayHash(x.hash, x.title); return; }
  if ((v = g('[data-mu-drop]', 'muDrop')) != null) { const l = musicList(); const [gone] = l.splice(+v, 1); saveMusicList(l); paintMusicMine(); if (gone) toastUndo('Убрано из музыки: ' + gone.title, () => { const ll = musicList(); ll.splice(+v, 0, gone); saveMusicList(ll); paintMusicMine(); }); return; }
  if ((v = g('[data-mu-preview]', 'muPreview')) != null) { playPreview(+v, t.closest('[data-mu-preview]')); return; }
  if ((v = g('[data-mu-find]', 'muFind')) != null) { musicSearch(v, true); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (t.closest('[data-mu-recs]')) return paintRecs(true);
  if ((v = g('[data-mu-ix]', 'muIx')) != null) { musicPlayIx(+v); return; }
  if (t.closest('[data-mu-shuf]')) return toggleShuffle();
  if (t.closest('[data-mu-pp]')) return musicToggle();
  if (t.closest('[data-mu-prev]')) return musicNext(-1);
  if (t.closest('[data-mu-next]')) return musicNext(1);
  if (t.closest('[data-mu-stop]')) return musicStop();
  if (typeof onBookClick === 'function' && onBookClick(t)) return;
  if (typeof onRadioClick === 'function' && onRadioClick(t)) return;
}
