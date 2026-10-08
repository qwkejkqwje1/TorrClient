/* ================= ЭФФЕКТЫ: ЗВЕЗДОПАД, ВАРП, РЕТРО =================
   Фон рисуется одним <canvas> под содержимым. Для «Графита» это тихое
   звёздное небо с редкими падающими звёздами, для «Денди» — пиксельные звёзды,
   плывущие вниз, как в космической стрелялке на приставке. Варп-прыжок —
   полноэкранная вспышка звёздных лучей при запуске просмотра и фон окна
   подготовки, пока раздача ищет раздающих.
   Всё выключается одной галочкой в Настройках и само молчит при «уменьшить
   движение» в системе и в свёрнутом окне — анимация не должна есть батарею. */

const FX_KEY = 'tc_fx';
function fxOn() {
  if (localStorage.getItem(FX_KEY) === '0') return false;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch {}
  return true;
}
const fx = { cv: null, ctx: null, stars: [], shoot: [], raf: 0, mode: '', last: 0, w: 0, h: 0, dpr: 1 };
function fxMode() {
  const th = document.documentElement.dataset.theme;
  if (th === 'retro') return 'pixel';
  if (th === 'dark' || th === 'oled') return 'sky';
  return '';
}
function fxResize() {
  if (!fx.cv) return;
  fx.dpr = Math.min(2, window.devicePixelRatio || 1);
  fx.w = window.innerWidth; fx.h = window.innerHeight;
  fx.cv.width = Math.round(fx.w * fx.dpr); fx.cv.height = Math.round(fx.h * fx.dpr);
  fx.ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
  fxSeed();
}
function fxSeed() {
  const n = Math.round(Math.min(220, fx.w * fx.h / 9000));
  fx.stars = Array.from({ length: n }, () => ({ x: Math.random() * fx.w, y: Math.random() * fx.h, z: Math.random(), tw: Math.random() * Math.PI * 2 }));
  fx.shoot = [];
}
const RETRO_PAL = ['#fcfcfc', '#3cbcfc', '#f8b800', '#f83800', '#58d854', '#fc74b4'];
function fxFrame(ts) {
  fx.raf = 0;
  if (!fx.cv || !fx.mode || document.hidden) return;
  // 30 кадров в секунду достаточно для неба и вдвое дешевле.
  if (ts - fx.last < 32) { fx.raf = requestAnimationFrame(fxFrame); return; }
  const dt = Math.min(0.1, (ts - (fx.last || ts)) / 1000); fx.last = ts;
  const c = fx.ctx; c.clearRect(0, 0, fx.w, fx.h);
  if (fx.mode === 'sky') {
    for (const s of fx.stars) {
      s.tw += dt * (0.6 + s.z * 1.8);
      const a = 0.18 + 0.5 * s.z * (0.6 + 0.4 * Math.sin(s.tw));
      c.fillStyle = 'rgba(200,220,255,' + a.toFixed(3) + ')';
      const r = 0.4 + s.z * 1.1;
      c.beginPath(); c.arc(s.x, s.y, r, 0, 6.283); c.fill();
    }
    // Звездопад: падающая звезда раз в несколько секунд, иногда — две.
    if (Math.random() < dt * 0.35) {
      const ang = Math.PI * (0.18 + Math.random() * 0.14);
      fx.shoot.push({ x: Math.random() * fx.w * 1.1, y: -20 + Math.random() * fx.h * 0.4, vx: -Math.cos(ang) * 620, vy: Math.sin(ang) * 620, life: 0, max: 0.9 + Math.random() * 0.7 });
    }
    fx.shoot = fx.shoot.filter(s => (s.life += dt) < s.max);
    for (const s of fx.shoot) {
      s.x += s.vx * dt; s.y += s.vy * dt;
      const k = 1 - s.life / s.max;
      const g = c.createLinearGradient(s.x, s.y, s.x - s.vx * 0.16, s.y - s.vy * 0.16);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * k).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(124,176,255,0)');
      c.strokeStyle = g; c.lineWidth = 1.6; c.lineCap = 'round';
      c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x - s.vx * 0.16, s.y - s.vy * 0.16); c.stroke();
    }
  } else if (fx.mode === 'pixel') {
    for (const s of fx.stars) {
      s.y += dt * (12 + s.z * 70);
      if (s.y > fx.h) { s.y = -4; s.x = Math.random() * fx.w; }
      const sz = s.z > 0.85 ? 3 : s.z > 0.5 ? 2 : 1;
      s.tw += dt * 3;
      c.globalAlpha = s.z > 0.85 && Math.sin(s.tw) < -0.6 ? 0.25 : 0.35 + s.z * 0.5;
      c.fillStyle = RETRO_PAL[Math.floor(s.z * 97) % RETRO_PAL.length];
      c.fillRect(Math.round(s.x), Math.round(s.y), sz, sz);
    }
    c.globalAlpha = 1;
  }
  fx.raf = requestAnimationFrame(fxFrame);
}
function fxApply() {
  const mode = fxOn() ? fxMode() : '';
  fx.mode = mode;
  if (!mode) { if (fx.cv) { fx.cv.remove(); fx.cv = null; } return; }
  if (!fx.cv) {
    fx.cv = document.createElement('canvas'); fx.cv.id = 'fxSky'; fx.cv.setAttribute('aria-hidden', 'true');
    document.body.prepend(fx.cv);
    fx.ctx = fx.cv.getContext('2d');
    fxResize();
  }
  if (!fx.raf) fx.raf = requestAnimationFrame(fxFrame);
}

