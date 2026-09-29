//go:build windows

package main

// Windows: реестр, открытие ссылок, автозапуск. Правится только здесь.

import (
	"os"
	"os/exec"
	"path/filepath"
)

const autostartRunKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

func platformOpenURL(rawurl string) {
	exec.Command(`rundll32`, `url.dll,FileProtocolHandler`, rawurl).Start()
}

func platformHandlersSupported() bool { return true }

func platformHandlersStatus() (magnet, torrent bool) {
	return regKeyExists(`HKCU\Software\Classes\magnet\shell\open\command`),
		regKeyExists(`HKCU\Software\Classes\TorrClient.torrent\shell\open\command`)
}

func platformInstallHandlers(exe string) error {
	installMagnet(exe)
	installTorrentAssoc(exe)
	return nil
}

func platformUninstallHandlers() error {
	uninstallMagnet()
	uninstallTorrentAssoc()
	return nil
}

func platformAutostartState() (enabled, supported bool) {
	return regKeyValueExists(autostartRunKey, "TorrClient"), true
}

func platformSetAutostart(exe string, on bool) error {
	if !on {
		exec.Command(regExe(), "delete", autostartRunKey, "/v", "TorrClient", "/f").CombinedOutput()
		return nil
	}
	return regAdd(autostartRunKey, "/v", "TorrClient", "/t", "REG_SZ", "/d", `"`+exe+`" --open=false`)
}

func unixPlayerDirs() []string { return nil }

func regExe() string {
	sys, _ := os.Getwd()
	if s := os.Getenv("SystemRoot"); s != "" {
		sys = filepath.Join(s, "System32")
	}
	return filepath.Join(sys, "reg.exe")
}

func regAdd(key string, args ...string) error {
	a := append([]string{"add", key, "/f"}, args...)
	_, err := exec.Command(regExe(), a...).CombinedOutput()
	return err
}

func regDel(key string) {
	exec.Command(regExe(), "delete", key, "/f").CombinedOutput()
}

func regKeyExists(key string) bool {
	_, err := exec.Command(regExe(), "query", key).CombinedOutput()
	return err == nil
}

func regKeyValueExists(key, name string) bool {
	_, err := exec.Command(regExe(), "query", key, "/v", name).CombinedOutput()
	return err == nil
}

// regQueryString читает значение из реестра. Нужен только как запасной путь
// поиска плееров: сначала плееры ищутся по файлам.
func regQueryString(key, val string) string {
	args := []string{"query", key}
	if val != "" {
		args = append(args, "/v", val)
	}
	out, err := exec.Command(regExe(), args...).CombinedOutput()
	if err != nil {
		return ""
	}
	return parseRegQuery(string(out), val)
}

func installMagnet(exe string) {
	base := `HKCU\Software\Classes\magnet`
	regAdd(base, `/ve`, `/d`, `URL:Magnet Protocol`)
	regAdd(base, `/v`, `URL Protocol`, `/t`, `REG_SZ`, `/d`, ``)
	regAdd(base+`\DefaultIcon`, `/ve`, `/d`, `"`+exe+`",0`)
	regAdd(base+`\shell\open\command`, `/ve`, `/d`, `"`+exe+`" --magnet "%1"`)
}

func uninstallMagnet() {
	regDel(`HKCU\Software\Classes\magnet`)
}

func installTorrentAssoc(exe string) {
	progid := `TorrClient.torrent`
	regAdd(`HKCU\Software\Classes\.torrent\OpenWithProgids`, `/v`, progid, `/t`, `REG_NONE`, `/d`, ``)
	regAdd(`HKCU\Software\Classes\`+progid, `/ve`, `/d`, `Добавить в TorrClient`)
	regAdd(`HKCU\Software\Classes\`+progid+`\DefaultIcon`, `/ve`, `/d`, `"`+exe+`",0`)
	regAdd(`HKCU\Software\Classes\`+progid+`\shell\open\command`, `/ve`, `/d`, `"`+exe+`" --torrent "%1"`)
}

func uninstallTorrentAssoc() {
	regDel(`HKCU\Software\Classes\TorrClient.torrent`)
}
