package main

// Источник Кинозал: поиск по зеркалам и разбор выдачи.

import (
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---------- Kinozal search (kinozaltv.life + зеркала) ----------

// Зеркала Кинозала.
//
// Официальные — по сообщениям канала Кинозала и теме на его форуме
// (forum.kinozal.tv, t=360702): kinozal.tv, kinozal.me, kinozal.guru. Они идут
// первыми. Там же прямо названы неофициальными kinozal.jumpingcrab.com и
// kinozaltv.appspot.com — их в списке нет вовсе.
//
// Неофициальные ниже — запасной путь: при проверке 27.09.2026 выдачу отдавали
// только kinozaltv.life и kinozal.cloudns.nz, официальные отвечали 403 (защита
// от ботов). Программа на Кинозал не входит и пароль туда не передаёт, только
// читает выдачу, поэтому запасной путь включён по умолчанию; выключается
// галочкой «Только официальные зеркала» (kinozal_official_only).
var kinozalOfficialHosts = [...]string{
	"kinozal.tv",
	"kinozal.me",
	"kinozal.guru",
}

var kinozalUnofficialHosts = [...]string{
	"kinozaltv.life",
	"kinozal.cloudns.nz",
	"tv.kinozal.app",
	"kinozal.club",
	"kinozal.bz",
	"kinozal.ist",
	"kinozal.shop",
	"kinozal.today",
}

// kinozalHosts — встроенный список целиком (официальные, затем запасные).
var kinozalHosts = func() []string {
	out := append([]string{}, kinozalOfficialHosts[:]...)
	return append(out, kinozalUnofficialHosts[:]...)
}()

func kinozalIsOfficial(host string) bool {
	host = strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://")
	for _, h := range kinozalOfficialHosts {
		if h == host {
			return true
		}
	}
	return false
}

// kinozalLastGood — зеркало, которое ответило последним. Следующий поиск
// начинается с него: иначе каждый запрос заново ждал бы отказов мёртвых.
var kinozalLastGood atomic.Value // string: "https://host"

// kinozalOrder — порядок перебора: последнее рабочее, свои зеркала из
// настроек, официальные, затем запасные (если не запрещены).
func kinozalOrder(extra []string, lastGood string, officialOnly bool) []string {
	hosts := make([]string, 0, len(extra)+len(kinozalHosts)+1)
	if lastGood != "" && (!officialOnly || kinozalIsOfficial(lastGood)) {
		hosts = append(hosts, lastGood)
	}
	hosts = append(hosts, extra...)
	hosts = append(hosts, kinozalOfficialHosts[:]...)
	if !officialOnly {
		hosts = append(hosts, kinozalUnofficialHosts[:]...)
	}
	return kinozalBases(hosts)
}

// Адрес выдачи Кинозала: g=0 — все разделы, страницы считаются с нуля
// (page=0 — первая). Запрос кодируется в UTF-8: сайт принимает и свою
// windows-1251, и UTF-8 — сверено обоими способами, выдача совпадает.
const kinozalSearchPath = "/browse.php?s=%s&g=0&page=%d"

// kinozalBases собирает адреса для перебора.
//
// Отдельная чистая функция, а не цикл в fetchKinozal: состав списка — это то,
// что стоит проверять, а сам перебор ходит в сеть. Здесь же отсеиваются мусор
// и дубли: пользовательский список не должен ни испортить перебор, ни съесть
// время на два одинаковых адреса подряд.
func kinozalBases(hosts []string) []string {
	seen := make(map[string]bool, len(hosts))
	out := make([]string, 0, len(hosts))
	for _, h := range hosts {
		h = strings.TrimSpace(strings.ToLower(h))
		// Хост без суффикса не примет соединение, а мусор в виде адреса целиком
		// («https://kinozal.tv/») даст путь вида https://https://... — такой
		// отказ внятнее убрать заранее, чем разбирать его по месту.
		if h == "" {
			continue
		}
		h = strings.TrimPrefix(h, "https://")
		h = strings.TrimPrefix(h, "http://")
		h = strings.TrimSuffix(h, "/")
		if i := strings.IndexByte(h, '/'); i >= 0 {
			h = h[:i]
		}
		if h == "" || seen[h] {
			continue
		}
		seen[h] = true
		out = append(out, "https://"+h)
	}
	return out
}

var (
	// Строка выдачи. Живой Кинозал размечает первую строку как
	// <tr class='first bg'>, остальные как <tr class=bg>: кавычки то одинарные,
	// то нет. Прежний разбор искал <tr id="torrent_N">, а такого атрибута в
	// разметке нет вовсе — поэтому ни одна строка не разбиралась.
	kzRowRe = regexp.MustCompile(`(?s)<tr[^>]*class=['"]?(?:first\s+)?bg['"]?[^>]*>(.*?)</tr>`)
	// Название и адрес страницы раздачи. Класс ссылки у разных строк разный —
	// r0, r1, r2 (в живой выдаче 35/12/3), это цветовая пометка трекера, и
	// опираться на неё нельзя.
	kzTitleRe = regexp.MustCompile(`(?s)<a href="(/details\.php\?id=\d+)"[^>]*>(.*?)</a>`)
	// Дата заливки: «05.08.2026 в 21:08».
	kzDateRe = regexp.MustCompile(`(\d{2}\.\d{2}\.\d{4}) в \d{2}:\d{2}`)
	// Размер опознаётся по единице измерения, а не по классу ячейки: рядом стоят
	// ячейки с тем же классом s — число комментариев и дата.
	kzSizeRe = regexp.MustCompile(`([\d.,]+)\s*(ТБ|ГБ|МБ|КБ|TB|GB|MB|KB)`)
	// Сиды и пиры. Прежний разбор ждал class="sl_sl" и class="sl_ll" в двойных
	// кавычках; на живой странице это class='sl_s' и class='sl_p'.
	kzSeedRe = regexp.MustCompile(`class=['"]sl_s['"][^>]*>\s*(\d+)`)
	kzPeerRe = regexp.MustCompile(`class=['"]sl_p['"][^>]*>\s*(\d+)`)
	kzIDRe   = regexp.MustCompile(`id=(\d+)`)
	// Признак «адрес страницы раздачи» — заменяется на get.php при скачивании.
	kzDetailsRe = regexp.MustCompile(`details\.php`)
	// Признак страницы выдачи — ссылки на раздачи. Нужен, чтобы страница
	// проверки бота не выглядела как «строки не разобраны».
	kzHostOKRe = regexp.MustCompile(`details\.php\?id=\d+`)
	kzTagsRe   = regexp.MustCompile(`<[^>]+>`)
)

// Кэш Кинозала — тот же механизм, что у rutor.
var kinozalSearch searchCacheStore

func (c *Comp) apiKinozalSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("query"))
	if q == "" {
		jj(w, []rutorItem{})
		return
	}
	page := atoiSafe(r.URL.Query().Get("page"))
	if page < 0 || page > 50 {
		page = 0
	}
	key := fmt.Sprintf("%d\x00%s", page, strings.ToLower(q))
	if items, ok := kinozalSearch.get(key); ok {
		jj(w, items)
		return
	}
	items, err := c.fetchKinozal(q, page)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	kinozalSearch.put(key, items)
	jj(w, items)
}

