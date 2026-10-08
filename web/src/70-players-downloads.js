/* ================= PLAYERS PAGE ================= */
function renderPlayers(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Плееры</h1>
      <div class="page-sub">Выберите, каким плеером открывать видео. Можно настроить пути и аргументы.</div></div></div>
    <div class="card"><div class="row wrap">
      <label style="flex:1;margin:0;display:inline-flex;gap:8px;align-items:center">Плеер для запуска по умолчанию:
        <select id="defPlayer" style="width:auto">
          <option value="">(автовыбор первого найденного)</option>
          ${raw(state.players.filter(p => p.key !== 'browser').map(p => html`<option value="${p.key}" ${localStorage.getItem('tc_defplayer') === p.key ? 'selected' : ''}>${p.name}</option>`).join(''))}
          <option value="browser" ${localStorage.getItem('tc_defplayer') === 'browser' ? 'selected' : ''}>Браузер</option>
        </select>
      </label>
      <button id="scanPlayers" class="primary">Найти плееры заново</button>
    </div>
    <div class="page-sub" id="scanInfo" style="margin-top:8px"></div></div>
    <div class="card"><div class="tabs" id="pmodeBtn"><button data-v="continue" class="on">Продолжить с позиции</button><button data-v="fresh">Просто открыть ссылку</button></div></div>
    <div id="playersList"></div>
    <div class="divider"></div>
    <div class="card">
      <label>Получите ссылку на поток для любого внешнего плеера:</label>
      <div class="row"><input id="pMagnet" placeholder="Вставьте магнитную ссылку или hash"><button id="pGo">Открыть</button></div>
      <div id="pOut"></div>
    </div>
    <div class="card">
      <h3>HTTP-ссылки (например для VLC, PotPlayer):</h3>
      <div class="mono" id="pHttp"></div>
    </div>`;
  paintPlayersList(root);
  paintScanInfo();
  const defSel = $('#defPlayer');
  if (defSel) defSel.addEventListener('change', () => {
    localStorage.setItem('tc_defplayer', defSel.value);
    const nm = defSel.options[defSel.selectedIndex] && defSel.options[defSel.selectedIndex].text;
    toast('Плеер по умолчанию: ' + (nm || '(автовыбор)'));
    route();
  });
  $('#scanPlayers').addEventListener('click', async () => {
    const btn = $('#scanPlayers');
    if (btn) { btn.disabled = true; btn.textContent = 'Ищу…'; }
    try {
      const r = await fetch('/api/player/scan', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
      state.players = j.players.filter(p => p.key !== 'browser');
      state.scanRoots = Array.isArray(j.roots) ? j.roots : [];
      const found = state.players.filter(p => p.found).map(p => p.name).join(', ');
      toast(found ? 'Обнаружены: ' + found : 'Установленных плееров не найдено');
      route();
    } catch (e) {
      toast('Ошибка сканирования: ' + e.message, true);
      if (btn) { btn.disabled = false; btn.textContent = 'Найти плееры заново'; }
    }
  });
  const mode = localStorage.getItem('tc_pmode') || 'continue';
  $$('#pmodeBtn [data-v]').forEach(b => {
    b.classList.toggle('on', b.dataset.v === mode);
    b.addEventListener('click', () => togglePlayerMode(b.dataset.v));
  });
  $('#pGo').addEventListener('click', async () => {
    const link = $('#pMagnet').value.trim(); if (!link) return;
    $('#pOut').innerHTML = '<div class="empty">Получение информации...</div>';
    try {
      const st = await tsGet('/stream?link=' + encodeURIComponent(link) + '&stat&save');
      const t = st;
      const files = (st.file_stats || []).filter(f => isVideo(f.path));
      const main = files[0];
      const base = t.hash && main ? ts(`/stream/${encodeURIComponent(basename(main.path))}?link=${encodeURIComponent(t.hash)}&index=${main.id}&play`) : '';
      $('#pOut').innerHTML = html`
        <div class="row wrap"><div style="flex:1"><b>${st.title || ''}</b> · ${fmtSize(st.torrent_size)} <br>
        <span class="mono">${st.hash || ''}</span></div>
        <button class="primary" id="pCopy" ${base ? '' : 'disabled'}>Скопировать</button>
        <button id="pOpen" ${base ? '' : 'disabled'}>Открыть VLC</button></div>
        ${raw(base ? html`<div class="mono" style="margin-top:8px">${base}</div>` : '')}`;
      if (base) { $('#pCopy').addEventListener('click', () => copyToClip(base, 'Скопировано')); $('#pOpen').addEventListener('click', () => launchPlayer('vlc', base, st.title)); }
    } catch (e) { $('#pOut').innerHTML = html`<div class="empty">Ошибка: ${e.message}</div>`; }
  });
}
function togglePlayerMode(mode) {
  localStorage.setItem('tc_pmode', mode);
  renderPlayers(document.querySelector('main'));
}

/* Где искали плееры. Без этого кнопка «Найти плееры заново» молчит одинаково и
   когда плееров на машине нет, и когда искала не там. */
function paintScanInfo() {
  const box = $('#scanInfo');
  if (!box) return;
  const roots = state.scanRoots || [];
  if (!roots.length) {
    box.textContent = 'Плееры ищутся в системных папках программ, на дисках C:–J:, рядом с программой и в PATH. Нажмите «Найти плееры заново», чтобы обновить список.';
    return;
  }
  const head = roots.slice(0, 8).join(' · ');
  const tail = roots.length > 8 ? ' и ещё ' + (roots.length - 8) : '';
  const found = (state.players || []).filter(p => p.found).length;
  box.textContent = 'Проверено папок: ' + roots.length + ' — ' + head + tail + '. Найдено плееров: ' + found + '.';
}

function paintPlayersList(root) {
  const el = document.createElement('div'); el.id = 'playersList';
  el.innerHTML = state.players.map(p => html`
    <div class="card" data-pp="${p.key}">
      <div class="row"><h3 style="flex:1;margin:0">${p.name}</h3>
        <span class="chip ${p.found ? '' : 'grey'}">${p.found ? '✓ найден' : 'не найден'}</span>
        ${raw(localStorage.getItem('tc_defplayer') === p.key ? '<span class="chip">по умолчанию</span>' : '')}
        ${raw(p.key && p.key !== 'browser' ? html`<button data-dl="${p.path}">Скачать exe</button>` : '')}
      </div>
      <label>Путь к исполняемому файлу</label>
      <div class="row"><input data-f="path" value="${p.path}" placeholder="C:\\Program Files\\...">
        <button data-browse>Обзор</button></div>
      <label>Аргументы (подставка: {url} — ссылка на поток, {path} — путь к exe)</label>
      <input data-f="args" value="${p.args || ''}" placeholder='"{url}"'>
      <div style="margin-top:8px"><button data-save>Сохранить</button></div>
    </div>`).join('') || '<div class="empty">Нет плееров</div>';
  root.querySelector('#playersList').replaceWith(el);
  $$('.card[data-pp]').forEach(card => {
    const key = card.dataset.pp;
    const getVal = (f) => card.querySelector(`[data-f="${f}"]`).value;
    const p = state.players.find(x => x.key === key);
    if (!p) return;
    card.querySelector('[data-save]').addEventListener('click', async () => {
      p.path = getVal('path'); p.args = getVal('args'); p.found = !!p.path;
      // «Сохранено» показывается только по успешному ответу: прежде надпись
      // появлялась и при 500, и человек уходил с мыслью, что путь записан.
      try {
        const r = await fetch('/api/player/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.players) });
        if (!r.ok) { toast('Не сохранилось: HTTP ' + r.status, true); return; }
        toast('Сохранено');
        route();
      } catch (e) { toast('Не сохранилось: ' + e.message, true); }
    });
    const browse = card.querySelector('[data-browse]'); if (browse) browse.addEventListener('click', () => {
      const inp = card.querySelector('[data-f="path"]');
      const pth = prompt('Введите путь к исполняемому файлу (или поставьте вручную)', inp.value);
      if (pth) inp.value = pth;
    });
    const dl = card.querySelector('[data-dl]'); if (dl && p && dl.dataset.dl) dl.addEventListener('click', () => {
      const path = p.path; if (!path) return toast('Сначала укажите путь', true);
      toast('Плеер уже найден по пути: ' + path);
    });
  });
}

/* ================= DOWNLOADS ================= */
function loadDownloads() { return api('/api/download?action=list'); }
function pollDownloads() {
  if (state.view !== 'downloads') return;
  loadDownloads().then(j => { state.dlJobs = j.jobs; if (document.querySelector('#dljobs')) paintDownloads(); }).catch(() => {});
  pollTorrents();
}

/* ---------- что происходит на сервере ---------- */
/* Прежде раздел «Загрузки» показывал только сохранение на диск и при пустом
   списке заданий писал «Нет активных загрузок» — хотя сервер в это время качал
   раздачу. Теперь сверху видно состояние раздач, подгрузку, кэш и скорость: то,
   что раньше мелькало только в панели при запуске показа. */
let dlRowsKey = '';
async function pollTorrents() {
  const box = $('#dlTorrents');
  if (!box) return;
  let list = null;
  try {
    list = await tsJson('/torrents', { action: 'list' });
  } catch (e) {
    if (dlRowsKey !== 'error') { box.innerHTML = html`<div class="empty">Сервер не отвечает: ${e.message}</div>`; dlRowsKey = 'error'; }
    const sum = $('#dlSummary'); if (sum) sum.innerHTML = '';
    return;
  }
  if (!Array.isArray(list)) list = [];
  if (dlRowsKey === 'error') dlRowsKey = '';
  paintTorrentRows(list);
  await paintCacheCard(list);
}

/* Сводка: суммарные скорости, объёмы и настройки кэша самого сервера. Настройки
   спрашиваются один раз — они меняются редко. */
async function paintCacheCard(list) {
  const box = $('#dlSummary');
  if (!box) return;
  const sum = k => list.reduce((n, t) => n + (Number(t[k]) || 0), 0);
  const bits = [
    ['↓ ' + fmtSpeed(sum('download_speed')), 'суммарная скорость загрузки'],
    ['↑ ' + fmtSpeed(sum('upload_speed')), 'суммарная скорость отдачи'],
    ['раздач: ' + list.length, 'раздач на сервере'],
    ['подгружено: ' + fmtSize(sum('preloaded_bytes')), 'готово к показу, лежит в кэше'],
    ['прочитано: ' + fmtSize(sum('bytes_read')), 'столько прочитал плеер'],
  ];
  /* Сводка пишется сразу, а настройки сервера дописываются, когда придут: ждать
     их перед первой отрисовкой — значит показывать пустое место, пока идёт
     запрос. PreloadCache и ReaderReadAHead — проценты, CacheSize — байты. */
  const render = () => {
    const c = state.cache || {};
    const preBytes = c.CacheSize && c.PreloadCache ? (c.CacheSize / 100) * c.PreloadCache : 0;
    const cache = [];
    if (c.CacheSize) cache.push('кэш ' + fmtSize(c.CacheSize));
    if (c.PreloadCache) cache.push('предзагрузка ' + c.PreloadCache + '%' + (preBytes ? ' (' + fmtSize(preBytes) + ')' : ''));
    if (c.ReaderReadAHead) cache.push('чтение вперёд ' + c.ReaderReadAHead + '%');
    if (c.ConnectionsLimit) cache.push('соединений ' + c.ConnectionsLimit);
    box.innerHTML = `<div class="row wrap stats-row">`
      + bits.map(([v, tip]) => html`<span class="stat" title="${tip}">${v}</span>`).join('')
      + `</div>`
      + (cache.length ? html`<div class="page-sub" style="margin-top:8px">Настройки сервера: ${cache.join(' · ')}</div>` : '');
  };
  render();
  if (state.cache == null) {
    // Настройки отдаются только запросом POST {"action":"get"}: на GET /settings
    // сервер отвечает 404.
    try { state.cache = await tsJson('/settings', { action: 'get' }); } catch { state.cache = null; }
    if (state.cache) render();
  }
}

/* Строки раздач обновляются на месте: перерисовка всего списка каждые три
   секунды сбрасывала бы прокрутку, а раздачи с нулевой скоростью прыгали бы
   вверх-вниз. Порядок — по скорости, затем по времени добавления. */
function paintTorrentRows(list) {
  const box = $('#dlTorrents');
  if (!box) return;
  const rows = list.map(t => {
    const total = Number(t.torrent_size) || 0;
    const loaded = Number(t.loaded_size) || 0;
    const pre = Number(t.preload_size) || 0;
    const preB = Number(t.preloaded_bytes) || 0;
    const part = pre > 0 ? preB / pre : (total > 0 ? loaded / total : 0);
    return { t, total, pre, preB, part: Math.max(0, Math.min(1, part)), speed: Number(t.download_speed) || 0 };
  }).sort((a, b) => (b.speed - a.speed) || ((b.t.timestamp || 0) - (a.t.timestamp || 0)));
  const key = rows.map(r => r.t.hash).join(',');
  if (key !== dlRowsKey) {
    dlRowsKey = key;
    box.innerHTML = rows.length
      ? `<div class="trow thead"><div>Раздача</div><div>Подгрузка</div><div>Размер</div><div>↓</div><div>↑</div><div>Сиды/пиры</div><div>В кэше</div><div>Прочитано</div></div>`
        + rows.map(r => html`<div class="trow" data-th="${r.t.hash}">
          <div class="tname" title="${r.t.title || r.t.hash}"><span class="tlabel">${r.t.title || r.t.hash}</span><span class="chip tstat"></span></div>
          <div><div class="progress"><i data-f="bar"></i></div></div>
          <div class="tcell" data-f="size"></div>
          <div class="tcell" data-f="dl"></div>
          <div class="tcell" data-f="ul"></div>
          <div class="tcell" data-f="peers"></div>
          <div class="tcell" data-f="pre"></div>
          <div class="tcell" data-f="read"></div>
        </div>`).join('')
      : '<div class="empty">На сервере нет раздач</div>';
    if (!rows.length) return;
  }
  rows.forEach(r => {
    const row = box.querySelector('[data-th="' + r.t.hash + '"]');
    if (!row) return;
    const set = (f, v) => { const e = row.querySelector('[data-f="' + f + '"]'); if (e) e.textContent = v; };
    const bar = row.querySelector('[data-f="bar"]');
    if (bar) bar.style.width = Math.round(r.part * 100) + '%';
    set('size', r.total ? fmtSize(r.total) : '—');
    set('dl', r.speed > 0 ? fmtSpeed(r.speed) : '—');
    set('ul', Number(r.t.upload_speed) > 0 ? fmtSpeed(Number(r.t.upload_speed)) : '—');
    set('peers', (Number(r.t.connected_seeders) || 0) + ' / ' + (Number(r.t.active_peers) || 0));
    set('pre', r.pre ? fmtSize(r.preB) + ' из ' + fmtSize(r.pre) : '—');
    set('read', Number(r.t.bytes_read) ? fmtSize(Number(r.t.bytes_read)) : '—');
    const st = row.querySelector('.tstat');
    if (st) {
      st.textContent = String(r.t.stat_string || PREP_STAGES[Number(r.t.stat)] || '');
      st.title = r.part > 0 ? 'подгружено ' + Math.round(r.part * 100) + '%' : '';
    }
    row.classList.toggle('busy', r.speed > 0);
  });
}
function renderDownloads(root) {
  dlRowsKey = '';
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Загрузки</h1>
    <div class="page-sub" id="dlFolder"></div></div>
      <button data-act="dlrefresh" class="iconbtn" title="Обновить">${raw(ico('refresh'))}</button></div>
    <div class="card" id="dlSummary"><div class="empty">Сведения о сервере...</div></div>
    <div class="card" id="dlTorrents"><div class="empty">Сведения о раздачах...</div></div>
    <div class="card"><div class="row wrap"><b>Папка для сохранения:</b> <code id="dlPath"></code>
      <button data-dlpath>Изменить</button></div>
      ${raw(folderNoticeHTML('downloads'))}</div>
    <h2 class="sec-h">Сохранение на диск</h2>
    <div id="dljobs"></div>`;
  loadDownloads().then(j => { state.dlJobs = j.jobs; $('#dlPath').textContent = j.folder || state.hello.download_folder || '—'; paintDownloads(); });
  $('[data-act="dlrefresh"]').addEventListener('click', () => { state.cache = null; dlRowsKey = ''; pollDownloads(); });
  pollDownloads();
  $('[data-dlpath]').addEventListener('click', async () => {
    const p = prompt('Папка для загрузок:', state.hello.download_folder); if (!p) return;
    await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dirs', download_folder: p }) });
    state.hello.download_folder = p; $('#dlPath').textContent = p;
    // Перерисовка целиком, а не правка одной строки: предупреждение о
    // недоступной папке должно появиться (или исчезнуть) вместе с новым путём.
    await refreshFolders(); toast('Папка обновлена'); route();
  });
  hookFolderFix(root);
}
function paintDownloads() {
  const el = $('#dljobs'); if (!el) return;
  if (!state.dlJobs.length) { el.innerHTML = '<div class="empty">Нет активных загрузок</div>'; return; }
  el.innerHTML = state.dlJobs.map((j, i) => html`
    <div class="card">
      <div class="row wrap">
        <div style="flex:1"><b>${j.file_name || j.name}</b> <span class="chip">${j.status}</span>
        ${raw(j.error ? html` <span class="chip" style="background:#3a1d22;color:#ff9d9d">${j.error}</span>` : '')}</div>
        <span>${fmtSize(j.done)} / ${j.total ? fmtSize(j.total) : '?'}</span>
        ${raw(j.status === 'done' ? html`<button data-openfolder="${i}">Открыть папку</button>` : '')}
      </div>
      <div class="progress"><i style="width:${j.total ? Math.min(100, j.done / j.total * 100) : 5}%"></i></div>
    </div>`).join('');
  $$('#dljobs [data-openfolder]').forEach(b => b.addEventListener('click', () => {
    const j = state.dlJobs[parseInt(b.dataset.openfolder, 10)];
    if (!j || !j.path) return;
    const dir = j.path.substring(0, j.path.lastIndexOf('\\'));
    if (dir) window.open('file:///' + encodeURI(dir.replace(/\\/g, '/')));
  }));
}

