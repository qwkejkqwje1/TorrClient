package main

// Автообновление через GitHub Releases.
//
// Демон раз в несколько часов (и по кнопке) спрашивает последний релиз, и если
// он новее запущенной версии, интерфейс предлагает обновиться. Установка:
// архив для своей системы скачивается, сверяется с SHA256SUMS.txt того же
// релиза и раскладывается рядом с программой. Работающий exe на Windows
// перезаписать нельзя, но переименовать можно: старый файл уходит в *.old
// (убирается при следующем запуске), новый ложится на его место. Затем демон
// перезапускается: под окном TorrClient — просто выходит, окно поднимет его
// заново; без окна — запускает свою новую копию и выходит сам.

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	updateRepo    = "qwkejkqwje1/TorrClient"
	updateMaxSize = 200 << 20
	updateEvery   = time.Hour
)

// startExe — путь к программе, каким он был при запуске.
var startExe = func() string { p, _ := os.Executable(); return p }()

// updateAPI, updateDir, trustURL — переменные ради тестов: адрес «последнего
// релиза», папка, куда ложатся файлы, и проверка адреса загрузки.
var (
	updateAPI = "https://api.github.com/repos/" + updateRepo + "/releases/latest"
	updateDir = exeDir
	trustURL  = trustedDownload
)

type relAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

type relInfo struct {
	Tag    string     `json:"tag_name"`
	Name   string     `json:"name"`
	Body   string     `json:"body"`
	Page   string     `json:"html_url"`
	Assets []relAsset `json:"assets"`
}

type updater struct {
	mu      sync.Mutex
	rel     *relInfo
	checked time.Time
	err     string
	state   string // "", "installing", "done", "failed"
	note    string
}

var upd = &updater{}

// parseVer разбирает «1.10.0», «v1.10.0» и «1.10.0-dev» в числа. Хвост после
// дефиса отбрасывается: сборка 1.10.0-dev и релиз 1.10.0 — одна версия.
func parseVer(s string) []int {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "- +"); i >= 0 {
		s = s[:i]
	}
	var out []int
	for _, p := range strings.Split(s, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// newerVer — a новее b.
func newerVer(a, b string) bool {
	x, y := parseVer(a), parseVer(b)
	if x == nil || y == nil {
		return false
	}
	for i := 0; i < len(x) || i < len(y); i++ {
		var p, q int
		if i < len(x) {
			p = x[i]
		}
		if i < len(y) {
			q = y[i]
		}
		if p != q {
			return p > q
		}
	}
	return false
}

// assetFor выбирает архив для текущей системы.
func assetFor(rel *relInfo, goos, goarch string) *relAsset {
	suffix := fmt.Sprintf("-%s-%s.tar.gz", goos, goarch)
	if goos == "windows" {
		suffix = fmt.Sprintf("-%s-%s.zip", goos, goarch)
	}
	for i := range rel.Assets {
		if strings.HasSuffix(rel.Assets[i].Name, suffix) {
			return &rel.Assets[i]
		}
	}
	return nil
}

func trustedDownload(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "github.com" || strings.HasSuffix(h, ".githubusercontent.com")
}

func fetchLimited(ctx context.Context, raw string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "TorrClient/"+appVersion())
	req.Header.Set("Accept", "application/vnd.github+json, */*")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errors.New("файл слишком большой")
	}
	return b, nil
}

func (u *updater) check(force bool) {
	u.mu.Lock()
	if !force && time.Since(u.checked) < updateEvery {
		u.mu.Unlock()
		return
	}
	u.checked = time.Now()
	u.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	b, err := fetchLimited(ctx, updateAPI, 4<<20)
	var rel relInfo
	if err == nil {
		err = json.Unmarshal(b, &rel)
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if err != nil {
		u.err = "не удалось узнать последнюю версию: " + err.Error()
		return
	}
	u.err = ""
	u.rel = &rel
}

// parseSums читает SHA256SUMS.txt: «<hex>  <имя>» построчно.
func parseSums(b []byte) map[string]string {
	out := map[string]string{}
	for _, ln := range strings.Split(string(b), "\n") {
		f := strings.Fields(ln)
		if len(f) == 2 {
			out[strings.TrimPrefix(f[1], "*")] = strings.ToLower(f[0])
		}
	}
	return out
}

// updFile — файл из архива, который ляжет рядом с программой.
type updFile struct {
	name string
	data []byte
	mode os.FileMode
}

// safeName пропускает только файлы верхнего уровня: архив не должен писать
// за пределы папки программы и не должен трогать настройки и данные.
func safeName(n string) (string, bool) {
	n = strings.TrimPrefix(filepath.ToSlash(n), "./")
	if n == "" || strings.Contains(n, "/") || strings.Contains(n, "..") {
		return "", false
	}
	switch strings.ToLower(n) {
	case "torrclient.json", "userdata.json", "viewed.json", "subscriptions.json", "tmdb-cache.json":
		return "", false
	}
	return n, true
}

func unpack(name string, b []byte) ([]updFile, error) {
	var out []updFile
	if strings.HasSuffix(name, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if f.FileInfo().IsDir() {
				continue
			}
			n, ok := safeName(f.Name)
			if !ok {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			data, err := io.ReadAll(io.LimitReader(rc, updateMaxSize))
			rc.Close()
			if err != nil {
				return nil, err
			}
			out = append(out, updFile{n, data, 0o755})
		}
		return out, nil
	}
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		n, ok := safeName(h.Name)
		if !ok {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(tr, updateMaxSize))
		if err != nil {
			return nil, err
		}
		mode := os.FileMode(h.Mode) & 0o777
		if mode == 0 {
			mode = 0o644
		}
		out = append(out, updFile{n, data, mode})
	}
	return out, nil
}

