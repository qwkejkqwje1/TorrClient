/* ---------- подготовка торрента перед показом ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Состояния раздачи у TorrServer — числами. Названия нужны, чтобы объяснить
   ожидание словами, а не показать «stat 1». */
const PREP_STAGES = [
  'Торрент добавлен',
  'Получаем сведения о раздаче',
  'Подгрузка начала файла',
  'Раздача работает',
  'Торрент закрыт',
  'Торрент в базе',
];

/* prepFigures — цифры ожидания в одном месте: и окно подготовки, и панель в
   углу показывают одно и то же. Буфер — то, сколько плееру нужно до старта;
   по скорости считается, сколько ещё ждать. */
function prepFigures(st, started) {
  const n = k => Number(st && st[k]) || 0;
  const stat = Number(st && st.stat);
  const pre = n('preload_size'), preBytes = n('preloaded_bytes');
  const total = n('torrent_size'), loaded = n('loaded_size');
  const sp = n('download_speed'), up = n('upload_speed');
  const seeds = n('connected_seeders'), active = n('active_peers'), all = n('total_peers');
  const pending = n('pending_peers') + n('half_open_peers');
  const part = pre > 0 ? preBytes / pre : (total > 0 ? loaded / total : 0);
  const left = pre > 0 ? Math.max(0, pre - preBytes) : 0;
  const eta = left > 0 && sp > 0 ? left / sp : 0;
  return {
    stat, pre, preBytes, total, loaded, sp, seeds, active, all, part,
    stage: PREP_STAGES[stat] || 'Раздача',
    text: {
      seeds: 'сиды: ' + seeds,
      peers: 'пиры: ' + active + (all > active ? ' из ' + all : '') + (pending > 0 ? ' · ждут ' + pending : ''),
      speed: 'скорость: ' + (sp > 0 ? fmtSize(sp) + '/с' : '0') + (up > 0 ? ' · отдача ' + fmtSize(up) + '/с' : ''),
      // До начала показа важен буфер, а не вся раздача: у сезона целиком
      // «300 МБ из 40 ГБ» выглядело как бесконечное ожидание.
      loaded: pre > 0 ? 'буфер: ' + fmtSize(preBytes) + ' из ' + fmtSize(pre) + ' (' + Math.round(Math.min(1, part) * 100) + '%)'
        : (total > 0 ? 'загружено: ' + fmtSize(loaded) : 'загружено: —'),
      eta: eta > 0 ? 'осталось ≈ ' + fmtPos(Math.max(1, eta)) : (pre > 0 && left === 0 ? 'буфер готов' : 'осталось: —'),
      total: total > 0 ? 'скачано: ' + fmtSize(loaded) + ' из ' + fmtSize(total) : 'скачано: —',
      time: 'прошло: ' + fmtPos((Date.now() - started) / 1000),
    },
  };
}
function paintPrepStats(el, fig) {
  Object.keys(fig.text).forEach(k => { const x = el('[data-st="' + k + '"]'); if (x) x.textContent = fig.text[k]; });
  const bar = el('[data-bar]'); if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, fig.part)) * 100) + '%';
}
const PREP_STAT_SPANS = ['seeds', 'peers', 'speed', 'loaded', 'eta', 'total', 'time'];

/* Пока сервер не сообщил сведения о раздаче, плееру нечего играть: он
   откроется на пустом месте. Поэтому ожидание показывается: этап, сиды, пиры,
   скорость и ход подгрузки, — а рядом кнопка отказа. */