/* ================= ПОДПИСКИ НА СЕРИАЛЫ =================
   Демон сам спрашивает трекер о новых сериях и присылает событие subs: своей
   проверки у интерфейса нет. Здесь только список подписок, число непрочитанных
   находок и кнопки «завести», «проверить», «прочитано», «снять».

   Первая проверка новой подписки ничего не объявляет — она запоминает, что уже
   вышло. Иначе свежая подписка принесла бы разом все серии сериала как новые. */

/* subsKey приводит название к виду сравнения — так же, как это делает демон:
   без регистра, без знаков и с «ё», приведённой к «е». Нужен, чтобы повторная
   подписка на тот же сериал не заводилась второй раз молча. */
function subsKey(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}
function subsKnown(title) {
  const key = subsKey(title);
  return (state.subs || []).some(s => subsKey(s.title) === key || subsKey(s.query) === key);
}
async function loadSubs() {
  try {
    const j = await api('/api/subs');
    state.subs = Array.isArray(j.subs) ? j.subs.filter(s => s && s.id) : [];
  } catch { state.subs = []; }
  paintSubsBadge();
  return state.subs;
}
function subsNewTotal() { return (state.subs || []).reduce((n, s) => n + (Number(s.new_count) || 0), 0); }
/* paintSubsBadge — число непрочитанных находок на самой вкладке: без него о
   новой серии узнают, только заглянув в раздел. */
