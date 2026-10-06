package main

// Добавление раздачи с Кинозала.
//
// Кинозал отдаёт .torrent (get.php) только вошедшим пользователям, а
// гостю — страницу входа с кодом 200. Прежде эта страница сохранялась как
// .torrent, сервер её отвергал, а интерфейс получал «ok» без хеша — и запуск
// молча не начинался («ошибка запуска по Кинозалу»). Теперь:
//   - ответ проверяется: это должен быть bencode с разделом info;
//   - если в настройках есть логин Кинозала — программа входит и повторяет;
//   - если .torrent не получить — та же раздача ищется в других источниках
//     (индексаторы Torznab/JacRed, rutor), и запуск идёт по магниту;
//   - хеш считается из самого .torrent, и интерфейс сразу запускает показ.

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	kinozalJar, _ = cookiejar.New(nil)
	kinozalDL     = &http.Client{Timeout: 40 * time.Second, Jar: kinozalJar}
	kinozalLogMu  sync.Mutex
)

// benEnd возвращает конец bencode-значения, начинающегося с i, или -1.
func benEnd(b []byte, i int) int {
	if i >= len(b) {
		return -1
	}
	switch c := b[i]; {
	case c == 'i':
		j := bytes.IndexByte(b[i:], 'e')
		if j < 0 {
			return -1
		}
		return i + j + 1
	case c == 'l' || c == 'd':
		i++
		for i < len(b) && b[i] != 'e' {
			if i = benEnd(b, i); i < 0 {
				return -1
			}
		}
		if i >= len(b) {
			return -1
		}
		return i + 1
	case c >= '0' && c <= '9':
		j := bytes.IndexByte(b[i:], ':')
		if j < 0 {
			return -1
		}
		n, err := strconv.Atoi(string(b[i : i+j]))
		if err != nil || n < 0 || i+j+1+n > len(b) {
			return -1
		}
		return i + j + 1 + n
	}
	return -1
}

// torrentInfoHash — хеш раздачи из .torrent: SHA-1 раздела info. Ошибка —
// если это не .torrent (например, страница входа).
func torrentInfoHash(b []byte) (string, error) {
	if len(b) < 10 || b[0] != 'd' {
		return "", errors.New("это не .torrent")
	}
	i := 1
	for i < len(b) && b[i] != 'e' {
		kEnd := benEnd(b, i)
		if kEnd < 0 {
			return "", errors.New("испорченный .torrent")
		}
		colon := bytes.IndexByte(b[i:kEnd], ':')
		key := ""
		if colon >= 0 {
			key = string(b[i+colon+1 : kEnd])
		}
		vEnd := benEnd(b, kEnd)
		if vEnd < 0 {
			return "", errors.New("испорченный .torrent")
		}
		if key == "info" {
			sum := sha1.Sum(b[kEnd:vEnd])
			return hex.EncodeToString(sum[:]), nil
		}
		i = vEnd
	}
	return "", errors.New("в .torrent нет раздела info")
}

