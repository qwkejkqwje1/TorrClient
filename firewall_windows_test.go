//go:build windows

package main

import (
	"strings"
	"testing"
)

// Запрет, который Windows завела после «Отмены», снимается, и разрешаются и
// программа, и порт — для всех профилей сети.
func TestFirewallCommands(t *testing.T) {
	c := firewallCommands(`C:\Program Files\TorrClient\torrclient.exe`, 8100)
	for _, want := range []string{
		`delete rule name=all dir=in program="C:\Program Files\TorrClient\torrclient.exe"`,
		`localport=8100 profile=any`,
		`action=allow program="C:\Program Files\TorrClient\torrclient.exe" profile=any`,
	} {
		if !strings.Contains(c, want) {
			t.Errorf("нет %q в %q", want, c)
		}
	}
	if strings.HasPrefix(c, `"`) {
		t.Error("команда начинается с кавычки — cmd /c срежет её")
	}
}
