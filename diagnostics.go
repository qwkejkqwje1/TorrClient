package main

// Сбор отчёта о состоянии установки.
//
// Зачем он нужен. По отдельности всё это уже есть — папки проверяются в
// /api/folders, версия и плееры в /api/hello, регистрация в /api/reg. Но
// «что-то сломалось» почти всегда означает сразу несколько причин, и собирать
// их по одной через четыре разных экрана — это работа для того, у кого сломалось.
// Отчёт собирает всё разом и кладёт в буфер обмена, чтобы его можно было
// приложить к письму.
//
// Секретов в отчёте нет: ключ TMDB и пароли профилей не попадают в него
// намеренно (см. backupSecrets) — отчёт предназначен для пересылки, а пароль от
// раздачи в письме не нужен.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ---------- чистые функции (покрываются тестами без диска и сети) ----------

// normPath приводит путь к сравнимому виду: обрезает пробелы, убирает хвостовой
// разделитель и переводит буквы в нижний регистр.
//
// Регистр важен: на Windows «C:\Данные» и «c:\данные» — одна папка, но строки
// разные, и проверка «совпадают ли папки» решила бы, что это разные места.
func normPath(p string) string {
	s := strings.TrimSpace(p)
	if s == "" {
		return ""
	}
	s = strings.ToLower(s)
	// Хвостовой разделитель убирается, но не у корня: «C:\» станет «C:» и уже
	// не совпадёт сам с собой.
	for len(s) > 3 && (strings.HasSuffix(s, `\`) || strings.HasSuffix(s, "/")) {
		s = s[:len(s)-1]
	}
	return s
}

// sameFolder — одна ли это папка. Сравнение идёт по нормализованным путям, а не
// по строкам: иначе одинаково выглядящие пути считались бы разными, и смысл
// проверки пропал бы.
func sameFolder(a, b string) bool {
	na, nb := normPath(a), normPath(b)
	return na != "" && na == nb
}

// splitKeyValue разбирает строку «ключ=значение» в пару. Нужен для вывода
// настроек TorrServer, которые приходят именно в таком виде.
func splitKeyValue(s string) (string, string) {
	if i := strings.Index(s, "="); i >= 0 {
		return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i+1:])
	}
	return strings.TrimSpace(s), ""
}

// reportProblem — одна строка отчёта о том, что требует внимания.
//
// Отдельным типом, а не просто строкой, потому что такие строки собираются в
// трёх местах и должны выглядеть одинаково: иначе по отчёту нельзя понять, где
// проблема, а где просто сведения.
type reportProblem struct {
	Where  string `json:"where"`
	Reason string `json:"reason"`
}

// diagFolder — состояние папки в отчёте. Size и Files заполняются best-effort:
// отказ их посчитать не делает папку недоступной, поэтому они не влияют на OK.
type diagFolder struct {
	Path   string `json:"path"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	Exists bool   `json:"exists"`
	Files  int    `json:"files"`
	Size   int64  `json:"size"`
}

// diagServer — доступность сервера из профилей.
type diagServer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Active  bool   `json:"active"`
	OK      bool   `json:"ok"`
	Reason  string `json:"reason,omitempty"`
	Version string `json:"version,omitempty"`
}

// diagStateFile — состояние одного файла состояния. Отсутствие файла — не
// ошибка (значит, его ещё не создавали), поэтому отдельно отмечается только
// нечитаемый файл: вот это уже потеря данных.
type diagStateFile struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	OK     bool   `json:"ok"`
	Exists bool   `json:"exists"`
	Size   int64  `json:"size"`
	Reason string `json:"reason,omitempty"`
}

// report — полный отчёт. Поля верхнего уровня и есть разделы, которые увидит
// пользователь.
type report struct {
	Version  string                `json:"version"`
	OS       string                `json:"os"`
	Exe      string                `json:"exe"`
	Started  string                `json:"started"`
	Servers  []diagServer          `json:"servers"`
	Folders  map[string]diagFolder `json:"folders"`
	State    []diagStateFile       `json:"state_files"`
	WatchOK  bool                  `json:"watch_ok"`
	WatchWhy string                `json:"watch_reason,omitempty"`
	Problems []reportProblem       `json:"problems"`
}