function paintSubsBadge() {
  setNavBadge('subs', subsNewTotal());
}
async function subsAction(action, body) {
  return api('/api/subs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action }, body || {})) });
}
async function subsAdd(title, query) {
  const t = String(title || '').trim();
  if (!t) { toast('Нечего отслеживать: пустое название', true); return; }
  const was = subsKnown(t);
  // Разрешение на уведомления спрашивается по нажатию — иначе браузер откажет.
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) { /* нет уведомлений */ }
  try {
    await subsAction('add', { title: t, query: query || '' });
    await loadSubs();
    toast(was ? 'Уже отслеживается: ' + t : 'Следим за «' + t + '»');
    if (state.view === 'subs') route();
  } catch (e) { toast('Не удалось подписаться: ' + e.message, true); }
}
async function subsRemove(id) {
  try {
    await subsAction('remove', { id });
    state.subs = (state.subs || []).filter(s => s.id !== id);
    paintSubsBadge();
    if (state.view === 'subs') route();
    toast('Подписка снята');
  } catch (e) { toast('Не удалось снять подписку: ' + e.message, true); }
}
async function subsSeen(id) {
  try { await subsAction('seen', { id }); await loadSubs(); if (state.view === 'subs') paintSubsBody(); }
  catch (e) { toast('Не удалось сбросить новизну: ' + e.message, true); }
}
async function subsCheck() {
  try {
    await subsAction('check');
    // Проверка идёт на демоне и отвечает сразу, а список обновится позже: ответ
    // ручки означает «принято», а не «проверено». Поэтому список перечитывается
    // ещё раз через несколько секунд, и о находках сообщает событие subs.
    toast('Проверяю трекер — о новых сериях сообщу');
    setTimeout(loadSubs, 4000);
    setTimeout(loadSubs, 15000);
  } catch (e) { toast('Проверка не запустилась: ' + e.message, true); }
}

