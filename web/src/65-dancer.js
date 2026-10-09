/* ───────────── музыка: неоновая танцовщица ─────────────
   Голограмма в духе неонового нуара: живёт в разделе «Музыка» и танцует
   под трек, который играет в окне. Звук разбирается Web Audio: по басу
   ищутся удары, из промежутков между ними — темп, к которому подстраивается
   «внутренний метроном». Фигура — скелет с прямой кинематикой рук и
   обратной для ног; движения (покачивание, волна, «качок», вог, вращение)
   меняются каждые 8 долей и зависят от громкости. Рисуется 30 кадров/с
   только пока раздел открыт и окно не свёрнуто; если звук не получен,
   она просто ждёт и покачивается. */
const dz = { cv: null, ctx: null, fig: null, fctx: null, glow: null, gctx: null, raf: 0, last: 0, w: 0, h: 0, dpr: 1,
  b: 0, bpm: 118, onsets: [], lastOn: 0, eMean: 0, eVar: 0, energy: 0, hi: 0, prevE: 0,
  move: 'sway', prevMove: 'sway', moveAt: 0, spinAt: -99, glitch: 0, hair: 0, hairV: 0, skirt: 0, lastHead: 0,
  poseA: null, poseB: null, vogueIx: 0, rain: [], city: [], spec: null, cost: 0 };
function dancerOn() { return localStorage.getItem('tc_dancer') !== '0'; }
function dancerHook() {
  // Подключаемся к звуку один раз: createMediaElementSource можно вызвать
  // на элементе лишь однажды, и дальше звук идёт через AudioContext.
  if (mu.an || !mu.audio || !window.AudioContext) return;
  try {
    const ac = new AudioContext();
    const src = ac.createMediaElementSource(mu.audio);
    const an = ac.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.5;
    src.connect(an); an.connect(ac.destination);
    mu.ac = ac; mu.an = an; dz.spec = new Uint8Array(an.frequencyBinCount);
    mu.audio.addEventListener('play', () => ac.resume().catch(() => {}));
    if (!mu.audio.paused) ac.resume().catch(() => {});
  } catch {}
}
function dancerHtml() {
  return html`<aside class="mu-stage${dancerOn() ? '' : ' off'}" id="muStage">
    <canvas id="muDance"></canvas>
    <button class="iconbtn mu-stage-x" id="muDanceX" title="${dancerOn() ? 'Убрать танцовщицу' : 'Позвать танцовщицу'}">${dancerOn() ? '×' : '💃'}</button>
    <div class="mu-stage-cap" id="muDanceCap"></div>
  </aside>`;
}
function bindDancer() {
  const x = $('#muDanceX'); if (!x) return;
  x.addEventListener('click', () => {
    savePref('tc_dancer', dancerOn() ? '0' : '1');
    const st = $('#muStage'); st.outerHTML = dancerHtml(); bindDancer();
  });
  if (dancerOn()) dancerStart();
}
function dancerStart() {
  const cv = $('#muDance'); if (!cv) return;
  dz.cv = cv; dz.ctx = cv.getContext('2d');
  dz.fig = document.createElement('canvas'); dz.fctx = dz.fig.getContext('2d');
  dz.glow = document.createElement('canvas'); dz.gctx = dz.glow.getContext('2d');
  dz.tmp = document.createElement('canvas'); dz.tctx = dz.tmp.getContext('2d');
  dancerResize();
  cancelAnimationFrame(dz.raf); dz.last = 0;
  dz.raf = requestAnimationFrame(dancerFrame);
}
function dancerResize() {
  const r = dz.cv.getBoundingClientRect();
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  dz.w = Math.max(10, r.width); dz.h = Math.max(10, r.height); dz.dpr = dpr;
  for (const c of [dz.cv, dz.fig, dz.tmp]) { c.width = Math.round(dz.w * dpr); c.height = Math.round(dz.h * dpr); }
  dz.glow.width = Math.ceil(dz.w / 4); dz.glow.height = Math.ceil(dz.h / 4);
  dz.rain = Array.from({ length: 46 }, () => ({ x: Math.random() * dz.w, y: Math.random() * dz.h, l: 8 + Math.random() * 18, v: 260 + Math.random() * 220 }));
  dz.city = Array.from({ length: 22 }, () => ({ x: Math.random() * dz.w, y: dz.h * (0.18 + Math.random() * 0.5), r: 6 + Math.random() * 22, c: Math.random() < 0.5 ? '255,60,170' : Math.random() < 0.5 ? '60,220,255' : '255,170,60', a: 0.05 + Math.random() * 0.12, f: Math.random() * 6 }));
}

