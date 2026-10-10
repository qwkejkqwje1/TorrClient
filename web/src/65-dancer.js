/* ───────────── аудио: танцоры ─────────────
   На сцене раздела «Аудио» танцует персонаж, нарисованный в духе аниме
   (заливка и тёмный контур): Резе — каре, зелёные глаза, белая рубашка и
   чокер — или серый волк с хвостом. На каждый трек выбирается случайный
   танцор и танец (или тот, кого закрепили кнопкой). Слух: удары баса из
   Web Audio дают темп и фазу «метронома»; если звук прочитать нельзя
   (радио без CORS), танцор держит свой темп ~118 BPM. Руки и ноги — через
   обратную кинематику к целям кистей и стоп. Рисуется 30 кадров/с, только
   пока раздел открыт и окно видно. */
const dz = { cv: null, ctx: null, raf: 0, last: 0, w: 0, h: 0, dpr: 1,
  who: 'reze', b: 0, bpm: 118, onsets: [], lastOn: 0, eMean: 0, eVar: 0, energy: 0, prevE: 0, spec: null, bassIx: [1, 6],
  move: 'idle', prevMove: 'idle', moveAt: 0, pose: null, hair: 0, hairV: 0, skirt: 0, skirtV: 0, lastHx: 0, lastPx: 0,
  tail: [], fw: [], stars: [], trees: [], flies: [], lastBurst: -1, flash: 0 };
const DZ_MOVES = { reze: ['iris', 'clap', 'point', 'hop'], wolf: ['howl', 'stomp', 'shuffle', 'shake'] };
const DZ_NAMES = { iris: 'IRIS OUT', clap: 'хлопки', point: 'указка', hop: 'прыжки', howl: 'вой', stomp: 'топот', shuffle: 'шаффл', shake: 'тряска', idle: '' };
function dancerOn() { return localStorage.getItem('tc_dancer') !== '0'; }
function dancerWho() { const v = localStorage.getItem('tc_dancer_who'); return v === 'reze' || v === 'wolf' ? v : 'random'; }
function dancerHtml() {
  const on = dancerOn(), w = dancerWho();
  return html`<aside class="mu-stage${on ? '' : ' off'}" id="muStage">
    <canvas id="muDance"></canvas>
    ${on ? raw(html`<button class="iconbtn mu-stage-who" id="muDanceWho" title="Кто танцует: ${w === 'random' ? 'случайно на каждый трек' : w === 'reze' ? 'Резе' : 'Волк'}">${w === 'random' ? '🎲' : w === 'reze' ? '💃' : '🐺'}</button>`) : ''}
    <button class="iconbtn mu-stage-x" id="muDanceX" title="${on ? 'Убрать танцора' : 'Позвать танцора'}">${on ? '×' : '💃'}</button>
    <div class="mu-stage-cap" id="muDanceCap"></div>
  </aside>`;
}
function bindDancer() {
  const x = $('#muDanceX'); if (!x) return;
  const redraw = () => { const st = $('#muStage'); st.outerHTML = dancerHtml(); bindDancer(); };
  x.addEventListener('click', () => { savePref('tc_dancer', dancerOn() ? '0' : '1'); redraw(); });
  const w = $('#muDanceWho');
  if (w) w.addEventListener('click', () => {
    const order = ['random', 'reze', 'wolf'], next = order[(order.indexOf(dancerWho()) + 1) % 3];
    savePref('tc_dancer_who', next); dancerNewTrack(); redraw();
    toast(next === 'random' ? 'Танцор — случайный на каждый трек' : next === 'reze' ? 'Танцует Резе' : 'Танцует волк');
  });
  if (dancerOn()) dancerStart();
}
// Новый трек: новый танцор (если не закреплён) и новый танец.
function dancerNewTrack() {
  const w = dancerWho();
  const who = w === 'random' ? (Math.random() < 0.5 ? 'reze' : 'wolf') : w;
  if (who !== dz.who) { dz.who = who; dz.pose = null; dz.tail = []; dz.fw = []; }
  const list = DZ_MOVES[dz.who];
  dz.prevMove = dz.move; dz.move = list[Math.floor(Math.random() * list.length)]; dz.moveAt = Math.floor(dz.b);
  dz.onsets = [];
}
function dancerStart() {
  const cv = $('#muDance'); if (!cv) return;
  if (!dz.who || (dancerWho() !== 'random' && dz.who !== dancerWho())) dz.who = dancerWho() === 'random' ? dz.who : dancerWho();
  dz.cv = cv; dz.ctx = cv.getContext('2d');
  dancerResize();
  cancelAnimationFrame(dz.raf); dz.last = 0;
  dz.raf = requestAnimationFrame(dancerFrame);
}
function dancerResize() {
  const r = dz.cv.getBoundingClientRect();
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  dz.w = Math.max(10, r.width); dz.h = Math.max(10, r.height); dz.dpr = dpr;
  dz.cv.width = Math.round(dz.w * dpr); dz.cv.height = Math.round(dz.h * dpr);
  const W = dz.w, H = dz.h;
  dz.stars = Array.from({ length: 60 }, () => ({ x: Math.random() * W, y: Math.random() * H * 0.6, r: Math.random() * 1.2 + 0.3, f: Math.random() * 6 }));
  dz.trees = Array.from({ length: 16 }, (_, i) => ({ x: (i + Math.random() * 0.8) / 16 * W * 1.1 - W * 0.05, h: H * (0.16 + Math.random() * 0.16), far: i % 2 }));
  dz.trees.sort((a, b) => b.far - a.far);
  dz.flies = Array.from({ length: 16 }, () => ({ x: Math.random() * W, y: H * (0.45 + Math.random() * 0.45), a: Math.random() * 6, s: 6 + Math.random() * 12, f: Math.random() * 6 }));
}

