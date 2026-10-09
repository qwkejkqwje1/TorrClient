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
  const dpr = Math.min(2, window.devicePixelRatio || 1);
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
    lt: 0.25, lp: 0.35, rt: 0.25, rp: 0.35, lf: [-12, 90], rf: [12, 90] };
  const amp = 0.35 + e;
  if (m === 'idle') {
    p.hx = 4 * s1; p.tilt = -0.04 * s1; p.head = 0.06 * Math.sin(Math.PI * b + 0.6); p.hy = 1.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * b));
    p.lt = 0.18 + 0.05 * s1; p.rt = 0.18 - 0.05 * s1; p.lp = 0.25; p.rp = 0.25;
  } else if (m === 'sway') {
    p.hx = 9 * amp * s1; p.tilt = -0.09 * amp * s1; p.head = 0.12 * Math.sin(Math.PI * b + 0.5);
    p.lt = 0.35 + 0.35 * amp * Math.max(0, Math.sin(Math.PI * b * 0.5)); p.lp = 0.5 + 0.6 * Math.max(0, s1);
    p.rt = 0.35 + 0.35 * amp * Math.max(0, -Math.sin(Math.PI * b * 0.5)); p.rp = 0.5 + 0.6 * Math.max(0, -s1);
    p.lf = [-13 - 3 * Math.max(0, -s1), 90]; p.rf = [13 + 3 * Math.max(0, s1), 90];
  } else if (m === 'wave') {
    p.hx = 7 * amp * s1; p.tilt = -0.06 * s1; p.head = -0.15 * s1;
    p.lt = 2.65 + 0.22 * Math.sin(Math.PI * b * 0.5); p.lp = -0.55 * Math.sin(Math.PI * b);
    p.rt = 2.65 - 0.22 * Math.sin(Math.PI * b * 0.5 + 1); p.rp = 0.55 * Math.sin(Math.PI * b + 1.2);
    p.lf = [-14, 90]; p.rf = [14, 90];
  } else if (m === 'pump') {
    const odd = Math.floor(b) % 2;
    p.hy += 3 * pulse * amp; p.hx = 5 * s1; p.head = 0.18 * pulse * (odd ? 1 : -1);
    p.lt = odd ? 0.9 + 1.3 * pulse * amp : 0.7; p.lp = odd ? 1.9 - 0.6 * pulse : 1.9;
    p.rt = odd ? 0.7 : 0.9 + 1.3 * pulse * amp; p.rp = odd ? 1.9 : 1.9 - 0.6 * pulse;
    const st = Math.max(0, Math.sin(Math.PI * b)) * 7 * amp;
    p.lf = odd ? [-12, 90] : [-12 - st, 90 - st * 0.6]; p.rf = odd ? [12 + st, 90 - st * 0.6] : [12, 90];
  } else if (m === 'vogue') {
    const A = DZ_VOGUE[Math.floor(b) % DZ_VOGUE.length], B = DZ_VOGUE[(Math.floor(b) + DZ_VOGUE.length - 1) % DZ_VOGUE.length];
    const k = Math.min(1, fr * 5), q = k * k * (3 - 2 * k);
    p.lt = B[0] + (A[0] - B[0]) * q; p.lp = B[1] + (A[1] - B[1]) * q; p.rt = B[2] + (A[2] - B[2]) * q; p.rp = B[3] + (A[3] - B[3]) * q;
    p.hx = (Math.floor(b) % 2 ? 8 : -8) * q * amp; p.tilt = (Math.floor(b) % 2 ? -0.1 : 0.1) * q; p.head = (Math.floor(b) % 2 ? 0.2 : -0.2) * q;
    p.lf = [-15, 90]; p.rf = [15, 90];
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

/* ── тело ── */
function dzLimb(c, a, b, r1, r2) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
  c.moveTo(a[0] + nx * r1, a[1] + ny * r1); c.lineTo(b[0] + nx * r2, b[1] + ny * r2);
  c.arc(b[0], b[1], r2, Math.atan2(ny, nx), Math.atan2(ny, nx) + Math.PI, true);
  c.lineTo(a[0] - nx * r1, a[1] - ny * r1);
  c.arc(a[0], a[1], r1, Math.atan2(-ny, -nx), Math.atan2(-ny, -nx) + Math.PI, true);
  c.closePath();
}
function dzIK(h, f, l1, l2, side) {
  let dx = f[0] - h[0], dy = f[1] - h[1], d = Math.hypot(dx, dy);
  const m = l1 + l2 - 0.5; if (d > m) { dx *= m / d; dy *= m / d; d = m; f = [h[0] + dx, h[1] + dy]; }
  const a = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const base = Math.atan2(dy, dx) + side * a;
  return [[h[0] + Math.cos(base) * l1, h[1] + Math.sin(base) * l1], f];
}
function dzRot(p, o, an) { const c = Math.cos(an), s = Math.sin(an), x = p[0] - o[0], y = p[1] - o[1]; return [o[0] + x * c - y * s, o[1] + x * s + y * c]; }
function dzArm(sh, side, t, ph) {
  const a1 = t, a2 = t + ph;
  const el = [sh[0] + side * Math.sin(a1) * 29, sh[1] + Math.cos(a1) * 29];
  return [el, [el[0] + side * Math.sin(a2) * 27, el[1] + Math.cos(a2) * 27]];
}
function dzGeom(p, e) {
  const H = [p.hx, p.hy];
  const up = (x, y) => dzRot([H[0] + x, H[1] + y], H, p.tilt);
  const g = { H, shL: up(-14, -52), shR: up(14, -52), neck: up(0, -58), neckTop: null, waL: up(-8, -28), waR: up(8, -28), buL: up(-12.5, -41), buR: up(12.5, -41) };
  g.headC = dzRot(up(0, -70), g.neck, p.head); g.neckTop = dzRot(up(0, -64), g.neck, p.head);
  // волосы и юбка запаздывают за движением — пружина
  const vx = g.headC[0] - dz.lastHead; dz.lastHead = g.headC[0];
  dz.hairV += (-vx * 0.9 - dz.hair) * 0.25; dz.hairV *= 0.82; dz.hair += dz.hairV;
  dz.skirt += (-vx * 0.6 - dz.skirt) * 0.2;
  g.hipL = [H[0] - 8.5, H[1] + 3]; g.hipR = [H[0] + 8.5, H[1] + 3];
  [g.knL, g.ftL] = dzIK(g.hipL, p.lf, 45, 44, 1); [g.knR, g.ftR] = dzIK(g.hipR, p.rf, 45, 44, -1);
  [g.elL, g.haL] = dzArm(g.shL, -1, p.lt, p.lp); [g.elR, g.haR] = dzArm(g.shR, 1, p.rt, p.rp);
  g.tilt = p.tilt; g.head = p.head; g.fl = 4 + 4 * e;
  return g;
}
// Силуэт рисуется дважды: с запасом по краю — ярко, затем без запаса
// вырезается внутрь. Остаётся единый светящийся контур без швов в суставах
// и полупрозрачное «стекло» внутри.
function dzBodyPass(c, g, grow) {
  const seg = (a, b, w) => { c.lineWidth = w + grow; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); };
  const fillGrow = () => { c.fill(); if (grow) { c.lineWidth = grow; c.stroke(); } };
  seg(g.hipL, g.knL, 11); seg(g.knL, g.ftL, 7); seg(g.hipR, g.knR, 11); seg(g.knR, g.ftR, 7);
  seg(g.ftL, [g.ftL[0] - 5, g.ftL[1] + 2.5], 4); seg(g.ftR, [g.ftR[0] + 5, g.ftR[1] + 2.5], 4);
  seg(g.shL, g.elL, 7); seg(g.elL, g.haL, 5); seg(g.shR, g.elR, 7); seg(g.elR, g.haR, 5);
  seg(g.neck, g.neckTop, 5);
  const H = g.H;
  c.beginPath();
  c.moveTo(g.shL[0], g.shL[1]); c.quadraticCurveTo(g.neck[0], g.neck[1] + 2, g.shR[0], g.shR[1]);
  c.quadraticCurveTo(g.buR[0] + 1.5, g.buR[1], g.waR[0], g.waR[1]); c.quadraticCurveTo(H[0] + 13, H[1] - 10, H[0] + 13, H[1] + 4);
  c.lineTo(H[0] - 13, H[1] + 4); c.quadraticCurveTo(H[0] - 13, H[1] - 10, g.waL[0], g.waL[1]); c.quadraticCurveTo(g.buL[0] - 1.5, g.buL[1], g.shL[0], g.shL[1]);
  c.closePath(); fillGrow();
  c.save(); c.translate(g.headC[0], g.headC[1]); c.rotate(g.tilt + g.head);
  c.beginPath(); c.ellipse(0, 0, 7.5, 9.5, 0, 0, Math.PI * 2); fillGrow(); c.restore();
}
function dzPinkPass(c, g, grow) {
  const H = g.H, sk = dz.skirt, fl = g.fl;
  const fillGrow = () => { c.fill(); if (grow) { c.lineWidth = grow; c.stroke(); } };
  c.beginPath(); c.moveTo(H[0] - 13.5, H[1] - 2); c.lineTo(H[0] - 18 - fl + sk, H[1] + 19); c.quadraticCurveTo(H[0] + sk, H[1] + 24, H[0] + 18 + fl + sk, H[1] + 19); c.lineTo(H[0] + 13.5, H[1] - 2); c.closePath(); fillGrow();
  c.save(); c.translate(g.headC[0], g.headC[1]); c.rotate(g.tilt + g.head);
  const sw = dz.hair;
  c.beginPath();
  c.moveTo(-9.5, 3); c.bezierCurveTo(-13, -17, 13, -17, 9.5, 3);
  c.quadraticCurveTo(11 + sw * 0.5, 9, 10.5 + sw, 14); c.lineTo(5.5 + sw * 0.6, 12.5);
  c.quadraticCurveTo(7.5, 3, 6.5, -4); c.quadraticCurveTo(0, -2.5, -6.5, -5.5);
  c.quadraticCurveTo(-7.5, 4, -5.5 + sw * 0.6, 12.5); c.lineTo(-10.5 + sw, 14); c.quadraticCurveTo(-11 + sw * 0.5, 9, -9.5, 3); c.closePath(); fillGrow();
  c.restore();
}
function dzGroup(tc, setT, g, pass, col, inner) {
  tc.setTransform(1, 0, 0, 1, 0, 0); tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, tc.canvas.width, tc.canvas.height);
  setT(tc); tc.lineCap = 'round'; tc.lineJoin = 'round';
  tc.fillStyle = tc.strokeStyle = col; pass(tc, g, 2.6);
  tc.globalCompositeOperation = 'destination-out'; tc.fillStyle = tc.strokeStyle = `rgba(0,0,0,${1 - inner})`; pass(tc, g, 0);
  tc.globalCompositeOperation = 'source-over';
}
function dzDrawFigure(f, setT, p, e) {
  const g = dzGeom(p, e), tc = dz.tctx;
  dzGroup(tc, setT, g, dzBodyPass, '#8ff4ff', 0.24);
  f.setTransform(1, 0, 0, 1, 0, 0); f.drawImage(dz.tmp, 0, 0);
  dzGroup(tc, setT, g, dzPinkPass, '#ff4fc3', 0.42);
  f.drawImage(dz.tmp, 0, 0);
  // глаза
  setT(f); f.save(); f.translate(g.headC[0], g.headC[1]); f.rotate(g.tilt + g.head);
  f.fillStyle = 'rgba(255,255,255,.9)'; f.fillRect(-4.5, 0, 3, 1); f.fillRect(1.5, 0, 3, 1); f.restore();
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
  const S = Math.min(W / 175, Hh / 245), cx = W / 2, floorY = Hh * 0.86, hipY = floorY - 93 * S;
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
  f.setTransform(1, 0, 0, 1, 0, 0); f.clearRect(0, 0, dz.fig.width, dz.fig.height);
  // смена движения — плавно, за одну долю
  const k = Math.min(1, (dz.b - dz.moveAt) / 1);
  let pose = dzPose(dz.move, dz.b, e);
  if (k < 1) pose = dzLerp(dzPose(dz.prevMove, dz.b, e), pose, k * k * (3 - 2 * k));
  const sp = dz.b - dz.spinAt, spin = sp >= 0 && sp < 2 ? Math.cos(Math.PI * sp) : 1;
  const sx = dpr * S * (Math.abs(spin) < 0.08 ? 0.08 * Math.sign(spin || 1) : spin);
  dzDrawFigure(f, c2 => c2.setTransform(sx, 0, 0, dpr * S, cx * dpr, hipY * dpr), pose, e);
  // развёртка голограммы
  f.setTransform(1, 0, 0, 1, 0, 0); f.globalCompositeOperation = 'destination-out'; f.fillStyle = 'rgba(0,0,0,.35)';
  const step = 3 * dpr, off = (t * 30 * dpr) % step;
  for (let y = off; y < dz.fig.height; y += step) f.fillRect(0, y, dz.fig.width, dpr);
  f.globalCompositeOperation = 'source-over';
  dz.glitch *= Math.pow(0.04, dt);
  const flick = 0.82 + 0.18 * Math.sin(t * 37) * Math.sin(t * 13.3) + (Math.random() < 0.015 ? -0.4 : 0);
  // свечение: уменьшенная копия, растянутая обратно
  const g = dz.gctx; g.clearRect(0, 0, dz.glow.width, dz.glow.height); g.drawImage(dz.fig, 0, 0, dz.glow.width, dz.glow.height);
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.9 * flick * (0.7 + e * 0.6); c.drawImage(dz.glow, 0, 0, dz.cv.width, dz.cv.height);
  c.globalAlpha = Math.max(0.3, flick);
  if (dz.glitch > 0.25) {
    const bands = 6, bh = dz.cv.height / bands;
    for (let i = 0; i < bands; i++) { const dx = (Math.random() - 0.5) * 18 * dpr * dz.glitch; c.drawImage(dz.fig, 0, i * bh, dz.fig.width, bh, dx, i * bh, dz.fig.width, bh); }
    c.globalAlpha = 0.35 * dz.glitch; c.drawImage(dz.fig, 5 * dpr * dz.glitch, 0);
  } else c.drawImage(dz.fig, 0, 0);
  // отражение в мокром полу
  c.globalAlpha = 0.16 * flick; c.save(); c.translate(0, floorY * dpr * 2); c.scale(1, -1); c.drawImage(dz.fig, 0, 0); c.restore();
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  const fade = c.createLinearGradient(0, floorY * dpr, 0, dz.cv.height); fade.addColorStop(0, 'rgba(3,3,8,0)'); fade.addColorStop(1, 'rgba(3,3,8,.9)');
  c.fillStyle = fade; c.fillRect(0, floorY * dpr, dz.cv.width, dz.cv.height);
  dz.cost = dz.cost * 0.95 + (performance.now() - t0) * 0.05;
}
