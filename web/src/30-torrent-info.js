/* ---------- torrent info modal ---------- */
function openTorrentModal(t) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  const files = t.file_stats || [];
  const vm = lookupView(t.hash);
  ov.innerHTML = html`<div class="modal wide">
    <button class="modal-close" data-close>✕</button>
    <div class="row"><div style="flex:1"><h2 style="margin-top:0">${t.title || t.name || t.hash}</h2>
      <div class="row wrap">
        ${raw(t.category ? html`<span class="chip grey">${t.category}</span>` : '')}
        ${raw(t.torrent_size ? html`<span class="chip">${fmtSize(t.torrent_size)}</span>` : '')}
        ${raw(t.duration_seconds ? html`<span class="chip">${fmtDur(t.duration_seconds)}</span>` : '')}
        ${raw(isSeries(t.title || '') ? html`<span class="chip series">${seriesTag(t.title || '')}</span>` : '')}
        ${raw(t.bit_rate ? html`<span class="chip">${t.bit_rate}</span>` : '')}
      </div></div>
      ${raw(t.poster ? html`<img src="${pimg(t.poster)}" style="height:110px; border-radius:8px" onerror="this.remove()">` : '')}
    </div>
    <div class="divider"></div>
    <div class="tabs" id="infoTabs">
      <button data-tab="files" class="on">Файлы (${files.length})</button>
      <button data-tab="media">Информация о медиа</button>
      <button data-tab="stats">Статистика</button>
    </div>
    <div id="infoFiles"></div>
    <div id="infoMedia" class="hidden media-info"></div>
    <div id="infoStats" class="hidden"></div>
    <div class="divider"></div>
    <div id="infoPlayer"></div>
  </div>`;
  document.body.appendChild(ov);
  const paintFiles = () => {
    const el = ov.querySelector('#infoFiles');
    el.innerHTML = html`<table><thead><tr><th>Файл</th><th>Размер</th><th>Статус</th></tr></thead><tbody>${raw(files.map(f => html`
      <tr><td><code class="inline">${f.path}</code></td><td>${fmtSize(f.length)}</td>
      <td>${raw(vm[f.id] && vm[f.id].done ? '<span class="chip">просмотрено</span>' : (vm[f.id] && vm[f.id].timecode ? html`<span class="chip">${fmtDur(vm[f.id].timecode)}</span>` : ''))}</td></tr>`).join(''))}</tbody></table>`;
  };
  paintFiles();
  ov.querySelector('#infoTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    $$('#infoTabs button').forEach(x => x.classList.remove('on')); b.classList.add('on');
    const tab = b.dataset.tab;
    ['#infoFiles', '#infoMedia', '#infoStats'].forEach(s => ov.querySelector(s).classList.add('hidden'));
    if (tab === 'files') { ov.querySelector('#infoFiles').classList.remove('hidden'); paintFiles(); }
    if (tab === 'media') { ov.querySelector('#infoMedia').classList.remove('hidden'); paintMedia(ov, t); }
    if (tab === 'stats') { ov.querySelector('#infoStats').classList.remove('hidden'); paintStats(ov, t); }
  });
  bindTorrentPlay(ov, t, files);
}

function paintStats(ov, t) {
  let h = '<div class="stat-line" style="display:grid; grid-template-columns:1fr 1fr; gap:6px 20px; max-width:520px">';
  const rows = [
    ['Статус', t.stat_string || t.stat], ['Загружено', fmtSize(t.loaded_size)],
    ['Размер торрента', fmtSize(t.torrent_size)], ['Скорость (вниз)', fmtSpeed(t.download_speed || 0)],
    ['Скорость (вверх)', fmtSpeed(t.upload_speed || 0)], ['Пиры (всего)', t.total_peers],
    ['Активные пиры', t.active_peers], ['Сиды', t.connected_seeders],
    ['Прочитано', fmtSize(t.bytes_read)], ['Записано', fmtSize(t.bytes_written)],
  ];
  rows.forEach(([k, v]) => h += html`<div><b>${k}:</b> ${v}</div>`);
  h += '</div>';
  ov.querySelector('#infoStats').innerHTML = h;
}

