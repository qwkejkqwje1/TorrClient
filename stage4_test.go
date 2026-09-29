package main

// Тесты этапа 4: «популярное» (rutor по сидам) и прокси к TorrServer.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// popularStub подменяет rutor страницей-эталоном и запоминает запрошенный путь.
func popularStub(t *testing.T, status int) (path *string) {
	t.Helper()
	doc := loadFixture(t, "rutor_search.html")
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Path
		if status != http.StatusOK {
			http.Error(w, "нет", status)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, doc)
	}))
	t.Cleanup(srv.Close)
	oldBase, oldMirrors := rutorBaseURL, rutorMirrorURLs
	rutorBaseURL, rutorMirrorURLs = srv.URL, nil
	t.Cleanup(func() { rutorBaseURL, rutorMirrorURLs = oldBase, oldMirrors })
	resetRutorCache()
	return &got
}

func TestApiPopular(t *testing.T) {
	path := popularStub(t, http.StatusOK)
	rec := httptest.NewRecorder()
	(&Comp{}).apiPopular(rec, httptest.NewRequest("GET", "/api/popular?page=1&cat=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("код %d: %s", rec.Code, rec.Body.String())
	}
	if *path != "/browse/1/1/0/2" {
		t.Errorf("запрошен путь %q, ожидался каталог с сортировкой по сидам (/browse/1/1/0/2): пустой поиск rutor отдаёт пустую страницу", *path)
	}
	var resp struct {
		OK      bool        `json:"ok"`
		Items   []rutorItem `json:"items"`
		Page    int         `json:"page"`
		HasMore bool        `json:"has_more"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("ответ не JSON: %v", err)
	}
	if !resp.OK || len(resp.Items) == 0 || resp.Page != 1 || !resp.HasMore {
		t.Fatalf("неверный ответ: ok=%v items=%d page=%d has_more=%v", resp.OK, len(resp.Items), resp.Page, resp.HasMore)
	}
	for i := 1; i < len(resp.Items); i++ {
		if resp.Items[i-1].Seed < resp.Items[i].Seed {
			t.Fatalf("раздачи не отсортированы по сидам на позиции %d", i)
		}
	}
}

func TestApiPopularClampsPageAndReportsFailure(t *testing.T) {
	popularStub(t, http.StatusOK)
	rec := httptest.NewRecorder()
	(&Comp{}).apiPopular(rec, httptest.NewRequest("GET", "/api/popular?page=9999", nil))
	var resp struct {
		Page    int  `json:"page"`
		HasMore bool `json:"has_more"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Page != 0 {
		t.Errorf("страница за пределом должна сбрасываться на 0, получили %d", resp.Page)
	}

	popularStub(t, http.StatusServiceUnavailable)
	rec = httptest.NewRecorder()
	(&Comp{}).apiPopular(rec, httptest.NewRequest("GET", "/api/popular", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("недоступный rutor должен давать 502, получили %d", rec.Code)
	}
}

// Прокси: передаёт метод, путь без префикса /ts и запрос, подставляет пароль
// профиля, сохраняет длину и код 206 у частичного ответа.
func TestHandleProxyForwards(t *testing.T) {
	var gotPath, gotQuery, gotUser, gotPass string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		gotUser, gotPass, _ = r.BasicAuth()
		w.Header().Set("Content-Range", "bytes 0-4/100")
		w.Header().Set("Content-Length", "5")
		w.WriteHeader(http.StatusPartialContent)
		io.WriteString(w, "hello")
	}))
	t.Cleanup(up.Close)
	setCfg(&Config{Profiles: []*Profile{{ID: "a", URL: up.URL + "/", User: "u", Pass: "p"}}, ActiveProfileID: "a"})
	t.Cleanup(func() { setCfg(defaultConfig()) })

	rec := httptest.NewRecorder()
	(&Comp{}).handleProxy(rec, httptest.NewRequest("GET", "/ts/echo?x=1", nil))
	if gotPath != "/echo" || gotQuery != "x=1" {
		t.Errorf("до сервера дошло %q?%q, ожидалось /echo?x=1", gotPath, gotQuery)
	}
	if gotUser != "u" || gotPass != "p" {
		t.Errorf("логин и пароль профиля не переданы: %q/%q", gotUser, gotPass)
	}
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "hello" {
		t.Errorf("ответ: %d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Range") != "bytes 0-4/100" {
		t.Errorf("Content-Range потерян: %q", rec.Header().Get("Content-Range"))
	}
	if rec.Header().Get("Content-Length") != "5" {
		t.Errorf("Content-Length у частичного ответа потерян: %q", rec.Header().Get("Content-Length"))
	}
}

func TestHandleProxyServerDown(t *testing.T) {
	up := httptest.NewServer(http.NotFoundHandler())
	url := up.URL
	up.Close()
	setCfg(&Config{Profiles: []*Profile{{ID: "a", URL: url}}, ActiveProfileID: "a"})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	rec := httptest.NewRecorder()
	(&Comp{}).handleProxy(rec, httptest.NewRequest("GET", "/ts/echo", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("недоступный TorrServer должен давать 502, получили %d", rec.Code)
	}
}

func TestHostGuard(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := hostGuard(ok)
	for host, want := range map[string]int{
		"127.0.0.1:8099": http.StatusOK,
		"localhost:8099": http.StatusOK,
		"LOCALHOST":      http.StatusOK,
		"evil.example":   http.StatusForbidden,
		"127.0.0.1.evil": http.StatusForbidden,
	} {
		req := httptest.NewRequest("GET", "/api/hello", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Host %q: код %d, ожидался %d", host, rec.Code, want)
		}
	}
}