/* ── слух: удары баса и темп ── */
function dancerListen(dt, now) {
  const a = mu.audio, playing = a && !a.paused && !a.ended && mu.an;
  let bass = 0, all = 0, hi = 0;
  if (playing) {
    mu.an.getByteFrequencyData(dz.spec);
    const s = dz.spec, n = s.length;
    for (let i = 1; i < 7; i++) bass += s[i];
    for (let i = 0; i < 160; i++) all += s[i];
    for (let i = 160; i < 380; i++) hi += s[i];
    bass /= 6 * 255; all /= 160 * 255; hi /= 220 * 255;
  }
  dz.energy += ((playing ? Math.min(1, all * 1.9) : 0) - dz.energy) * Math.min(1, dt * 3);
  dz.hi += (hi - dz.hi) * Math.min(1, dt * 8);
  // всплеск баса над скользящим средним — удар
  const d = bass - dz.eMean;
  dz.eMean += d * Math.min(1, dt * 2.2); dz.eVar += (d * d - dz.eVar) * Math.min(1, dt * 2.2);
  const rise = bass - dz.prevE; dz.prevE = bass;
  if (playing && bass > 0.32 && d > Math.sqrt(dz.eVar) * 1.15 && rise > 0 && now - dz.lastOn > 260) {
    const gap = now - dz.lastOn; dz.lastOn = now;
    if (gap < 2000) { dz.onsets.push(gap); if (dz.onsets.length > 24) dz.onsets.shift(); }
    if (dz.onsets.length >= 4) {
      const g = dz.onsets.slice().sort((x, y) => x - y)[dz.onsets.length >> 1];
      let bpm = 60000 / g; while (bpm < 85) bpm *= 2; while (bpm > 170) bpm /= 2;
      dz.bpm += (bpm - dz.bpm) * 0.25;
    }
    // подтягиваем фазу метронома к удару
    const fr = dz.b - Math.floor(dz.b);
    dz.b += fr > 0.5 ? (1 - fr) * 0.35 : -fr * 0.35;
    if (d > Math.sqrt(dz.eVar) * 2.6 && dz.energy > 0.35) dz.glitch = 1;
  }
  const tempo = playing ? dz.bpm : 46;
  dz.b += dt * tempo / 60;
  return playing;
}