async function paintMedia(ov, t) {
  const el = ov.querySelector('#infoMedia');
  el.classList.remove('hidden');
  el.innerHTML = '<div class="stat-line">Анализ потоков (ffprobe)...</div>';
  const vf = (t.file_stats || []).find(f => isVideo(f.path));
  if (!vf) { el.innerHTML = '<div class="empty">Видео не найдено</div>'; return; }
  try {
    const r = await fetch(ts(`/ffp/${t.hash}/${vf.id}`));
    const txt = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = JSON.parse(txt);
    const fmt = j.format || {};
    const streams = (j.streams || []).map(s => {
      const kind = s.codec_type === 'video' ? 'Видео' : s.codec_type === 'audio' ? 'Звук' : s.codec_type === 'subtitle' ? 'Субтитры' : s.codec_type;
      return html`<div><b>${kind}:</b> ${s.codec_name || ''} ${raw(s.width ? html`${s.width}×${s.height}` : '')} ${s.bit_rate ? fmtSize(parseInt(s.bit_rate)) + '/с' : ''} ${s.duration ? fmtDur(parseFloat(s.duration)) : ''}</div>`;
    }).join('');
    const pv = playVerdict(j);
    const fileDura = t.file_stats_rev ? (t.file_stats_rev[vf.id] && t.file_stats_rev[vf.id].length) : '';
    el.innerHTML = html`<div class="stat-line">
      <div><b>Контейнер:</b> ${fmt.format_name || ''} · ${fmt.format_long_name || ''}</div>
      <div><b>Длительность:</b> ${fmt.duration ? fmtDur(parseFloat(fmt.duration)) : ''}</div>
      <div><b>Размер:</b> ${fmt.size ? fmtSize(parseInt(fmt.size)) : ''}</div>
      ${raw(t.bit_rate ? html`<div><b>Битрейт:</b> ${t.bit_rate}</div>` : '')}
      <div class="divider"></div>${raw(streams || '—')}
      <div class="divider"></div>
      <div class="${pv.ok ? '' : 'hint'}"><b>${pv.ok ? '✔' : '⚠'}</b> ${pv.text}${pv.ru ? ' Русская дорожка есть.' : ''}</div>
    </div>`;
  } catch (e) { el.innerHTML = html`<div class="empty">Не удалось проанализировать (возможно, ffmpeg недоступен на сервере): ${e.message}</div>`; }
}

