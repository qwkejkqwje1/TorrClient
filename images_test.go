package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
)

// TestImgFallsBackToTheMirrorAndCaches: если image.tmdb.org не отвечает,
// картинка берётся с зеркала, а второй раз — уже с диска.
func TestImgFallsBackToTheMirrorAndCaches(t *testing.T) {
	old := cfg.Load()
	cfg.Store(&Config{DataFolder: t.TempDir()})
	defer cfg.Store(old)

	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "blocked", http.StatusForbidden)
	}))
	defer dead.Close()
	var hits atomic.Int32
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write([]byte("JPEGDATA:" + r.URL.Path))
	}))
	defer mirror.Close()
	oldHosts := imgHosts
	imgHosts = []string{dead.URL, mirror.URL}
	defer func() { imgHosts = oldHosts; imgGood.Store(0) }()
	imgGood.Store(0)

	c := &Comp{}
	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		c.apiImg(rec, httptest.NewRequest("GET", "/api/img?p="+p, nil))
		return rec
	}
	for i := 0; i < 2; i++ {
		rec := get("/t/p/w342/abcDEF123.jpg")
		if rec.Code != 200 || rec.Body.String() != "JPEGDATA:/t/p/w342/abcDEF123.jpg" {
			t.Fatalf("попытка %d: %d %q", i, rec.Code, rec.Body.String())
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("второй раз картинка должна прийти из кэша, запросов к зеркалу: %d", hits.Load())
	}
	if imgGood.Load() != 1 {
		t.Fatalf("удачный хост не запомнен")
	}
	if _, err := os.Stat(imgCacheFile("/t/p/w342/abcDEF123.jpg")); err != nil {
		t.Fatalf("нет файла в кэше: %v", err)
	}
	for _, bad := range []string{"", "/etc/passwd", "/t/p/w342/../../x.jpg", "http://evil/t/p/w342/a.jpg", "/t/p/w342/abcd.exe"} {
		if rec := get(bad); rec.Code != http.StatusBadRequest {
			t.Fatalf("%q должен быть отклонён, код %d", bad, rec.Code)
		}
	}
}
