package main

// Раздел «Аудио»: обложки, рекомендации и офлайн-прослушивание.
//
// Deezer и iTunes отдают обложки и «похожих исполнителей» без ключей, но окну
// напрямую их не спросить: у Deezer нет заголовков CORS. Демон ходит к ним
// сам, держит ответы в памяти и сохраняет картинки на диск — как постеры
// фильмов. Скачанные для офлайна аудиокниги он же отдаёт из папки загрузок.

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var audioClient = &http.Client{Timeout: 12 * time.Second}

// deezerPath — какие адреса Deezer можно спрашивать через демон.
var deezerPath = regexp.MustCompile(`^(search/(album|artist|track)\?q=[^&#]{1,200}(&limit=\d{1,3})?|artist/\d{1,12}(/related|/top|/albums)?(\?limit=\d{1,3})?|album/\d{1,12}|chart/\d{1,6}/(albums|artists|tracks)(\?limit=\d{1,3})?|genre(/\d{1,6}/artists)?)$`)

type audioCacheItem struct {
	body []byte
	at   time.Time
}

var (
	audioCacheMu sync.Mutex
	audioCache   = map[string]audioCacheItem{}
)

const audioCacheTTL = 6 * time.Hour

func audioCached(key string, fetch func() ([]byte, error)) ([]byte, error) {
	audioCacheMu.Lock()
	if it, ok := audioCache[key]; ok && time.Since(it.at) < audioCacheTTL {
		audioCacheMu.Unlock()
		return it.body, nil
	}
	audioCacheMu.Unlock()
	body, err := fetch()
	if err != nil {
		return nil, err
	}
	audioCacheMu.Lock()
	if len(audioCache) > 600 {
		for k, v := range audioCache {
			if time.Since(v.at) > audioCacheTTL/2 {
				delete(audioCache, k)
			}
		}
		if len(audioCache) > 600 {
			audioCache = map[string]audioCacheItem{}
		}
	}
	audioCache[key] = audioCacheItem{body, time.Now()}
	audioCacheMu.Unlock()
	return body, nil
}

func audioGet(u string, limit int64) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "TorrClient/"+appVersion()+" (+https://github.com/qwkejkqwje1/TorrClient)")
	resp, err := audioClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("сервис ответил " + resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("ответ слишком велик")
	}
	return b, nil
}

// audioImgHost — откуда можно брать обложки.
func audioImgHost(h string) bool {
	h = strings.ToLower(h)
	return h == "cdn-images.dzcdn.net" || h == "e-cdns-images.dzcdn.net" || h == "api.deezer.com" || strings.HasSuffix(h, ".mzstatic.com")
}

func (c *Comp) apiAudio(w http.ResponseWriter, r *http.Request) {
	what := strings.TrimPrefix(r.URL.Path, "/api/audio/")
	q := r.URL.Query()
	switch what {
	case "deezer":
		p := q.Get("p")
		if !deezerPath.MatchString(p) {
			writeJSONError(w, http.StatusBadRequest, "недопустимый запрос")
			return
		}
		body, err := audioCached("dz:"+p, func() ([]byte, error) { return audioGet("https://api.deezer.com/"+p, 2<<20) })
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "Deezer: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write(body)
	case "itunes":
		term := strings.TrimSpace(q.Get("term"))
		entity := q.Get("entity")
		if entity != "album" && entity != "musicArtist" && entity != "song" && entity != "audiobook" {
			entity = "album"
		}
		if term == "" || len(term) > 200 {
			writeJSONError(w, http.StatusBadRequest, "пустой запрос")
			return
		}
		u := "https://itunes.apple.com/search?media=all&limit=8&entity=" + entity + "&term=" + url.QueryEscape(term)
		body, err := audioCached("it:"+entity+":"+term, func() ([]byte, error) { return audioGet(u, 2<<20) })
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "iTunes: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write(body)
	case "img":
		u, err := url.Parse(q.Get("u"))
		if err != nil || u.Scheme != "https" || !audioImgHost(u.Hostname()) {
			http.Error(w, "bad image url", http.StatusBadRequest)
			return
		}
		sum := sha1.Sum([]byte(u.String()))
		dir := filepath.Join(imgCacheDir(), "audio")
		file := filepath.Join(dir, hex.EncodeToString(sum[:])+".img")
		body, err := os.ReadFile(file)
		if err != nil || len(body) == 0 {
			body, err = audioGet(u.String(), 4<<20)
			if err != nil {
				http.Error(w, "image unavailable", http.StatusBadGateway)
				return
			}
			if os.MkdirAll(dir, 0o755) == nil {
				tmp := file + ".tmp"
				if os.WriteFile(tmp, body, 0o644) == nil {
					_ = os.Rename(tmp, file)
				}
			}
		}
		w.Header().Set("Content-Type", http.DetectContentType(body))
		w.Header().Set("Cache-Control", "public, max-age=2592000, immutable")
		w.Write(body)
	case "local":
		// Офлайн: файл, скачанный в папку загрузок. Только оттуда и только аудио.
		p := q.Get("p")
		root := curCfg().DownloadFolder
		if p == "" || root == "" {
			http.NotFound(w, r)
			return
		}
		abs, err := filepath.Abs(p)
		rootAbs, err2 := filepath.Abs(root)
		if err != nil || err2 != nil || !audioInside(rootAbs, abs) || !isAudioExt(abs) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			if rr, err := filepath.EvalSymlinks(rootAbs); err == nil && !audioInside(rr, real) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		if _, err := os.Stat(abs); err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, abs)
	case "exists":
		// Какие из скачанных файлов книги ещё лежат на диске.
		var out []bool
		root, _ := filepath.Abs(curCfg().DownloadFolder)
		for _, p := range q["p"] {
			abs, err := filepath.Abs(p)
			ok := err == nil && root != "" && audioInside(root, abs)
			if ok {
				_, err = os.Stat(abs)
				ok = err == nil
			}
			out = append(out, ok)
		}
		jj(w, map[string]any{"exists": out})
	default:
		http.NotFound(w, r)
	}
}

func audioInside(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

func isAudioExt(p string) bool {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wav", ".wma", ".ape", ".mka", ".webm":
		return true
	}
	return false
}
