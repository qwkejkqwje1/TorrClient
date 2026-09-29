/* QUALITY-BEGIN */
// rateRelease оценивает раздачу по названию, размеру и сидам: разрешение,
// источник, кодек, HDR, русская дорожка. Возвращает оценку 0–100 и подписи для
// подсказки. Оценка эвристическая: по названию нельзя узнать всё, поэтому
// честно говорит «по названию» и не заменяет ffprobe в карточке раздачи.
function rateRelease(r) {
  const t = String((r && (r.title || r.name)) || '');
  const seeds = Math.max(0, Number(r && r.seed) || 0);
  const bytes = Number(r && r.size_bytes) || 0;
  const has = re => re.test(t);
  const out = { score: 0, res: '', source: '', codec: '', hdr: '', audio: '', ru: false, bad: false, notes: [] };

  // Разрешение
  let resPts = 0;
  if (has(/\b(2160p?|4k|uhd)\b/i)) { out.res = '4K'; resPts = 40; }
  else if (has(/\b1080[pi]?\b|\bfull\s?hd\b|\bfhd\b/i)) { out.res = '1080p'; resPts = 32; }
  else if (has(/\b720p?\b|\bhd\b(?!tv|rip)/i)) { out.res = '720p'; resPts = 20; }
  else if (has(/\b(480p?|576p?|dvd-?rip|dvd-?9|dvd5|sdtv|sd)\b/i)) { out.res = 'SD'; resPts = 8; }

  // Источник
  let srcPts = 10;
  if (has(/\b(cam-?rip|camrip|hdcam|cam|telesync|ts|hdts|tc|telecine|scr|screener)\b/i) && !has(/\b(web|bd|blu)/i)) { out.source = 'Экранка'; out.bad = true; srcPts = 0; }
  else if (has(/\bremux\b|bd-?remux/i)) { out.source = 'Remux'; srcPts = 20; }
  else if (has(/\bblu-?ray\b|\bbdrip\b|\bbrrip\b|\bbd-?rip\b|\bbd(?:25|50|66|100)\b/i)) { out.source = 'BluRay'; srcPts = 18; }
  else if (has(/\bweb-?dl\b/i)) { out.source = 'WEB-DL'; srcPts = 17; }
  else if (has(/\bweb-?rip\b|\bwebdlrip\b/i)) { out.source = 'WEBRip'; srcPts = 13; }
  else if (has(/\bhdtv|\bhdtvrip\b|\bsat-?rip\b|\btv-?rip\b/i)) { out.source = 'HDTV'; srcPts = 9; }
  else if (has(/\bdvd-?rip\b|\bdvd\b/i)) { out.source = 'DVD'; srcPts = 8; }

  // Кодек и HDR
  let extra = 0;
  if (has(/\bav1\b/i)) { out.codec = 'AV1'; extra += 3; }
  else if (has(/\b(hevc|x265|h\.?265)\b/i)) { out.codec = 'HEVC'; extra += 3; }
  else if (has(/\b(avc|x264|h\.?264)\b/i)) { out.codec = 'AVC'; extra += 2; }
  if (has(/dolby.?vision|\bdv\b/i)) { out.hdr = 'Dolby Vision'; extra += 2; }
  else if (has(/\bhdr10\+?\b|\bhdr\b/i)) { out.hdr = 'HDR'; extra += 2; }

  // Русская дорожка: лицензия и дубляж лучше многоголоски, та лучше одноголоски
  let ruPts = 0;
  if (has(/дубл|\bdub\b|лицензи|\bлицуха\b|\bdubbed\b/i)) { out.audio = 'Дубляж'; out.ru = true; ruPts = 15; }
  else if (has(/\bmvo\b|многоголос|\bпм\b/i)) { out.audio = 'Многоголосый'; out.ru = true; ruPts = 12; }
  else if (has(/\bdvo\b|двухголос|\bдм\b/i)) { out.audio = 'Двухголосый'; out.ru = true; ruPts = 9; }
  else if (has(/\bavo\b|\bvo\b|одноголос|\bлм\b|\bлюбительск/i)) { out.audio = 'Одноголосый'; out.ru = true; ruPts = 6; }
  else if (has(/озвучк|\brus\b|русск|\bru\b|\brusdub\b/i)) { out.audio = 'Русская'; out.ru = true; ruPts = 8; }
  if (has(/\b(atmos|truehd|dts-?hd|dts-?x)\b/i)) extra += 1;
  if (has(/\bsub\b|субтитр|\bsubs?\b/i) && !out.ru) { out.notes.push('только субтитры'); ruPts = 2; }

  // Сиды: логарифм, чтобы 1000 сидов не давили всё остальное
  const seedPts = Math.min(15, Math.round(5 * Math.log10(seeds + 1)));
  if (!seeds) out.notes.push('нет сидов');

  // Размер: у «1080p» на полтора гигабайта или 720p на пять терабайт что-то не так
  let sizePts = 3;
  if (bytes) {
    const gb = bytes / 1e9;
    const lo = { '4K': 8, '1080p': 1.2, '720p': 0.5, 'SD': 0.3 }[out.res];
    const hi = { '4K': 120, '1080p': 80, '720p': 25, 'SD': 12 }[out.res];
    if (lo && gb < lo) { sizePts = 0; out.notes.push('размер мал для ' + out.res); }
    else if (hi && gb > hi) { sizePts = 1; out.notes.push('очень большой'); }
    else sizePts = 5;
  }

  let score = resPts + srcPts + seedPts + ruPts + extra + sizePts;
  if (out.bad) score = Math.min(score, 15);
  if (!seeds) score = Math.min(score, 30);
  out.score = Math.max(0, Math.min(100, Math.round(score)));
  out.tier = out.score >= 75 ? 'good' : out.score >= 50 ? 'ok' : 'low';
  return out;
}
function rateTip(q) {
  const parts = [];
  if (q.res) parts.push(q.res);
  if (q.source) parts.push(q.source);
  if (q.codec) parts.push(q.codec);
  if (q.hdr) parts.push(q.hdr);
  parts.push(q.audio ? 'звук: ' + q.audio : 'русская дорожка не указана');
  return 'Оценка по названию: ' + q.score + '/100 · ' + parts.join(' · ') + (q.notes.length ? ' · ' + q.notes.join(', ') : '');
}
// playVerdict по потокам ffprobe говорит, сыграет ли файл в окне программы, а
// если нет — почему и что делать. Честнее, чем ждать ошибку <video>.
function playVerdict(j) {
  const streams = (j && j.streams) || [];
  const v = streams.find(s => s.codec_type === 'video');
  const audio = streams.filter(s => s.codec_type === 'audio');
  const langs = audio.map(a => ((a.tags && (a.tags.language || a.tags.LANGUAGE)) || '').toLowerCase());
  const hasRu = langs.some(l => l === 'rus' || l === 'ru');
  const vOk = !v || /^(h264|vp8|vp9|av1)$/i.test(v.codec_name || '');
  const aOk = audio.length === 0 || audio.some(a => /^(aac|mp3|opus|vorbis|flac)$/i.test(a.codec_name || ''));
  const problems = [];
  if (!vOk) problems.push('видео ' + String(v.codec_name).toUpperCase() + ' не поддерживается браузером');
  if (!aOk) problems.push('звук ' + audio.map(a => String(a.codec_name).toUpperCase()).join('/') + ' не поддерживается браузером');
  return {
    ok: problems.length === 0,
    ru: hasRu,
    problems,
    text: problems.length
      ? 'В окне программы может не играть: ' + problems.join('; ') + '. Откройте во внешнем плеере.'
      : 'Кодеки подходят для воспроизведения в окне программы.',
  };
}
/* QUALITY-END */