// fetchKinozal перебирает хосты, пока какой-нибудь не отдаст раздачи.
// Если не ответил ни один — возвращается ошибка с причиной последней попытки:
// мёртвый источник не должен выглядеть как пустая выдача.
func (c *Comp) fetchKinozal(q string, page int) ([]rutorItem, error) {
	// Свой список из настроек идёт первым: человек, который знает рабочее
	// зеркало, не должен ждать, пока перебор дойдёт до него через мёртвые.
	last, _ := kinozalLastGood.Load().(string)
	officialOnly := false
	if cur := curCfg(); cur != nil {
		officialOnly = cur.KinozalOfficialOnly
	}
	return c.fetchKinozalFrom(q, page, kinozalOrder(kinozalExtraHosts(), last, officialOnly))
}

// kinozalExtraHosts — добавленные пользователем зеркала. Домены Кинозала
// меняются быстрее, чем выходят обновления программы, поэтому список должен
// правиться без пересборки: запись в torrclient.json переживает всё остальное.
func kinozalExtraHosts() []string {
	cur := curCfg()
	if cur == nil {
		return nil
	}
	return cur.KinozalHosts
}

// fetchKinozalFrom — перебор адресов зеркал. Вынесено отдельно, чтобы путь
// отказа был проверяем тестом без обращения к сети.
func (c *Comp) fetchKinozalFrom(q string, page int, bases []string) ([]rutorItem, error) {
	suffix := fmt.Sprintf(kinozalSearchPath, url.QueryEscape(q), page)
	var lastErr error
	tried := 0
	for _, base := range bases {
		tried++
		doc, err := c.fetchHTML(base + suffix)
		if err != nil {
			lastErr = fmt.Errorf("%s: %v", base, err)
			continue
		}
		if !kzHostOKRe.MatchString(doc) {
			lastErr = fmt.Errorf("%s: отдана не страница выдачи (защита от ботов?)", base)
			continue
		}
		out := parseKinozalRows(doc, base)
		if len(out) == 0 {
			lastErr = fmt.Errorf("%s: строки выдачи не разобраны", base)
			continue
		}
		if len(out) > rutorPageSize {
			out = out[:rutorPageSize]
		}
		kinozalLastGood.Store(base)
		return out, nil
	}
	if lastErr == nil {
		lastErr = errors.New("список хостов пуст")
	}
	return nil, fmt.Errorf("кинозал: ни одно зеркало не отдало выдачу (проверено адресов: %d; последняя причина: %v)", tried, lastErr)
}

