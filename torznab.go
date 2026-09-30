package main

// Источник Torznab: поиск напрямую по индексатору (Jackett, Prowlarr), без
// TorrServer.
//
// Почему не через сервер: у TorrServer есть свой Torznab, но он отдаёт только
// первую страницу, не различает «не настроен» и «упал», и не имеет таймаута —
// зависший индексатор держит поиск открытым. Свой клиент даёт пагинацию, кэш,
// честную ошибку и покрывается тестами на эталоне, как rutor и Кинозал.

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- границы и признаки ошибок ----------

const (
	// torznabPageLimit — сколько раздач просим у индексатора за раз. Jackett и
	// Prowlarr оба режут выдачу по этому числу, а не отдают «всё, что нашли».
	torznabPageLimit = 100
	// torznabMaxPages — потолок пагинации: 20 страниц по 100 = 2000 раздач.
	// Дальше поиск в трекере бесполезен и упирается в ограничитель.
	torznabMaxPages = 20
	// torznabProbeQuery — запрос для проверки индексатора. Короткий и частый:
	// проверка не должна нагружать трекер и не должна искать то, что не найдётся.
	torznabProbeQuery = "matrix"
	// torznabBodyLimit — потолок ответа. Выдача в 100 раздач весит сотни
	// килобайт; мегабайтный ответ — это уже не поиск, а злоупотребление.
	torznabBodyLimit = 4 << 20
)

var (
	errTorznabNetwork = errors.New("сеть недоступна")
	errTorznabMarkup  = errors.New("ответ не разобран как Torznab")
	errTorznabAuth    = errors.New("индексатор отклонил ключ")
)

// decodeTorznabBody разбирает тело запроса с потолком размера — тем же
// приёмом, что и остальные ручки: без ограничения тело читается до упоя, а
// это уже способ занять память.
func decodeTorznabBody(w http.ResponseWriter, r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(v)
}

// torznabMaskKey оставляет от ключа начало и конец: человек должен узнать свой
// ключ в списке, но не переписывать его целиком каждый раз и не хранить его в
// буфере обмена вместе с остальным выводом.
func torznabMaskKey(k string) string {
	if len(k) <= 6 {
		return "••••"
	}
	return k[:3] + "…" + k[len(k)-2:]
}

// ---------- конфигурация источника ----------

// TorznabSource — один индексатор. В том же виде он лежит в torrclient.json,
// поэтому json-имена ст��бильные: их читают и ручка настроек, и человек, если
// правит конфиг вручную.
type TorznabSource struct {
	// Name — как источник называется в интерфейсе и в отчёте по поиску.
	// Служит ключом при правке, поэтому должен быть уникален в списке.
	Name string `json:"name"`
	// URL — адрес ручки Torznab целиком, без query. У Jackett он заканчивается
	// на /results/torznab/api, у Prowlarr — на /api/v1/indexers/<имя>/results/torznab/api.
	URL string `json:"url"`
	// APIKey — ключ индексатора. Пустой ключ бывает у локального Jackett без
	// авторизации, и это нормально: поиск работает и без него.
	APIKey string `json:"api_key,omitempty"`
}

// normTorznabURL приводит адрес индексатора к единому виду и проверяет его.
//
// Что чинит: «http://хост:9117/» и «http://хост:9117» должны быть одним
// источником, иначе в кэше и в списке они разойдутся. Что отвергает: пустой
// адрес, без схемы и не http(s) — такой всё равно не спросить, а молча
// пропустить хуже, чем сказать.
//
// Возвращает адрес без query и без хвостового слеша: ключ и параметры поиска
// дописываются при запросе. Ключ, если он был прямо в адресе (?apikey=… —
// именно так его отдаёт кнопка копирования в Jackett), вынимается и
// возвращается отдельно.
func normTorznabURL(raw string) (string, string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", "", errors.New("адрес пуст")
	}
	// Схему подставляем сами: пользователи привыкли писать «localhost:9117/...»
	// без «http://», и раньше это молча не работало.
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", "", errors.New("адрес не разобран")
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return "", "", errors.New("нужен адрес http:// или https://")
	}
	if u.Host == "" {
		return "", "", errors.New("в адресе нет хоста")
	}
	key := strings.TrimSpace(u.Query().Get("apikey"))
	if key != "" {
		q := u.Query()
		q.Del("apikey")
		u.RawQuery = q.Encode()
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u.String(), key, nil
}

