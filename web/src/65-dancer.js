/* ───────────── аудио: 3D-танцор ─────────────
   На сцене раздела «Аудио» танцует 3D-модель VRM (формат VRoid и витуберов),
   которую пользователь загрузил сам: модели и записи движений лежат в папке
   данных демона (/api/dancer), в программу они не вшиты — у персонажей и
   записей свои авторы и лицензии. Без окна и фона: модель стоит прямо на
   странице, тень под ногами.
   • Слух: удары баса из Web Audio дают темп и фазу «метронома»; если звук
     прочитать нельзя (радио без CORS), танцор держит свой темп ~118 BPM.
   • Встроенные танцы — позы, заданные целями кистей и стоп (обратная
     кинематика на «нормализованном» скелете VRM), меняются на долю; среди них
     «ихвильнихт» по мему с волком. Свои записи (.vrma, .fbx с Mixamo, .bvh)
     переносятся на скелет модели и идут вперемешку со встроенными.
   • three.js и three-vrm (/vrm.js, ~250 КБ сжатыми) грузятся, только когда
     танцор нужен. Рисуется 30 кадров/с, пока раздел открыт и окно видно. */
const dz = { cv: null, raf: 0, last: 0, w: 0, h: 0,
  b: 0, bpm: 118, onsets: [], lastOn: 0, eMean: 0, eVar: 0, energy: 0, prevE: 0, spec: null, bassIx: [1, 6],
  move: 'idle', prevMove: 'idle', moveAt: 0, pose: null, ichAt: 0 };
const DZ_BUILTIN = ['ichwill', 'ichwill', 'iris', 'clap', 'point', 'hop', 'stomp', 'shuffle', 'shake'];
const DZ_LEN = { ichwill: 16 };
const DZ_NAMES = { iris: 'IRIS OUT', clap: 'хлопки', point: 'указка', hop: 'прыжки', howl: 'вой', ichwill: 'ихвильнихт', stomp: 'топот', shuffle: 'шаффл', shake: 'тряска', idle: '' };
// v3 — всё, что касается 3D: модуль, сцена, модель, клипы.
const v3 = { M: null, mod: null, ren: null, scene: null, cam: null, vrm: null, vrmName: '', loading: '', err: '', files: [], filesAt: 0,
  rig: null, mixer: null, clips: {}, action: null, clipName: '', snap: null, snapAt: 0, blinkAt: 0, shadow: null, menu: false };
function dancerOn() { return localStorage.getItem('tc_dancer') !== '0'; }
function dzMix() { const v = localStorage.getItem('tc_dz_mix'); return v === 'builtin' || v === 'mine' ? v : 'all'; }
function dzAnims() { return v3.files.filter(f => f.kind === 'anim'); }
function dzModels() { return v3.files.filter(f => f.kind === 'model'); }
function dzMoveList() {
  const mine = dzAnims().map(f => 'clip:' + f.name), mix = dzMix();
  if (mix === 'mine' && mine.length) return mine;
  if (mix === 'builtin' || !mine.length) return DZ_BUILTIN;
  return DZ_BUILTIN.concat(mine, mine); // свои — почаще
}
function dzMoveLen(m) {
  if (m.startsWith('clip:')) { const c = v3.clips[m.slice(5)]; return c ? Math.max(16, Math.round(c.duration * dz.bpm / 60)) : 4; }
  return DZ_LEN[m] || 8;
}
function dzMoveName(m) { return m.startsWith('clip:') ? m.slice(5).replace(/\.[^.]+$/, '') : DZ_NAMES[m] || ''; }

/* ── сцена в разметке ── */
function dancerHtml() {
  const on = dancerOn();
  if (!on) return html`<aside class="dz-stage off" id="muStage"><button class="iconbtn dz-call" id="muDanceX" title="Позвать танцора">💃</button></aside>`;
  return html`<aside class="dz-stage" id="muStage">
    <canvas id="muDance"></canvas>
    <div class="dz-empty hidden" id="dzEmpty"></div>
    <div class="dz-bar"><span class="dz-cap" id="muDanceCap"></span>
      <button class="iconbtn" id="dzMenuBtn" title="Танцор: модель и движения">⚙</button>
      <button class="iconbtn" id="muDanceX" title="Убрать танцора">×</button></div>
    <div class="dz-menu hidden" id="dzMenu"></div>
    <input type="file" id="dzFile" class="hidden" accept=".vrm,.vrma,.fbx,.bvh" multiple>
  </aside>`;
}
function bindDancer() {
  const st = $('#muStage'); if (!st) return;
  const redraw = () => { const s = $('#muStage'); if (s) { s.outerHTML = dancerHtml(); bindDancer(); } };
  $('#muDanceX').addEventListener('click', () => { savePref('tc_dancer', dancerOn() ? '0' : '1'); v3.menu = false; redraw(); });
  if (!dancerOn()) return;
  $('#dzMenuBtn').addEventListener('click', e => { e.stopPropagation(); v3.menu = !v3.menu; paintDzMenu(); });
  $('#dzFile').addEventListener('change', e => { dzUpload([...e.target.files]); e.target.value = ''; });
  st.addEventListener('click', onDzClick);
  st.addEventListener('change', onDzChange);
  st.addEventListener('dragover', e => { e.preventDefault(); st.classList.add('drop'); });
  st.addEventListener('dragleave', () => st.classList.remove('drop'));
  st.addEventListener('drop', e => { e.preventDefault(); st.classList.remove('drop'); dzUpload([...(e.dataTransfer.files || [])]); });
  dancerStart();
}
function dancerMenuClose() { if (!v3.menu) return false; v3.menu = false; paintDzMenu(); return true; }
document.addEventListener('click', e => { if (v3.menu && !e.target.closest('#dzMenu, #dzMenuBtn')) { v3.menu = false; paintDzMenu(); } });

