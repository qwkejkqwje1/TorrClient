/* ================= МУЗЫКА =================
   Отдельный маленький раздел: поиск только музыкальных раздач и плеер прямо
   в окне. Музыка живёт здесь и не расходится по программе: её раздачи не
   попадают в Библиотеку, «Продолжить просмотр», Сериалы и Главную, а играет
   она встроенным плеером, без запуска внешнего видеоплеера.
   Строгость отбора — в два слоя: трекер ищет в разделе «Музыка» (rutor 2), а
   выдача ещё раз проверяется по названию: нужен признак аудио (FLAC, MP3,
   kbps, дискография…) и не должно быть признаков видео (1080p, BDRip…). */

const MUSIC_KEY = 'tc_music';
const MUSIC_AUDIO_RE = /\b(flac|mp3|aac|alac|ape|wav|wv|ogg|opus|m4a|dsd|dsf|lossless|hi-?res|\d{2,3}\s?kbps|\d{2}\s?bit|24-?bit|16-?bit|vbr|cbr|cue)\b|дискограф|discograph|альбом|album|сингл|single\b|\bep\b|\blp\b|саундтрек|soundtrack|\bost\b|сборник|compilation|мп3/i;
const MUSIC_VIDEO_RE = /\b(2160p|1080[pi]|720p|480p|bdrip|bd-?remux|blu-?ray|web-?dl|web-?rip|hdtv|dvd-?rip|dvd5|dvd9|x264|x265|hevc|avc|xvid|mkv|avi)\b|клип[ыа]?\b|концерт.*(видео|dvd)|video/i;
function isMusicRelease(title) {
  const t = String(title || '');
  return MUSIC_AUDIO_RE.test(t) && !MUSIC_VIDEO_RE.test(t);
}
function musicList() { try { const a = JSON.parse(localStorage.getItem(MUSIC_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveMusicList(l) { try { localStorage.setItem(MUSIC_KEY, JSON.stringify(l.slice(0, 300))); } catch {} }
function musicHashes() { return new Set(musicList().map(x => x.hash).filter(Boolean)); }
/* isMusicTorrent — раздача принадлежит разделу «Музыка»: её добавили отсюда
   (категория music у TorrServer или запись в списке). Раздачу со звуком,
   добавленную через Библиотеку, раздел не забирает: её туда положили руками. */
function isMusicTorrent(t, set) {
  if (!t) return false;
  if (String(t.category || '').toLowerCase() === 'music') return true;
  return (set || musicHashes()).has(t.hash);
}

const mu = { q: '', rows: [], busy: false, err: '', queue: [], ix: -1, t: null, audio: null };

async function renderMusic(root) {
  root.innerHTML = html`<div class="mu-wrap"><div class="mu">
    <div class="mu-head"><h1 class="page-title">Музыка</h1><span class="page-sub">только аудиораздачи · играет здесь же</span></div>
    <div class="mu-search">
      <span class="sb-ico">${raw(ico('search', 18))}</span>
      <input id="muQ" placeholder="Исполнитель, альбом, саундтрек…" value="${mu.q}" autocomplete="off">
      <button id="muX" class="sb-clear${mu.q ? '' : ' hidden'}" type="button" title="Очистить (Esc)" aria-label="Очистить">${raw(ico('x', 15))}</button>
      <button id="muGo" class="primary">Найти</button>
    </div>
    <div id="muMine"></div>
    <div id="muRes"></div>
    <div id="muPlayer"></div>
  </div>${raw(dancerHtml())}</div>`;
  const q = $('#muQ');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') musicSearch(); else if (e.key === 'Escape' && q.value) { e.preventDefault(); e.stopPropagation(); q.value = ''; mu.q = ''; $('#muX').classList.add('hidden'); } });
  q.addEventListener('input', () => $('#muX').classList.toggle('hidden', !q.value));
  $('#muX').addEventListener('click', () => { q.value = ''; mu.q = ''; $('#muX').classList.add('hidden'); q.focus(); });
  $('#muGo').addEventListener('click', musicSearch);
  if (!root._muBound) { root._muBound = true; root.addEventListener('click', onMusicClick); }
  paintMusicMine(); paintMusicRes(); paintMusicPlayer();
  bindDancer();
}

async function musicSearch() {
  const q = ($('#muQ') && $('#muQ').value || '').trim();
  if (!q) return toast('Введите исполнителя или альбом', true);
  mu.q = q; mu.busy = true; mu.err = ''; mu.rows = [];
  paintMusicRes();
  const got = [];
  const jobs = [];
  if (!state.rutorOff) jobs.push(withTimeout(searchRutor(q, 0, 2), SEARCH_TIMEOUT, 'rutor не ответил').then(r => got.push(...r)).catch(e => { mu.err = e.message; }));
  // Кинозал ищет по всем разделам — строгий фильтр по названию отсекает лишнее.
  jobs.push(withTimeout(searchKinozal(q, 0), SEARCH_TIMEOUT, 'Кинозал не ответил').then(r => got.push(...r)).catch(() => {}));
  await Promise.all(jobs);
  if (mu.q !== q) return;
  const seen = new Set();
  mu.rows = mergeResults([], got).filter(r => isMusicRelease(r.title || r.name)).filter(r => { const k = r.hash || r.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.seed || 0) - (a.seed || 0)).slice(0, 60);
  mu.busy = false;
  paintMusicRes();
}

function musicFmt(r) {
  const t = r.title || r.name || '';
  const fmt = (t.match(/\b(flac|alac|ape|wav|dsd|mp3|aac|ogg|opus|m4a)\b/i) || [])[1];
  const br = (t.match(/\b(\d{2,3})\s?kbps\b/i) || [])[1];
  const bit = (t.match(/\b(24|16)\s?-?bit\b/i) || [])[1];
  return [fmt && fmt.toUpperCase(), br && br + ' kbps', bit && bit + ' bit'].filter(Boolean).join(' · ');
}
function paintMusicRes() {
  const el = $('#muRes'); if (!el) return;
  if (mu.busy) { el.innerHTML = skeleton('Ищу музыку…', 3); return; }
  if (!mu.q) { el.innerHTML = ''; return; }
  if (!mu.rows.length) { el.innerHTML = html`<div class="empty">Музыкальных раздач не нашлось.${mu.err ? ' ' + mu.err : ''}</div>`; return; }
  const mine = musicHashes();
  el.innerHTML = html`<div class="mu-h">Найдено ${mu.rows.length}</div><div class="mu-list">${raw(mu.rows.map((r, i) => html`
    <div class="mu-row">
      <button class="mu-play" data-mu-play="${i}" title="Слушать">${raw(ico('play', 14))}</button>
      <div class="mu-main"><div class="mu-t" title="${r.title || r.name}">${r.title || r.name}</div>
        <div class="mu-s">${[musicFmt(r), r.size_bytes ? fmtSize(r.size_bytes) : r.size || '', '⬆ ' + (r.seed || 0)].filter(Boolean).join(' · ')}</div></div>
      <button class="iconbtn${r.hash && mine.has(r.hash) ? ' on' : ''}" data-mu-save="${i}" title="В мою музыку">${raw(ico('plus', 15))}</button>
    </div>`).join(''))}</div>`;
}
function paintMusicMine() {
  const el = $('#muMine'); if (!el) return;
  const l = musicList();
  if (!l.length) { el.innerHTML = ''; return; }
  el.innerHTML = html`<div class="mu-h">Моя музыка</div><div class="mu-chips">${raw(l.map((x, i) => html`<span class="mu-chip${mu.t && mu.t.hash === x.hash ? ' on' : ''}"><button data-mu-mine="${i}" title="${x.title}">${raw(ico('play', 12))}${x.title}</button><button class="mu-chip-x" data-mu-drop="${i}" title="Убрать из моей музыки">×</button></span>`).join(''))}</div>`;
}

/* Раздача добавляется в TorrServer с категорией music: так её узнают и
   после перезапуска, и с другого окна, где нет записи в localStorage. */
async function musicOpen(r, keep) {
  try {
    let hash = r.hash || ((r.magnet || '').match(/btih:([0-9a-fA-F]{40})/i) || [])[1] || '';
    if (!hash && (r.get || r.link)) {
      toast('Забираю раздачу с Кинозала…');
      const rr = await fetch('/api/kinozal/add?url=' + encodeURIComponent(r.get || r.link) + '&title=' + encodeURIComponent(r.title || '') + '&size=' + encodeURIComponent(r.size || ''), { method: 'POST' });
      const j = await rr.json().catch(() => null);
      if (!rr.ok || !j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + rr.status);
      if (j.magnet) await torrentAction('add', { link: j.magnet, save_to_db: true, category: 'music' }).catch(() => {});
      hash = ((j.hash || j.magnet || '').match(/([0-9a-fA-F]{40})/) || [])[1] || '';
    }
    hash = String(hash).toLowerCase();
    if (!hash) throw new Error('не удалось узнать хеш раздачи');
    const title = cleanMusicTitle(r.title || r.name || hash);
    await torrentAction('add', { link: r.magnet || magnetFromHash(hash, title), title, category: 'music', save_to_db: true }).catch(() => {});
    await torrentAction('set', { hash, title, category: 'music' }).catch(() => {});
    const l = musicList();
    if (!l.some(x => x.hash === hash)) { l.unshift({ hash, title, added: Date.now() }); saveMusicList(l); }
    else if (keep) toast('Уже в вашей музыке');
    paintMusicMine(); paintMusicRes();
    if (keep) { toast('Добавлено в музыку'); return; }
    await musicPlayHash(hash, title);
  } catch (e) { toast('Музыка: ' + e.message, true); }
}
function cleanMusicTitle(t) {
  const s = String(t || '').replace(/\s*[\[(](?:flac|mp3|aac|alac|ape|\d{2,3}\s?kbps|lossless|24.?bit|16.?bit|web|cd)[^\])]*[\])]/gi, '').replace(/\s*\|\s*.*$/, '').replace(/\s{2,}/g, ' ').trim();
  return s.length > 2 ? s.slice(0, 120) : String(t || '').slice(0, 120);
}
async function musicPlayHash(hash, title) {
  const st = await waitForFiles({ hash, title });
  if (!st) return;
  const files = (st.file_stats || []).filter(f => isAudio(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'ru', { numeric: true }));
  if (!files.length) return toast('В раздаче нет аудиофайлов', true);
  mu.t = { hash, title: title || st.title || hash };
  mu.queue = files; mu.ix = 0;
  musicPlayIx(0);
  paintMusicMine();
}
function musicAudio() {
  if (mu.audio) return mu.audio;
  // Элемент живёт в body: переход по разделам не обрывает трек на середине.
  const a = document.createElement('audio');
  a.preload = 'auto'; a.id = 'muAudio';
  a.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('tc_muvol') || 0.8)));
  a.addEventListener('ended', () => musicNext(1));
  a.addEventListener('timeupdate', paintMusicProgress);
  a.addEventListener('play', () => { paintMusicPlayer(); paintNowPlaying(); });
  a.addEventListener('pause', () => { paintMusicPlayer(); paintNowPlaying(); });
  a.addEventListener('error', () => { if (mu.ix >= 0) toast('Трек не играет в окне — формат не поддерживается браузером', true); });
  document.body.appendChild(a);
  mu.audio = a;
  return a;
}
function musicPlayIx(i) {
  if (i < 0 || i >= mu.queue.length) return;
  mu.ix = i;
  const f = mu.queue[i];
  const a = musicAudio();
  a.src = ts(`/stream/${encodeURIComponent(basename(f.path))}?link=${encodeURIComponent(mu.t.hash)}&index=${f.id}&play`);
  a.play().catch(() => {});
  paintMusicPlayer(); paintNowPlaying();
}
function musicNext(d) { if (mu.ix + d >= 0 && mu.ix + d < mu.queue.length) musicPlayIx(mu.ix + d); else { paintMusicPlayer(); paintNowPlaying(); } }
function musicToggle() { const a = musicAudio(); if (!a.src) return; if (a.paused) a.play().catch(() => {}); else a.pause(); }
function musicStop() { if (mu.audio) { mu.audio.pause(); mu.audio.removeAttribute('src'); mu.audio.load(); } mu.ix = -1; mu.t = null; mu.queue = []; paintMusicPlayer(); paintNowPlaying(); paintMusicMine(); }
function musicTrackName(f) { return f ? basename(f.path).replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, '') : ''; }
function paintMusicPlayer() {
  const el = $('#muPlayer'); if (!el) return;
  if (!mu.t || mu.ix < 0) { el.innerHTML = ''; return; }
  const a = mu.audio;
  const f = mu.queue[mu.ix];
  el.innerHTML = html`<div class="mu-bar">
    <div class="mu-bar-t"><b title="${musicTrackName(f)}">${musicTrackName(f)}</b><small>${mu.t.title} · ${mu.ix + 1}/${mu.queue.length}</small></div>
    <div class="mu-ctl">
      <button class="iconbtn" data-mu-prev title="Предыдущий" ${mu.ix > 0 ? '' : 'disabled'}>${raw(ico('prev', 16))}</button>
      <button class="iconbtn mu-pp" data-mu-pp title="Пауза / играть">${raw(ico(a && !a.paused ? 'pause' : 'play', 17))}</button>
      <button class="iconbtn" data-mu-next title="Следующий" ${mu.ix < mu.queue.length - 1 ? '' : 'disabled'}>${raw(ico('next', 16))}</button>
      <button class="iconbtn" data-mu-stop title="Остановить">${raw(ico('stop', 14))}</button>
    </div>
    <input type="range" class="mu-seek" min="0" max="1000" value="0" id="muSeek" title="Перемотка">
    <span class="mu-time" id="muTime">0:00</span>
    <input type="range" class="mu-vol" min="0" max="100" value="${Math.round((a ? a.volume : 0.8) * 100)}" id="muVol" title="Громкость">
    <details class="mu-q"><summary title="Список треков">≡</summary><div>${raw(mu.queue.map((x, i) => html`<button class="${i === mu.ix ? 'on' : ''}" data-mu-ix="${i}">${i + 1}. ${musicTrackName(x)}</button>`).join(''))}</div></details>
  </div>`;
  const sk = $('#muSeek'); sk.addEventListener('input', () => { const au = mu.audio; if (au && isFinite(au.duration)) au.currentTime = au.duration * sk.value / 1000; });
  const vo = $('#muVol'); vo.addEventListener('input', () => { const au = musicAudio(); au.volume = vo.value / 100; savePref('tc_muvol', au.volume); });
  paintMusicProgress();
}
function paintMusicProgress() {
  const a = mu.audio; if (!a) return;
  const sk = $('#muSeek'), tm = $('#muTime');
  if (sk && isFinite(a.duration) && a.duration > 0 && document.activeElement !== sk) sk.value = Math.round(a.currentTime / a.duration * 1000);
  if (tm) tm.textContent = fmtPos(a.currentTime || 0) + (isFinite(a.duration) ? ' / ' + fmtPos(a.duration) : '');
}
function onMusicClick(e) {
  if (state.view !== 'music') return;
  const t = e.target;
  const g = (sel, k) => { const b = t.closest(sel); return b ? b.dataset[k] : null; };
  let v;
  if ((v = g('[data-mu-play]', 'muPlay')) != null) { const r = mu.rows[+v]; if (r) musicOpen(r, false); return; }
  if ((v = g('[data-mu-save]', 'muSave')) != null) { const r = mu.rows[+v]; if (r) musicOpen(r, true); return; }
  if ((v = g('[data-mu-mine]', 'muMine')) != null) { const x = musicList()[+v]; if (x) musicPlayHash(x.hash, x.title); return; }
  if ((v = g('[data-mu-drop]', 'muDrop')) != null) { const l = musicList(); const [gone] = l.splice(+v, 1); saveMusicList(l); paintMusicMine(); if (gone) toastUndo('Убрано из музыки: ' + gone.title, () => { const ll = musicList(); ll.splice(+v, 0, gone); saveMusicList(ll); paintMusicMine(); }); return; }
  if ((v = g('[data-mu-ix]', 'muIx')) != null) { musicPlayIx(+v); return; }
  if (t.closest('[data-mu-pp]')) return musicToggle();
  if (t.closest('[data-mu-prev]')) return musicNext(-1);
  if (t.closest('[data-mu-next]')) return musicNext(1);
  if (t.closest('[data-mu-stop]')) return musicStop();
}