function qTag(name) {
  if (/(2160|4k|uhd)/i.test(name)) return 'q2160';
  if (/(1080|fullhd|fhd|blu-ray|bdrip|web-dl.*1080|hd)\b/i.test(name)) return 'q1080';
  return '';
}

function bindTiles(grid) {
  $$('.tile', grid).forEach(tileEl => {
    const hash = tileEl.dataset.hash;
    const t = state.lib.find(x => x.hash === hash); if (!t) return;
    const w = tileEl.querySelector('[data-act="watch"]'); if (w) w.addEventListener('click', () => watchNow(t));
    tileEl.addEventListener('dblclick', e => { if (e.target.closest('.ctxmenu') || e.target.closest('.menu-ico')) return; watchNow(t); });
    const titleEl = tileEl.querySelector('[data-act="titled"]');
    if (titleEl) titleEl.addEventListener('click', e => { e.stopPropagation(); if (isSeries(t.title || t.name)) openEpisodesPicker(t); });
    const menuBtn = tileEl.querySelector('[data-menu]');
    const menu = tileEl.querySelector('.ctxmenu');
    if (menuBtn && menu) menuBtn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    const act = (sel, fn) => tileEl.querySelectorAll(sel).forEach(b => b.addEventListener('click', () => { menu && menu.classList.add('hidden'); fn(); }));
    act('[data-act="info"]', () => openTorrentModal(t));
    act('[data-act="edit"]', () => openEditModal(t));
    act('[data-act="m3u"]', () => downloadM3u(t));
    act('[data-act="copy"]', () => copyTorrentMagnet(t));
    act('[data-act="drop"]', () => dropTorrent(t));
    act('[data-del]', () => dropTorrent(t));
    act('[data-act="autoposter"]', () => autoPoster(t));
    // Подписка ведётся по названию сериала, а не по раздаче: сезон выходит
    // новыми раздачами, и следить за одной из них нечем.
    act('[data-act="subs"]', () => subsAdd(cleanSeriesName(t.title || t.name || '') || t.title || t.name || ''));
    act('[data-act="bm"]', () => { const f = firstPlayable(t); if (!f) return toast('Нет воспроизводимых файлов', true); addBookmark(t, f.id, basename(f.path)); });
    act('[data-act="coll"]', () => openCollectionPicker(t));
    act('[data-sa="kp"]', () => openExternal(kpSearchUrl(t.title || t.name || '')));
    act('[data-sa="imdb"]', () => openExternal(imdbUrlFor(t)));
  });
}

