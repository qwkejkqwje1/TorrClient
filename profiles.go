package main

// API профилей сервера и запуск внешнего плеера.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ---------- profiles ----------

func (c *Comp) apiHello(w http.ResponseWriter, r *http.Request) {
	cfg := curCfg()
	players := []*Player{}
	for _, p := range cfg.Players {
		cp := *p
		cp.Found = findExe(cp.Path)
		players = append(players, &cp)
	}
	jj(w, map[string]any{
		"version":           version,
		"app_version":       appVersion(),
		"active_profile_id": cfg.ActiveProfileID,
		"profiles":          cfg.Profiles,
		"players":           players,
		"watch_folder":      cfg.WatchFolder,
		"download_folder":   cfg.DownloadFolder,
		"cache_folder":      cfg.CacheFolder,
		"data_folder":       cfg.DataFolder,
		"os":                "windows",
		// Папка программы нужна странице «О программе»: на диске часто лежит
		// несколько сборок, и по одному только номеру версии не поймёшь, какая
		// из них запущена.
		"exe": exeDir(),
	})
}

func (c *Comp) apiProfiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := curCfg()
		jj(w, map[string]any{
			"profiles":          cfg.Profiles,
			"active_profile_id": cfg.ActiveProfileID,
		})
	case http.MethodPost:
		raw, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		var m map[string]any
		// Ошибку разбора прежде отбрасывали: при мусоре в теле action оставался
		// пустым, и ручка отвечала «unknown action» — то есть называла не ту
		// причину и отправляла искать дефект в разборе действий.
		if err := json.Unmarshal(raw, &m); err != nil {
			writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос: "+err.Error())
			return
		}
		action, _ := m["action"].(string)
		switch action {
		case "add":
			var req struct {
				Profile *Profile `json:"profile"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
				return
			}
			if req.Profile == nil || req.Profile.URL == "" {
				http.Error(w, `{"error":"url required"}`, http.StatusBadRequest)
				return
			}
			p := req.Profile
			if p.ID == "" {
				p.ID = fmt.Sprintf("s%d", time.Now().UnixNano())
			}
			if err := updateCfg(func(nc *Config) {
				nc.Profiles = append(nc.Profiles, p)
				nc.ActiveProfileID = p.ID
			}); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
				return
			}
			jj(w, map[string]any{"ok": true, "id": p.ID})
		case "set":
			var req struct {
				Profile *Profile `json:"profile"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
				return
			}
			if req.Profile != nil {
				np := *req.Profile
				if err := updateCfg(func(nc *Config) {
					for i, p := range nc.Profiles {
						if p.ID == np.ID {
							nc.Profiles[i] = &np
							break
						}
					}
				}); err != nil {
					writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
					return
				}
			}
			jj(w, map[string]any{"ok": true})
		case "del":
			id, _ := m["id"].(string)
			if err := updateCfg(func(nc *Config) {
				idx := -1
				for i, p := range nc.Profiles {
					if p.ID == id {
						idx = i
						break
					}
				}
				if idx >= 0 {
					nc.Profiles = append(nc.Profiles[:idx], nc.Profiles[idx+1:]...)
					if nc.ActiveProfileID == id {
						if len(nc.Profiles) > 0 {
							nc.ActiveProfileID = nc.Profiles[0].ID
						} else {
							nc.ActiveProfileID = ""
						}
					}
				}
			}); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
				return
			}
			jj(w, map[string]any{"ok": true})
		case "active":
			id, _ := m["id"].(string)
			if err := updateCfg(func(nc *Config) {
				for _, p := range nc.Profiles {
					if p.ID == id {
						nc.ActiveProfileID = p.ID
						break
					}
				}
			}); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
				return
			}
			jj(w, map[string]any{"ok": true})
		case "dirs":
			var d struct {
				WatchFolder    string `json:"watch_folder"`
				DownloadFolder string `json:"download_folder"`
				CacheFolder    string `json:"cache_folder"`
				DataFolder     string `json:"data_folder"`
			}
			if err := json.Unmarshal(raw, &d); err != nil {
				writeJSONError(w, http.StatusBadRequest, "неразборчивый запрос")
				return
			}
			before := curCfg().DataFolder
			if err := updateCfg(func(nc *Config) {
				if d.WatchFolder != "" {
					nc.WatchFolder = d.WatchFolder
				}
				if d.DownloadFolder != "" {
					nc.DownloadFolder = d.DownloadFolder
				}
				if d.CacheFolder != "" {
					nc.CacheFolder = d.CacheFolder
				}
				if d.DataFolder != "" {
					nc.DataFolder = d.DataFolder
				}
			}); err != nil {
				writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
				return
			}
			nc := curCfg()
			for _, p := range []string{nc.WatchFolder, nc.DownloadFolder, nc.CacheFolder, nc.DataFolder} {
				os.MkdirAll(p, 0o755)
			}
			if c.watch != nil {
				c.watch.SetFolder(nc.WatchFolder)
			}
			if c.dl != nil {
				c.dl.SetFolder(nc.DownloadFolder)
			}
			// Смена папки постоянных данных переносит накопленное. Без переноса
			// смена пути выглядела бы как «всё пропало»: файлы остались в
			// прежней папке, а читаются уже из новой — то есть пустой.
			//
			// subscriptions.json переносится тем же списком, а перечитывается
			// отдельно: подписки читаются один раз при запуске, и без этого
			// после смены папки список указывал бы на новую, где файла нет, —
			// то есть выглядел бы пустым до следующего перезапуска.
			moved := moveStateFiles(absToExe(before), nc.DataFolder, "viewed.json", "userdata.json", "subscriptions.json")
			if len(moved) > 0 {
				viewedMarks.load()
				loadUserDataStore()
				loadSubs()
				logMsg("  Постоянные данные перенесены: %s", strings.Join(moved, ", "))
			}
			jj(w, map[string]any{"ok": true, "moved": moved})
		default:
			http.Error(w, `{"error":"unknown action"}`, http.StatusBadRequest)
		}
	default:
		// Без этой ветки PUT, DELETE и прочие методы проваливались мимо switch:
		// обработчик ничего не писал, и net/http отвечал 200 с пустым телом —
		// «получилось», хотя не делалось ничего.
		writeJSONError(w, http.StatusMethodNotAllowed, "метод не поддерживается")
	}
}

