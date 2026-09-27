package main

// Защитные проверки HTTP-слоя: чужая страница не должна дёргать API демона,
// а адрес извне не должен превращаться в вызов произвольного протокола.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Плееру и браузеру разрешены только http(s)-адреса: кавычка ломает разбор
// командной строки, а file:// превращает «открыть страницу» во «запустить что
// угодно».
func TestIsHTTPLink(t *testing.T) {
	ok := []string{
		"http://127.0.0.1:8099/ts/stream?link=abc",
		"https://image.tmdb.org/t/p/w342/x.jpg",
		"http://127.0.0.1:8099/playlist?hash=abc&title=%D1%81%D0%B5%D1%80%D0%B8%D0%B0%D0%BB",
	}
	for _, u := range ok {
		if !isHTTPLink(u) {
			t.Errorf("легитимный адрес отклонён: %q", u)
		}
	}
	bad := []string{
		"",
		"file:///C:/Windows/System32",
		"javascript:alert(1)",
		"http://",                      // без хоста
		"http://x/\" --http-reconnect", // кавычка ломает разбор аргументов
		"http://x/\r\n",                // перевод строки — разделитель аргументов
		"ftp://example.com/x",
	}
	for _, u := range bad {
		if isHTTPLink(u) {
			t.Errorf("опасный адрес принят: %q", u)
		}
	}
}

// Из подстановки в командную строку убираются только знаки, ломающие её
// разбор; одиночная кавычка в названии («Don't») остаётся.
func TestArgSafeStripsCommandBreakers(t *testing.T) {
	if got := argSafe("Фильм \"Терминатор\"\r\n2"); got != "Фильм Терминатор2" {
		t.Errorf("argSafe = %q", got)
	}
	if got := argSafe("Don't Look Up"); got != "Don't Look Up" {
		t.Errorf("одиночная кавычка потеряна: %q", got)
	}
}

// Чужая страница не должна управлять демоном: ни формой (Origin), ни
// кросс-сайтовым fetch'ем. Читать она и так ничего не может — CORS-заголовков
// демон не отдаёт, — поэтому безопасные методы пропускаются, а изменяющие
// отклоняются. Свои запросы и локальные вызовы без этих заголовков проходят.
//
// Отдельно закреплён путь запуска десктопной оболочки: окно живёт на своём
// хосте (wails.localhost) и переходит на UI демона обычной навигацией, то есть
// как чужой сайт. Когда такие переходы отклонялись, окно оставалось пустым и
// приложение выглядело не запускающимся.
func TestOriginGuardRejectsCrossSiteRequests(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := originGuard(ok)

	cases := []struct {
		name   string
		method string
		origin string
		fetch  string
		want   int
	}{
		{"свой GET без заголовков", "GET", "", "", http.StatusNoContent},
		{"свой POST с совпадающим Origin", "POST", "http://127.0.0.1:8099", "", http.StatusNoContent},
		{"прямая навигация", "GET", "", "none", http.StatusNoContent},
		{"запрос с того же сайта", "GET", "", "same-origin", http.StatusNoContent},

		// --- путь запуска окна-оболочки ---
		{"переход окна-оболочки на UI демона", "GET", "", "cross-site", http.StatusNoContent},
		{"проба готовности из окна-оболочки", "GET", "http://wails.localhost", "cross-site", http.StatusNoContent},

		// --- чужой источник читать может, менять — нет ---
		{"чужой GET ничего не меняет", "GET", "http://evil.example", "", http.StatusNoContent},
		{"картинка с чужого сайта", "GET", "", "cross-site", http.StatusNoContent},
		{"чужой Origin на POST", "POST", "http://evil.example", "", http.StatusForbidden},
		{"кросс-сайтовый fetch (POST)", "POST", "", "cross-site", http.StatusForbidden},
		{"чужой POST и по Origin, и по fetch", "POST", "http://evil.example", "cross-site", http.StatusForbidden},
		{"чужое удаление", "DELETE", "http://evil.example", "", http.StatusForbidden},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, "http://127.0.0.1:8099/api/download?action=list", nil)
		if tc.origin != "" {
			req.Header.Set("Origin", tc.origin)
		}
		if tc.fetch != "" {
			req.Header.Set("Sec-Fetch-Site", tc.fetch)
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != tc.want {
			t.Errorf("%s: код %d, ожидался %d", tc.name, rr.Code, tc.want)
		}
	}
}

// Проба готовности отвечает пустым 204 и проходит охранника: окно-оболочка
// стучится в неё из своего источника, то есть кросс-сайтово.
func TestNetProbeAnswersShell(t *testing.T) {
	c := &Comp{}
	h := originGuard(http.HandlerFunc(c.apiNet))
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8099/net", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Errorf("проба готовности: код %d, ожидался 204", rr.Code)
	}
}

// Запуск закачки по GET позволял любой посещённой странице ставить файл на
// загрузку картинкой. Мутации принимаются только POST'ом.
func TestDownloadMutationsRequirePOST(t *testing.T) {
	saved := cfg.Load()
	cfg.Store(defaultConfig())
	t.Cleanup(func() { cfg.Store(saved) })

	c := &Comp{dl: NewDLManager(t.TempDir())}

	req := httptest.NewRequest(http.MethodGet, "/api/download?action=list", nil)
	rr := httptest.NewRecorder()
	c.apiDownload(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET list: код %d", rr.Code)
	}

	for _, action := range []string{"start", "cancel", "clean"} {
		req := httptest.NewRequest(http.MethodGet, "/api/download?action="+action+"&hash=abc&index=1", nil)
		rr := httptest.NewRecorder()
		c.apiDownload(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s: код %d, ожидался 405", action, rr.Code)
		}
		req = httptest.NewRequest(http.MethodPost, "/api/download?action="+action+"&id=x", nil)
		rr = httptest.NewRecorder()
		c.apiDownload(rr, req)
		if rr.Code != http.StatusOK {
			t.Errorf("POST %s: код %d, ожидался 200", action, rr.Code)
		}
	}
}

// Прочие методы у ручки профилей прежде проваливались мимо switch: обработчик
// ничего не писал, и net/http отвечал 200 с пустым телом — «получилось», хотя не
// делалось ничего. А мусор в теле назывался «unknown action»: причина была не
// той, и дефект искали в разборе действий, а не в разборе запроса.
func TestProfilesRejectsUnsupportedMethodsAndBadBodies(t *testing.T) {
	saved := cfg.Load()
	cfg.Store(defaultConfig())
	t.Cleanup(func() { cfg.Store(saved) })

	c := &Comp{}

	for _, method := range []string{http.MethodPut, http.MethodDelete, http.MethodPatch} {
		req := httptest.NewRequest(method, "/api/profiles", strings.NewReader("{}"))
		rr := httptest.NewRecorder()
		c.apiProfiles(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: код %d, ожидался 405", method, rr.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/profiles", strings.NewReader("это не json"))
	rr := httptest.NewRecorder()
	c.apiProfiles(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("мусор в теле: код %d, ожидался 400", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "неразборчивый запрос") {
		t.Errorf("причина названа неверно: %s", rr.Body.String())
	}
}
