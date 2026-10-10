/* ================= АУДИО · АУДИОКНИГИ =================
   Полка книг с прогрессом, продолжение с места, закладки с подписью, скорость
   чтения и скачивание для офлайна. Позиция пишется каждые 5 секунд и при
   паузе; при продолжении плеер отступает на 3 секунды назад, чтобы не терять
   фразу. Офлайн — файлы книги скачиваются в папку загрузок (как обычные
   загрузки) и дальше играют с диска через демон, без TorrServer и сети. */

const bk = { q: '', rows: [], busy: false, err: '', open: null, files: {}, dlPoll: 0 };
const BOOK_RE = /аудиокниг|audio\s?book|аудиоспектакл|радиоспектакл|радиопостановк|чита(ет|ют|ла)\b|чтец|исполнител[ья]|\bm4b\b|\bmp3\b|\baac\b|kbps|аудио/i;
const BOOK_NOT_RE = /\b(pdf|fb2|epub|djvu|mobi|azw3?|docx?|rtf|txt)\b/i;
function isBookRelease(t) { t = String(t || ''); return BOOK_RE.test(t) && !(BOOK_NOT_RE.test(t) && !/\bmp3\b|аудио/i.test(t)) && !MUSIC_VIDEO_RE.test(t); }
function bookList() { const a = jsonPref('tc_books', []); return Array.isArray(a) ? a : []; }
function saveBooks(l) { saveJson('tc_books', l.slice(0, 200)); }
function bookPosAll() { return jsonPref('tc_bookpos', {}); }
function bookSpeed() { const v = Number(localStorage.getItem('tc_bkspeed') || 1); return v >= 0.5 && v <= 3 ? v : 1; }
function bookSetSpeed(v) { savePref('tc_bkspeed', v); }
function bookMarks(hash) { return (jsonPref('tc_bookmarks', {})[hash] || []); }
function saveBookMarks(hash, l) { const all = jsonPref('tc_bookmarks', {}); all[hash] = l.slice(0, 200); saveJson('tc_bookmarks', all); }
function bookOffAll() { return jsonPref('tc_bookoff', {}); }
function bookOfflinePath(hash, id) { const o = bookOffAll()[hash]; return (o && o.files && o.files[id]) || ''; }
function bookKeepFiles(hash, files) {
  bk.files[hash] = files;
  const meta = jsonPref('tc_bookmeta', {}); meta[hash] = files.map(f => ({ id: f.id, path: f.path, length: f.length })); saveJson('tc_bookmeta', meta);
}
function bookFiles(hash) { return bk.files[hash] || jsonPref('tc_bookmeta', {})[hash] || null; }
function bookResumeIx(hash, files) { const p = bookPosAll()[hash]; return p && p.ix < files.length ? p.ix : 0; }
function bookResumeAt(hash, i) { const p = bookPosAll()[hash]; return p && p.ix === i ? Math.max(0, p.t - 3) : 0; }
let bookSaveAt = 0;
function bookSavePos(force) {
  const a = mu.audio; if (mu.kind !== 'book' || !mu.t || !a) return;
  if (!force && Date.now() - bookSaveAt < 5000) return;
  bookSaveAt = Date.now();
  const all = bookPosAll();
  all[mu.t.hash] = { ix: mu.ix, t: a.ended ? 0 : a.currentTime || 0, d: isFinite(a.duration) ? a.duration : 0, n: mu.queue.length, at: Date.now() };
  if (a.ended && mu.ix + 1 < mu.queue.length) all[mu.t.hash].ix = mu.ix + 1;
  saveJson('tc_bookpos', all);
}
function bookProgress(hash) {
  const p = bookPosAll()[hash]; if (!p || !p.n) return 0;
  return Math.min(1, (p.ix + (p.d ? p.t / p.d : 0)) / p.n);
}

