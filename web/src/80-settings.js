/* ================= SETTINGS ================= */
function renderSettings(root) {
  root.innerHTML = html`
    <div class="toolbar"><div class="grow"><h1 class="page-title">Настройки TorrClient</h1></div><input class="search-input" id="setFilter" placeholder="Найти настройку…" style="max-width:260px"></div>
    <div class="card"><h3>Серверы TorrServer <button id="setOpenTs" style="float:right">Открыть сервер в браузере</button></h3>
      <div id="profList"></div>
      <div class="divider"></div>
      <h3>Добавить сервер</h3>
      <div class="row wrap">
        <input id="npName" placeholder="Название" style="flex:1;min-width:120px">
        <input id="npUrl" placeholder="http://192.168.1.10:8090" style="flex:2;min-width:200px">
        <input id="npUser" placeholder="Логин (если включён auth)" style="flex:1">
        <input id="npPass" placeholder="Пароль" type="password" style="flex:1">
        <button id="npAdd" class="primary">Добавить</button>
      </div>
      <div class="page-sub">По умолчанию уже добавлен локальный сервер 127.0.0.1:8090. Для удалённого сервера укажите его адрес (поддержаны security-сертификаты — включите Skip SSL в полях).</div>
    </div>
    <div class="card"><h3>Постеры и рейтинги (TMDB)</h3>
      <p class="page-sub">API Key themoviedb.org — автоматически подставляем постеры в результаты поиска. Заполните на <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a>.</p>
      <div class="row wrap">
        <input id="tmdbKey" placeholder="API Key (v3) — 32 знака" style="flex:2;min-width:200px">
        <button id="tmdbSave" class="primary">Сохранить</button>
        <span id="tmdbStat" class="chip grey"></span>
      </div>
    </div>
    <div class="card"><h3>Индексаторы Torznab</h3>
      <p class="page-sub">Поиск идёт напрямую в индексатор, без TorrServer. Обычно это Jackett или Prowlarr: у него есть кнопка копирования адреса Torznab вместе с ключом — вставьте эту строку целиком, ключ выделится сам.</p>
      <div id="tzList"></div>
      <div class="row wrap" style="margin-top:8px">
        <button id="tzFind" title="Ищет Jackett и Prowlarr на этом компьютере и в вашей локальной сети (порты 9117 и 9696)">Найти Jackett / Prowlarr</button>
        <span class="page-sub" id="tzFindNote" style="margin:0"></span>
      </div>
      <div id="tzFound"></div>
      <div class="row wrap" style="margin-top:8px">
        <input id="tzName" placeholder="Название" style="flex:1;min-width:110px">
        <input id="tzUrl" placeholder="http://127.0.0.1:9117/results/torznab/api" style="flex:2;min-width:220px">
        <input id="tzKey" placeholder="API key (если есть)" style="flex:1;min-width:130px">
        <button id="tzTest">Проверить</button>
        <button id="tzAdd" class="primary">Добавить</button>
      </div>
      <div id="tzNote" class="page-sub" style="margin-top:6px"></div>
    </div>
    <div class="card"><h3>Автодобавление .torrent</h3>
      <p class="page-sub">Файлы .torrent, которые сохранены вашим браузером (Firefox/Chrome) из «Просмотровать в приложениях», автоматически добавятся через watch-папку.</p>
      <div class="row wrap">
        <input id="wfPath" value="${state.hello.watch_folder}" style="flex:2">
        <button id="wfBrowse">Обзор</button>
        <button id="wfReg" class="primary">Зарегистрировать magnet:// и .torrent</button>
        <label style="margin:0;display:inline-flex;align-items:center;gap:6px" title="Демон запускается при входе в систему, без окна и без открытия браузера"><input type="checkbox" id="autoStart" disabled> запускать при входе в систему</label>
      </div>
      ${raw(folderNoticeHTML('watch'))}
      <div class="row wrap" style="margin-top:8px">
        <label style="margin:0"><input type="checkbox" id="wfEnabled" ${state.watchOk !== false ? 'checked' : ''}> Включить автозагрузку</label>
      </div>
      <div id="wfLog" class="mono" style="margin-top:10px; max-height:160px; overflow:auto; white-space:pre-wrap"></div>
    </div>
    <div class="card"><h3>Где хранятся данные</h3>
      <p class="page-sub">Кэш — постеры, оценки и журнал работы. Потерять его не страшно: постеры и оценки соберутся заново. Поэтому папку кэша можно указать на диск, который очищается при перезагрузке.</p>
      <div class="row wrap">
        <input id="cfPath" value="${state.hello.cache_folder || ''}" style="flex:2">
        <button id="cfBrowse">Обзор</button>
      </div>
      ${raw(folderNoticeHTML('cache'))}
      ${raw(folderOverlapHTML())}
      <div class="divider"></div>
      <p class="page-sub">Постоянные данные — отметки просмотра («продолжить просмотр») и избранное с закладками. Заново их не собрать, поэтому папка должна лежать на постоянном диске. Сами настройки остаются рядом с программой: в них записаны обе эти папки.</p>
      <div class="row wrap">
        <input id="dfPath" value="${state.hello.data_folder || ''}" style="flex:2">
        <button id="dfBrowse">Обзор</button>
      </div>
      ${raw(folderNoticeHTML('data'))}
    </div>
    <div class="card"><h3>Свой список</h3>
      <p class="page-sub">Импорт/экспорт избранных магнитов (сохраняется локально в безе браузера).</p>
      <div class="row"><button id="expList">Экспорт JSON</button><button id="impList">Импорт JSON</button><input type="file" id="impInput" accept=".json,.txt" hidden></div>
    </div>
    <div class="card"><h3>Перенос состояния</h3>
      <p class="page-sub">Один архив со всем состоянием: настройки серверов и плееров, избранное, отметки просмотра. Кэш постеров и закачки в архив не входят — это не состояние, а временные данные.</p>
      <div class="row">
        <button id="backupDl">Скачать архив</button>
        <button id="restoreBtn">Восстановить из архива</button>
        <input type="file" id="restoreInput" accept=".zip" hidden>
      </div>
    </div>
    <div class="card"><h3>Кинозал: зеркала</h3>
      <p class="page-sub">Официальные: kinozal.tv, kinozal.me, kinozal.guru — они проверяются первыми. Неофициальные зеркала — запасной путь, если официальные не отдают выдачу. Программа на Кинозал не входит и пароль туда не передаёт.</p>
      <label style="margin:0"><input type="checkbox" id="kzOfficial"> Только официальные зеркала (и свои из списка ниже)</label>
      <label>Свои зеркала (через запятую или с новой строки), проверяются первыми</label>
      <textarea id="kzHosts" rows="2" placeholder="kinozal.tv"></textarea>
      <div class="row wrap" style="margin-top:8px"><button id="kzSave">Сохранить</button><button id="kzProbe" class="primary">Проверить зеркала</button><span id="kzLast" class="page-sub"></span></div>
      <div id="kzProbeOut"></div>
    </div>
    <div class="card"><h3>Оформление</h3>
      ${raw(themePickerHtml())}
      <p class="page-sub">Кнопка 🌓 в шапке и клавиша T перебирают темы по кругу.</p>
    </div>
    <div class="card"><h3>Автооткрытие и встроенные</h3>
      <label style="margin:0"><input type="checkbox" id="autoOpen" ${localStorage.getItem('tc_autoopen') !== '0' ? 'checked' : ''}> Автоматически открывать UI после добавления торрента</label>
    </div>
    <div class="card"><h3>О программе</h3>
      <div class="stat-line">
        <div><b>Версия:</b> ${state.hello.app_version || '?'} <span class="mono">${(state.hello.version || '').replace(/^TorrClient\s*/, '')}</span></div>
        <div><b>Система:</b> ${state.hello.os || ''}</div>
        <div><b>Папка программы:</b> <span class="mono">${state.hello.exe || '—'}</span></div>
      </div>
      <ul class="whatsnew">${raw(WHATSNEW.map(([v, items]) => html`<li><b>${v}</b>: ${items.join('; ')}</li>`).join(''))}</ul>
      <p class="page-sub">Версия подставляется при сборке. По ней видно, какая копия запущена, когда на диске лежит несколько сборок.</p>
      <div class="row wrap">
        <button id="diagBtn" class="primary">Собрать отчёт о состоянии</button>
        <span class="page-sub" style="margin:0">Версии, папки, серверы и файлы данных разом. Ключ TMDB и пароли в отчёт не попадают.</span>
      </div>
    </div>`;

  const pp = state.profiles.map(p => html`
    <div class="row wrap" style="margin:6px 0">
      <b style="flex:1; min-width:120px">${p.name}</b>
      <span class="mono" style="flex:2">${p.url}</span>
      ${raw(p.id === state.active ? html`<span class="chip">активный</span>` : html`<button data-act="act" data-id="${p.id}">Сделать активным</button>`)}
      <button data-act="set" data-id="${p.id}">Править</button>
      <button data-act="del" data-id="${p.id}" class="danger">Удалить</button>
    </div>`).join('');
  $('#profList').innerHTML = pp || '<div class="empty">Нет серверов</div>';
  $$('#profList [data-act]').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id; const p = state.profiles.find(x => x.id === id); if (!p) return;
      const act = b.dataset.act;
      if (act === 'act') { await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'active', id }) }); state.active = id; renderTopbar(); renderServerStatus(); route(); }
      if (act === 'set') { editProfileModal(p); }
      if (act === 'del') { if (confirm('Удалить сервер ' + p.name + '?')) { await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'del', id }) }); route(); } }
    });
  });
  $('#npAdd').addEventListener('click', addProfile);
  $('#wfReg').addEventListener('click', async () => {
    try { await api('/api/reg?action=install', { method: 'POST' }); toast('Протокол magnet:// зарегистрирован. Проверьте, что TorrClient — браузер по умолчанию для magnet.'); renderServerStatus(); } catch (e) { toast(e.message, true); }
  });
  const asBox = $('#autoStart');
  if (asBox) {
    api('/api/autostart').then(j => {
      if (!j.supported) { asBox.parentElement.title = 'На этой системе автозапуск не поддерживается'; return; }
      asBox.checked = !!j.enabled; asBox.disabled = false;
    }).catch(() => {});
    asBox.addEventListener('change', async () => {
      asBox.disabled = true;
      try {
        const j = await api('/api/autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: asBox.checked }) });
        asBox.checked = !!j.enabled;
        toast(j.enabled ? 'Автозапуск включён' : 'Автозапуск выключен');
      } catch (e) { asBox.checked = !asBox.checked; toast(e.message, true); }
      asBox.disabled = false;
    });
  }
  $('#expList').addEventListener('click', exportList);
  $('#impList').addEventListener('click', () => $('#impInput').click());
  $('#impInput').addEventListener('change', e => importList(e.target.files[0]));
  const rb = $('#restoreBtn');
  if (rb) rb.addEventListener('click', () => $('#restoreInput').click());
  const ri = $('#restoreInput');
  if (ri) ri.addEventListener('change', e => restoreBackup(e.target.files[0]));
  const bd = $('#backupDl');
  // Переход по адресу, а не fetch: ответ отдаётся вложением, и браузер сам
  // показывает сохранение файла.
  if (bd) bd.addEventListener('click', () => { window.location.href = '/api/backup'; });
  $('#autoOpen').addEventListener('change', e => localStorage.setItem('tc_autoopen', e.target.checked ? '1' : '0'));
  initKinozalMirrors();
  initSettingsFilter(root);
  const diagBtn = $('#diagBtn');
  if (diagBtn) diagBtn.addEventListener('click', () => showDiagnostics(diagBtn));
  // Папки меняются одним и тем же диалогом: различаются только подпись и поле
  // настройки, поэтому отдельная ветка на каждую папку ничего не добавляла бы,
  // кроме повода забыть про новую.
  $('#wfBrowse').addEventListener('click', () => setFolderFromPrompt('watch', 'Папка для watch (.torrent):'));
  $('#cfBrowse').addEventListener('click', () => setFolderFromPrompt('cache', 'Папка кэша (постеры, оценки, журнал):'));
  $('#dfBrowse').addEventListener('click', () => setFolderFromPrompt('data', 'Папка постоянных данных (отметки просмотра, избранное):'));
  hookFolderFix(root);
  const so = $('#setOpenTs'); if (so) so.addEventListener('click', openServerInBrowser);
  (async () => { try { const m = await api('/api/meta'); $('#tmdbStat').textContent = m.configured ? 'ключ сохранён' : 'ключ не задан'; } catch {} })();
  $('#tmdbSave').addEventListener('click', async () => {
    const k = $('#tmdbKey').value.trim(); if (!k) return toast('Введите API Key', true);
    try {
      await api('/api/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k }) });
      toast('TMDB ключ сохранён'); $('#tmdbStat').textContent = 'ключ сохранён';
      // Демон уже забыл отказы, запомненные по прежнему ключу; здесь то же
      // самое делается для отказов, запомненных интерфейсом.
      forgetMetaMisses();
      // То, что не нашлось по прежнему ключу, спрашивается заново — иначе
      // библиотека осталась бы без постеров до перезапуска окна.
      if ((state.lib || []).length) libRatings();
    }
    catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
  });

  /* ---------- индексаторы Torznab ----------
     Проверка идёт по тому, что человек ввёл в поля, а не по сохранённому:
     иначе «Проверить» перед добавлением было бы некуда нажать. И проверка
     ничего не сохраняет — иначе кнопка «проверить» была бы кнопкой
     «применить», и об этом нигде не написано. */
  let tzSources = [];
  const tzDraw = () => {
    const rows = tzSources.map(s => html`
      <div class="row wrap" style="align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line,#eee)">
        <b style="flex:1;min-width:110px">${s.name}</b>
        <span class="mono page-sub" style="flex:2;min-width:180px">${s.url}</span>
        ${raw(s.has_key ? html`<span class="chip grey" title="ключ сохранён">ключ ${s.key_hint || '••••'}</span>` : html`<span class="chip grey">без ключа</span>`)}
        <button data-tz="test" data-name="${s.name}">Проверить</button>
        <button data-tz="del" data-name="${s.name}" class="danger">Удалить</button>
      </div>`).join('');
    $('#tzList').innerHTML = rows || '<div class="empty">Индексаторы не заданы — поиск по Torznab сейчас ничего не вернёт.</div>';
    $$('#tzList [data-tz]').forEach(b => b.addEventListener('click', () => {
      const name = b.dataset.name;
      if (b.dataset.tz === 'del') {
        if (!confirm('Удалить индексатор ' + name + '?')) return;
        return tzSave(tzSources.filter(s => s.name !== name), name)
          .then(() => { toast('Индексатор удалён'); renderSettings(root); })
          .catch(e => toast('Не удалось удалить: ' + e.message, true));
      }
      const btn = b; btn.disabled = true; btn.textContent = 'Проверка...';
      tzTest({ name })
        .then(res => { tzTestShow(res); })
        .catch(e => { $('#tzNote').innerHTML = html`<span style="color:#c0392b">Проверка не удалась: ${e.message}</span>`; })
        .finally(() => { btn.disabled = false; btn.textContent = 'Проверить'; });
    }));
  };
  /* tzSave шлёт весь список: составной PUT без чтения здесь был бы источником
     тихой потери — удалил одну строку в интерфейсе, а на сервере пропала
     соседняя. */
  const tzSave = (list, remove) => api('/api/torznab/sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(remove ? { remove } : { sources: list.map(s => ({ name: s.name, url: s.url, api_key: s.api_key || '' })) }),
  }).then(j => { tzSources = j.sources || []; tzDraw(); return j; });
  const tzTest = body => api('/api/torznab/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const tzTestShow = res => {
    const caps = res.caps || {};
    const kinds = [
      caps.search && 'обычный', caps.tv_search && 'сериалы', caps.movie_search && 'фильмы',
      caps.music_search && 'музыка', caps.book_search && 'книги',
    ].filter(Boolean).join(', ');
    const bits = [`<b>${res.name || 'Индексатор'}</b> ${res.ok ? 'отвечает' : 'не отвечает'} за ${res.ms || 0} мс`];
    if (res.ok) bits.push(`раздач на пробный запрос: ${res.items}${kinds ? ' · поиск: ' + kinds : ''}`);
    if ((res.notes || []).length) bits.push('<div class="page-sub" style="margin-top:4px">' + res.notes.join('<br>') + '</div>');
    if (!res.ok && res.error) bits.push(`<div style="color:#c0392b;margin-top:4px">${res.error}</div>`);
    $('#tzNote').innerHTML = bits.join(' ');
  };
  const tzFromForm = () => ({
    name: ($('#tzName').value || '').trim(),
    url: ($('#tzUrl').value || '').trim(),
    api_key: ($('#tzKey').value || '').trim(),
  });
  $('#tzFind').addEventListener('click', async () => {
    const btn = $('#tzFind'), note = $('#tzFindNote'), box = $('#tzFound');
    btn.disabled = true; btn.textContent = 'Ищу...'; note.textContent = ''; box.innerHTML = '';
    try {
      const res = await api('/api/torznab/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const found = res.found || [];
      note.textContent = found.length ? 'Найдено: ' + found.length + ' (проверено адресов: ' + res.scanned + ')'
        : 'Ничего не найдено (проверено адресов: ' + res.scanned + '). Запущены ли Jackett или Prowlarr? Адрес можно ввести вручную ниже.';
      box.innerHTML = found.map((f, i) => html`<div class="row wrap" style="margin-top:6px" data-fi="${i}">
        <b>${f.kind === 'jackett' ? 'Jackett' : 'Prowlarr'}</b>
        <span class="page-sub" style="margin:0">${f.host}:${f.port}${f.local ? ' · этот компьютер' : ''}</span>
        ${raw(f.key_found ? '<span class="chip grey">ключ найден</span>' : html`<input class="fkey" placeholder="API key" style="flex:1;min-width:150px">`)}
        <button class="primary fadd">Добавить</button>
      </div>`).join('');
      $$('.fadd', box).forEach(b => b.addEventListener('click', async () => {
        const row = b.closest('[data-fi]'), f = found[+row.dataset.fi];
        const keyEl = $('.fkey', row);
        b.disabled = true; b.textContent = 'Добавляю...';
        try {
          const j = await api('/api/torznab/discover/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: f.kind, base: f.base, api_key: keyEl ? keyEl.value.trim() : '' }),
          });
          tzSources = j.sources || []; tzDraw();
          b.textContent = 'Добавлено: ' + j.added;
          toast('Индексаторов добавлено: ' + j.added);
        } catch (e) { b.disabled = false; b.textContent = 'Добавить'; toast(e.message, true); }
      }));
    } catch (e) { note.textContent = 'Поиск не удался: ' + e.message; }
    finally { btn.disabled = false; btn.textContent = 'Найти Jackett / Prowlarr'; }
  });
  api('/api/torznab/sources').then(j => { tzSources = j.sources || []; tzDraw(); }).catch(() => { $('#tzList').innerHTML = '<div class="empty">Не удалось прочитать список индексаторов</div>'; });
  $('#tzTest').addEventListener('click', async () => {
    const f = tzFromForm();
    if (!f.url) return toast('Укажите адрес индексатора', true);
    const btn = $('#tzTest'); btn.disabled = true; btn.textContent = 'Проверка...';
    try { tzTestShow(await tzTest(f)); } catch (e) { $('#tzNote').innerHTML = html`<span style="color:#c0392b">Проверка не удалась: ${e.message}</span>`; }
    finally { btn.disabled = false; btn.textContent = 'Проверить'; }
  });
  $('#tzAdd').addEventListener('click', async () => {
    const f = tzFromForm();
    if (!f.url) return toast('Укажите адрес индексатора', true);
    if (tzSources.some(s => s.name && s.name.toLowerCase() === f.name.toLowerCase()))
      return toast('Индексатор с таким именем уже есть', true);
    try {
      /* Ключ приходит из формы, а у уже сохранённых источников форма его не
         знает: сервер оставит прежний ключ, когда в записи ключ пуст. */
      await tzSave(tzSources.concat([{ name: f.name, url: f.url, api_key: f.api_key }]));
      toast('Индексатор добавлен');
      $('#tzName').value = ''; $('#tzUrl').value = ''; $('#tzKey').value = '';
      renderSettings(root);
    } catch (e) { toast('Не удалось добавить: ' + e.message, true); }
  });
  refreshWatchLog();
}
function editProfileModal(p) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = html`<div class="modal"><button class="modal-close" data-close>✕</button><h2>Изменить сервер</h2>
    <label>Название</label><input id="epName" value="${p.name}">
    <label>URL</label><input id="epUrl" value="${p.url}">
    <label>Логин</label><input id="epUser" value="${p.user || ''}">
    <label>Пароль</label><input id="epPass" type="password" value="${p.pass || ''}">
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button data-close>Отмена</button><button id="epGo" class="primary">Сохранить</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#epGo').addEventListener('click', async () => {
    const was = { name: p.name, url: p.url, user: p.user, pass: p.pass };
    p.name = ov.querySelector('#epName').value; p.url = ov.querySelector('#epUrl').value; p.user = ov.querySelector('#epUser').value; p.pass = ov.querySelector('#epPass').value;
    // Окно не закрывается до ответа и ошибка называется: прежде окно исчезало
    // сразу, а отказ демона терялся в консоли — правка выглядела сохранённой.
    const go = ov.querySelector('#epGo');
    go.disabled = true;
    try {
      await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', profile: p }) });
      ov.remove(); state.profiles = await (await api('/api/profiles')).profiles; renderTopbar(); route();
    } catch (e) {
      // Правка откатывается вместе с отказом: иначе в памяти остался бы сервер,
      // которого нет на диске, и следующее сохранение записало бы его молча.
      Object.assign(p, was);
      toast('Сервер не сохранён: ' + e.message, true);
      go.disabled = false;
    }
  });
}
async function addProfile() {
  const name = $('#npName').value.trim(); const url = $('#npUrl').value.trim();
  if (!name || !url) return toast('Заполните название и URL', true);
  const res = await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', profile: { name, url, user: $('#npUser').value, pass: $('#npPass').value } }) });
  state.profiles = (await api('/api/profiles')).profiles || state.profiles;
  state.active = (res && res.id) || (state.profiles.length ? state.profiles[0].id : '');
  renderTopbar(); route();
}
function exportList() {
  const ul = JSON.parse(localStorage.getItem('tc_userlist') || '[]');
  const data = JSON.stringify(ul, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'torrclient-list.json'; a.click();
}
function importList(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const arr = JSON.parse(r.result);
      if (!Array.isArray(arr)) { toast('В файле не список избранного', true); return; }
      // Через saveFavList, а не прямо в localStorage: он же отправляет список
      // демону. Прежде импорт жил только в браузере и исчезал при первом
      // обновлении склада — «Импортировано N» и пустое избранное.
      saveFavList(arr);
      toast('Импортировано ' + arr.length + ' позиций');
      if (state.view === 'favorites') route();
    } catch (e) { toast('Ошибка импорта: ' + e.message, true); }
  };
  r.onerror = () => toast('Не удалось прочитать файл', true);
  r.readAsText(file);
}
async function refreshWatchLog() {
  const el = $('#wfLog'); if (!el) return;
  try { const j = await api('/api/watch'); $('#wfLog').textContent = (j.log || []).join('\n'); } catch {}
}
/* restoreBackup возвращает состояние из архива. Подтверждение обязательно:
   возврат затирает текущие настройки, избранное и отметки, а отменить это нечем. */
async function restoreBackup(file) {
  if (!file) return;
  if (typeof confirm === 'function' && !confirm('Заменить текущие настройки, избранное и отметки содержимым архива?')) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/restore', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    toast('Состояние восстановлено: ' + (j.files || []).join(', '));
    state.hello = await api('/api/hello');
    state.profiles = state.hello.profiles || [];
  paintVersion();
    state.players = state.hello.players || [];
    state.active = state.hello.active_profile_id;
    await loadUserData();
    await loadPositions();
    renderTopbar();
    route();
  } catch (e) {
    toast('Восстановление не удалось: ' + e.message, true);
  }
}


// Поиск по настройкам: прячет карточки, в которых нет введённого текста.
function initSettingsFilter(root) {
  const inp = $('#setFilter'); if (!inp) return;
  const cards = [...root.querySelectorAll('.card')];
  let empty = null;
  inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    let shown = 0;
    for (const c of cards) {
      const hit = !q || c.textContent.toLowerCase().includes(q) || [...c.querySelectorAll('input,textarea')].some(i => (i.placeholder || '').toLowerCase().includes(q));
      c.style.display = hit ? '' : 'none'; if (hit) shown++;
    }
    if (!empty) { empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Такой настройки нет'; inp.closest('.toolbar').after(empty); }
    empty.style.display = shown ? 'none' : '';
  });
}
