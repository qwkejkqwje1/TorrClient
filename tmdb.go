package main

// Метаданные: постеры, оценки и списки серий (TMDB, Cinemeta).

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- TMDB metadata (posters for search results) ----------

type TMDBRes struct {
	OK     bool    `json:"ok"`
	ID     int     `json:"id,omitempty"`
	Type   string  `json:"type,omitempty"` // movie | tv
	Title  string  `json:"title,omitempty"`
	Year   int     `json:"year,omitempty"`
	Poster string  `json:"poster,omitempty"`
	Rating float64 `json:"rating,omitempty"`
	IMDBID string  `json:"imdb_id,omitempty"`
	IMDB   float64 `json:"imdb,omitempty"`
	Error  string  `json:"error,omitempty"`
}

type tmdbItem struct {
	res TMDBRes
	eps TVEpsRes
	t   time.Time
	// neg — «не найдено» тоже запоминается: без этого каждая перерисовка
	// библиотеки спрашивала бы сервис заново о каждой раздаче, которой там
	// нет. Живёт меньше обычной записи (tmdbNegTTL) и на диск не пишется.
	neg bool
}

// TMEpisode — серия в том виде, в каком её показывает интерфейс: номер, название,
// дата выхода, длительность, описание и кадр.
type TMEpisode struct {
	Number   int     `json:"number"`
	Name     string  `json:"name,omitempty"`
	AirDate  string  `json:"air_date,omitempty"`
	Runtime  int     `json:"runtime,omitempty"`
	Overview string  `json:"overview,omitempty"`
	Still    string  `json:"still,omitempty"`
	Rating   float64 `json:"rating,omitempty"`
}

// TMSeason — сезон целиком: по нему интерфейс пишет заголовок «Сезон 2 · 24 серии
// · 2019–2020» и раскладывает серии.
type TMSeason struct {
	Number   int         `json:"number"`
	Name     string      `json:"name,omitempty"`
	AirDate  string      `json:"air_date,omitempty"`
	Overview string      `json:"overview,omitempty"`
	Poster   string      `json:"poster,omitempty"`
	Episodes []TMEpisode `json:"episodes"`
}

type TVEpsRes struct {
	OK    bool   `json:"ok"`
	TVID  int    `json:"tvid,omitempty"`
	Name  string `json:"name,omitempty"`
	Error string `json:"error,omitempty"`
	// NameBy оставлен для совместимости: прежний интерфейс читает только его.
	NameBy  map[int]map[int]string `json:"name_by,omitempty"`
	Seasons []TMSeason             `json:"seasons,omitempty"`
}

var (
	tmdbMu    sync.Mutex
	tmdbCache = map[string]tmdbItem{}
	// tmdbDirty отмечает, что кэш разошёлся с диском: писать файл на каждый
	// вопрос к сервису было бы дороже самого вопроса.
	tmdbDirty bool
)

// tmdbCacheTTL — сколько живёт запись кэша. Постеры и оценки за сутки не
// меняются, а спрашивать их заново на каждый запуск — это пустой экран в
// библиотеке, пока сервис отвечает.
const tmdbCacheTTL = 24 * time.Hour

// tmdbNegTTL — срок жизни ответа «не найдено». Короче обычного: фильм могли
// добавить на сервис только что, и ждать сутки его появления незачем.
const tmdbNegTTL = 30 * time.Minute

// tmdbCacheMax — потолок записей в памяти: кэш не должен расти вечно при
// месяцах работы. Обычная библиотека — сотни названий, потолок с запасом.
const tmdbCacheMax = 4000

// tmdbSaveInterval — как часто кэш ложится на диск.
const tmdbSaveInterval = 30 * time.Second

// tmdbClient — общий клиент к TMDB: срок единый для всех запросов метаданных.
var tmdbClient = &http.Client{Timeout: 12 * time.Second}

// tmdbAPIBase — корень API метаданных. Переменная, а не константа: проверки
// подменяют её своим сервером, чтобы разобрать ответ сервиса и сборку адреса
// постера без сети и без настоящего ключа.
var tmdbAPIBase = "https://api.themoviedb.org/3"

