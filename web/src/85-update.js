// ── Автообновление ──
// Демон спрашивает GitHub Releases; интерфейс показывает кнопку «⬆ версия»
// рядом со значком версии и окно с установкой в один клик.

let updInfo = null;

async function checkUpdate(force) {
  try { updInfo = await api('/api/update' + (force ? '?force=1' : '')); }
  catch (e) { if (force) toast(e.message, true); return null; }
  paintUpdateBadge();
  return updInfo;
}

function paintUpdateBadge() {
  const ver = document.getElementById('appVer'); if (!ver) return;
  let b = document.getElementById('updBtn');
  if (!updInfo || !updInfo.newer) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('button'); b.id = 'updBtn'; b.className = 'upd-btn';
    b.addEventListener('click', showUpdate);
    ver.after(b);
  }
  b.textContent = '⬆ ' + updInfo.latest;
  b.title = 'Доступна версия ' + updInfo.latest + ' — нажмите, чтобы обновить';
}

function showUpdate() {
  if (!updInfo) return;
  $$('body > .overlay.upd-ov').forEach(o => o.remove());
  const ov = document.createElement('div'); ov.className = 'overlay upd-ov';
  const notes = String(updInfo.notes || '').replace(/^#+\s*/gm, '').replace(/\*\*|`/g, '').trim();
  ov.innerHTML = html`<div class="modal" style="max-width:560px">
    <h3>${updInfo.newer ? 'Доступна версия ' + updInfo.latest : 'Установлена последняя версия'}</h3>
    <div class="page-sub">Сейчас: ${updInfo.current}${updInfo.latest ? ' · последняя: ' + updInfo.latest : ''}</div>
    ${raw(notes ? html`<div class="upd-notes">${notes}</div>` : '')}
    <div id="updState" class="page-sub"></div>
    <div class="row wrap">
      ${raw(updInfo.newer && updInfo.installable ? '<button class="primary" id="updGo">Обновить сейчас</button>' : '')}
      ${raw(updInfo.page ? '<button id="updPage">Страница релиза</button>' : '')}
      <button id="updClose">${updInfo.newer ? 'Не сейчас' : 'Закрыть'}</button>
    </div>
    <p class="page-sub" style="margin:8px 0 0">Архив скачивается с GitHub и сверяется с контрольной суммой. Настройки, избранное и отметки просмотра не затрагиваются. Окно программы обновится при следующем запуске.</p></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#updClose').addEventListener('click', close);
  const pg = ov.querySelector('#updPage'); if (pg) pg.addEventListener('click', () => openExternal(updInfo.page));
  const go = ov.querySelector('#updGo');
  if (go) go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Обновляю…';
    const st = ov.querySelector('#updState');
    try { await api('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install' }) }); }
    catch (e) { st.textContent = e.message; go.disabled = false; go.textContent = 'Повторить'; return; }
    const target = updInfo.latest;
    const poll = async () => {
      let s = null;
      try { s = await api('/api/update'); } catch {}
      if (s && s.state === 'failed') { st.textContent = 'Не удалось: ' + s.note; go.disabled = false; go.textContent = 'Повторить'; return; }
      if (s && s.state === 'installing') { st.textContent = s.note || 'Скачиваю…'; setTimeout(poll, 1500); return; }
      // Установлено или демон уже перезапускается: ждём ответа новой версии.
      st.textContent = 'Установлено, перезапуск…';
      try { const h = await api('/api/hello'); if (h.app_version === target) { location.reload(); return; } } catch {}
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 800);
  });
}

// Автопроверка — один раз за сеанс интерфейса (демон и сам не спрашивает
// GitHub чаще раза в 6 часов). Отключается в Настройках → «О программе».
function autoCheckUpdate() {
  if (localStorage.getItem('tc_autoupd') === '0' || autoCheckUpdate.done) return;
  autoCheckUpdate.done = true;
  setTimeout(() => checkUpdate(false), 3000);
}