// normTorznabSource проверяет и дополняет источник: имя без пробелов по краям,
// адрес нормализован, ключ обрезан. source — копия, вызывающий не меняет свой.
func normTorznabSource(s TorznabSource) (TorznabSource, error) {
	out := TorznabSource{
		Name:   strings.TrimSpace(s.Name),
		APIKey: strings.TrimSpace(s.APIKey),
	}
	addr, key, err := normTorznabURL(s.URL)
	if err != nil {
		return out, err
	}
	if out.APIKey != "" {
		key = out.APIKey // явное поле важнее того, что нашлось в адресе
	}
	out.URL = addr
	out.APIKey = key
	if out.Name == "" {
		out.Name = torznabSourceName(addr)
	}
	return out, nil
}

// torznabSourceName придумывает имя источника по адресу, чтобы в списке не было
// безымянных строк. Хост без порта — узнаваемее, чем «индексатор 1».
func torznabSourceName(addr string) string {
	u, err := url.Parse(addr)
	if err != nil || u.Host == "" {
		return "Индексатор"
	}
	return u.Host
}

// ---------- разбор ответа Torznab ----------

// torznabFeed — RSS-ответ индексатора. Разбирается через encoding/xml, а не
// регулярками: в title раздачи попадают «&», «<» и «&amp;», и регулярка на этом
// ломается, а xml — штатное дело.
type torznabFeed struct {
	Channel struct {
		Title string         `xml:"title"`
		Items []torznabEntry `xml:"item"`
	} `xml:"channel"`
}

type torznabEntry struct {
	Title      string   `xml:"title"`
	Link       string   `xml:"link"`
	GUID       string   `xml:"guid"`
	PubDate    string   `xml:"pubDate"`
	Categories []string `xml:"category"`
	Size       string   `xml:"size"`
	Enclosure  struct {
		URL    string `xml:"url,attr"`
		Length string `xml:"length,attr"`
		Type   string `xml:"type,attr"`
	} `xml:"enclosure"`
	Attrs []struct {
		Name  string `xml:"name,attr"`
		Value string `xml:"value,attr"`
	} `xml:"attr"`
}

// attr ищёт значение дополнительного поля Torznab (пространство имён torznab).
func (e torznabEntry) attr(names ...string) string {
	for _, a := range e.Attrs {
		for _, n := range names {
			if strings.EqualFold(a.Name, n) {
				return strings.TrimSpace(a.Value)
			}
		}
	}
	return ""
}

// parseTorznabFeed разбирает RSS индексатора в наши раздачи.
//
// Что считается годной раздачей: есть заголовок и есть чем её взять — magnet
// в link/guid либо infohash (тогда magnet собирается самим). Раздача без ссылки
// и без хеша не качается, и в выдаче она только мешает: интерфейс насчитал бы
// «25 раздач», а добавить нельзя ни одну.
//
// Возвращает errTorznabMarkup, если в ответе нет ни одного item: так отличается
// «индексатор жив, но это не Torznab» (страница ошибки, HTML-заглушка,
// авторизация с редиректом на вход) от пустой выдачи.
func parseTorznabFeed(data []byte) ([]rutorItem, error) {
	var feed torznabFeed
	if err := xml.Unmarshal(data, &feed); err != nil {
		return nil, fmt.Errorf("%w: %v", errTorznabMarkup, err)
	}
	if len(feed.Channel.Items) == 0 {
		return nil, errTorznabMarkup
	}
	items := make([]rutorItem, 0, len(feed.Channel.Items))
	for _, e := range feed.Channel.Items {
		if it, ok := torznabItem(e); ok {
			items = append(items, it)
		}
	}
	return items, nil
}