/* ── хореография ── */
const DZ_VOGUE = [[2.7, 0.3, 0.4, 2.2], [1.6, 1.6, 1.6, 1.6], [0.3, 2.3, 2.9, 0.2], [2.2, 2.0, 2.2, 2.0], [1.2, 0.2, 2.6, 1.9], [2.9, 0.1, 2.9, 0.1]];
function dzPose(m, b, e) {
  const s1 = Math.sin(Math.PI * b), fr = b - Math.floor(b), pulse = Math.pow(1 - fr, 3);
  const p = { hx: 0, hy: 4 * e * (0.5 - 0.5 * Math.cos(2 * Math.PI * b)), tilt: 0, head: 0,
    hr: 0, lw: 0.2, rw: 0.2, lt: 0.22, lp: 0.3, rt: 0.22, rp: 0.3, lf: [-6, 99], rf: [6, 99] };
  const amp = 0.35 + e;
  if (m === 'idle') {
    p.hx = 4 * s1; p.tilt = -0.04 * s1; p.head = 0.06 * Math.sin(Math.PI * b + 0.6); p.hy = 1.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * b));
    p.lt = 0.16 + 0.04 * s1; p.rt = 0.16 - 0.04 * s1; p.lp = 0.22; p.rp = 0.22; p.hr = -0.08 * s1;
  } else if (m === 'sway') {
    p.hx = 9 * amp * s1; p.tilt = -0.09 * amp * s1; p.head = 0.12 * Math.sin(Math.PI * b + 0.5);
    p.lt = 0.35 + 0.35 * amp * Math.max(0, Math.sin(Math.PI * b * 0.5)); p.lp = 0.5 + 0.6 * Math.max(0, s1);
    p.rt = 0.35 + 0.35 * amp * Math.max(0, -Math.sin(Math.PI * b * 0.5)); p.rp = 0.5 + 0.6 * Math.max(0, -s1);
    p.hr = -0.16 * amp * s1; p.lw = 0.5 * Math.max(0, s1); p.rw = 0.5 * Math.max(0, -s1);
    p.lf = [-6 - 3 * Math.max(0, -s1), 99]; p.rf = [6 + 3 * Math.max(0, s1), 99];
  } else if (m === 'wave') {
    p.hx = 7 * amp * s1; p.tilt = -0.06 * s1; p.head = -0.15 * s1;
    p.lt = 2.65 + 0.22 * Math.sin(Math.PI * b * 0.5); p.lp = -0.55 * Math.sin(Math.PI * b);
    p.rt = 2.65 - 0.22 * Math.sin(Math.PI * b * 0.5 + 1); p.rp = 0.55 * Math.sin(Math.PI * b + 1.2);
    p.hr = -0.12 * s1; p.lw = 0.8 * Math.sin(Math.PI * b + 0.8); p.rw = -0.8 * Math.sin(Math.PI * b + 2);
    p.lf = [-8, 99]; p.rf = [8, 99];
  } else if (m === 'pump') {
    const odd = Math.floor(b) % 2;
    p.hy += 3 * pulse * amp; p.hx = 5 * s1; p.head = 0.18 * pulse * (odd ? 1 : -1);
    p.lt = odd ? 0.9 + 1.3 * pulse * amp : 0.7; p.lp = odd ? 1.9 - 0.6 * pulse : 1.9;
    p.rt = odd ? 0.7 : 0.9 + 1.3 * pulse * amp; p.rp = odd ? 1.9 : 1.9 - 0.6 * pulse;
    const st = Math.max(0, Math.sin(Math.PI * b)) * 7 * amp;
    p.hr = (odd ? -0.1 : 0.1) * pulse; p.lw = p.rw = -0.4;
    p.lf = odd ? [-6, 99] : [-6 - st, 99 - st * 0.7]; p.rf = odd ? [6 + st, 99 - st * 0.7] : [6, 99];
  } else if (m === 'vogue') {
    const A = DZ_VOGUE[Math.floor(b) % DZ_VOGUE.length], B = DZ_VOGUE[(Math.floor(b) + DZ_VOGUE.length - 1) % DZ_VOGUE.length];
    const k = Math.min(1, fr * 5), q = k * k * (3 - 2 * k);
    p.lt = B[0] + (A[0] - B[0]) * q; p.lp = B[1] + (A[1] - B[1]) * q; p.rt = B[2] + (A[2] - B[2]) * q; p.rp = B[3] + (A[3] - B[3]) * q;
    p.hx = (Math.floor(b) % 2 ? 8 : -8) * q * amp; p.tilt = (Math.floor(b) % 2 ? -0.1 : 0.1) * q; p.head = (Math.floor(b) % 2 ? 0.2 : -0.2) * q;
    p.hr = (Math.floor(b) % 2 ? -0.14 : 0.14) * q; p.lw = 0.5 * q; p.rw = 0.5 * q;
    p.lf = [-9, 99]; p.rf = [9, 99];
  }
  return p;
}
function dzLerp(a, b, t) {
  const o = {};
  for (const k in a) o[k] = Array.isArray(a[k]) ? [a[k][0] + (b[k][0] - a[k][0]) * t, a[k][1] + (b[k][1] - a[k][1]) * t] : a[k] + (b[k] - a[k]) * t;
  return o;
}
function dzChoreo(playing) {
  const beat = Math.floor(dz.b);
  if (!playing) { if (dz.move !== 'idle') { dz.prevMove = dz.move; dz.move = 'idle'; dz.moveAt = dz.b; } return; }
  if (dz.move === 'idle' || beat - Math.floor(dz.moveAt) >= 8 && beat % 4 === 0 && dz.b - beat < 0.2) {
    const e = dz.energy, pool = e < 0.3 ? ['sway', 'sway', 'wave'] : e < 0.55 ? ['sway', 'wave', 'pump', 'vogue'] : ['pump', 'vogue', 'wave', 'pump'];
    let n = pool[Math.floor(Math.random() * pool.length)];
    if (n === dz.move) n = pool[(pool.indexOf(n) + 1) % pool.length];
    dz.prevMove = dz.move; dz.move = n; dz.moveAt = dz.b;
    if (e > 0.5 && dz.b - dz.spinAt > 24 && Math.random() < 0.45) dz.spinAt = dz.b;
  }
}

/* ── тело ──
   Пропорции «модельные»: голова маленькая, ноги длинные, песочные часы в
   корпусе. Конечности — сужающиеся формы с изгибом икры и бедра, на ногах
   ботфорты на каблуке, длинные волосы — две цепочки с инерцией. */
