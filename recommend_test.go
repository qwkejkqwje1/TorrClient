package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestApiRecommend(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case strings.HasPrefix(p, "/search/"):
			id := 603
			if strings.Contains(r.URL.Query().Get("query"), "Интерстеллар") {
				id = 157336
			}
			fmt.Fprintf(w, `{"results":[{"id":%d,"title":"%s","release_date":"2000-01-01"}]}`, id, r.URL.Query().Get("query"))
		case p == "/movie/603/recommendations":
			w.Write([]byte(`{"results":[{"id":1,"title":"А","vote_count":1000,"vote_average":8},{"id":157336,"title":"Интерстеллар","vote_count":9000},{"id":2,"title":"Б","vote_count":500}]}`))
		case p == "/movie/157336/recommendations":
			w.Write([]byte(`{"results":[{"id":1,"title":"А","vote_count":1000,"vote_average":8},{"id":3,"title":"В","vote_count":10}]}`))
		default:
			w.Write([]byte(`{"results":[]}`))
		}
	}))
	t.Cleanup(srv.Close)
	old := tmdbAPIBase
	tmdbAPIBase = srv.URL
	oldCfg := cfg.Load()
	t.Cleanup(func() {
		tmdbAPIBase = old
		cfg.Store(oldCfg)
		discoverCache.Range(func(k, _ any) bool { discoverCache.Delete(k); return true })
	})
	setCfg(&Config{TMDBApiKey: "K"})

	body, _ := json.Marshal(map[string]any{"items": []recSeed{{Q: "Матрица рек"}, {Q: "Интерстеллар рек"}, {Q: "Матрица рек"}}})
	rec := httptest.NewRecorder()
	(&Comp{}).apiRecommend(rec, httptest.NewRequest("POST", "/api/recommend", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("код %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Items   []recItem `json:"items"`
		Seeds   int       `json:"seeds"`
		Matched int       `json:"matched"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Seeds != 2 || resp.Matched != 2 {
		t.Fatalf("повторы не убраны или не сопоставлены: %+v", resp)
	}
	if len(resp.Items) != 2 {
		t.Fatalf("ожидали А и Б (своё и малоизвестное убраны): %+v", resp.Items)
	}
	if resp.Items[0].ID != 1 || len(resp.Items[0].Because) != 2 {
		t.Fatalf("первым должен быть фильм, который советуют к обоим: %+v", resp.Items[0])
	}
}

// Совет к досмотренному или Избранному весит больше, чем к раздаче «на потом»:
// при равной позиции в списках выше окажется то, что похоже на любимое, и в
// «похоже на» оно стоит первым.
func TestMergeRecsWeights(t *testing.T) {
	seeds := []TMDBRes{{OK: true, ID: 1, Type: "movie", Title: "Лежит"}, {OK: true, ID: 2, Type: "movie", Title: "Любимое"}}
	a := discoverItem{ID: 10, Kind: "movie", Title: "A", Votes: 1000, Rating: 7}
	b := discoverItem{ID: 11, Kind: "movie", Title: "B", Votes: 1000, Rating: 7}
	both := discoverItem{ID: 12, Kind: "movie", Title: "C", Votes: 1000, Rating: 7}
	out := mergeRecs(seeds, [][]discoverItem{{a, both}, {b, both}}, []float64{1, 2})
	if len(out) != 3 || out[0].ID != 12 || out[1].ID != 11 {
		t.Fatalf("порядок: %+v", out)
	}
	if out[0].Because[0] != "Любимое" {
		t.Errorf("похоже на: %v, первым ожидалось «Любимое»", out[0].Because)
	}
	if (recSeed{}).weight() != 1 || (recSeed{W: 9}).weight() != 3 {
		t.Error("вес по умолчанию 1 и не больше 3")
	}
}
