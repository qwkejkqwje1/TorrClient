package main

// Подписки: поиск по всем источникам и сверка с расписанием TMDB.
//
// Раньше подписка спрашивала только rutor. Аниме и мультсериалы там выходят
// реже и с другой записью серий, поэтому подписки на них молчали. Теперь
// спрашиваются и настроенные индексаторы, а при ключе TMDB подписка знает,
// какая серия уже вышла в эфир и когда ждать следующую, — даже если раздачи
// ещё нет.

import (
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// subsSearchAll ищет раздачи по rutor и по индексаторам разом. Одна выдача
// пустая или с ошибкой — не беда, если ответила другая.
func (c *Comp) subsSearchAll(q string) ([]rutorItem, error) {
	type res struct {
		items []rutorItem
		err   error
	}
	ch := make(chan res, 2)
	go func() {
		items, err := c.rutorSearchAll(q)
		ch <- res{items, err}
	}()
	n := 1
	if len(curCfg().TorznabSources) > 0 {
		n = 2
		go func() {
			r, err := c.torznabSearchAll(q, "", 0)
			ch <- res{r.Items, err}
		}()
	}
	var out []rutorItem
	var lastErr error
	seen := map[string]bool{}
	for i := 0; i < n; i++ {
		r := <-ch
		if r.err != nil {
			lastErr = r.err
			continue
		}
		for _, it := range r.items {
			k := strings.ToLower(it.Hash)
			if k == "" {
				k = normTitle(it.Title)
			}
			if seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, it)
		}
	}
	if len(out) == 0 && lastErr != nil {
		return nil, lastErr
	}
	return out, nil
}

// tvAir — что известно о выходе серий по TMDB.
type tvAir struct {
	LastSeason, LastEpisode int
	LastDate                string
	NextSeason, NextEpisode int
	NextDate                string
	Ended                   bool
}

// tmdbTvAir спрашивает у TMDB последнюю вышедшую и следующую серию.
func tmdbTvAir(id int) (tvAir, bool) {
	var air tvAir
	if id == 0 {
		return air, false
	}
	req, err := tmdbRequest(tmdbAPIBase + "/tv/" + strconv.Itoa(id) + "?language=ru-RU")
	if err != nil {
		return air, false
	}
	resp, err := tmdbClient.Do(req)
	if err != nil {
		return air, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return air, false
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	type ep struct {
		Season  int    `json:"season_number"`
		Episode int    `json:"episode_number"`
		Date    string `json:"air_date"`
	}
	var x struct {
		Status string `json:"status"`
		Last   *ep    `json:"last_episode_to_air"`
		Next   *ep    `json:"next_episode_to_air"`
	}
	if json.Unmarshal(body, &x) != nil {
		return air, false
	}
	if x.Last != nil {
		air.LastSeason, air.LastEpisode, air.LastDate = x.Last.Season, x.Last.Episode, x.Last.Date
	}
	if x.Next != nil {
		air.NextSeason, air.NextEpisode, air.NextDate = x.Next.Season, x.Next.Episode, x.Next.Date
	}
	air.Ended = x.Status == "Ended" || x.Status == "Canceled"
	return air, true
}

// noteSubAir сверяет подписку с расписанием TMDB. Объявляет «вышла серия»,
// когда в эфир вышла серия новее известной по прошлой сверке. Первая сверка
// молчит, как и первая проверка раздач.
func (c *Comp) noteSubAir(sub *subscription) {
	if !tmdbConfigured() {
		return
	}
	subsMu.Lock()
	id, title := sub.TmdbID, sub.Title
	subsMu.Unlock()
	if id == 0 {
		r := c.queryTmdbSearch("tv", title, "")
		if !r.OK || r.ID == 0 {
			return
		}
		id = r.ID
	}
	air, ok := tmdbTvAir(id)
	if !ok {
		return
	}
	subsMu.Lock()
	sub.TmdbID = id
	known := sub.AirSeason > 0 || sub.AirEpisode > 0
	aired := air.LastSeason > 0 && newerEpisode(air.LastSeason, air.LastEpisode, sub.AirSeason, sub.AirEpisode)
	sub.AirSeason, sub.AirEpisode, sub.AirDate = air.LastSeason, air.LastEpisode, air.LastDate
	sub.NextSeason, sub.NextEpisode, sub.NextAir = air.NextSeason, air.NextEpisode, air.NextDate
	sub.Ended = air.Ended
	// Раздача с этой серией уже известна — отдельного сообщения не нужно.
	have := !newerEpisode(air.LastSeason, air.LastEpisode, sub.Season, sub.Episode)
	cp := *sub
	subsMu.Unlock()
	if known && aired && !have {
		events.broadcast("subs", map[string]any{
			"id":      cp.ID,
			"title":   cp.Title,
			"aired":   true,
			"season":  cp.AirSeason,
			"episode": cp.AirEpisode,
			"date":    cp.AirDate,
			"count":   0,
		})
	}
}

// subsAirDue — расписание TMDB меняется редко: раз в шесть часов хватает.
func subsAirDue(sub *subscription) bool {
	subsMu.Lock()
	defer subsMu.Unlock()
	return time.Since(sub.AirChecked) > 6*time.Hour
}

func markSubAirChecked(sub *subscription) {
	subsMu.Lock()
	sub.AirChecked = time.Now()
	subsMu.Unlock()
}

var (
	reSubCutSE     = regexp.MustCompile(`(?i)(?:^|[\s._-])s\d{1,2}(?:[\s._-]*e\d{1,4})?(?:[\s._-]|$).*$`)
	reSubCutSeason = regexp.MustCompile(`(?i)(?:\d{1,2}\s*[-–—]\s*)?\d{1,2}\s*сезон.*$|сезон\s*\d.*$|\bseason\s*\d.*$`)
	reSubCutEps    = regexp.MustCompile(`(?i)\d{1,4}\s*(?:[-–—]\s*\d{1,4}\s*)?(?:сери|эпизод|из\s).*$`)
	reSubCutTech   = regexp.MustCompile(`(?i)(?:^|\s)(?:2160p|1080p|720p|480p|4k|web-?dl|webrip|hdtv|bdrip|hdrip)\b.*$`)
)

// cleanSubQuery превращает название раздачи в запрос для трекера.
//
// Подписка, заведённая из карточки раздачи, получала её название целиком:
// «Магическая битва / Jujutsu Kaisen [TV-2] [1-23 из 23] [2023, WEB-DL]».
// По такому запросу трекер не находит ничего, и подписка молчала всегда —
// особенно у аниме и мультсериалов, где хвост из скобок длиннее названия.
// Остаётся только название: до «/», скобок, сезона, серий и качества.
func cleanSubQuery(q string) string {
	orig := strings.TrimSpace(q)
	s := orig
	if !strings.Contains(s, " ") && strings.Count(s, ".") >= 2 {
		s = strings.NewReplacer(".", " ", "_", " ").Replace(s)
	}
	for _, sep := range []string{" / ", " | ", "[", "(", "{"} {
		if i := strings.Index(s, sep); i > 0 {
			s = s[:i]
		}
	}
	s = reSubCutSE.ReplaceAllString(s, "")
	s = reSubCutSeason.ReplaceAllString(s, "")
	s = reSubCutEps.ReplaceAllString(s, "")
	s = reSubCutTech.ReplaceAllString(s, "")
	s = strings.Trim(s, " .,:;_-–—")
	if len([]rune(s)) < 2 {
		return orig
	}
	return s
}