function dzRot(p, o, an) { const c = Math.cos(an), s = Math.sin(an), x = p[0] - o[0], y = p[1] - o[1]; return [o[0] + x * c - y * s, o[1] + x * s + y * c]; }
function dzIK(h, f, l1, l2, side) {
  let dx = f[0] - h[0], dy = f[1] - h[1], d = Math.hypot(dx, dy);
  const m = l1 + l2 - 0.4; if (d > m) { dx *= m / d; dy *= m / d; d = m; f = [h[0] + dx, h[1] + dy]; }
  const a = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const base = Math.atan2(dy, dx) + side * a;
  return [[h[0] + Math.cos(base) * l1, h[1] + Math.sin(base) * l1], f];
}
function dzArm(sh, side, t, ph, wr) {
  const el = [sh[0] + side * Math.sin(t) * 27, sh[1] + Math.cos(t) * 27];
  const wa = [el[0] + side * Math.sin(t + ph) * 25, el[1] + Math.cos(t + ph) * 25];
  const ha = [wa[0] + side * Math.sin(t + ph + wr) * 8, wa[1] + Math.cos(t + ph + wr) * 8];
  return [el, wa, ha];
}
// сужающаяся конечность a→b: ширина w0→w1, «мышца» bw на доле at длины
function dzTaper(c, a, b, w0, w1, bw, at) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
  const mx = a[0] + dx * at, my = a[1] + dy * at, an = Math.atan2(ny, nx);
  c.moveTo(a[0] + nx * w0, a[1] + ny * w0);
  c.quadraticCurveTo(mx + nx * bw * 1.15, my + ny * bw * 1.15, b[0] + nx * w1, b[1] + ny * w1);
  c.arc(b[0], b[1], w1, an, an + Math.PI, true);
  c.quadraticCurveTo(mx - nx * bw * 1.15, my - ny * bw * 1.15, a[0] - nx * w0, a[1] - ny * w0);
  c.arc(a[0], a[1], w0, an + Math.PI, an, true);
  c.closePath();
}
function dzHair(g, dt) {
  // две пряди-цепочки, привязанные к затылку; Верле с гравитацией
  const N = 8, seg = 6.4;
  if (!dz.hc) dz.hc = [-1, 1].map(sd => Array.from({ length: N }, (_, i) => { const q = [g.H[0] + sd * 7, g.H[1] - 75 + i * seg]; return { p: q, o: q.slice() }; }));
  const k = Math.min(2, dt * 30);
  dz.hc.forEach((ch, si) => {
    const sd = si ? 1 : -1, an = g.toHead([sd * 6.8, -2]);
    ch[0].p = an; ch[0].o = an;
    for (let i = 1; i < N; i++) {
      const q = ch[i], vx = (q.p[0] - q.o[0]) * 0.9, vy = (q.p[1] - q.o[1]) * 0.9;
      q.o = q.p.slice(); q.p = [q.p[0] + vx + sd * 0.05 * k, q.p[1] + vy + 0.55 * k];
    }
    for (let it = 0; it < 3; it++) for (let i = 1; i < N; i++) {
      const A = ch[i - 1].p, B = ch[i].p, dx = B[0] - A[0], dy = B[1] - A[1], d = Math.hypot(dx, dy) || 1, f = seg / d;
      ch[i].p = [A[0] + dx * f, A[1] + dy * f];
      // волосы не проходят сквозь плечи: держатся снаружи шеи
      const o = ch[i].p, cx0 = g.neck[0], minX = 6 + i * 0.9;
      if (sd < 0 && o[0] > cx0 - minX) o[0] = cx0 - minX; if (sd > 0 && o[0] < cx0 + minX) o[0] = cx0 + minX;
    }
  });
}
function dzGeom(p, e, dt) {
  const H = [p.hx, p.hy];
  const up = (x, y) => dzRot([H[0] + x, H[1] + y], H, p.tilt);
  const lo = (x, y) => dzRot([H[0] + x, H[1] + y], H, p.hr);
  const g = { H, up, lo, tilt: p.tilt, head: p.head, e };
  g.shL = up(-12.5, -52); g.shR = up(12.5, -52); g.neck = up(0, -58);
  g.headC = dzRot(up(0, -73), g.neck, p.head); g.neckTop = dzRot(up(0, -65), g.neck, p.head);
  g.toHead = q => { const r = dzRot(q, [0, 0], p.tilt + p.head); return [g.headC[0] + r[0], g.headC[1] + r[1]]; };
  const vx = g.headC[0] - (dz.lastHead == null ? g.headC[0] : dz.lastHead); dz.lastHead = g.headC[0];
  dz.skirt += (-vx * 0.6 - dz.skirt) * 0.2;
  g.hipL = lo(-7.5, 3); g.hipR = lo(7.5, 3);
  [g.knL, g.ftL] = dzIK(g.hipL, p.lf, 49, 48, 1); [g.knR, g.ftR] = dzIK(g.hipR, p.rf, 49, 48, -1);
  [g.elL, g.waL, g.haL] = dzArm(g.shL, -1, p.lt, p.lp, p.lw); [g.elR, g.waR, g.haR] = dzArm(g.shR, 1, p.rt, p.rp, p.rw);
  dzHair(g, dt);
  return g;
}
function dzTorso(c, g) {
  const u = g.up, l = g.lo;
  const P = [u(-3.2, -60), u(-9, -57), u(-12.5, -53), u(-11.6, -45), u(-11.8, -37), l(-7.6, -24), l(-13.8, -8), l(-14, -1), l(-10.5, 8), l(0, 10)];
  c.moveTo(P[0][0], P[0][1]);
  const side = (pts) => {
    c.quadraticCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
    c.lineTo(pts[3][0], pts[3][1]);
    c.quadraticCurveTo(pts[4][0], pts[4][1], pts[4][0] + (pts[5][0] - pts[4][0]) * 0.5, pts[4][1] + (pts[5][1] - pts[4][1]) * 0.5);
    c.quadraticCurveTo(pts[5][0], pts[5][1], pts[5][0] + (pts[6][0] - pts[5][0]) * 0.4, pts[5][1] + (pts[6][1] - pts[5][1]) * 0.4);
    c.quadraticCurveTo(pts[6][0], pts[6][1], pts[7][0], pts[7][1]);
    c.quadraticCurveTo(pts[8][0], pts[8][1], pts[9][0], pts[9][1]);
  };
  side(P);
  const Q = [u(3.2, -60), u(9, -57), u(12.5, -53), u(11.6, -45), u(11.8, -37), l(7.6, -24), l(13.8, -8), l(14, -1), l(10.5, 8), l(0, 10)].reverse();
  c.quadraticCurveTo(Q[1][0], Q[1][1], Q[2][0], Q[2][1]);
  c.quadraticCurveTo(Q[3][0], Q[3][1], Q[3][0] + (Q[4][0] - Q[3][0]) * 0.6, Q[3][1] + (Q[4][1] - Q[3][1]) * 0.6);
  c.quadraticCurveTo(Q[4][0], Q[4][1], Q[4][0] + (Q[5][0] - Q[4][0]) * 0.5, Q[4][1] + (Q[5][1] - Q[4][1]) * 0.5);
  c.quadraticCurveTo(Q[5][0], Q[5][1], Q[6][0], Q[6][1]);
  c.lineTo(Q[7][0], Q[7][1]);
  c.quadraticCurveTo(Q[8][0], Q[8][1], Q[9][0], Q[9][1]);
  c.closePath();
}
function dzHeadPath(c, g) {
  c.save(); c.translate(g.headC[0], g.headC[1]); c.rotate(g.tilt + g.head);
  c.moveTo(0, -9.6); c.bezierCurveTo(7.8, -9.6, 7.6, 3, 0, 9.4); c.bezierCurveTo(-7.6, 3, -7.8, -9.6, 0, -9.6);
  c.restore();
}
function dzBodyPass(c, g, grow) {
  const fill = () => { c.fill(); if (grow) { c.lineWidth = grow; c.stroke(); } };
  c.beginPath();
  dzTaper(c, g.hipL, g.knL, 7.2, 3.9, 7.4, 0.28); dzTaper(c, g.knL, g.ftL, 3.9, 2.1, 4.4, 0.3);
  dzTaper(c, g.hipR, g.knR, 7.2, 3.9, 7.4, 0.28); dzTaper(c, g.knR, g.ftR, 3.9, 2.1, 4.4, 0.3);
  dzTaper(c, g.shL, g.elL, 3.7, 2.5, 3.6, 0.3); dzTaper(c, g.elL, g.waL, 2.5, 1.7, 2.6, 0.25); dzTaper(c, g.waL, g.haL, 1.8, 1, 2.1, 0.45);
  dzTaper(c, g.shR, g.elR, 3.7, 2.5, 3.6, 0.3); dzTaper(c, g.elR, g.waR, 2.5, 1.7, 2.6, 0.25); dzTaper(c, g.waR, g.haR, 1.8, 1, 2.1, 0.45);
  dzTaper(c, g.neck, g.neckTop, 2.8, 2.5, 2.5, 0.5);
  dzTorso(c, g); dzHeadPath(c, g);
  fill();
}
function dzOutfitPass(c, g, grow) {
  const fill = () => { c.fill(); if (grow) { c.lineWidth = grow; c.stroke(); } };
  // ботфорты выше колена, каблук-шпилька
  c.beginPath();
  for (const [hp, kn, ft, sd] of [[g.hipL, g.knL, g.ftL, -1], [g.hipR, g.knR, g.ftR, 1]]) {
    const top = [kn[0] + (hp[0] - kn[0]) * 0.22, kn[1] + (hp[1] - kn[1]) * 0.22];
    dzTaper(c, top, kn, 4.6, 4.1, 4.4, 0.5); dzTaper(c, kn, ft, 4.1, 2.4, 4.6, 0.3);
    c.moveTo(ft[0] - sd * 2.4, ft[1] - 1); c.lineTo(ft[0] + sd * 4.5, ft[1] + 7.5); c.lineTo(ft[0] + sd * 3, ft[1] + 8); c.lineTo(ft[0] - sd * 0.5, ft[1] + 3.2); c.lineTo(ft[0] - sd * 2.2, ft[1] + 8); c.lineTo(ft[0] - sd * 2.9, ft[1] + 7.8); c.closePath();
  }
  fill();
  // бюстье: по силуэту корпуса, низ — дугой под грудью
  c.save(); c.beginPath(); dzTorso(c, g); c.clip();
  const u = g.up, l = g.lo;
  c.beginPath();
  c.moveTo(...u(-16, -50)); c.quadraticCurveTo(...u(-6, -53), ...u(0, -46)); c.quadraticCurveTo(...u(6, -53), ...u(16, -50));
  c.lineTo(...u(16, -34)); c.quadraticCurveTo(...u(0, -30), ...u(-16, -34)); c.closePath(); fill();
  c.restore();
  // юбка-клёш от талии, подол летит за движением
  const sk = dz.skirt, fl = 3 + 5 * g.e;
  c.beginPath();
  c.moveTo(...l(-9.5, -19)); c.quadraticCurveTo(...l(0, -17.5), ...l(9.5, -19));
  c.quadraticCurveTo(...l(15, -6), ...l(19 + fl + sk, 17));
  c.quadraticCurveTo(...l(sk * 0.5, 21), ...l(-19 - fl + sk, 17));
  c.quadraticCurveTo(...l(-15, -6), ...l(-9.5, -19)); c.closePath(); fill();
  // чокер
  c.beginPath(); const n1 = dzRot(g.up(0, -60.6), g.neck, g.head); c.ellipse(n1[0], n1[1], 2.9, 0.55, g.tilt, 0, Math.PI * 2); fill();
}
function dzHairBackPass(c, g, grow) {
  const [L, R] = dz.hc, fill = () => { c.fill(); if (grow) { c.lineWidth = grow; c.stroke(); } };
  c.beginPath();
  c.moveTo(L[0].p[0], L[0].p[1]);
  for (let i = 1; i < L.length; i++) { const m = [(L[i - 1].p[0] + L[i].p[0]) / 2 - 2.2, (L[i - 1].p[1] + L[i].p[1]) / 2]; c.quadraticCurveTo(L[i - 1].p[0] - 2.4, L[i - 1].p[1], m[0], m[1]); }
  const lt = L[L.length - 1].p, rt = R[R.length - 1].p;
  c.quadraticCurveTo((lt[0] + rt[0]) / 2, Math.max(lt[1], rt[1]) + 4, rt[0] + 2, rt[1]);
  for (let i = R.length - 1; i > 0; i--) { const m = [(R[i - 1].p[0] + R[i].p[0]) / 2 + 2.2, (R[i - 1].p[1] + R[i].p[1]) / 2]; c.quadraticCurveTo(R[i].p[0] + 2.4, R[i].p[1], m[0], m[1]); }
  c.lineTo(R[0].p[0], R[0].p[1]);
  const h = g.toHead; c.bezierCurveTo(...h([10, -9]), ...h([6, -12.5]), ...h([0, -12])); c.bezierCurveTo(...h([-6, -12.5]), ...h([-10, -9]), L[0].p[0], L[0].p[1]);
  c.closePath(); fill();
}
function dzHairFrontPass(c, g, grow) {
  const fill = () => { c.fill(); if (grow) { c.lineWidth = grow; c.stroke(); } };
  c.save(); c.translate(g.headC[0], g.headC[1]); c.rotate(g.tilt + g.head);
  // косая чёлка и пряди у лица
  c.beginPath();
  c.moveTo(-8.4, 4); c.bezierCurveTo(-11, -14, 9, -16, 8.4, 1);
  c.quadraticCurveTo(8.8, 7, 7.6, 12); c.quadraticCurveTo(6.4, 4, 6.2, -2.5);
  c.quadraticCurveTo(1, -2.4, -4.5, -6.2); c.quadraticCurveTo(-6.3, -1, -6.4, 6);
  c.quadraticCurveTo(-7, 9, -7.8, 12); c.quadraticCurveTo(-8.6, 8, -8.4, 4); c.closePath(); fill();
  c.restore();
}
function dzGroup(tc, setT, g, pass, col, inner) {
  tc.setTransform(1, 0, 0, 1, 0, 0); tc.globalCompositeOperation = 'source-over'; const [bx, by, bw, bh] = dz.bb; tc.clearRect(bx, by, bw, bh);
  setT(tc); tc.lineCap = 'round'; tc.lineJoin = 'round';
  tc.fillStyle = tc.strokeStyle = col; pass(tc, g, 2.2);
  tc.globalCompositeOperation = 'destination-out'; tc.fillStyle = tc.strokeStyle = `rgba(0,0,0,${1 - inner})`; pass(tc, g, 0);
  tc.globalCompositeOperation = 'source-over';
}
function dzBodyGrad(c) { const gr = c.createLinearGradient(0, -85, 0, 100); gr.addColorStop(0, '#a8f7ff'); gr.addColorStop(0.45, '#7fd8ff'); gr.addColorStop(1, '#a98bff'); return gr; }
function dzPinkGrad(c) { const gr = c.createLinearGradient(0, -85, 0, 100); gr.addColorStop(0, '#ff5fcf'); gr.addColorStop(1, '#ff3d8b'); return gr; }
function dzDrawFigure(f, setT, p, e, dt) {
  const g = dzGeom(p, e, dt), tc = dz.tctx;
  const [bx, by, bw, bh] = dz.bb;
  const put = () => { f.setTransform(1, 0, 0, 1, 0, 0); f.drawImage(dz.tmp, bx, by, bw, bh, bx, by, bw, bh); };
  setT(tc); const hairG = (() => { const gr = tc.createLinearGradient(0, -85, 0, -20); gr.addColorStop(0, '#ff5fd2'); gr.addColorStop(1, '#8f6bff'); return gr; })();
  dzGroup(tc, setT, g, dzHairBackPass, hairG, 0.42); put();
  dzGroup(tc, setT, g, dzBodyPass, dzBodyGrad(tc), 0.22); put();
  dzGroup(tc, setT, g, dzOutfitPass, dzPinkGrad(tc), 0.3); put();
  dzGroup(tc, setT, g, dzHairFrontPass, hairG, 0.55); put();
  // лицо: миндалевидные глаза с ресницами, брови, губы
  setT(f); f.save(); f.translate(g.headC[0], g.headC[1]); f.rotate(g.tilt + g.head);
  f.lineCap = 'round';
  const blink = (dz.b % 7) > 6.85 ? 0.15 : 1;
  for (const sd of [-1, 1]) {
    f.save(); f.scale(sd, 1);
    f.beginPath(); f.moveTo(1.3, 0.6); f.quadraticCurveTo(3, -1.3 * blink, 5, 0.1); f.quadraticCurveTo(3.1, 1.3 * blink, 1.3, 0.6);
    f.fillStyle = 'rgba(235,255,255,.95)'; f.fill();
    f.strokeStyle = 'rgba(255,255,255,.9)'; f.lineWidth = 0.55; f.beginPath(); f.moveTo(4.8, 0); f.lineTo(6, -1.1); f.stroke();
    f.strokeStyle = 'rgba(200,240,255,.55)'; f.lineWidth = 0.5; f.beginPath(); f.moveTo(1.4, -2.2); f.quadraticCurveTo(3.4, -3.3, 5.2, -2); f.stroke();
    f.restore();
  }
  f.strokeStyle = 'rgba(200,240,255,.35)'; f.lineWidth = 0.5; f.beginPath(); f.moveTo(0.2, 1.5); f.quadraticCurveTo(0.9, 3.4, 0, 3.9); f.stroke();
  f.fillStyle = 'rgba(255,90,180,.95)'; f.beginPath(); f.moveTo(-2.3, 5.7); f.quadraticCurveTo(-1, 4.7, 0, 5.2); f.quadraticCurveTo(1, 4.7, 2.3, 5.7); f.quadraticCurveTo(0, 7.4, -2.3, 5.7); f.fill();
  f.restore();
}

