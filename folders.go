package main

// Доступность папок загрузок и наблюдения.
//
// Путь на несуществующем диске выглядит в настройках совершенно правильным, но
// закачки в него не сохраняются, а наблюдатель молча ничего не видит: os.MkdirAll
// возвращает ошибку, которую никто не читает. Поэтому состояние папок проверяется
// отдельно и показывается в интерфейсе — вместе с предложением взять папки рядом
// с программой.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// folderState — состояние одной папки. Reason заполняется только при отказе:
// он уходит прямо в интерфейс, поэтому должен быть понятен без контекста.
type folderState struct {
	Path   string `json:"path"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

// checkFolder проверяет, что папку можно создать и что в неё можно писать.
// Проверка настоящая: одного os.Stat мало — каталог может быть доступен только
// для чтения, а диск может отключиться уже после создания папки.
func checkFolder(path string) folderState {
	st := folderState{Path: path}
	if strings.TrimSpace(path) == "" {
		st.Reason = "путь не задан"
		return st
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		st.Reason = err.Error()
		return st
	}
	f, err := os.CreateTemp(path, ".tc-write-check-*")
	if err != nil {
		st.Reason = err.Error()
		return st
	}
	name := f.Name()
	f.Close()
	// Не убралось — не беда: запись уже проверена, а имя своё и временное.
	os.Remove(name)
	st.OK = true
	return st
}

// defaultWatchFolder и defaultDownloadsFolder — папки рядом с программой. Те же
// значения стоят в конфиге по умолчанию; интерфейс предлагает их, когда
// заданный путь недоступен.
func defaultWatchFolder() string     { return filepath.Join(exeDir(), "watch") }
func defaultDownloadsFolder() string { return filepath.Join(exeDir(), "downloads") }

// defaultCacheFolder и defaultDataFolder — каталог программы: кэш и постоянные
// данные лежат в нём с самого начала, и предлагать при отказе нужно ровно его,
// а не выдуманный подкаталог, которого в прежних сборках не было.
func defaultCacheFolder() string { return exeDir() }
func defaultDataFolder() string  { return exeDir() }

// folderProblems превращает состояния папок в строки для журнала. Отдельной
// функцией, а не прямо в main: строка о недоступной папке — это то, по чему
// потом ищут причину, и её стоит проверять, а не надеяться на глаз.
func folderProblems(states ...folderState) []string {
	var out []string
	for _, st := range states {
		if st.OK {
			continue
		}
		where := st.Path
		if strings.TrimSpace(where) == "" {
			where = "(путь не задан)"
		}
		out = append(out, "папка недоступна — "+where+": "+st.Reason)
	}
	return out
}

// apiFolders отвечает, доступны ли папки, и заодно отдаёт пути по умолчанию —
// чтобы предложение «взять папки рядом с программой» не собиралось на стороне
// интерфейса из догадок.
//
// Кэш и постоянные данные проверяются наравне с папками загрузок: путь на
// очищаемом диске выглядит в настройках правильным, а кэш в него не пишется —
// и без этой проверки о причине узнают по пустым постерам, а не по настройке.
func (c *Comp) apiFolders(w http.ResponseWriter, r *http.Request) {
	cfg := curCfg()
	if cfg == nil {
		writeJSONError(w, http.StatusInternalServerError, "конфиг не загружен")
		return
	}
	jj(w, map[string]any{
		"watch":             checkFolder(cfg.WatchFolder),
		"downloads":         checkFolder(cfg.DownloadFolder),
		"cache":             checkFolder(cfg.CacheFolder),
		"data":              checkFolder(cfg.DataFolder),
		"default_watch":     defaultWatchFolder(),
		"default_downloads": defaultDownloadsFolder(),
		"default_cache":     defaultCacheFolder(),
		"default_data":      defaultDataFolder(),
	})
}
