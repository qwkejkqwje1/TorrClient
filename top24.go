package main

// ТОП за сутки без потолка в тридцать строк.
//
// Блок «Топ торренты за последние 24 часа» на rutor — ровно тридцать раздач, и
// после фильтра качества от них оставалось два десятка. Поэтому к блоку
// добавляются все раздачи видеоразделов, вышедшие за сутки (первая страница
// каждого раздела по дате), — и всё вместе сортируется по сидам.
//
// Если rutor не отвечает вовсе, ТОП не ломается: названия, которые сейчас
// смотрят (тренды TMDB за день), ищутся через подключённые индексаторы
// (JacRed, Jackett), и от каждого берётся лучшая раздача.

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

// top24Cats — видеоразделы rutor: фильмы, сериалы, мультфильмы, аниме,
// научно-популярное и телевизор.
var top24Cats = []int{1, 5, 4, 16, 7, 10, 12, 6}

var rutorMonths = map[string]time.Month{
	"янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5, "июн": 6,
	"июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12,
}

// rutorDate читает дату вида «07 Окт 26».
func rutorDate(s string) (time.Time, bool) {
	f := strings.Fields(strings.ReplaceAll(rutorSpaces.Replace(s), "\u00a0", " "))
	if len(f) != 3 {
		return time.Time{}, false
	}
	d, m, y := atoiSafe(f[0]), rutorMonths[strings.ToLower(f[1])], atoiSafe(f[2])
	if d < 1 || d > 31 || m == 0 || y < 0 {
		return time.Time{}, false
	}
	if y < 100 {
		y += 2000
	}
	return time.Date(y, m, d, 0, 0, 0, 0, time.Local), true
}

// freshDay — раздача вышла сегодня или вчера: rutor пишет дату без времени,
// поэтому «за сутки» — это два календарных дня.
func freshDay(it rutorItem, now time.Time) bool {
	d, ok := rutorDate(it.Date)
	if !ok {
		return false
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	return !d.Before(today.AddDate(0, 0, -1)) && !d.After(today.AddDate(0, 0, 1))
}

// mergeTop сводит выдачи без повторов и сортирует по сидам.
func mergeTop(lists ...[]rutorItem) []rutorItem {
	seen := map[string]bool{}
	var out []rutorItem
	for _, l := range lists {
		for _, it := range l {
			k := strings.ToLower(it.Hash)
			if k == "" {
				k = it.Link
			}
			if k == "" {
				k = it.Title
			}
			if seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, it)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Seed > out[j].Seed })
	return out
}

// top24Wait — сколько ждать индексаторы: поиск по сорока названиям через
// JacRed или Jackett бывает долгим, а ТОП не должен висеть из-за одного
// медленного источника.
const top24Wait = 20 * time.Second

type topPart struct {
	items []rutorItem
	err   error
}

// fetchTop24All собирает ТОП суток из всех доступных источников разом: rutor
// (если не выключен) и индексаторы (JacRed, Jackett, Prowlarr). Ни один из
// них не обязателен — хватает любого. source: "rutor", "indexers" или
// "rutor+indexers".
func (c *Comp) fetchTop24All() ([]rutorItem, string, error) {
	rch := make(chan topPart, 1)
	ich := make(chan topPart, 1)
	useRutor := rutorEnabled()
	useIdx := len(curCfg().TorznabSources) > 0
	if useRutor {
		go func() {
			items, err := c.top24FromRutor()
			rch <- topPart{items, err}
		}()
	}
	if useIdx {
		go func() {
			items, err := c.top24FromIndexers()
			ich <- topPart{items, err}
		}()
	}
	var rut, idx topPart
	if useRutor {
		rut = <-rch
	} else {
		rut.err = errRutorOff
	}
	if useIdx {
		select {
		case idx = <-ich:
		case <-time.After(top24Wait):
			idx.err = errors.New("индексаторы не ответили вовремя")
		}
	} else {
		idx.err = errors.New("индексаторы не подключены (Настройки → Torznab, например JacRed)")
	}
	rok, iok := rut.err == nil && len(rut.items) > 0, idx.err == nil && len(idx.items) > 0
	switch {
	case rok && iok:
		return mergeTop(rut.items, idx.items), "rutor+indexers", nil
	case rok:
		return mergeTop(rut.items), "rutor", nil
	case iok:
		return mergeTop(idx.items), "indexers", nil
	}
	var why []string
	if useRutor {
		why = append(why, errText(rut.err, "rutor пуст"))
	} else {
		why = append(why, "rutor выключен")
	}
	why = append(why, errText(idx.err, "индексаторы ничего не нашли"))
	return nil, "", errors.New(strings.Join(why, "; "))
}

func errText(err error, empty string) string {
	if err != nil {
		return err.Error()
	}
	return empty
}