// Новый трек — новый танец.
function dancerNewTrack() {
  const list = dzMoveList();
  dz.prevMove = dz.move; dz.move = list[Math.floor(Math.random() * list.length)]; dz.moveAt = Math.floor(dz.b);
  if (dz.move === 'ichwill') dz.ichAt = dz.moveAt;
  dz.onsets = [];
  dzMoveStarted();
}
async function dancerStart() {
  const cv = $('#muDance'); if (!cv) return;
  dz.cv = cv;
  await dzLoadFiles();
  const models = dzModels();
  if (!models.length) { dzEmpty(); return; }
  const want = localStorage.getItem('tc_vrm_model'), pick = models.find(f => f.name === want) || models[0];
  try { await dzEnsure3D(); } catch (e) { dzEmpty('Не удалось загрузить 3D: ' + e.message); return; }
  if (!dz.cv || !dz.cv.isConnected) return;
  dzAttachCanvas();
  if (v3.vrmName !== pick.name) await dzLoadModel(pick.name);
  cancelAnimationFrame(dz.raf); dz.last = 0;
  dz.raf = requestAnimationFrame(dancerFrame);
}
async function dzLoadFiles(force) {
  if (!force && Date.now() - v3.filesAt < 5000) return;
  try { v3.files = (await api('/api/dancer')).files || []; v3.filesAt = Date.now(); } catch { v3.files = []; }
}
function dzEmpty(err) {
  const el = $('#dzEmpty'); if (!el) return;
  el.classList.remove('hidden');
  el.innerHTML = html`<div class="dz-empty-in">
    <div class="dz-empty-i">💃</div>
    <b>Добавьте танцора</b>
    <span>3D-модель в формате VRM — например, из VRoid Hub или VRoid Studio. Перетащите файл сюда или выберите его.</span>
    ${err ? raw(html`<span class="err">${err}</span>`) : ''}
    <button class="btn primary sm" data-dz-up>Выбрать модель (.vrm)</button>
  </div>`;
}

