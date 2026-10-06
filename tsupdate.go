package main

// Обновление TorrServer MatriX из приложения.
//
// Новый выпуск скачивается с GitHub (YouROK/TorrServer) рядом со старым
// файлом, старый переименовывается (запущенный файл переименовать можно, а
// удалить — нет), сервер просится завершиться и поднимается уже новым:
// сторож приложения перезапускает его сам, а если сторожа нет — запускает
// демон. Обновляется только локальный сервер: файл удалённого лежит на
// другом компьютере.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const tsReleaseAPI = "https://api.github.com/repos/YouROK/TorrServer/releases/latest"

type tsUpdater struct {
	mu      sync.Mutex
	rel     *relInfo
	checked time.Time
	err     string
	state   string // "", "downloading", "restarting", "done", "failed"
	note    string
	got     int64
	total   int64
}

var tsUpd = &tsUpdater{}

// tsAssetName — имя файла TorrServer для этой системы.
func tsAssetName(goos, goarch string) string {
	n := "TorrServer-" + goos + "-" + goarch
	if goos == "windows" {
		n += ".exe"
	}
	return n
}

// tsBinaryPath ищет файл локального TorrServer: TC_SERVER, затем папка
// программы и две папки выше — так его ищет и приложение.
func tsBinaryPath() string {
	if v := os.Getenv("TC_SERVER"); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	name := tsAssetName(runtime.GOOS, runtime.GOARCH)
	dir := filepath.Dir(exe)
	for i := 0; i < 3; i++ {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
		dir = filepath.Dir(dir)
	}
	return ""
}

var reVerNums = regexp.MustCompile(`\d+`)

// tsVerNums — числа версии: «MatriX.145.2» → [145 2]. Приставка MatriX и
// прочие буквы не в счёт.
func tsVerNums(s string) []int {
	var out []int
	for _, m := range reVerNums.FindAllString(s, 6) {
		n, _ := strconv.Atoi(m)
		out = append(out, n)
	}
	return out
}

// tsNewer — версия a новее b.
func tsNewer(a, b string) bool {
	x, y := tsVerNums(a), tsVerNums(b)
	if len(x) == 0 || len(y) == 0 {
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

func isLocalURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func tsEcho(p *Profile) string {
	ok, _, ver := probeServer(p)
	if !ok {
		return ""
	}
	return ver
}

func (u *tsUpdater) latest(force bool) (*relInfo, error) {
	u.mu.Lock()
	if !force && u.rel != nil && time.Since(u.checked) < time.Hour {
		r := u.rel
		u.mu.Unlock()
		return r, nil
	}
	u.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	b, err := fetchLimited(ctx, tsReleaseAPI, 4<<20)
	if err != nil {
		u.mu.Lock()
		u.err = err.Error()
		u.mu.Unlock()
		return nil, err
	}
	var rel relInfo
	if err := json.Unmarshal(b, &rel); err != nil {
		return nil, err
	}
	u.mu.Lock()
	u.rel, u.checked, u.err = &rel, time.Now(), ""
	u.mu.Unlock()
	return &rel, nil
}

func (u *tsUpdater) set(state, note string) {
	u.mu.Lock()
	u.state, u.note = state, note
	u.mu.Unlock()
}

// install скачивает и ставит новый TorrServer.
func (u *tsUpdater) install(prof *Profile, path string, asset relAsset) {
	fail := func(note string) { u.set("failed", note) }
	u.set("downloading", "Скачиваю "+asset.Name)
	if !trustedDownload(asset.URL) {
		fail("адрес файла не с GitHub")
		return
	}
	tmp := path + ".new"
	if err := downloadTo(asset, tmp, u); err != nil {
		_ = os.Remove(tmp)
		fail("скачивание: " + err.Error())
		return
	}
	_ = os.Chmod(tmp, 0o755)
	u.set("restarting", "Перезапускаю TorrServer")
	old := path + ".old"
	_ = os.Remove(old)
	// Запущенный файл переименовывается, и на его место встаёт новый — тогда
	// сторож приложения, перезапуская сервер, поднимет уже новую версию.
	renamed := os.Rename(path, old) == nil
	if renamed {
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Rename(old, path)
			_ = os.Remove(tmp)
			fail("замена файла: " + err.Error())
			return
		}
	}
	tsShutdown(prof)
	if !renamed {
		// Не дали переименовать — значит, файл держат; ждём завершения.
		var err error
		for i := 0; i < 20; i++ {
			time.Sleep(500 * time.Millisecond)
			if err = os.Rename(path, old); err == nil {
				break
			}
		}
		if err != nil {
			_ = os.Remove(tmp)
			fail("старый файл занят: " + err.Error())
			return
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Rename(old, path)
			fail("замена файла: " + err.Error())
			return
		}
	}
	// Сторож приложения поднимает сервер сам; без него — запускаем сами.
	if !waitEcho(prof, 12*time.Second) {
		cmd := exec.Command(path)
		cmd.Dir = filepath.Dir(path)
		detachCmd(cmd)
		if err := cmd.Start(); err != nil {
			fail("запуск нового TorrServer: " + err.Error())
			return
		}
		go func() { _ = cmd.Wait() }()
		if !waitEcho(prof, 25*time.Second) {
			fail("новый TorrServer не ответил; прежний файл сохранён как " + filepath.Base(old))
			return
		}
	}
	_ = os.Remove(old)
	u.set("done", "TorrServer обновлён: "+tsEcho(prof))
}

func waitEcho(p *Profile, d time.Duration) bool {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		time.Sleep(time.Second)
		if ok, _, _ := probeServer(p); ok {
			return true
		}
	}
	return false
}