// Причины отказа, которые интерфейс показывает словами. Без них пропавшие
// постеры выглядят как «сервис ничего не знает об этом фильме»: и «ключ не
// задан», и «ключ отклонён» приходили как «не найдено», а где искать причину —
// непонятно: настройки выглядели заполненными, а картинок не было.
const (
	errTMDBNoKey  = "tmdb key not configured"
	errTMDBBadKey = "tmdb key rejected"
)

// tmdbConfigured сообщает, есть ли чем спрашивать TMDB: ключ в адресе или токен
// в заголовке. Пустая строка вместо ключа — это «не задан», и интерфейс должен
// услышать именно это, а не «не найдено».
func tmdbConfigured() bool {
	cfg := curCfg()
	return cfg != nil && (strings.TrimSpace(cfg.TMDBApiKey) != "" || strings.TrimSpace(cfg.TMDBAccessToken) != "")
}

// tmdbDropMisses выбрасывает запомненные отказы. Их нужно забыть, когда ключ
// сменился: иначе свежевведённый ключ ещё полчаса (tmdbNegTTL) не давал бы
// постеров, и «сохранённый ключ не помог» выглядело бы новым дефектом.
func tmdbDropMisses() {
	tmdbMu.Lock()
	defer tmdbMu.Unlock()
	for k, v := range tmdbCache {
		if v.neg {
			delete(tmdbCache, k)
		}
	}
	tmdbDirty = true
}

// tmdbRequest строит запрос к TMDB с учётом настроенных учётных данных: ключ
// уходит в адрес, токен — в заголовок. Снимок берётся свежий: ключи меняются
// из настроек без перезапуска демона.
func tmdbRequest(u string) (*http.Request, error) {
	cfg := curCfg()
	if cfg != nil && strings.TrimSpace(cfg.TMDBApiKey) != "" {
		sep := "?"
		if strings.Contains(u, "?") {
			sep = "&"
		}
		u += sep + "api_key=" + url.QueryEscape(strings.TrimSpace(cfg.TMDBApiKey))
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	if cfg != nil && strings.TrimSpace(cfg.TMDBApiKey) == "" && strings.TrimSpace(cfg.TMDBAccessToken) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.TMDBAccessToken))
	}
	return req, nil
}

// tmdbGet берёт запись кэша, если она ещё свежая. Протухшая выбрасывается
// сразу: лежать в памяти до перезапуска ей незачем.
func tmdbGet(key string) (tmdbItem, bool) {
	tmdbMu.Lock()
	defer tmdbMu.Unlock()
	it, ok := tmdbCache[key]
	if !ok {
		return tmdbItem{}, false
	}
	ttl := tmdbCacheTTL
	if it.neg {
		ttl = tmdbNegTTL
	}
	if time.Since(it.t) >= ttl {
		delete(tmdbCache, key)
		return tmdbItem{}, false
	}
	return it, true
}

// tmdbPut кладёт запись в кэш и отмечает, что её есть смысл сохранить.
// При переполнении выбрасывается самая старая запись — одним проходом, без
// сортировки: потолок большой, и случается это редко.
func tmdbPut(key string, it tmdbItem) {
	it.t = time.Now()
	tmdbMu.Lock()
	if len(tmdbCache) >= tmdbCacheMax {
		oldestKey := ""
		oldest := time.Time{}
		for k, v := range tmdbCache {
			if oldestKey == "" || v.t.Before(oldest) {
				oldestKey, oldest = k, v.t
			}
		}
		if oldestKey != "" {
			delete(tmdbCache, oldestKey)
		}
	}
	tmdbCache[key] = it
	tmdbDirty = true
	tmdbMu.Unlock()
}

// tmdbCachePath — файл кэша метаданных в папке кэша. Кэш одноразовый: постеры
// и оценки собираются заново, поэтому его папку можно указать на диск, который
// очищается при перезагрузке.
func tmdbCachePath() string {
	return filepath.Join(cacheDir(), "tmdb-cache.json")
}

