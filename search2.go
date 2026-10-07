package main

// Этап 2: потоковый параллельный поиск по индексаторам и «популярное за всё
// время» с постраничной подгрузкой.
//
// Потоковый поиск: все Torznab-источники опрашиваются одновременно, а
// раздачи уходят в интерфейс событиями SSE по мере ответа каждого источника.
// Медленный индексатор больше не задерживает быстрые: результаты быстрых
// видны сразу, а общий предел ожидания ограничен torznabStreamTimeout.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	// torznabStreamTimeout — сколько всего ждём ответов от источников.
	torznabStreamTimeout = 12 * time.Second

	// rutorSortSeeders — код сортировки «по сидам, по убыванию» в адресе
	// поиска rutor. Для «популярного за всё время» выдача сортируется на
	// стороне трекера, а не только внутри одной страницы.
	rutorSortSeeders = 2

	// rutorPopularMaxPage — потолок постраничной подгрузки.
	rutorPopularMaxPage = 20
)

// sseWrite отправляет одно событие SSE и сразу сбрасывает буфер клиенту.
func sseWrite(w http.ResponseWriter, f http.Flusher, name string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
	f.Flush()
}

// mergeNewItems возвращает раздачи, которых ещё не было в seen, и отмечает их
// там. Ключ — хеш, а без него magnet: у разных индексаторов одна раздача
// приходит несколько раз.
func mergeNewItems(seen map[string]bool, items []rutorItem) []rutorItem {
	out := make([]rutorItem, 0, len(items))
	for _, it := range items {
		k := strings.ToLower(it.Hash)
		if k == "" {
			k = strings.ToLower(it.Magnet)
		}
		if k != "" {
			if seen[k] {
				continue
			}
			seen[k] = true
		}
		out = append(out, it)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Seed > out[j].Seed })
	return out
}

type torznabStreamMsg struct {
	rep   torznabSourceReport
	items []rutorItem
}

// apiTorznabStream — параллельный поиск по всем индексаторам потоком SSE.
//
// События: «source» — {source: отчёт, items: новые раздачи} от каждого
// источника по мере ответа; «done» — {alive, total}. Если источников нет, или
// они не настроены, отвечает обычной JSON-ошибкой до начала потока.
func (c *Comp) apiTorznabStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "потоковый ответ не поддерживается")
		return
	}
	srcs := curCfg().TorznabSources
	if len(srcs) == 0 {
		writeJSONError(w, http.StatusServiceUnavailable, "индексаторы не настроены: добавьте Torznab-адрес в настройках")
		return
	}
	q := r.URL.Query()
	query := strings.TrimSpace(q.Get("query"))
	cat := strings.TrimSpace(q.Get("cat"))
	page := atoiSafe(q.Get("page"))
	if page < 0 || page >= torznabMaxPages {
		page = 0
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch := make(chan torznabStreamMsg, len(srcs))
	for _, s := range srcs {
		go func(s TorznabSource) {
			rep := torznabSourceReport{Name: s.Name, URL: s.URL}
			start := time.Now()
			items, err := fetchTorznab(s.URL, s.APIKey, query, cat, page)
			rep.MS = time.Since(start).Milliseconds()
			if err != nil {
				rep.Error = err.Error()
			} else {
				rep.OK = true
				rep.Items = len(items)
			}
			ch <- torznabStreamMsg{rep: rep, items: items}
		}(s)
	}

	timer := time.NewTimer(torznabStreamTimeout)
	defer timer.Stop()
	seen := map[string]bool{}
	answered := map[string]bool{}
	alive := 0
loop:
	for i := 0; i < len(srcs); i++ {
		select {
		case m := <-ch:
			answered[m.rep.Name] = true
			if m.rep.OK {
				alive++
			}
			sseWrite(w, flusher, "source", map[string]any{
				"source": m.rep,
				"items":  mergeNewItems(seen, m.items),
			})
		case <-timer.C:
			break loop
		case <-r.Context().Done():
			return
		}
	}
	// Не успевшие ответить источники сообщаем отдельно: молчание источника
	// нельзя выдавать за пустую выдачу.
	for _, s := range srcs {
		if !answered[s.Name] {
			sseWrite(w, flusher, "source", map[string]any{
				"source": torznabSourceReport{Name: s.Name, URL: s.URL, Error: "не ответил за отведённое время"},
				"items":  []rutorItem{},
			})
		}
	}
	sseWrite(w, flusher, "done", map[string]any{"alive": alive, "total": len(srcs)})
}

