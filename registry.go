package main

// Регистрация обработчиков magnet и .torrent в системе и автозапуск демона.
// Общая часть — обработчики запросов. Всё, что зависит от системы, лежит в
// platform_windows.go (реестр) и platform_unix.go (файлы .desktop).

import (
	"net/http"
	"os"
)

func (c *Comp) apiReg(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	action := r.Form.Get("action") // install | uninstall
	exe, _ := os.Executable()
	// Регистрация меняет состояние системы и принимается только POST'ом.
	if action == "install" || action == "uninstall" {
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "изменение регистрации принимается только POST'ом")
			return
		}
	}
	var err error
	switch action {
	case "install":
		err = platformInstallHandlers(exe)
	case "uninstall":
		err = platformUninstallHandlers()
	default:
		magnet, torrent := platformHandlersStatus()
		jj(w, map[string]any{"magnet": magnet, "torrent": torrent, "supported": platformHandlersSupported()})
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jj(w, map[string]any{"ok": true})
}

// apiAutostart — GET: состояние, POST {"enabled":bool}: включить или выключить
// запуск демона при входе в систему (без окна и без открытия браузера).
func (c *Comp) apiAutostart(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		on, supported := platformAutostartState()
		jj(w, map[string]any{"enabled": on, "supported": supported})
	case http.MethodPost:
		var in struct {
			Enabled bool `json:"enabled"`
		}
		if err := decodeTorznabBody(w, r, &in); err != nil {
			writeJSONError(w, http.StatusBadRequest, "тело запроса не разобрано")
			return
		}
		exe, _ := os.Executable()
		if err := platformSetAutostart(exe, in.Enabled); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		on, supported := platformAutostartState()
		jj(w, map[string]any{"enabled": on, "supported": supported})
	default:
		writeJSONError(w, http.StatusMethodNotAllowed, "метод не поддерживается")
	}
}
