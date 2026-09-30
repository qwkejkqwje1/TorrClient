package main

// Тесты прямого Torznab-клиента. Эталонный ответ лежит в testdata, чтобы
// разбор проверялся на настоящем формате индексатора, а не на том, что сам же
// тест и выдумал.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func torznabFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/torznab_search.xml")
	if err != nil {
		t.Fatalf("эталонный ответ не прочитан: %v", err)
	}
	return b
}

// TestTorznabParseFeed разбирает эталон и сверяет всё, на что смотрит интерфейс:
// заголовок, размер, сиды, magnet и хеш.
func TestTorznabParseFeed(t *testing.T) {
	items, err := parseTorznabFeed(torznabFixture(t))
	if err != nil {
		t.Fatalf("эталон не разобран: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("ожидалось 3 годные раздачи, получено %d", len(items))
	}
	// Раздача без ссылки и без хеша пропущена: её нельзя ни показать, ни скачать.
	for _, it := range items {
		if strings.Contains(it.Title, "Пустая раздача") {
			t.Fatalf("раздача без способа скачивания попала в выдачу: %+v", it)
		}
	}
	first := items[0]
	if first.Title != "Матрица 1999 1080p BluRay & HDR" {
		t.Errorf("сущности XML не разобраны, заголовок: %q", first.Title)
	}
	if first.Seed != 120 || first.Peer != 7 {
		t.Errorf("сиды/личи не разобраны: %d/%d", first.Seed, first.Peer)
	}
	if first.Hash != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("infohash не разобран: %q", first.Hash)
	}
	if !strings.HasPrefix(first.Magnet, "magnet:?xt=urn:btih:") {
		t.Errorf("magnet собран неверно: %q", first.Magnet)
	}
	if !strings.Contains(first.Size, "8") {
		t.Errorf("размер в байтах не показан по-человечески: %q", first.Size)
	}
	// Спецсимволы в заголовке не должны рвать разметку интерфейса.
	if second := items[1]; second.Title != "Обход <заглушки> и прочих спецсимволов" {
		t.Errorf("экранированные спецсимволы не разобраны: %q", second.Title)
	}
	// Минус один сид — это «никто не качает», а не «хуже всех»: иначе пустая
	// раздача встанет в начало отсортированного списка.
	if items[1].Seed != 0 {
		t.Errorf("seeders=-1 должен читаться как 0, получено %d", items[1].Seed)
	}
	// Только инфохаш: magnet обязан появиться сам, иначе раздача не добавится.
	if items[2].Magnet == "" || !strings.Contains(items[2].Magnet, "cccccccc") {
		t.Errorf("magnet не собран из infohash: %q", items[2].Magnet)
	}
	if items[2].Hash != "cccccccccccccccccccccccccccccccccccccccc" {
		t.Errorf("infohash приведён не к нижнему регистру: %q", items[2].Hash)
	}
}

// TestTorznabParseFeedRejectsGarbage отличает «индексатор не ответил» от
// «ответил мусором»: иначе оба случая выглядят как пустая выдача.
func TestTorznabParseFeedRejectsGarbage(t *testing.T) {
	cases := map[string]string{
		"пустой ответ":   "",
		"html-заглушка":  "<html><body>Please sign in</body></html>",
		"xml без item":   `<?xml version="1.0"?><rss><channel><title>пусто</title></channel></rss>`,
		"не xml вовсе":   "{ошибкаjson}",
		"незакрытый тег": `<rss><channel><item><title>Обрыв`,
	}
	for name, body := range cases {
		if _, err := parseTorznabFeed([]byte(body)); !errors.Is(err, errTorznabMarkup) {
			t.Errorf("%s: ждали errTorznabMarkup, получено %v", name, err)
		}
	}
}

