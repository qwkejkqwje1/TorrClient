package main

// Подборки TMDB: «самое популярное за всё время» по виду, жанру и происхождению.
//
// Трекеры (rutor, Кинозал) жанров не отдают, а жанровый топ нужен: «зарубежное
// кино — самое популярное за всё время». Поэтому список названий берётся из
// TMDB /discover, отсортированный по числу голосов, а сама раздача ищется уже
// по выбранному названию обычным поиском. Выдача постраничная: интерфейс
// подгружает следующие страницы по кнопке, а не режет список на первых 30.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// discoverItem — одна строка подборки.
type discoverItem struct {
	ID            int     `json:"id"`
	Kind          string  `json:"kind"`
	Title         string  `json:"title"`
	OriginalTitle string  `json:"original_title,omitempty"`
	Year          string  `json:"year,omitempty"`
	Poster        string  `json:"poster,omitempty"`
	Rating        float64 `json:"rating"`
	Votes         int     `json:"votes"`
	Overview      string  `json:"overview,omitempty"`
}

const (
	discoverMaxPage = 50               // дальше TMDB отдаёт всё менее известное
	discoverMinVote = 300              // отсекает малоизвестное с парой десятков голосов
	discoverTTL     = 30 * time.Minute // подборка за всё время почти не меняется
)

type discoverCached struct {
	at   time.Time
	body []byte
}

var discoverCache sync.Map // ключ — адрес запроса без ключа TMDB

// Разделы подборки поверх жанров. Аниме — японская анимация: у TMDB это
// жанр «мультфильм» с японским оригиналом. Мультфильмы — та же анимация без
// аниме (ключевое слово TMDB «anime» — 210024): иначе японские сериалы
// заполняли бы весь топ мультфильмов.
const (
	tmdbGenreAnimation   = "16"
	tmdbGenreDocumentary = "99"
	tmdbKeywordAnime     = "210024"
)

// discoverURL собирает адрес запроса. Жанр — только число: строка из адреса
// интерфейса не должна попасть в чужой запрос как есть. cat — раздел
// (anime, cartoon, doc) или пусто; раздел задаёт жанр сам.
func discoverURL(kind, genre, origin, cat string, page int) (string, bool) {
	if kind != "movie" && kind != "tv" {
		return "", false
	}
	if page < 1 || page > discoverMaxPage {
		page = 1
	}
	switch cat {
	case "trending", "trending_day":
		// «Сейчас смотрят» — тренды TMDB за неделю или за сегодня: что больше
		// всего смотрят и ищут прямо сейчас, а не за всё время. Жанра у
		// трендов нет.
		span := "week"
		if cat == "trending_day" {
			span = "day"
		}
		q := url.Values{}
		q.Set("language", "ru-RU")
		q.Set("page", strconv.Itoa(page))
		return tmdbAPIBase + "/trending/" + kind + "/" + span + "?" + q.Encode(), true
	case "trend_anime", "trend_cartoon":
		// «Сейчас смотрят» аниме и мультфильмы. В общих трендах TMDB их почти
		// нет — там всё забирают фильмы и сериалы. Поэтому здесь подборка по
		// текущей популярности внутри жанра: это и есть «смотрят сейчас».
		q := url.Values{}
		q.Set("language", "ru-RU")
		q.Set("sort_by", "popularity.desc")
		q.Set("include_adult", "false")
		q.Set("vote_count.gte", "20")
		q.Set("with_genres", tmdbGenreAnimation)
		q.Set("page", strconv.Itoa(page))
		if cat == "trend_anime" {
			q.Set("with_original_language", "ja")
		} else {
			q.Set("without_keywords", tmdbKeywordAnime)
			if origin == "ru" {
				q.Set("with_original_language", "ru")
			}
		}
		return tmdbAPIBase + "/discover/" + kind + "?" + q.Encode(), true
	case "":
	case "anime", "cartoon":
		genre = tmdbGenreAnimation
	case "doc":
		genre = tmdbGenreDocumentary
	default:
		return "", false
	}
	if page < 1 || page > discoverMaxPage {
		page = 1
	}
	q := url.Values{}
	q.Set("language", "ru-RU")
	q.Set("sort_by", "vote_count.desc")
	q.Set("include_adult", "false")
	q.Set("vote_count.gte", strconv.Itoa(discoverMinVote))
	q.Set("page", strconv.Itoa(page))
	if genre != "" {
		if _, err := strconv.Atoi(genre); err != nil {
			return "", false
		}
		q.Set("with_genres", genre)
	}
	switch {
	case cat == "anime":
		q.Set("with_original_language", "ja")
	case origin == "ru":
		q.Set("with_original_language", "ru")
	}
	if cat == "cartoon" {
		q.Set("without_keywords", tmdbKeywordAnime)
	}
	return tmdbAPIBase + "/discover/" + kind + "?" + q.Encode(), true
}

