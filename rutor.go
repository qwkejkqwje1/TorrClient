package main

// Источник rutor: поиск, ТОП-24, ТОП по категории и разбор выдачи.

import (
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- TOP-24 (rutor "Топ торренты за последние 24 часа") ----------

type rutorItem struct {
	Title  string `json:"title"`
	Size   string `json:"size"`
	Seed   int    `json:"seed"`
	Peer   int    `json:"peer"`
	Link   string `json:"link"`
	Get    string `json:"get,omitempty"`
	Hash   string `json:"hash"`
	Magnet string `json:"magnet"`
	Date   string `json:"date"`
}

var (
	topMu   sync.Mutex
	topItem struct {
		items []rutorItem
		t     time.Time
	}
)

// Адрес трекера и вид адреса выдачи.
//
// rutorBaseURL — переменная, а не константа: тесты подставляют свой сервер,
// чтобы проверить, какую именно страницу просит поиск. Зеркала перебираются
// после основного адреса, если он не отдал разбираемую выдачу (капча, смена
// разметки, недоступность): один мёртвый или запросивший капчу домен не должен
// останавливать и поиск, и ТОП-24 разом.
var rutorBaseURL = "https://rutor.info"

// rutorMirrorURLs — дополнительные адреса rutor. Проверено 21.09.2026: жив
// только rutor.info, остальные отвечают ошибкой или 403. Список короткий, чтобы
// при вымирании основного домена не тянуть недостижимые адреса подряд: каждая
// попытка ограничена таймаутом клиента, и с пятью мёртвыми зеркалами ожидание
// выросло бы на минуты.
var rutorMirrorURLs = []string{
	"https://rutor.la",
	"https://rutor.is",
	"https://rutor.top",
}

const (
	// Вид адреса выдачи:
	// /search/<страница>/<категория>/<метод поиска><где искать>0/<сортировка>/<запрос>.
	//
	// Нумерация страниц у rutor начинается с нуля: search/0 — первая страница
	// выдачи, search/1 — вторая. Запрос search/1 выбрасывает первые сто
	// результатов, а с ними и всё свежее: на живой странице search/1 раздачи
	// датированы 2018–2019 годами, тогда как search/0 — текущим годом.
	//
	// Метод поиска (0 — фраза целиком) и место (0 — только название) в шаблоне
	// уже сведены в «000»: приложение их не меняет.
	rutorSearchPath = "/search/%d/%d/000/0/"

	// Сколько строк выдачи показываем за один раз.
	rutorPageSize = 100

	// Сколько страниц выдачи держать в кэше и как долго.
	rutorCacheTTL     = 4 * time.Minute
	rutorCacheMaxSize = 24

	// Заголовок второго блока страницы /top/1. Первый блок — «Топ торренты за
	// последние 24 часа», дальше начинаются «Самые популярные торренты в
	// категории …»: это уже не сутки, и в ТОП-24 они попадать не должны.
	rutorTopCategoryHeader = "Самые популярные торренты в категории"

	// Сколько строк занимает блок суток на /top/1. Нужно как запасной ориентир,
	// если заголовок категорийного блока в раскладке не найдётся.
	rutorTop24Block = 30
)

// rutorCategories — коды категорий из формы поиска самого rutor. Категория у
// трекера это поле адреса, а не слово запроса: запрос «фильм 2024» ищет
// раздачи, в названии которых встречается слово «фильм», и к категории
// отношения не имеет. Интерфейс раньше приписывал выбранную категорию к
// запросу — то есть сужал выдачу словом, которого в названиях нет.
//
// Таблица снята с <select name="category"> на живой странице 20.09.2026 и
// проверена запросами: cat=8 отдаёт игры, cat=1 — зарубежные фильмы, cat=11 —
// книги.
var rutorCategories = map[int]string{
	0:  "Любая категория",
	1:  "Зарубежные фильмы",
	2:  "Музыка",
	3:  "Другое",
	4:  "Зарубежные сериалы",
	5:  "Наши фильмы",
	6:  "Телевизор",
	7:  "Мультипликация",
	8:  "Игры",
	9:  "Софт",
	10: "Аниме",
	11: "Книги",
	12: "Научно-популярные фильмы",
	13: "Спорт и Здоровье",
	14: "Хозяйство и Быт",
	15: "Юмор",
	16: "Наши сериалы",
	17: "Иностранные релизы",
}

// normalizeRutorCat отбрасывает неизвестный код категории. Подставлять в адрес
// чужое число нельзя: rutor ответит выдачей не той категории, и это будет
// выглядеть как ошибка поиска.
func normalizeRutorCat(cat int) int {
	if _, ok := rutorCategories[cat]; ok {
		return cat
	}
	return 0
}

// dedupeItems убирает повторы в выдаче.
//
// Одна и та же раздача попадается дважды: у rutor — на стыке страниц, когда
// между запросами на трекер добавили новую раздачу (нумерация страниц
// сдвигается, и последняя строка первой страницы становится первой строкой
// второй). Ключ — хеш, а при его отсутствии название с размером: у Кинозала
// магнита в выдаче нет, и хеша тоже.
func dedupeItems(items []rutorItem) []rutorItem {
	seen := make(map[string]bool, len(items))
	out := make([]rutorItem, 0, len(items))
	for _, it := range items {
		key := it.Hash
		if key == "" {
			key = strings.ToLower(it.Title) + "\x00" + it.Size
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, it)
	}
	return out
}

// Причины пустой выдачи. Без их различения капча, недоступная сеть и
// изменившаяся разметка выглядят для пользователя одинаково — «ничего не
// найдено», и поломка разбора живёт незамеченной месяцами.
var (
	errRutorNetwork = errors.New("трекер не ответил")
	errRutorMarkup  = errors.New("страница получена, но выдача не разобрана (возможна капча или изменившаяся разметка)")
)

var (
	rutorRowRe    = regexp.MustCompile(`(?s)<tr class="(?:gai|tum)".*?</tr>`)
	rutorDateRe   = regexp.MustCompile(`(?s)<tr class="(?:gai|tum)"><td>([^<]*)</td>`)
	rutorTitleRe  = regexp.MustCompile(`href="/torrent/\d+[^"]*">([^<]*)</a>`)
	rutorMagnetRe = regexp.MustCompile(`href="(magnet:[^"]+)"`)
	rutorPageRe   = regexp.MustCompile(`href="(/torrent/\d+[^"]*)"`)
	// Размер — ячейка с единицей измерения. Одного выравнивания мало: в той же
	// колонке, прямо перед размером, стоит число комментариев, и по
	// align="right" читалось бы оно.
	rutorSizeRe = regexp.MustCompile(`(?i)align="right">\s*([\d.,]+\s*(?:KB|MB|GB|TB))\s*</td>`)
	// Квантификатор обязан быть ленивым. Жадный .* дотягивается до последнего
	// </span> в строке, а это соседняя красная ячейка с числом пиров: сиды и
	// пиры показывались одним и тем же числом (на раздаче с 6 сидами и 3
	// пирами обе величины читались как 3).
	rutorSeedRe = regexp.MustCompile(`<span class="green">.*?(-?\d+)\s*</span>`)
	rutorPeerRe = regexp.MustCompile(`<span class="red">[^<]*?(-?\d+)\s*</span>`)
	rutorHashRe = regexp.MustCompile(`btih:([0-9a-fA-F]{40})`)
)

// rutorSpaces заменяет неразрывный пробел обычным до сопоставления. Живой
// трекер разделяет им день, месяц и год в дате, а регулярка не считает
// неразрывный пробел пробелом: дата и размер не читались вовсе.
var rutorSpaces = strings.NewReplacer("&nbsp;", " ", "\u00a0", " ")

// httpClient — общий клиент для обращений к сайтам-трекеров.
//
// Проверка сертификата включена. Раньше в четырёх местах стоял
// InsecureSkipVerify: true, то есть подмена ответа трекера была неотличима от
// настоящего ответа; через этот же клиент пойдут учётные данные, когда
// появится вход на трекер.
//
// Транспорт задан явно ради короткого соединения (5 секунд): недостижимое
// зеркало должно отвалиться быстро, а не держать пользователя по таймауту
// полной попытки. Прокси берётся из окружения, как и у стандартного
// транспорта.
var httpClient = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   8 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	},
}

