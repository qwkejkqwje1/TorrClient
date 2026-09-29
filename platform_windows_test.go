//go:build windows

package main

import (
	"os/exec"
	"strings"
	"testing"
)

// regRaw — сырой вывод reg query: parseRegQuery снимает внешние кавычки
// (он для путей плееров), а здесь проверяется команда целиком, с кавычками.
func regRaw(t *testing.T, key string, args ...string) string {
	t.Helper()
	out, err := exec.Command(regExe(), append([]string{"query", key}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("reg query %s: %v\n%s", key, err, out)
	}
	return string(out)
}

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
	cmd := regRaw(t, regClasses+`\magnet\shell\open\command`, "/ve")
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
	if v := regRaw(t, autostartRunKey, "/v", "TorrClient"); !strings.Contains(v, `"`+exe+`" --open=false`) {
		t.Fatalf("команда автозапуска: %q", v)
	}
	platformSetAutostart(exe, false)
	if on, _ := platformAutostartState(); on {
		t.Fatal("автозапуск не выключился")
	}
}
