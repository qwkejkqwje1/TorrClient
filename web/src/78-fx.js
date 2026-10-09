/* ================= ЭФФЕКТЫ: ФОН ТЕМЫ И АНИМАЦИЯ ЗАПУСКА =================
   Фон рисуется одним <canvas> под содержимым, у каждой темы свой:
   «Графит» — звёздное небо со звездопадом, «Денди» — пиксельные звёзды,
   «Матрица» — зелёный дождь символов, «Кибер-неон» — сетка до горизонта,
   «Японский сад» — лепестки сакуры, «Девятый вал» — небо мазками Ван Гога
   над морем Айвазовского.
   Анимация запуска — отдельно: у темы есть своя, но в Настройках можно
   поставить любую или случайную. Она играет за окном ожидания, пока раздача
   ищет раздающих, и коротким разгоном при запуске плеера.
   Расход: фон — 20–30 кадров в секунду, на кадр уходит доли миллисекунды
   (fx.cost — скользящее среднее). Свёрнутое окно не рисуется вовсе, а при
   «уменьшить движение» в системе и по галочке в Настройках фон выключается. */

const FX_KEY = 'tc_fx';
const FXL_KEY = 'tc_fxl';
function fxOn() {
  if (localStorage.getItem(FX_KEY) === '0') return false;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch {}
  return true;
}
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const RETRO_PAL = ['#fcfcfc', '#3cbcfc', '#f8b800', '#f83800', '#58d854', '#fc74b4'];
const MATRIX_CH = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789';