func tsShutdown(p *Profile) {
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(p.URL, "/")+"/shutdown", nil)
	if err != nil {
		return
	}
	if p.User != "" {
		req.SetBasicAuth(p.User, p.Pass)
	}
	cl := &http.Client{Timeout: 5 * time.Second}
	if resp, err := cl.Do(req); err == nil {
		resp.Body.Close()
	}
	// Ждём, пока сервер действительно закроется.
	for i := 0; i < 20; i++ {
		if ok, _, _ := probeServer(p); !ok {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// downloadTo пишет файл потоком, считая принятое: файл весит десятки
// мегабайт, и держать его целиком в памяти незачем.
func downloadTo(a relAsset, dst string, u *tsUpdater) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "TorrClient/"+appVersion())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	u.mu.Lock()
	u.got, u.total = 0, a.Size
	u.mu.Unlock()
	buf := make([]byte, 256<<10)
	var n int64
	var head []byte
	for {
		k, rerr := resp.Body.Read(buf)
		if k > 0 {
			if len(head) < 4 {
				head = append(head, buf[:min(k, 4)]...)
			}
			if _, err := f.Write(buf[:k]); err != nil {
				f.Close()
				return err
			}
			n += int64(k)
			u.mu.Lock()
			u.got = n
			u.mu.Unlock()
			if n > 300<<20 {
				f.Close()
				return errors.New("файл слишком большой")
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return rerr
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if a.Size > 0 && n != a.Size {
		return fmt.Errorf("получено %d байт из %d", n, a.Size)
	}
	if !execHeader(head) {
		return errors.New("скачанный файл — не программа")
	}
	return nil
}

// execHeader — начало исполняемого файла: MZ (Windows), ELF, Mach-O.
func execHeader(h []byte) bool {
	if len(h) >= 2 && h[0] == 'M' && h[1] == 'Z' {
		return true
	}
	if len(h) >= 4 && string(h[:4]) == "\x7fELF" {
		return true
	}
	if len(h) >= 4 && (string(h[:4]) == "\xcf\xfa\xed\xfe" || string(h[:4]) == "\xce\xfa\xed\xfe") {
		return true
	}
	return false
}

// apiTsUpdate: GET — версии и состояние; POST {action:"install"} — обновить;
// GET ?force=1 — заново спросить GitHub.
func (c *Comp) apiTsUpdate(w http.ResponseWriter, r *http.Request) {
	prof := curCfg().active()
	out := map[string]any{}
	local := prof != nil && isLocalURL(prof.URL)
	path := ""
	if local {
		path = tsBinaryPath()
	}
	out["local"] = local
	out["found"] = path != ""
	if prof != nil {
		out["current"] = tsEcho(prof)
	}
	rel, err := tsUpd.latest(r.URL.Query().Get("force") == "1")
	var asset *relAsset
	if err != nil {
		out["error"] = "GitHub не ответил: " + err.Error()
	} else {
		out["latest"] = rel.Tag
		out["page"] = rel.Page
		name := tsAssetName(runtime.GOOS, runtime.GOARCH)
		for i := range rel.Assets {
			if rel.Assets[i].Name == name {
				asset = &rel.Assets[i]
			}
		}
		if asset != nil {
			out["size"] = asset.Size
		}
		cur, _ := out["current"].(string)
		out["newer"] = cur != "" && tsNewer(rel.Tag, cur)
	}
	if r.Method == http.MethodPost {
		var in struct {
			Action string `json:"action"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&in)
		if in.Action != "install" {
			writeJSONError(w, http.StatusBadRequest, "неизвестное действие")
			return
		}
		switch {
		case !local:
			writeJSONError(w, http.StatusBadRequest, "активный сервер не на этом компьютере — обновите TorrServer там, где он установлен")
			return
		case path == "":
			writeJSONError(w, http.StatusBadRequest, "файл "+tsAssetName(runtime.GOOS, runtime.GOARCH)+" не найден рядом с программой")
			return
		case asset == nil:
			writeJSONError(w, http.StatusBadGateway, "в выпуске нет файла для этой системы")
			return
		}
		tsUpd.mu.Lock()
		busy := tsUpd.state == "downloading" || tsUpd.state == "restarting"
		if !busy {
			tsUpd.state, tsUpd.note = "downloading", "Начинаю"
		}
		tsUpd.mu.Unlock()
		if !busy {
			go tsUpd.install(prof, path, *asset)
		}
	}
	tsUpd.mu.Lock()
	out["state"], out["note"], out["got"], out["total"] = tsUpd.state, tsUpd.note, tsUpd.got, tsUpd.total
	tsUpd.mu.Unlock()
	jj(w, out)
}
