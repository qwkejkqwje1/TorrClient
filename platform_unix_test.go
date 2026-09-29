//go:build !windows

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func linuxSandbox(t *testing.T) string {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("проверка для Linux")
	}
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	t.Setenv("PATH", "") // xdg-mime в проверке не вызывается
	return dir
}

func TestDesktopExecQuoting(t *testing.T) {
	if got := desktopExec(`/opt/Torr Client/torrclient`); got != `"/opt/Torr Client/torrclient"` {
		t.Errorf("путь с пробелом: %s", got)
	}
	if got := desktopExec(`/a"b$c`); got != `"/a\"b\$c"` {
		t.Errorf("служебные символы: %s", got)
	}
}

func TestLinuxHandlersInstallAndRemove(t *testing.T) {
	linuxSandbox(t)
	if m, tr := platformHandlersStatus(); m || tr {
		t.Fatal("до установки обработчиков быть не должно")
	}
	c := &Comp{}
	rec := httptest.NewRecorder()
	c.apiReg(rec, httptest.NewRequest("POST", "/api/reg?action=install", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("установка: %d %s", rec.Code, rec.Body.String())
	}
	mg, _ := os.ReadFile(magnetDesktopPath())
	tr, _ := os.ReadFile(torrentDesktopPath())
	if !strings.Contains(string(mg), "--magnet %u") || !strings.Contains(string(mg), "x-scheme-handler/magnet") {
		t.Errorf("magnet.desktop:\n%s", mg)
	}
	if !strings.Contains(string(tr), "--torrent %f") || !strings.Contains(string(tr), "application/x-bittorrent") {
		t.Errorf("torrent.desktop:\n%s", tr)
	}
	get := httptest.NewRecorder()
	c.apiReg(get, httptest.NewRequest("GET", "/api/reg", nil))
	var st map[string]bool
	json.Unmarshal(get.Body.Bytes(), &st)
	if !st["magnet"] || !st["torrent"] || !st["supported"] {
		t.Errorf("состояние после установки: %v", st)
	}
	// Изменение только POST'ом.
	bad := httptest.NewRecorder()
	c.apiReg(bad, httptest.NewRequest("GET", "/api/reg?action=uninstall", nil))
	if bad.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET не должен менять регистрацию: %d", bad.Code)
	}
	c.apiReg(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/reg?action=uninstall", nil))
	if m, tr := platformHandlersStatus(); m || tr {
		t.Error("после удаления обработчиков быть не должно")
	}
}

func TestLinuxAutostart(t *testing.T) {
	linuxSandbox(t)
	c := &Comp{}
	set := func(on string) map[string]any {
		rec := httptest.NewRecorder()
		c.apiAutostart(rec, httptest.NewRequest("POST", "/api/autostart", strings.NewReader(`{"enabled":`+on+`}`)))
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	if out := set("true"); out["enabled"] != true || out["supported"] != true {
		t.Fatalf("включение: %v", out)
	}
	b, _ := os.ReadFile(autostartPath())
	if !strings.Contains(string(b), "--open=false") {
		t.Errorf("автозапуск должен идти без открытия браузера:\n%s", b)
	}
	if out := set("false"); out["enabled"] != false {
		t.Fatalf("выключение: %v", out)
	}
}

func TestDetectPlayersUnixNames(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "mpv"), []byte("#!/bin/sh\n"), 0o755)
	got := detectPlayersIn([]string{dir})
	if got["mpv"] != filepath.Join(dir, "mpv") {
		t.Fatalf("mpv без .exe не найден: %v", got)
	}
}
