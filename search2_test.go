package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMergeNewItemsStage2(t *testing.T) {
	seen := map[string]bool{}
	first := mergeNewItems(seen, []rutorItem{
		{Title: "a", Hash: "AA", Seed: 1},
		{Title: "b", Hash: "bb", Seed: 5},
		{Title: "a-dup", Hash: "aa", Seed: 9},
	})
	if len(first) != 2 {
		t.Fatalf("ожидали 2 раздачи, получили %d", len(first))
	}
	if first[0].Title != "b" {
		t.Fatalf("ожидали сортировку по сидам, первая: %q", first[0].Title)
	}
	second := mergeNewItems(seen, []rutorItem{{Title: "c", Hash: "bb"}, {Title: "d", Magnet: "magnet:?x"}})
	if len(second) != 1 || second[0].Title != "d" {
		t.Fatalf("повтор по хешу должен отсеиваться: %+v", second)
	}
}

func TestRutorPopularPathStage2(t *testing.T) {
	got := rutorPopularPath(2, 1, "a b")
	want := "/search/2/1/000/2/a+b"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if rutorPopularPath(0, 0, "") != "/search/0/0/000/2/" {
		t.Fatalf("пустой запрос должен давать «всё в категории»")
	}
}

// parseSSE разбирает ответ потока на пары «событие → данные».
func parseSSE(t *testing.T, body string) (names []string, data []map[string]any) {
	t.Helper()
	for _, block := range strings.Split(strings.TrimSpace(body), "\n\n") {
		var name, raw string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				raw += strings.TrimPrefix(line, "data: ")
			}
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatalf("кадр %q не разобран: %v", block, err)
		}
		names = append(names, name)
		data = append(data, m)
	}
	return
}

// Поток отдаёт по кадру на каждый индексатор и завершается кадром done;
// упавший индексатор виден отдельной строкой с ошибкой, а повтор одной
// раздачи у второго индексатора отсеивается.
func TestTorznabStreamEndpoint(t *testing.T) {
	good := torznabStub(t, 0)
	twin := torznabStub(t, 0)
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	t.Cleanup(bad.Close)
	setCfg(&Config{TorznabSources: []TorznabSource{
		{Name: "Первый", URL: good.URL, APIKey: "KEY"},
		{Name: "Двойник", URL: twin.URL, APIKey: "KEY"},
		{Name: "Сломанный", URL: bad.URL, APIKey: "KEY"},
	}})
	t.Cleanup(func() { setCfg(defaultConfig()) })

	rec := httptest.NewRecorder()
	(&Comp{}).apiTorznabStream(rec, httptest.NewRequest("GET", "/api/torznab/stream?query=matrix", nil))
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type=%q", ct)
	}
	names, data := parseSSE(t, rec.Body.String())
	if len(names) != 4 || names[3] != "done" {
		t.Fatalf("ожидали 3 кадра source и done, получили %v", names)
	}
	total, failed := 0, 0
	for _, d := range data[:3] {
		src := d["source"].(map[string]any)
		items, _ := d["items"].([]any)
		total += len(items)
		if ok, _ := src["ok"].(bool); !ok {
			failed++
		}
	}
	if failed != 1 {
		t.Errorf("упавших индексаторов %d вместо 1", failed)
	}
	if total != 3 {
		t.Errorf("после сведения дублей ожидали 3 раздачи, получили %d", total)
	}
	if alive := data[3]["alive"].(float64); alive != 2 {
		t.Errorf("alive=%v, ожидали 2", alive)
	}
}

func TestTorznabStreamWithoutSources(t *testing.T) {
	setCfg(&Config{})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	rec := httptest.NewRecorder()
	(&Comp{}).apiTorznabStream(rec, httptest.NewRequest("GET", "/api/torznab/stream?query=x", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("без индексаторов ожидали 503, получили %d", rec.Code)
	}
}