async function autoPoster(t) {
  const c = cleanSearchTitle(t.title || t.name || '');
  if (!c.q) return toast('Не удалось определить название', true);
  let j;
  try {
    const rr = await fetch('/api/tmdb?q=' + encodeURIComponent(c.q) + (c.year ? '&year=' + c.year : ''));
    j = await rr.json();
  } catch (e) { return toast('Ошибка TMDB: ' + e.message, true); }
  if (!j.ok || !j.poster) {
    noteMetaError(j.error);
    // Причину по-русски называет metaErrText; остальное — отказ самого
    // сервиса, и он показывается как есть.
    return toast(metaErrText(j.error) || ('Постер не найден: ' + (j.error || 'нет в TMDB')), true);
  }
  try {
    await torrentAction('set', { hash: t.hash, poster: j.poster, title: j.title || t.title || t.name });
    toast('Постер подгружен');
    rememberMeta(c, j);
    const cur = state.lib.find(x => x.hash === t.hash); if (cur) { cur.poster = j.poster; cur.title = j.title || cur.title; }
    delete statCache[t.hash];
    paintLibrary();
  } catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
}

/* openCollectionPicker — окно «в какие подборки положить раздачу».
   Одна раздача может лежать в нескольких подборках, поэтому это не выбор
   одного значения, а набор отметок. Удалить подборку можно тут же: отдельной
   страницы ради трёх списков делать незачем. */
function openCollectionPicker(t) {
  const list = collList();
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal">
    <button class="modal-close" data-close>✕</button>
    <h2>В подборку</h2>
    <div class="page-sub">${t.title || t.name || ''}</div>
    <div id="collPick">${raw(list.length
      ? list.map(c => html`<div class="row"><label style="flex:1"><input type="checkbox" data-coll="${c.id}"${collHas(c.id, t.hash) ? ' checked' : ''}> ${c.name}</label><button class="iconbtn" data-cdel="${c.id}" title="Удалить подборку">✕</button></div>`).join('')
      : '<div class="empty">Подборок пока нет — создайте первую ниже.</div>')}</div>
    <div class="divider"></div>
    <label>Новая подборка</label>
    <div class="row">
      <input id="collNewName" placeholder="Например: смотреть вечером" style="flex:1">
      <button id="collNewGo">Создать</button>
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end">
      <button data-close>Готово</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-coll]').forEach(cb => cb.addEventListener('change', () => {
    const added = collToggle(cb.dataset.coll, t.hash);
    toast(added ? 'Добавлено в подборку' : 'Убрано из подборки');
    fillCollSelect($('#libColl'), state.coll);
    if (state.coll) paintLibrary();
  }));
  ov.querySelectorAll('[data-cdel]').forEach(b => b.addEventListener('click', () => {
    const c = collById(b.dataset.cdel);
    if (!c) return;
    if (typeof confirm === 'function' && !confirm('Удалить подборку «' + c.name + '»? Раздачи останутся в библиотеке.')) return;
    collRemove(b.dataset.cdel);
    fillCollSelect($('#libColl'), state.coll);
    close();
    paintLibrary();
    toast('Подборка удалена');
  }));
  ov.querySelector('#collNewGo').addEventListener('click', () => {
    const name = (ov.querySelector('#collNewName').value || '').trim();
    if (!name) return toast('Введите название подборки', true);
    const id = collCreate(name);
    collToggle(id, t.hash);
    fillCollSelect($('#libColl'), state.coll);
    close();
    toast('Подборка создана, раздача в ней');
    paintLibrary();
  });
}