// ---------- диск и сеть ----------

// dirStats считает файлы и байты в папке. Ошибки не поднимаются: у отчёта нет
// смысла падать из-за того, что не удалось обойти дерево, — вместо этого Files
// и Size останутся нулевыми, а папка будет отмечена отдельно.
func dirStats(path string) (files int, size int64) {
	if strings.TrimSpace(path) == "" {
		return 0, 0
	}
	filepath.WalkDir(path, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			// Не заходим глубже в недоступное поддерево, но и не отменяем обход:
			// частичный счёт полезнее нулевого.
			return nil
		}
		if d.IsDir() {
			return nil
		}
		files++
		if info, err := d.Info(); err == nil {
			size += info.Size()
		}
		return nil
	})
	return files, size
}

// probeServer проверяет сервер из профиля запросом /echo. Отдельный таймаут
// короткий: отчёт собирают, когда что-то не работает, и ждать там 30 секунд
// недопустимо.
func probeServer(p *Profile) (ok bool, reason, ver string) {
	if p == nil || strings.TrimSpace(p.URL) == "" {
		return false, "адрес не задан", ""
	}
	cl := &http.Client{Timeout: 3 * time.Second}
	resp, err := cl.Get(strings.TrimRight(p.URL, "/") + "/echo")
	if err != nil {
		return false, err.Error(), ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Sprintf("HTTP %d", resp.StatusCode), ""
	}
	// Тело не разбирается целиком: версия — приятное дополнение, а не повод
	// отказывать в отчёте из-за неожиданного формата.
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	_, ver = splitKeyValue(string(buf[:n]))
	return true, "", strings.Trim(ver, "\r\n\"")
}

// stateFileReport описывает один файл состояния.
func stateFileReport(name string) diagStateFile {
	st := diagStateFile{Name: name, OK: true, Path: stateFilePath(name)}
	info, err := os.Stat(st.Path)
	if err != nil {
		if os.IsNotExist(err) {
			// Файла нет — это нормально, а не поломка: на свежей установке его
			// ещё не создавали.
			return diagStateFile{Name: name, OK: true, Exists: false}
		}
		return diagStateFile{Name: name, OK: false, Reason: err.Error()}
	}
	st.Exists = true
	st.Size = info.Size()
	return st
}

// collectReport собирает отчёт. Вынесено отдельно от apiDiagnostics, чтобы
// проверять можно было отчёт, а не ручку.
func collectReport(cfg *Config, watchOK bool, watchWhy string) *report {
	rep := &report{
		Version: version,
		OS:      runtime.GOOS + "/" + runtime.GOARCH,
		Exe:     exeDir(),
		Started: time.Now().Format("2006-01-02 15:04:05"),
		Folders: map[string]diagFolder{},
	}

	// ---------- папки ----------
	paths := map[string]string{
		"watch":     cfg.WatchFolder,
		"downloads": cfg.DownloadFolder,
		"cache":     cfg.CacheFolder,
		"data":      cfg.DataFolder,
	}
	for key, p := range paths {
		st := checkFolder(p)
		d := diagFolder{Path: p, OK: st.OK, Reason: st.Reason}
		if st.OK {
			d.Exists = true
			d.Files, d.Size = dirStats(p)
		}
		rep.Folders[key] = d
		if !st.OK {
			rep.Problems = append(rep.Problems, reportProblem{Where: "папка " + key, Reason: st.Reason})
		}
	}

	// Кэш и постоянные данные в одной папке — самый дорогой вид поломки из
	// возможных: папку кэша принято указывать на очищаемый диск, и вместе с ней
	// уезжают подписки и отметки просмотра, которые заново не собрать.
	if sameFolder(cfg.CacheFolder, cfg.DataFolder) {
		rep.Problems = append(rep.Problems, reportProblem{
			Where:  "кэш и данные",
			Reason: "оба пути совпадают: очистка кэша удалит подписки и отметки просмотра",
		})
	}

	// ---------- серверы ----------
	rep.WatchOK, rep.WatchWhy = watchOK, watchWhy
	for _, p := range cfg.Profiles {
		ok, reason, ver := probeServer(p)
		ds := diagServer{URL: p.URL, OK: ok, Reason: reason, Version: ver, Active: p.ID == cfg.ActiveProfileID}
		if p != nil {
			ds.ID, ds.Name = p.ID, p.Name
		}
		rep.Servers = append(rep.Servers, ds)
		if !ok {
			rep.Problems = append(rep.Problems, reportProblem{Where: "сервер " + p.Name, Reason: reason})
		}
	}
	if !watchOK {
		rep.Problems = append(rep.Problems, reportProblem{Where: "наблюдение", Reason: watchWhy})
	}

	// ---------- файлы состояния ----------
	for _, name := range backupFiles {
		rep.State = append(rep.State, stateFileReport(name))
	}

	return rep
}