// parseKinozalRows разбирает строки выдачи Кинозала.
func parseKinozalRows(doc, base string) []rutorItem {
	var out []rutorItem
	for _, m := range kzRowRe.FindAllStringSubmatch(doc, -1) {
		it := parseKinozalRow(m[1], base)
		if it.Title == "" || it.Link == "" {
			continue
		}
		out = append(out, it)
	}
	return dedupeItems(out)
}

func parseKinozalRow(row, base string) rutorItem {
	var it rutorItem
	if m := kzTitleRe.FindStringSubmatch(row); len(m) >= 3 {
		it.Link = base + m[1]
		it.Title = strings.TrimSpace(html.UnescapeString(kzTagsRe.ReplaceAllString(m[2], "")))
	}
	if m := kzDateRe.FindStringSubmatch(row); len(m) == 2 {
		it.Date = m[1]
	}
	if m := kzSizeRe.FindStringSubmatch(row); len(m) == 3 {
		it.Size = m[1] + " " + m[2]
	}
	if m := kzSeedRe.FindStringSubmatch(row); len(m) == 2 {
		it.Seed = atoiSafe(m[1])
	}
	if m := kzPeerRe.FindStringSubmatch(row); len(m) == 2 {
		it.Peer = atoiSafe(m[1])
	}
	// Магнита в выдаче Кинозала нет: трекер отдаёт раздачу только файлом
	// .torrent, и ссылки magnet: в разметке не встречается вовсе (проверено на
	// живой странице). Поэтому Hash остаётся пустым, а раздача забирается через
	// get.php по номеру из адреса страницы.
	if m := kzIDRe.FindStringSubmatch(it.Link); len(m) == 2 {
		it.Get = base + "/get.php?id=" + m[1]
	}
	return it
}

// apiKinozalAdd — скачивает .torrent (get.php) и добавляет на сервер.
// Ответ — хеш раздачи, чтобы интерфейс сразу запустил показ. Если .torrent не
// получить, ищет ту же раздачу в других источниках и отдаёт магнит.
func (c *Comp) apiKinozalAdd(w http.ResponseWriter, r *http.Request) {
	// Добавление раздачи меняет состояние сервера и принимается только POST'ом.
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "добавление принимается только POST'ом")
		return
	}
	u := strings.TrimSpace(r.URL.Query().Get("url"))
	title := strings.TrimSpace(r.URL.Query().Get("title"))
	size := strings.TrimSpace(r.URL.Query().Get("size"))
	if u == "" {
		writeJSONError(w, http.StatusBadRequest, "url empty")
		return
	}
	if kzDetailsRe.MatchString(u) {
		u = strings.Replace(u, "details.php", "get.php", 1)
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		writeJSONError(w, http.StatusBadRequest, "bad url")
		return
	}
	data, hash, err := kinozalTorrent(u)
	if err == nil {
		if uerr := uploadTorrentData("kz-"+hash+".torrent", data); uerr != nil {
			writeJSONError(w, http.StatusBadGateway, uerr.Error())
			return
		}
		jj(w, map[string]any{"ok": true, "hash": hash})
		return
	}
	if title != "" {
		if it, ok := c.sameReleaseElsewhere(title, size); ok {
			magnet := it.Magnet
			if magnet == "" {
				magnet = "magnet:?xt=urn:btih:" + it.Hash
			}
			jj(w, map[string]any{"ok": true, "magnet": magnet, "hash": strings.ToLower(it.Hash), "via": it.Title,
				"note": err.Error()})
			return
		}
	}
	writeJSONError(w, http.StatusBadGateway, err.Error()+". Укажите логин Кинозала в Настройках или подключите индексатор (JacRed) — тогда раздача найдётся по магниту")
}

// downloadClient — клиент для скачивания .torrent: таймаут больше, чем у
// поискового, потому что файл может отдаваться медленно. Проверка сертификата
// включена.
var downloadClient = &http.Client{Timeout: 40 * time.Second}

func (c *Comp) downloadTorrent(u string) ([]byte, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", browserUserAgent)
	req.Header.Set("Accept", "*/*")
	resp, err := downloadClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}