// parseDiscover разбирает ответ TMDB. Для origin=foreign отбрасывает русские
// оригиналы: у TMDB нет фильтра «кроме этого языка», поэтому — после запроса.
//
// Для мультфильмов отбрасываются и японские оригиналы: ключевое слово «anime»
// стоит не у всех аниме, а язык оригинала не врёт.
func parseDiscover(body []byte, kind, origin, cat string) ([]discoverItem, int, error) {
	var resp struct {
		TotalPages int `json:"total_pages"`
		Results    []struct {
			ID               int     `json:"id"`
			Title            string  `json:"title"`
			Name             string  `json:"name"`
			OriginalTitle    string  `json:"original_title"`
			OriginalName     string  `json:"original_name"`
			OriginalLanguage string  `json:"original_language"`
			ReleaseDate      string  `json:"release_date"`
			FirstAirDate     string  `json:"first_air_date"`
			PosterPath       string  `json:"poster_path"`
			VoteAverage      float64 `json:"vote_average"`
			VoteCount        int     `json:"vote_count"`
			Overview         string  `json:"overview"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, 0, err
	}
	out := make([]discoverItem, 0, len(resp.Results))
	for _, r := range resp.Results {
		if origin == "foreign" && r.OriginalLanguage == "ru" {
			continue
		}
		if (cat == "cartoon" || cat == "trend_cartoon") && r.OriginalLanguage == "ja" {
			continue
		}
		// У трендов нет фильтра по языку в запросе — русское отбирается здесь.
		if strings.HasPrefix(cat, "trending") && origin == "ru" && r.OriginalLanguage != "ru" {
			continue
		}
		title, orig, date := r.Title, r.OriginalTitle, r.ReleaseDate
		if kind == "tv" {
			title, orig, date = r.Name, r.OriginalName, r.FirstAirDate
		}
		if strings.TrimSpace(title) == "" {
			continue
		}
		if orig == title {
			orig = ""
		}
		year := ""
		if len(date) >= 4 {
			year = date[:4]
		}
		out = append(out, discoverItem{
			ID: r.ID, Kind: kind, Title: title, OriginalTitle: orig, Year: year,
			Poster: tmdbImage(r.PosterPath, "w342"), Rating: r.VoteAverage, Votes: r.VoteCount,
			Overview: r.Overview,
		})
	}
	return out, resp.TotalPages, nil
}

// apiDiscover — GET /api/discover?kind=movie|tv&genre=<id>&origin=any|foreign|ru&cat=anime|cartoon|doc|trending|trending_day&page=N
func (c *Comp) apiDiscover(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind := strings.TrimSpace(q.Get("kind"))
	if kind == "" {
		kind = "movie"
	}
	origin := strings.TrimSpace(q.Get("origin"))
	page := atoiSafe(q.Get("page"))
	if page < 1 {
		page = 1
	}
	cat := strings.TrimSpace(q.Get("cat"))
	target, ok := discoverURL(kind, strings.TrimSpace(q.Get("genre")), origin, cat, page)
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "неверные параметры подборки")
		return
	}
	if !tmdbConfigured() {
		writeJSONError(w, http.StatusServiceUnavailable, "ключ TMDB не задан: Настройки → TMDB")
		return
	}
	body, err := discoverFetch(target)
	if err != nil {
		code := http.StatusBadGateway
		if err.Error() == errTMDBBadKey {
			code = http.StatusUnauthorized
		}
		writeJSONError(w, code, err.Error())
		return
	}
	items, total, err := parseDiscover(body, kind, origin, cat)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "ответ TMDB не разобран")
		return
	}
	jj(w, map[string]any{
		"ok":       true,
		"items":    items,
		"page":     page,
		"has_more": page < total && page < discoverMaxPage,
	})
}

// discoverFetch забирает страницу подборки, кэшируя её на discoverTTL.
func discoverFetch(target string) ([]byte, error) {
	if v, ok := discoverCache.Load(target); ok {
		if e := v.(discoverCached); time.Since(e.at) < discoverTTL {
			return e.body, nil
		}
	}
	req, err := tmdbRequest(target)
	if err != nil {
		return nil, err
	}
	resp, err := tmdbClient.Do(req)
	if err != nil {
		return nil, errString("TMDB недоступен")
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<21))
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, errString(errTMDBBadKey)
	case resp.StatusCode != http.StatusOK:
		return nil, errString("TMDB http " + strconv.Itoa(resp.StatusCode))
	}
	discoverCache.Store(target, discoverCached{at: time.Now(), body: body})
	return body, nil
}

type errString string

func (e errString) Error() string { return string(e) }