/* ---------- фоны ---------- */
const BG = {};
// Звёздное небо. Падающая звезда появляется в случайный момент (между
// звёздами — случайная пауза, в среднем 7 с), в случайном месте и летит в
// случайную сторону вниз; иногда — две-три подряд.
BG.sky = {
  fps: 30,
  seed(s) {
    s.stars = Array.from({ length: Math.round(Math.min(220, s.w * s.h / 9000)) }, () => ({ x: Math.random() * s.w, y: Math.random() * s.h, z: Math.random(), tw: Math.random() * 6.28 }));
    s.shoot = []; s.next = rnd(1.5, 8);
  },
  draw(s, c, dt, t) {
    c.clearRect(0, 0, s.w, s.h);
    for (const p of s.stars) {
      p.tw += dt * (0.6 + p.z * 1.8);
      c.fillStyle = 'rgba(200,220,255,' + (0.18 + 0.5 * p.z * (0.6 + 0.4 * Math.sin(p.tw))).toFixed(3) + ')';
      c.beginPath(); c.arc(p.x, p.y, 0.4 + p.z * 1.1, 0, 6.283); c.fill();
    }
    if ((s.next -= dt) <= 0) {
      const n = Math.random() < 0.15 ? 2 + (Math.random() < 0.4 ? 1 : 0) : 1;
      for (let i = 0; i < n; i++) {
        const ang = rnd(0.08, 0.92) * Math.PI; // любая сторона вниз
        const sp = rnd(320, 900);
        s.shoot.push({ x: rnd(0, s.w), y: rnd(-20, s.h * 0.75), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, len: rnd(0.08, 0.22), w: rnd(0.8, 2.2), a: rnd(0.5, 1), life: -i * rnd(0.15, 0.5), max: rnd(0.45, 1.4) });
      }
      // Экспоненциальная пауза: моменты непредсказуемы, но в среднем ~7 с.
      s.next = Math.min(25, Math.max(0.8, -Math.log(1 - Math.random()) * 7));
    }
    s.shoot = s.shoot.filter(p => (p.life += dt) < p.max);
    for (const p of s.shoot) {
      if (p.life < 0) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const k = Math.min(1, p.life / 0.12) * (1 - p.life / p.max);
      const tx = p.x - p.vx * p.len, ty = p.y - p.vy * p.len;
      const g = c.createLinearGradient(p.x, p.y, tx, ty);
      g.addColorStop(0, 'rgba(255,255,255,' + (p.a * k).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(124,176,255,0)');
      c.strokeStyle = g; c.lineWidth = p.w; c.lineCap = 'round';
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(tx, ty); c.stroke();
    }
  },
};
BG.pixel = {
  fps: 30,
  seed(s) { s.stars = Array.from({ length: Math.round(Math.min(200, s.w * s.h / 9000)) }, () => ({ x: Math.random() * s.w, y: Math.random() * s.h, z: Math.random(), tw: Math.random() * 6 })); },
  draw(s, c, dt) {
    c.clearRect(0, 0, s.w, s.h);
    for (const p of s.stars) {
      p.y += dt * (12 + p.z * 70);
      if (p.y > s.h) { p.y = -4; p.x = Math.random() * s.w; }
      const sz = p.z > 0.85 ? 3 : p.z > 0.5 ? 2 : 1;
      p.tw += dt * 3;
      c.globalAlpha = p.z > 0.85 && Math.sin(p.tw) < -0.6 ? 0.25 : 0.35 + p.z * 0.5;
      c.fillStyle = RETRO_PAL[Math.floor(p.z * 97) % RETRO_PAL.length];
      c.fillRect(Math.round(p.x), Math.round(p.y), sz, sz);
    }
    c.globalAlpha = 1;
  },
};
// Дождь символов. След не перерисовывается: старые символы гаснут сами
// (destination-out), а на кадр рисуется только голова каждой колонки.
BG.rain = {
  fps: 20,
  seed(s) { const n = Math.ceil(s.w / 18); s.cols = Array.from({ length: n }, () => ({ y: rnd(-s.h, s.h), v: rnd(40, 140), on: Math.random() < 0.55 })); },
  draw(s, c, dt) {
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,.09)'; c.fillRect(0, 0, s.w, s.h);
    c.globalCompositeOperation = 'source-over';
    c.font = '15px "MS Gothic","Lucida Console",monospace';
    s.cols.forEach((col, i) => {
      if (!col.on) { if (Math.random() < dt * 0.05) col.on = true; return; }
      const prev = col.y; col.y += col.v * dt;
      if (Math.floor(prev / 18) !== Math.floor(col.y / 18)) {
        c.fillStyle = 'rgba(57,255,122,.32)'; c.fillText(pick(MATRIX_CH), i * 18, prev);
        c.fillStyle = 'rgba(210,255,225,.55)'; c.fillText(pick(MATRIX_CH), i * 18, col.y);
      }
      if (col.y > s.h + 40) { col.y = rnd(-200, 0); col.v = rnd(40, 140); col.on = Math.random() < 0.6; }
    });
  },
};
// Синтвейв: солнце в полосах и сетка, бегущая к зрителю.
function drawNeonScene(s, c, t, speed, alpha) {
  const hz = s.h * 0.64, cx = s.w / 2;
  const sun = c.createLinearGradient(0, hz - s.h * 0.34, 0, hz);
  sun.addColorStop(0, 'rgba(255,214,63,' + alpha + ')'); sun.addColorStop(1, 'rgba(255,43,214,' + alpha + ')');
  c.save(); c.beginPath(); c.arc(cx, hz, s.h * 0.2, Math.PI, 0); c.closePath(); c.clip();
  c.fillStyle = sun; c.fillRect(cx - s.h * 0.2, hz - s.h * 0.2, s.h * 0.4, s.h * 0.2);
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 6; i++) { const y = hz - s.h * 0.012 - i * s.h * 0.028; c.fillRect(0, y, s.w, 2 + i * 0.9); }
  c.restore();
  c.strokeStyle = 'rgba(255,43,214,' + (alpha * 0.9) + ')'; c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(0, hz); c.lineTo(s.w, hz); c.stroke();
  c.strokeStyle = 'rgba(0,240,255,' + (alpha * 0.7) + ')';
  for (let i = -14; i <= 14; i++) { c.beginPath(); c.moveTo(cx + i * 22, hz); c.lineTo(cx + i * s.w * 0.16, s.h); c.stroke(); }
  const off = (t * speed) % 1;
  for (let k = 0; k < 14; k++) { const z = (k + off) / 14; const y = hz + (s.h - hz) * z * z; c.globalAlpha = Math.min(1, z * 2); c.beginPath(); c.moveTo(0, y); c.lineTo(s.w, y); c.stroke(); }
  c.globalAlpha = 1;
}
BG.grid = {
  fps: 30,
  seed(s) { s.stars = Array.from({ length: 70 }, () => ({ x: Math.random() * s.w, y: Math.random() * s.h * 0.6, z: Math.random() })); },
  draw(s, c, dt, t) {
    c.clearRect(0, 0, s.w, s.h);
    for (const p of s.stars) { c.fillStyle = 'rgba(255,200,255,' + (0.15 + p.z * 0.4 * (0.6 + 0.4 * Math.sin(t * 2 + p.x))).toFixed(3) + ')'; c.fillRect(p.x, p.y, 1.4, 1.4); }
    drawNeonScene(s, c, t, 0.35, 0.22);
  },
};
// Лепестки сакуры: падают, кружатся и покачиваются на ветру.
function petal(c, x, y, r, rot, a) {
  c.save(); c.translate(x, y); c.rotate(rot); c.globalAlpha = a;
  c.beginPath(); c.moveTo(0, -r); c.quadraticCurveTo(r * 0.9, -r * 0.2, 0, r); c.quadraticCurveTo(-r * 0.9, -r * 0.2, 0, -r); c.fill();
  c.restore();
}
const PETAL_COL = ['#f6b6c8', '#f2a2b9', '#fbd0dc', '#eb8fab'];
BG.petals = {
  fps: 30,
  seed(s) { s.p = Array.from({ length: Math.round(Math.min(42, s.w / 34)) }, () => ({ x: rnd(0, s.w), y: rnd(-s.h, s.h), r: rnd(4, 9), rot: rnd(0, 6), vr: rnd(-1.5, 1.5), vy: rnd(18, 45), ph: rnd(0, 6), col: pick(PETAL_COL) })); },
  draw(s, c, dt, t) {
    c.clearRect(0, 0, s.w, s.h);
    const wind = Math.sin(t * 0.17) * 22;
    for (const p of s.p) {
      p.y += p.vy * dt; p.x += (wind + Math.sin(t * 1.1 + p.ph) * 18) * dt; p.rot += p.vr * dt;
      if (p.y > s.h + 20) { p.y = -20; p.x = rnd(-40, s.w); }
      if (p.x > s.w + 30) p.x = -20; if (p.x < -40) p.x = s.w + 10;
      c.fillStyle = p.col; petal(c, p.x, p.y, p.r, p.rot, 0.55);
    }
    c.globalAlpha = 1;
  },
};
// «Девятый вал»: вихри неба мазками (Ван Гог), луна в кольцах, а внизу —
// тяжёлые волны с пеной и лунной дорожкой (Айвазовский).
const SEA_STROKE = ['#1d4e89', '#2f6fb3', '#5b93cf', '#8fb8de', '#f2c14e', '#f7e3a1'];
function seaField(s, x, y, t) {
  let a = Math.sin(x * 0.0042 + t * 0.07) * Math.cos(y * 0.006 - t * 0.05) * 1.6;
  for (const v of s.vort) { const dx = x - v.x, dy = y - v.y, d2 = dx * dx + dy * dy; const k = Math.exp(-d2 / (v.r * v.r)); a = a * (1 - k) + (Math.atan2(dy, dx) + Math.PI / 2 * v.dir) * k; }
  return a;
}
function drawSea(s, c, t, top, amp, alpha) {
  const layers = 4;
  for (let L = 0; L < layers; L++) {
    const base = top + (s.h - top) * (L / layers) * 0.85;
    const A = amp * (0.5 + L * 0.35), k = 0.006 + L * 0.0018, sp = 0.5 + L * 0.25;
    const yAt = x => base + A * Math.sin(x * k - t * sp + L * 1.7) + A * 0.35 * Math.sin(x * k * 2.3 + t * sp * 1.4 + L);
    const g = c.createLinearGradient(0, base - A, 0, s.h);
    g.addColorStop(0, 'rgba(' + (28 + L * 6) + ',' + (70 + L * 10) + ',' + (96 + L * 8) + ',' + alpha + ')');
    g.addColorStop(1, 'rgba(4,16,28,' + Math.min(1, alpha + 0.2) + ')');
    c.fillStyle = g; c.beginPath(); c.moveTo(0, s.h);
    for (let x = 0; x <= s.w + 12; x += 12) c.lineTo(x, yAt(x));
    c.lineTo(s.w, s.h); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(235,245,240,' + (alpha * 0.55) + ')'; c.lineWidth = 1.4; c.beginPath();
    for (let x = 0; x <= s.w; x += 12) { const y = yAt(x), y2 = yAt(x + 12); if (y2 < y - 1.5) { c.moveTo(x, y); c.lineTo(x + 12, y2); } }
    c.stroke();
  }
  const mx = s.w * 0.78;
  c.fillStyle = 'rgba(247,227,161,' + (alpha * 0.7) + ')';
  for (let i = 0; i < 26; i++) { const y = top + 6 + i * (s.h - top) / 26, w = 6 + i * 2.2; const x = mx + Math.sin(t * 1.3 + i * 1.7) * w * 0.8; c.fillRect(x - w / 2, y, w, 1.6); }
}
BG.sea = {
  fps: 24,
  seed(s) {
    s.top = s.h * 0.66;
    s.vort = [{ x: s.w * 0.32, y: s.h * 0.24, r: s.h * 0.16, dir: 1 }, { x: s.w * 0.58, y: s.h * 0.4, r: s.h * 0.12, dir: -1 }];
    s.p = Array.from({ length: 240 }, () => ({ x: rnd(0, s.w), y: rnd(0, s.top), life: rnd(0, 4), col: pick(SEA_STROKE) }));
  },
  draw(s, c, dt, t) {
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,.05)'; c.fillRect(0, 0, s.w, s.top);
    c.globalCompositeOperation = 'source-over';
    c.lineCap = 'round'; c.lineWidth = 2.2;
    for (const p of s.p) {
      const a = seaField(s, p.x, p.y, t);
      const nx = p.x + Math.cos(a) * 26 * dt, ny = p.y + Math.sin(a) * 26 * dt;
      c.strokeStyle = p.col; c.globalAlpha = 0.28;
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(nx, ny); c.stroke();
      p.x = nx; p.y = ny;
      if ((p.life -= dt) < 0 || p.x < 0 || p.x > s.w || p.y < 0 || p.y > s.top) { p.x = rnd(0, s.w); p.y = rnd(0, s.top); p.life = rnd(2, 5); }
    }
    c.globalAlpha = 1;
    // Луна в кольцах — как на «Звёздной ночи».
    const mx = s.w * 0.78, my = s.h * 0.17;
    c.clearRect(mx - 70, my - 70, 140, 140);
    for (let i = 4; i >= 1; i--) { c.strokeStyle = 'rgba(247,227,161,' + (0.07 * i) + ')'; c.lineWidth = 3; c.beginPath(); c.arc(mx, my, 18 + i * 11 + Math.sin(t + i) * 1.5, 0, 6.283); c.stroke(); }
    c.fillStyle = 'rgba(247,227,161,.85)'; c.beginPath(); c.arc(mx, my, 16, 0, 6.283); c.fill();
    c.clearRect(0, s.top - 40, s.w, s.h - s.top + 40);
    drawSea(s, c, t, s.top, 9, 0.5);
  },
};
const THEME_BG = { dark: 'sky', oled: 'sky', retro: 'pixel', matrix: 'rain', neon: 'grid', sakura: 'petals', sea: 'sea' };