/* ── слух: удары баса и темп ── */
function dancerListen(dt, now) {
  const playing = typeof auPlaying === 'function' && auPlaying();
  const an = playing && typeof auAnalyser === 'function' ? auAnalyser() : null;
  let bass = 0, all = 0;
  if (an) {
    if (!dz.spec || dz.spec.length !== an.frequencyBinCount) {
      dz.spec = new Uint8Array(an.frequencyBinCount);
      const bw = an.context.sampleRate / an.fftSize;
      dz.bassIx = [Math.max(1, Math.round(40 / bw)), Math.max(2, Math.round(150 / bw))];
    }
    an.getByteFrequencyData(dz.spec);
    const s = dz.spec, [b0, b1] = dz.bassIx, top = Math.min(s.length, Math.round(s.length * 0.3));
    for (let i = b0; i <= b1; i++) bass += s[i];
    for (let i = 0; i < top; i++) all += s[i];
    bass /= (b1 - b0 + 1) * 255; all /= top * 255;
  }
  // без анализа (радио без CORS) — ровная «внутренняя» энергия
  const target = !playing ? 0 : an ? Math.min(1, all * 2.2) : 0.6;
  dz.energy += (target - dz.energy) * Math.min(1, dt * 3);
  const d = bass - dz.eMean;
  dz.eMean += d * Math.min(1, dt * 2.2); dz.eVar += (d * d - dz.eVar) * Math.min(1, dt * 2.2);
  const rise = bass - dz.prevE; dz.prevE = bass;
  if (an && bass > 0.3 && d > Math.sqrt(dz.eVar) * 1.15 && rise > 0 && now - dz.lastOn > 260) {
    const gap = now - dz.lastOn; dz.lastOn = now;
    if (gap < 2000) { dz.onsets.push(gap); if (dz.onsets.length > 24) dz.onsets.shift(); }
    if (dz.onsets.length >= 4) {
      const g = dz.onsets.slice().sort((x, y) => x - y)[dz.onsets.length >> 1];
      let bpm = 60000 / g; while (bpm < 85) bpm *= 2; while (bpm > 170) bpm /= 2;
      dz.bpm += (bpm - dz.bpm) * 0.25;
    }
    const fr = dz.b - Math.floor(dz.b);
    dz.b += fr > 0.5 ? (1 - fr) * 0.35 : -fr * 0.35;
  }
  if (playing && !an) dz.bpm += (118 - dz.bpm) * Math.min(1, dt);
  dz.b += dt * (playing ? dz.bpm : 40) / 60;
  return { playing, heard: !!an };
}