/* ── загрузка файлов на демон ── */
async function dzUpload(files) {
  files = files.filter(f => /\.(vrm|vrma|fbx|bvh)$/i.test(f.name));
  if (!files.length) { toast('Нужен файл .vrm (модель) или .vrma, .fbx, .bvh (движение)', true); return; }
  let lastModel = '';
  for (const f of files) {
    const name = f.name.replace(/[^\p{L}\p{N} _.()\[\]-]/gu, '_').slice(-100);
    toast('Загружаю ' + name + ' (' + fmtSize(f.size) + ')…');
    try {
      const r = await fetch('/api/dancer/file?n=' + encodeURIComponent(name), { method: 'POST', body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      if (/\.vrm$/i.test(name)) lastModel = name;
      else delete v3.clips[name];
    } catch (e) { toast('Не загрузилось: ' + e.message, true); }
  }
  await dzLoadFiles(true);
  if (lastModel) { savePref('tc_vrm_model', lastModel); v3.vrmName = ''; const em = $('#dzEmpty'); if (em) em.classList.add('hidden'); dancerStart(); toast('Танцор готов'); }
  else toast('Движения добавлены — пойдут вперемешку со встроенными');
  paintDzMenu();
}
async function dzDelete(name) {
  try { await fetch('/api/dancer/file?n=' + encodeURIComponent(name), { method: 'DELETE' }); } catch {}
  delete v3.clips[name];
  await dzLoadFiles(true);
  if (name === v3.vrmName) { dzDropModel(); if (dzModels().length) dancerStart(); else dzEmpty(); }
  paintDzMenu();
}
function paintDzMenu() {
  const m = $('#dzMenu'); if (!m) return;
  m.classList.toggle('hidden', !v3.menu); const st = $('#muStage'); if (st) st.classList.toggle('menu', !!v3.menu);
  if (!v3.menu) return;
  const meta = v3.vrm && v3.vrm.meta, mix = dzMix();
  const who = meta ? (meta.name || meta.title || v3.vrmName) : '';
  const by = meta ? [].concat(meta.authors || meta.author || []).join(', ') : '';
  m.innerHTML = html`<div class="dz-mh">Модель</div>
    ${dzModels().map(f => raw(html`<div class="dz-row${f.name === v3.vrmName ? ' on' : ''}"><button data-dz-model="${f.name}">${f.name.replace(/\.vrm$/i, '')}</button><button class="iconbtn" data-dz-del="${f.name}" title="Удалить файл">×</button></div>`))}
    ${who ? raw(html`<div class="dz-credit">«${who}»${by ? ' · автор ' + by : ''}${meta && meta.licenseUrl ? raw(' · <a href="' + esc(meta.licenseUrl) + '" target="_blank" rel="noopener">лицензия</a>') : ''}</div>`) : ''}
    <button class="btn sm" data-dz-up>+ Модель (.vrm)</button>
    <div class="dz-mh">Танцы</div>
    <label class="dz-opt"><input type="radio" name="dzMix" value="all" ${mix === 'all' ? 'checked' : ''}> встроенные и мои вперемешку</label>
    <label class="dz-opt"><input type="radio" name="dzMix" value="builtin" ${mix === 'builtin' ? 'checked' : ''}> только встроенные</label>
    <label class="dz-opt"><input type="radio" name="dzMix" value="mine" ${mix === 'mine' ? 'checked' : ''}> только мои</label>
    ${dzAnims().map(f => raw(html`<div class="dz-row${dz.move === 'clip:' + f.name ? ' on' : ''}"><button data-dz-play="${f.name}" title="Танцевать сейчас">${f.name}</button><button class="iconbtn" data-dz-del="${f.name}" title="Удалить файл">×</button></div>`))}
    <button class="btn sm" data-dz-up>+ Движение (.vrma, .fbx, .bvh)</button>
    <div class="dz-hint">Движения: .vrma (VRoid), .fbx с Mixamo («Without Skin»), .bvh. Файлы можно перетащить на танцора.</div>`;
}
function onDzClick(e) {
  const t = e.target; let b;
  if (t.closest('[data-dz-up]')) { $('#dzFile').click(); return; }
  if ((b = t.closest('[data-dz-model]'))) { savePref('tc_vrm_model', b.dataset.dzModel); dancerStart(); paintDzMenu(); return; }
  if ((b = t.closest('[data-dz-del]'))) { const n = b.dataset.dzDel; if (confirm('Удалить «' + n + '»?')) dzDelete(n); return; }
  if ((b = t.closest('[data-dz-play]'))) { dz.prevMove = dz.move; dz.move = 'clip:' + b.dataset.dzPlay; dz.moveAt = Math.floor(dz.b); dzMoveStarted(); paintDzMenu(); }
}
function onDzChange(e) { if (e.target.name === 'dzMix') { savePref('tc_dz_mix', e.target.value); dancerNewTrack(); } }

/* ── 3D ── */
async function dzEnsure3D() {
  if (v3.M) return v3.M;
  if (!v3.mod) v3.mod = import('/vrm.js');
  v3.M = await v3.mod;
  return v3.M;
}
function dzAttachCanvas() {
  const M = v3.M, THREE = M.THREE;
  if (!v3.ren || v3.ren.domElement !== dz.cv) {
    if (v3.ren) { try { v3.ren.dispose(); } catch {} }
    v3.ren = new THREE.WebGLRenderer({ canvas: dz.cv, alpha: true, antialias: true, powerPreference: 'low-power' });
    v3.ren.setClearColor(0x000000, 0);
    v3.ren.outputColorSpace = THREE.SRGBColorSpace;
  }
  if (!v3.scene) {
    v3.scene = new THREE.Scene();
    v3.cam = new THREE.PerspectiveCamera(26, 1, 0.1, 30);
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9); key.position.set(1, 2, 3); v3.scene.add(key);
    v3.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    // мягкая тень — пятно с радиальной прозрачностью
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    v3.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    v3.shadow.rotation.x = -Math.PI / 2; v3.shadow.position.y = 0.002; v3.scene.add(v3.shadow);
  }
  dancerResize();
}
function dancerResize() {
  if (!v3.ren || !dz.cv) return;
  const r = dz.cv.getBoundingClientRect();
  dz.w = Math.max(10, r.width); dz.h = Math.max(10, r.height);
  v3.ren.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  v3.ren.setSize(dz.w, dz.h, false);
  v3.cam.aspect = dz.w / dz.h;
  dzFrameCamera();
}
// Камера: модель целиком, ноги у нижнего края, с запасом под поднятые руки.
function dzFrameCamera() {
  if (!v3.cam) return;
  const H = v3.rig ? v3.rig.height : 1.6, fov = v3.cam.fov * Math.PI / 180;
  const needH = H * 1.18, needW = H * 0.95; // по высоте и по ширине (руки в стороны)
  const dist = Math.max(needH / 2 / Math.tan(fov / 2), needW / 2 / Math.tan(fov / 2) / v3.cam.aspect);
  v3.cam.position.set(0, H * 0.56, dist);
  v3.cam.lookAt(0, H * 0.53, 0);
  v3.cam.updateProjectionMatrix();
}
function dzDropModel() {
  if (v3.vrm) { v3.scene.remove(v3.vrm.scene); try { v3.M.VRMUtils.deepDispose(v3.vrm.scene); } catch {} }
  v3.vrm = null; v3.vrmName = ''; v3.rig = null; v3.mixer = null; v3.action = null; v3.clipName = ''; v3.clips = {};
}
async function dzLoadModel(name) {
  const M = v3.M;
  v3.loading = name; dzCap('загружаю танцора…');
  try {
    const loader = new M.GLTFLoader();
    loader.register(p => new M.VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync('/api/dancer/file?n=' + encodeURIComponent(name));
    const vrm = gltf.userData.vrm; if (!vrm) throw new Error('в файле нет VRM');
    if (v3.loading !== name) { M.VRMUtils.deepDispose(gltf.scene); return; }
    dzDropModel();
    M.VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (M.VRMUtils.combineSkeletons) M.VRMUtils.combineSkeletons(gltf.scene);
    M.VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse(o => { o.frustumCulled = false; });
    v3.scene.add(vrm.scene);
    v3.vrm = vrm; v3.vrmName = name;
    if (vrm.lookAt) vrm.lookAt.target = v3.cam;
    v3.mixer = new M.THREE.AnimationMixer(vrm.scene);
    dzBuildRig();
    dzFrameCamera();
    const em = $('#dzEmpty'); if (em) em.classList.add('hidden');
    paintDzMenu();
  } catch (e) { dzEmpty('Модель не открылась: ' + e.message); }
  finally { if (v3.loading === name) v3.loading = ''; }
}

/* ── скелет: опорные точки и обратная кинематика ── */
const DZ_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftToes', 'rightToes'];
function dzBuildRig() {
  const THREE = v3.M.THREE, h = v3.vrm.humanoid, V = () => new THREE.Vector3();
  const n = {}; for (const k of DZ_BONES) n[k] = h.getNormalizedBoneNode(k);
  v3.vrm.scene.updateMatrixWorld(true);
  const wp = k => n[k] ? n[k].getWorldPosition(V()) : null;
  const armL = wp('leftUpperArm').distanceTo(wp('leftLowerArm')) + wp('leftLowerArm').distanceTo(wp('leftHand'));
  const head = wp('head'), foot = wp('leftFoot');
  const eyeL = h.getNormalizedBoneNode('leftEye'), eyeR = h.getNormalizedBoneNode('rightEye');
  v3.rig = { n, u: armL / 55, hips0: n.hips.position.clone(), ankleY: foot.y, height: head.y + armL * 0.42,
    eyes: eyeL && eyeR ? [eyeL, eyeR] : null, len: {} };
  for (const s of ['left', 'right']) {
    v3.rig.len[s + 'Arm'] = [wp(s + 'UpperArm').distanceTo(wp(s + 'LowerArm')), wp(s + 'LowerArm').distanceTo(wp(s + 'Hand'))];
    v3.rig.len[s + 'Leg'] = [wp(s + 'UpperLeg').distanceTo(wp(s + 'LowerLeg')), wp(s + 'LowerLeg').distanceTo(wp(s + 'Foot'))];
  }
  v3.shadow.scale.set(armL * 1.7, armL * 1.0, 1);
}
// Двухзвенная ОК в мировых координатах; pole — куда смотрит сустав.
const dzT = {};
function dzIK3(up, lo, end, target, pole, lens) {
  const THREE = v3.M.THREE;
  if (!dzT.a) { for (const k of ['a', 'b', 'c', 'd', 'e', 't', 'x', 'y']) dzT[k] = new THREE.Vector3(); dzT.q = new THREE.Quaternion(); dzT.pq = new THREE.Quaternion(); dzT.wq = new THREE.Quaternion(); }
  const { a, b, c, d, e, t, x, y, q, pq, wq } = dzT;
  const [l1, l2] = lens;
  up.getWorldPosition(a); lo.getWorldPosition(b); end.getWorldPosition(c);
  t.copy(target).sub(a); let dist = t.length();
  const dd = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, dist));
  t.normalize();
  const along = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd), hgt = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  x.copy(pole).addScaledVector(t, -pole.dot(t)); if (x.lengthSq() < 1e-8) x.set(0, 0, 1).addScaledVector(t, -t.z); x.normalize();
  e.copy(a).addScaledVector(t, along).addScaledVector(x, hgt);          // локоть / колено
  const tip = d.copy(a).addScaledVector(t, dd);                          // кисть / стопа
  // верхнее звено: (b - a) → (e - a)
  x.copy(b).sub(a).normalize(); y.copy(e).sub(a).normalize();
  q.setFromUnitVectors(x, y);
  up.getWorldQuaternion(wq); wq.premultiply(q);
  up.parent.getWorldQuaternion(pq); up.quaternion.copy(pq.invert().multiply(wq));
  up.updateMatrixWorld(true);
  // нижнее звено: (c' - e) → (tip - e)
  lo.getWorldPosition(b); end.getWorldPosition(c);
  x.copy(c).sub(b).normalize(); y.copy(tip).sub(b).normalize();
  q.setFromUnitVectors(x, y);
  lo.getWorldQuaternion(wq); wq.premultiply(q);
  lo.parent.getWorldQuaternion(pq); lo.quaternion.copy(pq.invert().multiply(wq));
  lo.updateMatrixWorld(true);
}
function dzApplyPose(p) {
  const THREE = v3.M.THREE, R = v3.rig, n = R.n, u = R.u;
  for (const k of DZ_BONES) if (n[k]) n[k].quaternion.identity();
  const E = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
  // 2D: x вправо по экрану (= левая рука модели, +X), y вниз; tl — наклон по часовой
  n.hips.position.set(R.hips0.x + p.px * u, R.hips0.y - p.py * u, R.hips0.z);
  n.hips.quaternion.copy(E(0, p.tw * 0.5, -p.tl * 0.5));
  n.spine.quaternion.copy(E(0.02, p.tw * 0.3, -p.tl * 0.3));
  if (n.chest) n.chest.quaternion.copy(E(0, p.tw * 0.2, -p.tl * 0.2));
  if (n.neck) n.neck.quaternion.copy(E(-p.up * 0.4, -p.tw * 0.4, -p.ht * 0.4));
  n.head.quaternion.copy(E(-p.up * 0.6, -p.tw * 0.3, -p.ht * 0.6));
  v3.vrm.scene.updateMatrixWorld(true);
  // руки: цели — от точки груди, в осях повёрнутого торса
  const sl = n.leftUpperArm.getWorldPosition(new THREE.Vector3()), sr = n.rightUpperArm.getWorldPosition(new THREE.Vector3());
  const chest = sl.clone().add(sr).multiplyScalar(0.5).add(new THREE.Vector3(0, 2 * u, 0));
  const roll = -p.tl * 0.6, cr = Math.cos(roll), sn = Math.sin(roll);
  const loc = (xy, z) => { const x = xy[0] * u, y = -xy[1] * u; return new THREE.Vector3(chest.x + x * cr - y * sn, chest.y + x * sn + y * cr, chest.z + z * u); };
  let tl = loc(p.rh, p.rhz), tr = loc(p.lh, p.lhz); // экран справа = левая рука модели
  const ew = Math.min(1, Math.abs(p.eye || 0));
  if (ew > 0.02 && R.eyes) { // кисть кольцом у глаза: та, что на стороне p.eye (|eye| — вес, т.к. позы плавно смешиваются)
    const left = p.eye > 0, eye = R.eyes[left ? 0 : 1].getWorldPosition(new THREE.Vector3()), a = TAU * dz.b;
    const tg = eye.add(new THREE.Vector3((left ? 1 : -1) * 0.04 + Math.cos(a) * 0.008, -0.01 + Math.sin(a) * 0.008, 0.07));
    if (left) tl.lerp(tg, ew); else tr.lerp(tg, ew);
  }
  dzIK3(n.leftUpperArm, n.leftLowerArm, n.leftHand, tl, new THREE.Vector3(0.8, -1, -0.7), R.len.leftArm);
  dzIK3(n.rightUpperArm, n.rightLowerArm, n.rightHand, tr, new THREE.Vector3(-0.8, -1, -0.7), R.len.rightArm);
  // ноги: стопы на полу, колени вперёд (в присяде — в стороны)
  const fl = new THREE.Vector3(p.rf[0] * u, R.ankleY + p.rf[1] * u, p.rfz * u), fr = new THREE.Vector3(p.lf[0] * u, R.ankleY + p.lf[1] * u, p.lfz * u);
  const ko = 0.3 + (p.kn - 0.4) * 2;
  dzIK3(n.leftUpperLeg, n.leftLowerLeg, n.leftFoot, fl, new THREE.Vector3(ko, 0, 1), R.len.leftLeg);
  dzIK3(n.rightUpperLeg, n.rightLowerLeg, n.rightFoot, fr, new THREE.Vector3(-ko, 0, 1), R.len.rightLeg);
  // стопы ровно, носком туда же, куда таз
  const yaw = E(0, p.tw * 0.5, 0), pq = new THREE.Quaternion();
  for (const k of ['leftFoot', 'rightFoot']) { n[k].parent.getWorldQuaternion(pq); n[k].quaternion.copy(pq.invert().multiply(yaw)); }
  // мимика: рот поёт, иногда моргает
  const ex = v3.vrm.expressionManager;
  if (ex) {
    ex.setValue('aa', Math.min(1, p.mo * 0.8));
    ex.setValue('happy', Math.min(0.6, dz.energy * 0.5));
  }
}
function dzBlink(now) {
  const ex = v3.vrm && v3.vrm.expressionManager; if (!ex) return;
  if (!v3.blinkAt) v3.blinkAt = now + 2000 + Math.random() * 3000;
  const k = (now - v3.blinkAt) / 140;
  ex.setValue('blink', k > 0 && k < 2 ? 1 - Math.abs(k - 1) : 0);
  if (k >= 2) v3.blinkAt = now + 2200 + Math.random() * 3500;
}

