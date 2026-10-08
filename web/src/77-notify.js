/* ================= УВЕДОМЛЕНИЯ, «СЕЙЧАС ИГРАЕТ», АВТОСЛЕЖЕНИЕ =================
   Находка демона (новая серия) раньше показывалась тостом на четыре секунды
   и пропадала: не заметил — не узнал. Теперь у неё есть место — колокольчик в
   шапке со счётчиком и списком, который переживает перезапуск. Рядом —
   «Сейчас играет»: что открыто во внешнем плеере (демон сообщает событием
   nowplaying) и какой трек играет в разделе «Музыка». */

const NOTIF_KEY = 'tc_notifs';
function notifList() { try { const a = JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveNotifs(l) { try { localStorage.setItem(NOTIF_KEY, JSON.stringify(l.slice(0, 50))); } catch {} }
function notifPush(n) {
  const l = notifList();
  // Повтор той же находки (демон перепроверил подписку) не плодит строки.
  const dup = l.findIndex(x => x.text === n.text && Date.now() - (x.at || 0) < 6 * 3600e3);
  if (dup >= 0) l.splice(dup, 1);
  l.unshift(Object.assign({ at: Date.now(), read: false }, n));
  saveNotifs(l);
  paintNotifBtn();
  const bell = $('#notifBtn'); if (bell) { bell.classList.remove('ring'); void bell.offsetWidth; bell.classList.add('ring'); }
}
function notifUnread() { return notifList().filter(x => !x.read).length; }
function paintNotifBtn() {
  const b = $('#notifBtn'); if (!b) return;
  const n = notifUnread();
  b.innerHTML = ico('bell', 18) + (n ? '<span class="tb-badge">' + (n > 9 ? '9+' : n) + '</span>' : '');
  b.title = n ? 'Уведомления: новых ' + n : 'Уведомления';
}
function openNotifs() {
  closeNotifs();
  const l = notifList();
  const pop = document.createElement('div');
  pop.className = 'notif-pop'; pop.id = 'notifPop';
  pop.innerHTML = html`<div class="notif-h"><b>Уведомления</b><span class="spacer"></span>
      ${raw(l.length ? '<button class="link-btn" data-nf-clear>очистить</button>' : '')}
      <button class="link-btn" data-nf-subs>подписки</button></div>
    ${raw(l.length ? l.map((x, i) => html`<button class="notif-it${x.read ? '' : ' new'}" data-nf="${i}">
        <span class="notif-ico">${raw(ico(x.kind === 'ep' ? 'tv' : 'info', 16))}</span>
        <span class="notif-tx"><span>${x.text}</span><small>${new Date(x.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></span></button>`).join('')
      : '<div class="notif-empty">Пока пусто. О новых сериях сериалов из Библиотеки сообщу здесь.</div>')}`;
  document.body.appendChild(pop);
  const r = $('#notifBtn').getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  pop.addEventListener('click', e => {
    const it = e.target.closest('[data-nf]');
    if (it) {
      const x = l[+it.dataset.nf]; closeNotifs();
      if (x && x.kind === 'ep') openMovie({ title: subsName(x.title || ''), kind: 'tv' });
      return;
    }
    if (e.target.closest('[data-nf-clear]')) { saveNotifs([]); closeNotifs(); paintNotifBtn(); return; }
    if (e.target.closest('[data-nf-subs]')) { closeNotifs(); setView('subs'); }
  });
  // Открыл список — значит увидел.
  saveNotifs(l.map(x => Object.assign({}, x, { read: true })));
  setTimeout(paintNotifBtn, 0);
  setTimeout(() => document.addEventListener('click', notifOutside, true), 0);
}
function notifOutside(e) { if (!e.target.closest('#notifPop, #notifBtn')) closeNotifs(); }
function closeNotifs() { const p = $('#notifPop'); if (p) p.remove(); document.removeEventListener('click', notifOutside, true); }

/* Разрешение на системные уведомления браузер даёт только по жесту
   пользователя: спрашиваем один раз, при первом клике по окну. */
document.addEventListener('click', function askNotif() {
  document.removeEventListener('click', askNotif, true);
  try { if ('Notification' in window && Notification.permission === 'default' && localStorage.getItem('tc_notif_asked') !== '1') { localStorage.setItem('tc_notif_asked', '1'); Notification.requestPermission(); } } catch (_) { /* нет уведомлений */ }
}, true);

/* ---- автослежение за сериалами ----
   Подписку раньше заводили руками кнопкой «Следить», и о новых сериях не
   узнавали, потому что подписок просто не было. Теперь каждый сериал из
   Библиотеки (по названию раздачи или по номерам серий в именах файлов —
   так у аниме и мультсериалов) получает подписку сам. Снятая руками подписка
   запоминается и сама больше не возвращается. */
const AF_KEY = 'tc_autofollow';
const AF_SKIP = 'tc_af_skip';
function autoFollowOn() { return localStorage.getItem(AF_KEY) !== '0'; }
function autoFollowSkip(title) {
  let l = []; try { l = JSON.parse(localStorage.getItem(AF_SKIP) || '[]'); } catch {}
  const k = subsKey(subsName(title || ''));
  if (k && !l.includes(k)) { l.push(k); try { localStorage.setItem(AF_SKIP, JSON.stringify(l.slice(-300))); } catch {} }
}
let afBusy = false;
async function autoFollowSeries(loud) {
  if (!autoFollowOn() || afBusy || !Array.isArray(state.lib) || !state.lib.length) return;
  afBusy = true;
  try {
    if (!Array.isArray(state.subs)) await loadSubs();
    let skip = []; try { skip = JSON.parse(localStorage.getItem(AF_SKIP) || '[]'); } catch {}
    const names = new Map();
    state.lib.forEach(t => {
      const title = t.title || t.name || '';
      const stat = (statCache[t.hash] && statCache[t.hash].data) || t;
      const eps = (stat.file_stats || []).filter(f => isVideo(f.path) && (parseSeriesEp(basename(f.path)) || {}).e).length;
      if (!isSeries(title) && eps < 3) return;
      const n = subsName(title);
      const k = subsKey(n);
      if (n && n.length >= 2 && k && !skip.includes(k)) names.set(k, n);
    });
    const add = [...names.values()].filter(n => !subsKnown(n)).slice(0, 25);
    let ok = 0;
    for (const n of add) { try { await subsAction('add', { title: n, query: '' }); ok++; } catch { /* следующий */ } }
    if (ok) { await loadSubs(); paintSubsBadge(); toast('Слежу за новыми сериями: ' + ok + ' ' + plural(ok, 'сериал', 'сериала', 'сериалов')); if (state.view === 'subs') paintSubsBody(); }
    else if (loud) toast('Все сериалы из Библиотеки уже отслеживаются');
  } finally { afBusy = false; }
}

/* ---- сейчас играет ---- */
state.now = [];
async function loadNowPlaying() {
  try { const j = await api('/api/nowplaying'); state.now = Array.isArray(j.items) ? j.items : []; } catch { state.now = []; }
  paintNowPlaying();
}
function paintNowPlaying() {
  const b = $('#nowBtn'); if (!b) return;
  let label = '', sub = '', kind = '';
  if (mu.t && mu.ix >= 0 && mu.audio && mu.audio.src) {
    kind = 'music';
    label = musicTrackName(mu.queue[mu.ix]);
    sub = mu.audio.paused ? 'пауза' : 'музыка';
  } else if (state.now && state.now.length) {
    const it = state.now[0];
    const t = (state.lib || []).find(x => x.hash === it.hash);
    kind = 'video';
    label = t ? (t.title || t.name) : 'Видео';
    const f = t && (((statCache[t.hash] && statCache[t.hash].data) || t).file_stats || []).find(x => x.id === it.file_index);
    sub = (f && isSeries(t.title || t.name || '') ? epLabel(f, t) + ' · ' : '') + (it.player || 'плеер');
  }
  b.classList.toggle('hidden', !kind);
  b.dataset.kind = kind;
  if (!kind) { b.innerHTML = ''; return; }
  b.innerHTML = html`<span class="np-eq${kind === 'music' && mu.audio && mu.audio.paused ? ' paused' : ''}"><i></i><i></i><i></i></span><span class="np-tx"><b>${label}</b><small>Сейчас играет · ${sub}</small></span>`;
  b.title = 'Сейчас играет: ' + label;
}
function onNowClick() {
  const b = $('#nowBtn'); if (!b) return;
  if (b.dataset.kind === 'music') { if (state.view === 'music') musicToggle(); else setView('music'); return; }
  const it = state.now && state.now[0];
  const t = it && (state.lib || []).find(x => x.hash === it.hash);
  if (t) openMovie(Object.assign(fromRelease(t), { poster: t.poster || '' }));
}

/* extrasBoot — вызывается после запуска ленты событий. */
function extrasBoot() {
  paintNotifBtn();
  const nb = $('#notifBtn'); if (nb) nb.addEventListener('click', e => { e.stopPropagation(); if ($('#notifPop')) closeNotifs(); else openNotifs(); });
  const np = $('#nowBtn'); if (np) np.addEventListener('click', onNowClick);
  loadNowPlaying();
  if (eventsSrc) eventsSrc.addEventListener('nowplaying', e => {
    try { const d = JSON.parse(e.data); state.now = Array.isArray(d.items) ? d.items : []; } catch { return; }
    paintNowPlaying();
  });
  else setInterval(loadNowPlaying, 10000);
  // Автослежение — когда библиотека уже прочитана (её грузит первая страница).
  setTimeout(() => { if (Array.isArray(state.lib) && state.lib.length) autoFollowSeries(); else loadLibrary().then(() => autoFollowSeries()).catch(() => {}); }, 20000);
  fxBoot();
}