// diskItem — запись кэша в том виде, в каком она ложится на диск. Ключ здесь
// поле, а не ключ карты: при чтении файла его иначе неоткуда взять.
type diskItem struct {
	Key string    `json:"key"`
	At  time.Time `json:"at"`
	Res *TMDBRes  `json:"res,omitempty"`
	Eps *TVEpsRes `json:"eps,omitempty"`
}

// loadTmdbCache читает кэш метаданных с диска: он переживает перезапуск, и
// постеры с оценками не спрашиваются у сервиса заново.
func loadTmdbCache() {
	b, err := os.ReadFile(tmdbCachePath())
	if err != nil {
		return
	}
	var items []diskItem
	if json.Unmarshal(b, &items) != nil {
		return
	}
	tmdbMu.Lock()
	defer tmdbMu.Unlock()
	for _, it := range items {
		if it.Key == "" || time.Since(it.At) >= tmdbCacheTTL {
			continue
		}
		entry := tmdbItem{t: it.At}
		if it.Res != nil {
			entry.res = *it.Res
		}
		if it.Eps != nil {
			entry.eps = *it.Eps
		}
		tmdbCache[it.Key] = entry
	}
}

// saveTmdbCache кладёт кэш на диск. Пустые записи не сохраняются: спрашивать их
// заново придётся всё равно, а место они занимают.
func saveTmdbCache() error {
	tmdbMu.Lock()
	items := make([]diskItem, 0, len(tmdbCache))
	for k, v := range tmdbCache {
		if v.neg {
			// «Не найдено» живёт недолго (tmdbNegTTL) и на диске не нужно:
			// после перезапуска такой вопрос задаётся заново.
			continue
		}
		it := diskItem{Key: k, At: v.t}
		if v.res.OK {
			r := v.res
			it.Res = &r
		}
		if v.eps.OK {
			e := v.eps
			it.Eps = &e
		}
		if it.Res == nil && it.Eps == nil {
			continue
		}
		items = append(items, it)
	}
	tmdbDirty = false
	tmdbMu.Unlock()
	b, err := json.Marshal(items)
	if err != nil {
		return err
	}
	return writeFileAtomic(tmdbCachePath(), b, 0o600)
}

// tmdbSaver сохраняет кэш по таймеру и только когда он изменился.
func tmdbSaver() {
	t := time.NewTicker(tmdbSaveInterval)
	defer t.Stop()
	for range t.C {
		tmdbMu.Lock()
		dirty := tmdbDirty
		tmdbMu.Unlock()
		if dirty {
			_ = saveTmdbCache()
		}
	}
}

