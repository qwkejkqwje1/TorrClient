package main

// Постеры и оценки: почему их нет.
//
// Разбор случая «постеры сломались». Причина была не в разборе ответа сервиса
// и не в сборке адреса картинки — их проверяют TestTmdbImageBuildsAnAddressFromAPath
// и TestTvmdbSeasonEpsReadsEpisodeDetails. Причина была в том, что демон
// отвечал «не найдено» на «ключ не задан» и «ключ отклонён», и пропавшие
// постеры выглядели как «сервис ничего не знает об этом фильме».
//
// Поэтому здесь проверяется не картинка, а то, что причина называется:
//   - без ключа ручки отвечают «ключ не задан», а не «не найдено»;
//   - отклонённый ключ (401) называется отклонённым ключом;
//   - с настроенным ключом постер собирается из ответа сервиса — то есть
//     путь «ключ → поиск → адрес картинки» цел;
//   - смена ключа забывает запомненные отказы, иначе свежий ключ ещё полчаса
//     не давал бы постеров и «ключ не помог» выглядело бы новым дефектом.
//
// Сети тесты не касаются: сервис подменён своим, адрес берётся из tmdbAPIBase.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// useTmdbStub подменяет корень API метаданных своим сервером и возвращает
// прежний адрес на место после проверки.
func useTmdbStub(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(h)
	saved := tmdbAPIBase
	tmdbAPIBase = srv.URL
	t.Cleanup(func() {
		tmdbAPIBase = saved
		srv.Close()
	})
}

// useTmdbKey ставит конфигурацию с заданным ключом (пустой ключ — «не задан»).
func useTmdbKey(t *testing.T, key string) {
	t.Helper()
	saved := cfg.Load()
	c := defaultConfig()
	c.TMDBApiKey = key
	cfg.Store(c)
	t.Cleanup(func() { cfg.Store(saved) })
}

// getRatingsJSON зовёт ручку оценок и разбирает ответ.
func getRatingsJSON(t *testing.T, query string) TMDBRes {
	t.Helper()
	c := &Comp{}
	req := httptest.NewRequest(http.MethodGet, "/api/ratings?q="+query, nil)
	rr := httptest.NewRecorder()
	c.apiRatings(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("код ответа %d, ожидался 200", rr.Code)
	}
	var out TMDBRes
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("ответ не разобран: %v (%s)", err, rr.Body.String())
	}
	return out
}

// Без ключа причина обязана называться: «не найдено» отправляло искать дефект
// в разборе ответа сервиса и в адресе картинки, хотя спрашивать было нечем.
func TestRatingsNameTheMissingKey(t *testing.T) {
	useTempTmdbCache(t)
	useTmdbKey(t, "")

	got := getRatingsJSON(t, "%D0%9C%D0%B0%D1%82%D1%80%D0%B8%D1%86%D0%B0")
	if got.OK {
		t.Fatalf("без ключа ответ положительный: %+v", got)
	}
	if got.Error != errTMDBNoKey {
		t.Errorf("причина %q, ожидалась %q", got.Error, errTMDBNoKey)
	}
	if got.Error == "not found" {
		t.Error("пропавшие постеры снова выглядят как «сервис ничего не нашёл»")
	}
}

// Ключ в настройках есть, но сервис его не принимает (отозван, опечатка):
// это отдельная причина, и по ней видно, что чинить — настройки, а не поиск.
func TestRatingsReportARejectedKey(t *testing.T) {
	useTempTmdbCache(t)
	useTmdbKey(t, "отозванный-ключ")
	useTmdbStub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"status_message":"Invalid API key"}`))
	})

	got := getRatingsJSON(t, "%D0%9C%D0%B0%D1%82%D1%80%D0%B8%D1%86%D0%B0")
	if got.Error != errTMDBBadKey {
		t.Errorf("причина %q, ожидалась %q", got.Error, errTMDBBadKey)
	}
}

// С настроенным ключом путь «поиск → адрес картинки» обязан быть цел: именно
// это отличает «сломанный код» от «нечем спрашивать».
func TestRatingsBuildAPosterWhenTheKeyWorks(t *testing.T) {
	useTempTmdbCache(t)
	useTmdbKey(t, "рабочий-ключ")
	useTmdbStub(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/search/movie"):
			// Номер IMDb нарочно не отдаётся: иначе оценка пошла бы в
			// Cinemeta, а проверка — в сеть.
			w.Write([]byte(`{"results":[{"id":603,"title":"Матрица","release_date":"1999-03-31","poster_path":"/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg","vote_average":8.2}]}`))
		case strings.HasPrefix(r.URL.Path, "/movie/603/external_ids"):
			w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	got := getRatingsJSON(t, "%D0%9C%D0%B0%D1%82%D1%80%D0%B8%D1%86%D0%B0")
	if !got.OK {
		t.Fatalf("с рабочим ключом ответ отрицательный: %+v", got)
	}
	want := "https://image.tmdb.org/t/p/w342/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg"
	if got.Poster != want {
		t.Errorf("постер %q, ожидался %q", got.Poster, want)
	}
	if got.Title != "Матрица" || got.Year != 1999 {
		t.Errorf("название/год = %q/%d", got.Title, got.Year)
	}
	if got.Error != "" {
		t.Errorf("положительный ответ несёт причину отказа: %q", got.Error)
	}
}

// Ручка постера отвечает тем же кодом причины: окно «Подгрузить постер» тоже
// должно объясняться, а не показывать «не найден» при незаданном ключе.
func TestTmdbEndpointNamesTheMissingKey(t *testing.T) {
	useTempTmdbCache(t)
	useTmdbKey(t, "")

	c := &Comp{}
	req := httptest.NewRequest(http.MethodGet, "/api/tmdb?q=%D0%9C%D0%B0%D1%82%D1%80%D0%B8%D1%86%D0%B0", nil)
	rr := httptest.NewRecorder()
	c.apiTmdb(rr, req)
	var got TMDBRes
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("ответ не разобран: %v", err)
	}
	if got.Error != errTMDBNoKey {
		t.Errorf("причина %q, ожидалась %q", got.Error, errTMDBNoKey)
	}
}

// Ключ сменился — запомненные отказы недействительны. Иначе свежевведённый
// ключ полчаса (tmdbNegTTL) не давал бы постеров, и это выглядело бы новым
// дефектом ровно в тот момент, когда пользователь считает, что всё починил.
func TestSavingTheKeyForgetsRememberedMisses(t *testing.T) {
	useTempTmdbCache(t)
	useTmdbKey(t, "")

	tmdbPut("rat|матрица|1999|", tmdbItem{neg: true})
	if _, ok := tmdbGet("rat|матрица|1999|"); !ok {
		t.Fatal("отказ не запомнен — проверять нечего")
	}

	c := &Comp{}
	body := strings.NewReader(`{"key":"новый-ключ"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/meta", body)
	rr := httptest.NewRecorder()
	c.apiMeta(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("сохранение ключа: код %d (%s)", rr.Code, rr.Body.String())
	}
	var res struct {
		OK         bool `json:"ok"`
		Configured bool `json:"configured"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatalf("ответ не разобран: %v", err)
	}
	if !res.OK || !res.Configured {
		t.Errorf("после сохранения ключа демон считает его незаданным: %+v", res)
	}
	if _, ok := tmdbGet("rat|матрица|1999|"); ok {
		t.Error("запомненный отказ пережил смену ключа")
	}
}
