package main

// Проверки доступности папок: путь на отключённом диске или под файлом выглядит
// в настройках правильным, но писать в него нельзя. Приложение должно это
// замечать и говорить вслух, а не молча терять закачки.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Рабочая папка проходит проверку и остаётся после неё чистой: проверка пишет
// временный файл и убирает его за собой.
func TestCheckFolderAcceptsWritableDir(t *testing.T) {
	dir := t.TempDir()
	st := checkFolder(dir)
	if !st.OK {
		t.Fatalf("рабочая папка признана недоступной: %q", st.Reason)
	}
	if st.Reason != "" {
		t.Errorf("у доступной папки осталась причина отказа: %q", st.Reason)
	}
	if st.Path != dir {
		t.Errorf("путь в ответе %q, ожидался %q", st.Path, dir)
	}
	left, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("папка не читается: %v", err)
	}
	if len(left) != 0 {
		t.Errorf("проверка оставила после себя %d файлов", len(left))
	}
}

// Пустой путь — это отказ, а не «папка по умолчанию»: подставлять её молча
// означало бы сохранять закачки не туда, куда просили.
func TestCheckFolderRejectsEmptyPath(t *testing.T) {
	for _, p := range []string{"", "   "} {
		st := checkFolder(p)
		if st.OK {
			t.Errorf("пустой путь %q признан доступным", p)
		}
		if st.Reason == "" {
			t.Errorf("пустой путь %q: причина отказа не названа", p)
		}
	}
}

// Под файлом папку не создать — это надёжный переносимый отказ, в отличие от
// пути на несуществующем диске, который зависит от машины.
func TestCheckFolderRejectsPathUnderFile(t *testing.T) {
	base := t.TempDir()
	file := filepath.Join(base, "не-папка")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("подготовка: %v", err)
	}
	st := checkFolder(filepath.Join(file, "внутри"))
	if st.OK {
		t.Fatal("путь под файлом признан доступной папкой")
	}
	if st.Reason == "" {
		t.Error("причина отказа не названа — в интерфейсе будет пустое место")
	}
}

// Строка для журнала должна называть и путь, и причину: по ней потом ищут, что
// именно случилось. О рабочей папке не говорится ничего — иначе предупреждение
// висело бы и на исправных настройках.
func TestFolderProblemsNamesPathAndReason(t *testing.T) {
	good := folderState{Path: t.TempDir(), OK: true}
	if got := folderProblems(good); len(got) != 0 {
		t.Errorf("о рабочей папке сказано лишнее: %v", got)
	}

	got := folderProblems(good, folderState{
		Path:   `D:\TorrClientPortable\watch`,
		Reason: "диск не найден",
	})
	if len(got) != 1 {
		t.Fatalf("строк %d, ожидалась 1: %v", len(got), got)
	}
	if !strings.Contains(got[0], `D:\TorrClientPortable\watch`) {
		t.Errorf("строка не называет путь: %q", got[0])
	}
	if !strings.Contains(got[0], "диск не найден") {
		t.Errorf("строка не называет причину: %q", got[0])
	}

	empty := folderProblems(folderState{Reason: "путь не задан"})
	if len(empty) != 1 || !strings.Contains(empty[0], "путь не задан") {
		t.Errorf("пустой путь подан как %v", empty)
	}
}

// Ответ обработчика: состояние обеих папок и пути по умолчанию, чтобы кнопка
// «взять папки рядом с программой» не собирала их из догадок.
func TestApiFoldersReportsStateAndDefaults(t *testing.T) {
	saved := cfg.Load()
	good := t.TempDir()
	bad := filepath.Join(t.TempDir(), "файл")
	if err := os.WriteFile(bad, []byte("x"), 0o644); err != nil {
		t.Fatalf("подготовка: %v", err)
	}
	c := defaultConfig()
	c.WatchFolder = good
	c.DownloadFolder = filepath.Join(bad, "нет")
	cfg.Store(c)
	t.Cleanup(func() { cfg.Store(saved) })

	comp := &Comp{}
	rr := httptest.NewRecorder()
	comp.apiFolders(rr, httptest.NewRequest(http.MethodGet, "/api/folders", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("код %d, ожидался 200", rr.Code)
	}

	var got struct {
		Watch            folderState `json:"watch"`
		Downloads        folderState `json:"downloads"`
		DefaultWatch     string      `json:"default_watch"`
		DefaultDownloads string      `json:"default_downloads"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("ответ не разобран: %v", err)
	}

	if !got.Watch.OK {
		t.Errorf("рабочая папка наблюдения признана недоступной: %q", got.Watch.Reason)
	}
	if got.Downloads.OK {
		t.Error("недоступная папка загрузок признана рабочей")
	}
	if got.Downloads.Reason == "" {
		t.Error("у недоступной папки не названа причина")
	}
	if !strings.HasSuffix(got.DefaultWatch, "watch") {
		t.Errorf("путь по умолчанию для наблюдения: %q", got.DefaultWatch)
	}
	if !strings.HasSuffix(got.DefaultDownloads, "downloads") {
		t.Errorf("путь по умолчанию для загрузок: %q", got.DefaultDownloads)
	}
	if filepath.Dir(got.DefaultWatch) != filepath.Dir(got.DefaultDownloads) {
		t.Error("папки по умолчанию должны лежать рядом — в одном каталоге")
	}
}
