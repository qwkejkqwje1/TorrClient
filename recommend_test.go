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
