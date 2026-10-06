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

// fetchTop24All собирает ТОП суток. source — откуда он: rutor или индексаторы.
func (c *Comp) fetchTop24All() ([]rutorItem, string, error) {
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
		return mergeTop(append([][]rutorItem{block}, fresh...)...), "rutor", nil
	}
	items, err := c.top24FromIndexers()
	if err != nil {
		reason := "rutor не отвечает"
		if len(errs) > 0 {
			reason = errs[0]
		}
		return nil, "", errors.New(reason + "; запасной путь: " + err.Error())
	}
	return items, "indexers", nil
}

// top24FromIndexers — запасной ТОП: тренды TMDB за день, найденные через
// индексаторы. По каждому названию берётся раздача с наибольшим числом сидов.
func (c *Comp) top24FromIndexers() ([]rutorItem, error) {
	if len(curCfg().TorznabSources) == 0 {
		return nil, errors.New("индексаторы не подключены (Настройки → Torznab, например JacRed)")
	}
	if !tmdbConfigured() {
		return nil, errors.New("нужен ключ TMDB, чтобы узнать, что смотрят сегодня")
	}
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