/* ── хореография: цели кистей (в осях торса от груди), стоп и таза ── */
const TAU = Math.PI * 2;
function dzPose(m, b, e) {
  const fr = b - Math.floor(b), beat = Math.floor(b), dn = Math.pow(1 - fr, 3), A = 0.55 + e * 0.6;
  const p = { px: 0, py: dn * 4 * A, tl: 0, ht: 0, lh: [-17, 40], rh: [17, 40], lf: [-12, 0], rf: [12, 0], muz: 0, ring: 0, spark: 0 };
  const sw = Math.sin(Math.PI * b);
  switch (m) {
    case 'idle':
      p.px = Math.sin(b * Math.PI / 2) * 2; p.py = 1; p.tl = Math.sin(b * Math.PI / 2) * 0.03; p.ht = -p.tl;
      p.lh = [-16, 41]; p.rh = [16, 41]; break;
    case 'iris': { // кисть кольцом у глаза, другая на бедре; стороны меняются каждые 2 доли
      const s = Math.floor(b / 4) % 2 ? 1 : -1, a = TAU * b;
      const hand = [s * 8 + Math.cos(a) * 2.5 * A, -25 + Math.sin(a) * 2.5 * A];
      if (s < 0) { p.lh = hand; p.rh = [16, 39]; } else { p.rh = hand; p.lh = [-16, 39]; }
      p.px = -s * 5 * A; p.tl = s * 0.07; p.ht = s * 0.16 + Math.sin(a) * 0.03;
      if (s < 0) p.rf = [12, 3]; else p.lf = [-12, 3];
      p.ring = 1; break;
    }
    case 'clap': {
      const sep = Math.sin(Math.PI * fr), hi = beat % 4 === 3 ? -22 : 12;
      p.lh = [-3 - 19 * sep, hi + sep * 6]; p.rh = [3 + 19 * sep, hi + sep * 6];
      p.px = Math.sin(Math.PI * b) * 4 * A; p.tl = -p.px * 0.012;
      if (beat % 2) p.lf = [-16, 0]; else p.rf = [16, 0];
      p.spark = fr < 0.18 ? 1 - fr / 0.18 : 0; break;
    }
    case 'point': {
      const s = Math.floor(b / 2) % 2 ? 1 : -1, pop = Math.pow(1 - (b / 2 - Math.floor(b / 2)), 2);
      const up = [s * (38 + 3 * pop), -36 - 4 * pop];
      if (s < 0) { p.lh = up; p.rh = [16, 39]; } else { p.rh = up; p.lh = [-16, 39]; }
      p.px = s * 5 * A * (0.5 + pop); p.tl = -s * 0.06; p.ht = s * 0.12;
      if (s < 0) p.lf = [-17, 0]; else p.rf = [17, 0];
      break;
    }
    case 'hop': {
      const h = Math.sin(Math.PI * fr) * 9 * A;
      p.py = -h + dn * 3; p.lf = [-10, h]; p.rf = [10, h];
      p.lh = [-22, 30 - 16 * sw]; p.rh = [22, 30 + 16 * sw];
      p.tl = sw * 0.04; p.ht = -sw * 0.08; break;
    }
    case 'howl': { // 2 доли — вой, задрав морду, 2 доли — покачивание
      const ph = (b / 4 - Math.floor(b / 4)) * 4, hw = ph < 2 ? Math.sin(Math.min(1, ph / 0.4) * Math.PI / 2) * (ph > 1.7 ? (2 - ph) / 0.3 : 1) : 0;
      p.muz = hw; p.py = 2 + (1 - hw) * dn * 4 * A;
      p.lh = [-13 - (1 - hw) * 4, -12 + (1 - hw) * 28]; p.rh = [13 + (1 - hw) * 4, -12 + (1 - hw) * 28];
      p.px = (1 - hw) * Math.sin(Math.PI * b) * 3; p.lf = [-14, 0]; p.rf = [14, 0]; break;
    }
    case 'stomp': {
      const s = beat % 2 ? 1 : -1, lift = Math.sin(Math.PI * Math.min(1, fr * 1.4)) * 20 * A;
      if (s < 0) p.lf = [-13, lift]; else p.rf = [13, lift];
      p.px = -s * 3; p.py = 3 + dn * 5 * A; p.tl = s * 0.04;
      p.lh = [-18, s < 0 ? 26 : 6 - 6 * A]; p.rh = [18, s > 0 ? 26 : 6 - 6 * A]; break;
    }
    case 'shuffle': {
      const k = Math.sin(TAU * b / 2), l = Math.max(0, Math.sin(TAU * b)) * 8 * A;
      p.lf = [-12 + 9 * k, beat % 2 ? l : 0]; p.rf = [12 + 9 * k, beat % 2 ? 0 : l];
      p.px = 5 * k; p.py = 3 + dn * 3; p.tl = -k * 0.04;
      p.lh = [-17, 18 + 10 * sw]; p.rh = [17, 18 - 10 * sw]; break;
    }
    case 'shake': {
      const q = Math.sin(TAU * b * 2);
      p.px = q * 6 * A; p.tl = -q * 0.06; p.ht = q * 0.08; p.py = 3;
      p.lh = [-42, -4 + 6 * q]; p.rh = [42, -4 - 6 * q]; p.lf = [-15, 0]; p.rf = [15, 0]; break;
    }
  }
  return p;
}
function dzLerp(a, b, t) {
  const o = {};
  for (const k in b) o[k] = Array.isArray(b[k]) ? [a[k][0] + (b[k][0] - a[k][0]) * t, a[k][1] + (b[k][1] - a[k][1]) * t] : a[k] + (b[k] - a[k]) * t;
  return o;
}
function dzChoreo(playing) {
  if (!playing) { if (dz.move !== 'idle') { dz.prevMove = dz.move; dz.move = 'idle'; dz.moveAt = dz.b; } return; }
  if (dz.move === 'idle' || dz.b - dz.moveAt >= 8) {
    const list = DZ_MOVES[dz.who].filter(m => m !== dz.move);
    dz.prevMove = dz.move; dz.move = list[Math.floor(Math.random() * list.length)]; dz.moveAt = Math.floor(dz.b);
  }
}

/* ── скелет ── */
function dzRot(v, a) { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; }
function dzAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
// Двухзвенная ОК: сустав выбирается «наружу» (out = −1 влево, +1 вправо).
function dzIK(root, tgt, l1, l2, out) {
  let dx = tgt[0] - root[0], dy = tgt[1] - root[1], d = Math.hypot(dx, dy) || 0.001;
  const dm = Math.min(l1 + l2 - 0.01, Math.max(Math.abs(l1 - l2) + 0.01, d));
  dx *= dm / d; dy *= dm / d; d = dm;
  const th = Math.atan2(dy, dx), al = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const j1 = [root[0] + Math.cos(th + al) * l1, root[1] + Math.sin(th + al) * l1], j2 = [root[0] + Math.cos(th - al) * l1, root[1] + Math.sin(th - al) * l1];
  return { j: (j1[0] - j2[0]) * out > 0 ? j1 : j2, e: [root[0] + dx, root[1] + dy] };
}
function dzSkeleton(p) {
  const pel = [p.px, p.py], chest = dzAdd(pel, dzRot([0, -46], p.tl));
  const loc = v => dzAdd(chest, dzRot(v, p.tl));
  const g = { pel, chest, tl: p.tl, ht: p.ht, neck: loc([0, -6]) };
  g.head = dzAdd(g.neck, dzRot([0, -16], p.tl + p.ht));
  g.ls = loc([-14, 2]); g.rs = loc([14, 2]);
  const la = dzIK(g.ls, loc(p.lh), 28, 27, -1), ra = dzIK(g.rs, loc(p.rh), 28, 27, 1);
  g.le = la.j; g.lw = la.e; g.re = ra.j; g.rw = ra.e;
  g.lhip = dzAdd(pel, dzRot([-9, 4], p.tl * 0.5)); g.rhip = dzAdd(pel, dzRot([9, 4], p.tl * 0.5));
  const ll = dzIK(g.lhip, [p.lf[0], 92 - p.lf[1]], 47, 46, -1), rl = dzIK(g.rhip, [p.rf[0], 92 - p.rf[1]], 47, 46, 1);
  // колени гнутся к зрителю, а не в стороны: боковой вынос сильно сжат
  const knee = (h, k, a) => { const mx = h[0] + (a[0] - h[0]) * 47 / 93; return [mx + (k[0] - mx) * 0.4, k[1]]; };
  g.lk = knee(g.lhip, ll.j, ll.e); g.la = ll.e; g.rk = knee(g.rhip, rl.j, rl.e); g.ra = rl.e;
  return g;
}

