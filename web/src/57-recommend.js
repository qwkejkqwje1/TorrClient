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

async function librarySeeds() {
  if (!(state.lib || []).length) { try { await loadLibrary(false); } catch {} }
  const out = []; const seen = new Set();
  for (const t of state.lib || []) {
    const c = cleanSearchTitle(t.title || t.name || '');
    if (!c.q) continue;
    const k = c.q.toLowerCase() + '|' + (c.year || '');
    if (seen.has(k)) continue;
    seen.add(k); out.push({ q: c.q, year: +c.year || 0 });
  }
  return out;
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
      <div class="disc-poster">${raw(it.poster ? html`<img loading="lazy" src="${it.poster}" alt="">` : '')}
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
