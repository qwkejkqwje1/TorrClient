/* ================= SERVER ================= */
function renderServer(root) {
  root.innerHTML = `
    <div class="toolbar"><div class="grow"><h1 class="page-title">Настройки сервера</h1>
    <div class="page-sub" id="serAct"></div></div></div>
    <div class="card"><div class="row">
      <div class="grow">Веб-интерфейс TorrServer для углублённых настроек.</div>
      <button id="openTs" class="primary">Открыть сервер в браузере</button>
    </div></div>
    <div class="card" id="tsUpdCard"><h3>Обновление TorrServer MatriX</h3><div id="tsUpdBody" class="page-sub">Проверяю версию…</div></div>
    <div class="card"><div class="tabs">
      <button data-ss="settings" class="on">BitTorr</button>
      <button data-ss="info">О сервере</button>
    </div><div id="serverPane"></div></div>`;
  const prof = state.profiles.find(p => p.id === state.active) || {};
  $('#serAct').textContent = 'Активный сервер: ' + prof.name;
  $$('[data-ss]').forEach(b => b.addEventListener('click', () => {
    $$('[data-ss]').forEach(x => x.classList.remove('on')); b.classList.add('on');
    renderServerPane(b.dataset.ss);
  }));
  renderServerPane('settings');
  const ob = $('#openTs'); if (ob) ob.addEventListener('click', openServerInBrowser);
  paintTsUpdate(false);
}
/* paintTsUpdate — текущая и последняя версия TorrServer и кнопка обновления.
   Скачивает и ставит демон; здесь только кнопка и ход процесса. */