/* ── рисование в cel-стиле ── */
const OL = '#1b1424';
function dzLimb(c, pts, w, col, ol = OL) {
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.strokeStyle = ol; c.lineWidth = w + 3; c.stroke();
  c.strokeStyle = col; c.lineWidth = w; c.stroke();
}
function dzFill(c, col, ol = OL, lw = 1.6) { c.fillStyle = col; c.fill(); c.strokeStyle = ol; c.lineWidth = lw; c.stroke(); }
function dzDot(c, p, r, col) { c.beginPath(); c.arc(p[0], p[1], r, 0, TAU); dzFill(c, col); }
function dzShoe(c, a, col, side) {
  c.beginPath(); c.ellipse(a[0] + side * 3, a[1] + 1.5, 7, 3.6, 0, 0, TAU); dzFill(c, col);
}
// Пружинка для волос, юбки и прочего, что догоняет тело.
function dzSpring(k, v, tgt, dt, stiff = 70, damp = 7) { const a = (tgt - dz[k]) * stiff - dz[v] * damp; dz[v] += a * dt; dz[k] += dz[v] * dt; }

function dzDrawReze(c, g, p, dt) {
  const SKIN = '#f6dccd', HAIR = '#3a2346', HAIR2 = '#5b3a6e', SHIRT = '#f5f3ef', SKIRT = '#262a3d', SHOE = '#221c28';
  const hv = (g.head[0] - dz.lastHx) / Math.max(dt, 0.01); dz.lastHx = g.head[0];
  dzSpring('hair', 'hairV', Math.max(-0.7, Math.min(0.7, -hv * 0.012)), dt);
  const pv = (g.pel[0] - dz.lastPx) / Math.max(dt, 0.01); dz.lastPx = g.pel[0];
  dzSpring('skirt', 'skirtV', Math.max(-0.5, Math.min(0.5, -pv * 0.01)), dt, 55, 6);
  const H = g.head, ha = g.tl + g.ht;
  // волосы сзади: каре до подбородка
  c.save(); c.translate(H[0], H[1]); c.rotate(ha); c.scale(1.25, 1.25);
  c.beginPath(); c.moveTo(-14, -2); c.quadraticCurveTo(-16, -17, 0, -17); c.quadraticCurveTo(16, -17, 14, -2);
  c.quadraticCurveTo(15 + dz.hair * 4, 10, 12 + dz.hair * 5, 15); c.lineTo(-12 + dz.hair * 5, 15); c.quadraticCurveTo(-15 + dz.hair * 4, 10, -14, -2); dzFill(c, HAIR);
  c.restore();
  // ноги
  dzLimb(c, [g.lhip, g.lk, g.la], 8, SKIN); dzLimb(c, [g.rhip, g.rk, g.ra], 8, SKIN);
  dzShoe(c, g.la, SHOE, -1); dzShoe(c, g.ra, SHOE, 1);
  // юбка
  c.save(); c.translate(g.pel[0], g.pel[1]); c.rotate(g.tl * 0.5);
  const sk = dz.skirt * 10, fl = 2 + dz.energy * 3;
  c.beginPath(); c.moveTo(-11, -6); c.lineTo(11, -6); c.lineTo(17 + fl + sk, 24); c.quadraticCurveTo(sk, 27, -17 - fl + sk, 24); c.closePath(); dzFill(c, SKIRT);
  c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1; c.beginPath(); c.moveTo(-4, -4); c.lineTo(-6 + sk * 0.6, 23); c.moveTo(5, -4); c.lineTo(7 + sk * 0.6, 23); c.stroke();
  c.restore();
  // рубашка
  c.save(); c.translate(g.chest[0], g.chest[1]); c.rotate(g.tl);
  c.beginPath(); c.moveTo(-15, 0); c.quadraticCurveTo(0, -5, 15, 0); c.lineTo(11, 41); c.quadraticCurveTo(0, 43, -11, 41); c.closePath(); dzFill(c, SHIRT);
  c.strokeStyle = '#c9c4cf'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, 2); c.lineTo(0, 40); c.stroke();
  for (let y = 9; y < 40; y += 9) { c.fillStyle = '#b8b2c0'; c.beginPath(); c.arc(1.8, y, 0.9, 0, TAU); c.fill(); }
  c.beginPath(); c.moveTo(-6, -3); c.lineTo(0, 5); c.lineTo(6, -3); dzFill(c, SHIRT, OL, 1.2); // воротник
  c.restore();
  // шея с чокером
  dzLimb(c, [g.chest, g.neck], 6, SKIN);
  c.save(); c.translate(g.neck[0], g.neck[1]); c.rotate(g.tl); c.fillStyle = '#111'; c.fillRect(-4, -1.5, 8, 2.6); c.restore();
  // голова и лицо
  c.save(); c.translate(H[0], H[1]); c.rotate(ha); c.scale(1.25, 1.25);
  c.beginPath(); c.ellipse(0, 0, 10.5, 12.5, 0, 0, TAU); dzFill(c, SKIN);
  for (const s of [-1, 1]) {
    c.fillStyle = '#fff'; c.beginPath(); c.ellipse(s * 4.4, 1, 2.6, 2.9, 0, 0, TAU); c.fill();
    c.fillStyle = '#2f9e6e'; c.beginPath(); c.ellipse(s * 4.2, 1.4, 1.8, 2.4, 0, 0, TAU); c.fill();
    c.fillStyle = '#0c2a1e'; c.beginPath(); c.arc(s * 4.2, 1.6, 0.9, 0, TAU); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(s * 4.7, 0.6, 0.6, 0, TAU); c.fill();
    c.strokeStyle = OL; c.lineWidth = 1.3; c.beginPath(); c.moveTo(s * 1.8, -1.2); c.quadraticCurveTo(s * 4.4, -2.6, s * 7.2, -1); c.stroke();
    c.fillStyle = 'rgba(255,120,140,.35)'; c.beginPath(); c.ellipse(s * 6, 5, 1.8, 1, 0, 0, TAU); c.fill();
  }
  c.strokeStyle = '#a0505a'; c.lineWidth = 1; c.beginPath();
  if (dz.energy > 0.5) { c.arc(0, 7, 1.8, 0.1, Math.PI - 0.1); } else { c.moveTo(-1.6, 7.6); c.quadraticCurveTo(0, 8.6, 1.6, 7.6); }
  c.stroke();
  // чёлка и боковые пряди на пружинах
  c.beginPath(); c.moveTo(-11.5, -1); c.quadraticCurveTo(-12, -14, 0, -14.5); c.quadraticCurveTo(12, -14, 11.5, -1);
  c.lineTo(8, -5); c.lineTo(5.5, -1.5); c.lineTo(3, -6); c.lineTo(0, -2.5); c.lineTo(-3, -6.5); c.lineTo(-5.5, -2); c.lineTo(-8.5, -5.5); c.closePath(); dzFill(c, HAIR);
  c.strokeStyle = HAIR2; c.lineWidth = 1.4; c.beginPath(); c.moveTo(-6, -11); c.quadraticCurveTo(0, -13, 5, -11); c.stroke();
  for (const s of [-1, 1]) {
    const sw = dz.hair * 6;
    c.beginPath(); c.moveTo(s * 11, -4); c.quadraticCurveTo(s * 13 + sw * 0.5, 6, s * 11 + sw, 15); c.lineTo(s * 8 + sw * 0.8, 12); c.quadraticCurveTo(s * 9, 4, s * 8.5, -3); c.closePath(); dzFill(c, HAIR);
  }
  c.restore();
  // руки: рукав до локтя, дальше кожа
  for (const [s, e, w] of [[g.ls, g.le, g.lw], [g.rs, g.re, g.rw]]) {
    dzLimb(c, [s, e], 8, SHIRT); dzLimb(c, [e, w], 6, SKIN);
    dzDot(c, w, 3.4, SKIN);
  }
  // «IRIS OUT»: кольцо из пальцев у глаза
  if (p.ring > 0.5) {
    const dl = Math.hypot(g.lw[0] - H[0], g.lw[1] - H[1]), dr = Math.hypot(g.rw[0] - H[0], g.rw[1] - H[1]);
    const hand = dl < dr ? g.lw : g.rw;
    if (Math.min(dl, dr) < 18) {
    c.strokeStyle = OL; c.lineWidth = 2.6; c.beginPath(); c.arc(hand[0], hand[1], 4.2, 0, TAU); c.stroke();
    c.strokeStyle = SKIN; c.lineWidth = 1.4; c.stroke(); }
  }
  if (p.spark > 0) {
    const m = [(g.lw[0] + g.rw[0]) / 2, (g.lw[1] + g.rw[1]) / 2];
    c.strokeStyle = `rgba(255,230,140,${p.spark})`; c.lineWidth = 1.4; c.beginPath();
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU, r0 = 6, r1 = 6 + 7 * p.spark; c.moveTo(m[0] + Math.cos(a) * r0, m[1] + Math.sin(a) * r0); c.lineTo(m[0] + Math.cos(a) * r1, m[1] + Math.sin(a) * r1); }
    c.stroke();
  }
}

