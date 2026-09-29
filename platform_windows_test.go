//go:build windows

package main

import (
	"strings"
	"testing"
)

// Настоящий реестр, но своя ветка: ассоциации magnet/.torrent и автозапуск
// пользователя, запустившего go test, не трогаются.
func withTestRegistry(t *testing.T) {
	t.Helper()
	oldC, oldR := regClasses, autostartRunKey
	root := `HKCU\Software\TorrClientTest`
	regClasses, autostartRunKey = root+`\Classes`, root+`\Run`
	t.Cleanup(func() {
		regDel(root)
		regClasses, autostartRunKey = oldC, oldR
	})
}

func TestWindowsHandlersInstallAndUninstall(t *testing.T) {
	withTestRegistry(t)
	exe := `C:\Program Files\TorrClient\torrclient.exe`
	if err := platformInstallHandlers(exe); err != nil {
		t.Fatalf("регистрация: %v", err)
	}
	if m, tr := platformHandlersStatus(); !m || !tr {
		t.Fatalf("после регистрации magnet=%v torrent=%v", m, tr)
	}
	cmd := regQueryString(regClasses+`\magnet\shell\open\command`, "")
	if !strings.Contains(cmd, `"`+exe+`" --magnet "%1"`) {
		t.Fatalf("команда magnet: %q", cmd)
	}
	if err := platformUninstallHandlers(); err != nil {
		t.Fatal(err)
	}
	if m, tr := platformHandlersStatus(); m || tr {
		t.Fatalf("после удаления magnet=%v torrent=%v", m, tr)
	}
}

func TestWindowsAutostartOnOff(t *testing.T) {
	withTestRegistry(t)
	exe := `C:\TC\torrclient.exe`
	if err := platformSetAutostart(exe, true); err != nil {
		t.Fatal(err)
	}
	if on, ok := platformAutostartState(); !on || !ok {
		t.Fatalf("автозапуск не включился: on=%v supported=%v", on, ok)
	}
	if v := regQueryString(autostartRunKey, "TorrClient"); v != `"`+exe+`" --open=false` {
		t.Fatalf("команда автозапуска: %q", v)
	}
	platformSetAutostart(exe, false)
	if on, _ := platformAutostartState(); on {
		t.Fatal("автозапуск не выключился")
	}
}
