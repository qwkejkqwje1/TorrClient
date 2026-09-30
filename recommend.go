package main

// Рекомендации по библиотеке.
//
// Каждая раздача библиотеки сопоставляется с фильмом или сериалом TMDB (тем же
// поиском, что даёт постеры, и через тот же кэш), для каждого берутся
// рекомендации TMDB, и они складываются: фильм, который советуют сразу к
// нескольким вашим, поднимается выше. Уже имеющееся в библиотеке не
// предлагается.

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

const (
	recommendMaxSeeds = 30
	recommendMaxOut   = 60
	recommendMinVotes = 50
)

type recSeed struct {
	Q    string `json:"q"`
	Year int    `json:"year"`
}

type recItem struct {
	discoverItem
	Because []string `json:"because"`
	score   float64
}

// resolveSeed находит фильм/сериал TMDB для названия из библиотеки; ответ
// кэшируется тем же ключом, что у /api/tmdb.
func (c *Comp) resolveSeed(s recSeed) TMDBRes {
	year := ""
	if s.Year > 0 {
		year = strconv.Itoa(s.Year)
	}
	key := strings.ToLower(s.Q) + "|" + year
	if it, ok := tmdbGet(key); ok {
		return it.res
	}
	res := c.queryTmdb(s.Q, year)
	if res.OK {
		tmdbPut(key, tmdbItem{res: res})
	} else if res.Error == "not found" {
		tmdbPut(key, tmdbItem{neg: true})
	}
	return res
}

// mergeRecs складывает списки рекомендаций. Вес позиции убывает по списку:
// первая рекомендация TMDB к фильму значит больше двадцатой.
func mergeRecs(seeds []TMDBRes, lists [][]discoverItem) []recItem {
	own := map[string]bool{}
	for _, s := range seeds {
		if s.OK {
			own[s.Type+":"+strconv.Itoa(s.ID)] = true
		}
	}
	acc := map[string]*recItem{}
	for i, list := range lists {
		for pos, it := range list {
			k := it.Kind + ":" + strconv.Itoa(it.ID)
			if own[k] || it.Votes < recommendMinVotes {
				continue
			}
			r := acc[k]
			if r == nil {
				r = &recItem{discoverItem: it}
				acc[k] = r
			}
			r.score += 1 + float64(20-min(pos, 20))/20
			if len(r.Because) < 3 && i < len(seeds) {
				r.Because = append(r.Because, seeds[i].Title)
			}
		}
	}
	out := make([]recItem, 0, len(acc))
	for _, r := range acc {
		// Небольшая добавка за оценку и известность: при равном счёте выше
		// окажется то, что понравилось многим.
		r.score += r.Rating/10 + math.Log10(1+float64(r.Votes))/10
		out = append(out, *r)
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].score != out[b].score {
			return out[a].score > out[b].score
		}
		return out[a].ID < out[b].ID
	})
	if len(out) > recommendMaxOut {
		out = out[:recommendMaxOut]
	}
	return out
}

// apiRecommend — POST /api/recommend {items:[{q,year}]}: рекомендации к
// названиям из библиотеки.
func (c *Comp) apiRecommend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "POST")
		return
	}
	if !tmdbConfigured() {
		writeJSONError(w, http.StatusServiceUnavailable, "ключ TMDB не задан: Настройки → TMDB")
		return
	}
	var req struct {
		Items []recSeed `json:"items"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad json")
		return
	}
	var seedsIn []recSeed
	seen := map[string]bool{}
	for _, s := range req.Items {
		s.Q = strings.TrimSpace(s.Q)
		k := strings.ToLower(s.Q) + "|" + strconv.Itoa(s.Year)
		if len([]rune(s.Q)) < 2 || seen[k] {
			continue
		}
		seen[k] = true
		seedsIn = append(seedsIn, s)
		if len(seedsIn) == recommendMaxSeeds {
			break
		}
	}
	if len(seedsIn) == 0 {
		jj(w, map[string]any{"ok": true, "items": []recItem{}, "seeds": 0})
		return
	}
	seeds := make([]TMDBRes, len(seedsIn))
	lists := make([][]discoverItem, len(seedsIn))
	var badKey bool
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, s := range seedsIn {
		wg.Add(1)
		go func(i int, s recSeed) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			res := c.resolveSeed(s)
			if res.Error == errTMDBBadKey {
				mu.Lock()
				badKey = true
				mu.Unlock()
			}
			seeds[i] = res
			if !res.OK || res.ID == 0 {
				return
			}
			kind := res.Type
			if kind != "tv" {
				kind = "movie"
			}
			body, err := discoverFetch(tmdbAPIBase + "/" + kind + "/" + strconv.Itoa(res.ID) + "/recommendations?language=ru-RU&page=1")
			if err != nil {
				return
			}
			items, _, err := parseDiscover(body, kind, "", "")
			if err == nil {
				lists[i] = items
			}
		}(i, s)
	}
	wg.Wait()
	if badKey {
		writeJSONError(w, http.StatusUnauthorized, errTMDBBadKey)
		return
	}
	matched := 0
	for _, s := range seeds {
		if s.OK {
			matched++
		}
	}
	jj(w, map[string]any{"ok": true, "items": mergeRecs(seeds, lists), "seeds": len(seedsIn), "matched": matched})
}
