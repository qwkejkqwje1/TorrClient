/* Страница «смотреть без TorrClient»: гость комнаты TorrClient прямо в браузере.
   Протокол (MQTT-брокеры + шифрование + WebRTC) — общий, из tg-core.js.
   Гость видит экран ведущего, слышит звук фильма и голоса, говорит в микрофон
   и пишет в чат. Код комнаты — после # в адресе: на сервер он не уходит. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const W = { code: '', vol: +(localStorage.getItem('tc_w_vol') || 90), blocked: false, screenOf: '' };
tg.web = true;

function toast(text, err) {
  const box = $('#wToasts'), t = document.createElement('div');
  t.className = 'w-toast' + (err ? ' err' : ''); t.textContent = text; box.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3500);
}
function wCode() { return decodeURIComponent((location.hash || '').replace(/^#(join=)?/, '')).trim(); }

/* ── вход ── */
function wJoinView(err) {
  const code = wCode(), o = tgParse(code), can = tgCanRun();
  $('#wTitle').textContent = '';
  $('#wRoot').innerHTML = `<div class="w-join">
    <h1>Смотрим вместе</h1>
    <p>Друг приглашает посмотреть фильм вместе. Вы увидите его экран, услышите звук и голос, сможете говорить и писать в чат. Ничего устанавливать не нужно.</p>
    ${can ? '' : '<div class="w-err">Этот браузер не умеет звонки (WebRTC) или шифрование. Откройте ссылку в свежем Chrome, Edge, Firefox или Safari.</div>'}
    <label>Ваше имя<input id="wName" maxlength="40" value="${esc(localStorage.getItem('tc_tg_name') || '')}" placeholder="Как вас называть" autocomplete="nickname"></label>
    ${o ? '' : `<label>Код приглашения<input id="wCodeIn" placeholder="TC1.…" autocomplete="off" value="${esc(code)}"></label>`}
    ${err ? `<div class="w-err">${esc(err)}</div>` : ''}
    <button class="primary" id="wGo" ${can ? '' : 'disabled'}>Подключиться</button>
    ${o ? `<div class="alt">Есть TorrClient? <a href="http://localhost:8099/#join=${esc(code)}">Открыть в нём</a> — фильм пойдёт с вашей раздачи в хорошем качестве.</div>` : ''}
  </div>`;
  $('#wGo').onclick = wJoin;
  $('#wRoot').onkeydown = e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') wJoin(); };
  const n = $('#wName'); if (n && !n.value) n.focus();
}
async function wJoin() {
  const name = ($('#wName').value || '').trim().slice(0, 40);
  if (!name) { $('#wName').focus(); toast('Напишите, как вас называть'); return; }
  localStorage.setItem('tc_tg_name', name);
  const code = $('#wCodeIn') ? $('#wCodeIn').value.trim() : wCode(), o = tgParse(code);
  if (!o) { wJoinView('Это не код приглашения — он начинается с TC1.'); return; }
  if ($('#wCodeIn')) { try { history.replaceState(null, '', '#' + code); } catch {} }
  // Нажатие — это «жест»: после него браузер разрешит играть звук.
  try { const ac = new (window.AudioContext || window.webkitAudioContext)(); ac.resume().then(() => ac.close()); } catch {}
  wRoomView();
  if (!(await tgStart(o, false))) { wJoinView('Не удалось войти в комнату'); }
}

/* ── комната ── */
function wRoomView() {
  $('#wRoot').onkeydown = null;
  $('#wRoot').innerHTML = `<div class="w-room">
    <section class="w-main">
      <div class="w-stage" id="wStage">
        <video id="wVideo" autoplay playsinline muted></video>
        <div class="w-wait" id="wWait"></div>
        <button class="primary w-unmute" id="wUnmute" hidden>🔊 Включить звук</button>
      </div>
      <div class="w-ctl">
        <button id="wMic">🎤 Микрофон</button>
        <label class="w-vol" title="Громкость фильма и голосов">🔊<input type="range" id="wVol" min="0" max="100" value="${W.vol}"></label>
        <span class="grow"></span>
        <button id="wFull" title="Во весь экран">⛶ Во весь экран</button>
        <button class="danger" id="wLeave">Выйти</button>
      </div>
    </section>
    <aside class="w-side">
      <div class="w-people" id="wPeople"></div>
      <div class="w-chat" id="wChat"></div>
      <div class="w-reacts">${TG_REACT.map(e => `<button data-r="${e}">${e}</button>`).join('')}</div>
      <div class="w-in"><input id="wIn" maxlength="500" placeholder="Сообщение" autocomplete="off"><button class="primary" id="wSend">Отправить</button></div>
    </aside>
  </div>`;
  $('#wMic').onclick = () => tgMic();
  $('#wVol').oninput = e => { W.vol = +e.target.value; localStorage.setItem('tc_w_vol', W.vol); wApplyVol(); };
  $('#wFull').onclick = () => { const s = $('#wStage'); if (document.fullscreenElement) document.exitFullscreen(); else if (s.requestFullscreen) s.requestFullscreen().catch(() => {}); else { const v = $('#wVideo'); if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); } };
  $('#wLeave').onclick = () => { tgLeave(true); wJoinView(); };
  $('#wUnmute').onclick = () => { W.blocked = false; wAllAudio().forEach(a => a.play().catch(() => { W.blocked = true; })); wPaintUnmute(); };
  $('#wSend').onclick = () => { wSay($('#wIn').value); $('#wIn').value = ''; $('#wIn').focus(); };
  $('#wIn').onkeydown = e => { if (e.key === 'Enter') { wSay(e.target.value); e.target.value = ''; } };
  document.querySelector('.w-reacts').onclick = e => { const b = e.target.closest('[data-r]'); if (b) { tgSend({ k: 'react', e: b.dataset.r }); tgChatPush({ name: tg.name, text: b.dataset.r, mine: true, react: true }); tgBurst(b.dataset.r); } };
  tg.chat.forEach(wMsgAppend);
  tgPaint();
}
function wSay(text) {
  text = String(text || '').trim().slice(0, 500); if (!text || !tg.on) return;
  tgSend({ k: 'chat', text }); tgChatPush({ name: tg.name, text, mine: true });
}
function wAllAudio() { const o = []; for (const p of tg.peers.values()) o.push(...Object.values(p.auds)); return o; }
function wApplyVol() { for (const a of wAllAudio()) a.volume = W.vol / 100; }
function wPaintUnmute() { const b = $('#wUnmute'); if (b) b.hidden = !W.blocked; }