// top24FromRutor — блок «Топ за 24 часа» и свежие раздачи видеоразделов rutor.
func (c *Comp) top24FromRutor() ([]rutorItem, error) {
	var (
		mu    sync.Mutex
		wg    sync.WaitGroup
		block []rutorItem
		fresh [][]rutorItem
		errs  []string
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		items, err := c.fetchRutorTop()
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			errs = append(errs, err.Error())
			return
		}
		block = items
	}()
	now := time.Now()
	for _, cat := range top24Cats {
		wg.Add(1)
		go func(cat int) {
			defer wg.Done()
			items, err := c.fetchRutorFrom("/browse/0/"+itoa(cat)+"/0/0", func(doc string) []rutorItem {
				return parseRutorRows(doc, 0)
			})
			if err != nil {
				return
			}
			var day []rutorItem
			for _, it := range items {
				if freshDay(it, now) {
					day = append(day, it)
				}
			}
			mu.Lock()
			fresh = append(fresh, day)
			mu.Unlock()
		}(cat)
	}
	wg.Wait()
	if len(block) > 0 || len(fresh) > 0 {
		return mergeTop(append([][]rutorItem{block}, fresh...)...), nil
	}
	reason := "rutor не отвечает"
	if len(errs) > 0 {
		reason = errs[0]
	}
	return nil, errors.New(reason)
}

// top24FromIndexers — ТОП суток через индексаторы. С ключом TMDB это тренды дня,
// найденные по названиям; без ключа (или если TMDB не ответил) — свежие раздачи
// фильмов и сериалов прямо из ленты индексатора.
func (c *Comp) top24FromIndexers() ([]rutorItem, error) {
	if len(curCfg().TorznabSources) == 0 {
		return nil, errors.New("индексаторы не подключены (Настройки → Torznab, например JacRed)")
	}
	var trendErr error
	if tmdbConfigured() {
		items, err := c.top24FromTrends()
		if err == nil {
			return items, nil
		}
		trendErr = err
	}
	items, err := c.top24FromFeeds(time.Now())
	if err == nil {
		return items, nil
	}
	if trendErr != nil {
		return nil, errors.New(trendErr.Error() + "; лента индексаторов: " + err.Error())
	}
	return nil, err
}

// torznabCatsTop — категории Torznab для ленты: фильмы и сериалы (аниме и
// мультфильмы лежат внутри них).
var torznabCatsTop = []string{"2000", "5000"}

// torznabDate читает дату раздачи из ленты: RSS (RFC 1123) или ISO 8601.
func torznabDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC1123Z, time.RFC1123, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "Mon, 02 Jan 2006 15:04:05 -0700"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// top24FromFeeds спрашивает каждый индексатор без запроса — это лента
// последних раздач — и оставляет вышедшие за последние сутки с запасом в
// несколько часов (индексаторы отдают время в UTC, а часовые пояса бывают
// кривыми). Раздачи без понятной даты отбрасываются: суточным ТОПом их не
// назвать.
func (c *Comp) top24FromFeeds(now time.Time) ([]rutorItem, error) {
	srcs := curCfg().TorznabSources
	var (
		mu    sync.Mutex
		wg    sync.WaitGroup
		lists [][]rutorItem
		errs  []string
	)
	for _, s := range srcs {
		for _, cat := range torznabCatsTop {
			wg.Add(1)
			go func(name, addr, key, cat string) {
				defer wg.Done()
				items, err := fetchTorznab(addr, key, "", cat, 0)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					errs = append(errs, name+": "+err.Error())
					return
				}
				var day []rutorItem
				for _, it := range items {
					if t, ok := torznabDate(it.Date); ok && now.Sub(t) < 30*time.Hour && t.Sub(now) < 12*time.Hour {
						day = append(day, it)
					}
				}
				lists = append(lists, day)
			}(s.Name, s.URL, s.APIKey, cat)
		}
	}
	wg.Wait()
	out := mergeTop(lists...)
	if len(out) == 0 {
		if len(errs) > 0 {
			return nil, errors.New(errs[0])
		}
		return nil, errors.New("в ленте нет свежих раздач (индексатор не отдаёт последние без запроса)")
	}
	return out, nil
}

// top24FromTrends — тренды TMDB за день, найденные через индексаторы. По
// каждому названию берётся раздача с наибольшим числом сидов.
func (c *Comp) top24FromTrends() ([]rutorItem, error) {
	var titles []string
	for _, kind := range []string{"movie", "tv"} {
		u, _ := discoverURL(kind, "", "any", "trending_day", 1)
		body, err := discoverFetch(u)
		if err != nil {
			continue
		}
		items, _, err := parseDiscover(body, kind, "any", "trending_day")
		if err != nil {
			continue
		}
		for _, it := range items {
			titles = append(titles, it.Title)
		}
	}
	if len(titles) == 0 {
		return nil, errors.New("TMDB не ответил")
	}
	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		out []rutorItem
	)
	lanes := make(chan struct{}, 4)
	for _, t := range titles {
		wg.Add(1)
		go func(t string) {
			defer wg.Done()
			lanes <- struct{}{}
			defer func() { <-lanes }()
			res, err := c.torznabSearchAll(t, "", 0)
			if err != nil {
				return
			}
			best := -1
			for i, it := range res.Items {
				if !matchSub(it.Title, t) {
					continue
				}
				if best < 0 || it.Seed > res.Items[best].Seed {
					best = i
				}
			}
			if best >= 0 {
				mu.Lock()
				out = append(out, res.Items[best])
				mu.Unlock()
			}
		}(t)
	}
	wg.Wait()
	if len(out) == 0 {
		return nil, errors.New("индексаторы ничего не нашли")
	}
	return mergeTop(out), nil
}