/* ================= FAVORITES + BOOKMARKS ================= */
function favList() { try { const a = JSON.parse(localStorage.getItem('tc_userlist') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveFavList(l) { try { localStorage.setItem('tc_userlist', JSON.stringify(l)); } catch {} syncUserData(); }
function getBookmarks() { try { const a = JSON.parse(localStorage.getItem('tc_bm') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveBookmarks(l) { try { localStorage.setItem('tc_bm', JSON.stringify(l)); } catch {} syncUserData(); }
function userDataPayload() {
  let fav = [], bm = [], colls = [];
  try { fav = JSON.parse(localStorage.getItem('tc_userlist') || '[]'); } catch {}
  try { bm = JSON.parse(localStorage.getItem('tc_bm') || '[]'); } catch {}
  try { colls = JSON.parse(localStorage.getItem(COLLS_KEY) || '[]'); } catch {}
  return {
    favorites: Array.isArray(fav) ? fav : [],
    bookmarks: Array.isArray(bm) ? bm : [],
    collections: Array.isArray(colls) ? colls : [],
  };
}
function syncUserData() { fetch('/api/userdata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(userDataPayload()) }).catch(() => {}); }
async function loadUserData() {
  try {
    const j = await api('/api/userdata');
    /* Склад рядом с демоном — источник правды, но только если в него хоть раз
       писали: у свежей сборки он пуст, и «на сервере пусто» означало бы
       стирание списка, накопленного в браузере до первого сохранения. Прежде
       пустой серверный список просто игнорировался, поэтому удалённое в одном
       браузере возвращалось из другого: устаревшее локальное всегда побеждало. */
    if (!j.stored) {
      if (favList().length || getBookmarks().length || collList().length) syncUserData();
      return;
    }
    localStorage.setItem('tc_userlist', JSON.stringify(Array.isArray(j.favorites) ? j.favorites : []));
    localStorage.setItem('tc_bm', JSON.stringify(Array.isArray(j.bookmarks) ? j.bookmarks : []));
    // Подборки, как и избранное, лежат на сервере: они переживают переустановку
    // браузера и едут в архив состояния вместе с остальным.
    localStorage.setItem(COLLS_KEY, JSON.stringify(Array.isArray(j.collections) ? j.collections : []));
  } catch {}
}

/* ---------- подборки ----------
   Подборка — именованный список раздач. Ими заменяется единственное
   «Избранное»: одного списка мало, когда библиотека на сотни раздач, а
   переименовать или разложить по полкам его было нельзя.

   В списке хранятся хеши: сама раздача живёт на сервере, и дублировать её
   описание в подборке незачем — название и постер берутся из библиотеки. Хеш
   переживает переименование раздачи, а вот название раздачи — нет. */
const COLLS_KEY = 'tc_colls';

function collList() {
  try {
    const a = JSON.parse(localStorage.getItem(COLLS_KEY) || '[]');
    return Array.isArray(a) ? a.filter(c => c && typeof c === 'object' && c.id) : [];
  } catch { return []; }
}
function saveCollList(l) { try { localStorage.setItem(COLLS_KEY, JSON.stringify(l)); } catch {} syncUserData(); }
function collById(id) { return collList().find(c => c.id === id) || null; }
function collHas(id, hash) { const c = collById(id); return !!(c && (c.items || []).indexOf(hash) >= 0); }
function collCreate(name) {
  const list = collList();
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  list.push({ id, name: String(name || 'Подборка').slice(0, 60), items: [] });
  saveCollList(list);
  return id;
}
// Возвращает признак «теперь в подборке»: по нему интерфейс говорит, что
// добавлено, а что убрано, — не переспрашивая список заново.
function collToggle(id, hash) {
  const list = collList();
  const c = list.find(x => x.id === id);
  if (!c) return false;
  const items = Array.isArray(c.items) ? c.items : [];
  const at = items.indexOf(hash);
  if (at >= 0) { items.splice(at, 1); c.items = items; saveCollList(list); return false; }
  c.items = items.concat([hash]);
  saveCollList(list);
  return true;
}
function collRemove(id) {
  const list = collList().filter(c => c.id !== id);
  saveCollList(list);
  if (state.coll === id) state.coll = '';
}

/* watchState — состояние просмотра раздачи: не начато, начато, досмотрено.
   Считается по видеофайлам: у сериала «досмотрено» означает все серии, одна
   начатая серия делает раздачу начатой. Нет известных файлов (статистика ещё не
   подгружена) — раздача считается не начатой, а не пропадает из выдачи. */
function watchState(t) {
  const vids = playableOf(t).filter(f => isVideo(f.path));
  if (!vids.length) return 'new';
  const done = vids.filter(f => isWatched(t, f.id)).length;
  if (done >= vids.length) return 'done';
  if (done > 0 || vids.some(f => viewedShare(t, f.id) > 0)) return 'started';
  return 'new';
}
// Доля просмотренного: у сериала — по сериям, у фильма — по первому файлу.
function libProgress(t) {
  const sp = seriesProgress(t);
  if (sp) return sp.share;
  const f = playableOf(t).filter(x => isVideo(x.path))[0];
  return f ? viewedShare(t, f.id) : 0;
}
/* Отметка одного файла. Досмотр и позиция — разные вещи: у досмотренной серии
   позиция обнуляется, поэтому «просмотрено» определяется признаком done, а не
   положительным временем. По времени досмотренная серия выглядела непросмотренной. */
/* marksIndex — те же отметки, разложенные по хешу раздачи. Строится по
   требованию и живёт до первого изменения отметок.

   Прежде поиск шёл по всему массиву на каждый файл: плитка сериала спрашивает
   про каждый файл дважды (досмотр и позиция), то есть 200 раздач × 100 файлов ×
   500 отметок давали на каждую перерисовку миллионы сравнений. Перерисовка же
   идёт на каждый ввод буквы в фильтре и на каждое событие positions. Индекс
   строится один раз за весь проход — столько же работы, сколько один поиск. */
let marksIndex = null;
let marksIndexArr = null;
let marksIndexLen = -1;

/* Сброс нужен ровно там, где запись отметки заменяется на месте новым объектом
   (так приходит событие positions): смену самого массива и его рост индекс
   замечает сам, и вызывать сброс из каждого места не требуется — забытый сброс
   означал бы устаревшие отметки на экране. */
function invalidateMarks() { marksIndex = null; }
function marksFor(hash) {
  const arr = state.viewed || [];
  if (!marksIndex || marksIndexArr !== arr || marksIndexLen !== arr.length) {
    marksIndex = {};
    marksIndexArr = arr;
    marksIndexLen = arr.length;
    arr.forEach(v => {
      if (!v) return;
      let m = marksIndex[v.hash];
      if (!m) m = marksIndex[v.hash] = {};
      m[v.file_index] = v;
    });
  }
  return marksIndex[hash] || null;
}
function markOf(t, fi) { const m = marksFor(t.hash); return (m && m[fi]) || null; }
function currentTc(t, fi) { const v = markOf(t, fi); return v && !v.done ? (v.timecode || 0) : 0; }
function isWatched(t, fi) { const v = markOf(t, fi); return !!(v && v.done); }
function viewedShare(t, fi) { const v = markOf(t, fi); return v && v.duration > 0 ? Math.min(1, (v.timecode || 0) / v.duration) : 0; }
function fmtPos(s) {
  if (!s) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
  return (h ? h + ' ч ' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
/* tracking реальной позиции: сервер /viewed не ведёт время, считаем от момента запуска */
function trackPlay(hash, fi, base) {
  state.play = { hash, fi, base: base || 0, at: Date.now() };
  notePlayed(hash, fi);
}
/* Когда раздачу запускали в последний раз. Отметка демона обновляется, только
   пока плеер сообщает позицию; раздача, запущенная в плеере без канала, с
   телефона или из списка TorrServer, шла с нулевым временем в самый конец
   «Продолжить просмотр» — хотя её открыли только что. */
const LASTPLAY_KEY = 'tc_lastplay';
function lastPlayed() { try { const o = JSON.parse(localStorage.getItem(LASTPLAY_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function notePlayed(hash, fi) {
  if (!hash) return;
  const o = lastPlayed();
  o[hash] = { at: Date.now(), fi: fi | 0 };
  // Хранится только свежее: сотня записей с запасом покрывает полосу.
  const keep = Object.entries(o).sort((a, b) => b[1].at - a[1].at).slice(0, 100);
  try { localStorage.setItem(LASTPLAY_KEY, JSON.stringify(Object.fromEntries(keep))); } catch {}
}
function estimatePos(hash, fi) {
  const p = state.play;
  if (p && p.hash === hash && p.fi === fi) {
    const sec = (Date.now() - p.at) / 1000;
    if (sec >= 0 && sec < 6 * 3600) return Math.round(p.base + sec);
  }
  return 0;
}
function addBookmark(t, fi, fname, explicitPos) {
  let list = getBookmarks();
  // Позицию ведёт демон, пока играет плеер. Оценка по времени с момента запуска
  // — запасной путь для плеера, который о себе не сообщает.
  const pos = explicitPos != null && explicitPos > 0 ? explicitPos : (currentTc(t, fi) || estimatePos(t.hash, fi));
  const prev = list.find(x => x.hash === t.hash && x.file_index === fi);
  list = list.filter(x => !(x.hash === t.hash && x.file_index === fi));
  list.unshift({ hash: t.hash, file_index: fi, file: fname || (prev && prev.file) || '', title: t.title || t.name || (prev && prev.title) || '', poster: t.poster || (prev && prev.poster) || '', pos, updated: Date.now() });
  saveBookmarks(list);
  toast(pos > 0 ? 'Закладка: ' + fmtPos(pos) : 'Закладка сохранена (с 0:00)');
}
function delBookmark(b) { saveBookmarks(getBookmarks().filter(x => !(x.hash === b.hash && x.file_index === b.file_index))); }