// textLines собирает отчёт в текст для буфера обмена и файла. Формат —
// «ключ: значение» и заголовки, потому что это читается и в блокноте, и в
// письме, тогда как JSON требует разбирать.
func (r *report) textLines() []string {
	var out []string
	out = append(out, "TorrClient "+r.Version, "Собрано: "+r.Started, "Система: "+r.OS, "Папка программы: "+r.Exe, "")

	out = append(out, "-- Серверы --")
	if len(r.Servers) == 0 {
		out = append(out, "  не заданы")
	}
	for _, s := range r.Servers {
		mark := "  "
		if s.Active {
			mark = " *"
		}
		line := mark + s.Name + " (" + s.URL + "): "
		if s.OK {
			line += "отвечает"
			if s.Version != "" {
				line += ", версия " + s.Version
			}
		} else {
			line += "НЕ ОТВЕЧАЕТ — " + s.Reason
		}
		out = append(out, line)
	}
	out = append(out, "")

	out = append(out, "-- Папки --")
	for _, key := range []string{"watch", "downloads", "cache", "data"} {
		f := r.Folders[key]
		status := "доступна"
		if !f.OK {
			status = "НЕДОСТУПНА — " + f.Reason
		} else {
			status = fmt.Sprintf("доступна, файлов %d, %.1f МБ", f.Files, float64(f.Size)/1048576)
		}
		out = append(out, "  "+key+": "+f.Path+" — "+status)
	}
	out = append(out, "")

	out = append(out, "-- Файлы состояния --")
	for _, s := range r.State {
		switch {
		case !s.OK:
			out = append(out, "  "+s.Name+": НЕ ЧИТАЕТСЯ — "+s.Reason)
		case !s.Exists:
			out = append(out, "  "+s.Name+": ещё не создан")
		default:
			out = append(out, fmt.Sprintf("  %s: %d байт", s.Name, s.Size))
		}
	}
	out = append(out, "")

	if len(r.Problems) == 0 {
		out = append(out, "Замечаний нет.")
	} else {
		out = append(out, "-- Замечания --")
		for _, p := range r.Problems {
			out = append(out, "  "+p.Where+": "+p.Reason)
		}
	}
	return out
}

// Text — отчёт целиком, одной строкой разделов.
func (r *report) Text() string { return strings.Join(r.textLines(), "\n") }

// apiDiagnostics отдаёт отчёт. Формат выбирается по ?format=text: в буфер
// обмена нужен читаемый текст, а разбирать JSON вручную при отладке неудобно.
func (c *Comp) apiDiagnostics(w http.ResponseWriter, r *http.Request) {
	cfg := curCfg()
	if cfg == nil {
		writeJSONError(w, http.StatusInternalServerError, "конфиг не загружен")
		return
	}
	watchOK, watchWhy := true, ""
	if c.watch != nil {
		if why := c.watch.LastError(); why != "" {
			watchOK, watchWhy = false, why
		}
	}
	rep := collectReport(cfg, watchOK, watchWhy)
	if r.URL.Query().Get("format") == "text" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, rep.Text())
		return
	}
	b, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "не собралось: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(b)
}
