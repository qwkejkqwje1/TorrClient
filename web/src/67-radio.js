/* ================= АУДИО · РАДИО =================
   Те же станции, что в радио Hermes Agent: Nightride FM (Chillsynth,
   Nightride, Darksynth, Spacesynth), Radio Paradise (Main и Mellow Mix) и EVE
   Radio, плюс поиск по каталогу Radio Browser (50 тысяч станций), жанры и
   «Россия». Закреплённые станции, громкость, следующая станция, ссылка на
   сайт вещателя, название песни (где вещатель его отдаёт) и живая форма
   волны по настоящему звуку.
   Звук читается, только если станция отвечает с CORS: тогда она подключается
   к общему графу (осциллограф, танцовщица). Если нет — поток играет мимо
   графа, а вместо волны показывается индикатор активности, а не выдуманные
   уровни. Пауза отпускает поток; «играть» возвращает в прямой эфир. */

const NIGHTRIDE = 'https://stream.nightride.fm/';
const RADIO_PRESETS = [
  { id: 'chillsynth', name: 'Chillsynth', description: 'Мягкий фокус · тёплые синты', provider: 'Nightride FM', url: NIGHTRIDE + 'chillsynth.mp3', homepage: 'https://nightride.fm/?station=chillsynth' },
  { id: 'nightride', name: 'Nightride', description: 'Синтвейв · после полуночи', provider: 'Nightride FM', url: NIGHTRIDE + 'nightride.mp3', homepage: 'https://nightride.fm/' },
  { id: 'darksynth', name: 'Darksynth', description: 'Тёмная электроника · высокая энергия', provider: 'Nightride FM', url: NIGHTRIDE + 'darksynth.mp3', homepage: 'https://nightride.fm/?station=darksynth' },
  { id: 'spacesynth', name: 'Spacesynth', description: 'Космические синты · ретро-будущее', provider: 'Nightride FM', url: NIGHTRIDE + 'spacesynth.mp3', homepage: 'https://nightride.fm/?station=spacesynth' },
  { id: 'paradise-main', name: 'Main Mix', description: 'Эклектика · подобрано людьми', provider: 'Radio Paradise', url: 'https://stream.radioparadise.com/aac-128', homepage: 'https://radioparadise.com/' },
  { id: 'paradise-mellow', name: 'Mellow Mix', description: 'Помедленнее и помягче', provider: 'Radio Paradise', url: 'https://stream.radioparadise.com/mellow-flac', homepage: 'https://radioparadise.com/' },
  { id: 'eve-radio', name: 'EVE Radio', description: 'GamingNow · радио сообщества EVE', provider: 'GamingNow', url: 'https://media01.gamingnow.net:8010/erweb.mp3', homepage: 'https://gamingnow.net/eve-radio/' },
];
const RADIO_META = { 'stream.nightride.fm': NIGHTRIDE + 'status-json.xsl', 'media01.gamingnow.net': 'https://media01.gamingnow.net:8010/status-json.xsl' };
const RADIO_TAGS = [['', 'Популярные'], ['@RU', 'Россия'], ['synthwave', 'Синтвейв'], ['lofi', 'Lo-fi'], ['chillout', 'Чилаут'], ['electronic', 'Электроника'], ['rock', 'Рок'], ['jazz', 'Джаз'], ['classical', 'Классика'], ['80s', '80-е'], ['news', 'Новости']];
const rd = { list: null, q: '', busy: false, err: '', station: null, status: 'idle', title: '', a: null, b: null, cors: true, servers: ['https://de1.api.radio-browser.info'], discovered: false, metaT: 0, raf: 0, traces: [] };