let tsUpdPoll = null;
async function paintTsUpdate(force, body) {
  const el = $('#tsUpdBody'); if (!el) { clearTimeout(tsUpdPoll); return; }
  let j;
  try {
    j = await api('/api/tsupdate' + (force ? '?force=1' : ''), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  } catch (e) { el.innerHTML = html`<span class="err-text">${e.message}</span> <button id="tsUpdRetry">Проверить снова</button>`; const b = $('#tsUpdRetry'); if (b) b.onclick = () => paintTsUpdate(true); return; }
  const mb = n => (n / 1048576).toFixed(1) + ' МБ';
  const busy = j.state === 'downloading' || j.state === 'restarting';
  let line = 'Установлена: <b>' + (j.current ? esc(j.current) : 'не отвечает') + '</b> · последняя: <b>' + (j.latest ? esc(j.latest) : '—') + '</b>' + (j.size ? ' (' + mb(j.size) + ')' : '');
  let act = '';
  if (busy) act = esc(j.note || '') + (j.state === 'downloading' && j.total ? ' — ' + Math.round(100 * j.got / j.total) + '%' : '') + '…';
  else if (j.state === 'done') act = '✓ ' + esc(j.note || 'Обновлено');
  else if (j.state === 'failed') act = '<span class="err-text">Не удалось: ' + esc(j.note || '') + '</span>';
  let btn = '';
  if (!busy) {
    if (!j.local) btn = '<div>Активный сервер не на этом компьютере — обновите TorrServer там, где он установлен.</div>';
    else if (!j.found) btn = '<div>Файл TorrServer не найден рядом с программой — обновить можно только тот, что поставлен вместе с TorrClient.</div>';
    else if (j.newer) btn = '<button id="tsUpdGo" class="primary">Обновить до ' + esc(j.latest) + '</button>';
    else if (j.latest && j.current) btn = '<span>Установлена последняя версия.</span> <button id="tsUpdGo">Переустановить</button>';
  }
  el.innerHTML = line + (j.error ? '<div class="err-text">' + esc(j.error) + '</div>' : '') + (act ? '<div>' + act + '</div>' : '') + '<div class="row wrap" style="margin-top:6px">' + btn + ' <button id="tsUpdCheck" class="iconbtn" title="Проверить на GitHub">⟳</button></div>';
  const go = $('#tsUpdGo'); if (go) go.onclick = () => { if (confirm('TorrServer перезапустится — текущий просмотр прервётся. Обновить?')) paintTsUpdate(false, { action: 'install' }); };
  const ck = $('#tsUpdCheck'); if (ck) ck.onclick = () => paintTsUpdate(true);
  clearTimeout(tsUpdPoll);
  if (busy) tsUpdPoll = setTimeout(() => paintTsUpdate(false), 1000);
}
let _serverSets = null;

/* Набор «только оперативная память, без следов». Кэш живёт в RAM и
   освобождается при снятии раздачи, на диск не пишется ничего, отдача
   выключена — сервер не раздаёт и не копит за собой данных.

   Числа подобраны под стриминг: кэш 128 МБ (вдвое больше умолчания — хватает
   на 4K без постоянных докачек), предзагрузка 30 % (старт быстрый, и RAM не
   занимается зря), лимит соединений скромный, простаивающая раздача снимается
   через 15 с и сразу отпускает память.

   DHT и PEX нарочно оставлены включёнными: без них публичные раздачи ищут
   пиров заметно медленнее. А вот локальное обнаружение (LPD/Bonjour) выключено —
   на одной машине оно бесполезно, а в сеть болтает лишнее.

   Набор НЕ трогает список трекеров, ключи SSL и настройки TMDB: отправка
   настроек у TorrServer заменяет объект целиком, и лишний ключ в наборе
   означал бы потерю чужих значений. */
function ramOnlyPreset() {
  return {
    UseDisk: false,
    TorrentsSavePath: '',
    RemoveCacheOnDrop: true,
    DisableUpload: true,
    EnableLPD: false,
    EnableBonjour: false,
    CacheSize: 128 * 1024 * 1024,
    PreloadCache: 30,
    ConnectionsLimit: 25,
    TorrentDisconnectTimeout: 15,
  };
}

/* Полный объект настроек для отправки на сервер: прочитанное плюс правки.

   Отдельная функция не для красоты. action:set у TorrServer не сливает
   присланное с текущим — недостающие поля обнуляются. Отправишь только правки
   («так ведь короче») — и сервер потеряет список трекеров, предзагрузку и всё
   остальное, чего в правках не было. Проверено живьём: частичный набор ровно
   так и сбросил TrackersListURL. Поэтому основа — прочитанное, а правки лишь
   накладываются сверху. */
function mergeServerSets(base, edits) {
  return { ...(base || {}), ...(edits || {}) };
}

/* Поля настроек BitTorr по группам: [ключ, подпись, вид]. Вид: 'bool' —
   переключатель, 'mb' — размер в мегабайтах (сервер хранит байты), иначе число
   или строка.

   Ключи сверены с ответом сервера: прежние ReadAheadBytes и RemoteDownloads в
   нём отсутствуют, а чтение вперёд называется ReaderReadAHead. */
const serverFields = [
  ['Память и кэш', [
    ['CacheSize', 'Размер кэша', 'mb'],
    ['PreloadCache', 'Предзагрузка, %'],
    ['ReaderReadAHead', 'Чтение вперёд, %'],
    ['UseDisk', 'Кэш на диске', 'bool'],
    ['RemoveCacheOnDrop', 'Освобождать кэш при снятии раздачи', 'bool'],
    ['TorrentDisconnectTimeout', 'Снимать простаивающую раздачу, с'],
    ['TorrentsSavePath', 'Папка сохранения (пусто — не сохранять)'],
  ]],
  ['Сеть и нагрузка', [
    ['ConnectionsLimit', 'Лимит соединений'],
    ['DownloadRateLimit', 'Ограничение скачивания, байт/с (0 — без)'],
    ['UploadRateLimit', 'Ограничение отдачи, байт/с (0 — без)'],
    ['DisableUpload', 'Не отдавать (только смотреть)', 'bool'],
    ['DisableDHT', 'Отключить DHT', 'bool'],
    ['DisablePEX', 'Отключить PEX', 'bool'],
    ['EnableLPD', 'Локальное обнаружение (LPD)', 'bool'],
    ['EnableBonjour', 'Bonjour', 'bool'],
    ['EnableIPv6', 'IPv6', 'bool'],
    ['ForceEncrypt', 'Принудительное шифрование', 'bool'],
    ['PeersListenPort', 'Порт пиров (0 — случайный)'],
  ]],
  ['Прочее', [
    ['ResponsiveMode', 'Режим отзывчивости', 'bool'],
    ['EnableDLNA', 'DLNA', 'bool'],
    ['EnableRutorSearch', 'Поиск rutor на сервере', 'bool'],
    ['EnableTorznabSearch', 'Поиск Torznab', 'bool'],
    ['RetrackersMode', 'Режим трекеров'],
  ]],
];

/* Значение поля для отправки на сервер: переключатель — булево, мегабайты —
   обратно в байты, пустая строка остаётся пустой (сервер понимает её как
   «не задано»), остальное — число, если им является. */
function serverFieldValue(inp) {
  const v = inp.value;
  if (inp.dataset.kind === 'bool') return v === 'true';
  if (inp.dataset.kind === 'mb') return Math.max(0, Math.round(Number(v) || 0)) * 1048576;
  if (v === '') return '';
  return isNaN(v) ? v : Number(v);
}

async function renderServerPane(tab) {
  const pane = document.querySelector('#serverPane'); if (!pane) return;
  if (tab === 'info') {
    pane.innerHTML = html`<div class="stat-line">
      <div><b>TorrClient:</b> ${state.hello.version || ''} · ОС ${state.hello.os || ''}</div>
      <div><b>Папка программы:</b> <span class="mono">${state.hello.exe || '—'}</span></div>
      <div><b>Демон:</b> локальный компаньон на порту 8099</div>
      <div class="divider"></div>
      <div class="mono" style="white-space:pre-wrap">${JSON.stringify(state.hello, null, 2)}</div>
    </div>`;
    return;
  }
  pane.innerHTML = '<div class="empty">Загрузка настроек BitTorr...</div>';
  try { _serverSets = await tsGet('/settings?action=get').catch(async () => (await jFetch('/settings', { action: 'get' })).json()); } catch (e) { _serverSets = null; }
  if (!_serverSets || typeof _serverSets === 'string') {
    // try POST action get
    try { const r = await fetch(ts('/settings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get' }) }); _serverSets = await r.json(); } catch (e) { _serverSets = null; }
  }
  if (!_serverSets) { pane.innerHTML = '<div class="empty">Не удалось получить настройки сервера (нужен auth?)</div>'; return; }
  const s = _serverSets.BitTorr || _serverSets || {};
  const mb = n => Math.round(Number(n || 0) / 1048576);
  pane.innerHTML = html`
    <div class="row wrap" style="align-items:center;gap:10px;margin-bottom:6px">
      <button id="ssAuto" class="primary" title="Замерит скорость интернета и подберёт кэш, предзагрузку и число соединений">Автонастройка буфера</button>
      <button id="ssPreset">Только оперативная память, без следов</button>
      <span class="page-sub" style="margin:0">Кэш живёт в RAM и освобождается при снятии раздачи, на диск не пишется ничего, отдача выключена.</span>
    </div>
    ${raw(serverFields.map(([group, list]) => html`
      <div class="divider"></div>
      <h3>${group}</h3>
      <div class="stat-line" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:8px 24px">
        ${raw(list.map(([k, label, kind]) => {
          if (kind === 'bool') return html`<div><b>${label}:</b> <select data-k="${k}" data-kind="bool"><option ${s[k] ? 'selected' : ''}>true</option><option ${s[k] ? '' : 'selected'}>false</option></select></div>`;
          if (kind === 'mb') return html`<div><b>${label}:</b> <input data-k="${k}" data-kind="mb" value="${mb(s[k])}" style="width:90px"> МБ</div>`;
          return html`<div><b>${label}:</b> <input data-k="${k}" value="${s[k]}" style="width:150px"></div>`;
        }).join(''))}
      </div>`).join(''))}
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="ssSave" class="primary">Сохранить</button></div>
    <details style="margin-top:10px"><summary class="page-sub" style="cursor:pointer">Все поля, как их отдаёт сервер</summary>
      <div class="mono" style="font-size:11px;white-space:pre-wrap">${JSON.stringify(s, null, 1)}</div>
    </details>`;

  const saveServerSets = async edits => {
    const r = await jFetch('/settings', { action: 'set', sets: mergeServerSets(s, edits) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  };

  const save = $('#ssSave');
  if (save) save.addEventListener('click', async () => {
    const edits = {};
    $$('[data-k]', pane).forEach(inp => { edits[inp.dataset.k] = serverFieldValue(inp); });
    try {
      await saveServerSets(edits);
      toast('Настройки сохранены');
      await refreshLibrary();
    } catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
  });

  const auto = $('#ssAuto');
  if (auto) auto.addEventListener('click', async () => {
    auto.disabled = true; auto.textContent = 'Замеряю скорость…';
    try {
      const p = await api('/api/autobuffer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const txt = `Скорость ≈ ${Math.round(p.mbps)} Мбит/с — ${p.why}.\n\nКэш ${Math.round(p.CacheSize / 1048576)} МБ, предзагрузка ${p.PreloadCache}%, чтение вперёд ${p.ReaderReadAHead}%, соединений ${p.ConnectionsLimit}.\n\nПрименить?`;
      if (confirm(txt)) {
        await saveServerSets({ CacheSize: p.CacheSize, PreloadCache: p.PreloadCache, ReaderReadAHead: p.ReaderReadAHead, ConnectionsLimit: p.ConnectionsLimit });
        toast('Буфер настроен под ' + Math.round(p.mbps) + ' Мбит/с');
        renderServerPane(tab);
        return;
      }
    } catch (e) { toast(e.message, true); }
    auto.disabled = false; auto.textContent = 'Автонастройка буфера';
  });

  const preset = $('#ssPreset');
  if (preset) preset.addEventListener('click', async () => {
    try {
      await saveServerSets(ramOnlyPreset());
      toast('Режим «только оперативная память» включён');
      renderServerPane('settings');
    } catch (e) { toast('Не удалось применить режим: ' + e.message, true); }
  });
}

/* ---------- modal helpers ---------- */
/* Закрывается верхнее окно, а не первое найденное: окна открываются друг из
   друга (например, «Инфо о раздаче» → выбор плеера), и прежде закрывалось то,
   что лежит ниже, — верхнее оставалось висеть поверх страницы. */
function closeModal() { const all = $$('body > .overlay'); if (all.length) all[all.length - 1].remove(); }

/* ---------- отчёт о состоянии ---------- */
/* Отчёт собирают, когда что-то уже сломалось, и разбираться будут не здесь, а
   там, куда его ушлют. Поэтому он обязан быть цельным: текст, а не «посмотрите
   в консоли». Копирование в буфер — основной путь, и оно сделано вручную через
   execCommand, потому что navigator.clipboard у file:// и wails.localhost
   недоступен без разрешения, а спрашивать его посреди поломки лишне. */
function diagFallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

async function showDiagnostics(btn) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Собираю…'; }
  let text = '';
  try {
    const r = await fetch('/api/diagnostics?format=text');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = old; }
    toast('Не удалось собрать отчёт: ' + e.message, true);
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = old; }

  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal diag">
    <h2>Отчёт о состоянии</h2>
    <p class="page-sub">Скопируйте и приложите к письму. Ключ TMDB и пароли серверов в отчёт не попадают.</p>
    <div class="mono diag-text">${text}</div>
    <div class="row" style="justify-content:flex-end;gap:8px">
      <button data-d="copy" class="primary">Скопировать</button>
      <button data-d="save">Сохранить файл</button>
      <button data-d="close">Закрыть</button>
    </div>
  </div>`;
  document.body.appendChild(ov);

  ov.querySelector('[data-d="copy"]').addEventListener('click', async () => {
    // Сначала пробуем современный буфер, и только потом запасной путь: первый
    // надёжнее, второй работает везде.
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
    if (!ok) ok = diagFallbackCopy(text);
    toast(ok ? 'Отчёт скопирован' : 'Не удалось скопировать — выделите текст вручную', !ok);
  });
  ov.querySelector('[data-d="save"]').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'torrclient-diagnostic-' + stamp + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Освобождение отложено: освобождать сразу — значит отменить скачивание в
    // некоторых браузерах, файл не успевает начать качаться.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  ov.querySelector('[data-d="close"]').addEventListener('click', () => ov.remove());
}


/* ---------- auto-open added hint ---------- */
document.addEventListener('DOMContentLoaded', () => { if (localStorage.getItem('tc_first') !== '1') { localStorage.setItem('tc_first', '1'); } });