/* ── кадр ── */
function dancerFrame(now) {
  if (!dz.cv || !dz.cv.isConnected) { dz.raf = 0; return; }
  dz.raf = requestAnimationFrame(dancerFrame);
  if (document.hidden || now - dz.last < 32) return;
  const dt = dz.last ? Math.min(0.1, (now - dz.last) / 1000) : 0.033; dz.last = now;
  const t0 = performance.now();
  const r = dz.cv.getBoundingClientRect();
  if (Math.abs(r.width - dz.w) > 1 || Math.abs(r.height - dz.h) > 1) dancerResize();
  dancerHook();
  const playing = dancerListen(dt, now);
  dzChoreo(playing);
  const e = dz.energy, t = now / 1000, W = dz.w, Hh = dz.h, c = dz.ctx, dpr = dz.dpr;
  const cap = $('#muDanceCap');
  if (cap) cap.textContent = playing ? Math.round(dz.bpm) + ' BPM' : mu.audio && !mu.audio.paused ? '' : 'включите трек — потанцую';
  // фон: ночной город под дождём
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  const bg = c.createLinearGradient(0, 0, 0, Hh); bg.addColorStop(0, '#05030f'); bg.addColorStop(0.6, '#0a0b22'); bg.addColorStop(1, '#030308');
  c.fillStyle = bg; c.fillRect(0, 0, W, Hh);
  c.globalCompositeOperation = 'lighter';
  for (const o of dz.city) { c.fillStyle = `rgba(${o.c},${o.a * (0.75 + 0.25 * Math.sin(t * 0.7 + o.f))})`; c.beginPath(); c.arc(o.x, o.y, o.r, 0, Math.PI * 2); c.fill(); }
  // спектр полукругом за спиной
  const S = Math.min(W / 175, Hh / 290), cx = W / 2, floorY = Hh * 0.88, hipY = floorY - 106 * S;
  if (playing && dz.spec) {
    const n = 48, R = 62 * S;
    for (let i = 0; i < n; i++) {
      const v = dz.spec[2 + i * 3] / 255, an = Math.PI + (i + 0.5) / n * Math.PI;
      const x1 = cx + Math.cos(an) * R, y1 = hipY - 20 * S + Math.sin(an) * R, L = 4 + v * 34 * S;
      c.strokeStyle = `hsla(${300 - i * 2.5},100%,60%,${0.15 + v * 0.5})`; c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x1 + Math.cos(an) * L, y1 + Math.sin(an) * L); c.stroke();
    }
  }
  c.strokeStyle = 'rgba(150,190,255,.22)'; c.lineWidth = 1;
  c.beginPath();
  for (const d of dz.rain) { d.y += d.v * dt; if (d.y > Hh) { d.y = -d.l; d.x = Math.random() * W; } c.moveTo(d.x, d.y); c.lineTo(d.x - d.l * 0.12, d.y + d.l); }
  c.stroke();
  // пол: светящийся круг, пульсирует на долю
  const fr = dz.b - Math.floor(dz.b), pulse = playing ? Math.pow(1 - fr, 2) : 0.2;
  c.save(); c.translate(cx, floorY); c.scale(1, 0.22);
  const ring = c.createRadialGradient(0, 0, 10, 0, 0, 70 * S);
  ring.addColorStop(0, `rgba(0,240,255,${0.18 + 0.25 * pulse})`); ring.addColorStop(0.7, `rgba(255,43,214,${0.08 + 0.14 * pulse})`); ring.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = ring; c.beginPath(); c.arc(0, 0, 70 * S, 0, Math.PI * 2); c.fill();
  c.strokeStyle = `rgba(0,240,255,${0.35 + 0.4 * pulse})`; c.lineWidth = 2 / 0.22 * 0.6; c.beginPath(); c.arc(0, 0, (46 + 8 * pulse) * S, 0, Math.PI * 2); c.stroke();
  c.restore();
  // фигура — на отдельном холсте, чтобы наложить развёртку и свечение
  const f = dz.fctx;
  // рамка фигуры: всё тяжёлое делается только внутри неё
  { const x0 = Math.max(0, Math.floor((cx - 95 * S) * dpr)), y0 = Math.max(0, Math.floor((hipY - 110 * S) * dpr));
    dz.bb = [x0, y0, Math.min(dz.fig.width - x0, Math.ceil(190 * S * dpr)), Math.min(dz.fig.height - y0, Math.ceil(225 * S * dpr))]; }
  const [bx, by, bw, bh] = dz.bb;
  f.setTransform(1, 0, 0, 1, 0, 0); f.clearRect(bx, by, bw, bh);
  // смена движения — плавно, за одну долю
  const k = Math.min(1, (dz.b - dz.moveAt) / 1);
  let pose = dzPose(dz.move, dz.b, e);
  if (k < 1) pose = dzLerp(dzPose(dz.prevMove, dz.b, e), pose, k * k * (3 - 2 * k));
  // сглаживание: тело догоняет цель, а не прыгает за ней
  dz.pose = dz.pose ? dzLerp(dz.pose, pose, 1 - Math.exp(-dt * 16)) : pose; pose = dz.pose;
  const sp = dz.b - dz.spinAt, spin = sp >= 0 && sp < 2 ? Math.cos(Math.PI * sp) : 1;
  const sx = dpr * S * (Math.abs(spin) < 0.08 ? 0.08 * Math.sign(spin || 1) : spin);
  dzDrawFigure(f, c2 => c2.setTransform(sx, 0, 0, dpr * S, cx * dpr, hipY * dpr), pose, e, dt);
  // развёртка голограммы
  f.setTransform(1, 0, 0, 1, 0, 0); f.globalCompositeOperation = 'destination-out'; f.fillStyle = 'rgba(0,0,0,.35)';
  const step = 3 * dpr, off = (t * 30 * dpr) % step;
  for (let y = by + off; y < by + bh; y += step) f.fillRect(bx, y, bw, dpr);
  f.globalCompositeOperation = 'source-over';
  dz.glitch *= Math.pow(0.04, dt);
  const flick = 0.82 + 0.18 * Math.sin(t * 37) * Math.sin(t * 13.3) + (Math.random() < 0.015 ? -0.4 : 0);
  // свечение: уменьшенная копия, растянутая обратно
  const g = dz.gctx; g.clearRect(0, 0, dz.glow.width, dz.glow.height); g.drawImage(dz.fig, bx, by, bw, bh, bx / 4 / dpr, by / 4 / dpr, bw / 4 / dpr, bh / 4 / dpr);
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.9 * flick * (0.7 + e * 0.6); c.drawImage(dz.glow, 0, 0, dz.cv.width, dz.cv.height);
  c.globalAlpha = Math.max(0.3, flick);
  if (dz.glitch > 0.25) {
    const bands = 6, bh = dz.cv.height / bands;
    for (let i = 0; i < bands; i++) { const dx = (Math.random() - 0.5) * 18 * dpr * dz.glitch; c.drawImage(dz.fig, 0, i * bh, dz.fig.width, bh, dx, i * bh, dz.fig.width, bh); }
    c.globalAlpha = 0.35 * dz.glitch; c.drawImage(dz.fig, 5 * dpr * dz.glitch, 0);
  } else c.drawImage(dz.fig, bx, by, bw, bh, bx, by, bw, bh);
  // отражение в мокром полу
  c.globalAlpha = 0.16 * flick; c.save(); c.translate(0, floorY * dpr * 2); c.scale(1, -1); c.drawImage(dz.fig, bx, by, bw, bh, bx, by, bw, bh); c.restore();
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  const fade = c.createLinearGradient(0, floorY * dpr, 0, dz.cv.height); fade.addColorStop(0, 'rgba(3,3,8,0)'); fade.addColorStop(1, 'rgba(3,3,8,.9)');
  c.fillStyle = fade; c.fillRect(0, floorY * dpr, dz.cv.width, dz.cv.height);
  dz.cost = dz.cost * 0.95 + (performance.now() - t0) * 0.05;
}