/* ── свои движения: .vrma, .fbx (Mixamo), .bvh → скелет модели ── */
const DZ_RIGMAP = { Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Chest: 'chest', UpperChest: 'upperChest', LowerBack: 'spine', Neck: 'neck', Neck1: 'neck', Head: 'head',
  LeftShoulder: 'leftShoulder', LeftArm: 'leftUpperArm', LeftForeArm: 'leftLowerArm', LeftHand: 'leftHand', RightShoulder: 'rightShoulder', RightArm: 'rightUpperArm', RightForeArm: 'rightLowerArm', RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg', LeftLeg: 'leftLowerLeg', LeftFoot: 'leftFoot', LeftToeBase: 'leftToes', RightUpLeg: 'rightUpperLeg', RightLeg: 'rightLowerLeg', RightFoot: 'rightFoot', RightToeBase: 'rightToes' };
function dzRigKey(name) { return String(name).replace(/^mixamorig\d*:?/i, '').replace(/^.*[:|]/, ''); }
function dzRetarget(root, clip) {
  const THREE = v3.M.THREE, vrm = v3.vrm, v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  const byKey = {}; root.traverse(o => { const k = DZ_RIGMAP[dzRigKey(o.name)]; if (k && !byKey[k]) byKey[k] = o; });
  const hipsSrc = byKey.hips; if (!hipsSrc) throw new Error('в записи нет кости бёдер (Hips)');
  const footSrc = byKey.leftFoot || byKey.rightFoot;
  const pScale = hipsSrc.parent ? hipsSrc.parent.getWorldScale(v).y : 1;
  const hipsW = hipsSrc.getWorldPosition(new THREE.Vector3()), footW = footSrc ? footSrc.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  const srcH = Math.max(1e-6, (hipsW.y - footW.y) / (pScale || 1));
  const vrmH = Math.abs(vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(v).y - v3.rig.ankleY);
  const scale = vrmH / srcH, floorLocal = footW.y / (pScale || 1) - (v3.rig.ankleY / scale);
  const v0 = vrm.meta && vrm.meta.metaVersion === '0';
  const tracks = [], restInv = new THREE.Quaternion(), parentRest = new THREE.Quaternion(), q = new THREE.Quaternion();
  for (const tr of clip.tracks) {
    const [node, prop] = tr.name.split('.');
    const src = root.getObjectByName(node) || (node === root.name ? root : null);
    const vb = DZ_RIGMAP[dzRigKey(node)];
    const dst = vb && vrm.humanoid.getNormalizedBoneNode(vb);
    if (!src || !dst) continue;
    src.getWorldQuaternion(restInv).invert();
    if (src.parent) src.parent.getWorldQuaternion(parentRest); else parentRest.identity();
    if (prop === 'quaternion') {
      const vals = tr.values.slice();
      for (let i = 0; i < vals.length; i += 4) {
        q.fromArray(vals, i).premultiply(parentRest).multiply(restInv).toArray(vals, i);
        if (v0) { vals[i] = -vals[i]; vals[i + 2] = -vals[i + 2]; }
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(dst.name + '.quaternion', tr.times, vals));
    } else if (prop === 'position' && vb === 'hips') {
      const vals = tr.values.slice(), x0 = vals[0], z0 = vals[2];
      for (let i = 0; i < vals.length; i += 3) {
        // по полу — на месте сцены: сдвиг от первого кадра
        vals[i] = (vals[i] - x0) * scale * (v0 ? -1 : 1);
        vals[i + 1] = (vals[i + 1] - floorLocal) * scale;
        vals[i + 2] = (vals[i + 2] - z0) * scale * (v0 ? -1 : 1);
      }
      tracks.push(new THREE.VectorKeyframeTrack(dst.name + '.position', tr.times, vals));
    }
  }
  if (!tracks.length) throw new Error('кости записи не совпали со скелетом');
  return new THREE.AnimationClip(clip.name || 'dance', clip.duration, tracks);
}
async function dzLoadClip(name) {
  if (v3.clips[name] || !v3.vrm) return v3.clips[name];
  const M = v3.M, url = '/api/dancer/file?n=' + encodeURIComponent(name), ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
  let clip;
  if (ext === 'vrma') {
    const loader = new M.GLTFLoader(); loader.register(p => new M.VRMAnimationLoaderPlugin(p));
    const g = await loader.loadAsync(url), a = (g.userData.vrmAnimations || [])[0];
    if (!a) throw new Error('в файле нет VRMA-анимации');
    clip = M.createVRMAnimationClip(a, v3.vrm);
  } else if (ext === 'fbx') {
    const obj = await new M.FBXLoader().loadAsync(url);
    const src = (obj.animations || [])[0]; if (!src) throw new Error('в FBX нет анимации');
    clip = dzRetarget(obj, src);
  } else if (ext === 'bvh') {
    const res = new M.BVHLoader().parse(await (await fetch(url)).text());
    const root = res.skeleton.bones[0];
    clip = dzRetarget(root, res.clip);
  }
  v3.clips[name] = clip;
  return clip;
}
// Смена танца: запоминаем текущую позу, чтобы перейти к новой плавно.
function dzMoveStarted() {
  if (!v3.rig) return;
  const n = v3.rig.n;
  v3.snap = { at: performance.now(), q: DZ_BONES.map(k => n[k] ? n[k].quaternion.clone() : null), hp: n.hips.position.clone() };
  const m = dz.move;
  if (m.startsWith('clip:')) {
    const name = m.slice(5);
    dzLoadClip(name).then(clip => {
      if (dz.move !== m || !clip || !v3.mixer) return;
      if (v3.action) v3.action.stop();
      v3.action = v3.mixer.clipAction(clip); v3.action.reset().setLoop(v3.M.THREE.LoopRepeat, Infinity).play();
      v3.clipName = name;
      v3.snap = { at: performance.now(), q: DZ_BONES.map(k => n[k] ? n[k].quaternion.clone() : null), hp: n.hips.position.clone() };
    }).catch(e => { toast('Движение «' + name + '» не подошло: ' + e.message, true); dz.move = 'idle'; dz.moveAt = dz.b - 99; });
  } else if (v3.action) { v3.action.stop(); v3.action = null; v3.clipName = ''; }
}
function dzBlendSnap() {
  const s = v3.snap; if (!s) return;
  const k = Math.min(1, (performance.now() - s.at) / 450); if (k >= 1) { v3.snap = null; return; }
  const e = k * k * (3 - 2 * k), n = v3.rig.n;
  DZ_BONES.forEach((name, i) => { if (n[name] && s.q[i]) n[name].quaternion.slerpQuaternions(s.q[i], n[name].quaternion.clone(), e); });
  n.hips.position.lerpVectors(s.hp, n.hips.position.clone(), e);
}
function dzCap(text) { const c = $('#muDanceCap'); if (c) c.textContent = text; }

/* ── кадр ── */
function dancerFrame(now) {
  if (!dz.cv || !dz.cv.isConnected) { dz.raf = 0; return; }
  dz.raf = requestAnimationFrame(dancerFrame);
  if (document.hidden || now - dz.last < 32) return;
  const dt = dz.last ? Math.min(0.1, (now - dz.last) / 1000) : 0.033; dz.last = now;
  if (!v3.vrm || !v3.rig) return;
  const r = dz.cv.getBoundingClientRect();
  if (Math.abs(r.width - dz.w) > 1 || Math.abs(r.height - dz.h) > 1) dancerResize();
  const { playing, heard } = dancerListen(dt, now);
  dzChoreo(playing);
  const clip = dz.move.startsWith('clip:') && v3.action;
  if (clip) {
    v3.mixer.update(dt);
    const ex = v3.vrm.expressionManager; if (ex) { ex.setValue('aa', 0); ex.setValue('happy', Math.min(0.6, dz.energy * 0.5)); }
  } else {
    const k = Math.min(1, Math.max(0, dz.b - dz.moveAt));
    const mv = dz.move.startsWith('clip:') ? 'idle' : dz.move, pm = dz.prevMove.startsWith('clip:') ? 'idle' : dz.prevMove;
    let pose = dzPose(mv, dz.b, dz.energy);
    if (k < 1) pose = dzLerp(dzPose(pm, dz.b, dz.energy), pose, k * k * (3 - 2 * k));
    dz.pose = dz.pose ? dzLerp(dz.pose, pose, 1 - Math.exp(-dt * 14)) : pose;
    dzApplyPose(dz.pose);
  }
  dzBlendSnap();
  dzBlink(now);
  v3.vrm.update(dt);
  const hp = v3.rig.n.hips.getWorldPosition(dzT.sh || (dzT.sh = new v3.M.THREE.Vector3()));
  v3.shadow.position.x = hp.x; v3.shadow.position.z = hp.z;
  v3.ren.render(v3.scene, v3.cam);
  dzCap(!playing ? 'включите трек — потанцуем' : `${dzMoveName(dz.move)} · ${heard ? '' : '≈'}${Math.round(dz.bpm)} BPM`);
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
  const p = { px: 0, py: dn * 4 * A, tl: 0, ht: 0, lh: [-17, 40], rh: [17, 40], lf: [-12, 0], rf: [12, 0], muz: 0, ring: 0, spark: 0, kn: 0.4, mo: 0,
    lhz: 10, rhz: 10, lfz: 0, rfz: 0, tw: 0, up: 0, eye: 0 };
  const sw = Math.sin(Math.PI * b);
  switch (m) {
    case 'idle':
      p.px = Math.sin(b * Math.PI / 2) * 2; p.py = 1; p.tl = Math.sin(b * Math.PI / 2) * 0.03; p.ht = -p.tl;
      p.lh = [-16, 41]; p.rh = [16, 41]; break;
    case 'ichwill': { // по мему: подскоки со скрещенной ногой → лапы-мельница → присед-пружинка
      const rb = ((b - (dz.ichAt || 0)) % 16 + 16) % 16, s = Math.floor(rb) % 2 ? 1 : -1, flop = Math.sin(TAU * b) * 3;
      p.mo = 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * b));
      if (rb < 8) { // стоит на одной ноге, другая согнута и заходит за опорную; лапки висят у груди
        const hop = Math.sin(Math.PI * fr) * 5 * A;
        p.py = -hop + 2; p.tl = -s * 0.08; p.ht = s * 0.1 - 0.06; p.px = s * 2;
        if (s > 0) { p.rf = [5, hop]; p.lf = [9, 20 + hop]; p.lfz = 12; } else { p.lf = [-5, hop]; p.rf = [-9, 20 + hop]; p.rfz = 12; }
        p.lh = [-8, 6 + flop]; p.rh = [8, 6 - flop]; p.lhz = p.rhz = 22; p.up = 0.28; p.tw = s * 0.15;
      } else if (rb < 12) { // лапы машут в стороны по очереди, корпус крутится
        const a = Math.PI * b, w = Math.sin(a);
        p.lh = [-14 - 26 * Math.max(0, w), 2 - 12 * w]; p.rh = [14 + 26 * Math.max(0, -w), 2 + 12 * w];
        p.px = 4 * w; p.tl = 0.1 * w; p.ht = -0.15 * w; p.tw = 0.4 * w; p.lhz = p.rhz = 6; p.up = 0.12;
        if (Math.floor(rb) % 2) p.lf = [-12, Math.sin(Math.PI * fr) * 7]; else p.rf = [12, Math.sin(Math.PI * fr) * 7];
      } else { // широкий присед, колени в стороны, пружинит на долю
        p.lf = [-23, 0]; p.rf = [23, 0]; p.kn = 1; p.py = 9 + dn * 6 * A;
        p.tl = Math.sin(Math.PI * b) * 0.08; p.ht = -p.tl;
        p.lh = [-9, 8 + flop]; p.rh = [9, 8 - flop]; p.lhz = p.rhz = 20; p.up = 0.15;
      }
      break;
    }
    case 'iris': { // кисть кольцом у глаза, другая на бедре; стороны меняются каждые 2 доли
      const s = Math.floor(b / 4) % 2 ? 1 : -1, a = TAU * b;
      const hand = [s * 8 + Math.cos(a) * 2.5 * A, -25 + Math.sin(a) * 2.5 * A];
      if (s < 0) { p.lh = hand; p.rh = [16, 39]; } else { p.rh = hand; p.lh = [-16, 39]; }
      p.px = -s * 5 * A; p.tl = s * 0.07; p.ht = s * 0.16 + Math.sin(a) * 0.03;
      if (s < 0) p.rf = [12, 3]; else p.lf = [-12, 3];
      p.ring = 1; p.eye = s; break;
    }
    case 'clap': {
      const sep = Math.sin(Math.PI * fr), hi = beat % 4 === 3 ? -22 : 12;
      p.lh = [-3 - 19 * sep, hi + sep * 6]; p.rh = [3 + 19 * sep, hi + sep * 6];
      p.px = Math.sin(Math.PI * b) * 4 * A; p.tl = -p.px * 0.012;
      if (beat % 2) p.lf = [-16, 0]; else p.rf = [16, 0];
      p.spark = fr < 0.18 ? 1 - fr / 0.18 : 0; p.lhz = p.rhz = 26; break;
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
      p.lh = [-42, -4 + 6 * q]; p.rh = [42, -4 - 6 * q]; p.lf = [-15, 0]; p.rf = [15, 0]; p.tw = q * 0.2; p.lhz = p.rhz = 4; break;
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
  if (dz.move === 'idle' || dz.b - dz.moveAt >= dzMoveLen(dz.move)) {
    const list = dzMoveList().filter(m => m !== dz.move);
    dz.prevMove = dz.move; dz.move = list[Math.floor(Math.random() * list.length)]; dz.moveAt = Math.floor(dz.b);
    if (dz.move === 'ichwill') dz.ichAt = dz.moveAt;
    dzMoveStarted();
  }
}