const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

// ---------- Rutor search прямо из демона (не зависит от TorrServer) ----------

// searchCacheStore — кэш страниц выдачи, общий для обоих источников.
//
// Раньше у каждого источника хранилась одна запись, и переход на вторую
// страницу вытеснял первую: возврат на неё снова шёл в сеть, а rutor отвечает
// капчей на частые запросы. Теперь записей несколько, вытесняется самая старая.
type searchCacheStore struct {
	mu      sync.Mutex
	entries map[string]rutorCacheEntry
}

type rutorCacheEntry struct {
	items []rutorItem
	t     time.Time
}

var rutorSearch searchCacheStore

func (c *searchCacheStore) get(key string) ([]rutorItem, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Since(e.t) >= rutorCacheTTL {
		return nil, false
	}
	return e.items, true
}

// clear сбрасывает кэш: после смены зеркал старая выдача не должна жить до TTL.
func (c *searchCacheStore) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = nil
}

func (c *searchCacheStore) put(key string, items []rutorItem) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]rutorCacheEntry)
	}
	if len(c.entries) >= rutorCacheMaxSize {
		var oldestKey string
		var oldestT time.Time
		for k, e := range c.entries {
			if oldestKey == "" || e.t.Before(oldestT) {
				oldestKey, oldestT = k, e.t
			}
		}
		delete(c.entries, oldestKey)
	}
	c.entries[key] = rutorCacheEntry{items: items, t: time.Now()}
}