function renderBooks(el) {
  el.innerHTML = html`<div class="mu-search">
      <span class="sb-ico">${raw(ico('search', 18))}</span>
      <input id="bkQ" placeholder="Название книги или автор…" value="${bk.q}" autocomplete="off">
      <button id="bkGo" class="primary">Найти</button>
    </div>
    <div id="bkBody"></div>`;
  const q = $('#bkQ');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') bookSearch(); });
  $('#bkGo').addEventListener('click', bookSearch);
  paintBooks();
}
async function bookSearch() {
  const q = ($('#bkQ').value || '').trim(); if (!q) return toast('Введите название или автора', true);
  bk.q = q; bk.busy = true; bk.rows = []; bk.open = null; paintBooks();
  const res = await audioTrackerSearch(q, 11, isBookRelease, 0.7);
  if (bk.q !== q) return;
  bk.rows = res.rows; bk.err = res.err; bk.busy = false; paintBooks();
}
function paintBooks() {
  const el = $('#bkBody'); if (!el) return;
  if (bk.open) return paintBookOpen(el);
  let h = '';
  const shelf = bookList();
  if (bk.busy) h += skeleton('Ищу аудиокниги и выбираю раздачу побыстрее…', 3);
  else if (bk.q) {
    h += bk.rows.length ? html`<div class="mu-h">Найдено ${bk.rows.length} · сверху самая быстрая</div><div class="mu-list">${raw(bk.rows.map((r, i) => html`
      <div class="mu-row${i === 0 ? ' best' : ''}">
        <button class="mu-play" data-bk-add="${i}" data-play="1" title="Слушать">${raw(ico('play', 14))}</button>
        <div class="mu-main"><div class="mu-t" title="${r.title}">${i === 0 ? raw('<span class="mu-badge">быстрее всех</span>') : ''}${r.title}</div>
          <div class="mu-s">${[musicFmt(r), r.size_bytes ? fmtSize(r.size_bytes) : r.size || '', '⬆ ' + (r.seed || 0)].filter(Boolean).join(' · ')}</div></div>
        <button class="iconbtn" data-bk-add="${i}" title="На полку">${raw(ico('plus', 15))}</button>
      </div>`).join(''))}</div>` : html`<div class="empty">Аудиокниг не нашлось.${bk.err ? ' ' + bk.err : ''}</div>`;
  }
  if (shelf.length) {
    const off = bookOffAll();
    h += html`<div class="mu-h">Моя полка</div><div class="au-grid">${raw(shelf.map((b, i) => { const p = bookProgress(b.hash); return html`
      <div class="au-card book${mu.t && mu.t.hash === b.hash ? ' on' : ''}">
        <button class="au-cover" data-bk-open="${i}" title="${b.title}">${raw(coverImg(b.title, b.hash, 'book'))}${raw(off[b.hash] && off[b.hash].done ? '<span class="au-off" title="Доступна офлайн">⤓</span>' : '')}</button>
        <div class="au-prog"><i style="width:${Math.round(p * 100)}%"></i></div>
        <div class="au-card-t" title="${b.title}">${b.title}</div>
        <div class="au-card-s">${p ? Math.round(p * 100) + '% прослушано' : 'не начата'}</div>
      </div>`; }).join(''))}</div>`;
  } else if (!bk.q && !bk.busy) h += html`<div class="empty">Найдите книгу — она ляжет на полку, а место, где вы остановились, запомнится.</div>`;
  el.innerHTML = h;
  hydrateCovers(el);
}
async function paintBookOpen(el) {
  const b = bookList().find(x => x.hash === bk.open); if (!b) { bk.open = null; return paintBooks(); }
  let files = bookFiles(b.hash);
  const pos = bookPosAll()[b.hash], marks = bookMarks(b.hash), off = bookOffAll()[b.hash], p = bookProgress(b.hash);
  const playingHere = mu.t && mu.t.hash === b.hash && mu.kind === 'book';
  el.innerHTML = html`<div class="bk-open">
    <button class="btn sm ghost" data-bk-back-shelf>← Полка</button>
    <div class="bk-hero">
      <div class="bk-cov">${raw(coverImg(b.title, b.hash, 'book'))}</div>
      <div class="bk-info"><h2>${b.title}</h2>
        <div class="au-prog big"><i style="width:${Math.round(p * 100)}%"></i></div>
        <div class="mu-s">${p ? Math.round(p * 100) + '% · глава ' + ((pos && pos.ix) + 1) + (files ? ' из ' + files.length : '') + ' · ' + fmtPos((pos && pos.t) || 0) : 'не начата'}</div>
        <div class="bk-acts">
          <button class="btn primary" data-bk-play>${raw(ico(playingHere && auPlaying() ? 'pause' : 'play', 15))} ${p ? 'Продолжить' : 'Слушать'}</button>
          ${raw(off && off.done ? html`<span class="bk-offok">⤓ Доступна офлайн</span>` : off && off.jobs ? html`<span class="bk-offok" id="bkDl">Скачиваю…</span>` : html`<button class="btn" data-bk-dl>${raw(ico('download', 15))} Скачать для офлайна</button>`)}
          <button class="btn ghost" data-bk-drop>Убрать с полки</button>
        </div></div></div>
    <div class="mu-h">Закладки</div>
    ${raw(marks.length ? html`<div class="mu-list">${raw(marks.map((m, i) => html`<div class="mu-row"><button class="mu-play" data-bk-go="${i}" title="Перейти">${raw(ico('bookmark', 14))}</button><div class="mu-main"><div class="mu-t">${m.note || 'Закладка'}</div><div class="mu-s">глава ${m.ix + 1} · ${fmtPos(m.t)} · ${new Date(m.at).toLocaleDateString('ru-RU')}</div></div><button class="iconbtn" data-bk-unmark="${i}" title="Удалить закладку">×</button></div>`).join(''))}</div>` : html`<div class="empty sm">Пока нет. Во время прослушивания нажмите ${raw(ico('bookmark', 13))} в плеере.</div>`)}
    <div class="mu-h">Главы</div><div class="mu-list" id="bkCh">${raw(files ? bookChaptersHtml(b.hash, files) : skeleton('Получаю список глав…', 2))}</div>
  </div>`;
  hydrateCovers(el);
  if (off && off.jobs) bookDlWatch();
  if (!files) {
    const st = await waitForFiles({ hash: b.hash, title: b.title });
    if (st && bk.open === b.hash) { files = (st.file_stats || []).filter(f => isAudio(f.path)).sort((a, c) => a.path.localeCompare(c.path, 'ru', { numeric: true })); bookKeepFiles(b.hash, files); const ch = $('#bkCh'); if (ch) ch.innerHTML = bookChaptersHtml(b.hash, files); }
  }
}
function bookChaptersHtml(hash, files) {
  const pos = bookPosAll()[hash] || { ix: -1 };
  return files.map((f, i) => html`<div class="mu-row${i === pos.ix ? ' best' : ''}"><button class="mu-play" data-bk-ch="${i}">${raw(i < pos.ix ? '✓' : ico('play', 13))}</button><div class="mu-main"><div class="mu-t">${musicTrackName(f)}</div><div class="mu-s">${[f.length ? fmtSize(f.length) : '', bookOfflinePath(hash, f.id) ? 'на диске' : '', i === pos.ix ? 'остановились на ' + fmtPos(pos.t) : ''].filter(Boolean).join(' · ')}</div></div></div>`).join('');
}
async function bookPlay(hash, ix, at) {
  const b = bookList().find(x => x.hash === hash); if (!b) return;
  if (mu.t && mu.t.hash === hash && mu.kind === 'book' && ix == null) return musicToggle();
  const files = bookFiles(hash);
  const allOff = files && files.every(f => bookOfflinePath(hash, f.id));
  if (ix != null) { const all = bookPosAll(); all[hash] = Object.assign(all[hash] || {}, { ix, t: at || 0, n: files ? files.length : 0 }); saveJson('tc_bookpos', all); }
  await musicPlayHash(hash, b.title, 'book', allOff ? files : null);
  if (bk.open) paintBooks();
}
async function bookAdd(r, play) {
  try {
    const { hash, title } = await audioAddRelease(r, 'audiobook');
    const l = bookList();
    if (!l.some(x => x.hash === hash)) { l.unshift({ hash, title, added: Date.now() }); saveBooks(l); }
    bk.open = hash; paintBooks();
    if (play) bookPlay(hash);
  } catch (e) { toast('Аудиокнига: ' + e.message, true); }
}
function bookMarkHere() {
  if (mu.kind !== 'book' || !mu.audio) return;
  const t = mu.audio.currentTime || 0, ix = mu.ix, hash = mu.t.hash;
  const note = prompt('Подпись к закладке (можно оставить пустой):', '') ;
  if (note === null) return;
  const l = bookMarks(hash); l.unshift({ ix, t, note: note.trim().slice(0, 140), at: Date.now() }); saveBookMarks(hash, l);
  toast('Закладка: глава ' + (ix + 1) + ', ' + fmtPos(t));
  if (bk.open === hash) paintBooks();
}

