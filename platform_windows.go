//go:build windows

package main

// Windows: реестр, открытие ссылок, автозапуск. Правится только здесь.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Корни ключей — переменные, а не константы: тест подменяет их на свою ветку
// HKCU\Software\TorrClientTest, чтобы не трогать настоящие ассоциации.
var (
	autostartRunKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	regClasses      = `HKCU\Software\Classes`
)

func platformOpenURL(rawurl string) {
	exec.Command(`rundll32`, `url.dll,FileProtocolHandler`, rawurl).Start()
}

func platformHandlersSupported() bool { return true }

func platformHandlersStatus() (magnet, torrent bool) {
	return regKeyExists(regClasses + `\magnet\shell\open\command`),
		regKeyExists(regClasses + `\TorrClient.torrent\shell\open\command`)
}

func platformInstallHandlers(exe string) error {
	if err := installMagnet(exe); err != nil {
		return fmt.Errorf("magnet: %v", err)
	}
	if err := installTorrentAssoc(exe); err != nil {
		return fmt.Errorf(".torrent: %v", err)
	}
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
	return regAdd(autostartRunKey, "/v", "TorrClient", "/t", "REG_SZ", "/d", autostartCommand(exe))
}

// autostartCommand — что запускать при входе в систему. Если рядом лежит окно
// программы, запускается оно — сразу в лоток (--tray): у голого демона нет
// иконки в лотке, и после входа программу было не найти. Окно поднимает демон
// само. Без окна — демон, как раньше.
func autostartCommand(exe string) string {
	desk := filepath.Join(filepath.Dir(exe), "TorrClientDesktop.exe")
	if st, err := os.Stat(desk); err == nil && !st.IsDir() {
		return `"` + desk + `" --tray`
	}
	return `"` + exe + `" --open=false`
}

// migrateAutostart переводит старую запись автозапуска (голый демон) на окно
// с лотком, если окно лежит рядом. Трогает только свою запись и только если она
// уже включена: включать автозапуск за пользователя нельзя.
func migrateAutostart(exe string) {
	cur := regQueryString(autostartRunKey, "TorrClient")
	if cur == "" || strings.Contains(cur, "--tray") {
		return
	}
	if want := autostartCommand(exe); want != cur && strings.Contains(want, "--tray") {
		_ = regAdd(autostartRunKey, "/v", "TorrClient", "/t", "REG_SZ", "/d", want)
	}
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

// firstErr возвращает первую ошибку: запись в реестр идёт пачкой, и отказ
// раньше терялся — кнопка «Зарегистрировать» отвечала «готово» впустую.
func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

func installMagnet(exe string) error {
	base := regClasses + `\magnet`
	return firstErr(
		regAdd(base, `/ve`, `/d`, `URL:Magnet Protocol`),
		regAdd(base, `/v`, `URL Protocol`, `/t`, `REG_SZ`, `/d`, ``),
		regAdd(base+`\DefaultIcon`, `/ve`, `/d`, `"`+exe+`",0`),
		regAdd(base+`\shell\open\command`, `/ve`, `/d`, `"`+exe+`" --magnet "%1"`),
	)
}

func uninstallMagnet() {
	regDel(regClasses + `\magnet`)
}

func installTorrentAssoc(exe string) error {
	progid := `TorrClient.torrent`
	return firstErr(
		regAdd(regClasses+`\.torrent\OpenWithProgids`, `/v`, progid, `/t`, `REG_NONE`, `/d`, ``),
		regAdd(regClasses+`\`+progid, `/ve`, `/d`, `Добавить в TorrClient`),
		regAdd(regClasses+`\`+progid+`\DefaultIcon`, `/ve`, `/d`, `"`+exe+`",0`),
		regAdd(regClasses+`\`+progid+`\shell\open\command`, `/ve`, `/d`, `"`+exe+`" --torrent "%1"`),
	)
}

func uninstallTorrentAssoc() {
	regDel(regClasses + `\TorrClient.torrent`)
}