func (c *searchCacheStore) reset() {
	c.mu.Lock()
	c.entries = nil
	c.mu.Unlock()
}

func (c *Comp) apiRutorSearch(w http.ResponseWriter, r *http.Request) {
	page := atoiSafe(r.URL.Query().Get("page"))
	if page < 0 || page > 20 {
		page = 0
	}
	cat := normalizeRutorCat(atoiSafe(r.URL.Query().Get("cat")))
	items, err := c.rutorSearch(strings.TrimSpace(r.URL.Query().Get("query")), page, cat)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	jj(w, items)
}

// rutorSearch — поиск на rutor.info напрямую из демона (не зависит от
// TorrServer). Кэшируется на 4 минуты по тройке «запрос, страница, категория».
//
// Возвращает ошибку, когда трекер не ответил или ответ не разобран: вызывающий
// обязан показать это пользователю, иначе капча и «ничего не найдено»
// неотличимы.
func (c *Comp) rutorSearch(q string, page, cat int) ([]rutorItem, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return []rutorItem{}, nil
	}
	if page < 0 {
		page = 0
	}
	cat = normalizeRutorCat(cat)
	key := fmt.Sprintf("%d\x00%d\x00%s", page, cat, strings.ToLower(q))

	if items, ok := rutorSearch.get(key); ok {
		return items, nil
	}

	pagePath := fmt.Sprintf(rutorSearchPath, page, cat) + url.QueryEscape(q)
	items, err := c.fetchRutorPage(rutorBaseURL + pagePath)
	// Основной адрес жив и отдаёт выдачу чаще всего; капчу при частых запросах
	// лечим паузой и повтором. Зеркала трогаются только если и он не ответил.
	if err != nil {
		if errors.Is(err, errRutorMarkup) {
			time.Sleep(1200 * time.Millisecond)
			items, err = c.fetchRutorPage(rutorBaseURL + pagePath)
		}
		if err != nil {
			items, err = c.fetchRutorFrom(pagePath, func(doc string) []rutorItem {
				return parseRutorRows(doc, 0)
			})
		}
	}
	if err != nil {
		return nil, err
	}
	if len(items) > rutorPageSize {
		items = items[:rutorPageSize]
	}
	rutorSearch.put(key, items)
	return items, nil
}

