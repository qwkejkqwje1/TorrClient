package main

// Постеры через демон.
//
// Картинки TMDB лежат на image.tmdb.org, и у части провайдеров (в России —
// часто) этот адрес не открывается: оценки и названия приходят, а обложек в
// библиотеке нет. Интерфейс берёт картинку у демона (/api/img), а тот —
// с image.tmdb.org или, если он недоступен, с зеркала. Заодно картинка
// ложится в кэш на диске: библиотека в сотню плиток открывается сразу, без
// сотни запросов наружу.

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// imgHosts — откуда брать картинки: сам TMDB и его общедоступное зеркало.
var imgHosts = []string{"https://image.tmdb.org", "https://imagetmdb.com"}

// imgPath — только картинки TMDB: /t/p/<размер>/<имя>.<jpg|png|webp>.
// Проверка строгая: ручка не должна превращаться в прокси «куда угодно».
var imgPath = regexp.MustCompile(`^/t/p/(w[0-9]{2,4}|h[0-9]{2,4}|original)/[A-Za-z0-9_-]{4,64}\.(jpg|jpeg|png|webp|svg)$`)

// imgGood — номер хоста, ответившего последним: с него и начинаем.
var imgGood atomic.Int32

var imgClient = &http.Client{Timeout: 12 * time.Second}

const (
	imgMaxBytes   = 4 << 20
	imgCacheFiles = 4000
)

var imgPrune sync.Mutex

func imgCacheDir() string { return filepath.Join(dataDir(), "cache", "img") }

func imgCacheFile(p string) string {
	h := sha1.Sum([]byte(p))
	return filepath.Join(imgCacheDir(), hex.EncodeToString(h[:])+filepath.Ext(p))
}

func imgType(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	}
	return "image/jpeg"
}

// fetchImg забирает картинку: сначала с хоста, ответившего последним, потом с
// остальных.
func fetchImg(p string) ([]byte, error) {
	start := int(imgGood.Load())
	var lastErr error
	for i := range imgHosts {
		n := (start + i) % len(imgHosts)
		req, err := http.NewRequest("GET", imgHosts[n]+p, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", browserUserAgent)
		resp, err := imgClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, imgMaxBytes+1))
		resp.Body.Close()
		ct := resp.Header.Get("Content-Type")
		if err != nil || resp.StatusCode != http.StatusOK || len(body) == 0 || len(body) > imgMaxBytes || !strings.HasPrefix(ct, "image/") {
			if err == nil {
				err = errors.New(resp.Status)
			}
			lastErr = err
			continue
		}
		imgGood.Store(int32(n))
		return body, nil
	}
	if lastErr == nil {
		lastErr = errors.New("картинка не найдена")
	}
	return nil, lastErr
}

// apiImg — GET /api/img?p=/t/p/w342/abc.jpg
func (c *Comp) apiImg(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("p")
	if !imgPath.MatchString(p) {
		http.Error(w, "bad image path", http.StatusBadRequest)
		return
	}
	file := imgCacheFile(p)
	body, err := os.ReadFile(file)
	if err != nil || len(body) == 0 {
		body, err = fetchImg(p)
		if err != nil {
			http.Error(w, "image unavailable", http.StatusBadGateway)
			return
		}
		if os.MkdirAll(imgCacheDir(), 0o755) == nil {
			tmp := file + ".tmp"
			if os.WriteFile(tmp, body, 0o644) == nil {
				_ = os.Rename(tmp, file)
			}
			go pruneImgCache()
		}
	}
	w.Header().Set("Content-Type", imgType(p))
	// Картинка по этому адресу не меняется никогда — пусть окно держит её у себя.
	w.Header().Set("Cache-Control", "public, max-age=2592000, immutable")
	w.Write(body)
}

// pruneImgCache держит кэш в разумных пределах: при переполнении удаляет
// самые старые картинки. Запускается после записи, не чаще одного раза сразу.
func pruneImgCache() {
	if !imgPrune.TryLock() {
		return
	}
	defer imgPrune.Unlock()
	entries, err := os.ReadDir(imgCacheDir())
	if err != nil || len(entries) <= imgCacheFiles {
		return
	}
	type fi struct {
		name string
		at   time.Time
	}
	list := make([]fi, 0, len(entries))
	for _, e := range entries {
		if info, err := e.Info(); err == nil && !e.IsDir() {
			list = append(list, fi{e.Name(), info.ModTime()})
		}
	}
	// Удаляем четверть самых старых — чтобы не чистить после каждой картинки.
	sortByTime := func(a, b int) bool { return list[a].at.Before(list[b].at) }
	sort.Slice(list, sortByTime)
	for _, f := range list[:len(list)/4] {
		_ = os.Remove(filepath.Join(imgCacheDir(), f.name))
	}
}