function radioPins() { const a = jsonPref('tc_radiopins', null); return Array.isArray(a) ? a : RADIO_PRESETS.slice(0, 3); }
function saveRadioPins(l) { saveJson('tc_radiopins', l.slice(0, 40)); }
function sameStation(a, b) { return a && b && (a.id === b.id || a.url === b.url); }
function radioEl() { if (!rd.station) return null; return { el: rd.cors ? rd.a : rd.b, cors: rd.cors }; }
function radioElem(cors) {
  const k = cors ? 'a' : 'b';
  if (rd[k]) return rd[k];
  const el = document.createElement('audio');
  if (cors) el.crossOrigin = 'anonymous';
  el.preload = 'none';
  el.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('tc_muvol') || 0.8)));
  el.addEventListener('playing', () => { rd.status = 'live'; paintRadioStatus(); radioMeta(); });
  el.addEventListener('waiting', () => { if (rd.status === 'live') { rd.status = 'connecting'; paintRadioStatus(); } });
  el.addEventListener('pause', () => { paintMusicPlayer(); paintNowPlaying(); });
  el.addEventListener('error', () => {
    if (!rd.station || el !== (rd.cors ? rd.a : rd.b) || !el.getAttribute('src')) return;
    // Станция без CORS: повторяем без анализа, как обычный поток.
    if (cors) { rd.cors = false; const b = radioElem(false); b.src = rd.station.url; b.play().catch(() => {}); return; }
    rd.status = 'error'; paintRadioStatus(); toast('Станция не отвечает: ' + rd.station.name, true);
  });
  document.body.appendChild(el);
  rd[k] = el;
  return el;
}
function radioPlay(st) {
  if (mu.audio && !mu.audio.paused) mu.audio.pause();
  if (mu.kind === 'book') bookSavePos(true);
  radioStop(true);
  rd.station = st; rd.cors = true; rd.status = 'connecting'; rd.title = '';
  mu.kind = 'radio';
  savePref('tc_radiolast', JSON.stringify(st));
  const el = radioElem(true);
  auHook(el);
  el.src = st.url; el.play().catch(() => {});
  dancerNewTrack();
  paintMusicPlayer(); paintNowPlaying(); paintRadioList();
}
function radioStop(keepKind) {
  for (const el of [rd.a, rd.b]) if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
  clearTimeout(rd.metaT);
  if (!keepKind) { rd.station = null; rd.status = 'idle'; if (mu.kind === 'radio') mu.kind = ''; paintMusicPlayer(); paintNowPlaying(); paintRadioList(); }
}
function radioToggle() {
  const r = radioEl(); if (!r) return;
  // Пауза отпускает поток: вернуться можно только в прямой эфир.
  if (!r.el.paused) { r.el.pause(); r.el.removeAttribute('src'); r.el.load(); rd.status = 'paused'; paintMusicPlayer(); paintNowPlaying(); return; }
  radioPlay(rd.station);
}
function radioCurrentList() { return rd.list && rd.list.length ? rd.list : radioPins().concat(RADIO_PRESETS.filter(p => !radioPins().some(x => sameStation(x, p)))); }
function radioNext(d) {
  const l = radioCurrentList(); if (!l.length) return;
  const i = l.findIndex(x => sameStation(x, rd.station));
  radioPlay(l[(i + (d || 1) + l.length) % l.length]);
}
function radioNow() {
  if (!rd.station) return null;
  const r = radioEl();
  return { label: rd.title || rd.station.name, sub: (r && r.el.paused ? 'пауза · ' : 'радио · ') + rd.station.name, paused: !r || r.el.paused };
}

