package main

// Плейлист раздачи для внешнего плеера.
//
// Свой плейлист, а не /playlist самого TorrServer: тот подставляет в ссылки
// собственный адрес и путь /stream, тогда как интерфейс и плеер ходят через
// демон по /ts/stream — и через него же проходит вход на сервер с паролем.
// Из-за этого VLC получал один файл: в плеер уходила ссылка на поток одной
// серии, и списка серий у него не было вовсе.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// maxStatusBody — предел ответа о состоянии раздачи. Список файлов большой
// раздачи занимает десятки килобайт, но не мегабайты.
const maxStatusBody = 4 << 20

// statusClient — запросы о состоянии раздачи. Срок обязателен: по свежей
// раздаче сервер ждёт сведения о ней, и без срока запрос повис бы на нём.
var statusClient = &http.Client{Timeout: 30 * time.Second}

// torrentFile — файл раздачи в том виде, в каком его отдаёт TorrServer.
type torrentFile struct {
	ID     int    `json:"id"`
	Path   string `json:"path"`
	Length int64  `json:"length"`
}

// torrentStatus — часть ответа /stream?link=HASH&stat, нужная интерфейсу:
// и ход подгрузки, и список файлов.
type torrentStatus struct {
	Hash        string         `json:"hash"`
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Stat        int            `json:"stat"`
	StatString  string         `json:"stat_string"`
	TorrentSize int64          `json:"torrent_size"`
	LoadedSize  int64          `json:"loaded_size"`
	Preloaded   int64          `json:"preloaded_bytes"`
	PreloadSize int64          `json:"preload_size"`
	DownSpeed   float64        `json:"download_speed"`
	UpSpeed     float64        `json:"upload_speed"`
	ActivePeers int            `json:"active_peers"`
	Seeders     int            `json:"connected_seeders"`
	TotalPeers  int            `json:"total_peers"`
	BytesRead   int64          `json:"bytes_read"`
	Files       []*torrentFile `json:"file_stats"`
}

// Те же расширения, что и у интерфейса: список серий в плеере и список файлов
// на экране обязаны совпадать.
var (
	videoExt = map[string]bool{
		".mp4": true, ".mkv": true, ".avi": true, ".mov": true, ".webm": true,
		".m4v": true, ".ts": true, ".wmv": true, ".flv": true, ".mpg": true,
		".mpeg": true, ".m2ts": true, ".3gp": true,
	}
	audioExt = map[string]bool{
		".mp3": true, ".flac": true, ".wav": true, ".m4a": true, ".aac": true,
		".ogg": true, ".opus": true, ".ac3": true, ".dts": true,
	}
)

func isVideoPath(p string) bool { return videoExt[strings.ToLower(path.Ext(p))] }
func isAudioPath(p string) bool { return audioExt[strings.ToLower(path.Ext(p))] }
func isPlayablePath(p string) bool {
	return isVideoPath(p) || isAudioPath(p)
}

// playableFiles отбирает воспроизводимые файлы, сохраняя порядок раздачи.
//
// Файлы без номера пропускаются: номер — это index в адресе потока, и без него
// ссылка ведёт не туда.
func playableFiles(files []*torrentFile) []*torrentFile {
	out := make([]*torrentFile, 0, len(files))
	for _, f := range files {
		if f == nil || f.ID <= 0 || f.Path == "" || !isPlayablePath(f.Path) {
			continue
		}
		out = append(out, f)
	}
	return out
}

// buildPlaylist собирает m3u со всеми сериями, начиная с файла с номером from.
//
// base — адрес, по которому плеер видит демон: он берётся из самого запроса, а
// не подставляется зашитым. Демон может быть доступен и по имени в сети, и по
// адресу замыкания на себя, и playlist должен вести туда же, куда пришёл запрос.
func buildPlaylist(base, hash string, files []*torrentFile, from int) string {
	// Указанного файла в раздаче может уже не быть (файлы переименовали,
	// раздача обновилась) — тогда показываем список целиком: пустой плейлист
	// хуже полного.
	if from > 0 && !hasFile(files, from) {
		from = 0
	}
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	started := false
	for _, f := range files {
		if !started && from > 0 && f.ID != from {
			continue
		}
		started = true
		name := playlistEntryName(f)
		b.WriteString("#EXTINF:0," + name + "\n")
		link := base + "/ts/stream/" + url.PathEscape(name) +
			"?link=" + url.QueryEscape(hash) + "&index=" + fmt.Sprint(f.ID) + "&play"
		b.WriteString(link + "\n")
	}
	return b.String()
}

// playlistEntryName — имя файла в плейлисте: без папок раздачи.
func playlistEntryName(f *torrentFile) string {
	name := path.Base(strings.ReplaceAll(f.Path, "\\", "/"))
	if name == "" || name == "." {
		name = f.Path
	}
	return name
}