func (c *Comp) apiPlayer(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/player/")
	if action == "list" {
		cfg := curCfg()
		out := []*Player{}
		for _, p := range cfg.Players {
			cp := *p
			cp.Found = findExe(cp.Path)
			out = append(out, &cp)
		}
		jj(w, out)
		return
	}
	if r.Method == http.MethodPost && action == "save" {
		var players []*Player
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&players); err != nil {
			writeJSONError(w, http.StatusBadRequest, "неразборчивый список плееров")
			return
		}
		if err := updateCfg(func(nc *Config) { nc.Players = players }); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
			return
		}
		jj(w, map[string]any{"ok": true})
		return
	}
	if r.Method == http.MethodPost && action == "scan" {
		roots := playerRoots()
		// scanPlayersInto возвращает список найденных плееров, а updateCfg ждёт
		// функцию без результата: обёртка отбрасывает возврат, а список берётся
		// из опубликованного снимка ниже.
		if err := updateCfg(func(nc *Config) { scanPlayersInto(nc) }); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "конфиг не сохранён: "+err.Error())
			return
		}
		nc := curCfg()
		out := []*Player{}
		for _, p := range nc.Players {
			cp := *p
			cp.Found = findExe(cp.Path)
			out = append(out, &cp)
		}
		// Папки, где искали, отдаются интерфейсу: без них кнопка «Автообнаружение»
		// молчит одинаково и когда плееров нет, и когда искала не там.
		jj(w, map[string]any{"ok": true, "players": out, "roots": roots})
		return
	}
	if action == "launch" {
		// Запуск плеера меняет состояние машины и принимается только POST'ом:
		// GET-адрес с чужой страницы могла бы дёрнуть даже картинка.
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "запуск плеера принимается только POST'ом")
			return
		}
		r.ParseForm()
		key := r.Form.Get("player")
		url := r.Form.Get("url")
		title := r.Form.Get("title")
		hash := strings.TrimSpace(r.Form.Get("hash"))
		index := atoiSafe(r.Form.Get("index"))
		if url == "" && hash == "" {
			http.Error(w, `{"error":"url empty"}`, http.StatusBadRequest)
			return
		}
		// Адрес уходит в командную строку плеера или в обработчик протокола
		// браузера: разрешены только http(s) без кавычек и управляющих знаков —
		// кавычка сломала бы разбор аргументов (splitCmdline считает её
		// границей), а file:// превратил бы запуск в открытие чего угодно.
		if url != "" && !isHTTPLink(url) {
			writeJSONError(w, http.StatusBadRequest, "недопустимый адрес: нужен http(s)")
			return
		}
		if key == "browser" {
			if url == "" {
				http.Error(w, `{"error":"url empty"}`, http.StatusBadRequest)
				return
			}
			openBrowser(url)
			jj(w, map[string]any{"ok": true, "mode": "browser"})
			return
		}
		cfg := curCfg()
		for _, p := range cfg.Players {
			if p.Key != key {
				continue
			}
			if p.Path == "" || !findExe(p.Path) {
				http.Error(w, `{"error":"player not found"}`, http.StatusNotFound)
				return
			}
			// Раздачу отдаём плееру плейлистом, а не ссылкой на один файл: одна
			// ссылка на поток — это одна серия, и списка серий у плеера не будет
			// вовсе.
			url, mode := c.launchURL(r, hash, title, url, index)
			cmdLine := strings.ReplaceAll(p.Args, "{url}", url)
			cmdLine = strings.ReplaceAll(cmdLine, "{path}", `"`+p.Path+`"`)
			cmdLine = strings.ReplaceAll(cmdLine, "{title}", argSafe(title))
			args := splitCmdline(cmdLine)
			resume, watching, err := c.startPlayer(p, args, hash, index, resumeOf(hash, index))
			if err != nil {
				writeJSONError(w, http.StatusBadGateway, "плеер не запустился: "+err.Error())
				return
			}
			jj(w, map[string]any{
				"ok":       true,
				"mode":     "player",
				"exec":     p.Path,
				"url_mode": mode,
				"resume":   resume,
				"watching": watching,
			})
			return
		}
		http.Error(w, `{"error":"unknown player"}`, http.StatusNotFound)
		return
	}
	http.Error(w, "unknown", http.StatusNotFound)
}

func splitCmdline(s string) []string {
	var out []string
	var cur strings.Builder
	inQ := false
	for _, r := range s {
		switch r {
		case '"':
			inQ = !inQ
		case ' ', '\t', '\r', '\n':
			if !inQ {
				if cur.Len() > 0 {
					out = append(out, cur.String())
					cur.Reset()
				}
				continue
			}
			cur.WriteRune(r)
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}
