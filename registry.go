package main

// Регистрация обработчиков magnet и .torrent в системе.

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
)

func (c *Comp) apiReg(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	action := r.Form.Get("action") // install | uninstall
	exe, _ := os.Executable()
	// Запись в реестр меняет состояние системы и принимается только POST'ом.
	if action == "install" || action == "uninstall" {
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "изменение регистрации принимается только POST'ом")
			return
		}
	}
	if action == "install" {
		installMagnet(exe)
		installTorrentAssoc(exe)
		jj(w, map[string]any{"ok": true})
		return
	}
	if action == "uninstall" {
		uninstallMagnet()
		uninstallTorrentAssoc()
		jj(w, map[string]any{"ok": true})
		return
	}
	jj(w, map[string]any{"magnet": regKeyExists(`HKCU\Software\Classes\magnet\shell\open\command`), "torrent": regKeyExists(`HKCU\Software\Classes\TorrClient.torrent\shell\open\command`)})
}

func regExe() string {
	sys, _ := os.Getwd()
	if s := os.Getenv("SystemRoot"); s != "" {
		sys = filepath.Join(s, "System32")
	}
	return filepath.Join(sys, "reg.exe")
}

func regAdd(key string, args ...string) error {
	a := append([]string{"add", key, "/f"}, args...)
	out, err := exec.Command(regExe(), a...).CombinedOutput()
	_ = out
	return err
}

func regDel(key string) {
	exec.Command(regExe(), "delete", key, "/f").CombinedOutput()
}

func regKeyExists(key string) bool {
	_, err := exec.Command(regExe(), "query", key).CombinedOutput()
	return err == nil
}

func installMagnet(exe string) {
	base := `HKCU\Software\Classes\magnet`
	regAdd(base, `/ve`, `/d`, `URL:Magnet Protocol`)
	regAdd(base, `/v`, `URL Protocol`, `/t`, `REG_SZ`, `/d`, ``)
	regAdd(base+`\DefaultIcon`, `/ve`, `/d`, `"`+exe+`",0`)
	cmd := `"` + exe + `" --magnet "%1"`
	regAdd(base+`\shell\open\command`, `/ve`, `/d`, cmd)
}

func uninstallMagnet() {
	regDel(`HKCU\Software\Classes\magnet`)
}

func installTorrentAssoc(exe string) {
	progid := `TorrClient.torrent`
	regAdd(`HKCU\Software\Classes\.torrent\OpenWithProgids`, `/v`, progid, `/t`, `REG_NONE`, `/d`, ``)
	regAdd(`HKCU\Software\Classes\`+progid, `/ve`, `/d`, `Добавить в TorrClient`)
	regAdd(`HKCU\Software\Classes\`+progid+`\DefaultIcon`, `/ve`, `/d`, `"`+exe+`",0`)
	cmd := `"` + exe + `" --torrent "%1"`
	regAdd(`HKCU\Software\Classes\`+progid+`\shell\open\command`, `/ve`, `/d`, cmd)
}

func uninstallTorrentAssoc() {
	regDel(`HKCU\Software\Classes\TorrClient.torrent`)
}