function prepOverlay(title) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal prep">
    <h2>${title || 'Раздача'}</h2>
    <div class="prep-stage"><span class="spin"></span><span data-stage>Торрент добавлен</span></div>
    <div class="prep-bar"><i data-bar></i></div>
    <div class="prep-stats">${raw(PREP_STAT_SPANS.map(k => '<span data-st="' + k + '">—</span>').join(''))}</div>
    <div class="prep-hint" data-hint>Плеер откроется сам, когда появятся файлы раздачи.</div>
    <div class="btn-group"><button data-cancel>Отмена</button></div>
  </div>`;
  document.body.appendChild(ov);
  const started = Date.now();
  const el = s => ov.querySelector(s);
  const api = {
    cancelled: false,
    update(st) {
      const fig = prepFigures(st, started);
      el('[data-stage]').textContent = fig.stage;
      paintPrepStats(el, fig);
      const stat = fig.stat, seeds = fig.seeds;
      if (stat <= 1 && seeds === 0) el('[data-hint]').textContent = 'Сервер ищет раздающих. Если сидов нет, показ не начнётся — можно попробовать другую раздачу.';
    },
    hint(text) { el('[data-hint]').textContent = text; },
    fail(text) { el('[data-stage]').textContent = text; ov.querySelector('.spin').classList.add('stop'); },
    close() { api.cancelled = true; ov.remove(); },
  };
  ov.querySelector('[data-cancel]').addEventListener('click', () => api.close());
  ov.addEventListener('click', e => { if (e.target === ov) api.close(); });
  return api;
}

/* waitForFiles ждёт, пока сервер сообщит файлы раздачи.
   Возвращает состояние раздачи или null, если ожидание прервали. */
async function waitForFiles(t, waitMs) {
  const hash = t.hash;
  const quick = await statTorrent(hash).catch(() => null);
  if (quick && Array.isArray(quick.file_stats) && quick.file_stats.length) return rememberStat(hash, quick);

  const ov = prepOverlay(t.title || t.name || hash);
  const deadline = Date.now() + (waitMs || 120000);
  // Свежую раздачу сервер добавляет сам, но уже известную надо разбудить.
  await torrentAction('add', { link: hash, save_to_db: true }).catch(() => {});
  await torrentAction('start', { hash }).catch(() => {});
  try {
    while (!ov.cancelled && Date.now() < deadline) {
      const st = await statTorrent(hash).catch(() => null);
      if (ov.cancelled) break;
      if (st && typeof st === 'object') {
        ov.update(st);
        if (Array.isArray(st.file_stats) && st.file_stats.length) return rememberStat(hash, st);
      }
      await sleep(1000);
    }
    if (!ov.cancelled) ov.fail('Сведения о раздаче не получены');
    await sleep(900);
    return null;
  } finally { ov.close(); }
}
function rememberStat(hash, st) {
  statCache[hash] = { at: Date.now(), data: st };
  const cur = state.lib.find(x => x.hash === hash);
  if (cur) { mergeStat(cur, st); cur.hasStat = true; }
  return st;
}
/* Предупреждение после запуска: без раздающих показ не начнётся, и молчащий
   плеер на пустом месте выглядит поломкой. */
async function warnIfNoSeeds(t) {
  const st = await statTorrent(t.hash).catch(() => null);
  if (!st || typeof st !== 'object') return;
  const seeds = Number(st.connected_seeders) || 0;
  const peers = Number(st.total_peers) || 0;
  if (seeds === 0 && peers === 0) toast('Раздающих пока нет — загрузка может не начаться', true);
}

/* ---------- ход подгрузки во время показа ---------- */

/* Панель в углу: пока данных мало, плеер показывает «буферизацию», и без
   объяснения это выглядит поломкой. Панель живёт от нажатия «play» до первых
   прочитанных байтов, а если раздающих нет — остаётся и говорит об этом. */
let activePanel = null;

function progressPanel(t, f, next) {
  if (activePanel) activePanel.stop();
  const ov = document.createElement('div');
  ov.className = 'dlpanel';
  ov.innerHTML = html`<div class="dlpanel-h"><span class="spin"></span>
      <b data-title>${t.title || t.name || t.hash}</b>
      <button data-hide title="Скрыть">✕</button></div>
    <div class="dlpanel-sub" data-sub>${epSuffix(f).replace(/^ — /, '') || basename(f.path)}</div>
    <div class="prep-bar"><i data-bar></i></div>
    <div class="prep-stats"><span data-st="stage">—</span>${raw(PREP_STAT_SPANS.map(k => '<span data-st="' + k + '">—</span>').join(''))}</div>
    <div class="prep-hint" data-hint></div>
    <div class="prep-next hidden" data-nextbox></div>`;
  document.body.appendChild(ov);
  const el = s => ov.querySelector(s);
  const started = Date.now();
  let stopped = false;
  let announced = false;
  let lastBytes = 0, lastMove = Date.now();

  const panel = {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (activePanel === panel) activePanel = null;
      ov.remove();
    },
    /** ready — показ начался: панель сообщает это и уходит сама. */
    ready() {
      if (stopped || announced) return;
      announced = true;
      // Во время показа цифры подгрузки только врут: плеер читает с опережением,
      // скорость скачет, а «загружено» относится ко всей раздаче. Поэтому они
      // убираются, и опрос сервера прекращается — просмотру ничего не мешает.
      clearInterval(timer);
      ['.prep-bar', '.prep-stats', '[data-hint]'].forEach(s => { const x = el(s); if (x) x.remove(); });
      const sp = ov.querySelector('.spin'); if (sp) sp.remove();
      el('[data-sub]').textContent = 'Показ идёт · ' + el('[data-sub]').textContent;
      ov.classList.add('done');
      if (next) {
        // Серия с серией: панель не уходит, а предлагает следующую. Искать
        // раздачу и серию заново после каждой серии — обычная работа, которую
        // тут делает одна кнопка.
        panel.showNextButton();
        return;
      }
      setTimeout(() => panel.stop(), 4000);
    },
    /** showNextButton — кнопка «следующая серия» рядом с панелью. */
    showNextButton() {
      const box = el('[data-nextbox]');
      if (!box || box.querySelector('button')) return;
      const p = parseSeriesEp(basename(next.path)) || {};
      const num = p.e ? ' E' + String(p.e).padStart(2, '0') : '';
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.dataset.nextEp = String(next.id);
      btn.textContent = 'Следующая серия' + num + ' ▶';
      btn.title = basename(next.path);
      btn.addEventListener('click', () => {
        panel.stop();
        playSelected(t, next);
      });
      box.appendChild(btn);
      box.classList.remove('hidden');
    },
  };
  // Текущая панель запоминается: иначе предыдущая оставалась на экране до
  // своего девяностасекундного срока, и после второго запуска их висело две.
  activePanel = panel;
  el('[data-hide]').addEventListener('click', () => panel.stop());

  const tick = async () => {
    if (stopped || announced) return;
    const st = await statTorrent(t.hash).catch(() => null);
    if (stopped || !st || typeof st !== 'object') return;
    if (Array.isArray(st.file_stats) && st.file_stats.length) rememberStat(t.hash, st);
    const fig = prepFigures(st, started);
    const stat = fig.stat, seeds = fig.seeds, peers = fig.active;
    el('[data-st="stage"]').textContent = fig.stage;
    paintPrepStats(el, fig);
    // Показ начался, когда буфер набран. Раньше панель уходила при первом же
    // байте — и самое интересное, ход предзагрузки, увидеть было нельзя.
    // bytes_read у TorrServer — принятое от пиров, а не прочитанное плеером,
    // поэтому по нему о старте судить нельзя.
    if (fig.pre > 0 ? fig.preBytes >= fig.pre * 0.97 : (stat === 3 && fig.loaded > 0 && Date.now() - started > 4000)) { panel.ready(); return; }
    if (fig.preBytes > lastBytes) { lastBytes = fig.preBytes; lastMove = Date.now(); }
    if (seeds === 0 && peers === 0) {
      el('[data-hint]').textContent = 'Раздающих нет: показ не начнётся, пока не появятся сиды. Попробуйте другую раздачу.';
    } else if (stat <= 1) {
      el('[data-hint]').textContent = 'Сервер ищет раздающих...';
    } else if (fig.pre > 0) {
      el('[data-hint]').textContent = 'Набирается буфер: показ начнётся, когда он заполнится.';
    } else {
      el('[data-hint]').textContent = 'Плеер открыт и ждёт данных.';
    }
    // Долгое ожидание без движения не должно висеть вечно; пока буфер
    // растёт, панель остаётся.
    if (Date.now() - lastMove > 90000) panel.stop();
  };
  const timer = setInterval(tick, 1500);
  tick();
  return panel;
}

/* ---------- player switcher + play ---------- */
function bindTorrentPlay(ov, t, files) {
  const el = ov.querySelector('#infoPlayer');
  let vf = files.filter(f => isVideo(f.path));
  let af = files.filter(f => isAudio(f.path));
  const allPlayable = files.filter(f => isPlayable(f.path));
  const vid = vf.length ? vf : files.filter(f => isPlayable(f.path));
  const target = vid.length ? vid : [];
  if (!target.length) { el.innerHTML = '<div class="empty">Нет воспроизводимых файлов</div>'; return; }
  let curFile = target[0];
  const fileChip = f => {
    const mark = markOf(t, f.id);
    const st = mark && mark.done ? ' ✓' : (mark && mark.timecode > 0 ? ' · ' + fmtPos(mark.timecode) : '');
    return html`<button class="chip-btn${f.id === target[0].id ? ' on' : ''}${mark && mark.done ? ' watched' : ''}" data-file="${f.id}">${basename(f.path)}${st}</button>`;
  };
  el.innerHTML = html`<div><b>Воспроизведение файла:</b> <code class="inline">${target[0].path}</code></div>
    <div style="margin-top:6px">${raw(allPlayable.map(fileChip).join(''))}</div>
    <div class="btn-group" style="margin-top:8px">
      <button data-pk="switcher">Плееры ▾</button>
      <button data-pk="browser">В браузере</button>
      <a class="btn" data-pk="m3u" href="#" download>M3U</a>
      <button data-pk="copy">Копировать ссылку</button>
      <button data-pk="dl">Скачать файл</button>
      <button data-pk="bm">Сохранить закладку</button>
      <button data-pk="eps">Список серий</button>
    </div>
    <div id="pkMode" class="switch" style="margin-top:8px"></div>`;
  const redoPicker = () => {
    el.querySelector('#pkMode').innerHTML = state.players.map(p => {
      const miss = (p.key !== 'browser' && !p.found) ? 'miss' : '';
      const base = makeStreamUrlFor(t, curFile);
      return html`<div class="player ${miss}" data-pk2="${p.key}" data-stream="${base}">
        <div class="pname">${p.name}</div><div class="plink mono">${base}</div>
      </div>`;
    }).join('');
    $$('#pkMode .player', el).forEach(p => p.addEventListener('click', () => {
      if (p.dataset.pk2 === 'browser') return inBrowser(t, curFile);
      ov.remove();
      playSelected(t, curFile, { player: p.dataset.pk2 });
    }));
  };
  redoPicker();
  $$('button[data-file]', el).forEach(b => b.addEventListener('click', () => {
    curFile = files.find(f => String(f.id) === b.dataset.file); if (!curFile) return;
    $$('button[data-file]', el).forEach(x => x.classList.remove('on'));
    b.classList.add('on'); redoPicker();
  }));
  el.querySelector('[data-pk="switcher"]').addEventListener('click', () => {
    const sw = el.querySelector('#pkMode'); sw.classList.toggle('hidden');
  });
  el.querySelector('[data-pk="eps"]').addEventListener('click', () => {
    const vids = playableOf(t).filter(f => isVideo(f.path));
    if (vids.length < 2) return toast('В раздаче одна серия', true);
    ov.remove(); openEpisodesPicker(t, vids);
  });
  el.querySelector('[data-pk="browser"]').addEventListener('click', () => { inBrowser(t, curFile); });
  el.querySelector('[data-pk="m3u"]').addEventListener('click', e => { e.preventDefault(); m3uForFile(t, curFile); });
  el.querySelector('[data-pk="copy"]').addEventListener('click', () => copyToClip(isRemoteUI() ? phoneStreamUrl(t, curFile) : makeStreamUrlFor(t, curFile), 'Ссылка скопирована'));
  el.querySelector('[data-pk="dl"]').addEventListener('click', async () => {
    const q = 'action=start&hash=' + encodeURIComponent(t.hash) + '&index=' + curFile.id + '&name=' + encodeURIComponent(t.title || 'file') + '&file=' + encodeURIComponent(basename(curFile.path)) + '&size=' + (curFile.length || 0);
    // Запуск закачки — POST: GET-адрес с чужой страницы могла бы дёрнуть даже картинка.
    try { await api('/api/download?' + q, { method: 'POST' }); toast('Загрузка начата'); loadDownloads(); }
    catch (e) { toast('Не удалось начать загрузку: ' + e.message, true); }
  });
  el.querySelector('[data-pk="bm"]').addEventListener('click', () => { addBookmark(t, curFile.id, basename(curFile.path), estimatePos(t.hash, curFile.id)); });
}
function basename(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }
function makeStreamUrlFor(t, f) {
  // Ссылка на один файл: плейлист всей раздачи собирает демон, когда получает
  // раздачу и номер файла. Продолжение с места остановки ставит плеер флагом
  // запуска — параметр pos TorrServer не разбирает.
  return location.origin + ts(`/stream/${encodeURIComponent(basename(f.path))}?link=${encodeURIComponent(t.hash)}&index=${f.id}&play`);
}
function inBrowser(t, f) {
  // На телефоне «в браузере» — это браузер телефона, а не компьютера.
  if (isRemoteUI()) { trackPlay(t.hash, f.id, currentTc(t, f.id)); return phoneBrowser(phoneStreamUrl(t, f), (t.title || t.name || 'stream') + epSuffix(f), t, f); }
  const url = makeStreamUrlFor(t, f);
  trackPlay(t.hash, f.id, currentTc(t, f.id));
  launchPlayer('browser', url, t.title || 'stream');
}
function m3uForFile(t, f) {
  const url = ts(`/playlist?hash=${encodeURIComponent(t.hash)}&index=${f.id}&m3u`);
  const a = document.createElement('a'); a.href = url; a.download = (t.title || 'file') + '.m3u'; document.body.appendChild(a); a.click(); a.remove();
}
function firstPlayable(t) {
  const files = t.file_stats || [];
  return files.find(x => isPlayable(x.path)) || (files.length === 1 ? files[0] : null);
}
function playableOf(t) { return (t.file_stats || []).filter(x => isPlayable(x.path)); }

/* playSelected запускает показ выбранного файла.
   Раздача и номер файла уходят демону: он отдаёт плееру плейлист всей раздачи
   с выбранной серии, поэтому у плеера есть список серий, а не одна ссылка.
   Позиция продолжения ставится флагом запуска — параметр pos в адресе потока
   TorrServer не разбирает. */
function playSelected(cur, f, opts = {}) {
  // С телефона «Смотреть» раньше запускало плеер на компьютере, и на телефоне
  // ничего не происходило. Теперь спрашиваем, где смотреть.
  if (isRemoteUI() && !opts.player && !opts.onPC) return phonePlay(cur, f, opts);
  const key = opts.player || pickPlayer();
  const title = (cur.title || cur.name || 'stream') + epSuffix(f);
  trackPlay(cur.hash, f.id, opts.fromZero ? 0 : currentTc(cur, f.id));
  // Ход подгрузки виден всегда, а не только пока сервер не отдал список файлов:
  // иначе нажатие «play» на известной раздаче выглядит как молчание. В браузере
  // панель не нужна — там свой значок ожидания, а раздающих проверяет тост.
  const vids = playableOf(cur).filter(x => isVideo(x.path));
  const next = vids.length > 1 ? nextAfter(cur, vids, f) : null;
  const panel = key === 'browser' ? null : progressPanel(cur, f, next);
  return launchPlayer(key, makeStreamUrlFor(cur, f), title, { hash: cur.hash, index: f.id })
    .then(res => {
      if (!res) { if (panel) panel.stop(); return; }
      if (!panel) warnIfNoSeeds(cur);
      refreshViewedSoon();
    });
}
/* Отметки ставит и сам демон: он считает, сколько байт ушло плееру, и отмечает
   серию просмотренной, когда файл прочитан до конца, — даже если плеер о позиции
   не сообщает вовсе. Интерфейс об этом не знает, пока не спросит, поэтому список
   отметок обновляется сам, а не только по нажатию. */
let viewedKey = '';
function viewedSignature() {
  return (state.viewed || [])
    .map(v => v.hash + ':' + v.file_index + ':' + Math.round(v.timecode || 0) + ':' + (v.done ? 1 : 0))
    .sort()
    .join('|');
}
async function refreshViewed() {
  await loadPositions();
  const key = viewedSignature();
  if (key === viewedKey) return;
  const first = !viewedKey;
  viewedKey = key;
  // Первый ответ — это то, что уже нарисовано. Открытое окно перерисовывать
  // нельзя: пользователь как раз выбирает серию или правит настройки.
  if (first || $('.overlay')) return;
  if (state.view === 'library') paintLibrary();
}
function refreshViewedSoon() {
  [1500, 4000, 8000].forEach(ms => setTimeout(refreshViewed, ms));
}
function epSuffix(f) {
  const p = parseSeriesEp(basename(f.path));
  if (!p || !(p.s || p.e)) return '';
  return ' — ' + (p.s ? 'Сезон ' + p.s + ' · ' : '') + (p.e ? 'Серия ' + p.e : 'сезон');
}

/* Нажатие «play». Сериал не открывается первой серией молча: показывается
   список серий, и уже оттуда запускается выбранная. Для фильма ожидание
   сведений о раздаче видно — этап, сиды, скорость. */
async function watchNow(t) {
  const hash = (t && t.hash) || '';
  if (!hash) return;
  let cur = t;
  let files = playableOf(cur);
  if (!files.length) {
    const st = await waitForFiles(cur);
    if (!st) return;
    cur = Object.assign({}, cur, st);
    files = playableOf(cur);
  }
  if (!files.length) { toast('В раздаче нет воспроизводимых файлов', true); return; }
  const vids = files.filter(x => isVideo(x.path));
  if (vids.length === 1) return playSelected(cur, vids[0]);
  if (!vids.length) return playSelected(cur, files[0]);
  /* Несколько серий: выбор делает пользователь, а не догадка «начнём с первой». */
  return openEpisodesPicker(cur, vids);
}
/* nextEpisode — серия, которую логично смотреть дальше: первая не начатая,
   а если все начаты — самая ранняя. Отметка досмотра сильнее позиции. */
function nextEpisode(t, vids) {
  const sorted = vids.slice().sort((a, b) => epIdx(a.path) - epIdx(b.path) || a.path.localeCompare(b.path, 'ru', { numeric: true }));
  return sorted.find(f => !isWatched(t, f.id) && !(currentTc(t, f.id) > 0)) || sorted.find(f => !isWatched(t, f.id)) || sorted[0];
}
function epIdx(name) {
  const p = parseSeriesEp(name);
  if (!p) return Infinity;
  return (p.s || 0) * 1000 + (p.e || 0);
}
/* nextAfter — серия, идущая сразу за текущей по номерам. Это не то же самое, что
   nextEpisode («что смотреть дальше» по отметкам): кнопка «следующая серия»
   должна вести на E07 после E06, а не на пропущенную ранее серию. */
function nextAfter(t, vids, cur) {
  const sorted = vids.slice().sort((a, b) => epIdx(a.path) - epIdx(b.path) || a.path.localeCompare(b.path, 'ru', { numeric: true }));
  const i = sorted.findIndex(f => f.id === cur.id);
  return i >= 0 ? (sorted[i + 1] || null) : null;
}
function openEpisodesPicker(t, files, opts) {
  opts = opts || {};
  if (!files) {
    const cached = statCache[t.hash] && statCache[t.hash].data;
    if (cached && cached.file_stats) { files = playableOf(cached); }
  }
  if (!files || !files.length) {
    statTorrent(t.hash).then(s => {
      if (s && s.file_stats) {
        rememberStat(t.hash, s);
        const vids = playableOf(s).filter(x => isVideo(x.path));
        if (vids.length) openEpisodesPicker(t, vids);
        else toast('Нет воспроизводимых файлов', true);
      } else toast('Нет воспроизводимых файлов', true);
    }).catch(() => toast('Не удалось получить список файлов', true));
    return;
  }
  const ov = document.createElement('div'); ov.className = 'overlay';
  const next = nextEpisode(t, files);
  // Порядок раздачи — по сезону и серии, затем по имени: так же, как нумерует
  // файлы сервер, и так же, как это делал прежний клиент.
  const groups = new Map();
  files.forEach(f => {
    const p = parseSeriesEp(basename(f.path));
    const s = (p && p.s) || 0;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(f);
  });
  const seasons = [...groups.keys()].sort((a, b) => a - b);
  seasons.forEach(s => groups.get(s).sort((a, b) => epIdx(a.path) - epIdx(b.path) || basename(a.path).localeCompare(basename(b.path), 'ru', { numeric: true })));
  const done = files.filter(f => isWatched(t, f.id)).length;
  // Много сезонов — вкладки: одним списком в сотню серий приходилось листать
  // до нужного сезона. Открывается сезон следующей серии (или тот, что был
  // выбран до перерисовки), остальные — одним нажатием.
  const tabs = seasons.length > 1;
  const nextSn = ((p => (p && p.s) || 0)(parseSeriesEp(basename(next.path))));
  let cur = tabs ? (opts.season != null && groups.has(opts.season) ? opts.season : (groups.has(nextSn) ? nextSn : seasons[0])) : null;
  const tabHtml = !tabs ? '' : html`<div class="eps-tabs">${raw(seasons.map(sn => {
    const list = groups.get(sn);
    const w = list.filter(f => isWatched(t, f.id)).length;
    const full = w === list.length;
    return html`<button class="eps-tab${sn === cur ? ' on' : ''}${full ? ' full' : ''}" data-sn-tab="${sn}" title="просмотрено ${w} из ${list.length}">${sn ? 'Сезон ' + sn : 'Прочее'} <small>${full ? '✓' : w + '/' + list.length}</small></button>`;
  }).join(''))}</div>
    <div class="row eps-tools"><span class="page-sub" data-sn-sum></span><span style="flex:1"></span>
      <button class="ghost" data-sn-mark>✓ Отметить сезон</button></div>`;
  ov.innerHTML = html`<div class="modal wide">
    <button class="modal-close" data-close>✕</button>
    <div class="row"><div style="flex:1"><h2 style="margin-top:0">${t.title || t.name || t.hash}</h2>
      <div class="page-sub">Серий: ${files.length} · просмотрено: ${done} · следующая — ${epLabel(next, t)}</div></div>
      <button data-next>▶ Смотреть следующую</button></div>
    <div class="divider"></div>
    ${raw(tabHtml)}
    <div class="eps-list" style="max-height:60vh;overflow:auto">
      ${raw(seasons.map(sn => html`<div class="eps-season${tabs && sn !== cur ? ' hidden' : ''}" data-sn="${sn}">
        <div class="eps-season-h">${sn ? 'Сезон ' + sn : 'Эпизоды'}</div>
        ${raw(groups.get(sn).map(f => epRow(t, f, next, sn)).join(''))}
      </div>`).join(''))}
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  const cb = ov.querySelector('[data-close]'); if (cb) cb.addEventListener('click', close);
  ov.querySelector('[data-next]').addEventListener('click', () => { close(); playSelected(t, next); });
  $$('[data-ep]', ov).forEach(b => b.addEventListener('click', () => {
    const f = files.find(x => String(x.id) === b.dataset.ep); if (!f) return;
    close(); playSelected(t, f);
  }));
  // Отметка просмотра — прямое действие пользователя: позиция от плеера может
  // не дойти, если плеер о ней не сообщает.
  $$('[data-toggle]', ov).forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const id = parseInt(b.dataset.toggle, 10);
    const f = files.find(x => x.id === id); if (!f) return;
    const wasWatched = isWatched(t, id);
    b.disabled = true;
    const ok = await savePosition(t.hash, id, wasWatched ? 0 : null, 0, !wasWatched);
    b.disabled = false;
    if (!ok) return;
    toast(wasWatched ? 'Отметка снята' : 'Отмечено просмотренным');
    close(); openEpisodesPicker(t, files, { season: cur });
  }));
  const list = ov.querySelector('.eps-list');
  const showSeason = sn => {
    cur = sn;
    $$('.eps-season', ov).forEach(b => b.classList.toggle('hidden', parseInt(b.dataset.sn, 10) !== sn));
    $$('[data-sn-tab]', ov).forEach(b => b.classList.toggle('on', parseInt(b.dataset.snTab, 10) === sn));
    const g = groups.get(sn) || [];
    const w = g.filter(f => isWatched(t, f.id)).length;
    const sum = ov.querySelector('[data-sn-sum]');
    if (sum) sum.textContent = 'Серий в сезоне: ' + g.length + ' · просмотрено: ' + w;
    const mk = ov.querySelector('[data-sn-mark]');
    if (mk) mk.textContent = w === g.length ? '↺ Снять отметки сезона' : '✓ Отметить сезон';
    // Прокрутка — к следующей серии, если она в этом сезоне, иначе к началу.
    const row = ov.querySelector('.eps-season[data-sn="' + sn + '"] .eprow.next');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' }); else list.scrollTop = 0;
    loadEpDetails(ov, t, sn);
  };
  $$('[data-sn-tab]', ov).forEach(b => b.addEventListener('click', () => showSeason(parseInt(b.dataset.snTab, 10))));
  // Сезон целиком — одно нажатие, а не двадцать галочек: так начинают
  // смотреть с середины сериала или отмечают уже увиденное.
  const mark = ov.querySelector('[data-sn-mark]');
  if (mark) mark.addEventListener('click', async () => {
    const g = groups.get(cur) || [];
    const all = g.every(f => isWatched(t, f.id));
    mark.disabled = true;
    let ok = true;
    for (const f of g) {
      if (isWatched(t, f.id) !== all) continue;
      if (!(await savePosition(t.hash, f.id, all ? 0 : null, 0, !all))) { ok = false; break; }
    }
    mark.disabled = false;
    if (ok) toast(all ? 'Отметки сезона сняты' : 'Сезон отмечен просмотренным');
    close(); openEpisodesPicker(t, files, { season: cur });
  });
  if (tabs) showSeason(cur);
  else {
    const row = ov.querySelector('.eprow.next');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    loadEpDetails(ov, t);
  }
}
/* epLabel — человеческая подпись серии: «Сезон 1 · Серия 2». Так же называл
   серии прежний клиент, и так их понятнее искать глазами, чем «S01E02». */
