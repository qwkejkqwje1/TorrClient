/* ───────────── смотрим вместе ─────────────
   Комната на двоих (и больше): у каждого свой TorrClient и своя раздача,
   а по сети ходят только команды, чат, голос и показ экрана.
   • Связь: WebRTC напрямую (STUN Google и Cloudflare, свой TURN — по
     желанию). Найти друг друга и передать предложения WebRTC помогает
     публичный MQTT-брокер по WebSocket; он же — запасной путь, если
     напрямую не вышло. Всё, что идёт через брокер, зашифровано AES-GCM
     ключом из приглашения: брокер видит только шум.
   • Синхронизация: ведущий (создатель) — источник правды. Его плеер
     (mpv или VLC, через /api/together/player) раз в 2 с рассылает позицию;
     у гостя небольшое расхождение выбирается скоростью ±5 %, большое —
     перемоткой. Пауза или перемотка у гостя уходит ведущему и дальше всем.
     Если у кого-то не грузится — пауза у всех и отсчёт 3-2-1. */
const TG_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const TG_REACT = ['😂', '😱', '❤️', '👍', '🔥', '🍿'];
const tg = { on: false, room: '', key: null, keyB64: '', host: false, me: '', name: '', peers: new Map(), mq: [], seen: new Map(),
  media: null, chat: [], mic: null, screen: null, hostId: '', off: [], st: null, stAt: 0, mine: null, prev: null, adj: false,
  cmdAt: 0, hold: 0, web: false, stall: 0, waitAt: 0, waitFor: '', timers: [], unread: 0, sync: '', lastSt: '', pingN: 0 };
const tgRid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const tgB64e = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const tgB64d = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

/* ── MQTT 3.1.1 поверх WebSocket: CONNECT, SUBSCRIBE, PUBLISH (QoS 0), PING ── */
function mqStr(s) { const b = new TextEncoder().encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function mqLen(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return o; }
function mqPkt(h, body) { const head = [h, ...mqLen(body.length)], out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out; }
class TgMqtt {
  constructor(url, topic, onMsg, onState) { Object.assign(this, { url, topic, onMsg, onState, ok: false, fail: 0, closed: false }); this.connect(); }
  connect() {
    if (this.closed) return;
    let ws; try { ws = new WebSocket(this.url, 'mqtt'); } catch { this.retry(); return; }
    ws.binaryType = 'arraybuffer'; this.ws = ws; this.buf = new Uint8Array(0); this.ok = false;
    ws.onopen = () => ws.send(mqPkt(0x10, [...mqStr('MQTT'), 4, 2, 0, 60, ...mqStr('tc' + tgRid(6))]));
    ws.onmessage = e => this.feed(new Uint8Array(e.data));
    ws.onclose = () => { const was = this.ok; this.ok = false; clearInterval(this.ping); if (was) this.onState(); this.retry(); };
    ws.onerror = () => {};
  }
  retry() { if (this.closed) return; this.fail++; clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), Math.min(30000, 1500 * this.fail)); }
  feed(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
    for (;;) {
      const B = this.buf; if (B.length < 2) return;
      let len = 0, mul = 1, i = 1;
      for (;; i++) { if (i >= B.length) return; len += (B[i] & 127) * mul; mul *= 128; if (!(B[i] & 128)) break; if (i > 4) { this.ws.close(); return; } }
      const start = i + 1; if (B.length < start + len) return;
      this.handle(B[0] >> 4, B[0] & 15, B.subarray(start, start + len));
      this.buf = B.slice(start + len);
    }
  }
  handle(type, flags, body) {
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws.close(); return; }
      this.ok = true; this.fail = 0;
      this.ws.send(mqPkt(0x82, [0, 1, ...mqStr(this.topic), 0]));
      clearInterval(this.ping); this.ping = setInterval(() => { try { this.ws.send(new Uint8Array([0xC0, 0])); } catch {} }, 30000);
      this.onState();
    } else if (type === 3) { // PUBLISH
      const tl = (body[0] << 8) | body[1]; let i = 2 + tl; if ((flags >> 1) & 3) i += 2;
      this.onMsg(body.slice(i));
    }
  }
  pub(payload) {
    if (!this.ok) return false;
    const t = mqStr(this.topic), p = new Uint8Array(t.length + payload.length); p.set(t); p.set(payload, t.length);
    try { this.ws.send(mqPkt(0x30, p)); return true; } catch { return false; }
  }
  close() { this.closed = true; clearInterval(this.ping); clearTimeout(this.rt); try { this.ws && this.ws.close(); } catch {} }
}

/* ── шифрование ── */
async function tgSeal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tg.key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
async function tgUnseal(bytes) {
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, tg.key, bytes.slice(12)))); } catch { return null; }
}