function dzDrawWolf(c, g, p, dt) {
  const FUR = '#8e97a8', FUR2 = '#6c7486', BELLY = '#dfe3ea', JEANS = '#34466b', SHOE = '#f2f2f2', OLW = '#1a1d27';
  // хвост — цепочка звеньев, каждое догоняет предыдущее: так и виляет
  const wag = Math.sin(TAU * dz.b * (dz.move === 'shake' ? 2 : 1)) * (0.35 + dz.energy * 0.55);
  if (dz.tail.length !== 8) dz.tail = Array(8).fill(-0.4);
  dz.tail[0] = -0.3 + wag;
  for (let i = 1; i < 8; i++) dz.tail[i] += (dz.tail[i - 1] - dz.tail[i]) * Math.min(1, dt * 14);
  const pts = []; let q = dzAdd(g.pel, [6, 6]);
  for (let i = 0; i < 8; i++) { pts.push(q); const a = dz.tail[i] - i * 0.12; q = dzAdd(q, [Math.cos(a) * 6.5, -Math.sin(a) * 6.5]); }
  const rr = i => 8.5 - i * 0.5;
  c.fillStyle = OLW; pts.forEach((t, i) => { c.beginPath(); c.arc(t[0], t[1], rr(i) + 1.6, 0, TAU); c.fill(); });
  pts.forEach((t, i) => { c.fillStyle = i > 5 ? BELLY : FUR; c.beginPath(); c.arc(t[0], t[1], rr(i), 0, TAU); c.fill(); });
  // ноги в джинсах, кроссовки
  dzLimb(c, [g.lhip, g.lk, g.la], 11, JEANS, OLW); dzLimb(c, [g.rhip, g.rk, g.ra], 11, JEANS, OLW);
  dzShoe(c, g.la, SHOE, -1); dzShoe(c, g.ra, SHOE, 1);
  // торс: мех, светлая грудь
  c.save(); c.translate(g.chest[0], g.chest[1]); c.rotate(g.tl);
  c.beginPath(); c.moveTo(-17, 0); c.quadraticCurveTo(0, -6, 17, 0); c.quadraticCurveTo(15, 24, 12, 46); c.quadraticCurveTo(0, 49, -12, 46); c.quadraticCurveTo(-15, 24, -17, 0); dzFill(c, FUR, OLW);
  c.beginPath(); c.moveTo(-8, 1); c.lineTo(-4, 6); c.lineTo(0, 2); c.lineTo(4, 6); c.lineTo(8, 1); c.quadraticCurveTo(9, 26, 0, 34); c.quadraticCurveTo(-9, 26, -8, 1); c.fillStyle = BELLY; c.fill();
  c.fillStyle = '#26324d'; c.fillRect(-12.5, 40, 25, 6); // пояс джинсов
  c.restore();
  // голова
  const H = g.head, ha = g.tl + g.ht, m = p.muz;
  c.save(); c.translate(H[0], H[1] - m * 1.5); c.rotate(ha); c.scale(1.2, 1.2);
  for (const s of [-1, 1]) {
    const flick = Math.max(0, Math.sin(TAU * dz.b + s)) * 0.12 * dz.energy;
    c.save(); c.translate(s * 7.5, -8); c.rotate(s * (0.18 + flick));
    c.beginPath(); c.moveTo(-4.5, 2); c.lineTo(0, -13); c.lineTo(4.5, 2); c.closePath(); dzFill(c, FUR2, OLW);
    c.beginPath(); c.moveTo(-2.3, 0.5); c.lineTo(0, -8.5); c.lineTo(2.3, 0.5); c.fillStyle = '#d99aa8'; c.fill();
    c.restore();
  }
  c.beginPath(); c.moveTo(-12, -4); c.quadraticCurveTo(-12, -14, 0, -14); c.quadraticCurveTo(12, -14, 12, -4);
  c.lineTo(15, 3); c.lineTo(11, 4); c.lineTo(13, 9); c.quadraticCurveTo(0, 16, -13, 9); c.lineTo(-11, 4); c.lineTo(-15, 3); c.closePath(); dzFill(c, FUR, OLW);
  // морда: при вое уходит вверх, глаза закрываются
  const sy = 5 - m * 5;
  c.beginPath(); c.ellipse(0, sy, 6.8 + m, 5.4 + m * 1.5, 0, 0, TAU); dzFill(c, BELLY, OLW, 1.3);
  for (const s of [-1, 1]) {
    if (m > 0.4) { c.strokeStyle = OLW; c.lineWidth = 1.4; c.beginPath(); c.arc(s * 5, -3, 2, Math.PI * 1.1, Math.PI * 1.9); c.stroke(); }
    else {
      c.beginPath(); c.ellipse(s * 5, -3.5, 2.5, 2.2, s * 0.25, 0, TAU); dzFill(c, '#ffc93c', OLW, 1);
      c.fillStyle = '#111'; c.beginPath(); c.ellipse(s * 5, -3.3, 0.8, 1.6, 0, 0, TAU); c.fill();
    }
    c.strokeStyle = OLW; c.lineWidth = 1.3; c.beginPath(); c.moveTo(s * 2.4, -6.6 - m); c.lineTo(s * 7.6, -7.4 + m); c.stroke();
  }
  c.fillStyle = '#15161c'; c.beginPath(); c.ellipse(0, sy - 2.6 - m, 2.6, 1.8, 0, 0, TAU); c.fill();
  if (m > 0.3) { c.fillStyle = '#5b1f2c'; c.beginPath(); c.ellipse(0, sy + 2.2, 2 * m + 0.6, 2.4 * m, 0, 0, TAU); c.fill(); }
  else { c.strokeStyle = OLW; c.lineWidth = 1; c.beginPath(); c.moveTo(0, sy - 1); c.lineTo(0, sy + 1.5); c.moveTo(-2.5, sy + 2.5); c.quadraticCurveTo(0, sy + 3.6, 2.5, sy + 2.5); c.stroke(); }
  c.restore();
  // руки в меху, лапы темнее
  for (const [s, e, w] of [[g.ls, g.le, g.lw], [g.rs, g.re, g.rw]]) {
    dzLimb(c, [s, e, w], 8.5, FUR, OLW); dzDot(c, w, 4, FUR2);
  }
  if (m > 0.6) {
    c.save(); c.globalAlpha = (m - 0.6) / 0.4; c.fillStyle = '#e8eefc'; c.font = 'italic 700 9px sans-serif'; c.textAlign = 'center';
    c.fillText('А-у-у-у!', H[0] + 26, H[1] - 26 - (dz.b % 4) * 3); c.restore();
  }
}