function fmtWhen(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/* subsAirLine — расписание по TMDB: что уже вышло в эфир и когда следующая. */
function subsAirLine(s) {
  const se = (a, b) => 'S' + String(a).padStart(2, '0') + (b ? 'E' + String(b).padStart(2, '0') : '');
  const day = v => { const d = new Date(v); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); };
  const parts = [];
  if (s.air_season) parts.push('в эфире вышла ' + se(s.air_season, s.air_episode) + (s.air_date ? ' (' + day(s.air_date) + ')' : ''));
  if (s.next_air) parts.push('следующая ' + se(s.next_season, s.next_episode) + ' — ' + day(s.next_air));
  else if (s.ended) parts.push('сериал завершён');
  return parts.length ? html`<div class="page-sub" style="margin:0">По TMDB: ${parts.join(' · ')}</div>` : '';
}
function subsCard(s) {
  const known = s.season ? 'известно: сезон ' + s.season + (s.episode ? ', серия ' + s.episode : '') : 'ещё не проверялась';
  const check = fmtWhen(s.checked);
  return html`<div class="card sub-card" data-sub="${s.id}">
    <div class="row wrap">
      <h3 style="flex:1;margin:0">${s.title}</h3>
      ${raw(s.new_count ? html`<span class="chip hasnew">${s.new_count} ${plural(s.new_count, 'новая серия', 'новые серии', 'новых серий')}</span>` : '')}
      <button data-sub-check>Проверить</button>
      ${raw(s.new_count ? html`<button data-sub-seen>Прочитано</button>` : '')}
      <button data-sub-del class="danger">Снять</button>
    </div>
    <div class="page-sub" style="margin:6px 0 0">Ищу на трекерах: ${s.query || s.title} · ${known}${check ? ' · проверено ' + check : ''}</div>
    ${raw(s.last_seen ? html`<div class="page-sub" style="margin:0">Последняя находка: ${s.last_seen}</div>` : '')}
    ${raw(subsAirLine(s))}
  </div>`;
}