/* ── приглашение ── */
function tgCode() {
  const m = tg.media || {};
  const o = { r: tg.room, k: tg.keyB64, h: m.h || '', f: m.f, t: m.t || '', b: localStorage.getItem('tc_tg_broker') || '' };
  return 'TC1.' + tgB64e(new TextEncoder().encode(JSON.stringify(o)));
}
function tgParse(code) {
  const s = String(code || '').trim().replace(/\s+/g, ''), m = s.match(/TC1\.([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try { const o = JSON.parse(new TextDecoder().decode(tgB64d(m[1]))); return o && /^[0-9a-f]{16,64}$/.test(o.r) && o.k ? o : null; } catch { return null; }
}

/* ── вход и выход ── */
function tgIce() {
  const s = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const t = (localStorage.getItem('tc_tg_turn') || '').trim();
  if (t) s.push({ urls: t, username: localStorage.getItem('tc_tg_turnu') || '', credential: localStorage.getItem('tc_tg_turnp') || '' });
  return s;
}
function tgCanRun() { return !!(window.crypto && crypto.subtle && window.RTCPeerConnection && window.isSecureContext); }
function tgMyName() { return (localStorage.getItem('tc_tg_name') || '').trim() || (typeof devName === 'function' ? devName() : 'Гость'); }
async function tgStart(o, host) {
  if (!tgCanRun()) { toast('Браузер разрешает шифрование и звонки только на защищённом адресе — откройте TorrClient на этом компьютере (localhost)', true); return false; }
  if (tg.on) tgLeave(true);
  tg.room = o.r; tg.keyB64 = o.k; tg.host = host; tg.me = tgRid(6); tg.name = tgMyName();
  try { tg.key = await crypto.subtle.importKey('raw', tgB64d(o.k), 'AES-GCM', false, ['encrypt', 'decrypt']); } catch { toast('Код приглашения повреждён', true); return false; }
  tg.on = true; tg.chat = []; tg.unread = 0; tg.off = []; tg.st = null; tg.mine = null; tg.prev = null; tg.sync = ''; tg.lastSt = '';
  tg.media = o.h ? { h: o.h, f: o.f, t: o.t } : null;
  const own = (localStorage.getItem('tc_tg_broker') || o.b || '').trim();
  const list = own ? [own] : TG_BROKERS;
  tg.mq = list.map(u => new TgMqtt(u, 'torrclient/v1/' + tg.room, b => tgUnseal(b).then(m => tgRecv(m, 'mqtt')), () => { if (tg.mq.some(c => c.ok)) tgHello(); tgPaint(); }));
  tg.timers = [setInterval(tgTick, 1000), setInterval(tgHello, 15000)];
  try { sessionStorage.setItem('tc_tg', JSON.stringify({ o, host })); } catch {}
  tgNote(host ? 'Комната создана — отправьте другу код приглашения' : 'Подключаюсь к комнате…');
  tgPaint();
  return true;
}
function tgCreate() { return tgStart({ r: tgRid(12), k: tgB64e(crypto.getRandomValues(new Uint8Array(16))), h: '' }, true).then(ok => { if (ok) tgTick(); }); }
function tgLeave(quiet) {
  if (!tg.on) return;
  try { tgSend({ k: 'bye' }); } catch {}
  for (const p of [...tg.peers.values()]) tgDropPeer(p, true);
  tg.peers.clear();
  const mq = tg.mq; setTimeout(() => mq.forEach(c => c.close()), 300);
  tg.timers.forEach(clearInterval); tg.timers = [];
  for (const s of [tg.mic, tg.screen]) if (s) s.getTracks().forEach(t => t.stop());
  tg.mic = tg.screen = null; tg.on = false; tg.st = null;
  if (tg.adj && tg.mine && tg.mine.active) tgCmd('rate', 1);
  tg.adj = false;
  try { sessionStorage.removeItem('tc_tg'); } catch {}
  tgHideScreen();
  if (!quiet) toast('Вы вышли из комнаты');
  tgPaint();
}

/* ── отправка и приём ── */
function tgSeen(id) {
  if (tg.seen.has(id)) return true;
  tg.seen.set(id, 1);
  if (tg.seen.size > 600) [...tg.seen.keys()].slice(0, 200).forEach(k => tg.seen.delete(k));
  return false;
}
async function tgSend(m, viaMqtt) {
  if (!tg.on) return;
  m.id = m.id || tgRid(6); m.from = tg.me; m.name = tg.name; if (tg.host) m.host = 1;
  tgSeen(m.id);
  const targets = m.to ? [tg.peers.get(m.to)].filter(Boolean) : [...tg.peers.values()];
  let mq = !!viaMqtt || !targets.length;
  if (!viaMqtt) for (const p of targets) {
    if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(JSON.stringify(m)); continue; } catch {} }
    mq = true;
  }
  if (mq) { const b = await tgSeal(m); tg.mq.forEach(c => c.pub(b)); }
}
function tgHello() { if (tg.on) tgSend({ k: 'hello', media: tg.host ? tg.media : undefined, web: tg.web ? 1 : undefined }, true); }
function tgRecv(m, via) {
  if (!tg.on || !m || !m.id || !m.from || m.from === tg.me || tgSeen(m.id)) return;
  if (m.to && m.to !== tg.me) return;
  if (m.k === 'bye') { const p = tg.peers.get(m.from); if (p) { tgNote(`${p.name} вышел(а)`); tgDropPeer(p); } return; }
  const known = tg.peers.has(m.from);
  const p = tgPeer(m.from, m.name, m.host);
  if (m.web) p.web = true;
  if (!known) {
    tgNote(`${p.name} в комнате${p.web ? ' (из браузера, без TorrClient)' : ''}`);
    if (p.web && !tg.web && !tg.screen) { tgNote(`🌐 ${p.name} смотрит из браузера — нажмите «Показать экран» и выберите окно плеера (со звуком), чтобы он видел фильм`); if (typeof toast === 'function') toast(`${p.name} зашёл из браузера — покажите ему экран`); }
    tgPaint();
    if (m.k === 'hello') tgSend({ k: 'hello', to: m.from, media: tg.host ? tg.media : undefined, web: tg.web ? 1 : undefined }, true);
  }
  if (m.host && m.media && !tg.host) tg.media = m.media;
  switch (m.k) {
    case 'sig': p.q = p.q.then(() => tgSig(p, m)); break;
    case 'chat': tgChatIn(p, String(m.text || '').slice(0, 500)); break;
    case 'react': if (TG_REACT.includes(m.e)) tgReactIn(p, m.e); break;
    case 'st': if (m.host) tgFollow(m); break;
    case 'ping': tgSend({ k: 'pong', to: m.from, t0: m.t0, t1: Date.now() }); break;
    case 'pong': tgPong(m); break;
    case 'req': if (tg.host) tgHostReq(p, m); break;
    case 'wait': if (tg.host) tgHostWait(p); break;
    case 'ready': if (tg.host && tg.waitFor === p.id) { tg.waitFor = ''; tgCountdown(); } break;
    case 'cd': if (m.host) tgRunCountdown(m.pos, m.at - tgOffset()); break;
    case 'screen': if (!m.on) tgHideScreen(p.id); break;
  }
}

/* ── WebRTC: «вежливые переговоры», канал данных согласован заранее ── */
function tgPeer(id, name, isHost) {
  let p = tg.peers.get(id);
  if (!p) {
    p = { id, name: 'Гость', last: Date.now(), polite: tg.me > id, making: false, ignore: false, q: Promise.resolve(), cands: [], auds: {} };
    tg.peers.set(id, p); tgPc(p);
  }
  p.last = Date.now(); if (name) p.name = String(name).slice(0, 40);
  if (isHost) { p.host = true; tg.hostId = id; }
  return p;
}
function tgPc(p) {
  const pc = new RTCPeerConnection({ iceServers: tgIce() });
  p.pc = pc;
  p.dc = pc.createDataChannel('tc', { negotiated: true, id: 0 });
  p.dc.onopen = () => { tgNote(`С ${p.name} — напрямую (P2P)`); tgPaint(); };
  p.dc.onclose = () => tgPaint();
  p.dc.onmessage = e => { try { tgRecv(JSON.parse(e.data), 'p2p'); } catch {} };
  pc.onnegotiationneeded = async () => {
    try { p.making = true; await pc.setLocalDescription(); tgSend({ k: 'sig', to: p.id, desc: pc.localDescription.toJSON() }); } catch {} finally { p.making = false; }
  };
  pc.onicecandidate = e => { if (e.candidate) tgSend({ k: 'sig', to: p.id, cand: e.candidate.toJSON() }); };
  pc.ontrack = e => tgTrack(p, e);
  pc.onconnectionstatechange = () => { tgPaint(); if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch {} } };
  for (const s of [tg.mic, tg.screen]) if (s) s.getTracks().forEach(t => { try { pc.addTrack(t, s); } catch {} });
}
async function tgSig(p, m) {
  const pc = p.pc;
  try {
    if (m.desc) {
      const collision = m.desc.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision; if (p.ignore) return;
      await pc.setRemoteDescription(m.desc);
      for (const c of p.cands.splice(0)) { try { await pc.addIceCandidate(c); } catch {} }
      if (m.desc.type === 'offer') { await pc.setLocalDescription(); tgSend({ k: 'sig', to: p.id, desc: pc.localDescription.toJSON() }); }
    } else if (m.cand) {
      // кандидат мог обогнать предложение (разные брокеры) — подождёт
      if (!pc.remoteDescription) { p.cands.push(m.cand); return; }
      try { await pc.addIceCandidate(m.cand); } catch {}
    }
  } catch {}
}
function tgDropPeer(p, quiet) {
  try { p.pc.close(); } catch {}
  Object.values(p.auds).forEach(a => { try { a.srcObject = null; } catch {} });
  tg.peers.delete(p.id); if (tg.hostId === p.id) tg.hostId = '';
  tgHideScreen(p.id);
  if (!quiet) tgPaint();
}
function tgLink(p) {
  if (p.dc && p.dc.readyState === 'open') return 'P2P';
  return tg.mq.some(c => c.ok) ? 'через MQTT' : 'нет связи';
}