/* офлайн: каждый файл книги — отдельная загрузка в папку загрузок */
async function bookDownload(hash) {
  const b = bookList().find(x => x.hash === hash); if (!b) return;
  let files = bookFiles(hash);
  if (!files) { const st = await waitForFiles({ hash, title: b.title }); if (!st) return toast('Раздача не отдаёт список файлов', true); files = (st.file_stats || []).filter(f => isAudio(f.path)).sort((a, c) => a.path.localeCompare(c.path, 'ru', { numeric: true })); bookKeepFiles(hash, files); }
  const jobs = {};
  for (const f of files) {
    if (bookOfflinePath(hash, f.id)) continue;
    const name = (b.title.slice(0, 60) + ' - ' + basename(f.path)).replace(/[\\/:*?"<>|]/g, '_');
    try {
      const r = await fetch('/api/download?action=start&hash=' + encodeURIComponent(hash) + '&index=' + f.id + '&file=' + encodeURIComponent(name) + '&name=' + encodeURIComponent(b.title) + '&size=' + (f.length || 0), { method: 'POST' });
      const j = await r.json(); if (j.ok) jobs[j.id] = f.id;
    } catch {}
  }
  const all = bookOffAll(); all[hash] = Object.assign(all[hash] || { files: {} }, { jobs, done: false }); saveJson('tc_bookoff', all);
  toast('Скачиваю «' + b.title + '» для офлайна: ' + Object.keys(jobs).length + ' файлов. Видно и в «Загрузках»');
  paintBooks(); bookDlWatch();
}
function bookDlWatch() {
  clearTimeout(bk.dlPoll);
  bk.dlPoll = setTimeout(async () => {
    const all = bookOffAll(); let pending = false;
    try {
      const j = await api('/api/download?action=list');
      const byId = Object.fromEntries((j.jobs || []).map(x => [x.id, x]));
      for (const [hash, o] of Object.entries(all)) {
        if (!o.jobs) continue;
        let done = 0, total = 0, bytes = 0, size = 0;
        for (const [id, fid] of Object.entries(o.jobs)) {
          const x = byId[id]; total++;
          if (!x) continue;
          bytes += x.done || 0; size += x.total || 0;
          if (x.status === 'done') { o.files[fid] = x.path; done++; }
          else if (x.status === 'error' || x.status === 'cancelled') done++;
          else pending = true;
        }
        if (!pending || done === total) { delete o.jobs; const files = bookFiles(hash) || []; o.done = files.length > 0 && files.every(f => o.files[f.id]); if (o.done) toast('Аудиокнига скачана — слушается без сети'); }
        const el = $('#bkDl'); if (el && bk.open === hash) el.textContent = 'Скачиваю… ' + done + ' из ' + total + (size ? ' · ' + Math.round(bytes / size * 100) + '%' : '');
      }
      saveJson('tc_bookoff', all);
    } catch { pending = true; }
    if (pending) bookDlWatch(); else if (bk.open) paintBooks();
  }, 3000);
}

function onBookClick(t) {
  const g = (sel, k) => { const b = t.closest(sel); return b ? b.dataset[k] : null; };
  let v;
  if ((v = g('[data-bk-add]', 'bkAdd')) != null) { const r = bk.rows[+v]; if (r) bookAdd(r, !!t.closest('[data-play]')); return true; }
  if ((v = g('[data-bk-open]', 'bkOpen')) != null) { const b = bookList()[+v]; if (b) { bk.open = b.hash; paintBooks(); } return true; }
  if (t.closest('[data-bk-back-shelf]')) { bk.open = null; paintBooks(); return true; }
  if (t.closest('[data-bk-play]')) { bookPlay(bk.open); return true; }
  if ((v = g('[data-bk-ch]', 'bkCh')) != null) { bookPlay(bk.open, +v, 0); return true; }
  if ((v = g('[data-bk-go]', 'bkGo')) != null) { const m = bookMarks(bk.open)[+v]; if (m) bookPlay(bk.open, m.ix, m.t); return true; }
  if ((v = g('[data-bk-unmark]', 'bkUnmark')) != null) { const l = bookMarks(bk.open); l.splice(+v, 1); saveBookMarks(bk.open, l); paintBooks(); return true; }
  if (t.closest('[data-bk-dl]')) { bookDownload(bk.open); return true; }
  if (t.closest('[data-bk-drop]')) { const h = bk.open, l = bookList(), i = l.findIndex(x => x.hash === h); if (i >= 0) { const [gone] = l.splice(i, 1); saveBooks(l); bk.open = null; paintBooks(); toastUndo('Убрано с полки: ' + gone.title, () => { const ll = bookList(); ll.splice(i, 0, gone); saveBooks(ll); paintBooks(); }); } return true; }
  if (t.closest('[data-bk-mark]')) { bookMarkHere(); return true; }
  if (t.closest('[data-bk-back]')) { if (mu.audio) mu.audio.currentTime = Math.max(0, mu.audio.currentTime - 15); return true; }
  if (t.closest('[data-bk-fwd]')) { if (mu.audio) mu.audio.currentTime = mu.audio.currentTime + 30; return true; }
  return false;
}
