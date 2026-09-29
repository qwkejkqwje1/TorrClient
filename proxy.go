package main

// Статика интерфейса, прокси к TorrServer и защита запросов.

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// hostGuard не пускает запросы с чужим Host. Это защита от DNS-rebinding:
// вредоносная страница не может дернуть локальные API-адреса, пока её адрес
// не совпадает с локальным. Если демон сознательно слушает на нездесьшнем
// адресе (--host 0.0.0.0), проверка отключается — доступ наружу открыт явно.
func hostGuard(next http.Handler) http.Handler {
	if *flagHost != "127.0.0.1" && *flagHost != "localhost" && *flagHost != "::1" {
		return next
	}
	allowed := map[string]bool{
		"127.0.0.1": true,
		"localhost": true,
		"::1":       true,
		"127.0.0.2": true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Host
		if host, _, err := net.SplitHostPort(h); err == nil {
			h = host
		}
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" && allowed[h] {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
	})
}

// safeMethod сообщает, что метод по семантике HTTP ничего не меняет. Только
// такие запросы можно принимать с чужого сайта без последствий: прочитать
// ответ он не сможет (CORS-заголовков демон не отдаёт), а изменить состояние
// через GET нечем — все мутации принимаются исключительно POST'ом.
func safeMethod(m string) bool {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

// originGuard отбрасывает чужие изменяющие запросы. Демон не отдаёт
// CORS-заголовков, поэтому его API с чужой страницы не прочитать — но запрос
// *отправить* можно: классическая HTML-форма постит без CORS. Поэтому оба
// признака чужого источника проверяются на всех методах, а не только на POST:
//
//   - Origin (браузер шлёт его на POST и на навигации fetch'ем): обязан
//     совпадать с хостом запроса;
//   - Sec-Fetch-Site (браузер шлёт на каждый запрос): «cross-site» означает,
//     что запрос инициирован страницей с чужого сайта.
//
// Безопасные методы при этом пропускаются намеренно. Демон обслуживает не
// только вкладку браузера, но и окно-оболочку, а оболочка Wails живёт на
// отдельном хосте (wails.localhost) и переходит на UI демона обычной
// навигацией — для браузера это чужой сайт. Строгая проверка на всех методах
// оставляла окно пустым: GET / с Sec-Fetch-Site: cross-site получал 403, и
// приложение выглядело не запускающимся. Пропускать безопасные методы можно
// ровно потому, что ни один GET состояние не меняет.
//
// Запросы без этих заголовков (curl, плееры, системные вызовы) не трогаются.
func originGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requestTrusted(r) {
			writeJSONError(w, http.StatusForbidden, "cross-site request rejected")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requestTrusted решает, можно ли выполнить запрос: свой — всегда, чужой —
// только если он ничего не меняет.
func requestTrusted(r *http.Request) bool {
	foreign := false
	if o := r.Header.Get("Origin"); o != "" {
		if u, err := url.Parse(o); err != nil || !strings.EqualFold(u.Host, r.Host) {
			foreign = true
		}
	}
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "cross-site") {
		foreign = true
	}
	return !foreign || safeMethod(r.Method)
}

// apiNet — проба готовности демона. Её делает окно-оболочка, прежде чем уйти
// на UI: до этой ручки адрес не существовал, и оболочка полагалась на то, что
// no-cors-запрос разрешается и при 404.
func (c *Comp) apiNet(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// openBrowser открывает страницу системным браузером. Адрес проверяется: через
// url.dll срабатывает любой зарегистрированный протокол, и адрес извне не
// должен превращаться в вызов file:// или другого обработчика.
func openBrowser(rawurl string) {
	if !isHTTPLink(rawurl) {
		return
	}
	exec.Command(`rundll32`, `url.dll,FileProtocolHandler`, rawurl).Start()
}

// isHTTPLink сообщает, безопасно ли передать адрес браузеру или плееру:
// только http(s) с хостом, без кавычек и управляющих знаков — кавычка ломает
// разбор командной строки плеера (splitCmdline считает её границей аргумента).
func isHTTPLink(s string) bool {
	if strings.ContainsAny(s, "\"'\r\n") {
		return false
	}
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// argSafe убирает из значения, подставляемого в командную строку плеера,
// знаки, ломающие разбор аргументов: splitCmdline особой считает только
// двойную кавычку, а перевод строки — разделителем. Одиночная кавычка в
// названиях легитимна («Don't») и разбору не мешает.
func argSafe(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '"', '\r', '\n':
			return -1
		}
		return r
	}, s)
}

