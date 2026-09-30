// ── Рекомендации по библиотеке ──
// Названия из библиотеки уходят демону, он сопоставляет их с TMDB и
// складывает рекомендации: что советуют сразу к нескольким вашим — выше.
// Щелчок по карточке ищет лучшую раздачу (findBest). Лишнее прячется «✕».

const REC_HIDE = 'tc_rec_hide';
const recState = { items: [], matched: 0, seeds: 0 };

function recHidden() { try { return new Set(JSON.parse(localStorage.getItem(REC_HIDE) || '[]')); } catch { return new Set(); } }
function recHide(key) {
  const s = recHidden(); s.add(key);
  try { localStorage.setItem(REC_HIDE, JSON.stringify([...s].slice(-500))); } catch {}
}

/* librarySeeds — названия для рекомендаций с весом. Досмотренное и
   Избранное говорят о вкусе больше, чем раздача, добавленная «на потом»:
   Избранное ×2, досмотренное ×1.8, начатое ×1.3, остальное ×1. Отправляются
   самые весомые, при равенстве — свежие: демон берёт не больше 60. */
function recWeight(t) {
  const vids = (t.file_stats || []).filter(f => isVideo(f.path));
  if (!vids.length) return 1;
  const done = vids.filter(f => isWatched(t, f.id)).length;
  if (done && done >= Math.ceil(vids.length / 2)) return 1.8;
  if (done || vids.some(f => currentTc(t, f.id) > 0)) return 1.3;
  return 1;
}
async function librarySeeds() {
  if (!(state.lib || []).length) { try { await loadLibrary(false); } catch {} }
  const by = new Map();
  const add = (title, w, at) => {
    const c = cleanSearchTitle(title || '');
    if (!c.q) return;
    const k = c.q.toLowerCase() + '|' + (c.year || '');
    const cur = by.get(k);
    if (cur) { cur.w = Math.max(cur.w, w); cur.at = Math.max(cur.at, at); return; }
    by.set(k, { q: c.q, year: +c.year || 0, w, at });
  };
  for (const t of state.lib || []) add(t.title || t.name, recWeight(t), Number(t.timestamp) || 0);
  for (const f of favList()) add(f.title, 2, Number(f.added || f.at) || 0);
  return [...by.values()]
    .sort((a, b) => b.w - a.w || b.at - a.at)
    .slice(0, 60)
    .map(({ q, year, w }) => ({ q, year, w }));
}

async function showRecommendations() {
  if (state.view !== 'search') { state.skipAutoTop = true; setView('search'); await new Promise(r => setTimeout(r, 30)); }
  const el = $('#searchResults'); if (!el) return;
  el.innerHTML = skeleton('Подбираю рекомендации по вашей библиотеке…', 12, true);
  const seeds = await librarySeeds();
  if (!seeds.length) { el.innerHTML = '<div class="empty">Библиотека пуста — рекомендовать не к чему. Добавьте пару фильмов.</div>'; return; }
  try {
    const r = await api('/api/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: seeds }) });
    recState.items = r.items || []; recState.matched = r.matched || 0; recState.seeds = r.seeds || 0;
  } catch (e) {
    el.innerHTML = html`<div class="empty">Не удалось подобрать: ${e.message}</div>`;
    return;
  }
  paintRecommendations(el);
}

function paintRecommendations(el) {
  const hidden = recHidden();
  const list = recState.items.filter(it => !hidden.has(it.kind + ':' + it.id));
  if (!list.length) {
    el.innerHTML = html`<div class="empty">Рекомендаций нет${recState.matched ? '' : ': ни одно название из библиотеки не нашлось в TMDB'}.</div>`;
    return;
  }
  const cards = list.map(it => html`
    <div class="disc-card" data-rk="${it.kind + ':' + it.id}" title="${it.overview || 'Подобрать лучшую раздачу из всех источников'}">
      <div class="disc-poster">${raw(it.poster ? html`<img loading="lazy" src="${pimg(it.poster)}" alt="">` : '')}
        <button class="rec-x" data-hide="${it.kind + ':' + it.id}" title="Не показывать">✕</button></div>
      <div class="disc-title">${it.title}</div>
      <div class="disc-meta">${it.kind === 'tv' ? 'Сериал · ' : ''}${it.year || ''}${it.rating ? ' · ★ ' + it.rating.toFixed(1) : ''}</div>
      ${raw((it.because || []).length ? html`<div class="rec-why">Похоже на: ${it.because.join(', ')}</div>` : '')}
    </div>`).join('');
  el.innerHTML = html`<div class="disc-head">Рекомендации по библиотеке (${list.length}) <span class="page-sub" style="font-weight:400">— по ${recState.matched} из ${recState.seeds} названий, найденных в TMDB</span></div>
    <div class="disc-grid">${raw(cards)}</div>`;
  el.querySelector('.disc-grid').addEventListener('click', e => {
    const x = e.target.closest('[data-hide]');
    if (x) { e.stopPropagation(); recHide(x.dataset.hide); paintRecommendations(el); return; }
    const c = e.target.closest('[data-rk]'); if (!c) return;
    const it = recState.items.find(i => i.kind + ':' + i.id === c.dataset.rk);
    if (it) findBest(it.title, it.year ? +String(it.year).slice(0, 4) : 0);
  });
}
