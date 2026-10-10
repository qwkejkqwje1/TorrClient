// Собрано из web/src/68-together.js (node tools/build-web.cjs) — не править вручную.
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