function epLabel(f, t) {
  const p = parseSeriesEp(basename(f.path));
  if (p && (p.s || p.e)) {
    const s = p.s || (parseSeriesEp(t && t.title) || {}).s || 0;
    let lab = s ? 'Сезон ' + s + ' · ' : '';
    lab += p.e ? 'Серия ' + p.e + (p.e2 && p.e2 > p.e ? '–' + p.e2 : '') : 'сезон целиком';
    return lab;
  }
  return basename(f.path);
}
/* epFileName — название серии из имени файла. Релиз пишет его в скобках сразу
   после номера: «S02 E01 (Тихая жизнь) WEB-DL 1080p». TMDB отвечает не всегда
   (у него своя сеть и ключ), а имя серии нужно всегда, поэтому это запасной
   источник: разметку и год релизера именем серии не считаем. Когда TMDB ответит,
   loadEpDetails подставит своё, каноническое название. */
const RE_EP_NAME_JUNK = /^(?:\d{4}|2160p?|1080p?|720p?|480p?|4k|uhd|bdrip|blu-?ray|web-?dl|web-?rip|hdrip|hdtv|dvdrip|remux|sdr|hdr10?|hevc|x26[45]|mkv|avi|mp4|mov)$/i;
function epFileName(path) {
  const s = basename(path);
  const m = s.match(RE_SXEX) || s.match(RE_RU_EP);
  if (!m) return '';
  const tail = s.slice(m.index + m[0].length);
  const clean = x => x.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const junk = w => !w || RE_EP_NAME_JUNK.test(w) || /^\d+$/.test(w);
  // Скобки сразу после номера: «S02E01 (Тихая жизнь)». В скобках может
  // оказаться год или разрешение — тогда ищем дальше, а не выдаём мусор.
  const g = tail.match(/[[(]([^[\]()]{2,60})[\])]/);
  if (g) {
    const inBrackets = clean(g[1]);
    if (inBrackets && !junk(inBrackets)) return inBrackets;
  }
  // Иначе — слова после номера до первой технической приметы: год,
  // разрешение, кодек, «WEB-DL». Название может идти через дефис или точки,
  // поэтому режем только по пробелу и точке: «Sci-Fi» и «WEB-DL» останутся
  // целыми, а мусор справа отбросится.
  let rest = tail.replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/^[\s\-–—:]+/, '');
  const words = [];
  for (const w of rest.split(/[.\s·]+/)) {
    const t = w.trim();
    if (!t) continue;
    if (/^[[(]/.test(t) || junk(t)) break;
    words.push(t);
    if (words.join(' ').length > 60) break;
  }
  const name = clean(words.join(' '));
  if (!name || junk(name) || !/[\p{L}]/u.test(name)) return '';
  return name;
}
/* epRow — строка списка серий: подпись, название, дата выхода, длительность,
   описание и кадр из метаданных, состояние (просмотрено / продолжение / не
   начата) и отметка просмотра. Номер серии стоит и на строке, и на кнопке:
   подробности подставляются в строку, а нажатие обрабатывает кнопка. */
function epRow(t, f, next, season) {
  const tc = currentTc(t, f.id);
  const watched = isWatched(t, f.id);
  const isNext = next && next.id === f.id;
  const stateText = watched ? 'просмотрено' : (tc > 0 ? 'продолжить с ' + fmtPos(tc) : (isNext ? 'следующая' : 'не начата'));
  const cls = ['eprow'];
  if (watched) cls.push('watched');
  if (tc > 0) cls.push('started');
  if (isNext) cls.push('next');
  const p = parseSeriesEp(basename(f.path)) || {};
  const fb = epFileName(f.path);
  return html`<div class="${cls.join(' ')}" data-ep-row="${f.id}" data-ep-num="${p.e || 0}" data-sn="${season}">
    <button class="ep-main" data-ep="${f.id}" data-ep-num="${p.e || 0}" data-sn="${season}" title="${basename(f.path)}">
      <span class="ep-still"></span>
      <span class="ep-body">
        <span class="ep-line1"><span class="ep-label">${epLabel(f, t)}</span><span class="epname">${fb ? ' · ' + fb : ''}</span></span>
        <span class="ep-meta"></span>
        <span class="ep-over"></span>
        <span class="ep-state">${stateText}</span>
      </span>
    </button>
    <button class="ep-toggle${watched ? ' on' : ''}" data-toggle="${f.id}" title="${watched ? 'Снять отметку просмотра' : 'Отметить просмотренной'}">✓</button>
  </div>`;
}
/* Сведения о сезоне спрашиваются один раз на сериал и сезон и хранятся в памяти
   вкладки: и список серий в карточке, и окно выбора серии берут их оттуда. */
const epSeasonCache = {};
async function seasonInfo(q, sn) {
  const ck = q.toLowerCase() + '|s' + sn;
  if (epSeasonCache[ck] !== undefined) return epSeasonCache[ck];
  let season = null;
  try {
    const r = await fetch('/api/tv_eps?q=' + encodeURIComponent(q) + '&season=' + sn);
    const j = await r.json();
    // Отказ по ключу виден и здесь: без названий серий причина та же.
    if (j && j.error) noteMetaError(j.error);
    if (j && j.ok && Array.isArray(j.seasons)) season = j.seasons.find(x => Number(x.number) === sn) || null;
    // Запасной разбор: ответ прежнего вида — одни названия серий.
    if (!season && j && j.ok && j.name_by && j.name_by[sn]) {
      season = { number: sn, episodes: Object.keys(j.name_by[sn]).map(k => ({ number: Number(k), name: j.name_by[sn][k] })) };
    }
  } catch { season = null; }
  epSeasonCache[ck] = season;
  return season;
}
function epByName(season) {
  const by = {};
  ((season && season.episodes) || []).forEach(e => { if (e.name) by[e.number] = e.name; });
  return by;
}
function fmtAirDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '.' + m[2] + '.' + m[1] : String(s || '');
}
/* seasonHead — заголовок сезона: сколько серий, когда вышли. По нему видно, что
   перед вами целый сезон, а не одна раздача. */