/* ── голос и экран ── */
function tgTrack(p, e) {
  const s = e.streams[0] || new MediaStream([e.track]);
  if (e.track.kind === 'video') { tgShowScreen(p, s); return; }
  let a = p.auds[s.id]; if (!a) { a = p.auds[s.id] = new Audio(); a.autoplay = true; }
  a.srcObject = s; a.play().catch(() => {});
}
function tgAddTracks(s) { for (const p of tg.peers.values()) s.getTracks().forEach(t => { try { p.pc.addTrack(t, s); } catch {} }); }
function tgDropTracks(s) {
  const ids = new Set(s.getTracks().map(t => t.id));
  for (const p of tg.peers.values()) p.pc.getSenders().forEach(x => { if (x.track && ids.has(x.track.id)) { try { p.pc.removeTrack(x); } catch {} } });
}
async function tgMic() {
  if (tg.mic) { tgDropTracks(tg.mic); tg.mic.getTracks().forEach(t => t.stop()); tg.mic = null; tgPaint(); return; }
  try { tg.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { toast('Микрофон недоступен: ' + (e.message || e.name), true); return; }
  tgAddTracks(tg.mic); tgPaint();
}
async function tgScreenToggle() {
  if (tg.screen) { tgStopScreen(); return; }
  try { tg.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }); }
  catch (e) { if (e.name !== 'NotAllowedError') toast('Показ экрана недоступен: ' + (e.message || e.name), true); return; }
  tg.screen.getVideoTracks().forEach(t => { t.onended = tgStopScreen; try { t.contentHint = 'motion'; } catch {} });
  tgAddTracks(tg.screen); tgSend({ k: 'screen', on: true }); tgPaint();
}
function tgStopScreen() {
  if (!tg.screen) return;
  tgDropTracks(tg.screen); tg.screen.getTracks().forEach(t => t.stop()); tg.screen = null;
  tgSend({ k: 'screen', on: false }); tgPaint();
}
function tgShowScreen(p, s) {
  let w = $('#tgScreen');
  if (!w) {
    w = document.createElement('div'); w.id = 'tgScreen'; w.className = 'tg-screen';
    w.innerHTML = '<div class="tg-screen-h"><span></span><button class="iconbtn" data-big title="Во весь экран">⛶</button><button class="iconbtn" data-x title="Скрыть">×</button></div><video autoplay playsinline muted></video>';
    document.body.appendChild(w);
    w.querySelector('[data-x]').onclick = () => tgHideScreen();
    w.querySelector('[data-big]').onclick = () => { const v = w.querySelector('video'); if (v.requestFullscreen) v.requestFullscreen().catch(() => {}); };
  }
  w.dataset.peer = p.id; w.querySelector('span').textContent = 'Экран: ' + p.name;
  const v = w.querySelector('video'); v.srcObject = s; v.play().catch(() => {});
}
function tgHideScreen(peer) { const w = $('#tgScreen'); if (w && (!peer || w.dataset.peer === peer)) { const v = w.querySelector('video'); if (v) v.srcObject = null; w.remove(); } }

