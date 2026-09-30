package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const discoverSample = `{"page":1,"total_pages":3,"results":[
 {"id":1,"title":"Матрица","original_title":"The Matrix","original_language":"en","release_date":"1999-03-30","poster_path":"/m.jpg","vote_average":8.2,"vote_count":25000},
 {"id":2,"title":"Брат","original_title":"Брат","original_language":"ru","release_date":"1997-05-17","poster_path":"","vote_average":7.9,"vote_count":3000},
 {"id":3,"title":"","original_language":"en"}]}`

func TestDiscoverURL(t *testing.T) {
	u, ok := discoverURL("movie", "28", "ru", "", 2)
	if !ok || !strings.Contains(u, "/discover/movie?") || !strings.Contains(u, "with_genres=28") ||
		!strings.Contains(u, "with_original_language=ru") || !strings.Contains(u, "sort_by=vote_count.desc") ||
		!strings.Contains(u, "page=2") {
		t.Fatalf("адрес собран неверно: %q", u)
	}
	if _, ok := discoverURL("person", "", "", "", 1); ok {
		t.Error("неизвестный вид должен отвергаться")
	}
	if _, ok := discoverURL("movie", "28&x=1", "", "", 1); ok {
		t.Error("жанр не из цифр должен отвергаться")
	}
}

func TestParseDiscoverForeignFilter(t *testing.T) {
	items, total, err := parseDiscover([]byte(discoverSample), "movie", "foreign", "")
	if err != nil || total != 3 {
		t.Fatalf("err=%v total=%d", err, total)
	}
	if len(items) != 1 || items[0].Title != "Матрица" || items[0].Year != "1999" || items[0].OriginalTitle != "The Matrix" {
		t.Fatalf("зарубежный фильтр: %+v", items)
	}
	if !strings.HasSuffix(items[0].Poster, "/w342/m.jpg") {
		t.Errorf("постер: %q", items[0].Poster)
	}
	all, _, _ := parseDiscover([]byte(discoverSample), "movie", "", "")
	if len(all) != 2 {
		t.Errorf("без фильтра ожидали 2 (пустое название отбрасывается), получили %d", len(all))
	}
}

func TestApiDiscover(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Write([]byte(discoverSample))
	}))
	t.Cleanup(srv.Close)
	old := tmdbAPIBase
	tmdbAPIBase = srv.URL
	t.Cleanup(func() {
		tmdbAPIBase = old
		discoverCache.Range(func(k, _ any) bool { discoverCache.Delete(k); return true })
	})

	setCfg(&Config{})
	rec := httptest.NewRecorder()
	(&Comp{}).apiDiscover(rec, httptest.NewRequest("GET", "/api/discover?kind=movie", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("без ключа TMDB ожидали 503, получили %d", rec.Code)
	}

	setCfg(&Config{TMDBApiKey: "K"})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	rec = httptest.NewRecorder()
	(&Comp{}).apiDiscover(rec, httptest.NewRequest("GET", "/api/discover?kind=movie&genre=878&origin=foreign&page=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("код %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotQuery, "with_genres=878") || !strings.Contains(gotQuery, "api_key=K") {
		t.Errorf("запрос к TMDB: %q", gotQuery)
	}
	var resp struct {
		OK      bool           `json:"ok"`
		Items   []discoverItem `json:"items"`
		HasMore bool           `json:"has_more"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if !resp.OK || len(resp.Items) != 1 || !resp.HasMore {
		t.Fatalf("ответ: %+v", resp)
	}

	rec = httptest.NewRecorder()
	(&Comp{}).apiDiscover(rec, httptest.NewRequest("GET", "/api/discover?kind=music", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("неверный вид: код %d", rec.Code)
	}
}

// Разделы «Аниме», «Мультфильмы», «Документальное» сами задают жанр: выбор
// жанра в списке для них не действует, а чужой раздел отвергается.
func TestDiscoverURLSections(t *testing.T) {
	anime, ok := discoverURL("tv", "28", "foreign", "anime", 1)
	if !ok || !strings.Contains(anime, "with_genres=16") || !strings.Contains(anime, "with_original_language=ja") {
		t.Errorf("аниме: %q", anime)
	}
	cartoon, _ := discoverURL("movie", "", "ru", "cartoon", 1)
	if !strings.Contains(cartoon, "with_genres=16") || !strings.Contains(cartoon, "without_keywords=210024") || !strings.Contains(cartoon, "with_original_language=ru") {
		t.Errorf("мультфильмы: %q", cartoon)
	}
	doc, _ := discoverURL("movie", "", "", "doc", 1)
	if !strings.Contains(doc, "with_genres=99") {
		t.Errorf("документальное: %q", doc)
	}
	if _, ok := discoverURL("movie", "", "", "porn", 1); ok {
		t.Error("неизвестный раздел принят")
	}
}

// В мультфильмах не должно быть аниме, даже если у него нет ключевого слова.
func TestParseDiscoverCartoonsDropJapanese(t *testing.T) {
	body := []byte(`{"total_pages":1,"results":[
 {"id":1,"title":"Шрек","original_language":"en","vote_count":9},
 {"id":2,"title":"Унесённые призраками","original_language":"ja","vote_count":9}]}`)
	items, _, err := parseDiscover(body, "movie", "any", "cartoon")
	if err != nil || len(items) != 1 || items[0].ID != 1 {
		t.Errorf("мультфильмы = %+v, %v; ожидался только Шрек", items, err)
	}
	items, _, _ = parseDiscover(body, "movie", "any", "anime")
	if len(items) != 2 {
		t.Errorf("аниме: %d записей, ожидалось 2", len(items))
	}
}

// «Сейчас смотрят» — недельные тренды TMDB, а не подборка по голосам.
func TestDiscoverURLTrending(t *testing.T) {
	u, ok := discoverURL("tv", "18", "any", "trending", 2)
	if !ok || !strings.Contains(u, "/trending/tv/week?") || !strings.Contains(u, "page=2") || strings.Contains(u, "with_genres") {
		t.Errorf("тренды: %q", u)
	}
}

func TestDiscoverTrendingToday(t *testing.T) {
	u, ok := discoverURL("movie", "", "any", "trending_day", 3)
	if !ok || !strings.Contains(u, "/trending/movie/day?") || !strings.Contains(u, "page=3") {
		t.Fatalf("тренды за сегодня: %q %v", u, ok)
	}
	body := []byte(`{"total_pages":5,"results":[{"id":1,"title":"Фильм","original_language":"en"},{"id":2,"title":"Кино","original_language":"ru"}]}`)
	items, _, err := parseDiscover(body, "movie", "ru", "trending_day")
	if err != nil || len(items) != 1 || items[0].ID != 2 {
		t.Fatalf("русское в трендах за сегодня: %+v %v", items, err)
	}
}