/* ── сцены ── */
function dzSceneReze(c, W, H, dt, pl, t, floorY) {
  const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0a0f2e'); bg.addColorStop(0.55, '#2b1a4d'); bg.addColorStop(1, '#4a2550');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  if (dz.flash > 0) { c.fillStyle = `rgba(255,200,230,${dz.flash * 0.12})`; c.fillRect(0, 0, W, H); dz.flash = Math.max(0, dz.flash - dt * 2.5); }
  for (const s of dz.stars) { c.fillStyle = `rgba(255,255,255,${0.35 + 0.35 * Math.sin(t * 1.3 + s.f)})`; c.fillRect(s.x, s.y, s.r, s.r); }
  // фейерверк на каждую четвёртую долю (без музыки — изредка)
  const bar = Math.floor(dz.b / 4);
  if ((pl && bar !== dz.lastBurst) || (!pl && Math.random() < dt * 0.15)) {
    dz.lastBurst = bar;
    const x = W * (0.15 + Math.random() * 0.7), y = H * (0.1 + Math.random() * 0.25), hue = Math.floor(Math.random() * 360);
    for (let i = 0; i < 46; i++) { const a = i / 46 * TAU, v = 50 + Math.random() * 60; dz.fw.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, hue: hue + Math.random() * 40 }); }
    if (dz.fw.length > 400) dz.fw.splice(0, dz.fw.length - 400);
    dz.flash = 1;
  }
  c.globalCompositeOperation = 'lighter'; c.lineWidth = 1.6;
  for (const f of dz.fw) {
    f.vy += 38 * dt; f.vx *= 1 - dt * 0.9; f.vy *= 1 - dt * 0.9; f.x += f.vx * dt; f.y += f.vy * dt; f.life -= dt * 0.65;
    if (f.life <= 0) continue;
    c.strokeStyle = `hsla(${f.hue},100%,65%,${f.life})`; c.beginPath(); c.moveTo(f.x, f.y); c.lineTo(f.x - f.vx * 0.06, f.y - f.vy * 0.06); c.stroke();
  }
  dz.fw = dz.fw.filter(f => f.life > 0);
  c.globalCompositeOperation = 'source-over';
  // гирлянда фонариков
  c.strokeStyle = 'rgba(30,15,30,.8)'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, H * 0.42);
  c.quadraticCurveTo(W / 2, H * 0.5, W, H * 0.4); c.stroke();
  for (let i = 1; i < 7; i++) {
    const u = i / 7, x = W * u, y = (1 - u) * (1 - u) * H * 0.42 + 2 * (1 - u) * u * H * 0.5 + u * u * H * 0.4 + 6, sw = Math.sin(t * 1.5 + i) * 2;
    const glow = 0.6 + 0.4 * (pl ? Math.pow(1 - (dz.b % 1), 2) : 0.4);
    c.fillStyle = `rgba(255,120,60,${0.15 * glow})`; c.beginPath(); c.arc(x + sw, y, 13, 0, TAU); c.fill();
    c.fillStyle = i % 2 ? '#e8463a' : '#f29a3a'; c.beginPath(); c.ellipse(x + sw, y, 5, 6.5, 0, 0, TAU); c.fill();
  }
  // холмы и крыши
  c.fillStyle = '#1b1030'; c.beginPath(); c.moveTo(0, floorY - 40);
  c.quadraticCurveTo(W * 0.3, floorY - 70, W * 0.55, floorY - 45); c.quadraticCurveTo(W * 0.8, floorY - 25, W, floorY - 55); c.lineTo(W, H); c.lineTo(0, H); c.fill();
  c.fillStyle = '#130a22'; c.fillRect(0, floorY - 6, W, H - floorY + 6);
}
function dzSceneWolf(c, W, H, dt, pl, t, floorY) {
  const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#050b18'); bg.addColorStop(0.6, '#0f2238'); bg.addColorStop(1, '#0b1a28');
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  for (const s of dz.stars) { c.fillStyle = `rgba(220,235,255,${0.3 + 0.3 * Math.sin(t + s.f)})`; c.fillRect(s.x, s.y, s.r, s.r); }
  const mx = W * 0.27, my = H * 0.16, mr = Math.min(W, H) * 0.09, howl = dz.move === 'howl' && dz.pose ? dz.pose.muz : 0;
  const gl = c.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * (3.2 + howl));
  gl.addColorStop(0, `rgba(220,230,255,${0.25 + howl * 0.2})`); gl.addColorStop(1, 'rgba(220,230,255,0)');
  c.fillStyle = gl; c.fillRect(0, 0, W, H * 0.6);
  c.fillStyle = '#eef1f8'; c.beginPath(); c.arc(mx, my, mr, 0, TAU); c.fill();
  c.fillStyle = 'rgba(160,170,195,.35)'; for (const [dx, dy, r] of [[-0.3, -0.2, 0.22], [0.25, 0.15, 0.16], [-0.05, 0.35, 0.12]]) { c.beginPath(); c.arc(mx + dx * mr, my + dy * mr, r * mr, 0, TAU); c.fill(); }
  // ели в два ряда
  for (const tr of dz.trees) {
    c.fillStyle = tr.far ? '#0d1d2e' : '#081320';
    const base = floorY - (tr.far ? 22 : 0), h = tr.h * (tr.far ? 0.8 : 1);
    for (let k = 0; k < 3; k++) {
      const y0 = base - h * k * 0.28, w = h * (0.32 - k * 0.07);
      c.beginPath(); c.moveTo(tr.x - w, y0); c.lineTo(tr.x, y0 - h * 0.48); c.lineTo(tr.x + w, y0); c.fill();
    }
  }
  c.fillStyle = '#0a1622'; c.fillRect(0, floorY - 4, W, H - floorY + 4);
  // светлячки — вспыхивают на долю
  const pulse = pl ? Math.pow(1 - (dz.b % 1), 2) : 0.3;
  c.globalCompositeOperation = 'lighter';
  for (const f of dz.flies) {
    f.a += dt * 0.6; f.x += Math.cos(f.a + f.f) * f.s * dt; f.y += Math.sin(f.a * 1.3) * f.s * 0.5 * dt;
    if (f.x < 0) f.x += W; if (f.x > W) f.x -= W;
    const al = 0.25 + 0.5 * Math.max(0, Math.sin(t * 2 + f.f)) + 0.3 * pulse;
    const gr = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, 7); gr.addColorStop(0, `rgba(210,255,120,${al})`); gr.addColorStop(1, 'rgba(210,255,120,0)');
    c.fillStyle = gr; c.fillRect(f.x - 7, f.y - 7, 14, 14);
  }
  c.globalCompositeOperation = 'source-over';
}