// TestTorznabBuildURL сверяет правила стандарта: без них индексатор отдаст пустую
// выдачу и объяснить это будет нечем.
func TestTorznabBuildURL(t *testing.T) {
	full := torznabBuildURL("http://127.0.0.1:9117/results/torznab/api", "KEY", "matrix", "2040", 0, torznabPageLimit)
	for _, want := range []string{
		"http://127.0.0.1:9117/results/torznab/api?",
		"t=search", "q=matrix", "cat=2040", "limit=100", "extended=1", "apikey=KEY",
	} {
		if !strings.Contains(full, want) {
			t.Errorf("в адресе нет %q: %s", want, full)
		}
	}
	// На первой странице offset не нужен: у индексатора offset=0 иногда
	// превращается в пустую выдачу.
	if strings.Contains(full, "offset") {
		t.Errorf("offset на первой странице лишний: %s", full)
	}
	second := torznabBuildURL("http://h/api", "", "x", "", 2, 100)
	if !strings.Contains(second, "offset=200") {
		t.Errorf("вторая страница не посчитана: %s", second)
	}
	if strings.Contains(second, "cat=") || strings.Contains(second, "apikey=") {
		t.Errorf("пустые cat и apikey не должны уходить в запрос: %s", second)
	}
}

// TestTorznabNormURLAndKey проверяет приведение адреса и извлечение ключа из
// ссылки вида «?apikey=…» — именно такую строку даёт кнопка копирования.
func TestTorznabNormURLAndKey(t *testing.T) {
	addr, key, err := normTorznabURL("  HTTP://Jackett.local:9117/results/torznab/api/?apikey=abc123  ")
	if err != nil {
		t.Fatalf("нормальный адрес отвергнут: %v", err)
	}
	if key != "abc123" {
		t.Errorf("ключ не вынут из адреса: %q", key)
	}
	if strings.Contains(addr, "apikey") {
		t.Errorf("ключ остался в адресе: %s", addr)
	}
	if addr != "http://Jackett.local:9117/results/torznab/api" {
		t.Errorf("схема/слеш не приведены: %q", addr)
	}
	// Без схемы — обычная опечатка, а не повод отказывать.
	if a, _, err := normTorznabURL("127.0.0.1:9696/api"); err != nil || a != "http://127.0.0.1:9696/api" {
		t.Errorf("схема не подставлена: %q, %v", a, err)
	}
	// А вот ftp:// — нет: так адрес не спросить, и молча пропустить хуже.
	if _, _, err := normTorznabURL("ftp://host/api"); err == nil {
		t.Error("ftp:// принят, а должен быть отвергнут")
	}
	if _, _, err := normTorznabURL("   "); err == nil {
		t.Error("пустой адрес принят")
	}
}