function seasonHead(season, sn) {
  const eps = (season && season.episodes) || [];
  const dates = eps.map(e => e.air_date).filter(Boolean).sort();
  const bits = [];
  if (eps.length) bits.push(eps.length + ' ' + plural(eps.length, 'серия', 'серии', 'серий'));
  if (dates.length) {
    const a = fmtAirDate(dates[0]), b = fmtAirDate(dates[dates.length - 1]);
    bits.push(a === b ? a : a + ' — ' + b);
  }
  const rated = eps.filter(e => e.rating > 0);
  if (rated.length) bits.push((rated.reduce((n, e) => n + e.rating, 0) / rated.length).toFixed(1) + ' из 10');
  const name = season && season.name && !/^сезон\s*\d+$/i.test(season.name.trim()) ? season.name.trim() : '';
  return html`${sn ? 'Сезон ' + sn : 'Эпизоды'}${name ? ' · ' + name : ''}`
    + (bits.length ? html`<span class="ep-season-meta">${bits.join(' · ')}</span>` : '');
}
/* Названия серий подставляются и в списке серий, и во вкладке «Сериалы»,
   поэтому выборка идёт по номеру серии, а не по кнопке списка. */
async function loadEpNames(ov, t) {
  const q = cleanSeriesName(t.title || t.name || '');
  if (!q) return;
  const blocks = $$('.eps-season', ov);
  for (const block of blocks) {
    const sn = parseInt(block.dataset.sn, 10);
    if (!sn) continue;
    const by = epByName(await seasonInfo(q, sn));
    if (!Object.keys(by).length) continue;
    $$('[data-ep-num]', block).forEach(b => {
      const num = parseInt(b.dataset.epNum, 10);
      if (!num || !by[num]) return;
      const nm = b.querySelector('.epname');
      if (nm) nm.textContent = ' · ' + by[num];
      if (!b.title.includes(by[num])) b.title += ' — ' + by[num];
    });
  }
}
/* loadEpDetails наполняет окно выбора серии: заголовок сезона, дата выхода,
   длительность, оценка, описание и кадр. Список серий в карточке остаётся
   коротким — там для этого нет места. */