// webAssets — статика интерфейса, прочитанная в память один раз. Перечитывать
// встроенные файлы на каждый запрос незачем.
var webAssets = func() map[string][]byte {
	out := map[string][]byte{}
	for _, name := range []string{"index.html", "style.css", "app.js"} {
		if b, err := webFS.ReadFile("web/" + name); err == nil {
			out[name] = b
		}
	}
	return out
}()

// webAssetInfo — то, что считается один раз на каждый файл статики: ETag и
// сжатая копия. Файлы вшиты в exe и между запусками не меняются, поэтому
// хеш содержимого — надёжный признак версии, а сжимать на каждый запрос
// (256 КБ app.js) незачем.
type webAssetInfo struct {
	etag string
	gz   []byte
}

var webAssetMeta = func() map[string]webAssetInfo {
	out := map[string]webAssetInfo{}
	for name, b := range webAssets {
		sum := sha256.Sum256(b)
		info := webAssetInfo{etag: `"` + hex.EncodeToString(sum[:8]) + `"`}
		var buf bytes.Buffer
		zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if err == nil {
			_, werr := zw.Write(b)
			cerr := zw.Close()
			// Сжатая копия нужна только если получилась и стала меньше.
			if werr == nil && cerr == nil && buf.Len() < len(b) {
				info.gz = buf.Bytes()
			}
		}
		out[name] = info
	}
	return out
}()

// etagMatches сообщает, подходит ли заголовок If-None-Match к текущему ETag.
// Слабый префикс W/ отбрасывается: для GET сравнение слабое по определению.
func etagMatches(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		p := strings.TrimSpace(part)
		if p == "*" {
			return true
		}
		p = strings.TrimPrefix(p, "W/")
		if p != "" && p == etag {
			return true
		}
	}
	return false
}

func (c *Comp) handleRoot(w http.ResponseWriter, r *http.Request) {
	var name, ctype string
	switch r.URL.Path {
	case "/":
		name, ctype = "index.html", "text/html; charset=utf-8"
	case "/style.css":
		name, ctype = "style.css", "text/css; charset=utf-8"
	case "/app.js":
		name, ctype = "app.js", "application/javascript; charset=utf-8"
	default:
		http.NotFound(w, r)
		return
	}
	b, ok := webAssets[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	meta := webAssetMeta[name]
	h := w.Header()
	h.Set("Content-Type", ctype)
	// no-cache — не «не кэшировать», а «спрашивать каждый раз»: браузер
	// присылает If-None-Match и получает 304 без тела, пока exe тот же. После
	// обновления программы ETag меняется, и устаревшей копии интерфейса нет.
	h.Set("Cache-Control", "no-cache")
	h.Set("Vary", "Accept-Encoding")
	if meta.etag != "" {
		h.Set("ETag", meta.etag)
		if etagMatches(r.Header.Get("If-None-Match"), meta.etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	body := b
	if len(meta.gz) > 0 && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		h.Set("Content-Encoding", "gzip")
		body = meta.gz
	}
	h.Set("Content-Length", itoaLen(len(body)))
	w.Write(body)
}

// itoaLen превращает длину в строку для заголовка Content-Length.
func itoaLen(n int) string {
	const digits = "0123456789"
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = digits[n%10]
		n /= 10
	}
	return string(buf[i:])
}

// ---------- proxy ----------

var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// streamClient — клиент проксирования потока. Общего таймаута нет: видео играет
// дольше любого разумного лимита. Транспорт один на всех: соединения с сервером
// переиспользуются между запросами, а не открываются заново на каждый чанк.
var streamClient = &http.Client{
	Timeout: 0,
	Transport: &http.Transport{
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     2 * time.Minute,
		TLSHandshakeTimeout: 10 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return nil
	},
}

// streamBufSize — размер куска при перекладывании потока. 32 КБ по умолчанию у
// io.Copy — это тысячи системных вызовов на гигабайтный файл; 256 КБ снижает их
// на порядок и не занимает заметной памяти: буферы берутся из пула.
const streamBufSize = 256 << 10

var streamBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, streamBufSize)
		return &b
	},
}