/* ── то, что ядро протокола вызывает у интерфейса ── */
function tgPaint() {
  const ppl = $('#wPeople'); if (!ppl) return;
  const peers = [...tg.peers.values()], host = peers.find(p => p.host);
  const brokers = tg.mq.filter(c => c.ok).length;
  const row = (n, s) => `<div class="p"><i>${esc(n.slice(0, 1).toUpperCase())}</i><span>${esc(n)}</span><small>${esc(s)}</small></div>`;
  ppl.innerHTML = row(tg.name, 'вы' + (tg.mic ? ' · 🎤' : '')) + peers.map(p => row(p.name, (p.host ? 'ведущий · ' : '') + (p.web ? '🌐 · ' : '') + tgLink(p))).join('')
    + (peers.length ? '' : `<div class="w-msg sys">${brokers ? 'Ждём остальных…' : 'Подключаюсь…'}</div>`);
  const mic = $('#wMic'); if (mic) { mic.classList.toggle('on', !!tg.mic); mic.textContent = tg.mic ? '🎤 Выключить микрофон' : '🎤 Микрофон'; }
  const m = tg.media; $('#wTitle').textContent = m && m.t ? '🎬 ' + m.t : '';
  const wait = $('#wWait');
  if (wait) {
    const on = !!W.screenOf && tg.peers.has(W.screenOf);
    wait.hidden = on; wait.style.display = on ? 'none' : '';
    if (!on) wait.innerHTML = !brokers && !peers.length ? '<b>Подключаюсь…</b><span>Ищем комнату через защищённые серверы-посредники</span>'
      : !peers.length ? '<b>В комнате пока никого</b><span>Как только друг появится, вы его увидите</span>'
      : `<b>Ждём экран от ${esc((host || peers[0]).name)}</b><span>Попросите в чате нажать «Показать экран» в TorrClient и выбрать окно плеера со звуком</span>`;
  }
  wApplyVol();
}
function tgNote(text) { tgChatPush({ sys: true, text }); }
function tgChatPush(m) { m.at = Date.now(); tg.chat.push(m); if (tg.chat.length > 200) tg.chat.shift(); wMsgAppend(m); }
function wMsgAppend(m) {
  const box = $('#wChat'); if (!box) return;
  const tm = new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  box.insertAdjacentHTML('beforeend', m.sys ? `<div class="w-msg sys">${esc(m.text)}</div>`
    : `<div class="w-msg${m.mine ? ' me' : ''}${m.react ? ' react' : ''}"><b>${esc(m.name)}</b><span>${esc(m.text)}</span><time>${tm}</time></div>`);
  box.scrollTop = box.scrollHeight;
}
function tgChatIn(p, text) { if (text) tgChatPush({ name: p.name, text }); }
function tgReactIn(p, e) { tgChatPush({ name: p.name, text: e, react: true }); tgBurst(e); }
function tgBurst(e) {
  const st = $('#wStage'); if (!st) return;
  const b = document.createElement('div'); b.className = 'w-burst'; b.textContent = e; b.style.left = (15 + Math.random() * 70) + '%';
  st.appendChild(b); setTimeout(() => b.remove(), 2300);
}
function tgShowScreen(p, s) {
  const v = $('#wVideo'); if (!v) return;
  W.screenOf = p.id; v.srcObject = s; v.play().catch(() => {});
  tgPaint();
}
function tgHideScreen(peer) {
  if (peer && W.screenOf !== peer) return;
  const v = $('#wVideo'); if (v) v.srcObject = null;
  W.screenOf = ''; tgPaint();
}
// Звук: новые дорожки играют через Audio из ядра — следим, не заблокировал ли их браузер.
function tgTick() {
  if (!tg.on) return;
  const now = Date.now();
  for (const p of [...tg.peers.values()]) if (now - p.last > 45000) { tgNote(`${p.name} пропал(а) из сети`); tgDropPeer(p); }
  const auds = wAllAudio();
  auds.forEach(a => { if (a.srcObject && a.paused) a.play().then(() => { W.blocked = false; wPaintUnmute(); }).catch(() => { W.blocked = true; wPaintUnmute(); }); });
  const v = $('#wVideo'); if (v && v.srcObject && v.srcObject.getVideoTracks().every(t => t.readyState === 'ended')) tgHideScreen();
  tgPaint();
}
// Синхронизация плееров гостю-браузеру не нужна: он смотрит экран ведущего.
function tgFollow() {} function tgPong() {} function tgHostReq() {} function tgHostWait() {} function tgCountdown() {} function tgRunCountdown() {}
function tgCmd() { return Promise.resolve(null); }

window.addEventListener('beforeunload', () => { if (tg.on) try { tgSend({ k: 'bye' }); } catch {} });
window.addEventListener('hashchange', () => { if (!tg.on) wJoinView(); });
wJoinView();