async function loadEpDetails(ov, t, only) {
  const q = cleanSeriesName(t.title || t.name || '');
  if (!q) return;
  // Сезоны подгружаются по мере открытия вкладок: у сериала на десять сезонов
  // десять запросов подряд задерживали как раз тот, что открыт.
  const blocks = $$('.eps-season', ov).filter(b => only == null || parseInt(b.dataset.sn, 10) === only);
  for (const block of blocks) {
    const sn = parseInt(block.dataset.sn, 10);
    if (!sn || block.dataset.loaded) continue;
    block.dataset.loaded = '1';
    const season = await seasonInfo(q, sn);
    if (!season) continue;
    const head = block.querySelector('.eps-season-h');
    if (head) head.innerHTML = seasonHead(season, sn);
    (season.episodes || []).forEach(ep => {
      const row = block.querySelector('[data-ep-num="' + ep.number + '"]');
      if (!row) return;
      const nm = row.querySelector('.epname');
      if (nm && ep.name) nm.textContent = ' · ' + ep.name;
      const meta = row.querySelector('.ep-meta');
      if (meta) {
        meta.textContent = [
          ep.air_date ? fmtAirDate(ep.air_date) : '',
          ep.runtime ? ep.runtime + ' мин' : '',
          ep.rating > 0 ? ep.rating.toFixed(1) : '',
        ].filter(Boolean).join(' · ');
      }
      const over = row.querySelector('.ep-over');
      if (over && ep.overview) over.textContent = ep.overview;
      const still = row.querySelector('.ep-still');
      if (still && ep.still) still.innerHTML = html`<img src="${pimg(ep.still)}" loading="lazy" alt="">`;
      if (ep.name && !row.title.includes(ep.name)) row.title += ' — ' + ep.name;
      if (ep.overview) row.title += '\n' + ep.overview;
    });
  }
}
function openServerInBrowser() {
  const p = state.profiles.find(x => x.id === state.active) || state.profiles[0];
  if (!p) return toast('Нет активного сервера', true);
  launchPlayer('browser', p.url, 'TorrServer');
}
function pickPlayer() {
  const def = localStorage.getItem('tc_defplayer');
  if (def && def !== 'browser') { const p = state.players.find(x => x.key === def && x.found); if (p) return def; }
  const pl = state.players.find(p => p.key !== 'browser' && p.found);
  return pl ? pl.key : 'browser';
}
async function launchPlayer(key, url, title, extra) {
  if (key === 'browser') {
    const r = await fetch('/api/player/launch?player=browser&url=' + encodeURIComponent(url), { method: 'POST' });
    try { const j = await r.json(); if (j.ok) return j; } catch {}
    toast('Не удалось открыть браузер', true);
    return null;
  }
  /* Раздачу и номер файла передаём демону: он отдаёт плееру плейлист всей
     раздачи, а не ссылку на одну серию, и сам ставит продолжение с места
     остановки. Без этого VLC видел одну серию и не видел списка. */
  let q = 'player=' + encodeURIComponent(key) + '&url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title || '');
  if (extra && extra.hash) {
    q += '&hash=' + encodeURIComponent(extra.hash);
    if (extra.index) q += '&index=' + encodeURIComponent(extra.index);
  }
  const r = await fetch('/api/player/launch?' + q, { method: 'POST' });
  let j = null;
  try { j = await r.json(); } catch {}
  if (j && j.ok) {
    if (j.url_mode === 'playlist') toast('Плееру передан список серий' + (j.resume ? ' — продолжение с места остановки' : ''));
    else if (!j.watching) toast('Плеер не сообщает позицию — отметку придётся ставить вручную');
    return j;
  }
  toast('Плеер не найден или не запустился', true);
  return null;
}