// copyStream перекладывает поток крупными кусками и после каждого сбрасывает
// его клиенту (flusher может быть nil). Сброс нужен, чтобы плеер получал байты
// сразу, а не по заполнению внутреннего буфера сервера: это ускоряет старт и
// снижает задержку перемотки. Стандартный io.Copy тут не годится: у
// http.ResponseWriter есть ReadFrom, и заданный буфер он игнорирует.
func copyStream(dst io.Writer, src io.Reader, flusher http.Flusher) (int64, error) {
	bp := streamBufPool.Get().(*[]byte)
	defer streamBufPool.Put(bp)
	buf := *bp
	var written int64
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			nw, werr := dst.Write(buf[:n])
			written += int64(nw)
			if flusher != nil {
				flusher.Flush()
			}
			if werr != nil {
				return written, werr
			}
			if nw < n {
				return written, io.ErrShortWrite
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				rerr = nil
			}
			return written, rerr
		}
	}
}

func (c *Comp) handleProxy(w http.ResponseWriter, r *http.Request) {
	// Конфиг может быть ещё не опубликован: прокси поднимается на том же шаге,
	// что и чтение настроек, а обращение к nil-конфигу — паника в обработчике
	// запроса. Тот же случай оговорён в backup.go.
	cfg := curCfg()
	if cfg == nil {
		writeJSONError(w, http.StatusBadGateway, "настройки ещё не прочитаны")
		return
	}
	prof := cfg.active()
	if prof == nil {
		http.Error(w, `{"error":"no active profile"}`, http.StatusBadGateway)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/ts")
	if path == "" {
		path = "/"
	}
	// Поиск rutor выполняем сами (рабочий даже без TorrServer). Этот перехват
	// чинит и десктоп-оболочку, в которую вшита старая копия интерфейса.
	if r.Method == http.MethodGet && path == "/search" && strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("tracker")), "rutor") {
		items, err := c.rutorSearch(
			strings.TrimSpace(r.URL.Query().Get("query")),
			atoiSafe(r.URL.Query().Get("page")),
			normalizeRutorCat(atoiSafe(r.URL.Query().Get("cat"))),
		)
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, err.Error())
			return
		}
		jj(w, items)
		return
	}
	target := strings.TrimRight(prof.URL, "/") + path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	for k, v := range r.Header {
		skip := false
		for _, h := range hopHeaders {
			if strings.EqualFold(k, h) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		req.Header[k] = v
	}
	if prof.User != "" {
		req.SetBasicAuth(prof.User, prof.Pass)
	}

	resp, err := streamClient.Do(req)
	if err != nil {
		http.Error(w, `{"error":"server unreachable"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Content-Length теперь сохраняется. Раньше он отбрасывался для всех
	// ответов, и браузер получал 206 без длины: длительность и перемотка
	// зависели от Content-Range и от везения. Заголовок можно пробрасывать
	// как есть: Accept-Encoding клиента уходит серверу без изменений, поэтому
	// Go не распаковывает тело сам, и длина совпадает с тем, что будет записано.
	for k, v := range resp.Header {
		skip := false
		for _, h := range hopHeaders {
			if strings.EqualFold(k, h) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		w.Header()[k] = v
	}
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	// Сколько байт файла ушло клиенту, видно только здесь. По этому счёту
	// отмечается просмотренное у плеера, о позиции не сообщающего.
	readHash, readFile := readTarget(path, r.URL.Query().Get)
	if readHash == "" || readFile <= 0 {
		copyStream(w, resp.Body, flusher)
		return
	}
	cw := &countingWriter{w: w}
	copyStream(cw, resp.Body, flusher)
	viewedReads.add(readHash, readFile, cw.n)
	// Отметка ставится отдельно: ответ клиенту она задерживать не должна.
	// Уже просмотренному файлу горутина с запросом статуса не нужна.
	if prev, ok := viewedMarks.get(readHash, readFile); !ok || !prev.Done {
		go markReadThrough(readHash, readFile, fileLength(readHash, readFile))
	}
}
