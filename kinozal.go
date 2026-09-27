package main

// Источник Кинозал: поиск по зеркалам и разбор выдачи.

import (
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ---------- Kinozal search (kinozaltv.life + зеркала) ----------

// Список хостов в порядке приоритета. Домены Кинозала живут недолго и
// меняются; при недоступности одного перебираем следующий.
//
// Проверено 20.09.2026: kinozaltv.life отвечает 200 и отдаёт 50 строк выдачи;
// kinozal.me и kinozal.guru отвечают 403 (защита от ботов), kinozal.life не
// отвечает вовсе. Прежний список начинался с 403-хостов и рабочего адреса не
// содержал, поэтому источник был мёртв целиком.
var kinozalHosts = [...]string{
	"kinozaltv.life",
	"kinozal.me",
	"kinozal.guru",
	"tv.kinozal.app",
	"kinozal.jumpingcrab.com",
	"kinozal.cloudns.nz",
	"kinozal.tv",
	"kinozal.club",
	"kinozal.bz",
	"kinozal.ist",
	"kinozal.shop",
	"kinozal.today",
}

// Адрес выдачи Кинозала: g=0 — все разделы, страницы считаются с нуля
// (page=0 — первая). Запрос кодируется в UTF-8: сайт принимает и свою
// windows-1251, и UTF-8 — сверено обоими способами, выдача совпадает.
const kinozalSearchPath = "/browse.php?s=%s&g=0&page=%d"

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
	bases := make([]string, 0, len(kinozalHosts))
	for _, host := range kinozalHosts {
		bases = append(bases, "https://"+host)
	}
	return c.fetchKinozalFrom(q, page, bases)
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
func (c *Comp) apiKinozalAdd(w http.ResponseWriter, r *http.Request) {
	// Добавление раздачи меняет состояние сервера и принимается только POST'ом.
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "добавление принимается только POST'ом")
		return
	}
	u := strings.TrimSpace(r.URL.Query().Get("url"))
	if u == "" {
		http.Error(w, `{"error":"url empty"}`, http.StatusBadRequest)
		return
	}
	if kzDetailsRe.MatchString(u) {
		u = strings.Replace(u, "details.php", "get.php", 1)
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		http.Error(w, `{"error":"bad url"}`, http.StatusBadRequest)
		return
	}
	name := "kz-" + strconv.FormatInt(time.Now().UnixNano(), 10) + ".torrent"
	data, err := c.downloadTorrent(u)
	if err != nil {
		http.Error(w, `{"error":"download failed"}`, http.StatusBadGateway)
		return
	}
	path := filepath.Join(curCfg().WatchFolder, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		http.Error(w, `{"error":"write failed"}`, http.StatusInternalServerError)
		return
	}
	c.addTorrentFromFile(path, false)
	jj(w, map[string]any{"ok": true})
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
