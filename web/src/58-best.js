/* ---------- лучшая раздача из всех источников ---------- */
// По нажатию: rutor, Кинозал и Torznab опрашиваются разом, одинаковые раздачи
// (тот же хэш, а без хэша — то же название и размер) сливаются в одну со
// списком источников, и выбирается лучшая по оценке качества, затем по сидам.

function bestNorm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}
// bestRelevant — название раздачи содержит все значимые слова запроса и, если
// известен год, год рядом: иначе «Дюна» подтянет «Дюну» 1984 года и сборники.
function bestRelevant(r, q, year) {
  const t = bestNorm(r.title || r.name);
  const words = bestNorm(q).split(' ').filter(w => w.length > 1);
  if (!words.every(w => t.includes(w))) return false;
  if (year) {
    const ys = (String(r.title || '').match(/\b(19|20)\d{2}\b/g) || []).map(Number);
    if (ys.length && !ys.some(y => Math.abs(y - year) <= 1)) return false;
  }
  return true;
}
function bestKey(r) {
  if (r.hash) return 'h:' + String(r.hash).toLowerCase();
  const gb = r.size_bytes ? Math.round(r.size_bytes / (64 * 1048576)) : '';
  return 't:' + bestNorm(r.title || r.name) + '|' + gb;
}
function mergeBest(lists) {
  const map = new Map();
  for (const r of lists.flat()) {
    if (!r) continue;
    const k = bestKey(r);
    const cur = map.get(k);
    const src = r._p || '?';
    if (!cur) { map.set(k, { ...r, _srcs: [src] }); continue; }
    if (!cur._srcs.includes(src)) cur._srcs.push(src);
    // Сиды одной раздачи на разных трекерах — один рой, считается максимум.
    if ((r.seed || 0) > (cur.seed || 0)) cur.seed = r.seed;
    if (!cur.magnet && r.magnet) cur.magnet = r.magnet;
    if (!cur.hash && r.hash) cur.hash = r.hash;
  }
  return [...map.values()];
}
// Для просмотра «сразу» сиды важны не меньше качества: раздача с одним сидом
// не раскачается, какой бы хорошей ни была. Поэтому к оценке качества
// прибавляется вес сидов (логарифм, до +20), а почти пустые раздачи штрафуются.
function bestScore(r, q) {
  const s = r.seed || 0;
  return q.score + Math.min(20, 8 * Math.log10(1 + s)) - (s < 3 ? 15 : 0);
}
function rankBest(rows) {
  return rows.filter(r => (r.seed || 0) > 0)
    .map(r => { const q = rateRelease(r); return { r, q, w: bestScore(r, q) }; })
    .sort((a, b) => (b.w - a.w) || ((b.r.seed || 0) - (a.r.seed || 0)));
}

const SRC_NAME = { rutor: 'rutor', kinozal: 'Кинозал', torznab: 'Torznab', popular: 'rutor' };

async function findBest(q, year) {
  q = String(q || '').trim(); if (!q) return;
  $$('body > .overlay.best-ov').forEach(o => o.remove());
  const ov = document.createElement('div'); ov.className = 'overlay best-ov';
  ov.innerHTML = html`<div class="modal" style="max-width:720px"><h3>Лучшая раздача: ${q}${year ? ' (' + year + ')' : ''}</h3><div id="bestBody">${raw(skeleton('Опрашиваю все источники…', 3))}</div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  const body = ov.querySelector('#bestBody');
  const jobs = [['kinozal', () => searchKinozal(q, 0)], ['torznab', () => searchTorznab(q, 0)]];
  if (!state.rutorOff) jobs.unshift(['rutor', () => searchRutor(q, 0, 0)]);
  const res = await Promise.allSettled(jobs.map(([, f]) => f()));
  const failed = res.map((x, i) => x.status === 'rejected' ? SRC_NAME[jobs[i][0]] : '').filter(Boolean);
  const lists = res.map((x, i) => (x.status === 'fulfilled' ? x.value : []).map(r => ({ ...r, _p: r._p || jobs[i][0] })));
  let rows = mergeBest(lists).filter(r => bestRelevant(r, q, year));
  const ranked = rankBest(rows);
  if (!ranked.length) {
    body.innerHTML = html`<div class="empty">Живых раздач не найдено${failed.length ? ' (не ответили: ' + failed.join(', ') + ')' : ''}.</div><div class="row"><button class="primary" id="bestAll">Обычный поиск</button></div>`;
  } else {
    const line = ({ r, q: rq }, big) => html`<div class="best-row${big ? ' best-top' : ''}">
      <div class="best-title">${r.title || r.name}</div>
      <div class="best-meta">
        <span class="chip rq rq-${rq.tier}" title="${rateTip(rq)}">${rq.score}${rq.ru ? ' · RU' : ''}</span>
        ${raw(isSeries(r.title) ? html`<span class="chip series">${seriesTag(r.title)}</span>` : '')}
        <span>${r.size_bytes ? fmtSize(r.size_bytes) : (r.size || '')}</span><span>⬆ ${r.seed || 0}</span>
        <span class="page-sub" style="margin:0">${r._srcs.map(s => SRC_NAME[s] || s).join(' + ')}</span>
        <span class="spacer"></span><button class="${big ? 'primary' : ''}" data-bplay="${ranked.indexOf(ranked.find(x => x.r === r))}">▶ Смотреть</button>
      </div></div>`;
    body.innerHTML = html`${raw(line(ranked[0], true))}
      ${raw(ranked.length > 1 ? '<div class="page-sub" style="margin:10px 0 4px">Другие варианты</div>' + ranked.slice(1, 6).map(x => line(x, false)).join('') : '')}
      <div class="page-sub" style="margin-top:8px">Выбрано из ${rows.length} раздач (одинаковые с разных трекеров объединены)${failed.length ? '; не ответили: ' + failed.join(', ') : ''}.</div>
      <div class="row" style="margin-top:8px"><button id="bestAll">Все раздачи</button><span class="spacer"></span><button id="bestClose">Закрыть</button></div>`;
    $$('[data-bplay]', body).forEach(b => b.addEventListener('click', () => { const x = ranked[+b.dataset.bplay]; ov.remove(); playSearchLink(x.r); }));
  }
  const all = body.querySelector('#bestAll');
  if (all) all.addEventListener('click', () => { ov.remove(); if (state.view !== 'search') setView('search'); setTimeout(() => { $('#searchInput').value = q; doSearch(); }, 30); });
  const cl = body.querySelector('#bestClose'); if (cl) cl.addEventListener('click', () => ov.remove());
}