/* ── каталог Radio Browser ── */
async function rbFetch(path) {
  if (!rd.discovered) {
    rd.discovered = true;
    try {
      const s = await (await fetch(rd.servers[0] + '/json/servers', { signal: AbortSignal.timeout(8000) })).json();
      const hosts = [...new Set(s.map(x => x.name).filter(n => /^[a-z0-9-]+\.api\.radio-browser\.info$/.test(n)))];
      if (hosts.length) rd.servers = hosts.map(n => 'https://' + n).sort(() => Math.random() - 0.5);
    } catch {}
  }
  let last;
  for (const srv of rd.servers.slice(0, 3)) {
    try { const r = await fetch(srv + path, { signal: AbortSignal.timeout(10000), credentials: 'omit' }); if (r.ok) return await r.json(); last = new Error('HTTP ' + r.status); } catch (e) { last = e; }
  }
  throw last || new Error('каталог не отвечает');
}
function rbStations(rows) {
  const seen = new Set();
  return (rows || []).flatMap(r => {
    const url = r.url_resolved || r.url;
    if (!/^https?:\/\//.test(url || '') || !r.stationuuid || !r.name || r.hls || seen.has(url)) return [];
    seen.add(url);
    return [{ id: r.stationuuid, name: r.name.trim().slice(0, 80), url, provider: [r.country, r.codec && r.codec + (r.bitrate ? ' ' + r.bitrate : '')].filter(Boolean).join(' · '), description: (r.tags || '').split(',').filter(Boolean).slice(0, 3).join(' · '), homepage: /^https?:/.test(r.homepage || '') ? r.homepage : '', favicon: /^https:/.test(r.favicon || '') ? r.favicon : '' }];
  });
}
async function radioSearch(q, tag) {
  rd.busy = true; rd.err = ''; paintRadioList();
  try {
    const base = 'limit=60&hidebroken=true&order=votes&reverse=true';
    let path;
    if (tag === '@RU') path = '/json/stations/bycountrycodeexact/RU?' + base;
    else if (tag) path = '/json/stations/bytagexact/' + encodeURIComponent(tag) + '?' + base;
    else if (q) path = '/json/stations/search?name=' + encodeURIComponent(q) + '&' + base;
    else path = '/json/stations/topvote/60?hidebroken=true';
    const local = q ? RADIO_PRESETS.filter(p => (p.name + ' ' + p.provider + ' ' + p.description).toLowerCase().includes(q.toLowerCase())) : [];
    const found = rbStations(await rbFetch(path));
    rd.list = local.concat(found.filter(f => !local.some(l => sameStation(l, f))));
  } catch (e) { rd.err = e.message; rd.list = []; }
  rd.busy = false; paintRadioList();
}

/* ── вкладка ── */
function renderRadio(el) {
  el.innerHTML = html`<div class="rd-now" id="rdNow"></div>
    <div class="mu-search">
      <span class="sb-ico">${raw(ico('search', 18))}</span>
      <input id="rdQ" placeholder="Станция, город, жанр…" value="${rd.q}" autocomplete="off">
      <button id="rdGo" class="primary">Найти</button>
    </div>
    <div class="rd-tags">${raw(RADIO_TAGS.map(([t, l]) => html`<button class="chip" data-rd-tag="${t}">${l}</button>`).join(''))}</div>
    <div id="rdList"></div>`;
  const q = $('#rdQ');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { rd.q = q.value.trim(); radioSearch(rd.q); } });
  $('#rdGo').addEventListener('click', () => { rd.q = q.value.trim(); radioSearch(rd.q); });
  paintRadioStatus(); paintRadioList();
}
function stationRow(s, i, from) {
  const cur = sameStation(s, rd.station), pinned = radioPins().some(x => sameStation(x, s));
  const playing = cur && rd.status !== 'paused' && rd.status !== 'idle';
  return html`<div class="mu-row rd-row${cur ? ' best' : ''}">
    <button class="mu-play" data-rd-play="${from}:${i}" title="${playing ? 'Пауза' : 'Слушать'}">${raw(ico(playing ? 'pause' : 'play', 14))}</button>
    ${raw(s.favicon ? `<img class="rd-ico" src="${esc(s.favicon)}" alt="" loading="lazy" onerror="this.remove()">` : '')}
    <div class="mu-main"><div class="mu-t">${s.name}</div><div class="mu-s">${[s.provider, s.description].filter(Boolean).join(' · ')}</div></div>
    <button class="iconbtn${pinned ? ' on' : ''}" data-rd-pin="${from}:${i}" title="${pinned ? 'Открепить' : 'Закрепить'}">${raw(ico('star', 15))}</button>
  </div>`;
}
function paintRadioList() {
  const el = $('#rdList'); if (!el) return;
  const pins = radioPins();
  let h = '';
  if (rd.busy) h += skeleton('Ищу станции…', 3);
  else if (rd.list) h += rd.list.length ? html`<div class="mu-h">Найдено ${rd.list.length} <button class="btn sm ghost" data-rd-clear>×</button></div><div class="mu-list">${raw(rd.list.map((s, i) => stationRow(s, i, 'l')).join(''))}</div>` : html`<div class="empty">Станций не нашлось.${rd.err ? ' ' + rd.err : ''}</div>`;
  if (pins.length) h += html`<div class="mu-h">Закреплённые</div><div class="mu-list">${raw(pins.map((s, i) => stationRow(s, i, 'p')).join(''))}</div>`;
  h += html`<div class="mu-h">Подборка</div><div class="mu-list">${raw(RADIO_PRESETS.map((s, i) => stationRow(s, i, 'r')).join(''))}</div>`;
  el.innerHTML = h;
}
function stationFrom(ref) { const [w, i] = String(ref).split(':'); const l = w === 'l' ? rd.list || [] : w === 'p' ? radioPins() : RADIO_PRESETS; return l[+i]; }
function paintRadioStatus() {
  const el = $('#rdNow');
  if (el) {
    if (!rd.station) el.innerHTML = '';
    else {
      el.innerHTML = html`<canvas id="rdWave"></canvas><div class="rd-now-t"><small>${rd.station.provider || 'Радио'} · ${({ live: '● в эфире', connecting: 'подключаюсь…', paused: 'пауза', error: 'не отвечает' })[rd.status] || ''}${rd.cors ? '' : ' · звук без анализа'}</small><b>${rd.title || rd.station.name}</b>${raw(rd.title ? html`<span>${rd.station.name}</span>` : '')}</div>
        ${raw(rd.station.homepage ? html`<button class="btn sm ghost" data-rd-site>Сайт станции ↗</button>` : '')}`;
      radioWaveStart();
    }
  }
  const t = $('#rdBarT'); if (t) t.innerHTML = radioBarTitle();
  paintNowPlaying();
}