/* ── кадр ── */
function dancerFrame(now) {
  if (!dz.cv || !dz.cv.isConnected) { dz.raf = 0; return; }
  dz.raf = requestAnimationFrame(dancerFrame);
  if (document.hidden || now - dz.last < 32) return;
  const dt = dz.last ? Math.min(0.1, (now - dz.last) / 1000) : 0.033; dz.last = now;
  const r = dz.cv.getBoundingClientRect();
  if (Math.abs(r.width - dz.w) > 1 || Math.abs(r.height - dz.h) > 1) dancerResize();
  const { playing, heard } = dancerListen(dt, now);
  dzChoreo(playing);
  const W = dz.w, H = dz.h, c = dz.ctx, dpr = dz.dpr, t = now / 1000;
  const cap = $('#muDanceCap');
  if (cap) cap.textContent = !playing ? 'включите трек — потанцуем'
    : `${dz.who === 'reze' ? 'Резе' : 'Волк'} · ${DZ_NAMES[dz.move] || ''} · ${heard ? '' : '≈'}${Math.round(dz.bpm)} BPM`;
  const S = Math.min(W / 150, H / 255), cx = W / 2, floorY = H * 0.87, hipY = floorY - 92 * S;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (dz.who === 'reze') dzSceneReze(c, W, H, dt, playing, t, floorY); else dzSceneWolf(c, W, H, dt, playing, t, floorY);
  // поза: смена движения за долю, тело догоняет цель
  const k = Math.min(1, Math.max(0, dz.b - dz.moveAt));
  let pose = dzPose(dz.move, dz.b, dz.energy);
  if (k < 1) pose = dzLerp(dzPose(dz.prevMove, dz.b, dz.energy), pose, k * k * (3 - 2 * k));
  dz.pose = dz.pose ? dzLerp(dz.pose, pose, 1 - Math.exp(-dt * 16)) : pose;
  const g = dzSkeleton(dz.pose);
  // тень: меньше, когда ноги в воздухе
  const lift = Math.min(dz.pose.lf[1], dz.pose.rf[1]);
  c.fillStyle = `rgba(0,0,0,${0.4 - Math.min(0.25, lift / 60)})`;
  c.beginPath(); c.ellipse(cx + dz.pose.px * S * 0.5, floorY + 2, (30 - Math.min(14, lift)) * S, 5 * S, 0, 0, TAU); c.fill();
  c.setTransform(dpr * S, 0, 0, dpr * S, cx * dpr, hipY * dpr);
  if (dz.who === 'reze') dzDrawReze(c, g, dz.pose, dt); else dzDrawWolf(c, g, dz.pose, dt);
  c.setTransform(1, 0, 0, 1, 0, 0);
}
