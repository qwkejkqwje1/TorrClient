package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestTranslitToCyr(t *testing.T) {
	for in, want := range map[string]string{
		"Trudno byt bogom": "трудно быт богом",
		"Slovo patsana":    "слово пацана",
		"Shchit i mech":    "щит и меч",
		"Zhizn":            "жизн",
		"Игра престолов":   "",
		"2012":             "",
	} {
		if got := translitToCyr(in); got != want {
			t.Errorf("translitToCyr(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestQueryTmdbPrefersTheSeriesWithPoster: «Rick and Morty» среди фильмов
// находит чужой фильм без постера — ответом должен стать сериал из общего поиска.
func TestQueryTmdbPrefersTheSeriesWithPoster(t *testing.T) {
	useTmdbKey(t, "k")
	useTmdbStub(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/search/movie"):
			w.Write([]byte(`{"results":[{"id":1,"title":"Rick and Morty: Behind the Scenes","poster_path":""}]}`))
		case strings.HasSuffix(r.URL.Path, "/search/multi"):
			w.Write([]byte(`{"results":[{"id":5,"media_type":"person","name":"Rick and Morty"},{"id":60625,"media_type":"tv","name":"Рик и Морти","original_name":"Rick and Morty","first_air_date":"2013-12-02","poster_path":"/rm.jpg"}]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	})
	res := (&Comp{}).queryTmdb("Rick and Morty", "")
	if !res.OK || res.ID != 60625 || res.Type != "tv" || !strings.HasSuffix(res.Poster, "/rm.jpg") {
		t.Fatalf("ожидался сериал с постером: %+v", res)
	}
}