/* ---------- add magnet from search via appended event ---------- */
window.addEventListener('tc:runadd', e => {
  const hash = ((e.detail || '').match(/btih:([0-9a-fA-F]{40})/) || [null, e.detail || ''])[1].toLowerCase();
  setTimeout(() => { const t = state.lib.find(x => x.hash === hash); if (t) watchNow(t); else toast('Раздача добавлена — ищите в Библиотеке'); }, 900);
});


/* ---------- просмотр на телефоне ---------- */
function isRemoteUI() { return !!(state.hello && state.hello.remote); }
/* phoneStreamUrl — ссылка на серию для плеера телефона. Плеер не знает cookie
   браузера, поэтому пропуск (только к потоку) идёт в самой ссылке. */
function phoneStreamUrl(t, f) {
  const tk = (state.hello && state.hello.stream_token) || '';
  return makeStreamUrlFor(t, f) + (tk ? '&tk=' + encodeURIComponent(tk) : '');
}
function isAndroid() { return /android/i.test(navigator.userAgent || ''); }
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent || ''); }
/* phoneOpenPlayer открывает ссылку в плеере телефона. Android показывает выбор
   установленных плееров (VLC, MX Player…) по типу video/*; на iPhone — VLC. */
function phoneOpenPlayer(url, title) {
  if (isAndroid()) {
    const u = new URL(url);
    location.href = 'intent://' + u.host + u.pathname + u.search + '#Intent;scheme=' + u.protocol.replace(':', '') +
      ';type=video/*;S.title=' + encodeURIComponent(title || '') + ';end';
  } else if (isIOS()) {
    location.href = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(url);
  } else {
    window.open(url, '_blank');
  }
}
/* phoneBrowser — встроенный проигрыватель страницы. Браузер телефона играет
   MP4/H.264 и часто MKV с H.264; HEVC и AC3 — нет, тогда нужен плеер. */