// kinozalLogin входит на Кинозал логином из настроек.
func kinozalLogin(base string) error {
	cur := curCfg()
	if cur == nil || strings.TrimSpace(cur.KinozalUser) == "" || cur.KinozalPass == "" {
		return errors.New("логин Кинозала не задан")
	}
	kinozalLogMu.Lock()
	defer kinozalLogMu.Unlock()
	form := url.Values{"username": {cur.KinozalUser}, "password": {cur.KinozalPass}, "returnto": {""}}
	req, err := http.NewRequest("POST", base+"/takelogin.php", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", browserUserAgent)
	resp, err := kinozalDL.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	u, _ := url.Parse(base)
	for _, ck := range kinozalJar.Cookies(u) {
		if ck.Name == "uid" || ck.Name == "pass" {
			return nil
		}
	}
	return errors.New("Кинозал не принял логин или пароль")
}

// kinozalTorrent скачивает .torrent; при необходимости входит и повторяет.
func kinozalTorrent(u string) ([]byte, string, error) {
	get := func() ([]byte, error) {
		req, err := http.NewRequest("GET", u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", browserUserAgent)
		resp, err := kinozalDL.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, errors.New("Кинозал ответил кодом " + strconv.Itoa(resp.StatusCode))
		}
		return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	}
	data, err := get()
	if err != nil {
		return nil, "", err
	}
	if h, herr := torrentInfoHash(data); herr == nil {
		return data, h, nil
	}
	pu, perr := url.Parse(u)
	if perr != nil {
		return nil, "", perr
	}
	if lerr := kinozalLogin(pu.Scheme + "://" + pu.Host); lerr != nil {
		return nil, "", errors.New("Кинозал отдаёт .torrent только после входа (" + lerr.Error() + ")")
	}
	if data, err = get(); err != nil {
		return nil, "", err
	}
	h, herr := torrentInfoHash(data)
	if herr != nil {
		return nil, "", errors.New("Кинозал не отдал .torrent и после входа")
	}
	return data, h, nil
}

var kzYearRe = regexp.MustCompile(`\b(19|20)\d{2}\b`)

// kinozalTitleParts — название и год из строки Кинозала: «Дюна / Dune / 2021 / …».
func kinozalTitleParts(t string) (name, year string) {
	parts := strings.Split(t, "/")
	name = strings.TrimSpace(parts[0])
	if m := kzYearRe.FindString(t); m != "" {
		year = m
	}
	return name, year
}

// sizeBytes читает размер вида «14.3 ГБ», «1.2 GB», «700 MB».
func sizeBytes(s string) float64 {
	f := strings.Fields(strings.ReplaceAll(strings.ReplaceAll(s, ",", "."), "\u00a0", " "))
	if len(f) < 2 {
		return 0
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0
	}
	switch strings.ToUpper(f[1]) {
	case "TB", "ТБ":
		return v * (1 << 40)
	case "GB", "ГБ":
		return v * (1 << 30)
	case "MB", "МБ":
		return v * (1 << 20)
	case "KB", "КБ":
		return v * (1 << 10)
	}
	return 0
}

// pickSameRelease выбирает из чужой выдачи ту же раздачу: то же название и
// год, ближайший размер (в пределах 3 %), а без размера — больше сидов.
func pickSameRelease(items []rutorItem, title, size string) (rutorItem, bool) {
	name, year := kinozalTitleParts(title)
	want := sizeBytes(size)
	best, bestScore := -1, 0.0
	for i, it := range items {
		if it.Magnet == "" && it.Hash == "" {
			continue
		}
		if !matchSub(it.Title, name) || (year != "" && !strings.Contains(it.Title, year)) {
			continue
		}
		score := float64(it.Seed)
		if want > 0 {
			got := sizeBytes(it.Size)
			if got <= 0 {
				continue
			}
			diff := (got - want) / want
			if diff < 0 {
				diff = -diff
			}
			if diff > 0.03 {
				continue
			}
			score = 1e9 - diff*1e9 + float64(it.Seed)
		}
		if best < 0 || score > bestScore {
			best, bestScore = i, score
		}
	}
	if best < 0 {
		return rutorItem{}, false
	}
	return items[best], true
}

// sameReleaseElsewhere ищет раздачу Кинозала в других источниках.
func (c *Comp) sameReleaseElsewhere(title, size string) (rutorItem, bool) {
	name, year := kinozalTitleParts(title)
	q := strings.TrimSpace(name + " " + year)
	if q == "" {
		return rutorItem{}, false
	}
	var pool []rutorItem
	if len(curCfg().TorznabSources) > 0 {
		if res, err := c.torznabSearchAll(q, "", 0); err == nil {
			pool = append(pool, res.Items...)
		}
	}
	if it, ok := pickSameRelease(pool, title, size); ok {
		return it, true
	}
	if items, err := c.rutorSearch(q, 0, 0); err == nil {
		pool = append(pool, items...)
	}
	if it, ok := pickSameRelease(pool, title, size); ok {
		return it, true
	}
	// Той же раздачи нет — годится та же картина в другой раздаче: смотреть
	// лучше её, чем ничего.
	return pickSameRelease(pool, title, "")
}