// ---------- популярное за всё время (rutor) ----------

// rutorPopularPath строит адрес выдачи rutor, отсортированной по сидам.
// Нумерация страниц с нуля, как и у обычного поиска. Пустой запрос даёт
// «всё в категории»: cat=0 — любая категория.
//
// Без запроса используется каталог /browse/<стр>/<кат>/0/<сорт>: поиск с пустым
// запросом rutor отвечает пустой страницей (проверено 30.09.2026), и
// «Популярное» падало с «ни один адрес не отдал выдачу».
func rutorPopularPath(page, cat int, q string) string {
	if strings.TrimSpace(q) == "" {
		return fmt.Sprintf("/browse/%d/%d/0/%d", page, cat, rutorSortSeeders)
	}
	return fmt.Sprintf("/search/%d/%d/000/%d/", page, cat, rutorSortSeeders) + url.QueryEscape(q)
}

// rutorPopular отдаёт страницу популярных раздач категории за всё время.
func (c *Comp) rutorPopular(q string, page, cat int) ([]rutorItem, error) {
	q = strings.TrimSpace(q)
	if page < 0 || page > rutorPopularMaxPage {
		page = 0
	}
	cat = normalizeRutorCat(cat)
	key := fmt.Sprintf("pop\x00%d\x00%d\x00%s", page, cat, strings.ToLower(q))
	if items, ok := rutorSearch.get(key); ok {
		return items, nil
	}
	items, err := c.fetchRutorFrom(rutorPopularPath(page, cat, q), func(doc string) []rutorItem {
		return parseRutorRows(doc, 0)
	})
	if err != nil {
		return nil, err
	}
	// Порядок задаёт трекер; локальная сортировка страхует, если код
	// сортировки на трекере изменится.
	sort.SliceStable(items, func(i, j int) bool { return items[i].Seed > items[j].Seed })
	if len(items) > rutorPageSize {
		items = items[:rutorPageSize]
	}
	rutorSearch.put(key, items)
	return items, nil
}

// apiPopular — «самое популярное за всё время» по категории с подгрузкой.
// Параметры: cat (код категории rutor), page (с нуля), query (необязательно).
// Ответ: {ok, items, page, has_more}.
func (c *Comp) apiPopular(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page := atoiSafe(q.Get("page"))
	if page < 0 || page > rutorPopularMaxPage {
		page = 0
	}
	cat := normalizeRutorCat(atoiSafe(q.Get("cat")))
	var (
		items  []rutorItem
		err    error
		source = "rutor"
	)
	if rutorEnabled() {
		items, err = c.rutorPopular(q.Get("query"), page, cat)
	} else {
		err = errRutorOff
	}
	// rutor выключен или не ответил — то же «Популярное» собирается через
	// индексаторы: они сортируются по сидам здесь же.
	if err != nil && len(curCfg().TorznabSources) > 0 {
		var ierr error
		items, ierr = c.torznabPopular(q.Get("query"), page, cat)
		if ierr == nil {
			err, source = nil, "indexers"
		} else if errors.Is(err, errRutorOff) {
			err = ierr
		}
	}
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	more := len(items) >= rutorPageSize/2 && page < rutorPopularMaxPage
	if source == "indexers" {
		more = len(items) >= rutorPageSize/2 && page < torznabMaxPages-1
	}
	jj(w, map[string]any{
		"ok":       true,
		"items":    items,
		"page":     page,
		"has_more": more,
		"source":   source,
	})
}

// torznabCatForRutor переводит категорию rutor в категории Torznab. Пусто —
// все категории.
func torznabCatForRutor(cat int) string {
	switch cat {
	case 1, 5:
		return "2000"
	case 4, 16:
		return "5000"
	case 7, 10, 12, 6:
		return "2000,5000"
	case 2:
		return "3000"
	case 8, 9:
		return "4000"
	case 11:
		return "7000"
	}
	return ""
}

// torznabPopular — популярное через индексаторы: страница выдачи по сидам.
func (c *Comp) torznabPopular(q string, page, rutorCat int) ([]rutorItem, error) {
	res, err := c.torznabSearchAll(strings.TrimSpace(q), torznabCatForRutor(rutorCat), page)
	if err != nil {
		return nil, err
	}
	items := res.Items
	sort.SliceStable(items, func(i, j int) bool { return items[i].Seed > items[j].Seed })
	if len(items) > rutorPageSize {
		items = items[:rutorPageSize]
	}
	return items, nil
}