function phoneBrowser(url, title, t, f) {
  const ov = document.createElement('div'); ov.className = 'overlay phone-video';
  ov.innerHTML = html`<div class="modal wide"><button class="modal-close" data-close>✕</button>
    <h3 style="margin-top:0">${title}</h3>
    <video controls autoplay playsinline preload="auto" src="${url}" style="width:100%;max-height:70vh;background:#000"></video>
    <div class="page-sub" data-vmsg>Если видео не идёт (кодек HEVC или звук AC3) — откройте в плеере.</div>
    <div class="row" style="margin-top:8px"><button data-ext>▶ В плеере телефона</button></div></div>`;
  document.body.appendChild(ov);
  const v = ov.querySelector('video');
  const pos = currentTc(t, f.id);
  if (pos > 5) v.addEventListener('loadedmetadata', () => { try { v.currentTime = pos; } catch (e) {} }, { once: true });
  // Позиция из браузера телефона сохраняется так же, как от плеера на компьютере.
  let last = 0;
  v.addEventListener('timeupdate', () => {
    if (Date.now() - last < 15000 || !v.duration) return;
    last = Date.now();
    const done = v.currentTime >= v.duration * 0.92;
    savePosition(t.hash, f.id, done ? 0 : v.currentTime, v.duration, done);
  });
  v.addEventListener('error', () => { ov.querySelector('[data-vmsg]').textContent = 'Браузер телефона не может показать этот файл — откройте в плеере.'; });
  ov.querySelector('[data-ext]').addEventListener('click', () => { v.pause(); phoneOpenPlayer(url, title); });
  ov.querySelector('[data-close]').addEventListener('click', () => { v.pause(); v.removeAttribute('src'); v.load(); ov.remove(); });
}
function phonePlay(t, f, opts) {
  const title = (t.title || t.name || 'stream') + epSuffix(f);
  const url = phoneStreamUrl(t, f);
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal"><button class="modal-close" data-close>✕</button>
    <h3 style="margin-top:0">Где смотреть?</h3>
    <div class="page-sub" style="margin-bottom:10px">${title}</div>
    <div class="phone-play">
      <button class="primary" data-pp="player">📱 В плеере телефона<small>VLC, MX Player — играет любые файлы</small></button>
      <button data-pp="browser">🌐 В браузере телефона<small>без установки, но не все кодеки</small></button>
      <button data-pp="pc">💻 На компьютере<small>телефон как пульт: плеер откроется там</small></button>
      <button class="ghost" data-pp="copy">🔗 Скопировать ссылку</button>
    </div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.querySelector('[data-close]').addEventListener('click', () => ov.remove());
  ov.querySelectorAll('[data-pp]').forEach(b => b.addEventListener('click', async () => {
    const how = b.dataset.pp;
    if (how === 'copy') {
      try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); } catch (e) { prompt('Ссылка на серию', url); }
      return;
    }
    ov.remove();
    trackPlay(t.hash, f.id, opts.fromZero ? 0 : currentTc(t, f.id));
    if (how === 'pc') return playSelected(t, f, Object.assign({}, opts, { onPC: true }));
    if (how === 'browser') return phoneBrowser(url, title, t, f);
    phoneOpenPlayer(url, title);
    refreshViewedSoon();
  }));
}