// hasFile ищет файл по номеру.
func hasFile(files []*torrentFile, id int) bool {
	for _, f := range files {
		if f != nil && f.ID == id {
			return true
		}
	}
	return false
}

// playlistURL собирает адрес плейлиста так, как его увидит плеер.
//
// Путь оканчивается на .m3u не для красоты: по расширению плеер опознаёт
// плейлист надёжнее, чем по заголовку ответа, а m3u без списка серий — это
// ровно то, на что жаловался пользователь.
func playlistURL(base, hash, title string, index int) string {
	u := base + "/api/playlist/" + url.PathEscape(playlistName(title)) +
		"?hash=" + url.QueryEscape(hash)
	if index > 0 {
		u += "&index=" + fmt.Sprint(index)
	}
	return u
}

// m3uBase собирает адрес демона так, как его видит плеер.
func m3uBase(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); p != "" {
		scheme = p
	}
	host := r.Host
	if h := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); h != "" {
		host = h
	}
	return scheme + "://" + host
}

// fetchTorrentStatus спрашивает у TorrServer состояние раздачи: и ход
// подгрузки, и список файлов. Это тот же ответ, что интерфейс получает по
// /ts/stream?stat, но нужен он самому демону — по списку файлов строится
// плейлист.
//
// Свежую раздачу сервер добавляет сам, поэтому запрос заодно и начинает её.
func fetchTorrentStatus(hash string) (*torrentStatus, error) {
	prof := curCfg().active()
	if prof == nil {
		return nil, errors.New("нет активного сервера")
	}
	target := strings.TrimRight(prof.URL, "/") + "/stream?link=" + url.QueryEscape(hash) + "&stat"
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	if prof.User != "" {
		req.SetBasicAuth(prof.User, prof.Pass)
	}
	resp, err := statusClient.Do(req)
	if err != nil {
		return nil, errors.New("сервер недоступен")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxStatusBody))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		// Сервер объясняет отказ в теле («torrent connection timeout» и т. п.).
		// Показываем объяснение, а не код: по коду причина не видна.
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error != "" {
			return nil, errors.New(e.Error)
		}
		return nil, fmt.Errorf("сервер ответил кодом %d", resp.StatusCode)
	}
	var st torrentStatus
	if err := json.Unmarshal(body, &st); err != nil {
		return nil, errors.New("сервер вернул неразборчивое состояние раздачи")
	}
	return &st, nil
}

// launchURL решает, что получит плеер: плейлист всей раздачи или ссылку на один
// файл.
//
// Плейлист нужен, когда воспроизводимых файлов несколько: одна ссылка на поток —
// это одна серия, и списка серий у плеера не будет вовсе. Не удалось собрать
// список — отдаём ссылку как раньше: запуск важнее способа.
//
// Второе значение — способ запуска, он уходит интерфейсу для показа.
func (c *Comp) launchURL(r *http.Request, hash, title, url string, index int) (string, string) {
	if hash == "" {
		return url, "file"
	}
	st, err := fetchTorrentStatus(hash)
	if err != nil || len(playableFiles(st.Files)) == 0 {
		return url, "file"
	}
	return playlistURL(m3uBase(r), hash, title, index), "playlist"
}

// apiPlaylist отдаёт плейлист раздачи: все воспроизводимые файлы подряд,
// начиная с указанного. Так внешний плеер видит список всех серий, а не одну.
func (c *Comp) apiPlaylist(w http.ResponseWriter, r *http.Request) {
	hash := strings.TrimSpace(r.URL.Query().Get("hash"))
	if hash == "" {
		writeJSONError(w, http.StatusBadRequest, "hash пуст")
		return
	}
	from := atoiSafe(r.URL.Query().Get("index"))
	st, err := fetchTorrentStatus(hash)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	files := playableFiles(st.Files)
	if len(files) == 0 {
		writeJSONError(w, http.StatusNotFound, "в раздаче нет воспроизводимых файлов")
		return
	}
	body := buildPlaylist(m3uBase(r), hash, files, from)
	name := st.Title
	if name == "" {
		name = st.Name
	}
	if name == "" {
		name = hash
	}
	w.Header().Set("Content-Type", "audio/x-mpegurl; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+playlistName(name)+`"`)
	w.Write([]byte(body))
}

// playlistName приводит название раздачи к имени файла: плееру имя показывают,
// а разделители пути и управляющие знаки в нём недопустимы.
func playlistName(s string) string {
	repl := strings.NewReplacer("/", "_", "\\", "_", "\r", "", "\n", "", `"`, "", ":", "_")
	s = strings.TrimSpace(repl.Replace(s))
	if s == "" {
		s = "playlist"
	}
	if len(s) > 80 {
		s = s[:80]
	}
	return s + ".m3u"
}