// apiKinozalMirrors — GET: настройки зеркал; POST {"hosts":[...],"official_only":bool}
// сохраняет их; POST с {"probe":true} проверяет все зеркала параллельно и
// возвращает, какое отдаёт выдачу. Проверка — только POST: страница в чужой
// вкладке не должна гонять программу по сети.
func (c *Comp) apiKinozalMirrors(w http.ResponseWriter, r *http.Request) {
	state := func() map[string]any {
		cur := curCfg()
		last, _ := kinozalLastGood.Load().(string)
		return map[string]any{"hosts": cur.KinozalHosts, "official_only": cur.KinozalOfficialOnly,
			"official": kinozalOfficialHosts, "unofficial": kinozalUnofficialHosts, "last_good": last,
			// Пароль наружу не отдаётся: только признак, что он задан.
			"user": cur.KinozalUser, "pass_set": cur.KinozalPass != ""}
	}
	switch r.Method {
	case http.MethodGet:
		jj(w, state())
	case http.MethodPost:
		var in struct {
			Probe        bool     `json:"probe"`
			Hosts        []string `json:"hosts"`
			OfficialOnly *bool    `json:"official_only"`
			User         *string  `json:"user"`
			Pass         *string  `json:"pass"`
		}
		if err := decodeTorznabBody(w, r, &in); err != nil {
			writeJSONError(w, http.StatusBadRequest, "тело запроса не разобрано")
			return
		}
		if in.Probe {
			jj(w, map[string]any{"results": c.probeKinozal(kinozalOrder(kinozalExtraHosts(), "", false))})
			return
		}
		hosts := make([]string, 0, len(in.Hosts))
		for _, b := range kinozalBases(in.Hosts) {
			hosts = append(hosts, strings.TrimPrefix(b, "https://"))
		}
		if err := updateCfg(func(nc *Config) {
			nc.KinozalHosts = hosts
			if in.OfficialOnly != nil {
				nc.KinozalOfficialOnly = *in.OfficialOnly
			}
			if in.User != nil {
				nc.KinozalUser = strings.TrimSpace(*in.User)
			}
			// Пустой пароль в форме — «не менять»: поле пароля не заполняется
			// сохранённым, и сохранение зеркал не должно его стирать.
			if in.Pass != nil && *in.Pass != "" {
				nc.KinozalPass = *in.Pass
			}
			if in.User != nil && strings.TrimSpace(*in.User) == "" {
				nc.KinozalPass = ""
			}
		}); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		kinozalLastGood.Store("")
		kinozalSearch.clear()
		jj(w, state())
	default:
		writeJSONError(w, http.StatusMethodNotAllowed, "метод не поддерживается")
	}
}

type kinozalProbe struct {
	Host     string `json:"host"`
	Official bool   `json:"official"`
	OK       bool   `json:"ok"`
	Reason   string `json:"reason,omitempty"`
	Ms       int64  `json:"ms"`
}

// probeKinozal проверяет зеркала параллельно одним и тем же запросом.
func (c *Comp) probeKinozal(bases []string) []kinozalProbe {
	out := make([]kinozalProbe, len(bases))
	var wg sync.WaitGroup
	for i, b := range bases {
		wg.Add(1)
		go func(i int, b string) {
			defer wg.Done()
			t := time.Now()
			_, err := c.fetchKinozalFrom("2024", 0, []string{b})
			p := kinozalProbe{Host: strings.TrimPrefix(b, "https://"), OK: err == nil, Ms: time.Since(t).Milliseconds()}
			p.Official = kinozalIsOfficial(p.Host)
			if err != nil {
				p.Reason = err.Error()
				p.Reason = kinozalReason(p.Reason)
			}
			out[i] = p
		}(i, b)
	}
	wg.Wait()
	return out
}

// kinozalReason переводит сетевую ошибку в короткую причину для человека.
func kinozalReason(e string) string {
	switch {
	case strings.Contains(e, "no such host"):
		return "домен не найден"
	case strings.Contains(e, "connection refused"):
		return "соединение отклонено (домен заблокирован провайдером?)"
	case strings.Contains(e, "код ответа 403"):
		return "403: защита от ботов"
	case strings.Contains(e, "код ответа 404"):
		return "404: страницы поиска нет"
	case strings.Contains(e, "Timeout") || strings.Contains(e, "deadline exceeded"):
		return "нет ответа (тайм-аут)"
	case strings.Contains(e, "certificate"):
		return "ошибка сертификата HTTPS"
	}
	if i := strings.Index(e, "последняя причина: "); i >= 0 {
		e = strings.TrimSuffix(e[i+len("последняя причина: "):], ")")
	}
	if i := strings.Index(e, ": "); i >= 0 && strings.HasPrefix(e, "https://") {
		e = e[i+2:]
	}
	return e
}