func (c *Comp) apiMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var in struct {
			Key   string `json:"key"`
			Token string `json:"token"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
			writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
			return
		}
		key := strings.TrimSpace(in.Key)
		token := strings.TrimSpace(in.Token)
		if err := updateCfg(func(nc *Config) {
			nc.TMDBApiKey = key
			nc.TMDBAccessToken = token
		}); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
			return
		}
		// Запомненные отказы относились к прежнему ключу: с новым они неверны
		// и полчаса держали бы постеры пустыми.
		tmdbDropMisses()
		jj(w, map[string]any{"ok": true, "configured": key != "" || token != ""})
		return
	}
	jj(w, map[string]any{"ok": true, "configured": tmdbConfigured()})
}

func (c *Comp) apiTmdb(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		jj(w, TMDBRes{OK: false, Error: "empty query"})
		return
	}
	cfg := curCfg()
	if cfg == nil || (cfg.TMDBApiKey == "" && cfg.TMDBAccessToken == "") {
		jj(w, TMDBRes{OK: false, Error: errTMDBNoKey})
		return
	}
	year := strings.TrimSpace(r.URL.Query().Get("year"))
	cacheK := strings.ToLower(q) + "|" + year
	if it, ok := tmdbGet(cacheK); ok {
		jj(w, it.res)
		return
	}
	res := c.queryTmdb(q, year)
	if res.OK {
		tmdbPut(cacheK, tmdbItem{res: res})
	} else if res.Error == "not found" {
		// «Не найдено» — тоже ответ: без его запоминания каждый повторный показ
		// той же карточки спрашивал бы сервис заново.
		tmdbPut(cacheK, tmdbItem{neg: true})
	}
	jj(w, res)
}

func (c *Comp) queryTmdb(q, year string) TMDBRes {
	res := c.queryTmdbSearch("movie", q, year)
	if res.OK {
		return res
	}
	// Отказ по ключу повторится и на втором запросе: сервис отвечает на
	// учётные данные, а не на вид поиска. Спрашивать второй раз незачем.
	if res.Error == errTMDBNoKey || res.Error == errTMDBBadKey {
		return res
	}
	if multi := c.queryTmdbSearch("multi", q, ""); multi.OK {
		return multi
	}
	// Русское название латиницей — «Trudno.byt.bogom», «Slovo.patsana»:
	// так называют папки релизёры. TMDB такое не узнаёт, а по-русски
	// находит. Пробуется только после неудачи: английское название уже
	// нашлось бы выше.
	if cyr := translitToCyr(q); cyr != "" {
		if tr := c.queryTmdbSearch("movie", cyr, year); tr.OK {
			return tr
		}
		if tr := c.queryTmdbSearch("multi", cyr, ""); tr.OK {
			return tr
		}
	}
	return res
}

// translitPairs — латиница русских релизов, сначала длинные сочетания.
var translitPairs = []struct{ lat, cyr string }{
	{"shch", "щ"}, {"sch", "щ"}, {"zh", "ж"}, {"kh", "х"}, {"ts", "ц"}, {"ch", "ч"}, {"sh", "ш"},
	{"yo", "ё"}, {"yu", "ю"}, {"ya", "я"}, {"ye", "е"}, {"ju", "ю"}, {"ja", "я"}, {"iy", "ий"}, {"yy", "ый"}, {"yj", "ый"},
	{"a", "а"}, {"b", "б"}, {"v", "в"}, {"g", "г"}, {"d", "д"}, {"e", "е"}, {"z", "з"}, {"i", "и"},
	{"j", "й"}, {"k", "к"}, {"l", "л"}, {"m", "м"}, {"n", "н"}, {"o", "о"}, {"p", "п"}, {"r", "р"},
	{"s", "с"}, {"t", "т"}, {"u", "у"}, {"f", "ф"}, {"h", "х"}, {"c", "ц"}, {"y", "ы"}, {"w", "в"},
	{"x", "кс"}, {"q", "к"}, {"'", "ь"},
}

// translitToCyr переводит латиницу в кириллицу. Пусто — если в строке есть
// что-то кроме латиницы, цифр и пробелов: русское название уже по-русски.
func translitToCyr(q string) string {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return ""
	}
	for _, r := range q {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == ' ' || r == '\'' || r == '-') {
			return ""
		}
	}
	var b strings.Builder
	for i := 0; i < len(q); {
		matched := false
		for _, p := range translitPairs {
			if strings.HasPrefix(q[i:], p.lat) {
				b.WriteString(p.cyr)
				i += len(p.lat)
				matched = true
				break
			}
		}
		if !matched {
			b.WriteByte(q[i])
			i++
		}
	}
	out := b.String()
	if out == q {
		return ""
	}
	return out
}

func (c *Comp) queryTmdbSearch(kind, q, year string) TMDBRes {
	api := tmdbAPIBase + "/search/" + kind
	u := api + "?language=ru-RU&query=" + url.QueryEscape(q) + "&include_adult=false"
	if year != "" {
		u += "&year=" + url.QueryEscape(year)
	}
	req, err := tmdbRequest(u)
	if err != nil {
		return TMDBRes{OK: false, Error: "tmdb request build failed"}
	}
	// Проверка сертификата включена. Отключать её нельзя: подмена ответа
	// сервиса метаданных неотличима от настоящего ответа, а идут по этому
	// адресу и постеры, и названия.
	resp, err := tmdbClient.Do(req)
	if err != nil {
		return TMDBRes{OK: false, Error: "tmdb request failed"}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<21))
	if resp.StatusCode == http.StatusUnauthorized {
		// Отозванный или неверный ключ. Это не «фильм не найден»: постеры
		// пропадут у всех раздач сразу, и причина должна называться.
		return TMDBRes{OK: false, Error: errTMDBBadKey}
	}
	if resp.StatusCode != http.StatusOK {
		return TMDBRes{OK: false, Error: "tmdb http " + strconv.Itoa(resp.StatusCode)}
	}
	var sr struct {
		Results []struct {
			ID           int     `json:"id"`
			MediaType    string  `json:"media_type"`
			Title        string  `json:"title"`
			Name         string  `json:"name"`
			ReleaseDate  string  `json:"release_date"`
			FirstAirDate string  `json:"first_air_date"`
			PosterPath   string  `json:"poster_path"`
			VoteAverage  float64 `json:"vote_average"`
		} `json:"results"`
	}
	if json.Unmarshal(body, &sr) != nil || len(sr.Results) == 0 {
		return TMDBRes{OK: false, Error: "not found"}
	}
	it := sr.Results[0]
	title := it.Title
	if title == "" {
		title = it.Name
	}
	typ := it.MediaType
	if typ != "movie" && typ != "tv" {
		typ = "movie"
	}
	rdate := it.ReleaseDate
	if rdate == "" {
		rdate = it.FirstAirDate
	}
	y := 0
	if len(rdate) >= 4 {
		if n, err := strconv.Atoi(rdate[:4]); err == nil {
			y = n
		}
	}
	p := ""
	if it.PosterPath != "" {
		p = "https://image.tmdb.org/t/p/w342" + it.PosterPath
	}
	return TMDBRes{OK: true, ID: it.ID, Type: typ, Title: title, Year: y, Poster: p, Rating: it.VoteAverage}
}

// ---------- ratings (TMDB + Cinemeta IMDb) ----------

// ratingsCall — ответ, который считается прямо сейчас: остальные запросы с тем
// же ключом ждут его на канале, вместо того чтобы спрашивать сервис второй
// раз. При первом показе библиотеки десятки карточек одного сериала приходят
// разом, и без слияния каждая задавала бы сервису свой вопрос.
type ratingsCall struct {
	done chan struct{}
	res  TMDBRes
}

var (
	ratingsFlightMu sync.Mutex
	ratingsFlight   = map[string]*ratingsCall{}
)

func (c *Comp) apiRatings(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	year := strings.TrimSpace(r.URL.Query().Get("year"))
	imdb := strings.TrimSpace(r.URL.Query().Get("imdb"))
	if q == "" && imdb == "" {
		jj(w, TMDBRes{OK: false, Error: "empty query"})
		return
	}
	// Ключ нужен только для поиска в TMDB. С готовым номером IMDb оценка
	// берётся из Cinemeta, и ключ для неё не нужен — поэтому отказ здесь не
	// безусловный. Постер без ключа не появится всё равно, но оценка покажется.
	if !tmdbConfigured() && imdb == "" {
		jj(w, TMDBRes{OK: false, Error: errTMDBNoKey})
		return
	}
	cacheK := "rat|" + strings.ToLower(q) + "|" + year + "|" + strings.ToLower(imdb)
	if it, ok := tmdbGet(cacheK); ok {
		jj(w, it.res)
		return
	}

	// Второй запрос с тем же ключом, пришедший, пока первый ещё ждёт сервис,
	// пристраивается к нему, а не задаёт вопрос повторно.
	ratingsFlightMu.Lock()
	if call, ok := ratingsFlight[cacheK]; ok {
		ratingsFlightMu.Unlock()
		<-call.done
		jj(w, call.res)
		return
	}
	call := &ratingsCall{done: make(chan struct{})}
	ratingsFlight[cacheK] = call
	ratingsFlightMu.Unlock()
	// Канал закрывается после записи ответа: ждущие читают его по
	// happens-before закрытия, гонки нет.
	defer func() {
		ratingsFlightMu.Lock()
		delete(ratingsFlight, cacheK)
		ratingsFlightMu.Unlock()
		close(call.done)
	}()

	out := TMDBRes{OK: false, Error: "not found"}
	if q != "" {
		tr := c.queryTmdb(q, year)
		if tr.OK {
			out = tr
			if imdb == "" && tr.ID != 0 {
				imdb = c.tmdbImdbID(tr.ID, tr.Type)
			}
		} else if tr.Error != "" {
			// Причина отказа сервиса доходит до интерфейса: «не найдено»,
			// «ключ отклонён» и «ключ не задан» — разные состояния, и
			// молчание вместо причины выглядит как пропавшие постеры.
			out.Error = tr.Error
		}
	}
	if imdb != "" {
		out.IMDBID = imdb
		out.IMDB = c.cinemetaRating(imdb, out.Type)
	}
	if !out.OK && out.IMDBID == "" {
		// Отказ из-за ключа не запоминается: ключ может появиться через
		// минуту, и держать его пользователя в неведении полчаса незачем.
		if out.Error != errTMDBNoKey && out.Error != errTMDBBadKey {
			// «Не найдено» запоминается ненадолго (tmdbNegTTL): иначе каждая
			// перерисовка библиотеки спрашивала бы сервис заново о каждой
			// неизвестной ему раздаче.
			tmdbPut(cacheK, tmdbItem{neg: true})
		}
		call.res = out
		jj(w, out)
		return
	}
	out.OK = true
	// Оценка IMDb бывает и без постеров TMDB: тогда ответ положительный, а
	// причина отказа сервиса в нём лишняя.
	out.Error = ""
	tmdbPut(cacheK, tmdbItem{res: out})
	call.res = out
	jj(w, out)
}

func (c *Comp) tmdbImdbID(id int, typ string) string {
	if id == 0 {
		return ""
	}
	k := "movie"
	if typ == "tv" {
		k = "tv"
	}
	u := tmdbAPIBase + "/" + k + "/" + strconv.Itoa(id) + "/external_ids?language=ru-RU"
	req, err := tmdbRequest(u)
	if err != nil {
		return ""
	}
	resp, err := tmdbClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var x struct {
		IMDBID string `json:"imdb_id"`
	}
	if json.Unmarshal(body, &x) == nil {
		return x.IMDBID
	}
	return ""
}

// apiTvEps возвращает названия эпизодов сериала по сезонам (TMDB),
// чтобы выборщик серий в библиотеке мог показывать читаемые подписи E01, E02...
func (c *Comp) apiTvEps(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		jj(w, TVEpsRes{OK: false, Error: "empty query"})
		return
	}
	if !tmdbConfigured() {
		jj(w, TVEpsRes{OK: false, Error: errTMDBNoKey})
		return
	}
	key := "tv|" + strings.ToLower(q)
	if it, ok := tmdbGet(key); ok {
		jj(w, it.eps)
		return
	}

	tr := c.queryTmdbSearch("tv", q, "")
	if !tr.OK || tr.ID == 0 {
		// Причина отказа сервиса видна в ответе: без неё «нет названий серий»
		// и «ключ отклонён» выглядят одинаково.
		why := tr.Error
		if why == "" {
			why = "not found"
		}
		jj(w, TVEpsRes{OK: false, Error: why})
		return
	}
	nameBy := map[int]map[int]string{}
	base := tmdbAPIBase + "/tv/" + strconv.Itoa(tr.ID) + "/season/"
	seasons, rawNameBy, _ := c.tvmdbSeasonEps(tmdbClient, base, nameBy)
	out := TVEpsRes{OK: true, TVID: tr.ID, Name: tr.Title, NameBy: rawNameBy, Seasons: seasons}
	if out.NameBy != nil {
		tmdbPut(key, tmdbItem{eps: out})
	}
	jj(w, out)
}

func (c *Comp) tvmdbSeasonEps(cl *http.Client, base string, dst map[int]map[int]string) ([]TMSeason, map[int]map[int]string, bool) {
	// Сколько сезонов спрашивать: карточка самого сериала их называет точно, и
	// перебирать один за другим до пяти ещё не значит получить ответ. Считать
	// валом нельзя — у TMDB есть лимиты, поэтому верх ограничен.
	limit := 5
	if tvURL := strings.TrimSuffix(base, "season/"); tvURL != base {
		if req, err := tmdbRequest(tvURL + "?language=ru-RU"); err == nil {
			if resp, err := cl.Do(req); err == nil {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
				resp.Body.Close()
				var tv struct {
					SeasonCount int `json:"number_of_seasons"`
				}
				if resp.StatusCode == http.StatusOK && json.Unmarshal(body, &tv) == nil && tv.SeasonCount > 0 {
					if tv.SeasonCount < 20 {
						limit = tv.SeasonCount
					}
				}
			}
		}
	}

	// Сезоны берутся параллельно: последовательные ответы TMDB растягивали
	// загрузку на лишние секунды после каждого промаха кэша.
	seasons := make([]TMSeason, 0, limit)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for s := 1; s <= limit; s++ {
		wg.Add(1)
		go func(s int) {
			defer wg.Done()
			u := base + strconv.Itoa(s) + "?language=ru-RU"
			req, err := tmdbRequest(u)
			if err != nil {
				return
			}
			resp, err := cl.Do(req)
			if err != nil {
				return
			}
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return
			}
			var j struct {
				Name     string `json:"name"`
				AirDate  string `json:"air_date"`
				Overview string `json:"overview"`
				Poster   string `json:"poster_path"`
				Episodes []struct {
					EpisodeNumber int     `json:"episode_number"`
					Name          string  `json:"name"`
					Overview      string  `json:"overview"`
					AirDate       string  `json:"air_date"`
					Runtime       int     `json:"runtime"`
					Still         string  `json:"still_path"`
					Rating        float64 `json:"vote_average"`
				} `json:"episodes"`
			}
			if json.Unmarshal(body, &j) != nil {
				return
			}
			if len(j.Episodes) == 0 {
				return
			}
			season := TMSeason{
				Number:   s,
				Name:     strings.TrimSpace(j.Name),
				AirDate:  j.AirDate,
				Overview: strings.TrimSpace(j.Overview),
				Poster:   tmdbImage(j.Poster, "w300"),
			}
			m := map[int]string{}
			for _, e := range j.Episodes {
				if e.EpisodeNumber <= 0 {
					continue
				}
				ep := TMEpisode{
					Number:   e.EpisodeNumber,
					Name:     strings.TrimSpace(e.Name),
					AirDate:  e.AirDate,
					Runtime:  e.Runtime,
					Overview: strings.TrimSpace(e.Overview),
					Still:    tmdbImage(e.Still, "w300"),
					Rating:   e.Rating,
				}
				season.Episodes = append(season.Episodes, ep)
				if ep.Name != "" {
					m[e.EpisodeNumber] = ep.Name
				}
			}
			mu.Lock()
			if len(m) > 0 {
				dst[s] = m
			}
			seasons = append(seasons, season)
			mu.Unlock()
		}(s)
	}
	wg.Wait()
	// Параллельный сбор не гарантирует порядка: порядок восстанавливается по
	// номеру сезона.
	sort.Slice(seasons, func(i, j int) bool { return seasons[i].Number < seasons[j].Number })
	if len(dst) > 0 {
		return seasons, dst, true
	}
	return seasons, dst, false
}

// tmdbImage достраивает адрес кадра: в ответе TMDB приходит только путь.
func tmdbImage(p, size string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if strings.HasPrefix(p, "http") {
		return p
	}
	return "https://image.tmdb.org/t/p/" + size + p
}

func (c *Comp) cinemetaRating(imdb, typ string) float64 {
	try := []string{"movie", "series"}
	if typ == "tv" || typ == "series" {
		try = []string{"series", "movie"}
	}
	cl := &http.Client{Timeout: 10 * time.Second}
	for _, t := range try {
		u := "https://v3-cinemeta.strem.io/meta/" + t + "/" + imdb + ".json"
		req, err := http.NewRequest("GET", u, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "Mozilla/5.0")
		resp, err := cl.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			continue
		}
		var j struct {
			Meta struct {
				ImdbRating json.RawMessage `json:"imdbRating"`
			} `json:"meta"`
		}
		if json.Unmarshal(body, &j) != nil {
			continue
		}
		var s string
		if json.Unmarshal(j.Meta.ImdbRating, &s) == nil {
			if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil && f > 0 {
				return f
			}
			continue
		}
		var f float64
		if json.Unmarshal(j.Meta.ImdbRating, &f) == nil && f > 0 {
			return f
		}
	}
	return 0
}
