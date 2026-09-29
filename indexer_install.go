package main

// Помощник «где взять Jackett / Prowlarr»: показывает, установлен ли каждый,
// запущен ли, и умеет поставить его через winget или запустить уже
// установленный. На Linux/macOS — только состояние и ссылки на загрузку.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type indexerApp struct {
	Kind     string   // jackett | prowlarr
	Name     string   // для людей
	WingetID string   // пакет winget
	Port     int      // порт по умолчанию
	Exes     []string // где лежит после установки (Windows)
	Site     string   // страница загрузки
}

var indexerApps = []indexerApp{
	{Kind: "prowlarr", Name: "Prowlarr", WingetID: "TeamProwlarr.Prowlarr", Port: 9696,
		Exes: []string{`%ProgramData%\Prowlarr\bin\Prowlarr.exe`}, Site: "https://prowlarr.com/#downloads"},
	{Kind: "jackett", Name: "Jackett", WingetID: "Jackett.Jackett", Port: 9117,
		Exes: []string{`%ProgramData%\Jackett\JackettTray.exe`, `%ProgramData%\Jackett\JackettConsole.exe`}, Site: "https://github.com/Jackett/Jackett/releases/latest"},
}

// indexerJob — ход установки через winget: она идёт минуты, и интерфейс
// спрашивает состояние, а не держит запрос открытым.
type indexerJob struct {
	State string `json:"state"` // installing | done | error
	Note  string `json:"note,omitempty"`
}

var (
	indexerJobsMu sync.Mutex
	indexerJobs   = map[string]indexerJob{}
)

func findIndexerExe(a indexerApp) string {
	if runtime.GOOS != "windows" {
		return ""
	}
	for _, p := range a.Exes {
		p = expandWinEnv(p)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func wingetPath() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	p, err := exec.LookPath("winget")
	if err != nil {
		return ""
	}
	return p
}

// indexerAppsState — состояние обоих: установлен, запущен, идёт ли установка.
func indexerAppsState(ctx context.Context) map[string]any {
	apps := make([]map[string]any, 0, len(indexerApps))
	for _, a := range indexerApps {
		exe := findIndexerExe(a)
		running := probeIndexer(ctx, "http://127.0.0.1:"+itoa(a.Port)) == a.Kind
		indexerJobsMu.Lock()
		job := indexerJobs[a.Kind]
		indexerJobsMu.Unlock()
		apps = append(apps, map[string]any{
			"kind": a.Kind, "name": a.Name, "installed": exe != "" || running, "exe": exe,
			"running": running, "url": "http://127.0.0.1:" + itoa(a.Port), "site": a.Site, "job": job,
		})
	}
	return map[string]any{"os": runtime.GOOS, "winget": wingetPath() != "", "apps": apps}
}

func itoa(n int) string { return strconv.Itoa(n) }

func indexerAppByKind(kind string) (indexerApp, bool) {
	for _, a := range indexerApps {
		if a.Kind == kind {
			return a, true
		}
	}
	return indexerApp{}, false
}

// startIndexerInstall запускает winget в фоне. Установщик может попросить
// подтверждение администратора — это окно Windows, не наше.
func startIndexerInstall(a indexerApp, run func(name string, args ...string) ([]byte, error)) string {
	w := wingetPath()
	if w == "" {
		return "winget не найден: установите «Установщик приложений» из Microsoft Store или скачайте " + a.Name + " с сайта"
	}
	indexerJobsMu.Lock()
	if indexerJobs[a.Kind].State == "installing" {
		indexerJobsMu.Unlock()
		return ""
	}
	indexerJobs[a.Kind] = indexerJob{State: "installing", Note: "winget ставит " + a.Name + "…"}
	indexerJobsMu.Unlock()
	go func() {
		out, err := run(w, "install", "--id", a.WingetID, "-e", "--silent",
			"--accept-package-agreements", "--accept-source-agreements")
		j := indexerJob{State: "done", Note: a.Name + " установлен"}
		if err != nil {
			tail := strings.TrimSpace(string(out))
			if len(tail) > 300 {
				tail = tail[len(tail)-300:]
			}
			j = indexerJob{State: "error", Note: "winget: " + err.Error() + " " + tail}
		}
		indexerJobsMu.Lock()
		indexerJobs[a.Kind] = j
		indexerJobsMu.Unlock()
	}()
	return ""
}

func runCombined(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// startIndexerApp запускает установленный, но не запущенный Jackett/Prowlarr.
func startIndexerApp(a indexerApp) string {
	exe := findIndexerExe(a)
	if exe == "" {
		return a.Name + " не найден на диске"
	}
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return "не запустился: " + err.Error()
	}
	go cmd.Wait()
	return ""
}