const fx = { cv: null, ctx: null, raf: 0, mode: '', last: 0, t: 0, s: null, cost: 0 };
function fxMode() { return THEME_BG[document.documentElement.dataset.theme] || ''; }
function fxResize() {
  if (!fx.cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  fx.cv.width = Math.round(w * dpr); fx.cv.height = Math.round(h * dpr);
  fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fx.s = { w, h };
  BG[fx.mode].seed(fx.s);
}
function fxFrame(ts) {
  fx.raf = 0;
  if (!fx.cv || !fx.mode || document.hidden) return;
  const bg = BG[fx.mode];
  if (ts - fx.last < 1000 / bg.fps - 2) { fx.raf = requestAnimationFrame(fxFrame); return; }
  const dt = Math.min(0.1, (ts - (fx.last || ts)) / 1000); fx.last = ts; fx.t += dt;
  const t0 = performance.now();
  bg.draw(fx.s, fx.ctx, dt, fx.t);
  fx.cost = fx.cost * 0.95 + (performance.now() - t0) * 0.05;
  fx.raf = requestAnimationFrame(fxFrame);
}
function fxApply() {
  const mode = fxOn() ? fxMode() : '';
  if (mode !== fx.mode && fx.cv) { fx.cv.remove(); fx.cv = null; }
  fx.mode = mode;
  if (!mode) return;
  if (!fx.cv) {
    fx.cv = document.createElement('canvas'); fx.cv.id = 'fxSky'; fx.cv.setAttribute('aria-hidden', 'true');
    document.body.prepend(fx.cv);
    fx.ctx = fx.cv.getContext('2d');
    fxResize();
  }
  if (!fx.raf) { fx.last = 0; fx.raf = requestAnimationFrame(fxFrame); }
}

/* ---------- анимации запуска ----------
   Каждая — draw(o, c, dt, t, v): v — «скорость», в ожидании ровная, при
   запуске разгоняется. burst — длительность разгона, flash — цвет вспышки. */
const LAUNCH = {};
LAUNCH.warp = {
  name: 'Варп-прыжок', burst: 1.1, flash: '',
  init(o) { o.st = Array.from({ length: o.retro ? 160 : 340 }, () => ({ a: Math.random() * 6.283, d: Math.random() * 0.9 + 0.02, s: Math.random() * 0.7 + 0.3, col: pick(RETRO_PAL) })); },
  draw(o, c, dt, t, v) {
    const { w, h, retro } = o, cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
    c.fillStyle = retro ? 'rgba(0,0,0,.5)' : 'rgba(2,4,12,' + (v > 2 ? 0.28 : 0.45) + ')'; c.fillRect(0, 0, w, h);
    for (const s of o.st) {
      const d0 = s.d; s.d += (0.004 + s.d * 0.9) * v * s.s * 0.05;
      if (s.d > 1.15) { s.d = 0.02 + Math.random() * 0.05; s.a = Math.random() * 6.283; continue; }
      const x0 = cx + Math.cos(s.a) * d0 * R, y0 = cy + Math.sin(s.a) * d0 * R, x1 = cx + Math.cos(s.a) * s.d * R, y1 = cy + Math.sin(s.a) * s.d * R;
      if (retro) { c.fillStyle = s.col; const n = Math.max(1, Math.round((s.d - d0) * R / 6)); for (let i = 0; i <= n; i++) { const k = i / n; c.fillRect(Math.round((x0 + (x1 - x0) * k) / 3) * 3, Math.round((y0 + (y1 - y0) * k) / 3) * 3, 3, 3); } }
      else { c.strokeStyle = 'rgba(' + (190 + Math.round(65 * s.s)) + ',' + (215 + Math.round(40 * s.s)) + ',255,' + Math.min(1, 0.25 + s.d).toFixed(2) + ')'; c.lineWidth = 0.6 + s.d * 2.2; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
    }
  },
};
LAUNCH.matrix = {
  name: 'Матрица', burst: 1.3, flash: 'matrix',
  init(o) { o.cols = Array.from({ length: Math.ceil(o.w / 16) }, () => ({ y: rnd(-o.h, 0), v: rnd(0.6, 1.4) })); o.c.fillStyle = '#000'; o.c.fillRect(0, 0, o.w, o.h); },
  draw(o, c, dt, t, v) {
    c.fillStyle = 'rgba(0,0,0,.12)'; c.fillRect(0, 0, o.w, o.h);
    c.font = 'bold 16px "MS Gothic","Lucida Console",monospace';
    o.cols.forEach((col, i) => {
      const step = col.v * (120 + v * 90) * dt;
      for (let y = col.y; y < col.y + step; y += 16) { c.fillStyle = 'rgba(57,255,122,.85)'; c.fillText(pick(MATRIX_CH), i * 16, y); }
      col.y += step; c.fillStyle = '#e6ffe9'; c.fillText(pick(MATRIX_CH), i * 16, col.y);
      if (col.y > o.h + 20) { col.y = rnd(-120, 0); col.v = rnd(0.6, 1.4); }
    });
  },
};
// Ракорд старой плёнки: круг, перекрестье, бегущий сектор и цифра 3-2-1.
LAUNCH.film = {
  name: 'Киноплёнка', burst: 2.1, flash: 'film',
  init() {},
  draw(o, c, dt, t, v, burst) {
    const { w, h } = o, cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3;
    const fl = 0.92 + Math.random() * 0.08;
    c.fillStyle = 'rgb(' + Math.round(214 * fl) + ',' + Math.round(192 * fl) + ',' + Math.round(150 * fl) + ')'; c.fillRect(0, 0, w, h);
    const per = burst ? burst / 3 : 1;
    const ph = (t % per) / per;
    const num = burst ? Math.max(1, 3 - Math.floor(t / per)) : 3 - Math.floor(t / per) % 3;
    c.fillStyle = 'rgba(70,52,30,.33)'; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R * 1.6, -Math.PI / 2, -Math.PI / 2 + ph * 6.283); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(40,28,14,.85)'; c.lineWidth = 3;
    c.beginPath(); c.arc(cx, cy, R, 0, 6.283); c.stroke();
    c.beginPath(); c.arc(cx, cy, R * 0.82, 0, 6.283); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.moveTo(0, cy); c.lineTo(w, cy); c.moveTo(cx, 0); c.lineTo(cx, h); c.stroke();
    c.fillStyle = 'rgba(30,20,10,.9)'; c.font = 'bold ' + Math.round(R * 1.1) + 'px Georgia,"Times New Roman",serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(num), cx, cy + R * 0.05); c.textAlign = 'start'; c.textBaseline = 'alphabetic';
    // зерно и царапины
    c.fillStyle = 'rgba(40,28,14,.35)';
    for (let i = 0; i < 260; i++) c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    c.fillStyle = 'rgba(255,248,230,.25)';
    for (let i = 0; i < 90; i++) c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    if (Math.random() < 0.7) { c.strokeStyle = 'rgba(40,28,14,.4)'; c.lineWidth = 1; const x = Math.random() * w; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + rnd(-8, 8), h); c.stroke(); }
    const vg = c.createRadialGradient(cx, cy, R * 0.8, cx, cy, Math.hypot(cx, cy));
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(40,24,8,.7)'); c.fillStyle = vg; c.fillRect(0, 0, w, h);
  },
};
LAUNCH.sakura = {
  name: 'Вихрь лепестков', burst: 1.4, flash: 'sakura',
  init(o) { const m = Math.hypot(o.w, o.h) / 2; o.p = Array.from({ length: 180 }, () => ({ a: rnd(0, 6.283), r: rnd(40, m), r0: 0, rot: rnd(0, 6), sz: rnd(5, 12), col: pick(PETAL_COL) })); o.p.forEach(p => { p.r0 = p.r; }); },
  draw(o, c, dt, t, v) {
    c.fillStyle = 'rgba(246,240,228,.38)'; c.fillRect(0, 0, o.w, o.h);
    const cx = o.w / 2, cy = o.h / 2;
    for (const p of o.p) {
      p.a += dt * (0.5 + v * 0.22) * (220 / (p.r + 60));
      p.r = v > 3 ? p.r + dt * v * 40 : p.r0 * (0.75 + 0.25 * Math.sin(t * 0.8 + p.a));
      p.rot += dt * 3;
      c.fillStyle = p.col; petal(c, cx + Math.cos(p.a) * p.r, cy + Math.sin(p.a) * p.r * 0.8, p.sz, p.rot + p.a, 0.85);
    }
    c.globalAlpha = 1;
  },
};
LAUNCH.neon = {
  name: 'Неоновый горизонт', burst: 1.2, flash: 'neon',
  init() {},
  draw(o, c, dt, t, v) {
    c.fillStyle = 'rgba(13,2,33,.55)'; c.fillRect(0, 0, o.w, o.h);
    o.tt = (o.tt || 0) + dt * (0.5 + v * 0.35);
    drawNeonScene(o, c, o.tt, 1, Math.min(1, 0.55 + v * 0.03));
  },
};
LAUNCH.wave = {
  name: 'Девятый вал', burst: 1.5, flash: 'sea',
  init() {},
  draw(o, c, dt, t, v, burst) {
    const g = c.createLinearGradient(0, 0, 0, o.h);
    g.addColorStop(0, '#08182a'); g.addColorStop(1, '#0f3049'); c.fillStyle = g; c.fillRect(0, 0, o.w, o.h);
    o.tt = (o.tt || 0) + dt * (1 + v * 0.15);
    const k = burst ? Math.min(1, t / burst) : 0;
    // Вал поднимается и накрывает экран к концу разгона.
    drawSea(o, c, o.tt, o.h * (0.62 - 0.75 * k * k), 14 + v * 2.5, 0.95);
  },
};
const LAUNCH_THEME = { matrix: 'matrix', neon: 'neon', sakura: 'sakura', sea: 'wave' };
function launchPref() { const v = localStorage.getItem(FXL_KEY) || 'auto'; return v === 'auto' || v === 'random' || v === 'off' || LAUNCH[v] ? v : 'auto'; }
let launchPick = { k: '', at: 0 };
function launchKind() {
  const p = launchPref();
  if (p === 'off') return '';
  if (p !== 'random' && p !== 'auto') return p;
  // Ожидание и запуск идут подряд — случайный выбор держится десять секунд,
  // чтобы ожидание и разгон были одной анимацией.
  if (launchPick.k && Date.now() - launchPick.at < 10000) return launchPick.k;
  const k = p === 'random' ? pick(Object.keys(LAUNCH)) : LAUNCH_THEME[document.documentElement.dataset.theme] || 'warp';
  launchPick = { k, at: Date.now() };
  return k;
}
function fxLaunchCanvas(kind) {
  const cv = document.createElement('canvas'); cv.className = 'fx-warp fx-' + kind;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.body.appendChild(cv);
  const o = { cv, c, w, h, kind, retro: document.documentElement.dataset.theme === 'retro' };
  LAUNCH[kind].init(o);
  return o;
}
function fxLaunchRun(o, speedAt, total, onEnd) {
  const an = LAUNCH[o.kind];
  let t0 = 0, last = 0, raf = 0, stopped = false;
  const frame = ts => {
    if (stopped) return;
    if (!t0) t0 = last = ts;
    const t = (ts - t0) / 1000, dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    an.draw(o, o.c, dt, t, speedAt(t), total);
    if (total && t >= total) { stop(); if (onEnd) onEnd(); return; }
    raf = requestAnimationFrame(frame);
  };
  const stop = () => { stopped = true; cancelAnimationFrame(raf); };
  raf = requestAnimationFrame(frame);
  return stop;
}
function fxFlash(kind, retro) {
  const f = document.createElement('div'); f.className = 'fx-flash' + (retro ? ' retro' : '') + (kind ? ' ' + kind : '');
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 700);
}
function fxFinish(o) { fxFlash(LAUNCH[o.kind].flash, o.retro); o.cv.classList.add('out'); setTimeout(() => o.cv.remove(), 380); }
let warpBusy = false;
// fxWarp — короткий разгон при запуске плеера (имя прежнее: так его зовёт код).
function fxWarp(kindForce) {
  const kind = kindForce || launchKind();
  if (!kind || !fxLaunchOn() || warpBusy) return;
  warpBusy = true;
  const o = fxLaunchCanvas(kind), T = LAUNCH[kind].burst;
  fxLaunchRun(o, t => 0.4 + Math.pow(t / T, 3) * 28, T, () => { fxFinish(o); setTimeout(() => { warpBusy = false; }, 380); });
}
// fxWarpCruise — фон окна ожидания; возвращает остановку (ok — с разгоном).
function fxWarpCruise(host) {
  const kind = launchKind();
  if (!kind || !fxLaunchOn()) return () => {};
  const o = fxLaunchCanvas(kind);
  o.cv.classList.add('cruise');
  if (host) host.classList.add('warp-host');
  let stop = fxLaunchRun(o, () => 2.2, 0);
  return ok => {
    stop();
    if (!ok) { o.cv.classList.add('out'); setTimeout(() => o.cv.remove(), 380); return; }
    stop = fxLaunchRun(o, t => 2.2 + Math.pow(t / 0.6, 3) * 26, 0.6, () => fxFinish(o));
  };
}
// Анимацию запуска можно оставить и при выключенном фоне — это разные галочки.
function fxLaunchOn() {
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch {}
  return launchPref() !== 'off';
}
function launchSelectHtml() {
  const v = launchPref();
  const opt = (k, l) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`;
  return `<select id="fxLaunch" style="width:auto">${opt('auto', 'Как у темы')}${opt('random', 'Случайная')}${Object.entries(LAUNCH).map(([k, a]) => opt(k, a.name)).join('')}${opt('off', 'Без анимации')}</select> <button id="fxTry" type="button">Показать</button>`;
}
function bindLaunchSelect() {
  const s = $('#fxLaunch'); if (!s) return;
  s.addEventListener('change', () => { savePref(FXL_KEY, s.value); launchPick = { k: '', at: 0 }; });
  const b = $('#fxTry'); if (b) b.addEventListener('click', () => { launchPick = { k: '', at: 0 }; const k = launchKind() || 'warp'; warpBusy = false; fxWarp(k); });
}

/* ---- ретро: включение ЭЛТ при выборе темы ---- */
function fxCrtOn() {
  if (!fxOn()) return;
  document.documentElement.classList.remove('crt-on'); void document.documentElement.offsetWidth;
  document.documentElement.classList.add('crt-on');
  setTimeout(() => document.documentElement.classList.remove('crt-on'), 900);
}

function fxBoot() {
  fxApply();
  window.addEventListener('resize', () => { if (fx.cv) fxResize(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && fx.mode && !fx.raf) { fx.last = 0; fx.raf = requestAnimationFrame(fxFrame); } });
  new MutationObserver(() => fxApply()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