// torznabItem превращает один item в раздачу. ok=false — раздача без заголовка
// или без способа скачивания.
func torznabItem(e torznabEntry) (rutorItem, bool) {
	title := collapseSpace(e.Title)
	if title == "" {
		return rutorItem{}, false
	}
	it := rutorItem{Title: title}

	// Ссылка: magnet где бы он ни был — в link, в guid или в enclosure.
	for _, cand := range []string{e.Link, e.GUID, e.Enclosure.URL} {
		cand = strings.TrimSpace(cand)
		if strings.HasPrefix(strings.ToLower(cand), "magnet:") {
			it.Magnet = cand
			break
		}
	}
	// Хеш: из magnet, из infohash или из ссылки на .torrent с хешем в имени.
	hash := torznabHash(it.Magnet, e.attr("infohash"))
	if it.Magnet == "" && hash != "" {
		it.Magnet = "magnet:?xt=urn:btih:" + hash
	}
	link := strings.TrimSpace(e.Link)
	if link == "" || strings.HasPrefix(strings.ToLower(link), "magnet:") {
		link = strings.TrimSpace(e.Enclosure.URL)
	}
	if link == "" && hash != "" {
		link = it.Magnet
	}
	if it.Magnet == "" && link == "" {
		return rutorItem{}, false
	}
	it.Link = link
	it.Hash = hash

	// Размер: сначала точное число из атрибута, потом length у enclosure, потом
	// человекопонятная строка. Строковый размер оставляем как есть — его уже
	// умеет показывать интерфейс.
	if n, err := strconv.ParseInt(e.attr("sizebytes", "size"), 10, 64); err == nil && n > 0 {
		it.Size = humanBytes(n)
	} else if n, err := strconv.ParseInt(strings.TrimSpace(e.Enclosure.Length), 10, 64); err == nil && n > 0 {
		it.Size = humanBytes(n)
	} else if s := strings.TrimSpace(e.Size); s != "" {
		it.Size = s
	}

	if n, err := strconv.Atoi(torznabAtoi(e.attr("seeders", "seed"))); err == nil {
		it.Seed = n
	}
	if n, err := strconv.Atoi(torznabAtoi(e.attr("leechers", "peer", "leech"))); err == nil {
		it.Peer = n
	}
	it.Date = strings.TrimSpace(e.PubDate)
	return it, true
}

// torznabHash достаёт infohash из magnet-ссылки или из атрибута.
// torznabHash достаёт infohash из magnet-ссылки или из атрибута.
//
// Принимаются оба вида infohash: 40 hex-символов и 32 символа base32.
// Второй встречается у части индексаторов, и он не проходит проверку «это
// hex», поэтому разбирается отдельно — иначе раздача молча теряла бы хеш и
// выпадала из выдачи как «нечего качать».
func torznabHash(magnet, infohash string) string {
	infohash = strings.TrimSpace(strings.ToLower(infohash))
	if len(infohash) == 40 && isHex(infohash) {
		return infohash
	}
	if h := torznabBase32Hash(infohash); h != "" {
		return h
	}
	magnet = strings.TrimSpace(magnet)
	if i := strings.Index(strings.ToLower(magnet), "urn:btih:"); i >= 0 {
		rest := magnet[i+len("urn:btih:"):]
		if j := strings.IndexAny(rest, "&/?"); j >= 0 {
			rest = rest[:j]
		}
		if strings.HasPrefix(strings.ToLower(rest), "h:") {
			rest = rest[2:]
		}
		rest = strings.ToLower(strings.TrimSpace(rest))
		if len(rest) == 40 && isHex(rest) {
			return rest
		}
		// 32 hex-символа — это тоже не base32, а сокращённый вид, который
		// индексаторы не отдают; пробуем разобрать как base32, и если не
		// вышло — не выдумываем хеш.
		return torznabBase32Hash(rest)
	}
	return ""
}

// torznabBase32Hash разбирает 32-символьный base32-инфохаш в 40 hex-символов.
// Пустая строка — значит «это не base32-инфохаш».
func torznabBase32Hash(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != 32 {
		return ""
	}
	b, err := base32Decode(s)
	if err != nil || len(b) != 20 {
		return ""
	}
	return hexLower(b)
}

func torznabAtoi(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "0"
	}
	// Индексаторы пишут «-1», когда раздачу ещё никто не качал. В нашей выдаче
	// это ноль, иначе пустая раздача встанет выше всех.
	if strings.HasPrefix(s, "-") {
		return "0"
	}
	return s
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return len(s) > 0
}

func hexLower(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, digits[c>>4], digits[c&0x0f])
	}
	return string(out)
}

func base32Decode(s string) ([]byte, error) {
	s = strings.ToUpper(strings.TrimRight(s, "="))
	var out []byte
	var buf, bits int
	for i := 0; i < len(s); i++ {
		idx := strings.IndexByte("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", s[i])
		if idx < 0 {
			return nil, errors.New("не base32")
		}
		buf = buf<<5 | idx
		bits += 5
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(buf>>bits))
		}
	}
	return out, nil
}

// humanBytes печатает размер так, как привык человек: «1,4 ГБ». Точное число
// раздаче всё равно нужно для сортировки, поэтому в интерфейс уходит и строка,
// и байты — но байты считает сам интерфейс из строки, как и у rutor.
func humanBytes(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d Б", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 3; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cБ", float64(n)/float64(div), "KMGT"[exp])
}

// collapseSpace убирает переносы строк и повторы пробелов: индексаторы присылают
// название в несколько строк, а список от этого «рвётся».
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// ---------- запрос к индексатору ----------