// placeFile кладёт файл на место: занятый (запущенный) файл переименовывается
// в .old, а не перезаписывается — на Windows это единственный рабочий способ.
func placeFile(dir string, f updFile) error {
	dst := filepath.Join(dir, f.name)
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, f.data, f.mode); err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		old := dst + ".old"
		_ = os.Remove(old)
		if _, err := os.Stat(old); err == nil {
			old = fmt.Sprintf("%s.%d.old", dst, time.Now().UnixNano())
		}
		if err := os.Rename(dst, old); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	return os.Rename(tmp, dst)
}

// cleanupOld убирает файлы, оставшиеся от прошлого обновления.
func cleanupOld(dir string) {
	matches, _ := filepath.Glob(filepath.Join(dir, "*.old"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
}

func (u *updater) set(state, note string) {
	u.mu.Lock()
	u.state, u.note = state, note
	u.mu.Unlock()
}

func (u *updater) install(restart func()) {
	u.mu.Lock()
	rel := u.rel
	if u.state == "installing" {
		u.mu.Unlock()
		return
	}
	u.state, u.note = "installing", "скачиваю…"
	u.mu.Unlock()
	fail := func(msg string) { u.set("failed", msg) }
	if rel == nil {
		fail("сначала проверьте обновления")
		return
	}
	a := assetFor(rel, runtime.GOOS, runtime.GOARCH)
	if a == nil {
		fail("в релизе нет архива для " + runtime.GOOS + "/" + runtime.GOARCH)
		return
	}
	var sumURL string
	for _, x := range rel.Assets {
		if x.Name == "SHA256SUMS.txt" {
			sumURL = x.URL
		}
	}
	if sumURL == "" || !trustURL(sumURL) || !trustURL(a.URL) {
		fail("в релизе нет SHA256SUMS.txt — устанавливать непроверенный архив нельзя")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	sums, err := fetchLimited(ctx, sumURL, 1<<20)
	if err != nil {
		fail("SHA256SUMS.txt: " + err.Error())
		return
	}
	data, err := fetchLimited(ctx, a.URL, updateMaxSize)
	if err != nil {
		fail("загрузка: " + err.Error())
		return
	}
	h := sha256.Sum256(data)
	if want := parseSums(sums)[a.Name]; want == "" || want != hex.EncodeToString(h[:]) {
		fail("контрольная сумма архива не сошлась — файл повреждён или подменён")
		return
	}
	files, err := unpack(a.Name, data)
	if err != nil || len(files) == 0 {
		fail(fmt.Sprintf("архив не читается: %v", err))
		return
	}
	dir := updateDir()
	for _, f := range files {
		if err := placeFile(dir, f); err != nil {
			fail(fmt.Sprintf("не удалось записать %s: %v", f.name, err))
			return
		}
	}
	u.set("done", "установлено, перезапуск…")
	logAlways("Обновление до %s установлено, перезапуск.", rel.Tag)
	if restart != nil {
		go func() {
			time.Sleep(1500 * time.Millisecond)
			restart()
		}()
	}
}

// restartSelf перезапускает демон новой версией. Под окном TorrClient
// (TC_SUPERVISED=1) достаточно выйти: окно поднимет демон само и уже из
// нового файла. Иначе порт освобождается и запускается своя новая копия.
func (c *Comp) restartSelf() {
	_ = viewedMarks.save()
	if os.Getenv("TC_SUPERVISED") == "1" {
		os.Exit(0)
	}
	// Новая копия запускается первой: как только старая отпустит порт
	// (Shutdown ниже), она его займёт — ждать она умеет (TC_UPDATE_RESTART).
	// Наоборот нельзя: после Shutdown main возвращается и процесс кончается
	// раньше, чем успел бы запустить замену.
	// Путь берётся запомненный при запуске: на Linux os.Executable() после
	// переименования вернул бы уже torrclient.old.
	if exe := startExe; exe != "" {
		cmd := exec.Command(exe, os.Args[1:]...)
		cmd.Env = append(os.Environ(), "TC_UPDATE_RESTART=1")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		detachCmd(cmd)
		if err := cmd.Start(); err != nil {
			logAlways("Перезапуск после обновления: %v — запустите программу вручную.", err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if c.httpSrv != nil {
		_ = c.httpSrv.Shutdown(ctx)
	}
	os.Exit(0)
}

func (u *updater) status() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := map[string]any{
		"current": appVersion(),
		"error":   u.err,
		"state":   u.state,
		"note":    u.note,
	}
	if !u.checked.IsZero() {
		out["checked"] = u.checked.Unix()
	}
	if u.rel != nil {
		latest := strings.TrimPrefix(u.rel.Tag, "v")
		out["latest"] = latest
		out["newer"] = newerVer(latest, appVersion())
		out["page"] = u.rel.Page
		out["notes"] = u.rel.Body
		out["installable"] = assetFor(u.rel, runtime.GOOS, runtime.GOARCH) != nil
	}
	return out
}

// apiUpdate: GET — состояние (проверка не чаще раза в 6 часов, ?force=1 —
// сейчас же); POST {action:"install"} — установить последнюю версию.
func (c *Comp) apiUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var req struct {
			Action string `json:"action"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req)
		if req.Action != "install" {
			writeJSONError(w, http.StatusBadRequest, "unknown action")
			return
		}
		go upd.install(c.restartSelf)
		time.Sleep(100 * time.Millisecond)
		jj(w, upd.status())
		return
	}
	upd.check(r.URL.Query().Get("force") == "1")
	w.Header().Set("Cache-Control", "no-store")
	jj(w, upd.status())
}
