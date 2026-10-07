package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// feedStub — индексатор, который отвечает и на пустой запрос (лента последних
// раздач): одна свежая раздача, одна старая.
func feedStub(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fresh := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC1123Z)
		old := time.Now().Add(-10 * 24 * time.Hour).UTC().Format(time.RFC1123Z)
		cat := r.URL.Query().Get("cat")
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = fmt.Fprintf(w, `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>`+
			`<item><title>Свежий %[1]s</title><link>magnet:?xt=urn:btih:%[2]s</link><pubDate>%[3]s</pubDate>`+
			`<torznab:attr name="seeders" value="40"/><torznab:attr name="peers" value="5"/><torznab:attr name="infohash" value="%[2]s"/></item>`+
			`<item><title>Старый %[1]s</title><link>magnet:?xt=urn:btih:%[4]s</link><pubDate>%[5]s</pubDate>`+
			`<torznab:attr name="seeders" value="900"/><torznab:attr name="infohash" value="%[4]s"/></item>`+
			`</channel></rss>`, cat, strings.Repeat(cat[:1], 40), fresh, strings.Repeat("e", 40), old)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ТОП суток не зависит от rutor: при выключенном rutor и подключённом
// индексаторе он собирается из ленты индексатора, старые раздачи отсеиваются.
func TestTop24WorksWithoutRutor(t *testing.T) {
	srv := feedStub(t)
	setCfg(&Config{RutorOff: true, TorznabSources: []TorznabSource{{Name: "Лента", URL: srv.URL, APIKey: "K"}}})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	items, source, err := (&Comp{}).fetchTop24All()
	if err != nil {
		t.Fatalf("ТОП без rutor не собрался: %v", err)
	}
	if source != "indexers" {
		t.Errorf("источник %q, ожидали indexers", source)
	}
	if len(items) != 2 { // по одной свежей на категорию 2000 и 5000
		t.Fatalf("ожидали 2 свежие раздачи, получили %d: %+v", len(items), items)
	}
	for _, it := range items {
		if strings.HasPrefix(it.Title, "Старый") {
			t.Errorf("старая раздача попала в ТОП суток: %q", it.Title)
		}
	}
}

func TestTop24NothingAvailable(t *testing.T) {
	setCfg(&Config{RutorOff: true})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	_, _, err := (&Comp{}).fetchTop24All()
	if err == nil || !strings.Contains(err.Error(), "rutor выключен") || !strings.Contains(err.Error(), "индексаторы не подключены") {
		t.Fatalf("ошибка должна называть обе причины: %v", err)
	}
}

func TestTorznabDate(t *testing.T) {
	for in, want := range map[string]bool{
		"Mon, 02 Jan 2006 15:04:05 +0000": true,
		"2026-10-07T12:00:00Z":            true,
		"2026-10-07 12:00:00":             true,
		"":                                false,
		"вчера":                           false,
	} {
		if _, ok := torznabDate(in); ok != want {
			t.Errorf("torznabDate(%q)=%v", in, ok)
		}
	}
}

// Выключенный rutor не опрашивается ни одной ручкой, а «Популярное» уходит в
// индексаторы.
func TestRutorOffGatesAndPopularFallsBack(t *testing.T) {
	srv := feedStub(t)
	setCfg(&Config{RutorOff: true, TorznabSources: []TorznabSource{{Name: "Лента", URL: srv.URL, APIKey: "K"}}})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	c := &Comp{}
	if _, err := c.rutorSearch("matrix", 0, 0); err != errRutorOff {
		t.Errorf("поиск rutor при выключенном: %v", err)
	}
	if _, err := c.fetchRutorFrom("/top/1", nil); err != errRutorOff {
		t.Errorf("fetchRutorFrom при выключенном: %v", err)
	}
	rec := httptest.NewRecorder()
	c.apiPopular(rec, httptest.NewRequest("GET", "/api/popular?cat=1", nil))
	var out struct {
		OK     bool        `json:"ok"`
		Source string      `json:"source"`
		Items  []rutorItem `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || !out.OK || out.Source != "indexers" || len(out.Items) == 0 {
		t.Fatalf("популярное через индексаторы: код %d, %s", rec.Code, rec.Body.String())
	}
	if out.Items[0].Seed < out.Items[len(out.Items)-1].Seed {
		t.Error("популярное не отсортировано по сидам")
	}
	rec = httptest.NewRecorder()
	c.apiRutorSettings(rec, httptest.NewRequest("GET", "/api/rutor/settings", nil))
	if !strings.Contains(rec.Body.String(), `"enabled":false`) {
		t.Errorf("настройка rutor: %s", rec.Body.String())
	}
}

func TestTorznabCatForRutor(t *testing.T) {
	if torznabCatForRutor(1) != "2000" || torznabCatForRutor(4) != "5000" || torznabCatForRutor(0) != "" {
		t.Error("соответствие категорий rutor и Torznab нарушено")
	}
}