// torznabBuildURL собирает адрес поискового запроса. Отдельная чистая функция:
// правила стандарта (t=, q=, cat=, limit=, offset=, extended=) должны быть
// видны и проверяемы, а не прятаться в HTTP-запросе.
func torznabBuildURL(addr, key, query, cat string, page, limit int) string {
	if limit <= 0 {
		limit = torznabPageLimit
	}
	if page < 0 {
		page = 0
	}
	v := url.Values{}
	v.Set("t", "search")
	if query != "" {
		v.Set("q", query)
	}
	if cat != "" {
		v.Set("cat", cat)
	}
	v.Set("limit", strconv.Itoa(limit))
	if page > 0 {
		v.Set("offset", strconv.Itoa(page*limit))
	}
	// extended=1 возвращает размер, сиды, личи и infohash атрибутами. Без него
	// индексатор отдаёт почти пустые item, и раздач с размером не видно.
	v.Set("extended", "1")
	if key != "" {
		v.Set("apikey", key)
	}
	return addr + "?" + v.Encode()
}

// fetchTorznab спрашивает один индексатор. Таймаут и User-Agent — те же, что у
// rutor: индексаторы любят молча не отвечать, и это должно быть видно сразу,
// а не висеть в интерфейсе.
func fetchTorznab(addr, key, query, cat string, page int) ([]rutorItem, error) {
	reqURL := torznabBuildURL(addr, key, query, cat, page, torznabPageLimit)
	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	// Некоторые индексаторы (и Jackett в том числе) режут запросы без внятного
	// User-Agent; TorzClient шлёт свой.
	req.Header.Set("User-Agent", browserUserAgent)
	req.Header.Set("Accept", "application/rss+xml, application/xml, text/xml, */*")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%w: код %d", errTorznabAuth, resp.StatusCode)
	case resp.StatusCode == http.StatusNotFound:
		// Онлайн-JacRed (jac-red.ru и подобные) отвечает только JSON-ручкой
		// Jackett, а Torznab-адрес у него — 404. Тогда тот же поиск идёт туда.
		if _, ok := jackettJSONURL(addr, key, query, cat); ok {
			if items, jerr := fetchJackettJSON(addr, key, query, cat, page); jerr == nil {
				return items, nil
			}
		}
		// Чаще всего это неверный адрес: у Jackett путь заканчивается на
		// /results/torznab/api, и опечатка в нём выглядит как 404, а не как
		// «индексатор сломан».
		return nil, fmt.Errorf("код 404 — проверьте адрес: у Jackett он заканчивается на /results/torznab/api")
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("код ответа %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, torznabBodyLimit))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	return parseTorznabFeed(body)
}

// ---------- JSON-ручка Jackett (онлайн-JacRed) ----------

// jackettJSONURL — адрес JSON-поиска Jackett рядом с Torznab-адресом:
// …/indexers/all/results/torznab/api → …/indexers/all/results?Query=…
// Такую ручку отдают и сам Jackett, и JacRed — в том числе онлайн-экземпляры,
// у которых Torznab выключен.
func jackettJSONURL(addr, key, query, cat string) (string, bool) {
	base, ok := strings.CutSuffix(strings.TrimRight(addr, "/"), "/torznab/api")
	if !ok || !strings.HasSuffix(base, "/results") {
		return "", false
	}
	v := url.Values{}
	v.Set("apikey", key)
	v.Set("Query", query)
	if cat != "" {
		for _, c := range strings.Split(cat, ",") {
			if c = strings.TrimSpace(c); c != "" {
				v.Add("Category[]", c)
			}
		}
	}
	return base + "?" + v.Encode(), true
}

// fetchJackettJSON ищет через JSON-ручку. Она отдаёт всё сразу, без страниц,
// поэтому вторая и дальше страницы пусты — иначе «Показать ещё» повторяло бы
// выдачу.
func fetchJackettJSON(addr, key, query, cat string, page int) ([]rutorItem, error) {
	u, ok := jackettJSONURL(addr, key, query, cat)
	if !ok {
		return nil, errors.New("адрес не похож на Jackett")
	}
	if page > 0 {
		return []rutorItem{}, nil
	}
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	req.Header.Set("User-Agent", browserUserAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("%w: код %d", errTorznabAuth, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("код ответа %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, torznabBodyLimit))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	return parseJackettJSON(body)
}

// parseJackettJSON разбирает ответ {"Results":[…]} Jackett/JacRed.
func parseJackettJSON(body []byte) ([]rutorItem, error) {
	var doc struct {
		Results *[]struct {
			Title       string `json:"Title"`
			Tracker     string `json:"Tracker"`
			Details     string `json:"Details"`
			Link        string `json:"Link"`
			MagnetURI   string `json:"MagnetUri"`
			InfoHash    string `json:"InfoHash"`
			Size        int64  `json:"Size"`
			Seeders     int    `json:"Seeders"`
			Peers       int    `json:"Peers"`
			PublishDate string `json:"PublishDate"`
		} `json:"Results"`
	}
	if err := json.Unmarshal(body, &doc); err != nil || doc.Results == nil {
		return nil, errors.New("ответ не похож на Jackett")
	}
	out := make([]rutorItem, 0, len(*doc.Results))
	for _, r := range *doc.Results {
		title := collapseSpace(r.Title)
		if title == "" {
			continue
		}
		it := rutorItem{Title: title, Seed: r.Seeders, Peer: r.Peers, Date: strings.TrimSpace(r.PublishDate)}
		magnet := strings.TrimSpace(r.MagnetURI)
		if !strings.HasPrefix(strings.ToLower(magnet), "magnet:") {
			magnet = ""
		}
		it.Hash = torznabHash(magnet, r.InfoHash)
		if magnet == "" && it.Hash != "" {
			magnet = "magnet:?xt=urn:btih:" + it.Hash
		}
		it.Magnet = magnet
		it.Link = strings.TrimSpace(r.Link)
		if it.Link == "" {
			it.Link = magnet
		}
		if it.Magnet == "" && it.Link == "" {
			continue
		}
		if r.Size > 0 {
			it.Size = humanBytes(r.Size)
		}
		out = append(out, it)
	}
	return out, nil
}

// ---------- кэш ----------

// Кэш тот же, что у поиска rutor: те же пять минут, тот же потолок. Ключ
// включает индекс источника и страницу, иначе два индексатора с одинаковым
// запросом делили бы выдачу.
var torznabSearch = &searchCacheStore{}

// ---------- поиск по всем источникам ----------

// torznabSourceReport — что получилось от одного индексатора. Отчёт нужен в
// интерфейсе: молчаливый список «ничего не нашлось» не отличить от «индексатор
// упал», а это разные вещи, и чинить их нужно по-разному.
type torznabSourceReport struct {
	Name  string   `json:"name"`
	URL   string   `json:"url"`
	OK    bool     `json:"ok"`
	Items int      `json:"items"`
	MS    int64    `json:"ms"`
	Error string   `json:"error,omitempty"`
	Notes []string `json:"notes,omitempty"`
}

// torznabSearchResult — ответ нашей ручки: раздачи и разбор по источникам.
type torznabSearchResult struct {
	Items   []rutorItem           `json:"items"`
	Sources []torznabSourceReport `json:"sources"`
}

// torznabSearchAll спрашивает все настроенные индексаторы и сводит выдачу.
//
// Источники спрашиваются по очереди, а не параллельно: их обычно один-два, а
// параллельный обход означал бы столько одновременных обращений к трекерам,
// сколько индексаторов настроено. Совпадения по хешу убираются — у разных
// индексаторов один и тот же трекер отдаёт одну и ту же раздачу дважды.
func (c *Comp) torznabSearchAll(query, cat string, page int) (torznabSearchResult, error) {
	srcs := curCfg().TorznabSources
	if len(srcs) == 0 {
		return torznabSearchResult{}, errors.New("индексаторы не настроены: добавьте Torznab-адрес в настройках")
	}
	if page < 0 || page >= torznabMaxPages {
		page = 0
	}
	query = strings.TrimSpace(query)
	cacheKey := fmt.Sprintf("%d\x00%s\x00%s", page, cat, strings.ToLower(query))
	if items, ok := torznabSearch.get(cacheKey); ok {
		return torznabSearchResult{Items: items, Sources: []torznabSourceReport{{Name: "кэш", URL: "", OK: true, Items: len(items)}}}, nil
	}

	res := torznabSearchResult{Items: []rutorItem{}}
	seen := map[string]bool{}
	alive := 0
	for _, s := range srcs {
		rep := torznabSourceReport{Name: s.Name, URL: s.URL}
		addr, key := s.URL, s.APIKey
		start := time.Now()
		items, err := fetchTorznab(addr, key, query, cat, page)
		rep.MS = time.Since(start).Milliseconds()
		if err != nil {
			rep.Error = err.Error()
		} else {
			rep.OK = true
			rep.Items = len(items)
			alive++
			for _, it := range items {
				k := strings.ToLower(it.Hash)
				if k == "" {
					k = strings.ToLower(it.Magnet)
				}
				if k != "" && seen[k] {
					continue
				}
				if k != "" {
					seen[k] = true
				}
				res.Items = append(res.Items, it)
			}
		}
		res.Sources = append(res.Sources, rep)
	}
	if alive == 0 {
		// Ни один индексатор не ответил — это поломка, а не пустая выдача, и
		// молчать о ней нельзя: человек решит, что ищет не там.
		msgs := make([]string, 0, len(res.Sources))
		for _, r := range res.Sources {
			msgs = append(msgs, r.Name+": "+r.Error)
		}
		return res, fmt.Errorf("ни один индексатор не ответил — %s", strings.Join(msgs, "; "))
	}
	sort.SliceStable(res.Items, func(i, j int) bool { return res.Items[i].Seed > res.Items[j].Seed })
	if page == 0 {
		torznabSearch.put(cacheKey, res.Items)
	}
	return res, nil
}

// ---------- ручки ----------

// apiTorznabSearch — поиск по индексаторам. Ответ отдаёт и раздачи, и разбор
// по источникам: пустая выдача с объяснением «у Prowlarr 401» и пустая выдача
// с объяснением «всех отвечает, ничего не нашлось» — разные вещи.
func (c *Comp) apiTorznabSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page := atoiSafe(q.Get("page"))
	res, err := c.torznabSearchAll(strings.TrimSpace(q.Get("query")), strings.TrimSpace(q.Get("cat")), page)
	if err != nil {
		if len(res.Sources) == 0 {
			writeJSONError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		// Источники есть, но все с ошибкой: отдаём разбор с кодом 502, чтобы
		// интерфейс показал причины, а не «пусто».
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		jj(w, res)
		return
	}
	jj(w, res)
}

// torznabCaps — что индексатор умеет. Нужно для проверки: «отдаёт поиск» и
// «отдаёт поиск по сериалам» — разные вещи, и молчаливое отсутствие второго
// выглядит как поломка настроек.
type torznabCaps struct {
	Title       string   `json:"title"`
	Search      bool     `json:"search"`
	TVSearch    bool     `json:"tv_search"`
	MovieSearch bool     `json:"movie_search"`
	MusicSearch bool     `json:"music_search"`
	BookSearch  bool     `json:"book_search"`
	Categories  []string `json:"categories,omitempty"`
}

// torznabCapFlag — один флаг capabilities. В Torznab возможности приходят
// атрибутом available у пустого элемента («<search available="yes"/>»), а не
// текстом, поэтому это отдельный тип, а не строка.
type torznabCapFlag struct {
	Available string `xml:"available,attr"`
}

type torznabCapsDoc struct {
	XMLName   xml.Name `xml:"caps"`
	Searching struct {
		Search      torznabCapFlag `xml:"search"`
		TVSearch    torznabCapFlag `xml:"tv-search"`
		MovieSearch torznabCapFlag `xml:"movie-search"`
		MusicSearch torznabCapFlag `xml:"music-search"`
		BookSearch  torznabCapFlag `xml:"book-search"`
	} `xml:"searching"`
	// Название индексатора приходит атрибутом у <server>, а не отдельным тегом.
	Server struct {
		Title string `xml:"title,attr"`
	} `xml:"server"`
}

// fetchTorznabCaps читает capabilities индексатора. Адрес тот же, что и для
// поиска: у Jackett это один и тот же URL, различается только t=caps.
func fetchTorznabCaps(addr, key string) (torznabCaps, error) {
	v := url.Values{}
	v.Set("t", "caps")
	if key != "" {
		v.Set("apikey", key)
	}
	req, err := http.NewRequest("GET", addr+"?"+v.Encode(), nil)
	if err != nil {
		return torznabCaps{}, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	req.Header.Set("User-Agent", browserUserAgent)
	resp, err := httpClient.Do(req)
	if err != nil {
		return torznabCaps{}, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return torznabCaps{}, fmt.Errorf("%w: код %d", errTorznabAuth, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return torznabCaps{}, fmt.Errorf("код ответа %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, torznabBodyLimit))
	if err != nil {
		return torznabCaps{}, fmt.Errorf("%w: %v", errTorznabNetwork, err)
	}
	var doc torznabCapsDoc
	if err := xml.Unmarshal(body, &doc); err != nil {
		return torznabCaps{}, fmt.Errorf("%w: ответ не capabilities: %v", errTorznabMarkup, err)
	}
	yes := func(f torznabCapFlag) bool { return strings.EqualFold(strings.TrimSpace(f.Available), "yes") }
	return torznabCaps{
		Title:       collapseSpace(doc.Server.Title),
		Search:      yes(doc.Searching.Search),
		TVSearch:    yes(doc.Searching.TVSearch),
		MovieSearch: yes(doc.Searching.MovieSearch),
		MusicSearch: yes(doc.Searching.MusicSearch),
		BookSearch:  yes(doc.Searching.BookSearch),
	}, nil
}

// torznabTestResult — ответ на «проверить индексатор».
type torznabTestResult struct {
	OK    bool        `json:"ok"`
	Name  string      `json:"name"`
	URL   string      `json:"url"`
	Caps  torznabCaps `json:"caps"`
	Items int         `json:"items"`
	MS    int64       `json:"ms"`
	Error string      `json:"error,omitempty"`
	Notes []string    `json:"notes,omitempty"`
}

// apiTorznabTest проверяет индексатор, ничего не сохраняя. Проверка обязана
// быть безвредной: она спрашивает capabilities и одну раздачу, но не меняет
// настройки — иначе «проверить» было бы «применить».
//
// Принимает и сохранённый источник (по имени), и свободный адрес: проверить
// хочется до того, как настройка вписана в конфиг.
func (c *Comp) apiTorznabTest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name   string `json:"name"`
		URL    string `json:"url"`
		APIKey string `json:"api_key"`
	}
	if r.Method == http.MethodPost {
		if err := decodeTorznabBody(w, r, &in); err != nil && err != io.EOF {
			writeJSONError(w, http.StatusBadRequest, "тело запроса не разобрано")
			return
		}
	}
	q := r.URL.Query()
	if in.URL == "" {
		in.URL = q.Get("url")
	}
	if in.APIKey == "" {
		in.APIKey = q.Get("api_key")
	}
	if in.Name == "" {
		in.Name = q.Get("name")
	}
	// Пустой адрес с именем — это проверка уже сохранённого источника.
	if strings.TrimSpace(in.URL) == "" && strings.TrimSpace(in.Name) != "" {
		for _, s := range curCfg().TorznabSources {
			if strings.EqualFold(strings.TrimSpace(s.Name), strings.TrimSpace(in.Name)) {
				in.URL, in.APIKey = s.URL, s.APIKey
				break
			}
		}
	}
	if strings.TrimSpace(in.URL) == "" {
		writeJSONError(w, http.StatusBadRequest, "не указан адрес индексатора")
		return
	}
	src, err := normTorznabSource(TorznabSource{Name: in.Name, URL: in.URL, APIKey: in.APIKey})
	out := torznabTestResult{Name: src.Name, URL: src.URL}
	if err != nil {
		out.Error = err.Error()
		jj(w, out)
		return
	}
	start := time.Now()
	caps, err := fetchTorznabCaps(src.URL, src.APIKey)
	if err != nil {
		// Онлайн-JacRed без Torznab: capabilities нет, но JSON-поиск есть —
		// значит, источник рабочий, просто другой ручкой.
		if items, jerr := fetchJackettJSON(src.URL, src.APIKey, torznabProbeQuery, "", 0); jerr == nil {
			out.OK, out.Items, out.MS = true, len(items), time.Since(start).Milliseconds()
			out.Caps = torznabCaps{Search: true}
			out.Notes = append(out.Notes, fmt.Sprintf("Torznab не отвечает, поиск идёт через JSON-ручку Jackett: «%s» — %d раздач", torznabProbeQuery, len(items)))
			jj(w, out)
			return
		}
		out.MS = time.Since(start).Milliseconds()
		out.Error = err.Error()
		jj(w, out)
		return
	}
	out.Caps = caps
	// Поиск — вторая половина проверки: capabilities отдаются и при неверном
	// ключе, а настоящая работоспособность видна только по раздаче.
	items, serr := fetchTorznab(src.URL, src.APIKey, torznabProbeQuery, "", 0)
	if serr != nil {
		// Причина идёт именно в error, а не только в примечания: «не
		// отвечает» с пустым error для интерфейса — это «не работает,
		// непонятно почему», и человек пойдёт проверять не то. Capabilities при
		// этом часто отдаются даже при неверном ключе, поэтому «отвечает, но
		// поиск не работает» — самая частая форма отказа здесь.
		out.Error = serr.Error()
		out.Notes = append(out.Notes, "поиск не ответил: "+serr.Error())
	} else {
		out.Items = len(items)
	}
	out.MS = time.Since(start).Milliseconds()
	out.OK = serr == nil
	if out.OK && len(items) > 0 {
		out.Notes = append(out.Notes, fmt.Sprintf("пробный запрос «%s» вернул %d раздач", torznabProbeQuery, len(items)))
	}
	if out.OK && len(items) == 0 {
		// Пустой ответ — не поломка, но сообщить надо: иначе человек решит, что
		// ключ неверный.
		out.Notes = append(out.Notes, "индексатор ответил, но на пробный запрос не нашлось раздач — это бывает у пустых и новых трекеров")
	}
	if out.OK && !caps.Search {
		out.Notes = append(out.Notes, "в capabilities нет поиска (search) — проверьте, что адрес ведёт на Torznab, а не на другую ручку")
	}
	jj(w, out)
}

// ---------- список источников: чтение и запись ----------

// apiTorznabSources отдаёт и принимает список индексаторов.
//
// Ключи в ответе замаскированы: список показывается в интерфейсе и попадает в
// отчёт о состоянии, а полноценный ключ в таком месте — лишняя копия секрета
// на диске и в буфере обмена. Для правки ключ передаётся обратно, а если он не
// передан — остаётся прежний.
func (c *Comp) apiTorznabSources(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jj(w, map[string]any{"sources": maskTorznabSources(curCfg().TorznabSources)})
	case http.MethodPost:
		var in struct {
			Sources []TorznabSource `json:"sources"`
			Remove  string          `json:"remove"`
		}
		if err := decodeTorznabBody(w, r, &in); err != nil {
			writeJSONError(w, http.StatusBadRequest, "тело запроса не разобрано")
			return
		}
		if in.Remove != "" {
			name := strings.TrimSpace(in.Remove)
			err := updateCfg(func(nc *Config) {
				kept := make([]TorznabSource, 0, len(nc.TorznabSources))
				for _, s := range nc.TorznabSources {
					if !strings.EqualFold(strings.TrimSpace(s.Name), name) {
						kept = append(kept, s)
					}
				}
				nc.TorznabSources = kept
			})
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, err.Error())
				return
			}
			torznabSearch.reset()
			jj(w, map[string]any{"sources": maskTorznabSources(curCfg().TorznabSources)})
			return
		}
		clean, err := cleanTorznabSources(in.Sources, curCfg().TorznabSources)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		if uerr := updateCfg(func(nc *Config) { nc.TorznabSources = clean }); uerr != nil {
			writeJSONError(w, http.StatusInternalServerError, uerr.Error())
			return
		}
		torznabSearch.reset()
		jj(w, map[string]any{"sources": maskTorznabSources(curCfg().TorznabSources)})
	default:
		writeJSONError(w, http.StatusMethodNotAllowed, "метод не поддерживается")
	}
}

// cleanTorznabSources проверяет список перед записью.
//
// Ключ берётся из старого списка, если новый пришёл пустым: маскированный ключ
// из ответа нельзя записать обратно, иначе правка любого поля обнулила бы
// ключ. Второй источник с тем же именем — ошибка, а не молчаливая замена:
// непонятно, кого из них человек собирался оставить.
func cleanTorznabSources(in, old []TorznabSource) ([]TorznabSource, error) {
	out := make([]TorznabSource, 0, len(in))
	seenName := map[string]bool{}
	for _, s := range in {
		if strings.TrimSpace(s.Name) == "" && strings.TrimSpace(s.URL) == "" {
			continue // пустая строка — не источник, а незаполненное поле
		}
		if s.APIKey == "" {
			for _, o := range old {
				if strings.EqualFold(strings.TrimSpace(o.Name), strings.TrimSpace(s.Name)) {
					s.APIKey = o.APIKey
					break
				}
			}
		}
		norm, err := normTorznabSource(s)
		if err != nil {
			return nil, fmt.Errorf("«%s»: %v", strings.TrimSpace(s.Name), err)
		}
		key := strings.ToLower(norm.Name)
		if seenName[key] {
			return nil, fmt.Errorf("два индексатора с именем «%s» — переименуйте один", norm.Name)
		}
		seenName[key] = true
		out = append(out, norm)
	}
	return out, nil
}

// maskTorznabSources прячет ключи, оставляя признак «ключ задан».
func maskTorznabSources(in []TorznabSource) []map[string]any {
	out := make([]map[string]any, 0, len(in))
	for _, s := range in {
		masked := ""
		if s.APIKey != "" {
			masked = torznabMaskKey(s.APIKey)
		}
		out = append(out, map[string]any{
			"name": s.Name, "url": s.URL, "has_key": s.APIKey != "", "key_hint": masked,
		})
	}
	return out
}