/* название песни: Icecast-статус Nightride и EVE, пока играет */
async function radioMeta() {
  clearTimeout(rd.metaT);
  const st = rd.station; if (!st || rd.status !== 'live') return;
  let u; try { u = new URL(st.url); } catch { return; }
  const ep = RADIO_META[u.hostname]; if (!ep) return;
  try {
    const j = await (await fetch(ep, { signal: AbortSignal.timeout(8000), credentials: 'omit' })).json();
    const src = [].concat((j.icestats && j.icestats.source) || []).find(s => String(s.listenurl || '').endsWith(u.pathname));
    const title = src && typeof src.title === 'string' ? src.title.trim() : '';
    if (sameStation(st, rd.station) && title !== rd.title) { rd.title = title; paintRadioStatus(); dancerNewTrack(); }
  } catch {}
  rd.metaT = setTimeout(radioMeta, 25000);
}

/* живая волна с двумя тусклыми следами прошлых кадров */
function radioWaveStart() {
  cancelAnimationFrame(rd.raf);
  const cv = $('#rdWave'); if (!cv) return;
  const draw = () => {
    if (!cv.isConnected) return;
    rd.raf = requestAnimationFrame(draw);
    if (document.hidden) return;
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#7cb0ff';
    const r = radioEl(), an = r && r.cors && !r.el.paused ? auHook(r.el) : null;
    if (an) {
      an.getByteTimeDomainData(auGraph.wave);
      const pts = []; const n = 160, step = Math.floor(auGraph.wave.length / n);
      for (let i = 0; i < n; i++) pts.push((auGraph.wave[i * step] - 128) / 128);
      rd.traces.unshift(pts); rd.traces.length = Math.min(rd.traces.length, 3);
      rd.traces.slice().reverse().forEach((p, k, arr) => {
        const age = arr.length - 1 - k;
        c.strokeStyle = acc; c.globalAlpha = age ? 0.18 / age : 0.95; c.lineWidth = age ? 1 : 1.6;
        c.beginPath(); p.forEach((v, i) => { const x = i / (n - 1) * w, y = h / 2 + v * h * 0.45; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
      });
      c.globalAlpha = 1;
    } else {
      // без доступа к звуку — честный индикатор активности, а не выдуманная волна
      const t = performance.now() / 1000, live = r && !r.el.paused;
      c.fillStyle = acc;
      for (let i = 0; i < 5; i++) { c.globalAlpha = live ? 0.3 + 0.7 * Math.max(0, Math.sin(t * 4 - i * 0.7)) : 0.2; c.beginPath(); c.arc(w / 2 + (i - 2) * 14, h / 2, 3.5, 0, Math.PI * 2); c.fill(); }
      c.globalAlpha = 1;
    }
  };
  draw();
}

function radioBarTitle() {
  if (!rd.station) return '';
  return html`<b title="${rd.title || rd.station.name}">${rd.title || rd.station.name}</b><small>${rd.station.name} · ${({ live: 'в эфире', connecting: 'подключаюсь…', paused: 'пауза — «играть» вернёт в эфир', error: 'станция не отвечает' })[rd.status] || ''}</small>`;
}
function radioBarHtml() {
  const r = radioEl(), playing = r && !r.el.paused;
  const pinned = radioPins().some(x => sameStation(x, rd.station));
  return html`<div class="mu-bar${playing ? ' playing' : ''}"><div class="mu-np">
    <div class="mu-bar-cov rd-cov">${raw(rd.station.favicon ? `<img src="${esc(rd.station.favicon)}" alt="">` : '📻')}</div>
    <div class="mu-bar-t" id="rdBarT">${raw(radioBarTitle())}</div>
    <div class="mu-ctl">
      <button class="iconbtn mu-pp" data-mu-pp title="${playing ? 'Пауза (отпустить поток)' : 'Играть — в прямой эфир'}">${raw(ico(playing ? 'pause' : 'play', 17))}</button>
      <button class="iconbtn" data-mu-next title="Следующая станция">⏭</button>
      <button class="iconbtn${pinned ? ' on' : ''}" data-rd-pinnow title="Закрепить станцию">${raw(ico('star', 15))}</button>
      <button class="iconbtn" data-mu-stop title="Выключить радио">${raw(ico('stop', 14))}</button>
    </div>
    <div class="mu-side"><input type="range" class="mu-vol" min="0" max="100" value="${Math.round((r ? r.el.volume : 0.8) * 100)}" id="rdVol" title="Громкость"></div>
  </div></div>`;
}
function bindRadioBar() {
  const v = $('#rdVol'); if (v) v.addEventListener('input', () => { for (const el of [rd.a, rd.b, mu.audio]) if (el) el.volume = v.value / 100; savePref('tc_muvol', v.value / 100); });
}
function togglePin(s) {
  const l = radioPins(), i = l.findIndex(x => sameStation(x, s));
  if (i >= 0) l.splice(i, 1); else l.unshift(s);
  saveRadioPins(l); paintRadioList(); if (mu.kind === 'radio') paintMusicPlayer();
}
function onRadioClick(t) {
  const g = (sel, k) => { const b = t.closest(sel); return b ? b.dataset[k] : null; };
  let v;
  if ((v = g('[data-rd-play]', 'rdPlay')) != null) { const s = stationFrom(v); if (!s) return true; if (sameStation(s, rd.station) && rd.status !== 'paused') radioToggle(); else radioPlay(s); return true; }
  if ((v = g('[data-rd-pin]', 'rdPin')) != null) { const s = stationFrom(v); if (s) togglePin(s); return true; }
  if (t.closest('[data-rd-pinnow]')) { if (rd.station) togglePin(rd.station); return true; }
  if ((v = g('[data-rd-tag]', 'rdTag')) != null) { document.querySelectorAll('[data-rd-tag]').forEach(b => b.classList.toggle('on', b.dataset.rdTag === v)); radioSearch('', v); return true; }
  if (t.closest('[data-rd-clear]')) { rd.list = null; rd.q = ''; const q = $('#rdQ'); if (q) q.value = ''; document.querySelectorAll('[data-rd-tag]').forEach(b => b.classList.remove('on')); paintRadioList(); return true; }
  if (t.closest('[data-rd-site]')) { if (rd.station && rd.station.homepage) launchPlayer('browser', rd.station.homepage); return true; }
  return false;
}