// torznabStub поднимает индексатор-эталон: отдаёт capabilities и выдачу по
// t=search, проверяет, что ключ пришёл, и умеет притвориться сломанным.
func torznabStub(t *testing.T, status int) *httptest.Server {
	t.Helper()
	fixture := torznabFixture(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("t") {
		case "caps":
			w.Header().Set("Content-Type", "application/xml")
			io := `<?xml version="1.0" encoding="UTF-8"?><caps><server title="Jackett"/><searching>` +
				`<search available="yes" supportedParams="q"/><tv-search available="yes"/>` +
				`<movie-search available="no"/></searching></caps>`
			_, _ = w.Write([]byte(io))
		case "search":
			if status != 0 {
				w.WriteHeader(status)
				return
			}
			if r.URL.Query().Get("apikey") == "" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			if r.URL.Query().Get("q") == "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/rss+xml")
			_, _ = w.Write(fixture)
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestTorznabHash разбирает magnet во всех видах, в которых его отдают
// индексаторы: с параметрами после хеша, с префиксом «h:» и в base32. Третий
// вариант встречается редко, но ровно он ломает отбор раздач: неопознанный
// хеш молча превращает раздачу в «нечего качать».
func TestTorznabHash(t *testing.T) {
	const want = "0123456789abcdef0123456789abcdef01234567"
	cases := []struct{ name, magnet, infohash, expect string }{
		{"прямой хеш", "", "0123456789abcdef0123456789abcdef01234567", want},
		{"хеш в верхнем регистре", "", "0123456789ABCDEF0123456789ABCDEF01234567", want},
		{"magnet с параметрами", "magnet:?xt=urn:btih:" + want + "&dn=Movie&tr=http://x", "", want},
		{"magnet с префиксом h:", "magnet:?xt=urn:btih:h:" + want + "&dn=Movie", "", want},
		{"magnet без схемы", "magnet:?xt=urn:btih:" + want, "", want},
		{"base32", "", "AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH", want},
		{"base32 в magnet", "magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH", "", want},
		{"пусто", "", "", ""},
		{"не хеш", "", "нехеш", ""},
		{"слишком короткий", "", "0123456789", ""},
	}
	for _, c := range cases {
		if got := torznabHash(c.magnet, c.infohash); got != c.expect {
			t.Errorf("%s: получено %q, ждали %q", c.name, got, c.expect)
		}
	}
}

// TestTorznabHashPrefersMagnetLink: обе ссылки дают один хеш, иначе одинаковая
// раздача от двух индексаторов не уберётся как повтор.
func TestTorznabHashFromBothSources(t *testing.T) {
	const hex = "0123456789abcdef0123456789abcdef01234567"
	if torznabHash("magnet:?xt=urn:btih:"+hex, hex) != hex {
		t.Error("хеш из magnet и из атрибута разошёлся")
	}
}

// TestTorznabSourceNameAuto: без имени в списке появилась бы строка
// «Индексатор 1», а человек ищет свой список взглядом.
func TestTorznabSourceNameAuto(t *testing.T) {
	s, err := normTorznabSource(TorznabSource{URL: "http://127.0.0.1:9117/results/torznab/api"})
	if err != nil {
		t.Fatalf("источник отвергнут: %v", err)
	}
	if s.Name != "127.0.0.1:9117" {
		t.Errorf("имя не придумано по хосту: %q", s.Name)
	}
}

// TestTorznabFetchAndSearch идёт по полному пути: HTTP-запрос, разбор, сведение
// раздачи и отчёт по источнику.
func TestTorznabFetchAndSearch(t *testing.T) {
	srv := torznabStub(t, 0)
	items, err := fetchTorznab(srv.URL, "KEY", "matrix", "", 0)
	if err != nil {
		t.Fatalf("эталонный индексатор не ответил: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("ожидалось 3 раздачи, получено %d", len(items))
	}

	// Тот же поиск через свою ручку: список источников и разбор должны
	// доехать до интерфейса.
	setCfg(&Config{TorznabSources: []TorznabSource{{Name: "Эталон", URL: srv.URL, APIKey: "KEY"}}})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	res, err := (&Comp{}).torznabSearchAll("matrix", "", 0)
	if err != nil {
		t.Fatalf("сведение источников не отработало: %v", err)
	}
	if len(res.Items) != 3 {
		t.Fatalf("в ответе ручки %d раздач вместо 3", len(res.Items))
	}
	if len(res.Sources) != 1 || !res.Sources[0].OK {
		t.Fatalf("отчёт по источнику неверен: %+v", res.Sources)
	}
	// Сортировка по сидам: интерфейс сам не переставляет выдачу.
	if res.Items[0].Seed < res.Items[len(res.Items)-1].Seed {
		t.Error("раздачи не отсортированы по сидам")
	}
}

// TestTorznabSearchAllDeduplicates убирает повтор одной раздачи от двух
// индексаторов: иначе список покажет 25 раздач, а добавить можно 24.
func TestTorznabSearchAllDeduplicates(t *testing.T) {
	srv := torznabStub(t, 0)
	setCfg(&Config{TorznabSources: []TorznabSource{
		{Name: "Первый", URL: srv.URL, APIKey: "KEY"},
		{Name: "Второй", URL: srv.URL, APIKey: "KEY"},
	}})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	torznabSearch.reset()
	res, err := (&Comp{}).torznabSearchAll("matrix", "", 0)
	if err != nil {
		t.Fatalf("поиск не отработал: %v", err)
	}
	if len(res.Items) != 3 {
		t.Fatalf("совпадения не убраны: %d раздач вместо 3", len(res.Items))
	}
}

// TestTorznabSearchAllReportsFailure отличает поломку индексатора от пустой
// выдачи: без этого человек ищет не там, где надо, и не понимает почему.
func TestTorznabSearchAllReportsFailure(t *testing.T) {
	bad := torznabStub(t, http.StatusInternalServerError)
	setCfg(&Config{TorznabSources: []TorznabSource{{Name: "Сломанный", URL: bad.URL, APIKey: "KEY"}}})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	torznabSearch.reset()
	res, err := (&Comp{}).torznabSearchAll("matrix", "", 0)
	if err == nil {
		t.Fatal("упавший индексатор отдан как успешный поиск")
	}
	if !strings.Contains(err.Error(), "Сломанный") {
		t.Errorf("в ошибке нет имени источника: %v", err)
	}
	if len(res.Sources) != 1 || res.Sources[0].Error == "" {
		t.Errorf("причина не попала в отчёт по источникам: %+v", res.Sources)
	}
	// 401 — это про ключ, а не про сеть: сказать «сеть недоступна» значит
	// отправить человека проверять кабель.
	wrong := torznabStub(t, 0)
	setCfg(&Config{TorznabSources: []TorznabSource{{Name: "Без ключа", URL: wrong.URL}}})
	torznabSearch.reset()
	if _, err := (&Comp{}).torznabSearchAll("matrix", "", 0); !errors.Is(err, errTorznabAuth) &&
		!strings.Contains(err.Error(), "отклонил ключ") {
		t.Errorf("отказ по ключу не распознан: %v", err)
	}
}

// TestTorznabSearchAllWithoutSources говорит прямо, что источников нет, вместо
// «ничего не нашлось».
func TestTorznabSearchAllWithoutSources(t *testing.T) {
	setCfg(&Config{})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	_, err := (&Comp{}).torznabSearchAll("matrix", "", 0)
	if err == nil || !strings.Contains(err.Error(), "не настроены") {
		t.Fatalf("пустой список источников не объяснён: %v", err)
	}
}

// TestTorznabTestEndpoint проверяет «Проверить»: он обязан убедиться, что
// индексатор рабочий, и не должен при этом ничего сохранять.
func TestTorznabTestEndpoint(t *testing.T) {
	srv := torznabStub(t, 0)
	c := &Comp{}
	setCfg(&Config{})
	t.Cleanup(func() { setCfg(defaultConfig()) })

	w := httptest.NewRecorder()
	c.apiTorznabTest(w, httptest.NewRequest("POST", "/api/torznab/test",
		strings.NewReader(`{"name":"Джекетт","url":"`+srv.URL+`","api_key":"KEY"}`)))
	var ok torznabTestResult
	if err := json.Unmarshal(w.Body.Bytes(), &ok); err != nil {
		t.Fatalf("ответ проверки не разобран: %v (%s)", err, w.Body.String())
	}
	if !ok.OK || ok.Items != 3 {
		t.Errorf("рабочий индексатор признан нерабочим: %+v", ok)
	}
	if !ok.Caps.Search || !ok.Caps.TVSearch || ok.Caps.MovieSearch {
		t.Errorf("capabilities прочитаны неверно: %+v", ok.Caps)
	}
	if len(ok.Caps.Categories) != 0 {
		t.Errorf("категории без запроса придуманы: %+v", ok.Caps)
	}
	if len(curCfg().TorznabSources) != 0 {
		t.Error("проверка что-то записала в конфиг — она обязана быть безвредной")
	}

	// Неверный адрес должен быть назван неверным адресом, а не «сеть».
	bad := httptest.NewRecorder()
	c.apiTorznabTest(bad, httptest.NewRequest("POST", "/api/torznab/test",
		strings.NewReader(`{"url":"ftp://host/api"}`)))
	var badOut torznabTestResult
	_ = json.Unmarshal(bad.Body.Bytes(), &badOut)
	if badOut.OK || !strings.Contains(badOut.Error, "http") {
		t.Errorf("плохой адрес не отвергнут: %+v", badOut)
	}
}

// TestTorznabTestReportsSearchFailure: capabilities отдаются даже при неверном
// ключе, поэтому «отвечает, но поиск не работает» — самая частая форма отказа.
// Если в этом случае error пуст, человек видит «не отвечает» без причины и
// идёт проверять не то.
func TestTorznabTestReportsSearchFailure(t *testing.T) {
	// Этот индексатор отдаёт capabilities всегда, а поиск — только с ключом.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("t") == "caps" {
			_, _ = w.Write([]byte(`<?xml version="1.0"?><caps><server title="X"/><searching>` +
				`<search available="yes"/></searching></caps>`))
			return
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)

	c := &Comp{}
	setCfg(&Config{})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	w := httptest.NewRecorder()
	c.apiTorznabTest(w, httptest.NewRequest("POST", "/api/torznab/test",
		strings.NewReader(`{"url":"`+srv.URL+`"}`)))
	var out torznabTestResult
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("ответ не разобран: %v", err)
	}
	if out.OK {
		t.Error("индексатор без ключа признан рабочим")
	}
	if out.Error == "" {
		t.Error("причина отказа по ключу не попала в error — интерфейс покажет «не отвечает» без объяснения")
	}
	if !strings.Contains(out.Error, "ключ") {
		t.Errorf("отказ по ключу назван неверно: %q", out.Error)
	}
	if len(out.Notes) == 0 {
		t.Error("примечание о неработающем поиске не добавлено")
	}
}

// TestTorznabSourcesSaveAndMask проверяет запись списка и то, что ключ наружу не
// уходит целиком, а при правке не затирается.
func TestTorznabSourcesSaveAndMask(t *testing.T) {
	c := &Comp{}
	setCfg(defaultConfig())
	t.Cleanup(func() { setCfg(defaultConfig()) })

	w := httptest.NewRecorder()
	body := `{"sources":[{"name":"Джекетт","url":"127.0.0.1:9117/results/torznab/api/","api_key":"SECRETKEY1"}]}`
	c.apiTorznabSources(w, httptest.NewRequest("POST", "/api/torznab/sources", strings.NewReader(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("сохранение отклонено: %d %s", w.Code, w.Body.String())
	}
	saved := curCfg().TorznabSources
	if len(saved) != 1 || saved[0].APIKey != "SECRETKEY1" {
		t.Fatalf("источник не сохранён как есть: %+v", saved)
	}
	if saved[0].URL != "http://127.0.0.1:9117/results/torznab/api" {
		t.Errorf("адрес не нормализован при записи: %q", saved[0].URL)
	}

	// Список наружу: ключа быть не должно ни в каком виде.
	get := httptest.NewRecorder()
	c.apiTorznabSources(get, httptest.NewRequest("GET", "/api/torznab/sources", nil))
	if strings.Contains(get.Body.String(), "SECRETKEY1") {
		t.Errorf("ключ утёк в ответ списка: %s", get.Body.String())
	}
	if !strings.Contains(get.Body.String(), "has_key") {
		t.Errorf("нет признака «ключ задан»: %s", get.Body.String())
	}

	// Правка адреса без ключа не должна обнулить ключ.
	edit := httptest.NewRecorder()
	c.apiTorznabSources(edit, httptest.NewRequest("POST", "/api/torznab/sources",
		strings.NewReader(`{"sources":[{"name":"Джекетт","url":"http://127.0.0.1:9117/other"}]}`)))
	if curCfg().TorznabSources[0].APIKey != "SECRETKEY1" {
		t.Errorf("ключ затёрся при правке адреса: %+v", curCfg().TorznabSources)
	}

	// Два индексатора с одним именем — ошибка, а не молчаливая замена.
	dup := httptest.NewRecorder()
	c.apiTorznabSources(dup, httptest.NewRequest("POST", "/api/torznab/sources",
		strings.NewReader(`{"sources":[{"name":"Джекетт","url":"http://a/api"},{"name":"джекетт","url":"http://b/api"}]}`)))
	if dup.Code != http.StatusBadRequest {
		t.Errorf("дубль имени прошёл незамеченным: %d", dup.Code)
	}

	// Удаление по имени.
	del := httptest.NewRecorder()
	c.apiTorznabSources(del, httptest.NewRequest("POST", "/api/torznab/sources", strings.NewReader(`{"remove":"Джекетт"}`)))
	if len(curCfg().TorznabSources) != 0 {
		t.Errorf("источник не удалён: %+v", curCfg().TorznabSources)
	}
}

// TestTorznabSearchEndpointHTTP: ручка обязана отличать «индексаторы сломаны»
// от «выдачи нет» кодом ответа — иначе интерфейс покажет «ничего не нашлось».
func TestTorznabSearchEndpointHTTP(t *testing.T) {
	c := &Comp{}
	setCfg(&Config{})
	t.Cleanup(func() { setCfg(defaultConfig()) })
	w := httptest.NewRecorder()
	c.apiTorznabSearch(w, httptest.NewRequest("GET", "/api/torznab/search?query=matrix", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("без источников ждали 503, получено %d", w.Code)
	}

	bad := torznabStub(t, http.StatusNotFound)
	setCfg(&Config{TorznabSources: []TorznabSource{{Name: "Битый", URL: bad.URL, APIKey: "KEY"}}})
	torznabSearch.reset()
	w2 := httptest.NewRecorder()
	c.apiTorznabSearch(w2, httptest.NewRequest("GET", "/api/torznab/search?query=matrix", nil))
	if w2.Code != http.StatusBadGateway {
		t.Errorf("упавший индексатор ждал 502, получено %d", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "Битый") {
		t.Errorf("разбор по источникам не дошёл до ответа: %s", w2.Body.String())
	}
	if !strings.Contains(w2.Body.String(), "адрес") {
		t.Errorf("на 404 не сказано, что дело в адресе: %s", w2.Body.String())
	}
}

// Онлайн-JacRed (jac-red.ru) не отвечает Torznab, но отдаёт JSON-ручку Jackett
// рядом: поиск должен уйти туда, а вторая страница — быть пустой.
func TestFetchTorznabFallsBackToJackettJSON(t *testing.T) {
	var jsonHits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v2.0/indexers/all/results":
			jsonHits++
			if r.URL.Query().Get("Query") != "матрица" {
				t.Errorf("запрос = %q", r.URL.Query().Get("Query"))
			}
			w.Write([]byte(`{"Results":[{"Title":"Матрица / The Matrix (1999) 1080p","Tracker":"rutor","Size":2147483648,"Seeders":42,"Peers":3,` +
				`"MagnetUri":"magnet:?xt=urn:btih:0E6C99417FD5A446BA8F7B9E17DAB326553D23BA&dn=x"},{"Title":"","MagnetUri":"magnet:?xt=urn:btih:1"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	addr := srv.URL + "/api/v2.0/indexers/all/results/torznab/api"
	items, err := fetchTorznab(addr, "", "матрица", "", 0)
	if err != nil {
		t.Fatalf("поиск: %v", err)
	}
	if len(items) != 1 || items[0].Seed != 42 || items[0].Hash != "0e6c99417fd5a446ba8f7b9e17dab326553d23ba" || items[0].Size == "" {
		t.Fatalf("раздачи = %+v", items)
	}
	more, err := fetchTorznab(addr, "", "матрица", "", 1)
	if err != nil || len(more) != 0 {
		t.Errorf("вторая страница = %v, %v; ожидалось пусто", more, err)
	}
	if _, ok := jackettJSONURL("http://h/api/v1/search", "", "q", ""); ok {
		t.Error("адрес не Jackett принят за Jackett")
	}
	if u, _ := jackettJSONURL(addr, "K", "q", "2000,5000"); !strings.Contains(u, "Category%5B%5D=2000") || !strings.Contains(u, "apikey=K") {
		t.Errorf("адрес JSON: %q", u)
	}
}