async function copyTorrentMagnet(t) {
  const link = await magnetFor(t);
  if (link) { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }
}
async function magnetFor(t) {
  if (t.torrs_hash) return 'torrs://' + t.torrs_hash.replace(/^torrs:\/\//, '');
  if (t.hash) return 'magnet:?xt=urn:btih:' + t.hash + (t.title ? '&dn=' + encodeURIComponent(t.title) : '');
  return '';
}

async function openAddModal() {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="modal">
    <button class="modal-close" data-close>✕</button><h2>Добавить торрент</h2>
    <div id="dropZone" class="card" style="text-align:center; padding:26px; border-style:dashed">
      Перетащите сюда .torrent файлы или магниты<br><small>(Drag&drop)</small>
      <button id="pickFile" style="margin-top:10px">Выбрать файл</button><input type="file" id="fileInput" multiple accept=".torrent" hidden>
    </div>
    <div class="divider"></div>
    <label>Магнитная ссылка / hash / ссылка на .torrent</label>
    <textarea id="addLink" rows="3" placeholder="magnet:?xt=urn:btih:..."></textarea>
    <label>Заголовок (необязательно)</label><input id="addTitle" placeholder="Название">
    <div class="row" style="margin-top:12px">
      <label style="flex:1"><input type="checkbox" id="addSave" checked> Сохранить в библиотеке сервера</label>
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end">
      <button data-close>Отмена</button><button id="addGo" class="primary">Добавить</button>
    </div></div>`;
  document.body.appendChild(ov);
  const dz = ov.querySelector('#dropZone');
  const fileInput = ov.querySelector('#fileInput');
  ov.querySelector('#pickFile').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => uploadFiles([...fileInput.files], ov));
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }));
  dz.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); ov.remove(); onDropFiles(e); });
  ov.querySelector('#addGo').addEventListener('click', async () => {
    const link = ov.querySelector('#addLink').value.trim();
    const title = ov.querySelector('#addTitle').value.trim();
    const save = ov.querySelector('#addSave').checked;
    if (!link) return toast('Введите магнит или ссылку', true);
    const btn = ov.querySelector('#addGo'); btn.disabled = true; btn.textContent = 'Добавление...';
    try {
      const raw = link.includes('/') && !link.startsWith('magnet:') ? link : link;
      let tmp;
      if (link.startsWith('magnet:') || /^[0-9a-f]{40}$/.test(link) || /^[A-Za-z0-9+/]{40,}=*$/.test(link.replace(/^torrs:\/\//i, ''))) {
        tmp = await torrentAction('add', { link, save_to_db: save });
      } else if (/^[a-f0-9]{40}$/i.test(link)) {
        tmp = await torrentAction('add', { link, save_to_db: save });
      } else {
        // could be a http(s) magnet handler
        tmp = await torrentAction('add', { link, save_to_db: save });
      }
      ov.remove(); toast('Торрент добавлен'); loadLibrary().then(() => { state.view = 'library'; route(); });
    } catch (e) { btn.disabled = false; btn.textContent = 'Добавить'; toast('Ошибка: ' + e.message, true); }
  });
}

let uploadBusy = false;
async function onDropFiles(e) {
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  let texts = [];
  if (e.dataTransfer && e.dataTransfer.items) {
    for (const it of e.dataTransfer.items) { if (it.kind === 'string' && it.type === 'text/plain') { const t = await new Promise(r => it.getAsString(r)); texts.push(t); } }
  }
  const magnets = texts.filter(t => t.toLowerCase().includes('magnet:'));
  if (magnets.length) { for (const m of magnets) { try { await torrentAction('add', { link: m.trim(), save_to_db: true }); toast('Добавлен: ' + short(m)); } catch (err) { toast('Ошибка магнита: ' + err.message, true); } } refreshLibrary(); }
  const tf = files.filter(f => /\.torrent$/i.test(f.name)) || files.filter(f => /\.(torrent|magnet)$/i.test(f.name));
  if (tf.length) { for (const f of tf) { await uploadFile(f); } }
  if (texts.length && !magnets.length) { const l = texts.join('\n'); showAddFromText(l); }
}
function short(s) { const m = s.match(/dn=([^&]+)/); return m ? decodeURIComponent(m[1]).slice(0, 40) : s.slice(0, 40); }
function showAddFromText(text) {
  const add = $('.overlay #addLink'); if (add) { add.value = text; return; }
  toast('Вставьте текст в окно добавления');
  state.view = 'library'; route(); openAddModal();
}
async function uploadFile(file) {
  const fd = new FormData(); fd.append('file', file); fd.append('save', '1');
  try {
    const r = await fetch(ts('/torrent/upload'), { method: 'POST', body: fd });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('Загружен: ' + file.name);
  } catch (e) { toast('Ошибка загрузки ' + file.name + ': ' + e.message, true); }
  refreshLibrary();
}
async function uploadFiles(files, ov) {
  for (const f of files) await uploadFile(f);
  if (ov) ov.remove();
}

async function dropTorrent(t) {
  if (!confirm('Убрать торрент с сервера?')) return;
  try { await torrentAction('rem', { hash: t.hash }); delete statCache[t.hash]; toast('Торрент удалён'); } catch (e) { toast('Ошибка: ' + e.message, true); }
  refreshLibrary();
}
function downloadM3u(t) {
  const url = ts(`/playlist?hash=${encodeURIComponent(t.hash)}&m3u`);
  const a = document.createElement('a'); a.href = url; a.download = (t.title || 'all') + '.m3u';
  document.body.appendChild(a); a.click(); a.remove();
}
function openEditModal(t) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal">
    <button class="modal-close" data-close>✕</button><h2>Изменить торрент</h2>
    <label>Название</label><input id="edTitle" value="${t.title || t.name || ''}">
    <label>Категория</label><select id="edCat">
      <option value="">(без категории)</option>
      <option value="movie" ${t.category === 'movie' ? 'selected' : ''}>Фильм</option>
      <option value="tv" ${t.category === 'tv' ? 'selected' : ''}>Сериал</option>
      <option value="music" ${t.category === 'music' ? 'selected' : ''}>Музыка</option>
      <option value="other" ${t.category === 'other' ? 'selected' : ''}>Другое</option>
    </select>
    <label>Постер (URL)</label><input id="edPoster" value="${t.poster || ''}">
    <div class="row" style="justify-content:flex-end; margin-top:12px">
      <button data-close>Отмена</button><button id="edGo" class="primary">Сохранить</button>
    </div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#edGo').addEventListener('click', async () => {
    const title = ov.querySelector('#edTitle').value;
    const poster = ov.querySelector('#edPoster').value.trim();
    // Кнопка гасится на время запроса: без этого второе нажатие уходило вторым
    // запросом, а окно закрывалось только по ответу первого — и «сохранил, но
    // ничего не изменилось» выглядело как потеря правки.
    const go = ov.querySelector('#edGo');
    go.disabled = true;
    try {
      await torrentAction('set', { hash: t.hash, title: title, category: ov.querySelector('#edCat').value, poster: poster });
      // TorrServer поле poster не хранит, поэтому введённый вручную адрес
      // запоминается отдельно — иначе он пропадал бы при первой же перезагрузке
      // списка (loadLibrary заменяет state.lib новым массивом).
      const c = cleanSearchTitle(title || t.title || t.name || '');
      if (poster) rememberPoster(c, poster); else forgetPoster(c);
      ov.remove(); refreshLibrary();
    } catch (e) {
      toast('Не сохранилось: ' + e.message, true);
      go.disabled = false;
    }
  });
}
function copyToClip(txt, msg) { navigator.clipboard.writeText(txt).then(() => toast(msg || 'Скопировано')); }