/* ---- варп-прыжок ----
   fxWarp(ms) — короткий прыжок: лучи из центра разгоняются и гаснут вспышкой.
   fxWarpCruise() — фон окна подготовки, пока раздача ищет раздающих: лучи
   идут ровно, а на выходе — тот же разгон. Возвращает функцию остановки. */
function fxWarpCanvas() {
  const cv = document.createElement('canvas'); cv.className = 'fx-warp';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.body.appendChild(cv);
  const retro = document.documentElement.dataset.theme === 'retro';
  const N = retro ? 160 : 340;
  const st = Array.from({ length: N }, () => ({ a: Math.random() * 6.283, d: Math.random() * 0.9 + 0.02, s: Math.random() * 0.7 + 0.3, col: RETRO_PAL[Math.floor(Math.random() * RETRO_PAL.length)] }));
  return { cv, c, w, h, st, retro };
}
function fxWarpRun(o, speedAt, total, onEnd) {
  const { c, w, h, st, retro } = o;
  const cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
  let t0 = 0, raf = 0, stopped = false;
  const frame = ts => {
    if (stopped) return;
    if (!t0) t0 = ts;
    const t = (ts - t0) / 1000;
    const v = speedAt(t);
    // Хвост от прошлых кадров: лучи тянутся, а не мигают.
    c.fillStyle = retro ? 'rgba(0,0,0,.5)' : 'rgba(2,4,12,' + (v > 2 ? 0.28 : 0.45) + ')';
    c.fillRect(0, 0, w, h);
    for (const s of st) {
      const d0 = s.d;
      s.d += (0.004 + s.d * 0.9) * v * s.s * 0.05;
      if (s.d > 1.15) { s.d = 0.02 + Math.random() * 0.05; s.a = Math.random() * 6.283; continue; }
      const r0 = d0 * R, r1 = s.d * R;
      const x0 = cx + Math.cos(s.a) * r0, y0 = cy + Math.sin(s.a) * r0;
      const x1 = cx + Math.cos(s.a) * r1, y1 = cy + Math.sin(s.a) * r1;
      if (retro) {
        c.fillStyle = s.col;
        const n = Math.max(1, Math.round((r1 - r0) / 6));
        for (let i = 0; i <= n; i++) { const k = i / n; c.fillRect(Math.round((x0 + (x1 - x0) * k) / 3) * 3, Math.round((y0 + (y1 - y0) * k) / 3) * 3, 3, 3); }
      } else {
        const a = Math.min(1, 0.25 + s.d);
        c.strokeStyle = 'rgba(' + (190 + Math.round(65 * s.s)) + ',' + (215 + Math.round(40 * s.s)) + ',255,' + a.toFixed(2) + ')';
        c.lineWidth = 0.6 + s.d * 2.2;
        c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      }
    }
    if (total && t >= total) { stop(); if (onEnd) onEnd(); return; }
    raf = requestAnimationFrame(frame);
  };
  const stop = () => { stopped = true; cancelAnimationFrame(raf); };
  raf = requestAnimationFrame(frame);
  return stop;
}
function fxFlash(retro) {
  const f = document.createElement('div'); f.className = 'fx-flash' + (retro ? ' retro' : '');
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 700);
}
let warpBusy = false;
function fxWarp(ms) {
  if (!fxOn() || warpBusy) return;
  warpBusy = true;
  const o = fxWarpCanvas();
  const T = (ms || 1100) / 1000;
  // Разгон: сначала звёзды стоят, потом рывок — как переход в гиперпространство.
  fxWarpRun(o, t => 0.4 + Math.pow(t / T, 3) * 28, T, () => {
    fxFlash(o.retro);
    o.cv.classList.add('out');
    setTimeout(() => { o.cv.remove(); warpBusy = false; }, 380);
  });
}
function fxWarpCruise(host) {
  if (!fxOn()) return () => {};
  const o = fxWarpCanvas();
  o.cv.classList.add('cruise');
  if (host) host.classList.add('warp-host');
  let boost = 0;
  let stop = fxWarpRun(o, () => 2.2 + boost, 0);
  return ok => {
    stop();
    if (!ok) { o.cv.classList.add('out'); setTimeout(() => o.cv.remove(), 380); return; }
    stop = fxWarpRun(o, t => 2.2 + Math.pow(t / 0.6, 3) * 26, 0.6, () => { fxFlash(o.retro); o.cv.classList.add('out'); setTimeout(() => o.cv.remove(), 380); });
  };
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
  // Тема меняется в одном месте — applyTheme; небо следует за ней.
  new MutationObserver(() => fxApply()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