/* ── плеер ── */
async function tgCmd(action, val, text) {
  if (action !== 'osd') tg.cmdAt = Date.now();
  try { return await api('/api/together/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, val: val || 0, text: text || '', ms: 4000 }) }); } catch { return null; }
}
function tgOsd(text) { if (tg.mine && tg.mine.active && tg.mine.osd) tgCmd('osd', 0, text); }
async function tgReadPlayer() {
  const t0 = Date.now();
  let st; try { st = await api('/api/together/player'); } catch { st = { active: false }; }
  st.local = (t0 + Date.now()) / 2;
  tg.prev = tg.mine; tg.mine = st; return st;
}
function tgOffset() { return tg.off.length ? tg.off.slice().sort((a, b) => a.rtt - b.rtt)[0].o : 0; }
function tgPong(m) {
  const t3 = Date.now(), rtt = t3 - m.t0; if (!(rtt >= 0 && rtt < 10000)) return;
  tg.off.push({ o: m.t1 - (m.t0 + t3) / 2, rtt }); if (tg.off.length > 6) tg.off.shift();
}
async function tgTick() {
  if (!tg.on || tg.busy) return;
  tg.busy = true;
  try {
    const now = Date.now();
    for (const p of [...tg.peers.values()]) if (now - p.last > 45000) { tgNote(`${p.name} пропал(а) из сети`); tgDropPeer(p); }
    const st = await tgReadPlayer();
    if (!tg.on) return;
    if (tg.host) tgHostTick(st); else tgGuestTick(st);
    tgPaintSync();
  } finally { tg.busy = false; }
}
/* ведущий: рассылает своё состояние раз в 2 с и сразу при изменении */
function tgHostTick(st) {
  if (st.active && !st.error) {
    const t = (state.lib || []).find(x => x.hash === st.hash);
    const media = { h: st.hash, f: st.file, t: t ? (t.title || t.name) : (tg.media && tg.media.h === st.hash ? tg.media.t : '') };
    if (!tg.media || tg.media.h !== media.h || tg.media.f !== media.f) { tg.media = media; tgPaint(); }
  }
  const sig = st.active ? `${st.hash}|${st.file}|${st.paused}|${Math.round((st.rate || 1) * 100)}` : 'off';
  const jumped = tg.prev && tg.prev.active && st.active && !st.paused && Math.abs(st.pos - tg.prev.pos - (st.local - tg.prev.local) / 1000 * (st.rate || 1)) > 2.5;
  tg.pingN = (tg.pingN + 1) % 2;
  if (sig !== tg.lastSt || jumped || tg.pingN === 0) {
    tg.lastSt = sig;
    tgSend({ k: 'st', a: !!st.active, h: st.hash, f: st.file, pos: st.pos || 0, paused: !!st.paused, rate: st.rate || 1, at: st.local, media: tg.media });
  }
  tg.sync = !st.active ? 'Включите фильм в mpv или VLC — гости пойдут следом' : st.error ? 'Плеер не отвечает' : st.paused ? 'Пауза у всех' : 'Вы ведёте показ';
}
function tgHostReq(p, m) {
  const act = m.action;
  if (act === 'pause' || act === 'play') { tgCmd(act); tgOsd(`${p.name}: ${act === 'pause' ? 'пауза' : 'продолжаем'}`); }
  else if (act === 'seek' && m.val >= 0) { tgCmd('seek', m.val); tgOsd(`${p.name}: перемотка`); }
  else return;
  tg.lastSt = ''; setTimeout(tgTick, 400);
}
function tgHostWait(p) {
  if (!tg.mine || !tg.mine.active || tg.mine.paused) return;
  tg.waitFor = p.id; tgCmd('pause'); tgOsd(`Ждём ${p.name} — подгружается…`); tgNote(`Ждём ${p.name} — подгружается`);
  tg.lastSt = ''; setTimeout(tgTick, 300);
  setTimeout(() => { if (tg.waitFor === p.id) { tg.waitFor = ''; tgCountdown(); } }, 15000);
}
function tgCountdown() {
  if (!tg.host || !tg.mine || !tg.mine.active) { toast('Сначала включите фильм в mpv или VLC', true); return; }
  const at = Date.now() + 3600, pos = Math.max(0, (tg.mine.pos || 0) - 1);
  tgSend({ k: 'cd', pos, at }); tgRunCountdown(pos, at);
}
// Отсчёт 3-2-1: пауза и перемотка в одну точку, старт в один момент.
function tgRunCountdown(pos, at) {
  tg.hold = at + 2500;
  tgCmd('pause'); setTimeout(() => tgCmd('seek', pos), 150);
  for (const n of [3, 2, 1]) setTimeout(() => { tgOsd(String(n)); tgNote('Старт через ' + n); }, Math.max(0, at - Date.now() - n * 1000));
  setTimeout(() => { tgCmd('play'); tgOsd('▶ Поехали!'); tgNote('Поехали!'); tg.lastSt = ''; }, Math.max(0, at - Date.now()));
}
/* гость: догоняет ведущего */
function tgFollow(m) {
  tg.st = m; tg.stAt = Date.now();
  if (m.media) tg.media = m.media;
  if (tg.off.length < 3 || Math.random() < 0.15) tgSend({ k: 'ping', to: m.from, t0: Date.now() });
}
function tgGuestTick(mine) {
  const st = tg.st, now = Date.now();
  if (!st || now - tg.stAt > 8000) { tg.sync = tg.peers.size ? 'Жду ведущего…' : 'Ищу участников…'; return; }
  if (!st.a) { tg.sync = 'У ведущего фильм не запущен'; return; }
  if (!mine.active || mine.hash !== st.h || mine.file !== st.f) { tg.sync = 'open'; return; }
  if (mine.error) { tg.sync = 'Плеер не отвечает'; return; }
  if (now < tg.hold || now - tg.cmdAt < 1500) return;
  const expect = st.pos + (st.paused ? 0 : Math.max(0, now + tgOffset() - st.at) / 1000 * (st.rate || 1));
  const prev = tg.prev && tg.prev.active && tg.prev.hash === mine.hash ? tg.prev : null;
  // своё действие гостя — просьба ведущему
  if (prev && prev.paused !== mine.paused && mine.paused !== st.paused) {
    tgSend({ k: 'req', to: st.from, action: mine.paused ? 'pause' : 'play' }); tg.cmdAt = now; tg.sync = 'Попросил ведущего: ' + (mine.paused ? 'пауза' : 'продолжить'); return;
  }
  if (prev && !st.paused && Math.abs(mine.pos - expect) > 5 && Math.abs(prev.pos - expect) < 1.5) {
    tgSend({ k: 'req', to: st.from, action: 'seek', val: mine.pos }); tg.cmdAt = now; tg.sync = 'Попросил ведущего перемотать'; return;
  }
  if (mine.paused !== st.paused) { tgCmd(st.paused ? 'pause' : 'play'); tg.sync = st.paused ? 'Пауза у ведущего' : 'Продолжаем'; return; }
  const diff = mine.pos - expect, base = st.rate || 1;
  if (st.paused) { if (Math.abs(diff) > 0.5) tgCmd('seek', expect); tg.sync = 'Пауза у всех'; return; }
  // буфер: позиция стоит, а у ведущего идёт
  if (prev && mine.pos - prev.pos < 0.15) tg.stall++; else tg.stall = 0;
  if (tg.stall >= 3 && now - tg.waitAt > 30000) {
    tg.waitAt = now; tg.stall = 0;
    tgSend({ k: 'wait', to: st.from }); tg.sync = 'Подгружается — попросил подождать';
    setTimeout(() => tgSend({ k: 'ready', to: st.from }), 7000);
    return;
  }
  if (Math.abs(diff) > 2) { tgCmd('seek', expect + 0.2); if (tg.adj) { tgCmd('rate', base); tg.adj = false; } tg.sync = 'Перемотал к ведущему'; return; }
  if (Math.abs(diff) > 0.4) { tgCmd('rate', base * (diff > 0 ? 0.95 : 1.05)); tg.adj = true; tg.sync = diff > 0 ? 'Чуть притормаживаю' : 'Чуть догоняю'; return; }
  if (tg.adj && Math.abs(diff) < 0.15) { tgCmd('rate', base); tg.adj = false; }
  tg.sync = `В синхроне · ±${Math.abs(diff).toFixed(1).replace('.', ',')} с`;
}
async function tgOpenMedia() {
  const m = tg.media; if (!m || !m.h) return;
  let t = (state.lib || []).find(x => x.hash === m.h);
  if (!t) {
    try { await addTorrentRes(magnetFromHash(m.h, m.t || '')); await loadLibrary(); }
    catch (e) { toast('Не удалось добавить раздачу: ' + e.message, true); return; }
    t = (state.lib || []).find(x => x.hash === m.h) || { hash: m.h, title: m.t, file_stats: [] };
  }
  if (!(t.file_stats || []).length) { toast('Получаю список файлов…'); t = await waitForFiles(t, 30000) || t; }
  const f = (t.file_stats || []).find(x => x.id === m.f);
  if (!f) { toast('Файлы раздачи ещё не получены — попробуйте через минуту', true); return; }
  const pl = pickPlayer();
  if (pl !== 'mpv' && pl !== 'vlc') toast('Для синхронизации нужен mpv или VLC — выберите его в «Плеерах»', true);
  playSelected(t, f, { fromZero: true, onPC: true });
}

/* ── чат ── */
function tgNote(text) { tgChatPush({ sys: true, text }); }
function tgChatPush(m) {
  m.at = Date.now(); tg.chat.push(m); if (tg.chat.length > 200) tg.chat.shift();
  const box = $('#tgChat');
  if (box) { box.insertAdjacentHTML('beforeend', tgMsgHtml(m)); box.scrollTop = box.scrollHeight; }
  else if (!m.sys && !m.mine) { tg.unread++; toast(`${m.name}: ${m.text}`); }
  tgPaintDock();
}
function tgMsgHtml(m) {
  const tm = new Date(m.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (m.sys) return html`<div class="tg-msg sys">${m.text}</div>`;
  return html`<div class="tg-msg${m.mine ? ' me' : ''}${m.react ? ' react' : ''}"><b>${m.name}</b><span>${m.text}</span><time>${tm}</time></div>`;
}
function tgChatIn(p, text) { if (!text) return; tgChatPush({ name: p.name, text }); tgOsd(`💬 ${p.name}: ${text}`); }
function tgReactIn(p, e) { tgChatPush({ name: p.name, text: e, react: true }); tgOsd(`${e} ${p.name}`); tgBurst(e); }
function tgSay(text) {
  text = String(text || '').trim().slice(0, 500); if (!text || !tg.on) return;
  tgSend({ k: 'chat', text }); tgChatPush({ name: tg.name, text, mine: true });
}
function tgReact(e) { tgSend({ k: 'react', e }); tgChatPush({ name: tg.name, text: e, mine: true, react: true }); tgBurst(e); }
function tgBurst(e) {
  const box = $('#tgRoot'); if (!box) return;
  const s = document.createElement('span'); s.className = 'tg-burst'; s.textContent = e;
  s.style.left = (20 + Math.random() * 60) + '%'; box.appendChild(s); setTimeout(() => s.remove(), 2200);
}

/* ── раздел ── */
function renderTogether(root) {
  root.innerHTML = '<div class="tg" id="tgRoot"></div>';
  tg.unread = 0; tgPaint();
}
function tgPaint() {
  tgPaintDock();
  const root = $('#tgRoot'); if (!root) return;
  if (!root._bound) {
    root._bound = true;
    root.addEventListener('click', tgOnClick);
    root.addEventListener('change', tgOnChange);
    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'tgIn') { tgSay(e.target.value); e.target.value = ''; }
      if (e.target.id === 'tgCodeIn') tgOnClick({ target: $('[data-tg=join]') });
    });
  }
  if (!tg.on) { root.innerHTML = tgLobbyHtml(); return; }
  if (!$('#tgChat')) {
    root.innerHTML = html`<div class="mu-head"><h1 class="page-title">Смотрим вместе</h1><span class="tg-role">${tg.host ? 'вы ведущий' : 'вы гость'}</span></div>
      <div class="tg-grid">
        <div class="tg-side">
          <div class="card tg-card" id="tgStatus"></div>
          <div class="card tg-card"><div class="tg-h">Пригласить</div>
            <div class="tg-code"><code id="tgCode"></code><button class="btn" data-tg="copy">Скопировать</button></div>
            <div class="tg-links"><button class="btn sm" data-tg="link-web" title="Откроется в обычном браузере: друг видит ваш экран, слышит звук и голос, пишет в чат">🌐 Ссылка для друга без TorrClient</button><button class="btn sm" data-tg="link-app" title="У друга есть TorrClient — ссылка откроет комнату в нём">Ссылка для TorrClient</button></div>
            <div class="muted sm">Друг с TorrClient вставляет код в «Вместе → Присоединиться» или открывает ссылку. Без TorrClient — «Ссылка для друга»: откроется страница в браузере, а вы включите «Показать экран». В коде — ключ шифрования, поэтому отправляйте его лично.</div></div>
        </div>
        <div class="card tg-chatcard">
          <div class="tg-chat" id="tgChat">${raw(tg.chat.map(tgMsgHtml).join(''))}</div>
          <div class="tg-reacts">${raw(TG_REACT.map(e => `<button class="iconbtn" data-tg-react="${e}">${e}</button>`).join(''))}</div>
          <div class="tg-input"><input id="tgIn" maxlength="500" placeholder="Сообщение — увидят в чате и поверх видео в mpv" autocomplete="off"><button class="btn primary" data-tg="send">Отправить</button></div>
        </div>
      </div>`;
    const c = $('#tgChat'); c.scrollTop = c.scrollHeight;
  }
  const code = $('#tgCode'); if (code) code.textContent = tgCode();
  tgPaintStatus();
}
function tgLobbyHtml() {
  const can = tgCanRun(), v = k => localStorage.getItem(k) || '';
  return html`<div class="mu-head"><h1 class="page-title">Смотрим вместе</h1></div>
    <p class="muted tg-lead">Смотрите фильм с другом на разных компьютерах: плееры идут в ногу, есть чат, голос и показ экрана. У каждого свой TorrClient и своя раздача — по сети идут только команды.</p>
    ${can ? '' : raw('<div class="card tg-warn">Браузер разрешает звонки и шифрование только на защищённом адресе. Откройте TorrClient на самом компьютере (адрес <code>localhost</code>) или в приложении.</div>')}
    <label class="tg-name">Ваше имя <input id="tgName" maxlength="40" value="${tgMyName()}"></label>
    <div class="tg-lobby">
      <div class="card tg-card"><div class="tg-h">Создать комнату</div>
        <p class="muted sm">Включите фильм в mpv или VLC — до или после создания комнаты. Гости увидят, что смотреть, и откроют ту же раздачу у себя.</p>
        <button class="btn primary" data-tg="create"${raw(can ? '' : ' disabled')}>Создать комнату</button></div>
      <div class="card tg-card"><div class="tg-h">Присоединиться</div>
        <input id="tgCodeIn" placeholder="Код приглашения TC1.…" autocomplete="off">
        <button class="btn primary" data-tg="join"${raw(can ? '' : ' disabled')}>Присоединиться</button></div>
    </div>
    <details class="tg-adv"><summary>Соединение</summary>
      <p class="muted sm">Участники находят друг друга через публичные MQTT-брокеры (EMQX, HiveMQ, Mosquitto); сообщения зашифрованы. Можно указать свой брокер (WebSocket, wss://…/mqtt) — его адрес попадёт в приглашение. Если напрямую соединиться не выходит (строгий NAT), поможет свой TURN-сервер.</p>
      <label>Свой MQTT-брокер <input data-tg-set="tc_tg_broker" value="${v('tc_tg_broker')}" placeholder="wss://broker.example.com:8084/mqtt"></label>
      <label>TURN <input data-tg-set="tc_tg_turn" value="${v('tc_tg_turn')}" placeholder="turn:turn.example.com:3478"></label>
      <label>TURN логин <input data-tg-set="tc_tg_turnu" value="${v('tc_tg_turnu')}"></label>
      <label>TURN пароль <input type="password" data-tg-set="tc_tg_turnp" value="${v('tc_tg_turnp')}"></label>
    </details>`;
}
function tgPaintStatus() {
  const box = $('#tgStatus'); if (!box) return;
  const brokers = tg.mq.filter(c => c.ok).length, peers = [...tg.peers.values()], m = tg.media;
  box.innerHTML = html`<div class="tg-h">Комната</div>
    <div class="tg-people">
      <div class="tg-person me"><i>${tg.name.slice(0, 1).toUpperCase()}</i><span>${tg.name}<small>вы${tg.host ? ' · ведущий' : ''}${tg.mic ? ' · 🎤' : ''}${tg.screen ? ' · 🖥' : ''}</small></span></div>
      ${peers.map(p => raw(html`<div class="tg-person"><i>${p.name.slice(0, 1).toUpperCase()}</i><span>${p.name}<small>${p.host ? 'ведущий · ' : ''}${p.web ? '🌐 браузер · ' : ''}${tgLink(p)}</small></span></div>`))}
      ${peers.length ? '' : raw('<div class="muted sm">Пока никого. Отправьте код приглашения.</div>')}
    </div>
    <div class="tg-media">${m && m.h ? raw(html`🎬 <b>${m.t || 'Фильм'}</b>`) : raw('<span class="muted">Фильм не выбран</span>')}</div>
    <div class="tg-sync" id="tgSync"></div>
    <div class="tg-acts">
      <button class="btn${tg.mic ? ' on' : ''}" data-tg="mic">${tg.mic ? '🎤 Выключить микрофон' : '🎤 Микрофон'}</button>
      <button class="btn${tg.screen ? ' on' : ''}" data-tg="screen">${tg.screen ? '🖥 Остановить показ' : '🖥 Показать экран'}</button>
      ${tg.host ? raw('<button class="btn" data-tg="cd" title="Пауза у всех, перемотка в одну точку и старт после 3-2-1">⏱ Старт с отсчётом</button>') : ''}
      <button class="btn danger" data-tg="leave">Выйти</button>
    </div>
    <div class="muted sm">${brokers ? `Брокеров на связи: ${brokers} из ${tg.mq.length}` : 'Брокеры недоступны — переподключаюсь…'}</div>`;
  tgPaintSync();
}
function tgPaintSync() {
  const el = $('#tgSync'); if (!el) return;
  if (tg.sync === 'open') { if (!el.querySelector('[data-tg=open]')) el.innerHTML = '<span>У вас открыт другой фильм или плеер закрыт.</span> <button class="btn primary sm" data-tg="open">▶ Открыть у себя</button>'; }
  else el.textContent = tg.sync || '';
}
function tgPaintDock() {
  let d = $('#tgDock');
  if (!tg.on || state.view === 'together') { if (d) d.remove(); return; }
  if (!d) { d = document.createElement('button'); d.id = 'tgDock'; d.className = 'tg-dock'; d.onclick = () => setView('together'); document.body.appendChild(d); }
  d.innerHTML = html`👥 Вместе · ${tg.peers.size + 1}${tg.unread ? raw(`<b>${tg.unread}</b>`) : ''}`;
}
async function tgOnClick(e) {
  const t = e.target && e.target.closest ? e.target : null; if (!t) return;
  const r = t.closest('[data-tg-react]'); if (r) { tgReact(r.dataset.tgReact); return; }
  const b = t.closest('[data-tg]'); if (!b) return;
  const a = b.dataset.tg;
  if (a === 'create') { tgSaveName(); await tgCreate(); }
  else if (a === 'join') {
    tgSaveName();
    const o = tgParse(($('#tgCodeIn') || {}).value);
    if (!o) { toast('Это не код приглашения — он начинается с TC1.', true); return; }
    await tgStart(o, false);
  }
  else if (a === 'link-web' || a === 'link-app') { const c = tgLinkFor(a === 'link-web'); try { await navigator.clipboard.writeText(c); toast(a === 'link-web' ? 'Ссылка скопирована — друг откроет её в браузере' : 'Ссылка скопирована'); } catch { prompt('Скопируйте ссылку:', c); } }
  else if (a === 'copy') { const c = tgCode(); try { await navigator.clipboard.writeText(c); toast('Код скопирован'); } catch { prompt('Скопируйте код:', c); } }
  else if (a === 'send') { const i = $('#tgIn'); tgSay(i.value); i.value = ''; i.focus(); }
  else if (a === 'mic') tgMic();
  else if (a === 'screen') tgScreenToggle();
  else if (a === 'cd') tgCountdown();
  else if (a === 'leave') tgLeave();
  else if (a === 'open') tgOpenMedia();
}
function tgOnChange(e) { const k = e.target.dataset && e.target.dataset.tgSet; if (k) savePref(k, e.target.value.trim()); if (e.target.id === 'tgName') tgSaveName(); }
function tgSaveName() { const i = $('#tgName'); if (i && i.value.trim()) savePref('tc_tg_name', i.value.trim().slice(0, 40)); }
const TG_WEB_URL = 'https://qwkejkqwje1.github.io/TorrClient/watch/';
// Ссылки-приглашения: код идёт после #, поэтому не уходит ни на GitHub, ни на чей-то сервер.
function tgLinkFor(web) { return web ? TG_WEB_URL + '#' + tgCode() : 'http://localhost:8099/#join=' + tgCode(); }
// После перезагрузки страницы — обратно в ту же комнату; ссылка #join=КОД — сразу в комнату гостем.
function tgBoot() {
  const h = decodeURIComponent(BOOT_HASH), j = h.match(/^#join=(TC1\.[A-Za-z0-9_-]+)/);
  if (j) {
    const o = tgParse(j[1]);
    if (o) { if (typeof setView === 'function') setView('together'); tgStart(o, false); return; }
  }
  let s; try { s = JSON.parse(sessionStorage.getItem('tc_tg') || 'null'); } catch {}
  if (s && s.o && !tg.on) tgStart(s.o, !!s.host);
}
window.addEventListener('beforeunload', () => { if (tg.on) try { tgSend({ k: 'bye' }); } catch {} });
setTimeout(tgBoot, 1200);