func (c *Comp) apiTop24(w http.ResponseWriter, r *http.Request) {
	topMu.Lock()
	if time.Since(topItem.t) < 5*time.Minute && topItem.items != nil {
		items := topItem.items
		topMu.Unlock()
		jj(w, map[string]any{"ok": true, "items": items})
		return
	}
	topMu.Unlock()

	items, err := c.fetchRutorTop()
	if err != nil {
		jj(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	topMu.Lock()
	topItem.items = items
	topItem.t = time.Now()
	topMu.Unlock()
	jj(w, map[string]any{"ok": true, "items": items})
}

// apiTopcat: ТОП раздач по категории раздела rutor.info (/kino, /anime, ...).
// Разделы отдают свежие раздачи категории — сортируем по сидам.
func (c *Comp) apiTopcat(w http.ResponseWriter, r *http.Request) {
	sec := strings.TrimSpace(r.URL.Query().Get("cat"))
	if sec == "" || strings.ContainsAny(sec, "/\\?&#") {
		sec = "kino"
	}
	items, err := c.fetchRutorFrom("/"+sec, func(doc string) []rutorItem {
		return parseRutorRows(doc, 0)
	})
	if err != nil {
		jj(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if r.URL.Query().Get("sort") == "peer" {
		sort.SliceStable(items, func(i, j int) bool { return items[i].Peer > items[j].Peer })
	} else {
		sort.SliceStable(items, func(i, j int) bool { return items[i].Seed > items[j].Seed })
	}
	if len(items) > rutorPageSize {
		items = items[:rutorPageSize]
	}
	jj(w, map[string]any{"ok": true, "cat": sec, "items": items})
}

// fetchRutorTop читает первый блок страницы /top/1 — «Топ торренты за
// последние 24 часа». Дальше на той же странице идут «Самые популярные
// торренты в категории …»: это уже не сутки.
//
// Обрезка по числу строк здесь не работает: страница содержит 285 строк, блок
// суток занимает ровно первые 30, а обрезка по 40 подмешивала в ТОП-24 десять
// строк категорийных топов — частью месячной давности.
func (c *Comp) fetchRutorTop() ([]rutorItem, error) {
	items, err := c.fetchRutorFrom("/top/1", func(doc string) []rutorItem {
		if i := strings.Index(doc, rutorTopCategoryHeader); i > 0 {
			doc = doc[:i]
		} else {
			// Заголовок не найден — раскладка изменилась. Ограничиваемся
			// известным размером блока суток, чтобы категорийные топы не
			// попали в выдачу.
			doc = firstRows(doc, rutorTop24Block)
		}
		return parseRutorRows(doc, 0)
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errRutorNetwork, err)
	}
	return items, nil
}

// firstRows обрезает документ после n-й строки выдачи. Запасной путь на случай,
// если заголовок категорийного блока в раскладке не найдётся.
//
// Считаются именно строки выдачи, а не «</tr>» вообще: до таблицы результатов
// на странице есть и другие строки, и по закрывающим тегам граница уезжала.
func firstRows(doc string, n int) string {
	locs := rutorRowRe.FindAllStringIndex(doc, n)
	if len(locs) < n {
		return doc
	}
	return doc[:locs[n-1][1]]
}

// fetchRutorPage забирает страницу и разбирает строки выдачи.
//
// Ошибка различает «трекер не ответил» и «ответил, но разобрать нечего»:
// капча и смена разметки не должны выглядеть как пустая выдача.
func (c *Comp) fetchRutorPage(pageURL string) ([]rutorItem, error) {
	doc, err := c.fetchHTML(pageURL)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errRutorNetwork, err)
	}
	items := parseRutorRows(doc, 0)
	if len(items) == 0 {
		return nil, errRutorMarkup
	}
	return items, nil
}

// rutorBases — адреса поиска в порядке приоритета: основной домен, затем
// зеркала. Тест подставляет свой сервер в rutorBaseURL — и первым пробуется
// он; зеркала тронутся только если он не ответил разбираемым документом.
func rutorBases() []string {
	out := make([]string, 0, 1+len(rutorMirrorURLs))
	out = append(out, strings.TrimRight(rutorBaseURL, "/"))
	out = append(out, rutorMirrorURLs...)
	return out
}

// fetchRutorFrom забирает страницу по пути и перебирает адреса, пока какой-
// нибудь не отдаст разбираемую выдачу. Капча или изменившаяся разметка на
// одном домене не должны выглядеть как «трекер мёртв»: следующим адресом может
// ответить живое зеркало. Если не ответил ни один — ошибка с причиной
// последней попытки и числом проверенных адресов.
func (c *Comp) fetchRutorFrom(path string, docParse func(doc string) []rutorItem) ([]rutorItem, error) {
	// Причины собираются по всем адресам: раньше показывалась только
	// последняя («rutor.top: 403»), а отказ основного rutor.info терялся.
	var reasons []string
	for _, base := range rutorBases() {
		host := strings.TrimPrefix(base, "https://")
		doc, err := c.fetchHTML(base + path)
		if err != nil {
			reasons = append(reasons, host+": "+kinozalReason(err.Error()))
			continue
		}
		items := docParse(doc)
		if len(items) == 0 {
			reasons = append(reasons, host+": пустая страница (капча, изменившаяся разметка или ничего не найдено)")
			continue
		}
		return items, nil
	}
	if len(reasons) == 0 {
		return nil, errors.New("rutor: список адресов пуст")
	}
	return nil, fmt.Errorf("rutor: ни один адрес не отдал выдачу — %s", strings.Join(reasons, "; "))
}

// fetchHTML забирает страницу, переводит её в UTF-8 и нормализует неразрывные
// пробелы.
//
// Кодировка определяется по заголовку ответа и по <meta> внутри страницы:
// Rutor отдаёт UTF-8, Кинозал — windows-1251. Без перевода кириллица Кинозала
// приходила бы нечитаемыми байтами, и разбор молча давал бы пустую выдачу.
//
// Замена пробелов делается до разбора, потому что регулярка не считает
// неразрывный пробел пробелом: живой трекер разделяет им день, месяц и год в
// дате, и без замены дата и размер не читались.
func (c *Comp) fetchHTML(pageURL string) (string, error) {
	req, err := http.NewRequest("GET", pageURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", browserUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("Accept-Language", "ru-RU,ru;q=0.9")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("код ответа %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
	if err != nil {
		return "", err
	}
	return rutorSpaces.Replace(decodeBody(body, resp.Header.Get("Content-Type"))), nil
}

// parseRutorRows разбирает строки выдачи. limit <= 0 — без ограничения.
//
// Повторы выбрасываются: одна и та же раздача стоит в выдаче дважды, когда
// попадает и в блок суток, и в категорийный топ на /top/1 (в живой фикстуре
// таких 9 из 285).
func parseRutorRows(doc string, limit int) []rutorItem {
	var out []rutorItem
	for _, row := range rutorRowRe.FindAllString(doc, -1) {
		it := parseRutorRow(row)
		// Строку без названия или без магнита добавить нельзя: магнит лежит
		// прямо в выдаче, и его отсутствие означает, что строка разобрана не
		// полностью.
		if it.Title == "" || it.Magnet == "" {
			continue
		}
		out = append(out, it)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return dedupeItems(out)
}

func parseRutorRow(row string) rutorItem {
	// Строка нормализуется и здесь, а не только в fetchHTML: неразрывный пробел
	// разделяет в ячейке число и единицу измерения («265.94&nbsp;GB»), и без
	// замены размер не читается вовсе. Функция обязана быть верной независимо
	// от того, кто её позвал.
	row = rutorSpaces.Replace(row)
	var it rutorItem
	if m := rutorMagnetRe.FindStringSubmatch(row); len(m) == 2 {
		it.Magnet = html.UnescapeString(m[1])
	}
	if m := rutorTitleRe.FindStringSubmatch(row); len(m) == 2 {
		it.Title = strings.TrimSpace(html.UnescapeString(m[1]))
	}
	if m := rutorDateRe.FindStringSubmatch(row); len(m) == 2 {
		it.Date = strings.TrimSpace(html.UnescapeString(m[1]))
	}
	if m := rutorSizeRe.FindStringSubmatch(row); len(m) == 2 {
		it.Size = strings.TrimSpace(html.UnescapeString(m[1]))
	}
	if m := rutorSeedRe.FindStringSubmatch(row); len(m) == 2 {
		it.Seed = atoiSafe(m[1])
	}
	if m := rutorPeerRe.FindStringSubmatch(row); len(m) == 2 {
		it.Peer = atoiSafe(m[1])
	}
	if m := rutorHashRe.FindStringSubmatch(it.Magnet); len(m) == 2 {
		it.Hash = strings.ToLower(m[1])
	}
	if m := rutorPageRe.FindStringSubmatch(row); len(m) == 2 {
		it.Link = rutorBaseURL + m[1]
	}
	return it
}

func atoiSafe(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return 0
}
